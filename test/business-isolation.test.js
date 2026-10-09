// Tripelyx Business company isolation (plan §I7, §L Stage 3): one company can never see, change or infer
// another company's data. Two seeded companies (test/business-world.js: Acme Inc and Globex Ltd, every role,
// departments, budgets, policy versions, a pending invite and requests in every state) and a platform admin.
//
// - Every entry of every Business ROUTES table (public, traveler, admin, platform) is walked with ids from the
//   other company, made-up ids and malformed ids, as every role: a cross-company read or write answers 404 with
//   a body byte-identical to the made-up id's 404, and the store (the other company's records above all) is
//   unchanged after every attempt. Ids in forms and query strings (departments, travelers, managers,
//   approvers, alternatives, cursors) are refused the same way.
// - The Repo choke point refuses unscoped reads, personal kinds and another tenant's records.
// - Every service method refuses an actor that names a company the user is not in.
// - Every page, the CSV, the activity log, the company export and the company switcher of one company hold no
//   trace of the other (names, emails, ids, trip purposes).
// - A platform admin who is not a member gets the plain 404 on every company page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, keyWhere, crawl, textOf, decode, REASON, BQ } = require('./business-world');
const { storeSnapshot, seedUser, client } = require('./business-helpers');
const businessRoutes = require('../server/routes/business');
const businessPlatform = require('../server/routes/businessPlatform');
const { Repo, memberScope } = require('../server/business/repo');
const { SERVICE_METHODS } = require('../server/business/service');
const { KINDS } = require('../server/business/constants');
const { AppError } = require('../server/lib/errors');
const tokens = require('../server/business/tokens');

let w;
test.before(async () => { w = await world(); });
test.after(async () => { if (w) await w.close(); });

const MADE_UP = Object.freeze({
  orgId: 'org_ZZZZZZZZZZZZZZZZ', rid: 'btr_ZZZZZZZZZZZZZZZZ', userId: 'usr_ZZZZZZZZZZZZZZZZ', publicId: 'inv_ZZZZZZZZZZZZZZZZ',
  departmentId: 'dep_ZZZZZZZZZZZZZZZZ', tier: 'premium', token: tokens.newToken(),
});
/** Ids that can't be ids: wrong shape, wrong case, a colon, NUL, a space, markup, an em dash, far too long. */
const MALFORMED = Object.freeze(['x', 'btr_short', 'BTR_ZZZZZZZZZZZZZZZZ', 'org_ZZZZ%3AZZZZZZZZZZZ', '%00', '%20', '%3Cb%3Ehi%3C%2Fb%3E', '%E2%80%94', 'z'.repeat(240)]);
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

/** Records that belong to a company (its org, everything with its orgId), as one string. */
function companySnapshot(C) {
  const rows = [...w.app.store.records.entries()].filter(([, r]) => r.data && (r.data.orgId === C.id || (r.kind === KINDS.org && r.data.id === C.id)) || r.userId === C.id);
  return JSON.stringify(rows.sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function send(who, r, url, C) {
  return r.method === 'GET' ? who.get(url) : who.post(url, formFor(r, C));
}

/**
 * Send `url`, then the made-up one: same status, byte-identical body, and (for any method) nothing written.
 * `echo` [sent, madeUp]: a token the answer may repeat back in a link to its own page (/invite/<token>), written
 * out of both.
 */
async function sameAsMadeUp(label, who, r, url, madeUpUrl, C, { status = null, echo = null } = {}) {
  const before = storeSnapshot(w.app);
  const B = companySnapshot(w.B), A = companySnapshot(w.A);
  const got = await send(who, r, url, C);
  const ref = await send(who, r, madeUpUrl, C);
  assert.equal(storeSnapshot(w.app), before, `${label}: nothing written`);
  assert.equal(companySnapshot(w.B), B, `${label}: Globex unchanged`);
  assert.equal(companySnapshot(w.A), A, `${label}: Acme unchanged`);
  if (status !== null) assert.equal(got.status, status, `${label}: ${got.status} ${textOf(got.text).slice(0, 200)}`);
  assert.equal(got.status, ref.status, `${label}: the same status as a made-up id`);
  const out = (v, i) => {
    if (!echo || typeof v !== 'string') return v;
    const said = echo[i];
    return v.split(`/invite/${encodeURIComponent(said)}`).join('/invite/[echo]').split(`/invite/${said}`).join('/invite/[echo]');
  };
  assert.equal(out(got.text, 0), out(ref.text, 1), `${label}: the same body as a made-up id`);
  assert.equal(out(got.location, 0), out(ref.location, 1), `${label}: the same redirect as a made-up id`);
  return got;
}

/** Can this role reach the route at all (its permission)? */
const { canAny } = require('../server/business/roles');
const passes = (role, r) => r.perm === null || canAny(role, Array.isArray(r.perm) ? r.perm : [r.perm]);

// ---------------------------------------------------------------------------------------------------------

test('repo: the choke point refuses unscoped reads, personal kinds and another company\'s records', async () => {
  const repo = new Repo({ store: w.app.store, now: w.app.ctx.now });
  const { A, B } = w;
  // Unscoped or malformed owner scopes never list anything.
  for (const scope of ['', null, undefined, 'org_short', 'prp_AAAAAAAAAAAAAAAA', `${A.id} `, 'ORG_AAAAAAAAAAAAAAAA', 42]) {
    await assert.rejects(repo.list(KINDS.request, scope), /unscoped or malformed owner/, String(scope));
    await assert.rejects(repo.page(KINDS.request, scope), /unscoped or malformed owner/, String(scope));
  }
  // Personal kinds are refused for every read, so Business can't reach accounts, sessions or trips.
  for (const kind of ['user', 'user_email', 'session', 'booking', 'quote', 'payment_intent', 'saved', 'hunt', 'travel_defaults', 'outbox', 'platform_admin', 'BIZ_org', '']) {
    await assert.rejects(repo.get(kind, A.people.owner.user.id), /bad record kind/, kind);
    await assert.rejects(repo.getIn(kind, A.people.owner.user.id, A.id), /bad record kind/, kind);
    await assert.rejects(repo.list(kind, A.id), /bad record kind/, kind);
    await assert.rejects(repo.page(kind, A.id), /bad record kind/, kind);
  }
  // Every Globex record is invisible through getIn for Acme, and every Acme list holds Acme's rows only.
  const bizRows = [...w.app.store.records.values()].filter(r => r.kind.startsWith('biz_'));
  let foreign = 0;
  for (const r of bizRows) {
    const orgOf = r.kind === KINDS.org ? r.data.id : r.data.orgId;
    if (!orgOf) continue;
    const id = r.id;
    const other = orgOf === A.id ? B.id : A.id;
    assert.equal(await repo.getIn(r.kind, id, other), null, `${r.kind} ${id} through the other company`);
    assert.deepEqual(await repo.getIn(r.kind, id, orgOf), r.data, `${r.kind} ${id} through its own company`);
    foreign += 1;
  }
  assert.ok(foreign > 100, `${foreign} records checked`);
  for (const kind of Object.values(KINDS).filter(k => k !== KINDS.org && k !== KINDS.userIndex && k !== KINDS.reqLink && k !== KINDS.inviteEmail)) {
    for (const C of [A, B]) {
      const rows = (await repo.page(kind, C.id, { limit: 200 })).rows;
      for (const row of rows) assert.equal(row.orgId, C.id, `${kind} listed under ${C.name}`);
    }
  }
  // Link records live under a per-company member scope: Pat Both's links in Acme are not his links in Globex.
  const patA = memberScope(A.id, w.both.user.id), patB = memberScope(B.id, w.both.user.id);
  assert.notEqual(patA, patB);
  for (const [scope, C] of [[patA, A], [patB, B], [memberScope(A.id, A.people.manager.user.id), A], [memberScope(B.id, B.people.manager.user.id), B]]) {
    for (const row of await repo.list(KINDS.reqLink, scope)) assert.equal(row.orgId, C.id, 'a link of the same company');
  }
  // A cursor is tied to its kind and scope: Globex's cursor on an Acme list is a 404, as a damaged one is.
  const bPage = await repo.page(KINDS.audit, B.id, { limit: 1 });
  assert.ok(bPage.cursor, 'Globex has more than one audit row');
  for (const cursor of [bPage.cursor, `${bPage.cursor}x`, 'abc.def', 'x'.repeat(700)]) {
    await assert.rejects(repo.page(KINDS.audit, A.id, { cursor }), e => e instanceof AppError && e.status === 404, cursor.slice(0, 30));
  }
  // A write must name its owner scope (only biz_org has none), and never a falsy one.
  for (const owner of [null, '', undefined, 'prp_AAAAAAAAAAAAAAAA']) {
    await assert.rejects(repo.insert(KINDS.department, 'dep_NEWNEWNEWNEWNEWN', { orgId: A.id, name: 'X' }, { owner }), /unscoped or malformed owner/, String(owner));
  }
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
    // A broken escape is the same 400 for a real and a made-up company.
    const esc = urlOf(r, { ...own(A), orgId: `${A.id}${BAD_ESCAPE}` });
    const escRef = urlOf(r, { ...own(A), orgId: `${MADE_UP.orgId}${BAD_ESCAPE}` });
    await sameAsMadeUp(`bad escape ${r.method} ${r.path}`, B.people.owner.http, r, esc, escRef, A, { status: 400 });
    // Signed out: the same redirect to the company sign-in, whatever the company.
    const anon = client(w.app.base);
    const so = await send(anon, r, urlOf(r, own(A)), A);
    const soRef = await send(anon, r, urlOf(r, { ...own(A), orgId: MADE_UP.orgId }), A);
    assert.equal(so.status, 303, `signed out ${r.path}`);
    assert.equal(so.location.replace(A.id, MADE_UP.orgId), soRef.location, `signed out ${r.path}: the same redirect`);
    visited.add(keyOf(r));
  }
});

test('routes: as every Acme role, Globex request, member and invite ids (and made-up and malformed ones) in Acme paths are byte-identical 404s that write nothing', async () => {
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
        const status = passes(p.role, r) ? 404 : 403;
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

test('routes: public and platform routes: made-up and malformed tokens and ids answer alike, write nothing, and show no company to a stranger', async () => {
  const { A, B, ops } = w;
  const rest = ALL_ROUTES.filter(r => !r.path.startsWith('/o/:orgId'));
  for (const r of rest) {
    const params = paramsOf(r);
    const label = keyOf(r);
    if (params.includes('token')) {
      // An invite token is a secret link: a made-up one and a malformed one are the same "can't be used" page, for
      // a stranger and for members of either company.
      for (const [who, name] of [[client(w.app.base), 'signed out'], [A.people.owner.http, 'Acme owner'], [B.people.employee.http, 'Globex employee']]) {
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
      for (const p of [A.people.owner, B.people.owner, A.people.admin]) {
        for (const C of [A, B]) await sameAsMadeUp(`${label} member on ${C.name}`, p.http, r, urlOf(r, { orgId: C.id }), urlOf(r, { orgId: MADE_UP.orgId }), C, { status: 404 });
      }
    } else if (r.mount === businessPlatform.MOUNT) {
      // The company list is for platform admins only: everyone else gets the plain 404, with no company in it.
      for (const p of [A.people.owner, B.people.owner, w.both]) {
        const res = await p.http.get(urlOf(r, {}));
        assert.equal(res.status, 404, `${label} as a member`);
        assert.doesNotMatch(res.text, /Acme Inc|Globex Ltd|org_/, `${label}: no company named`);
      }
    } else if (r.method === 'GET') {
      // Pages with no ids: signed in as Globex, nothing of Acme (and the other way round).
      for (const [p, other] of [[B.people.employee, /Acme|acme\.example/], [A.people.employee, /Globex|globex\.example/]]) {
        const res = await p.http.get(urlOf(r, {}));
        assert.ok([200, 303].includes(res.status), `${label}: ${res.status}`);
        assert.doesNotMatch(res.text, other, `${label}: nothing of the other company`);
        if (res.status === 303) assert.ok(!/org_/.test(res.location) || res.location.includes(p === B.people.employee ? B.id : A.id), `${label}: redirect to the own company`);
      }
    } else if (r.path === '/signout') {
      const throwaway = await seedUser(w.app, { name: 'Tess Throwaway' });
      const res = await client(w.app.base, throwaway.cookie).post(urlOf(r, {}), {});
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
});

test('forms and query strings: Globex department, traveler, manager, approver, alternative and cursor ids in Acme forms answer as made-up ids do, and write nothing', async () => {
  const { A, B } = w;
  const a = A.people;
  const fb = B.deps[0].id, fu = B.people.employee.user.id, fm = B.people.manager.user.id;
  /** Compare two posts or gets, with the submitted id itself written out of both bodies (a form shows what was typed). */
  async function alike(label, who, method, path, mk, foreignId, madeUpId, { status = null } = {}) {
    const before = storeSnapshot(w.app);
    const go = id => (method === 'GET' ? who.get(mk(id)) : who.post(path, mk(id)));
    const got = await go(foreignId);
    const ref = await go(madeUpId);
    assert.equal(storeSnapshot(w.app), before, `${label}: nothing written`);
    if (status !== null) assert.equal(got.status, status, `${label}: ${got.status} ${textOf(got.text).slice(0, 200)}`);
    assert.equal(got.status, ref.status, `${label}: the same status`);
    const norm = (s, id) => s.split(id).join('[id]').split(encodeURIComponent(id)).join('[id]');
    assert.equal(norm(got.text, foreignId), norm(ref.text, madeUpId), `${label}: the same page`);
    assert.doesNotMatch(got.text, /Globex/, `${label}: nothing of Globex`);
  }
  const B0 = A.B;
  // Budgets and departments.
  await alike('budget for a Globex department', a.finance.http, 'POST', `${B0}/budgets`, id => ({ departmentId: id, period: '2026-Q4', amount: '100', rev: '' }), fb, MADE_UP.departmentId, { status: 404 });
  await alike('rename a Globex department', a.owner.http, 'POST', `${B0}/departments`, id => ({ departmentId: id, name: 'Renamed Team', rev: '0' }), fb, MADE_UP.departmentId, { status: 404 });
  await alike('archive a Globex department', a.owner.http, 'POST', `${B0}/departments`, id => ({ departmentId: id, archive: '1', rev: '0' }), fb, MADE_UP.departmentId, { status: 404 });
  // Invites and member changes naming Globex departments and people.
  for (const field of ['departmentId', 'managerId', 'approverId']) {
    const foreign = field === 'departmentId' ? fb : fm;
    const madeUp = field === 'departmentId' ? MADE_UP.departmentId : MADE_UP.userId;
    await alike(`invite with a Globex ${field}`, a.owner.http, 'POST', `${B0}/people/invite`, id => ({ email: 'new.person@acme.example', role: 'employee', tier: 'standard', [field]: id }), foreign, madeUp);
    const emp = A.people.employee.member;
    await alike(`member change with a Globex ${field}`, a.owner.http, 'POST', `${B0}/people/${A.people.employee.user.id}`,
      id => ({ role: 'employee', tier: 'standard', departmentId: emp.departmentId || '', managerId: A.people.manager.user.id, approverId: '', rev: String(emp.rev), [field]: id }), foreign, madeUp);
  }
  // Reports, the CSV and the trip list filtered on Globex departments and travelers.
  for (const [field, foreign, madeUp] of [['departmentId', fb, MADE_UP.departmentId], ['travelerId', fu, MADE_UP.userId]]) {
    await alike(`reports filtered on a Globex ${field}`, a.finance.http, 'GET', null, id => `${B0}/reports?period=2026-Q4&${field}=${encodeURIComponent(id)}`, foreign, madeUp, { status: 404 });
    await alike(`CSV filtered on a Globex ${field}`, a.finance.http, 'POST', `${B0}/reports/export`, id => ({ period: '2026-Q4', [field]: id }), foreign, madeUp, { status: 404 });
    await alike(`trips filtered on a Globex ${field}`, a.owner.http, 'GET', null, id => `${B0}/trips?scope=all&${field}=${encodeURIComponent(id)}`, foreign, madeUp);
  }
  // A swap to an alternative of a Globex request, on Acme's own returned draft. Alternative ids come from the
  // inventory (the same trip gives the same ids in any company), so the Globex draft is for other dates: its
  // alternatives are none of Acme's.
  const mine = A.requests.returned;
  const bq = { ...BQ, depart: '2026-11-26', return: '2026-11-30' };
  const sv = await w.svc.searchTrip(B.people.employee.actor, bq);
  const zm = r => r.row.available && r.row.carrier.code === 'ZM';
  const bDraft = await w.svc.createRequest(B.people.employee.actor, {
    query: bq, purpose: 'Globex later launch',
    selection: { out: keyWhere(sv, 'out', zm), back: keyWhere(sv, 'back', zm), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5) },
  });
  const acmeAlts = new Set((mine.alternatives || []).map(x => x.id));
  const bAlt = (bDraft.alternatives || []).find(x => !acmeAlts.has(x.id));
  assert.ok(bAlt, 'the Globex draft has an alternative Acme\'s draft does not');
  const cur = await w.svc.getRequest(a.employee.actor, mine.id);
  await alike('swap to a Globex alternative', a.employee.http, 'POST', `${B0}/trips/${mine.id}/swap`, id => ({ altId: id, rev: String(cur.request.rev) }), bAlt.id, 'alt_ZZZZZZZZZZZZZZZZ');
  // Cursors from Globex's lists on Acme's pages.
  const repo = w.svc.repo;
  const cursors = {
    activity: (await repo.page(KINDS.audit, B.id, { limit: 1 })).cursor,
    trips: (await repo.page(KINDS.request, B.id, { limit: 1 })).cursor,
    people: (await repo.page(KINDS.member, B.id, { limit: 1 })).cursor,
  };
  for (const [k, c] of Object.entries(cursors)) assert.ok(c, `a Globex ${k} cursor`);
  await alike('activity with a Globex cursor', a.owner.http, 'GET', null, id => `${B0}/activity?cursor=${encodeURIComponent(id)}`, cursors.activity, 'abc.def', { status: 404 });
  await alike('people with a Globex cursor', a.owner.http, 'GET', null, id => `${B0}/people?cursor=${encodeURIComponent(id)}`, cursors.people, 'abc.def');
  await alike('trips with a Globex cursor', a.owner.http, 'GET', null, id => `${B0}/trips?scope=all&cursor=${encodeURIComponent(id)}`, cursors.trips, 'abc.def');
  await alike('reports with a Globex cursor', a.finance.http, 'GET', null, id => `${B0}/reports?period=2026-Q4&cursor=${encodeURIComponent(id)}`, cursors.trips, 'abc.def');
  // A policy history page reads Acme's versions only, whatever `before` asks for.
  for (const before of ['2', '3', '999', 'v1', `${B.id}.standard.v1`]) {
    const res = await a.owner.http.get(`${B0}/policies/standard/history?before=${encodeURIComponent(before)}`);
    assert.doesNotMatch(res.text, /Globex/, `history before=${before}`);
  }
});

test('the walk covered every entry of every Business ROUTES table', () => {
  assert.deepEqual([...visited].sort(), ALL_ROUTES.map(keyOf).sort());
});

// ---------------------------------------------------------------------------------------------------------

/** Everything that would name Globex on an Acme page (and the other way round): its words, domain and ids. */
function traces(C) {
  const ids = [
    C.id, ...C.deps.map(d => d.id), C.general.id, C.invite.invite.publicId, ...Object.values(C.requests).map(r => r.id),
    ...Object.values(C.people).map(p => p.user.id), ...C.budgets.map(b => `${C.id}.${b.departmentId}`),
  ];
  return { words: new RegExp(`${C.word}|${C.domain.replace('.', '\\.')}`, 'i'), ids };
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

test('every page each role can reach, the CSV, the activity log and the company export of one company hold no trace of the other', async () => {
  for (const [C, other] of [[w.A, w.B], [w.B, w.A]]) {
    let pages = 0;
    for (const [role, p] of Object.entries(C.people)) {
      const seen = await crawl(p.http, [C.B, `${C.B}/activity?group=trips`, `${C.B}/trips?scope=all`, `${C.B}/approvals?tab=decided`, '/business/app', '/business/start', '/business/signin']);
      for (const [url, res] of seen) {
        assertNoTrace(`${C.name} ${role} ${url}`, res.text, other);
        if (res.location) assertNoTrace(`${C.name} ${role} ${url} redirect`, res.location, other);
        pages += 1;
      }
      // Every request page this role reaches is its own company's.
      for (const url of seen.keys()) {
        const m = /\/trips\/(btr_[A-Za-z0-9_-]{16})/.exec(url);
        if (m) assert.equal(orgOfRequest(m[1]), C.id, `${url} is a ${C.name} request`);
      }
    }
    assert.ok(pages > 150, `${pages} ${C.name} pages crawled`);
    // The CSV (Finance and the Owner export it).
    for (const role of ['finance', 'owner', 'admin']) {
      const res = await C.people[role].http.post(`${C.B}/reports/export`, { period: '2026-Q4' });
      assert.equal(res.status, 200, `${C.name} ${role} CSV`);
      assertNoTrace(`${C.name} CSV (${role})`, res.text, other);
      const ids = [...res.text.matchAll(/\bbtr_[A-Za-z0-9_-]{16}\b/g)].map(m => m[0]);
      assert.ok(ids.length >= 5, `${C.name} CSV rows`);
      for (const id of ids) assert.equal(orgOfRequest(id), C.id, `${C.name} CSV row ${id} is its own`);
    }
    // The company export: every record its own.
    const exp = await C.people.owner.http.post(`${C.B}/settings/export`, {});
    assert.equal(exp.status, 200, `${C.name} export`);
    assertNoTrace(`${C.name} export`, exp.text, other);
    const data = JSON.parse(exp.text);
    const walk = x => {
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (!x || typeof x !== 'object') return;
      if (Object.hasOwn(x, 'orgId')) assert.equal(x.orgId, C.id, `${C.name} export: a record of another company`);
      Object.values(x).forEach(walk);
    };
    walk(data);
    // The activity log, every group and page.
    for (const group of ['', 'company', 'people', 'departments', 'policy', 'budgets', 'trips', 'reports']) {
      const res = await C.people.owner.http.get(`${C.B}/activity${group ? `?group=${group}` : ''}`);
      assert.equal(res.status, 200, `${C.name} activity ${group}`);
      assertNoTrace(`${C.name} activity ${group}`, res.text, other);
    }
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
  // Pat Both is an Employee of both: both are listed, and each workspace shows its own trips and people.
  const pat = w.both.http;
  for (const [C, other] of [[w.A, w.B], [w.B, w.A]]) {
    const res = await pat.get(C.B);
    assert.deepEqual(listed(res.text).sort(), [w.A.id, w.B.id].sort());
    assert.match(textOf(switcher(res.text)), /Acme Inc/);
    assert.match(textOf(switcher(res.text)), /Globex Ltd/);
    for (const path of ['', '/trips', '/policy', '/settings']) {
      const page = await pat.get(`${C.B}${path}`);
      assert.equal(page.status, 200, `${C.name}${path}`);
      const main = (page.text.match(/<main\b[\s\S]*<\/main>/) || [''])[0];
      assertNoTrace(`Pat in ${C.name}${path}`, main, other);
    }
  }
  const chooser = await pat.get('/business/app');
  assert.equal(chooser.status, 200);
  assert.match(textOf(chooser.text), /Acme Inc/);
  assert.match(textOf(chooser.text), /Globex Ltd/);
  // The chooser shows Pat's own role in each and nothing about the companies' insides.
  assert.doesNotMatch(chooser.text, /Engineering|Research|board meeting|client workshop/i);
  // Pat's Acme trips (none) and Globex's requests are never mixed: the Globex employee's trips are not on Pat's Acme list.
  const list = await pat.get(`${w.A.B}/trips`);
  for (const r of Object.values(w.B.requests)) assert.ok(!list.text.includes(r.id), r.id);
  void decode;
});

test('a platform admin who is not a member gets the plain 404 on every company page, for each company, as for one that does not exist', async () => {
  const { ops } = w;
  for (const C of [w.A, w.B]) {
    for (const path of ['', '/welcome', '/trips', `/trips/${C.requests.pending.id}`, '/approvals', '/policies', '/budgets', '/people', '/reports', '/activity', '/settings']) {
      const res = await ops.http.get(`${C.B}${path}`);
      const ref = await ops.http.get(`/business/o/${MADE_UP.orgId}${path.replace(C.requests.pending.id, MADE_UP.rid)}`);
      assert.equal(res.status, 404, `${C.name}${path}`);
      assert.equal(res.text, ref.text, `${C.name}${path}: the same page as a made-up company`);
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
});
