// Trip search for Business (plan §F3, §F4, §G1): parse the search form, search the legs, price a selection
// again, and generate the cheaper variants the alternatives are ranked from. Writes nothing, ever: quotes
// come from provider.quote(), which stores nothing. The service holds a TripComposer as this.composer
// (types.TripComposer), so tests can use test/business-fakes.fakeComposer().
//
// - Up to 3 provider searches run in parallel (out, back, hotel). Every available option of every offer is
//   priced with provider.quote() (at most MAX_PRICED_PER_LEG per leg, then the leg is `truncated`).
//   Totals are the sum of the price lines. An unavailable option is a row with available:false and no price.
//   Every offer and quote is checked with providers/contracts (a malformed one is a 502), and every row is a
//   dto row that passed dto.assertRow.
// - The hotel check-in: parseTripQuery sets it to the departure date. search() moves it to the outbound
//   arrival's local date when every available outbound itinerary lands on a later date (an overnight
//   flight): one way the nights are kept (check-out moves too); with a return the check-out stays the return
//   date, and nothing moves if that would leave no night. SearchResult.query is the query as searched.
// - A currency other than the org's (USD): 422 'unsupported_currency', "Priced in another currency, not supported yet".
// - The benchmarks are plan §E2's median with outliers removed, computed here so the composer needs no policy
//   engine (the same rule as policy/benchmark.js; test/business-search.test.js checks the two agree).
// - Latency targets with MOCK_LATENCY_MS=0: search ≤ 150 ms, draft creation with alternatives ≤ 400 ms
//   (tests assert 1,500 ms ceilings).
// - variants(): each candidate is the whole trip with ONE change (all_within: every out-of-policy component
//   swapped for its cheapest within-policy row), priced end to end, and strictly cheaper than the pick:
//     fare (same itinerary, cheaper fare family; 0 extra searches) · flight (another itinerary, same leg, date,
//     cabin and fare family; 0) · stops (a one-stop, same fare family, when the pick is nonstop; 0) · cabin
//     (the same flight and fare one cabin lower; 1 per leg) · dates (only with datesFlexible: the whole trip
//     ±1, ±2, ±3 days, legs and hotel moving together, nights kept, never in the past; 1 to 3 per shift) ·
//     room (a cheaper room, same hotel; 0) · hotel (another hotel in the same city, its cheapest room; 0) ·
//     all_within (0; only when the caller passes `evaluate`, since the composer holds no policy).
//   The pick's own legs are searched once more for the 0-search kinds (the same search the results page
//   showed; not counted as extra, and skipped when the caller hands over that SearchResult as `searched`).
//   At most maxSearches (20) extra searches and POOL_CAP (200) candidates; truncated when either cuts
//   anything. Never a different destination or route.
const { AppError } = require('../lib/errors');
const { isIsoDate, addDays, daysBetween } = require('../lib/dates');
const { validateOffer, validateQuote } = require('../providers/contracts');
const { CABINS, CABIN_RANK, CABIN_LABELS } = require('./constants');
const dto = require('./dto');
const { recheck } = require('./recheck');
const tz = require('./tz');

/** The most options priced per leg. */
const MAX_PRICED_PER_LEG = 60;
/** The most extra searches variants() makes. */
const MAX_SEARCHES = 20;
/** The most candidates variants() returns. */
const POOL_CAP = 200;
/** How far ahead a trip can be searched (days after today in the org's time zone). */
const MAX_DAYS_AHEAD = 330;
/** The longest trip (return date after departure). */
const MAX_TRIP_DAYS = 30;
/** Hotel nights on a one-way trip. */
const NIGHTS_RANGE = Object.freeze([1, 14]);
/** How far dates move for 'dates' variants. */
const FLEX_DAYS = 3;

/** The date shifts 'dates' variants try, closest first. */
const SHIFTS = Object.freeze([1, -1, 2, -2, 3, -3].filter(d => Math.abs(d) <= FLEX_DAYS));
const COMPONENTS = Object.freeze(['out', 'back', 'hotel']);
const CURRENCY = 'USD';
/** A checkbox in the search form: '1' (the form's value) or 'on' (a browser's default). */
const CHECKED = new Set(['1', 'on']);
const CABIN_SUFFIX = /_(economy|premium|business)$/;

function noSupplier() {
  return new AppError('no_supplier', "Supplier not connected yet. Tripelyx hasn't connected airlines and hotels for company travel.", 503);
}
function invalidSelection(message = "That option isn't part of this search.") {
  return new AppError('invalid_selection', message, 422);
}
function unsupportedCurrency() {
  return new AppError('unsupported_currency', 'Priced in another currency, not supported yet.', 422);
}

// ---------------------------------------------------------------------------------------------------------
// The search form

/** A form field as a trimmed string; '' when absent; null when it is not a single string (a repeated field). */
function field(raw, name) {
  const v = raw[name];
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v.trim() : null;
}

/**
 * Parse the search form (types.RawTripQuery). Airports must come from `airports`; from ≠ to; departDate in
 * today..today + 330; returnDate after departDate and ≤ departDate + 30; hotel: checkIn = departDate,
 * checkOut = returnDate, or checkIn + nights (1..14) one way; city and country from cityFor(to).
 * (search() moves checkIn to the outbound arrival's local date when every available outbound itinerary lands
 * on a later date, keeping the nights; SearchResult.query is the query as searched. The results form carries
 * only the RawTripQuery fields to POST /trips, never a check-in: createRequest parses them again, runs
 * search() again (which moves checkIn the same way) and prices and stores that SearchResult.query. Nothing
 * is ever priced with this function's output directly when a hotel is in the trip.)
 * Blank cabin means economy; blank nights (one way with a hotel) means 1; hotel and flex are checkboxes
 * ('1' or 'on'). Unknown fields are ignored; a repeated field is an error on that field.
 * @param {import('./types').RawTripQuery} raw
 * @param {{ today: string, airports: Array<{ code: string }>, cityFor: (iata: string) => { city: string, country: string }|null }} opts
 *   today: tz.localDate(org.timezone, now)
 * @returns {import('./types').TripQuery}
 * @throws {AppError} 422 'invalid_query', 'Check the highlighted fields.', details keyed by raw field name
 *   (from, to, depart, return, nights, cabin)
 * @throws {Error} a malformed `today` (a programming error)
 */
function parseTripQuery(raw, { today, airports = [], cityFor = null } = {}) {
  if (!isIsoDate(today)) throw new Error('[business] parseTripQuery needs today as YYYY-MM-DD');
  const r = raw && typeof raw === 'object' ? raw : {};
  const byCode = new Map((Array.isArray(airports) ? airports : []).map(a => [a.code, a]));
  const details = {};

  const from = (field(r, 'from') || '').toUpperCase();
  const to = (field(r, 'to') || '').toUpperCase();
  if (!byCode.has(from)) details.from = 'Choose an airport from the list.';
  if (!byCode.has(to)) details.to = 'Choose an airport from the list.';
  else if (to === from) details.to = 'Choose a destination other than where you leave from.';

  const depart = field(r, 'depart');
  const departOk = isIsoDate(depart);
  if (!departOk || depart < today || daysBetween(today, depart) > MAX_DAYS_AHEAD) {
    details.depart = `Choose a date from today up to ${MAX_DAYS_AHEAD} days ahead.`;
  }

  const ret = field(r, 'return');
  if (ret === null || (ret !== '' && !isIsoDate(ret))) {
    details.return = 'Choose a return date, or leave it blank for a one-way trip.';
  } else if (ret !== '' && departOk && (ret <= depart || daysBetween(depart, ret) > MAX_TRIP_DAYS)) {
    details.return = `Choose a return date after you leave, up to ${MAX_TRIP_DAYS} days later.`;
  }

  const cabinRaw = field(r, 'cabin');
  const cabin = cabinRaw === '' ? 'economy' : cabinRaw;
  if (!CABINS.includes(cabin)) details.cabin = 'Choose a cabin.';

  const wantsHotel = CHECKED.has(field(r, 'hotel'));
  let nights = null;
  if (wantsHotel && !ret) {
    const n = field(r, 'nights');
    nights = n === '' ? NIGHTS_RANGE[0] : /^\d{1,2}$/.test(n || '') ? Number(n) : NaN;
    if (!(nights >= NIGHTS_RANGE[0] && nights <= NIGHTS_RANGE[1])) details.nights = `Choose ${NIGHTS_RANGE[0]} to ${NIGHTS_RANGE[1]} nights.`;
  }

  if (Object.keys(details).length) throw new AppError('invalid_query', 'Check the highlighted fields.', 422, details);

  let hotel = null;
  if (wantsHotel) {
    const airport = byCode.get(to);
    const place = (typeof cityFor === 'function' && cityFor(to)) || { city: airport.city, country: airport.country };
    hotel = { city: place.city, country: place.country, checkIn: depart, checkOut: ret || addDays(depart, nights) };
  }
  return {
    from, to, departDate: depart, returnDate: ret || null, cabin, passengers: 1,
    datesFlexible: CHECKED.has(field(r, 'flex')), hotel,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Benchmarks (plan §E2; the same rule as policy/benchmark.js)

/** The median of whole-cent values with outliers removed (n ≥ 4: outside [Q1 − 1.5·IQR, Q3 + 1.5·IQR]). */
function benchmarkOf(values) {
  const a = values.filter(v => Number.isSafeInteger(v) && v >= 0).sort((x, y) => x - y);
  const n = a.length;
  if (n < 3) return { medianCents: null, sampleSize: n, excluded: [] };
  let kept = a, excluded = [];
  if (n >= 4) {
    const q1 = a[Math.floor((n - 1) * 0.25)], q3 = a[Math.ceil((n - 1) * 0.75)];
    const f = Math.floor((3 * (q3 - q1)) / 2);
    kept = a.filter(v => v >= q1 - f && v <= q3 + f);
    excluded = a.filter(v => v < q1 - f || v > q3 + f);
  }
  const m = kept.length, mid = Math.floor(m / 2);
  return { medianCents: m % 2 ? kept[mid] : Math.floor((kept[mid - 1] + kept[mid]) / 2), sampleSize: m, excluded };
}

/** One value per offer: the smallest pick(row) among its available rows. */
function cheapestPerOffer(rows, pick) {
  const best = new Map();
  for (const r of rows) {
    if (!r.available) continue;
    const v = pick(r);
    if (!Number.isInteger(v)) continue;
    if (!best.has(r.offerId) || v < best.get(r.offerId)) best.set(r.offerId, v);
  }
  return [...best.values()];
}

const flightBenchmark = rows => benchmarkOf(cheapestPerOffer(rows, r => r.totalCents));
const hotelBenchmarks = rows => ({
  incl_taxes: benchmarkOf(cheapestPerOffer(rows, r => r.nightlyInclCents)),
  excl_taxes: benchmarkOf(cheapestPerOffer(rows, r => r.nightlyCents)),
});

// ---------------------------------------------------------------------------------------------------------
// Helpers

/** Available rows first, then total, then key. */
const byTotal = (a, b) => (a.available === b.available ? 0 : a.available ? -1 : 1)
  || (a.totalCents ?? 0) - (b.totalCents ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const minutesOfDay = local => Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
const sameItinerary = (a, b) => a.flightNumbers.join('+') === b.flightNumbers.join('+') && a.segments[0].departLocal === b.segments[0].departLocal;
const rowsTotal = rows => COMPONENTS.reduce((n, c) => n + (rows[c] ? rows[c].totalCents : 0), 0);
const selectionOf = rows => ({ out: rows.out.key, back: rows.back ? rows.back.key : null, hotel: rows.hotel ? rows.hotel.key : null });

/** A plain copy of a TripQuery (only its declared fields). */
function copyQuery(q) {
  return {
    from: q.from, to: q.to, departDate: q.departDate, returnDate: q.returnDate || null, cabin: q.cabin, passengers: 1,
    datesFlexible: Boolean(q.datesFlexible),
    hotel: q.hotel ? { city: q.hotel.city, country: q.hotel.country, checkIn: q.hotel.checkIn, checkOut: q.hotel.checkOut } : null,
  };
}

/** Throws a TypeError unless `q` is a TripQuery the composer can search (a programming error, not a 4xx). */
function assertQuery(q) {
  const ok = q && typeof q.from === 'string' && typeof q.to === 'string' && q.from !== q.to && isIsoDate(q.departDate)
    && (q.returnDate == null || (isIsoDate(q.returnDate) && q.returnDate > q.departDate)) && CABINS.includes(q.cabin)
    && (q.hotel == null || (typeof q.hotel.city === 'string' && typeof q.hotel.country === 'string'
      && isIsoDate(q.hotel.checkIn) && isIsoDate(q.hotel.checkOut) && q.hotel.checkOut > q.hotel.checkIn));
  if (!ok) throw new TypeError('[business] the composer needs a TripQuery from parseTripQuery');
  return q;
}

/** The leg's airports and date. */
function legOf(query, leg) {
  return leg === 'out' ? { from: query.from, to: query.to, date: query.departDate } : { from: query.to, to: query.from, date: query.returnDate };
}

/** The whole trip moved by `days` (legs and hotel together, nights kept). */
function shiftQuery(query, days) {
  const q = copyQuery(query);
  q.departDate = addDays(q.departDate, days);
  if (q.returnDate) q.returnDate = addDays(q.returnDate, days);
  if (q.hotel) { q.hotel.checkIn = addDays(q.hotel.checkIn, days); q.hotel.checkOut = addDays(q.hotel.checkOut, days); }
  return q;
}

/**
 * The stay as searched: moved to the outbound arrival's local date when every available outbound itinerary
 * lands after the check-in (see the header), else null (no move).
 */
function movedStay(query, outRows) {
  const arrivals = new Map();
  for (const r of outRows) if (r.available) arrivals.set(r.offerId, r.segments[r.segments.length - 1].arriveLocal.slice(0, 10));
  if (!arrivals.size) return null;
  const earliest = [...arrivals.values()].sort()[0];
  const h = query.hotel;
  if (earliest <= h.checkIn) return null;
  if (!query.returnDate) return { ...h, checkIn: earliest, checkOut: addDays(earliest, daysBetween(h.checkIn, h.checkOut)) };
  return earliest < h.checkOut ? { ...h, checkIn: earliest } : null;
}

/** The plain words a change shows ("Classic", "Premium economy", "Mediterra Airways ZM123, leaves 13:40"). */
function describe(kind, row) {
  if (kind === 'fare') return row.fare.name;
  if (kind === 'cabin') return CABIN_LABELS[row.cabin];
  if (kind === 'room') return row.room.name;
  if (kind === 'hotel') return row.name;
  if (kind === 'stops') return row.stops ? `${row.stops} stop${row.stops > 1 ? 's' : ''} via ${row.via.map(v => v.city).join(' and ')}` : 'Nonstop';
  return `${row.carrier.name} ${row.flightNumbers.join(' + ')}, leaves ${row.segments[0].departLocal.slice(11)}`;
}

/** A gone component's row: the stored row with no price (recheck's "no longer in the demo data"). */
function goneRow(prev, key, component, pricedAt) {
  if (!prev || prev.key !== key || (component === 'hotel') !== (prev.kind === 'hotel')) return null;
  const row = { ...structuredClone(prev), lines: [], totalCents: null, available: false, pricedAt };
  if (row.kind === 'hotel') { row.nightlyCents = null; row.nightlyInclCents = null; }
  return dto.assertRow(row);
}

// ---------------------------------------------------------------------------------------------------------
// The composer

/**
 * Searches, prices and builds variants over a BusinessInventory. Construction never throws (the app builds
 * one at boot); with inventory status 'none' search/price/variants answer 503 'no_supplier'.
 */
class TripComposer {
  /**
   * @param {{ inventory: import('./types').BusinessInventory, now: () => Date }} deps
   */
  constructor({ inventory, now } = {}) {
    this.inventory = inventory;
    this.now = now;
  }

  /**
   * parseTripQuery with this inventory's airports and cityFor.
   * @param {import('./types').RawTripQuery} raw
   * @param {{ today: string }} opts
   * @returns {import('./types').TripQuery}
   * @throws {AppError} 422 'invalid_query' with per-field details
   */
  parseQuery(raw, { today } = {}) {
    const inv = this.inventory || {};
    const airports = typeof inv.airports === 'function' ? inv.airports() : [];
    return parseTripQuery(raw, { today, airports, cityFor: iata => (typeof inv.cityFor === 'function' ? inv.cityFor(iata) : null) });
  }

  /**
   * Search every leg of the query.
   * @param {import('./types').TripQuery} query
   * @returns {Promise<import('./types').SearchResult>} pricedAt from this.now()
   * @throws {AppError} 503 'no_supplier' when inventory.status is 'none'; 422 'unsupported_currency'; provider
   *   errors pass through (502)
   */
  async search(query) {
    this._ready();
    const q = copyQuery(assertQuery(query));
    const pricedAt = this._pricedAt();
    const [out, back, hotel] = await Promise.all([
      this._flightLeg('out', q, q.cabin, pricedAt),
      q.returnDate ? this._flightLeg('back', q, q.cabin, pricedAt) : null,
      q.hotel ? this._hotelLeg(q.hotel, pricedAt) : null,
    ]);
    const legs = { out, back, hotel };
    if (q.hotel) {
      const moved = movedStay(q, out.rows);
      if (moved) {
        q.hotel = moved;
        legs.hotel = await this._hotelLeg(moved, pricedAt);
      }
    }
    return { query: q, legs, pricedAt, status: this.inventory.status };
  }

  /**
   * Price a selection again, now (never trusting any price a form sent).
   * @param {import('./types').Selection} selection
   * @param {import('./types').TripQuery} query
   * @param {{ previous?: import('./types').TripRows|null }} [opts] previous: the stored rows (recheck): a
   *   component whose offer is gone from the inventory comes back as that row with no price, rather than a 422
   * @returns {Promise<import('./types').PriceResult>}
   * @throws {AppError} 422 'invalid_selection' for a malformed key, a key on the wrong leg, back without a
   *   returnDate or hotel without query.hotel; 422 'unsupported_currency'; 503 'no_supplier'
   */
  async price(selection, query, { previous = null } = {}) {
    this._ready();
    assertQuery(query);
    const sel = checkSelection(selection, query);
    const pricedAt = this._pricedAt();
    const rows = { out: null, back: null, hotel: null };
    await Promise.all(COMPONENTS.filter(c => sel[c]).map(async c => {
      rows[c] = await this._priceOne(c, sel[c], query, pricedAt, previous ? previous[c] : null);
    }));
    const parts = COMPONENTS.filter(c => rows[c]);
    const unavailable = parts.filter(c => !rows[c].available);
    return { rows, totalCents: unavailable.length ? null : rowsTotal(rows), pricedAt, unavailable };
  }

  /**
   * The cheaper variants of a pick (see the header for the kinds and caps).
   * @param {import('./types').TripQuery} query the query as searched (SearchResult.query, or request.query)
   * @param {import('./types').Selection} selection
   * @param {{ datesFlexible: boolean, maxSearches?: number,
   *   evaluate?: (row: import('./types').Row) => import('./types').Evaluation|import('./types').PolicyStatus,
   *   searched?: import('./types').SearchResult, today?: string }} opts
   *   evaluate (optional): a row's policy verdict (this.policy.evaluateComponent with the request's EvalCtx);
   *   without it there is no 'all_within' candidate. searched (optional): the SearchResult the pick came from,
   *   reused for the 0-search kinds when it is the same query. today (optional): the org's local date, the
   *   earliest a 'dates' shift may leave (default: the UTC date of now()). maxSearches is capped at 20.
   * @returns {Promise<import('./types').VariantResult>} searches: the extra searches made
   * @throws {AppError} 422 'invalid_selection'; 503 'no_supplier'
   */
  async variants(query, selection, { datesFlexible = false, maxSearches = MAX_SEARCHES, evaluate = null, searched = null, today = null } = {}) {
    this._ready();
    assertQuery(query);
    const max = Number.isInteger(maxSearches) && maxSearches > 0 ? Math.min(maxSearches, MAX_SEARCHES) : 0;
    const priced = await this.price(selection, query);
    if (priced.unavailable.length) return { candidates: [], searches: 0, truncated: false };
    const pricedAt = priced.pricedAt;
    const pick = priced.rows;
    const pickTotal = priced.totalCents;
    const comps = COMPONENTS.filter(c => pick[c]);
    let searches = 0, truncated = false;
    const spend = n => {
      if (searches + n > max) { truncated = true; return false; }
      searches += n;
      return true;
    };

    const candidates = [];
    const seen = new Set();
    const add = (change, rows, q = query) => {
      const total = rowsTotal(rows);
      if (total >= pickTotal) return;
      const selectionNow = selectionOf(rows);
      const id = JSON.stringify([selectionNow, q.departDate, q.returnDate, q.hotel && [q.hotel.checkIn, q.hotel.checkOut]]);
      if (seen.has(id)) return;
      seen.add(id);
      candidates.push({ change, selection: selectionNow, query: copyQuery(q), rows: structuredClone(rows), totalCents: total });
    };

    // The pick's own legs: the same search the results came from (reused when handed over).
    const reuse = searched && searched.query && sameSearch(searched.query, query) ? searched : null;
    const pools = {};
    await Promise.all(comps.map(async c => {
      if (c === 'hotel') {
        pools.hotel = reuse && reuse.legs.hotel ? reuse.legs.hotel.rows : (await this._hotelLeg(query.hotel, pricedAt)).rows;
      } else {
        const leg = reuse && reuse.legs[c] && pick[c].cabin === query.cabin ? reuse.legs[c] : await this._flightLeg(c, query, pick[c].cabin, pricedAt);
        pools[c] = leg.rows;
      }
    }));

    // fare, flight, stops, room, hotel: one component changes, from the same search.
    for (const c of comps) {
      const mine = pick[c];
      const pool = pools[c].filter(r => r.available && r.key !== mine.key && r.totalCents < mine.totalCents);
      if (c === 'hotel') {
        for (const r of pool.filter(x => x.offerId === mine.offerId)) add({ kind: 'room', component: c, fromText: describe('room', mine), toText: describe('room', r) }, { ...pick, [c]: r });
        const cheapest = new Map();
        for (const r of pool.filter(x => x.offerId !== mine.offerId).sort(byTotal)) if (!cheapest.has(r.offerId)) cheapest.set(r.offerId, r);
        for (const r of cheapest.values()) add({ kind: 'hotel', component: c, fromText: describe('hotel', mine), toText: describe('hotel', r) }, { ...pick, [c]: r });
      } else {
        for (const r of pool) {
          if (r.offerId === mine.offerId) {
            add({ kind: 'fare', component: c, fromText: describe('fare', mine), toText: describe('fare', r) }, { ...pick, [c]: r });
          } else if (r.optionId === mine.optionId) {
            const kind = mine.stops === 0 && r.stops > 0 ? 'stops' : 'flight';
            add({ kind, component: c, fromText: describe(kind, mine), toText: describe(kind, r) }, { ...pick, [c]: r });
          }
        }
      }
    }

    // cabin: the same flight and fare, one cabin lower (1 search per leg).
    const lowerPools = {};
    const cabinLegs = comps.filter(c => c !== 'hotel' && CABIN_RANK[pick[c].cabin] > 0).filter(() => spend(1));
    await Promise.all(cabinLegs.map(async c => {
      const lower = CABINS[CABIN_RANK[pick[c].cabin] - 1];
      lowerPools[c] = (await this._flightLeg(c, query, lower, pricedAt)).rows;
    }));
    for (const c of cabinLegs) {
      const mine = pick[c];
      const twin = lowerPools[c].find(r => r.available && r.optionId === mine.optionId && sameItinerary(r, mine));
      if (twin) add({ kind: 'cabin', component: c, fromText: describe('cabin', mine), toText: describe('cabin', twin) }, { ...pick, [c]: twin });
    }

    // dates: the whole trip a day or more earlier or later (only when the dates can move).
    if (datesFlexible === true) {
      const first = isIsoDate(today) ? today : tz.localDate('UTC', this.now());
      const shifts = SHIFTS.filter(d => {
        const depart = addDays(query.departDate, d);
        return depart >= first && daysBetween(first, depart) <= MAX_DAYS_AHEAD;
      }).filter(() => spend(comps.length));
      const found = await Promise.all(shifts.map(async days => {
        const q = shiftQuery(query, days);
        const legs = await Promise.all(comps.map(c => (c === 'hotel' ? this._hotelLeg(q.hotel, pricedAt) : this._flightLeg(c, q, pick[c].cabin, pricedAt))));
        const rows = { out: null, back: null, hotel: null };
        comps.forEach((c, i) => { rows[c] = c === 'hotel' ? sameRoom(legs[i].rows, pick.hotel) : closestFlight(legs[i].rows, pick[c]); });
        return comps.every(c => rows[c]) ? { days, q, rows } : null;
      }));
      for (const f of found) {
        if (f) add({ kind: 'dates', component: 'trip', fromText: query.departDate, toText: f.q.departDate, days: f.days }, f.rows, f.q);
      }
    }

    // all_within: every out-of-policy component swapped for its cheapest within-policy row (same dates).
    if (typeof evaluate === 'function') {
      const statusOf = row => { const e = evaluate(row); return e && typeof e === 'object' ? e.status : e; };
      const rows = { ...pick };
      let changed = false, possible = true;
      for (const c of comps) {
        if (statusOf(pick[c]) === 'within') continue;
        const best = [...pools[c], ...(lowerPools[c] || [])].filter(r => r.available && statusOf(r) === 'within').sort(byTotal)[0];
        if (!best) { possible = false; break; }
        rows[c] = best;
        changed = true;
      }
      if (possible && changed) {
        add({ kind: 'all_within', component: 'trip', fromText: 'Your pick', toText: 'The cheapest options inside your policy' }, rows);
      }
    }

    if (candidates.length > POOL_CAP) {
      truncated = true;
      return { candidates: roundRobin(candidates, POOL_CAP), searches, truncated };
    }
    return { candidates, searches, truncated };
  }

  /**
   * Price a stored request's selection again (recheck.recheck(this, request)). Writes nothing.
   * @param {import('./types').Request} request
   * @returns {Promise<import('./types').RecheckResult>}
   */
  async recheck(request) {
    return recheck(this, request);
  }

  // -------------------------------------------------------------------------------------------------------

  _ready() {
    const inv = this.inventory;
    if (!inv || inv.status === 'none' || !inv.flights) throw noSupplier();
  }

  _pricedAt() {
    return this.now().toISOString();
  }

  /** One flight leg of `query` in `cabin`: every option priced (up to the cap), sorted, with its benchmark. */
  async _flightLeg(leg, query, cabin, pricedAt) {
    const { from, to, date } = legOf(query, leg);
    const provider = this.inventory.flights;
    const pq = { from, to, departDate: date, passengers: 1, cabin };
    const offers = (await provider.search(pq)).filter(o => {
      validateOffer(o, 'flights');
      const segs = o.details && o.details.segments;
      return Array.isArray(segs) && segs.length && segs[0].from.code === from && segs[segs.length - 1].to.code === to && o.details.cabin === cabin;
    });
    const { rows, truncated } = await this._rows(provider, 'flights', offers, pq, (offer, option, quote) => dto.flightRow(offer, option, quote, { leg, pricedAt }));
    return { rows, benchmark: flightBenchmark(rows), truncated };
  }

  /** The hotel leg: the hotels of that city (exactly), every room priced, sorted, with both benchmarks. */
  async _hotelLeg(stay, pricedAt) {
    const provider = this.inventory.hotels;
    if (!provider) return { rows: [], benchmark: hotelBenchmarks([]), truncated: false };
    const pq = { where: stay.city, checkIn: stay.checkIn, checkOut: stay.checkOut, guests: 1 };
    const offers = (await provider.search(pq)).filter(o => {
      validateOffer(o, 'hotels');
      return o.location && o.location.city === stay.city && o.location.country === stay.country;
    });
    const { rows, truncated } = await this._rows(provider, 'hotels', offers, pq,
      (offer, option, quote) => dto.hotelRow(offer, option, quote, { pricedAt, checkIn: stay.checkIn, checkOut: stay.checkOut }));
    return { rows, benchmark: hotelBenchmarks(rows), truncated };
  }

  /** Rows for the offers of one search: available options quoted (at most MAX_PRICED_PER_LEG), the rest not. */
  async _rows(provider, vertical, offers, pq, build) {
    const kind = vertical === 'flights' ? 'flight' : 'hotel';
    let quoted = 0, truncated = false;
    const jobs = [];
    for (const offer of offers) {
      for (const option of offer.options) {
        if (!dto.ROW_KEY_RE.test(dto.rowKey(kind, offer.id, option.id))) continue; // an id no form can carry
        if (!option.available) { jobs.push([offer, option, null]); continue; }
        if (quoted >= MAX_PRICED_PER_LEG) { truncated = true; continue; }
        quoted += 1;
        jobs.push(this._quote(provider, vertical, offer, option, pq).then(quote => [offer, option, quote]));
      }
    }
    const rows = (await Promise.all(jobs)).map(([offer, option, quote]) => this._row(build(offer, option, quote)));
    return { rows: rows.sort(byTotal), truncated };
  }

  /** provider.quote(), checked; null when the option no longer prices (404 or 409 from the provider). */
  async _quote(provider, vertical, offer, option, pq) {
    try {
      const quote = await provider.quote({ offerId: offer.id, optionId: option.id, query: pq });
      return validateQuote(quote, vertical);
    } catch (e) {
      if (e instanceof AppError && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
  }

  /** A built row: allow-list checked, in the org's currency. */
  _row(row) {
    dto.assertRow(row);
    if (row.available && row.currency !== CURRENCY) throw unsupportedCurrency();
    return row;
  }

  /** One selected component priced now. */
  async _priceOne(component, key, query, pricedAt, prev) {
    const k = dto.parseRowKey(key);
    const gone = () => {
      const row = goneRow(prev, key, component, pricedAt);
      if (!row) throw invalidSelection();
      return row;
    };
    if (component === 'hotel') {
      const stay = query.hotel;
      const provider = this.inventory.hotels;
      if (!provider) return gone();
      const pq = { where: stay.city, checkIn: stay.checkIn, checkOut: stay.checkOut, guests: 1 };
      const offer = await provider.getOffer(k.offerId, pq);
      if (offer) validateOffer(offer, 'hotels');
      const here = offer && offer.location && offer.location.city === stay.city && offer.location.country === stay.country;
      const option = here ? offer.options.find(o => o.id === k.optionId) : null;
      if (!option) return gone();
      const quote = option.available ? await this._quote(provider, 'hotels', offer, option, pq) : null;
      return this._row(dto.hotelRow(offer, option, quote, { pricedAt, checkIn: stay.checkIn, checkOut: stay.checkOut }));
    }
    const { from, to, date } = legOf(query, component);
    const m = CABIN_SUFFIX.exec(k.offerId);
    const cabin = m ? m[1] : query.cabin;
    // A cabin variant may sit below the searched cabin, never above it.
    if (CABIN_RANK[cabin] > CABIN_RANK[query.cabin]) throw invalidSelection();
    const provider = this.inventory.flights;
    const pq = { from, to, departDate: date, passengers: 1, cabin };
    const offer = await provider.getOffer(k.offerId, pq);
    if (offer) validateOffer(offer, 'flights');
    const segs = offer && offer.details && offer.details.segments;
    const here = Array.isArray(segs) && segs.length && segs[0].from.code === from && segs[segs.length - 1].to.code === to;
    const option = here ? offer.options.find(o => o.id === k.optionId) : null;
    if (!option) return gone();
    const quote = option.available ? await this._quote(provider, 'flights', offer, option, pq) : null;
    return this._row(dto.flightRow(offer, option, quote, { leg: component, pricedAt }));
  }
}

/** The selection's keys checked against the query; '' counts as none. */
function checkSelection(selection, query) {
  const s = selection && typeof selection === 'object' ? selection : {};
  const keyOf = v => (v === undefined || v === null || v === '' ? null : v);
  const sel = { out: keyOf(s.out), back: keyOf(s.back), hotel: keyOf(s.hotel) };
  if (!sel.out) throw invalidSelection('Choose an outbound flight.');
  for (const c of COMPONENTS) {
    if (!sel[c]) continue;
    const k = dto.parseRowKey(sel[c]);
    if (!k) throw invalidSelection('That option key is not valid.');
    if ((c === 'hotel') !== (k.kind === 'hotel')) throw invalidSelection('That option belongs to another part of the trip.');
  }
  if (Boolean(sel.back) !== Boolean(query.returnDate)) throw invalidSelection('Choose a return flight for a return trip, and none one way.');
  if (sel.hotel && !query.hotel) throw invalidSelection('This search has no hotel.');
  return sel;
}

/** Is `a` the same search as `b` (legs, dates, cabin and stay)? */
function sameSearch(a, b) {
  return JSON.stringify(copyQuery(a)) === JSON.stringify({ ...copyQuery(b), datesFlexible: Boolean(a.datesFlexible) });
}

/** The same room of the same hotel, if it is available. */
function sameRoom(rows, mine) {
  return rows.find(r => r.available && r.offerId === mine.offerId && r.optionId === mine.optionId) || null;
}

/**
 * The flight on another date that matches `mine` best: the same fare family, stops and cabin; the same
 * carrier first, then the nearest departure time of day, then the lower total.
 */
function closestFlight(rows, mine) {
  const at = minutesOfDay(mine.segments[0].departLocal);
  const fits = rows.filter(r => r.available && r.optionId === mine.optionId && r.stops === mine.stops && r.cabin === mine.cabin);
  fits.sort((a, b) => (a.carrier.code === mine.carrier.code ? 0 : 1) - (b.carrier.code === mine.carrier.code ? 0 : 1)
    || Math.abs(minutesOfDay(a.segments[0].departLocal) - at) - Math.abs(minutesOfDay(b.segments[0].departLocal) - at)
    || a.totalCents - b.totalCents || (a.key < b.key ? -1 : 1));
  return fits[0] || null;
}

/** At most `cap` candidates, taken in turn from each kind (each kind cheapest first). */
function roundRobin(candidates, cap) {
  const byKind = new Map();
  for (const v of [...candidates].sort((a, b) => a.totalCents - b.totalCents)) {
    if (!byKind.has(v.change.kind)) byKind.set(v.change.kind, []);
    byKind.get(v.change.kind).push(v);
  }
  const out = [];
  while (out.length < cap) {
    let took = false;
    for (const list of byKind.values()) {
      if (list.length && out.length < cap) { out.push(list.shift()); took = true; }
    }
    if (!took) break;
  }
  return out;
}

module.exports = {
  MAX_PRICED_PER_LEG, MAX_SEARCHES, POOL_CAP, MAX_DAYS_AHEAD, MAX_TRIP_DAYS, NIGHTS_RANGE, FLEX_DAYS,
  parseTripQuery, TripComposer,
};
