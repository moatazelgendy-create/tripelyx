// Trip search for Business (plan §F3, §F4, §G1): parse the search form, search the legs, price a selection
// again, and generate the cheaper variants the alternatives are ranked from. Writes nothing, ever: quotes
// come from provider.quote(), which stores nothing.
// STUB from Stage 0 with the frozen interface; Stage 1I builds it. The service holds a TripComposer as
// this.composer (types.TripComposer), so tests can use test/business-fakes.fakeComposer().
//
// - Up to 3 provider searches run in parallel (out, back, hotel). Every available option of every offer is
//   priced with provider.quote() (at most MAX_PRICED_PER_LEG per leg, then the leg is `truncated`).
//   Totals are the sum of the price lines. An unavailable option is a row with available:false and no price.
// - A currency other than the org's (USD): 422 'unsupported_currency', "Priced in another currency, not supported yet".
// - Latency targets with MOCK_LATENCY_MS=0: search ≤ 150 ms, draft creation with alternatives ≤ 400 ms
//   (tests assert 1,500 ms ceilings).
// - variants(): each candidate is the whole trip with ONE change (all_within: every out-of-policy component
//   swapped for its cheapest within-policy row), priced end to end:
//     fare (same itinerary, cheaper fare family; 0 searches) · flight (other itinerary, same leg, date and
//     cabin; 0) · stops (a one-stop when the pick is nonstop; 0) · cabin (next lower cabin, same leg; 1 per
//     leg) · dates (only with datesFlexible: the whole trip ±1, ±2, ±3 days, legs and hotel moving together,
//     nights kept, never in the past; 1 to 3 per shift) · room (cheaper room, same hotel; 0) · hotel (another
//     hotel in the same city; 0) · all_within (0).
//   At most maxSearches (20) extra searches and POOL_CAP (200) candidates; truncated when either cuts
//   anything. Never a different destination or route.

function notBuilt() { throw new Error('[business] not built'); }

/** The most options priced per leg. */
const MAX_PRICED_PER_LEG = 60;
/** The most extra searches variants() makes. */
const MAX_SEARCHES = 20;
/** The most candidates variants() returns. */
const POOL_CAP = 200;
/** How far ahead a trip can be searched (days after today in the org's time zone). */
const MAX_DAYS_AHEAD = 330;
/** The longest trip (return date after departure). */
const MAX_TRIP_DAYS = 30;
/** Hotel nights on a one-way trip. */
const NIGHTS_RANGE = Object.freeze([1, 14]);
/** How far dates move for 'dates' variants. */
const FLEX_DAYS = 3;

/**
 * Parse the search form (types.RawTripQuery). Airports must come from `airports`; from ≠ to; departDate in
 * today..today + 330; returnDate after departDate and ≤ departDate + 30; hotel: checkIn = departDate,
 * checkOut = returnDate, or checkIn + nights (1..14) one way; city and country from cityFor(to).
 * (search() moves checkIn to the outbound arrival's local date when every available outbound itinerary lands
 * on a later date, keeping the nights; SearchResult.query is the query as searched, and is what the results
 * form carries to POST /trips.)
 * @param {import('./types').RawTripQuery} raw
 * @param {{ today: string, airports: Array<{ code: string }>, cityFor: (iata: string) => { city: string, country: string }|null }} opts
 *   today: tz.localDate(org.timezone, now)
 * @returns {import('./types').TripQuery}
 * @throws {AppError} 422 'invalid_query', 'Check the highlighted fields.', details keyed by raw field name
 *   (from, to, depart, return, nights, cabin)
 */
function parseTripQuery(raw, opts) { notBuilt(); }

/**
 * Searches, prices and builds variants over a BusinessInventory. Construction never throws (the app builds
 * one at boot); with inventory status 'none' search/price/variants answer 503 'no_supplier'.
 */
class TripComposer {
  /**
   * @param {{ inventory: import('./types').BusinessInventory, now: () => Date }} deps
   */
  constructor({ inventory, now }) {
    this.inventory = inventory;
    this.now = now;
  }

  /**
   * parseTripQuery with this inventory's airports and cityFor.
   * @param {import('./types').RawTripQuery} raw
   * @param {{ today: string }} opts
   * @returns {import('./types').TripQuery}
   * @throws {AppError} 422 'invalid_query' with per-field details
   */
  parseQuery(raw, opts) { notBuilt(); }

  /**
   * Search every leg of the query.
   * @param {import('./types').TripQuery} query
   * @returns {Promise<import('./types').SearchResult>} pricedAt from this.now()
   * @throws {AppError} 503 'no_supplier' when inventory.status is 'none'; provider errors pass through (502)
   */
  async search(query) { notBuilt(); }

  /**
   * Price a selection again, now (never trusting any price a form sent).
   * @param {import('./types').Selection} selection
   * @param {import('./types').TripQuery} query
   * @returns {Promise<import('./types').PriceResult>}
   * @throws {AppError} 422 'invalid_selection' for a malformed key, a key on the wrong leg, back without a
   *   returnDate or hotel without query.hotel; 503 'no_supplier'
   */
  async price(selection, query) { notBuilt(); }

  /**
   * The cheaper variants of a pick (see the header for the kinds and caps).
   * @param {import('./types').TripQuery} query
   * @param {import('./types').Selection} selection
   * @param {{ datesFlexible: boolean, maxSearches?: number }} opts
   * @returns {Promise<import('./types').VariantResult>}
   */
  async variants(query, selection, opts) { notBuilt(); }

  /**
   * Price a stored request's selection again (recheck.recheck(this, request)). Writes nothing.
   * @param {import('./types').Request} request
   * @returns {Promise<import('./types').RecheckResult>}
   */
  async recheck(request) { notBuilt(); }
}

module.exports = {
  MAX_PRICED_PER_LEG, MAX_SEARCHES, POOL_CAP, MAX_DAYS_AHEAD, MAX_TRIP_DAYS, NIGHTS_RANGE, FLEX_DAYS,
  parseTripQuery, TripComposer,
};
