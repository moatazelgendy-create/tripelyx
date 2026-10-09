// scripts/business-demo.js (plan §L Stage 3 step 3): the seed the private preview's boot hook awaits, and the
// development-only command. The seed goes through the BusinessService, fills only the in-memory store outside
// production, uses the preview password when there is one (and never logs it), and leaves requests in every
// state with the two test scenarios captioned wherever they show. The command refuses anything but
// APP_ENV=development on the in-memory store, and serves the demo (and the production preview) over http.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startApp, FIXED_NOW, quietLog } = require('./helpers');
const { mutableClock, storeSnapshot } = require('./business-helpers');
const flows = require('./business-e2e-flows');
const demo = require('../scripts/business-demo');

const ADMIN = 'ops@tripelyx.example';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'business-demo.js');
const { textOf, mainOf, browser, formOf, setFields } = flows;

function recordingLog() {
  const lines = [];
  const at = level => (...a) => lines.push(`${level} ${a.map(String).join(' ')}`);
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error'), log: at('log') } };
}

/** A development app with Business on, seeded as the preview hook seeds it ({ ...createApp result, config, log, now }). */
async function seeded({ env = {}, config: patch = null } = {}) {
  const clock = mutableClock(FIXED_NOW);
  const app = await startApp({ ENABLE_BUSINESS: 'true', ADMIN_EMAILS: ADMIN, ...env }, { now: clock.now });
  const config = patch ? { ...app.config, ...patch } : app.config;
  const { lines, log } = recordingLog();
  const result = await demo.seed({ ...app, config, log, now: app.ctx.now });
  return { app, clock, lines, result };
}

async function signIn(base, email, password) {
  const b = browser(base);
  let res = await b.get('/business/signin');
  res = await b.post('/business/signin', setFields(formOf(res.text, '/business/signin'), { email, password }));
  assert.equal(res.status, 303, `${email} signs in: ${textOf(mainOf(res.text)).slice(0, 200)}`);
  return b;
}

const userId = async (app, email) => (await app.store.getRecord('user_email', email)).userId;
const requestsOf = async (app, orgId) => (await app.store.listRecords('biz_request', { limit: 1000 })).filter(r => r.orgId === orgId);

test('seed: Demo Company (preview) with every role, departments, budgets, the policy, requests in every state, and a second company for the switcher', { timeout: 60000 }, async t => {
  const { app, result, lines } = await seeded();
  t.after(app.close);
  const svc = app.business;

  // Companies, confirmed, named as demo.
  assert.deepEqual(result.companies.map(c => c.name), [demo.DEMO_COMPANY, demo.SECOND_COMPANY]);
  for (const c of result.companies) {
    const org = await app.store.getRecord('biz_org', c.id);
    assert.equal(org.status, 'active', `${c.name} is confirmed`);
    assert.match(org.name, /Demo Company \(preview\)$/);
  }
  const [orgId, org2Id] = result.companies.map(c => c.id);

  // Accounts: obviously fictional names, reserved .example addresses, the roles the plan asks for.
  const emails = result.accounts.map(a => a.email);
  assert.deepEqual(new Set(emails).size, emails.length);
  assert.ok(emails.includes(ADMIN), 'the platform admin is the first ADMIN_EMAILS address');
  for (const a of result.accounts) {
    assert.match(a.email, /\.example$/, a.email);
    assert.match(a.name, /\b(Owner|Traveladmin|Finance|Manager|Employee|Platform)\b/, `${a.name} says it is a demo role`);
  }
  const rolesIn = company => result.accounts.flatMap(a => a.roles.filter(r => r.company === company).map(r => r.role)).sort();
  assert.deepEqual(rolesIn(demo.DEMO_COMPANY), ['Employee', 'Employee', 'Employee', 'Employee', 'Finance', 'Manager', 'Manager', 'Owner', 'Travel Admin']);
  assert.deepEqual(rolesIn(demo.SECOND_COMPANY), ['Employee', 'Owner']);
  const sharedEmail = demo.PEOPLE.find(p => p.key === demo.SHARED).email;
  assert.equal(result.accounts.find(a => a.email === sharedEmail).roles.length, 2, 'one employee is in both companies');
  assert.equal(result.passwordSource, 'default');
  assert.ok(!JSON.stringify(result).includes(demo.DEMO_PASSWORD), 'the result never carries the password');

  // The platform admin is one (ADMIN_EMAILS and a platform_admin record).
  const admin = await app.store.getRecord('user', await userId(app, ADMIN));
  assert.equal(await app.accounts.isPlatformAdmin(admin), true);
  // Every demo account signs in with the demo password.
  for (const email of emails) assert.ok(await app.accounts.authenticate({ email, password: demo.DEMO_PASSWORD }), email);

  // Departments, budgets for Q4 2026, the Standard policy with the route exception and ZS blocked.
  const owner = { org: { id: orgId }, user: await app.store.getRecord('user', await userId(app, demo.PEOPLE[0].email)) };
  const deps = await svc.listDepartments(owner);
  assert.deepEqual(deps.map(d => d.name).sort(), ['Engineering', 'General', 'Sales']);
  const budgets = await svc.listBudgets(owner, '2026-Q4');
  const byName = Object.fromEntries(budgets.map(b => [b.department.name, b]));
  assert.deepEqual([byName.Sales.amountCents, byName.Engineering.amountCents], [1500000, 3000000]);
  const policy = await svc.getPolicy(owner, 'standard');
  assert.equal(policy.version, 2);
  assert.deepEqual(policy.rules.flights.blockedCarriers, ['ZS']);
  assert.deepEqual(policy.rules.flights.routeOverrides.map(o => [o.from, o.to, o.bothWays, o.maxCabin]), [['CAI', 'LHR', true, 'premium']]);
  const org = await app.store.getRecord('biz_org', orgId);
  assert.equal(org.settings.approvalHours, 168, 'approvers get 7 days after the expired scenario is made');

  // Requests in every state.
  const all = await requestsOf(app, orgId);
  assert.equal(all.length, 9);
  const nowIso = app.ctx.now().toISOString();
  const effective = r => svc.policy.effectiveStatus(r, nowIso, org.timezone);
  const byPurpose = Object.fromEntries(all.map(r => [r.purpose, r]));
  assert.deepEqual(Object.fromEntries(all.map(r => [r.purpose, effective(r)])), {
    'Client workshop in London': 'approved',
    'Board meeting in London': 'pending',
    'Partner summit in London': 'approved',
    'Sales conference in London': 'denied',
    'Team offsite in London': 'cancelled',
    'Product launch in London': 'pending',
    'Customer visit in London': 'draft',
    'Test scenario: the approval window ran out': 'expired',
    'Test scenario: the hotel price changed before sending': 'draft',
  });
  assert.deepEqual(byPurpose['Client workshop in London'].approval.decidedBy, { system: 'policy' }, 'approved by policy');
  const summit = byPurpose['Partner summit in London'];
  assert.equal(summit.approval.mode, 'manual', 'approved by a manager');
  assert.ok(summit.history.some(h => h.action === 'swapped'), 'after a swap to a cheaper option');
  assert.ok(byPurpose['Sales conference in London'].history.some(h => h.action === 'denied' && h.note.length >= 10), 'denied with a reason');
  assert.ok(byPurpose['Product launch in London'].messages.some(m => /launch agenda/.test(m.text)), 'a question from the manager');
  assert.ok(byPurpose['Customer visit in London'].alternatives.length > 0, 'a draft with cheaper alternatives');
  const expired = byPurpose['Test scenario: the approval window ran out'];
  assert.equal(expired.status, 'pending', 'stored as sent; nothing wrote the expiry');
  assert.equal(expired.submittedAt, new Date(Date.parse(FIXED_NOW) - 2 * 86400000).toISOString(), 'made under a clock two days back');
  assert.ok(Date.parse(expired.expiresAt) < Date.parse(nowIso));
  const repriced = byPurpose['Test scenario: the hotel price changed before sending'];
  assert.equal(repriced.returned.why, 'price_changed');
  assert.equal(repriced.returned.toCents - repriced.returned.fromCents, demo.PRICE_STEP_CENTS, 'the hotel room priced $29 more');
  // The budget holds only the approved trips (the cancelled one gave its hold back).
  const eng = await app.store.getRecord('biz_budget', `${orgId}.${deps.find(d => d.name === 'Engineering').id}.2026-Q4`);
  assert.deepEqual(Object.keys(eng.commits), [byPurpose['Client workshop in London'].id]);
  const sales = await app.store.getRecord('biz_budget', `${orgId}.${deps.find(d => d.name === 'Sales').id}.2026-Q4`);
  assert.deepEqual(Object.keys(sales.commits), [summit.id]);

  // The second company shares the one employee and holds nothing of the first.
  const idx = await app.store.getRecord('biz_user_index', await userId(app, sharedEmail));
  assert.deepEqual(idx.orgIds.sort(), [orgId, org2Id].sort());
  assert.deepEqual(await requestsOf(app, org2Id), []);

  // The log says "Test scenario" and never the password.
  assert.ok(lines.some(l => /Test scenario: one demo hotel room/.test(l)), lines.join('\n'));
  assert.ok(lines.every(l => !l.includes(demo.DEMO_PASSWORD)));
  // Nothing was booked, charged or sent.
  assert.deepEqual([app.store.quotes.size, app.store.bookings.size, app.store.intents.size, app.store.leads.length], [0, 0, 0, 0]);
  assert.deepEqual(await app.store.listRecords('outbox'), []);
});

test('seed over HTTP: the test scenarios are captioned on their pages, the switcher has both companies, ZS is blocked, the platform admin confirms', { timeout: 60000 }, async t => {
  const { app, result } = await seeded();
  t.after(app.close);
  const [orgId, org2Id] = result.companies.map(c => c.id);
  const B = `/business/o/${orgId}`;
  const P = demo.DEMO_PASSWORD;
  const email = key => demo.PEOPLE.find(p => p.key === key).email;
  const all = await requestsOf(app, orgId);
  const rid = purpose => all.find(r => r.purpose === purpose).id;
  const expiredId = rid('Test scenario: the approval window ran out');
  const repricedId = rid('Test scenario: the hotel price changed before sending');

  // Emma: her trips list has the expired request (lists show route, dates and status, not the purpose), and
  // its page carries the caption.
  const emma = await signIn(app.base, email('emma'), P);
  let res = await emma.get(`${B}/trips`);
  let main = flows.pageChecks('/trips (emma)', res);
  assert.ok(main.includes(`href="${B}/trips/${expiredId}"`), 'the expired scenario is in her list');
  assert.match(textOf(main), /Expired/);
  const snap = storeSnapshot(app);
  res = await emma.get(`${B}/trips/${expiredId}`);
  main = flows.pageChecks('expired scenario', res);
  assert.match(textOf(main), /Test scenario: the approval window ran out/);
  assert.match(textOf(main), /Expired at .*\. Nothing was approved\./);
  assert.equal(storeSnapshot(app), snap, 'showing it expired writes nothing');

  // Ezra: the price-change scenario, with was and now, captioned; sending it again goes through at the new price.
  const ezra = await signIn(app.base, email('ezra'), P);
  res = await ezra.get(`${B}/trips/${repricedId}`);
  main = flows.pageChecks('price-change scenario', res);
  assert.match(textOf(main), /Test scenario: the hotel price changed before sending/);
  assert.match(textOf(main), /This trip changed before it was sent\. Review it and send it again\. The price changed\./);
  assert.match(textOf(main), /Was \$[\d,.]+ ?, now \$[\d,.]+ ?\./);
  res = await ezra.post(`${B}/trips/${repricedId}/submit`, formOf(res.text, `${B}/trips/${repricedId}/submit`));
  assert.match(res.location || '', /\?ok=auto_approved$/, `sent again: ${res.location}`);

  // The Sales manager: the expired scenario under Expired, and captioned on its page as she sees it.
  const mona = await signIn(app.base, email('salesManager'), P);
  res = await mona.get(`${B}/approvals?tab=expired`);
  assert.ok(flows.pageChecks('approvals expired', res).includes(`href="${B}/trips/${expiredId}"`));
  res = await mona.get(`${B}/trips/${expiredId}`);
  assert.match(textOf(flows.pageChecks('expired scenario (manager)', res)), /Test scenario: the approval window ran out/);
  // The Engineering manager: two requests waiting, one with his question.
  const milo = await signIn(app.base, email('engManager'), P);
  res = await milo.get(`${B}/approvals`);
  main = flows.pageChecks('approvals (milo)', res);
  for (const p of ['Board meeting in London', 'Product launch in London']) assert.ok(main.includes(`href="${B}/trips/${rid(p)}"`), p);
  res = await milo.get(`${B}/trips/${rid('Product launch in London')}`);
  assert.match(textOf(flows.pageChecks('question', res)), /Could you share the launch agenda\?/);

  // The blocked airline on a search: Sahara Wings rows are blocked and cannot be picked.
  res = await ezra.get(`${B}/trips/search?${new URLSearchParams({ ...flows.Q, depart: '2026-11-20', return: '2026-11-24' })}`);
  main = flows.pageChecks('search (ZS blocked)', res);
  const zs = [...main.matchAll(/<article class="bz-card bz-row bz-row-flight"[\s\S]*?<\/article>/g)].map(m => m[0]).filter(c => /Sahara Wings/.test(c));
  assert.equal(zs.length, 2, 'Sahara Wings flies out and back on these dates');
  for (const card of zs) {
    assert.ok(textOf(card).includes(`Blocked by policy Sahara Wings isn't used by ${demo.DEMO_COMPANY}.`), textOf(card).slice(0, 300));
    assert.equal((card.match(/<input class="bz-opt-radio"[^>]*>/g) || []).filter(i => !/\sdisabled/.test(i)).length, 0, 'no Sahara Wings fare can be picked');
  }
  assert.ok(!flows.choices(res.text).some(c => /Sahara Wings/.test(c.card)));

  // Eli: the switcher with both demo companies.
  const eli = await signIn(app.base, email('eli'), P);
  res = await eli.get(B);
  const sw = (res.text.match(/<details class="[^"]*\bbz-switch\b[^"]*"[\s\S]*?<\/details>/) || [''])[0];
  assert.ok(textOf(sw).includes(demo.DEMO_COMPANY) && textOf(sw).includes(demo.SECOND_COMPANY), "Eli's switcher shows both companies");
  assert.equal((await eli.get(`/business/o/${org2Id}`)).status, 200);

  // The platform admin sees both companies confirmed, and is no member of either.
  const ops = await signIn(app.base, ADMIN, P);
  res = await ops.get('/admin/business');
  assert.equal(res.status, 200);
  for (const name of [demo.DEMO_COMPANY, demo.SECOND_COMPANY]) assert.ok(textOf(res.text).includes(name), name);
  assert.equal((await ops.get(B)).status, 404);
});

test('seed uses config.preview.password for every demo account and never logs it', { timeout: 60000 }, async t => {
  const secret = 'gate-and-demo-password-1234';
  const { app, result, lines } = await seeded({ config: { preview: { gate: null, seed: 'business', password: secret } } });
  t.after(app.close);
  assert.equal(result.passwordSource, 'preview');
  for (const a of result.accounts) {
    assert.ok(await app.accounts.authenticate({ email: a.email, password: secret }), a.email);
    await assert.rejects(app.accounts.authenticate({ email: a.email, password: demo.DEMO_PASSWORD }), /match/);
  }
  assert.ok(lines.length > 0 && lines.every(l => !l.includes(secret)), 'the password is never logged');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('seed refuses a store that is not the in-memory one, production, Business off, no ADMIN_EMAILS, and a second run', { timeout: 60000 }, async t => {
  const app = await startApp({ ENABLE_BUSINESS: 'true', ADMIN_EMAILS: ADMIN });
  t.after(app.close);
  const { log } = recordingLog();
  const base = { ...app, config: app.config, log, now: app.ctx.now };
  const before = storeSnapshot(app);
  await assert.rejects(demo.seed({ ...base, store: { kind: 'postgres' } }), /only fills the in-memory store/);
  await assert.rejects(demo.seed({ ...base, config: { ...app.config, appEnv: 'production', isProduction: true } }), /never runs with APP_ENV=production/);
  await assert.rejects(demo.seed({ ...base, config: { ...app.config, appEnv: 'staging', isProduction: true } }), /production/);
  await assert.rejects(demo.seed({ ...base, business: null }), /ENABLE_BUSINESS=true/);
  await assert.rejects(demo.seed({ ...base, config: { ...app.config, trips: { ...app.config.trips, adminEmails: [] } } }), /needs ADMIN_EMAILS/);
  assert.equal(storeSnapshot(app), before, 'a refusal writes nothing');
  await demo.seed(base);
  await assert.rejects(demo.seed(base), /already here/);
  // A staging preview (APP_ENV=staging, DATABASE_URL=memory) is allowed: the hook's own config.
  const staging = await startApp({ APP_ENV: 'staging', DATABASE_URL: 'memory', ENABLE_BUSINESS: 'true', ADMIN_EMAILS: ADMIN, ALLOW_DEMO_INVENTORY: 'true' }, { log: quietLog });
  t.after(staging.close);
  const r = await demo.seed({ ...staging, config: staging.config, log, now: staging.ctx.now });
  assert.equal(r.companies.length, 2);
});

test('priceStep moves one room on one stay only, and passes everything else through', async () => {
  const calls = [];
  const inner = {
    name: 'Inner', isDemo: true,
    async quote(input) { calls.push(input.offerId); return { lines: [{ kind: 'base', amount: 10000 }, { kind: 'tax', amount: 1400 }] }; },
    lookups() { return { where: ['London'] }; },
  };
  const target = { offerId: 'htl_A', optionId: 'STD', checkIn: '2026-11-12', checkOut: '2026-11-16' };
  const p = demo.priceStep(inner, target, 2900);
  const q = { checkIn: '2026-11-12', checkOut: '2026-11-16' };
  assert.deepEqual((await p.quote({ offerId: 'htl_A', optionId: 'STD', query: q })).lines.map(l => l.amount), [12900, 1400]);
  assert.deepEqual((await p.quote({ offerId: 'htl_A', optionId: 'DLX', query: q })).lines.map(l => l.amount), [10000, 1400]);
  assert.deepEqual((await p.quote({ offerId: 'htl_A', optionId: 'STD', query: { ...q, checkIn: '2026-11-13' } })).lines.map(l => l.amount), [10000, 1400]);
  assert.deepEqual((await p.quote({ offerId: 'htl_B', optionId: 'STD', query: q })).lines.map(l => l.amount), [10000, 1400]);
  assert.equal(p.name, 'Inner');
  assert.equal(p.isDemo, true);
  assert.deepEqual(p.lookups(), { where: ['London'] });
  assert.equal(calls.length, 4);
});

test('the command: arguments, and it refuses anything but APP_ENV=development on the in-memory store', async () => {
  assert.deepEqual(demo.parseArgs([]), { port: 4400, prodPort: null });
  assert.deepEqual(demo.parseArgs(['--port', '4500', '--production-preview=4501']), { port: 4500, prodPort: 4501 });
  assert.match(demo.parseArgs(['--port']).error, /needs a port/);
  assert.match(demo.parseArgs(['--port', 'x']).error, /needs a port/);
  assert.match(demo.parseArgs(['--seed']).error, /Unknown option/);
  assert.match(demo.parseArgs(['--port', '4500', '--production-preview', '4500']).error, /two different ports/);
  const out = () => { const lines = []; return { lines, log: m => lines.push(String(m)), error: m => lines.push(String(m)) }; };
  for (const env of [{}, { APP_ENV: 'staging' }, { APP_ENV: 'production' }]) {
    const o = out();
    assert.equal((await demo.main({ argv: [], env, out: o })).code, 1, JSON.stringify(env));
    assert.match(o.lines.join('\n'), /only with APP_ENV=development/);
  }
  for (const env of [{ APP_ENV: 'development', DATABASE_URL: 'postgres://x@127.0.0.1:9/db' }, { APP_ENV: 'development', DATABASE_HOST: 'db.internal' }]) {
    const o = out();
    assert.equal((await demo.main({ argv: [], env, out: o })).code, 1);
    assert.match(o.lines.join('\n'), /only fills the in-memory store/);
  }
  const o = out();
  assert.equal((await demo.main({ argv: ['--nope'], env: { APP_ENV: 'development' }, out: o })).code, 2);
});

test('the command: the demo and the production preview, in this process, over plain http', { timeout: 60000 }, async t => {
  const lines = [];
  const out = { log: m => lines.push(String(m)), error: m => lines.push(String(m)) };
  const r = await demo.main({ argv: ['--port', '0', '--production-preview', '0'], env: { APP_ENV: 'development' }, out });
  t.after(() => r.close && r.close());
  assert.equal(r.code, 0, lines.join('\n'));
  const text = lines.join('\n');
  assert.match(text, /Password for every demo account: preview-only-password/);
  assert.ok(text.includes(demo.PEOPLE[0].email) && text.includes(demo.DEMO_ADMIN_EMAIL), 'who to sign in as');
  assert.match(text, /Test scenario/);

  // The demo: the owner signs in with the printed password and sees the company.
  const owner = await signIn(r.urls.dev, demo.PEOPLE[0].email, demo.DEMO_PASSWORD);
  let res = await owner.get('/business/app');
  assert.equal(res.status, 303, 'one company: straight to it');
  res = await owner.follow(res);
  assert.equal(res.status, 200);
  assert.ok(textOf(res.text).includes(demo.DEMO_COMPANY));
  // The platform admin (the command's own ADMIN_EMAILS address) opens /admin/business.
  const ops = await signIn(r.urls.dev, demo.DEMO_ADMIN_EMAIL, demo.DEMO_PASSWORD);
  assert.equal((await ops.get('/admin/business')).status, 200);

  // The production preview: plain http works (no https redirect, no Secure cookie), no supplier.
  const p = browser(r.urls.prod);
  res = await p.get('/business/start');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.headers.get('content-security-policy') || '', /upgrade-insecure-requests/);
  res = await p.post('/business/start', setFields(formOf(res.text, '/business/start'), {
    name: 'Prue Preview', email: 'prue@production-preview.example', password: demo.DEMO_PASSWORD, companyName: 'Preview Check Co (demo)', size: '1-10 people', timezone: 'Africa/Cairo', ack: '1',
  }));
  assert.equal(res.status, 303, textOf(mainOf(res.text)).slice(0, 200));
  for (const c of res.headers.getSetCookie()) assert.doesNotMatch(c, /;\s*Secure/i, 'no Secure cookie over local http');
  const B = `/business/o/${res.location.split('/')[3]}`;
  res = await p.get(`${B}/trips/new`);
  assert.equal(res.status, 200);
  assert.match(textOf(mainOf(res.text)), /Supplier not connected yet\./);
});

test('the command run directly: a refusal exits 1 with one line; a development run serves until stopped', { timeout: 60000 }, async () => {
  const run = (env, args = []) => spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const refused = run({ APP_ENV: 'production' });
  let err = '';
  refused.stderr.on('data', d => { err += d; });
  const code = await new Promise(resolve => refused.on('close', resolve));
  assert.equal(code, 1);
  assert.match(err, /only with APP_ENV=development/);

  const child = run({ APP_ENV: 'development' }, ['--port', '0']);
  let stdout = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready line: ${stdout}`)), 30000);
      child.stdout.on('data', d => { stdout += d; if (/Stop with Ctrl\+C/.test(stdout)) { clearTimeout(timer); resolve(); } });
      child.on('close', c => { clearTimeout(timer); reject(new Error(`exited ${c}: ${stdout}`)); });
    });
    const url = /Tripelyx Business demo: (http:\/\/127\.0\.0\.1:\d+)\/business/.exec(stdout)[1];
    assert.equal((await fetch(`${url}/business`)).status, 200);
  } finally {
    child.kill('SIGTERM');
  }
  const exit = await new Promise(resolve => (child.exitCode !== null ? resolve(child.exitCode) : child.on('close', resolve)));
  assert.equal(exit, 0, 'stops cleanly on SIGTERM');
});
