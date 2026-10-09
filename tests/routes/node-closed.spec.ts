import { describe, expect, test } from 'bun:test';
import { runRouteScript, PROJECT_ROOT } from './helpers/script-runner';

// 6 Oct: the Gateway's relay connection dropped, the bifrost node emitted
// 'closed', the Gateway stopped monitoring it and never recreated it: no
// signature for three days. An unexpected close must trigger the restart path.

describe('bifrost node closed by itself', () => {
  test('an unexpected close recreates the node once; an intentional cleanup does not', () => {
    const out = runRouteScript<any>(`
      const root = ${JSON.stringify(PROJECT_ROOT)};
      const { Lib, PackageEncoder } = await import('@frostr/bifrost');
      const { createBifrostNode, cleanupBifrostNode } = await import(root + 'src/frostr/node.ts');
      const { setupNodeEventListeners } = await import(root + 'src/node/manager.ts');
      const { group, shares } = Lib.generate_dealer_package(2, 3);
      const make = () => createBifrostNode({ group: PackageEncoder.group.encode(group), share: PackageEncoder.share.encode(shares[0]), relays: ['wss://relay.invalid'] });
      const logs = [];
      const log = (t, m) => logs.push(t + ': ' + m);

      // The relay dropped: the node closes by itself (twice, as reconnect noise can).
      let recreated = 0;
      const a = make();
      setupNodeEventListeners(a, log, () => {}, new Map(), () => { recreated += 1; });
      a.emit('closed', a);
      a.emit('closed', a);

      // An intentional cleanup (replacing the node, shutdown): no recreate.
      let recreatedAfterCleanup = 0;
      const b = make();
      setupNodeEventListeners(b, log, () => {}, new Map(), () => { recreatedAfterCleanup += 1; });
      cleanupBifrostNode(b);
      b.emit('closed', b);

      await new Promise(r => setTimeout(r, 100));
      console.log('@@RESULT@@' + JSON.stringify({ recreated, recreatedAfterCleanup, warned: logs.some(l => l.includes('closed unexpectedly')) }));
      process.exit(0);
    `);
    expect(out.recreated).toBe(1);
    expect(out.recreatedAfterCleanup).toBe(0);
    expect(out.warned).toBe(true);
  });
});
