/**
 * Held events: delay-gated events (profile, delete, …) the share nodes queued.
 * The gateway keeps the exact unsigned event, re-requests it after the delay,
 * and publishes the signed result (see src/cinderella/held-events.ts).
 *
 * Keyed by the group pubkey (the identity), not the user, so it works in both
 * database and headless mode. The table is created here on first use.
 */

import { randomBytes } from 'node:crypto';
import db from './database.js';

export type HeldStatus = 'held' | 'signed' | 'published' | 'failed' | 'cancelled' | 'superseded';

export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface HeldEvent {
  id: string;
  pubkey: string;
  event_id: string;
  kind: number;
  event: UnsignedEvent;
  status: HeldStatus;
  unlock_at: number;        // ms
  next_attempt_at: number;  // ms
  attempts: number;
  signed: (UnsignedEvent & { id: string; sig: string }) | null;
  publish_results: Record<string, string> | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string; pubkey: string; event_id: string; kind: number; event_json: string; status: HeldStatus;
  unlock_at: number; next_attempt_at: number; attempts: number; signed_json: string | null;
  publish_results: string | null; last_error: string | null; created_at: string; updated_at: string;
}

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS held_events (
      id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      kind INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      status TEXT NOT NULL,
      unlock_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      signed_json TEXT,
      publish_results TEXT,
      last_error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_held_events_due ON held_events(pubkey, status, next_attempt_at)');
  ensured = true;
}

function toHeld(row: Row): HeldEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    event_id: row.event_id,
    kind: row.kind,
    event: JSON.parse(row.event_json),
    status: row.status,
    unlock_at: row.unlock_at,
    next_attempt_at: row.next_attempt_at,
    attempts: row.attempts,
    signed: row.signed_json ? JSON.parse(row.signed_json) : null,
    publish_results: row.publish_results ? JSON.parse(row.publish_results) : null,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function getHeldByEventId(eventId: string): HeldEvent | null {
  ensureTable();
  const row = db.query('SELECT * FROM held_events WHERE event_id = ?').get(eventId) as Row | null;
  return row ? toHeld(row) : null;
}

export function getHeld(id: string): HeldEvent | null {
  ensureTable();
  const row = db.query('SELECT * FROM held_events WHERE id = ?').get(id) as Row | null;
  return row ? toHeld(row) : null;
}

/**
 * Record a held event. The same event id is stored once. For replaceable kinds
 * only the newest held event counts: older ones become 'superseded', and an
 * incoming event older than one already held is stored as 'superseded'.
 */
export function holdEvent(params: {
  event: UnsignedEvent;
  eventId: string;
  unlockAt: number;
  nextAttemptAt: number;
  replaceable: boolean;
}): HeldEvent {
  ensureTable();
  const existing = getHeldByEventId(params.eventId);
  if (existing) return existing;

  let status: HeldStatus = 'held';
  const tx = db.transaction(() => {
    if (params.replaceable) {
      const newer = db.query(
        "SELECT event_json FROM held_events WHERE pubkey = ? AND kind = ? AND status IN ('held', 'signed')"
      ).all(params.event.pubkey, params.event.kind) as { event_json: string }[];
      if (newer.some(r => (JSON.parse(r.event_json) as UnsignedEvent).created_at > params.event.created_at)) {
        status = 'superseded';
      } else {
        db.query(
          "UPDATE held_events SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE pubkey = ? AND kind = ? AND status IN ('held', 'signed')"
        ).run(params.event.pubkey, params.event.kind);
      }
    }
    db.query(`
      INSERT INTO held_events (id, pubkey, event_id, kind, event_json, status, unlock_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomBytes(16).toString('hex'),
      params.event.pubkey,
      params.eventId,
      params.event.kind,
      JSON.stringify(params.event),
      status,
      params.unlockAt,
      params.nextAttemptAt
    );
  });
  tx();
  return getHeldByEventId(params.eventId)!;
}

/** Held events that are due: re-request ('held') or re-publish ('signed'). */
export function dueHeld(pubkey: string, now: number): HeldEvent[] {
  ensureTable();
  return (db.query(
    "SELECT * FROM held_events WHERE pubkey = ? AND status IN ('held', 'signed') AND next_attempt_at <= ? ORDER BY next_attempt_at"
  ).all(pubkey, now) as Row[]).map(toHeld);
}

export function listHeld(pubkey: string, limit = 50): HeldEvent[] {
  ensureTable();
  return (db.query(
    'SELECT * FROM held_events WHERE pubkey = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
  ).all(pubkey, Math.max(1, Math.min(limit, 200))) as Row[]).map(toHeld);
}

export function updateHeld(id: string, fields: {
  status?: HeldStatus;
  next_attempt_at?: number;
  attempts?: number;
  signed?: HeldEvent['signed'];
  publish_results?: Record<string, string>;
  last_error?: string | null;
}): void {
  ensureTable();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.next_attempt_at !== undefined) { sets.push('next_attempt_at = ?'); values.push(fields.next_attempt_at); }
  if (fields.attempts !== undefined) { sets.push('attempts = ?'); values.push(fields.attempts); }
  if (fields.signed !== undefined) { sets.push('signed_json = ?'); values.push(fields.signed ? JSON.stringify(fields.signed) : null); }
  if (fields.publish_results !== undefined) { sets.push('publish_results = ?'); values.push(JSON.stringify(fields.publish_results)); }
  if (fields.last_error !== undefined) { sets.push('last_error = ?'); values.push(fields.last_error); }
  if (!sets.length) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  db.query(`UPDATE held_events SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

/** Cancel a held event before it is re-requested. Only 'held' events can be cancelled. */
export function cancelHeld(id: string, pubkey: string): boolean {
  ensureTable();
  const res = db.query(
    "UPDATE held_events SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND pubkey = ? AND status = 'held'"
  ).run(id, pubkey);
  return res.changes > 0;
}
