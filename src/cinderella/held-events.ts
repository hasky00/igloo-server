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

import { SimplePool, getEventHash, nip19 } from 'nostr-tools';
import type { ServerBifrostNode } from '../routes/types.js';
import { getValidRelays, withTimeout } from '../routes/utils.js';
import type { HeldEvent, UnsignedEvent } from '../db/held-events.js';
import { heldDelayHours, isReplaceable, retryEveryMs, retryMarginMs } from './held-config.js';
import { cinderella_sign, group_pubkey, SignRefusedError, type EventTemplate, type PeerRefusal } from './request.js';
import type { NostrEvent } from './types.js';

export type HeldOutcome =
  | { ok: true; event: NostrEvent }
  | { ok: false; held: HeldEvent }
  /** Every node that answered refused it for good (e.g. kind not allowed): not held. */
  | { ok: false; refused: string; refusals: PeerRefusal[] };

/** The share nodes' refusals carried by a failed cinderella_sign, if any. */
export function refusalsOf(error: unknown): PeerRefusal[] {
  return error instanceof SignRefusedError ? error.refusals : [];
}

/** What the nodes said, for the Held card and the logs ("still locked until …"). */
export function describeFailure(error: unknown): string {
  const refusals = refusalsOf(error);
  if (refusals.length) return Array.from(new Set(refusals.map(r => r.reason))).join('; ');
  const message = error instanceof Error ? error.message : String(error);
  return /time(d)? ?out/i.test(message)
    ? `no share node answered (${message.replace(/^cinderella: /, '')}): offline, or running older code that refuses silently`
    : message.replace(/^cinderella: /, '');
}

/** The latest unlock time the refusing nodes reported, if any. */
function reportedUnlock(refusals: PeerRefusal[]): number | null {
  const times = refusals
    .filter(r => r.code === 'locked' || r.code === 'held')
    .map(r => r.unlock_at)
    .filter((t): t is number => typeof t === 'number');
  return times.length ? Math.max(...times) : null;
}

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

  const errors = attempts.map(a => (a as PromiseRejectedResult).reason);
  const refusals = errors.flatMap(refusalsOf);
  if (refusals.length && refusals.every(r => r.code === 'denied')) {
    return { ok: false, refused: Array.from(new Set(refusals.map(r => r.reason))).join('; '), refusals };
  }

  // The node's own unlock time when it told us; otherwise our guess from HELD_KINDS.
  const unlockAt = reportedUnlock(refusals) ?? now + delayHours * HOUR;
  const { updateHeld, markVetoed, getHeld } = await store();
  let held = holdEvent({
    event,
    eventId,
    unlockAt,
    nextAttemptAt: unlockAt + retryMarginMs(),
    replaceable: isReplaceable(event.kind)
  });
  const vetoed = refusals.find(r => r.code === 'vetoed');
  if (vetoed) markVetoed(eventId, vetoed.peer);
  else if (held.status === 'held') updateHeld(held.id, { last_error: errors.map(describeFailure).filter(Boolean).join(' | ') || null });
  held = getHeld(held.id) ?? held;
  return { ok: false, held };
}

export function heldMessage(held: HeldEvent): string {
  if (held.status === 'vetoed') {
    const by = held.vetoed_by ? ` (reported by share node ${nip19.npubEncode(held.vetoed_by)})` : '';
    return `Not signed: this event was vetoed from the veto key${by} and will never be signed. ` +
      'Cancel it in the Held tab to remove it.';
  }
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
/** Give up on an event the nodes keep answering about (but never sign) after this long past its unlock. */
const ANSWERED_GIVE_UP_MS = 7 * 24 * HOUR;

export interface RetryPlan {
  reason: string;
  /** Give up: mark 'failed'. */
  fail: boolean;
  nextAttemptAt: number;
  /** A node reported its unlock time: store it (the card shows it). */
  unlockAt?: number;
  /** A node said it is vetoed. */
  vetoedBy?: string;
}

/**
 * When to re-request a held event after a failed attempt, from what the
 * share nodes said:
 *   vetoed        → vetoed, never again
 *   denied        → failed (refused for good)
 *   locked, or held with an unlock time (the node restarted its delay)
 *                 → at the node's unlock time (+ margin); the card shows it
 *   rate_limited  → when the node said a slot frees up (+ margin)
 *   held without a time, catching up, nonce trouble
 *                 → every HELD_RETRY_EVERY_MS (15 min): the node is there and
 *                   will unlock, so no early give-up (hard cap: 7 days)
 *   no answer at all → every 15 min, until one delay length past the unlock
 *                   time; then failed
 */
export function planRetry(held: HeldEvent, error: unknown, now: number): RetryPlan {
  const refusals = refusalsOf(error);
  const reason = describeFailure(error);
  const margin = retryMarginMs();

  const vetoed = refusals.find(r => r.code === 'vetoed');
  if (vetoed) return { reason, fail: false, nextAttemptAt: now, vetoedBy: vetoed.peer };
  if (refusals.length && refusals.every(r => r.code === 'denied')) return { reason, fail: true, nextAttemptAt: now };

  // The node's own unlock time wins over our guess, also when it restarted the delay.
  const unlock = reportedUnlock(refusals);
  if (unlock !== null && unlock > now) return { reason, fail: false, nextAttemptAt: unlock + margin, unlockAt: unlock };

  const limited = refusals.filter(r => r.code === 'rate_limited' && typeof r.retry_at === 'number').map(r => r.retry_at as number);
  if (limited.length) return { reason, fail: false, nextAttemptAt: Math.max(...limited) + margin };

  const next = now + retryEveryMs();
  // A node that answers (held, catching up, nonce trouble) will get there: keep going.
  if (refusals.length) {
    const cap = held.unlock_at + ANSWERED_GIVE_UP_MS;
    if (next > cap) return { reason: `${reason} (gave up: still not signed ${ANSWERED_GIVE_UP_MS / (24 * HOUR)} days after the unlock)`, fail: true, nextAttemptAt: now };
    return { reason, fail: false, nextAttemptAt: next };
  }
  // Nobody answered: give up one delay length past the unlock.
  const deadline = held.unlock_at + (heldDelayHours(held.kind) ?? 24) * HOUR;
  if (next > deadline) return { reason: `${reason} (gave up: no share node signed it by ${new Date(deadline).toISOString()})`, fail: true, nextAttemptAt: now };
  return { reason, fail: false, nextAttemptAt: next };
}

/** One pass over the due held events of the signer's identity. */
export async function processDueHeld(deps: HeldSchedulerDeps): Promise<void> {
  const node = deps.getNode();
  if (!node) return;   // signer not running (e.g. before login): try later
  const { dueHeld, updateHeld, getHeld, markVetoed } = await store();
  // A veto can arrive while a re-request is in flight: it wins, nothing is overwritten or published.
  const vetoed = (id: string) => getHeld(id)?.status === 'vetoed';
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
        if (vetoed(held.id)) { log('info', 'Held event was vetoed while it was re-requested; not publishing', { id: held.id }); continue; }
        updateHeld(held.id, { status: 'signed', signed: signed as any, attempts: held.attempts + 1, last_error: null });
        log('info', 'Held event signed after its delay', { id: held.id, kind: held.kind, eventId: held.event_id });
      } catch (error) {
        const plan = planRetry(held, error, now);
        if (plan.vetoedBy) {
          markVetoed(held.event_id, plan.vetoedBy);
          log('info', 'Held event was vetoed (reported by a share node)', { id: held.id });
        } else {
          updateHeld(held.id, {
            attempts: held.attempts + 1,
            last_error: plan.reason,
            ...(plan.fail ? { status: 'failed' as const } : { next_attempt_at: plan.nextAttemptAt }),
            ...(plan.unlockAt !== undefined ? { unlock_at: plan.unlockAt } : {}),
          });
          log(plan.fail ? 'error' : 'warning', plan.fail ? 'Held event could not be signed; giving up' : 'Held event not signed yet; will try again', {
            id: held.id, kind: held.kind, reason: plan.reason,
            ...(plan.fail ? {} : { nextAttemptAt: new Date(plan.nextAttemptAt).toISOString() })
          });
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
