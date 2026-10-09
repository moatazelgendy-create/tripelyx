// The opt-in contract test against the supplier SANDBOXES (real-suppliers design §7.2), run by
// .github/workflows/supplier-sandbox.yml (§7.3). It runs only when SUPPLIER_SANDBOX=1 and both DUFFEL_TEST_TOKEN
// and LITEAPI_SANDBOX_KEY are set; otherwise its sandbox case is skipped, so `npm test` never reaches the network.
// It refuses any key that is not a test key (Duffel `duffel_test_`, LiteAPI `sand_`): it never reaches live.
//
// The real adapters (suppliers/index.js, as the inventory wires them) run through http.js with the real fetch,
// paced to at most 1 request a second for LiteAPI and 10 a minute for Duffel (about 3 minutes in all):
// - Duffel: our routes CAI-LHR, DXB-LHR, CAI-DXB 30 and 60 days ahead; each test-mode scenario of D-TYI
//   (https://duffel.com/docs/api/overview/test-your-integration): PVD-RAI no offers, LHR-STN a new price on GET,
//   LGW-LHR offer no longer available, STN-LHR timeout, LHR-DXB a connection, BTS-MRU no bags, DXB-AMS one stop
//   inside the segment; live_mode false everywhere; the ratelimit headers (ratelimit-reset is an HTTP-date);
//   GET /air/airlines against suppliers/airlines.js;
// - LiteAPI: rates for the 10 Business cities and New Alamein (sandbox true on every answer, USD, stars, taxes,
//   RFN/NRFN); Cairo sorted by price with limit 40 against limit 200; at most 3 prebooks of a fresh rate (Cairo,
//   Dubai, London; each locks a room briefly, L-VAL), plus one deliberate prebook of an old offerId that the
//   supplier refuses (4040 or 2001); Cairo with guestNationality US and EG.
// Output: counts, booleans and medians only, in the job log and supplier-sandbox-report.json. Never an id, a
// key, a name or a body. The same harness runs on every `npm test` against the fixtures ("dry run", no
// network), so its code is exercised and its report is checked for anything that is not a count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../server/config');
const { createBusinessSuppliers } = require('../server/business/suppliers');
const { Gate } = require('../server/business/suppliers/gate');
const { createSupplierHttp } = require('../server/business/suppliers/http');
const { AIRLINES } = require('../server/business/suppliers/airlines');
const { API: DUFFEL_API } = require('../server/business/suppliers/duffel');
const { API: LITE_API, BOOK_API } = require('../server/business/suppliers/liteapi');
const { withCompany } = require('../server/business/scope');
const { BUSINESS_CITIES } = require('../server/business/demo/hotels-data');
const { addDays, today } = require('../server/lib/dates');
const { fakeFetch, testKeys, airportLookups } = require('./supplier-fetch');

const ORG = 'org_supplierContract01';
const DUFFEL_HOST = 'api.duffel.com';
const LITE_HOSTS = Object.freeze(['api.liteapi.travel', 'book.liteapi.travel']);
const DUFFEL_PER_MINUTE = 10;
const LITE_SPACING_MS = 1000;
const MAX_FRESH_PREBOOKS = 3;
const REPORT = 'supplier-sandbox-report.json';
const quiet = Object.freeze({ info() {}, log() {}, warn() {}, error() {} });

/**
 * Whether the sandbox run may start. Never throws; never returns a key in a reason.
 * @param {Record<string, string|undefined>} env
 * @returns {{ run: true, token: string, apiKey: string } | { run: false, reason: string, refused?: string }}
 */
function guard(env) {
  if (env.SUPPLIER_SANDBOX !== '1') return { run: false, reason: 'SUPPLIER_SANDBOX is not 1: the sandbox contract test is opt-in' };
  const token = typeof env.DUFFEL_TEST_TOKEN === 'string' ? env.DUFFEL_TEST_TOKEN.trim() : '';
  const apiKey = typeof env.LITEAPI_SANDBOX_KEY === 'string' ? env.LITEAPI_SANDBOX_KEY.trim() : '';
  if (!token || !apiKey) return { run: false, reason: 'DUFFEL_TEST_TOKEN and LITEAPI_SANDBOX_KEY are not both set' };
  const printable = /^[\x21-\x7e]{1,512}$/;
  if (!printable.test(token) || !token.startsWith('duffel_test_') || token.length <= 'duffel_test_'.length) {
    return { run: false, reason: 'refused', refused: 'DUFFEL_TEST_TOKEN is not a Duffel test token (duffel_test_): this test never runs against live.' };
  }
  if (!printable.test(apiKey) || !apiKey.startsWith('sand_') || apiKey.length <= 'sand_'.length) {
    return { run: false, reason: 'refused', refused: 'LITEAPI_SANDBOX_KEY is not a LiteAPI sandbox key (sand_): this test never runs against live.' };
  }
  return { run: true, token, apiKey };
}

const median = list => {
  const a = list.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const CURRENCY_RE = /^[A-Z]{3}$/;

/** What the raw answers show (counts only), gathered beside the adapters without changing what they read. */
function newObservations() {
  return {
    duffel: {
      answers: 0, liveModeNotFalse: 0, offers: 0, ownersNotZZ: 0, ownersNullIata: 0, currencies: {}, nullTaxAmount: 0,
      brandNamed: 0, brandNull: 0, offerRefundNull: 0, offerChangeNull: 0, sliceChangeGiven: 0, slices: 0,
      segments: 0, segmentDurationNull: 0, segmentsWithStops: 0, expiresMinMinutes: null, expiresMaxMinutes: null,
      largestBodyBytes: 0, rateLimitLimit: null, rateLimitRemainingMin: null, resetSeen: 0, resetHttpDate: 0, resetNumeric: 0,
    },
    liteapi: {
      answers: 0, noAvailability: 0, sandboxTrue: 0, sandboxNotTrue: 0, hotels: 0, rates: 0, starsUnrated: 0, starsWhole: 0,
      starsHalf: 0, nonUsdTotals: 0, excludedCurrencies: {}, taxesNull: 0, refundable: 0, refundableWithDeadline: 0,
      nonRefundable: 0, largestBodyBytes: 0, prebookCalls: 0, prebookPriceDifferencePercent: [], prebookCancellationChanged: 0,
    },
    // Kept in memory for the reused-offerId case; never reported.
    secret: { oldOfferId: null },
    sends: { duffel: [], liteapi: [] },
  };
}

function observeDuffel(obs, url, res, text, at) {
  const d = obs.duffel;
  d.largestBodyBytes = Math.max(d.largestBodyBytes, Buffer.byteLength(text, 'utf8'));
  const limit = Number(res.headers.get('ratelimit-limit'));
  if (Number.isFinite(limit) && res.headers.get('ratelimit-limit') !== null) d.rateLimitLimit = limit;
  const remaining = Number(res.headers.get('ratelimit-remaining'));
  if (Number.isFinite(remaining) && res.headers.get('ratelimit-remaining') !== null) d.rateLimitRemainingMin = d.rateLimitRemainingMin === null ? remaining : Math.min(d.rateLimitRemainingMin, remaining);
  const reset = res.headers.get('ratelimit-reset');
  if (reset !== null) {
    d.resetSeen += 1;
    if (/^\s*\d+\s*$/.test(reset)) d.resetNumeric += 1;
    else if (Number.isFinite(Date.parse(reset))) d.resetHttpDate += 1;
  }
  const json = parse(text);
  const data = json && json.data;
  if (!data || typeof data !== 'object') return;
  const pathname = new URL(url).pathname;
  if (pathname.startsWith('/air/airlines')) return;
  d.answers += 1;
  if (data.live_mode !== false) d.liveModeNotFalse += 1;
  const offers = pathname === '/air/offer_requests' ? (Array.isArray(data.offers) ? data.offers : []) : [data];
  for (const o of offers) {
    if (!o || typeof o !== 'object') continue;
    d.offers += 1;
    if (o.live_mode !== false) d.liveModeNotFalse += 1;
    const iata = o.owner && o.owner.iata_code;
    if (iata === null || iata === undefined) d.ownersNullIata += 1;
    else if (iata !== 'ZZ') d.ownersNotZZ += 1;
    if (typeof o.total_currency === 'string' && CURRENCY_RE.test(o.total_currency)) bump(d.currencies, o.total_currency);
    if (o.tax_amount === null) d.nullTaxAmount += 1;
    const expires = Date.parse(o.expires_at);
    if (Number.isFinite(expires)) {
      const minutes = Math.round((expires - at) / 60000);
      d.expiresMinMinutes = d.expiresMinMinutes === null ? minutes : Math.min(d.expiresMinMinutes, minutes);
      d.expiresMaxMinutes = d.expiresMaxMinutes === null ? minutes : Math.max(d.expiresMaxMinutes, minutes);
    }
    const c = o.conditions || {};
    if (c.refund_before_departure === null || c.refund_before_departure === undefined) d.offerRefundNull += 1;
    if (c.change_before_departure === null || c.change_before_departure === undefined) d.offerChangeNull += 1;
    for (const s of Array.isArray(o.slices) ? o.slices : []) {
      d.slices += 1;
      if (typeof s.fare_brand_name === 'string' && s.fare_brand_name.trim()) d.brandNamed += 1; else d.brandNull += 1;
      if (s.conditions && s.conditions.change_before_departure) d.sliceChangeGiven += 1;
      for (const seg of Array.isArray(s.segments) ? s.segments : []) {
        d.segments += 1;
        if (seg.duration === null || seg.duration === undefined) d.segmentDurationNull += 1;
        if (Array.isArray(seg.stops) && seg.stops.length) d.segmentsWithStops += 1;
      }
    }
  }
}

function observeLite(obs, url, res, text) {
  const l = obs.liteapi;
  l.largestBodyBytes = Math.max(l.largestBodyBytes, Buffer.byteLength(text, 'utf8'));
  const json = parse(text);
  if (!json || typeof json !== 'object') return;
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('/rates/prebook')) {
    const data = json.data;
    if (data && typeof data === 'object') {
      if (Number.isFinite(data.priceDifferencePercent)) l.prebookPriceDifferencePercent.push(data.priceDifferencePercent);
      if (data.cancellationChanged === true) l.prebookCancellationChanged += 1;
    }
    return;
  }
  if (!pathname.endsWith('/hotels/rates')) return;
  l.answers += 1;
  if (!Array.isArray(json.data)) { l.noAvailability += 1; return; }
  if (json.sandbox === true) l.sandboxTrue += 1; else l.sandboxNotTrue += 1;
  l.hotels += json.data.length;
  for (const h of Array.isArray(json.hotels) ? json.hotels : []) {
    const s = h && h.stars;
    if (!Number.isFinite(s) || s <= 0) l.starsUnrated += 1;
    else if (Number.isInteger(s)) l.starsWhole += 1;
    else l.starsHalf += 1;
  }
  for (const h of json.data) {
    for (const rt of Array.isArray(h && h.roomTypes) ? h.roomTypes : []) {
      if (!obs.secret.oldOfferId && typeof rt.offerId === 'string') obs.secret.oldOfferId = rt.offerId;
      for (const r of Array.isArray(rt.rates) ? rt.rates : []) {
        l.rates += 1;
        const rr = r.retailRate || {};
        const total = Array.isArray(rr.total) ? rr.total[0] : null;
        if (!total || total.currency !== 'USD') l.nonUsdTotals += 1;
        if (rr.taxesAndFees === null || rr.taxesAndFees === undefined) l.taxesNull += 1;
        for (const tf of Array.isArray(rr.taxesAndFees) ? rr.taxesAndFees : []) {
          if (tf && tf.included === false && typeof tf.currency === 'string' && CURRENCY_RE.test(tf.currency)) bump(l.excludedCurrencies, tf.currency);
        }
        const cp = r.cancellationPolicies || {};
        if (cp.refundableTag === 'RFN') {
          l.refundable += 1;
          if (Array.isArray(cp.cancelPolicyInfos) && cp.cancelPolicyInfos.length) l.refundableWithDeadline += 1;
        } else l.nonRefundable += 1;
      }
    }
  }
}

/**
 * The fetch the adapters get: LiteAPI calls at least 1 s apart, every send recorded, and each answer observed on
 * a clone (the adapter reads the original exactly as it would).
 */
function observedFetch(baseFetch, obs, { sleep, clock }) {
  let lastLite = -Infinity;
  return async (url, init) => {
    const host = new URL(String(url)).host;
    if (LITE_HOSTS.includes(host)) {
      const wait = lastLite + LITE_SPACING_MS - clock();
      if (wait > 0) await sleep(wait);
      lastLite = clock();
      obs.sends.liteapi.push(lastLite);
    } else if (host === DUFFEL_HOST) obs.sends.duffel.push(clock());
    if (LITE_HOSTS.includes(host) && new URL(String(url)).pathname.endsWith('/rates/prebook')) obs.liteapi.prebookCalls += 1;
    const res = await baseFetch(url, init);
    try {
      const text = await res.clone().text();
      if (host === DUFFEL_HOST) observeDuffel(obs, String(url), res, text, clock());
      else if (LITE_HOSTS.includes(host)) observeLite(obs, String(url), res, text);
    } catch { /* the adapter sees the same failure on the original */ }
    return res;
  };
}

/**
 * Run every case; gather counts. Never asserts (the test does), never throws for a supplier answer.
 * @param {{ token: string, apiKey: string, fetch: Function, sleep: (ms: number) => Promise<void>, clock: () => number,
 *   timing?: { sleep?: Function, mono?: Function } }} opts timing: the dry run's instant waits for the gate
 */
async function collect({ token, apiKey, fetch: baseFetch, sleep, clock, timing = {} }) {
  const started = clock();
  const now = () => new Date(clock());
  const obs = newObservations();
  const fetch = observedFetch(baseFetch, obs, { sleep, clock });
  const { airport, cityZone } = airportLookups();
  const env = {
    APP_ENV: 'development', ENABLE_BUSINESS: 'true', BUSINESS_FLIGHT_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: token,
    BUSINESS_HOTEL_SUPPLIER: 'liteapi', LITEAPI_API_KEY: apiKey, BUSINESS_ALLOW_SUPPLIER_TEST: 'true',
    BUSINESS_SUPPLIER_COMPANY_CALLS_PER_HOUR: '1000',
  };
  const build = extra => {
    const cfg = loadConfig({ ...env, ...extra }).business.suppliers;
    const s = createBusinessSuppliers(cfg, { fetch, now, log: quiet, airport, cityZone, ...timing });
    if (!s.flights) throw new Error(`[contract] the suppliers did not start: ${s.problem}`);
    return s;
  };
  const us = build({});
  const eg = build({ BUSINESS_GUEST_NATIONALITY: 'EG' });
  const gate = new Gate({ now, log: quiet, companyPerHour: 1000, companyPerMinute: 1000, ...timing });
  const http = createSupplierHttp({ fetch, gate, now, log: quiet, ...timing });
  const day = today(now());
  const ahead = n => addDays(day, n);
  const codeOf = e => (e && typeof e.code === 'string' && /^[a-z_]{1,40}$/.test(e.code) ? e.code : 'error');

  // Duffel: at most DUFFEL_PER_MINUTE sends in any minute, counting the k an operation may send.
  const duffelSlot = async k => {
    for (;;) {
      const t = clock();
      const recent = obs.sends.duffel.filter(x => x > t - 60000);
      if (recent.length + k <= DUFFEL_PER_MINUTE) return;
      await sleep(recent[0] + 60000 - t + 50);
    }
  };
  const fq = (from, to, days) => ({ from, to, departDate: ahead(days), passengers: 1, cabin: 'economy' });
  const searchFlights = async (pq, k = 1) => {
    await duffelSlot(k);
    return us.flights.searchDetailed(pq);
  };

  const duffelCases = async () => {
    const routes = {};
    for (const [from, to] of [['CAI', 'LHR'], ['DXB', 'LHR'], ['CAI', 'DXB']]) {
      for (const days of [30, 60]) {
        const label = `${from}_${to}_${days}`;
        try {
          const r = await searchFlights(fq(from, to, days));
          routes[label] = {
            offers: r.offers.length, options: r.offers.reduce((n, o) => n + o.options.length, 0), truncated: r.truncated,
            skipped: Object.values(r.skipped).reduce((n, x) => n + x, 0), timeMismatch: r.skipped.timeMismatch || 0,
            ownersNotZZ: r.offers.filter(o => o.details.segments[0] && !/^ZZ\d/.test(o.details.segments[0].flightNumber)).length,
          };
        } catch (e) { routes[label] = { failed: codeOf(e) }; }
      }
    }
    const scenarios = {};
    const run = async (name, fn) => { try { scenarios[name] = await fn(); } catch (e) { scenarios[name] = { failed: codeOf(e) }; } };
    await run('pvd_rai_none', async () => ({ offers: (await searchFlights(fq('PVD', 'RAI', 30))).offers.length }));
    await run('lhr_stn_price_change', async () => {
      const pq = fq('LHR', 'STN', 30);
      const { offers } = await searchFlights(pq);
      const o = offers[0];
      if (!o) return { offers: 0 };
      const opt = o.options[0];
      await duffelSlot(4);
      const fresh = await us.flights.getOffer(o.id, { ...pq, check: 'confirm' }, { optionId: opt.id });
      const now2 = fresh && fresh.options.find(x => x.id === opt.id);
      return { offers: offers.length, gone: !now2, changed: Boolean(now2) && now2.price.amount !== opt.price.amount };
    });
    await run('lgw_lhr_gone', async () => {
      const pq = fq('LGW', 'LHR', 30);
      const { offers } = await searchFlights(pq);
      const o = offers[0];
      if (!o) return { offers: 0 };
      await duffelSlot(4);
      const fresh = await us.flights.getOffer(o.id, { ...pq, check: 'confirm' }, { optionId: o.options[0].id });
      return { offers: offers.length, gone: fresh === null };
    });
    await run('stn_lhr_timeout', async () => {
      await duffelSlot(2);
      const t0 = clock(); // after the pacing wait: only the supplier's time counts
      try {
        const r = await us.flights.searchDetailed(fq('STN', 'LHR', 30));
        return { unavailable: false, offers: r.offers.length, ms: clock() - t0 };
      } catch (e) {
        return { unavailable: codeOf(e) === 'supplier_unavailable', ms: clock() - t0 };
      }
    });
    await run('lhr_dxb_connection', async () => {
      const { offers } = await searchFlights(fq('LHR', 'DXB', 30));
      return { offers: offers.length, withConnection: offers.filter(o => o.details.segments.length > 1).length };
    });
    await run('bts_mru_no_bags', async () => {
      const { offers } = await searchFlights(fq('BTS', 'MRU', 30));
      const options = offers.flatMap(o => o.options);
      return { offers: offers.length, options: options.length, withCheckedBags: options.filter(x => x.fare && x.fare.checkedBags > 0).length };
    });
    await run('dxb_ams_stop_in_segment', async () => {
      const { offers } = await searchFlights(fq('DXB', 'AMS', 30));
      return { offers: offers.length, oneSegmentOneStop: offers.filter(o => o.details.segments.length === 1 && o.details.stops === 1).length };
    });

    // GET /air/airlines against airlines.js (codes and names).
    const airlines = { pages: 0, failed: false, ours: AIRLINES.length, found: 0, namesDiffer: 0 };
    const names = new Map();
    let after = null;
    do {
      await duffelSlot(1);
      const url = `${DUFFEL_API}/air/airlines?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      let res;
      try {
        res = await http.call({ supplier: 'duffel', op: 'airlines', vertical: 'flights', url, timeoutMs: 15000,
          headers: { Authorization: `Bearer ${token}`, 'Duffel-Version': 'v2', Accept: 'application/json', 'Accept-Encoding': 'gzip' } });
      } catch { airlines.failed = true; break; }
      if (res.status !== 200 || !res.json || !Array.isArray(res.json.data)) { airlines.failed = true; break; }
      for (const a of res.json.data) if (a && typeof a.iata_code === 'string' && typeof a.name === 'string') names.set(a.iata_code, a.name);
      after = res.json.meta && typeof res.json.meta.after === 'string' && res.json.meta.after ? res.json.meta.after : null;
      airlines.pages += 1;
    } while (after && airlines.pages < 8 && AIRLINES.some(a => !names.has(a.code)));
    for (const a of AIRLINES) {
      if (!names.has(a.code)) continue;
      airlines.found += 1;
      if (names.get(a.code).trim().toLowerCase() !== a.name.toLowerCase()) airlines.namesDiffer += 1;
    }
    airlines.missing = airlines.ours - airlines.found;
    return { routes, scenarios, airlines };
  };

  const liteCases = async () => {
    const cities = [...BUSINESS_CITIES.map(c => [c.city, c.country]), ['New Alamein', 'Egypt']];
    const stay = { checkIn: ahead(30), checkOut: ahead(31), guests: 1 };
    const hq = (city, country) => ({ where: city, country, ...stay });
    const perCity = {};
    for (const [city, country] of cities) {
      const label = city.toLowerCase().replace(/[^a-z]+/g, '_');
      try {
        const r = await us.hotels.searchDetailed(hq(city, country));
        perCity[label] = { hotels: r.offers.length, rooms: r.offers.reduce((n, o) => n + o.options.length, 0), skipped: Object.values(r.skipped).reduce((n, x) => n + x, 0) };
      } catch (e) { perCity[label] = { failed: codeOf(e) }; }
    }

    // Cairo sorted by price: are limit 40's hotels the cheapest 40 of limit 200?
    const ratesBody = limit => JSON.stringify({
      cityName: 'Cairo', countryCode: 'EG', checkin: stay.checkIn, checkout: stay.checkOut, occupancies: [{ adults: 1 }],
      currency: 'USD', guestNationality: 'US', timeout: 8, limit, sort: [{ field: 'price', direction: 'ascending' }],
      maxRatesPerHotel: 3, includeHotelData: true, roomMapping: true,
    });
    const liteHeaders = { 'X-API-Key': apiKey, Accept: 'application/json', 'Accept-Encoding': 'gzip', 'Content-Type': 'application/json' };
    const cheapest = json => {
      const out = new Map();
      for (const h of json && Array.isArray(json.data) ? json.data : []) {
        let best = Infinity;
        for (const rt of Array.isArray(h.roomTypes) ? h.roomTypes : []) {
          for (const r of Array.isArray(rt.rates) ? rt.rates : []) {
            const t = r.retailRate && Array.isArray(r.retailRate.total) && r.retailRate.total[0];
            if (t && Number.isFinite(t.amount)) best = Math.min(best, Math.round(t.amount * 100));
          }
        }
        if (typeof h.hotelId === 'string' && Number.isFinite(best)) out.set(h.hotelId, best);
      }
      return out;
    };
    const sortCheck = {};
    try {
      const call = limit => http.call({ supplier: 'liteapi', op: 'rates', vertical: 'hotels', method: 'POST', url: `${LITE_API}/hotels/rates`, headers: liteHeaders, body: ratesBody(limit), timeoutMs: 12000 });
      const forty = cheapest((await call(40)).json);
      const all = cheapest((await call(200)).json);
      const lowest = [...all.entries()].sort((x, y) => x[1] - y[1]).slice(0, forty.size).map(([id]) => id);
      const overlap = lowest.filter(id => forty.has(id)).length;
      Object.assign(sortCheck, {
        hotels40: forty.size, hotels200: all.size, overlap, fortyAreTheCheapest: forty.size > 0 && overlap === forty.size,
        medianCents40: median([...forty.values()]), medianCents200: median([...all.values()]),
      });
    } catch (e) { sortCheck.failed = codeOf(e); }

    // Nationality: Cairo as a US and as an Egyptian guest.
    const nationality = {};
    for (const [label, s] of [['us', us], ['eg', eg]]) {
      try {
        const r = await s.hotels.searchDetailed(hq('Cairo', 'Egypt'));
        const totals = [];
        for (const o of r.offers) {
          for (const opt of o.options) totals.push(opt.price.amount);
        }
        nationality[label] = { hotels: r.offers.length, rooms: totals.length, medianNightCents: median(totals) };
      } catch (e) { nationality[label] = { failed: codeOf(e) }; }
    }

    // Prebooks: the cheapest refundable room in Cairo, Dubai and London, at most MAX_FRESH_PREBOOKS in all.
    const prebooks = {};
    for (const [city, country] of [['Cairo', 'Egypt'], ['Dubai', 'United Arab Emirates'], ['London', 'United Kingdom']]) {
      const label = city.toLowerCase();
      try {
        if (obs.liteapi.prebookCalls >= MAX_FRESH_PREBOOKS) { prebooks[label] = { skipped: true }; continue; }
        const pq = hq(city, country);
        const { offers } = await us.hotels.searchDetailed(pq);
        let best = null;
        for (const offer of offers) {
          for (const option of offer.options) {
            if (!option.available) continue;
            const q = await us.hotels.quote({ offerId: offer.id, optionId: option.id, query: pq, offer });
            if (q.cancellation.type === 'non_refundable') continue;
            const total = q.lines.reduce((n, l) => n + l.amount, 0);
            if (!best || total < best.total) best = { offer, option, total, type: q.cancellation.type };
          }
        }
        if (!best) { prebooks[label] = { refundableRooms: 0 }; continue; }
        const fpq = { ...pq, check: 'final' };
        const fresh = await us.hotels.getOffer(best.offer.id, fpq);
        if (!fresh) { prebooks[label] = { gone: true }; continue; }
        const q2 = await us.hotels.quote({ offerId: fresh.id, optionId: best.option.id, query: fpq, offer: fresh });
        const total2 = q2.lines.reduce((n, l) => n + l.amount, 0);
        prebooks[label] = { prebooked: true, priceChanged: total2 !== best.total, deltaCents: total2 - best.total, cancellationChanged: q2.cancellation.type !== best.type };
      } catch (e) { prebooks[label] = { failed: codeOf(e) }; }
    }

    // An old offerId (the first rates answer's, minutes ago, maybe prebooked since): refused with 4040 or 2001?
    const reused = {};
    if (obs.secret.oldOfferId) {
      try {
        const res = await http.call({ supplier: 'liteapi', op: 'prebook', vertical: 'hotels', method: 'POST', url: `${BOOK_API}/rates/prebook?timeout=20`, headers: liteHeaders, body: JSON.stringify({ offerId: obs.secret.oldOfferId, usePaymentSdk: false }), timeoutMs: 25000 });
        const code = res.json && res.json.error && Number.isSafeInteger(res.json.error.code) ? res.json.error.code : null;
        Object.assign(reused, { httpStatus: res.status, errorCode: code, refused: code === 4040 || code === 2001 });
      } catch (e) { reused.failed = codeOf(e); }
    } else reused.noOfferSeen = true;
    return { perCity, sortCheck, nationality, prebooks, reused };
  };

  const [duffel, liteapi] = await withCompany(ORG, () => Promise.all([duffelCases(), liteCases()]));
  const o = obs;
  const { prebookPriceDifferencePercent: diffs, ...liteRaw } = o.liteapi;
  const report = {
    durationSeconds: Math.round((clock() - started) / 1000),
    duffel: {
      ...duffel,
      liveModeAllFalse: o.duffel.answers > 0 && o.duffel.liveModeNotFalse === 0,
      raw: { ...o.duffel },
      calls: o.sends.duffel.length,
      latchedOff: us.state.latched.duffel,
    },
    liteapi: {
      ...liteapi,
      sandboxAllTrue: o.liteapi.answers - o.liteapi.noAvailability > 0 && o.liteapi.sandboxNotTrue === 0,
      raw: { ...liteRaw, priceDifferencePercentMedian: median(diffs), priceDifferencePercentMax: diffs.length ? Math.max(...diffs) : null },
      calls: o.sends.liteapi.length,
      latchedOff: us.state.latched.liteapi || eg.state.latched.liteapi,
    },
  };
  return { report: JSON.parse(JSON.stringify(report)), trace: { duffelSends: [...o.sends.duffel], liteSends: [...o.sends.liteapi], prebookCalls: o.liteapi.prebookCalls } };
}

/** Every value in the report is a count, a boolean, null, a median, or a short lower-case code: nothing else. */
function onlyCounts(value, where = 'report') {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return [];
  if (typeof value === 'string') return /^[a-z_]{1,40}$/.test(value) ? [] : [`${where}: a string`];
  if (Array.isArray(value)) return [`${where}: a list`];
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => (/^[A-Za-z0-9_]{1,60}$/.test(k) ? onlyCounts(v, `${where}.${k}`) : [`${where}: key ${k.slice(0, 8)}`]));
  }
  return [`${where}: ${typeof value}`];
}

const plan = guard(process.env);

test('guard: runs only with SUPPLIER_SANDBOX=1 and both keys, and refuses any key that is not a test key', () => {
  const k = testKeys();
  assert.deepEqual(guard({}).run, false);
  assert.match(guard({}).reason, /opt-in/);
  assert.equal(guard({ SUPPLIER_SANDBOX: '1', DUFFEL_TEST_TOKEN: k.token }).run, false);
  assert.equal(guard({ SUPPLIER_SANDBOX: 'true', DUFFEL_TEST_TOKEN: k.token, LITEAPI_SANDBOX_KEY: k.apiKey }).run, false);
  const ok = guard({ SUPPLIER_SANDBOX: '1', DUFFEL_TEST_TOKEN: k.token, LITEAPI_SANDBOX_KEY: k.apiKey });
  assert.equal(ok.run, true);
  for (const [token, apiKey] of [
    [`duffel_live_${'x'.repeat(30)}`, k.apiKey], [`duffel_${'x'.repeat(30)}`, k.apiKey], ['duffel_test_', k.apiKey],
    [k.token, `prod_${'0'.repeat(30)}`], [k.token, 'sand_'], [k.token, `${k.apiKey} x`], [` ${'x'.repeat(40)}`, k.apiKey],
  ]) {
    const g = guard({ SUPPLIER_SANDBOX: '1', DUFFEL_TEST_TOKEN: token, LITEAPI_SANDBOX_KEY: apiKey });
    assert.equal(g.run, false);
    assert.ok(g.refused, 'refused, not skipped');
    for (const v of [token, apiKey].filter(x => x.length > 'duffel_test_'.length)) assert.ok(!g.refused.includes(v.trim()), 'never quotes a key');
  }
});

test('dry run on the fixtures: the harness paces its calls and reports counts and booleans only', async () => {
  const keys = testKeys();
  // The CAI-LHR fixture moved to the route and date each offer request asks for, so every case has offers.
  const asAsked = (body, call) => {
    const want = call.body.data.slices[0];
    const shift = (Date.parse(want.departure_date) - Date.parse('2026-11-12')) / 86400000;
    const moved = JSON.parse(JSON.stringify(body).replace(/2026-11-1([2-4])/g, (m, d) => new Date(Date.parse(`2026-11-1${d}`) + shift * 86400000).toISOString().slice(0, 10)));
    for (const o of moved.data.offers) {
      const segs = o.slices[0].segments;
      segs[0].origin = { ...segs[0].origin, iata_code: want.origin };
      segs[segs.length - 1].destination = { ...segs[segs.length - 1].destination, iata_code: want.destination };
    }
    return moved;
  };
  // A prebook answers for the hotel of the offerId it was asked about.
  const forHotel = (body, call) => { const m = /lp\d+/.exec(call.body.offerId); if (m) body.data.hotelId = m[0]; return body; };
  const ff = fakeFetch([
    { method: 'POST', url: `${DUFFEL_API}/air/offer_requests`, reply: { fixture: 'duffel/offer-request.cai-lhr.json', transform: asAsked } },
    { method: 'GET', url: /^https:\/\/api\.duffel\.com\/air\/offers\//, reply: 'duffel/offer.get.json' },
    { method: 'GET', url: `${DUFFEL_API}/air/airlines`, reply: 'duffel/airlines.page1.json' },
    { method: 'POST', url: `${LITE_API}/hotels/rates`, reply: 'liteapi/rates.cairo.json' },
    { method: 'POST', url: /^https:\/\/book\.liteapi\.travel\/v3\.0\/rates\/prebook\?timeout=\d+$/, reply: c => (c.body.offerId === 'offer_PLACEHOLDER_lp1001_std' ? 'liteapi/prebook.4040-outdated.json' : { fixture: 'liteapi/prebook.json', transform: forHotel }) },
  ], keys);
  let t = Date.parse('2026-10-09T09:00:00.000Z');
  const clock = () => t;
  const sleep = async ms => { t += Math.max(0, ms); };
  const { report, trace } = await collect({ token: keys.token, apiKey: keys.apiKey, fetch: ff.fetch, sleep, clock, timing: { sleep, mono: clock } });
  ff.assertClean();
  assert.deepEqual(onlyCounts(report), []);
  const text = JSON.stringify(report);
  for (const s of [keys.token, keys.apiKey, 'offer_PLACEHOLDER', 'off_0000', 'lp100', 'pb_', 'rate_PLACEHOLDER', 'Nile', 'Cairo']) assert.ok(!text.includes(s), s);
  // Pacing: never more than 10 Duffel sends in a minute; LiteAPI sends at least a second apart.
  for (const x of trace.duffelSends) assert.ok(trace.duffelSends.filter(y => y >= x && y < x + 60000).length <= DUFFEL_PER_MINUTE);
  for (let i = 1; i < trace.liteSends.length; i += 1) assert.ok(trace.liteSends[i] - trace.liteSends[i - 1] >= LITE_SPACING_MS);
  assert.ok(trace.prebookCalls <= MAX_FRESH_PREBOOKS + 1, `prebooks: ${trace.prebookCalls}`);
  // The fixtures give the harness something to count.
  assert.equal(report.duffel.liveModeAllFalse, true);
  assert.equal(report.liteapi.sandboxAllTrue, true);
  assert.ok(report.duffel.routes.CAI_LHR_30.offers > 0 && report.duffel.scenarios.lhr_dxb_connection.withConnection > 0);
  assert.ok(report.duffel.scenarios.dxb_ams_stop_in_segment.oneSegmentOneStop > 0, 'the in-segment stop is counted');
  assert.ok(Object.values(report.liteapi.prebooks).some(p => p.prebooked === true), 'a prebook ran');
  assert.equal(report.duffel.airlines.ours, AIRLINES.length);
  assert.equal(report.liteapi.reused.refused, true, 'the old offerId case reads the error code');
  assert.ok(report.liteapi.raw.excludedCurrencies.AED > 0, 'the AED fee is counted');
  assert.ok(report.duffel.raw.resetSeen > 0 && report.duffel.raw.resetHttpDate === report.duffel.raw.resetSeen);
});

test('the keys are test keys (the run refuses anything else)', { skip: plan.refused ? false : plan.reason }, () => {
  assert.fail(plan.refused);
});

test('contract: the Duffel and LiteAPI sandboxes answer as the adapters expect', { skip: plan.run ? false : plan.reason, timeout: 12 * 60 * 1000 }, async () => {
  const sleep = ms => new Promise(r => { setTimeout(r, ms); });
  const { report } = await collect({ token: plan.token, apiKey: plan.apiKey, fetch: (url, init) => globalThis.fetch(url, init), sleep, clock: () => Date.now() });
  assert.deepEqual(onlyCounts(report), [], 'the report holds counts only');
  const text = JSON.stringify(report, null, 2);
  assert.ok(!text.includes(plan.token) && !text.includes(plan.apiKey));
  fs.writeFileSync(path.join(process.cwd(), REPORT), `${text}\n`);
  console.log(`[supplier-sandbox] ${text}`);

  const d = report.duffel, l = report.liteapi, s = d.scenarios;
  assert.equal(d.latchedOff, false, 'Duffel answered in test mode');
  assert.equal(d.liveModeAllFalse, true, 'live_mode false on every answer');
  assert.ok(Object.values(d.routes).some(r => r.offers > 0), 'our routes have offers');
  assert.equal(s.pvd_rai_none.offers, 0, 'PVD-RAI: no offers');
  assert.equal(s.lhr_stn_price_change.changed, true, 'LHR-STN: the GET shows a new price');
  assert.equal(s.lgw_lhr_gone.gone, true, 'LGW-LHR: the offer is gone');
  assert.equal(s.stn_lhr_timeout.unavailable, true, 'STN-LHR: "not available right now"');
  assert.ok(s.stn_lhr_timeout.ms <= 16000, `STN-LHR inside 15 s (${s.stn_lhr_timeout.ms} ms)`);
  assert.ok(s.lhr_dxb_connection.withConnection > 0, 'LHR-DXB: a connection');
  assert.ok(s.bts_mru_no_bags.options > 0 && s.bts_mru_no_bags.withCheckedBags === 0, 'BTS-MRU: no bags');
  assert.ok(s.dxb_ams_stop_in_segment.oneSegmentOneStop > 0, 'DXB-AMS: stops === 1 from a stop inside the segment');
  assert.ok(d.raw.resetSeen === 0 || d.raw.resetHttpDate === d.raw.resetSeen, 'ratelimit-reset is an HTTP-date');
  assert.equal(d.airlines.failed, false);
  assert.equal(d.airlines.missing, 0, 'every airlines.js code is in GET /air/airlines');
  assert.equal(l.latchedOff, false, 'LiteAPI answered in sandbox');
  assert.equal(l.sandboxAllTrue, true, 'sandbox true on every rates answer');
  assert.equal(l.raw.nonUsdTotals, 0, 'every total in USD');
  assert.ok(l.raw.prebookCalls <= MAX_FRESH_PREBOOKS + 1);
  assert.equal(l.reused.refused, true, 'an old offerId is refused with 4040 or 2001');
});

module.exports = { guard, collect, onlyCounts };
