/**
 * Held (delay-gated) events: list and cancel.
 *
 *   GET    /api/held-events         held events of the running signer's identity
 *   DELETE /api/held-events/:id     cancel one that has not been re-requested yet
 *
 * Cancel is for honest mistakes: it stops this gateway from re-requesting the
 * event. It is not a veto against a stolen share (see src/cinderella/held-events.ts).
 */

import { getSecureCorsHeaders, mergeVaryHeaders } from './utils.js';
import type { RouteContext, RequestAuth } from './types.js';
import { cancelHeld, listHeld } from '../db/held-events.js';
import { groupPubkey } from '../cinderella/sign-event.js';

export async function handleHeldEventsRoute(
  req: Request,
  url: URL,
  context: RouteContext,
  _auth: RequestAuth | null
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/held-events')) return null;

  const corsHeaders = getSecureCorsHeaders(req);
  const headers = {
    'Content-Type': 'application/json',
    ...corsHeaders,
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Session-ID',
    'Vary': mergeVaryHeaders(corsHeaders),
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers });

  if (!context.node) {
    return Response.json({ code: 'NODE_UNAVAILABLE', error: 'Signer not running' }, { status: 503, headers });
  }
  const pubkey = groupPubkey(context.node);

  if (url.pathname === '/api/held-events' && req.method === 'GET') {
    const events = listHeld(pubkey).map(h => ({
      id: h.id,
      kind: h.kind,
      eventId: h.event_id,
      createdAt: h.event.created_at,
      preview: h.event.content.slice(0, 120),
      status: h.status,
      unlockAt: new Date(h.unlock_at).toISOString(),
      nextAttemptAt: new Date(h.next_attempt_at).toISOString(),
      attempts: h.attempts,
      publishResults: h.publish_results,
      lastError: h.last_error,
    }));
    return Response.json({ events }, { headers });
  }

  const match = url.pathname.match(/^\/api\/held-events\/([0-9a-f]{32})$/);
  if (match && req.method === 'DELETE') {
    const cancelled = cancelHeld(match[1], pubkey);
    if (!cancelled) {
      return Response.json({ error: 'Not found, or already re-requested / finished' }, { status: 404, headers });
    }
    try { context.addServerLog('info', 'Held event cancelled', { id: match[1] }); } catch {}
    return Response.json({ cancelled: true }, { headers });
  }

  return Response.json({ error: 'Not Found' }, { status: 404, headers });
}
