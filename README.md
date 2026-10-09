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

The planner is on by default outside production (`ENABLE_TRIPS`). Its homepage is `/ai-travel-agent`;
`/` stays the corporate homepage, and Our Brands and Technology link to the agent. Admin access needs
an `ADMIN_EMAILS` address and a platform admin record (see [Platform admins](#platform-admins)).

| Route | What it is |
| --- | --- |
| `/ai-travel-agent` | One number first: "How much do you want to spend?" with "Show me what my money can do" (no destination required; the number is a ceiling, not a target), then WHAT DO YOU WANT FROM THIS TRIP? as four ways in with the same number: SAVE THE MOST (Save Max: tell us your max, we'll try not to use it), BEST VALUE (the mission as it is), MAKE IT EASY and MAKE IT MEMORABLE (Experience Max); BUILD ME AN EXPERIENCE under it with the promise "SPEND ON THE MEMORIES. NOT THE LABELS." (each starts the agent's mission in that mode: `save`, `easy` or `experience`); "I already know where I want to go" and "I already found a trip"; "Or say it in your own words" keeps the sentence box with the spec's example sentences. Below: what one sentence gets you, where each budget can take you, how the agent works, and the three ways in (a budget, a dream destination, a trip to beat) |
| `/agent`, `/agent/:id`, `/agent/:id/live` | The travel agent: conversation on the left, live Trip Canvas on the right (conversation first on phones, with a sticky total). One message becomes a canonical trip object (budget as a ceiling, booking or whole-vacation money with the protected part kept out, travelers, origin, destination, dates, nights, style, hard and soft flight rules, hotel rules, locks); the agent asks only the one question it cannot go without. Every ask is routed to the engines: build (fast first: the likeliest destinations priced live for a first strong match; deep second: every destination, with "I beat my first option" when a better one turns up; widening one rule at a time only when nothing fits), make it cheaper (Name your price downward, locks kept, a bad trade challenged once then accepted), make it better (only real improvements with nothing given up, else "keep the money"), one more night, only nonstop, what one stop saves, another country, easier (nonstop plus a transfer, nothing else touched), what's the catch, which one would you pick, can you beat this (the Trip Challenge in the conversation: the agent asks for each unknown about the found trip one question at a time, with "don't know" always an answer and "that's all I know" running the comparison with what it has; no win with unknowns), the one-more-compromise menu (when a price target is out of reach under the traveler's rules and locks, the single changes that would reach it, each priced, for the traveler to pick; only the chosen rule moves), book (You asked for against You are getting, with anything not as asked named, then the live price check page). Every change is a proposal with before and after; nothing is applied, booked, charged or cancelled without the traveler's word. Progress is real: each phase shows what it priced and when; nothing is widened silently and nothing is called exhaustive that was not run. **The mission (one number → three vacations):** a conversation started from a budget alone accepts the mission ("$1,500 is the ceiling, not a target… I'll only interrupt you when I need a real decision"), asks only where you fly from (origins as chips; never booking-or-vacation, beach-or-city, 3-or-4-star), applies saved defaults only when the traveler saved them and always says which ("not this time" drops them), shows a live draft while building (budget, destination, flight, hotel, length, total, each with its real state: understood, comparing, finding, matching, optimizing, calculating; never a blank screen, never a value the suppliers have not returned), a decision feed of real counts ("checked 22 destinations: 2,268 packages, 320 inside your rules"; "rejected 14 cheaper packages: each gives something up"), then three meaningfully different ways to use the same number (`server/trips/strategies.js`: More vacation, Keep more, Make it special, each a priced package at or under the ceiling with Total and Keep = ceiling minus total, what makes each different, one-tap reactions Love this / Too expensive / Too short / Too far / Wrong vibe under each, and one question: "Which feels more like you? 1 · 2 · 3 · None, try again"). The answer is a signal for this trip only (More → length and experiences, Keep → the budget is not a target, Special → quality), never saved without permission; "Got it. You seem to prefer… Let me push that direction" then prices three real versions in that direction (A/B/C, each at or under the ceiling, with what is not offered and why), "Pick A" or "the hotel from C with the flight from A" (mixed as one package by the real pricer, rejected with the reason when the pieces cannot be one trip). "None, try again" asks what was wrong (destinations, too expensive, too short, too much travel, hotels, not exciting) and builds a genuinely different set (nothing shown is repeated, the complaint changes the search, "too short" never returns fewer nights). Plain words work the same ("Number 2 but somewhere warmer", "Number 1 but make it 6 nights", "I like 3 but it's too expensive", "Anything international?", "Don't spend more than $1,200", "Keep $300 for when I get there"). The budget slider on the canvas (and "don't spend more than $X") rebuilds the three ways at the new ceiling and says what the money really does: an extra night as a proposal, "I would keep the $200" when the dearer versions improve nothing, the same trip kept under a lower ceiling by moving a day, or the compromise it would take; nothing is downgraded silently. "Keep looking" runs another honest round (the length moved a night each way, one rule at a time) and proposes a switch only for a materially better verified trip, else "I checked another round… my recommendation hasn't changed"; a third round says it would repeat. "Why Puerto Rico?" / "Why not Cancun?" answers from the two trips' facts. The canvas carries the mission (budget, travelers, from, status) and "What are you optimizing?": hard rules, preferences, what the agent is free to change. The signature stop when the deep check ends: "I'd stop here. I checked all 11 destinations… 444 complete packages, every combination inside your rules… This is the strongest option I found for your current rules" (never "objectively the best"), with Verify & book and Challenge it again. "I'm happy, stop searching" stops the optional search and lays out the trip for booking. "Remember these as my defaults" (signed in) keeps how you travel (origin, travelers, flight rule, hotel floor, length, bags, flexible dates), never a reaction and never anything about money. **Save Max** (`server/trips/savemax.js`, "Save me the most" on the homepage): the same mission for a saver. "Your maximum, and I'll try not to use it"; the result leads with Your max / We built it for / You keep (max minus the verified total, never a market saving), options named Best value, Lowest I recommend, Keep more comfort (never Best, Premium or Luxury), and the saver's actions: Find $100 (Name your price downward, the compromise named when the target needs one), How low can you go? (the lowest version the agent would still recommend apart from the absolute cheapest found, with the facts of that trip that keep it from being recommended; the cheapest is a choice, never applied), Same trip for less (destination, length and the stay held; dates, fares, like-for-like hotels, room, transport and airport may move), Upgrades worth considering (price breakpoints: where money starts buying something, one priced version per kind of improvement with nothing given up, picked by letter), How did you keep my cost down? (the savings receipt: sequential lines between the versions applied in this conversation, each the live price of one minus the one before, summing exactly; you keep = max minus final), the fare compared with the bag you pack (Looks cheaper / Cheaper overall badge once you say how you pack; "bag fees need verification" when the fare has no fee data), Never cut below (only rules the suppliers' data can check: nonstop, refundable, hotel floor, bags), Balanced or Aggressive (every trade-off still said, hard rules kept), "When can I go for less?" answered without a prediction, and the savings check before payment (the trip priced again and every cheaper version looked for once more; a materially cheaper one with nothing given up is a decision before the contract). Remembering a saver's habits is a savings style: how they pack and travel, never income, hardship or creditworthiness |
| `/plan` | One question at a time: budget, then "Is that just the booking, or the whole vacation?" (money protected for after you land, your number, never a suggestion), departure city, travelers, dates, style, what matters most |
| `/trips` | Three trips, never hundreds: Our pick, Save more, and Upgrade only if worth it (shown only when more money buys something real without giving anything up; otherwise "keep your money" with what we considered), each with its verdict; "You gave us / We need / You keep"; "Our call" (the one we'd book, what almost won and why, what would change our mind); flexibility toggle; why we didn't pick the cheapest; no dead ends (change dates, shorten the trip, another destination, allow up to 10% more, protect less, ask a specialist); when a reserve is protected and nothing fits, the budget collision is spelled out (vacation budget, reserve, what is left for the booking) and "One rule away" re-runs the search with exactly one rule relaxed at a time, offering only the relaxations that really produce a trip, at its real price, and naming the ones that don't get there alone; Save more says why it is cheaper than our pick (each price line that differs, what it gives up from the facts, or that the data shows no trade-off); when nothing fits, what blocks it: the cheapest priced trip line by line, and which line alone is more than the budget (or how much of it the largest line takes) |
| `/trip/:token` | The trip: verdict (Great fit / Good fit / Budget fit / We'd keep looking, biggest win and compromise, what we'd actually do), the main actions (Make it cheaper, Make it better, Change one thing, Compare, Step by step, What am I paying for?, Strip it down, Find my biggest money leak, Make it more memorable, Why this trip is built this way, which opens the receipt when the link carries your goals and otherwise asks what you want to remember), budget meter, Your money, the whole vacation (the booking as known and paid today, the reserve as yours and untouched, what is left unassigned, what you arrive with as a whole-dollar planning figure per day that we never call enough; optional items at the customizer's real prices; what we don't put a number on), Get me back to my price, budget unlocks (what a little more buys), Make it better for the same money, Protect the magic (lock hotel, flights or dates and optimize the rest; a lock is never silently broken), Your time there (usable vacation time from the flight schedule, weekdays away as PTO days with cheaper or same-price versions that keep a PTO day, Get my day back), recipe, customizer (every change re-priced; each included experience has "Protect this experience", which carries `px=` so no version offered leaves it out, and a protected one shows as MAIN EXPERIENCE 🔒 PROTECTED with Unprotect; only one is protected at a time, so while one is, another's link reads "Protect this instead" and names the one it replaces, and the page it opens says "<new> is now the experience I protect; <old> is no longer protected"), Make it cheaper one change at a time, Name your price, Know Before You Book (each part's free-cancellation cutoff dated from the supplier's stated hours), scorecard, trade-offs |
| `/trip/:token/optimize` | Before and after: the strongest alternative package at or under the current total (or the budget) with the locked parts held fixed, or an honest "this is already the best version" |
| `/trip/:token/price` | Name your price: a number lower than the total, and we search downward (hotel, flight, dates, nights, extras) for the cheapest version that is still a strong trip. Three honest outcomes: "we got there"; "we can make it cheaper, we don't think we should" (the floor, the value cliff, and your price anyway with what it means); or "no version gets there" with real next moves. The value ladder shows every rung and its trade-offs |
| `/trip/:token/guide` | Your trip, step by step: a first-trip guide built from the trip itself (before you leave, the airport, bags, security and boarding, your connection, arrival, your hotel, your experiences, going home), each line marked "We know this", "Check required" or "General guidance"; it says what it doesn't know instead of guessing |
| `/trip/:token/leaks` | The Money Leak Hunter ("We don't just find cheaper. We find what you don't need to pay for."): what am I paying for? (every material dollar as a row of a price line, core / mandatory / optional totalled, the rows summing exactly to the total, no mystery line items), You do not need these to book (every optional item with the trip priced in full without it; Remove opens that version, Keep changes nothing, an item a rule you set asks for is listed and never offered), Strip it down (Current / Lean / Difference with the same flights, hotel, dates and nights, What you give up, Customer decides, then Add back what's worth it with Worth considering / I'd keep the $X judged only from what you told us), Remove one thing (the lowest-value optional component, or that every optional item is one you asked for), Find my biggest money leak (the largest avoidable cost, a version with nothing given up always first, a trade-off named only when no free cut exists, Show me the version), Free savings and the trade-off version as two blocks never merged, Cut it in order (an amount to take out, cut in the spec's order one priced change at a time: extras, paid twice, same bags cheaper fare, nearby dates, transport, hotel, flight timing, departure airport, destination, nights; rules and locks never relaxed, every skipped stage says why), Hotel fees (room price + mandatory fees = real hotel total; parking is not in our data), Bags (every fare inside your rules priced with and without a bought bag; one shared bag is not priced), Seats (no seat fee is in the price; sitting together is never claimed), Meals (all-inclusive against breakfast or room only at the same stars or better, only when both are priced; never assumed to save money), Your first night / your last day (from the flight times, the night's real cost, a later or earlier fare priced; nothing removed, never without lodging), Transfers and cars (paying twice: a bought bag on a fare that includes one, a private transfer at a hotel that lists a shuttle; rental cars are not in packages), and Not compared here (booking channels, package vs separate rates, one-way fares, hotel splits, credits and points, currency, promo codes: what the data does not have, so no saving is claimed from it). Every control is a link to a priced version; nothing is removed on the page and nothing optional is preselected |
| `/trip/:token/memories` | Experience Max ("SPEND ON THE MEMORIES. NOT THE LABELS."): WHAT DO YOU WANT TO REMEMBER? (up to three goal chips in ranked order, each a link that changes `mem=`; nothing chosen for you, and nothing is judged until you pick), WHY THIS TRIP IS BUILT THIS WAY (the receipt: your goal, we spent less on, we used money for, each a price line of a priced baseline against this trip's so they add up to the difference; final, your max, keep), YOUR EXPERIENCE BUDGET (the trip's own price lines, summing to the total), THE RHYTHM (a suggested day-by-day rhythm, never the main experience on the arrival or departure day; nothing is booked for a day), HOTEL OR EXPERIENCE? (the cheapest hotel step-up against the best goal experiences not in the trip, both priced in full), MAKE $100 MEMORABLE ($250, $500: every version priced around that amount above the trip, ranked by what it adds to your goals; the pick is the biggest difference that fits your maximum, and a bigger one over it is named as your call, never picked), ONE BIG MEMORY vs MORE THINGS TO DO (both priced; your call), FIND FREE THINGS WORTH DOING (only with the source and the date it was checked, otherwise "no verified free options"), LOCATION, SCHEDULE CONFLICT and GIVE ME MORE FREE TIME (a very scheduled trip says so and offers a priced version with a day opened up), EXPERIENCE LADDER with the MEMORY SWEET SPOT (where I'd stop, under your maximum), SAME FEELING FOR LESS (a different trip with a similar goal, said as different), FIND AN ALTERNATIVE EXPERIENCE (a similar, cheaper one per paid experience, what is similar and what is different, or that none is), PROTECTION (what our data verifies about the trip's own main experience and what needs verification: operating days, age limits, meeting point, transport), the BACKUP for a weather-dependent experience (weather is never guaranteed), FINAL EXPERIENCE CHECK (ok, or the rebuild that passes as a link), MAKE IT BETTER FOR $0 MORE and MAKE IT MORE MEMORABLE, then the signature line. Every amount is the full priced total of the version its link opens, the context (rules, goals, protected experience, promo code, budget, the agent's locks, and the event you built the trip around: `ev=` its date, `evt=` its time only when you said one, `evn=` its name) travels with it; that event is THE RHYTHM's EVENT DAY with no experience on it, and SCHEDULE CONFLICT, PROTECTION and the FINAL EXPERIENCE CHECK read it as the agent does, while one more than 30 days from the trip's dates, or already past, is dropped from every link and said; a different trip drops the protection and says so, and nothing is applied, booked or preselected on the page; every version over your maximum says by how much beside its link, and none is marked as the pick; a protected experience the destination does not offer is dropped from every link and said in words, never as an id; with a promo code the page prices before it and says what it takes off, and its review link names the total with the code, so the review says "still", not "dropped"; dates are written as the rest of the site writes them; hotel stars and brands count only when they serve a goal you named |
| `/compare` | Two or three trips side by side, only the rows that differ, each with its verdict, and where the money goes line by line against the first |
| `/hunts`, `/hunts/new`, `/hunts/:id` | The Savings Hunter (hunt mode: "I can wait. Only come back when my money can do something better."): a maximum, where you fly from, travelers, an optional window and minimum length, hard rules, and what counts as a win (a good trip under the limit, you beat my saved trip, the same trip drops by $X, an extra night without spending more, a nonstop option enters my budget, same money better hotel, a new destination enters my budget) with a threshold ($50+, $100+, $200+, custom, or only what you'd actually recommend). Then "Hunt for a trip". The hunt is re-run on its own schedule while the site runs, and when it is opened if its last check is more than ten minutes old (never implied otherwise: every check is logged with what it priced); nothing qualifies unless the total is inside the ceiling with every hard rule met and the trip is one we would recommend, and nothing is said unless the customer's own trigger fired by at least their threshold (a cheaper trip that gives something up is kept quiet unless they chose Aggressive). Each opportunity is a decision, not a nudge: what was found, the limit, what remains, "this currently meets the rules you gave me", the receipt (your rules, found, why I interrupted you), the previous price only when this platform recorded that comparable search, "current price was verified at" and "price and availability may change" (no countdowns, no "only 2 left", no "book now"). See trip, Keep waiting (always), Not good enough (what should I improve? lower price, better hotel, more nights, nonstop, different destination; the hunt learns for this mission only), Find me something even better (same quality under the next $50 step), Stop. The persistent card: My travel money, status, best current opportunity, potential money kept, last meaningful improvement, last checked. Several hunts per account, each with its own rules. Notifications land on the page, in My Trips and in the outbox (an email once a provider is connected) |
| `/trip/:token/review` | Live price check with explicit approval of any increase; with a reserve, Your vacation plan and "Does the whole trip fit?", and a price rise asks where it should come from (find it in the booking, unassigned money, change the reserve, or don't accept) with an approve button that names any part taken from the reserve; our honest take, Travel reality check (documents, arrival and last day, bags, fees, changing your mind, getting to the hotel, weather) and what's not in the price, final trip review, readiness checklist, promo code, then Your savings check (max budget, current trip, budget not used, or the overrun) and the Money leak check (optional add-ons, paid twice, bags, transport, taxes and fees, the same trip priced lower: "Money leak check complete" with one more optional cost you can remove as a link to that version and Keep it, or that nothing would be removed without changing the trip you approved; "What am I paying for?" folded under the trip), then the quote; with goals or a protected experience on the link, the EXPERIENCE RECEIPT, EXPERIENCE PROTECTION (MAIN EXPERIENCE 🔒 PROTECTED and what is verified or needs verification), the FINAL EXPERIENCE CHECK (ok, or the rebuild that passes as a link that is priced again on arrival) and the "very scheduled" line with a version that opens up a day; "Do I need to decide today?" (nothing holds the price before checkout, the checkout hold and the recheck at payment, what booking today commits you to with each part's dated cutoff and the 24-hour window; no prediction, no countdown) |
| `/dream` | Journey B / Budget Negotiator: a dream destination and a maximum; the gap and the single changes that close it. Also "I have to be there" (a fixed date) and the older "Beat my quote" (`beat=1`, kept for existing links; the homepage now sends people to `/challenge`) |
| `/challenge`, `/challenge/review`, `/challenge/result` | Trip Challenge: bring the trip you found (destination, origin, dates or unknown, nights, travelers, their total, and what it includes: flights, hotel class, meals, bags, transfer, cancellation, taxes, each with Unknown; optionally one of our hotels to keep). The trip to beat shows every unknown as unknown, never guessed. Make it a fair fight: our version carries everything theirs is known to include and our price always has taxes, fees and the service fee inside. Five modes (Same trip for less, Better trip same money, More vacation same money, Easier trip, Surprise me), "Don't touch these" locks, a scoreboard row by row, and one of four verdicts: We beat it, We found a different trade-off, Your deal wins, We need more information (any unknown means no win is claimed). Challenge receipt (kept, changed, still unknown, you keep $X only on a win or trade-off), why we won (our money by line, never their breakdown), why their deal is better (the cheapest comparable version's lines, never an invented reason), the $100 more (an improvement with nothing given up within $100 of their price, else "keep the $100"), Save me $100 (Name your price), Keep my deal always. Share-safe: the result URL holds only what was typed |
| `/checkout/:quoteId`, `/booking/:ref` | Traveler details and test-mode payment, with the vacation plan beside what is paid today; the trip page after booking (the saver victory screen when a maximum was given: You gave us / Your trip / You kept, And you kept with only the stated asks the booked trip's facts meet, an unmet ask under Not kept, or "You went over by $X, which you approved"; what was protected for the destination and the per-day figure, untouched by the booking (Trip ID, per-component confirmations, what the booking covers, leaves out and what we never price, support thread, cancellation with the full-refund window dated 24 hours after booking and each part's dated cutoff, the same cutoffs the refund follows); "Ask your travel agent" hands the booking to the same agent, which answers from the booking's facts (what's next, what a cancellation refunds today, what one more night prices at, flight changes) and says "I don't know yet" otherwise; opened on a booking, the agent's canvas is its home for that trip (today, next, trip status, remaining trip money, next reservation, important actions) from the booking's own facts and the suppliers' dated cutoffs, with nothing counted down or invented; My Trips carries the same "Ask your travel agent" on every live booking; after the trip (the day after the return flight, for a confirmed booking) WHAT WAS ACTUALLY WORTH IT? asks with chips (Hotel, Food, Main experience, Free time, Nightlife, Location, Other) as worth it or not, nothing preselected, plus your own words: the answer is kept on the booking, and goes into the account's travel defaults only when "Remember this for next time" is ticked by the signed-in account that booked it (the box and its promise are shown only to that account; a booking made without an account is told plainly that remembering needs an account that owns the booking); an answer from this booking saved earlier follows the latest answer (replaced when ticked, removed when not), and the page says what was kept, where, and what happened to the earlier one |
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
  strategies.js         one number, three vacations: More vacation / Keep more / Make it special, the
                        direction pushed, a different set, mixing two versions, the budget moved
  savemax.js            Save Max: how low, price breakpoints, the cheap-trap check, the savings receipt,
                        the savings check before paying, the lowest trip still recommended
  experience.js         Experience Max: the memory goals and their scores from the trip's facts, the
                        experience receipt and budget, the rhythm, hotel or experience, make $X memorable,
                        one big memory or more things, free things with a source, location, schedule
                        conflicts and fatigue, the experience ladder and sweet spot, same feeling for
                        less, alternatives, protection and backup, the final check, what was worth it
  weeks.js              the same trip on every other departure date searched: the cheapest strong
                        week and the range the priced windows cover, today's prices only, no forecast
  hunter.js             the Savings Hunter's engine: one run of a hunt (every length and destination
                        inside the rules and the ceiling, the challenger pass, the quality floor and gate),
                        the triggers the customer chose, the decision text and the receipt
  hunts.js              hunts as records: create, re-run on open and on the scheduler, notify once per
                        opportunity, keep waiting, not good enough, even better, stop; what each hunt learned
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
returns none simply hides those facts); the Trip Challenge compares like for like, claims a win only when every stated attribute is known and nothing is worse, and says "your deal wins" when we can't beat a price. The budget is a ceiling, not a target: "Our pick" is the
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

### The travel agent's language layer

`server/agent/understand.js` is a rule-based provider: it turns a message into structured updates to the trip object (money, people, places, dates, rules, locks) and a list of intents, and admits what it did not understand instead of guessing. It never produces a travel fact. A model-backed provider can replace it behind the same contract (the same updates and intents, with the model key read from the environment on the server and never in code), and the engines still do all searching, pricing, comparing and booking: the language model is never trusted with a price, an availability, a rule, a saving or a verdict. `server/agent/state.js` is the canonical trip object (the conversation is never the only source of truth), `server/agent/jobs.js` runs a build in real phases, and `server/agent/agent.js` is the tool router.

### Roadmap (phased, behind feature flags)

The MVP above is the production-ready first pass. Everything else from the product spec is a later
phase, to be added behind its own flag once real suppliers are connected:

- Trip Companion after booking (today's view, itinerary, remaining vacation budget, daily spending, plan B, offline essentials, packing, airport/arrival/check-out modes, spend review).
- Trip Simulator and budget intelligence (what should my budget be, price drivers, destination cost index, hidden-cost detector, stress test, trade-off lab, diminishing-returns curve, "my perfect number").
- Full Budget Negotiator (lock components, no-compromise mode, dream tracker, "it's possible" alerts, flexibility currency, travel goals) on top of today's `/dream`.
- The travel agent, later phases (today: the conversation and canvas at `/agent`, the rule-based language layer, fast-then-deep builds with real progress, proposals and approvals, the conversational challenge with its one-at-a-time questions, the one-more-compromise menu, the agent's home after booking and the agent inside My Trips, the mission from one number with its three ways built first from the likeliest destinations while every other destination tries to beat them (a way is replaced only by a materially better verified trip, and the replacement is said as what stays the same, what gets better and what it costs), reactions, pushed variants, mixing only when two versions can be one trip, budget slider, decision feed and signature stop, the "one decision away" interrupt (two priced trips within $50 trading exactly one thing, the traveler's call), watches set from the conversation with the traveler's own rule (drop by $X, any drop, under $X; re-priced when My Trips is opened and silent otherwise), "when can I go for less?" and the cheapest strong week for a flexible month answered from today's prices on the other departure dates searched, never a forecast, and Save Max with how low, breakpoints, the receipt, the cheapest trip still recommended as "Lowest I recommend" and the savings check; the Savings Hunter at `/hunts`, started from the saver canvas with "Hunt for a better deal" or in words, the customer's own triggers and threshold, silence otherwise, every check logged, and the hunt's learning for this mission only): a model-backed language provider behind the same contract (structured updates only, never prices); link and screenshot import for "can you beat this" (always followed by "confirm the extracted details"); exact-match watches; email alerts for watches and hunts once notifications are connected (today they land in the outbox, on the page and in My Trips); hunts that re-price while the site is down (a job queue outside the process); supplier change alerts on the home after booking once real suppliers report them; voice input. Honesty rules carry over: no invented facts, no silent relaxations, no action without approval.
- Trip Challenge, later phases (today: `/challenge`, the structured challenger, five modes, locks, scoreboard, four verdicts, receipt, the $100 more): link, screenshot and free-text import of the competitor's trip (OCR or extraction, always followed by "confirm the extracted details"; nothing extracted is trusted silently); challenge history with "which deal should I actually book" from the saved comparisons; a saved re-challenge and "don't contact me until you beat this" watches (alerts only when the beat-by rule is really met, never a meaningless nudge); public challenge cards and friend challenges (no private booking information on the card); creator challenges (no implied endorsement without authorization); a one-line hotel or flight challenge. Honesty rules carry over: like for like only, unknowns stay unknown, the platform is allowed to lose.
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
- The Money Leak Hunter, later phases (today: `/trip/:token/leaks`, the review page's money leak check and the booking page's victory screen, the agent's paying / strip / add back / remove one / biggest leak / leak scan / cut in order / free savings / scorecard flows, every number a priced version and every removal the traveler's own click): a booking-channel comparison (booking each part elsewhere) once a second channel's prices are in the data; package vs separate rates once a supplier quotes a package rate apart from its parts; one-way fare structures (two one-ways, open jaw) once one-way fares exist; hotel splits (two hotels in one stay) priced as one trip; credits, points and loyalty applied at the traveler's own stated value, never ours; currency conversion with a dated rate the traveler can see; rental cars inside trip packages compared with the transfer; and a hotel stay that starts on arrival day when the flight lands the next morning, so the first night is not paid for. Until each exists the page says "not in our data" and claims no saving.
- Experience Max, later phases (today: customer level 4, the homepage's MAKE IT MEMORABLE / BUILD ME AN EXPERIENCE, `/trip/:token/memories`, Protect this experience on the trip page, the review page's experience receipt, protection and final check, and the booking page's WHAT WAS ACTUALLY WORTH IT?): the hotel's distance to each experience and its meeting point, operating days, age limits and current restrictions, room categories (a view or a higher floor priced as its own version), a second activity supplier so an alternative experience can come from elsewhere, weather data beyond the demo climate notes (never a guarantee), and real free-attraction sources with their own checked dates. Until each exists the page says "not in our data" or "needs verification" and never builds the trip around it.
- Customer levels 2 and 3: Value Max (BEST VALUE) and Comfort Max (MAKE IT EASY) await their own specs; today BEST VALUE is the mission as it is, and MAKE IT EASY is the way in that starts the mission in `easy` mode; Comfort Max itself is not built yet.

From the fifth spec (Trip Reality Builder to Trip Proof), later phases behind their own flags. Its
core-journey asks are in today's pages (booking budget vs whole vacation, the vacation picture with
known / optional / reserve rows, "does the whole trip fit?", no silent reserve raid, the budget
collision and "one rule away", dated cancellation cutoffs with "do I need to decide today?", what the
booking covers after payment, why Save more is cheaper and what blocks a no-fit search). The rest
waits for data we don't have or belongs after booking:

- Trip Reality Builder, the rest: budget envelopes (food, transport, experiences, shopping, cushion) with "help me set it up / I'll set it myself", a budget style (simple, moderate, splurge on a few things) as a trip preference, auto-build from travel questions labeled "suggested planning estimate", experience protection locks ("the whole reason I'm going is to scuba dive"), a stress test before payment, and "cheap to book vs cheap to be there" comparisons (all-inclusive vs room-only, central vs far hotel) once real on-ground and transport numbers exist. We never infer what amount is appropriate, never show a per-day figure as a verdict, and never pretend every traveler spends the same.
- Daily Spend Navigator (after booking): the protected money as a daily plan the traveler edits (fixed vs flexible, pace, "what's left for today"), adjustments after a splurge, group splits, refunds back into the plan. It is a planning helper, not banking: no bank links, no credit language, no scoring, and every number is the traveler's own or a receipt they entered.
- No-Car Vacation Engine: "can I do this trip without a car?", walkable-vs-transit-vs-rental comparison, true ground cost, and hotel placement that removes the car, once transit, walkability and parking data exist for the destination. Until then the trip page says only what it knows (the transfer, the hotel area).
- Vacation Composer: several trips in one plan (a travel year, a long trip in legs) with one money and PTO ledger, trade-offs between trips, and "lock this one, build the rest"; shares the Build My Travel Year flag.
- Trip Booking Order: which part to book first, what each part locks, verified deadlines only (a hotel's free-cancellation date, a fare's hold), no countdowns or invented urgency, and "what happens if I wait" from real re-pricing. Today every part is booked together, and each part's free-cancellation cutoff is dated from the supplier's stated hours on the trip, review and booking pages, with the 24-hour full-refund window dated after booking; the refund follows the same cutoffs, and the review page answers "do I need to decide today?" without predicting prices.
- Travel Re-entry: a gentle first-trip-in-years mode (what changed, document checks, slower pacing) built on the step-by-step guide; it never invents rules and marks anything unverified.
- Trip Constraint Solver, the rest: several rules relaxed together with the least-painful combination, "which rule is costing me the most" from real re-runs, a rules board with never / last / flexible / don't care tiers. No fake solution: nothing is offered that was not priced. Today: one rule away, and what blocks the search from the cheapest priced trip's own lines.
- Trip Contrarian (second opinion): "before you book, one thing we'd reconsider" from real alternatives (dates, hotel tier, nonstop, car, nights, airport), always concrete ("two days later is $380 less"), never a lecture, with "don't agree with me" as a first-class answer. Only when a comparable alternative was actually priced.
- Trip Price Doctor: "what is making this trip expensive" as the price of each preference (nonstop, 4-star, beachfront, breakfast) from comparable priced options, the one-change cure before five small downgrades, a pain order (never / last / flexible), and a price leak detector that never labels a required fee as a leak. Partly covered by Name your price and the value ladder today.
- Trip Readiness (after booking): "booked ≠ ready", documents, transit, activities, ground transport, payment, bags, arrival and events as ready / needs verification / action required, with a pre-departure timeline of only relevant tasks. Never a score, never "you will make the connection" or "you are guaranteed entry". Today: the booking page says what the booking covers, what it leaves out, what we never price, and which part is still to confirm.
- Trip Scenario Studio: "what if" as named scenarios beside the current trip (never destroying it), the change breakdown (what you gain, what you lose, why the total moved, the ripple through dates, PTO, hotel and transfer), undo and history, lock-and-rebuild, best single change. Today the customizer, compare and Protect the magic cover one change at a time.
- Trip Memory Vault: explicit rules the traveler saved ("make this a rule", just this trip / default / ask me each time), contextual profiles (solo, couple, family), regret and success memory from a few post-trip questions, trip recipes and "same recipe, new place", a control center that shows and deletes every rule, memory expiration. No hidden memory, no inferred profile, no "you always prefer".
- Vacation Auction: priorities compete for the budget (hotel, nonstop, nights, location, food, experiences, keeping money), money locks, "give the trip $100 / take $100 away", a pressure test that finds the natural price floor, couples and group auctions with private budgets shown as ranges. Keep-money always competes; the reserve is never used to make a booking fit without permission.
- Trip Proof: the recommendation receipt (why we picked it, why it beat the others, what it sacrifices, what would change our mind), every fact labeled by evidence type (live supplier data, current search, provider information, public rating, estimate, customer preference, platform calculation, needs verification) with its freshness, "prove the savings" with a comparability check, and "what's the catch" that says "we didn't find a major trade-off in the data currently available" rather than inventing one. Today: Our call, why not the cheapest, what would change our mind, the scorecard and the trade-offs, Save more's "why it's cheaper than our pick" (where the money differs, what it gives up, or that the data shows no trade-off), where the money goes on compare, with demo data labeled demo and prices checked at the review page.

## Tripelyx Business

Company travel workspaces under `/business`: a company signs up, sets its travel policy, departments and
budgets, invites its people, and its travelers plan work trips that are checked against the policy as they
search and go to their manager when they need approval. Finance sees reports and a CSV. Nothing is booked
or charged: an approved trip is approved to book, and booking is not open yet. No emails are sent; invites
are copy links. Outside production every flight, hotel and price is demo data, labelled as such on every
page; production has no supplier yet, so trip planning says "Supplier not connected yet" while sign-up,
people, policies, budgets and approvals still work.

| Route | What it is |
| --- | --- |
| `/business` | The Business page (company page; sign up or sign in from it) |
| `/business/start`, `/business/signin` | Create a company (its first account becomes the Owner), sign in |
| `/business/invite/:token` | An invite link: sign up or sign in, then join the company |
| `/business/app` | Your companies (straight to the company when there is one; the switcher is in the header) |
| `/business/o/:orgId/...` | The workspace: home, trips, approvals, policies, people, budgets, reports, activity, settings, as the member's role allows |
| `/admin/business` | Platform admins only: every company, and confirming a new one |

### Switches

Every setting is in `.env.example` with its default.

| Variable | Default | What it does |
| --- | --- | --- |
| `ENABLE_BUSINESS` | `false` | Turns Business on. With it off, every other page is exactly as it was before Business. Works with `ENABLE_TRIPS` on or off. |
| `BUSINESS_SELF_SERVE` | `false` | `false`: a new company waits until a platform admin confirms it at `/admin/business` before anyone can join it. |
| `BUSINESS_INVITE_DAYS` | `7` | Days an invite link stays usable. |
| `BUSINESS_MAX_ORGS_PER_USER` | `3` | Companies one account can create or join. |
| `BUSINESS_APPROVAL_HOURS` | `24` | Hours a request waits for a decision before it expires, for new companies (each company picks 4 to 168 in Settings). |
| `BUSINESS_WRITE_LIMIT`, `BUSINESS_COMPUTE_LIMIT`, `BUSINESS_AUTH_LIMIT` | `300`, `30`, `20` | Business's own rate limits: writes per user per 10 minutes, searches and decisions per user per minute, sign-up and sign-in attempts per IP per 10 minutes. |
| `BUSINESS_EXPLAINER` | `rules` | What writes the notes beside cheaper alternatives. Only `rules` exists: rule-based, and no trip data leaves Tripelyx. |
| `ALLOW_DEMO_INVENTORY` | `true` outside production | Business's demo flights and hotels need it. Without it (production), there is no supplier. |

### Platform admins

An account opens `/admin` and `/admin/business` only when its email is in `ADMIN_EMAILS` **and** it has an
active `platform_admin` record for that email. Adding an address to `ADMIN_EMAILS` alone gives nothing.

- **One-time grandfather seed.** The first boot after this change writes a grandfather list once (the
  `platform_admin_seed` record `v1`, insert-only): the `ADMIN_EMAILS` accounts that already existed and were
  created before `2026-10-08T00:00:00Z`. Those accounts get their record at that boot (granted by
  `legacy-email-match`), so existing admins keep `/admin`. No later boot grants anyone else: an address added
  to `ADMIN_EMAILS` later, or an account signed up with a listed address, needs a grant. Removing an address
  from `ADMIN_EMAILS` takes access away at the next restart; a revoked record stays revoked.
- **`scripts/platform-admin.js`** grants and revokes records on the site's own database (configured exactly
  as the server reads it: `DATABASE_URL` or `DATABASE_HOST`, `APP_ENV`, `ADMIN_EMAILS`). It refuses the
  in-memory store.

  ```sh
  node scripts/platform-admin.js list                                   # every listed address and where it stands
  node scripts/platform-admin.js grant --email ops@example.com          # the address must be in ADMIN_EMAILS and have an account
  node scripts/platform-admin.js revoke --email ops@example.com --sign-out
  ```

  On AWS, run it as a one-off task of the admin task definition (family `tripelyx-<env>-admin`, container
  `admin`, never the site's own task definition) and read its output in the task's log stream; see
  [One-off admin tasks](#one-off-admin-tasks).

### The demo

`scripts/business-demo.js` fills the in-memory store with two fictional demo companies, through the same
service the pages use, so you can click through every role:

```sh
APP_ENV=development node scripts/business-demo.js --port 4400 --production-preview 4401
```

It runs only with `APP_ENV=development` on the in-memory store (no `DATABASE_URL`, or `DATABASE_URL=memory`)
and refuses anything else. It starts the app in the same process with Business on and prints every demo
account (email, role and company) to sign in as at `http://127.0.0.1:4400/business/signin`, and a link to
each test scenario's page. Every demo account's password is
`preview-only-password`. `--production-preview 4401` also starts the production configuration
(`APP_ENV=production`, no supplier, trips off, an empty in-memory store) on a second port, with HTTPS
forced off so it opens over plain http on your computer only; sign up a company there to see
"Supplier not connected yet".

What it seeds:

- a platform admin: the first `ADMIN_EMAILS` address (`platform.admin@tripelyx-demo.example` when unset),
  given a `platform_admin` record;
- **Demo Company (preview)**, confirmed: `owner@`, `travel.admin@`, `finance@`, `sales.manager@`,
  `engineering.manager@`, and four employees (`eli.employee@`, `emma.employee@`, `ezra.employee@`,
  `esme.employee@`), all at `demo-company.example`; Sales and Engineering with budgets for the quarter;
  the Standard policy plus a Cairo to London route exception and the demo airline ZS blocked (each only when
  the inventory lists those airports and that airline);
- only when Business prices come from demo data, trip requests in every state: approved by policy, waiting, approved by a manager after a swap, denied,
  cancelled (its budget hold released), waiting with the manager's question, and a draft with cheaper
  alternatives; and two test scenarios whose purpose starts with "Test scenario": one whose approval window
  ran out (made under a clock set two days back, so it shows Expired) and one sent back because its hotel
  price changed (one demo hotel room on those dates prices $29 more, and the log says so). On any other price
  source (the private preview on supplier test keys, or no supplier) it makes no trips, so it never calls a
  supplier, and the log says why;
- **Second Demo Company (preview)** (`owner@second-demo-company.example`), which shares Eli, so the company
  switcher has two companies.

The private preview's boot hook (`PREVIEW_SEED=business`, on an in-memory staging app with Business on)
calls the same `seed()` from this file, with the app and its config. The demo accounts then use the
preview's own password: `config.preview.password` when the config carries one, else `PREVIEW_PASSWORD` when
its SHA-256 matches the preview gate's digest (`config.preview.gate.passwordDigest`), else
`preview-only-password`. The platform admin is the first `ADMIN_EMAILS` address; the preview workflow always
sets it to the demo address `platform.admin@tripelyx-demo.example`, never a real one. `seed()` logs every demo account with its role and company, and the path of each test
scenario, so the preview log says who to sign in as. It throws on any store but the in-memory one and in
production, and never logs a password.

## Pages

| Route | What it is |
| --- | --- |
| `/` | Corporate homepage, with or without Travel by Budget (`/company` redirects here) |
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

### Tripelyx Business: real suppliers (round 1)

Business workspaces (`ENABLE_BUSINESS`) can search a real flight supplier (Duffel) and hotel supplier
(LiteAPI) instead of demo data. Round 1 uses their **test systems only**; nothing is booked or charged.
These suppliers serve Business only: `/book`, `/` and the rest of the site never use them.

- **Settings** (all in `.env.example`): `BUSINESS_FLIGHT_SUPPLIER=duffel` with `DUFFEL_ACCESS_TOKEN` (a
  `duffel_test_` token), `BUSINESS_HOTEL_SUPPLIER=liteapi` with `LITEAPI_API_KEY` (a `sand_` key; hotels need a
  working flight supplier), `BUSINESS_ALLOW_SUPPLIER_TEST` (true by default only in development, so every
  deployed stack switches test data on by hand), `BUSINESS_GUEST_NATIONALITY`, `BUSINESS_SUPPLIER_CACHE_SECONDS`,
  `BUSINESS_SUPPLIER_COMPANY_CALLS_PER_HOUR` and `BUSINESS_SUPPLIER_VARIANT_SEARCHES`.
- **Keys only from the environment:** GitHub secrets for CI and for the private preview (its workflow writes them
  into the Lightsail container's settings, see [Private preview](#private-preview)). No key
  is ever in the repo, a log, an error page or `/api/config` (test fixtures use placeholders such as
  `duffel_test_PLACEHOLDER`).
- **A bad setting never stops the app.** A missing key, a key that is not a test key, an unknown supplier name or
  a number out of range switches the suppliers off: Business shows "Supplier not connected yet" and
  `/admin/business` tells platform admins which variable to fix, without its value. It never falls back to demo
  data.
- **Labels.** Every amount says where it came from. Demo data keeps "Demo price". Supplier test data says
  "Supplier test data, not a real fare" (hotels: "not a real room rate") with a dashed outline and a TEST DATA
  tag, the workspace ribbon says the prices are test data, an approved test trip says "Approved (test data).
  Nothing was booked.", and budgets, reports and home say "Includes supplier test data" when any request they
  count was priced that way. The CSV export's `price_source` column says it per request. A request keeps the
  source it was priced from; requests made before this change read as demo.
- **Honest failure.** A supplier that fails never serves demo or stale data: the page says flights or hotels
  are not available right now (hotels failing still lets the traveler request the flights), and a price check
  that cannot run at submit or decide changes nothing ("The price couldn't be checked just now, so nothing
  changed."). The approver's page always opens; its price is checked again when they approve.
- **In-memory limits.** The supplier call counters (per company per hour), the circuit breaker and the short
  result cache live in memory per running task, like the other Business rate limits: a restart resets them,
  and each task counts on its own.

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
  and the app receives it at start-up; it never appears in GitHub or in the image. Deletion protection
  and 14 days of backups are on in every environment (see [Protecting the database](#protecting-the-database)).
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
with its own database (Multi-AZ). `CERTIFICATE_ARN` is an ACM certificate for
your domain, which turns on HTTPS. Then point the domain at the load balancer with a CNAME.

**www.tripelyx.com is the `tripelyx-staging` stack**, with `APP_ENV=staging` on purpose: in production
every vertical is off by default. "Staging" here names the live site, so keep the `staging` default in
`deploy.yml` (a static test pins it) and never point another experiment at that stack.

Staging runs demo inventory with `PAYMENT_MODE=test`, so it is safe to share. A staging stack
costs roughly USD 40 to 50 a month (load balancer, a small database, one small container). If a
first deploy fails, delete the `tripelyx-staging` stack in CloudFormation before running it again
(turn off the database's deletion protection first: RDS console, **Modify**).

#### Repository settings the deploy reads

- `ENABLE_BUSINESS` (variable, default `false`): Tripelyx Business on or off. The deploy job's first step
  trims and lowercases it; any value but `true` or `false` stops the run before the build with
  "ENABLE_BUSINESS must be true or false (lowercase).", so a typo never reaches CloudFormation (which
  allows exactly those two and would block every later deploy).
- `ADMIN_EMAILS`: a repository **secret**, never a variable. The repository is public and so are its run
  logs; a secret is masked in them, a variable prints in clear. The workflow still reads
  `secrets.ADMIN_EMAILS || vars.ADMIN_EMAILS`, but when only the variable is set the first step stops the
  run before anything prints it ("ADMIN_EMAILS is set as a repository variable..."): move the addresses to
  the secret and delete the variable. A variable of that name must never hold real addresses.
- `PUBLIC_BASE_URL` (default `https://www.tripelyx.com`), `APP_ENV`, `CERTIFICATE_ARN`, `AWS_ROLE_ARN`,
  `AWS_REGION` as above.

Every deploy also prints, before and after "Deploy the stack", the status code and sha256 of `/`, `/book`
and `/ai-travel-agent` (with the `?v=` asset versions removed), read through the stack's own `SiteUrl`
output, and "same" or "changed". After the deploy it opens `/healthz` and, with Business on, `/business`
and a Business 404. A page that answers anything but 200, or another status than before the deploy, gets
a "Page status" warning. It only reports: the run turns red when `/healthz` does not answer 200 or a
Business page shows demo wording or the environment banner, and it never undoes anything. It prints status
codes and hashes only.

A second run on the same commit (the flip, the undo, **Re-run jobs**) reuses the image that commit already
pushed to ECR instead of building it again: the repository's image tags are immutable, so a rebuild under
the same tag would be refused.

#### Tripelyx Business on www: dark deploy, flip, undo

1. **Stack policy first.** After the change set preview and before the merge, apply the stack policy
   ([Protecting the database](#protecting-the-database)). The dark deploy is the first update
   CloudFormation makes to the database, so it already runs with the database protected against an
   unexpected replacement. The policy allows in-place changes, so it does not stop that deploy.
2. **Dark deploy.** Merge with `ENABLE_BUSINESS` unset, so Business is off. Add the secret `ADMIN_EMAILS`
   in the same sitting, never earlier: until this code runs, the site's `/admin` check is the email alone
   (see [Platform admins](#platform-admins)). The page hashes of
   `/`, `/book` and `/ai-travel-agent` should read "same", with no "Page status" warning. Then run `list`
   on the admin task ([One-off admin tasks](#one-off-admin-tasks)).
3. **The flip.** Add the repository variable `ENABLE_BUSINESS` = `true` (lowercase), then run
   **Actions → Deploy to AWS → Run workflow**. A variable reaches the site only with a deploy. Only the
   container's environment changes; the check step then also opens `/business` and a Business 404. The
   three pages above now differ by the approved "Business" header item and trip footer link only, so
   they read "changed"; a "Page status" warning means a page answered something other than 200.
4. **Undo.** Set `ENABLE_BUSINESS` to `false` and run the deploy again. Company data stays in the
   database. A failed deploy rolls itself back (ECS circuit breaker, then CloudFormation).
5. **Never undo with a git revert.** A revert would bring back the older email-only `/admin` check while
   `ADMIN_EMAILS` is set, and turn the database's deletion protection off. If code ever has to be
   reverted, keep the accounts code, `ProtectDatabase`, the admin task definition and every secret
   resource, and remove `ADMIN_EMAILS` first.

#### Protecting the database

- **`ProtectDatabase`** (stack parameter, default `true`) turns on deletion protection and 14 days of
  automated backups whatever `APP_ENV` is (production always has them). Both change in place, with no
  replacement and no outage (RDS only has an outage when backups go from 0 days to some or back).
  `deploy.yml` does not pass it, so every deploy keeps the stack's current value. Set it to `false` only
  when deleting a stack on purpose: one update with `ProtectDatabase=false`, then the delete.
- **The stack policy** `infra/www-stack-policy.json` denies `Update:Replace` and `Update:Delete` on the
  `Database` resource and allows every other update. With it in place, a deploy whose change set would
  replace or remove the database fails and rolls back, and the database stays as it is. The deploy role
  cannot set it: it is applied once after the change set preview and before the merge that brings this
  code (so the dark deploy already runs under it), by whoever runs the go-live (with the owner's
  approval), and again each time the file changes (later stages add their secrets to the deny list):

  ```bash
  aws cloudformation set-stack-policy --region us-east-1 --stack-name tripelyx-staging \
    --stack-policy-body file://infra/www-stack-policy.json
  aws cloudformation get-stack-policy --region us-east-1 --stack-name tripelyx-staging   # check it
  ```

- **A deliberate database migration** (a change that replaces the instance) overrides the policy for one
  update only, never through the deploy workflow (`aws cloudformation deploy` has no override, so a
  deploy can never replace the database). With the owner's approval: take a manual snapshot, plan how the
  data moves (a replacement starts a new, empty instance; `UpdateReplacePolicy: Snapshot` keeps a snapshot
  of the old one), then run one update with a temporary policy. Every parameter keeps its current value
  except what the migration changes:

  ```bash
  aws cloudformation update-stack --region us-east-1 --stack-name tripelyx-staging \
    --template-body file://infra/app.yaml --capabilities CAPABILITY_IAM \
    --role-arn arn:aws:iam::<account id>:role/tripelyx-cfn-execution \
    --parameters ParameterKey=AppEnv,UsePreviousValue=true ParameterKey=ImageUri,UsePreviousValue=true ... \
    --stack-policy-during-update-body '{"Statement":[{"Effect":"Allow","Action":"Update:*","Principal":"*","Resource":"*"}]}'
  ```

  The stored policy applies again to the next update without being set again.

#### One-off admin tasks

`AdminTaskDefinition` (family `tripelyx-<env>-admin`, container `admin`) runs the same image as the site
with `node scripts/platform-admin.js list` by default. It gets `APP_ENV`, `ADMIN_EMAILS` and the
database settings, the database secret and nothing else; it has no task role (so no AWS credentials)
and its own execution role, which can only pull the image, read the database secret and write its own
log streams. Every one-off task runs on it, never on the site's task definition, so a mistaken command
can never print a key the site holds. On the web service's network:

```bash
NET=$(aws ecs describe-services --region us-east-1 --cluster tripelyx-staging --services web \
  --query 'services[0].networkConfiguration' --output json)
aws ecs run-task --region us-east-1 --cluster tripelyx-staging --task-definition tripelyx-staging-admin \
  --launch-type FARGATE --network-configuration "$NET" \
  --overrides '{"containerOverrides":[{"name":"admin","command":["node","scripts/platform-admin.js","list"]}]}'
```

Its output is in the log group `/tripelyx/staging`, in the stream `admin/admin/<task id>`.

### Private preview

A password-protected copy of the site with Tripelyx Business switched on, on its own small AWS service and
its own address (`https://tripelyx-preview.<id>.us-east-1.cs.amazonlightsail.com`). It is for clicking
through Business before it goes anywhere near the live site: tripelyx.com, its load balancer, containers,
database and DNS are never touched, and Business stays off there.

- **What runs:** the same Docker image as the live site, with `APP_ENV=staging`, `DATABASE_URL=memory`
  (data lives in memory only), `ENABLE_BUSINESS=true`, demo inventory (or the suppliers' test systems, see
  **Supplier test keys** below), `PAYMENT_MODE=test`, and the demo companies from `scripts/business-demo.js`
  when that script is in the build (`PREVIEW_SEED=business`; on supplier test keys, without trips).
  Nothing is booked or charged and no email is sent. **Test data starts fresh with every update.**
- **The password:** every page asks for it (HTTP Basic auth, any user name); only `/healthz` is open, for
  the health check. Search engines are told not to index anything. After 10 wrong passwords from one
  address, that address waits out the rest of a 15-minute window. The password is generated by AWS Secrets Manager when the stack is
  created; it is not in the repository, the image or any log. Production refuses `PREVIEW_PASSWORD` and
  `PREVIEW_SEED` at start-up.
- **Cost:** about USD 10.50 a month: the Lightsail container service at power micro with one node is USD 10
  a month (500 GB of data transfer included), the password secret USD 0.40 a month, and the last 5
  preview images in Amazon ECR a few cents of storage.
- **Updates:** every push to `claude/travel-by-budget-uv85qf` runs the tests, then
  `.github/workflows/preview.yml` builds the image, pushes it to the `tripelyx-preview` registry and
  deploys it to the `tripelyx-preview` service. It never runs on `main` and never uses the live site's
  deploy role; it signs in as `tripelyx-github-preview`, which only this workflow on that branch can use.
  The run summary shows the address. Until the stack below exists, the workflow ends with a notice saying
  so and deploys nothing.
- **Running it again without a push:** open the latest **Private preview** run in the Actions tab and
  choose **Re-run all jobs**. It runs the same commit on the same branch, and reads the password fresh
  from AWS. GitHub allows re-runs for 30 days after a run; after that, push to the branch, or, from a
  computer with the GitHub CLI, run `gh workflow run preview.yml --ref claude/travel-by-budget-uv85qf`
  (this works once the workflow has run at least once). GitHub only shows a **Run workflow** button for
  workflows that are on the default branch (`main`), so this one has none while it lives on the
  development branch.

**One-time setup (about 10 minutes, AWS account 957123506077, `us-east-1`).** Create the
`tripelyx-preview` stack from `infra/preview.yaml`, either in the console (**CloudFormation → Create
stack → With new resources**, upload the file, stack name `tripelyx-preview`, keep the defaults, tick
the IAM acknowledgement) or with the AWS CLI:

```bash
aws cloudformation deploy --region us-east-1 --stack-name tripelyx-preview \
  --template-file infra/preview.yaml --capabilities CAPABILITY_NAMED_IAM
```

It uses the GitHub identity provider that `tripelyx-bootstrap` already created. When it finishes, open the
latest **Private preview** run (the one that ended with "not set up yet") and choose **Re-run all jobs**,
or push to the branch.

**Supplier test keys (optional).** Two repository secrets switch the preview's Business prices from demo data to
the suppliers' test systems. The workflow writes them into the container's settings only when they are set:

| Secret | Container settings |
| --- | --- |
| `DUFFEL_TEST_TOKEN` (a Duffel test token, `duffel_test_...`) | `BUSINESS_FLIGHT_SUPPLIER=duffel`, `DUFFEL_ACCESS_TOKEN`, `BUSINESS_ALLOW_SUPPLIER_TEST=true` |
| `LITEAPI_SANDBOX_KEY` (a LiteAPI sandbox key, `sand_...`), with `DUFFEL_TEST_TOKEN` | `BUSINESS_HOTEL_SUPPLIER=liteapi`, `LITEAPI_API_KEY` |

Hotels need flights, so `LITEAPI_SANDBOX_KEY` alone changes nothing. With the keys, Business prices are
labelled TEST DATA, and the demo seed makes the companies, people, budgets and policy but no trips, so the
preview calls no supplier when it starts. Before anything is built, the run stops
when either secret is set to anything but a test key (a Duffel token not starting with `duffel_test_`, a
LiteAPI key not starting with `sand_`); the message names the secret, never its value. The preview's
`ADMIN_EMAILS` is always the demo address `platform.admin@tripelyx-demo.example`, so no real address is in
this public repository's run log.

**Reading the password:** in the console, open **Secrets Manager → `tripelyx-preview/password` →
Retrieve secret value**, or:

```bash
aws secretsmanager get-secret-value --region us-east-1 --secret-id tripelyx-preview/password \
  --query SecretString --output text
```

To change it, edit that secret's value in the console, then choose **Re-run all jobs** on the latest
**Private preview** run (or push to the branch).

**Taking it down:** delete the stack. That removes the service, its address, the preview images, the
password and the role, and the charges stop:

```bash
aws cloudformation delete-stack --region us-east-1 --stack-name tripelyx-preview
```

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
  HttpOnly SameSite=Lax session cookie, cross-site form posts refused. `/admin` needs an `ADMIN_EMAILS`
  address and an active platform admin record (see [Platform admins](#platform-admins)).
- Notifications default to an outbox (`NOTIFY_PROVIDER=outbox`): recorded and visible to admins, never
  sent, until a real provider is registered.
- Hunts are re-run by an in-process scheduler every `HUNT_INTERVAL_MINUTES` (default 360; 0 means on
  open only) and when their page is opened if the last check is more than ten minutes old; the page says exactly that and nothing more. With
  more than one instance, run the scheduler on one of them (`HUNT_INTERVAL_MINUTES=0` on the others)
  so a hunt is not re-priced twice at once; hunts are not re-run while the site is down (a job queue
  outside the process is on the roadmap).

## Assets

The homepage's pictures (`public/img/home-*.webp`: the hero, the Alamein Go card, the laptop and
phone screens and the partner band, which the other company pages reuse) are cropped from the
homepage design picture the owner supplied, with the design's text and buttons painted out, and
enlarged with ImageMagick (Lanczos, light sharpening) for 1x and 2x screens; no new imagery was
generated or taken from a stock library for them. The rest of the photography (`coast-hero.*`,
`brand-alameingo.webp`) is derived from Alamein Go's own `public/hero-beach.jpg`. Illustrations,
icons, device frames and demo images are original. The Inter font is bundled under the SIL Open Font License
(see `public/fonts/OFL.txt`).
