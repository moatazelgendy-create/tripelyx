// Where a Business price comes from, and the frozen sentences real suppliers write (real-suppliers design §2.2,
// §2.4, §3.2, §8.1). Pure: no store, no clock, no network. Safe to require from anywhere: service modules,
// dto.js, the policy engine, diff.js, views, and business/suppliers/** (design §7.4 lists '../source').
// Built by the lead in step R1-0 and FROZEN for both builders: add to it only through the lead.
//
// Price sources (types.PriceSource), least real first: 'demo' (Tripelyx demo data), 'sandbox' (a supplier's
// test system, round 1), 'live' (a supplier's live system, round 1b). A row's source is read from its offer id:
//   flights  flt_t.<id>  sandbox     flt_l.<id>  live     anything else (flt_ZM429_2026-11-12_economy)  demo
//   hotels   htl_t.<id>  sandbox     htl_l.<id>  live     anything else (htl_CA-NILE)                     demo
// Demo and test-fixture ids (flt_ZM…, flt_fake_…, htl_CA-…, htl_fix_…) never carry a namespace, so they can
// never read as supplier rows. Anything not recognisably sandbox or live reads as 'demo': a mistake can only
// make a price look less real, never more. row.demo means "not a real price": dto.assertRow requires
// row.demo === (sourceOf(row) !== 'live') (Builder A's dto change; today's rule is demo === true).
//
// TERMS are the fare-term sentences a supplier flight row carries in fare.terms (and its quote's
// cancellation.summary): three sentences, refunds, changes, bags, in that order, e.g.
//   "Refunds: not allowed. Changes: allowed for a fee of 50.00 USD set by the airline. Bags: 1 checked bag, 1 carry-on bag."
// suppliers/duffel.js writes them with TERMS.fare(...); diff.js and policy/evaluate.js read them with the
// predicates below (never by parsing the words). Unknown terms say "(NEEDS VERIFICATION)". A fee in another
// currency is printed as the airline gave it, never converted.
const { AppError } = require('../lib/errors');

/** Every price source, least real first. */
const SOURCES = Object.freeze(['demo', 'sandbox', 'live']);
const RANK = Object.freeze({ demo: 0, sandbox: 1, live: 2 });

/** The offer id prefix of each supplier namespace. Demo ids have no namespace. */
const NAMESPACES = Object.freeze({
  flight: Object.freeze({ sandbox: 'flt_t.', live: 'flt_l.' }),
  hotel: Object.freeze({ sandbox: 'htl_t.', live: 'htl_l.' }),
});
const PREFIXES = Object.freeze([
  ['flt_t.', 'sandbox'], ['htl_t.', 'sandbox'], ['flt_l.', 'live'], ['htl_l.', 'live'],
]);

/**
 * Is this one of SOURCES?
 * @param {unknown} value
 * @returns {boolean}
 */
const isSource = value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANK, value);

/**
 * Where a row's price came from, read from the offer id's namespace.
 * @param {unknown} rowOrOfferId a Row (its offerId), an offer id ('flt_t.ZZ1234_20261112T0835_economy') or a
 *   row key ('f.flt_t.…|economy-r0c1')
 * @returns {import('./types').PriceSource} 'demo' for anything not in the sandbox or live namespace (never throws)
 */
function sourceOf(rowOrOfferId) {
  let id = rowOrOfferId;
  if (id && typeof id === 'object') id = id.offerId;
  if (typeof id !== 'string') return 'demo';
  if (/^[fh]\./.test(id)) id = id.slice(2);
  for (const [prefix, source] of PREFIXES) {
    if (id.length > prefix.length && id.startsWith(prefix)) return source;
  }
  return 'demo';
}

/**
 * The offer id prefix a supplier adapter (suppliers/ids.js) puts on its ids.
 * @param {'flight'|'hotel'} kind
 * @param {'sandbox'|'live'} source
 * @returns {string} 'flt_t.', 'flt_l.', 'htl_t.' or 'htl_l.'
 * @throws {TypeError} for any other kind or source ('demo' has no namespace)
 */
function offerPrefix(kind, source) {
  const ns = Object.prototype.hasOwnProperty.call(NAMESPACES, kind) ? NAMESPACES[kind] : null;
  if (!ns || (source !== 'sandbox' && source !== 'live')) throw new TypeError('[business] a supplier namespace is a flight or hotel, sandbox or live');
  return ns[source];
}

/**
 * The least real of some sources: 'demo' if any is demo, else 'sandbox' if any is sandbox, else 'live'.
 * A value that is not a source (undefined on a request stored before real suppliers, null, a typo) counts as 'demo'.
 * @param {Iterable<unknown>} sources
 * @returns {import('./types').PriceSource|null} null when there are none (the caller picks the label, usually
 *   from inventory.source)
 * @throws {TypeError} when sources is not iterable
 */
function leastReal(sources) {
  if (sources == null || typeof sources[Symbol.iterator] !== 'function' || typeof sources === 'string') {
    throw new TypeError('[business] leastReal takes a list of sources');
  }
  let least = null;
  for (const s of sources) {
    const source = isSource(s) ? s : 'demo';
    if (least === null || RANK[source] < RANK[least]) least = source;
  }
  return least;
}

/**
 * A request's source: its stored `source` and every one of its rows, the least real of them. A request stored
 * before real suppliers has no `source` and reads as 'demo'. request.demo is requestSource(request) !== 'live'.
 * @param {import('./types').Request|null|undefined} request
 * @returns {import('./types').PriceSource}
 */
function requestSource(request) {
  if (!request || typeof request !== 'object') return 'demo';
  const rows = request.rows && typeof request.rows === 'object' ? request.rows : {};
  const all = [request.source, ...['out', 'back', 'hotel'].filter(c => rows[c]).map(c => sourceOf(rows[c]))];
  return leastReal(all);
}

// ---------------------------------------------------------------------------------------------------------
// Fare terms

/** The marker every unknown term carries (the owner's rule: unknown → NEEDS VERIFICATION). */
const NEEDS_VERIFICATION = 'NEEDS VERIFICATION';

const AMOUNT_RE = /^\d{1,9}(?:\.\d{1,4})?$/;
const ZERO_RE = /^0+(?:\.0+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const count = n => Number.isSafeInteger(n) && n >= 0;

const SENTENCES = Object.freeze({
  refundsNotAllowed: 'Refunds: not allowed.',
  refundsFree: 'Refunds: allowed with no fee.',
  refundsFeeUnknown: `Refunds: allowed, but the airline doesn't say the fee (${NEEDS_VERIFICATION}).`,
  refundsUnknown: `Refunds: the airline doesn't say (${NEEDS_VERIFICATION}).`,
  changesNotAllowed: 'Changes: not allowed.',
  freeChanges: 'Changes: free changes allowed.',
  changesFeeUnknown: `Changes: allowed, but the airline doesn't say the fee (${NEEDS_VERIFICATION}).`,
  changesUnknown: `Changes: the airline doesn't say (${NEEDS_VERIFICATION}).`,
  bagsUnknown: `Bags: the airline doesn't say (${NEEDS_VERIFICATION}).`,
  hotelNonRefundable: 'Non-refundable.',
  hotelNoDeadline: `Refundable, but the supplier gave no deadline (${NEEDS_VERIFICATION}).`,
});

/** "Refunds: allowed for a fee of 50.00 USD set by the airline." (the amount as the airline gave it). */
function feeSentence(topic, amount, currency) {
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount) || typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
    return topic === 'Refunds' ? SENTENCES.refundsFeeUnknown : SENTENCES.changesFeeUnknown;
  }
  return `${topic}: allowed for a fee of ${amount} ${currency} set by the airline.`;
}

/**
 * One condition (refunds or changes) as its sentence.
 * @param {'Refunds'|'Changes'} topic
 * @param {TermCondition|null|undefined} cond
 */
function conditionSentence(topic, cond) {
  const refunds = topic === 'Refunds';
  if (!cond || typeof cond !== 'object' || typeof cond.allowed !== 'boolean') return refunds ? SENTENCES.refundsUnknown : SENTENCES.changesUnknown;
  if (!cond.allowed) return refunds ? SENTENCES.refundsNotAllowed : SENTENCES.changesNotAllowed;
  const amount = cond.penaltyAmount;
  if (typeof amount === 'string' && ZERO_RE.test(amount)) return refunds ? SENTENCES.refundsFree : SENTENCES.freeChanges;
  if (amount == null) return refunds ? SENTENCES.refundsFeeUnknown : SENTENCES.changesFeeUnknown;
  return feeSentence(topic, amount, cond.penaltyCurrency);
}

/**
 * A refund or change condition as an adapter reads it (Duffel's `refund_before_departure` and
 * `change_before_departure`, slice level first, then offer level; null when the airline gave nothing).
 * @typedef {{ allowed: boolean|null, penaltyAmount: string|null, penaltyCurrency: string|null }} TermCondition
 *   penaltyAmount: the decimal string as the airline gave it ('50.00'; '0' or '0.00' means no fee)
 */

/**
 * The bags sentence. A count that is not a whole number ≥ 0 is "not stated".
 * @param {{ checked?: number|null, carryOn?: number|null }} [bags] the allowance that holds on every segment
 * @returns {string} "Bags: 1 checked bag, 1 carry-on bag." · "Bags: no checked bag, 1 carry-on bag." ·
 *   "Bags: 2 checked bags, carry-on bags not stated (NEEDS VERIFICATION)." · TERMS.bagsUnknown
 */
function bagsSentence(bags) {
  const { checked = null, carryOn = null } = bags && typeof bags === 'object' ? bags : {};
  if (!count(checked) && !count(carryOn)) return SENTENCES.bagsUnknown;
  const a = count(checked) ? (checked === 0 ? 'no checked bag' : plural(checked, 'checked bag')) : 'checked bags not stated';
  const b = count(carryOn) ? (carryOn === 0 ? 'no carry-on bag' : plural(carryOn, 'carry-on bag')) : 'carry-on bags not stated';
  const unknown = !count(checked) || !count(carryOn);
  return `Bags: ${a}, ${b}${unknown ? ` (${NEEDS_VERIFICATION})` : ''}.`;
}

/**
 * The frozen fare-term sentences and the functions that build them. Never edit a sentence: diff.js and
 * policy/evaluate.js match them exactly.
 */
const TERMS = Object.freeze({
  ...SENTENCES,
  /** @type {(amount: string, currency: string) => string} */
  refundsFee: (amount, currency) => feeSentence('Refunds', amount, currency),
  /** @type {(amount: string, currency: string) => string} */
  changesFee: (amount, currency) => feeSentence('Changes', amount, currency),
  /** @type {(cond: TermCondition|null) => string} */
  refunds: cond => conditionSentence('Refunds', cond),
  /** @type {(cond: TermCondition|null) => string} */
  changes: cond => conditionSentence('Changes', cond),
  bags: bagsSentence,
  /**
   * The whole fare.terms text: refunds, changes, bags, one space apart.
   * @type {(t: { refund: TermCondition|null, change: TermCondition|null, bags: { checked?: number|null, carryOn?: number|null }|null }) => string}
   */
  fare: ({ refund = null, change = null, bags = null } = {}) =>
    [conditionSentence('Refunds', refund), conditionSentence('Changes', change), bagsSentence(bags)].join(' '),
});

const says = (text, ...sentences) => typeof text === 'string' && sentences.some(s => text.includes(s));

/**
 * The terms say changes are not allowed (the only case diff.js may give up "No changes allowed" on a supplier row).
 * @param {unknown} terms a row's fare.terms
 * @returns {boolean}
 */
const saysNoChanges = terms => says(terms, TERMS.changesNotAllowed);

const REFUND_FEE_RE = /Refunds: allowed for a fee of \d{1,9}(?:\.\d{1,4})? ([A-Z]{3}) set by the airline\./;

/**
 * The terms don't confirm how much a refund returns, so fare.refundablePercent (0) is a placeholder, not a fact:
 * the airline didn't say whether, or didn't say the fee, or the fee is in another currency than the fare
 * (never converted, design §3.2). Then never say "Refunds nothing": say "No refund confirmed".
 * @param {unknown} terms a row's fare.terms
 * @param {{ currency?: string }} [opts] currency: the row's (Business rows are 'USD')
 * @returns {boolean}
 */
function refundsUnconfirmed(terms, { currency = 'USD' } = {}) {
  if (says(terms, TERMS.refundsUnknown, TERMS.refundsFeeUnknown)) return true;
  const fee = typeof terms === 'string' ? terms.match(REFUND_FEE_RE) : null;
  return Boolean(fee && fee[1] !== currency);
}

/**
 * The terms don't confirm the change rules: the airline didn't say whether, or didn't say the fee.
 * @param {unknown} terms
 * @returns {boolean}
 */
const changesUnconfirmed = terms => says(terms, TERMS.changesUnknown, TERMS.changesFeeUnknown);

// ---------------------------------------------------------------------------------------------------------
// Supplier errors (design §2.4, §4.3, §5.1). A configured real supplier that fails never serves demo or stale data.

/** What a company Tripelyx hasn't confirmed sees instead of a live search (go-live design §5.5). */
const SEARCH_CLOSED = 'Search opens once Tripelyx confirms your company.';

const SUPPLIER_ERRORS = Object.freeze({
  // Timeouts, 5xx, 429 beyond the retry budget, an open breaker, refused credentials, a mode mismatch, a body over the cap.
  supplier_unavailable: Object.freeze({
    status: 503,
    flights: 'Flights are not available right now. Please try again in a few minutes.',
    hotels: 'Hotels are not available right now.',
  }),
  // The per-company hourly limit.
  supplier_busy: Object.freeze({
    status: 429,
    message: 'Your company has run a lot of searches in the last hour. Please try again in a few minutes.',
  }),
  // A page-view ('peek') price check that would need a supplier search.
  live_check_skipped: Object.freeze({ status: 503, message: 'The price is checked again when you approve.' }),
  // The persisted daily caps on live keys (go-live design §5.5, added with L2): the company's own calls to one
  // supplier today, or every company's together. {opensAt} is the next UTC midnight in the company's zone.
  supplier_daily_limit: Object.freeze({
    status: 429,
    company: "Your company has reached today's search limit. Search opens again at {opensAt}.",
    total: 'Search is paused for the rest of today. It opens again at {opensAt}.',
  }),
  // Live search calls suppliers only for companies Tripelyx has confirmed (go-live design §5.5): a pending
  // company's search, price check or re-check stops here, before any supplier call.
  company_not_confirmed: Object.freeze({ status: 409, message: SEARCH_CLOSED }),
});

/** The live-check errors getRequest shows as RequestView.liveError instead of failing the page (it rethrows others). */
const LIVE_ERROR_CODES = Object.freeze(['supplier_unavailable', 'supplier_busy', 'live_check_skipped', 'unsupported_currency', 'supplier_daily_limit', 'company_not_confirmed']);

/** Page copy around a price check (design §2.4). */
const PRICE_CHECK_COPY = Object.freeze({
  // Approver page, liveError 'live_check_skipped'.
  skipped: 'The price is checked again when you approve.',
  // Approver page, any other liveError.
  failed: "We couldn't check the price just now. It is checked again when you approve.",
  // Submit or decide answered 503 during the price check: the request is untouched.
  unchanged: "The price couldn't be checked just now, so nothing changed. Try again in a few minutes.",
  // Results page, hotel leg error 'unavailable' (the flights still show).
  hotelsLeg: 'Hotels are not available right now. You can still request the flights.',
  // Results page, hotel leg error 'limit': the hotel supplier's daily cap (the flights still show).
  hotelsLimit: "Hotel search has reached today's limit. You can still request the flights.",
  // Live prices with live search off (turned off, or a mode mismatch; inventory status 'none'), for a trip priced
  // on live prices: nothing can be checked until a platform admin turns live search on again, so no page says
  // "try again in a few minutes" or that suppliers were never connected (go-live design §5.4, §5.7).
  // Submit or decide refused (the request is untouched).
  searchOff: "Trip search is off right now, so the price can't be checked and nothing changed.",
  // Approver page, instead of the price check line (no Approve button).
  searchOffDecide: "Trip search is off right now, so the price can't be checked and this trip can't be approved yet. You can still deny it or send a message.",
  // The traveler's draft inside the policy, instead of the Confirm form.
  searchOffConfirm: "Trip search is off right now, so the price can't be checked and this trip can't be confirmed yet.",
  // The traveler's draft over the policy, instead of the Request Approval form.
  searchOffRequest: "Trip search is off right now, so the price can't be checked and this trip can't be sent for approval yet.",
  // The traveler's draft with cheaper options, as the options' summary: a switch searches again, so the options
  // show with no "Use this option" (a switch sent anyway is refused with searchOff, the request untouched).
  searchOffSwap: "Trip search is off right now, so you can't switch to one of these options yet.",
});

/**
 * The AppError a real supplier path throws.
 * @param {'supplier_unavailable'|'supplier_busy'|'live_check_skipped'|'supplier_daily_limit'|'company_not_confirmed'} code
 * @param {{ vertical?: 'flights'|'hotels', limit?: 'company'|'total', opensAt?: string }} [opts] vertical:
 *   required for supplier_unavailable; limit and opensAt (e.g. "2:00 AM tomorrow (Cairo time)"): required for
 *   supplier_daily_limit
 * @returns {AppError}
 * @throws {TypeError} for another code, supplier_unavailable without a vertical, or supplier_daily_limit
 *   without its limit and time
 */
function supplierError(code, { vertical = null, limit = null, opensAt = null } = {}) {
  const e = Object.prototype.hasOwnProperty.call(SUPPLIER_ERRORS, code) ? SUPPLIER_ERRORS[code] : null;
  if (!e) throw new TypeError(`[business] ${code} is not a supplier error`);
  if (code === 'supplier_unavailable') {
    if (vertical !== 'flights' && vertical !== 'hotels') throw new TypeError('[business] supplier_unavailable names flights or hotels');
    return new AppError(code, e[vertical], e.status);
  }
  if (code === 'supplier_daily_limit') {
    if ((limit !== 'company' && limit !== 'total') || typeof opensAt !== 'string' || !opensAt) {
      throw new TypeError('[business] supplier_daily_limit names its limit and when search opens again');
    }
    return new AppError(code, e[limit].replace('{opensAt}', opensAt), e.status);
  }
  return new AppError(code, e.message, e.status);
}

module.exports = {
  SOURCES, NAMESPACES, isSource, sourceOf, offerPrefix, leastReal, requestSource,
  NEEDS_VERIFICATION, TERMS, saysNoChanges, refundsUnconfirmed, changesUnconfirmed,
  SUPPLIER_ERRORS, LIVE_ERROR_CODES, PRICE_CHECK_COPY, SEARCH_CLOSED, supplierError,
};
