// Mounting a Business router from its route table (Stage 2A: public.js, admin.js and businessPlatform.js).
// The router modules keep the frozen shape { router, ROUTES } (businessPlatform adds MOUNT), so the helpers
// they share live here. A table row is a types.RouteEntry plus `handler`, the name of its handler; ROUTES
// is built from the same rows, so the Express stack and ROUTES cannot disagree.
//
// The chain mountTable builds for each row:
//   GET:  limiters → gate(row) → handler
//   POST: limiters (bizAuthAccount left out) → sameOrigin → deps.form → bizAuthAccount (it keys on the
//         parsed email) → gate(row) → handler
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
 * @param {{ deps: import('../../business/types').RouterDeps, gate: (row: object) => Function[], handlers: Record<string, Function> }} opts
 *   gate(row): the guards for row.who (and row.perm), run right before the handler
 * @returns {import('express').Router} r
 */
function mountTable(r, table, { deps, gate, handlers }) {
  for (const row of table) {
    const handler = handlers[row.handler];
    if (typeof handler !== 'function') throw new Error(`[business] no handler ${row.handler} for ${row.method} ${row.path}`);
    const early = row.limiter.filter(l => l !== 'bizAuthAccount').map(l => deps.limits[l]);
    const late = row.limiter.includes('bizAuthAccount') ? [deps.limits.bizAuthAccount] : [];
    const chain = row.method === 'GET' ? [...early, ...gate(row)] : [...early, deps.sameOrigin, deps.form, ...late, ...gate(row)];
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

module.exports = { send, clientError, routesOf, mountTable, publicHeaders };
