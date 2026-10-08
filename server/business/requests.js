// Trip requests: search, draft, swap, submit, cancel, decide, ask a question, lists and the approvals inbox
// (plan §C4 to §C6, §F, §G, §H1 to §H3). BusinessService methods (service.js assigns `methods` onto its
// prototype); `this` is the service.
// STUB from Stage 0 with the frozen interface; Stage 1W-b builds it against test/business-fakes.js.
//
// Collaborators, ONLY through `this` (so the fakes stand in during Stage 1):
// - this.composer (types.TripComposer): parseQuery, search, price, variants, recheck;
// - this.policy (types.PolicyEngine): evaluateComponent, evaluateTrip, priceToBeat, limitsBar, describe,
//   benchmark/flightValues/hotelValues, resolveApprover, transition, effectiveStatus, expiresAt;
// - this.alternatives (types.AlternativesEngine): buildAlternatives, compareTrips;
// - this.explainer (types.GuardedExplainer): explain(input) (never throws; falls back to the rules text);
// - this.inventory (types.BusinessInventory): status, carriers() for names;
// - this.repo for every read and write; tz.js and budgets.js helpers directly (pure).
//
// Write rules:
// - GETs never write (getRequest, listRequests, inbox, inboxCount, liveCheck, searchTrip). An effectively
//   expired request shows as expired without a write.
// - Every POST re-reads the request, runs this.policy.transition on the fresh document inside the
//   repo.commit CAS fn, and commits the request, its links, the budget change and the audit together.
//   A stale form rev answers 409 'conflict' ("Someone else just acted on this request. Here is where it
//   stands now.").
// - A POST on a pending request with now ≥ expiresAt first commits the expiry (request CAS → expired, audit
//   'request.expired', the 'clock' system actor), then answers 409 'request_expired'.
// - Prices are never taken from a form: the selection keys are re-priced with this.composer.price and the
//   policy re-evaluated with the tier's current policy every time.
// - evaluation.evaluatedAt is stamped from this.repo.iso().
// Errors common to all: 404 'not_found' (unknown id, another company's, or not visible to the member under
// roles.allowed with { own: 'request' }), 403 'forbidden', 403 'org_suspended', 409 'conflict', plus the
// lifecycle errors (lifecycle.js header) and 503 'no_supplier'.

function notBuilt() { throw new Error('[business] not built'); }

/** Purpose length on POST /trips. */
const PURPOSE_CHARS = Object.freeze([3, 140]);
/** Rows on the home page lists (waiting for you, my trips). */
const HOME_ROWS = 5;
/** List scopes on /trips and the permission each needs. */
const LIST_SCOPES = Object.freeze({ mine: 'request.view.own', team: 'request.view.team', all: 'request.view.all' });
/** Inbox tabs, in order. */
const INBOX_TABS = Object.freeze(['waiting', 'decided', 'company', 'expired']);

const methods = {
  /**
   * The results page (trip.request; GET /trips/search). today = tz.localDate(org.timezone, now);
   * this.composer.parseQuery → search; every row evaluated with this.policy.evaluateComponent against the
   * member's tier policy and benchmarks from the same search; rows ordered within → out → blocked, then
   * total, departure time, offer id. Writes nothing.
   * @param {import('./types').MemberActor} actor
   * @param {import('./types').RawTripQuery} raw the query string
   * @returns {Promise<import('./types').SearchView>} with status 'none' the legs are empty and nothing was searched
   * @throws {AppError} 422 'invalid_query' with per-field details; 403
   */
  async searchTrip(actor, raw) { notBuilt(); },

  /**
   * Create a draft from a pick (trip.request; POST /trips). Re-parses the query, re-prices the selection
   * (composer.price), re-searches the same legs for benchmarks, evaluates the trip with the budget preview,
   * and when not within builds alternatives (composer.variants → alternatives.buildAlternatives →
   * explainer.explain). One commit: biz_request insert (status draft; the traveler's name, manager,
   * department and tier snapshotted), the traveler's biz_req_link, audit 'request.drafted'.
   * @param {import('./types').MemberActor} actor
   * @param {{ query: import('./types').RawTripQuery, selection: { out?: string, back?: string, hotelKey?: string }, purpose: string }} input
   *   selection.hotelKey: the form's hotel radio (named hotelKey because `hotel` is the "I need a hotel" box)
   * @returns {Promise<import('./types').Request>}
   * @throws {AppError} 422 'invalid_query'; 422 'invalid_selection'; 422 'invalid_purpose' (details.purpose,
   *   3..140 characters, no card numbers); 422 'unsupported_currency'; 409 'option_unavailable' when a
   *   picked option no longer prices ("That option isn't available anymore. Pick another."); 403; 503 'no_supplier'
   */
  async createRequest(actor, input) { notBuilt(); },

  /**
   * A request page. Visible to the traveler, and to members whose request.view.team/all or approval role
   * reaches it (roles.allowed with { own: 'request' }, pooled when the member holds a pool link). Deciders
   * on a pending request also get `live` (composer.recheck, no write) and `comparison`
   * (alternatives.compareTrips against cheapestWithin). Writes nothing.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid btr_…
   * @returns {Promise<import('./types').RequestView>}
   * @throws {AppError} 404
   */
  async getRequest(actor, rid) { notBuilt(); },

  /**
   * The /trips lists, newest first, 50 per page. scope 'mine' (request.view.own), 'team' (request.view.team:
   * the member's reports and department), 'all' (request.view.all) with filters.
   * @param {import('./types').MemberActor} actor
   * @param {{ scope?: 'mine'|'team'|'all', status?: string, departmentId?: string, travelerId?: string,
   *   period?: string, cursor?: string|null }} [opts] status: an EffectiveStatus; period: a PeriodKey
   * @returns {Promise<import('./types').Page<import('./types').RequestRow>>}
   * @throws {AppError} 403 for a scope the member lacks; 422 'invalid_filter' (details by field); 404 bad cursor
   */
  async listRequests(actor, opts) { notBuilt(); },

  /**
   * Use a cheaper alternative (the traveler, draft only; POST /trips/:rid/swap). The alternative's
   * selection is re-priced and re-evaluated, new alternatives built; originalTotalCents is kept; history
   * gets savedCents. One commit: request CAS (form rev), audit 'request.swapped'.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ altId: string, rev: string|number }} form
   * @returns {Promise<import('./types').Request>}
   * @throws {AppError} 404; 409 'invalid_transition'; 410 'alternative_gone' ("That option isn't available
   *   anymore. Here are the current ones."); 409 'conflict'
   */
  async swap(actor, rid, form) { notBuilt(); },

  /**
   * Confirm a trip or request approval (the traveler, draft only; POST /trips/:rid/submit). Always re-checks
   * the price first: a changed or unavailable price updates the draft (outcome 'repriced', no submit).
   * Within policy and inside the budget → approved by policy with the budget hold (outcome
   * 'auto_approved'; audit 'request.auto_approved'). Otherwise, outOfPolicy 'approval' → pending with the
   * resolved approver or pool, links and expiresAt (outcome 'submitted'; audit 'request.submitted').
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ rev: string|number, reason?: string, category?: string }} form reason 10..500 characters when
   *   approval is needed (org.settings.reasonMinChars); category one of constants.REASON_CATEGORIES or blank
   * @returns {Promise<import('./types').SubmitResult>}
   * @throws {AppError} 422 'policy_blocked'; 422 'reason_too_short'; 422 'card_number'; 422 'no_approver'
   *   ("No one else at Acme Inc can approve this yet …"); 409 'invalid_transition'; 409 'departed';
   *   409 'conflict'; 404
   */
  async submit(actor, rid, form) { notBuilt(); },

  /**
   * Cancel (POST /trips/:rid/cancel): the traveler a draft, a pending request, or an approved one before
   * the departure date; approval.override holders an approved one. Cancelling an approved request deletes
   * its budget hold in the same commit. Audit 'request.cancelled'.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ rev: string|number }} form
   * @returns {Promise<import('./types').Request>}
   * @throws {AppError} 404; 403; 409 'invalid_transition'; 409 'departed'; 409 'request_expired'; 409 'conflict'
   */
  async cancel(actor, rid, form) { notBuilt(); },

  /**
   * Approve or deny (POST /trips/:rid/decide): the assigned approver, a pool member, or an
   * approval.override holder (labelled "as Travel Admin (assigned to Dana Lee)", note required); never the
   * traveler. Order (§H2): read; effectively expired → persist and 409; recheck; changed or unavailable →
   * back to draft with `returned` (outcome 'returned', audit 'request.returned'); approve → request CAS,
   * budget hold (refused over budget unless ackOverBudget), a check on the decider's member rev, audit
   * 'request.approved' with decidedAs and overBudgetAck; deny → request CAS, audit 'request.denied'.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ action: 'approve'|'deny', note?: string, ackOverBudget?: string, rev: string|number }} form
   *   note ≥ 10 characters to deny or to override; ackOverBudget '1'
   * @returns {Promise<import('./types').DecideResult>}
   * @throws {AppError} 404; 403; 422 'self_approval' ("You can't decide your own trip."); 422 'note_required';
   *   422 'over_budget'; 409 'request_expired'; 409 'invalid_transition'; 409 'conflict'
   */
  async decide(actor, rid, form) { notBuilt(); },

  /**
   * Ask a question or answer one (POST /trips/:rid/message): the traveler, the assigned approver, pool
   * members and override holders, on a draft, pending or approved request. A pending request stays pending;
   * expiry unchanged. One commit: request CAS (messages appended), audit 'request.message' (no text in the
   * audit entry).
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ text: string }} form 2..1000 characters, card numbers refused
   * @returns {Promise<import('./types').Request>}
   * @throws {AppError} 404; 403; 422 'invalid_message'; 422 'card_number'; 409 'too_many_messages';
   *   409 'request_expired'; 409 'invalid_transition'
   */
  async message(actor, rid, form) { notBuilt(); },

  /**
   * The approvals inbox (approval.decide). Pages the member's 'approver' and 'pool' links (Repo.page on
   * biz_req_link in member scope), getIn each request and keeps those whose effectiveStatus fits the tab;
   * 'company' (approval.override only) pages the company's requests filtered to pending. Writes nothing.
   * @param {import('./types').MemberActor} actor
   * @param {{ tab?: 'waiting'|'decided'|'company'|'expired', cursor?: string|null }} [opts]
   * @returns {Promise<import('./types').InboxView>}
   * @throws {AppError} 403; 404 bad cursor or a 'company' tab without approval.override
   */
  async inbox(actor, opts) { notBuilt(); },

  /**
   * "Waiting for you (n)" for the workspace shell (http.shellContext calls it on every workspace page). Must
   * be cheap: one bounded page of the member's links. Never throws for a member without approval.decide.
   * @param {import('./types').MemberActor} actor
   * @returns {Promise<number|null>} null when the member cannot decide
   */
  async inboxCount(actor) { notBuilt(); },

  /**
   * The approver's live price check on its own (GET; the request page embeds the same result).
   * composer.recheck(request); writes nothing.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @returns {Promise<import('./types').RecheckResult>}
   * @throws {AppError} 404; 403 when the member cannot decide this request
   */
  async liveCheck(actor, rid) { notBuilt(); },
};

module.exports = { methods, PURPOSE_CHARS, HOME_ROWS, LIST_SCOPES, INBOX_TABS };
