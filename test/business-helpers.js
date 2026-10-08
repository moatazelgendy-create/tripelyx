// Shared helpers for the Tripelyx Business tests (not a test file itself: it doesn't match *.test.js).
// Seeding goes through a Repo straight to the store, so tests spend no rate limit (signin shares the
// 40-per-10-minute writeLimiter) and need no BusinessService method that a later stage owns.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Repo } = require('../server/business/repo');
const { KINDS, DEFAULT_TIMEZONE, TIERS, GENERAL_DEPARTMENT, ID_PREFIX } = require('../server/business/constants');
const { auditInsert } = require('../server/business/actor');
const { defaultPolicy, DEFAULTS_NOTE } = require('../server/business/policy/defaults');
const { id } = require('../server/lib/ids');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const PASSWORD = 'correct horse battery staple';
let seq = 0;

/**
 * Register an account (app.accounts.register) and put a session for it straight into the store.
 * The session never expires within the tests (clock moves included).
 * @param {object} app from startApp()
 * @param {{ name?: string, email?: string }} [who]
 * @returns {Promise<{ user: object, token: string, cookie: string }>} cookie is `txs=<token>`
 */
async function seedUser(app, { name, email } = {}) {
  seq += 1;
  const user = await app.accounts.register({
    name: name || `Test User${seq}`,
    email: email || `user${seq}.${crypto.randomBytes(3).toString('hex')}@example.com`,
    password: PASSWORD,
  });
  const token = crypto.randomBytes(32).toString('base64url');
  await app.store.putRecord('session', sha256(token), { userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' }, { userId: user.id });
  return { user, token, cookie: `txs=${token}` };
}

/**
 * A fetch client that always sends `sec-fetch-site: same-origin` (unless overridden), never follows
 * redirects, and sends the given session cookie.
 * @param {string} base app.base
 * @param {string} [cookie] e.g. seedUser(...).cookie
 * @returns {{ get: Function, post: Function, raw: Function, req: Function }}
 *   each resolves to { status, location, headers, text }
 */
function client(base, cookie = '') {
  const req = async (path, { method = 'GET', form, body, type, headers = {} } = {}) => {
    const h = { 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...headers };
    let payload = body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (type) h['content-type'] = type;
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  };
  return {
    req,
    get: (path, opts = {}) => req(path, opts),
    post: (path, form = {}, opts = {}) => req(path, { ...opts, method: 'POST', form }),
    raw: (path, body, type, opts = {}) => req(path, { ...opts, method: 'POST', body, type }),
  };
}

/** A Repo on the app's store and clock. */
const repoFor = app => new Repo({ store: app.store, now: app.ctx.now });

/** The commit entry that adds orgId to a user's company index (insert, or cas when it exists). */
async function indexOp(repo, userId, orgId) {
  const cur = await repo.get(KINDS.userIndex, userId);
  if (!cur) return { insert: { kind: KINDS.userIndex, id: userId, data: { userId, orgIds: [orgId], rev: 0 }, owner: userId } };
  return { cas: { kind: KINDS.userIndex, id: userId, rev: null, fn: d => { if (!d.orgIds.includes(orgId)) d.orgIds.push(orgId); } } };
}

/** A biz_member document in the §C3 shape. */
function memberDoc(orgId, user, role, by, at, extra = {}) {
  return {
    orgId, userId: user.id, email: user.email, name: user.name, role, status: 'active', departmentId: null, managerId: null,
    approverId: null, tier: 'standard', at, by, removedAt: null, rev: 0, ...extra,
  };
}

/** The owner's ActorRef (types.ActorRef) for records and audit entries a seed writes. */
const ownerRef = owner => ({ userId: owner.user.id, name: owner.user.name, role: 'owner' });

/**
 * Seed a company straight into the store in one Repo.commit, with the shapes team.createCompany writes
 * (types.js §2): biz_org (memberCount 1, ownerIds [owner]), the "General" biz_department, the owner's
 * biz_member (in General, tier standard), the owner's biz_user_index (insert, or CAS adding the id), the
 * three biz_policy records at version 1 from policy/defaults.js with their biz_policy_version v1 (note
 * DEFAULTS_NOTE, no changes), and the 'org.created' audit entry. Every `at` comes from app.ctx.now().
 * @param {object} app from startApp()
 * @param {{ user: object }} owner from seedUser()
 * @param {{ status?: 'pending'|'active'|'suspended', name?: string, timezone?: string,
 *   settings?: Partial<import('../server/business/types').OrgSettings> }} [opts]
 * @returns {Promise<{ id: string, org: object, repo: Repo, general: object, owner: object }>}
 *   general: the General department; owner: the owner's biz_member
 */
async function seedOrg(app, owner, { status = 'active', name = 'Acme Inc', timezone = DEFAULT_TIMEZONE, settings = {} } = {}) {
  const repo = repoFor(app);
  const at = repo.iso();
  const orgId = id(ID_PREFIX.org);
  const depId = id(ID_PREFIX.department);
  const by = ownerRef(owner);
  const org = {
    id: orgId, name, nameKey: name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''), status, size: '1-10 people',
    currency: 'USD', timezone,
    settings: { outOfPolicy: 'approval', approvalHours: 24, reasonMinChars: 10, budgetPeriod: 'quarter', ...settings },
    ownerIds: [owner.user.id], memberCount: 1, createdBy: owner.user.id, at, updatedAt: at, statusBy: null, statusAt: null,
    statusNote: null, rev: 0,
  };
  const general = { id: depId, orgId, name: GENERAL_DEPARTMENT, archivedAt: null, at, updatedAt: at, rev: 0 };
  const policyInserts = TIERS.flatMap(tier => {
    const rules = defaultPolicy(tier);
    return [
      { kind: KINDS.policy, id: `${orgId}.${tier}`, data: { orgId, tier, version: 1, rules, updatedAt: at, updatedBy: by, rev: 0 }, owner: orgId },
      { kind: KINDS.policyVersion, id: `${orgId}.${tier}.v1`, data: { orgId, tier, version: 1, rules, at, by, note: DEFAULTS_NOTE, changes: [] }, owner: orgId },
    ];
  });
  const idx = await indexOp(repo, owner.user.id, orgId);
  await repo.commit({
    inserts: [
      { kind: KINDS.org, id: orgId, data: org, owner: null },
      { kind: KINDS.department, id: depId, data: general, owner: orgId },
      { kind: KINDS.member, id: `${orgId}.${owner.user.id}`, data: memberDoc(orgId, owner.user, 'owner', null, at, { departmentId: depId }), owner: orgId },
      ...(idx.insert ? [idx.insert] : []),
      ...policyInserts,
      auditInsert(repo, { orgId, actor: by, action: 'org.created', target: { kind: KINDS.org, id: orgId }, summary: `${owner.user.name} created ${name}` }),
    ],
    cas: idx.cas ? [idx.cas] : [],
  });
  return {
    id: orgId,
    org: await repo.get(KINDS.org, orgId),
    repo,
    general: await repo.get(KINDS.department, depId),
    owner: await repo.get(KINDS.member, `${orgId}.${owner.user.id}`),
  };
}

/** The company creator's ActorRef, read from their member record (the actor of seeded admin changes). */
async function creatorRef(repo, org) {
  const m = await repo.get(KINDS.member, `${org.id}.${org.org.createdBy}`);
  return { userId: m.userId, name: m.name, role: m.role };
}

/**
 * Seed a department (and its 'department.created' audit, plus 'department.archived' when archived) in one
 * Repo.commit, as team.saveDepartment writes it.
 * @param {object} app
 * @param {{ id: string, org: object }} org from seedOrg()
 * @param {{ name?: string, archived?: boolean }} [opts]
 * @returns {Promise<object>} the stored biz_department
 */
async function seedDepartment(app, org, { name = 'Engineering', archived = false } = {}) {
  const repo = repoFor(app);
  const at = repo.iso();
  const depId = id(ID_PREFIX.department);
  const by = await creatorRef(repo, org);
  const target = { kind: KINDS.department, id: depId };
  await repo.commit({
    inserts: [
      { kind: KINDS.department, id: depId, data: { id: depId, orgId: org.id, name, archivedAt: archived ? at : null, at, updatedAt: at, rev: 0 }, owner: org.id },
      auditInsert(repo, { orgId: org.id, actor: by, action: 'department.created', target, summary: `Created the ${name} department` }),
      ...(archived ? [auditInsert(repo, { orgId: org.id, actor: by, action: 'department.archived', target, summary: `Archived the ${name} department` })] : []),
    ],
  });
  return repo.get(KINDS.department, depId);
}

/**
 * Seed a department's budget for a period, with holds already committed, and its 'budget.set' audit, in
 * one Repo.commit (types.Budget).
 * @param {object} app
 * @param {{ id: string, org: object }} org from seedOrg()
 * @param {string} departmentId
 * @param {{ periodKey?: string, amountCents?: number, commits?: Record<string, number> }} [opts]
 * @returns {Promise<object>} the stored biz_budget
 */
async function seedBudget(app, org, departmentId, { periodKey = '2026-Q4', amountCents = 1000000, commits = {} } = {}) {
  const repo = repoFor(app);
  const at = repo.iso();
  const budgetId = `${org.id}.${departmentId}.${periodKey}`;
  const by = await creatorRef(repo, org);
  await repo.commit({
    inserts: [
      {
        kind: KINDS.budget, id: budgetId, owner: org.id,
        data: { orgId: org.id, departmentId, periodKey, amountCents, currency: 'USD', commits: { ...commits }, at, updatedAt: at, updatedBy: by, rev: 0 },
      },
      auditInsert(repo, { orgId: org.id, actor: by, action: 'budget.set', target: { kind: KINDS.budget, id: budgetId }, summary: `Set the ${periodKey} budget`,
        changes: [{ path: 'amountCents', before: null, after: amountCents }] }),
    ],
  });
  return repo.get(KINDS.budget, budgetId);
}

/**
 * Seed a new account and make it a member of the company with this role, in one Repo.commit: its
 * biz_member, the org's memberCount (and ownerIds for an owner) and its biz_user_index.
 * @param {object} app
 * @param {{ id: string, org?: object }} org from seedOrg()
 * @param {'owner'|'travel_admin'|'finance'|'manager'|'employee'} role
 * @param {{ name?: string, email?: string, departmentId?: string|null, managerId?: string|null,
 *   approverId?: string|null, tier?: 'standard'|'director'|'executive' }} [who]
 * @returns {Promise<{ user: object, token: string, cookie: string, member: object }>}
 */
async function seedMember(app, org, role, { name, email, ...extra } = {}) {
  const u = await seedUser(app, { name, email });
  const repo = repoFor(app);
  const at = repo.iso();
  const member = memberDoc(org.id, u.user, role, org.org ? org.org.createdBy : null, at, extra);
  const idx = await indexOp(repo, u.user.id, org.id);
  await repo.commit({
    inserts: [{ kind: KINDS.member, id: `${org.id}.${u.user.id}`, data: member, owner: org.id }, ...(idx.insert ? [idx.insert] : [])],
    cas: [
      { kind: KINDS.org, id: org.id, rev: null, fn: d => { d.memberCount += 1; if (role === 'owner') d.ownerIds.push(u.user.id); } },
      ...(idx.cas ? [idx.cas] : []),
    ],
  });
  return { ...u, member };
}

/**
 * A clock that stays still until moved: pass `now` to startApp(env, { now }).
 * @param {string} iso starting moment, e.g. FIXED_NOW
 * @returns {{ now: () => Date, advance: (days: number) => void, set: (iso: string) => void }}
 */
function mutableClock(iso) {
  let t = Date.parse(iso);
  return {
    now: () => new Date(t),
    advance(days) { t += days * 86400000; },
    set(next) { t = Date.parse(next); },
  };
}

/**
 * The CSP check from http.test.js: no style="" attributes and no inline scripts (JSON data blocks allowed).
 * @param {string} path for the message
 * @param {string} body page HTML
 */
function noInline(path, body) {
  assert.ok(!/\sstyle="/.test(body), `${path} has an inline style attribute`);
  assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${path} has an inline script`);
}

/**
 * Everything a MemoryStore holds, as one JSON string with stable ordering: compare two snapshots to
 * prove a request wrote nothing. `ignoreKinds` leaves out record kinds a test does not care about.
 * @param {object} app from startApp() (MemoryStore only)
 * @param {{ ignoreKinds?: string[] }} [opts]
 * @returns {string}
 */
function storeSnapshot(app, { ignoreKinds = [] } = {}) {
  const s = app.store;
  assert.equal(s.kind, 'memory', 'storeSnapshot needs the memory store');
  const map = m => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    records: map(s.records).filter(([, r]) => !ignoreKinds.includes(r.kind)).map(([k, r]) => [k, r.userId, r.data]),
    quotes: map(s.quotes), bookings: map(s.bookings), intents: map(s.intents), leads: s.leads,
  });
}

module.exports = {
  seedUser, client, seedOrg, seedMember, seedDepartment, seedBudget, memberDoc, mutableClock, noInline, storeSnapshot, PASSWORD,
};
