// The "median of these demo fares" a policy cap can follow (plan §E2). Pure, integer math: no store, no
// clock, inputs never mutated.
//
// benchmark(values):
//   n < 3  → medianCents null (the cap uses its fallback);
//   n = 3  → the plain median;
//   n ≥ 4  → sort ascending; Q1 = a[floor((n−1)×0.25)], Q3 = a[ceil((n−1)×0.75)], IQR = Q3 − Q1,
//            f = floor(3×IQR/2); keep values in [Q1 − f, Q3 + f]; median of those: odd → middle,
//            even → floor((a+b)/2).
// Examples: [] [a] [a,b] → null; [100,110,120] → 110; [300,310,320,330,2000] → 315 (2000 excluded);
// [100,110,120,130,1000] → 115.
// Only whole, non-negative cents count: anything else in `values` (null for an unpriced option, NaN, a
// fraction) is left out before n is counted, so a stray value can never move a cap.

const isCents = v => Number.isSafeInteger(v) && v >= 0;

/** The median of an ascending, non-empty list of integers (even count: the floor of the middle two's mean). */
function medianOf(sorted) {
  const n = sorted.length;
  const mid = (n - (n % 2)) / 2;
  return n % 2 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The median of a search with outliers removed.
 * @param {number[]} values integer cents (not mutated)
 * @returns {import('../types').Benchmark} sampleSize: values the median was taken over; excluded: the outliers, ascending
 */
function benchmark(values) {
  const a = (Array.isArray(values) ? values : []).filter(isCents).sort((x, y) => x - y);
  const n = a.length;
  if (n < 3) return { medianCents: null, sampleSize: n, excluded: [] };
  if (n === 3) return { medianCents: a[1], sampleSize: 3, excluded: [] };
  // Quartile positions in integers: floor((n−1)/4) and ceil(3(n−1)/4) = floor((3(n−1)+3)/4).
  const q1i = ((n - 1) - ((n - 1) % 4)) / 4;
  const top = 3 * (n - 1) + 3;
  const q3i = (top - (top % 4)) / 4;
  const q1 = a[q1i], q3 = a[q3i];
  const f = Math.floor((3 * (q3 - q1)) / 2);
  const low = q1 - f, high = q3 + f;
  const kept = [], excluded = [];
  for (const v of a) (v < low || v > high ? excluded : kept).push(v);
  return { medianCents: medianOf(kept), sampleSize: kept.length, excluded };
}

/** One value per offer: the smallest `pick(row)` among its available rows. Ascending. */
function cheapestPerOffer(rows, pick) {
  const best = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.available !== true) continue;
    const v = pick(r);
    if (!isCents(v)) continue;
    const was = best.get(r.offerId);
    if (was === undefined || v < was) best.set(r.offerId, v);
  }
  return [...best.values()].sort((x, y) => x - y);
}

/**
 * The values a flight leg's benchmark is taken over: one per itinerary (offerId), its cheapest available
 * totalCents in that leg's search (same leg, date and cabin). Itineraries with nothing available give nothing.
 * @param {import('../types').FlightRow[]} rows
 * @returns {number[]} ascending
 */
function flightValues(rows) {
  return cheapestPerOffer(rows, r => r.totalCents);
}

/**
 * The values a hotel search's benchmark is taken over: one per hotel (offerId), its cheapest available room's
 * nightly amount on the policy basis (incl_taxes: nightlyInclCents; excl_taxes: nightlyCents).
 * @param {import('../types').HotelRow[]} rows
 * @param {'incl_taxes'|'excl_taxes'} basis
 * @returns {number[]} ascending
 */
function hotelValues(rows, basis) {
  if (basis !== 'incl_taxes' && basis !== 'excl_taxes') throw new TypeError(`[business] unknown cap basis ${basis}`);
  return cheapestPerOffer(rows, r => (basis === 'excl_taxes' ? r.nightlyCents : r.nightlyInclCents));
}

module.exports = { benchmark, flightValues, hotelValues };
