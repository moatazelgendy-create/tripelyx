// DuffelFlights: the FlightProvider contract (providers/contracts.js) over Duffel's API v2, test mode only in
// round 1 (real-suppliers design §3.1, §3.2, §5.2). Plain fetch through http.js, never the SDK (the build adds
// no dependencies; D-SDK's guidance holds: server side only, the token from the environment).
//
// Search: one offer request per leg, POST /air/offer_requests?return_offers=true&supplier_timeout=10000 (D-ORQ)
//   with one adult, the cabin and max_connections 1 (which caps connections, not stops inside a segment).
//   Every offer is normalised and filtered (counted in `skipped`): an owner, marketing or operating carrier
//   without an IATA code (unknownCarrier), segments in different cabins (mixedCabin), first class (firstCabin),
//   local times that disagree with the segment's duration by more than a minute (timeMismatch; skipped when
//   Duffel gives no duration). Offers in another currency are passed through (the composer drops and counts
//   them). Then the cheapest 60 options of the whole answer are kept (US dollars first, ties by option key; `truncated` when
//   more existed) and grouped by itinerary: one provider Offer per itinerary (same marketing flight numbers,
//   same first local departure, same cabin), one option per Duffel offer (fare), cheapest first. A second
//   fare with the same option id in one itinerary is dropped (duplicateOption; the cheaper stays).
// Mode: the offer request and every offer carry `live_mode` (D-ORQ, D-OFF); it must be false in sandbox (a
//   missing field counts as a mismatch). A mismatch throws the answer away, fails the call with 503
//   supplier_unavailable, logs `mode_mismatch` once (no body) and latches flights off for the process.
// Row fields (§3.2): ids from ids.js (flt_t.<flight numbers>_<first local departure>_<cabin>; Duffel's off_…
//   ids never leave this module); details.owner = the airline selling the fare (ZZ is "Test airline" in
//   sandbox; other owners keep their names, still test data); segment carrier = the operating carrier;
//   flightNumber = marketing carrier + number; local times as Duffel gives them (airport-local, D-ORDT);
//   stops = connections + stops inside segments, via = their airports in travel order; the fare's terms are
//   source.TERMS.fare(...) from the slice's conditions first, then the offer's; bags = the allowance that holds
//   on every segment; kilograms are not in Duffel's schema, so cabinKg and checkedKg are 0 ("not stated");
//   lines "Fare" + "Taxes and airline charges" only when they add up exactly, else one "Fare including taxes".
// Price checks (§5.1, §5.2), by pq.check:
//   auto    the cached search (fresh), else as confirm;
//   peek    the cached search, or ONE GET /air/offers/{id} of the selected fare when its Duffel offer has more
//           than 60 s left; never a search. Anything else (or a non-200 GET) → 503 live_check_skipped;
//   confirm, final  GET the selected fare's Duffel offer; when it is unknown or has 60 s or less left, re-run
//           the offer request first (stored in the cache, so the next search is a hit). GET answering
//           offer_expired, offer_no_longer_available or 404 → re-search once, then GET again; still missing
//           → null (unavailable). A changed total_amount in the GET answer is simply the new price (D-OFF
//           lists no price_changed for GET; D-TYI's LHR→STN scenario shows it there).
//   Every GET answer (peek, confirm, final) also replaces that fare in the cached search, so a later auto or
//   peek never serves an older price than a check already saw; every GET answer's live_mode is checked too.
// Retries (§4.2, D-ERR): an offer request once, only after a connection error before any answer or a 503;
//   a GET twice, after a connection error, 503, 504 or a short 429. Never 500 or 502 ("You should not retry
//   this request"), never a timeout of the offer request, never an offer request whose answer had started.
//   The composer passes the selected option as getOffer's third argument ({ optionId }); quote() reads the
//   offer it was handed (or the one getOffer just answered), never the network.
// book() and cancel() answer 409 booking_not_open: nothing calls them in round 1.
const crypto = require('node:crypto');
const tz = require('../tz');
const { AppError } = require('../../lib/errors');
const { TERMS, sourceOf, offerPrefix, supplierError } = require('../source');
const { parseMinor } = require('./money');
const ids = require('./ids');
const { SupplierCache, MB } = require('./cache');
const { TEST_AIRLINE } = require('./airlines');
const { currentCompany } = require('../scope');

const API = 'https://api.duffel.com';
/** Our client timeouts (§4.1), per operation. */
const TIMEOUTS = Object.freeze({ offerRequest: 15000, offerGet: 10000, airlines: 15000 });
/** Duffel's own limit for each airline search, milliseconds (D-ORQ). */
const SUPPLIER_TIMEOUT_MS = 10000;
/** The options one leg keeps: search.MAX_PRICED_PER_LEG (a test checks the two agree). */
const MAX_OPTIONS = 60;
const MAX_BYTES = Object.freeze({ offerRequest: 8 * MB, other: 4 * MB });
const CHECKS = Object.freeze(['auto', 'peek', 'confirm', 'final']);
const CABIN_TO_DUFFEL = Object.freeze({ economy: 'economy', premium: 'premium_economy', business: 'business' });
const CABIN_FROM_DUFFEL = Object.freeze({ economy: 'economy', premium_economy: 'premium', business: 'business' });
const CABIN_LABEL = Object.freeze({ economy: 'Economy', premium: 'Premium economy', business: 'Business' });
/** What a whole offer says about its terms: they depend on the fare (each option carries its own). */
const OFFER_CANCELLATION = Object.freeze({
  type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: 'Refund and change terms depend on the fare.',
});
const IATA_RE = /^[A-Z0-9]{2}$/;
const AIRPORT_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/;
const OFFER_ID_RE = /^off_[A-Za-z0-9]{1,64}$/;
const SKIP_REASONS = Object.freeze(['mixedCabin', 'firstCabin', 'unknownCarrier', 'timeMismatch', 'duplicateOption']);
const REF_KEEP_MAX_MS = 60 * 60 * 1000;
const MIN_LEFT_MS = 60 * 1000;
const FRESH_MARGIN_MS = 120 * 1000;

/**
 * An ISO 8601 duration ("PT02H26M", "P1DT2H") in whole minutes.
 * @param {unknown} text
 * @returns {number|null}
 */
function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  return Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0) + Math.round(Number(m[4] || 0) / 60);
}

/**
 * Whether an offer request is sent once more (§4.2): only after a connection error before any answer, or a
 * 503 ("Please retry later", D-ERR). Never after an answer that broke mid-body or a refused redirect (Duffel
 * got the request: a second one is a second search, which costs ratio), never after a timeout (a retry could
 * not finish inside the 15 s), and never on 500 or 502 (D-ERR: "You should not retry this request") or 504
 * (Duffel's airline_internal timeout).
 * @param {{ kind: string, status?: number, afterResponse?: boolean }} o http.js's outcome
 * @returns {boolean}
 */
function offerRequestRetry(o) {
  return (o.kind === 'network' && !o.afterResponse) || (o.kind === 'response' && o.status === 503);
}

/**
 * Whether GET /air/offers/{id} is sent again (§4.2, at most twice): a connection error (a GET is idempotent,
 * so one that broke mid-body too), 503 or 504 ("Please retry later", D-ERR), and a 429 whose ratelimit-reset
 * is at most 2 s away (that wait, in ms). Never 500 or 502 (D-ERR: "You should not retry this request").
 * @param {{ kind: string, status?: number, headers?: { get: Function } }} o
 * @param {Date} now
 * @returns {boolean|number}
 */
function offerGetRetry(o, now) {
  if (o.kind === 'network') return true;
  if (o.kind !== 'response') return false;
  if (o.status === 503 || o.status === 504) return true;
  if (o.status === 429) {
    const reset = Date.parse(String((o.headers && o.headers.get('ratelimit-reset')) || ''));
    const wait = Number.isFinite(reset) ? Math.max(0, Math.ceil((reset - now.getTime()) / 1000) * 1000) : Infinity;
    return wait <= 2000 ? wait : false;
  }
  return false;
}

const isCode = v => typeof v === 'string' && IATA_RE.test(v);
const dayIndex = date => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
const company = () => currentCompany() || 'unscoped';
/** Fares: US dollars first, then cheapest (byAmount); then by fare id (byFare). */
const byAmount = (a, b) => (a.currency === 'USD' ? 0 : 1) - (b.currency === 'USD' ? 0 : 1) || a.totalMinor - b.totalMinor;
const byFare = (a, b) => byAmount(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const firstError = json => (json && Array.isArray(json.errors) && json.errors[0] && typeof json.errors[0] === 'object' ? json.errors[0] : {});

/** A condition as source.TERMS reads it, slice level first, then offer level; null when both are null. */
function condition(slice, offer, name) {
  const s = slice && slice.conditions && typeof slice.conditions === 'object' ? slice.conditions[name] : null;
  const o = offer && offer.conditions && typeof offer.conditions === 'object' ? offer.conditions[name] : null;
  const c = s != null ? s : o != null ? o : null;
  if (!c || typeof c !== 'object') return null;
  const amount = typeof c.penalty_amount === 'string' ? c.penalty_amount.trim() : typeof c.penalty_amount === 'number' ? String(c.penalty_amount) : null;
  return {
    allowed: typeof c.allowed === 'boolean' ? c.allowed : null,
    penaltyAmount: amount,
    penaltyCurrency: typeof c.penalty_currency === 'string' ? c.penalty_currency : null,
  };
}

/** The penalty in the total's currency as minor units: 0 for "no fee", null when unknown or in another currency. */
function penaltyMinor(cond, currency) {
  if (!cond || cond.allowed !== true || cond.penaltyAmount === null || cond.penaltyCurrency !== currency) return null;
  const p = parseMinor(cond.penaltyAmount, currency);
  return p ? p.minor : null;
}

/** How much of the fare a refund returns, in whole percent (§3.2): 0 whenever it isn't known. */
function refundablePercent(refund, totalMinor, currency) {
  if (!refund || refund.allowed !== true) return 0;
  const p = penaltyMinor(refund, currency);
  if (p === null || !(totalMinor > 0)) return 0;
  if (p === 0) return 100;
  return Math.min(100, Math.max(0, Math.floor(((totalMinor - p) * 100) / totalMinor)));
}

/** The quote's cancellation (§3.2): summary is the whole terms text. */
function cancellationOf(refund, totalMinor, currency, terms) {
  const p = penaltyMinor(refund, currency);
  if (p === null || !(totalMinor > 0)) return { type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: terms };
  if (p === 0) return { type: 'free', freeUntilHours: 0, penaltyPercent: 0, summary: terms };
  return { type: 'partial', freeUntilHours: 0, penaltyPercent: Math.min(100, Math.ceil((p * 100) / totalMinor)), summary: terms };
}

/** The bags that hold on every segment: min over segments of the sum of each type; null when not stated. */
function bagsOf(segments) {
  let checked = Infinity, carryOn = Infinity;
  for (const seg of segments) {
    const p = Array.isArray(seg.passengers) ? seg.passengers[0] : null;
    if (!p || !Array.isArray(p.baggages)) return { checked: null, carryOn: null };
    let c = 0, k = 0;
    for (const b of p.baggages) {
      if (!b || !Number.isSafeInteger(b.quantity) || b.quantity < 0) return { checked: null, carryOn: null };
      if (b.type === 'checked') c += b.quantity;
      else if (b.type === 'carry_on') k += b.quantity;
    }
    checked = Math.min(checked, c);
    carryOn = Math.min(carryOn, k);
  }
  return { checked: Number.isFinite(checked) ? checked : null, carryOn: Number.isFinite(carryOn) ? carryOn : null };
}

/** The price lines (§3.2): their sum is always exactly total_amount. */
function linesOf(raw, total) {
  const cur = raw.total_currency;
  const base = raw.base_currency === cur ? parseMinor(raw.base_amount, cur) : null;
  const tax = raw.tax_amount != null && raw.tax_currency === cur ? parseMinor(raw.tax_amount, cur) : null;
  if (base && tax && base.minor + tax.minor === total.minor) {
    return [
      { code: 'fare', label: 'Fare', kind: 'base', amount: base.minor },
      { code: 'taxes', label: 'Taxes and airline charges', kind: 'tax', amount: tax.minor },
    ];
  }
  return [{ code: 'fare', label: 'Fare including taxes', kind: 'base', amount: total.minor }];
}

class DuffelFlights {
  /**
   * @param {{ token: string, mode: 'sandbox'|'live', http: { call: Function, warn: Function, info: Function },
   *   now: () => Date, log?: object, state: { latched: object, latch: Function }, cacheSeconds?: number,
   *   airport?: (code: string) => ({ city: string, country: string, tz: string }|null), timeouts?: object }} opts
   */
  constructor({ token, mode, http, now, log = console, state, cacheSeconds = 300, airport = () => null, timeouts = {} }) {
    if (mode !== 'sandbox' && mode !== 'live') throw new TypeError('[suppliers] DuffelFlights needs a mode');
    this.name = 'DuffelFlights';
    this.vertical = 'flights';
    this.isDemo = true;
    this.mode = mode;
    this.prefix = offerPrefix('flight', mode);
    this.http = http;
    this.now = now;
    this.log = log;
    this.state = state;
    this.cacheMs = Math.max(0, cacheSeconds) * 1000;
    this.airport = airport;
    this.timeouts = { ...TIMEOUTS, ...timeouts };
    this.results = new SupplierCache({ now, maxEntries: 500, maxPerCompany: 20, maxBytes: 32 * MB });
    this.refs = new SupplierCache({ now, maxEntries: 1000, maxPerCompany: 40, maxBytes: 4 * MB });
    /** @type {WeakMap<object, object>} a provider Offer handed out → the normalised itinerary behind it */
    this.internal = new WeakMap();
    // The key lives only in this closure, and only ever goes into the Authorization header.
    const auth = `Bearer ${token}`;
    this._headers = post => ({
      Authorization: auth,
      'Duffel-Version': 'v2',
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'x-client-correlation-id': crypto.randomUUID(),
      ...(post ? { 'Content-Type': 'application/json' } : {}),
    });
    Object.defineProperty(this, '_headers', { enumerable: false });
  }

  // -------------------------------------------------------------------------------------------------------
  // The provider contract

  /**
   * @param {import('../types').BusinessFlightQuery} pq
   * @returns {Promise<object[]>} provider Offers
   */
  async search(pq) {
    return (await this.searchDetailed(pq)).offers;
  }

  /**
   * search(pq) with what was left out (types.DetailedSearch).
   * @param {import('../types').BusinessFlightQuery} pq
   * @returns {Promise<{ offers: object[], skipped: object, truncated: boolean }>}
   */
  async searchDetailed(pq) {
    this._alive();
    const q = this._query(pq);
    const org = company(), key = this._key(q);
    const entry = this.results.get(org, key) || await this._search(q, org, key);
    return { offers: entry.groups.map(g => this._offer(g)), skipped: { ...entry.skipped }, truncated: entry.truncated };
  }

  /**
   * One itinerary, priced as pq.check allows (see the header).
   * @param {string} offerId
   * @param {import('../types').BusinessFlightQuery} pq
   * @param {{ optionId?: string|null }} [opts] the fare the caller will quote
   * @returns {Promise<object|null>} null for another namespace (no call) or an itinerary that is gone
   * @throws {AppError} 503 live_check_skipped (peek), 503 supplier_unavailable, 429 supplier_busy
   */
  async getOffer(offerId, pq, { optionId = null } = {}) {
    if (!this._mine(offerId)) return null;
    this._alive();
    const q = this._query(pq);
    const org = company(), key = this._key(q);
    const check = CHECKS.includes(pq && pq.check) ? pq.check : 'auto';
    if (check === 'auto' || check === 'peek') {
      const hit = this.results.get(org, key);
      if (hit) return this._offerIn(hit, offerId);
      if (check === 'peek') return this._peek(q, org, key, offerId, optionId);
    }
    return this._confirm(q, org, key, offerId, optionId);
  }

  /**
   * The quote for one fare, read locally from the offer the composer was handed (or from getOffer).
   * @param {{ offerId: string, optionId: string, query: object, offer?: object }} input
   * @returns {Promise<object>} a SupplierQuote
   * @throws {AppError} 404 when the itinerary or the fare is gone
   */
  async quote({ offerId, optionId, query, offer = null }) {
    let g = offer ? this.internal.get(offer) : null;
    if (!g || g.offerId !== offerId) {
      const o = await this.getOffer(offerId, query, { optionId });
      g = o ? this.internal.get(o) : null;
    }
    if (!g) throw new AppError('offer_not_found', 'This flight is no longer available.', 404);
    const opt = g.options.find(o => o.id === optionId);
    if (!opt) throw new AppError('option_not_found', 'That fare is no longer offered.', 404);
    const pub = this._offer(g);
    return {
      offer: pub,
      option: pub.options.find(o => o.id === optionId),
      lines: opt.lines.map(l => ({ ...l })),
      currency: opt.currency,
      startDate: g.date,
      cancellation: { ...opt.cancellation },
    };
  }

  async book() { throw new AppError('booking_not_open', 'Booking is not open yet.', 409); }

  async cancel() { throw new AppError('booking_not_open', 'Booking is not open yet.', 409); }

  // -------------------------------------------------------------------------------------------------------
  // Checks and keys

  _mine(offerId) {
    return typeof offerId === 'string' && offerId.startsWith(this.prefix) && sourceOf(offerId) === this.mode;
  }

  _alive() {
    if (this.state && this.state.latched.duffel) throw supplierError('supplier_unavailable', { vertical: 'flights' });
  }

  _query(pq) {
    const q = pq || {};
    if (!AIRPORT_RE.test(q.from || '') || !AIRPORT_RE.test(q.to || '') || !DATE_RE.test(q.departDate || '') || !CABIN_TO_DUFFEL[q.cabin]) {
      throw new TypeError('[suppliers] a flight query needs from, to, departDate and cabin');
    }
    return { from: q.from, to: q.to, date: q.departDate, cabin: q.cabin };
  }

  _key(q) {
    return ['duffel', this.mode, q.from, q.to, q.date, q.cabin, 1].join('|');
  }

  _mismatch() {
    this.state.latch('duffel');
    return supplierError('supplier_unavailable', { vertical: 'flights' });
  }

  _expectLive() {
    return this.mode === 'live';
  }

  // -------------------------------------------------------------------------------------------------------
  // Search

  /** Run the offer request (single-flight per company and query), store it, return the cache entry. */
  _search(q, org, key) {
    return this.results.once(org, key, async () => {
      const res = await this.http.call({
        supplier: 'duffel', op: 'offer_request', vertical: 'flights', method: 'POST',
        url: `${API}/air/offer_requests?return_offers=true&supplier_timeout=${SUPPLIER_TIMEOUT_MS}`,
        headers: this._headers(true),
        body: JSON.stringify({ data: {
          slices: [{ origin: q.from, destination: q.to, departure_date: q.date }],
          passengers: [{ type: 'adult' }],
          cabin_class: CABIN_TO_DUFFEL[q.cabin],
          max_connections: 1,
        } }),
        timeoutMs: this.timeouts.offerRequest,
        maxBytes: MAX_BYTES.offerRequest,
        maxAttempts: 2,
        retry: offerRequestRetry,
      });
      const data = this._data(res, 'offer_request');
      // The mode check (§2.1): the offer request and every offer must say the mode we run in; a missing field
      // is a mismatch. The whole answer is then thrown away and flights are latched off.
      if (data.live_mode !== this._expectLive()) throw this._mismatch();
      if (!Array.isArray(data.offers)) throw supplierError('supplier_unavailable', { vertical: 'flights' });
      if (data.offers.some(o => !o || o.live_mode !== this._expectLive())) throw this._mismatch();
      const entry = this._normalizeAll(data.offers, q, res.answeredAt);
      this._store(org, key, entry);
      return entry;
    });
  }

  /** A 200/201 answer's `data`, or the right error for anything else. */
  _data(res, op) {
    if ((res.status === 200 || res.status === 201) && res.json && res.json.data && typeof res.json.data === 'object') return res.json.data;
    if (res.status === 401 || res.status === 403) this.http.warn('[suppliers] Duffel refused the access token');
    else if (res.status === 200 || res.status === 201) this.http.warn(`[suppliers] duffel ${op}: an answer without data`);
    throw supplierError('supplier_unavailable', { vertical: 'flights' });
  }

  /** Store a search: the results while fresh, the Duffel offer ids while usable. */
  _store(org, key, entry) {
    const t = this.now().getTime();
    const expiries = entry.expiries;
    // TTL (§4.4): min(the cache setting, the earliest offer expiry − 120 s); under 60 s, not cached. An answer
    // with no offers has no expiry and keeps the cache setting; an expiry that doesn't parse stops caching.
    const earliest = expiries.every(Number.isFinite) ? Math.min(Infinity, ...expiries) : NaN;
    const fresh = Math.min(this.cacheMs, earliest - FRESH_MARGIN_MS - t);
    if (Number.isFinite(fresh) && fresh >= MIN_LEFT_MS) this.results.set(org, key, entry.public, fresh);
    else this.results.delete(org, key);
    const latest = expiries.filter(Number.isFinite);
    const keep = latest.length ? Math.min(REF_KEEP_MAX_MS, Math.max(...latest) - MIN_LEFT_MS - t) : 0;
    if (keep > 0) this.refs.set(org, key, entry.refs, keep);
    else this.refs.delete(org, key);
  }

  /** Every offer normalised, filtered, capped at the cheapest 60 options and grouped (see the header). */
  _normalizeAll(rawOffers, q, answeredAt) {
    const skipped = {};
    const count = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
    let roundedAmounts = 0, unreadable = 0;
    const all = [];
    for (const raw of rawOffers) {
      const n = this._normalize(raw, q, answeredAt);
      if (n.skip) {
        if (SKIP_REASONS.includes(n.skip)) count(n.skip);
        else if (n.skip === 'malformed') unreadable += 1;
        continue;
      }
      if (n.rounded) roundedAmounts += 1;
      all.push(n);
    }
    if (roundedAmounts) this.http.warn(`[suppliers] duffel: ${roundedAmounts} amounts had more digits than their currency and were rounded half-up`);
    if (unreadable) this.http.warn(`[suppliers] duffel: ${unreadable} offers could not be read and were left out`);
    // Cheapest first, US dollar fares before any other currency (amounts in two currencies don't compare;
    // Business companies are USD, §3.5), ties by option key.
    const keyOf = n => `${n.group.offerId}|${n.option.id}`;
    const foreign = n => (n.option.currency === 'USD' ? 0 : 1);
    all.sort((a, b) => foreign(a) - foreign(b) || a.option.totalMinor - b.option.totalMinor || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    const truncated = all.length > MAX_OPTIONS;
    const kept = all.slice(0, MAX_OPTIONS);
    const groups = new Map();
    const refs = {};
    const expiries = [];
    for (const n of kept) {
      let g = groups.get(n.group.offerId);
      if (!g) { g = { ...n.group, options: [] }; groups.set(n.group.offerId, g); }
      if (g.options.some(o => o.id === n.option.id) || g.owner.code !== n.group.owner.code) { count('duplicateOption'); continue; }
      g.options.push(n.option);
      refs[`${g.offerId}|${n.option.id}`] = n.ref;
      expiries.push(Date.parse(n.ref.expiresAt));
    }
    const list = [...groups.values()];
    return { public: { groups: list, skipped, truncated }, groups: list, skipped, truncated, refs, expiries };
  }

  /**
   * One Duffel offer as { group, option, ref } (or { skip: reason }).
   * @returns {{ skip?: string, group?: object, option?: object, ref?: object, rounded?: boolean }}
   */
  _normalize(raw, q, answeredAt) {
    if (!raw || typeof raw !== 'object') return { skip: 'malformed' };
    const owner = raw.owner;
    if (!owner || !isCode(owner.iata_code)) return { skip: 'unknownCarrier' };
    const slice = Array.isArray(raw.slices) ? raw.slices[0] : null;
    const rawSegs = slice && Array.isArray(slice.segments) ? slice.segments : [];
    if (!rawSegs.length) return { skip: 'malformed' };
    for (const s of rawSegs) {
      if (!s || !s.marketing_carrier || !isCode(s.marketing_carrier.iata_code) || !s.operating_carrier || !isCode(s.operating_carrier.iata_code)) {
        return { skip: 'unknownCarrier' };
      }
    }
    const cabins = rawSegs.map(s => (Array.isArray(s.passengers) && s.passengers[0] ? s.passengers[0].cabin_class : null));
    if (new Set(cabins).size > 1) return { skip: 'mixedCabin' };
    if (cabins[0] === 'first') return { skip: 'firstCabin' };
    const cabin = CABIN_FROM_DUFFEL[cabins[0]];
    if (!cabin || cabin !== q.cabin) return { skip: 'otherCabin' };

    const segments = [];
    let firstUtc = null, lastUtc = null;
    for (const s of rawSegs) {
      const seg = this._segment(s);
      if (!seg) return { skip: 'timeMismatch' };
      if (firstUtc === null) firstUtc = seg.departUtc;
      lastUtc = seg.arriveUtc;
      segments.push(seg);
    }
    const first = segments[0], last = segments[segments.length - 1];
    if (first.from.code !== q.from || last.to.code !== q.to || first.departAt.slice(0, 10) !== q.date) return { skip: 'malformed' };

    const total = parseMinor(raw.total_amount, raw.total_currency);
    if (!total) return { skip: 'malformed' };
    const currency = raw.total_currency;
    const refund = condition(slice, raw, 'refund_before_departure');
    const change = condition(slice, raw, 'change_before_departure');
    const bags = bagsOf(rawSegs);
    const terms = TERMS.fare({ refund, change, bags });
    const marketingName = Array.isArray(rawSegs[0].passengers) && rawSegs[0].passengers[0] ? rawSegs[0].passengers[0].cabin_class_marketing_name : null;
    const brand = typeof slice.fare_brand_name === 'string' && slice.fare_brand_name.trim() ? slice.fare_brand_name.trim() : null;
    const optionId = ids.flightOptionId({
      brand, marketingName, cabin, refundAllowed: refund ? refund.allowed : null, changeAllowed: change ? change.allowed : null,
    });
    const offerId = ids.flightOfferId(this.mode, { flightNumbers: segments.map(s => s.flightNumber), firstDepartLocal: first.departAt, cabin });
    if (!offerId) return { skip: 'malformed' };

    const via = [];
    rawSegs.forEach((s, i) => {
      for (const stop of Array.isArray(s.stops) ? s.stops : []) via.push(this._place(stop && stop.airport));
      if (i < rawSegs.length - 1) via.push({ code: segments[i].to.code, city: segments[i].to.city });
    });
    const stopsInside = rawSegs.reduce((n, s) => n + (Array.isArray(s.stops) ? s.stops.length : 0), 0);
    const elapsed = parseDuration(slice.duration);
    const name = (brand || (typeof marketingName === 'string' && marketingName.trim()) || CABIN_LABEL[cabin]).slice(0, 80);
    const fare = {
      code: optionId, cabinKg: 0, checkedBags: Number.isSafeInteger(bags.checked) ? bags.checked : 0, checkedKg: 0,
      changeable: Boolean(change && change.allowed === true),
      refundablePercent: refundablePercent(refund, total.minor, currency),
      terms,
    };
    const passenger = Array.isArray(raw.passengers) && raw.passengers[0] && typeof raw.passengers[0].id === 'string' ? raw.passengers[0].id : null;
    const lines = linesOf(raw, total);
    return {
      rounded: total.rounded,
      group: {
        offerId, date: q.date, from: q.from, to: q.to, cabin,
        owner: this._carrier(owner),
        segments: segments.map(({ departUtc, arriveUtc, ...s }) => s),
        stops: segments.length - 1 + stopsInside,
        via,
        elapsedMinutes: elapsed !== null && elapsed > 0 ? elapsed : Math.round((lastUtc - firstUtc) / 60000),
        country: this._country(q.to),
        answeredAt,
      },
      option: {
        id: optionId, name, totalMinor: total.minor, currency, lines,
        cancellation: cancellationOf(refund, total.minor, currency, terms),
        fare,
      },
      ref: { id: typeof raw.id === 'string' ? raw.id : '', passengerId: passenger, expiresAt: typeof raw.expires_at === 'string' ? raw.expires_at : '' },
    };
  }

  /** One segment with local times, its UTC instants and the duration cross-check; null when it fails. */
  _segment(s) {
    const o = s.origin || {}, d = s.destination || {};
    if (!AIRPORT_RE.test(o.iata_code || '') || !AIRPORT_RE.test(d.iata_code || '')) return null;
    const dep = LOCAL_RE.exec(String(s.departing_at || '')), arr = LOCAL_RE.exec(String(s.arriving_at || ''));
    if (!dep || !arr) return null;
    const zone = (a, code) => (typeof a.time_zone === 'string' && tz.isTimeZone(a.time_zone) ? a.time_zone : (this.airport(code) || {}).tz || null);
    const zo = zone(o, o.iata_code), zd = zone(d, d.iata_code);
    if (!zo || !zd) return null;
    const departAt = `${dep[1]}T${dep[2]}:${dep[3]}`, arriveAt = `${arr[1]}T${arr[2]}:${arr[3]}`;
    let departUtc, arriveUtc;
    try {
      departUtc = tz.localToUtc(zo, departAt).getTime();
      arriveUtc = tz.localToUtc(zd, arriveAt).getTime();
    } catch { return null; }
    const duration = parseDuration(s.duration);
    // The safety net (§3.2): Duffel documents airport-local times (D-ORDT); when it also gives the duration,
    // the two must agree within a minute. With no duration the check is skipped, not failed.
    if (duration !== null && Math.abs(departUtc + duration * 60000 - arriveUtc) > 60000) return null;
    const minutes = duration !== null ? duration : Math.round((arriveUtc - departUtc) / 60000);
    if (!(minutes > 0) || arriveUtc <= departUtc) return null;
    const marketing = s.marketing_carrier;
    const number = String(s.marketing_carrier_flight_number ?? '').replace(/[^A-Za-z0-9]/g, '');
    if (!number) return null;
    return {
      carrier: this._carrier(s.operating_carrier),
      flightNumber: `${marketing.iata_code}${number}`.slice(0, 12),
      from: { code: o.iata_code, city: this._city(o) },
      to: { code: d.iata_code, city: this._city(d) },
      departAt,
      arriveAt,
      arriveDayOffset: dayIndex(arr[1]) - dayIndex(dep[1]),
      durationMinutes: minutes,
      departUtc,
      arriveUtc,
    };
  }

  _carrier(c) {
    const code = c.iata_code;
    if (code === TEST_AIRLINE.code && this.mode === 'sandbox') return { code, name: TEST_AIRLINE.name };
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 80) : code;
    return { code, name };
  }

  _city(a) {
    const known = AIRPORT_RE.test(a.iata_code || '') ? this.airport(a.iata_code) : null;
    if (known && known.city) return known.city;
    const name = typeof a.city_name === 'string' && a.city_name.trim() ? a.city_name : typeof a.name === 'string' && a.name.trim() ? a.name : a.iata_code || '';
    return String(name).trim().slice(0, 80);
  }

  _place(a) {
    const airport = a && typeof a === 'object' ? a : {};
    return { code: AIRPORT_RE.test(airport.iata_code || '') ? airport.iata_code : '', city: this._city(airport) || 'a stop' };
  }

  _country(code) {
    const a = this.airport(code);
    return a && a.country ? a.country : '';
  }

  /** A provider Offer (contracts.js shape) for one itinerary: a fresh object every time. */
  _offer(g) {
    const first = g.segments[0], last = g.segments[g.segments.length - 1];
    const cheapest = g.options[0];
    const offer = {
      id: g.offerId,
      vertical: 'flights',
      provider: this.name,
      demo: this.mode !== 'live',
      title: `${first.from.city} → ${last.to.city}`,
      location: { name: `${first.from.code} → ${last.to.code}`, city: last.to.city, country: g.country },
      media: [],
      fromPrice: { amount: cheapest.totalMinor, currency: cheapest.currency, unit: 'passenger' },
      options: g.options.map(o => ({ id: o.id, name: o.name, price: { amount: o.totalMinor, currency: o.currency }, available: true })),
      cancellation: { ...OFFER_CANCELLATION },
      details: {
        segments: g.segments.map(s => ({ ...s, carrier: { ...s.carrier }, from: { ...s.from }, to: { ...s.to } })),
        stops: g.stops,
        via: g.via.map(v => ({ ...v })),
        owner: { ...g.owner },
        cabin: g.cabin,
        baggage: { cabinKg: 0, checkedBags: cheapest.fare.checkedBags, checkedKg: 0 },
        fareFamilies: g.options.map(o => ({ ...o.fare })),
        elapsedMinutes: g.elapsedMinutes,
        answeredAt: g.answeredAt,
      },
    };
    this.internal.set(offer, g);
    return offer;
  }

  _offerIn(entry, offerId) {
    const g = entry.groups.find(x => x.offerId === offerId);
    return g ? this._offer(g) : null;
  }

  // -------------------------------------------------------------------------------------------------------
  // Price checks

  /** The Duffel offer behind one fare, while it has more than 60 s left. */
  _ref(org, key, offerId, optionId) {
    if (!optionId) return null;
    const refs = this.refs.get(org, key);
    const r = refs && Object.prototype.hasOwnProperty.call(refs, `${offerId}|${optionId}`) ? refs[`${offerId}|${optionId}`] : null;
    if (!r || !OFFER_ID_RE.test(r.id)) return null;
    const left = Date.parse(r.expiresAt) - this.now().getTime();
    return left > MIN_LEFT_MS ? r : null;
  }

  async _peek(q, org, key, offerId, optionId) {
    const skipped = () => supplierError('live_check_skipped');
    const ref = this._ref(org, key, offerId, optionId);
    if (!ref) throw skipped();
    const got = await this._get(ref, q, org, key, offerId, optionId);
    if (got.gone || got.failed) throw skipped();
    return got.offer;
  }

  async _confirm(q, org, key, offerId, optionId) {
    if (!optionId) return this._offerIn(await this._search(q, org, key), offerId);
    let researched = false;
    let ref = this._ref(org, key, offerId, optionId);
    if (!ref) {
      await this._search(q, org, key);
      researched = true;
      ref = this._ref(org, key, offerId, optionId);
      if (!ref) return null;
    }
    let got = await this._get(ref, q, org, key, offerId, optionId);
    if (got.gone && !researched) {
      await this._search(q, org, key);
      ref = this._ref(org, key, offerId, optionId);
      if (!ref) return null;
      got = await this._get(ref, q, org, key, offerId, optionId);
    }
    if (got.failed) throw supplierError('supplier_unavailable', { vertical: 'flights' });
    return got.gone ? null : got.offer;
  }

  /**
   * A GET answer for one fare replaces that fare in the cached search (§4.4), so auto and peek, the search
   * pages and the variants never serve an older price than one a check already saw. The other fares keep
   * theirs, and the itinerary keeps its answer time (the oldest of its fares: never a fresher claim than is
   * true). When the answer moved the itinerary itself (times, carriers, stops), the cached itinerary is stale
   * as a whole and the search entry is dropped. The entry keeps its expiry, shortened to the fare's new
   * expires_at less 120 s (under 60 s left: dropped).
   * @param {string} org
   * @param {string} key
   * @param {object} fresh the re-normalised itinerary with the one fare
   * @param {number} expiresAt the fare's Duffel expires_at (ms; NaN when unknown)
   */
  _refresh(org, key, fresh, expiresAt) {
    const entry = this.results.get(org, key);
    if (!entry) return;
    const old = entry.groups.find(g => g.offerId === fresh.offerId);
    const option = fresh.options[0];
    if (!old || !old.options.some(o => o.id === option.id)) return;
    const shape = g => JSON.stringify([g.segments, g.owner, g.stops, g.via, g.elapsedMinutes, g.cabin, g.date, g.from, g.to]);
    const ttl = Math.min(this.results.expiresIn(org, key), Number.isFinite(expiresAt) ? expiresAt - FRESH_MARGIN_MS - this.now().getTime() : 0);
    if (shape(old) !== shape(fresh) || !(ttl >= MIN_LEFT_MS)) { this.results.delete(org, key); return; }
    const options = old.options.map(o => (o.id === option.id ? option : o)).sort(byFare);
    // The search's own order: by each itinerary's cheapest fare, ties by offer id then fare id.
    const keyOf = g => `${g.offerId}|${g.options[0].id}`;
    const groups = entry.groups.map(g => (g === old ? { ...old, options } : g))
      .sort((a, b) => byAmount(a.options[0], b.options[0]) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    this.results.set(org, key, { ...entry, groups }, ttl);
  }

  /**
   * GET /air/offers/{id} for one fare.
   * @returns {Promise<{ offer?: object, gone?: boolean, failed?: boolean }>}
   */
  async _get(ref, q, org, key, offerId, optionId) {
    const res = await this.http.call({
      supplier: 'duffel', op: 'offer_get', vertical: 'flights',
      url: `${API}/air/offers/${ref.id}`,
      headers: this._headers(false),
      timeoutMs: this.timeouts.offerGet,
      maxBytes: MAX_BYTES.other,
      maxAttempts: 3,
      retry: o => offerGetRetry(o, this.now()),
    });
    if (res.status === 200) {
      const data = this._data(res, 'offer_get');
      if (data.live_mode !== this._expectLive()) throw this._mismatch();
      const n = this._normalize(data, q, res.answeredAt);
      if (n.skip) return { gone: true };
      const sameFlights = n.group.segments.map(s => s.flightNumber).join('-') === offerId.slice(this.prefix.length).split('_')[0];
      if (n.group.offerId !== offerId && !sameFlights) return { gone: true };
      // The same Duffel offer: its id is the fare's identity, so a renamed brand or moved times are a change
      // to this fare (recheck sees the new terms or times), never a different option.
      const g = { ...n.group, offerId, options: [{ ...n.option, id: optionId, fare: { ...n.option.fare, code: optionId } }] };
      const refs = this.refs.get(org, key);
      if (refs && refs[`${offerId}|${optionId}`]) {
        refs[`${offerId}|${optionId}`] = { ...refs[`${offerId}|${optionId}`], expiresAt: n.ref.expiresAt || ref.expiresAt };
      }
      this._refresh(org, key, g, Date.parse(n.ref.expiresAt));
      return { offer: this._offer(g) };
    }
    const code = firstError(res.json).code;
    if (res.status === 404 || (res.status === 422 && (code === 'offer_expired' || code === 'offer_no_longer_available'))) return { gone: true };
    if (res.status === 401 || res.status === 403) this.http.warn('[suppliers] Duffel refused the access token');
    return { failed: true };
  }
}

module.exports = { DuffelFlights, offerRequestRetry, offerGetRetry, parseDuration, condition, refundablePercent, cancellationOf, bagsOf, linesOf, API, TIMEOUTS, MAX_OPTIONS, SUPPLIER_TIMEOUT_MS };
