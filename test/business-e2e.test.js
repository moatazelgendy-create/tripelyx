// Tripelyx Business end to end (plan §L Stage 3, §A3): the full HTTP flows on the real modules, as a person
// clicks them, with every form read from the page (test/business-e2e-flows.js). Then the scenarios the walk
// cannot show on a held clock or a fixed price: expiry (mutableClock), a price change returning a trip (an
// inventory override on the real seam), cancel releasing the budget hold; and the production config with no
// supplier ("Supplier not connected yet", sign-up still working). With TEST_DATABASE_URL the walk also runs on
// PostgresStore.
const test = require('node:test');
const assert = require('node:assert/strict');
const flows = require('./business-e2e-flows');

const { devWorld, prodWorld } = flows;

test('A3 walk over HTTP: sign-up, platform confirm, policies, budgets, invites, trips, decisions, reports, CSV, settings, switcher', { timeout: 120000 }, async t => {
  const w = await devWorld();
  t.after(w.close);
  await flows.a3Walk(w, (name, fn) => t.test(name, fn));
  // What the walk left behind, as the store has it: one trip in each state the walk reached.
  const statuses = {};
  for (const [k, rid] of Object.entries(w.rids)) statuses[k] = (await w.app.store.getRecord('biz_request', rid)).status;
  assert.deepEqual(statuses, { within: 'approved', approve: 'approved', deny: 'denied', ask: 'pending', window: 'pending' });
  const within = await w.app.store.getRecord('biz_request', w.rids.within);
  assert.deepEqual(within.approval.decidedBy, { system: 'policy' }, 'the trip inside policy was approved by policy');
  const approved = await w.app.store.getRecord('biz_request', w.rids.approve);
  assert.equal(approved.approval.mode, 'manual');
  assert.ok(approved.history.some(h => h.action === 'swapped' && h.savedCents > 0), 'the swap is in its history with what it saved');
  // The Engineering budget holds exactly the two approved trips.
  const budget = await w.app.store.getRecord('biz_budget', `${w.orgId}.${w.deptIds.Engineering}.2026-Q4`);
  assert.deepEqual(Object.keys(budget.commits).sort(), [w.rids.within, w.rids.approve].sort());
  assert.equal(Object.values(budget.commits).reduce((s, c) => s + (typeof c === 'number' ? c : c.cents), 0), within.totalCents + approved.totalCents);
});

test('expiry: a request left pending past its approval window shows Expired with no write; a decision then is refused with 409 and persists it', { timeout: 60000 }, async t => {
  const w = await devWorld();
  t.after(w.close);
  await flows.company(w);
  assert.equal((await w.app.store.getRecord('biz_org', w.orgId)).settings.approvalHours, 24, 'a new company gives approvers 24 hours');
  await flows.expiryFlow(w);
});

test('who may decide: a manager of another department cannot see or decide a trip; nobody decides their own (Manager or Owner), each a 404 with no write; another admin decides the Owner\'s trip', { timeout: 60000 }, async t => {
  const w = await devWorld();
  t.after(w.close);
  await flows.company(w);
  await flows.deciderScopeFlow(w);
});

test('a price change sends a trip back: before it is sent (was and now, then approved by policy at the new price) and while it waits (the approval returns it)', { timeout: 60000 }, async t => {
  const w = await devWorld();
  t.after(w.close);
  await flows.company(w);
  await flows.priceChangeFlow(w);
  // The override is gone: the live inventory is the app's own again.
  assert.equal(w.app.business.composer.inventory, w.app.business.inventory);
  assert.equal(w.app.business.inventory.flights.name, 'BusinessDemoFlights');
});

test('cancel releases the budget hold of an approved trip, in two steps, and the budget reads as before', { timeout: 60000 }, async t => {
  const w = await devWorld();
  t.after(w.close);
  await flows.company(w);
  await flows.cancelFlow(w);
});

test('platform confirm and the switcher: a second company waits for Tripelyx (no joining, no staff powers for members), then a member of both switches between them', { timeout: 60000 }, async t => {
  const w = await devWorld();
  t.after(w.close);
  await flows.company(w);
  await flows.employeeWithin(w);
  const sam = w.people.employee.b;
  await flows.switcher(w, {
    beforeConfirm: async (org2, B2) => {
      const { owner, names } = w;
      let res = await owner.get(`${B2}/people`);
      assert.equal(res.status, 200);
      assert.ok(flows.textOf(res.text).includes(`Tripelyx is confirming ${names.second}`), 'the second company is pending');
      // An invite can be made while pending, but not accepted.
      res = await owner.post(`${B2}/people/invite`, flows.setFields(flows.fieldsOf(flows.formsOf(res.text, `${B2}/people/invite`)[0] || ''), { email: names.email('tara'), role: 'employee' }));
      assert.equal(res.status, 200, 'the invite link page');
      const token = (/\/business\/invite\/([A-Za-z0-9_-]{16,})/.exec(res.text) || [])[1];
      const tara = w.people.travelAdmin.b;
      const landing = await tara.get(`/business/invite/${token}`);
      assert.equal(landing.status, 409, 'the landing says the company is not confirmed yet');
      assert.ok(flows.textOf(flows.mainOf(landing.text)).includes(`${names.second} is waiting for Tripelyx to confirm it`), flows.textOf(flows.mainOf(landing.text)).slice(0, 300));
      assert.equal(flows.formsOf(landing.text, `/business/invite/${token}/accept`).length, 0, 'no accept form while the company is pending');
      const taraId = (await w.app.store.getRecord('user_email', names.email('tara'))).userId;
      const before = await w.app.store.getRecord('biz_user_index', taraId);
      // The accept, as a browser would send it (the rendered page has no form, so the fields are the token's own):
      // refused with the same words, and nothing is written (no member, no used invite, no audit).
      await flows.refused(w, 'accept while the company is pending', () => tara.post(`/business/invite/${token}/accept`, {}), {
        status: 409, text: new RegExp(`${names.second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is waiting for Tripelyx to confirm it`),
      });
      assert.deepEqual((await w.app.store.getRecord('biz_user_index', taraId)).orgIds, before.orgIds, 'nobody joined');
      // A member who is no platform admin cannot confirm it, and cannot open the platform list.
      assert.equal((await tara.get('/admin/business')).status, 404);
      const org = await w.app.store.getRecord('biz_org', org2);
      await flows.refused(w, 'a non-admin POST to the platform route', () => tara.post(`/admin/business/${org2}/status`, { status: 'active', rev: String(org.rev) }), { status: 404 });
      assert.equal((await w.app.store.getRecord('biz_org', org2)).status, 'pending');
    },
  });
  // Confirmed: the activity log says Tripelyx confirmed it (the exact rows are checked in the switcher flow),
  // and Sam is in both companies.
  const activity = await w.owner.get(`${w.B2}/activity`);
  assert.deepEqual(flows.activityRows(activity.text).map(r => r.text).filter(x => /Tripelyx/.test(x)), [`Tripelyx confirmed ${w.names.second} 12:00 PM today · Company`]);
  const samId = (await w.app.store.getRecord('user_email', w.names.email('sam'))).userId;
  assert.equal((await w.app.store.getRecord('biz_user_index', samId)).orgIds.length, 2);
  assert.equal((await sam.get(w.B)).status, 200);
  assert.equal((await sam.get(w.B2)).status, 200);
});

test('production config: APP_ENV=production, a dummy DATABASE_URL, trips off, Business on: "Supplier not connected yet" and sign-up still works', { timeout: 60000 }, async t => {
  const p = await prodWorld();
  t.after(p.close);
  await flows.productionFlow(p);
});

test('Postgres: the A3 walk on PostgresStore', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set', timeout: 180000 }, async t => {
  const tag = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const w = await devWorld({ tag, env: { DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_SSL: 'false', BUSINESS_COMPUTE_LIMIT: '200' } });
  t.after(w.close);
  assert.equal(w.app.store.kind, 'postgres');
  await flows.a3Walk(w, (name, fn) => t.test(name, fn));
  await flows.signIn(w, 'employee');
  await flows.cancelFlow(w);
  await flows.priceChangeFlow(w);
  await flows.expiryFlow(w);
  await flows.deciderScopeFlow(w);
});

test('ROUTES, frozen: every Business route with its permission, request gate, limiters and who may call it (public, traveler, admin and platform)', () => {
  const business = require('../server/routes/business');
  const platform = require('../server/routes/businessPlatform');
  const row = r => [r.method, r.path, r.perm, r.own, r.limiter.join('+'), r.who];
  const VIEW = ['request.view.own', 'request.view.team', 'request.view.all'];
  assert.deepEqual(business.ROUTES.map(row), [
    // public
    ['GET', '/start', null, false, '', 'anyone'],
    ['POST', '/start', null, false, 'bizAuthIp', 'anyone'],
    ['GET', '/signin', null, false, '', 'anyone'],
    ['POST', '/signin', null, false, 'bizAuthIp+bizAuthAccount', 'anyone'],
    ['POST', '/signout', null, false, 'bizWrite', 'user'],
    ['GET', '/invite/:token', null, false, '', 'anyone'],
    ['POST', '/invite/:token/accept', null, false, 'bizAuthIp', 'user'],
    ['POST', '/invite/:token/join', null, false, 'bizAuthIp', 'anyone'],
    ['GET', '/app', null, false, '', 'user'],
    // traveler
    ['GET', '/o/:orgId', 'org.view', false, '', 'member'],
    ['GET', '/o/:orgId/policy', 'org.view', false, '', 'member'],
    ['GET', '/o/:orgId/trips/new', 'trip.request', false, '', 'member'],
    ['GET', '/o/:orgId/trips/search', 'trip.request', false, 'bizCompute', 'member'],
    ['POST', '/o/:orgId/trips', 'trip.request', false, 'bizWrite+bizCompute', 'member'],
    ['GET', '/o/:orgId/trips', VIEW, false, '', 'member'],
    ['GET', '/o/:orgId/trips/:rid', [...VIEW, 'approval.decide', 'approval.override'], 'request', '', 'member'],
    ['POST', '/o/:orgId/trips/:rid/swap', 'request.view.own', 'request', 'bizWrite+bizCompute', 'member'],
    ['POST', '/o/:orgId/trips/:rid/submit', 'request.view.own', 'request', 'bizWrite+bizCompute', 'member'],
    ['POST', '/o/:orgId/trips/:rid/cancel', ['request.view.own', 'approval.override'], 'request', 'bizWrite', 'member'],
    ['POST', '/o/:orgId/trips/:rid/decide', ['approval.decide', 'approval.override'], 'request', 'bizWrite+bizCompute', 'member'],
    ['POST', '/o/:orgId/trips/:rid/message', ['request.view.own', 'approval.decide', 'approval.override'], 'request', 'bizWrite', 'member'],
    ['GET', '/o/:orgId/approvals', 'approval.decide', false, '', 'member'],
    // admin
    ['GET', '/o/:orgId/welcome', 'settings.company', false, '', 'member'],
    ['GET', '/o/:orgId/policies', 'policy.view.all', false, '', 'member'],
    ['GET', '/o/:orgId/policies/:tier', 'policy.view.all', false, '', 'member'],
    ['POST', '/o/:orgId/policies/:tier', 'policy.edit', false, 'bizWrite', 'member'],
    ['GET', '/o/:orgId/policies/:tier/history', 'policy.view.all', false, '', 'member'],
    ['GET', '/o/:orgId/budgets', ['budget.view.dept', 'budget.view.all'], false, '', 'member'],
    ['POST', '/o/:orgId/budgets', 'budget.edit', false, 'bizWrite', 'member'],
    ['GET', '/o/:orgId/people', 'members.view', false, '', 'member'],
    ['POST', '/o/:orgId/people/invite', 'members.manage', false, 'bizWrite', 'member'],
    ['POST', '/o/:orgId/people/invites/:publicId/revoke', 'members.manage', false, 'bizWrite', 'member'],
    ['POST', '/o/:orgId/people/:userId', 'members.manage', false, 'bizWrite', 'member'],
    ['POST', '/o/:orgId/people/:userId/remove', 'members.manage', false, 'bizWrite', 'member'],
    ['POST', '/o/:orgId/departments', 'departments.manage', false, 'bizWrite', 'member'],
    ['GET', '/o/:orgId/reports', 'reports.view', false, '', 'member'],
    ['POST', '/o/:orgId/reports/export', 'reports.export', false, 'bizWrite', 'member'],
    ['GET', '/o/:orgId/activity', 'audit.view', false, '', 'member'],
    ['GET', '/o/:orgId/settings', 'org.view', false, '', 'member'],
    ['POST', '/o/:orgId/settings', ['settings.company', 'settings.travel'], false, 'bizWrite', 'member'],
    ['POST', '/o/:orgId/settings/export', 'settings.company', false, 'bizWrite', 'member'],
  ]);
  assert.equal(platform.MOUNT, '/admin/business');
  assert.deepEqual(platform.ROUTES.map(row), [
    ['GET', '/', null, false, '', 'platform'],
    ['POST', '/:orgId/status', null, false, 'bizWrite', 'platform'],
    ['POST', '/house', null, false, 'bizWrite', 'platform'],
    ['POST', '/suppliers/check', null, false, 'bizWrite', 'platform'],
    ['POST', '/suppliers/live', null, false, 'bizWrite', 'platform'],
  ]);
  for (const r of [...business.ROUTES, ...platform.ROUTES]) {
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.limiter), `${r.method} ${r.path} is frozen`);
    if (Array.isArray(r.perm)) assert.ok(Object.isFrozen(r.perm), `${r.method} ${r.path}: its permissions are frozen`);
  }
  for (const file of ['public', 'traveler', 'admin']) assert.ok(Object.isFrozen(require(`../server/routes/business/${file}`).ROUTES), `the ${file} table is frozen`);
  assert.ok(Object.isFrozen(platform.ROUTES), 'the platform table is frozen');
});
