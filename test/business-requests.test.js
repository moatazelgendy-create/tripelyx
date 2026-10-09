// Stage 1W-b: trip requests, approvals, budget holds, reports and the CSV export (plan §C4 to §C6, §H),
// through BusinessService against the frozen fakes (test/business-fakes.js) on a MemoryStore. The race
// tests also run on Postgres when TEST_DATABASE_URL names a throwaway database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { PostgresStore } = require('../server/booking/PostgresStore');
const { Accounts } = require('../server/accounts');
const { loadConfig } = require('../server/config');
const { Repo, memberScope } = require('../server/business/repo');
const { BusinessService } = require('../server/business/service');
const { KINDS, ID_PREFIX } = require('../server/business/constants');
const { id: newId } = require('../server/lib/ids');
const { CARD_MESSAGE } = require('../server/business/cards');
const reports = require('../server/business/reports');
const csv = require('../server/business/csv');
const fakes = require('./business-fakes');
const { seedUser, seedOrg, seedMember, seedDepartment, seedBudget, mutableClock, storeSnapshot } = require('./business-helpers');
const { FIXED_NOW, quietLog } = require('./helpers');

const pgUrl = process.env.TEST_DATABASE_URL;
const STORES = [
  { name: 'MemoryStore', skip: false, make: async () => new MemoryStore() },
  {
    name: 'PostgresStore',
    skip: !pgUrl && 'TEST_DATABASE_URL not set',
    make: async () => { const s = new PostgresStore({ connectionString: pgUrl, ssl: false }); await s.init(); return s; },
  },
];

// The fake inventory's London trip (test/business-fakes.js): rows and totals as the fakes craft them.
const Q = { from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1' };
const OUT = {
  cheap: 'f.flt_fake_CAILHR_2026-11-12_4|LIGHT', // 32200, within
  flex: 'f.flt_fake_CAILHR_2026-11-12_1|FLEX', // 66200, over the 600 dollar cap (out)
  zs: 'f.flt_fake_CAILHR_2026-11-12_3|LIGHT', // Sahara Wings: blocked
  gone: 'f.flt_fake_CAILHR_2026-11-12_4|FLEX', // unavailable
};
const BACK = 'f.flt_fake_LHRCAI_2026-11-16_4|LIGHT'; // 30800, within
const HOTEL = 'h.htl_fake_LHR_3|STD'; // 79800 for 4 nights, within
const WITHIN = { out: OUT.cheap, back: BACK, hotelKey: HOTEL }; // 142800
const OUTSIDE = { out: OUT.flex, back: BACK, hotelKey: HOTEL }; // 176800
const BLOCKED = { out: OUT.zs, back: BACK, hotelKey: HOTEL };
const WITHIN_TOTAL = 32200 + 30800 + 79800;
const OUTSIDE_TOTAL = 66200 + 30800 + 79800;
const REASON = 'Meeting the client at their office on Monday morning.';

/**
 * A company with an owner (General), a manager and an employee in Engineering (the employee managed by the
 * manager), a travel admin and a finance member, and a BusinessService on the fakes.
 */
async function world({ store = new MemoryStore(), settings = {}, policyOpts = {}, budgetCents = null, solo = false } = {}) {
  const clock = mutableClock(FIXED_NOW);
  const now = clock.now;
  const config = loadConfig({});
  const app = { store, accounts: new Accounts({ store, config, now }), ctx: { now } };
  const ownerU = await seedUser(app, { name: 'Olive Owner' });
  const org = await seedOrg(app, ownerU, { settings });
  const inventory = fakes.fakeInventory();
  const composer = fakes.fakeComposer({ inventory, now });
  const policy = fakes.fakePolicy(policyOpts);
  const alternatives = fakes.fakeAlternatives();
  const explainer = fakes.fakeExplainer();
  const repo = new Repo({ store, now });
  const svc = new BusinessService({ repo, config, now, log: quietLog, inventory, composer, policy, alternatives, explainer });
  const as = who => ({ org: { id: org.id }, user: who.user });
  const w = { app, store, clock, org, svc, repo, inventory, composer, policy, alternatives, explainer, as, owner: { user: ownerU.user, member: org.owner } };
  if (solo) return w;
  w.eng = await seedDepartment(app, org, { name: 'Engineering' });
  w.manager = await seedMember(app, org, 'manager', { name: 'Dana Lee', departmentId: w.eng.id });
  w.traveler = await seedMember(app, org, 'employee', { name: 'Sam Traveler', departmentId: w.eng.id, managerId: w.manager.user.id });
  w.admin = await seedMember(app, org, 'travel_admin', { name: 'Tara Admin', departmentId: org.general.id });
  w.finance = await seedMember(app, org, 'finance', { name: 'Fin Ance', departmentId: org.general.id });
  if (budgetCents !== null) w.budget = await seedBudget(app, org, w.eng.id, { periodKey: '2026-Q4', amountCents: budgetCents });
  return w;
}

const draft = (w, who, selection = WITHIN, { query = Q, purpose = 'Client visit in London' } = {}) => w.svc.createRequest(w.as(who), { query, selection, purpose });
const audits = async w => (await w.repo.page(KINDS.audit, w.org.id, { limit: 200 })).rows;
const auditsFor = async (w, action) => (await audits(w)).filter(a => a.action === action);
const budgetOf = (w, departmentId = w.eng.id, key = '2026-Q4') => w.repo.get(KINDS.budget, `${w.org.id}.${departmentId}.${key}`);
const link = (w, rid, role, userId) => w.repo.get(KINDS.reqLink, `${rid}.${role}.${userId}`);
const code = c => e => { assert.equal(e.code, c, `${e.code}: ${e.message}`); return true; };

/** A pending request of the employee (out of policy, assigned to the manager). */
async function pending(w, who = w.traveler, selection = OUTSIDE) {
  const r = await draft(w, who, selection);
  const res = await w.svc.submit(w.as(who), r.id, { rev: r.rev, reason: REASON, category: 'client_meeting' });
  assert.equal(res.outcome, 'submitted');
  return res.request;
}

// ---------------------------------------------------------------------------------------------------------
// Search and draft

test('searchTrip evaluates every row with the member\'s tier, orders within → out → blocked, and writes nothing', async () => {
  const w = await world();
  const before = storeSnapshot(w.app);
  const v = await w.svc.searchTrip(w.as(w.traveler), Q);
  assert.equal(storeSnapshot(w.app), before, 'a search writes nothing');
  assert.equal(v.status, 'demo');
  assert.deepEqual(v.policy, { tier: 'standard', version: 1 });
  assert.equal(v.tierLabel, 'Standard');
  assert.equal(v.departmentName, 'Engineering');
  const statuses = v.legs.out.rows.map(r => r.evaluation.status);
  assert.deepEqual(statuses, [...statuses].sort((a, b) => ['within', 'out', 'blocked'].indexOf(a) - ['within', 'out', 'blocked'].indexOf(b)));
  const within = v.legs.out.rows.filter(r => r.evaluation.status === 'within').map(r => r.row.totalCents);
  assert.deepEqual(within, [...within].sort((a, b) => a - b), 'cheapest first inside a verdict');
  assert.equal(v.legs.out.outsideCount, v.legs.out.rows.filter(r => r.evaluation.status !== 'within').length);
  assert.deepEqual(v.blockedCarrierNames, ['Sahara Wings']);
  assert.equal(v.legs.hotel.city, 'London');
  assert.equal(v.legs.hotel.priceToBeatCents, 28500, 'min(nightly cap, median)');
  assert.match(v.limits.heading, /Standard policy, v1/);

  const none = await world();
  none.svc.inventory = fakes.fakeInventory({ status: 'none' });
  const nv = await none.svc.searchTrip(none.as(none.traveler), Q);
  assert.equal(nv.status, 'none');
  assert.deepEqual(nv.legs.out.rows, []);
  assert.equal(nv.query, null);
  await assert.rejects(w.svc.searchTrip(w.as(w.traveler), { ...Q, to: 'XXX' }), code('invalid_query'));
});

test('createRequest prices with the query as searched, evaluates it and writes the draft, the traveler link and the audit in one commit', async () => {
  const w = await world();
  // search() may move the hotel check-in (the outbound arrival's local date): the stored query is that one.
  const search = w.composer.search;
  const priced = [];
  w.composer.search = async q => {
    const res = await search(q);
    res.query.hotel.checkIn = '2026-11-13';
    return res;
  };
  const price = w.composer.price;
  w.composer.price = async (sel, q) => { priced.push(structuredClone(q)); return price({ ...sel }, { ...q, hotel: { ...q.hotel, checkIn: '2026-11-12' } }); };
  const r = await draft(w, w.traveler);
  assert.equal(priced[0].hotel.checkIn, '2026-11-13', 'priced with SearchResult.query');
  assert.equal(r.query.hotel.checkIn, '2026-11-13', 'stored with SearchResult.query');
  w.composer.search = search;
  w.composer.price = price;

  assert.match(r.id, /^btr_/);
  assert.equal(r.status, 'draft');
  assert.equal(r.rev, 0);
  assert.equal(r.travelerId, w.traveler.user.id);
  assert.equal(r.travelerName, 'Sam Traveler');
  assert.equal(r.travelerManagerId, w.manager.user.id);
  assert.equal(r.departmentId, w.eng.id);
  assert.equal(r.tier, 'standard');
  assert.equal(r.totalCents, WITHIN_TOTAL);
  assert.equal(r.originalTotalCents, WITHIN_TOTAL);
  assert.equal(r.currency, 'USD');
  assert.equal(r.evaluation.status, 'within');
  assert.equal(r.evaluation.evaluatedAt, FIXED_NOW);
  assert.deepEqual(r.alternatives, []);
  assert.equal(r.explanation, null);
  assert.deepEqual(r.selection, { out: OUT.cheap, back: BACK, hotel: HOTEL });
  assert.deepEqual(r.booking, { status: 'not_open' });
  assert.equal(r.demo, true);
  assert.deepEqual(r.history.map(h => h.action), ['drafted']);
  assert.deepEqual(await w.repo.get(KINDS.request, r.id), r);
  assert.ok(await link(w, r.id, 'traveler', w.traveler.user.id));
  const [audit] = await auditsFor(w, 'request.drafted');
  assert.equal(audit.target.id, r.id);
  assert.equal(audit.at, FIXED_NOW);
  assert.equal(audit.summary, 'Sam Traveler planned a trip to London');
});

test('createRequest out of policy builds alternatives; the explainer sees no prices, and its order and notes are kept', async () => {
  const w = await world();
  const r = await draft(w, w.traveler, OUTSIDE);
  assert.equal(r.evaluation.status, 'out');
  assert.deepEqual(r.evaluation.violations.map(v => v.rule), ['flight.cap']);
  assert.ok(r.alternatives.length > 0 && r.alternatives.length <= 5);
  assert.ok(r.cheapestWithin, 'a cheaper option inside the policy exists');
  assert.equal(r.alternatives[0].id, r.cheapestWithin.id);
  assert.ok(r.alternatives.every(a => typeof a.note === 'string' && a.note.length > 0), 'explainer notes are filled in');
  assert.ok(r.cheapestWithin.note);
  assert.deepEqual(r.explanation, { summary: 'These options keep your route and cost less.', explainer: 'rules' });
  const input = w.explainer.inputs.at(-1);
  assert.deepEqual(Object.keys(input).sort(), ['alternatives', 'noneWithin', 'violations']);
  assert.deepEqual(input.violations, [{ rule: 'flight.cap' }]);
  for (const a of input.alternatives) assert.deepEqual(Object.keys(a).sort(), ['giveUps', 'id', 'kind', 'savingsRank', 'withinPolicy']);
  assert.deepEqual(input.alternatives.map(a => a.savingsRank).sort((x, y) => x - y), input.alternatives.map((_, i) => i + 1));
  assert.ok(!/Cents|cents|\$/.test(JSON.stringify(input)), 'no prices reach the explainer');
  // The variants were asked with the evaluator (all_within needs it) and the search they came from.
  assert.equal(w.composer.calls.variants, 1);
});

test('createRequest refuses a bad purpose, a card number, a forged key and an option that stopped pricing', async () => {
  const w = await world();
  const t = w.as(w.traveler);
  await assert.rejects(w.svc.createRequest(t, { query: Q, selection: WITHIN, purpose: 'ab' }), e => e.code === 'invalid_purpose' && e.status === 422 && !!e.details.purpose);
  await assert.rejects(w.svc.createRequest(t, { query: Q, selection: WITHIN, purpose: 'Pay with 4111 1111 1111 1111' }), e => e.code === 'invalid_purpose' && e.details.purpose === CARD_MESSAGE);
  await assert.rejects(w.svc.createRequest(t, { query: Q, selection: WITHIN, purpose: 'x'.repeat(141) }), code('invalid_purpose'));
  await assert.rejects(w.svc.createRequest(t, { query: Q, selection: { ...WITHIN, out: 'nope' }, purpose: 'Client visit' }), code('invalid_selection'));
  await assert.rejects(w.svc.createRequest(t, { query: Q, selection: { ...WITHIN, out: HOTEL }, purpose: 'Client visit' }), code('invalid_selection'));
  await assert.rejects(w.svc.createRequest(t, { query: Q, selection: { back: BACK }, purpose: 'Client visit' }), code('invalid_selection'));
  await assert.rejects(w.svc.createRequest(t, { query: { ...Q, depart: '2020-01-01' }, selection: WITHIN, purpose: 'Client visit' }), code('invalid_query'));
  await assert.rejects(w.svc.createRequest(t, { query: Q, selection: { ...WITHIN, out: OUT.gone }, purpose: 'Client visit' }), e => e.code === 'option_unavailable' && e.status === 409);
  assert.equal((await w.repo.page(KINDS.request, w.org.id)).rows.length, 0, 'nothing was written');
});

// ---------------------------------------------------------------------------------------------------------
// Submit

test('submit within policy is approved by policy with the budget hold, in one commit', async () => {
  const w = await world({ budgetCents: 1000000 });
  const r = await draft(w, w.traveler);
  const res = await w.svc.submit(w.as(w.traveler), r.id, { rev: r.rev });
  assert.equal(res.outcome, 'auto_approved');
  const q = res.request;
  assert.equal(q.status, 'approved');
  assert.equal(q.rev, 1);
  assert.equal(q.approval.mode, 'auto');
  assert.deepEqual(q.approval.decidedBy, { system: 'policy' });
  assert.deepEqual(q.budget, { budgetId: `${w.org.id}.${w.eng.id}.2026-Q4`, periodKey: '2026-Q4', cents: WITHIN_TOTAL });
  const b = await budgetOf(w);
  assert.deepEqual(b.commits, { [r.id]: WITHIN_TOTAL });
  const [audit] = await auditsFor(w, 'request.auto_approved');
  assert.deepEqual(audit.actor, { system: 'policy' });
  assert.equal(audit.target.id, r.id);
  assert.equal((await w.svc.getRequest(w.as(w.traveler), r.id)).status, 'approved');
});

test('submit out of policy goes pending with the approver link; a traveler without a valid approver goes to the admins\' pool', async () => {
  const w = await world({ budgetCents: 1000000 });
  const q = await pending(w);
  assert.equal(q.status, 'pending');
  assert.deepEqual(q.reason, { text: REASON, category: 'client_meeting' });
  assert.equal(q.approval.mode, 'manual');
  assert.equal(q.approval.approverId, w.manager.user.id);
  assert.equal(q.approval.rule, 'manager');
  assert.equal(q.submittedAt, FIXED_NOW);
  assert.equal(q.expiresAt, '2026-10-10T09:00:00.000Z', 'submittedAt + 24 hours, before the departure');
  assert.equal(q.budget, null, 'nothing is held while pending');
  assert.ok(await link(w, q.id, 'approver', w.manager.user.id));
  const stored = await w.repo.get(KINDS.reqLink, `${q.id}.approver.${w.manager.user.id}`);
  assert.deepEqual(stored, { orgId: w.org.id, requestId: q.id, userId: w.manager.user.id, role: 'approver', at: FIXED_NOW });
  assert.equal((await w.repo.page(KINDS.reqLink, memberScope(w.org.id, w.manager.user.id))).rows.length, 1, 'the link lives in the approver\'s scope');
  assert.equal((await auditsFor(w, 'request.submitted')).length, 1);
  assert.deepEqual((await budgetOf(w)).commits, {});
  assert.equal(await w.svc.inboxCount(w.as(w.manager)), 1);

  // No manager and no approver: the active owners and travel admins (never the traveler) decide.
  const lone = await seedMember(w.app, w.org, 'employee', { name: 'Lou Lone', departmentId: w.eng.id });
  const p = await pending(w, lone);
  assert.equal(p.approval.pool, true);
  assert.equal(p.approval.rule, 'admin');
  assert.deepEqual([...p.approval.poolIds].sort(), [w.owner.user.id, w.admin.user.id].sort());
  for (const u of p.approval.poolIds) assert.ok(await link(w, p.id, 'pool', u));
  assert.equal(await w.svc.inboxCount(w.as(w.admin)), 1);
  const view = await w.svc.getRequest(w.as(lone), p.id);
  assert.equal(view.approver.rule, 'admin');
  assert.match(view.approver.name, /Olive Owner|Tara Admin/);
});

test('submit refuses blocked (422), a short reason (422), a card number (422), no approver (422) and too late (422)', async () => {
  const w = await world();
  const t = w.as(w.traveler);
  const blocked = await draft(w, w.traveler, BLOCKED);
  await assert.rejects(w.svc.submit(t, blocked.id, { rev: blocked.rev, reason: REASON }), e => e.code === 'policy_blocked' && e.status === 422);
  assert.equal((await w.repo.get(KINDS.request, blocked.id)).rev, 0, 'still the same draft');

  const out = await draft(w, w.traveler, OUTSIDE);
  await assert.rejects(w.svc.submit(t, out.id, { rev: out.rev, reason: 'Too short' }), e => e.code === 'reason_too_short' && e.status === 422);
  await assert.rejects(w.svc.submit(t, out.id, { rev: out.rev }), code('reason_too_short'));
  await assert.rejects(w.svc.submit(t, out.id, { rev: out.rev, reason: 'Card 4111 1111 1111 1111 for the hotel' }), e => e.code === 'card_number' && e.status === 422);
  const stored = await w.repo.get(KINDS.request, out.id);
  assert.equal(stored.status, 'draft');
  assert.equal(stored.rev, 0);
  assert.equal((await auditsFor(w, 'request.submitted')).length, 0);

  // A one-person company: nobody else can approve.
  const solo = await world({ solo: true });
  const mine = await draft(solo, solo.owner, OUTSIDE);
  await assert.rejects(solo.svc.submit(solo.as(solo.owner), mine.id, { rev: mine.rev, reason: REASON }), e => e.code === 'no_approver' && e.status === 422 && /Acme Inc/.test(e.message));

  // Leaving today: the approval would expire before it could be given.
  const today = await w.svc.createRequest(t, { query: { ...Q, depart: '2026-10-09', return: '2026-10-12' }, selection: { ...OUTSIDE, out: 'f.flt_fake_CAILHR_2026-10-09_1|FLEX', back: 'f.flt_fake_LHRCAI_2026-10-12_4|LIGHT' }, purpose: 'Urgent visit' });
  assert.equal(today.evaluation.status, 'out');
  await assert.rejects(w.svc.submit(t, today.id, { rev: today.rev, reason: REASON }), e => e.code === 'too_late' && e.status === 422);
});

test('submit: only the traveler, only a draft, only on the current rev', async () => {
  const w = await world();
  const r = await draft(w, w.traveler);
  await assert.rejects(w.svc.submit(w.as(w.manager), r.id, { rev: r.rev }), code('not_found'));
  await assert.rejects(w.svc.submit(w.as(w.traveler), r.id, { rev: 3 }), e => e.code === 'conflict' && e.status === 409);
  await assert.rejects(w.svc.submit(w.as(w.traveler), r.id, { rev: 'x' }), code('conflict'));
  const res = await w.svc.submit(w.as(w.traveler), r.id, { rev: '0' });
  await assert.rejects(w.svc.submit(w.as(w.traveler), r.id, { rev: res.request.rev }), code('invalid_transition'));
  await assert.rejects(w.svc.submit(w.as(w.traveler), 'btr_missing', { rev: 0 }), code('not_found'));
});

test('a changed price on submit updates the draft instead (outcome repriced, audit request.repriced)', async () => {
  const w = await world({ budgetCents: 1000000 });
  const r = await draft(w, w.traveler);
  w.inventory.setPrice(OUT.cheap, 35000);
  const res = await w.svc.submit(w.as(w.traveler), r.id, { rev: r.rev });
  assert.equal(res.outcome, 'repriced');
  assert.equal(res.request.status, 'draft');
  assert.equal(res.request.totalCents, WITHIN_TOTAL - 32200 + 35000);
  assert.equal(res.request.rows.out.totalCents, 35000);
  assert.equal(res.request.originalTotalCents, WITHIN_TOTAL, 'the first pick stays the original');
  assert.equal(res.request.history.at(-1).action, 'repriced');
  const [audit] = await auditsFor(w, 'request.repriced');
  assert.deepEqual(audit.changes, [{ path: 'totalCents', before: WITHIN_TOTAL, after: WITHIN_TOTAL - 32200 + 35000 }]);
  assert.deepEqual((await budgetOf(w)).commits, {}, 'nothing held');
  // Submitting the updated draft goes through.
  const again = await w.svc.submit(w.as(w.traveler), r.id, { rev: res.request.rev });
  assert.equal(again.outcome, 'auto_approved');

  // An option that stopped pricing: the draft shows it as blocked and cannot be sent as is.
  w.inventory.clearOverrides();
  const r2 = await draft(w, w.traveler);
  w.inventory.setUnavailable(HOTEL);
  const res2 = await w.svc.submit(w.as(w.traveler), r2.id, { rev: r2.rev });
  assert.equal(res2.outcome, 'repriced');
  assert.equal(res2.request.evaluation.status, 'blocked');
  assert.equal(res2.request.totalCents, 32200 + 30800, 'the sum of what still prices');
});

test('a submit that comes back repriced keeps the reason typed (never a card number; an empty field keeps the stored one)', async () => {
  const w = await world({ budgetCents: 1000000 });
  const t = w.as(w.traveler);
  // The price moved: the draft keeps the reason and category, cut to what the lifecycle accepts.
  const r = await draft(w, w.traveler, OUTSIDE);
  w.inventory.setPrice(OUT.flex, 70000);
  const res = await w.svc.submit(t, r.id, { rev: r.rev, reason: `  ${REASON}  `, category: 'client_meeting' });
  assert.equal(res.outcome, 'repriced');
  assert.deepEqual(res.request.reason, { text: REASON, category: 'client_meeting' });
  // Sent again with an empty field after another move: the stored reason stays; a card number never replaces it.
  w.inventory.setPrice(OUT.flex, 71000);
  const res2 = await w.svc.submit(t, r.id, { rev: res.request.rev, reason: '' });
  assert.equal(res2.outcome, 'repriced');
  assert.deepEqual(res2.request.reason, { text: REASON, category: 'client_meeting' });
  w.inventory.setPrice(OUT.flex, 72000);
  const res3 = await w.svc.submit(t, r.id, { rev: res2.request.rev, reason: 'Pay with 4111 1111 1111 1111 please', category: 'other' });
  assert.equal(res3.outcome, 'repriced');
  assert.deepEqual(res3.request.reason, { text: REASON, category: 'client_meeting' }, 'a card number is never stored');
  const long = 'x'.repeat(700);
  w.inventory.setPrice(OUT.flex, 73000);
  const res4 = await w.svc.submit(t, r.id, { rev: res3.request.rev, reason: long, category: 'nonsense' });
  assert.deepEqual(res4.request.reason, { text: 'x'.repeat(500), category: null });
  // The verdict got worse at the same price (the policy tightened): the reason is kept too.
  w.inventory.clearOverrides();
  const r2 = await draft(w, w.traveler);
  w.policy.configure({ flightCapCents: 10000 });
  const res5 = await w.svc.submit(t, r2.id, { rev: r2.rev, reason: REASON, category: 'schedule' });
  assert.equal(res5.outcome, 'repriced');
  assert.equal(res5.request.evaluation.status, 'out');
  assert.deepEqual(res5.request.reason, { text: REASON, category: 'schedule' });
  // Sent again with it: pending with that reason.
  const sent = await w.svc.submit(t, r2.id, { rev: res5.request.rev, reason: res5.request.reason.text, category: res5.request.reason.category });
  assert.equal(sent.outcome, 'submitted');
  assert.deepEqual(sent.request.reason, { text: REASON, category: 'schedule' });
});

// ---------------------------------------------------------------------------------------------------------
// Decide, ask, cancel

test('the assigned approver approves: request CAS, budget hold, decider link and audit in one commit', async () => {
  const w = await world({ budgetCents: 1000000 });
  const q = await pending(w);
  const res = await w.svc.decide(w.as(w.manager), q.id, { action: 'approve', note: '', rev: q.rev });
  assert.equal(res.outcome, 'approved');
  assert.equal(res.request.status, 'approved');
  assert.equal(res.request.approval.decidedAs, 'assigned');
  assert.equal(res.request.approval.decidedBy.userId, w.manager.user.id);
  assert.equal(res.request.approval.overBudgetAck, false);
  assert.deepEqual((await budgetOf(w)).commits, { [q.id]: OUTSIDE_TOTAL });
  assert.ok(await link(w, q.id, 'decider', w.manager.user.id));
  const [audit] = await auditsFor(w, 'request.approved');
  assert.equal(audit.summary, 'Dana Lee approved Sam Traveler\'s trip to London');
  assert.deepEqual(audit.changes, [{ path: 'approval.decidedAs', before: null, after: 'assigned' }, { path: 'approval.overBudgetAck', before: false, after: false }]);
  const inbox = await w.svc.inbox(w.as(w.manager), { tab: 'decided' });
  assert.deepEqual(inbox.rows.map(r => r.id), [q.id]);
  assert.equal(inbox.rows[0].decidedAs, 'assigned');
  assert.deepEqual(inbox.counts, { waiting: 0, decided: 1, company: null, expired: 0 });
  assert.equal(await w.svc.inboxCount(w.as(w.manager)), 0);
  await assert.rejects(w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: res.request.rev }), code('invalid_transition'));
});

test('deny needs a note of 10 characters; asking a question keeps the request pending and its expiry', async () => {
  const w = await world();
  const q = await pending(w);
  const m = w.as(w.manager);
  await assert.rejects(w.svc.decide(m, q.id, { action: 'deny', note: 'No', rev: q.rev }), e => e.code === 'note_required' && e.status === 422);
  await assert.rejects(w.svc.decide(m, q.id, { action: 'deny', note: 'Card 4111 1111 1111 1111 please', rev: q.rev }), code('card_number'));
  await assert.rejects(w.svc.decide(m, q.id, { action: 'maybe', rev: q.rev }), code('invalid_action'));

  const asked = await w.svc.message(m, q.id, { text: 'Can you take the earlier flight?' });
  assert.equal(asked.status, 'pending');
  assert.equal(asked.expiresAt, q.expiresAt);
  assert.deepEqual(asked.messages.map(x => [x.by, x.name, x.text]), [[w.manager.user.id, 'Dana Lee', 'Can you take the earlier flight?']]);
  const answered = await w.svc.message(w.as(w.traveler), q.id, { text: 'Yes, that works for me.' });
  assert.equal(answered.messages.length, 2);
  const msgAudits = await auditsFor(w, 'request.message');
  assert.equal(msgAudits.length, 2);
  assert.ok(msgAudits.every(a => !a.summary.includes('earlier flight') && !a.summary.includes('works for me')), 'no message text in the audit log');
  await assert.rejects(w.svc.message(m, q.id, { text: 'x' }), code('invalid_message'));
  await assert.rejects(w.svc.message(m, q.id, { text: 'My card is 4111 1111 1111 1111' }), code('card_number'));
  await assert.rejects(w.svc.message(w.as(w.finance), q.id, { text: 'Hello there' }), code('not_found'), 'finance can see it but has no say');

  const res = await w.svc.decide(m, q.id, { action: 'deny', note: 'Please pick the cheaper fare.', rev: answered.rev });
  assert.equal(res.outcome, 'denied');
  assert.equal(res.request.approval.note, 'Please pick the cheaper fare.');
  assert.ok(await link(w, q.id, 'decider', w.manager.user.id));
  assert.equal((await auditsFor(w, 'request.denied')).length, 1);
  await assert.rejects(w.svc.message(m, q.id, { text: 'Too late now' }), code('invalid_transition'));
});

test('an override decision is labelled and needs a note; "Decided by you" finds it through the decider link', async () => {
  const w = await world({ budgetCents: 1000000 });
  const q = await pending(w);
  const t = w.as(w.admin);
  const company = await w.svc.inbox(t, { tab: 'company' });
  assert.deepEqual(company.rows.map(r => r.id), [q.id]);
  assert.equal(company.counts.company, 1);
  assert.equal((await w.svc.inbox(t, { tab: 'waiting' })).rows.length, 0, 'not assigned to the admin');
  await assert.rejects(w.svc.inbox(w.as(w.manager), { tab: 'company' }), code('not_found'));
  const view = await w.svc.getRequest(t, q.id);
  assert.equal(view.can.decide, true);
  assert.equal(view.can.override, true);

  await assert.rejects(w.svc.decide(t, q.id, { action: 'approve', rev: q.rev }), code('note_required'));
  const res = await w.svc.decide(t, q.id, { action: 'approve', note: 'Dana is away this week.', rev: q.rev });
  assert.equal(res.request.approval.decidedAs, 'override');
  const [audit] = await auditsFor(w, 'request.approved');
  assert.equal(audit.summary, 'Tara Admin approved Sam Traveler\'s trip to London as Travel Admin (assigned to Dana Lee)');
  assert.deepEqual(audit.changes[0], { path: 'approval.decidedAs', before: null, after: 'override' });
  const decided = await w.svc.inbox(t, { tab: 'decided' });
  assert.deepEqual(decided.rows.map(r => r.id), [q.id]);
  assert.equal(decided.rows[0].decidedAs, 'override');
  assert.equal((await w.svc.inbox(w.as(w.manager), { tab: 'decided' })).rows.length, 0, 'the manager did not decide it');
});

test('nobody decides their own trip, the Owner included', async () => {
  const w = await world();
  const mine = await pending(w, w.owner);
  assert.equal(mine.approval.pool, true);
  assert.deepEqual(mine.approval.poolIds, [w.admin.user.id]);
  const o = w.as(w.owner);
  await assert.rejects(w.svc.decide(o, mine.id, { action: 'approve', note: 'Approving my own trip', rev: mine.rev }), e => e.code === 'self_approval' && e.status === 422);
  await assert.rejects(w.svc.decide(o, mine.id, { action: 'deny', note: 'Denying my own trip', rev: mine.rev }), code('self_approval'));
  const view = await w.svc.getRequest(o, mine.id);
  assert.equal(view.can.decide, false);
  assert.equal(view.self, true);
  assert.equal((await w.svc.inbox(o, { tab: 'company' })).rows.length, 0, 'the company tab leaves out the member\'s own');
  // The pool member can.
  const res = await w.svc.decide(w.as(w.admin), mine.id, { action: 'approve', rev: mine.rev });
  assert.equal(res.request.approval.decidedAs, 'pool');
  // An employee (no approval permission) gets 403.
  await assert.rejects(w.svc.decide(w.as(w.traveler), mine.id, { action: 'approve', rev: 1 }), e => e.status === 403);
});

test('expiry is lazy: GETs show expired and write nothing; the next POST persists it and answers 409', async () => {
  const w = await world();
  const q = await pending(w);
  w.clock.set('2026-10-10T09:00:00.000Z'); // exactly expiresAt
  const before = storeSnapshot(w.app);
  const view = await w.svc.getRequest(w.as(w.manager), q.id);
  assert.equal(view.status, 'expired');
  assert.equal(view.can.decide, false);
  assert.equal(view.live, null);
  assert.equal((await w.svc.inbox(w.as(w.manager), { tab: 'waiting' })).rows.length, 0);
  assert.deepEqual((await w.svc.inbox(w.as(w.manager), { tab: 'expired' })).rows.map(r => r.status), ['expired']);
  assert.equal(await w.svc.inboxCount(w.as(w.manager)), 0);
  assert.deepEqual((await w.svc.listRequests(w.as(w.traveler), { scope: 'mine' })).rows.map(r => r.status), ['expired']);
  await assert.rejects(w.svc.liveCheck(w.as(w.manager), q.id), e => e.status === 403);
  await w.svc.dashboard(w.as(w.owner), { view: 'reports' });
  assert.equal(storeSnapshot(w.app), before, 'GETs never write');
  assert.equal((await w.repo.get(KINDS.request, q.id)).status, 'pending');

  await assert.rejects(w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev }), e => e.code === 'request_expired' && e.status === 409);
  const stored = await w.repo.get(KINDS.request, q.id);
  assert.equal(stored.status, 'expired');
  assert.deepEqual(stored.history.at(-1).by, { system: 'clock' });
  const [audit] = await auditsFor(w, 'request.expired');
  assert.deepEqual(audit.actor, { system: 'clock' });
  // Once expired it stays expired, and every POST says so.
  await assert.rejects(w.svc.cancel(w.as(w.traveler), q.id, { rev: stored.rev }), code('invalid_transition'));
  assert.equal((await auditsFor(w, 'request.expired')).length, 1);

  // Any POST persists it: a message on another expired request.
  w.clock.set(FIXED_NOW);
  const q2 = await pending(w);
  w.clock.set('2026-10-11T00:00:00.000Z');
  await assert.rejects(w.svc.message(w.as(w.traveler), q2.id, { text: 'Still waiting here' }), code('request_expired'));
  assert.equal((await w.repo.get(KINDS.request, q2.id)).status, 'expired');
});

test('a price check that finds a change sends the request back to the traveler as a draft', async () => {
  const w = await world({ budgetCents: 1000000 });
  const q = await pending(w);
  w.inventory.setPrice(OUT.flex, 70000);
  const m = w.as(w.manager);
  const view = await w.svc.getRequest(m, q.id);
  assert.equal(view.live.status, 'changed', 'the approver sees the live check');
  assert.equal((await w.repo.get(KINDS.request, q.id)).rev, q.rev, 'which writes nothing');
  assert.equal((await w.svc.liveCheck(m, q.id)).newTotalCents, OUTSIDE_TOTAL - 66200 + 70000);
  const res = await w.svc.decide(m, q.id, { action: 'approve', rev: q.rev });
  assert.equal(res.outcome, 'returned');
  const r = res.request;
  assert.equal(r.status, 'draft');
  assert.equal(r.approval, null);
  assert.equal(r.expiresAt, null);
  assert.deepEqual(r.returned, { at: FIXED_NOW, why: 'price_changed', fromCents: OUTSIDE_TOTAL, toCents: OUTSIDE_TOTAL - 66200 + 70000 });
  assert.equal(r.totalCents, OUTSIDE_TOTAL - 66200 + 70000);
  assert.deepEqual((await budgetOf(w)).commits, {}, 'nothing held');
  assert.equal(await link(w, q.id, 'decider', w.manager.user.id), null, 'no decision was made');
  assert.equal((await auditsFor(w, 'request.returned')).length, 1);
  assert.equal(await w.svc.inboxCount(m), 0);

  // The traveler sends it again: the approver link is there already, so only missing links are inserted.
  const again = await w.svc.submit(w.as(w.traveler), q.id, { rev: r.rev, reason: REASON });
  assert.equal(again.outcome, 'submitted');
  assert.equal(await w.svc.inboxCount(m), 1);
  const links = (await w.repo.page(KINDS.reqLink, memberScope(w.org.id, w.manager.user.id))).rows;
  assert.equal(links.length, 1);
});

test('cancel: the traveler a draft or pending request; an approved one releases the hold in the same commit', async () => {
  const w = await world({ budgetCents: 1000000 });
  const d = await draft(w, w.traveler);
  await assert.rejects(w.svc.cancel(w.as(w.manager), d.id, { rev: d.rev }), code('not_found'));
  assert.equal((await w.svc.cancel(w.as(w.traveler), d.id, { rev: d.rev })).status, 'cancelled');

  const q = await pending(w);
  await assert.rejects(w.svc.cancel(w.as(w.traveler), q.id, { rev: 0 }), code('conflict'));
  assert.equal((await w.svc.cancel(w.as(w.traveler), q.id, { rev: q.rev })).status, 'cancelled');

  const a = await draft(w, w.traveler);
  const approved = (await w.svc.submit(w.as(w.traveler), a.id, { rev: a.rev })).request;
  assert.deepEqual((await budgetOf(w)).commits, { [a.id]: WITHIN_TOTAL });
  const view = await w.svc.getRequest(w.as(w.traveler), a.id);
  assert.equal(view.can.cancel, true);
  assert.equal(view.budget.committedCents, 0, 'the preview leaves the request\'s own hold out');
  const c = await w.svc.cancel(w.as(w.traveler), a.id, { rev: approved.rev });
  assert.equal(c.status, 'cancelled');
  assert.deepEqual(c.budget, approved.budget, 'the request keeps its hold record');
  assert.deepEqual((await budgetOf(w)).commits, {}, 'the budget released it');
  assert.equal((await auditsFor(w, 'request.cancelled')).length, 3);
  await assert.rejects(w.svc.cancel(w.as(w.traveler), a.id, { rev: c.rev }), code('invalid_transition'));

  // On the departure date the traveler can no longer cancel; an override holder still can.
  const b = await draft(w, w.traveler);
  const ok = (await w.svc.submit(w.as(w.traveler), b.id, { rev: b.rev })).request;
  w.clock.set('2026-11-12T08:00:00.000Z');
  await assert.rejects(w.svc.cancel(w.as(w.traveler), b.id, { rev: ok.rev }), code('departed'));
  await assert.rejects(w.svc.cancel(w.as(w.manager), b.id, { rev: ok.rev }), code('not_found'));
  assert.equal((await w.svc.cancel(w.as(w.admin), b.id, { rev: ok.rev })).status, 'cancelled');
  assert.deepEqual((await budgetOf(w)).commits, {});
});

test('budget hold and release are idempotent: a key already there (or already gone) changes nothing', async () => {
  const w = await world({ budgetCents: 1000000 });
  const q = await pending(w);
  // As if an earlier attempt had already written the hold.
  await w.repo.cas(KINDS.budget, `${w.org.id}.${w.eng.id}.2026-Q4`, null, d => { d.commits[q.id] = OUTSIDE_TOTAL; });
  const res = await w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev });
  assert.equal(res.outcome, 'approved');
  const b = await budgetOf(w);
  assert.deepEqual(b.commits, { [q.id]: OUTSIDE_TOTAL }, 'held once, never twice');

  // The hold is gone already (released elsewhere): cancelling leaves the budget record alone.
  await w.repo.cas(KINDS.budget, `${w.org.id}.${w.eng.id}.2026-Q4`, null, d => { delete d.commits[q.id]; });
  const rev = (await budgetOf(w)).rev;
  const c = await w.svc.cancel(w.as(w.traveler), q.id, { rev: res.request.rev });
  assert.equal(c.status, 'cancelled');
  assert.equal((await budgetOf(w)).rev, rev, 'no budget write');
});

test('approving past the budget needs the acknowledgement; a budget-only overrun goes to approval', async () => {
  const w = await world({ budgetCents: 100000 });
  const r = await draft(w, w.traveler); // within policy, but 1428 dollars against a 1000 dollar budget
  assert.equal(r.evaluation.status, 'out');
  assert.deepEqual(r.evaluation.violations.map(v => v.rule), ['budget']);
  assert.match(r.evaluation.violations[0].text, /Engineering for Q4 2026/);
  const res = await w.svc.submit(w.as(w.traveler), r.id, { rev: r.rev, reason: REASON });
  assert.equal(res.outcome, 'submitted', 'never auto-approved over the budget');
  const q = res.request;
  const view = await w.svc.getRequest(w.as(w.manager), q.id);
  assert.equal(view.budget.remainingCents, 100000);
  await assert.rejects(w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev }), e => e.code === 'over_budget' && e.status === 422);
  assert.deepEqual((await budgetOf(w)).commits, {});
  const ok = await w.svc.decide(w.as(w.manager), q.id, { action: 'approve', ackOverBudget: '1', rev: q.rev });
  assert.equal(ok.request.approval.overBudgetAck, true);
  assert.deepEqual((await budgetOf(w)).commits, { [q.id]: WITHIN_TOTAL });
  const [audit] = await auditsFor(w, 'request.approved');
  assert.deepEqual(audit.changes[1], { path: 'approval.overBudgetAck', before: false, after: true });
  assert.match(audit.summary, /over the budget/);
});

test('a lost budget race re-runs under withRetry and re-checks what is left', async () => {
  const w = await world({ budgetCents: 400000 });
  const q = await pending(w);
  // Another approval lands between this decision's budget read and its commit.
  const repo = w.svc.repo;
  const commit = repo.commit.bind(repo);
  let injected = false;
  repo.commit = async spec => {
    if (!injected && spec.cas && spec.cas.some(c => c.kind === KINDS.budget)) {
      injected = true;
      await repo.cas(KINDS.budget, `${w.org.id}.${w.eng.id}.2026-Q4`, null, d => { d.commits.btr_other = 300000; });
    }
    return commit(spec);
  };
  await assert.rejects(w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev }), code('over_budget'));
  assert.ok(injected);
  assert.deepEqual((await budgetOf(w)).commits, { btr_other: 300000 }, 'never past the budget');
  assert.equal((await w.repo.get(KINDS.request, q.id)).status, 'pending');
  repo.commit = commit;
});

test('swap: the traveler switches a draft to a cheaper option; the saving is kept for reports', async () => {
  const w = await world({ budgetCents: 1000000 });
  const r = await draft(w, w.traveler, OUTSIDE);
  const alt = r.cheapestWithin;
  await assert.rejects(w.svc.swap(w.as(w.traveler), r.id, { altId: alt.id, rev: 5 }), code('conflict'));
  await assert.rejects(w.svc.swap(w.as(w.traveler), r.id, { altId: 'nope', rev: r.rev }), e => e.code === 'alternative_gone' && e.status === 410);
  await assert.rejects(w.svc.swap(w.as(w.manager), r.id, { altId: alt.id, rev: r.rev }), code('not_found'));
  const s = await w.svc.swap(w.as(w.traveler), r.id, { altId: alt.id, rev: r.rev });
  assert.equal(s.status, 'draft');
  assert.equal(s.rev, 1);
  assert.equal(s.totalCents, alt.totalCents);
  assert.equal(s.originalTotalCents, OUTSIDE_TOTAL);
  assert.equal(s.evaluation.status, 'within');
  assert.deepEqual(s.selection, alt.selection);
  const line = s.history.at(-1);
  assert.equal(line.action, 'swapped');
  assert.equal(line.savedCents, OUTSIDE_TOTAL - alt.totalCents);
  assert.equal((await auditsFor(w, 'request.swapped')).length, 1);
  const done = await w.svc.submit(w.as(w.traveler), r.id, { rev: s.rev });
  assert.equal(done.outcome, 'auto_approved');
  assert.equal(reports.savedBySwitching([done.request]), OUTSIDE_TOTAL - alt.totalCents);

  // An alternative that stopped pricing is gone.
  const r2 = await draft(w, w.traveler, OUTSIDE);
  const alt2 = r2.alternatives.find(a => a.selection.out !== OUTSIDE.out) || r2.alternatives[0];
  for (const k of Object.values(alt2.selection)) if (k && !Object.values(OUTSIDE).includes(k)) w.inventory.setUnavailable(k);
  await assert.rejects(w.svc.swap(w.as(w.traveler), r2.id, { altId: alt2.id, rev: r2.rev }), code('alternative_gone'));
});

// ---------------------------------------------------------------------------------------------------------
// Races (MemoryStore and Postgres)

for (const S of STORES) {
  test(`${S.name}: two racing approvals never overspend a budget`, { skip: S.skip }, async t => {
    const store = await S.make();
    t.after(() => store.close && store.close());
    const w = await world({ store, budgetCents: 300000 });
    const other = await seedMember(w.app, w.org, 'employee', { name: 'Kim Other', departmentId: w.eng.id, managerId: w.manager.user.id });
    const a = await pending(w, w.traveler);
    const b = await pending(w, other);
    const results = await Promise.allSettled([a, b].map(q => w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev })));
    const won = results.filter(r => r.status === 'fulfilled');
    assert.equal(won.length, 1, JSON.stringify(results.map(r => r.reason && r.reason.code)));
    const lost = results.find(r => r.status === 'rejected').reason;
    assert.ok(['over_budget', 'conflict'].includes(lost.code), lost.code);
    const budget = await budgetOf(w);
    const committed = Object.values(budget.commits).reduce((n, c) => n + c, 0);
    assert.ok(committed <= 300000, `committed ${committed}`);
    assert.equal(committed, OUTSIDE_TOTAL);
    const statuses = await Promise.all([a, b].map(q => w.repo.get(KINDS.request, q.id).then(r => r.status)));
    assert.deepEqual(statuses.sort(), ['approved', 'pending']);
  });

  test(`${S.name}: approve racing cancel has exactly one winner`, { skip: S.skip }, async t => {
    const store = await S.make();
    t.after(() => store.close && store.close());
    const w = await world({ store, budgetCents: 1000000 });
    for (let i = 0; i < 3; i += 1) {
      const q = await pending(w);
      const results = await Promise.allSettled([
        w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev }),
        w.svc.cancel(w.as(w.traveler), q.id, { rev: q.rev }),
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const loser = results.find(r => r.status === 'rejected').reason;
      assert.equal(loser.status, 409, loser.code);
      const stored = await w.repo.get(KINDS.request, q.id);
      const held = Object.hasOwn((await budgetOf(w)).commits, q.id);
      if (stored.status === 'approved') assert.ok(held, 'approved holds');
      else assert.equal(stored.status, 'cancelled');
      if (stored.status === 'cancelled') assert.ok(!held, 'cancelled holds nothing');
      assert.equal(stored.rev, q.rev + 1, 'one write');
    }
  });

  test(`${S.name}: two racing auto-approvals on one budget: one approved, the other updated to ask for approval`, { skip: S.skip }, async t => {
    const store = await S.make();
    t.after(() => store.close && store.close());
    const w = await world({ store, budgetCents: WITHIN_TOTAL + 1000 });
    const other = await seedMember(w.app, w.org, 'employee', { name: 'Kim Other', departmentId: w.eng.id, managerId: w.manager.user.id });
    const a = await draft(w, w.traveler);
    const b = await draft(w, other);
    const results = await Promise.allSettled([[w.traveler, a], [other, b]].map(([who, r]) => w.svc.submit(w.as(who), r.id, { rev: r.rev })));
    assert.deepEqual(results.map(x => x.status), ['fulfilled', 'fulfilled'], JSON.stringify(results.map(x => x.reason && x.reason.code)));
    assert.deepEqual(results.map(x => x.value.outcome).sort(), ['auto_approved', 'repriced']);
    const loser = results.find(x => x.value.outcome === 'repriced').value.request;
    assert.equal(loser.status, 'draft');
    assert.deepEqual(loser.evaluation.violations.map(v => v.rule), ['budget']);
    const committed = Object.values((await budgetOf(w)).commits).reduce((n, c) => n + c, 0);
    assert.equal(committed, WITHIN_TOTAL, 'never past the budget');
  });

  test(`${S.name}: two cancellations of one approved trip release its hold once`, { skip: S.skip }, async t => {
    const store = await S.make();
    t.after(() => store.close && store.close());
    const w = await world({ store, budgetCents: 1000000 });
    const r = await draft(w, w.traveler);
    const ok = (await w.svc.submit(w.as(w.traveler), r.id, { rev: r.rev })).request;
    const results = await Promise.allSettled([
      w.svc.cancel(w.as(w.traveler), r.id, { rev: ok.rev }),
      w.svc.cancel(w.as(w.admin), r.id, { rev: ok.rev }),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.deepEqual((await budgetOf(w)).commits, {});
    assert.equal((await auditsFor(w, 'request.cancelled')).length, 1);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Lists, visibility and isolation

test('getRequest and lists: who sees what (own, team, all, deciders); another company never does', async () => {
  const w = await world();
  const q = await pending(w);
  const colleague = await seedMember(w.app, w.org, 'manager', { name: 'Cole League', departmentId: w.eng.id });
  await assert.rejects(w.svc.getRequest(w.as(colleague), q.id), code('not_found'), 'a department colleague is not team');
  const peer = await seedMember(w.app, w.org, 'employee', { name: 'Pat Peer', departmentId: w.eng.id });
  await assert.rejects(w.svc.getRequest(w.as(peer), q.id), code('not_found'));
  for (const who of [w.traveler, w.manager, w.admin, w.finance, w.owner]) assert.equal((await w.svc.getRequest(w.as(who), q.id)).request.id, q.id);

  const m = await w.svc.getRequest(w.as(w.manager), q.id);
  assert.equal(m.can.decide, true);
  assert.equal(m.can.override, false);
  assert.equal(m.live.status, 'same');
  assert.ok(m.comparison && Array.isArray(m.comparison.rows));
  assert.equal(m.timezone, 'Africa/Cairo');
  const f = await w.svc.getRequest(w.as(w.finance), q.id);
  assert.equal(f.can.decide, false);
  assert.equal(f.live, null);
  const own = await w.svc.getRequest(w.as(w.traveler), q.id);
  assert.deepEqual(own.approver, { userId: w.manager.user.id, name: 'Dana Lee', rule: 'manager' });
  assert.equal(own.can.cancel, true);
  assert.equal(own.can.submit, false);

  assert.deepEqual((await w.svc.listRequests(w.as(w.manager), { scope: 'team' })).rows.map(r => r.id), [q.id]);
  assert.deepEqual((await w.svc.listRequests(w.as(colleague), { scope: 'team' })).rows, []);
  await assert.rejects(w.svc.listRequests(w.as(w.traveler), { scope: 'team' }), e => e.status === 403);
  await assert.rejects(w.svc.listRequests(w.as(w.manager), { scope: 'all' }), e => e.status === 403);
  const all = await w.svc.listRequests(w.as(w.finance), { scope: 'all', status: 'pending', departmentId: w.eng.id, period: '2026-Q4' });
  assert.deepEqual(all.rows.map(r => [r.id, r.status, r.policyStatus, r.totalCents]), [[q.id, 'pending', 'out', OUTSIDE_TOTAL]]);
  assert.deepEqual((await w.svc.listRequests(w.as(w.finance), { scope: 'all', status: 'approved' })).rows, []);
  assert.deepEqual((await w.svc.listRequests(w.as(w.finance), { scope: 'all', period: '2026-12' })).rows.length, 0);
  await assert.rejects(w.svc.listRequests(w.as(w.finance), { scope: 'all', status: 'bogus', period: 'Q4' }), e => e.code === 'invalid_filter' && !!e.details.status && !!e.details.period);
  await assert.rejects(w.svc.listRequests(w.as(w.finance), { scope: 'all', cursor: 'forged.cursor' }), code('not_found'));

  // Another company in the same store: its owner cannot reach this request by id, through any method.
  const xw = await world({ store: w.store });
  await assert.rejects(xw.svc.getRequest({ org: { id: w.org.id }, user: xw.owner.user }, q.id), code('not_found'), 'not a member here');
  await assert.rejects(xw.svc.getRequest(xw.as(xw.owner), q.id), code('not_found'));
  await assert.rejects(xw.svc.decide(xw.as(xw.owner), q.id, { action: 'approve', note: 'Approving from outside', rev: q.rev }), code('not_found'));
  await assert.rejects(xw.svc.cancel(xw.as(xw.owner), q.id, { rev: q.rev }), code('not_found'));
  assert.equal((await xw.svc.listRequests(xw.as(xw.owner), { scope: 'all' })).rows.length, 0);
  assert.equal((await xw.svc.inbox(xw.as(xw.owner), { tab: 'company' })).rows.length, 0);
});

test('pool membership is the request\'s own snapshot: a pool link left from an earlier submission gives no say', async () => {
  const w = await world();
  const lone = await seedMember(w.app, w.org, 'employee', { name: 'Lou Lone', departmentId: w.eng.id });
  const p = await pending(w, lone);
  assert.ok(p.approval.poolIds.includes(w.admin.user.id));
  // The price moves, the request goes back to Lou, and Lou now has a manager.
  w.inventory.setPrice(OUT.flex, 70000);
  const back = (await w.svc.decide(w.as(w.admin), p.id, { action: 'approve', rev: p.rev })).request;
  assert.equal(back.status, 'draft');
  await w.repo.cas(KINDS.member, `${w.org.id}.${lone.user.id}`, null, d => { d.managerId = w.manager.user.id; });
  const again = (await w.svc.submit(w.as(lone), p.id, { rev: back.rev, reason: REASON })).request;
  assert.equal(again.approval.approverId, w.manager.user.id);
  assert.equal(again.approval.pool, false);
  assert.ok(await link(w, p.id, 'pool', w.admin.user.id), 'the old pool link is still stored');
  assert.equal((await w.svc.inbox(w.as(w.admin), { tab: 'waiting' })).rows.length, 0);
  assert.equal(await w.svc.inboxCount(w.as(w.admin)), 0);
  // The admin can still act, but only as an override (labelled, note required).
  await assert.rejects(w.svc.decide(w.as(w.admin), p.id, { action: 'approve', rev: again.rev }), code('note_required'));
  assert.equal(await w.svc.inboxCount(w.as(w.manager)), 1);
});

test('a decider whose role changes while deciding cannot slip through (the member rev is checked in the commit)', async () => {
  const w = await world({ budgetCents: 1000000 });
  const q = await pending(w);
  const repo = w.svc.repo;
  const commit = repo.commit.bind(repo);
  let demoted = false;
  repo.commit = async spec => {
    if (!demoted && spec.checks && spec.checks.some(c => c.kind === KINDS.member)) {
      demoted = true;
      await repo.cas(KINDS.member, `${w.org.id}.${w.manager.user.id}`, null, d => { d.role = 'employee'; });
    }
    return commit(spec);
  };
  await assert.rejects(w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev }), e => e.status === 403);
  repo.commit = commit;
  assert.ok(demoted);
  const stored = await w.repo.get(KINDS.request, q.id);
  assert.equal(stored.status, 'pending');
  assert.deepEqual((await budgetOf(w)).commits, {});
  assert.equal(await link(w, q.id, 'decider', w.manager.user.id), null);
});

test('lists page 50 at a time without skipping or repeating a request', async () => {
  const w = await world();
  const ids = [];
  for (let i = 0; i < 53; i += 1) ids.push((await draft(w, w.traveler)).id);
  const t = w.as(w.traveler);
  const p1 = await w.svc.listRequests(t, { scope: 'mine' });
  assert.equal(p1.rows.length, 50);
  assert.ok(p1.cursor);
  const p2 = await w.svc.listRequests(t, { scope: 'mine', cursor: p1.cursor });
  assert.equal(p2.rows.length, 3);
  assert.deepEqual([...p1.rows, ...p2.rows].map(r => r.id).sort(), [...ids].sort());
  const a1 = await w.svc.listRequests(w.as(w.admin), { scope: 'all', status: 'draft' });
  const a2 = await w.svc.listRequests(w.as(w.admin), { scope: 'all', status: 'draft', cursor: a1.cursor });
  assert.equal(new Set([...a1.rows, ...a2.rows].map(r => r.id)).size, 53);
});

test('inbox tabs, counts and cursors; inboxCount is null for members who cannot decide', async () => {
  const w = await world();
  const reqs = [];
  for (let i = 0; i < 3; i += 1) {
    reqs.push(await pending(w));
    w.clock.set(new Date(Date.parse(FIXED_NOW) + (i + 1) * 60000).toISOString());
  }
  const m = w.as(w.manager);
  const inbox = await w.svc.inbox(m);
  assert.equal(inbox.tab, 'waiting');
  assert.deepEqual(inbox.rows.map(r => r.id), reqs.map(r => r.id), 'oldest first');
  assert.deepEqual(inbox.counts, { waiting: 3, decided: 0, company: null, expired: 0 });
  assert.equal(inbox.cursor, null);
  assert.equal(inbox.rows[0].violationsCount, 1);
  assert.equal(inbox.rows[0].waitingSince, FIXED_NOW);
  await assert.rejects(w.svc.inbox(m, { tab: 'nope' }), code('not_found'));
  await assert.rejects(w.svc.inbox(m, { cursor: 'waiting.7' }), code('not_found'));
  await assert.rejects(w.svc.inbox(m, { cursor: 'decided.50' }), code('not_found'));
  assert.deepEqual((await w.svc.inbox(m, { cursor: 'waiting.50' })).rows, []);
  await assert.rejects(w.svc.inbox(w.as(w.traveler)), e => e.status === 403);
  assert.equal(await w.svc.inboxCount(w.as(w.traveler)), null);
  assert.equal(await w.svc.inboxCount(w.as(w.finance)), null);
  assert.equal(await w.svc.inboxCount(m), 3);
  assert.equal((await w.svc.inbox(w.as(w.owner), { tab: 'company' })).counts.company, 3);
});

// ---------------------------------------------------------------------------------------------------------
// Reports and the dashboard

test('report tiles: shares in tenths rounded half up, top reasons, savings, statuses and Coming soon never $0', () => {
  const req = (status, evalStatus, rules = [], extra = {}) => ({
    id: `btr_${Math.random().toString(36).slice(2)}`, travelerId: extra.travelerId || 'usr_AAAAAAAAAAAAAAAA', travelerName: extra.travelerName || 'Sam',
    status, submittedAt: status === 'draft' ? null : FIXED_NOW, expiresAt: status === 'pending' ? '2026-10-10T09:00:00.000Z' : null,
    query: { departDate: extra.departDate || '2026-11-12' }, totalCents: 1000, originalTotalCents: extra.original ?? 1000,
    evaluation: { status: evalStatus, violations: rules.map(rule => ({ rule })) }, history: extra.history || [], ...extra,
  });
  assert.deepEqual(reports.outOfPolicyShare([]), { tenths: null, submitted: 0, outOrBlocked: 0 });
  const third = [req('pending', 'out', ['flight.cap']), req('approved', 'within'), req('approved', 'within'), req('draft', 'out', ['flight.cap'])];
  assert.deepEqual(reports.outOfPolicyShare(third), { tenths: 333, submitted: 3, outOrBlocked: 1 }, 'drafts never submitted are left out');
  assert.equal(reports.outOfPolicyShare([req('pending', 'out'), req('pending', 'out'), req('approved', 'within')]).tenths, 667);
  const sixteenth = [req('pending', 'out'), ...Array.from({ length: 15 }, () => req('approved', 'within'))];
  assert.equal(reports.outOfPolicyShare(sixteenth).tenths, 63, '62.5 rounds half up');

  const reasons = reports.topReasons([
    req('pending', 'out', ['flight.cap', 'flight.cap', 'hotel.cap']), req('pending', 'out', ['hotel.cap']), req('denied', 'out', ['budget']),
    req('denied', 'out', ['zz.custom']),
  ]);
  assert.deepEqual(reasons.map(r => [r.rule, r.count]), [['hotel.cap', 2], ['budget', 1], ['flight.cap', 1], ['zz.custom', 1]]);
  assert.equal(reasons[0].label, 'Hotel over the nightly limit');
  assert.equal(reasons[3].label, 'zz.custom');
  assert.equal(reports.topReasons(Array.from({ length: 9 }, (_, i) => req('pending', 'out', [`r.${i}`]))).length, 5);

  const swapped = (...saved) => ({ history: [{ action: 'drafted' }, ...saved.map(savedCents => ({ action: 'swapped', savedCents }))] });
  assert.equal(reports.savedBySwitching([
    req('approved', 'within', [], { original: 1400, ...swapped(400) }), req('approved', 'within', [], { original: 1300 }),
    req('cancelled', 'within', [], { original: 1900, ...swapped(900) }), req('approved', 'within', [], { original: 900, ...swapped(-100) }),
    // The price fell after the switches (original − total is 800): only the 250 they saved counts.
    req('approved', 'within', [], { original: 1800, ...swapped(300, -50) }),
  ]), 650, 'approved with a swap only, what each switch saved, never negative');

  const effectiveStatus = (r, nowIso) => (r.status === 'pending' && nowIso >= r.expiresAt ? 'expired' : r.status === 'approved' && r.query.departDate < nowIso.slice(0, 10) ? 'past' : r.status);
  const tiles = reports.reportTiles({
    requests: [req('pending', 'out', ['flight.cap']), req('approved', 'within', [], { travelerId: 'usr_BBBBBBBBBBBBBBBB', travelerName: 'Kim' }), req('approved', 'within', [], { departDate: '2026-10-01' }), req('draft', 'within')],
    budgets: [], nowIso: '2026-10-11T00:00:00.000Z', timezone: 'UTC', truncated: false, effectiveStatus,
  });
  assert.deepEqual(tiles.byStatus, { draft: 1, pending: 0, approved: 1, denied: 0, cancelled: 0, expired: 1, past: 1 });
  assert.deepEqual(tiles.byTraveler.map(t => [t.name, t.requests, t.committedCents]), [['Sam', 3, 1000], ['Kim', 1, 1000]]);
  assert.deepEqual(tiles.comingSoon, [{ key: 'spend', label: 'Spend booked' }, { key: 'invoices', label: 'Invoices' }]);
  for (const tile of tiles.comingSoon) assert.deepEqual(Object.keys(tile).sort(), ['key', 'label'], 'no amount, never $0');
  assert.equal(tiles.truncated, false);
  assert.throws(() => reports.reportTiles({ requests: [] }), TypeError);

  assert.deepEqual(reports.checklist({ policies: [{ version: 1 }], departments: [{ name: 'General' }], budgets: 0, invites: 0, memberCount: 1, requests: 0 }),
    { policyReviewed: false, departments: false, invited: false, demoTrip: false });
  assert.deepEqual(reports.checklist({ policies: [{ version: 2 }], departments: [{ name: 'General' }, { name: 'Sales' }], budgets: 0, invites: 1, memberCount: 1, requests: 2 }),
    { policyReviewed: true, departments: true, invited: true, demoTrip: true });
  assert.equal(reports.checklist({ policies: [], departments: [{ name: 'General' }], budgets: 1, invites: 0, memberCount: 2, requests: 0 }).departments, true);
});

test('dashboard: each role gets its sections; the Manager home has team trips this period', async () => {
  const w = await world({ budgetCents: 1000000 });
  const q = await pending(w);
  const a = await draft(w, w.traveler);
  await w.svc.submit(w.as(w.traveler), a.id, { rev: a.rev });
  await draft(w, w.manager); // the manager's own trip is left out of team trips

  const mgr = await w.svc.dashboard(w.as(w.manager), {});
  assert.equal(mgr.role, 'manager');
  assert.equal(mgr.periodKey, '2026-Q4');
  assert.equal(mgr.periodLabel, 'Q4 2026');
  assert.equal(mgr.checklist, null);
  assert.equal(mgr.waiting.count, 1);
  assert.deepEqual(mgr.waiting.rows.map(r => r.id), [q.id]);
  assert.deepEqual(mgr.teamTrips.map(r => r.id).sort(), [q.id, a.id].sort());
  assert.equal(mgr.myTrips.length, 1);
  assert.equal(mgr.pendingCompany, null);
  assert.equal(mgr.outOfPolicyShare, null);
  assert.equal(mgr.recent, null);
  assert.deepEqual(mgr.budgets.map(b => b.department.name), ['Engineering']);
  assert.equal(mgr.reports, null);
  assert.equal(mgr.policy.title, 'Your travel policy');
  assert.equal((await w.svc.dashboard(w.as(w.manager), { periodKey: '2027-Q1' })).teamTrips.length, 0);

  const emp = await w.svc.dashboard(w.as(w.traveler), {});
  assert.equal(emp.waiting, null);
  assert.equal(emp.teamTrips, null);
  assert.equal(emp.budgets, null);
  assert.equal(emp.myTrips.length, 2);

  const own = await w.svc.dashboard(w.as(w.owner), {});
  assert.deepEqual(own.checklist, { policyReviewed: false, departments: true, invited: true, demoTrip: true });
  assert.deepEqual(own.pendingCompany, { count: 1 });
  assert.deepEqual(own.outOfPolicyShare, { tenths: 500, submitted: 2, outOrBlocked: 1 });
  assert.deepEqual(own.topReasons.map(r => r.rule), ['flight.cap']);
  assert.equal(own.recent.length, 5);

  const fin = await w.svc.dashboard(w.as(w.finance), { view: 'reports' });
  assert.equal(fin.reports.byStatus.pending, 1);
  assert.equal(fin.reports.byStatus.approved, 1);
  assert.equal(fin.reports.byStatus.draft, 1);
  assert.deepEqual(fin.reports.comingSoon.map(t => t.label), ['Spend booked', 'Invoices']);
  assert.ok(fin.reports.committedVsBudget.some(b => b.department.name === 'Engineering' && b.committedCents === WITHIN_TOTAL));
  await assert.rejects(w.svc.dashboard(w.as(w.manager), { view: 'reports' }), e => e.status === 403);
  await assert.rejects(w.svc.dashboard(w.as(w.finance), { view: 'other' }), code('not_found'));
  await assert.rejects(w.svc.dashboard(w.as(w.finance), { periodKey: 'Q4' }), code('invalid_period'));
});

// ---------------------------------------------------------------------------------------------------------
// CSV

test('CSV: the 21 columns, a BOM and CRLF, the formula guard and Demo price on every row', async () => {
  assert.equal(csv.csvCell(null), '');
  assert.equal(csv.csvCell(undefined), '');
  assert.equal(csv.csvCell(12), '12');
  for (const bad of ['=SUM(A1)', '+1', '-1', '@x', '\tx', '\rx']) assert.equal(csv.csvCell(bad).replace(/^"/, '')[0], "'", JSON.stringify(bad));
  assert.equal(csv.csvCell('a,b'), '"a,b"');
  assert.equal(csv.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csv.csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csv.csvCell('=1,2'), '"\'=1,2"');
  assert.equal(csv.toCsv(['a', 'b'], [[1, 'x']]), '﻿a,b\r\n1,x\r\n');

  const w = await world({ budgetCents: 1000000 });
  const evil = await seedMember(w.app, w.org, 'employee', { name: '=HYPERLINK("http://x")', departmentId: w.eng.id, managerId: w.manager.user.id });
  const q = await pending(w, evil);
  await w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev });
  const r = await draft(w, w.traveler, OUTSIDE);
  const s = await w.svc.swap(w.as(w.traveler), r.id, { altId: r.cheapestWithin.id, rev: r.rev });
  await w.svc.submit(w.as(w.traveler), r.id, { rev: s.rev });

  const out = await w.svc.exportCsv(w.as(w.finance), {});
  assert.equal(out.filename, 'tripelyx-requests-2026-Q4.csv');
  assert.equal(out.rowCount, 2);
  assert.equal(out.truncated, false);
  assert.ok(out.body.startsWith('﻿'));
  const lines = out.body.slice(1).split('\r\n');
  assert.equal(lines.at(-1), '', 'ends with CRLF');
  assert.equal(lines[0], csv.CSV_COLUMNS.join(','));
  assert.equal(csv.CSV_COLUMNS.length, 21);
  const rows = lines.slice(1, -1);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(row.startsWith('Demo price,'), row);
  const evilRow = rows.find(x => x.includes(q.id));
  assert.ok(evilRow.includes('"\'=HYPERLINK(""http://x"")"'), evilRow);
  assert.ok(evilRow.includes(',Dana Lee,'));
  assert.ok(evilRow.includes(',1768.00,'), 'total in dollars with 2 decimals');
  assert.ok(evilRow.includes(',2026-10-09 12:00,'), 'decided time local to Cairo');
  const swapRow = rows.find(x => x.includes(r.id));
  const cells = swapRow.split(',');
  assert.equal(cells[csv.CSV_COLUMNS.indexOf('approval_mode')], 'auto');
  assert.equal(cells[csv.CSV_COLUMNS.indexOf('approver')], 'Approved by policy');
  assert.equal(cells[csv.CSV_COLUMNS.indexOf('saved_by_switching_usd')], ((OUTSIDE_TOTAL - s.totalCents) / 100).toFixed(2));
  assert.equal(cells[csv.CSV_COLUMNS.indexOf('currency')], 'USD');
  assert.equal(cells[csv.CSV_COLUMNS.indexOf('hotel_city')], 'London');
  assert.equal(cells[csv.CSV_COLUMNS.indexOf('nights')], '4');
  for (const secret of ['netNightly', 'commission', 'markup', 'FakeFlights', 'FakeHotels', 'internal']) assert.ok(!out.body.includes(secret), secret);

  const [audit] = await auditsFor(w, 'reports.exported');
  assert.deepEqual(audit.changes[0], { path: 'rowCount', before: null, after: 2 });
  assert.equal((await w.svc.exportCsv(w.as(w.finance), { status: 'approved', travelerId: evil.user.id })).rowCount, 1);
  assert.equal((await w.svc.exportCsv(w.as(w.finance), { period: '2027-Q1' })).rowCount, 0);
  await assert.rejects(w.svc.exportCsv(w.as(w.finance), { status: 'nope', departmentId: 'x' }), e => e.code === 'invalid_filter' && !!e.details.status && !!e.details.departmentId);
  await assert.rejects(w.svc.exportCsv(w.as(w.manager), {}), e => e.status === 403);
});

// ---------------------------------------------------------------------------------------------------------
// Review round (Stage 1W-b): each test failed before its fix

test('approving keeps the evaluation the request was submitted with, whatever the policy says now', async () => {
  // The limit raised while the request waited, then tightened until the trip would be blocked.
  for (const change of [{ flightCapCents: 70000 }, { blockedCarriers: ['ZS', 'ZM'] }]) {
    const w = await world({ budgetCents: 1000000 });
    const q = await pending(w);
    const submitted = structuredClone(q.evaluation);
    assert.equal(submitted.status, 'out');
    w.policy.configure(change);
    const searches = w.composer.calls.search;
    const res = await w.svc.decide(w.as(w.manager), q.id, { action: 'approve', rev: q.rev });
    assert.equal(res.outcome, 'approved');
    assert.deepEqual(res.request.evaluation, submitted, JSON.stringify(change));
    assert.equal(w.composer.calls.search, searches, 'approving runs no new search');
    assert.deepEqual(reports.outOfPolicyShare([res.request]), { tenths: 1000, submitted: 1, outOrBlocked: 1 });
    assert.deepEqual(reports.topReasons([res.request]).map(r => r.rule), ['flight.cap']);
    const row = (await w.svc.exportCsv(w.as(w.finance), {})).body.split('\r\n')[1];
    assert.ok(row.includes(',out,'), row);
  }
});

test('a POST reads the clock once: crossing expiresAt half-way never answers 409 with the request left pending', async () => {
  const posts = {
    deny: (w, q) => w.svc.decide(w.as(w.manager), q.id, { action: 'deny', note: 'Not this time, sorry.', rev: q.rev }),
    message: (w, q) => w.svc.message(w.as(w.manager), q.id, { text: 'Any update on this?' }),
    cancel: (w, q) => w.svc.cancel(w.as(w.traveler), q.id, { rev: q.rev }),
  };
  for (const [name, post] of Object.entries(posts)) {
    const w = await world();
    const q = await pending(w);
    const exp = Date.parse(q.expiresAt);
    const repo = w.svc.repo;
    const clock = repo.clock;
    let reads = 0;
    repo.clock = () => { reads += 1; return new Date(reads <= 1 ? exp - 1 : exp); };
    let err = null;
    try { await post(w, q); } catch (e) { err = e; }
    repo.clock = clock;
    const stored = await w.repo.get(KINDS.request, q.id);
    if (err) {
      assert.equal(err.code, 'request_expired', `${name}: ${err.code}`);
      assert.equal(stored.status, 'expired', `${name}: a 409 request_expired persists the expiry`);
    } else {
      assert.notEqual(stored.rev, q.rev, `${name}: the POST wrote`);
    }
  }
});

test('override holders see the cancel button on a departed (past) approved trip, as the POST allows', async () => {
  const w = await world({ budgetCents: 1000000 });
  const r = await draft(w, w.traveler);
  const ok = (await w.svc.submit(w.as(w.traveler), r.id, { rev: r.rev })).request;
  w.clock.set('2026-11-13T09:00:00.000Z');
  const admin = await w.svc.getRequest(w.as(w.admin), r.id);
  assert.equal(admin.status, 'past');
  assert.equal(admin.can.cancel, true);
  const own = await w.svc.getRequest(w.as(w.traveler), r.id);
  assert.equal(own.can.cancel, false, 'the traveler cannot cancel after departure');
  await assert.rejects(w.svc.cancel(w.as(w.traveler), r.id, { rev: ok.rev }), code('departed'));
  const fin = await w.svc.getRequest(w.as(w.finance), r.id);
  assert.equal(fin.can.cancel, false, 'no override, no button');
  assert.equal((await w.svc.cancel(w.as(w.admin), r.id, { rev: ok.rev })).status, 'cancelled');
});

test('a draft that was within policy but is not anymore at Confirm is updated with its new verdict, not refused', async () => {
  // The department budget is used up by a colleague first.
  const w = await world({ budgetCents: WITHIN_TOTAL + 1000 });
  const other = await seedMember(w.app, w.org, 'employee', { name: 'Kim Other', departmentId: w.eng.id, managerId: w.manager.user.id });
  const a = await draft(w, w.traveler);
  const b = await draft(w, other);
  assert.equal(b.evaluation.status, 'within');
  assert.equal((await w.svc.submit(w.as(w.traveler), a.id, { rev: a.rev })).outcome, 'auto_approved');
  const res = await w.svc.submit(w.as(other), b.id, { rev: b.rev });
  assert.equal(res.outcome, 'repriced');
  assert.equal(res.request.status, 'draft');
  assert.equal(res.request.rev, b.rev + 1);
  assert.equal(res.request.totalCents, WITHIN_TOTAL, 'the price did not change');
  assert.equal(res.request.evaluation.status, 'out');
  assert.deepEqual(res.request.evaluation.violations.map(v => v.rule), ['budget']);
  assert.deepEqual(res.request.history.map(h => h.action), ['drafted'], 'no price line: only the verdict moved');
  const [audit] = await auditsFor(w, 'request.repriced');
  assert.equal(audit.target.id, b.id);
  assert.doesNotMatch(audit.summary, /price/i);
  assert.deepEqual((await budgetOf(w)).commits, { [a.id]: WITHIN_TOTAL });
  const view = await w.svc.getRequest(w.as(other), b.id);
  assert.equal(view.request.evaluation.status, 'out', 'the page now shows the Request Approval form');
  assert.equal(view.can.submit, true);
  const sent = await w.svc.submit(w.as(other), b.id, { rev: res.request.rev, reason: REASON });
  assert.equal(sent.outcome, 'submitted');

  // The policy tightened since the draft: the same.
  const w2 = await world();
  const c = await draft(w2, w2.traveler);
  w2.policy.configure({ flightCapCents: 10000 });
  const res2 = await w2.svc.submit(w2.as(w2.traveler), c.id, { rev: c.rev });
  assert.equal(res2.outcome, 'repriced');
  assert.equal(res2.request.evaluation.status, 'out');
  assert.ok(res2.request.alternatives.length >= 0);
});

test('swapping to an option inside policy keeps the cheapest option inside policy the traveler saw', async () => {
  const w = await world({ budgetCents: 1000000 });
  const r = await draft(w, w.traveler, OUTSIDE);
  const cheapest = r.cheapestWithin;
  assert.ok(cheapest);
  const s = await w.svc.swap(w.as(w.traveler), r.id, { altId: cheapest.id, rev: r.rev });
  assert.equal(s.evaluation.status, 'within');
  assert.equal(s.cheapestWithin && s.cheapestWithin.id, cheapest.id);
  assert.equal(s.cheapestWithin.totalCents, cheapest.totalCents);
  // A later re-price of the (within) pick keeps it too.
  w.inventory.setPrice(s.selection.hotel, s.rows.hotel.totalCents - 1000);
  const rp = await w.svc.submit(w.as(w.traveler), r.id, { rev: s.rev });
  assert.equal(rp.outcome, 'repriced');
  assert.equal(rp.request.cheapestWithin && rp.request.cheapestWithin.id, cheapest.id);
  const done = await w.svc.submit(w.as(w.traveler), r.id, { rev: rp.request.rev });
  const cells = csv.requestRow(done.request, { timezone: 'UTC', status: 'approved', departmentName: 'Engineering', approverName: '' });
  assert.equal(cells[csv.CSV_COLUMNS.indexOf('cheapest_in_policy_usd')], (cheapest.totalCents / 100).toFixed(2));
});

test('saved by switching is what each switch saved, on approved trips only; the CSV and the tile agree', async () => {
  const w = await world({ budgetCents: 1000000 });
  const r = await draft(w, w.traveler, OUTSIDE);
  const s = await w.svc.swap(w.as(w.traveler), r.id, { altId: r.cheapestWithin.id, rev: r.rev });
  const saved = s.history.at(-1).savedCents;
  assert.equal(saved, OUTSIDE_TOTAL - s.totalCents);
  // The outbound gets cheaper after the switch: that is a price change, not a saving from switching.
  w.inventory.setPrice(s.selection.out, s.rows.out.totalCents - 15000);
  const rp = await w.svc.submit(w.as(w.traveler), r.id, { rev: s.rev });
  assert.equal(rp.outcome, 'repriced');
  const done = await w.svc.submit(w.as(w.traveler), r.id, { rev: rp.request.rev });
  assert.equal(done.outcome, 'auto_approved');
  assert.equal(done.request.totalCents, s.totalCents - 15000);
  assert.equal(reports.savedBySwitching([done.request]), saved);
  const col = csv.CSV_COLUMNS.indexOf('saved_by_switching_usd');
  const ctx = status => ({ timezone: 'UTC', status, departmentName: 'Engineering', approverName: '' });
  assert.equal(csv.requestRow(done.request, ctx('approved'))[col], (saved / 100).toFixed(2));

  // A switched trip that was then cancelled saved nothing.
  const c = await draft(w, w.traveler, OUTSIDE);
  const cs = await w.svc.swap(w.as(w.traveler), c.id, { altId: c.cheapestWithin.id, rev: c.rev });
  const cancelled = await w.svc.cancel(w.as(w.traveler), c.id, { rev: cs.rev });
  assert.equal(reports.savedBySwitching([cancelled]), 0);
  assert.equal(csv.requestRow(cancelled, ctx('cancelled'))[col], '', 'blank, never a saving');

  const d = await w.svc.dashboard(w.as(w.finance), { view: 'reports' });
  assert.equal(d.reports.savedBySwitchingCents, saved);
  const out = await w.svc.exportCsv(w.as(w.finance), {});
  const sum = out.body.slice(1).split('\r\n').slice(1, -1).map(line => line.split(',')).reduce((n, cells) => n + Math.round(Number(cells[col] || 0) * 100), 0);
  assert.equal(sum, saved, 'the CSV column sums to the tile');
});

test('CSV: a formula after a semicolon is guarded too (spreadsheets in semicolon locales split on it)', async () => {
  const starts = /^[\s"]*[=+\-@\t\r]/;
  for (const s of ['x;=1+2;y', 'Sam;=HYPERLINK(CHAR(104)&CHAR(116));x', 'a; +1', 'a;"=1', 'a;-2', 'a;@b', ';=1', 'a;\t=1']) {
    const cell = csv.csvCell(s);
    for (const part of cell.split(';').slice(1)) assert.doesNotMatch(part, starts, `${JSON.stringify(s)} → ${JSON.stringify(cell)}`);
  }
  assert.equal(csv.csvCell('Sales; Europe'), 'Sales; Europe', 'plain text keeps its semicolons');
  assert.equal(csv.csvCell("a;'=1"), "a;'=1", 'already guarded');

  const w = await world({ budgetCents: 1000000 });
  const sam = await seedMember(w.app, w.org, 'employee', { name: 'Sam;=HYPERLINK(CHAR(104));x', departmentId: w.eng.id, managerId: w.manager.user.id });
  await draft(w, sam);
  const out = await w.svc.exportCsv(w.as(w.finance), {});
  const row = out.body.split('\r\n')[1];
  for (const part of row.split(';').slice(1)) assert.doesNotMatch(part, starts, row);
});

test('a pool member demoted below admin leaves the pool: no decision, no note-free approval, no view', async () => {
  const w = await world({ budgetCents: 1000000 });
  const lone = await seedMember(w.app, w.org, 'employee', { name: 'Lou Lone', departmentId: w.eng.id });
  const p = await pending(w, lone);
  assert.ok(p.approval.poolIds.includes(w.admin.user.id));
  await w.repo.cas(KINDS.member, `${w.org.id}.${w.admin.user.id}`, null, d => { d.role = 'manager'; });
  const ex = w.as(w.admin);
  await assert.rejects(w.svc.decide(ex, p.id, { action: 'approve', note: '', rev: p.rev }), code('not_found'));
  await assert.rejects(w.svc.getRequest(ex, p.id), code('not_found'));
  await assert.rejects(w.svc.message(ex, p.id, { text: 'Any update on this?' }), code('not_found'));
  assert.equal((await w.svc.inbox(ex, {})).counts.waiting, 0);
  assert.equal(await w.svc.inboxCount(ex), 0);
  assert.equal((await w.svc.listRequests(ex, { scope: 'team' })).rows.length, 0);
  assert.equal((await w.repo.get(KINDS.request, p.id)).status, 'pending');
  // The owner, still an admin, decides as the pool.
  const ok = await w.svc.decide(w.as(w.owner), p.id, { action: 'approve', rev: p.rev });
  assert.equal(ok.request.approval.decidedAs, 'pool');
});

test('an override cancellation checks the canceller\'s member record in the commit', async () => {
  const w = await world({ budgetCents: 1000000 });
  const r = await draft(w, w.traveler);
  const ok = (await w.svc.submit(w.as(w.traveler), r.id, { rev: r.rev })).request;
  const repo = w.svc.repo;
  const commit = repo.commit.bind(repo);
  let demoted = false;
  repo.commit = async spec => {
    if (!demoted && spec.cas && spec.cas.some(c => c.kind === KINDS.request)) {
      demoted = true;
      await repo.cas(KINDS.member, `${w.org.id}.${w.admin.user.id}`, null, d => { d.role = 'employee'; });
    }
    return commit(spec);
  };
  await assert.rejects(w.svc.cancel(w.as(w.admin), r.id, { rev: ok.rev }), e => e.status === 403);
  repo.commit = commit;
  assert.ok(demoted);
  assert.equal((await w.repo.get(KINDS.request, r.id)).status, 'approved');
  assert.deepEqual((await budgetOf(w)).commits, { [r.id]: WITHIN_TOTAL });
  assert.equal((await auditsFor(w, 'request.cancelled')).length, 0);
});

test('a filtered list matching few requests reads the store in whole pages, not one record at a time', async () => {
  const w = await world();
  const proto = await w.repo.get(KINDS.request, (await draft(w, w.traveler)).id);
  const put = async status => {
    const rid = newId(ID_PREFIX.request);
    await w.repo.insert(KINDS.request, rid, { ...structuredClone(proto), id: rid, rev: 0, status }, { owner: w.org.id });
  };
  for (let i = 0; i < 150; i += 1) await put('cancelled');
  for (let i = 0; i < 48; i += 1) await put('draft'); // 49 drafts in all, the newest
  const repo = w.svc.repo;
  const page = repo.page.bind(repo);
  let calls = 0;
  repo.page = (...args) => { if (args[0] === KINDS.request) calls += 1; return page(...args); };
  const res = await w.svc.listRequests(w.as(w.finance), { scope: 'all', status: 'draft' });
  repo.page = page;
  assert.equal(res.rows.length, 49);
  assert.equal(res.cursor, null);
  assert.ok(calls <= 5, `${calls} store pages`);
});

test('CSV: when the 5,000-request scan is hit, the note row says so and promises nothing else', async () => {
  const w = await world();
  const proto = await w.repo.get(KINDS.request, (await draft(w, w.traveler)).id);
  const repo = w.svc.repo;
  const page = repo.page.bind(repo);
  let n = 0;
  repo.page = async (kind, scope, opts) => {
    if (kind !== KINDS.request) return page(kind, scope, opts);
    n += 1;
    return { rows: Array.from({ length: opts.limit }, (_, i) => ({ ...structuredClone(proto), id: `btr_${String(n).padStart(8, '0')}${String(i).padStart(8, '0')}` })), cursor: 'more' };
  };
  const out = await w.svc.exportCsv(w.as(w.finance), {});
  repo.page = page;
  assert.equal(out.truncated, true);
  const lines = out.body.slice(1).split('\r\n');
  assert.match(lines.at(-2), /^"Based on the 5,000 most recent requests\.",/);
  assert.doesNotMatch(out.body, /Narrow the filters/, 'filters run on the same 5,000 requests, so narrowing reaches nothing older');
});
