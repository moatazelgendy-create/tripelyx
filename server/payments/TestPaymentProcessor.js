// PAYMENT_MODE=test. Simulates a card processor with documented test card numbers; it never talks to a
// bank and never moves money. Only the brand and last four digits of a card are ever kept — the full
// number is checked in memory and discarded, and is never logged or stored.
const { id } = require('../lib/ids');
const { AppError } = require('../lib/errors');

const TEST_CARDS = {
  '4242424242424242': { brand: 'Visa', outcome: 'succeeded' },
  '5555555555554444': { brand: 'Mastercard', outcome: 'succeeded' },
  '4000000000000002': { brand: 'Visa', outcome: 'card_declined' },
  '4000000000009995': { brand: 'Visa', outcome: 'insufficient_funds' },
  '4000000000000069': { brand: 'Visa', outcome: 'expired_card' },
};

const DECLINE_MESSAGES = {
  card_declined: 'Your card was declined. Try another card.',
  insufficient_funds: 'Your card has insufficient funds. Try another card.',
  expired_card: 'Your card has expired. Try another card.',
};

function luhn(num) {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

class TestPaymentProcessor {
  constructor({ store, now = () => new Date() }) {
    this.name = 'test';
    this.mode = 'test';
    this.store = store;
    this.now = now;
  }

  clientConfig() {
    return {
      mode: 'test',
      testCards: [
        { number: '4242 4242 4242 4242', result: 'Payment succeeds' },
        { number: '4000 0000 0000 0002', result: 'Card declined' },
        { number: '4000 0000 0000 9995', result: 'Insufficient funds' },
      ],
    };
  }

  async createIntent({ amount, currency, bookingId, description }) {
    const intent = {
      id: id('pi_test'), amount, currency, bookingId, description, status: 'requires_payment',
      mode: 'test', processor: this.name, refundedAmount: 0, createdAt: this.now().toISOString(),
    };
    await this.store.savePaymentIntent(intent);
    return intent;
  }

  async confirm(intent, method) {
    if (!method || method.type !== 'test_card') throw new AppError('invalid_payment_method', 'Test mode only accepts test card details.', 400);
    const number = String(method.number || '').replace(/[\s-]/g, '');
    const errors = {};
    if (!/^\d{12,19}$/.test(number) || !luhn(number)) errors.number = 'Enter a valid card number.';
    const month = Number(method.expMonth), year = Number(String(method.expYear || '').length === 2 ? `20${method.expYear}` : method.expYear);
    const now = this.now();
    if (!(month >= 1 && month <= 12) || !(year >= 2000) || year < now.getUTCFullYear() || (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1)) {
      errors.exp = 'Enter a valid expiry date in the future.';
    }
    if (!/^\d{3,4}$/.test(String(method.cvc || ''))) errors.cvc = 'Enter the 3 or 4 digit security code.';
    if (!String(method.name || '').trim()) errors.name = 'Enter the name on the card.';
    if (Object.keys(errors).length) throw new AppError('invalid_card', 'Check your card details.', 422, errors);

    const card = TEST_CARDS[number];
    if (!card) throw new AppError('not_a_test_card', 'Payments are in test mode — use one of the test card numbers shown. No real card is charged.', 422, { number: 'Use a test card number.' });

    const updated = { ...intent, card: { brand: card.brand, last4: number.slice(-4) }, updatedAt: now.toISOString() };
    if (card.outcome === 'succeeded') {
      updated.status = 'succeeded';
      updated.lastError = null;
    } else {
      updated.status = 'failed';
      updated.lastError = DECLINE_MESSAGES[card.outcome];
      updated.declineCode = card.outcome;
    }
    await this.store.savePaymentIntent(updated);
    return updated;
  }

  async refund(intent, amount) {
    if (intent.status !== 'succeeded' && intent.status !== 'partially_refunded') throw new AppError('not_refundable', 'Nothing to refund.', 409);
    const refundable = intent.amount - intent.refundedAmount;
    const amt = Math.min(Math.max(0, Math.round(amount)), refundable);
    const refundedAmount = intent.refundedAmount + amt;
    const updated = { ...intent, refundedAmount, status: refundedAmount >= intent.amount ? 'refunded' : 'partially_refunded', updatedAt: this.now().toISOString() };
    await this.store.savePaymentIntent(updated);
    return updated;
  }
}

module.exports = { TestPaymentProcessor, TEST_CARDS, luhn };
