/**
 * Held events end to end, with real bifrost nodes over this server's relay:
 * the gateway (built as the server builds it) and TWO share nodes that follow
 * Cinderella's contract, with a 3.6 s delay gate on kind 0.
 *
 *  - the first request is held, and both share nodes start their clock;
 *  - nothing happens before the unlock;
 *  - after it the gateway re-requests the identical event, one node signs,
 *    and the gateway publishes it to the relay (read back, signature valid).
 *
 * Runs in its own process (own database, env set before any import).
 */

import { describe, expect, test } from 'bun:test';
import { runRouteScript, PROJECT_ROOT } from '../../tests/routes/helpers/script-runner';

const ENV = {
  HELD_KINDS: '{"0":0.001}',          // 3.6 s, matching the share nodes below
  HELD_RETRY_MARGIN_MS: '300',
  FROSTR_SIGN_TIMEOUT: '2000',
  ALLOW_LOCALHOST_RELAY: 'true',
  SKIP_RELAY_PROBE: 'true',
  SKIP_STARTUP_ECHO: 'true',
};

describe('held events with real share nodes', () => {
  test('held, both nodes primed, then re-requested after unlock and published', () => {
    const out = runRouteScript<any>(`
      const root = ${JSON.stringify(PROJECT_ROOT)};
      const { BifrostNode, Lib, PackageEncoder } = await import('@frostr/bifrost');
      const { SimplePool, getEventHash, verifyEvent } = await import('nostr-tools');
      const { NostrRelay } = await import(root + 'src/class/relay.ts');
      const { createConnectedNode } = await import(root + 'src/frostr/index.ts');
      const { decode_event_content } = await import(root + 'src/cinderella/content.ts');
      const { attach_responder_resync, spend_refused_nonce, close_node } = await import(root + 'src/cinderella/resync.ts');
      const { signEventWithPolicy } = await import(root + 'src/cinderella/sign-event.ts');
      const { processDueHeld } = await import(root + 'src/cinderella/held-events.ts');
      const store = await import(root + 'src/db/held-events.ts');

      const relay = new NostrRelay({ info: false, debug: false });
      await relay.start();
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
        fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('relay')),
        websocket: relay.handler() });
      const relayUrl = 'ws://127.0.0.1:' + server.port;
      process.env.RELAYS = JSON.stringify([relayUrl]);
      process.env.PUBLISH_RELAYS = JSON.stringify([relayUrl]);

      const { group, shares } = Lib.generate_dealer_package(2, 3);

      // Share nodes: Cinderella's contract, kinds 1/7 allowed, kind 0 delayed 3.6 s.
      const mkShare = (share) => {
        const queue = new Map();
        const node = new BifrostNode(group, share, [relayUrl], {
          node_config: { msg_timeout: 2000, sub_timeout: 2000 },
          middleware: { sign: (n, msg) => {
            try {
              const ev = decode_event_content(msg.data.content);
              const id = getEventHash(ev);
              if (msg.data.hashes?.length !== 1 || msg.data.hashes[0][0] !== id) throw new Error('content does not match sighash');
              if (ev.kind === 0) {
                const unlock = queue.get(id);
                if (unlock === undefined) { queue.set(id, Date.now() + 3600); throw new Error('queued'); }
                if (Date.now() < unlock) throw new Error('still locked');
              } else if (![1, 7].includes(ev.kind)) {
                throw new Error('kind not allowed');
              }
              return msg;
            } catch (err) { spend_refused_nonce(n, msg); throw err; }
          } }
        });
        attach_responder_resync(node);
        return { node, queue };
      };
      const a = mkShare(shares[1]);
      const b = mkShare(shares[2]);
      await a.node.connect();
      await b.node.connect();
      const { node: gateway } = await createConnectedNode({
        group: PackageEncoder.group.encode(group), share: PackageEncoder.share.encode(shares[0]), relays: [relayUrl]
      }, { enableLogging: false });

      const template = { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: '{"name":"bobo"}' };
      const first = await signEventWithPolicy(gateway, template, 2000);
      const eventId = getEventHash({ ...template, pubkey: group.group_pk.slice(-64) });
      const primed = { a: a.queue.has(eventId), b: b.queue.has(eventId) };

      const deps = { getNode: () => gateway, timeoutMs: 2000 };
      await processDueHeld(deps);                           // not due yet
      const beforeUnlock = store.getHeldByEventId(eventId).status;

      const held = store.getHeldByEventId(eventId);
      await Bun.sleep(Math.max(0, held.next_attempt_at - Date.now()) + 200);
      await processDueHeld(deps);
      const after = store.getHeldByEventId(eventId);

      const pool = new SimplePool();
      const found = await pool.querySync([relayUrl], { ids: [eventId] });
      pool.destroy();

      const result = {
        first: { ok: first.ok, code: first.code, status: first.status, reason: first.reason },
        primed, beforeUnlock,
        after: { status: after.status, results: after.publish_results, error: after.last_error },
        relayUrl,
        onRelay: found.length, valid: found[0] ? verifyEvent(found[0]) : false, content: found[0]?.content ?? null,
      };
      await close_node(gateway); await close_node(a.node); await close_node(b.node);
      server.stop(true);
      console.log('@@RESULT@@' + JSON.stringify(result));
      process.exit(0);
    `, ENV);

    expect(out.first.ok).toBe(false);
    expect(out.first.code).toBe('SIGN_HELD');
    expect(out.first.status).toBe('held');
    expect(out.primed).toEqual({ a: true, b: true });        // both share nodes started their clock
    expect(out.beforeUnlock).toBe('held');
    expect(out.after.status).toBe('published');
    expect(out.after.results?.[out.relayUrl]).toBe('ok');
    expect(out.onRelay).toBe(1);
    expect(out.valid).toBe(true);
    expect(out.content).toBe('{"name":"bobo"}');
  }, { timeout: 30000 });
});
