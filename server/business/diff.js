// What changes between two versions of a trip (plan §G2 "giveUps", §H2 "Requested vs cheapest option inside
// policy"). Fields are read from a declared list, never Object.keys order (JSONB reorders keys); the 1B
// diff.js pattern. Pure.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. The service holds compareTrips as
// this.alternatives.compareTrips (types.AlternativesEngine); buildAlternatives calls giveUps itself.
//
// giveUps, for example: "Leaves 07:05 instead of 13:40" · "Arrives 2h 10m later" · "1 stop in Istanbul,
// adds 1h 50m" · "No free changes" · "Refunds nothing (yours refunds 70%)" · "1 checked bag instead of 2" ·
// "4-star instead of 5-star" · "Your trip moves 1 day later" · "Nothing else changes". No amounts (the saving
// is shown by the view), no em dash.

function notBuilt() { throw new Error('[business] not built'); }

/** The compared fields, in row order. */
const DIFF_FIELDS = Object.freeze(['dates', 'carrier', 'times', 'stops', 'cabin', 'fare', 'bags', 'refunds', 'changes', 'hotel', 'room', 'stars', 'hotelRefunds']);

/**
 * What the traveler gives up by taking `alt` instead of `pick` (what gets worse or different; never the price).
 * @param {import('./types').TripRows} pick
 * @param {import('./types').TripRows} alt
 * @returns {string[]} ['Nothing else changes'] when only the price differs
 */
function giveUps(pick, alt) { notBuilt(); }

/**
 * Side by side, two versions of a trip: the rows that differ (in DIFF_FIELDS order), and the totals.
 * @param {{ rows: import('./types').TripRows, totalCents: number }} a usually the requested trip
 * @param {{ rows: import('./types').TripRows, totalCents: number }} b usually the cheapest option inside policy
 * @returns {import('./types').TripComparison}
 */
function compareTrips(a, b) { notBuilt(); }

/**
 * Per-line money changes between two rows' price lines, matched by label then kind; the deltas add up to
 * the totals' delta (1B lineDeltas).
 * @param {import('./types').Row|null} a
 * @param {import('./types').Row|null} b
 * @returns {Array<{ label: string, kind: string, from: number, to: number, delta: number }>}
 */
function lineDeltas(a, b) { notBuilt(); }

module.exports = { DIFF_FIELDS, giveUps, compareTrips, lineDeltas };
