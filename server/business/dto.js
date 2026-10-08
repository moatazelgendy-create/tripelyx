// What a company may see of a flight or a hotel option: allow-list rows built field by field, never spread
// (plan §F5; the 1B extraKeys/assertClientOption pattern). Stripped for good: remaining, provider, rating and
// review counts, media, badges, supplierQuoteRef, description, attributes, details.distanceKm, and anything
// net* or internal. Policy and ranking only ever see these rows, so they never see a cost or a markup.
// STUB from Stage 0: the key schemas and the key pattern below are FINAL; Stage 1I builds the functions.

function notBuilt() { throw new Error('[business] not built'); }

/** A row key in a form or a Selection: 'f.flt_…|LIGHT' or 'h.htl_…|STU-SEA'. */
const ROW_KEY_RE = /^[fh]\.(flt|htl)_[A-Za-z0-9_.-]{1,160}\|[A-Za-z0-9_-]{1,40}$/;

const LINE = Object.freeze({ label: true, kind: true, cents: true });
const PLACE = Object.freeze({ code: true, city: true });

/**
 * The deep schema of a FlightRow: `true` is a scalar (or null), an object lists its allowed keys, an array
 * of one schema is a list of those. Every key a row carries must appear here, at every level, and every
 * key here is always present.
 */
const FLIGHT_ROW_KEYS = Object.freeze({
  key: true, kind: true, leg: true, offerId: true, optionId: true,
  carrier: Object.freeze({ code: true, name: true }),
  flightNumbers: Object.freeze([true]),
  segments: Object.freeze([Object.freeze({
    carrier: Object.freeze({ code: true, name: true }), flightNumber: true, from: PLACE, to: PLACE,
    departLocal: true, arriveLocal: true, arriveDayOffset: true, durationMinutes: true,
  })]),
  stops: true, via: Object.freeze([PLACE]), flyingMinutes: true, elapsedMinutes: true,
  cabin: true, cabinLabel: true,
  fare: Object.freeze({ code: true, name: true, cabinKg: true, checkedBags: true, checkedKg: true, changeable: true, refundablePercent: true, terms: true }),
  lines: Object.freeze([LINE]), totalCents: true, currency: true, available: true, demo: true, pricedAt: true,
});

/** The deep schema of a HotelRow (same notation). */
const HOTEL_ROW_KEYS = Object.freeze({
  key: true, kind: true, offerId: true, optionId: true, name: true, stars: true, area: true, city: true, country: true,
  room: Object.freeze({ name: true, sleeps: true, bed: true }),
  checkIn: true, checkOut: true, nights: true, nightlyCents: true, nightlyInclCents: true,
  lines: Object.freeze([LINE]), totalCents: true, currency: true,
  cancellation: Object.freeze({ refundable: true, freeUntilHours: true, text: true }),
  amenities: Object.freeze([true]), available: true, demo: true, pricedAt: true,
});

/**
 * Keys of `value` that its schema does not allow, as dotted paths ("segments[1].supplier").
 * @param {unknown} value
 * @param {object|true|Array} schema FLIGHT_ROW_KEYS, HOTEL_ROW_KEYS or a part of one
 * @returns {string[]}
 */
function extraKeys(value, schema) { notBuilt(); }

/**
 * Throws unless `row` fits its schema exactly (no extra key, no missing key, at every level) and every
 * number is finite (null only where the typedef allows it: an unavailable row's prices).
 * @param {import('./types').Row} row
 * @returns {import('./types').Row} the same row
 * @throws {Error} '[business] … may not carry …' (a programming error, never shown)
 */
function assertRow(row) { notBuilt(); }

/**
 * The FlightRow for one fare of one itinerary, from a provider offer and (when available) its quote.
 * @param {object} offer a validated provider Offer (vertical flights)
 * @param {object} option one of offer.options
 * @param {object|null} quote provider.quote(...) for it; null when the option is unavailable (row has no price)
 * @param {{ leg: 'out'|'back', pricedAt: string }} opts
 * @returns {import('./types').FlightRow}
 */
function flightRow(offer, option, quote, opts) { notBuilt(); }

/**
 * The HotelRow for one room of one hotel.
 * @param {object} offer a validated provider Offer (vertical hotels)
 * @param {object} option one of offer.options
 * @param {object|null} quote null when the room is unavailable
 * @param {{ pricedAt: string }} opts
 * @returns {import('./types').HotelRow}
 */
function hotelRow(offer, option, quote, opts) { notBuilt(); }

/**
 * Split a row key ('f.<offerId>|<optionId>').
 * @param {unknown} key
 * @returns {{ kind: 'flight'|'hotel', offerId: string, optionId: string }|null} null unless it matches ROW_KEY_RE
 *   with 'f.' on a flt_ offer or 'h.' on an htl_ offer
 */
function parseRowKey(key) { notBuilt(); }

/**
 * Build a row key.
 * @param {'flight'|'hotel'} kind
 * @param {string} offerId
 * @param {string} optionId
 * @returns {string}
 */
function rowKey(kind, offerId, optionId) { notBuilt(); }

module.exports = { ROW_KEY_RE, FLIGHT_ROW_KEYS, HOTEL_ROW_KEYS, extraKeys, assertRow, flightRow, hotelRow, parseRowKey, rowKey };
