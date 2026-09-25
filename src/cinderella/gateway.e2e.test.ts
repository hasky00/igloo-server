/**
 * Gateway end to end: real bifrost 2 nodes over this server's own relay.
 *
 * The gateway is built exactly as the server builds it (createConnectedNode,
 * so the send-only middleware and timeouts apply). Its only peer is a share
 * node that follows Cinderella's contract — decode the attached event, check
 * it matches the sighash, allow kinds 1 and 7 only — with the same resync
 * hooks the real Cinderella node uses (hasky00/cinderella src/share-node.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BifrostNode, Lib, PackageEncoder } from '@frostr/bifrost';
import { getEventHash, verifyEvent } from 'nostr-tools';
import { NostrRelay } from '../class/relay.js';
import { createConnectedNode, cleanupBifrostNode } from '../frostr/index.js';
import type { ServerBifrostNode } from '../routes/types.js';
import { decode_event_content } from './content.js';
import { attach_responder_resync, close_node, spend_refused_nonce } from './resync.js';
import { signEventWithPolicy } from './sign-event.js';

const TIMEOUT_MS = 3000;   // FROSTR_SIGN_TIMEOUT: the route timeout; bifrost waits half of it
const ALLOWED_KINDS = [1, 7];

const { group, shares } = Lib.generate_dealer_package(2, 3);
const groupCred = PackageEncoder.group.encode(group);
const gatewayShareCred = PackageEncoder.share.encode(shares[0]);

let server: ReturnType<typeof Bun.serve>;
let relayUrl = '';
let gateway: ServerBifrostNode;
let share: BifrostNode;
const refusals: string[] = [];

function makeShareNode(): BifrostNode {
  const node = new BifrostNode(group, shares[1], [relayUrl], {
    node_config: { msg_timeout: TIMEOUT_MS, sub_timeout: TIMEOUT_MS },
    middleware: {
      sign: (n: BifrostNode, msg: any) => {
        try {
          const content = msg?.data?.content;
          if (typeof content !== 'string') throw new Error('blind sign request');
          const event = decode_event_content(content);
          const id = getEventHash(event);
          const hashes: string[][] = msg.data.hashes ?? [];
          if (hashes.length !== 1 || hashes[0][0] !== id) throw new Error('content does not match sighash');
          if (!ALLOWED_KINDS.includes(event.kind)) throw new Error(`kind ${event.kind} not allowed`);
          return msg;
        } catch (err) {
          refusals.push(err instanceof Error ? err.message : String(err));
          spend_refused_nonce(n, msg);
          throw err;
        }
      }
    }
  });
  attach_responder_resync(node);
  return node;
}

async function makeGateway(): Promise<ServerBifrostNode> {
  const { node } = await createConnectedNode({ group: groupCred, share: gatewayShareCred, relays: [relayUrl] }, { enableLogging: false });
  return node as ServerBifrostNode;
}

const template = (kind: number) => ({ kind, created_at: Math.floor(Date.now() / 1000), tags: [], content: `gm ${Math.random()}` });

beforeAll(async () => {
  process.env.FROSTR_SIGN_TIMEOUT = String(TIMEOUT_MS);
  delete process.env.GATEWAY_SEND_ONLY;

  const relay = new NostrRelay({ info: false, debug: false });
  await relay.start();
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined as never }) ? undefined : new Response('relay', { status: 426 })),
    websocket: relay.handler()
  });
  relayUrl = `ws://127.0.0.1:${server.port}`;

  share = makeShareNode();
  await share.connect();
  gateway = await makeGateway();
});

afterAll(async () => {
  cleanupBifrostNode(gateway as any);
  await close_node(share);
  server.stop(true);
});

describe('Cinderella gateway (real bifrost nodes)', () => {
  it('signs an allowed event with the group key', async () => {
    const res = await signEventWithPolicy(gateway, template(1), TIMEOUT_MS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.event.pubkey).toBe(group.group_pk.slice(-64));
    expect(verifyEvent(res.event as any)).toBe(true);
  }, { timeout: 15000 });

  it('reports a policy refusal as refused-or-unreachable', async () => {
    const before = refusals.length;
    const res = await signEventWithPolicy(gateway, template(0), TIMEOUT_MS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SIGN_REFUSED_OR_UNREACHABLE');
    expect(refusals.slice(before)).toContain('kind 0 not allowed');
  }, { timeout: 15000 });

  it('keeps signing after a refusal', async () => {
    const res = await signEventWithPolicy(gateway, template(7), TIMEOUT_MS);
    expect(res.ok).toBe(true);
  }, { timeout: 15000 });

  it('is send-only: refuses to co-sign for another member', async () => {
    const rejected: string[] = [];
    (gateway as any).on('/sign/handler/rej', (reason: string) => rejected.push(String(reason)));
    await share.req.ping(gateway.pubkey);   // get nonces from the gateway
    const res = await share.req.sign_batch([['ab'.repeat(32)]], { retries: 0 });
    expect(res.ok).toBe(false);
    expect(rejected.some((r) => r.includes('send-only'))).toBe(true);
  }, { timeout: 15000 });

  it('signs on the first attempt after the gateway restarts', async () => {
    cleanupBifrostNode(gateway as any);
    gateway = await makeGateway();
    const res = await signEventWithPolicy(gateway, template(1), TIMEOUT_MS);
    expect(res.ok).toBe(true);
  }, { timeout: 15000 });

  it('recovers within one attempt after a share node restarts', async () => {
    await close_node(share);
    share = makeShareNode();
    await share.connect();
    const first = await signEventWithPolicy(gateway, template(1), TIMEOUT_MS);
    const second = await signEventWithPolicy(gateway, template(1), TIMEOUT_MS);
    expect(first.ok || second.ok).toBe(true);
    expect(second.ok).toBe(true);
  }, { timeout: 20000 });
});
