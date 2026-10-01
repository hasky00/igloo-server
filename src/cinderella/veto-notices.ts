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
 * the sender verified through the NIP-59 seal.
 */

import { SimplePool, getEventHash, nip44, nip19, verifyEvent } from 'nostr-tools';
import type { Event as NostrToolsEvent, Filter } from 'nostr-tools';
import { getValidRelays } from '../routes/utils.js';
import { getOrCreateNoticeKey, getNoticeState, setNoticeState } from '../db/notices.js';
import { markVetoed } from '../db/held-events.js';

export interface Unwrapped {
  sender     : string
  content    : string
  created_at : number
}

// Copied from hasky00/cinderella@ccbcec6 (src/veto.ts, PR #16). Keep in sync.
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
  return markVetoed(notice.id) ? 'vetoed' : 'not_held';
}

type Log = (level: string, message: string, data?: unknown) => void;

// NIP-59 gift wraps carry a random timestamp up to 2 days in the past.
const WRAP_JITTER_S = 2 * 24 * 3600;
const SEEN_RETENTION_MS = 3 * 24 * 3_600_000;

/** Relays to listen on: NOTICE_RELAYS, else PUBLISH_RELAYS + RELAYS. */
export function noticeRelays(): string[] {
  const own = getValidRelays(process.env.NOTICE_RELAYS ?? '', { fallbackToDefault: false });
  if (own.length) return own;
  const publish = getValidRelays(process.env.PUBLISH_RELAYS ?? '', { fallbackToDefault: false });
  return Array.from(new Set([...publish, ...getValidRelays(undefined)]));
}

/** Listen for veto notices. Returns a stop function (no-op when no node keys are configured). */
export function startVetoNoticeListener(log: Log = () => {}): () => void {
  const allowed = nodeAlertPubkeys();
  const { sk, pubkey } = getOrCreateNoticeKey();
  if (!allowed.length) {
    log('info', 'Veto notices: NODE_ALERT_PUBKEYS not set; held events will not show vetoes', { noticeNpub: nip19.npubEncode(pubkey) });
    return () => {};
  }
  const relays = noticeRelays();
  const pool = new SimplePool();
  const seenUntil = getNoticeState<number>('seen_until') ?? Date.now();
  const since = Math.floor(seenUntil / 1000) - WRAP_JITTER_S - 60;
  const sub = pool.subscribeMany(relays, { kinds: [1059], '#p': [pubkey], since } as Filter, {
    onevent: (wrap: NostrToolsEvent) => {
      const now = Date.now();
      const seen = { ...(getNoticeState<Record<string, number>>('seen_wraps') ?? {}) };
      if (seen[wrap.id]) return;
      for (const [id, at] of Object.entries(seen)) if (now - at > SEEN_RETENTION_MS) delete seen[id];
      seen[wrap.id] = now;
      setNoticeState('seen_wraps', seen);
      const outcome = handleNoticeWrap(wrap, sk, allowed);
      if (outcome === 'vetoed') log('info', 'Held event vetoed from the veto key (reported by a share node)');
      else if (outcome !== 'not_held') log('warning', `Veto notice ignored: ${outcome}`);
    },
    oneose: () => setNoticeState('seen_until', Date.now()),
    maxWait: 10_000,
  });
  const timer = setInterval(() => setNoticeState('seen_until', Date.now()), 10 * 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  log('info', 'Veto notices: listening', { relays, nodes: allowed.length, noticeNpub: nip19.npubEncode(pubkey) });
  return () => {
    clearInterval(timer);
    try { sub.close(); } catch {}
    try { pool.close(relays); } catch {}
  };
}
