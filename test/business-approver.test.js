// Approver resolution (plan §D, Stage 1P): the explicit approver, then the manager, then the admin pool; never
// the traveler; every reason a candidate is passed over, in order.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveApprover, SKIP_REASONS } = require('../server/business/approver');
const { createPolicyEngine } = require('../server/business/policy');
const { fakePolicy } = require('./business-fakes');

const ORG = 'org_acme';
let seq = 0;
function member(userId, role, o = {}) {
  seq += 1;
  return {
    orgId: ORG, userId, email: `${userId}@example.test`, name: userId, role, status: 'active', departmentId: null,
    managerId: null, approverId: null, tier: 'standard', at: `2026-01-${String(10 + (seq % 18)).padStart(2, '0')}T09:00:00.000Z`, by: null, removedAt: null, rev: 1,
    ...o,
  };
}
const byId = list => Object.fromEntries(list.map(m => [m.userId, m]));
const freeze = v => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(freeze); } return v; };

const owner = member('u_owner', 'owner', { at: '2026-01-01T09:00:00.000Z' });
const admin = member('u_admin', 'travel_admin', { at: '2026-02-01T09:00:00.000Z' });
const lead = member('u_lead', 'manager', { at: '2026-03-01T09:00:00.000Z' });
const boss = member('u_boss', 'manager', { at: '2026-03-02T09:00:00.000Z' });
const fin = member('u_fin', 'finance');
const emp = member('u_emp', 'employee');

test('the explicit approver wins over the manager; the manager next; skipped empty when both are fine', () => {
  const traveler = member('u_t', 'employee', { approverId: 'u_boss', managerId: 'u_lead' });
  const all = byId([owner, admin, lead, boss, traveler]);
  assert.deepEqual(resolveApprover(traveler, all), { approverId: 'u_boss', pool: false, poolIds: [], rule: 'approver', skipped: [] });
  const noExplicit = { ...traveler, approverId: null };
  assert.deepEqual(resolveApprover(noExplicit, all), { approverId: 'u_lead', pool: false, poolIds: [], rule: 'manager', skipped: [] });
  // An owner or travel admin named as approver or manager is assigned too, not pooled.
  assert.deepEqual(resolveApprover({ ...traveler, approverId: 'u_admin' }, all).approverId, 'u_admin');
  assert.deepEqual(resolveApprover({ ...noExplicit, managerId: 'u_owner' }, all).rule, 'manager');
});

test('every skip reason, in order: not_member, removed, is_traveler, cannot_approve', () => {
  assert.deepEqual([...SKIP_REASONS].sort(), ['cannot_approve', 'is_traveler', 'not_member', 'removed']);
  const removedBoss = { ...boss, status: 'removed', removedAt: '2026-09-01T00:00:00.000Z' };
  const otherOrg = member('u_far', 'manager', { orgId: 'org_other' });
  const cases = [
    ['no record', { approverId: 'u_ghost' }, [], 'not_member'],
    ['a record of another company', { approverId: 'u_far' }, [otherOrg], 'not_member'],
    ['a record under another key', { approverId: 'u_alias' }, [], 'not_member', { u_alias: lead }],
    ['removed', { approverId: 'u_boss' }, [removedBoss], 'removed'],
    ['the traveler', { approverId: 'u_t' }, [], 'is_traveler'],
    ['finance', { approverId: 'u_fin' }, [fin], 'cannot_approve'],
    ['employee', { managerId: 'u_emp' }, [emp], 'cannot_approve'],
  ];
  for (const [name, fields, extra, reason, raw = {}] of cases) {
    const traveler = member('u_t', 'employee', fields);
    const res = resolveApprover(traveler, { ...byId([owner, traveler, ...extra]), ...raw });
    const userId = fields.approverId || fields.managerId;
    assert.deepEqual(res.skipped, [{ userId, reason }], name);
    assert.deepEqual([res.approverId, res.pool, res.poolIds, res.rule], [null, true, ['u_owner'], 'admin'], `${name}: falls to the pool`);
  }
  // A traveler who can approve, named as their own approver: is_traveler (before cannot_approve).
  const t = member('u_t', 'manager', { approverId: 'u_t', status: 'active' });
  assert.deepEqual(resolveApprover(t, byId([owner, t])).skipped, [{ userId: 'u_t', reason: 'is_traveler' }]);
  // Both skipped, explicit approver first.
  const both = member('u_t', 'employee', { approverId: 'u_fin', managerId: 'u_ghost' });
  assert.deepEqual(resolveApprover(both, byId([owner, fin, both])).skipped, [{ userId: 'u_fin', reason: 'cannot_approve' }, { userId: 'u_ghost', reason: 'not_member' }]);
  // A bad explicit approver with a good manager: the manager, with the skip recorded.
  const fallback = member('u_t', 'employee', { approverId: 'u_ghost', managerId: 'u_lead' });
  assert.deepEqual(resolveApprover(fallback, byId([owner, lead, fallback])), { approverId: 'u_lead', pool: false, poolIds: [], rule: 'manager', skipped: [{ userId: 'u_ghost', reason: 'not_member' }] });
});

test('the pool: active owners and travel admins but the traveler, earliest joined first, then user id', () => {
  const late = member('u_admin2', 'travel_admin', { at: '2026-02-01T09:00:00.000Z' }); // same at as u_admin
  const gone = member('u_admin3', 'travel_admin', { status: 'removed' });
  const traveler = member('u_t', 'employee');
  const res = resolveApprover(traveler, byId([late, admin, lead, fin, gone, owner, traveler]));
  assert.deepEqual(res, { approverId: null, pool: true, poolIds: ['u_owner', 'u_admin', 'u_admin2'], rule: 'admin', skipped: [] });
  // Managers are never pooled: they approve only their own people.
  assert.ok(!res.poolIds.includes('u_lead'));
  // An admin traveling is left out of their own pool.
  const adminTraveler = { ...admin };
  assert.deepEqual(resolveApprover(adminTraveler, byId([owner, adminTraveler, late])).poolIds, ['u_owner', 'u_admin2']);
  // Other-company records in the map are never pooled.
  const foreign = member('u_x', 'owner', { orgId: 'org_other', at: '2025-01-01T00:00:00.000Z' });
  assert.deepEqual(resolveApprover(traveler, byId([owner, foreign, traveler])).poolIds, ['u_owner']);
});

test('the same company means the same orgId on both records: a record or a traveler with none is never trusted', () => {
  const traveler = member('u_t', 'employee', { approverId: 'u_x' });
  const noOrg = { ...member('u_x', 'owner'), orgId: undefined };
  assert.deepEqual(resolveApprover(traveler, byId([traveler, noOrg])), { approverId: null, pool: false, poolIds: [], rule: null, skipped: [{ userId: 'u_x', reason: 'not_member' }] });
  const homeless = { ...traveler, orgId: undefined };
  assert.deepEqual(resolveApprover(homeless, byId([homeless, member('u_x', 'owner', { orgId: 'org_b' }), owner])), {
    approverId: null, pool: false, poolIds: [], rule: null, skipped: [{ userId: 'u_x', reason: 'not_member' }],
  });
});

test('nobody else: rule null (a company of one); never the traveler, even an owner', () => {
  const solo = member('u_owner', 'owner', { approverId: 'u_owner', managerId: 'u_owner' });
  assert.deepEqual(resolveApprover(solo, byId([solo])), {
    approverId: null, pool: false, poolIds: [], rule: null,
    skipped: [{ userId: 'u_owner', reason: 'is_traveler' }, { userId: 'u_owner', reason: 'is_traveler' }],
  });
  const t = member('u_t', 'employee');
  assert.deepEqual(resolveApprover(t, byId([t, fin, emp, lead])), { approverId: null, pool: false, poolIds: [], rule: null, skipped: [] });
  assert.deepEqual(resolveApprover(t, {}).rule, null);
  assert.deepEqual(resolveApprover(t, null).rule, null);
  assert.throws(() => resolveApprover(null, {}), TypeError);
  assert.throws(() => resolveApprover({}, {}), TypeError);
});

test('pure: frozen inputs, the same answer twice, and the same as the policy engine and the fake', () => {
  const traveler = freeze(member('u_t', 'employee', { approverId: 'u_ghost', managerId: 'u_fin' }));
  const all = freeze(byId([owner, admin, lead, fin, traveler].map(m => ({ ...m }))));
  const a = resolveApprover(traveler, all);
  assert.deepEqual(a, resolveApprover(traveler, all));
  assert.deepEqual(createPolicyEngine().resolveApprover(traveler, all), a);
  assert.deepEqual(fakePolicy().resolveApprover(traveler, all), a, 'the fake matches the real thing');
  a.poolIds.push('x');
  assert.notDeepEqual(resolveApprover(traveler, all).poolIds, a.poolIds);
});
