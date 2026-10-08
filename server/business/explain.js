// The notes next to cheaper alternatives (plan §G3). The explainer receives no prices, totals or names, and
// whatever it returns goes through guardExplanation: amounts are always rendered by the view from savesCents.
// Today only the rule-based explainer exists (config.business.explainer 'rules'); no AI model is connected
// and nothing here makes an outbound call.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. The service holds createExplainer(config)
// as this.explainer (types.GuardedExplainer), so tests can use fakeExplainer().
//
// Rule notes, for example: "Same flight with the Classic fare: you keep your times and still check a bag,
// but changes cost extra." noneWithin summary: "No cheaper option inside your policy turned up in this
// search. You can still request approval with a reason."

function notBuilt() { throw new Error('[business] not built'); }

/** How long an explainer may take before its output is replaced by RuleExplainer's. */
const EXPLAIN_TIMEOUT_MS = 200;
/** Longest note per alternative, and longest summary. */
const NOTE_MAX = 160;
const SUMMARY_MAX = 300;
/** Text matching this is dropped (no numbers or currencies from an explainer, ever). */
const FORBIDDEN_TEXT = /[0-9]|[$€£¥]|\bUSD\b/;

/** The explainers BUSINESS_EXPLAINER may name (config.js accepts only these). */
const EXPLAINERS = Object.freeze(['rules']);

/**
 * The rule-based explainer: deterministic notes written and tested by Tripelyx.
 * Implements types.AlternativesExplainer.
 */
class RuleExplainer {
  constructor() { this.name = 'rules'; }

  /**
   * @param {import('./types').ExplainInput} input
   * @param {{ signal?: object }} [opts] an AbortSignal (ignored: rules answer at once)
   * @returns {Promise<import('./types').ExplainOutput>} order: input order; a note for every id; the summary
   */
  async explain(input, opts) { notBuilt(); }
}

/**
 * Make an explainer's output safe to show: keep known ids only (missing ones appended in input order, no
 * duplicates); drop any note or summary matching FORBIDDEN_TEXT; cut notes to NOTE_MAX and the summary to
 * SUMMARY_MAX characters; non-string values become ''.
 * @param {unknown} out what the explainer returned
 * @param {import('./types').ExplainInput} input
 * @returns {import('./types').ExplainOutput}
 */
function guardExplanation(out, input) { notBuilt(); }

/**
 * The explainer the service uses: the configured one, run with an AbortSignal and EXPLAIN_TIMEOUT_MS, its
 * output through guardExplanation; on a throw or timeout, RuleExplainer's output. Its explain() never rejects.
 * Called once at boot (app.js); it must not throw for a valid config.
 * @param {object} config the app config (config.business.explainer)
 * @returns {import('./types').GuardedExplainer}
 * @throws {Error} at boot when config.business.explainer is not one of EXPLAINERS
 */
function createExplainer(config) {
  const name = config && config.business && config.business.explainer;
  if (!EXPLAINERS.includes(name)) throw new Error(`[business] unknown explainer ${name}`);
  return Object.freeze({ name, explain: async () => notBuilt() });
}

module.exports = {
  EXPLAIN_TIMEOUT_MS, NOTE_MAX, SUMMARY_MAX, FORBIDDEN_TEXT, EXPLAINERS, RuleExplainer, guardExplanation, createExplainer,
};
