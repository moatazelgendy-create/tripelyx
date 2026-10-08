// Shared helpers for the Tripelyx Business tests (not a test file itself: it doesn't match *.test.js).
// Seeding goes straight to the store, so tests spend no rate limit (signin shares the 40-per-10-minute
// writeLimiter) and need no BusinessService method that a later stage owns.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Repo } = require('../server/business/repo');
const { KINDS, DEFAULT_COLORS } = require('../server/business/constants');
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

/**
 * Seed an agency straight into the store, with the records BusinessService.createOrg writes (plan §D):
 * biz_org, biz_brand (default colors, no logo), biz_rules (all zero), the creator's biz_member (Owner)
 * and biz_user_org. Every `at` comes from app.ctx.now().
 * @param {object} app from startApp()
 * @param {{ user: object }} owner from seedUser()
 * @param {{ status?: 'pending'|'active'|'suspended', name?: string, email?: string }} [opts]
 * @returns {Promise<{ id: string, org: object, repo: Repo }>}
 */
async function seedOrg(app, owner, { status = 'active', name = 'Sunny Days Travel', email = 'hello@sunnydays.example' } = {}) {
  const repo = new Repo({ store: app.store, now: app.ctx.now });
  const at = repo.iso();
  const orgId = id('org');
  const org = { id: orgId, name, status, createdBy: owner.user.id, at, updatedAt: at, statusBy: null, statusAt: null, rev: 0 };
  assert.ok(await repo.insert(KINDS.org, orgId, org));
  assert.ok(await repo.insert(KINDS.brand, orgId, {
    orgId, displayName: name, email, phone: '', website: '', primary: DEFAULT_COLORS.primary, accent: DEFAULT_COLORS.accent,
    logo: null, rev: 0, updatedAt: at, updatedBy: owner.user.id,
  }, { owner: orgId }));
  assert.ok(await repo.insert(KINDS.rules, orgId, {
    orgId, serviceFee: 0, perBookingFee: 0, markupTenths: 0, maxServiceFee: null, minProfit: 0, minMarginTenths: 0, maxDiscount: 0,
    rev: 0, updatedAt: at, updatedBy: owner.user.id,
  }, { owner: orgId }));
  await linkMember(repo, orgId, owner.user, 'owner', owner.user.id);
  return { id: orgId, org, repo };
}

async function linkMember(repo, orgId, user, role, by) {
  const at = repo.iso();
  const member = { orgId, userId: user.id, email: user.email, name: user.name, role, at, by, rev: 0 };
  assert.ok(await repo.insert(KINDS.member, `${orgId}.${user.id}`, member, { owner: orgId }));
  assert.ok(await repo.insert(KINDS.userOrg, `${user.id}.${orgId}`, { userId: user.id, orgId, at }, { owner: user.id }));
  return member;
}

/**
 * Seed a new account and make it a member of the org with this role (biz_member + biz_user_org).
 * @param {object} app
 * @param {{ id: string }} org from seedOrg()
 * @param {'owner'|'manager'|'advisor'|'support'|'finance'|'readonly'} role
 * @param {{ name?: string, email?: string }} [who]
 * @returns {Promise<{ user: object, token: string, cookie: string, member: object }>}
 */
async function addMember(app, org, role, who = {}) {
  const u = await seedUser(app, who);
  const repo = new Repo({ store: app.store, now: app.ctx.now });
  const member = await linkMember(repo, org.id, u.user, role, org.org ? org.org.createdBy : null);
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

module.exports = { seedUser, client, seedOrg, addMember, mutableClock, noInline, storeSnapshot, PASSWORD };
