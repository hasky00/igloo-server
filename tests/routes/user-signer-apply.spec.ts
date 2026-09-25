import { describe, expect, test } from 'bun:test';
import { runRouteScript, PROJECT_ROOT } from './helpers/script-runner';

// Saving relays or credentials while the signer runs must restart it with the
// new values AND hand them to updateNode (the watchdog restarts from that
// snapshot). Found in the Cinderella gateway dry run: new relays never took
// effect, and the watchdog kept bringing the old ones back.
//
// Real bifrost nodes on a local relay. SKIP_STARTUP_ECHO keeps credential
// saves from broadcasting to the public default echo relays.
const ENV = { HEADLESS: 'false', ALLOW_LOCALHOST_RELAY: 'true', SKIP_RELAY_PROBE: 'true', SKIP_STARTUP_ECHO: 'true' };

const setup = `
  const root = ${JSON.stringify(PROJECT_ROOT)};
  const { Lib, PackageEncoder } = await import('@frostr/bifrost');
  const { NostrRelay } = await import(root + 'src/class/relay.ts');
  const db = await import(root + 'src/db/database.ts');
  const { handleUserRoute } = await import(root + 'src/routes/user.ts');

  const serve = async () => {
    const relay = new NostrRelay({ info: false, debug: false });
    await relay.start();
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('relay')),
      websocket: relay.handler()
    });
    return 'ws://127.0.0.1:' + server.port;
  };
  const relayA = await serve();
  const relayB = await serve();

  const { group, shares } = Lib.generate_dealer_package(2, 3);
  const groupCred = PackageEncoder.group.encode(group);
  const shareCreds = shares.map((s) => PackageEncoder.share.encode(s));

  const created = await db.createUser('signer-user', 'signer-password');
  const userId = created.userId;
  db.updateUserCredentials(userId, { group_cred: groupCred, share_cred: shareCreds[0], relays: [relayA] }, 'signer-password', false);

  const updates = [];
  const context = {
    node: null,
    addServerLog: () => {},
    broadcastEvent: () => {},
    peerStatuses: new Map(),
    eventStreams: new Set(),
    restartState: { blockedByCredentials: false },
    updateNode: (node, options) => { updates.push(options?.credentials ?? null); context.node = node; },
  };
  const auth = () => ({ authenticated: true, userId, getPassword: () => 'signer-password' });
  const post = (path, body) => {
    const req = new Request('http://localhost' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return handleUserRoute(req, new URL(req.url), context, auth());
  };
  const finish = async (result) => {
    try { await db.closeDatabase(); } catch {}
    console.log('@@RESULT@@' + JSON.stringify(result));
    process.exit(0);
  };
`;

describe('applying credential and relay changes to a running signer', () => {
  test('POST /api/user/relays restarts a running signer and updates the watchdog snapshot', () => {
    const script = setup + `
      context.node = { running: 'old signer' };
      const res = await post('/api/user/relays', { relays: [relayB] });
      const body = await res.json();
      await finish({ status: res.status, applied: body.applied, updates, relayB, swapped: context.node?.running !== 'old signer' });
    `;
    const out = runRouteScript<any>(script, ENV);
    expect(out.status).toBe(200);
    expect(out.applied).toBe(true);
    expect(out.swapped).toBe(true);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0].relaysEnv).toBe(out.relayB);
  }, { timeout: 20000 });

  test('POST /api/user/relays with no running signer only saves', () => {
    const script = setup + `
      const res = await post('/api/user/relays', { relays: [relayB] });
      const body = await res.json();
      const saved = JSON.parse(db.getUserById(userId).relays);
      await finish({ status: res.status, applied: body.applied, updates, saved, relayB });
    `;
    const out = runRouteScript<any>(script, ENV);
    expect(out.status).toBe(200);
    expect(out.applied).toBe(false);
    expect(out.updates).toHaveLength(0);
    expect(out.saved).toEqual([out.relayB]);
  }, { timeout: 20000 });

  test('saving a new share while the signer runs swaps to the new share', () => {
    const script = setup + `
      context.node = { running: 'old signer' };
      const res = await post('/api/user/credentials', { share_cred: shareCreds[1] });
      await finish({ status: res.status, updates, expected: shareCreds[1], swapped: context.node?.running !== 'old signer' });
    `;
    const out = runRouteScript<any>(script, ENV);
    expect(out.status).toBe(200);
    expect(out.swapped).toBe(true);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0].share).toBe(out.expected);
  }, { timeout: 20000 });
});
