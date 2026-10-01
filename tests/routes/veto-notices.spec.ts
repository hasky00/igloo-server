import { describe, expect, test } from 'bun:test';
import { runRouteScript, PROJECT_ROOT } from './helpers/script-runner';

// Veto notices from share nodes (Cinderella PR #16): a node tells the Gateway's
// notice key {"type":"cinderella-veto","id":…}; the held event becomes 'vetoed'.
// Each case in its own process with its own database.

const setup = `
  const root = ${JSON.stringify(PROJECT_ROOT)};
  process.env.NODE_ENV = 'test';
  const { generateSecretKey, getPublicKey, getEventHash, finalizeEvent, nip17, nip19, nip44 } = await import('nostr-tools');
  const store = await import(root + 'src/db/held-events.ts');
  const db = await import(root + 'src/db/database.ts');
  const { getOrCreateNoticeKey } = await import(root + 'src/db/notices.ts');
  const PK = 'a'.repeat(64);
  const ev = (content) => ({ pubkey: PK, kind: 0, created_at: 100, tags: [], content });
  const hold = (e) => store.holdEvent({ event: e, eventId: getEventHash(e), unlockAt: 1000, nextAttemptAt: 1000, replaceable: true });
  const finish = async (result) => { try { await db.closeDatabase(); } catch {} console.log('@@RESULT@@' + JSON.stringify(result)); process.exit(0); };
  const nodeSk = generateSecretKey(), otherSk = generateSecretKey();
  const notice = (from, to, id) => nip17.wrapEvent(from, { publicKey: to }, JSON.stringify({ type: 'cinderella-veto', id, status: 'vetoed' }));
`;

describe('veto notices', () => {
  test('a verified notice from a configured node marks the held event vetoed; everything else is ignored', () => {
    const out = runRouteScript<any>(setup + `
      const { handleNoticeWrap } = await import(root + 'src/cinderella/veto-notices.ts');
      const { sk, pubkey } = getOrCreateNoticeKey();
      const allowed = [getPublicKey(nodeSk)];
      const h = hold(ev('{"name":"pumpkin"}'));

      const fromOther = handleNoticeWrap(notice(otherSk, pubkey, h.event_id), sk, allowed);
      const statusAfterOther = store.getHeld(h.id).status;

      // forged seal: signed by otherSk but claiming nodeSk as author
      const rumor = { kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', pubkey]], content: JSON.stringify({ type: 'cinderella-veto', id: h.event_id, status: 'vetoed' }), pubkey: getPublicKey(nodeSk) };
      rumor.id = getEventHash(rumor);
      const seal = finalizeEvent({ kind: 13, created_at: rumor.created_at, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(otherSk, pubkey)) }, otherSk);
      const tk = generateSecretKey();
      const forged = finalizeEvent({ kind: 1059, created_at: rumor.created_at, tags: [['p', pubkey]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(tk, pubkey)) }, tk);
      const fromForged = handleNoticeWrap(forged, sk, allowed);

      const garbage = handleNoticeWrap(nip17.wrapEvent(nodeSk, { publicKey: pubkey }, 'hello'), sk, allowed);
      const statusBefore = store.getHeld(h.id).status;

      const genuine = handleNoticeWrap(notice(nodeSk, pubkey, h.event_id), sk, allowed);
      const again = handleNoticeWrap(notice(nodeSk, pubkey, h.event_id), sk, allowed);
      await finish({
        fromOther, statusAfterOther, fromForged, garbage, statusBefore, genuine, again,
        after: store.getHeld(h.id).status,
        due: store.dueHeld(PK, 10_000).length,
        cancel: store.cancelHeld(h.id, PK),
      });
    `);
    expect(out.fromOther).toBe('unknown_sender');
    expect(out.statusAfterOther).toBe('held');
    expect(out.fromForged).toBe('unverified');
    expect(out.garbage).toBe('not_a_notice');
    expect(out.statusBefore).toBe('held');
    expect(out.genuine).toBe('vetoed');
    expect(out.again).toBe('not_held');
    expect(out.after).toBe('vetoed');
    expect(out.due).toBe(0);          // the scheduler skips vetoed events
    expect(out.cancel).toBe(false);
  });

  test('NODE_ALERT_PUBKEYS accepts npubs and hex, comma-separated or JSON', () => {
    const out = runRouteScript<any>(setup + `
      const { nodeAlertPubkeys } = await import(root + 'src/cinderella/veto-notices.ts');
      const a = getPublicKey(nodeSk), b = getPublicKey(otherSk);
      await finish({
        csv: nodeAlertPubkeys(nip19.npubEncode(a) + ', ' + b),
        json: nodeAlertPubkeys(JSON.stringify([nip19.npubEncode(a), 'npub1nope', b, b])),
        none: nodeAlertPubkeys(''),
        a, b,
      });
    `);
    expect(out.csv).toEqual([out.a, out.b]);
    expect(out.json).toEqual([out.a, out.b]);
    expect(out.none).toEqual([]);
  });

  test('the listener marks a held event vetoed from a notice on the relay; notice-key route shows the npub', () => {
    const out = runRouteScript<any>(setup + `
      const { NostrRelay } = await import(root + 'src/class/relay.ts');
      const { SimplePool } = await import('nostr-tools');
      const relay = new NostrRelay({ info: false, debug: false });
      await relay.start();
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
        fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('relay')),
        websocket: relay.handler() });
      const relayUrl = 'ws://127.0.0.1:' + server.port;
      process.env.NOTICE_RELAYS = JSON.stringify([relayUrl]);
      process.env.NODE_ALERT_PUBKEYS = nip19.npubEncode(getPublicKey(nodeSk));

      const { startVetoNoticeListener } = await import(root + 'src/cinderella/veto-notices.ts');
      const { handleHeldEventsRoute } = await import(root + 'src/routes/held-events.ts');
      const h = hold(ev('{"name":"pumpkin"}'));
      const logs = [];
      const stop = startVetoNoticeListener((level, message) => logs.push(level + ': ' + message));
      const { pubkey } = getOrCreateNoticeKey();

      const pool = new SimplePool();
      await Promise.allSettled(pool.publish([relayUrl], notice(nodeSk, pubkey, h.event_id)));
      let status = 'held';
      for (let i = 0; i < 50 && status !== 'vetoed'; i++) { await Bun.sleep(100); status = store.getHeld(h.id).status; }

      const res = await handleHeldEventsRoute(new Request('http://localhost/api/held-events/notice-key'), new URL('http://localhost/api/held-events/notice-key'), { node: null }, { authenticated: true });
      const body = await res.json();
      stop(); pool.close([relayUrl]); server.stop(true);
      await finish({ status, logs, route: res.status, npub: body.npub, expected: nip19.npubEncode(pubkey), nodes: body.nodeAlertPubkeys });
    `, { ALLOW_LOCALHOST_RELAY: 'true' });
    expect(out.status).toBe('vetoed');
    expect(out.logs.some((l: string) => l.includes('vetoed from the veto key'))).toBe(true);
    expect(out.route).toBe(200);
    expect(out.npub).toBe(out.expected);
    expect(out.nodes).toHaveLength(1);
  }, { timeout: 20000 });
});
