// WHEN CAN I GO FOR LESS? "Anytime in June" never turns into a question about exact dates: the same
// trip (destination, length, travelers, party, departure airport, experiences, transfer and bags) is
// priced on every departure date the suppliers can be asked about today, and the answer is the
// cheapest window that is still a strong trip, next to the range of the other windows actually
// priced. Every number here is a package pricing.priceTrip priced for that date; a range is the
// lowest and highest of the windows priced, never an average, a forecast or a "typical" price; a
// date that was not priced is not covered, and a pass cut off at the pricing limit says so
// (`truncated`). Rules and locks are never relaxed: a locked or exactly stated departure is the only
// date priced, hotels and fares stay inside the traveler's rules, and a window that would mean a
// compromise the current trip does not carry is recorded under `weak` with its reason instead of
// being offered.
const { addDays, today, isIsoDate } = require('../lib/dates');
const { format } = require('../lib/money');
const { priceTrip, roomsFor } = require('./pricing');
const { memoInventory, hotelAllowed, rulesAllowHotel, rulesAllowFlight } = require('./optimizer');
const { verdict, compromises, GRADES } = require('./decision');
const { classifyChanges } = require('./facts');
const { encodeSpec } = require('./spec');

const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MAX_PRICED = 2500;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LABEL = 'Cheapest strong week I found';
const COMPARABLE_LABEL = 'Cheapest comparable week I found';
const HONESTY = 'Today\'s prices for those dates, not a forecast; dates I did not price are not covered';
const PARTIAL = 'The pass was cut off at the pricing limit, so later dates were not priced';
const monthName = m => new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));

// ---- the dates to price ----------------------------------------------------------------------
// The caller's own list when given; else every day of the month the traveler named, from a week
// out; else every second day from two weeks to five months out (the optimizer's windows, all of
// them rather than its two cheapest). The trip's own departure is always among them while it is
// still ahead, so the trip competes on its own date whatever day the question is asked (the grid is
// laid from today, and a trip built yesterday sits between its lines). A locked departure, or one
// the traveler stated exactly, is the only date whatever else was asked: nothing here moves a date
// the traveler set.
function windowDates(trip, ctx = {}, { now = new Date(), locks = {}, dates = null } = {}) {
  const s = trip.spec;
  if ((locks && locks.dates) || ctx.dateMode === 'exact') return [s.depart];
  if (Array.isArray(dates)) return [...new Set(dates.filter(isIsoDate))].sort();
  const t = today(now);
  const out = [];
  if (ctx.month && MONTH.test(ctx.month)) {
    for (let d = `${ctx.month}-01`; d.slice(0, 7) === ctx.month; d = addDays(d, 1)) if (d >= addDays(t, 7)) out.push(d);
  } else {
    for (let i = 14; i <= 150; i += 2) out.push(addDays(t, i));
  }
  if (s.depart > t && !out.includes(s.depart) && (!ctx.month || !MONTH.test(ctx.month) || s.depart.slice(0, 7) === ctx.month)) out.push(s.depart);
  return out.sort();
}

// ---- the cheapest strong week -----------------------------------------------------------------
// On each date the trip's own hotel is priced when the supplier has it then; when it does not, the
// hotels the traveler's party, style and rules allow of the same star class or better (hotelChanged).
// The fare is the trip's own (by id, else by fare name) wherever the supplier offers it, like for
// like; only on a date without it do the fares inside the traveler's rules stand in (flightChanged). Each hotel × fare is priced in full
// and the date keeps its cheapest STRONG version: decision.verdict grades it great or good with the
// budget taken out, and it carries no compromise of weight 2 or more that the current trip does not
// already carry. A trip the verdict itself grades below good sets the standard instead (`standard`
// 'comparable'): a window must then be graded at least as well as the trip, so the comparison stays
// like for like and no week is called "strong" against a trip that is not. A date with no strong version is recorded under `weak` with the cheapest total
// priced that day and the reason it is not offered, read off the version that came closest to
// strong (fewest new compromises, then the highest grade): its top new compromise when it has one
// (kind 'compromise'), else the label of the grade it earned (kind 'grade', with the grade key).
// Pricing stops at `limit` versions: the date being priced then is dropped (its cheapest strong
// version was not established) and `truncated` is set, so callers can say the pass was partial.
const GRADE_RANK = { look: 0, budget: 1, good: 2, great: 3 };
const closer = (a, b) => a.fresh.length - b.fresh.length || GRADE_RANK[b.v.grade] - GRADE_RANK[a.v.grade] || a.trip.total - b.trip.total;
function cheapestWeeks(inventory, trip, settings, ctx = {}, { now = new Date(), locks = {}, dates = null, limit = MAX_PRICED } = {}) {
  const inv = memoInventory(inventory);
  const s = trip.spec;
  const qctx = { ...ctx, budget: null, allowOver: 0 };
  const had = new Set(compromises(trip, qctx).map(c => c.text));
  const ownGrade = verdict(trip, qctx).grade;
  const strongTrip = ownGrade === 'great' || ownGrade === 'good';
  const floor = strongTrip ? GRADE_RANK.good : GRADE_RANK[ownGrade];
  const judge = p => {
    const v = verdict(p, qctx);
    const fresh = v.compromises.filter(c => c.w >= 2 && !had.has(c.text));
    return { v, fresh, ok: GRADE_RANK[v.grade] >= floor && !fresh.length };
  };
  const list = windowDates(trip, ctx, { now, locks, dates });
  const rooms = roomsFor(s);
  const windows = [], weak = [];
  let priced = 0, truncated = false, searched = 0;
  outer: for (const depart of list) {
    const hotelsOn = inv.hotels.search({ destId: s.dest, checkIn: depart, nights: s.nights, rooms });
    const own = hotelsOn.find(h => h.id === s.hotel) || null;
    const flightsOn = inv.flights.search({ from: s.from, destId: s.dest, depart, nights: s.nights, travelers: s.travelers });
    const ownFlight = flightsOn.find(f => f.id === s.flight) || flightsOn.find(f => f.name === trip.flight.name) || null;
    // Like for like: a locked hotel or locked flights the supplier does not offer that day are never
    // swapped for another; the date is recorded as not offered, and the words say so.
    const lockOut = locks && locks.hotel && !own ? 'your locked hotel is not offered that week' : locks && locks.flight && !ownFlight ? 'your locked flights are not offered that week' : null;
    if (lockOut) { searched++; weak.push({ depart, total: null, reason: lockOut, kind: 'lock', grade: null }); continue; }
    const hotels = own ? [own] : hotelsOn.filter(h => h.stars >= trip.hotel.stars && hotelAllowed(h, { who: s.who, style: ctx.style }) && rulesAllowHotel(h, ctx.rules)).sort((a, b) => a.stars - b.stars);
    // The trip's own fare is the only one priced on a date the supplier offers it (by id, else by fare
    // name), so a week is never "cheaper" because of a different fare; other fares inside the rules
    // stand in only when it is not offered that day, and the swap is flagged (flightChanged).
    const flights = ownFlight ? [ownFlight] : flightsOn.filter(f => rulesAllowFlight(f, ctx.rules));
    let keep = null, cheapest = null, nearest = null;
    for (const h of hotels) for (const f of flights) {
      if (priced >= limit) { truncated = true; break outer; }
      priced++;
      const p = priceTrip(inv, { ...s, depart, hotel: h.id, flight: f.id }, settings);
      if (!p) continue;
      const j = { trip: p, ...judge(p) };
      if (!cheapest || p.total < cheapest.trip.total) cheapest = j;
      if (!nearest || closer(j, nearest) < 0) nearest = j;
      if (j.ok && (!keep || p.total < keep.total)) keep = { trip: p, total: p.total, flightChanged: !ownFlight || f.id !== ownFlight.id };
    }
    searched++;
    if (keep) {
      const p = keep.trip;
      windows.push({ depart, ret: p.flight.return || addDays(depart, s.nights), nights: s.nights, total: p.total, token: encodeSpec(p.spec), trip: p, changes: classifyChanges(trip, p), hotelChanged: p.spec.hotel !== s.hotel, flightChanged: keep.flightChanged, delta: p.total - trip.total });
    } else if (cheapest) {
      const top = nearest.fresh[0] || null;
      weak.push({ depart, total: cheapest.trip.total, reason: top ? top.text : GRADES[nearest.v.grade].label, kind: top ? 'compromise' : 'grade', grade: nearest.v.grade });
    }
  }
  windows.sort((a, b) => a.total - b.total || (a.depart < b.depart ? -1 : a.depart > b.depart ? 1 : 0));
  const ownToken = encodeSpec(s);
  // The cheapest window priced, which may be the trip itself on its own date; and `cheaper`, the one
  // worth moving to: strictly cheaper than the trip and not the trip. A dearer window is never
  // "the cheapest week" against the trip in hand, and the label exists only when one is cheaper.
  const cheapest = windows[0] || null;
  const cheaper = cheapest && cheapest.total < trip.total && cheapest.token !== ownToken ? cheapest : null;
  const range = windows.length ? { min: windows[0].total, max: Math.max(...windows.map(w => w.total)), count: windows.length } : null;
  const done = list.slice(0, searched);
  const held = (locks && locks.dates) || ctx.dateMode === 'exact';
  return {
    current: { depart: s.depart, ret: trip.flight.return || addDays(s.depart, s.nights), total: trip.total, token: ownToken, strong: strongTrip, grade: ownGrade, priced: done.includes(s.depart) },
    standard: strongTrip ? 'strong' : 'comparable',
    windows, cheapest, cheaper, range, weak, priced, datesSearched: searched, dates: done, truncated,
    month: !held && ctx.month && MONTH.test(ctx.month) ? ctx.month : null,
    span: done.length ? { from: done[0], to: done[done.length - 1] } : null,
    label: cheaper ? (strongTrip ? LABEL : COMPARABLE_LABEL) : null,
  };
}

// ---- the words ---------------------------------------------------------------------------------
// Plain pieces the agent can speak, each read off the result: the cheapest window's dates and price,
// the range of the OTHER windows priced (lowest to highest, nothing in between is implied) with how
// many there were and where they were looked for, and the line that says these are today's prices.
// Money is formatted by lib/money; dates by the caller's formatter (ISO when none is given).
function windowWords(out, { fmtDate = d => d } = {}) {
  const c = out && out.cheapest;
  const span = (a, b) => (/\s/.test(a) || /\s/.test(b) ? `${a} – ${b}` : `${a}–${b}`);
  const headline = c ? `${span(fmtDate(c.depart), fmtDate(c.ret))} at ${fmt(c.total)}` : null;
  let compared = null;
  if (c) {
    const others = out.windows.filter(w => w.depart !== c.depart);
    if (others.length) {
      const lo = Math.min(...others.map(w => w.total)), hi = Math.max(...others.map(w => w.total));
      const amounts = lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
      compared = out.month
        ? `Compared with the ${others.length} other ${monthName(out.month)} ${plural(others.length, 'window').replace(/^\d+ /, '')} I priced and would recommend for this trip: ${amounts}`
        : `Compared with the ${others.length} other ${plural(others.length, 'window').replace(/^\d+ /, '')} I priced and would recommend for this trip between ${fmtDate(out.span.from)} and ${fmtDate(out.span.to)}: ${amounts}`;
    }
  }
  return { headline, compared, honesty: HONESTY, partial: out && out.truncated ? PARTIAL : null };
}

module.exports = { cheapestWeeks, windowWords, windowDates, monthName, LABEL, COMPARABLE_LABEL, HONESTY, PARTIAL, MAX_PRICED };
