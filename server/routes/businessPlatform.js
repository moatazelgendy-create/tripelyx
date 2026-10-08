// The platform admin's company list (plan §I8), mounted by app.js at MOUNT ('/admin/business') when
// ENABLE_BUSINESS is on, before /admin, with Travel by Budget on or off. Only platform admins
// (req.user.isAdmin, D1) see it; everyone else gets the app's 404. It never shows requests, policies,
// budgets, member lists or audit contents, and a platform admin gets nothing inside a company from it.
// STUB from Stage 0: an empty router and an empty ROUTES table; Stage 2A builds it (view
// server/views/business/platform.js, a tab in server/views/trips/admin.js).
//
// What 2A adds (method, path relative to MOUNT, who, limiters → service method):
//   GET  /                platform  -          → platformListOrgs (pending first; company enquiries)
//   POST /:orgId/status   platform  bizWrite   → platformSetStatus (status=active|suspended, note, rev) → 303 /admin/business?ok=…
const express = require('express');

/** Where app.js mounts this router; ROUTES paths are relative to it. */
const MOUNT = '/admin/business';

/** This router's routes (types.RouteEntry, who 'platform'). Empty until Stage 2A. */
const ROUTES = Object.freeze([]);

/**
 * @param {object} ctx the app context (ctx.business is the BusinessService)
 * @param {import('../business/types').RouterDeps} deps routes/business/index.createRouterDeps(ctx)
 * @returns {import('express').Router}
 */
function router(ctx, deps) {
  return express.Router();
}

module.exports = { MOUNT, router, ROUTES };
