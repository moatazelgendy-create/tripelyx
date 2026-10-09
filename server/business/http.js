// Tripelyx Business HTTP guards (plan §B4, §I7; from 1C's http.js). Routers use these per route, never as a
// path-less r.use(), so /business (the company page in pagesRouter) is never caught.
//
// - requireUserPage (alias requireUser): signed out → GET 303 /business/signin?next=<this page>; any other
//   method → 303 /business/signin (a POST cannot be replayed after signing in).
// - memberGate(ctx, perm, { own }): the company and the member record are re-read on every request
//   (actor.loadActor; the only source of the role, and platform admins get nothing from isAdmin). Not a
//   member, a removed member or an unknown company → the app's 404 page (nothing says the workspace exists).
//   Another company's record or a request the permission does not reach → 404. A member whose role lacks the
//   permission → 403 page; a suspended company → 403 page. Always Cache-Control: no-store and X-Robots-Tag:
//   noindex. Sets req.biz. The service re-checks all of this inside every method anyway.
// - Inside the workspace (lead decision L2-1): once the gate knows the company and the member, its 404 and
//   the role's 403 are drawn in the workspace shell ("This page isn't available" / the role message, a link
//   back to the company home, no consumer footer or ribbon), and so is a Business limiter's 429 on a
//   /business/o/:orgId page (bizErrorPages, the Business router's error handler). Signed out, unknown
//   company, a suspended company: the plain pages as before. Status codes never change.
// - shellContext(ctx, req): what the workspace shell needs (company, member, company switcher, approvals
//   count, navigation filtered by can()).
const { AppError } = require('../lib/errors');
const { notFoundView, errorView } = require('../views/errors');
const { PERMISSIONS, LABELS, can, canAny, allowedAny, scopeOf } = require('./roles');
const { KINDS } = require('./constants');
const { safeLocal } = require('./validate');
const { loadActor, roleMessage, SUSPENDED } = require('./actor');
const { shellErrorView } = require('../views/business/shell');
const { withCompany } = require('./scope');

/** Private workspace headers: never cached, never indexed. */
function privateHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

/** Middleware: Cache-Control no-store and X-Robots-Tag noindex for a private page. */
function noStore(req, res, next) {
  privateHeaders(res);
  next();
}

/** Send the signed-out visitor to the company sign-in (GET comes back here afterwards). */
function toSignIn(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(303, `/business/signin?next=${encodeURIComponent(safeLocal(req.originalUrl, '/business/app'))}`);
  }
  return res.redirect(303, '/business/signin');
}

/** Middleware: a signed-in user, or a redirect to the company sign-in. */
function requireUserPage(req, res, next) {
  if (!req.user) return toSignIn(req, res);
  next();
}

/**
 * The app context for a Business page drawn in the site's own layout (a 404, a 403): the same, without the
 * environment banner (go-live design §3.4). Business never shows "demo inventory · payments in test mode": its
 * workspace and public pages don't, and neither do its refusals. Consumer pages keep their banner.
 * @param {object} ctx
 * @returns {object}
 */
function withoutEnvBanner(ctx) {
  return ctx && ctx.envBanner ? { ...ctx, envBanner: null } : ctx;
}

/**
 * Is this request path a Business one (/business, /business/..., /admin/business, /admin/business/...)? Case
 * does not matter (Express routes ignore it). The app's own 404 and error pages leave the banner off these when
 * Business runs.
 * @param {unknown} p req.path
 * @returns {boolean}
 */
function isBusinessPath(p) {
  const s = String(p || '').toLowerCase();
  return s === '/business' || s.startsWith('/business/') || s === '/admin/business' || s.startsWith('/admin/business/');
}

/** The default 403 page: the app's error page with the message (no environment banner). Stage 2 may pass its own view. */
function defaultForbiddenView(ctx, { message }) {
  return errorView(withoutEnvBanner(ctx), { status: 403, message });
}

/** The workspace refusals drawn in the shell (lead decision L2-1). */
const NOT_AVAILABLE = Object.freeze({ title: "This page isn't available", message: 'The link may be wrong or out of date.' });
const ROLE_TITLE = "Your role can't open this page";
const LIMITED_TITLE = 'Too many requests';

/** req.biz as memberGate sets it: the company, the member and the actor all known. */
const knownBiz = biz => (biz && biz.org && biz.member && biz.actor ? biz : null);

/**
 * Draw a refusal in the workspace shell. Never rejects: if the shell cannot be drawn (the company list or
 * the count failing), `fallback` answers instead.
 * @returns {Promise<void>}
 */
async function sendInShell(ctx, res, biz, { status, title, message }, fallback) {
  privateHeaders(res);
  let page;
  try {
    const shell = await shellContext(ctx, { biz, originalUrl: (res.req && res.req.originalUrl) || '' });
    page = String(shellErrorView(ctx, shell, { title, message }));
  } catch {
    return fallback();
  }
  if (res.headersSent) return undefined;
  res.status(status).type('html').send(page);
  return undefined;
}

/**
 * Answer 404. Before the gate knows the company and the member (a stranger, a removed member, an unknown
 * company): the app's own "Page not found" page, so nothing hints that the workspace exists. Inside the
 * workspace (biz, or res.req.biz from memberGate): "This page isn't available" in the shell.
 * @param {object} ctx
 * @param {import('express').Response} res
 * @param {{ biz?: object|null }} [opts] what the gate knows (default res.req.biz)
 * @returns {void|Promise<void>}
 */
function sendNotFound(ctx, res, { biz = null } = {}) {
  privateHeaders(res);
  const plain = () => { res.status(404).type('html').send(String(notFoundView(withoutEnvBanner(ctx)))); };
  const known = knownBiz(biz || (res.req && res.req.biz));
  if (!known || !ctx.business) return plain();
  return sendInShell(ctx, res, known, { status: 404, ...NOT_AVAILABLE }, plain);
}

/**
 * Answer 403. A role without the permission, inside the workspace (biz, or res.req.biz): the role message in
 * the shell. Otherwise (a suspended company, or the gate knows no member) the forbidden page `view`.
 * @param {object} ctx
 * @param {import('express').Response} res
 * @param {{ message: string, role?: string|null, reason: 'role'|'suspended' }} info
 * @param {Function} [view] (ctx, { message, role, label, reason }) => html
 * @param {{ biz?: object|null }} [opts]
 * @returns {void|Promise<void>}
 */
function sendForbidden(ctx, res, info, view = defaultForbiddenView, { biz = null } = {}) {
  privateHeaders(res);
  const plain = () => { res.status(403).type('html').send(String(view(withoutEnvBanner(ctx), { ...info, label: info.role ? LABELS[info.role] : null }))); };
  const known = info.reason === 'role' ? knownBiz(biz || (res.req && res.req.biz)) : null;
  if (!known || !ctx.business) return plain();
  return sendInShell(ctx, res, known, { status: 403, title: ROLE_TITLE, message: info.message }, plain);
}

/**
 * The Business router's error handler (routes/business/index.js mounts it after every Business route; as
 * an error handler it never sees a request that went well, so GET /business is never caught). A Business
 * limiter's 429 on a /business/o/:orgId page, for a signed-in member of that company, is drawn in the
 * workspace shell; so is a 404, or a role's 403, that a route passed on. Everything else (signed out, not a
 * member, a suspended company, sameOrigin's 403, a 500) goes on to the app's error handler as before.
 * @param {object} ctx
 * @returns {import('express').ErrorRequestHandler}
 */
function bizErrorPages(ctx) {
  return async function bizErrorPage(err, req, res, next) {
    try {
      const shown = err instanceof AppError && (err.status === 429 || err.status === 404 || (err.status === 403 && typeof err.role === 'string'));
      const m = /^\/business\/o\/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/.exec(String(req.originalUrl || ''));
      if (!shown || !m || !req.user || !ctx.business || !ctx.business.repo || res.headersSent) return next(err);
      let a;
      try {
        a = await loadActor(ctx.business.repo, { org: { id: m[1] }, user: req.user });
      } catch (e) {
        if (e instanceof AppError) return next(err);
        throw e;
      }
      const biz = { org: a.org, member: a.member, actor: { org: a.org, member: a.member, user: req.user } };
      const page = err.status === 429 ? { status: 429, title: LIMITED_TITLE, message: err.message }
        : err.status === 404 ? { status: 404, ...NOT_AVAILABLE }
          : { status: 403, title: ROLE_TITLE, message: roleMessage(a.member.role, a.org.name) };
      return sendInShell(ctx, res, biz, page, () => next(err));
    } catch (e) { return next(e); }
  };
}

/**
 * Gate a company page on a permission.
 * @param {object} ctx the app context (ctx.business is the BusinessService, with its Repo at ctx.business.repo)
 * @param {string|string[]} perm one of roles.PERMISSIONS, or several (the member needs any one of them)
 * @param {{ own?: false|'request', forbiddenView?: Function }} [opts]
 *   own: 'request' loads req.params.rid with Repo.getIn and requires roles.allowed for one of the permissions
 *   (a pool link for the member counts for team and decider scopes); a missing, foreign or unreachable
 *   request → 404. forbiddenView(ctx, { message, role, label, reason }) renders the 403 page.
 * @returns {import('express').RequestHandler} named bizMemberGate, with .perms (the permissions, frozen) and
 *   .own; sets req.biz = { org, member, actor: { org, member, user }, request? }
 */
function memberGate(ctx, perm, { own = false, forbiddenView = defaultForbiddenView } = {}) {
  const perms = Array.isArray(perm) ? [...perm] : [perm];
  if (!perms.length || perms.some(p => !PERMISSIONS.includes(p))) throw new Error(`[business] unknown permission ${perm}`);
  if (own !== false && own !== 'request') throw new Error(`[business] memberGate own must be false or 'request' (got ${own})`);
  const gate = async function bizMemberGate(req, res, next) {
    try {
      privateHeaders(res);
      if (!req.user) return toSignIn(req, res);
      const svc = ctx.business;
      const orgId = req.params.orgId;
      if (!svc || !svc.repo || typeof orgId !== 'string') return sendNotFound(ctx, res);
      let a;
      try {
        a = await loadActor(svc.repo, { org: { id: orgId }, user: req.user });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        if (e.code === 'org_suspended') return sendForbidden(ctx, res, { message: SUSPENDED, role: null, reason: 'suspended' }, forbiddenView);
        return sendNotFound(ctx, res);
      }
      const { org, member } = a;
      const biz = { org, member, actor: { org, member, user: req.user } };
      if (!canAny(member.role, perms)) {
        return sendForbidden(ctx, res, { message: roleMessage(member.role, org.name), role: member.role, reason: 'role' }, forbiddenView, { biz });
      }
      if (own === 'request') {
        const rid = req.params.rid;
        if (typeof rid !== 'string') throw new Error('[business] memberGate own:request needs a :rid route parameter');
        const record = await svc.repo.getIn(KINDS.request, rid, org.id);
        if (!record) return sendNotFound(ctx, res, { biz });
        let ok = allowedAny(member, perms, record);
        const poolScoped = perms.some(p => can(member.role, p) && (scopeOf(p) === 'team' || scopeOf(p) === 'decider'));
        if (!ok && poolScoped) {
          const link = await svc.repo.getIn(KINDS.reqLink, `${rid}.pool.${member.userId}`, org.id);
          ok = !!link && link.userId === member.userId && allowedAny(member, perms, record, { pooled: true });
        }
        if (!ok) return sendNotFound(ctx, res, { biz });
        biz.request = record;
      }
      req.biz = biz;
      // Everything this request runs from here on (the service, the composer, a supplier call several awaits
      // later) knows its company: the per-company supplier limit and result cache key on it (scope.js).
      withCompany(org.id, () => next());
    } catch (e) { next(e); }
  };
  // What the gate checks, so the structural test (business-static) can compare it with the route's ROUTES row.
  gate.perms = Object.freeze([...perms]);
  gate.own = own;
  return gate;
}

/**
 * The workspace navigation, in order (§B3). `perms`: the member needs any one of them. "Policy" opens every
 * tier's policy for policy.view.all and "Your travel policy" for everyone else.
 */
const NAV = Object.freeze([
  { key: 'home', label: 'Home', path: '', perms: ['org.view'] },
  { key: 'plan', label: 'Plan a trip', path: '/trips/new', perms: ['trip.request'] },
  { key: 'trips', label: 'Trips', path: '/trips', perms: ['request.view.own', 'request.view.team', 'request.view.all'] },
  { key: 'approvals', label: 'Approvals', path: '/approvals', perms: ['approval.decide'] },
  { key: 'policy', label: 'Policy', path: '/policy', perms: ['org.view'] },
  { key: 'budgets', label: 'Budgets', path: '/budgets', perms: ['budget.view.dept', 'budget.view.all'] },
  { key: 'people', label: 'People', path: '/people', perms: ['members.view'] },
  { key: 'reports', label: 'Reports', path: '/reports', perms: ['reports.view'] },
  { key: 'activity', label: 'Activity', path: '/activity', perms: ['audit.view'] },
  { key: 'settings', label: 'Settings', path: '/settings', perms: ['org.view'] },
].map(n => Object.freeze({ ...n, perms: Object.freeze(n.perms) })));

/**
 * The navigation for one member: the items their role reaches, each with its href and whether it is the
 * current section (the longest path that `currentPath` starts with, at a "/" boundary).
 * @param {{ id: string }} org
 * @param {{ role: string }} member
 * @param {string} [currentPath] e.g. req.originalUrl
 * @returns {Array<{ key: string, label: string, href: string, current: boolean }>}
 */
function navFor(org, member, currentPath = '') {
  const base = `/business/o/${org.id}`;
  const items = NAV.filter(n => canAny(member.role, n.perms)).map(n => {
    const path = n.key === 'policy' && can(member.role, 'policy.view.all') ? '/policies' : n.path;
    return { key: n.key, label: n.label, path, href: base + path };
  });
  const p = String(currentPath).split(/[?#]/)[0];
  const rest = p === base || p.startsWith(`${base}/`) ? p.slice(base.length) : null;
  let current = null;
  if (rest !== null) {
    for (const n of items) {
      const hit = n.path === '' ? rest === '' || rest === '/' : rest === n.path || rest.startsWith(`${n.path}/`);
      if (hit && (!current || n.path.length > current.path.length)) current = n;
    }
  }
  return items.map(n => ({ key: n.key, label: n.label, href: n.href, current: n === current }));
}

/**
 * Everything the workspace shell (views/business/shell.js) needs, after memberGate has set req.biz.
 * Calls svc.listCompaniesFor(actor) for the company switcher and, for members who decide approvals,
 * svc.inboxCount(actor) for the count chip (null otherwise).
 * @param {object} ctx the app context
 * @param {import('express').Request} req with req.biz from memberGate
 * @returns {Promise<{ org: object, member: object, companies: object[], approvalsCount: number|null,
 *   nav: Array<{ key: string, label: string, href: string, current: boolean }> }>}
 */
async function shellContext(ctx, req) {
  const biz = req.biz;
  if (!biz || !biz.org || !biz.member || !biz.actor) throw new Error('[business] shellContext runs after memberGate');
  const svc = ctx.business;
  const { org, member, actor } = biz;
  const companies = await svc.listCompaniesFor(actor);
  const approvalsCount = can(member.role, 'approval.decide') ? await svc.inboxCount(actor) : null;
  return { org, member, companies, approvalsCount, nav: navFor(org, member, req.originalUrl) };
}

/**
 * The guards bound to one app context and (optionally) a forbidden page view, for a router to use:
 *   const g = gates(ctx, { forbiddenView }); r.get('/o/:orgId', g.memberGate('org.view'), handler)
 * @param {object} ctx
 * @param {{ forbiddenView?: Function }} [opts]
 */
function gates(ctx, { forbiddenView = defaultForbiddenView } = {}) {
  return {
    requireUser: requireUserPage,
    requireUserPage,
    noStore,
    memberGate: (perm, opts = {}) => memberGate(ctx, perm, { forbiddenView, ...opts }),
    notFound: res => sendNotFound(ctx, res),
    forbidden: (res, info) => sendForbidden(ctx, res, info, forbiddenView),
    shellContext: req => shellContext(ctx, req),
  };
}

module.exports = {
  requireUserPage, requireUser: requireUserPage, memberGate, noStore, gates, sendNotFound, sendForbidden, shellContext,
  navFor, defaultForbiddenView, privateHeaders, bizErrorPages, withoutEnvBanner, isBusinessPath, NAV, NOT_AVAILABLE,
};
