// Tripelyx Business companies and team (Stage 1W-a, server/business/team.js): createCompany in one commit,
// the switcher, members, invites (D3, D4, D5), departments, settings, the company export, the paged audit
// log, the platform list and status, last-owner protection (D8), and the memberGate port from 1C.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser, seedOrg, seedMember, seedBudget, mutableClock, storeSnapshot, noInline } = require('./business-helpers');
const { fakePolicy } = require('./business-fakes');
const { KINDS, TIERS, AUDIT_GROUPS, HOUSE_COMPANY_NAME, HOUSE_ID, HOUSE_NAME_FIXED } = require('../server/business/constants');
const { COMPANY_FORM } = require('../server/business/team');
const { BusinessService } = require('../server/business/service');
const { Repo } = require('../server/business/repo');
const { auditInsert } = require('../server/business/actor');
const { defaultPolicy, DEFAULTS_NOTE } = require('../server/business/policy/defaults');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { PostgresStore } = require('../server/booking/PostgresStore');
const { loadConfig } = require('../server/config');
const { AppError } = require('../server/lib/errors');
const { id } = require('../server/lib/ids');
const http = require('../server/business/http');

const FORM = Object.freeze({ name: 'Acme Inc', size: '11-50 people', ack: '1' });
const rejectsWith = (p, status, code) => assert.rejects(p, e => {
  assert.ok(e instanceof AppError, `expected an AppError, got ${e && e.stack}`);
  assert.equal(e.status, status, `${e.code}: ${e.message}`);
  if (code) assert.equal(e.code, code, e.message);
  return true;
});
const recordsOf = (app, kind) => [...app.store.records.values()].filter(r => r.kind === kind).map(r => r.data);
const sha32 = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * A fresh app (Business on) on a still clock, with the fake policy engine's resolveApprover (1P builds the
 * real one) and a platform admin user. company() creates and confirms a company through the service;
 * join() invites someone and accepts the invite, so every member comes in the way real ones do.
 */
async function setup({ env = {}, clock = mutableClock(FIXED_NOW) } = {}) {
  const app = await startApp({ ENABLE_BUSINESS: 'true', ADMIN_EMAILS: 'ops@example.com', ...env }, { now: clock.now });
  const svc = app.business;
  svc.policy = fakePolicy();
  const repo = svc.repo;
  // A real platform admin (D1): a listed email and a platform_admin record; the service asks accounts each time.
  const pat = await seedUser(app, { name: 'Pat Platform', email: 'ops@example.com' });
  await app.accounts.grantPlatformAdmin(pat.user.id, { by: 'test' });
  const adminUser = { ...pat.user, isAdmin: true };
  const admin = { user: adminUser };
  const actorOf = (orgId, u) => ({ org: { id: orgId }, user: u.user || u });
  async function company(owner, { name = 'Acme Inc', confirm = true, ...form } = {}) {
    let { org } = await svc.createCompany({ user: owner.user }, { ...FORM, name, ...form });
    if (confirm && org.status === 'pending') org = await svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev });
    return { id: org.id, org, owner: actorOf(org.id, owner) };
  }
  async function join(c, inviter, role, { name, email, ...extra } = {}) {
    const u = await seedUser(app, { name, email });
    const { token } = await svc.invite(inviter, { email: u.user.email, role, ...extra });
    const { member } = await svc.acceptInvite({ user: u.user }, token);
    return { ...u, member, actor: actorOf(c.id, u) };
  }
  const member = async (orgId, userId) => repo.getIn(KINDS.member, `${orgId}.${userId}`, orgId);
  const org = async orgId => repo.getIn(KINDS.org, orgId, orgId);
  const audits = async orgId => (await repo.page(KINDS.audit, orgId, { limit: 200 })).rows;
  return { app, svc, repo, clock, admin, actorOf, company, join, member, org, audits };
}

// ---------------------------------------------------------------------------------------------------
// createCompany

test('createCompany: one commit writes the org, the Owner in General, the index, three v1 policies and the audit, in the seedOrg shapes', async t => {
  const clock = mutableClock(FIXED_NOW);
  const { app, svc, repo, audits } = await setup({ clock });
  t.after(app.close);
  assert.deepEqual(COMPANY_FORM, { sizes: ['1-10 people', '11-50 people', '51-200 people', '201-1,000 people', 'More than 1,000 people'], defaultTimezone: 'Africa/Cairo' });
  const pat = await seedUser(app, { name: 'Pat Planner', email: 'Pat@Acme.example' });
  clock.set('2026-10-09T11:22:33.000Z');
  const at = '2026-10-09T11:22:33.000Z';

  // Every write goes through exactly one store.commit; nothing writes around it.
  const store = app.store;
  const calls = [];
  for (const name of ['commit', 'insertRecord', 'updateRecord', 'putRecord', 'deleteRecord']) {
    const orig = store[name].bind(store);
    store[name] = (...args) => { calls.push(name); return orig(...args); };
  }
  const { org, member } = await svc.createCompany({ user: pat.user }, { name: '  Pat​ Plans  ', size: '1-10 people', ack: 'on' });
  assert.deepEqual(calls, ['commit']);

  assert.match(org.id, /^org_[A-Za-z0-9_-]{16}$/);
  assert.equal(org.name, 'Pat Plans');
  assert.equal(org.nameKey, 'patplans');
  assert.equal(org.status, 'pending', 'a new company waits for Tripelyx unless BUSINESS_SELF_SERVE is on');
  assert.equal(org.size, '1-10 people');
  assert.equal(org.currency, 'USD');
  assert.equal(org.timezone, 'Africa/Cairo');
  assert.deepEqual(org.settings, { outOfPolicy: 'approval', approvalHours: 24, reasonMinChars: 10, budgetPeriod: 'quarter' });
  assert.deepEqual(org.ownerIds, [pat.user.id]);
  assert.equal(org.memberCount, 1);
  assert.deepEqual([org.createdBy, org.at, org.updatedAt, org.statusBy, org.statusAt, org.statusNote, org.rev], [pat.user.id, at, at, null, null, null, 0]);

  const deps = await repo.list(KINDS.department, org.id);
  assert.equal(deps.length, 1);
  const general = deps[0];
  assert.deepEqual(general, { id: general.id, orgId: org.id, name: 'General', archivedAt: null, at, updatedAt: at, rev: 0 });
  assert.deepEqual(member, {
    orgId: org.id, userId: pat.user.id, email: 'pat@acme.example', name: 'Pat Planner', role: 'owner', status: 'active', departmentId: general.id,
    managerId: null, approverId: null, tier: 'standard', at, by: null, removedAt: null, rev: 0,
  });
  assert.deepEqual(await repo.get(KINDS.userIndex, pat.user.id), { userId: pat.user.id, orgIds: [org.id], rev: 0 });
  const by = { userId: pat.user.id, name: 'Pat Planner', role: 'owner' };
  for (const tier of TIERS) {
    assert.deepEqual(await repo.getIn(KINDS.policy, `${org.id}.${tier}`, org.id), { orgId: org.id, tier, version: 1, rules: defaultPolicy(tier), updatedAt: at, updatedBy: by, rev: 0 });
    assert.deepEqual(await repo.getIn(KINDS.policyVersion, `${org.id}.${tier}.v1`, org.id), { orgId: org.id, tier, version: 1, rules: defaultPolicy(tier), at, by, note: DEFAULTS_NOTE, changes: [] });
  }
  const log = await audits(org.id);
  assert.deepEqual(log.map(e => [e.action, e.at, e.actor, e.target, e.summary]), [['org.created', at, by, { kind: KINDS.org, id: org.id }, 'Pat Planner created Pat Plans']]);

  // seedOrg (the shared test helper) writes the same records with the same document keys.
  const other = await seedUser(app, { name: 'Other Owner' });
  const seeded = await seedOrg(app, other, { status: 'pending' });
  const pairs = [
    [KINDS.org, org.id, seeded.id], [KINDS.member, `${org.id}.${pat.user.id}`, `${seeded.id}.${other.user.id}`],
    [KINDS.userIndex, pat.user.id, other.user.id], [KINDS.department, general.id, seeded.general.id],
    ...TIERS.flatMap(tier => [[KINDS.policy, `${org.id}.${tier}`, `${seeded.id}.${tier}`], [KINDS.policyVersion, `${org.id}.${tier}.v1`, `${seeded.id}.${tier}.v1`]]),
  ];
  for (const [kind, mine, theirs] of pairs) {
    const a = await repo.get(kind, mine), b = await repo.get(kind, theirs);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), kind);
  }
  assert.deepEqual(Object.keys(log[0]).sort(), Object.keys((await audits(seeded.id))[0]).sort());

  // With self-serve on, a new company starts active; a time zone from the list is kept.
  const app2 = await startApp({ ENABLE_BUSINESS: 'true', BUSINESS_SELF_SERVE: 'true' }, { now: clock.now });
  t.after(app2.close);
  const u2 = await seedUser(app2);
  const made = await app2.business.createCompany({ user: u2.user }, { ...FORM, timezone: 'Europe/London' });
  assert.equal(made.org.status, 'active');
  assert.equal(made.org.timezone, 'Europe/London');
});

test('createCompany is all or nothing: a failing commit writes nothing, and a racing index write is retried without leftovers', async t => {
  const { app, svc, repo } = await setup();
  t.after(app.close);
  const pat = await seedUser(app, { name: 'Pat Planner' });
  const store = app.store;
  const orig = store.commit.bind(store);
  const before = storeSnapshot(app);

  store.commit = async () => { throw new Error('the database went away'); };
  await assert.rejects(svc.createCompany({ user: pat.user }, FORM), /the database went away/);
  assert.equal(storeSnapshot(app), before, 'nothing was written');
  store.commit = async () => ({ ok: false, reason: 'conflict', kind: KINDS.policy, id: 'x' });
  await rejectsWith(svc.createCompany({ user: pat.user }, FORM), 409, 'conflict');
  assert.equal(storeSnapshot(app), before, 'nothing was written');
  store.commit = orig;

  // A second company for the same user: another writer bumps the user's index between the read and the
  // commit, so the first commit loses; withRetry runs it again and only that second attempt lands.
  const first = await svc.createCompany({ user: pat.user }, FORM);
  let calls = 0;
  store.commit = async spec => {
    calls += 1;
    if (calls === 1) {
      const cur = await store.getRecord(KINDS.userIndex, pat.user.id);
      await store.updateRecord(KINDS.userIndex, pat.user.id, cur.rev, { ...cur, touched: true });
    }
    return orig(spec);
  };
  const second = await svc.createCompany({ user: pat.user }, { ...FORM, name: 'Beta Co' });
  store.commit = orig;
  assert.equal(calls, 2);
  const orgs = recordsOf(app, KINDS.org).filter(o => o.createdBy === pat.user.id);
  assert.deepEqual(orgs.map(o => o.id).sort(), [first.org.id, second.org.id].sort(), 'the losing attempt left no company behind');
  assert.equal(recordsOf(app, KINDS.policy).filter(p => p.orgId !== first.org.id && p.orgId !== second.org.id).length, 0);
  assert.equal(recordsOf(app, KINDS.department).length, 2);
  assert.equal(recordsOf(app, KINDS.audit).length, 2);
  assert.deepEqual((await repo.get(KINDS.userIndex, pat.user.id)).orgIds, [first.org.id, second.org.id]);
});

test('createCompany refuses "tripelyx" in any spelling, checks every field, and caps companies per account (D4), also under a race', async t => {
  const { app, svc, repo } = await setup({ env: { BUSINESS_MAX_ORGS_PER_USER: '2' } });
  t.after(app.close);
  const u = await seedUser(app);
  for (const name of ['Tripelyx Travel', 'my TRIPELYX', 'Ｔｒｉｐｅｌｙｘ', 'Trip​elyx Tours', 'Trip elyx', 'trip-elyx partners', 'Trípelyx', 'T.R.I.P.E.L.Y.X']) {
    await assert.rejects(svc.createCompany({ user: u.user }, { ...FORM, name }),
      e => e.status === 422 && e.code === 'invalid_company' && e.details.name === "Choose your own company's name.", name);
  }
  const e = await svc.createCompany({ user: u.user }, { name: ' ', size: '12 people', timezone: 'Mars/Olympus' }).catch(x => x);
  assert.equal(e.code, 'invalid_company');
  assert.deepEqual(Object.keys(e.details).sort(), ['ack', 'name', 'size', 'timezone']);
  assert.equal(e.details.ack, "Tick this box to confirm you won't enter real employee travel plans yet.");
  await rejectsWith(svc.createCompany({ user: null }, FORM), 404, 'not_found');
  await rejectsWith(svc.createCompany({}, FORM), 404, 'not_found');
  await rejectsWith(svc.createCompany({ user: { id: 'usr_x', name: 'x' } }, FORM), 404, 'not_found');
  assert.equal(recordsOf(app, KINDS.org).length, 0, 'refusals write nothing');

  await svc.createCompany({ user: u.user }, { ...FORM, name: 'One' });
  await svc.createCompany({ user: u.user }, { ...FORM, name: 'Two' });
  await assert.rejects(svc.createCompany({ user: u.user }, { ...FORM, name: 'Three' }),
    x => x.status === 422 && x.code === 'too_many_companies' && x.message === "You're already in 2 companies, the most one account can join in the preview.");

  // Five at once for a new account: exactly two land; the rest see the cap after their retry.
  const v = await seedUser(app);
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(i => svc.createCompany({ user: v.user }, { ...FORM, name: `Race ${i}` })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  for (const r of results.filter(x => x.status === 'rejected')) assert.equal(r.reason.code, 'too_many_companies', r.reason.message);
  assert.equal((await repo.get(KINDS.userIndex, v.user.id)).orgIds.length, 2);
  assert.equal(recordsOf(app, KINDS.org).filter(o => o.createdBy === v.user.id).length, 2, 'no company exists outside the index');
});

// ---------------------------------------------------------------------------------------------------
// Switcher, membership, getOrg

test('listCompaniesFor, membership and getOrg: active memberships in index order, null or [] for everyone else', async t => {
  const { app, svc, admin, company, join, actorOf } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia, { name: 'Acme Inc' });
  const other = await seedUser(app, { name: 'Other Owner' });
  const beta = await company(other, { name: 'Beta Co', confirm: false });
  const sam = await join(acme, acme.owner, 'employee', { name: 'Sam Traveler' });
  // Sam joins Beta too, once Beta is confirmed.
  await svc.platformSetStatus(admin, beta.id, { status: 'active', rev: beta.org.rev });
  const { token } = await svc.invite(beta.owner, { email: sam.user.email, role: 'manager' });
  await svc.acceptInvite({ user: sam.user }, token);
  assert.deepEqual(await svc.listCompaniesFor({ user: sam.user }), [
    { id: acme.id, name: 'Acme Inc', status: 'active', role: 'employee', roleLabel: 'Employee' },
    { id: beta.id, name: 'Beta Co', status: 'active', role: 'manager', roleLabel: 'Manager' },
  ]);
  assert.deepEqual(await svc.listCompaniesFor(actorOf(acme.id, sam)), (await svc.listCompaniesFor({ user: sam.user })), 'a MemberActor works too');
  assert.deepEqual(await svc.listCompaniesFor({ user: null }), []);
  assert.deepEqual(await svc.listCompaniesFor({ user: (await seedUser(app)).user }), []);
  assert.deepEqual(await svc.listCompaniesFor(null), []);

  assert.equal((await svc.membership({ user: sam.user }, acme.id)).role, 'employee');
  for (const orgId of ['org_nope', '', null, 'org_AAAAAAAAAAAAAAAA']) assert.equal(await svc.membership({ user: sam.user }, orgId), null, String(orgId));
  assert.equal(await svc.membership({ user: olivia.user }, beta.id), null);
  assert.equal(await svc.membership({ user: null }, acme.id), null);

  assert.equal((await svc.getOrg(sam.actor)).name, 'Acme Inc');
  await rejectsWith(svc.getOrg(actorOf(acme.id, other)), 404, 'not_found');

  // A suspended company still shows in the switcher (with its status) and membership() does not throw.
  const cur = await svc.getOrg(acme.owner);
  await svc.platformSetStatus(admin, acme.id, { status: 'suspended', note: 'Checking the account', rev: cur.rev });
  assert.equal((await svc.listCompaniesFor({ user: sam.user }))[0].status, 'suspended');
  assert.equal((await svc.membership({ user: sam.user }, acme.id)).role, 'employee');
  await rejectsWith(svc.getOrg(sam.actor), 403, 'org_suspended');
});

// ---------------------------------------------------------------------------------------------------
// Invites

test('invites: the token is shown once and stored only as a hash; the landing picks join (always, signed out), accept, other email or member; accepting needs the invited email (D5)', async t => {
  const { app, svc, repo, company, join, member, org, audits } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const eng = await svc.saveDepartment(acme.owner, { name: 'Engineering' });
  const dana = await join(acme, acme.owner, 'manager', { name: 'Dana Lee' });

  const made = await svc.invite(acme.owner, { email: ' Ana@Example.com ', role: 'employee', departmentId: eng.id, managerId: dana.user.id, tier: 'director' });
  assert.match(made.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.replaced, false);
  assert.equal(made.orgName, 'Acme Inc');
  assert.deepEqual(Object.keys(made.invite).sort(), ['at', 'departmentName', 'email', 'expiresAt', 'publicId', 'role', 'roleLabel']);
  assert.deepEqual([made.invite.email, made.invite.role, made.invite.roleLabel, made.invite.departmentName], ['ana@example.com', 'employee', 'Employee', 'Engineering']);
  assert.equal(made.invite.expiresAt, new Date(Date.parse(FIXED_NOW) + 7 * 86400000).toISOString(), 'inviteDays (7) from the clock');
  assert.ok(!JSON.stringify([...app.store.records.values()]).includes(made.token), 'the raw token is nowhere in the store');
  const stored = await repo.get(KINDS.invite, crypto.createHash('sha256').update(made.token).digest('hex'));
  assert.equal(stored.publicId, made.invite.publicId);
  assert.deepEqual(await repo.getIn(KINDS.inviteEmail, `${acme.id}.${sha32('ana@example.com')}`, acme.id), { orgId: acme.id, inviteHash: stored.tokenHash, rev: 0 });
  const invited = (await audits(acme.id)).find(e => e.action === 'member.invited' && e.target.id === made.invite.publicId);
  assert.equal(invited.summary, 'Olivia Owner invited a***@example.com as Employee', 'audit entries never carry a full email');
  assert.ok(!JSON.stringify(await audits(acme.id)).includes(made.token));

  // The landing. Signed out it is always 'join' and never looks the invited email up (lead decision on 1W-a
  // finding 15), so a link never tells its holder whether an address has a Tripelyx account.
  const asked = [];
  app.accounts.emailInUse = async function spy(e) { asked.push(e); return Object.getPrototypeOf(this).emailInUse.call(this, e); };
  t.after(() => { delete app.accounts.emailInUse; });
  assert.equal(svc.accounts, app.accounts);
  const landing = await svc.inviteByToken({ user: null }, made.token);
  assert.deepEqual(landing.org, { id: acme.id, name: 'Acme Inc', status: 'active', timezone: 'Africa/Cairo' }, 'the company time zone, for the expiry');
  assert.deepEqual(landing.invite, {
    publicId: made.invite.publicId, email: 'ana@example.com', emailMasked: 'a***@example.com', role: 'employee', roleLabel: 'Employee',
    departmentName: 'Engineering', invitedByName: 'Olivia Owner', expiresAt: made.invite.expiresAt,
  });
  assert.equal(landing.state, 'join', 'signed out, and no account uses the email');
  const ana = await seedUser(app, { name: 'Ana Analyst', email: 'ana@example.com' });
  const withAccount = await svc.inviteByToken({ user: null }, made.token);
  assert.deepEqual(withAccount, landing, 'an account now uses the email, and the signed-out landing is exactly the same');
  assert.equal((await svc.inviteByToken({}, made.token)).state, 'join');
  assert.deepEqual(asked, [], 'the landing never asks accounts.emailInUse');
  assert.equal((await svc.inviteByToken({ user: ana.user }, made.token)).state, 'accept');
  const bob = await seedUser(app, { name: 'Bob', email: 'bob@example.com' });
  assert.equal((await svc.inviteByToken({ user: bob.user }, made.token)).state, 'other_email');
  assert.equal((await svc.inviteByToken({ user: dana.user }, made.token)).state, 'member', 'already in the company');
  for (const bad of ['x'.repeat(43), 'not-a-token', '', null, `${made.token}x`]) {
    await rejectsWith(svc.inviteByToken({ user: null }, bad), 410, 'invite_gone');
    await rejectsWith(svc.acceptInvite({ user: ana.user }, bad), 410, 'invite_gone');
  }

  // D5: the account's email must be the invite's.
  await assert.rejects(svc.acceptInvite({ user: bob.user }, made.token), x => x.status === 403 && x.code === 'invite_email_mismatch'
    && x.message === "This invite is for a***@example.com. You're signed in as bob@example.com. Sign out to use it, or ask your admin to invite bob@example.com.");
  await rejectsWith(svc.acceptInvite({ user: null }, made.token), 404, 'not_found');

  const before = await org(acme.id);
  const joined = await svc.acceptInvite({ user: { ...ana.user, email: 'ANA@example.com' } }, made.token);
  assert.deepEqual([joined.member.role, joined.member.tier, joined.member.departmentId, joined.member.managerId, joined.member.approverId, joined.member.by],
    ['employee', 'director', eng.id, dana.user.id, null, olivia.user.id]);
  assert.equal(joined.member.name, 'Ana Analyst');
  assert.equal(joined.org.memberCount, before.memberCount + 1);
  assert.deepEqual(joined.org.ownerIds, before.ownerIds);
  assert.deepEqual((await repo.get(KINDS.userIndex, ana.user.id)).orgIds, [acme.id]);
  const used = await repo.get(KINDS.invite, stored.tokenHash);
  assert.deepEqual([used.acceptedAt, used.acceptedBy], [FIXED_NOW, ana.user.id]);
  assert.equal((await repo.getIn(KINDS.inviteEmail, `${acme.id}.${sha32('ana@example.com')}`, acme.id)).inviteHash, null, 'the pointer is cleared');
  const joinedEntry = (await audits(acme.id)).find(e => e.action === 'member.joined' && e.target.id === ana.user.id);
  assert.deepEqual(joinedEntry.actor, { userId: ana.user.id, name: 'Ana Analyst', role: 'employee' });
  assert.equal(joinedEntry.summary, 'Ana Analyst joined as Employee');
  assert.ok(await member(acme.id, ana.user.id));
  // Single use.
  await rejectsWith(svc.acceptInvite({ user: ana.user }, made.token), 410, 'invite_gone');
  await rejectsWith(svc.inviteByToken({ user: null }, made.token), 410, 'invite_gone');
  // An active member's email cannot be invited again.
  await rejectsWith(svc.invite(acme.owner, { email: 'ana@example.com', role: 'manager' }), 409, 'already_member');
});

test('invites: a new invite for the same email replaces the old one (D3); revoke, expiry and racing accepts leave one usable path', async t => {
  const clock = mutableClock(FIXED_NOW);
  const { app, svc, repo, company, org, audits } = await setup({ clock });
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const dee = await seedUser(app, { name: 'Dee Developer', email: 'dee@example.com' });
  const first = await svc.invite(acme.owner, { email: 'dee@example.com', role: 'employee' });
  const second = await svc.invite(acme.owner, { email: 'DEE@example.com', role: 'manager' });
  assert.equal(second.replaced, true);
  assert.equal(second.invite.role, 'manager');
  const hash = t2 => crypto.createHash('sha256').update(t2).digest('hex');
  const old = await repo.get(KINDS.invite, hash(first.token));
  assert.deepEqual([old.revokedAt, old.revokedReason], [FIXED_NOW, 'replaced']);
  assert.equal((await repo.getIn(KINDS.inviteEmail, `${acme.id}.${sha32('dee@example.com')}`, acme.id)).inviteHash, hash(second.token));
  await rejectsWith(svc.inviteByToken({ user: null }, first.token), 410, 'invite_gone');
  await rejectsWith(svc.acceptInvite({ user: dee.user }, first.token), 410, 'invite_gone');
  const people = await svc.listMembers(acme.owner);
  assert.deepEqual(people.invites.map(i => [i.email, i.role]), [['dee@example.com', 'manager']], 'one pending invite per email');

  // Racing accepts of one token by its owner: exactly one joins, the count moves once.
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => svc.acceptInvite({ user: dee.user }, second.token)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of results.filter(x => x.status === 'rejected')) assert.ok([409, 410].includes(r.reason.status), r.reason.message);
  assert.equal((await org(acme.id)).memberCount, 2);
  assert.equal((await audits(acme.id)).filter(e => e.action === 'member.joined').length, 1);

  // Revoke.
  const eve = await svc.invite(acme.owner, { email: 'eve@example.com', role: 'employee' });
  const revoked = await svc.revokeInvite(acme.owner, eve.invite.publicId);
  assert.deepEqual([revoked.revokedReason, revoked.revokedAt, revoked.publicId], ['manual', FIXED_NOW, eve.invite.publicId]);
  assert.equal((await repo.getIn(KINDS.inviteEmail, `${acme.id}.${sha32('eve@example.com')}`, acme.id)).inviteHash, null);
  await rejectsWith(svc.inviteByToken({ user: null }, eve.token), 410, 'invite_gone');
  await rejectsWith(svc.revokeInvite(acme.owner, eve.invite.publicId), 409, 'invite_not_pending');
  await rejectsWith(svc.revokeInvite(acme.owner, 'inv_AAAAAAAAAAAAAAAA'), 404, 'not_found');
  await rejectsWith(svc.revokeInvite(acme.owner, 'not an id'), 404, 'not_found');
  assert.ok((await audits(acme.id)).some(e => e.action === 'member.invite_revoked' && e.summary === 'Olivia Owner cancelled the invite for e***@example.com'));
  // Another company's invite is a 404 here.
  const bo = await seedUser(app, { name: 'Bea Owner' });
  const beta = await company(bo, { name: 'Beta Co' });
  const theirs = await svc.invite(beta.owner, { email: 'fay@example.com', role: 'employee' });
  await rejectsWith(svc.revokeInvite(acme.owner, theirs.invite.publicId), 404, 'not_found');

  // Expiry after inviteDays (7), by the injected clock.
  const gus = await svc.invite(acme.owner, { email: 'gus@example.com', role: 'employee' });
  const gusUser = await seedUser(app, { email: 'gus@example.com' });
  clock.advance(7);
  await rejectsWith(svc.inviteByToken({ user: null }, gus.token), 410, 'invite_gone');
  await rejectsWith(svc.acceptInvite({ user: gusUser.user }, gus.token), 410, 'invite_gone');
  await rejectsWith(svc.revokeInvite(acme.owner, gus.invite.publicId), 409, 'invite_not_pending');
  assert.deepEqual((await svc.listMembers(acme.owner)).invites, [], 'expired invites leave the People page');
  // A fresh invite after expiry works again (and says nothing was replaced).
  const again = await svc.invite(acme.owner, { email: 'gus@example.com', role: 'employee' });
  assert.equal(again.replaced, false);
  await svc.acceptInvite({ user: gusUser.user }, again.token);
});

test('invites: only roles the inviter may grant, valid departments and teammates, and a pending company refuses to let anyone join until confirmed', async t => {
  const { app, svc, admin, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const tara = await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin' });
  const sam = await join(acme, acme.owner, 'employee', { name: 'Sam Traveler' });
  const old = await svc.saveDepartment(acme.owner, { name: 'Old Team' });
  await svc.saveDepartment(acme.owner, { departmentId: old.id, archive: '1', rev: old.rev });
  const leaver = await join(acme, acme.owner, 'employee', { name: 'Lee Leaver' });
  await svc.removeMember(acme.owner, leaver.user.id, { rev: leaver.member.rev });

  await rejectsWith(svc.invite(tara.actor, { email: 'x@example.com', role: 'owner' }), 403, 'forbidden');
  await rejectsWith(svc.invite(tara.actor, { email: 'x@example.com', role: 'finance' }), 403, 'forbidden');
  assert.equal((await svc.invite(tara.actor, { email: 'x@example.com', role: 'travel_admin' })).invite.role, 'travel_admin');
  await assert.rejects(svc.invite(sam.actor, { email: 'y@example.com', role: 'employee' }),
    e => e.status === 403 && e.message === "Your role (Employee) can't open this page. Ask a travel admin at Acme Inc if you need it.");

  const bo = await seedUser(app, { name: 'Bea Owner' });
  const beta = await company(bo, { name: 'Beta Co' });
  const betaDep = await svc.saveDepartment(beta.owner, { name: 'Sales' });
  const e = await svc.invite(acme.owner, {
    email: 'not an email', role: 'pilot', departmentId: old.id, managerId: leaver.user.id, approverId: bo.user.id, tier: 'gold',
  }).catch(x => x);
  assert.equal(e.code, 'invalid_invite');
  assert.deepEqual(Object.keys(e.details).sort(), ['approverId', 'departmentId', 'email', 'managerId', 'role', 'tier']);
  assert.equal(e.details.departmentId, "Choose one of your company's departments.", 'archived');
  assert.equal(e.details.managerId, 'Choose someone on your team.', 'removed');
  assert.equal(e.details.approverId, 'Choose someone on your team.', 'another company');
  assert.equal((await svc.invite(acme.owner, { email: 'z@example.com', role: 'employee', departmentId: betaDep.id }).catch(x => x)).details.departmentId,
    "Choose one of your company's departments.", "another company's department");

  // A pending company: invites can be made, nobody can join until Tripelyx confirms it.
  const pc = await seedUser(app, { name: 'Pia Pending' });
  const pend = await company(pc, { name: 'Pending Co', confirm: false });
  assert.equal(pend.org.status, 'pending');
  const inv = await svc.invite(pend.owner, { email: 'quinn@example.com', role: 'employee' });
  const quinn = await seedUser(app, { name: 'Quinn', email: 'quinn@example.com' });
  assert.equal((await svc.inviteByToken({ user: null }, inv.token)).state, 'pending_company');
  assert.equal((await svc.inviteByToken({ user: quinn.user }, inv.token)).state, 'pending_company');
  await assert.rejects(svc.acceptInvite({ user: quinn.user }, inv.token),
    x => x.status === 409 && x.code === 'company_pending' && x.message === "Pending Co is waiting for Tripelyx to confirm it. Try this link again once it's confirmed.");
  assert.equal(await svc.membership({ user: quinn.user }, pend.id), null);
  await svc.platformSetStatus(admin, pend.id, { status: 'active', rev: pend.org.rev });
  assert.equal((await svc.inviteByToken({ user: quinn.user }, inv.token)).state, 'accept');
  await svc.acceptInvite({ user: quinn.user }, inv.token);
  assert.equal((await svc.membership({ user: quinn.user }, pend.id)).role, 'employee');

  // A suspended company: the link holder gets the paused message, and nobody joins.
  const inv2 = await svc.invite(pend.owner, { email: 'rae@example.com', role: 'employee' });
  const rae = await seedUser(app, { email: 'rae@example.com' });
  await svc.platformSetStatus(admin, pend.id, { status: 'suspended', note: 'Paused while we check details', rev: (await svc.getOrg(pend.owner)).rev });
  await rejectsWith(svc.inviteByToken({ user: null }, inv2.token), 403, 'org_suspended');
  await rejectsWith(svc.acceptInvite({ user: rae.user }, inv2.token), 403, 'org_suspended');
});

test('invites: accepting counts toward the per-account company cap (D4), and a removed member returns only through a new invite', async t => {
  const clock = mutableClock(FIXED_NOW);
  const { app, svc, repo, company, join, member, org, audits } = await setup({ env: { BUSINESS_MAX_ORGS_PER_USER: '2' }, clock });
  t.after(app.close);
  const sam = await seedUser(app, { name: 'Sam Traveler', email: 'sam@example.com' });
  await svc.createCompany({ user: sam.user }, { ...FORM, name: 'Sam One' });
  await svc.createCompany({ user: sam.user }, { ...FORM, name: 'Sam Two' });
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const inv = await svc.invite(acme.owner, { email: 'sam@example.com', role: 'employee' });
  await assert.rejects(svc.acceptInvite({ user: sam.user }, inv.token), e => e.code === 'too_many_companies' && e.status === 422);
  assert.equal((await svc.inviteByToken({ user: sam.user }, inv.token)).state, 'accept', 'the refused accept used nothing up');

  // Removal: the record stays, the count, the owners and the index follow, a pending invite for them goes.
  const lee = await join(acme, acme.owner, 'employee', { name: 'Lee Leaver', email: 'lee@example.com' });
  const removedAt = '2026-10-09T10:00:00.000Z';
  clock.set(removedAt);
  const before = await org(acme.id);
  const gone = await svc.removeMember(acme.owner, lee.user.id, { rev: lee.member.rev });
  assert.deepEqual([gone.status, gone.removedAt, gone.role], ['removed', removedAt, 'employee']);
  assert.equal((await org(acme.id)).memberCount, before.memberCount - 1);
  assert.deepEqual((await repo.get(KINDS.userIndex, lee.user.id)).orgIds, []);
  assert.deepEqual(await svc.listCompaniesFor({ user: lee.user }), []);
  await rejectsWith(svc.getOrg(lee.actor), 404, 'not_found');
  const entry = (await audits(acme.id)).find(e => e.action === 'member.removed');
  assert.deepEqual([entry.summary, entry.target, entry.at], ['Olivia Owner removed Lee Leaver (Employee)', { kind: KINDS.member, id: lee.user.id }, removedAt]);

  // Lee comes back through a new invite: the same record turns active again with the new role.
  clock.set('2026-10-09T11:00:00.000Z');
  const back = await svc.invite(acme.owner, { email: 'lee@example.com', role: 'manager' });
  const rejoined = await svc.acceptInvite({ user: lee.user }, back.token);
  assert.deepEqual([rejoined.member.status, rejoined.member.role, rejoined.member.removedAt, rejoined.member.at], ['active', 'manager', null, '2026-10-09T11:00:00.000Z']);
  assert.equal(rejoined.member.rev, gone.rev + 1, 'the member record was changed, never re-inserted');
  assert.equal((await org(acme.id)).memberCount, before.memberCount);

  // A pending invite for a member's email is revoked when they are removed (it could bring them straight back).
  const pre = await svc.invite(acme.owner, { email: 'nia@example.com', role: 'employee' });
  const nia = await seedMember(app, { id: acme.id, org: acme.org }, 'employee', { name: 'Nia', email: 'nia@example.com' });
  await svc.removeMember(acme.owner, nia.user.id, { rev: (await member(acme.id, nia.user.id)).rev });
  const revoked = await repo.get(KINDS.invite, crypto.createHash('sha256').update(pre.token).digest('hex'));
  assert.equal(revoked.revokedReason, 'removed');
  await rejectsWith(svc.acceptInvite({ user: nia.user }, pre.token), 410, 'invite_gone');
});

// ---------------------------------------------------------------------------------------------------
// Members

test('updateMember: role, department, manager, approver and tier with audited changes; assignable roles, self-references and stale revs are refused', async t => {
  const { app, svc, company, join, member, audits } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const eng = await svc.saveDepartment(acme.owner, { name: 'Engineering' });
  const dana = await join(acme, acme.owner, 'manager', { name: 'Dana Lee' });
  const fay = await join(acme, acme.owner, 'finance', { name: 'Fay Finance' });
  const tara = await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin' });
  const sam = await join(acme, acme.owner, 'employee', { name: 'Sam Traveler' });

  let m = await svc.updateMember(acme.owner, sam.user.id, { role: 'employee', departmentId: eng.id, managerId: dana.user.id, approverId: '', tier: 'director', rev: sam.member.rev });
  assert.deepEqual([m.departmentId, m.managerId, m.approverId, m.tier, m.rev], [eng.id, dana.user.id, null, 'director', sam.member.rev + 1]);
  let e = (await audits(acme.id))[0];
  assert.equal(e.action, 'member.updated');
  assert.equal(e.summary, "Olivia Owner changed Sam Traveler's department, manager and policy tier");
  assert.deepEqual(e.changes, [
    { path: 'departmentId', before: null, after: eng.id }, { path: 'managerId', before: null, after: dana.user.id }, { path: 'tier', before: 'standard', after: 'director' },
  ]);
  m = await svc.updateMember(acme.owner, sam.user.id, { role: 'manager', rev: String(m.rev) });
  assert.equal(m.role, 'manager');
  assert.equal(m.tier, 'director', 'fields left out stay as they are');
  e = (await audits(acme.id))[0];
  assert.deepEqual([e.action, e.summary, e.changes], ['member.role_changed', "Olivia Owner changed Sam Traveler's role from Employee to Manager", [{ path: 'role', before: 'employee', after: 'manager' }]]);
  const count = (await audits(acme.id)).length;
  assert.deepEqual(await svc.updateMember(acme.owner, sam.user.id, { role: 'manager', tier: 'director', rev: m.rev }), m, 'no change, no write');
  assert.equal((await audits(acme.id)).length, count);

  // Refusals write nothing.
  await rejectsWith(svc.updateMember(acme.owner, sam.user.id, { tier: 'executive', rev: 0 }), 409, 'conflict');
  await rejectsWith(svc.updateMember(acme.owner, sam.user.id, { tier: 'executive' }), 409, 'conflict');
  e = await svc.updateMember(acme.owner, sam.user.id, { managerId: sam.user.id, approverId: sam.user.id, departmentId: 'dep_AAAAAAAAAAAAAAAA', role: 'boss', rev: m.rev }).catch(x => x);
  assert.equal(e.code, 'invalid_member');
  assert.deepEqual(e.details, { role: 'Choose one of the options.', departmentId: "Choose one of your company's departments.", managerId: 'Choose someone else.', approverId: 'Choose someone else.' });
  await rejectsWith(svc.updateMember(tara.actor, olivia.user.id, { tier: 'executive', rev: 0 }), 403, 'forbidden');
  await rejectsWith(svc.updateMember(tara.actor, fay.user.id, { tier: 'executive', rev: fay.member.rev }), 403, 'forbidden');
  await rejectsWith(svc.updateMember(tara.actor, sam.user.id, { role: 'owner', rev: m.rev }), 403, 'forbidden');
  await rejectsWith(svc.updateMember(tara.actor, sam.user.id, { role: 'finance', rev: m.rev }), 403, 'forbidden');
  await rejectsWith(svc.updateMember(dana.actor, sam.user.id, { tier: 'executive', rev: m.rev }), 403, 'forbidden');
  for (const uid of ['usr_AAAAAAAAAAAAAAAA', 'nope', '', null]) await rejectsWith(svc.updateMember(acme.owner, uid, { rev: 0 }), 404, 'not_found');
  assert.equal((await member(acme.id, sam.user.id)).rev, m.rev);
  // A Travel Admin may grant Travel Admin, Manager and Employee.
  m = await svc.updateMember(tara.actor, sam.user.id, { role: 'travel_admin', rev: m.rev });
  assert.equal(m.role, 'travel_admin');
  // An archived department the member already has may stay; a new one must be active.
  await svc.saveDepartment(acme.owner, { departmentId: eng.id, archive: '1', rev: eng.rev });
  m = await svc.updateMember(acme.owner, sam.user.id, { departmentId: eng.id, tier: 'standard', rev: m.rev });
  assert.equal(m.departmentId, eng.id);
  assert.equal((await svc.updateMember(acme.owner, dana.user.id, { departmentId: eng.id, rev: dana.member.rev }).catch(x => x)).details.departmentId, "Choose one of your company's departments.");

  // The last owner cannot step down; with a second owner they can.
  await rejectsWith(svc.updateMember(acme.owner, olivia.user.id, { role: 'manager', rev: (await member(acme.id, olivia.user.id)).rev }), 422, 'last_owner');
  await svc.updateMember(acme.owner, fay.user.id, { role: 'owner', rev: fay.member.rev });
  assert.deepEqual((await svc.getOrg(acme.owner)).ownerIds, [olivia.user.id, fay.user.id]);
  await svc.updateMember(acme.owner, olivia.user.id, { role: 'travel_admin', rev: (await member(acme.id, olivia.user.id)).rev });
  assert.deepEqual((await svc.getOrg(fay.actor)).ownerIds, [fay.user.id]);
  await rejectsWith(svc.updateMember(fay.actor, fay.user.id, { role: 'employee', rev: (await member(acme.id, fay.user.id)).rev }), 422, 'last_owner');
  await rejectsWith(svc.removeMember(fay.actor, fay.user.id, { rev: (await member(acme.id, fay.user.id)).rev }), 422, 'remove_self');
  await rejectsWith(svc.removeMember(tara.actor, fay.user.id, { rev: (await member(acme.id, fay.user.id)).rev }), 403, 'forbidden');
  // Olivia is a Travel Admin now and Sam is one too (assignable), so only the stale rev stops this.
  await rejectsWith(svc.removeMember(acme.owner, sam.user.id, { rev: 0 }), 409, 'conflict');
});

test('D8: two owners demoting each other at once: exactly one wins and the other gets 409; 200 racing demotions and removals never leave zero owners', async t => {
  const { app, svc, company, join, member, org } = await setup();
  t.after(app.close);
  const pair = async name => {
    const a = await seedUser(app, { name: `${name} A` });
    const c = await company(a, { name });
    const b = await join(c, c.owner, 'owner', { name: `${name} B` });
    return { c, a: { user: a.user, actor: c.owner, rev: (await member(c.id, a.user.id)).rev }, b: { user: b.user, actor: b.actor, rev: b.member.rev } };
  };
  const invariant = async c => {
    const o = await org(c.id);
    const owners = [];
    for (const uid of [...new Set([o.createdBy, ...o.ownerIds])]) { const m = await member(c.id, uid); if (m && m.status === 'active' && m.role === 'owner') owners.push(uid); }
    assert.ok(o.ownerIds.length >= 1, 'never zero owners');
    assert.deepEqual([...o.ownerIds].sort(), owners.sort(), 'ownerIds matches the owner members');
    return o;
  };

  // Two at once.
  const p = await pair('Duo Co');
  const two = await Promise.allSettled([
    svc.updateMember(p.a.actor, p.b.user.id, { role: 'manager', rev: p.b.rev }),
    svc.updateMember(p.b.actor, p.a.user.id, { role: 'manager', rev: p.a.rev }),
  ]);
  assert.equal(two.filter(r => r.status === 'fulfilled').length, 1);
  const loser = two.find(r => r.status === 'rejected').reason;
  assert.ok(loser instanceof AppError && loser.status === 409 && loser.code === 'conflict', loser.message);
  assert.equal((await invariant(p.c)).ownerIds.length, 1);

  // 200 at once: demotions both ways.
  const q = await pair('Many Co');
  const many = await Promise.allSettled(Array.from({ length: 200 }, (_, i) => (i % 2
    ? svc.updateMember(q.a.actor, q.b.user.id, { role: 'employee', rev: q.b.rev })
    : svc.updateMember(q.b.actor, q.a.user.id, { role: 'employee', rev: q.a.rev }))));
  assert.equal(many.filter(r => r.status === 'fulfilled').length, 1, 'exactly one succeeds');
  for (const r of many.filter(x => x.status === 'rejected')) {
    assert.ok(r.reason instanceof AppError && (r.reason.status === 409 || r.reason.status === 403), `${r.reason.code}: ${r.reason.message}`);
  }
  assert.equal((await invariant(q.c)).ownerIds.length, 1);

  // 200 at once: demotions and removals mixed.
  const r2 = await pair('Mixed Co');
  const ops = Array.from({ length: 200 }, (_, i) => [
    () => svc.updateMember(r2.a.actor, r2.b.user.id, { role: 'manager', rev: r2.b.rev }),
    () => svc.updateMember(r2.b.actor, r2.a.user.id, { role: 'manager', rev: r2.a.rev }),
    () => svc.removeMember(r2.a.actor, r2.b.user.id, { rev: r2.b.rev }),
    () => svc.removeMember(r2.b.actor, r2.a.user.id, { rev: r2.a.rev }),
  ][i % 4]());
  const mixed = await Promise.allSettled(ops);
  assert.equal(mixed.filter(x => x.status === 'fulfilled').length, 1, 'exactly one succeeds');
  const o = await invariant(r2.c);
  assert.equal(o.ownerIds.length, 1);
  assert.ok(o.memberCount === 1 || o.memberCount === 2);
});

// ---------------------------------------------------------------------------------------------------
// Departments, settings, export

test('departments: create, rename and archive with audits, unique names, the cap, stale revs and permissions', async t => {
  const { app, svc, repo, company, join, audits } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const dana = await join(acme, acme.owner, 'manager', { name: 'Dana Lee' });
  const eng = await svc.saveDepartment(acme.owner, { name: '  Engineering ' });
  assert.deepEqual(eng, { id: eng.id, orgId: acme.id, name: 'Engineering', archivedAt: null, at: FIXED_NOW, updatedAt: FIXED_NOW, rev: 0 });
  assert.equal((await audits(acme.id))[0].summary, 'Olivia Owner added the Engineering department');
  await rejectsWith(svc.saveDepartment(acme.owner, { name: 'engineering' }), 409, 'department_exists');
  await rejectsWith(svc.saveDepartment(acme.owner, { name: 'General' }), 409, 'department_exists');
  assert.equal((await svc.saveDepartment(acme.owner, { name: '' }).catch(x => x)).details.name, 'Fill in this field.');
  await rejectsWith(svc.saveDepartment(dana.actor, { name: 'Sales' }), 403, 'forbidden');

  const sales = await svc.saveDepartment(acme.owner, { name: 'Sales' });
  await rejectsWith(svc.saveDepartment(acme.owner, { departmentId: sales.id, name: 'ENGINEERING', rev: sales.rev }), 409, 'department_exists');
  const renamed = await svc.saveDepartment(acme.owner, { departmentId: sales.id, name: 'Sales and Partnerships', rev: sales.rev });
  assert.deepEqual([renamed.name, renamed.rev], ['Sales and Partnerships', 1]);
  await rejectsWith(svc.saveDepartment(acme.owner, { departmentId: sales.id, name: 'Sales again', rev: sales.rev }), 409, 'conflict');
  const archived = await svc.saveDepartment(acme.owner, { departmentId: sales.id, name: 'Sales and Partnerships', archive: '1', rev: renamed.rev });
  assert.equal(archived.archivedAt, FIXED_NOW);
  assert.deepEqual((await audits(acme.id)).slice(0, 2).map(e => e.action).sort(), ['department.archived', 'department.renamed']);
  assert.deepEqual(await svc.saveDepartment(acme.owner, { departmentId: sales.id, archive: '1', rev: archived.rev }), archived, 'archiving twice changes nothing');
  // An archived department's name may be used again.
  const again = await svc.saveDepartment(acme.owner, { name: 'sales and partnerships' });
  assert.deepEqual((await svc.listDepartments(dana.actor)).map(d => [d.name, !!d.archivedAt]),
    [['Engineering', false], ['General', false], ['sales and partnerships', false], ['Sales and Partnerships', true]]);
  for (const bad of ['dep_AAAAAAAAAAAAAAAA', 'nope', '../x']) await rejectsWith(svc.saveDepartment(acme.owner, { departmentId: bad, name: 'X', rev: 0 }), 404, 'not_found');
  const bo = await seedUser(app, { name: 'Bea Owner' });
  const beta = await company(bo, { name: 'Beta Co' });
  await rejectsWith(svc.saveDepartment(beta.owner, { departmentId: again.id, name: 'Mine now', rev: again.rev }), 404, 'not_found');

  // At most 200 departments (archived ones count: they keep budgets and history).
  const have = (await repo.list(KINDS.department, acme.id)).length;
  const fill = Array.from({ length: 200 - have }, (_, i) => {
    const depId = id('dep');
    return { kind: KINDS.department, id: depId, data: { id: depId, orgId: acme.id, name: `Team ${i}`, archivedAt: null, at: FIXED_NOW, updatedAt: FIXED_NOW, rev: 0 }, owner: acme.id };
  });
  await repo.commit({ inserts: fill });
  assert.equal((await svc.saveDepartment(acme.owner, { name: 'One too many' }).catch(x => x)).details.name, 'A company can have up to 200 departments.');
});

test('settings: name and time zone need settings.company, the travel rules need settings.travel; checked, audited and compare-and-set', async t => {
  const { app, svc, company, join, audits } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const tara = await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin' });
  const fay = await join(acme, acme.owner, 'finance', { name: 'Fay Finance' });
  let org = await svc.getOrg(acme.owner);

  org = await svc.saveSettings(acme.owner, { name: 'Acme Travel Group', timezone: 'Europe/London', outOfPolicy: 'block', approvalHours: '48', budgetPeriod: 'month', rev: org.rev });
  assert.deepEqual([org.name, org.nameKey, org.timezone, org.settings], ['Acme Travel Group', 'acmetravelgroup', 'Europe/London', { outOfPolicy: 'block', approvalHours: 48, reasonMinChars: 10, budgetPeriod: 'month' }]);
  assert.equal(org.status, 'pending', 'a new name goes back to Tripelyx for confirmation');
  const e = (await audits(acme.id))[0];
  assert.deepEqual([e.action, e.summary], ['org.settings_changed', 'Olivia Owner changed the company settings. Tripelyx will confirm the new name before anyone else can join.']);
  assert.deepEqual(e.changes, [
    { path: 'name', before: 'Acme Inc', after: 'Acme Travel Group' }, { path: 'timezone', before: 'Africa/Cairo', after: 'Europe/London' },
    { path: 'settings.outOfPolicy', before: 'approval', after: 'block' }, { path: 'settings.approvalHours', before: 24, after: 48 },
    { path: 'settings.budgetPeriod', before: 'quarter', after: 'month' }, { path: 'status', before: 'active', after: 'pending' },
  ]);

  // A Travel Admin changes the travel rules; the company's name and time zone only as they are.
  org = await svc.saveSettings(tara.actor, { name: org.name, timezone: org.timezone, approvalHours: '4', outOfPolicy: 'approval', rev: org.rev });
  assert.deepEqual([org.settings.approvalHours, org.settings.outOfPolicy], [4, 'approval']);
  await rejectsWith(svc.saveSettings(tara.actor, { name: 'Renamed by Tara', rev: org.rev }), 403, 'forbidden');
  await rejectsWith(svc.saveSettings(tara.actor, { timezone: 'UTC', rev: org.rev }), 403, 'forbidden');
  await rejectsWith(svc.saveSettings(fay.actor, { approvalHours: '30', rev: org.rev }), 403, 'forbidden');
  assert.equal((await svc.getOrg(acme.owner)).rev, org.rev, 'refusals write nothing');

  const bad = await svc.saveSettings(acme.owner, { name: 'Tripelyx Partners', timezone: 'Moon/Base', outOfPolicy: 'soft', approvalHours: '3', budgetPeriod: 'year', rev: org.rev }).catch(x => x);
  assert.equal(bad.code, 'invalid_settings');
  assert.deepEqual(Object.keys(bad.details).sort(), ['approvalHours', 'budgetPeriod', 'name', 'outOfPolicy', 'timezone']);
  assert.equal(bad.details.approvalHours, 'Enter a number of hours from 4 to 168.');
  for (const h of ['169', '1.5', '-4', 'ten']) assert.ok((await svc.saveSettings(acme.owner, { approvalHours: h, rev: org.rev }).catch(x => x)).details.approvalHours, h);
  assert.equal((await svc.saveSettings(acme.owner, { approvalHours: '168', rev: org.rev })).settings.approvalHours, 168);
  await rejectsWith(svc.saveSettings(acme.owner, { approvalHours: '100', rev: org.rev }), 409, 'conflict');
});

test('exportCompany: the Owner downloads the company records as JSON, never invites, tokens or account records; audited', async t => {
  const { app, svc, repo, company, join, audits } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const tara = await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin' });
  const eng = await svc.saveDepartment(acme.owner, { name: 'Engineering' });
  const { token } = await svc.invite(acme.owner, { email: 'later@example.com', role: 'employee' });
  await seedBudget(app, { id: acme.id, org: acme.org }, eng.id, { amountCents: 500000 });
  const rid = id('btr');
  await repo.insert(KINDS.request, rid, { id: rid, orgId: acme.id, travelerId: tara.user.id, status: 'draft', demo: true, rev: 0 }, { owner: acme.id });
  const bo = await seedUser(app, { name: 'Bea Owner' });
  const beta = await company(bo, { name: 'Beta Co' });
  await svc.saveDepartment(beta.owner, { name: 'Beta Secret Team' });

  const out = await svc.exportCompany(acme.owner);
  assert.equal(out.filename, `tripelyx-company-${acme.id}.json`);
  const data = JSON.parse(out.json);
  assert.deepEqual(Object.keys(data), ['format', 'version', 'exportedAt', 'note', 'org', 'members', 'departments', 'policies', 'policyVersions', 'budgets', 'requests', 'audit', 'truncated']);
  assert.equal(data.org.id, acme.id);
  assert.deepEqual(data.members.map(m => m.name).sort(), ['Olivia Owner', 'Tara Admin']);
  assert.deepEqual(data.departments.map(d => d.name), ['Engineering', 'General']);
  assert.deepEqual(data.policies.map(p => p.tier), ['standard', 'director', 'executive']);
  assert.deepEqual(data.policyVersions.map(p => `${p.tier}.v${p.version}`), ['standard.v1', 'director.v1', 'executive.v1']);
  assert.deepEqual(data.budgets.map(b => b.amountCents), [500000]);
  assert.deepEqual(data.requests.map(r => r.id), [rid]);
  assert.ok(data.audit.some(e => e.action === 'org.created'));
  assert.deepEqual(data.truncated, {});
  assert.match(data.note, /demo prices/);
  const text = out.json;
  for (const secret of [token, crypto.createHash('sha256').update(token).digest('hex'), 'passwordHash', 'Beta Secret Team', beta.id, 'later@example.com']) {
    assert.ok(!text.includes(secret), `the export holds no ${secret.slice(0, 12)}`);
  }
  const e = (await audits(acme.id))[0];
  assert.deepEqual([e.action, e.summary], ['org.exported', 'Olivia Owner downloaded the company data (2 members, 1 requests)']);
  await rejectsWith(svc.exportCompany(tara.actor), 403, 'forbidden');
});

// ---------------------------------------------------------------------------------------------------
// Activity log

test('listAudit: 50 per page, newest first, every entry exactly once past 1,000, one group at a time, and foreign cursors are 404', async t => {
  const { app, svc, repo, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const sam = await join(acme, acme.owner, 'employee', { name: 'Sam Traveler' });
  const fay = await join(acme, acme.owner, 'finance', { name: 'Fay Finance' });
  const actorRef = { userId: olivia.user.id, name: 'Olivia Owner', role: 'owner' };
  for (let c = 0; c < 13; c += 1) {
    await repo.commit({
      inserts: Array.from({ length: 100 }, (_, i) => auditInsert(repo, {
        orgId: acme.id, actor: actorRef, action: (c * 100 + i) % 7 === 0 ? 'budget.set' : 'request.message', target: { kind: KINDS.request, id: `btr_${c}_${i}` },
        summary: `entry ${c * 100 + i}`,
      })),
    });
  }
  const everything = [];
  let cursor = null;
  do {
    const page = await repo.page(KINDS.audit, acme.id, { limit: 200, cursor });
    everything.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  assert.ok(everything.length > 1300);

  const seen = [];
  let pages = 0;
  cursor = null;
  do {
    const page = await svc.listAudit(fay.actor, { cursor });
    assert.ok(page.rows.length <= 50);
    seen.push(...page.rows);
    cursor = page.cursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, Math.ceil(everything.length / 50));
  assert.deepEqual(seen.map(e => e.id), everything.map(e => e.id), 'every entry once, in store order (newest first)');
  assert.equal(new Set(seen.map(e => e.id)).size, seen.length);

  const budget = [];
  cursor = null;
  do {
    const page = await svc.listAudit(fay.actor, { group: 'budget', cursor });
    assert.ok(page.rows.length <= 50 && page.rows.every(e => e.group === 'budget'));
    budget.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(budget.map(e => e.id), everything.filter(e => e.group === 'budget').map(e => e.id));
  assert.ok(budget.length > 150);
  // A rare group: the team's own entries are the oldest, under 1,300 newer ones. The first call stops after
  // FILTER_PAGES (25) store reads of 50 with nothing found and offers "Show older"; the next one finds them.
  const first = await svc.listAudit(fay.actor, { group: 'member' });
  assert.deepEqual(first.rows, []);
  assert.ok(first.cursor);
  const rest = await svc.listAudit(fay.actor, { group: 'member', cursor: first.cursor });
  assert.deepEqual(rest.rows.map(e => e.action).sort(), ['member.invited', 'member.invited', 'member.joined', 'member.joined']);
  assert.equal(rest.cursor, null);
  assert.deepEqual(rest.rows.map(e => e.id), everything.filter(e => e.group === 'member').map(e => e.id));
  assert.equal((await svc.listAudit(fay.actor, { group: 'no-such-group' })).rows.length, 50, 'an unknown group shows everything');
  assert.ok(AUDIT_GROUPS.includes('member'));

  const bo = await seedUser(app, { name: 'Bea Owner' });
  const beta = await company(bo, { name: 'Beta Co' });
  const theirs = (await svc.listAudit(beta.owner)).cursor;
  assert.equal(theirs, null);
  const mine = (await svc.listAudit(acme.owner)).cursor;
  await rejectsWith(svc.listAudit(beta.owner, { cursor: mine }), 404, 'not_found');
  await rejectsWith(svc.listAudit(acme.owner, { cursor: `${mine}x` }), 404, 'not_found');
  await rejectsWith(svc.listAudit(acme.owner, { cursor: 'garbage' }), 404, 'not_found');
  await rejectsWith(svc.listAudit(sam.actor), 403, 'forbidden');
});

test('every team change writes its audit entry in the same commit, stamped by the injected clock', async t => {
  const clock = mutableClock(FIXED_NOW);
  const { app, svc, admin, company, audits } = await setup({ clock });
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  let minute = 0;
  const tick = () => { minute += 1; clock.set(new Date(Date.parse(FIXED_NOW) + minute * 60000).toISOString()); return clock.now().toISOString(); };
  const expect = [];
  const step = async (action, fn) => { const at = tick(); await fn(); expect.push([action, at]); };
  let acme;
  await step('org.created', async () => { acme = await company(olivia, { confirm: false }); });
  await step('org.confirmed', () => svc.platformSetStatus(admin, acme.id, { status: 'active', rev: acme.org.rev }));
  let sam, inv, dep;
  await step('member.invited', async () => { inv = await svc.invite(acme.owner, { email: 'sam@example.com', role: 'employee' }); });
  sam = await seedUser(app, { name: 'Sam Traveler', email: 'sam@example.com' });
  await step('member.joined', () => svc.acceptInvite({ user: sam.user }, inv.token));
  await step('member.invited', async () => { inv = await svc.invite(acme.owner, { email: 'x@example.com', role: 'employee' }); });
  await step('member.invite_revoked', () => svc.revokeInvite(acme.owner, inv.invite.publicId));
  await step('department.created', async () => { dep = await svc.saveDepartment(acme.owner, { name: 'Engineering' }); });
  await step('department.renamed', async () => { dep = await svc.saveDepartment(acme.owner, { departmentId: dep.id, name: 'Eng', rev: dep.rev }); });
  await step('department.archived', () => svc.saveDepartment(acme.owner, { departmentId: dep.id, archive: '1', rev: dep.rev }));
  let m = (await svc.listMembers(acme.owner)).members.find(x => x.userId === sam.user.id);
  await step('member.updated', async () => { m = await svc.updateMember(acme.owner, sam.user.id, { tier: 'director', rev: m.rev }); });
  await step('member.role_changed', async () => { m = await svc.updateMember(acme.owner, sam.user.id, { role: 'manager', rev: m.rev }); });
  await step('org.settings_changed', async () => svc.saveSettings(acme.owner, { approvalHours: '30', rev: (await svc.getOrg(acme.owner)).rev }));
  await step('org.exported', () => svc.exportCompany(acme.owner));
  await step('member.removed', () => svc.removeMember(acme.owner, sam.user.id, { rev: m.rev }));
  await step('org.suspended', async () => svc.platformSetStatus(admin, acme.id, { status: 'suspended', note: 'Paused for a check', rev: (await svc.getOrg(acme.owner)).rev }));
  const org = await app.business.repo.getIn(KINDS.org, acme.id, acme.id);
  await step('org.reactivated', () => svc.platformSetStatus(admin, acme.id, { status: 'active', rev: org.rev }));
  const log = (await audits(acme.id)).map(e => [e.action, e.at]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  assert.deepEqual(log, expect);
});

// ---------------------------------------------------------------------------------------------------
// People page

test('listMembers: 50 per page with names for departments, managers and approvers; emails and invites only with members.manage; approval warnings', async t => {
  const { app, svc, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const eng = await svc.saveDepartment(acme.owner, { name: 'Engineering' });
  const dana = await join(acme, acme.owner, 'manager', { name: 'Dana Lee', email: 'dana@example.com' });
  const sam = await join(acme, acme.owner, 'employee', { name: 'Sam Traveler', email: 'sam@example.com', departmentId: eng.id, managerId: dana.user.id });
  await svc.invite(acme.owner, { email: 'pending@example.com', role: 'employee', departmentId: eng.id });

  const view = await svc.listMembers(acme.owner);
  assert.equal(view.memberCount, 3);
  assert.deepEqual(view.members.map(m => [m.name, m.roleLabel]), [['Olivia Owner', 'Owner'], ['Dana Lee', 'Manager'], ['Sam Traveler', 'Employee']]);
  const s = view.members.find(m => m.userId === sam.user.id);
  assert.deepEqual(s, {
    userId: sam.user.id, name: 'Sam Traveler', email: 'sam@example.com', role: 'employee', roleLabel: 'Employee', status: 'active',
    department: { id: eng.id, name: 'Engineering' }, manager: { userId: dana.user.id, name: 'Dana Lee' }, approver: null, tier: 'standard',
    at: FIXED_NOW, rev: 0,
  });
  assert.deepEqual(view.invites.map(i => [i.email, i.departmentName]), [['pending@example.com', 'Engineering']]);
  assert.deepEqual(view.departments.map(d => d.name), ['Engineering', 'General']);
  // Dana and Sam reach the owner's pool; the owner alone has nobody else who can approve.
  assert.deepEqual(view.warnings, ['Olivia Owner has no one who can approve their trips']);
  assert.equal(svc.policy.calls.resolveApprover, 3);

  const mgr = await svc.listMembers(dana.actor);
  assert.ok(mgr.members.every(m => m.email === null), 'no emails without members.manage');
  assert.equal(mgr.invites, null);
  await rejectsWith(svc.listMembers(sam.actor), 403, 'forbidden');

  // A second owner clears the warning; a member with a removed manager and no admins would get one.
  await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin' });
  assert.deepEqual((await svc.listMembers(acme.owner)).warnings, []);

  // Paging: 55 members → 50, then 5; a foreign cursor is a 404.
  for (let i = 0; i < 51; i += 1) await seedMember(app, { id: acme.id, org: acme.org }, 'employee', { name: `Person ${String(i).padStart(2, '0')}` });
  const p1 = await svc.listMembers(acme.owner);
  assert.equal(p1.members.length, 50);
  assert.ok(p1.cursor);
  const p2 = await svc.listMembers(acme.owner, { cursor: p1.cursor });
  assert.equal(p2.members.length, 5);
  assert.equal(p2.cursor, null);
  assert.equal(new Set([...p1.members, ...p2.members].map(m => m.userId)).size, 55);
  const bo = await seedUser(app, { name: 'Bea Owner' });
  const beta = await company(bo, { name: 'Beta Co' });
  await rejectsWith(svc.listMembers(beta.owner, { cursor: p1.cursor }), 404, 'not_found');
});

// ---------------------------------------------------------------------------------------------------
// Platform admin

test('platform: only platform admins list and change companies; pending first, creator email, similar names, business enquiries; every change audited', async t => {
  const { app, svc, admin, company, audits } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner', email: 'olivia@acme.example' });
  const acme = await company(olivia, { name: 'Acme Inc' });
  const copy = await seedUser(app, { name: 'Copy Cat', email: 'copy@example.com' });
  const twin = await company(copy, { name: 'ACME, Inc.', confirm: false });
  const zed = await seedUser(app, { name: 'Zed', email: 'zed@example.com' });
  const third = await company(zed, { name: 'Zed Co', confirm: false });
  await app.store.savePartnerLead({ name: 'Lead A', email: 'a@example.com', kind: 'business', at: FIXED_NOW });
  await app.store.savePartnerLead({ name: 'Lead B', email: 'b@example.com', at: FIXED_NOW });

  const notAdmin = { user: { ...olivia.user, isAdmin: false } };
  for (const who of [notAdmin, { user: null }, null, { user: { ...olivia.user, isAdmin: 'yes' } }]) {
    await rejectsWith(svc.platformListOrgs(who), 404, 'not_found');
    await rejectsWith(svc.platformSetStatus(who, twin.id, { status: 'active', rev: 0 }), 404, 'not_found');
  }
  const view = await svc.platformListOrgs(admin);
  assert.deepEqual(view.orgs.map(o => [o.name, o.status]), [['Zed Co', 'pending'], ['ACME, Inc.', 'pending'], ['Acme Inc', 'active']]);
  const row = view.orgs.find(o => o.id === twin.id);
  assert.deepEqual(row, {
    id: twin.id, name: 'ACME, Inc.', status: 'pending', size: '11-50 people', at: FIXED_NOW, creatorEmail: 'copy@example.com', memberCount: 1,
    timezone: 'Africa/Cairo', similarNames: ['Acme Inc'], statusNote: null, statusAt: null, previousName: null, house: false, rev: 0,
  });
  assert.equal(view.house, null, "no Tripelyx company until a platform admin makes it");
  assert.deepEqual(view.orgs.find(o => o.id === third.id).similarNames, []);
  assert.deepEqual(view.leads.map(l => l.name), ['Lead A']);

  // pending → active → suspended (note required) → active.
  const bad = await svc.platformSetStatus(admin, twin.id, { status: 'deleted', rev: 0 }).catch(x => x);
  assert.deepEqual([bad.code, Object.keys(bad.details)], ['invalid_status', ['status']]);
  await rejectsWith(svc.platformSetStatus(admin, 'org_AAAAAAAAAAAAAAAA', { status: 'active', rev: 0 }), 404, 'not_found');
  await rejectsWith(svc.platformSetStatus(admin, 'nope', { status: 'active', rev: 0 }), 404, 'not_found');
  let o = await svc.platformSetStatus(admin, twin.id, { status: 'active', rev: 0 });
  assert.deepEqual([o.status, o.statusBy, o.statusAt, o.statusNote], ['active', admin.user.id, FIXED_NOW, null]);
  let e = (await audits(twin.id))[0];
  assert.deepEqual([e.action, e.actor, e.summary, e.changes], ['org.confirmed', { platformAdmin: admin.user.id, name: 'Tripelyx' }, 'Tripelyx confirmed ACME, Inc.', [{ path: 'status', before: 'pending', after: 'active' }]]);
  await rejectsWith(svc.platformSetStatus(admin, twin.id, { status: 'suspended', note: 'A stale form', rev: 0 }), 409, 'conflict');
  const noNote = await svc.platformSetStatus(admin, twin.id, { status: 'suspended', note: '  ', rev: o.rev }).catch(x => x);
  assert.deepEqual([noNote.code, noNote.details], ['invalid_status', { note: 'Write a short note on why this company is paused.' }]);
  o = await svc.platformSetStatus(admin, twin.id, { status: 'suspended', note: 'Looks like a copy of another company', rev: o.rev });
  assert.deepEqual([o.status, o.statusNote], ['suspended', 'Looks like a copy of another company']);
  // The platform list shows staff why it is paused, and since when (lead decision L2-4).
  const paused = (await svc.platformListOrgs(admin)).orgs.find(x => x.id === twin.id);
  assert.deepEqual([paused.statusNote, paused.statusAt, paused.previousName], ['Looks like a copy of another company', FIXED_NOW, null]);
  assert.equal((await audits(twin.id))[0].action, 'org.suspended');
  await rejectsWith(svc.getOrg(twin.owner), 403, 'org_suspended');
  await rejectsWith(svc.invite(twin.owner, { email: 'x@example.com', role: 'employee' }), 403, 'org_suspended');
  assert.deepEqual(await svc.platformSetStatus(admin, twin.id, { status: 'suspended', note: 'again', rev: o.rev }), o, 'the same status changes nothing');
  o = await svc.platformSetStatus(admin, twin.id, { status: 'active', rev: o.rev });
  e = (await audits(twin.id))[0];
  assert.deepEqual([e.action, e.summary], ['org.reactivated', 'Tripelyx reactivated ACME, Inc.']);
  assert.equal((await svc.getOrg(twin.owner)).status, 'active');

  // A platform admin gets nothing inside a company from isAdmin.
  await rejectsWith(svc.getOrg({ org: { id: acme.id }, member: { role: 'owner' }, user: admin.user }), 404, 'not_found');
  await rejectsWith(svc.listMembers({ org: { id: acme.id }, user: admin.user }), 404, 'not_found');
});

// ---------------------------------------------------------------------------------------------------
// Tripelyx's own company (go-live design §3.8)

/** Every spelling sign-up refuses (the createCompany test above), and the house name itself. */
const TRIPELYX_SPELLINGS = Object.freeze(['Tripelyx Travel', 'my TRIPELYX', 'Ｔｒｉｐｅｌｙｘ', 'Trip\u200belyx Tours', 'Trip elyx', 'trip-elyx partners', 'Trípelyx', 'T.R.I.P.E.L.Y.X', HOUSE_COMPANY_NAME]);

test("house company: only a platform admin makes Tripelyx Inc, once, active and owned by them; its name never changes; sign-up and renames still refuse Tripelyx", async t => {
  const { app, svc, repo, admin, company, audits } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner', email: 'olivia@acme.example' });
  const listedNotGranted = await seedUser(app, { name: 'Lee Listed', email: 'lee@example.com' });

  // Anyone but a platform admin (an isAdmin flag on an ordinary account included) gets 404 and writes nothing.
  const before = storeSnapshot(app);
  for (const who of [{ user: { ...olivia.user, isAdmin: false } }, { user: { ...olivia.user, isAdmin: true } }, { user: { ...listedNotGranted.user, isAdmin: true } }, { user: null }, {}, null]) {
    await rejectsWith(svc.platformCreateHouseCompany(who), 404, 'not_found');
  }
  assert.equal(storeSnapshot(app), before, 'refusals write nothing');
  assert.equal(await repo.houseOrgId(), null);

  const first = await svc.platformCreateHouseCompany(admin);
  assert.equal(first.created, true);
  const org = first.org;
  assert.deepEqual(
    [org.name, org.status, org.house, org.size, org.timezone, org.ownerIds, org.createdBy, org.memberCount, org.statusBy],
    [HOUSE_COMPANY_NAME, 'active', true, null, 'Africa/Cairo', [admin.user.id], admin.user.id, 1, null],
  );
  // The pointer, in the same commit: one fixed id, insert-only, naming the company.
  assert.deepEqual(await repo.getIn(KINDS.house, HOUSE_ID, org.id), { orgId: org.id, at: FIXED_NOW, by: admin.user.id });
  assert.equal(await repo.houseOrgId(), org.id);
  await assert.rejects(repo.cas(KINDS.house, HOUSE_ID, null, d => { d.orgId = 'org_AAAAAAAAAAAAAAAA'; }), /insert-only/);
  await assert.rejects(repo.del(KINDS.house, HOUSE_ID), /never deleted/);
  // Everything createCompany makes, through the same commit: the Owner in General, three v1 policies, the index.
  const owner = await repo.getIn(KINDS.member, `${org.id}.${admin.user.id}`, org.id);
  assert.deepEqual([owner.role, owner.status, owner.tier, owner.email], ['owner', 'active', 'standard', 'ops@example.com']);
  assert.equal(recordsOf(app, KINDS.policy).filter(p => p.orgId === org.id).length, TIERS.length);
  assert.equal(recordsOf(app, KINDS.department).filter(d => d.orgId === org.id).length, 1);
  assert.deepEqual((await repo.list(KINDS.userIndex, admin.user.id)).map(x => x.orgIds), [[org.id]]);
  const log = await audits(org.id);
  assert.deepEqual(log.map(e => [e.action, e.actor, e.summary]), [
    ['org.house_created', { platformAdmin: admin.user.id, name: 'Tripelyx' }, 'Tripelyx created Tripelyx Inc, its own company, with Pat Platform as its Owner'],
  ]);

  // A second press makes nothing and answers the company already there.
  const snap = storeSnapshot(app);
  const again = await svc.platformCreateHouseCompany(admin);
  assert.deepEqual([again.created, again.org.id], [false, org.id]);
  assert.equal(storeSnapshot(app), snap, 'a second press writes nothing');

  // The platform page shows it, by name and id.
  const view = await svc.platformListOrgs(admin);
  assert.deepEqual(view.house, { id: org.id, name: HOUSE_COMPANY_NAME, status: 'active' });
  assert.deepEqual(view.orgs.map(o => [o.name, o.house]), [[HOUSE_COMPANY_NAME, true]]);

  // Its name never changes; everything else in its settings does.
  const houseOwner = { org: { id: org.id }, user: admin.user };
  const cur = await svc.getOrg(houseOwner);
  assert.equal(cur.house, true);
  for (const name of ['Acme Inc', 'Tripelyx Travel', 'tripelyx inc', ' ']) {
    const err = await svc.saveSettings(houseOwner, { name, rev: cur.rev }).catch(x => x);
    assert.deepEqual([err.status, err.code, err.details], [422, 'invalid_settings', { name: HOUSE_NAME_FIXED }], name);
  }
  const saved = await svc.saveSettings(houseOwner, { name: HOUSE_COMPANY_NAME, timezone: 'Europe/London', rev: cur.rev });
  assert.deepEqual([saved.name, saved.status, saved.timezone], [HOUSE_COMPANY_NAME, 'active', 'Europe/London']);

  // Sign-up and every other company's rename still refuse each spelling, the house name included.
  const acme = await company(olivia, { name: 'Acme Inc' });
  for (const name of TRIPELYX_SPELLINGS) {
    await assert.rejects(svc.createCompany({ user: olivia.user }, { ...FORM, name }),
      e => e.status === 422 && e.code === 'invalid_company' && e.details.name === "Choose your own company's name.", `sign-up ${name}`);
    const o = await svc.getOrg(acme.owner);
    await assert.rejects(svc.saveSettings(acme.owner, { name, rev: o.rev }),
      e => e.status === 422 && e.code === 'invalid_settings' && e.details.name === "Choose your own company's name.", `rename ${name}`);
  }
  assert.equal(recordsOf(app, KINDS.org).filter(o => o.house === true).length, 1);
  assert.equal(recordsOf(app, KINDS.org).filter(o => /tripelyx/i.test(o.name)).length, 1, 'only the house company says Tripelyx');
});

test('house company: two presses at once (one admin twice, or two admins) make exactly one', async t => {
  for (const twoAdmins of [false, true]) {
    const { app, svc, admin, audits } = await setup({ env: { ADMIN_EMAILS: 'ops@example.com,ops2@example.com' } });
    t.after(app.close);
    let other = admin;
    if (twoAdmins) {
      const sam = await seedUser(app, { name: 'Sam Staff', email: 'ops2@example.com' });
      await app.accounts.grantPlatformAdmin(sam.user.id, { by: 'test' });
      other = { user: { ...sam.user, isAdmin: true } };
    }
    // A real race: both presses read "none" before either commits (the first two reads wait for each other),
    // and the commits that lose are counted.
    const readHouse = svc.repo.houseOrgId.bind(svc.repo);
    let reads = 0, release;
    const bothRead = new Promise(resolve => { release = resolve; });
    svc.repo.houseOrgId = async () => {
      const v = await readHouse();
      reads += 1;
      if (reads === 2) release();
      if (reads <= 2) await bothRead;
      return v;
    };
    const orig = app.store.commit.bind(app.store);
    let lost = 0;
    app.store.commit = async spec => {
      const res = await orig(spec);
      if (!res.ok) lost += res.reason === 'duplicate' ? 1 : 100;
      return res;
    };
    const results = await Promise.all([svc.platformCreateHouseCompany(admin), svc.platformCreateHouseCompany(other)]);
    app.store.commit = orig;
    delete svc.repo.houseOrgId;
    assert.equal(reads, 3, 'two reads before the commits, then the loser reads again and finds the winner');
    assert.deepEqual(results.map(r => r.created).sort(), [false, true], `twoAdmins=${twoAdmins}`);
    assert.equal(results[0].org.id, results[1].org.id);
    assert.equal(lost, 1, 'the second press lost at the commit (the biz_house id was taken) and made nothing');
    const orgs = recordsOf(app, KINDS.org);
    assert.equal(orgs.length, 1, 'one company');
    assert.equal(recordsOf(app, KINDS.house).length, 1, 'one pointer');
    assert.equal(recordsOf(app, KINDS.member).length, 1, 'one member');
    assert.deepEqual((await audits(orgs[0].id)).map(e => e.action), ['org.house_created']);
  }
});

// ---------------------------------------------------------------------------------------------------
// Actors, outbox, HTTP guards

test('the role comes from biz_member only: forged, stale, removed and foreign actors get 404 on every company method', async t => {
  const { app, svc, repo, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const sam = await join(acme, acme.owner, 'employee', { name: 'Sam Traveler' });
  const forged = { org: { id: acme.id, name: 'Acme Inc' }, member: { role: 'owner', userId: sam.user.id }, user: sam.user };
  await assert.rejects(svc.invite(forged, { email: 'x@example.com', role: 'employee' }),
    e => e.status === 403 && e.message === "Your role (Employee) can't open this page. Ask a travel admin at Acme Inc if you need it.");
  // The stored role changes: the same actor object acts with it at once.
  await repo.cas(KINDS.member, `${acme.id}.${sam.user.id}`, null, d => { d.role = 'travel_admin'; });
  assert.equal((await svc.invite(forged, { email: 'x@example.com', role: 'employee' })).invite.role, 'employee');

  const stranger = await seedUser(app, { name: 'Stan Stranger' });
  const bo = await seedUser(app, { name: 'Bea Owner' });
  const beta = await company(bo, { name: 'Beta Co' });
  const dep = await svc.saveDepartment(acme.owner, { name: 'Engineering' });
  const actors = [
    { org: { id: acme.id }, member: { role: 'owner' }, user: stranger.user },
    { org: { id: acme.id }, user: bo.user },
    { org: { id: 'org_AAAAAAAAAAAAAAAA' }, user: olivia.user },
    { org: { id: beta.id }, user: olivia.user },
    { org: { id: acme.id }, user: { id: '' } },
    { org: {}, user: olivia.user },
    null,
  ];
  const calls = a => [
    () => svc.getOrg(a), () => svc.listMembers(a), () => svc.invite(a, { email: 'q@example.com', role: 'employee' }),
    () => svc.revokeInvite(a, 'inv_AAAAAAAAAAAAAAAA'), () => svc.updateMember(a, sam.user.id, { tier: 'director', rev: 1 }),
    () => svc.removeMember(a, sam.user.id, { rev: 1 }), () => svc.saveDepartment(a, { departmentId: dep.id, name: 'X', rev: 0 }),
    () => svc.listDepartments(a), () => svc.saveSettings(a, { name: 'X', rev: 0 }), () => svc.exportCompany(a), () => svc.listAudit(a),
  ];
  for (const a of actors) for (const fn of calls(a)) await rejectsWith(fn(), 404, 'not_found');
  // Removed: gone at once.
  const m = await repo.getIn(KINDS.member, `${acme.id}.${sam.user.id}`, acme.id);
  await svc.removeMember(acme.owner, sam.user.id, { rev: m.rev });
  for (const fn of calls(sam.actor)) await rejectsWith(fn(), 404, 'not_found');
});

test('no team method writes an outbox record or calls the notifier', async t => {
  const { app, svc, admin, company, join } = await setup();
  t.after(app.close);
  let sent = 0;
  const notifier = app.tripService.notifier;
  assert.equal(typeof notifier.send, 'function', 'the app has a notifier to watch');
  const orig = notifier.send.bind(notifier);
  notifier.send = (...x) => { sent += 1; return orig(...x); };
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const sam = await join(acme, acme.owner, 'employee', { name: 'Sam Traveler' });
  const inv = await svc.invite(acme.owner, { email: 'later@example.com', role: 'manager' });
  await svc.inviteByToken({ user: null }, inv.token);
  await svc.revokeInvite(acme.owner, inv.invite.publicId);
  const dep = await svc.saveDepartment(acme.owner, { name: 'Engineering' });
  await svc.updateMember(acme.owner, sam.user.id, { departmentId: dep.id, rev: sam.member.rev });
  await svc.saveSettings(acme.owner, { approvalHours: '12', rev: (await svc.getOrg(acme.owner)).rev });
  await svc.listMembers(acme.owner);
  await svc.exportCompany(acme.owner);
  await svc.listAudit(acme.owner);
  await svc.platformListOrgs(admin);
  await svc.removeMember(acme.owner, sam.user.id, { rev: sam.member.rev + 1 });
  assert.equal(recordsOf(app, 'outbox').length, 0);
  assert.equal(sent, 0);
  assert.equal(app.store.quotes.size + app.store.bookings.size + app.store.intents.size, 0, 'no quotes, bookings or payment intents');
});

/** A tiny app around the real guards (from 1C's memberGate test), with req.user from an x-user header. */
async function guardApp(ctx, users) {
  const app = express();
  app.use((req, res, next) => { req.user = users[req.get('x-user')] || null; next(); });
  const g = http.gates(ctx);
  const ok = (req, res) => res.json({ org: req.biz.org.id, role: req.biz.member.role });
  app.get('/business/o/:orgId', g.memberGate('org.view'), ok);
  app.get('/business/o/:orgId/activity', g.memberGate('audit.view'), ok);
  app.get('/business/o/:orgId/people', g.memberGate('members.view'), ok);
  app.get('/business/o/:orgId/shell', g.memberGate('org.view'), async (req, res, next) => { try { res.json(await g.shellContext(req)); } catch (e) { next(e); } });
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code, message: err.message }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('memberGate on companies built by the service: 404 for strangers, other companies and removed members, 403 with the role, suspended 403, the real switcher', async t => {
  const { app, svc, admin, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia, { name: 'Acme Inc' });
  const bo = await seedUser(app, { name: 'Bea Owner' });
  const beta = await company(bo, { name: 'Beta Co' });
  const sam = await join(acme, acme.owner, 'employee', { name: 'Sam Traveler' });
  const dana = await join(acme, acme.owner, 'manager', { name: 'Dana Lee' });
  const { token } = await svc.invite(beta.owner, { email: dana.user.email, role: 'employee' });
  await svc.acceptInvite({ user: dana.user }, token);
  const stranger = await seedUser(app, { name: 'Stan Stranger' });
  svc.inboxCount = async () => 0; // requests.js (1W-b) owns the real count
  const users = { olivia: olivia.user, bea: bo.user, sam: sam.user, dana: dana.user, stranger: stranger.user, admin: admin.user };
  const g = await guardApp(app.ctx, users);
  t.after(g.close);
  const req = (path, who) => fetch(g.base + path, { redirect: 'manual', headers: who ? { 'x-user': who } : {} });
  const o = `/business/o/${acme.id}`;

  let r = await req(o, 'olivia');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { org: acme.id, role: 'owner' });
  for (const [path, who] of [[o, 'stranger'], [o, 'admin'], [o, 'bea'], ['/business/o/org_AAAAAAAAAAAAAAAA', 'olivia'], [`/business/o/${beta.id}`, 'sam']]) {
    r = await req(path, who);
    assert.equal(r.status, 404, `${who} ${path}`);
    const body = await r.text();
    assert.match(body, /Page not found/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    noInline(path, body);
  }
  r = await req(`${o}/activity`, 'sam');
  assert.equal(r.status, 403);
  assert.match(await r.text(), /Your role \(Employee\) can(’|'|&#39;|&#x27;)t open this page\. Ask a travel admin at Acme Inc if you need it\./);
  assert.equal((await req(`${o}/people`, 'dana')).status, 200);
  r = await req(`${o}/activity`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `/business/signin?next=${encodeURIComponent(`${o}/activity`)}`);

  // The switcher is the real listCompaniesFor: Dana is in both companies with a role in each.
  const shell = await (await req(`${o}/shell`, 'dana')).json();
  assert.deepEqual(shell.companies, [
    { id: acme.id, name: 'Acme Inc', status: 'active', role: 'manager', roleLabel: 'Manager' },
    { id: beta.id, name: 'Beta Co', status: 'active', role: 'employee', roleLabel: 'Employee' },
  ]);
  assert.equal(shell.approvalsCount, 0);

  // A role change applies on the next request; a removed member is a stranger at once.
  const samNow = await svc.membership({ user: sam.user }, acme.id);
  await svc.updateMember(acme.owner, sam.user.id, { role: 'manager', rev: samNow.rev });
  assert.equal((await req(`${o}/people`, 'sam')).status, 200);
  await svc.removeMember(acme.owner, sam.user.id, { rev: samNow.rev + 1 });
  assert.equal((await req(o, 'sam')).status, 404);

  // Suspended by the platform: members get the paused page, strangers still a 404.
  await svc.platformSetStatus(admin, acme.id, { status: 'suspended', note: 'A routine check', rev: (await svc.getOrg(acme.owner)).rev });
  r = await req(o, 'olivia');
  assert.equal(r.status, 403);
  assert.match(await r.text(), /Tripelyx has paused this company workspace\. Write to go@tripelyx\.com\./);
  assert.equal((await req(o, 'stranger')).status, 404);
});

// ---------------------------------------------------------------------------------------------------
// Postgres: the D8 race on real transactions

const pgUrl = process.env.TEST_DATABASE_URL;
test('PostgresStore: two owners racing to demote each other 200 times: exactly one succeeds and an owner remains (D8)', { skip: !pgUrl && 'TEST_DATABASE_URL not set', timeout: 120000 }, async t => {
  const store = new PostgresStore({ connectionString: pgUrl, ssl: false });
  await store.init();
  t.after(() => store.close());
  const now = () => new Date(FIXED_NOW);
  const config = loadConfig({ APP_ENV: 'development', ENABLE_BUSINESS: 'true' });
  const user = name => ({ id: id('usr'), name, email: `${name.toLowerCase().replace(/\W+/g, '.')}.${crypto.randomBytes(3).toString('hex')}@example.com` });
  const admin = { user: { ...user('Pat Platform'), isAdmin: true } };
  const accounts = { isPlatformAdmin: async u => !!u && u.id === admin.user.id };
  const svc = new BusinessService({ repo: new Repo({ store, now }), config, now, policy: fakePolicy(), accounts });
  const a = user('Ada Owner'), b = user('Bo Owner');
  const { org } = await svc.createCompany({ user: a }, FORM);
  await svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev });
  const { token } = await svc.invite({ org: { id: org.id }, user: a }, { email: b.email, role: 'owner' });
  await svc.acceptInvite({ user: b }, token);
  const ma = await svc.membership({ user: a }, org.id), mb = await svc.membership({ user: b }, org.id);
  const results = await Promise.allSettled(Array.from({ length: 200 }, (_, i) => (i % 2
    ? svc.updateMember({ org: { id: org.id }, user: a }, b.id, { role: 'manager', rev: mb.rev })
    : svc.updateMember({ org: { id: org.id }, user: b }, a.id, { role: 'manager', rev: ma.rev }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of results.filter(x => x.status === 'rejected')) assert.ok(r.reason instanceof AppError && [403, 409].includes(r.reason.status), r.reason.message);
  const after = await svc.repo.getIn(KINDS.org, org.id, org.id);
  assert.equal(after.ownerIds.length, 1);
  const owners = [await svc.membership({ user: a }, org.id), await svc.membership({ user: b }, org.id)].filter(m => m.role === 'owner');
  assert.deepEqual(owners.map(m => m.userId), after.ownerIds);
});

test('PostgresStore: 8 people join at once and 8 are removed at once, all landing; racing department creates keep the 200 cap', { skip: !pgUrl && 'TEST_DATABASE_URL not set', timeout: 120000 }, async t => {
  const store = new PostgresStore({ connectionString: pgUrl, ssl: false });
  await store.init();
  t.after(() => store.close());
  const now = () => new Date(FIXED_NOW);
  const config = loadConfig({ APP_ENV: 'development', ENABLE_BUSINESS: 'true' });
  const user = name => ({ id: id('usr'), name, email: `${name.toLowerCase().replace(/\W+/g, '.')}.${crypto.randomBytes(3).toString('hex')}@example.com` });
  const admin = { user: { ...user('Pat Platform'), isAdmin: true } };
  const repo = new Repo({ store, now });
  const svc = new BusinessService({ repo, config, now, policy: fakePolicy(), accounts: { isPlatformAdmin: async u => !!u && u.id === admin.user.id } });
  const a = user('Ada Owner');
  const { org } = await svc.createCompany({ user: a }, FORM);
  await svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev });
  const owner = { org: { id: org.id }, user: a };
  const people = [];
  for (let i = 0; i < 8; i += 1) {
    const u = user(`Joiner ${i}`);
    people.push({ u, token: (await svc.invite(owner, { email: u.email, role: 'employee' })).token });
  }
  const joined = await Promise.allSettled(people.map(p => svc.acceptInvite({ user: p.u }, p.token)));
  assert.deepEqual(joined.filter(r => r.status === 'rejected').map(r => `${r.reason.status} ${r.reason.code}`), []);
  assert.equal((await repo.getIn(KINDS.org, org.id, org.id)).memberCount, 9);
  const removed = await Promise.allSettled(joined.map(r => svc.removeMember(owner, r.value.member.userId, { rev: r.value.member.rev })));
  assert.deepEqual(removed.filter(r => r.status === 'rejected').map(r => `${r.reason.status} ${r.reason.code}`), []);
  assert.equal((await repo.getIn(KINDS.org, org.id, org.id)).memberCount, 1);

  const have = (await repo.list(KINDS.department, org.id)).length;
  const fill = Array.from({ length: 199 - have }, (_, i) => {
    const depId = id('dep');
    return { kind: KINDS.department, id: depId, data: { id: depId, orgId: org.id, name: `Team ${i}`, archivedAt: null, at: FIXED_NOW, updatedAt: FIXED_NOW, rev: 0 }, owner: org.id };
  });
  await repo.commit({ inserts: fill });
  const four = await Promise.allSettled([0, 1, 2, 3].map(i => svc.saveDepartment(owner, { name: `Last ${i}` })));
  assert.equal(four.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await svc.listDepartments(owner)).length, 200);
});

test('a bare service on a MemoryStore (no app) runs the team methods, and reads by id only invite tokens (I7)', async () => {
  const store = new MemoryStore();
  const now = () => new Date(FIXED_NOW);
  const config = loadConfig({ APP_ENV: 'development', ENABLE_BUSINESS: 'true' });
  const repo = new Repo({ store, now });
  const read = new Set();
  const get = repo.get.bind(repo);
  // Only reads team.js makes itself count (getIn and commit call get inside repo.js).
  repo.get = (kind, key) => {
    const caller = (new Error().stack.split('\n')[2] || '');
    if (caller.includes('/server/business/team.js')) read.add(kind);
    return get(kind, key);
  };
  const admin = { user: { id: id('usr'), name: 'Pat Platform', email: 'ops@example.com', isAdmin: true } };
  // accounts only answers who is a platform admin here; it has no emailInUse.
  const svc = new BusinessService({ repo, config, now, policy: fakePolicy(), accounts: { isPlatformAdmin: async u => !!u && u.id === admin.user.id } });
  const ada = { id: id('usr'), name: 'Ada Owner', email: 'ada@example.com' };
  const bo = { id: id('usr'), name: 'Bo Builder', email: 'bo@example.com' };
  const { org, member } = await svc.createCompany({ user: ada }, FORM);
  assert.equal(member.role, 'owner');
  const ownerActor = { org: { id: org.id }, user: ada };
  const { token } = await svc.invite(ownerActor, { email: 'bo@example.com', role: 'employee' });
  assert.equal((await svc.inviteByToken({ user: null }, token)).state, 'pending_company', 'a pending company needs no account lookup');
  await svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev });
  assert.equal((await svc.inviteByToken({ user: bo }, token)).state, 'accept');
  // Signed out on a confirmed company the landing is 'join' and needs no account lookup (this accounts has no emailInUse).
  assert.equal((await svc.inviteByToken({ user: null }, token)).state, 'join');
  await svc.acceptInvite({ user: bo }, token);
  assert.deepEqual((await svc.listCompaniesFor({ user: bo })).map(c => c.id), [org.id]);
  const view = await svc.listMembers(ownerActor);
  assert.equal(view.members.length, 2);
  const dep = await svc.saveDepartment(ownerActor, { name: 'Engineering' });
  const bm = await svc.membership({ user: bo }, org.id);
  await svc.updateMember(ownerActor, bo.id, { departmentId: dep.id, rev: bm.rev });
  await svc.saveSettings(ownerActor, { approvalHours: '36', rev: (await svc.getOrg(ownerActor)).rev });
  await svc.exportCompany(ownerActor);
  await svc.listAudit(ownerActor);
  await svc.platformListOrgs(admin);
  await svc.removeMember(ownerActor, bo.id, { rev: bm.rev + 1 });
  assert.deepEqual([...read], [KINDS.invite], 'every other read is scoped (getIn, list, page)');
});

// ---------------------------------------------------------------------------------------------------
// Review round 1

test('an invite carries its inviter\'s authority only while they still hold it: removed or demoted inviters\' invites answer 410, also when the demotion races the accept', async t => {
  const { app, svc, repo, company, join, member, org } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);

  // A removed Travel Admin's Travel Admin invite to a second address.
  const tara = await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin', email: 'tara@acme.com' });
  const taraAlt = await svc.invite(tara.actor, { email: 'tara.home@example.com', role: 'travel_admin' });
  assert.equal((await svc.listMembers(acme.owner)).invites.length, 1);
  await svc.removeMember(acme.owner, tara.user.id, { rev: tara.member.rev });
  const home = await seedUser(app, { name: 'Tara Home', email: 'tara.home@example.com' });
  await rejectsWith(svc.inviteByToken({ user: null }, taraAlt.token), 410, 'invite_gone');
  await rejectsWith(svc.inviteByToken({ user: home.user }, taraAlt.token), 410, 'invite_gone');
  await rejectsWith(svc.acceptInvite({ user: home.user }, taraAlt.token), 410, 'invite_gone');
  assert.deepEqual((await svc.listMembers(acme.owner)).invites, [], 'the People page no longer lists it');

  // An Owner demoted to Employee: the Owner invite she made no longer makes an Owner.
  const mallory = await join(acme, acme.owner, 'owner', { name: 'Mallory', email: 'mallory@acme.com' });
  const alt = await svc.invite(mallory.actor, { email: 'mallory.alt@example.com', role: 'owner' });
  await svc.updateMember(acme.owner, mallory.user.id, { role: 'employee', rev: mallory.member.rev });
  const malt = await seedUser(app, { name: 'Mallory Alt', email: 'mallory.alt@example.com' });
  await rejectsWith(svc.acceptInvite({ user: malt.user }, alt.token), 410, 'invite_gone');
  assert.deepEqual((await org(acme.id)).ownerIds, [olivia.user.id]);
  assert.equal(await svc.membership({ user: malt.user }, acme.id), null);

  // A Travel Admin demoted to Employee: her earlier Travel Admin invite is gone; a Manager invite from a
  // current Travel Admin still works.
  const tess = await join(acme, acme.owner, 'travel_admin', { name: 'Tess Admin' });
  const friend = await svc.invite(tess.actor, { email: 'friend@example.com', role: 'travel_admin' });
  const mate = await svc.invite(tess.actor, { email: 'mate@example.com', role: 'manager' });
  const tessNow = await member(acme.id, tess.user.id);
  const fr = await seedUser(app, { name: 'Friend', email: 'friend@example.com' });
  const mt = await seedUser(app, { name: 'Mate', email: 'mate@example.com' });
  assert.equal((await svc.acceptInvite({ user: mt.user }, mate.token)).member.role, 'manager');
  await svc.updateMember(acme.owner, tess.user.id, { role: 'employee', rev: tessNow.rev });
  await rejectsWith(svc.acceptInvite({ user: fr.user }, friend.token), 410, 'invite_gone');

  // The race: the inviter loses the role after the accept read it and before its commit lands. The accept
  // checks the inviter's record in the same commit, so it reads again and answers 410.
  const tom = await join(acme, acme.owner, 'travel_admin', { name: 'Tom Admin' });
  const late = await svc.invite(tom.actor, { email: 'late@example.com', role: 'travel_admin' });
  const lateUser = await seedUser(app, { name: 'Late', email: 'late@example.com' });
  const orig = repo.commit.bind(repo);
  let fired = 0;
  repo.commit = async spec => {
    if (!fired && spec.inserts.some(i => i.data && i.data.action === 'member.joined')) {
      fired += 1;
      await repo.cas(KINDS.member, `${acme.id}.${tom.user.id}`, null, d => { d.role = 'employee'; });
    }
    return orig(spec);
  };
  try {
    await rejectsWith(svc.acceptInvite({ user: lateUser.user }, late.token), 410, 'invite_gone');
  } finally {
    repo.commit = orig;
  }
  assert.equal(fired, 1);
  assert.equal(await svc.membership({ user: lateUser.user }, acme.id), null);
});

test('a Travel Admin cannot cancel an Owner\'s Finance invite by inviting the same email again', async t => {
  const { app, svc, repo, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const tara = await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin' });
  const fin = await svc.invite(acme.owner, { email: 'cfo@acme.com', role: 'finance' });
  await rejectsWith(svc.revokeInvite(tara.actor, fin.invite.publicId), 403, 'forbidden');
  await rejectsWith(svc.invite(tara.actor, { email: 'cfo@acme.com', role: 'travel_admin' }), 403, 'forbidden');
  const stored = await repo.get(KINDS.invite, crypto.createHash('sha256').update(fin.token).digest('hex'));
  assert.equal(stored.revokedAt, null, 'the Owner\'s invite is untouched');
  const cfo = await seedUser(app, { name: 'Casey CFO', email: 'cfo@acme.com' });
  assert.equal((await svc.acceptInvite({ user: cfo.user }, fin.token)).member.role, 'finance');
  // An Owner may still replace an Owner's invite, and a Travel Admin may replace one she could grant.
  const emp = await svc.invite(acme.owner, { email: 'pat@acme.com', role: 'employee' });
  assert.equal((await svc.invite(tara.actor, { email: 'pat@acme.com', role: 'manager' })).replaced, true);
  await rejectsWith(svc.inviteByToken({ user: null }, emp.token), 410, 'invite_gone');
  const own = await svc.invite(acme.owner, { email: 'dee@acme.com', role: 'owner' });
  assert.equal((await svc.invite(acme.owner, { email: 'dee@acme.com', role: 'employee' })).replaced, true);
  await rejectsWith(svc.inviteByToken({ user: null }, own.token), 410, 'invite_gone');
});

test('unrelated joins and removals at the same moment all land: 8 accepts, then 8 removals, with the count kept right', async t => {
  const { app, svc, company, org, audits } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const people = [];
  for (let i = 0; i < 8; i += 1) {
    const u = await seedUser(app, { name: `Joiner ${i}` });
    people.push({ u, token: (await svc.invite(acme.owner, { email: u.user.email, role: i % 2 ? 'owner' : 'employee' })).token });
  }
  const joined = await Promise.allSettled(people.map(p => svc.acceptInvite({ user: p.u.user }, p.token)));
  assert.deepEqual(joined.filter(r => r.status === 'rejected').map(r => `${r.reason.status} ${r.reason.code}`), []);
  let o = await org(acme.id);
  assert.equal(o.memberCount, 9);
  assert.equal(o.ownerIds.length, 5);
  assert.equal((await audits(acme.id)).filter(e => e.action === 'member.joined').length, 8);

  const employees = joined.map(r => r.value.member).filter(m => m.role === 'employee');
  const removed = await Promise.allSettled(employees.map(m => svc.removeMember(acme.owner, m.userId, { rev: m.rev })));
  assert.deepEqual(removed.filter(r => r.status === 'rejected').map(r => `${r.reason.status} ${r.reason.code}`), []);
  o = await org(acme.id);
  assert.equal(o.memberCount, 5);
  assert.equal(o.ownerIds.length, 5);
});

test('departments: racing creates keep names unique and the cap at 200, so General stays on every list', async t => {
  const { app, svc, repo, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const tara = await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin' });
  const two = await Promise.allSettled([svc.saveDepartment(acme.owner, { name: 'Sales' }), svc.saveDepartment(tara.actor, { name: 'sales' })]);
  assert.equal(two.filter(r => r.status === 'fulfilled').length, 1);
  const lost = two.find(r => r.status === 'rejected').reason;
  assert.deepEqual([lost.status, lost.code], [409, 'department_exists']);
  // Renames racing a create to the same name: one name only.
  const ops = await Promise.allSettled([
    svc.saveDepartment(acme.owner, { name: 'Marketing' }),
    (async () => { const d = (await svc.listDepartments(acme.owner)).find(x => /^sales$/i.test(x.name)); return svc.saveDepartment(tara.actor, { departmentId: d.id, name: 'marketing', rev: d.rev }); })(),
  ]);
  assert.equal(ops.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await svc.listDepartments(acme.owner)).filter(d => /^marketing$/i.test(d.name)).length, 1);

  // Fill to 199, then 4 creates at once: exactly one lands.
  const have = (await repo.list(KINDS.department, acme.id)).length;
  const fill = Array.from({ length: 199 - have }, (_, i) => {
    const depId = id('dep');
    return { kind: KINDS.department, id: depId, data: { id: depId, orgId: acme.id, name: `Team ${i}`, archivedAt: null, at: FIXED_NOW, updatedAt: FIXED_NOW, rev: 0 }, owner: acme.id };
  });
  await repo.commit({ inserts: fill });
  const four = await Promise.allSettled([0, 1, 2, 3].map(i => svc.saveDepartment(i % 2 ? tara.actor : acme.owner, { name: `Last ${i}` })));
  assert.equal(four.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of four.filter(x => x.status === 'rejected')) assert.deepEqual([r.reason.code, r.reason.details.name], ['invalid_department', 'A company can have up to 200 departments.']);
  const all = await svc.listDepartments(acme.owner);
  assert.equal(all.length, 200);
  assert.ok(all.some(d => d.name === 'General'));
  assert.equal(recordsOf(app, KINDS.department).filter(d => d.orgId === acme.id).length, 200);
});

test('a removed member re-invited in the same millisecond lands on "accept" and can accept', async t => {
  const { app, svc, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const lee = await join(acme, acme.owner, 'employee', { name: 'Lee Leaver', email: 'lee@example.com' });
  await svc.removeMember(acme.owner, lee.user.id, { rev: lee.member.rev });
  const back = await svc.invite(acme.owner, { email: 'lee@example.com', role: 'employee' });
  assert.equal((await svc.inviteByToken({ user: lee.user }, back.token)).state, 'accept');
  const { member } = await svc.acceptInvite({ user: lee.user }, back.token);
  assert.deepEqual([member.status, member.removedAt], ['active', null]);
});

test('platform: a company Tripelyx never confirmed is "confirmed" when it first becomes active, even after a pause', async t => {
  const { app, svc, admin, company, audits } = await setup();
  t.after(app.close);
  const pia = await seedUser(app, { name: 'Pia Pending' });
  const pend = await company(pia, { name: 'Pending Co', confirm: false });
  let o = await svc.platformSetStatus(admin, pend.id, { status: 'suspended', note: 'Waiting for details', rev: pend.org.rev });
  o = await svc.platformSetStatus(admin, pend.id, { status: 'active', rev: o.rev });
  assert.deepEqual((await audits(pend.id)).map(e => e.action), ['org.confirmed', 'org.suspended', 'org.created']);
  assert.equal((await audits(pend.id))[0].summary, 'Tripelyx confirmed Pending Co');
  // Once confirmed, a pause and its end are a reactivation.
  o = await svc.platformSetStatus(admin, pend.id, { status: 'suspended', note: 'A check', rev: o.rev });
  await svc.platformSetStatus(admin, pend.id, { status: 'active', rev: o.rev });
  assert.equal((await audits(pend.id))[0].action, 'org.reactivated');
});

test('platform: the service asks accounts who is a platform admin; a made-up user, a flag on a normal account or a revoked admin get 404', async t => {
  const { app, svc, admin } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const { org } = await svc.createCompany({ user: olivia.user }, FORM);
  const forged = { user: { id: 'usr_AAAAAAAAAAAAAAAA', isAdmin: true, name: 'Nobody' } };
  const eve = await seedUser(app, { name: 'Eve', email: 'eve@example.com' });
  const flagged = { user: { ...eve.user, isAdmin: true } };
  for (const who of [forged, flagged]) {
    await rejectsWith(svc.platformListOrgs(who), 404, 'not_found');
    await rejectsWith(svc.platformSetStatus(who, org.id, { status: 'active', rev: org.rev }), 404, 'not_found');
  }
  const real = app.accounts.isPlatformAdmin;
  app.accounts.isPlatformAdmin = async () => false; // revoked since the page loaded
  try {
    await rejectsWith(svc.platformListOrgs(admin), 404, 'not_found');
    await rejectsWith(svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev }), 404, 'not_found');
  } finally {
    app.accounts.isPlatformAdmin = real;
  }
  assert.equal((await app.business.repo.getIn(KINDS.org, org.id, org.id)).status, 'pending');
  assert.equal((await svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev })).status, 'active');
});

test('the company never sees who at Tripelyx changed its status or the internal note: getOrg, the export and the activity log', async t => {
  const { app, svc, admin, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const emp = await join(acme, acme.owner, 'employee', { name: 'Eli Employee' });
  let o = await svc.getOrg(acme.owner);
  o = await svc.platformSetStatus(admin, acme.id, { status: 'suspended', note: 'Fraud flag from ops review', rev: o.rev });
  o = await svc.platformSetStatus(admin, acme.id, { status: 'active', note: 'Cleared after a call', rev: o.rev });
  assert.equal(o.statusNote, 'Cleared after a call', 'the platform admin keeps the note');
  const seen = await svc.getOrg(emp.actor);
  assert.deepEqual([seen.status, seen.statusAt, seen.statusBy, seen.statusNote], ['active', FIXED_NOW, null, null]);
  const out = (await svc.exportCompany(acme.owner)).json;
  for (const secret of ['Cleared after a call', 'Fraud flag', 'Pat Platform']) assert.ok(!out.includes(secret), secret);
  assert.equal(JSON.parse(out).org.statusBy, null);
  const log = await svc.listAudit(acme.owner, { group: 'org' });
  assert.ok(log.rows.filter(e => e.actor.platformAdmin).every(e => e.actor.name === 'Tripelyx'));
  assert.ok(!JSON.stringify(log.rows).includes('Pat Platform'));
});

test('settings: a stale form answers 409 before any permission check, and changes outside the settings do not make the form stale', async t => {
  const { app, svc, company, join } = await setup();
  t.after(app.close);
  const olivia = await seedUser(app, { name: 'Olivia Owner' });
  const acme = await company(olivia);
  const tara = await join(acme, acme.owner, 'travel_admin', { name: 'Tara Admin' });
  // Tara loads the form; Olivia changes the time zone; Tara posts the whole form as she saw it.
  const seen = await svc.getOrg(tara.actor);
  await svc.saveSettings(acme.owner, { timezone: 'Europe/London', rev: seen.rev });
  const full = { name: seen.name, timezone: seen.timezone, approvalHours: '48', outOfPolicy: 'approval', budgetPeriod: 'quarter', rev: seen.rev };
  await rejectsWith(svc.saveSettings(tara.actor, full), 409, 'conflict');
  assert.equal((await svc.getOrg(acme.owner)).timezone, 'Europe/London', 'nothing was overwritten');
  // Someone joins between loading and saving: the settings form is still current.
  const form = await svc.getOrg(acme.owner);
  await join(acme, acme.owner, 'employee', { name: 'Newbie' });
  const saved = await svc.saveSettings(acme.owner, { approvalHours: '36', rev: form.rev });
  assert.equal(saved.settings.approvalHours, 36);
  assert.equal(saved.timezone, 'Europe/London');
  // ...but a settings change in between still makes it stale, and a rev from the future is refused too.
  await rejectsWith(svc.saveSettings(tara.actor, { approvalHours: '40', rev: form.rev }), 409, 'conflict');
  await rejectsWith(svc.saveSettings(tara.actor, { approvalHours: '40', rev: saved.rev + 5 }), 409, 'conflict');
  assert.equal((await svc.saveSettings(tara.actor, { approvalHours: '40', rev: saved.rev })).settings.approvalHours, 40);
});

test('settings: a confirmed company that takes a new name goes back to Tripelyx before anyone else joins; spelling-only changes and self-serve keep it active', async t => {
  const { app, svc, admin, company, join, audits } = await setup();
  t.after(app.close);
  const eve = await seedUser(app, { name: 'Eve' });
  const co = await company(eve, { name: 'Eve Test Co' });
  let o = await svc.saveSettings(co.owner, { name: 'EVE test co.', rev: co.org.rev });
  assert.equal(o.status, 'active', 'case, spacing and punctuation keep the confirmation');
  const { token } = await svc.invite(co.owner, { email: 'victim@globex.example', role: 'employee' });
  o = await svc.saveSettings(co.owner, { name: 'Globex Corporation', rev: o.rev });
  assert.equal(o.status, 'pending');
  assert.equal((await svc.inviteByToken({ user: null }, token)).state, 'pending_company');
  const victim = await seedUser(app, { name: 'Vic', email: 'victim@globex.example' });
  await rejectsWith(svc.acceptInvite({ user: victim.user }, token), 409, 'company_pending');
  // Members keep working while Tripelyx looks.
  const sam = await join(co, co.owner, 'employee', { name: 'Sam' }).catch(e => e);
  assert.equal(sam.code, 'company_pending');
  assert.equal((await svc.listMembers(co.owner)).memberCount, 1);
  const row = (await svc.platformListOrgs(admin)).orgs.find(r => r.id === co.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.previousName, 'EVE test co.', 'the name Tripelyx confirmed, for "Renamed from"');
  assert.ok(!Object.hasOwn(await svc.getOrg(co.owner), 'previousName'), "members' views leave it out");
  assert.ok(!Object.hasOwn(o, 'previousName'));
  // A second rename while it waits keeps the confirmed name.
  o = await svc.saveSettings(co.owner, { name: 'Globex Corporation Two', rev: o.rev });
  assert.equal((await svc.platformListOrgs(admin)).orgs.find(r => r.id === co.id).previousName, 'EVE test co.');
  await svc.platformSetStatus(admin, co.id, { status: 'active', rev: o.rev });
  assert.equal((await audits(co.id))[0].action, 'org.confirmed');
  await svc.acceptInvite({ user: victim.user }, token);

  // With self-serve on, nobody confirms companies, so a rename keeps it active.
  const app2 = await startApp({ ENABLE_BUSINESS: 'true', BUSINESS_SELF_SERVE: 'true' }, { now: () => new Date(FIXED_NOW) });
  t.after(app2.close);
  const u2 = await seedUser(app2);
  const made = await app2.business.createCompany({ user: u2.user }, FORM);
  const renamed = await app2.business.saveSettings({ org: { id: made.org.id }, user: u2.user }, { name: 'Another Name', rev: made.org.rev });
  assert.equal(renamed.status, 'active');
});

test('company names that read as "Tripelyx" with look-alike letters or digits are refused; ordinary names pass', async t => {
  const { app, svc, company } = await setup({ env: { BUSINESS_MAX_ORGS_PER_USER: '10' } });
  t.after(app.close);
  const u = await seedUser(app);
  const lookAlikes = [
    'Тripelyx Support', 'Tripеlyx Travel', 'Trіpelyx', 'TRIРELYX', 'Tripelух', 'Tr1pelyx Business', 'Tripe1yx', 'TRIP3LYX', 'Trip|elyx',
    'ᴛʀɪᴘᴇʟʏx', 'Τripelyx', 'Tripelyχ', 'Tripeӏyx',
  ];
  for (const name of lookAlikes) {
    await assert.rejects(svc.createCompany({ user: u.user }, { ...FORM, name }),
      e => e.status === 422 && e.code === 'invalid_company' && e.details.name === "Choose your own company's name.", name);
  }
  for (const name of ['Triple X Logistics', 'Stripe Lynx', 'Trip Lux', 'Pelyx Tri']) {
    assert.equal((await svc.createCompany({ user: u.user }, { ...FORM, name })).org.name, name);
  }
  const co = await company(u, { name: 'Plain Co' });
  await assert.rejects(svc.saveSettings(co.owner, { name: 'Тripelyx', rev: co.org.rev }), e => e.code === 'invalid_settings' && e.details.name === "Choose your own company's name.");
});
