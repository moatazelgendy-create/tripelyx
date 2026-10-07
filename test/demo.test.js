// Demo data is never presented as real: every production page carries the preview notice while trips
// come from demo inventory or payments are in test mode, demo prices and bookings say "demo", nothing
// is shown behind a timed "checking" animation, and no saving rests on an invented price history.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, sampleQueries } = require('./helpers');
const { loadConfig } = require('../server/config');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { createTripIntegrations } = require('../server/trips/integrations');

const PROD = { APP_ENV: 'production', DATABASE_URL: 'postgres://x/p', ENABLE_TRIPS: 'true', ALLOW_DEMO_INVENTORY: 'true', PAYMENT_MODE: 'test' };
const QUERY = { b: '1500', k: '0', from: 'SFO', who: 'couple', when: 'anytime', nights: '5', style: 'beach', prio: 'hotel' };
// Production refuses plain HTTP; the load balancer says the request came in over HTTPS.
const get = (app, p) => fetch(app.base + p, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } }).then(async r => ({ status: r.status, text: await r.text() }));

test('production with demo inventory and test payments: every page carries the preview notice', async t => {
  const app = await startApp(PROD, { store: new MemoryStore() });
  t.after(() => app.close());
  for (const p of ['/', '/agent', '/about', '/contact', '/legal/terms', '/destinations', '/trips-to-cancun', `/trips?${new URLSearchParams(QUERY)}`]) {
    const r = await get(app, p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<aside class="env-banner"[^>]*>Preview: the trips, prices, hotels and airlines shown are demo examples, not real offers; payments are in test mode, so no card is ever charged\.<\/aside>/, p);
  }
  // Pages whose content is demo prices are not offered to search engines.
  for (const p of ['/destinations', '/trips-to-cancun', '/trips-under-1500', '/beach-vacations']) assert.match((await get(app, p)).text, /<meta name="robots" content="noindex/, p);
  assert.doesNotMatch((await get(app, '/')).text, /<meta name="robots" content="noindex/, 'the homepage stays indexable');
  const sitemap = (await get(app, '/sitemap.xml')).text;
  assert.match(sitemap, /<loc>[^<]*\/agent<\/loc>/);
  assert.doesNotMatch(sitemap, /trips-under-|trips-to-|\/destinations</);
});

test('outside production the build is still named', async t => {
  const app = await startApp();
  t.after(() => app.close());
  assert.match((await get(app, '/')).text, /Development build · demo inventory · payments in test mode/);
});

test('demo prices say demo: review, checkout, destinations; no comparison is claimed that was not made', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const results = await get(app, `/trips?${new URLSearchParams(QUERY)}`);
  const m = results.text.match(/href="(\/trip\/[^"?]+)\?([^"]*)"/);
  const tripPath = m[1], cx = m[2].replace(/&amp;/g, '&');
  // No earlier price named: the page states the price, never "still".
  const fresh = await get(app, `${tripPath}/review?${cx}`);
  assert.match(fresh.text, /<b>Your price is \$[\d,.]+\.<\/b> We priced it from the demo inventory just now; no real supplier was contacted\./);
  assert.doesNotMatch(fresh.text, /price is still|Every supplier confirmed|Price rechecked with every supplier/);
  assert.match(fresh.text, /Price rechecked against the demo inventory/);
  assert.match(fresh.text, /class="tb-demo"[^>]*>.*Demo inventory and prices/);
  assert.doesNotMatch(fresh.text, /data-checking|Checking your final price/, 'no timed "checking" moment');
  const total = fresh.text.match(/name="approvedTotal" value="(\d+)"/)[1];
  const same = await get(app, `${tripPath}/review?${cx}&seen=${total}`);
  assert.match(same.text, /your price is still \$[\d,.]+\.<\/b> We re-priced it from the demo inventory just now; no real supplier was contacted\./);
  // The trip page.
  assert.match((await get(app, `${tripPath}?${cx}`)).text, /Priced from the demo inventory moments ago\./);
  // Destinations: example prices, labelled.
  const dest = await get(app, '/destinations');
  assert.match(dest.text, /The prices are examples/);
  assert.match(dest.text, /example from \$/);
  assert.match(dest.text, /Demo inventory and example prices/);
  assert.doesNotMatch(dest.text, /<small>[^<]*· from \$/);
});

test('no saving rests on an invented price history, and ratings name their source', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const results = await get(app, `/trips?${new URLSearchParams(QUERY)}`);
  assert.doesNotMatch(results.text, /below (this trip’s )?typical|price history/i);
  assert.match(results.text, /rated [\d.]+\/5 \(demo supplier rating\)/);
  assert.doesNotMatch(results.text, /Finding destinations within your budget|data-building/, 'no timed "building" list');
  const home = await get(app, '/');
  assert.doesNotMatch(home.text, /Our most-built trip|Reading what you asked for|data-building/);
  assert.match(home.text, /In this preview the trips, prices and ratings themselves are demo examples, not real offers\./);
  const js = fs.readFileSync(path.join(__dirname, '../public/js/trips.js'), 'utf8');
  assert.doesNotMatch(js, /data-checking|data-building/, 'the scripts no longer stage fake progress');
});

test('the demo booking verticals show no invented scarcity, discounts or review counts', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const q = sampleQueries();
  for (const [v, query] of Object.entries({ hotels: q.hotels, experiences: q.experiences, transfers: q.transfers, flights: q.flights })) {
    const r = await get(app, `/book/${v}?${new URLSearchParams(query)}`);
    assert.equal(r.status, 200, v);
    assert.doesNotMatch(r.text, /only \d+ left|Selling fast|% off|View deal|\d+ reviews/i, v);
    const offer = r.text.match(/href="(\/book\/[a-z]+\/[^"]+)"/);
    if (offer) assert.doesNotMatch((await get(app, offer[1].replace(/&amp;/g, '&'))).text, /only \d+ left|\d+ left<|% off|\d+ reviews/i, `${v} offer`);
  }
  // The test card widget never invites a browser to fill in a saved real card.
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../public/js/payments-test.js'), 'utf8'), /autocomplete="cc-/);
});

test('the demo hotel failure hook is off in production', async () => {
  const traveler = { firstName: 'Ada', lastName: 'Failhotel' };
  const prod = createTripIntegrations(loadConfig(PROD));
  assert.equal((await prod.hotels.book({ id: 'cun-1', checkIn: '2027-03-02' }, { traveler })).status, 'confirmed');
  const dev = createTripIntegrations(loadConfig({ APP_ENV: 'development' }));
  await assert.rejects(dev.hotels.book({ id: 'cun-1', checkIn: '2027-03-02' }, { traveler }), /demo hotel rejected/);
});
