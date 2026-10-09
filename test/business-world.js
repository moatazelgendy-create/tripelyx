// A seeded Business world for the Stage 3 isolation and honesty tests (not a test file itself: it doesn't
// match *.test.js). Two companies, Acme Inc (Cairo) and Globex Ltd (London), each with every role, two
// departments with Q4 2026 budgets, a second version of the Standard policy, a pending invite, and (with
// demo inventory) requests in every state: draft, approved by policy, pending with a question, denied,
// cancelled, expired, and sent back because the price changed. A fifth person, Pat Both, is an Employee in
// both companies (the company switcher). A platform admin (Pat Platform) is a member of neither.
//
// Seeding uses the real service (and the store-level helpers for accounts and memberships), so every record
// has the shape the pages read. The clock is held at FIXED_NOW (the expired request is made two days back).
// Every person's name, email, department and trip purpose names its company, so a page of one company can be
// searched for any trace of the other.
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser, seedOrg, seedMember, client, mutableClock } = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { KINDS } = require('../server/business/constants');

const OPS_EMAIL = 'ops@tripelyx.example';
/** Limits high enough that a walk over every route never meets a 429 (the limiters stay in the chains). */
const ROOMY = Object.freeze({ BUSINESS_WRITE_LIMIT: '100000', BUSINESS_COMPUTE_LIMIT: '100000', BUSINESS_AUTH_LIMIT: '100000' });
const PRODUCTION = Object.freeze({ APP_ENV: 'production', DATABASE_URL: 'postgres://x/prod', ENABLE_TRIPS: 'false' });
const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });
const BQ = Object.freeze({ ...Q, cabin: 'business' });
const REASON = 'The board meets at the client office, and this is the only flight that lands in time.';

/** The people of one company, by role key; `word` makes every name and email unique to the company. */
const CAST = Object.freeze([
  ['owner', 'owner', 'Owner'],
  ['admin', 'travel_admin', 'Travel'],
  ['finance', 'finance', 'Finance'],
  ['manager', 'manager', 'Manager'],
  ['employee', 'employee', 'Employee'],
]);

const keyWhere = (sv, leg, f) => {
  const hit = sv.legs[leg].rows.find(f);
  assert.ok(hit, `a ${leg} row for the seed`);
  return hit.row.key;
};
const withinRow = r => r.row.available && r.row.carrier.code === 'ZA' && r.evaluation.status === 'within';

/**
 * Boot the app and seed both companies.
 * @param {{ production?: boolean, env?: object }} [opts] production: APP_ENV=production with an injected
 *   MemoryStore and no supplier (no requests can exist; everything else is seeded the same way)
 */
async function world({ production = false, env = {} } = {}) {
  const clock = mutableClock(FIXED_NOW);
  const app = await startApp({
    ENABLE_BUSINESS: 'true', ADMIN_EMAILS: OPS_EMAIL, ...ROOMY, ...(production ? PRODUCTION : {}), ...env,
  }, { now: clock.now, store: new MemoryStore() });
  const svc = app.business;
  const headers = production ? { 'x-forwarded-proto': 'https' } : {};
  const http = cookie => {
    const c = client(app.base, cookie);
    return {
      get: (path, opts = {}) => c.get(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } }),
      post: (path, form = {}, opts = {}) => c.post(path, form, { ...opts, headers: { ...headers, ...(opts.headers || {}) } }),
      raw: (path, body, type, opts = {}) => c.raw(path, body, type, { ...opts, headers: { ...headers, ...(opts.headers || {}) } }),
    };
  };

  const ops = await seedUser(app, { name: 'Pat Platform', email: OPS_EMAIL });
  await app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
  ops.http = http(ops.cookie);

  const A = await company({ app, svc, clock, http, name: 'Acme Inc', word: 'Acme', domain: 'acme.example', timezone: 'Africa/Cairo', depNames: ['Acme Engineering', 'Acme Sales'], demo: !production });
  const B = await company({ app, svc, clock, http, name: 'Globex Ltd', word: 'Globex', domain: 'globex.example', timezone: 'Europe/London', depNames: ['Globex Research', 'Globex Marketing'], demo: !production });

  // Pat Both: an Employee of both companies, by invite (the real join path).
  const both = await seedMember(app, A, 'employee', { name: 'Pat Both', email: 'pat.both@example.com', departmentId: A.deps[0].id });
  const toB = await svc.invite(B.people.owner.actor, { email: both.user.email, role: 'employee', departmentId: B.deps[0].id });
  await svc.acceptInvite({ user: both.user }, toB.token);
  both.http = http(both.cookie);
  both.actorA = { org: { id: A.id }, user: both.user };
  both.actorB = { org: { id: B.id }, user: both.user };

  return { app, svc, clock, ops, A, B, both, http, production, close: app.close };
}

/** One company with every role, departments, budgets, policy v2, a pending invite and (demo) requests. */
async function company({ app, svc, clock, http, name, word, domain, timezone, depNames, demo }) {
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

  // Budgets for both departments in Q4 2026 (Finance sets them), and the Standard policy's version 2.
  const budgets = [];
  budgets.push(await svc.setBudget(people.finance.actor, deps[0].id, '2026-Q4', null, '20000'));
  budgets.push(await svc.setBudget(people.finance.actor, deps[1].id, '2026-Q4', null, '5000'));
  const pol = await svc.getPolicy(people.owner.actor, 'standard');
  // (With no supplier there is no airline list to block one from, so production changes the hotel notice.)
  const change = demo ? { form: { ...pol.form, blockedCarriers: ['ZS'] }, note: `${word} does not use Sahara Wings` }
    : { form: { ...pol.form, 'hotel.minAdvanceDays': '2' }, note: `${word} asks for hotels two days ahead` };
  await svc.savePolicy(people.owner.actor, 'standard', { ...change, rev: pol.rev });
  // A pending invite.
  const invited = await svc.invite(people.admin.actor, { email: `new.hire@${domain}`, role: 'employee', departmentId: deps[1].id });

  const requests = {};
  if (demo) Object.assign(requests, await seedRequests({ svc, clock, people, word }));
  const fresh = await app.store.getRecord(KINDS.org, org.id);
  return {
    id: org.id, org: fresh, name, word, domain, timezone, general: org.general, deps, people, budgets, invite: invited, requests,
    B: `/business/o/${org.id}`,
  };
}

/** Requests in every state, through the service, as the employee (manager decides). */
async function seedRequests({ svc, clock, people, word }) {
  const emp = people.employee.actor;
  const mgr = people.manager.actor;
  const within = async purpose => {
    const sv = await svc.searchTrip(emp, Q);
    const selection = { out: keyWhere(sv, 'out', withinRow), back: keyWhere(sv, 'back', withinRow), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 3 && r.evaluation.status === 'within') };
    return svc.createRequest(emp, { query: Q, selection, purpose });
  };
  const business = async purpose => {
    const sv = await svc.searchTrip(emp, BQ);
    const zm = r => r.row.available && r.row.carrier.code === 'ZM';
    const selection = { out: keyWhere(sv, 'out', zm), back: keyWhere(sv, 'back', zm), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5) };
    return svc.createRequest(emp, { query: BQ, selection, purpose });
  };
  const send = async r => (await svc.submit(emp, r.id, { rev: r.rev, reason: REASON, category: 'client_meeting' })).request;

  const out = {};
  // Expired: sent two days ago, never decided (24 hours to decide).
  clock.set(new Date(Date.parse(FIXED_NOW) - 2 * 86400000).toISOString());
  out.expired = await send(await business(`${word} expired offsite`));
  clock.set(FIXED_NOW);

  const approved = await within(`${word} client workshop`);
  out.approved = (await svc.submit(emp, approved.id, { rev: approved.rev })).request;
  assert.equal(out.approved.status, 'approved');

  out.pending = await send(await business(`${word} board meeting`));
  assert.equal(out.pending.status, 'pending');
  await svc.message(mgr, out.pending.id, { text: `Could the ${word} meeting move to a Tuesday?` });

  const denied = await send(await business(`${word} partner summit`));
  out.denied = (await svc.decide(mgr, denied.id, { action: 'deny', note: 'Please pick an Economy fare for this one.', rev: denied.rev })).request;

  const cancelled = await send(await business(`${word} trade fair`));
  out.cancelled = await svc.cancel(emp, cancelled.id, { rev: cancelled.rev });
  assert.equal(out.cancelled.status, 'cancelled');

  out.draft = await within(`${word} team planning`);

  // Sent back: the hotel's price moved while it waited, so the approval returned it to the traveler.
  const back = await send(await business(`${word} product launch`));
  const hotels = svc.inventory.hotels;
  const real = hotels.quote;
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 2900 } : l)) };
  };
  try {
    const fresh = await svc.getRequest(mgr, back.id);
    out.returned = (await svc.decide(mgr, back.id, { action: 'approve', note: '', rev: fresh.request.rev })).request;
  } finally {
    hotels.quote = real;
  }
  assert.equal(out.returned.status, 'draft');
  assert.equal(out.returned.returned.why, 'price_changed');
  return out;
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
 * Sign-out and downloads are POSTs, so a crawl never writes.
 * @returns {Promise<Map<string, { status: number, text: string, headers: Headers }>>}
 */
async function crawl(who, start, { cap = 400, prefix = '/business/' } = {}) {
  const seen = new Map();
  const queue = Array.isArray(start) ? [...start] : [start];
  while (queue.length && seen.size < cap) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    const res = await who.get(url);
    seen.set(url, res);
    if (res.status !== 200) continue;
    for (const h of linksOf(res.text)) if (h.startsWith(prefix) && !seen.has(h) && !queue.includes(h)) queue.push(h);
  }
  return seen;
}

module.exports = { world, keyWhere, Q, BQ, REASON, CAST, OPS_EMAIL, ROOMY, PRODUCTION, decode, textOf, mainOf, escRe, linksOf, postForms, crawl };
