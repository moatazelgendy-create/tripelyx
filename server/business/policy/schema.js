// Policy rules from the editor's form, and back (plan §E1). Pure: no store, no clock.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. Types: server/business/types.js.
//
// Every PolicyRules a company stores went through normalizePolicy: unknown keys, a 'first' cabin, negative
// money, unknown airports or carriers and over-long lists are refused with per-field details. Money is
// parsed with validate.dollarsToCents and percentages with validate.percentTenths (string arithmetic).

function notBuilt() { throw new Error('[business] not built'); }

/** Cap modes, in the editor's order. */
const CAP_MODES = Object.freeze(['none', 'fixed', 'median_pct', 'median_plus']);

/** Limits normalizePolicy enforces (money: whatever validate.dollarsToCents accepts, which is under $10 million). */
const LIMITS = Object.freeze({
  longHaulMinutes: Object.freeze([60, 1200]),
  minAdvanceDays: Object.freeze([0, 365]),
  pctTenths: Object.freeze([0, 999]),
  routeOverrides: 50,
  blockedCarriers: 20,
  countryCaps: 60,
  citiesPerCountry: 20,
  nameChars: 80,   // a country or city name
  noteChars: 300,  // "What changed?" (policies.savePolicy)
});

/**
 * Build PolicyRules from the editor's form (types.PolicyForm lists every field name).
 * @param {import('../types').PolicyForm} form the url-encoded body (extra fields such as rev and note are ignored)
 * @param {import('../types').PolicyRefs} refs codes the inventory knows (empty lists refuse every code)
 * @returns {import('../types').PolicyRules} every key present, lists in the form's order
 * @throws {AppError} 422 'invalid_policy', message 'Check the highlighted fields.', details { [form field]: message }
 */
function normalizePolicy(form, refs) { notBuilt(); }

/**
 * The editor's form fields for stored rules (what the editor pre-fills). normalizePolicy(formFromPolicy(r), refs)
 * deep-equals r for any r normalizePolicy produced.
 * @param {import('../types').PolicyRules} rules
 * @returns {import('../types').PolicyForm} every value a string (blockedCarriers: string[])
 */
function formFromPolicy(rules) { notBuilt(); }

/**
 * The field changes from one version to the next, walking a declared list of paths (never Object.keys
 * order: Postgres JSONB reorders keys). Lists are matched by their natural key: route overrides by
 * 'from-to', countries by name, cities by name. Paths look like 'flights.shortHaul.cap',
 * 'flights.routeOverrides[CAI-LHR]', 'hotels.countryCaps[United Kingdom].cities[London].nightlyCents'.
 * @param {import('../types').PolicyRules} before
 * @param {import('../types').PolicyRules} after
 * @returns {import('../types').Change[]} [] when nothing changed
 */
function policyChanges(before, after) { notBuilt(); }

module.exports = { CAP_MODES, LIMITS, normalizePolicy, formFromPolicy, policyChanges };
