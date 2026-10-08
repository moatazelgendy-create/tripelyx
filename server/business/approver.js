// Who approves a traveler's out-of-policy trip (plan §D "Approver resolution"). Pure: no store, no clock.
// The service reaches it as this.policy.resolveApprover (policy/index.js), so tests can use
// test/business-fakes.fakePolicy().
//
// One level only, so no loops:
//   1. traveler.approverId, if valid;
//   2. traveler.managerId, if valid;
//   3. otherwise the pool: active owners and travel admins other than the traveler, earliest `at` first
//      (then user id), with approverId null, pool true, rule 'admin';
//   4. nobody → rule null (submit answers 422 'no_approver' with the single-person copy).
// Valid = an active member of the company, holding approval.decide (roles.can), and not the traveler.
// Why a candidate is passed over, checked in this order: not_member (no record, or a record of another
// company), removed (not active), is_traveler, cannot_approve (the role lacks approval.decide).
// The result is snapshotted on the request at submit (approval.approverId, pool, poolIds, rule).
const roles = require('./roles');

/** Why a candidate was passed over, in ApproverResolution.skipped. */
const SKIP_REASONS = Object.freeze(['not_member', 'removed', 'cannot_approve', 'is_traveler']);

const POOL_ROLES = Object.freeze(['owner', 'travel_admin']);

/**
 * Resolve the approver for a traveler.
 * @param {import('./types').Member} traveler the traveler's member record (as stored now)
 * @param {Record<string, import('./types').Member>} membersById every member of the company, active or removed, by user id
 * @returns {import('./types').ApproverResolution} skipped lists the explicit approver and the manager when
 *   set but not valid, in that order
 */
function resolveApprover(traveler, membersById) {
  if (!traveler || typeof traveler.userId !== 'string' || !traveler.userId) throw new TypeError('[business] resolveApprover needs the traveler member');
  const members = membersById && typeof membersById === 'object' ? membersById : {};
  const member = userId => (Object.hasOwn(members, userId) ? members[userId] : null);
  const sameOrg = m => !traveler.orgId || !m.orgId || m.orgId === traveler.orgId;
  const why = userId => {
    const m = member(userId);
    if (!m || m.userId !== userId || !sameOrg(m)) return 'not_member';
    if (m.status !== 'active') return 'removed';
    if (userId === traveler.userId) return 'is_traveler';
    if (!roles.can(m.role, 'approval.decide')) return 'cannot_approve';
    return null;
  };
  const skipped = [];
  for (const [field, rule] of [['approverId', 'approver'], ['managerId', 'manager']]) {
    const userId = traveler[field];
    if (typeof userId !== 'string' || !userId) continue;
    const reason = why(userId);
    if (!reason) return { approverId: userId, pool: false, poolIds: [], rule, skipped };
    skipped.push({ userId, reason });
  }
  const poolIds = Object.keys(members)
    .map(member)
    .filter(m => m && typeof m.userId === 'string' && POOL_ROLES.includes(m.role) && why(m.userId) === null)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map(m => m.userId);
  if (poolIds.length) return { approverId: null, pool: true, poolIds, rule: 'admin', skipped };
  return { approverId: null, pool: false, poolIds: [], rule: null, skipped };
}

module.exports = { SKIP_REASONS, resolveApprover };
