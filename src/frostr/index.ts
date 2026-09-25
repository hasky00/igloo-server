/**
 * FROSTR helpers, ported from @frostr/igloo-core 0.2.4 (MIT, see ./LICENSE)
 * to @frostr/bifrost 2.x. igloo-core only supports bifrost 1.x, whose nodes
 * cannot talk to 2.x nodes, so this server carries its own copy.
 *
 * Only the API this server uses is re-exported; the IglooCore class wrapper
 * from upstream is intentionally omitted.
 */

export * from './types.js';

export {
  decodeShare,
  decodeGroup,
  recoverSecretKeyFromCredentials
} from './keyset.js';

export {
  createAndConnectNode,
  createConnectedNode,
  cleanupBifrostNode,
  type NodeEventConfig
} from './node.js';

export { sendEcho, DEFAULT_ECHO_RELAYS } from './echo.js';

export { DEFAULT_PING_TIMEOUT } from './ping.js';

export { validateShare, validateGroup } from './validation.js';

export {
  normalizePubkey,
  comparePubkeys,
  extractSelfPubkeyFromCredentials
} from './peer.js';

export {
  normalizeNodePolicies,
  setNodePolicies,
  getNodePolicies,
  getNodePolicy,
  canSendToPeer,
  canReceiveFromPeer
} from './policy.js';
