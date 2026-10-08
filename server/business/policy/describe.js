// A travel policy in plain words (plan §B6 "Your travel policy", §E4 limits bar). Pure.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. Types: server/business/types.js.
//
// Copy rules: no em dash, none of the PRESSURE words (test/experience-pages.test.js:49), amounts through
// lib/money. Hotel stars are labelled as a Tripelyx addition where the editor shows them.
//
// describe() lines, for example:
//   "Flights under 6 hours: Economy, up to the median of the demo fares in your search plus 20% (or $600 if
//    there aren't enough fares to compare)."
//   "Flights of 6 hours or more: up to Premium economy."
//   "Plan flights at least 7 days ahead."
//   "Hotels: up to $180 a night, taxes included; London $300."
//   "Up to 4-star hotels."
//   "Sahara Wings isn't used by Acme Inc."
// limitsBar() for one search, for example:
//   heading 'Your limits for this search (Standard policy, v3)'
//   { key: 'flight.short', text: 'Flights under 6 hours: Economy, up to', cents: 71200, suffix: 'each way (median of these demo fares plus 20%)' }
//   { key: 'flight.advance', text: 'Plan 7 days ahead', cents: null, suffix: '' }
//   { key: 'hotel.cap', text: 'Hotels in London: up to', cents: 30000, suffix: 'a night, taxes included' }
//   { key: 'hotel.priceToBeat', text: 'Price to Beat:', cents: 26400, suffix: 'a night (the lower of your limit and the middle rate of this search)' }

function notBuilt() { throw new Error('[business] not built'); }

/**
 * The member-facing summary of one tier's rules.
 * @param {import('../types').PolicyRules} rules
 * @param {{ tier: import('../types').Tier, version: number, orgName: string, carriers: Record<string, string> }} opts
 * @returns {import('../types').PolicyDescription} title 'Your travel policy', sub '<Tier> policy, version <n>'
 */
function describe(rules, opts) { notBuilt(); }

/**
 * The "Your limits for this search" bar: the cap of each haul band the search's rows fall in (route
 * overrides included), the advance-days rule, the hotel city's cap and the Price to Beat.
 * @param {import('../types').PolicyRules} rules
 * @param {import('../types').EvalCtx} ctx
 * @param {import('../types').SearchResult} search
 * @returns {import('../types').LimitsBar}
 */
function limitsBar(rules, ctx, search) { notBuilt(); }

module.exports = { describe, limitsBar };
