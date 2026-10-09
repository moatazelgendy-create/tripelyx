// Role-aware home and the Reports page (plan §H5): pure tile functions over paged records, and the service
// method that pages the records (bounded by constants.SCAN_CAP, then `truncated`: "Based on the 5,000 most
// recent requests"). BusinessService methods (service.js assigns `methods` onto its prototype).
//
// - Every money tile is calculated on demo prices (the view says so). Coming soon tiles (COMING_SOON) never
//   show a number and never $0. Empty periods say "No requests yet", never $0.
// - Statuses are effective statuses (this.policy.effectiveStatus with the org's time zone); nothing is
//   written by a report.
// - A request belongs to the period of its departure date (budgets.periodKey(query.departDate, period)).

const { AppError } = require('../lib/errors');
const { KINDS, SCAN_CAP, REQUEST_STATUSES, GENERAL_DEPARTMENT } = require('./constants');
const roles = require('./roles');
const { loadActor, need, notFound } = require('./actor');
const { periodKey, periodLabel, currentPeriodKey, PERIOD_KEY_RE } = require('./budgets');
const { HOME_ROWS } = require('./requests');

/** Tiles for what phase 1 cannot measure yet. Never a number, never $0. */
const COMING_SOON = Object.freeze([
  Object.freeze({ key: 'spend', label: 'Spend booked' }),
  Object.freeze({ key: 'invoices', label: 'Invoices' }),
]);
/** How many rules "Top reasons" lists. */
const TOP_REASONS = 5;
/** Recent activity rows on the admin home. */
const RECENT_ROWS = 5;
/** Dashboard views. */
const VIEWS = Object.freeze(['home', 'reports']);

/** Every status a page shows (the stored ones and 'past'). */
const EFFECTIVE_STATUSES = Object.freeze([...REQUEST_STATUSES, 'past']);
/** Rule id → the words the "Top reasons" tile uses. */
const RULE_LABELS = Object.freeze({
  'flight.cap': 'Flight over the price limit',
  'flight.cabin': 'Cabin above the policy',
  'flight.advance': 'Flight planned too close to departure',
  'flight.stops': 'More stops than the policy allows',
  'flight.refundable': 'Fare refunds less than the policy asks',
  'flight.carrier': "An airline the company doesn't use",
  'hotel.cap': 'Hotel over the nightly limit',
  'hotel.stars': 'Hotel above the star limit',
  'hotel.advance': 'Hotel planned too close to the stay',
  'hotel.refundable': "Hotel rate that isn't refundable",
  'trip.cap': 'Trip over the total limit',
  budget: 'Over the department budget',
  'inventory.unavailable': 'Option no longer available',
});

/**
 * Out-of-policy share: requests submitted out of policy or blocked ÷ requests submitted (drafts never
 * submitted are left out), in integer tenths of a percent rounded half up.
 * @param {import('./types').Request[]} requests
 * @returns {import('./types').OutOfPolicyShare}
 */
function outOfPolicyShare(requests) {
  const submitted = (requests || []).filter(r => r && r.submittedAt);
  const outOrBlocked = submitted.filter(r => r.evaluation && (r.evaluation.status === 'out' || r.evaluation.status === 'blocked')).length;
  const n = submitted.length;
  // round(outOrBlocked / n × 1000), half up, in integers.
  return { tenths: n ? Math.floor((outOrBlocked * 2000 + n) / (2 * n)) : null, submitted: n, outOrBlocked };
}

/**
 * The most frequent violation rules across the requests' evaluations, most first, then by rule id.
 * @param {import('./types').Request[]} requests
 * @param {number} [limit] default TOP_REASONS
 * @returns {import('./types').ReasonCount[]}
 */
function topReasons(requests, limit = TOP_REASONS) {
  const counts = new Map();
  for (const r of requests || []) {
    const rules = new Set(((r && r.evaluation && r.evaluation.violations) || []).map(v => v && v.rule).filter(x => typeof x === 'string'));
    for (const rule of rules) counts.set(rule, (counts.get(rule) || 0) + 1);
  }
  return [...counts].map(([rule, count]) => ({ rule, label: Object.hasOwn(RULE_LABELS, rule) ? RULE_LABELS[rule] : rule, count }))
    .sort((x, y) => y.count - x.count || (x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : 0))
    .slice(0, Number.isInteger(limit) && limit > 0 ? limit : TOP_REASONS);
}

/**
 * What switching to cheaper options saved: over approved requests (stored status, so departed ones count and
 * cancelled or denied ones never do), each request's Σ savedCents of its 'swapped' history lines (the pick's
 * total as it stood minus the option's, priced at the switch), floored at 0 per request. A price that
 * moved later (a re-price on submit or on approval) is not a saving from switching, so originalTotalCents −
 * totalCents is never used.
 * @param {import('./types').Request[]} requests
 * @returns {number} cents (never negative)
 */
function savedBySwitching(requests) {
  let sum = 0;
  for (const r of requests || []) {
    if (!r || r.status !== 'approved' || !Array.isArray(r.history)) continue;
    let saved = 0;
    for (const h of r.history) if (h && h.action === 'swapped' && Number.isSafeInteger(h.savedCents)) saved += h.savedCents;
    if (saved > 0) sum += saved;
  }
  return sum;
}

/**
 * Every Reports tile for one period.
 * @param {{ requests: import('./types').Request[], budgets: import('./types').BudgetRow[], nowIso: string,
 *   timezone: string, truncated: boolean, effectiveStatus: (request: import('./types').Request, nowIso: string, timezone: string) => import('./types').EffectiveStatus }} input
 *   effectiveStatus: this.policy.effectiveStatus (passed in so the tiles stay pure)
 * @returns {import('./types').ReportTiles}
 */
function reportTiles(input) {
  const { requests = [], budgets = [], nowIso, timezone = 'UTC', truncated = false, effectiveStatus } = input || {};
  if (typeof effectiveStatus !== 'function') throw new TypeError('[business] reportTiles needs effectiveStatus');
  const byStatus = Object.fromEntries(EFFECTIVE_STATUSES.map(s => [s, 0]));
  const travelers = new Map();
  for (const r of requests) {
    const status = effectiveStatus(r, nowIso, timezone);
    if (Object.hasOwn(byStatus, status)) byStatus[status] += 1;
    const t = travelers.get(r.travelerId) || { userId: r.travelerId, name: r.travelerName, requests: 0, committedCents: 0 };
    t.requests += 1;
    if (r.status === 'approved' && Number.isInteger(r.totalCents)) t.committedCents += r.totalCents;
    travelers.set(r.travelerId, t);
  }
  const submitted = requests.filter(r => r.submittedAt);
  return {
    byStatus,
    outOfPolicyShare: outOfPolicyShare(requests),
    topReasons: topReasons(submitted),
    committedVsBudget: budgets,
    savedBySwitchingCents: savedBySwitching(requests),
    byTraveler: [...travelers.values()].sort((x, y) => y.committedCents - x.committedCents || y.requests - x.requests
      || String(x.name).localeCompare(String(y.name), 'en') || (x.userId < y.userId ? -1 : 1)),
    comingSoon: COMING_SOON.map(t => ({ key: t.key, label: t.label })),
    truncated: truncated === true,
  };
}

/**
 * The setup checklist, ticked from data: policyReviewed (any tier past version 1), departments (more than
 * General, or any budget), invited (any invite or a second member), demoTrip (any request).
 * @param {{ policies: import('./types').Policy[], departments: import('./types').Department[], budgets: number,
 *   invites: number, memberCount: number, requests: number }} input
 * @returns {import('./types').Checklist}
 */
function checklist(input) {
  const i = input || {};
  const departments = Array.isArray(i.departments) ? i.departments : [];
  return {
    policyReviewed: (i.policies || []).some(p => p && p.version > 1),
    departments: departments.length > 1 || departments.some(d => d && d.name !== GENERAL_DEPARTMENT) || i.budgets > 0,
    invited: i.invites > 0 || i.memberCount > 1,
    demoTrip: i.requests > 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Service side

/** Pages of the team list the Manager home reads to find HOME_ROWS requests of other travelers. */
const TEAM_PAGES = 3;

/** The period a page asks for: blank → the company's current one; a malformed key → 422 'invalid_period'. */
function requestedPeriod(org, key, now) {
  if (key === null || key === undefined || key === '') return currentPeriodKey(org, now);
  if (typeof key !== 'string' || !PERIOD_KEY_RE.test(key)) throw new AppError('invalid_period', 'Choose a period like 2026-Q4.', 422, { period: 'Choose a period like 2026-Q4.' });
  return key;
}

/** The company's requests, newest stored first, up to SCAN_CAP (truncated when more remain). */
async function scanRequests(repo, orgId) {
  const rows = [];
  let cursor = null;
  do {
    const page = await repo.page(KINDS.request, orgId, { limit: 200, cursor });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor && rows.length < SCAN_CAP);
  return { rows, truncated: !!cursor };
}

const methods = {
  /**
   * The role-aware home (view 'home', org.view) or the Reports page (view 'reports', reports.view).
   * Sections the member's role does not reach are null (types.DashboardView). teamTrips (request.view.team)
   * is the Manager home's "team trips this period": the HOME_ROWS newest requests the member reaches through
   * roles.allowed 'request.view.team' (their own left out) departing in the period.
   * @param {import('./types').MemberActor} actor
   * @param {{ periodKey?: string|null, view?: 'home'|'reports' }} [opts] periodKey null = the current period
   * @returns {Promise<import('./types').DashboardView>}
   * @throws {AppError} 403 'forbidden' (reports without reports.view); 422 'invalid_period'
   */
  async dashboard(actor, opts) {
    const a = await loadActor(this.repo, actor);
    need(a, 'org.view');
    const o = opts && typeof opts === 'object' ? opts : {};
    const view = o.view === undefined || o.view === null || o.view === '' ? 'home' : o.view;
    if (!VIEWS.includes(view)) throw notFound();
    if (view === 'reports') need(a, 'reports.view');
    const now = this.now();
    const nowIso = this.repo.iso();
    const key = requestedPeriod(a.org, o.periodKey, now);
    const orgId = a.org.id;
    const me = a.member.userId;
    const role = a.member.role;
    const holds = perm => roles.can(role, perm);
    const status = r => this.policy.effectiveStatus(r, nowIso, a.org.timezone);

    // The company's requests (newest stored first, up to SCAN_CAP), only for the sections that use them.
    const wantsScan = holds('request.view.all') || holds('reports.view') || role === 'owner' || role === 'travel_admin';
    const scanned = wantsScan ? await scanRequests(this.repo, orgId) : { rows: [], truncated: false };
    const kind = key.includes('Q') ? 'quarter' : 'month';
    const inPeriod = scanned.rows.filter(r => r.query && periodKey(r.query.departDate, kind) === key);

    let checklistView = null;
    if (role === 'owner' || role === 'travel_admin') {
      const [policies, departments, budgets, invites] = await Promise.all([
        this.repo.list(KINDS.policy, orgId), this.repo.list(KINDS.department, orgId),
        this.repo.page(KINDS.budget, orgId, { limit: 1 }), this.repo.page(KINDS.invite, orgId, { limit: 1 }),
      ]);
      checklistView = checklist({
        policies, departments, budgets: budgets.rows.length, invites: invites.rows.length, memberCount: a.org.memberCount,
        requests: scanned.rows.length,
      });
    }

    let waiting = null;
    if (holds('approval.decide')) {
      const inbox = await this.inbox(actor, { tab: 'waiting' });
      waiting = { count: inbox.counts.waiting, rows: inbox.rows.slice(0, HOME_ROWS) };
    }
    const myTrips = (await this.listRequests(actor, { scope: 'mine' })).rows.slice(0, HOME_ROWS);

    let teamTrips = null;
    if (holds('request.view.team')) {
      teamTrips = [];
      let cursor = null, pages = 0;
      do {
        const page = await this.listRequests(actor, { scope: 'team', period: key, cursor });
        teamTrips.push(...page.rows.filter(r => r.travelerId !== me));
        cursor = page.cursor;
        pages += 1;
      } while (cursor && teamTrips.length < HOME_ROWS && pages < TEAM_PAGES);
      teamTrips = teamTrips.slice(0, HOME_ROWS);
    }

    const policy = (await this.getPolicy(actor, null)).description;
    const pendingCompany = holds('request.view.all') ? { count: scanned.rows.filter(r => status(r) === 'pending').length } : null;
    const reportsView = holds('reports.view');
    const recent = holds('audit.view') ? (await this.repo.page(KINDS.audit, orgId, { limit: RECENT_ROWS })).rows : null;
    const budgets = holds('budget.view.dept') ? await this.listBudgets(actor, key) : null;
    const reports = view === 'reports'
      ? reportTiles({ requests: inPeriod, budgets: budgets || [], nowIso, timezone: a.org.timezone, truncated: scanned.truncated, effectiveStatus: this.policy.effectiveStatus })
      : null;
    return {
      role, periodKey: key, periodLabel: periodLabel(key), checklist: checklistView, waiting, myTrips, teamTrips, policy, pendingCompany,
      outOfPolicyShare: reportsView ? outOfPolicyShare(inPeriod) : null,
      topReasons: reportsView ? topReasons(inPeriod.filter(r => r.submittedAt)) : null,
      recent, budgets, reports,
    };
  },
};

module.exports = {
  methods, COMING_SOON, TOP_REASONS, RECENT_ROWS, VIEWS,
  outOfPolicyShare, topReasons, savedBySwitching, reportTiles, checklist,
};
