// Stage 1 integration: the REAL Business modules, wired exactly as server/app.js wires them (1I's demo
// inventory and TripComposer, 1P's policy engine, alternatives and explainer, 1W-a's team methods, 1W-b's
// requests and budgets, 1S's accounts), driven through the service with no fakes. One company with an Owner,
// a Travel Admin, a Manager, an Employee and Finance, an Engineering budget for Q4 2026, then:
//   (a) a trip inside policy is approved by policy with a budget hold;
//   (b) Business class plus a 5-star hotel gets real cheaper alternatives with honest labels and savings, a
//       swap, Request Approval with a reason, the manager's approval, and the budget committed;
//   (c) a blocked airline's rows cannot be picked, and a submit on one is refused;
//   (d) deny and cancel release what the budget had counted;
//   (e) a second company can neither see nor touch any of it.
// No HTTP server is started: createApp is called directly. The clock is held at FIXED_NOW.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { AppError } = require('../server/lib/errors');
const { TripComposer } = require('../server/business/search');
const { POLICY_ENGINE_METHODS } = require('../server/business/policy');
const { BusinessDemoFlights } = require('../server/business/demo/flights');
const { BusinessDemoHotels } = require('../server/business/demo/hotels');
const alternativesModule = require('../server/business/alternatives');
const { DIFF_FIELDS } = require('../server/business/diff');
const { KINDS } = require('../server/business/constants');
const parts = require('../server/views/business/parts');
const { quietLog, FIXED_NOW } = require('./helpers');
const { mutableClock, PASSWORD } = require('./business-helpers');

const TZ = 'Africa/Cairo';
const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });
const MONEY = /[$€£¥]|\bUSD\b/;
const REASON = 'The board meets at the client office, and this is the only flight that lands in time.';

const rejectsWith = (p, status, code) => assert.rejects(p, e => {
  assert.ok(e instanceof AppError, `expected an AppError, got ${e && e.stack}`);
  assert.deepEqual([e.status, e.code], [status, code], e.message);
  return true;
});

/** The real app (Business on, demo inventory, D1 platform admin) and a confirmed company seeded through the service. */
async function world() {
  const clock = mutableClock(FIXED_NOW);
  const config = loadConfig({ APP_ENV: 'development', ENABLE_BUSINESS: 'true', ADMIN_EMAILS: 'ops@example.com' });
  const app = await createApp(config, { log: quietLog, now: clock.now, store: new MemoryStore() });
  const svc = app.business;
  const register = (name, email) => app.accounts.register({ name, email, password: PASSWORD });
  const ops = await register('Pat Platform', 'ops@example.com');
  await app.accounts.grantPlatformAdmin(ops.id, { by: 'test' });
  const admin = { user: { ...ops, isAdmin: true } };

  async function company(name, ownerName, domain) {
    const ownerUser = await register(ownerName, `owner@${domain}`);
    let { org } = await svc.createCompany({ user: ownerUser }, { name, size: '11-50 people', ack: '1' });
    assert.equal(org.status, 'pending', 'a new company waits for Tripelyx');
    org = await svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev });
    const owner = { user: ownerUser, actor: { org: { id: org.id }, user: ownerUser } };
    const join = async (person, email, role, extra = {}) => {
      const user = await register(person, email);
      const { token } = await svc.invite(owner.actor, { email, role, ...extra });
      assert.equal((await svc.inviteByToken({ user: null }, token)).state, 'join');
      const { member } = await svc.acceptInvite({ user }, token);
      return { user, member, actor: { org: { id: org.id }, user } };
    };
    return { org, owner, join };
  }

  const acme = await company('Acme Inc', 'Olivia Owner', 'acme.example');
  const eng = await svc.saveDepartment(acme.owner.actor, { name: 'Engineering' });
  const tom = await acme.join('Tom Travel', 'tom@acme.example', 'travel_admin');
  const dana = await acme.join('Dana Lee', 'dana@acme.example', 'manager', { departmentId: eng.id });
  const sam = await acme.join('Sam Rivera', 'sam@acme.example', 'employee', { departmentId: eng.id, managerId: dana.user.id });
  const fay = await acme.join('Fay Finance', 'fay@acme.example', 'finance');
  await svc.setBudget(fay.actor, eng.id, '2026-Q4', null, '20000');
  return { app, svc, clock, admin, company, acme, eng, tom, dana, sam, fay, owner: acme.owner };
}

/** Engineering's Q4 2026 budget row as Finance sees it. */
async function engBudget(w) {
  const rows = await w.svc.listBudgets(w.fay.actor, '2026-Q4');
  return rows.find(r => r.department.id === w.eng.id);
}

const rowsOf = (sv, leg) => sv.legs[leg].rows;
const keyWhere = (sv, leg, f) => {
  const hit = rowsOf(sv, leg).find(f);
  assert.ok(hit, `a ${leg} row for the test`);
  return hit.row.key;
};

/** A trip inside the Standard policy: Economy LIGHT fares on one airline and a 3-star hotel. */
async function withinTrip(w, actor = w.sam.actor, purpose = 'Client workshop in London') {
  const sv = await w.svc.searchTrip(actor, Q);
  const ok = r => r.row.available && r.row.carrier.code === 'ZA' && r.evaluation.status === 'within';
  const selection = { out: keyWhere(sv, 'out', ok), back: keyWhere(sv, 'back', ok), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 3 && r.evaluation.status === 'within') };
  return w.svc.createRequest(actor, { query: Q, selection, purpose });
}

/** Business class on both legs and a 5-star hotel: out of the Standard policy. */
async function businessTrip(w, purpose = 'Board meeting in London') {
  const q = { ...Q, cabin: 'business' };
  const sv = await w.svc.searchTrip(w.sam.actor, q);
  const zm = r => r.row.available && r.row.carrier.code === 'ZM';
  const selection = { out: keyWhere(sv, 'out', zm), back: keyWhere(sv, 'back', zm), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5) };
  return w.svc.createRequest(w.sam.actor, { query: q, selection, purpose });
}

const sumRows = rows => ['out', 'back', 'hotel'].reduce((s, c) => s + (rows[c] ? rows[c].totalCents : 0), 0);

// ---------------------------------------------------------------------------------------------------------

test('the service runs on the real modules: demo inventory, TripComposer, the policy engine, alternatives, the rule explainer and D1 accounts', async () => {
  const w = await world();
  const { svc, app } = w;
  assert.equal(svc.inventory.status, 'demo');
  assert.ok(svc.inventory.flights instanceof BusinessDemoFlights);
  assert.ok(svc.inventory.hotels instanceof BusinessDemoHotels);
  assert.ok(svc.composer instanceof TripComposer);
  assert.deepEqual(Object.keys(svc.policy).sort(), [...POLICY_ENGINE_METHODS].sort());
  assert.ok(!('calls' in svc.policy) && !('configure' in svc.policy), 'not fakePolicy');
  assert.ok(!('inputs' in svc.alternatives) && !('inputs' in svc.explainer), 'not the fake alternatives or explainer');
  assert.equal(svc.explainer.name, 'rules');
  assert.equal(svc.accounts, app.accounts);
  // The seeded company, as its members see it.
  const org = await svc.getOrg(w.sam.actor);
  assert.deepEqual([org.name, org.status, org.timezone, org.statusBy, org.statusNote, 'settingsRev' in org], ['Acme Inc', 'active', TZ, null, null, false]);
  const people = await svc.listMembers(w.owner.actor);
  assert.deepEqual(people.members.map(m => m.role).sort(), ['employee', 'finance', 'manager', 'owner', 'travel_admin']);
  const budget = await engBudget(w);
  assert.deepEqual([budget.amountCents, budget.committedCents, budget.awaitingCents, budget.remainingCents], [2000000, 0, 0, 2000000]);
});

test('(a) a trip inside policy is approved by policy on submit, with a budget hold for its total', async () => {
  const w = await world();
  const { svc, sam } = w;
  const draft = await withinTrip(w);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.evaluation.status, 'within');
  assert.deepEqual(draft.evaluation.violations, []);
  assert.equal(draft.totalCents, sumRows(draft.rows));
  assert.equal(draft.originalTotalCents, draft.totalCents);
  assert.deepEqual(draft.alternatives, [], 'no alternatives for a trip already inside policy');
  assert.equal(draft.query.hotel.city, 'London');
  assert.equal(draft.demo, true);
  for (const c of ['out', 'back', 'hotel']) assert.equal(draft.rows[c].demo, true, c);

  const view = await svc.getRequest(sam.actor, draft.id);
  assert.equal(view.can.submit, true);
  assert.equal(view.budget.remainingCents, 2000000);
  assert.equal(view.approver.userId, w.dana.user.id, 'who it would go to if it needed approval');

  const { outcome, request } = await svc.submit(sam.actor, draft.id, { rev: draft.rev });
  assert.equal(outcome, 'auto_approved');
  assert.equal(request.status, 'approved');
  assert.deepEqual(request.approval.decidedBy, { system: 'policy' });
  assert.deepEqual(request.budget, { budgetId: `${w.acme.org.id}.${w.eng.id}.2026-Q4`, periodKey: '2026-Q4', cents: draft.totalCents });
  const budget = await engBudget(w);
  assert.deepEqual([budget.committedCents, budget.awaitingCents, budget.remainingCents], [draft.totalCents, 0, 2000000 - draft.totalCents]);
  // Nothing was booked or charged.
  for (const kind of ['quote', 'booking', 'payment_intent']) assert.equal([...w.app.store.records.keys()].filter(k => k.startsWith(`${kind}:`)).length, 0, kind);
});

test('(b) Business class and a 5-star hotel: honest cheaper alternatives, a swap, Request Approval, the manager approves, the budget is committed', async () => {
  const w = await world();
  const { svc, sam, dana } = w;
  const draft = await businessTrip(w);
  assert.equal(draft.evaluation.status, 'out');
  assert.deepEqual([...new Set(draft.evaluation.violations.map(v => v.rule))].sort(), ['flight.cabin', 'hotel.cap', 'hotel.stars']);
  for (const v of draft.evaluation.violations) assert.doesNotMatch(v.text, /—/);

  // Real alternatives from the same search, ranked and explained.
  const alts = draft.alternatives;
  assert.ok(alts.length >= 2 && alts.length <= alternativesModule.MAX_ALTERNATIVES, `${alts.length} alternatives`);
  const kinds = new Set(alts.map(a => a.kind));
  assert.ok(kinds.has('hotel'), 'a cheaper hotel in the same city');
  for (const a of alts) {
    assert.equal(a.savesCents, draft.totalCents - a.totalCents, `${a.label}: the saving is the difference of the two totals`);
    assert.ok(a.savesCents >= alternativesModule.MIN_SAVING_CENTS, a.label);
    assert.equal(a.totalCents, sumRows(a.rows), `${a.label}: the total is the sum of its rows`);
    assert.notEqual(a.evaluation.status, 'blocked');
    assert.match(a.label, /^[^$\d]*$/, 'labels hold no amounts');
    assert.match(a.note, /^[^$\d]*$/, 'notes hold no amounts');
    for (const g of a.giveUps) assert.doesNotMatch(g, MONEY, g);
    assert.ok(a.giveUps.length >= 1 && !a.giveUps.includes('Nothing else changes'), `${a.label}: says what changes`);
    // Honest labels: nothing out of policy claims to be inside it.
    if (a.evaluation.status !== 'within') {
      assert.doesNotMatch(`${a.label} ${a.note}`, /inside your policy|fits your policy/i, a.label);
      assert.match(a.note, /still needs approval/i, a.label);
    }
    // Never another route, city or set of dates.
    const ends = row => [row.segments[0].from.code, row.segments[row.segments.length - 1].to.code, row.segments[0].departLocal.slice(0, 10)];
    for (const leg of ['out', 'back']) assert.deepEqual(ends(a.rows[leg]), ends(draft.rows[leg]), `${a.label}: the same ${leg} route and day`);
    assert.equal(a.rows.hotel.city, 'London');
    assert.equal(a.rows.hotel.checkIn, draft.rows.hotel.checkIn);
    assert.equal(a.rows.hotel.checkOut, draft.rows.hotel.checkOut);
  }
  const hotelAlts = alts.filter(a => a.kind === 'hotel');
  for (const a of hotelAlts) {
    assert.equal(a.label, 'Another hotel in London');
    assert.ok(a.giveUps.includes(`${a.rows.hotel.stars}-star instead of 5-star`), a.giveUps.join(' / '));
    assert.ok(a.giveUps.some(g => g.startsWith('Stays at ')), 'names the other hotel');
  }
  // Ranked by saving among the same verdicts, and the stored explanation names the explainer that ran.
  const outs = alts.filter(a => a.evaluation.status === 'out').map(a => a.savesCents);
  assert.deepEqual(outs, [...outs].sort((x, y) => y - x));
  assert.equal(new Set(alts.map(a => a.id)).size, alts.length, 'alternative ids are unique');
  assert.equal(draft.explanation.explainer, 'rules');
  assert.match(draft.explanation.summary, /^[^$\d]*$/);
  if (!draft.cheapestWithin) {
    assert.equal(draft.explanation.summary, 'No cheaper option inside your policy turned up in this search. You can still request approval with a reason.');
  }
  // The shared view part renders these real alternatives with every amount demo-labelled and the label once.
  const panel = String(parts.alternativesPanel(draft, { timeZone: TZ, action: '/swap', rev: draft.rev }));
  assert.equal(panel.split(parts.CHEAPEST_WITHIN_LABEL).length - 1, draft.cheapestWithin ? 1 : 0);
  assert.doesNotMatch(panel, /style=|<script|—/);

  // Swap to the cheapest hotel alternative: still Business class, so still out of policy.
  const pick = hotelAlts.sort((x, y) => y.savesCents - x.savesCents)[0];
  const swapped = await svc.swap(sam.actor, draft.id, { altId: pick.id, rev: draft.rev });
  assert.deepEqual([swapped.status, swapped.evaluation.status], ['draft', 'out']);
  assert.deepEqual(swapped.selection, pick.selection);
  assert.equal(swapped.totalCents, pick.totalCents);
  assert.equal(swapped.originalTotalCents, draft.totalCents, 'the first pick is kept for "saved by switching"');
  const line = swapped.history.find(h => h.action === 'swapped');
  assert.deepEqual([line.savedCents, line.note], [pick.savesCents, pick.label]);
  assert.deepEqual([...new Set(swapped.evaluation.violations.map(v => v.rule))], ['flight.cabin']);
  await rejectsWith(svc.swap(sam.actor, draft.id, { altId: pick.id, rev: draft.rev }), 409, 'conflict');

  // Request Approval: a reason is needed, then it goes to Dana, Sam's manager.
  const before = await svc.getRequest(sam.actor, draft.id);
  assert.deepEqual([before.approver.userId, before.approver.rule], [dana.user.id, 'manager']);
  await rejectsWith(svc.submit(sam.actor, draft.id, { rev: swapped.rev, reason: 'Board.' }), 422, 'reason_too_short');
  await rejectsWith(svc.submit(sam.actor, draft.id, { rev: swapped.rev, reason: 'Card 4111 1111 1111 1111 for the hotel deposit' }), 422, 'card_number');
  const sent = await svc.submit(sam.actor, draft.id, { rev: swapped.rev, reason: REASON, category: '' });
  assert.equal(sent.outcome, 'submitted');
  assert.equal(sent.request.status, 'pending');
  assert.deepEqual([sent.request.approval.approverId, sent.request.approval.mode, sent.request.reason.text], [dana.user.id, 'manual', REASON]);
  assert.equal(sent.request.expiresAt, '2026-10-10T09:00:00.000Z', 'the company default, 24 hours');
  let budget = await engBudget(w);
  assert.deepEqual([budget.committedCents, budget.awaitingCents], [0, swapped.totalCents], 'pending: counted as awaiting, nothing held');

  // Dana's inbox, the live price check, and her approval.
  assert.equal(await svc.inboxCount(dana.actor), 1);
  const inbox = await svc.inbox(dana.actor, { tab: 'waiting' });
  assert.deepEqual(inbox.rows.map(r => r.request ? r.request.id : r.id), [draft.id]);
  const seen = await svc.getRequest(dana.actor, draft.id);
  assert.equal(seen.can.decide, true);
  assert.equal(seen.live.status, 'same', 'the demo price is unchanged');
  await rejectsWith(svc.decide(sam.actor, draft.id, { action: 'approve', rev: sent.request.rev }), 403, 'forbidden');
  const decided = await svc.decide(dana.actor, draft.id, { action: 'approve', note: '', rev: sent.request.rev });
  assert.equal(decided.outcome, 'approved');
  assert.deepEqual([decided.request.status, decided.request.approval.decidedAs, decided.request.approval.decidedBy.userId], ['approved', 'assigned', dana.user.id]);
  assert.deepEqual(decided.request.evaluation, sent.request.evaluation, 'the approval keeps the verdict it was submitted with');
  assert.deepEqual(decided.request.budget, { budgetId: `${w.acme.org.id}.${w.eng.id}.2026-Q4`, periodKey: '2026-Q4', cents: swapped.totalCents });
  budget = await engBudget(w);
  assert.deepEqual([budget.committedCents, budget.awaitingCents, budget.remainingCents], [swapped.totalCents, 0, 2000000 - swapped.totalCents]);
  assert.equal(await svc.inboxCount(dana.actor), 0);
  const done = await svc.inbox(dana.actor, { tab: 'decided' });
  assert.deepEqual(done.rows.map(r => r.request ? r.request.id : r.id), [draft.id]);
  // Reports count the real switch: the swap's own saving, on an approved request.
  const dash = await svc.dashboard(w.owner.actor, { periodKey: '2026-Q4', view: 'reports' });
  assert.equal(dash.reports.savedBySwitchingCents, pick.savesCents);
  assert.deepEqual([dash.reports.byStatus.approved, dash.reports.outOfPolicyShare.submitted], [1, 1]);
  assert.deepEqual(dash.reports.topReasons.map(r => [r.rule, r.count]), [['flight.cabin', 1]]);
});

test('(c) a blocked airline: its rows are blocked and cannot be picked, and a submit on one is refused', async () => {
  const w = await world();
  const { svc, sam, owner } = w;
  const view = await svc.getPolicy(owner.actor, 'standard');
  const saved = await svc.savePolicy(owner.actor, 'standard', { form: { ...view.form, blockedCarriers: ['ZS'] }, rev: view.rev, note: 'Sahara Wings is not used' });
  assert.deepEqual(saved.policy.rules.flights.blockedCarriers, ['ZS']);
  assert.equal(saved.policy.version, 2);

  const sv = await svc.searchTrip(sam.actor, Q);
  assert.equal(sv.policy.version, 2);
  assert.deepEqual(sv.blockedCarrierNames, ['Sahara Wings']);
  for (const leg of ['out', 'back']) {
    const rows = rowsOf(sv, leg);
    const zs = rows.filter(r => r.row.carrier.code === 'ZS' && r.row.available);
    assert.ok(zs.length, `${leg}: Sahara Wings flies this route in the demo data`);
    for (const r of zs) {
      assert.equal(r.evaluation.status, 'blocked');
      assert.ok(r.evaluation.violations.some(v => v.rule === 'flight.carrier' && v.severity === 'block'));
    }
    const firstBlocked = rows.findIndex(r => r.evaluation.status === 'blocked');
    assert.ok(rows.slice(firstBlocked).every(r => r.evaluation.status === 'blocked'), `${leg}: blocked rows come last`);
    // The results card offers no radio to pick a blocked row.
    for (const r of zs) {
      const card = String(parts.rowCard([r], { timeZone: TZ, input: { name: leg } }));
      assert.match(card, new RegExp(`value="${r.row.key.replace(/[|.]/g, '\\$&')}" disabled`), r.row.key);
      assert.match(card, /Blocked by policy/);
    }
  }
  // A crafted draft on a blocked row is held as blocked, and submitting it is refused with nothing written.
  const zsOut = keyWhere(sv, 'out', r => r.row.available && r.row.carrier.code === 'ZS');
  const back = keyWhere(sv, 'back', r => r.row.available && r.evaluation.status === 'within');
  const draft = await svc.createRequest(sam.actor, { query: { ...Q, hotel: '' }, selection: { out: zsOut, back }, purpose: 'Site visit' });
  assert.equal(draft.evaluation.status, 'blocked');
  for (const a of draft.alternatives) assert.notEqual(a.evaluation.status, 'blocked', 'a blocked option is never offered');
  await rejectsWith(svc.submit(sam.actor, draft.id, { rev: draft.rev, reason: REASON }), 422, 'policy_blocked');
  const after = await svc.getRequest(sam.actor, draft.id);
  assert.deepEqual([after.request.status, after.request.rev, after.request.approval], ['draft', draft.rev, null]);
  assert.equal(await svc.inboxCount(w.dana.actor), 0);
});

test('(d) deny and cancel release what the budget counted: awaiting on deny, the hold on cancel (traveler and override)', async () => {
  const w = await world();
  const { svc, sam, dana, tom } = w;
  // Cancel by the traveler releases an approval by policy.
  const a = await withinTrip(w);
  const auto = await svc.submit(sam.actor, a.id, { rev: a.rev });
  assert.equal((await engBudget(w)).committedCents, a.totalCents);
  const cancelled = await svc.cancel(sam.actor, a.id, { rev: auto.request.rev });
  assert.equal(cancelled.status, 'cancelled');
  let budget = await engBudget(w);
  assert.deepEqual([budget.committedCents, budget.awaitingCents, budget.remainingCents], [0, 0, 2000000]);
  await rejectsWith(svc.cancel(sam.actor, a.id, { rev: cancelled.rev }), 409, 'invalid_transition');
  assert.equal((await engBudget(w)).committedCents, 0, 'released once');

  // Deny: a note is needed, and the pending total stops counting as awaiting.
  const b = await businessTrip(w, 'Partner summit in London');
  const pending = (await svc.submit(sam.actor, b.id, { rev: b.rev, reason: REASON })).request;
  assert.equal((await engBudget(w)).awaitingCents, b.totalCents);
  await rejectsWith(svc.decide(dana.actor, b.id, { action: 'deny', note: 'No.', rev: pending.rev }), 422, 'note_required');
  const denied = await svc.decide(dana.actor, b.id, { action: 'deny', note: 'Please fly Economy for this one.', rev: pending.rev });
  assert.deepEqual([denied.outcome, denied.request.status, denied.request.budget], ['denied', 'denied', null]);
  budget = await engBudget(w);
  assert.deepEqual([budget.committedCents, budget.awaitingCents], [0, 0]);

  // An approved exception, cancelled by the Travel Admin (approval.override), releases its hold.
  const c = await businessTrip(w, 'Customer visit in London');
  const sent = (await svc.submit(sam.actor, c.id, { rev: c.rev, reason: REASON })).request;
  const approved = (await svc.decide(dana.actor, c.id, { action: 'approve', rev: sent.rev })).request;
  assert.equal((await engBudget(w)).committedCents, c.totalCents);
  const byAdmin = await svc.cancel(tom.actor, c.id, { rev: approved.rev });
  assert.equal(byAdmin.status, 'cancelled');
  budget = await engBudget(w);
  assert.deepEqual([budget.committedCents, budget.awaitingCents, budget.remainingCents], [0, 0, 2000000]);
  const stored = await svc.repo.getIn(KINDS.budget, `${w.acme.org.id}.${w.eng.id}.2026-Q4`, w.acme.org.id);
  assert.deepEqual(stored.commits, {}, 'no hold left on the budget record');
});

test('(e) a second company cannot see or touch any of it', async () => {
  const w = await world();
  const { svc, sam, dana } = w;
  const a = await withinTrip(w);
  await svc.submit(sam.actor, a.id, { rev: a.rev });
  const b = await businessTrip(w);
  const pending = (await svc.submit(sam.actor, b.id, { rev: b.rev, reason: REASON })).request;

  const globex = await w.company('Globex Ltd', 'Gina Globex', 'globex.example');
  const gina = globex.owner;
  const gEng = await svc.saveDepartment(gina.actor, { name: 'Engineering' });
  await svc.setBudget(gina.actor, gEng.id, '2026-Q4', null, '5000');
  const acmeIds = [w.acme.org.id, w.eng.id, a.id, b.id, sam.user.id, dana.user.id];
  const snapshot = () => JSON.stringify([...w.app.store.records.entries()].filter(([k]) => k.includes(w.acme.org.id) || acmeIds.some(x => k.includes(x))).sort());
  const before = snapshot();

  // Gina's own company views hold nothing of Acme's.
  const leaks = value => { const s = JSON.stringify(value); for (const x of [...acmeIds, 'Acme Inc', 'Sam Rivera', 'Dana Lee']) assert.ok(!s.includes(x), `leaked ${x}`); };
  leaks(await svc.listRequests(gina.actor, { scope: 'all' }));
  leaks(await svc.inbox(gina.actor, { tab: 'company' }));
  leaks(await svc.listBudgets(gina.actor, '2026-Q4'));
  leaks(await svc.listMembers(gina.actor));
  leaks(await svc.listDepartments(gina.actor));
  leaks(await svc.dashboard(gina.actor, { periodKey: '2026-Q4', view: 'reports' }));
  leaks(await svc.exportCsv(gina.actor, {}));
  leaks(await svc.exportCompany(gina.actor));
  leaks(await svc.listAudit(gina.actor, {}));
  assert.deepEqual((await svc.listCompaniesFor({ user: gina.user })).map(c => c.id), [globex.org.id]);

  // Every request method on Acme's requests answers 404, from Globex or with Acme's id in a Globex user's actor.
  const foreign = [gina.actor, { org: { id: w.acme.org.id }, user: gina.user }];
  for (const actor of foreign) {
    for (const rid of [a.id, b.id]) {
      await rejectsWith(svc.getRequest(actor, rid), 404, 'not_found');
      await rejectsWith(svc.liveCheck(actor, rid), 404, 'not_found');
      await rejectsWith(svc.decide(actor, rid, { action: 'approve', note: 'Approving for my friend at Acme.', rev: pending.rev }), 404, 'not_found');
      await rejectsWith(svc.cancel(actor, rid, { rev: pending.rev }), 404, 'not_found');
      await rejectsWith(svc.message(actor, rid, { text: 'Hello from Globex' }), 404, 'not_found');
      await rejectsWith(svc.submit(actor, rid, { rev: 0, reason: REASON }), 404, 'not_found');
      await rejectsWith(svc.swap(actor, rid, { altId: (b.alternatives[0] || {}).id || 'x', rev: 0 }), 404, 'not_found');
    }
  }
  await rejectsWith(svc.setBudget(gina.actor, w.eng.id, '2026-Q4', null, '1'), 404, 'not_found');
  await rejectsWith(svc.listBudgets({ org: { id: w.acme.org.id }, user: gina.user }, '2026-Q4'), 404, 'not_found');
  await rejectsWith(svc.getOrg({ org: { id: w.acme.org.id }, user: gina.user }), 404, 'not_found');
  // And Acme's people cannot reach into Globex either.
  await rejectsWith(svc.getOrg({ org: { id: globex.org.id }, user: sam.user }), 404, 'not_found');
  await rejectsWith(svc.searchTrip({ org: { id: globex.org.id }, user: sam.user }, Q), 404, 'not_found');

  assert.equal(snapshot(), before, 'nothing of Acme\'s changed');
  const still = await svc.getRequest(dana.actor, b.id);
  assert.deepEqual([still.status, still.request.messages.length], ['pending', 0]);
});

test('a re-check that finds only the terms changed (same total) says so: returned.why terms_changed and an audit line that names no price change', async t => {
  const w = await world();
  const { svc, sam } = w;
  const draft = await withinTrip(w);
  const hotels = svc.inventory.hotels;
  const real = hotels.quote;
  // The supplier turns the room non-refundable at the same price.
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, cancellation: { ...q.cancellation, type: 'non_refundable', freeUntilHours: 0, summary: 'Non-refundable.' } };
  };
  t.after(() => { hotels.quote = real; });
  const result = await svc.submit(sam.actor, draft.id, { rev: draft.rev });
  assert.equal(result.outcome, 'repriced');
  assert.equal(result.request.totalCents, draft.totalCents, 'the same total');
  assert.deepEqual(result.request.returned, { at: FIXED_NOW, why: 'terms_changed', fromCents: draft.totalCents, toCents: draft.totalCents });
  assert.equal(result.request.rows.hotel.cancellation.text, 'Non-refundable.');
  const audit = (await svc.listAudit(w.owner.actor, {})).rows.find(e => e.action === 'request.repriced');
  assert.equal(audit.summary, "The terms of Sam Rivera's trip to London changed before it was sent, so the trip was updated");
  assert.doesNotMatch(audit.summary, /price/i);
});

test('types.js documents the Stage 1 contract changes the pages rely on', () => {
  const types = fs.readFileSync(path.join(__dirname, '..', 'server', 'business', 'types.js'), 'utf8');
  // TripComparison lists the rows in diff.DIFF_FIELDS order, 'changes' and 'hotelRefunds' included.
  const order = types.match(/diff\.DIFF_FIELDS: ([a-zA-Z, \n*]+?)\), one row/);
  assert.ok(order, 'the TripComparison order text');
  assert.deepEqual(order[1].replace(/\s*\*\s*/g, ' ').split(',').map(s => s.trim()), [...DIFF_FIELDS]);
  // InviteLanding: signed out is always 'join'.
  assert.match(types, /@property \{'join'\|'accept'\|'other_email'\|'member'\|'pending_company'\} state/);
  // Org.settingsRev, and RequestReturned's terms_changed.
  assert.match(types, /@property \{number\} \[settingsRev\]/);
  assert.match(types, /why: 'price_changed'\|'terms_changed'\|'unavailable'/);
});
