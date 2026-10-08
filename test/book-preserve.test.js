// Alamein Go preservation (plan §F8): the /book pages, two offer pages and the /api/search JSON are exactly what
// the untouched site (a0ea0bc) served, with Tripelyx Business off; with it on, the JSON is still exactly equal and
// the pages differ only by what Business adds to the shared chrome. Business never changes the demo inventory
// /book runs on. The full text is in test/fixtures/baseline/<env>/, written by scripts/capture-baseline.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ENVS, BOOK, API, FIXED_NOW, stripBusiness, expectedBusinessCounts, freezeDate, bootApp, collect, providerSources } = require('../scripts/capture-baseline');
const manifest = require('./fixtures/baseline/manifest.json');
const mock = require('../server/providers/mock');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'baseline');
const fixture = file => fs.readFileSync(path.join(FIXTURES, file), 'utf8');
const NAMES = [...BOOK, ...API].map(([name]) => name).concat(['offer-flight', 'offer-hotel']);

async function run(t, env, envName) {
  const restore = freezeDate(FIXED_NOW);
  t.after(restore);
  const app = await bootApp(ROOT, env);
  t.after(app.close);
  return { app, got: await collect(app, { only: 'full', offers: manifest.envs[envName].offers }) };
}

test('the §F8 set: /book, two flight and three hotel searches, one flight and one hotel offer, and their search JSON', () => {
  for (const name of Object.keys(ENVS)) {
    const full = manifest.envs[name].full;
    assert.deepEqual(Object.keys(full).sort(), [...NAMES].sort(), name);
    for (const [key, r] of Object.entries(full)) {
      assert.equal(r.status, 200, `${name} ${key}`);
      assert.ok(fs.existsSync(path.join(FIXTURES, r.file)), `${name} ${key}: ${r.file}`);
    }
    assert.match(full['offer-flight'].path, /^\/book\/flights\/flt_[^?]+\?from=CAI&to=LHR&/);
    assert.match(full['offer-hotel'].path, /^\/book\/hotels\/htl_[^?]+\?where=New\+Alamein&/);
    assert.deepEqual(JSON.parse(fixture(full['api-hotels-dubai'].file)).count, 0, `${name}: Dubai has no demo hotels`);
    assert.ok(JSON.parse(fixture(full['api-flights-cai-lhr'].file)).count > 0, `${name}: CAI to LHR has flights`);
  }
});

for (const [envName, env] of Object.entries(ENVS)) {
  test(`${envName}, Business off: the booking pages and search JSON are exactly the baseline`, async t => {
    const { app, got } = await run(t, env, envName);
    assert.equal(app.ctx.businessNav, false);
    for (const [name, want] of Object.entries(manifest.envs[envName].full)) {
      assert.equal(got.full[name].path, want.path, name);
      assert.equal(got.full[name].status, want.status, `${envName} ${name}: status`);
      assert.equal(got.full[name].type, want.type, `${envName} ${name}: content type`);
      assert.equal(got.full[name].text, fixture(want.file), `${envName} ${name}: ${want.path}`);
    }
  });

  test(`${envName}, Business on: the search JSON is exactly equal and the pages differ only by the Business chrome`, async t => {
    const { app, got } = await run(t, { ...env, ENABLE_BUSINESS: 'true' }, envName);
    assert.ok(app.ctx.business && app.ctx.businessNav, 'Business runs');
    for (const [name, want] of Object.entries(manifest.envs[envName].full)) {
      assert.equal(got.full[name].status, want.status, `${envName} ${name}: status`);
      assert.equal(got.full[name].type, want.type, `${envName} ${name}: content type`);
      if (want.type === 'application/json') {
        assert.equal(got.full[name].text, fixture(want.file), `${envName} ${name}: the JSON is unchanged`);
        continue;
      }
      const { text, counts } = stripBusiness(got.full[name].text);
      assert.deepEqual(counts, expectedBusinessCounts(got.full[name].text), `${envName} ${name}: what Business adds`);
      assert.equal(counts.navItem, 1, `${envName} ${name}: the Business menu item`);
      assert.equal(text, fixture(want.file), `${envName} ${name}: nothing else changed`);
    }
  });
}

test('Business never touches the demo inventory /book runs on: the registry serves the mock providers, unchanged', async t => {
  const restore = freezeDate(FIXED_NOW);
  t.after(restore);
  assert.deepEqual(providerSources(ROOT), manifest.providerSources, 'no file under server/providers/mock changed');
  assert.deepEqual(Object.keys(mock.FACTORIES), ['hotels', 'flights', 'cars', 'cruises', 'yachts', 'transfers', 'activities', 'experiences']);
  for (const env of [{}, { ENABLE_BUSINESS: 'true' }, { ENABLE_TRIPS: 'false', ENABLE_BUSINESS: 'true' }]) {
    const app = await bootApp(ROOT, env);
    t.after(app.close);
    const flights = app.registry.get('flights');
    const hotels = app.registry.get('hotels');
    assert.equal(Object.getPrototypeOf(flights), mock.MockFlightProvider.prototype, 'flights: exactly MockFlightProvider, no subclass');
    assert.equal(Object.getPrototypeOf(hotels), mock.MockHotelProvider.prototype, 'hotels: exactly MockHotelProvider, no subclass');
    assert.notEqual(flights.constructor.name, 'BusinessDemoFlights');
    assert.notEqual(hotels.constructor.name, 'BusinessDemoHotels');
  }
});
