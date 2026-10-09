// Department budgets per period, holds and releases (plan §C6, §H4). BusinessService methods (service.js
// assigns `methods` onto its prototype); `this` is the service. The pure helpers are exported for
// requests.js, reports.js, the views and anyone else (they need no store and no clock).
// The pure helpers (periodKey, periodLabel, currentPeriodKey, periodChoices, committedCents) were built in
// Stage 0, like tz.js, because 1P, 1V, 1W-a and 1W-b all need them; their signatures and results never change.
// The service methods (listBudgets, setBudget) are Stage 1W-b's.
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
const { AppError } = require('../lib/errors');
const { format } = require('../lib/money');
const { KINDS, SCAN_CAP, CURRENCY } = require('./constants');
const { can } = require('./roles');
const { loadActor, need, who, auditInsert, notFound } = require('./actor');
const { dollarsToCents, collect } = require('./validate');

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

// ---------------------------------------------------------------------------------------------------------
// Service side (not exported: the frozen export list is above)

/** A budget record's id. */
const budgetIdOf = (orgId, departmentId, key) => `${orgId}.${departmentId}.${key}`;
/** The period kind a key names. */
const kindOf = key => (String(key).includes('Q') ? 'quarter' : 'month');
/** A form's rev (an integer or a digit string) as a number, or NaN. */
const formRev = rev => (typeof rev === 'number' ? (Number.isInteger(rev) && rev >= 0 ? rev : NaN) : /^\d{1,9}$/.test(String(rev ?? '')) ? Number(rev) : NaN);
/** The 409 for a stale budget form (plan §B6 "Stale rev"). */
const stale = () => new AppError('conflict', 'Someone changed this while you were looking. Here is the latest version.', 409);
const fieldError = message => new AppError('invalid_field', message, 422);

/** The period a page asks for: blank → the company's current one; a malformed key → 422 'invalid_period'. */
function requestedPeriod(org, key, now) {
  if (key === null || key === undefined || key === '') return currentPeriodKey(org, now);
  if (typeof key !== 'string' || !PERIOD_KEY_RE.test(key)) throw new AppError('invalid_period', 'Choose a period like 2026-Q4.', 422, { period: 'Choose a period like 2026-Q4.' });
  return key;
}

/**
 * Σ totals of the company's effectively pending requests per department for one period ("Awaiting
 * approval"), paging the requests newest first up to SCAN_CAP. Never counted as committed.
 * @returns {Promise<{ sums: Map<string, number>, truncated: boolean }>}
 */
async function awaitingByDepartment(svc, org, key, departmentIds) {
  const sums = new Map();
  const nowIso = svc.repo.iso();
  const kind = kindOf(key);
  let cursor = null, scanned = 0;
  do {
    const page = await svc.repo.page(KINDS.request, org.id, { limit: 200, cursor });
    for (const r of page.rows) {
      if (r.status !== 'pending' || !departmentIds.has(r.departmentId)) continue;
      if (svc.policy.effectiveStatus(r, nowIso, org.timezone) !== 'pending') continue;
      if (periodKey(r.query.departDate, kind) !== key) continue;
      sums.set(r.departmentId, (sums.get(r.departmentId) || 0) + r.totalCents);
    }
    scanned += page.rows.length;
    cursor = page.cursor;
  } while (cursor && scanned < SCAN_CAP);
  return { sums, truncated: !!cursor };
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
  async listBudgets(actor, periodKey) {
    const a = await loadActor(this.repo, actor);
    need(a, 'budget.view.dept');
    const key = requestedPeriod(a.org, periodKey, this.now());
    const orgId = a.org.id;
    let departments = await this.repo.list(KINDS.department, orgId);
    if (!can(a.member.role, 'budget.view.all')) departments = departments.filter(d => !!a.member.departmentId && d.id === a.member.departmentId);
    if (!departments.length) return [];
    const budgets = await Promise.all(departments.map(d => this.repo.getIn(KINDS.budget, budgetIdOf(orgId, d.id, key), orgId)));
    const { sums, truncated } = await awaitingByDepartment(this, a.org, key, new Set(departments.map(d => d.id)));
    const rows = departments.map((d, i) => {
      const b = budgets[i];
      const committed = committedCents(b);
      return {
        department: { id: d.id, name: d.name, archived: !!d.archivedAt },
        periodKey: key,
        budgetId: b ? budgetIdOf(orgId, d.id, key) : null,
        amountCents: b ? b.amountCents : null,
        committedCents: committed,
        awaitingCents: sums.get(d.id) || 0,
        remainingCents: b ? b.amountCents - committed : null,
        currency: CURRENCY,
        rev: b ? (b.rev ?? 0) : null,
        truncated,
      };
    }).filter(r => !r.department.archived || r.budgetId);
    return rows.sort((x, y) => Number(x.department.archived) - Number(y.department.archived)
      || x.department.name.localeCompare(y.department.name, 'en') || (x.department.id < y.department.id ? -1 : 1));
  },

  /**
   * Set (or change) a department's budget for a period (budget.edit; POST /budgets). One commit: biz_budget
   * insert (rev null in the form) or CAS on the form's rev (commits kept), audit 'budget.set' with the
   * department, period, from and to amounts. A budget may be set below what is already committed (the page
   * then shows a negative remaining; nothing is released).
   * The period must be of the company's budget period kind (a quarter like 2026-Q4, or a month like 2026-11).
   * An unchanged amount writes nothing and returns the stored budget.
   * @param {import('./types').MemberActor} actor
   * @param {string} departmentId an active department of this company
   * @param {import('./types').PeriodKey} periodKey
   * @param {string|number|null} rev the budget record's rev, or empty/null for a new budget
   * @param {string} amountDollars the form value, through validate.dollarsToCents
   * @returns {Promise<import('./types').Budget>}
   * @throws {AppError} 403; 404 unknown or archived department; 422 'invalid_budget' with details
   *   (amount, period); 409 'conflict' (stale rev, or a budget created meanwhile)
   */
  async setBudget(actor, departmentId, periodKey, rev, amountDollars) {
    const a = await loadActor(this.repo, actor);
    need(a, 'budget.edit');
    const orgId = a.org.id;
    const dep = typeof departmentId === 'string' && departmentId ? await this.repo.getIn(KINDS.department, departmentId, orgId) : null;
    if (!dep || dep.archivedAt) throw notFound();
    const kind = a.org.settings.budgetPeriod === 'month' ? 'month' : 'quarter';
    const v = collect('invalid_budget', {
      amount: () => dollarsToCents(amountDollars),
      period: () => {
        if (typeof periodKey !== 'string' || !PERIOD_KEY_RE.test(periodKey) || kindOf(periodKey) !== kind) {
          throw fieldError(kind === 'month' ? 'Choose a month like 2026-11.' : 'Choose a quarter like 2026-Q4.');
        }
        return periodKey;
      },
    });
    const id = budgetIdOf(orgId, dep.id, v.period);
    const now = this.repo.iso();
    const by = who(a);
    const label = periodLabel(v.period);
    const target = { kind: KINDS.budget, id };
    const cur = await this.repo.getIn(KINDS.budget, id, orgId);
    const blank = rev === null || rev === undefined || String(rev).trim() === '';
    if (blank) {
      if (cur) throw stale();
      const data = {
        orgId, departmentId: dep.id, periodKey: v.period, amountCents: v.amount, currency: CURRENCY, commits: {},
        at: now, updatedAt: now, updatedBy: by, rev: 0,
      };
      try {
        const docs = await this.repo.commit({
          inserts: [
            { kind: KINDS.budget, id, data, owner: orgId },
            auditInsert(this.repo, {
              orgId, actor: by, action: 'budget.set', target, summary: `${by.name} set the ${dep.name} budget for ${label} to ${format(v.amount)}`,
              changes: [{ path: 'amountCents', before: null, after: v.amount }],
            }),
          ],
        });
        return docs[`${KINDS.budget}:${id}`];
      } catch (e) {
        if (e instanceof AppError && e.code === 'already_exists') throw stale();
        throw e;
      }
    }
    if (!cur) throw notFound();
    if (formRev(rev) !== (cur.rev ?? 0)) throw stale();
    if (cur.amountCents === v.amount) return cur;
    try {
      const docs = await this.repo.commit({
        cas: [{ kind: KINDS.budget, id, rev, fn: d => { d.amountCents = v.amount; d.updatedAt = now; d.updatedBy = by; } }],
        inserts: [auditInsert(this.repo, {
          orgId, actor: by, action: 'budget.set', target,
          summary: `${by.name} changed the ${dep.name} budget for ${label} from ${format(cur.amountCents)} to ${format(v.amount)}`,
          changes: [{ path: 'amountCents', before: cur.amountCents, after: v.amount }],
        })],
      });
      return docs[`${KINDS.budget}:${id}`];
    } catch (e) {
      if (e instanceof AppError && e.code === 'conflict') throw stale();
      throw e;
    }
  },
};

module.exports = { methods, PERIOD_KEY_RE, periodKey, periodLabel, currentPeriodKey, periodChoices, committedCents };
