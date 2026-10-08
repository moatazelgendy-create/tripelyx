// Crafted Business rows for the policy and alternatives tests (plan §E5, §G4): FlightRow and HotelRow
// builders shaped exactly like dto.FLIGHT_ROW_KEYS and dto.HOTEL_ROW_KEYS, plus trip, query and variant
// helpers. Every number is chosen by the test that builds the row, so a rule's boundary (a cap, a haul
// threshold, a day count) is hit exactly. DEMO-shaped data only: fictional carriers and hotels.
// Not a test file (it doesn't match *.test.js).
const tz = require('../../server/business/tz');
const { CABIN_LABELS } = require('../../server/business/constants');
const { alternativeId } = require('../../server/business/alternatives');

const PRICED_AT = '2026-10-09T09:00:00.000Z';
const AIRPORTS = Object.freeze({
  CAI: { code: 'CAI', city: 'Cairo', country: 'Egypt', tz: 'Africa/Cairo' },
  LHR: { code: 'LHR', city: 'London', country: 'United Kingdom', tz: 'Europe/London' },
  DXB: { code: 'DXB', city: 'Dubai', country: 'United Arab Emirates', tz: 'Asia/Dubai' },
  IST: { code: 'IST', city: 'Istanbul', country: 'Türkiye', tz: 'Europe/Istanbul' },
});
const CARRIERS = Object.freeze({ ZM: 'Mediterra Airways', ZS: 'Sahara Wings', ZG: 'Gulfstar' });
const FARES = Object.freeze({
  LIGHT: { code: 'LIGHT', name: 'Light', cabinKg: 7, checkedBags: 0, checkedKg: 0, changeable: false, refundablePercent: 0, terms: 'Non-refundable. No changes.' },
  CLASSIC: { code: 'CLASSIC', name: 'Classic', cabinKg: 8, checkedBags: 1, checkedKg: 23, changeable: true, refundablePercent: 0, terms: 'Non-refundable. Changes for a fee.' },
  FLEX: { code: 'FLEX', name: 'Flex', cabinKg: 10, checkedBags: 2, checkedKg: 23, changeable: true, refundablePercent: 70, terms: '70% refundable. Free changes.' },
});
const TAX_CENTS = 4200;
const MINUTE = 60000;
const DAY = 86400000;

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

function seg(carrier, flightNumber, from, to, departUtc, minutes) {
  const a = AIRPORTS[from], b = AIRPORTS[to];
  const departLocal = tz.utcToLocal(a.tz, departUtc);
  const arriveUtc = new Date(departUtc.getTime() + minutes * MINUTE);
  const arriveLocal = tz.utcToLocal(b.tz, arriveUtc);
  return {
    seg: {
      carrier: { code: carrier, name: CARRIERS[carrier] || carrier }, flightNumber,
      from: { code: a.code, city: a.city }, to: { code: b.code, city: b.city },
      departLocal, arriveLocal, arriveDayOffset: dayDiff(departLocal.slice(0, 10), arriveLocal.slice(0, 10)), durationMinutes: minutes,
    },
    arriveUtc,
  };
}

/**
 * A FlightRow.
 * @param {object} [o]
 * @param {'out'|'back'} [o.leg] @param {string} [o.from] @param {string} [o.to] @param {string} [o.date] local departure date
 * @param {string} [o.depart] 'HH:MM' local at the origin @param {number} [o.minutes] flying minutes (split over two
 *   segments when stops is 1) @param {number} [o.stops] 0 or 1 @param {string} [o.via] connection airport
 * @param {number} [o.layover] minutes @param {string} [o.carrier] @param {string[]} [o.segmentCarriers] per segment
 * @param {string} [o.fare] LIGHT|CLASSIC|FLEX @param {string} [o.cabin] @param {number} [o.totalCents]
 * @param {boolean} [o.available] @param {number} [o.n] itinerary number in the offer id @param {object} [o.fareOverride]
 */
function flight(o = {}) {
  const {
    leg = 'out', from = leg === 'out' ? 'CAI' : 'LHR', to = leg === 'out' ? 'LHR' : 'CAI', date = leg === 'out' ? '2026-11-12' : '2026-11-16',
    depart = '08:35', minutes = 300, stops = 0, via = 'IST', layover = 90, carrier = 'ZM', segmentCarriers = null, fare = 'LIGHT',
    cabin = 'economy', totalCents = 44200, available = true, n = 1, fareOverride = {},
  } = o;
  const departUtc = tz.localToUtc(AIRPORTS[from].tz, `${date}T${depart}`);
  const carriers = segmentCarriers || (stops ? [carrier, carrier] : [carrier]);
  const segs = [];
  if (!stops) {
    segs.push(seg(carriers[0], `${carriers[0]}${100 + n}`, from, to, departUtc, minutes));
  } else {
    const firstMinutes = Math.floor(minutes / 2);
    const a = seg(carriers[0], `${carriers[0]}${100 + n}`, from, via, departUtc, firstMinutes);
    const b = seg(carriers[1], `${carriers[1]}${600 + n}`, via, to, new Date(a.arriveUtc.getTime() + layover * MINUTE), minutes - firstMinutes);
    segs.push(a, b);
  }
  const offerId = `flt_fix_${from}${to}_${date}_${n}${cabin === 'economy' ? '' : `_${cabin}`}`;
  const f = { ...FARES[fare], ...fareOverride };
  return {
    key: `f.${offerId}|${fare}`, kind: 'flight', leg, offerId, optionId: fare,
    carrier: { code: carrier, name: CARRIERS[carrier] || carrier },
    flightNumbers: segs.map(s => s.seg.flightNumber),
    segments: segs.map(s => s.seg),
    stops, via: stops ? [{ code: via, city: AIRPORTS[via].city }] : [],
    flyingMinutes: minutes,
    elapsedMinutes: Math.round((segs[segs.length - 1].arriveUtc.getTime() - departUtc.getTime()) / MINUTE),
    cabin, cabinLabel: CABIN_LABELS[cabin],
    fare: f,
    lines: available ? [{ label: 'Fare', kind: 'base', cents: totalCents - TAX_CENTS }, { label: 'Taxes and charges', kind: 'tax', cents: TAX_CENTS }] : [],
    totalCents: available ? totalCents : null, currency: 'USD', available, demo: true, pricedAt: PRICED_AT,
  };
}

/**
 * A HotelRow. totalCents = (nightly + tax) × nights, tax = round(nightly × taxPercent / 100).
 * @param {object} [o]
 */
function hotel(o = {}) {
  const {
    n = 1, name = 'Fixture Grand London', stars = 4, area = 'City centre', city = 'London', country = 'United Kingdom',
    checkIn = '2026-11-12', nights = 4, nightlyCents = 25000, taxPercent = 14, refundable = true, available = true,
    room = 'STD', roomName = 'Standard room', sleeps = 2, bed = 'Queen bed', freeUntilHours = refundable ? 48 : 0,
  } = o;
  const tax = Math.round((nightlyCents * taxPercent) / 100);
  const total = (nightlyCents + tax) * nights;
  const offerId = `htl_fix_${city.replace(/\W/g, '')}_${n}`;
  return {
    key: `h.${offerId}|${room}`, kind: 'hotel', offerId, optionId: room, name, stars, area, city, country,
    room: { name: roomName, sleeps, bed }, checkIn, checkOut: addDays(checkIn, nights), nights,
    nightlyCents: available ? nightlyCents : null, nightlyInclCents: available ? Math.round(total / nights) : null,
    lines: available ? [{ label: `${nights} nights`, kind: 'base', cents: nightlyCents * nights }, { label: 'Taxes and fees', kind: 'tax', cents: tax * nights }] : [],
    totalCents: available ? total : null, currency: 'USD',
    cancellation: refundable ? { refundable: true, freeUntilHours, text: `Free cancellation until ${freeUntilHours} hours before check-in.` } : { refundable: false, freeUntilHours: 0, text: 'Non-refundable.' },
    amenities: ['Free Wi-Fi'], available, demo: true, pricedAt: PRICED_AT,
  };
}

/** A TripQuery for rows (CAI to LHR by default). */
function query(o = {}) {
  const { from = 'CAI', to = 'LHR', departDate = '2026-11-12', returnDate = '2026-11-16', cabin = 'economy', datesFlexible = false, hotel: h = true } = o;
  return {
    from, to, departDate, returnDate, cabin, passengers: 1, datesFlexible,
    hotel: h ? { city: AIRPORTS[to].city, country: AIRPORTS[to].country, checkIn: departDate, checkOut: returnDate || addDays(departDate, 4) } : null,
  };
}

const selectionOf = rows => ({ out: rows.out.key, back: rows.back ? rows.back.key : null, hotel: rows.hotel ? rows.hotel.key : null });
const totalOf = rows => ['out', 'back', 'hotel'].reduce((s, c) => s + (rows[c] ? rows[c].totalCents : 0), 0);

/** The pick as buildAlternatives takes it. */
function pick(rows, q = query()) {
  return { selection: selectionOf(rows), query: q, rows, totalCents: totalOf(rows) };
}

/** A TripVariant: the pick's rows with `changes` applied (the whole trip priced end to end). */
function variant(base, kind, component, changes, { q = base.query, days, fromText = 'pick', toText = 'alternative' } = {}) {
  const rows = { ...base.rows, ...changes };
  const change = { kind, component, fromText, toText };
  if (days !== undefined) change.days = days;
  return { change, selection: selectionOf(rows), query: q, rows, totalCents: totalOf(rows) };
}

/** An EvalCtx over `rules` (Acme Inc, Standard v3, today 2026-10-09). */
function ctx(rules, extra = {}) {
  return {
    rules, policy: { tier: 'standard', version: 3 }, outOfPolicy: 'approval', today: '2026-10-09', benchmarks: {},
    carriers: { ...CARRIERS }, orgName: 'Acme Inc', ...extra,
  };
}

/** Freeze a value all the way down (purity tests). */
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

module.exports = {
  PRICED_AT, AIRPORTS, CARRIERS, FARES, TAX_CENTS, flight, hotel, query, pick, variant, ctx, selectionOf, totalOf, addDays, deepFreeze, alternativeId,
};
