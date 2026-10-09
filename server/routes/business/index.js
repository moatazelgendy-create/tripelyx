// Tripelyx Business routes (plan §B4), mounted by app.js at MOUNT ('/business') when ENABLE_BUSINESS is on,
// after /admin and before agentRouter (with trips off: before pagesRouter). GET /business itself is the
// company page in pagesRouter, so no Business router defines it and none uses a path-less r.use() that
// could catch it: every guard is per route (server/business/http.js).
// Frozen in Stage 0: the module shape ({ router(ctx, deps), ROUTES }), createRouterDeps, assertRoutes and
// the RouteEntry shape (types.RouteEntry). Stage 2 fills public.js and admin.js (2A) and traveler.js (2B).
//
// Every POST runs, in this order: a limiter (bizWrite; bizAuthIp for the sign-in, sign-up and invite
// routes; bizCompute where the plan says so) → sameOrigin → deps.form → the gate (memberGate(perm[, { own:
// 'request' }]) or requireUser) → the handler → 303 to a GET with ?ok=<code>. Exceptions: bizAuthAccount
// runs after the form on /signin (it keys on the email); the invite-link page answers 200 (show-once
// token); the CSV and company-export downloads answer 200 with an attachment. GETs never write.
const express = require('express');
const publicRoutes = require('./public');
const travelerRoutes = require('./traveler');
const adminRoutes = require('./admin');
const { createBusinessLimits } = require('../../business/limits');
const { bizErrorPages } = require('../../business/http');
const { PERMISSIONS } = require('../../business/roles');
const { sameOrigin } = require('../trips');

/** Where app.js mounts this router; ROUTES paths are relative to it. */
const MOUNT = '/business';

/** The Business form parser: url-encoded, 64 kb and 4,000 fields (the policy editor is the largest form). */
const FORM_OPTIONS = Object.freeze({ extended: false, limit: '64kb', parameterLimit: 4000 });

/** RouteEntry vocabularies. */
const METHODS = Object.freeze(['GET', 'POST']);
const LIMITERS = Object.freeze(['bizAuthIp', 'bizAuthAccount', 'bizWrite', 'bizCompute']);
const WHO = Object.freeze(['anyone', 'user', 'member', 'platform']);

/**
 * Build what every Business router needs, once per app (never inside a request).
 * @param {{ config: object, log?: object }} ctx the app context
 * @returns {import('../../business/types').RouterDeps}
 */
function createRouterDeps(ctx) {
  const log = ctx.log || console;
  return Object.freeze({
    limits: createBusinessLimits(ctx.config.business, { logger: log }),
    sameOrigin,
    form: express.urlencoded(FORM_OPTIONS),
    log,
  });
}

/**
 * Check a ROUTES table: each entry well formed, no method and path listed twice, every '/o/:orgId' route a
 * member route with a permission, every POST with a limiter, and bizAuthAccount only after a bizAuthIp.
 * Stage 2's structural test also walks the Express stack against this table.
 * @param {import('../../business/types').RouteEntry[]} routes
 * @param {{ mount?: string }} [opts] the router's mount (MOUNT, or businessPlatform's '/admin/business')
 * @returns {import('../../business/types').RouteEntry[]} the same array
 * @throws {TypeError} naming the first bad entry
 */
function assertRoutes(routes, { mount = MOUNT } = {}) {
  if (!Array.isArray(routes)) throw new TypeError('[business] ROUTES must be an array');
  const seen = new Set();
  routes.forEach((r, i) => {
    const where = `ROUTES[${i}] ${r && r.method} ${r && r.path}`;
    const fail = why => { throw new TypeError(`[business] ${where}: ${why}`); };
    if (!r || typeof r !== 'object') fail('not an object');
    const keys = Object.keys(r).sort().join(',');
    if (keys !== 'limiter,method,own,path,perm,who') fail(`keys must be method, path, perm, own, limiter, who (got ${keys})`);
    if (!METHODS.includes(r.method)) fail('method must be GET or POST');
    if (typeof r.path !== 'string' || !/^\/[A-Za-z0-9/:._-]*$/.test(r.path) || r.path.startsWith(mount + '/')) fail('path must start with / and be relative to the mount');
    const perms = r.perm === null ? [] : Array.isArray(r.perm) ? r.perm : [r.perm];
    if (r.perm !== null && (!perms.length || perms.some(p => !PERMISSIONS.includes(p)))) fail('perm must be null, a permission or a non-empty list of them');
    if (r.own !== false && r.own !== 'request') fail("own must be false or 'request'");
    if (r.own === 'request' && !r.path.includes(':rid')) fail("own 'request' needs a :rid parameter");
    if (!Array.isArray(r.limiter) || r.limiter.some(l => !LIMITERS.includes(l))) fail('limiter must be a list of limiter names');
    if (r.limiter.includes('bizAuthAccount') && r.limiter.indexOf('bizAuthIp') !== 0) fail('bizAuthAccount runs after bizAuthIp (and after the form)');
    if (!WHO.includes(r.who)) fail('who must be anyone, user, member or platform');
    if ((r.who === 'member') !== perms.length > 0) fail("a member route needs a perm, and only a member route has one");
    if (r.path.startsWith('/o/:orgId') && r.who !== 'member') fail('every /o/:orgId route is a member route');
    if (r.method === 'POST' && !r.limiter.length) fail('every POST has a limiter');
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) fail('listed twice');
    seen.add(key);
  });
  return routes;
}

/** Every Business route under MOUNT, in mount order (public, traveler, admin). */
const ROUTES = assertRoutes([...publicRoutes.ROUTES, ...travelerRoutes.ROUTES, ...adminRoutes.ROUTES]);

/**
 * The Business router: public, traveler and admin routes, in that order, then the workspace error pages
 * (http.bizErrorPages).
 * @param {object} ctx the app context (ctx.business is the BusinessService)
 * @param {import('../../business/types').RouterDeps} deps from createRouterDeps(ctx)
 * @returns {import('express').Router}
 */
function router(ctx, deps) {
  const r = express.Router();
  r.use(publicRoutes.router(ctx, deps));
  r.use(travelerRoutes.router(ctx, deps));
  r.use(adminRoutes.router(ctx, deps));
  // An error handler only (four arguments): it sees only errors from the routes above, never a request that
  // went well, so it cannot catch GET /business. A limiter's 429 (and a 404 or role 403 passed on) on a
  // workspace page is drawn in the workspace shell; anything else goes on to the app's error handler.
  r.use(bizErrorPages(ctx));
  return r;
}

module.exports = { MOUNT, FORM_OPTIONS, METHODS, LIMITERS, WHO, ROUTES, router, createRouterDeps, assertRoutes };
