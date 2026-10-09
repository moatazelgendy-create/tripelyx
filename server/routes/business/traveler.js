// Traveler and approver routes (plan §B4 "Trips and approvals", §H1 to §H3), built by Stage 2B. Paths are
// relative to MOUNT ('/business'). Every route runs memberGate per route (never a path-less r.use()), and the
// router is built from the ROUTES table itself, so the table and the Express stack cannot drift apart.
//
//   GET  /o/:orgId                       org.view                                    → dashboard({ view: 'home' })
//   GET  /o/:orgId/policy                org.view                                    → getPolicy(actor, null)
//   GET  /o/:orgId/trips/new             trip.request                                → (form; inventory status)
//   GET  /o/:orgId/trips/search          trip.request                bizCompute      → searchTrip (writes nothing)
//   POST /o/:orgId/trips                 trip.request                bizWrite, bizCompute → createRequest → 303 /trips/:rid
//   GET  /o/:orgId/trips                 request.view.own|team|all                   → listRequests (?scope, filters, cursor)
//   GET  /o/:orgId/trips/:rid            request.view.*, approval.*  own:'request'   → getRequest
//   POST /o/:orgId/trips/:rid/swap       request.view.own            own:'request'   bizWrite, bizCompute → swap
//   POST /o/:orgId/trips/:rid/submit     request.view.own            own:'request'   bizWrite, bizCompute → submit
//   POST /o/:orgId/trips/:rid/cancel     request.view.own, approval.override own:'request' bizWrite → cancel
//   POST /o/:orgId/trips/:rid/decide     approval.decide, approval.override own:'request' bizWrite, bizCompute → decide
//   POST /o/:orgId/trips/:rid/message    request.view.own, approval.* own:'request'  bizWrite → message
//   GET  /o/:orgId/approvals             approval.decide                             → inbox (?tab, cursor)
//
// Every route starts with noStore (Cache-Control: no-store, X-Robots-Tag: noindex, so even a limiter's 429 is
// private), then every POST runs limiter(s) → sameOrigin → form → memberGate → handler, and answers 303 to the
// request page with ?ok=<code> (mapped to fixed text by the view) on success. A decision that sent the trip
// back to a traveler the decider can no longer see (an assigned approver who is not their manager) answers
// 303 to the Approvals inbox with ?ok=returned instead. A decider's view of a pending request prices it again
// (getRequest's live check), so that one GET counts against bizCompute inside its handler, after the gate;
// every other view is free. A refusal the traveler or approver can act on
// re-renders the page it came from, with the service's message and what they typed, and its own status:
// 422 (a reason too short, a card number, a blocked trip, a past departure), 409 (someone acted first, the
// request expired), 410 (an alternative that is gone), 503 (no supplier). 404 and 403 answer with the app's
// pages, as memberGate does. GETs never write: an expired request shows as expired, and the search reads
// prices without storing anything.
//
// Real suppliers (real-suppliers design §2.4): a supplier that fails ('supplier_unavailable', 503) or a
// company that used up its supplier calls ('supplier_busy', 429) is said on the page, never thrown to the
// error page: a search or a new draft goes back to the trip form with the query kept and the message; a
// swap, submit or decide re-renders the request page, untouched. When the price check at submit or decide
// could not run, the page says "The price couldn't be checked just now, so nothing changed." (503) or the
// supplier_busy text (429): a request is never approved without a check, nor sent back because of an outage.
// Live prices (go-live design §5.5) add the daily limit ('supplier_daily_limit', 429, naming when search opens
// again) and a company Tripelyx hasn't confirmed ('company_not_confirmed', 409), said the same way.
// A failure that left search off (inventory status 'none' after it: a mode mismatch turns live search off until
// a platform admin turns it on again) never says "try again in a few minutes": a search or a new draft gets the
// trip form with its search-off panel alone, and a submit, decide or swap says trip search is off and nothing
// changed (PRICE_CHECK_COPY.searchOff), as it does for a trip priced on live prices refused with 503
// 'no_supplier' while live search is off (never "Supplier not connected yet": that trip was priced on them).
// The search-off panel is "Supplier not connected yet" for a company that has priced nothing on live prices.
// One that already has trips priced on them is told that trip search is turned off for now and its trips keep
// their prices (parts.SEARCH_OFF on home and the trip form, NO_TRIPS.textSearchOff where its own list is empty),
// never that Tripelyx hasn't connected airlines and hotels: one read of its newest request on those pages, and
// only while search is off (liveTrips).
const express = require('express');
const { AppError } = require('../../lib/errors');
const { PRICE_CHECK_COPY, requestSource } = require('../../business/source');
const { gates } = require('../../business/http');
const roles = require('../../business/roles');
const { TIER_LABELS, KINDS } = require('../../business/constants');
const { periodChoices, currentPeriodKey } = require('../../business/budgets');
const { LIST_FILTER_FIELDS } = require('../../views/business/trips');
const { shellView } = require('../../views/business/shell');
const { workspaceForbiddenView } = require('../../views/business/auth');
const { homeView } = require('../../views/business/home');
const { policyMineView } = require('../../views/business/policyMine');
const { tripNewView, formValues } = require('../../views/business/tripNew');
const { resultsView } = require('../../views/business/results');
const { requestView } = require('../../views/business/request');
const { tripsView } = require('../../views/business/trips');
const { approvalsView } = require('../../views/business/approvals');

const VIEW_REQUEST = Object.freeze(['request.view.own', 'request.view.team', 'request.view.all', 'approval.decide', 'approval.override']);
const DECIDE = Object.freeze(['approval.decide', 'approval.override']);

const entry = (method, path, perm, { own = false, limiter = [] } = {}) => Object.freeze({
  method, path, perm: Array.isArray(perm) ? Object.freeze([...perm]) : perm, own, limiter: Object.freeze([...limiter]), who: 'member',
});

/** This router's routes (types.RouteEntry), in mount order. */
const ROUTES = Object.freeze([
  entry('GET', '/o/:orgId', 'org.view'),
  entry('GET', '/o/:orgId/policy', 'org.view'),
  entry('GET', '/o/:orgId/trips/new', 'trip.request'),
  entry('GET', '/o/:orgId/trips/search', 'trip.request', { limiter: ['bizCompute'] }),
  entry('POST', '/o/:orgId/trips', 'trip.request', { limiter: ['bizWrite', 'bizCompute'] }),
  entry('GET', '/o/:orgId/trips', ['request.view.own', 'request.view.team', 'request.view.all']),
  entry('GET', '/o/:orgId/trips/:rid', VIEW_REQUEST, { own: 'request' }),
  entry('POST', '/o/:orgId/trips/:rid/swap', 'request.view.own', { own: 'request', limiter: ['bizWrite', 'bizCompute'] }),
  entry('POST', '/o/:orgId/trips/:rid/submit', 'request.view.own', { own: 'request', limiter: ['bizWrite', 'bizCompute'] }),
  entry('POST', '/o/:orgId/trips/:rid/cancel', ['request.view.own', 'approval.override'], { own: 'request', limiter: ['bizWrite'] }),
  entry('POST', '/o/:orgId/trips/:rid/decide', DECIDE, { own: 'request', limiter: ['bizWrite', 'bizCompute'] }),
  entry('POST', '/o/:orgId/trips/:rid/message', ['request.view.own', 'approval.decide', 'approval.override'], { own: 'request', limiter: ['bizWrite'] }),
  entry('GET', '/o/:orgId/approvals', 'approval.decide'),
]);

/** A query-string or form value as one trimmed string ('' for anything else, e.g. a repeated field). */
const one = v => (typeof v === 'string' ? v.trim() : '');

/** The search form's fields, as the query string or the POST /trips form carries them (types.RawTripQuery). */
const QUERY_FIELDS = Object.freeze(['from', 'to', 'depart', 'return', 'hotel', 'nights', 'cabin', 'flex']);
function rawQuery(src) {
  const out = {};
  for (const k of QUERY_FIELDS) {
    const v = src ? src[k] : undefined;
    if (v === undefined) continue;
    // A repeated field stays an array, so parseTripQuery refuses it with its own words.
    out[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return out;
}

/** A refusal the page itself explains (a 4xx AppError other than 404, 403 and 429). */
const shown = e => e instanceof AppError && e.status >= 400 && e.status < 500 && ![403, 404, 429].includes(e.status);
const isStatus = (e, status) => e instanceof AppError && e.status === status;
/**
 * A real supplier that failed (503), the company's hourly or daily supplier limit (429), or live search for a
 * company Tripelyx hasn't confirmed (409): said on the page, never thrown.
 */
const SUPPLIER_FAILS = Object.freeze(['supplier_unavailable', 'supplier_busy', 'supplier_daily_limit', 'company_not_confirmed']);
const supplierFail = e => e instanceof AppError && SUPPLIER_FAILS.includes(e.code);

function send(res, status, page) {
  res.status(status).type('html').send(String(page));
}

/**
 * @param {object} ctx the app context (ctx.business is the BusinessService)
 * @param {import('../../business/types').RouterDeps} deps
 * @returns {import('express').Router}
 */
function router(ctx, deps) {
  const r = express.Router();
  // A paused company, or a role refusal the shell can't draw, gets the Business page that says why (as the
  // admin pages do), not the app's generic error page.
  const g = gates(ctx, { forbiddenView: workspaceForbiddenView });
  const svc = () => ctx.business;
  const NO_INVENTORY = Object.freeze({ status: 'none', airports: () => [], cityFor: () => null });
  const inventory = () => (ctx.business && ctx.business.inventory) || NO_INVENTORY;
  /** Search is off now (read after a failure: a mode mismatch turns it off during the call). */
  const searchOff = () => inventory().status === 'none';

  /**
   * Is search off for a company that already has trips priced on live prices? Its pages then say trip search is
   * turned off for now (parts.SEARCH_OFF), never "Supplier not connected yet". One indexed read, and only while
   * search is off: the company's newest request (Repo.page, one row). No request is made while search is off, so
   * the newest one was priced the last time search was on: on live prices once a company has used live search.
   */
  async function liveTrips(req) {
    if (!searchOff() || !svc() || !svc().repo) return false;
    const { rows } = await svc().repo.page(KINDS.request, req.biz.org.id, { limit: 1 });
    return rows.length > 0 && requestSource(rows[0]) === 'live';
  }

  /** Answer an AppError with the app's 404 or 403 page; anything else goes to the app's error handler. */
  function refuse(res, next, e) {
    if (isStatus(e, 404)) return g.notFound(res);
    if (isStatus(e, 403)) {
      return g.forbidden(res, { message: e.message, role: e.role || null, reason: e.code === 'org_suspended' ? 'suspended' : 'role' });
    }
    return next(e);
  }

  /**
   * Mount one ROUTES entry: noStore → limiters → (POST: sameOrigin → form) → memberGate → handler. noStore is
   * no gate: it only marks the answer private, so a limiter's 429 is never cached or indexed either.
   */
  function mount(path, method, handler) {
    const e = ROUTES.find(x => x.path === path && x.method === method);
    if (!e) throw new Error(`[business] ${method} ${path} is not in traveler ROUTES`);
    const chain = [g.noStore, ...e.limiter.map(name => deps.limits[name])];
    if (method === 'POST') chain.push(deps.sameOrigin, deps.form);
    chain.push(g.memberGate(e.perm, { own: e.own }));
    const run = async (req, res, next) => {
      try { await handler(req, res, next); } catch (err) { refuse(res, next, err); }
    };
    r[method.toLowerCase()](path, ...chain, run);
  }

  const page = async (req, res, status, opts) => send(res, status, shellView(ctx, await g.shellContext(req), opts));
  const tripsBase = req => `/business/o/${req.biz.org.id}/trips`;

  /** The member's department name (org.view), or null. */
  async function departmentName(req, departmentId) {
    if (!departmentId) return null;
    const list = await svc().listDepartments(req.biz.actor);
    const d = list.find(x => x.id === departmentId);
    return d ? d.name : null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Home and policy

  mount('/o/:orgId', 'GET', async (req, res) => {
    const dash = await svc().dashboard(req.biz.actor, { view: 'home' });
    const body = homeView(ctx, { org: req.biz.org, member: req.biz.member, dash, inventoryStatus: inventory().status, liveTrips: await liveTrips(req) });
    await page(req, res, 200, { title: '', body });
  });

  mount('/o/:orgId/policy', 'GET', async (req, res) => {
    const policy = await svc().getPolicy(req.biz.actor, null);
    await page(req, res, 200, { title: 'Your travel policy', body: policyMineView(ctx, { org: req.biz.org, member: req.biz.member, policy }) });
  });

  // ---------------------------------------------------------------------------------------------------------
  // Plan a trip, search, create the draft

  /** The trip form page (also the answer to a search the form must fix: 422, or 503 with no supplier). */
  async function formPage(req, res, status, { values, errors = {}, error = null }) {
    const m = req.biz.member;
    const body = tripNewView(ctx, {
      org: req.biz.org, inventory: inventory(), values, errors, error,
      departmentName: await departmentName(req, m.departmentId), tierLabel: TIER_LABELS[m.tier] || m.tier,
      liveTrips: await liveTrips(req),
    });
    // With no supplier the form carries the "Supplier not connected yet" panel (or, for a company with trips
    // priced on live prices, the "turned off for now" one) itself, so the shell's ribbon (searchPage) would say
    // it twice.
    await page(req, res, status, { title: 'Plan a work trip', body, searchPage: false });
  }

  mount('/o/:orgId/trips/new', 'GET', async (req, res) => {
    await formPage(req, res, 200, { values: formValues(rawQuery(req.query)) });
  });

  /**
   * The results page for a raw query, or the trip form when the query needs fixing. `pick` re-renders a
   * POST /trips the service refused: its selection stays checked, its purpose filled in, with the error.
   */
  async function resultsPage(req, res, raw, { status = 200, pick = null, error = null, errors = {}, missing = [] } = {}) {
    let view;
    try {
      view = await svc().searchTrip(req.biz.actor, raw);
    } catch (e) {
      if (isStatus(e, 422)) return formPage(req, res, 422, { values: formValues(raw), errors: e.details || {}, error: e.message });
      // A supplier that failed, or the company's supplier limit: the form, the query kept, the message. A
      // failure that turned search off: the form's own panel says so, alone.
      if (supplierFail(e)) return formPage(req, res, e.status, { values: formValues(raw), error: searchOff() ? null : e.message });
      if (isStatus(e, 503)) return formPage(req, res, 503, { values: formValues(raw) });
      throw e;
    }
    if (view.status === 'none') return formPage(req, res, 503, { values: formValues(raw) });
    const body = resultsView(ctx, {
      org: req.biz.org, view, all: one(req.query.all) === '1', pick, error, errors, missing, action: tripsBase(req),
    });
    await page(req, res, status, { title: 'Trip results', body, searchPage: true });
  }

  mount('/o/:orgId/trips/search', 'GET', async (req, res) => {
    await resultsPage(req, res, rawQuery(req.query));
  });

  mount('/o/:orgId/trips', 'POST', async (req, res) => {
    const b = req.body || {};
    const raw = rawQuery(b);
    const selection = { out: one(b.out), back: one(b.back), hotelKey: one(b.hotelKey) };
    const pick = () => ({ out: selection.out, back: selection.back, hotel: selection.hotelKey, purpose: typeof b.purpose === 'string' ? b.purpose.slice(0, 200) : '' });
    // Every choice the results form still needs, named at once (the service stops at the first). The form
    // says it offered hotels with hotelChoice=1: then no hotelKey at all (not even "No hotel", which is '')
    // means no choice was made.
    const missing = [];
    if (!selection.out) missing.push('out');
    if (typeof raw.return === 'string' && raw.return.trim() && !selection.back) missing.push('back');
    if (one(b.hotelChoice) === '1' && b.hotelKey === undefined) missing.push('hotel');
    if (missing.length) return resultsPage(req, res, raw, { status: 422, pick: pick(), missing });
    try {
      const request = await svc().createRequest(req.biz.actor, { query: raw, selection, purpose: typeof b.purpose === 'string' ? b.purpose : '' });
      return res.redirect(303, `${tripsBase(req)}/${request.id}`);
    } catch (e) {
      // A supplier failure is said on the trip form (the query kept): nothing was written, and searching
      // again for the results page would only ask the failing supplier once more.
      if (supplierFail(e)) return formPage(req, res, e.status, { values: formValues(raw), error: searchOff() ? null : e.message });
      if (!shown(e) && !isStatus(e, 503)) throw e;
      return resultsPage(req, res, raw, { status: e.status, pick: pick(), error: e.message, errors: e.details || {} });
    }
  });

  // ---------------------------------------------------------------------------------------------------------
  // Trip lists

  mount('/o/:orgId/trips', 'GET', async (req, res) => {
    const a = req.biz.actor;
    const role = req.biz.member.role;
    const scope = one(req.query.scope) || 'mine';
    const scopes = [['mine', 'request.view.own'], ['team', 'request.view.team'], ['all', 'request.view.all']].filter(([, p]) => roles.can(role, p)).map(([s]) => s);
    if (!['mine', 'team', 'all'].includes(scope)) return g.notFound(res);
    const filters = scope === 'all'
      ? { status: one(req.query.status), departmentId: one(req.query.departmentId), travelerId: one(req.query.travelerId), period: one(req.query.period) }
      : {};
    let list, filterError = null, filterErrors = {}, applied = filters;
    try {
      list = await svc().listRequests(a, { scope, ...filters, cursor: one(req.query.cursor) || null });
    } catch (e) {
      if (!isStatus(e, 422)) throw e;
      filterError = e.message;
      filterErrors = e.details || {};
      // Keep every filter the service accepted, so the list matches the selects that show as chosen; only
      // the refused ones are dropped (and the cursor, which belongs to the refused scan).
      applied = {};
      for (const k of LIST_FILTER_FIELDS) if (filters[k] && !Object.hasOwn(filterErrors, k)) applied[k] = filters[k];
      list = await svc().listRequests(a, { scope, ...applied });
    }
    let options = null;
    if (scope === 'all') {
      const departments = await svc().listDepartments(a);
      const travelers = [];
      if (roles.can(role, 'members.view')) {
        let cursor = null, pages = 0;
        do {
          const p = await svc().listMembers(a, { cursor });
          travelers.push(...p.members.map(m => ({ userId: m.userId, name: m.name })));
          cursor = p.cursor;
          pages += 1;
        } while (cursor && pages < 20);
      }
      options = { departments, travelers, periods: periodChoices(currentPeriodKey(req.biz.org, ctx.now())) };
    }
    // Only an empty list of the member's own trips says when search turns on.
    const live = scope === 'mine' && !list.rows.length ? await liveTrips(req) : false;
    const body = tripsView(ctx, { org: req.biz.org, member: req.biz.member, scope, scopes, list, filters: applied, options, query: req.query, filterError, filterErrors, liveTrips: live });
    await page(req, res, filterError ? 422 : 200, { title: 'Trips', body });
  });

  // ---------------------------------------------------------------------------------------------------------
  // One request: the page, and every POST on it

  /**
   * The request page. `form` re-renders what was typed into the form that failed (reason, category, note,
   * text, ack) so nothing typed is lost; `failed` names that form.
   */
  async function requestPage(req, res, { status = 200, error = null, failed = null, form = {}, refusal = null } = {}) {
    const view = await svc().getRequest(req.biz.actor, req.params.rid);
    const depName = await departmentName(req, view.request.departmentId);
    const body = requestView(ctx, {
      org: req.biz.org, member: req.biz.member, view, departmentName: depName, ok: one(req.query.ok), error, failed, form, refusal,
      base: `/business/o/${req.biz.org.id}`, confirm: one(req.query.confirm),
    });
    const title = view.self && view.status === 'draft' ? 'Review your trip' : 'Trip request';
    await page(req, res, status, { title, body });
  }

  /**
   * Will getRequest price this request again for this viewer (its live check)? Only for a pending request,
   * and only for someone who decides it: its assigned approver, or an override holder (who covers the pool,
   * which is drawn from Owners and Travel Admins). Never for the traveler.
   */
  function pricesAgain(req) {
    const r = req.biz.request;
    const m = req.biz.member;
    if (!r || r.travelerId === m.userId) return false;
    const decides = roles.can(m.role, 'approval.override') || (roles.can(m.role, 'approval.decide') && !!r.approval && r.approval.approverId === m.userId);
    if (!decides) return false;
    return svc().policy.effectiveStatus(r, ctx.now().toISOString(), req.biz.org.timezone) === 'pending';
  }

  /** Run one limiter (an Express middleware) inside a handler: resolves, or rejects with its 429 AppError. */
  const limit = (name, req, res) => new Promise((resolve, reject) => {
    Promise.resolve(deps.limits[name](req, res, err => (err ? reject(err) : resolve()))).catch(reject);
  });

  mount('/o/:orgId/trips/:rid', 'GET', async (req, res) => {
    // A decider's view asks the supplier for fresh prices: it counts as compute, as search and decide do.
    if (pricesAgain(req)) await limit('bizCompute', req, res);
    await requestPage(req, res);
  });

  /** Can this member still open the request (after a decision sent it back to its traveler as a draft)? */
  async function canOpen(req) {
    try {
      await svc().getRequest(req.biz.actor, req.params.rid);
      return true;
    } catch (e) {
      if (isStatus(e, 404)) return false;
      throw e;
    }
  }

  /** Run one request POST: 303 to the request page with ?ok=code, or the page again with the refusal. */
  function act(path, failed, run, okCode) {
    mount(path, 'POST', async (req, res) => {
      const b = req.body || {};
      try {
        const result = await run(req.biz.actor, req.params.rid, b);
        const code = okCode(result);
        // 'returned' makes the request a draft again: an assigned approver who is not the traveler's manager
        // can no longer open it, so their answer is the inbox, which says what happened.
        if (code === 'returned' && !(await canOpen(req))) return res.redirect(303, `/business/o/${req.biz.org.id}/approvals?ok=returned`);
        return res.redirect(303, `${tripsBase(req)}/${req.params.rid}?ok=${code}`);
      } catch (e) {
        if (!shown(e) && !isStatus(e, 503) && !supplierFail(e)) throw e;
        const form = {
          reason: typeof b.reason === 'string' ? b.reason.slice(0, 2000) : '', category: one(b.category),
          note: typeof b.note === 'string' ? b.note.slice(0, 1000) : '', ack: one(b.ackOverBudget) === '1',
          text: typeof b.text === 'string' ? b.text.slice(0, 1001) : '', action: one(b.action),
          // The alternative a 410 swap refused: the page leaves it out instead of offering it again.
          altId: e.code === 'alternative_gone' ? one(b.altId) : '',
        };
        // The price check at submit or decide could not reach the supplier: the request is untouched. With
        // search off now (the check met a mode mismatch, or a trip priced on live prices met search turned
        // off), trying again in a few minutes can't help. A swap searches again, so it is refused the same way.
        const checks = failed === 'submit' || failed === 'decide';
        const searches = checks || failed === 'swap';
        const off = searches && searchOff() && (e.code === 'supplier_unavailable' || (e.code === 'no_supplier' && requestSource(req.biz.request) === 'live'));
        const error = off ? PRICE_CHECK_COPY.searchOff : e.code === 'supplier_unavailable' && checks ? PRICE_CHECK_COPY.unchanged : e.message;
        return requestPage(req, res, { status: e.status, error, failed, form, refusal: e.code });
      }
    });
  }

  act('/o/:orgId/trips/:rid/swap', 'swap', (a, rid, b) => svc().swap(a, rid, { altId: one(b.altId), rev: one(b.rev) }), () => 'swapped');
  act('/o/:orgId/trips/:rid/submit', 'submit', (a, rid, b) => svc().submit(a, rid, { rev: one(b.rev), reason: typeof b.reason === 'string' ? b.reason : '', category: one(b.category) }), res => res.outcome);
  act('/o/:orgId/trips/:rid/cancel', 'cancel', (a, rid, b) => svc().cancel(a, rid, { rev: one(b.rev) }), () => 'cancelled');
  act('/o/:orgId/trips/:rid/decide', 'decide', (a, rid, b) => svc().decide(a, rid, {
    action: one(b.action), note: typeof b.note === 'string' ? b.note : '', ackOverBudget: one(b.ackOverBudget), rev: one(b.rev),
  }), res => res.outcome);
  act('/o/:orgId/trips/:rid/message', 'message', (a, rid, b) => svc().message(a, rid, { text: typeof b.text === 'string' ? b.text : '' }), () => 'message');

  // ---------------------------------------------------------------------------------------------------------
  // Approvals inbox

  mount('/o/:orgId/approvals', 'GET', async (req, res) => {
    const tab = one(req.query.tab) || 'waiting';
    const inbox = await svc().inbox(req.biz.actor, { tab, cursor: one(req.query.cursor) || null });
    const body = approvalsView(ctx, { org: req.biz.org, member: req.biz.member, inbox, override: roles.can(req.biz.member.role, 'approval.override'), ok: one(req.query.ok) });
    await page(req, res, 200, { title: 'Approvals', body });
  });

  return r;
}

module.exports = { router, ROUTES };
