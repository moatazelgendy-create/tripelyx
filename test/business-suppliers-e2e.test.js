// Real suppliers end to end (real-suppliers design §7.1 "End to end", §8.4 step R1-m): the whole app over HTTP,
// with Duffel and LiteAPI reached only through the injected fetch (createApp's businessFetch, test/supplier-fetch.js
// fakeFetch) answered by test/supplier-double.js, which reshapes the fixtures in test/fixtures/suppliers per call
// (its header cites the documentation page of each answer). Nothing here reaches a supplier and nothing holds a
// key: the keys are built at run time (supplier-fetch.js testKeys) and fakeFetch checks every call carries them
// only where they belong.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const {
  seedUser, client, seedOrg, seedMember, seedDepartment, seedBudget, mutableClock, noInline, storeSnapshot,
} = require('./business-helpers');
const { fakeFetch, captureLog, supplierLines, testKeys, BAD_SUPPLIER_ENVS } = require('./supplier-fetch');
const sandbox = require('./business-sandbox');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { PRICE_CHECK_COPY, SUPPLIER_ERRORS } = require('../server/business/source');
const { SANDBOX_RIBBON } = require('../server/views/business/parts');
const { HOTELS_NOT_CONNECTED } = require('../server/views/business/results');
const { currentCompany, withCompany } = require('../server/business/scope');
const { supplierDouble, opsOf, OFFER_GET } = require('./supplier-double');

const { textOf, assertSourceMoney } = sandbox;
const mainOf = page => (page.match(/<main\b[\s\S]*<\/main>/) || [''])[0];
const textMain = page => textOf(mainOf(page));
const qs = q => new URLSearchParams(q).toString();
/** One way, CAI to LHR on Thursday 12 November, 2 nights in London, Economy, dates fixed. */
const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '', hotel: '1', nights: '2', cabin: 'economy', flex: '0' });
const REASON = 'The client workshop starts at 14:00 and this is the only fare that lets me change the flight.';

// ---------------------------------------------------------------------------------------------------------
// The world: the app on the supplier double, Acme Inc as in test/business-traveler.test.js (an Owner, Dana the
// Manager, Sam her report in Engineering, a Travel Admin and Finance, a 20,000 dollar Q4 budget).

const supplierEnv = keys => ({
  ENABLE_BUSINESS: 'true', BUSINESS_FLIGHT_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: keys.token,
  BUSINESS_HOTEL_SUPPLIER: 'liteapi', LITEAPI_API_KEY: keys.apiKey, BUSINESS_ALLOW_SUPPLIER_TEST: 'true',
});

async function company(app, name) {
  const owner = await seedUser(app, { name: `${name} Owner` });
  const org = await seedOrg(app, owner, { name });
  const eng = await seedDepartment(app, org, { name: 'Engineering' });
  const dana = await seedMember(app, org, 'manager', { name: 'Dana Lee', departmentId: eng.id });
  const sam = await seedMember(app, org, 'employee', { name: 'Sam Rivera', departmentId: eng.id, managerId: dana.user.id });
  const fay = await seedMember(app, org, 'finance', { name: 'Fay Finance' });
  await seedBudget(app, org, eng.id, { periodKey: '2026-Q4', amountCents: 2000000 });
  const co = {
    org, eng, owner, dana, sam, fay, B: `/business/o/${org.id}`,
    as: m => ({ org: { id: org.id }, user: m.user }),
    /** Point the members' clients at an app (the same store after a restart). */
    at(running) {
      const http = m => client(running.base, m.cookie);
      co.c = { owner: http(owner), dana: http(dana), sam: http(sam), fay: http(fay) };
      return co;
    },
  };
  return co.at(app);
}

async function world({ env = {}, store = new MemoryStore(), clock = mutableClock(FIXED_NOW) } = {}) {
  const keys = testKeys();
  const double = supplierDouble(clock);
  const ff = fakeFetch(double.routes, keys);
  const log = captureLog();
  // The company each call ran for, in call order (the per-company limit and cache key on it).
  const scopes = [];
  const businessFetch = (url, init) => { scopes.push(currentCompany()); return ff.fetch(url, init); };
  const app = await startApp({ ...supplierEnv(keys), ...env }, { now: clock.now, store, log, businessFetch });
  return { app, svc: app.business, clock, keys, double, state: double.state, ff, scopes, log, store };
}

/** The sandbox page checks: CSP, no em dash, every amount in a TEST DATA container, no supplier id. */
function checkPage(label, res, { min = 0 } = {}) {
  noInline(label, res.text);
  const main = mainOf(res.text);
  assert.ok(main, `${label}: has <main>`);
  assert.doesNotMatch(textOf(main), /—/, `${label}: no em dash`);
  assert.doesNotMatch(res.text, /\boff_[A-Za-z0-9]|offer_PLACEHOLDER|pb_PLACEHOLDER|rt_offer|sand_|duffel_test_/, `${label}: no supplier id or key`);
  assertSourceMoney(main, 'sandbox', { label, min });
  return main;
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

/** The ZZ1234 Flexible fare (412.00, over the Standard policy's $279.84) and Paddington Lodge's Double Room (3-star). */
const FLEX = 'f.flt_t.ZZ1234_20261112T0835_economy|flexible';
const SUITES = 'h.htl_t.lp1002|superior-room-ro-n';
const LODGE = 'h.htl_t.lp1004|double-room-ro-n';
const formFor = (out, hotelKey) => ({ ...Q, out, hotelKey, hotelChoice: '1', purpose: 'Client workshop in London' });

/** The traveler's own read of a request (no price check: a traveler's view never asks a supplier). */
const requestOf = async (w, co, rid) => (await withCompany(co.org.id, () => w.svc.getRequest(co.as(co.sam), rid))).request;

/**
 * A world with Acme Inc and one pending request: Sam's ZZ1234 Flexible fare (out of policy) and 2 nights at
 * Paddington Lodge, sent for approval with a reason.
 */
async function pendingTrip(opts = {}) {
  const w = await world(opts);
  const co = await company(w.app, 'Acme Inc');
  let res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200, textMain(res.text).slice(0, 300));
  const rid = await createDraft(co, formFor(FLEX, LODGE));
  res = await co.c.sam.get(`${co.B}/trips/${rid}`);
  res = await co.c.sam.post(`${co.B}/trips/${rid}/submit`, { rev: revOf(mainOf(res.text), 'submit'), reason: REASON, category: 'client_meeting' });
  assert.equal(res.location, `${co.B}/trips/${rid}?ok=submitted`, textMain(res.text).slice(0, 300));
  return { w, co, rid };
}

/** Dana opens the request (a page view: the cached prices, no supplier call) and approves it. */
async function approve(co, rid) {
  const page = await co.c.dana.get(`${co.B}/trips/${rid}`);
  assert.equal(page.status, 200, textMain(page.text).slice(0, 300));
  return co.c.dana.post(`${co.B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(mainOf(page.text), 'decide') });
}

/** Nothing leaked: the calls carried the keys only in their headers, no key in any log line, no id crossed. */
function assertClean(w) {
  w.ff.assertClean();
  const logged = w.log.text();
  assert.ok(!logged.includes(w.keys.token) && !logged.includes(w.keys.apiKey), 'no key in the log');
  assert.deepEqual(w.double.crossed, [], 'every supplier id was used by the company it was served to');
}

// ---------------------------------------------------------------------------------------------------------

test('the journey on supplier test data: search, TEST DATA results, a draft, a swap, Request Approval (flight GET and hotel rates), the approver\'s cached check, and approval (with the prebook); nothing is booked', async t => {
  const w = await world();
  t.after(w.app.close);
  const co = await company(w.app, 'Acme Inc');
  const { B, c } = co;
  const ops = () => opsOf(w.ff.calls);
  assert.equal(w.svc.inventory.status, 'sandbox');

  // Search: one offer request and one rates call, both for this company, and every row is TEST DATA.
  let res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200, textMain(res.text).slice(0, 300));
  let main = checkPage('results', res, { min: 20 });
  assert.deepEqual(ops(), ['offer_request', 'rates']);
  const [orq, rates] = w.ff.calls;
  assert.deepEqual(orq.body.data.slices, [{ origin: 'CAI', destination: 'LHR', departure_date: '2026-11-12' }]);
  assert.equal(orq.body.data.cabin_class, 'economy');
  assert.deepEqual([rates.body.cityName, rates.body.countryCode, rates.body.checkin, rates.body.checkout, rates.body.currency], ['London', 'GB', '2026-11-12', '2026-11-14', 'USD']);
  assert.ok(textOf(res.text).includes(`TEST DATA ${SANDBOX_RIBBON}`), 'the ribbon');
  assert.ok(textOf(main).includes('Test airline'), "Duffel's test airline by its name");
  for (const name of ['Thames View Hotel', 'Garden Court Suites', 'Paddington Lodge']) assert.ok(textOf(main).includes(name), name);
  const outs = radioKeys(res.text, 'out'), hotels = radioKeys(res.text, 'hotelKey').filter(Boolean);
  assert.ok(outs.length >= 10 && hotels.length >= 5, `${outs.length} fares, ${hotels.length} rooms`);
  for (const key of [...outs, ...hotels]) assert.match(key, /^[fh]\.(flt|htl)_t\./, 'a supplier test data key');
  assert.ok(outs.includes(FLEX) && hotels.includes(SUITES) && hotels.includes(LODGE));
  // What the adapter left out is said, never shown: a first-class fare, a GBP fare, an owner with no code.
  assert.ok(textOf(main).includes('1 fare priced in another currency is not shown.'));

  // The same search again is the company's cache: no call.
  res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200);
  assert.equal(w.ff.calls.length, 2, 'served from the cache');

  // Review trip: the Flexible fare and a 4.5-star hotel, both outside the Standard policy. Priced from the cache.
  const rid = await createDraft(co, formFor(FLEX, SUITES));
  res = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('draft', res, { min: 5 });
  assert.match(textOf(main), /Out of policy: 2 reasons/);
  assert.ok(textOf(main).includes('4.5-star hotel. Your policy allows up to 4 stars.'));
  assert.ok(textOf(main).includes('Of this total, $20 is paid at the hotel.'), "the hotel's resort fee is in the total");
  assert.match(textOf(main), /Trip total \$631\.99/);
  assert.match(textOf(main), /AI-powered cheaper alternatives/);
  assert.equal(w.ff.calls.length, 2, 'the draft and its alternatives came from the same search');

  // Swap the hotel for the cheaper one inside the policy.
  const draft = await requestOf(w, co, rid);
  const alt = draft.alternatives.find(a => a.change && a.change.component === 'hotel' && a.rows.hotel.offerId === 'htl_t.lp1004');
  assert.ok(alt, `a hotel alternative at Paddington Lodge: ${draft.alternatives.map(a => a.kind).join(', ')}`);
  res = await c.sam.post(`${B}/trips/${rid}/swap`, { altId: alt.id, rev: revOf(main, 'swap') });
  assert.equal(res.location, `${B}/trips/${rid}?ok=swapped`, textMain(res.text).slice(0, 300));
  res = await c.sam.get(res.location);
  main = checkPage('swapped', res, { min: 4 });
  assert.ok(textOf(main).includes('Switched to the cheaper option. Here is your updated trip.'));
  assert.ok(textOf(main).includes('Paddington Lodge') && !textOf(main).includes('Garden Court Suites'));
  assert.match(textOf(main), /Out of policy: 1 reason/, 'the flight is still over the limit');
  assert.equal(w.ff.calls.length, 2, 'a swap prices nothing again');

  // Request Approval: the price check at submit is the fare's GET and fresh rates for the hotel, no prebook.
  res = await c.sam.post(`${B}/trips/${rid}/submit`, { rev: revOf(main, 'submit'), reason: REASON, category: 'client_meeting' });
  assert.equal(res.location, `${B}/trips/${rid}?ok=submitted`, textMain(res.text).slice(0, 300));
  assert.deepEqual(ops().slice(2), ['offer_get', 'rates_hotel']);
  const [get, hotelRates] = w.ff.calls.slice(2);
  assert.match(get.url, /\/air\/offers\/off_20261112R1\w+$/, 'the Flexible fare from this search');
  assert.deepEqual(hotelRates.body.hotelIds, ['lp1004'], 'rates for the picked hotel only');
  res = await c.sam.get(res.location);
  main = checkPage('pending (traveler)', res, { min: 3 });
  assert.ok(textOf(main).includes('Sent for approval. We don\'t send emails yet, so Dana Lee will see it under Approvals.'));

  // The approver: the inbox and the request page read the prices the submit's check stored. No supplier call.
  res = await c.dana.get(`${B}/approvals`);
  assert.equal(res.status, 200);
  main = checkPage('approvals', res, { min: 1 });
  assert.ok(textOf(main).includes('Sam Rivera') && textOf(main).includes('$552'));
  res = await c.dana.get(`${B}/trips/${rid}`);
  main = checkPage('pending (approver)', res, { min: 4 });
  assert.ok(textOf(main).includes('Price checked again at 12:00 PM today: unchanged.'));
  assert.ok(textOf(main).includes(REASON));
  assert.equal(w.ff.calls.length, 4, "the approver's page view asked no supplier");

  // Approve: the final check is the fare's GET, fresh hotel rates and a prebook of the fresh rate.
  res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(main, 'decide') });
  assert.equal(res.location, `${B}/trips/${rid}?ok=approved`, textMain(res.text).slice(0, 300));
  assert.deepEqual(ops().slice(4), ['offer_get', 'rates_hotel', 'prebook']);
  const prebook = w.ff.calls[6];
  assert.match(prebook.body.offerId, /_lp1004_\w+_c3$/, 'the room from the decision\'s own rates call');
  assert.equal(prebook.body.usePaymentSdk, false);
  res = await c.dana.get(res.location);
  main = checkPage('approved (approver)', res, { min: 3 });
  assert.ok(textOf(main).includes('Approval saved. Sam sees it on this trip.'));
  assert.ok(textOf(main).includes('Approved (test data). Nothing was booked.'));
  res = await c.sam.get(`${B}/trips`);
  main = checkPage('trips (traveler)', res, { min: 1 });
  assert.match(main, /<span class="bz-pill bz-pill-good">Approved \(test data\)<\/span>/);

  // The CSV says where each amount came from.
  res = await c.fay.post(`${B}/reports/export`, { period: '2026-Q4' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  const lines = res.text.split('\r\n');
  assert.match(lines[0], /^﻿?price_source,request_id,/);
  const row = lines.find(l => l.includes(rid));
  assert.ok(row && row.startsWith('Supplier test data,'), row);
  assert.match(row, /,552\.00,/);
  assert.doesNotMatch(res.text, /Demo price|off_|offer_PLACEHOLDER/);

  // Nothing was booked and nothing was charged.
  assert.equal(w.store.bookings.size, 0);
  assert.equal(w.store.quotes.size, 0);
  const lines2 = supplierLines(w.log);
  assert.equal(lines2.length, 7, 'one log line per supplier call');
  assert.ok(lines2.every(l => l.outcome === 'ok' && /^[0-9a-f]{8}$/.test(l.company)), 'each names its company by a tag');
  assert.equal(new Set(lines2.map(l => l.company)).size, 1);
  assertClean(w);
});

test('at the decision, the final check finds a new price: the trip goes back to the traveler (price_changed), nothing approved', async t => {
  const { w, co, rid } = await pendingTrip();
  t.after(w.app.close);
  const before = w.ff.calls.length;
  // The airline's new total for the fare (the change duffel/offer.get.price-changed.json shows): 11.50 more.
  w.state.fares.set('ZZ1234|Flexible', { addCents: 1150 });
  let res = await approve(co, rid);
  assert.equal(res.location, `${co.B}/trips/${rid}?ok=returned`, textMain(res.text).slice(0, 300));
  assert.deepEqual(opsOf(w.ff.calls.slice(before)).sort(), ['offer_get', 'prebook', 'rates_hotel']);
  const r = await requestOf(w, co, rid);
  assert.equal(r.status, 'draft');
  assert.deepEqual([r.returned.why, r.returned.fromCents, r.returned.toCents], ['price_changed', 55200, 56350]);
  assert.ok(!r.history.some(h => h.action === 'approved'), 'nothing approved');
  res = await co.c.dana.get(res.location);
  let main = checkPage('returned (approver)', res, { min: 2 });
  assert.ok(textOf(main).includes('The price changed while this was waiting, so it went back to Sam. Nothing was approved.'));
  assert.match(textOf(main), /Was \$552 ?, now \$563\.50 ?\./);
  res = await co.c.sam.get(`${co.B}/trips/${rid}`);
  main = checkPage('returned (traveler)', res, { min: 3 });
  assert.ok(textOf(main).includes('The price changed while this was waiting, so it came back to you. Nothing was approved. Review the new total and request approval again.'));
  assert.match(textOf(main), /Trip total \$563\.50/, 'the draft carries the new price');
  revOf(main, 'submit');
  assertClean(w);
});

test('at the decision, the fare terms changed at the same price: back to the traveler (terms_changed), with the new terms shown', async t => {
  const { w, co, rid } = await pendingTrip();
  t.after(w.app.close);
  // Refunds are no longer allowed (the change duffel/offer.get.terms-changed.json shows); the total is the same.
  w.state.fares.set('ZZ1234|Flexible', { refund: false });
  let res = await approve(co, rid);
  assert.equal(res.location, `${co.B}/trips/${rid}?ok=returned`, textMain(res.text).slice(0, 300));
  const r = await requestOf(w, co, rid);
  assert.deepEqual([r.status, r.returned.why, r.returned.fromCents, r.returned.toCents], ['draft', 'terms_changed', 55200, 55200]);
  res = await co.c.sam.get(`${co.B}/trips/${rid}`);
  const main = checkPage('terms changed (traveler)', res, { min: 3 });
  const text = textOf(main);
  assert.ok(text.includes('The fare or room terms changed while this was waiting, so it came back to you. The price is the same. Nothing was approved.'));
  assert.ok(text.includes('Refunds: not allowed. Changes: free changes allowed.'), 'the fare as the airline now sells it');
  assert.ok(!text.includes('Refunds: allowed with no fee.'), 'never the old terms');
  assertClean(w);
});

test('at the decision, the fare is gone (422 offer_no_longer_available, then not in a fresh search): back to the traveler (unavailable)', async t => {
  const { w, co, rid } = await pendingTrip();
  t.after(w.app.close);
  const before = w.ff.calls.length;
  w.state.goneFlights.add('ZZ1234|Flexible');
  let res = await approve(co, rid);
  assert.equal(res.location, `${co.B}/trips/${rid}?ok=returned`, textMain(res.text).slice(0, 300));
  const asked = opsOf(w.ff.calls.slice(before));
  assert.equal(asked.filter(o => o === 'offer_get').length, 1, asked.join());
  assert.equal(asked.filter(o => o === 'offer_request').length, 1, 'searched again once before giving up');
  const r = await requestOf(w, co, rid);
  assert.deepEqual([r.status, r.returned.why], ['draft', 'unavailable']);
  res = await co.c.dana.get(res.location);
  checkPage('gone (approver)', res);
  assert.ok(textMain(res.text).includes("An option in this trip is no longer in the supplier's test data, so it went back to Sam. Nothing was approved."));
  res = await co.c.sam.get(`${co.B}/trips/${rid}`);
  const main = checkPage('gone (traveler)', res, { min: 1 });
  assert.ok(textOf(main).includes("An option in this trip is no longer in the supplier's test data, so it came back to you. Nothing was approved. Plan the trip again to choose new options."));
  assert.ok(textOf(main).includes("Outbound flight: no longer in the supplier's test data."));
  assert.doesNotMatch(main, /action="[^"]*\/submit"/, 'it cannot be sent as it is');
  assertClean(w);
});

test('at the decision, the flight supplier is down: 503 on the page with the request untouched (500 is never retried); once it is back the decision goes through', async t => {
  const { w, co, rid } = await pendingTrip();
  t.after(w.app.close);
  let before = w.ff.calls.length;
  w.state.offerGet = 'down';
  const snap = storeSnapshot(w.app);
  let res = await approve(co, rid);
  assert.equal(res.status, 503, textMain(res.text).slice(0, 300));
  const main = checkPage('decide 503', res, { min: 1 });
  assert.ok(textOf(main).includes(PRICE_CHECK_COPY.unchanged));
  assert.ok(textOf(main).includes('Waiting for approval'));
  revOf(main, 'decide');
  assert.equal(storeSnapshot(w.app), snap, 'nothing written');
  assert.equal(opsOf(w.ff.calls.slice(before)).filter(o => o === 'offer_get').length, 1, 'Duffel 500: "You should not retry this request" (D-ERR)');
  assert.ok(supplierLines(w.log).some(l => l.op === 'offer_get' && l.status === 500));
  w.state.offerGet = 'up';
  before = w.ff.calls.length;
  res = await approve(co, rid);
  assert.equal(res.location, `${co.B}/trips/${rid}?ok=approved`, textMain(res.text).slice(0, 300));
  assert.deepEqual(opsOf(w.ff.calls.slice(before)).sort(), ['offer_get', 'prebook', 'rates_hotel']);
  assertClean(w);
});

test('the company limit used up: the approver still reads the pending request (the check is said to have failed), and the decision answers 429 with the request untouched', async t => {
  // Four supplier calls an hour for this company: the search and the submit's check use them all.
  const { w, co, rid } = await pendingTrip({ env: { BUSINESS_SUPPLIER_COMPANY_CALLS_PER_HOUR: '4' } });
  t.after(w.app.close);
  assert.equal(w.ff.calls.length, 4);
  // Six minutes on: the cached prices (300 s) have lapsed, so a page view would need the supplier.
  w.clock.set('2026-10-09T09:06:00.000Z');
  let res = await co.c.dana.get(`${co.B}/trips/${rid}`);
  assert.equal(res.status, 200, 'the page still opens');
  let main = checkPage('approver, limit used up', res, { min: 3 });
  assert.ok([PRICE_CHECK_COPY.skipped, PRICE_CHECK_COPY.failed].some(copy => textOf(main).includes(copy)), textOf(main).slice(0, 600));
  assert.ok(textOf(main).includes(REASON));
  const snap = storeSnapshot(w.app);
  res = await co.c.dana.post(`${co.B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(main, 'decide') });
  assert.equal(res.status, 429);
  main = checkPage('decide 429', res, { min: 1 });
  assert.ok(textOf(main).includes(SUPPLIER_ERRORS.supplier_busy.message));
  assert.ok(textOf(main).includes('Waiting for approval'));
  assert.equal(storeSnapshot(w.app), snap, 'nothing written');
  assert.equal(w.ff.calls.length, 4, 'the limit stopped the calls before they were sent');
  assertClean(w);
});

test('a flight supplier outage: the search answers 503 with the search kept and nothing written; a hotel-only outage still shows the flights; flights only says hotels are not connected', async t => {
  const w = await world();
  t.after(w.app.close);
  const co = await company(w.app, 'Acme Inc');
  const { B, c } = co;
  const snap = storeSnapshot(w.app);

  // Duffel answers 500: never retried, nothing made up, the form keeps the search.
  w.state.flights = 'down';
  let res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 503, textMain(res.text).slice(0, 300));
  let main = mainOf(res.text);
  noInline('search 503', res.text);
  assert.ok(textOf(main).includes(SUPPLIER_ERRORS.supplier_unavailable.flights));
  assert.match(main, /<input id="t-depart" name="depart"[^>]*value="2026-11-12"/, 'the search is kept');
  assert.doesNotMatch(main, /bz-money|name="out"/, 'no fare is shown');
  assert.equal(opsOf(w.ff.calls).filter(o => o === 'offer_request').length, 1, 'a 500 is not retried');
  res = await c.sam.post(`${B}/trips`, formFor(FLEX, LODGE));
  assert.equal(res.status, 503);
  assert.ok(textMain(res.text).includes(SUPPLIER_ERRORS.supplier_unavailable.flights));
  assert.equal(storeSnapshot(w.app), snap, 'nothing written');
  assert.deepEqual(opsOf(w.ff.calls).filter(o => o === 'offer_request'), ['offer_request', 'offer_request'], 'one call each, never retried');

  // Back up: the search works again (a failed answer was never cached).
  w.state.flights = 'up';
  res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200);
  checkPage('results after the outage', res, { min: 20 });

  // LiteAPI answers 4291 (HTTP 500) on a new search (another stay, so nothing is cached): flights still shown.
  w.state.hotels = 'down';
  const calls = w.ff.calls.length;
  res = await c.sam.get(`${B}/trips/search?${qs({ ...Q, nights: '3' })}`);
  assert.equal(res.status, 200, textMain(res.text).slice(0, 300));
  main = checkPage('results, hotels down', res, { min: 10 });
  assert.ok(textOf(main).includes(PRICE_CHECK_COPY.hotelsLeg));
  assert.ok(radioKeys(res.text, 'out').includes(FLEX), 'the flights can still be picked');
  assert.deepEqual(radioKeys(res.text, 'hotelKey').filter(Boolean), [], 'no room to pick');
  assert.deepEqual(opsOf(w.ff.calls.slice(calls)), ['rates', 'rates'], 'a LiteAPI 5xx is retried once (§4.2); the flights came from the cache');
  // The traveler can still request the flights: a draft without a hotel.
  const rid = await createDraft(co, { ...Q, nights: '3', out: FLEX, hotelKey: '', hotelChoice: '1', purpose: 'Client workshop in London' });
  res = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('flights-only draft', res, { min: 2 });
  assert.match(textOf(main), /Trip total \$412\b/);
  assertClean(w);
});

test('flights only (no hotel supplier set): the results say hotels are not connected yet, and LiteAPI is never called', async t => {
  const w = await world({ env: { BUSINESS_HOTEL_SUPPLIER: '', LITEAPI_API_KEY: '' } });
  t.after(w.app.close);
  assert.equal(w.svc.inventory.status, 'sandbox');
  assert.equal(w.svc.inventory.hotelsConnected, false);
  const co = await company(w.app, 'Acme Inc');
  const res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200);
  const main = checkPage('flights only', res, { min: 10 });
  assert.ok(textOf(main).includes(HOTELS_NOT_CONNECTED));
  assert.deepEqual(opsOf(w.ff.calls), ['offer_request']);
  w.ff.assertClean();
});

test('a bad supplier setting: the app still boots, says "Supplier not connected yet" (never demo), calls no supplier, and tells a platform admin what to fix', async t => {
  for (const [label, change] of BAD_SUPPLIER_ENVS) {
    const w = await world({ env: { ...change, ADMIN_EMAILS: 'ops@example.com' } });
    try {
      const inv = w.svc.inventory;
      assert.equal(inv.status, 'none', label);
      assert.equal(typeof inv.problem, 'string', label);
      assert.doesNotMatch(inv.problem, /duffel_|sand_|FAKE|SECRET/, `${label}: the problem names the variable, never its value`);
      const co = await company(w.app, 'Acme Inc');
      let res = await co.c.sam.get(`${co.B}/trips/new`);
      assert.equal(res.status, 200, label);
      let main = mainOf(res.text);
      assert.equal(textOf(main).split('Supplier not connected yet.').length - 1, 1, `${label}: said once`);
      assert.doesNotMatch(main, /data-price-source|Demo price|TEST DATA/, `${label}: no price of any source`);
      res = await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`);
      assert.equal(res.status, 503, label);
      assert.doesNotMatch(mainOf(res.text), /bz-money/, label);
      // The problem is for platform admins only.
      assert.doesNotMatch(textOf(res.text), /needs attention|DUFFEL_|LITEAPI_|BUSINESS_/, `${label}: a company never sees the setting`);
      const ops = await seedUser(w.app, { name: 'Pat Platform', email: 'ops@example.com' });
      await w.app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
      res = await client(w.app.base, ops.cookie).get('/admin/business');
      assert.equal(res.status, 200, label);
      assert.ok(textOf(res.text).includes(`A supplier setting needs attention: ${inv.problem} Companies see "Supplier not connected yet" until this is fixed.`), `${label}: ${textOf(res.text).slice(0, 300)}`);
      assert.equal(w.ff.calls.length, 0, `${label}: no supplier call`);
      assert.ok(!w.log.text().includes(w.keys.token) && !w.log.text().includes(w.keys.apiKey), `${label}: no key in the log`);
    } finally {
      await w.app.close();
    }
  }
});

test('an old demo request after the switch to supplier test data: its prices are not re-checked against a supplier, and approving it sends it back as unavailable', async t => {
  const store = new MemoryStore();
  const clock = mutableClock(FIXED_NOW);
  // Before the switch: demo Business on the same store.
  const demo = await startApp({ ENABLE_BUSINESS: 'true' }, { now: clock.now, store });
  let co, rid;
  try {
    assert.equal(demo.business.inventory.status, 'demo');
    co = await company(demo, 'Acme Inc');
    const sv = await demo.business.searchTrip(co.as(co.sam), { ...Q, cabin: 'business' });
    const out = sv.legs.out.rows.find(r => r.row.available && r.evaluation.status === 'out');
    const hotel = sv.legs.hotel.rows.find(r => r.row.available);
    assert.ok(out && hotel);
    rid = await createDraft(co, { ...formFor(out.row.key, hotel.row.key), cabin: 'business' });
    let res = await co.c.sam.get(`${co.B}/trips/${rid}`);
    res = await co.c.sam.post(`${co.B}/trips/${rid}/submit`, { rev: revOf(mainOf(res.text), 'submit'), reason: REASON, category: 'client_meeting' });
    assert.equal(res.location, `${co.B}/trips/${rid}?ok=submitted`, textMain(res.text).slice(0, 300));
  } finally {
    await demo.close();
  }

  // After: the same store, the suppliers' test systems.
  const w = await world({ store, clock });
  t.after(w.app.close);
  assert.equal(w.svc.inventory.status, 'sandbox');
  co.at(w.app);
  // The approver's page: the demo options are not the supplier's, so nothing is asked, and the page says
  // approving sends it back. Its amounts keep their own label: they are demo prices.
  let res = await co.c.dana.get(`${co.B}/trips/${rid}`);
  assert.equal(res.status, 200);
  let main = mainOf(res.text);
  noInline('old demo request (approver)', res.text);
  assert.ok(textOf(main).includes('Price checked again at 12:00 PM today: an option is no longer in the demo data. Approving sends it back to Sam, and nothing is approved.'), textOf(main).slice(0, 600));
  assert.match(main, /<button[^>]*value="approve"[^>]*>(?:(?!<\/button>)[\s\S])*<span>Send back to Sam<\/span><\/button>/);
  assert.match(main, /data-price-source="demo"/);
  assert.doesNotMatch(main, /data-price-source="sandbox"/, 'a demo amount is never labelled supplier test data');
  assert.equal(w.ff.calls.length, 0, 'the page view asked no supplier');

  res = await approve(co, rid);
  assert.equal(res.location, `${co.B}/trips/${rid}?ok=returned`, textMain(res.text).slice(0, 300));
  const r = await requestOf(w, co, rid);
  assert.deepEqual([r.status, r.returned.why], ['draft', 'unavailable']);
  // The final check asked nothing about the demo options (no GET, no hotel rates, no prebook); the one search
  // is the returned draft's own (requests.js repricedDraft, counted in design §4.5).
  assert.deepEqual(opsOf(w.ff.calls), ['offer_request', 'rates']);
  assert.equal(w.ff.calls[0].body.data.cabin_class, 'business', "the trip's own search");
  res = await co.c.sam.get(`${co.B}/trips/${rid}`);
  main = mainOf(res.text);
  assert.ok(textOf(main).includes('An option in this trip is no longer in the demo data, so it came back to you. Nothing was approved. Plan the trip again to choose new options.'));
  assert.ok(textOf(main).includes('Outbound flight: no longer in the demo data.'));
  assert.doesNotMatch(main, /data-price-source="sandbox"/);
  w.ff.assertClean();
});

test('two companies: each has its own cache and its own count, every supplier id stays with the company it was served to, and neither sees the other\'s request', async t => {
  const w = await world();
  t.after(w.app.close);
  const acme = await company(w.app, 'Acme Inc');
  const beta = await company(w.app, 'Beta Co');
  const gate = w.svc.inventory.flights.http.gate;

  // The same search by both: each company asks for itself; asking again is each one's own cache.
  for (const co of [acme, beta]) {
    for (let i = 0; i < 2; i += 1) assert.equal((await co.c.sam.get(`${co.B}/trips/search?${qs(Q)}`)).status, 200);
  }
  assert.deepEqual(opsOf(w.ff.calls), ['offer_request', 'rates', 'offer_request', 'rates']);
  assert.deepEqual(w.scopes, [acme.org.id, acme.org.id, beta.org.id, beta.org.id]);

  // Both send a trip: each check reads its own company's offer ids.
  const rids = {};
  for (const [name, co] of [['acme', acme], ['beta', beta]]) {
    rids[name] = await createDraft(co, formFor(FLEX, LODGE));
    const page = await co.c.sam.get(`${co.B}/trips/${rids[name]}`);
    const res = await co.c.sam.post(`${co.B}/trips/${rids[name]}/submit`, { rev: revOf(mainOf(page.text), 'submit'), reason: REASON, category: 'client_meeting' });
    assert.equal(res.location, `${co.B}/trips/${rids[name]}?ok=submitted`);
  }
  const gets = w.ff.calls.filter(c => OFFER_GET.test(c.url)).map(c => c.url.split('/').pop());
  assert.equal(gets.length, 2);
  assert.match(gets[0], /^off_20261112R1/, "Acme's check: Acme's search");
  assert.match(gets[1], /^off_20261112R2/, "Beta's check: Beta's search");
  assert.deepEqual(w.scopes.slice(4), [acme.org.id, acme.org.id, beta.org.id, beta.org.id]);

  // Each company counted against its own limit; nothing in the shared unscoped bucket.
  assert.deepEqual([...gate.companies.keys()].sort(), [acme.org.id, beta.org.id].sort());
  assert.equal(gate.companies.get(acme.org.id).length, 4);
  assert.equal(gate.companies.get(beta.org.id).length, 4);
  assert.deepEqual(gate.unscoped, []);
  assert.deepEqual([...new Set(supplierLines(w.log).map(l => l.company))].length, 2, 'two company tags in the log');

  // Neither reaches the other's request, by either company's address.
  for (const [co, other] of [[beta, 'acme'], [acme, 'beta']]) {
    const theirs = other === 'acme' ? acme : beta;
    for (const who of [co.c.sam, co.c.dana, co.c.owner]) {
      assert.equal((await who.get(`${theirs.B}/trips/${rids[other]}`)).status, 404);
      assert.equal((await who.get(`${co.B}/trips/${rids[other]}`)).status, 404);
    }
    const inbox = await co.c.dana.get(`${co.B}/approvals`);
    assert.equal(inbox.status, 200);
    assert.ok(!inbox.text.includes(rids[other]) && !inbox.text.includes(theirs.org.id), 'no row or id of the other company');
    const trips = await co.c.owner.get(`${co.B}/trips?scope=all`);
    assert.equal(trips.status, 200);
    assert.ok(trips.text.includes(rids[other === 'acme' ? 'beta' : 'acme']), 'the company\'s own request is listed');
    assert.ok(!trips.text.includes(rids[other]), 'the other company\'s is not');
  }
  assertClean(w);
});
