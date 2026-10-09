// Mounting a Business router from its route table (Stage 2A: public.js, admin.js and businessPlatform.js).
// The router modules keep the frozen shape { router, ROUTES } (businessPlatform adds MOUNT), so the helpers
// they share live here. A table row is a types.RouteEntry plus `handler`, the name of its handler; ROUTES
// is built from the same rows, so the Express stack and ROUTES cannot disagree.
//
// The chain mountTable builds for each row:
//   GET:  headers → limiters → gate(row) → handler
//   POST: headers → limiters (bizAuthAccount left out) → sameOrigin → deps.form → bizAuthAccount (it keys on
//         the parsed email) → gate(row) → handler
// `headers` (bizPrivateHeaders, or bizPublicHeaders for the public pages) only sets response headers and
// always calls next(): Cache-Control no-store, X-Robots-Tag noindex and, on public pages, Referrer-Policy
// no-referrer. It runs first so that a refusal before the gate (sameOrigin's 403, a limiter's 429, the body
// parser's 4xx, all answered by the app's error page) carries them too: an invite token can sit in the URL.
const { AppError } = require('../../lib/errors');
const { privateHeaders } = require('../../business/http');

/** Send a page with a status. */
function send(res, status, page) {
  res.status(status).type('html').send(String(page));
}

/** Is this a 4xx AppError a page can answer itself (anything else goes to the app's error handler)? */
const clientError = e => e instanceof AppError && Number.isInteger(e.status) && e.status >= 400 && e.status < 500;

/** Freeze a table's RouteEntry rows (types.RouteEntry: exactly method, path, perm, own, limiter, who). */
function routesOf(table) {
  return Object.freeze(table.map(({ method, path, perm, own, limiter, who }) => Object.freeze({
    method, path, perm: Array.isArray(perm) ? Object.freeze([...perm]) : perm, own, limiter: Object.freeze([...limiter]), who,
  })));
}

/**
 * Mount a table of routes on a router.
 * @param {import('express').Router} r
 * @param {Array<object>} table RouteEntry rows plus `handler`, a key of `handlers`
 * @param {{ deps: import('../../business/types').RouterDeps, gate: (row: object) => Function[], handlers: Record<string, Function>,
 *   headers?: Function }} opts
 *   gate(row): the guards for row.who (and row.perm), run right before the handler; headers: the first
 *   middleware of every chain (bizPrivateHeaders by default, bizPublicHeaders for the public pages)
 * @returns {import('express').Router} r
 */
function mountTable(r, table, { deps, gate, handlers, headers = bizPrivateHeaders }) {
  if (typeof headers !== 'function') throw new Error('[business] mountTable needs a headers middleware');
  for (const row of table) {
    const handler = handlers[row.handler];
    if (typeof handler !== 'function') throw new Error(`[business] no handler ${row.handler} for ${row.method} ${row.path}`);
    const early = row.limiter.filter(l => l !== 'bizAuthAccount').map(l => deps.limits[l]);
    const late = row.limiter.includes('bizAuthAccount') ? [deps.limits.bizAuthAccount] : [];
    const chain = row.method === 'GET'
      ? [headers, ...early, ...gate(row)]
      : [headers, ...early, deps.sameOrigin, deps.form, ...late, ...gate(row)];
    if (chain.some(fn => typeof fn !== 'function')) throw new Error(`[business] a middleware is missing for ${row.method} ${row.path}`);
    r[row.method === 'GET' ? 'get' : 'post'](row.path, ...chain, handler);
  }
  return r;
}

/** Middleware: the private headers (no-store, noindex) plus Referrer-Policy no-referrer, for the public pages. */
function publicHeaders(req, res, next) {
  privateHeaders(res);
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/** The first middleware of a workspace or platform chain: Cache-Control no-store, X-Robots-Tag noindex. */
function bizPrivateHeaders(req, res, next) {
  privateHeaders(res);
  next();
}

/** The first middleware of a public chain: the private headers plus Referrer-Policy no-referrer. */
function bizPublicHeaders(req, res, next) {
  publicHeaders(req, res, next);
}

module.exports = { send, clientError, routesOf, mountTable, publicHeaders, bizPrivateHeaders, bizPublicHeaders };
