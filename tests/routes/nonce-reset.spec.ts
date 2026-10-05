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

  test('the Gateway node also drops what it gave, ignores stale messages, and announces its own start', () => {
    const out = runRouteScript<any>(`
      const root = ${JSON.stringify(PROJECT_ROOT)};
      const { Lib, PackageEncoder } = await import('@frostr/bifrost');
      const { createBifrostNode } = await import(root + 'src/frostr/node.ts');
      const { RESET_TOPIC } = await import(root + 'src/cinderella/resync.ts');
      const { group, shares } = Lib.generate_dealer_package(2, 3);
      const node = createBifrostNode({ group: PackageEncoder.group.encode(group), share: PackageEncoder.share.encode(shares[0]), relays: ['wss://relay.invalid'] });
      const peerIdx = shares[1].idx;
      const peer = group.members.find(m => m.idx === peerIdx).pubkey.slice(-64);
      const self = group.members.find(m => m.idx === shares[0].idx).pubkey.slice(-64);
      node.pool._outgoing.set(peerIdx, new Map([['g1', {}]]));
      node.emit('message', { type: 'event', topic: RESET_TOPIC, data: {}, event: { pubkey: peer } });
      const gaveDropped = (node.pool._outgoing.get(peerIdx)?.size ?? 0) === 0;

      const now = Math.floor(Date.now() / 1000);
      const ev = (created_at) => ({ pubkey: peer, created_at, kind: 20000, tags: [['p', self]], content: '' });
      const fresh = node.client._filter(ev(now));
      const replayed = node.client._filter(ev(now - 120));

      const announced = [];
      node.client.announce = (t, peers) => { announced.push({ topic: t.topic, peers: peers.length }); return []; };
      node.emit('ready', node);
      console.log('@@RESULT@@' + JSON.stringify({ gaveDropped, fresh, replayed, announced, topic: RESET_TOPIC }));
      process.exit(0);
    `);
    expect(out.gaveDropped).toBe(true);
    expect(out.fresh).toBe(true);
    expect(out.replayed).toBe(false);
    expect(out.announced).toEqual([{ topic: out.topic, peers: 2 }]);
  });
});
