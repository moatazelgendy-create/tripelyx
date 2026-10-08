// The store methods Tripelyx Business relies on: insert-only writes, compare-and-set on `rev`, and
// listing partner leads. test/postgres.test.js runs the same contract against Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../server/booking/MemoryStore');

test('insertRecord writes once and never overwrites', async () => {
  const store = new MemoryStore();
  assert.equal(await store.insertRecord('biz_test', 'a', { n: 1, rev: 0 }, { userId: 'org_aaaaaaaaaaaaaaaa' }), true);
  assert.equal(await store.insertRecord('biz_test', 'a', { n: 2, rev: 0 }, { userId: 'org_bbbbbbbbbbbbbbbb' }), false);
  assert.deepEqual(await store.getRecord('biz_test', 'a'), { n: 1, rev: 0 });
  assert.equal((await store.listRecords('biz_test', { userId: 'org_aaaaaaaaaaaaaaaa' })).length, 1);
  assert.equal((await store.listRecords('biz_test', { userId: 'org_bbbbbbbbbbbbbbbb' })).length, 0, 'the owner is not taken over');
  // The same id under another kind is a different record.
  assert.equal(await store.insertRecord('biz_other', 'a', { n: 3 }), true);
  // The stored copy is detached from the caller's object.
  const doc = { list: [1] };
  await store.insertRecord('biz_test', 'b', doc);
  doc.list.push(2);
  assert.deepEqual((await store.getRecord('biz_test', 'b')).list, [1]);
});

test('updateRecord is a compare-and-set on rev', async () => {
  const store = new MemoryStore();
  await store.insertRecord('biz_test', 'a', { n: 1 }, { userId: 'org_aaaaaaaaaaaaaaaa' }); // no rev: counts as 0
  assert.equal(await store.updateRecord('biz_test', 'a', 1, { n: 9 }), null, 'wrong rev');
  assert.equal(await store.updateRecord('biz_test', 'missing', 0, { n: 9 }), null, 'missing record');
  assert.equal(await store.updateRecord('biz_test', 'a', '0', { n: 9 }), null, 'a string rev is refused');
  assert.deepEqual(await store.getRecord('biz_test', 'a'), { n: 1 });
  const w = await store.updateRecord('biz_test', 'a', 0, { n: 2, rev: 77 });
  assert.deepEqual(w, { n: 2, rev: 1 }, 'rev is set by the store, whatever the caller passed');
  assert.deepEqual(await store.getRecord('biz_test', 'a'), { n: 2, rev: 1 });
  assert.equal(await store.updateRecord('biz_test', 'a', 0, { n: 3 }), null, 'a stale rev loses');
  assert.deepEqual(await store.updateRecord('biz_test', 'a', 1, { n: 3 }), { n: 3, rev: 2 });
  assert.equal((await store.listRecords('biz_test', { userId: 'org_aaaaaaaaaaaaaaaa' })).length, 1, 'the owner is kept');
});

test('racing compare-and-sets: exactly one wins', async () => {
  const store = new MemoryStore();
  await store.insertRecord('biz_test', 'r', { v: 'start', rev: 0 });
  const results = await Promise.all(['x', 'y', 'z'].map(v => store.updateRecord('biz_test', 'r', 0, { v })));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results.find(Boolean);
  assert.deepEqual(await store.getRecord('biz_test', 'r'), winner);
  assert.equal(winner.rev, 1);
  const inserts = await Promise.all([1, 2, 3].map(n => store.insertRecord('biz_test', 'new', { n })));
  assert.deepEqual(inserts.filter(Boolean).length, 1);
});

test('listPartnerLeads lists newest first and keeps store.leads', async () => {
  const store = new MemoryStore();
  for (const n of [1, 2, 3]) await store.savePartnerLead({ id: `lead_${n}`, name: `n${n}`, type: 'Travel agency' });
  const leads = await store.listPartnerLeads();
  assert.deepEqual(leads.map(l => l.id), ['lead_3', 'lead_2', 'lead_1']);
  assert.deepEqual((await store.listPartnerLeads({ limit: 2 })).map(l => l.id), ['lead_3', 'lead_2']);
  assert.deepEqual(store.leads.map(l => l.id), ['lead_1', 'lead_2', 'lead_3'], 'store.leads is unchanged (http.test.js reads it)');
  leads[0].name = 'changed';
  assert.equal(store.leads[2].name, 'n3', 'callers get copies');
});

// ---------------------------------------------------------------------------------------------------
// commit() and listRecordsPage() (plan §C1): the same contract on both stores. The Postgres runs need
// TEST_DATABASE_URL (a throwaway database); they use fresh kinds so reruns never collide.
const { PostgresStore } = require('../server/booking/PostgresStore');
const { AppError } = require('../server/lib/errors');
const { Repo } = require('../server/business/repo');
const { loadActor } = require('../server/business/actor');
const { id } = require('../server/lib/ids');

const pgUrl = process.env.TEST_DATABASE_URL;
const STORES = [
  { name: 'MemoryStore', skip: false, make: async () => new MemoryStore() },
  {
    name: 'PostgresStore',
    skip: !pgUrl && 'TEST_DATABASE_URL not set',
    make: async () => { const s = new PostgresStore({ connectionString: pgUrl, ssl: false }); await s.init(); return s; },
  },
];
const letters = () => Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const sfx = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const OWNER_A = 'org_AAAAAAAAAAAAAAAA', OWNER_B = 'org_BBBBBBBBBBBBBBBB';

/** Everything a test wrote, read back by id (null when missing). */
const readAll = (store, kind, ids) => Promise.all(ids.map(i => store.getRecord(kind, i)));

for (const S of STORES) {
  const open = async t => { const store = await S.make(); t.after(() => store.close()); return store; };

  test(`${S.name} commit: inserts, compare-and-set updates, checks and deletes land together`, { skip: S.skip }, async t => {
    const store = await open(t);
    const k = `t_${sfx()}`;
    assert.equal(await store.insertRecord(k, 'upd', { n: 1, rev: 0 }, { userId: OWNER_A }), true);
    assert.equal(await store.insertRecord(k, 'chk', { n: 1, rev: 3 }, { userId: OWNER_A }), true);
    assert.equal(await store.insertRecord(k, 'del', { n: 1, rev: 2 }, { userId: OWNER_A }), true);
    assert.equal(await store.insertRecord(k, 'norev', { n: 1 }, { userId: OWNER_A }), true);
    const res = await store.commit({
      checks: [{ kind: k, id: 'chk', rev: 3 }],
      updates: [{ kind: k, id: 'upd', expectedRev: 0, next: { n: 2, rev: 99 } }, { kind: k, id: 'norev', expectedRev: 0, next: { n: 5 } }],
      inserts: [{ kind: k, id: 'new', data: { n: 7, list: [1, { a: null }], rev: 0 }, userId: OWNER_A }],
      deletes: [{ kind: k, id: 'del', expectedRev: 2 }],
    });
    assert.deepEqual(res, { ok: true, docs: { [`${k}:upd`]: { n: 2, rev: 1 }, [`${k}:norev`]: { n: 5, rev: 1 }, [`${k}:new`]: { n: 7, list: [1, { a: null }], rev: 0 } } });
    assert.deepEqual(await readAll(store, k, ['upd', 'chk', 'del', 'new', 'norev']),
      [{ n: 2, rev: 1 }, { n: 1, rev: 3 }, null, { n: 7, list: [1, { a: null }], rev: 0 }, { n: 5, rev: 1 }]);
    const owned = (await store.listRecords(k, { userId: OWNER_A })).map(d => d.n).sort();
    assert.deepEqual(owned, [1, 2, 5, 7], 'the inserted record has its owner; updates keep theirs');
    assert.deepEqual(await store.commit({}), { ok: true, docs: {} }, 'an empty commit is fine');
  });

  test(`${S.name} commit: a stale update, a taken id, a failed check or a stale delete writes nothing at all`, { skip: S.skip }, async t => {
    const store = await open(t);
    const k = `t_${sfx()}`;
    await store.insertRecord(k, 'a', { v: 'a0', rev: 0 }, { userId: OWNER_A });
    await store.insertRecord(k, 'b', { v: 'b0', rev: 4 }, { userId: OWNER_A });
    await store.insertRecord(k, 'taken', { v: 'mine', rev: 0 }, { userId: OWNER_B });
    const before = await readAll(store, k, ['a', 'b', 'taken', 'fresh']);
    const good = {
      updates: [{ kind: k, id: 'a', expectedRev: 0, next: { v: 'a1' } }],
      inserts: [{ kind: k, id: 'fresh', data: { v: 'f' }, userId: OWNER_A }],
    };
    const cases = [
      ['a stale update', { ...good, updates: [...good.updates, { kind: k, id: 'b', expectedRev: 3, next: { v: 'b1' } }] }, { reason: 'conflict', id: 'b' }],
      ['an update of a missing record', { ...good, updates: [...good.updates, { kind: k, id: 'nope', expectedRev: 0, next: { v: 'x' } }] }, { reason: 'conflict', id: 'nope' }],
      ['a non-integer rev', { ...good, updates: [...good.updates, { kind: k, id: 'b', expectedRev: '4', next: { v: 'b1' } }] }, { reason: 'conflict', id: 'b' }],
      ['a taken id', { ...good, inserts: [...good.inserts, { kind: k, id: 'taken', data: { v: 'theirs' }, userId: OWNER_A }] }, { reason: 'duplicate', id: 'taken' }],
      ['a failed check', { ...good, checks: [{ kind: k, id: 'b', rev: 5 }] }, { reason: 'conflict', id: 'b' }],
      ['a check on a missing record', { ...good, checks: [{ kind: k, id: 'gone', rev: 0 }] }, { reason: 'conflict', id: 'gone' }],
      ['a stale delete', { ...good, deletes: [{ kind: k, id: 'b', expectedRev: 0 }] }, { reason: 'conflict', id: 'b' }],
      ['a delete of a missing record', { ...good, deletes: [{ kind: k, id: 'gone', expectedRev: 0 }] }, { reason: 'conflict', id: 'gone' }],
    ];
    for (const [name, spec, want] of cases) {
      assert.deepEqual(await store.commit(spec), { ok: false, kind: k, ...want }, name);
      assert.deepEqual(await readAll(store, k, ['a', 'b', 'taken', 'fresh']), before, `${name}: nothing was written`);
    }
    // The first failure in (kind, id) order is the one reported, whatever order the lists come in.
    const two = await store.commit({ inserts: [{ kind: k, id: 'taken', data: { v: 1 } }], updates: [{ kind: k, id: 'b', expectedRev: 0, next: {} }] });
    assert.deepEqual(two, { ok: false, reason: 'conflict', kind: k, id: 'b' });
    // And with nothing wrong, the good half lands.
    assert.equal((await store.commit(good)).ok, true);
    assert.deepEqual(await readAll(store, k, ['a', 'fresh']), [{ v: 'a1', rev: 1 }, { v: 'f' }]);
  });

  test(`${S.name} commit: malformed calls throw before anything is written`, { skip: S.skip }, async t => {
    const store = await open(t);
    const k = `t_${sfx()}`;
    await assert.rejects(store.commit({ cas: [] }), /checks, updates, inserts and deletes/);
    await assert.rejects(store.commit({ inserts: {} }), /must be an array/);
    await assert.rejects(store.commit({ inserts: [{ kind: k, id: 'x', data: [1] }] }), /plain object/);
    await assert.rejects(store.commit({ updates: [{ kind: k, id: 'x', expectedRev: 0, next: null }] }), /plain object/);
    await assert.rejects(store.commit({ inserts: [{ kind: k, id: '', data: {} }] }), /kind and an id/);
    await assert.rejects(store.commit({ inserts: [{ kind: k, id: 'x', data: {} }], deletes: [{ kind: k, id: 'x', expectedRev: 0 }] }), /more than once/);
    assert.equal(await store.getRecord(k, 'x'), null);
  });

  test(`${S.name} commit: ten racing writers on one record, exactly one wins and only its other writes land`, { skip: S.skip }, async t => {
    const store = await open(t);
    const k = `t_${sfx()}`;
    await store.insertRecord(k, 'budget', { committed: 0, rev: 0 }, { userId: OWNER_A });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.commit({
      updates: [{ kind: k, id: 'budget', expectedRev: 0, next: { committed: (i + 1) * 100 } }],
      inserts: [{ kind: k, id: `audit_${i}`, data: { i }, userId: OWNER_A }],
    })));
    const winners = results.map((r, i) => (r.ok ? i : -1)).filter(i => i >= 0);
    assert.equal(winners.length, 1, 'exactly one winner');
    assert.ok(results.filter(r => !r.ok).every(r => r.reason === 'conflict' && r.id === 'budget'));
    const w = winners[0];
    assert.deepEqual(await store.getRecord(k, 'budget'), { committed: (w + 1) * 100, rev: 1 });
    const audits = await readAll(store, k, Array.from({ length: 10 }, (_, i) => `audit_${i}`));
    assert.deepEqual(audits.map((d, i) => (d ? i : -1)).filter(i => i >= 0), [w], 'the losers wrote nothing');

    // Ten racing inserts of one id: one wins, and only the winner's companion row exists.
    const ins = await Promise.all(Array.from({ length: 10 }, (_, i) => store.commit({
      inserts: [{ kind: k, id: 'pointer', data: { i } }, { kind: k, id: `side_${i}`, data: { i } }],
    })));
    assert.equal(ins.filter(r => r.ok).length, 1);
    assert.ok(ins.filter(r => !r.ok).every(r => r.reason === 'duplicate' && r.id === 'pointer'));
    const pi = (await store.getRecord(k, 'pointer')).i;
    const sides = await readAll(store, k, Array.from({ length: 10 }, (_, i) => `side_${i}`));
    assert.deepEqual(sides.map((d, i) => (d ? i : -1)).filter(i => i >= 0), [pi]);
  });

  test(`${S.name} under the Repo: ten racing withRetry writers on one budget all land, one at a time, with their entries`, { skip: S.skip }, async t => {
    const store = await open(t);
    const repo = new Repo({ store, now: () => new Date('2026-10-10T09:00:00.000Z') });
    const k = `biz_t_${letters()}`, log = `biz_t_${letters()}`;
    const org = id('org');
    await repo.insert(k, 'budget', { orgId: org, commits: {}, rev: 0 }, { owner: org });
    let attempts = 0;
    const hold = i => repo.withRetry(async () => {
      attempts += 1;
      return repo.commit({
        cas: [{ kind: k, id: 'budget', rev: null, fn: d => { d.commits[`btr_${i}`] = (i + 1) * 100; } }],
        inserts: [{ kind: log, id: `aud_${i}`, data: { orgId: org, i }, owner: org }],
      });
    }, { tries: 10 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => hold(i)));
    const budget = await repo.get(k, 'budget');
    assert.equal(budget.rev, 10, 'ten writes, one after another');
    assert.equal(Object.keys(budget.commits).length, 10, 'no write was lost');
    assert.ok(attempts >= 10);
    const entries = (await repo.page(log, org, { limit: 50 })).rows.map(r => r.i).sort((a, b) => a - b);
    assert.deepEqual(entries, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'each write has exactly one entry');
    // A stale explicit rev is not retried, and leaves nothing behind.
    const e = await repo.withRetry(() => repo.commit({
      cas: [{ kind: k, id: 'budget', rev: 3, fn: d => { d.late = true; } }],
      inserts: [{ kind: log, id: 'aud_late', data: { orgId: org }, owner: org }],
    })).catch(x => x);
    assert.ok(e instanceof AppError && e.code === 'conflict' && e.retryable === false);
    assert.equal(await repo.get(log, 'aud_late'), null);
  });

  test(`${S.name} listRecordsPage: one owner, newest first, every row exactly once across 2,500 rows`, { skip: S.skip, timeout: 120000 }, async t => {
    const store = await open(t);
    const k = `t_${sfx()}`;
    const ids = Array.from({ length: 2500 }, (_, i) => `r${String(i).padStart(4, '0')}`);
    // Five commits of 500 (inside one commit the store writes in id order), plus other owners and kinds.
    for (let b = 0; b < 5; b += 1) {
      const batch = ids.slice(b * 500, b * 500 + 500);
      const res = await store.commit({ inserts: batch.map(i => ({ kind: k, id: i, data: { i }, userId: OWNER_A })) });
      assert.equal(res.ok, true);
      await store.insertRecord(k, `other_${b}`, { other: true }, { userId: OWNER_B });
      await store.insertRecord(`${k}_x`, `x_${b}`, { other: true }, { userId: OWNER_A });
    }
    const want = [...ids].reverse();
    for (const limit of [200, 50, 7]) {
      const got = [];
      let cursor = null, pages = 0;
      do {
        const page = await store.listRecordsPage(k, { userId: OWNER_A, limit, cursor });
        assert.ok(page.rows.length <= limit);
        if (page.cursor !== null) {
          assert.equal(page.rows.length, limit, 'only the last page is short');
          assert.match(page.cursor, /^[A-Za-z0-9_-]+$/, 'the cursor is opaque base64url');
        }
        got.push(...page.rows.map(r => r.i));
        cursor = page.cursor;
        pages += 1;
      } while (cursor && pages < 1000);
      assert.equal(got.length, 2500, `limit ${limit}`);
      assert.deepEqual(got, want, `limit ${limit}: newest first, each row once`);
      assert.equal(pages, Math.ceil(2500 / limit), 'no empty last page');
    }
    const other = await store.listRecordsPage(k, { userId: OWNER_B, limit: 200 });
    assert.deepEqual(other.rows.map(r => r.other), [true, true, true, true, true]);
    assert.equal(other.cursor, null);
    assert.deepEqual(await store.listRecordsPage(k, { userId: 'org_CCCCCCCCCCCCCCCC' }), { rows: [], cursor: null });

    // A row deleted between pages is skipped, never repeated.
    const first = await store.listRecordsPage(k, { userId: OWNER_A, limit: 3 });
    assert.deepEqual(first.rows.map(r => r.i), ['r2499', 'r2498', 'r2497']);
    await store.deleteRecord(k, 'r2496');
    const second = await store.listRecordsPage(k, { userId: OWNER_A, limit: 3, cursor: first.cursor });
    assert.deepEqual(second.rows.map(r => r.i), ['r2495', 'r2494', 'r2493']);
  });

  test(`${S.name} listRecordsPage: refuses a falsy owner, a bad limit and a forged cursor`, { skip: S.skip }, async t => {
    const store = await open(t);
    const k = `t_${sfx()}`;
    await store.insertRecord(k, 'a', { n: 1 }, { userId: OWNER_A });
    for (const userId of ['', null, undefined, 0, false]) {
      await assert.rejects(store.listRecordsPage(k, { userId }), /needs an owner/, String(userId));
    }
    await assert.rejects(store.listRecordsPage(k), /needs an owner/);
    for (const limit of [0, 201, 1.5, '50', -1]) await assert.rejects(store.listRecordsPage(k, { userId: OWNER_A, limit }), RangeError, String(limit));
    const garbage = ['!!', 'x'.repeat(600), Buffer.from('not json').toString('base64url'), Buffer.from('"text"').toString('base64url'),
      Buffer.from('[1,2,3]').toString('base64url'), Buffer.from('-4').toString('base64url'), Buffer.from('["yesterday","a"]').toString('base64url'), 42];
    for (const cursor of garbage) {
      const e = await store.listRecordsPage(k, { userId: OWNER_A, cursor }).catch(x => x);
      assert.ok(e instanceof AppError && e.code === 'bad_cursor' && e.status === 400, `cursor ${String(cursor).slice(0, 20)}: ${e && e.message}`);
    }
    // Cursors shaped like a real Postgres one that Postgres still cannot read: an offset out of range, or an
    // id holding a NUL (text columns cannot). Both stores answer bad_cursor, never a raw database error.
    const enc = v => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    const forged = ['2026-10-09 09:00:00+99', '2026-10-09 09:00:00+16', '2026-10-09 09:00:00-16', '2026-10-09 09:00:00+15:60']
      .map(ts => [ts, 'a']).concat([['2026-10-09 09:00:00+00', 'r\u0000'], ['2026-10-09 09:00:00.5+00', 'a\ud800']]);
    for (const at of forged) {
      const e = await store.listRecordsPage(k, { userId: OWNER_A, cursor: enc(at) }).catch(x => x);
      assert.ok(e instanceof AppError && e.code === 'bad_cursor' && e.status === 400, `cursor ${JSON.stringify(at)}: ${e && e.code} ${e && e.message}`);
    }
  });

  test(`${S.name} commit: a nested value that is not plain JSON, or a string Postgres cannot hold, is refused before anything is written`, { skip: S.skip }, async t => {
    const store = await open(t);
    const k = `t_${sfx()}`;
    await store.insertRecord(k, 'a', { v: 0, rev: 0 }, { userId: OWNER_A });
    const bad = [
      ['a function', { bad: { f: () => 1 } }], ['undefined', { bad: { u: undefined } }], ['undefined in a list', { bad: [1, undefined] }],
      ['NaN', { n: NaN }], ['Infinity', { n: [Infinity] }], ['a Date', { d: new Date(0) }], ['a Map', { m: new Map() }],
      ['a BigInt', { b: 1n }], ['a symbol', { s: Symbol('x') }], ['a NUL in a value', { s: 'x\u0000y' }],
      ['a NUL in a key', { ['k\u0000']: 1 }], ['an unpaired surrogate', { s: 'x\ud800' }],
    ];
    for (const [name, data] of bad) {
      for (const spec of [
        { updates: [{ kind: k, id: 'a', expectedRev: 0, next: { v: 1 } }], inserts: [{ kind: k, id: 'b', data, userId: OWNER_A }] },
        { inserts: [{ kind: k, id: 'b', data: { ok: true }, userId: OWNER_A }], updates: [{ kind: k, id: 'a', expectedRev: 0, next: data }] },
      ]) {
        await assert.rejects(store.commit(spec), TypeError, name);
        assert.deepEqual(await readAll(store, k, ['a', 'b']), [{ v: 0, rev: 0 }, null], `${name}: nothing was written`);
      }
    }
    await assert.rejects(store.commit({ inserts: [{ kind: k, id: 'nul\u0000', data: {} }] }), /kind and an id/, 'an id with a NUL');
    assert.equal((await store.commit({ inserts: [{ kind: k, id: 'b', data: { s: 'é ✓ 😀', n: -0.5, z: null, l: [[], {}] }, userId: OWNER_A }] })).ok, true);
    assert.deepEqual(await store.getRecord(k, 'b'), { s: 'é ✓ 😀', n: -0.5, z: null, l: [[], {}] });
  });

  test(`${S.name} under the Repo: forged cursors, ids with control characters and non-Business kinds never reach the database`, { skip: S.skip }, async t => {
    const store = await open(t);
    const repo = new Repo({ store, now: () => new Date('2026-10-10T09:00:00.000Z') });
    const k = `biz_t_${letters()}`;
    const org = id('org');
    for (let i = 0; i < 3; i += 1) await repo.insert(k, `r${i}`, { orgId: org, i, rev: 0 }, { owner: org });
    const p1 = await repo.page(k, org, { limit: 1 });
    const tag = p1.cursor.slice(0, p1.cursor.indexOf('.'));
    const enc = v => `${tag}.${Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')}`;
    for (const inner of [['2026-10-09 09:00:00+99', 'r1'], ['2026-10-09 09:00:00-16', 'r1'], ['2026-10-09 09:00:00+00', 'r\u0000'], 2, -1]) {
      const e = await repo.page(k, org, { limit: 1, cursor: enc(inner) }).catch(x => x);
      if (store.kind === 'memory' && inner === 2) { assert.ok(Array.isArray(e.rows), 'a real memory cursor'); continue; }
      assert.ok(e instanceof AppError && e.status === 404, `${JSON.stringify(inner)}: ${e && e.message}`);
    }
    for (const bad of ['r\u0000', '\u0000', 'r1\n', 'r\u001f', 'r\u007f']) {
      assert.equal(await repo.get(k, bad), null, JSON.stringify(bad));
      assert.equal(await repo.getIn(k, bad, org), null, JSON.stringify(bad));
      assert.equal(await repo.getIn(k, 'r1', `${org}\u0000`), null, JSON.stringify(bad));
      assert.equal(await repo.del(k, bad), false, JSON.stringify(bad));
      await assert.rejects(repo.commit({ checks: [{ kind: k, id: bad, rev: 0 }] }), e => e instanceof AppError && e.status === 404);
      await assert.rejects(repo.insert(k, bad, { orgId: org }, { owner: org }), /bad record id/);
    }
    const e = await loadActor(repo, { org: { id: 'org_\u0000' }, user: { id: 'usr_x' } }).catch(x => x);
    assert.ok(e instanceof AppError && e.status === 404, `loadActor: ${e && e.message}`);
    // Reads and deletes refuse anything but a biz_* kind, as writes do: Business never sees sessions or users.
    await store.insertRecord('session', 'sess_probe', { userId: 'usr_AAAAAAAAAAAAAAAA' }, { userId: 'usr_AAAAAAAAAAAAAAAA' });
    for (const [name, call] of [
      ['get', () => repo.get('user', 'usr_AAAAAAAAAAAAAAAA')], ['getIn', () => repo.getIn('user_email', 'a@b.com', org)],
      ['list', () => repo.list('session', 'usr_AAAAAAAAAAAAAAAA')], ['page', () => repo.page('session', 'usr_AAAAAAAAAAAAAAAA')],
      ['del', () => repo.del('session', 'sess_probe')], ['commit check', () => repo.commit({ checks: [{ kind: 'session', id: 'sess_probe', rev: 0 }] })],
    ]) await assert.rejects(call(), /bad record kind/, name);
    assert.ok(await store.getRecord('session', 'sess_probe'), 'the session is still there');
  });
}
