// The supplier settings and the inventory seam (real-suppliers design §1.3, §1.4, §2.1, §7.1): config parsing,
// every bad setting ends as status 'none' with a problem that never shows a key (and never throws), the
// BUSINESS_ALLOW_SUPPLIER_TEST default per APP_ENV, status 'sandbox', carriers(), and no supplier call at boot.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createBusinessInventory } = require('../server/business/inventory');
const { createBusinessSuppliers, supplierCarriers, PROBLEMS } = require('../server/business/suppliers');
const { AIRLINES } = require('../server/business/suppliers/airlines');
const { withCompany } = require('../server/business/scope');
const { fakeFetch, testKeys, captureLog, testClock } = require('./supplier-fetch');
const { startApp } = require('./helpers');

const keys = testKeys();
const GOOD = Object.freeze({
  APP_ENV: 'development', ENABLE_BUSINESS: 'true', BUSINESS_FLIGHT_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: keys.token,
  BUSINESS_HOTEL_SUPPLIER: 'liteapi', LITEAPI_API_KEY: keys.apiKey, BUSINESS_ALLOW_SUPPLIER_TEST: 'true',
});
const noRegistry = { get: () => null };
const inventoryOf = (env, deps = {}) => {
  const config = loadConfig(env);
  return createBusinessInventory(config, { registry: noRegistry, fetch: fakeFetch([]).fetch, log: captureLog(), now: testClock().now, ...deps });
};

/** The bad settings of §1.6, each with what its problem names. */
const BAD = [
  ['a live-looking Duffel token', { DUFFEL_ACCESS_TOKEN: `duffel_live_${'A'.repeat(40)}` }, /^DUFFEL_ACCESS_TOKEN is not a Duffel test token\.$/],
  ['an unknown Duffel prefix', { DUFFEL_ACCESS_TOKEN: `dfl_${'B'.repeat(40)}` }, /^DUFFEL_ACCESS_TOKEN is not a Duffel test token\.$/],
  ['the bare Duffel prefix', { DUFFEL_ACCESS_TOKEN: 'duffel_test_' }, /^DUFFEL_ACCESS_TOKEN is not a Duffel test token\.$/],
  ['no Duffel token', { DUFFEL_ACCESS_TOKEN: '' }, /^DUFFEL_ACCESS_TOKEN is not set\.$/],
  ['a LiteAPI key without sand_', { LITEAPI_API_KEY: `prod_${'0123abcd'.repeat(4)}` }, /^LITEAPI_API_KEY is not a LiteAPI sandbox key\.$/],
  ['no LiteAPI key', { LITEAPI_API_KEY: undefined }, /^LITEAPI_API_KEY is not set\.$/],
  ['test keys with ALLOW=false', { BUSINESS_ALLOW_SUPPLIER_TEST: 'false' }, /^BUSINESS_ALLOW_SUPPLIER_TEST is not true/],
  ['hotels without flights', { BUSINESS_FLIGHT_SUPPLIER: '', DUFFEL_ACCESS_TOKEN: undefined }, /^BUSINESS_HOTEL_SUPPLIER needs a working flight supplier/],
  ['an unknown flight supplier', { BUSINESS_FLIGHT_SUPPLIER: 'amadeus' }, /^BUSINESS_FLIGHT_SUPPLIER must be duffel or empty\.$/],
  ['an unknown hotel supplier', { BUSINESS_HOTEL_SUPPLIER: 'hotelbeds' }, /^BUSINESS_HOTEL_SUPPLIER must be liteapi or empty\.$/],
  ['CACHE_SECONDS=abc', { BUSINESS_SUPPLIER_CACHE_SECONDS: 'abc' }, /^BUSINESS_SUPPLIER_CACHE_SECONDS must be a whole number from 0 to 900\.$/],
  ['CACHE_SECONDS=901', { BUSINESS_SUPPLIER_CACHE_SECONDS: '901' }, /BUSINESS_SUPPLIER_CACHE_SECONDS/],
  ['CALLS_PER_HOUR=0', { BUSINESS_SUPPLIER_COMPANY_CALLS_PER_HOUR: '0' }, /BUSINESS_SUPPLIER_COMPANY_CALLS_PER_HOUR/],
  ['VARIANT_SEARCHES=-1', { BUSINESS_SUPPLIER_VARIANT_SEARCHES: '-1' }, /BUSINESS_SUPPLIER_VARIANT_SEARCHES/],
  ['a bad nationality', { BUSINESS_GUEST_NATIONALITY: 'Egypt' }, /BUSINESS_GUEST_NATIONALITY/],
  ['a key with a space', { LITEAPI_API_KEY: `sand_${'x'.repeat(10)} y` }, /^LITEAPI_API_KEY is not a LiteAPI sandbox key\.$/],
];

test('config: the supplier block parses, with defaults, and keeps its keys out of sight', () => {
  const config = loadConfig(GOOD);
  const s = config.business.suppliers;
  assert.deepEqual({ ...s }, {
    configured: true, flights: 'duffel', hotels: 'liteapi', allowTest: true, guestNationality: 'US',
    cacheSeconds: 300, companyCallsPerHour: 120, variantSearches: 4, problem: null,
  });
  assert.equal(s.duffelToken, keys.token);
  assert.equal(s.liteapiKey, keys.apiKey);
  assert.ok(Object.isFrozen(s));
  assert.ok(!Object.keys(config.business).includes('suppliers'), 'non-enumerable: the business block reads as before');
  const text = JSON.stringify(config);
  assert.ok(!text.includes(keys.token) && !text.includes(keys.apiKey), 'never serialised');
  const set = loadConfig({
    ...GOOD, BUSINESS_FLIGHT_SUPPLIER: ' Duffel ', BUSINESS_HOTEL_SUPPLIER: 'LITEAPI', BUSINESS_GUEST_NATIONALITY: 'eg',
    BUSINESS_SUPPLIER_CACHE_SECONDS: '0', BUSINESS_SUPPLIER_COMPANY_CALLS_PER_HOUR: '30', BUSINESS_SUPPLIER_VARIANT_SEARCHES: '20',
  }).business.suppliers;
  assert.deepEqual([set.flights, set.hotels, set.guestNationality, set.cacheSeconds, set.companyCallsPerHour, set.variantSearches, set.problem], ['duffel', 'liteapi', 'EG', 0, 30, 20, null]);
  // Flights only.
  const flightsOnly = loadConfig({ ...GOOD, BUSINESS_HOTEL_SUPPLIER: '', LITEAPI_API_KEY: '' }).business.suppliers;
  assert.deepEqual([flightsOnly.flights, flightsOnly.hotels, flightsOnly.problem, flightsOnly.liteapiKey], ['duffel', null, null, undefined]);
  // Nothing set: not configured, no problem, no keys.
  const none = loadConfig({ APP_ENV: 'development' }).business.suppliers;
  assert.deepEqual([none.configured, none.problem, none.duffelToken], [false, null, undefined]);
  // A problem only counts when suppliers are configured.
  assert.equal(loadConfig({ APP_ENV: 'development', BUSINESS_SUPPLIER_CACHE_SECONDS: 'abc' }).business.suppliers.problem, null);
});

test('config: BUSINESS_ALLOW_SUPPLIER_TEST defaults to true in development only', () => {
  const env = { ...GOOD };
  delete env.BUSINESS_ALLOW_SUPPLIER_TEST;
  assert.equal(loadConfig(env).business.suppliers.allowTest, true);
  for (const appEnv of ['staging', 'production']) {
    const s = loadConfig({ ...env, APP_ENV: appEnv, DATABASE_URL: `postgres://x/${appEnv}` }).business.suppliers;
    assert.equal(s.allowTest, false, appEnv);
    assert.match(s.problem, /^BUSINESS_ALLOW_SUPPLIER_TEST is not true/);
    assert.equal(s.duffelToken, undefined, 'no key kept when there is a problem');
    const allowed = loadConfig({ ...env, APP_ENV: appEnv, DATABASE_URL: `postgres://x/${appEnv}`, BUSINESS_ALLOW_SUPPLIER_TEST: 'true' }).business.suppliers;
    assert.equal(allowed.problem, null, `${appEnv}: allowed on purpose`);
  }
});

test('inventory: good settings give status sandbox with the real adapters, and no call at boot', () => {
  const ff = fakeFetch([]);
  const inv = createBusinessInventory(loadConfig(GOOD), { registry: noRegistry, fetch: ff.fetch, log: captureLog(), now: testClock().now });
  assert.equal(inv.status, 'sandbox');
  assert.equal(inv.source, 'sandbox');
  assert.equal(inv.flights.name, 'DuffelFlights');
  assert.equal(inv.hotels.name, 'LiteApiHotels');
  assert.equal(inv.flights.isDemo, true, 'test data is never real inventory');
  assert.equal(inv.hotelsConnected, true);
  assert.equal(inv.maxVariantSearches, 4);
  assert.equal(inv.problem, null);
  assert.equal(ff.calls.length, 0);
  assert.equal(inv.cityFor('DBB').city, 'New Alamein');
  assert.ok(inv.airports().length >= 14);
  const flightsOnly = inventoryOf({ ...GOOD, BUSINESS_HOTEL_SUPPLIER: '', LITEAPI_API_KEY: '', BUSINESS_SUPPLIER_VARIANT_SEARCHES: '2' });
  assert.equal(flightsOnly.status, 'sandbox');
  assert.equal(flightsOnly.hotels, null);
  assert.equal(flightsOnly.hotelsConnected, false);
  assert.equal(flightsOnly.maxVariantSearches, 2);
  // Overrides (tests and preview scenarios) still win.
  const fake = { name: 'Fake', vertical: 'flights' };
  assert.equal(createBusinessInventory(loadConfig(GOOD), { registry: noRegistry, overrides: { flights: fake } }).flights, fake);
});

test('inventory: every bad setting gives status none and a problem without the key, never demo, never a throw', () => {
  for (const [label, change, problem] of BAD) {
    const env = { ...GOOD, ...change };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    let inv;
    assert.doesNotThrow(() => { inv = inventoryOf(env); }, label);
    assert.equal(inv.status, 'none', label);
    assert.equal(inv.flights, null, label);
    assert.equal(inv.hotels, null, label);
    assert.equal(inv.source, null, label);
    assert.match(inv.problem, problem, label);
    for (const v of [env.DUFFEL_ACCESS_TOKEN, env.LITEAPI_API_KEY].filter(x => x && x.length > 12)) {
      assert.ok(!inv.problem.includes(v) && !inv.problem.includes(v.slice(-10)), `${label}: the problem names the variable, never its value`);
    }
    assert.deepEqual(inv.carriers(), [], label);
    assert.deepEqual(inv.airports(), [], label);
  }
});

test('createBusinessSuppliers: never throws, refuses what config would refuse, logs each problem once', () => {
  const log = captureLog();
  const now = testClock().now;
  const odd = [
    null, undefined, {}, { configured: true }, { configured: true, flights: 'duffel' },
    { configured: true, flights: 'duffel', duffelToken: 42 },
    { configured: true, flights: 'duffel', duffelToken: `duffel_live_${'x'.repeat(30)}` },
    { configured: true, flights: 'duffel', duffelToken: keys.token, hotels: 'liteapi', liteapiKey: 'nope_123456789' },
    { configured: true, get flights() { throw new Error(`boom ${keys.token}`); } },
  ];
  for (const cfg of odd) {
    const r = createBusinessSuppliers(cfg, { now, log });
    assert.equal(r.flights, null);
    assert.equal(r.hotels, null);
    if (r.problem) assert.ok(!r.problem.includes(keys.token));
  }
  assert.equal(createBusinessSuppliers({ configured: true, flights: 'duffel', duffelToken: `duffel_live_${'x'.repeat(30)}` }, { now, log }).problem, PROBLEMS.duffelToken);
  assert.equal(createBusinessSuppliers({ configured: true, flights: 'duffel', duffelToken: keys.token }, { log }).problem, PROBLEMS.unreadable, 'no clock');
  assert.ok(!log.text().includes(keys.token));
  const lines = log.lines.map(l => l.text);
  assert.equal(new Set(lines).size, lines.length, 'one line per problem');
});

test('inventory: a supplier answering in the wrong mode latches off; problem says so without a key', async () => {
  const ff = fakeFetch([{ method: 'POST', url: 'https://api.duffel.com/air/offer_requests', reply: 'duffel/offer-request.live-mode-true.json' }], keys);
  const log = captureLog();
  const inv = createBusinessInventory(loadConfig(GOOD), { registry: noRegistry, fetch: ff.fetch, log, now: testClock().now });
  await withCompany('org_inventoryTest00001', async () => {
    await assert.rejects(inv.flights.search({ from: 'CAI', to: 'LHR', departDate: '2026-11-12', passengers: 1, cabin: 'economy' }), e => e.code === 'supplier_unavailable');
  });
  assert.equal(inv.problem, PROBLEMS.flightsMismatch);
  assert.equal(inv.status, 'sandbox', 'the status is the configuration; the latch shows in problem');
  assert.ok(!log.text().includes(keys.token));
});

test('carriers(): the supplier airlines plus the test airline in sandbox; demo carriers for demo; none otherwise', () => {
  const sandbox = inventoryOf(GOOD).carriers();
  assert.deepEqual(sandbox, supplierCarriers('sandbox'));
  assert.equal(sandbox.length, AIRLINES.length + 1);
  assert.deepEqual(sandbox[sandbox.length - 1], { code: 'ZZ', name: 'Test airline' });
  assert.ok(sandbox.some(c => c.code === 'MS' && c.name === 'EgyptAir'));
  assert.equal(new Set(sandbox.map(c => c.code)).size, sandbox.length);
  for (const c of sandbox) assert.match(c.code, /^[A-Z0-9]{2}$/);
  assert.ok(!supplierCarriers('live').some(c => c.code === 'ZZ'));
  sandbox[0].name = 'changed';
  assert.notEqual(inventoryOf(GOOD).carriers()[0].name, 'changed', 'a fresh list each time');
  const demo = createBusinessInventory({ allowDemoInventory: true, business: {} }, { registry: noRegistry });
  assert.equal(demo.status, 'demo');
  assert.ok(demo.carriers().length > 0 && !demo.carriers().some(c => c.code === 'ZZ'));
  const none = createBusinessInventory({ allowDemoInventory: false, business: {} }, { registry: noRegistry });
  assert.deepEqual([none.status, none.carriers(), none.problem], ['none', [], null]);
});

test('boot: the app with suppliers configured makes no supplier call and never loads them when Business is off', async t => {
  const ff = fakeFetch([]);
  const real = globalThis.fetch;
  let global = 0;
  globalThis.fetch = (url, init) => {
    if (/api\.duffel\.com|liteapi\.travel/.test(String(url))) { global += 1; return Promise.reject(new Error('no supplier call in tests')); }
    return real(url, init);
  };
  t.after(() => { globalThis.fetch = real; });
  const on = await startApp(GOOD, { businessFetch: ff.fetch });
  t.after(on.close);
  assert.equal(on.business.inventory.status, 'sandbox');
  for (const p of ['/', '/business', '/book']) assert.ok((await real(on.base + p)).status < 500, p);
  assert.equal(ff.calls.length, 0);
  assert.equal(global, 0);
  const off = await startApp({ ...GOOD, ENABLE_BUSINESS: 'false' });
  t.after(off.close);
  assert.equal(off.business, null);
  assert.equal(global, 0);
});
