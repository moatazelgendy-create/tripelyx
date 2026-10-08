// Department budgets per period, holds and releases (plan §C6, §H4). BusinessService methods (service.js
// assigns `methods` onto its prototype); `this` is the service. The pure helpers are exported for
// requests.js, reports.js, the views and anyone else (they need no store and no clock).
// The service methods are a STUB from Stage 0 with the frozen interface; Stage 1W-b builds them. The pure
// helpers (periodKey, periodLabel, currentPeriodKey, periodChoices, committedCents) are BUILT in Stage 0,
// like tz.js, because 1P, 1V, 1W-a and 1W-b all need them in parallel; 1W-b owns this file from here on and
// may add to them, but never changes these signatures or results.
//
// - A budget is biz_budget id `${orgId}.${departmentId}.${periodKey}` with amountCents and
//   commits { [requestId]: cents } (types.Budget). Committed = Σ commits; remaining = amount − committed.
// - Holds and releases happen inside the request commits of requests.js (submit within, approve, cancel an
//   approved request): a budget CAS fn that adds or deletes the request's key, idempotent (a key already
//   present, or already absent, changes nothing), refusing an approval that would go over unless the decider
//   acknowledged it (manual only). Two racing approvals are serialised by CAS; the loser re-runs under
//   repo.withRetry and re-checks what remains, so there is no overspend.
// - "Awaiting approval" pages through the company's pending requests for that department and period
//   (bounded by constants.SCAN_CAP, then `truncated`). Never counted as committed.
// - "Spent" is not tracked in phase 1 ("Not yet: shows once real bookings exist").

const tz = require('./tz');

function notBuilt() { throw new Error('[business] not built'); }

/** A period key: '2026-Q4' (quarter) or '2026-11' (month). */
const PERIOD_KEY_RE = /^(\d{4})-(Q[1-4]|0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

/** A key's year and its index in that year (quarter 0..3 or month 0..11), or a RangeError. */
function parseKey(key) {
  const m = typeof key === 'string' ? PERIOD_KEY_RE.exec(key) : null;
  if (!m) throw new RangeError(`[business] not a period key: ${String(key).slice(0, 20)}`);
  const quarter = m[2].startsWith('Q');
  return { year: Number(m[1]), quarter, index: quarter ? Number(m[2].slice(1)) - 1 : Number(m[2]) - 1 };
}

/** The key for a year and an index (which may run past either end of the year). */
function makeKey(year, index, quarter) {
  const per = quarter ? 4 : 12;
  const y = year + Math.floor(index / per);
  const i = ((index % per) + per) % per;
  return quarter ? `${y}-Q${i + 1}` : `${y}-${String(i + 1).padStart(2, '0')}`;
}

/**
 * The budget period a date falls in.
 * @param {string} date 'YYYY-MM-DD' (the departure's local date)
 * @param {import('./types').BudgetPeriod} period
 * @returns {import('./types').PeriodKey} '2026-Q4' or '2026-11'
 * @throws {RangeError} a malformed date or an unknown period
 */
function periodKey(date, period) {
  const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
  if (!m || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new RangeError(`[business] not a date: ${String(date).slice(0, 20)}`);
  const month = Number(m[2]);
  if (period === 'quarter') return `${m[1]}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === 'month') return `${m[1]}-${m[2]}`;
  throw new RangeError(`[business] unknown budget period: ${String(period).slice(0, 20)}`);
}

/**
 * A period key in words.
 * @param {import('./types').PeriodKey} key
 * @returns {string} 'Q4 2026' or 'November 2026'
 * @throws {RangeError} a malformed key
 */
function periodLabel(key) {
  const { year, quarter, index } = parseKey(key);
  return quarter ? `Q${index + 1} ${year}` : `${MONTHS[index]} ${year}`;
}

/**
 * The company's current period: periodKey(tz.localDate(org.timezone, now), org.settings.budgetPeriod).
 * @param {import('./types').Org} org
 * @param {Date|string|number} now the injected clock's instant
 * @returns {import('./types').PeriodKey}
 */
function currentPeriodKey(org, now) {
  return periodKey(tz.localDate(org.timezone, now), org.settings.budgetPeriod);
}

/**
 * The period keys the /budgets switcher offers: the current one, 2 before and 3 after, oldest first
 * (crossing years: '2026-Q4' → 2026-Q2 … 2027-Q3; '2026-11' → 2026-09 … 2027-02).
 * @param {import('./types').PeriodKey} current
 * @returns {import('./types').PeriodKey[]}
 * @throws {RangeError} a malformed key
 */
function periodChoices(current) {
  const { year, quarter, index } = parseKey(current);
  return [-2, -1, 0, 1, 2, 3].map(d => makeKey(year, index + d, quarter));
}

/**
 * Σ commits of a budget record, optionally leaving one request's own hold out. 0 for a missing budget.
 * @param {import('./types').Budget|null} budget
 * @param {string} [exceptRequestId]
 * @returns {number} cents
 * @throws {RangeError} a hold that is not whole cents
 */
function committedCents(budget, exceptRequestId) {
  const commits = (budget && budget.commits) || {};
  let sum = 0;
  for (const [rid, cents] of Object.entries(commits)) {
    if (rid === exceptRequestId) continue;
    if (!Number.isInteger(cents)) throw new RangeError(`[business] budget hold ${rid} is not whole cents`);
    sum += cents;
  }
  return sum;
}

const methods = {
  /**
   * The /budgets page rows for a period: every department (archived ones only when they have a budget for
   * the period), each with its budget, committed, awaiting and remaining. budget.view.all sees every
   * department; budget.view.dept only the member's own (an empty list when they have none).
   * @param {import('./types').MemberActor} actor
   * @param {import('./types').PeriodKey|null} periodKey null = the current period
   * @returns {Promise<import('./types').BudgetRow[]>}
   * @throws {AppError} 403 'forbidden'; 422 'invalid_period' for a malformed key ("Choose a period like 2026-Q4.")
   */
  async listBudgets(actor, periodKey) { notBuilt(); },

  /**
   * Set (or change) a department's budget for a period (budget.edit; POST /budgets). One commit: biz_budget
   * insert (rev null in the form) or CAS on the form's rev (commits kept), audit 'budget.set' with the
   * department, period, from and to amounts. A budget may be set below what is already committed (the page
   * then shows a negative remaining; nothing is released).
   * @param {import('./types').MemberActor} actor
   * @param {string} departmentId an active department of this company
   * @param {import('./types').PeriodKey} periodKey
   * @param {string|number|null} rev the budget record's rev, or empty/null for a new budget
   * @param {string} amountDollars the form value, through validate.dollarsToCents
   * @returns {Promise<import('./types').Budget>}
   * @throws {AppError} 403; 404 unknown or archived department; 422 'invalid_budget' with details
   *   (amount, period); 409 'conflict' (stale rev, or a budget created meanwhile)
   */
  async setBudget(actor, departmentId, periodKey, rev, amountDollars) { notBuilt(); },
};

module.exports = { methods, PERIOD_KEY_RE, periodKey, periodLabel, currentPeriodKey, periodChoices, committedCents };
