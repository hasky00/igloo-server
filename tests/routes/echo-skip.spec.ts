import { describe, expect, test } from 'bun:test';
import { runRouteScript } from './helpers/script-runner';

// SKIP_STARTUP_ECHO is read once at module load, so each case runs in a fresh process.
// No control case without the flag: broadcasts always add the public default echo
// relays, and tests must not reach them. The skip log proves which path ran.
describe('SKIP_STARTUP_ECHO', () => {
  test('skips both credential echoes without opening any relay connection', () => {
    const script = `
      const root = ${JSON.stringify(process.cwd() + '/')};
      const { Lib, PackageEncoder } = await import('@frostr/bifrost');
      const { NostrRelay } = await import(root + 'src/class/relay.ts');
      const { broadcastShareEcho, sendSelfEcho } = await import(root + 'src/node/manager.ts');

      const relay = new NostrRelay({ info: false, debug: false });
      await relay.start();
      const server = Bun.serve({
        port: 0, hostname: '127.0.0.1',
        fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('relay')),
        websocket: relay.handler()
      });
      const relays = ['ws://127.0.0.1:' + server.port];

      const { group, shares } = Lib.generate_dealer_package(2, 3);
      const groupCred = PackageEncoder.group.encode(group);
      const shareCred = PackageEncoder.share.encode(shares[0]);

      const logs = [];
      const addServerLog = (level, message) => logs.push(level + ': ' + message);
      const opts = { relays, addServerLog, contextLabel: 'test', timeoutMs: 3000 };

      const broadcast = await broadcastShareEcho(groupCred, shareCred, opts);
      const self = await sendSelfEcho(groupCred, shareCred, opts);
      await Bun.sleep(200);

      console.log('@@RESULT@@' + JSON.stringify({ broadcast, self, connections: relay.conn, logs }));
      server.stop(true);
      process.exit(0);
    `;

    const out = runRouteScript<{ broadcast: boolean; self: boolean; connections: number; logs: string[] }>(
      script,
      { SKIP_STARTUP_ECHO: 'true', ALLOW_LOCALHOST_RELAY: 'true' }
    );
    expect(out.broadcast).toBe(false);
    expect(out.self).toBe(false);
    expect(out.connections).toBe(0);
    expect(out.logs.filter((l) => l.includes('Credential echo skipped (SKIP_STARTUP_ECHO)'))).toHaveLength(2);
  }, { timeout: 20000 });
});
