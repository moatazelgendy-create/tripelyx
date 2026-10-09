// Shared security fixes (plan §I1-I4, §I9): D1 platform admins (ADMIN_EMAILS plus a platform_admin record,
// the boot grandfathering and scripts/platform-admin.js), the D2 sign-up race, D10 sign-in redirects,
// sessionsValidAfter, and the lead `kind`. None of them changes a page for anyone who isn't an admin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startApp, quietLog, FIXED_NOW, fixedNow } = require('./helpers');
const { seedUser, seedOrg, client, mutableClock, PASSWORD } = require('./business-helpers');
const { loadConfig } = require('../server/config');
const { MemoryStore, PostgresStore } = require('../server/booking');
const { Accounts, PLATFORM_ADMIN, ADMIN_SEED_BEFORE, ADMIN_SEED, ADMIN_SEED_ID, maskEmail, seedPending, quoteName } = require('../server/accounts');
const { localPath, validatePartnerLead } = require('../server/lib/validate');
const { Repo } = require('../server/business/repo');
const { KINDS } = require('../server/business/constants');
const cli = require('../scripts/platform-admin');
const { ACCOUNT_LIMIT } = require('../server/business/limits');

const pgUrl = process.env.TEST_DATABASE_URL;
const sfx = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const headerOf = page => (page.match(/<header class="site-header[\s\S]*?<\/header>/) || [''])[0];
const sessionCookie = res => {
  const m = String(res.headers.get('set-cookie') || '').match(/txs=[A-Za-z0-9_-]+/);
  assert.ok(m, 'a session cookie was set');
  return m[0];
};
const TAKEN = 'An account with this email already exists. Sign in instead.';
/** Accounts on a store with a clock held at `iso` (register stamps createdAt with it). */
const accountsAt = (store, iso, env = {}) => new Accounts({ store, config: loadConfig(env), now: () => new Date(iso) });
const asReq = cookie => ({ headers: { cookie } });
const ROOT = path.join(__dirname, '..');
/** A session cookie for `user`, written straight to the store (an account that signed in before this boot). */
async function storedSession(store, user) {
  const token = `tok${sfx()}${sfx()}`;
  await store.putRecord('session', crypto.createHash('sha256').update(token).digest('hex'), { userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' }, { userId: user.id });
  return `txs=${token}`;
}
/** Boot an app on `store` with `env`; resolves to { app, admin } with the "[admin]" log lines as [level, text]. */
async function bootOn(t, store, env) {
  const lines = [];
  const log = { ...quietLog, info: m => lines.push(['info', String(m)]), warn: m => lines.push(['warn', String(m)]) };
  const app = await startApp(env, { store, log });
  t.after(app.close);
  return { app, admin: lines.filter(l => l[1].startsWith('[admin]')) };
}

// =============================================================================================================
// D1: platform admins

test('D1: the grandfather cutoff is fixed at 2026-10-08T00:00:00Z with no environment override', async () => {
  assert.equal(ADMIN_SEED_BEFORE, '2026-10-08T00:00:00Z');
  const store = new MemoryStore();
  const env = { ADMIN_EMAILS: 'ops@example.com', ADMIN_SEED_BEFORE: '2030-01-01T00:00:00Z' };
  await accountsAt(store, '2026-10-08T00:00:00.000Z').register({ name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  assert.deepEqual(await accountsAt(store, FIXED_NOW, env).seedPlatformAdmins(), { granted: [], missing: ['o***@example.com'] }, 'an env value moves nothing');
  assert.equal(maskEmail('ops@example.com'), 'o***@example.com');
  assert.equal(maskEmail('x'), '***');
  assert.equal(maskEmail('@example.com'), '***');
});

test('D1: an ADMIN_EMAILS address signed up after boot is not an admin, cannot confirm a company, and becomes one only when granted', async t => {
  const app = await startApp({ ADMIN_EMAILS: 'ops@example.com', ENABLE_BUSINESS: 'true' });
  t.after(app.close);
  const signup = await client(app.base).post('/signup', { name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  assert.equal(signup.status, 303);
  const cookie = sessionCookie(signup);
  const ops = client(app.base, cookie);
  const user = await app.accounts.userFromRequest(asReq(cookie));
  assert.equal(user.email, 'ops@example.com');
  assert.equal(user.isAdmin, false, 'isAdmin:false');
  assert.equal(await app.accounts.isPlatformAdmin(user), false);
  assert.equal(await app.store.getRecord(PLATFORM_ADMIN, user.id), null, 'signing up writes no platform_admin record');
  for (const p of ['/admin', '/admin/bookings', '/admin/settings']) assert.equal((await ops.get(p)).status, 404, p);
  assert.doesNotMatch(headerOf((await ops.get('/plan')).text), /header-admin/, 'no Admin link');

  // It cannot confirm a company: the platform route answers 404 and the company stays pending.
  const owner = await seedUser(app, { name: 'Dana Lee' });
  const org = await seedOrg(app, owner, { status: 'pending' });
  assert.equal((await ops.post(`/admin/business/${org.id}/status`, { status: 'active', note: '', rev: '0' })).status, 404);
  assert.equal((await org.repo.get(KINDS.org, org.id)).status, 'pending');
  // The service gate sees the same isAdmin:false (once team.platformSetStatus is built, it must answer 404).
  const tried = await app.business.platformSetStatus({ user }, org.id, { status: 'active', rev: 0 }).then(() => null, e => e);
  assert.ok(tried, 'platformSetStatus refuses');
  if (!/not built/.test(tried.message)) assert.equal(tried.status, 404);
  assert.equal((await org.repo.get(KINDS.org, org.id)).status, 'pending');

  // Granted: 200, and the Admin link.
  await app.accounts.grantPlatformAdmin(user.id, { by: 'test' });
  assert.equal((await app.accounts.userFromRequest(asReq(cookie))).isAdmin, true);
  for (const p of ['/admin', '/admin/bookings', '/admin/settings']) assert.equal((await ops.get(p)).status, 200, p);
  assert.match(headerOf((await ops.get('/plan')).text), /<a class="text-link header-admin" href="\/admin">Admin<\/a>/);

  // Revoked: 404 again.
  await app.accounts.revokePlatformAdmin(user.id);
  assert.equal((await ops.get('/admin')).status, 404, 'revoked: 404');
  assert.equal((await app.accounts.userFromRequest(asReq(cookie))).isAdmin, false);

  // Granted again, then the email is taken out of ADMIN_EMAILS (a restart with the same database): 404,
  // though the record itself is untouched; listed again, the record counts again.
  await app.accounts.grantPlatformAdmin(user.id, { by: 'test' });
  const unlisted = await startApp({ ENABLE_BUSINESS: 'true' }, { store: app.store });
  t.after(unlisted.close);
  assert.equal((await client(unlisted.base, cookie).get('/admin')).status, 404, 'email removed from the env: 404');
  assert.equal((await unlisted.accounts.userFromRequest(asReq(cookie))).isAdmin, false);
  assert.equal((await app.store.getRecord(PLATFORM_ADMIN, user.id)).revokedAt, null);
  assert.equal((await ops.get('/admin')).status, 200);
});

test('D1: isPlatformAdmin needs the listed email, a record for that user id, the same email on it and no revokedAt', async () => {
  const store = new MemoryStore();
  const accounts = accountsAt(store, FIXED_NOW, { ADMIN_EMAILS: 'ops@example.com,new@example.com' });
  const ops = await accounts.register({ name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  const other = await accounts.register({ name: 'Other Person', email: 'other@example.com', password: PASSWORD });
  assert.equal(await accounts.isPlatformAdmin(ops), false, 'listed, no record');
  await accounts.grantPlatformAdmin(other.id, { by: 'test' });
  assert.equal(await accounts.isPlatformAdmin(other), false, 'a record, but the email is not listed');
  await accounts.grantPlatformAdmin(ops.id, { by: 'test' });
  assert.equal(await accounts.isPlatformAdmin(ops), true);
  assert.equal(await accounts.isPlatformAdmin({ ...ops, email: 'new@example.com' }), false, 'the record is for another email');
  assert.equal(await accounts.isPlatformAdmin({ ...other, id: ops.id }), false, 'another account cannot borrow the record');
  assert.equal(await accounts.isPlatformAdmin({ email: 'ops@example.com' }), false, 'no id');
  assert.equal(await accounts.isPlatformAdmin(null), false);
  const rec = await store.getRecord(PLATFORM_ADMIN, ops.id);
  await store.putRecord(PLATFORM_ADMIN, ops.id, { ...rec, userId: other.id }, { userId: ops.id });
  assert.equal(await accounts.isPlatformAdmin(ops), false, 'a record naming another user id');
  await store.putRecord(PLATFORM_ADMIN, ops.id, rec, { userId: ops.id });
  assert.equal(await accounts.isPlatformAdmin(ops), true);
  // The flag a caller passes in counts for nothing: only the listed email and the record decide (a service
  // gate must ask isPlatformAdmin, never trust actor.user.isAdmin).
  assert.equal(await accounts.isPlatformAdmin({ ...other, isAdmin: true }), false, 'a forged isAdmin flag');
  assert.equal(await accounts.isPlatformAdmin({ id: other.id, email: 'ops@example.com', isAdmin: true }), false, 'a forged email on another id');
  assert.equal(await accounts.isPlatformAdmin({ id: ops.id, email: 'ops@example.com' }), true, 'the stored id and email are what count');
});

test('D1: the allow-list half alone is not a method anyone can call (isPlatformAdmin is the only admin check)', () => {
  assert.equal(Accounts.prototype.isAdmin, undefined, 'Accounts has no isAdmin(user) answering only the email list');
  assert.equal(typeof Accounts.prototype.isPlatformAdmin, 'function');
  // Nothing under server/ or scripts/ calls an isAdmin(...) method: admin checks read req.user.isAdmin (set by
  // userFromRequest from isPlatformAdmin) or call isPlatformAdmin.
  const calls = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') && /\.isAdmin\(/.test(fs.readFileSync(full, 'utf8'))) calls.push(path.relative(ROOT, full));
    }
  };
  for (const dir of ['server', 'scripts']) walk(path.join(ROOT, dir));
  assert.deepEqual(calls, []);
});

test('D1: accounts created before the cutoff are grandfathered at boot exactly once; later ones and revoked ones never are', async t => {
  const store = new MemoryStore();
  const ops = await accountsAt(store, '2026-09-01T10:00:00.000Z').register({ name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  const edge = await accountsAt(store, '2026-10-07T23:59:59.999Z').register({ name: 'Edge Case', email: 'edge@example.com', password: PASSWORD });
  const late = await accountsAt(store, '2026-10-08T00:00:00.000Z').register({ name: 'Late Comer', email: 'late@example.com', password: PASSWORD });
  const old = await accountsAt(store, '2026-01-01T00:00:00.000Z').register({ name: 'Old Friend', email: 'old@example.com', password: PASSWORD });
  const env = { ADMIN_EMAILS: 'ops@example.com, EDGE@example.com,late@example.com,nobody@example.com' };
  const boot = async () => {
    const lines = [];
    const log = { ...quietLog, info: m => lines.push(['info', String(m)]), warn: m => lines.push(['warn', String(m)]) };
    const app = await startApp(env, { store, log });
    t.after(app.close);
    return { app, admin: lines.filter(l => l[1].startsWith('[admin]')) };
  };
  const session = async user => {
    const token = `tok${sfx()}${sfx()}`;
    await store.putRecord('session', crypto.createHash('sha256').update(token).digest('hex'), { userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' }, { userId: user.id });
    return `txs=${token}`;
  };

  const first = await boot();
  assert.deepEqual(first.admin, [
    ['info', `[admin] platform admin: ${ops.id} (o***@example.com), account created 2026-09-01, name "Ops Person"`],
    ['info', `[admin] platform admin: ${edge.id} (e***@example.com), account created 2026-10-07, name "Edge Case"`],
    ['warn', '[admin] ADMIN_EMAILS entry with no admin record: l***@example.com'],
    ['warn', '[admin] ADMIN_EMAILS entry with no admin record: n***@example.com'],
  ]);
  const opsRec = await store.getRecord(PLATFORM_ADMIN, ops.id);
  assert.deepEqual({ ...opsRec, grantedAt: 'x' }, {
    userId: ops.id, email: 'ops@example.com', grantedAt: 'x', grantedBy: 'legacy-email-match', revokedAt: null,
    note: 'ADMIN_EMAILS account created before 2026-10-08T00:00:00Z', rev: 0,
  });
  assert.ok(Date.parse(opsRec.grantedAt) >= Date.parse(FIXED_NOW), 'grantedAt comes from the injected clock');
  assert.equal((await store.getRecord(PLATFORM_ADMIN, edge.id)).grantedBy, 'legacy-email-match', '1 ms before the cutoff counts');
  assert.equal(await store.getRecord(PLATFORM_ADMIN, late.id), null, 'created exactly at the cutoff: not grandfathered');
  assert.equal(await store.getRecord(PLATFORM_ADMIN, old.id), null, 'an old account whose email is not listed: nothing');
  assert.equal((await store.listRecords(PLATFORM_ADMIN, { limit: 100 })).length, 2);
  // The first boot wrote the grandfather list: the listed accounts created before the cutoff, nobody else.
  const list = await store.getRecord(ADMIN_SEED, ADMIN_SEED_ID);
  assert.deepEqual({ ...list, at: 'x' }, { userIds: [ops.id, edge.id], at: 'x', before: '2026-10-08T00:00:00Z', rev: 0 });
  const [opsCookie, lateCookie] = [await session(ops), await session(late)];
  assert.equal((await client(first.app.base, opsCookie).get('/admin')).status, 200, 'grandfathered: no visible change');
  assert.equal((await client(first.app.base, lateCookie).get('/admin')).status, 404);

  // Every boot names the admins again, and grants nothing new.
  const before = await store.listRecords(PLATFORM_ADMIN, { limit: 100 });
  const second = await boot();
  assert.deepEqual(second.admin, first.admin);
  assert.deepEqual(await store.listRecords(PLATFORM_ADMIN, { limit: 100 }), before, 'the records are untouched');
  assert.deepEqual(await store.getRecord(ADMIN_SEED, ADMIN_SEED_ID), list, 'the grandfather list is written once');
  assert.deepEqual(await second.app.accounts.seedPlatformAdmins({ log: quietLog }), { granted: [], missing: ['l***@example.com', 'n***@example.com'] });

  // A revoked grandfathered record stays revoked on every later boot.
  await second.app.accounts.revokePlatformAdmin(ops.id);
  const third = await boot();
  const revoked = await store.getRecord(PLATFORM_ADMIN, ops.id);
  assert.equal(typeof revoked.revokedAt, 'string');
  assert.equal(revoked.rev, 1, 'not granted again');
  assert.equal((await client(third.app.base, opsCookie).get('/admin')).status, 404);
  assert.deepEqual(third.admin.filter(l => l[0] === 'warn').map(l => l[1].split(': ')[1]), ['o***@example.com', 'l***@example.com', 'n***@example.com']);
  for (const line of [...first.admin, ...second.admin, ...third.admin]) {
    for (const email of ['ops@example.com', 'edge@example.com', 'late@example.com', 'nobody@example.com']) assert.ok(!line[1].toLowerCase().includes(email), `${line[1]}: no whole email in the log`);
  }
});

test('D1: the boot seed is safe when several servers boot at once, and skips accounts it cannot date', async () => {
  const store = new MemoryStore();
  const env = { ADMIN_EMAILS: 'ops@example.com,odd@example.com' };
  const ops = await accountsAt(store, '2026-09-01T10:00:00.000Z').register({ name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  const odd = await accountsAt(store, '2026-09-01T10:00:00.000Z').register({ name: 'Odd Date', email: 'odd@example.com', password: PASSWORD });
  await store.putRecord('user', odd.id, { ...(await store.getRecord('user', odd.id)), createdAt: 'sometime' }, { userId: odd.id });
  const [a, b] = await Promise.all([accountsAt(store, FIXED_NOW, env).seedPlatformAdmins(), accountsAt(store, FIXED_NOW, env).seedPlatformAdmins()]);
  assert.deepEqual([...a.granted, ...b.granted], [ops.id], 'one record, granted once');
  assert.deepEqual(a.missing, ['o***@example.com']);
  assert.equal(await store.getRecord(PLATFORM_ADMIN, odd.id), null, 'an unreadable createdAt is never grandfathered');
  assert.equal((await store.listRecords(PLATFORM_ADMIN, { limit: 10 })).length, 1);
  assert.deepEqual((await store.getRecord(ADMIN_SEED, ADMIN_SEED_ID)).userIds, [ops.id], 'one grandfather list');
});

/**
 * The grandfathering is a one-time migration: an account created before the cutoff whose address is added
 * to ADMIN_EMAILS after the first boot gets nothing at later boots. Its name may even be the owner's (the
 * account holder chooses it); the boot log tells the accounts apart by masked email and id.
 */
async function lateListing(store) {
  const owner = await accountsAt(store, '2026-05-01T08:00:00.000Z').register({ name: 'Sam Owner', email: `owner.${sfx()}@example.com`, password: PASSWORD });
  const squat = await accountsAt(store, '2026-06-01T08:00:00.000Z').register({ name: 'Sam Owner', email: `support.${sfx()}@example.com`, password: PASSWORD });
  const first = await accountsAt(store, FIXED_NOW, { ADMIN_EMAILS: owner.email }).seedPlatformAdmins();
  assert.deepEqual(first, { granted: [owner.id], missing: [] });
  const both = { ADMIN_EMAILS: `${owner.email},${squat.email}` };
  for (let boot = 0; boot < 2; boot += 1) {
    assert.deepEqual(await accountsAt(store, FIXED_NOW, both).seedPlatformAdmins(), { granted: [], missing: [maskEmail(squat.email)] }, `later boot ${boot}`);
  }
  assert.equal(await store.getRecord(PLATFORM_ADMIN, squat.id), null, 'no record for the late-listed account');
  const accounts = accountsAt(store, FIXED_NOW, both);
  assert.equal(await accounts.isPlatformAdmin(squat), false);
  assert.equal(await accounts.isPlatformAdmin(owner), true);
  assert.equal(await seedPending(store, squat), false, 'and no boot will grant it');
  return { owner, squat, both };
}

test('D1: an old account whose address joins ADMIN_EMAILS after the first boot is never grandfathered (MemoryStore, HTTP)', async t => {
  const store = new MemoryStore();
  const { owner, squat, both } = await lateListing(store);
  const { app, admin } = await bootOn(t, store, { ...both, ENABLE_BUSINESS: 'true' });
  assert.deepEqual(admin, [
    ['info', `[admin] platform admin: ${owner.id} (${maskEmail(owner.email)}), account created 2026-05-01, name "Sam Owner"`],
    ['warn', `[admin] ADMIN_EMAILS entry with no admin record: ${maskEmail(squat.email)}`],
  ]);
  const squatCookie = await storedSession(store, squat);
  for (const p of ['/admin', '/admin/business']) assert.equal((await client(app.base, squatCookie).get(p)).status, 404, p);
  assert.equal((await client(app.base, await storedSession(store, owner)).get('/admin')).status, 200);
  // The CLI says so, and a grant is the only way in.
  const listed = await runCli(['list'], { store, env: both });
  assert.match(listed.out.find(l => l.includes(squat.email)), /Not an admin: no record \(grant it to give access\)\.$/);
  assert.equal((await runCli(['grant', '--email', squat.email], { store, env: both })).code, cli.EXIT.ok);
  assert.equal((await client(app.base, squatCookie).get('/admin')).status, 200);
});

test('D1: an old account whose address joins ADMIN_EMAILS after the first boot is never grandfathered (Postgres)', { skip: !pgUrl && 'TEST_DATABASE_URL not set' }, async () => {
  const store = new PostgresStore({ connectionString: pgUrl, ssl: false });
  await store.init();
  // The grandfather list is one record per database: start this run without one, and leave none behind.
  await store.deleteRecord(ADMIN_SEED, ADMIN_SEED_ID);
  try {
    const { owner } = await lateListing(store);
    assert.deepEqual((await store.getRecord(ADMIN_SEED, ADMIN_SEED_ID)).userIds, [owner.id]);
  } finally {
    await store.deleteRecord(ADMIN_SEED, ADMIN_SEED_ID);
    await store.close();
  }
});

test('D1: revoking an account with no record before the first boot keeps the seed from ever granting it', async t => {
  const store = new MemoryStore();
  const env = { ADMIN_EMAILS: 'ops@example.com,boss@example.com' };
  const ops = await accountsAt(store, '2026-06-01T08:00:00.000Z').register({ name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  const boss = await accountsAt(store, '2026-06-01T08:00:00.000Z').register({ name: 'Dana Boss', email: 'boss@example.com', password: PASSWORD });
  // Before any boot, list says which old accounts the next boot will grandfather.
  assert.equal(await seedPending(store, ops), true);
  const before = await runCli(['list'], { store, env });
  assert.deepEqual(before.out.slice(1), [
    `  ops@example.com: <ops@example.com>, account created 2026-06-01, id ${ops.id}, name "Ops Person". Not an admin yet, but created before 2026-10-08, so the next boot grants it (revoke it to stop that).`,
    `  boss@example.com: <boss@example.com>, account created 2026-06-01, id ${boss.id}, name "Dana Boss". Not an admin yet, but created before 2026-10-08, so the next boot grants it (revoke it to stop that).`,
  ]);
  const later = () => new Date('2026-10-10T12:00:00.000Z');
  const revoked = await runCli(['revoke', '--email', 'ops@example.com'], { store, env, now: later });
  assert.equal(revoked.code, cli.EXIT.ok);
  assert.deepEqual(revoked.out, [`No platform admin record for <ops@example.com>, account created 2026-06-01, id ${ops.id}, name "Ops Person". Recorded it as revoked, so no boot can grant it.`]);
  assert.deepEqual(await store.getRecord(PLATFORM_ADMIN, ops.id), {
    userId: ops.id, email: 'ops@example.com', grantedAt: '2026-10-10T12:00:00.000Z', grantedBy: 'cli', revokedAt: '2026-10-10T12:00:00.000Z',
    note: 'Revoked before any grant, so the boot seed never grants it', rev: 0,
  });
  assert.equal(await seedPending(store, ops), false);

  const { app } = await bootOn(t, store, env);
  assert.equal((await client(app.base, await storedSession(store, ops)).get('/admin')).status, 404, 'revoked before the boot: never seeded');
  assert.equal((await client(app.base, await storedSession(store, boss)).get('/admin')).status, 200, 'the other old account is grandfathered');
  assert.equal((await store.getRecord(PLATFORM_ADMIN, ops.id)).rev, 0, 'the seed left the revoked record alone');
  assert.match((await runCli(['list'], { store, env })).out[1], /Not an admin: revoked on 2026-10-10\.$/);
  // A grant still works after it (compare-and-set on the revoked record).
  assert.equal((await runCli(['grant', '--email', 'ops@example.com'], { store, env })).code, cli.EXIT.ok);
  assert.equal(await accountsAt(store, FIXED_NOW, env).isPlatformAdmin(ops), true);
  // revokePlatformAdmin answers null only when there is no such account.
  assert.equal(await accountsAt(store, FIXED_NOW, env).revokePlatformAdmin('usr_NOBODYNOBODYNOBO'), null);
});

test('D1: a boot that stopped after writing the grandfather list is finished by the next boot, for accounts on it only', async () => {
  const store = new MemoryStore();
  const env = { ADMIN_EMAILS: 'ops@example.com,other@example.com' };
  const ops = await accountsAt(store, '2026-06-01T08:00:00.000Z').register({ name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  const other = await accountsAt(store, '2026-06-01T08:00:00.000Z').register({ name: 'Other Person', email: 'other@example.com', password: PASSWORD });
  await store.insertRecord(ADMIN_SEED, ADMIN_SEED_ID, { userIds: [ops.id], at: FIXED_NOW, before: ADMIN_SEED_BEFORE, rev: 0 }, { userId: null });
  assert.equal(await seedPending(store, ops), true, 'on the list, no record yet');
  assert.equal(await seedPending(store, other), false, 'not on the list');
  assert.deepEqual(await accountsAt(store, FIXED_NOW, env).seedPlatformAdmins(), { granted: [ops.id], missing: ['o***@example.com'] });
  assert.equal(await store.getRecord(PLATFORM_ADMIN, other.id), null);
  assert.equal(await seedPending(store, ops), false, 'granted now');
  // A list that is not an array grants nobody.
  const odd = new MemoryStore();
  const a = await accountsAt(odd, '2026-06-01T08:00:00.000Z').register({ name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  await odd.insertRecord(ADMIN_SEED, ADMIN_SEED_ID, { userIds: a.id, rev: 0 }, { userId: null });
  assert.deepEqual(await accountsAt(odd, FIXED_NOW, env).seedPlatformAdmins(), { granted: [], missing: ['o***@example.com', 'o***@example.com'] });
});

// =============================================================================================================
// D2: the sign-up race

/**
 * Five sign-ups with one email at the same moment: exactly one account, four email_taken, and the winner
 * (only the winner) can sign in. Every racer gets past the pre-check (each writes its user), so the
 * insert-only email claim is what decides.
 */
async function signUpRace(store) {
  const users = [];
  const realPut = store.putRecord.bind(store);
  store.putRecord = async (kind, recordId, data, opts) => { if (kind === 'user') users.push(recordId); return realPut(kind, recordId, data, opts); };
  try {
    const accounts = accountsAt(store, FIXED_NOW);
    const email = `race.${sfx()}@example.com`;
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map(i => accounts.register({ name: `Racer ${i}`, email, password: `racer password ${i}` })));
    const won = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const lost = results.filter(r => r.status === 'rejected').map(r => r.reason);
    assert.equal(won.length, 1, 'one account');
    assert.equal(lost.length, 4);
    for (const e of lost) {
      assert.equal(e.code, 'email_taken');
      assert.equal(e.status, 409);
      assert.equal(e.message, TAKEN, 'the same message as before');
      assert.deepEqual(e.details, { email: 'An account with this email already exists.' });
    }
    assert.equal(users.length, 5, 'all five passed the pre-check and wrote a user');
    const winner = won[0];
    assert.equal((await store.getRecord('user_email', email)).userId, winner.id);
    for (const uid of users.filter(u => u !== winner.id)) assert.equal(await store.getRecord('user', uid), null, 'each loser removed its user');
    assert.ok(await store.getRecord('user', winner.id));
    const n = winner.name.slice(-1);
    assert.equal((await accounts.authenticate({ email, password: `racer password ${n}` })).id, winner.id, 'the winner can sign in');
    for (const i of [0, 1, 2, 3, 4].filter(i => String(i) !== n)) {
      assert.equal((await accounts.authenticate({ email, password: `racer password ${i}` }).catch(e => e)).code, 'invalid_login');
    }
  } finally {
    store.putRecord = realPut;
  }
}

test('D2: five concurrent sign-ups with one email give one account and four email_taken (MemoryStore)', async () => {
  await signUpRace(new MemoryStore());
});

test('D2: five concurrent sign-ups with one email give one account and four email_taken (Postgres)', { skip: !pgUrl && 'TEST_DATABASE_URL not set' }, async () => {
  const store = new PostgresStore({ connectionString: pgUrl, ssl: false });
  await store.init();
  try { await signUpRace(store); } finally { await store.close(); }
});

test('D2: concurrent sign-ups through /signup: one 303 with a session, four 409 pages', async t => {
  const app = await startApp();
  t.after(app.close);
  const email = `web.${sfx()}@example.com`;
  const res = await Promise.all([0, 1, 2, 3, 4].map(i => client(app.base).post('/signup', { name: `Web ${i}`, email, password: PASSWORD })));
  assert.deepEqual(res.map(r => r.status).sort(), [303, 409, 409, 409, 409]);
  for (const r of res.filter(x => x.status === 409)) assert.match(r.text, /An account with this email already exists/);
  const cookie = sessionCookie(res.find(r => r.status === 303));
  const me = await app.accounts.userFromRequest(asReq(cookie));
  assert.equal(me.email, email);
  assert.equal((await app.store.getRecord('user_email', email)).userId, me.id);
});

test('D2: the user is written before the email is claimed insert-only; a failed claim removes the user', async () => {
  const store = new MemoryStore();
  const calls = [];
  for (const m of ['putRecord', 'insertRecord', 'deleteRecord']) {
    const real = store[m].bind(store);
    store[m] = async (kind, ...rest) => { calls.push(`${m}:${kind}`); return real(kind, ...rest); };
  }
  const accounts = accountsAt(store, FIXED_NOW);
  await accounts.register({ name: 'Ada Lovelace', email: 'ada@example.com', password: PASSWORD });
  assert.deepEqual(calls, ['putRecord:user', 'insertRecord:user_email']);

  // The claim throws (the database went away): the user is removed and the error is not swallowed.
  calls.length = 0;
  const realInsert = MemoryStore.prototype.insertRecord;
  store.insertRecord = async kind => { calls.push(`insertRecord:${kind}`); throw new Error('database went away'); };
  await assert.rejects(accounts.register({ name: 'Grace Hopper', email: 'grace@example.com', password: PASSWORD }), /database went away/);
  assert.deepEqual(calls, ['putRecord:user', 'insertRecord:user_email', 'deleteRecord:user']);
  assert.equal(await accounts.emailInUse('grace@example.com'), false);
  assert.deepEqual((await store.listRecords('user', { limit: 10 })).map(u => u.email), ['ada@example.com'], 'no orphan from the failed claim');
  store.insertRecord = realInsert.bind(store);
  assert.equal((await accounts.register({ name: 'Grace Hopper', email: 'grace@example.com', password: PASSWORD })).email, 'grace@example.com');

  // A crash between the two writes leaves a user with no email link: harmless, and the email is still free.
  const orphan = { id: 'usr_ORPHANORPHANORPHAN', name: 'Half Done', email: 'half@example.com', passwordHash: 'x', profile: {}, createdAt: FIXED_NOW };
  await store.putRecord('user', orphan.id, orphan, { userId: orphan.id });
  const real = await accounts.register({ name: 'Real Person', email: 'half@example.com', password: PASSWORD });
  assert.equal((await accounts.authenticate({ email: 'half@example.com', password: PASSWORD })).id, real.id);
});

// =============================================================================================================
// D10: where sign-in and sign-up send you

const OFF_SITE = ['/\\evil.example', '//evil.example', '/\\/evil.example', '/\t/evil.example', '/\n/evil.example', '/plan\r\nSet-Cookie: x=1',
  'https://evil.example', 'http:/evil.example', '\\\\evil.example', ' /plan', 'plan', '', '/\u0000x', '/x\u001f'];

test('D10: localPath keeps same-site paths only', () => {
  for (const n of OFF_SITE) assert.equal(localPath(n, '/my-trips'), '/my-trips', JSON.stringify(n));
  for (const n of [undefined, null, 42, ['/plan'], { toString: () => '/plan' }]) assert.equal(localPath(n, '/my-trips'), '/my-trips', String(n));
  for (const n of ['/plan?x=1', '/', '/my-trips#saved', '/trip/abc?b=1&c=2', '/%5Cevil.example', '/%2F%2Fevil.example', '/.//evil'])
    assert.equal(localPath(n, '/my-trips'), n, `${n}: an encoded slash or backslash is a plain path character to the browser`);
  assert.equal(localPath(`/${'a'.repeat(400)}`, '/x').length, 300);
});

test('D10: /signin and /signup send off-site and malformed next values to /my-trips and keep local ones', async t => {
  const app = await startApp();
  t.after(app.close);
  const ada = await seedUser(app, { name: 'Ada Lovelace', email: `ada.${sfx()}@example.com` });
  const web = client(app.base);
  const signin = next => web.post('/signin', { email: ada.user.email, password: PASSWORD, next });
  for (const next of OFF_SITE) assert.equal((await signin(next)).location, '/my-trips', JSON.stringify(next));
  assert.equal((await signin('/plan?x=1')).location, '/plan?x=1');
  // A form-encoded backslash (%5C) is decoded by the body parser before the check.
  const raw = await web.raw('/signin', `email=${encodeURIComponent(ada.user.email)}&password=${encodeURIComponent(PASSWORD)}&next=%2F%5Cevil.example`, 'application/x-www-form-urlencoded');
  assert.equal(raw.status, 303);
  assert.equal(raw.location, '/my-trips');
  const tab = await web.raw('/signin', `email=${encodeURIComponent(ada.user.email)}&password=${encodeURIComponent(PASSWORD)}&next=%2F%09%2Fevil.example`, 'application/x-www-form-urlencoded');
  assert.equal(tab.location, '/my-trips');

  for (const [i, next] of ['/\\evil.example', '//evil.example', 'https://evil.example', '/\t/evil.example'].entries()) {
    const r = await web.post('/signup', { name: 'New Person', email: `new${i}.${sfx()}@example.com`, password: PASSWORD, next });
    assert.equal(r.status, 303);
    assert.equal(r.location, '/my-trips', JSON.stringify(next));
  }
  assert.equal((await web.post('/signup', { name: 'Kept Person', email: `kept.${sfx()}@example.com`, password: PASSWORD, next: '/plan?x=1' })).location, '/plan?x=1');

  // A failed sign-in shows the form again with the safe value in its hidden field.
  const bad = await web.post('/signin', { email: ada.user.email, password: 'wrong password!', next: '/\\evil.example' });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /<input type="hidden" name="next" value="\/my-trips">/);
  const kept = await web.post('/signin', { email: ada.user.email, password: 'wrong password!', next: '/plan?x=1' });
  assert.match(kept.text, /<input type="hidden" name="next" value="\/plan\?x=1">/);
  // The GET pages carry ?next= into the form exactly as before (preserve.test.js holds their HTML).
  assert.match((await web.get('/signin?next=%2Fplan%3Fx%3D1')).text, /<input type="hidden" name="next" value="\/plan\?x=1">/);
});

// =============================================================================================================
// Sign-in limits: one budget of failed attempts per email address, whichever sign-in page they come through

/** A client whose every request comes from a new address (TRUST_PROXY on), so no per-IP limit ever counts. */
function freshIps(base) {
  const web = client(base);
  let n = 0;
  const from = () => { n += 1; return { headers: { 'x-forwarded-for': `203.0.${Math.floor(n / 250)}.${(n % 250) + 1}` } }; };
  return { signin: (path, email, password) => web.post(path, { email, password }, from()) };
}

test('sign-in limits: the consumer /signin has the per-address limit too (Business off): 10 failures, then refused for every spelling of that address', async t => {
  const app = await startApp({ TRUST_PROXY: 'true' });
  t.after(app.close);
  const carol = await seedUser(app, { name: 'Carol Chen', email: `carol.${sfx()}@example.com` });
  const sam = await seedUser(app, { name: 'Sam Lee', email: `sam.${sfx()}@example.com` });
  const web = freshIps(app.base);
  for (let i = 0; i < ACCOUNT_LIMIT; i += 1) assert.equal((await web.signin('/signin', carol.user.email, 'wrong password!')).status, 401, `attempt ${i + 1}`);
  for (const spelling of [carol.user.email, ` ${carol.user.email.toUpperCase()} `, `${carol.user.email}\x01`]) {
    const over = await web.signin('/signin', spelling, PASSWORD);
    assert.equal(over.status, 429, JSON.stringify(spelling));
    assert.doesNotMatch(String(over.headers.get('set-cookie') || ''), /txs=/, 'no session');
  }
  assert.equal((await web.signin('/signin', sam.user.email, PASSWORD)).status, 303, 'another address keeps its own budget');
  // Successful sign-ins never count against an address.
  for (let i = 0; i < ACCOUNT_LIMIT + 2; i += 1) assert.equal((await web.signin('/signin', sam.user.email, PASSWORD)).status, 303);
});

test('sign-in limits: /signin and /business/signin share one budget per address, so neither page gets past the other\'s limit', async t => {
  const app = await startApp({ ENABLE_BUSINESS: 'true', TRUST_PROXY: 'true', ADMIN_EMAILS: 'ops@example.com' });
  t.after(app.close);
  const ops = await seedUser(app, { name: 'Ops Person', email: 'ops@example.com' });
  await app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
  const dana = await seedUser(app, { name: 'Dana Lee', email: `dana.${sfx()}@example.com` });
  const web = freshIps(app.base);
  // Ten failures on the Business page, then the consumer page refuses the right password too, with no session.
  for (let i = 0; i < ACCOUNT_LIMIT; i += 1) assert.equal((await web.signin('/business/signin', 'ops@example.com', 'wrong password!')).status, 401, `attempt ${i + 1}`);
  assert.equal((await web.signin('/business/signin', 'ops@example.com', PASSWORD)).status, 429);
  const consumer = await web.signin('/signin', 'ops@example.com', PASSWORD);
  assert.equal(consumer.status, 429, 'the platform admin\'s address is not open on the consumer page');
  assert.doesNotMatch(String(consumer.headers.get('set-cookie') || ''), /txs=/);
  // And the other way round: failures on the consumer page count on the Business page.
  for (let i = 0; i < ACCOUNT_LIMIT; i += 1) assert.equal((await web.signin('/signin', dana.user.email, 'wrong password!')).status, 401, `attempt ${i + 1}`);
  assert.equal((await web.signin('/business/signin', dana.user.email, PASSWORD)).status, 429);
  assert.equal((await web.signin('/signin', dana.user.email, PASSWORD)).status, 429);
});

// =============================================================================================================
// I4: sessions and sessionsValidAfter

test('I4: sessions record issuedAt; signing an account out everywhere ends every earlier session, and only those', async t => {
  const app = await startApp();
  t.after(app.close);
  const email = `sam.${sfx()}@example.com`;
  const up = await client(app.base).post('/signup', { name: 'Sam Traveler', email, password: PASSWORD });
  const first = sessionCookie(up);
  const me = await app.accounts.userFromRequest(asReq(first));
  const sessions = await app.store.listRecords('session', { userId: me.id });
  assert.equal(sessions.length, 1);
  assert.deepEqual(Object.keys(sessions[0]), ['userId', 'issuedAt', 'expiresAt']);
  assert.ok(Date.parse(sessions[0].issuedAt) >= Date.parse(FIXED_NOW), 'issuedAt from the injected clock');
  assert.ok(!('sessionsValidAfter' in me), 'nothing changes for an account that was never signed out everywhere');
  // A session stored before sessions recorded issuedAt still counts while the account has no sessionsValidAfter.
  const legacy = await seedUser(app, { name: 'Lee Legacy' });
  assert.equal((await client(app.base, legacy.cookie).get('/my-trips')).status, 200);

  const second = sessionCookie(await client(app.base).post('/signin', { email, password: PASSWORD }));
  for (const c of [first, second]) assert.equal((await client(app.base, c).get('/my-trips')).status, 200);
  await new Promise(r => setTimeout(r, 5)); // the test clock moves with real time
  const at = await app.accounts.endAllSessions(me.id);
  assert.equal((await app.store.getRecord('user', me.id)).sessionsValidAfter, at);
  for (const c of [first, second]) {
    assert.equal(await app.accounts.userFromRequest(asReq(c)), null);
    const page = await client(app.base, c).get('/my-trips');
    assert.equal(page.status, 303);
    assert.match(page.location, /^\/signin\?next=/);
  }
  const third = sessionCookie(await client(app.base).post('/signin', { email, password: PASSWORD }));
  assert.equal((await client(app.base, third).get('/my-trips')).status, 200, 'signing in again works');
  assert.equal((await app.accounts.userFromRequest(asReq(third))).id, me.id);

  // The legacy session (no issuedAt) ends too once its account is signed out everywhere.
  await app.accounts.endAllSessions(legacy.user.id);
  assert.equal(await app.accounts.userFromRequest(asReq(legacy.cookie)), null);
  assert.equal(await app.accounts.endAllSessions('usr_NOBODYNOBODYNOBO'), null);
});

test('I4: only sessions issued before sessionsValidAfter end; an unreadable date fails closed; user writes never drop each other', async () => {
  const store = new MemoryStore();
  const clock = mutableClock(FIXED_NOW);
  const accounts = new Accounts({ store, config: loadConfig({}), now: clock.now });
  const ada = await accounts.register({ name: 'Ada Lovelace', email: 'ada@example.com', password: PASSWORD });
  const session = async () => {
    let cookie = null;
    await accounts.createSession({ append: (name, value) => { cookie = value.split(';')[0]; } }, ada);
    return cookie;
  };
  const earlier = await session();
  clock.set('2026-10-09T09:00:00.001Z');
  const same = await session();
  assert.equal(await accounts.endAllSessions(ada.id), '2026-10-09T09:00:00.001Z');
  assert.equal(await accounts.userFromRequest(asReq(earlier)), null, 'issued 1 ms before: ended');
  assert.equal((await accounts.userFromRequest(asReq(same))).id, ada.id, 'issued at that same moment: not before it, so it counts');

  await store.putRecord('user', ada.id, { ...(await store.getRecord('user', ada.id)), sessionsValidAfter: 'not a date' }, { userId: ada.id });
  assert.equal(await accounts.userFromRequest(asReq(same)), null, 'an unreadable sessionsValidAfter ends every session');

  // endAllSessions and updateProfile both compare-and-set the user record, so racing writes all land.
  await Promise.all([accounts.endAllSessions(ada.id), accounts.updateProfile(ada.id, { home: 'CAI' }), accounts.updateProfile(ada.id, { seat: 'aisle' })]);
  const stored = await store.getRecord('user', ada.id);
  assert.equal(stored.sessionsValidAfter, '2026-10-09T09:00:00.001Z');
  assert.deepEqual(stored.profile, { home: 'CAI', seat: 'aisle' });
  assert.equal(stored.passwordHash, ada.passwordHash);
  assert.equal((await accounts.authenticate({ email: 'ada@example.com', password: PASSWORD })).id, ada.id);
  assert.equal((await accounts.userFromRequest(asReq(await session()))).id, ada.id);
  assert.equal(await accounts.updateProfile('usr_NOBODYNOBODYNOBO', { a: 1 }), null);
});

// =============================================================================================================
// scripts/platform-admin.js

/** Run the CLI on a store; resolves to { code, out, err } (lines). */
async function runCli(argv, { store, env, now = fixedNow }) {
  const out = [], err = [];
  const code = await cli.run(argv, { store, config: loadConfig(env), now, out: l => out.push(l), err: l => err.push(l) });
  return { code, out, err };
}

test('platform-admin CLI: list, grant (refusing an address outside ADMIN_EMAILS), revoke and revoke --sign-out', async () => {
  const store = new MemoryStore();
  const env = { ADMIN_EMAILS: 'ops@example.com,boss@example.com,new@example.com' };
  const ops = await accountsAt(store, '2026-10-09T08:00:00.000Z').register({ name: 'Ops Person', email: 'ops@example.com', password: PASSWORD });
  const boss = await accountsAt(store, '2026-10-01T08:00:00.000Z').register({ name: 'Dana Boss', email: 'boss@example.com', password: PASSWORD });
  const eve = await accountsAt(store, '2026-10-01T08:00:00.000Z').register({ name: 'Eve Outsider', email: 'eve@example.com', password: PASSWORD });
  await accountsAt(store, FIXED_NOW, env).seedPlatformAdmins();

  const listed = await runCli(['list'], { store, env });
  assert.equal(listed.code, cli.EXIT.ok);
  assert.deepEqual(listed.err, []);
  assert.deepEqual(listed.out, [
    'ADMIN_EMAILS lists 3 addresses.',
    `  ops@example.com: <ops@example.com>, account created 2026-10-09, id ${ops.id}, name "Ops Person". Not an admin: no record (grant it to give access).`,
    `  boss@example.com: <boss@example.com>, account created 2026-10-01, id ${boss.id}, name "Dana Boss". Platform admin since 2026-10-09 (legacy-email-match).`,
    '  new@example.com: no account with this email yet.',
  ]);

  // grant refuses an address that is not listed, and a listed one with no account.
  const outside = await runCli(['grant', '--email', 'eve@example.com'], { store, env });
  assert.equal(outside.code, cli.EXIT.refused);
  assert.match(outside.err.join('\n'), /eve@example\.com is not in ADMIN_EMAILS/);
  assert.equal(await store.getRecord(PLATFORM_ADMIN, eve.id), null, 'nothing written');
  const noAccount = await runCli(['grant', '--email', 'new@example.com'], { store, env });
  assert.equal(noAccount.code, cli.EXIT.refused);
  assert.match(noAccount.err.join('\n'), /no account uses new@example\.com/);

  const granted = await runCli(['grant', '--email=OPS@Example.com '], { store, env });
  assert.equal(granted.code, cli.EXIT.ok);
  assert.deepEqual(granted.out, [`Granted platform admin: <ops@example.com>, account created 2026-10-09, id ${ops.id}, name "Ops Person".`]);
  const rec = await store.getRecord(PLATFORM_ADMIN, ops.id);
  assert.deepEqual(rec, { userId: ops.id, email: 'ops@example.com', grantedAt: FIXED_NOW, grantedBy: 'cli', revokedAt: null, note: 'scripts/platform-admin.js grant', rev: 0 });
  const accounts = accountsAt(store, FIXED_NOW, env);
  assert.equal(await accounts.isPlatformAdmin(ops), true);
  const again = await runCli(['grant', '--email', 'ops@example.com'], { store, env });
  assert.deepEqual(again.out, [`Already a platform admin: <ops@example.com>, account created 2026-10-09, id ${ops.id}, name "Ops Person". Nothing changed.`]);
  assert.deepEqual(await store.getRecord(PLATFORM_ADMIN, ops.id), rec);

  // revoke keeps the record with revokedAt; a second revoke changes nothing.
  const later = () => new Date('2026-10-10T12:00:00.000Z');
  const revoked = await runCli(['revoke', '--email', 'ops@example.com'], { store, env, now: later });
  assert.equal(revoked.code, cli.EXIT.ok);
  assert.deepEqual(revoked.out, [`Revoked platform admin: <ops@example.com>, account created 2026-10-09, id ${ops.id}, name "Ops Person".`]);
  assert.equal((await store.getRecord(PLATFORM_ADMIN, ops.id)).revokedAt, '2026-10-10T12:00:00.000Z');
  assert.equal(await accounts.isPlatformAdmin(ops), false);
  assert.deepEqual((await runCli(['revoke', '--email', 'ops@example.com'], { store, env })).out, [`Already revoked on 2026-10-10: <ops@example.com>, account created 2026-10-09, id ${ops.id}, name "Ops Person".`]);
  assert.match((await runCli(['list'], { store, env })).out[1], /Not an admin: revoked on 2026-10-10\.$/);
  // Granting again after a revoke works (by compare-and-set).
  assert.equal((await runCli(['grant', '--email', 'ops@example.com'], { store, env })).code, cli.EXIT.ok);
  assert.equal(await accounts.isPlatformAdmin(ops), true);

  // revoke --sign-out also ends the account's sessions.
  let cookie = null;
  await accounts.createSession({ append: (n, v) => { cookie = v.split(';')[0]; } }, boss);
  assert.equal((await accounts.userFromRequest(asReq(cookie))).isAdmin, true);
  const out = await runCli(['revoke', '--email', 'boss@example.com', '--sign-out'], { store, env, now: later });
  assert.equal(out.code, cli.EXIT.ok);
  assert.deepEqual(out.out, [
    `Revoked platform admin: <boss@example.com>, account created 2026-10-01, id ${boss.id}, name "Dana Boss".`,
    'Signed out everywhere: every session issued before 2026-10-10T12:00:00.000Z has ended.',
  ]);
  assert.equal(await accounts.userFromRequest(asReq(cookie)), null);
  assert.equal((await store.getRecord('user', boss.id)).sessionsValidAfter, '2026-10-10T12:00:00.000Z');

  // revoke works for an address no longer listed (it only takes access away); an unknown address is refused.
  const unlistedEnv = { ADMIN_EMAILS: 'boss@example.com' };
  const fromList = await runCli(['list'], { store, env: unlistedEnv });
  assert.deepEqual(fromList.out.slice(-2), [
    'Records for addresses no longer in ADMIN_EMAILS (they give no access):',
    `  ops@example.com: <ops@example.com>, account created 2026-10-09, id ${ops.id}, name "Ops Person". Granted on 2026-10-09 (cli).`,
  ]);
  assert.equal((await runCli(['revoke', '--email', 'ops@example.com'], { store, env: unlistedEnv })).code, cli.EXIT.ok);
  assert.ok((await store.getRecord(PLATFORM_ADMIN, ops.id)).revokedAt);
  const nobody = await runCli(['revoke', '--email', 'nobody@example.com'], { store, env });
  assert.equal(nobody.code, cli.EXIT.refused);
  assert.match(nobody.err.join('\n'), /no account uses nobody@example\.com/);
  assert.deepEqual((await runCli(['revoke', '--email', 'eve@example.com'], { store, env })).out, [`No platform admin record for <eve@example.com>, account created 2026-10-01, id ${eve.id}, name "Eve Outsider". Recorded it as revoked, so no boot can grant it.`]);
  assert.equal((await store.getRecord(PLATFORM_ADMIN, eve.id)).revokedAt, FIXED_NOW);
});

test('platform-admin CLI and the boot log: the real date and id come before the account\'s own name, which is quoted and escaped', async () => {
  // A name is whatever the account typed at sign-up. One that imitates the fixed fields must not read as them in
  // the line the owner checks before a grant ("that's me").
  const store = new MemoryStore();
  const fake = 'Moataz <spoof@example.com>, account created 2025-02-11. Platform admin since 2025-02-11 (legacy-email-match).';
  const spoof = await accountsAt(store, FIXED_NOW).register({ name: fake, email: 'spoof@example.com', password: PASSWORD });
  const stored = (await store.getRecord('user', spoof.id)).name;
  assert.equal(stored, fake.slice(0, 80), 'stored as typed, cut to 80 characters');
  const env = { ADMIN_EMAILS: 'spoof@example.com,tricky@example.com' };
  const listed = await runCli(['list'], { store, env });
  const line = listed.out[1];
  assert.equal(line, `  spoof@example.com: <spoof@example.com>, account created 2026-10-09, id ${spoof.id}, name ${JSON.stringify(stored)}. Not an admin: no record (grant it to give access).`);
  assert.ok(line.indexOf('account created 2026-10-09') < line.indexOf('2025-02-11'), 'the real creation date is the first date on the line');
  assert.ok(line.indexOf(`id ${spoof.id}`) < line.indexOf('name "'), 'and the id comes before the name');

  // Characters that would break the line or hide and reorder text in a terminal or log viewer are escaped.
  const tricky = await accountsAt(store, FIXED_NOW).register({ name: 'A\u202eB\u2028C\u200bD\u0085E"F\\G\u2066H\ufeffI', email: 'tricky@example.com', password: PASSWORD });
  const escaped = String.raw`"A\u202eB\u2028C\u200bD\u0085E\"F\\G\u2066H\ufeffI"`;
  assert.equal(quoteName((await store.getRecord('user', tricky.id)).name), escaped);
  const granted = await runCli(['grant', '--email', 'tricky@example.com'], { store, env });
  assert.deepEqual(granted.out, [`Granted platform admin: <tricky@example.com>, account created 2026-10-09, id ${tricky.id}, name ${escaped}.`]);
  assert.doesNotMatch(granted.out[0], /[\u0080-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);

  // The boot log line has the same order: id, masked email and date, then the quoted name.
  await accountsAt(store, FIXED_NOW, env).grantPlatformAdmin(spoof.id, { by: 'test' });
  const lines = [];
  await accountsAt(store, FIXED_NOW, env).seedPlatformAdmins({ log: { info: m => lines.push(String(m)), warn: m => lines.push(String(m)) } });
  assert.deepEqual(lines, [
    `[admin] platform admin: ${spoof.id} (s***@example.com), account created 2026-10-09, name ${JSON.stringify(stored)}`,
    `[admin] platform admin: ${tricky.id} (t***@example.com), account created 2026-10-09, name ${escaped}`,
  ]);
});

test('platform-admin CLI: the container image carries the script and everything it requires (the documented ECS run-task)', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const copied = dockerfile.split('\n').map(l => l.trim()).filter(l => /^COPY\s/i.test(l))
    .flatMap(l => l.replace(/^COPY\s+(--\S+\s+)*/i, '').split(/\s+/).slice(0, -1)).map(src => src.replace(/^\.\//, '').replace(/\/$/, ''));
  const inImage = rel => copied.some(src => rel === src || rel.startsWith(`${src}/`));
  assert.ok(inImage('scripts/platform-admin.js'), `the Dockerfile copies scripts/platform-admin.js (COPY sources: ${copied.join(', ')})`);
  const ignored = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  assert.ok(!ignored.some(p => p === 'scripts' || p === 'scripts/' || p === 'scripts/platform-admin.js'), '.dockerignore keeps it');
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'platform-admin.js'), 'utf8');
  const local = [...source.matchAll(/require\('(\.[^']+)'\)/g)].map(m => path.relative(ROOT, path.resolve(ROOT, 'scripts', m[1])));
  assert.ok(local.length >= 4, local.join(', '));
  for (const rel of local) assert.ok(inImage(rel), `${rel} is in the image`);
  for (const m of source.matchAll(/require\('([^.'][^']*)'\)/g)) assert.ok(m[1].startsWith('node:'), `${m[1]}: only node built-ins beyond the copied files`);
});

test('platform-admin CLI: refuses a command line it does not understand, and the in-memory store', async () => {
  const store = new MemoryStore();
  const env = { ADMIN_EMAILS: 'ops@example.com' };
  for (const argv of [[], ['delete'], ['grant'], ['grant', '--email'], ['revoke'], ['list', '--email', 'ops@example.com'], ['list', '--sign-out'],
    ['grant', '--email', 'ops@example.com', '--sign-out'], ['grant', '--email', 'ops@example.com', '--force']]) {
    const r = await runCli(argv, { store, env });
    assert.equal(r.code, cli.EXIT.usage, JSON.stringify(argv));
    assert.ok(r.err.includes(cli.USAGE), JSON.stringify(argv));
    assert.deepEqual(r.out, []);
  }
  assert.deepEqual(await store.listRecords(PLATFORM_ADMIN, { limit: 10 }), []);
  const script = path.join(__dirname, '..', 'scripts', 'platform-admin.js');
  for (const extra of [{ DATABASE_URL: 'memory' }, {}]) {
    const envVars = { ...process.env, APP_ENV: 'development', ADMIN_EMAILS: 'ops@example.com', ...extra };
    if (!('DATABASE_URL' in extra)) delete envVars.DATABASE_URL;
    delete envVars.DATABASE_HOST;
    const child = spawnSync(process.execPath, [script, 'list'], { env: envVars, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, cli.EXIT.refused, child.stderr);
    assert.match(child.stderr, /set DATABASE_URL/);
    assert.equal(child.stdout, '');
  }
});

// =============================================================================================================
// I9: the lead kind

test('I9: validatePartnerLead keeps kind only when it is exactly business; other leads are stored as before', () => {
  const base = { name: 'Rana', company: 'Blue Door Logistics', email: 'Rana@Example.com', type: '51-200 people', message: 'We would like our team to plan work trips.' };
  assert.deepEqual(validatePartnerLead({ ...base, kind: 'business' }), { name: 'Rana', company: 'Blue Door Logistics', email: 'rana@example.com', type: '51-200 people', message: base.message, kind: 'business' });
  for (const kind of [undefined, null, '', 'partner', 'contact', 'Business', ' business', 'business ', ['business'], { business: true }, 1]) {
    const lead = validatePartnerLead({ ...base, kind });
    assert.ok(!('kind' in lead), JSON.stringify(kind));
    assert.deepEqual(Object.keys(lead), ['name', 'company', 'email', 'type', 'message'], 'the same fields, in the same order, as before');
  }
  assert.throws(() => validatePartnerLead({ ...base, kind: 'business', message: 'short' }), e => e.code === 'invalid_lead', 'the kind skips no check');
});

test('I9: POST /api/partners stores kind business only from the business form; the platform list sees only those', async t => {
  const app = await startApp({ ENABLE_BUSINESS: 'true' });
  t.after(app.close);
  const post = body => fetch(app.base + '/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
  const lead = { name: 'Rana', company: 'Blue Door Logistics', email: 'rana@example.com', type: '51-200 people', message: 'We would like our team to plan work trips.' };
  assert.equal((await post({ ...lead, kind: 'business' })).status, 201);
  assert.equal((await post({ ...lead, name: 'Omar', type: 'Property owner', kind: 'partner' })).status, 201);
  assert.equal((await post({ ...lead, name: 'Mona', type: 'General enquiry' })).status, 201);
  assert.equal((await post({ ...lead, name: 'Bot', kind: 'business', website: 'x' })).status, 201, 'the honeypot still drops it');
  const stored = await app.store.listPartnerLeads();
  assert.deepEqual(stored.map(l => [l.name, l.kind]), [['Mona', undefined], ['Omar', undefined], ['Rana', 'business']]);
  for (const l of stored.filter(x => x.name !== 'Rana')) assert.deepEqual(Object.keys(l), ['id', 'name', 'company', 'email', 'type', 'message', 'createdAt']);
  const repo = new Repo({ store: app.store, now: app.ctx.now });
  assert.deepEqual((await repo.listBusinessLeads()).map(l => l.name), ['Rana']);
});
