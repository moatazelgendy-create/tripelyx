// The notes next to cheaper alternatives (plan §G3). The explainer receives no prices, totals or names, and
// whatever it returns goes through guardExplanation: amounts are always rendered by the view from savesCents.
// Today only the rule-based explainer exists (config.business.explainer 'rules'); no AI model is connected
// and nothing here makes an outbound call. The service holds createExplainer(config) as this.explainer
// (types.GuardedExplainer), so tests can use fakeExplainer().
//
// Rule notes, for example: "Same flight on a cheaper fare: you keep your times, with fewer bags and stricter
// change rules. It fits your policy." noneWithin summary: "No cheaper option inside your policy turned up in this
// search. You can still request approval with a reason."
//
// The guard, beyond FORBIDDEN_TEXT (checked on the NFKC form, so fullwidth digits count): any Unicode digit,
// number sign or currency symbol, spelled-out large numbers and percentages, and currency words drop the text
// too, so no explainer can state an amount in any spelling. So do the owner's copy rules: the PRESSURE words
// (test/experience-pages.test.js), scarcity, popularity and rating claims ("seats left", "sells out",
// "rated", "reviews", "popular", "best"), and em or en dashes. Notes and summaries are cut by whole characters
// (never half a surrogate pair), with control characters turned into spaces, so the output is always storable.
// The explainer gets a fresh, frozen copy of the input holding only the ExplainInput fields.

/** How long an explainer may take before its output is replaced by RuleExplainer's. */
const EXPLAIN_TIMEOUT_MS = 200;
/** Longest note per alternative, and longest summary. */
const NOTE_MAX = 160;
const SUMMARY_MAX = 300;
/** Text matching this is dropped (no numbers or currencies from an explainer, ever). */
const FORBIDDEN_TEXT = /[0-9]|[$€£¥]|\bUSD\b/;

/** The explainers BUSINESS_EXPLAINER may name (config.js accepts only these). */
const EXPLAINERS = Object.freeze(['rules']);

/** Numbers and money in any other spelling (see the header). */
const ALSO_FORBIDDEN = [
  /[\p{Nd}\p{No}\p{Sc}]/u,
  /\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|percent|per cent)\b/i,
  /\b(?:dollars?|cents?|bucks?|euros?|pounds? sterling|dirhams?|riyals?|lira|liras|EGP|AED|SAR|GBP|EUR|usd)\b/i,
];

/** Copy Tripelyx never writes, so no explainer may either: pressure, scarcity, popularity, ratings, long dashes. */
const PRESSURE_TEXT = [
  /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i,
  /\b(?:left|sells? out|sold out|selling fast|going fast|rising|rated|ratings?|reviews?|reviewed|popular|popularity|best|bestsellers?|trending|in demand|high demand|most booked|travell?ers love)\b/i,
  /[\u2013\u2014]/,
];

const KINDS = ['fare', 'flight', 'stops', 'cabin', 'dates', 'room', 'hotel', 'all_within'];

const forbidden = s => {
  const n = s.normalize('NFKC');
  return FORBIDDEN_TEXT.test(n) || ALSO_FORBIDDEN.some(re => re.test(n)) || PRESSURE_TEXT.some(re => re.test(n));
};

/** A storable string: lone surrogates removed, control characters spaced out, cut to max whole characters. */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (forbidden(s)) return '';
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : s;
}

/** Only the ExplainInput fields, copied and frozen: what an explainer may see. */
function safeInput(input) {
  const i = input && typeof input === 'object' ? input : {};
  const freeze = o => Object.freeze(o);
  return freeze({
    violations: freeze((Array.isArray(i.violations) ? i.violations : []).map(v => freeze({ rule: String((v && v.rule) || '') }))),
    alternatives: freeze((Array.isArray(i.alternatives) ? i.alternatives : []).map(a => freeze({
      id: String((a && a.id) || ''),
      kind: KINDS.includes(a && a.kind) ? a.kind : 'flight',
      withinPolicy: !!(a && a.withinPolicy),
      savingsRank: a && Number.isSafeInteger(a.savingsRank) ? a.savingsRank : 0,
      giveUps: freeze((a && Array.isArray(a.giveUps) ? a.giveUps : []).filter(g => typeof g === 'string' && !/[$€£¥]|\bUSD\b/.test(g))),
    }))),
    noneWithin: !!i.noneWithin,
  });
}

// What each kind of change keeps and costs, in plain words.
const KIND_NOTES = {
  fare: 'Same flight on a cheaper fare: you keep your times',
  flight: 'Another flight on the same day and route',
  stops: 'A flight with a stop on the way, so the trip takes longer',
  cabin: 'A lower cabin on the same route',
  dates: 'The same trip moved to nearby dates',
  room: 'Another room in the same hotel',
  hotel: 'Another hotel in the same city',
  all_within: 'The parts of your trip outside your policy swapped for their cheapest options inside it',
};

/** What the give-ups add up to, in words with no numbers. */
function costs(giveUps) {
  const out = [];
  const any = re => giveUps.some(g => re.test(g));
  if (any(/checked bag|cabin bag/i)) out.push('fewer bags');
  if (any(/refunds/i)) out.push('a smaller refund');
  if (any(/no changes|no free changes/i)) out.push('stricter change rules');
  if (any(/^(outbound: |return: )?(leaves|arrives)/i)) out.push('different times');
  if (any(/-star instead of/i)) out.push('fewer stars');
  if (any(/^sleeps /i)) out.push('a smaller room');
  if (any(/can't be cancelled|free cancellation ends/i)) out.push('stricter cancellation');
  return out;
}

const joinWords = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

const RULE_WORDS = {
  'flight.cap': 'price', 'hotel.cap': 'price', 'trip.cap': 'price', 'flight.cabin': 'cabin', 'flight.advance': 'how far ahead it was planned',
  'hotel.advance': 'how far ahead it was planned', 'flight.stops': 'stops', 'flight.refundable': 'refund terms',
  'hotel.refundable': 'cancellation terms', 'flight.carrier': 'airline', 'hotel.stars': 'hotel class', budget: 'budget',
  'inventory.unavailable': 'availability',
};

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
  async explain(input, opts) {
    const i = safeInput(input);
    const notes = {};
    for (const a of i.alternatives) {
      const lost = costs(a.giveUps).slice(0, 2);
      const nothing = a.giveUps.length === 0 || a.giveUps.every(g => g === 'Nothing else changes');
      let note = KIND_NOTES[a.kind] || KIND_NOTES.flight;
      if (lost.length) note += `, with ${joinWords(lost)}`;
      else if (nothing) note += ', and nothing else changes';
      note += a.withinPolicy ? '. It fits your policy.' : '. It still needs approval.';
      notes[a.id] = note;
    }
    let summary;
    if (i.noneWithin) {
      summary = 'No cheaper option inside your policy turned up in this search. You can still request approval with a reason.';
    } else {
      const reasons = [...new Set(i.violations.map(v => RULE_WORDS[v.rule]).filter(Boolean))];
      summary = `${reasons.length ? `Your pick is outside your policy on ${joinWords(reasons)}. ` : ''}`
        + 'These options come from the same search, with the ones inside your policy first.';
    }
    return { order: i.alternatives.map(a => a.id), notes, summary };
  }
}

/**
 * Make an explainer's output safe to show: keep known ids only (missing ones appended in input order, no
 * duplicates); drop any note or summary matching FORBIDDEN_TEXT (or any other spelling of an amount, or
 * pressure, scarcity, popularity or rating copy, or a long dash: see the header); cut notes to NOTE_MAX and
 * the summary to SUMMARY_MAX characters; non-string values become ''.
 * @param {unknown} out what the explainer returned
 * @param {import('./types').ExplainInput} input
 * @returns {import('./types').ExplainOutput}
 */
function guardExplanation(out, input) {
  const ids = safeInput(input).alternatives.map(a => a.id);
  const known = new Set(ids);
  const o = out && typeof out === 'object' ? out : {};
  const order = [];
  for (const id of Array.isArray(o.order) ? o.order : []) {
    if (typeof id === 'string' && known.has(id) && !order.includes(id)) order.push(id);
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const given = o.notes && typeof o.notes === 'object' ? o.notes : {};
  const notes = {};
  for (const id of ids) notes[id] = clean(Object.hasOwn(given, id) ? given[id] : '', NOTE_MAX);
  return { order, notes, summary: clean(o.summary, SUMMARY_MAX) };
}

/** Run one explainer under the timeout; resolves to its raw output, rejects on a throw or the timeout. */
function runWithTimeout(explainer, input, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('[business] explainer timed out')); }, ms);
  });
  const run = Promise.resolve().then(() => explainer.explain(input, { signal: controller.signal }));
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The explainer the service uses: the configured one, run with an AbortSignal and EXPLAIN_TIMEOUT_MS, its
 * output through guardExplanation; on a throw or timeout, RuleExplainer's output. Its explain() never rejects.
 * Called once at boot (app.js); it must not throw for a valid config.
 * @param {object} config the app config (config.business.explainer)
 * @param {{ explainer?: import('./types').AlternativesExplainer }} [opts] run this explainer in place of the
 *   configured one's built-in instance (tests; where a model would plug in later, on the owner's word)
 * @returns {import('./types').GuardedExplainer}
 * @throws {Error} at boot when config.business.explainer is not one of EXPLAINERS
 */
function createExplainer(config, { explainer = null } = {}) {
  const name = config && config.business && config.business.explainer;
  if (!EXPLAINERS.includes(name)) throw new Error(`[business] unknown explainer ${name}`);
  const rules = new RuleExplainer();
  const inner = explainer || rules;
  return Object.freeze({
    name,
    async explain(input) {
      const safe = safeInput(input);
      try {
        return guardExplanation(await runWithTimeout(inner, safe, EXPLAIN_TIMEOUT_MS), safe);
      } catch {
        return guardExplanation(await rules.explain(safe), safe);
      }
    },
  });
}

module.exports = {
  EXPLAIN_TIMEOUT_MS, NOTE_MAX, SUMMARY_MAX, FORBIDDEN_TEXT, EXPLAINERS, RuleExplainer, guardExplanation, createExplainer,
};
