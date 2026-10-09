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
  assert.deepEqual(statuses, { within: 'approved', approve: 'approved', deny: 'denied', ask: 'pending' });
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
  await flows.expiryFlow(w);
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
      const accept = await tara.post(`/business/invite/${token}/accept`, {});
      assert.ok(accept.status >= 400 && accept.status < 500, `accept refused while pending (${accept.status})`);
      assert.deepEqual((await w.app.store.getRecord('biz_user_index', taraId)).orgIds, before.orgIds, 'nobody joined');
      // A member who is no platform admin cannot confirm it, and cannot open the platform list.
      assert.equal((await tara.get('/admin/business')).status, 404);
      const forged = await tara.post(`/admin/business/${org2}/status`, { status: 'active', rev: '0' });
      assert.equal(forged.status, 404, 'a non-admin POST to the platform route is 404');
      assert.equal((await w.app.store.getRecord('biz_org', org2)).status, 'pending');
    },
  });
  // Confirmed: the activity log names Tripelyx, and Sam is in both companies.
  const activity = await w.owner.get(`${w.B2}/activity`);
  assert.match(flows.textOf(flows.mainOf(activity.text)), /Tripelyx/, 'the confirmation is in the activity log, by Tripelyx');
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
});
