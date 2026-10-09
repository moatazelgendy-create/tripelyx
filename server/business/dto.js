// What a company may see of a flight or a hotel option: allow-list rows built field by field, never spread
// (plan §F5; the 1B extraKeys/assertClientOption pattern). Stripped for good: remaining, provider, rating and
// review counts, media, badges, supplierQuoteRef, description, attributes, details.distanceKm, and anything
// net* or internal. Policy and ranking only ever see these rows, so they never see a cost or a markup.
// The key schemas and the key pattern are FINAL (Stage 0). Every row the composer returns has passed assertRow.
//
// Where each field comes from (a provider Offer, one of its options and, when the option prices, its quote):
//   flight: segments from offer.details.segments (local departAt/arriveAt, arriveDayOffset), elapsedMinutes
//     from offer.details.elapsedMinutes (UTC; computed from the local times only for a provider that lacks
//     it), the fare's bags, changeability and refund share from offer.details.fareFamilies (else the quote's
//     baggage and cancellation), its terms from the quote's cancellation summary;
//   hotel: name, stars, area, city and country from the offer, the room from the option (bed from option.bed),
//     nightlyCents = the base lines / nights, nightlyInclCents = Math.round(total / nights), cancellation from
//     the quote (refundable = 'free' or 'partial' with freeUntilHours > 0), at most 4 amenities;
//   both: lines = the quote's lines ({ label, kind, cents }), totalCents = their sum, pricedAt from the caller.
// An option with no quote (unavailable) has available:false, lines [], totalCents null (and, for a hotel,
// nightlyCents and nightlyInclCents null): no price is ever shown for it.
//
// Real suppliers (real-suppliers design §2.2, §3.2, §3.4, §8.6):
// - `demo` comes from offer.demo (true for demo and supplier test data, false only for a live price), and
//   assertRow requires row.demo === (source.sourceOf(row) !== 'live'): the offer id's namespace decides.
// - A flight's `carrier` is the airline selling the fare (offer.details.owner) when the offer names one, and
//   `via` lists every stop in travel order (offer.details.via: connections and stops inside a segment) when it
//   gives them; demo offers have neither, so demo rows are unchanged.
// - Supplier hotel rows: a line of kind 'fee' is always paid at the hotel, and it is counted in totalCents, so a
//   policy cap sees the whole cost of the stay.

const { CABIN_LABELS } = require('./constants');
const { sourceOf } = require('./source');

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
 * Keys of `value` that its schema does not allow, as dotted paths ("segments[1].supplier"). A scalar slot
 * holding an object or a list, or a list or object slot holding the wrong thing, is reported at its own path.
 * @param {unknown} value
 * @param {object|true|Array} schema FLIGHT_ROW_KEYS, HOTEL_ROW_KEYS or a part of one
 * @param {string} [path] internal: where `value` sits
 * @returns {string[]}
 */
function extraKeys(value, schema, path = '') {
  const here = path || '(root)';
  if (value === null || value === undefined) return [];
  if (schema === true) return typeof value === 'object' ? [here] : [];
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return [here];
    return value.flatMap((x, i) => extraKeys(x, schema[0], `${path}[${i}]`));
  }
  if (typeof value !== 'object' || Array.isArray(value)) return [here];
  return Object.keys(value).flatMap(k => (Object.prototype.hasOwnProperty.call(schema, k)
    ? extraKeys(value[k], schema[k], path ? `${path}.${k}` : k)
    : [path ? `${path}.${k}` : k]));
}

/** Paths the schema requires that `value` lacks, or holds with the wrong shape (null only where `nullable` says). */
function shapeProblems(value, schema, path, nullable, out) {
  if (schema === true) {
    if (value === undefined) out.push(`${path} is missing`);
    else if (value === null) { if (!nullable.has(path)) out.push(`${path} is null`); }
    else if (typeof value === 'number') { if (!Number.isFinite(value)) out.push(`${path} is not a finite number`); }
    else if (typeof value !== 'string' && typeof value !== 'boolean') out.push(`${path} is not a plain value`);
    return out;
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) out.push(`${path} is not a list`);
    else value.forEach((x, i) => shapeProblems(x, schema[0], `${path}[${i}]`, nullable, out));
    return out;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    out.push(`${path} is not an object`);
    return out;
  }
  for (const k of Object.keys(schema)) shapeProblems(value[k], schema[k], path ? `${path}.${k}` : k, nullable, out);
  return out;
}

/**
 * Throws unless `row` fits its schema exactly (no extra key, no missing key, at every level) and every
 * number is finite (null only where the typedef allows it: an unavailable row's prices).
 * @param {import('./types').Row} row
 * @returns {import('./types').Row} the same row
 * @throws {Error} '[business] … may not carry …' (a programming error, never shown)
 */
function assertRow(row) {
  const kind = row && row.kind;
  const schema = kind === 'flight' ? FLIGHT_ROW_KEYS : kind === 'hotel' ? HOTEL_ROW_KEYS : null;
  if (!schema) throw new Error('[business] a row must be a flight or a hotel');
  const extra = extraKeys(row, schema);
  if (extra.length) throw new Error(`[business] a ${kind} row may not carry ${extra.join(', ')}`);
  const nullable = new Set(row.available === false ? (kind === 'hotel' ? ['totalCents', 'nightlyCents', 'nightlyInclCents'] : ['totalCents']) : []);
  const problems = shapeProblems(row, schema, '', nullable, []);
  if (typeof row.available !== 'boolean') problems.push('available is not true or false');
  const demo = sourceOf(row) !== 'live';
  if (row.demo !== demo) problems.push(`demo is not ${demo}`);
  if (typeof row.key !== 'string' || !ROW_KEY_RE.test(row.key) || row.key !== rowKey(kind, row.offerId, row.optionId)) problems.push('key does not match the offer and option');
  if (kind === 'flight' && row.leg !== 'out' && row.leg !== 'back') problems.push('leg is not out or back');
  if (Array.isArray(row.lines)) {
    if (row.available) {
      const sum = row.lines.reduce((n, l) => n + (l && Number.isInteger(l.cents) ? l.cents : NaN), 0);
      if (!row.lines.length || !Number.isInteger(row.totalCents) || row.totalCents !== sum) problems.push('totalCents is not the sum of the lines');
      if (row.totalCents < 0) problems.push('totalCents is below 0');
    } else if (row.lines.length || row.totalCents !== null) {
      problems.push('an unavailable row may not carry a price');
    }
  }
  if (problems.length) throw new Error(`[business] a ${kind} row may not carry these: ${problems.join('; ')}`);
  return row;
}

const dayDiff = (a, b) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000);
const sumCents = lines => lines.reduce((n, l) => n + l.cents, 0);
const rowLines = quote => quote.lines.map(l => ({ label: String(l.label), kind: l.kind, cents: l.amount }));
/** How much of the price a cancellation refunds: none for non_refundable, 100 − penalty for partial, all for free. */
const refundShare = c => (!c || c.type === 'non_refundable' ? 0 : c.type === 'partial' ? 100 - c.penaltyPercent : 100);

/**
 * The FlightRow for one fare of one itinerary, from a provider offer and (when available) its quote.
 * @param {object} offer a validated provider Offer (vertical flights)
 * @param {object} option one of offer.options
 * @param {object|null} quote provider.quote(...) for it; null when the option is unavailable (row has no price)
 * @param {{ leg: 'out'|'back', pricedAt: string }} opts
 * @returns {import('./types').FlightRow}
 */
function flightRow(offer, option, quote, { leg, pricedAt }) {
  const d = offer.details || {};
  const segs = (d.segments || []).map(s => ({
    carrier: { code: s.carrier.code, name: s.carrier.name },
    flightNumber: s.flightNumber,
    from: { code: s.from.code, city: s.from.city },
    to: { code: s.to.code, city: s.to.city },
    departLocal: s.departAt.slice(0, 16),
    arriveLocal: s.arriveAt.slice(0, 16),
    arriveDayOffset: Number.isInteger(s.arriveDayOffset) ? s.arriveDayOffset : dayDiff(s.departAt, s.arriveAt),
    durationMinutes: s.durationMinutes,
  }));
  if (!segs.length) throw new Error(`[business] flight offer ${offer.id} has no segments`);
  const cabin = d.cabin;
  if (!CABIN_LABELS[cabin]) throw new Error(`[business] flight offer ${offer.id} has no known cabin`);
  const first = segs[0], last = segs[segs.length - 1];
  const fam = (d.fareFamilies || []).find(f => f.code === option.id) || null;
  const bags = fam || (quote && quote.offer && quote.offer.details && quote.offer.details.baggage) || d.baggage || {};
  const priced = Boolean(quote);
  const lines = priced ? rowLines(quote) : [];
  const elapsed = Number.isInteger(d.elapsedMinutes) ? d.elapsedMinutes
    : Math.round((Date.parse(`${last.arriveLocal}:00Z`) - Date.parse(`${first.departLocal}:00Z`)) / 60000);
  const owner = d.owner && typeof d.owner.code === 'string' && typeof d.owner.name === 'string' ? d.owner : first.carrier;
  const via = Array.isArray(d.via) ? d.via : segs.slice(0, -1).map(s => s.to);
  return {
    key: rowKey('flight', offer.id, option.id), kind: 'flight', leg, offerId: offer.id, optionId: option.id,
    carrier: { code: owner.code, name: owner.name },
    flightNumbers: segs.map(s => s.flightNumber),
    segments: segs,
    stops: Number.isInteger(d.stops) ? d.stops : segs.length - 1,
    via: via.map(s => ({ code: s.code, city: s.city })),
    flyingMinutes: segs.reduce((n, s) => n + s.durationMinutes, 0),
    elapsedMinutes: elapsed,
    cabin,
    cabinLabel: CABIN_LABELS[cabin],
    fare: {
      code: option.id,
      name: option.name,
      cabinKg: bags.cabinKg ?? 0,
      checkedBags: bags.checkedBags ?? 0,
      checkedKg: bags.checkedKg ?? 0,
      changeable: fam ? Boolean(fam.changeable) : false,
      refundablePercent: fam && Number.isFinite(fam.refundablePercent) ? fam.refundablePercent : refundShare(priced ? quote.cancellation : null),
      terms: priced ? quote.cancellation.summary : (fam && fam.terms) || offer.cancellation.summary,
    },
    lines,
    totalCents: priced ? sumCents(lines) : null,
    currency: priced ? quote.currency : option.price.currency,
    available: priced,
    demo: offer.demo === true,
    pricedAt,
  };
}

/**
 * The HotelRow for one room of one hotel.
 * @param {object} offer a validated provider Offer (vertical hotels)
 * @param {object} option one of offer.options
 * @param {object|null} quote null when the room is unavailable
 * @param {{ pricedAt: string, checkIn?: string, checkOut?: string }} opts checkIn/checkOut: the stay searched
 *   (optional; else offer.details.checkIn/checkOut, else the quote's startDate plus the nights)
 * @returns {import('./types').HotelRow}
 */
function hotelRow(offer, option, quote, { pricedAt, checkIn = null, checkOut = null }) {
  const d = offer.details || {};
  const nights = d.nights;
  if (!Number.isInteger(nights) || nights < 1) throw new Error(`[business] hotel offer ${offer.id} has no nights`);
  const start = checkIn || d.checkIn || (quote && quote.startDate);
  if (!start) throw new Error(`[business] hotel offer ${offer.id} has no check-in date`);
  const end = checkOut || d.checkOut || new Date(Date.parse(`${start}T00:00:00Z`) + nights * 86400000).toISOString().slice(0, 10);
  const priced = Boolean(quote);
  const lines = priced ? rowLines(quote) : [];
  const total = priced ? sumCents(lines) : null;
  const base = priced ? sumCents(lines.filter(l => l.kind === 'base' || l.kind === 'discount')) : null;
  const c = (priced ? quote.cancellation : offer.cancellation) || { type: 'non_refundable', freeUntilHours: 0, summary: 'Non-refundable.' };
  const loc = offer.location || {};
  return {
    key: rowKey('hotel', offer.id, option.id), kind: 'hotel', offerId: offer.id, optionId: option.id,
    name: offer.title,
    stars: d.stars,
    area: loc.area || '',
    city: loc.city,
    country: loc.country,
    room: { name: option.name, sleeps: Number.isInteger(option.capacity) ? option.capacity : 1, bed: typeof option.bed === 'string' ? option.bed : '' },
    checkIn: start,
    checkOut: end,
    nights,
    nightlyCents: priced ? Math.round(base / nights) : null,
    nightlyInclCents: priced ? Math.round(total / nights) : null,
    lines,
    totalCents: total,
    currency: priced ? quote.currency : option.price.currency,
    cancellation: {
      refundable: (c.type === 'free' || c.type === 'partial') && c.freeUntilHours > 0,
      freeUntilHours: c.type === 'non_refundable' ? 0 : c.freeUntilHours || 0,
      text: c.summary,
    },
    amenities: (d.amenities || []).slice(0, 4).map(String),
    available: priced,
    demo: offer.demo === true,
    pricedAt,
  };
}

/**
 * Split a row key ('f.<offerId>|<optionId>').
 * @param {unknown} key
 * @returns {{ kind: 'flight'|'hotel', offerId: string, optionId: string }|null} null unless it matches ROW_KEY_RE
 *   with 'f.' on a flt_ offer or 'h.' on an htl_ offer
 */
function parseRowKey(key) {
  if (typeof key !== 'string' || !ROW_KEY_RE.test(key)) return null;
  const bar = key.indexOf('|');
  const offerId = key.slice(2, bar), optionId = key.slice(bar + 1);
  const kind = key[0] === 'f' ? 'flight' : 'hotel';
  if ((kind === 'flight') !== offerId.startsWith('flt_')) return null;
  return { kind, offerId, optionId };
}

/**
 * Build a row key.
 * @param {'flight'|'hotel'} kind
 * @param {string} offerId
 * @param {string} optionId
 * @returns {string}
 */
function rowKey(kind, offerId, optionId) {
  if (kind !== 'flight' && kind !== 'hotel') throw new TypeError('[business] a row key is for a flight or a hotel');
  return `${kind === 'flight' ? 'f' : 'h'}.${offerId}|${optionId}`;
}

module.exports = { ROW_KEY_RE, FLIGHT_ROW_KEYS, HOTEL_ROW_KEYS, extraKeys, assertRow, flightRow, hotelRow, parseRowKey, rowKey };
