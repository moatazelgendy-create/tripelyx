// LiteApiHotels: the HotelProvider contract (providers/contracts.js) over LiteAPI v3.0, sandbox only in round 1
// (real-suppliers design §3.1, §3.3, §3.4, §5.3).
//
// Search: one rates call per stay, POST https://api.liteapi.travel/v3.0/hotels/rates (L-RATES) with X-API-Key:
//   the searched city and its ISO-2 country, 1 room for 1 adult, USD, the guest nationality, the 40 lowest-priced
//   hotels (sort by price, limit 40), at most 3 rates a hotel, hotel data included. One hotel (`data[].hotelId`)
//   is one provider Offer; each room type (`roomTypes[]`, which carries the offerId prebook takes, with one rate
//   for 1 room and 1 adult, L-STRUCT) is one option. The cheapest 60 options of the answer are kept
//   (`truncated` when more existed); the same option id twice in a hotel keeps the cheaper (duplicateOption).
//   Left out and counted: a hotel with no hotel data or no name (noHotelData), a rate with a fee paid at the
//   hotel in another currency (feeOtherCurrency: it can't be added without a made-up exchange rate).
// Mode: every rates answer carries `sandbox` (L-RATES); it must equal (mode !== 'live'), and a missing flag is a
//   mismatch. A 2001 "no availability" answer (HTTP 200, L-ERRW) carries no rates and is not checked. Prebook has
//   no flag (L-PRE); every prebook here follows a checked rates call for the same hotel in the same operation.
//   A mismatch throws the answer away, fails with 503 supplier_unavailable, logs `mode_mismatch` once and
//   latches hotels off for the process (flights keep working).
// Rows (§3.3): ids from ids.js (htl_t.<hotelId>; LiteAPI's offerId never leaves this module); stars as given
//   (4.5 stays 4.5; null, missing or 0 → 0, "no star rating from the supplier"; never the review rating); area
//   = the address plus the supplier's city when it differs; city and country = the searched ones; room =
//   rate name + board; sleeps = maxOccupancy; no bed, no amenities.
// Lines (§3.4): `taxesAndFees: null` reads as [] (everything included). Included items in the total's currency
//   are one tax line each and the room line is the rest; an included item in another currency makes one line,
//   "Room total including taxes". An item paid at the hotel in the total's currency is a `fee` line
//   "{description}, paid at the hotel", counted in the total (convention: on supplier hotel rows a fee line is
//   always paid at the hotel). Commission, suggested selling price, initial price and supplier fields are never
//   read into anything.
// Cancellation: refundable only for RFN with its first penalty deadline still ahead; freeUntilHours = the hours
//   from that deadline (read in the supplier's stated time zone) to check-in at 00:00 in the destination's
//   time zone. NRFN → "Non-refundable."; RFN without a readable deadline → TERMS.hotelNoDeadline.
// Price checks (§5.3), by pq.check: auto = the cached search, else rates for that hotel; peek = cache only
//   (else 503 live_check_skipped); confirm = fresh rates for that hotel; final = fresh rates, then quote()
//   prebooks the room (POST https://book.liteapi.travel/v3.0/rates/prebook, never with the payment SDK).
//   Fresh rates for one hotel also refresh that hotel in the cached city search, so a later auto or peek
//   never serves an older price than a check already saw. A prebook that changed the meal plan (boardChanged,
//   or another board) says so in the room's name and terms text: the price check then reads it as a change.
//   Prebook 2001, 4040 or 4020 → fresh rates for the hotel → the same option re-found → one more prebook; still
//   nothing → 409 option_sold_out (the composer shows the room unavailable). 4016 → once more with the longer
//   timeout; 5000 → once more; anything else → 503 supplier_unavailable.
// book() and cancel() answer 409 booking_not_open: nothing calls them in round 1.
const crypto = require('node:crypto');
const tz = require('../tz');
const { AppError } = require('../../lib/errors');
const { TERMS, sourceOf, offerPrefix, supplierError } = require('../source');
const { currentCompany } = require('../scope');
const { parseMinor, formatMinor } = require('./money');
const ids = require('./ids');
const { iso2 } = require('./places');
const { SupplierCache, MB } = require('./cache');

const API = 'https://api.liteapi.travel/v3.0';
const BOOK_API = 'https://book.liteapi.travel/v3.0';
/** Our client timeouts (§4.1) and the supplier-side ones we send. */
const TIMEOUTS = Object.freeze({ rates: 12000, prebook: 25000, prebookLong: 35000 });
const SUPPLIER_TIMEOUTS = Object.freeze({ rates: 8, prebook: 20, prebookLong: 30 });
const HOTEL_LIMIT = 40;
const RATES_PER_HOTEL = 3;
/** The options one answer keeps: search.MAX_PRICED_PER_LEG. */
const MAX_OPTIONS = 60;
const CHECKS = Object.freeze(['auto', 'peek', 'confirm', 'final']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CANCEL_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/;
/** Prebook codes that mean "search again, then prebook a fresh offer" (L-ERRW, §5.3). */
const STALE_CODES = Object.freeze([2001, 4040, 4020]);
const OFFER_CANCELLATION = Object.freeze({
  type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: 'Cancellation terms depend on the room.',
});
const company = () => currentCompany() || 'unscoped';
const dayIndex = date => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);

/** A LiteAPI error's numeric code, or null. */
function liteCode(json) {
  const e = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : null;
  const n = e ? Number(e.code) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** A supplier's short text, safe to print: one line, no control characters, no long dashes, at most `max`. */
function cleanText(value, max = 80) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** A hotel's rooms: US dollars first, then cheapest, then by id. */
const byPrice = (a, b) => (a.currency === 'USD' ? 0 : 1) - (b.currency === 'USD' ? 0 : 1) || a.totalMinor - b.totalMinor || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Hotels: the cheapest room first, then by hotel id. */
const byCheapest = (a, b) => a.options[0].totalMinor - b.options[0].totalMinor || (a.hotelId < b.hotelId ? -1 : a.hotelId > b.hotelId ? 1 : 0);

/**
 * Price lines for one rate (§3.4), totalling the supplier's total plus any fee paid at the hotel.
 * @param {object} rate a LiteAPI rate
 * @param {number} nights
 * @param {{ amount: unknown, currency: unknown }|null} [total] the total to use (prebook's `price`), else the rate's
 * @returns {{ skip?: string, lines?: object[], currency?: string, supplierTotal?: number, rounded?: boolean }}
 */
function rateLines(rate, nights, total = null) {
  const rr = rate && rate.retailRate && typeof rate.retailRate === 'object' ? rate.retailRate : null;
  const t = total || (rr && Array.isArray(rr.total) ? rr.total[0] : null);
  const currency = t && typeof t.currency === 'string' ? t.currency : null;
  const sum = t ? parseMinor(t.amount, currency) : null;
  if (!sum || !rr) return { skip: 'malformed' };
  const items = rr.taxesAndFees == null ? [] : rr.taxesAndFees;
  if (!Array.isArray(items)) return { skip: 'malformed' };
  let rounded = sum.rounded;
  const included = [], fees = [];
  let foreignIncluded = false;
  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof item.included !== 'boolean') return { skip: 'malformed' };
    const same = item.currency === currency;
    if (item.included) {
      if (!same) { foreignIncluded = true; continue; }
      const a = parseMinor(item.amount, currency);
      if (!a) return { skip: 'malformed' };
      rounded = rounded || a.rounded;
      if (a.minor > 0) included.push({ label: cleanText(item.description, 60) || 'Taxes and fees', amount: a.minor });
    } else {
      if (!same) return { skip: 'feeOtherCurrency' };
      const a = parseMinor(item.amount, currency);
      if (!a) return { skip: 'malformed' };
      rounded = rounded || a.rounded;
      if (a.minor > 0) fees.push({ label: `${cleanText(item.description, 60) || 'Fees'}, paid at the hotel`, amount: a.minor });
    }
  }
  const taxes = included.reduce((n, x) => n + x.amount, 0);
  const lines = [];
  if (foreignIncluded || !included.length || taxes > sum.minor) {
    lines.push({ code: 'room', label: 'Room total including taxes', kind: 'base', amount: sum.minor });
  } else {
    lines.push({ code: 'room', label: `Room, ${plural(nights, 'night')}`, kind: 'base', amount: sum.minor - taxes });
    included.forEach((x, i) => lines.push({ code: `tax_${i + 1}`, label: x.label, kind: 'tax', amount: x.amount }));
  }
  fees.forEach((x, i) => lines.push({ code: `hotel_fee_${i + 1}`, label: x.label, kind: 'fee', amount: x.amount }));
  return { lines, currency, supplierTotal: sum.minor, rounded };
}

class LiteApiHotels {
  /**
   * @param {{ apiKey: string, mode: 'sandbox'|'live', http: { call: Function, warn: Function, info: Function },
   *   now: () => Date, state: { latched: object, latch: Function }, cacheSeconds?: number,
   *   guestNationality?: string, cityZone?: (city: string, country: string) => string|null, timeouts?: object }} opts
   */
  constructor({ apiKey, mode, http, now, state, cacheSeconds = 300, guestNationality = 'US', cityZone = () => null, timeouts = {} }) {
    if (mode !== 'sandbox' && mode !== 'live') throw new TypeError('[suppliers] LiteApiHotels needs a mode');
    this.name = 'LiteApiHotels';
    this.vertical = 'hotels';
    this.isDemo = true;
    this.mode = mode;
    this.prefix = offerPrefix('hotel', mode);
    this.http = http;
    this.now = now;
    this.state = state;
    this.cacheMs = Math.max(0, cacheSeconds) * 1000;
    this.nationality = guestNationality;
    this.cityZone = cityZone;
    this.timeouts = { ...TIMEOUTS, ...timeouts };
    this.cache = new SupplierCache({ now, maxEntries: 500, maxPerCompany: 20, maxBytes: 32 * MB });
    /** @type {WeakMap<object, object>} a provider Offer handed out → the normalised hotel behind it */
    this.internal = new WeakMap();
    // The key lives only in this closure, and only ever goes into the X-API-Key header.
    const key = apiKey;
    this._headers = () => ({
      'X-API-Key': key,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'Content-Type': 'application/json',
      'x-client-correlation-id': crypto.randomUUID(),
    });
    Object.defineProperty(this, '_headers', { enumerable: false });
  }

  // -------------------------------------------------------------------------------------------------------
  // The provider contract

  /**
   * @param {import('../types').BusinessHotelQuery} pq
   * @returns {Promise<object[]>}
   */
  async search(pq) {
    return (await this.searchDetailed(pq)).offers;
  }

  /**
   * @param {import('../types').BusinessHotelQuery} pq
   * @returns {Promise<{ offers: object[], skipped: object, truncated: boolean }>}
   */
  async searchDetailed(pq) {
    this._alive();
    const q = this._query(pq);
    if (!q.countryCode) {
      this.http.warn('[suppliers] liteapi: a hotel search for a country with no ISO code was not sent');
      return { offers: [], skipped: {}, truncated: false };
    }
    const org = company(), key = this._key(q);
    const entry = this.cache.get(org, key) || await this._rates(q, org, key, null);
    return { offers: entry.hotels.map(h => this._offer(h)), skipped: { ...entry.skipped }, truncated: entry.truncated };
  }

  /**
   * One hotel, priced as pq.check allows (see the header).
   * @param {string} offerId
   * @param {import('../types').BusinessHotelQuery} pq
   * @returns {Promise<object|null>} null for another namespace (no call) or a hotel with no rates now
   * @throws {AppError} 503 live_check_skipped (peek), 503 supplier_unavailable, 429 supplier_busy
   */
  async getOffer(offerId, pq) {
    if (!this._mine(offerId)) return null;
    this._alive();
    const q = this._query(pq);
    const hotelId = offerId.slice(this.prefix.length);
    const check = CHECKS.includes(pq && pq.check) ? pq.check : 'auto';
    const org = company();
    if (!q.countryCode && check !== 'peek') return null;
    if (check === 'auto' || check === 'peek') {
      for (const key of [this._key(q), this._key(q, hotelId)]) {
        const hit = this.cache.get(org, key);
        const h = hit ? hit.hotels.find(x => x.hotelId === hotelId) : null;
        if (h) return this._offer(h);
        if (hit && key.endsWith(`|h:${hotelId}`)) return null;
      }
      if (check === 'peek') throw supplierError('live_check_skipped');
    }
    const entry = await this._rates(q, org, this._key(q, hotelId), hotelId);
    const h = entry.hotels.find(x => x.hotelId === hotelId);
    return h ? this._offer(h) : null;
  }

  /**
   * The quote for one room. For pq.check 'final' it prebooks (see the header); otherwise it reads the rates
   * answer the offer came from.
   * @param {{ offerId: string, optionId: string, query: object, offer?: object }} input
   * @returns {Promise<object>} a SupplierQuote
   * @throws {AppError} 404 when the hotel or room is gone; 409 option_sold_out; 503 supplier_unavailable
   */
  async quote({ offerId, optionId, query, offer = null }) {
    let h = offer ? this.internal.get(offer) : null;
    if (!h || h.offerId !== offerId) {
      const o = await this.getOffer(offerId, query);
      h = o ? this.internal.get(o) : null;
    }
    if (!h) throw new AppError('offer_not_found', 'This hotel is no longer available for your dates.', 404);
    const opt = h.options.find(o => o.id === optionId);
    if (!opt) throw new AppError('option_not_found', 'That room is no longer offered.', 404);
    if (query && query.check === 'final') return this._prebookQuote(h, opt, this._query(query));
    return this._quoteOf(h, opt);
  }

  async book() { throw new AppError('booking_not_open', 'Booking is not open yet.', 409); }

  async cancel() { throw new AppError('booking_not_open', 'Booking is not open yet.', 409); }

  // -------------------------------------------------------------------------------------------------------
  // Checks and keys

  _mine(offerId) {
    return typeof offerId === 'string' && offerId.startsWith(this.prefix) && sourceOf(offerId) === this.mode
      && ids.hotelOfferId(this.mode, offerId.slice(this.prefix.length)) === offerId;
  }

  _alive() {
    if (this.state && this.state.latched.liteapi) throw supplierError('supplier_unavailable', { vertical: 'hotels' });
  }

  _query(pq) {
    const q = pq || {};
    if (typeof q.where !== 'string' || !q.where.trim() || !DATE_RE.test(q.checkIn || '') || !DATE_RE.test(q.checkOut || '')) {
      throw new TypeError('[suppliers] a hotel query needs where, checkIn and checkOut');
    }
    const nights = dayIndex(q.checkOut) - dayIndex(q.checkIn);
    if (!(nights >= 1)) throw new TypeError('[suppliers] a hotel stay needs at least one night');
    const country = typeof q.country === 'string' ? q.country : '';
    return { where: q.where.trim(), country, countryCode: iso2(country), checkIn: q.checkIn, checkOut: q.checkOut, nights };
  }

  _key(q, hotelId = null) {
    const parts = ['liteapi', this.mode, q.where, q.countryCode || '', q.checkIn, q.checkOut, 1, 'USD', this.nationality];
    if (hotelId) parts.push(`h:${hotelId}`);
    return parts.join('|');
  }

  _mismatch() {
    this.state.latch('liteapi');
    return supplierError('supplier_unavailable', { vertical: 'hotels' });
  }

  // -------------------------------------------------------------------------------------------------------
  // Rates

  /**
   * One rates call (the city, or one hotel), single-flight per company and key, stored for the cache setting.
   * @returns {Promise<{ hotels: object[], skipped: object, truncated: boolean }>}
   */
  _rates(q, org, key, hotelId) {
    return this.cache.once(org, key, async () => {
      const body = {
        ...(hotelId ? { hotelIds: [hotelId] } : { cityName: q.where, countryCode: q.countryCode }),
        checkin: q.checkIn,
        checkout: q.checkOut,
        occupancies: [{ adults: 1 }],
        currency: 'USD',
        guestNationality: this.nationality,
        timeout: SUPPLIER_TIMEOUTS.rates,
        ...(hotelId ? {} : { limit: HOTEL_LIMIT, sort: [{ field: 'price', direction: 'ascending' }], maxRatesPerHotel: RATES_PER_HOTEL }),
        includeHotelData: true,
        roomMapping: true,
      };
      const res = await this.http.call({
        supplier: 'liteapi', op: hotelId ? 'rates_hotel' : 'rates', vertical: 'hotels', method: 'POST',
        url: `${API}/hotels/rates`,
        headers: this._headers(),
        body: JSON.stringify(body),
        timeoutMs: this.timeouts.rates,
        maxAttempts: 2,
        // One retry (§4.2): a connection error, any 5xx (4291 included), a 429 (codes 429 and 4290), 4011.
        retry: o => o.kind === 'network' || (o.kind === 'response' && (o.status >= 500 || o.status === 429 || liteCode(o.json) === 4011)),
      });
      const entry = this._answer(res, q);
      if (this.cacheMs > 0) this.cache.set(org, key, entry, this.cacheMs);
      if (hotelId) this._refreshCity(org, q, hotelId, entry);
      return entry;
    });
  }

  /**
   * A price check's fresh rates for one hotel replace what the cached city search holds for it (§4.4), so
   * auto and peek, the search pages and the variants never serve an older price than one already seen: each
   * room the city search showed takes its fresh price and terms, a room the fresh answer no longer has is
   * dropped, and the hotel goes when none is left. The city entry keeps its own expiry.
   */
  _refreshCity(org, q, hotelId, entry) {
    const key = this._key(q);
    const city = this.cache.get(org, key);
    if (!city || !city.hotels.some(x => x.hotelId === hotelId)) return;
    const fresh = entry.hotels.find(x => x.hotelId === hotelId) || null;
    const byId = new Map((fresh ? fresh.options : []).map(o => [o.id, o]));
    const hotels = [];
    for (const old of city.hotels) {
      if (old.hotelId !== hotelId) { hotels.push(old); continue; }
      const options = old.options.filter(o => byId.has(o.id)).map(o => byId.get(o.id)).sort(byPrice);
      if (options.length) hotels.push({ ...old, options, answeredAt: fresh.answeredAt });
    }
    hotels.sort(byCheapest);
    this.cache.set(org, key, { ...city, hotels }, this.cache.expiresIn(org, key));
  }

  /** A rates answer as a cache entry, after the mode check (§2.1). */
  _answer(res, q) {
    const json = res.json && typeof res.json === 'object' ? res.json : null;
    if (res.status === 200 && json && liteCode(json) === 2001) return { hotels: [], skipped: {}, truncated: false };
    if (res.status !== 200 || !json) {
      if (res.status === 401 || res.status === 403) this.http.warn('[suppliers] LiteAPI refused the API key');
      throw supplierError('supplier_unavailable', { vertical: 'hotels' });
    }
    if (json.sandbox !== (this.mode !== 'live')) throw this._mismatch();
    if (!Array.isArray(json.data)) throw supplierError('supplier_unavailable', { vertical: 'hotels' });
    return this._normalizeAll(json, q, res.answeredAt);
  }

  _normalizeAll(json, q, answeredAt) {
    const skipped = {};
    const count = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
    const byId = new Map();
    for (const h of Array.isArray(json.hotels) ? json.hotels : []) {
      if (h && typeof h === 'object' && typeof h.id === 'string') byId.set(h.id, h);
    }
    const zone = this._zone(q);
    let unreadable = 0, rounded = 0;
    const all = [];
    const hotels = new Map();
    for (const d of json.data) {
      const offerId = d && ids.hotelOfferId(this.mode, d.hotelId);
      if (!offerId) { unreadable += 1; continue; }
      const info = byId.get(d.hotelId);
      const name = info ? cleanText(info.name, 120) : '';
      if (!name) { count('noHotelData'); continue; }
      if (!hotels.has(d.hotelId)) hotels.set(d.hotelId, this._hotel(d.hotelId, offerId, info, name, q, answeredAt));
      for (const rt of Array.isArray(d.roomTypes) ? d.roomTypes : []) {
        const o = this._option(rt, q, zone);
        if (o.skip) {
          if (o.skip === 'feeOtherCurrency') count('feeOtherCurrency');
          else unreadable += 1;
          continue;
        }
        if (o.rounded) rounded += 1;
        all.push({ hotelId: d.hotelId, option: o.option });
      }
    }
    if (rounded) this.http.warn(`[suppliers] liteapi: ${rounded} amounts had more digits than their currency and were rounded half-up`);
    if (unreadable) this.http.warn(`[suppliers] liteapi: ${unreadable} rates could not be read and were left out`);
    const keyOf = x => `${x.hotelId}|${x.option.id}`;
    const foreign = x => (x.option.currency === 'USD' ? 0 : 1);
    all.sort((a, b) => foreign(a) - foreign(b) || a.option.totalMinor - b.option.totalMinor || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    const truncated = all.length > MAX_OPTIONS;
    for (const x of all.slice(0, MAX_OPTIONS)) {
      const h = hotels.get(x.hotelId);
      if (h.options.some(o => o.id === x.option.id)) { count('duplicateOption'); continue; }
      h.options.push(x.option);
    }
    const list = [...hotels.values()].filter(h => h.options.length).sort(byCheapest);
    return { hotels: list, skipped, truncated };
  }

  _hotel(hotelId, offerId, info, name, q, answeredAt) {
    const s = Number(info.stars);
    const stars = Number.isFinite(s) && s > 0 && s <= 7 ? Math.round(s * 2) / 2 : 0;
    const address = cleanText(info.address, 120);
    const city = cleanText(info.city_name, 80);
    let area = address;
    if (city && city.toLowerCase() !== q.where.toLowerCase() && !address.toLowerCase().includes(city.toLowerCase())) {
      area = address ? `${address}, ${city}` : city;
    }
    return {
      hotelId, offerId, name, stars, area: area.slice(0, 120),
      city: q.where, country: q.country, checkIn: q.checkIn, checkOut: q.checkOut, nights: q.nights,
      answeredAt, options: [],
    };
  }

  /**
   * One room type as an option (or { skip }).
   * @returns {{ skip?: string, option?: object, rounded?: boolean }}
   */
  _option(rt, q, zone, total = null) {
    if (!rt || typeof rt !== 'object') return { skip: 'malformed' };
    const rates = Array.isArray(rt.rates) ? rt.rates : [];
    const rate = rates.find(r => r && r.occupancyNumber === 1) || rates[0];
    if (!rate || typeof rate !== 'object') return { skip: 'malformed' };
    const priced = rateLines(rate, q.nights, total);
    if (priced.skip) return { skip: priced.skip };
    const rateName = cleanText(rate.name, 80) || 'Room';
    const board = cleanText(rate.boardName, 40);
    const cp = rate.cancellationPolicies && typeof rate.cancellationPolicies === 'object' ? rate.cancellationPolicies : {};
    const refundableTag = cp.refundableTag === 'RFN' ? 'RFN' : 'NRFN';
    const totalMinor = priced.lines.reduce((n, l) => n + l.amount, 0);
    const sleeps = Number.isSafeInteger(rate.maxOccupancy) && rate.maxOccupancy >= 1 ? Math.min(rate.maxOccupancy, 20) : 1;
    return {
      rounded: priced.rounded,
      option: {
        id: ids.hotelOptionId({ rateName: rate.name, boardType: rate.boardType, refundable: refundableTag === 'RFN' }),
        name: board ? `${rateName}, ${board}` : rateName,
        rateName,
        board: { type: cleanText(rate.boardType, 8), name: board },
        sleeps,
        totalMinor,
        currency: priced.currency,
        lines: priced.lines,
        cancellation: this._cancellation(cp, refundableTag, priced.supplierTotal, priced.currency, q, zone),
        ref: typeof rt.offerId === 'string' ? rt.offerId : '',
      },
    };
  }

  _zone(q) {
    const z = this.cityZone(q.where, q.country);
    return typeof z === 'string' && tz.isTimeZone(z) ? z : 'UTC';
  }

  /** The provider cancellation of one rate (§3.3). */
  _cancellation(cp, tag, supplierTotal, currency, q, zone) {
    if (tag !== 'RFN') return { type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: TERMS.hotelNonRefundable };
    const noDeadline = { type: 'free', freeUntilHours: 0, penaltyPercent: 100, summary: TERMS.hotelNoDeadline };
    const penalties = [];
    for (const info of Array.isArray(cp.cancelPolicyInfos) ? cp.cancelPolicyInfos : []) {
      if (!info || typeof info !== 'object') continue;
      const amount = typeof info.amount === 'number' || typeof info.amount === 'string' ? Number(info.amount) : NaN;
      if (!(amount > 0)) continue;
      const m = CANCEL_TIME_RE.exec(String(info.cancelTime || ''));
      const zoneName = typeof info.timezone === 'string' && info.timezone.trim() ? info.timezone.trim() : null;
      if (!m || !zoneName || !tz.isTimeZone(zoneName)) return noDeadline;
      let at;
      try { at = tz.localToUtc(zoneName, `${m[1]}T${m[2]}:${m[3]}`).getTime(); } catch { return noDeadline; }
      penalties.push({ at, shown: `${m[1]} ${m[2]}:${m[3]} ${zoneName}`, info });
    }
    if (!penalties.length) return noDeadline;
    penalties.sort((a, b) => a.at - b.at);
    const first = penalties[0];
    const p = first.info.currency === currency ? parseMinor(first.info.amount, currency) : null;
    const penaltyPercent = p && supplierTotal > 0 ? Math.min(100, Math.ceil((p.minor * 100) / supplierTotal)) : 100;
    const below = penaltyPercent < 100;
    const fee = p ? `${formatMinor(p.minor, currency)} ${currency}` : null;
    if (first.at <= this.now().getTime()) {
      return {
        type: below ? 'partial' : 'non_refundable', freeUntilHours: 0, penaltyPercent,
        summary: `The free cancellation deadline (${first.shown}, the supplier's time) has passed.${fee ? ` Cancelling now costs ${fee}.` : ''}`,
      };
    }
    let checkInAt;
    try { checkInAt = tz.localToUtc(zone, `${q.checkIn}T00:00`).getTime(); } catch { return noDeadline; }
    const hours = Math.max(0, Math.floor((checkInAt - first.at) / 3600000));
    return {
      type: below ? 'partial' : 'free', freeUntilHours: hours, penaltyPercent,
      summary: `Free cancellation until ${first.shown} (the supplier's time).${fee ? ` After that, cancelling costs ${fee}.` : ''}`,
    };
  }

  /** A provider Offer for one hotel: a fresh object every time. */
  _offer(h) {
    const cheapest = h.options[0];
    const perNight = o => Math.round(o.totalMinor / h.nights);
    const offer = {
      id: h.offerId,
      vertical: 'hotels',
      provider: this.name,
      demo: this.mode !== 'live',
      title: h.name,
      location: { name: h.area || h.name, area: h.area, city: h.city, country: h.country },
      media: [],
      fromPrice: { amount: perNight(cheapest), currency: cheapest.currency, unit: 'night' },
      options: h.options.map(o => ({
        id: o.id, name: o.name, price: { amount: perNight(o), currency: o.currency }, capacity: o.sleeps, bed: '', available: true,
      })),
      cancellation: { ...OFFER_CANCELLATION },
      details: {
        stars: h.stars, nights: h.nights, checkIn: h.checkIn, checkOut: h.checkOut, amenities: [], answeredAt: h.answeredAt,
      },
    };
    this.internal.set(offer, h);
    return offer;
  }

  _quoteOf(h, opt) {
    const g = { ...h, options: [opt] };
    const pub = this._offer(g);
    return {
      offer: pub,
      option: pub.options[0],
      lines: opt.lines.map(l => ({ ...l })),
      currency: opt.currency,
      startDate: h.checkIn,
      cancellation: { ...opt.cancellation },
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Prebook (decide only)

  async _prebookQuote(h, opt, q) {
    const soldOut = () => new AppError('option_sold_out', 'This room is no longer available.', 409);
    let got = await this._prebook(opt.ref);
    if (got.stale) {
      // L-ERRW: after 2001 (and 4040, 4020), always search again before prebooking a fresh offer.
      const org = company();
      const entry = await this._rates(q, org, this._key(q, h.hotelId), h.hotelId);
      const again = entry.hotels.find(x => x.hotelId === h.hotelId);
      const fresh = again ? again.options.find(o => o.id === opt.id) : null;
      if (!fresh || !fresh.ref) throw soldOut();
      got = await this._prebook(fresh.ref);
      if (got.stale) throw soldOut();
    }
    const data = got.data;
    const rt = Array.isArray(data.roomTypes) ? data.roomTypes[0] : null;
    if (typeof data.hotelId === 'string' && data.hotelId !== h.hotelId) throw supplierError('supplier_unavailable', { vertical: 'hotels' });
    const price = { amount: data.price, currency: typeof data.currency === 'string' ? data.currency : opt.currency };
    const o = this._option(rt && typeof rt === 'object' ? { ...rt, offerId: opt.ref } : null, q, this._zone(q), price);
    if (o.skip) throw soldOut();
    // The prebooked room is the same option (its id names what was selected); its terms and price are new.
    // A meal plan the supplier changed (L-PRE `boardChanged`, or a board that differs from the selected one) is
    // a change of terms: the room's name and its terms text say the new plan, and the terms text is what the
    // price check compares (recheck.terms()), so a decision sees `changed`, never `same`, at the same price.
    const now = o.option;
    const differs = (a, b) => Boolean(a) && Boolean(b) && a.toLowerCase() !== b.toLowerCase();
    const boardMoved = data.boardChanged === true || differs(now.board.type, opt.board.type) || differs(now.board.name, opt.board.name);
    if (!boardMoved) return this._quoteOf(h, { ...now, id: opt.id, name: opt.name, sleeps: opt.sleeps });
    const plan = now.board.name || now.board.type;
    const said = plan ? `The supplier changed the meal plan to ${plan}.` : 'The supplier changed the meal plan.';
    return this._quoteOf(h, {
      ...now, id: opt.id, sleeps: opt.sleeps,
      name: plan ? `${opt.rateName}, ${plan}` : opt.name,
      cancellation: { ...now.cancellation, summary: `${now.cancellation.summary} ${said}` },
    });
  }

  /**
   * One prebook (plus the 4016 retry with a longer timeout).
   * @returns {Promise<{ data?: object, stale?: boolean }>}
   * @throws {AppError} 503 supplier_unavailable
   */
  async _prebook(supplierOfferId) {
    const unavailable = () => supplierError('supplier_unavailable', { vertical: 'hotels' });
    if (typeof supplierOfferId !== 'string' || !supplierOfferId) throw unavailable();
    const send = (supplierTimeout, timeoutMs, countCompany) => this.http.call({
      supplier: 'liteapi', op: 'prebook', vertical: 'hotels', method: 'POST',
      url: `${BOOK_API}/rates/prebook?timeout=${supplierTimeout}`,
      headers: this._headers(),
      body: JSON.stringify({ offerId: supplierOfferId, usePaymentSdk: false }),
      timeoutMs,
      maxAttempts: 2,
      countCompany,
      // 5000 and the rate-limit answers once more; never 2001, 4040, 4020 (search again instead), 4002 or a
      // connection error (a prebook may have been made).
      retry: o => o.kind === 'response' && (liteCode(o.json) === 5000 || o.status === 429 || liteCode(o.json) === 4291),
    });
    let res = await send(SUPPLIER_TIMEOUTS.prebook, this.timeouts.prebook, true);
    if (liteCode(res.json) === 4016) res = await send(SUPPLIER_TIMEOUTS.prebookLong, this.timeouts.prebookLong, false);
    const code = liteCode(res.json);
    if (res.status === 200 && res.json && res.json.data && typeof res.json.data === 'object' && code === null) return { data: res.json.data };
    if (STALE_CODES.includes(code)) return { stale: true };
    if (res.status === 401 || res.status === 403) this.http.warn('[suppliers] LiteAPI refused the API key');
    throw unavailable();
  }
}

module.exports = { LiteApiHotels, rateLines, liteCode, cleanText, API, BOOK_API, TIMEOUTS, HOTEL_LIMIT, MAX_OPTIONS };
