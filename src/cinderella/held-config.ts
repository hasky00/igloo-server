/**
 * Which event kinds the share nodes delay, and by how long.
 *
 * HELD_KINDS='{"0":24,"10063":24,"5":48}' (hours) says which kinds to hold
 * and gives the first guess of the unlock time. Cinderella nodes tell the
 * Gateway their real unlock time when they refuse (src/cinderella/refusal.ts),
 * and the scheduler follows that; the guess only matters for nodes that don't
 * answer (older code, offline). Keep it equal to the nodes' delay tiers.
 */

const DEFAULT_HELD_KINDS: Record<number, number> = { 0: 24, 10063: 24, 5: 48 };

let warned = false;

export function heldKinds(): Record<number, number> {
  const raw = process.env.HELD_KINDS;
  if (!raw || !raw.trim()) return DEFAULT_HELD_KINDS;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<number, number> = {};
    for (const [kind, hours] of Object.entries(parsed)) {
      const k = Number(kind);
      if (Number.isInteger(k) && k >= 0 && typeof hours === 'number' && hours > 0) out[k] = hours;
    }
    return out;
  } catch {
    if (!warned) {
      warned = true;
      console.warn('[held] HELD_KINDS is not valid JSON; using the defaults', DEFAULT_HELD_KINDS);
    }
    return DEFAULT_HELD_KINDS;
  }
}

/** Delay in hours for a delay-gated kind, or undefined if the kind is signed at once. */
export function heldDelayHours(kind: number): number | undefined {
  return heldKinds()[kind];
}

/** Replaceable kinds (NIP-01): only the newest event per kind counts. */
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/**
 * When a node gave no unlock time (no answer, delay not started yet, nonce
 * trouble), try again this often: HELD_RETRY_EVERY_MS, default 15 minutes.
 */
export function retryEveryMs(): number {
  const n = Number.parseInt(process.env.HELD_RETRY_EVERY_MS ?? '', 10);
  return Number.isFinite(n) && n >= 1000 ? n : 15 * 60_000;
}

/** Wait this long past the unlock before re-requesting (clock skew between machines). */
export function retryMarginMs(): number {
  const n = Number.parseInt(process.env.HELD_RETRY_MARGIN_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60_000;
}
