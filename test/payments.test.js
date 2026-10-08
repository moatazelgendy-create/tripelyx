const test = require('node:test');
const assert = require('node:assert/strict');
const { TestPaymentProcessor, luhn } = require('../server/payments/TestPaymentProcessor');
const { MemoryStore } = require('../server/booking');
const { clock } = require('./helpers');

const card = number => ({ type: 'test_card', number, expMonth: '12', expYear: '35', cvc: '123', name: 'T' });

test('test processor: success, declines, validation, refunds', async () => {
  const store = new MemoryStore();
  const p = new TestPaymentProcessor({ store, now: clock });
  const i = await p.createIntent({ amount: 10000, currency: 'USD', bookingId: 'bk_1', description: 'x' });
  assert.equal(i.mode, 'test');

  const declined = await p.confirm(i, card('4000 0000 0000 0002'));
  assert.equal(declined.status, 'failed');
  assert.match(declined.lastError, /declined/);

  await assert.rejects(p.confirm(i, card('4111111111111112')), { code: 'invalid_card' });
  await assert.rejects(p.confirm(i, card('4111111111111111')), { code: 'not_a_test_card' });
  await assert.rejects(p.confirm(i, { ...card('4242424242424242'), expYear: '19' }), { code: 'invalid_card' });
  await assert.rejects(p.confirm(i, { type: 'token', token: 'tok' }), { code: 'invalid_payment_method' });

  const ok = await p.confirm(i, card('4242424242424242'));
  assert.equal(ok.status, 'succeeded');
  assert.deepEqual(ok.card, { brand: 'Visa', last4: '4242' });
  assert.ok(!JSON.stringify(await store.getPaymentIntent(i.id)).includes('4242424242424242'), 'full card number is never stored');

  const part = await p.refund(ok, 2500);
  assert.equal(part.status, 'partially_refunded');
  const full = await p.refund(part, 999999);
  assert.equal(full.refundedAmount, 10000);
  assert.equal(full.status, 'refunded');
});

test('luhn', () => {
  assert.ok(luhn('4242424242424242'));
  assert.ok(!luhn('4242424242424241'));
});
