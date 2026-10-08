// Tripelyx Business foundation (plan Stage 0): the roles matrix, constants, tokens, the Repo's storage
// rules (scopes, commit, page, withRetry), field validators, the card-number guard, rate limits, the actor
// re-read, the HTTP guards, the app wiring and the accounts stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const roles = require('../server/business/roles');
const tokens = require('../server/business/tokens');
const v = require('../server/business/validate');
const constants = require('../server/business/constants');
const cards = require('../server/business/cards');
const actorLib = require('../server/business/actor');
const http = require('../server/business/http');
const { Repo, SCOPE_RE, USER_ID_RE, IDENTITY_KEYS, memberScope } = require('../server/business/repo');
const { createBusinessLimits, ACCOUNT_LIMIT, accountKey } = require('../server/business/limits');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { Accounts, PLATFORM_ADMIN } = require('../server/accounts');
const { AppError } = require('../server/lib/errors');
const { loadConfig } = require('../server/config');
const { redactUrl } = require('../server/app');
const { id } = require('../server/lib/ids');
const { startApp, FIXED_NOW, quietLog } = require('./helpers');
const { seedUser, client, seedOrg, seedMember, seedDepartment, seedBudget, mutableClock, noInline, storeSnapshot } = require('./business-helpers');
const { defaultPolicy, DEFAULTS_NOTE } = require('../server/business/policy/defaults');

const { KINDS } = constants;
const fixed = () => new Date(FIXED_NOW);

// ---------------------------------------------------------------------------------------------------
// Roles (plan §D): the literal 5 × 20 table. Columns: Owner, Travel Admin, Finance, Manager, Employee.
const EXPECTED_MATRIX = {
  'org.view':           'Y Y Y Y Y',
  'trip.request':       'Y Y Y Y Y',
  'request.view.own':   'Y Y Y Y Y',
  'request.view.team':  'Y Y - Y -',
  'request.view.all':   'Y Y Y - -',
  'approval.decide':    'Y Y - Y -',
  'approval.override':  'Y Y - - -',
  'policy.view.all':    'Y Y Y - -',
  'policy.edit':        'Y Y - - -',
  'budget.view.dept':   'Y Y Y Y -',
  'budget.view.all':    'Y Y Y - -',
  'budget.edit':        'Y - Y - -',
  'members.view':       'Y Y Y Y -',
  'members.manage':     'Y Y - - -',
  'departments.manage': 'Y Y - - -',
  'reports.view':       'Y Y Y - -',
  'reports.export':     'Y Y Y - -',
  'audit.view':         'Y Y Y - -',
  'settings.travel':    'Y Y - - -',
  'settings.company':   'Y - - - -',
};
const EXPECTED_SCOPES = {
  'request.view.own': 'own',
  'request.view.team': 'team',
  'budget.view.dept': 'dept',
  'approval.decide': 'decider',
  'approval.override': 'not_traveler',
};

test('roles: the five roles, their labels and the exact permission matrix', () => {
  assert.deepEqual([...roles.ROLES], ['owner', 'travel_admin', 'finance', 'manager', 'employee']);
  assert.deepEqual({ ...roles.LABELS }, { owner: 'Owner', travel_admin: 'Travel Admin', finance: 'Finance', manager: 'Manager', employee: 'Employee' });
  assert.deepEqual([...roles.PERMISSIONS], Object.keys(EXPECTED_MATRIX), 'every permission in the plan, in order');
  const actual = {};
  for (const perm of roles.PERMISSIONS) {
    actual[perm] = roles.ROLES.map(r => (roles.can(r, perm) ? 'Y' : '-')).join(' ');
    for (const r of roles.ROLES) {
      assert.equal(roles.PERMS[r].has(perm), roles.can(r, perm), `PERMS and can agree: ${r} ${perm}`);
      assert.equal(roles.ownOnly(r, perm), roles.can(r, perm) && Object.hasOwn(EXPECTED_SCOPES, perm), `ownOnly: ${r} ${perm}`);
      assert.equal(roles.OWN[r].has(perm), roles.ownOnly(r, perm));
    }
    assert.equal(roles.scopeOf(perm), EXPECTED_SCOPES[perm] || 'org', perm);
  }
  assert.deepEqual(actual, EXPECTED_MATRIX);
  assert.deepEqual({ ...roles.SCOPES }, EXPECTED_SCOPES);
  assert.ok(Object.isFrozen(roles.PERMS) && Object.isFrozen(roles.ROLES) && Object.isFrozen(roles.PERMISSIONS) && Object.isFrozen(roles.SCOPES));
  // The Sets refuse changes, so nothing can widen a role at runtime.
  assert.throws(() => roles.PERMS.employee.add('approval.decide'), /read-only/);
  assert.throws(() => roles.PERMS.owner.delete('org.view'), /read-only/);
  assert.throws(() => roles.OWN.manager.clear(), /read-only/);
  // Everyone can travel and sees their own requests; only an Owner holds settings.company.
  for (const r of roles.ROLES) for (const p of ['org.view', 'trip.request', 'request.view.own']) assert.ok(roles.can(r, p), `${r} ${p}`);
  assert.deepEqual(roles.ROLES.filter(r => roles.can(r, 'settings.company')), ['owner']);
});

test('roles: unknown roles and permissions are refused', () => {
  for (const perm of [...roles.PERMISSIONS, 'nope']) {
    for (const bad of ['x', '', undefined, null, '__proto__', 'constructor', 'toString', 'Owner', 'advisor']) {
      assert.equal(roles.can(bad, perm), false, `${String(bad)} ${perm}`);
      assert.equal(roles.ownOnly(bad, perm), false);
    }
  }
  for (const r of roles.ROLES) {
    for (const p of ['nope', 'has', undefined, 'proposals.view', 'pricing.viewInternal']) assert.equal(roles.can(r, p), false, `${r} ${p}`);
  }
  assert.deepEqual([...roles.assignableBy('x')], []);
  assert.deepEqual([...roles.assignableBy('__proto__')], []);
  assert.equal(roles.canAny('owner', 'org.view'), false, 'canAny needs a list');
  assert.equal(roles.canAny('employee', ['approval.decide', 'trip.request']), true);
  for (const gone of ['STAGE_LIMITS', 'CLIENT_VIEW', 'DASHBOARD_OWN', 'canSetStage', 'clientView']) assert.ok(!(gone in roles), gone);
});

test('roles: who may grant which roles', () => {
  assert.deepEqual([...roles.assignableBy('owner')], [...roles.ROLES]);
  assert.deepEqual([...roles.assignableBy('travel_admin')], ['travel_admin', 'manager', 'employee'], 'only an Owner grants owner or finance');
  for (const r of ['finance', 'manager', 'employee']) assert.deepEqual([...roles.assignableBy(r)], [], r);
  for (const r of roles.ROLES) assert.equal(roles.can(r, 'members.manage'), roles.assignableBy(r).length > 0, r);
});

test('roles: allowed() applies the own, team, department, decider and not-traveler scopes', () => {
  const sam = 'usr_SSSSSSSSSSSSSSSS', dana = 'usr_DDDDDDDDDDDDDDDD', mo = 'usr_MMMMMMMMMMMMMMMM', fin = 'usr_FFFFFFFFFFFFFFFF';
  const req = { travelerId: sam, travelerManagerId: mo, departmentId: 'dep_eng', approval: { approverId: dana } };
  const employee = { role: 'employee', userId: sam, departmentId: 'dep_eng' };
  const approver = { role: 'manager', userId: dana, departmentId: 'dep_sales' };
  const manager = { role: 'manager', userId: mo, departmentId: 'dep_eng' };
  const otherManager = { role: 'manager', userId: 'usr_OOOOOOOOOOOOOOOO', departmentId: 'dep_eng' };
  const finance = { role: 'finance', userId: fin, departmentId: null };
  const admin = { role: 'travel_admin', userId: 'usr_AAAAAAAAAAAAAAAA', departmentId: null };

  // own
  assert.equal(roles.allowed(employee, 'request.view.own', req), true);
  assert.equal(roles.allowed(approver, 'request.view.own', req), false);
  // team: own, the assigned approver, the traveler's manager, or a pool link
  assert.equal(roles.allowed(approver, 'request.view.team', req), true);
  assert.equal(roles.allowed(manager, 'request.view.team', req), true);
  assert.equal(roles.allowed(otherManager, 'request.view.team', req), false);
  assert.equal(roles.allowed(otherManager, 'request.view.team', req, { pooled: true }), true);
  assert.equal(roles.allowed(employee, 'request.view.team', req), false, 'Employees do not hold request.view.team');
  // all
  assert.equal(roles.allowed(finance, 'request.view.all', req), true);
  assert.equal(roles.allowed(otherManager, 'request.view.all', req), false);
  // dept
  assert.equal(roles.allowed(manager, 'budget.view.dept', { departmentId: 'dep_eng' }), true);
  assert.equal(roles.allowed(approver, 'budget.view.dept', { departmentId: 'dep_eng' }), false);
  assert.equal(roles.allowed(finance, 'budget.view.dept', { departmentId: 'dep_eng' }), false, 'no department, no department scope');
  assert.equal(roles.allowed({ ...manager, departmentId: null }, 'budget.view.dept', { departmentId: null }), false, 'null never matches null');
  assert.equal(roles.allowed(finance, 'budget.view.all', { departmentId: 'dep_eng' }), true);
  // decider: the assigned approver or a pool member, never the traveler
  assert.equal(roles.allowed(approver, 'approval.decide', req), true);
  assert.equal(roles.allowed(manager, 'approval.decide', req), false, 'being the manager is not being the assigned approver');
  assert.equal(roles.allowed(admin, 'approval.decide', req, { pooled: true }), true);
  const selfApprover = { travelerId: dana, approval: { approverId: dana } };
  assert.equal(roles.allowed(approver, 'approval.decide', selfApprover), false, 'nobody decides their own trip');
  assert.equal(roles.allowed(approver, 'approval.decide', selfApprover, { pooled: true }), false);
  // override: any request but your own
  assert.equal(roles.allowed(admin, 'approval.override', req), true);
  assert.equal(roles.allowed({ role: 'owner', userId: sam }, 'approval.override', req), false, 'not even an Owner overrides on their own trip');
  assert.equal(roles.allowed(approver, 'approval.override', req), false, 'Managers do not hold override');
  // no record: any holder passes; no member or no user id: nothing passes
  assert.equal(roles.allowed(employee, 'request.view.own'), true);
  assert.equal(roles.allowed(null, 'org.view'), false);
  assert.equal(roles.allowed({ role: 'owner' }, 'request.view.own', req), false);
  assert.equal(roles.allowed({ role: 'owner', userId: '' }, 'policy.edit', {}), false);
  assert.equal(roles.allowedAny(manager, ['request.view.all', 'request.view.team', 'request.view.own'], req), true);
  assert.equal(roles.allowedAny(otherManager, ['request.view.all', 'request.view.team', 'request.view.own'], req), false);
});

// ---------------------------------------------------------------------------------------------------
test('constants: the corporate kinds, tiers, statuses and the advisor-era names are gone', () => {
  assert.equal(constants.BUSINESS_EMAIL, 'go@tripelyx.com');
  assert.deepEqual([...constants.ORG_STATUSES], ['pending', 'active', 'suspended']);
  assert.equal(constants.LIST_LIMIT, 1000);
  assert.deepEqual({ ...KINDS }, {
    org: 'biz_org', member: 'biz_member', userIndex: 'biz_user_index', invite: 'biz_invite', inviteEmail: 'biz_invite_email',
    department: 'biz_department', policy: 'biz_policy', policyVersion: 'biz_policy_version', budget: 'biz_budget',
    request: 'biz_request', reqLink: 'biz_req_link', audit: 'biz_audit',
  });
  assert.deepEqual([...constants.TIERS], ['standard', 'director', 'executive']);
  assert.deepEqual([...constants.REQUEST_STATUSES], ['draft', 'pending', 'approved', 'denied', 'cancelled', 'expired']);
  assert.deepEqual([...constants.REASON_CATEGORIES], ['client_meeting', 'schedule', 'no_option', 'other']);
  assert.deepEqual(constants.REASON_CATEGORIES.map(c => constants.REASON_CATEGORY_LABELS[c]), ['Client meeting', 'Schedule', 'No option inside policy', 'Other']);
  assert.deepEqual({ ...constants.CABIN_RANK }, { economy: 0, premium: 1, business: 2 });
  assert.deepEqual(constants.CABINS.map(c => constants.CABIN_LABELS[c]), ['Economy', 'Premium economy', 'Business']);
  assert.equal(constants.DEFAULT_TIMEZONE, 'Africa/Cairo');
  assert.equal(constants.TIMEZONES[0], 'Africa/Cairo');
  assert.equal(constants.TIMEZONES.length, 13);
  for (const tz of constants.TIMEZONES) assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: tz }), tz);
  assert.deepEqual([...constants.AUDIT_GROUPS], ['org', 'member', 'department', 'policy', 'budget', 'request', 'reports']);
  for (const [group, actions] of Object.entries(constants.AUDIT_ACTIONS)) for (const a of actions) assert.ok(a.startsWith(`${group}.`), a);
  assert.equal(Object.values(constants.AUDIT_ACTIONS).flat().length, 29, 'the §C7 table plus request.repriced');
  assert.ok(constants.AUDIT_ACTIONS.request.includes('request.repriced'), 'a re-priced draft on submit is audited (D7)');
  assert.deepEqual([...constants.REQ_LINK_ROLES], ['traveler', 'approver', 'pool', 'decider']);
  for (const gone of ['STAGES', 'STAGE_LABELS', 'AUTO_LOCKED', 'MAX_OPTIONS', 'OPTION_KEYS', 'MAX_SHARES', 'RESPONSE_KINDS', 'WRONG_REASONS', 'REMINDER_KINDS', 'SHARE_KINDS', 'DEFAULT_COLORS']) {
    assert.ok(!(gone in constants), gone);
  }
  assert.ok(Object.isFrozen(KINDS) && Object.isFrozen(constants.AUDIT_ACTIONS.request));
});

// ---------------------------------------------------------------------------------------------------
test('tokens: 43 random characters, stored only as a hash, compared in constant time', () => {
  const a = tokens.newToken(), b = tokens.newToken();
  assert.equal(a.length, 43);
  assert.match(a, tokens.TOKEN_RE);
  assert.notEqual(a, b);
  assert.ok(tokens.isToken(a));
  for (const bad of ['', 'short', `${a}x`, `${a.slice(0, 42)}!`, null, undefined, 42]) assert.equal(tokens.isToken(bad), false);
  const h = tokens.hashToken(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(tokens.hashToken(a), h, 'deterministic');
  assert.equal(tokens.sameHash(h, tokens.hashToken(a)), true);
  assert.equal(tokens.sameHash(h, tokens.hashToken(b)), false);
  assert.equal(tokens.sameHash(h, h.slice(0, 62)), false, 'different lengths');
  assert.equal(tokens.sameHash(h, `${h.slice(0, 63)}z`), false, 'not hex');
  assert.equal(tokens.sameHash(undefined, undefined), false);
  assert.equal(tokens.sameHash('', ''), false);
  // Node drops a trailing odd nibble when it decodes hex: only whole sha256 hashes are compared.
  assert.equal(tokens.sameHash('a', 'b'), false, 'odd length');
  assert.equal(tokens.sameHash('abc', 'abd'), false, 'odd length');
  assert.equal(tokens.sameHash(`${h}a`, `${h}b`), false, '65 characters');
  assert.equal(tokens.sameHash(h.slice(0, 62), h.slice(0, 62)), false, 'not a sha256 hash');
  assert.equal(tokens.sameHash(h.toUpperCase(), h.toUpperCase()), false, 'uppercase is not a stored hash');
  assert.equal(tokens.sameHash(h, h), true);
});

// ---------------------------------------------------------------------------------------------------
// Repo (plan §C2)
const newRepo = (store = new MemoryStore(), now = fixed, log = null) => new Repo({ store, now, log });

test('repo: org, user and member scopes only; prp_ and falsy scopes are refused', async () => {
  const store = new MemoryStore();
  const accounts = new Accounts({ store, config: loadConfig({}), now: fixed });
  const user = await accounts.register({ name: 'Ada Admin', email: 'ada@example.com', password: 'long enough password' });
  assert.match(user.id, USER_ID_RE);
  const repo = newRepo(store);
  const orgId = id('org');
  for (const ok of [user.id, orgId, memberScope(orgId, user.id)]) assert.equal(repo.assertScope(ok), ok);
  for (const bad of ['', null, undefined, 0, false, id('prp'), id('cli'), 'org_short', `${orgId} `, `${orgId}x`, 'org_aaaaaaaa:aaaaaaa', {}, [orgId]]) {
    assert.throws(() => repo.assertScope(bad), /unscoped or malformed/, String(bad));
  }
  assert.ok(!SCOPE_RE.test(id('prp')));
  await assert.rejects(repo.list(KINDS.department, ''), /unscoped/);
  await assert.rejects(repo.page(KINDS.request, null), /unscoped/);
  await assert.rejects(repo.insert(KINDS.department, 'dep_x', { rev: 0 }, { owner: '' }), /unscoped/);
  await assert.rejects(repo.insert(KINDS.department, 'dep_y', { rev: 0 }), /unscoped/, 'only biz_org goes without an owner');
  assert.equal(await repo.insert(KINDS.org, orgId, { id: orgId, rev: 0 }), true);
  await assert.rejects(repo.insert('user', 'u1', { rev: 0 }, { owner: orgId }), /bad record kind/, 'the Repo touches biz_ kinds only');
  assert.equal(typeof repo.put, 'undefined', 'there is no unconditional write');
  assert.deepEqual([...IDENTITY_KEYS], ['id', 'orgId', 'userId', 'travelerId', 'requestId']);
});

test('repo: memberScope is deterministic, per company and per user, and refuses anything but real ids', () => {
  const orgA = 'org_AAAAAAAAAAAAAAAA', orgB = 'org_BBBBBBBBBBBBBBBB', u1 = 'usr_1111111111111111', u2 = 'usr_2222222222222222';
  const s = memberScope(orgA, u1);
  assert.match(s, /^mbr_[A-Za-z0-9_-]{16}$/);
  assert.equal(memberScope(orgA, u1), s);
  assert.equal(s, `mbr_${require('node:crypto').createHash('sha256').update(`${orgA}|${u1}`).digest('base64url').slice(0, 16)}`);
  assert.equal(new Set([s, memberScope(orgB, u1), memberScope(orgA, u2), memberScope(orgB, u2)]).size, 4);
  for (const [o, u] of [['', u1], [orgA, ''], [null, u1], [orgA, undefined], [u1, orgA], [`${orgA}|`, u1], ['org_x', u1]]) {
    assert.throws(() => memberScope(o, u), /memberScope needs/, `${o} ${u}`);
  }
});

test('repo: getIn refuses another tenant; list is bounded, scoped, sorted by the clock time and warns at its limit', async () => {
  const clock = mutableClock(FIXED_NOW);
  const warned = [];
  const repo = newRepo(new MemoryStore(), clock.now, { warn: m => warned.push(m) });
  assert.equal(repo.iso(), FIXED_NOW);
  const orgA = id('org'), orgB = id('org');
  await repo.insert(KINDS.org, orgA, { id: orgA, name: 'A', rev: 0, at: repo.iso() });
  await repo.insert(KINDS.department, 'dep_1', { id: 'dep_1', orgId: orgA, name: 'Sales', at: repo.iso(), rev: 0 }, { owner: orgA });
  assert.equal((await repo.getIn(KINDS.department, 'dep_1', orgA)).name, 'Sales');
  for (const [k, i, o] of [[KINDS.department, 'dep_1', orgB], [KINDS.department, 'dep_1', ''], [KINDS.department, 'dep_1', undefined],
    [KINDS.department, 'dep_missing', orgA], [KINDS.department, '', orgA], [KINDS.department, 'x'.repeat(500), orgA], [KINDS.org, orgA, orgB]]) {
    assert.equal(await repo.getIn(k, i, o), null, `${k} ${i} ${o}`);
  }
  assert.equal((await repo.getIn(KINDS.org, orgA, orgA)).name, 'A');

  const ats = ['2026-10-09T09:00:00.000Z', '2026-10-11T09:00:00.000Z', '2026-10-10T09:00:00.000Z'];
  for (const [i, at] of ats.entries()) await repo.insert(KINDS.department, `dep_b${i}`, { id: `dep_b${i}`, orgId: orgB, at, updatedAt: ats[2 - i] }, { owner: orgB });
  assert.deepEqual((await repo.list(KINDS.department, orgB)).map(r => r.id), ['dep_b1', 'dep_b2', 'dep_b0']);
  assert.deepEqual((await repo.list(KINDS.department, orgB, { by: 'updatedAt' })).map(r => r.id), ['dep_b1', 'dep_b0', 'dep_b2']);
  assert.deepEqual(warned, []);
  assert.equal((await repo.list(KINDS.department, orgB, { limit: 3 })).length, 3);
  assert.equal(warned.length, 1, 'reaching the limit is logged: rows past it would be missing');
  assert.match(warned[0], /reached its limit of 3/);
  for (const limit of [0, 201, 1000, 1.5]) await assert.rejects(repo.list(KINDS.department, orgB, { limit }), RangeError);
});

test('repo: documents must be plain JSON and ids never use a colon', async () => {
  const repo = newRepo();
  const org = id('org');
  for (const bad of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: new Date() }, { a: [1, undefined] }, { a: { b: () => 1 } }, { a: new Map() }]) {
    await assert.rejects(repo.insert(KINDS.department, id('dep'), bad, { owner: org }), /not plain JSON|not a finite number/);
  }
  for (const bad of [[], null, 'text', new Date()]) await assert.rejects(repo.insert(KINDS.department, id('dep'), bad, { owner: org }), /plain object/);
  await assert.rejects(repo.insert(KINDS.member, `${org}:usr`, { ok: true }, { owner: org }), /bad record id/);
  assert.equal(await repo.insert(KINDS.member, `${org}.usr_aaaaaaaaaaaaaaaa`, { ok: true, list: [1, 'a', null, { x: false }] }, { owner: org }), true);
  assert.equal(await repo.insert(KINDS.member, `${org}.usr_aaaaaaaaaaaaaaaa`, { ok: false }, { owner: org }), false, 'insert-only');
});

test('repo: cas checks rev, applies the change, keeps identity keys and makes racing writers lose with 409', async () => {
  const store = new MemoryStore();
  const repo = newRepo(store);
  const org = id('org');
  const original = { id: 'btr_1', orgId: org, travelerId: 'usr_SSSSSSSSSSSSSSSS', status: 'draft', rev: 0 };
  await repo.insert(KINDS.request, 'btr_1', original, { owner: org });
  assert.deepEqual(await repo.cas(KINDS.request, 'btr_1', 0, d => { d.status = 'pending'; }), { ...original, status: 'pending', rev: 1 });
  assert.deepEqual(await repo.cas(KINDS.request, 'btr_1', '1', d => ({ ...d, status: 'approved', rev: 99 })), { ...original, status: 'approved', rev: 2 });
  const stale = await repo.cas(KINDS.request, 'btr_1', 1, d => { d.status = 'x'; }).catch(e => e);
  assert.ok(stale instanceof AppError && stale.status === 409 && stale.code === 'conflict');
  assert.equal(stale.retryable, false, 'a stale form rev never retries');
  for (const bad of ['abc', '1.5', -1, '', {}]) assert.equal((await repo.cas(KINDS.request, 'btr_1', bad, d => d).catch(x => x)).status, 409, `rev ${JSON.stringify(bad)}`);
  assert.equal((await repo.cas(KINDS.request, 'btr_1', null, d => { d.status = 'cancelled'; })).rev, 3, 'null rev: the rev just read');
  assert.equal((await repo.cas(KINDS.request, 'nope', 0, d => d).catch(e => e)).status, 404);
  assert.equal((await repo.cas(KINDS.request, 'btr_1', 3, () => { throw new AppError('bad', 'no', 422); }).catch(e => e)).status, 422);
  assert.equal((await repo.get(KINDS.request, 'btr_1')).rev, 3, 'an aborted change writes nothing');

  // `d => d.x = 1` returns 1; returning anything but a plain object, or re-homing the record, throws.
  for (const fn of [d => d.status = 'X', () => true, () => 5, () => 'str', () => [1], () => null, () => new Date(), d => d.rev = 7]) {
    await assert.rejects(repo.cas(KINDS.request, 'btr_1', 3, fn), /cas fn must return a plain object or nothing|may not change or drop/, String(fn));
  }
  for (const key of ['id', 'orgId', 'travelerId']) {
    await assert.rejects(repo.cas(KINDS.request, 'btr_1', 3, d => ({ ...d, [key]: 'usr_OOOOOOOOOOOOOOOO' })), new RegExp(`may not change or drop ${key}`));
    await assert.rejects(repo.cas(KINDS.request, 'btr_1', 3, d => { delete d[key]; }), new RegExp(`may not change or drop ${key}`));
  }
  await repo.insert(KINDS.reqLink, 'btr_1.traveler.usr_SSSSSSSSSSSSSSSS', { orgId: org, requestId: 'btr_1', userId: 'usr_SSSSSSSSSSSSSSSS', role: 'traveler', at: FIXED_NOW }, { owner: memberScope(org, 'usr_SSSSSSSSSSSSSSSS') });
  await assert.rejects(repo.cas(KINDS.reqLink, 'btr_1.traveler.usr_SSSSSSSSSSSSSSSS', 0, d => { d.at = 'x'; }), /insert-only/);

  // Racing writers that all saw rev 3: exactly one wins, the others get 409.
  const results = await Promise.allSettled(['x', 'y', 'z'].map(n => repo.cas(KINDS.request, 'btr_1', 3, async d => { await null; d.purpose = n; })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409));
});

test('repo: commit writes the change, the checks and the audit entry together, or nothing', async () => {
  const store = new MemoryStore();
  const repo = newRepo(store);
  const org = id('org');
  await repo.insert(KINDS.org, org, { id: org, name: 'Acme Inc', ownerIds: ['usr_OOOOOOOOOOOOOOOO'], rev: 0 });
  await repo.insert(KINDS.budget, `${org}.dep_1.2026-Q4`, { orgId: org, amountCents: 100000, commits: {}, rev: 0 }, { owner: org });
  await repo.insert(KINDS.request, 'btr_1', { id: 'btr_1', orgId: org, travelerId: 'usr_SSSSSSSSSSSSSSSS', status: 'pending', totalCents: 84200, rev: 2 }, { owner: org });
  await repo.insert(KINDS.member, `${org}.usr_DDDDDDDDDDDDDDDD`, { orgId: org, userId: 'usr_DDDDDDDDDDDDDDDD', role: 'manager', rev: 5 }, { owner: org });
  const audit = actorLib.auditInsert(repo, { orgId: org, actor: { userId: 'usr_DDDDDDDDDDDDDDDD', name: 'Dana Lee', role: 'manager' }, action: 'request.approved', target: { kind: KINDS.request, id: 'btr_1' }, summary: 'Dana Lee approved a trip' });
  const approve = () => ({
    cas: [
      { kind: KINDS.request, id: 'btr_1', rev: 2, fn: d => { d.status = 'approved'; } },
      { kind: KINDS.budget, id: `${org}.dep_1.2026-Q4`, rev: null, fn: d => { d.commits.btr_1 = 84200; } },
    ],
    checks: [{ kind: KINDS.member, id: `${org}.usr_DDDDDDDDDDDDDDDD`, rev: 5 }],
    inserts: [audit],
  });
  const before = storeSnapshot({ store });

  // A taken audit id: nothing at all is written.
  await repo.insert(KINDS.audit, audit.id, { id: audit.id, orgId: org, at: FIXED_NOW }, { owner: org });
  const dup = await repo.commit(approve()).catch(e => e);
  assert.ok(dup instanceof AppError && dup.code === 'already_exists' && dup.status === 409);
  assert.equal((await repo.get(KINDS.request, 'btr_1')).status, 'pending');
  assert.deepEqual((await repo.get(KINDS.budget, `${org}.dep_1.2026-Q4`)).commits, {});
  await store.deleteRecord(KINDS.audit, audit.id);
  assert.equal(storeSnapshot({ store }), before);

  // The decider's member record moved on: 409, and nothing is written.
  await repo.cas(KINDS.member, `${org}.usr_DDDDDDDDDDDDDDDD`, 5, d => { d.role = 'employee'; });
  const moved = await repo.commit(approve()).catch(e => e);
  assert.ok(moved instanceof AppError && moved.code === 'conflict');
  assert.equal(moved.retryable, false, 'an explicit rev is not retried');
  assert.equal((await repo.get(KINDS.request, 'btr_1')).status, 'pending');
  assert.equal(await repo.get(KINDS.audit, audit.id), null);

  // server:true marks an explicit rev the server read: its conflict is retryable.
  const serverRead = await repo.commit({ ...approve(), checks: [{ kind: KINDS.member, id: `${org}.usr_DDDDDDDDDDDDDDDD`, rev: 5, server: true }] }).catch(e => e);
  assert.equal(serverRead.retryable, true);

  // Fresh revs: all of it lands at once.
  const docs = await repo.commit({ ...approve(), checks: [{ kind: KINDS.member, id: `${org}.usr_DDDDDDDDDDDDDDDD`, rev: 6 }] });
  assert.deepEqual(Object.keys(docs).sort(), [`${KINDS.audit}:${audit.id}`, `${KINDS.budget}:${org}.dep_1.2026-Q4`, `${KINDS.request}:btr_1`].sort());
  assert.equal(docs[`${KINDS.request}:btr_1`].status, 'approved');
  assert.equal(docs[`${KINDS.request}:btr_1`].rev, 3);
  assert.deepEqual((await repo.get(KINDS.budget, `${org}.dep_1.2026-Q4`)).commits, { btr_1: 84200 });
  assert.equal((await repo.getIn(KINDS.audit, audit.id, org)).action, 'request.approved');
  assert.deepEqual((await repo.page(KINDS.audit, org)).rows.map(r => r.id), [audit.id], 'the audit entry is owned by the company');

  // A cas fn that throws aborts the whole commit (the D8 last-owner guard lives in such a fn).
  const lastOwner = await repo.commit({
    cas: [{ kind: KINDS.org, id: org, rev: null, fn: d => { d.ownerIds = []; if (!d.ownerIds.length) throw new AppError('last_owner', 'A company needs at least one owner.', 422); } }],
    inserts: [actorLib.auditInsert(repo, { orgId: org, actor: { system: 'clock' }, action: 'member.role_changed', target: { kind: KINDS.org, id: org }, summary: 'x' })],
  }).catch(e => e);
  assert.equal(lastOwner.code, 'last_owner');
  assert.deepEqual((await repo.get(KINDS.org, org)).ownerIds, ['usr_OOOOOOOOOOOOOOOO']);

  // Write-mode rules: audit, links and policy versions are insert-only; members and orgs are never deleted.
  await assert.rejects(repo.commit({ cas: [{ kind: KINDS.audit, id: audit.id, rev: null, fn: () => {} }] }), /insert-only/);
  await assert.rejects(repo.commit({ deletes: [{ kind: KINDS.member, id: `${org}.usr_DDDDDDDDDDDDDDDD`, rev: null }] }), /never deleted/);
  await assert.rejects(repo.commit({ deletes: [{ kind: KINDS.org, id: org, rev: null }] }), /never deleted/);
  await assert.rejects(repo.del(KINDS.member, `${org}.usr_DDDDDDDDDDDDDDDD`), /never deleted/);
  await assert.rejects(repo.commit({ puts: [] }), /commit takes cas, checks, inserts and deletes/);
  await assert.rejects(repo.commit({ cas: {} }), /must be an array/);
  assert.equal((await repo.commit({ checks: [{ kind: KINDS.member, id: 'nobody', rev: null }] }).catch(e => e)).status, 404, 'a check on a missing record');
  // A CAS delete with the right rev.
  await repo.insert(KINDS.inviteEmail, `${org}.abc`, { orgId: org, inviteHash: 'h', rev: 0 }, { owner: org });
  await repo.commit({ deletes: [{ kind: KINDS.inviteEmail, id: `${org}.abc`, rev: 0 }] });
  assert.equal(await repo.get(KINDS.inviteEmail, `${org}.abc`), null);
});

test('repo: withRetry re-runs server-side conflicts only, and gives up after its tries', async () => {
  const store = new MemoryStore();
  const repo = newRepo(store);
  const org = id('org');
  await repo.insert(KINDS.budget, 'b1', { orgId: org, commits: {}, rev: 0 }, { owner: org });
  // A rival writes between our read and our commit on the first two attempts.
  let rivals = 2, attempts = 0;
  const hold = async rid => repo.withRetry(async () => {
    attempts += 1;
    const cur = await repo.get(KINDS.budget, 'b1');
    if (rivals > 0) { rivals -= 1; await repo.cas(KINDS.budget, 'b1', null, d => { d.rival = (d.rival || 0) + 1; }); }
    return repo.commit({ cas: [{ kind: KINDS.budget, id: 'b1', rev: cur.rev, server: true, fn: d => { d.commits[rid] = 100; } }] });
  });
  await hold('btr_a');
  assert.equal(attempts, 3);
  assert.deepEqual((await repo.get(KINDS.budget, 'b1')).commits, { btr_a: 100 });

  // A form rev that is stale is never retried.
  attempts = 0;
  const e = await repo.withRetry(async () => { attempts += 1; return repo.cas(KINDS.budget, 'b1', 0, d => { d.x = 1; }); }).catch(x => x);
  assert.equal(e.status, 409);
  assert.equal(attempts, 1);
  // Other errors pass straight through; after `tries` conflicts the last one is thrown.
  attempts = 0;
  const always = await repo.withRetry(async () => { attempts += 1; throw Object.assign(new AppError('conflict', 'x', 409), { retryable: true }); }, { tries: 4 }).catch(x => x);
  assert.equal(always.code, 'conflict');
  assert.equal(attempts, 4);
  assert.equal((await repo.withRetry(async () => { throw new TypeError('bug'); }).catch(x => x)).name, 'TypeError');
  await assert.rejects(repo.withRetry(async () => 1, { tries: 0 }), RangeError);
});

test('repo: page() follows store order with an opaque cursor tied to its kind and scope', async () => {
  const repo = newRepo();
  const orgA = id('org'), orgB = id('org');
  for (let i = 0; i < 7; i += 1) {
    await repo.insert(KINDS.audit, `aud_a${i}`, { id: `aud_a${i}`, orgId: orgA, n: i }, { owner: orgA });
    await repo.insert(KINDS.audit, `aud_b${i}`, { id: `aud_b${i}`, orgId: orgB, n: i }, { owner: orgB });
  }
  const seen = [];
  let cursor = null;
  do {
    const p = await repo.page(KINDS.audit, orgA, { limit: 3, cursor });
    seen.push(...p.rows.map(r => r.n));
    cursor = p.cursor;
  } while (cursor);
  assert.deepEqual(seen, [6, 5, 4, 3, 2, 1, 0]);
  const first = await repo.page(KINDS.audit, orgA, { limit: 3 });
  assert.ok(first.cursor);
  // Company B's list with company A's cursor, another kind, or a damaged cursor: 404.
  for (const [kind, scope, c] of [[KINDS.audit, orgB, first.cursor], [KINDS.request, orgA, first.cursor], [KINDS.audit, orgA, `${first.cursor}x`],
    [KINDS.audit, orgA, first.cursor.split('.')[1]], [KINDS.audit, orgA, 'garbage'], [KINDS.audit, orgA, `${first.cursor.split('.')[0]}.!!`]]) {
    const e = await repo.page(kind, scope, { cursor: c }).catch(x => x);
    assert.ok(e instanceof AppError && e.status === 404, `${kind} ${c}`);
  }
  assert.deepEqual((await repo.page(KINDS.audit, orgA, { cursor: '' })).rows.length, 7, 'an empty cursor is the first page');
  for (const limit of [0, 201, 2.5]) await assert.rejects(repo.page(KINDS.audit, orgA, { limit }), RangeError);
});

// ---------------------------------------------------------------------------------------------------
const fieldError = fn => { try { fn(); } catch (e) { assert.ok(e instanceof AppError && e.code === 'invalid_field' && e.status === 422, e.message); return e.message; } assert.fail('expected an invalid_field error'); };

test('validate: money in cents and percentages in tenths, by string arithmetic', () => {
  assert.equal(v.dollarsToCents('1,000.50'), 100050);
  assert.equal(v.dollarsToCents('$ 25'), 2500);
  assert.equal(v.dollarsToCents('25.5'), 2550);
  assert.equal(v.dollarsToCents('0.07'), 7);
  assert.equal(v.dollarsToCents(17), 1700);
  assert.equal(v.dollarsToCents('9999999.99'), 999999999);
  for (const bad of ['1.005', '-1', 'abc', '1e3', '1.2.3', '12345678', '.5', '0x10', '1,00', ',5', '1,,0', '$$5', '5$', '12,345,678']) fieldError(() => v.dollarsToCents(bad));
  assert.equal(v.dollarsToCents('', { blank: 0 }), 0);
  assert.equal(v.dollarsToCents('  ', { blank: null }), null);
  assert.equal(fieldError(() => v.dollarsToCents('')), 'Enter an amount.');
  assert.equal(fieldError(() => v.dollarsToCents('2000.01', { max: 200000 })), 'The most you can enter is $2,000.');
  assert.equal(v.percentTenths('7.5'), 75);
  assert.equal(v.percentTenths('13.7%'), 137);
  assert.equal(v.percentTenths('30', { max: 300 }), 300);
  for (const bad of ['7.55', '-1', '100', 'abc', '1,5']) fieldError(() => v.percentTenths(bad));
  assert.equal(fieldError(() => v.percentTenths('30.1', { max: 300 })), 'The most you can enter is 30%.');
});

test('validate: emails, phones, text, choices and collected errors; the brand validators are gone', () => {
  assert.equal(v.email(' Ada@Example.COM '), 'ada@example.com');
  assert.equal(v.email('', { optional: true }), '');
  for (const bad of ['', 'ada', 'ada@x', '<a>@x.com', `${'a'.repeat(120)}@x.com`, 'hello‮@acme.example']) fieldError(() => v.email(bad));
  assert.equal(v.phone('+1 (555) 010-0199'), '+1 (555) 010-0199');
  for (const bad of ['', 'call me', '12', '5'.repeat(31)]) fieldError(() => v.phone(bad));
  assert.equal(v.text('  hi\u0000there  ', 100), 'hi there');
  assert.equal(v.text('line one\r\nline two\n\n\n\nend', 100, { multiline: true }), 'line one\nline two\n\nend');
  assert.equal(v.text('Trip​elyx', 20), 'Tripelyx');
  assert.equal(v.text('Ｔｒｉｐelyx', 20), 'Tripelyx');
  assert.equal(fieldError(() => v.text('​ ‮', 10, { required: true })), 'Fill in this field.');
  assert.equal(v.oneOf('director', constants.TIERS), 'director');
  assert.equal(v.oneOf('', constants.TIERS, { blank: null }), null);
  for (const bad of ['Director', '', '__proto__', undefined]) fieldError(() => v.oneOf(bad, constants.TIERS));
  const e = (() => { try { return v.collect('invalid_member', { email: () => v.email('nope'), tier: () => v.oneOf('x', constants.TIERS), name: () => v.text('Sam', 80) }); } catch (x) { return x; } })();
  assert.ok(e instanceof AppError && e.code === 'invalid_member' && e.status === 422);
  assert.deepEqual(Object.keys(e.details), ['email', 'tier']);
  assert.throws(() => v.collect('x', { a: () => { throw new TypeError('bug'); } }), TypeError);
  for (const gone of ['httpsUrl', 'hexColor', 'contrast', 'MIN_CONTRAST']) assert.ok(!(gone in v), gone);
});

test('validate: safeLocal is lib/validate.localPath (D10 vectors)', () => {
  const { localPath } = require('../server/lib/validate');
  const decoded = new URLSearchParams('next=%2F%5Cevil.example').get('next');
  for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil', '/\n/evil', '/\r/evil', decoded, 'https://x', 'business', '', null, 42, undefined]) {
    assert.equal(v.safeLocal(bad), null, JSON.stringify(bad));
    assert.equal(v.safeLocal(bad, '/business/app'), '/business/app');
    assert.equal(localPath(bad, '/my-trips'), '/my-trips');
  }
  for (const ok of ['/plan?x=1', '/business/o/x?ok=1', '/business/invite/abc', '/']) assert.equal(v.safeLocal(ok), ok);
  assert.equal(v.safeLocal(`/${'a'.repeat(400)}`).length, 300, 'at most 300 characters are kept');
});

// ---------------------------------------------------------------------------------------------------
test('cards: Luhn-valid 13 to 19 digit numbers are found, phone numbers, dates and long ids are not', () => {
  for (const s of ['4242 4242 4242 4242', 'my card is 4242424242424242, exp 12/28', '4242-4242-4242-4242', '5555.5555.5555.4444',
    'amex 3782 822463 10005', '4242 4242 4242 4242 12 28 123', 'ＣＡＲＤ ４２４２４２４２４２４２４２４２', 'card:4111111111111111',
    '5555-5555-5555-4444 exp', '378282246310005', '٤٢٤٢٤٢٤٢٤٢٤٢٤٢٤٢', '۴۲۴۲ ۴۲۴۲ ۴۲۴۲ ۴۲۴۲']) {
    assert.equal(cards.hasCardNumber(s), true, s);
  }
  for (const s of ['+1 (555) 123-4567', '+44 20 7946 0958', 'call 212 555 0100 or 646 555 0199', '4242 4242 4242 4241', 'Leaving 2026-10-27, back 2026-11-02',
    'Budget $2,500 for 2 travelers', 'Booking ref 12345678901234567890123', '+20 10 1234 5678', '', null, undefined]) {
    assert.equal(cards.hasCardNumber(s), false, String(s));
  }
  assert.equal(cards.containsCardNumber, cards.hasCardNumber);
  assert.equal(cards.luhn('79927398713'), true);
  assert.equal(cards.luhn('79927398710'), false);
  assert.equal(cards.CARD_MESSAGE, "For your security, don't send card numbers here.");
});

// ---------------------------------------------------------------------------------------------------
async function limiterApp(biz, logger) {
  const lim = createBusinessLimits(biz, { logger });
  const app = express();
  app.use((req, res, next) => { const u = req.get('x-user'); req.user = u ? { id: u } : null; next(); });
  const form = express.urlencoded({ extended: false });
  const ok = (req, res) => res.send('ok');
  app.post('/start', lim.bizAuthIp, ok);
  app.post('/signin', lim.bizAuthIp, form, lim.bizAuthAccount, (req, res) => res.status(req.body.password === 'right' ? 303 : 401).send('done'));
  app.post('/misplaced', lim.bizAuthAccount, ok);
  app.post('/write', lim.bizWrite, ok);
  app.get('/compute', lim.bizCompute, ok);
  app.use((err, req, res, next) => res.status(err.status || 500).send(`${err.code || 'error'}|${err.message}`));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('limits: per IP for sign-up, per email after the form for sign-in, per user for writes and compute', async t => {
  const logged = [];
  const logger = { warn: (...a) => logged.push(['warn', ...a]), error: (...a) => logged.push(['error', ...a]) };
  const srv = await limiterApp({ authLimit: 30, writeLimit: 2, computeLimit: 1 }, logger);
  t.after(srv.close);
  const post = (path, { user, form } = {}) => fetch(srv.base + path, {
    method: 'POST', headers: { ...(user ? { 'x-user': user } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });

  // Ten failed sign-ins on one address, then that address is limited (whatever its case), others are not.
  for (let i = 0; i < ACCOUNT_LIMIT; i += 1) assert.equal((await post('/signin', { form: { email: 'dana@acme.example', password: 'wrong' } })).status, 401, `attempt ${i + 1}`);
  const over = await post('/signin', { form: { email: ' DANA@Acme.Example ', password: 'right' } });
  assert.equal(over.status, 429);
  assert.equal(await over.text(), 'rate_limited|Too many requests in a short time. Wait a few minutes and try again.');
  // Control characters the account lookup turns into spaces and trims give no fresh budget either.
  for (const e of ['dana@acme.example\x01', 'dana@acme.example\x7f', 'dana@acme.example\x1f', 'dana@acme.example\x01\x01', '\x02dana@acme.example', '\tDANA@acme.example\x03']) {
    assert.equal((await post('/signin', { form: { email: e, password: 'right' } })).status, 429, JSON.stringify(e));
  }
  assert.equal((await post('/signin', { form: { email: 'sam@acme.example', password: 'wrong' } })).status, 401, 'another address has its own budget');
  // Successful sign-ins do not count against the address.
  for (let i = 0; i < ACCOUNT_LIMIT + 2; i += 1) assert.equal((await post('/signin', { form: { email: 'ok@acme.example', password: 'right' } })).status, 303);
  // Mounted before the form parser, it refuses to guess.
  const misplaced = await post('/misplaced', { form: { email: 'x@y.z' } });
  assert.equal(misplaced.status, 500);
  assert.match(await misplaced.text(), /must run after the form parser/);

  assert.equal((await post('/write', { user: 'usr_a' })).status, 200);
  assert.equal((await post('/write', { user: 'usr_a' })).status, 200);
  assert.equal((await post('/write', { user: 'usr_a' })).status, 429);
  assert.equal((await post('/write', { user: 'usr_b' })).status, 200, 'two users on one IP do not share a budget');
  assert.equal((await fetch(`${srv.base}/compute`, { headers: { 'x-user': 'usr_a' } })).status, 200);
  assert.equal((await fetch(`${srv.base}/compute`, { headers: { 'x-user': 'usr_a' } })).status, 429);
  assert.equal((await fetch(`${srv.base}/compute`, { headers: { 'x-user': 'usr_b' } })).status, 200);
  assert.deepEqual(logged.filter(l => l[0] === 'warn' || !/must run after/.test(String(l[1]))), [], 'express-rate-limit reports no misconfiguration');
});

test('limits: the per-account key is the address Accounts.authenticate looks up, so every spelling that signs in shares one budget', async () => {
  const accounts = new Accounts({ store: new MemoryStore(), config: loadConfig({}), now: () => new Date(FIXED_NOW) });
  const user = await accounts.register({ name: 'Dana Lee', email: 'dana@acme.example', password: 'correct horse battery' });
  const key = e => accountKey({ body: { email: e } });
  const variants = ['dana@acme.example', ' DANA@Acme.Example ', 'dana@acme.example\x01', '\x7fdana@acme.example\x1f\x1f', `dana@acme.example${'\x00'.repeat(3)}`];
  for (const e of variants) {
    assert.equal((await accounts.authenticate({ email: e, password: 'correct horse battery' })).id, user.id, JSON.stringify(e));
    assert.equal(key(e), key('dana@acme.example'), JSON.stringify(e));
  }
  assert.notEqual(key('sam@acme.example'), key('dana@acme.example'));
  assert.match(key('dana@acme.example'), /^acct:[0-9a-f]{16}$/, 'a short hash, never the address');
});

test('limits: defaults come from config; the sign-up IP limit is 20 per 10 minutes', async t => {
  const biz = loadConfig({}).business;
  const lim = createBusinessLimits(biz);
  assert.deepEqual(Object.keys(lim).sort(), ['bizAuthAccount', 'bizAuthIp', 'bizCompute', 'bizWrite']);
  const srv = await limiterApp(biz);
  t.after(srv.close);
  const policy = async (path, opts = {}) => (await fetch(srv.base + path, opts)).headers.get('ratelimit-policy');
  assert.equal(await policy('/start', { method: 'POST' }), '20;w=600');
  assert.equal(await policy('/write', { method: 'POST', headers: { 'x-user': 'usr_a' } }), '300;w=600');
  assert.equal(await policy('/compute', { headers: { 'x-user': 'usr_a' } }), '30;w=60');
  const r = await fetch(`${srv.base}/start`, { method: 'POST' });
  let last = r.status;
  for (let i = 0; i < 20; i += 1) last = (await fetch(`${srv.base}/start`, { method: 'POST' })).status;
  assert.equal(last, 429, 'the 21st sign-up from one IP is refused');
});

// ---------------------------------------------------------------------------------------------------
// The actor re-read (actor.js) and the HTTP guards (http.js), on a seeded company.
async function seededCompany() {
  const app = await startApp({ ENABLE_BUSINESS: 'true' });
  const owner = await seedUser(app, { name: 'Olivia Owner', email: 'olivia@acme.example' });
  const org = await seedOrg(app, owner, { name: 'Acme Inc' });
  const add = (role, who = {}) => seedMember(app, org, role, who);
  return { app, owner, org, add, repo: app.business.repo };
}

test('actor: the company and member are re-read; forged, stale, removed and foreign actors get 404; suspended 403', async t => {
  const { app, owner, org, add, repo } = await seededCompany();
  t.after(app.close);
  const sam = await add('employee', { name: 'Sam Traveler' });
  const a = await actorLib.loadActor(repo, { org: { id: org.id, name: 'forged' }, member: { role: 'owner' }, user: sam.user });
  assert.equal(a.member.role, 'employee', 'the role comes from the stored member, never the actor passed in');
  assert.equal(a.org.name, 'Acme Inc');
  const otherOwner = await seedUser(app, { name: 'Other Owner' });
  const other = await seedOrg(app, otherOwner, { name: 'Other Co' });
  for (const forged of [{ org: { id: other.id }, user: sam.user }, { org: { id: org.id }, user: otherOwner.user }, { org: { id: 'org_nope' }, user: sam.user },
    { org: { id: org.id } }, { user: sam.user }, null, { org: { id: org.id }, user: { id: '' } }]) {
    const e = await actorLib.loadActor(repo, forged).catch(x => x);
    assert.ok(e instanceof AppError && e.status === 404, JSON.stringify(forged));
  }
  await repo.cas(KINDS.member, `${org.id}.${sam.user.id}`, null, d => { d.status = 'removed'; d.removedAt = repo.iso(); });
  assert.equal((await actorLib.loadActor(repo, { org: { id: org.id }, user: sam.user }).catch(x => x)).status, 404, 'a removed member');
  await repo.cas(KINDS.org, org.id, null, d => { d.status = 'pending'; });
  assert.equal((await actorLib.loadActor(repo, { org: { id: org.id }, user: owner.user })).org.status, 'pending', 'a pending company works');
  await repo.cas(KINDS.org, org.id, null, d => { d.status = 'suspended'; });
  const susp = await actorLib.loadActor(repo, { org: { id: org.id }, user: owner.user }).catch(x => x);
  assert.equal(susp.status, 403);
  assert.equal(susp.message, 'Tripelyx has paused this company workspace. Write to go@tripelyx.com.');

  const emp = { org: { id: org.id, name: 'Acme Inc' }, member: { role: 'employee', userId: sam.user.id }, user: sam.user };
  const f = (() => { try { actorLib.need(emp, 'policy.edit'); } catch (e) { return e; } })();
  assert.equal(f.status, 403);
  assert.equal(f.message, "Your role (Employee) can't open this page. Ask a travel admin at Acme Inc if you need it.");
  assert.equal(f.role, 'employee');
  const n = (() => { try { actorLib.need(emp, 'request.view.own', { travelerId: 'usr_OOOOOOOOOOOOOOOO' }); } catch (e) { return e; } })();
  assert.equal(n.status, 404, 'a record outside the scope is a 404, not a 403');
  assert.doesNotThrow(() => actorLib.need(emp, 'request.view.own', { travelerId: sam.user.id }));
  assert.deepEqual(actorLib.who({ member: { name: 'Sam Traveler', role: 'employee' }, user: sam.user }), { userId: sam.user.id, name: 'Sam Traveler', role: 'employee' });
  assert.deepEqual(actorLib.platformActor({ id: 'usr_PPPPPPPPPPPPPPPP', name: 'Moataz' }), { platformAdmin: 'usr_PPPPPPPPPPPPPPPP', name: 'Moataz' });
  assert.deepEqual(actorLib.systemActor('clock'), { system: 'clock' });
  assert.throws(() => actorLib.systemActor('cron'), /unknown system actor/);
});

test('actor: auditInsert builds one entry for the same commit, stamped by the injected clock', () => {
  const clock = mutableClock('2026-11-12T08:35:00.000Z');
  const repo = newRepo(new MemoryStore(), clock.now);
  const org = id('org');
  const e = actorLib.auditInsert(repo, { orgId: org, actor: { system: 'policy' }, action: 'request.auto_approved', target: { kind: KINDS.request, id: 'btr_1' }, summary: `Approved by policy‮ ${'x'.repeat(400)}` });
  assert.equal(e.kind, KINDS.audit);
  assert.equal(e.owner, org);
  assert.match(e.id, /^aud_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(Object.keys(e.data), ['id', 'orgId', 'at', 'actor', 'action', 'group', 'target', 'summary', 'changes']);
  assert.equal(e.data.at, '2026-11-12T08:35:00.000Z');
  assert.equal(e.data.group, 'request');
  assert.equal(e.data.summary.length, 300);
  assert.ok(!e.data.summary.includes('‮'));
  for (const action of ['request.booked', 'proposal.sent', 'org', '', null]) {
    assert.throws(() => actorLib.auditInsert(repo, { orgId: org, actor: { system: 'clock' }, action, target: { kind: 'k', id: 'i' }, summary: '' }), /unknown audit action/);
  }
  assert.throws(() => actorLib.auditInsert(repo, { orgId: org, action: 'budget.set', target: { kind: 'k', id: 'i' }, summary: '' }), /needs an actor/);
  assert.throws(() => actorLib.auditInsert(repo, { orgId: org, actor: { system: 'clock' }, action: 'budget.set', summary: '' }), /needs a target/);
});

/** A tiny app around the guards, with req.user taken from an x-user header. */
async function guardApp(ctx, users) {
  const app = express();
  app.use((req, res, next) => { req.user = users[req.get('x-user')] || null; next(); });
  const g = http.gates(ctx);
  const ok = (req, res) => res.json({ org: req.biz.org.id, role: req.biz.member.role, request: req.biz.request ? req.biz.request.id : null });
  app.get('/business/o/:orgId', g.memberGate('org.view'), ok);
  app.get('/business/o/:orgId/activity', g.memberGate('audit.view'), ok);
  app.post('/business/o/:orgId/policies/:tier', g.memberGate('policy.edit'), ok);
  app.get('/business/o/:orgId/budgets', g.memberGate(['budget.view.dept', 'budget.view.all']), ok);
  app.get('/business/o/:orgId/trips/:rid', g.memberGate(['request.view.all', 'request.view.team', 'request.view.own'], { own: 'request' }), ok);
  app.post('/business/o/:orgId/trips/:rid/decide', g.memberGate(['approval.decide', 'approval.override'], { own: 'request' }), ok);
  app.get('/business/o/:orgId/shell', g.memberGate('org.view'), async (req, res, next) => { try { res.json(await g.shellContext(req)); } catch (e) { next(e); } });
  app.post('/business/signout', g.requireUser, (req, res) => res.send('bye'));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code, message: err.message }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('memberGate: 404 for non-members and foreign ids, 403 with the role, suspended 403, no-store, sign-in redirects, own:request scopes', async t => {
  const { app, owner, org, add, repo } = await seededCompany();
  t.after(app.close);
  const dana = await add('manager', { name: 'Dana Lee' });
  const sam = await add('employee', { name: 'Sam Traveler', managerId: dana.user.id });
  const ben = await add('employee', { name: 'Ben Other' });
  const fin = await add('finance', { name: 'Fay Finance' });
  const ta = await add('travel_admin', { name: 'Tara Admin' });
  const otherOwner = await seedUser(app, { name: 'Other Owner' });
  const other = await seedOrg(app, otherOwner, { name: 'Other Co' });
  const stranger = await seedUser(app, { name: 'Stan Stranger' });
  const admin = await seedUser(app, { name: 'Pat Platform', email: 'ops@example.com' });
  const rid = id('btr');
  await repo.insert(KINDS.request, rid, { id: rid, orgId: org.id, travelerId: sam.user.id, travelerManagerId: dana.user.id, departmentId: null, status: 'pending', approval: { approverId: null, pool: true }, rev: 0 }, { owner: org.id });
  const foreignRid = id('btr');
  await repo.insert(KINDS.request, foreignRid, { id: foreignRid, orgId: other.id, travelerId: otherOwner.user.id, status: 'draft', rev: 0 }, { owner: other.id });
  const users = {
    owner: owner.user, dana: dana.user, sam: sam.user, ben: ben.user, fin: fin.user, ta: ta.user, other: otherOwner.user, stranger: stranger.user,
    admin: { ...admin.user, isAdmin: true },
  };
  const svc = app.ctx.business;
  svc.listCompaniesFor = async actor => [{ id: actor.org.id, name: actor.org.name, role: actor.member.role }];
  svc.inboxCount = async actor => (actor.member.role === 'manager' ? 2 : 0);
  const g = await guardApp(app.ctx, users);
  t.after(g.close);
  const req = (path, who, opts = {}) => fetch(g.base + path, { redirect: 'manual', ...opts, headers: { ...(who ? { 'x-user': who } : {}), ...(opts.headers || {}) } });
  const o = `/business/o/${org.id}`;

  let r = await req(o, 'owner');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(await r.json(), { org: org.id, role: 'owner', request: null });

  for (const [path, who] of [[o, 'stranger'], [o, 'admin'], [o, 'other'], ['/business/o/org_AAAAAAAAAAAAAAAA', 'owner'], [`/business/o/${other.id}`, 'owner'],
    [`${o}/trips/${foreignRid}`, 'owner'], [`${o}/trips/btr_nope`, 'owner'], [`${o}/trips/${rid}`, 'ben'], [`/business/o/${other.id}/trips/${rid}`, 'other']]) {
    r = await req(path, who);
    assert.equal(r.status, 404, `${who} ${path}`);
    const body = await r.text();
    assert.match(body, /Page not found/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    noInline(path, body);
  }

  // own:request: the traveler, their manager, anyone with request.view.all; a pool link for a decider.
  for (const who of ['sam', 'dana', 'fin', 'ta', 'owner']) assert.equal((await req(`${o}/trips/${rid}`, who)).status, 200, who);
  assert.deepEqual(await (await req(`${o}/trips/${rid}`, 'sam')).json(), { org: org.id, role: 'employee', request: rid });
  assert.equal((await req(`${o}/trips/${rid}/decide`, 'sam', { method: 'POST' })).status, 403, 'an Employee holds neither decide nor override');
  assert.equal((await req(`${o}/trips/${rid}/decide`, 'dana', { method: 'POST' })).status, 404, 'the manager is not the assigned approver and has no pool link');
  assert.equal((await req(`${o}/trips/${rid}/decide`, 'ta', { method: 'POST' })).status, 200, 'override holders may decide');
  await repo.insert(KINDS.reqLink, `${rid}.pool.${dana.user.id}`, { orgId: org.id, requestId: rid, userId: dana.user.id, role: 'pool', at: FIXED_NOW }, { owner: memberScope(org.id, dana.user.id) });
  assert.equal((await req(`${o}/trips/${rid}/decide`, 'dana', { method: 'POST' })).status, 200, 'a pool link lets her decide');
  assert.equal((await req(`${o}/trips/${rid}`, 'ben')).status, 404);

  r = await req(`${o}/activity`, 'sam');
  assert.equal(r.status, 403);
  assert.match(await r.text(), /Your role \(Employee\) can(’|'|&#39;|&#x27;)t open this page\. Ask a travel admin at Acme Inc if you need it\./);
  assert.equal((await req(`${o}/policies/standard`, 'fin', { method: 'POST' })).status, 403, 'Finance reads policies but cannot edit them');
  assert.equal((await req(`${o}/budgets`, 'dana')).status, 200, 'any one of the listed permissions is enough');
  assert.equal((await req(`${o}/budgets`, 'sam')).status, 403);

  r = await req(`${o}/activity?x=1`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `/business/signin?next=${encodeURIComponent(`${o}/activity?x=1`)}`);
  r = await req(`${o}/policies/standard`, null, { method: 'POST' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/business/signin');
  assert.equal((await req('/business/signout', null, { method: 'POST' })).status, 303);
  assert.equal((await req('/business/signout', 'sam', { method: 'POST' })).status, 200);

  // A removed member is a stranger again.
  await repo.cas(KINDS.member, `${org.id}.${ben.user.id}`, null, d => { d.status = 'removed'; });
  assert.equal((await req(o, 'ben')).status, 404);

  await repo.cas(KINDS.org, org.id, null, d => { d.status = 'suspended'; });
  r = await req(o, 'owner');
  assert.equal(r.status, 403);
  assert.match(await r.text(), /Tripelyx has paused this company workspace\. Write to go@tripelyx\.com\./);
  assert.equal((await req(o, 'stranger')).status, 404, 'a suspended company is still invisible to strangers');
  assert.throws(() => http.memberGate(app.ctx, 'no.such.perm'), /unknown permission/);
  assert.throws(() => http.memberGate(app.ctx, ['org.view', 'pricing.editRules']), /unknown permission/);
  assert.throws(() => http.memberGate(app.ctx, 'org.view', { own: 'proposal' }), /own must be/);
  assert.equal(http.memberGate(app.ctx, 'org.view').name, 'bizMemberGate', 'the structural route test looks for this name');
});

test('shellContext and navFor: the switcher, the approvals count and the navigation each role reaches', async t => {
  const { app, owner, org, add } = await seededCompany();
  t.after(app.close);
  const dana = await add('manager', { name: 'Dana Lee' });
  const sam = await add('employee', { name: 'Sam Traveler' });
  const fin = await add('finance', { name: 'Fay Finance' });
  const svc = app.ctx.business;
  const calls = [];
  svc.listCompaniesFor = async actor => { calls.push(['list', actor.user.id]); return [{ id: actor.org.id, name: actor.org.name, role: actor.member.role, status: actor.org.status }]; };
  svc.inboxCount = async actor => { calls.push(['inbox', actor.member.role]); return 3; };
  const g = await guardApp(app.ctx, { owner: owner.user, dana: dana.user, sam: sam.user, fin: fin.user });
  t.after(g.close);
  const shell = async who => (await fetch(`${g.base}/business/o/${org.id}/shell`, { headers: { 'x-user': who } })).json();

  const m = await shell('dana');
  assert.equal(m.org.id, org.id);
  assert.equal(m.member.role, 'manager');
  assert.deepEqual(m.companies, [{ id: org.id, name: 'Acme Inc', role: 'manager', status: 'active' }]);
  assert.equal(m.approvalsCount, 3);
  assert.deepEqual(m.nav.map(n => n.label), ['Home', 'Plan a trip', 'Trips', 'Approvals', 'Policy', 'Budgets', 'People', 'Settings']);
  const e = await shell('sam');
  assert.equal(e.approvalsCount, null, 'no count chip without approval.decide');
  assert.deepEqual(e.nav.map(n => n.label), ['Home', 'Plan a trip', 'Trips', 'Policy', 'Settings']);
  assert.equal(e.nav.find(n => n.key === 'policy').href, `/business/o/${org.id}/policy`, '"Your travel policy" for travelers');
  const f = await shell('fin');
  assert.deepEqual(f.nav.map(n => n.label), ['Home', 'Plan a trip', 'Trips', 'Policy', 'Budgets', 'People', 'Reports', 'Activity', 'Settings']);
  assert.equal(f.nav.find(n => n.key === 'policy').href, `/business/o/${org.id}/policies`, 'every tier for policy.view.all');
  const ow = await shell('owner');
  assert.deepEqual(ow.nav.map(n => n.label), ['Home', 'Plan a trip', 'Trips', 'Approvals', 'Policy', 'Budgets', 'People', 'Reports', 'Activity', 'Settings']);
  assert.deepEqual(calls.filter(c => c[0] === 'inbox').map(c => c[1]), ['manager', 'owner']);
  assert.ok(calls.filter(c => c[0] === 'list').length === 4);

  // The current section: the longest matching path at a "/" boundary.
  const base = `/business/o/${org.id}`;
  const cur = path => http.navFor({ id: org.id }, { role: 'owner' }, path).filter(n => n.current).map(n => n.key);
  assert.deepEqual(cur(base), ['home']);
  assert.deepEqual(cur(`${base}/`), ['home']);
  assert.deepEqual(cur(`${base}/trips/new?from=CAI`), ['plan']);
  assert.deepEqual(cur(`${base}/trips/btr_x`), ['trips']);
  assert.deepEqual(cur(`${base}/tripsx`), []);
  assert.deepEqual(cur(`${base}/policies/standard/history`), ['policy']);
  assert.deepEqual(cur('/business/o/org_OTHEROTHEROTHER1/trips'), []);
  await assert.rejects(http.shellContext(app.ctx, {}), /runs after memberGate/);
});

// ---------------------------------------------------------------------------------------------------
test('redactUrl: invite tokens, token= values and token-shaped runs never reach the log (D9)', () => {
  const tok = tokens.newToken();
  assert.equal(redactUrl(`/business/invite/${tok}`), '/business/invite/[redacted]');
  assert.equal(redactUrl(`/business/invite/${tok}/accept?x=1`), '/business/invite/[redacted]/accept?x=1');
  assert.equal(redactUrl('/BUSINESS/INVITE/short'), '/BUSINESS/INVITE/[redacted]');
  assert.equal(redactUrl('/reset?token=abc123&x=1'), '/reset?token=[redacted]&x=1');
  assert.equal(redactUrl('/x?a=1&access_token=abc;b=2'), '/x?a=1&access_token=[redacted];b=2');
  assert.equal(redactUrl(`/business/signin?next=${encodeURIComponent(`/business/invite/${tok}`)}`), '/business/signin?next=%2Fbusiness%2Finvite%[token]');
  assert.equal(redactUrl(`/p/${tok}`), '/p/[token]');
  for (const s of [redactUrl(`/business/invite/${tok}`), redactUrl(`/business/signin?next=${encodeURIComponent(`/business/invite/${tok}`)}`), redactUrl(`/x?token=${tok}`)]) {
    assert.ok(!s.includes(tok) && !s.includes(tok.slice(0, 20)), s);
  }
  // Ordinary URLs are untouched.
  for (const s of ['/business/o/org_AAAAAAAAAAAAAAAA/trips/btr_BBBBBBBBBBBBBBBB?scope=team', '/book/flights?from=CAI&to=DBB', '/']) assert.equal(redactUrl(s), s);
  assert.equal(redactUrl(`/${'a'.repeat(30)}/`.repeat(40)).length, 500);
  assert.equal(redactUrl(undefined), '');
});

test('app: the 500 log line carries the redacted URL', async t => {
  const logged = [];
  const log = { ...quietLog, error: (...a) => logged.push(a) };
  const app = await startApp({ ENABLE_BUSINESS: 'true' }, { log });
  t.after(app.close);
  // The error handler is the app's last middleware: hand it an unexpected error for a token URL.
  const stack = (app.app.router || app.app._router).stack;
  const handler = stack[stack.length - 1].handle;
  assert.equal(handler.length, 4);
  const tok = tokens.newToken();
  const res = { statusCode: 0, status(s) { this.statusCode = s; return this; }, type() { return this; }, send(b) { this.body = b; return this; } };
  handler(new Error('boom'), { method: 'GET', originalUrl: `/business/invite/${tok}/accept`, path: `/business/invite/${tok}/accept` }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /^\[error [A-Za-z0-9_-]{10}\] GET \/business\/invite\/\[redacted\]\/accept$/);
  assert.ok(!JSON.stringify(logged[0][0]).includes(tok));
  // The error itself is logged redacted too: a message or stack that quotes a token never reaches the log.
  logged.length = 0;
  const quoting = new Error(`Failed to decode param '${tok}%E0'`);
  handler(quoting, { method: 'GET', originalUrl: `/business/invite/${tok}%E0`, path: `/business/invite/${tok}%E0` }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(logged.length, 1);
  for (const arg of logged[0]) {
    const text = arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg);
    assert.ok(!text.includes(tok) && !text.includes(tok.slice(0, 20)), `a log argument quotes the token: ${text.slice(0, 120)}`);
  }
  assert.match(String(logged[0][1]), /Failed to decode param '\[token\]%E0'/, 'the redacted error is still logged');

  // A client error from Express or the body parser (status 4xx, not an AppError) answers with that status
  // and is not logged as a server fault: a malformed escape after a token is a 400, logged nowhere.
  logged.length = 0;
  for (const path of [`/book/flights/${tok}%E0`, `/business/invite/${tok}%E0`]) {
    const r = await fetch(app.base + path);
    assert.ok(r.status === 400 || r.status === 404, `${path}: ${r.status}`);
    assert.ok(!(await r.text()).includes(tok));
  }
  const decode = new URIError(`Failed to decode param '${tok}%E0'`);
  decode.status = 400;
  handler(decode, { method: 'GET', originalUrl: `/business/invite/${tok}%E0`, path: `/business/invite/${tok}%E0` }, res, () => {});
  assert.equal(res.statusCode, 400);
  // The body parser's http-errors shape (expose true below 500).
  const tooBig = Object.assign(new Error('request entity too large'), { status: 413, expose: true, type: 'entity.too.large' });
  handler(tooBig, { method: 'POST', originalUrl: '/business/signin', path: '/business/signin' }, res, () => {});
  assert.equal(res.statusCode, 413);
  assert.match(String(res.body), /could not be read/);
  assert.deepEqual(logged, [], 'client errors are not logged');
  // Any other error that happens to carry a 4xx status (say a library's upstream 404) is a server fault.
  const upstream = Object.assign(new Error('upstream said 404'), { status: 404 });
  handler(upstream, { method: 'GET', originalUrl: '/business/app', path: '/business/app' }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.equal(logged.length, 1, 'a stray 4xx status on an unexpected error is still logged');
});

test('app: ctx.business and its Repo exist only with Business on, with trips on or off; the advisor-era mounts are gone', async t => {
  const app = await startApp({ ENABLE_BUSINESS: 'true' });
  t.after(app.close);
  assert.ok(app.business, 'createApp returns business');
  assert.equal(app.ctx.business, app.business);
  assert.ok(app.business.repo instanceof Repo);
  assert.equal(app.business.repo.store, app.store);
  assert.equal(app.business.accounts, app.accounts);
  assert.equal(app.business.config, app.config);
  assert.equal(typeof app.business.now, 'function');
  assert.ok(!('store' in app.business) && !('tripService' in app.business), 'Business reaches the store only through its Repo');
  assert.equal(app.ctx.businessNav, true);
  for (const path of ['/', '/plan', '/brands', '/how-it-works', '/business']) assert.equal((await fetch(app.base + path)).status, 200, path);
  // The advisor-era client, brand and preview routes and their session bypass are gone: these are the
  // app's ordinary 404 (visitor cookie and session as on any other page).
  const { user, cookie } = await seedUser(app, { name: 'Zebedee Quartermaine' });
  for (const path of [`/business/p/${tokens.newToken()}`, '/business/brand/x/brand.css', '/business/app', '/business/o/x', '/business/o/x/proposals/p/preview']) {
    const res = await fetch(app.base + path, { redirect: 'manual' });
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get('set-cookie') || '', /^txv=/, `${path}: the visitor cookie as on any page`);
    noInline(path, await res.text());
    const signedIn = await fetch(app.base + path, { headers: { cookie } });
    assert.ok((await signedIn.text()).includes(user.name.split(' ')[0]), `${path}: the session is read as on any page`);
  }
  assert.throws(() => require('../server/routes/businessClient'), /Cannot find module/);
  assert.deepEqual(Object.keys(require('../server/routes/business')).sort(), ['FORM_OPTIONS', 'LIMITERS', 'METHODS', 'MOUNT', 'ROUTES', 'WHO', 'assertRoutes', 'createRouterDeps', 'router']);

  for (const env of [{}, { ENABLE_BUSINESS: 'false' }]) {
    const off = await startApp(env);
    t.after(off.close);
    assert.equal(off.business, null, 'off by default and with ENABLE_BUSINESS=false');
    assert.equal(off.ctx.business, null);
    assert.equal(off.ctx.businessNav, false);
    assert.equal((await fetch(`${off.base}/business`)).status, 404);
  }
});

test('app: Business with trips off builds accounts and reads the session on /business only, with no visitor cookie', async t => {
  const noTrips = await startApp({ ENABLE_TRIPS: 'false', ENABLE_BUSINESS: 'true' });
  t.after(noTrips.close);
  assert.equal(noTrips.tripService, null);
  assert.ok(noTrips.business, 'Business runs with Travel by Budget off');
  assert.ok(noTrips.accounts instanceof Accounts, 'accounts run for Business');
  assert.equal(noTrips.business.accounts, noTrips.accounts);
  assert.equal(noTrips.ctx.businessNav, true);
  const { cookie } = await seedUser(noTrips, { name: 'Nora Notrips' });
  const reads = [];
  const real = noTrips.accounts.userFromRequest.bind(noTrips.accounts);
  noTrips.accounts.userFromRequest = async req => { const u = await real(req); reads.push([req.originalUrl, u && u.name]); return u; };
  for (const path of ['/business', '/business/app', '/admin/business', '/admin/business/x', '/BUSINESS/o/x']) {
    const res = await fetch(noTrips.base + path, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.headers.get('set-cookie'), null, `${path}: no visitor cookie`);
    noInline(path, await res.text());
  }
  assert.deepEqual(reads.map(r => r[0]), ['/business', '/business/app', '/admin/business', '/admin/business/x', '/BUSINESS/o/x']);
  assert.ok(reads.every(r => r[1] === 'Nora Notrips'), 'the session is read');
  reads.length = 0;
  for (const path of ['/', '/about', '/book', '/businessx', '/admin', '/api/search/hotels?where=Cairo']) await fetch(noTrips.base + path, { headers: { cookie } });
  assert.deepEqual(reads, [], 'no other page reads the session with trips off');

  const plainOff = await startApp({ ENABLE_TRIPS: 'false' });
  t.after(plainOff.close);
  assert.equal(plainOff.accounts, null, 'trips off and Business off: no accounts, as before');
  assert.equal(plainOff.business, null);
});

test('app: platform admins are seeded at boot, and a listed email signed up after boot needs a granted record (D1)', async t => {
  const seen = [];
  const real = Accounts.prototype.seedPlatformAdmins;
  Accounts.prototype.seedPlatformAdmins = async function seed(opts) { seen.push(opts && typeof opts.log); return real.call(this, opts); };
  try {
    const app = await startApp({ ADMIN_EMAILS: 'ops@example.com' });
    t.after(app.close);
    const off = await startApp({ ENABLE_TRIPS: 'false' });
    t.after(off.close);
    assert.deepEqual(seen, ['object'], 'once per app with accounts, with the logger');
    assert.deepEqual(await app.accounts.seedPlatformAdmins({ log: quietLog }), { granted: [], missing: ['o***@example.com'] });
    // D1: the email is listed in ADMIN_EMAILS and an active platform_admin record exists (test/accounts-security.test.js).
    const ops = await seedUser(app, { name: 'Ops Person', email: 'ops@example.com' });
    const ada = await seedUser(app, { name: 'Ada Lovelace', email: 'ada@example.com' });
    assert.equal((await fetch(`${app.base}/admin`, { headers: { cookie: ops.cookie } })).status, 404, 'signed up after boot: not an admin yet');
    await app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
    assert.equal((await fetch(`${app.base}/admin`, { headers: { cookie: ops.cookie } })).status, 200);
    assert.equal((await fetch(`${app.base}/admin`, { headers: { cookie: ada.cookie } })).status, 404);
    assert.equal(await app.accounts.isPlatformAdmin(ops.user), true);
    assert.equal(await app.accounts.isPlatformAdmin(ada.user), false);
    assert.equal(await app.accounts.isPlatformAdmin(null), false);
  } finally {
    Accounts.prototype.seedPlatformAdmins = real;
  }
});

test('accounts: grantPlatformAdmin and revokePlatformAdmin write and compare-and-set the platform_admin record', async () => {
  const clock = mutableClock(FIXED_NOW);
  const store = new MemoryStore();
  const accounts = new Accounts({ store, config: loadConfig({ ADMIN_EMAILS: 'ops@example.com' }), now: clock.now });
  const ops = await accounts.register({ name: 'Ops Person', email: 'ops@example.com', password: 'long enough password' });
  const rec = await accounts.grantPlatformAdmin(ops.id, { by: 'test', note: 'suite' });
  assert.deepEqual(rec, { userId: ops.id, email: 'ops@example.com', grantedAt: FIXED_NOW, grantedBy: 'test', revokedAt: null, note: 'suite', rev: 0 });
  assert.equal(PLATFORM_ADMIN, 'platform_admin');
  assert.deepEqual((await store.listRecords(PLATFORM_ADMIN, { userId: ops.id })).length, 1, 'owned by the user');
  clock.advance(1);
  assert.deepEqual(await accounts.grantPlatformAdmin(ops.id, { by: 'cli' }), rec, 'granting an active admin again changes nothing');
  const revoked = await accounts.revokePlatformAdmin(ops.id);
  assert.equal(revoked.revokedAt, '2026-10-10T09:00:00.000Z');
  assert.equal(revoked.rev, 1);
  assert.deepEqual(await accounts.revokePlatformAdmin(ops.id), revoked, 'revoking twice changes nothing');
  clock.advance(1);
  const again = await accounts.grantPlatformAdmin(ops.id, { by: 'cli' });
  assert.deepEqual(again, { userId: ops.id, email: 'ops@example.com', grantedAt: '2026-10-11T09:00:00.000Z', grantedBy: 'cli', revokedAt: null, note: '', rev: 2 });
  assert.equal(await accounts.revokePlatformAdmin('usr_NOBODYNOBODYNOBO'), null);
  await assert.rejects(accounts.grantPlatformAdmin(ops.id, { by: 'self' }), /needs by/);
  await assert.rejects(accounts.grantPlatformAdmin(ops.id), /needs by/);
  assert.equal((await accounts.grantPlatformAdmin('usr_NOBODYNOBODYNOBO', { by: 'test' }).catch(e => e)).status, 404);
  // Listed in ADMIN_EMAILS with an active record: a platform admin.
  assert.equal(await accounts.isPlatformAdmin(ops), true);
});

test('accounts: register takes an optional emailProof (D5) and stores it only when given', async () => {
  const store = new MemoryStore();
  const accounts = new Accounts({ store, config: loadConfig({}), now: fixed });
  const plain = await accounts.register({ name: 'Ada Lovelace', email: 'ada@example.com', password: 'long enough password' });
  assert.ok(!('emailProof' in plain) && !('emailProof' in (await store.getRecord('user', plain.id))), 'sign-up without a proof is unchanged');
  const orgId = id('org');
  const proof = { via: 'invite', orgId, at: FIXED_NOW };
  const dana = await accounts.register({ name: 'Dana Lee', email: 'dana@acme.example', password: 'long enough password' }, { emailProof: proof });
  assert.deepEqual((await store.getRecord('user', dana.id)).emailProof, proof);
  for (const bad of [{ via: 'email', orgId, at: FIXED_NOW }, { via: 'invite', orgId: 'org_x', at: FIXED_NOW }, { via: 'invite', orgId, at: 'soon' }, 'invite', [proof]]) {
    await assert.rejects(accounts.register({ name: 'X Y', email: `x${Math.random()}@example.com`, password: 'long enough password' }, { emailProof: bad }), /emailProof must be/);
  }
  assert.equal((await accounts.register({ name: 'Ada Again', email: 'ada@example.com', password: 'long enough password' }, { emailProof: proof }).catch(e => e)).code, 'email_taken');
});

test('helpers: seeded companies and members have the §C3 shapes, and GETs leave the store alone', async t => {
  const app = await startApp({ ENABLE_BUSINESS: 'true' });
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Olivia Owner', email: 'olivia@example.com' });
  const signedIn = await client(app.base, owner.cookie).get('/my-trips');
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.text.includes('Olivia'));
  const org = await seedOrg(app, owner, { status: 'pending' });
  const repo = app.business.repo;
  const stored = await repo.getIn(KINDS.org, org.id, org.id);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.timezone, 'Africa/Cairo');
  assert.deepEqual(stored.settings, { outOfPolicy: 'approval', approvalHours: 24, reasonMinChars: 10, budgetPeriod: 'quarter' });
  assert.deepEqual(stored.ownerIds, [owner.user.id]);
  assert.equal(stored.memberCount, 1);
  assert.equal(stored.at, app.ctx.now().toISOString().slice(0, 4) + stored.at.slice(4), 'at comes from the clock');
  const om = await repo.getIn(KINDS.member, `${org.id}.${owner.user.id}`, org.id);
  assert.equal(om.role, 'owner');
  assert.equal(om.status, 'active');
  assert.equal(om.tier, 'standard');
  assert.deepEqual((await repo.get(KINDS.userIndex, owner.user.id)).orgIds, [org.id]);
  assert.deepEqual((await repo.page(KINDS.audit, org.id)).rows.map(a => a.action), ['org.created']);
  // What team.createCompany writes: the General department (the owner in it), three policies at version 1
  // from policy/defaults.js and their version records.
  assert.equal(om.departmentId, org.general.id);
  assert.equal(om.by, null, 'the creator was added by nobody');
  assert.deepEqual(org.general, { id: org.general.id, orgId: org.id, name: 'General', archivedAt: null, at: stored.at, updatedAt: stored.at, rev: 0 });
  assert.deepEqual(org.owner, om);
  for (const tier of constants.TIERS) {
    const pol = await repo.getIn(KINDS.policy, `${org.id}.${tier}`, org.id);
    assert.equal(pol.version, 1);
    assert.deepEqual(pol.rules, defaultPolicy(tier));
    assert.deepEqual(pol.updatedBy, { userId: owner.user.id, name: 'Olivia Owner', role: 'owner' });
    const v1 = await repo.getIn(KINDS.policyVersion, `${org.id}.${tier}.v1`, org.id);
    assert.deepEqual(v1, { orgId: org.id, tier, version: 1, rules: defaultPolicy(tier), at: stored.at, by: pol.updatedBy, note: DEFAULTS_NOTE, changes: [] });
  }
  const eng = await seedDepartment(app, org, { name: 'Engineering' });
  const old = await seedDepartment(app, org, { name: 'Old Team', archived: true });
  assert.equal(eng.name, 'Engineering');
  assert.equal(eng.archivedAt, null);
  assert.equal(old.archivedAt, stored.at.slice(0, 4) + old.archivedAt.slice(4));
  const budget = await seedBudget(app, org, eng.id, { amountCents: 500000, commits: { btr_AAAAAAAAAAAAAAAA: 84200 } });
  assert.equal(budget.periodKey, '2026-Q4');
  assert.deepEqual(budget.commits, { btr_AAAAAAAAAAAAAAAA: 84200 });
  assert.deepEqual(await repo.getIn(KINDS.budget, `${org.id}.${eng.id}.2026-Q4`, org.id), budget);
  // (Entries of one commit share its moment, so only the set is compared.)
  assert.deepEqual((await repo.page(KINDS.audit, org.id)).rows.map(a => a.action).sort(),
    ['budget.set', 'department.archived', 'department.created', 'department.created', 'org.created']);

  const second = await seedOrg(app, owner, { name: 'Second Co' });
  assert.deepEqual((await repo.get(KINDS.userIndex, owner.user.id)).orgIds, [org.id, second.id], 'the company index grows under CAS');
  const ta = await seedMember(app, org, 'travel_admin', { name: 'Tara Admin', tier: 'director' });
  const co = await seedMember(app, org, 'owner', { name: 'Cora Owner' });
  assert.equal(ta.member.role, 'travel_admin');
  assert.equal(ta.member.tier, 'director');
  const after = await repo.get(KINDS.org, org.id);
  assert.equal(after.memberCount, 3);
  assert.deepEqual(after.ownerIds, [owner.user.id, co.user.id]);
  assert.deepEqual((await repo.list(KINDS.member, org.id)).map(m => m.role).sort(), ['owner', 'owner', 'travel_admin']);

  const before = storeSnapshot(app);
  await client(app.base, owner.cookie).get('/my-trips');
  await client(app.base, owner.cookie).get('/business');
  assert.equal(storeSnapshot(app), before);
});

// ---------------------------------------------------------------------------------------------------
// Stage 0 frozen interfaces (plan §L steps 8 to 14): the module surfaces Stage 1 builds against.

const businessRoutes = require('../server/routes/business');
const businessPlatform = require('../server/routes/businessPlatform');
const { BusinessService, SERVICE_METHODS, METHOD_MODULE } = require('../server/business/service');
const { createPolicyEngine, POLICY_ENGINE_METHODS } = require('../server/business/policy');
const { DEFAULT_POLICIES, HOTEL_SCALE_PERCENT } = require('../server/business/policy/defaults');
const { createBusinessInventory } = require('../server/business/inventory');
const { TripComposer } = require('../server/business/search');
const { createExplainer } = require('../server/business/explain');
const dto = require('../server/business/dto');
const tz = require('../server/business/tz');
const { assertProvider, validateOffer, validateQuote } = require('../server/providers/contracts');
const demoAirports = require('../server/providers/mock/demo-data/flights').airports;
const fakes = require('./business-fakes');

const NOT_BUILT = /\[business\] not built/;

/** Problems with `value` against a dto deep schema: extra or missing keys at any level, wrong nesting. */
function schemaProblems(value, schema, path = 'row') {
  if (schema === true) return value !== null && typeof value === 'object' ? [`${path} should be a scalar`] : [];
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return [`${path} should be a list`];
    return value.flatMap((v, i) => schemaProblems(v, schema[0], `${path}[${i}]`));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} should be an object`];
  const out = Object.keys(value).filter(k => !Object.hasOwn(schema, k)).map(k => `${path}.${k} is not allowed`);
  for (const k of Object.keys(schema)) {
    if (!Object.hasOwn(value, k)) out.push(`${path}.${k} is missing`);
    else out.push(...schemaProblems(value[k], schema[k], `${path}.${k}`));
  }
  return out;
}

test('interfaces: every Stage 0 Business module loads with its frozen exports, and the stubs throw "[business] not built"', async () => {
  const EXPECTED = {
    team: ['COMPANY_FORM', 'methods'],
    requests: ['HOME_ROWS', 'INBOX_TABS', 'LIST_SCOPES', 'PURPOSE_CHARS', 'methods'],
    budgets: ['PERIOD_KEY_RE', 'committedCents', 'currentPeriodKey', 'methods', 'periodChoices', 'periodKey', 'periodLabel'],
    policies: ['HISTORY_PAGE', 'methods'],
    reports: ['COMING_SOON', 'RECENT_ROWS', 'TOP_REASONS', 'VIEWS', 'checklist', 'methods', 'outOfPolicyShare', 'reportTiles', 'savedBySwitching', 'topReasons'],
    csv: ['BOM', 'CSV_COLUMNS', 'PRICE_SOURCE', 'csvCell', 'methods', 'requestRow', 'toCsv'],
    lifecycle: ['EVENTS', 'HISTORY_MAX', 'MESSAGES_MAX', 'MESSAGE_CHARS', 'NOTE_MIN_CHARS', 'REASON_MAX_CHARS', 'TERMINAL', 'effectiveStatus', 'expiresAt', 'transition'],
    approver: ['SKIP_REASONS', 'resolveApprover'],
    alternatives: ['CHEAPEST_WITHIN_LABEL', 'MAX_ALTERNATIVES', 'MIN_SAVING_CENTS', 'alternativeId', 'buildAlternatives'],
    explain: ['EXPLAINERS', 'EXPLAIN_TIMEOUT_MS', 'FORBIDDEN_TEXT', 'NOTE_MAX', 'RuleExplainer', 'SUMMARY_MAX', 'createExplainer', 'guardExplanation'],
    diff: ['DIFF_FIELDS', 'compareTrips', 'giveUps', 'lineDeltas'],
    inventory: ['createBusinessInventory'],
    search: ['FLEX_DAYS', 'MAX_DAYS_AHEAD', 'MAX_PRICED_PER_LEG', 'MAX_SEARCHES', 'MAX_TRIP_DAYS', 'NIGHTS_RANGE', 'POOL_CAP', 'TripComposer', 'parseTripQuery'],
    dto: ['FLIGHT_ROW_KEYS', 'HOTEL_ROW_KEYS', 'ROW_KEY_RE', 'assertRow', 'extraKeys', 'flightRow', 'hotelRow', 'parseRowKey', 'rowKey'],
    recheck: ['recheck'],
    tz: ['isTimeZone', 'localDate', 'localMidnightUtc', 'localToUtc', 'offsetMinutes', 'utcToLocal'],
    'policy/schema': ['CAP_MODES', 'LIMITS', 'formFromPolicy', 'normalizePolicy', 'policyChanges'],
    'policy/evaluate': ['RULE_IDS', 'STATUS_RANK', 'evaluateComponent', 'evaluateTrip', 'flightCap', 'hotelCap', 'priceToBeat'],
    'policy/benchmark': ['benchmark', 'flightValues', 'hotelValues'],
    'policy/describe': ['describe', 'limitsBar'],
    'policy/index': ['POLICY_ENGINE_METHODS', 'createPolicyEngine'],
    'policy/defaults': ['DEFAULTS_NOTE', 'DEFAULT_POLICIES', 'HOTEL_SCALE_PERCENT', 'defaultPolicy'],
    'demo/flights': ['BusinessDemoFlights', 'FARE_TERMS', 'OFFER_CANCELLATION'],
    'demo/hotels': ['BusinessDemoHotels'],
    'demo/hotels-data': ['BUSINESS_CITIES', 'BUSINESS_HOTELS'],
    service: ['BusinessService', 'METHOD_MODULE', 'OPTIONAL_DEPS', 'REQUIRED_DEPS', 'SERVICE_METHODS'],
    types: [],
  };
  for (const [mod, names] of Object.entries(EXPECTED)) assert.deepEqual(Object.keys(require(`../server/business/${mod}`)).sort(), names, mod);

  const m = name => require(`../server/business/${name}`);
  // Stage 1P built lifecycle, approver, alternatives, diff, explain and policy/*; Stage 1I built dto, search, recheck,
  // inventory and demo/*: their stubs left this list.
  const stubs = [
    () => m('csv').csvCell('x'), () => m('csv').toCsv([], []), () => m('reports').outOfPolicyShare([]), () => m('reports').reportTiles({}),
  ];
  for (const fn of stubs) assert.throws(fn, NOT_BUILT, String(fn));

  // The frozen data that is final in Stage 0.
  assert.equal(m('csv').CSV_COLUMNS.length, 21);
  assert.deepEqual([m('csv').CSV_COLUMNS[0], m('csv').CSV_COLUMNS[20]], ['price_source', 'currency']);
  assert.deepEqual(m('reports').COMING_SOON.map(t => t.label), ['Spend booked', 'Invoices']);
  assert.ok(dto.ROW_KEY_RE.test('f.flt_fake_CAILHR_2026-11-12_1|LIGHT') && dto.ROW_KEY_RE.test('h.htl_fake_LHR_1|STD'));
  for (const bad of ['flt_x|LIGHT', 'f.flt_x', 'f.flt_x|LI GHT', 'x.flt_x|A', `f.flt_${'a'.repeat(161)}|A`]) assert.ok(!dto.ROW_KEY_RE.test(bad), bad);
  assert.equal(m('demo/hotels-data').BUSINESS_HOTELS.length, 29);
  for (const c of m('demo/hotels-data').BUSINESS_CITIES) {
    const a = demoAirports.find(x => x.iata === c.iata);
    assert.ok(a && a.city === c.city && a.country === c.country, `${c.iata} is in the airport data as ${c.city}, ${c.country}`);
  }

  // The policy engine bundles 1P's pure rules for the service (this.policy).
  const engine = createPolicyEngine();
  assert.deepEqual(Object.keys(engine).sort(), [...POLICY_ENGINE_METHODS].sort());
  assert.equal(POLICY_ENGINE_METHODS.length, 17);
  assert.ok(Object.isFrozen(engine));
  for (const name of POLICY_ENGINE_METHODS) assert.equal(typeof engine[name], 'function', name);

  // Factories never throw (the app boots on them), and the built explainer resolves.
  const explainer = createExplainer({ business: { explainer: 'rules' } });
  assert.equal(explainer.name, 'rules');
  assert.equal(typeof (await explainer.explain({ violations: [], alternatives: [], noneWithin: true })).summary, 'string');
  assert.throws(() => createExplainer({ business: { explainer: 'model' } }), /unknown explainer/);
  const composer = new TripComposer({ inventory: { status: 'none' }, now: fixed });
  assert.throws(() => composer.parseQuery({}, { today: '2026-10-09' }), e => e.code === 'no_supplier' && e.status === 503);
  await assert.rejects(composer.search({}), e => e.code === 'no_supplier' && e.status === 503);
});

test('interfaces: createBusinessInventory picks overrides, live, demo or none, and never loads demo data without demo inventory', () => {
  const demoRegistry = { get: () => ({ isDemo: true }) };
  const none = createBusinessInventory({ allowDemoInventory: false }, { registry: demoRegistry });
  assert.equal(none.status, 'none');
  assert.equal(none.flights, null);
  assert.equal(none.hotels, null);
  const demo = createBusinessInventory({ allowDemoInventory: true }, { registry: demoRegistry });
  assert.equal(demo.status, 'demo');
  assert.equal(demo.flights.constructor.name, 'BusinessDemoFlights');
  assert.equal(demo.hotels.constructor.name, 'BusinessDemoHotels');
  assert.equal(demo.flights.isDemo, true);
  const live = { isDemo: false };
  const real = createBusinessInventory({ allowDemoInventory: true }, { registry: { get: () => live } });
  assert.equal(real.status, 'live');
  assert.equal(real.flights, live);
  const f = {}, h = {};
  const over = createBusinessInventory({ allowDemoInventory: false }, { registry: demoRegistry, overrides: { flights: f, hotels: h } });
  assert.equal(over.status, 'demo');
  assert.equal(over.flights, f);
  assert.equal(over.hotels, h);
  assert.deepEqual(none.airports(), []);
  assert.ok(demo.airports().some(a => a.code === 'CAI'));
});

test('interfaces: the service facade carries exactly the frozen method list, one module per method, with checked dependencies', async t => {
  assert.deepEqual([...SERVICE_METHODS], [
    'createCompany', 'listCompaniesFor', 'getOrg', 'membership', 'listMembers', 'invite', 'inviteByToken', 'acceptInvite', 'revokeInvite',
    'updateMember', 'removeMember', 'saveDepartment', 'listDepartments', 'saveSettings', 'exportCompany', 'listAudit', 'platformListOrgs',
    'platformSetStatus', 'getPolicy', 'savePolicy', 'policyHistory', 'listBudgets', 'setBudget', 'searchTrip', 'createRequest', 'getRequest',
    'listRequests', 'swap', 'submit', 'cancel', 'decide', 'message', 'inbox', 'inboxCount', 'liveCheck', 'dashboard', 'exportCsv',
  ]);
  assert.ok(Object.isFrozen(SERVICE_METHODS));
  const owners = {};
  for (const name of SERVICE_METHODS) {
    assert.equal(typeof BusinessService.prototype[name], 'function', name);
    owners[METHOD_MODULE[name]] = (owners[METHOD_MODULE[name]] || 0) + 1;
  }
  assert.deepEqual(owners, { team: 18, policies: 3, budgets: 2, requests: 12, reports: 1, csv: 1 });
  assert.equal(METHOD_MODULE.inboxCount, 'requests');
  assert.equal(METHOD_MODULE.platformSetStatus, 'team');

  const repo = new Repo({ store: new MemoryStore(), now: fixed });
  const config = loadConfig({ APP_ENV: 'development', ENABLE_BUSINESS: 'true' });
  assert.throws(() => new BusinessService({ config, now: fixed }), /needs repo/);
  assert.throws(() => new BusinessService({ repo, now: fixed }), /needs config/);
  assert.throws(() => new BusinessService({ repo, config, now: 'soon' }), /needs now|must be a function/);
  assert.throws(() => new BusinessService({ repo, config, now: fixed, store: {} }), /unknown BusinessService dependency: store/);
  const deps = { inventory: fakes.fakeInventory(), composer: fakes.fakeComposer(), policy: fakes.fakePolicy(), alternatives: fakes.fakeAlternatives(), explainer: fakes.fakeExplainer() };
  const svc = new BusinessService({ repo, config, now: fixed, log: quietLog, accounts: null, ...deps });
  for (const k of Object.keys(deps)) assert.equal(svc[k], deps[k], k);
  assert.equal(svc.repo, repo);
  // Stage 1W-a built team.js (test/business-team.test.js covers it): its methods left this loop.
  for (const name of SERVICE_METHODS.filter(n => METHOD_MODULE[n] !== 'team')) await assert.rejects(svc[name]({ user: null }), NOT_BUILT, name);
  const bare = new BusinessService({ repo, config, now: fixed });
  assert.deepEqual([bare.inventory, bare.composer, bare.policy, bare.alternatives, bare.explainer, bare.accounts], [null, null, null, null, null, null]);
});

test('interfaces: Business routers, the ROUTES table shape and the Business form parser', async t => {
  assert.equal(businessRoutes.MOUNT, '/business');
  assert.equal(businessPlatform.MOUNT, '/admin/business');
  assert.deepEqual(businessRoutes.ROUTES, []);
  assert.deepEqual(businessPlatform.ROUTES, []);
  for (const file of ['public', 'traveler', 'admin']) {
    const mod = require(`../server/routes/business/${file}`);
    assert.deepEqual(Object.keys(mod).sort(), ['ROUTES', 'router'], file);
    assert.ok(Object.isFrozen(mod.ROUTES));
  }
  const good = [
    { method: 'GET', path: '/start', perm: null, own: false, limiter: [], who: 'anyone' },
    { method: 'POST', path: '/signin', perm: null, own: false, limiter: ['bizAuthIp', 'bizAuthAccount'], who: 'anyone' },
    { method: 'GET', path: '/app', perm: null, own: false, limiter: [], who: 'user' },
    { method: 'GET', path: '/o/:orgId', perm: 'org.view', own: false, limiter: [], who: 'member' },
    { method: 'POST', path: '/o/:orgId/trips/:rid/decide', perm: ['approval.decide', 'approval.override'], own: 'request', limiter: ['bizCompute'], who: 'member' },
  ];
  assert.equal(businessRoutes.assertRoutes(good), good);
  assert.deepEqual(businessRoutes.assertRoutes([{ method: 'POST', path: '/:orgId/status', perm: null, own: false, limiter: ['bizWrite'], who: 'platform' }], { mount: businessPlatform.MOUNT }).length, 1);
  const base = good[3];
  const bad = {
    'keys must be': { ...base, extra: 1 },
    'method must be': { ...base, method: 'PUT' },
    'relative to the mount': { ...base, path: '/business/o/:orgId' },
    'perm must be': { ...base, perm: 'org.fly' },
    "own 'request' needs": { ...base, own: 'request' },
    'limiter must be': { ...base, limiter: ['writeLimiter'] },
    'bizAuthAccount runs after': { ...good[1], limiter: ['bizAuthAccount'] },
    'who must be': { ...base, who: 'admin' },
    'a member route needs a perm': { ...base, perm: null },
    'every /o/:orgId route is a member route': { ...base, perm: null, who: 'user' },
    'every POST has a limiter': { ...base, method: 'POST' },
  };
  for (const [why, entry] of Object.entries(bad)) assert.throws(() => businessRoutes.assertRoutes([entry]), e => e instanceof TypeError && e.message.includes(why), why);
  assert.throws(() => businessRoutes.assertRoutes([base, { ...base }]), /listed twice/);
  assert.throws(() => businessRoutes.assertRoutes(null), /must be an array/);

  const config = loadConfig({ APP_ENV: 'development', ENABLE_BUSINESS: 'true' });
  const deps = businessRoutes.createRouterDeps({ config, log: quietLog });
  assert.deepEqual(Object.keys(deps).sort(), ['form', 'limits', 'log', 'sameOrigin']);
  assert.deepEqual(Object.keys(deps.limits).sort(), ['bizAuthAccount', 'bizAuthIp', 'bizCompute', 'bizWrite']);
  assert.ok(Object.isFrozen(deps));
  assert.equal(typeof businessRoutes.router({ config }, deps), 'function');
  assert.equal(typeof businessPlatform.router({ config }, deps), 'function');
  assert.deepEqual(businessRoutes.FORM_OPTIONS, { extended: false, limit: '64kb', parameterLimit: 4000 });

  // The policy editor's form: 3,000 fields fit; repeated keys give arrays.
  const app = express();
  app.post('/f', deps.form, (req, res) => res.json({ n: Object.keys(req.body).length, carriers: req.body.blockedCarriers }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => new Promise(r => server.close(r)));
  const body = new URLSearchParams();
  for (let i = 0; i < 2998; i++) body.append(`country.${i}.name`, 'x');
  body.append('blockedCarriers', 'ZS');
  body.append('blockedCarriers', 'ZC');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/f`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  assert.deepEqual(await res.json(), { n: 2999, carriers: ['ZS', 'ZC'] });
});

test('interfaces: with Business on, trips on or off, the service holds its inventory, composer, policy engine, alternatives and explainer', async t => {
  for (const env of [{ ENABLE_BUSINESS: 'true' }, { ENABLE_BUSINESS: 'true', ENABLE_TRIPS: 'false' }]) {
    const app = await startApp(env);
    t.after(app.close);
    const svc = app.business;
    assert.equal(svc.inventory.status, 'demo', 'development allows demo inventory');
    assert.equal(svc.inventory.flights.constructor.name, 'BusinessDemoFlights');
    assert.ok(svc.composer instanceof TripComposer);
    assert.equal(svc.composer.inventory, svc.inventory);
    assert.deepEqual(Object.keys(svc.policy).sort(), [...POLICY_ENGINE_METHODS].sort());
    assert.deepEqual(Object.keys(svc.alternatives).sort(), ['buildAlternatives', 'compareTrips']);
    assert.equal(svc.explainer.name, 'rules');
    const page = await fetch(`${app.base}/business`);
    assert.equal(page.status, 200, 'GET /business is the company page');
    assert.match(await page.text(), /<h1/);
    for (const path of ['/business/app', '/business/o/org_AAAAAAAAAAAAAAAA', '/admin/business']) assert.equal((await fetch(app.base + path)).status, 404, path);
  }
});

test('interfaces: policy/defaults.js holds the final starting rules for each tier', () => {
  assert.deepEqual(Object.keys(DEFAULT_POLICIES), ['standard', 'director', 'executive']);
  assert.deepEqual(HOTEL_SCALE_PERCENT, { standard: 100, director: 115, executive: 130 });
  assert.equal(DEFAULTS_NOTE, 'Starting rules suggested by Tripelyx');
  const frozenDeep = v => !v || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(frozenDeep));
  assert.ok(frozenDeep(DEFAULT_POLICIES));
  const copy = defaultPolicy('standard');
  assert.deepEqual(copy, DEFAULT_POLICIES.standard);
  assert.ok(!Object.isFrozen(copy) && !Object.isFrozen(copy.hotels.countryCaps[0]), 'a fresh mutable copy');
  copy.hotels.defaultNightlyCents = 1;
  assert.equal(DEFAULT_POLICIES.standard.hotels.defaultNightlyCents, 18000);
  assert.throws(() => defaultPolicy('gold'), /unknown tier/);

  const s = DEFAULT_POLICIES.standard;
  assert.deepEqual(Object.keys(s), ['flights', 'hotels', 'trip']);
  assert.deepEqual(Object.keys(s.flights), ['longHaulMinutes', 'shortHaul', 'longHaul', 'routeOverrides', 'blockedCarriers']);
  assert.deepEqual(Object.keys(s.hotels), ['capBasis', 'defaultNightlyCents', 'countryCaps', 'maxStars', 'minAdvanceDays', 'refundableOnly']);
  assert.deepEqual(s.trip, { maxTotalCents: null });
  assert.equal(s.flights.longHaulMinutes, 360);
  assert.deepEqual(s.flights.shortHaul, { cap: { mode: 'median_pct', pctTenths: 200, fallbackCents: 60000 }, maxCabin: 'economy', minAdvanceDays: 7, maxStops: 1, refundableOnly: false });
  assert.deepEqual(s.flights.longHaul, { cap: { mode: 'median_pct', pctTenths: 200, fallbackCents: 150000 }, maxCabin: 'premium', minAdvanceDays: 14, maxStops: 1, refundableOnly: false });
  assert.deepEqual([s.hotels.capBasis, s.hotels.defaultNightlyCents, s.hotels.maxStars], ['incl_taxes', 18000, 4]);
  assert.deepEqual(s.hotels.countryCaps.find(c => c.country === 'United Kingdom'), { country: 'United Kingdom', nightlyCents: 26000, cities: [{ city: 'London', nightlyCents: 30000 }] });

  const expectBands = { director: ['premium', 'business', 300, 7, 14], executive: ['premium', 'business', 400, 3, 3] };
  for (const tier of ['director', 'executive']) {
    const p = DEFAULT_POLICIES[tier];
    const [shortCabin, longCabin, pct, shortAdvance, longAdvance] = expectBands[tier];
    assert.deepEqual([p.flights.shortHaul.maxCabin, p.flights.longHaul.maxCabin], [shortCabin, longCabin], tier);
    assert.deepEqual([p.flights.shortHaul.cap.pctTenths, p.flights.longHaul.cap.pctTenths], [pct, pct], tier);
    assert.deepEqual([p.flights.shortHaul.cap.fallbackCents, p.flights.longHaul.cap.fallbackCents], [60000, 150000], tier);
    assert.deepEqual([p.flights.shortHaul.minAdvanceDays, p.flights.longHaul.minAdvanceDays], [shortAdvance, longAdvance], tier);
    assert.equal(p.hotels.maxStars, 5);
    // Every hotel cap is Standard's × 1.15 or × 1.30, rounded to whole dollars.
    const scale = cents => Math.round(cents * HOTEL_SCALE_PERCENT[tier] / 10000) * 100;
    assert.equal(p.hotels.defaultNightlyCents, scale(s.hotels.defaultNightlyCents), tier);
    assert.deepEqual(p.hotels.countryCaps, s.hotels.countryCaps.map(c => ({ country: c.country, nightlyCents: scale(c.nightlyCents), cities: c.cities.map(x => ({ city: x.city, nightlyCents: scale(x.nightlyCents) })) })), tier);
  }
  // Country and city names are exactly the airport data's (what cityFor() and hotel rows carry).
  for (const c of s.hotels.countryCaps) {
    assert.ok(demoAirports.some(a => a.country === c.country), c.country);
    for (const city of c.cities) assert.ok(demoAirports.some(a => a.country === c.country && a.city === city.city), city.city);
  }
});

test('interfaces: tz.js converts between UTC and company local time across DST', () => {
  assert.ok(tz.isTimeZone('Africa/Cairo') && tz.isTimeZone('UTC'));
  assert.ok(!tz.isTimeZone('Mars/Olympus') && !tz.isTimeZone('') && !tz.isTimeZone(null));
  assert.equal(tz.offsetMinutes('Africa/Cairo', new Date('2026-10-09T09:00:00Z')), 180, 'Cairo summer time');
  assert.equal(tz.offsetMinutes('Africa/Cairo', new Date('2026-11-12T09:00:00Z')), 120);
  assert.equal(tz.offsetMinutes('Europe/London', new Date('2026-11-12T09:00:00Z')), 0);
  assert.equal(tz.utcToLocal('Africa/Cairo', new Date('2026-11-12T06:35:00Z')), '2026-11-12T08:35');
  assert.equal(tz.localToUtc('Africa/Cairo', '2026-11-12T08:35').toISOString(), '2026-11-12T06:35:00.000Z');
  assert.equal(tz.localDate('Asia/Dubai', new Date('2026-11-12T21:00:00Z')), '2026-11-13');
  assert.equal(tz.localMidnightUtc('Africa/Cairo', '2026-11-12'), '2026-11-11T22:00:00.000Z');
  assert.equal(tz.localMidnightUtc('UTC', '2026-11-12'), '2026-11-12T00:00:00.000Z');
  // A wall time in the spring-forward gap moves forward by the gap; a repeated hour takes the first one.
  assert.equal(tz.localToUtc('Europe/London', '2026-03-29T01:30').toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(tz.localToUtc('Europe/London', '2026-10-25T01:30').toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(tz.localToUtc('America/New_York', '2026-03-08T02:30').toISOString(), '2026-03-08T07:30:00.000Z');
  for (let h = 0; h < 48; h++) {
    const at = new Date(Date.UTC(2026, 9, 24, h));
    assert.equal(tz.localToUtc('Europe/London', tz.utcToLocal('Europe/London', at)).getTime() <= at.getTime(), true, 'round trip never lands later');
  }
});

test('interfaces: the fakes are shaped like the typedefs: rows fit the dto schemas and the provider contracts', async () => {
  const inv = fakes.fakeInventory();
  assert.deepEqual(['status', 'flights', 'hotels', 'airports', 'carriers', 'cityFor'].map(k => k in inv), [true, true, true, true, true, true]);
  assertProvider(inv.flights, 'flights');
  assertProvider(inv.hotels, 'hotels');
  assert.deepEqual(inv.cityFor('lhr'), { city: 'London', country: 'United Kingdom' });
  assert.equal(inv.cityFor('XXX'), null);
  for (const a of inv.airports()) assert.ok(demoAirports.some(d => d.iata === a.code && d.city === a.city && d.country === a.country && d.tz === a.tz), a.code);

  const composer = fakes.fakeComposer({ inventory: inv, now: fixed });
  const query = composer.parseQuery({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' }, { today: '2026-10-09' });
  assert.deepEqual(query, { from: 'CAI', to: 'LHR', departDate: '2026-11-12', returnDate: '2026-11-16', cabin: 'economy', passengers: 1, datesFlexible: false, hotel: { city: 'London', country: 'United Kingdom', checkIn: '2026-11-12', checkOut: '2026-11-16' } });
  const res = await composer.search(query);
  assert.equal(inv.searches, 3, 'one search per leg');
  assert.deepEqual(Object.keys(res).sort(), ['legs', 'pricedAt', 'query', 'status']);
  assert.equal(res.pricedAt, FIXED_NOW);
  const rows = [...res.legs.out.rows, ...res.legs.back.rows, ...res.legs.hotel.rows];
  assert.equal(rows.length, 12 + 12 + 6);
  for (const r of rows) {
    assert.deepEqual(schemaProblems(r, r.kind === 'flight' ? dto.FLIGHT_ROW_KEYS : dto.HOTEL_ROW_KEYS), [], r.key);
    assert.ok(dto.ROW_KEY_RE.test(r.key), r.key);
    assert.equal(r.totalCents, r.available ? r.lines.reduce((n, l) => n + l.cents, 0) : null, r.key);
    if (!r.available) assert.deepEqual(r.lines, []);
  }
  assert.ok(rows.some(r => !r.available) && rows.some(r => r.carrier && r.carrier.code === 'ZS') && rows.some(r => r.stops === 1));
  const late = res.legs.out.rows.find(r => r.stops === 1);
  assert.deepEqual(late.segments.map(x => [x.departLocal, x.arriveLocal, x.arriveDayOffset]), [['2026-11-12T22:10', '2026-11-13T03:55', 1], ['2026-11-13T05:25', '2026-11-13T08:35', 0]]);
  assert.deepEqual(res.legs.out.benchmark, { medianCents: 38200, sampleSize: 4, excluded: [] });
  for (const o of await inv.flights.search({ leg: 'out', from: 'CAI', to: 'LHR', date: '2026-11-12', cabin: 'economy' })) validateOffer(o, 'flights');
  for (const o of await inv.hotels.search(query.hotel)) validateOffer(o, 'hotels');
  validateQuote(await inv.hotels.quote({ offerId: 'htl_fake_LHR_1', optionId: 'STD', query: query.hotel }), 'hotels');

  const pick = { out: res.legs.out.rows.find(r => r.key.endsWith('_1|FLEX')).key, back: res.legs.back.rows.find(r => r.key.endsWith('_1|FLEX')).key, hotel: 'h.htl_fake_LHR_1|DLX' };
  const priced = await composer.price(pick, query);
  assert.equal(inv.quotes, 4, 'the hotel quote above, then one quote per component');
  assert.equal(priced.totalCents, priced.rows.out.totalCents + priced.rows.back.totalCents + priced.rows.hotel.totalCents);
  await assert.rejects(composer.price({ ...pick, out: 'h.htl_fake_LHR_1|DLX' }, query), e => e.code === 'invalid_selection' && e.status === 422);
  await assert.rejects(composer.price({ ...pick, back: null }, query), e => e.code === 'invalid_selection');
  assert.throws(() => composer.parseQuery({ from: 'CAI', to: 'CAI', depart: '2026-10-01', cabin: 'first' }, { today: '2026-10-09' }), e => e.code === 'invalid_query' && e.status === 422 && Object.keys(e.details).sort().join() === 'cabin,depart,to');
  const request = { selection: pick, query, rows: priced.rows };
  assert.equal((await composer.recheck(request)).status, 'same');
  inv.setPrice(pick.out, priced.rows.out.totalCents + 2900);
  const changed = await composer.recheck(request);
  assert.deepEqual([changed.status, changed.components.out.status, changed.components.hotel.status, changed.newTotalCents], ['changed', 'changed', 'same', priced.totalCents + 2900]);
  inv.setUnavailable(pick.hotel);
  const gone = await composer.recheck(request);
  assert.deepEqual([gone.status, gone.newTotalCents, gone.components.hotel.row.available], ['unavailable', null, false]);
  inv.clearOverrides();
  const variants = await composer.variants(query, pick, { datesFlexible: true });
  assert.ok(variants.candidates.length > 0 && variants.candidates.every(v => v.totalCents < priced.totalCents));
  assert.deepEqual([...new Set(variants.candidates.map(v => v.change.kind))].sort(), ['dates', 'fare', 'flight', 'hotel', 'room', 'stops']);
  assert.ok(variants.searches <= 20);
  assert.deepEqual(composer.calls, { parseQuery: 2, search: 1, price: 3 + 3, variants: 1, recheck: 3 });
  const off = fakes.fakeComposer({ inventory: fakes.fakeInventory({ status: 'none' }), now: fixed });
  await assert.rejects(off.search(query), e => e.code === 'no_supplier' && e.status === 503);
  assert.deepEqual(off.inventory.airports(), []);

  // fakePolicy: fixed caps, the plan's statuses and the full PolicyEngine surface.
  const policy = fakes.fakePolicy();
  assert.deepEqual(POLICY_ENGINE_METHODS.filter(n => typeof policy[n] !== 'function'), []);
  const ctx = { rules: defaultPolicy('standard'), policy: { tier: 'standard', version: 1 }, outOfPolicy: 'approval', today: '2026-10-09', benchmarks: {}, carriers: { ZS: 'Sahara Wings' }, orgName: 'Acme Inc' };
  const zs = res.legs.out.rows.find(r => r.carrier.code === 'ZS' && r.optionId === 'LIGHT');
  assert.equal(policy.evaluateComponent(zs, ctx).status, 'blocked');
  assert.equal(policy.evaluateComponent(zs, ctx).violations[0].text, "Sahara Wings isn't used by Acme Inc.");
  const cheap = res.legs.out.rows.find(r => r.key.endsWith('_2|LIGHT'));
  assert.equal(policy.evaluateComponent(cheap, ctx).status, 'within');
  const trip = policy.evaluateTrip({ out: cheap, back: null, hotel: null }, ctx, { budget: { remainingCents: 100, periodKey: '2026-Q4', periodLabel: 'Q4 2026', departmentName: 'Engineering' } });
  assert.deepEqual([trip.status, trip.violations.map(v => v.rule)], ['out', ['budget']]);
  assert.equal(policy.evaluateTrip(priced.rows, { ...ctx, outOfPolicy: 'block' }, { budget: null }).status, 'blocked');
  assert.equal(policy.calls.evaluateTrip, 2);
});

test('interfaces: fakePolicy runs the lifecycle and approver rules as lifecycle.js and approver.js state them', () => {
  const policy = fakes.fakePolicy();
  const at = '2026-10-01T09:00:00.000Z';
  const m = (userId, role, extra = {}) => ({ orgId: 'org_x', userId, name: userId, role, status: 'active', departmentId: null, managerId: null, approverId: null, tier: 'standard', at, by: null, removedAt: null, rev: 0, ...extra });
  const members = {
    sam: m('sam', 'employee', { managerId: 'dana', approverId: 'gone' }), dana: m('dana', 'manager'), gone: m('gone', 'manager', { status: 'removed' }),
    olivia: m('olivia', 'owner', { at: '2026-09-01T00:00:00.000Z' }), tara: m('tara', 'travel_admin'), fay: m('fay', 'finance'),
  };
  assert.deepEqual(policy.resolveApprover(members.sam, members), { approverId: 'dana', pool: false, poolIds: [], rule: 'manager', skipped: [{ userId: 'gone', reason: 'removed' }] });
  assert.deepEqual(policy.resolveApprover({ ...members.sam, managerId: 'fay', approverId: null }, members), { approverId: null, pool: true, poolIds: ['olivia', 'tara'], rule: 'admin', skipped: [{ userId: 'fay', reason: 'cannot_approve' }] });
  assert.equal(policy.resolveApprover(members.olivia, { olivia: members.olivia }).rule, null);

  const org = { id: 'org_x', name: 'Acme Inc', timezone: 'Africa/Cairo', settings: { outOfPolicy: 'approval', approvalHours: 24, reasonMinChars: 10, budgetPeriod: 'quarter' } };
  const now = FIXED_NOW;
  const draft = { id: 'btr_x', travelerId: 'sam', status: 'draft', totalCents: 90000, query: { departDate: '2026-11-12' }, alternatives: [], messages: [], approval: null, expiresAt: null };
  const samRef = { userId: 'sam', name: 'Sam', role: 'employee' };
  const out = { status: 'out', violations: [{ rule: 'flight.cap' }], components: {}, totalCents: 90000, policy: { tier: 'standard', version: 1 } };
  const same = { status: 'same' };
  const approver = policy.resolveApprover(members.sam, members);
  const submit = reason => policy.transition(draft, { type: 'submit', reason, approver, budget: null, draft: null }, { now, actor: samRef, member: members.sam, org, evaluation: out, recheck: same });
  assert.throws(() => submit({ text: 'too short', category: null }), e => e.code === 'reason_too_short' && e.status === 422);
  assert.throws(() => submit({ text: 'Client visit 4242 4242 4242 4242', category: 'other' }), e => e.code === 'card_number');
  const sub = submit({ text: 'Client meeting moved to Monday', category: 'client_meeting' });
  assert.equal(sub.outcome, 'submitted');
  assert.equal(sub.next.status, 'pending');
  assert.equal(sub.next.expiresAt, '2026-10-10T09:00:00.000Z', 'submittedAt + 24 h, before the departure midnight');
  assert.deepEqual(sub.next.approval.approverId, 'dana');
  const auto = policy.transition(draft, { type: 'submit', reason: null, approver: null, budget: { budgetId: 'b', periodKey: '2026-Q4', remainingCents: 1e6 }, draft: null }, { now, actor: samRef, member: members.sam, org, evaluation: { ...out, status: 'within', violations: [] }, recheck: same });
  assert.deepEqual([auto.outcome, auto.next.status, auto.next.approval.mode, auto.history.by, auto.next.budget], ['auto_approved', 'approved', 'auto', { system: 'policy' }, { budgetId: 'b', periodKey: '2026-Q4', cents: 90000 }]);
  assert.throws(() => policy.transition(draft, { type: 'submit', reason: null, approver, budget: null, draft: null }, { now, actor: samRef, member: members.sam, org, evaluation: { ...out, status: 'blocked' }, recheck: same }), e => e.code === 'policy_blocked');

  const pending = { ...draft, ...sub.next };
  const decide = (who, ev, extra = {}) => policy.transition(pending, ev, { now, actor: { userId: who, name: who, role: members[who].role }, member: members[who], org, evaluation: out, recheck: same, ...extra });
  assert.throws(() => decide('sam', { type: 'approve', note: '' }), e => e.code === 'self_approval');
  assert.throws(() => decide('fay', { type: 'approve', note: '' }), e => e.code === 'not_found');
  assert.throws(() => decide('tara', { type: 'approve', note: 'ok' }), e => e.code === 'note_required', 'an override needs a note');
  assert.equal(decide('tara', { type: 'approve', note: 'Approved for the client visit' }).next.approval.decidedAs, 'override');
  assert.equal(decide('dana', { type: 'approve', note: '' }).next.approval.decidedAs, 'assigned');
  assert.throws(() => decide('dana', { type: 'deny', note: 'no' }), e => e.code === 'note_required');
  assert.throws(() => decide('dana', { type: 'approve', note: '', budget: { budgetId: 'b', periodKey: '2026-Q4', remainingCents: 100 } }), e => e.code === 'over_budget');
  assert.equal(decide('dana', { type: 'approve', note: '', ackOverBudget: true, budget: { budgetId: 'b', periodKey: '2026-Q4', remainingCents: 100 } }).next.approval.overBudgetAck, true);
  const back = decide('dana', { type: 'approve', note: '', draft: { totalCents: 95000 } }, { recheck: { status: 'changed', newTotalCents: 95000 } });
  assert.deepEqual([back.outcome, back.next.status, back.next.returned.why, back.next.returned.toCents], ['returned', 'draft', 'price_changed', 95000]);
  const later = '2026-10-10T09:00:00.000Z';
  assert.throws(() => policy.transition(pending, { type: 'approve', note: '' }, { now: later, actor: { userId: 'dana' }, member: members.dana, org }), e => e.code === 'request_expired' && e.status === 409);
  assert.equal(policy.transition(pending, { type: 'expire' }, { now: later, actor: { system: 'clock' }, member: null, org }).history.by.system, 'clock');
  assert.equal(policy.effectiveStatus(pending, later, 'Africa/Cairo'), 'expired');
  assert.equal(policy.effectiveStatus(pending, now, 'Africa/Cairo'), 'pending');
  assert.equal(policy.effectiveStatus({ ...pending, status: 'approved' }, '2026-11-13T09:00:00.000Z', 'Africa/Cairo'), 'past');
  assert.equal(policy.expiresAt('2026-11-11T20:00:00.000Z', 24, '2026-11-12', 'Africa/Cairo'), '2026-11-11T22:00:00.000Z', 'the departure midnight comes first');
  const msg = decide('dana', { type: 'message', text: 'Which client is this for?' });
  assert.deepEqual([msg.history, msg.next.messages.length], [null, 1]);
  assert.throws(() => decide('fay', { type: 'message', text: 'hello there' }), e => e.code === 'not_found');
  for (const status of ['denied', 'cancelled', 'expired']) {
    assert.throws(() => policy.transition({ ...pending, status }, { type: 'cancel' }, { now, actor: samRef, member: members.sam, org }), e => e.code === 'invalid_transition', status);
  }
});

test('interfaces: fakeAlternatives and fakeExplainer: ranked, capped, digit-free', async () => {
  const inv = fakes.fakeInventory();
  const composer = fakes.fakeComposer({ inventory: inv, now: fixed });
  const policy = fakes.fakePolicy();
  const alts = fakes.fakeAlternatives();
  const explainer = fakes.fakeExplainer();
  const query = composer.parseQuery({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1' }, { today: '2026-10-09' });
  const selection = { out: `f.flt_fake_CAILHR_2026-11-12_1|FLEX`, back: `f.flt_fake_LHRCAI_2026-11-16_1|FLEX`, hotel: 'h.htl_fake_LHR_1|DLX' };
  const pick = await composer.price(selection, query);
  const ctx = { rules: defaultPolicy('standard'), policy: { tier: 'standard', version: 1 }, outOfPolicy: 'approval', today: '2026-10-09', benchmarks: {}, carriers: {}, orgName: 'Acme Inc' };
  const pickEval = policy.evaluateTrip(pick.rows, ctx, { budget: null });
  const variants = await composer.variants(query, selection, { datesFlexible: false });
  const result = alts.buildAlternatives({ pick: { selection, query, rows: pick.rows, totalCents: pick.totalCents }, pickEval, candidates: variants.candidates, evaluate: v => policy.evaluateTrip(v.rows, ctx, { budget: null }), truncated: false });
  assert.ok(result.alternatives.length >= 1 && result.alternatives.length <= 5);
  assert.equal(result.noneWithin, result.cheapestWithin === null);
  if (result.cheapestWithin) assert.equal(result.alternatives[0].id, result.cheapestWithin.id);
  for (const a of result.alternatives) {
    assert.match(a.id, /^[0-9a-f]{16}$/);
    assert.ok(a.savesCents >= 100 && a.evaluation.status !== 'blocked');
    assert.ok(!/[0-9$]/.test(a.label), a.label);
  }
  const cmp = alts.compareTrips({ rows: pick.rows, totalCents: pick.totalCents }, result.alternatives[0]);
  assert.equal(cmp.totalCents.delta, result.alternatives[0].totalCents - pick.totalCents);
  const input = { violations: pickEval.violations.map(v => ({ rule: v.rule })), alternatives: result.alternatives.map((a, i) => ({ id: a.id, kind: a.kind, withinPolicy: a.evaluation.status === 'within', savingsRank: i + 1, giveUps: [] })), noneWithin: result.noneWithin };
  const said = await explainer.explain(input);
  assert.deepEqual(said.order, input.alternatives.map(a => a.id));
  assert.ok(!/[0-9]|[$€£¥]|\bUSD\b/.test(JSON.stringify([Object.values(said.notes), said.summary])), 'notes and summary carry no digits');
  assert.deepEqual(explainer.inputs, [input]);
});

test('interfaces: Repo.listOrgs (the platform list) and Repo.listBusinessLeads', async t => {
  const logs = [];
  const app = await startApp({ ENABLE_BUSINESS: 'true' }, { log: { ...quietLog, warn: (...a) => logs.push(a.join(' ')) } });
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Olivia Owner' });
  const a = await seedOrg(app, owner, { name: 'Alpha Co' });
  const b = await seedOrg(app, owner, { name: 'Beta Co', status: 'pending' });
  const repo = new Repo({ store: app.store, now: app.ctx.now, log: { warn: (...x) => logs.push(x.join(' ')), error() {} } });
  assert.deepEqual((await repo.listOrgs()).map(o => o.id), [b.id, a.id], 'newest first');
  assert.deepEqual((await repo.listOrgs({ limit: 1 })).map(o => o.id), [b.id]);
  assert.ok(logs.some(l => /listOrgs reached its limit of 1/.test(l)));
  for (const limit of [0, 1001, 1.5]) await assert.rejects(repo.listOrgs({ limit }), RangeError);
  await app.store.savePartnerLead({ name: 'A', email: 'a@example.com', kind: 'business', at: FIXED_NOW });
  await app.store.savePartnerLead({ name: 'B', email: 'b@example.com', at: FIXED_NOW });
  await app.store.savePartnerLead({ name: 'C', email: 'c@example.com', kind: 'Business', at: FIXED_NOW });
  assert.deepEqual((await repo.listBusinessLeads()).map(l => l.name), ['A']);
  for (const limit of [0, 201]) await assert.rejects(repo.listBusinessLeads({ limit }), RangeError);
});

test('interfaces: the budget period helpers are built in Stage 0 (pure, like tz.js)', () => {
  const b = require('../server/business/budgets');
  assert.equal(b.periodKey('2026-11-12', 'quarter'), '2026-Q4');
  assert.equal(b.periodKey('2026-01-01', 'quarter'), '2026-Q1');
  assert.equal(b.periodKey('2026-03-31', 'quarter'), '2026-Q1');
  assert.equal(b.periodKey('2026-04-01', 'quarter'), '2026-Q2');
  assert.equal(b.periodKey('2026-11-12', 'month'), '2026-11');
  for (const [date, period] of [['2026-02-30', 'quarter'], ['2026-11-12', 'year'], ['12/11/2026', 'month'], [null, 'month']]) {
    assert.throws(() => b.periodKey(date, period), RangeError, `${date} ${period}`);
  }
  assert.equal(b.periodLabel('2026-Q4'), 'Q4 2026');
  assert.equal(b.periodLabel('2026-11'), 'November 2026');
  assert.equal(b.periodLabel('2027-01'), 'January 2027');
  for (const bad of ['2026-Q5', '2026-13', '2026-1', 'Q4 2026', '']) assert.throws(() => b.periodLabel(bad), RangeError, bad);
  for (const key of ['2026-Q4', '2026-11']) assert.match(key, b.PERIOD_KEY_RE);
  assert.deepEqual(b.periodChoices('2026-Q4'), ['2026-Q2', '2026-Q3', '2026-Q4', '2027-Q1', '2027-Q2', '2027-Q3']);
  assert.deepEqual(b.periodChoices('2026-Q1'), ['2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.deepEqual(b.periodChoices('2026-11'), ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(b.periodChoices('2026-02'), ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
  const org = { timezone: 'Africa/Cairo', settings: { budgetPeriod: 'quarter' } };
  assert.equal(b.currentPeriodKey(org, new Date(FIXED_NOW)), '2026-Q4');
  assert.equal(b.currentPeriodKey(org, new Date('2026-12-31T22:30:00Z')), '2027-Q1', "Cairo's date, not UTC's");
  assert.equal(b.currentPeriodKey({ ...org, timezone: 'UTC' }, new Date('2026-12-31T22:30:00Z')), '2026-Q4');
  assert.equal(b.currentPeriodKey({ ...org, settings: { budgetPeriod: 'month' } }, new Date(FIXED_NOW)), '2026-10');
  assert.equal(b.committedCents({ commits: { btr_a: 84200, btr_b: 15800 } }), 100000);
  assert.equal(b.committedCents({ commits: { btr_a: 84200, btr_b: 15800 } }, 'btr_a'), 15800);
  assert.equal(b.committedCents({ commits: {} }), 0);
  assert.equal(b.committedCents(null), 0);
  assert.throws(() => b.committedCents({ commits: { btr_a: 1.5 } }), RangeError);
});

test('interfaces: fakePolicy follows evaluate.js on Price to Beat, hotel cap units and the budget text', async () => {
  const policy = fakes.fakePolicy();
  // min(cap, median) when both exist, else whichever exists, else null.
  assert.equal(policy.priceToBeat(30000, { medianCents: 26400 }), 26400);
  assert.equal(policy.priceToBeat(25000, { medianCents: 26400 }), 25000);
  assert.equal(policy.priceToBeat(null, { medianCents: 26400 }), 26400);
  assert.equal(policy.priceToBeat(30000, { medianCents: null }), 30000);
  assert.equal(policy.priceToBeat(30000, null), 30000);
  assert.equal(policy.priceToBeat(null, null), null);
  assert.equal(policy.priceToBeat(null, { medianCents: null }), null);

  const inv = fakes.fakeInventory();
  const composer = fakes.fakeComposer({ inventory: inv, now: fixed });
  const query = composer.parseQuery({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1' }, { today: '2026-10-09' });
  const res = await composer.search(query);
  const grand = res.legs.hotel.rows.find(r => r.key === 'h.htl_fake_LHR_1|STD');
  assert.equal(grand.nights, 4);
  const ctx = { rules: defaultPolicy('standard'), policy: { tier: 'standard', version: 1 }, outOfPolicy: 'approval', today: '2026-10-09', benchmarks: {}, carriers: {}, orgName: 'Acme Inc' };
  // hotel.cap: limit, actual and overCents are stay totals on the basis; the text quotes nightly amounts.
  const e = policy.evaluateComponent(grand, ctx);
  const v = e.violations.find(x => x.rule === 'hotel.cap');
  assert.deepEqual({ limit: v.limit, actual: v.actual }, { limit: 30000 * 4, actual: grand.totalCents });
  assert.equal(e.overCents, grand.totalCents - 30000 * 4);
  assert.equal(e.cap.cents, 30000, 'the cap itself stays nightly');
  assert.match(v.text, /a night is over the limit of \$300/);
  // The budget violation reads as evaluate.js words it, with the period's label from BudgetCtx.
  const cheap = res.legs.out.rows.find(r => r.key.endsWith('_2|LIGHT'));
  const trip = policy.evaluateTrip({ out: cheap, back: null, hotel: null }, ctx, { budget: { remainingCents: 100, periodKey: '2026-Q4', periodLabel: 'Q4 2026', departmentName: 'Engineering' } });
  const budget = trip.violations.find(x => x.rule === 'budget');
  assert.equal(budget.text, `This trip would use ${require('../server/lib/money').format(cheap.totalCents)} of the $1 left in Engineering for Q4 2026`);
  assert.throws(() => policy.evaluateTrip({ out: cheap, back: null, hotel: null }, ctx, { budget: { remainingCents: 100, periodKey: '2026-Q4', departmentName: 'Engineering' } }), /periodLabel/);
});

test('interfaces: fakeInventory providers refuse provider-contract queries; overrideProvider wraps a real provider for the real inventory seam', async () => {
  const MockFlightProvider = require('../server/providers/mock/MockFlightProvider');
  const MockHotelProvider = require('../server/providers/mock/MockHotelProvider');
  const inv = fakes.fakeInventory();
  // The fake's providers serve fakeComposer only: a contract-shaped query fails loudly instead of matching nothing.
  await assert.rejects(inv.flights.search({ from: 'CAI', to: 'LHR', departDate: '2026-11-12', passengers: 1, cabin: 'economy' }), /overrideProvider/);
  await assert.rejects(inv.hotels.search({ where: 'London', checkIn: '2026-11-12', checkOut: '2026-11-16', guests: 1 }), /overrideProvider/);
  await assert.rejects(inv.flights.quote({ offerId: 'flt_fake_CAILHR_2026-11-12_1', optionId: 'LIGHT', query: { from: 'CAI', to: 'LHR', departDate: '2026-11-12', passengers: 1, cabin: 'economy' } }), /overrideProvider/);

  const fq = { from: 'CAI', to: 'LHR', departDate: '2026-11-12', passengers: 1, cabin: 'economy' };
  const hq = { where: 'Cairo', checkIn: '2026-11-12', checkOut: '2026-11-14', guests: 1 };
  const innerF = new MockFlightProvider({ latencyMs: 0 }), innerH = new MockHotelProvider({ latencyMs: 0 });
  const flights = fakes.overrideProvider(innerF), hotels = fakes.overrideProvider(innerH);
  assertProvider(flights, 'flights');
  assertProvider(hotels, 'hotels');
  assert.deepEqual([flights.name, flights.vertical, flights.isDemo], [innerF.name, 'flights', true]);
  // With nothing changed, everything is the wrapped provider's own (queries, offers, details, quotes).
  const strip = q => ({ ...q, supplierQuoteRef: null });
  assert.deepEqual(await flights.search(fq), await innerF.search(fq));
  const [offer] = await hotels.search(hq);
  for (const o of await flights.search(fq)) validateOffer(o, 'flights');
  validateOffer(offer, 'hotels');
  assert.ok(Array.isArray((await flights.search(fq))[0].details.segments), 'real FlightDetails');
  const optionId = offer.options[0].id;
  const same = await hotels.quote({ offerId: offer.id, optionId, query: hq });
  validateQuote(same, 'hotels');
  assert.deepEqual(strip(same), strip(await innerH.quote({ offerId: offer.id, optionId, query: hq })));
  const sum = q => q.lines.reduce((n, l) => n + l.amount, 0);
  // A price change moves the quote's total by exactly the delta (search unchanged).
  hotels.setPrice(offer.id, optionId, 2900);
  const changed = await hotels.quote({ offerId: offer.id, optionId, query: hq });
  validateQuote(changed, 'hotels');
  assert.equal(sum(changed), sum(same) + 2900);
  assert.deepEqual(changed.lines.map(l => l.kind), same.lines.map(l => l.kind));
  assert.deepEqual(await hotels.search(hq), await innerH.search(hq));
  hotels.setPrice(offer.id, optionId, -sum(same) - 1);
  await assert.rejects(hotels.quote({ offerId: offer.id, optionId, query: hq }), RangeError);
  // Unavailable: the option shows available:false and quote() refuses as the mock providers do.
  hotels.setUnavailable(offer.id, optionId);
  const [marked] = await hotels.search(hq);
  validateOffer(marked, 'hotels');
  assert.equal(marked.options.find(o => o.id === optionId).available, false);
  assert.equal((await hotels.getOffer(offer.id, hq)).options.find(o => o.id === optionId).available, false);
  await assert.rejects(hotels.quote({ offerId: offer.id, optionId, query: hq }), e => e.code === 'option_sold_out' && e.status === 409);
  hotels.clearOverrides();
  assert.deepEqual(strip(await hotels.quote({ offerId: offer.id, optionId, query: hq })), strip(same));
  assert.ok(hotels.calls.quote >= 5 && hotels.calls.search >= 2);
  await assert.rejects(hotels.book({}), e => e.code === 'not_supported');
  assert.throws(() => hotels.setPrice(offer.id, optionId, 1.5), RangeError);
  // Through the documented seam.
  const seam = createBusinessInventory({ allowDemoInventory: false }, { registry: { get: () => null }, overrides: { flights, hotels } });
  assert.equal(seam.status, 'demo');
  assert.equal(seam.flights, flights);
  assert.equal(seam.hotels, hotels);
});

test('interfaces: accounts.emailInUse tells the invite landing whether to offer join or sign in', async () => {
  const store = new MemoryStore();
  const accounts = new Accounts({ store, config: loadConfig({}), now: fixed });
  await accounts.register({ name: 'Dana Lee', email: 'dana@acme.example', password: 'correct horse battery' });
  for (const e of ['dana@acme.example', ' DANA@Acme.Example ', 'dana@acme.example\x01']) assert.equal(await accounts.emailInUse(e), true, JSON.stringify(e));
  for (const e of ['sam@acme.example', '', null, undefined, 'dana@acme.exampl']) assert.equal(await accounts.emailInUse(e), false, JSON.stringify(e));
});
