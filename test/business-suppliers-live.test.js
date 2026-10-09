// Live search on www (go-live design §5, stage L2; §8 row E). Business on live keys (BUSINESS_SUPPLIER_LIVE=true),
// with Duffel and LiteAPI reached only through the injected fetch (createApp's businessFetch, test/supplier-fetch.js
// fakeFetch) answered by test/supplier-double.js in live mode (live_mode true, sandbox false). Nothing here reaches a
// supplier, and no key is real: liveKeys() builds obviously fake ones at run time.
// - the answers: live_mode true and sandbox false are live; false, true or a missing flag is a mode mismatch;
// - the platform admin's Suppliers panel end to end: check, turn on, search, request, submit, decide (no prebook),
//   turn off;
// - a mode mismatch turns the stored switch off: every task follows within 30 seconds, a restart keeps it off, and
//   only a new passing check turns it on again;
// - test prefixes are refused on a live stack;
// - the daily caps (100 per company, 500 in all, per supplier and UTC day) count every call, a retry and the admin's
//   check included, and survive a restart (MemoryStore and, with TEST_DATABASE_URL, PostgresStore);
// - a company Tripelyx hasn't confirmed makes no supplier call;
// - the switch turns on only after a passing check for the keys in place, in the last 24 hours, at most 3 an hour;
// - the 80% notice;
// - www with both secrets holding "unset" is Business as before (status 'none'), and the consumer pages are the same;
// - no key, no piece of one and no key print in any page or log line.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser, client, seedOrg, seedMember, seedDepartment, seedBudget, mutableClock, noInline } = require('./business-helpers');
const { fakeFetch, captureLog, supplierKit, airportLookups, blockSupplierHosts } = require('./supplier-fetch');
const { supplierDouble, opsOf, OFFER_REQUESTS, RATES } = require('./supplier-double');
const { textOf, assertSourceMoney } = require('./business-sandbox');
const { ENVS, normalise, freezeDate, bootApp } = require('../scripts/capture-baseline');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { PostgresStore } = require('../server/booking/PostgresStore');
const { loadConfig } = require('../server/config');
const { Repo } = require('../server/business/repo');
const { createBusinessInventory } = require('../server/business/inventory');
const { createBusinessSuppliers, PROBLEMS } = require('../server/business/suppliers');
const { SupplierUsage, opensAtText } = require('../server/business/usage');
const { withCompany, currentScope } = require('../server/business/scope');
const { SEARCH_CLOSED } = require('../server/business/source');
const { KINDS, SUPPLIER_CAPS } = require('../server/business/constants');
const { LIVE_RIBBON, NO_SUPPLIER } = require('../server/views/business/parts');
const { id: newId } = require('../server/lib/ids');

const ROOT = path.join(__dirname, '..');
const ADMIN_EMAIL = 'ops@example.com';
const TODAY = FIXED_NOW.slice(0, 10);
const pgUrl = process.env.TEST_DATABASE_URL;
const STORES = [['MemoryStore', null], ['PostgresStore', pgUrl || null]];
const skipFor = (name, url) => name === 'PostgresStore' && !url && 'TEST_DATABASE_URL not set';

const qs = q => new URLSearchParams(q).toString();
const mainOf = page => (page.match(/<main\b[\s\S]*<\/main>/) || [''])[0];
const textMain = page => textOf(mainOf(page));
/** The Suppliers panel of /admin/business. */
const panelOf = page => (page.match(/<section[^>]*aria-labelledby="bz-plat-live"[\s\S]*?<\/section>/) || [''])[0];
/** One way, CAI to LHR on Thursday 12 November, 2 nights in London, Economy, dates fixed. */
const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '', hotel: '1', nights: '2', cabin: 'economy', flex: '0' });
const Q_FLIGHTS = Object.freeze({ ...Q, hotel: '0', nights: '' });
const REASON = 'The client workshop starts at 14:00 and this is the only fare that lets me change the flight.';
/** The ZZ1234 Flexible fare (over the Standard policy) and Paddington Lodge's Double Room, as live rows. */
const FLEX = 'f.flt_l.ZZ1234_20261112T0835_economy|flexible';
const LODGE = 'h.htl_l.lp1004|double-room-ro-n';
const formFor = (out, hotelKey) => ({ ...Q, out, hotelKey, hotelChoice: '1', purpose: 'Client workshop in London' });
const FQ = Object.freeze({ from: 'CAI', to: 'LHR', departDate: '2026-11-12', passengers: 1, cabin: 'economy' });
const HQ = Object.freeze({ where: 'Cairo', country: 'Egypt', checkIn: '2026-11-12', checkOut: '2026-11-14', guests: 1 });
const FLIGHTS_DOWN = 'Flights are not available right now. Please try again in a few minutes.';
const CHECK_NEEDED = 'Run the live check first. Live search turns on only after a check that passed for the keys in place, in the last 24 hours.';

/** Move a mutableClock by milliseconds. */
const tick = (clock, ms) => clock.set(new Date(clock.now().getTime() + ms).toISOString());

/** Obviously fake live keys, made at run time: no test prefix, so a live stack takes them. */
const liveKeys = () => ({
  token: `fake-live-token-${crypto.randomBytes(16).toString('hex')}`,
  apiKey: `fake-live-key-${crypto.randomBytes(16).toString('hex')}`,
});

/** www's supplier settings (infra/app.yaml) with these keys, and generous request limits for the tests. */
const liveEnv = keys => ({
  ENABLE_BUSINESS: 'true', BUSINESS_FLIGHT_SUPPLIER: 'duffel', BUSINESS_HOTEL_SUPPLIER: 'liteapi',
  BUSINESS_SUPPLIER_LIVE: 'true', BUSINESS_ALLOW_SUPPLIER_TEST: 'false',
  DUFFEL_ACCESS_TOKEN: keys.token, LITEAPI_API_KEY: keys.apiKey,
  ADMIN_EMAILS: ADMIN_EMAIL, BUSINESS_WRITE_LIMIT: '1000', BUSINESS_COMPUTE_LIMIT: '1000',
});

/**
 * What must never show: each key, every 12-character piece of its random part, and the key print's hex.
 * @param {{ token: string, apiKey: string }} keys
 */
function secretsOf(keys) {
  const pieces = [];
  const prints = [];
  for (const k of [keys.token, keys.apiKey]) {
    pieces.push(k);
    const rnd = k.slice(k.lastIndexOf('-') + 1);
    for (let i = 0; i + 12 <= rnd.length; i += 1) pieces.push(rnd.slice(i, i + 12));
  }
  const print = loadConfig({ APP_ENV: 'development', ...liveEnv(keys) }).business.suppliers.keyPrint;
  assert.match(print, /^duffel:[0-9a-f]{8} liteapi:[0-9a-f]{8}$/);
  for (const part of print.split(' ')) prints.push(part.split(':')[1]);
  return { pieces, prints };
}

function assertNoSecret(label, text, secrets) {
  const s = String(text);
  for (const p of secrets.pieces) assert.ok(!s.includes(p), `${label}: a key or a piece of one`);
  for (const h of secrets.prints) assert.doesNotMatch(s, new RegExp(`(?<![0-9a-f])${h}(?![0-9a-f])`), `${label}: a key print`);
}

/**
 * Run `fn(open)` where open() gives the store a (re)started app uses: the same MemoryStore each time, or a new
 * PostgresStore on a schema of this run's own (dropped after), as a new task or a restart connects again.
 */
async function withStores(url, fn) {
  if (!url) {
    const mem = new MemoryStore();
    return fn(async () => mem);
  }
  const schema = `live_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const own = new URL(url);
  own.searchParams.set('options', `-c search_path=${schema}`);
  const opened = [];
  const open = async () => {
    const s = new PostgresStore({ connectionString: own.toString(), ssl: false });
    await s.init();
    opened.push(s);
    return s;
  };
  try {
    return await fn(open);
  } finally {
    for (const s of opened) await s.close().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

// ---------------------------------------------------------------------------------------------------------
// The world: the app on live keys over the supplier double, a platform admin, and companies.

/**
 * @param {{ open?: () => Promise<object>, clock?: object, keys?: object, env?: object }} [opts]
 * @returns {Promise<object>} w: app (the current task), boot() (another task on the same store), restart(),
 *   close(), ff, double, state, scopes (the company of each supplier call), pages (every page a browser got),
 *   log, keys, secrets, tamper (null, or (url, body) → body to change an answer)
 */
async function world({ open = async () => new MemoryStore(), clock = mutableClock(FIXED_NOW), keys = liveKeys(), env = {} } = {}) {
  const double = supplierDouble(clock, { live: true });
  const log = captureLog();
  const w = {
    clock, double, state: double.state, log, keys, secrets: secretsOf(keys), scopes: [], pages: [], tamper: null, tasks: [],
    ff: fakeFetch(double.routes, keys),
  };
  w.fetch = async (url, init) => {
    const s = currentScope();
    w.scopes.push(s ? s.orgId : null);
    const res = await w.ff.fetch(url, init);
    if (!w.tamper) return res;
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON: as it came */ }
    const out = body === null ? text : JSON.stringify(w.tamper(String(url), body) ?? body);
    return new globalThis.Response(out, { status: res.status, headers: res.headers });
  };
  w.boot = async () => {
    const store = await open();
    const app = await startApp({ ...liveEnv(w.keys), ...env }, { now: clock.now, store, log, businessFetch: w.fetch });
    w.tasks.push(app);
    return app;
  };
  /** Stop this task and start a new one (a restart or a deploy), on the same store; new keys when given. */
  w.restart = async ({ keys: next = null } = {}) => {
    await w.app.close();
    w.tasks = w.tasks.filter(a => a !== w.app);
    if (next) {
      w.keys = next;
      w.ff = fakeFetch(double.routes, next);
      w.secrets = { pieces: [...w.secrets.pieces, ...secretsOf(next).pieces], prints: [...w.secrets.prints, ...secretsOf(next).prints] };
    }
    w.app = await w.boot();
    return w.app;
  };
  w.close = async () => {
    for (const a of w.tasks) await a.close();
    w.tasks = [];
  };
  w.inv = () => w.app.business.inventory;
  w.repo = () => new Repo({ store: w.app.store, now: clock.now });
  w.app = await w.boot();
  return w;
}

/** A browser for one person: its pages are kept for the leak checks; `on` is the task it talks to. */
function browser(w, who, on = () => w.app) {
  const keep = (p, res) => {
    w.pages.push({ label: p, who: who.user.email, text: res.text, headers: [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n') });
    return res;
  };
  return {
    get: async (p, opts) => keep(p, await client(on().base, who.cookie).get(p, opts)),
    post: async (p, form, opts) => keep(p, await client(on().base, who.cookie).post(p, form, opts)),
  };
}

/** A company as in test/business-suppliers-e2e.test.js: an Owner, Dana the Manager, Sam her report, a Q4 budget. */
async function company(w, name, { status = 'active', timezone } = {}) {
  const app = w.app;
  const owner = await seedUser(app, { name: `${name} Owner` });
  const org = await seedOrg(app, owner, { name, status, ...(timezone ? { timezone } : {}) });
  const eng = await seedDepartment(app, org, { name: 'Engineering' });
  const dana = await seedMember(app, org, 'manager', { name: 'Dana Lee', departmentId: eng.id });
  const sam = await seedMember(app, org, 'employee', { name: 'Sam Rivera', departmentId: eng.id, managerId: dana.user.id });
  await seedBudget(app, org, eng.id, { periodKey: '2026-Q4', amountCents: 2000000 });
  return { org, eng, owner, dana, sam, B: `/business/o/${org.id}`, c: { owner: browser(w, owner), dana: browser(w, dana), sam: browser(w, sam) } };
}

/** The platform admin (ADMIN_EMAILS and the platform_admin record): a browser. */
async function platformAdmin(w) {
  const ops = await seedUser(w.app, { name: 'Pat Platform', email: ADMIN_EMAIL });
  await w.app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
  return { ...browser(w, ops), user: ops.user };
}

/** Press "Turn on live search" or "Turn off live search" from the panel as it is now. */
async function turn(admin, on) {
  const page = await admin.get('/admin/business');
  assert.equal(page.status, 200);
  const form = page.text.match(new RegExp(`action="/admin/business/suppliers/live">\\s*<input type="hidden" name="on" value="${on ? 1 : 0}"><input type="hidden" name="rev" value="(\\d+)">`));
  assert.ok(form, `a turn ${on ? 'on' : 'off'} form on the panel`);
  return admin.post('/admin/business/suppliers/live', { on: on ? '1' : '0', rev: form[1] });
}

/** Check live connection, then turn live search on. */
async function goLive(w, admin) {
  let res = await admin.post('/admin/business/suppliers/check', {});
  assert.equal(res.location, '/admin/business?ok=check_passed', textMain(res.text).slice(0, 300));
  res = await turn(admin, true);
  assert.equal(res.location, '/admin/business?ok=live_on', textMain(res.text).slice(0, 300));
  assert.equal(w.inv().status, 'live');
}

/** POST /trips answered 303 to the new request: its id. */
async function createDraft(co, form, who = co.c.sam) {
  const res = await who.post(`${co.B}/trips`, form);
  assert.equal(res.status, 303, textMain(res.text).slice(0, 400));
  const m = res.location.match(new RegExp(`^${co.B}/trips/(btr_[A-Za-z0-9_-]+)$`));
  assert.ok(m, res.location);
  return m[1];
}

const revOf = (page, action) => {
  const form = page.match(new RegExp(`<form[^>]*action="[^"]*/${action}"[\\s\\S]*?</form>`));
  assert.ok(form, `a ${action} form`);
  return form[0].match(/name="rev" value="(\d+)"/)[1];
};

/** Every radio key a results page offers for `name` ('out', 'hotelKey'). */
const radioKeys = (page, name) => [...mainOf(page).matchAll(new RegExp(`type="radio"[^>]*name="${name}"[^>]*value="([^"]*)"`, 'g'))].map(m => m[1]);

/**
 * Nothing leaked: the calls carried the keys only in their headers; no key, piece of one or key print in any
 * page, header or log line; no supplier name on any page a company member saw; no supplier id crossed companies.
 */
function assertClean(w) {
  w.ff.assertClean();
  assert.deepEqual(w.double.crossed, [], 'every supplier id was used by the company it was served to');
  for (const p of w.pages) {
    assertNoSecret(`${p.label} (${p.who})`, `${p.headers}\n${p.text}`, w.secrets);
    if (p.who !== ADMIN_EMAIL) assert.doesNotMatch(p.text, /duffel|liteapi/i, `${p.label} (${p.who}): a supplier's name`);
  }
  assertNoSecret('the log', w.log.text(), w.secrets);
}

// ---------------------------------------------------------------------------------------------------------
// The answers on live keys

test('live keys: live_mode true and sandbox false are live rows; false, true or a missing flag latches the supplier and tells the inventory', async () => {
  const keys = liveKeys();
  const cfg = loadConfig({ APP_ENV: 'development', ...liveEnv(keys) }).business.suppliers;
  assert.equal(cfg.live, true);
  assert.equal(cfg.problem, null);
  assert.equal(cfg.allowTest, false, 'BUSINESS_ALLOW_SUPPLIER_TEST is off by default on a live stack');
  assert.deepEqual(cfg.keyState, { duffel: 'set', liteapi: 'set' });
  const org = newId('org');
  const clock = mutableClock(FIXED_NOW);
  const make = routes => {
    const ff = fakeFetch(routes, keys);
    const told = [];
    const log = captureLog();
    const s = createBusinessSuppliers(cfg, { fetch: ff.fetch, now: clock.now, log, ...airportLookups(), sleep: async () => {}, onMismatch: x => told.push(x) });
    return { s, ff, told, log };
  };
  const inScope = fn => withCompany(org, fn, { confirmed: true, timezone: 'Africa/Cairo' });

  // The fixtures that say live: rows in the live namespace, not demo.
  let k = make([
    { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.live-mode-true.json' },
    { method: 'POST', url: RATES, reply: 'liteapi/rates.sandbox-mismatch.json' },
  ]);
  assert.equal(k.s.mode, 'live');
  assert.equal(k.s.flights.isDemo, false);
  assert.equal(k.s.hotels.isDemo, false);
  const flights = await inScope(() => k.s.flights.search(FQ));
  assert.ok(flights.length > 0);
  for (const o of flights) assert.match(o.id, /^flt_l\./);
  const hotels = await inScope(() => k.s.hotels.search(HQ));
  assert.ok(hotels.length > 0);
  for (const h of hotels) assert.match(h.id, /^htl_l\./);
  assert.deepEqual(k.told, []);
  assert.equal(k.s.state.isLatched(), false);
  assert.equal(k.s.problem, null);
  k.ff.assertClean();

  // live_mode false (a test system), and live_mode missing: Duffel latches off and the inventory is told once.
  for (const reply of ['duffel/offer-request.cai-lhr.json', 'duffel/offer-request.live-mode-missing.json']) {
    k = make([{ method: 'POST', url: OFFER_REQUESTS, reply }]);
    await assert.rejects(inScope(() => k.s.flights.search(FQ)), e => e.code === 'supplier_unavailable' && e.message === FLIGHTS_DOWN, reply);
    await assert.rejects(inScope(() => k.s.flights.search({ ...FQ, departDate: '2026-11-13' })), e => e.code === 'supplier_unavailable', `${reply}: stays off`);
    assert.equal(k.ff.calls.length, 1, `${reply}: nothing more is asked once latched`);
    assert.deepEqual(k.told, ['duffel'], reply);
    assert.equal(k.s.problem, null, 'on live keys the Suppliers panel says what happened, not the problem line');
    assert.ok(k.log.lines.some(l => /"outcome":"mode_mismatch"/.test(l.text)), reply);
    assertNoSecret(`${reply}: the log`, k.log.text(), secretsOf(keys));
  }
  // sandbox true (LiteAPI's test system), and sandbox missing: LiteAPI latches off.
  const missing = body => { delete body.sandbox; return body; };
  for (const reply of ['liteapi/rates.cairo.json', { fixture: 'liteapi/rates.sandbox-mismatch.json', transform: missing }]) {
    k = make([{ method: 'POST', url: RATES, reply }]);
    await assert.rejects(inScope(() => k.s.hotels.search(HQ)), e => e.code === 'supplier_unavailable');
    assert.deepEqual(k.told, ['liteapi']);
  }
});

test('test prefixes are refused on a live stack, never test data; live keys are refused where only test keys go', async t => {
  const keys = liveKeys();
  const live = { APP_ENV: 'development', ...liveEnv(keys) };
  const cases = [
    [{ DUFFEL_ACCESS_TOKEN: `duffel_test_${'FAKE'.repeat(8)}` }, 'DUFFEL_ACCESS_TOKEN is a test token; this site takes live keys only.', { duffel: 'test_key', liteapi: 'set' }],
    [{ LITEAPI_API_KEY: `sand_${'FAKE'.repeat(8)}` }, 'LITEAPI_API_KEY is a sandbox key; this site takes live keys only.', { duffel: 'set', liteapi: 'test_key' }],
    [{ BUSINESS_ALLOW_SUPPLIER_TEST: 'true' }, 'BUSINESS_ALLOW_SUPPLIER_TEST must not be true when BUSINESS_SUPPLIER_LIVE is true.', { duffel: 'set', liteapi: 'set' }],
    [{ DUFFEL_ACCESS_TOKEN: 'unset' }, 'DUFFEL_ACCESS_TOKEN is not set.', { duffel: 'not_set', liteapi: 'set' }],
    [{ LITEAPI_API_KEY: 'unset' }, 'LITEAPI_API_KEY is not set.', { duffel: 'set', liteapi: 'not_set' }],
    [{ DUFFEL_ACCESS_TOKEN: 'fake live token with spaces' }, 'DUFFEL_ACCESS_TOKEN is not a Duffel access token.', { duffel: 'not_valid', liteapi: 'set' }],
  ];
  for (const [change, problem, keyState] of cases) {
    const s = loadConfig({ ...live, ...change }).business.suppliers;
    assert.equal(s.problem, problem, problem);
    assert.deepEqual({ ...s.keyState }, keyState, problem);
    assert.equal(s.duffelToken, undefined, `${problem}: no key handed on`);
    assert.equal(s.keyPrint, undefined, `${problem}: no key print`);
    const inv = createBusinessInventory(loadConfig({ ...live, ...change }), { fetch: fakeFetch([]).fetch, now: () => new Date(FIXED_NOW), log: captureLog(), repo: null });
    assert.deepEqual([inv.status, inv.flights, inv.hotels, inv.source, inv.liveMode], ['none', null, null, null, true], problem);
    assert.equal(inv.problem, problem);
  }
  // The same keys where only test keys go (round 1, the preview): refused the other way.
  const sandbox = loadConfig({ ...live, BUSINESS_SUPPLIER_LIVE: 'false', BUSINESS_ALLOW_SUPPLIER_TEST: 'true' }).business.suppliers;
  assert.equal(sandbox.problem, 'DUFFEL_ACCESS_TOKEN is not a Duffel test token.');
  // createBusinessSuppliers checks the prefixes again on its own, whatever config handed it.
  const log = captureLog();
  const now = () => new Date(FIXED_NOW);
  const base = { configured: true, flights: 'duffel', hotels: 'liteapi', live: true, problem: null };
  assert.equal(createBusinessSuppliers({ ...base, duffelToken: `duffel_test_${'x'.repeat(20)}`, liteapiKey: keys.apiKey }, { now, log }).problem, PROBLEMS.duffelLive);
  assert.equal(createBusinessSuppliers({ ...base, duffelToken: keys.token, liteapiKey: `sand_${'x'.repeat(20)}` }, { now, log }).problem, PROBLEMS.liteapiLive);
  const ok = createBusinessSuppliers({ ...base, duffelToken: keys.token, liteapiKey: keys.apiKey }, { now, log });
  assert.equal(ok.mode, 'live');
  assert.ok(ok.flights && ok.hotels);

  // Over HTTP: status 'none', no supplier call, and the panel says "Test key refused" without the key.
  const w = await world({ env: { DUFFEL_ACCESS_TOKEN: `duffel_test_${'FAKE'.repeat(8)}` } });
  t.after(w.close);
  const co = await company(w, 'Acme Inc');
  const admin = await platformAdmin(w);
  assert.equal(w.inv().status, 'none');
  let res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 503);
  assert.ok(textOf(res.text).includes(NO_SUPPLIER.title));
  res = await admin.get('/admin/business');
  const panel = textOf(panelOf(res.text));
  assert.match(panel, /Duffel \(flights\)\s*Test key refused\s*This site takes live keys only\./);
  assert.match(panel, /A supplier setting needs attention: DUFFEL_ACCESS_TOKEN is a test token; this site takes live keys only\./);
  assert.doesNotMatch(res.text, /Check live connection|Turn on live search/, 'nothing to check with a refused key');
  assert.doesNotMatch(res.text, /duffel_test_|FAKEFAKE/, 'the refused key never shows');
  res = await admin.post('/admin/business/suppliers/check', {});
  assert.equal(res.status, 409);
  assert.match(textOf(res.text), /Live search needs both supplier keys in place first\./);
  assert.equal(w.ff.calls.length, 0);
  assertClean(w);
});

// ---------------------------------------------------------------------------------------------------------
// End to end

test('end to end on the supplier double: check, turn on, search, request, submit, decide, turn off', async t => {
  const w = await world();
  t.after(w.close);
  const co = await company(w, 'Acme Inc');
  const admin = await platformAdmin(w);
  const inv = w.inv();
  assert.equal(inv.liveMode, true);
  assert.equal(inv.status, 'none', 'off until a platform admin turns it on');

  // Off: "Supplier not connected yet", and nothing calls a supplier.
  let res = await co.c.sam.get(`${co.B}/trips/new`);
  assert.equal(res.status, 200);
  assert.ok(textMain(res.text).includes(NO_SUPPLIER.title));
  res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 503);
  assert.equal(w.ff.calls.length, 0);

  // The Suppliers panel before any check.
  res = await admin.get('/admin/business');
  assert.equal(res.status, 200);
  noInline('/admin/business', res.text);
  let panel = textOf(panelOf(res.text));
  assert.match(panel, /^Suppliers\s*Live search is off/);
  assert.match(panel, /Live search is off\. Companies see "Supplier not connected yet"\./);
  assert.match(panel, /Duffel \(flights\)\s*Ready to check/);
  assert.match(panel, /LiteAPI \(hotels\)\s*Ready to check/);
  assert.match(panel, /No live check has run yet\./);
  assert.match(panel, /Calls today: 0 of 500\. Each company can make up to 100\./);
  assert.match(res.text, /action="\/admin\/business\/suppliers\/check"/);
  assert.doesNotMatch(res.text, /Turn on live search/);
  assert.doesNotMatch(res.text, /—/, 'no em dash');
  // A forged "turn on" with no check: refused, nothing written.
  res = await admin.post('/admin/business/suppliers/live', { on: '1', rev: '0' });
  assert.equal(res.status, 409);
  assert.ok(textOf(res.text).includes(CHECK_NEEDED));
  assert.equal(await w.repo().supplierSwitch(), null);

  // Check live connection: one offer request (CAI to DXB, 30 days ahead, economy, 1 adult), one GET of its
  // cheapest offer, one rates call for Dubai, all as the platform.
  res = await admin.post('/admin/business/suppliers/check', {});
  assert.equal(res.status, 303);
  assert.equal(res.location, '/admin/business?ok=check_passed');
  assert.deepEqual(opsOf(w.ff.calls).sort(), ['offer_get', 'offer_request', 'rates']);
  const orq = w.ff.calls.find(c => c.url.startsWith(OFFER_REQUESTS)).body.data;
  assert.deepEqual([orq.slices.length, orq.slices[0].origin, orq.slices[0].destination, orq.slices[0].departure_date], [1, 'CAI', 'DXB', '2026-11-08']);
  assert.deepEqual([orq.cabin_class, orq.passengers.length], ['economy', 1]);
  const rates = w.ff.calls.find(c => c.url.startsWith(RATES)).body;
  assert.deepEqual([rates.cityName, rates.checkin, rates.checkout], ['Dubai', '2026-11-09', '2026-11-10']);
  assert.deepEqual([...new Set(w.scopes)], ['platform'], 'the check runs as the platform, never as a company');
  // Its calls count against today's totals, as the company 'platform'.
  const usage = await w.repo().supplierUsage(TODAY);
  assert.ok(usage.duffel.companies.platform >= 2 && usage.duffel.total >= 2, 'both Duffel calls counted');
  assert.ok(usage.liteapi.companies.platform >= 1, 'the rates call counted');
  assert.equal(inv.status, 'none', 'a passing check alone turns nothing on');

  res = await admin.get('/admin/business?ok=check_passed');
  assert.ok(textMain(res.text).includes('Done. The live check passed. You can turn live search on.'));
  panel = textOf(panelOf(res.text));
  assert.match(panel, /Last live check: Passed at 9:00 AM, Fri 9 Oct \(UTC\)\./);
  assert.match(panel, /Search\s*CAI to DXB, 2026-11-08, economy, 1 adult/);
  assert.match(panel, /Duffel offer request\s*answered: yes · live mode: yes · (\d+) of \1 fares in US dollars, 1 in another currency left out · every row checked: yes/);
  assert.match(panel, /Duffel offer check\s*answered: yes · live mode: yes · still available: yes/);
  assert.match(panel, /LiteAPI rates\s*answered: yes · test mode: no · (\d+) of \1 rooms in US dollars, 0 in another currency left out · every row checked: yes/);
  assert.match(panel, /Duffel \(flights\)\s*Checked, ready to turn on/);
  assert.match(panel, /Calls today: \d+ of 500\. Each company can make up to 100\./);
  assert.doesNotMatch(panel, /\$|USD \d|off_|offer_|Marina Lodge|Example Air/, 'counts and yes or no only: no price, name or id');

  // Turn on.
  res = await turn(admin, true);
  assert.equal(res.location, '/admin/business?ok=live_on');
  assert.equal(inv.status, 'live');
  assert.equal(inv.source, 'live');
  res = await admin.get(res.location);
  assert.ok(textMain(res.text).includes('Done. Live search is on. Confirmed companies now search live prices.'));
  panel = textOf(panelOf(res.text));
  assert.match(panel, /^Suppliers\s*Live search is on/);
  assert.match(panel, /Booking is not open, so nothing is booked or charged\./);
  assert.match(panel, /Duffel \(flights\)\s*Live/);
  assert.match(panel, /LiteAPI \(hotels\)\s*Live/);
  assert.match(res.text, /Turn off live search/);
  assert.doesNotMatch(res.text, /Turn on live search/);
  assert.match(panel, /What was done lately.*Turned live search on.*Live check passed/);

  // Sam searches live prices: live rows, labelled live, no test or demo words, as Acme Inc.
  let before = w.ff.calls.length;
  res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200, textMain(res.text).slice(0, 300));
  noInline('results', res.text);
  assert.ok(textOf(res.text).includes(LIVE_RIBBON));
  assertSourceMoney(mainOf(res.text), 'live', { label: 'results', min: 4 });
  assert.doesNotMatch(res.text, /TEST DATA|Demo price|\bsandbox\b/i);
  const outs = radioKeys(res.text, 'out');
  const rooms = radioKeys(res.text, 'hotelKey').filter(Boolean);
  assert.ok(outs.includes(FLEX), outs.join(' '));
  assert.ok(rooms.includes(LODGE), rooms.join(' '));
  assert.ok(outs.every(k => k.startsWith('f.flt_l.')) && rooms.every(k => k.startsWith('h.htl_l.')), 'every row is live');
  assert.deepEqual(opsOf(w.ff.calls.slice(before)).sort(), ['offer_request', 'rates']);
  assert.deepEqual([...new Set(w.scopes.slice(before))], [co.org.id]);

  // Request and submit (the Flexible fare is over the policy: a reason).
  const rid = await createDraft(co, formFor(FLEX, LODGE));
  res = await co.c.sam.get(`${co.B}/trips/${rid}`);
  assert.equal(res.status, 200);
  assertSourceMoney(mainOf(res.text), 'live', { label: 'request', min: 1 });
  res = await co.c.sam.post(`${co.B}/trips/${rid}/submit`, { rev: revOf(mainOf(res.text), 'submit'), reason: REASON, category: 'client_meeting' });
  assert.equal(res.location, `${co.B}/trips/${rid}?ok=submitted`, textMain(res.text).slice(0, 300));

  // Dana approves: the final check asks the suppliers again, and never prebooks a room.
  before = w.ff.calls.length;
  res = await co.c.dana.get(`${co.B}/trips/${rid}`);
  assert.equal(res.status, 200);
  res = await co.c.dana.post(`${co.B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(mainOf(res.text), 'decide') });
  assert.equal(res.location, `${co.B}/trips/${rid}?ok=approved`, textMain(res.text).slice(0, 300));
  const decided = opsOf(w.ff.calls.slice(before));
  assert.ok(decided.includes('offer_get'), `the fare is checked again: ${decided.join(' ')}`);
  assert.ok(decided.includes('rates_hotel'), `the room is checked again: ${decided.join(' ')}`);
  assert.ok(!opsOf(w.ff.calls).includes('prebook'), 'no prebook at L2: it would hold a real room');
  res = await co.c.sam.get(`${co.B}/trips/${rid}`);
  assert.ok(textMain(res.text).includes("Approved. Booking in Tripelyx isn't open yet, so this fare is not held and can change."));
  assertSourceMoney(mainOf(res.text), 'live', { label: 'approved request', min: 1 });

  // Turn off: status 'none' at once, and nothing more is asked.
  res = await turn(admin, false);
  assert.equal(res.location, '/admin/business?ok=live_off');
  assert.equal(inv.status, 'none');
  res = await admin.get(res.location);
  assert.ok(textMain(res.text).includes('Done. Live search is off. Companies see "Supplier not connected yet".'));
  assert.match(textOf(panelOf(res.text)), /What was done lately.*Turned live search off/);
  before = w.ff.calls.length;
  res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 503);
  assert.ok(textOf(res.text).includes(NO_SUPPLIER.title));
  res = await co.c.sam.get(`${co.B}/trips/${rid}`);
  assert.equal(res.status, 200, 'the approved request still opens, with its stored prices');
  res = await co.c.dana.get(`${co.B}/trips/${rid}`);
  assert.equal(res.status, 200);
  assert.equal(w.ff.calls.length, before, 'no supplier call once live search is off');

  // The platform audit: what was done, by whom, in order.
  const audit = (await w.repo().listPlatformAudit({ limit: 10 })).map(e => [e.action, e.summary, e.actor.platformAdmin === admin.user.id]);
  assert.deepEqual(audit.reverse(), [
    ['suppliers.checked', 'Live check passed', true],
    ['suppliers.live_on', 'Turned live search on', true],
    ['suppliers.live_off', 'Turned live search off', true],
  ]);
  assertClean(w);
});

// ---------------------------------------------------------------------------------------------------------
// A mode mismatch turns the stored switch off

for (const [storeName, url] of STORES) {
  test(`a mode mismatch turns the stored switch off: every task follows within 30 seconds, a restart keeps it off, and only a new check turns it on (${storeName})`, {
    skip: skipFor(storeName, url), timeout: 120000,
  }, async () => {
    await withStores(url, async open => {
      const w = await world({ open });
      try {
        const co = await company(w, 'Acme Inc');
        const admin = await platformAdmin(w);
        await goLive(w, admin);
        // A second task on the same store: it reads the switch when it starts.
        const other = await w.boot();
        assert.equal(other.business.inventory.status, 'live');
        const samThere = browser(w, co.sam, () => other);

        // Duffel answers the second task's search in test mode: that task is off at once, and the stored switch
        // is turned off.
        w.state.mode = 'test';
        let before = w.ff.calls.length;
        let res = await samThere.get(`${co.B}/trips/search?${qs(Q_FLIGHTS)}`);
        assert.equal(res.status, 503, textMain(res.text).slice(0, 300));
        assert.ok(textMain(res.text).includes(FLIGHTS_DOWN));
        assert.deepEqual(opsOf(w.ff.calls.slice(before)), ['offer_request']);
        assert.equal(other.business.inventory.status, 'none');
        await other.business.inventory.flush();
        const sw = await w.repo().supplierSwitch();
        assert.equal(sw.on, false);
        assert.equal(sw.offReason, 'mismatch');
        assert.deepEqual(sw.mismatch, { at: FIXED_NOW, supplier: 'duffel' });
        const off = (await w.repo().listPlatformAudit({ limit: 10 })).find(e => e.action === 'suppliers.live_off');
        assert.deepEqual(off.actor, { system: 'mode_check' });
        assert.equal(off.summary, 'Live search turned off: Duffel answered in test mode');

        // The first task: on from its 30-second read of the switch, then off once it reads it again.
        assert.equal(w.inv().status, 'live');
        tick(w.clock, 31 * 1000);
        before = w.ff.calls.length;
        res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q_FLIGHTS)}`);
        assert.equal(res.status, 503);
        assert.ok(textOf(res.text).includes(NO_SUPPLIER.title));
        assert.equal(w.inv().status, 'none');
        assert.equal(w.ff.calls.length, before);

        // The panel says when and why; the check from before no longer counts.
        res = await admin.get('/admin/business');
        let panel = textOf(panelOf(res.text));
        assert.match(panel, /Duffel \(flights\)\s*Turned off after a mode mismatch at 9:00 AM, Fri 9 Oct \(UTC\)\s*It answered in test mode\./);
        assert.match(panel, /Last live check: Passed at 9:00 AM, Fri 9 Oct \(UTC\)\. A supplier answered in test mode after it, so it no longer counts\./);
        assert.doesNotMatch(res.text, /Turn on live search/);
        assert.match(panel, /What was done lately.*Live search turned off: Duffel answered in test mode/);

        // A restart (a deploy) keeps it off, with live answers again: nothing is asked.
        w.state.mode = 'live';
        await w.restart();
        assert.equal(w.inv().status, 'none');
        before = w.ff.calls.length;
        res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
        assert.equal(res.status, 503);
        assert.equal(w.ff.calls.length, before);
        res = await admin.post('/admin/business/suppliers/live', { on: '1', rev: String(sw.rev) });
        assert.equal(res.status, 409);
        assert.ok(textOf(res.text).includes(CHECK_NEEDED));
        assert.equal((await w.repo().supplierSwitch()).on, false);

        // A new passing check, then on: this task at once, and the latched task once it reads the switch again.
        await goLive(w, admin);
        assert.equal(other.business.inventory.status, 'none', 'still latched until it reads the switch');
        tick(w.clock, 31 * 1000);
        res = await samThere.get(`${co.B}/trips/search?${qs(Q)}`);
        assert.equal(res.status, 200, textMain(res.text).slice(0, 300));
        assert.equal(other.business.inventory.status, 'live');
        res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
        assert.equal(res.status, 200);
        panel = textOf(panelOf((await admin.get('/admin/business')).text));
        assert.match(panel, /Duffel \(flights\)\s*Live/);
        assertClean(w);
      } finally {
        await w.close();
      }
    });
  });
}

test('a mismatch in the live check itself turns live search off; a missing live_mode is a mismatch too', async t => {
  const w = await world();
  t.after(w.close);
  const co = await company(w, 'Acme Inc');
  const admin = await platformAdmin(w);
  await goLive(w, admin);
  // The offer request says nothing about its mode.
  w.tamper = (url, body) => {
    if (url.startsWith(OFFER_REQUESTS)) {
      delete body.data.live_mode;
      for (const o of body.data.offers) delete o.live_mode;
    }
    return body;
  };
  let res = await admin.post('/admin/business/suppliers/check', {});
  assert.equal(res.location, '/admin/business?ok=check_mismatch');
  assert.equal(w.inv().status, 'none');
  assert.ok(!opsOf(w.ff.calls.slice(-1)).includes('offer_get'), 'no GET after a mismatch');
  const sw = await w.repo().supplierSwitch();
  assert.deepEqual([sw.on, sw.offReason, sw.mismatch.supplier, sw.lastCheck.passed], [false, 'mismatch', 'duffel', false]);
  res = await admin.get(res.location);
  assert.ok(textMain(res.text).includes('A supplier answered in test mode, so live search is off. Check the key in AWS, then run the live check again.'));
  const panel = textOf(panelOf(res.text));
  assert.match(panel, /Last live check: Did not pass at/);
  assert.match(panel, /Duffel offer request\s*answered in test mode, so nothing it sent was used\s*Duffel offer check\s*answered: no/);
  assert.match(panel, /Duffel \(flights\)\s*Turned off after a mode mismatch at 9:00 AM, Fri 9 Oct \(UTC\)/);
  assert.match(panel, /What was done lately.*Live check: Duffel answered in test mode, so live search is off/);
  // A company's search: off, nothing asked.
  const before = w.ff.calls.length;
  res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 503);
  assert.equal(w.ff.calls.length, before);
  // The answers are live again: a new passing check (a minute later), and on.
  w.tamper = null;
  tick(w.clock, 60 * 1000);
  await goLive(w, admin);
  assertClean(w);
});

// ---------------------------------------------------------------------------------------------------------
// The switch needs a passing check for the keys in place, in the last 24 hours, at most 3 checks an hour

for (const [storeName, url] of STORES) {
  test(`the switch turns on only after a passing check for the current key print, in the last 24 hours; at most 3 checks an hour (${storeName})`, {
    skip: skipFor(storeName, url), timeout: 120000,
  }, async () => {
    await withStores(url, async open => {
      const w = await world({ open });
      try {
        const admin = await platformAdmin(w);
        const actor = { platformAdmin: admin.user.id };
        // No check: refused.
        await assert.rejects(w.inv().setLive(true, { actor, rev: 0 }), e => e.code === 'live_check_needed' && e.status === 409 && e.message === CHECK_NEEDED);

        // A check that fails (Duffel down): refused, and the panel says it did not pass.
        w.state.flights = 'down';
        let res = await admin.post('/admin/business/suppliers/check', {});
        assert.equal(res.location, '/admin/business?ok=check_failed');
        res = await admin.get(res.location);
        assert.ok(textMain(res.text).includes('The live check did not pass, so live search stays off. What it found is under Suppliers.'));
        assert.match(textOf(panelOf(res.text)), /Last live check: Did not pass at 9:00 AM, Fri 9 Oct \(UTC\)\.\s*Search[\s\S]*Duffel offer request\s*no answer \(supplier_unavailable\)/);
        assert.doesNotMatch(res.text, /Turn on live search/);
        let sw = await w.repo().supplierSwitch();
        await assert.rejects(w.inv().setLive(true, { actor, rev: sw.rev }), e => e.code === 'live_check_needed');

        // A passing check: on is offered.
        w.state.flights = 'up';
        tick(w.clock, 60 * 1000);
        res = await admin.post('/admin/business/suppliers/check', {});
        assert.equal(res.location, '/admin/business?ok=check_passed');
        assert.equal(w.inv().liveState().canTurnOn, true);

        // More than 24 hours later the check no longer counts.
        tick(w.clock, 24 * 60 * 60 * 1000 + 60 * 1000);
        await w.inv().sync({ force: true });
        let st = w.inv().liveState();
        assert.deepEqual([st.canTurnOn, st.lastCheck.counts, st.lastCheck.stale], [false, false, 'old']);
        sw = await w.repo().supplierSwitch();
        await assert.rejects(w.inv().setLive(true, { actor, rev: sw.rev }), e => e.code === 'live_check_needed');
        res = await admin.get('/admin/business');
        assert.match(textOf(panelOf(res.text)), /It is more than 24 hours old, so it no longer counts\./);

        // A fresh passing check, on; then a restart with other keys: status 'none', and the check is for the old keys.
        const firstAt = w.clock.now();
        res = await admin.post('/admin/business/suppliers/check', {});
        assert.equal(res.location, '/admin/business?ok=check_passed');
        res = await turn(admin, true);
        assert.equal(res.location, '/admin/business?ok=live_on');
        assert.equal(w.inv().status, 'live');
        await w.restart({ keys: liveKeys() });
        assert.equal(w.inv().status, 'none', 'the stored switch is for other keys');
        st = w.inv().liveState();
        assert.deepEqual([st.on, st.stored.on, st.stored.sameKeys, st.canTurnOn, st.lastCheck.current, st.lastCheck.stale], [false, true, false, false, false, 'keys']);
        res = await admin.get('/admin/business');
        let panel = textOf(panelOf(res.text));
        assert.match(panel, /The keys have changed since, so it no longer counts\./);
        assert.match(panel, /Live search is off/);
        assert.doesNotMatch(res.text, /Turn on live search/);
        sw = await w.repo().supplierSwitch();
        await assert.rejects(w.inv().setLive(true, { actor, rev: sw.rev }), e => e.code === 'live_check_needed');

        // Two checks for the new keys: with the one before the restart, the fourth this hour is refused before any
        // call, and a restart remembers.
        tick(w.clock, 60 * 1000);
        res = await admin.post('/admin/business/suppliers/check', {});
        assert.equal(res.location, '/admin/business?ok=check_passed');
        tick(w.clock, 60 * 1000);
        res = await admin.post('/admin/business/suppliers/check', {});
        assert.equal(res.location, '/admin/business?ok=check_passed');
        const again = new Date(firstAt.getTime() + 60 * 60 * 1000).toISOString().slice(11, 16);
        tick(w.clock, 60 * 1000);
        const before = w.ff.calls.length;
        res = await admin.post('/admin/business/suppliers/check', {});
        assert.equal(res.status, 429);
        assert.ok(textMain(res.text).includes(`The live check has run 3 times in the last hour. You can run it again at ${again} (UTC).`), textMain(res.text).slice(0, 400));
        assert.equal(w.ff.calls.length, before, 'refused before any call');
        await w.restart();
        await assert.rejects(w.inv().liveCheck({ actor }), e => e.code === 'live_check_limit' && e.status === 429);
        res = await admin.get('/admin/business');
        panel = textOf(panelOf(res.text));
        assert.match(panel, /The live check has run 3 times in the last hour\. It can run again at/);
        assert.doesNotMatch(res.text, /Check live connection/);
        // An hour after the first of them, it runs again.
        tick(w.clock, 60 * 60 * 1000);
        await w.inv().sync({ force: true });
        assert.equal((await w.inv().liveCheck({ actor })).passed, true);
        assertClean(w);
      } finally {
        await w.close();
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------------------
// The daily caps

for (const [storeName, url] of STORES) {
  test(`daily caps: per company and in all, per supplier and UTC day, counted on the store so a restart keeps them (${storeName})`, {
    skip: skipFor(storeName, url), timeout: 120000,
  }, async () => {
    await withStores(url, async open => {
      const clock = mutableClock(FIXED_NOW);
      const caps = { company: 3, total: 5, block: 1, noticeShare: 0.8 };
      const usageOn = async () => new SupplierUsage({ repo: new Repo({ store: await open(), now: clock.now }), now: clock.now, log: captureLog(), caps });
      const cairo = { orgId: newId('org'), confirmed: true, timezone: 'Africa/Cairo' };
      const la = { orgId: newId('org'), confirmed: true, timezone: 'America/Los_Angeles' };
      const limit = text => e => e.code === 'supplier_daily_limit' && e.status === 429 && e.message === text;
      let u = await usageOn();
      for (let i = 0; i < 3; i += 1) await u.take('duffel', cairo, 'flights');
      await assert.rejects(u.take('duffel', cairo, 'flights'), limit("Your company has reached today's search limit. Search opens again at 3:00 AM tomorrow (Cairo time)."));
      await u.take('liteapi', cairo, 'hotels');
      await u.take('duffel', la, 'flights');
      await u.take('duffel', la, 'flights');
      await assert.rejects(u.take('duffel', la, 'flights'), limit('Search is paused for the rest of today. It opens again at 5:00 PM today (Los Angeles time).'));
      const repo = new Repo({ store: await open(), now: clock.now });
      const day = await repo.supplierUsage(TODAY);
      assert.equal(day.duffel.total, 5);
      assert.deepEqual(day.duffel.companies, { [cairo.orgId]: 3, [la.orgId]: 2 });
      assert.equal(day.liteapi.total, 1);

      // A restart: a new task counts from the store, not from zero.
      u = await usageOn();
      await assert.rejects(u.take('duffel', cairo, 'flights'), e => e.code === 'supplier_daily_limit');
      await assert.rejects(u.take('duffel', la, 'flights'), e => e.code === 'supplier_daily_limit');
      await u.take('liteapi', la, 'hotels');
      const today = await u.today();
      assert.deepEqual([today.day, today.suppliers.duffel.total, today.suppliers.duffel.notice, today.suppliers.liteapi.total, today.suppliers.liteapi.notice], [TODAY, 5, true, 2, false]);
      // The next UTC day starts a new count.
      clock.set('2026-10-10T00:00:01.000Z');
      await u.take('duffel', cairo, 'flights');
      assert.equal((await repo.supplierUsage('2026-10-10')).duffel.total, 1);
      assert.equal((await repo.supplierUsage(TODAY)).duffel.total, 5, "yesterday's count is kept");
    });
  });
}

test('daily caps: opensAt is the next 00:00 UTC in the company zone; a store that cannot be read fails closed', async () => {
  const now = new Date(FIXED_NOW);
  assert.equal(opensAtText('2026-10-10T00:00:00.000Z', 'Africa/Cairo', now), '3:00 AM tomorrow (Cairo time)');
  assert.equal(opensAtText('2026-10-10T00:00:00.000Z', 'America/Los_Angeles', now), '5:00 PM today (Los Angeles time)');
  assert.equal(opensAtText('2026-10-10T00:00:00.000Z', 'UTC', now), '12:00 AM tomorrow (UTC)');
  assert.equal(opensAtText('2026-10-10T00:00:00.000Z', 'Not/AZone', now), '12:00 AM tomorrow (UTC)');
  const log = captureLog();
  const broken = { reserveSupplierUsage: async () => { throw new Error('the store is down'); }, supplierUsage: async () => ({}) };
  const u = new SupplierUsage({ repo: broken, now: () => now, log });
  await assert.rejects(u.take('duffel', { orgId: newId('org'), confirmed: true }, 'flights'), e => e.code === 'supplier_unavailable' && e.message === FLIGHTS_DOWN);
  assert.match(log.text(), /the daily call count could not be read or written, so the call was not made/);
  assert.equal(SUPPLIER_CAPS.company, 100);
  assert.equal(SUPPLIER_CAPS.total, 500);
});

test('daily caps: the gate counts every attempt, a retry included, and refuses an unconfirmed company before any count', async () => {
  const store = new MemoryStore();
  const clock = mutableClock(FIXED_NOW);
  const repo = new Repo({ store, now: clock.now });
  const usage = new SupplierUsage({ repo, now: clock.now, log: captureLog(), caps: { company: 100, total: 500, block: 1, noticeShare: 0.8 } });
  const org = newId('org');
  // LiteAPI's 4291 is retried once: two calls, both counted.
  let kit = supplierKit({ routes: [{ method: 'POST', url: RATES, reply: ['liteapi/error.4291.json', 'liteapi/rates.cairo.json'] }], gate: { usage, confirmedOnly: true } });
  await withCompany(org, () => kit.hotels.search(HQ), { confirmed: true, timezone: 'Africa/Cairo' });
  assert.equal(kit.ff.calls.length, 2);
  assert.deepEqual((await repo.supplierUsage(TODAY)).liteapi.companies, { [org]: 2 });
  // A Duffel offer request and a GET of one of its offers: two calls, two counted.
  kit = supplierKit({ routes: supplierDouble(clock).routes, gate: { usage, confirmedOnly: true } });
  await withCompany(org, async () => {
    const offers = await kit.flights.search(FQ);
    assert.ok(await kit.flights.getOffer(offers[0].id, { ...FQ, check: 'confirm' }, { optionId: offers[0].options[0].id }));
  }, { confirmed: true, timezone: 'Africa/Cairo' });
  assert.deepEqual(opsOf(kit.ff.calls), ['offer_request', 'offer_get']);
  assert.deepEqual((await repo.supplierUsage(TODAY)).duffel.companies, { [org]: 2 });
  // A company that is not confirmed, and a call with no company at all: refused, nothing counted, nothing sent.
  const counted = JSON.stringify(await repo.supplierUsage(TODAY));
  kit = supplierKit({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' }], gate: { usage, confirmedOnly: true } });
  await assert.rejects(withCompany(newId('org'), () => kit.flights.search(FQ), { confirmed: false }), e => e.code === 'supplier_unavailable');
  await assert.rejects(kit.flights.search(FQ), e => e.code === 'supplier_unavailable');
  assert.equal(kit.ff.calls.length, 0);
  assert.equal(JSON.stringify(await repo.supplierUsage(TODAY)), counted);
});

for (const [storeName, url] of STORES) {
  test(`daily caps over HTTP: the admin's check counts as the platform; a company at its limit or a supplier at 500 is told when search opens (${storeName})`, {
    skip: skipFor(storeName, url), timeout: 120000,
  }, async () => {
    await withStores(url, async open => {
      const w = await world({ open });
      try {
        const co = await company(w, 'Acme Inc');
        const la = await company(w, 'Westside Co', { timezone: 'America/Los_Angeles' });
        const admin = await platformAdmin(w);
        // 98 Duffel calls already counted for the platform today: the check's two take it to exactly 100.
        await w.repo().reserveSupplierUsage({ day: TODAY, supplier: 'duffel', company: 'platform', want: 98, caps: SUPPLIER_CAPS });
        await goLive(w, admin);
        assert.equal((await w.repo().supplierUsage(TODAY)).duffel.companies.platform, 100, 'the offer request and the GET, each counted');

        // Acme Inc at its 100 Duffel calls for today (counted before a restart): its search stops, Westside's goes on.
        await w.repo().reserveSupplierUsage({ day: TODAY, supplier: 'duffel', company: co.org.id, want: 100, caps: SUPPLIER_CAPS });
        await w.restart();
        let before = w.ff.calls.length;
        let res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q_FLIGHTS)}`);
        assert.equal(res.status, 429, textMain(res.text).slice(0, 300));
        assert.ok(textMain(res.text).includes("Your company has reached today's search limit. Search opens again at 3:00 AM tomorrow (Cairo time)."));
        assert.equal(w.ff.calls.length, before, 'no call over the cap');
        res = await la.c.sam.get(`${la.B}/trips/search?${qs(Q_FLIGHTS)}`);
        assert.equal(res.status, 200, textMain(res.text).slice(0, 300));

        // Every company together at 500 Duffel calls: search is paused for everyone, in each company's own time.
        const day = await w.repo().supplierUsage(TODAY);
        await w.repo().reserveSupplierUsage({ day: TODAY, supplier: 'duffel', company: 'unscoped', want: 500 - day.duffel.total, caps: { company: 500, total: 500 } });
        await w.restart();
        before = w.ff.calls.length;
        res = await la.c.sam.get(`${la.B}/trips/search?${qs({ ...Q_FLIGHTS, depart: '2026-11-13' })}`);
        assert.equal(res.status, 429);
        assert.ok(textMain(res.text).includes('Search is paused for the rest of today. It opens again at 5:00 PM today (Los Angeles time).'));
        assert.equal(w.ff.calls.length, before);
        // The panel shows the totals and the notice.
        res = await admin.get('/admin/business');
        const panel = textOf(panelOf(res.text));
        assert.match(panel, /Duffel \(flights\)[\s\S]*Calls today: 500 of 500\./);
        assert.match(panel, /Duffel calls today have passed 80% of the daily total \(500 of 500\)\. At 500 search stops for every company until 00:00 UTC\./);
        assertClean(w);
      } finally {
        await w.close();
      }
    });
  });
}

test('the 80% notice: none at 399 of 500, then one for that supplier at 400', async t => {
  const w = await world();
  t.after(w.close);
  const admin = await platformAdmin(w);
  const big = { company: 1000, total: 1000 };
  await w.repo().reserveSupplierUsage({ day: TODAY, supplier: 'duffel', company: 'unscoped', want: 399, caps: big });
  await w.repo().reserveSupplierUsage({ day: TODAY, supplier: 'liteapi', company: 'unscoped', want: 12, caps: big });
  let res = await admin.get('/admin/business');
  let panel = textOf(panelOf(res.text));
  assert.match(panel, /Duffel \(flights\)[\s\S]*Calls today: 399 of 500\. Each company can make up to 100\./);
  assert.match(panel, /LiteAPI \(hotels\)[\s\S]*Calls today: 12 of 500\./);
  assert.doesNotMatch(panel, /passed 80%/);
  await w.repo().reserveSupplierUsage({ day: TODAY, supplier: 'duffel', company: 'unscoped', want: 1, caps: big });
  res = await admin.get('/admin/business');
  panel = textOf(panelOf(res.text));
  assert.match(panel, /Duffel calls today have passed 80% of the daily total \(400 of 500\)\. At 500 search stops for every company until 00:00 UTC\./);
  assert.doesNotMatch(panel, /LiteAPI calls today have passed/);
  assert.equal((panelOf(res.text).match(/role="status"/g) || []).length, 1, 'one notice');
  // The next UTC day starts at zero.
  w.clock.set('2026-10-10T00:00:01.000Z');
  res = await admin.get('/admin/business');
  assert.match(textOf(panelOf(res.text)), /Duffel \(flights\)[\s\S]*Calls today: 0 of 500\./);
  assertClean(w);
});

// ---------------------------------------------------------------------------------------------------------
// Only confirmed companies make supplier calls

test('a company Tripelyx has not confirmed makes no supplier call: the form says why, search and requests are refused', async t => {
  const w = await world();
  t.after(w.close);
  const pending = await company(w, 'Pending Co', { status: 'pending' });
  const acme = await company(w, 'Acme Inc');
  const admin = await platformAdmin(w);
  await goLive(w, admin);
  const before = w.ff.calls.length;

  let res = await pending.c.sam.get(`${pending.B}/trips/new`);
  assert.equal(res.status, 200);
  let main = textMain(res.text);
  assert.ok(main.includes('Not open yet') && main.includes(SEARCH_CLOSED), main.slice(0, 400));
  assert.ok(!main.includes(NO_SUPPLIER.title), 'the reason is the company, not the supplier');
  assert.match(res.text, /<fieldset class="bz-search-fields" disabled>/);
  res = await pending.c.sam.get(`${pending.B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 409);
  main = textMain(res.text);
  assert.ok(main.includes(SEARCH_CLOSED));
  assert.equal(main.split(SEARCH_CLOSED).length - 1, 1, 'said once');
  res = await pending.c.owner.post(`${pending.B}/trips`, formFor(FLEX, LODGE));
  assert.equal(res.status, 409);
  assert.ok(textMain(res.text).includes(SEARCH_CLOSED));
  assert.equal(w.ff.calls.length, before, 'zero supplier calls for a pending company');
  assert.ok(!w.scopes.includes(pending.org.id));
  // Below the service, the gate refuses a call for a company that is not confirmed, or for none at all.
  const inv = w.inv();
  await assert.rejects(withCompany(pending.org.id, () => inv.flights.search(FQ), { confirmed: false }), e => e.code === 'supplier_unavailable');
  await assert.rejects(inv.flights.search(FQ), e => e.code === 'supplier_unavailable');
  await assert.rejects(withCompany(pending.org.id, () => w.app.business.composer.search({
    from: 'CAI', to: 'LHR', departDate: '2026-11-12', returnDate: null, cabin: 'economy', passengers: 1, datesFlexible: false, hotel: null,
  }), { confirmed: false }), e => e.code === 'company_not_confirmed' && e.status === 409 && e.message === SEARCH_CLOSED);
  assert.equal(w.ff.calls.length, before);

  // A confirmed company with a request waiting, then no longer confirmed: no check, and so no approval.
  let page = await acme.c.sam.get(`${acme.B}/trips/search?${qs(Q)}`);
  assert.equal(page.status, 200);
  const rid = await createDraft(acme, formFor(FLEX, LODGE));
  page = await acme.c.sam.get(`${acme.B}/trips/${rid}`);
  page = await acme.c.sam.post(`${acme.B}/trips/${rid}/submit`, { rev: revOf(mainOf(page.text), 'submit'), reason: REASON, category: 'client_meeting' });
  assert.equal(page.location, `${acme.B}/trips/${rid}?ok=submitted`);
  await w.repo().commit({ cas: [{ kind: KINDS.org, id: acme.org.id, rev: null, fn: d => { d.status = 'pending'; } }] });
  const atPending = w.ff.calls.length;
  page = await acme.c.dana.get(`${acme.B}/trips/${rid}`);
  assert.equal(page.status, 200);
  assert.ok(textMain(page.text).includes(SEARCH_CLOSED), 'the approver is told why nothing is checked');
  res = await acme.c.dana.post(`${acme.B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(mainOf(page.text), 'decide') });
  assert.equal(res.status, 409, textMain(res.text).slice(0, 300));
  assert.ok(textMain(res.text).includes(SEARCH_CLOSED));
  assert.equal(w.ff.calls.length, atPending, 'zero supplier calls');
  const stored = await w.repo().getIn(KINDS.request, rid, acme.org.id);
  assert.equal(stored.status, 'pending', 'never approved without a check');
  assertClean(w);
});

// ---------------------------------------------------------------------------------------------------------
// www as deployed: both secrets hold "unset"

test('www with both key secrets holding "unset": Business as before (status none), the same consumer pages, and the panel says "Not set"', async t => {
  const WWW = { ...ENVS.live, ENABLE_BUSINESS: 'true', ADMIN_EMAILS: ADMIN_EMAIL };
  const UNSET = {
    ...WWW, BUSINESS_FLIGHT_SUPPLIER: 'duffel', BUSINESS_HOTEL_SUPPLIER: 'liteapi', BUSINESS_SUPPLIER_LIVE: 'true',
    BUSINESS_ALLOW_SUPPLIER_TEST: 'false', DUFFEL_ACCESS_TOKEN: 'unset', LITEAPI_API_KEY: 'unset',
  };
  const restore = freezeDate(FIXED_NOW);
  t.after(restore);
  const blocked = blockSupplierHosts();
  t.after(() => blocked.restore());
  const PAGES = ['/', '/book', '/ai-travel-agent', '/brands', '/signin', '/admin', '/no-such-page', '/business', '/business/start', '/business/signin'];
  const pagesOf = async env => {
    const site = await bootApp(ROOT, env);
    try {
      const got = {};
      for (const p of PAGES) {
        const res = await fetch(site.base + p, { headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' }, redirect: 'manual' });
        got[p] = { status: res.status, location: res.headers.get('location'), text: normalise(await res.text()) };
      }
      return { got, status: site.business.inventory.status, liveMode: site.business.inventory.liveMode };
    } finally {
      await site.close();
    }
  };
  const before = await pagesOf(WWW);
  const after = await pagesOf(UNSET);
  assert.equal(before.status, 'none');
  assert.deepEqual([after.status, after.liveMode], ['none', true]);
  for (const p of PAGES) assert.deepEqual(after.got[p], before.got[p], `${p} is the same page`);

  // The platform admin's panel: both keys "Not set", what to do, and nothing to press.
  const app = await startApp(UNSET, { store: new MemoryStore() });
  t.after(app.close);
  const ops = await seedUser(app, { name: 'Pat Platform', email: ADMIN_EMAIL });
  await app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
  const res = await client(app.base, ops.cookie).get('/admin/business');
  assert.equal(res.status, 200);
  const panel = textOf(panelOf(res.text));
  assert.match(panel, /Live search is off/);
  assert.match(panel, /Duffel \(flights\)\s*Not set\s*Paste the live key in AWS Secrets Manager \(the README says how\), then restart the service\./);
  assert.match(panel, /LiteAPI \(hotels\)\s*Not set/);
  assert.match(panel, /A supplier setting needs attention: DUFFEL_ACCESS_TOKEN is not set\./);
  assert.doesNotMatch(res.text, /Check live connection|Turn on live search|Turn off live search/);
  assert.doesNotMatch(res.text, />unset</, 'the placeholder is a setting, not something to show');
  assert.equal(blocked.count(), 0, 'no supplier call');
});
