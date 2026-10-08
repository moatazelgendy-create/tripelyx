// Business's own demo flights (plan §F2): the same fictional schedule as MockFlightProvider, with times local
// to each airport and honest per-fare terms. A subclass, so no file under providers/mock changes and the
// registry (Alamein Go, the AI travel agent) keeps serving MockFlightProvider itself.
// STUB from Stage 0 with the frozen interface; Stage 1I builds it. Loaded only when demo inventory is
// allowed (inventory.js requires it lazily).
//
// To build:
// - the private helpers (AIRPORTS, km, blockMinutes) copied from DATA = providers/mock/demo-data/flights;
// - buildOffers: the same itineraries, but nonstop slot i of n departs at
//   360 + floor((i + rand(seed, 'dep', i)) × 900 / n), rounded to 5 minutes (origin local), so the nonstops
//   on a route are spread over the day;
// - toOffer: origin-local departure → UTC with tz.localToUtc(airport.tz, …); arrival = UTC + duration, shown
//   in the destination's time zone; a connection leaves the hub at the previous arrival + layover, shown in
//   the hub's; details.segments[*].departAt/arriveAt are local 'YYYY-MM-DDTHH:MM'; details.elapsedMinutes is
//   computed in UTC; each segment adds arriveDayOffset; the offer-level cancellation is OFFER_CANCELLATION;
// - quote: FARE_TERMS[fare code] as the quote's cancellation, each validated against providers/contracts.js.
// Example: CAI→LHR on 2026-11-12 is about 5 h 04 min (short haul under 360); a CAI departure at 08:35 arrives
// at 11:39 London time.
const MockFlightProvider = require('../../providers/mock/MockFlightProvider');

function notBuilt() { throw new Error('[business] not built'); }

/** The offer-level cancellation: the real terms depend on the fare, and quote() gives them. */
const OFFER_CANCELLATION = Object.freeze({
  type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100,
  summary: 'Refund and change terms depend on the fare (demo fare rules).',
});

/** Each demo fare family's terms (the quote's cancellation). */
const FARE_TERMS = Object.freeze({
  LIGHT: Object.freeze({ type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: 'Non-refundable. No changes.' }),
  CLASSIC: Object.freeze({ type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: 'Non-refundable. Changes for a fee.' }),
  FLEX: Object.freeze({ type: 'partial', freeUntilHours: 0, penaltyPercent: 30, summary: '70% refundable. Free changes.' }),
});

class BusinessDemoFlights extends MockFlightProvider {
  /** @param {{ latencyMs?: number }} [opts] */
  constructor(opts = {}) {
    super({ latencyMs: 0, ...opts, name: 'BusinessDemoFlights' });
  }

  /**
   * @param {{ from: string, to: string, departDate: string, cabin: string, passengers: number }} query
   * @param {{ offerId?: string }} [opts]
   * @returns {object[]} provider Offers (validateOffer passes), cheapest first
   * @throws {AppError} 400 unknown_airport / same_airport, as MockFlightProvider
   */
  buildOffers(query, opts) { notBuilt(); }

  /** @returns {object} one provider Offer with local times (see the header) */
  toOffer(it, query, dist) { notBuilt(); }

  /**
   * @param {{ offerId: string, optionId: string, query: object }} input
   * @returns {Promise<object>} a SupplierQuote whose cancellation is FARE_TERMS[optionId]; writes nothing
   */
  async quote(input) { notBuilt(); }
}

module.exports = { BusinessDemoFlights, FARE_TERMS, OFFER_CANCELLATION };
