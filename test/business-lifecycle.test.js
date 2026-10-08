// The request state machine (plan §C5, Stage 1P): every status × event, legal and illegal; expiry exactly at
// expiresAt; effectiveStatus; expiresAt's min rule; automatic events never override a human; the error table;
// and inputs never mutated.
const test = require('node:test');
const assert = require('node:assert/strict');
const lc = require('../server/business/lifecycle');
const { createPolicyEngine } = require('../server/business/policy');
const { AppError } = require('../server/lib/errors');
const { CARD_MESSAGE } = require('../server/business/cards');

const { transition, effectiveStatus, expiresAt, EVENTS, TERMINAL } = lc;
const NOW = '2026-10-09T09:00:00.000Z';
const STATUSES = ['draft', 'pending', 'approved', 'denied', 'cancelled', 'expired'];
const ORG = Object.freeze({ id: 'org_acme', name: 'Acme Inc', timezone: 'Africa/Cairo', settings: Object.freeze({ outOfPolicy: 'approval', approvalHours: 48, reasonMinChars: 20, budgetPeriod: 'quarter' }) });
const REASON = 'Client workshop on Thursday morning in London.';
const CARD = 'Use my card 4111 1111 1111 1111 for this.';

function member(userId, role, o = {}) {
  return { orgId: ORG.id, userId, email: `${userId}@example.test`, name: userId.slice(2), role, status: 'active', departmentId: 'dep_eng', managerId: null, approverId: null, tier: 'standard', at: '2026-01-01T00:00:00.000Z', by: null, removedAt: null, rev: 1, ...o };
}
const M = {
  traveler: member('u_t', 'employee', { managerId: 'u_lead' }),
  lead: member('u_lead', 'manager'),
  boss: member('u_boss', 'manager'),
  admin: member('u_admin', 'travel_admin'),
  owner: member('u_owner', 'owner'),
  fin: member('u_fin', 'finance'),
  emp: member('u_emp', 'employee'),
};
const ref = m => ({ userId: m.userId, name: m.name, role: m.role });

const ALT = Object.freeze({ id: 'a1b2c3d4e5f60718', kind: 'fare', label: 'Same flight, Classic fare', totalCents: 240000 });
function request(status = 'draft', o = {}) {
  const base = {
    id: 'btr_1', orgId: ORG.id, travelerId: 'u_t', travelerName: 't', travelerManagerId: 'u_lead', departmentId: 'dep_eng', tier: 'standard',
    status, rev: 3, at: '2026-10-08T09:00:00.000Z', updatedAt: '2026-10-08T09:00:00.000Z', purpose: 'Client workshop',
    query: { from: 'CAI', to: 'LHR', departDate: '2026-11-12', returnDate: '2026-11-16', cabin: 'economy', passengers: 1, datesFlexible: false, hotel: null },
    selection: { out: 'f.flt_x|FLEX', back: 'f.flt_y|FLEX', hotel: null }, rows: { out: { totalCents: 150000 }, back: { totalCents: 102000 }, hotel: null },
    pricedAt: '2026-10-08T09:00:00.000Z', currency: 'USD', totalCents: 252000, originalTotalCents: 252000,
    evaluation: { status: 'out', components: {}, violations: [{ rule: 'flight.cap' }], totalCents: 252000, policy: { tier: 'standard', version: 3 }, evaluatedAt: '2026-10-08T09:00:00.000Z' },
    alternatives: [structuredClone(ALT)], alternativesTruncated: false, cheapestWithin: null, explanation: null,
    reason: null, approval: null, submittedAt: null, expiresAt: null, budget: null, returned: null, messages: [], history: [], booking: { status: 'not_open' }, demo: true,
  };
  if (status === 'pending') {
    Object.assign(base, {
      reason: { text: REASON, category: 'client_meeting' }, submittedAt: '2026-10-08T09:00:00.000Z', expiresAt: '2026-10-10T09:00:00.000Z',
      approval: { mode: 'manual', approverId: 'u_lead', pool: false, poolIds: [], rule: 'manager', decidedBy: null, decidedAt: null, decidedAs: null, note: '', overBudgetAck: false },
    });
  }
  if (['approved', 'denied'].includes(status)) {
    Object.assign(base, {
      reason: { text: REASON, category: null }, submittedAt: '2026-10-08T09:00:00.000Z', expiresAt: '2026-10-10T09:00:00.000Z',
      approval: { mode: 'manual', approverId: 'u_lead', pool: false, poolIds: [], rule: 'manager', decidedBy: ref(M.lead), decidedAt: '2026-10-08T10:00:00.000Z', decidedAs: 'assigned', note: status === 'denied' ? 'Please pick the Classic fare.' : '', overBudgetAck: false },
    });
  }
  return { ...base, ...o };
}
const SAME = Object.freeze({ status: 'same', components: {}, newTotalCents: 252000, at: NOW });
const CHANGED = Object.freeze({ status: 'changed', components: {}, newTotalCents: 260000, at: NOW });
const GONE = Object.freeze({ status: 'unavailable', components: {}, newTotalCents: null, at: NOW });
const WITHIN = Object.freeze({ status: 'within', components: {}, violations: [], totalCents: 252000, policy: { tier: 'standard', version: 3 } });
const OUT = Object.freeze({ status: 'out', components: {}, violations: [{ rule: 'flight.cap' }], totalCents: 252000, policy: { tier: 'standard', version: 3 } });
const BLOCKED = Object.freeze({ ...OUT, status: 'blocked' });
const DRAFT = Object.freeze({ selection: { out: 'f.flt_z|CLASSIC', back: 'f.flt_y|FLEX', hotel: null }, rows: { out: { totalCents: 138000 }, back: { totalCents: 102000 }, hotel: null }, totalCents: 240000, pricedAt: NOW, evaluation: WITHIN });
const MANAGER = Object.freeze({ approverId: 'u_lead', pool: false, poolIds: [], rule: 'manager', skipped: [] });
const BUDGET = Object.freeze({ budgetId: 'bud_1', departmentId: 'dep_eng', departmentName: 'Engineering', periodKey: '2026-Q4', periodLabel: 'Q4 2026', amountCents: 1000000, committedCents: 0, remainingCents: 1000000, rev: 1 });

const as = (m, extra = {}) => ({ now: NOW, actor: ref(m), member: m, org: ORG, ...extra });
/** The legal event for each status, from the right person (used by the matrix). */
const LEGAL = {
  swap: [{ type: 'swap', alternative: ALT, draft: DRAFT }, as(M.traveler)],
  submit: [{ type: 'submit', reason: { text: REASON, category: 'client_meeting' }, approver: MANAGER, budget: null, draft: null }, as(M.traveler, { recheck: SAME, evaluation: OUT })],
  cancel: [{ type: 'cancel' }, as(M.traveler)],
  approve: [{ type: 'approve', note: '', ackOverBudget: false, budget: null, draft: null }, as(M.lead, { recheck: SAME })],
  deny: [{ type: 'deny', note: 'Please pick the Classic fare.' }, as(M.lead)],
  expire: [{ type: 'expire' }, { now: '2026-10-10T09:00:00.000Z', actor: { system: 'clock' }, member: null, org: ORG }],
  message: [{ type: 'message', text: 'Is the Classic fare fine?' }, as(M.traveler)],
};
const ALLOWED = {
  draft: ['swap', 'submit', 'cancel', 'message'],
  pending: ['cancel', 'approve', 'deny', 'message', 'expire'],
  approved: ['cancel', 'message'],
  denied: [], cancelled: [], expired: [],
};
const OUTCOME = { swap: 'swapped', submit: 'submitted', cancel: 'cancelled', approve: 'approved', deny: 'denied', expire: 'expired', message: 'message' };
const TO = { swap: 'draft', submit: 'pending', cancel: 'cancelled', approve: 'approved', deny: 'denied', expire: 'expired' };

/** The [code, status] an AppError carries, or a failure. */
function refusal(fn) {
  try { fn(); } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return [e.code, e.status];
  }
  return assert.fail('expected an AppError');
}
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); }
  return v;
}

// ---------------------------------------------------------------------------------------------------------

test('every status × event: the legal ones move as the table says, every other one is 409 invalid_transition', () => {
  assert.deepEqual([...EVENTS], ['swap', 'submit', 'cancel', 'approve', 'deny', 'expire', 'message']);
  assert.deepEqual([...TERMINAL], ['denied', 'cancelled', 'expired']);
  for (const status of STATUSES) {
    for (const type of EVENTS) {
      const [event, opts] = LEGAL[type];
      const req = deepFreeze(request(status));
      const label = `${status} + ${type}`;
      if (ALLOWED[status].includes(type)) {
        const res = transition(req, event, opts);
        assert.equal(res.outcome, OUTCOME[type], label);
        assert.equal(res.next.updatedAt, opts.now, label);
        if (type === 'message') {
          assert.equal(res.history, null, label);
          assert.equal(res.next.status, undefined, 'a message never changes the status');
        } else {
          assert.equal(res.next.status ?? req.status, TO[type], label);
          assert.deepEqual([res.history.at, res.history.action, res.history.from, res.history.to], [opts.now, OUTCOME[type], status, TO[type]], label);
        }
      } else {
        assert.deepEqual(refusal(() => transition(req, event, opts)), ['invalid_transition', 409], label);
      }
    }
  }
  assert.throws(() => transition(request(), { type: 'book' }, as(M.traveler)), TypeError);
  assert.throws(() => transition(request(), { type: 'cancel' }, { actor: ref(M.traveler) }), /opts.now/);
  assert.throws(() => transition(null, { type: 'cancel' }, as(M.traveler)), TypeError);
});

test('expiry is exact: at expiresAt the request is expired for every event; a millisecond before it is not', () => {
  const req = deepFreeze(request('pending'));
  const at = req.expiresAt;
  const before = new Date(Date.parse(at) - 1).toISOString();
  // At expiresAt: expire works (by the clock), everything else is request_expired.
  const res = transition(req, { type: 'expire' }, { now: at, actor: { system: 'clock' }, member: null, org: ORG });
  assert.deepEqual(res, {
    next: { status: 'expired', updatedAt: at },
    history: { at, by: { system: 'clock' }, action: 'expired', from: 'pending', to: 'expired', note: '' },
    outcome: 'expired',
  });
  for (const type of ['cancel', 'approve', 'deny', 'message']) {
    const [event, opts] = LEGAL[type];
    assert.deepEqual(refusal(() => transition(req, event, { ...opts, now: at })), ['request_expired', 409], type);
  }
  // A millisecond before: expire is not legal yet; approve goes through.
  assert.deepEqual(refusal(() => transition(req, { type: 'expire' }, { now: before, actor: { system: 'clock' }, member: null, org: ORG })), ['invalid_transition', 409]);
  assert.equal(transition(req, LEGAL.approve[0], { ...LEGAL.approve[1], now: before }).outcome, 'approved');
  assert.equal(effectiveStatus(req, before, 'Africa/Cairo'), 'pending');
  assert.equal(effectiveStatus(req, at, 'Africa/Cairo'), 'expired');
  assert.equal(effectiveStatus(req, '2027-01-01T00:00:00.000Z'), 'expired');
  // The stored status 'pending' with no expiresAt never expires by itself.
  assert.equal(effectiveStatus(request('pending', { expiresAt: null }), '2027-01-01T00:00:00.000Z'), 'pending');
});

test('automatic events never override a human decision', () => {
  for (const status of ['approved', 'denied', 'cancelled']) {
    const req = request(status, { expiresAt: '2026-10-09T08:00:00.000Z' }); // long past
    assert.deepEqual(refusal(() => transition(req, { type: 'expire' }, { now: NOW, actor: { system: 'clock' }, member: null, org: ORG })), ['invalid_transition', 409], status);
    assert.equal(effectiveStatus(req, NOW, 'Africa/Cairo'), status, `${status} reads as ${status}, never expired`);
  }
  // A price change returns a pending request to draft before a human decides, but never an approved one.
  const approved = request('approved');
  assert.deepEqual(refusal(() => transition(approved, LEGAL.approve[0], as(M.lead, { recheck: CHANGED }))), ['invalid_transition', 409]);
  const draft = transition(request('draft'), LEGAL.submit[0], as(M.traveler, { recheck: SAME, evaluation: WITHIN }));
  assert.equal(draft.next.approval.mode, 'auto', 'the policy approves only what is within policy and budget, at submit');
});

test('effectiveStatus: past the day after departure in the company time zone; expiresAt is the earlier of hours and departure midnight', () => {
  const approved = request('approved');
  // Departure 2026-11-12. On the day itself: still approved. After midnight in Cairo: past.
  assert.equal(effectiveStatus(approved, '2026-11-12T21:00:00.000Z', 'Africa/Cairo'), 'approved', '23:00 in Cairo on the 12th');
  assert.equal(effectiveStatus(approved, '2026-11-12T22:30:00.000Z', 'Africa/Cairo'), 'past', '00:30 in Cairo on the 13th');
  assert.equal(effectiveStatus(approved, '2026-11-12T22:30:00.000Z', 'UTC'), 'approved', 'still the 12th in UTC');
  assert.equal(effectiveStatus(approved, '2026-11-12T22:30:00.000Z'), 'approved', 'UTC by default');
  for (const status of ['draft', 'denied', 'cancelled', 'expired']) assert.equal(effectiveStatus(request(status), '2027-06-01T00:00:00.000Z', 'Africa/Cairo'), status);
  assert.throws(() => effectiveStatus(approved, 'soon'), TypeError);
  // expiresAt: submittedAt + hours, unless the departure date's local midnight comes first.
  assert.equal(expiresAt(NOW, 48, '2026-11-12', 'Africa/Cairo'), '2026-10-11T09:00:00.000Z');
  assert.equal(expiresAt(NOW, 24, '2026-10-10', 'Africa/Cairo'), '2026-10-09T21:00:00.000Z', 'midnight in Cairo (UTC+3 in October)');
  assert.equal(expiresAt(NOW, 4, '2026-10-10', 'Africa/Cairo'), '2026-10-09T13:00:00.000Z', '4 hours is sooner');
  assert.equal(expiresAt(NOW, 168, '2026-10-12', 'Europe/London'), '2026-10-11T23:00:00.000Z', 'midnight in London (BST)');
  assert.equal(expiresAt(NOW, 24, '2026-10-09', 'Africa/Cairo'), '2026-10-08T21:00:00.000Z', 'already past: the caller refuses it');
  for (const bad of [0, -1, 1.5, NaN, '24', null]) assert.throws(() => expiresAt(NOW, bad, '2026-11-12', 'Africa/Cairo'), TypeError, String(bad));
  assert.throws(() => expiresAt('now', 24, '2026-11-12', 'Africa/Cairo'), TypeError);
  assert.equal(createPolicyEngine().expiresAt(NOW, 48, '2026-11-12', 'Africa/Cairo'), '2026-10-11T09:00:00.000Z');
});

test('swap: the traveler, a listed alternative, the new draft; savedCents and the label in history', () => {
  const req = deepFreeze(request('draft'));
  const res = transition(req, { type: 'swap', alternative: ALT, draft: DRAFT }, as(M.traveler));
  assert.deepEqual(res.next, { ...structuredClone(DRAFT), updatedAt: NOW });
  assert.equal(res.next.originalTotalCents, undefined, 'originalTotalCents is never rewritten');
  assert.deepEqual(res.history, { at: NOW, by: ref(M.traveler), action: 'swapped', from: 'draft', to: 'draft', note: 'Same flight, Classic fare', savedCents: 12000 });
  assert.deepEqual(refusal(() => transition(req, { type: 'swap', alternative: { ...ALT, id: 'ffffffffffffffff' }, draft: DRAFT }, as(M.traveler))), ['alternative_gone', 410]);
  assert.deepEqual(refusal(() => transition(request('draft', { alternatives: [] }), { type: 'swap', alternative: ALT, draft: DRAFT }, as(M.traveler))), ['alternative_gone', 410]);
  assert.deepEqual(refusal(() => transition(req, { type: 'swap', alternative: ALT, draft: DRAFT }, as(M.lead))), ['not_found', 404]);
  assert.throws(() => transition(req, { type: 'swap', alternative: ALT }, as(M.traveler)), /draft/);
});

test('submit: auto approval inside policy and budget; pending outside it, with reason, approver and expiry', () => {
  const req = deepFreeze(request('draft', { returned: { at: NOW, why: 'price_changed', fromCents: 1, toCents: 2 } }));
  const auto = transition(req, { type: 'submit', reason: { text: 'ignored', category: 'other' }, approver: null, budget: BUDGET, draft: null }, as(M.traveler, { recheck: SAME, evaluation: WITHIN }));
  assert.deepEqual(auto, {
    next: {
      status: 'approved', evaluation: { ...WITHIN, evaluatedAt: NOW }, reason: null, returned: null, budget: { budgetId: 'bud_1', periodKey: '2026-Q4', cents: 252000 },
      submittedAt: NOW, expiresAt: null, updatedAt: NOW,
      approval: { mode: 'auto', approverId: null, pool: false, poolIds: [], rule: null, decidedBy: { system: 'policy' }, decidedAt: NOW, decidedAs: null, note: '', overBudgetAck: false },
    },
    history: { at: NOW, by: { system: 'policy' }, action: 'auto_approved', from: 'draft', to: 'approved', note: '' },
    outcome: 'auto_approved',
  });
  // Within policy, but the budget has less left than the trip: it needs approval (and so a reason).
  const tight = { ...BUDGET, remainingCents: 251999 };
  assert.deepEqual(refusal(() => transition(req, { type: 'submit', reason: null, approver: MANAGER, budget: tight, draft: null }, as(M.traveler, { recheck: SAME, evaluation: WITHIN }))), ['reason_too_short', 422]);
  const exact = transition(req, { type: 'submit', reason: null, approver: null, budget: { ...BUDGET, remainingCents: 252000 }, draft: null }, as(M.traveler, { recheck: SAME, evaluation: WITHIN }));
  assert.equal(exact.outcome, 'auto_approved', 'exactly what is left still fits');
  const pending = transition(req, { type: 'submit', reason: { text: `  ${REASON}  `, category: 'client_meeting' }, approver: MANAGER, budget: tight, draft: null }, as(M.traveler, { recheck: SAME, evaluation: WITHIN }));
  assert.deepEqual(pending.next, {
    status: 'pending', evaluation: { ...WITHIN, evaluatedAt: NOW }, reason: { text: REASON, category: 'client_meeting' }, returned: null,
    submittedAt: NOW, expiresAt: '2026-10-11T09:00:00.000Z', updatedAt: NOW,
    approval: { mode: 'manual', approverId: 'u_lead', pool: false, poolIds: [], rule: 'manager', decidedBy: null, decidedAt: null, decidedAs: null, note: '', overBudgetAck: false },
  });
  assert.deepEqual(pending.history, { at: NOW, by: ref(M.traveler), action: 'submitted', from: 'draft', to: 'pending', note: '' });
  const submit = (reason, approver = MANAGER, extra = {}) => transition(req, { type: 'submit', reason, approver, budget: null, draft: null }, as(M.traveler, { recheck: SAME, evaluation: OUT, ...extra }));
  // The reason: reasonMinChars to 500 characters, measured after cleaning; no card number; unknown categories stored as null.
  assert.deepEqual(refusal(() => submit({ text: 'x'.repeat(19), category: 'other' })), ['reason_too_short', 422]);
  assert.equal(submit({ text: 'x'.repeat(20), category: 'other' }).next.reason.text.length, 20);
  assert.equal(submit({ text: 'x'.repeat(500), category: 'other' }).next.reason.text.length, 500);
  assert.deepEqual(refusal(() => submit({ text: 'x'.repeat(501), category: 'other' })), ['reason_too_short', 422]);
  assert.deepEqual(refusal(() => submit({ text: `${'​'.repeat(10)}${'x'.repeat(19)}`, category: 'other' })), ['reason_too_short', 422], 'invisible characters do not count');
  assert.deepEqual(refusal(() => submit(null)), ['reason_too_short', 422]);
  assert.deepEqual(refusal(() => submit({ text: CARD, category: 'other' })), ['card_number', 422]);
  assert.equal(submit({ text: REASON, category: 'bribe' }).next.reason.category, null);
  // The approver: a pool keeps its ids (never the traveler's); nobody, or only the traveler, is no_approver.
  const pool = submit({ text: REASON }, { approverId: null, pool: true, poolIds: ['u_owner', 'u_t', 'u_admin'], rule: 'admin', skipped: [] });
  assert.deepEqual([pool.next.approval.approverId, pool.next.approval.pool, pool.next.approval.poolIds, pool.next.approval.rule], [null, true, ['u_owner', 'u_admin'], 'admin']);
  for (const ap of [null, { approverId: null, pool: false, poolIds: [], rule: null, skipped: [] }, { ...MANAGER, approverId: 'u_t' }, { approverId: null, pool: true, poolIds: ['u_t'], rule: 'admin', skipped: [] }]) {
    assert.deepEqual(refusal(() => submit({ text: REASON }, ap)), ['no_approver', 422], JSON.stringify(ap));
  }
  // Leaving today (the departure date's midnight has passed in Cairo): too late to wait.
  assert.deepEqual(refusal(() => transition(request('draft', { query: { ...req.query, departDate: '2026-10-09' } }), { type: 'submit', reason: { text: REASON }, approver: MANAGER, budget: null, draft: null }, as(M.traveler, { recheck: SAME, evaluation: OUT }))), ['too_late', 422]);
  assert.equal(transition(request('draft', { query: { ...req.query, departDate: '2026-10-10' } }), { type: 'submit', reason: { text: REASON }, approver: MANAGER, budget: null, draft: null }, as(M.traveler, { recheck: SAME, evaluation: OUT })).next.expiresAt, '2026-10-09T21:00:00.000Z');
  // Blocked, re-priced, the wrong person, missing inputs.
  assert.deepEqual(refusal(() => submit({ text: REASON }, MANAGER, { evaluation: BLOCKED })), ['policy_blocked', 422]);
  const repriced = transition(req, { type: 'submit', reason: { text: REASON }, approver: MANAGER, budget: null, draft: DRAFT }, as(M.traveler, { recheck: CHANGED, evaluation: OUT }));
  assert.deepEqual([repriced.outcome, repriced.next, repriced.history.action, repriced.history.to], ['repriced', { ...structuredClone(DRAFT), updatedAt: NOW }, 'repriced', 'draft']);
  assert.equal(transition(req, { type: 'submit', reason: null, approver: null, budget: null, draft: DRAFT }, as(M.traveler, { recheck: GONE })).outcome, 'repriced');
  assert.throws(() => transition(req, { type: 'submit', reason: null, approver: null, budget: null, draft: null }, as(M.traveler, { recheck: CHANGED })), /draft/);
  assert.deepEqual(refusal(() => transition(req, LEGAL.submit[0], { ...LEGAL.submit[1], actor: ref(M.lead), member: M.lead })), ['not_found', 404]);
  assert.throws(() => transition(req, LEGAL.submit[0], as(M.traveler, { evaluation: OUT })), /recheck/);
  assert.throws(() => transition(req, LEGAL.submit[0], as(M.traveler, { recheck: SAME })), /evaluation/);
});

test('cancel: draft and pending by the traveler; approved before departure, or by an override holder', () => {
  for (const status of ['draft', 'pending']) {
    const res = transition(request(status), { type: 'cancel' }, as(M.traveler));
    assert.deepEqual(res, { next: { status: 'cancelled', updatedAt: NOW }, history: { at: NOW, by: ref(M.traveler), action: 'cancelled', from: status, to: 'cancelled', note: '' }, outcome: 'cancelled' });
    assert.deepEqual(refusal(() => transition(request(status), { type: 'cancel' }, as(M.admin))), ['not_found', 404], `${status}: only the traveler`);
  }
  const approved = request('approved', { budget: { budgetId: 'bud_1', periodKey: '2026-Q4', cents: 252000 } });
  const cancelled = transition(approved, { type: 'cancel' }, as(M.traveler));
  assert.equal(cancelled.next.budget, undefined, 'the hold is left as it was (the budget record releases it)');
  // The departure day in Cairo: 2026-11-11 22:30 UTC is 00:30 on the 12th there.
  const onTheDay = '2026-11-11T22:30:00.000Z';
  assert.deepEqual(refusal(() => transition(approved, { type: 'cancel' }, as(M.traveler, { now: onTheDay }))), ['departed', 409]);
  assert.equal(transition(approved, { type: 'cancel' }, as(M.traveler, { now: '2026-11-11T21:30:00.000Z' })).outcome, 'cancelled', '23:30 on the 11th');
  assert.equal(transition(approved, { type: 'cancel' }, as(M.admin, { now: onTheDay })).outcome, 'cancelled', 'a travel admin may');
  assert.equal(transition(approved, { type: 'cancel' }, as(M.owner, { now: onTheDay })).outcome, 'cancelled');
  for (const m of [M.lead, M.fin, M.emp, { ...M.admin, status: 'removed' }]) assert.deepEqual(refusal(() => transition(approved, { type: 'cancel' }, as(m))), ['not_found', 404], m.userId);
  // An owner traveling cannot override their own departure.
  const ownTrip = request('approved', { travelerId: 'u_owner' });
  assert.deepEqual(refusal(() => transition(ownTrip, { type: 'cancel' }, as(M.owner, { now: onTheDay }))), ['departed', 409]);
  // The member record must be the actor's own.
  assert.deepEqual(refusal(() => transition(approved, { type: 'cancel' }, { ...as(M.lead), member: M.admin })), ['not_found', 404]);
});

test('approve and deny: who may decide, notes, the budget, and a price change returning the request', () => {
  const req = deepFreeze(request('pending'));
  const approve = (m, extra = {}, event = {}) => transition(req, { type: 'approve', note: '', ackOverBudget: false, budget: null, draft: null, ...event }, as(m, { recheck: SAME, ...extra }));
  const deny = (m, note = 'Please pick the Classic fare.', extra = {}) => transition(req, { type: 'deny', note }, as(m, extra));
  // Assigned.
  const ok = approve(M.lead);
  assert.deepEqual(ok.next.approval, { ...req.approval, decidedBy: ref(M.lead), decidedAt: NOW, decidedAs: 'assigned', note: '', overBudgetAck: false });
  assert.deepEqual([ok.next.status, ok.next.budget, ok.next.evaluation], ['approved', null, req.evaluation]);
  assert.deepEqual(ok.history, { at: NOW, by: ref(M.lead), action: 'approved', from: 'pending', to: 'approved', note: '' });
  assert.deepEqual(approve(M.lead, { evaluation: OUT }).next.evaluation, { ...OUT, evaluatedAt: NOW }, 'the fresh evaluation when given');
  // The traveler never decides, whatever their role.
  assert.deepEqual(refusal(() => approve(M.traveler)), ['self_approval', 422]);
  assert.deepEqual(refusal(() => deny(M.traveler)), ['self_approval', 422]);
  const ownersOwn = request('pending', { travelerId: 'u_owner', approval: { ...req.approval, approverId: 'u_owner' } });
  assert.deepEqual(refusal(() => transition(ownersOwn, { type: 'approve', note: 'Approving my own trip now.' }, as(M.owner, { recheck: SAME }))), ['self_approval', 422]);
  // Pool members, when the request is pooled and the link says so.
  const pooledReq = request('pending', { approval: { ...req.approval, approverId: null, pool: true, poolIds: ['u_owner', 'u_admin'], rule: 'admin' } });
  assert.equal(transition(pooledReq, LEGAL.approve[0], as(M.admin, { recheck: SAME, pooled: true })).next.approval.decidedAs, 'pool');
  assert.deepEqual(refusal(() => transition(pooledReq, LEGAL.approve[0], as(M.boss, { recheck: SAME, pooled: false }))), ['not_found', 404]);
  // Override: owners and travel admins, with a note of at least 10 characters.
  assert.deepEqual(refusal(() => approve(M.admin)), ['note_required', 422]);
  assert.deepEqual(refusal(() => approve(M.admin, {}, { note: 'Fine. Ok.' })), ['note_required', 422], '9 characters');
  assert.equal(approve(M.admin, {}, { note: 'Fine, okay' }).next.approval.decidedAs, 'override');
  assert.equal(approve(M.owner, {}, { note: 'Approved for the client visit.' }).next.approval.note, 'Approved for the client visit.');
  // Nobody else.
  for (const m of [M.boss, M.fin, M.emp, { ...M.lead, status: 'removed' }, { ...M.lead, role: 'employee' }]) {
    assert.deepEqual(refusal(() => approve(m)), ['not_found', 404], `${m.userId} ${m.role} ${m.status}`);
  }
  assert.deepEqual(refusal(() => transition(req, LEGAL.approve[0], { ...as(M.lead, { recheck: SAME }), member: M.admin })), ['not_found', 404], 'the member record is the actor\'s');
  // Notes: cleaned, card numbers refused, kept to 1,000 characters.
  assert.deepEqual(refusal(() => approve(M.lead, {}, { note: CARD })), ['card_number', 422]);
  assert.equal(approve(M.lead, {}, { note: 'y'.repeat(1500) }).next.approval.note.length, 1000);
  // Deny: a note is always required.
  assert.deepEqual(refusal(() => deny(M.lead, 'No.')), ['note_required', 422]);
  assert.deepEqual(refusal(() => deny(M.lead, `${'​'.repeat(12)}No.`)), ['note_required', 422]);
  assert.deepEqual(refusal(() => deny(M.lead, CARD)), ['card_number', 422]);
  const denied = deny(M.lead);
  assert.deepEqual(denied.next, { status: 'denied', approval: { ...req.approval, decidedBy: ref(M.lead), decidedAt: NOW, decidedAs: 'assigned', note: 'Please pick the Classic fare.' }, updatedAt: NOW });
  assert.deepEqual([denied.history.action, denied.history.note, denied.outcome], ['denied', 'Please pick the Classic fare.', 'denied']);
  assert.equal(deny(M.admin).next.approval.decidedAs, 'override');
  // The budget: over it needs ackOverBudget; the hold is the whole total.
  const over = { ...BUDGET, remainingCents: 100000 };
  assert.deepEqual(refusal(() => approve(M.lead, {}, { budget: over })), ['over_budget', 422]);
  const acked = approve(M.lead, {}, { budget: over, ackOverBudget: true });
  assert.deepEqual([acked.next.approval.overBudgetAck, acked.next.budget], [true, { budgetId: 'bud_1', periodKey: '2026-Q4', cents: 252000 }]);
  assert.equal(approve(M.lead, {}, { budget: BUDGET, ackOverBudget: true }).next.approval.overBudgetAck, false, 'not over: no ack recorded');
  // A changed or vanished price returns the request to the traveler, by the policy.
  const back = approve(M.lead, { recheck: CHANGED }, { draft: DRAFT });
  assert.deepEqual(back.next, {
    ...structuredClone(DRAFT), status: 'draft', approval: null, submittedAt: null, expiresAt: null, updatedAt: NOW,
    returned: { at: NOW, why: 'price_changed', fromCents: 252000, toCents: 260000 },
  });
  assert.deepEqual([back.history.by, back.history.action, back.history.to, back.outcome], [{ system: 'policy' }, 'returned', 'draft', 'returned']);
  const gone = approve(M.lead, { recheck: GONE });
  assert.deepEqual(gone.next.returned, { at: NOW, why: 'unavailable', fromCents: 252000, toCents: null });
  assert.throws(() => approve(M.lead, { recheck: undefined }), /recheck/);
  assert.equal(deny(M.lead, 'Please pick the Classic fare.', { recheck: undefined }).outcome, 'denied', 'deny needs no recheck');
});

test('message: the traveler, the approver, the pool or an override holder; 2 to 1,000 characters; at most 50', () => {
  const req = deepFreeze(request('pending', { messages: [{ at: '2026-10-08T10:00:00.000Z', by: 'u_t', name: 't', text: 'Hello' }] }));
  const send = (m, text, extra = {}, r = req) => transition(r, { type: 'message', text }, as(m, extra));
  const res = send(M.lead, '  Is the Classic fare fine?  ');
  assert.deepEqual(res, {
    next: { messages: [...structuredClone(req.messages), { at: NOW, by: 'u_lead', name: 'lead', text: 'Is the Classic fare fine?' }], updatedAt: NOW },
    history: null, outcome: 'message',
  });
  assert.equal(send(M.traveler, 'ok').outcome, 'message');
  assert.equal(send(M.admin, 'Checking.').outcome, 'message', 'override holders');
  const pooled = request('pending', { approval: { ...req.approval, approverId: null, pool: true, poolIds: ['u_owner', 'u_boss'], rule: 'admin' } });
  assert.equal(send(M.boss, 'Pool here.', { pooled: true }, pooled).outcome, 'message');
  for (const m of [M.boss, M.fin, M.emp]) assert.deepEqual(refusal(() => send(m, 'Hello there')), ['not_found', 404], m.userId);
  assert.deepEqual(refusal(() => transition(req, { type: 'message', text: 'Hello there' }, { ...as(M.boss), member: M.admin })), ['not_found', 404]);
  assert.deepEqual(refusal(() => send(M.traveler, 'x')), ['invalid_message', 422]);
  assert.deepEqual(refusal(() => send(M.traveler, ' ​ x ​ ')), ['invalid_message', 422]);
  assert.equal(send(M.traveler, 'x'.repeat(1000)).next.messages.at(-1).text.length, 1000);
  assert.deepEqual(refusal(() => send(M.traveler, 'x'.repeat(1001))), ['invalid_message', 422]);
  assert.deepEqual(refusal(() => send(M.traveler, CARD)), ['card_number', 422]);
  const full = request('draft', { messages: Array.from({ length: 50 }, (_, i) => ({ at: NOW, by: 'u_t', name: 't', text: `m${i}` })) });
  assert.deepEqual(refusal(() => send(M.traveler, 'One more', {}, full)), ['too_many_messages', 409]);
  assert.equal(send(M.traveler, 'One more', {}, { ...full, messages: full.messages.slice(1) }).next.messages.length, 50);
  assert.equal(send(M.traveler, 'Hello there', {}, request('approved')).outcome, 'message');
});

test('the error table: every code with its status, the copy plain, the card message shared', () => {
  const seen = {};
  const note = (fn) => { try { fn(); } catch (e) { if (e instanceof AppError) seen[e.code] = [e.status, e.message]; else throw e; } };
  const pending = request('pending');
  note(() => transition(request('denied'), LEGAL.cancel[0], LEGAL.cancel[1]));
  note(() => transition(pending, LEGAL.approve[0], { ...LEGAL.approve[1], now: pending.expiresAt }));
  note(() => transition(request(), { type: 'swap', alternative: { id: 'nope' }, draft: DRAFT }, as(M.traveler)));
  note(() => transition(request('approved'), { type: 'cancel' }, as(M.traveler, { now: '2026-11-12T09:00:00.000Z' })));
  note(() => transition(request(), { type: 'cancel' }, as(M.lead)));
  note(() => transition(pending, LEGAL.approve[0], as(M.traveler, { recheck: SAME })));
  note(() => transition(request(), LEGAL.submit[0], as(M.traveler, { recheck: SAME, evaluation: BLOCKED })));
  note(() => transition(request(), { ...LEGAL.submit[0], reason: { text: 'short' } }, as(M.traveler, { recheck: SAME, evaluation: OUT })));
  note(() => transition(request(), { ...LEGAL.submit[0], reason: { text: CARD } }, as(M.traveler, { recheck: SAME, evaluation: OUT })));
  note(() => transition(request(), { ...LEGAL.submit[0], approver: null }, as(M.traveler, { recheck: SAME, evaluation: OUT })));
  note(() => transition(request('draft', { query: { ...request().query, departDate: '2026-10-09' } }), LEGAL.submit[0], as(M.traveler, { recheck: SAME, evaluation: OUT })));
  note(() => transition(pending, { type: 'deny', note: '' }, as(M.lead)));
  note(() => transition(pending, { ...LEGAL.approve[0], budget: { ...BUDGET, remainingCents: 0 } }, as(M.lead, { recheck: SAME })));
  note(() => transition(pending, { type: 'message', text: '' }, as(M.lead)));
  note(() => transition(request('draft', { messages: Array.from({ length: 50 }, () => ({ at: NOW, by: 'u_t', name: 't', text: 'hi' })) }), { type: 'message', text: 'hi' }, as(M.traveler)));
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([k, [s]]) => [k, s])), {
    invalid_transition: 409, request_expired: 409, alternative_gone: 410, departed: 409, not_found: 404, self_approval: 422, policy_blocked: 422,
    reason_too_short: 422, card_number: 422, no_approver: 422, too_late: 422, note_required: 422, over_budget: 422, invalid_message: 422, too_many_messages: 409,
  });
  assert.equal(seen.card_number[1], CARD_MESSAGE);
  assert.match(seen.no_approver[1], /Acme Inc/);
  assert.match(seen.policy_blocked[1], /Acme Inc's policy/);
  assert.equal(seen.over_budget[1], 'Approving this takes Engineering over its Q4 2026 budget. Tick the box to approve it anyway.');
  for (const [, message] of Object.values(seen)) assert.ok(!/\u2014/.test(message), message);
});

test('pure: frozen inputs are never mutated, results are copies, and the same input gives the same output', () => {
  const req = deepFreeze(request('pending', { messages: [{ at: NOW, by: 'u_t', name: 't', text: 'Hi' }] }));
  const event = deepFreeze({ type: 'approve', note: 'Approved for the client visit.', ackOverBudget: true, budget: { ...BUDGET, remainingCents: 1 }, draft: null });
  const opts = deepFreeze(as(M.admin, { recheck: SAME, evaluation: OUT }));
  const a = transition(req, event, opts);
  assert.deepEqual(a, transition(req, event, opts));
  a.next.approval.poolIds.push('x');
  a.next.evaluation.violations.push({ rule: 'x' });
  a.history.by.name = 'changed';
  assert.deepEqual(req.approval.poolIds, []);
  assert.equal(req.evaluation.violations.length, 1);
  assert.equal(opts.actor.name, 'admin');
  const m = transition(req, deepFreeze({ type: 'message', text: 'Thanks' }), deepFreeze(as(M.traveler)));
  m.next.messages[0].text = 'changed';
  assert.equal(req.messages[0].text, 'Hi');
  const d = transition(request('draft'), deepFreeze({ type: 'swap', alternative: ALT, draft: DRAFT }), deepFreeze(as(M.traveler)));
  d.next.rows.out.totalCents = 1;
  assert.equal(DRAFT.rows.out.totalCents, 138000);
});
