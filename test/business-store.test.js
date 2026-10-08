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
