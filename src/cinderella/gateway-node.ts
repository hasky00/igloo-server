/**
 * Options applied to every bifrost node this server creates.
 *
 * Send-only: the Gateway runs no signing policy of its own, so it must never
 * contribute a partial signature or ECDH share for another member — otherwise
 * a stolen share could use the Gateway as its co-signer and skip every
 * Cinderella node. Enforced with bifrost's middleware hooks rather than peer
 * policies, because peer policies can be changed at runtime from the UI.
 * Set GATEWAY_SEND_ONLY=false to run as an ordinary igloo signer.
 */

import type { BifrostNodeOptions } from '@frostr/bifrost';
import { spend_refused_nonce } from './resync.js';

export function isGatewaySendOnly(): boolean {
  return (process.env.GATEWAY_SEND_ONLY ?? 'true').trim().toLowerCase() !== 'false';
}

/** Same env keys and bounds as getOpTimeoutMs in routes/utils.ts. */
function requestTimeoutMs(): number {
  for (const key of ['FROSTR_SIGN_TIMEOUT', 'SIGN_TIMEOUT_MS']) {
    const n = Number.parseInt(process.env[key] ?? '', 10);
    if (Number.isFinite(n)) return Math.max(1000, Math.min(120000, n));
  }
  return 30000;
}

export function gatewayNodeOptions(): Partial<BifrostNodeOptions> {
  // bifrost's own wait for a peer response. A signature may need two waits
  // (a ping for nonces, then the sign session), so each gets half the route
  // timeout: cinderella_sign then always finishes — and discards the nonces
  // of a failed session — before the route gives up on it.
  const options: Partial<BifrostNodeOptions> = {
    node_config: { sub_timeout: Math.max(1000, Math.floor(requestTimeoutMs() / 2)) }
  };
  if (!isGatewaySendOnly()) return options;

  return {
    ...options,
    middleware: {
      sign: (node, msg) => {
        spend_refused_nonce(node, msg);
        throw new Error('gateway is send-only: it does not co-sign for other members');
      },
      ecdh: () => {
        throw new Error('gateway is send-only: it does not answer ECDH for other members');
      }
    }
  };
}
