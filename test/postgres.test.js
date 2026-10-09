// Runs the store contract against a real Postgres when TEST_DATABASE_URL is set (skipped otherwise).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStore } = require('../server/booking');

const url = process.env.TEST_DATABASE_URL;

test('PostgresStore round-trips quotes, bookings, intents and leads', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const store = new PostgresStore({ connectionString: url, ssl: false });
  await store.init();
  await store.init(); // idempotent
  try {
    const sfx = Date.now().toString(36);
    const quote = { id: `qt_${sfx}`, vertical: 'hotels', demo: true, expiresAt: new Date(Date.now() + 60000).toISOString(), total: 100 };
    await store.saveQuote(quote);
    assert.deepEqual(await store.getQuote(quote.id), quote);

    const b = { id: `bk_${sfx}`, ref: `DEMO-${sfx.toUpperCase()}`, vertical: 'hotels', status: 'pending_payment', demo: true, traveler: { email: 'a@b.co' }, total: 100, currency: 'USD', history: [] };
    await store.createBooking(b);
    assert.equal((await store.getBookingByRef(b.ref)).id, b.id);
    assert.equal(await store.updateBooking(b.id, 'confirmed', { status: 'cancelled' }), null, 'compare-and-set refuses a stale status');
    const u = await store.updateBooking(b.id, 'pending_payment', { status: 'confirming' });
    assert.equal(u.status, 'confirming');
    // Two racing claims: exactly one wins.
    const [x, y] = await Promise.all([
      store.updateBooking(b.id, 'confirming', { status: 'confirmed' }),
      store.updateBooking(b.id, 'confirming', { status: 'failed' }),
    ]);
    assert.equal([x, y].filter(Boolean).length, 1);

    const intent = { id: `pi_${sfx}`, bookingId: b.id, mode: 'test', status: 'requires_payment', amount: 100 };
    await store.savePaymentIntent(intent);
    await store.savePaymentIntent({ ...intent, status: 'succeeded' });
    assert.equal((await store.getPaymentIntent(intent.id)).status, 'succeeded');
    await store.savePartnerLead({ id: `lead_${sfx}`, name: 'n' });
  } finally {
    await store.close();
  }
});

test('PostgresStore keeps generic records and lists a user’s bookings', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const store = new PostgresStore({ connectionString: url, ssl: false });
  await store.init();
  try {
    const sfx = Date.now().toString(36);
    await store.putRecord('saved', `sv_${sfx}`, { token: 'abc', budget: 1000 }, { userId: `usr_${sfx}` });
    await store.putRecord('saved', `sv_${sfx}`, { token: 'abc', budget: 2000 }, { userId: `usr_${sfx}` }); // upsert
    assert.equal((await store.getRecord('saved', `sv_${sfx}`)).budget, 2000);
    assert.equal((await store.listRecords('saved', { userId: `usr_${sfx}` })).length, 1);
    assert.equal((await store.listRecords('saved', { userId: 'usr_nobody' })).length, 0);
    await store.deleteRecord('saved', `sv_${sfx}`);
    assert.equal(await store.getRecord('saved', `sv_${sfx}`), null);

    const b = { id: `bk2_${sfx}`, ref: `DEMO-BT-${sfx.toUpperCase()}`, vertical: 'trips', status: 'confirmed', demo: true, userId: `usr_${sfx}`, traveler: { email: 'a@b.co' }, total: 100, currency: 'USD', history: [] };
    await store.createBooking(b);
    assert.equal((await store.listBookings({ userId: `usr_${sfx}` })).length, 1);
    assert.equal((await store.listBookings({ userId: 'usr_nobody' })).length, 0);
  } finally {
    await store.close();
  }
});

test('PostgresStore keeps the Business store contract: insert-only, compare-and-set, leads newest first', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const store = new PostgresStore({ connectionString: url, ssl: false });
  await store.init();
  try {
    const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const owner = `org_${sfx}`;
    assert.equal(await store.insertRecord('biz_test', `a_${sfx}`, { n: 1 }, { userId: owner }), true);
    assert.equal(await store.insertRecord('biz_test', `a_${sfx}`, { n: 2 }, { userId: `org_other_${sfx}` }), false);
    assert.deepEqual(await store.getRecord('biz_test', `a_${sfx}`), { n: 1 });
    assert.equal((await store.listRecords('biz_test', { userId: owner })).length, 1);

    assert.equal(await store.updateRecord('biz_test', `a_${sfx}`, 1, { n: 9 }), null, 'wrong rev (missing rev counts as 0)');
    assert.equal(await store.updateRecord('biz_test', `missing_${sfx}`, 0, { n: 9 }), null);
    assert.deepEqual(await store.updateRecord('biz_test', `a_${sfx}`, 0, { n: 2, rev: 77 }), { n: 2, rev: 1 });
    assert.equal(await store.updateRecord('biz_test', `a_${sfx}`, 0, { n: 3 }), null, 'a stale rev loses');
    assert.equal((await store.listRecords('biz_test', { userId: owner })).length, 1, 'the owner is kept');

    const results = await Promise.all(['x', 'y', 'z'].map(v => store.updateRecord('biz_test', `a_${sfx}`, 1, { v })));
    assert.equal(results.filter(Boolean).length, 1, 'racing compare-and-sets: exactly one wins');
    assert.equal((await store.getRecord('biz_test', `a_${sfx}`)).rev, 2);
    const inserts = await Promise.all([1, 2, 3].map(n => store.insertRecord('biz_test', `new_${sfx}`, { n })));
    assert.equal(inserts.filter(Boolean).length, 1, 'racing inserts: exactly one wins');

    for (const n of [1, 2]) {
      await store.savePartnerLead({ id: `lead_${sfx}_${n}`, name: `n${n}` });
      await new Promise(r => setTimeout(r, 5));
    }
    const leads = await store.listPartnerLeads({ limit: 2 });
    assert.deepEqual(leads.map(l => l.id), [`lead_${sfx}_2`, `lead_${sfx}_1`]);
    await store.deleteRecord('biz_test', `a_${sfx}`);
    await store.deleteRecord('biz_test', `new_${sfx}`);
  } finally {
    await store.close();
  }
});
