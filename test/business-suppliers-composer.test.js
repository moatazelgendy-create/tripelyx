// The trip composer on the real suppliers (real-suppliers design §1.2, §2.3, §2.4, §5.1, §7.1): searchDetailed
// when a provider has it, leg.skipped, the hotel leg's outage, pq.check and pq.country, pricedAt as the
// supplier's own answer time, and the variants cap. The suppliers answer from fixtures through an injected fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createBusinessInventory } = require('../server/business/inventory');
const { TripComposer } = require('../server/business/search');
const { recheck } = require('../server/business/recheck');
const { BusinessDemoFlights } = require('../server/business/demo/flights');
const { BusinessDemoHotels } = require('../server/business/demo/hotels');
const { withCompany } = require('../server/business/scope');
const { AppError } = require('../server/lib/errors');
const dto = require('../server/business/dto');
const { overrideProvider } = require('./business-fakes');
const { fakeFetch, testKeys, captureLog, testClock } = require('./supplier-fetch');

const ORG = 'org_composerTest00001';
const TODAY = '2026-10-09';
const T0 = '2026-10-09T09:00:00.000Z';
const OFFER_REQUESTS = 'https://api.duffel.com/air/offer_requests';
const OFFERS = /^https:\/\/api\.duffel\.com\/air\/offers\//;
const RATES = 'https://api.liteapi.travel/v3.0/hotels/rates';
const PREBOOK = /^https:\/\/book\.liteapi\.travel\/v3\.0\/rates\/prebook\?timeout=\d+$/;
const I1 = 'flt_t.ZZ1234_20261112T0835_economy';
const RAW = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', hotel: '1', nights: '2', cabin: 'economy' });
const keys = testKeys();
const GOOD = Object.freeze({
  APP_ENV: 'development', ENABLE_BUSINESS: 'true', BUSINESS_FLIGHT_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: keys.token,
  BUSINESS_HOTEL_SUPPLIER: 'liteapi', LITEAPI_API_KEY: keys.apiKey, BUSINESS_ALLOW_SUPPLIER_TEST: 'true',
});
const noRegistry = { get: () => null };
const ROUTES = Object.freeze({
  search: { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
  get: { method: 'GET', url: OFFERS, reply: 'duffel/offer.get.json' },
  rates: { method: 'POST', url: RATES, reply: c => (c.body.hotelIds ? 'liteapi/rates.hotel.json' : 'liteapi/rates.cairo.json') },
  prebook: { method: 'POST', url: PREBOOK, reply: 'liteapi/prebook.json' },
});
const inOrg = fn => withCompany(ORG, fn);

/** A composer over the sandbox suppliers on a fake fetch; `wrap` may replace the inventory's providers. */
function supplierComposer({ routes = Object.values(ROUTES), clock = testClock(), env = {}, wrap = null } = {}) {
  const ff = fakeFetch(routes, keys);
  const log = captureLog();
  let inventory = createBusinessInventory(loadConfig({ ...GOOD, ...env }), { registry: noRegistry, fetch: ff.fetch, log, now: clock.now });
  if (wrap) inventory = { ...inventory, ...wrap(inventory) };
  return { composer: new TripComposer({ inventory, now: clock.now }), inventory, ff, clock, log };
}

/** A provider that records every call (name and arguments) and otherwise is the provider itself. */
function spy(provider, calls) {
  return new Proxy(provider, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      return (...args) => { calls.push({ fn: prop, vertical: target.vertical, args }); return v.apply(target, args); };
    },
  });
}

const pickOf = r => {
  const out = r.legs.out.rows.find(x => x.offerId === I1 && x.optionId === 'standard');
  const hotel = r.legs.hotel.rows.find(x => x.offerId === 'htl_t.lp1001' && x.optionId === 'standard-room-ro-r');
  return { rows: { out, back: null, hotel }, selection: { out: out.key, back: null, hotel: hotel.key } };
};

test('search: searchDetailed is used; each leg says what was left out and why', () => inOrg(async () => {
  const { composer, ff } = supplierComposer();
  const q = composer.parseQuery(RAW, { today: TODAY });
  assert.deepEqual(q.hotel, { city: 'London', country: 'United Kingdom', checkIn: '2026-11-12', checkOut: '2026-11-14' });
  const r = await composer.search(q);
  assert.equal(r.status, 'sandbox');
  assert.deepEqual(r.legs.out.skipped, { firstCabin: 1, mixedCabin: 1, unknownCarrier: 1, otherCurrency: 1, currencies: ['GBP'] });
  assert.deepEqual(r.legs.hotel.skipped, { feeOtherCurrency: 1, noHotelData: 1 });
  assert.equal(r.legs.out.truncated, false);
  assert.ok(r.legs.out.rows.length >= 10 && r.legs.hotel.rows.length >= 5);
  for (const row of [...r.legs.out.rows, ...r.legs.hotel.rows]) {
    dto.assertRow(row);
    assert.equal(row.currency, 'USD');
    assert.equal(row.demo, true, 'test data');
    assert.equal(row.pricedAt, T0);
  }
  assert.equal(ff.calls.length, 2, 'one offer request, one rates call');
  ff.assertClean();
}));

test('search: skip counts from a provider are whitelisted; truncated is carried; a plain search() leg has no skipped', () => inOrg(async () => {
  const demoFlights = new BusinessDemoFlights({ latencyMs: 0 });
  const detailed = {
    name: 'Detailed', vertical: 'flights', isDemo: true,
    searchDetailed: async pq => ({ offers: await demoFlights.search(pq), skipped: { mixedCabin: 2, bogus: 5, timeMismatch: -1, firstCabin: 1.5, noHotelData: 0 }, truncated: true }),
    search: () => { throw new Error('search() is not called when searchDetailed exists'); },
    getOffer: (...a) => demoFlights.getOffer(...a),
    quote: (...a) => demoFlights.quote(...a),
  };
  const inventory = createBusinessInventory({ allowDemoInventory: false }, { registry: noRegistry, overrides: { flights: detailed, hotels: new BusinessDemoHotels({ latencyMs: 0 }) } });
  const composer = new TripComposer({ inventory, now: () => new Date(T0) });
  const r = await composer.search(composer.parseQuery({ ...RAW, to: 'DBB' }, { today: TODAY }));
  assert.deepEqual(r.legs.out.skipped, { mixedCabin: 2 });
  assert.equal(r.legs.out.truncated, true);
  assert.ok(!('skipped' in r.legs.hotel), 'the demo hotel leg reports nothing');
  assert.equal(r.pricedAt, T0, 'demo offers say no answer time: now');
}));

test('the hotel leg: a supplier outage leaves the flights standing; any other error still fails the search', () => inOrg(async () => {
  const { composer, ff } = supplierComposer({ routes: [ROUTES.search, { method: 'POST', url: RATES, reply: { status: 503, body: {} } }] });
  const r = await composer.search(composer.parseQuery(RAW, { today: TODAY }));
  assert.ok(r.legs.out.rows.length > 0);
  assert.equal(r.legs.hotel.error, 'unavailable');
  assert.deepEqual(r.legs.hotel.rows, []);
  assert.equal(r.legs.hotel.truncated, false);
  assert.deepEqual([r.legs.hotel.benchmark.incl_taxes.medianCents, r.legs.hotel.benchmark.excl_taxes.sampleSize], [null, 0]);
  assert.equal(ff.count('api.liteapi.travel'), 2, 'rates retried once, then given up');
  // Flights down: the search fails (there is no trip without flights).
  const noFlights = supplierComposer({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/error.504-airline-internal.json' }, ROUTES.rates] });
  await assert.rejects(noFlights.composer.search(noFlights.composer.parseQuery(RAW, { today: TODAY })), e => e.code === 'supplier_unavailable' && e.status === 503);
  // A hotel error that isn't an outage is not swallowed.
  const broken = supplierComposer({ wrap: () => ({ hotels: { name: 'Broken', vertical: 'hotels', isDemo: true, search: async () => { throw new AppError('other', 'Something else.', 500); } } }) });
  await assert.rejects(broken.composer.search(broken.composer.parseQuery(RAW, { today: TODAY })), e => e.code === 'other');
}));

test('pq.country on the hotel search; pq.check only when given; getOffer gets { optionId }; quote gets the offer', () => inOrg(async () => {
  const calls = [];
  const { composer, ff } = supplierComposer({ wrap: inv => ({ flights: spy(inv.flights, calls), hotels: spy(inv.hotels, calls) }) });
  const q = composer.parseQuery(RAW, { today: TODAY });
  const r = await composer.search(q);
  const hotelSearch = calls.find(c => c.fn === 'searchDetailed' && c.vertical === 'hotels');
  assert.deepEqual(hotelSearch.args[0], { where: 'London', country: 'United Kingdom', checkIn: '2026-11-12', checkOut: '2026-11-14', guests: 1 });
  assert.equal(ff.calls.find(c => c.url === RATES).body.countryCode, 'GB');
  const quotes = calls.filter(c => c.fn === 'quote');
  assert.ok(quotes.length > 0 && quotes.every(c => c.args[0].offer && c.args[0].offer.id === c.args[0].offerId), 'quote gets the offer it prices');
  const { selection, rows } = pickOf(r);

  calls.length = 0;
  await composer.price(selection, q);
  const plain = calls.filter(c => c.fn === 'getOffer');
  assert.equal(plain.length, 2);
  for (const c of plain) assert.ok(!('check' in c.args[1]), 'no check level: none sent');
  assert.deepEqual(plain.map(c => c.args[2]).sort((a, b) => a.optionId.localeCompare(b.optionId)), [{ optionId: 'standard' }, { optionId: 'standard-room-ro-r' }]);
  assert.equal(plain.find(c => c.vertical === 'hotels').args[1].country, 'United Kingdom');

  for (const check of ['peek', 'confirm', 'final']) {
    calls.length = 0;
    await recheck(composer, { selection, query: q, rows }, { check });
    const levels = calls.filter(c => c.fn === 'getOffer').map(c => c.args[1].check);
    assert.deepEqual(levels, [check, check], check);
    for (const c of calls.filter(x => x.fn === 'quote')) assert.equal(c.args[0].query.check, check);
  }
  assert.equal(ff.calls.filter(c => PREBOOK.test(c.url)).length, 1, 'a prebook only at final');
}));

test('pricedAt is when the supplier answered: a cache hit keeps the search time while the clock moves on', () => inOrg(async () => {
  const clock = testClock();
  const { composer, ff } = supplierComposer({ clock });
  const q = composer.parseQuery(RAW, { today: TODAY });
  const r = await composer.search(q);
  assert.equal(r.pricedAt, T0);
  const { selection, rows } = pickOf(r);
  clock.advance(2 * 60 * 1000); // createRequest two minutes later: searches again, prices, both from the cache
  const again = await composer.search(q);
  assert.equal(again.pricedAt, T0);
  const priced = await composer.price(selection, q);
  assert.equal(priced.pricedAt, T0, 'the row keeps the supplier\'s time, not createRequest\'s');
  assert.equal(priced.rows.out.pricedAt, T0);
  assert.equal(priced.rows.hotel.pricedAt, T0);
  assert.equal(ff.calls.length, 2, 'no supplier call since the search');
  // submit's check asks the suppliers again: their answers carry the new time.
  const checked = await recheck(composer, { selection, query: q, rows }, { check: 'confirm' });
  assert.equal(checked.at, '2026-10-09T09:02:00.000Z');
  assert.equal(checked.components.out.row.pricedAt, '2026-10-09T09:02:00.000Z');
  assert.equal(checked.components.hotel.row.pricedAt, '2026-10-09T09:02:00.000Z');
  assert.equal(checked.status, 'same');
  // The earliest wins when the legs answered at different times.
  clock.advance(60 * 1000);
  const mixed = await composer.price(selection, q, { check: 'auto' });
  assert.equal(mixed.pricedAt, mixed.rows.out.pricedAt < mixed.rows.hotel.pricedAt ? mixed.rows.out.pricedAt : mixed.rows.hotel.pricedAt);
}));

test('variants: at most inventory.maxVariantSearches searches (BUSINESS_SUPPLIER_VARIANT_SEARCHES; demo keeps 20)', async () => {
  // Demo providers under a lower cap.
  const f = overrideProvider(new BusinessDemoFlights()), h = overrideProvider(new BusinessDemoHotels());
  const demo = createBusinessInventory({ allowDemoInventory: false }, { registry: noRegistry, overrides: { flights: f, hotels: h } });
  assert.equal(demo.maxVariantSearches, 20);
  for (const cap of [2, 0]) {
    const composer = new TripComposer({ inventory: { ...demo, maxVariantSearches: cap }, now: () => new Date(T0) });
    const q = composer.parseQuery({ ...RAW, to: 'DBB', cabin: 'business', flex: '1', return: '2026-11-16' }, { today: TODAY });
    const r = await composer.search(q);
    const pick = c => r.legs[c].rows.find(x => x.available);
    const selection = { out: pick('out').key, back: pick('back').key, hotel: pick('hotel').key };
    const before = f.calls.search + h.calls.search;
    const v = await composer.variants(q, selection, { datesFlexible: true, maxSearches: 20, today: TODAY });
    assert.ok(v.searches <= cap, `cap ${cap}: ${v.searches}`);
    assert.equal(v.truncated, true);
    assert.equal(f.calls.search + h.calls.search - before, v.searches);
  }
  // The suppliers: BUSINESS_SUPPLIER_VARIANT_SEARCHES=1.
  await inOrg(async () => {
    const { composer, inventory, ff } = supplierComposer({ env: { BUSINESS_SUPPLIER_VARIANT_SEARCHES: '1' } });
    assert.equal(inventory.maxVariantSearches, 1);
    const q = composer.parseQuery({ ...RAW, flex: '1' }, { today: TODAY });
    const { selection } = pickOf(await composer.search(q));
    const v = await composer.variants(q, selection, { datesFlexible: true, maxSearches: 20, today: TODAY });
    assert.equal(v.searches, 1);
    assert.equal(v.truncated, true);
    assert.ok(ff.calls.length <= 3, `at most one more supplier call: ${ff.calls.length}`);
  });
});

test('pricedAt per row: every cached flight and hotel row keeps the supplier\'s time; a flights-only search too', () => inOrg(async () => {
  for (const raw of [RAW, { from: 'CAI', to: 'LHR', depart: '2026-11-12', cabin: 'economy' }]) {
    const clock = testClock();
    const { composer, ff } = supplierComposer({ clock });
    const q = composer.parseQuery(raw, { today: TODAY });
    const first = await composer.search(q);
    clock.advance(2 * 60 * 1000);
    const again = await composer.search(q);
    assert.equal(ff.calls.length, first.legs.hotel ? 2 : 1, 'the second search is a cache hit');
    const rows = [...again.legs.out.rows, ...(again.legs.hotel ? again.legs.hotel.rows : [])];
    assert.ok(again.legs.out.rows.length > 0);
    for (const row of rows) assert.equal(row.pricedAt, T0, `${row.key}: the supplier's time, not the cache hit's`);
    assert.equal(again.pricedAt, T0);
  }
}));

test('final: a meal plan the supplier changed at the same price is `changed`, never `same`', () => inOrg(async () => {
  const { composer, ff } = supplierComposer({ routes: [ROUTES.search, ROUTES.get, ROUTES.rates, { method: 'POST', url: PREBOOK, reply: 'liteapi/prebook.board-changed.json' }] });
  const q = composer.parseQuery(RAW, { today: TODAY });
  const { selection, rows } = pickOf(await composer.search(q));
  const rc = await recheck(composer, { selection, query: q, rows }, { check: 'final' });
  assert.equal(ff.calls.filter(c => PREBOOK.test(c.url)).length, 1);
  assert.equal(rc.components.hotel.status, 'changed');
  assert.equal(rc.components.hotel.wasCents, rc.components.hotel.nowCents, 'the same price: a change of terms');
  assert.match(rc.components.hotel.row.cancellation.text, /The supplier changed the meal plan to Breakfast Included\.$/);
  assert.equal(rc.status, 'changed');
}));

test('a supplier that stays down during a price check is 503 with nothing decided, never an unavailable row', () => inOrg(async () => {
  const q0 = c => c.composer.parseQuery(RAW, { today: TODAY });
  // decide: the prebook keeps failing (5000 and its retry, or a plain 5xx).
  for (const reply of [{ status: 500, body: { error: { code: 5000, message: 'retry' } } }, { status: 503, body: {} }]) {
    const c = supplierComposer({ routes: [ROUTES.search, ROUTES.get, ROUTES.rates, { method: 'POST', url: PREBOOK, reply }] });
    const q = q0(c);
    const { selection, rows } = pickOf(await c.composer.search(q));
    await assert.rejects(recheck(c.composer, { selection, query: q, rows }, { check: 'final' }), e => e.code === 'supplier_unavailable' && e.status === 503, JSON.stringify(reply));
  }
  // submit: Duffel's GET keeps failing (a 503 retried twice, or a 500).
  for (const reply of [{ fixture: 'duffel/error.500.json', status: 503 }, 'duffel/error.500.json']) {
    const c = supplierComposer({ routes: [ROUTES.search, { method: 'GET', url: OFFERS, reply }, ROUTES.rates, ROUTES.prebook] });
    const q = q0(c);
    const { selection, rows } = pickOf(await c.composer.search(q));
    await assert.rejects(recheck(c.composer, { selection, query: q, rows }, { check: 'confirm' }), e => e.code === 'supplier_unavailable' && e.status === 503, JSON.stringify(reply));
    await assert.rejects(recheck(c.composer, { selection, query: q, rows }, { check: 'final' }), e => e.code === 'supplier_unavailable' && e.status === 503);
  }
  // submit: the hotel's fresh rates keep failing.
  const c = supplierComposer({ routes: [ROUTES.search, ROUTES.get, { method: 'POST', url: RATES, reply: x => (x.body.hotelIds ? { status: 503, body: {} } : 'liteapi/rates.cairo.json') }] });
  const q = q0(c);
  const { selection, rows } = pickOf(await c.composer.search(q));
  await assert.rejects(recheck(c.composer, { selection, query: q, rows }, { check: 'confirm' }), e => e.code === 'supplier_unavailable' && e.status === 503);
}));

test('price(): a key the supplier no longer has is 422 marked optionGone; a form mistake is 422 with no mark (R1-m)', () => inOrg(async () => {
  const { composer } = supplierComposer();
  const q = composer.parseQuery(RAW, { today: TODAY });
  const { selection } = pickOf(await composer.search(q));
  const unmarked = e => e instanceof AppError && e.code === 'invalid_selection' && e.status === 422 && e.optionGone === undefined;
  // A room the hotel no longer offers, and an itinerary the search no longer has: gone, with no earlier row.
  for (const sel of [{ ...selection, hotel: 'h.htl_t.lp1001|no-such-room' }, { ...selection, out: 'f.flt_t.ZZ9999_20261112T0835_economy|standard' }]) {
    await assert.rejects(composer.price(sel, q), e => e instanceof AppError && e.code === 'invalid_selection' && e.status === 422
      && e.optionGone === true && e.message === "That option isn't part of this search.", JSON.stringify(sel));
  }
  // With the earlier rows, the same keys come back as unavailable rows instead (the price check's path).
  const priced = await composer.price(selection, q);
  const again = await composer.price({ ...selection, hotel: 'h.htl_t.lp1001|no-such-room' }, q, { previous: { ...priced.rows, hotel: { ...priced.rows.hotel, key: 'h.htl_t.lp1001|no-such-room', optionId: 'no-such-room' } } });
  assert.deepEqual(again.unavailable, ['hotel']);
  // The form's own mistakes keep their 422 and carry no mark: a cabin above the search (same words), a key of
  // the wrong part, a return flight on a one-way search.
  await assert.rejects(composer.price({ ...selection, out: selection.out.replace('_economy|', '_business|') }, q), unmarked);
  await assert.rejects(composer.price({ ...selection, out: selection.hotel }, q), unmarked);
  await assert.rejects(composer.price({ ...selection, back: selection.out }, q), unmarked);
}));
