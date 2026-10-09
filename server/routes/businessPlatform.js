// The platform admin's company list (plan §I8), mounted by app.js at MOUNT ('/admin/business') when
// ENABLE_BUSINESS is on, before /admin, with Travel by Budget on or off. Only platform admins
// (req.user.isAdmin, D1; the service asks accounts.isPlatformAdmin again) see it; everyone else gets the
// app's 404. It never shows requests, policies, budgets, member lists or audit contents, and a platform
// admin gets nothing inside a company from it (memberGate answers them 404 on /business/o/...).
//
//   GET  /                platform  -          → platformListOrgs (pending first; company enquiries; Tripelyx's own company)
//   POST /:orgId/status   platform  bizWrite   → platformSetStatus (status=active|suspended, note, rev) → 303 /admin/business?ok=…
//   POST /house           platform  bizWrite   → platformCreateHouseCompany ("Create Tripelyx Inc") → 303 /admin/business?ok=house|house_exists
//   POST /suppliers/check platform  bizWrite   → platformCheckSuppliers ("Check live connection", at most 3 an hour)
//                                                → 303 /admin/business?ok=check_passed|check_failed|check_mismatch
//   POST /suppliers/live  platform  bizWrite   → platformSetLive (on=1|0, rev) → 303 /admin/business?ok=live_on|live_off
//
// The Suppliers panel (go-live design §5.4) shows only on a live-keys stack (platformSuppliers answers null
// anywhere else, and the page is as it was); the two POSTs refuse there with the page and a 409.
// Mounted from TABLE by routes/business/table.mountTable: a POST runs bizWrite → sameOrigin → the form
// parser → the platform gate → the handler. The gate sends no-store and noindex on every answer.
const express = require('express');
const { privateHeaders, sendNotFound } = require('../business/http');
const { assertRoutes } = require('./business/index');
const { send, clientError, routesOf, mountTable } = require('./business/table');
const { platformView } = require('../views/business/platform');
const { HOUSE_COMPANY_NAME } = require('../business/constants');

/** Where app.js mounts this router; ROUTES paths are relative to it. */
const MOUNT = '/admin/business';

const TABLE = [
  { method: 'GET', path: '/', perm: null, own: false, limiter: [], who: 'platform', handler: 'listPage' },
  { method: 'POST', path: '/:orgId/status', perm: null, own: false, limiter: ['bizWrite'], who: 'platform', handler: 'statusPost' },
  { method: 'POST', path: '/house', perm: null, own: false, limiter: ['bizWrite'], who: 'platform', handler: 'housePost' },
  { method: 'POST', path: '/suppliers/check', perm: null, own: false, limiter: ['bizWrite'], who: 'platform', handler: 'checkPost' },
  { method: 'POST', path: '/suppliers/live', perm: null, own: false, limiter: ['bizWrite'], who: 'platform', handler: 'livePost' },
];

/** This router's routes (types.RouteEntry, who 'platform'). */
const ROUTES = assertRoutes(routesOf(TABLE), { mount: MOUNT });

/** ?ok= codes → the notice, naming the company (?org=<id>) when it is still listed. */
const NOTICES = Object.freeze({
  active: name => `Done. ${name} is active, and its people can join by invite.`,
  suspended: name => `Done. ${name} is paused. Its members see that Tripelyx paused it.`,
  house: () => `Done. ${HOUSE_COMPANY_NAME} is active, and you're its Owner.`,
  house_exists: () => `${HOUSE_COMPANY_NAME} already exists, so nothing new was made.`,
  check_passed: () => 'Done. The live check passed. You can turn live search on.',
  live_on: () => 'Done. Live search is on. Confirmed companies now search live prices.',
  live_off: () => 'Done. Live search is off. Companies see "Supplier not connected yet".',
});
/** ?ok= codes for a live check that did not pass: shown as a problem, not a notice. */
const CHECK_PROBLEMS = Object.freeze({
  check_failed: 'The live check did not pass, so live search stays off. What it found is under Suppliers.',
  check_mismatch: 'A supplier answered in test mode, so live search is off. Check the key in AWS, then run the live check again.',
});
/** A lost compare-and-set (a double click, or a form loaded before another change): the page shows the latest. */
const STALE = 'Someone changed this while you were looking. Here is the latest version.';
const ORG_ID = /^org_[A-Za-z0-9_-]{16}$/;

const one = v => (typeof v === 'string' ? v : '');
const okHref = (status, orgId) => `${MOUNT}?ok=${status === 'suspended' ? 'suspended' : 'active'}${ORG_ID.test(orgId) ? `&org=${orgId}` : ''}`;

/**
 * @param {object} ctx the app context (ctx.business is the BusinessService)
 * @param {import('../business/types').RouterDeps} deps routes/business/index.createRouterDeps(ctx)
 * @returns {import('express').Router}
 */
function router(ctx, deps) {
  const r = express.Router();
  const svc = ctx.business;

  /** Platform admins only; anyone else (signed out included) gets the app's 404, never a sign-in page. */
  function bizPlatformGate(req, res, next) {
    privateHeaders(res);
    if (!req.user || req.user.isAdmin !== true) return sendNotFound(ctx, res);
    next();
  }
  const gate = () => [bizPlatformGate];

  /** The company list, or null when the service answers 404 (not a platform admin after all). */
  async function listOrgs(req) {
    try {
      return await svc.platformListOrgs({ user: req.user });
    } catch (e) {
      if (clientError(e) && e.status === 404) return null;
      throw e;
    }
  }

  async function render(req, res, { status = 200, notice = null, error = null, form = null, data = null } = {}) {
    const list = data || await listOrgs(req);
    if (!list) return sendNotFound(ctx, res);
    // The Suppliers panel: null anywhere but a live-keys stack (the page is then as it was).
    const suppliers = await svc.platformSuppliers({ user: req.user });
    const text = typeof notice === 'function' ? notice(list) : notice;
    return send(res, status, platformView(ctx, { data: { ...list, suppliers }, notice: text, error, form }));
  }

  const handlers = {
    async listPage(req, res) {
      const ok = one(req.query.ok);
      const orgId = one(req.query.org);
      const notice = Object.hasOwn(NOTICES, ok) ? list => {
        const o = (list.orgs || []).find(x => x.id === orgId);
        return NOTICES[ok](o ? o.name : 'The company');
      } : null;
      return render(req, res, { notice, error: Object.hasOwn(CHECK_PROBLEMS, ok) ? CHECK_PROBLEMS[ok] : null });
    },

    async statusPost(req, res) {
      const b = req.body || {};
      const orgId = req.params.orgId;
      const status = one(b.status);
      try {
        const org = await svc.platformSetStatus({ user: req.user }, orgId, { status, note: one(b.note), rev: one(b.rev) });
        return res.redirect(303, okHref(org.status, org.id));
      } catch (e) {
        if (!clientError(e)) throw e;
        if (e.status === 404) return sendNotFound(ctx, res);
        if (e.code === 'conflict') {
          // A double click: the first post already made the change asked for, so this one lands where it did.
          // Otherwise someone (or this admin in another tab) changed the company first: the latest, with the note kept.
          const data = await listOrgs(req);
          if (!data) return sendNotFound(ctx, res);
          const now = (data.orgs || []).find(o => o.id === orgId);
          if (now && (status === 'active' || status === 'suspended') && now.status === status) return res.redirect(303, okHref(status, orgId));
          return render(req, res, { status: 409, error: STALE, data, form: one(b.note) ? { orgId, note: one(b.note), errors: {} } : null });
        }
        return render(req, res, {
          status: e.status,
          error: e.message,
          form: e.status === 422 ? { orgId, note: one(b.note), errors: e.details || {} } : null,
        });
      }
    },

    /** "Create Tripelyx Inc": a second press (or two at once) makes nothing and lands on the same page. */
    async housePost(req, res) {
      try {
        const r = await svc.platformCreateHouseCompany({ user: req.user });
        return res.redirect(303, `${MOUNT}?ok=${r.created ? 'house' : 'house_exists'}`);
      } catch (e) {
        if (!clientError(e)) throw e;
        if (e.status === 404) return sendNotFound(ctx, res);
        return render(req, res, { status: e.status, error: e.message });
      }
    },

    /** "Check live connection": the result is stored with the switch, so the page after the 303 shows it. */
    async checkPost(req, res) {
      try {
        const r = await svc.platformCheckSuppliers({ user: req.user });
        return res.redirect(303, `${MOUNT}?ok=${r.passed ? 'check_passed' : r.mismatch ? 'check_mismatch' : 'check_failed'}`);
      } catch (e) {
        if (!clientError(e)) throw e;
        if (e.status === 404) return sendNotFound(ctx, res);
        return render(req, res, { status: e.status, error: e.message });
      }
    },

    /** "Turn on live search" / "Turn off live search". A double click lands where the first one did. */
    async livePost(req, res) {
      const b = req.body || {};
      const on = one(b.on);
      try {
        const doc = await svc.platformSetLive({ user: req.user }, { on, rev: one(b.rev) });
        return res.redirect(303, `${MOUNT}?ok=${doc.on === true ? 'live_on' : 'live_off'}`);
      } catch (e) {
        if (!clientError(e)) throw e;
        if (e.status === 404) return sendNotFound(ctx, res);
        if (e.code === 'conflict') {
          const now = await svc.platformSuppliers({ user: req.user });
          if (now && now.stored && (on === '1' || on === '0') && now.stored.on === (on === '1')) return res.redirect(303, `${MOUNT}?ok=${on === '1' ? 'live_on' : 'live_off'}`);
          return render(req, res, { status: 409, error: STALE });
        }
        return render(req, res, { status: e.status, error: e.message });
      }
    },
  };

  return mountTable(r, TABLE, { deps, gate, handlers });
}

module.exports = { MOUNT, router, ROUTES };
