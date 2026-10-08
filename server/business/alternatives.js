// "AI-powered cheaper alternatives": ranking (plan §G2). Pure and deterministic: every alternative is a
// priced result of the same demo search (composer.variants), never an estimate.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. The service holds it as
// this.alternatives.buildAlternatives (types.AlternativesEngine), so tests can use fakeAlternatives().
//
// Kept: available, not blocked, savesCents ≥ MIN_SAVING_CENTS; deduplicated by selection (and query).
// Ranked: within policy first; then savesCents descending; then fewer giveUps; then the smaller date shift;
// then id. At most MAX_ALTERNATIVES. cheapestWithin (the cheapest within-policy candidate) is pinned first,
// labelled CHEAPEST_WITHIN_LABEL, and stored on the request for approvers and reports.
// Labels have no digits and no currency signs:
//   fare 'Same flight, Classic fare' · flight 'Another flight the same day' · stops 'One stop via Istanbul'
//   cabin 'Premium economy instead of Business' · dates 'Leave a day later' · hotel 'Another hotel in London'
//   room 'Smaller room, same hotel' · all_within 'Cheapest trip inside your policy'
// giveUps come from diff.giveUps(pick rows, alternative rows).

function notBuilt() { throw new Error('[business] not built'); }

/** The most alternatives a request shows. */
const MAX_ALTERNATIVES = 5;
/** An alternative must save at least this much (cents). */
const MIN_SAVING_CENTS = 100;
/** The label of the pinned cheapest within-policy option. */
const CHEAPEST_WITHIN_LABEL = 'Cheapest option inside your policy';

/**
 * Rank the candidates of one pick.
 * @param {import('./types').AlternativesInput} input
 * @returns {import('./types').AlternativesResult} every Alternative's note is '' (the explainer fills it)
 */
function buildAlternatives(input) { notBuilt(); }

/**
 * An alternative's id: the first 16 hex characters of sha256 over the selection keys and the query's dates
 * (stable across searches, so a swap form can name it).
 * @param {import('./types').Selection} selection
 * @param {import('./types').TripQuery} query
 * @returns {string}
 */
function alternativeId(selection, query) { notBuilt(); }

module.exports = { MAX_ALTERNATIVES, MIN_SAVING_CENTS, CHEAPEST_WITHIN_LABEL, buildAlternatives, alternativeId };
