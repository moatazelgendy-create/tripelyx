# Tripelyx

The Tripelyx corporate site plus a provider-agnostic booking platform for hotels, flights, cars,
cruises, yachts, transfers, activities and experiences. Everything runs today on **isolated demo
inventory** and a **test-mode payment processor**; real suppliers and a real payment processor plug in
later by adding adapters, without touching the booking engine, routes or UI.

## Run it

```sh
cd tripelyx
npm install
cp .env.example .env          # placeholders only; edit locally, never commit
npm run dev                   # http://localhost:4100 (in-memory store, mock providers, test payments)
# or load the .env explicitly:  node --env-file=.env server/index.js
npm test                      # unit + HTTP tests (Postgres tests run when TEST_DATABASE_URL is set)
npm run screenshots           # desktop 1440 / tablet 820 / phone 390 into ./screenshots (needs Playwright)
```

Test cards at checkout: `4242 4242 4242 4242` (success), `5555 5555 5555 4444` (success),
`4000 0000 0000 0002` (declined), `4000 0000 0000 9995` (insufficient funds),
`4000 0000 0000 0069` (expired). Any future expiry and any CVC.

## Pages

| Route | What it is |
| --- | --- |
| `/` | Homepage, recreated from the reference desktop screenshot |
| `/brands`, `/technology`, `/partners`, `/about`, `/contact` | Site pages (partner form stores leads) |
| `/book`, `/book/:vertical` | Search per vertical, server-rendered with JS-enhanced loading states |
| `/book/:vertical/:offerId` | Offer details and options; "Reserve" creates a time-limited quote |
| `/checkout/:quoteId` | Traveler details and payment (test mode) |
| `/booking/:ref`, `/manage` | Booking confirmation, cancellation, lookup by reference + email |
| `/api/*` | JSON API used by the UI (search, offers, quotes, bookings, pay, cancel, partners) |

## Architecture

```
server/
  verticals.js              the 8 verticals, their flags, provider env names and search fields
  config.js                 all settings from env; publicConfig() is the only part sent to browsers
  providers/
    types.d.ts              HotelProvider, FlightProvider, … PaymentProcessor interfaces
    contracts.js            runtime checks: every provider result is validated before use
    registry.js             picks mock or a real adapter per vertical from <VERTICAL>_PROVIDER
    adapters/index.js       where real supplier adapters are registered (empty today)
    mock/                   MockHotelProvider, MockFlightProvider, … + demo-data/ (isolated)
  booking/
    engine.js               quote -> booking -> pay -> supplier book -> cancel/refund
    MemoryStore.js          development store
    PostgresStore.js        staging/production store (tables tx_*)
  payments/
    TestPaymentProcessor.js test cards, no network, no real money
    live/index.js           where real processors are registered (empty today)
  routes/ views/            Express routes and server-rendered, auto-escaped views
public/                     CSS, small progressive-enhancement scripts, images, font
```

The UI and booking engine only ever see **normalized** offers and quotes (money in integer minor
units). Each provider maps its supplier's own response shape into that model; the mock providers do
exactly the same mapping from vendor-like raw data, so swapping one in is a configuration change.

### Connecting a real supplier

1. Add a class in `server/providers/adapters/` implementing the vertical's interface
   (`search`, `getOffer`, `quote`, `book`, `cancel`; see `types.d.ts`).
2. Register it in `server/providers/adapters/index.js`, e.g. `hotels: { acme: env => new AcmeHotels(env) }`.
3. Set `HOTEL_PROVIDER=acme` and the adapter's credentials in that environment's secret store.

### Connecting a real payment processor

1. Implement the `PaymentProcessor` interface and register it in `server/payments/live/index.js`.
2. Replace the test card widget (`public/js/payments-test.js`) with the processor's hosted fields
   behind the same `window.TxPayments` interface, so card data never reaches this server.
3. In production only: `PAYMENT_MODE=live`, `PAYMENT_LIVE_PROCESSOR`, `PAYMENT_LIVE_SECRET_KEY`,
   `PAYMENT_LIVE_WEBHOOK_SECRET`, and `ALLOW_DEMO_INVENTORY=false`. The app refuses to boot in live
   mode if any of these is missing, outside production, or combined with demo inventory.

## Deploy

### AWS (via GitHub Actions)

Every push to `main` runs the tests, builds the Docker image, pushes it to Amazon ECR and updates the
`tripelyx-staging` CloudFormation stack (`infra/app.yaml`). The stack holds:

- ECS Fargate running the app behind an Application Load Balancer, with health checks on `/healthz`
  and automatic rollback if a new version fails them.
- Its own private, encrypted PostgreSQL database on RDS. RDS keeps the password in Secrets Manager,
  and the app receives it at start-up; it never appears in GitHub or in the image.
- Logs in CloudWatch (`/tripelyx/staging`).

GitHub signs in to AWS with OpenID Connect, so no AWS keys are stored in GitHub. The deploy role only
works for workflow runs on `main` of this repository.

The Tripelyx AWS account (`us-east-1`) is already set up, and the workflow uses it by default.
To deploy into a different AWS account, do this **one-time setup (about 5 minutes):**

1. In the AWS console, pick a region, open **CloudFormation → Create stack → With new resources**,
   choose **Upload a template file** and upload `infra/bootstrap.yaml`. Name the stack
   `tripelyx-bootstrap`, keep the defaults, tick the IAM acknowledgement, and create it. If the
   account already has a GitHub identity provider (`token.actions.githubusercontent.com`), set
   `CreateOidcProvider` to `false`.
2. When it finishes, open the stack's **Outputs** tab and copy `DeployRoleArn`.
3. In GitHub, open the repository's **Settings → Secrets and variables → Actions → Variables** and add
   `AWS_ROLE_ARN` (the value you copied) and `AWS_REGION` (for example `us-east-1`).
4. Merge to `main`, or run **Actions → Deploy to AWS → Run workflow**. The first run takes about
   15 minutes, mostly creating the database. The run summary shows the site's address.

Optional repository variables: `APP_ENV=production` deploys a separate `tripelyx-production` stack
with its own database (Multi-AZ, deletion protection). `CERTIFICATE_ARN` is an ACM certificate for
your domain, which turns on HTTPS. Then point the domain at the load balancer with a CNAME.

Staging runs demo inventory with `PAYMENT_MODE=test`, so it is safe to share. A staging stack
costs roughly USD 40 to 50 a month (load balancer, a small database, one small container). If a
first deploy fails, delete the `tripelyx-staging` stack in CloudFormation before running it again.

### Other hosts

The `Dockerfile` runs anywhere containers run, and `render.yaml` is a ready Render Blueprint. Set the
variables from `.env.example` in the host's settings, never in the repo. Behind a proxy or load
balancer set `TRUST_PROXY=true`. `APP_ENV=staging DATABASE_URL=memory` runs a throwaway demo
without a database: bookings disappear on restart, and production refuses it.

**Going to production** needs its own database, the verticals switched on with `ENABLE_*`, real
supplier adapters and a live payment processor as described above. Until then, keep public
deployments on `staging`.

## Demo data isolation

- Demo inventory lives only in `server/providers/mock/demo-data/` and is served only by mock providers.
- Demo bookings get `DEMO-` references and a "Demo inventory" label; non-production pages show an
  environment banner; demo images are generated SVGs under `/media/demo/`, mounted only when demo
  inventory is allowed.
- Production refuses mock providers unless `ALLOW_DEMO_INVENTORY=true`, and never with live payments.

## Environments and secrets

- `APP_ENV` is `development`, `staging` or `production`. Staging and production require their own
  `DATABASE_URL`, and `DATABASE_ENV` must match `APP_ENV` so one environment can't use another's database.
- Secrets come only from environment variables. `.env` files are git-ignored; `.env.example` holds placeholders.
- No key or provider credential is ever sent to the browser; `/api/config` exposes only the
  environment name, payment mode, currency and which verticals are on.
- Card data: in test mode only the brand and last four digits are stored.
- Security headers via helmet with a strict Content-Security-Policy (no inline scripts or styles),
  rate limiting on the API, HttpOnly SameSite=Strict booking cookies with hashed access tokens.

## Assets

Photography is derived from Alamein Go's own `public/hero-beach.jpg`; illustrations, icons, device
mockups and demo images are original. The Inter font is bundled under the SIL Open Font License
(see `public/fonts/OFL.txt`).
