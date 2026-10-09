// Nothing is booked, charged or sent (plan §L Stage 3, §A3 item 10): after every end-to-end flow (the A3
// walk, cancel, a price change, expiry, and the production config), the store holds no quotes, bookings,
// booking refs, payment intents, partner leads or outbox messages, and nothing called the booking engine,
// the payment processor or the store's booking methods. Business writes only accounts and biz_ records.
const test = require('node:test');
const assert = require('node:assert/strict');
const flows = require('./business-e2e-flows');

/** Every record kind Business flows may write: accounts and sessions (D1 included), and biz_ records. */
const ALLOWED_KINDS = new Set(['user', 'user_email', 'session', 'platform_admin', 'platform_admin_seed']);
const allowedKind = kind => ALLOWED_KINDS.has(kind) || /^biz_[a-z_]+$/.test(kind);

/** Count every call to the booking engine, the payment processor and the store's booking methods. */
function spy(app) {
  const calls = [];
  const wrap = (obj, label, names) => {
    for (const name of names) {
      if (!obj || typeof obj[name] !== 'function') continue;
      const real = obj[name];
      obj[name] = function spied(...args) { calls.push(`${label}.${name}`); return real.apply(this, args); };
    }
  };
  wrap(app.engine, 'engine', ['search', 'getOffer', 'createQuote', 'getQuote', 'createBooking', 'authorize', 'getBooking', 'payBooking', 'cancelBooking']);
  wrap(app.payments, 'payments', ['createIntent', 'confirm', 'refund']);
  wrap(app.store, 'store', ['saveQuote', 'getQuote', 'createBooking', 'updateBooking', 'getBooking', 'getBookingByRef', 'savePaymentIntent', 'getPaymentIntent', 'savePartnerLead', 'listBookings']);
  // Which kinds the store is asked to write, by any path.
  const written = new Set();
  for (const name of ['putRecord', 'insertRecord']) {
    const real = app.store[name];
    app.store[name] = function kinds(kind, ...rest) { written.add(kind); return real.call(this, kind, ...rest); };
  }
  const realUpdate = app.store.updateRecord;
  app.store.updateRecord = function kinds(kind, ...rest) { written.add(kind); return realUpdate.call(this, kind, ...rest); };
  const realCommit = app.store.commit;
  app.store.commit = function kinds(spec) {
    for (const part of ['inserts', 'cas', 'deletes', 'checks']) for (const op of (spec && spec[part]) || []) if (op && op.kind) written.add(op.kind);
    return realCommit.call(this, spec);
  };
  return { calls, written };
}

/** What the MemoryStore holds that would be a booking, a charge, a lead or a message. */
async function assertNothingBooked(app, label) {
  const s = app.store;
  assert.equal(s.kind, 'memory');
  assert.equal(s.quotes.size, 0, `${label}: no quotes`);
  assert.equal(s.bookings.size, 0, `${label}: no bookings`);
  assert.equal(s.refs.size, 0, `${label}: no booking refs`);
  assert.equal(s.intents.size, 0, `${label}: no payment intents`);
  assert.equal(s.leads.length, 0, `${label}: no partner leads`);
  assert.deepEqual(await s.listRecords('outbox'), [], `${label}: the outbox is empty`);
  const kinds = [...new Set([...s.records.values()].map(r => r.kind))].sort();
  assert.deepEqual(kinds.filter(k => !allowedKind(k)), [], `${label}: only accounts and biz_ records are stored (${kinds.join(', ')})`);
  for (const k of ['quote', 'booking', 'payment_intent', 'intent', 'outbox', 'trip', 'saved', 'hunt', 'travel_defaults']) {
    assert.equal([...s.records.keys()].filter(key => key.startsWith(`${k}:`)).length, 0, `${label}: no ${k} records`);
  }
}

test('after the e2e flows (A3 walk, cancel, a price change, expiry), no quotes, bookings, payment intents or outbox messages exist', { timeout: 180000 }, async t => {
  // One traveler runs every flow here within a minute or two: more searches than one person makes, so this
  // world allows more compute requests per minute (the limiter itself is tested in business-traveler).
  const w = await flows.devWorld({ env: { BUSINESS_COMPUTE_LIMIT: '200' } });
  t.after(w.close);
  const seen = spy(w.app);
  await flows.a3Walk(w);
  await flows.signIn(w, 'employee');
  await flows.cancelFlow(w);
  await flows.priceChangeFlow(w);
  await flows.expiryFlow(w);
  // The flows ran: trips in every state the walk and the scenarios reach, on demo prices.
  const statuses = new Set();
  for (const rid of Object.values(w.rids)) statuses.add((await w.app.store.getRecord('biz_request', rid)).status);
  assert.deepEqual([...statuses].sort(), ['approved', 'cancelled', 'denied', 'draft', 'expired', 'pending']);
  for (const rid of Object.values(w.rids)) {
    const r = await w.app.store.getRecord('biz_request', rid);
    assert.equal(r.demo, true, `${rid} is a demo request`);
    assert.deepEqual(r.booking, { status: 'not_open' }, `${rid}: booking is not open`);
  }

  await assertNothingBooked(w.app, 'development');
  assert.deepEqual(seen.calls, [], 'nothing called the booking engine, payments or the store booking methods');
  assert.deepEqual([...seen.written].filter(k => !allowedKind(k)), [], `only accounts and biz_ kinds were written (${[...seen.written].join(', ')})`);
});

test('the production config (no supplier) flow books, charges and sends nothing either', { timeout: 60000 }, async t => {
  const p = await flows.prodWorld();
  t.after(p.close);
  const seen = spy(p.app);
  await flows.productionFlow(p);
  await assertNothingBooked(p.app, 'production');
  assert.deepEqual(seen.calls, []);
  assert.deepEqual([...seen.written].filter(k => !allowedKind(k)), []);
});
