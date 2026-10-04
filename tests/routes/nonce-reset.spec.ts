import { describe, expect, test } from 'bun:test';
import { runRouteScript, PROJECT_ROOT } from './helpers/script-runner';

// A share node that restarted announces that its nonces are dead
// (cinderella PR #19, topic cinderella/nonce-reset). The Gateway's node must
// drop the nonces it holds from that node, so its next signature pings first
// instead of failing on a stale nonce (the 4 Oct pass-test failure).

describe('nonce reset from a restarted share node', () => {
  test('the Gateway node drops the nonces it holds from that node, and only those', () => {
    const out = runRouteScript<any>(`
      const root = ${JSON.stringify(PROJECT_ROOT)};
      const { Lib, PackageEncoder } = await import('@frostr/bifrost');
      const { createBifrostNode } = await import(root + 'src/frostr/node.ts');
      const { RESET_TOPIC } = await import(root + 'src/cinderella/resync.ts');
      const { group, shares } = Lib.generate_dealer_package(2, 3);
      const node = createBifrostNode({ group: PackageEncoder.group.encode(group), share: PackageEncoder.share.encode(shares[0]), relays: ['wss://relay.invalid'] });
      const incoming = node.pool._incoming;
      const fill = (idx) => incoming.set(idx, new Map([['n1', {}], ['n2', {}]]));
      fill(shares[1].idx); fill(shares[2].idx);
      const restarted = group.members.find(m => m.idx === shares[1].idx).pubkey.slice(-64);
      node.emit('message', { type: 'event', topic: RESET_TOPIC, data: { at: Date.now() }, event: { pubkey: restarted } });
      node.emit('message', { type: 'event', topic: 'something/else', data: {}, event: { pubkey: group.members.find(m => m.idx === shares[2].idx).pubkey.slice(-64) } });
      console.log('@@RESULT@@' + JSON.stringify({
        dropped: (incoming.get(shares[1].idx)?.size ?? 0),
        kept: (incoming.get(shares[2].idx)?.size ?? 0),
      }));
      process.exit(0);
    `);
    expect(out.dropped).toBe(0);
    expect(out.kept).toBe(2);
  });
});
