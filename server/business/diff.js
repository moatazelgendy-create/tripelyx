// What changes between two versions of a trip (plan §G2 "giveUps", §H2 "Requested vs cheapest option inside
// policy"). Fields are read from a declared list, never Object.keys order (JSONB reorders keys); the 1B
// diff.js pattern. Pure: no store, no clock, inputs never mutated.
// The service holds compareTrips as this.alternatives.compareTrips (types.AlternativesEngine);
// buildAlternatives calls giveUps itself.
//
// giveUps, for example: "Leaves 07:05 instead of 13:40" · "Arrives 2h 10m later" · "1 stop in Istanbul,
// adds 1h 50m" · "No free changes" · "Refunds nothing (yours refunds 70%)" · "1 checked bag instead of 2" ·
// "4-star instead of 5-star" · "Your trip moves 1 day later" · "Nothing else changes". No amounts (the saving
// is shown by the view), no em dash. On a return trip each flight line names its leg ("Return: leaves 07:05
// instead of 13:40"; a cabin or fare name keeps its capital: "Outbound: Economy instead of Business"). Times
// are local wall-clock times at each airport; a 'dates' shift is taken out before arrival times are compared,
// so the same flight a day later is not "24h later". The date shift comes first in giveUps.
// Another hotel always says so ("Stays at Kestrel Yard Hotel instead of Aldermoor House"), and its room is
// compared with the pick's room (name, bed, how many it sleeps) like a room in the same hotel, so "Nothing
// else changes" means only the price (or nothing a traveler gives up) changed.
//
// compareTrips rows follow DIFF_FIELDS order, the TripComparison typedef's declared order (carrier, times,
// stops, cabin, fare, bags, refunds, hotel, room, stars, dates) with the fare terms ('changes') after refunds
// and the hotel cancellation ('hotelRefunds') after stars; one row per field and flight leg that differs.
//
// Supplier rows (real-suppliers design §8.3; a row's source is read from its offer id, source.sourceOf): what
// the airline or hotel supplier doesn't say is never turned into a fact. "No changes allowed" only when the
// alternative's terms hold source.TERMS.changesNotAllowed (an unknown change rule says "Changes not confirmed
// by the airline" instead); a refund the terms don't confirm (source.refundsUnconfirmed) is "No refund
// confirmed", never "Refunds nothing"; cabinKg and checkedKg 0 mean "not stated", so no line ever says
// "0 kg", and checked bags the airline doesn't state are not compared; hotel stars 0 is "No star rating".
// Demo rows keep every rule above exactly.
const { CABIN_RANK, CABIN_LABELS } = require('./constants');
const { sourceOf, TERMS, saysNoChanges, refundsUnconfirmed, changesUnconfirmed } = require('./source');

/** The compared fields, in row order. */
const DIFF_FIELDS = Object.freeze(['carrier', 'times', 'stops', 'cabin', 'fare', 'bags', 'refunds', 'changes', 'hotel', 'room', 'stars', 'hotelRefunds', 'dates']);

const DAY_MS = 86400000;
const MONEY = /[$€£¥]|\bUSD\b/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "2h 10m", "2h", "45m". */
function hm(minutes) {
  const m = Math.abs(minutes), h = Math.floor(m / 60), r = m % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
}
/** Minutes since the epoch of a local wall-clock time 'YYYY-MM-DDTHH:MM' (read as if UTC; differences only). */
const wall = local => Date.parse(`${local}:00Z`) / 60000;
const dateOf = local => String(local).slice(0, 10);
const timeOf = local => String(local).slice(11, 16);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** 'Thu 12 Nov' for '2026-11-12'. */
function shortDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
/** The first words a leg prefix lowercases ("Outbound: leaves …"); cabin and fare names keep their capital. */
const LOWER_AFTER_LEG = /^(?:Flies|Leaves|Arrives|Refunds|No)\b/;
const afterLeg = s => (LOWER_AFTER_LEG.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

const first = row => row.segments[0];
const last = row => row.segments[row.segments.length - 1];
const viaText = row => (row.via || []).map(v => v.city).join(' and ');

/** The trip's first departure date (outbound) and the date the hotel starts, for the 'dates' field. */
function tripStart(rows) {
  if (rows.out && rows.out.segments && rows.out.segments.length) return dateOf(first(rows.out).departLocal);
  return rows.hotel ? rows.hotel.checkIn : null;
}

function tripDatesText(rows) {
  const parts = [];
  if (rows.out) parts.push(shortDate(dateOf(first(rows.out).departLocal)));
  if (rows.back) parts.push(shortDate(dateOf(first(rows.back).departLocal)));
  else if (rows.hotel) parts.push(shortDate(rows.hotel.checkOut));
  return parts.join(' to ');
}

/** A row from a real supplier (sandbox or live), whose unknown terms are not facts. */
const supplier = r => sourceOf(r) !== 'demo';
/** The terms text of a flight row. */
const termsOf = r => (r && r.fare && typeof r.fare.terms === 'string' ? r.fare.terms : '');
/** A supplier row's refund terms are not confirmed (the airline didn't say, or the fee is in another currency). */
const refundUnknown = r => supplier(r) && refundsUnconfirmed(termsOf(r), { currency: r.currency || 'USD' });
/** A supplier row's change rule is not confirmed (the airline didn't say whether, or the fee). */
const changesUnknown = r => supplier(r) && changesUnconfirmed(termsOf(r));
/** Does the row state its checked bags? (A supplier row whose terms say the airline doesn't state them: no.) */
const checkedStated = r => !supplier(r) || !(termsOf(r).includes(TERMS.bagsUnknown) || termsOf(r).includes('checked bags not stated'));
/** "4-star", "4.5-star", or "No star rating" for a supplier hotel with none (stars 0). */
const starsText = r => (supplier(r) && r.stars === 0 ? 'No star rating' : `${r.stars}-star`);

/** Flight-leg give-ups for one DIFF_FIELDS field. p: the pick's row, q: the alternative's; shift: days moved. */
const FLIGHT_GIVE_UPS = {
  carrier: (p, q) => (q.carrier.code !== p.carrier.code ? [`Flies with ${q.carrier.name} instead of ${p.carrier.name}`] : []),
  times: (p, q, shift) => {
    const out = [];
    if (timeOf(first(q).departLocal) !== timeOf(first(p).departLocal)) out.push(`Leaves ${timeOf(first(q).departLocal)} instead of ${timeOf(first(p).departLocal)}`);
    const later = wall(last(q).arriveLocal) - shift * 1440 - wall(last(p).arriveLocal);
    if (later > 0) out.push(`Arrives ${hm(later)} later`);
    return out;
  },
  stops: (p, q) => {
    if (q.stops <= p.stops) return [];
    const adds = q.elapsedMinutes - p.elapsedMinutes;
    const where = viaText(q);
    return [`${plural(q.stops, 'stop')}${where ? ` in ${where}` : ''}${adds > 0 ? `, adds ${hm(adds)}` : ''}`];
  },
  cabin: (p, q) => (CABIN_RANK[q.cabin] < CABIN_RANK[p.cabin] ? [`${CABIN_LABELS[q.cabin]} instead of ${CABIN_LABELS[p.cabin]}`] : []),
  fare: (p, q) => {
    if (q.fare.code === p.fare.code) return [];
    // The fare's name only when nothing more specific (bags, refunds, changes) says what it changes.
    const specific = ['bags', 'refunds', 'changes'].some(k => FLIGHT_GIVE_UPS[k](p, q).length);
    return specific ? [] : [`${q.fare.name} fare instead of ${p.fare.name}`];
  },
  bags: (p, q) => {
    const out = [];
    const a = p.fare.checkedBags, b = q.fare.checkedBags;
    if (checkedStated(p) && checkedStated(q) && b < a) out.push(`${b === 0 ? 'No checked bag' : plural(b, 'checked bag')} instead of ${a}`);
    // A supplier's 0 kg is "not stated": only two stated weights compare.
    const kgStated = !(supplier(p) || supplier(q)) || (q.fare.cabinKg > 0 && p.fare.cabinKg > 0);
    if (kgStated && q.fare.cabinKg < p.fare.cabinKg) out.push(`${q.fare.cabinKg} kg cabin bag instead of ${p.fare.cabinKg} kg`);
    return out;
  },
  refunds: (p, q) => {
    const a = p.fare.refundablePercent, b = q.fare.refundablePercent;
    if (refundUnknown(q)) {
      // Nothing is confirmed for the alternative: it is a give-up only against a pick that does refund.
      return a > 0 && !refundUnknown(p) ? [`No refund confirmed (yours refunds ${a}%)`] : [];
    }
    if (b >= a) return [];
    return [`${b === 0 ? 'Refunds nothing' : `Refunds ${b}%`} (yours refunds ${a}%)`];
  },
  changes: (p, q) => {
    const free = f => /free changes/i.test(f.terms || '');
    if (supplier(q)) {
      // Only the airline's own "not allowed" is a lost change; a rule it doesn't state is not confirmed.
      if (saysNoChanges(termsOf(q))) return p.fare.changeable && !saysNoChanges(termsOf(p)) ? ['No changes allowed'] : [];
      if (changesUnknown(q)) return p.fare.changeable && !changesUnknown(p) ? ['Changes not confirmed by the airline'] : [];
      if (q.fare.changeable && free(p.fare) && !free(q.fare)) return ['No free changes'];
      return [];
    }
    if (p.fare.changeable && !q.fare.changeable) return ['No changes allowed'];
    if (q.fare.changeable && free(p.fare) && !free(q.fare)) return ['No free changes'];
    return [];
  },
};

/** Hotel give-ups for one field. */
const HOTEL_GIVE_UPS = {
  hotel: (p, q) => {
    if (q.offerId === p.offerId) return [];
    const out = [q.name && p.name && q.name !== p.name ? `Stays at ${q.name} instead of ${p.name}` : 'Another hotel'];
    if (q.area && p.area && q.area !== p.area) out.push(`${q.area} instead of ${p.area}`);
    return out;
  },
  // The room, in the same hotel or another one.
  room: (p, q) => {
    const a = p.room || {}, b = q.room || {};
    const out = [];
    if (b.name && a.name && b.name !== a.name) out.push(`${b.name} instead of ${a.name}`);
    if (b.bed && a.bed && b.bed !== a.bed) out.push(`${b.bed} instead of ${a.bed}`);
    if (Number.isInteger(b.sleeps) && Number.isInteger(a.sleeps) && b.sleeps < a.sleeps) out.push(`Sleeps ${b.sleeps} instead of ${a.sleeps}`);
    return out;
  },
  stars: (p, q) => (q.stars < p.stars ? [`${starsText(q)} instead of ${starsText(p)}`] : []),
  hotelRefunds: (p, q) => {
    const a = p.cancellation, b = q.cancellation;
    if (a.refundable && !b.refundable) return ["Can't be cancelled (yours can)"];
    if (a.refundable && b.refundable && b.freeUntilHours > a.freeUntilHours) {
      return [`Free cancellation ends ${b.freeUntilHours} hours before check-in instead of ${a.freeUntilHours}`];
    }
    return [];
  },
};

/**
 * What the traveler gives up by taking `alt` instead of `pick` (what gets worse or different; never the price).
 * @param {import('./types').TripRows} pick
 * @param {import('./types').TripRows} alt
 * @returns {string[]} ['Nothing else changes'] when only the price differs
 */
function giveUps(pick, alt) {
  const out = [];
  const start = tripStart(pick), moved = tripStart(alt);
  const shift = start && moved ? daysBetween(start, moved) : 0;
  const twoLegs = !!(pick.back || alt.back);
  // The date shift first (it changes the whole trip), then the other fields in DIFF_FIELDS order.
  if (shift) out.push(`Your trip moves ${plural(Math.abs(shift), 'day')} ${shift > 0 ? 'later' : 'earlier'}`);
  for (const field of DIFF_FIELDS) {
    if (field === 'dates') continue;
    if (FLIGHT_GIVE_UPS[field]) {
      for (const c of ['out', 'back']) {
        const p = pick[c], q = alt[c];
        if (!p || !q || p.key === q.key) continue;
        for (const line of FLIGHT_GIVE_UPS[field](p, q, shift)) out.push(twoLegs ? `${c === 'out' ? 'Outbound' : 'Return'}: ${afterLeg(line)}` : line);
      }
    } else if (HOTEL_GIVE_UPS[field]) {
      const p = pick.hotel, q = alt.hotel;
      if (p && q && p.key !== q.key) out.push(...HOTEL_GIVE_UPS[field](p, q));
    }
  }
  const safe = out.filter(line => !MONEY.test(line));
  return safe.length ? safe : ['Nothing else changes'];
}

/** Display text per field for compareTrips. */
const FLIGHT_TEXT = {
  carrier: r => `${r.carrier.name} ${r.flightNumbers.join(', ')}`,
  times: r => {
    const days = daysBetween(dateOf(first(r).departLocal), dateOf(last(r).arriveLocal));
    return `${timeOf(first(r).departLocal)} to ${timeOf(last(r).arriveLocal)}${days > 0 ? ` (+${days})` : ''}`;
  },
  stops: r => `${r.stops ? `${plural(r.stops, 'stop')} in ${viaText(r)}` : 'Nonstop'}, ${hm(r.elapsedMinutes)}`,
  cabin: r => r.cabinLabel || CABIN_LABELS[r.cabin],
  fare: r => r.fare.name,
  bags: r => {
    if (!supplier(r)) return `${r.fare.cabinKg} kg cabin bag, ${r.fare.checkedBags ? `${plural(r.fare.checkedBags, 'checked bag')} (${r.fare.checkedKg} kg)` : 'no checked bag'}`;
    // A supplier's weights are printed only when stated (0 kg is "not stated").
    const checked = !checkedStated(r) ? 'checked bags not stated by the airline'
      : r.fare.checkedBags ? `${plural(r.fare.checkedBags, 'checked bag')}${r.fare.checkedKg > 0 ? ` (${r.fare.checkedKg} kg)` : ''}` : 'no checked bag';
    return r.fare.cabinKg > 0 ? `${r.fare.cabinKg} kg cabin bag, ${checked}` : checked.charAt(0).toUpperCase() + checked.slice(1);
  },
  refunds: r => {
    if (refundUnknown(r)) return 'No refund confirmed';
    return r.fare.refundablePercent > 0 ? `Refunds ${r.fare.refundablePercent}%` : 'Refunds nothing';
  },
  changes: r => r.fare.terms,
};
const FLIGHT_LABEL = {
  carrier: 'flight', times: 'times', stops: 'stops', cabin: 'cabin', fare: 'fare', bags: 'bags', refunds: 'refunds', changes: 'fare terms',
};
const HOTEL_TEXT = {
  hotel: r => `${r.name}, ${r.area}`,
  room: r => `${r.room.name}, ${r.room.bed}`,
  stars: r => starsText(r),
  hotelRefunds: r => r.cancellation.text,
};
const HOTEL_LABEL = { hotel: 'Hotel', room: 'Room', stars: 'Hotel class', hotelRefunds: 'Hotel cancellation' };

/**
 * Side by side, two versions of a trip: the rows that differ (in DIFF_FIELDS order), and the totals.
 * A component one side has and the other lacks shows null on the side without it.
 * @param {{ rows: import('./types').TripRows, totalCents: number }} a usually the requested trip
 * @param {{ rows: import('./types').TripRows, totalCents: number }} b usually the cheapest option inside policy
 * @returns {import('./types').TripComparison}
 */
function compareTrips(a, b) {
  const ra = a.rows || {}, rb = b.rows || {};
  const rows = [];
  for (const field of DIFF_FIELDS) {
    if (field === 'dates') {
      const x = tripDatesText(ra), y = tripDatesText(rb);
      if (x !== y) rows.push({ label: 'Dates', a: x || null, b: y || null });
      continue;
    }
    if (FLIGHT_TEXT[field]) {
      for (const c of ['out', 'back']) {
        const p = ra[c] || null, q = rb[c] || null;
        if (!p && !q) continue;
        const x = p ? FLIGHT_TEXT[field](p) : null, y = q ? FLIGHT_TEXT[field](q) : null;
        if (x !== y) rows.push({ label: `${c === 'out' ? 'Outbound' : 'Return'} ${FLIGHT_LABEL[field]}`, a: x, b: y });
      }
    } else {
      const p = ra.hotel || null, q = rb.hotel || null;
      if (!p && !q) continue;
      const x = p ? HOTEL_TEXT[field](p) : null, y = q ? HOTEL_TEXT[field](q) : null;
      if (x !== y) rows.push({ label: HOTEL_LABEL[field], a: x, b: y });
    }
  }
  return { rows, totalCents: { a: a.totalCents, b: b.totalCents, delta: b.totalCents - a.totalCents } };
}

/**
 * Per-line money changes between two rows' price lines, matched by label then kind; the deltas add up to
 * the totals' delta (1B lineDeltas). Lines in a's order, then b's lines a lacks; a line one side lacks is 0 there.
 * @param {import('./types').Row|null} a
 * @param {import('./types').Row|null} b
 * @returns {Array<{ label: string, kind: string, from: number, to: number, delta: number }>}
 */
function lineDeltas(a, b) {
  const order = [];
  const sums = new Map();
  const add = (row, side) => {
    for (const l of (row && row.lines) || []) {
      const k = `${l.label}\u0000${l.kind}`;
      if (!sums.has(k)) { sums.set(k, { label: l.label, kind: l.kind, from: 0, to: 0 }); order.push(k); }
      sums.get(k)[side] += l.cents;
    }
  };
  add(a, 'from');
  add(b, 'to');
  return order.map(k => { const s = sums.get(k); return { ...s, delta: s.to - s.from }; });
}

module.exports = { DIFF_FIELDS, giveUps, compareTrips, lineDeltas };
