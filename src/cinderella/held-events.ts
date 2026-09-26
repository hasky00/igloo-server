/**
 * Held events: completing delay-gated events (Cinderella roadmap).
 *
 * A share node signs a delay-gated event (kind 0 profile, kind 5 delete, …)
 * only when the *identical* event is requested again after the delay. Clients
 * never do that, so the gateway does:
 *
 *  1. First request: shown to every share node (one session per node), so
 *     each starts its delay clock. The event is stored as 'held'.
 *  2. After unlock (+ margin): the gateway requests the identical event again.
 *     If it still fails, it tries once more a full delay later (a node may
 *     have started its clock late), then gives up ('failed').
 *  3. Signed: published to the user's NIP-65 write relays (fallback
 *     PUBLISH_RELAYS, then RELAYS). If no relay accepts it, publishing is
 *     retried ('signed').
 *
 * Cancel is for honest mistakes only: someone holding a stolen gateway share
 * runs their own requester. The real protection is noticing within the delay
 * and vetoing on the share nodes (roadmap: veto listener + notification).
 */

import { SimplePool, getEventHash } from 'nostr-tools';
import type { ServerBifrostNode } from '../routes/types.js';
import { getValidRelays, withTimeout } from '../routes/utils.js';
import type { HeldEvent, UnsignedEvent } from '../db/held-events.js';
import { heldDelayHours, isReplaceable, retryMarginMs } from './held-config.js';
import { cinderella_sign, group_pubkey, type EventTemplate } from './request.js';
import type { NostrEvent } from './types.js';

export type HeldOutcome =
  | { ok: true; event: NostrEvent }
  | { ok: false; held: HeldEvent };

const HOUR = 3_600_000;

// Loaded on first use: signing ordinary kinds never touches the database.
const store = () => import('../db/held-events.js');

/**
 * Sign a delay-gated event, or hold it. Shows it to every share node we may
 * send to (one session each, in parallel). If any node signs (it was already
 * unlocked there), that's the result; otherwise it is stored as held.
 */
export async function signOrHold(
  node: ServerBifrostNode,
  template: EventTemplate,
  timeoutMs: number,
  now = Date.now()
): Promise<HeldOutcome> {
  const delayHours = heldDelayHours(template.kind);
  if (delayHours === undefined) throw new Error(`kind ${template.kind} is not delay-gated`);

  const event: UnsignedEvent = { ...template, pubkey: group_pubkey(node as any) };
  const eventId = getEventHash(event);

  // A client retrying the same event: answer from the store, don't re-prime.
  const { getHeldByEventId, holdEvent } = await store();
  const existing = getHeldByEventId(eventId);
  if (existing?.status === 'published' && existing.signed) return { ok: true, event: existing.signed as NostrEvent };
  if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') return { ok: false, held: existing };

  const peers = ((node as any).peers as { pubkey: string; policy?: { send?: boolean } }[])
    .filter(p => p.policy?.send !== false)
    .map(p => p.pubkey);
  const attempts = await Promise.allSettled(
    peers.map(pk => withTimeout(cinderella_sign(node as any, template, { peers: [pk] }), timeoutMs, 'SIGN_TIMEOUT'))
  );
  const signed = attempts.find((a): a is PromiseFulfilledResult<NostrEvent> => a.status === 'fulfilled');
  if (signed) return { ok: true, event: signed.value };

  const unlockAt = now + delayHours * HOUR;
  const held = holdEvent({
    event,
    eventId,
    unlockAt,
    nextAttemptAt: unlockAt + retryMarginMs(),
    replaceable: isReplaceable(event.kind)
  });
  return { ok: false, held };
}

export function heldMessage(held: HeldEvent): string {
  if (held.status === 'superseded') {
    return 'Not signed: a newer version of this event is already waiting for its delay; this one will not be published';
  }
  return `Held until ${new Date(held.unlock_at).toISOString()}: kind ${held.kind} is delay-gated. ` +
    'The gateway will request it again after that and publish it automatically.';
}

// ---------------------------------------------------------------- publishing

type Log = (level: string, message: string, data?: unknown) => void;

function parseRelayList(raw: string | undefined): string[] {
  return raw ? getValidRelays(raw, { fallbackToDefault: false }) : [];
}

/** The user's NIP-65 write relays, else PUBLISH_RELAYS, else RELAYS. */
export async function resolvePublishRelays(pubkey: string, pool: SimplePool): Promise<string[]> {
  const configured = parseRelayList(process.env.PUBLISH_RELAYS);
  const lookup = Array.from(new Set([...configured, ...getValidRelays(undefined)]));
  try {
    const events = await withTimeout(pool.querySync(lookup, { kinds: [10002], authors: [pubkey], limit: 1 }), 8000, 'NIP65_TIMEOUT');
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
    const write = (newest?.tags ?? [])
      .filter(t => t[0] === 'r' && typeof t[1] === 'string' && (t[2] === undefined || t[2] === 'write'))
      .map(t => t[1]);
    const valid = write.length ? getValidRelays(JSON.stringify(write), { fallbackToDefault: false }) : [];
    if (valid.length) return valid;
  } catch {
    // no relay list reachable: fall back below
  }
  return configured.length ? configured : getValidRelays(undefined);
}

export async function publishSigned(event: NostrEvent): Promise<Record<string, string>> {
  const pool = new SimplePool();
  try {
    const relays = await resolvePublishRelays(event.pubkey, pool);
    const results = await Promise.allSettled(
      pool.publish(relays, event as any).map(p => withTimeout(p, 10_000, 'PUBLISH_TIMEOUT'))
    );
    const out: Record<string, string> = {};
    relays.forEach((relay, i) => {
      const r = results[i];
      out[relay] = r?.status === 'fulfilled' ? 'ok' : String((r as PromiseRejectedResult)?.reason?.message ?? (r as PromiseRejectedResult)?.reason ?? 'failed');
    });
    return out;
  } finally {
    try { pool.destroy(); } catch {}
  }
}

// ----------------------------------------------------------------- scheduler

export interface HeldSchedulerDeps {
  getNode: () => ServerBifrostNode | null;
  log?: Log;
  timeoutMs?: number;
  /** Test seams; default to cinderella_sign / publishSigned. */
  sign?: (node: ServerBifrostNode, template: EventTemplate) => Promise<NostrEvent>;
  publish?: (event: NostrEvent) => Promise<Record<string, string>>;
  now?: () => number;
}

const PUBLISH_RETRY_MS = 5 * 60_000;

/** One pass over the due held events of the signer's identity. */
export async function processDueHeld(deps: HeldSchedulerDeps): Promise<void> {
  const node = deps.getNode();
  if (!node) return;   // signer not running (e.g. before login): try later
  const { dueHeld, updateHeld } = await store();
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? (() => {});
  const sign = deps.sign ?? ((n, t) => withTimeout(cinderella_sign(n as any, t), deps.timeoutMs ?? 30_000, 'SIGN_TIMEOUT'));
  const publish = deps.publish ?? publishSigned;

  for (const held of dueHeld(group_pubkey(node as any), now)) {
    let signed = held.signed as NostrEvent | null;

    if (held.status === 'held') {
      const { pubkey: _pubkey, ...template } = held.event;
      try {
        signed = await sign(node, template);
        if (signed.id !== held.event_id) throw new Error('signed event id does not match the held event');
        updateHeld(held.id, { status: 'signed', signed: signed as any, attempts: held.attempts + 1, last_error: null });
        log('info', 'Held event signed after its delay', { id: held.id, kind: held.kind, eventId: held.event_id });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const attempts = held.attempts + 1;
        if (attempts < 2) {
          const delay = (heldDelayHours(held.kind) ?? 24) * HOUR;
          updateHeld(held.id, { attempts, next_attempt_at: now + delay + retryMarginMs(), last_error: reason });
          log('warning', 'Held event not signed yet; will try once more after another delay', { id: held.id, kind: held.kind, reason });
        } else {
          updateHeld(held.id, { attempts, status: 'failed', last_error: reason });
          log('error', 'Held event could not be signed; giving up', { id: held.id, kind: held.kind, reason });
        }
        continue;
      }
    }

    if (!signed) continue;
    try {
      const results = await publish(signed);
      const accepted = Object.values(results).some(r => r === 'ok');
      updateHeld(held.id, accepted
        ? { status: 'published', publish_results: results, last_error: null }
        : { publish_results: results, next_attempt_at: now + PUBLISH_RETRY_MS, last_error: 'no relay accepted the event' });
      log(accepted ? 'info' : 'warning', accepted ? 'Held event published' : 'Held event signed but no relay accepted it; retrying', { id: held.id, results });
    } catch (error) {
      updateHeld(held.id, { next_attempt_at: now + PUBLISH_RETRY_MS, last_error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Run processDueHeld every intervalMs (default 60s). Returns a stop function. */
export function startHeldEventScheduler(deps: HeldSchedulerDeps & { intervalMs?: number }): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDueHeld(deps);
    } catch (error) {
      deps.log?.('error', 'Held event scheduler failed', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  }, deps.intervalMs ?? 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
