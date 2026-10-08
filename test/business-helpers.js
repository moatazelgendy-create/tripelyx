// Shared helpers for the Tripelyx Business tests (not a test file itself: it doesn't match *.test.js).
// Seeding goes through a Repo straight to the store, so tests spend no rate limit (signin shares the
// 40-per-10-minute writeLimiter) and need no BusinessService method that a later stage owns.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Repo } = require('../server/business/repo');
const { KINDS, DEFAULT_TIMEZONE } = require('../server/business/constants');
const { auditInsert } = require('../server/business/actor');
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

/**
 * Seed a company straight into the store in one Repo.commit, with the §C3 shapes: biz_org (memberCount 1,
 * ownerIds [owner]), the owner's biz_member, the owner's biz_user_index and an org.created audit entry. Every
 * `at` comes from app.ctx.now(). Stage 0 step 13 adds departments, budgets and the policies.
 * @param {object} app from startApp()
 * @param {{ user: object }} owner from seedUser()
 * @param {{ status?: 'pending'|'active'|'suspended', name?: string, timezone?: string }} [opts]
 * @returns {Promise<{ id: string, org: object, repo: Repo }>}
 */
async function seedOrg(app, owner, { status = 'active', name = 'Acme Inc', timezone = DEFAULT_TIMEZONE } = {}) {
  const repo = repoFor(app);
  const at = repo.iso();
  const orgId = id('org');
  const org = {
    id: orgId, name, nameKey: name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''), status, size: '1-10 people',
    currency: 'USD', timezone, settings: { outOfPolicy: 'approval', approvalHours: 24, reasonMinChars: 10, budgetPeriod: 'quarter' },
    ownerIds: [owner.user.id], memberCount: 1, createdBy: owner.user.id, at, updatedAt: at, statusBy: null, statusAt: null,
    statusNote: null, rev: 0,
  };
  const idx = await indexOp(repo, owner.user.id, orgId);
  await repo.commit({
    inserts: [
      { kind: KINDS.org, id: orgId, data: org, owner: null },
      { kind: KINDS.member, id: `${orgId}.${owner.user.id}`, data: memberDoc(orgId, owner.user, 'owner', owner.user.id, at), owner: orgId },
      ...(idx.insert ? [idx.insert] : []),
      auditInsert(repo, { orgId, actor: { userId: owner.user.id, name: owner.user.name, role: 'owner' }, action: 'org.created', target: { kind: KINDS.org, id: orgId }, summary: `Created ${name}` }),
    ],
    cas: idx.cas ? [idx.cas] : [],
  });
  return { id: orgId, org: await repo.get(KINDS.org, orgId), repo };
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

module.exports = { seedUser, client, seedOrg, seedMember, mutableClock, noInline, storeSnapshot, PASSWORD };
