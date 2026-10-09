// A seeded Business world for the Stage 3 isolation and honesty tests (not a test file itself: it doesn't
// match *.test.js). Two companies, Acme Inc (Cairo) and Globex Ltd (London), each with every role, two
// departments with Q4 2026 budgets, a newer Standard policy, a pending invite and (with demo inventory)
// requests in many states. A sixth person, Pat Both, is an Employee of Acme and a Manager of Globex (the
// company switcher), with trips in both. A platform admin (Pat Platform) is a member of neither.
//
// The two companies are deliberately NOT mirror images, so a figure copied or summed from the other company
// shows up as a wrong number, not only as a wrong name:
//   - budgets: Acme $20,000 and $3,000; Globex $35,000 and $2,500;
//   - Standard policy: Acme v2 (no Sahara Wings); Globex v3 (no Sahara Wings, London hotels up to $280 a
//     night, hotels two days ahead);
//   - trips: Acme 18 (3 pending, 5 approved, 1 past, 2 denied, 1 cancelled, 1 expired, 5 drafts), on dates
//     from 5 Oct; Globex 11 (4 pending, 3 approved, 1 cancelled, 1 expired, 2 drafts), a week later.
// `C.expected` holds each request's effective status as the seed meant it (checked when it is made), so a
// test can count what a page should say from the seed alone.
//
// Acme's extra trips cover the copy that only some states carry: a swap to a cheaper option (the "Saved"
// line and the savings tile), a manager's approval, an Owner's override approval and denial, a trip whose
// departure has passed, drafts sent back because an option became unavailable or the terms changed, a
// blocked draft, an approval over budget (ackOverBudget) and a pending trip over budget. One pending trip
// (liveChanged) keeps a hotel price change active for the whole run, so its deciders see the live check say
// the price changed.
//
// Personal records (a saved trip, a price watch, a hunt, travel defaults, the last search, a recent trip, a
// trip request, a quote and a booking) are written for Acme's employee and for Pat Both straight into the
// store, as the consumer app keeps them. Each carries a PRIV… word and id that no company page may show.
//
// Seeding uses the real service (and the store-level helpers for accounts and memberships), so every record
// has the shape the pages read. The clock is held at FIXED_NOW (the expired request is sent two days back,
// the past one planned in September). Every person's name, email, department and trip purpose names its
// company, so a page of one company can be searched for any trace of the other.
//
// world({ live: true }) seeds the same requests on live prices (go-live design §5.6): the demo providers moved
// into the live namespace by test/business-sandbox.js useLive, inventory status 'live'. A fixture over the demo
// data, for the live label tests and screenshots: no supplier is called.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser, seedOrg, seedMember, mutableClock } = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { KINDS } = require('../server/business/constants');
const { AppError } = require('../server/lib/errors');
const { useLive } = require('./business-sandbox');

const OPS_EMAIL = 'ops@tripelyx.example';
/** Limits high enough that a walk over every route never meets a 429 (the limiters stay in the chains). */
const ROOMY = Object.freeze({ BUSINESS_WRITE_LIMIT: '100000', BUSINESS_COMPUTE_LIMIT: '100000', BUSINESS_AUTH_LIMIT: '100000' });
const PRODUCTION = Object.freeze({ APP_ENV: 'production', DATABASE_URL: 'postgres://x/prod', ENABLE_TRIPS: 'false' });
const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });
const BQ = Object.freeze({ ...Q, cabin: 'business' });
const REASON = 'The board meets at the client office, and this is the only flight that lands in time.';
const OVERRIDE_NOTE = 'Approved by the owner while the manager is away this week.';

/** The people of one company, by role key; `word` makes every name and email unique to the company. */
const CAST = Object.freeze([
  ['owner', 'owner', 'Owner'],
  ['admin', 'travel_admin', 'Travel'],
  ['finance', 'finance', 'Finance'],
  ['manager', 'manager', 'Manager'],
  ['employee', 'employee', 'Employee'],
]);

/** How the two companies differ (see the header). */
const SHAPES = Object.freeze({
  Acme: Object.freeze({ budgets: ['20000', '3000'], shift: 0, denied: true, policyVersion: 2 }),
  Globex: Object.freeze({ budgets: ['35000', '2500'], shift: 7, denied: false, policyVersion: 3 }),
});

const keyWhere = (sv, leg, f) => {
  const hit = sv.legs[leg].rows.find(f);
  assert.ok(hit, `a ${leg} row for the seed`);
  return hit.row.key;
};
const withinRow = r => r.row.available && r.row.carrier.code === 'ZA' && r.evaluation.status === 'within';
/** A row inside the policy: Zephyr Air where it flies that day, else any. */
const within = (sv, leg) => keyWhere(sv, leg, sv.legs[leg].rows.some(withinRow) ? withinRow : r => r.row.available && r.evaluation.status === 'within');
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * Boot the app and seed both companies.
 * @param {{ production?: boolean, env?: object, store?: object, unique?: boolean }} [opts] production:
 *   APP_ENV=production with an injected store and no supplier (no requests can exist; everything else is seeded
 *   the same way); store: the store to inject (a fresh MemoryStore by default; the isolation test passes a
 *   PostgresStore); unique: a random part in every email domain, for a shared database that keeps the accounts
 *   of earlier runs (the company words, Acme and Globex, stay the same)
 */
async function world({ production = false, env = {}, store = null, unique = false, live = false } = {}) {
  const clock = mutableClock(FIXED_NOW);
  const suffix = unique ? `-${crypto.randomBytes(4).toString('hex')}` : '';
  const opsEmail = unique ? `ops${suffix}@tripelyx.example` : OPS_EMAIL;
  const app = await startApp({
    ENABLE_BUSINESS: 'true', ADMIN_EMAILS: opsEmail, ...ROOMY, ...(production ? PRODUCTION : {}), ...env,
  }, { now: clock.now, store: store || new MemoryStore() });
  const svc = app.business;
  if (live) useLive(app);
  const demo = !production;
  // `connection: close`: a test may spend seconds checking pages between two requests, longer than the
  // server's keep-alive timeout, and a reused socket the server already closed fails the next fetch.
  const headers = { connection: 'close', ...(production ? { 'x-forwarded-proto': 'https' } : {}) };
  const http = cookie => client(app.base, cookie, headers);

  const ops = await seedUser(app, { name: 'Pat Platform', email: opsEmail });
  await app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
  ops.http = http(ops.cookie);

  const quotes = demo ? hotelOverrides(svc) : null;
  const ctx = { app, svc, clock, http, demo, quotes };
  const A = await company(ctx, { name: 'Acme Inc', word: 'Acme', domain: `acme${suffix}.example`, timezone: 'Africa/Cairo', depNames: ['Acme Engineering', 'Acme Sales'] });
  const B = await company(ctx, { name: 'Globex Ltd', word: 'Globex', domain: `globex${suffix}.example`, timezone: 'Europe/London', depNames: ['Globex Research', 'Globex Marketing'] });

  // Pat Both: an Employee of Acme (Sales, managed by Acme's manager) and a Manager of Globex (Research), each
  // by invite (the real join path, so each company logs its own join). Globex's Finance member names Pat as
  // their approver, so Pat has an inbox in Globex and none in Acme.
  const both = await seedUser(app, { name: 'Pat Both', email: `pat.both${suffix}@example.com` });
  const toA = await svc.invite(A.people.owner.actor, { email: both.user.email, role: 'employee', departmentId: A.deps[1].id, managerId: A.people.manager.user.id });
  await svc.acceptInvite({ user: both.user }, toA.token);
  const toB = await svc.invite(B.people.owner.actor, { email: both.user.email, role: 'manager', departmentId: B.deps[0].id });
  await svc.acceptInvite({ user: both.user }, toB.token);
  both.http = http(both.cookie);
  both.actorA = { org: { id: A.id }, user: both.user };
  both.actorB = { org: { id: B.id }, user: both.user };
  const fin = await svc.repo.getIn(KINDS.member, `${B.id}.${B.people.finance.user.id}`, B.id);
  await svc.updateMember(B.people.owner.actor, B.people.finance.user.id, { approverId: both.user.id, rev: fin.rev });

  if (demo) {
    await acmeExtras(ctx, A, both);
    await globexExtras(ctx, B, both);
  }
  // Personal records of the consumer app, which no company page may show.
  const personal = [await personalRecords(app, A.people.employee.user, 'ACMEEMP'), await personalRecords(app, both.user, 'PATBOTH')];
  for (const C of [A, B]) C.org = await app.store.getRecord(KINDS.org, C.id);
  return { app, svc, clock, ops, A, B, both, http, production, quotes, personal, close: app.close };
}

/** A fetch client like business-helpers.client, with extra headers on every request. */
function client(base, cookie = '', extra = {}) {
  const req = async (path, { method = 'GET', form, body, type, headers = {} } = {}) => {
    const h = { 'sec-fetch-site': 'same-origin', ...extra, ...(cookie ? { cookie } : {}), ...headers };
    let payload = body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (type) h['content-type'] = type;
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  };
  return {
    req,
    get: (path, opts = {}) => req(path, opts),
    post: (path, form = {}, opts = {}) => req(path, { ...opts, method: 'POST', form }),
    raw: (path, body, type, opts = {}) => req(path, { ...opts, method: 'POST', body, type }),
  };
}

/**
 * Hotel quotes by check-in date: `rules.set(checkIn, { unavailable: true })` makes every room of that stay
 * stop pricing (the provider's 409), `{ fn }` rewrites the quote. Dates are unique to the trips that use them.
 * @returns {Map<string, { unavailable?: boolean, fn?: Function }>}
 */
function hotelOverrides(svc) {
  const rules = new Map();
  const hotels = svc.inventory.hotels;
  const real = hotels.quote;
  hotels.quote = async function quote(args) {
    const rule = args && args.query ? rules.get(args.query.checkIn) : null;
    if (rule && rule.unavailable) throw new AppError('option_gone', 'That room no longer prices.', 409);
    const q = await real.call(this, args);
    return rule && rule.fn ? rule.fn(q) : q;
  };
  return rules;
}
/** +$29 on the first price line: the total moves. */
const priceUp = q => ({ ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 2900 } : l)) });
/** $1 moved from the first price line to the second: the same total, other terms. */
const termsMoved = q => {
  assert.ok(q.lines.length >= 2, 'a hotel quote has two price lines');
  return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount - 100 } : i === 1 ? { ...l, amount: l.amount + 100 } : l)) };
};

/** One company with every role, departments, budgets, a newer policy, a pending invite and (demo) base requests. */
async function company(ctx, { name, word, domain, timezone, depNames }) {
  const { app, svc, http, demo } = ctx;
  const shape = SHAPES[word];
  const ownerUser = await seedUser(app, { name: `Olivia ${word}`, email: `owner@${domain}` });
  const org = await seedOrg(app, ownerUser, { name, timezone });
  const as = u => ({ org: { id: org.id }, user: u.user });
  const people = {};
  people.owner = { ...ownerUser, member: org.owner, role: 'owner', actor: as(ownerUser) };

  const deps = [];
  for (const depName of depNames) deps.push(await svc.saveDepartment(people.owner.actor, { name: depName }));
  for (const [key, role, title] of CAST.slice(1)) {
    const extra = key === 'manager' ? { departmentId: deps[0].id } : key === 'employee' ? { departmentId: deps[0].id, managerId: people.manager.user.id } : {};
    const m = await seedMember(app, org, role, { name: `${title} ${word}`, email: `${key}@${domain}`, ...extra });
    people[key] = { ...m, role, actor: as(m) };
  }
  for (const p of Object.values(people)) p.http = http(p.cookie);

  // Budgets for both departments in Q4 2026 (Finance sets them), and the Standard policy's newer versions.
  const budgets = [];
  budgets.push(await svc.setBudget(people.finance.actor, deps[0].id, '2026-Q4', null, shape.budgets[0]));
  budgets.push(await svc.setBudget(people.finance.actor, deps[1].id, '2026-Q4', null, shape.budgets[1]));
  let pol = await svc.getPolicy(people.owner.actor, 'standard');
  // (With no supplier there is no airline list to block one from, so production changes the hotel notice.)
  const change = demo ? { form: { ...pol.form, blockedCarriers: ['ZS'] }, note: `${word} does not use Sahara Wings` }
    : { form: { ...pol.form, 'hotel.minAdvanceDays': '2' }, note: `${word} asks for hotels two days ahead` };
  await svc.savePolicy(people.owner.actor, 'standard', { ...change, rev: pol.rev });
  if (shape.policyVersion === 3) {
    pol = await svc.getPolicy(people.owner.actor, 'standard');
    const london = Object.keys(pol.form).find(k => /^country\.\d+\.city\.\d+\.name$/.test(k) && pol.form[k] === 'London');
    assert.ok(london, 'the London cap in the policy form');
    const form = { ...pol.form, [london.replace(/name$/, 'nightly')]: '280', 'hotel.minAdvanceDays': '2' };
    // (A change note is the company's own words, shown as written, so it names no amount: the honesty test
    // holds every amount a demo page draws to a Demo price label.)
    await svc.savePolicy(people.owner.actor, 'standard', { form, rev: pol.rev, note: `${word} keeps London hotels cheaper` });
  }
  assert.equal((await svc.getPolicy(people.owner.actor, 'standard')).version, shape.policyVersion);
  // A pending invite.
  const invited = await svc.invite(people.admin.actor, { email: `new.hire@${domain}`, role: 'employee', departmentId: deps[1].id });

  const C = {
    id: org.id, org: null, name, word, domain, timezone, general: org.general, deps, people, budgets, invite: invited, requests: {}, expected: {},
    shape, B: `/business/o/${org.id}`,
  };
  if (demo) await baseRequests(ctx, C);
  return C;
}

// ---------------------------------------------------------------------------------------------------------
// Requests

/**
 * The trip helpers for one company (as any of its actors): within, business and blocked drafts, send, and
 * keep (which records a seeded request in C.requests and C.expected).
 * @param {{ svc: object }} ctx
 * @param {object} C a company of world()
 */
function trips(ctx, C) {
  const { svc } = ctx;
  const query = (depart, nights, cabin) => ({ ...Q, depart, return: addDays(depart, nights), cabin });
  const make = async (actor, q, selection, purpose) => svc.createRequest(actor, { query: q, selection, purpose });
  return {
    async within(actor, depart, nights, purpose) {
      const q = query(depart, nights, 'economy');
      const sv = await svc.searchTrip(actor, q);
      return make(actor, q, { out: within(sv, 'out'), back: within(sv, 'back'), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 3 && r.evaluation.status === 'within') }, purpose);
    },
    async business(actor, depart, nights, purpose) {
      const q = query(depart, nights, 'business');
      const sv = await svc.searchTrip(actor, q);
      // Mediterra Airways where it flies that day, else any airline the policy allows.
      const pick = leg => (sv.legs[leg].rows.some(r => r.row.available && r.row.carrier.code === 'ZM') ? r => r.row.available && r.row.carrier.code === 'ZM'
        : r => r.row.available && r.evaluation.status !== 'blocked');
      return make(actor, q, { out: keyWhere(sv, 'out', pick('out')), back: keyWhere(sv, 'back', pick('back')), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5) }, purpose);
    },
    async blocked(actor, depart, nights, purpose) {
      const q = query(depart, nights, 'economy');
      const sv = await svc.searchTrip(actor, q);
      const zs = r => r.row.available && r.row.carrier.code === 'ZS';
      return make(actor, q, { out: keyWhere(sv, 'out', zs), back: within(sv, 'back'), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 3) }, purpose);
    },
    async send(actor, r) { return (await svc.submit(actor, r.id, { rev: r.rev, reason: REASON, category: 'client_meeting' })).request; },
    keep(key, r, status) {
      assert.equal(r.orgId, C.id, `${C.word} ${key} is the company's own`);
      C.requests[key] = r;
      C.expected[key] = status;
      return r;
    },
  };
}

/** Requests in every state, through the service, as the employee (the manager decides). */
async function baseRequests(ctx, C) {
  const { svc, clock, quotes } = ctx;
  const t = trips(ctx, C);
  const { word } = C;
  const emp = C.people.employee.actor;
  const mgr = C.people.manager.actor;
  const day = addDays(Q.depart, C.shape.shift);
  const nights = 4;

  // Expired: sent two days ago, never decided (24 hours to decide).
  clock.set(new Date(Date.parse(FIXED_NOW) - 2 * 86400000).toISOString());
  t.keep('expired', await t.send(emp, await t.business(emp, day, nights, `${word} expired offsite`)), 'expired');
  clock.set(FIXED_NOW);

  const approved = await t.within(emp, day, nights, `${word} client workshop`);
  t.keep('approved', (await svc.submit(emp, approved.id, { rev: approved.rev })).request, 'approved');
  assert.equal(C.requests.approved.status, 'approved');

  const pending = t.keep('pending', await t.send(emp, await t.business(emp, day, nights, `${word} board meeting`)), 'pending');
  assert.equal(pending.status, 'pending');
  await svc.message(mgr, pending.id, { text: `Could the ${word} meeting move to a Tuesday?` });

  if (C.shape.denied) {
    const denied = await t.send(emp, await t.business(emp, day, nights, `${word} partner summit`));
    t.keep('denied', (await svc.decide(mgr, denied.id, { action: 'deny', note: 'Please pick an Economy fare for this one.', rev: denied.rev })).request, 'denied');
  }

  const cancelled = await t.send(emp, await t.business(emp, day, nights, `${word} trade fair`));
  t.keep('cancelled', await svc.cancel(emp, cancelled.id, { rev: cancelled.rev }), 'cancelled');
  assert.equal(C.requests.cancelled.status, 'cancelled');

  t.keep('draft', await t.within(emp, day, nights, `${word} team planning`), 'draft');

  // Sent back: the hotel's price moved while it waited, so the approval returned it to the traveler.
  const back = await t.send(emp, await t.business(emp, day, nights, `${word} product launch`));
  quotes.set(day, { fn: priceUp });
  try {
    const fresh = await svc.getRequest(mgr, back.id);
    t.keep('returned', (await svc.decide(mgr, back.id, { action: 'approve', note: '', rev: fresh.request.rev })).request, 'draft');
  } finally {
    quotes.delete(day);
  }
  assert.equal(C.requests.returned.status, 'draft');
  assert.equal(C.requests.returned.returned.why, 'price_changed');
}

/** Acme's extra states (see the header). Pat Both is an Acme Employee in Sales, whose budget is $3,000. */
async function acmeExtras(ctx, C, both) {
  const { svc, clock, quotes } = ctx;
  const t = trips(ctx, C);
  const emp = C.people.employee.actor;
  const mgr = C.people.manager.actor;
  const owner = C.people.owner.actor;
  const decide = async (actor, r, form) => (await svc.decide(actor, r.id, { note: '', ...form, rev: r.rev })).request;

  // A swap to the cheapest option inside the policy, then sent (and approved by the manager if it still
  // needed approval): the history says what the switch saved.
  const sw = await t.business(emp, '2026-11-02', 3, 'Acme supplier visit');
  assert.ok(sw.alternatives && sw.alternatives.length, 'the swapped trip has cheaper options');
  const swapped = await svc.swap(emp, sw.id, { altId: sw.alternatives[0].id, rev: sw.rev });
  let done = await t.send(emp, swapped);
  if (done.status === 'pending') done = await decide(mgr, done, { action: 'approve' });
  t.keep('swapped', done, 'approved');
  assert.equal(done.status, 'approved');
  assert.ok(done.history.some(h => h.action === 'swapped' && h.savedCents > 0), 'the switch saved money');

  t.keep('mgrApproved', await decide(mgr, await t.send(emp, await t.business(emp, '2026-11-03', 3, 'Acme customer training')), { action: 'approve' }), 'approved');
  assert.equal(C.requests.mgrApproved.approval.decidedAs, 'assigned');
  t.keep('ovApproved', await decide(owner, await t.send(emp, await t.business(emp, '2026-11-04', 3, 'Acme investor day')), { action: 'approve', note: OVERRIDE_NOTE }), 'approved');
  assert.equal(C.requests.ovApproved.approval.decidedAs, 'override');
  t.keep('ovDenied', await decide(owner, await t.send(emp, await t.business(emp, '2026-11-05', 3, 'Acme roadshow')), { action: 'deny', note: 'Not this quarter, please plan it for January.' }), 'denied');
  assert.equal(C.requests.ovDenied.approval.decidedAs, 'override');

  // Sent back at approval: the hotel stopped pricing; then the same total with other price lines.
  for (const [key, depart, rule, why, purpose] of [['unavailable', '2026-11-06', { unavailable: true }, 'unavailable', 'Acme warehouse audit'], ['terms', '2026-11-09', { fn: termsMoved }, 'terms_changed', 'Acme factory tour']]) {
    const sent = await t.send(emp, await t.business(emp, depart, 3, purpose));
    quotes.set(depart, rule);
    try {
      t.keep(key, await decide(mgr, sent, { action: 'approve' }), 'draft');
    } finally {
      quotes.delete(depart);
    }
    assert.equal(C.requests[key].status, 'draft', key);
    assert.equal(C.requests[key].returned.why, why, key);
  }

  // Pending while the hotel's price has moved since it was sent: kept moved for the whole run.
  t.keep('liveChanged', await t.send(emp, await t.business(emp, '2026-11-10', 3, 'Acme design review')), 'pending');
  quotes.set('2026-11-10', { fn: priceUp });

  t.keep('blocked', await t.blocked(emp, '2026-11-23', 2, 'Acme quick visit'), 'draft');
  assert.equal(C.requests.blocked.evaluation.status, 'blocked');

  // Planned in September, approved by policy, departed on 5 October.
  clock.set('2026-09-20T09:00:00.000Z');
  try {
    const p = await t.within(emp, '2026-10-05', 2, 'Acme autumn check-in');
    t.keep('past', (await svc.submit(emp, p.id, { rev: p.rev })).request, 'past');
  } finally {
    clock.set(FIXED_NOW);
  }
  assert.equal(C.requests.past.status, 'approved');

  // Pat's Acme trips, in Sales ($3,000): approved over the budget by the manager, then one waiting over it.
  const pat = both.actorA;
  const over = await t.send(pat, await t.business(pat, '2026-11-16', 3, 'Acme Pat sales pitch'));
  await assert.rejects(svc.decide(mgr, over.id, { action: 'approve', note: '', rev: over.rev }), e => e instanceof AppError && e.code === 'over_budget');
  t.keep('patOver', await decide(mgr, over, { action: 'approve', ackOverBudget: '1' }), 'approved');
  assert.equal(C.requests.patOver.approval.overBudgetAck, true);
  t.keep('patPending', await t.send(pat, await t.business(pat, '2026-11-17', 3, 'Acme Pat sales follow-up')), 'pending');
}

/** Globex's extra trips: two more pending, Pat's own trip, and Globex Finance's trips that Pat decides. */
async function globexExtras(ctx, C, both) {
  const { svc } = ctx;
  const t = trips(ctx, C);
  const emp = C.people.employee.actor;
  const fin = C.people.finance.actor;
  t.keep('extraPending1', await t.send(emp, await t.business(emp, '2026-11-27', 3, 'Globex lab visit')), 'pending');
  t.keep('extraPending2', await t.send(emp, await t.business(emp, '2026-11-30', 3, 'Globex research retreat')), 'pending');
  const own = await t.within(both.actorB, '2026-11-24', 2, 'Globex Pat site visit');
  t.keep('patGlobex', (await svc.submit(both.actorB, own.id, { rev: own.rev })).request, 'approved');
  const finPending = t.keep('finPending', await t.send(fin, await t.business(fin, '2026-11-25', 3, 'Globex finance audit')), 'pending');
  assert.equal(finPending.approval.approverId, both.user.id, 'Pat decides Globex Finance trips');
  const toDecide = await t.send(fin, await t.business(fin, '2026-11-26', 3, 'Globex finance conference'));
  t.keep('finApproved', (await svc.decide(both.actorB, toDecide.id, { action: 'approve', note: '', rev: toDecide.rev })).request, 'approved');
}

// ---------------------------------------------------------------------------------------------------------
// Personal records

/**
 * The consumer app's records for one person, straight into the store as the consumer app keeps them. Ids carry
 * a random part, so a shared database never holds two runs' quotes or bookings under one id.
 * @returns {Promise<{ tag: string, ids: string[], quoteId: string, bookingId: string }>} tag: the word every
 *   record carries
 */
async function personalRecords(app, user, word) {
  const s = app.store;
  const tag = `PRIV${word}`;
  const n = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ids = { saved: `sav_${tag}${n}01`, watch: `wch_${tag}${n}02`, hunt: `hnt_${tag}${n}03`, tripRequest: `trq_${tag}${n}04`, quote: `qte_${tag}${n}05`, booking: `bkg_${tag}${n}06` };
  const own = { userId: user.id };
  await s.putRecord('saved', ids.saved, { id: ids.saved, kind: 'saved', token: `tok${tag}`, budget: 250000, priceAtSave: 199900, title: `4 nights in Zanzibar ${tag}`, savedAt: FIXED_NOW }, own);
  await s.putRecord('watch', ids.watch, { id: ids.watch, kind: 'watch', token: `tok${tag}`, budget: 250000, priceAtSave: 189900, title: `Watch Zanzibar ${tag}`, rule: { below: 150000 }, savedAt: FIXED_NOW }, own);
  await s.putRecord('hunt', ids.hunt, { id: ids.hunt, userId: user.id, status: 'hunting', budget: 300000, where: `Zanzibar ${tag}`, createdAt: FIXED_NOW, updatedAt: FIXED_NOW }, own);
  await s.putRecord('travel_defaults', user.id, { home: `Alexandria ${tag}`, travelers: 2, experiencePrefs: { note: `Diving ${tag}` } }, own);
  await s.putRecord('last_search', user.id, { query: { where: `Zanzibar ${tag}` }, at: FIXED_NOW }, own);
  await s.putRecord('recent_trip', user.id, { token: `tok${tag}`, budget: 250000, at: FIXED_NOW }, own);
  await s.putRecord('trip_request', ids.tripRequest, { id: ids.tripRequest, userId: user.id, note: `Honeymoon ${tag}`, status: 'new' }, own);
  await s.saveQuote({ id: ids.quote, vertical: 'hotels', demo: true, expiresAt: '2026-10-10T09:00:00.000Z', userId: user.id, note: `Quote ${tag}` });
  await s.createBooking({
    id: ids.booking, ref: `REF${tag}${n}`, vertical: 'hotels', status: 'held', demo: true, traveler: { email: user.email, name: user.name },
    total: 199900, currency: 'USD', userId: user.id, title: `Stay ${tag}`, createdAt: FIXED_NOW,
  });
  return { tag, ids: [...Object.values(ids), `REF${tag}${n}`, `tok${tag}`], quoteId: ids.quote, bookingId: ids.booking };
}

// ---------------------------------------------------------------------------------------------------------
// Page reading

const decode = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = s => decode(String(s).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const mainOf = page => (String(page).match(/<main\b[\s\S]*<\/main>/) || [''])[0];
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every same-site GET link on a page (decoded), without its #fragment. */
function linksOf(page) {
  return [...String(page).matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map(m => decode(m[1]).split('#')[0]).filter(h => h.startsWith('/'));
}

/** Every <form method="post"> on a page: { action, fields: [[name, value]] }. */
function postForms(page) {
  const out = [];
  for (const m of String(page).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    if (!/\smethod="post"/i.test(m[1])) continue;
    const action = (m[1].match(/\saction="([^"]*)"/) || [])[1];
    if (!action) continue;
    const fields = [];
    for (const [tag] of m[2].matchAll(/<input\b[^>]*>/g)) {
      const nm = (tag.match(/\sname="([^"]*)"/) || [])[1];
      if (!nm) continue;
      const type = ((tag.match(/\stype="([^"]*)"/) || [])[1] || 'text').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/.test(tag)) continue;
      fields.push([decode(nm), decode((tag.match(/\svalue="([^"]*)"/) || [, ''])[1])]);
    }
    out.push({ action: decode(action), fields });
  }
  return out;
}

/**
 * Crawl a member's workspace from its home: every same-workspace GET link, breadth first, up to `cap` pages.
 * Sign-out and downloads are POSTs, so a crawl never writes. `onPage(url, res)` runs on each page as it
 * arrives (so a check never waits for the whole crawl).
 * @returns {Promise<Map<string, { status: number, text: string, headers: Headers }>>}
 */
async function crawl(who, start, { cap = 400, prefix = '/business/', onPage = null } = {}) {
  const seen = new Map();
  const queue = Array.isArray(start) ? [...start] : [start];
  while (queue.length && seen.size < cap) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    const res = await who.get(url);
    seen.set(url, res);
    if (onPage) onPage(url, res);
    if (res.status !== 200) continue;
    for (const h of linksOf(res.text)) if (h.startsWith(prefix) && !seen.has(h) && !queue.includes(h)) queue.push(h);
  }
  return seen;
}

/**
 * Every record a store holds that Business or the consumer app could show, as one string with stable
 * ordering, for any store (MemoryStore or PostgresStore): every company's biz_* records by kind and scope
 * (the org scope, each member's link scope and each user's index), the companies themselves, and each
 * person's personal records, quotes and bookings.
 * @param {object} w a world
 * @returns {Promise<string>}
 */
async function snapshot(w) {
  const s = w.app.store;
  const { memberScope } = require('../server/business/repo');
  const orgIds = [w.A.id, w.B.id, ...(w.extraOrgs || [])].sort();
  const users = [...new Set([w.A, w.B].flatMap(C => Object.values(C.people).map(p => p.user.id)).concat(w.both.user.id, w.ops.user.id, ...(w.extraUsers || [])))].sort();
  const out = { orgs: await Promise.all(orgIds.map(id => s.getRecord(KINDS.org, id))) };
  const sorted = rows => rows.map(r => JSON.stringify(r)).sort();
  for (const kind of Object.values(KINDS)) {
    if (kind === KINDS.org) continue;
    for (const orgId of orgIds) {
      out[`${kind}|${orgId}`] = sorted(await s.listRecords(kind, { userId: orgId, limit: 5000 }));
      if (kind === KINDS.reqLink) for (const u of users) out[`${kind}|${orgId}|${u}`] = sorted(await s.listRecords(kind, { userId: memberScope(orgId, u), limit: 5000 }));
    }
    if (kind === KINDS.userIndex) for (const u of users) out[`${kind}|${u}`] = sorted(await s.listRecords(kind, { userId: u, limit: 100 }));
  }
  for (const kind of ['saved', 'watch', 'hunt', 'travel_defaults', 'last_search', 'recent_trip', 'trip_request', 'user', 'platform_admin']) {
    for (const u of users) out[`${kind}|${u}`] = sorted(await s.listRecords(kind, { userId: u, limit: 100 }));
  }
  for (const p of w.personal) {
    out[`quote|${p.tag}`] = JSON.stringify(await s.getQuote(p.quoteId));
    out[`booking|${p.tag}`] = JSON.stringify(await s.getBooking(p.bookingId));
  }
  return JSON.stringify(out);
}

module.exports = {
  world, client, trips, keyWhere, addDays, Q, BQ, REASON, OVERRIDE_NOTE, CAST, SHAPES, OPS_EMAIL, ROOMY, PRODUCTION,
  decode, textOf, mainOf, escRe, linksOf, postForms, crawl, snapshot, priceUp, termsMoved,
};
