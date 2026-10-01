/**
 * The Gateway's notice key and the veto-notice listener's bookkeeping.
 *
 * Share nodes tell the Gateway about vetoes with a NIP-17 DM to this key (see
 * src/cinderella/veto-notices.ts). It is not a FROSTR share and signs nothing
 * for the user; it only receives notices. Created on first use.
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools';
import db from './database.js';

let ensured = false;
function ensureTables(): void {
  if (ensured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_notice_key (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret_hex TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_notice_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  ensured = true;
}

export function getOrCreateNoticeKey(): { sk: Uint8Array; pubkey: string } {
  ensureTables();
  let row = db.query('SELECT secret_hex FROM gateway_notice_key WHERE id = 1').get() as { secret_hex: string } | null;
  if (!row) {
    const hex = Buffer.from(generateSecretKey()).toString('hex');
    db.query('INSERT OR IGNORE INTO gateway_notice_key (id, secret_hex) VALUES (1, ?)').run(hex);
    row = db.query('SELECT secret_hex FROM gateway_notice_key WHERE id = 1').get() as { secret_hex: string };
  }
  const sk = Uint8Array.from(Buffer.from(row.secret_hex, 'hex'));
  return { sk, pubkey: getPublicKey(sk) };
}

export function getNoticeState<T>(key: string): T | undefined {
  ensureTables();
  const row = db.query('SELECT value FROM gateway_notice_state WHERE key = ?').get(key) as { value: string } | null;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function setNoticeState(key: string, value: unknown): void {
  ensureTables();
  db.query(
    'INSERT INTO gateway_notice_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}
