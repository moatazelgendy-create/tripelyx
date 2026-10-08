// Stage 1W-b: department budgets (plan §C6, §H4) and travel policies (§E, the policy pages), through
// BusinessService against the frozen fakes on a MemoryStore.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { Accounts } = require('../server/accounts');
const { loadConfig } = require('../server/config');
const { Repo } = require('../server/business/repo');
const { BusinessService } = require('../server/business/service');
const { KINDS } = require('../server/business/constants');
const { HISTORY_PAGE } = require('../server/business/policies');
const fakes = require('./business-fakes');
const { seedUser, seedOrg, seedMember, seedDepartment, seedBudget, mutableClock, storeSnapshot } = require('./business-helpers');
const { FIXED_NOW, quietLog } = require('./helpers');

const Q = { from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1' };
const OUTSIDE = { out: 'f.flt_fake_CAILHR_2026-11-12_1|FLEX', back: 'f.flt_fake_LHRCAI_2026-11-16_4|LIGHT', hotelKey: 'h.htl_fake_LHR_3|STD' };
const WITHIN = { out: 'f.flt_fake_CAILHR_2026-11-12_4|LIGHT', back: 'f.flt_fake_LHRCAI_2026-11-16_4|LIGHT', hotelKey: 'h.htl_fake_LHR_3|STD' };
const code = c => e => { assert.equal(e.code, c, `${e.code}: ${e.message}`); return true; };

async function world({ settings = {} } = {}) {
  const store = new MemoryStore();
  const clock = mutableClock(FIXED_NOW);
  const now = clock.now;
  const config = loadConfig({});
  const app = { store, accounts: new Accounts({ store, config, now }), ctx: { now } };
  const ownerU = await seedUser(app, { name: 'Olive Owner' });
  const org = await seedOrg(app, ownerU, { settings });
  const inventory = fakes.fakeInventory();
  const policy = fakes.fakePolicy();
  const svc = new BusinessService({
    repo: new Repo({ store, now }), config, now, log: quietLog, inventory, composer: fakes.fakeComposer({ inventory, now }), policy,
    alternatives: fakes.fakeAlternatives(), explainer: fakes.fakeExplainer(),
  });
  const eng = await seedDepartment(app, org, { name: 'Engineering' });
  const sales = await seedDepartment(app, org, { name: 'Sales' });
  const old = await seedDepartment(app, org, { name: 'Old Team', archived: true });
  const manager = await seedMember(app, org, 'manager', { name: 'Dana Lee', departmentId: eng.id });
  const traveler = await seedMember(app, org, 'employee', { name: 'Sam Traveler', departmentId: eng.id, managerId: manager.user.id });
  const admin = await seedMember(app, org, 'travel_admin', { name: 'Tara Admin', departmentId: org.general.id });
  const finance = await seedMember(app, org, 'finance', { name: 'Fin Ance', departmentId: org.general.id });
  const as = who => ({ org: { id: org.id }, user: who.user });
  return { app, store, clock, org, svc, repo: svc.repo, policy, eng, sales, old, manager, traveler, admin, finance, as, owner: { user: ownerU.user } };
}
const audits = async (w, action) => (await w.repo.page(KINDS.audit, w.org.id, { limit: 200 })).rows.filter(a => a.action === action);

// ---------------------------------------------------------------------------------------------------------
// Budgets

test('listBudgets: committed, awaiting and remaining per department; view.dept sees only its own', async () => {
  const w = await world();
  await seedBudget(w.app, w.org, w.eng.id, { amountCents: 500000, commits: { btr_a: 100000, btr_b: 25000 } });
  // A pending request in Engineering for Q4 (awaiting), and one in Q1 2027 (another period).
  const t = w.as(w.traveler);
  for (const [query, selection] of [[Q, OUTSIDE], [{ ...Q, depart: '2027-01-12', return: '2027-01-16' }, {
    out: 'f.flt_fake_CAILHR_2027-01-12_1|FLEX', back: 'f.flt_fake_LHRCAI_2027-01-16_4|LIGHT', hotelKey: 'h.htl_fake_LHR_3|STD',
  }]]) {
    const r = await w.svc.createRequest(t, { query, selection, purpose: 'Client visit' });
    await w.svc.submit(t, r.id, { rev: r.rev, reason: 'Meeting the client at their office.' });
  }
  const before = storeSnapshot(w.app);
  const rows = await w.svc.listBudgets(w.as(w.finance), null);
  assert.equal(storeSnapshot(w.app), before, 'a GET writes nothing');
  assert.deepEqual(rows.map(r => r.department.name), ['Engineering', 'General', 'Sales'], 'archived without a budget is left out');
  const eng = rows[0];
  assert.equal(eng.periodKey, '2026-Q4');
  assert.equal(eng.budgetId, `${w.org.id}.${w.eng.id}.2026-Q4`);
  assert.equal(eng.amountCents, 500000);
  assert.equal(eng.committedCents, 125000);
  assert.equal(eng.awaitingCents, 66200 + 30800 + 79800, 'pending is awaiting, never committed');
  assert.equal(eng.remainingCents, 375000);
  assert.equal(eng.rev, 0);
  assert.equal(eng.truncated, false);
  assert.deepEqual([rows[1].budgetId, rows[1].amountCents, rows[1].remainingCents, rows[1].rev, rows[1].committedCents], [null, null, null, null, 0]);
  assert.equal((await w.svc.listBudgets(w.as(w.finance), '2027-Q1'))[0].awaitingCents, 66200 + 30800 + 79800);

  // The archived department shows once it has a budget for the period.
  await seedBudget(w.app, w.org, w.old.id, { amountCents: 1000 });
  const withOld = await w.svc.listBudgets(w.as(w.owner), '2026-Q4');
  assert.deepEqual(withOld.map(r => [r.department.name, r.department.archived]), [['Engineering', false], ['General', false], ['Sales', false], ['Old Team', true]]);

  // budget.view.dept: the member's own department only.
  assert.deepEqual((await w.svc.listBudgets(w.as(w.manager), null)).map(r => r.department.name), ['Engineering']);
  const nodep = await seedMember(w.app, w.org, 'manager', { name: 'No Dept' });
  assert.deepEqual(await w.svc.listBudgets(w.as(nodep), null), []);
  await assert.rejects(w.svc.listBudgets(w.as(w.traveler), null), e => e.status === 403);
  await assert.rejects(w.svc.listBudgets(w.as(w.finance), '2026-Q5'), code('invalid_period'));
});

test('setBudget: insert, change on the current rev, audit with amounts; stale or racing forms answer 409', async () => {
  const w = await world();
  const f = w.as(w.finance);
  const b = await w.svc.setBudget(f, w.eng.id, '2026-Q4', '', '12,500');
  assert.equal(b.amountCents, 1250000);
  assert.equal(b.rev, 0);
  assert.deepEqual(b.commits, {});
  const [a1] = await audits(w, 'budget.set');
  assert.equal(a1.summary, 'Fin Ance set the Engineering budget for Q4 2026 to $12,500');
  assert.deepEqual(a1.changes, [{ path: 'amountCents', before: null, after: 1250000 }]);
  await assert.rejects(w.svc.setBudget(f, w.eng.id, '2026-Q4', '', '1'), e => e.code === 'conflict' && e.status === 409, 'a budget created meanwhile');

  const b2 = await w.svc.setBudget(f, w.eng.id, '2026-Q4', '0', '10000');
  assert.equal(b2.amountCents, 1000000);
  assert.equal(b2.rev, 1);
  await assert.rejects(w.svc.setBudget(f, w.eng.id, '2026-Q4', '0', '9000'), code('conflict'));
  const same = await w.svc.setBudget(f, w.eng.id, '2026-Q4', 1, '10000');
  assert.equal(same.rev, 1, 'an unchanged amount writes nothing');
  assert.equal((await audits(w, 'budget.set')).length, 2);

  // Holds are kept when the amount changes, and a budget may go below what is committed.
  await w.repo.cas(KINDS.budget, `${w.org.id}.${w.eng.id}.2026-Q4`, null, d => { d.commits.btr_x = 600000; });
  const low = await w.svc.setBudget(f, w.eng.id, '2026-Q4', 2, '5000');
  assert.deepEqual(low.commits, { btr_x: 600000 });
  assert.equal((await w.svc.listBudgets(f, '2026-Q4')).find(r => r.department.id === w.eng.id).remainingCents, -100000);

  const racing = await Promise.allSettled(['7000', '8000'].map(v => w.svc.setBudget(f, w.eng.id, '2026-Q4', 3, v)));
  assert.equal(racing.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(racing.find(r => r.status === 'rejected').reason.code, 'conflict');
});

test('setBudget refuses bad amounts, the wrong period kind, archived or foreign departments and roles without budget.edit', async () => {
  const w = await world();
  const f = w.as(w.finance);
  await assert.rejects(w.svc.setBudget(f, w.eng.id, '2026-11', '', '100'), e => e.code === 'invalid_budget' && /quarter/.test(e.details.period));
  await assert.rejects(w.svc.setBudget(f, w.eng.id, '2026-Q4', '', 'lots'), e => e.code === 'invalid_budget' && !!e.details.amount);
  await assert.rejects(w.svc.setBudget(f, w.eng.id, 'soon', '', '-5'), e => e.code === 'invalid_budget' && !!e.details.amount && !!e.details.period);
  await assert.rejects(w.svc.setBudget(f, w.old.id, '2026-Q4', '', '100'), code('not_found'));
  await assert.rejects(w.svc.setBudget(f, 'dep_AAAAAAAAAAAAAAAA', '2026-Q4', '', '100'), code('not_found'));
  await assert.rejects(w.svc.setBudget(w.as(w.admin), w.eng.id, '2026-Q4', '', '100'), e => e.status === 403, 'travel admins view budgets but do not set them');
  await assert.rejects(w.svc.setBudget(f, w.eng.id, '2026-Q4', '4', '100'), code('not_found'), 'a rev for a budget that does not exist');
  const monthly = await world({ settings: { budgetPeriod: 'month' } });
  await assert.rejects(monthly.svc.setBudget(monthly.as(monthly.finance), monthly.eng.id, '2026-Q4', '', '100'), e => /month/.test(e.details.period));
  assert.equal((await monthly.svc.setBudget(monthly.as(monthly.finance), monthly.eng.id, '2026-11', '', '100')).periodKey, '2026-11');
  assert.equal((await monthly.svc.listBudgets(monthly.as(monthly.finance), null))[0].periodKey, '2026-10');
  assert.equal((await audits(w, 'budget.set')).length, 0, 'nothing was written');
});

test('a budget hold follows the departure\'s period and department, and a cancellation gives it back', async () => {
  const w = await world();
  const f = w.as(w.finance);
  await w.svc.setBudget(f, w.eng.id, '2026-Q4', '', '5000');
  const t = w.as(w.traveler);
  const r = await w.svc.createRequest(t, { query: Q, selection: WITHIN, purpose: 'Client visit' });
  const ok = (await w.svc.submit(t, r.id, { rev: r.rev })).request;
  const row = (await w.svc.listBudgets(f, '2026-Q4')).find(x => x.department.id === w.eng.id);
  assert.equal(row.committedCents, ok.totalCents);
  assert.equal(row.remainingCents, 500000 - ok.totalCents);
  await w.svc.cancel(t, r.id, { rev: ok.rev });
  assert.equal((await w.svc.listBudgets(f, '2026-Q4')).find(x => x.department.id === w.eng.id).committedCents, 0);
});

// ---------------------------------------------------------------------------------------------------------
// Policies

test('getPolicy: the member\'s own tier for everyone; other tiers need policy.view.all; the form only for editors', async () => {
  const w = await world();
  const mine = await w.svc.getPolicy(w.as(w.traveler), null);
  assert.equal(mine.tier, 'standard');
  assert.equal(mine.version, 1);
  assert.equal(mine.defaults, true);
  assert.equal(mine.canEdit, false);
  assert.equal(mine.form, null);
  assert.equal(mine.description.title, 'Your travel policy');
  assert.equal(mine.description.sub, 'Standard policy, version 1');
  assert.ok(mine.description.lines.some(l => l.includes("Sahara Wings isn't used by Acme Inc.")), 'carriers by name, never code');
  await assert.rejects(w.svc.getPolicy(w.as(w.traveler), 'executive'), e => e.status === 403);
  await assert.rejects(w.svc.getPolicy(w.as(w.finance), 'nope'), code('not_found'));
  const exec = await w.svc.getPolicy(w.as(w.finance), 'executive');
  assert.equal(exec.tier, 'executive');
  assert.equal(exec.form, null);
  const edit = await w.svc.getPolicy(w.as(w.admin), 'director');
  assert.equal(edit.canEdit, true);
  assert.deepEqual(Object.keys(edit.form).sort(), ['hotel.default', 'longHaulMinutes']);
  assert.ok(edit.refs.carriers.some(c => c.code === 'ZS' && c.name === 'Sahara Wings'));
  assert.ok(edit.refs.airports.some(a => a.code === 'LHR' && a.city === 'London'));
  assert.ok(edit.refs.countries.includes('United Kingdom'));
});

test('savePolicy writes version n+1, its version record and the audit atomically; a stale rev answers 409', async () => {
  const w = await world();
  const t = w.as(w.admin);
  const before = await w.svc.getPolicy(t, 'standard');
  const res = await w.svc.savePolicy(t, 'standard', { form: { longHaulMinutes: '420', 'hotel.default': '250' }, rev: before.rev, note: 'Longer flights count as long haul.' });
  assert.equal(res.policy.version, 2);
  assert.equal(res.policy.rev, 1);
  assert.equal(res.policy.rules.flights.longHaulMinutes, 420);
  assert.equal(res.policy.rules.hotels.defaultNightlyCents, 25000);
  assert.deepEqual(res.policy.updatedBy, { userId: w.admin.user.id, name: 'Tara Admin', role: 'travel_admin' });
  assert.equal(res.version.version, 2);
  assert.equal(res.version.note, 'Longer flights count as long haul.');
  assert.ok(res.version.changes.some(c => c.path === 'flights.longHaulMinutes' && c.after === 420));
  assert.deepEqual(await w.repo.get(KINDS.policyVersion, `${w.org.id}.standard.v2`), res.version);
  const [audit] = await audits(w, 'policy.published');
  assert.equal(audit.summary, 'Tara Admin published the Standard policy, version 2 (was version 1)');
  assert.deepEqual(audit.changes, res.version.changes);
  assert.equal((await w.svc.getPolicy(w.as(w.traveler), null)).defaults, false);

  // The same form again: nothing changed, nothing written.
  const same = await w.svc.savePolicy(t, 'standard', { form: { longHaulMinutes: '420', 'hotel.default': '250' }, rev: 1 });
  assert.equal(same.version, null);
  assert.equal(same.policy.rev, 1);
  // A form opened before the save is stale.
  await assert.rejects(w.svc.savePolicy(t, 'standard', { form: { longHaulMinutes: '500' }, rev: before.rev }), e => e.code === 'conflict' && e.status === 409);
  await assert.rejects(w.svc.savePolicy(t, 'standard', { form: { longHaulMinutes: '5' }, rev: 1 }), e => e.code === 'invalid_policy' && !!e.details.longHaulMinutes);
  await assert.rejects(w.svc.savePolicy(w.as(w.finance), 'standard', { form: { longHaulMinutes: '500' }, rev: 1 }), e => e.status === 403);
  await assert.rejects(w.svc.savePolicy(t, 'gold', { form: {}, rev: 0 }), code('not_found'));

  // All or nothing: when the version record cannot be inserted, the policy and the audit are not written either.
  await w.repo.insert(KINDS.policyVersion, `${w.org.id}.standard.v3`, { orgId: w.org.id, tier: 'standard', version: 3, rules: {}, at: FIXED_NOW, by: {}, note: '', changes: [] }, { owner: w.org.id });
  await assert.rejects(w.svc.savePolicy(t, 'standard', { form: { longHaulMinutes: '480', 'hotel.default': '250' }, rev: 1 }), code('conflict'));
  const stored = await w.repo.get(KINDS.policy, `${w.org.id}.standard`);
  assert.equal(stored.version, 2);
  assert.equal(stored.rev, 1);
  assert.equal((await audits(w, 'policy.published')).length, 1);

  // Two editors racing on the same rev: exactly one publishes.
  const racing = await Promise.allSettled(['600', '700'].map(m => w.svc.savePolicy(t, 'director', { form: { longHaulMinutes: m, 'hotel.default': '' }, rev: 0 })));
  assert.equal(racing.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await w.repo.get(KINDS.policy, `${w.org.id}.director`)).version, 2);
});

test('policyHistory pages versions newest first, HISTORY_PAGE at a time', async () => {
  const w = await world();
  const t = w.as(w.owner);
  for (let i = 0; i < 12; i += 1) {
    const cur = await w.repo.get(KINDS.policy, `${w.org.id}.executive`);
    await w.svc.savePolicy(t, 'executive', { form: { longHaulMinutes: String(400 + i), 'hotel.default': '' }, rev: cur.rev });
  }
  const p1 = await w.svc.policyHistory(t, 'executive', {});
  assert.equal(p1.versions.length, HISTORY_PAGE);
  assert.deepEqual(p1.versions.map(v => v.version), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  assert.equal(p1.older, 4);
  const p2 = await w.svc.policyHistory(t, 'executive', { before: p1.older });
  assert.deepEqual(p2.versions.map(v => v.version), [3, 2, 1]);
  assert.equal(p2.older, null);
  assert.equal(p2.versions[2].changes.length, 0, 'version 1 is the starting rules');
  await assert.rejects(w.svc.policyHistory(t, 'executive', { before: 99 }), code('not_found'));
  await assert.rejects(w.svc.policyHistory(t, 'executive', { before: 'x' }), code('not_found'));
  await assert.rejects(w.svc.policyHistory(w.as(w.manager), 'executive', {}), e => e.status === 403);
});

test('a request is evaluated with its tier\'s current policy; the page says when the policy moved on', async () => {
  const w = await world();
  const t = w.as(w.traveler);
  const r = await w.svc.createRequest(t, { query: Q, selection: OUTSIDE, purpose: 'Client visit' });
  assert.deepEqual(r.evaluation.policy, { tier: 'standard', version: 1 });
  const p = await w.repo.get(KINDS.policy, `${w.org.id}.standard`);
  await w.svc.savePolicy(w.as(w.admin), 'standard', { form: { longHaulMinutes: '420', 'hotel.default': '' }, rev: p.rev });
  const view = await w.svc.getRequest(t, r.id);
  assert.deepEqual(view.policyChanged, { from: 1, to: 2 });
  const q = (await w.svc.submit(t, r.id, { rev: r.rev, reason: 'Meeting the client at their office.' })).request;
  assert.deepEqual(q.evaluation.policy, { tier: 'standard', version: 2 }, 'submit re-evaluates with the current version');
  assert.equal((await w.svc.getRequest(t, r.id)).policyChanged, null);
});
