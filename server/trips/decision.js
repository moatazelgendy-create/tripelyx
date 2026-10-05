// The travel decision layer: everything that helps a traveler *decide*, built only from facts the
// engine already has. Nothing here invents data: verdicts come from the score and the trade-offs,
// usable vacation time from the flight schedule, budget unlocks from real re-priced changes, and
// "make it better" from enumerating and pricing every alternative package for the same trip. The
// platform's margin is never an input (the internal economics aren't passed in anywhere here).
const { addDays, today } = require('../lib/dates');
const { priceTrip } = require('./pricing');
const { scoreTrip, memoInventory, activitySets, hotelAllowed } = require('./optimizer');
// The fact-only comparison helpers live in facts.js (shared with the optimizer); re-exported here so
// every page keeps requiring them from the decision layer.
const { usableTime, classifyChanges, tripDiff, clock, hoursLabel } = require('./facts');

const { format } = require('../lib/money');
const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// "Get my day back": other flights on this trip that add usable time, with their real price difference.
function timeAlternatives(t, options) {
  const base = usableTime(t);
  if (!base) return [];
  return options.flights.filter(f => f.flight.id !== t.spec.flight).map(f => {
    const u = usableTime({ ...t, flight: f.flight });
    return u ? { flight: f.flight, delta: f.delta, total: f.total, gain: u.usableMinutes - base.usableMinutes, time: u } : null;
  }).filter(x => x && x.gain >= 60).sort((a, b) => b.gain - a.gain || a.delta - b.delta);
}

// ---- the verdict -----------------------------------------------------------------------------
// Compromises weighted by how much they matter for what the traveler told us. Weight 3 means it
// contradicts an answer they gave; 2 is a real downside; 1 is worth knowing.
function compromises(t, ctx = {}, time = usableTime(t)) {
  const style = ctx.style || 'surprise', prio = ctx.priority || 'price';
  const out = [];
  if (ctx.nightsAsked && t.spec.nights < ctx.nightsAsked) out.push({ w: 3, text: `${plural(ctx.nightsAsked - t.spec.nights, 'night')} shorter than you asked for` });
  if (style === 'all-inclusive' && !t.hotel.features.allInclusive) out.push({ w: 3, text: 'not an all-inclusive resort' });
  else if (style !== 'surprise' && style !== 'all-inclusive' && !t.dest.styles.includes(style)) out.push({ w: 3, text: `not really a ${style === 'city' ? 'city-break' : style} destination (${t.dest.name})` });
  if (prio === 'hotel' && t.hotel.stars <= 3) out.push({ w: 2, text: `a ${t.hotel.stars}-star hotel, when the hotel mattered most to you` });
  else if (t.hotel.stars <= 2) out.push({ w: 2, text: `a ${t.hotel.stars}-star hotel` });
  else if (t.hotel.stars === 3) out.push({ w: 1, text: 'a 3-star hotel' });
  if (prio === 'flights' && t.flight.stops > 0) out.push({ w: 2, text: `${t.flight.stops}-stop flights, when flights mattered most to you` });
  else if (t.flight.stops > 0 && t.flight.durationMinutes >= 8 * 60) out.push({ w: 1, text: `long ${t.flight.stops}-stop flights (${Math.round(t.flight.durationMinutes / 60)}h each way)` });
  if (t.flight.id === 'basic') out.push({ w: 2, text: 'a Basic fare: personal item only, no changes' });
  if (!t.hotel.features.beachfront && t.dest.styles.includes('beach') && ['beach', 'romantic', 'all-inclusive'].includes(style)) out.push({ w: 2, text: `not on the beach (${t.hotel.area})` });
  if (time) for (const fl of time.flags) out.push({ w: fl.kind === 'early-return' ? 2 : 1, text: fl.kind === 'early-return' ? `a ${time.lastDay.leaveHotel} hotel departure on your last day` : fl.kind === 'overnight' ? `an overnight flight (you land at ${time.firstDay.arrive} the next day)` : fl.kind === 'late-arrival' ? `a late arrival (${time.firstDay.arrive}) that uses up the first day` : `a short last day (you leave the hotel at ${time.lastDay.leaveHotel})` });
  if (!t.hotel.refundable) out.push({ w: 1, text: 'a non-refundable hotel rate' });
  if (!t.hotel.features.breakfast && !t.hotel.features.allInclusive) out.push({ w: 0.5, text: 'no breakfast included' });
  return out.sort((a, b) => b.w - a.w);
}

// The single best thing about this trip for this traveler.
function biggestWin(t, ctx = {}) {
  const budget = ctx.budget, prio = ctx.priority || 'price', style = ctx.style || 'surprise';
  const diff = budget ? budget - t.total : null;
  if (prio === 'hotel' && t.hotel.stars >= 4) return `a ${t.hotel.stars}-star hotel rated ${t.hotel.rating}/5, which is what you said mattered most`;
  if (prio === 'flights' && t.flight.stops === 0) return 'nonstop flights, which is what you said mattered most';
  if (prio === 'longer' && ctx.nightsAsked && t.spec.nights > ctx.nightsAsked) return `${plural(t.spec.nights - ctx.nightsAsked, 'extra night')} over what you asked for`;
  if (prio === 'activities' && t.activities.length >= 2) return `${plural(t.activities.length, 'experience')} already in the price`;
  if (prio === 'price' && diff !== null && diff >= budget * 0.15) return `${fmt(diff)} of your budget left over`;
  if (t.hotel.features.beachfront && ['beach', 'romantic', 'surprise', 'all-inclusive', 'family'].includes(style) && t.dest.styles.includes('beach')) return `a beachfront ${t.hotel.stars}-star hotel`;
  if (t.hotel.features.allInclusive) return 'meals and drinks included at the resort';
  if (t.typical > t.total * 1.1) return `a price about ${Math.round((1 - t.total / t.typical) * 100)}% below typical for these parts${t.demo ? ' (demo price history)' : ''}`;
  if (diff !== null && diff >= budget * 0.1) return `${fmt(diff)} of your budget left over`;
  if (t.flight.stops === 0) return `nonstop flights and a ${t.hotel.stars}-star hotel`;
  return `a ${t.hotel.stars}-star hotel rated ${t.hotel.rating}/5, every fee in the price`;
}

const GRADES = {
  great: { label: 'Great fit', tone: 'good' },
  good: { label: 'Good fit', tone: 'good' },
  budget: { label: 'Budget fit', tone: 'warn' },
  look: { label: 'We’d keep looking', tone: 'bad' },
};

// What we'd actually do with this trip, said plainly. Transparent rules, no scarcity, no pressure.
function verdict(t, ctx = {}, scores = scoreTrip(t, ctx)) {
  const budget = ctx.budget;
  const diff = budget ? budget - t.total : null;
  const time = usableTime(t);
  const cons = compromises(t, ctx, time);
  const win = biggestWin(t, ctx);
  const heavy = cons.filter(c => c.w >= 2);
  const top = cons[0] || null;
  let grade, action;
  if (diff !== null && diff < 0) {
    grade = 'look';
    action = ctx.allowOver
      ? `You allowed up to 10% more, so it’s your call: we’d only book it if ${win} is worth the extra ${fmt(-diff)}.`
      : `It’s ${fmt(-diff)} over the ${fmt(budget)} you set. We don’t call that within budget; see what gets it back under.`;
  } else if (cons.some(c => c.w >= 3)) {
    grade = 'budget';
    action = `It fits the money, but it’s ${top.text}. We’d book it only if that’s fine with you.`;
  } else if (scores.match >= 78 && heavy.length === 0) {
    grade = 'great';
    action = top ? `We’d book it. The only thing to know: ${top.text}.` : 'We’d book it.';
  } else if ((scores.match >= 66 && heavy.length <= 1) || !top) {
    grade = 'good';
    action = heavy.length ? `We’d book it, knowing it means ${heavy[0].text}.` : `We’d book it.${top ? ` Worth knowing: ${top.text}.` : ''}`;
  } else {
    grade = 'budget';
    action = `It fits the money, but it means ${heavy.slice(0, 2).map(c => c.text).join(' and ') || top.text}. We’d see what a little more buys before booking.`;
  }
  return { grade, ...GRADES[grade], win, compromise: top ? top.text : null, compromises: cons, action, match: scores.match, diff };
}

// ---- budget unlocks ---------------------------------------------------------------------------
// "What does another $100 get me?" from real re-priced single changes (see views/trips/trip.js
// singleChanges). One step per kind of change, cheapest first; `within` are the ones the remaining
// budget already covers. When nothing within budget is a real improvement we say so.
const KIND_RANK = { hotel: 0, flight: 1, nights: 2, transfer: 3, activity: 4, bags: 5, dates: 6 };
function budgetUnlocks(changes, diff) {
  const ups = changes.filter(c => c.delta > 0 && c.better).sort((a, b) => a.delta - b.delta || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  const steps = [];
  const seen = new Set();
  for (const c of ups) {
    if (seen.has(c.kind)) continue;
    seen.add(c.kind);
    steps.push({ ...c, within: diff !== null && c.delta <= diff });
    if (steps.length === 4) break;
  }
  return { steps, within: steps.filter(s => s.within), keep: diff !== null && diff > 0 && !steps.some(s => s.within) };
}

// ---- make it better / optimize around what's locked ------------------------------------------
// Enumerate every alternative package for this trip (hotel × flight × experiences × transfer, and
// nearby dates and lengths unless the dates are locked), price each in full, and return the one
// that scores highest for this traveler at or under `cap`. Returns null when nothing beats the
// current trip, which the pages say honestly instead of showing a lateral change.
// "Better" is judged on the trip itself, with the budget taken out of the score: a package that only
// scores higher because it is cheaper is "make it cheaper", which the customizer already offers. A
// proposal must improve at least one thing, must not earn a worse verdict than the trip it replaces,
// and must not add a compromise that contradicts an answer the traveler gave.
const GRADE_RANK = { look: 0, budget: 1, good: 2, great: 3 };
function optimizeAround(inventory, t, settings, ctx = {}, { locks = {}, cap = t.total, now = new Date() } = {}) {
  const inv = memoInventory(inventory);
  const s = t.spec;
  const qctx = { ...ctx, budget: null, allowOver: 0 };
  const base = scoreTrip(t, qctx);
  const baseGrade = GRADE_RANK[verdict(t, qctx, base).grade];
  const baseHard = compromises(t, ctx).filter(c => c.w >= 3).length;
  const hotels = locks.hotel ? [s.hotel] : t.hotelOptions.filter(h => hotelAllowed(h, { who: s.who, style: ctx.style })).map(h => h.id);
  const flights = locks.flight ? [s.flight] : t.flightOptions.map(f => f.id);
  const earliest = addDays(today(now), 3);
  const dates = locks.dates ? [s.depart] : [s.depart, ...[-2, -1, 1, 2].map(o => addDays(s.depart, o)).filter(d => d >= earliest)];
  const nightsList = locks.dates ? [s.nights] : [s.nights, s.nights + 1].filter(n => n <= 14); // never shorter: that is "make it cheaper", not "better"
  const sets = [s.activities, ...activitySets(t.activityOptions, ctx.style || 'surprise')];
  const seen = new Set();
  let best = null;
  for (const depart of dates) for (const nights of nightsList) for (const hotel of hotels) for (const flight of flights) for (const activities of sets) for (const transfer of [s.transfer, !s.transfer]) {
    const spec = { ...s, depart, nights, hotel, flight, activities: [...activities].sort(), transfer };
    const key = JSON.stringify(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === JSON.stringify({ ...s, activities: [...s.activities].sort() })) continue;
    const p = priceTrip(inv, spec, settings);
    if (!p || p.total > cap) continue;
    const sc = scoreTrip(p, qctx);
    if (sc.match <= base.match) continue;
    if (best && (sc.match < best.match || (sc.match === best.match && p.total >= best.trip.total))) continue;
    const changes = classifyChanges(t, p);
    if (!changes.improvements.length) continue;
    if (GRADE_RANK[verdict(p, qctx, sc).grade] < baseGrade) continue;
    if (compromises(p, ctx).filter(c => c.w >= 3).length > baseHard) continue;
    best = { trip: p, ...sc, changes };
  }
  if (!best) return null;
  return { trip: best.trip, match: best.match, baseMatch: base.match, delta: best.trip.total - t.total, improvements: best.changes.improvements, tradeoffs: best.changes.tradeoffs, changes: best.changes.neutral };
}

// ---- the reality check before paying ----------------------------------------------------------
// Each row is a fact with a status: ok (nothing to do), heads-up (good to know, in the price or
// the schedule) or verify (only the traveler can check it, e.g. passport validity).
function realityCheck(t, { weather } = {}) {
  const time = usableTime(t);
  const rows = [];
  rows.push(t.internationalTrip
    ? { status: 'verify', label: 'Travel documents', text: `${t.dest.country} needs a valid passport for every traveler, and entry rules depend on nationality. Check the official requirements before paying; we can’t guarantee entry.` }
    : { status: 'ok', label: 'Travel documents', text: 'Domestic trip: a government-issued photo ID is enough for US travelers.' });
  if (time) {
    rows.push({ status: time.flags.some(f => f.kind === 'overnight' || f.kind === 'late-arrival') ? 'heads-up' : 'ok', label: 'Arrival day', text: time.flags.find(f => f.kind === 'overnight' || f.kind === 'late-arrival')?.text || `You land at ${time.firstDay.arrive} and should be at the hotel around ${time.firstDay.settled}: about ${time.firstDay.label} of your first day to enjoy.` });
    rows.push({ status: time.flags.some(f => f.kind === 'early-return' || f.kind === 'short-last-day') ? 'heads-up' : 'ok', label: 'Last day', text: time.flags.find(f => f.kind === 'early-return' || f.kind === 'short-last-day')?.text || `Your flight home leaves at ${time.lastDay.depart}; leave the hotel around ${time.lastDay.leaveHotel}, so you still have about ${time.lastDay.label} that day.` });
  }
  rows.push(t.flight.checkedBagIncluded || t.spec.bags
    ? { status: 'ok', label: 'Bags', text: 'A checked bag for each traveler, both ways, is in the price.' }
    : { status: 'heads-up', label: 'Bags', text: `${t.flight.carryOn ? 'Carry-on only' : 'Personal item only (no carry-on)'} on this fare. Checked bags are ${fmt(t.flight.bagFeePerTraveler)} per traveler both ways and are not in this price unless you add them.` });
  rows.push(t.hotel.resortFeePerNight
    ? { status: 'ok', label: 'Hotel fees', text: `The mandatory resort fee (${fmt(t.hotel.resortFeePerNight)} per room per night) is already in your total. Incidentals are extra.` }
    : { status: 'ok', label: 'Hotel fees', text: 'No mandatory hotel fees. Incidentals (minibar, parking, spa) are extra.' });
  rows.push({ status: t.flight.refundable && t.hotel.refundable ? 'ok' : 'heads-up', label: 'Changing your mind', text: t.flight.refundable && t.hotel.refundable ? 'Every part can be canceled within its own window; the terms are listed below.' : `Full refund within 24 hours of booking (departure 7+ days away). After that: ${t.flight.refundable ? 'flights refundable' : 'flights non-refundable'}, ${t.hotel.refundable ? `hotel free to cancel until ${t.hotel.freeCancelHours} hours before` : 'hotel non-refundable'}.` });
  rows.push(t.transfer
    ? { status: 'ok', label: 'Getting to the hotel', text: 'A private transfer meets you at the airport and brings you back.' }
    : { status: 'heads-up', label: 'Getting to the hotel', text: 'No transfer is included. Taxis and shuttles are available at the airport; a private transfer can be added on the trip page so it’s in your total.' });
  if (weather) rows.push({ status: weather.warm ? 'ok' : 'heads-up', label: 'Weather', text: `${weather.label}, going by ${weather.source}. Not a forecast.` });
  return rows;
}

module.exports = { usableTime, timeAlternatives, compromises, biggestWin, verdict, budgetUnlocks, optimizeAround, classifyChanges, tripDiff, realityCheck, clock, hoursLabel, GRADES };
