import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runRouteScript, PROJECT_ROOT } from './helpers/script-runner';

// RelayFeed is a verbatim copy of hasky00/cinderella's reviewed src/relay-feed.ts.
// When cinderella's changes, copy it again and update the commit and hash here.
const CINDERELLA_COMMIT = 'da0ea68';
const CINDERELLA_SHA256 = '1fe7736731ef277013c54cedc0d2ce93e936dae4c9b1cec230e26b0c3c3dbd1b';

describe('RelayFeed (ported from cinderella)', () => {
  test(`is byte-identical to cinderella@${CINDERELLA_COMMIT} below its two header lines`, () => {
    const copy = readFileSync('src/cinderella/relay-feed.ts', 'utf8');
    const lines = copy.split('\n');
    expect(lines[0]).toContain(`hasky00/cinderella@${CINDERELLA_COMMIT}`);
    const body = lines.slice(2).join('\n');
    expect(createHash('sha256').update(body).digest('hex')).toBe(CINDERELLA_SHA256);
  });

  test('only a real EOSE counts; backoff grows on CLOSED and on dropped connections', () => {
    const out = runRouteScript<any>(`
      const root = ${JSON.stringify(PROJECT_ROOT)};
      const { RelayFeed } = await import(root + 'src/cinderella/relay-feed.ts');
      const { TestRelay } = await import(root + 'tests/routes/helpers/test-relay.ts');
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const feed = (relays) => new RelayFeed(relays, { filter: () => ({ kinds: [1059] }), onevent: () => {}, min_backoff_ms: 100, max_backoff_ms: 2000 });

      const dead = feed(['ws://127.0.0.1:1']); dead.start();
      await sleep(1500);
      const deadCaughtUp = dead.all_caught_up; dead.stop();

      const closing = new TestRelay(); closing.closeEveryReq = true; closing.start();
      const c = feed([closing.url]); c.start(); await sleep(3000); c.stop(); closing.stop();
      const dropping = new TestRelay(); dropping.dropOnConnect = true; dropping.start();
      const d = feed([dropping.url]); d.start(); await sleep(3000); d.stop(); dropping.stop();
      console.log('@@RESULT@@' + JSON.stringify({ deadCaughtUp, reqs: closing.reqCount, conns: dropping.connCount }));
      process.exit(0);
    `);
    expect(out.deadCaughtUp).toBe(false);
    expect(out.reqs).toBeLessThanOrEqual(7);     // 100, 200, 400, 800 ms…; a fixed 100 ms would be ~30
    expect(out.conns).toBeLessThanOrEqual(7);
  }, { timeout: 15000 });
});
