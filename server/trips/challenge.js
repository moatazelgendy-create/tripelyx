// The Trip Challenge: the traveler brings a trip they are already considering and we say, honestly,
// whether we can build a better vacation. Like for like is the whole point: our version carries
// every inclusion theirs is known to have (bags, a transfer, meals, a refundable rate, nonstop
// flights, the hotel class), nothing unknown is assumed either way, and no saving is claimed that
// the comparison does not support. The platform is allowed to lose: "your deal wins" is a verdict.
const { AppError } = require('../lib/errors');
const { addDays, today, isIsoDate, daysBetween } = require('../lib/dates');
const { priceTrip, roomsFor } = require('./pricing');
const { memoInventory, hotelAllowed, scoreTrip, candidateDates, int, STYLES } = require('./optimizer');
const { classifyChanges } = require('./facts');

const UNKNOWN = 'unknown';
const FLIGHT = ['nonstop', 'stops', UNKNOWN];
const MEALS = ['none', 'breakfast', 'all-inclusive', UNKNOWN];
const BAGS = ['personal', 'carry-on', 'checked', UNKNOWN];
const TRANSFER = ['yes', 'no', UNKNOWN];
const CANCEL = ['nonrefundable', 'refundable', UNKNOWN];
const TAXES = ['included', 'excluded', UNKNOWN];
const LOCKS = ['nonstop', 'stars', 'nights', 'dates', 'meals', 'dest'];
const MODES = {
  less: { label: 'Same trip for less', blurb: 'Keep everything you said; find a lower complete price.' },
  better: { label: 'Better trip, same money', blurb: 'Spend what you were going to spend; improve something real.' },
  more: { label: 'More vacation, same money', blurb: 'Extra nights for the same money, or less.' },
  easier: { label: 'Easier trip', blurb: 'Nonstop, a transfer, shorter travel, for the same money.' },
  surprise: { label: 'Surprise me', blurb: 'Keep the experience, change the place.' },
};
const MEAL_RANK = { none: 0, breakfast: 1, 'all-inclusive': 2 };
const BAG_RANK = { personal: 0, 'carry-on': 1, checked: 2 };
const FLEX_RANK = { nonrefundable: 0, refundable: 2 };
const WHO = { solo: 1, couple: 2, family: 4, friends: 3 };
const PLUS = 10000; // the "$100 more" challenge, in cents

// ---- the challenger -------------------------------------------------------------------------
// What the traveler told us about the trip to beat. Every field they did not give stays unknown.
function parseChallenger(raw = {}, { maps, now = new Date() } = {}) {
  const t = today(now);
  const pick = (v, list) => (list.includes(v) ? v : UNKNOWN);
  const dest = raw.dest && maps.getDestination(String(raw.dest)) ? String(raw.dest) : null;
  const origin = raw.from && maps.getOrigin(String(raw.from).toUpperCase()) ? String(raw.from).toUpperCase() : null;
  let depart = isIsoDate(raw.depart) ? raw.depart : null;
  if (depart && (depart < addDays(t, 3) || daysBetween(t, depart) > 330)) depart = null;
  const who = WHO[raw.who] ? raw.who : 'couple';
  const travelers = int(raw.n, WHO[who], 1, 9);
  // Out-of-range values are not clamped into something the traveler did not say: they are missing.
  const within = (v, min, max) => { const n = int(v, null, -1e12, 1e12); return n !== null && n >= min && n <= max ? n : null; };
  const nights = within(raw.nights, 1, 14);
  const totalInput = within(String(raw.total || '').replace(/[,$\s]/g, ''), 100, 100000);
  const stars = ['3', '4', '5'].includes(String(raw.stars)) ? Number(raw.stars) : null;
  const hotel = dest && /^[a-z0-9-]{1,20}$/.test(String(raw.hotel || '')) ? String(raw.hotel) : null; // checked against the destination's hotels when the challenge runs
  const locks = [].concat(raw.lock || []).map(String).filter(l => LOCKS.includes(l));
  const style = STYLES.includes(raw.style) ? raw.style : null;
  const ch = {
    dest, origin, depart, who, travelers, nights, total: totalInput ? totalInput * 100 : null, totalInput,
    flight: pick(raw.flight, FLIGHT), stars, meals: pick(raw.meals, MEALS), bags: pick(raw.bags, BAGS),
    transfer: pick(raw.transfer, TRANSFER), cancel: pick(raw.cancel, CANCEL), taxes: pick(raw.taxes, TAXES),
    hotel, locks, style,
  };
  const missing = [];
  if (!dest) missing.push('dest');
  if (!origin) missing.push('from');
  if (!nights) missing.push('nights');
  if (!ch.total) missing.push('total');
  return { challenger: ch, missing };
}

// The fields a fair comparison needs that the traveler has not given.
const UNKNOWN_LABELS = { dates: 'the dates', flight: 'nonstop or not', stars: 'the hotel class', meals: 'meals', bags: 'bags', transfer: 'airport transfers', cancel: 'cancellation terms', taxes: 'whether taxes and fees are in the price' };
function unknownsOf(ch) {
  return Object.keys(UNKNOWN_LABELS).filter(k => (k === 'dates' ? !ch.depart : k === 'stars' ? ch.stars === null : ch[k] === UNKNOWN));
}

function challengerParams(ch, extra = {}) {
  const p = {
    dest: ch.dest, from: ch.origin, depart: ch.depart || undefined, who: ch.who, n: ch.travelers, nights: ch.nights, total: ch.totalInput,
    flight: ch.flight !== UNKNOWN ? ch.flight : undefined, stars: ch.stars || undefined, meals: ch.meals !== UNKNOWN ? ch.meals : undefined,
    bags: ch.bags !== UNKNOWN ? ch.bags : undefined, transfer: ch.transfer !== UNKNOWN ? ch.transfer : undefined,
    cancel: ch.cancel !== UNKNOWN ? ch.cancel : undefined, taxes: ch.taxes !== UNKNOWN ? ch.taxes : undefined,
    hotel: ch.hotel || undefined, style: ch.style || undefined, ...extra,
  };
  const sp = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  for (const l of ch.locks) sp.append('lock', l);
  return sp.toString();
}

// ---- like for like --------------------------------------------------------------------------
// What our version must carry so that it is comparable: the floor set by what theirs is known to
// include, plus anything the traveler locked. Unknown sets no floor; it is reported, never guessed.
function floorOf(ch) {
  const lock = l => ch.locks.includes(l);
  return {
    nonstop: ch.flight === 'nonstop' || lock('nonstop'),
    stars: ch.stars || 0,
    meals: MEAL_RANK[ch.meals] || 0,
    bags: BAG_RANK[ch.bags] || 0,
    transfer: ch.transfer === 'yes',
    flex: FLEX_RANK[ch.cancel] || 0,
    hotel: ch.hotel,
    nightsLocked: lock('nights'),
    datesLocked: lock('dates'),
    destLocked: lock('dest'),
  };
}
const ourMeals = h => (h.features.allInclusive ? 2 : h.features.breakfast ? 1 : 0);
const ourBags = t => (t.flight.checkedBagIncluded || t.spec.bags ? 2 : t.flight.carryOn ? 1 : 0);
const ourFlex = t => (t.flight.refundable ? 1 : 0) + (t.hotel.refundable ? 1 : 0);

// Every priced package that meets the floor, for the destinations, dates and lengths asked.
function comparablePackages(inv, ch, settings, { dests, nightsList, cap = null, nonstop = false, now = new Date() }) {
  const floor = floorOf(ch);
  const origin = inv.maps.getOrigin(ch.origin);
  const airport = origin.airports[0].code;
  const out = [];
  for (const dest of dests) {
    const q = { nights: ch.nights, travelers: ch.travelers, dateMode: ch.depart ? 'exact' : 'anytime', depart: ch.depart };
    const dates = candidateDates(inv, q, airport, dest.id, now);
    for (const depart of dates) for (const nights of nightsList) {
      const base = { dest: dest.id, from: airport, depart, nights, travelers: ch.travelers, who: ch.who };
      const flights = inv.flights.search({ from: airport, destId: dest.id, depart, nights, travelers: ch.travelers })
        .filter(f => (!(floor.nonstop || nonstop) || f.stops === 0) && (floor.flex < 2 || f.refundable) && (floor.bags < 1 || f.carryOn || f.checkedBagIncluded));
      const hotels = inv.hotels.search({ destId: dest.id, checkIn: depart, nights, rooms: roomsFor(base) })
        .filter(h => hotelAllowed(h, { who: ch.who, style: ch.style || 'surprise' }) && h.stars >= floor.stars && ourMeals(h) >= floor.meals && (floor.flex < 2 || h.refundable) && (!floor.hotel || h.id === floor.hotel));
      for (const f of flights) for (const h of hotels) for (const transfer of (floor.transfer ? [true] : [false, true])) {
        const bags = floor.bags === 2 && !f.checkedBagIncluded;
        const t = priceTrip(inv, { ...base, flight: f.id, hotel: h.id, activities: [], bags, transfer }, settings);
        if (t && (cap === null || t.total <= cap)) out.push(t);
      }
    }
  }
  return out;
}

// ---- the scoreboard --------------------------------------------------------------------------
// Their trip against ours, row by row, from facts on both sides. `who` says who is ahead on the
// row: ours, theirs, same, diff (different but not better or worse, such as the dates) or unknown.
function scoreboard(ch, t) {
  const cmp = (theirs, ours) => (theirs === null ? 'unknown' : ours > theirs ? 'ours' : ours < theirs ? 'theirs' : 'same');
  const rows = [];
  rows.push({ key: 'price', label: 'Price', theirs: { value: ch.total, note: ch.taxes === 'excluded' ? 'before taxes and fees' : ch.taxes === UNKNOWN ? 'taxes and fees: unknown' : 'taxes and fees included' }, ours: t ? { value: t.total, note: 'everything included' } : null, who: t ? (t.total < ch.total ? 'ours' : t.total > ch.total ? 'theirs' : 'same') : 'unknown' });
  rows.push({ key: 'nights', label: 'Nights', theirs: ch.nights, ours: t ? t.spec.nights : null, who: t ? cmp(ch.nights, t.spec.nights) : 'unknown' });
  rows.push({ key: 'dates', label: 'Dates', theirs: ch.depart, ours: t ? { depart: t.spec.depart, back: t.flight.return } : null, who: !t ? 'unknown' : !ch.depart ? 'unknown' : ch.depart === t.spec.depart ? 'same' : 'diff' });
  rows.push({ key: 'dest', label: 'Destination', theirs: ch.dest, ours: t ? t.dest.id : null, who: !t ? 'unknown' : t.dest.id === ch.dest ? 'same' : 'diff' });
  rows.push({ key: 'flight', label: 'Flight', theirs: ch.flight, ours: t ? { stops: t.flight.stops, durationMinutes: t.flight.durationMinutes, name: t.flight.name } : null, who: !t ? 'unknown' : cmp(ch.flight === UNKNOWN ? null : ch.flight === 'nonstop' ? 1 : 0, t.flight.stops === 0 ? 1 : 0) });
  rows.push({ key: 'hotel', label: 'Hotel', theirs: ch.stars, ours: t ? { name: t.hotel.name, stars: t.hotel.stars, rating: t.hotel.rating, area: t.hotel.area } : null, who: !t ? 'unknown' : ch.hotel && t.hotel.id === ch.hotel ? 'same' : cmp(ch.stars, t.hotel.stars) });
  rows.push({ key: 'meals', label: 'Meals', theirs: ch.meals, ours: t ? ourMeals(t.hotel) : null, who: !t ? 'unknown' : cmp(ch.meals === UNKNOWN ? null : MEAL_RANK[ch.meals], ourMeals(t.hotel)) });
  rows.push({ key: 'bags', label: 'Bags', theirs: ch.bags, ours: t ? ourBags(t) : null, who: !t ? 'unknown' : cmp(ch.bags === UNKNOWN ? null : BAG_RANK[ch.bags], ourBags(t)) });
  rows.push({ key: 'transfer', label: 'Airport transfer', theirs: ch.transfer, ours: t ? !!t.transfer : null, who: !t ? 'unknown' : cmp(ch.transfer === UNKNOWN ? null : ch.transfer === 'yes' ? 1 : 0, t.transfer ? 1 : 0) });
  rows.push({ key: 'cancel', label: 'Cancellation', theirs: ch.cancel, ours: t ? { flight: t.flight.refundable, hotel: t.hotel.refundable } : null, who: !t ? 'unknown' : cmp(ch.cancel === UNKNOWN ? null : FLEX_RANK[ch.cancel], ourFlex(t)) });
  rows.push({ key: 'taxes', label: 'Taxes and fees', theirs: ch.taxes, ours: t ? 'included' : null, who: !t ? 'unknown' : ch.taxes === UNKNOWN ? 'unknown' : ch.taxes === 'excluded' ? 'ours' : 'same' });
  return rows;
}

// ---- the verdict ------------------------------------------------------------------------------
// Four states, nothing invented to sell: beat (like for like, ours is better and no worse on any
// known row), tradeoff (better on some rows, different on others: the traveler decides), keep
// (their deal wins), info (something the comparison needs is unknown, so no verdict yet).
function verdictOf(ch, mode, t, rows, cheapest) {
  const unknowns = unknownsOf(ch);
  if (!t && !cheapest) return { state: 'keep', reason: 'none', ups: [], downs: [], different: [] };
  const known = rows.filter(r => r.key !== 'price' && r.key !== 'dates' && r.key !== 'dest');
  const ups = known.filter(r => r.who === 'ours').map(r => r.key);
  const downs = known.filter(r => r.who === 'theirs').map(r => r.key);
  const different = rows.filter(r => r.who === 'diff').map(r => r.key);
  // Unknowns mean no verdict either way: not a win for us, not a win for their deal.
  if (unknowns.length) return { state: 'info', unknowns, ups, downs, different, found: !!t };
  if (!t) return { state: 'keep', reason: cheapest.total >= ch.total ? 'dearer' : 'noimprovement', ups: [], downs: [], different: [] };
  const cheaper = t.total < ch.total;
  const sameMoney = t.total <= ch.total;
  const wins = mode === 'less' ? cheaper && !downs.length : sameMoney && ups.length >= 1 && !downs.length;
  if (wins && !different.length) return { state: 'beat', ups, downs, different };
  if ((wins || (cheaper && !downs.length)) && different.length) return { state: 'tradeoff', ups, downs, different };
  if (ups.length && downs.length) return { state: 'tradeoff', ups, downs, different };
  return { state: 'keep', reason: cheapest && cheapest.total >= ch.total ? 'dearer' : 'noimprovement', ups, downs, different };
}

// ---- the challenge ---------------------------------------------------------------------------
// Every mode is a different constraint on the same comparable set; the result of each is a real
// priced package or nothing. `all` carries the one-line answer of the other modes.
function runChallenge(inventory, ch, settings, { mode = 'less', now = new Date() } = {}) {
  if (!MODES[mode]) throw new AppError('invalid_mode', 'Pick how we should beat it.', 422);
  const inv = memoInventory(inventory);
  const dest = inv.maps.getDestination(ch.dest);
  if (!dest || (settings.disabledDestinations || []).includes(ch.dest)) throw new AppError('invalid_search', 'We don’t serve that destination yet.', 422);
  // A locked hotel must be one of ours at this destination; anything else is simply no lock.
  if (ch.hotel) {
    const probe = inv.hotels.search({ destId: ch.dest, checkIn: addDays(today(now), 14), nights: ch.nights, rooms: roomsFor({ travelers: ch.travelers, who: ch.who }) });
    if (!probe.some(h => h.id === ch.hotel)) ch = { ...ch, hotel: null };
  }
  const floor = floorOf(ch);
  const ctx = { budget: ch.total, keep: 0, allowOver: 0, style: ch.style || dest.styles[0] || 'surprise', priority: 'hotel', nightsAsked: ch.nights };
  const base = { dests: [dest], nightsList: [ch.nights], now };
  const byTotal = (a, b) => a.total - b.total;
  const improvementsOver = t => scoreboard(ch, t).filter(r => !['price', 'dates', 'dest'].includes(r.key) && r.who === 'ours').length;
  const bestOf = list => (list.length ? [...list].sort((a, b) => improvementsOver(b) - improvementsOver(a) || scoreTrip(b, ctx).match - scoreTrip(a, ctx).match || a.total - b.total)[0] : null);

  const same = comparablePackages(inv, ch, settings, base);
  const cheapest = same.length ? [...same].sort(byTotal)[0] : null;
  const modes = {};
  modes.less = cheapest;
  modes.better = bestOf(same.filter(t => t.total <= ch.total && improvementsOver(t) >= 1));
  modes.more = floor.nightsLocked ? null : (() => {
    const longer = comparablePackages(inv, ch, settings, { ...base, nightsList: [1, 2, 3].map(x => ch.nights + x).filter(n => n <= 14), cap: ch.total });
    return longer.length ? [...longer].sort((a, b) => b.spec.nights - a.spec.nights || a.total - b.total)[0] : null;
  })();
  modes.easier = (() => {
    const easy = comparablePackages(inv, ch, settings, { ...base, cap: ch.total, nonstop: true }).filter(t => improvementsOver(t) >= 1);
    return easy.length ? [...easy].sort((a, b) => (b.transfer ? 1 : 0) - (a.transfer ? 1 : 0) || a.flight.durationMinutes - b.flight.durationMinutes || a.total - b.total)[0] : null;
  })();
  modes.surprise = floor.destLocked ? null : (() => {
    const style = ctx.style;
    const others = inv.maps.listDestinations().filter(d => d.id !== ch.dest && !(settings.disabledDestinations || []).includes(d.id) && (style === 'surprise' || d.styles.includes(style)));
    const elsewhere = comparablePackages(inv, { ...ch, style }, settings, { ...base, dests: others, cap: ch.total });
    return elsewhere.length ? [...elsewhere].sort((a, b) => scoreTrip(b, ctx).match - scoreTrip(a, ctx).match || a.total - b.total)[0] : null;
  })();

  // The asked mode may find nothing within their money; when the same trip still costs less, that
  // is the honest answer, shown as "Same trip for less" rather than a "keep your deal" that the
  // cheaper version contradicts.
  let ours = modes[mode], fallback = null;
  if (!ours && mode !== 'less' && cheapest && cheapest.total < ch.total) { ours = cheapest; fallback = 'less'; }
  const rows = scoreboard(ch, ours);
  const verdict = verdictOf(ch, mode, ours, rows, cheapest);
  // "$100 more": only an improvement over what we already found (or over theirs) with nothing given up.
  const plusBase = ours || null;
  const plusPool = comparablePackages(inv, ch, settings, { ...base, cap: ch.total + PLUS }).filter(t => t.total > (plusBase ? plusBase.total : ch.total));
  const plus = bestOf(plusPool.filter(t => (plusBase ? (() => { const c = classifyChanges(plusBase, t); return c.improvements.length >= 1 && c.tradeoffs.length === 0; })() : improvementsOver(t) >= 1)));
  const receipt = ours ? receiptOf(ch, rows, verdict) : null;
  return { mode, fallback, challenger: ch, floor, ctx, ours, rows, verdict, receipt, cheapest, considered: same.length, modes, plus: plus ? { trip: plus, delta: plus.total - (plusBase ? plusBase.total : ch.total), changes: plusBase ? classifyChanges(plusBase, plus) : null } : null, unknowns: unknownsOf(ch) };
}

// What we changed, what we kept and what the traveler keeps in money, from the scoreboard rows.
function receiptOf(ch, rows, verdict) {
  const kept = rows.filter(r => r.who === 'same').map(r => r.key);
  const changed = rows.filter(r => ['ours', 'theirs', 'diff'].includes(r.who) && r.key !== 'price').map(r => r.key);
  const unknown = rows.filter(r => r.who === 'unknown' && r.key !== 'price').map(r => r.key);
  const price = rows.find(r => r.key === 'price');
  const diff = price.ours ? ch.total - price.ours.value : 0;
  return { kept, changed, unknown, diff, saving: verdict.state === 'beat' || verdict.state === 'tradeoff' ? Math.max(0, diff) : 0 };
}

module.exports = { parseChallenger, challengerParams, unknownsOf, floorOf, comparablePackages, scoreboard, verdictOf, runChallenge, receiptOf, MODES, LOCKS, UNKNOWN, UNKNOWN_LABELS, FLIGHT, MEALS, BAGS, TRANSFER, CANCEL, TAXES, PLUS };
