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
