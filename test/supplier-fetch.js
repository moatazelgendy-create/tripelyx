// An injected fetch for the supplier unit tests (real-suppliers design §7.1). Not a test file itself.
// No test reaches a supplier: every supplier call in the suite goes through fakeFetch, which answers from
// test/fixtures/suppliers/** (see the README there) or from a reply the test builds.
//
//   const ff = fakeFetch([
//     { method: 'POST', url: 'https://api.duffel.com/air/offer_requests', reply: 'duffel/offer-request.cai-lhr.json' },
//     { method: 'GET', url: /\/air\/offers\/off_/, reply: [{ fixture: 'duffel/error.500.json' }, 'duffel/offer.get.json'] },
//   ], { token, apiKey });
//
// A route matches on the method and the URL (a string matches the URL without its query, or the whole URL when
// it has a '?'; a RegExp is tested on the whole URL). A reply is a fixture name, a spec, a function of the call
// returning either, or a list (one per call, the last repeating). A spec:
//   { fixture, body, status, headers, transform(body), text, delayMs, hang, reset, redirect, bodyError, oversized }
//   body: a JSON body instead of a fixture's; transform: edits a copy of the fixture's body; text: a raw body;
//   hang: never answers (only the request's abort signal ends it, as a timeout); reset: the connection fails
//   before any answer (TypeError 'fetch failed'); redirect: the answer was a redirect that `redirect: 'error'`
//   refused (TypeError 'fetch failed', cause 'unexpected redirect', as Node's fetch throws it); bodyError: the
//   status and headers arrive, then the body breaks after that many bytes (TypeError 'terminated', as Node's
//   fetch throws when the connection drops mid-body); oversized: a streamed body of that many bytes.
// Every call is recorded (method, url, lower-cased headers, parsed body) and checked: the Duffel token only in
// Authorization (as "Bearer <token>") and with Duffel-Version v2, the LiteAPI key only in X-API-Key, redirects
// refused (redirect: 'error'). Anything else goes to `problems`; assertClean() throws when there are any.
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.join(__dirname, 'fixtures', 'suppliers');
const DUFFEL_HOST = 'api.duffel.com';
const LITEAPI_HOSTS = ['api.liteapi.travel', 'book.liteapi.travel'];
const parsed = new Map();

/**
 * A fixture as { status, headers, body }: `_source`, `_status` and `_headers` stripped, the body a fresh copy.
 * @param {string} name e.g. 'duffel/offer-request.cai-lhr.json'
 */
function loadFixture(name) {
  if (!parsed.has(name)) parsed.set(name, JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')));
  const { _source, _status, _headers, ...body } = structuredClone(parsed.get(name));
  if (typeof _source !== 'string' || !/^https:\/\//.test(_source)) throw new Error(`[supplier-fetch] ${name} has no _source URL`);
  return { status: _status ?? 200, headers: _headers || {}, body };
}

function matches(pattern, url) {
  if (pattern instanceof RegExp) return pattern.test(url);
  return pattern.includes('?') ? url === pattern : url.split('?')[0] === pattern;
}

function oversizedStream(bytes) {
  const chunk = new Uint8Array(64 * 1024).fill(32);
  let sent = 0;
  return new globalThis.ReadableStream({
    pull(controller) {
      if (sent >= bytes) { controller.close(); return; }
      const n = Math.min(chunk.length, bytes - sent);
      controller.enqueue(chunk.slice(0, n));
      sent += n;
    },
  });
}

/** The first `bytes` of `text`, then the stream fails as a dropped connection does. */
function brokenStream(text, bytes) {
  const head = Buffer.from(text, 'utf8').subarray(0, Math.max(0, bytes));
  let sent = false;
  return new globalThis.ReadableStream({
    pull(controller) {
      if (!sent && head.length) { sent = true; controller.enqueue(new Uint8Array(head)); return; }
      controller.error(new TypeError('terminated'));
    },
  });
}

function aborted(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Never answers; the abort signal ends it. AbortSignal.timeout's timer doesn't hold the process open, so this does. */
function hang(signal) {
  return new Promise((_, reject) => {
    const keep = setInterval(() => {}, 1000);
    const done = reason => { clearInterval(keep); reject(reason); };
    if (!signal) { clearInterval(keep); reject(new Error('[supplier-fetch] hang needs an abort signal')); return; }
    if (signal.aborted) done(signal.reason);
    else signal.addEventListener('abort', () => done(signal.reason), { once: true });
  });
}

async function respond(reply, call, signal) {
  const spec = typeof reply === 'string' ? { fixture: reply } : reply || {};
  if (spec.reset) throw new TypeError('fetch failed');
  if (spec.redirect) throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  if (spec.hang) return hang(signal);
  if (spec.delayMs) {
    await Promise.race([new Promise(r => setTimeout(r, spec.delayMs)), aborted(signal)]);
  }
  const fx = spec.fixture ? loadFixture(spec.fixture) : { status: 200, headers: {}, body: null };
  let body = spec.body !== undefined ? structuredClone(spec.body) : fx.body;
  if (typeof spec.transform === 'function') body = spec.transform(body, call) ?? body;
  const status = spec.status ?? fx.status;
  const headers = { 'content-type': 'application/json', ...fx.headers, ...(spec.headers || {}) };
  if (spec.oversized) return new globalThis.Response(oversizedStream(spec.oversized), { status, headers });
  const text = spec.text !== undefined ? spec.text : body === null ? '' : JSON.stringify(body);
  if (spec.bodyError !== undefined) return new globalThis.Response(brokenStream(text, spec.bodyError), { status, headers });
  return new globalThis.Response(text, { status, headers });
}

/**
 * @param {Array<{ method: string, url: string|RegExp, reply: unknown }>} routes
 * @param {{ token?: string|null, apiKey?: string|null }} [keys] the keys the adapters were given
 * @returns {{ fetch: Function, calls: object[], problems: string[], count: (host?: string) => number, assertClean: Function }}
 */
function fakeFetch(routes, { token = null, apiKey = null } = {}) {
  const calls = [];
  const problems = [];
  const hits = new Map();
  async function fetch(url, init = {}) {
    const href = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    const raw = typeof init.body === 'string' ? init.body : '';
    let body = null;
    if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
    const call = { method, url: href, headers, body, n: calls.length + 1 };
    calls.push(call);
    const host = new URL(href).host;
    if (init.redirect !== 'error') problems.push(`${method} ${host}: redirects are not refused`);
    if (host === DUFFEL_HOST) {
      if (token && headers.authorization !== `Bearer ${token}`) problems.push('Duffel call without the token in Authorization');
      if (headers['duffel-version'] !== 'v2') problems.push('Duffel call without Duffel-Version v2');
    }
    if (LITEAPI_HOSTS.includes(host) && apiKey && headers['x-api-key'] !== apiKey) problems.push('LiteAPI call without the key in X-API-Key');
    for (const secret of [token, apiKey].filter(Boolean)) {
      if (href.includes(secret)) problems.push(`${host}: a key in the URL`);
      if (raw.includes(secret)) problems.push(`${host}: a key in the body`);
      for (const [k, v] of Object.entries(headers)) {
        if (v.includes(secret) && k !== 'authorization' && k !== 'x-api-key') problems.push(`${host}: a key in header ${k}`);
      }
    }
    const index = routes.findIndex(r => String(r.method || 'GET').toUpperCase() === method && matches(r.url, href));
    if (index < 0) throw new Error(`[supplier-fetch] no route for ${method} ${href}`);
    const n = (hits.get(index) || 0) + 1;
    hits.set(index, n);
    let reply = routes[index].reply;
    if (Array.isArray(reply)) reply = reply[Math.min(n - 1, reply.length - 1)];
    if (typeof reply === 'function') reply = reply(call);
    return respond(reply, call, init.signal);
  }
  return {
    fetch,
    calls,
    problems,
    count: host => (host ? calls.filter(c => new URL(c.url).host === host).length : calls.length),
    assertClean() {
      if (problems.length) throw new Error(`[supplier-fetch] ${problems.join('; ')}`);
    },
  };
}

/** A log that keeps every line (for the redaction tests and the one-line-per-call checks). */
function captureLog() {
  const lines = [];
  const keep = level => (...args) => lines.push({ level, text: args.map(a => (a instanceof Error ? `${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
  return { lines, error: keep('error'), warn: keep('warn'), info: keep('info'), log: keep('log'), text: () => lines.map(l => l.text).join('\n') };
}

/** The structured supplier log lines ({ supplier, op, status, … }) out of a captured log. */
function supplierLines(log) {
  return log.lines.map(l => /^\[suppliers\] (\{.*\})$/.exec(l.text)).filter(Boolean).map(m => JSON.parse(m[1]));
}

module.exports = { fakeFetch, loadFixture, captureLog, supplierLines, FIXTURES, DUFFEL_HOST, LITEAPI_HOSTS };

// ---------------------------------------------------------------------------------------------------------
// Adapters wired the way suppliers/index.js wires them, on a fake fetch, a test clock and an instant sleep.

/** The tests' keys, built at run time (no key-shaped literal in the repo). */
const testKeys = () => ({
  token: `duffel_test_${'SECRET'.padEnd(40, 'x')}`,
  apiKey: `sand_${require('node:crypto').randomUUID()}`,
});

/** A clock the test moves: now() reads it, advance(ms) moves it. Starts at the suite's FIXED_NOW. */
function testClock(start = '2026-10-09T09:00:00.000Z') {
  let t = Date.parse(start);
  const now = () => new Date(t);
  return { now, advance(ms) { t += ms; }, set(iso) { t = Date.parse(iso); } };
}

/** The inventory's airport lookups (suppliers/index.js gets these from inventory.js). */
function airportLookups() {
  const DATA = require('../server/providers/mock/demo-data/flights');
  const HOTEL_CITY = { DBB: 'New Alamein', CAI: 'Cairo' };
  const byCode = new Map(DATA.airports.map(a => [a.iata, { city: a.city, country: a.country, tz: a.tz }]));
  const zones = new Map(DATA.airports.map(a => [`${HOTEL_CITY[a.iata] || a.city}|${a.country}`, a.tz]));
  return { airport: code => byCode.get(code) || null, cityZone: (city, country) => zones.get(`${city}|${country}`) || null };
}

/**
 * DuffelFlights and LiteApiHotels on one fake fetch, one gate and one http, like createBusinessSuppliers.
 * The gate's monotonic clock moves only when something sleeps, and sleeping is instant (the waits are kept).
 * @param {{ routes?: object[], clock?: object, log?: object, keys?: object, cacheSeconds?: number,
 *   duffelTimeouts?: object, liteTimeouts?: object, gate?: object, guestNationality?: string }} [opts]
 */
function supplierKit({ routes = [], clock = testClock(), log = captureLog(), keys = testKeys(), cacheSeconds = 300, duffelTimeouts = {}, liteTimeouts = {}, gate: gateOpts = {}, guestNationality = 'US' } = {}) {
  const { Gate } = require('../server/business/suppliers/gate');
  const { createSupplierHttp } = require('../server/business/suppliers/http');
  const { DuffelFlights } = require('../server/business/suppliers/duffel');
  const { LiteApiHotels } = require('../server/business/suppliers/liteapi');
  const { createState } = require('../server/business/suppliers');
  const ff = fakeFetch(routes, keys);
  const waits = [];
  let mono = 0;
  const sleep = async ms => { waits.push(ms); mono += ms; };
  const gate = new Gate({ now: clock.now, log, sleep, mono: () => mono, ...gateOpts });
  const http = createSupplierHttp({ fetch: ff.fetch, gate, now: clock.now, log, sleep, random: () => 0.5, mono: () => mono });
  const state = createState(log);
  const { airport, cityZone } = airportLookups();
  const flights = new DuffelFlights({ token: keys.token, mode: 'sandbox', http, now: clock.now, log, state, cacheSeconds, airport, timeouts: duffelTimeouts });
  const hotels = new LiteApiHotels({ apiKey: keys.apiKey, mode: 'sandbox', http, now: clock.now, state, cacheSeconds, guestNationality, cityZone, timeouts: liteTimeouts });
  return { flights, hotels, ff, gate, http, state, log, waits, clock, keys, passTime(ms) { mono += ms; } };
}

module.exports.testKeys = testKeys;
module.exports.testClock = testClock;
module.exports.airportLookups = airportLookups;
module.exports.supplierKit = supplierKit;

// ---------------------------------------------------------------------------------------------------------
// The byte-identity runs of design §1.6 (test/preserve.test.js, test/book-preserve.test.js, test/agent.test.js).

/** A good round 1 configuration, Business on. The values are the design's obvious placeholders, never keys. */
const SANDBOX_ENV = Object.freeze({
  ENABLE_BUSINESS: 'true', BUSINESS_FLIGHT_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: 'duffel_test_FAKEFAKE',
  BUSINESS_HOTEL_SUPPLIER: 'liteapi', LITEAPI_API_KEY: 'sand_FAKE', BUSINESS_ALLOW_SUPPLIER_TEST: 'true',
});

/** Each bad setting of §1.6, applied over SANDBOX_ENV: [label, changes]. */
const BAD_SUPPLIER_ENVS = Object.freeze([
  ['a live-looking Duffel token', { DUFFEL_ACCESS_TOKEN: 'duffel_live_FAKEFAKE' }],
  ['an unknown Duffel prefix', { DUFFEL_ACCESS_TOKEN: 'dfl_FAKEFAKE' }],
  ['a LiteAPI key without sand_', { LITEAPI_API_KEY: 'live_FAKE' }],
  ['test keys with BUSINESS_ALLOW_SUPPLIER_TEST=false', { BUSINESS_ALLOW_SUPPLIER_TEST: 'false' }],
  ['hotels without flights', { BUSINESS_FLIGHT_SUPPLIER: '', DUFFEL_ACCESS_TOKEN: '' }],
  ['an unknown supplier name', { BUSINESS_FLIGHT_SUPPLIER: 'amadeus' }],
  ['BUSINESS_SUPPLIER_CACHE_SECONDS=abc', { BUSINESS_SUPPLIER_CACHE_SECONDS: 'abc' }],
].map(([label, env]) => Object.freeze([label, Object.freeze(env)])));

/**
 * Wraps globalThis.fetch so that a call to a supplier host fails (and is counted) while every other call, the
 * tests' own requests to the app, passes through. restore() puts the real fetch back.
 * @returns {{ count: () => number, restore: () => void }}
 */
function blockSupplierHosts() {
  const { SUPPLIER_HOSTS } = require('../server/business/suppliers/http');
  const real = globalThis.fetch;
  const blocked = [];
  globalThis.fetch = function guardedFetch(input, init) {
    let host = '';
    try { host = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).host; } catch { /* not a URL: let fetch say so */ }
    if (SUPPLIER_HOSTS.includes(host)) {
      blocked.push(host);
      return Promise.reject(new Error(`[supplier-fetch] a supplier call during a byte-identity run (${host})`));
    }
    return real.call(this, input, init);
  };
  return { count: () => blocked.length, restore() { globalThis.fetch = real; } };
}

module.exports.SANDBOX_ENV = SANDBOX_ENV;
module.exports.BAD_SUPPLIER_ENVS = BAD_SUPPLIER_ENVS;
module.exports.blockSupplierHosts = blockSupplierHosts;
