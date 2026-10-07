// Fact-only comparison helpers shared by the optimizer and the decision layer: what a flight
// schedule leaves you of each day, and which way every difference between two priced trips goes.
// Nothing here looks at the budget, the traveler's answers or the platform's economics; it reads
// the trips themselves. This module must not require optimizer.js or decision.js.
const { format } = require('../lib/money');
const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- usable vacation time ---------------------------------------------------------------------
// A trip is sold as "5 nights", but what you get depends on when the flights land and leave.
const DAY_START = 8 * 60;          // we count usable time from 8:00 AM...
const DAY_END = 22 * 60;           // ...to 10:00 PM
const FULL_DAY = DAY_END - DAY_START;
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
  const clamp = v => Math.max(0, Math.min(FULL_DAY, v));
  const settled = f.arriveMinutes + ARRIVAL_BUFFER;
  // The arrival day is the day you reach the hotel: the departure day for a same-day arrival, the
  // next day for an overnight flight (which then loses one full day in the middle, not the arrival day).
  const firstDay = clamp(DAY_END - Math.max(settled, DAY_START));
  const leaveHotel = f.returnDepartMinutes - (t.internationalTrip ? 180 : AIRPORT_BUFFER);
  const lastDay = clamp(leaveHotel - DAY_START);
  const fullDays = Math.max(0, t.spec.nights - 1 - (f.arrivesNextDay ? 1 : 0));
  const usableMinutes = fullDays * FULL_DAY + firstDay + lastDay;
  const wholeFirst = firstDay >= FULL_DAY; // at the hotel before 8 AM: the arrival day is a full day
  const travelMinutes = (wholeFirst ? 0 : firstDay) + lastDay;
  const days = fullDays + (wholeFirst ? 1 : 0);
  const flags = [];
  if (f.arrivesNextDay) flags.push({ kind: 'overnight', text: f.arriveMinutes < 4 * 60
    ? `You land at ${clock(f.arriveMinutes)} the night after you leave and reach the hotel around ${clock(settled)}, so the first night is a short one.`
    : `You fly overnight and land at ${clock(f.arriveMinutes)} the next day${firstDay < 3 * 60 ? `, reaching the hotel around ${clock(settled)} with little of that day left` : ', so the first night is spent in the air, not at the hotel'}.` });
  else if (firstDay < 3 * 60) flags.push({ kind: 'late-arrival', text: `You land at ${clock(f.arriveMinutes)} and reach the hotel around ${clock(settled)}, so the first day is mostly gone.` });
  if (leaveHotel < 6 * 60) flags.push({ kind: 'early-return', text: `The flight home leaves at ${clock(f.returnDepartMinutes)}, so you leave the hotel around ${clock(leaveHotel)}: no last day, and a very early start.` });
  else if (lastDay < 3 * 60) flags.push({ kind: 'short-last-day', text: `The flight home leaves at ${clock(f.returnDepartMinutes)}, so your last day ends around ${clock(leaveHotel)}.` });
  return {
    firstDay: { minutes: firstDay, arrive: clock(f.arriveMinutes), nextDay: !!f.arrivesNextDay, settled: clock(settled), label: wholeFirst ? 'a full day' : hoursLabel(firstDay) },
    lastDay: { minutes: lastDay, leaveHotel: clock(leaveHotel), depart: clock(f.returnDepartMinutes), label: hoursLabel(lastDay) },
    fullDays, usableMinutes, usableLabel: `${days} full ${days === 1 ? 'day' : 'days'}${travelMinutes ? ` plus ${hoursLabel(travelMinutes)} on travel days` : ''}`,
    outbound: `${clock(f.departMinutes)} → ${clock(f.arriveMinutes)}${f.arrivesNextDay ? ' next day' : ''}`,
    inbound: `${clock(f.returnDepartMinutes)} → ${clock(f.returnArriveMinutes)}`,
    flags,
  };
}

// ---- side by side -----------------------------------------------------------------------------
// The fields two trips can differ on, as readable values. Used by the compare page, the before/after
// view of an optimization, and the optimizer's upgrade test.
const dur = m => `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}`;
// Bags are read off the fare and the spec: a checked bag (included in the fare or bought) with or
// without a carry-on, a carry-on only, or a personal item only; a checked bag on a fare with no
// carry-on is said as such, so a switch to that fare never reads as the same bags. Experiences are a
// set: the same experiences listed in another order are the same experiences, so they are compared
// and shown sorted by name.
const hasChecked = t => !!(t.flight.checkedBagIncluded || t.spec.bags);
const bagsText = t => (hasChecked(t) ? (t.flight.carryOn ? 'Checked bag included' : 'Checked bag included (no carry-on)') : t.flight.carryOn ? 'Carry-on only' : 'Personal item only');
const activitiesText = t => (t.activities.length ? t.activities.map(x => x.name).sort().join(', ') : 'None');
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
    ['flight', 'Flights', `${stopsText(a.flight)}, ${dur(a.flight.durationMinutes)} each way, ${a.flight.name} fare`, `${stopsText(b.flight)}, ${dur(b.flight.durationMinutes)} each way, ${b.flight.name} fare`],
    ['time', 'Usable vacation time', ta ? ta.usableLabel : 'Schedule not available', tb ? tb.usableLabel : 'Schedule not available'],
    ['bags', 'Bags', bagsText(a), bagsText(b)],
    ['experiences', 'Experiences', activitiesText(a), activitiesText(b)],
    ['transfer', 'Airport transfer', a.transfer ? 'Included, both ways' : 'Not included', b.transfer ? 'Included, both ways' : 'Not included'],
    ['flex', 'Cancellation', flex(a), flex(b)],
    ['perTraveler', 'Per traveler', fmt(a.perTraveler), fmt(b.perTraveler)],
    ['perNight', 'Per night', fmt(a.perNight), fmt(b.perNight)],
  ];
  return rows.map(([key, label, va, vb]) => ({ key, label, a: va, b: vb, changed: va !== vb }));
}

// The price lines two trips can differ on, in money: what each part costs in one trip against the
// other. Keys follow pricing.js; a line a trip does not have counts as zero.
const LINE_ORDER = ['flights', 'hotel', 'experiences', 'transfer', 'bags', 'taxes', 'service', 'promo'];
const LINE_LABEL = { flights: 'Flight fares', hotel: 'Hotel stay', experiences: 'Experiences', transfer: 'Airport transfer', bags: 'Checked bags', taxes: 'Taxes and mandatory fees', service: 'Service fee', promo: 'Promo code' };
const lineAmount = (t, key) => (t.lines.find(l => l.key === key) || { amount: 0 }).amount;
function lineDiff(a, b) {
  const keys = LINE_ORDER.filter(k => a.lines.some(l => l.key === k) || b.lines.some(l => l.key === k));
  return keys.map(key => ({ key, label: LINE_LABEL[key] || key, a: lineAmount(a, key), b: lineAmount(b, key), delta: lineAmount(b, key) - lineAmount(a, key) }));
}

// Which way each difference between two trips goes, from the facts rather than the wording.
const MEAL_RANK = h => (h.features.allInclusive ? 2 : h.features.breakfast ? 1 : 0);
// Bags rank monotone on what the traveler can bring: a checked bag (included or bought) counts 2 and
// a carry-on 1 more, so personal item only = 0, carry-on = 1, checked bag without a carry-on = 2,
// checked bag with a carry-on = 3. A carry-on fare to a personal-item fare with a bought bag is a
// step up (1 to 2), but a carry-on fare with a bought bag to that same fare is a step down (3 to 2).
const BAG_RANK = t => (hasChecked(t) ? 2 : 0) + (t.flight.carryOn ? 1 : 0);
const FLEX_RANK = t => (t.flight.refundable ? 1 : 0) + (t.hotel.refundable ? 1 : 0);
function direction(key, a, b) {
  const sign = (x, y, min = 0) => (y - x > min ? 1 : x - y > min ? -1 : 0);
  switch (key) {
    case 'hotel': return sign(a.hotel.stars, b.hotel.stars) || sign(a.hotel.rating, b.hotel.rating);
    case 'area': return sign(a.hotel.features.beachfront ? 1 : 0, b.hotel.features.beachfront ? 1 : 0);
    case 'meals': return sign(MEAL_RANK(a.hotel), MEAL_RANK(b.hotel));
    case 'flight': return -sign(a.flight.stops, b.flight.stops) || -sign(a.flight.durationMinutes, b.flight.durationMinutes, 59);
    case 'time': { const ta = usableTime(a), tb = usableTime(b); return ta && tb ? sign(ta.usableMinutes, tb.usableMinutes, 59) : 0; }
    case 'bags': return sign(BAG_RANK(a), BAG_RANK(b));
    case 'experiences': return sign(a.activities.length, b.activities.length);
    case 'transfer': return sign(a.transfer ? 1 : 0, b.transfer ? 1 : 0);
    case 'flex': return sign(FLEX_RANK(a), FLEX_RANK(b));
    case 'nights': return sign(a.spec.nights, b.spec.nights);
    default: return 0;
  }
}

// Every difference between two trips sorted into what gets better, what gets worse and what is
// merely different (destination, dates, a same-rank hotel swap).
function classifyChanges(a, b, opts) {
  const rows = tripDiff(a, b, opts).filter(r => r.changed && !['total', 'perTraveler', 'perNight'].includes(r.key)).map(r => ({ ...r, direction: direction(r.key, a, b) }));
  return { improvements: rows.filter(r => r.direction > 0), tradeoffs: rows.filter(r => r.direction < 0), neutral: rows.filter(r => r.direction === 0) };
}

module.exports = { usableTime, clock, hoursLabel, direction, classifyChanges, tripDiff, lineDiff, lineAmount, hasChecked, LINE_ORDER, LINE_LABEL, DAY_START, DAY_END, FULL_DAY, ARRIVAL_BUFFER, AIRPORT_BUFFER };
