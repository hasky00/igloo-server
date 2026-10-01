/**
 * The Gateway's notice key and the veto-notice listener's bookkeeping.
 *
 * Share nodes tell the Gateway about vetoes with a NIP-17 DM to this key (see
 * src/cinderella/veto-notices.ts). It is not a FROSTR share and signs nothing
 * for the user; it only receives notices.
 *
 * The secret is stored like the group and share credentials: AES-256-GCM with
 * the user's password-derived key (database mode), so it can only be read once
 * the user has unlocked the signer. The npub is stored in the clear (it is
 * public) so the UI can show it while the signer is locked. Headless mode
 * keeps it in NOTICE_SECRET, next to SHARE_CRED.
 */

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import db, { decryptUserSecret, encryptUserSecret } from './database.js';

export interface NoticeKey { sk: Uint8Array; pubkey: string }

let ensured = false;
function ensureTables(): void {
  if (ensured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_notice_keys (
      user_id INTEGER PRIMARY KEY,
      pubkey TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
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

const toKey = (hex: string): NoticeKey => {
  const sk = Uint8Array.from(Buffer.from(hex, 'hex'));
  return { sk, pubkey: getPublicKey(sk) };
};

/** An earlier build kept the secret in plaintext (one row, id = 1). */
function takeLegacyPlaintextSecret(): string | null {
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gateway_notice_key'").get();
  if (!table) return null;
  const row = db.query('SELECT secret_hex FROM gateway_notice_key WHERE id = 1').get() as { secret_hex: string } | null;
  return row && /^[0-9a-f]{64}$/.test(row.secret_hex) ? row.secret_hex : null;
}

/**
 * The user's notice key, decrypted with their password or derived key; created
 * (and stored encrypted) on first use. A plaintext key from an earlier build is
 * moved into the encrypted store (same npub) and its plaintext row deleted.
 * Throws when the key is wrong.
 */
export function unlockNoticeKey(
  userId: number | bigint,
  passwordOrKey: string | Uint8Array | Buffer,
  isDerivedKey: boolean
): NoticeKey {
  ensureTables();
  const row = db.query('SELECT secret_encrypted FROM gateway_notice_keys WHERE user_id = ?').get(userId) as { secret_encrypted: string } | null;
  if (row) {
    const hex = decryptUserSecret(userId, passwordOrKey, isDerivedKey, row.secret_encrypted);
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Notice key: stored secret is malformed');
    return toKey(hex);
  }
  const legacy = takeLegacyPlaintextSecret();
  const hex = legacy ?? Buffer.from(generateSecretKey()).toString('hex');
  const key = toKey(hex);
  const encrypted = encryptUserSecret(userId, passwordOrKey, isDerivedKey, hex);
  db.transaction(() => {
    db.query('INSERT INTO gateway_notice_keys (user_id, pubkey, secret_encrypted) VALUES (?, ?, ?)').run(userId, key.pubkey, encrypted);
    if (legacy) db.exec('DROP TABLE gateway_notice_key');
  })();
  return key;
}

/** Headless: NOTICE_SECRET (64 hex or nsec). Null when unset; throws when invalid. */
export function noticeKeyFromEnv(raw = process.env.NOTICE_SECRET): NoticeKey | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return toKey(value.toLowerCase());
  try {
    const d = nip19.decode(value);
    if (d.type === 'nsec') return toKey(Buffer.from(d.data as Uint8Array).toString('hex'));
  } catch { /* fall through */ }
  throw new Error('NOTICE_SECRET must be 64 hex characters or an nsec');
}

/** The notice npub to show, without unlocking anything (null when there is none yet). */
export function noticePubkey(): string | null {
  try {
    const env = noticeKeyFromEnv();
    if (env) return env.pubkey;
  } catch { /* invalid NOTICE_SECRET: reported at startup */ }
  ensureTables();
  const row = db.query('SELECT pubkey FROM gateway_notice_keys ORDER BY created_at DESC, user_id LIMIT 1').get() as { pubkey: string } | null;
  return row?.pubkey ?? null;
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
