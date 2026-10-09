// Tripelyx Business company isolation (plan §I7, §L Stage 3): one company can never see, change or infer
// another company's data. Two seeded companies (test/business-world.js: Acme Inc and Globex Ltd, every role,
// departments, budgets, policy versions, a pending invite and requests in many states) that are deliberately
// not mirror images, Pat Both (an Employee of Acme and a Manager of Globex, with trips and approvals in both),
// consumer records of two people, and a platform admin.
//
// - Each company's own figures, exactly: the home tiles, the approvals tabs, the reports, the budgets, the
//   CSV row count and a search's policy, from that company's seed alone (a figure summed or copied from the
//   other company is a wrong number).
// - Pat Both's links, lists, inbox, activity and export in each company hold only that company's records.
// - The role matrix: each role on each workspace route gives the 200, 303, 403 or 404 that plan §D and §B4 say,
//   from literal tables (not from roles.js or the ROUTES tables, which are checked against the same literals).
// - Every entry of every Business ROUTES table (public, traveler, admin, platform) is walked with ids from the
//   other company, made-up ids and malformed ids, as every role: a cross-company read or write answers like the
//   made-up id (same status, byte-identical body, same headers but the date, the visitor cookie and the
//   limiter's count), and the store is unchanged after every attempt. Ids in forms and query strings
//   (departments, travelers, managers, approvers, alternatives, cursors, policy versions) are refused the same
//   way. A suspended company, a pending company and a removed member answer like a made-up company; the other
//   company's real invite token is refused and writes nothing; a 429 on another company's URL is the plain one.
// - The Repo choke point refuses unscoped reads, personal kinds and another tenant's records, on the
//   MemoryStore and (with TEST_DATABASE_URL) on PostgresStore, where a reduced route walk runs too.
// - Every service method refuses an actor that names a company the user is not in.
// - Every page, the CSV, the activity log, the company export and the company switcher of one company hold no
//   trace of the other, and no page of either holds anyone's consumer records; crawling writes nothing.
// - A platform admin who is not a member gets the plain 404 on every company page.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  world, trips, keyWhere, crawl, textOf, mainOf, escRe, snapshot, addDays, REASON, BQ, Q,
} = require('./business-world');
const { storeSnapshot, seedUser, seedOrg, seedMember } = require('./business-helpers');
const businessRoutes = require('../server/routes/business');
const businessPlatform = require('../server/routes/businessPlatform');
const { Repo, memberScope } = require('../server/business/repo');
const { SERVICE_METHODS } = require('../server/business/service');
const { KINDS, AUDIT_GROUPS } = require('../server/business/constants');
const { AppError } = require('../server/lib/errors');
const roles = require('../server/business/roles');
const tokens = require('../server/business/tokens');
const { money } = require('../server/views/business/format');
const { PostgresStore } = require('../server/booking/PostgresStore');

let w;
test.before(async () => { w = await world(); });
test.after(async () => { if (w) await w.close(); });

const MADE_UP = Object.freeze({
  orgId: 'org_ZZZZZZZZZZZZZZZZ', rid: 'btr_ZZZZZZZZZZZZZZZZ', userId: 'usr_ZZZZZZZZZZZZZZZZ', publicId: 'inv_ZZZZZZZZZZZZZZZZ',
  departmentId: 'dep_ZZZZZZZZZZZZZZZZ', tier: 'premium', token: tokens.newToken(), altId: 'alt_ZZZZZZZZZZZZZZZZ', cursor: 'abc.def',
});
/** Ids that can't be ids, as they go in a path: wrong shape, wrong case, a colon, NUL, a space, markup, an em dash, far too long. */
const MALFORMED = Object.freeze(['x', 'btr_short', 'BTR_ZZZZZZZZZZZZZZZZ', 'org_ZZZZ%3AZZZZZZZZZZZ', '%00', '%20', '%3Cb%3Ehi%3C%2Fb%3E', '%E2%80%94', 'z'.repeat(240)]);
/** The same values as typed into a form field or a query parameter. */
const MALFORMED_RAW = Object.freeze(MALFORMED.map(decodeURIComponent));
/** A broken percent escape: Express answers 400 before any route runs, the same for every company. */
const BAD_ESCAPE = '%E0';

const ALL_ROUTES = Object.freeze([
  ...businessRoutes.ROUTES.map(r => ({ ...r, mount: businessRoutes.MOUNT })),
  ...businessPlatform.ROUTES.map(r => ({ ...r, mount: businessPlatform.MOUNT })),
]);
const keyOf = r => `${r.mount} ${r.method} ${r.path}`;
const paramsOf = r => [...r.path.matchAll(/:([A-Za-z]+)/g)].map(m => m[1]);
const urlOf = (r, values) => r.mount + (r.path === '/' ? '' : r.path.replace(/:([A-Za-z]+)/g, (m, k) => {
  assert.ok(Object.hasOwn(values, k), `a value for :${k} in ${r.path}`);
  return values[k];
}));
const visited = new Set();

// ---------------------------------------------------------------------------------------------------------
// Plan §D and §B4, literally

/** The world's role keys, in §D's column order: Owner, Travel Admin, Finance, Manager, Employee. */
const ROLE_KEYS = Object.freeze(['owner', 'admin', 'finance', 'manager', 'employee']);
const ROLE_NAMES = Object.freeze({ owner: 'owner', admin: 'travel_admin', finance: 'finance', manager: 'manager', employee: 'employee' });
/** Plan §D: which roles hold each permission, one letter per column (O T F M E), '-' for none. */
const D = Object.freeze({
  'org.view': 'OTFME', 'trip.request': 'OTFME', 'request.view.own': 'OTFME',
  'request.view.team': 'OT-M-', 'request.view.all': 'OTF--',
  'approval.decide': 'OT-M-', 'approval.override': 'OT---',
  'policy.view.all': 'OTF--', 'policy.edit': 'OT---',
  'budget.view.dept': 'OTFM-', 'budget.view.all': 'OTF--', 'budget.edit': 'O-F--',
  'members.view': 'OTFM-', 'members.manage': 'OT---', 'departments.manage': 'OT---',
  'reports.view': 'OTF--', 'reports.export': 'OTF--', 'audit.view': 'OTF--',
  'settings.travel': 'OT---', 'settings.company': 'O----',
});
const holds = (roleKey, perm) => D[perm][ROLE_KEYS.indexOf(roleKey)] !== '-';
const holdsAny = (roleKey, perm) => perm === null || (Array.isArray(perm) ? perm : [perm]).some(p => holds(roleKey, p));

const OWN_TEAM_ALL = Object.freeze(['request.view.own', 'request.view.team', 'request.view.all']);
/** Plan §B4: each route's permission, `own` and who may call it (by `${mount} ${method} ${path}`). */
const ROUTE_PERMS = Object.freeze({
  '/business GET /start': [null, false, 'anyone'],
  '/business POST /start': [null, false, 'anyone'],
  '/business GET /signin': [null, false, 'anyone'],
  '/business POST /signin': [null, false, 'anyone'],
  '/business POST /signout': [null, false, 'user'],
  '/business GET /invite/:token': [null, false, 'anyone'],
  '/business POST /invite/:token/accept': [null, false, 'user'],
  '/business POST /invite/:token/join': [null, false, 'anyone'],
  '/business GET /app': [null, false, 'user'],
  '/business GET /o/:orgId': ['org.view', false, 'member'],
  '/business GET /o/:orgId/policy': ['org.view', false, 'member'],
  '/business GET /o/:orgId/trips/new': ['trip.request', false, 'member'],
  '/business GET /o/:orgId/trips/search': ['trip.request', false, 'member'],
  '/business POST /o/:orgId/trips': ['trip.request', false, 'member'],
  '/business GET /o/:orgId/trips': [OWN_TEAM_ALL, false, 'member'],
  '/business GET /o/:orgId/trips/:rid': [[...OWN_TEAM_ALL, 'approval.decide', 'approval.override'], 'request', 'member'],
  '/business POST /o/:orgId/trips/:rid/swap': ['request.view.own', 'request', 'member'],
  '/business POST /o/:orgId/trips/:rid/submit': ['request.view.own', 'request', 'member'],
  '/business POST /o/:orgId/trips/:rid/cancel': [['request.view.own', 'approval.override'], 'request', 'member'],
  '/business POST /o/:orgId/trips/:rid/decide': [['approval.decide', 'approval.override'], 'request', 'member'],
  '/business POST /o/:orgId/trips/:rid/message': [['request.view.own', 'approval.decide', 'approval.override'], 'request', 'member'],
  '/business GET /o/:orgId/approvals': ['approval.decide', false, 'member'],
  '/business GET /o/:orgId/welcome': ['settings.company', false, 'member'],
  '/business GET /o/:orgId/policies': ['policy.view.all', false, 'member'],
  '/business GET /o/:orgId/policies/:tier': ['policy.view.all', false, 'member'],
  '/business POST /o/:orgId/policies/:tier': ['policy.edit', false, 'member'],
  '/business GET /o/:orgId/policies/:tier/history': ['policy.view.all', false, 'member'],
  '/business GET /o/:orgId/budgets': [['budget.view.dept', 'budget.view.all'], false, 'member'],
  '/business POST /o/:orgId/budgets': ['budget.edit', false, 'member'],
  '/business GET /o/:orgId/people': ['members.view', false, 'member'],
  '/business POST /o/:orgId/people/invite': ['members.manage', false, 'member'],
  '/business POST /o/:orgId/people/invites/:publicId/revoke': ['members.manage', false, 'member'],
  '/business POST /o/:orgId/people/:userId': ['members.manage', false, 'member'],
  '/business POST /o/:orgId/people/:userId/remove': ['members.manage', false, 'member'],
  '/business POST /o/:orgId/departments': ['departments.manage', false, 'member'],
  '/business GET /o/:orgId/reports': ['reports.view', false, 'member'],
  '/business POST /o/:orgId/reports/export': ['reports.export', false, 'member'],
  '/business GET /o/:orgId/activity': ['audit.view', false, 'member'],
  '/business GET /o/:orgId/settings': ['org.view', false, 'member'],
  '/business POST /o/:orgId/settings': [['settings.company', 'settings.travel'], false, 'member'],
  '/business POST /o/:orgId/settings/export': ['settings.company', false, 'member'],
  '/admin/business GET /': [null, false, 'platform'],
  '/admin/business POST /:orgId/status': [null, false, 'platform'],
});
const permOf = r => ROUTE_PERMS[keyOf(r)][0];

// ---------------------------------------------------------------------------------------------------------
// Comparing an answer with a made-up id's

/** A form that gets past field checks on every POST, so a refusal is about the ids alone. */
function formFor(r, C) {
  return {
    rev: '0', reason: REASON, category: 'client_meeting', action: 'approve', note: 'Checked with the team lead first.', ackOverBudget: '1',
    text: 'Could this move to Tuesday?', altId: 'alt_none', role: 'employee', tier: 'standard', departmentId: C.deps[0].id, managerId: '', approverId: '',
    amount: '100', period: '2026-Q4', name: 'Renamed Team', email: 'someone@example.com', password: 'correct horse battery staple',
    companyName: 'Another Co', size: '1-10 people', status: 'active', ...(r.path === '/o/:orgId/trips' ? { from: 'CAI', to: 'LHR', depart: '2026-11-12', out: 'x', purpose: 'Visit' } : {}),
  };
}

/** The values of a company for each path parameter (its own ids). */
function own(C) {
  return {
    orgId: C.id, rid: C.requests.pending.id, userId: C.people.employee.user.id, publicId: C.invite.invite.publicId, tier: 'standard', token: C.invite.token,
  };
}

/** Records that belong to a company (its org, everything with its orgId or in its scope), as one string (MemoryStore). */
function companySnapshot(x, C) {
  const rows = [...x.app.store.records.entries()].filter(([, r]) => (r.data && (r.data.orgId === C.id || (r.kind === KINDS.org && r.data.id === C.id))) || r.userId === C.id);
  return JSON.stringify(rows.sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function send(who, r, url, C) {
  return r.method === 'GET' ? who.get(url) : who.post(url, formFor(r, C));
}

/**
 * The headers of an answer, as comparable lines: the date and the redirect (compared on their own) left out, the
 * visitor cookie's random value and the limiter's remaining count written out, and (when the body repeats what
 * was sent, so the two bodies differ before the echo is written out) the entity tag and length written out.
 */
function headerLines(res, echoed = false) {
  const out = [];
  for (const [k, v] of res.headers) {
    if (k === 'date' || k === 'location') continue;
    let x = v;
    if (k === 'set-cookie') x = x.replace(/\btxv=[^;]*/g, 'txv=[visitor]');
    if (k === 'ratelimit') x = x.replace(/\bremaining=\d+/g, 'remaining=[n]').replace(/\breset=\d+/g, 'reset=[s]');
    if (echoed && (k === 'etag' || k === 'content-length')) x = '[echoed]';
    out.push(`${k}: ${x}`);
  }
  return out.sort();
}

/**
 * Send `url`, then the made-up one: same status, byte-identical body, the same headers and redirect, and (for any
 * method) nothing written. `echo` [sent, madeUp]: a token the answer may repeat back in a link to its own page
 * (/invite/<token>), written out of both.
 */
async function sameAsMadeUp(label, who, r, url, madeUpUrl, C, { status = null, echo = null, x = w } = {}) {
  const before = storeSnapshot(x.app);
  const sA = companySnapshot(x, x.A), sB = companySnapshot(x, x.B);
  const got = await send(who, r, url, C);
  const ref = await send(who, r, madeUpUrl, C);
  assert.equal(storeSnapshot(x.app), before, `${label}: nothing written`);
  assert.equal(companySnapshot(x, x.B), sB, `${label}: Globex unchanged`);
  assert.equal(companySnapshot(x, x.A), sA, `${label}: Acme unchanged`);
  if (status !== null) assert.equal(got.status, status, `${label}: ${got.status} ${textOf(got.text).slice(0, 200)}`);
  assert.equal(got.status, ref.status, `${label}: the same status as a made-up id`);
  const out = (v, i) => {
    if (!echo || typeof v !== 'string') return v;
    const said = echo[i];
    return v.split(`/invite/${encodeURIComponent(said)}`).join('/invite/[echo]').split(`/invite/${said}`).join('/invite/[echo]');
  };
  assert.equal(out(got.text, 0), out(ref.text, 1), `${label}: the same body as a made-up id`);
  assert.equal(out(got.location, 0), out(ref.location, 1), `${label}: the same redirect as a made-up id`);
  const echoed = got.text !== ref.text;
  assert.deepEqual(headerLines(got, echoed), headerLines(ref, echoed), `${label}: the same headers as a made-up id`);
  return got;
}

const htmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/**
 * A body with a submitted id written out (a form shows back what was typed; a link carries it encoded). Values
 * under four characters are left alone: written out, they would blank ordinary letters of the page.
 */
const withoutId = (s, id) => (typeof s !== 'string' || !id || String(id).length < 4 ? s
  : s.split(id).join('[id]').split(encodeURIComponent(id)).join('[id]').split(htmlEsc(id)).join('[id]').split(htmlEsc(encodeURIComponent(id))).join('[id]'));

/**
 * Compare two posts or gets that differ in one submitted id: the same status, page (with the id written out of
 * both), headers and redirect, and nothing written.
 */
async function alike(label, who, method, path, mk, foreignId, madeUpId, { status = null, app = w.app } = {}) {
  const before = storeSnapshot(app);
  const go = id => (method === 'GET' ? who.get(mk(id)) : who.post(path, mk(id)));
  const got = await go(foreignId);
  const ref = await go(madeUpId);
  assert.equal(storeSnapshot(app), before, `${label}: nothing written`);
  if (status !== null) assert.equal(got.status, status, `${label}: ${got.status} ${textOf(got.text).slice(0, 200)}`);
  assert.equal(got.status, ref.status, `${label}: the same status (${got.status} for ${String(foreignId).slice(0, 20)}, ${ref.status} for a made-up id)`);
  assert.equal(withoutId(got.text, foreignId), withoutId(ref.text, madeUpId), `${label}: the same page`);
  assert.equal(withoutId(got.location, foreignId), withoutId(ref.location, madeUpId), `${label}: the same redirect`);
  const echoed = got.text !== ref.text;
  assert.deepEqual(headerLines(got, echoed), headerLines(ref, echoed), `${label}: the same headers`);
  assert.doesNotMatch(withoutSwitcher(got.text), /Globex/, `${label}: nothing of Globex (but Pat's own switcher)`);
  return got;
}

// ---------------------------------------------------------------------------------------------------------
// Reading figures off pages

const STATUS_LABELS = Object.freeze({
  pending: 'Waiting for approval', approved: 'Approved to book', past: 'Past trip', denied: 'Denied', cancelled: 'Cancelled', expired: 'Expired', draft: 'Draft',
});
/** Each company's requests by effective status, as the world's header promises them. */
const SEEDED = Object.freeze({
  Acme: { requests: 18, pending: 3, approved: 5, past: 1, denied: 2, cancelled: 1, expired: 1, draft: 5 },
  Globex: { requests: 11, pending: 4, approved: 3, past: 0, denied: 0, cancelled: 1, expired: 1, draft: 2 },
});
const countsOf = C => {
  const n = { requests: 0, pending: 0, approved: 0, past: 0, denied: 0, cancelled: 0, expired: 0, draft: 0 };
  for (const s of Object.values(C.expected)) { n.requests += 1; n[s] += 1; }
  return n;
};
/** The seeded requests of a company with their key and effective status. */
const seeded = C => Object.entries(C.requests).map(([key, r]) => ({ key, r, status: C.expected[key] }));
const sum = rows => rows.reduce((s, x) => s + x.r.totalCents, 0);
/** "84.6%": a share in tenths of a percent, rounded half up, as the tiles print it. */
const percent = (n, of) => { const t = Math.round((n * 1000) / of); return `${t % 10 ? (t / 10).toFixed(1) : t / 10}%`; };
/** The text between two markers of a page (the first marker included), for reading one tile. */
function between(page, from, to) {
  const i = page.indexOf(from);
  assert.ok(i >= 0, `"${from}" on the page`);
  const j = page.indexOf(to, i + from.length);
  return page.slice(i, j < 0 ? undefined : j);
}
/** The tab labels with their counts: ['Waiting for you 3', 'Decided by you', ...]. */
const tabsOf = page => [...page.matchAll(/<a class="bz-tab"[^>]*>([\s\S]*?)<\/a>/g)].map(m => textOf(m[1]));
/** Every request id a page's <main> links to. */
const ridsOf = page => new Set([...mainOf(page).matchAll(/\/trips\/(btr_[A-Za-z0-9_-]{16})/g)].map(m => m[1]));
/** Pat's company switcher, written out (it rightly names both of Pat's companies). */
const withoutSwitcher = page => String(page).replace(/<details class="[^"]*\bbz-switch\b[^"]*"[\s\S]*?<\/details>/g, '');

// ---------------------------------------------------------------------------------------------------------

test('the tables: every ROUTES entry has the permission, own and caller of plan §B4, and roles.js gives each role the permissions of §D', () => {
  for (const r of ALL_ROUTES) {
    const want = ROUTE_PERMS[keyOf(r)];
    assert.ok(want, `${keyOf(r)} is in plan §B4`);
    assert.deepEqual([r.perm, r.own, r.who], want, keyOf(r));
  }
  assert.deepEqual(ALL_ROUTES.map(keyOf).sort(), Object.keys(ROUTE_PERMS).sort(), 'no route missing from or added to §B4');
  assert.deepEqual([...roles.PERMISSIONS].sort(), Object.keys(D).sort());
  for (const perm of Object.keys(D)) {
    for (const k of ROLE_KEYS) assert.equal(roles.can(ROLE_NAMES[k], perm), holds(k, perm), `${k} ${perm}`);
  }
});

test('each company\'s own figures: home tiles, approvals tabs, reports, budgets, CSV and its own policy in a search, all from its own seed', async () => {
  for (const C of [w.A, w.B]) {
    const n = countsOf(C);
    assert.deepEqual(n, SEEDED[C.word], `${C.name}: the seed made what it says`);
    const rows = seeded(C);
    const p = C.people;
    const sent = rows.filter(x => x.r.submittedAt);
    const out = sent.filter(x => ['out', 'blocked'].includes(x.r.evaluation.status)).length;

    // Home (the Owner): pending across the company and the out-of-policy share.
    const home = await p.owner.http.get(C.B);
    assert.equal(home.status, 200);
    const tile = title => textOf(between(home.text, `<p class="bz-tile-title">${title}</p>`, '</div>').replace(/<p class="bz-tile-title">[^<]*<\/p>/, ''));
    assert.equal(tile('Waiting for approval'), `${n.pending} Pending requests across ${C.name}`, `${C.name} home: waiting for approval`);
    assert.equal(tile('Outside policy, Q4 2026'), `${percent(out, sent.length)} ${out} of ${sent.length} requests`, `${C.name} home: outside policy`);

    // Approvals: the Manager's inbox, the Owner's company tab, the Manager's decided list.
    const mgr = p.manager.user.id, ownerId = p.owner.user.id;
    const waitingFor = me => rows.filter(x => x.status === 'pending' && x.r.travelerId !== me && x.r.approval && (x.r.approval.approverId === me || (x.r.approval.poolIds || []).includes(me))).length;
    const expiredFor = me => rows.filter(x => x.status === 'expired' && x.r.approval && x.r.approval.approverId === me).length;
    const mgrPage = await p.manager.http.get(`${C.B}/approvals`);
    assert.deepEqual(tabsOf(mgrPage.text), [`Waiting for you ${waitingFor(mgr)}`, 'Decided by you', `Expired ${expiredFor(mgr)}`], `${C.name} manager tabs`);
    assert.match(textOf((await p.manager.http.get(C.B)).text), new RegExp(`Waiting for you \\(${waitingFor(mgr)}\\)`), `${C.name} manager home`);
    const company = rows.filter(x => x.status === 'pending' && x.r.travelerId !== ownerId).length;
    const ownerPage = await p.owner.http.get(`${C.B}/approvals?tab=company`);
    assert.deepEqual(tabsOf(ownerPage.text), [`Waiting for you ${waitingFor(ownerId)}`, 'Decided by you', `Company ${company}`, `Expired ${expiredFor(ownerId)}`], `${C.name} owner tabs`);
    assert.deepEqual([...ridsOf(ownerPage.text)].sort(), rows.filter(x => x.status === 'pending' && x.r.travelerId !== ownerId).map(x => x.r.id).sort(), `${C.name} company tab rows`);
    const decided = await p.manager.http.get(`${C.B}/approvals?tab=decided`);
    assert.deepEqual([...ridsOf(decided.text)].sort(), rows.filter(x => x.r.approval && x.r.approval.decidedBy && x.r.approval.decidedBy.userId === mgr).map(x => x.r.id).sort(), `${C.name} decided rows`);

    // Reports (Finance): requests by status, the out-of-policy share, committed vs budget, saved by switching.
    const rep = await p.finance.http.get(`${C.B}/reports?period=2026-Q4`);
    assert.equal(rep.status, 200);
    const byStatus = Object.fromEntries([...between(rep.text, 'Requests by status', 'Out-of-policy share').matchAll(/<li>([^<:]+): <b>(\d+)<\/b><\/li>/g)].map(m => [m[1], Number(m[2])]));
    assert.deepEqual(byStatus, Object.fromEntries(Object.entries(STATUS_LABELS).filter(([s]) => n[s]).map(([s, l]) => [l, n[s]])), `${C.name} requests by status`);
    assert.match(textOf(rep.text), new RegExp(`${escRe(percent(out, sent.length))} ${out} of ${sent.length} sent requests were outside the policy or blocked\\.`), `${C.name} reports share`);
    const saved = rows.filter(x => x.r.status === 'approved').reduce((s, x) => s + Math.max(0, (x.r.history || []).filter(h => h.action === 'swapped').reduce((t, h) => t + h.savedCents, 0)), 0);
    const repText = textOf(rep.text);
    if (saved > 0) assert.match(repText, new RegExp(`Saved by switching to cheaper options ${escRe(money(saved))} On approved trips`), `${C.name} saved by switching`);
    else assert.match(repText, /Saved by switching to cheaper options Nothing saved by switching yet\./, `${C.name} saved by switching`);
    assert.equal(C.word === 'Acme', saved > 0, 'only Acme has a swapped, approved trip');

    // Budgets (Finance): every department's budget, committed, awaiting and remaining.
    const bud = await p.finance.http.get(`${C.B}/budgets?period=2026-Q4`);
    const tableRows = (bud.text.match(/<tr>[\s\S]*?<\/tr>/g) || []).map(textOf);
    for (const [i, dep] of [[0, C.deps[0]], [1, C.deps[1]], [null, C.general]]) {
      const mine = rows.filter(x => x.r.departmentId === dep.id);
      const committed = sum(mine.filter(x => x.r.status === 'approved'));
      const awaiting = sum(mine.filter(x => x.status === 'pending'));
      const amount = i === null ? null : Number(C.shape.budgets[i]) * 100;
      const want = amount === null
        ? `Department ${dep.name} Budget No budget set Committed ${money(committed)} Awaiting approval ${money(awaiting)} Remaining No budget set`
        : `Department ${dep.name} Budget ${money(amount)} Committed ${money(committed)} Awaiting approval ${money(awaiting)} Remaining ${money(amount - committed)}`;
      assert.ok(tableRows.includes(want), `${C.name} budgets row: ${want}\n${tableRows.join('\n')}`);
      if (amount !== null) assert.match(textOf(rep.text), new RegExp(`${escRe(dep.name)} ${escRe(money(committed))} committed and ${escRe(money(awaiting))} awaiting approval, of ${escRe(money(amount))}`), `${C.name} reports committed vs budget`);
    }
    assert.equal(tableRows.length, 4, `${C.name}: a header and three departments`);

    // The CSV: one row per request of the company, and exactly its requests.
    const csv = await p.finance.http.post(`${C.B}/reports/export`, { period: '2026-Q4' });
    assert.equal(csv.status, 200);
    const lines = csv.text.trim().split('\n');
    assert.equal(lines.length - 1, n.requests, `${C.name} CSV rows`);
    assert.deepEqual([...new Set(lines.slice(1).map(l => (l.match(/(?<![\w-])btr_[A-Za-z0-9_-]{16}(?![\w-])/) || [''])[0]))].sort(), rows.map(x => x.r.id).sort(), `${C.name} CSV request ids`);

    // A search shows the company's own Standard policy: its version and its London limit.
    const sr = await p.employee.http.get(`${C.B}/trips/search?${new URLSearchParams(Q)}`);
    assert.equal(sr.status, 200);
    assert.match(sr.text, new RegExp(`Your limits for this search \\(Standard policy, v${C.shape.policyVersion}\\)`), `${C.name} search policy version`);
    assert.match(textOf(sr.text), new RegExp(`Hotels in London: up to \\$${C.word === 'Globex' ? '280' : '300'}\\b`), `${C.name} search London limit`);
    const pol = textOf(mainOf((await p.employee.http.get(`${C.B}/policy`)).text));
    assert.match(pol, new RegExp(`Standard policy, version ${C.shape.policyVersion}`));
    assert.match(pol, new RegExp(`London \\$${C.word === 'Globex' ? '280' : '300'}\\)`));
    assert.equal(/Book hotels at least 2 days ahead\./.test(pol), C.word === 'Globex', `${C.name}: hotels two days ahead is Globex's rule only`);
  }
});

test('Pat Both, a member of both: links, lists, inbox, home, activity and export in each company hold only that company\'s records', async () => {
  const { A, B, both, svc } = w;
  const repo = svc.repo;
  const pat = both.user.id;
  // The member-scope links: both loaded, disjoint, each only its own company's requests.
  const links = {};
  for (const C of [A, B]) {
    links[C.word] = await repo.list(KINDS.reqLink, memberScope(C.id, pat));
    for (const l of links[C.word]) {
      assert.equal(l.orgId, C.id, `a link of ${C.name}`);
      assert.ok(await repo.getIn(KINDS.request, l.requestId, C.id), `${l.requestId} is ${C.name}'s`);
      assert.equal(await repo.getIn(KINDS.request, l.requestId, C === A ? B.id : A.id), null);
    }
  }
  const ids = word => [...new Set(links[word].map(l => l.requestId))].sort();
  assert.deepEqual(ids('Acme'), [A.requests.patOver.id, A.requests.patPending.id].sort(), 'Pat\'s Acme links: his two Acme trips');
  assert.deepEqual(ids('Globex'), [B.requests.patGlobex.id, B.requests.finPending.id, B.requests.finApproved.id].sort(), 'Pat\'s Globex links: his trip and the two he decides');
  assert.equal(ids('Acme').filter(id => ids('Globex').includes(id)).length, 0, 'disjoint');

  // His trips, team trips, inbox and home in each company.
  const mineA = await both.http.get(`${A.B}/trips`);
  assert.deepEqual([...ridsOf(mineA.text)].sort(), [A.requests.patOver.id, A.requests.patPending.id].sort(), 'Pat\'s Acme trips');
  const mineB = await both.http.get(`${B.B}/trips`);
  assert.deepEqual([...ridsOf(mineB.text)].sort(), [B.requests.patGlobex.id], 'Pat\'s Globex trips');
  assert.equal((await both.http.get(`${A.B}/trips?scope=team`)).status, 403, 'an Acme Employee has no team list');
  const teamWant = Object.values(B.requests).filter(r => r.travelerId === pat || (r.approval && r.approval.approverId === pat) || r.travelerManagerId === pat).map(r => r.id).sort();
  assert.deepEqual([...ridsOf((await both.http.get(`${B.B}/trips?scope=team`)).text)].sort(), teamWant, 'Pat\'s Globex team trips');
  assert.equal((await both.http.get(`${A.B}/approvals`)).status, 403, 'an Acme Employee has no inbox');
  const inbox = await both.http.get(`${B.B}/approvals`);
  assert.deepEqual(tabsOf(inbox.text), ['Waiting for you 1', 'Decided by you', 'Expired 0']);
  assert.deepEqual([...ridsOf(inbox.text)], [B.requests.finPending.id]);
  assert.deepEqual([...ridsOf((await both.http.get(`${B.B}/approvals?tab=decided`)).text)], [B.requests.finApproved.id]);
  assert.match(textOf((await both.http.get(B.B)).text), /Waiting for you \(1\)/);
  assert.doesNotMatch(textOf((await both.http.get(A.B)).text), /Waiting for you/);

  // Each join is logged in its own company only, and each export holds Pat's own membership there.
  for (const [C, mine, theirs] of [[A, 'Employee', 'Manager'], [B, 'Manager', 'Employee']]) {
    const act = textOf((await C.people.owner.http.get(`${C.B}/activity?group=member`)).text);
    assert.match(act, new RegExp(`Pat Both joined as ${mine}`), `${C.name} logs Pat's join`);
    assert.doesNotMatch(act, new RegExp(`joined as ${theirs}`), `${C.name} logs no other company's join`);
    const data = JSON.parse((await C.people.owner.http.post(`${C.B}/settings/export`, {})).text);
    const m = data.members.filter(x => x.userId === pat);
    assert.deepEqual(m.map(x => [x.orgId, x.role]), [[C.id, ROLE_NAMES[mine === 'Employee' ? 'employee' : 'manager']]]);
    for (const r of data.requests) assert.equal(r.orgId, C.id);
  }

  // Every page Pat reaches in one company holds nothing of the other (the switcher, which rightly names both
  // companies, written out), and nothing of anyone's consumer records.
  for (const [C, other] of [[A, B], [B, A]]) {
    const seen = await crawl(both.http, [C.B, `${C.B}/trips`, `${C.B}/trips?scope=team`, `${C.B}/approvals`, `${C.B}/approvals?tab=decided`, `${C.B}/approvals?tab=expired`, `${C.B}/settings`], { prefix: C.B });
    let pages = 0;
    for (const [url, res] of seen) {
      assertNoTrace(`Pat in ${C.name} ${url}`, withoutSwitcher(res.text), other);
      assertNoPersonal(`Pat in ${C.name} ${url}`, res.text);
      pages += 1;
    }
    assert.ok(pages >= 10, `${pages} pages of Pat's ${C.name} workspace`);
    for (const id of Object.values(other.requests).map(r => r.id)) assert.ok(!seen.has(`${C.B}/trips/${id}`), `${id} reached in ${C.name}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The Repo choke point, on any store

/** Every record of the world's companies and people: { kind, id, userId, data }. */
async function recordsOf(x) {
  const s = x.app.store;
  if (s.kind === 'memory') return [...s.records.values()].map(r => ({ kind: r.kind, id: r.id, userId: r.userId, data: r.data }));
  const users = [...new Set([x.A, x.B].flatMap(C => Object.values(C.people).map(p => p.user.id)).concat(x.both.user.id, x.ops.user.id))];
  const orgIds = [x.A.id, x.B.id];
  const scopes = [...orgIds, ...orgIds.flatMap(o => users.map(u => memberScope(o, u))), ...users];
  const { rows } = await s.pool.query('SELECT kind, id, user_id, data FROM tx_records WHERE user_id = ANY($1) OR (kind = $2 AND id = ANY($3))', [scopes, KINDS.org, orgIds]);
  return rows.map(r => ({ kind: r.kind, id: r.id, userId: r.user_id, data: r.data }));
}

async function repoChecks(x) {
  const repo = new Repo({ store: x.app.store, now: x.app.ctx.now });
  const { A, B } = x;
  // Unscoped or malformed owner scopes never list anything.
  for (const scope of ['', null, undefined, 'org_short', 'prp_AAAAAAAAAAAAAAAA', `${A.id} `, 'ORG_AAAAAAAAAAAAAAAA', 42]) {
    await assert.rejects(repo.list(KINDS.request, scope), /unscoped or malformed owner/, String(scope));
    await assert.rejects(repo.page(KINDS.request, scope), /unscoped or malformed owner/, String(scope));
  }
  // Personal kinds are refused for every read, so Business can't reach accounts, sessions or trips.
  for (const kind of ['user', 'user_email', 'session', 'booking', 'quote', 'payment_intent', 'saved', 'watch', 'hunt', 'travel_defaults', 'last_search', 'recent_trip', 'trip_request', 'outbox', 'platform_admin', 'BIZ_org', '']) {
    await assert.rejects(repo.get(kind, A.people.owner.user.id), /bad record kind/, kind);
    await assert.rejects(repo.getIn(kind, A.people.owner.user.id, A.id), /bad record kind/, kind);
    await assert.rejects(repo.list(kind, A.id), /bad record kind/, kind);
    await assert.rejects(repo.page(kind, A.id), /bad record kind/, kind);
  }
  // Every Globex record is invisible through getIn for Acme (and the other way round); each reads through its own.
  const rows = (await recordsOf(x)).filter(r => r.kind.startsWith('biz_'));
  let checked = 0;
  for (const r of rows) {
    const orgOf = r.kind === KINDS.org ? r.data.id : r.data.orgId;
    if (orgOf !== A.id && orgOf !== B.id) continue;
    const other = orgOf === A.id ? B.id : A.id;
    assert.equal(await repo.getIn(r.kind, r.id, other), null, `${r.kind} ${r.id} through the other company`);
    assert.deepEqual(await repo.getIn(r.kind, r.id, orgOf), r.data, `${r.kind} ${r.id} through its own company`);
    checked += 1;
  }
  assert.ok(checked > 100, `${checked} records checked`);
  // Every list holds its own company's rows only, page after page.
  for (const kind of Object.values(KINDS).filter(k => k !== KINDS.org && k !== KINDS.userIndex && k !== KINDS.reqLink && k !== KINDS.inviteEmail)) {
    for (const C of [A, B]) {
      let cursor = null, n = 0;
      do {
        const page = await repo.page(kind, C.id, { limit: 7, cursor });
        for (const row of page.rows) assert.equal(row.orgId, C.id, `${kind} listed under ${C.name}`);
        n += page.rows.length;
        cursor = page.cursor;
      } while (cursor);
      assert.equal(n, rows.filter(r => r.kind === kind && r.userId === C.id).length, `${kind} of ${C.name}: every row, paged`);
    }
  }
  // Link records live under a per-company member scope: Pat Both's links in Acme are not his links in Globex.
  const patA = memberScope(A.id, x.both.user.id), patB = memberScope(B.id, x.both.user.id);
  assert.notEqual(patA, patB);
  for (const [scope, C, min] of [[patA, A, 2], [patB, B, 3], [memberScope(A.id, A.people.manager.user.id), A, 3], [memberScope(B.id, B.people.manager.user.id), B, 3]]) {
    const list = await repo.list(KINDS.reqLink, scope);
    assert.ok(list.length >= min, `${list.length} links in ${C.name}`);
    for (const row of list) assert.equal(row.orgId, C.id, 'a link of the same company');
  }
  // A cursor is tied to its kind and scope: Globex's cursors on Acme lists are 404s, as damaged ones are.
  const foreign = [
    (await repo.page(KINDS.audit, B.id, { limit: 1 })).cursor,
    (await repo.page(KINDS.request, B.id, { limit: 1 })).cursor,
    (await repo.page(KINDS.reqLink, patB, { limit: 1 })).cursor,
  ];
  for (const c of foreign) assert.ok(c, 'a Globex cursor');
  for (const [kind, scope] of [[KINDS.audit, A.id], [KINDS.request, A.id], [KINDS.reqLink, patA]]) {
    for (const cursor of [...foreign, `${foreign[0]}x`, 'abc.def', 'x'.repeat(700)]) {
      await assert.rejects(repo.page(kind, scope, { cursor }), e => e instanceof AppError && e.status === 404, `${kind} ${cursor.slice(0, 30)}`);
    }
  }
  // A write must name its owner scope (only biz_org has none), and never a falsy one.
  for (const owner of [null, '', undefined, 'prp_AAAAAAAAAAAAAAAA']) {
    await assert.rejects(repo.insert(KINDS.department, 'dep_NEWNEWNEWNEWNEWN', { orgId: A.id, name: 'X' }, { owner }), /unscoped or malformed owner/, String(owner));
  }
}

test('repo: the choke point refuses unscoped reads, personal kinds, another company\'s records and its cursors (MemoryStore)', async () => {
  const before = storeSnapshot(w.app);
  await repoChecks(w);
  assert.equal(storeSnapshot(w.app), before, 'reads wrote nothing');
});

test('service: every method refuses an actor naming a company the user is not in (404), and Globex ids through an Acme actor', async () => {
  const { A, B, svc } = w;
  const before = storeSnapshot(w.app);
  // Acme's owner, claiming Globex.
  const forged = { org: { id: B.id }, user: A.people.owner.user };
  const ARGS = {
    getOrg: [], listMembers: [{}], invite: [{ email: 'x@example.com', role: 'employee' }], revokeInvite: [B.invite.invite.publicId],
    updateMember: [B.people.employee.user.id, { role: 'employee', rev: '0' }], removeMember: [B.people.employee.user.id, { rev: '0' }],
    saveDepartment: [{ name: 'X' }], listDepartments: [], saveSettings: [{ rev: '0', name: 'X' }], exportCompany: [], listAudit: [{}],
    getPolicy: ['standard'], savePolicy: ['standard', { form: {}, rev: '0', note: '' }], policyHistory: ['standard', {}],
    listBudgets: ['2026-Q4'], setBudget: [B.deps[0].id, '2026-Q4', null, '1'], searchTrip: [{}], createRequest: [{ query: {}, selection: {}, purpose: 'x' }],
    getRequest: [B.requests.pending.id], listRequests: [{ scope: 'all' }], swap: [B.requests.returned.id, { altId: 'x', rev: '0' }],
    submit: [B.requests.draft.id, { rev: '0' }], cancel: [B.requests.pending.id, { rev: '0' }], decide: [B.requests.pending.id, { action: 'approve', rev: '0' }],
    message: [B.requests.pending.id, { text: 'Hello there' }], inbox: [{ tab: 'waiting' }], inboxCount: [], liveCheck: [B.requests.pending.id],
    dashboard: [{ view: 'home' }], exportCsv: [{}],
  };
  const SKIP = new Set(['createCompany', 'listCompaniesFor', 'membership', 'inviteByToken', 'acceptInvite', 'platformListOrgs', 'platformSetStatus']);
  for (const name of SERVICE_METHODS) {
    if (SKIP.has(name)) continue;
    assert.ok(ARGS[name], `arguments for ${name}`);
    await assert.rejects(svc[name](forged, ...ARGS[name]), e => e instanceof AppError && e.status === 404 && e.code === 'not_found', name);
  }
  // Pat Both, naming Acme, still can't reach a Globex request through it.
  await assert.rejects(svc.getRequest(w.both.actorA, B.requests.finPending.id), e => e instanceof AppError && e.status === 404);
  await assert.rejects(svc.decide(w.both.actorA, B.requests.finPending.id, { action: 'approve', note: '', rev: '0' }), e => e instanceof AppError && (e.status === 404 || e.status === 403));
  // The company switcher and membership answer only the user's own companies.
  assert.deepEqual((await svc.listCompaniesFor(A.people.owner.actor)).map(c => c.id), [A.id]);
  assert.equal(await svc.membership({ user: A.people.owner.user }, B.id), null);
  assert.deepEqual((await svc.listCompaniesFor(w.both.actorA)).map(c => c.id).sort(), [A.id, B.id].sort());
  // Acme's own actors with Globex ids: the record does not exist for them.
  const a = A.people;
  const notFound = p => assert.rejects(p, e => e instanceof AppError && e.status === 404);
  for (const rid of Object.values(B.requests).map(r => r.id)) {
    await notFound(svc.getRequest(a.owner.actor, rid));
    await notFound(svc.liveCheck(a.owner.actor, rid));
    await notFound(svc.cancel(a.owner.actor, rid, { rev: '0' }));
    await notFound(svc.decide(a.manager.actor, rid, { action: 'deny', note: 'Not this one, sorry.', rev: '0' }));
    await notFound(svc.message(a.manager.actor, rid, { text: 'Hello there' }));
    await notFound(svc.submit(a.employee.actor, rid, { rev: '0', reason: REASON, category: 'other' }));
    await notFound(svc.swap(a.employee.actor, rid, { altId: 'x', rev: '0' }));
  }
  await notFound(svc.updateMember(a.owner.actor, B.people.employee.user.id, { role: 'employee', rev: '0' }));
  await notFound(svc.removeMember(a.owner.actor, B.people.employee.user.id, { rev: '0' }));
  await notFound(svc.revokeInvite(a.owner.actor, B.invite.invite.publicId));
  await notFound(svc.setBudget(a.finance.actor, B.deps[0].id, '2026-Q4', null, '100'));
  await notFound(svc.saveDepartment(a.owner.actor, { departmentId: B.deps[0].id, name: 'Renamed', rev: '0' }));
  await notFound(svc.saveDepartment(a.owner.actor, { departmentId: B.deps[0].id, archive: true, rev: '0' }));
  assert.equal(storeSnapshot(w.app), before, 'nothing was written');
});

// ---------------------------------------------------------------------------------------------------------
// The walk

test('routes: as every Globex role (and as the platform admin), every Acme workspace route answers the plain 404 a made-up company gets, and writes nothing', async () => {
  const { A, B, ops } = w;
  const orgRoutes = ALL_ROUTES.filter(r => r.path.startsWith('/o/:orgId'));
  assert.ok(orgRoutes.length >= 30, `${orgRoutes.length} workspace routes`);
  const actors = [...Object.entries(B.people).map(([k, p]) => [`Globex ${k}`, p.http]), ['platform admin', ops.http]];
  for (const r of orgRoutes) {
    for (const [label, who] of actors) {
      const values = { ...own(A) };
      const got = await sameAsMadeUp(`${label} ${r.method} ${r.path}`, who, r, urlOf(r, values), urlOf(r, { ...values, orgId: MADE_UP.orgId }), A, { status: 404 });
      assert.doesNotMatch(got.text, /Acme|bz-app/, `${label} ${r.path}: the plain page, nothing of Acme`);
      for (const bad of MALFORMED.slice(0, label === 'Globex owner' ? MALFORMED.length : 3)) {
        await sameAsMadeUp(`${label} ${r.method} ${r.path} org=${bad.slice(0, 12)}`, who, r, urlOf(r, { ...values, orgId: bad }), urlOf(r, { ...values, orgId: MADE_UP.orgId }), A, { status: 404 });
      }
      // Acme's ids under Globex's own company (Globex's members only): the record is not Globex's.
      if (label.startsWith('Globex') && paramsOf(r).some(p => p !== 'orgId' && p !== 'tier')) {
        const p = B.people[label.split(' ')[1]];
        const mixed = { ...own(A), orgId: B.id };
        const madeUp = { ...mixed };
        for (const k of paramsOf(r)) if (k !== 'orgId' && k !== 'tier') madeUp[k] = MADE_UP[k];
        await sameAsMadeUp(`${label} ${r.method} ${r.path} with Acme ids`, p.http, r, urlOf(r, mixed), urlOf(r, madeUp), B);
      }
    }
    // Pat Both, who is in both: Globex's request ids in Acme paths answer as made-up ones (his Acme role decides
    // 403 or 404, the same for both).
    if (paramsOf(r).includes('rid')) {
      for (const rid of [w.B.requests.finPending.id, w.B.requests.patGlobex.id]) {
        await sameAsMadeUp(`Pat ${r.method} ${r.path} Globex rid in Acme`, w.both.http, r, urlOf(r, { ...own(A), rid }), urlOf(r, { ...own(A), rid: MADE_UP.rid }), A);
      }
    }
    // A broken escape is the same 400 for a real and a made-up company.
    const esc = urlOf(r, { ...own(A), orgId: `${A.id}${BAD_ESCAPE}` });
    const escRef = urlOf(r, { ...own(A), orgId: `${MADE_UP.orgId}${BAD_ESCAPE}` });
    await sameAsMadeUp(`bad escape ${r.method} ${r.path}`, B.people.owner.http, r, esc, escRef, A, { status: 400 });
    // Signed out: the same redirect to the company sign-in, whatever the company.
    const anon = w.http('');
    const so = await send(anon, r, urlOf(r, own(A)), A);
    const soRef = await send(anon, r, urlOf(r, { ...own(A), orgId: MADE_UP.orgId }), A);
    assert.equal(so.status, 303, `signed out ${r.path}`);
    assert.equal(so.location.replace(A.id, MADE_UP.orgId), soRef.location, `signed out ${r.path}: the same redirect`);
    visited.add(keyOf(r));
  }
});

test('routes: as every Acme role, Globex request, member and invite ids (and made-up and malformed ones) in Acme paths answer alike (403 for a role §D refuses, else 404) and write nothing', async () => {
  const { A, B } = w;
  const withIds = ALL_ROUTES.filter(r => r.path.startsWith('/o/:orgId') && paramsOf(r).length > 1);
  assert.ok(withIds.length >= 12, `${withIds.length} routes with ids`);
  const FOREIGN = {
    rid: Object.values(B.requests).map(x => x.id),
    userId: [B.people.employee.user.id, B.people.manager.user.id, B.people.owner.user.id],
    publicId: [B.invite.invite.publicId],
    tier: [],
  };
  let checked = 0;
  for (const r of withIds) {
    for (const [role, p] of Object.entries(A.people)) {
      for (const param of paramsOf(r).filter(k => k !== 'orgId')) {
        const base = { ...own(A) };
        const madeUpUrl = urlOf(r, { ...base, [param]: MADE_UP[param] });
        const status = holdsAny(role, permOf(r)) ? 404 : 403;
        for (const id of FOREIGN[param]) {
          await sameAsMadeUp(`Acme ${role} ${r.method} ${r.path} Globex ${param}`, p.http, r, urlOf(r, { ...base, [param]: id }), madeUpUrl, A, { status });
          checked += 1;
        }
        for (const bad of MALFORMED) {
          await sameAsMadeUp(`Acme ${role} ${r.method} ${r.path} ${param}=${bad.slice(0, 12)}`, p.http, r, urlOf(r, { ...base, [param]: bad }), madeUpUrl, A, { status });
          checked += 1;
        }
      }
    }
    visited.add(keyOf(r));
  }
  assert.ok(checked > 500, `${checked} requests compared`);
});

test('routes: public and platform routes: made-up and malformed tokens and ids answer alike, write nothing, show no company to a stranger, and the other company\'s real invite token is refused', async () => {
  const { A, B, ops } = w;
  const rest = ALL_ROUTES.filter(r => !r.path.startsWith('/o/:orgId'));
  for (const r of rest) {
    const params = paramsOf(r);
    const label = keyOf(r);
    if (params.includes('token')) {
      // An invite token is a secret link: a made-up one and a malformed one are the same "can't be used" page, for
      // a stranger and for members of either company.
      for (const [who, name] of [[w.http(''), 'signed out'], [A.people.owner.http, 'Acme owner'], [B.people.employee.http, 'Globex employee']]) {
        if (r.who === 'user' && name === 'signed out') {
          const res = await send(who, r, urlOf(r, { token: MADE_UP.token }), A);
          assert.equal(res.status, 303, `${label} signed out`);
          continue;
        }
        for (const bad of [...MALFORMED, tokens.newToken()]) {
          await sameAsMadeUp(`${label} ${name} token=${bad.slice(0, 12)}`, who, r, urlOf(r, { token: bad }), urlOf(r, { token: MADE_UP.token }), A, { echo: [bad, MADE_UP.token] });
        }
      }
    } else if (params.includes('orgId')) {
      // The platform status change: only for a platform admin, whose made-up and malformed company ids answer alike.
      for (const bad of MALFORMED) {
        await sameAsMadeUp(`${label} platform admin orgId=${bad.slice(0, 12)}`, ops.http, r, urlOf(r, { orgId: bad }), urlOf(r, { orgId: MADE_UP.orgId }), A, { status: 404 });
      }
      // Members of either company (even owners) get the plain 404 for a real company, as for a made-up one.
      for (const p of [A.people.owner, B.people.owner, A.people.admin, w.both]) {
        for (const C of [A, B]) await sameAsMadeUp(`${label} member on ${C.name}`, p.http, r, urlOf(r, { orgId: C.id }), urlOf(r, { orgId: MADE_UP.orgId }), C, { status: 404 });
      }
    } else if (r.mount === businessPlatform.MOUNT) {
      // The company list is for platform admins only: everyone else gets the plain 404, with no company in it.
      for (const p of [A.people.owner, B.people.owner, w.both]) {
        const res = await p.http.get(urlOf(r, {}));
        const ref = await p.http.get('/admin/no-such-page');
        assert.equal(res.status, 404, `${label} as a member`);
        assert.equal(res.text, ref.text, `${label}: the plain 404`);
        assert.doesNotMatch(res.text, /Acme Inc|Globex Ltd|org_/, `${label}: no company named`);
      }
    } else if (r.method === 'GET') {
      // Pages with no ids: signed in as Globex, nothing of Acme (and the other way round).
      for (const [p, other] of [[B.people.employee, /Acme|acme[-.]/], [A.people.employee, /Globex|globex[-.]/]]) {
        const res = await p.http.get(urlOf(r, {}));
        assert.ok([200, 303].includes(res.status), `${label}: ${res.status}`);
        assert.doesNotMatch(res.text, other, `${label}: nothing of the other company`);
        if (res.status === 303) assert.ok(!/org_/.test(res.location) || res.location.includes(p === B.people.employee ? B.id : A.id), `${label}: redirect to the own company`);
      }
    } else if (r.path === '/signout') {
      const throwaway = await seedUser(w.app, { name: 'Tess Throwaway' });
      const res = await w.http(throwaway.cookie).post(urlOf(r, {}), {});
      assert.equal(res.status, 303, label);
    } else {
      // POST /start and /signin with forms that are refused: no company is created, nothing is written, and
      // the answer names neither company.
      const before = storeSnapshot(w.app);
      for (const p of [A.people.owner, B.people.owner]) {
        const res = await p.http.post(urlOf(r, {}), r.path === '/start' ? { companyName: 'Globex Ltd', size: '1-10 people' } : { email: B.people.owner.user.email, password: 'not the password' });
        assert.ok(res.status >= 400 && res.status < 500, `${label}: ${res.status}`);
        assert.doesNotMatch(textOf(res.text).replace(/Globex Ltd/g, r.path === '/start' ? '' : 'Globex Ltd'), p === A.people.owner ? /Globex/ : /Acme/, `${label}: nothing of the other company`);
      }
      assert.equal(storeSnapshot(w.app), before, `${label}: nothing written`);
    }
    visited.add(keyOf(r));
  }

  // Acme's real, pending invite in the hands of Globex members: accept is refused, join while signed in goes
  // back to the invite page, and neither joins anyone or writes anything.
  const before = storeSnapshot(w.app);
  for (const p of [B.people.employee, B.people.owner, w.both]) {
    const acc = await p.http.post(`/business/invite/${A.invite.token}/accept`, {});
    assert.equal(acc.status, 403, `accept as ${p.user.name}: ${acc.status} ${textOf(mainOf(acc.text)).slice(0, 160)}`);
    assert.doesNotMatch(acc.text, /new\.hire@/, 'the invited email is never shown in full');
    const join = await p.http.post(`/business/invite/${A.invite.token}/join`, { name: 'Gina Globex', password: 'correct horse battery staple' });
    assert.equal(join.status, 303, `join as ${p.user.name}`);
    assert.equal(join.location, `/business/invite/${A.invite.token}`, 'back to the invite page');
  }
  assert.equal(storeSnapshot(w.app), before, 'nothing written by the refused invite');
  assert.equal(await w.svc.membership({ user: B.people.employee.user }, A.id), null);
});

test('forms and query strings: Globex (and malformed) department, traveler, manager, approver, alternative, cursor and policy-version values in Acme forms answer as made-up ones do, and write nothing', async () => {
  const { A, B } = w;
  const a = A.people;
  const fb = B.deps[0].id, fu = B.people.employee.user.id, fm = B.people.manager.user.id;
  const B0 = A.B;
  const emp = A.people.employee.member;
  /**
   * One field: Globex's value answers exactly as a made-up one. Each malformed value is refused too and writes
   * nothing: as the made-up value is, or, where a filter or form checks the shape first, with its own 422 field
   * message (a shape no company's id has, so the answer can't depend on any company). A value that is only spaces
   * is a blank field, which means "none" (no department, no manager; a department form with no id adds one), so
   * it is not an id at all and is left out here.
   */
  async function field(label, who, method, path, mk, foreign, madeUp, opts = {}) {
    const ref = await alike(label, who, method, path, mk, foreign, madeUp, opts);
    for (const bad of MALFORMED_RAW.filter(v => v.trim())) {
      const l = `${label} (malformed ${JSON.stringify(bad.slice(0, 12))})`;
      const before = storeSnapshot(w.app);
      const got = method === 'GET' ? await who.get(mk(bad)) : await who.post(path, mk(bad));
      assert.equal(storeSnapshot(w.app), before, `${l}: nothing written`);
      assert.doesNotMatch(withoutSwitcher(got.text), /Globex|globex[-.]/, `${l}: nothing of Globex`);
      if (got.status === 422 && ref.status !== 422) continue;
      await alike(l, who, method, path, mk, bad, madeUp);
    }
  }
  // Budgets and departments.
  await field('budget for a Globex department', a.finance.http, 'POST', `${B0}/budgets`, id => ({ departmentId: id, period: '2026-Q4', amount: '100', rev: '' }), fb, MADE_UP.departmentId, { status: 404 });
  await field('rename a Globex department', a.owner.http, 'POST', `${B0}/departments`, id => ({ departmentId: id, name: 'Renamed Team', rev: '0' }), fb, MADE_UP.departmentId, { status: 404 });
  await field('archive a Globex department', a.owner.http, 'POST', `${B0}/departments`, id => ({ departmentId: id, archive: '1', rev: '0' }), fb, MADE_UP.departmentId, { status: 404 });
  // Invites and member changes naming Globex departments and people.
  for (const f of ['departmentId', 'managerId', 'approverId']) {
    const foreign = f === 'departmentId' ? fb : fm;
    const madeUp = f === 'departmentId' ? MADE_UP.departmentId : MADE_UP.userId;
    await field(`invite with a Globex ${f}`, a.owner.http, 'POST', `${B0}/people/invite`, id => ({ email: 'new.person@acme.example', role: 'employee', tier: 'standard', [f]: id }), foreign, madeUp);
    await field(`member change with a Globex ${f}`, a.owner.http, 'POST', `${B0}/people/${A.people.employee.user.id}`,
      id => ({ role: 'employee', tier: 'standard', departmentId: emp.departmentId || '', managerId: A.people.manager.user.id, approverId: '', rev: String(emp.rev), [f]: id }), foreign, madeUp);
  }
  // Reports, the CSV and the trip list filtered on Globex departments and travelers.
  for (const [f, foreign, madeUp] of [['departmentId', fb, MADE_UP.departmentId], ['travelerId', fu, MADE_UP.userId]]) {
    await field(`reports filtered on a Globex ${f}`, a.finance.http, 'GET', null, id => `${B0}/reports?period=2026-Q4&${f}=${encodeURIComponent(id)}`, foreign, madeUp, { status: 404 });
    await field(`CSV filtered on a Globex ${f}`, a.finance.http, 'POST', `${B0}/reports/export`, id => ({ period: '2026-Q4', [f]: id }), foreign, madeUp, { status: 404 });
    await field(`trips filtered on a Globex ${f}`, a.owner.http, 'GET', null, id => `${B0}/trips?scope=all&${f}=${encodeURIComponent(id)}`, foreign, madeUp);
  }
  // A swap to an alternative of a Globex request, on Acme's own returned draft. Alternative ids come from the
  // inventory (the same trip gives the same ids in any company), so the Globex draft is for other dates: its
  // alternatives are none of Acme's.
  const mine = A.requests.returned;
  const bq = { ...BQ, depart: '2026-12-14', return: '2026-12-18' };
  const sv = await w.svc.searchTrip(B.people.employee.actor, bq);
  const pick = leg => (sv.legs[leg].rows.some(r => r.row.available && r.row.carrier.code === 'ZM') ? r => r.row.available && r.row.carrier.code === 'ZM' : r => r.row.available && r.evaluation.status !== 'blocked');
  const bDraft = await w.svc.createRequest(B.people.employee.actor, {
    query: bq, purpose: 'Globex later launch',
    selection: { out: keyWhere(sv, 'out', pick('out')), back: keyWhere(sv, 'back', pick('back')), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5) },
  });
  const acmeAlts = new Set((mine.alternatives || []).map(x => x.id));
  const bAlt = (bDraft.alternatives || []).find(x => !acmeAlts.has(x.id));
  assert.ok(bAlt, 'the Globex draft has an alternative Acme\'s draft does not');
  const cur = await w.svc.getRequest(a.employee.actor, mine.id);
  await field('swap to a Globex alternative', a.employee.http, 'POST', `${B0}/trips/${mine.id}/swap`, id => ({ altId: id, rev: String(cur.request.rev) }), bAlt.id, MADE_UP.altId);

  // Cursors from Globex's lists (and its members' link lists) on Acme's pages: each a 404 like a made-up cursor.
  const repo = w.svc.repo;
  const cursors = {
    activity: (await repo.page(KINDS.audit, B.id, { limit: 1 })).cursor,
    trips: (await repo.page(KINDS.request, B.id, { limit: 1 })).cursor,
    people: (await repo.page(KINDS.member, B.id, { limit: 1 })).cursor,
    managerLinks: (await repo.page(KINDS.reqLink, memberScope(B.id, B.people.manager.user.id), { limit: 1 })).cursor,
    patLinks: (await repo.page(KINDS.reqLink, memberScope(B.id, w.both.user.id), { limit: 1 })).cursor,
  };
  for (const [k, c] of Object.entries(cursors)) assert.ok(c, `a Globex ${k} cursor`);
  const nf = { status: 404 };
  await field('activity with a Globex cursor', a.owner.http, 'GET', null, id => `${B0}/activity?cursor=${encodeURIComponent(id)}`, cursors.activity, MADE_UP.cursor, nf);
  await field('people with a Globex cursor', a.owner.http, 'GET', null, id => `${B0}/people?cursor=${encodeURIComponent(id)}`, cursors.people, MADE_UP.cursor, nf);
  await field('company trips with a Globex cursor', a.owner.http, 'GET', null, id => `${B0}/trips?scope=all&cursor=${encodeURIComponent(id)}`, cursors.trips, MADE_UP.cursor, nf);
  await field('team trips with a Globex cursor', a.manager.http, 'GET', null, id => `${B0}/trips?scope=team&cursor=${encodeURIComponent(id)}`, cursors.trips, MADE_UP.cursor, nf);
  await field('my trips with the Globex manager\'s link cursor', a.manager.http, 'GET', null, id => `${B0}/trips?scope=mine&cursor=${encodeURIComponent(id)}`, cursors.managerLinks, MADE_UP.cursor, nf);
  await field('Pat\'s Acme trips with his own Globex link cursor', w.both.http, 'GET', null, id => `${B0}/trips?scope=mine&cursor=${encodeURIComponent(id)}`, cursors.patLinks, MADE_UP.cursor, nf);
  await field('reports with a Globex cursor', a.finance.http, 'GET', null, id => `${B0}/reports?period=2026-Q4&cursor=${encodeURIComponent(id)}`, cursors.trips, MADE_UP.cursor, nf);
  for (const [who, name] of [[a.manager.http, 'manager'], [a.owner.http, 'owner']]) {
    for (const tab of ['waiting', 'decided', 'expired', ...(name === 'owner' ? ['company'] : [])]) {
      for (const [k, c] of [['links', cursors.managerLinks], ['Pat links', cursors.patLinks], ['requests', cursors.trips]]) {
        await alike(`approvals ${tab} (${name}) with a Globex ${k} cursor`, who, 'GET', null, id => `${B0}/approvals?tab=${tab}&cursor=${encodeURIComponent(id)}`, c, MADE_UP.cursor, nf);
      }
    }
  }
  for (const bad of MALFORMED_RAW.filter(v => v.trim())) await alike(`approvals with a malformed cursor ${JSON.stringify(bad.slice(0, 12))}`, a.manager.http, 'GET', null, id => `${B0}/approvals?cursor=${encodeURIComponent(id)}`, bad, MADE_UP.cursor, nf);

  // Policy history: Acme is at v2, Globex at v3. A version only Globex has, or one named by Globex's record id,
  // is the 404 of a made-up version, byte for byte; and Acme's own pages show only Acme's versions.
  const hist = id => `${B0}/policies/standard/history?before=${encodeURIComponent(id)}`;
  for (const [foreign, madeUp] of [['4', '999'], ['v3', 'v9'], [`${B.id}.standard.v1`, `${MADE_UP.orgId}.standard.v1`], [`${B.id}.standard.v3`, `${MADE_UP.orgId}.standard.v3`]]) {
    await alike(`history before=${foreign}`, a.owner.http, 'GET', null, hist, foreign, madeUp, nf);
  }
  for (const bad of MALFORMED_RAW.filter(v => v.trim())) await alike(`history before=${JSON.stringify(bad.slice(0, 12))}`, a.owner.http, 'GET', null, hist, bad, '999', nf);
  const v3 = await a.owner.http.get(hist('3'));
  assert.equal(v3.status, 200);
  assert.doesNotMatch(v3.text, /Globex|London hotels under/, 'Acme history holds Acme\'s versions only');
});

test('a suspended company, a pending company and a removed member answer as a made-up company does, for every workspace route', async () => {
  const { A, B, ops } = w;
  const orgRoutes = ALL_ROUTES.filter(r => r.path.startsWith('/o/:orgId'));
  const stranger = await seedUser(w.app, { name: 'Sam Stranger' });
  stranger.http = w.http(stranger.cookie);
  const others = [];
  for (const status of ['suspended', 'pending']) {
    const boss = await seedUser(w.app, { name: `Bea ${status}` });
    const org = await seedOrg(w.app, boss, { status, name: status === 'suspended' ? 'Initech LLC' : 'Umbrella Co' });
    others.push({ status, org, boss: { ...boss, http: w.http(boss.cookie) } });
  }
  // A removed Acme member (through the service, as the people page removes one).
  const gone = await seedMember(w.app, { id: A.id, org: A.org }, 'employee', { name: 'Remy Removed', departmentId: A.deps[0].id });
  const gm = await w.svc.repo.getIn(KINDS.member, `${A.id}.${gone.user.id}`, A.id);
  await w.svc.removeMember(A.people.owner.actor, gone.user.id, { rev: gm.rev });
  gone.http = w.http(gone.cookie);

  for (const r of orgRoutes) {
    const values = { orgId: MADE_UP.orgId, rid: MADE_UP.rid, userId: MADE_UP.userId, publicId: MADE_UP.publicId, tier: 'standard' };
    for (const { status, org } of others) {
      for (const [label, who] of [['a stranger', stranger.http], ['Globex owner', B.people.owner.http], ['Globex employee', B.people.employee.http], ['platform admin', ops.http]]) {
        const got = await sameAsMadeUp(`${label} on a ${status} company ${r.method} ${r.path}`, who, r, urlOf(r, { ...values, orgId: org.id }), urlOf(r, values), A, { status: 404 });
        assert.doesNotMatch(got.text, /Initech|Umbrella|bz-app/);
      }
    }
    const got = await sameAsMadeUp(`removed member ${r.method} ${r.path}`, gone.http, r, urlOf(r, { ...own(A) }), urlOf(r, { ...own(A), orgId: MADE_UP.orgId }), A, { status: 404 });
    assert.doesNotMatch(got.text, /Acme|bz-app/);
  }
  // The suspended company's own owner gets the plain 403 (never the workspace); the pending one's owner gets in.
  const sus = others.find(o => o.status === 'suspended');
  const own403 = await sus.boss.http.get(`/business/o/${sus.org.id}`);
  assert.equal(own403.status, 403);
  assert.doesNotMatch(own403.text, /bz-app/);
  const pend = others.find(o => o.status === 'pending');
  assert.equal((await pend.boss.http.get(`/business/o/${pend.org.id}`)).status, 200);
});

test('the walk covered every entry of every Business ROUTES table', () => {
  assert.deepEqual([...visited].sort(), ALL_ROUTES.map(keyOf).sort());
});

// ---------------------------------------------------------------------------------------------------------
// Traces

/** Everything that would name a company on another's page: its words, domain and ids (Pat's records in it included). */
function traces(C) {
  const ids = [
    C.id, ...C.deps.map(d => d.id), C.general.id, C.invite.invite.publicId, ...Object.values(C.requests).map(r => r.id),
    ...Object.values(C.people).map(p => p.user.id), ...C.budgets.map(b => `${C.id}.${b.departmentId}`),
  ];
  return { words: new RegExp(`${C.word}|${escRe(C.domain)}`, 'i'), ids };
}
/** The company a request belongs to, from the store itself (requests made after seeding count too). */
function orgOfRequest(id) {
  const rec = w.app.store.records.get(`${KINDS.request}:${id}`);
  return rec ? rec.data.orgId : null;
}
function assertNoTrace(label, text, C) {
  const t = traces(C);
  assert.doesNotMatch(text, t.words, `${label}: names ${C.name}`);
  for (const id of t.ids) assert.ok(!text.includes(id), `${label}: holds ${C.name}'s id ${id}`);
}
/** No consumer record (saved trip, watch, hunt, travel defaults, last search, recent trip, trip request, quote, booking). */
function assertNoPersonal(label, text) {
  for (const p of w.personal) {
    assert.ok(!text.includes(p.tag), `${label}: shows ${p.tag}`);
    for (const id of p.ids) assert.ok(!text.includes(id), `${label}: holds ${id}`);
  }
}

test('every page each role can reach, the CSV, the activity log and the company export of one company hold no trace of the other and no consumer record; crawling writes nothing', async () => {
  for (const [C, other] of [[w.A, w.B], [w.B, w.A]]) {
    let pages = 0;
    const before = storeSnapshot(w.app);
    for (const [role, p] of Object.entries(C.people)) {
      const seen = await crawl(p.http, [C.B, `${C.B}/trips?scope=all`, `${C.B}/trips?scope=team`, `${C.B}/approvals?tab=decided`, `${C.B}/approvals?tab=expired`, `${C.B}/welcome`, '/business/app', '/business/start', '/business/signin'], {
        onPage(url, res) {
          assertNoTrace(`${C.name} ${role} ${url}`, res.text, other);
          assertNoPersonal(`${C.name} ${role} ${url}`, res.text);
          if (res.location) assertNoTrace(`${C.name} ${role} ${url} redirect`, res.location, other);
          pages += 1;
        },
      });
      // Every request page this role reaches is its own company's.
      for (const url of seen.keys()) {
        const m = /\/trips\/(btr_[A-Za-z0-9_-]{16})/.exec(url);
        if (m) assert.equal(orgOfRequest(m[1]), C.id, `${url} is a ${C.name} request`);
      }
    }
    assert.ok(pages > 150, `${pages} ${C.name} pages crawled`);
    // The activity log, every group and every older page.
    for (const group of ['', ...AUDIT_GROUPS]) {
      const start = `${C.B}/activity${group ? `?group=${group}` : ''}`;
      const seen = await crawl(C.people.owner.http, [start], { prefix: `${C.B}/activity` });
      for (const [url, res] of seen) {
        assert.equal(res.status, 200, url);
        assertNoTrace(`${C.name} ${url}`, res.text, other);
        assertNoPersonal(`${C.name} ${url}`, res.text);
      }
    }
    assert.equal(storeSnapshot(w.app), before, `${C.name}: the crawl wrote nothing`);
    // The CSV (Finance, the Owner and the Travel Admin export it).
    for (const role of ['finance', 'owner', 'admin']) {
      const res = await C.people[role].http.post(`${C.B}/reports/export`, { period: '2026-Q4' });
      assert.equal(res.status, 200, `${C.name} ${role} CSV`);
      assertNoTrace(`${C.name} CSV (${role})`, res.text, other);
      assertNoPersonal(`${C.name} CSV (${role})`, res.text);
      const ids = [...res.text.matchAll(/(?<![\w-])btr_[A-Za-z0-9_-]{16}(?![\w-])/g)].map(m => m[0]);
      assert.ok(ids.length >= 5, `${C.name} CSV rows`);
      for (const id of ids) assert.equal(orgOfRequest(id), C.id, `${C.name} CSV row ${id} is its own`);
    }
    // The company export: every record its own.
    const exp = await C.people.owner.http.post(`${C.B}/settings/export`, {});
    assert.equal(exp.status, 200, `${C.name} export`);
    assertNoTrace(`${C.name} export`, exp.text, other);
    assertNoPersonal(`${C.name} export`, exp.text);
    const data = JSON.parse(exp.text);
    const walk = x => {
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (!x || typeof x !== 'object') return;
      if (Object.hasOwn(x, 'orgId')) assert.equal(x.orgId, C.id, `${C.name} export: a record of another company`);
      Object.values(x).forEach(walk);
    };
    walk(data);
  }
});

test('the company switcher lists only the viewer\'s own companies; a person in both sees both, each page its own data', async () => {
  const switcher = page => (page.match(/<details class="[^"]*\bbz-switch\b[^"]*"[\s\S]*?<\/details>/) || [''])[0];
  const listed = page => [...switcher(page).matchAll(/<a href="\/business\/o\/(org_[A-Za-z0-9_-]{16})"/g)].map(m => m[1]);
  for (const C of [w.A, w.B]) {
    for (const [role, p] of Object.entries(C.people)) {
      const res = await p.http.get(C.B);
      assert.equal(res.status, 200, `${C.name} ${role}`);
      assert.deepEqual(listed(res.text), [C.id], `${C.name} ${role}: the switcher lists this company only`);
      const app = await p.http.get('/business/app');
      assert.equal(app.status, 303, `${C.name} ${role}: one company, straight to it`);
      assert.equal(app.location, C.B);
    }
  }
  // Pat Both: both are listed, and each workspace shows its own trips and people.
  const pat = w.both.http;
  for (const [C, other] of [[w.A, w.B], [w.B, w.A]]) {
    const res = await pat.get(C.B);
    assert.deepEqual(listed(res.text).sort(), [w.A.id, w.B.id].sort());
    assert.match(textOf(switcher(res.text)), /Acme Inc/);
    assert.match(textOf(switcher(res.text)), /Globex Ltd/);
    for (const path of ['', '/trips', '/policy', '/settings']) {
      const page = await pat.get(`${C.B}${path}`);
      assert.equal(page.status, 200, `${C.name}${path}`);
      assertNoTrace(`Pat in ${C.name}${path}`, withoutSwitcher(page.text), other);
    }
  }
  const chooser = await pat.get('/business/app');
  assert.equal(chooser.status, 200);
  assert.match(textOf(chooser.text), /Acme Inc/);
  assert.match(textOf(chooser.text), /Globex Ltd/);
  // The chooser shows Pat's own role in each and nothing about the companies' insides.
  assert.doesNotMatch(chooser.text, /Engineering|Research|board meeting|client workshop|sales pitch|site visit/i);
});

test('a platform admin who is not a member gets the plain 404 on every company page, for each company, as for one that does not exist', async () => {
  const { ops } = w;
  for (const C of [w.A, w.B]) {
    for (const path of ['', '/welcome', '/trips', `/trips/${C.requests.pending.id}`, '/approvals', '/policies', '/budgets', '/people', '/reports', '/activity', '/settings']) {
      const res = await ops.http.get(`${C.B}${path}`);
      const ref = await ops.http.get(`/business/o/${MADE_UP.orgId}${path.replace(C.requests.pending.id, MADE_UP.rid)}`);
      assert.equal(res.status, 404, `${C.name}${path}`);
      assert.equal(res.text, ref.text, `${C.name}${path}: the same page as a made-up company`);
      assert.deepEqual(headerLines(res), headerLines(ref), `${C.name}${path}: the same headers`);
      assert.doesNotMatch(res.text, new RegExp(C.word), `${C.name}${path}`);
    }
  }
  // The platform page itself names companies, but none of their requests, budgets, policies, people or audit rows.
  const list = await ops.http.get('/admin/business');
  assert.equal(list.status, 200);
  for (const C of [w.A, w.B]) {
    assert.match(textOf(list.text), new RegExp(C.name));
    for (const r of Object.values(C.requests)) assert.ok(!list.text.includes(r.id) && !list.text.includes(r.purpose), `no request of ${C.name}`);
    for (const k of ['admin', 'finance', 'manager', 'employee']) assert.ok(!list.text.includes(C.people[k].user.name), `no member list of ${C.name}`);
    assert.ok(!list.text.includes(C.deps[0].name), `no departments of ${C.name}`);
  }
  assertNoPersonal('platform page', list.text);
});

// ---------------------------------------------------------------------------------------------------------
// The role matrix (a world of its own: its writes change states)

/** A form body with repeated keys for arrays (the policy form's lists). */
function formBody(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const x of v) p.append(k, String(x));
    else if (v !== undefined && v !== null) p.append(k, String(v));
  }
  return p.toString();
}

/** Targets in one company for each role, so one role's write never changes another's case. */
async function matrixTargets(m, C) {
  const t = trips({ svc: m.svc }, C);
  const p = C.people;
  const emp = p.employee.actor;
  const day = n => addDays('2026-12-01', n + (C.word === 'Globex' ? 1 : 0));
  const approved = async (n, purpose) => {
    const d = await t.within(emp, day(n), 3, purpose);
    const r = (await m.svc.submit(emp, d.id, { rev: d.rev })).request;
    assert.equal(r.status, 'approved', purpose);
    return r;
  };
  const pending = async (n, purpose) => {
    const r = await t.send(emp, await t.business(emp, day(n), 3, purpose));
    assert.equal(r.status, 'pending', purpose);
    return r;
  };
  const T = { pending: C.requests.pending };
  T.ownerDraft = await t.within(p.owner.actor, day(0), 3, `${C.word} owner planning`);
  T.swapDraft = await t.business(emp, day(1), 3, `${C.word} matrix swap`);
  assert.ok(T.swapDraft.alternatives && T.swapDraft.alternatives.length, 'a draft with cheaper options');
  T.submitDraft = await t.within(emp, day(2), 3, `${C.word} matrix submit`);
  T.cancel = { owner: await approved(3, `${C.word} cancelled by the owner`), admin: await approved(4, `${C.word} cancelled by the admin`), employee: await pending(5, `${C.word} cancelled by the traveler`) };
  T.decide = { owner: await pending(6, `${C.word} decided by the owner`), admin: await pending(7, `${C.word} decided by the admin`), manager: await pending(8, `${C.word} decided by the manager`) };
  T.revoke = {};
  for (const k of ['owner', 'admin']) T.revoke[k] = (await m.svc.invite(p.owner.actor, { email: `revoke.${k}@${C.domain}`, role: 'employee' })).invite.publicId;
  T.member = {};
  T.remove = {};
  for (const k of ['owner', 'admin']) {
    T.member[k] = (await seedMember(m.app, { id: C.id, org: C.org }, 'employee', { name: `Uma ${C.word} ${k}`, email: `update.${k}@${C.domain}` })).user.id;
    T.remove[k] = (await seedMember(m.app, { id: C.id, org: C.org }, 'employee', { name: `Ray ${C.word} ${k}`, email: `remove.${k}@${C.domain}` })).user.id;
  }
  const sq = { ...Q, depart: day(9), return: addDays(day(9), 3) };
  T.searchQs = new URLSearchParams(sq).toString();
  T.tripForm = async k => {
    const sv = await m.svc.searchTrip(p[k].actor, sq);
    const within = leg => keyWhere(sv, leg, r => r.row.available && r.evaluation.status === 'within');
    return { ...sq, out: within('out'), back: within('back'), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.evaluation.status === 'within'), purpose: `${C.word} matrix trip by ${k}` };
  };
  return T;
}

/** The matrix rows: a route (by ROUTES key), a case, the expected status per role (O T F M E) and the request. */
function matrixRows(m, C, T) {
  const repo = m.svc.repo;
  const rev = async (kind, id) => String((await repo.getIn(kind, id, C.id)).rev);
  const reqRev = id => rev(KINDS.request, id);
  const ALL = [200, 200, 200, 200, 200];
  const get = path => () => ({ path });
  const post = (path, form) => async k => ({ path: typeof path === 'function' ? path(k) : path, form: typeof form === 'function' ? await form(k) : form });
  const pick = (map, fallback) => k => map[k] || map[fallback];
  return [
    ['GET /o/:orgId', 'home', ALL, get('')],
    ['GET /o/:orgId/policy', 'own policy', ALL, get('/policy')],
    ['GET /o/:orgId/trips/new', 'search form', ALL, get('/trips/new')],
    ['GET /o/:orgId/trips/search', 'results', ALL, get(`/trips/search?${T.searchQs}`)],
    ['POST /o/:orgId/trips', 'a new draft', [303, 303, 303, 303, 303], post('/trips', k => T.tripForm(k))],
    ['GET /o/:orgId/trips', 'mine', ALL, get('/trips')],
    ['GET /o/:orgId/trips', 'team', [200, 200, 403, 200, 403], get('/trips?scope=team')],
    ['GET /o/:orgId/trips', 'company', [200, 200, 200, 403, 403], get('/trips?scope=all')],
    ['GET /o/:orgId/trips/:rid', 'the employee\'s pending trip', ALL, get(`/trips/${T.pending.id}`)],
    ['GET /o/:orgId/trips/:rid', 'the owner\'s draft', [200, 200, 200, 404, 404], get(`/trips/${T.ownerDraft.id}`)],
    ['POST /o/:orgId/trips/:rid/swap', 'the employee\'s draft', [404, 404, 404, 404, 303], post(`/trips/${T.swapDraft.id}/swap`, async () => ({ altId: T.swapDraft.alternatives[0].id, rev: await reqRev(T.swapDraft.id) }))],
    ['POST /o/:orgId/trips/:rid/submit', 'the employee\'s draft', [404, 404, 404, 404, 303], post(`/trips/${T.submitDraft.id}/submit`, async () => ({ rev: await reqRev(T.submitDraft.id), reason: REASON, category: 'client_meeting' }))],
    ['POST /o/:orgId/trips/:rid/cancel', 'approved (override) or own pending', [303, 303, 404, 404, 303], post(k => `/trips/${pick(T.cancel, 'employee')(k).id}/cancel`, async k => ({ rev: await reqRev(pick(T.cancel, 'employee')(k).id) }))],
    ['POST /o/:orgId/trips/:rid/decide', 'a pending trip each', [303, 303, 403, 303, 403], post(k => `/trips/${pick(T.decide, 'manager')(k).id}/decide`,
      async k => ({ action: 'approve', note: `Approved by the ${k} after a check.`, ackOverBudget: '1', rev: await reqRev(pick(T.decide, 'manager')(k).id) }))],
    ['POST /o/:orgId/trips/:rid/message', 'the employee\'s pending trip', [303, 303, 404, 303, 303], post(`/trips/${T.pending.id}/message`, k => ({ text: `A short note from the ${k}.` }))],
    ['GET /o/:orgId/approvals', 'waiting', [200, 200, 403, 200, 403], get('/approvals')],
    ['GET /o/:orgId/approvals', 'company tab (override only)', [200, 200, 403, 404, 403], get('/approvals?tab=company')],
    ['GET /o/:orgId/welcome', 'setup', [200, 403, 403, 403, 403], get('/welcome')],
    ['GET /o/:orgId/policies', 'every tier', [200, 200, 200, 403, 403], get('/policies')],
    ['GET /o/:orgId/policies/:tier', 'editor', [200, 200, 200, 403, 403], get('/policies/standard')],
    ['POST /o/:orgId/policies/:tier', 'save', [303, 303, 403, 403, 403], async k => {
      const pol = await m.svc.getPolicy(C.people.owner.actor, 'standard');
      return { path: '/policies/standard', body: formBody({ ...pol.form, rev: String(pol.rev), note: `Checked by the ${k}` }) };
    }],
    ['GET /o/:orgId/policies/:tier/history', 'history', [200, 200, 200, 403, 403], get('/policies/standard/history')],
    ['GET /o/:orgId/budgets', 'budgets', [200, 200, 200, 200, 403], get('/budgets')],
    ['POST /o/:orgId/budgets', 'set a budget', [303, 403, 303, 403, 403], post('/budgets', async k => ({
      departmentId: C.deps[0].id, period: '2026-Q4', amount: k === 'owner' ? '21000' : '22000', rev: await rev(KINDS.budget, `${C.id}.${C.deps[0].id}.2026-Q4`),
    }))],
    ['GET /o/:orgId/people', 'people', [200, 200, 200, 200, 403], get('/people')],
    ['POST /o/:orgId/people/invite', 'invite', [200, 200, 403, 403, 403], post('/people/invite', k => ({ email: `matrix.${k}@${C.domain}`, role: 'employee', tier: 'standard' }))],
    ['POST /o/:orgId/people/invites/:publicId/revoke', 'revoke', [303, 303, 403, 403, 403], post(k => `/people/invites/${pick(T.revoke, 'owner')(k)}/revoke`, {})],
    ['POST /o/:orgId/people/:userId', 'change a member', [303, 303, 403, 403, 403], post(k => `/people/${pick(T.member, 'owner')(k)}`, async k => ({
      role: 'employee', tier: 'director', departmentId: '', managerId: '', approverId: '', rev: await rev(KINDS.member, `${C.id}.${pick(T.member, 'owner')(k)}`),
    }))],
    ['POST /o/:orgId/people/:userId/remove', 'remove a member', [303, 303, 403, 403, 403], post(k => `/people/${pick(T.remove, 'owner')(k)}/remove`, async k => ({
      rev: await rev(KINDS.member, `${C.id}.${pick(T.remove, 'owner')(k)}`),
    }))],
    ['POST /o/:orgId/departments', 'add a department', [303, 303, 403, 403, 403], post('/departments', k => ({ name: `${C.word} Matrix ${k}` }))],
    ['GET /o/:orgId/reports', 'reports', [200, 200, 200, 403, 403], get('/reports')],
    ['POST /o/:orgId/reports/export', 'CSV', [200, 200, 200, 403, 403], post('/reports/export', { period: '2026-Q4' })],
    ['GET /o/:orgId/activity', 'activity', [200, 200, 200, 403, 403], get('/activity')],
    ['GET /o/:orgId/settings', 'settings', ALL, get('/settings')],
    ['POST /o/:orgId/settings', 'save (Owner: every field; others: the travel fields)', [303, 303, 403, 403, 403], post('/settings', async k => {
      const org = await repo.getIn(KINDS.org, C.id, C.id);
      const travel = { outOfPolicy: org.settings.outOfPolicy, approvalHours: String(org.settings.approvalHours), budgetPeriod: org.settings.budgetPeriod };
      return { rev: String(org.rev), ...(k === 'owner' ? { name: org.name, timezone: org.timezone } : {}), ...travel };
    })],
    ['POST /o/:orgId/settings/export', 'company export', [200, 403, 403, 403, 403], post('/settings/export', {})],
  ];
}

test('role matrix (plan §D and §B4): each role on each workspace route gets the literal 200, 303, 403 or 404, in both companies', async () => {
  const m = await world();
  try {
    const keys = new Set();
    const problems = [];
    for (const C of [m.A, m.B]) {
      const T = await matrixTargets(m, C);
      for (const [key, label, expect, req] of matrixRows(m, C, T)) {
        keys.add(key);
        const got = [];
        for (const k of ROLE_KEYS) {
          const who = C.people[k].http;
          const spec = await req(k);
          const [method] = key.split(' ');
          const url = `${C.B}${spec.path}`;
          const res = method === 'GET' ? await who.get(url)
            : spec.body !== undefined ? await who.raw(url, spec.body, 'application/x-www-form-urlencoded') : await who.post(url, spec.form || {});
          got.push(res.status);
          if (res.status === 303) assert.ok(res.location.startsWith(C.B), `${C.name} ${k} ${key}: stays in the company (${res.location})`);
          if (res.status === 403 || res.status === 404) assert.match(res.text, /bz-app/, `${C.name} ${k} ${key}: a member's refusal sits in the workspace`);
          if (res.status >= 400 && res.status !== 403 && res.status !== 404) problems.push(`${C.name} ${k} ${key}: ${textOf(mainOf(res.text)).slice(0, 200)}`);
        }
        if (JSON.stringify(got) !== JSON.stringify(expect)) problems.push(`${C.name} ${key} (${label}): got ${got.join(' ')}, §D says ${expect.join(' ')}`);
      }
    }
    assert.deepEqual(problems, []);
    assert.deepEqual([...keys].sort(), ALL_ROUTES.filter(r => r.path.startsWith('/o/:orgId')).map(r => `${r.method} ${r.path}`).sort(), 'every workspace route is in the matrix');
  } finally {
    await m.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// 429

test('a 429 on another company\'s URL is the plain 429 a made-up company gets; only a member sees it in the workspace', async () => {
  const lw = await world({ production: true, env: { BUSINESS_WRITE_LIMIT: '2', BUSINESS_COMPUTE_LIMIT: '2' } });
  try {
    const { A, B } = lw;
    const before = storeSnapshot(lw.app);
    const gx = B.people.employee.http;
    const madeUp = `/business/o/${MADE_UP.orgId}`;
    // Writes (bizWrite): two refused posts spend the limit, then Acme's URL and a made-up one answer alike.
    for (let i = 0; i < 2; i += 1) assert.equal((await gx.post(`${madeUp}/departments`, { name: 'X' })).status, 404);
    const r = { method: 'POST', path: '/o/:orgId/departments' };
    const got = await sameAsMadeUp('Globex employee over the write limit on Acme', gx, r, `${A.B}/departments`, `${madeUp}/departments`, A, { status: 429, x: lw });
    assert.doesNotMatch(got.text, /Acme|bz-app/);
    // Searches (bizCompute) the same way.
    const qs = new URLSearchParams(Q).toString();
    const gy = B.people.manager.http;
    for (let i = 0; i < 2; i += 1) await gy.get(`${madeUp}/trips/search?${qs}`);
    const s = { method: 'GET', path: '/o/:orgId/trips/search' };
    const got2 = await sameAsMadeUp('Globex manager over the search limit on Acme', gy, s, `${A.B}/trips/search?${qs}`, `${madeUp}/trips/search?${qs}`, A, { status: 429, x: lw });
    assert.doesNotMatch(got2.text, /Acme|bz-app/);
    // An Acme member over the limit gets the 429 inside Acme's workspace.
    const ae = A.people.employee.http;
    for (let i = 0; i < 2; i += 1) await ae.post(`${A.B}/departments`, { name: 'X' });
    const mine = await ae.post(`${A.B}/departments`, { name: 'X' });
    assert.equal(mine.status, 429);
    assert.match(mine.text, /bz-app/);
    assert.equal(storeSnapshot(lw.app), before, 'nothing written');
  } finally {
    await lw.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// PostgresStore

const pgUrl = process.env.TEST_DATABASE_URL;
test('PostgresStore: the repo choke point and a route walk (other company\'s ids and cursors) on the production store', { skip: !pgUrl && 'TEST_DATABASE_URL not set', timeout: 600000 }, async () => {
  const store = new PostgresStore({ connectionString: pgUrl, ssl: false });
  await store.init();
  let pw = null;
  try {
    pw = await world({ store, unique: true });
    const { A, B } = pw;
    const before = await snapshot(pw);
    await repoChecks(pw);
    // Every Acme workspace route as Globex's owner, and Globex's ids and cursors through Acme's members.
    const app = pw.app;
    const sameAs = async (label, who, method, url, ref, status) => {
      const got = method === 'GET' ? await who.get(url) : await who.post(url, { rev: '0', note: 'Checked with the team lead first.', action: 'approve', text: 'Hello there' });
      const res = method === 'GET' ? await who.get(ref) : await who.post(ref, { rev: '0', note: 'Checked with the team lead first.', action: 'approve', text: 'Hello there' });
      assert.equal(got.status, status, `${label}: ${got.status}`);
      assert.equal(got.status, res.status, label);
      assert.equal(got.text, res.text, `${label}: the same body`);
      assert.deepEqual(headerLines(got), headerLines(res), `${label}: the same headers`);
    };
    for (const r of ALL_ROUTES.filter(x => x.path.startsWith('/o/:orgId'))) {
      const values = { orgId: A.id, rid: A.requests.pending.id, userId: A.people.employee.user.id, publicId: A.invite.invite.publicId, tier: 'standard' };
      await sameAs(`Globex owner ${r.method} ${r.path}`, B.people.owner.http, r.method, urlOf(r, values), urlOf(r, { ...values, orgId: MADE_UP.orgId }), 404);
    }
    for (const rid of Object.values(B.requests).map(x => x.id)) {
      for (const [method, path] of [['GET', ''], ['POST', '/cancel'], ['POST', '/decide'], ['POST', '/message']]) {
        await sameAs(`Acme owner ${method} Globex request${path}`, A.people.owner.http, method, `${A.B}/trips/${rid}${path}`, `${A.B}/trips/${MADE_UP.rid}${path}`, 404);
      }
    }
    const repo = new Repo({ store, now: app.ctx.now });
    const c = {
      activity: (await repo.page(KINDS.audit, B.id, { limit: 1 })).cursor,
      trips: (await repo.page(KINDS.request, B.id, { limit: 1 })).cursor,
      people: (await repo.page(KINDS.member, B.id, { limit: 1 })).cursor,
      patLinks: (await repo.page(KINDS.reqLink, memberScope(B.id, pw.both.user.id), { limit: 1 })).cursor,
    };
    for (const [path, cursor, who] of [['/activity', c.activity, A.people.owner], ['/people', c.people, A.people.owner], ['/trips?scope=all&', c.trips, A.people.owner],
      ['/trips?scope=team&', c.trips, A.people.manager], ['/trips?scope=mine&', c.patLinks, pw.both], ['/approvals', c.patLinks, A.people.manager]]) {
      const join = path.endsWith('&') ? '' : '?';
      await sameAs(`${path} with a Globex cursor`, who.http, 'GET', `${A.B}${path}${join}cursor=${encodeURIComponent(cursor)}`, `${A.B}${path}${join}cursor=abc.def`, 404);
    }
    assert.equal(await snapshot(pw), before, 'nothing written on PostgresStore');
  } finally {
    if (pw) await pw.close();
    await store.close();
  }
});
