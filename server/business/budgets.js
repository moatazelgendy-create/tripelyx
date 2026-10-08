// Department budgets per period, holds and releases (plan §C6, §H4). BusinessService methods (service.js
// assigns `methods` onto its prototype); `this` is the service. The pure helpers are exported for
// requests.js and reports.js.
// STUB from Stage 0 with the frozen interface; Stage 1W-b builds it.
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

function notBuilt() { throw new Error('[business] not built'); }

/** A period key: '2026-Q4' (quarter) or '2026-11' (month). */
const PERIOD_KEY_RE = /^(\d{4})-(Q[1-4]|0[1-9]|1[0-2])$/;

/**
 * The budget period a date falls in.
 * @param {string} date 'YYYY-MM-DD' (the departure's local date)
 * @param {import('./types').BudgetPeriod} period
 * @returns {import('./types').PeriodKey} '2026-Q4' or '2026-11'
 * @throws {RangeError} a malformed date or an unknown period
 */
function periodKey(date, period) { notBuilt(); }

/**
 * A period key in words.
 * @param {import('./types').PeriodKey} key
 * @returns {string} 'Q4 2026' or 'November 2026'
 * @throws {RangeError} a malformed key
 */
function periodLabel(key) { notBuilt(); }

/**
 * The company's current period: periodKey(tz.localDate(org.timezone, now), org.settings.budgetPeriod).
 * @param {import('./types').Org} org
 * @param {Date} now
 * @returns {import('./types').PeriodKey}
 */
function currentPeriodKey(org, now) { notBuilt(); }

/**
 * The period keys the /budgets switcher offers: the current one, 2 before and 3 after, oldest first.
 * @param {import('./types').PeriodKey} current
 * @returns {import('./types').PeriodKey[]}
 */
function periodChoices(current) { notBuilt(); }

/**
 * Σ commits of a budget record, optionally leaving one request's own hold out.
 * @param {import('./types').Budget} budget
 * @param {string} [exceptRequestId]
 * @returns {number} cents
 */
function committedCents(budget, exceptRequestId) { notBuilt(); }

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
