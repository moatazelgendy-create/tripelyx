// scripts/business-demo.js (plan §L Stage 3 step 3): the seed the private preview's boot hook awaits, and the
// development-only command. The seed goes through the BusinessService, fills only the in-memory store outside
// production, uses the preview password when there is one (and never logs it), and leaves requests in every
// state with the two test scenarios captioned wherever they show. On any price source but demo (the
// preview on supplier test keys, or no supplier) it seeds the companies, people, budgets and policy, makes no
// trips and calls no supplier, and says why in the log. The command refuses anything but
// APP_ENV=development on the in-memory store, and serves the demo (and the production preview) over http.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { startApp, FIXED_NOW, quietLog } = require('./helpers');
const { mutableClock, storeSnapshot } = require('./business-helpers');
const flows = require('./business-e2e-flows');
const { SANDBOX_ENV, blockSupplierHosts } = require('./supplier-fetch');
const demo = require('../scripts/business-demo');

const ADMIN = 'ops@tripelyx.example';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'business-demo.js');
const { textOf, mainOf, browser, formOf, setFields } = flows;

function recordingLog() {
  const lines = [];
  const at = level => (...a) => lines.push(`${level} ${a.map(String).join(' ')}`);
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error'), log: at('log') } };
}

/**
 * A development app with Business on, seeded as the preview hook seeds it ({ ...createApp result, config, log,
 * now }). `seedEnv` stands in for process.env (where the seed reads PREVIEW_PASSWORD); by default it is empty,
 * so a PREVIEW_PASSWORD in the environment running the tests never changes them.
 */
async function seeded({ env = {}, config: patch = null, seedEnv = {} } = {}) {
  const clock = mutableClock(FIXED_NOW);
  const app = await startApp({ ENABLE_BUSINESS: 'true', ADMIN_EMAILS: ADMIN, ...env }, { now: clock.now });
  const config = patch ? { ...app.config, ...patch } : app.config;
  const { lines, log } = recordingLog();
  const result = await demo.seed({ ...app, config, log, now: app.ctx.now, env: seedEnv });
  return { app, clock, lines, result };
}

/** The gate's digest of a password, as the preview config keeps it (SHA-256, a 32-byte Buffer). */
const digestOf = text => crypto.createHash('sha256').update(String(text), 'utf8').digest();

/** Every run of 4 characters of a secret: no log line may hold any of them. */
const piecesOf = secret => [...new Set(Array.from({ length: secret.length - 3 }, (_, i) => secret.slice(i, i + 4)))];
/** A password with no 4-character run that a log line would hold on its own (no words, no "[demo]"). */
const SECRET = 'Kq7#Zv9!Wx2$Pj4%';

/** The roles the plan asks for in Demo Company (preview), and who reports to whom (independent of the script's table). */
const EXPECTED_ROLES = ['employee', 'employee', 'employee', 'employee', 'finance', 'manager', 'manager', 'owner', 'travel_admin'];

/** The members of a company as the store holds them, read through the service as its owner. */
async function membersOf(app, orgId, ownerEmail) {
  const owner = await app.store.getRecord('user', await userId(app, ownerEmail));
  return (await app.business.listMembers({ org: { id: orgId }, user: owner })).members;
}

/** The roster seed() should return, built from the store: the platform admin, then each account's roles. */
async function rosterFromStore(app, result) {
  const rows = [];
  for (const c of result.companies) {
    const owner = c.name === demo.DEMO_COMPANY ? demo.PEOPLE[0].email : demo.SECOND_OWNER.email;
    for (const m of await membersOf(app, c.id, owner)) {
      if (m.status !== 'active') continue;
      let row = rows.find(r => r.email === m.email);
      if (!row) { row = { email: m.email, name: m.name, roles: [] }; rows.push(row); }
      row.roles.push({ company: c.name, role: m.roleLabel });
    }
  }
  return rows;
}

async function signIn(base, email, password) {
  const b = browser(base);
  let res = await b.get('/business/signin');
  res = await b.post('/business/signin', setFields(formOf(res.text, '/business/signin'), { email, password }));
  assert.equal(res.status, 303, `${email} signs in: ${textOf(mainOf(res.text)).slice(0, 200)}`);
  return b;
}

async function userId(app, email) { return (await app.store.getRecord('user_email', email)).userId; }
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
  // Roles, departments and managers as the store holds them (not as the script says it seeded them): an
  // Owner, a Travel Admin, Finance, two Managers and four Employees; Eli and Emma report to Mona in Sales, Ezra
  // and Esme to Milo in Engineering.
  const members = await membersOf(app, orgId, demo.PEOPLE[0].email);
  assert.deepEqual(members.filter(m => m.status === 'active').map(m => m.role).sort(), EXPECTED_ROLES);
  const member = email => members.find(m => m.email === email);
  const idOf = async key => userId(app, demo.PEOPLE.find(p => p.key === key).email);
  const expected = {
    owner: ['owner', null, null], travelAdmin: ['travel_admin', null, null], finance: ['finance', null, null],
    salesManager: ['manager', 'Sales', null], engManager: ['manager', 'Engineering', null],
    eli: ['employee', 'Sales', 'salesManager'], emma: ['employee', 'Sales', 'salesManager'],
    ezra: ['employee', 'Engineering', 'engManager'], esme: ['employee', 'Engineering', 'engManager'],
  };
  assert.deepEqual(Object.keys(expected).sort(), demo.PEOPLE.map(p => p.key).sort(), 'every demo person is checked');
  for (const [key, [role, department, manager]] of Object.entries(expected)) {
    const p = demo.PEOPLE.find(x => x.key === key);
    const m = member(p.email);
    assert.ok(m, `${p.email} is a member`);
    assert.equal(m.status, 'active', p.email);
    assert.equal(m.role, role, `${p.email} is stored as ${role}`);
    if (department) assert.equal(m.department && m.department.name, department, `${p.email} is in ${department}`);
    assert.equal(m.manager ? m.manager.userId : null, manager ? await idOf(manager) : null, `${p.email}'s manager`);
  }
  const second = await membersOf(app, org2Id, demo.SECOND_OWNER.email);
  const sharedEmail = demo.PEOPLE.find(p => p.key === demo.SHARED).email;
  assert.deepEqual(second.filter(m => m.status === 'active').map(m => [m.email, m.role]).sort(), [[demo.SECOND_OWNER.email, 'owner'], [sharedEmail, 'employee']].sort());
  // What the owner is told (who to sign in as) is what the store holds, the platform admin first.
  assert.deepEqual(result.accounts[0], { email: ADMIN, name: 'Pat Platform (demo)', roles: [{ company: null, role: 'Platform admin (/admin/business)' }] });
  const byEmail = rows => [...rows].sort((x, y) => (x.email < y.email ? -1 : 1));
  assert.deepEqual(byEmail(result.accounts.slice(1)), byEmail(await rosterFromStore(app, result)));
  assert.deepEqual(result.accounts.slice(1).map(a => a.email), [...demo.PEOPLE, demo.SECOND_OWNER].map(p => p.email), 'in the order of the people table');
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
  assert.deepEqual((await svc.policyHistory(owner, 'standard')).versions.filter(v => v.version === 2).map(v => v.note),
    ['Demo policy: Premium economy on Cairo to London, and Sahara Wings (ZS) blocked.']);
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

  // Every seeded request is a demo request that books nothing.
  for (const r of all) {
    assert.equal(r.demo, true, `${r.purpose}: a demo request`);
    assert.deepEqual(r.booking, { status: 'not_open' }, `${r.purpose}: booking is not open`);
  }
  // The log says "Test scenario" (the wrapped hotel and each scenario with its page), names every demo account
  // and its roles (who to sign in as), and never the password.
  assert.ok(lines.some(l => /Test scenario: one demo hotel room/.test(l)), lines.join('\n'));
  assert.ok(lines.every(l => !l.includes('No trip requests were seeded')), 'demo prices: the trips are seeded');
  for (const x of result.scenarios) assert.ok(lines.some(l => l.includes(x.purpose) && l.includes(`/business/o/${orgId}/trips/${x.id}`)), x.purpose);
  assert.deepEqual(result.scenarios.map(x => x.purpose).sort(), ['Test scenario: the approval window ran out', 'Test scenario: the hotel price changed before sending']);
  for (const a of result.accounts) {
    assert.ok(lines.some(l => l.includes(a.email) && a.roles.every(r => l.includes(r.role))), `the log names ${a.email} and its roles`);
  }
  assert.ok(lines.every(l => !l.includes(demo.DEMO_PASSWORD)), 'the default password is never logged');
  assert.ok(lines.every(l => !/password\s*[:=]\s*\S/i.test(l)), 'no log line gives a password');
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

  // The caption is on the scenario's page for everyone who can open it: the traveler, their manager, Finance,
  // the Travel Admin and the Owner. (The trip lists, the inbox and the CSV show route, dates and status, never
  // a purpose, so the caption cannot show there without a view change: see the Stage 3B report.)
  const fay = await signIn(app.base, email('finance'), P);
  const tara = await signIn(app.base, email('travelAdmin'), P);
  const olivia = await signIn(app.base, email('owner'), P);
  const milo = await signIn(app.base, email('engManager'), P);
  const mona = await signIn(app.base, email('salesManager'), P);
  for (const [who, label] of [[emma, 'Emma'], [mona, 'Mona'], [fay, 'Fay'], [tara, 'Tara'], [olivia, 'Olivia']]) {
    res = await who.get(`${B}/trips/${expiredId}`);
    assert.equal(res.status, 200, `${label} opens the expired scenario`);
    assert.match(textOf(flows.pageChecks(`expired scenario (${label})`, res)), /Purpose Test scenario: the approval window ran out/, `${label} sees its caption`);
  }
  const ezra = await signIn(app.base, email('ezra'), P);
  for (const [who, label] of [[ezra, 'Ezra'], [milo, 'Milo'], [fay, 'Fay'], [tara, 'Tara'], [olivia, 'Olivia']]) {
    res = await who.get(`${B}/trips/${repricedId}`);
    assert.equal(res.status, 200, `${label} opens the price-change scenario`);
    assert.match(textOf(flows.pageChecks(`price-change scenario (${label})`, res)), /Purpose Test scenario: the hotel price changed before sending/, `${label} sees its caption`);
  }
  // Each role opens what its role gives it, as the store holds the role: Tara People, Fay Reports (and not
  // Approvals), the managers Approvals, an employee neither People nor Reports.
  assert.equal((await tara.get(`${B}/people`)).status, 200, 'the Travel Admin opens People');
  assert.equal((await fay.get(`${B}/reports`)).status, 200, 'Finance opens Reports');
  assert.equal((await fay.get(`${B}/approvals`)).status, 403, 'Finance cannot open Approvals');
  assert.equal((await mona.get(`${B}/approvals`)).status, 200, 'a Manager opens Approvals');
  assert.equal((await olivia.get(`${B}/settings`)).status, 200, 'the Owner opens Settings');
  assert.equal((await ezra.get(`${B}/people`)).status, 403, 'an Employee cannot open People');
  assert.equal((await ezra.get(`${B}/reports`)).status, 403, 'an Employee cannot open Reports');

  // Ezra: the price-change scenario, with was and now, captioned; sending it again goes through at the new price.
  res = await ezra.get(`${B}/trips/${repricedId}`);
  main = flows.pageChecks('price-change scenario', res);
  assert.match(textOf(main), /Test scenario: the hotel price changed before sending/);
  assert.match(textOf(main), /This trip changed before it was sent\. Review it and send it again\. The price changed\./);
  assert.match(textOf(main), /Was \$[\d,.]+ ?, now \$[\d,.]+ ?\./);
  res = await ezra.post(`${B}/trips/${repricedId}/submit`, formOf(res.text, `${B}/trips/${repricedId}/submit`));
  assert.match(res.location || '', /\?ok=auto_approved$/, `sent again: ${res.location}`);

  // The Sales manager: the expired scenario under Expired.
  res = await mona.get(`${B}/approvals?tab=expired`);
  assert.ok(flows.pageChecks('approvals expired', res).includes(`href="${B}/trips/${expiredId}"`));
  // The Engineering manager: two requests waiting, one with his question.
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

/** Every demo account signs in with `password` and not with the default one; no log line holds any 4 characters of it. */
async function assertPreviewPassword(app, result, lines, password) {
  assert.equal(result.passwordSource, 'preview');
  assert.ok(result.accounts.length >= 11, 'the platform admin and every demo account');
  for (const a of result.accounts) {
    assert.ok(await app.accounts.authenticate({ email: a.email, password }), a.email);
    await assert.rejects(app.accounts.authenticate({ email: a.email, password: demo.DEMO_PASSWORD }), /match/);
  }
  assert.ok(lines.length > 0, 'the seed logs');
  for (const piece of piecesOf(password)) {
    const hit = lines.find(l => l.includes(piece));
    assert.ok(!hit, `no log line holds "${piece}" of the password: ${hit}`);
  }
  assert.ok(lines.every(l => !/password\s*[:=]\s*\S/i.test(l)), 'no log line gives a password');
  assert.ok(!JSON.stringify(result).includes(password), 'the result never carries it');
  // The log tells whoever reads it who to sign in as.
  for (const a of result.accounts) assert.ok(lines.some(l => l.includes(a.email)), `the log names ${a.email}`);
}

test('seed with the preview config the hook really passes (only the gate digest): PREVIEW_PASSWORD for every demo account, never logged', { timeout: 60000 }, async t => {
  // The preview's config keeps only { gate: { passwordDigest }, seed } (server/config.js on the preview
  // branch); the password itself is PREVIEW_PASSWORD in the environment.
  const config = { preview: { gate: { passwordDigest: digestOf(SECRET) }, seed: 'business' } };
  const { app, result, lines } = await seeded({ config, seedEnv: { PREVIEW_PASSWORD: SECRET } });
  t.after(app.close);
  await assertPreviewPassword(app, result, lines, SECRET);
});

test('seed takes PREVIEW_PASSWORD only when it matches the gate, and config.preview.password when the config carries one', { timeout: 60000 }, async t => {
  // An environment password that is not the gate's: the default password, and nothing of it logged.
  const other = 'Lm8&Rt5*Yu3^Nb6@';
  const a = await seeded({ config: { preview: { gate: { passwordDigest: digestOf(SECRET) }, seed: 'business' } }, seedEnv: { PREVIEW_PASSWORD: other } });
  t.after(a.app.close);
  assert.equal(a.result.passwordSource, 'default');
  assert.ok(await a.app.accounts.authenticate({ email: demo.PEOPLE[0].email, password: demo.DEMO_PASSWORD }));
  await assert.rejects(a.app.accounts.authenticate({ email: demo.PEOPLE[0].email, password: other }), /match/);
  assert.ok(a.lines.every(l => piecesOf(other).every(piece => !l.includes(piece))));
  // No gate: an environment password is never used.
  assert.equal(demo.demoPassword({ preview: { gate: null, seed: 'business' } }, { PREVIEW_PASSWORD: SECRET }).source, 'default');
  assert.equal(demo.demoPassword({}, { PREVIEW_PASSWORD: SECRET }).source, 'default');
  // A config that carries the password itself (the task's config.preview.password).
  const b = await seeded({ config: { preview: { gate: null, seed: 'business', password: SECRET } } });
  t.after(b.app.close);
  await assertPreviewPassword(b.app, b.result, b.lines, SECRET);
});

const HOOK = path.join(__dirname, '..', 'server', 'lib', 'previewSeed.js');
test('the preview boot hook end to end: loadConfig, createApp, runPreviewSeed, seed', {
  skip: !fs.existsSync(HOOK) && 'the preview boot hook (server/lib/previewSeed.js, branch biz-prev) is not in this tree yet', timeout: 60000,
}, async t => {
  const { loadConfig } = require('../server/config');
  const { createApp } = require('../server/app');
  const { runPreviewSeed } = require(HOOK);
  const env = {
    APP_ENV: 'staging', DATABASE_URL: 'memory', ENABLE_BUSINESS: 'true', ALLOW_DEMO_INVENTORY: 'true', BUSINESS_DEMO_INVENTORY: 'true',
    PREVIEW_PASSWORD: SECRET, PREVIEW_SEED: 'business', ADMIN_EMAILS: ADMIN,
  };
  const config = loadConfig(env);
  assert.ok(!JSON.stringify(config).includes(SECRET), 'the config keeps no password text');
  const built = await createApp(config, { log: quietLog });
  t.after(() => built.store.close && built.store.close());
  assert.equal(built.business.inventory.status, 'demo', 'the preview turns Business demo inventory on (BUSINESS_DEMO_INVENTORY)');
  const { lines, log } = recordingLog();
  // The hook passes no env: the seed reads process.env, as on the preview.
  const was = process.env.PREVIEW_PASSWORD;
  process.env.PREVIEW_PASSWORD = SECRET;
  let r;
  try {
    r = await runPreviewSeed(config, built, { log });
  } finally {
    if (was === undefined) delete process.env.PREVIEW_PASSWORD; else process.env.PREVIEW_PASSWORD = was;
  }
  assert.equal(r.seeded, true, lines.join('\n'));
  const emails = [ADMIN, ...demo.PEOPLE.map(p => p.email), demo.SECOND_OWNER.email];
  for (const email of emails) {
    assert.ok(await built.accounts.authenticate({ email, password: SECRET }), email);
    await assert.rejects(built.accounts.authenticate({ email, password: demo.DEMO_PASSWORD }), /match/);
    assert.ok(lines.some(l => l.includes(email)), `the boot log names ${email}`);
  }
  for (const piece of piecesOf(SECRET)) assert.ok(lines.every(l => !l.includes(piece)), `no log line holds "${piece}"`);
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
  const staging = await startApp({ APP_ENV: 'staging', DATABASE_URL: 'memory', ENABLE_BUSINESS: 'true', ADMIN_EMAILS: ADMIN, ALLOW_DEMO_INVENTORY: 'true', BUSINESS_DEMO_INVENTORY: 'true' }, { log: quietLog });
  t.after(staging.close);
  const r = await demo.seed({ ...staging, config: staging.config, log, now: staging.ctx.now });
  assert.equal(r.companies.length, 2);
});

/**
 * A Business app on `env` whose suppliers fetch only through a spy that records each URL and answers nothing
 * (and the supplier hosts blocked for the global fetch as well), seeded as the preview hook seeds it.
 */
async function seededOn(env, t) {
  const blocked = blockSupplierHosts();
  t.after(() => blocked.restore());
  const calls = [];
  const businessFetch = async url => { calls.push(String(url)); throw new Error('no supplier answers in this test'); };
  const clock = mutableClock(FIXED_NOW);
  const app = await startApp({ ...env, ADMIN_EMAILS: ADMIN }, { now: clock.now, businessFetch });
  t.after(app.close);
  const { lines, log } = recordingLog();
  const result = await demo.seed({ ...app, config: app.config, log, now: app.ctx.now, env: {} });
  return { app, result, lines, calls, blocked };
}

/** What every source seeds: both companies, every person and role, the budgets and the approval window. */
async function assertPeopleAndBudgets(app, result) {
  assert.deepEqual(result.companies.map(c => c.name), [demo.DEMO_COMPANY, demo.SECOND_COMPANY]);
  const [orgId, org2Id] = result.companies.map(c => c.id);
  for (const id of [orgId, org2Id]) assert.equal((await app.store.getRecord('biz_org', id)).status, 'active');
  const members = await membersOf(app, orgId, demo.PEOPLE[0].email);
  assert.deepEqual(members.filter(m => m.status === 'active').map(m => m.role).sort(), EXPECTED_ROLES);
  assert.deepEqual(result.accounts.map(a => a.email), [ADMIN, ...demo.PEOPLE.map(p => p.email), demo.SECOND_OWNER.email]);
  const owner = { org: { id: orgId }, user: await app.store.getRecord('user', await userId(app, demo.PEOPLE[0].email)) };
  const byName = Object.fromEntries((await app.business.listBudgets(owner, '2026-Q4')).map(b => [b.department.name, b.amountCents]));
  assert.deepEqual([byName.Sales, byName.Engineering], [1500000, 3000000], 'the budgets for the quarter');
  assert.equal((await app.store.getRecord('biz_org', orgId)).settings.approvalHours, 168, 'approvers get 7 days');
  return { orgId, org2Id, owner };
}

test('seed on the suppliers\' test systems (the preview with test keys): companies, people, budgets and policy, no trips, no supplier call, and the log says why', { timeout: 60000 }, async t => {
  const { app, result, lines, calls, blocked } = await seededOn(SANDBOX_ENV, t);
  assert.equal(app.business.inventory.source, 'sandbox', 'Business prices come from the suppliers\' test systems');
  assert.equal(app.business.inventory.hotelsConnected, true);
  assert.deepEqual(calls, [], 'the seed called no supplier');
  assert.equal(blocked.count(), 0);
  const { orgId, org2Id, owner } = await assertPeopleAndBudgets(app, result);

  // The policy: the Cairo to London route exception (the supplier inventory has both airports); ZS is the demo
  // airline, not one the suppliers list, so it is not blocked.
  assert.ok(!app.business.inventory.carriers().some(c => c.code === 'ZS'));
  const policy = await app.business.getPolicy(owner, 'standard');
  assert.equal(policy.version, 2);
  assert.deepEqual(policy.rules.flights.blockedCarriers, []);
  assert.deepEqual(policy.rules.flights.routeOverrides.map(o => [o.from, o.to, o.bothWays, o.maxCabin]), [['CAI', 'LHR', true, 'premium']]);
  const history = await app.business.policyHistory(owner, 'standard');
  assert.deepEqual(history.versions.filter(v => v.version === 2).map(v => v.note), ['Demo policy: Premium economy on Cairo to London.'], 'its note names only what it holds');

  // No trips, no scenarios, nothing wrapped.
  assert.deepEqual(await requestsOf(app, orgId), []);
  assert.deepEqual(await requestsOf(app, org2Id), []);
  assert.deepEqual([result.requests, result.scenarios], [[], []]);
  assert.ok(lines.every(l => !/Test scenario/.test(l)), 'no test scenario in the log');
  // The log says why, once, and still names who to sign in as.
  const why = lines.filter(l => l.includes('No trip requests were seeded'));
  assert.deepEqual(why, [`info [demo] ${demo.NO_TRIPS.sandbox} The companies, people, budgets and policy are ready: sign in as an employee to search for a trip.`]);
  assert.ok(lines.some(l => l.includes(`${demo.DEMO_COMPANY} (${demo.PEOPLE.length} people, 0 trip requests)`)), lines.join('\n'));
  for (const a of result.accounts) assert.ok(lines.some(l => l.includes(a.email)), `the log names ${a.email}`);
  for (const key of [SANDBOX_ENV.DUFFEL_ACCESS_TOKEN, SANDBOX_ENV.LITEAPI_API_KEY]) assert.ok(lines.every(l => !l.includes(key)), 'no key in the log');

  // The spy is the path the suppliers fetch on: an employee's own search after the seed reaches it.
  const eli = { org: { id: orgId }, user: await app.store.getRecord('user', await userId(app, demo.PEOPLE.find(p => p.key === 'eli').email)) };
  const depart = '2026-11-02';
  await app.business.searchTrip(eli, { from: 'CAI', to: 'LHR', depart, return: '2026-11-06', hotel: '1', cabin: 'economy' }).catch(() => null);
  assert.ok(calls.length > 0, 'a search calls the supplier through the same fetch the seed never used');
});

test('seed with no supplier connected (a supplier setting refused): no trips, no route or airline the inventory does not list, and the log says why', { timeout: 60000 }, async t => {
  const { app, result, lines, calls } = await seededOn({ ...SANDBOX_ENV, BUSINESS_ALLOW_SUPPLIER_TEST: 'false' }, t);
  assert.equal(app.business.inventory.status, 'none');
  assert.equal(app.business.inventory.source, null);
  assert.deepEqual(calls, []);
  const { orgId, owner } = await assertPeopleAndBudgets(app, result);
  const policy = await app.business.getPolicy(owner, 'standard');
  assert.equal(policy.version, 1, 'no new policy version: the inventory lists no airports and no airlines');
  assert.deepEqual([policy.rules.flights.blockedCarriers, policy.rules.flights.routeOverrides], [[], []]);
  assert.deepEqual(await requestsOf(app, orgId), []);
  assert.deepEqual(lines.filter(l => l.includes('No trip requests were seeded')),
    [`info [demo] ${demo.NO_TRIPS.none} The companies, people, budgets and policy are ready: sign in as an employee to search for a trip.`]);
});

test('the preview boot hook on supplier test keys, with the settings the preview workflow writes: seeded, and no supplier call at boot', {
  skip: !fs.existsSync(HOOK) && 'the preview boot hook (server/lib/previewSeed.js) is not in this tree yet', timeout: 60000,
}, async t => {
  const { loadConfig } = require('../server/config');
  const { createApp } = require('../server/app');
  const { runPreviewSeed } = require(HOOK);
  const blocked = blockSupplierHosts();
  t.after(() => blocked.restore());
  const env = {
    APP_ENV: 'staging', PORT: '4100', TRUST_PROXY: 'true', HTTPS_ONLY: 'true', DATABASE_URL: 'memory', PAYMENT_MODE: 'test',
    ALLOW_DEMO_INVENTORY: 'true', BUSINESS_DEMO_INVENTORY: 'true', ENABLE_TRIPS: 'true', ENABLE_BUSINESS: 'true', ADMIN_EMAILS: demo.DEMO_ADMIN_EMAIL, PREVIEW_SEED: 'business',
    PREVIEW_PASSWORD: SECRET,
    BUSINESS_FLIGHT_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: SANDBOX_ENV.DUFFEL_ACCESS_TOKEN, BUSINESS_ALLOW_SUPPLIER_TEST: 'true',
    BUSINESS_HOTEL_SUPPLIER: 'liteapi', LITEAPI_API_KEY: SANDBOX_ENV.LITEAPI_API_KEY,
  };
  const calls = [];
  const config = loadConfig(env);
  const built = await createApp(config, { log: quietLog, businessFetch: async url => { calls.push(String(url)); throw new Error('no supplier call at boot'); } });
  t.after(() => built.store.close && built.store.close());
  assert.equal(built.business.inventory.source, 'sandbox');
  const { lines, log } = recordingLog();
  const r = await runPreviewSeed(config, built, { log });
  assert.equal(r.seeded, true, lines.join('\n'));
  assert.deepEqual(calls, [], 'no supplier call at boot');
  assert.equal(blocked.count(), 0);
  assert.equal((await built.store.listRecords('biz_request', { limit: 10 })).length, 0);
  assert.ok(lines.some(l => l.includes(demo.NO_TRIPS.sandbox)), lines.join('\n'));
  assert.ok(lines.some(l => l.includes(demo.DEMO_ADMIN_EMAIL)), 'the demo platform admin');
  for (const piece of piecesOf(SECRET)) assert.ok(lines.every(l => !l.includes(piece)), `no log line holds "${piece}"`);
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

test('the command: arguments, and it refuses anything but APP_ENV=development on the in-memory store', async t => {
  assert.deepEqual(demo.parseArgs([]), { port: 4400, prodPort: null });
  assert.deepEqual(demo.parseArgs(['--port', '4500', '--production-preview=4501']), { port: 4500, prodPort: 4501 });
  assert.match(demo.parseArgs(['--port']).error, /needs a port/);
  assert.match(demo.parseArgs(['--port', 'x']).error, /needs a port/);
  assert.match(demo.parseArgs(['--seed']).error, /Unknown option/);
  assert.match(demo.parseArgs(['--port', '4500', '--production-preview', '4500']).error, /two different ports/);
  const out = () => { const lines = []; return { lines, log: m => lines.push(String(m)), error: m => lines.push(String(m)) }; };
  // Port 0 throughout: a refusal that regressed into a run would bind a free port (never 4400) and is closed.
  const run = async (env, argv = ['--port', '0']) => {
    const o = out();
    const r = await demo.main({ argv, env, out: o });
    if (typeof r.close === 'function') t.after(r.close);
    return { r, text: o.lines.join('\n') };
  };
  for (const env of [{}, { APP_ENV: 'staging' }, { APP_ENV: 'production' }, { APP_ENV: 'Development' }]) {
    const { r, text } = await run(env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.equal(r.close, undefined, 'nothing started');
    assert.match(text, /only with APP_ENV=development/);
  }
  for (const env of [{ APP_ENV: 'development', DATABASE_URL: 'postgres://x@127.0.0.1:9/db' }, { APP_ENV: 'development', DATABASE_HOST: 'db.internal' }]) {
    const { r, text } = await run(env);
    assert.equal(r.code, 1);
    assert.equal(r.close, undefined, 'nothing started');
    assert.match(text, /only fills the in-memory store/);
  }
  assert.equal((await run({ APP_ENV: 'development' }, ['--nope'])).r.code, 2);
});

test('the command: the demo and the production preview, in this process, over plain http', { timeout: 60000 }, async t => {
  const lines = [];
  const out = { log: m => lines.push(String(m)), error: m => lines.push(String(m)) };
  const r = await demo.main({ argv: ['--port', '0', '--production-preview', '0'], env: { APP_ENV: 'development' }, out });
  t.after(() => r.close && r.close());
  assert.equal(r.code, 0, lines.join('\n'));
  const text = lines.join('\n');
  assert.match(text, /Password for every demo account: preview-only-password/);
  for (const a of r.result.accounts) assert.ok(text.includes(a.email), `who to sign in as: ${a.email}`);
  assert.ok(text.includes(demo.DEMO_ADMIN_EMAIL), 'the platform admin');
  for (const x of r.result.scenarios) assert.ok(text.includes(`${x.purpose}: ${r.urls.dev}${x.path}`), `where to find "${x.purpose}"`);

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

  // The production preview: plain http works (no https redirect, no HSTS, no Secure cookie), no supplier, and
  // its own empty store: a demo account does not exist there.
  const p = browser(r.urls.prod);
  res = await p.get('/business/start');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.headers.get('content-security-policy') || '', /upgrade-insecure-requests/);
  assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS over local http');
  const stranger = browser(r.urls.prod);
  res = await stranger.get('/business/signin');
  res = await stranger.post('/business/signin', setFields(formOf(res.text, '/business/signin'), { email: demo.PEOPLE[0].email, password: demo.DEMO_PASSWORD }));
  assert.equal(res.status, 401, 'a demo account cannot sign in on the production preview');
  assert.match(textOf(mainOf(res.text)), /That email and password don.t match an account\./);
  assert.equal(stranger.jar.size, 0, 'and gets no session');
  res = await p.get('/business/start');
  res = await p.post('/business/start', setFields(formOf(res.text, '/business/start'), {
    name: 'Prue Preview', email: 'prue@production-preview.example', password: demo.DEMO_PASSWORD, companyName: 'Preview Check Co (demo)', size: '1-10 people', timezone: 'Africa/Cairo', ack: '1',
  }));
  assert.equal(res.status, 303, textOf(mainOf(res.text)).slice(0, 200));
  for (const c of res.headers.getSetCookie()) assert.doesNotMatch(c, /;\s*Secure/i, 'no Secure cookie over local http');
  const B = `/business/o/${res.location.split('/')[3]}`;
  res = await p.get(`${B}/trips/new`);
  assert.equal(res.status, 200);
  assert.match(textOf(mainOf(res.text)), /Supplier not connected yet\./);
  assert.equal(res.headers.get('strict-transport-security'), null);
});

test('the command takes DATABASE_URL=memory (the in-memory store, said explicitly)', { timeout: 60000 }, async t => {
  const lines = [];
  const out = { log: m => lines.push(String(m)), error: m => lines.push(String(m)) };
  const r = await demo.main({ argv: ['--port', '0'], env: { APP_ENV: 'development', DATABASE_URL: 'memory' }, out });
  t.after(() => r.close && r.close());
  assert.equal(r.code, 0, lines.join('\n'));
  assert.equal(r.urls.prod, null, 'no production preview unless asked');
  assert.equal((await fetch(`${r.urls.dev}/business`)).status, 200);
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
