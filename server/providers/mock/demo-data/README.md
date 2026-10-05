# Demo inventory — not production data

Everything in this folder is **fictional demo inventory** used by the mock providers
(`../Mock*Provider.js`). Properties, airlines, ships, yachts, suppliers, prices and reviews are
invented; airport codes and place names are real only so searches feel natural.

Isolation rules (enforced in code, see `server/providers/registry.js` and `server/config.js`):

- Only the mock providers import this folder. Nothing in the booking engine, payments, routes
  or views does.
- Every offer built from it carries `demo: true`, and the UI shows a "Demo inventory" badge.
- `APP_ENV=production` refuses to load any mock provider unless `ALLOW_DEMO_INVENTORY=true`
  is set deliberately, and `PAYMENT_MODE=live` can never be combined with demo inventory.
- Bookings made against demo inventory get a `DEMO-` reference prefix and are stored with
  `demo = true`, so they can never be mistaken for, or reported alongside, real bookings.

The data is stored in a deliberately vendor-like raw shape (snake_case, major-unit prices, supplier
codes). The mock providers map it through the same normalization a real adapter would, so the
normalization layer is exercised end to end in development.
