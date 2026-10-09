/**
 * Gateway signing: every signature goes through Cinderella share nodes,
 * which only sign events whose full JSON is attached and matches the
 * sighash. Used by /api/sign and the NIP-46 signer.
 */

import type { ServerBifrostNode } from '../routes/types.js';
import { withTimeout } from '../routes/utils.js';
import { cinderella_sign, group_pubkey, type EventTemplate } from './request.js';
import type { NostrEvent } from './types.js';
import { heldDelayHours } from './held-config.js';
import { describeFailure, heldMessage, refusalsOf, signOrHold } from './held-events.js';

export type PolicySignResult =
  | { ok: true; event: NostrEvent }
  | { ok: false; code: 'SIGN_REFUSED_OR_UNREACHABLE' | 'SIGN_FAILED'; reason: string }
  /** A share node refused and said why (e.g. rate limit, kind not allowed). */
  | { ok: false; code: 'SIGN_REFUSED'; reason: string }
  | { ok: false; code: 'SIGN_HELD'; reason: string; heldId: string; unlockAt: number; status: string }
  | { ok: false; code: 'SIGN_VETOED'; reason: string; heldId: string; vetoedBy: string | null };

/**
 * bifrost does not relay refusals (FROSTR-ORG/bifrost#13): a share node that
 * refuses stays silent, so a policy refusal and an unreachable signer both
 * end in a timeout here. Say so rather than pretending to know which.
 */
export const REFUSED_OR_UNREACHABLE =
  'Not signed: refused by the signing policy (e.g. kind not allowed, rate limit, or delay gate) or no signer reachable';

export function groupPubkey(node: ServerBifrostNode): string {
  return group_pubkey(node as any);
}

export async function signEventWithPolicy(
  node: ServerBifrostNode,
  template: EventTemplate,
  timeoutMs: number
): Promise<PolicySignResult> {
  try {
    // Delay-gated kinds (profile, delete, …): shown to every share node and
    // held; the gateway re-requests and publishes them after the delay.
    if (heldDelayHours(template.kind) !== undefined) {
      const outcome = await signOrHold(node, template, timeoutMs);
      if (outcome.ok) return { ok: true, event: outcome.event };
      if ('refused' in outcome) return { ok: false, code: 'SIGN_REFUSED', reason: `Not signed: ${outcome.refused}` };
      if (outcome.held.status === 'vetoed') {
        return { ok: false, code: 'SIGN_VETOED', reason: heldMessage(outcome.held), heldId: outcome.held.id, vetoedBy: outcome.held.vetoed_by };
      }
      return {
        ok: false,
        code: 'SIGN_HELD',
        reason: heldMessage(outcome.held),
        heldId: outcome.held.id,
        unlockAt: outcome.held.unlock_at,
        status: outcome.held.status
      };
    }
    const event = await withTimeout(cinderella_sign(node as any, template), timeoutMs, 'SIGN_TIMEOUT');
    return { ok: true, event };
  } catch (error) {
    // The share node said why: show that, not "timed out".
    if (refusalsOf(error).length) return { ok: false, code: 'SIGN_REFUSED', reason: `Not signed: ${describeFailure(error)}` };
    const reason = error instanceof Error ? error.message : String(error);
    if (/time(d)? ?out/i.test(reason)) {
      return { ok: false, code: 'SIGN_REFUSED_OR_UNREACHABLE', reason: REFUSED_OR_UNREACHABLE };
    }
    return { ok: false, code: 'SIGN_FAILED', reason };
  }
}
