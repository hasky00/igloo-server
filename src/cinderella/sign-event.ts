/**
 * Gateway signing: every signature goes through Cinderella share nodes,
 * which only sign events whose full JSON is attached and matches the
 * sighash. Used by /api/sign and the NIP-46 signer.
 */

import type { ServerBifrostNode } from '../routes/types.js';
import { withTimeout } from '../routes/utils.js';
import { cinderella_sign, group_pubkey, type EventTemplate } from './request.js';
import type { NostrEvent } from './types.js';

export type PolicySignResult =
  | { ok: true; event: NostrEvent }
  | { ok: false; code: 'SIGN_REFUSED_OR_UNREACHABLE' | 'SIGN_FAILED'; reason: string };

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
    const event = await withTimeout(cinderella_sign(node as any, template), timeoutMs, 'SIGN_TIMEOUT');
    return { ok: true, event };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/time(d)? ?out/i.test(reason)) {
      return { ok: false, code: 'SIGN_REFUSED_OR_UNREACHABLE', reason: REFUSED_OR_UNREACHABLE };
    }
    return { ok: false, code: 'SIGN_FAILED', reason };
  }
}
