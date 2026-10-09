import { describe, expect, test } from 'bun:test';
import { runRouteScript, PROJECT_ROOT } from './helpers/script-runner';

// Held (delay-gated) events: store, /api/sign 202, scheduler, list/cancel routes.
// Each case runs in its own process with its own database. The real-node flow
// (share node delay gate, publish to a relay) is in src/cinderella/held-events.e2e.test.ts.

const ENV = { HELD_RETRY_MARGIN_MS: '0' };

const setup = `
  const root = ${JSON.stringify(PROJECT_ROOT)};
  process.env.NODE_ENV = 'test';
  const store = await import(root + 'src/db/held-events.ts');
  const db = (await import(root + 'src/db/database.ts'));
  const { getEventHash } = await import('nostr-tools');
  const PK = 'a'.repeat(64);
  const ev = (kind, created_at, content = 'x') => ({ pubkey: PK, kind, created_at, tags: [], content });
  const hold = (e, unlockAt = 1000) => store.holdEvent({ event: e, eventId: getEventHash(e), unlockAt, nextAttemptAt: unlockAt, replaceable: e.kind === 0 });
  const finish = async (result) => { try { await db.closeDatabase(); } catch {} console.log('@@RESULT@@' + JSON.stringify(result)); process.exit(0); };

  // A fake bifrost node, enough for cinderella_sign: every signature is refused (times out).
  const signCalls = [];
  const listeners = new Map();
  const emit = (name, ...args) => { for (const f of listeners.get(name) ?? []) f(...args); };
  // A share node that answers with a Cinderella refusal (reject message), as on the real wire.
  const { encode_refusal } = await import(root + 'src/cinderella/refusal.ts');
  const refuseWith = (refusal) => async (vecs, opts) => {
    signCalls.push(opts?.peers ?? null);
    emit('message', { type: 'reject', reason: encode_refusal({ sighash: vecs[0][0], ...refusal }), event: { pubkey: 'b'.repeat(64) } });
    return { ok: false, err: 'unexpected message type for psig' };
  };
  const fakeNode = (signBatch = async (vecs, opts) => { signCalls.push(opts?.peers ?? null); return { ok: false, err: 'request timed out' }; }) => ({
    group: { group_pk: '02' + PK, threshold: 2, members: [{ idx: 1, pubkey: '02' + PK }, { idx: 2, pubkey: '03' + 'b'.repeat(64) }, { idx: 3, pubkey: '02' + 'c'.repeat(64) }] },
    peers: [{ pubkey: 'b'.repeat(64), policy: { send: true, recv: false } }, { pubkey: 'c'.repeat(64), policy: { send: true, recv: false } }],
    pool: { can_sign: () => true },
    signer: { idx: 1 },
    on: (name, f) => { listeners.set(name, [...(listeners.get(name) ?? []), f]); },
    off: (name, f) => { listeners.set(name, (listeners.get(name) ?? []).filter(g => g !== f)); },
    req: { sign_batch: signBatch, ping: async () => ({ ok: true }) },
  });
`;

describe('held events', () => {
  test('store: one row per event id, newest replaceable wins, cancel only while held', () => {
    const out = runRouteScript<any>(setup + `
      const a = hold(ev(0, 100, 'first'));
      const again = hold(ev(0, 100, 'first'));
      const b = hold(ev(0, 200, 'second'));            // newer profile supersedes a
      const older = hold(ev(0, 150, 'late but older')); // older than b: superseded at once
      const del = hold(ev(5, 300));                     // deletions are independent
      await finish({
        sameRow: a.id === again.id,
        a: store.getHeld(a.id).status, b: b.status, older: older.status, del: del.status,
        due: store.dueHeld(PK, 1000).map(h => h.kind).sort(),
        cancelOther: store.cancelHeld(b.id, 'f'.repeat(64)),
        cancel: store.cancelHeld(b.id, PK),
        cancelTwice: store.cancelHeld(b.id, PK),
      });
    `, ENV);
    expect(out.sameRow).toBe(true);
    expect(out.a).toBe('superseded');
    expect(out.b).toBe('held');
    expect(out.older).toBe('superseded');
    expect(out.del).toBe('held');
    expect(out.due).toEqual([0, 5]);
    expect(out.cancelOther).toBe(false);
    expect(out.cancel).toBe(true);
    expect(out.cancelTwice).toBe(false);
  });

  test('/api/sign holds a profile edit (202), shown to every share node; a retry answers from the store', () => {
    const out = runRouteScript<any>(setup + `
      const { handleSignRoute } = await import(root + 'src/routes/sign.ts');
      const node = fakeNode();
      const context = { node, addServerLog: () => {} };
      const body = { event: { ...ev(0, Math.floor(Date.now() / 1000), '{"name":"bobo"}') } };
      const post = () => handleSignRoute(new Request('http://localhost/api/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), new URL('http://localhost/api/sign'), context, { authenticated: true });
      const t0 = Date.now();
      const r1 = await post(); const j1 = await r1.json();
      const callsAfterFirst = signCalls.length;
      const r2 = await post(); const j2 = await r2.json();
      await finish({ s1: r1.status, j1, s2: r2.status, j2, callsAfterFirst, callsTotal: signCalls.length, peersAsked: signCalls, t0 });
    `, ENV);
    expect(out.s1).toBe(202);
    expect(out.j1.code).toBe('SIGN_HELD');
    expect(out.j1.message).toContain('publish it automatically');
    const unlock = Date.parse(out.j1.unlockAt);
    expect(Math.abs(unlock - (out.t0 + 24 * 3_600_000))).toBeLessThan(60_000);
    // shown to both share nodes, one session each
    expect(out.callsAfterFirst).toBe(2);
    expect(out.peersAsked.map((p: string[]) => p[0]).sort()).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
    // the retry of the identical event: same held entry, no new sessions
    expect(out.s2).toBe(202);
    expect(out.j2.heldId).toBe(out.j1.heldId);
    expect(out.callsTotal).toBe(2);
  }, { timeout: 20000 });

  test('scheduler: signs and publishes after unlock; no answer: every 15 min for one delay length, then failed; re-publishes until a relay accepts', () => {
    const out = runRouteScript<any>(setup + `
      const { processDueHeld } = await import(root + 'src/cinderella/held-events.ts');
      const node = fakeNode();
      let clock = 5_000;
      const signed = (e) => ({ ...e, id: getEventHash(e), sig: 'f'.repeat(128) });

      // 1. unlocked profile: signed, first publish rejected everywhere, second accepted
      const p = hold(ev(0, 100, 'profile'), 1_000);
      let publishes = 0;
      const deps = {
        getNode: () => node, now: () => clock,
        sign: async (_n, t) => signed({ ...t, pubkey: PK }),
        publish: async () => (++publishes === 1 ? { 'wss://r': 'blocked' } : { 'wss://r': 'ok' }),
      };
      await processDueHeld(deps);
      const afterFirst = store.getHeld(p.id);
      clock += 6 * 60_000;
      await processDueHeld(deps);
      const afterSecond = store.getHeld(p.id);

      // 2. deletion no node ever answers: every 15 min until 48h past its unlock, then failed
      const d = hold(ev(5, 300), 1_000);
      const failing = { getNode: () => node, now: () => clock, sign: async () => { throw new Error('request timed out'); }, publish: async () => ({}) };
      const start = clock;
      await processDueHeld(failing);
      const d1 = store.getHeld(d.id);
      let dn = d1, gaps = new Set();
      for (let i = 0; i < 500 && dn.status === 'held'; i++) {
        gaps.add(dn.next_attempt_at - clock);
        clock = dn.next_attempt_at;
        await processDueHeld(failing);
        dn = store.getHeld(d.id);
      }
      const d2 = dn;

      // 3. not due yet: untouched
      const later = hold(ev(0, 400, 'later'), clock + 60_000);
      await processDueHeld(deps);

      // 4. no signer running: nothing happens
      await processDueHeld({ ...deps, getNode: () => null, now: () => clock + 10 * 60_000 });

      await finish({
        afterFirst: { status: afterFirst.status, results: afterFirst.publish_results, signed: !!afterFirst.signed },
        afterSecond: { status: afterSecond.status, results: afterSecond.publish_results },
        d1: { status: d1.status, attempts: d1.attempts, next: d1.next_attempt_at - start, error: d1.last_error },
        d2: { status: d2.status, attempts: d2.attempts, error: d2.last_error, failedAt: clock },
        gaps: [...gaps],
        later: store.getHeld(later.id).status,
      });
    `, ENV);
    expect(out.afterFirst.status).toBe('signed');
    expect(out.afterFirst.signed).toBe(true);
    expect(out.afterFirst.results).toEqual({ 'wss://r': 'blocked' });
    expect(out.afterSecond.status).toBe('published');
    expect(out.afterSecond.results).toEqual({ 'wss://r': 'ok' });
    expect(out.d1.status).toBe('held');
    expect(out.d1.attempts).toBe(1);
    expect(out.d1.next).toBe(15 * 60_000);                               // not "once more after another 48h"
    expect(out.d1.error).toContain('no share node answered');
    expect(out.gaps).toEqual([15 * 60_000]);
    expect(out.d2.status).toBe('failed');
    expect(out.d2.attempts).toBeGreaterThan(150);                       // ~48h / 15 min
    expect(out.d2.failedAt).toBeLessThanOrEqual(1_000 + 48 * 3_600_000);
    expect(out.d2.error).toContain('gave up');
    expect(out.later).toBe('held');
  });

  test('the scheduler follows what the share node said: locked, held, rate limited, vetoed, denied', () => {
    const out = runRouteScript<any>(setup + `
      const { processDueHeld } = await import(root + 'src/cinderella/held-events.ts');
      const { SignRefusedError } = await import(root + 'src/cinderella/request.ts');
      const node = fakeNode();
      const now = 10_000;
      const peer = 'b'.repeat(64);
      const refuse = (r) => async () => { throw new SignRefusedError('cinderella: refused by share node: ' + r.reason, [{ sighash: null, peer, idx: 2, ...r }]); };
      const run = async (e, r) => { const h = hold(e, 1_000); await processDueHeld({ getNode: () => node, now: () => now, sign: refuse(r), publish: async () => ({}) }); return store.getHeld(h.id); };

      const unlock = now + 13 * 60_000;                                   // node A's real unlock, later than our guess
      const locked = await run(ev(0, 1, 'a'), { code: 'locked', unlock_at: unlock, reason: 'still locked until ' + new Date(unlock).toISOString() });
      const held = await run(ev(10063, 2), { code: 'held', unlock_at: null, reason: 'held: veto alert not delivered yet, so the delay has not started' });
      const limited = await run(ev(5, 3), { code: 'rate_limited', retry_at: now + 30_000, reason: 'rate limit: 3/1440min exceeded' });
      const vetoed = await run(ev(5, 4), { code: 'vetoed', reason: 'vetoed: 12345678 was vetoed from the veto key' });
      const denied = await run(ev(5, 5), { code: 'denied', reason: 'kind 5 not in any tier (default deny)' });
      const pick = (h) => ({ status: h.status, next: h.next_attempt_at, unlock: h.unlock_at, error: h.last_error, by: h.vetoed_by });
      await finish({ now, unlock, peer, locked: pick(locked), held: pick(held), limited: pick(limited), vetoed: pick(vetoed), denied: pick(denied) });
    `, ENV);
    expect(out.locked.status).toBe('held');
    expect(out.locked.next).toBe(out.unlock);                            // at the node's unlock (margin 0 here)
    expect(out.locked.unlock).toBe(out.unlock);                          // and the card shows it
    expect(out.locked.error).toContain('still locked until');
    expect(out.held.next).toBe(out.now + 15 * 60_000);
    expect(out.held.error).toContain('veto alert not delivered');
    expect(out.limited.next).toBe(out.now + 30_000);
    expect(out.vetoed.status).toBe('vetoed');
    expect(out.vetoed.by).toBe(out.peer);
    expect(out.denied.status).toBe('failed');
    expect(out.denied.error).toContain('not in any tier');
  });

  test('first request: the node\'s own unlock time is stored; refusals and reasons reach /api/sign', () => {
    const out = runRouteScript<any>(setup + `
      const { signOrHold } = await import(root + 'src/cinderella/held-events.ts');
      const { signEventWithPolicy } = await import(root + 'src/cinderella/sign-event.ts');
      const unlock = Date.now() + 3_600_000 + 7 * 60_000;                // the node started its delay later than we would guess
      const held = await signOrHold(fakeNode(refuseWith({ code: 'held', unlock_at: unlock, reason: 'queued: kind 0 unlocks at ' + new Date(unlock).toISOString() })), { kind: 0, created_at: 50, tags: [], content: '{"name":"x"}' }, 1000);
      const row = store.getHeld(held.held.id);
      const denied = await signEventWithPolicy(fakeNode(refuseWith({ code: 'denied', reason: 'kind 5 not in any tier (default deny)' })), { kind: 5, created_at: 60, tags: [], content: '' }, 1000);
      const limited = await signEventWithPolicy(fakeNode(refuseWith({ code: 'rate_limited', retry_at: Date.now() + 60_000, reason: 'rate limit: 50/60min exceeded' })), { kind: 1, created_at: 70, tags: [], content: 'hi' }, 1000);
      const silent = await signEventWithPolicy(fakeNode(), { kind: 1, created_at: 80, tags: [], content: 'hi' }, 1000);
      await finish({ unlock, rowUnlock: row.unlock_at, rowNext: row.next_attempt_at, rowError: row.last_error, denied, limited, silent, deniedRow: store.getHeldByEventId(getEventHash({ pubkey: PK, kind: 5, created_at: 60, tags: [], content: '' })) });
    `, { ...ENV, HELD_KINDS: '{"0":1,"5":48}' });
    expect(out.rowUnlock).toBe(out.unlock);
    expect(out.rowNext).toBe(out.unlock);
    expect(out.rowError).toContain('unlocks at');
    expect(out.denied.code).toBe('SIGN_REFUSED');
    expect(out.denied.reason).toContain('not in any tier');
    expect(out.deniedRow).toBe(null);                                    // refused for good: not held
    expect(out.limited.code).toBe('SIGN_REFUSED');
    expect(out.limited.reason).toContain('rate limit');
    expect(out.silent.code).toBe('SIGN_REFUSED_OR_UNREACHABLE');         // a node that says nothing: still a timeout
  });

  test('GET /api/held-events lists, DELETE cancels', () => {
    const out = runRouteScript<any>(setup + `
      const { handleHeldEventsRoute } = await import(root + 'src/routes/held-events.ts');
      const context = { node: fakeNode(), addServerLog: () => {} };
      const h = hold(ev(0, 100, '{"name":"bobo"}'));
      const call = (method, path) => handleHeldEventsRoute(new Request('http://localhost' + path, { method }), new URL('http://localhost' + path), context, { authenticated: true });
      const list = await (await call('GET', '/api/held-events')).json();
      const del = await call('DELETE', '/api/held-events/' + h.id);
      const delAgain = await call('DELETE', '/api/held-events/' + h.id);
      const noNode = await handleHeldEventsRoute(new Request('http://localhost/api/held-events'), new URL('http://localhost/api/held-events'), { node: null }, { authenticated: true });
      await finish({ list, del: del.status, delAgain: delAgain.status, after: store.getHeld(h.id).status, noNode: noNode.status });
    `, ENV);
    expect(out.list.events).toHaveLength(1);
    expect(out.list.events[0].kind).toBe(0);
    expect(out.list.events[0].preview).toBe('{"name":"bobo"}');
    expect(out.list.events[0].status).toBe('held');
    expect(out.del).toBe(200);
    expect(out.delAgain).toBe(404);
    expect(out.after).toBe('cancelled');
    expect(out.noNode).toBe(503);
  });
});
