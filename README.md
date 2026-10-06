# Tripelyx

**Travel by Budget**: a budget-first trip planner ("How much do you want to spend?") that builds
complete trips (flights, hotel, experiences, transfers) priced in full and shows the three best fits,
plus the Tripelyx corporate site and a provider-agnostic booking platform for hotels, flights, cars,
cruises, yachts, transfers, activities and experiences. Everything runs today on **isolated demo
inventory** and a **test-mode payment processor**; real suppliers and a real payment processor plug in
later by adding adapters, without touching the trip engine, booking engine, routes or UI.

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

## Travel by Budget

The planner is on by default outside production (`ENABLE_TRIPS`) and becomes the homepage; the
corporate homepage moves to `/company`. Admin access is given by email (`ADMIN_EMAILS`).

| Route | What it is |
| --- | --- |
| `/` | "How much do you want to spend?", a live example, where each budget can take you, Journey B entry ("Make it work"), Surprise Me |
| `/plan` | One question at a time: budget, then "Is that just the booking, or the whole vacation?" (money protected for after you land, your number, never a suggestion), departure city, travelers, dates, style, what matters most |
| `/trips` | Three trips, never hundreds: Our pick, Save more, and Upgrade only if worth it (shown only when more money buys something real without giving anything up; otherwise "keep your money" with what we considered), each with its verdict; "You gave us / We need / You keep"; "Our call" (the one we'd book, what almost won and why, what would change our mind); flexibility toggle; why we didn't pick the cheapest; no dead ends (change dates, shorten the trip, another destination, allow up to 10% more, protect less, ask a specialist); when a reserve is protected and nothing fits, the budget collision is spelled out (vacation budget, reserve, what is left for the booking) and "One rule away" re-runs the search with exactly one rule relaxed at a time, offering only the relaxations that really produce a trip, at its real price, and naming the ones that don't get there alone |
| `/trip/:token` | The trip: verdict (Great fit / Good fit / Budget fit / We'd keep looking, biggest win and compromise, what we'd actually do), the main actions (Make it cheaper, Make it better, Change one thing, Compare, Step by step), budget meter, Your money, the whole vacation (the booking as known and paid today, the reserve as yours and untouched, what is left unassigned, what you arrive with as a whole-dollar planning figure per day that we never call enough; optional items at the customizer's real prices; what we don't put a number on), Get me back to my price, budget unlocks (what a little more buys), Make it better for the same money, Protect the magic (lock hotel, flights or dates and optimize the rest; a lock is never silently broken), Your time there (usable vacation time from the flight schedule, weekdays away as PTO days with cheaper or same-price versions that keep a PTO day, Get my day back), recipe, customizer (every change re-priced), Make it cheaper one change at a time, Name your price, Know Before You Book, scorecard, trade-offs |
| `/trip/:token/optimize` | Before and after: the strongest alternative package at or under the current total (or the budget) with the locked parts held fixed, or an honest "this is already the best version" |
| `/trip/:token/price` | Name your price: a number lower than the total, and we search downward (hotel, flight, dates, nights, extras) for the cheapest version that is still a strong trip. Three honest outcomes: "we got there"; "we can make it cheaper, we don't think we should" (the floor, the value cliff, and your price anyway with what it means); or "no version gets there" with real next moves. The value ladder shows every rung and its trade-offs |
| `/trip/:token/guide` | Your trip, step by step: a first-trip guide built from the trip itself (before you leave, the airport, bags, security and boarding, your connection, arrival, your hotel, your experiences, going home), each line marked "We know this", "Check required" or "General guidance"; it says what it doesn't know instead of guessing |
| `/compare` | Two or three trips side by side, only the rows that differ, each with its verdict |
| `/trip/:token/review` | Live price check with explicit approval of any increase; with a reserve, Your vacation plan and "Does the whole trip fit?", and a price rise asks where it should come from (find it in the booking, unassigned money, change the reserve, or don't accept) with an approve button that names any part taken from the reserve; our honest take, Travel reality check (documents, arrival and last day, bags, fees, changing your mind, getting to the hotel, weather) and what's not in the price, final trip review, readiness checklist, promo code, then the quote |
| `/dream` | Journey B / Budget Negotiator: a dream destination and a maximum; the gap and the single changes that close it. Also "I have to be there" (a fixed date) and "Beat my quote" (`beat=1`: the price someone else offered, and an honest yes or "keep it") |
| `/checkout/:quoteId`, `/booking/:ref` | Traveler details and test-mode payment, with the vacation plan beside what is paid today; the trip page after booking (what was protected for the destination and the per-day figure, untouched by the booking (Trip ID, per-component confirmations, support thread, cancellation) |
| `/signin`, `/signup`, `/my-trips` | Accounts: upcoming and past trips, saved trips, price watches, last search |
| `/admin` | Control center (admins only): KPIs and funnel, bookings with internal economics and alerts, trip requests, business rules, promo codes, outbox |
| `/how-it-works`, `/faq`, `/legal/*`, `/custom-trip`, `/destinations`, `/trips-under-:n`, `/trips-to-:slug`, `/beach-vacations` | Help, legal placeholders (marked for professional review), custom trip request, SEO landing pages |

```
server/trips/
  demo-data/            invented origins, destinations, hotels, activities (labeled demo everywhere)
  integrations/         maps, weather, flights, hotels, activities, transfers, notifications
                        (types.d.ts = the interfaces; mock.js = demo; index.js = where real adapters register)
  spec.js               the shareable trip token (destination, dates, travelers, hotel, flight, extras)
  pricing.js            full price (taxes, mandatory fees, service fee) + internal economics (never sent to browsers)
  optimizer.js          every sensible combination per destination, scored on customer value only; picks 3
  facts.js              fact-only helpers: usable vacation time from the flight clock, what changed
                        between two trips (improvements vs trade-offs), the side-by-side diff
  vacation.js           the whole-vacation picture: booking (known), the traveler's reserve, unassigned,
                        what they arrive with; nothing estimated, the reserve only ever touched by name
  decision.js           the decision layer: verdicts, budget unlocks, make it better / optimize around
                        locks, name your price (the downward search and the value ladder), weekdays
                        away and PTO alternatives, the step-by-step guide, the reality check
  service.js            search, trip pages, customizer, live price check, quotes, the booking provider,
                        saved trips and watches, support, requests, funnel events, admin numbers
server/accounts/        email + password (scrypt), server-side sessions, admin by email
```

Rules the engine keeps: the total shown is the total charged (taxes and mandatory fees inside it);
a trip is "within budget" only when that complete total is at or under the budget; a changed price is
never charged without the traveler's approval (checked at the review page and again at payment);
platform margin is never an input to ranking; no fake scarcity, reviews or discounts. Pricing and
margin rules (service fee, markup, minimum profit and margin) are editable under `/admin/settings`;
bookings under the minimums are flagged for review, never silently repriced. The decision layer
follows the same rules: a verdict uses only the traveler's answers and the facts of the trip; "make it
better" reports "nothing better" when that is true instead of a lateral change; usable vacation time is
computed from the flight schedule (demo flights carry departure and arrival times; a real adapter that
returns none simply hides those facts); "beat my quote" says "keep it" when we can't beat a price. The budget is a ceiling, not a target: "Our pick" is the
cheapest of the trips that match best, and the money it leaves is shown as yours to keep; an upgrade
is offered only when it improves something real (hotel, flight, nights, area, meals, time) without
giving anything up, otherwise we say "keep your money" and how many dearer trips we considered;
"name your price" searches downward and says where we'd stop and why, and shows the cheaper
version anyway if asked, with what it means; the step-by-step guide marks every line as known,
needs checking, or general guidance, and never guarantees entry or a connection. A budget is read the
way the traveler meant it: "just the booking" or "the whole vacation", and in the second case the money
protected for after landing is the traveler's number (we never suggest one or judge it), the search
runs on what is left, and a booking is never called within budget because it is under the vacation
total; every amount on the vacation picture is the traveler's own, the booking's complete price, or
arithmetic on the two (food, getting around and shopping are named as things we don't put a number on);
a price rise asks where it should come from and the reserve is only ever used by name on the button;
"one rule away" offers a relaxation only after re-running the search with it and names the real price.

### Roadmap (phased, behind feature flags)

The MVP above is the production-ready first pass. Everything else from the product spec is a later
phase, to be added behind its own flag once real suppliers are connected:

- Trip Companion after booking (today's view, itinerary, remaining vacation budget, daily spending, plan B, offline essentials, packing, airport/arrival/check-out modes, spend review).
- Trip Simulator and budget intelligence (what should my budget be, price drivers, destination cost index, hidden-cost detector, stress test, trade-off lab, diminishing-returns curve, "my perfect number").
- Full Budget Negotiator (lock components, no-compromise mode, dream tracker, "it's possible" alerts, flexibility currency, travel goals) on top of today's `/dream`.
- Social and decision tools: compare side by side, group budget splitter and decision room, couples mode, share-before-booking votes, second-thoughts mode.
- Growth: referrals, loyalty, deal radar, deal of the day, price history, budget calendar, My Travel Year, Trip Remix, Beat My Trip, gift a trip, trip fund, pay over time, travel wallet.
- AI assistant and negotiator through a provider interface (rule-based today), real review ingestion (verified bookings only), email/SMS delivery for the outbox, abandoned-trip emails.
- From the decision-engine spec, deferred until the data exists or a real supplier is connected: deal-breaker filters and a priority stack as planner steps; trip verdict history and "second opinion" sharing; visa and passport-validity facts, insurance comparison and health advisories (need an authoritative source); multi-city and stopover trips, "stretch my trip", Trip Ladder tiers and budget bidding; Trip Rescue after booking (schedule changes, re-plans); door-to-door true cost (home-to-airport transport, parking, pet care); family, group and multi-room engines, room types and group splits; "what if" flexibility pricing beyond nearby dates; neighborhood intelligence and venue-distance hotel search (need geodata); event, cruise-connection, wedding-guest, bleisure and visiting-family modes; component removal (already have flights or a hotel); experience-first and natural-language entry; Trip Request Marketplace and reverse auctions; Dreamboard and visual discovery; named trip versions, undo history and the drag-and-drop budget allocator.

From the fourth spec (the decision-engine rebuild), later phases behind their own flags. What it
asked for in the core journey is in today's pages (Our pick / Save more / Upgrade only if worth it,
keep your money, Name your price with the value ladder, Protect the magic, weekdays as a second
budget, no dead ends, the step-by-step guide). The standalone engines wait for the data or the
suppliers they need:

- Name Your Price, full engine: three numbers (dream, comfortable, absolute maximum), the price challenge ("I bet you can do $1,200", which says "you win" only when the number was genuinely reached), destination and experience price floors ("how cheap can I do Italy well?"), name-your-price across destinations, comparable-offer normalization for Beat my quote, drive and staycation fallbacks. Every floor comes from configurations we actually priced, never a curve.
- Travel Budget Lab (money to experience): "what can my money become?" as its own entry, the Money Board and Money Ladder with breakpoints, the $100 give-and-take buttons, allocation buckets and "spend it for me", budget personality, budget-lab pages per destination, experience and length. Keeping the money always competes; tiers exist only where the trip materially changes; the maximum is never the target.
- Travel Power: a world map of where a budget is strong (Strong / Possible / Stretch / Not searched), "take $300 back" two-budget comparison, "which rule is costing me the most?", "make my money stronger" levers (dates, nearby airport, one stop), travel power by month, and alerts when your money gets stronger. Every claim from priced inventory, labeled live, recent or estimate; never a made-up score.
- Trip Matchmaker (eliminate the world): hard-no vs preference tiers, the shrinking candidate map, almost-matches, a destination tournament (Beach vs City, Luxury vs Longer), blind Trip A vs Trip B picks with a reveal, Final 8/4/2 and a wildcard. Counts and eliminations only from priced inventory; every rule reversible; never a fake "world shrinks" number.
- Trip Time Machine (when should I go): destination x dates x length across the months you can travel, a date heatmap and month slider, best-week picks (overall, money saver, weather, PTO, longest), a PTO and holiday optimizer on a real holiday calendar, event locks, experience seasons, calendar watches. Prices only for dates actually searched; climate context never shown as a forecast. Today: Anytime and flexible-month search, nearby-date re-pricing, unlock your dates.
- Trip Draft (blind vacation builder): pick flight, stay, room, length, experience and location concepts with prices hidden, then the reveal, Dream DNA, "get me to my number" with a savings meter, sequential cuts, "find another way", "restore one thing", draft history and a share card. Needs room types and location tiers. Every compromise stays visible; the trip is never silently made worse to hit a number.
- Trip Reverse Engineer (Experience DNA): show us a trip you found and we break it into what you actually love (view, privacy, pace, room, length), must-keep vs flexible, "same dream, different place", "same place, smarter version", three rebuilds (closest / best value / wildcard) with what we kept, changed and saved. Qualitative labels only; never a similarity score or a "dupe".
- Trip Puzzle (build around what I have, "finish my trip"): existing flights, hotels, free lodging, event tickets, cruises, credits and points as locked pieces the engine builds around; found-money choices with "keep the savings" first; already-paid vs still-needed; a net-change audit of changeable bookings. Needs component-removal pricing and real supplier terms. Credits and points are never treated as cash; a locked component is never re-sold.
- Trip Contract (customer promises): tiered promises (must not change, important, preferred), locks carried to checkout, a promise-violation check that blocks payment, trip versions with history, compare and restore, "that's not what I picked", post-booking change requests with confirmation matching, an admin promise view and audit log. A checkmark only for what the booking data supports; a locked requirement is never substituted without asking.
- Vacation Success Plan: up to three success goals and deal-breakers as planner steps, goals translated into trip design, a "good price, wrong vacation" detector, vacation rhythm and density with "protect my free time", purposeful-upgrade classification, couples and family plans, a post-trip "did it deliver?" loop. Never guarantees a feeling; keeping the money always competes.
- Build My Travel Year: an annual travel budget and PTO bank across several trips, strategies (one big year, balanced, travel more), Compare my year, lock a must-do trip and build the rest, trip states (idea, planned, booked), the travel calendar, "this upgrade costs a weekend", a protected opportunity fund, a year health check. The customer sets the budget; estimates are never counted as spent.
- Vacation Autopilot: set rules once (ideal and maximum total, nights range, flight and hotel rules, deal-breakers, departure windows, notice required, attention threshold), then scheduled re-searches surface only trips that materially pass them, with "why now" and "why this made the cut", not-for-me and snooze, weekend and "get me out of here" modes. It never books, never relaxes a rule silently, and sends nothing when nothing qualifies.
- First-Time Traveler Mode and Trip Rehearsal, after booking, once suppliers return itinerary segments: "I've never done this before", Rehearse my trip, "what do I do now?", "am I ready to go?" (ready / needs attention / not yet verified), a connection coach, document, packing and arrival kits, a return-day checklist. Today: the step-by-step guide on every trip. Says "we don't know yet, here's where to check" when a fact is missing; never guarantees entry; never fear-sells.
- Trip Guardian (post-booking trip integrity): detect supplier changes to flights and hotels, trace the ripple across transfer, hotel, experiences and the return ("check my whole trip", "what did this break?", "fix what this affected", "fix only the hotel"), net-of-fees price drops, schedule and airport-change flags, 7-day and 24-hour checks, a change history and a quiet alerts inbox. Plain statuses, never scores; nothing is cancelled, rebooked, changed or charged without the traveler's explicit approval.
- Trip Handoff and shared responsibility: a responsibility board for group trips with owners, task states and "blocked by" dependencies, finalist votes that never book silently, private budgets shown only as a shared range, split modes with no assumed equal split, handoff that keeps the previous owner's context. No profiling, no shame language, no fake urgency.
- Season Switch (climate-first search), once a historical-climate provider replaces the demo month label: Find my season, Chase summer, Find real winter, Follow the sun, "where is my perfect October", a weather-profile builder and the climate-vs-price trade-off. Climate is always a historical pattern, never a forecast or a guarantee of snow, bloom or sun.
- Crowd and Calm (the calmer version), once crowd, event and school-holiday data exist: a calmer version of the same trip, "escape the peak" date scanning, and the peak-timing price difference. We say "typically less busy", never "empty"; when crowd data is thin we say so; nothing is rebooked automatically.
- Also deferred from the master command: room types in the no-silent-downgrade check, a checkout add-ons step (insurance, seats, bags as explicit choices with prices), and "finish my trip" around existing bookings (part of Trip Puzzle above).

From the fifth spec (Trip Reality Builder to Trip Proof), later phases behind their own flags. Its
core-journey asks are in today's pages (booking budget vs whole vacation, the vacation picture with
known / optional / reserve rows, "does the whole trip fit?", no silent reserve raid, the budget
collision and "one rule away"). The rest waits for data we don't have or belongs after booking:

- Trip Reality Builder, the rest: budget envelopes (food, transport, experiences, shopping, cushion) with "help me set it up / I'll set it myself", a budget style (simple, moderate, splurge on a few things) as a trip preference, auto-build from travel questions labeled "suggested planning estimate", experience protection locks ("the whole reason I'm going is to scuba dive"), a stress test before payment, and "cheap to book vs cheap to be there" comparisons (all-inclusive vs room-only, central vs far hotel) once real on-ground and transport numbers exist. We never infer what amount is appropriate, never show a per-day figure as a verdict, and never pretend every traveler spends the same.
- Daily Spend Navigator (after booking): the protected money as a daily plan the traveler edits (fixed vs flexible, pace, "what's left for today"), adjustments after a splurge, group splits, refunds back into the plan. It is a planning helper, not banking: no bank links, no credit language, no scoring, and every number is the traveler's own or a receipt they entered.
- No-Car Vacation Engine: "can I do this trip without a car?", walkable-vs-transit-vs-rental comparison, true ground cost, and hotel placement that removes the car, once transit, walkability and parking data exist for the destination. Until then the trip page says only what it knows (the transfer, the hotel area).
- Vacation Composer: several trips in one plan (a travel year, a long trip in legs) with one money and PTO ledger, trade-offs between trips, and "lock this one, build the rest"; shares the Build My Travel Year flag.
- Trip Booking Order: which part to book first, what each part locks, verified deadlines only (a hotel's free-cancellation date, a fare's hold), no countdowns or invented urgency, and "what happens if I wait" from real re-pricing. Today every part is booked together with its own terms shown.
- Travel Re-entry: a gentle first-trip-in-years mode (what changed, document checks, slower pacing) built on the step-by-step guide; it never invents rules and marks anything unverified.
- Trip Constraint Solver, the rest: several rules relaxed together with the least-painful combination, "which rule is costing me the most" from real re-runs, a rules board with never / last / flexible / don't care tiers. No fake solution: nothing is offered that was not priced.
- Trip Contrarian (second opinion): "before you book, one thing we'd reconsider" from real alternatives (dates, hotel tier, nonstop, car, nights, airport), always concrete ("two days later is $380 less"), never a lecture, with "don't agree with me" as a first-class answer. Only when a comparable alternative was actually priced.
- Trip Price Doctor: "what is making this trip expensive" as the price of each preference (nonstop, 4-star, beachfront, breakfast) from comparable priced options, the one-change cure before five small downgrades, a pain order (never / last / flexible), and a price leak detector that never labels a required fee as a leak. Partly covered by Name your price and the value ladder today.
- Trip Readiness (after booking): "booked ≠ ready", documents, transit, activities, ground transport, payment, bags, arrival and events as ready / needs verification / action required, with a pre-departure timeline of only relevant tasks. Never a score, never "you will make the connection" or "you are guaranteed entry".
- Trip Scenario Studio: "what if" as named scenarios beside the current trip (never destroying it), the change breakdown (what you gain, what you lose, why the total moved, the ripple through dates, PTO, hotel and transfer), undo and history, lock-and-rebuild, best single change. Today the customizer, compare and Protect the magic cover one change at a time.
- Trip Memory Vault: explicit rules the traveler saved ("make this a rule", just this trip / default / ask me each time), contextual profiles (solo, couple, family), regret and success memory from a few post-trip questions, trip recipes and "same recipe, new place", a control center that shows and deletes every rule, memory expiration. No hidden memory, no inferred profile, no "you always prefer".
- Vacation Auction: priorities compete for the budget (hotel, nonstop, nights, location, food, experiences, keeping money), money locks, "give the trip $100 / take $100 away", a pressure test that finds the natural price floor, couples and group auctions with private budgets shown as ranges. Keep-money always competes; the reserve is never used to make a booking fit without permission.
- Trip Proof: the recommendation receipt (why we picked it, why it beat the others, what it sacrifices, what would change our mind), every fact labeled by evidence type (live supplier data, current search, provider information, public rating, estimate, customer preference, platform calculation, needs verification) with its freshness, "prove the savings" with a comparability check, and "what's the catch" that says "we didn't find a major trade-off in the data currently available" rather than inventing one. Today: Our call, why not the cheapest, what would change our mind, the scorecard and the trade-offs, with demo data labeled demo and prices checked at the review page.

## Pages

| Route | What it is |
| --- | --- |
| `/company` | Corporate homepage (served at `/` when `ENABLE_TRIPS=false`) |
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
- Trip inventory follows the same rule: `TRIP_*_PROVIDER=mock` is refused where demo inventory is not
  allowed, so the planner simply switches off instead of serving invented trips.

## Environments and secrets

- `APP_ENV` is `development`, `staging` or `production`. Staging and production require their own
  `DATABASE_URL`, and `DATABASE_ENV` must match `APP_ENV` so one environment can't use another's database.
- Secrets come only from environment variables. `.env` files are git-ignored; `.env.example` holds placeholders.
- No key or provider credential is ever sent to the browser; `/api/config` exposes only the
  environment name, payment mode, currency and which verticals are on.
- Card data: in test mode only the brand and last four digits are stored.
- Security headers via helmet with a strict Content-Security-Policy (no inline scripts or styles),
  rate limiting on the API, HttpOnly SameSite=Strict booking cookies with hashed access tokens.
- Accounts: scrypt password hashes, server-side sessions (only a hash of the session token is stored),
  HttpOnly SameSite=Lax session cookie, cross-site form posts refused. `ADMIN_EMAILS` grants `/admin`.
- Notifications default to an outbox (`NOTIFY_PROVIDER=outbox`): recorded and visible to admins, never
  sent, until a real provider is registered.

## Assets

Photography is derived from Alamein Go's own `public/hero-beach.jpg`; illustrations, icons, device
mockups and demo images are original. The Inter font is bundled under the SIL Open Font License
(see `public/fonts/OFL.txt`).
