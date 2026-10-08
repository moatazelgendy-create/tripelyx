// Who approves a traveler's out-of-policy trip (plan §D "Approver resolution"). Pure: no store, no clock.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. The service reaches it as
// this.policy.resolveApprover (policy/index.js), so tests can use test/business-fakes.fakePolicy().
//
// One level only, so no loops:
//   1. traveler.approverId, if valid;
//   2. traveler.managerId, if valid;
//   3. otherwise the pool: active owners and travel admins other than the traveler, earliest `at` first
//      (approverId null, pool true, rule 'admin');
//   4. nobody → rule null (submit answers 422 'no_approver' with the single-person copy).
// Valid = an active member of the company, holding approval.decide (roles.can), and not the traveler.
// The result is snapshotted on the request at submit (approval.approverId, pool, poolIds, rule).

function notBuilt() { throw new Error('[business] not built'); }

/** Why a candidate was passed over, in ApproverResolution.skipped. */
const SKIP_REASONS = Object.freeze(['not_member', 'removed', 'cannot_approve', 'is_traveler']);

/**
 * Resolve the approver for a traveler.
 * @param {import('./types').Member} traveler the traveler's member record (as stored now)
 * @param {Record<string, import('./types').Member>} membersById every member of the company, active or removed, by user id
 * @returns {import('./types').ApproverResolution} skipped lists the explicit approver and the manager when
 *   set but not valid, in that order
 */
function resolveApprover(traveler, membersById) { notBuilt(); }

module.exports = { SKIP_REASONS, resolveApprover };
