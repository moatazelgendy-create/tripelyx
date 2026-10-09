// Stage 2A: the public Business pages (plan §B2, §B4 "Public" and "Workspace entry", §B7, §I5): sign-up for a
// new person, for an existing account and from an invite (every landing state, pending included), sign-in
// with its limiter order, sign-out, /business/app, and the route table itself: every POST runs limiter →
// sameOrigin → form → gate → handler, a cross-site POST gets 403 and writes nothing, and every Business page
// is noindex and no-store with no inline style or script.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser, seedOrg, seedMember, client, mutableClock, noInline, storeSnapshot, PASSWORD } = require('./business-helpers');
const businessRoutes = require('../server/routes/business');
const businessPlatform = require('../server/routes/businessPlatform');
const { KINDS } = require('../server/business/constants');
const { ACCOUNT_LIMIT } = require('../server/business/limits');

const ROUTERS = Object.freeze({
  public: require('../server/routes/business/public'),
  traveler: require('../server/routes/business/traveler'),
  admin: require('../server/routes/business/admin'),
});

/** Page text with tags dropped and entities decoded, for matching copy. */
const textOf = page => String(page).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
/** The session cookie a response set (trips on also sets the visitor cookie first). */
const sessionOf = res => {
  const c = res.headers.getSetCookie().find(x => x.startsWith('txs='));
  assert.ok(c, 'a session cookie was set');
  return c.split(';')[0];
};
/** The page's <main> (the app's development banner and chrome are not this page's copy). */
const mainOf = page => (String(page).match(/<main[\s\S]*<\/main>/) || [''])[0];
const recordsOf = (app, kind) => [...app.store.records.values()].filter(r => r.kind === kind).map(r => r.data);
const privatePage = (res, label) => {
  assert.match(res.headers.get('cache-control') || '', /no-store/, `${label}: no-store`);
  assert.match(res.headers.get('x-robots-tag') || '', /noindex/, `${label}: noindex`);
};

/** An app with Business on, a platform admin, and a few helpers over the service. */
async function setup({ env = {}, clock = null } = {}) {
  const app = await startApp({ ENABLE_BUSINESS: 'true', BUSINESS_AUTH_LIMIT: '1000', ADMIN_EMAILS: 'ops@example.com', ...env }, clock ? { now: clock.now } : {});
  const svc = app.business;
  const ops = await seedUser(app, { name: 'Pat Platform', email: 'ops@example.com' });
  await app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
  const admin = { user: { ...ops.user, isAdmin: true } };
  const actor = (orgId, u) => ({ org: { id: orgId }, user: u.user || u });
  return { app, svc, ops, admin, actor };
}

// ---------------------------------------------------------------------------------------------------------
// The route table

test('routes: ROUTES lists every public, admin and platform route, and each Express route runs exactly limiter → sameOrigin → form → gate → handler', async t => {
  const { app } = await setup();
  t.after(app.close);
  assert.deepEqual(businessRoutes.ROUTES, [...ROUTERS.public.ROUTES, ...ROUTERS.traveler.ROUTES, ...ROUTERS.admin.ROUTES]);
  for (const [name, mod] of Object.entries(ROUTERS)) assert.deepEqual(Object.keys(mod).sort(), ['ROUTES', 'router'], name);
  assert.deepEqual(Object.keys(businessPlatform).sort(), ['MOUNT', 'ROUTES', 'router']);
  const key = r => `${r.method} ${r.path}`;
  assert.deepEqual(ROUTERS.public.ROUTES.map(key), [
    'GET /start', 'POST /start', 'GET /signin', 'POST /signin', 'POST /signout', 'GET /invite/:token', 'POST /invite/:token/accept', 'POST /invite/:token/join', 'GET /app',
  ]);
  assert.deepEqual(ROUTERS.admin.ROUTES.map(key), [
    'GET /o/:orgId/welcome', 'GET /o/:orgId/policies', 'GET /o/:orgId/policies/:tier', 'POST /o/:orgId/policies/:tier', 'GET /o/:orgId/policies/:tier/history',
    'GET /o/:orgId/budgets', 'POST /o/:orgId/budgets', 'GET /o/:orgId/people', 'POST /o/:orgId/people/invite', 'POST /o/:orgId/people/invites/:publicId/revoke',
    'POST /o/:orgId/people/:userId', 'POST /o/:orgId/people/:userId/remove', 'POST /o/:orgId/departments', 'GET /o/:orgId/reports', 'POST /o/:orgId/reports/export',
    'GET /o/:orgId/activity', 'GET /o/:orgId/settings', 'POST /o/:orgId/settings', 'POST /o/:orgId/settings/export',
  ]);
  assert.deepEqual(businessPlatform.ROUTES.map(key), ['GET /', 'POST /:orgId/status']);
  assert.deepEqual(ROUTERS.public.ROUTES.find(r => key(r) === 'POST /signin').limiter, ['bizAuthIp', 'bizAuthAccount']);
  for (const r of [...ROUTERS.public.ROUTES, ...ROUTERS.admin.ROUTES, ...businessPlatform.ROUTES]) {
    assert.ok(Object.isFrozen(r), key(r));
    if (r.method === 'POST') assert.ok(r.limiter.length, `${key(r)} has a limiter`);
  }
  assert.equal(ROUTERS.admin.ROUTES.filter(r => r.method === 'POST').every(r => r.limiter.join() === 'bizWrite'), true, 'every admin POST is bizWrite');

  // The Express stack, built with real deps, against the table: nothing more, nothing less, in order.
  const deps = businessRoutes.createRouterDeps(app.ctx);
  const GATES = { anyone: ['publicHeaders'], user: ['publicHeaders', 'requireUserPage'], member: ['bizMemberGate'], platform: ['bizPlatformGate'] };
  const check = (router, routes, label) => {
    const layers = router.stack.filter(l => l.route);
    const seen = layers.flatMap(l => Object.keys(l.route.methods).filter(m => l.route.methods[m]).map(m => `${m.toUpperCase()} ${l.route.path}`));
    assert.deepEqual(seen.sort(), routes.map(key).sort(), `${label}: the Express routes are the ROUTES table`);
    for (const r of routes) {
      const layer = layers.find(l => l.route.path === r.path && l.route.methods[r.method.toLowerCase()]);
      const chain = layer.route.stack.map(s => s.handle);
      const want = [...r.limiter.filter(l => l !== 'bizAuthAccount').map(l => deps.limits[l])];
      if (r.method === 'POST') want.push(deps.sameOrigin, deps.form);
      if (r.limiter.includes('bizAuthAccount')) want.push(deps.limits.bizAuthAccount);
      assert.deepEqual(chain.slice(0, want.length), want, `${label} ${key(r)}: limiters, sameOrigin and the form parser first`);
      const rest = chain.slice(want.length).map(fn => fn.name);
      assert.deepEqual(rest.slice(0, -1), GATES[r.who], `${label} ${key(r)}: then the gate`);
      assert.ok(rest.at(-1) && !GATES[r.who].includes(rest.at(-1)), `${label} ${key(r)}: then its handler`);
    }
  };
  check(ROUTERS.public.router(app.ctx, deps), ROUTERS.public.ROUTES, 'public');
  check(ROUTERS.admin.router(app.ctx, deps), ROUTERS.admin.ROUTES, 'admin');
  check(businessPlatform.router(app.ctx, deps), businessPlatform.ROUTES, 'platform');
  // The sign-in chain by name: the email limiter reads the parsed form, so it sits after the parser.
  const signin = ROUTERS.public.router(app.ctx, deps).stack.find(l => l.route && l.route.path === '/signin' && l.route.methods.post);
  assert.deepEqual(signin.route.stack.map(s => s.handle === deps.limits.bizAuthIp ? 'bizAuthIp' : s.handle === deps.limits.bizAuthAccount ? 'bizAuthAccount' : s.handle.name),
    ['bizAuthIp', 'sameOrigin', 'urlencodedParser', 'bizAuthAccount', 'publicHeaders', 'signinPost']);
});

test('routes: a cross-site POST to every Business route (walked from ROUTES) answers 403 and writes nothing', async t => {
  const { app, svc, ops, actor } = await setup();
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Olivia Owner' });
  const org = await seedOrg(app, owner);
  const emp = await seedMember(app, org, 'employee', { name: 'Eli Employee' });
  const { token, invite } = await svc.invite(actor(org.id, owner), { email: 'new.person@example.com', role: 'employee' });
  const params = { orgId: org.id, token, tier: 'standard', userId: emp.user.id, publicId: invite.publicId, rid: 'req_AAAAAAAAAAAAAAAA' };
  const fill = p => p.replace(/:([A-Za-z]+)/g, (m, k) => {
    assert.ok(Object.hasOwn(params, k), `a value for :${k}`);
    return encodeURIComponent(params[k]);
  });
  const routes = [
    ...businessRoutes.ROUTES.map(r => ({ ...r, url: businessRoutes.MOUNT + fill(r.path), cookie: owner.cookie })),
    ...businessPlatform.ROUTES.map(r => ({ ...r, url: businessPlatform.MOUNT + (r.path === '/' ? '' : fill(r.path)), cookie: ops.cookie })),
  ].filter(r => r.method === 'POST');
  assert.ok(routes.length >= 16, 'the walk covers the 2A POST routes');
  const form = { email: 'x@example.com', password: PASSWORD, name: 'X', companyName: 'Cross Inc', size: '1-10 people', ack: '1', rev: '0', status: 'active', role: 'employee', amount: '1', period: '2026-Q4', note: 'n' };
  const before = storeSnapshot(app);
  for (const r of routes) {
    for (const cookie of [r.cookie, '']) {
      const res = await client(app.base, cookie).post(r.url, form, { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(res.status, 403, `${r.method} ${r.url} (${cookie ? 'signed in' : 'signed out'})`);
      assert.match(textOf(res.text), /This request was blocked\./, r.url);
    }
  }
  assert.deepEqual(storeSnapshot(app), before, 'nothing was written');
});

test('pages: every Business page is noindex and no-store; the public ones send no referrer; none has an inline style or script', async t => {
  const { app, svc, ops, actor } = await setup();
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Olivia Owner' });
  const org = await seedOrg(app, owner);
  const { token } = await svc.invite(actor(org.id, owner), { email: 'new.person@example.com', role: 'employee' });
  const anon = client(app.base);
  const mine = client(app.base, owner.cookie);
  const o = `/business/o/${org.id}`;
  const pages = [
    [anon, '/business/start', 200, true], [anon, '/business/signin', 200, true], [anon, `/business/invite/${token}`, 200, true],
    [anon, '/business/invite/not-a-token', 410, true], [mine, '/business/start', 200, true], [mine, '/business/app', 200, true],
    [client(app.base, ops.cookie), '/admin/business', 200, false],
    ...['/welcome', '/policies', '/policies/standard', '/policies/standard/history', '/budgets', '/people', '/reports', '/activity', '/settings'].map(p => [mine, o + p, 200, false]),
  ];
  await seedOrg(app, owner, { name: 'Second Co' }); // two companies: /business/app shows the chooser
  for (const [c, path, status, pub] of pages) {
    const res = await c.get(path);
    assert.equal(res.status, status, path);
    privatePage(res, path);
    if (pub) assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${path}: no referrer`);
    noInline(path, res.text);
    assert.doesNotMatch(mainOf(res.text), /—/, `${path}: no em dash in the copy`);
    assert.match(res.text, /<meta name="robots" content="noindex/, `${path}: noindex in the page too`);
  }
  // Redirects and refusals are private too.
  for (const [c, path] of [[anon, '/business/app'], [anon, `${o}/people`], [client(app.base, ops.cookie), `${o}/people`], [anon, '/admin/business']]) {
    const res = await c.get(path);
    assert.ok([303, 404].includes(res.status), path);
    privatePage(res, path);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Sign-up

test('sign-up: a new person creates an account and a company in one form, lands on the welcome page, and the company waits for Tripelyx', async t => {
  const { app, svc } = await setup();
  t.after(app.close);
  const c = client(app.base);
  const page = await c.get('/business/start');
  assert.equal(page.status, 200);
  for (const name of ['name', 'email', 'password', 'companyName', 'size', 'timezone', 'ack']) assert.match(page.text, new RegExp(`name="${name}"`), name);
  assert.match(textOf(page.text), /Tripelyx confirms each new company before teammates can join\./);
  assert.match(textOf(page.text), /US dollars \(USD\)\. More currencies later\./);
  const res = await c.post('/business/start', { name: 'Dana Lee', email: 'Dana@Acme.example', password: PASSWORD, companyName: 'Acme Inc', size: '11-50 people', timezone: 'Europe/London', ack: '1' });
  assert.equal(res.status, 303);
  const m = /^\/business\/o\/(org_[A-Za-z0-9_-]+)\/welcome$/.exec(res.location);
  assert.ok(m, res.location);
  const cookie = sessionOf(res);
  const orgRec = await svc.repo.get(KINDS.org, m[1]);
  assert.equal(orgRec.status, 'pending');
  assert.equal(orgRec.timezone, 'Europe/London');
  const user = recordsOf(app, 'user').find(u => u.email === 'dana@acme.example');
  assert.ok(user, 'the account exists, its email lowercased');
  assert.deepEqual(orgRec.ownerIds, [user.id]);
  const welcome = await client(app.base, cookie).get(res.location);
  assert.equal(welcome.status, 200);
  const text = textOf(welcome.text);
  assert.match(text, /Welcome to Tripelyx Business/);
  assert.match(text, /Tripelyx is confirming Acme Inc\./, 'the pending-company ribbon');
  for (const item of ['Review your policy', 'Add departments and budgets', 'Invite your team']) assert.match(text, new RegExp(item), item);
  // While pending, an invite landing says to try again later (409).
  const { token } = await svc.invite({ org: { id: m[1] }, user }, { email: 'sam@acme.example', role: 'employee' });
  const landing = await client(app.base).get(`/business/invite/${token}`);
  assert.equal(landing.status, 409);
  assert.match(textOf(landing.text), /Acme Inc is waiting for Tripelyx to confirm it\. Try this link again once it's confirmed\./);
  assert.doesNotMatch(landing.text, /name="password"/, 'no join form while pending');
});

test('sign-up: an email that already has an account is told to sign in, and nothing is created', async t => {
  const { app } = await setup();
  t.after(app.close);
  await seedUser(app, { name: 'Dana Lee', email: 'dana@acme.example' });
  const users = recordsOf(app, 'user').length;
  const res = await client(app.base).post('/business/start', { name: 'Dana Again', email: 'DANA@acme.example', password: 'another-long-pass', companyName: 'Acme Inc', size: '1-10 people', ack: '1' });
  assert.equal(res.status, 409);
  const text = textOf(res.text);
  assert.match(text, /An account with this email already exists\. Sign in to add your company to it\./);
  assert.match(res.text, /href="\/business\/signin\?next=%2Fbusiness%2Fstart"/);
  assert.doesNotMatch(res.text, /another-long-pass/, 'the password is never echoed');
  assert.match(res.text, /value="Acme Inc"/, 'the company name is kept');
  assert.equal(recordsOf(app, 'user').length, users);
  assert.equal(recordsOf(app, KINDS.org).length, 0);
  assert.equal(res.headers.getSetCookie().some(x => x.startsWith('txs=')), false, 'no session');
});

test('sign-up: bad fields come back 422 with each message, and nothing is created', async t => {
  const { app } = await setup();
  t.after(app.close);
  const res = await client(app.base).post('/business/start', { name: '', email: 'not-an-email', password: 'short', companyName: 'Tripelyx Travel', size: '', ack: '' });
  assert.equal(res.status, 422);
  const text = textOf(res.text);
  for (const msg of ['Enter your name.', 'Enter a valid email address.', 'Use at least 10 characters.', "Choose your own company's name.", "Tick this box to confirm you won't enter real employee travel plans yet."]) {
    assert.ok(text.includes(msg), msg);
  }
  assert.match(res.text, /aria-invalid="true"/);
  assert.doesNotMatch(res.text, /value="short"/);
  assert.equal(recordsOf(app, 'user').length, 1, 'only the platform admin');
  assert.equal(recordsOf(app, KINDS.org).length, 0);
});

test('sign-up: a signed-in person adds a company under their own account; at the company limit the page says so', async t => {
  const { app } = await setup({ env: { BUSINESS_MAX_ORGS_PER_USER: '1' } });
  t.after(app.close);
  const me = await seedUser(app, { name: 'Dana Lee', email: 'dana@acme.example' });
  const c = client(app.base, me.cookie);
  const page = await c.get('/business/start');
  const text = textOf(page.text);
  assert.match(text, /You're signed in as Dana Lee \(d\*+@acme\.example\)\./);
  assert.match(text, /Your personal trips stay private: your company can't see them\./);
  assert.doesNotMatch(page.text, /name="password"/, 'no account fields when signed in');
  const res = await c.post('/business/start', { companyName: 'Acme Inc', size: '1-10 people', ack: '1' });
  assert.equal(res.status, 303);
  assert.match(res.location, /^\/business\/o\/org_[A-Za-z0-9_-]+\/welcome$/);
  assert.equal(res.headers.getSetCookie().some(x => x.startsWith('txs=')), false, 'the same session');
  const capped = await c.get('/business/start');
  assert.match(textOf(capped.text), /You're already in 1 company, the most one account can join in the preview\./);
  const again = await c.post('/business/start', { companyName: 'Beta Inc', size: '1-10 people', ack: '1' });
  assert.equal(again.status, 422);
  assert.equal(recordsOf(app, KINDS.org).length, 1);
});

// ---------------------------------------------------------------------------------------------------------
// Sign-in, sign-out, limits

test('sign-in: a wrong password is 401 with the message; a good one goes to a /business next or /business/app; a signed-in visit skips the form', async t => {
  const { app } = await setup();
  t.after(app.close);
  await seedUser(app, { name: 'Dana Lee', email: 'dana@acme.example' });
  const c = client(app.base);
  const page = await c.get('/business/signin?next=%2Fbusiness%2Fstart');
  assert.equal(page.status, 200);
  assert.match(page.text, /name="next" value="\/business\/start"/);
  const bad = await c.post('/business/signin', { email: 'dana@acme.example', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  assert.match(textOf(bad.text), /That email and password don.t match an account\./);
  assert.match(bad.text, /value="dana@acme\.example"/);
  assert.doesNotMatch(bad.text, /wrong-password/);
  const outside = await c.post('/business/signin', { email: 'dana@acme.example', password: PASSWORD, next: 'https://evil.example/business' });
  assert.equal(outside.status, 303);
  assert.equal(outside.location, '/business/app', 'a next off the site is ignored');
  const notBiz = await c.post('/business/signin', { email: 'dana@acme.example', password: PASSWORD, next: '/my-trips' });
  assert.equal(notBiz.location, '/business/app', 'a next outside /business is ignored');
  const good = await c.post('/business/signin', { email: 'dana@acme.example', password: PASSWORD, next: '/business/start' });
  assert.equal(good.status, 303);
  assert.equal(good.location, '/business/start');
  const signedIn = client(app.base, sessionOf(good));
  const skip = await signedIn.get('/business/signin?next=%2Fbusiness%2Fstart');
  assert.equal(skip.status, 303);
  assert.equal(skip.location, '/business/start');
});

test('sign-in limits: the email limiter reads the parsed form and counts only failures; the IP limiter caps sign-ups', async t => {
  const { app } = await setup();
  t.after(app.close);
  await seedUser(app, { name: 'Dana Lee', email: 'dana@acme.example' });
  await seedUser(app, { name: 'Sam Doe', email: 'sam@acme.example' });
  const c = client(app.base);
  // Successful sign-ins never count.
  for (let i = 0; i < ACCOUNT_LIMIT + 2; i += 1) assert.equal((await c.post('/business/signin', { email: 'sam@acme.example', password: PASSWORD })).status, 303);
  for (let i = 0; i < ACCOUNT_LIMIT; i += 1) assert.equal((await c.post('/business/signin', { email: 'dana@acme.example', password: `wrong-${i}-password` })).status, 401, `attempt ${i + 1}`);
  const blocked = await c.post('/business/signin', { email: ' DANA@acme.example ', password: PASSWORD });
  assert.equal(blocked.status, 429, 'the right password too, once the address is over its limit, in any spelling');
  assert.match(textOf(blocked.text), /Too many requests in a short time\./);
  assert.equal((await c.post('/business/signin', { email: 'sam@acme.example', password: 'wrong-password' })).status, 401, 'another address is not limited');

  const small = await setup({ env: { BUSINESS_AUTH_LIMIT: '3' } });
  t.after(small.app.close);
  const s = client(small.app.base);
  for (let i = 0; i < 3; i += 1) assert.equal((await s.post('/business/start', { name: '', email: 'x' })).status, 422);
  assert.equal((await s.post('/business/start', { name: '', email: 'x' })).status, 429);
  assert.equal((await s.post('/business/signin', { email: 'a@b.example', password: 'whatever-pass' })).status, 429, 'one IP budget for sign-up and sign-in');
});

test('sign-out ends the session and goes back to /business (or a /business next); it needs the same site', async t => {
  const { app } = await setup();
  t.after(app.close);
  const me = await seedUser(app, { name: 'Dana Lee' });
  const c = client(app.base, me.cookie);
  assert.equal((await c.get('/business/app')).status, 200);
  const cross = await c.post('/business/signout', {}, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  assert.equal((await c.get('/business/app')).status, 200, 'still signed in');
  const out = await c.post('/business/signout', { next: 'https://evil.example' });
  assert.equal(out.status, 303);
  assert.equal(out.location, '/business');
  const after = await c.get('/business/app');
  assert.equal(after.status, 303);
  assert.equal(after.location, `/business/signin?next=${encodeURIComponent('/business/app')}`);
  const anon = await client(app.base).post('/business/signout', {});
  assert.equal(anon.status, 303);
  assert.equal(anon.location, '/business/signin');
});

// ---------------------------------------------------------------------------------------------------------
// Invites

test('invite, signed out: one join state offers "Create your account" and "Already have an account? Sign in"; joining makes the account, the session and the member', async t => {
  const { app, svc, actor } = await setup();
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Dana Lee' });
  const org = await seedOrg(app, owner);
  const eng = (await svc.saveDepartment(actor(org.id, owner), { name: 'Engineering' }));
  const { token } = await svc.invite(actor(org.id, owner), { email: 'sam@acme.example', role: 'manager', departmentId: eng.id, tier: 'director' });
  const here = `/business/invite/${token}`;
  const c = client(app.base);
  const page = await c.get(here);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const text = textOf(page.text);
  assert.match(text, /Join Acme Inc/);
  assert.match(text, /Dana Lee invited sam@acme\.example to join as Manager in Engineering\./);
  assert.match(text, /Create your account to join/);
  assert.match(text, /Already have an account\? Sign in with it to join Acme Inc\./);
  assert.match(page.text, new RegExp(`href="/business/signin\\?next=${encodeURIComponent(here).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(text, /If an account with this email isn't yours, write to go@tripelyx\.com\./);
  assert.doesNotMatch(page.text, /name="email"/, 'the email is fixed by the invite');
  // A bad password: 422, nothing created, the name kept.
  const short = await c.post(`${here}/join`, { name: 'Sam Doe', password: 'short' });
  assert.equal(short.status, 422);
  assert.match(textOf(short.text), /Use at least 10 characters\./);
  assert.match(short.text, /value="Sam Doe"/);
  assert.equal(recordsOf(app, 'user').some(u => u.email === 'sam@acme.example'), false);
  // Join.
  const res = await c.post(`${here}/join`, { name: 'Sam Doe', password: PASSWORD, email: 'someone.else@example.com' });
  assert.equal(res.status, 303);
  assert.equal(res.location, `/business/o/${org.id}`);
  const user = recordsOf(app, 'user').find(u => u.email === 'sam@acme.example');
  assert.ok(user, 'the account uses the invited email, whatever the form says');
  assert.equal(recordsOf(app, 'user').some(u => u.email === 'someone.else@example.com'), false);
  const member = await svc.repo.get(KINDS.member, `${org.id}.${user.id}`);
  assert.equal(member.role, 'manager');
  assert.equal(member.tier, 'director');
  assert.equal(member.departmentId, eng.id);
  const app2 = await client(app.base, sessionOf(res)).get('/business/app');
  assert.equal(app2.status, 303, 'one company: /business/app opens it');
  assert.equal(app2.location, `/business/o/${org.id}`);
  // The link is used now.
  const used = await c.get(here);
  assert.equal(used.status, 410);
  assert.match(textOf(used.text), /This invite link can't be used anymore\. Ask your company's travel admin for a new one\./);
});

test('invite: joining with an email that already has an account answers 409 "This email already has an account. Sign in instead." and joins nothing', async t => {
  const { app, svc, actor } = await setup();
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Dana Lee' });
  const org = await seedOrg(app, owner);
  const sam = await seedUser(app, { name: 'Sam Doe', email: 'sam@acme.example' });
  const { token } = await svc.invite(actor(org.id, owner), { email: 'sam@acme.example', role: 'employee' });
  const here = `/business/invite/${token}`;
  const res = await client(app.base).post(`${here}/join`, { name: 'Sam Again', password: PASSWORD });
  assert.equal(res.status, 409);
  const text = textOf(res.text);
  assert.match(text, /This email already has an account\. Sign in instead\./);
  assert.match(res.text, new RegExp(`href="/business/signin\\?next=${encodeURIComponent(here)}"`));
  assert.equal(res.headers.getSetCookie().some(x => x.startsWith('txs=')), false, 'no session');
  assert.equal(await svc.repo.get(KINDS.member, `${org.id}.${sam.user.id}`), null);
  // Signing in, then accepting, works.
  const signin = await client(app.base).post('/business/signin', { email: 'sam@acme.example', password: PASSWORD, next: here });
  assert.equal(signin.location, here);
  const c = client(app.base, sessionOf(signin));
  const landing = await c.get(here);
  assert.match(textOf(landing.text), /You're signed in as Sam Doe \(sam@acme\.example\)\./);
  const ok = await c.post(`${here}/accept`, {});
  assert.equal(ok.status, 303);
  assert.equal(ok.location, `/business/o/${org.id}`);
  assert.equal((await svc.repo.get(KINDS.member, `${org.id}.${sam.user.id}`)).status, 'active');
});

test('invite, signed in: another account sees the masked address and a sign-out; a member is told so; revoked and expired links are 410; a paused company is 403', async t => {
  const clock = mutableClock(FIXED_NOW);
  const { app, svc, admin, actor } = await setup({ clock });
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Dana Lee' });
  const org = await seedOrg(app, owner);
  const other = await seedUser(app, { name: 'Olga Other', email: 'olga@example.com' });
  const { token, invite } = await svc.invite(actor(org.id, owner), { email: 'sam@acme.example', role: 'employee' });
  const here = `/business/invite/${token}`;
  const asOther = await client(app.base, other.cookie).get(here);
  assert.equal(asOther.status, 200);
  const t1 = textOf(asOther.text);
  assert.match(t1, /This invite is for s\*+@acme\.example\. You're signed in as olga@example\.com\./);
  assert.doesNotMatch(asOther.text, /sam@acme\.example/, 'another account never sees the full invited address');
  assert.match(asOther.text, /action="\/business\/signout"/);
  assert.match(asOther.text, new RegExp(`name="next" value="${here}"`));
  const refused = await client(app.base, other.cookie).post(`${here}/accept`, {});
  assert.equal(refused.status, 403, 'the wrong account cannot accept');
  const asOwner = await client(app.base, owner.cookie).get(here);
  assert.match(textOf(asOwner.text), /You're already in Acme Inc\./);
  // Revoked.
  await svc.revokeInvite(actor(org.id, owner), invite.publicId);
  assert.equal((await client(app.base).get(here)).status, 410);
  // Expired.
  const fresh = await svc.invite(actor(org.id, owner), { email: 'sam@acme.example', role: 'employee' });
  assert.equal((await client(app.base).get(`/business/invite/${fresh.token}`)).status, 200);
  clock.advance(8);
  assert.equal((await client(app.base).get(`/business/invite/${fresh.token}`)).status, 410);
  assert.equal((await client(app.base).post(`/business/invite/${fresh.token}/join`, { name: 'Sam', password: PASSWORD })).status, 410);
  // Paused.
  const third = await svc.invite(actor(org.id, owner), { email: 'kim@acme.example', role: 'employee' });
  const cur = await svc.repo.get(KINDS.org, org.id);
  await svc.platformSetStatus(admin, org.id, { status: 'suspended', note: 'Checking', rev: cur.rev });
  const paused = await client(app.base).get(`/business/invite/${third.token}`);
  assert.equal(paused.status, 403);
  assert.match(textOf(paused.text), /This company is paused/);
  assert.match(textOf(paused.text), /Tripelyx has paused this company workspace\. Write to go@tripelyx\.com\./);
  assert.match(paused.text, /href="\/business\/signin"/, 'signed out: Sign in');
  const pausedSignedIn = await client(app.base, other.cookie).get(`/business/invite/${third.token}`);
  assert.equal(pausedSignedIn.status, 403);
  assert.match(pausedSignedIn.text, /href="\/business\/app">Your companies</, 'signed in: their companies, not Sign in');
  assert.doesNotMatch(pausedSignedIn.text, /href="\/business\/signin"/);
});

// ---------------------------------------------------------------------------------------------------------
// /business/app

test('/business/app: no company offers to create one, one company opens it, two show cards; a platform admin also sees companies waiting', async t => {
  const { app, ops } = await setup();
  t.after(app.close);
  const me = await seedUser(app, { name: 'Dana Lee' });
  const c = client(app.base, me.cookie);
  const none = await c.get('/business/app');
  assert.equal(none.status, 200);
  assert.match(textOf(none.text), /Create your company workspace/);
  assert.match(textOf(none.text), /Joining a team\? Open the invite link your travel admin sent you\./);
  const a = await seedOrg(app, me, { name: 'Acme Inc' });
  const one = await c.get('/business/app');
  assert.equal(one.status, 303);
  assert.equal(one.location, `/business/o/${a.id}`);
  const b = await seedOrg(app, me, { name: 'Beta Ltd', status: 'pending' });
  const two = await c.get('/business/app');
  assert.equal(two.status, 200);
  const text = textOf(two.text);
  assert.match(text, /Your companies/);
  assert.match(two.text, new RegExp(`href="/business/o/${a.id}"`));
  assert.match(two.text, new RegExp(`href="/business/o/${b.id}"`));
  assert.match(text, /Beta Ltd Owner Waiting for confirmation/);
  assert.doesNotMatch(two.text, /\/admin\/business/, 'no platform link for a customer');
  const asOps = await client(app.base, ops.cookie).get('/business/app');
  assert.equal(asOps.status, 200, 'a platform admin is never sent into a company');
  assert.match(textOf(asOps.text), /Companies waiting for confirmation \(1\)/);
});

test('with Travel by Budget off, sign-up, sign-in and the platform page still work', async t => {
  const { app, ops } = await setup({ env: { ENABLE_TRIPS: 'false' } });
  t.after(app.close);
  const c = client(app.base);
  assert.equal((await c.get('/business/start')).status, 200);
  const res = await c.post('/business/start', { name: 'Dana Lee', email: 'dana@acme.example', password: PASSWORD, companyName: 'Acme Inc', size: '1-10 people', ack: '1' });
  assert.equal(res.status, 303);
  assert.deepEqual(res.headers.getSetCookie().filter(x => x.startsWith('txv=')), [], 'no visitor cookie with trips off');
  const page = await client(app.base, ops.cookie).get('/admin/business');
  assert.equal(page.status, 200);
  noInline('/admin/business', page.text);
  assert.match(textOf(page.text), /Waiting for confirmation \(1\)/);
  assert.doesNotMatch(page.text, /tb-admin-tabs/, 'the corporate page, not the trips admin');
  assert.equal((await client(app.base, sessionOf(res)).get('/admin/business')).status, 404);
});

test('Postgres: sign-up, invite and join over HTTP', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set', timeout: 60000 }, async t => {
  const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const app = await startApp({ ENABLE_BUSINESS: 'true', BUSINESS_AUTH_LIMIT: '1000', BUSINESS_SELF_SERVE: 'true', DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_SSL: 'false' });
  t.after(async () => { await app.close(); await app.store.close(); });
  const c = client(app.base);
  const res = await c.post('/business/start', { name: 'Dana Lee', email: `dana.${sfx}@acme.example`, password: PASSWORD, companyName: `Acme ${sfx}`, size: '1-10 people', ack: '1' });
  assert.equal(res.status, 303);
  const orgId = /\/business\/o\/([^/]+)\/welcome/.exec(res.location)[1];
  const owner = client(app.base, sessionOf(res));
  assert.equal((await owner.get(res.location)).status, 200);
  const inv = await owner.post(`/business/o/${orgId}/people/invite`, { email: `sam.${sfx}@acme.example`, role: 'employee', tier: 'standard' });
  assert.equal(inv.status, 200);
  const link = /\/business\/invite\/([A-Za-z0-9_-]{20,})/.exec(inv.text)[0];
  const join = await client(app.base).post(`${link}/join`, { name: 'Sam Doe', password: PASSWORD });
  assert.equal(join.status, 303);
  assert.equal(join.location, `/business/o/${orgId}`);
  const people = await owner.get(`/business/o/${orgId}/people`);
  assert.match(textOf(people.text), /Sam Doe/);
});
