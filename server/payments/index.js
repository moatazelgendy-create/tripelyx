// Picks the payment processor from PAYMENT_MODE. Test mode is the default everywhere; live mode is only
// reachable in production with a registered processor and its credentials (validated in config.js).
const { TestPaymentProcessor } = require('./TestPaymentProcessor');
const LIVE = require('./live');

function createPaymentProcessor({ config, store, now }) {
  if (config.payment.mode === 'test') return new TestPaymentProcessor({ store, now });
  const factory = LIVE[config.payment.liveProcessor];
  if (!factory) throw new Error(`PAYMENT_LIVE_PROCESSOR "${config.payment.liveProcessor}" is not registered in server/payments/live/index.js`);
  return factory({ config, store, now });
}

module.exports = { createPaymentProcessor };
