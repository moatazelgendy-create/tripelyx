// Go-live stage L0 (go-live design §3.4, §3.8, §3.11): Tripelyx Business on www with no demo data and no test
// data. www's own settings (APP_ENV=staging, ALLOW_DEMO_INVENTORY=true for /book, ENABLE_TRIPS=true,
// ENABLE_BUSINESS=true, BUSINESS_DEMO_INVENTORY unset, no supplier keys) give Business the status 'none':
// - every Business page, in every role (public pages, every workspace page, /admin/business, 404s, refusals and
//   the ?ok= notices), the company export and the CSV say nothing about demo or test data, carry no price source
//   and name no fictional airline or hotel; no Business page wears the site's environment banner, and the
//   consumer 404 keeps it;
// - the sign-up box and its error agree for every inventory status;
// - Tripelyx's own company is made once, by a platform admin, over HTTP: a second press, or two at once, makes
//   nothing, and anyone else gets the plain Business 404;
// - /, /book, /ai-travel-agent and a consumer 404 are the stored baseline (test/fixtures/baseline, written from
//   the untouched site and unchanged on the dev branch since): byte for byte with Business off, and with
//   Business on only the approved "Business" header item and trip footer link differ (?v= aside);
// - /book still lists its demo inventory.
// The Business checks run on MemoryStore and, with TEST_DATABASE_URL, on PostgresStore.
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENVS, FIXED_NOW, sha256, normalise, stripBusiness, expectedBusinessCounts, freezeDate } = require('../scripts/capture-baseline');
const manifest = require('./fixtures/baseline/manifest.json');
const { world, crawl, textOf, mainOf } = require('./business-world');
const { seedUser, storeSnapshot } = require('./business-helpers');
const { startApp, quietLog } = require('./helpers');
const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { PostgresStore } = require('../server/booking/PostgresStore');
const { Pool } = require('pg');
const tokens = require('../server/business/tokens');
const { KINDS, HOUSE_COMPANY_NAME, HOUSE_NAME_FIXED, SIGNUP_ACK } = require('../server/business/constants');
const { carriers: DEMO_CARRIERS } = require('../server/providers/mock/demo-data/flights');
const { BUSINESS_HOTELS } = require('../server/business/demo/hotels-data');
const { NO_SUPPLIER } = require('../server/views/business/parts');

/** www's settings (infra/app.yaml): the live baseline env set, with Business on. */
const WWW = Object.freeze({ ...ENVS.live, ENABLE_BUSINESS: 'true' });
const pgUrl = process.env.TEST_DATABASE_URL;
const STORES = [['MemoryStore', null], ['PostgresStore', pgUrl || null]];

/** The site's environment notice ("Staging build · demo inventory · …"): consumer pages only. */
const BANNER = /<aside class="env-banner"/;
const FICTIONAL = new RegExp([...DEMO_CARRIERS.map(c => c.name), ...BUSINESS_HOTELS.map(h => h.name)]
  .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
const TEST_DATA = /test data|\bsandbox\b|supplier test|test system|test mode|bz-price-test|bz-test-tag/i;

/**
 * Nothing on a Business page (or download) speaks of demo or test data: no "demo" anywhere in the document,
 * no price source container or label, no fictional airline or hotel, no environment banner.
 */
function assertLive(label, text, { banner = false } = {}) {
  const s = String(text);
  const demo = /demo/i.exec(s);
  assert.ok(!demo, `${label}: "${demo && s.slice(Math.max(0, demo.index - 100), demo.index + 60)}"`);
  assert.doesNotMatch(s, /Demo price/i, `${label}: a Demo price label`);
  assert.doesNotMatch(s, /data-price-source/, `${label}: a price source container`);
  const test = TEST_DATA.exec(s);
  assert.ok(!test, `${label}: test data words: "${test && s.slice(Math.max(0, test.index - 100), test.index + 60)}"`);
  const fictional = FICTIONAL.exec(s);
  assert.ok(!fictional, `${label}: a fictional airline or hotel: ${fictional && fictional[0]}`);
  if (!banner) assert.doesNotMatch(s, BANNER, `${label}: the site's environment banner`);
}

/** Boot the app the way scripts/capture-baseline.js does, on `store` (a fresh MemoryStore by default). */
async function boot(env, store = null) {
  const config = loadConfig({ APP_ENV: 'development', ...env });
  const built = await createApp(config, { log: quietLog, now: () => new Date(FIXED_NOW), store: store || new MemoryStore() });
  const server = await new Promise(resolve => { const s = built.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...built, config, base, close: () => new Promise(r => server.close(r)) };
}

async function page(base, p) {
  const res = await fetch(base + p, { headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' }, redirect: 'manual' });
  return { status: res.status, text: normalise(await res.text()) };
}

/**
 * Run `fn` on a PostgresStore of its own: a schema made for this run (dropped after), so other tests' companies
 * in a shared test database (the platform page lists every company) and an earlier run's house company are not
 * in it. With no url, `fn(null)` (a fresh MemoryStore).
 */
async function withStore(url, fn) {
  if (!url) return fn(null);
  const schema = `golive_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const own = new URL(url);
  own.searchParams.set('options', `-c search_path=${schema}`);
  const store = new PostgresStore({ connectionString: own.toString(), ssl: false });
  try {
    await store.init();
    return await fn(store);
  } finally {
    await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

// ---------------------------------------------------------------------------------------------------------
// www's settings

test("www's settings: Business status 'none' with BUSINESS_DEMO_INVENTORY unset, while /book keeps its demo inventory", async t => {
  for (const name of Object.keys(WWW)) assert.ok(!/^(?:BUSINESS_|DUFFEL|LITEAPI)/.test(name) || name === 'ENABLE_BUSINESS', `${name} is not a Business or supplier setting`);
  const config = loadConfig({ APP_ENV: 'development', ...WWW });
  assert.equal(config.appEnv, 'staging');
  assert.equal(config.allowDemoInventory, true, '/book keeps its demo inventory');
  assert.equal(config.business.demoInventory, false, 'Business does not');
  const app = await startApp(WWW, { store: new MemoryStore() });
  t.after(app.close);
  assert.equal(app.ctx.business.inventory.status, 'none');
  assert.equal(app.ctx.business.inventory.flights, null);
  assert.equal(app.ctx.business.inventory.hotels, null);
  // /book and its search still run on the demo inventory.
  const api = await (await fetch(`${app.base}/api/search/flights?from=CAI&to=LHR&departDate=2026-11-12&passengers=1&cabin=economy`, { headers: { 'x-forwarded-proto': 'https' } })).json();
  assert.ok(api.offers.length > 0, 'demo flights on /book');
  assert.ok(api.offers.some(o => DEMO_CARRIERS.some(c => JSON.stringify(o).includes(c.name))), 'the demo airlines');
});

// ---------------------------------------------------------------------------------------------------------
// Consumer pages: the stored baseline

for (const [storeName, url] of STORES) {
  test(`consumer pages on ${storeName}: /, /book, /ai-travel-agent and a 404 are the baseline; with Business on only the header item and trip footer link differ`, {
    skip: storeName === 'PostgresStore' && !url && 'TEST_DATABASE_URL not set', timeout: 120000,
  }, async t => {
    const restore = freezeDate(FIXED_NOW);
    t.after(restore);
    const want = manifest.envs.live;
    // '/business' did not exist on the untouched site: its answer there is the consumer 404 page.
    const BASE = { '/': want.pages['/'], '/ai-travel-agent': want.pages['/ai-travel-agent'], '/book': want.full.book, '/no-such-page': want.pages['/business'] };
    assert.equal(BASE['/no-such-page'].status, 404);
    await withStore(url, async store => {
      const off = await boot(ENVS.live, store);
      const offPages = {};
      try {
        assert.equal(off.ctx.business, null);
        for (const [p, b] of Object.entries(BASE)) {
          const r = await page(off.base, p);
          offPages[p] = r.text;
          assert.equal(r.status, b.status, `off ${p}`);
          assert.equal(sha256(r.text), b.sha256, `off ${p}: byte for byte the baseline`);
        }
        assert.match(offPages['/no-such-page'], BANNER, 'the consumer 404 has its environment banner');
      } finally { await off.close(); }

      const on = await boot(WWW, store);
      try {
        assert.equal(on.ctx.business.inventory.status, 'none');
        for (const [p, b] of Object.entries(BASE)) {
          const r = await page(on.base, p);
          assert.equal(r.status, b.status, `on ${p}`);
          const { text, counts } = stripBusiness(r.text);
          assert.deepEqual(counts, expectedBusinessCounts(r.text), `on ${p}: the header item and footer link, once each where they belong`);
          assert.equal(text, offPages[p], `on ${p}: nothing else differs`);
          assert.equal(sha256(text), b.sha256, `on ${p}: the baseline once they are taken out`);
        }
        const consumer404 = (await page(on.base, '/no-such-page')).text;
        assert.match(consumer404, BANNER, 'a consumer 404 keeps its environment banner with Business on');
        assert.match(consumer404, /<li><a href="\/business"[^>]*>Business<\/a><\/li>/, 'and the Business header item');
        // A Business 404 is the same page without the banner (go-live design §3.4).
        // (A signed-out visit to a workspace is sent to sign-in; the sweep below covers the signed-in 404s.)
        for (const p of ['/business/no-such-page', '/BUSINESS/Nope', '/admin/business', '/admin/business/no-such-page']) {
          const r = await page(on.base, p);
          assert.equal(r.status, 404, p);
          assert.doesNotMatch(r.text, BANNER, `${p}: no environment banner`);
          assert.equal(r.text, consumer404.replace(/<aside class="env-banner"[\s\S]*?<\/aside>/, ''), `${p}: the consumer 404 without the banner`);
        }
        // A Business error page (a path that can't be decoded) has no banner; a consumer one keeps it.
        const bizErr = await page(on.base, '/business/o/%E0%A4%A');
        const consumerErr = await page(on.base, '/book/flights/%E0%A4%A');
        assert.equal(bizErr.status, 400);
        assert.equal(consumerErr.status, 400);
        assert.doesNotMatch(bizErr.text, BANNER, 'a Business error page has no environment banner');
        assert.match(consumerErr.text, BANNER, 'a consumer error page keeps it');
      } finally { await on.close(); }
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// The sign-up box and its error

test('the sign-up box and its error agree for every inventory status, on the page, in the route and in createCompany', async t => {
  const www = await startApp(WWW, { store: new MemoryStore() });
  t.after(www.close);
  const dev = await startApp({ ENABLE_BUSINESS: 'true' }, { store: new MemoryStore() });
  t.after(dev.close);
  assert.equal(SIGNUP_ACK.none.error, "Tick this box to confirm you've read this.");
  assert.equal(SIGNUP_ACK.live.error, SIGNUP_ACK.none.error);
  assert.equal(SIGNUP_ACK.none.box, "I understand trip search and booking aren't open in Tripelyx Business yet.");
  assert.equal(SIGNUP_ACK.live.box, "I understand booking isn't open in Tripelyx Business yet.");
  for (const [status, app, inventory] of [
    ['none', www, null], ['demo', dev, null],
    ['live', www, { ...www.business.inventory, status: 'live', source: 'live' }],
    ['sandbox', www, { ...www.business.inventory, status: 'sandbox', source: 'sandbox' }],
  ]) {
    const was = app.business.inventory;
    if (inventory) app.business.inventory = inventory;
    try {
      assert.equal(app.business.inventory.status, status);
      const u = await seedUser(app, { name: `Sign Up ${status}`, email: `signup.${status}@example.com` });
      const h = { 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https', cookie: u.cookie };
      const form = await (await fetch(`${app.base}/business/start`, { headers: h })).text();
      assert.ok(textOf(form).includes(SIGNUP_ACK[status].box), `${status}: the box`);
      const res = await fetch(`${app.base}/business/start`, {
        method: 'POST', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
        body: new URLSearchParams({ companyName: 'North Pier', size: '1-10 people', timezone: 'Africa/Cairo' }).toString(),
      });
      assert.equal(res.status, 422, status);
      const refused = await res.text();
      assert.ok(textOf(refused).includes(SIGNUP_ACK[status].box), `${status}: the box again`);
      assert.ok(textOf(refused).includes(SIGNUP_ACK[status].error), `${status}: its error`);
      const e = await app.business.createCompany({ user: u.user }, { name: 'North Pier', size: '1-10 people' }).catch(x => x);
      assert.equal(e.details.ack, SIGNUP_ACK[status].error, `${status}: createCompany says the same`);
      if (status === 'none') assertLive('the www sign-up refusal', refused);
    } finally { app.business.inventory = was; }
  }
});

// ---------------------------------------------------------------------------------------------------------
// Every Business page, the downloads and the house company

/** The workspace pages to start each crawl from, with every ?ok= notice the admin pages show. */
function seedsFor(C) {
  const b = C.B;
  return [
    b, `${b}/welcome`, `${b}/trips`, `${b}/trips/new`, `${b}/approvals`, `${b}/approvals?ok=returned`, `${b}/policy`, `${b}/policies`,
    `${b}/policies?ok=handling`, `${b}/policies/standard`, `${b}/policies/standard?ok=saved`, `${b}/policies/standard?ok=unchanged`,
    `${b}/policies/director`, `${b}/policies/executive`, `${b}/policies/standard/history`, `${b}/budgets`, `${b}/budgets?ok=budget`,
    `${b}/budgets?period=2026-Q3`, `${b}/people`, ...['revoked', 'member', 'removed', 'department', 'archived'].map(ok => `${b}/people?ok=${ok}`),
    `${b}/reports`, `${b}/activity`, `${b}/settings`, `${b}/settings?ok=saved`, `${b}/settings?ok=renamed`,
    `${b}/trips/search?from=CAI&to=LHR&depart=2026-11-12&return=2026-11-16&hotel=1&cabin=economy`,
  ];
}

/** POSTs that are refused, as company C's Owner: each answer is a page to check. */
async function refusals(C, w) {
  const o = C.people.owner.http;
  const b = C.B;
  const org = await w.svc.getOrg(C.people.owner.actor);
  const out = [
    // A rev the company never had: the stale-form 409.
    ['stale settings', await o.post(`${b}/settings`, { name: org.name, timezone: org.timezone, rev: String((org.rev || 0) + 1000) })],
    ['Tripelyx rename', await o.post(`${b}/settings`, { name: 'Tripelyx Travel', timezone: org.timezone, rev: String(org.rev) })],
    ['bad budget', await o.post(`${b}/budgets`, { departmentId: C.deps[0].id, period: '2026-Q4', amount: 'lots', rev: '' })],
    ['bad invite', await o.post(`${b}/people/invite`, { email: 'not an email', role: 'employee' })],
    ['bad policy', await o.post(`${b}/policies/standard`, { 'flight.maxStops': 'many', rev: '0' })],
    ['new department, no name', await o.post(`${b}/departments`, { name: '' })],
    ['trip request with no supplier', await C.people.employee.http.post(`${b}/trips`, { purpose: 'Visit', from: 'CAI', to: 'LHR' })],
    ['Tripelyx sign-up', await o.post('/business/start', { companyName: 'Tripelyx Travel', size: '1-10 people' })],
    ['wrong password', await w.http('').post('/business/signin', { email: C.people.owner.user.email, password: 'not the password' })],
    ['house company, not an admin', await o.post('/admin/business/house', {})],
    ['platform status, not an admin', await o.post(`/admin/business/${C.id}/status`, { status: 'suspended', note: 'x', rev: '0' })],
  ];
  for (const [label, res] of out) {
    // With no supplier a trip request answers 503 with the form and "Supplier not connected yet" (§B6).
    if (label === 'trip request with no supplier') {
      assert.equal(res.status, 503, `${C.word} ${label}`);
      assert.ok(textOf(mainOf(res.text)).includes(NO_SUPPLIER.title), `${C.word} ${label}: says why`);
    } else assert.ok(res.status >= 400 && res.status < 500, `${C.word} ${label}: ${res.status}`);
  }
  return out;
}

for (const [storeName, url] of STORES) {
  test(`every Business page in every role on ${storeName}, the downloads and the house company: no demo, no test data, no banner`, {
    skip: storeName === 'PostgresStore' && !url && 'TEST_DATABASE_URL not set', timeout: 600000,
  }, async t => {
    await withStore(url, async store => {
      // On Postgres the store is a schema of its own (withStore): no house company yet, no other test's companies.
      const w = await world({ production: true, env: WWW, store, unique: !!store });
      try {
        assert.equal(w.svc.inventory.status, 'none');
        let n = 0;
        const check = who => (u, res) => {
          n += 1;
          // A search or trip request with no supplier answers 503 with the trip form and "Supplier not connected
          // yet" (§B6).
          const noSupplier = res.status === 503 && textOf(mainOf(res.text)).includes(NO_SUPPLIER.title);
          assert.ok(res.status < 500 || noSupplier, `${who} ${u}: ${res.status}`);
          if (/^<!doctype html>/i.test(res.text)) assertLive(`${who} ${u} (${res.status})`, res.text);
        };

        // The house company, over HTTP: refused for everyone but a platform admin, then made once.
        const before = store ? null : storeSnapshot(w.app);
        for (const [who, h] of [['stranger', w.http('')], ['Acme owner', w.A.people.owner.http], ['Pat Both', w.both.http]]) {
          const res = await h.post('/admin/business/house', {});
          assert.equal(res.status, 404, `${who}: the plain 404`);
          check(`${who} house press`)('/admin/business/house', res);
        }
        if (!store) assert.equal(storeSnapshot(w.app), before, 'refused presses write nothing');
        assert.equal(await w.svc.repo.houseOrgId(), null, 'no house company after the refused presses');
        const panel = await w.ops.http.get('/admin/business');
        check('platform admin')('/admin/business', panel);
        assert.match(panel.text, /<form class="bz-inline-form" method="post" action="\/admin\/business\/house"><button class="btn btn-navy bz-btn" type="submit">Create Tripelyx Inc<\/button><\/form>/);
        // Two presses at once (a double click): one company.
        const [p1, p2] = await Promise.all([w.ops.http.post('/admin/business/house', {}), w.ops.http.post('/admin/business/house', {})]);
        assert.deepEqual([p1.status, p2.status], [303, 303]);
        assert.deepEqual([p1.location, p2.location].sort(), ['/admin/business?ok=house', '/admin/business?ok=house_exists'], 'one press made it, the other nothing');
        const houseId = await w.svc.repo.houseOrgId();
        assert.ok(houseId, 'the house company exists');
        const house = await w.svc.repo.getIn(KINDS.org, houseId, houseId);
        assert.deepEqual([house.name, house.status, house.house, house.ownerIds], [HOUSE_COMPANY_NAME, 'active', true, [w.ops.user.id]]);
        const again = await w.ops.http.post('/admin/business/house', {});
        assert.equal(again.location, '/admin/business?ok=house_exists');
        assert.equal((await w.svc.repo.houseOrgId()), houseId, 'still the same one');
        for (const ok of ['house', 'house_exists']) {
          const res = await w.ops.http.get(`/admin/business?ok=${ok}`);
          check('platform admin')(`/admin/business?ok=${ok}`, res);
          assert.ok(textOf(mainOf(res.text)).includes(ok === 'house' ? `Done. ${HOUSE_COMPANY_NAME} is active, and you're its Owner.` : `${HOUSE_COMPANY_NAME} already exists, so nothing new was made.`), ok);
          assert.match(res.text, new RegExp(`<dt>Company id</dt><dd><code>${houseId}</code></dd>`), `${ok}: the company id`);
          assert.doesNotMatch(res.text, /action="\/admin\/business\/house"/, `${ok}: no button once it exists`);
        }
        // Its settings show the name, fixed.
        const houseHttp = w.ops.http;
        const settings = await houseHttp.get(`/business/o/${houseId}/settings`);
        assert.equal(settings.status, 200);
        assert.ok(textOf(mainOf(settings.text)).includes(HOUSE_NAME_FIXED));
        assert.doesNotMatch(settings.text, /name="name"/, 'no name field');

        // Every role of both companies, every page they reach.
        for (const C of [w.A, w.B]) {
          for (const [role, p] of Object.entries(C.people)) await crawl(p.http, seedsFor(C), { cap: 600, onPage: check(`${C.word} ${role}`) });
        }
        // The house company as its Owner (the platform admin).
        await crawl(houseHttp, seedsFor({ B: `/business/o/${houseId}` }), { cap: 600, onPage: check('house owner') });
        // Public pages, the chooser, invites (real and made up), and the 404s.
        const publicUrls = ['/business', '/business/start', '/business/signin', '/business/app', `/business/invite/${w.A.invite.token}`,
          `/business/invite/${tokens.newToken()}`, '/business/no-such-page', '/business/o/org_AAAAAAAAAAAAAAAA', w.A.B, w.B.B, `${w.B.B}/settings`,
          '/admin/business', '/admin/business/no-such-page', '/admin/business?ok=active', '/admin/business?ok=suspended'];
        for (const [who, h] of [['stranger', w.http('')], ['Pat Both', w.both.http], ['platform admin', w.ops.http], ['Acme employee', w.A.people.employee.http]]) {
          await crawl(h, publicUrls, { cap: 600, onPage: check(who) });
        }
        // The platform admin's own notices, naming each company.
        for (const C of [w.A, w.B]) {
          for (const ok of ['active', 'suspended']) check('platform admin')(`?ok=${ok}`, await w.ops.http.get(`/admin/business?ok=${ok}&org=${C.id}`));
        }
        // A non-member and a non-admin get the plain Business 404.
        for (const [label, res] of [
          ['Acme owner at Globex', await w.A.people.owner.http.get(w.B.B)],
          ['Acme owner at /admin/business', await w.A.people.owner.http.get('/admin/business')],
          ['stranger at /business/no-such-page', await w.http('').get('/business/no-such-page')],
        ]) {
          assert.equal(res.status, 404, label);
          assertLive(label, res.text);
        }
        // Refusals, as the Owner of each company.
        for (const C of [w.A, w.B]) {
          for (const [label, res] of await refusals(C, w)) check(`${C.word} refusal: ${label}`)(label, res);
        }
        t.diagnostic(`${n} answers checked`);
        assert.ok(n > 250, `${n} answers checked`);

        // The company export and the CSV, for both companies and the house company.
        for (const [label, b, http] of [['Acme', w.A.B, w.A.people.owner.http], ['Globex', w.B.B, w.B.people.owner.http], ['house', `/business/o/${houseId}`, houseHttp]]) {
          const ex = await http.post(`${b}/settings/export`, {});
          assert.equal(ex.status, 200, `${label} export`);
          assertLive(`${label} export`, ex.text);
          const data = JSON.parse(ex.text);
          assert.equal(data.note, 'Tripelyx Business export. Amounts are whole US cents. Nothing was booked or charged. Questions: go@tripelyx.com.');
          for (const period of ['2026-Q4', '2026-10']) {
            const csv = await http.post(`${b}/reports/export`, { period });
            assert.equal(csv.status, 200, `${label} CSV ${period}`);
            assertLive(`${label} CSV ${period}`, csv.text);
          }
        }
      } finally {
        await w.close();
      }
    });
  });
}
