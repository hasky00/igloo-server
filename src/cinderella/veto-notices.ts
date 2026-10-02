/**
 * Veto notices from share nodes.
 *
 * When you veto a held event from your phone, the share node refuses it and
 * sends this Gateway a NIP-17 DM to its notice key:
 *   {"type":"cinderella-veto","id":"<event id>","status":"vetoed"}
 * The Gateway then marks the held event 'vetoed' and stops re-requesting it.
 * This is display and housekeeping only: the refusal is enforced on the node,
 * so a Gateway that ignores notices still gets no signature.
 *
 * Only notices from NODE_ALERT_PUBKEYS (the nodes' alert keys) count, with
 * the sender verified through the NIP-59 seal. A wrap is recorded as handled
 * only once it was verified and turned out to be a notice from one of them,
 * so junk can't fill the store or shadow a real notice.
 *
 * The feed is Cinderella's RelayFeed (relay-feed.ts): per-relay catch-up
 * points that move only on a real EOSE, a heartbeat with an idle timeout, and
 * reconnects with exponential backoff.
 *
 * The notice key is encrypted like the credentials (src/db/notices.ts), so in
 * database mode the listener starts when the signer is unlocked; headless
 * mode reads NOTICE_SECRET at startup. A setup error only disables vetoes in
 * the UI; it never stops the Gateway.
 */

import { getEventHash, nip44, nip19, verifyEvent } from 'nostr-tools';
import type { Event as NostrToolsEvent } from 'nostr-tools';
import { getValidRelays } from '../routes/utils.js';
import { getNoticeState, noticeKeyFromEnv, setNoticeState, unlockNoticeKey, type NoticeKey } from '../db/notices.js';
import { markVetoed } from '../db/held-events.js';
import { RelayFeed } from './relay-feed.js';

export interface Unwrapped {
  sender     : string
  content    : string
  created_at : number
}

// Copied from hasky00/cinderella@da0ea68 (src/veto.ts). Keep in sync.
export function is_event_shape (ev : unknown) : ev is NostrToolsEvent {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false
  const e = ev as Record<string, unknown>
  return typeof e.id === 'string' && /^[0-9a-f]{64}$/.test(e.id)
    && typeof e.pubkey === 'string' && /^[0-9a-f]{64}$/.test(e.pubkey)
    && typeof e.sig === 'string' && /^[0-9a-f]{128}$/.test(e.sig)
    && Number.isInteger(e.kind) && Number.isInteger(e.created_at)
    && Array.isArray(e.tags) && typeof e.content === 'string'
}

// Copied from hasky00/cinderella@da0ea68 (src/veto.ts). Keep in sync.
export function unwrap_verified (wrap : NostrToolsEvent, sk : Uint8Array) : Unwrapped | null {
  try {
    if (wrap.kind !== 1059 || !verifyEvent(wrap)) return null
    const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey))) as NostrToolsEvent
    if (seal.kind !== 13 || !verifyEvent(seal)) return null
    const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey))) as {
      id : string, pubkey : string, kind : number, created_at : number, tags : string[][], content : string
    }
    if (rumor.pubkey !== seal.pubkey) return null
    if (rumor.kind !== 14 || typeof rumor.content !== 'string' || typeof rumor.created_at !== 'number') return null
    if (getEventHash({ ...rumor, sig: '' } as unknown as Parameters<typeof getEventHash>[0]) !== rumor.id) return null
    return { sender: seal.pubkey, content: rumor.content, created_at: rumor.created_at }
  } catch {
    return null
  }
}

/** NODE_ALERT_PUBKEYS: npubs or hex, comma-separated or a JSON array. */
export function nodeAlertPubkeys(raw = process.env.NODE_ALERT_PUBKEYS): string[] {
  if (!raw || !raw.trim()) return [];
  let items: string[];
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    items = raw.split(/[,\s]+/);
  }
  const out: string[] = [];
  for (const item of items.map(s => s.trim()).filter(Boolean)) {
    if (/^[0-9a-f]{64}$/.test(item)) { out.push(item); continue; }
    try {
      const d = nip19.decode(item);
      if (d.type === 'npub') out.push(d.data as string);
    } catch { /* skip invalid */ }
  }
  return Array.from(new Set(out));
}

export type NoticeOutcome = 'vetoed' | 'not_held' | 'unknown_sender' | 'unverified' | 'not_a_notice';

/** Verified notices from a configured node: the only outcomes recorded as handled. */
const RECORDED: NoticeOutcome[] = ['vetoed', 'not_held'];

/** Handle one gift wrap addressed to the notice key. */
export function handleNoticeWrap(wrap: NostrToolsEvent, sk: Uint8Array, allowed: string[]): NoticeOutcome {
  const msg = unwrap_verified(wrap, sk);
  if (!msg) return 'unverified';
  if (!allowed.includes(msg.sender)) return 'unknown_sender';
  let notice: { type?: unknown; id?: unknown; status?: unknown };
  try { notice = JSON.parse(msg.content); } catch { return 'not_a_notice'; }
  if (notice?.type !== 'cinderella-veto' || notice.status !== 'vetoed' || typeof notice.id !== 'string' || !/^[0-9a-f]{64}$/.test(notice.id)) {
    return 'not_a_notice';
  }
  return markVetoed(notice.id, msg.sender) ? 'vetoed' : 'not_held';
}

type Log = (level: string, message: string, data?: unknown) => void;

// NIP-59 gift wraps carry a random timestamp up to 2 days in the past.
const WRAP_JITTER_S = 2 * 24 * 3600;
const SEEN_RETENTION_MS = 3 * 24 * 3_600_000;
const ADVANCE_INTERVAL_MS = 60_000;

/** Relays to listen on: NOTICE_RELAYS, else PUBLISH_RELAYS + RELAYS. */
export function noticeRelays(): string[] {
  const own = getValidRelays(process.env.NOTICE_RELAYS ?? '', { fallbackToDefault: false });
  if (own.length) return own;
  const publish = getValidRelays(process.env.PUBLISH_RELAYS ?? '', { fallbackToDefault: false });
  return Array.from(new Set([...publish, ...getValidRelays(undefined)]));
}

export interface NoticeListenerOptions {
  relays?: string[];
  allowed?: string[];
  log?: Log;
  /** Feed tuning (tests use short values). */
  backoffMs?: { min: number; max: number };
  idleMs?: number;
  advanceMs?: number;
}

export interface NoticeListener {
  stop: () => void;
  /** Every notice relay connected and past a real EOSE since its last reconnect. */
  readonly caughtUp: boolean;
  readonly feed: RelayFeed;
}

/** Listen for veto notices to `key`. */
export function createVetoNoticeListener(key: NoticeKey, options: NoticeListenerOptions = {}): NoticeListener {
  const log = options.log ?? (() => {});
  const allowed = options.allowed ?? nodeAlertPubkeys();
  const relays = options.relays ?? noticeRelays();

  // A catch-up point per relay: each relay's `since` follows what THAT relay delivered.
  const seenUntil = (): Record<string, number> => {
    const v = getNoticeState<number | Record<string, number>>('seen_until');
    if (typeof v === 'number') return Object.fromEntries(relays.map(r => [r, v]));   // older single point
    return v && typeof v === 'object' ? { ...v } : {};
  };
  const advance = (list: string[]) => {
    if (!list.length) return;
    const now = Date.now();
    const next = seenUntil();
    for (const r of list) next[r] = now;
    setNoticeState('seen_until', next);
  };

  const onWrap = (raw: unknown, relay: string) => {
    if (!is_event_shape(raw)) { log('warning', `Veto notices: ignored a malformed event from ${relay}`); return; }
    const seen = getNoticeState<Record<string, number>>('seen_wraps') ?? {};
    if (seen[raw.id]) return;
    const outcome = handleNoticeWrap(raw, key.sk, allowed);
    if (RECORDED.includes(outcome)) {
      const now = Date.now();
      const next = { ...seen };
      for (const [id, at] of Object.entries(next)) if (now - at > SEEN_RETENTION_MS) delete next[id];
      next[raw.id] = now;
      setNoticeState('seen_wraps', next);
    }
    if (outcome === 'vetoed') log('info', 'Held event vetoed from the veto key (reported by a share node)');
    else if (outcome !== 'not_held') log('warning', `Veto notice ignored: ${outcome}`);
  };

  const feed = new RelayFeed(relays, {
    filter: (relay) => {
      const seen = seenUntil();
      const values = Object.values(seen);
      const from = seen[relay] ?? (values.length ? Math.min(...values) : Date.now());
      return { kinds: [1059], '#p': [key.pubkey], since: Math.floor(from / 1000) - WRAP_JITTER_S - 60 };
    },
    onevent: (raw, relay) => {
      try { onWrap(raw, relay); }
      catch (err) { log('warning', `Veto notices: error handling an event from ${relay}: ${err instanceof Error ? err.message : String(err)}`); }
    },
    oncaughtup: (relay) => advance([relay]),
    onstate: (all) => log(all ? 'info' : 'warning', all
      ? 'Veto notices: caught up on every notice relay'
      : 'Veto notices: not every notice relay is live; reconnecting'),
    min_backoff_ms: options.backoffMs?.min,
    max_backoff_ms: options.backoffMs?.max,
    idle_ms: options.idleMs,
  });
  feed.start();

  // Keep each live relay's catch-up point current.
  const timer = setInterval(() => advance(feed.caught_up_relays), options.advanceMs ?? ADVANCE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  log('info', 'Veto notices: listening', { relays, nodes: allowed.length, noticeNpub: nip19.npubEncode(key.pubkey) });
  return {
    stop: () => { clearInterval(timer); feed.stop(); },
    get caughtUp() { return feed.all_caught_up; },
    feed,
  };
}

// ------------------------------------------------- the Gateway's one listener

let active: { listener: NoticeListener; pubkey: string } | null = null;

/** Start (or keep) the Gateway's listener for `key`; replaces one for another key. */
function ensureListener(key: NoticeKey, log: Log, options: NoticeListenerOptions = {}): void {
  if (active?.pubkey === key.pubkey) return;
  stopVetoNoticeListener();
  const allowed = options.allowed ?? nodeAlertPubkeys();
  if (!allowed.length) {
    log('info', 'Veto notices: NODE_ALERT_PUBKEYS not set; held events will not show vetoes', { noticeNpub: nip19.npubEncode(key.pubkey) });
    return;
  }
  active = { listener: createVetoNoticeListener(key, { ...options, allowed, log }), pubkey: key.pubkey };
}

/** Stop the listener and close its relay connections (shutdown). */
export function stopVetoNoticeListener(): void {
  if (!active) return;
  try { active.listener.stop(); } catch { /* already stopped */ }
  active = null;
}

/** The running listener, if any (status and tests). */
export function activeVetoNoticeListener(): NoticeListener | null {
  return active?.listener ?? null;
}

/**
 * Startup. Headless: NOTICE_SECRET. Database mode: nothing yet, the key is
 * unlocked with the signer (unlockVetoNotices). Any error is logged and only
 * disables veto notices. Returns whether a listener runs.
 */
export function setupVetoNotices(log: Log, options: NoticeListenerOptions & { headless?: boolean } = {}): boolean {
  try {
    const key = noticeKeyFromEnv();
    if (!key) {
      if (options.headless) log('info', 'Veto notices: NOTICE_SECRET not set (headless); held events will not show vetoes');
      return false;
    }
    ensureListener(key, log, options);
    return !!active;
  } catch (err) {
    log('error', `Veto notices disabled: ${err instanceof Error ? err.message : String(err)}`);
    stopVetoNoticeListener();
    return false;
  }
}

/**
 * Database mode: the user unlocked the signer; decrypt (or create) the notice
 * key with the same secret and start listening. Never throws.
 */
export function unlockVetoNotices(
  userId: number | bigint,
  passwordOrKey: string | Uint8Array | Buffer,
  isDerivedKey: boolean,
  log: Log,
  options: NoticeListenerOptions = {}
): boolean {
  try {
    if (noticeKeyFromEnv()) return !!active;   // NOTICE_SECRET wins (set at startup)
    ensureListener(unlockNoticeKey(userId, passwordOrKey, isDerivedKey), log, options);
    return !!active;
  } catch (err) {
    log('error', `Veto notices disabled: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
