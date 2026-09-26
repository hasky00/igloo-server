import type { RouteContext, RequestAuth } from './types.js';
import { getSecureCorsHeaders, mergeVaryHeaders, getOpTimeoutMs } from './utils.js';
import { checkRateLimit } from './auth.js';
import { getEventHash, type EventTemplate, type UnsignedEvent } from 'nostr-tools';
import { groupPubkey, signEventWithPolicy } from '../cinderella/sign-event.js';

type SignRequestBody = {
  message?: string; // 32-byte hex event id
  event?: Partial<EventTemplate> & {
    kind: number;
    created_at: number;
    content: string;
    tags: any[];
    pubkey?: string; // Optional pubkey for event hashing
  };
};

function normalizeHex(input: string): string | null {
  const hex = input.trim().toLowerCase();
  return /^[0-9a-f]+$/.test(hex) ? hex : null;
}

function computeEventId(body: SignRequestBody): { id: string; template?: UnsignedEvent } | { error: string } {
  if (body.message) {
    const hex = normalizeHex(body.message);
    if (!hex || hex.length !== 64) return { error: 'Invalid message: expected 32-byte hex event id' };
    return { id: hex };
  }

  if (body.event) {
    try {
      // Validate required pubkey for event hashing
      const pk = typeof body.event.pubkey === 'string' ? body.event.pubkey.trim() : ''
      if (!/^[0-9a-fA-F]{64}$/.test(pk)) {
        return { error: 'Invalid event: 64-hex pubkey required' };
      }

      // Validate kind (must be non-negative integer)
      const kind = Number(body.event.kind);
      if (!Number.isInteger(kind) || kind < 0) {
        return { error: 'Invalid event: kind must be a non-negative integer' };
      }

      // Validate created_at (must be positive integer timestamp)
      const created_at = Number(body.event.created_at);
      if (!Number.isInteger(created_at) || created_at <= 0) {
        return { error: 'Invalid event: created_at must be a positive integer timestamp' };
      }

      // Validate tags structure (array of arrays of strings)
      if (!Array.isArray(body.event.tags)) {
        return { error: 'Invalid event: tags must be an array' };
      }

      const validatedTags: string[][] = [];
      for (const tag of body.event.tags) {
        if (!Array.isArray(tag)) {
          return { error: 'Invalid event: each tag must be an array' };
        }
        const validatedTag: string[] = [];
        for (const element of tag) {
          if (typeof element !== 'string') {
            return { error: 'Invalid event: tag elements must be strings' };
          }
          validatedTag.push(element);
        }
        validatedTags.push(validatedTag);
      }

      const template: UnsignedEvent = {
        pubkey: pk.toLowerCase(),
        kind,
        created_at,
        content: body.event.content ?? '',
        tags: validatedTags,
      };
      const id = getEventHash(template);
      return { id, template };
    } catch (e) {
      return { error: 'Invalid event: could not compute id' };
    }
  }

  return { error: 'Request must include `message` or `event`' };
}

function normalizeErrorReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.trim().length > 0) return reason;
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return String(reason ?? 'unknown error');
}

function isTimeoutReason(reason: string): boolean {
  const value = reason.toLowerCase();
  return value.includes('timeout');
}

async function readTextBodyWithLimit(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bodyBytes);
}

export async function handleSignRoute(req: Request, url: URL, context: RouteContext, _auth?: RequestAuth | null) {
  if (url.pathname !== '/api/sign') return null;

  const corsHeaders = getSecureCorsHeaders(req);
  const mergedVary = mergeVaryHeaders(corsHeaders);
  const headers = {
    'Content-Type': 'application/json',
    ...corsHeaders,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Session-ID',
    'Vary': mergedVary,
    ...(context.requestId ? { 'X-Request-ID': context.requestId } : {}),
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers });
  if (req.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });

  // Defense-in-depth: Validate authentication even though router already enforces it
  if (!_auth || !_auth.authenticated) {
    return Response.json({ code: 'AUTH_REQUIRED', error: 'Authentication required' }, { status: 401, headers });
  }

  if (!context.node) {
    return Response.json({ code: 'NODE_UNAVAILABLE', error: 'Node not available' }, { status: 503, headers });
  }

  // Basic rate limit to protect signing endpoint
  // Use a separate bucket so signing traffic doesn't compete with auth/login
  const rate = await checkRateLimit(req, 'sign', { clientIp: context.clientIp });
  if (!rate.allowed) {
    const resetAt = typeof rate.resetAt === 'number' && Number.isFinite(rate.resetAt) ? rate.resetAt : null;
    const retryAfterFromReset = resetAt !== null
      ? Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
      : null;
    const retryAfterWindow = Number.parseInt(process.env.RATE_LIMIT_WINDOW || '900', 10);
    const retryAfterFallback = Number.isFinite(retryAfterWindow) && retryAfterWindow > 0 ? retryAfterWindow : 900;
    const retryAfterSeconds = retryAfterFromReset !== null ? retryAfterFromReset : retryAfterFallback;
    return Response.json({ code: 'RATE_LIMITED', error: 'Rate limit exceeded. Try again later.' }, {
      status: 429,
      headers: { ...headers, 'Retry-After': retryAfterSeconds.toString() }
    });
  }

  const maxBodyBytes = 1024 * 100;
  const contentLength = req.headers.get('content-length');
  const declaredLength = contentLength ? Number.parseInt(contentLength, 10) : null;
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return Response.json({ code: 'REQUEST_TOO_LARGE', error: 'Request too large' }, { status: 413, headers });
  }

  let rawBody = '';
  try {
    const bodyText = await readTextBodyWithLimit(req, maxBodyBytes);
    if (bodyText === null) {
      return Response.json({ code: 'REQUEST_TOO_LARGE', error: 'Request too large' }, { status: 413, headers });
    }
    rawBody = bodyText;
  } catch {
    return Response.json({ code: 'INVALID_JSON', error: 'Invalid JSON' }, { status: 400, headers });
  }

  let body: SignRequestBody;
  try {
    body = JSON.parse(rawBody) as SignRequestBody;
  } catch {
    return Response.json({ code: 'INVALID_JSON', error: 'Invalid JSON' }, { status: 400, headers });
  }

  // Cinderella gateway: share nodes refuse blind hashes, so only full events can be signed.
  if (body.message && !body.event) {
    return Response.json({
      code: 'BLIND_SIGN_UNSUPPORTED',
      error: 'This signer only signs full events: send `event` instead of a bare `message` hash'
    }, { status: 400, headers });
  }

  const result = computeEventId(body);
  if ('error' in result) return Response.json({ code: 'BAD_REQUEST', error: result.error }, { status: 400, headers });
  const { id, template } = result;
  if (!template) {
    return Response.json({ code: 'BAD_REQUEST', error: 'Request must include `event`' }, { status: 400, headers });
  }

  const node = context.node!;
  const expectedPubkey = groupPubkey(node);
  if (template.pubkey !== expectedPubkey) {
    return Response.json({
      code: 'BAD_REQUEST',
      error: `Invalid event: pubkey must be this signer's group pubkey (${expectedPubkey})`
    }, { status: 400, headers });
  }

  try {
    const timeoutMs = getOpTimeoutMs();
    const signed = await signEventWithPolicy(node, {
      kind: template.kind,
      created_at: template.created_at,
      tags: template.tags,
      content: template.content
    }, timeoutMs);

    if (!signed.ok) {
      if (signed.code === 'SIGN_HELD') {
        try { context.addServerLog('info', 'Delay-gated event held; will be re-requested and published after unlock', { id, kind: template.kind, heldId: signed.heldId, unlockAt: new Date(signed.unlockAt).toISOString() }); } catch {}
        return Response.json({
          code: signed.code,
          message: signed.reason,
          id,
          heldId: signed.heldId,
          unlockAt: new Date(signed.unlockAt).toISOString(),
          status: signed.status
        }, { status: 202, headers });
      }
      if (signed.code === 'SIGN_REFUSED_OR_UNREACHABLE') {
        try { context.addServerLog('warning', 'Signing refused or timed out', { id, kind: template.kind, timeoutMs }); } catch {}
        return Response.json({ code: signed.code, error: signed.reason }, { status: 504, headers });
      }
      try { context.addServerLog('error', 'Signing operation failed', { id, reason: signed.reason }); } catch {}
      return Response.json({ code: 'SIGN_FAILED', error: signed.reason }, { status: 502, headers });
    }

    const signatureHex = signed.event.sig ?? null;
    if (signed.event.id !== id || !signatureHex || !/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
      try { context.addServerLog('error', 'Invalid signature response', { id, got: signed.event.id }); } catch {}
      return Response.json({ code: 'INVALID_NODE_RESPONSE', error: 'invalid signature response from node' }, { status: 502, headers });
    }

    return Response.json({ id, signature: signatureHex }, { status: 200, headers });
  } catch (e: any) {
    const message = normalizeErrorReason(e);
    if (isTimeoutReason(message)) {
      const timeoutMs = getOpTimeoutMs();
      try { context.addServerLog('warning', `FROSTR signing timeout`, { id, timeoutMs, source: 'unexpected' }); } catch {}
      return Response.json({ code: 'SIGN_TIMEOUT', error: `Signing timed out after ${timeoutMs}ms` }, { status: 504, headers });
    }
    return Response.json({ code: 'SIGN_ERROR', error: message }, { status: 500, headers });
  }
}
