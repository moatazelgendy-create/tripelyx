// Is a flight, a hotel or a whole trip inside a company's travel policy? (plan §E3). Pure: no store, no clock
// (ctx.today is passed in), integer math, inputs never mutated (the tests deep-freeze them), and no access to
// markup, commission or any cost: rows are the allow-listed DTOs of dto.js.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. Types: server/business/types.js.
//
// Rules (within when …):
//   flight.cap        totalCents ≤ cap (equal is within)            "Over your $712 limit by $86 (median of these demo fares plus 20%)"
//   flight.cabin      rank(cabin) ≤ rank(maxCabin); a route override's maxCabin wins
//                                                                   "Business class is above your limit (Economy) for flights under 6 hours"
//   flight.advance    daysBetween(today, departure's local date) ≥ minAdvanceDays
//                                                                   "Planned 3 days ahead. Your policy asks for 7."
//   flight.stops      stops ≤ maxStops (when not null)              "1 stop. Your policy allows nonstop only."
//   flight.refundable fare.refundablePercent > 0 (when required)    "Your policy asks for a fare that refunds at least part of the price. Light refunds nothing."
//   flight.carrier    no segment's carrier is blocked; severity block "Sahara Wings isn't used by Acme Inc"
//   hotel.cap         basis total ≤ cap × nights (no per-night rounding); the violation's limit is cap × nights,
//                     its actual the stay's basis total and overCents their difference (stay totals, never
//                     per night); only the text quotes nightly amounts (Math.round(actual / nights) and the cap)
//                                                                   "$340 a night is over the London limit of $300 (taxes included)"
//   hotel.stars       stars ≤ maxStars                              "5-star hotel. Your policy allows up to 4 stars."
//   hotel.advance     as flights, on checkIn
//   hotel.refundable  cancellation.refundable (free, or partial with freeUntilHours > 0)
//   trip.cap          totalCents ≤ maxTotalCents                    "The trip total is over your $2,500 trip limit by $310"
//   budget            totalCents ≤ remainingCents; severity approval; the period in words is budget.periodLabel
//                                                                   "This trip would use $1,240 of the $900 left in Engineering for Q4 2026"
//   inventory.unavailable  row.available; severity block            "Not available in demo data"
// Status: any block violation → blocked; else with outOfPolicy 'block' any non-budget violation → blocked;
// else any violation → out; else within. A trip takes its worst component, plus trip.cap and budget; a
// budget-only overrun is out, never blocked. Texts use lib/money formatting, no em dash, no PRESSURE words.

function notBuilt() { throw new Error('[business] not built'); }

/** Every rule id a Violation can carry, in display order. */
const RULE_IDS = Object.freeze([
  'flight.cap', 'flight.cabin', 'flight.advance', 'flight.stops', 'flight.refundable', 'flight.carrier',
  'hotel.cap', 'hotel.stars', 'hotel.advance', 'hotel.refundable', 'trip.cap', 'budget', 'inventory.unavailable',
]);

/** Status order for sorting and roll-up: within < out < blocked. */
const STATUS_RANK = Object.freeze({ within: 0, out: 1, blocked: 2 });

/**
 * The price limit for one flight row: the first matching route override (from/to, or reversed when
 * bothWays), else the band for its haul (flyingMinutes ≥ longHaulMinutes → long).
 * median_pct: median + Math.floor(median × pctTenths / 1000); median_plus: median + amountCents;
 * median null (fewer than 3 fares) → fallbackCents with source 'fallback'; mode none → cents null.
 * @param {import('../types').PolicyRules} rules
 * @param {import('../types').FlightRow} row
 * @param {import('../types').Benchmark|null} benchmark the same leg's (search result legs[row.leg].benchmark)
 * @returns {import('../types').FlightCap}
 */
function flightCap(rules, row, benchmark) { notBuilt(); }

/**
 * The nightly limit for one hotel row: the city cap inside its country, else the country cap, else the
 * default (names compared case-insensitively after NFKC). cents null when none applies.
 * @param {import('../types').PolicyRules} rules
 * @param {import('../types').HotelRow} row
 * @returns {import('../types').HotelCap}
 */
function hotelCap(rules, row) { notBuilt(); }

/**
 * Evaluate one row against ctx.rules.
 * @param {import('../types').Row} row a FlightRow (uses ctx.benchmarks[row.leg]) or a HotelRow (ctx.benchmarks.hotel)
 * @param {import('../types').EvalCtx} ctx
 * @returns {import('../types').Evaluation}
 */
function evaluateComponent(row, ctx) { notBuilt(); }

/**
 * Evaluate a whole trip: each component, then trip.cap on the total and the budget check.
 * @param {{ out: import('../types').FlightRow, back?: import('../types').FlightRow|null, hotel?: import('../types').HotelRow|null }} rows
 * @param {import('../types').EvalCtx} ctx
 * @param {{ budget: import('../types').BudgetCtx|null }} opts budget null: no budget for the period (no violation);
 *   budget.periodLabel is the period in words for the text (never computed here, so evaluate stays pure)
 * @returns {import('../types').TripEvaluation} components holds only the components given; totalCents = Σ rows
 */
function evaluateTrip(rows, ctx, opts) { notBuilt(); }

/**
 * Hotel Price to Beat: min(cap, median) when both exist, else whichever exists, else null.
 * @param {number|null} capCents the city's nightly cap on the policy basis
 * @param {import('../types').Benchmark|null} hotelBenchmark on the policy basis
 * @returns {number|null}
 */
function priceToBeat(capCents, hotelBenchmark) { notBuilt(); }

module.exports = { RULE_IDS, STATUS_RANK, flightCap, hotelCap, evaluateComponent, evaluateTrip, priceToBeat };
