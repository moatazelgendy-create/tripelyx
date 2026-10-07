// One number, three vacations. The customer gives a budget and this module builds three meaningfully
// different strategies for it, each a package the inventory actually priced and never a cent over:
//   more     More vacation: the strongest trip that fits, preferring more nights and more included
//   keep     Keep more: a strong, different trip at or under 80% of the budget (keep = budget - total)
//   special  Make it special: a real step up in the stay (hotel class, meals, the beach) or in what is
//            included, relative to More; never dearer for a trivial difference
// It also pushes in the direction the customer chose (three variants), builds a genuinely different
// set after "none of these", mixes the hotel of one trip with the flight of another, and says what a
// higher or lower budget really changes. Nothing here is estimated: every number is a priced package
// (pricing.priceTrip, decision.nameYourPrice), every difference is said in words from the trips' facts,
// and a rule the customer set (a lock, an exact date, a chosen month, a stated length, a rejected
// destination or hotel) is never relaxed by the engine on its own: a variant a rule forbids is named
// in `missing` with that rule, never built.
const { addDays, daysBetween, today } = require('../lib/dates');
const { AppError } = require('../lib/errors');
const { format } = require('../lib/money');
const { priceTrip, roomsFor } = require('./pricing');
const { encodeSpec, decodeSpec } = require('./spec');
const { memoInventory, scoreTrip, candidateDates, activitySets, hotelAllowed, rulesAllowFlight, rulesAllowHotel, sameCountry, budgetContext } = require('./optimizer');
const { classifyChanges, nameYourPrice } = require('./decision');

const LABELS = { more: 'More vacation', keep: 'Keep more', special: 'Make it special' };
const KEYS = Object.keys(LABELS);
const KEEP_SHARE = 0.8; // Keep more aims at or under this share of the budget
const BAND = 3;         // near-equal strongest fits: within this many match points of the top, as the optimizer's pick
const NO_RULES = { nonstop: false, minStars: null, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false };
const LOCKED = { hotel: 'The hotel is locked', flight: 'The flights are locked', dates: 'The dates are locked', nights: 'The length is locked', dest: 'The destination is locked' };
const WHO_WORD = { solo: 'a solo traveler', couple: 'a couple', family: 'a family', friends: 'friends' };
const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hours = m => `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}`;
const list = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const MEALS = h => (h.features.allInclusive ? 2 : h.features.breakfast ? 1 : 0);
const mealWord = h => (h.features.allInclusive ? 'all-inclusive' : h.features.breakfast ? 'breakfast included' : 'no meals included');
const included = t => MEALS(t.hotel) + t.activities.length + (t.transfer ? 1 : 0);
const range = (a, b) => { const out = []; for (let n = Math.max(2, a); n <= Math.min(14, b); n++) out.push(n); return out; };
const contexts = q => { const ctx = { ...budgetContext(q), rules: q.rules || null }; return { ctx, plain: { ...ctx, budget: null, allowOver: 0 } }; };
const tripOf = x => (x && x.trip) || x;
const specOf = x => { const t = tripOf(x); return (t && t.spec) || t || null; };
const exclusions = e => ({ dests: (e && e.dests) || [], tokens: (e && e.tokens) || [], hotels: (e && e.hotels) || [] });

// The shape of a package: destination, hotel, flight and length. Two packages of one shape are the same
// trip to the customer even when a date or an added experience differs, so "already shown" is judged
// by shape, never only by the exact token. A token that cannot be read excludes nothing.
const shapeKey = s => `${s.dest}|${s.hotel}|${s.flight}|${s.nights}`;
const shapesOf = tokens => new Set(tokens.map(tok => { try { return shapeKey(decodeSpec(tok)); } catch (e) { return null; } }).filter(Boolean));
function excluder(exclude) {
  const { tokens } = exclusions(exclude), skip = new Set(tokens), shapes = shapesOf(tokens);
  return t => skip.has(encodeSpec(t.spec)) || shapes.has(shapeKey(t.spec));
}

// Which part the customer locked differs between the current trip and t, or null when none does: the
// hotel, the flights, the destination, the length, or the dates (the departure, and the length too,
// since the return date is part of the dates). Both arguments may be priced trips, packed trips or specs.
function lockCrossed(cur, t, locks = {}) {
  const a = specOf(cur), b = specOf(t);
  if (!a || !b || !locks) return null;
  if (locks.hotel && a.hotel !== b.hotel) return 'hotel';
  if (locks.flight && a.flight !== b.flight) return 'flight';
  if (locks.dest && a.dest !== b.dest) return 'dest';
  if (locks.nights && a.nights !== b.nights) return 'nights';
  if (locks.dates && (a.depart !== b.depart || a.nights !== b.nights)) return 'dates';
  return null;
}
const crossesLock = (cur, t, locks) => lockCrossed(cur, t, locks) !== null;

// The exact words differences() uses for the length, so a caller can take that one phrase out.
const nightsPhrase = (a, b) => `${plural(a.spec.nights, 'night')} instead of ${b.spec.nights}`;

// How trip a differs from trip b, in words, from facts only. Destination, nights, hotel class, meals,
// the beach and nonstop make a different stay; a transfer or experiences only change what is included.
function differences(a, b) {
  const stay = [], extras = [];
  if (a.dest.id !== b.dest.id) stay.push(`${a.dest.name} instead of ${b.dest.name}`);
  if (a.spec.nights !== b.spec.nights) stay.push(nightsPhrase(a, b));
  if (a.hotel.stars !== b.hotel.stars) stay.push(`a ${a.hotel.stars}-star hotel instead of ${b.hotel.stars}-star`);
  if (MEALS(a.hotel) !== MEALS(b.hotel)) stay.push(`${mealWord(a.hotel)} instead of ${mealWord(b.hotel)}`);
  if (a.hotel.features.beachfront !== b.hotel.features.beachfront) stay.push(a.hotel.features.beachfront ? 'a beachfront hotel' : 'not on the beach');
  if ((a.flight.stops === 0) !== (b.flight.stops === 0)) stay.push(a.flight.stops === 0 ? 'nonstop flights' : `${a.flight.stops}-stop flights`);
  if (!!a.transfer !== !!b.transfer) extras.push(a.transfer ? 'airport transfer included' : 'no airport transfer');
  if (a.activities.length !== b.activities.length) extras.push(`${plural(a.activities.length, 'experience')} included instead of ${b.activities.length}`);
  return { stay, extras, all: [...stay, ...extras] };
}
const meaningful = (a, b) => differences(a, b).all.length > 0;

// The facts of one trip, as a strategy card shows them: nothing about taste, nothing estimated.
function facts(t, budget) {
  const f = t.flight, h = t.hotel;
  const out = [`${plural(t.spec.nights, 'night')} in ${t.dest.name}, ${t.dest.country}`, `${f.stops === 0 ? 'Nonstop' : `${f.stops}-stop`} flights, ${hours(f.durationMinutes)} each way`];
  if (!f.carryOn) out.push(`${f.name} fare: personal item only`);
  out.push(`${h.name}: ${h.stars}-star, ${h.area}`, h.features.allInclusive ? 'All-inclusive: meals and drinks included' : h.features.breakfast ? 'Breakfast included' : 'Meals not included');
  if (t.transfer) out.push('Airport transfer included, both ways');
  if (t.activities.length) out.push(`Includes ${list(t.activities.map(a => a.name))}`);
  out.push(`${fmt(t.total)} total with every tax and fee; leaves ${fmt(budget - t.total)} of your ${fmt(budget)}`);
  return out;
}

// What t has over base, in words, from facts only. A rating tick or a same-class hotel swap is not a
// gain: `stay` is a better hotel class, more meals or the beach; `extras` a transfer or experiences;
// `travel` more nights or fewer stops.
function gains(base, t) {
  const stay = [], extras = [], travel = [];
  if (t.spec.nights > base.spec.nights) travel.push(plural(t.spec.nights - base.spec.nights, 'more night'));
  if (t.flight.stops < base.flight.stops) travel.push(t.flight.stops === 0 ? 'nonstop flights' : `${t.flight.stops}-stop flights instead of ${base.flight.stops}-stop`);
  if (t.hotel.stars > base.hotel.stars) stay.push(`a ${t.hotel.stars}-star hotel instead of ${base.hotel.stars}-star`);
  if (MEALS(t.hotel) > MEALS(base.hotel)) stay.push(mealWord(t.hotel));
  if (t.hotel.features.beachfront && !base.hotel.features.beachfront) stay.push('a beachfront hotel');
  if (t.transfer && !base.transfer) extras.push('an airport transfer');
  if (t.activities.length > base.activities.length) extras.push(plural(t.activities.length - base.activities.length, 'more experience'));
  return { stay, extras, travel, all: [...travel, ...stay, ...extras] };
}

// The step up Make it special is allowed to pay for: a better stay or more included, with nothing else
// getting worse (flights, hotel, meals, bags, cancellation, usable time). Extras may go when the stay
// steps up, never the other way round. Fewer nights only when the nights asked for are still met, and
// less usable time only when it follows from those fewer nights alone: the flight schedule must be the
// base's (the same flight, or identical times), otherwise the lost time is the schedule's, not the length's.
const SCHEDULE = ['departMinutes', 'arriveMinutes', 'returnDepartMinutes', 'arrivesNextDay'];
const sameSchedule = (a, b) => (a.flight.id === b.flight.id && a.dest.id === b.dest.id) || SCHEDULE.every(k => a.flight[k] === b.flight[k]);
function stepUp(base, t, nightsAsked) {
  const { stay, extras } = gains(base, t);
  if (!stay.length && !extras.length) return null;
  const allowed = new Set(stay.length ? ['experiences', 'transfer'] : []);
  if (t.spec.nights < base.spec.nights && t.spec.nights >= nightsAsked) { allowed.add('nights'); if (sameSchedule(base, t)) allowed.add('time'); }
  const worse = classifyChanges(base, t).tradeoffs.filter(r => !allowed.has(r.key));
  return worse.length ? null : { stay, extras };
}

// Every package the optimizer would price for these lengths, under the same rules and filters it
// applies (mirrors its packagesFor, which is not exported), minus the destinations and hotels a
// "try again" or a rejection excludes.
// `protect` (Experience Max: the main experience the customer protected, an activity id) keeps every
// package on it: destinations that do not offer it are left out and every activity set carries it,
// so no strategy, variant or budget note is ever a version without the experience they protected.
const withProtect = (sets, protect) => { const seen = new Set(), out = []; for (const a of [[protect], ...sets.map(x => [...new Set([...x, protect])])]) { const k = [...a].sort().join(','); if (!seen.has(k)) { seen.add(k); out.push(a); } } return out; };
function buildPool(inv, q, nightsList, { settings, now, exclude, protect = null }) {
  const origin = inv.maps.getOrigin(q.origin);
  const airport = origin.airports[0].code;
  const ex = exclusions(exclude);
  const disabled = new Set(settings.disabledDestinations || []), skipDest = new Set(ex.dests), skipHotel = new Set(ex.hotels);
  const out = [];
  for (const dest of inv.maps.listDestinations()) {
    if (disabled.has(dest.id) || skipDest.has(dest.id) || (q.dest && dest.id !== q.dest) || (q.dests && !q.dests.includes(dest.id))) continue;
    if (q.notCountry && sameCountry(dest.country, q.notCountry)) continue;
    if (q.region === 'international' && sameCountry(dest.country, origin.country || 'United States')) continue;
    if (q.style !== 'surprise' && q.style !== 'all-inclusive' && !dest.styles.includes(q.style)) continue;
    for (const nights of nightsList) for (const depart of candidateDates(inv, { ...q, nights }, airport, dest.id, now)) {
      const base = { dest: dest.id, from: airport, depart, nights, travelers: q.travelers, who: q.who };
      const flights = inv.flights.search({ from: airport, destId: dest.id, depart, nights, travelers: q.travelers }).filter(f => rulesAllowFlight(f, q.rules));
      const hotels = inv.hotels.search({ destId: dest.id, checkIn: depart, nights, rooms: roomsFor(base) }).filter(h => hotelAllowed(h, q) && rulesAllowHotel(h, q.rules) && !skipHotel.has(h.id));
      const acts = inv.activities.search({ destId: dest.id, date: depart, travelers: q.travelers });
      if (protect && !acts.some(a => a.id === protect)) continue;
      const transfers = q.rules && q.rules.transfer ? [true] : [false, true];
      const sets = protect ? withProtect(activitySets(acts, q.style), protect) : activitySets(acts, q.style);
      for (const f of flights) for (const h of hotels) for (const a of sets) for (const transfer of transfers) {
        const t = priceTrip(inv, { ...base, flight: f.id, hotel: h.id, activities: a, bags: false, transfer }, settings);
        if (t) out.push(t);
      }
    }
  }
  return out;
}
const keepsProtected = (t, protect) => !protect || t.spec.activities.includes(protect);

// Candidates at or under `cap`, minus what `skip` leaves out: a trip over the ceiling is never a
// strategy. `match` is the fit the rest of the product shows (budget included); `plain` is the trip's
// own strength, price taken out, so that cheapness decides only where the strategy is about cheapness.
function candidates(trips, cap, { ctx, plain }, skip = () => false) {
  return trips.filter(t => t.total <= cap && !skip(t)).map(t => ({ trip: t, token: encodeSpec(t.spec), total: t.total, match: scoreTrip(t, ctx).match, plain: scoreTrip(t, plain).match }));
}

// The optimizer's way of picking: everything within BAND points of the strongest is near-equal, and
// `order` decides among those (cheapest, fullest, ...), so a point of score never buys a dearer trip.
function strongest(cands, order, band = BAND) {
  if (!cands.length) return null;
  const top = Math.max(...cands.map(c => c.plain));
  return cands.filter(c => c.plain >= top - band).sort(order)[0];
}
const cheapest = (a, b) => a.total - b.total || b.plain - a.plain;
const fullest = (a, b) => b.trip.spec.nights - a.trip.spec.nights || included(b.trip) - included(a.trip) || cheapest(a, b);
const excitement = t => (t.hotel.features.allInclusive ? 2 : 0) + (t.hotel.features.beachfront ? 1 : 0) + Math.min(2, t.activities.length) + (t.dest.passportRequired ? 1 : 0);
const PREFER = { 'shorter-flights': (a, b) => a.trip.flight.durationMinutes - b.trip.flight.durationMinutes, exciting: (a, b) => excitement(b.trip) - excitement(a.trip) };
const withPrefer = (prefer, base) => (prefer && PREFER[prefer] ? (a, b) => PREFER[prefer](a, b) || base(a, b) : base);

// Which strategy the engine would start with: the best match for what the customer told us (ties to
// the cheaper), with the facts that set it apart from the others. No taste words.
function choosePick(strategies, q) {
  if (!strategies.length) return null;
  const best = [...strategies].sort((a, b) => b.match - a.match || a.total - b.total)[0];
  const others = strategies.filter(s => s !== best), t = best.trip, reasons = [];
  const mostNights = Math.max(0, ...others.map(o => o.trip.spec.nights));
  if (others.length && t.spec.nights > mostNights) reasons.push(`${plural(t.spec.nights - mostNights, 'extra night')} over the other${others.length > 1 ? 's' : ''}`);
  if (t.flight.stops === 0) reasons.push(others.some(o => o.trip.flight.stops > 0) ? 'Nonstop flights kept, which not every option does' : 'Nonstop flights');
  if (others.some(o => o.trip.hotel.stars < t.hotel.stars)) reasons.push(`A ${t.hotel.stars}-star hotel`);
  if (t.hotel.features.allInclusive && others.some(o => !o.trip.hotel.features.allInclusive)) reasons.push('All-inclusive');
  if (t.hotel.features.beachfront && others.some(o => !o.trip.hotel.features.beachfront)) reasons.push('A beachfront hotel');
  reasons.push(`Leaves ${fmt(best.keep)} of your ${fmt(q.budget)}${others.length && others.every(o => o.keep < best.keep) ? `, the most of the ${others.length === 2 ? 'three' : 'two'}` : ''}`);
  return { key: best.key, reasons };
}

// The three strategies (plus the candidate list and the pool, for budgetShift). `cap` is the ceiling
// the set is aimed at; `keep` is always read against q.budget, the customer's own number. `hold`
// ({ trip, locks }) keeps every package on the locked parts of that trip.
function plan(inventory, q, { settings, now = new Date(), nightsOpen = false, exclude = {}, cap = q.budget, prefer = null, minNights = 2, hold = null, protect = null } = {}) {
  if (!q || !q.budget || !q.origin) throw new AppError('invalid_search', 'Tell us your budget and where you’re leaving from.', 422);
  const inv = memoInventory(inventory);
  const n = q.nights;
  protect = protect || q.protect || null;
  const nightsFor = { more: nightsOpen ? range(n, n + 2) : [n], keep: nightsOpen ? range(Math.max(minNights, n - 1), n) : [n], special: [n] };
  let pool = buildPool(inv, q, [...new Set(Object.values(nightsFor).flat())], { settings, now, exclude, protect }).filter(t => keepsProtected(t, protect));
  if (hold && hold.trip) pool = pool.filter(t => !crossesLock(hold.trip, t, hold.locks));
  const skip = excluder(exclude);
  const cands = candidates(pool, cap, contexts(q), skip);
  const at = key => cands.filter(c => nightsFor[key].includes(c.trip.spec.nights));
  const base = { considered: pool.length, destinations: new Set(pool.map(t => t.dest.id)).size, cands, pool };
  const dropped = [], chosen = {};

  chosen.more = strongest(at('more'), withPrefer(prefer, fullest));
  if (!chosen.more) {
    // Said precisely: nothing matched, nothing fit, nothing fit at these lengths, or everything that
    // fit was already shown (every fitting package, or every one at these lengths).
    const fits = pool.filter(t => t.total <= cap), lengths = `${plural(n, 'night')}${nightsFor.more.length > 1 ? ' or more' : ''}`;
    const reason = !pool.length ? 'Nothing in the inventory matches these rules'
      : !fits.length ? `Nothing the inventory priced fits ${fmt(cap)} with these rules`
        : !fits.some(t => nightsFor.more.includes(t.spec.nights)) ? `Nothing the inventory priced fits ${fmt(cap)} with these rules for ${lengths}`
          : `Every package that fits ${fmt(cap)} with these rules${fits.every(skip) ? '' : ` for ${lengths}`} has already been shown`;
    return { ...base, strategies: [], dropped: KEYS.map(key => ({ key, reason })), pick: null };
  }
  const more = chosen.more;
  const different = (c, ...others) => others.every(o => !o || (c.token !== o.token && meaningful(c.trip, o.trip)));

  // Keep more: strongest at or under the 80% aim, cheaper than More and a different trip; a different
  // stay (destination, nights, hotel class) before a mere change of extras. When nothing meaningfully
  // different fits the aim, a trip that still keeps at least 10% more than More is offered and says so.
  const target = Math.floor(cap * KEEP_SHARE);
  let keepPool = at('keep').filter(c => c.total <= target && c.total < more.total && different(c, more));
  let keepNote = null;
  if (!keepPool.length) {
    keepPool = at('keep').filter(c => c.total <= more.total - cap * 0.1 && different(c, more));
    if (keepPool.length) keepNote = `Above the ${fmt(target)} aim: nothing meaningfully different was priced under it`;
  }
  const stayDiff = c => (differences(c.trip, more.trip).stay.length ? 1 : 0);
  chosen.keep = strongest(keepPool, withPrefer(prefer, (a, b) => stayDiff(b) - stayDiff(a) || cheapest(a, b)));
  if (!chosen.keep) dropped.push({ key: 'keep', reason: more.total <= target ? `More vacation already leaves ${fmt(q.budget - more.total)}; nothing meaningfully different was priced below ${fmt(more.total)}` : `Nothing meaningfully different was priced at or under ${fmt(target)}, 80% of ${fmt(cap)}` });

  // Make it special: a real step up over More, a better stay before more extras, cheapest of the near-equal.
  const ups = at('special').filter(c => different(c, more, chosen.keep)).map(c => ({ c, up: stepUp(more.trip, c.trip, n) })).filter(x => x.up);
  const stayUps = ups.filter(x => x.up.stay.length);
  chosen.special = strongest((stayUps.length ? stayUps : ups).map(x => x.c), withPrefer(prefer, cheapest));
  if (!chosen.special) dropped.push({ key: 'special', reason: `Nothing priced up to ${fmt(cap)} steps up from More vacation’s stay or what it includes without giving something else up` });

  const strategies = KEYS.filter(k => chosen[k]).map(k => ({
    key: k, label: LABELS[k], trip: chosen[k].trip, token: chosen[k].token, total: chosen[k].total, keep: q.budget - chosen[k].total, match: chosen[k].match,
    why: facts(chosen[k].trip, q.budget).concat(k === 'keep' && keepNote ? [keepNote] : []), differs: [],
  }));
  describeDiffers(strategies);
  return { ...base, strategies, dropped, pick: choosePick(strategies, q) };
}

// How each way differs from the others on the same table, in words and dollars, from the trips
// themselves. Recomputed whenever the set changes, so a card never compares a way with one it
// replaced.
function describeDiffers(strategies) {
  for (const s of strategies) s.differs = strategies.filter(o => o !== s).map(o => `${o.label}: ${list(differences(s.trip, o.trip).all)}; ${fmt(Math.abs(s.total - o.total))} ${s.total > o.total ? 'more' : 'less'}`);
  return strategies;
}

function threeWays(inv, q, opts = {}) {
  const { cands, pool, ...out } = plan(inv, q, opts); // eslint-disable-line no-unused-vars
  return out;
}

// Three variants in the direction the customer chose. Each is priced in full, fits the budget, obeys
// the rules and really differs from the chosen trip; a variant that cannot be built is named in
// `missing`, with the customer's own rule when that is what stops it: a lock (`locks`, as the agent
// keeps them), an exact departure or a chosen month (q.dateMode), a stated length (`nightsOpen` false),
// a rejected destination or hotel (`exclude`). `prefer` orders the pools built for another destination.
function pushDirection(inventory, q, chosen, key, { settings, now = new Date(), locks = {}, nightsOpen = true, exclude = {}, prefer = null, protect = null } = {}) {
  if (!LABELS[key]) throw new AppError('invalid_strategy', 'Pick one of the three strategies first.', 422);
  const inv = memoInventory(inventory);
  locks = locks || {};
  protect = protect || q.protect || null;
  const ex = exclusions(exclude), skipTok = new Set(ex.tokens), skipHotel = new Set(ex.hotels);
  const cur = tripOf(chosen), s = cur.spec, curToken = encodeSpec(s), cx = contexts(q), budget = q.budget;
  const price = spec => priceTrip(inv, spec, settings);
  const fits = t => t && t.total <= budget && encodeSpec(t.spec) !== curToken && !skipTok.has(encodeSpec(t.spec)) && keepsProtected(t, protect);
  const wrap = t => ({ trip: t, token: encodeSpec(t.spec), total: t.total, match: scoreTrip(t, cx.ctx).match, plain: scoreTrip(t, cx.plain).match });
  const hotelsOk = hs => hs.filter(h => hotelAllowed(h, q) && rulesAllowHotel(h, q.rules) && !skipHotel.has(h.id));
  const priced = specs => specs.map(price).filter(fits).map(wrap);
  const order = withPrefer(prefer, cheapest);
  // Another destination for the same nights: never one the customer rejected, never across a lock,
  // and on the same departure date when the dates are locked.
  const away = { dests: [...new Set([s.dest, ...ex.dests])], tokens: ex.tokens, hotels: ex.hotels };
  const qAway = locks.dates ? { ...q, dateMode: 'exact', depart: s.depart, month: null } : q;
  const elsewhere = keep => strongest(candidates(buildPool(inv, qAway, [s.nights], { settings, now, exclude: away, protect }), budget, cx, excluder(away)).filter(c => keep(c) && !crossesLock(cur, c.trip, locks)), order);
  const earliest = addDays(today(now), 3);
  const inMonth = d => q.dateMode !== 'flexible' || !q.month || d.slice(0, 7) === q.month;
  // The rule that stops a variant, in the customer's terms; null when nothing does.
  const held = (...parts) => { for (const p of parts) if (locks[p]) return LOCKED[p]; return null; };
  const nightsRule = () => held('nights', 'dates') || (nightsOpen ? null : `You asked for exactly ${plural(q.nights, 'night')}`);
  const datesRule = () => held('dates') || (q.dateMode === 'exact' ? `Leaving ${q.depart || s.depart} is fixed` : null);
  const protectedName = protect ? (cur.activities.find(a => a.id === protect) || { name: protect }).name : null;
  const awayRule = () => held('dest', 'hotel') || (protect ? `${protectedName}, the protected experience, is offered in ${cur.dest.name}` : null); // "protected", never "you protected": the agent may have set it
  const flightsHeld = locks.flight ? ' and the flights locked' : '';
  const plans = {
    more: [
      ['A', () => 'Same nights, better flight', () => held('flight'), () => {
        const opts = priced(cur.flightOptions.filter(f => f.id !== s.flight && rulesAllowFlight(f, q.rules)).map(f => ({ ...s, flight: f.id })))
          .filter(c => { const ch = classifyChanges(cur, c.trip); return !ch.tradeoffs.length && ch.improvements.some(r => ['flight', 'bags', 'flex', 'time'].includes(r.key)); });
        return opts.sort((a, b) => (a.total <= cur.total ? 0 : 1) - (b.total <= cur.total ? 0 : 1) || a.trip.flight.stops - b.trip.flight.stops || a.total - b.total)[0] || `No better flight than the ${cur.flight.name} fare was priced within ${fmt(budget)}`;
      }],
      ['B', c => `${plural(s.nights + 1, 'night')}, ${c.trip.hotel.id === s.hotel ? 'same hotel' : 'simpler hotel'}`, nightsRule, () => {
        if (s.nights >= 14) return 'Already the longest trip we price';
        const simpler = h => h.id === s.hotel || (!locks.hotel && (h.stars < cur.hotel.stars || (h.stars === cur.hotel.stars && h.netNightly < cur.hotel.netNightly)));
        const hotels = hotelsOk(inv.hotels.search({ destId: s.dest, checkIn: s.depart, nights: s.nights + 1, rooms: roomsFor(s) })).filter(simpler);
        return strongest(priced(hotels.map(h => ({ ...s, nights: s.nights + 1, hotel: h.id }))), order) || `${plural(s.nights + 1, 'night')} in ${cur.dest.name} does not fit ${fmt(budget)}${locks.hotel ? ' at the locked hotel' : ', even with a simpler hotel'}`;
      }],
      ['C', c => `Same nights in ${c.trip.dest.name}`, awayRule, () => elsewhere(() => true) || `No other destination fits ${fmt(budget)} for ${plural(s.nights, 'night')} with your rules${flightsHeld}`],
    ],
    keep: [
      ['A', c => `Same trip, leaving ${c.trip.spec.depart}`, datesRule, () => {
        const dates = [-3, -2, -1, 1, 2, 3].map(o => addDays(s.depart, o)).filter(d => d >= earliest && inMonth(d));
        return priced(dates.map(d => ({ ...s, depart: d }))).filter(c => c.total < cur.total).sort(cheapest)[0] || `No cheaper dates within three days${q.dateMode === 'flexible' && q.month ? ` in ${q.month}` : ''} were priced for the same trip`;
      }],
      ['B', () => `${plural(s.nights - 1, 'night')} instead of ${s.nights}`, nightsRule, () => (s.nights <= 2 ? 'Already the shortest trip we price' : priced([{ ...s, nights: s.nights - 1 }]).filter(c => c.total < cur.total)[0] || `${plural(s.nights - 1, 'night')} was not priced below ${fmt(cur.total)}`)],
      ['C', c => `${c.trip.dest.name} instead of ${cur.dest.name}`, awayRule, () => elsewhere(c => c.total < cur.total) || `No other destination was priced below ${fmt(cur.total)} for ${plural(s.nights, 'night')} with your rules${flightsHeld}`],
    ],
    special: [
      ['A', c => `${c.trip.hotel.stars}-star hotel instead of ${cur.hotel.stars}-star`, () => held('hotel'), () => {
        const above = cur.hotelOptions.filter(h => h.stars > cur.hotel.stars), hotels = hotelsOk(above);
        if (!above.length) return cur.hotel.stars >= 5 ? 'Already a 5-star hotel' : `No hotel above ${cur.hotel.stars}-star in ${cur.dest.name} was priced`;
        if (!hotels.length) return `No hotel above ${cur.hotel.stars}-star in ${cur.dest.name} passes your rules${above.some(h => skipHotel.has(h.id)) ? ' other than one you left out' : ''}`;
        return strongest(priced(hotels.map(h => ({ ...s, hotel: h.id }))), order) || `A better hotel class in ${cur.dest.name} does not fit ${fmt(budget)}`;
      }],
      ['B', c => `All-inclusive${c.trip.dest.id === s.dest ? '' : ` in ${c.trip.dest.name}`}`, () => held('hotel'), () => {
        if (cur.hotel.features.allInclusive) return `${cur.hotel.name} is already all-inclusive`;
        return strongest(priced(hotelsOk(cur.hotelOptions).filter(h => h.features.allInclusive).map(h => ({ ...s, hotel: h.id }))), order)
          || (awayRule() ? null : elsewhere(c => c.trip.hotel.features.allInclusive)) || `No all-inclusive resort fits ${fmt(budget)} for ${plural(s.nights, 'night')} with your rules${locks.dest ? ` in ${cur.dest.name}` : ''}${flightsHeld}`;
      }],
      ['C', c => `More included: ${list(differences(c.trip, cur).extras)}`, () => null, () => {
        const sets = [s.activities, ...(protect ? withProtect(activitySets(cur.activityOptions, q.style), protect) : activitySets(cur.activityOptions, q.style)).filter(a => a.length > s.activities.length)];
        const specs = [];
        for (const transfer of s.transfer ? [true] : [true, false]) for (const a of sets) if (transfer !== s.transfer || a.length > s.activities.length) specs.push({ ...s, transfer, activities: a });
        if (!specs.length) return 'Everything the destination offers is already included';
        return strongest(priced(specs), (a, b) => included(b.trip) - included(a.trip) || cheapest(a, b)) || `Adding a transfer or experiences does not fit ${fmt(budget)}`;
      }],
    ],
  }[key];
  const variants = [], missing = [], seen = new Set([curToken]);
  for (const [letter, label, rule, find] of plans) {
    const r = rule() || find();
    if (typeof r === 'string') { missing.push({ letter, reason: r }); continue; }
    if (seen.has(r.token)) { missing.push({ letter, reason: 'Would repeat another variant' }); continue; }
    const crossed = lockCrossed(cur, r.trip, locks); // every plan above keeps the locks; this is the last word
    if (crossed) { missing.push({ letter, reason: LOCKED[crossed] }); continue; }
    seen.add(r.token);
    variants.push({ letter, label: label(r), trip: r.trip, token: r.token, total: r.total, keep: budget - r.total, match: r.match, changes: classifyChanges(cur, r.trip) });
  }
  return { variants, missing };
}

// "None of these": a genuinely different set for what was wrong, never repeating a trip already shown
// (by shape: the same destination, hotel, flight and length is the same trip whatever the date).
function differentSet(inventory, q, { wrong, shown = [], settings, now = new Date(), nightsOpen = false } = {}) {
  const inv = memoInventory(inventory);
  const tokens = shown.map(x => x.token).filter(Boolean);
  const shownTrips = tokens.map(tok => { try { return priceTrip(inv, decodeSpec(tok), settings); } catch (e) { return null; } }).filter(Boolean);
  const dests = [...new Set([...shown.map(x => x.dest), ...shownTrips.map(t => t.dest.id)].filter(Boolean))];
  const name = id => (inv.maps.getDestination(id) || { name: id }).name;
  const shownHotels = () => { const ids = [...new Set(shownTrips.map(t => t.hotel.id))]; return { ids, names: [...new Set(shownTrips.map(t => t.hotel.name))] }; };
  const q2 = { ...q }, opts = { settings, now, nightsOpen, exclude: { dests: [], tokens, hotels: [] } }, adjusted = [];
  switch (wrong) {
    case 'destinations': opts.exclude.dests = dests; adjusted.push(dests.length ? `Left out ${list(dests.map(name))}` : 'No destination to leave out was given'); break;
    case 'expensive': opts.cap = Math.floor(q.budget * KEEP_SHARE); adjusted.push(`Every option now at or under ${fmt(opts.cap)}, 80% of your ${fmt(q.budget)}; the ceiling stays ${fmt(q.budget)}`); break;
    case 'short':
      // One night more, never fewer; at 14 nights there is no longer length priced, and that is said.
      q2.nights = Math.min(14, q.nights + 1); opts.nightsOpen = true; opts.minNights = q2.nights;
      adjusted.push(q.nights >= 14 ? '14 nights is already the longest length priced; every option stays at 14 nights'
        : `${plural(q2.nights, 'night')} instead of ${q.nights}${q2.nights < 14 ? `, up to ${Math.min(14, q2.nights + 2)} for More vacation` : ''} and never fewer`);
      break;
    case 'travel': q2.rules = { ...(q.rules || NO_RULES), nonstop: true }; opts.prefer = 'shorter-flights'; adjusted.push('Nonstop flights only, shortest flights first'); break;
    case 'hotels': {
      const stars = shownTrips.map(t => t.hotel.stars), h = shownHotels();
      const minStars = Math.min(5, ((q.rules && q.rules.minStars) || (stars.length ? Math.min(...stars) : 3)) + 1);
      q2.rules = { ...(q.rules || NO_RULES), minStars };
      opts.exclude.hotels = h.ids;
      adjusted.push(`${minStars}-star hotels or better${h.ids.length ? `, leaving out ${list(h.names)}` : ''}`);
      break;
    }
    case 'exciting': {
      const h = shownHotels();
      opts.prefer = 'exciting'; opts.exclude.hotels = h.ids;
      adjusted.push(`All-inclusive, beachfront, included experiences and international destinations first${h.ids.length ? `, leaving out ${list(h.names)}` : ''}`);
      break;
    }
    default: throw new AppError('invalid_feedback', 'Tell us what was wrong: destinations, expensive, short, travel, hotels or exciting.', 422);
  }
  if (tokens.length) adjusted.push('None of the trips you already saw is repeated');
  return { ...threeWays(inv, q2, opts), adjusted };
}

// Two priced trips can be mixed when they are one trip's worth of frame: the same destination, the
// same departure airport and the same party (travelers and who).
function mixable(a, b) {
  const A = tripOf(a), B = tripOf(b);
  return !!(A && B && A.spec && B.spec && A.dest && B.dest && A.dest.id === B.dest.id && A.spec.from === B.spec.from && A.spec.travelers === B.spec.travelers && A.spec.who === B.spec.who);
}

// The hotel of one priced trip with the flight of the other, priced as one trip by the real pricer.
// The flight side gives the dates, the length, the flight and its bags; the hotel side gives the
// hotel, the experiences and the transfer, re-priced on the flight side's dates. When the pricer
// cannot build it, the part with no availability on those dates is named; nothing is guessed.
// With `cap`, `over` says whether the mix is above it.
function mixTrips(inventory, a, b, { hotelFrom = 'a', flightFrom = 'b' } = {}, { settings, cap = null } = {}) {
  const trips = { a: tripOf(a), b: tripOf(b) }, names = { a: (a && (a.letter || a.label)) || 'the first trip', b: (b && (b.letter || b.label)) || 'the second trip' };
  const H = trips[hotelFrom], F = trips[flightFrom], hn = names[hotelFrom], fn = names[flightFrom];
  if (!H || !F || hotelFrom === flightFrom) return { error: 'Pick the hotel from one trip and the flight from the other.' };
  if (H.dest.id !== F.dest.id) return { error: `${hn} is in ${H.dest.name} and ${fn} flies to ${F.dest.name}; a hotel from one and a flight from the other cannot be one trip.` };
  if (H.spec.from !== F.spec.from) return { error: `${hn} is priced from ${H.spec.from} and ${fn} from ${F.spec.from}; the flight and the hotel must start from the same airport.` };
  if (H.spec.travelers !== F.spec.travelers) return { error: `${hn} is priced for ${H.spec.travelers} and ${fn} for ${F.spec.travelers} travelers; they cannot be one trip.` };
  if (H.spec.who !== F.spec.who) return { error: `${hn} is priced as ${WHO_WORD[H.spec.who] || H.spec.who} and ${fn} as ${WHO_WORD[F.spec.who] || F.spec.who}; they cannot be one trip.` };
  const inv = memoInventory(inventory);
  const spec = { ...F.spec, hotel: H.spec.hotel, activities: [...H.spec.activities].sort(), transfer: H.spec.transfer };
  const t = priceTrip(inv, spec, settings);
  if (!t) {
    const when = `${plural(spec.nights, 'night')} from ${spec.depart}, ${fn}’s dates`;
    if (!inv.hotels.search({ destId: spec.dest, checkIn: spec.depart, nights: spec.nights, rooms: roomsFor(spec) }).some(h => h.id === spec.hotel)) return { error: `${H.hotel.name}, ${hn}’s hotel, has no availability for ${when}.` };
    const offered = inv.activities.search({ destId: spec.dest, date: spec.depart, travelers: spec.travelers });
    const gone = H.activities.find(x => !offered.some(o => o.id === x.id));
    if (gone) return { error: `${gone.name}, ${hn}’s experience, is not offered on ${spec.depart}, ${fn}’s departure.` };
    if (!inv.flights.search({ from: spec.from, destId: spec.dest, depart: spec.depart, nights: spec.nights, travelers: spec.travelers }).some(f => f.id === spec.flight)) return { error: `The ${F.flight.name} fare, ${fn}’s flights, is no longer available for ${when}.` };
    if (spec.transfer && !inv.transfers.quote({ destId: spec.dest, travelers: spec.travelers })) return { error: `No airport transfer could be quoted in ${H.dest.name} for ${hn}’s transfer.` };
    return { error: 'That combination could not be priced right now: part of it is no longer available.' };
  }
  return { trip: t, token: encodeSpec(t.spec), total: t.total, over: cap ? t.total > cap : false, cap: cap || null };
}

// The three strategies at a new budget, and what the change really does to the current trip. Every
// lock is forwarded: the rebuild stays on the locked destination, dates and length, no candidate that
// crosses a lock is proposed, and a stated length (`nightsOpen` false) holds the length as well.
// `exclude` keeps rejected destinations and hotels out of the rebuild and out of the comparison.
function budgetShift(inventory, q, current, newBudget, { settings, now = new Date(), locks = {}, nightsOpen = true, exclude = {}, prefer = null, protect = null } = {}) {
  const cur = tripOf(current);
  locks = locks || {};
  protect = protect || q.protect || null;
  const holdNights = !!(locks.nights || locks.dates) || !nightsOpen;
  const anyLock = ['hotel', 'flight', 'dates', 'nights', 'dest'].some(k => locks[k]);
  const q2 = { ...q, budget: newBudget, vacationBudget: newBudget + (q.keep || 0) };
  if (locks.dest) q2.dest = cur.dest.id;
  if (locks.dates) { q2.dateMode = 'exact'; q2.depart = cur.spec.depart; q2.month = null; }
  if (locks.nights || locks.dates) q2.nights = cur.spec.nights;
  const { cands, pool, ...strategies } = plan(inventory, q2, { settings, now, nightsOpen: !holdNights, exclude, prefer, hold: { trip: cur, locks }, protect }); // eslint-disable-line no-unused-vars
  const changeWords = rows => rows.map(r => `${r.label.toLowerCase()}: ${r.b}${r.direction < 0 ? ` (was ${r.a})` : ''}`).join('; ');
  let note;
  if (newBudget > q.budget) {
    const extra = fmt(newBudget - q.budget);
    const more = strategies.strategies.find(s => s.key === 'more');
    const longer = more && !holdNights && more.trip.spec.nights > cur.spec.nights && !crossesLock(cur, more.trip, locks) ? more : null;
    if (longer) {
      // The headline is the priced difference between the two trips, never the budget increase, and
      // it is said with every other difference, so more nights never reads as "better" on its own.
      const nights = plural(longer.trip.spec.nights - cur.spec.nights, 'extra night'), delta = longer.total - cur.total;
      const lead = longer.total <= q.budget ? `${nights} already fit your ${fmt(q.budget)}, so the extra ${extra} is not needed for them`
        : delta > 0 ? `${fmt(delta)} more buys ${nights}` : `${nights} for ${delta ? `${fmt(-delta)} less` : 'the same money'}`;
      const rest = differences(longer.trip, cur).all.filter(w => w !== nightsPhrase(longer.trip, cur));
      note = { kind: 'extra-night', text: `${lead}: ${plural(longer.trip.spec.nights, 'night')} in ${longer.trip.dest.name} at ${fmt(longer.total)} instead of ${plural(cur.spec.nights, 'night')} at ${fmt(cur.total)}${rest.length ? `, with ${list(rest)}` : ''}.` };
    } else {
      // A dearer version is worth the money when the comparison finds something better and nothing
      // given up (classifyChanges). What it buys is said in gains() words when there are any (nights,
      // stops, hotel class, meals, the beach, a transfer, experiences), else as the improvement rows
      // (bags, cancellation, usable time, a rating). The dearer versions are every package priced
      // under the new budget, shown before or not, minus what the customer rejected or locked.
      const dearer = candidates(pool, newBudget, contexts(q2)).filter(c => c.total > cur.total && !crossesLock(cur, c.trip, locks) && keepsProtected(c.trip, protect)).sort(cheapest);
      const worthIt = c => { const ch = classifyChanges(cur, c.trip); return ch.improvements.length && !ch.tradeoffs.length ? ch : null; };
      const describe = (c, ch) => {
        const g = gains(cur, c.trip), where = c.trip.dest.id === cur.dest.id ? `in ${cur.dest.name}` : `in ${c.trip.dest.name} instead of ${cur.dest.name}`;
        return `${fmt(c.total - cur.total)} more buys ${g.all.length ? list(g.all) : changeWords(ch.improvements)} ${where} (${fmt(c.total)} instead of ${fmt(cur.total)}) without giving anything up${ch.neutral.length ? `; it also changes ${changeWords(ch.neutral)}` : ''}`;
      };
      let real = null, realCh = null;
      for (const c of dearer) { const ch = worthIt(c); if (ch) { real = c; realCh = ch; break; } }
      if (real) {
        // When the cheapest worth-it version already fit the old ceiling, the cheapest one that needs
        // the extra money is said too, so the customer hears what the raise itself buys.
        let already = '';
        if (real.total <= q.budget) {
          const above = dearer.find(c => c.total > q.budget && worthIt(c));
          already = ` It already fit your ${fmt(q.budget)}; the extra ${extra} is not needed for it.${above ? ` Above ${fmt(q.budget)}, ${describe(above, worthIt(above))}.` : ''}`;
        }
        note = { kind: 'upgrade-worth-it', text: `${describe(real, realCh)}.${already}` };
      } else if (dearer.length) {
        const eg = dearer[0], ch = classifyChanges(cur, eg.trip);
        note = { kind: 'upgrade-not-worth-it', text: `I priced ${plural(dearer.length, 'dearer version')} up to ${fmt(newBudget)}; none improves the trip without giving something up. The cheapest, ${fmt(eg.total)} in ${eg.trip.dest.name}, ${ch.tradeoffs.length ? `gives up ${changeWords(ch.tradeoffs)}` : ch.neutral.length ? `only changes ${changeWords(ch.neutral)}` : 'changes nothing the comparison reads'}. I would keep the ${extra}.` };
      } else {
        note = { kind: 'nothing-changes', text: `Nothing dearer than ${fmt(cur.total)}${anyLock ? ' that keeps what you locked' : ''} was priced up to ${fmt(newBudget)}; the trip stays the same and you keep ${fmt(newBudget - cur.total)}.` };
      }
    }
  } else if (newBudget < cur.total) {
    const r = nameYourPrice(inventory, cur, settings, { ...contexts(q2).ctx, protect }, newBudget, { now, locks });
    const rec = r.recommended;
    const dateWords = t => { const d = daysBetween(cur.spec.depart, t.spec.depart); return d ? `moving departure ${plural(Math.abs(d), 'day')} ${d < 0 ? 'earlier' : 'later'} (${t.spec.depart})` : null; };
    const how = v => list([dateWords(v.trip), changeWords(v.changes.neutral.filter(x => x.key !== 'dates')) || null, v.changes.improvements.length ? `and better: ${changeWords(v.changes.improvements)}` : null].filter(Boolean));
    // The dearest version under the new budget that gives nothing up (the recommendation, or a rung
    // of the same ladder) is the same trip for less; otherwise the recommendation names its compromise.
    const rungs = r.ladder.filter(x => !x.current && x.total <= newBudget); // dearest first
    const same = [rec, ...rungs].filter(v => v && !v.changes.tradeoffs.length).sort((p, s) => s.total - p.total)[0];
    const least = rec && rungs.find(x => x.label === 'strong' && x.total > rec.total); // a smaller compromise on the same ladder, if one was priced
    if (same) note = { kind: 'same-trip-cheaper', text: `The same trip at ${fmt(same.total)} by ${how(same)}; everything else stays.` };
    else if (rec) note = { kind: 'needs-compromise', text: `${least ? `${fmt(least.total)} means ${changeWords(least.changes.tradeoffs)}. ` : ''}${fmt(rec.total)} is the lowest I would recommend under ${fmt(newBudget)}; it means ${changeWords(rec.changes.tradeoffs)}.` };
    else if (r.anyway) note = { kind: 'needs-compromise', text: `No version of this trip I would recommend fits ${fmt(newBudget)}${r.floor ? `; I would stop at ${fmt(r.floor.total)}` : ''}. The closest, ${fmt(r.anyway.total)}, means ${changeWords(r.anyway.changes.tradeoffs) || how(r.anyway)}.` };
    else note = { kind: 'needs-compromise', text: r.cheapest ? `Nothing I priced gets this trip under ${fmt(newBudget)}; the cheapest version is ${fmt(r.cheapest.total)} and means ${changeWords(r.cheapest.changes.tradeoffs) || how(r.cheapest)}.` : 'No cheaper version of this trip was priced.' };
  } else {
    note = { kind: 'nothing-changes', text: `${fmt(cur.total)} still fits ${fmt(newBudget)}; nothing changes and you keep ${fmt(newBudget - cur.total)}.` };
  }
  return { strategies, note };
}

module.exports = { threeWays, pushDirection, differentSet, mixTrips, mixable, budgetShift, differences, describeDiffers, stepUp, crossesLock, shapeKey, LABELS, KEEP_SHARE };
