// Stage 1I (plan §F3, §F4, §G1): the search form, the trip composer (search, price, variants) and the price
// recheck, on Business's own demo inventory and on contract-shaped overrides. Search writes nothing, ever.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTripQuery, TripComposer, MAX_PRICED_PER_LEG, MAX_SEARCHES, MAX_DAYS_AHEAD, MAX_TRIP_DAYS, NIGHTS_RANGE, FLEX_DAYS } = require('../server/business/search');
const { recheck } = require('../server/business/recheck');
const { createBusinessInventory } = require('../server/business/inventory');
const { BusinessDemoFlights, FARE_TERMS } = require('../server/business/demo/flights');
const { BusinessDemoHotels } = require('../server/business/demo/hotels');
const { BUSINESS_HOTELS, BUSINESS_CITIES } = require('../server/business/demo/hotels-data');
const dto = require('../server/business/dto');
const { CABIN_RANK, CABINS } = require('../server/business/constants');
const { addDays, daysBetween } = require('../server/lib/dates');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { overrideProvider } = require('./business-fakes');
const { storeSnapshot } = require('./business-helpers');
const { startApp } = require('./helpers');

const NOW = new Date('2026-10-09T09:00:00.000Z');
const PRICED_AT = NOW.toISOString();
const TODAY = '2026-10-09';
const now = () => NOW;
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const RAW = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });

const demoInventory = () => createBusinessInventory({ business: { demoInventory: true } });
const demoComposer = () => new TripComposer({ inventory: demoInventory(), now });
/** A composer over contract-shaped overrides of the real demo providers (counters in .calls). */
function overrideComposer({ flights = new BusinessDemoFlights(), hotels = new BusinessDemoHotels() } = {}) {
  const f = overrideProvider(flights), h = overrideProvider(hotels);
  const inventory = createBusinessInventory({ business: { demoInventory: false } }, { overrides: { flights: f, hotels: h } });
  return { composer: new TripComposer({ inventory, now }), flights: f, hotels: h, inventory };
}
const parse = (raw, today = TODAY) => demoComposer().parseQuery(raw, { today });
const rejects = (fn, code, status) => assert.rejects(fn, e => e.code === code && e.status === status);
const total = rows => ['out', 'back', 'hotel'].reduce((n, c) => n + (rows[c] ? rows[c].totalCents : 0), 0);
/** Plan §E2, written out again from the plan for the test. */
function referenceBenchmark(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (n < 3) return { medianCents: null, sampleSize: n, excluded: [] };
  let kept = a, excluded = [];
  if (n >= 4) {
    const q1 = a[Math.floor((n - 1) * 0.25)], q3 = a[Math.ceil((n - 1) * 0.75)], f = Math.floor(3 * (q3 - q1) / 2);
    kept = a.filter(v => v >= q1 - f && v <= q3 + f);
    excluded = a.filter(v => v < q1 - f || v > q3 + f);
  }
  const m = kept.length;
  return { medianCents: m % 2 ? kept[(m - 1) / 2] : Math.floor((kept[m / 2 - 1] + kept[m / 2]) / 2), sampleSize: m, excluded };
}
const perOffer = (rows, pick) => {
  const best = new Map();
  for (const r of rows) if (r.available && (!best.has(r.offerId) || pick(r) < best.get(r.offerId))) best.set(r.offerId, pick(r));
  return [...best.values()];
};

// ---------------------------------------------------------------------------------------------------------
// The search form

test('parseTripQuery: a return trip with a hotel', () => {
  assert.deepEqual(parse(RAW), {
    from: 'CAI', to: 'LHR', departDate: '2026-11-12', returnDate: '2026-11-16', cabin: 'economy', passengers: 1, datesFlexible: false,
    hotel: { city: 'London', country: 'United Kingdom', checkIn: '2026-11-12', checkOut: '2026-11-16' },
  });
  assert.deepEqual(parse({ from: ' cai ', to: 'dbb', depart: '2026-11-12', hotel: 'on', nights: '3', cabin: 'business', flex: '1' }), {
    from: 'CAI', to: 'DBB', departDate: '2026-11-12', returnDate: null, cabin: 'business', passengers: 1, datesFlexible: true,
    hotel: { city: 'New Alamein', country: 'Egypt', checkIn: '2026-11-12', checkOut: '2026-11-15' },
  });
  assert.equal(parse({ from: 'CAI', to: 'HRG', depart: '2026-11-12', hotel: '1' }).hotel.checkOut, '2026-11-13', 'blank nights is 1');
  assert.deepEqual(parse({ from: 'LHR', to: 'CAI', depart: '2026-11-12' }).hotel, null);
  assert.equal(parse({ from: 'LHR', to: 'CAI', depart: '2026-11-12', cabin: '' }).cabin, 'economy');
  assert.equal(parse({ ...RAW, flex: '0' }).datesFlexible, false);
  assert.equal(parse({ ...RAW, hotel: '0' }).hotel, null);
  assert.equal(parse({ ...RAW, extra: 'x', out: 'f.flt_x|A' }).from, 'CAI', 'unknown fields are ignored');
});

test('parseTripQuery: 422 with an error for every bad field, keyed by the form field', () => {
  const details = raw => {
    try { parse(raw); } catch (e) {
      assert.equal(e.code, 'invalid_query');
      assert.equal(e.status, 422);
      assert.equal(e.message, 'Check the highlighted fields.');
      return e.details;
    }
    assert.fail('no error');
  };
  assert.deepEqual(details({}), {
    from: 'Choose an airport from the list.', to: 'Choose an airport from the list.',
    depart: `Choose a date from today up to ${MAX_DAYS_AHEAD} days ahead.`,
  });
  assert.deepEqual(details({ from: 'CAI', to: 'CAI', depart: '2026-11-12', return: '2026-11-12', cabin: 'first' }), {
    to: 'Choose a destination other than where you leave from.',
    return: `Choose a return date after you leave, up to ${MAX_TRIP_DAYS} days later.`,
    cabin: 'Choose a cabin.',
  });
  assert.deepEqual(Object.keys(details({ from: 'XXX', to: 'LHR', depart: '2026-11-12' })), ['from']);
  assert.deepEqual(Object.keys(details({ from: 'CAI', to: 'LHR', depart: '2026-13-01' })), ['depart']);
  assert.deepEqual(Object.keys(details({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: 'soon' })), ['return']);
  assert.deepEqual(Object.keys(details({ from: ['CAI', 'DXB'], to: 'LHR', depart: '2026-11-12' })), ['from'], 'a repeated field');
  assert.deepEqual(Object.keys(details({ from: 'CAI', to: 'LHR', depart: ['2026-11-12'] })), ['depart']);
  // The checkboxes too: a repeated hotel or flex box is an error, never a silent "unticked".
  assert.deepEqual(details({ ...RAW, hotel: ['1', '1'] }), { hotel: 'Choose whether you need a hotel.' });
  assert.deepEqual(details({ ...RAW, flex: ['1', '1'] }), { flex: 'Choose whether your dates can move.' });
  assert.deepEqual(Object.keys(details({ ...RAW, from: 'XXX', hotel: ['1'], flex: [] })).sort(), ['flex', 'from', 'hotel']);
  for (const nights of ['0', '15', '2.5', 'abc', '-1', '007']) {
    assert.deepEqual(details({ from: 'CAI', to: 'LHR', depart: '2026-11-12', hotel: '1', nights }), { nights: `Choose ${NIGHTS_RANGE[0]} to ${NIGHTS_RANGE[1]} nights.` }, nights);
  }
  assert.equal(parse({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-14', hotel: '1', nights: 'abc' }).hotel.checkOut, '2026-11-14', 'nights only count one way');
  const all = Object.values(details({ from: 'X', to: 'X', depart: 'x', return: 'y', cabin: 'z' })).join(' ');
  assert.doesNotMatch(all, /—/);
  assert.doesNotMatch(all, PRESSURE);
});

test('parseTripQuery: departure from today (the company\'s date) to 330 days ahead, return within 30 days', () => {
  assert.equal(parse({ from: 'CAI', to: 'LHR', depart: TODAY }).departDate, TODAY);
  assert.throws(() => parse({ from: 'CAI', to: 'LHR', depart: addDays(TODAY, -1) }), e => Object.keys(e.details).join() === 'depart');
  assert.equal(parse({ from: 'CAI', to: 'LHR', depart: addDays(TODAY, MAX_DAYS_AHEAD) }).departDate, addDays(TODAY, 330));
  assert.throws(() => parse({ from: 'CAI', to: 'LHR', depart: addDays(TODAY, MAX_DAYS_AHEAD + 1) }), e => Object.keys(e.details).join() === 'depart');
  assert.equal(parse({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: addDays('2026-11-12', MAX_TRIP_DAYS) }).returnDate, '2026-12-12');
  assert.throws(() => parse({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: addDays('2026-11-12', MAX_TRIP_DAYS + 1) }), e => Object.keys(e.details).join() === 'return');
  // A company in Cairo at 00:30 on the 10th (still the 9th in UTC) can leave on the 10th: today is the caller's.
  assert.equal(parse({ from: 'CAI', to: 'LHR', depart: '2026-10-10' }, '2026-10-10').departDate, '2026-10-10');
  assert.throws(() => parse({ from: 'CAI', to: 'LHR', depart: '2026-10-09' }, '2026-10-10'), e => e.code === 'invalid_query');
  assert.throws(() => parseTripQuery(RAW, { today: '9 Oct', airports: [] }), /today/);
  assert.throws(() => parseTripQuery(RAW, { today: TODAY, airports: [] }), e => Boolean(e.details.from && e.details.to), 'no airports, no search');
  // With no supplier there is no airport list to check against: "Supplier not connected yet", not field errors.
  const none = new TripComposer({ inventory: createBusinessInventory({ business: { demoInventory: false } }), now });
  for (const raw of [RAW, {}]) {
    assert.throws(() => none.parseQuery(raw, { today: TODAY }), e => e.code === 'no_supplier' && e.status === 503 && /^Supplier not connected yet\./.test(e.message));
  }
  assert.throws(() => new TripComposer({}).parseQuery(RAW, { today: TODAY }), e => e.code === 'no_supplier');
});

// ---------------------------------------------------------------------------------------------------------
// search

test('search: every leg, every available option priced with a quote, sorted, with the benchmarks of the search', async () => {
  const { composer, flights, hotels } = overrideComposer();
  const query = parse(RAW);
  const r = await composer.search(query);
  assert.equal(r.status, 'demo');
  assert.equal(r.pricedAt, PRICED_AT);
  assert.deepEqual(r.query, query, 'nothing moved: CAI to LHR lands the same day');
  assert.notEqual(r.query, query, 'a copy');
  assert.equal(flights.calls.search, 2);
  assert.equal(hotels.calls.search, 1);
  const legs = [['out', 'CAI', 'LHR', '2026-11-12'], ['back', 'LHR', 'CAI', '2026-11-16']];
  let available = 0;
  for (const [leg, from, to, date] of legs) {
    const { rows, benchmark, truncated } = r.legs[leg];
    assert.equal(truncated, false);
    assert.ok(rows.length >= 6);
    for (const row of rows) {
      dto.assertRow(row);
      assert.equal(row.leg, leg);
      assert.equal(row.segments[0].from.code, from);
      assert.equal(row.segments.at(-1).to.code, to);
      assert.equal(row.segments[0].departLocal.slice(0, 10), date);
      assert.equal(row.cabin, 'economy');
      assert.equal(row.pricedAt, PRICED_AT);
    }
    const seen = rows.map(x => [x.available ? 0 : 1, x.totalCents ?? 0]);
    assert.deepEqual(seen, [...seen].sort((a, b) => a[0] - b[0] || a[1] - b[1]), 'available first, then cheapest');
    assert.deepEqual(benchmark, referenceBenchmark(perOffer(rows, x => x.totalCents)));
    assert.ok(benchmark.medianCents > 0);
    available += rows.filter(x => x.available).length;
  }
  const h = r.legs.hotel;
  assert.deepEqual([...new Set(h.rows.map(x => x.offerId))].sort(), ['htl_LN-ALDERMOOR', 'htl_LN-KESTREL', 'htl_LN-LARKSPUR'], 'London only');
  assert.ok(h.rows.every(x => x.checkIn === '2026-11-12' && x.checkOut === '2026-11-16' && x.nights === 4 && x.city === 'London'));
  assert.deepEqual(h.benchmark, {
    incl_taxes: referenceBenchmark(perOffer(h.rows, x => x.nightlyInclCents)),
    excl_taxes: referenceBenchmark(perOffer(h.rows, x => x.nightlyCents)),
  });
  available += h.rows.filter(x => x.available).length;
  assert.equal(flights.calls.quote + hotels.calls.quote, available, 'one quote per available option, none for the rest');
});

test('search: the benchmarks agree with policy/benchmark.js once it is built', async t => {
  const bench = require('../server/business/policy/benchmark');
  try { bench.benchmark([1, 2, 3]); } catch (e) {
    if (/not built/.test(e.message)) return t.skip('policy/benchmark.js is still a stub in this worktree');
    throw e;
  }
  const r = await demoComposer().search(parse({ ...RAW, cabin: 'business' }));
  for (const leg of ['out', 'back']) assert.deepEqual(r.legs[leg].benchmark, bench.benchmark(bench.flightValues(r.legs[leg].rows)));
  for (const basis of ['incl_taxes', 'excl_taxes']) assert.deepEqual(r.legs.hotel.benchmark[basis], bench.benchmark(bench.hotelValues(r.legs.hotel.rows, basis)));
  for (const values of [[], [5], [5, 6], [100, 110, 120], [300, 310, 320, 330, 2000], [100, 110, 120, 130, 1000], [7, 7, 7, 7], [1, 2, 3, 4]]) {
    assert.deepEqual(referenceBenchmark(values), bench.benchmark(values), JSON.stringify(values));
  }
});

/** Only the itineraries that land on a later local date than they leave (an all-overnight schedule). */
class OvernightOnly extends BusinessDemoFlights {
  buildOffers(query, opts) {
    return super.buildOffers(query, opts).filter(o => o.details.segments.at(-1).arriveAt.slice(0, 10) > query.departDate);
  }
}

test('search: the hotel check-in moves to the arrival date when every flight lands the next day', async () => {
  const { composer } = overrideComposer({ flights: new OvernightOnly() });
  const oneWay = await composer.search(parse({ from: 'LHR', to: 'DXB', depart: '2026-11-12', hotel: '1', nights: '3' }));
  assert.ok(oneWay.legs.out.rows.some(x => x.available));
  assert.deepEqual(oneWay.query.hotel, { city: 'Dubai', country: 'United Arab Emirates', checkIn: '2026-11-13', checkOut: '2026-11-16' }, 'one way: the nights are kept');
  assert.ok(oneWay.legs.hotel.rows.every(x => x.checkIn === '2026-11-13' && x.nights === 3));
  const ret = await composer.search(parse({ from: 'LHR', to: 'DXB', depart: '2026-11-12', return: '2026-11-16', hotel: '1' }));
  assert.deepEqual([ret.query.hotel.checkIn, ret.query.hotel.checkOut], ['2026-11-13', '2026-11-16'], 'with a return, check-out stays the return date');
  assert.ok(ret.legs.hotel.rows.every(x => x.nights === 3));
  const short = await composer.search(parse({ from: 'LHR', to: 'DXB', depart: '2026-11-12', return: '2026-11-13', hotel: '1' }));
  assert.deepEqual([short.query.hotel.checkIn, short.query.hotel.checkOut], ['2026-11-12', '2026-11-13'], 'never down to no night');
  const again = await composer.search(oneWay.query);
  assert.deepEqual(again.query, oneWay.query, 'searching the moved query again moves nothing');
  const mixed = await demoComposer().search(parse({ from: 'LHR', to: 'DXB', depart: '2026-11-12', hotel: '1', nights: '3' }));
  assert.equal(mixed.query.hotel.checkIn, '2026-11-12', 'some flights land the same day: no move');
});

test('search: a leg with more than 60 options prices 60 and says it was cut', async () => {
  const london = BUSINESS_HOTELS.filter(h => h.city === 'London');
  const many = [];
  for (let i = 0; i < 25; i++) for (const h of london) many.push({ ...h, hotel_code: `${h.hotel_code}${i}`, name: `${h.name} ${i}` });
  const { composer, hotels } = overrideComposer({ hotels: new BusinessDemoHotels({ hotels: many }) });
  const r = await composer.search(parse(RAW));
  assert.equal(r.legs.hotel.truncated, true);
  assert.equal(hotels.calls.quote, MAX_PRICED_PER_LEG);
  assert.equal(r.legs.hotel.rows.filter(x => x.available).length, MAX_PRICED_PER_LEG);
  assert.equal(r.legs.out.truncated, false);
});

test('search: a row priced in another currency is left out and counted; pricing one still answers 422', async () => {
  // Real-suppliers design §3.5, §8.6 item 3: search drops and counts (leg.skipped), price/recheck keep the 422.
  class Euros extends BusinessDemoHotels {
    async quote(input) { return { ...(await super.quote(input)), currency: 'EUR' }; }
  }
  const { composer } = overrideComposer({ hotels: new Euros() });
  const r = await composer.search(parse(RAW));
  assert.equal(r.legs.hotel.rows.filter(x => x.available).length, 0, 'no EUR row is shown');
  assert.ok(r.legs.hotel.skipped.otherCurrency > 0);
  assert.deepEqual(r.legs.hotel.skipped.currencies, ['EUR']);
  assert.ok(r.legs.out.rows.length > 0 && !('skipped' in r.legs.out), 'the USD legs are untouched and carry no skipped');
  const demo = await demoComposer().search(parse(RAW));
  const room = demo.legs.hotel.rows.find(x => x.available);
  const selection = { out: r.legs.out.rows.find(x => x.available).key, back: r.legs.back.rows.find(x => x.available).key, hotel: room.key };
  await assert.rejects(composer.price(selection, r.query), e => e.code === 'unsupported_currency' && e.status === 422 && e.message === 'Priced in another currency, not supported yet.');
});

test('search: an unavailable option is a row with the flag and no price, and is never quoted', async () => {
  const base = await demoComposer().search(parse(RAW));
  const target = base.legs.out.rows.find(x => x.available && x.optionId === 'CLASSIC');
  const { composer, flights } = overrideComposer();
  flights.setUnavailable(target.offerId, target.optionId);
  const r = await composer.search(parse(RAW));
  const gone = r.legs.out.rows.find(x => x.key === target.key);
  assert.equal(gone.available, false);
  assert.equal(gone.totalCents, null);
  assert.deepEqual(gone.lines, []);
  assert.equal(r.legs.out.rows.at(-1).available, false, 'unavailable rows sort last');
  const priced = r.legs.out.rows.filter(x => x.available).length + r.legs.back.rows.filter(x => x.available).length;
  assert.equal(flights.calls.quote, priced);
  const p = await composer.price({ out: target.key, back: r.legs.back.rows[0].key, hotel: null }, r.query);
  assert.deepEqual(p.unavailable, ['out']);
  assert.equal(p.totalCents, null);
  assert.equal(p.rows.out.available, false);
});

test('search: a hotel whose every room is sold out for the stay shows as unavailable rows, never disappears', async () => {
  // Find a stay (the demo provider decides availability per room and night) where one Business hotel has no
  // room left at all, and keep the city's other hotels to compare.
  const provider = new BusinessDemoHotels();
  let found = null;
  for (let d = 0; d < 120 && !found; d++) {
    const checkIn = addDays(TODAY, d), checkOut = addDays(checkIn, 4);
    for (const h of BUSINESS_HOTELS) {
      const offer = await provider.getOffer(`htl_${h.hotel_code}`, { where: h.city, checkIn, checkOut, guests: 1 });
      if (offer.options.every(o => !o.available)) { found = { h, checkIn }; break; }
    }
  }
  assert.ok(found, 'some stay has a fully sold-out demo hotel');
  const { h, checkIn } = found;
  const offers = await provider.search({ where: h.city, checkIn, checkOut: addDays(checkIn, 4), guests: 1 });
  assert.ok(offers.some(o => o.id === `htl_${h.hotel_code}`), 'the provider still offers it');
  const to = BUSINESS_CITIES.find(c => c.city === h.city).iata;
  const from = to === 'CAI' ? 'DXB' : 'CAI';
  const { composer, hotels } = overrideComposer();
  const r = await composer.search(parse({ from, to, depart: checkIn, hotel: '1', nights: '4' }));
  assert.equal(r.query.hotel.checkIn, checkIn);
  const mine = r.legs.hotel.rows.filter(x => x.offerId === `htl_${h.hotel_code}`);
  assert.deepEqual(mine.map(x => x.optionId).sort(), h.rooms.map(x => x.code).sort(), 'every room is a row');
  for (const row of mine) {
    assert.equal(row.available, false);
    assert.equal(row.totalCents, null);
    assert.equal(row.nightlyCents, null);
    assert.deepEqual(row.lines, []);
  }
  assert.equal(hotels.calls.quote, r.legs.hotel.rows.filter(x => x.available).length, 'sold-out rooms are never quoted');
  assert.equal(r.legs.hotel.rows.at(-1).available, false, 'unavailable rows sort last');
  assert.deepEqual(r.legs.hotel.benchmark.incl_taxes, referenceBenchmark(perOffer(r.legs.hotel.rows, x => x.nightlyInclCents)), 'the benchmark counts available rooms only');
});

// ---------------------------------------------------------------------------------------------------------
// price

test('price: the same rows as the search, priced again from the provider, never from the form', async () => {
  const { composer, flights, hotels } = overrideComposer();
  const r = await composer.search(parse(RAW));
  const pick = { out: r.legs.out.rows[2], back: r.legs.back.rows[0], hotel: r.legs.hotel.rows.find(x => x.available && x.stars === 4) };
  const quotes = flights.calls.quote + hotels.calls.quote;
  const p = await composer.price({ out: pick.out.key, back: pick.back.key, hotel: pick.hotel.key, totalCents: 1, price: 1 }, r.query);
  assert.equal(flights.calls.quote + hotels.calls.quote - quotes, 3, 'one quote per component');
  assert.deepEqual(p.rows, pick);
  assert.equal(p.totalCents, total(pick));
  assert.deepEqual(p.unavailable, []);
  assert.equal(p.pricedAt, PRICED_AT);
  const oneWay = await composer.price({ out: pick.out.key, back: '', hotel: null }, { ...r.query, returnDate: null, hotel: null });
  assert.equal(oneWay.rows.back, null);
  assert.equal(oneWay.totalCents, pick.out.totalCents);
});

test('price: 422 invalid_selection for keys that are malformed, on the wrong leg, from another search or above the cabin', async () => {
  const composer = demoComposer();
  const r = await composer.search(parse(RAW));
  const out = r.legs.out.rows[0].key, back = r.legs.back.rows[0].key, hotel = r.legs.hotel.rows[0].key;
  const q = r.query;
  const paris = (await composer.search(parse({ from: 'CAI', to: 'CDG', depart: '2026-11-12', hotel: '1', nights: '4' }))).legs.hotel.rows[0].key;
  const dxb = (await composer.search(parse({ from: 'CAI', to: 'DXB', depart: '2026-11-12' }))).legs.out.rows[0].key;
  const otherDay = (await composer.search(parse({ from: 'CAI', to: 'LHR', depart: '2026-11-13' }))).legs.out.rows[0].key;
  const business = (await composer.search(parse({ from: 'CAI', to: 'LHR', depart: '2026-11-12', cabin: 'business' }))).legs.out.rows[0].key;
  const bad = [
    [{ out: 'f.nope', back, hotel }, 'That option key is not valid.'],
    [{ out: null, back, hotel }, 'Choose an outbound flight.'],
    [null, 'Choose an outbound flight.'],
    [{ out: hotel, back, hotel }, 'That option belongs to another part of the trip.'],
    [{ out, back, hotel: out }, 'That option belongs to another part of the trip.'],
    [{ out, back: null, hotel }, 'Choose a return flight for a return trip, and none one way.'],
    [{ out, back: ['x'], hotel }, 'That option key is not valid.'],
    [{ out, back, hotel: paris }, "That option isn't part of this search."],
    [{ out: dxb, back, hotel }, "That option isn't part of this search."],
    [{ out: otherDay, back, hotel }, "That option isn't part of this search."],
    [{ out: back, back: out, hotel }, "That option isn't part of this search."],
    [{ out: business, back, hotel }, "That option isn't part of this search."],
    [{ out: 'f.flt_ZM101_2026-11-12_economy|LIGHT', back, hotel }, "That option isn't part of this search."],
    [{ out, back, hotel: 'h.htl_LN-KESTREL|NOPE' }, "That option isn't part of this search."],
  ];
  for (const [selection, message] of bad) {
    await assert.rejects(composer.price(selection, q), e => e.code === 'invalid_selection' && e.status === 422 && e.message === message, JSON.stringify(selection));
  }
  await assert.rejects(composer.price({ out, back: null, hotel }, { ...q, returnDate: null, hotel: null }), e => e.message === 'This search has no hotel.');
  await assert.rejects(composer.price({ out, back, hotel }, { ...q, cabin: 'first' }), TypeError);
  // A lower cabin than the one searched is a cabin alternative, and prices.
  const bq = parse({ ...RAW, cabin: 'business' });
  const p = await composer.price({ out, back: (await composer.search(bq)).legs.back.rows[0].key, hotel }, bq);
  assert.equal(p.rows.out.cabin, 'economy');
  assert.equal(p.rows.back.cabin, 'business');
});

// ---------------------------------------------------------------------------------------------------------
// recheck

test('recheck: same, changed and unavailable through contract-shaped overrides of the real inventory', async () => {
  const { composer, flights, hotels } = overrideComposer();
  const r = await composer.search(parse(RAW));
  const out = r.legs.out.rows.find(x => x.available && x.optionId === 'CLASSIC');
  const hotel = r.legs.hotel.rows.find(x => x.available && x.stars === 4);
  const selection = { out: out.key, back: r.legs.back.rows[0].key, hotel: hotel.key };
  const priced = await composer.price(selection, r.query);
  const request = Object.freeze({ selection, query: r.query, rows: priced.rows, totalCents: priced.totalCents });

  const same = await composer.recheck(request);
  assert.equal(same.status, 'same');
  assert.equal(same.newTotalCents, priced.totalCents);
  assert.equal(same.at, PRICED_AT);
  for (const c of ['out', 'back', 'hotel']) {
    assert.equal(same.components[c].status, 'same');
    assert.equal(same.components[c].wasCents, priced.rows[c].totalCents);
    assert.equal(same.components[c].nowCents, priced.rows[c].totalCents);
  }

  hotels.setPrice(hotel.offerId, hotel.optionId, 2900);
  const changed = await recheck(composer, request);
  assert.equal(changed.status, 'changed');
  assert.equal(changed.components.hotel.status, 'changed');
  assert.equal(changed.components.hotel.nowCents, hotel.totalCents + 2900);
  assert.equal(changed.components.out.status, 'same');
  assert.equal(changed.newTotalCents, priced.totalCents + 2900);
  dto.assertRow(changed.components.hotel.row);

  hotels.clearOverrides();
  flights.setUnavailable(out.offerId, out.optionId);
  const unavailable = await composer.recheck(request);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.components.out.status, 'unavailable');
  assert.equal(unavailable.components.out.nowCents, null);
  assert.equal(unavailable.components.out.row.available, false);
  assert.equal(unavailable.components.hotel.status, 'same');
  assert.equal(unavailable.newTotalCents, null);

  flights.clearOverrides();
  hotels.setPrice(hotel.offerId, hotel.optionId, -500);
  flights.setUnavailable(out.offerId, out.optionId);
  assert.equal((await composer.recheck(request)).status, 'unavailable', 'unavailable outranks changed');
  flights.clearOverrides();
  hotels.clearOverrides();
  assert.equal((await composer.recheck(request)).status, 'same');
});

test('recheck: an option gone from the inventory altogether is unavailable, not an error', async () => {
  const composer = demoComposer();
  const r = await composer.search(parse(RAW));
  const was = structuredClone(r.legs.out.rows[0]);
  was.offerId = 'flt_ZM101-ZM999_2026-11-12_economy';
  was.key = dto.rowKey('flight', was.offerId, was.optionId);
  const back = r.legs.back.rows[0];
  const request = { selection: { out: was.key, back: back.key, hotel: null }, query: r.query, rows: { out: was, back, hotel: null } };
  const res = await composer.recheck(request);
  assert.equal(res.status, 'unavailable');
  assert.deepEqual(res.components.out.row, { ...was, lines: [], totalCents: null, available: false, pricedAt: PRICED_AT });
  assert.equal(res.components.out.wasCents, was.totalCents);
  assert.equal(res.components.back.status, 'same');
  assert.equal(res.components.hotel, null);
  await assert.rejects(composer.price(request.selection, request.query), e => e.code === 'invalid_selection', 'price() alone still refuses it');
});

/** Demo flights whose Flex quote can turn to Light's terms at the same price (a supplier changing its terms). */
class TermsFlights extends BusinessDemoFlights {
  async quote(input) {
    const q = await super.quote(input);
    return this.lightTerms && input.optionId === 'FLEX' ? { ...q, cancellation: { ...FARE_TERMS.LIGHT } } : q;
  }
}
/** Demo hotels whose rooms can turn non-refundable at the same price. */
class TermsHotels extends BusinessDemoHotels {
  async quote(input) {
    const q = await super.quote(input);
    return this.strict ? { ...q, cancellation: { type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: 'Non-refundable.' } } : q;
  }
}

test('recheck: new refund or change terms at the same price are "changed", not "same"', async () => {
  const flights = new TermsFlights(), hotels = new TermsHotels();
  const { composer } = overrideComposer({ flights, hotels });
  const r = await composer.search(parse(RAW));
  const out = r.legs.out.rows.find(x => x.available && x.optionId === 'FLEX');
  const hotel = r.legs.hotel.rows.find(x => x.available && x.cancellation.refundable);
  assert.ok(out && hotel, 'a Flex fare and a refundable room');
  const selection = { out: out.key, back: r.legs.back.rows.find(x => x.available).key, hotel: hotel.key };
  const priced = await composer.price(selection, r.query);
  const request = Object.freeze({ selection, query: r.query, rows: priced.rows, totalCents: priced.totalCents });
  assert.equal((await composer.recheck(request)).status, 'same');

  flights.lightTerms = true;
  const fare = await composer.recheck(request);
  assert.equal(fare.status, 'changed');
  assert.equal(fare.components.out.status, 'changed');
  assert.equal(fare.components.out.wasCents, fare.components.out.nowCents, 'the price did not move');
  assert.equal(fare.components.out.row.fare.terms, 'Non-refundable. No changes.');
  assert.equal(fare.components.back.status, 'same');
  assert.equal(fare.components.hotel.status, 'same');
  assert.equal(fare.newTotalCents, priced.totalCents);

  flights.lightTerms = false;
  hotels.strict = true;
  const room = await recheck(composer, request);
  assert.equal(room.status, 'changed');
  assert.equal(room.components.hotel.status, 'changed');
  assert.equal(room.components.hotel.nowCents, hotel.totalCents);
  assert.equal(room.components.hotel.row.cancellation.refundable, false);
  assert.equal(room.components.out.status, 'same');
  hotels.strict = false;
  assert.equal((await composer.recheck(request)).status, 'same', 'back to the stored terms: same');
});

// ---------------------------------------------------------------------------------------------------------
// variants

/** A pick that leaves room for every kind: the dearest available nonstop each way and the dearest 5-star room. */
async function businessPick(composer, raw = { ...RAW, cabin: 'business', flex: '1' }) {
  const r = await composer.search(parse(raw));
  const dearestNonstop = rows => rows.filter(x => x.available && x.stops === 0).at(-1);
  const rows = { out: dearestNonstop(r.legs.out.rows), back: r.legs.back ? dearestNonstop(r.legs.back.rows) : null, hotel: r.legs.hotel ? r.legs.hotel.rows.filter(x => x.available && x.stars === 5).at(-1) : null };
  return { r, rows, selection: { out: rows.out.key, back: rows.back ? rows.back.key : null, hotel: rows.hotel ? rows.hotel.key : null } };
}
/** A test policy: flights within under $600, hotels within up to 4 stars. */
const evaluate = row => ({ status: row.kind === 'flight' ? (row.totalCents < 60000 ? 'within' : 'out') : row.stars <= 4 ? 'within' : 'out' });

test('variants: every kind on the demo inventory, each the whole trip with one change, priced end to end and cheaper', async () => {
  const { composer, flights, hotels } = overrideComposer();
  const { r, rows: pick, selection } = await businessPick(composer);
  const before = flights.calls.search + hotels.calls.search;
  const v = await composer.variants(r.query, selection, { datesFlexible: true, evaluate, searched: r, today: TODAY });
  const kinds = new Set(v.candidates.map(c => c.change.kind));
  assert.deepEqual([...kinds].sort(), ['all_within', 'cabin', 'dates', 'fare', 'flight', 'hotel', 'room', 'stops']);
  assert.ok(v.searches <= MAX_SEARCHES);
  assert.equal(flights.calls.search + hotels.calls.search - before, v.searches, 'the handed-over search is reused; only extra searches run');
  assert.equal(v.truncated, false, 'cabin (2) and every date shift (6 × 3) fit in 20');
  assert.equal(v.searches, 2 + 2 * FLEX_DAYS * 3);
  const pickTotal = total(pick);
  const ids = new Set();
  for (const c of v.candidates) {
    const { kind, component } = c.change;
    assert.equal(c.totalCents, total(c.rows), `${kind}: the total is the sum of its rows`);
    assert.ok(c.totalCents < pickTotal, `${kind}: cheaper than the pick`);
    for (const k of ['out', 'back', 'hotel']) {
      dto.assertRow(c.rows[k]);
      assert.ok(c.rows[k].available);
      assert.equal(c.selection[k], c.rows[k].key);
    }
    assert.equal(c.rows.out.segments[0].from.code, 'CAI', 'never another route');
    assert.equal(c.rows.out.segments.at(-1).to.code, 'LHR');
    assert.equal(c.rows.back.segments[0].from.code, 'LHR');
    assert.equal(c.rows.hotel.city, 'London', 'never another destination');
    assert.equal(typeof c.change.fromText, 'string');
    assert.doesNotMatch(`${c.change.fromText} ${c.change.toText}`, /\$|USD|—/);
    const id = JSON.stringify([c.selection, c.query.departDate]);
    assert.ok(!ids.has(id), 'no duplicates');
    ids.add(id);
    const others = ['out', 'back', 'hotel'].filter(k => k !== component);
    if (kind !== 'dates' && kind !== 'all_within') {
      assert.deepEqual(c.query, r.query, `${kind}: same query`);
      for (const k of others) assert.equal(c.rows[k].key, pick[k].key, `${kind}: only ${component} changes`);
    }
    const mine = pick[component], alt = c.rows[component];
    if (kind === 'fare') { assert.equal(alt.offerId, mine.offerId); assert.notEqual(alt.optionId, mine.optionId); }
    if (kind === 'flight' || kind === 'stops') { assert.notEqual(alt.offerId, mine.offerId); assert.equal(alt.optionId, mine.optionId); assert.equal(alt.cabin, mine.cabin); }
    if (kind === 'stops') { assert.equal(mine.stops, 0); assert.ok(alt.stops > 0); assert.match(c.change.toText, /^1 stop via /); }
    if (kind === 'flight') assert.ok(!(mine.stops === 0 && alt.stops > 0));
    if (kind === 'cabin') {
      assert.equal(CABIN_RANK[alt.cabin], CABIN_RANK[mine.cabin] - 1);
      assert.deepEqual(alt.flightNumbers, mine.flightNumbers);
      assert.equal(alt.optionId, mine.optionId);
      assert.deepEqual([c.change.fromText, c.change.toText], ['Business', 'Premium economy']);
    }
    if (kind === 'room') { assert.equal(alt.offerId, mine.offerId); assert.notEqual(alt.optionId, mine.optionId); }
    if (kind === 'hotel') assert.notEqual(alt.offerId, mine.offerId);
    if (kind === 'dates') {
      const d = c.change.days;
      assert.ok(Math.abs(d) >= 1 && Math.abs(d) <= FLEX_DAYS);
      assert.equal(component, 'trip');
      assert.equal(c.query.departDate, addDays(r.query.departDate, d));
      assert.equal(c.query.returnDate, addDays(r.query.returnDate, d));
      assert.equal(c.query.hotel.checkIn, addDays(r.query.hotel.checkIn, d));
      assert.equal(daysBetween(c.query.hotel.checkIn, c.query.hotel.checkOut), 4, 'nights kept');
      assert.equal(c.rows.out.segments[0].departLocal.slice(0, 10), c.query.departDate);
      assert.equal(c.rows.hotel.offerId, pick.hotel.offerId, 'the same hotel and room');
      assert.equal(c.rows.out.optionId, pick.out.optionId);
      assert.deepEqual([c.change.fromText, c.change.toText], [r.query.departDate, c.query.departDate]);
    }
    if (kind === 'all_within') {
      assert.equal(component, 'trip');
      for (const k of ['out', 'back', 'hotel']) assert.equal(evaluate(c.rows[k]).status, 'within', `all_within: ${k} is within`);
    }
  }
});

test('variants: dates only when the dates can move, never in the past; no all_within without a policy verdict', async () => {
  const composer = demoComposer();
  const { r, selection } = await businessPick(composer);
  const fixed = await composer.variants(r.query, selection, { datesFlexible: false, searched: r });
  assert.ok(!fixed.candidates.some(c => c.change.kind === 'dates'));
  assert.ok(!fixed.candidates.some(c => c.change.kind === 'all_within'), 'no evaluate, no all_within');
  assert.equal(fixed.searches, 2, 'only the two cabin searches');
  const economy = await businessPick(composer, { ...RAW });
  const plain = await composer.variants(economy.r.query, economy.selection, { datesFlexible: false, searched: economy.r });
  assert.equal(plain.searches, 0, 'economy, fixed dates and the search handed over: no search at all');
  assert.ok(!plain.candidates.some(c => c.change.kind === 'cabin'));
  const again = await composer.variants(economy.r.query, economy.selection, { datesFlexible: false });
  assert.equal(again.searches, 3, 'not handed over: the pick\'s own three legs are searched again, and counted');
  assert.deepEqual(again.candidates, plain.candidates, 'the same candidates either way');

  // Leaving tomorrow: one day earlier is today, two and three days earlier would be in the past.
  const soon = await businessPick(composer, { from: 'CAI', to: 'LHR', depart: '2026-10-10', return: '2026-10-13', cabin: 'economy' });
  const v = await composer.variants(soon.r.query, soon.selection, { datesFlexible: true, today: TODAY });
  assert.ok(v.candidates.filter(c => c.change.kind === 'dates').every(c => c.query.departDate >= TODAY && c.change.days >= -1));
  assert.equal(v.searches, 2 + 4 * 2, 'the pick\'s two legs, then shifts +1, −1, +2 and +3, two legs each');
  const byDefault = await composer.variants(soon.r.query, soon.selection, { datesFlexible: true });
  assert.deepEqual(byDefault.candidates.map(c => c.query.departDate), v.candidates.map(c => c.query.departDate), 'without today: the UTC date of now()');
  const fromTomorrow = await composer.variants(soon.r.query, soon.selection, { datesFlexible: true, today: '2026-10-10', searched: soon.r });
  assert.equal(fromTomorrow.searches, 3 * 2, 'a company already on the 10th cannot leave on the 9th');
});

test('variants: at most 20 searches in all, counted as they run; a smaller budget cuts the furthest shifts and says so', async () => {
  const { composer, flights, hotels } = overrideComposer();
  const { r, selection } = await businessPick(composer);
  const calls = () => flights.calls.search + hotels.calls.search;
  let before = calls();
  const small = await composer.variants(r.query, selection, { datesFlexible: true, maxSearches: 5, searched: r, today: TODAY });
  assert.equal(small.truncated, true);
  assert.equal(small.searches, 5, 'cabin 2, then one shift of 3');
  assert.equal(calls() - before, 5);
  assert.ok(small.candidates.filter(c => c.change.kind === 'dates').every(c => c.change.days === 1), 'only the first shift fits');

  // Not handed over: the pick's own three legs are searched again and count against the 20.
  before = calls();
  const big = await composer.variants(r.query, selection, { datesFlexible: true, maxSearches: 500, today: TODAY });
  assert.equal(calls() - before, big.searches, 'searches is every provider search that ran');
  assert.equal(big.searches, MAX_SEARCHES, 'capped at 20: 3 pick legs, 2 cabin, 5 shifts of 3');
  assert.equal(big.truncated, true, 'the sixth shift did not fit');
  assert.equal(big.candidates.filter(c => c.change.kind === 'dates').length, 5);

  // A swapped-in cabin alternative (Premium economy out, the search was Business): that leg is searched in
  // its own cabin, and that search counts too.
  const cabinAlt = big.candidates.find(c => c.change.kind === 'cabin' && c.change.component === 'out');
  assert.equal(cabinAlt.rows.out.cabin, 'premium');
  before = calls();
  const swapped = await composer.variants(r.query, cabinAlt.selection, { datesFlexible: true, searched: r, today: TODAY });
  assert.equal(calls() - before, swapped.searches, 'every search counted');
  assert.ok(swapped.searches <= MAX_SEARCHES);
  assert.equal(swapped.searches, 1 + 2 + 5 * 3, 'the Premium economy out leg, 2 cabin, then 5 shifts of 3');
  assert.equal(swapped.truncated, true);
  assert.ok(swapped.candidates.some(c => c.change.kind === 'flight' && c.rows.out.cabin === 'premium'), 'the 0-search kinds vary the swapped leg in its cabin');

  const none = await composer.variants(r.query, selection, { datesFlexible: true, maxSearches: 0, searched: r });
  assert.equal(none.searches, 0);
  assert.equal(none.truncated, true);
  assert.ok(none.candidates.length > 0 && none.candidates.every(c => ['fare', 'flight', 'stops', 'room', 'hotel'].includes(c.change.kind)), 'the 0-search kinds still come');
  before = calls();
  const nothing = await composer.variants(r.query, selection, { datesFlexible: true, maxSearches: 0 });
  assert.deepEqual([nothing.searches, nothing.truncated, nothing.candidates.length, calls() - before], [0, true, 0, 0], 'no budget and nothing handed over: no search at all');
  const two = await composer.variants(r.query, selection, { datesFlexible: false, maxSearches: 2 });
  assert.equal(two.searches, 2);
  assert.equal(two.truncated, true);
  assert.ok(two.candidates.every(c => c.change.component !== 'hotel'), 'the hotel leg did not fit, so no hotel or room candidate');
});

test('variants: an unavailable pick has no variants; a one-way pick without a hotel varies the one flight', async () => {
  const { composer, flights } = overrideComposer();
  const { r, rows, selection } = await businessPick(composer);
  flights.setUnavailable(rows.out.offerId, rows.out.optionId);
  assert.deepEqual(await composer.variants(r.query, selection, { datesFlexible: true }), { candidates: [], searches: 0, truncated: false });
  flights.clearOverrides();
  const one = await businessPick(composer, { from: 'CAI', to: 'LHR', depart: '2026-11-12', cabin: 'premium', flex: '1' });
  const v = await composer.variants(one.r.query, one.selection, { datesFlexible: true, today: TODAY });
  assert.ok(v.candidates.every(c => c.rows.back === null && c.rows.hotel === null && c.selection.back === null && c.selection.hotel === null));
  assert.equal(v.searches, 1 + 1 + 6, 'the pick\'s own leg, one cabin search, then one search per shift');
  assert.ok(v.candidates.some(c => c.change.kind === 'cabin' && c.rows.out.cabin === 'economy'));
});

// ---------------------------------------------------------------------------------------------------------
// No supplier, no writes, latency

test('no supplier: search, price, variants and recheck answer 503 "Supplier not connected yet"', async () => {
  const composer = new TripComposer({ inventory: createBusinessInventory({ business: { demoInventory: false } }), now });
  const q = parse(RAW);
  const sel = { out: 'f.flt_ZM1_2026-11-12_economy|LIGHT', back: 'f.flt_ZM2_2026-11-16_economy|LIGHT', hotel: null };
  for (const call of [() => composer.search(q), () => composer.price(sel, q), () => composer.variants(q, sel, { datesFlexible: true }), () => composer.recheck({ selection: sel, query: q, rows: {} })]) {
    await assert.rejects(call(), e => e.code === 'no_supplier' && e.status === 503 && /^Supplier not connected yet\./.test(e.message));
  }
  assert.doesNotThrow(() => new TripComposer({}), 'construction never throws');
  await rejects(() => new TripComposer({}).search(q), 'no_supplier', 503);
});

test('production: an app with the production config has no supplier for Business, and says so', async t => {
  const app = await startApp({ APP_ENV: 'production', DATABASE_URL: 'postgres://x/prod', ENABLE_BUSINESS: 'true', ENABLE_TRIPS: 'false' }, { store: new MemoryStore() });
  t.after(app.close);
  assert.equal(app.business.inventory.status, 'none');
  assert.deepEqual(app.business.inventory.airports(), []);
  await rejects(() => app.business.composer.search(parse(RAW)), 'no_supplier', 503);
});

test('search never writes: no records, quotes, bookings or payment intents', async t => {
  const app = await startApp({ ENABLE_BUSINESS: 'true' }, { now });
  t.after(app.close);
  const composer = app.business.composer;
  assert.equal(app.business.inventory.status, 'demo');
  const before = storeSnapshot(app);
  const { r, selection } = await businessPick(composer);
  const p = await composer.price(selection, r.query);
  await composer.variants(r.query, selection, { datesFlexible: true, evaluate, today: TODAY });
  await composer.recheck({ selection, query: r.query, rows: p.rows });
  assert.equal(storeSnapshot(app), before);
  assert.equal(app.store.quotes.size, 0);
  assert.equal(app.store.bookings.size, 0);
  assert.equal(app.store.intents.size, 0);
  assert.ok(app.registry.get('flights').bookings.size === 0 && app.business.inventory.flights.bookings.size === 0, 'no provider booking either');
});

test('latency: search and draft-sized work (price plus every variant) well under the 1,500 ms ceiling', async tc => {
  const composer = demoComposer();
  await composer.search(parse(RAW)); // warm up
  let t = process.hrtime.bigint();
  const r = await composer.search(parse({ ...RAW, cabin: 'business', flex: '1', depart: '2026-12-03', return: '2026-12-08' }));
  const searchMs = Number(process.hrtime.bigint() - t) / 1e6;
  const dearest = rows => rows.filter(x => x.available).at(-1).key;
  const selection = { out: dearest(r.legs.out.rows), back: dearest(r.legs.back.rows), hotel: dearest(r.legs.hotel.rows) };
  t = process.hrtime.bigint();
  await composer.price(selection, r.query);
  await composer.search(r.query);
  await composer.variants(r.query, selection, { datesFlexible: true, evaluate, searched: r, today: TODAY });
  const draftMs = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(searchMs < 1500, `search ${searchMs} ms`);
  assert.ok(draftMs < 1500, `draft work ${draftMs} ms`);
  tc.diagnostic(`search ${searchMs.toFixed(1)} ms, draft work ${draftMs.toFixed(1)} ms`);
});

test('the composer\'s cabins and constants match the plan', () => {
  assert.deepEqual(CABINS, ['economy', 'premium', 'business']);
  assert.deepEqual([MAX_PRICED_PER_LEG, MAX_SEARCHES, MAX_DAYS_AHEAD, MAX_TRIP_DAYS, NIGHTS_RANGE, FLEX_DAYS], [60, 20, 330, 30, [1, 14], 3]);
});
