// Fakes for the Stage 1 Business tests (plan §L Stage 0 step 14). FROZEN at the end of Stage 0: Stage 1
// builders test against them and Stage 3 swaps in the real modules, so each fake is shaped exactly like its
// typedef in server/business/types.js and behaves as the plan states (simplified where noted).
//
//   fakeInventory()     types.BusinessInventory over crafted, deterministic rows (CAI, LHR, DXB; Mediterra
//                       Airways and Sahara Wings; three "Fixture" hotels per city), with search and quote
//                       counters and per-row price and availability overrides. Its `flights` and `hotels`
//                       providers pass assertProvider and their offers pass validateOffer, but they answer only
//                       the fake's own queries ({ leg, from, to, date, cabin } and types.HotelQuery) and carry
//                       no FlightDetails or HotelDetails: they serve fakeComposer, never the real TripComposer.
//                       A provider-contract query (FlightQuery with departDate, HotelQuery with where) throws.
//   overrideProvider()  the contract-shaped override for the REAL inventory seam
//                       (createBusinessInventory(config, { overrides })): wraps a real provider
//                       (BusinessDemoFlights, BusinessDemoHotels, any Mock*Provider) and changes the quoted price
//                       or the availability of chosen options; everything else is the wrapped provider's own.
//                       For 1I's recheck same/changed/unavailable tests and the Stage 3 price-change scenario.
//   fakeComposer()      types.TripComposer over a fakeInventory, with call counters.
//   fakePolicy()        types.PolicyEngine with FIXED caps (no medians, no advance-booking rules) and the
//                       lifecycle, approver, effectiveStatus and expiresAt rules as lifecycle.js and approver.js
//                       document them.
//   fakeAlternatives()  types.AlternativesEngine (simple ranking, no giveUps).
//   fakeExplainer()     types.GuardedExplainer: records every input, never rejects, writes no digits.
//
// No store and no clock of their own: times come from the arguments (composer: the `now` passed in).
// Not a test file (it doesn't match *.test.js).
const crypto = require('node:crypto');
const tz = require('../server/business/tz');
const roles = require('../server/business/roles');
const cards = require('../server/business/cards');
const { AppError } = require('../server/lib/errors');
const { format } = require('../server/lib/money');
const { CABINS, CABIN_RANK, CABIN_LABELS, TIER_LABELS } = require('../server/business/constants');
const { defaultPolicy } = require('../server/business/policy/defaults');

const DAY = 86400000;
const MINUTE = 60000;

// ---------------------------------------------------------------------------------------------------------
// Crafted inventory data

/** The fake airports: the demo data's own names, cities, countries and time zones. */
const FAKE_AIRPORTS = Object.freeze([
  Object.freeze({ code: 'CAI', name: 'Cairo International', city: 'Cairo', country: 'Egypt', tz: 'Africa/Cairo' }),
  Object.freeze({ code: 'LHR', name: 'London Heathrow', city: 'London', country: 'United Kingdom', tz: 'Europe/London' }),
  Object.freeze({ code: 'DXB', name: 'Dubai International', city: 'Dubai', country: 'United Arab Emirates', tz: 'Asia/Dubai' }),
]);
/** The fake carriers (fakePolicy blocks Sahara Wings by default). */
const FAKE_CARRIERS = Object.freeze([
  Object.freeze({ code: 'ZM', name: 'Mediterra Airways' }),
  Object.freeze({ code: 'ZS', name: 'Sahara Wings' }),
]);

/** Flying minutes per route, either direction: CAI-LHR and CAI-DXB are short haul, DXB-LHR long haul (≥ 360). */
const ROUTE_MINUTES = Object.freeze({ 'CAI-LHR': 300, 'CAI-DXB': 225, 'DXB-LHR': 430 });
/** The Economy Light fare of the reference itinerary per route, in cents, before taxes. */
const ROUTE_FARE_CENTS = Object.freeze({ 'CAI-LHR': 40000, 'CAI-DXB': 30000, 'DXB-LHR': 70000 });
/** Taxes and charges per flight row, in cents. */
const FLIGHT_TAX_CENTS = 4200;
/** Layover on a one-stop itinerary, in minutes. */
const LAYOVER_MINUTES = 90;

/**
 * The itineraries every route has each day (n is the itinerary number in the offer id).
 * pct: price relative to the reference itinerary. Itinerary 4 stops at the third airport, and its Flex
 * fare is unavailable.
 */
const ITINERARIES = Object.freeze([
  Object.freeze({ n: 1, carrier: 'ZM', depart: '08:35', stops: 0, pct: 100 }),
  Object.freeze({ n: 2, carrier: 'ZM', depart: '13:40', stops: 0, pct: 90 }),
  Object.freeze({ n: 3, carrier: 'ZS', depart: '07:05', stops: 0, pct: 80 }),
  Object.freeze({ n: 4, carrier: 'ZM', depart: '22:10', stops: 1, pct: 70 }),
]);
/** Fare families: the demo's names, bags and terms (demo/flights.js FARE_TERMS). pct: price relative to Light. */
const FARES = Object.freeze({
  LIGHT: Object.freeze({ code: 'LIGHT', name: 'Light', pct: 100, cabinKg: 7, checkedBags: 0, checkedKg: 0, changeable: false, refundablePercent: 0, terms: 'Non-refundable. No changes.' }),
  CLASSIC: Object.freeze({ code: 'CLASSIC', name: 'Classic', pct: 122, cabinKg: 8, checkedBags: 1, checkedKg: 23, changeable: true, refundablePercent: 0, terms: 'Non-refundable. Changes for a fee.' }),
  FLEX: Object.freeze({ code: 'FLEX', name: 'Flex', pct: 155, cabinKg: 10, checkedBags: 2, checkedKg: 23, changeable: true, refundablePercent: 70, terms: '70% refundable. Free changes.' }),
});
/** Cabin price multipliers, in tenths. */
const CABIN_TENTHS = Object.freeze({ economy: 10, premium: 17, business: 31 });
/** Unavailable by construction: itinerary 4's Flex fare, and every Fixture Lodge Deluxe room. */
const UNAVAILABLE_FARE = Object.freeze({ n: 4, fare: 'FLEX' });

/** Nightly room rate (Standard room at Fixture Central) per city, in cents, before taxes. */
const CITY_NIGHTLY_CENTS = Object.freeze({ London: 25000, Cairo: 12000, Dubai: 18000 });
/** Three hotels in every city. pct: rate relative to the city's reference. */
const HOTELS = Object.freeze([
  Object.freeze({ n: 1, name: 'Fixture Grand', stars: 5, area: 'City centre', pct: 150, refundable: true, amenities: Object.freeze(['Free Wi-Fi', 'Breakfast included', 'Gym', 'Pool']) }),
  Object.freeze({ n: 2, name: 'Fixture Central', stars: 4, area: 'Business district', pct: 100, refundable: false, amenities: Object.freeze(['Free Wi-Fi', 'Breakfast included']) }),
  Object.freeze({ n: 3, name: 'Fixture Lodge', stars: 3, area: 'Near the airport', pct: 70, refundable: false, amenities: Object.freeze(['Free Wi-Fi']) }),
]);
/** Rooms in every hotel. pct: rate relative to the Standard room. */
const ROOMS = Object.freeze([
  Object.freeze({ code: 'STD', name: 'Standard room', sleeps: 2, bed: 'Queen bed', pct: 100 }),
  Object.freeze({ code: 'DLX', name: 'Deluxe room', sleeps: 2, bed: 'King bed', pct: 130 }),
]);
/** Hotel taxes, percent of the room rate. */
const HOTEL_TAX_PERCENT = 14;

const airportByCode = code => FAKE_AIRPORTS.find(a => a.code === code) || null;
const routeKey = (a, b) => [a, b].sort().join('-');
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
/** A day-of-month price wobble (100, 95 or 90 percent), so date shifts can be cheaper. */
const datePct = date => 100 - (Number(date.slice(8, 10)) % 3) * 5;

function noSupplier() {
  return new AppError('no_supplier', "Supplier not connected yet. Tripelyx hasn't connected airlines and hotels for company travel.", 503);
}
function invalidSelection(message = "That option isn't part of this search.") {
  return new AppError('invalid_selection', message, 422);
}

/** One segment as types.RowSegment, times local to each airport. */
function segment(carrier, flightNumber, from, to, departUtc, minutes) {
  const departLocal = tz.utcToLocal(from.tz, departUtc);
  const arriveUtc = new Date(departUtc.getTime() + minutes * MINUTE);
  const arriveLocal = tz.utcToLocal(to.tz, arriveUtc);
  return {
    seg: {
      carrier: { code: carrier.code, name: carrier.name }, flightNumber,
      from: { code: from.code, city: from.city }, to: { code: to.code, city: to.city },
      departLocal, arriveLocal, arriveDayOffset: dayDiff(departLocal.slice(0, 10), arriveLocal.slice(0, 10)), durationMinutes: minutes,
    },
    arriveUtc,
  };
}

/**
 * The flight rows of one leg on one date (every itinerary × every fare), before overrides.
 * @returns {import('../server/business/types').FlightRow[]}
 */
function craftFlightRows({ leg, from, to, date, cabin }, pricedAt) {
  const a = airportByCode(from), b = airportByCode(to);
  if (!a || !b || a === b || !isDate(date)) return [];
  const via = FAKE_AIRPORTS.find(x => x !== a && x !== b);
  const rows = [];
  for (const it of ITINERARIES) {
    const carrier = FAKE_CARRIERS.find(c => c.code === it.carrier);
    const base = 100 + it.n * 2 + (leg === 'back' ? 1 : 0);
    const departUtc = tz.localToUtc(a.tz, `${date}T${it.depart}`);
    const segs = [];
    if (it.stops === 0) {
      segs.push(segment(carrier, `${carrier.code}${base}`, a, b, departUtc, ROUTE_MINUTES[routeKey(a.code, b.code)]));
    } else {
      const first = segment(carrier, `${carrier.code}${base}`, a, via, departUtc, ROUTE_MINUTES[routeKey(a.code, via.code)]);
      const second = segment(carrier, `${carrier.code}${base + 500}`, via, b, new Date(first.arriveUtc.getTime() + LAYOVER_MINUTES * MINUTE), ROUTE_MINUTES[routeKey(via.code, b.code)]);
      segs.push(first, second);
    }
    const offerId = `flt_fake_${a.code}${b.code}_${date}_${it.n}`;
    for (const fare of Object.values(FARES)) {
      const available = !(it.n === UNAVAILABLE_FARE.n && fare.code === UNAVAILABLE_FARE.fare);
      const baseCents = Math.round(ROUTE_FARE_CENTS[routeKey(a.code, b.code)] * it.pct * datePct(date) * CABIN_TENTHS[cabin] * fare.pct / 1e7);
      const lines = available ? [{ label: 'Fare', kind: 'base', cents: baseCents }, { label: 'Taxes and charges', kind: 'tax', cents: FLIGHT_TAX_CENTS }] : [];
      rows.push({
        key: `f.${offerId}|${fare.code}`, kind: 'flight', leg, offerId, optionId: fare.code,
        carrier: { code: carrier.code, name: carrier.name },
        flightNumbers: segs.map(s => s.seg.flightNumber),
        segments: segs.map(s => ({ ...s.seg, carrier: { ...s.seg.carrier }, from: { ...s.seg.from }, to: { ...s.seg.to } })),
        stops: it.stops,
        via: it.stops ? [{ code: via.code, city: via.city }] : [],
        flyingMinutes: segs.reduce((n, s) => n + s.seg.durationMinutes, 0),
        elapsedMinutes: Math.round((segs[segs.length - 1].arriveUtc.getTime() - departUtc.getTime()) / MINUTE),
        cabin, cabinLabel: CABIN_LABELS[cabin],
        fare: { code: fare.code, name: fare.name, cabinKg: fare.cabinKg, checkedBags: fare.checkedBags, checkedKg: fare.checkedKg, changeable: fare.changeable, refundablePercent: fare.refundablePercent, terms: fare.terms },
        lines, totalCents: available ? baseCents + FLIGHT_TAX_CENTS : null, currency: 'USD', available, demo: true, pricedAt,
      });
    }
  }
  return rows;
}

/**
 * The hotel rows for one stay (every hotel × every room), before overrides.
 * @returns {import('../server/business/types').HotelRow[]}
 */
function craftHotelRows({ city, country, checkIn, checkOut }, pricedAt) {
  const airport = FAKE_AIRPORTS.find(a => a.city === city && a.country === country);
  if (!airport || !isDate(checkIn) || !isDate(checkOut)) return [];
  const nights = dayDiff(checkIn, checkOut);
  if (nights < 1) return [];
  const rows = [];
  for (const h of HOTELS) {
    const offerId = `htl_fake_${airport.code}_${h.n}`;
    for (const room of ROOMS) {
      const available = !(h.n === 3 && room.code === 'DLX');
      const nightly = Math.round(CITY_NIGHTLY_CENTS[city] * h.pct * room.pct / 10000);
      const tax = Math.round(nightly * HOTEL_TAX_PERCENT / 100);
      const total = (nightly + tax) * nights;
      rows.push({
        key: `h.${offerId}|${room.code}`, kind: 'hotel', offerId, optionId: room.code, name: `${h.name} ${city}`, stars: h.stars, area: h.area,
        city, country, room: { name: room.name, sleeps: room.sleeps, bed: room.bed }, checkIn, checkOut, nights,
        nightlyCents: available ? nightly : null, nightlyInclCents: available ? Math.round(total / nights) : null,
        lines: available ? [{ label: `${nights} ${nights === 1 ? 'night' : 'nights'}`, kind: 'base', cents: nightly * nights }, { label: 'Taxes and fees', kind: 'tax', cents: tax * nights }] : [],
        totalCents: available ? total : null, currency: 'USD',
        cancellation: h.refundable
          ? { refundable: true, freeUntilHours: 48, text: 'Free cancellation until 48 hours before check-in.' }
          : { refundable: false, freeUntilHours: 0, text: 'Non-refundable.' },
        amenities: [...h.amenities], available, demo: true, pricedAt,
      });
    }
  }
  return rows;
}

/** Apply a price or availability override to a crafted row (lines stay consistent with the total). */
function applyOverride(row, o) {
  if (!o) return row;
  if (o.unavailable) {
    const gone = { ...row, lines: [], totalCents: null, available: false };
    if (row.kind === 'hotel') { gone.nightlyCents = null; gone.nightlyInclCents = null; }
    return gone;
  }
  if (Number.isInteger(o.totalCents)) {
    const tax = row.lines.filter(l => l.kind !== 'base').reduce((n, l) => n + l.cents, 0) || 0;
    const baseCents = Math.max(0, o.totalCents - tax);
    const lines = (row.lines.length ? row.lines : [{ label: 'Fare', kind: 'base', cents: 0 }]).map(l => (l.kind === 'base' ? { ...l, cents: baseCents } : { ...l }));
    const total = lines.reduce((n, l) => n + l.cents, 0);
    const next = { ...row, lines, totalCents: total, available: true };
    if (row.kind === 'hotel') {
      next.nightlyCents = Math.round(baseCents / row.nights);
      next.nightlyInclCents = Math.round(total / row.nights);
    }
    return next;
  }
  return row;
}

/** A provider-contract offer (providers/contracts.validateOffer passes) for the rows of one offer id. */
function offerFromRows(rows, vertical) {
  const r0 = rows[0];
  const priced = rows.filter(r => r.available).map(r => r.totalCents);
  return {
    id: r0.offerId, vertical, provider: vertical === 'flights' ? 'FakeFlights' : 'FakeHotels', demo: true,
    title: vertical === 'flights' ? `${r0.carrier.name} ${r0.flightNumbers.join(', ')}` : r0.name,
    location: { name: vertical === 'flights' ? `${r0.segments[0].from.city} to ${r0.segments[r0.segments.length - 1].to.city}` : r0.city },
    media: [],
    fromPrice: { amount: priced.length ? Math.min(...priced) : 0, currency: 'USD', unit: vertical === 'flights' ? 'per traveler' : 'per stay' },
    options: rows.map(r => ({ id: r.optionId, name: vertical === 'flights' ? r.fare.name : r.room.name, price: { amount: r.totalCents ?? 0, currency: 'USD' }, available: r.available })),
    cancellation: { type: 'non_refundable', penaltyPercent: 100, summary: 'Non-refundable.' },
    details: { rows: rows.map(r => r.key) },
  };
}

/**
 * A fake BusinessInventory over the crafted rows.
 * Besides the typedef's fields it has (fake-only):
 *   searches / quotes        how many leg searches and option quotes ran (the composer counts through these)
 *   flightRows(q, pricedAt)  one leg's rows ({ leg, from, to, date, cabin }); counts one search
 *   hotelRows(q, pricedAt)   one stay's rows (types.HotelQuery); counts one search
 *   quoteRow(key, q, pricedAt) the fresh row for one key, or null when the key is not in that search; counts one quote
 *   setPrice(key, totalCents) / setUnavailable(key[, unavailable]) / clearOverrides()
 *   peekFlightRows / peekHotelRows  the same rows without counting a search
 * @param {{ status?: 'demo'|'live'|'none' }} [opts]
 * @returns {import('../server/business/types').BusinessInventory & object}
 */
function fakeInventory({ status = 'demo' } = {}) {
  const overrides = new Map();
  const count = { searches: 0, quotes: 0 };
  const on = status !== 'none';
  const peekFlightRows = (q, pricedAt) => (on ? craftFlightRows(q, pricedAt).map(r => applyOverride(r, overrides.get(r.key))) : []);
  const peekHotelRows = (q, pricedAt) => (on ? craftHotelRows(q, pricedAt).map(r => applyOverride(r, overrides.get(r.key))) : []);
  /** The fake's own query vocabulary only: a provider-contract query would silently match nothing. */
  const ownQuery = (vertical, q) => {
    const ok = vertical === 'flights' ? q && typeof q.date === 'string' : q && typeof q.city === 'string';
    if (!ok) {
      throw new TypeError(`[fakes] fakeInventory().${vertical} answers only the fake's own queries (${vertical === 'flights' ? '{ leg, from, to, date, cabin }' : 'types.HotelQuery { city, country, checkIn, checkOut }'}) `
        + 'for fakeComposer. To give the real TripComposer an override, wrap a real provider with overrideProvider().');
    }
    return q;
  };
  const provider = vertical => ({
    name: vertical === 'flights' ? 'FakeFlights' : 'FakeHotels', vertical, isDemo: true,
    // Provider-contract shapes only (validateOffer/validateQuote pass); the details are not the demo providers'.
    async search(q) {
      ownQuery(vertical, q);
      const rows = vertical === 'flights' ? inv.flightRows(q, q.pricedAt || '1970-01-01T00:00:00.000Z') : inv.hotelRows(q, q.pricedAt || '1970-01-01T00:00:00.000Z');
      const byOffer = new Map();
      for (const r of rows) byOffer.set(r.offerId, [...(byOffer.get(r.offerId) || []), r]);
      return [...byOffer.values()].map(rs => offerFromRows(rs, vertical));
    },
    async getOffer(offerId, q) { return (await this.search(q)).find(o => o.id === offerId) || null; },
    async quote({ offerId, optionId, query }) {
      ownQuery(vertical, query);
      const prefix = vertical === 'flights' ? 'f.' : 'h.';
      const row = inv.quoteRow(`${prefix}${offerId}|${optionId}`, query, query.pricedAt || '1970-01-01T00:00:00.000Z');
      if (!row || !row.available) throw new AppError('unavailable', 'This option is no longer available.', 409);
      const offer = offerFromRows([row], vertical);
      return {
        offer, option: offer.options[0], currency: 'USD',
        lines: row.lines.map(l => ({ code: l.kind.toUpperCase(), label: l.label, kind: l.kind, amount: l.cents })),
        startDate: vertical === 'flights' ? query.date : query.checkIn, cancellation: offer.cancellation,
      };
    },
    async book() { throw new AppError('not_supported', 'Business never books.', 400); },
    async cancel() { throw new AppError('not_supported', 'Business never books.', 400); },
  });
  const inv = {
    status,
    flights: on ? provider('flights') : null,
    hotels: on ? provider('hotels') : null,
    airports: () => (on ? FAKE_AIRPORTS.map(a => ({ ...a })) : []),
    carriers: () => (on ? FAKE_CARRIERS.map(c => ({ ...c })) : []),
    cityFor: iata => {
      const a = on ? airportByCode(String(iata || '').toUpperCase()) : null;
      return a ? { city: a.city, country: a.country } : null;
    },
    get searches() { return count.searches; },
    get quotes() { return count.quotes; },
    flightRows(q, pricedAt) { count.searches += 1; return peekFlightRows(q, pricedAt); },
    hotelRows(q, pricedAt) { count.searches += 1; return peekHotelRows(q, pricedAt); },
    quoteRow(key, q, pricedAt) {
      count.quotes += 1;
      const rows = key.startsWith('f.') ? peekFlightRows(q, pricedAt) : peekHotelRows(q, pricedAt);
      return rows.find(r => r.key === key) || null;
    },
    peekFlightRows,
    peekHotelRows,
    setPrice(key, totalCents) {
      if (!Number.isInteger(totalCents) || totalCents < 0) throw new RangeError('setPrice needs whole cents');
      overrides.set(key, { totalCents });
    },
    setUnavailable(key, unavailable = true) {
      if (unavailable) overrides.set(key, { unavailable: true });
      else overrides.delete(key);
    },
    clearOverrides() { overrides.clear(); },
  };
  return inv;
}

// ---------------------------------------------------------------------------------------------------------
// overrideProvider

/**
 * A provider-contract override for the real inventory seam: createBusinessInventory(config, { overrides:
 * { flights, hotels } }) (plan §F1). Wraps a real provider (BusinessDemoFlights, BusinessDemoHotels or any
 * Mock*Provider) and passes every call through with the wrapped provider's own queries, offers, details and
 * quotes (assertProvider, validateOffer and validateQuote pass), except for the options you change:
 *   setPrice(offerId, optionId, deltaCents)  quote(): the first 'base' line moves by deltaCents (a whole number,
 *       may be negative), so the quote's total moves by exactly that. search() and getOffer() are unchanged
 *       (the composer prices every row through quote()). A base line that would go below 0 throws a RangeError.
 *   setUnavailable(offerId, optionId[, unavailable = true])  search() and getOffer() show the option with
 *       available:false; quote() throws AppError 'option_sold_out' 409, as the mock providers do.
 *   clearOverrides()
 *   calls  { search, getOffer, quote } counters; inner  the wrapped provider.
 * book() and cancel() always throw: Business never books.
 * @param {object} inner a provider that passes providers/contracts.assertProvider
 * @returns {object} a provider (same name, vertical and isDemo) with the methods above
 */
function overrideProvider(inner) {
  if (!inner || typeof inner.search !== 'function' || typeof inner.quote !== 'function' || typeof inner.getOffer !== 'function') {
    throw new TypeError('[fakes] overrideProvider wraps a provider (search, getOffer, quote)');
  }
  const changes = new Map();
  const calls = { search: 0, getOffer: 0, quote: 0 };
  const keyOf = (offerId, optionId) => `${offerId}|${optionId}`;
  const mark = offer => {
    if (!offer || !offer.options.some(o => changes.get(keyOf(offer.id, o.id))?.unavailable)) return offer;
    return { ...offer, options: offer.options.map(o => (changes.get(keyOf(offer.id, o.id))?.unavailable ? { ...o, available: false } : o)) };
  };
  return {
    name: inner.name, vertical: inner.vertical, isDemo: inner.isDemo, inner, calls,
    async search(query) {
      calls.search += 1;
      return (await inner.search(query)).map(mark);
    },
    async getOffer(offerId, query) {
      calls.getOffer += 1;
      return mark(await inner.getOffer(offerId, query));
    },
    async quote(input) {
      calls.quote += 1;
      const change = changes.get(keyOf(input.offerId, input.optionId));
      if (change && change.unavailable) throw new AppError('option_sold_out', 'That option is sold out for your dates.', 409);
      const q = await inner.quote(input);
      if (!change || !change.deltaCents) return q;
      const at = q.lines.findIndex(l => l.kind === 'base');
      if (at < 0) throw new RangeError('[fakes] overrideProvider: the quote has no base line to move');
      const amount = q.lines[at].amount + change.deltaCents;
      if (amount < 0) throw new RangeError('[fakes] overrideProvider: the base line would go below 0');
      return { ...q, lines: q.lines.map((l, i) => (i === at ? { ...l, amount } : l)) };
    },
    async book() { throw new AppError('not_supported', 'Business never books.', 400); },
    async cancel() { throw new AppError('not_supported', 'Business never books.', 400); },
    ...(typeof inner.lookups === 'function' ? { lookups: (...a) => inner.lookups(...a) } : {}),
    setPrice(offerId, optionId, deltaCents) {
      if (!Number.isInteger(deltaCents)) throw new RangeError('setPrice needs a whole number of cents');
      changes.set(keyOf(offerId, optionId), { deltaCents });
    },
    setUnavailable(offerId, optionId, unavailable = true) {
      if (unavailable) changes.set(keyOf(offerId, optionId), { unavailable: true });
      else changes.delete(keyOf(offerId, optionId));
    },
    clearOverrides() { changes.clear(); },
  };
}

// ---------------------------------------------------------------------------------------------------------
// fakeComposer

/** Cheapest available total per offer id (one value per itinerary or hotel). */
function cheapestPerOffer(rows, pick) {
  const best = new Map();
  for (const r of rows) {
    if (!r.available) continue;
    const v = pick(r);
    if (v == null) continue;
    if (!best.has(r.offerId) || v < best.get(r.offerId)) best.set(r.offerId, v);
  }
  return [...best.values()].sort((a, b) => a - b);
}

/** The plain median of whole-cent values (no outlier removal); null below 3 values. */
function plainBenchmark(values) {
  const v = [...values].sort((a, b) => a - b);
  if (v.length < 3) return { medianCents: null, sampleSize: v.length, excluded: [] };
  const mid = Math.floor(v.length / 2);
  return { medianCents: v.length % 2 ? v[mid] : Math.floor((v[mid - 1] + v[mid]) / 2), sampleSize: v.length, excluded: [] };
}

/** Rows sorted by total, unavailable last, then key. */
const byTotal = (a, b) => (a.available === b.available ? 0 : a.available ? -1 : 1) || (a.totalCents ?? 0) - (b.totalCents ?? 0) || (a.key < b.key ? -1 : 1);

const ROW_KEY = /^([fh])\.((flt|htl)_[A-Za-z0-9_.-]{1,160})\|([A-Za-z0-9_-]{1,40})$/;

/**
 * A fake TripComposer over a fakeInventory. Counters in `calls`; the inventory counts searches and quotes.
 * Simplified: search() never moves the hotel check-in; variants() makes fare, flight, stops, room, hotel and
 * (with datesFlexible) ±1 day 'dates' candidates, but no 'cabin' or 'all_within' ones.
 * @param {{ inventory?: ReturnType<typeof fakeInventory>, now?: () => Date }} [opts]
 * @returns {import('../server/business/types').TripComposer & { inventory: object, calls: Record<string, number> }}
 */
function fakeComposer({ inventory = fakeInventory(), now = () => new Date('2026-10-09T09:00:00.000Z') } = {}) {
  const calls = { parseQuery: 0, search: 0, price: 0, variants: 0, recheck: 0 };
  const iso = () => now().toISOString();
  const legQuery = (query, leg) => (leg === 'out'
    ? { leg, from: query.from, to: query.to, date: query.departDate, cabin: query.cabin }
    : { leg, from: query.to, to: query.from, date: query.returnDate, cabin: query.cabin });

  function priceComponent(key, component, query, pricedAt, count) {
    const m = ROW_KEY.exec(String(key || ''));
    if (!m || (m[1] === 'f') !== (m[3] === 'flt')) throw invalidSelection('That option key is not valid.');
    if ((component === 'hotel') !== (m[1] === 'h')) throw invalidSelection('That option belongs to another part of the trip.');
    const q = component === 'hotel' ? query.hotel : legQuery(query, component);
    const row = count ? inventory.quoteRow(key, q, pricedAt)
      : (component === 'hotel' ? inventory.peekHotelRows(q, pricedAt) : inventory.peekFlightRows(q, pricedAt)).find(r => r.key === key) || null;
    if (!row) throw invalidSelection();
    return row;
  }

  const composer = {
    inventory,
    calls,
    parseQuery(raw = {}, { today } = {}) {
      calls.parseQuery += 1;
      const details = {};
      const from = String(raw.from || '').trim().toUpperCase();
      const to = String(raw.to || '').trim().toUpperCase();
      if (!inventory.cityFor(from)) details.from = 'Choose an airport from the list.';
      if (!inventory.cityFor(to)) details.to = 'Choose an airport from the list.';
      else if (to === from) details.to = 'Choose a destination other than where you leave from.';
      const depart = String(raw.depart || '');
      if (!isDate(depart) || (today && depart < today) || (today && dayDiff(today, depart) > 330)) details.depart = 'Choose a date from today up to 330 days ahead.';
      const ret = String(raw.return || '');
      if (ret && (!isDate(ret) || !isDate(depart) || ret <= depart || dayDiff(depart, ret) > 30)) details.return = 'Choose a return date after you leave, within 30 days.';
      const cabin = raw.cabin ? String(raw.cabin) : 'economy';
      if (!CABINS.includes(cabin)) details.cabin = 'Choose a cabin.';
      const wantsHotel = raw.hotel === '1';
      let nights = null;
      if (wantsHotel && !ret) {
        nights = Number(raw.nights || 1);
        if (!Number.isInteger(nights) || nights < 1 || nights > 14) details.nights = 'Choose 1 to 14 nights.';
      }
      if (Object.keys(details).length) throw new AppError('invalid_query', 'Check the highlighted fields.', 422, details);
      const dest = inventory.cityFor(to);
      return {
        from, to, departDate: depart, returnDate: ret || null, cabin, passengers: 1, datesFlexible: raw.flex === '1',
        hotel: wantsHotel ? { city: dest.city, country: dest.country, checkIn: depart, checkOut: ret || addDays(depart, nights) } : null,
      };
    },

    async search(query) {
      calls.search += 1;
      if (inventory.status === 'none') throw noSupplier();
      const pricedAt = iso();
      const flightLeg = leg => {
        const rows = inventory.flightRows(legQuery(query, leg), pricedAt).sort(byTotal);
        return { rows, benchmark: plainBenchmark(cheapestPerOffer(rows, r => r.totalCents)), truncated: false };
      };
      let hotel = null;
      if (query.hotel) {
        const rows = inventory.hotelRows(query.hotel, pricedAt).sort(byTotal);
        hotel = {
          rows,
          benchmark: { incl_taxes: plainBenchmark(cheapestPerOffer(rows, r => r.nightlyInclCents)), excl_taxes: plainBenchmark(cheapestPerOffer(rows, r => r.nightlyCents)) },
          truncated: false,
        };
      }
      return { query: structuredClone(query), legs: { out: flightLeg('out'), back: query.returnDate ? flightLeg('back') : null, hotel }, pricedAt, status: inventory.status };
    },

    async price(selection, query) {
      calls.price += 1;
      if (inventory.status === 'none') throw noSupplier();
      if (!selection || !selection.out) throw invalidSelection('Choose an outbound flight.');
      if (Boolean(selection.back) !== Boolean(query.returnDate)) throw invalidSelection('Choose a return flight for a return trip, and none one way.');
      if (selection.hotel && !query.hotel) throw invalidSelection('This search has no hotel.');
      const pricedAt = iso();
      const rows = {
        out: priceComponent(selection.out, 'out', query, pricedAt, true),
        back: selection.back ? priceComponent(selection.back, 'back', query, pricedAt, true) : null,
        hotel: selection.hotel ? priceComponent(selection.hotel, 'hotel', query, pricedAt, true) : null,
      };
      const parts = ['out', 'back', 'hotel'].filter(c => rows[c]);
      const unavailable = parts.filter(c => !rows[c].available);
      return { rows, totalCents: unavailable.length ? null : parts.reduce((n, c) => n + rows[c].totalCents, 0), pricedAt, unavailable };
    },

    async variants(query, selection, { datesFlexible = false, maxSearches = 20 } = {}) {
      calls.variants += 1;
      if (inventory.status === 'none') throw noSupplier();
      const pricedAt = iso();
      const pick = {
        out: priceComponent(selection.out, 'out', query, pricedAt, false),
        back: selection.back ? priceComponent(selection.back, 'back', query, pricedAt, false) : null,
        hotel: selection.hotel ? priceComponent(selection.hotel, 'hotel', query, pricedAt, false) : null,
      };
      const total = rows => ['out', 'back', 'hotel'].reduce((n, c) => n + (rows[c] ? rows[c].totalCents : 0), 0);
      const describeRow = r => (r.kind === 'flight' ? `${r.carrier.name} ${r.flightNumbers.join(' ')} ${r.fare.name}` : `${r.name}, ${r.room.name}`);
      const candidates = [];
      for (const c of ['out', 'back', 'hotel']) {
        const mine = pick[c];
        if (!mine || !mine.available) continue;
        const pool = c === 'hotel' ? inventory.peekHotelRows(query.hotel, pricedAt) : inventory.peekFlightRows(legQuery(query, c), pricedAt);
        for (const r of pool) {
          if (!r.available || r.key === mine.key || r.totalCents >= mine.totalCents) continue;
          const kind = c === 'hotel' ? (r.offerId === mine.offerId ? 'room' : 'hotel')
            : r.offerId === mine.offerId ? 'fare' : r.stops > mine.stops ? 'stops' : 'flight';
          const rows = { ...pick, [c]: r };
          candidates.push({
            change: { kind, component: c, fromText: describeRow(mine), toText: describeRow(r) },
            selection: { out: rows.out.key, back: rows.back ? rows.back.key : null, hotel: rows.hotel ? rows.hotel.key : null },
            query: structuredClone(query), rows, totalCents: total(rows),
          });
        }
      }
      let searches = 0, truncated = false;
      if (datesFlexible) {
        for (const days of [1, -1]) {
          const legs = 1 + (query.returnDate ? 1 : 0) + (query.hotel ? 1 : 0);
          if (searches + legs > maxSearches) { truncated = true; break; }
          const today = iso().slice(0, 10);
          if (addDays(query.departDate, days) < today) continue;
          const q = structuredClone(query);
          q.departDate = addDays(q.departDate, days);
          if (q.returnDate) q.returnDate = addDays(q.returnDate, days);
          if (q.hotel) { q.hotel.checkIn = addDays(q.hotel.checkIn, days); q.hotel.checkOut = addDays(q.hotel.checkOut, days); }
          searches += legs;
          const same = (rows, row) => rows.find(r => r.offerId.replace(/_\d{4}-\d{2}-\d{2}_/, '_') === row.offerId.replace(/_\d{4}-\d{2}-\d{2}_/, '_') && r.optionId === row.optionId) || null;
          const rows = {
            out: same(inventory.flightRows(legQuery(q, 'out'), pricedAt), pick.out),
            back: pick.back ? same(inventory.flightRows(legQuery(q, 'back'), pricedAt), pick.back) : null,
            hotel: pick.hotel ? same(inventory.hotelRows(q.hotel, pricedAt), pick.hotel) : null,
          };
          if (!rows.out || !rows.out.available || (pick.back && (!rows.back || !rows.back.available)) || (pick.hotel && (!rows.hotel || !rows.hotel.available))) continue;
          if (total(rows) >= total(pick)) continue;
          candidates.push({
            change: { kind: 'dates', component: 'trip', fromText: query.departDate, toText: q.departDate, days },
            selection: { out: rows.out.key, back: rows.back ? rows.back.key : null, hotel: rows.hotel ? rows.hotel.key : null },
            query: q, rows, totalCents: total(rows),
          });
        }
      }
      return { candidates, searches, truncated };
    },

    async recheck(request) {
      calls.recheck += 1;
      const fresh = await composer.price(request.selection, request.query);
      const components = {};
      let worst = 'same';
      const rank = { same: 0, changed: 1, unavailable: 2 };
      for (const c of ['out', 'back', 'hotel']) {
        const was = request.rows[c];
        if (!was) { components[c] = null; continue; }
        const row = fresh.rows[c];
        const status = !row.available ? 'unavailable' : row.totalCents !== was.totalCents ? 'changed' : 'same';
        if (rank[status] > rank[worst]) worst = status;
        components[c] = { status, row, wasCents: was.totalCents, nowCents: row.available ? row.totalCents : null };
      }
      return { status: worst, components, newTotalCents: fresh.totalCents, at: fresh.pricedAt };
    },
  };
  return composer;
}

// ---------------------------------------------------------------------------------------------------------
// fakePolicy

const STATUS_RANK = Object.freeze({ within: 0, out: 1, blocked: 2 });
const TERMINAL = Object.freeze(['denied', 'cancelled', 'expired']);
const EVENTS = Object.freeze(['swap', 'submit', 'cancel', 'approve', 'deny', 'expire', 'message']);

const err = (code, message, status) => new AppError(code, message, status);
const invalidTransition = () => err('invalid_transition', 'Someone just acted on this request. Here is where it stands now.', 409);
const notFound = () => err('not_found', 'Not found.', 404);

/** Every scalar leaf of a JSON value as a dotted path ('hotels.countryCaps[0].nightlyCents'). */
function leaves(value, path = '', out = new Map()) {
  if (Array.isArray(value)) {
    if (!value.length) out.set(path, []);
    value.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) leaves(value[k], path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, value);
  }
  return out;
}

/**
 * A fake PolicyEngine. Caps are fixed (options below), not taken from ctx.rules: flight rows over
 * flightCapCents → 'flight.cap'; a cabin above maxCabin → 'flight.cabin'; a carrier in blockedCarriers →
 * 'flight.carrier' (block); hotel nightlyInclCents over hotelCapCents → 'hotel.cap'; more stars than maxStars
 * → 'hotel.stars'; an unavailable row → 'inventory.unavailable' (block). No advance, stops, refundability or
 * trip cap rules. The budget check, statuses, the lifecycle, approver resolution, effectiveStatus and
 * expiresAt follow lifecycle.js and approver.js. The policy form has two fields (longHaulMinutes and
 * hotel.default); every other rule comes from baseRules.
 * `calls` counts each method; `configure(opts)` changes the caps mid-test.
 * @param {{ flightCapCents?: number, hotelCapCents?: number, maxCabin?: string, maxStars?: number,
 *   blockedCarriers?: string[], longHaulMinutes?: number, baseRules?: object }} [opts]
 * @returns {import('../server/business/types').PolicyEngine & { calls: Record<string, number>, configure: Function, opts: object }}
 */
function fakePolicy(options = {}) {
  const opts = {
    flightCapCents: 60000, hotelCapCents: 30000, maxCabin: 'economy', maxStars: 4, blockedCarriers: ['ZS'], longHaulMinutes: 360,
    baseRules: defaultPolicy('standard'), ...options,
  };
  const calls = {};
  const counted = (name, fn) => (...args) => { calls[name] = (calls[name] || 0) + 1; return fn(...args); };

  function evaluateComponent(row, ctx) {
    const violations = [];
    const carriers = (ctx && ctx.carriers) || {};
    let cap;
    if (row.kind === 'flight') {
      cap = { cents: opts.flightCapCents, source: 'fixed', haul: row.flyingMinutes >= opts.longHaulMinutes ? 'long' : 'short' };
      if (opts.blockedCarriers.includes(row.carrier.code)) {
        violations.push({ rule: 'flight.carrier', component: row.leg, severity: 'block', limit: row.carrier.code, actual: row.carrier.code, text: `${carriers[row.carrier.code] || row.carrier.name} isn't used by ${ctx.orgName}.` });
      }
      if (CABIN_RANK[row.cabin] > CABIN_RANK[opts.maxCabin]) {
        violations.push({ rule: 'flight.cabin', component: row.leg, severity: 'approval', limit: opts.maxCabin, actual: row.cabin, text: `${CABIN_LABELS[row.cabin]} is above ${CABIN_LABELS[opts.maxCabin]}.` });
      }
    } else {
      cap = { cents: opts.hotelCapCents, source: 'default', basis: 'incl_taxes' };
      if (opts.maxStars != null && row.stars > opts.maxStars) {
        violations.push({ rule: 'hotel.stars', component: 'hotel', severity: 'approval', limit: opts.maxStars, actual: row.stars, text: `${row.stars}-star hotels are above your policy's ${opts.maxStars} stars.` });
      }
    }
    let overCents = 0;
    if (!row.available) {
      violations.push({ rule: 'inventory.unavailable', component: row.kind === 'flight' ? row.leg : 'hotel', severity: 'block', limit: null, actual: null, text: 'Not available in demo data.' });
    } else if (row.kind === 'flight') {
      if (cap.cents != null && row.totalCents > cap.cents) {
        overCents = row.totalCents - cap.cents;
        violations.push({ rule: 'flight.cap', component: row.leg, severity: 'approval', limit: cap.cents, actual: row.totalCents, text: `${format(overCents)} over the limit of ${format(cap.cents)}.` });
      }
    } else if (cap.cents != null) {
      // Whole stay on the basis (incl_taxes: the row total) against cap × nights; limit, actual and overCents
      // are stay totals, and the text quotes the nightly figures (evaluate.js hotel.cap).
      const limit = cap.cents * row.nights;
      if (row.totalCents > limit) {
        overCents = row.totalCents - limit;
        violations.push({ rule: 'hotel.cap', component: 'hotel', severity: 'approval', limit, actual: row.totalCents, text: `${format(row.nightlyInclCents)} a night is over the limit of ${format(cap.cents)} (taxes included).` });
      }
    }
    const blocked = violations.some(v => v.severity === 'block') || (ctx && ctx.outOfPolicy === 'block' && violations.length > 0);
    return { status: blocked ? 'blocked' : violations.length ? 'out' : 'within', violations, cap, overCents };
  }

  function evaluateTrip(rows, ctx, { budget = null } = {}) {
    if (budget && (typeof budget.periodLabel !== 'string' || !budget.periodLabel)) {
      throw new TypeError('[fake] BudgetCtx needs periodLabel (budgets.periodLabel(periodKey)): evaluate stays pure');
    }
    const components = {};
    let status = 'within';
    const violations = [];
    let totalCents = 0;
    for (const c of ['out', 'back', 'hotel']) {
      if (!rows[c]) continue;
      const e = evaluateComponent(rows[c], ctx);
      components[c] = e;
      violations.push(...e.violations);
      if (STATUS_RANK[e.status] > STATUS_RANK[status]) status = e.status;
      totalCents += rows[c].totalCents || 0;
    }
    if (budget && totalCents > budget.remainingCents) {
      violations.push({ rule: 'budget', component: 'trip', severity: 'approval', limit: budget.remainingCents, actual: totalCents, text: `This trip would use ${format(totalCents)} of the ${format(Math.max(0, budget.remainingCents))} left in ${budget.departmentName} for ${budget.periodLabel}` });
      if (status === 'within') status = 'out';
    }
    return { status, components, violations, totalCents, policy: { ...ctx.policy } };
  }

  function resolveApprover(traveler, membersById) {
    const skipped = [];
    const why = userId => {
      const m = membersById[userId];
      if (!m) return 'not_member';
      if (m.status !== 'active') return 'removed';
      if (userId === traveler.userId) return 'is_traveler';
      if (!roles.can(m.role, 'approval.decide')) return 'cannot_approve';
      return null;
    };
    for (const [field, rule] of [['approverId', 'approver'], ['managerId', 'manager']]) {
      const userId = traveler[field];
      if (!userId) continue;
      const reason = why(userId);
      if (!reason) return { approverId: userId, pool: false, poolIds: [], rule, skipped };
      skipped.push({ userId, reason });
    }
    const poolIds = Object.values(membersById)
      .filter(m => m.status === 'active' && (m.role === 'owner' || m.role === 'travel_admin') && m.userId !== traveler.userId)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.userId < b.userId ? -1 : 1))
      .map(m => m.userId);
    if (poolIds.length) return { approverId: null, pool: true, poolIds, rule: 'admin', skipped };
    return { approverId: null, pool: false, poolIds: [], rule: null, skipped };
  }

  function expiresAt(submittedAt, approvalHours, departDate, timezone) {
    const byHours = Date.parse(submittedAt) + approvalHours * 3600000;
    const midnight = Date.parse(tz.localMidnightUtc(timezone, departDate));
    return new Date(Math.min(byHours, midnight)).toISOString();
  }

  function effectiveStatus(request, nowIso, timezone = 'UTC') {
    if (request.status === 'pending' && request.expiresAt && Date.parse(nowIso) >= Date.parse(request.expiresAt)) return 'expired';
    if (request.status === 'approved' && request.query && request.query.departDate < tz.localDate(timezone, new Date(nowIso))) return 'past';
    return request.status;
  }

  /** How the actor may decide a pending request, or null. */
  function decidedAs(request, actor, member, pooled) {
    const a = request.approval || {};
    const decides = member && member.status !== 'removed' && roles.can(member.role, 'approval.decide');
    if (decides && a.approverId && actor.userId === a.approverId) return 'assigned';
    if (decides && pooled && a.pool) return 'pool';
    if (member && roles.can(member.role, 'approval.override')) return 'override';
    return null;
  }

  function hold(request, budget) {
    return budget ? { budgetId: budget.budgetId, periodKey: budget.periodKey, cents: request.totalCents } : null;
  }

  function transition(request, event, o) {
    const { now, actor, member = null, pooled = false, org } = o;
    if (!event || !EVENTS.includes(event.type)) throw new Error(`[fake] unknown event ${event && event.type}`);
    const from = request.status;
    if (TERMINAL.includes(from)) throw invalidTransition();
    if (event.type !== 'expire' && from === 'pending' && request.expiresAt && Date.parse(now) >= Date.parse(request.expiresAt)) {
      throw err('request_expired', 'This request expired. Ask the traveler to plan it again.', 409);
    }
    const isTraveler = !!actor && actor.userId === request.travelerId;
    const line = (action, to, extra = {}) => ({ at: now, by: actor, action, from, to, note: '', ...extra });
    const cleanNote = s => String(s ?? '').trim();
    switch (event.type) {
      case 'swap': {
        if (from !== 'draft') throw invalidTransition();
        if (!isTraveler) throw notFound();
        const alt = event.alternative;
        if (!alt || !(request.alternatives || []).some(a => a.id === alt.id)) throw err('alternative_gone', "That option isn't available anymore. Here are the current ones.", 410);
        return { next: { ...event.draft, updatedAt: now }, history: line('swapped', 'draft', { note: alt.label, savedCents: request.totalCents - event.draft.totalCents }), outcome: 'swapped' };
      }
      case 'submit': {
        if (from !== 'draft') throw invalidTransition();
        if (!isTraveler) throw notFound();
        if (o.recheck && o.recheck.status !== 'same') {
          if (!event.draft) throw new Error('[fake] a re-priced submit needs event.draft');
          return { next: { ...event.draft, updatedAt: now }, history: line('repriced', 'draft'), outcome: 'repriced' };
        }
        const ev = o.evaluation;
        if (ev.status === 'blocked') throw err('policy_blocked', "This trip can't be requested under your company's policy. Pick one of the options below.", 422);
        const evaluation = { ...ev, evaluatedAt: now };
        if (ev.status === 'within') {
          return {
            next: {
              status: 'approved', evaluation, reason: null, budget: hold(request, event.budget), submittedAt: now, expiresAt: null, updatedAt: now,
              approval: { mode: 'auto', approverId: null, pool: false, poolIds: [], rule: null, decidedBy: { system: 'policy' }, decidedAt: now, decidedAs: null, note: '', overBudgetAck: false },
            },
            history: { ...line('auto_approved', 'approved'), by: { system: 'policy' } },
            outcome: 'auto_approved',
          };
        }
        const text = cleanNote(event.reason && event.reason.text);
        if (text.length < org.settings.reasonMinChars || text.length > 500) throw err('reason_too_short', `Tell your approver why, in ${org.settings.reasonMinChars} to 500 characters.`, 422);
        if (cards.hasCardNumber(text)) throw err('card_number', cards.CARD_MESSAGE, 422);
        const category = event.reason.category ?? null;
        const ap = event.approver;
        if (!ap || ap.rule === null) throw err('no_approver', `No one else at ${org.name} can approve this yet, and nobody approves their own trip.`, 422);
        const exp = expiresAt(now, org.settings.approvalHours, request.query.departDate, org.timezone);
        if (Date.parse(exp) <= Date.parse(now)) throw err('too_late', 'This trip leaves too soon to wait for an approval.', 422);
        return {
          next: {
            status: 'pending', evaluation, reason: { text, category }, submittedAt: now, expiresAt: exp, returned: null, updatedAt: now,
            approval: { mode: 'manual', approverId: ap.approverId, pool: ap.pool, poolIds: [...ap.poolIds], rule: ap.rule, decidedBy: null, decidedAt: null, decidedAs: null, note: '', overBudgetAck: false },
          },
          history: line('submitted', 'pending'),
          outcome: 'submitted',
        };
      }
      case 'cancel': {
        if (!['draft', 'pending', 'approved'].includes(from)) throw invalidTransition();
        if (from === 'approved') {
          const beforeDeparture = tz.localDate(org.timezone, new Date(now)) < request.query.departDate;
          const override = !!member && roles.can(member.role, 'approval.override');
          if (!(isTraveler && beforeDeparture) && !override) throw isTraveler ? err('departed', 'This trip has already started.', 409) : notFound();
        } else if (!isTraveler) {
          throw notFound();
        }
        return { next: { status: 'cancelled', updatedAt: now }, history: line('cancelled', 'cancelled'), outcome: 'cancelled' };
      }
      case 'approve':
      case 'deny': {
        if (from !== 'pending') throw invalidTransition();
        if (isTraveler) throw err('self_approval', "You can't decide your own trip.", 422);
        const as = decidedAs(request, actor, member, pooled);
        if (!as) throw notFound();
        const note = cleanNote(event.note);
        if ((event.type === 'deny' || as === 'override') && note.length < 10) throw err('note_required', 'Add a note of at least 10 characters.', 422);
        if (cards.hasCardNumber(note)) throw err('card_number', cards.CARD_MESSAGE, 422);
        if (event.type === 'deny') {
          return {
            next: { status: 'denied', approval: { ...request.approval, decidedBy: actor, decidedAt: now, decidedAs: as, note }, updatedAt: now },
            history: line('denied', 'denied', { note }),
            outcome: 'denied',
          };
        }
        if (o.recheck && o.recheck.status !== 'same') {
          return {
            next: {
              ...(event.draft || {}), status: 'draft', approval: null, submittedAt: null, expiresAt: null, updatedAt: now,
              returned: { at: now, why: o.recheck.status === 'unavailable' ? 'unavailable' : 'price_changed', fromCents: request.totalCents, toCents: o.recheck.newTotalCents },
            },
            history: { ...line('returned', 'draft'), by: { system: 'policy' } },
            outcome: 'returned',
          };
        }
        const over = !!event.budget && request.totalCents > event.budget.remainingCents;
        if (over && !event.ackOverBudget) throw err('over_budget', 'Approving this goes over the budget. Tick the box to approve anyway.', 422);
        return {
          next: {
            status: 'approved', budget: hold(request, event.budget), updatedAt: now,
            evaluation: o.evaluation ? { ...o.evaluation, evaluatedAt: now } : request.evaluation,
            approval: { ...request.approval, decidedBy: actor, decidedAt: now, decidedAs: as, note, overBudgetAck: over },
          },
          history: line('approved', 'approved', { note }),
          outcome: 'approved',
        };
      }
      case 'expire': {
        if (from !== 'pending' || !request.expiresAt || Date.parse(now) < Date.parse(request.expiresAt)) throw invalidTransition();
        return { next: { status: 'expired', updatedAt: now }, history: { ...line('expired', 'expired'), by: { system: 'clock' } }, outcome: 'expired' };
      }
      case 'message': {
        if (!['draft', 'pending', 'approved'].includes(from)) throw invalidTransition();
        const a = request.approval || {};
        const allowed = isTraveler || (a.approverId && actor.userId === a.approverId) || (pooled && a.pool) || (!!member && roles.can(member.role, 'approval.override'));
        if (!allowed) throw notFound();
        const text = cleanNote(event.text);
        if (text.length < 2 || text.length > 1000) throw err('invalid_message', 'Write 2 to 1,000 characters.', 422);
        if (cards.hasCardNumber(text)) throw err('card_number', cards.CARD_MESSAGE, 422);
        if ((request.messages || []).length >= 50) throw err('too_many_messages', 'This request has reached 50 messages.', 409);
        return { next: { messages: [...(request.messages || []), { at: now, by: actor.userId, name: actor.name, text }], updatedAt: now }, history: null, outcome: 'message' };
      }
      default:
        throw new Error('[fake] unreachable');
    }
  }

  const engine = {
    normalizePolicy(form = {}, refs = {}) {
      const details = {};
      const minutes = Number(form.longHaulMinutes);
      if (!Number.isInteger(minutes) || minutes < 60 || minutes > 1200) details.longHaulMinutes = 'Enter a number of minutes from 60 to 1,200.';
      const raw = String(form['hotel.default'] ?? '').trim();
      const dollars = raw === '' ? null : Number(raw);
      if (dollars !== null && (!Number.isInteger(dollars) || dollars < 1)) details['hotel.default'] = 'Enter an amount in whole dollars, or leave it blank.';
      if (Object.keys(details).length) throw new AppError('invalid_policy', 'Check the highlighted fields.', 422, details);
      const rules = structuredClone(opts.baseRules);
      rules.flights.longHaulMinutes = minutes;
      rules.hotels.defaultNightlyCents = dollars === null ? null : dollars * 100;
      return rules;
    },
    formFromPolicy(rules) {
      return { longHaulMinutes: String(rules.flights.longHaulMinutes), 'hotel.default': rules.hotels.defaultNightlyCents == null ? '' : String(rules.hotels.defaultNightlyCents / 100) };
    },
    policyChanges(before, after) {
      const a = leaves(before), b = leaves(after);
      const paths = [...new Set([...a.keys(), ...b.keys()])];
      return paths.filter(p => JSON.stringify(a.get(p) ?? null) !== JSON.stringify(b.get(p) ?? null)).map(p => ({ path: p, before: a.get(p) ?? null, after: b.get(p) ?? null }));
    },
    benchmark: values => plainBenchmark(values),
    flightValues: rows => cheapestPerOffer(rows, r => r.totalCents),
    hotelValues: (rows, basis) => cheapestPerOffer(rows, r => (basis === 'excl_taxes' ? r.nightlyCents : r.nightlyInclCents)),
    flightCap: (rules, row, benchmark) => ({ cents: opts.flightCapCents, source: 'fixed', haul: row.flyingMinutes >= opts.longHaulMinutes ? 'long' : 'short', medianCents: benchmark ? benchmark.medianCents : null }),
    hotelCap: () => ({ cents: opts.hotelCapCents, source: 'default', basis: 'incl_taxes' }),
    evaluateComponent,
    evaluateTrip,
    // min(cap, median) when both exist, else whichever exists, else null (evaluate.priceToBeat).
    priceToBeat: (capCents, hotelBenchmark) => {
      const median = hotelBenchmark && hotelBenchmark.medianCents != null ? hotelBenchmark.medianCents : null;
      if (capCents == null) return median;
      return median == null ? capCents : Math.min(capCents, median);
    },
    describe(rules, { tier, version, orgName, carriers = {} }) {
      return {
        title: 'Your travel policy',
        sub: `${TIER_LABELS[tier]} policy, version ${version}`,
        lines: [
          `Flights: ${CABIN_LABELS[opts.maxCabin]}, up to ${format(opts.flightCapCents)} each way.`,
          `Hotels: up to ${format(opts.hotelCapCents)} a night, taxes included.`,
          ...(opts.maxStars != null ? [`Up to ${opts.maxStars}-star hotels.`] : []),
          ...opts.blockedCarriers.map(code => `${carriers[code] || code} isn't used by ${orgName}.`),
        ],
      };
    },
    limitsBar(rules, ctx, search) {
      return {
        heading: `Your limits for this search (${TIER_LABELS[ctx.policy.tier]} policy, v${ctx.policy.version})`,
        items: [
          { key: 'flight', text: `Flights: ${CABIN_LABELS[opts.maxCabin]}, up to`, cents: opts.flightCapCents, suffix: 'each way' },
          ...(search && search.legs && search.legs.hotel ? [{ key: 'hotel', text: 'Hotels: up to', cents: opts.hotelCapCents, suffix: 'a night, taxes included' }] : []),
        ],
      };
    },
    resolveApprover,
    transition,
    effectiveStatus,
    expiresAt,
  };
  const out = { calls, opts, configure(next) { Object.assign(opts, next); return out; } };
  for (const [name, fn] of Object.entries(engine)) out[name] = counted(name, fn);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// fakeAlternatives and fakeExplainer

/** Labels per kind, as alternatives.js words them (no digits, no currency signs). */
const ALT_LABELS = Object.freeze({
  fare: 'Same flight, cheaper fare', flight: 'Another flight the same day', stops: 'A flight with one stop', cabin: 'A lower cabin',
  dates: 'Move the trip by a day', room: 'Smaller room, same hotel', hotel: 'Another hotel in the same city', all_within: 'Cheapest trip inside your policy',
});
const CHEAPEST_WITHIN = 'Cheapest option inside your policy';

const altId = (selection, query) => crypto.createHash('sha256')
  .update(JSON.stringify([selection.out, selection.back, selection.hotel, query.departDate, query.returnDate]))
  .digest('hex').slice(0, 16);

/**
 * A fake AlternativesEngine. buildAlternatives keeps available, not blocked candidates saving at least
 * $1, ranks within policy first, then savesCents, then id; at most 5; cheapestWithin pinned first.
 * giveUps are always [] and notes ''. compareTrips lists the components whose row key differs.
 * `calls` counts both methods; `inputs` keeps every buildAlternatives input.
 * @returns {import('../server/business/types').AlternativesEngine & { calls: Record<string, number>, inputs: object[] }}
 */
function fakeAlternatives() {
  const calls = { buildAlternatives: 0, compareTrips: 0 };
  const inputs = [];
  return {
    calls,
    inputs,
    buildAlternatives(input) {
      calls.buildAlternatives += 1;
      inputs.push(input);
      const seen = new Set();
      const all = [];
      for (const v of input.candidates) {
        const parts = ['out', 'back', 'hotel'].filter(c => v.rows[c]);
        if (parts.some(c => !v.rows[c].available)) continue;
        const savesCents = input.pick.totalCents - v.totalCents;
        if (savesCents < 100) continue;
        const evaluation = input.evaluate(v);
        if (evaluation.status === 'blocked') continue;
        const id = altId(v.selection, v.query);
        if (seen.has(id)) continue;
        seen.add(id);
        all.push({
          id, kind: v.change.kind, label: ALT_LABELS[v.change.kind], change: structuredClone(v.change), selection: { ...v.selection },
          query: structuredClone(v.query), rows: v.rows, totalCents: v.totalCents, savesCents, evaluation, giveUps: [], note: '',
        });
      }
      const within = all.filter(a => a.evaluation.status === 'within').sort((a, b) => a.totalCents - b.totalCents || (a.id < b.id ? -1 : 1));
      const cheapestWithin = within.length ? { ...within[0], label: CHEAPEST_WITHIN } : null;
      const ranked = all
        .filter(a => !cheapestWithin || a.id !== cheapestWithin.id)
        .sort((a, b) => STATUS_RANK[a.evaluation.status] - STATUS_RANK[b.evaluation.status] || b.savesCents - a.savesCents || (a.id < b.id ? -1 : 1));
      const alternatives = [...(cheapestWithin ? [cheapestWithin] : []), ...ranked].slice(0, 5);
      return { alternatives, cheapestWithin, noneWithin: !cheapestWithin, truncated: !!input.truncated };
    },
    compareTrips(a, b) {
      calls.compareTrips += 1;
      const text = r => (!r ? null : r.kind === 'flight' ? `${r.carrier.name} ${r.flightNumbers.join(', ')}, ${r.cabinLabel}, ${r.fare.name}` : `${r.name}, ${r.room.name}`);
      const labels = { out: 'Outbound flight', back: 'Return flight', hotel: 'Hotel' };
      const rows = ['out', 'back', 'hotel']
        .filter(c => (a.rows[c] && a.rows[c].key) !== (b.rows[c] && b.rows[c].key))
        .map(c => ({ label: labels[c], a: text(a.rows[c]), b: text(b.rows[c]) }));
      return { rows, totalCents: { a: a.totalCents, b: b.totalCents, delta: b.totalCents - a.totalCents } };
    },
  };
}

/** Notes per kind: plain words, no digits or currency. */
const NOTES = Object.freeze({
  fare: 'Same flight with a simpler fare.', flight: 'A different flight on the same day.', stops: 'Adds a stop to save on the fare.',
  cabin: 'A lower cabin on the same route.', dates: 'The same trip on nearby dates.', room: 'A smaller room in the same hotel.',
  hotel: 'Another hotel in the same city.', all_within: 'Every part of the trip inside your policy.',
});

/**
 * A fake GuardedExplainer: keeps the input order, one note per alternative, a fixed summary. Never rejects.
 * `inputs` keeps a copy of every input (to prove no prices or names reach an explainer).
 * @returns {import('../server/business/types').GuardedExplainer & { inputs: object[] }}
 */
function fakeExplainer() {
  const inputs = [];
  return {
    name: 'rules',
    inputs,
    async explain(input) {
      inputs.push(structuredClone(input));
      const alts = input.alternatives || [];
      return {
        order: alts.map(a => a.id),
        notes: Object.fromEntries(alts.map(a => [a.id, NOTES[a.kind] || ''])),
        summary: input.noneWithin
          ? 'No cheaper option inside your policy turned up in this search. You can still request approval with a reason.'
          : 'These options keep your route and cost less.',
      };
    },
  };
}

module.exports = {
  fakeInventory, overrideProvider, fakeComposer, fakePolicy, fakeAlternatives, fakeExplainer,
  FAKE_AIRPORTS, FAKE_CARRIERS, ITINERARIES, FARES, HOTELS, ROOMS, ROUTE_MINUTES, ROUTE_FARE_CENTS, FLIGHT_TAX_CENTS, CITY_NIGHTLY_CENTS,
  HOTEL_TAX_PERCENT, plainBenchmark,
};
