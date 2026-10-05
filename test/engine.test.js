const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createRegistry } = require('../server/providers/registry');
const { MemoryStore } = require('../server/booking');
const { BookingEngine } = require('../server/booking/engine');
const { TestPaymentProcessor } = require('../server/payments/TestPaymentProcessor');
const { FACTORIES } = require('../server/providers/mock');
const { sampleQueries, quietLog } = require('./helpers');
const { addDays, today } = require('../server/lib/dates');

const TRAVELER = { firstName: 'Mona', lastName: 'Test', email: 'Mona@Example.com' };
const VISA = { type: 'test_card', number: '4242424242424242', expMonth: '12', expYear: '35', cvc: '123', name: 'Mona Test' };
const DECLINE = { ...VISA, number: '4000000000000002' };

function setup({ now, overrides } = {}) {
  const config = loadConfig({});
  const store = new MemoryStore();
  let clock = now || new Date();
  const nowFn = () => clock;
  const engine = new BookingEngine({
    registry: createRegistry(config, { overrides }), store, config, log: quietLog, now: nowFn,
    payments: new TestPaymentProcessor({ store, now: nowFn }),
  });
  return { engine, store, config, advance: ms => { clock = new Date(clock.getTime() + ms); } };
}

async function quoteFor(engine, vertical, query) {
  const { offers } = await engine.search(vertical, query);
  const offer = offers.find(o => o.options.some(x => x.available) && o.cancellation.type !== 'non_refundable') || offers[0];
  const option = offer.options.find(x => x.available);
  const selection = offer.details.slots ? { slot: offer.details.slots.find(s => s.remaining >= 2).time } : {};
  return engine.createQuote({ vertical, offerId: offer.id, optionId: option.id, query, selection });
}

test('query validation rejects past dates, inverted ranges and bad numbers', async () => {
  const { engine } = setup();
  const d = addDays(today(), 10);
  await assert.rejects(engine.search('hotels', { where: 'x', checkIn: '2020-01-01', checkOut: d }), e => e.code === 'invalid_query' && /past/.test(e.details.checkIn));
  await assert.rejects(engine.search('hotels', { where: 'x', checkIn: d, checkOut: d }), e => /after/.test(e.details.checkOut));
  await assert.rejects(engine.search('hotels', { where: 'x', checkIn: d, checkOut: addDays(d, 2), guests: '99' }), e => !!e.details.guests);
  await assert.rejects(engine.search('nope', {}), { code: 'vertical_unavailable' });
});

test('full flow for every vertical: quote → booking → decline → pay → confirmed', async () => {
  const { engine } = setup();
  for (const [vertical, query] of Object.entries(sampleQueries())) {
    const quote = await quoteFor(engine, vertical, query);
    assert.equal(quote.total, quote.subtotal + quote.taxes + quote.fees, `${vertical} totals add up`);
    const { booking, accessToken } = await engine.createBooking({ quoteId: quote.id, traveler: TRAVELER });
    assert.match(booking.ref, /^DEMO-/, 'demo bookings are prefixed');
    assert.equal(booking.status, 'pending_payment');
    await assert.rejects(engine.payBooking(booking.ref, { token: accessToken }, DECLINE), { code: 'payment_declined' });
    const paid = await engine.payBooking(booking.ref, { token: accessToken }, VISA);
    assert.equal(paid.booking.status, 'confirmed', vertical);
    assert.ok(paid.booking.supplierRef);
    assert.deepEqual(paid.booking.payment, { brand: 'Visa', last4: '4242', mode: 'test' });
    await assert.rejects(engine.payBooking(booking.ref, { token: accessToken }, VISA), { code: 'not_awaiting_payment' });
  }
});

test('booking access needs the token or the matching email', async () => {
  const { engine } = setup();
  const quote = await quoteFor(engine, 'hotels', sampleQueries().hotels);
  const { booking, accessToken } = await engine.createBooking({ quoteId: quote.id, traveler: TRAVELER });
  await assert.rejects(engine.getBooking(booking.ref, {}), { code: 'booking_not_found' });
  await assert.rejects(engine.getBooking(booking.ref, { token: 'wrong' }), { code: 'booking_not_found' });
  await assert.rejects(engine.getBooking(booking.ref, { email: 'other@example.com' }), { code: 'booking_not_found' });
  assert.equal((await engine.getBooking(booking.ref, { token: accessToken })).booking.ref, booking.ref);
  assert.equal((await engine.getBooking(booking.ref.toLowerCase(), { email: ' mona@example.com ' })).booking.ref, booking.ref);
  const pub = (await engine.getBooking(booking.ref, { token: accessToken })).booking;
  assert.ok(!('accessTokenHashes' in pub) && !JSON.stringify(pub).includes(accessToken));
});

test('expired quote and lapsed payment window are refused', async () => {
  const { engine, advance, config } = setup();
  const quote = await quoteFor(engine, 'cars', sampleQueries().cars);
  advance((config.quoteTtlMinutes + 1) * 60000);
  await assert.rejects(engine.createBooking({ quoteId: quote.id, traveler: TRAVELER }), { code: 'quote_expired' });

  const q2 = await quoteFor(engine, 'cars', sampleQueries().cars);
  const { booking, accessToken } = await engine.createBooking({ quoteId: q2.id, traveler: TRAVELER });
  advance((config.paymentWindowMinutes + 1) * 60000);
  await assert.rejects(engine.payBooking(booking.ref, { token: accessToken }, VISA), { code: 'payment_window_expired' });
  assert.equal((await engine.getBooking(booking.ref, { token: accessToken })).booking.status, 'expired');
});

test('cancellation refunds in full inside the free window, partially after it', async () => {
  const { engine, store, advance } = setup();
  // Yacht charters: free until 7 days before, 50% after.
  const query = { ...sampleQueries(10).yachts };
  const quote = await quoteFor(engine, 'yachts', query);
  const { booking, accessToken } = await engine.createBooking({ quoteId: quote.id, traveler: TRAVELER });
  await engine.payBooking(booking.ref, { token: accessToken }, VISA);
  advance(5 * 86400000); // now 5 days before the charter: past the 7-day window
  const { cancellationPreview } = await engine.getBooking(booking.ref, { token: accessToken });
  assert.equal(cancellationPreview.freeWindowOpen, false);
  assert.equal(cancellationPreview.refundAmount, quote.total - Math.round(quote.total / 2));
  const done = await engine.cancelBooking(booking.ref, { token: accessToken });
  assert.equal(done.booking.status, 'cancelled');
  const stored = await store.getBookingByRef(booking.ref);
  const intent = await store.getPaymentIntent(stored.paymentIntentId);
  assert.equal(intent.refundedAmount, cancellationPreview.refundAmount);
  assert.equal(intent.status, 'partially_refunded');
  await assert.rejects(engine.cancelBooking(booking.ref, { token: accessToken }), { code: 'not_cancellable' });

  const q2 = await quoteFor(engine, 'yachts', { ...sampleQueries(30).yachts });
  const b2 = await engine.createBooking({ quoteId: q2.id, traveler: TRAVELER });
  await engine.payBooking(b2.booking.ref, { token: b2.accessToken }, VISA);
  const c2 = await engine.cancelBooking(b2.booking.ref, { token: b2.accessToken });
  assert.equal(c2.booking.refundAmount, q2.total);
});

test('if the supplier fails after payment, the traveler is refunded in full', async () => {
  const flaky = FACTORIES.hotels({});
  flaky.book = async () => { throw new Error('supplier timeout'); };
  const { engine, store } = setup({ overrides: { hotels: flaky } });
  const quote = await quoteFor(engine, 'hotels', sampleQueries().hotels);
  const { booking, accessToken } = await engine.createBooking({ quoteId: quote.id, traveler: TRAVELER });
  await assert.rejects(engine.payBooking(booking.ref, { token: accessToken }, VISA), { code: 'supplier_failed' });
  const stored = await store.getBookingByRef(booking.ref);
  assert.equal(stored.status, 'failed');
  const intent = await store.getPaymentIntent(stored.paymentIntentId);
  assert.equal(intent.status, 'refunded');
});

test('supplier outages surface as a friendly 502, never the supplier error text', async () => {
  const { engine } = setup();
  await assert.rejects(engine.search('hotels', { ...sampleQueries().hotels, where: '__supplier_down__' }), e => e.status === 502 && !/simulated/.test(e.message));
});

test('traveler details are validated', async () => {
  const { engine } = setup();
  const quote = await quoteFor(engine, 'transfers', sampleQueries().transfers);
  await assert.rejects(engine.createBooking({ quoteId: quote.id, traveler: { firstName: '', lastName: 'x', email: 'nope' } }), e => e.code === 'invalid_traveler' && !!e.details.email && !!e.details.firstName);
});
