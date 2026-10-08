// Role-aware home and the Reports page (plan §H5): pure tile functions over paged records, and the service
// method that pages the records (bounded by constants.SCAN_CAP, then `truncated`: "Based on the 5,000 most
// recent requests"). BusinessService methods (service.js assigns `methods` onto its prototype).
// STUB from Stage 0 with the frozen interface; Stage 1W-b builds it.
//
// - Every money tile is calculated on demo prices (the view says so). Coming soon tiles (COMING_SOON) never
//   show a number and never $0. Empty periods say "No requests yet", never $0.
// - Statuses are effective statuses (this.policy.effectiveStatus with the org's time zone); nothing is
//   written by a report.
// - A request belongs to the period of its departure date (budgets.periodKey(query.departDate, period)).

function notBuilt() { throw new Error('[business] not built'); }

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

/**
 * Out-of-policy share: requests submitted out of policy or blocked ÷ requests submitted (drafts never
 * submitted are left out), in integer tenths of a percent rounded half up.
 * @param {import('./types').Request[]} requests
 * @returns {import('./types').OutOfPolicyShare}
 */
function outOfPolicyShare(requests) { notBuilt(); }

/**
 * The most frequent violation rules across the requests' evaluations, most first, then by rule id.
 * @param {import('./types').Request[]} requests
 * @param {number} [limit] default TOP_REASONS
 * @returns {import('./types').ReasonCount[]}
 */
function topReasons(requests, limit) { notBuilt(); }

/**
 * Σ (originalTotalCents − totalCents) over approved requests whose history has a swap.
 * @param {import('./types').Request[]} requests
 * @returns {number} cents (never negative)
 */
function savedBySwitching(requests) { notBuilt(); }

/**
 * Every Reports tile for one period.
 * @param {{ requests: import('./types').Request[], budgets: import('./types').BudgetRow[], nowIso: string,
 *   timezone: string, truncated: boolean, effectiveStatus: (request: import('./types').Request, nowIso: string, timezone: string) => import('./types').EffectiveStatus }} input
 *   effectiveStatus: this.policy.effectiveStatus (passed in so the tiles stay pure)
 * @returns {import('./types').ReportTiles}
 */
function reportTiles(input) { notBuilt(); }

/**
 * The setup checklist, ticked from data: policyReviewed (any tier past version 1), departments (more than
 * General, or any budget), invited (any invite or a second member), demoTrip (any request).
 * @param {{ policies: import('./types').Policy[], departments: import('./types').Department[], budgets: number,
 *   invites: number, memberCount: number, requests: number }} input
 * @returns {import('./types').Checklist}
 */
function checklist(input) { notBuilt(); }

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
  async dashboard(actor, opts) { notBuilt(); },
};

module.exports = {
  methods, COMING_SOON, TOP_REASONS, RECENT_ROWS, VIEWS,
  outOfPolicyShare, topReasons, savedBySwitching, reportTiles, checklist,
};
