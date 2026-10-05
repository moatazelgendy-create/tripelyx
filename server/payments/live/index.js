// Live card processors, keyed by PAYMENT_LIVE_PROCESSOR. None is connected yet.
//
// To connect one (for example Paymob, which Alamein Go already uses, or Stripe):
//   1. Write a class here implementing PaymentProcessor (see ../../providers/types.d.ts):
//      createIntent / confirm / refund / clientConfig. `confirm` receives { type: 'token', token }
//      from the processor's own hosted card fields, so card numbers never touch Tripelyx servers.
//      `clientConfig` returns only public values (e.g. a publishable key).
//   2. Register it below:  paymob: ({ config, store }) => new PaymobProcessor({ config, store })
//   3. In production only: PAYMENT_MODE=live, PAYMENT_LIVE_PROCESSOR=paymob and the processor's
//      PAYMENT_LIVE_SECRET_KEY / PAYMENT_LIVE_WEBHOOK_SECRET, set in the deployment's secret store.
// The checkout UI and booking engine don't change.
module.exports = {};
