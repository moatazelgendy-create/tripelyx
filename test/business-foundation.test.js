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
const { createBusinessLimits, ACCOUNT_LIMIT } = require('../server/business/limits');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { Accounts, PLATFORM_ADMIN } = require('../server/accounts');
const { AppError } = require('../server/lib/errors');
const { loadConfig } = require('../server/config');
const { redactUrl } = require('../server/app');
const { id } = require('../server/lib/ids');
const { startApp, FIXED_NOW, quietLog } = require('./helpers');
const { seedUser, client, seedOrg, seedMember, mutableClock, noInline, storeSnapshot } = require('./business-helpers');

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
  assert.equal(Object.values(constants.AUDIT_ACTIONS).flat().length, 28, 'the §C7 table');
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
  for (const gone of ['../server/routes/business', '../server/routes/businessClient']) assert.throws(() => require(gone), /Cannot find module/);

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

test('app: platform admins are seeded at boot (a no-op until Stage 1S), and admin behaviour is unchanged', async t => {
  const seen = [];
  const real = Accounts.prototype.seedPlatformAdmins;
  Accounts.prototype.seedPlatformAdmins = async function seed(opts) { seen.push(opts && typeof opts.log); return real.call(this, opts); };
  try {
    const app = await startApp({ ADMIN_EMAILS: 'ops@example.com' });
    t.after(app.close);
    const off = await startApp({ ENABLE_TRIPS: 'false' });
    t.after(off.close);
    assert.deepEqual(seen, ['object'], 'once per app with accounts, with the logger');
    assert.deepEqual(await app.accounts.seedPlatformAdmins({ log: quietLog }), { granted: [], missing: [] });
    // Today's rule: the email is listed in ADMIN_EMAILS (Stage 1S adds the record check).
    const ops = await seedUser(app, { name: 'Ops Person', email: 'ops@example.com' });
    const ada = await seedUser(app, { name: 'Ada Lovelace', email: 'ada@example.com' });
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
  // The record changes nothing yet: today's rule is the email list alone (Stage 1S).
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
