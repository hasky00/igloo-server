/**
 * Which event kinds the share nodes delay, and by how long.
 *
 * Share nodes refuse silently (FROSTR-ORG/bifrost#13), so the gateway cannot
 * read "queued until …" from a refusal. It keeps its own copy of the delay
 * tiers instead: HELD_KINDS='{"0":24,"10063":24,"5":48}' (hours), defaulting
 * to Cinderella's cinderella.config.json. If the copies drift, the re-request
 * schedule absorbs it: an early re-request just waits another round.
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

/** Wait this long past the unlock before re-requesting (clock skew between machines). */
export function retryMarginMs(): number {
  const n = Number.parseInt(process.env.HELD_RETRY_MARGIN_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60_000;
}
