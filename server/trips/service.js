// TripService ties the trip planner together: search, trip pages, customizing, the live price check,
// quotes for checkout, the booking provider the booking engine calls, saved trips and price watches,
// support messages, custom trip requests, analytics events and the admin control center's numbers.
const { AppError } = require('../lib/errors');
const { id } = require('../lib/ids');
const { addDays, today, hoursUntil } = require('../lib/dates');
const { str, EMAIL } = require('../lib/validate');
const { format: fmtMoney } = require('../lib/money');
const { encodeSpec, decodeSpec } = require('./spec');
const { priceTrip, publicTrip, requireTrip, DEFAULT_SETTINGS } = require('./pricing');
const optimizer = require('./optimizer');
const decision = require('./decision');
const leaks = require('./leaks');
const experience = require('./experience');
const { whyNot } = require('./savemax');
const { classifyChanges } = require('./facts');
const { longDate } = require('./words');
const { cutoffs, isOpen, nextCutoff } = require('./deadlines');

const FUNNEL = ['home_visit', 'budget_entered', 'search_started', 'results_viewed', 'trip_selected', 'checkout_started', 'payment_attempted', 'booking_confirmed'];
const FUNNEL_LABELS = {
  home_visit: 'Homepage visit', budget_entered: 'Budget entered', search_started: 'Search started', results_viewed: 'Results viewed',
  trip_selected: 'Trip selected', checkout_started: 'Checkout started', payment_attempted: 'Payment attempted', booking_confirmed: 'Booking confirmed',
};
const money = c => fmtMoney(c, 'USD');
// How far from a trip's dates an event on a link is still read for it (service.eventFor), in days either side.
const EVENT_NEAR_DAYS = 30;

// ---- price watches: the rule a watch waits for, and whether today's price meets it ----
// A watch speaks only when the rule the traveler set is met, judged on the total the pricer gives now
// against the total when the trip was saved. Three rules and no others: the total falls by at least an
// amount ('drop'), the same trip gets cheaper by any amount ('any-drop'), or the total is at or under
// an amount ('under'). A watch asked for with no rule gets the $100 drop. Amounts are cents.
const WATCH_RULES = ['drop', 'any-drop', 'under'];
const WATCH_DEFAULT_RULE = { kind: 'drop', amount: 10000 };
const WATCH_MAX_AMOUNT = 100000000; // $1,000,000, the same ceiling as "name your price"

// The rule as stored: validated and nothing else. Anything outside the three kinds, or an amount
// that is not a positive whole number of cents, is refused rather than guessed at.
// What the traveler asked for, kept on the quote for the booking page's victory screen: the nights
// (only when the link carried a stated length), the style and what matters most (only when stated,
// not the planner's defaults), the standing rules (kept both as `rules` and flattened, so a reader
// of either shape finds them) and the destination only when the traveler named one: `dest` on the
// context (the dream flow, the agent) or the search's own `dest` / a single `ds`. A destination the
// platform chose is never written down as something the traveler asked for and "kept": the booked
// trip's own facts are not asks. Nothing here is inferred; an ask that was never stated is absent.
function destAsked(cx, maps) {
  const p = cx || {};
  const s = p.searchParams ? new URLSearchParams(p.searchParams) : null;
  const ds = s && typeof s.get('ds') === 'string' ? s.get('ds').split(',').filter(Boolean) : [];
  const id = p.dest || (s && s.get('dest')) || (ds.length === 1 ? ds[0] : null);
  if (!id) return null;
  const d = maps && maps.getDestination(String(id));
  return d ? d.name : null;
}
// Experience Max: the memory goals the traveler ranked (`mem=`) are an ask like the others and ride
// onto the quote as `asks.goals`; the protected main experience (`px=`) is kept beside the asks as
// `budget.protect`. Both only when the link carried them: nothing is inferred from the booked trip.
function quoteAsks(cx, t, maps) {
  const p = cx || {}, rules = p.rules || null;
  return { nightsAsked: p.nightsAsked || null, style: p.style && p.style !== 'surprise' ? p.style : null, priority: p.priority && p.priority !== 'price' ? p.priority : null, rules, dest: destAsked(cx, maps), ...(rules || {}), ...(Array.isArray(p.goals) && p.goals.length ? { goals: p.goals.slice(0, 3) } : {}) };
}

function watchRule(input) {
  if (input === undefined || input === null) return { ...WATCH_DEFAULT_RULE };
  const kind = input && typeof input === 'object' ? input.kind : input;
  if (!WATCH_RULES.includes(kind)) throw new AppError('invalid_watch', 'Choose a watch rule: a drop of at least an amount, any drop, or a total at or under an amount.', 422, { rule: 'Choose a rule.' });
  if (kind === 'any-drop') return { kind };
  const amount = input.amount;
  if (!Number.isInteger(amount) || amount <= 0 || amount > WATCH_MAX_AMOUNT) throw new AppError('invalid_watch', 'Enter the amount in dollars for the watch, a whole number above zero.', 422, { amount: 'Enter an amount in dollars.' });
  return { kind, amount };
}

function ruleText(rule) {
  const r = watchRule(rule);
  if (r.kind === 'any-drop') return 'Alert when the same trip gets cheaper';
  if (r.kind === 'under') return `Alert when the total is at or under ${money(r.amount)}`;
  return `Alert when the total drops ${money(r.amount)} or more`;
}

// Is the rule met by the total priced now? Returns the verdict and the sentence My Trips shows: the
// movement with its sign when the rule asks for a drop, the total against the line when it asks for
// "at or under". A rule that is not met says so and never dresses the gap up.
function watchMet(rule, priceAtSave, now) {
  const r = watchRule(rule);
  if (!Number.isFinite(now) || !Number.isFinite(priceAtSave)) return { met: false, text: 'No alert: this trip could not be priced.' };
  const change = now - priceAtSave;
  const moved = change === 0 ? 'the total is unchanged since you saved it' : `the total moved ${change < 0 ? '−' : '+'}${money(Math.abs(change))} since you saved it`;
  if (r.kind === 'under') {
    if (now <= r.amount) return { met: true, text: `Now ${money(now)}, ${now === r.amount ? 'at' : 'under'} your ${money(r.amount)}` };
    return { met: false, text: `No alert: the total is ${money(now)}, above your ${money(r.amount)}` };
  }
  if (r.kind === 'any-drop') {
    if (change < 0) return { met: true, text: `The total dropped ${money(-change)} since you saved it: ${money(now)} now` };
    return { met: false, text: `No alert: ${moved}, so the same trip is not cheaper` };
  }
  if (change <= -r.amount) return { met: true, text: `The total dropped ${money(-change)} since you saved it: ${money(now)} now` };
  return { met: false, text: `No alert: ${moved}, not the ${money(r.amount)} drop you asked for` };
}

// WHAT WAS ACTUALLY WORTH IT? is asked once the trip is over: a booking that stands (confirmed, or
// confirmed in part) whose return date has passed. Before that there is nothing to judge, and a
// cancelled or failed booking was never travelled. Reads a stored booking (`quote.trip`) or the
// public one (`trip`).
const WORTH_IT_STATUSES = ['confirmed', 'partially_confirmed'];
function worthItOpen(b, now) {
  const t = (b && ((b.quote && b.quote.trip) || b.trip)) || null;
  if (!t || !t.spec) return { open: false, code: 'unknown', reason: 'This booking has no trip to ask about.' };
  const back = (t.flight && t.flight.return) || addDays(t.spec.depart, t.spec.nights);
  if (!WORTH_IT_STATUSES.includes(b.status)) return { open: false, code: 'status', back, reason: 'This question is for a trip that went ahead; this booking did not.' };
  if (today(now) <= back) return { open: false, code: 'early', back, reason: `This question is for after the trip: it opens the day after you fly home (${back}).` };
  return { open: true, code: null, back, reason: null };
}

class TripService {
  constructor({ inventory, store, notifier, config, now = () => new Date(), log = console }) {
    this.inv = inventory;
    this.store = store;
    this.notifier = notifier;
    this.config = config;
    this.now = now;
    this.log = log;
    this.settingsCache = null;
  }

  get demo() { return this.inv.demo; }

  // ---- settings (admin-editable business rules) ----
  async settings() {
    if (this.settingsCache && this.settingsCache.at > Date.now() - 15000) return this.settingsCache.value;
    const saved = await this.store.getRecord('settings', 'pricing');
    const value = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  async saveSettings(input) {
    const cur = await this.settings();
    const dollars = (v, max) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new AppError('invalid_settings', 'Check the values.', 422); return Math.round(n * 100); };
    const pct = (v, max) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new AppError('invalid_settings', 'Check the values.', 422); return Math.round(n * 10) / 10; };
    const next = {
      ...cur,
      serviceFeePerTraveler: dollars(input.serviceFeePerTraveler, 500),
      maxServiceFee: dollars(input.maxServiceFee, 2000),
      hotelMarkupPercent: pct(input.hotelMarkupPercent, 40),
      minProfit: dollars(input.minProfit, 5000),
      minMarginPercent: pct(input.minMarginPercent, 50),
      disabledDestinations: [].concat(input.disabledDestinations || []).filter(d => this.inv.maps.getDestination(d)),
    };
    await this.store.putRecord('settings', 'pricing', next);
    this.settingsCache = null;
    return next;
  }

  // ---- analytics ----
  async track(type, { visitor = null, userId = null, data = {} } = {}) {
    try {
      const e = { id: id('evt'), type, visitor, userId, at: this.now().toISOString(), data };
      await this.store.putRecord('event', e.id, e);
    } catch (err) { this.log.error('[analytics]', err); }
  }

  // ---- search ----
  parse(raw) { return optimizer.parseSearch(raw, { maps: this.inv.maps, now: this.now() }); }

  // When nothing fits: which single rule, relaxed on its own, really produces a trip.
  async oneRuleAway(query) {
    const settings = await this.settings();
    return optimizer.oneRuleAway(this.inv, query, { settings, now: this.now() });
  }

  async search(query, { visitor, user } = {}) {
    await this.track('search_started', { visitor, userId: user && user.id, data: { budget: query.budget, travelers: query.travelers, style: query.style, priority: query.priority, origin: query.origin } });
    const settings = await this.settings();
    const result = optimizer.search(this.inv, query, { settings, now: this.now() });
    if (result.picks.length) await this.track('results_viewed', { visitor, userId: user && user.id, data: { picks: result.picks.map(p => p.trip.dest.id) } });
    if (user) await this.store.putRecord('last_search', user.id, { params: optimizer.searchParams(query), query, at: this.now().toISOString() }, { userId: user.id });
    return result;
  }

  // Sample results for marketing sections (homepage example, SEO pages). Not tracked as searches.
  async sample(raw) {
    const { query } = this.parse(raw);
    return optimizer.search(this.inv, query, { settings: await this.settings(), now: this.now() });
  }

  // ---- a single trip ----
  async price(spec, { promo } = {}) {
    return priceTrip(this.inv, spec, await this.settings(), { promo });
  }

  async trip(token, ctx = {}) {
    const spec = decodeSpec(token);
    // A link to a trip whose dates have passed is no longer a trip anyone can book.
    if (spec.depart < today(this.now())) throw new AppError('trip_expired', 'This trip link is no longer available: its dates have passed.', 410);
    const t = requireTrip(await this.price(spec));
    const scores = optimizer.scoreTrip(t, ctx);
    return {
      trip: t, token: encodeSpec(t.spec), scores, why: optimizer.whyThisTrip(t, ctx),
      options: optimizer.customizerOptions(this.inv, t, await this.settings(), this.now()),
      origin: this.inv.maps.airport(spec.from), weather: this.inv.weather.outlook(spec.dest, Number(spec.depart.slice(5, 7))),
    };
  }

  // "Make it better for the same money" / "lock what you love, improve the rest": the strongest
  // alternative package at or under the cap (the current total, or the budget) with the locked parts
  // held fixed. Returns no proposal when nothing beats the current trip.
  async optimize(token, ctx = {}, { locks = {}, capMode = 'same' } = {}) {
    const current = await this.trip(token, ctx);
    const settings = await this.settings();
    const budgetCap = ctx.budget ? Math.round(ctx.budget * (1 + (ctx.allowOver || 0) / 100)) : null;
    const cap = capMode === 'budget' && budgetCap ? Math.max(current.trip.total, budgetCap) : current.trip.total;
    const best = decision.optimizeAround(this.inv, current.trip, settings, ctx, { locks, cap, now: this.now() });
    if (!best) return { current, proposal: null, cap, locks, capMode };
    const proposal = await this.trip(encodeSpec(best.trip.spec), ctx);
    return { current, proposal: { ...proposal, improvements: best.improvements, tradeoffs: best.tradeoffs, delta: best.delta }, cap, locks, capMode };
  }

  // "Name your price": the cheapest version of this trip that is still strong at or under the price
  // the traveler named, the cheapest version we would recommend at all, the best version that
  // reaches the price when none is strong (with its compromises), and the value ladder in between.
  // Candidates come back as trip-page data so every one carries a token.
  async namePrice(token, ctx = {}, target) {
    const current = await this.trip(token, ctx);
    if (target >= current.trip.total) return { current, currentTotal: current.trip.total, target, tooHigh: true };
    const settings = await this.settings();
    const out = decision.nameYourPrice(this.inv, current.trip, settings, ctx, target, { now: this.now() });
    const page = async c => (c ? { ...c, ...(await this.trip(encodeSpec(c.trip.spec), ctx)) } : null);
    return { ...out, current, currentTotal: out.current, recommended: await page(out.recommended), floor: await page(out.floor), anyway: await page(out.anyway), tooHigh: false };
  }

  // Apply one customizer change and return the new trip token.
  customize(token, change) {
    const s = decodeSpec(token);
    const next = { ...s, activities: [...s.activities] };
    if (change.hotel) next.hotel = String(change.hotel).slice(0, 40);
    if (change.flight) next.flight = String(change.flight).slice(0, 40);
    if (change.nights) next.nights = Math.max(2, Math.min(14, Number(change.nights) || s.nights));
    if (change.depart && /^\d{4}-\d{2}-\d{2}$/.test(change.depart)) next.depart = change.depart;
    if (change.bags !== undefined) next.bags = change.bags === '1' || change.bags === true;
    if (change.transfer !== undefined) next.transfer = change.transfer === '1' || change.transfer === true;
    if (change.activities !== undefined) next.activities = [].concat(change.activities).filter(Boolean).map(a => String(a).slice(0, 40)).slice(0, 6);
    if (next.depart < addDays(today(this.now()), 3)) next.depart = s.depart;
    return encodeSpec(next);
  }

  async promo(code) {
    if (!code) return null;
    const c = String(code).trim().toUpperCase().slice(0, 30);
    const p = await this.store.getRecord('promo', c);
    if (!p || !p.active || (p.expiresAt && p.expiresAt < today(this.now()))) throw new AppError('invalid_promo', 'That promo code isn’t valid.', 422, { promo: 'That promo code isn’t valid.' });
    return p;
  }

  // Live price check before checkout: re-ask the suppliers and compare with what the traveler saw.
  async verify(token, seen, { promoCode } = {}) {
    const promo = await this.promo(promoCode);
    const spec = decodeSpec(token);
    // A trip whose dates have passed cannot be quoted, and is not "unavailable from a supplier" either.
    if (spec.depart < today(this.now())) throw new AppError('trip_expired', 'This trip link is no longer available: its dates have passed.', 410);
    const t = await this.price(spec, { promo });
    if (!t) return { available: false };
    // With no earlier price to compare (no `seen`), the status is just "priced": never "still", which
    // would claim a comparison that was not made.
    if (!(Number.isFinite(seen) && seen > 0)) return { available: true, trip: t, promo, status: 'priced', diff: 0 };
    const diff = t.total - seen;
    return { available: true, trip: t, promo, status: diff === 0 ? 'same' : diff < 0 ? 'cheaper' : 'higher', diff: Math.abs(diff) };
  }

  // ---- the money leak hunter ----
  // Only facts the traveler stated reach the engine as preferences: the trip context's style and
  // what matters most (null when they are the planner's defaults, since a default was not said), the
  // nights asked, the bag they said they travel with (`bg` on the link; null when nothing was said,
  // so a page never claims "nothing you told me asks for a checked bag" to someone who said they
  // check one), the standing rules, and the party from the spec. The locks the traveler set with the
  // agent ride on the link (`locked=hotel,flight`: optimizer.parseContext) and reach every engine as
  // o.locks, so a page opened from the canvas never offers a version that moves a locked hotel, flights,
  // dates, length or destination; the dates are also held when the traveler stated an exact date, on the
  // context itself (`dm=exact`: the dream flow's "I have to be there on") or in the search it came from
  // (`when=exact`), and the hold reaches the engine both as `dateMode` and as `locks.dates`, so no
  // page moves a date the traveler fixed. The promo is the one the page carries, so every priced
  // version moves with it and no saving is a promo's shadow.
  linkLocks(cx) { return { ...((cx && cx.locks) || {}), ...(this.datesHeld(cx) ? { dates: true } : {}) }; }
  datesHeld(cx) {
    if (!cx) return false;
    if (cx.dateMode === 'exact' || (cx.locks && cx.locks.dates)) return true;
    const s = cx.searchParams ? new URLSearchParams(cx.searchParams) : null;
    return !!(s && s.get('when') === 'exact');
  }
  // The memory goals and the protected experience the link carries reach every engine the same way:
  // on the context (`goals`, `protect`) and, for the engines that read options, as `o.protect`, so a
  // protected experience is listed and never offered for removal on any page.
  leakOptions(trip, cx, promo = null) {
    const p = cx || {};
    return { now: this.now(), locks: this.linkLocks(cx), promo, protect: p.protect || null, prefs: { style: p.style && p.style !== 'surprise' ? p.style : null, priority: p.priority && p.priority !== 'price' ? p.priority : null, who: trip.spec.who, bags: p.bags || null, rules: p.rules || null, nightsAsked: p.nightsAsked || null, goals: Array.isArray(p.goals) ? p.goals.slice(0, 3) : [] } };
  }
  leakContext(cx) {
    const p = cx || {};
    return { ...p, dateMode: this.datesHeld(cx) ? 'exact' : null, goals: Array.isArray(p.goals) ? p.goals.slice(0, 3) : [], protect: p.protect || null };
  }
  // Everything the Money Leak page shows, each part the engine's own data (its words live in `text`).
  // `cut` is the amount to take out, in cents, for the cut-in-order walk; null skips it. The biggest
  // leak also carries `givesUp`: the facts' trade-offs between the trip and that version, in words.
  async moneyLeaks(trip, cx, { cut = null, promo = null } = {}) {
    const settings = await this.settings(), inv = this.inv, o = this.leakOptions(trip, cx, promo), lctx = this.leakContext(cx);
    const lean = leaks.lean(inv, trip, settings, lctx, o);
    const big = leaks.biggestLeak(inv, trip, settings, lctx, o);
    // The facts' trade-off rows between the trip and the leak's version, in savemax's words; a row
    // those words do not cover is still named, so "nothing given up" is never said over a row.
    const alt = big ? requireTrip(priceTrip(inv, decodeSpec(big.token), settings, { promo })) : null;
    const rows = alt ? classifyChanges(trip, alt).tradeoffs : [], words = alt ? whyNot(alt, trip, lctx) : [];
    const givesUp = words.length || !rows.length ? words : rows.map(r => `${r.label}: ${r.b}`);
    return {
      breakdown: leaks.breakdown(trip, o), extras: leaks.optionalExtras(inv, trip, settings, lctx, o), lean,
      addBack: leaks.addBack(inv, lean.lean.trip, lean.removed, settings, lctx, o), removeOne: leaks.removeOne(inv, trip, settings, lctx, o),
      biggestLeak: big ? { ...big, givesUp } : null, freeSavings: leaks.freeSavings(inv, trip, settings, lctx, o),
      // Why each optional item stays, when the engine says it (so a transfer kept for "you land late"
      // is never called "one you asked for"); null on an engine without it.
      whyKept: typeof leaks.whyKept === 'function' ? leaks.whyKept(inv, trip, settings, lctx, o) : null,
      cut: cut ? leaks.cutInOrder(inv, trip, settings, lctx, Math.max(0, trip.total - cut), o) : null,
      hotelFees: leaks.hotelFees(trip), bags: leaks.bagConfigs(inv, trip, settings, lctx, o), seats: leaks.seatFees(trip), meals: leaks.mealCheck(inv, trip, settings, lctx, o),
      nights: leaks.nightChecks(inv, trip, settings, lctx, o), duplicates: leaks.duplicates(inv, trip, settings, o), car: leaks.carCheck(trip), notAvailable: leaks.notAvailable(trip),
    };
  }
  // The review page's two checks before the quote: the savings check (the max, the trip, what is not
  // used; no history on a page) and the money leak check, plus the breakdown for "what am I paying for?".
  async leakCheck(trip, cx, { promo = null } = {}) {
    const settings = await this.settings(), o = this.leakOptions(trip, cx, promo), lctx = this.leakContext(cx);
    return { scorecard: leaks.scorecard({ max: (cx && cx.budget) || null, trip, history: [] }, this.inv, settings), scan: leaks.finalScan(this.inv, trip, settings, lctx, o), breakdown: leaks.breakdown(trip, o) };
  }

  // ---- Experience Max ----
  // The query the experience engine reads for one trip: the trip's own origin, party, dates and
  // length (a page about this trip compares versions of it on its own dates), and beyond that only
  // what the link carries: the ceiling, a stated style, priority, length and rules. Nothing the
  // traveler did not say is written in as an ask.
  experienceQuery(trip, cx) {
    const p = cx || {}, s = trip.spec, ap = this.inv.maps.airport(s.from);
    return {
      budget: p.budget || null, vacationBudget: p.budget ? p.budget + (p.keep || 0) : null, keep: p.keep || 0, budgetInput: p.budget ? Math.round((p.budget + (p.keep || 0)) / 100) : null, budgetType: 'total',
      travelers: s.travelers, who: s.who, origin: ap ? ap.originId : null, dateMode: 'exact', depart: s.depart, month: null, nights: p.nightsAsked || s.nights,
      style: p.style || 'surprise', priority: p.priority || 'price', allowOver: 0, dest: s.dest, region: null, rules: p.rules || null, dests: null, notCountry: null,
    };
  }
  // The options every experience call gets. The ceiling is the budget the link carries, never the
  // "up to 10% more" allowance: going over is the traveler's own word on a version, not a target an
  // engine builds toward. A date the traveler fixed is held (dm=exact or when=exact), a stated length
  // is not stretched, the locks on the link (locked=) hold, the rules ride along, and the protected
  // experience (px=) reaches every engine.
  // The event the link carries (ev=, evt=, evn=) reaches every engine as o.event, as the agent's own calls get it, so the
  // page's THE RHYTHM, SCHEDULE CONFLICT, PROTECTION, best day and FINAL EXPERIENCE CHECK keep the EVENT DAY the agent keeps.
  async experienceOptions(trip, cx, { promo = null } = {}) {
    const p = cx || {}, held = this.datesHeld(cx), px = this.offeredProtect(trip, cx);
    return {
      now: this.now(), settings: await this.settings(), locks: this.linkLocks(cx), cap: p.budget || null, rules: p.rules || null, protect: px, promo, event: this.eventFor(trip, cx),
      nightsOpen: !p.nightsAsked && !(p.locks && p.locks.nights), goals: experience.goalsOf(p.goals || []), ctx: { dateMode: held ? 'exact' : null, rules: p.rules || null, protect: px },
    };
  }
  // A protected experience (px=) counts only when this trip's destination offers it. A link that names
  // anything else (another destination's experience, an edited or stale link) protects nothing here.
  offeredProtect(trip, cx) {
    const px = (cx && cx.protect) || null;
    return px && (trip.activityOptions || []).some(a => a.id === px) ? px : null;
  }
  // The trip, memories and review routes call this first: a px the destination does not offer is
  // dropped from the context, so no link out of the page carries it, and the page says so in words.
  // Its id is never shown: it names nothing here.
  dropUnoffered(trip, cx) {
    if (!cx || !cx.protect || this.offeredProtect(trip, cx)) return null;
    cx.protect = null;
    return `The experience this link protects is not offered in ${trip.dest.name}, so it is no longer protected and nothing on this trip is held for it.`;
  }
  // The event a link carries is read for a trip only when it could belong to it: its date is today or later and falls
  // inside the trip or within EVENT_NEAR_DAYS of its dates (a trip that misses it by a few days is the SCHEDULE CONFLICT
  // the agent says, with the dates that cover it). A date far from the trip, or already past, is a stale or edited link:
  // reading it would plan this trip around a reservation nobody made for it. dropFarEvent() takes it off the context, so
  // no link out of the page carries it, and returns the sentence the page says, so it is never dropped quietly.
  eventFor(trip, cx) {
    const e = cx && cx.event;
    if (!e || !e.date) return null;
    const s = trip.spec, from = addDays(s.depart, -EVENT_NEAR_DAYS), to = addDays(s.depart, s.nights + EVENT_NEAR_DAYS);
    return e.date >= today(this.now()) && e.date >= from && e.date <= to ? e : null;
  }
  dropFarEvent(trip, cx) {
    if (!cx || !cx.event || this.eventFor(trip, cx)) return null;
    const e = cx.event, past = e.date < today(this.now());
    cx.event = null;
    return `The reservation this link carries (${e.name || 'your reservation'} on ${longDate(e.date)}) ${past ? 'is already past' : `is more than ${EVENT_NEAR_DAYS} days from this trip's dates`}, so this page does not plan around it, and no link from here carries it.`;
  }
  // The page's main experience is always one this trip has: the protected one while the trip has it,
  // else the strongest for the goals, so PROTECTION always covers the trip's own main experience. A
  // protected experience this version lacks is reported beside it by name (`missing`), never swapped in
  // or dropped quietly; one the destination does not offer is `foreign`, never shown by its raw id.
  experienceMain(trip, cx, gs) {
    const px = (cx && cx.protect) || null, own = px ? trip.activities.find(a => a.id === px) || null : null;
    const missing = px && !own ? (trip.activityOptions || []).find(a => a.id === px) || null : null;
    return { main: own || experience.mainOf(trip, gs), protected: !!own, missing, foreign: !!(px && !own && !missing) };
  }
  // Everything the /trip/:token/memories page shows, each part the experience engine's own data (its
  // words live in `text`, every version is a token priced in full). Nothing here is applied: the page
  // turns each version into a link. `amount` is MAKE $X MEMORABLE's amount, in cents. Without goals
  // the page asks for them first, and nothing is judged "worth it" before they are given.
  async memories(trip, cx, { amount = 10000 } = {}) {
    const X = experience, inv = this.inv, o = await this.experienceOptions(trip, cx), gs = o.goals, q = this.experienceQuery(trip, cx);
    const m = this.experienceMain(trip, cx, gs);
    if (!gs.length) return { goals: gs, q, ...m };
    o.q = q;
    // The ladder is read for this trip (X.ladder's `trip`): the same trip, goals and rules give the agent's "I'd stop at".
    const hoe = X.hotelOrExperience(inv, trip, gs, o), L = X.ladder(inv, q, gs, { ...o, trip }), main = m.main;
    // The budget's "I'd choose the simpler hotel" line is never said on the page that says "I'd take
    // the hotel": when HOTEL OR EXPERIENCE? picks the hotel, the allocation gets no step-up to name.
    const up = hoe.verdict === 'a' ? { hotelUp: null, inv: null } : { hotelUp: hoe.a, inv };
    return {
      goals: gs, q, ...m, amount,
      receipt: X.receipt(inv, q, trip, gs, o), allocation: X.allocation(trip, o.cap, { ...up, o }), rhythm: X.rhythm(trip, gs, { main, event: o.event }),
      hotelOrExperience: hoe, memoryTest: X.memoryTest(inv, trip, gs, o, amount), bigVsMany: X.bigVsMany(inv, trip, gs, o),
      free: X.freeThings(inv, trip, gs), freeOverPaid: X.freeOverPaid(inv, trip, gs), location: X.locationCheck(inv, trip, gs, o),
      collisions: X.collisions(trip, { event: o.event, inv, settings: o.settings, goals: gs, protect: o.protect, rules: o.rules, locks: o.locks }), fatigue: X.fatigue(trip, gs, { ...o, inv }),
      ladder: L, sweetSpot: X.sweetSpot(L, trip), sameFeeling: X.sameFeeling(inv, q, gs, trip, o),
      dupes: trip.activities.map(a => ({ activity: a, protected: a.id === o.protect, dupe: X.dupe(inv, trip, a, o) })),
      protection: main ? X.protection(inv, trip, main, o) : null, bestDay: main ? X.bestDay(trip, main, { ...o, inv, goals: gs }) : null, backup: main ? X.backup(inv, trip, main, { ...o, goals: gs }) : null,
      finalCheck: X.finalCheck(trip, gs, { ...o, inv }), more: X.moreMemorable(inv, trip, gs, o),
    };
  }
  // The review page's experience additions, only when the link carries goals or a protected
  // experience (a traveler who said neither gets the review as before): the EXPERIENCE RECEIPT, the
  // PROTECTION rows for the main experience, the FINAL EXPERIENCE CHECK and the "very scheduled" line.
  // The trip is the verified one, promo included, and every version these panels price carries the same
  // code (as the money leak check's do): a link to another version's review then names that version's
  // total with the code as the one seen, so its review says "still", never "dropped" because of the code.
  async experienceReview(trip, cx, { promo = null } = {}) {
    const X = experience, inv = this.inv, o = await this.experienceOptions(trip, cx, { promo }), gs = o.goals;
    if (!gs.length && !o.protect) return null;
    const q = this.experienceQuery(trip, cx), m = this.experienceMain(trip, cx, gs);
    o.q = q;
    return {
      goals: gs, ...m, receipt: gs.length ? X.receipt(inv, q, trip, gs, o) : null, protection: m.main ? X.protection(inv, trip, m.main, o) : null,
      finalCheck: gs.length ? X.finalCheck(trip, gs, { ...o, inv }) : null, fatigue: X.fatigue(trip, gs, { ...o, inv }),
    };
  }

  // WHAT WAS ACTUALLY WORTH IT? after the trip. `answer` is { worth: [chips], notWorth: [chips], other }
  // (a bare chip or list of chips counts as "worth it"); only WORTH_IT_CHIPS are read. The answer is
  // kept on the booking (`booking.worthIt`), and on the account's travel defaults only when the
  // traveler ticked "Remember this for next time" and is signed in as the booking's owner: a
  // preference is never remembered on anyone's word but theirs, and "Other" stays their words only.
  // It is asked after the trip is over, never before.
  async setWorthIt(ref, answer, { remember = false, userId = null } = {}) {
    const b = await this.store.getBookingByRef(String(ref || '').toUpperCase().slice(0, 20));
    if (!b || b.vertical !== 'trips') throw new AppError('booking_not_found', 'We couldn’t find that booking.', 404);
    const back = worthItOpen(b, this.now());
    if (!back.open) throw new AppError('worth_it_closed', back.reason, 409, { reason: back.code });
    const a = Array.isArray(answer) || typeof answer === 'string' ? { worth: answer } : answer || {};
    const chips = v => [...new Set([].concat(v || []).filter(c => typeof c === 'string' && experience.WORTH_IT_CHIPS.includes(c)))];
    const worth = chips(a.worth), notWorth = chips(a.notWorth), other = str(a.other, 300) || null;
    const both = worth.filter(c => notWorth.includes(c));
    if (both.length) throw new AppError('invalid_worth_it', `You marked ${both.join(' and ')} as both worth it and not worth it, so nothing was kept. Choose one for each.`, 422, { reason: 'both' });
    if (!worth.length && !notWorth.length && !other) throw new AppError('invalid_worth_it', 'Choose at least one: what was worth it, or what was not.', 422, { reason: 'empty' });
    const learned = experience.learn({ worth, notWorth });
    const has = Object.keys(learned.prefs).length > 0, owner = !!(userId && b.userId && b.userId === userId);
    // Where it is kept, said on the page as it was decided here. A booking made without an account
    // ('guest') belongs to no account, so it is never said to belong to another one.
    const defaults = !remember ? 'not-asked' : !b.userId ? 'guest' : !userId ? 'signed-out' : !owner ? 'not-owner' : !has ? 'nothing' : 'saved';
    // An answer saved earlier from this booking follows this booking's latest answer, as the owner decides
    // it now: ticked, the new answer replaces it; unticked, or with nothing in it I can use, it is removed,
    // so the account never keeps a preference the traveler's latest word contradicts. Only the owner,
    // signed in, changes their account; anyone else is told the earlier answer is still on it.
    const d = b.userId ? await this.store.getRecord('travel_defaults', b.userId) : null;
    const prior = !!(d && d.experiencePrefs && d.experiencePrefs.from === b.ref);
    const earlier = !prior ? null : !owner ? 'kept' : defaults === 'saved' ? 'replaced' : 'removed';
    const at = this.now().toISOString();
    const record = { worth, notWorth, other, prefs: learned.prefs, text: learned.text, notes: learned.notes, at, defaults, earlier };
    await this.store.updateBooking(b.id, null, { worthIt: record });
    if (defaults === 'saved') await this.store.putRecord('travel_defaults', userId, { ...(d || {}), experiencePrefs: { ...learned.prefs, from: b.ref, savedAt: at } }, { userId });
    else if (earlier === 'removed') { const { experiencePrefs, ...rest } = d; await this.store.putRecord('travel_defaults', userId, rest, { userId }); } // eslint-disable-line no-unused-vars
    return record;
  }
  // Who is answering WHAT WAS ACTUALLY WORTH IT? for this booking, so the form promises a save only to
  // the account that booked it: 'owner' (signed in as that account), 'signed-out' (a booking with an
  // account, opened without signing in), 'other' (signed in as another account) or 'guest' (booked
  // without an account: nothing can be remembered for it). `remembered` (only ever told to the owner):
  // an answer from this booking is already saved to their account, so the form says what each choice does to it.
  async worthItAccount(ref, user = null) {
    const b = await this.store.getBookingByRef(String(ref || '').toUpperCase().slice(0, 20));
    if (!b) return { who: user ? 'other' : 'signed-out', remembered: false };
    const who = !b.userId ? 'guest' : !user ? 'signed-out' : user.id === b.userId ? 'owner' : 'other';
    const d = who === 'owner' ? await this.store.getRecord('travel_defaults', b.userId) : null;
    return { who, remembered: !!(d && d.experiencePrefs && d.experiencePrefs.from === b.ref) };
  }

  // `cx` is the trip-page context the review carried: what the traveler asked for travels onto the
  // quote as `budget.asks`, so the booking page can say which asks the booked trip's facts meet.
  async createQuote(token, { approvedTotal, budget, keep, allowOver, promoCode, user, cx = null }) {
    const v = await this.verify(token, approvedTotal, { promoCode });
    if (!v.available) throw new AppError('trip_unavailable', 'Part of this trip is no longer available. Please rebuild it.', 410);
    if (v.status !== 'same') throw new AppError('price_changed', `Your trip price changed to ${money(v.trip.total)}. Please review it before continuing.`, 409, { newTotal: v.trip.total });
    const t = v.trip;
    const tokenNow = encodeSpec(t.spec);
    const origin = this.inv.maps.airport(t.spec.from);
    const now = this.now();
    const pub = publicTrip(t);
    const sum = keys => t.lines.filter(l => keys.includes(l.key)).reduce((s, l) => s + l.amount, 0);
    const taxDetail = t.lines.find(l => l.key === 'taxes').detail;
    const quote = {
      id: id('qt'), vertical: 'trips', refPrefix: 'BT', demo: t.demo, provider: 'trip-packages',
      query: { token: tokenNow },
      offer: {
        id: tokenNow, title: `${t.spec.nights} nights in ${t.dest.name}`, subtitle: `${origin ? origin.city : t.spec.from} to ${t.dest.name}, ${t.spec.travelers} traveler${t.spec.travelers > 1 ? 's' : ''}`,
        location: `${t.dest.name}, ${t.dest.country}`, media: [t.dest.image], demo: t.demo, provider: 'trip-packages',
      },
      option: { name: `${t.hotel.name} · ${t.flight.name} flights` },
      selection: {}, lines: t.lines.map(({ key, label, amount }) => ({ key, label, amount, kind: key === 'promo' ? 'discount' : key === 'taxes' ? 'tax' : key === 'service' ? 'fee' : 'base' })),
      currency: 'USD', subtotal: t.total - sum(['taxes', 'service']), taxes: sum(['taxes']), fees: sum(['service']), total: t.total,
      startDate: t.spec.depart,
      cancellation: { type: 'mixed', freeUntilHours: 0, penaltyPercent: 100, summary: 'Each part of the trip keeps its own cancellation terms, listed on your trip page.' },
      trip: {
        token: tokenNow, spec: t.spec, dest: { id: t.dest.id, name: t.dest.name, country: t.dest.country, image: t.dest.image },
        origin: origin ? { city: origin.city, code: origin.code } : { city: t.spec.from, code: t.spec.from },
        flight: pub.flight, hotel: pub.hotel, activities: pub.activities, transfer: pub.transfer, rooms: t.rooms,
        lines: pub.lines, included: pub.included, notIncluded: pub.notIncluded, providers: pub.providers, policies: pub.policies,
        perTraveler: t.perTraveler, perNight: t.perNight, total: t.total, internationalTrip: t.internationalTrip,
      },
      refundBasis: {
        flights: sum(['flights', 'bags']) + taxDetail[0].amount,
        hotel: sum(['hotel']) + taxDetail.slice(1).reduce((s, l) => s + l.amount, 0),
        activities: t.activities.map(a => ({ id: a.id, amount: a.pricePerPerson * t.spec.travelers })),
        transfer: sum(['transfer']), service: sum(['service']), discount: -sum(['promo']),
      },
      budget: { budget: budget || null, keep: budget && keep ? keep : 0, allowOver: allowOver || 0, asks: quoteAsks(cx, t, this.inv.maps), ...(cx && cx.protect ? { protect: cx.protect } : {}) },
      promoCode: v.promo ? v.promo.code : null,
      internal: t.internal,
      userId: user ? user.id : null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.quoteTtlMinutes * 60000).toISOString(),
    };
    await this.store.saveQuote(quote);
    return quote;
  }

  // ---- the provider the booking engine calls for vertical 'trips' ----
  bookingProvider() {
    const svc = this;
    return {
      async recheck(quote) {
        const v = await svc.verify(quote.trip.token, quote.total, { promoCode: quote.promoCode }).catch(() => ({ available: false }));
        const url = `/trip/${quote.trip.token}/review?seen=${quote.total}${quote.budget && quote.budget.budget ? `&b=${quote.budget.budget / 100}${quote.budget.keep ? `&k=${quote.budget.keep / 100}` : ''}` : ''}`;
        if (!v.available) return { changed: true, newTotal: null, url, message: 'Part of this trip is no longer available, so nothing was charged. Please review the trip.' };
        if (v.status === 'same') return { changed: false };
        return {
          changed: true, newTotal: v.trip.total, url,
          message: v.status === 'cheaper'
            ? `Good news — your trip dropped to ${money(v.trip.total)}. Nothing was charged; please confirm the new price.`
            : `Your trip price changed by ${money(v.diff)}. Nothing was charged; please review and approve the new price.`,
        };
      },
      async book({ quote, traveler, bookingRef }) {
        const t = await svc.price(quote.trip.spec);
        if (!t) throw new Error('trip components unavailable at booking time');
        const components = [];
        const ctx = { traveler, tripRef: bookingRef };
        const flight = await svc.inv.flights.book(t.flight, ctx); // a failure here fails the whole booking (full refund)
        components.push({ kind: 'flight', name: `${t.flight.airline} · ${t.flight.from} ⇄ ${t.flight.to}`, supplier: t.flight.supplier, status: 'confirmed', confirmation: flight.confirmation });
        const rest = [
          { kind: 'hotel', name: t.hotel.name, supplier: t.hotel.supplier, run: () => svc.inv.hotels.book(t.hotel, ctx) },
          ...t.activities.map(a => ({ kind: 'activity', name: a.name, supplier: a.supplier, run: () => svc.inv.activities.book(a, ctx) })),
          ...(t.transfer ? [{ kind: 'transfer', name: t.transfer.name, supplier: t.transfer.supplier, run: () => svc.inv.transfers.book(t.transfer, ctx) }] : []),
        ];
        let failed = null;
        for (const c of rest) {
          if (failed) { components.push({ kind: c.kind, name: c.name, supplier: c.supplier, status: 'not_booked' }); continue; }
          try {
            const r = await c.run();
            components.push({ kind: c.kind, name: c.name, supplier: c.supplier, status: 'confirmed', confirmation: r.confirmation });
          } catch (err) {
            svc.log.error(`[trips] ${c.kind} booking failed for ${bookingRef}:`, err && err.message);
            failed = c.kind;
            components.push({ kind: c.kind, name: c.name, supplier: c.supplier, status: 'failed' });
          }
        }
        return failed
          ? { status: 'partial', supplierRef: flight.confirmation, components, note: `${failed}_failed` }
          : { status: 'confirmed', supplierRef: flight.confirmation, components };
      },
      async cancel() { /* Demo suppliers accept every cancellation; real adapters cancel each component here. */ },
      // Refunds follow the same dated cutoffs the pages show (trips/deadlines): the 24-hour window
      // after a booking made at least 7 days ahead, then each part's own cutoff.
      cancellationPreview(b, now) {
        if (b.status === 'partially_confirmed') return { allowed: false, reason: 'Our team is already working on this trip and will contact you about your options and any refund.' };
        const q = b.quote, rb = q.refundBasis;
        const paid = (b.payment && b.payment.amount) || b.total;
        if (hoursUntil(b.startDate, now) <= 0) return { allowed: false, reason: 'This trip has already started.' };
        const { items, fullRefundUntil } = cutoffs(q.trip, { bookedAt: b.createdAt });
        const open = key => isOpen(items.find(x => x.key === key), now);
        const deadlines = items.map(it => ({ key: it.key, component: it.component, cutoff: it.cutoff, rule: it.rule, unverified: !!it.unverified, open: isOpen(it, now) }));
        const next = nextCutoff(items, now);
        const common = { currency: b.currency, fullRefundUntil, deadlines, nextCutoff: next ? { component: next.component, cutoff: next.cutoff } : null };
        if (fullRefundUntil && now.getTime() < Date.parse(fullRefundUntil)) {
          return { allowed: true, refundAmount: paid, freeWindowOpen: true, policy: 'You’re within 24 hours of booking, so the whole trip is refundable.', breakdown: [{ component: 'Whole trip', amount: paid }], ...common };
        }
        const breakdown = [
          { key: 'flights', component: 'Flights', amount: open('flights') ? rb.flights : 0 },
          { key: 'hotel', component: 'Hotel', amount: open('hotel') ? rb.hotel : 0 },
          ...rb.activities.map(a => ({ key: `activity:${a.id}`, component: (q.trip.activities.find(x => x.id === a.id) || {}).name || 'Experience', amount: open(`activity:${a.id}`) ? a.amount : 0 })),
          ...(rb.transfer ? [{ key: 'transfer', component: 'Airport transfer', amount: open('transfer') ? rb.transfer : 0 }] : []),
          { key: 'service', component: 'Service fee', amount: 0 },
        ];
        const gross = breakdown.reduce((s, x) => s + x.amount, 0);
        const before = paid + (rb.discount || 0);
        const refund = Math.min(paid, Math.round(rb.discount ? gross * (paid / before) : gross));
        if (rb.discount && gross) {
          // A promo discount is shared across the parts, so each row carries its share and the rows add up to the refund.
          for (const x of breakdown) x.amount = Math.round(x.amount * (paid / before));
          const largest = breakdown.reduce((m, x) => (x.amount > m.amount ? x : m), breakdown[0]);
          largest.amount += refund - breakdown.reduce((s, x) => s + x.amount, 0);
        }
        return { allowed: true, refundAmount: refund, freeWindowOpen: refund === paid, policy: 'Refunds follow each part’s own terms.', breakdown, ...common };
      },
    };
  }

  // Booking engine events → analytics, notifications and admin alerts.
  async onBookingEvent(type, b) {
    if (b.vertical !== 'trips') return;
    const visitor = null;
    if (type === 'payment_attempted' || type === 'booking_confirmed') await this.track(type, { visitor, userId: b.userId, data: { ref: b.ref, total: b.total, dest: b.quote.trip.dest.id } });
    if (type === 'booking_confirmed') {
      // A demo booking says so in the subject: nothing was reserved and the payment was a test.
      await this.notifier.send(b.demo
        ? { to: b.traveler.email, subject: `Demo booking complete · TRIP #${b.ref}`, body: `${b.quote.offer.title}. Demo total ${money(b.total)}. This was a demo: nothing was reserved with any supplier and no card was charged.`, ref: b.ref }
        : { to: b.traveler.email, subject: `Your trip is confirmed · TRIP #${b.ref}`, body: `${b.quote.offer.title}. Total paid ${money(b.total)}.`, ref: b.ref });
    }
    if (type === 'partially_confirmed' || type === 'booking_failed') {
      const alert = { id: id('alr'), ref: b.ref, type, message: type === 'partially_confirmed' ? 'Part of this trip could not be confirmed. Manual intervention needed.' : 'Booking failed after payment; the payment was refunded automatically.', open: true, at: this.now().toISOString() };
      await this.store.putRecord('alert', alert.id, alert);
      await this.notifier.send({ to: 'operations', audience: 'admin', subject: `Action needed: TRIP #${b.ref}`, body: alert.message, ref: b.ref });
      await this.notifier.send({ to: b.traveler.email, subject: `An update on TRIP #${b.ref}`, body: 'Part of your trip could not be confirmed. Our team is on it and will contact you.', ref: b.ref });
    }
  }

  // ---- saved trips, price watches, abandoned trips ----
  // A saved trip is a bookmark with the price of the day. A watch also carries the rule it waits for
  // (see watchRule); the rule is checked before the trip is priced, so bad input is a 422, not a search.
  async saveTrip(user, token, { kind = 'saved', budget = null, rule } = {}) {
    if (kind !== 'saved' && kind !== 'watch') throw new AppError('invalid_watch', 'Save the trip or watch its price.', 422);
    const watch = kind === 'watch';
    const checked = watch ? watchRule(rule) : null;
    const t = requireTrip(await this.price(decodeSpec(token)));
    const rec = { id: id(watch ? 'wch' : 'sav'), kind, token: encodeSpec(t.spec), budget, priceAtSave: t.total, title: `${t.spec.nights} nights in ${t.dest.name}`, savedAt: this.now().toISOString() };
    if (watch) rec.rule = checked;
    await this.store.putRecord(kind, rec.id, rec, { userId: user.id });
    return rec;
  }

  // The agent's way in: a watch with the rule the traveler named, returned with its rule in words.
  async watchTrip(user, token, { budget = null, rule } = {}) {
    const rec = await this.saveTrip(user, token, { kind: 'watch', budget, rule });
    return { ...rec, ruleText: ruleText(rec.rule) };
  }

  // Saved trips and watches re-priced now. A watch adds its rule, the rule in words and `alert`, the
  // watchMet verdict; a trip that can no longer be priced keeps trip and alert null, and a trip whose
  // dates have passed cannot alert, since it cannot be booked.
  async listSaved(user, kind) {
    const recs = await this.store.listRecords(kind, { userId: user.id, limit: 50 });
    const out = [];
    for (const r of recs) {
      let t = null;
      try { t = await this.price(decodeSpec(r.token)); } catch { t = null; }
      const departed = decodeSpec(r.token).depart < today(this.now());
      const row = { ...r, trip: t ? publicTrip(t) : null, now: t ? t.total : null, change: t ? t.total - r.priceAtSave : null, departed };
      if (kind === 'watch') {
        row.rule = watchRule(r.rule);
        row.ruleText = ruleText(row.rule);
        row.alert = !t ? null : departed ? { met: false, text: 'No alert: this trip’s dates have passed' } : watchMet(row.rule, r.priceAtSave, t.total);
      }
      out.push(row);
    }
    return out;
  }

  async removeSaved(user, kind, recId) {
    const recs = await this.store.listRecords(kind, { userId: user.id, limit: 200 });
    if (!recs.find(r => r.id === recId)) throw new AppError('not_found', 'Not found.', 404);
    await this.store.deleteRecord(kind, recId);
  }

  async rememberTrip(user, token, budget) {
    if (!user) return;
    await this.store.putRecord('recent_trip', user.id, { token, budget, at: this.now().toISOString() }, { userId: user.id });
  }

  // "Still thinking about Cancun?" Only for a trip that hasn't been booked, re-priced right now.
  async recentTrip(user) {
    if (!user) return null;
    const r = await this.store.getRecord('recent_trip', user.id);
    if (!r) return null;
    let spec;
    try { spec = decodeSpec(r.token); } catch { return null; }
    if (spec.depart < addDays(today(this.now()), 3)) return null;
    const booked = (await this.store.listBookings({ userId: user.id, limit: 20 })).some(b => b.vertical === 'trips' && b.quote.trip.token === r.token && b.status !== 'expired');
    if (booked) return null;
    const t = await this.price(spec);
    return t ? { ...r, trip: publicTrip(t) } : null;
  }

  // ---- support ----
  async addSupportMessage(ref, { from, text, name }) {
    const body = str(text, 2000);
    if (body.length < 2) throw new AppError('invalid_message', 'Write a message first.', 422, { message: 'Write a message first.' });
    const m = { id: id('sup'), ref, from, name: str(name, 80), text: body, at: this.now().toISOString() };
    await this.store.putRecord('support', m.id, m);
    if (from === 'customer') await this.notifier.send({ to: 'support', audience: 'admin', subject: `New message on TRIP #${ref}`, body: body.slice(0, 200), ref });
    return m;
  }

  async supportMessages(ref) {
    return (await this.store.listRecords('support', { limit: 2000 })).filter(m => m.ref === ref).reverse();
  }

  async createRequest(input, user) {
    const r = {
      id: id('req'), name: str(input.name, 80), email: str(input.email, 120).toLowerCase(), budget: str(input.budget, 20), from: str(input.from, 80),
      travelers: str(input.travelers, 10), dates: str(input.dates, 80), wants: str(input.wants, 1500), status: 'received', userId: user ? user.id : null,
      at: this.now().toISOString(),
    };
    const errors = {};
    if (!r.name) errors.name = 'Enter your name.';
    if (!EMAIL.test(r.email)) errors.email = 'Enter a valid email address.';
    if (!r.wants || r.wants.length < 10) errors.wants = 'Tell us a little more about the trip you want.';
    if (Object.keys(errors).length) throw new AppError('invalid_request', 'Check the highlighted fields.', 422, errors);
    await this.store.putRecord('trip_request', r.id, r, { userId: r.userId });
    await this.notifier.send({ to: 'support', audience: 'admin', subject: 'New custom trip request', body: `${r.name}: ${r.wants.slice(0, 200)}`, ref: r.id });
    return r;
  }

  // ---- admin ----
  async dashboard({ days = 30 } = {}) {
    const since = new Date(this.now().getTime() - days * 86400000).toISOString();
    const bookings = (await this.store.listBookings({ limit: 5000 })).filter(b => b.vertical === 'trips');
    const t0 = today(this.now());
    const paidStatuses = ['confirmed', 'partially_confirmed', 'pending_supplier'];
    const inRange = bookings.filter(b => b.createdAt >= since);
    const paid = inRange.filter(b => paidStatuses.includes(b.status));
    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const gbv = sum(paid, b => b.total);
    const revenue = sum(paid, b => (b.quote.internal ? b.quote.internal.serviceFee + b.quote.internal.hotelMarkup + b.quote.internal.commission : 0));
    const profit = sum(paid, b => (b.quote.internal ? b.quote.internal.grossProfit : 0));
    const events = await this.store.listRecords('event', { since, limit: 50000 });
    const funnel = this.funnel(events);
    const searches = events.filter(e => e.type === 'search_started');
    const budgets = searches.map(e => e.data && e.data.budget).filter(Boolean);
    const destCount = {};
    for (const b of paid) destCount[b.quote.trip.dest.name] = (destCount[b.quote.trip.dest.name] || 0) + 1;
    const alerts = (await this.store.listRecords('alert', { limit: 200 })).filter(a => a.open);
    return {
      days,
      bookingsToday: bookings.filter(b => b.createdAt.slice(0, 10) === t0 && paidStatuses.includes(b.status)).length,
      gbv, revenue, profit, avgBookingValue: paid.length ? Math.round(gbv / paid.length) : 0,
      conversionRate: funnel[0].visitors ? Math.round((funnel[funnel.length - 1].visitors / funnel[0].visitors) * 1000) / 10 : 0,
      failed: inRange.filter(b => b.status === 'failed').length,
      pending: bookings.filter(b => ['pending_payment', 'confirming', 'pending_supplier', 'partially_confirmed'].includes(b.status)).length,
      refundRequests: bookings.filter(b => b.status === 'refund_pending' || b.status === 'partially_confirmed').length,
      flagged: paid.filter(b => b.quote.internal && b.quote.internal.review.flagged).length,
      avgBudget: budgets.length ? Math.round(sum(budgets, x => x) / budgets.length) : 0,
      popular: Object.entries(destCount).sort((a, b) => b[1] - a[1]).slice(0, 6),
      funnel, alerts, demo: this.demo,
    };
  }

  funnel(events) {
    const sets = Object.fromEntries(FUNNEL.map(s => [s, new Set()]));
    for (const e of events) if (sets[e.type]) sets[e.type].add(e.visitor || e.userId || e.id);
    return FUNNEL.map((s, i) => {
      const visitors = sets[s].size;
      const prev = i ? sets[FUNNEL[i - 1]].size : null;
      return { stage: s, label: FUNNEL_LABELS[s], visitors, fromPrevious: prev ? Math.round((visitors / prev) * 1000) / 10 : null, dropOff: prev !== null ? Math.max(0, prev - visitors) : null };
    });
  }

  async findBookings({ q = '', status = '' } = {}) {
    const needle = String(q).trim().toLowerCase().replace(/^trip\s*#?/, '');
    return (await this.store.listBookings({ limit: 5000 })).filter(b => b.vertical === 'trips')
      .filter(b => !status || b.status === status)
      .filter(b => !needle || [b.ref, b.traveler.email, `${b.traveler.firstName} ${b.traveler.lastName}`, b.quote.trip.dest.name].some(v => String(v).toLowerCase().includes(needle)))
      .slice(0, 200);
  }

  async adminSetStatus(ref, status, note, staff) {
    const allowed = ['confirmed', 'partially_confirmed', 'refund_pending', 'refunded', 'cancelled', 'failed'];
    if (!allowed.includes(status)) throw new AppError('invalid_status', 'Choose a valid status.', 422);
    const b = await this.store.getBookingByRef(ref);
    if (!b || b.vertical !== 'trips') throw new AppError('booking_not_found', 'Booking not found.', 404);
    const at = this.now().toISOString();
    await this.store.updateBooking(b.id, b.status, { status, history: [...b.history, { at, status, note: str(note, 300), by: staff.email }] });
    if (['confirmed', 'refunded', 'cancelled'].includes(status)) {
      for (const a of await this.store.listRecords('alert', { limit: 500 })) if (a.ref === ref && a.open) await this.store.putRecord('alert', a.id, { ...a, open: false, closedAt: at });
    }
  }
}

module.exports = { TripService, FUNNEL, FUNNEL_LABELS, watchRule, ruleText, watchMet, WATCH_RULES, WATCH_DEFAULT_RULE, worthItOpen };
