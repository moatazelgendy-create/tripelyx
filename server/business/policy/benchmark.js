// The "median of these demo fares" a policy cap can follow (plan §E2). Pure, integer math.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. Types: server/business/types.js.
//
// benchmark(values):
//   n < 3  → medianCents null (the cap uses its fallback);
//   n = 3  → the plain median;
//   n ≥ 4  → sort ascending; Q1 = a[floor((n−1)×0.25)], Q3 = a[ceil((n−1)×0.75)], IQR = Q3 − Q1,
//            f = floor(3×IQR/2); keep values in [Q1 − f, Q3 + f]; median of those: odd → middle,
//            even → floor((a+b)/2).
// Examples: [] [a] [a,b] → null; [100,110,120] → 110; [300,310,320,330,2000] → 315 (2000 excluded);
// [100,110,120,130,1000] → 115.

function notBuilt() { throw new Error('[business] not built'); }

/**
 * The median of a search with outliers removed.
 * @param {number[]} values integer cents (not mutated)
 * @returns {import('../types').Benchmark} sampleSize: values the median was taken over; excluded: the outliers, ascending
 */
function benchmark(values) { notBuilt(); }

/**
 * The values a flight leg's benchmark is taken over: one per itinerary (offerId), its cheapest available
 * totalCents in that leg's search (same leg, date and cabin). Itineraries with nothing available give nothing.
 * @param {import('../types').FlightRow[]} rows
 * @returns {number[]}
 */
function flightValues(rows) { notBuilt(); }

/**
 * The values a hotel search's benchmark is taken over: one per hotel (offerId), its cheapest available room's
 * nightly amount on the policy basis (incl_taxes: nightlyInclCents; excl_taxes: nightlyCents).
 * @param {import('../types').HotelRow[]} rows
 * @param {'incl_taxes'|'excl_taxes'} basis
 * @returns {number[]}
 */
function hotelValues(rows, basis) { notBuilt(); }

module.exports = { benchmark, flightValues, hotelValues };
