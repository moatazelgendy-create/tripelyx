// The trip optimization engine. Given a budget and a few preferences it builds every sensible
// combination of flight, hotel, experiences and transfer for each destination, prices each one in
// full (taxes, mandatory fees and the service fee included) and picks up to three answers:
//   Our pick   – the trip we'd book: the cheapest of the near-equal strongest fits at or under the budget
//   Save more  – a strong trip that leaves real money unspent, usually somewhere else
//   Upgrade    – only if worth it: costs more and improves something real without giving anything up
// When no upgrade earns its price the result says so (`keepMoney`) instead of filling the third slot.
// The budget is a ceiling, not a target. The constraint is total <= budget unless the traveler
// explicitly allowed up to 10% over, and those trips are always labeled. Ranking only uses
// customer-facing qualities; platform margin is never an input (the internal economics aren't even
// passed in).
const { addDays, daysBetween, today, isIsoDate } = require('../lib/dates');
const { AppError } = require('../lib/errors');
const { priceTrip, roomsFor } = require('./pricing');
const { classifyChanges } = require('./facts');

const STYLES = ['beach', 'city', 'adventure', 'romantic', 'family', 'all-inclusive', 'surprise'];
// The Experience Max memory chips, in the spec's order; experience.js carries their labels and rules.
// They live here so a trip link's `mem=` is validated without optimizer requiring the engine built on it.
const GOAL_KEYS = ['beach', 'food', 'adventure', 'nightlife', 'romantic', 'nature', 'culture', 'family', 'new', 'surprise'];
const ACTIVITY_ID = /^[a-z0-9-]{1,40}$/i;
const PRIORITIES = ['hotel', 'flights', 'longer', 'activities', 'price'];
const WHO_DEFAULT = { solo: 1, couple: 2, family: 4, friends: 4 };
const STYLE_ACTIVITY = { beach: ['beach'], adventure: ['adventure'], romantic: ['romantic', 'beach'], family: ['family', 'beach'], city: ['culture', 'nightlife'] };

// Wrap the integrations so one search never asks a supplier the same question twice.
function memoInventory(inv) {
  const cache = new Map();
  const memo = (obj, fn) => (q) => {
    const k = `${fn}:${JSON.stringify(q)}`;
    if (!cache.has(k)) cache.set(k, obj[fn](q));
    return cache.get(k);
  };
  return {
    ...inv,
    flights: { ...inv.flights, search: memo(inv.flights, 'search') },
    hotels: { ...inv.hotels, search: memo(inv.hotels, 'search') },
    activities: { ...inv.activities, search: memo(inv.activities, 'search') },
    transfers: { ...inv.transfers, quote: memo(inv.transfers, 'quote') },
  };
}

function int(v, def, min, max) {
  if (Array.isArray(v)) return def; // a repeated key (b=100&b=200) is no number: never a joined one
  const n = Number(String(v ?? '').replace(/[,$\s]/g, ''));
  if (!Number.isFinite(n) || v === '' || v === undefined || v === null) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Parse a (query-string) trip search. Returns { query, missing } where `missing` names the questions
// still unanswered, so the planner can ask only those.
function parseSearch(raw = {}, { maps, now = new Date() } = {}) {
  const t = today(now);
  const missing = [];
  const budgetInput = int(raw.b, null, 1, 100000);
  const budgetType = raw.bt === 'pp' ? 'pp' : 'total';
  // Money the traveler wants to keep aside for food and spending; the trip is built around the rest.
  const keepGiven = raw.k !== undefined && raw.k !== '';
  const keep = keepGiven ? int(raw.k, 0, 0, 100000) : 0;
  const who = WHO_DEFAULT[raw.who] ? raw.who : null;
  const travelers = int(raw.n, who ? WHO_DEFAULT[who] : 2, 1, 9);
  const origin = maps && raw.from && maps.getOrigin(String(raw.from).toUpperCase()) ? String(raw.from).toUpperCase() : null;
  const dateMode = ['exact', 'flexible', 'anytime'].includes(raw.when) ? raw.when : null;
  let depart = isIsoDate(raw.depart) ? raw.depart : null;
  if (depart && (depart < addDays(t, 3) || daysBetween(t, depart) > 330)) depart = null;
  let month = /^\d{4}-(0[1-9]|1[0-2])$/.test(raw.month || '') ? raw.month : null;
  if (month && month < t.slice(0, 7)) month = null;
  const nights = int(raw.nights, 5, 2, 14);
  const style = STYLES.includes(raw.style) ? raw.style : null;
  const priority = PRIORITIES.includes(raw.prio) ? raw.prio : null;
  const allowOver = raw.ov === '10' ? 10 : 0;
  // Optional narrowing used by landing pages: one destination, or international trips only.
  const dest = maps && raw.dest && maps.getDestination(String(raw.dest)) ? String(raw.dest) : null;
  const region = raw.region === 'international' ? 'international' : null;
  // The traveler's standing rules (nonstop only, 4-star or better, ...): every package must obey them.
  const rules = parseRules(raw);
  const dests = maps && typeof raw.ds === 'string' ? raw.ds.split(',').filter(d => maps.getDestination(d)).slice(0, 30) : null;
  const notCountry = typeof raw.notc === 'string' && raw.notc ? raw.notc.slice(0, 40) : null;

  if (!budgetInput || budgetInput < 100) missing.push('budget');
  else if (!keepGiven) missing.push('keep');
  else if (budgetInput - keep < 100) missing.push('keep');
  if (!origin) missing.push('from');
  if (!who) missing.push('who');
  else if ((who === 'family' || who === 'friends') && !raw.n) missing.push('n');
  if (!dateMode || (dateMode === 'exact' && !depart) || (dateMode === 'flexible' && !month)) missing.push('when');
  if (!style) missing.push('style');
  if (!priority) missing.push('prio');

  const perPartyInput = budgetInput ? (budgetType === 'pp' ? budgetInput * travelers : budgetInput) : null;
  const vacationBudget = perPartyInput ? perPartyInput * 100 : null;
  const budget = perPartyInput ? Math.max(0, perPartyInput - keep) * 100 : null;
  return {
    query: { budget, vacationBudget, keep: keep * 100, budgetInput, budgetType, travelers, who: who || 'couple', origin, dateMode: dateMode || 'anytime', depart, month, nights, style: style || 'surprise', priority: priority || 'price', allowOver, dest, region, rules, dests: dests && dests.length ? dests : null, notCountry },
    missing,
  };
}

// Standing rules a traveler states once and the search keeps (ns=1 nonstop only, stars=4, ai=1
// all-inclusive, bf=1 breakfast, bch=1 beachfront, tr=1 transfer included, rf=1 refundable).
function parseRules(raw = {}) {
  const on = v => v === '1' || v === 1 || v === true;
  const stars = int(raw.stars, null, 3, 5);
  const rules = { nonstop: on(raw.ns), minStars: stars, allInclusive: on(raw.ai), breakfast: on(raw.bf), beachfront: on(raw.bch), transfer: on(raw.tr), refundable: on(raw.rf) };
  return Object.values(rules).some(Boolean) ? rules : null;
}
function rulesParams(rules) {
  if (!rules) return {};
  return { ns: rules.nonstop ? '1' : undefined, stars: rules.minStars || undefined, ai: rules.allInclusive ? '1' : undefined, bf: rules.breakfast ? '1' : undefined, bch: rules.beachfront ? '1' : undefined, tr: rules.transfer ? '1' : undefined, rf: rules.refundable ? '1' : undefined };
}
function rulesAllowFlight(f, rules) {
  if (!rules) return true;
  if (rules.nonstop && f.stops > 0) return false;
  if (rules.refundable && !f.refundable) return false;
  return true;
}
function rulesAllowHotel(h, rules) {
  if (!rules) return true;
  if (rules.minStars && h.stars < rules.minStars) return false;
  if (rules.allInclusive && !h.features.allInclusive) return false;
  if (rules.breakfast && !h.features.breakfast && !h.features.allInclusive) return false;
  if (rules.beachfront && !h.features.beachfront) return false;
  if (rules.refundable && !h.refundable) return false;
  return true;
}

function searchParams(q, extra = {}) {
  const p = { b: q.budgetInput, k: q.keep !== undefined ? Math.round(q.keep / 100) : undefined, bt: q.budgetType === 'pp' ? 'pp' : undefined, from: q.origin, who: q.who, n: q.travelers, when: q.dateMode, depart: q.dateMode === 'exact' ? q.depart : undefined, month: q.dateMode === 'flexible' ? q.month : undefined, nights: q.nights, style: q.style, prio: q.priority, ov: q.allowOver ? '10' : undefined, dest: q.dest || undefined, region: q.region || undefined, ...rulesParams(q.rules), ds: q.dests && q.dests.length ? q.dests.join(',') : undefined, notc: q.notCountry || undefined, ...extra };
  return new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
}

// The budget context a trip page carries so its numbers can be read against the traveler's budget.
function budgetContext(q) {
  return { budget: q.budget, keep: q.keep || 0, allowOver: q.allowOver, style: q.style, priority: q.priority, nightsAsked: q.nights, rules: q.rules || null };
}

// The same context carried on trip page links (?b=1500&k=300&ov=10&style=beach&prio=hotel&nights=5).
// `b` is the booking budget the trip is read against; `k` is the money the traveler protects for
// the destination, so the whole vacation budget is b + k. The standing rules (ns=1, stars=4, ...)
// ride along too, so a trip link keeps what the traveler said must hold: the money leak hunter and
// the quote read them from here, and a rule is never dropped between pages. Beyond those it carries
// `dm=exact` (a date the traveler said they must leave on, so no page moves it), `bg` (the bag they
// said they travel with: checked, carry-on or personal; '1' means checked), `dest` (a destination
// they named, so a booking can say it was kept; absent when the platform chose it) and `promo` (a
// code the review page verified, so every version opened from it is priced with the same code). A
// repeated key (b=100&b=200) is read as its first value, never joined into one number that would
// then ride on every link and into the quote's asks. Experience Max adds `mem` (the memory goals the
// traveler ranked, `mem=beach,food`, at most three, only the chips the engine knows, in the order
// said) and `px` (the activity id of the main experience they protected): both ride on every link so
// no page forgets what the trip is for, and a protected experience is never offered for removal.
// `locked` (locked=hotel,flight) carries the parts the traveler locked with the agent (the hotel, the flights, the
// dates, the length, the destination) to every page opened from the canvas, so no page offers a version that moves
// one of them: the experience and leak pages read it into the engines' o.locks, and the trip pages' "lk" checkboxes
// (the optimize page's own letters) stay separate. Only the known lock names are read, in one canonical order.
const BAGS = ['personal', 'carry-on', 'checked'], LOCK_NAMES = ['hotel', 'flight', 'dates', 'nights', 'dest'];
function lockList(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v && typeof v === 'object' ? Object.keys(v).filter(k => v[k]) : [];
  const want = new Set(raw.map(x => String(x).trim().toLowerCase()));
  return LOCK_NAMES.filter(k => want.has(k));
}
const parseLocks = v => Object.fromEntries(lockList(typeof v === 'string' ? v : []).map(k => [k, true]));
// `ev`, `evt` and `evn` carry the event the traveler built the trip around with the agent (BUILD AROUND AN EVENT / A
// RESERVATION): its date (ev=2026-11-10), its time slot only when they said one (evt=evening, one of the engine's slot
// names) and a short name (evn=your concert). Without them a page opened from the canvas draws the rhythm with no EVENT
// DAY and could put an experience on the day the traveler already has. The date must be a real calendar date; a slot
// outside the known names is dropped (an unknown time keeps the whole day, never a guessed one); the name keeps letters,
// digits and plain punctuation, at most 40 characters, and is escaped like every other value where it is shown. Anything
// unreadable is dropped, never an error, and an event with no readable date is no event. Whether it is near enough to a
// trip to be read is the page's call (service.eventFor), since only the page knows the trip.
const EVENT_SLOTS = ['morning', 'day', 'evening', 'night'];
const eventWords = v => (typeof v === 'string' ? v.normalize('NFC').replace(/[^\p{L}\p{N} '’&.,-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim() : '');
function parseEvent(date, slot, name) {
  const d = typeof date === 'string' ? date.trim() : '';
  if (!isIsoDate(d)) return null;
  const t = typeof slot === 'string' ? slot.trim().toLowerCase() : '';
  return { name: eventWords(name) || null, date: d, slot: EVENT_SLOTS.includes(t) ? t : null };
}
const eventParams = e => { const ev = e && typeof e === 'object' ? parseEvent(e.date, e.slot, e.name) : null; return ev ? { ev: ev.date, evt: ev.slot || undefined, evn: ev.name || undefined } : {}; };
function parseGoals(v) {
  if (typeof v !== 'string') return [];
  const out = [];
  for (const g of v.split(',').map(x => x.trim().toLowerCase())) if (GOAL_KEYS.includes(g) && !out.includes(g)) out.push(g);
  return out.slice(0, 3);
}
// b= in dollars, whole (b=2000, read as before) or with cents (b=1999.50), into cents, held to $100–$1,000,000. Cents are
// read exactly and anything finer is cut, never rounded up: a ceiling read back higher than it was would let a page
// offer a version over the traveler's maximum.
function budgetCents(v) {
  const t = typeof v === 'string' ? v.trim().replace(/[,$\s]/g, '') : null;
  if (t && /^\d{1,9}\.\d+$/.test(t)) return Math.min(100000000, Math.max(10000, Math.floor(Number(t) * 100 + 1e-6)));
  const d = int(v, null, 100, 1000000);
  return d ? d * 100 : null;
}
function parseContext(raw = {}) {
  const r = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const b = budgetCents(r.b);
  return {
    budget: b, keep: b ? int(r.k, 0, 0, 1000000) * 100 : 0, allowOver: r.ov === '10' ? 10 : 0,
    style: STYLES.includes(r.style) ? r.style : 'surprise', priority: PRIORITIES.includes(r.prio) ? r.prio : 'price',
    nightsAsked: int(r.nights, null, 2, 14) || undefined, searchParams: typeof r.s === 'string' ? r.s.slice(0, 400) : null,
    rules: parseRules(r),
    dateMode: r.dm === 'exact' ? 'exact' : null,
    bags: r.bg === '1' ? 'checked' : BAGS.includes(r.bg) ? r.bg : null,
    dest: typeof r.dest === 'string' && /^[a-z0-9-]{1,40}$/i.test(r.dest) ? r.dest : null,
    promo: typeof r.promo === 'string' && r.promo.trim() ? r.promo.trim().slice(0, 30) : null,
    goals: parseGoals(r.mem),
    protect: typeof r.px === 'string' && ACTIVITY_ID.test(r.px) ? r.px : null,
    locks: parseLocks(r.locked),
    event: parseEvent(r.ev, r.evt, r.evn),
  };
}

// The ceiling rides as dollars, with the cents when it has any (b=1999.50): rounded to whole dollars it could move up
// (a $1,999.50 ceiling read back as $2,000), and every page would then offer versions over the real maximum. The
// maximum is a ceiling, never a target, so it is carried exactly, never rounded up.
const dollarsParam = c => (c % 100 ? (c / 100).toFixed(2) : String(c / 100));
function contextParams(ctx, extra = {}) {
  const goals = parseGoals(Array.isArray(ctx.goals) ? ctx.goals.join(',') : ctx.goals);
  const p = { b: ctx.budget ? dollarsParam(ctx.budget) : undefined, k: ctx.budget && ctx.keep ? Math.round(ctx.keep / 100) : undefined, ov: ctx.allowOver ? '10' : undefined, style: ctx.style && ctx.style !== 'surprise' ? ctx.style : undefined, prio: ctx.priority && ctx.priority !== 'price' ? ctx.priority : undefined, nights: ctx.nightsAsked, s: ctx.searchParams || undefined, ...rulesParams(ctx.rules), dm: ctx.dateMode === 'exact' ? 'exact' : undefined, bg: BAGS.includes(ctx.bags) ? ctx.bags : undefined, dest: ctx.dest || undefined, promo: ctx.promo || undefined, mem: goals.length ? goals.join(',') : undefined, px: typeof ctx.protect === 'string' && ACTIVITY_ID.test(ctx.protect) ? ctx.protect : undefined, locked: lockList(ctx.locks).join(',') || undefined, ...eventParams(ctx.event), ...extra };
  // A list (the customizer's experiences) is repeated, one parameter per item, so the route reads it
  // back as a list; an empty list stays as one empty parameter, which means "none". Joined with commas
  // it would reach the token as a single name and the token would not decode.
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { if (!v.length) out.append(k, ''); else for (const x of v) out.append(k, String(x)); } else out.append(k, String(v));
  }
  return out.toString();
}

// Honest trade-offs for a trip, from facts we have.
function tradeoffs(t, ctx = {}) {
  const out = [];
  if (t.flight.stops > 0) out.push(`${t.flight.stops}-stop flights (${Math.round(t.flight.durationMinutes / 60)}h each way)`);
  if (t.flight.id === 'basic') out.push('Basic fare: personal item only, no changes');
  if (!t.flight.refundable) out.push('Flights not refundable after 24 hours');
  if (t.hotel.stars <= 3) out.push(`${t.hotel.stars}-star hotel`);
  if (!t.hotel.refundable) out.push('Non-refundable hotel rate');
  if (!t.hotel.features.beachfront && t.dest.styles.includes('beach') && ['beach', 'romantic', 'surprise', 'all-inclusive', 'family'].includes(ctx.style || 'surprise')) out.push(`Not beachfront (${t.hotel.area})`);
  if (!t.hotel.features.breakfast && !t.hotel.features.allInclusive) out.push('Breakfast not included');
  if (ctx.nightsAsked && t.spec.nights < ctx.nightsAsked) out.push(`${ctx.nightsAsked - t.spec.nights} night${ctx.nightsAsked - t.spec.nights > 1 ? 's' : ''} shorter than you asked`);
  if (!t.activities.length) out.push('No experiences included yet');
  if (!t.transfer) out.push('Airport transfer not included');
  return out;
}

function scoreTrip(t, ctx) {
  const { budget, style = 'surprise', priority = 'price', nightsAsked = t.spec.nights } = ctx;
  const clamp = (v, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, v));
  const over = budget ? Math.max(0, t.total - budget) / budget : 0;
  const s = {};
  s.budget = budget ? (over === 0 ? 10 : clamp(10 - over * 80)) : 8;
  s.hotel = clamp(t.hotel.stars * 1.2 + t.hotel.rating * 0.8);
  const hours = t.flight.durationMinutes / 60;
  s.flight = clamp((t.flight.stops === 0 ? (t.flight.id === 'basic' ? 8 : 9.6) : (t.flight.id === 'basic' ? 6 : 7.4)) - Math.max(0, hours - 6) * 0.12, 3);
  const beachy = ['beach', 'romantic', 'all-inclusive', 'family', 'surprise'].includes(style) && t.dest.styles.includes('beach');
  s.location = clamp(7.6 + (t.hotel.features.beachfront && beachy ? 2 : 0) + (style === 'city' && !t.hotel.features.beachfront ? 1 : 0) + (t.hotel.features.allInclusive ? 0.3 : 0));
  s.value = clamp(5 + (t.typical / t.total - 1) * 20, 1);
  s.style = style === 'surprise' ? 8 : style === 'all-inclusive' ? (t.hotel.features.allInclusive ? 10 : 4) : t.dest.styles.includes(style) ? 10 : 4;
  s.experiences = clamp((Math.min(t.activities.length, 3) / 3) * 10 + (t.transfer ? 1 : 0));
  const w = { budget: 3, style: 2, hotel: 1.5, flight: 1, location: 1, value: 1.5, experiences: 0.5 };
  const extra = {};
  if (priority === 'hotel') w.hotel += 2.5;
  if (priority === 'flights') w.flight += 2.5;
  if (priority === 'activities') w.experiences += 2.5;
  if (priority === 'price') { w.value += 1; extra.savings = budget ? clamp(((budget - t.total) / budget) * 30) : 5; }
  if (priority === 'longer') extra.length = clamp(5 + (t.spec.nights - nightsAsked) * 2.5);
  const all = { ...s, ...extra };
  const weights = { ...w, ...(extra.savings !== undefined ? { savings: 2 } : {}), ...(extra.length !== undefined ? { length: 2.5 } : {}) };
  let num = 0, den = 0;
  for (const [k, wt] of Object.entries(weights)) { num += all[k] * wt; den += wt; }
  const match = Math.round((num / den) * 10);
  const quality = (s.hotel * 0.45 + s.flight * 0.25 + s.location * 0.15 + s.style * 0.15) * (1 + 0.06 * t.activities.length + (t.transfer ? 0.03 : 0));
  const valueMetric = (quality ** 2 * t.spec.nights) / (t.total / 100);
  const round1 = v => Math.round(v * 10) / 10;
  return {
    match,
    card: { budget: round1(s.budget), hotel: round1(s.hotel), flight: round1(s.flight), location: round1(s.location), value: round1(s.value) },
    valueMetric,
  };
}

// Plain-language reasons a trip was picked, from facts we actually have.
function whyThisTrip(t, ctx) {
  const out = [];
  if (ctx.budget) {
    const diff = ctx.budget - t.total;
    out.push(diff >= 0 ? `Leaves ${fmt(diff)} of your budget unspent` : `${fmt(-diff)} over your budget (you allowed up to 10% more)`);
  }
  if (t.flight.stops === 0) out.push('Nonstop flights');
  out.push(`${t.hotel.stars}-star hotel rated ${t.hotel.rating}/5 (demo supplier rating)`);
  if (t.hotel.features.beachfront) out.push('Beachfront location');
  if (t.hotel.features.allInclusive) out.push('All-inclusive: meals and drinks included');
  else if (t.hotel.features.breakfast) out.push('Breakfast included');
  if (t.hotel.features.freeCancellation) out.push('Free cancellation on the hotel until 72 hours before');
  if (ctx.style && ctx.style !== 'surprise' && t.dest.styles.includes(ctx.style)) out.push(`A strong ${ctx.style === 'city' ? 'city break' : ctx.style} destination`);
  if (t.typical > t.total * 1.05) out.push(`About ${Math.round((1 - t.total / t.typical) * 100)}% below this trip’s typical price (demo price history)`);
  return out.slice(0, 6);
}

// What an upgrade actually buys, in words built from the two trips' facts. Only the kinds in
// REAL_UPGRADE make an upgrade worth showing on their own.
const REAL_UPGRADE = new Set(['hotel', 'flight', 'nights', 'area', 'meals', 'time']);
function upgradeGets(improvements, a, b) {
  const words = {
    hotel: `a ${b.hotel.stars}-star hotel${b.hotel.stars === a.hotel.stars ? ` rated ${b.hotel.rating}/5` : ''}`,
    flight: b.flight.stops === 0 && a.flight.stops > 0 ? 'nonstop flights' : `shorter flights (${Math.round(b.flight.durationMinutes / 60)}h each way)`,
    nights: `${b.spec.nights} nights instead of ${a.spec.nights}`,
    area: 'a beachfront hotel',
    meals: b.hotel.features.allInclusive ? 'meals and drinks included' : 'breakfast included',
    time: 'more usable vacation time',
    experiences: b.activities.length > a.activities.length ? `${b.activities.length - a.activities.length} more experience${b.activities.length - a.activities.length === 1 ? '' : 's'}` : 'more experiences',
    transfer: 'an airport transfer',
    bags: b.flight.checkedBagIncluded || b.spec.bags ? 'checked bags' : b.flight.carryOn && !a.flight.carryOn ? 'a carry-on bag' : 'more baggage allowance',
    flex: 'more flexible cancellation',
  };
  const order = ['hotel', 'flight', 'nights', 'area', 'meals', 'time', 'experiences', 'transfer', 'bags', 'flex'];
  const parts = order.filter(k => improvements.some(r => r.key === k)).map(k => words[k]).slice(0, 3);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function fmt(cents) {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

function candidateDates(inv, q, airport, destId, now) {
  const t = today(now);
  if (q.dateMode === 'exact') return [q.depart];
  let days = [];
  if (q.dateMode === 'flexible') {
    const first = `${q.month}-01`;
    for (let d = first; d.slice(0, 7) === q.month; d = addDays(d, 1)) if (d >= addDays(t, 7)) days.push(d);
  } else {
    for (let i = 14; i <= 150; i += 2) days.push(addDays(t, i));
  }
  if (!days.length) return [];
  const priced = days.map(d => {
    const f = inv.flights.search({ from: airport, destId, depart: d, nights: q.nights, travelers: q.travelers });
    return { d, p: f.length ? Math.min(...f.map(x => x.farePerTraveler)) : Infinity };
  }).filter(x => x.p < Infinity).sort((a, b) => a.p - b.p);
  return priced.slice(0, 2).map(x => x.d);
}

function hotelAllowed(h, q) {
  if (q.who === 'family' && h.features.adultsOnly) return false;
  if (q.style === 'all-inclusive' && !h.features.allInclusive) return false;
  return true;
}

function activitySets(acts, style) {
  const pref = STYLE_ACTIVITY[style] || [];
  const sorted = [...acts].sort((a, b) => (pref.includes(b.kind) - pref.includes(a.kind)) || a.pricePerPerson - b.pricePerPerson);
  return [[], sorted.slice(0, 1).map(a => a.id), sorted.slice(0, 2).map(a => a.id)].filter((s, i, arr) => i === 0 || s.length > arr[i - 1].length);
}

// Every priced package for one destination.
function packagesFor(inv, q, dest, airport, settings, now) {
  if (q.style !== 'surprise' && q.style !== 'all-inclusive' && !dest.styles.includes(q.style)) return [];
  const nightsList = q.priority === 'longer' ? [q.nights, q.nights + 1, q.nights + 2].filter(n => n <= 14) : [q.nights];
  const out = [];
  for (const depart of candidateDates(inv, q, airport, dest.id, now)) {
    for (const nights of nightsList) {
      const base = { dest: dest.id, from: airport, depart, nights, travelers: q.travelers, who: q.who };
      const flights = inv.flights.search({ from: airport, destId: dest.id, depart, nights, travelers: q.travelers }).filter(f => rulesAllowFlight(f, q.rules));
      const hotels = inv.hotels.search({ destId: dest.id, checkIn: depart, nights, rooms: roomsFor(base) }).filter(h => hotelAllowed(h, q) && rulesAllowHotel(h, q.rules));
      const acts = inv.activities.search({ destId: dest.id, date: depart, travelers: q.travelers });
      const transfers = q.rules && q.rules.transfer ? [true] : [false, true];
      for (const f of flights) for (const h of hotels) for (const a of activitySets(acts, q.style)) for (const transfer of transfers) {
        const t = priceTrip(inv, { ...base, flight: f.id, hotel: h.id, activities: a, bags: false, transfer }, settings);
        if (t) out.push(t);
      }
    }
  }
  return out;
}

// Demo data spells the United States two ways; a real maps provider will not.
const sameCountry = (a, b) => { const n = s => (/^(usa|united states)$/i.test(String(s).trim()) ? 'united states' : String(s).trim().toLowerCase()); return n(a) === n(b); };

function search(inventory, rawQuery, { settings, now = new Date() }) {
  const inv = memoInventory(inventory);
  const q = rawQuery;
  if (!q.budget || !q.origin) throw new AppError('invalid_search', 'Tell us your budget and where you’re leaving from.', 422);
  const origin = inv.maps.getOrigin(q.origin);
  const airport = origin.airports[0].code;
  const ctx = budgetContext(q);
  const disabled = new Set(settings.disabledDestinations || []);
  const all = [];
  for (const dest of inv.maps.listDestinations()) {
    if (disabled.has(dest.id)) continue;
    if (q.dest && dest.id !== q.dest) continue;
    if (q.dests && !q.dests.includes(dest.id)) continue;
    if (q.notCountry && sameCountry(dest.country, q.notCountry)) continue;
    if (q.region === 'international' && sameCountry(dest.country, origin.country || 'United States')) continue;
    for (const t of packagesFor(inv, q, dest, airport, settings, now)) {
      const sc = scoreTrip(t, ctx);
      all.push({ trip: t, ...sc, why: whyThisTrip(t, ctx) });
    }
  }
  const cap = Math.round(q.budget * (1 + q.allowOver / 100));
  const eligible = all.filter(x => x.trip.total <= cap);
  const destsConsidered = new Set(all.map(x => x.trip.dest.id)).size;

  // Prefer a different destination than the ones already picked, but never return nothing when
  // the only strong candidates share one.
  const pick = (list, key, avoid = []) => {
    const sorted = [...list].sort((a, b) => key(b) - key(a) || a.trip.total - b.trip.total);
    return sorted.find(x => !avoid.includes(x.trip.dest.id)) || sorted[0] || null;
  };
  let picks = [];
  let keepMoney = null;
  if (eligible.length) {
    const byMatch = (a, b) => b.match - a.match || a.trip.total - b.trip.total;
    // Our pick: among trips at or under the budget itself, the top match; then the cheapest of those
    // within 3 points of it. Only when nothing fits the budget does the allowed 10% come into play,
    // and that pick is flagged so the page never calls it within budget.
    const under = eligible.filter(x => x.trip.total <= q.budget);
    let ourPick;
    if (under.length) {
      const top = [...under].sort(byMatch)[0];
      ourPick = under.filter(x => x.match >= top.match - 3).sort((a, b) => a.trip.total - b.trip.total || b.match - a.match)[0];
    } else {
      ourPick = { ...[...eligible].sort(byMatch)[0], over: true };
    }
    const ours = ourPick.trip;

    // Save more: a strong trip that is clearly cheaper, preferably somewhere else.
    const strongCheaper = eligible.filter(x => x.trip.total < ours.total && (x.trip.total <= Math.round(q.budget * 0.85) || x.trip.total <= ours.total * 0.9) && x.match >= 55);
    let saveMore = pick(strongCheaper, x => x.match, [ours.dest.id]);
    if (!saveMore) saveMore = pick(eligible.filter(x => x.trip.total <= ours.total * 0.95 && x.match >= 50), x => -x.trip.total, [ours.dest.id]);

    // Upgrade, only if worth it: judged with the budget taken out of the score, it must improve at
    // least one thing and give nothing up, cost at most 35% more, and improve something that is
    // not just an activity or a transfer.
    const qctx = { ...ctx, budget: null };
    const baseMatch = scoreTrip(ours, qctx).match;
    const dearer = eligible.filter(x => x.trip.total > ours.total);
    const improved = dearer.map(x => ({ ...x, changes: classifyChanges(ours, x.trip), plainMatch: scoreTrip(x.trip, qctx).match }))
      .filter(x => x.changes.improvements.length >= 1 && x.changes.tradeoffs.length === 0 && x.plainMatch > baseMatch);
    const worthIt = improved.filter(x => x.trip.total - ours.total <= ours.total * 0.35 && x.changes.improvements.some(r => REAL_UPGRADE.has(r.key)));
    let upgrade = null;
    if (worthIt.length) {
      const topPlain = Math.max(...worthIt.map(x => x.plainMatch));
      const pool = worthIt.filter(x => x.plainMatch >= topPlain - 2);
      const sameDest = pool.filter(x => x.trip.dest.id === ours.dest.id);
      const cand = (sameDest.length ? sameDest : pool).sort((a, b) => a.trip.total - b.trip.total || b.plainMatch - a.plainMatch)[0];
      const delta = cand.trip.total - ours.total;
      const gets = upgradeGets(cand.changes.improvements, ours, cand.trip);
      upgrade = { ...cand, upgrade: { delta, improvements: cand.changes.improvements, gets, over: cand.trip.total > q.budget }, blurb: `+${fmt(delta)} gets ${gets}.` };
    } else {
      // Why each dearer trip that improved something was still not worth it: it asked more than a
      // third more, or it only added an extra the traveler can add themselves.
      const tooDear = improved.filter(x => x.trip.total - ours.total > ours.total * 0.35).length;
      keepMoney = { considered: dearer.length, spare: q.budget - ours.total, dear: improved.length, tooDear, extras: improved.length - tooDear };
    }

    picks = [
      { kind: 'our-pick', label: 'Our pick', blurb: ourPick.over ? 'The best fit we built; it needs the extra you allowed.' : 'The trip we’d book: the strongest fit for what you told us, at the lowest price that fit earns.', ...ourPick },
      saveMore && { kind: 'save-more', label: 'Save more', blurb: 'A strong trip that leaves real money unspent.', ...saveMore },
      upgrade && { kind: 'upgrade', label: 'Upgrade, only if worth it', ...upgrade },
    ].filter(Boolean);
    // Never show the same package twice.
    const seen = new Set();
    picks = picks.filter(p => { const k = JSON.stringify(p.trip.spec); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  let closest = [];
  if (!eligible.length && all.length) {
    const byDest = new Map();
    for (const x of [...all].sort((a, b) => a.trip.total - b.trip.total)) if (!byDest.has(x.trip.dest.id)) byDest.set(x.trip.dest.id, x);
    closest = [...byDest.values()].slice(0, 3);
  }
  const cheapest = all.length ? Math.min(...all.map(x => x.trip.total)) : null;
  const cheapestEligible = eligible.length ? [...eligible].sort((a, b) => a.trip.total - b.trip.total)[0] : null;
  const cheapestByDest = {};
  for (const x of all) if (!(x.trip.dest.id in cheapestByDest) || x.trip.total < cheapestByDest[x.trip.dest.id]) cheapestByDest[x.trip.dest.id] = x.trip.total;
  const eligibleDestinations = new Set(eligible.map(x => x.trip.dest.id)).size;
  const cheaperThanPick = picks[0] ? eligible.filter(x => x.trip.total < picks[0].trip.total).length : 0;
  // The eligible set itself, for callers that need more than the three picks (Save Max names the
  // cheapest trip it would still recommend from it): every eligible candidate at or under the budget
  // itself, cheapest first, and the eligible trips within $50 of the pick's price, strongest first,
  // at most 40. Both hold references to the packages priced above; nothing is priced again.
  const eligibleTrips = eligible.filter(x => x.trip.total <= q.budget).sort((a, b) => a.trip.total - b.trip.total).map(x => ({ trip: x.trip, match: x.match }));
  const near = picks[0] ? eligible.filter(x => x.trip !== picks[0].trip && Math.abs(x.trip.total - picks[0].trip.total) <= 5000).sort((a, b) => b.match - a.match || a.trip.total - b.trip.total).slice(0, 40).map(x => ({ trip: x.trip, match: x.match })) : [];
  return { query: q, ctx, picks, keepMoney, closest, cheapest, cheapestEligible, cheapestByDest, considered: all.length, eligible: eligible.length, cheaperThanPick, destinations: destsConsidered, eligibleDestinations, airport, eligibleTrips, near };
}

// Journey B: a dream destination and a maximum budget. Returns the strongest trip to that destination
// regardless of price (`best`), the best one that fits (`under`, when any does) and the gap to close.
function dreamSearch(inventory, rawQuery, destId, { settings, now = new Date() }) {
  const inv = memoInventory(inventory);
  const q = { ...rawQuery, dest: destId, region: null };
  if (!q.budget || !q.origin) throw new AppError('invalid_search', 'Tell us your budget and where you’re leaving from.', 422);
  const dest = inv.maps.getDestination(destId);
  if (!dest || (settings.disabledDestinations || []).includes(destId)) return { best: null, under: null, gap: 0 };
  const origin = inv.maps.getOrigin(q.origin);
  const airport = origin.airports[0].code;
  const ctx = { ...budgetContext(q), budget: null }; // score the dream without the budget penalty
  const all = packagesFor(inv, { ...q, style: dest.styles.includes(q.style) ? q.style : 'surprise' }, dest, airport, settings, now).map(t => ({ trip: t, ...scoreTrip(t, ctx), why: whyThisTrip(t, budgetContext(q)) }));
  if (!all.length) return { best: null, under: null, gap: 0 };
  const byMatch = (a, b) => b.match - a.match || a.trip.total - b.trip.total;
  // "Dream version": a strong trip (4-star or better where the destination has one), and among the
  // strongest fits the cheapest, so the gap to close is real rather than the most lavish option.
  const strong = (all.some(x => x.trip.hotel.stars >= 4) ? all.filter(x => x.trip.hotel.stars >= 4) : all).sort(byMatch);
  const best = strong.filter(x => x.match >= strong[0].match - 8).sort((a, b) => a.trip.total - b.trip.total)[0];
  const fits = all.filter(x => x.trip.total <= q.budget).sort(byMatch);
  const under = fits[0] || null;
  const gap = Math.max(0, best.trip.total - q.budget);
  return { best, under, gap: under && under.trip.spec === best.trip.spec ? 0 : gap };
}

// Customizer: the price of every single change the traveler can make to a trip.
function customizerOptions(inventory, t, settings, now = new Date()) {
  const inv = memoInventory(inventory);
  const s = t.spec;
  const price = spec => priceTrip(inv, spec, settings);
  const delta = spec => { const p = price(spec); return p ? { total: p.total, delta: p.total - t.total } : null; };
  const hotels = t.hotelOptions.filter(h => !(s.who === 'family' && h.features.adultsOnly)).map(h => ({ hotel: h, ...delta({ ...s, hotel: h.id }) })).filter(x => x.total !== undefined);
  const flights = t.flightOptions.map(f => ({ flight: f, ...delta({ ...s, flight: f.id }) })).filter(x => x.total !== undefined);
  const nights = [];
  for (let n = Math.max(2, s.nights - 2); n <= Math.min(14, s.nights + 3); n++) {
    const p = price({ ...s, nights: n });
    if (p) nights.push({ nights: n, total: p.total, perNight: p.perNight, delta: p.total - t.total });
  }
  const activities = t.activityOptions.map(a => ({ activity: a, selected: s.activities.includes(a.id), cost: a.pricePerPerson * s.travelers }));
  const transferQuote = inv.transfers.quote({ destId: s.dest, travelers: s.travelers });
  const transfer = transferQuote ? { quote: transferQuote, ...delta({ ...s, transfer: !s.transfer }) } : null;
  const bags = t.flight.checkedBagIncluded ? null : delta({ ...s, bags: !s.bags });
  const dates = [];
  const t0 = addDays(today(now), 3);
  for (const off of [-3, -2, -1, 1, 2, 3]) {
    const d = addDays(s.depart, off);
    if (d < t0) continue;
    const p = price({ ...s, depart: d });
    if (p) dates.push({ depart: d, total: p.total, delta: p.total - t.total });
  }
  return { hotels, flights, nights, activities, transfer, bags, dates };
}


// One rule away: when nothing fits, re-run the search with exactly one of the traveler's rules
// relaxed and report only the relaxations that really produce a trip, with its real price. A rule
// that does not get there on its own is named as such; nothing is suggested that was not priced.
const STYLE_WORD = { beach: 'a beach trip', city: 'a city break', adventure: 'an adventure trip', romantic: 'a romantic trip', family: 'a family trip', 'all-inclusive': 'an all-inclusive trip' };
const PRIO_WORD = { hotel: 'the hotel', flights: 'nonstop flights', activities: 'experiences', longer: 'a longer trip' };
const monthName = m => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
function oneRuleAway(inventory, q, { settings, now = new Date() }) {
  const candidates = [
    q.dateMode !== 'anytime' && { key: 'dates', rule: q.dateMode === 'exact' ? 'your exact dates' : `travel in ${monthName(q.month)}`, label: 'Any dates in the next few months', q: { ...q, dateMode: 'anytime', depart: null, month: null } },
    q.nights > 2 && { key: 'nights', rule: `${q.nights} nights`, label: `${q.nights - 1} nights instead of ${q.nights}`, q: { ...q, nights: q.nights - 1 } },
    q.nights > 3 && { key: 'nights2', rule: `${q.nights} nights`, label: `${q.nights - 2} nights instead of ${q.nights}`, q: { ...q, nights: q.nights - 2 } },
    q.style !== 'surprise' && { key: 'style', rule: STYLE_WORD[q.style] || q.style, label: `Any style, not only ${STYLE_WORD[q.style] || q.style}`, q: { ...q, style: 'surprise' } },
    q.priority !== 'price' && { key: 'prio', rule: `${PRIO_WORD[q.priority] || q.priority} first`, label: `Lowest price first, instead of ${PRIO_WORD[q.priority] || q.priority}`, q: { ...q, priority: 'price' } },
    q.rules && q.rules.nonstop && { key: 'nonstop', rule: 'nonstop flights only', label: 'Allow one stop', q: { ...q, rules: { ...q.rules, nonstop: false } } },
    q.rules && q.rules.minStars && { key: 'stars', rule: `${q.rules.minStars}-star hotels or better`, label: 'Any star class', q: { ...q, rules: { ...q.rules, minStars: null } } },
    !q.allowOver && { key: 'over', rule: 'your budget as a hard ceiling', label: 'Up to 10% over your budget', q: { ...q, allowOver: 10 } },
    q.keep > 0 && { key: 'keep', rule: `${fmt(q.keep)} protected for the destination`, label: 'Part of your reserve', q: { ...q, budget: q.budget + q.keep, keep: 0 } },
  ].filter(Boolean);
  const works = [];
  const notAlone = [];
  for (const c of candidates) {
    const r = search(inventory, c.q, { settings, now });
    const pick = r.picks[0];
    if (!pick) { notAlone.push({ key: c.key, label: c.label }); continue; }
    const total = pick.trip.total;
    let out = { key: c.key, rule: c.rule, label: c.label, total, dest: pick.trip.dest.name, nights: pick.trip.spec.nights, over: Math.max(0, total - q.budget), params: searchParams(c.q) };
    if (c.key === 'keep') {
      // Offer exactly the part of the reserve the pick needs, so the booking budget it is read
      // against is the one the traveler agreed to, and the rest stays protected. The page the
      // offer links to is searched again at that budget and the offer names that page's pick:
      // a smaller budget can change the pick, so repeat until the pick and the amount agree.
      const need = total => Math.ceil((total - q.budget) / 100) * 100; // whole dollars, rounded up, so the pick fits the budget it is read against
      let used = need(total);
      let landed = null;
      for (let i = 0; i < 8 && used > 0 && used <= q.keep; i++) {
        const rq = { ...q, budget: q.budget + used, keep: q.keep - used };
        const p = search(inventory, rq, { settings, now }).picks[0];
        if (!p) break;
        const again = need(p.trip.total);
        if (again === used) { landed = { rq, trip: p.trip }; break; }
        used = again;
      }
      if (!landed) { notAlone.push({ key: c.key, label: c.label }); continue; }
      out = { ...out, label: `Use ${fmt(used)} of the ${fmt(q.keep)} you protected`, used, total: landed.trip.total, dest: landed.trip.dest.name, nights: landed.trip.spec.nights, over: 0, params: searchParams(landed.rq) };
    }
    works.push(out);
  }
  works.sort((a, b) => a.over - b.over || a.total - b.total);
  return { works, notAlone };
}

module.exports = { search, dreamSearch, oneRuleAway, parseSearch, searchParams, budgetContext, parseContext, contextParams, parseGoals, parseLocks, lockList, LOCK_NAMES, parseEvent, EVENT_SLOTS, parseRules, rulesParams, rulesAllowFlight, rulesAllowHotel, sameCountry, tradeoffs, scoreTrip, whyThisTrip, customizerOptions, memoInventory, activitySets, hotelAllowed, candidateDates, packagesFor, int, STYLES, PRIORITIES, WHO_DEFAULT, GOAL_KEYS };
