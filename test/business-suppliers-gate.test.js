// The supplier plumbing (real-suppliers design §4, §7.1, §7.4): timeouts and bounded retries with call counts,
// the gate (company limits through scope, the unscoped bucket, the breaker, Duffel's headers, the global
// buckets), the result cache, the body size cap, logging that never prints a key or a traveler, and the static
// rules that keep the network in http.js. No network: an injected fetch answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { supplierKit, testClock, captureLog, supplierLines, fakeFetch, testKeys, loadFixture, FIXTURES } = require('./supplier-fetch');
const { startApp, quietLog } = require('./helpers');
const { withCompany } = require('../server/business/scope');
const { Gate, duffelResetWait, companyTag } = require('../server/business/suppliers/gate');
const { SupplierCache } = require('../server/business/suppliers/cache');
const { createSupplierHttp, readCapped, MB } = require('../server/business/suppliers/http');
const { redactText } = require('../server/app');
const { offerRequestRetry } = require('../server/business/suppliers/duffel');
const { seedUser, seedOrg, client } = require('./business-helpers');
const { currentCompany } = require('../server/business/scope');

const ORG = 'org_gateTest0000000001';
const OTHER = 'org_gateTest0000000002';
const THIRD = 'org_gateTest0000000003';
const FOURTH = 'org_gateTest0000000004';
const OFFER_REQUESTS = 'https://api.duffel.com/air/offer_requests';
const OFFERS = /^https:\/\/api\.duffel\.com\/air\/offers\//;
const RATES = 'https://api.liteapi.travel/v3.0/hotels/rates';
const PREBOOK = /^https:\/\/book\.liteapi\.travel\/v3\.0\/rates\/prebook\?timeout=\d+$/;
const FQ = Object.freeze({ from: 'CAI', to: 'LHR', departDate: '2026-11-12', passengers: 1, cabin: 'economy' });
const HQ = Object.freeze({ where: 'Cairo', country: 'Egypt', checkIn: '2026-11-12', checkOut: '2026-11-14', guests: 1 });
const I1 = 'flt_t.ZZ1234_20261112T0835_economy';
const FLIGHTS_DOWN = 'Flights are not available right now. Please try again in a few minutes.';
const HOTELS_DOWN = 'Hotels are not available right now.';
const inOrg = fn => withCompany(ORG, fn);
const flightKit = (reply, opts = {}) => supplierKit({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply }], ...opts });
const hotelKit = (reply, opts = {}) => supplierKit({ routes: [{ method: 'POST', url: RATES, reply }], ...opts });
const down = vertical => e => e.code === 'supplier_unavailable' && e.status === 503 && e.message === (vertical === 'flights' ? FLIGHTS_DOWN : HOTELS_DOWN);
const nightsFrom = d => ({ ...HQ, checkIn: `2026-11-${String(d).padStart(2, '0')}`, checkOut: `2026-11-${String(d + 2).padStart(2, '0')}` });

// ---------------------------------------------------------------------------------------------------------
// §4.1, §4.2: timeouts and bounded retries, with call counts

test('offer request: 504 (airline_internal) is called once; 500 and 502 once; 503 retried once', () => inOrg(async () => {
  const k504 = flightKit('duffel/error.504-airline-internal.json');
  await assert.rejects(k504.flights.search(FQ), down('flights'));
  assert.equal(k504.ff.calls.length, 1, 'never a second search after a 504');
  const k500 = flightKit('duffel/error.500.json');
  await assert.rejects(k500.flights.search(FQ), down('flights'));
  assert.equal(k500.ff.calls.length, 1);
  // D-ERR: 500 and 502 "You should not retry this request"; 503 and 504 "Please retry later".
  const k502 = flightKit([{ fixture: 'duffel/error.500.json', status: 502 }, 'duffel/offer-request.cai-lhr.json']);
  await assert.rejects(k502.flights.search(FQ), down('flights'));
  assert.equal(k502.ff.calls.length, 1, 'a 502 is never retried (D-ERR)');
  for (const status of [503]) {
    const k = flightKit([{ fixture: 'duffel/error.500.json', status }, 'duffel/offer-request.cai-lhr.json']);
    assert.equal((await k.flights.search(FQ)).length, 6, `${status}: the retry answered`);
    assert.equal(k.ff.calls.length, 2);
    assert.deepEqual(k.waits, [250], 'the jittered 250 ms backoff');
    const twice = flightKit({ fixture: 'duffel/error.500.json', status });
    await assert.rejects(twice.flights.search(FQ), down('flights'));
    assert.equal(twice.ff.calls.length, 2, `${status}: one retry only`);
  }
}));

test('offer request: a connection error before any answer is retried once; a timeout never', () => inOrg(async () => {
  const reset = flightKit([{ reset: true }, 'duffel/offer-request.cai-lhr.json']);
  assert.equal((await reset.flights.search(FQ)).length, 6);
  assert.equal(reset.ff.calls.length, 2);
  const resetTwice = flightKit({ reset: true });
  await assert.rejects(resetTwice.flights.search(FQ), down('flights'));
  assert.equal(resetTwice.ff.calls.length, 2);
  const slow = flightKit({ hang: true }, { duffelTimeouts: { offerRequest: 30 } });
  await assert.rejects(slow.flights.search(FQ), down('flights'));
  assert.equal(slow.ff.calls.length, 1, 'a slow search is "not available right now", not a second search');
  assert.deepEqual(supplierLines(slow.log).map(l => l.outcome), ['timeout']);
}));

test('GET offer: two retries for a connection error, 503, 504; 502 never; a timeout ends as 503', () => inOrg(async () => {
  const k502 = supplierKit({ routes: [
    { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
    { method: 'GET', url: OFFERS, reply: [{ fixture: 'duffel/error.500.json', status: 502 }, 'duffel/offer.get.json'] },
  ] });
  await k502.flights.search(FQ);
  await assert.rejects(k502.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' }), down('flights'));
  assert.equal(k502.ff.calls.filter(c => c.method === 'GET').length, 1, 'a 502 is never retried (D-ERR)');
  for (const fail of [{ reset: true }, { fixture: 'duffel/error.500.json', status: 503 }, { fixture: 'duffel/error.504-airline-internal.json' }, { fixture: 'duffel/offer.get.json', bodyError: 64 }]) {
    const kit = supplierKit({ routes: [
      { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
      { method: 'GET', url: OFFERS, reply: [fail, fail, 'duffel/offer.get.json'] },
    ] });
    await kit.flights.search(FQ);
    const o = await kit.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' });
    assert.equal(o.options[0].price.amount, 28990, JSON.stringify(fail));
    assert.equal(kit.ff.calls.filter(c => c.method === 'GET').length, 3);
    assert.deepEqual(kit.waits, [250, 1000], 'backoff 250 ms then 1 s');
  }
  const slow = supplierKit({ duffelTimeouts: { offerGet: 30 }, routes: [
    { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
    { method: 'GET', url: OFFERS, reply: { hang: true } },
  ] });
  await slow.flights.search(FQ);
  await assert.rejects(slow.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' }), down('flights'));
}));

test('offer request: an answer that breaks after it started, or a refused redirect, is never sent a second time', () => inOrg(async () => {
  // The 201 arrived, then the connection dropped mid-body: Duffel ran the search, so a second one costs ratio.
  const broken = flightKit([{ fixture: 'duffel/offer-request.cai-lhr.json', status: 201, bodyError: 64 }, 'duffel/offer-request.cai-lhr.json']);
  await assert.rejects(broken.flights.search(FQ), down('flights'));
  assert.equal(broken.ff.calls.length, 1, 'one offer request');
  assert.deepEqual(supplierLines(broken.log).map(l => [l.status, l.outcome]), [[null, 'body_error']]);
  const redirected = flightKit([{ redirect: true }, 'duffel/offer-request.cai-lhr.json']);
  await assert.rejects(redirected.flights.search(FQ), down('flights'));
  assert.equal(redirected.ff.calls.length, 1, 'a redirect is an answer: never retried');
  assert.deepEqual(supplierLines(redirected.log).map(l => l.outcome), ['redirect']);
  // The same through http.js alone, with the offer request's retry rule (the reviewer's case: 201, then 'terminated').
  const gate = new Gate({ now: testClock().now, log: captureLog(), sleep: async () => {} });
  let sends = 0;
  const fetch = async () => {
    sends += 1;
    let n = 0;
    const body = new globalThis.ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode('{"data":{"offers":[')); else c.error(new TypeError('terminated')); } });
    return new globalThis.Response(body, { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const http = createSupplierHttp({ fetch, gate, now: testClock().now, log: captureLog(), sleep: async () => {} });
  const retry = offerRequestRetry;
  assert.equal(typeof retry, 'function');
  await assert.rejects(http.call({ supplier: 'duffel', op: 'offer_request', vertical: 'flights', method: 'POST', url: OFFER_REQUESTS, headers: {}, body: '{}', timeoutMs: 15000, maxAttempts: 2, retry }), down('flights'));
  assert.equal(sends, 1);
  // Before any answer, it is retried once (design §4.2).
  assert.equal(retry({ kind: 'network', afterResponse: false }), true);
  assert.equal(retry({ kind: 'network', afterResponse: true }), false);
  assert.equal(retry({ kind: 'redirect' }), false);
  assert.equal(retry({ kind: 'timeout', afterResponse: false }), false);
  for (const status of [500, 502, 504]) assert.equal(retry({ kind: 'response', status }), false, String(status));
  assert.equal(retry({ kind: 'response', status: 503 }), true);
}));

test('LiteAPI rates: a timeout is 503 with one call; prebook never retries a connection error', () => inOrg(async () => {
  const slow = hotelKit({ hang: true }, { liteTimeouts: { rates: 30 } });
  await assert.rejects(slow.hotels.search(HQ), down('hotels'));
  assert.equal(slow.ff.calls.length, 1);
  const kit = supplierKit({ routes: [
    { method: 'POST', url: RATES, reply: c => (c.body.hotelIds ? 'liteapi/rates.hotel.json' : 'liteapi/rates.cairo.json') },
    { method: 'POST', url: PREBOOK, reply: { reset: true } },
  ] });
  const pq = { ...HQ, check: 'final' };
  const o = await kit.hotels.getOffer('htl_t.lp1001', pq);
  await assert.rejects(kit.hotels.quote({ offerId: o.id, optionId: 'standard-room-ro-r', query: pq, offer: o }), down('hotels'));
  assert.equal(kit.ff.calls.filter(c => PREBOOK.test(c.url)).length, 1, 'a prebook may have been made: never sent twice blind');
}));

test('LiteAPI 429, 4290 back off and retry once; 4291 is a retryable 5xx', () => inOrg(async () => {
  for (const fixture of ['liteapi/error.429.json', 'liteapi/error.4290.json', 'liteapi/error.4291.json']) {
    const kit = hotelKit([fixture, 'liteapi/rates.cairo.json']);
    assert.equal((await kit.hotels.search(HQ)).length, 4, fixture);
    assert.equal(kit.ff.calls.length, 2);
    assert.deepEqual(kit.waits.filter(w => w >= 200), [250], `${fixture}: one jittered backoff`);
    const line = supplierLines(kit.log)[0];
    assert.equal(line.outcome, 'error');
    assert.equal(typeof line.errorCode, 'number');
  }
}));

// ---------------------------------------------------------------------------------------------------------
// §4.3: the gate

test('Duffel headers: ratelimit-reset is an HTTP-date; remaining 0 holds the next call back; a bad date falls back', async () => {
  const at = new Date('2026-10-09T09:00:00.600Z');
  const h = (remaining, reset) => new globalThis.Headers({ 'ratelimit-remaining': remaining, 'ratelimit-reset': reset });
  assert.equal(duffelResetWait(h('0', 'Fri, 09 Oct 2026 09:00:02 GMT'), at), 2000, 'whole seconds, rounded up');
  assert.equal(duffelResetWait(h('0', 'Fri, 09 Oct 2026 08:59:00 GMT'), at), 0, 'a reset in the past');
  assert.equal(duffelResetWait(h('0', 'Fri, 09 Oct 2026 10:00:00 GMT'), at), 60000, 'clamped to 60 s');
  assert.equal(duffelResetWait(h('5', 'Fri, 09 Oct 2026 09:00:02 GMT'), at), null, 'calls left: no wait');
  assert.equal(duffelResetWait(h('0', '1700000000'), at), null, 'seconds are not the documented format');
  assert.equal(duffelResetWait(h('0', 'soon'), at), null);
  assert.equal(duffelResetWait(null, at), null);

  await inOrg(async () => {
    // A 429 whose reset is 2 s away: wait for it, then the GET answers.
    const kit = supplierKit({ routes: [
      { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
      { method: 'GET', url: OFFERS, reply: ['duffel/error.rate-limit.json', 'duffel/offer.get.json'] },
    ] });
    await kit.flights.search(FQ);
    const o = await kit.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' });
    assert.equal(o.options[0].price.amount, 28990);
    assert.ok(kit.waits.includes(2000), `waited for the reset: ${kit.waits}`);
    assert.equal(kit.ff.calls.length, 3);

    // A reset 5 s away: no retry (more than 2 s), a 503, and nothing is sent until the reset.
    const later = { fixture: 'duffel/error.rate-limit.json', headers: { 'ratelimit-reset': 'Fri, 09 Oct 2026 09:00:05 GMT' } };
    const held = supplierKit({ routes: [
      { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
      { method: 'GET', url: OFFERS, reply: [later, 'duffel/offer.get.json'] },
    ] });
    await held.flights.search(FQ);
    await assert.rejects(held.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' }), down('flights'));
    await assert.rejects(held.flights.search({ ...FQ, to: 'DXB' }), down('flights'));
    assert.equal(held.ff.calls.length, 2, 'held back: no call until the reset');
    held.passTime(5000);
    await held.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' });
    assert.equal(held.ff.calls.length, 3);

    // An unparseable reset: no header wait, the bucket decides (the next call goes out).
    const odd = supplierKit({ routes: [
      { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
      { method: 'GET', url: OFFERS, reply: [{ fixture: 'duffel/error.rate-limit.json', headers: { 'ratelimit-reset': 'soon' } }, 'duffel/offer.get.json'] },
    ] });
    await odd.flights.search(FQ);
    await assert.rejects(odd.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' }), down('flights'));
    assert.equal((await odd.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' })).options[0].price.amount, 28990);
  });
});

test('the breaker: 5 failures in 60 s pause that supplier for 30 s (503, no call); the other supplier goes on', () => inOrg(async () => {
  const fail = { status: 500, body: { error: { code: 5000, message: 'internal' } } };
  const kit = supplierKit({ routes: [
    { method: 'POST', url: RATES, reply: [fail, fail, fail, fail, fail, 'liteapi/rates.cairo.json'] },
    { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
  ] });
  for (let i = 0; i < 3; i += 1) await assert.rejects(kit.hotels.search(nightsFrom(10 + i)), down('hotels'));
  assert.equal(kit.ff.count('api.liteapi.travel'), 5, 'two, two, then the fifth failure opens it before the retry');
  assert.ok(kit.gate.isOpen('liteapi'));
  assert.equal(kit.log.lines.filter(l => l.text.includes('liteapi: 5 failures in a minute')).length, 1);
  await assert.rejects(kit.hotels.search(HQ), down('hotels'));
  assert.equal(kit.ff.count('api.liteapi.travel'), 5, 'open: no call');
  assert.equal((await kit.flights.search(FQ)).length, 6, 'Duffel is not paused');
  kit.passTime(30 * 1000 + 1);
  assert.equal((await kit.hotels.search(HQ)).length, 4, 'closed again after 30 s');
}));

test('per company: 120 an hour and 20 a minute, counted once per operation, then 429 supplier_busy', async () => {
  const busy = e => e.code === 'supplier_busy' && e.status === 429 && e.message === 'Your company has run a lot of searches in the last hour. Please try again in a few minutes.';
  const kit = supplierKit({ gate: { companyPerHour: 3, companyPerMinute: 100 }, routes: [{ method: 'POST', url: RATES, reply: [{ status: 503, body: {} }, 'liteapi/rates.cairo.json'] }] });
  await withCompany(ORG, async () => {
    await kit.hotels.search(nightsFrom(1)); // a 503 and its retry: one operation
    await kit.hotels.search(nightsFrom(2));
    await kit.hotels.search(nightsFrom(2)); // a cache hit is no call
    await kit.hotels.search(nightsFrom(3));
    assert.equal(kit.ff.calls.length, 4);
    await assert.rejects(kit.hotels.search(nightsFrom(4)), busy);
    assert.equal(kit.ff.calls.length, 4, 'refused before any call');
  });
  await withCompany(OTHER, async () => assert.equal((await kit.hotels.search(nightsFrom(4))).length, 4, 'another company has its own count'));
  kit.passTime(60 * 60 * 1000 + 1);
  await withCompany(ORG, async () => assert.equal((await kit.hotels.search(nightsFrom(5))).length, 4, 'an hour later'));

  const minute = supplierKit({ gate: { companyPerHour: 100, companyPerMinute: 2 }, routes: [{ method: 'POST', url: RATES, reply: 'liteapi/rates.cairo.json' }] });
  await withCompany(ORG, async () => {
    await minute.hotels.search(nightsFrom(1));
    await minute.hotels.search(nightsFrom(2));
    await assert.rejects(minute.hotels.search(nightsFrom(3)), busy);
    minute.passTime(60 * 1000 + 1);
    await minute.hotels.search(nightsFrom(3));
  });
});

test('no company in scope: one shared bucket of 10 an hour, a warning logged once, then 503', async () => {
  const kit = hotelKit('liteapi/rates.cairo.json');
  for (let d = 1; d <= 10; d += 1) await kit.hotels.search(nightsFrom(d));
  await assert.rejects(kit.hotels.search(nightsFrom(11)), down('hotels'));
  assert.equal(kit.ff.calls.length, 10);
  assert.equal(kit.log.lines.filter(l => l.text.includes('outside any company scope')).length, 1);
  assert.equal(supplierLines(kit.log)[0].company, null);
  // A company's own count is untouched by the unscoped calls.
  await withCompany(ORG, async () => assert.equal((await kit.hotels.search(nightsFrom(11))).length, 4));
});

test('through the routes: memberGate puts the company in scope, so each company has its own cache and its own count', async t => {
  const keys = testKeys();
  const ff = fakeFetch([
    { method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' },
    { method: 'POST', url: RATES, reply: 'liteapi/rates.cairo.json' },
  ], keys);
  const seen = [];
  const businessFetch = (url, init) => { seen.push({ host: new URL(url).host, org: currentCompany() }); return ff.fetch(url, init); };
  const app = await startApp({
    ENABLE_BUSINESS: 'true', BUSINESS_FLIGHT_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: keys.token,
    BUSINESS_HOTEL_SUPPLIER: 'liteapi', LITEAPI_API_KEY: keys.apiKey, BUSINESS_ALLOW_SUPPLIER_TEST: 'true',
  }, { businessFetch });
  t.after(app.close);
  assert.equal(app.business.inventory.status, 'sandbox');
  const a = await seedUser(app), b = await seedUser(app);
  const orgA = await seedOrg(app, a, { name: 'Alpha Co' }), orgB = await seedOrg(app, b, { name: 'Beta Co' });
  const path = org => `/business/o/${org.id}/trips/search?from=CAI&to=LHR&depart=2026-11-12&cabin=economy`;
  const ra = await client(app.base, a.cookie).get(path(orgA));
  assert.equal(ra.status, 200);
  assert.deepEqual(seen.map(x => x.org), [orgA.id], 'the supplier call knows its company');
  const again = await client(app.base, a.cookie).get(path(orgA));
  assert.equal(again.status, 200);
  assert.equal(seen.length, 1, 'the same company: a cache hit');
  const rb = await client(app.base, b.cookie).get(path(orgB));
  assert.equal(rb.status, 200);
  assert.deepEqual(seen.map(x => x.org), [orgA.id, orgB.id], 'another company makes its own call, in its own scope');
  assert.match(rb.text, /Test airline/, 'and sees its own results');
  const gate = app.business.inventory.flights.http.gate;
  assert.deepEqual([...gate.companies.keys()].sort(), [orgA.id, orgB.id].sort(), 'each company counted against its own limit');
  assert.equal(gate.companies.get(orgA.id).length, 1);
  assert.equal(gate.companies.get(orgB.id).length, 1);
  assert.deepEqual(gate.unscoped, [], 'nothing fell into the shared unscoped bucket');
  ff.assertClean();
});

test('global buckets: Duffel bursts 10 then 1 a second, LiteAPI 4 a second; a wait over 2 s is 503 at once', async () => {
  let mono = 0;
  const waits = [];
  const sleep = async ms => { waits.push(ms); mono += ms; };
  const gate = new Gate({ now: testClock().now, log: quietLog, mono: () => mono, sleep, companyPerMinute: 1000, companyPerHour: 1000 });
  await withCompany(ORG, async () => {
    for (let i = 0; i < 10; i += 1) await gate.admit('duffel', { vertical: 'flights' });
    assert.deepEqual(waits, []);
    await gate.admit('duffel', { vertical: 'flights' });
    assert.deepEqual(waits, [1000]);
    waits.length = 0;
    for (let i = 0; i < 4; i += 1) await gate.admit('liteapi', { vertical: 'hotels' });
    await gate.admit('liteapi', { vertical: 'hotels' });
    assert.deepEqual(waits, [250]);
  });
  // Ten callers at once with no wait allowed past 2 s: the ones that would wait longer get 503 now.
  let m2 = 0;
  const g2 = new Gate({ now: testClock().now, log: quietLog, mono: () => m2, sleep: async () => {}, companyPerMinute: 1000, companyPerHour: 1000 });
  await withCompany(ORG, async () => {
    const results = await Promise.allSettled(Array.from({ length: 14 }, () => g2.admit('duffel', { vertical: 'flights' })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 12, '10 now, then 1 s and 2 s');
    assert.ok(results.filter(r => r.status === 'rejected').every(r => down('flights')(r.reason)));
  });
});

// ---------------------------------------------------------------------------------------------------------
// §4.4: the cache

test('cache: Duffel TTL is bounded by the earliest expires_at minus 120 s; under 60 s is not cached', () => inOrg(async () => {
  const clock = testClock();
  const expiring = seconds => body => {
    for (const o of body.data.offers) o.expires_at = new Date(clock.now().getTime() + seconds * 1000).toISOString();
    return body;
  };
  const kit = flightKit({ fixture: 'duffel/offer-request.cai-lhr.json', transform: expiring(180) }, { clock });
  await kit.flights.search(FQ);
  clock.advance(59 * 1000);
  await kit.flights.search(FQ);
  assert.equal(kit.ff.calls.length, 1, '60 s of validity: cached');
  clock.advance(2 * 1000);
  await kit.flights.search(FQ);
  assert.equal(kit.ff.calls.length, 2, 'expired with the offers');
  const short = flightKit({ fixture: 'duffel/offer-request.cai-lhr.json', transform: expiring(179) }, { clock });
  await short.flights.search(FQ);
  await short.flights.search(FQ);
  assert.equal(short.ff.calls.length, 2, '59 s of validity: not cached');
  // The setting bounds it too (offers valid for 30 minutes, 300 s cache).
  const long = flightKit('duffel/offer-request.cai-lhr.json', { clock: testClock() });
  await long.flights.search(FQ);
  long.clock.advance(299 * 1000);
  await long.flights.search(FQ);
  long.clock.advance(2 * 1000);
  await long.flights.search(FQ);
  assert.equal(long.ff.calls.length, 2);
  const off = flightKit('duffel/offer-request.cai-lhr.json', { cacheSeconds: 0 });
  await off.flights.search(FQ);
  await off.flights.search(FQ);
  assert.equal(off.ff.calls.length, 2, 'BUSINESS_SUPPLIER_CACHE_SECONDS=0 caches nothing');
}));

test('cache: per company, single-flight, and answeredAt kept on a hit', async () => {
  const clock = testClock();
  const kit = supplierKit({ clock, routes: [
    { method: 'POST', url: RATES, reply: { fixture: 'liteapi/rates.cairo.json', delayMs: 20 } },
    { method: 'POST', url: OFFER_REQUESTS, reply: { fixture: 'duffel/offer-request.cai-lhr.json', delayMs: 20 } },
    { method: 'GET', url: OFFERS, reply: 'duffel/offer.get.json' },
  ] });
  await withCompany(ORG, async () => {
    const [a, b] = await Promise.all([kit.hotels.search(HQ), kit.hotels.search(HQ)]);
    assert.deepEqual(a, b);
    const [f1, f2] = await Promise.all([kit.flights.search(FQ), kit.flights.search(FQ)]);
    assert.deepEqual(f1, f2);
    assert.equal(kit.ff.calls.length, 2, 'two identical searches at once share one call');
  });
  await withCompany(OTHER, async () => {
    await kit.hotels.search(HQ);
    assert.equal(kit.ff.calls.length, 3, 'another company never reads the first company\'s cache');
    await kit.flights.search(FQ);
    assert.equal(kit.ff.calls.length, 4, 'nor its flight search');
  });
  // Nor its Duffel offers: a price check for a third company searches for itself before any GET.
  await withCompany(THIRD, async () => {
    const o = await kit.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' });
    assert.equal(o.options[0].price.amount, 28990);
    assert.deepEqual(kit.ff.calls.slice(4).map(c => c.method), ['POST', 'GET'], 'its own offer request, then the GET');
    assert.equal(await kit.flights.getOffer(I1, { ...FQ, check: 'peek' }, { optionId: 'standard' }).then(x => x.id), I1);
  });
  await withCompany(FOURTH, async () => {
    await assert.rejects(kit.flights.getOffer(I1, { ...FQ, check: 'peek' }, { optionId: 'standard' }), e => e.code === 'live_check_skipped', 'peek: no search and no other company\'s offer');
    await assert.rejects(kit.hotels.getOffer('htl_t.lp1001', { ...HQ, check: 'peek' }), e => e.code === 'live_check_skipped');
  });
  assert.equal(kit.ff.calls.length, 6);
  clock.advance(120 * 1000);
  await withCompany(ORG, async () => {
    const again = await kit.hotels.search(HQ);
    const flights = await kit.flights.search(FQ);
    assert.equal(kit.ff.calls.length, 6);
    for (const o of [...again, ...flights]) assert.equal(o.details.answeredAt, '2026-10-09T09:00:00.000Z', 'the supplier\'s time, not the hit\'s');
    // The cached offers are fresh copies: changing one changes nothing stored.
    again[0].options[0].price.amount = 1;
    assert.notEqual((await kit.hotels.search(HQ))[0].options[0].price.amount, 1);
  });
});

test('SupplierCache: TTL, LRU per company and in all, the byte bound', () => {
  const clock = testClock();
  const c = new SupplierCache({ now: clock.now, maxPerCompany: 2, maxEntries: 3, maxBytes: 100 });
  assert.equal(c.set('A', 'k1', { v: 1 }, 1000), true);
  assert.equal(c.set('A', 'k2', { v: 2 }, 1000), true);
  assert.deepEqual(c.get('A', 'k1'), { v: 1 }); // k1 is now the most recently used
  c.set('A', 'k3', { v: 3 }, 1000);
  assert.equal(c.get('A', 'k2'), undefined, 'the company\'s least recently used went first');
  assert.deepEqual([c.get('A', 'k1'), c.get('A', 'k3')], [{ v: 1 }, { v: 3 }]);
  assert.equal(c.get('B', 'k1'), undefined, 'keys are per company');
  c.set('B', 'k1', { v: 4 }, 1000);
  c.set('B', 'k2', { v: 5 }, 1000);
  assert.equal(c.stats().entries, 3, 'at most 3 in all');
  assert.equal(c.get('A', 'k1'), undefined, 'the oldest anywhere went');
  clock.advance(1000);
  assert.equal(c.get('B', 'k2'), undefined, 'expired');
  // Bytes: each entry is the JSON length of its value.
  const b = new SupplierCache({ now: clock.now, maxBytes: 100 });
  const blob = n => ({ s: 'x'.repeat(n) });
  b.set('A', 'one', blob(50), 1000);
  b.set('A', 'two', blob(50), 1000);
  assert.equal(b.get('A', 'one'), undefined, 'over 100 bytes: the oldest left');
  assert.ok(b.stats().bytes <= 100);
  assert.equal(b.set('A', 'big', blob(200), 1000), false, 'larger than the whole budget: not stored');
  assert.equal(b.set('A', 'none', blob(1), 0), false, 'no TTL: not stored');
  assert.throws(() => b.get('', 'k'), TypeError, 'never a key without a company');
});

// ---------------------------------------------------------------------------------------------------------
// §4.1: the body size cap

test('body size cap: 8 MB for an offer request, 4 MB otherwise, then 503 logged as too_large', () => inOrg(async () => {
  const big = flightKit({ oversized: 8 * MB + 1 });
  await assert.rejects(big.flights.search(FQ), down('flights'));
  assert.equal(big.ff.calls.length, 1);
  assert.deepEqual(supplierLines(big.log).map(l => l.outcome), ['too_large']);
  const hotels = hotelKit({ oversized: 4 * MB + 1 });
  await assert.rejects(hotels.hotels.search(HQ), down('hotels'));
  assert.deepEqual(supplierLines(hotels.log).map(l => l.outcome), ['too_large']);
  // Under the cap but not JSON: also 503, logged as bad_body.
  const junk = hotelKit({ text: '<html>busy</html>', status: 200 });
  await assert.rejects(junk.hotels.search(HQ), down('hotels'));
  assert.equal(supplierLines(junk.log)[0].outcome, 'bad_body');
  // A declared length over the cap is refused before reading.
  await assert.rejects(readCapped(new globalThis.Response('{}', { headers: { 'content-length': String(5 * MB) } }), 4 * MB), e => e.constructor.name === 'TooLarge');
  assert.equal(await readCapped(new globalThis.Response('{"a":1}'), 4 * MB), '{"a":1}');
}));

// ---------------------------------------------------------------------------------------------------------
// §4.6: logging

test('log: one structured line per attempt, with the company as a hash and never a URL, a body or a key', () => inOrg(async () => {
  const kit = hotelKit([{ fixture: 'liteapi/error.4291.json' }, { fixture: 'liteapi/rates.cairo.json', headers: { 'x-request-id': 'req_ABC123' } }]);
  await kit.hotels.search(HQ);
  const lines = supplierLines(kit.log);
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[1]).sort(), ['attempt', 'company', 'ms', 'op', 'outcome', 'requestId', 'status', 'supplier']);
  assert.deepEqual({ ...lines[1], ms: 0 }, { supplier: 'liteapi', op: 'rates', status: 200, ms: 0, attempt: 2, requestId: 'req_ABC123', company: companyTag(ORG), outcome: 'ok' });
  assert.match(lines[1].company, /^[0-9a-f]{8}$/);
  assert.deepEqual({ status: lines[0].status, outcome: lines[0].outcome, errorCode: lines[0].errorCode }, { status: 503, outcome: 'error', errorCode: 4291 });
  const text = kit.log.text();
  for (const banned of ['Cairo', '2026-11-12', 'https://', 'api.liteapi', ORG, kit.keys.apiKey, 'X-API-Key', 'x-api-key']) assert.ok(!text.includes(banned), banned);
  // A request id that isn't id-shaped is not logged.
  const odd = hotelKit({ fixture: 'liteapi/rates.cairo.json', headers: { 'x-request-id': 'has space and "quotes"' } });
  await odd.hotels.search(HQ);
  assert.equal(supplierLines(odd.log)[0].requestId, null);
}));

test('log and errors: every fixture path with the test keys and a traveler named Zelda Quokka prints none of them', async () => {
  const keys = testKeys();
  const NAME = 'Zelda Quokka';
  // Every answer carries the keys and the name where a careless adapter could copy them out: error messages,
  // titles and descriptions, passenger names, hotel names, headers.
  const poison = body => {
    const s = `${NAME} ${keys.token} ${keys.apiKey}`;
    if (body && Array.isArray(body.errors)) for (const e of body.errors) Object.assign(e, { message: s, title: s });
    if (body && body.error && typeof body.error === 'object') Object.assign(body.error, { message: s, description: s });
    const d = body && body.data;
    if (d && Array.isArray(d.passengers)) for (const p of d.passengers) Object.assign(p, { given_name: 'Zelda', family_name: 'Quokka' });
    if (body && Array.isArray(body.hotels)) for (const h of body.hotels) h.description = s;
    return body;
  };
  const fixtures = dir => fs.readdirSync(path.join(FIXTURES, dir)).map(f => `${dir}/${f}`);
  const errors = [];
  const logs = [];
  const tryIt = async p => { try { await p; } catch (e) { errors.push(e); } };
  for (const name of fixtures('duffel')) {
    const reply = { fixture: name, transform: poison, headers: { 'x-request-id': keys.apiKey.slice(0, 20) } };
    const kit = supplierKit({ keys, routes: [
      { method: 'POST', url: OFFER_REQUESTS, reply: name.includes('offer-request') ? reply : [reply, 'duffel/offer-request.cai-lhr.json'] },
      { method: 'GET', url: OFFERS, reply },
    ] });
    await withCompany(ORG, async () => {
      await tryIt(kit.flights.search(FQ));
      await tryIt(kit.flights.getOffer(I1, { ...FQ, check: 'confirm' }, { optionId: 'standard' }));
      await tryIt(kit.flights.getOffer(I1, { ...FQ, check: 'final' }, { optionId: 'standard' }));
    });
    logs.push(kit.log.text());
  }
  for (const name of fixtures('liteapi')) {
    const reply = { fixture: name, transform: poison };
    const kit = supplierKit({ keys, routes: [
      { method: 'POST', url: RATES, reply: name.startsWith('liteapi/rates') ? reply : [reply, 'liteapi/rates.cairo.json', 'liteapi/rates.hotel.json'] },
      { method: 'POST', url: PREBOOK, reply },
    ] });
    await withCompany(ORG, async () => {
      await tryIt(kit.hotels.search(HQ));
      const pq = { ...HQ, check: 'final' };
      let o = null;
      try { o = await kit.hotels.getOffer('htl_t.lp1001', pq); } catch (e) { errors.push(e); }
      if (o) await tryIt(kit.hotels.quote({ offerId: o.id, optionId: 'standard-room-ro-r', query: pq, offer: o }));
    });
    logs.push(kit.log.text());
  }
  assert.ok(errors.length >= 10, `the error paths ran (${errors.length})`);
  const seen = [...logs, ...errors.map(e => `${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${JSON.stringify(e.details ?? null)}`)].join('\n');
  for (const secret of [keys.token, keys.apiKey, keys.apiKey.slice(5, 25), NAME, 'Zelda', 'Quokka']) assert.ok(!seen.includes(secret), `never printed: ${secret.slice(0, 12)}`);
});

test('the app\'s 500 handler: an unexpected error quoting both keys leaves neither in the error log', async t => {
  const keys = testKeys();
  const logged = [];
  const log = { ...quietLog, error: (...a) => logged.push(a) };
  const app = await startApp({
    ENABLE_BUSINESS: 'true', BUSINESS_FLIGHT_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: keys.token,
    BUSINESS_HOTEL_SUPPLIER: 'liteapi', LITEAPI_API_KEY: keys.apiKey, BUSINESS_ALLOW_SUPPLIER_TEST: 'true',
  }, { log, businessFetch: fakeFetch([]).fetch });
  t.after(app.close);
  const stack = (app.app.router || app.app._router).stack;
  const handler = stack[stack.length - 1].handle;
  assert.equal(handler.length, 4);
  const res = { statusCode: 0, status(s) { this.statusCode = s; return this; }, type() { return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } };
  handler(new Error(`boom with ${keys.token} and ${keys.apiKey}`), { method: 'GET', originalUrl: `/x?k=${keys.apiKey}`, path: '/x' }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(logged.length, 1);
  const text = logged[0].map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join('\n');
  assert.ok(!text.includes(keys.token) && !text.includes(keys.apiKey), text.slice(0, 200));
  assert.match(text, /boom with \[secret\] and \[secret\]/);
  assert.ok(!JSON.stringify(res.body).includes(keys.apiKey));
  // Without the configured values the 41-character sandbox key is shorter than the generic token rule.
  assert.ok(redactText(keys.apiKey).includes(keys.apiKey));
  assert.equal(redactText(keys.apiKey, [keys.apiKey]), '[secret]');
  // The keys are not in the config as it serialises.
  assert.ok(!JSON.stringify(app.config).includes(keys.apiKey) && !JSON.stringify(app.config).includes(keys.token));
});

// ---------------------------------------------------------------------------------------------------------
// §7.4: the static rules

const ROOT = path.join(__dirname, '..');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');

test('static: under server/business only suppliers/http.js calls fetch; the suppliers require only what they may', () => {
  const business = walk(path.join(ROOT, 'server', 'business'));
  const callers = business.filter(f => /\bfetch\s*\(/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(callers, ['server/business/suppliers/http.js']);
  const ALLOWED = new Set(['../scope', '../tz', '../source', '../../lib/errors']);
  const suppliers = business.filter(f => rel(f).startsWith('server/business/suppliers/'));
  assert.ok(suppliers.length >= 10);
  for (const f of suppliers) {
    for (const [, spec] of fs.readFileSync(f, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const ok = spec.startsWith('node:') || ALLOWED.has(spec) || /^\.\/[a-z]+$/.test(spec);
      assert.ok(ok, `${rel(f)} requires ${spec}`);
    }
  }
});

test('static: nothing outside inventory.js and the tests requires business/suppliers; providers never mention business/', () => {
  const files = [...walk(path.join(ROOT, 'server')), ...(fs.existsSync(path.join(ROOT, 'scripts')) ? walk(path.join(ROOT, 'scripts')) : [])];
  const requirers = files.filter(f => !rel(f).startsWith('server/business/suppliers/'))
    .filter(f => /require\(\s*['"][^'"]*\bsuppliers(?:\/[^'"]*)?['"]\s*\)/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(requirers, ['server/business/inventory.js']);
  for (const f of walk(path.join(ROOT, 'server', 'providers'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /business\//, rel(f));
});

test('static: no AI model id or name in the supplier files, and no key-shaped literal in the fixtures', () => {
  // The vendor and model family names are written in hex, so this file holds none of them itself.
  const names = hex => hex.map(h => Buffer.from(h, 'hex').toString('utf8'));
  const VENDORS = names(['636c61756465', '616e7468726f706963', '6f70656e6169', '63686174677074', '67656d696e69', '6c6c616d61', '6d69737472616c']);
  const TIERS = names(['6f707573', '736f6e6e6574', '6861696b75']);
  const GPT = names(['677074'])[0];
  const MODEL = new RegExp(`(?:${VENDORS.join('|')})|\\b(?:${TIERS.join('|')})[-_ .]?\\d|\\b${GPT}[-_ ]?\\d`, 'i');
  assert.ok(MODEL.test(`${TIERS[0]}-4`) && MODEL.test(VENDORS[0].toUpperCase()) && !MODEL.test('sandbox gate'), 'the check itself works');
  const files = [
    ...walk(path.join(ROOT, 'server', 'business', 'suppliers')),
    path.join(ROOT, 'server', 'business', 'scope.js'),
    path.join(__dirname, 'supplier-fetch.js'),
  ];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), MODEL, rel(f));
  const KEYISH = /(?:duffel_(?:test|live)_[A-Za-z0-9]{8,}|sand_[0-9a-f]{8}-|prod_[0-9a-f]{8}-|Bearer [A-Za-z0-9_-]{12,})/;
  for (const dir of ['duffel', 'liteapi']) {
    for (const f of fs.readdirSync(path.join(FIXTURES, dir))) {
      const text = fs.readFileSync(path.join(FIXTURES, dir, f), 'utf8');
      assert.doesNotMatch(text, KEYISH, `${dir}/${f}`);
      assert.doesNotMatch(text, MODEL, `${dir}/${f}`);
      assert.ok(loadFixture(`${dir}/${f}`));
    }
  }
});

test('http.js: needs a gate and a clock; a redirect is refused; the URL never reaches an error', () => inOrg(async () => {
  assert.throws(() => createSupplierHttp({}), TypeError);
  const log = captureLog();
  let seen = null;
  const fetch = async (url, init) => { seen = init; throw new TypeError(`fetch failed for ${url}`); };
  const gate = new Gate({ now: testClock().now, log, sleep: async () => {} });
  const http = createSupplierHttp({ fetch, gate, now: testClock().now, log, sleep: async () => {} });
  const err = await http.call({ supplier: 'liteapi', op: 'rates', vertical: 'hotels', url: 'https://api.liteapi.travel/v3.0/hotels/rates?secret=1', method: 'POST', headers: { 'X-API-Key': 'sand_PLACEHOLDER' }, body: '{}', timeoutMs: 1000 }).catch(e => e);
  assert.ok(down('hotels')(err));
  assert.equal(seen.redirect, 'error');
  assert.ok(seen.signal instanceof globalThis.AbortSignal);
  for (const s of ['secret=1', 'sand_PLACEHOLDER', 'api.liteapi.travel']) assert.ok(!`${err.message}${err.stack}${log.text()}`.includes(s), s);
}));
