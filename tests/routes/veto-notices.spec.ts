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
  const { TestRelay } = await import(root + 'tests/routes/helpers/test-relay.ts');
  const PK = 'a'.repeat(64);
  const ev = (content) => ({ pubkey: PK, kind: 0, created_at: 100, tags: [], content });
  const hold = (e) => store.holdEvent({ event: e, eventId: getEventHash(e), unlockAt: 1000, nextAttemptAt: 1000, replaceable: false });
  const finish = async (result) => { try { await db.closeDatabase(); } catch {} console.log('@@RESULT@@' + JSON.stringify(result)); process.exit(0); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const until = async (check, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await sleep(50); } return check(); };
  const nodeSk = generateSecretKey(), otherSk = generateSecretKey();
  const noticeSk = generateSecretKey();
  const noticeKey = { sk: noticeSk, pubkey: getPublicKey(noticeSk) };
  const notice = (from, to, id) => nip17.wrapEvent(from, { publicKey: to }, JSON.stringify({ type: 'cinderella-veto', id, status: 'vetoed' }));
  const publish = (relayUrl, event) => new Promise((resolve) => {
    const ws = new WebSocket(relayUrl);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = () => { ws.close(); resolve(true); };
    ws.onerror = () => resolve(false);
  });
  const forgedFrom = (claimed, signer, to, content) => {
    const rumor = { kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', to]], content, pubkey: getPublicKey(claimed) };
    rumor.id = getEventHash(rumor);
    const seal = finalizeEvent({ kind: 13, created_at: rumor.created_at, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(signer, to)) }, signer);
    const tk = generateSecretKey();
    return finalizeEvent({ kind: 1059, created_at: rumor.created_at, tags: [['p', to]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(tk, to)) }, tk);
  };
  const fast = { backoffMs: { min: 100, max: 500 }, advanceMs: 200 };
`;

describe('veto notices', () => {
  test('a verified notice from a configured node marks the held event vetoed, recording which node', () => {
    const out = runRouteScript<any>(setup + `
      const { handleNoticeWrap } = await import(root + 'src/cinderella/veto-notices.ts');
      const allowed = [getPublicKey(nodeSk)];
      const h = hold(ev('{"name":"pumpkin"}'));
      const fromOther = handleNoticeWrap(notice(otherSk, noticeKey.pubkey, h.event_id), noticeSk, allowed);
      const fromForged = handleNoticeWrap(forgedFrom(nodeSk, otherSk, noticeKey.pubkey, JSON.stringify({ type: 'cinderella-veto', id: h.event_id, status: 'vetoed' })), noticeSk, allowed);
      const garbage = handleNoticeWrap(nip17.wrapEvent(nodeSk, { publicKey: noticeKey.pubkey }, 'hello'), noticeSk, allowed);
      const statusBefore = store.getHeld(h.id).status;
      const genuine = handleNoticeWrap(notice(nodeSk, noticeKey.pubkey, h.event_id), noticeSk, allowed);
      const again = handleNoticeWrap(notice(nodeSk, noticeKey.pubkey, h.event_id), noticeSk, allowed);
      const after = store.getHeld(h.id);
      await finish({ fromOther, fromForged, garbage, statusBefore, genuine, again, status: after.status, by: after.vetoed_by, node: getPublicKey(nodeSk), due: store.dueHeld(PK, 10_000).length });
    `);
    expect(out.fromOther).toBe('unknown_sender');
    expect(out.fromForged).toBe('unverified');
    expect(out.garbage).toBe('not_a_notice');
    expect(out.statusBefore).toBe('held');
    expect(out.genuine).toBe('vetoed');
    expect(out.again).toBe('not_held');
    expect(out.status).toBe('vetoed');
    expect(out.by).toBe(out.node);
    expect(out.due).toBe(0);          // the scheduler skips vetoed events
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

  // M2 + L5: junk wraps are never recorded as handled.
  test('only verified notices from configured nodes are recorded; malformed and junk wraps are dropped', () => {
    const out = runRouteScript<any>(setup + `
      const { createVetoNoticeListener } = await import(root + 'src/cinderella/veto-notices.ts');
      const { getNoticeState } = await import(root + 'src/db/notices.ts');
      const relay = new TestRelay(); relay.start();
      const logs = [];
      const listener = createVetoNoticeListener(noticeKey, { ...fast, relays: [relay.url], allowed: [getPublicKey(nodeSk)], log: (l, m) => logs.push(l + ': ' + m) });
      await until(() => listener.caughtUp);
      const h = hold(ev('{"name":"pumpkin"}'));

      const junk = [
        notice(otherSk, noticeKey.pubkey, h.event_id),                                                  // not a node
        forgedFrom(nodeSk, otherSk, noticeKey.pubkey, JSON.stringify({ type: 'cinderella-veto', id: h.event_id, status: 'vetoed' })), // forged seal
        nip17.wrapEvent(nodeSk, { publicKey: noticeKey.pubkey }, 'hello'),                             // from a node, not a notice
      ];
      for (const w of junk) await publish(relay.url, w);
      relay.sendRaw(null);
      relay.sendRaw('nope');
      relay.sendRaw({ id: 'zz' });
      relay.sendRaw({ id: 'ab'.repeat(32), pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64), kind: 1059, created_at: 1, tags: 'x', content: '' });
      await sleep(800);
      const statusAfterJunk = store.getHeld(h.id).status;
      const seenAfterJunk = Object.keys(getNoticeState('seen_wraps') ?? {});

      const real = notice(nodeSk, noticeKey.pubkey, h.event_id);
      await publish(relay.url, real);
      await until(() => store.getHeld(h.id).status === 'vetoed');
      const seen = Object.keys(getNoticeState('seen_wraps') ?? {});
      listener.stop(); relay.stop();
      await finish({ statusAfterJunk, seenAfterJunk, seen, realId: real.id, status: store.getHeld(h.id).status, malformed: logs.filter(l => l.includes('malformed')).length });
    `, { ALLOW_LOCALHOST_RELAY: 'true' });
    expect(out.statusAfterJunk).toBe('held');
    expect(out.seenAfterJunk).toEqual([]);
    expect(out.malformed).toBeGreaterThanOrEqual(4);
    expect(out.status).toBe('vetoed');
    expect(out.seen).toEqual([out.realId]);
  }, { timeout: 20000 });

  // M1 + L5: dead relay and reconnect, per-relay catch-up.
  test("a relay that drops: not caught up, only the live relay's point moves; back: resubscribed, notices work", () => {
    const out = runRouteScript<any>(setup + `
      const { createVetoNoticeListener } = await import(root + 'src/cinderella/veto-notices.ts');
      const { getNoticeState } = await import(root + 'src/db/notices.ts');
      const a = new TestRelay(); a.start();
      const b = new TestRelay(); b.start();
      const listener = createVetoNoticeListener(noticeKey, { ...fast, relays: [a.url, b.url], allowed: [getPublicKey(nodeSk)] });
      const caughtUp = await until(() => listener.caughtUp);
      await sleep(400);

      b.stop();
      const notCaughtUp = await until(() => !listener.caughtUp);
      const before = { ...getNoticeState('seen_until') };
      await sleep(800);
      const after = { ...getNoticeState('seen_until') };
      const h1 = hold(ev('{"name":"one"}'));
      await publish(a.url, notice(nodeSk, noticeKey.pubkey, h1.event_id));
      const viaLive = await until(() => store.getHeld(h1.id).status === 'vetoed');

      b.start();
      const backCaughtUp = await until(() => listener.caughtUp);
      const h2 = hold(ev('{"name":"two"}'));
      await publish(b.url, notice(nodeSk, noticeKey.pubkey, h2.event_id));            // only on the relay that came back
      const viaReconnected = await until(() => store.getHeld(h2.id).status === 'vetoed');

      a.frozen = true;                                                               // silent, socket still open
      listener.stop();
      const idle = createVetoNoticeListener(noticeKey, { ...fast, idleMs: 600, relays: [a.url], allowed: [getPublicKey(nodeSk)] });
      a.frozen = false;
      await until(() => idle.caughtUp);
      a.frozen = true;
      const idleDead = await until(() => !idle.caughtUp, 4000);
      a.frozen = false;
      const idleBack = await until(() => idle.caughtUp, 6000);
      idle.stop(); a.stop(); b.stop();
      await finish({
        caughtUp, notCaughtUp, viaLive, backCaughtUp, viaReconnected, idleDead, idleBack,
        aMoved: after[a.url] > before[a.url], bStayed: after[b.url] === before[b.url],
      });
    `, { ALLOW_LOCALHOST_RELAY: 'true' });
    expect(out.caughtUp).toBe(true);
    expect(out.notCaughtUp).toBe(true);
    expect(out.aMoved).toBe(true);
    expect(out.bStayed).toBe(true);
    expect(out.viaLive).toBe(true);
    expect(out.backCaughtUp).toBe(true);
    expect(out.viaReconnected).toBe(true);
    expect(out.idleDead).toBe(true);
    expect(out.idleBack).toBe(true);
  }, { timeout: 25000 });

  // M3 + L5: a vetoed event submitted again gets a clear answer; the Held tab shows who vetoed it; cancel works.
  test('a vetoed event submitted again is refused as vetoed; the list shows the node; it can be cancelled', () => {
    const out = runRouteScript<any>(setup + `
      const { signOrHold } = await import(root + 'src/cinderella/held-events.ts');
      const { signEventWithPolicy } = await import(root + 'src/cinderella/sign-event.ts');
      const { handleHeldEventsRoute } = await import(root + 'src/routes/held-events.ts');
      const node = { group: { group_pk: '02' + PK }, peers: [] };
      const e = ev('{"name":"pumpkin"}');
      const h = hold(e);
      store.markVetoed(h.event_id, getPublicKey(nodeSk));
      const { pubkey: _pk, ...template } = e;
      const again = await signOrHold(node, template, 1000);
      const res = await signEventWithPolicy(node, template, 1000);
      const ctx = { node, addServerLog: () => {} };
      const list = await (await handleHeldEventsRoute(new Request('http://localhost/api/held-events'), new URL('http://localhost/api/held-events'), ctx, { authenticated: true })).json();
      const del = await handleHeldEventsRoute(new Request('http://localhost/api/held-events/' + h.id, { method: 'DELETE' }), new URL('http://localhost/api/held-events/' + h.id), ctx, { authenticated: true });
      await finish({ againStatus: again.ok ? 'signed' : again.held.status, res, row: list.events[0], npub: nip19.npubEncode(getPublicKey(nodeSk)), del: del.status, after: store.getHeld(h.id).status });
    `);
    expect(out.againStatus).toBe('vetoed');
    expect(out.res.ok).toBe(false);
    expect(out.res.code).toBe('SIGN_VETOED');
    expect(out.res.reason).toContain('vetoed');
    expect(out.res.reason).toContain(out.npub);
    expect(out.res.reason).not.toContain('Held until');
    expect(out.row.status).toBe('vetoed');
    expect(out.row.vetoedBy).toBe(out.npub);
    expect(out.del).toBe(200);
    expect(out.after).toBe('cancelled');
  });

  // L1: the scheduler never overwrites a veto that arrived during a re-request.
  test('a veto arriving while the scheduler re-requests the event wins: never failed, never published', () => {
    const out = runRouteScript<any>(setup + `
      const { processDueHeld } = await import(root + 'src/cinderella/held-events.ts');
      const node = { group: { group_pk: '02' + PK }, peers: [] };
      const node_pk = getPublicKey(nodeSk);

      const h1 = hold(ev('{"name":"one"}'));
      store.updateHeld(h1.id, { attempts: 1 });                            // the last try: a failure would mean 'failed'
      await processDueHeld({ getNode: () => node, now: () => 10_000,
        sign: async () => { store.markVetoed(h1.event_id, node_pk); throw new Error('SIGN_TIMEOUT'); } });

      const h2 = hold(ev('{"name":"two"}'));
      let published = 0;
      await processDueHeld({ getNode: () => node, now: () => 10_000,
        sign: async (_n, t) => { store.markVetoed(h2.event_id, node_pk); return { ...t, pubkey: PK, id: h2.event_id, sig: '00'.repeat(64) }; },
        publish: async () => { published += 1; return { 'wss://x': 'ok' }; } });

      const h3 = hold(ev('{"name":"three"}'));
      store.markVetoed(h3.event_id, node_pk);
      store.updateHeld(h3.id, { status: 'failed', last_error: 'late' });   // any late scheduler write
      await finish({ s1: store.getHeld(h1.id).status, s2: store.getHeld(h2.id).status, published, s3: store.getHeld(h3.id).status });
    `);
    expect(out.s1).toBe('vetoed');
    expect(out.s2).toBe('vetoed');
    expect(out.published).toBe(0);
    expect(out.s3).toBe('vetoed');
  });

  // L2: the notice secret is encrypted like the credentials.
  test("the notice secret is stored encrypted with the user's key; a plaintext key is migrated", () => {
    const out = runRouteScript<any>(setup + `
      const { Database } = await import('bun:sqlite');
      // An earlier build's plaintext key, to be migrated.
      const legacySk = generateSecretKey();
      const legacyHex = Buffer.from(legacySk).toString('hex');
      db.default.exec('CREATE TABLE gateway_notice_key (id INTEGER PRIMARY KEY CHECK (id = 1), secret_hex TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      db.default.query('INSERT INTO gateway_notice_key (id, secret_hex) VALUES (1, ?)').run(legacyHex);

      const { unlockNoticeKey, noticePubkey, noticeKeyFromEnv } = await import(root + 'src/db/notices.ts');
      const created = await db.createUser('alice', 'correct horse battery staple');
      const k1 = unlockNoticeKey(created.userId, 'correct horse battery staple', false);
      const k2 = unlockNoticeKey(created.userId, 'correct horse battery staple', false);
      let wrong = '';
      try { unlockNoticeKey(created.userId, 'wrong password', false); } catch (e) { wrong = String(e); }

      // Scan every text value in the database for the secret.
      const dump = [];
      for (const { name } of db.default.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
        for (const row of db.default.query('SELECT * FROM "' + name + '"').all()) dump.push(JSON.stringify(row));
      }
      const legacyTable = db.default.query("SELECT name FROM sqlite_master WHERE name = 'gateway_notice_key'").get();
      const nsecKey = noticeKeyFromEnv(nip19.nsecEncode(noticeSk));
      let badEnv = '';
      try { noticeKeyFromEnv('nope'); } catch (e) { badEnv = String(e); }
      await finish({
        samePubkey: k1.pubkey === k2.pubkey, keptLegacyNpub: k1.pubkey === getPublicKey(legacySk),
        plaintextFound: dump.some(r => r.includes(legacyHex)), legacyTableGone: !legacyTable,
        wrong, shown: noticePubkey() === k1.pubkey, nsecOk: nsecKey.pubkey === noticeKey.pubkey, badEnv,
      });
    `);
    expect(out.samePubkey).toBe(true);
    expect(out.keptLegacyNpub).toBe(true);
    expect(out.plaintextFound).toBe(false);
    expect(out.legacyTableGone).toBe(true);
    expect(out.wrong).toContain('Decryption failed');
    expect(out.shown).toBe(true);
    expect(out.nsecOk).toBe(true);
    expect(out.badEnv).toContain('NOTICE_SECRET');
  });

  // L4: a setup error only disables veto notices.
  test('a notice-listener setup error is logged and disables the feature; the Gateway still starts', () => {
    const out = runRouteScript<any>(setup + `
      const lines = [];
      for (const k of ['log', 'warn', 'error', 'info']) { const orig = console[k].bind(console); console[k] = (...a) => { lines.push(a.map(String).join(' ')); orig(...a); }; }
      process.env.HEADLESS = 'true';
      process.env.AUTH_ENABLED = 'false';
      process.env.RATE_LIMIT_ENABLED = 'false';
      process.env.SKIP_SERVER_LISTEN = 'true';
      process.env.NOTICE_SECRET = 'not-a-key';
      process.env.NODE_ALERT_PUBKEYS = getPublicKey(nodeSk);
      let exitCode = null;
      const realExit = process.exit.bind(process);
      process.exit = (code) => { exitCode = code ?? 0; };
      const bootstrap = import(root + 'src/server.ts');
      let bootError = '';
      bootstrap.catch((error) => { bootError = String(error); });
      await sleep(1500);
      const { unlockVetoNotices, activeVetoNoticeListener } = await import(root + 'src/cinderella/veto-notices.ts');
      process.exit = realExit;
      await finish({ exitCode, bootError, disabled: lines.some(l => l.includes('Veto notices disabled') && l.includes('NOTICE_SECRET')), running: activeVetoNoticeListener() !== null });
    `);
    expect(out.exitCode).toBe(null);
    expect(out.bootError).toBe('');
    expect(out.disabled).toBe(true);
    expect(out.running).toBe(false);
  }, { timeout: 20000 });

  test('a wrong key when unlocking only disables veto notices', () => {
    const out = runRouteScript<any>(setup + `
      const { unlockVetoNotices } = await import(root + 'src/cinderella/veto-notices.ts');
      const created = await db.createUser('bob', 'right password');
      const logs = [];
      const log = (l, m) => logs.push(l + ': ' + m);
      const okFirst = unlockVetoNotices(created.userId, 'right password', false, log, { relays: ['ws://127.0.0.1:1'], allowed: [getPublicKey(nodeSk)] });
      const { stopVetoNoticeListener } = await import(root + 'src/cinderella/veto-notices.ts');
      stopVetoNoticeListener();
      let threw = false, ok;
      try { ok = unlockVetoNotices(created.userId, 'wrong password', false, log, { relays: ['ws://127.0.0.1:1'], allowed: [getPublicKey(nodeSk)] }); } catch { threw = true; }
      await finish({ okFirst, ok, threw, logged: logs.some(l => l.includes('Veto notices disabled')) });
    `);
    expect(out.okFirst).toBe(true);
    expect(out.threw).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.logged).toBe(true);
  });

  // L3: shutdown stops the listener and closes its relay connections.
  test('server shutdown stops the notice listener and closes its relay connections', () => {
    const out = runRouteScript<any>(setup + `
      const relay = new TestRelay(); relay.start();
      process.env.HEADLESS = 'true';
      process.env.AUTH_ENABLED = 'false';
      process.env.RATE_LIMIT_ENABLED = 'false';
      process.env.SKIP_SERVER_LISTEN = 'true';
      process.env.NOTICE_SECRET = Buffer.from(noticeSk).toString('hex');
      process.env.NOTICE_RELAYS = JSON.stringify([relay.url]);
      process.env.NODE_ALERT_PUBKEYS = getPublicKey(nodeSk);
      const realExit = process.exit.bind(process);
      let exited = null;
      process.exit = (code) => { exited = code ?? 0; };
      import(root + 'src/server.ts').catch(() => {});
      const connected = await until(() => relay.openCount === 1, 8000);
      process.emit('SIGTERM');
      await until(() => exited !== null, 5000);
      const closed = await until(() => relay.openCount === 0, 3000);
      const { activeVetoNoticeListener } = await import(root + 'src/cinderella/veto-notices.ts');
      const running = activeVetoNoticeListener() !== null;
      relay.stop();
      process.exit = realExit;
      console.log('@@RESULT@@' + JSON.stringify({ connected, exited, closed, running }));
      realExit(0);
    `, { ALLOW_LOCALHOST_RELAY: 'true' });
    expect(out.connected).toBe(true);
    expect(out.exited).not.toBe(null);
    expect(out.running).toBe(false);
    expect(out.closed).toBe(true);
  }, { timeout: 20000 });
});
