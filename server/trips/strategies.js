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
// and a rule the customer set is never relaxed by the engine on its own.
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

// How trip a differs from trip b, in words, from facts only. Destination, nights, hotel class, meals,
// the beach and nonstop make a different stay; a transfer or experiences only change what is included.
function differences(a, b) {
  const stay = [], extras = [];
  if (a.dest.id !== b.dest.id) stay.push(`${a.dest.name} instead of ${b.dest.name}`);
  if (a.spec.nights !== b.spec.nights) stay.push(`${plural(a.spec.nights, 'night')} instead of ${b.spec.nights}`);
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
// steps up, never the other way round. Fewer nights only when the nights asked for are still met;
// every such difference is said on the card.
function stepUp(base, t, nightsAsked) {
  const { stay, extras } = gains(base, t);
  if (!stay.length && !extras.length) return null;
  const allowed = new Set(stay.length ? ['experiences', 'transfer'] : []);
  if (t.spec.nights < base.spec.nights && t.spec.nights >= nightsAsked) { allowed.add('nights'); allowed.add('time'); } // less usable time follows from fewer nights
  const worse = classifyChanges(base, t).tradeoffs.filter(r => !allowed.has(r.key));
  return worse.length ? null : { stay, extras };
}

// Every package the optimizer would price for these lengths, under the same rules and filters it
// applies (mirrors its packagesFor, which is not exported), minus what a "try again" excludes.
function buildPool(inv, q, nightsList, { settings, now, exclude }) {
  const origin = inv.maps.getOrigin(q.origin);
  const airport = origin.airports[0].code;
  const disabled = new Set(settings.disabledDestinations || []), skipDest = new Set(exclude.dests || []), skipHotel = new Set(exclude.hotels || []);
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
      const transfers = q.rules && q.rules.transfer ? [true] : [false, true];
      for (const f of flights) for (const h of hotels) for (const a of activitySets(acts, q.style)) for (const transfer of transfers) {
        const t = priceTrip(inv, { ...base, flight: f.id, hotel: h.id, activities: a, bags: false, transfer }, settings);
        if (t) out.push(t);
      }
    }
  }
  return out;
}

// Candidates at or under `cap`: a trip over the ceiling is never a strategy. `match` is the fit the
// rest of the product shows (budget included); `plain` is the trip's own strength, price taken out,
// so that cheapness decides only where the strategy is about cheapness.
function candidates(trips, cap, { ctx, plain }, exclude = {}) {
  const skip = new Set(exclude.tokens || []);
  return trips.filter(t => t.total <= cap).map(t => ({ trip: t, token: encodeSpec(t.spec), total: t.total, match: scoreTrip(t, ctx).match, plain: scoreTrip(t, plain).match })).filter(c => !skip.has(c.token));
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
const withPrefer = (prefer, base) => (prefer ? (a, b) => PREFER[prefer](a, b) || base(a, b) : base);

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

// The three strategies (plus the candidate list, for budgetShift). `cap` is the ceiling the set is
// aimed at; `keep` is always read against q.budget, the customer's own number.
function plan(inventory, q, { settings, now = new Date(), nightsOpen = false, exclude = {}, cap = q.budget, prefer = null, minNights = 2 } = {}) {
  if (!q || !q.budget || !q.origin) throw new AppError('invalid_search', 'Tell us your budget and where you’re leaving from.', 422);
  const inv = memoInventory(inventory);
  const n = q.nights;
  const nightsFor = { more: nightsOpen ? range(n, n + 2) : [n], keep: nightsOpen ? range(Math.max(minNights, n - 1), n) : [n], special: [n] };
  const pool = buildPool(inv, q, [...new Set(Object.values(nightsFor).flat())], { settings, now, exclude });
  const cands = candidates(pool, cap, contexts(q), exclude);
  const at = key => cands.filter(c => nightsFor[key].includes(c.trip.spec.nights));
  const base = { considered: pool.length, destinations: new Set(pool.map(t => t.dest.id)).size, cands };
  const dropped = [], chosen = {};

  chosen.more = strongest(at('more'), withPrefer(prefer, fullest));
  if (!chosen.more) {
    const reason = pool.length ? `Nothing the inventory priced fits ${fmt(cap)} with these rules` : 'Nothing in the inventory matches these rules';
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
  for (const s of strategies) s.differs = strategies.filter(o => o !== s).map(o => `${o.label}: ${list(differences(s.trip, o.trip).all)}; ${fmt(Math.abs(s.total - o.total))} ${s.total > o.total ? 'more' : 'less'}`);
  return { ...base, strategies, dropped, pick: choosePick(strategies, q) };
}

function threeWays(inv, q, opts = {}) {
  const { cands, ...out } = plan(inv, q, opts); // eslint-disable-line no-unused-vars
  return out;
}

// Three variants in the direction the customer chose. Each is priced in full, fits the budget, obeys
// the rules and really differs from the chosen trip; a variant that cannot be built is named in `missing`.
function pushDirection(inventory, q, chosen, key, { settings, now = new Date() } = {}) {
  if (!LABELS[key]) throw new AppError('invalid_strategy', 'Pick one of the three strategies first.', 422);
  const inv = memoInventory(inventory);
  const cur = tripOf(chosen), s = cur.spec, curToken = encodeSpec(s), cx = contexts(q), budget = q.budget;
  const price = spec => priceTrip(inv, spec, settings);
  const fits = t => t && t.total <= budget && encodeSpec(t.spec) !== curToken;
  const wrap = t => ({ trip: t, token: encodeSpec(t.spec), total: t.total, match: scoreTrip(t, cx.ctx).match, plain: scoreTrip(t, cx.plain).match });
  const hotelsOk = hs => hs.filter(h => hotelAllowed(h, q) && rulesAllowHotel(h, q.rules));
  const priced = specs => specs.map(price).filter(fits).map(wrap);
  const elsewhere = keep => strongest(candidates(buildPool(inv, q, [s.nights], { settings, now, exclude: { dests: [s.dest] } }), budget, cx).filter(keep), cheapest);
  const earliest = addDays(today(now), 3);
  const plans = {
    more: [
      ['A', () => 'Same nights, better flight', () => {
        const opts = priced(cur.flightOptions.filter(f => f.id !== s.flight && rulesAllowFlight(f, q.rules)).map(f => ({ ...s, flight: f.id })))
          .filter(c => { const ch = classifyChanges(cur, c.trip); return !ch.tradeoffs.length && ch.improvements.some(r => ['flight', 'bags', 'flex', 'time'].includes(r.key)); });
        return opts.sort((a, b) => (a.total <= cur.total ? 0 : 1) - (b.total <= cur.total ? 0 : 1) || a.trip.flight.stops - b.trip.flight.stops || a.total - b.total)[0] || `No better flight than the ${cur.flight.name} fare was priced within ${fmt(budget)}`;
      }],
      ['B', c => `${plural(s.nights + 1, 'night')}, ${c.trip.hotel.id === s.hotel ? 'same hotel' : 'simpler hotel'}`, () => {
        if (s.nights >= 14) return 'Already the longest trip we price';
        const simpler = h => h.id === s.hotel || h.stars < cur.hotel.stars || (h.stars === cur.hotel.stars && h.netNightly < cur.hotel.netNightly);
        const hotels = hotelsOk(inv.hotels.search({ destId: s.dest, checkIn: s.depart, nights: s.nights + 1, rooms: roomsFor(s) })).filter(simpler);
        return strongest(priced(hotels.map(h => ({ ...s, nights: s.nights + 1, hotel: h.id }))), cheapest) || `${plural(s.nights + 1, 'night')} in ${cur.dest.name} does not fit ${fmt(budget)}, even with a simpler hotel`;
      }],
      ['C', c => `Same nights in ${c.trip.dest.name}`, () => elsewhere(() => true) || `No other destination fits ${fmt(budget)} for ${plural(s.nights, 'night')} with your rules`],
    ],
    keep: [
      ['A', c => `Same trip, leaving ${c.trip.spec.depart}`, () => priced([-3, -2, -1, 1, 2, 3].map(o => addDays(s.depart, o)).filter(d => d >= earliest).map(d => ({ ...s, depart: d }))).filter(c => c.total < cur.total).sort(cheapest)[0] || 'No cheaper dates within three days were priced for the same trip'],
      ['B', () => `${plural(s.nights - 1, 'night')} instead of ${s.nights}`, () => (s.nights <= 2 ? 'Already the shortest trip we price' : priced([{ ...s, nights: s.nights - 1 }]).filter(c => c.total < cur.total)[0] || `${plural(s.nights - 1, 'night')} was not priced below ${fmt(cur.total)}`)],
      ['C', c => `${c.trip.dest.name} instead of ${cur.dest.name}`, () => elsewhere(c => c.total < cur.total) || `No other destination was priced below ${fmt(cur.total)} for ${plural(s.nights, 'night')} with your rules`],
    ],
    special: [
      ['A', c => `${c.trip.hotel.stars}-star hotel instead of ${cur.hotel.stars}-star`, () => {
        const hotels = hotelsOk(cur.hotelOptions).filter(h => h.stars > cur.hotel.stars);
        if (!hotels.length) return cur.hotel.stars >= 5 ? 'Already a 5-star hotel' : `No hotel above ${cur.hotel.stars}-star in ${cur.dest.name} passes your rules`;
        return strongest(priced(hotels.map(h => ({ ...s, hotel: h.id }))), cheapest) || `A better hotel class in ${cur.dest.name} does not fit ${fmt(budget)}`;
      }],
      ['B', c => `All-inclusive${c.trip.dest.id === s.dest ? '' : ` in ${c.trip.dest.name}`}`, () => {
        if (cur.hotel.features.allInclusive) return `${cur.hotel.name} is already all-inclusive`;
        return strongest(priced(hotelsOk(cur.hotelOptions).filter(h => h.features.allInclusive).map(h => ({ ...s, hotel: h.id }))), cheapest)
          || elsewhere(c => c.trip.hotel.features.allInclusive) || `No all-inclusive resort fits ${fmt(budget)} for ${plural(s.nights, 'night')} with your rules`;
      }],
      ['C', c => `More included: ${list(differences(c.trip, cur).extras)}`, () => {
        const sets = [s.activities, ...activitySets(cur.activityOptions, q.style).filter(a => a.length > s.activities.length)];
        const specs = [];
        for (const transfer of s.transfer ? [true] : [true, false]) for (const a of sets) if (transfer !== s.transfer || a.length > s.activities.length) specs.push({ ...s, transfer, activities: a });
        if (!specs.length) return 'Everything the destination offers is already included';
        return strongest(priced(specs), (a, b) => included(b.trip) - included(a.trip) || cheapest(a, b)) || `Adding a transfer or experiences does not fit ${fmt(budget)}`;
      }],
    ],
  }[key];
  const variants = [], missing = [], seen = new Set([curToken]);
  for (const [letter, label, find] of plans) {
    const r = find();
    if (typeof r === 'string') { missing.push({ letter, reason: r }); continue; }
    if (seen.has(r.token)) { missing.push({ letter, reason: 'Would repeat another variant' }); continue; }
    seen.add(r.token);
    variants.push({ letter, label: label(r), trip: r.trip, token: r.token, total: r.total, keep: budget - r.total, match: r.match, changes: classifyChanges(cur, r.trip) });
  }
  return { variants, missing };
}

// "None of these": a genuinely different set for what was wrong, never repeating a trip already shown.
function differentSet(inventory, q, { wrong, shown = [], settings, now = new Date(), nightsOpen = false } = {}) {
  const inv = memoInventory(inventory);
  const tokens = shown.map(x => x.token).filter(Boolean);
  const shownTrips = tokens.map(tok => { try { return priceTrip(inv, decodeSpec(tok), settings); } catch (e) { return null; } }).filter(Boolean);
  const dests = [...new Set([...shown.map(x => x.dest), ...shownTrips.map(t => t.dest.id)].filter(Boolean))];
  const name = id => (inv.maps.getDestination(id) || { name: id }).name;
  const q2 = { ...q }, opts = { settings, now, nightsOpen, exclude: { dests: [], tokens, hotels: [] } }, adjusted = [];
  switch (wrong) {
    case 'destinations': opts.exclude.dests = dests; adjusted.push(dests.length ? `Left out ${list(dests.map(name))}` : 'No destination to leave out was given'); break;
    case 'expensive': opts.cap = Math.floor(q.budget * KEEP_SHARE); adjusted.push(`Every option now at or under ${fmt(opts.cap)}, 80% of your ${fmt(q.budget)}; the ceiling stays ${fmt(q.budget)}`); break;
    case 'short': q2.nights = Math.min(14, q.nights + 1); opts.nightsOpen = true; opts.minNights = q2.nights; adjusted.push(`${plural(q2.nights, 'night')} instead of ${q.nights}, up to ${Math.min(14, q2.nights + 2)} for More vacation and never fewer`); break;
    case 'travel': q2.rules = { ...(q.rules || NO_RULES), nonstop: true }; opts.prefer = 'shorter-flights'; adjusted.push('Nonstop flights only, shortest flights first'); break;
    case 'hotels': {
      const stars = shownTrips.map(t => t.hotel.stars);
      const minStars = Math.min(5, ((q.rules && q.rules.minStars) || (stars.length ? Math.min(...stars) : 3)) + 1);
      q2.rules = { ...(q.rules || NO_RULES), minStars };
      opts.exclude.hotels = [...new Set(shownTrips.map(t => t.hotel.id))];
      adjusted.push(`${minStars}-star hotels or better${shownTrips.length ? `, leaving out ${list([...new Set(shownTrips.map(t => t.hotel.name))])}` : ''}`);
      break;
    }
    case 'exciting': opts.prefer = 'exciting'; adjusted.push('All-inclusive, beachfront, included experiences and international destinations first'); break;
    default: throw new AppError('invalid_feedback', 'Tell us what was wrong: destinations, expensive, short, travel, hotels or exciting.', 422);
  }
  if (tokens.length) adjusted.push('None of the trips you already saw is repeated');
  return { ...threeWays(inv, q2, opts), adjusted };
}

// The hotel of one priced trip with the flight of the other, priced as one trip by the real pricer.
function mixTrips(inventory, a, b, { hotelFrom = 'a', flightFrom = 'b' } = {}, { settings } = {}) {
  const trips = { a: tripOf(a), b: tripOf(b) }, names = { a: (a && (a.letter || a.label)) || 'the first trip', b: (b && (b.letter || b.label)) || 'the second trip' };
  const H = trips[hotelFrom], F = trips[flightFrom], hn = names[hotelFrom], fn = names[flightFrom];
  if (!H || !F || hotelFrom === flightFrom) return { error: 'Pick the hotel from one trip and the flight from the other.' };
  if (H.dest.id !== F.dest.id) return { error: `${hn} is in ${H.dest.name} and ${fn} flies to ${F.dest.name}; a hotel from one and a flight from the other cannot be one trip.` };
  if (H.spec.from !== F.spec.from) return { error: `${hn} is priced from ${H.spec.from} and ${fn} from ${F.spec.from}; the flight and the hotel must start from the same airport.` };
  if (H.spec.depart !== F.spec.depart || H.spec.nights !== F.spec.nights) return { error: `${hn} is ${plural(H.spec.nights, 'night')} from ${H.spec.depart} and ${fn} is ${plural(F.spec.nights, 'night')} from ${F.spec.depart}; the hotel and the flight must cover the same dates.` };
  if (H.spec.travelers !== F.spec.travelers || H.spec.who !== F.spec.who) return { error: `${hn} is priced for ${H.spec.travelers} and ${fn} for ${F.spec.travelers} travelers; they cannot be one trip.` };
  const t = priceTrip(memoInventory(inventory), { ...H.spec, flight: F.spec.flight, bags: F.spec.bags }, settings);
  if (!t) return { error: 'That combination could not be priced right now: part of it is no longer available.' };
  return { trip: t, token: encodeSpec(t.spec), total: t.total };
}

// The three strategies at a new budget, and what the change really does to the current trip.
function budgetShift(inventory, q, current, newBudget, { settings, now = new Date(), locks = {}, nightsOpen = true } = {}) {
  const cur = tripOf(current);
  const q2 = { ...q, budget: newBudget, vacationBudget: newBudget + (q.keep || 0) };
  const { cands, ...strategies } = plan(inventory, q2, { settings, now, nightsOpen });
  const changeWords = rows => rows.map(r => `${r.label.toLowerCase()}: ${r.b}${r.direction < 0 ? ` (was ${r.a})` : ''}`).join('; ');
  let note;
  if (newBudget > q.budget) {
    const extra = fmt(newBudget - q.budget);
    const more = strategies.strategies.find(s => s.key === 'more');
    if (more && more.trip.spec.nights > cur.spec.nights) {
      // Said with every other difference from the current trip, so more nights never reads as "better" on its own.
      const nights = plural(more.trip.spec.nights - cur.spec.nights, 'extra night');
      const lead = more.total > q.budget ? `Another ${extra} buys ${nights}` : `${nights} already fit your ${fmt(q.budget)}, so the extra ${extra} is not needed for them`;
      const rest = differences(more.trip, cur).all.filter(w => !w.endsWith(`instead of ${cur.spec.nights}`));
      note = { kind: 'extra-night', text: `${lead}: ${plural(more.trip.spec.nights, 'night')} in ${more.trip.dest.name} at ${fmt(more.total)} instead of ${plural(cur.spec.nights, 'night')} at ${fmt(cur.total)}${rest.length ? `, with ${list(rest)}` : ''}.` };
    } else {
      // A dearer version is worth the money only for a real gain (gains(), not a rating tick) with
      // nothing given up by classifyChanges. The facts rule most versions out before the full comparison.
      const dearer = cands.filter(c => c.total > cur.total).sort(cheapest);
      let real = null;
      for (const c of dearer) {
        const g = gains(cur, c.trip);
        if (g.all.length && !classifyChanges(cur, c.trip).tradeoffs.length) { real = { ...c, gets: list(g.all) }; break; }
      }
      if (real) {
        const already = real.total <= q.budget ? ` It already fit your ${fmt(q.budget)}; the extra ${extra} is not needed for it.` : '';
        note = { kind: 'upgrade-worth-it', text: `${fmt(real.total - cur.total)} more buys ${real.gets} in ${real.trip.dest.name} (${fmt(real.total)} instead of ${fmt(cur.total)}) without giving anything up.${already}` };
      } else if (dearer.length) {
        const eg = dearer[0], ch = classifyChanges(cur, eg.trip);
        note = { kind: 'upgrade-not-worth-it', text: `I priced ${plural(dearer.length, 'dearer version')} up to ${fmt(newBudget)}; none improves the trip without giving something up. The cheapest, ${fmt(eg.total)} in ${eg.trip.dest.name}, ${ch.tradeoffs.length ? `gives up ${changeWords(ch.tradeoffs)}` : `only changes ${changeWords(ch.neutral)}`}. I would keep the ${extra}.` };
      } else {
        note = { kind: 'nothing-changes', text: `Nothing dearer than ${fmt(cur.total)} was priced up to ${fmt(newBudget)}; the trip stays the same and you keep ${fmt(newBudget - cur.total)}.` };
      }
    }
  } else if (newBudget < cur.total) {
    const r = nameYourPrice(inventory, cur, settings, contexts(q2).ctx, newBudget, { now, locks });
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

module.exports = { threeWays, pushDirection, differentSet, mixTrips, budgetShift, differences, stepUp, LABELS, KEEP_SHARE };
