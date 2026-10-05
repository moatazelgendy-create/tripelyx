// The travel decision layer: everything that helps a traveler *decide*, built only from facts the
// engine already has. Nothing here invents data: verdicts come from the score and the trade-offs,
// usable vacation time from the flight schedule, budget unlocks from real re-priced changes, and
// "make it better" from enumerating and pricing every alternative package for the same trip. The
// platform's margin is never an input (the internal economics aren't passed in anywhere here).
const { addDays, today } = require('../lib/dates');
const { priceTrip } = require('./pricing');
const { scoreTrip, memoInventory, activitySets } = require('./optimizer');

const fmt = cents => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- usable vacation time ---------------------------------------------------------------------
// A trip is sold as "5 nights", but what you get depends on when the flights land and leave.
const DAY_START = 8 * 60;          // we count usable time from 8:00 AM...
const DAY_END = 22 * 60;           // ...to 10:00 PM
const ARRIVAL_BUFFER = 90;         // bags, transfer, check-in
const AIRPORT_BUFFER = 150;        // leave the hotel this long before the return flight (180 international)

function clock(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function hoursLabel(minutes) {
  if (minutes <= 0) return 'none';
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (!h) return `${m} min`;
  return m >= 30 ? `${h}½ hours` : plural(h, 'hour');
}

// Returns null when the flight has no schedule (a real adapter that doesn't return times).
function usableTime(t) {
  const f = t.flight;
  if (!Number.isFinite(f.departMinutes) || !Number.isFinite(f.arriveMinutes) || !Number.isFinite(f.returnDepartMinutes)) return null;
  const clamp = v => Math.max(0, Math.min(DAY_END - DAY_START, v));
  const settled = f.arriveMinutes + ARRIVAL_BUFFER;
  const firstDay = f.arrivesNextDay ? 0 : clamp(DAY_END - settled);
  const leaveHotel = f.returnDepartMinutes - (t.internationalTrip ? 180 : AIRPORT_BUFFER);
  const lastDay = clamp(leaveHotel - DAY_START);
  const fullDays = Math.max(0, t.spec.nights - 1 - (f.arrivesNextDay ? 1 : 0));
  const usableMinutes = fullDays * (DAY_END - DAY_START) + firstDay + lastDay;
  const flags = [];
  if (f.arrivesNextDay) flags.push({ kind: 'overnight', text: `You land the morning after you leave (${clock(f.arriveMinutes)}), so the first night is spent in the air.` });
  else if (firstDay < 3 * 60) flags.push({ kind: 'late-arrival', text: `You land at ${clock(f.arriveMinutes)} and reach the hotel around ${clock(settled)}, so the first day is mostly gone.` });
  if (leaveHotel < 6 * 60) flags.push({ kind: 'early-return', text: `The flight home leaves at ${clock(f.returnDepartMinutes)}, so you leave the hotel around ${clock(leaveHotel)}: no last day, and a very early start.` });
  else if (lastDay < 3 * 60) flags.push({ kind: 'short-last-day', text: `The flight home leaves at ${clock(f.returnDepartMinutes)}, so your last day ends around ${clock(leaveHotel)}.` });
  return {
    firstDay: { minutes: firstDay, arrive: clock(f.arriveMinutes), settled: clock(settled), label: hoursLabel(firstDay) },
    lastDay: { minutes: lastDay, leaveHotel: clock(leaveHotel), depart: clock(f.returnDepartMinutes), label: hoursLabel(lastDay) },
    fullDays, usableMinutes, usableLabel: `${fullDays} full ${fullDays === 1 ? 'day' : 'days'}${firstDay || lastDay ? ` plus ${hoursLabel(firstDay + lastDay)} on travel days` : ''}`,
    outbound: `${clock(f.departMinutes)} → ${clock(f.arriveMinutes)}${f.arrivesNextDay ? ' next day' : ''}`,
    inbound: `${clock(f.returnDepartMinutes)} → ${clock(f.returnArriveMinutes)}`,
    flags,
  };
}

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
  else if (style !== 'surprise' && style !== 'all-inclusive' && !t.dest.styles.includes(style)) out.push({ w: 3, text: `${t.dest.name} isn’t really a ${style === 'city' ? 'city-break' : style} destination` });
  if (prio === 'hotel' && t.hotel.stars <= 3) out.push({ w: 2, text: `a ${t.hotel.stars}-star hotel, when the hotel mattered most to you` });
  else if (t.hotel.stars <= 2) out.push({ w: 2, text: `a ${t.hotel.stars}-star hotel` });
  else if (t.hotel.stars === 3) out.push({ w: 1, text: 'a 3-star hotel' });
  if (prio === 'flights' && t.flight.stops > 0) out.push({ w: 2, text: `${t.flight.stops}-stop flights, when flights mattered most to you` });
  else if (t.flight.stops > 0 && t.flight.durationMinutes >= 8 * 60) out.push({ w: 1, text: `long ${t.flight.stops}-stop flights (${Math.round(t.flight.durationMinutes / 60)}h each way)` });
  if (t.flight.id === 'basic') out.push({ w: 2, text: 'a Basic fare: personal item only, no changes' });
  if (!t.hotel.features.beachfront && t.dest.styles.includes('beach') && ['beach', 'romantic', 'all-inclusive'].includes(style)) out.push({ w: 2, text: `not on the beach (${t.hotel.area})` });
  if (time) for (const fl of time.flags) out.push({ w: fl.kind === 'early-return' || fl.kind === 'overnight' ? 2 : 1, text: fl.kind === 'early-return' ? `a ${time.lastDay.leaveHotel} hotel departure on your last day` : fl.kind === 'overnight' ? 'an overnight flight that costs you the first night' : fl.kind === 'late-arrival' ? `a late arrival (${time.firstDay.arrive}) that uses up the first day` : `a short last day (you leave the hotel at ${time.lastDay.leaveHotel})` });
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
function optimizeAround(inventory, t, settings, ctx = {}, { locks = {}, cap = t.total, now = new Date() } = {}) {
  const inv = memoInventory(inventory);
  const s = t.spec;
  const base = scoreTrip(t, ctx);
  const hotels = locks.hotel ? [s.hotel] : t.hotelOptions.filter(h => !(s.who === 'family' && h.features.adultsOnly)).map(h => h.id);
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
    const sc = scoreTrip(p, ctx);
    if (sc.match <= base.match) continue;
    if (!best || sc.match > best.match || (sc.match === best.match && p.total < best.trip.total)) best = { trip: p, ...sc };
  }
  if (!best) return null;
  return { trip: best.trip, match: best.match, baseMatch: base.match, delta: best.trip.total - t.total, gains: tripDiff(t, best.trip).filter(r => r.changed && r.key !== 'total' && r.key !== 'verdict') };
}

// ---- side by side -----------------------------------------------------------------------------
// The fields two trips can differ on, as readable values. Used by the compare page and by the
// before/after view of an optimization.
function tripDiff(a, b, { date = x => x } = {}) {
  const stopsText = f => (f.stops ? `${f.stops} stop` : 'nonstop');
  const flex = t => [t.flight.refundable && 'flights refundable', t.hotel.refundable && 'hotel free to cancel'].filter(Boolean).join(', ') || 'flights and hotel non-refundable after 24h';
  const ta = usableTime(a), tb = usableTime(b);
  const rows = [
    ['total', 'Total, everything included', fmt(a.total), fmt(b.total)],
    ['dest', 'Destination', `${a.dest.name}, ${a.dest.country}`, `${b.dest.name}, ${b.dest.country}`],
    ['dates', 'Dates', `${date(a.spec.depart)} – ${date(a.flight.return)}`, `${date(b.spec.depart)} – ${date(b.flight.return)}`],
    ['nights', 'Length', plural(a.spec.nights, 'night'), plural(b.spec.nights, 'night')],
    ['hotel', 'Hotel', `${a.hotel.name} · ${a.hotel.stars}-star · ${a.hotel.rating}/5`, `${b.hotel.name} · ${b.hotel.stars}-star · ${b.hotel.rating}/5`],
    ['area', 'Location', `${a.hotel.area}${a.hotel.features.beachfront ? ' · beachfront' : ''}`, `${b.hotel.area}${b.hotel.features.beachfront ? ' · beachfront' : ''}`],
    ['meals', 'Meals', a.hotel.features.allInclusive ? 'All-inclusive' : a.hotel.features.breakfast ? 'Breakfast included' : 'Not included', b.hotel.features.allInclusive ? 'All-inclusive' : b.hotel.features.breakfast ? 'Breakfast included' : 'Not included'],
    ['flight', 'Flights', `${stopsText(a.flight)}, ${Math.round(a.flight.durationMinutes / 60)}h each way, ${a.flight.name} fare`, `${stopsText(b.flight)}, ${Math.round(b.flight.durationMinutes / 60)}h each way, ${b.flight.name} fare`],
    ['time', 'Usable vacation time', ta ? ta.usableLabel : 'Schedule not available', tb ? tb.usableLabel : 'Schedule not available'],
    ['bags', 'Bags', a.flight.checkedBagIncluded || a.spec.bags ? 'Checked bag included' : a.flight.carryOn ? 'Carry-on only' : 'Personal item only', b.flight.checkedBagIncluded || b.spec.bags ? 'Checked bag included' : b.flight.carryOn ? 'Carry-on only' : 'Personal item only'],
    ['experiences', 'Experiences', a.activities.length ? a.activities.map(x => x.name).join(', ') : 'None', b.activities.length ? b.activities.map(x => x.name).join(', ') : 'None'],
    ['transfer', 'Airport transfer', a.transfer ? 'Included, both ways' : 'Not included', b.transfer ? 'Included, both ways' : 'Not included'],
    ['flex', 'Cancellation', flex(a), flex(b)],
    ['perTraveler', 'Per traveler', fmt(a.perTraveler), fmt(b.perTraveler)],
    ['perNight', 'Per night', fmt(a.perNight), fmt(b.perNight)],
  ];
  return rows.map(([key, label, va, vb]) => ({ key, label, a: va, b: vb, changed: va !== vb }));
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

module.exports = { usableTime, timeAlternatives, compromises, biggestWin, verdict, budgetUnlocks, optimizeAround, tripDiff, realityCheck, clock, hoursLabel, GRADES };
