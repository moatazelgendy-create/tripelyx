// Trip requests: search, draft, swap, submit, cancel, decide, ask a question, lists and the approvals inbox
// (plan §C4 to §C6, §F, §G, §H1 to §H3). BusinessService methods (service.js assigns `methods` onto its
// prototype); `this` is the service.
//
// Collaborators, ONLY through `this` (so the fakes stand in during Stage 1):
// - this.composer (types.TripComposer): parseQuery, search, price, variants, recheck;
// - this.policy (types.PolicyEngine): evaluateComponent, evaluateTrip, priceToBeat, limitsBar, describe,
//   benchmark/flightValues/hotelValues, resolveApprover, transition, effectiveStatus, expiresAt;
// - this.alternatives (types.AlternativesEngine): buildAlternatives, compareTrips;
// - this.explainer (types.GuardedExplainer): explain(input) (never throws; falls back to the rules text);
// - this.inventory (types.BusinessInventory): status, carriers() for names;
// - this.repo for every read and write; tz.js and budgets.js helpers directly (pure).
//
// Write rules:
// - GETs never write (getRequest, listRequests, inbox, inboxCount, liveCheck, searchTrip). An effectively
//   expired request shows as expired without a write.
// - Every POST re-reads the request, runs this.policy.transition on the fresh document inside the
//   repo.commit CAS fn, and commits the request, its links, the budget change and the audit together.
//   A stale form rev answers 409 'conflict' ("Someone else just acted on this request. Here is where it
//   stands now.").
// - A POST on a pending request with now ≥ expiresAt first commits the expiry (request CAS → expired, audit
//   'request.expired', the 'clock' system actor), then answers 409 'request_expired'.
// - Prices are never taken from a form: the selection keys are re-priced with this.composer.price, and the
//   policy re-evaluated with the tier's current policy on create, swap, re-price and submit (an approval
//   keeps the evaluation the request was submitted with).
// - evaluation.evaluatedAt is stamped from this.repo.iso().
// Errors common to all: 404 'not_found' (unknown id, another company's, or not visible to the member under
// roles.allowed with { own: 'request' }), 403 'forbidden', 403 'org_suspended', 409 'conflict', plus the
// lifecycle errors (lifecycle.js header) and 503 'no_supplier'.
//
// How a POST commits (settled in Stage 1W-b):
// - The request is read, the form's rev checked (409 'conflict' when it moved on), and the transition run once
//   on that document to learn its outcome, so the commit can carry the right audit entry, links and budget
//   change. The commit's request CAS (on the form's rev) runs the transition again on the fresh document and
//   refuses a different outcome. Budget holds and releases are CAS on the budget's rev as read (server side,
//   so a lost race re-runs the whole read-decide-commit under repo.withRetry and re-checks what is left).
// - A manual decision also checks the decider's member record at the rev read, so a role changed meanwhile
//   cannot slip through, and inserts the decider's 'decider' link (once).
// - Approver and pool links are insert-only and keyed by request, role and user, so a request submitted again
//   after a price change inserts only the links it does not have yet.
// - Pool membership is the request's own snapshot (approval.pool and approval.poolIds, written in the same
//   commit as the pool links): a pool link left from an earlier submission gives no say on the new one. The
//   member must also still be an admin (Owner or Travel Admin, the roles the pool is drawn from), so an admin
//   demoted meanwhile leaves the pool.
// - Each POST reads the clock once (nowIso) and uses it for the expiry check and every transition, so a
//   request crossing its expiresAt half-way is either decided as of that moment or expired and persisted.
// - Approving keeps the evaluation the request was submitted with (the verdict the approver is shown and
//   reports count); only the budget is read fresh for the hold.
// - A submit whose fresh evaluation is worse than the stored one (within became out, or out became blocked:
//   the budget was used up, or the policy changed) writes the re-evaluated draft instead (outcome
//   'repriced', audit 'request.repriced' with the policy check named), so the page shows the right form.
// - cheapestWithin is the cheapest option inside policy the traveler saw: a swap or a re-price that finds
//   none (the pick is within now) keeps the earlier one.
// - A re-priced draft (submit or approve finding a new price) keeps the convention of evaluateTrip: totalCents
//   is the sum of the components that still price, and an unavailable component evaluates as blocked.
//
// Real suppliers, round 1 (real-suppliers design §2.2, §2.4, §5.1):
// - Every draft (create, swap, re-price) stores `source`, the least real of its rows' price sources
//   (source.leastReal of sourceOf), and `demo` = source !== 'live'. Requests stored before carry no source and
//   read as demo through source.requestSource. RequestRow carries that `source` for the lists' labels.
// - Price checks say how far they may go with a real supplier: 'peek' on page views (getRequest, liveCheck:
//   never a search), 'confirm' at submit, 'final' at decide. A supplier failure at submit or decide
//   (503 supplier_unavailable, 429 supplier_busy) leaves the request untouched; getRequest turns the
//   source.LIVE_ERROR_CODES into RequestView.liveError, so the approver's page always opens.
// - EvalCtx.priceSource is the search's rows' source (else the inventory's): only the policy texts read it.
// - A supplier option can disappear between two calls (design §5.2, §5.4). A price check then finds it
//   'unavailable' (submit re-prices with why 'unavailable', decide sends the trip back), and a draft with a
//   part that is gone gets no alternatives (no variants are priced for it). A swap to an alternative that is
//   gone answers 410 'alternative_gone', and a pick that is gone by POST /trips 409 'option_unavailable':
//   never the 422 of a malformed form.
// Live prices (go-live design §5.5): only a company Tripelyx has confirmed ('active') searches, prices or
// re-checks; any other gets 409 'company_not_confirmed' before a supplier is called (getRequest: liveError).

const { AppError } = require('../lib/errors');
const { id: newId } = require('../lib/ids');
const tz = require('./tz');
const cards = require('./cards');
const roles = require('./roles');
const {
  KINDS, ID_PREFIX, PAGE_SIZE, SCAN_CAP, CURRENCY, TIER_LABELS, REQUEST_STATUSES, REASON_CATEGORIES,
} = require('./constants');
const { loadActor, need, who, systemActor, auditInsert, memberId, notFound, forbidden } = require('./actor');
const { text } = require('./validate');
const { memberScope, USER_ID_RE } = require('./repo');
const { periodKey, periodLabel, committedCents, PERIOD_KEY_RE } = require('./budgets');
const { ROW_KEY_RE } = require('./dto');
const { sourceOf, leastReal, requestSource, isSource, LIVE_ERROR_CODES, supplierError } = require('./source');

/** Purpose length on POST /trips. */
const PURPOSE_CHARS = Object.freeze([3, 140]);
/** Rows on the home page lists (waiting for you, my trips). */
const HOME_ROWS = 5;
/** List scopes on /trips and the permission each needs. */
const LIST_SCOPES = Object.freeze({ mine: 'request.view.own', team: 'request.view.team', all: 'request.view.all' });
/** Inbox tabs, in order. */
const INBOX_TABS = Object.freeze(['waiting', 'decided', 'company', 'expired']);

// ---------------------------------------------------------------------------------------------------------
// Helpers (module-private: the frozen export list is below)

/** The most history lines a request keeps (lifecycle.HISTORY_MAX; lifecycle is reached through this.policy). */
const HISTORY_KEEP = 50;
/** Who may decide, and who may see a request (with roles.allowed scopes). */
const DECIDE_PERMS = Object.freeze(['approval.decide', 'approval.override']);
const VIEW_PERMS = Object.freeze(['request.view.own', 'request.view.team', 'request.view.all', 'approval.decide']);
/** Links read per page. */
const LINK_PAGE = 200;
/** A department id and the effective statuses a list filter takes. */
const DEPARTMENT_ID_RE = /^dep_[A-Za-z0-9_-]{16}$/;
const EFFECTIVE_STATUSES = Object.freeze([...REQUEST_STATUSES, 'past']);
const COMPONENTS = Object.freeze(['out', 'back', 'hotel']);
const VERDICT_ORDER = Object.freeze({ within: 0, out: 1, blocked: 2 });

const RACE_MESSAGE = 'Someone else just acted on this request. Here is where it stands now.';
/** The 409 for a request that moved on (a stale form rev, or a lost race). retryable: withRetry may run it again. */
function race(retryable = false) {
  const e = new AppError('conflict', RACE_MESSAGE, 409);
  e.retryable = retryable === true;
  return e;
}
/** A Repo conflict (or a link another commit inserted first) in the request page's words. */
function asRace(e) {
  if (e instanceof AppError && e.code === 'conflict') throw race(e.retryable === true);
  if (e instanceof AppError && e.code === 'already_exists') throw race(false);
  throw e;
}
const expired = () => new AppError('request_expired', 'This request expired before anyone decided it. The trip can be planned again.', 409);

const gone = () => new AppError('alternative_gone', "That option isn't available anymore. Here are the current ones.", 410);
const optionUnavailable = () => new AppError('option_unavailable', "That option isn't available anymore. Pick another.", 409);
/**
 * Did composer.price refuse a key because the option is gone? A supplier's option can disappear between two
 * calls (a cached search or an offer expired, real-suppliers design §5.2): price() then answers 422
 * 'invalid_selection' marked `optionGone` (search.js _priceOne) for a key it no longer finds. With a
 * supplier's key, or prices from a supplier, that means the option is gone, not that the form was wrong. The
 * form's own mistakes (a return flight on a one-way search, a hotel without a stay, a cabin above the search)
 * carry no mark and stay 422. Demo keys on demo inventory keep today's answer.
 * @param {unknown} e
 * @param {Array<string|null|undefined>} keys the selection's row keys
 * @param {object|null} inventory
 */
function optionGone(e, keys, inventory) {
  if (!(e instanceof AppError) || e.code !== 'invalid_selection' || e.optionGone !== true) return false;
  const supplierPrices = !!inventory && inventory.status !== 'demo' && inventory.status !== 'none';
  return supplierPrices || keys.some(k => typeof k === 'string' && sourceOf(k) !== 'demo');
}
/** A row that no longer prices (gone from the supplier, sold out, or from another source). */
const isGoneRow = row => !!row && row.available === false;
const noSupplier = () => new AppError('no_supplier', "Supplier not connected yet. Tripelyx hasn't connected airlines and hotels for company travel.", 503);

/**
 * Live search calls suppliers only for companies Tripelyx has confirmed (go-live design §5.5): with live
 * prices, a company that is not 'active' searches, prices and re-checks nothing (409 'company_not_confirmed',
 * "Search opens once Tripelyx confirms your company."), before any supplier call. Demo and supplier test data
 * are as before. The gate refuses such a call again on its own (suppliers/gate.js).
 */
const searchOpen = (svc, org) => !(svc.inventory && svc.inventory.status === 'live' && (!org || org.status !== 'active'));
function assertSearchOpen(svc, org) {
  if (!searchOpen(svc, org)) throw supplierError('company_not_confirmed');
}

/** Form text bounds before the lifecycle checks it: it refuses a reason past 500 and a message past 1,000
 * characters in its own words (these bounds only keep a huge field out of memory); a decider's note is kept
 * to its first 500 characters. */
const REASON_INPUT_MAX = 2000;
/** The longest reason the lifecycle accepts (lifecycle.REASON_MAX_CHARS), for the one kept on a re-priced draft. */
const REASON_KEEP_MAX = 500;
const NOTE_INPUT_MAX = 500;
const MESSAGE_INPUT_MAX = 1001;

/** A form's rev (an integer or a digit string) as a number, or NaN. */
const formRev = rev => (typeof rev === 'number' ? (Number.isInteger(rev) && rev >= 0 ? rev : NaN) : /^\d{1,9}$/.test(String(rev ?? '')) ? Number(rev) : NaN);
const revOf = d => d.rev ?? 0;
const plain = v => (typeof v === 'string' ? v : '');

/**
 * The reason typed on a submit that came back 'repriced' (the trip changed before it was sent): kept on the
 * draft as request.reason, so the Request Approval form starts with it when the traveler sends it again. It
 * is cut to what the lifecycle accepts and never kept when it holds a card number; an empty field keeps the
 * reason already stored (one from a trip that came back from approval).
 * @param {{ text: string, category: string|null }} typed
 * @param {{ text: string, category: string|null }|null} [stored]
 * @returns {{ text: string, category: string|null }|null}
 */
function keptReason(typed, stored) {
  const t = text(typed && typed.text, REASON_KEEP_MAX, { multiline: true });
  if (!t || cards.hasCardNumber(t)) return stored && typeof stored.text === 'string' ? structuredClone(stored) : null;
  return { text: t, category: typed.category || null };
}

/** The roles the admins' pool is drawn from (approver resolution, plan §D). */
const POOL_ROLES = Object.freeze(['owner', 'travel_admin']);
/**
 * The member holds a place in this request's approval pool: named in the snapshot written with the pool
 * links, and still an admin (a pool member demoted to Manager no longer decides as the pool).
 */
const isPooled = (r, member) => !!member && POOL_ROLES.includes(member.role) && !!r.approval && r.approval.pool === true
  && Array.isArray(r.approval.poolIds) && r.approval.poolIds.includes(member.userId);

/** How this member would decide a request: 'assigned', 'pool', 'override', or null (never the traveler). */
function deciderRole(a, r) {
  const me = a.member.userId;
  if (r.travelerId === me) return null;
  const decides = roles.can(a.member.role, 'approval.decide');
  if (decides && r.approval && r.approval.approverId === me) return 'assigned';
  if (decides && isPooled(r, a.member)) return 'pool';
  if (roles.can(a.member.role, 'approval.override')) return 'override';
  return null;
}

/** May this member see the request (own, team, all, or as its decider)? */
const canSee = (a, r) => roles.allowedAny(a.member, VIEW_PERMS, r, { pooled: isPooled(r, a.member) });

/** A request of this company by id, or 404. */
async function readRequest(svc, a, rid) {
  const r = typeof rid === 'string' && rid ? await svc.repo.getIn(KINDS.request, rid, a.org.id) : null;
  if (!r) throw notFound();
  return r;
}

/** The trip's destination in words, for summaries. */
function destination(r) {
  if (r.rows && r.rows.hotel && r.rows.hotel.city) return r.rows.hotel.city;
  const segs = r.rows && r.rows.out && Array.isArray(r.rows.out.segments) ? r.rows.out.segments : [];
  return segs.length ? segs[segs.length - 1].to.city : r.query.to;
}
const tripOf = r => `${r.travelerName}'s trip to ${destination(r)}`;
// What a re-check found, in the audit's words: a price is named only when the totals differ (a terms-only change
// at the same total is 'changed' too, recheck.js).
const changedWhat = (rc, r, gone, price, terms) => (rc.status === 'unavailable' ? gone : rc.newTotalCents === r.totalCents ? terms : price);

/** Σ the components that price (an unavailable one counts 0, as evaluateTrip counts it). */
const rowsTotal = rows => COMPONENTS.reduce((n, c) => n + (rows[c] && Number.isInteger(rows[c].totalCents) ? rows[c].totalCents : 0), 0);

/** The insert of one request link (owner: the linked member's scope). */
function linkInsert(orgId, requestId, role, userId, at) {
  return {
    kind: KINDS.reqLink, id: `${requestId}.${role}.${userId}`, owner: memberScope(orgId, userId),
    data: { orgId, requestId, userId, role, at },
  };
}
/** The links of `wanted` that are not stored yet (links are insert-only). */
async function missingLinks(repo, orgId, wanted) {
  const have = await Promise.all(wanted.map(l => repo.getIn(KINDS.reqLink, l.id, orgId)));
  return wanted.filter((l, i) => !have[i]);
}

/** Every member of the company by user id (active and removed; paged, bounded). */
async function membersById(repo, orgId) {
  const out = {};
  let cursor = null, n = 0;
  do {
    const page = await repo.page(KINDS.member, orgId, { limit: 200, cursor });
    for (const m of page.rows) out[m.userId] = m;
    n += page.rows.length;
    cursor = page.cursor;
  } while (cursor && n < SCAN_CAP);
  return out;
}

/** The tier's current policy (every company has all three; a missing one is a broken record, not a 404). */
async function tierPolicy(repo, orgId, tier) {
  const p = await repo.getIn(KINDS.policy, `${orgId}.${tier}`, orgId);
  if (!p) throw new Error(`[business] the company has no ${tier} policy`);
  return p;
}

/** carriers() as code → name, for texts that name an airline. */
function carrierNames(inventory) {
  if (!inventory || inventory.status === 'none') return {};
  return Object.fromEntries(inventory.carriers().map(c => [c.code, c.name]));
}

/**
 * Where the inventory's prices come from (types.BusinessInventory.source). The frozen fakes carry no source:
 * then status 'demo' reads as 'demo', 'sandbox' as 'sandbox', 'live' as 'live', and 'none' (or no inventory) as null.
 */
function inventorySource(inventory) {
  if (!inventory || inventory.status === 'none') return null;
  if (isSource(inventory.source)) return inventory.source;
  return isSource(inventory.status) ? inventory.status : null;
}

/** The least real source of some rows (source.leastReal of each row's sourceOf), or null when there are none. */
const rowsSource = rows => leastReal((rows || []).filter(Boolean).map(r => sourceOf(r)));

/** The least real source of a search's rows, every leg. */
function searchedSource(searched) {
  const legs = (searched && searched.legs) || {};
  return rowsSource([legs.out, legs.back, legs.hotel].flatMap(leg => (leg && Array.isArray(leg.rows) ? leg.rows : [])));
}

/**
 * The EvalCtx of one company, tier policy and search (benchmarks from that search). priceSource: the
 * search's rows (else the inventory's), so the policy texts say "test fares" for supplier test data; demo
 * texts are unchanged.
 */
function evalCtx(svc, org, policy, searched, now) {
  const legs = (searched && searched.legs) || {};
  const benchmarks = {};
  if (legs.out) benchmarks.out = legs.out.benchmark;
  if (legs.back) benchmarks.back = legs.back.benchmark;
  if (legs.hotel) benchmarks.hotel = legs.hotel.benchmark[policy.rules.hotels.capBasis] || null;
  return {
    rules: policy.rules, policy: { tier: policy.tier, version: policy.version }, outOfPolicy: org.settings.outOfPolicy,
    today: tz.localDate(org.timezone, now), benchmarks, carriers: carrierNames(svc.inventory), orgName: org.name,
    priceSource: searchedSource(searched) || inventorySource(svc.inventory) || 'demo',
  };
}

/** The budget period a trip belongs to: its departure's local date, in the company's period. */
const tripPeriod = (org, query) => periodKey(query.departDate, org.settings.budgetPeriod);

/**
 * The budget a request would hold against (types.BudgetPreview), or null when its department has no budget
 * for the period. committedCents leaves the request's own hold out.
 */
async function budgetPreview(svc, org, departmentId, key, requestId) {
  if (!departmentId) return null;
  const budgetId = `${org.id}.${departmentId}.${key}`;
  const [b, dep] = await Promise.all([svc.repo.getIn(KINDS.budget, budgetId, org.id), svc.repo.getIn(KINDS.department, departmentId, org.id)]);
  if (!b) return null;
  const committed = committedCents(b, requestId);
  return {
    budgetId, departmentId, departmentName: dep ? dep.name : 'your department', periodKey: key, periodLabel: periodLabel(key),
    amountCents: b.amountCents, committedCents: committed, remainingCents: b.amountCents - committed, rev: revOf(b),
  };
}
/** The BudgetCtx evaluateTrip takes. */
const budgetCtx = p => (p ? { remainingCents: p.remainingCents, periodKey: p.periodKey, periodLabel: p.periodLabel, departmentName: p.departmentName } : null);

/** The budget CAS fn of an approval: add the request's hold once (idempotent); never past the budget unless allowed. */
function holdFn(requestId, cents, allowOver, at) {
  return d => {
    if (!d.commits || typeof d.commits !== 'object' || Array.isArray(d.commits)) d.commits = {};
    if (Object.hasOwn(d.commits, requestId)) return;
    if (!allowOver && committedCents(d) + cents > d.amountCents) throw race(true);
    d.commits[requestId] = cents;
    d.updatedAt = at;
  };
}
/** The budget CAS fn of a cancellation: drop the request's hold (idempotent). */
function releaseFn(requestId, at) {
  return d => {
    if (d.commits && Object.hasOwn(d.commits, requestId)) {
      delete d.commits[requestId];
      d.updatedAt = at;
    }
  };
}

/** The request CAS fn: run the transition again on the fresh document, refuse another outcome, apply it. */
function applyTransition(svc, event, opts, outcome) {
  return d => {
    const res = svc.policy.transition(d, event, opts);
    if (res.outcome !== outcome) throw race(true);
    Object.assign(d, structuredClone(res.next));
    if (res.history) d.history = [...(Array.isArray(d.history) ? d.history : []), structuredClone(res.history)].slice(-HISTORY_KEEP);
  };
}

/**
 * The alternatives of a pick that is not within policy: composer.variants → alternatives.buildAlternatives →
 * explainer (which sees no prices). Returns the DraftFields alternatives part, in the explainer's order.
 */
async function alternativesFor(svc, { ctx, budget, query, selection, rows, totalCents, evaluation, searched }) {
  // A pick with a part that no longer prices has no cheaper variants (composer.variants finds none for it), and
  // pricing a supplier key that is gone again would refuse it: so no variants are asked for.
  const v = COMPONENTS.some(c => isGoneRow(rows[c]))
    ? { candidates: [], searches: 0, truncated: false }
    : await svc.composer.variants(query, selection, {
      datesFlexible: query.datesFlexible === true, evaluate: row => svc.policy.evaluateComponent(row, ctx), searched, today: ctx.today,
    });
  const bctx = budgetCtx(budget);
  const result = svc.alternatives.buildAlternatives({
    pick: { selection, query, rows, totalCents }, pickEval: evaluation, candidates: v.candidates,
    evaluate: variant => svc.policy.evaluateTrip(variant.rows, ctx, { budget: bctx }), truncated: v.truncated === true,
  });
  const bySaving = [...result.alternatives].sort((x, y) => y.savesCents - x.savesCents || (x.id < y.id ? -1 : 1));
  const rank = new Map(bySaving.map((alt, i) => [alt.id, i + 1]));
  const said = await svc.explainer.explain({
    violations: evaluation.violations.map(x => ({ rule: x.rule })),
    alternatives: result.alternatives.map(alt => ({
      id: alt.id, kind: alt.kind, withinPolicy: alt.evaluation.status === 'within', savingsRank: rank.get(alt.id), giveUps: [...(alt.giveUps || [])],
    })),
    noneWithin: result.noneWithin === true,
  });
  const notes = said && said.notes && typeof said.notes === 'object' ? said.notes : {};
  const noteOf = altId => (typeof notes[altId] === 'string' ? notes[altId] : '');
  const byId = new Map(result.alternatives.map(alt => [alt.id, alt]));
  const order = [...(said && Array.isArray(said.order) ? said.order : []), ...byId.keys()];
  const alternatives = [];
  for (const altId of new Set(order)) if (byId.has(altId)) alternatives.push({ ...byId.get(altId), note: noteOf(altId) });
  return {
    alternatives,
    alternativesTruncated: result.truncated === true,
    cheapestWithin: result.cheapestWithin ? { ...result.cheapestWithin, note: noteOf(result.cheapestWithin.id) } : null,
    explanation: { summary: said && typeof said.summary === 'string' ? said.summary : '', explainer: svc.explainer.name },
  };
}

/**
 * The DraftFields of a pick: evaluated with the tier's current policy, benchmarks from `searched` and the
 * department's budget, with alternatives when it is not within policy.
 */
async function draftFields(svc, a, { tier, departmentId, requestId, query, selection, rows, pricedAt, searched, nowIso }) {
  const policy = await tierPolicy(svc.repo, a.org.id, tier);
  const ctx = evalCtx(svc, a.org, policy, searched, svc.now());
  const budget = await budgetPreview(svc, a.org, departmentId, tripPeriod(a.org, query), requestId);
  const totalCents = rowsTotal(rows);
  const ev = svc.policy.evaluateTrip(rows, ctx, { budget: budgetCtx(budget) });
  const alts = ev.status === 'within'
    ? { alternatives: [], alternativesTruncated: false, cheapestWithin: null, explanation: null }
    : await alternativesFor(svc, { ctx, budget, query, selection, rows, totalCents, evaluation: ev, searched });
  // Where these rows' prices came from (Request.source), so the request says so for as long as it lives;
  // request.demo is "not a real price" (true for demo and supplier test data).
  const source = rowsSource(COMPONENTS.map(c => rows[c])) || 'demo';
  return { query, selection, rows, pricedAt, totalCents, evaluation: { ...ev, evaluatedAt: nowIso }, ...alts, source, demo: source !== 'live' };
}

/** The cheapest option inside policy the traveler saw: a new draft that found none keeps the earlier one. */
const keepCheapest = (draft, r) => (draft.cheapestWithin || !r.cheapestWithin ? draft : { ...draft, cheapestWithin: r.cheapestWithin });

/** The draft a price check found changed or gone: the fresh rows, evaluated again, with fresh alternatives. */
async function repricedDraft(svc, a, r, rc, nowIso) {
  const rows = { out: null, back: null, hotel: null };
  for (const c of COMPONENTS) rows[c] = rc.components[c] ? rc.components[c].row : null;
  const searched = await svc.composer.search(r.query);
  return keepCheapest(await draftFields(svc, a, {
    tier: r.tier, departmentId: r.departmentId, requestId: r.id, query: r.query, selection: r.selection, rows, pricedAt: rc.at, searched, nowIso,
  }), r);
}

/**
 * A POST on a pending request past its expiry at nowIso (the POST's one clock reading): commit the expiry
 * (the clock's system actor, audit 'request.expired'), then answer 409 'request_expired'. Nothing happens
 * for any other request.
 */
async function expireIfDue(svc, a, r, nowIso) {
  const due = d => d && d.status === 'pending' && svc.policy.effectiveStatus(d, nowIso, a.org.timezone) === 'expired';
  if (!due(r)) return;
  await svc.repo.withRetry(async attempt => {
    const cur = attempt === 1 ? r : await svc.repo.getIn(KINDS.request, r.id, a.org.id);
    if (!due(cur)) return;
    const clock = systemActor('clock');
    const opts = { now: nowIso, actor: clock, member: null, org: a.org };
    const event = { type: 'expire' };
    svc.policy.transition(cur, event, opts);
    await svc.repo.commit({
      cas: [{ kind: KINDS.request, id: cur.id, rev: revOf(cur), server: true, fn: applyTransition(svc, event, opts, 'expired') }],
      inserts: [auditInsert(svc.repo, {
        orgId: a.org.id, actor: clock, action: 'request.expired', target: { kind: KINDS.request, id: cur.id },
        summary: `${tripOf(cur)} expired with no decision`,
      })],
    });
  });
  throw expired();
}

/** The purpose of a trip, cleaned: 3..140 characters, no card numbers (422 'invalid_purpose'). */
function cleanPurpose(raw) {
  const p = text(raw, PURPOSE_CHARS[1] + 1);
  const bad = message => new AppError('invalid_purpose', 'Check the highlighted fields.', 422, { purpose: message });
  if (p.length < PURPOSE_CHARS[0] || p.length > PURPOSE_CHARS[1]) throw bad(`Say what the trip is for, in ${PURPOSE_CHARS[0]} to ${PURPOSE_CHARS[1]} characters.`);
  if (cards.hasCardNumber(p)) throw bad(cards.CARD_MESSAGE);
  return p;
}

/** The form's picks as a Selection (row keys only; prices never come from a form). 422 'invalid_selection'. */
function cleanSelection(pick) {
  const p = pick && typeof pick === 'object' ? pick : {};
  const key = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const sel = { out: key(p.out), back: key(p.back), hotel: key(p.hotelKey) };
  const bad = message => new AppError('invalid_selection', message, 422);
  if (!sel.out) throw bad('Choose an outbound flight.');
  for (const c of COMPONENTS) {
    const k = sel[c];
    if (k !== null && (!ROW_KEY_RE.test(k) || k.startsWith('h.') !== (c === 'hotel'))) throw bad("That option isn't part of this search.");
  }
  return sel;
}

/** Every priced row is in the company's currency (USD), or 422 'unsupported_currency'. */
function assertUsd(rows) {
  for (const c of COMPONENTS) {
    if (rows[c] && rows[c].currency !== CURRENCY) throw new AppError('unsupported_currency', 'Priced in another currency, not supported yet.', 422);
  }
}

/** A row of a request list. */
function requestRow(r, status) {
  return {
    id: r.id, travelerId: r.travelerId, travelerName: r.travelerName, departmentId: r.departmentId ?? null,
    from: r.query.from, to: r.query.to, departDate: r.query.departDate, returnDate: r.query.returnDate ?? null,
    hotelCity: r.rows && r.rows.hotel ? r.rows.hotel.city : null, totalCents: r.totalCents, currency: r.currency || CURRENCY,
    pricedAt: r.pricedAt, status, policyStatus: r.evaluation ? r.evaluation.status : 'within', at: r.at,
    // Additive (real suppliers): where the total's prices came from, for the list's label.
    source: requestSource(r),
  };
}
/** A row of the approvals inbox. */
function inboxRow(r, status) {
  return {
    ...requestRow(r, status),
    violationsCount: r.evaluation && Array.isArray(r.evaluation.violations) ? r.evaluation.violations.length : 0,
    waitingSince: r.submittedAt ?? null, expiresAt: r.expiresAt ?? null, decidedAs: r.approval ? r.approval.decidedAs ?? null : null,
  };
}

/** The list filters, checked (422 'invalid_filter' with details by field). */
function listFilters(opts) {
  const details = {};
  const pick = (name, ok, message) => {
    const v = opts[name];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !ok(v)) { details[name] = message; return null; }
    return v;
  };
  const f = {
    status: pick('status', v => EFFECTIVE_STATUSES.includes(v), 'Choose a status from the list.'),
    departmentId: pick('departmentId', v => DEPARTMENT_ID_RE.test(v), 'Choose a department from the list.'),
    travelerId: pick('travelerId', v => USER_ID_RE.test(v), 'Choose a traveler from the list.'),
    period: pick('period', v => PERIOD_KEY_RE.test(v), 'Choose a period like 2026-Q4.'),
  };
  if (Object.keys(details).length) throw new AppError('invalid_filter', 'Check the highlighted fields.', 422, details);
  return f;
}
/** Does a request pass the list filters (status is its effective status)? */
function passes(r, f, status) {
  if (f.status && status !== f.status) return false;
  if (f.departmentId && r.departmentId !== f.departmentId) return false;
  if (f.travelerId && r.travelerId !== f.travelerId) return false;
  if (f.period && periodKey(r.query.departDate, f.period.includes('Q') ? 'quarter' : 'month') !== f.period) return false;
  return true;
}

/**
 * One page of rows from an owner's records, newest stored first: reads whole store pages until `want` rows
 * passed `accept`, the records run out, or SCAN_CAP records were read. accept(record) → a row or null.
 * Every row of a store page read is kept (so the cursor never skips a record), and a store page is never
 * smaller than PAGE_SIZE (so a filter that matches few records costs at most SCAN_CAP / PAGE_SIZE reads):
 * a page holds `want` rows when that many match in the first store page, and at most want + PAGE_SIZE − 1.
 */
async function scanPage(repo, kind, scope, { cursor = null, want = PAGE_SIZE, accept }) {
  const rows = [];
  let cur = cursor || null, scanned = 0;
  do {
    const page = await repo.page(kind, scope, { limit: Math.min(200, Math.max(want - rows.length, PAGE_SIZE)), cursor: cur });
    for (const row of await Promise.all(page.rows.map(accept))) if (row) rows.push(row);
    scanned += page.rows.length;
    cur = page.cursor;
  } while (cur && rows.length < want && scanned < SCAN_CAP);
  return { rows, cursor: cur };
}

/** Every record of one owner scope, newest stored first, up to SCAN_CAP. */
async function scanAll(repo, kind, scope) {
  const out = [];
  let cursor = null;
  do {
    const page = await repo.page(kind, scope, { limit: 200, cursor });
    out.push(...page.rows);
    cursor = page.cursor;
  } while (cursor && out.length < SCAN_CAP);
  return out;
}

/** The approver as the request page names them (approver, manager, or the admins' pool). */
function approverView(res, members) {
  if (!res || !res.rule) return null;
  if (res.rule === 'admin' || res.pool) {
    const names = (res.poolIds || []).map(u => (members[u] ? members[u].name : null)).filter(Boolean);
    if (!names.length) return null;
    const name = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} or ${names[1]}` : `${names[0]}, ${names[1]} or another admin`;
    return { userId: res.poolIds[0], name, rule: 'admin' };
  }
  const m = members[res.approverId];
  return m ? { userId: m.userId, name: m.name, rule: res.rule } : null;
}

/** A search leg's rows with their verdicts, ordered within → out → blocked, then total, departure, offer id. */
function legView(svc, leg, ctx, benchmark) {
  const priceKey = r => (r.available && Number.isInteger(r.totalCents) ? r.totalCents : Number.MAX_SAFE_INTEGER);
  const departKey = r => (r.kind === 'flight' && r.segments && r.segments.length ? r.segments[0].departLocal : '');
  const rows = (leg ? leg.rows : []).map(row => ({ row, evaluation: svc.policy.evaluateComponent(row, ctx) }));
  rows.sort((x, y) => VERDICT_ORDER[x.evaluation.status] - VERDICT_ORDER[y.evaluation.status]
    || priceKey(x.row) - priceKey(y.row)
    || (departKey(x.row) < departKey(y.row) ? -1 : departKey(x.row) > departKey(y.row) ? 1 : 0)
    || (x.row.offerId < y.row.offerId ? -1 : x.row.offerId > y.row.offerId ? 1 : 0)
    || (x.row.key < y.row.key ? -1 : x.row.key > y.row.key ? 1 : 0));
  const view = {
    rows,
    outsideCount: rows.filter(r => r.evaluation.status !== 'within').length,
    truncated: !!(leg && leg.truncated),
    benchmark: benchmark || { medianCents: null, sampleSize: 0, excluded: [] },
  };
  // Real suppliers only: what the search left out (the per-cause notices) and a hotel supplier's failure.
  if (leg && leg.skipped && typeof leg.skipped === 'object') view.skipped = leg.skipped;
  if (leg && leg.error) view.error = leg.error;
  if (leg && leg.error && leg.limit === true) view.limit = true;
  return view;
}

/** The inbox cursor: '<tab>.<offset>', a positive multiple of the page size (404 for anything else). */
function inboxOffset(cursor, tab) {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  const m = typeof cursor === 'string' ? /^([a-z]+)\.(\d{1,6})$/.exec(cursor) : null;
  const n = m ? Number(m[2]) : NaN;
  if (!m || m[1] !== tab || n <= 0 || n % PAGE_SIZE !== 0) throw notFound();
  return n;
}

/** Sort helper for ISO times and ids (null sorts first). */
const cmp = (x, y) => {
  const a = String(x ?? ''), b = String(y ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
};

/** The members with these user ids (getIn each; for names on a request page and in audit summaries). */
async function membersNamed(repo, orgId, ids) {
  const unique = [...new Set(ids.filter(u => typeof u === 'string' && u))];
  const found = await Promise.all(unique.map(u => repo.getIn(KINDS.member, memberId(orgId, u), orgId)));
  const out = {};
  for (const m of found) if (m) out[m.userId] = m;
  return out;
}

/** ' as Travel Admin (assigned to Dana Lee)': how an override decision is labelled in the audit log. */
async function overrideLabel(repo, a, r) {
  const ap = r.approval || {};
  const view = approverView(ap, await membersNamed(repo, a.org.id, [ap.approverId, ...(ap.poolIds || [])]));
  const role = roles.LABELS[a.member.role] || a.member.role;
  return view ? ` as ${role} (assigned to ${view.name})` : ` as ${role}`;
}

const methods = {
  /**
   * The results page (trip.request; GET /trips/search). today = tz.localDate(org.timezone, now);
   * this.composer.parseQuery → search; every row evaluated with this.policy.evaluateComponent against the
   * member's tier policy and benchmarks from the same search; rows ordered within → out → blocked, then
   * total, departure time, offer id. Writes nothing.
   * @param {import('./types').MemberActor} actor
   * @param {import('./types').RawTripQuery} raw the query string
   * @returns {Promise<import('./types').SearchView>} with status 'none' the legs are empty and nothing was searched
   * @throws {AppError} 422 'invalid_query' with per-field details; 403
   */
  async searchTrip(actor, raw) {
    const a = await loadActor(this.repo, actor);
    need(a, 'trip.request');
    const now = this.now();
    const policy = await tierPolicy(this.repo, a.org.id, a.member.tier);
    const dep = a.member.departmentId ? await this.repo.getIn(KINDS.department, a.member.departmentId, a.org.id) : null;
    const base = {
      policy: { tier: policy.tier, version: policy.version }, tierLabel: TIER_LABELS[policy.tier] || policy.tier, departmentName: dep ? dep.name : null,
    };
    if (!this.composer || !this.inventory || this.inventory.status === 'none') {
      return {
        status: 'none', query: null, ...base,
        limits: { heading: `Your limits for this search (${base.tierLabel} policy, v${policy.version})`, items: [] },
        legs: { out: legView(this, null, null, null), back: null, hotel: null }, pricedAt: null, blockedCarrierNames: [],
      };
    }
    assertSearchOpen(this, a.org);
    const query = this.composer.parseQuery(raw && typeof raw === 'object' ? raw : {}, { today: tz.localDate(a.org.timezone, now) });
    const searched = await this.composer.search(query);
    const ctx = evalCtx(this, a.org, policy, searched, now);
    const legs = searched.legs;
    const out = legView(this, legs.out, ctx, legs.out ? legs.out.benchmark : null);
    const back = legs.back ? legView(this, legs.back, ctx, legs.back.benchmark) : null;
    let hotel = null;
    if (legs.hotel) {
      const benchmark = legs.hotel.benchmark[policy.rules.hotels.capBasis] || null;
      const view = legView(this, legs.hotel, ctx, benchmark);
      const capped = view.rows.find(r => r.evaluation.cap && r.evaluation.cap.cents !== null && r.evaluation.cap.cents !== undefined);
      const hq = searched.query.hotel;
      hotel = { ...view, city: hq.city, country: hq.country, priceToBeatCents: this.policy.priceToBeat(capped ? capped.evaluation.cap.cents : null, benchmark) };
    }
    const blocked = new Set();
    for (const leg of [out, back]) {
      for (const r of leg ? leg.rows : []) {
        for (const v of r.evaluation.violations) if (v.rule === 'flight.carrier') blocked.add(ctx.carriers[r.row.carrier.code] || r.row.carrier.name);
      }
    }
    return {
      status: searched.status, query: searched.query, ...base, limits: this.policy.limitsBar(policy.rules, ctx, searched),
      legs: { out, back, hotel }, pricedAt: searched.pricedAt, blockedCarrierNames: [...blocked],
    };
  },

  /**
   * Create a draft from a pick (trip.request; POST /trips). In this order: parse the raw query
   * (composer.parseQuery); search the same legs again (composer.search) for the benchmarks; take that
   * SearchResult.query (the query as searched: search() may have moved hotel.checkIn to the outbound
   * arrival's local date, as it did for the results page) and use it for everything after, never the raw
   * re-parse: price the selection with composer.price(selection, searched.query), store it as
   * request.query. Then evaluate the trip with the budget preview, and when not within build alternatives
   * (composer.variants(searched.query, …) → alternatives.buildAlternatives → explainer.explain). One commit:
   * biz_request insert (status draft; the traveler's name, manager, department and tier snapshotted), the
   * traveler's biz_req_link, audit 'request.drafted'.
   * @param {import('./types').MemberActor} actor
   * @param {{ query: import('./types').RawTripQuery, selection: { out?: string, back?: string, hotelKey?: string }, purpose: string }} input
   *   selection.hotelKey: the form's hotel radio (named hotelKey because `hotel` is the "I need a hotel" box)
   * @returns {Promise<import('./types').Request>}
   * @throws {AppError} 422 'invalid_query'; 422 'invalid_selection'; 422 'invalid_purpose' (details.purpose,
   *   3..140 characters, no card numbers); 422 'unsupported_currency'; 409 'option_unavailable' when a
   *   picked option no longer prices ("That option isn't available anymore. Pick another."); 403; 503 'no_supplier'
   */
  async createRequest(actor, input) {
    const a = await loadActor(this.repo, actor);
    need(a, 'trip.request');
    const inp = input && typeof input === 'object' ? input : {};
    if (!this.composer || !this.inventory || this.inventory.status === 'none') throw noSupplier();
    assertSearchOpen(this, a.org);
    const parsed = this.composer.parseQuery(inp.query && typeof inp.query === 'object' ? inp.query : {}, { today: tz.localDate(a.org.timezone, this.now()) });
    const selection = cleanSelection(inp.selection);
    const purpose = cleanPurpose(inp.purpose);
    // The query as searched (search may move the hotel check-in), never the raw re-parse.
    const searched = await this.composer.search(parsed);
    const query = searched.query;
    const priced = await this.composer.price(selection, query).catch(e => {
      if (optionGone(e, COMPONENTS.map(c => selection[c]), this.inventory)) throw optionUnavailable();
      throw e;
    });
    if (priced.unavailable.length) throw optionUnavailable();
    assertUsd(priced.rows);
    const rid = newId(ID_PREFIX.request);
    const nowIso = this.repo.iso();
    const fields = await draftFields(this, a, {
      tier: a.member.tier, departmentId: a.member.departmentId || null, requestId: rid, query, selection, rows: priced.rows,
      pricedAt: priced.pricedAt, searched, nowIso,
    });
    const me = who(a);
    const doc = {
      id: rid, orgId: a.org.id, travelerId: a.member.userId, travelerName: me.name, travelerManagerId: a.member.managerId || null,
      departmentId: a.member.departmentId || null, tier: a.member.tier, status: 'draft', rev: 0, at: nowIso, updatedAt: nowIso, purpose,
      ...fields, currency: CURRENCY, originalTotalCents: fields.totalCents,
      reason: null, approval: null, submittedAt: null, expiresAt: null, budget: null, returned: null, messages: [],
      history: [{ at: nowIso, by: me, action: 'drafted', from: null, to: 'draft', note: '' }],
      booking: { status: 'not_open' },
    };
    const docs = await this.repo.commit({
      inserts: [
        { kind: KINDS.request, id: rid, owner: a.org.id, data: doc },
        linkInsert(a.org.id, rid, 'traveler', a.member.userId, nowIso),
        auditInsert(this.repo, {
          orgId: a.org.id, actor: me, action: 'request.drafted', target: { kind: KINDS.request, id: rid }, summary: `${me.name} planned a trip to ${destination(doc)}`,
        }),
      ],
    });
    return docs[`${KINDS.request}:${rid}`] || doc;
  },

  /**
   * A request page. Visible to the traveler, and to members whose request.view.team/all or approval role
   * reaches it (roles.allowed with { own: 'request' }, pooled when the member holds a pool link). Deciders
   * on a pending request also get `live` (composer.recheck with check 'peek', no write) and `comparison`
   * (alternatives.compareTrips against cheapestWithin). When the check cannot answer (supplier_unavailable,
   * supplier_busy, live_check_skipped, unsupported_currency) the page still opens: live is null and
   * `liveError` names the code (null otherwise). Writes nothing.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid btr_…
   * @returns {Promise<import('./types').RequestView>}
   * @throws {AppError} 404
   */
  async getRequest(actor, rid) {
    const a = await loadActor(this.repo, actor);
    const r = await readRequest(this, a, rid);
    if (!canSee(a, r)) throw notFound();
    const nowIso = this.repo.iso();
    const status = this.policy.effectiveStatus(r, nowIso, a.org.timezone);
    const me = a.member.userId;
    const self = r.travelerId === me;
    const role = deciderRole(a, r);
    const deciding = status === 'pending' && role !== null;
    const override = roles.can(a.member.role, 'approval.override');
    const today = tz.localDate(a.org.timezone, this.now());
    const can = {
      swap: self && status === 'draft' && Array.isArray(r.alternatives) && r.alternatives.length > 0,
      submit: self && status === 'draft',
      // An approved trip that has departed shows as 'past': override holders can still cancel it (never their
      // own: the traveler's limit is the departure date, as the lifecycle has it).
      cancel: (self && (status === 'draft' || status === 'pending'))
        || ((status === 'approved' || status === 'past') && ((self && today < r.query.departDate) || (override && !self))),
      decide: deciding,
      override: deciding && role === 'override',
      message: ['draft', 'pending', 'approved', 'past'].includes(status) && (self || role !== null),
    };

    let approver = null;
    if (r.approval && r.approval.mode === 'manual') {
      approver = approverView(r.approval, await membersNamed(this.repo, a.org.id, [r.approval.approverId, ...(r.approval.poolIds || [])]));
    } else if (self && status === 'draft') {
      const members = await membersById(this.repo, a.org.id);
      approver = approverView(this.policy.resolveApprover(members[me] || a.member, members), members);
    }

    let budget = null;
    if (status === 'draft' || status === 'pending') {
      budget = await budgetPreview(this, a.org, r.departmentId, tripPeriod(a.org, r.query), r.id);
    } else if ((status === 'approved' || status === 'past') && r.budget) {
      budget = await budgetPreview(this, a.org, r.departmentId, r.budget.periodKey, r.id);
    }

    let live = null, comparison = null, liveError = null;
    if (deciding && this.composer && !searchOpen(this, a.org)) {
      // Live prices for a company Tripelyx hasn't confirmed (again, after a rename): nothing is checked.
      liveError = 'company_not_confirmed';
    } else if (deciding && this.composer) {
      // A page view never searches a real supplier ('peek'): when the check can't answer (the supplier is
      // down, the company's hourly limit is used up, it would need a search, a row in another currency) the
      // page still opens and says so (liveError). No supplier at all (503 no_supplier) leaves live null.
      try {
        live = await this.composer.recheck(r, { check: 'peek' });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        if (LIVE_ERROR_CODES.includes(e.code)) liveError = e.code;
        else if (e.status !== 503) throw e;
      }
      if (r.cheapestWithin) comparison = this.alternatives.compareTrips({ rows: r.rows, totalCents: r.totalCents }, r.cheapestWithin);
    }

    let policyChanged = null;
    if ((status === 'draft' || status === 'pending') && r.evaluation && r.evaluation.policy) {
      const current = await tierPolicy(this.repo, a.org.id, r.tier);
      if (current.version !== r.evaluation.policy.version) policyChanged = { from: r.evaluation.policy.version, to: current.version };
    }
    return { request: r, status, self, can, approver, budget, live, liveError, comparison, policyChanged, timezone: a.org.timezone };
  },

  /**
   * The /trips lists, newest first, 50 per page. scope 'mine' (request.view.own), 'team' (request.view.team:
   * the requests roles.allowed(member, 'request.view.team', request, { pooled }) reaches, which is the
   * member's own, those they are the assigned approver of, those of travelers they manage
   * (travelerManagerId) and those they hold a pool link for; NOT their department's, so every Team row opens
   * through memberGate), 'all' (request.view.all) with filters.
   * @param {import('./types').MemberActor} actor
   * @param {{ scope?: 'mine'|'team'|'all', status?: string, departmentId?: string, travelerId?: string,
   *   period?: string, cursor?: string|null }} [opts] status: an EffectiveStatus; period: a PeriodKey
   * @returns {Promise<import('./types').Page<import('./types').RequestRow>>}
   * @throws {AppError} 403 for a scope the member lacks; 422 'invalid_filter' (details by field); 404 bad cursor
   */
  async listRequests(actor, opts) {
    const a = await loadActor(this.repo, actor);
    const o = opts && typeof opts === 'object' ? opts : {};
    const scope = o.scope === undefined || o.scope === null || o.scope === '' ? 'mine' : o.scope;
    if (typeof scope !== 'string' || !Object.hasOwn(LIST_SCOPES, scope)) {
      throw new AppError('invalid_filter', 'Check the highlighted fields.', 422, { scope: 'Choose a list.' });
    }
    need(a, LIST_SCOPES[scope]);
    const f = listFilters(o);
    const me = a.member.userId;
    const nowIso = this.repo.iso();
    const rowOf = r => {
      const status = this.policy.effectiveStatus(r, nowIso, a.org.timezone);
      return passes(r, f, status) ? requestRow(r, status) : null;
    };
    if (scope === 'mine') {
      return scanPage(this.repo, KINDS.reqLink, memberScope(a.org.id, me), {
        cursor: o.cursor, want: PAGE_SIZE,
        accept: async l => {
          if (l.role !== 'traveler') return null;
          const r = await this.repo.getIn(KINDS.request, l.requestId, a.org.id);
          return r && r.travelerId === me ? rowOf(r) : null;
        },
      });
    }
    const accept = scope === 'team'
      ? r => (roles.allowed(a.member, 'request.view.team', r, { pooled: isPooled(r, a.member) }) ? rowOf(r) : null)
      : rowOf;
    return scanPage(this.repo, KINDS.request, a.org.id, { cursor: o.cursor, want: PAGE_SIZE, accept });
  },

  /**
   * Use a cheaper alternative (the traveler, draft only; POST /trips/:rid/swap). The alternative's
   * selection is re-priced and re-evaluated, new alternatives built; originalTotalCents is kept; history
   * gets savedCents. One commit: request CAS (form rev), audit 'request.swapped'.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ altId: string, rev: string|number }} form
   * @returns {Promise<import('./types').Request>}
   * @throws {AppError} 404; 409 'invalid_transition'; 410 'alternative_gone' ("That option isn't available
   *   anymore. Here are the current ones."); 409 'conflict'
   */
  async swap(actor, rid, form) {
    const a = await loadActor(this.repo, actor);
    need(a, 'trip.request');
    const f = form && typeof form === 'object' ? form : {};
    const nowIso = this.repo.iso();
    const r = await readRequest(this, a, rid);
    if (!canSee(a, r)) throw notFound();
    await expireIfDue(this, a, r, nowIso);
    if (formRev(f.rev) !== revOf(r)) throw race();
    const me = who(a);
    const opts = { now: nowIso, actor: me, member: a.member, pooled: isPooled(r, a.member), org: a.org };
    const alt = (Array.isArray(r.alternatives) ? r.alternatives : []).find(x => x && x.id === f.altId) || null;
    if (!alt) {
      // The lifecycle words the refusal (not a draft, not the traveler, or an option no longer listed).
      this.policy.transition(r, { type: 'swap', alternative: null, draft: null }, opts);
      throw gone();
    }
    // The guards first (status, traveler), before any pricing.
    this.policy.transition(r, { type: 'swap', alternative: alt, draft: { totalCents: r.totalCents } }, opts);
    assertSearchOpen(this, a.org);
    const searched = await this.composer.search(alt.query);
    // The stored rows stand in for a part the supplier no longer has (an unavailable row, so 410 below).
    const priced = await this.composer.price(alt.selection, searched.query, { previous: alt.rows || null }).catch(e => {
      if (optionGone(e, COMPONENTS.map(c => alt.selection && alt.selection[c]), this.inventory)) throw gone();
      throw e;
    });
    if (priced.unavailable.length) throw gone();
    assertUsd(priced.rows);
    const draft = keepCheapest(await draftFields(this, a, {
      tier: r.tier, departmentId: r.departmentId, requestId: r.id, query: searched.query, selection: alt.selection, rows: priced.rows,
      pricedAt: priced.pricedAt, searched, nowIso,
    }), r);
    const event = { type: 'swap', alternative: alt, draft };
    this.policy.transition(r, event, opts);
    const docs = await this.repo.commit({
      cas: [{ kind: KINDS.request, id: r.id, rev: revOf(r), fn: applyTransition(this, event, opts, 'swapped') }],
      inserts: [auditInsert(this.repo, {
        orgId: a.org.id, actor: me, action: 'request.swapped', target: { kind: KINDS.request, id: r.id },
        summary: `${me.name} switched ${tripOf(r)} to a cheaper option`,
        changes: [{ path: 'totalCents', before: r.totalCents, after: draft.totalCents }],
      })],
    }).catch(asRace);
    return docs[`${KINDS.request}:${r.id}`];
  },

  /**
   * Confirm a trip or request approval (the traveler, draft only; POST /trips/:rid/submit). Always re-checks
   * the price first: a changed or unavailable price updates the draft instead (outcome 'repriced', no
   * submit; one commit: request CAS with the re-priced, re-evaluated draft, audit 'request.repriced'). So does
   * a fresh evaluation worse than the stored one (within became out or blocked, or out became blocked): the
   * re-evaluated draft, with its alternatives, is written instead (outcome 'repriced', no history line, audit
   * 'request.repriced' naming the policy check). Either way the reason typed with this submit is kept on the
   * draft (request.reason; never one holding a card number), so the re-sent form starts with it.
   * Within policy and inside the budget → approved by policy with the budget hold (outcome
   * 'auto_approved'; audit 'request.auto_approved'). Otherwise, outOfPolicy 'approval' → pending with the
   * resolved approver or pool, links and expiresAt (outcome 'submitted'; audit 'request.submitted').
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ rev: string|number, reason?: string, category?: string }} form reason 10..500 characters when
   *   approval is needed (org.settings.reasonMinChars); category one of constants.REASON_CATEGORIES or blank
   * @returns {Promise<import('./types').SubmitResult>}
   * @throws {AppError} 422 'policy_blocked'; 422 'reason_too_short'; 422 'card_number'; 422 'no_approver'
   *   ("No one else at Acme Inc can approve this yet …"); 422 'too_late' (the trip leaves too soon to wait
   *   for an approval: the computed expiresAt is not after now); 409 'invalid_transition'; 409 'conflict'; 404
   */
  async submit(actor, rid, form) {
    const a = await loadActor(this.repo, actor);
    need(a, 'trip.request');
    const f = form && typeof form === 'object' ? form : {};
    const nowIso = this.repo.iso();
    const first = await readRequest(this, a, rid);
    if (!canSee(a, first)) throw notFound();
    await expireIfDue(this, a, first, nowIso);
    const rev = formRev(f.rev);
    if (rev !== revOf(first)) throw race();
    const me = who(a);
    // The guards that need no price (a draft, the traveler), before the price check.
    const guards = d => this.policy.transition(d, { type: 'submit', reason: null, approver: null, budget: null, draft: { totalCents: d.totalCents } }, {
      now: nowIso, actor: me, member: a.member, org: a.org, recheck: { status: 'changed' },
    });
    guards(first);
    assertSearchOpen(this, a.org);
    const category = typeof f.category === 'string' && REASON_CATEGORIES.includes(f.category) ? f.category : null;
    const reason = { text: plain(f.reason).slice(0, REASON_INPUT_MAX), category };
    const key = `${KINDS.request}:${first.id}`;

    return this.repo.withRetry(async attempt => {
      const r = attempt === 1 ? first : await readRequest(this, a, rid);
      if (revOf(r) !== rev) throw race();
      const base = { now: nowIso, actor: me, member: a.member, org: a.org };
      const target = { kind: KINDS.request, id: r.id };
      const rc = await this.composer.recheck(r, { check: 'confirm' });

      if (rc.status !== 'same') {
        const draft = await repricedDraft(this, a, r, rc, nowIso);
        const event = { type: 'submit', reason, approver: null, budget: null, draft };
        const opts = { ...base, recheck: rc };
        this.policy.transition(r, event, opts);
        const docs = await this.repo.commit({
          cas: [{
            kind: KINDS.request, id: r.id, rev: revOf(r),
            fn: d => {
              const kept = keptReason(reason, d.reason);
              applyTransition(this, event, opts, 'repriced')(d);
              d.reason = kept;
            },
          }],
          inserts: [auditInsert(this.repo, {
            orgId: a.org.id, actor: me, action: 'request.repriced', target,
            summary: `${changedWhat(rc, r, 'An option on', 'The price of', 'The terms of')} ${tripOf(r)} changed before it was sent, so the trip was updated`,
            changes: [{ path: 'totalCents', before: r.totalCents, after: draft.totalCents }],
          })],
        }).catch(asRace);
        return { request: docs[key], outcome: 'repriced' };
      }

      const policy = await tierPolicy(this.repo, a.org.id, r.tier);
      const searched = await this.composer.search(r.query);
      const ctx = evalCtx(this, a.org, policy, searched, this.now());
      const budget = await budgetPreview(this, a.org, r.departmentId, tripPeriod(a.org, r.query), r.id);
      const evaluation = this.policy.evaluateTrip(r.rows, ctx, { budget: budgetCtx(budget) });
      const stored = r.evaluation && Object.hasOwn(VERDICT_ORDER, r.evaluation.status) ? r.evaluation.status : 'within';
      if (VERDICT_ORDER[evaluation.status] > VERDICT_ORDER[stored]) {
        // The verdict got worse since the draft was written (the budget was used up, or the policy changed):
        // write the re-evaluated draft, with its alternatives, instead of sending the form the traveler saw.
        const draft = keepCheapest(await draftFields(this, a, {
          tier: r.tier, departmentId: r.departmentId, requestId: r.id, query: r.query, selection: r.selection, rows: r.rows,
          pricedAt: r.pricedAt, searched, nowIso,
        }), r);
        const docs = await this.repo.commit({
          cas: [{
            kind: KINDS.request, id: r.id, rev: revOf(r),
            fn: d => {
              guards(d);
              const kept = keptReason(reason, d.reason);
              Object.assign(d, structuredClone(draft), { reason: kept, updatedAt: nowIso });
            },
          }],
          inserts: [auditInsert(this.repo, {
            orgId: a.org.id, actor: me, action: 'request.repriced', target,
            summary: `The policy check of ${tripOf(r)} changed before it was sent, so the trip was updated`,
            changes: [{ path: 'evaluation.status', before: stored, after: draft.evaluation.status }],
          })],
        }).catch(asRace);
        return { request: docs[key], outcome: 'repriced' };
      }
      let approver = null;
      if (evaluation.status !== 'within') {
        const members = await membersById(this.repo, a.org.id);
        approver = this.policy.resolveApprover(members[r.travelerId] || a.member, members);
      }
      const event = { type: 'submit', reason, approver, budget, draft: null };
      const opts = { ...base, evaluation, recheck: rc };
      const dry = this.policy.transition(r, event, opts);
      const cas = [{ kind: KINDS.request, id: r.id, rev: revOf(r), fn: applyTransition(this, event, opts, dry.outcome) }];
      const inserts = [];
      if (dry.outcome === 'auto_approved') {
        if (dry.next.budget && budget) {
          cas.push({ kind: KINDS.budget, id: budget.budgetId, rev: budget.rev, server: true, fn: holdFn(r.id, dry.next.budget.cents, false, nowIso) });
        }
        inserts.push(auditInsert(this.repo, {
          orgId: a.org.id, actor: systemActor('policy'), action: 'request.auto_approved', target,
          summary: `${tripOf(r)} was approved by policy`,
        }));
      } else {
        const ap = dry.next.approval;
        const wanted = [];
        if (ap.approverId) wanted.push(linkInsert(a.org.id, r.id, 'approver', ap.approverId, nowIso));
        if (ap.pool) for (const userId of ap.poolIds) wanted.push(linkInsert(a.org.id, r.id, 'pool', userId, nowIso));
        inserts.push(...await missingLinks(this.repo, a.org.id, wanted));
        inserts.push(auditInsert(this.repo, {
          orgId: a.org.id, actor: me, action: 'request.submitted', target, summary: `${me.name} asked for approval of ${tripOf(r)}`,
        }));
      }
      const docs = await this.repo.commit({ cas, inserts }).catch(asRace);
      return { request: docs[key], outcome: dry.outcome };
    });
  },

  /**
   * Cancel (POST /trips/:rid/cancel): the traveler a draft, a pending request, or an approved one before
   * the departure date; approval.override holders an approved one (the commit then checks their member
   * record at the rev read, and a retry that finds the override gone answers 403). Cancelling an approved
   * request deletes its budget hold in the same commit. Audit 'request.cancelled'.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ rev: string|number }} form
   * @returns {Promise<import('./types').Request>}
   * @throws {AppError} 404; 403; 409 'invalid_transition'; 409 'departed'; 409 'request_expired'; 409 'conflict'
   */
  async cancel(actor, rid, form) {
    const loaded = await loadActor(this.repo, actor);
    const f = form && typeof form === 'object' ? form : {};
    const nowIso = this.repo.iso();
    const first = await readRequest(this, loaded, rid);
    if (!canSee(loaded, first)) throw notFound();
    await expireIfDue(this, loaded, first, nowIso);
    const rev = formRev(f.rev);
    if (rev !== revOf(first)) throw race();
    const key = `${KINDS.request}:${first.id}`;
    return this.repo.withRetry(async attempt => {
      // Someone else's trip is cancelled on approval.override: a retry reads the canceller again, and the
      // commit checks their member record at the rev read, as a decision does.
      const a = attempt === 1 ? loaded : await loadActor(this.repo, actor);
      const r = attempt === 1 ? first : await readRequest(this, a, rid);
      if (revOf(r) !== rev) throw race();
      const me = who(a);
      const self = r.travelerId === me.userId;
      if (attempt > 1 && !self && !roles.can(a.member.role, 'approval.override')) throw forbidden(a.member.role, a.org.name);
      const event = { type: 'cancel' };
      const opts = { now: nowIso, actor: me, member: a.member, pooled: isPooled(r, a.member), org: a.org };
      this.policy.transition(r, event, opts);
      const cas = [{ kind: KINDS.request, id: r.id, rev: revOf(r), fn: applyTransition(this, event, opts, 'cancelled') }];
      if (r.status === 'approved' && r.budget && typeof r.budget.budgetId === 'string') {
        const b = await this.repo.getIn(KINDS.budget, r.budget.budgetId, a.org.id);
        if (b && b.commits && Object.hasOwn(b.commits, r.id)) {
          cas.push({ kind: KINDS.budget, id: r.budget.budgetId, rev: revOf(b), server: true, fn: releaseFn(r.id, nowIso) });
        }
      }
      const docs = await this.repo.commit({
        cas,
        checks: self ? [] : [{ kind: KINDS.member, id: memberId(a.org.id, me.userId), rev: revOf(a.member), server: true }],
        inserts: [auditInsert(this.repo, {
          orgId: a.org.id, actor: me, action: 'request.cancelled', target: { kind: KINDS.request, id: r.id },
          summary: self ? `${me.name} cancelled ${tripOf(r)}` : `${me.name} cancelled ${tripOf(r)} as ${roles.LABELS[me.role] || me.role}`,
        })],
      }).catch(asRace);
      return docs[key];
    });
  },

  /**
   * Approve or deny (POST /trips/:rid/decide): the assigned approver, a pool member, or an
   * approval.override holder (labelled "as Travel Admin (assigned to Dana Lee)", note required); never the
   * traveler. Order (§H2): read; effectively expired → persist and 409; recheck; changed or unavailable →
   * back to draft with `returned` (outcome 'returned', audit 'request.returned'); approve → request CAS,
   * budget hold (refused over budget unless ackOverBudget), a check on the decider's member rev, audit
   * 'request.approved' with decidedAs and overBudgetAck; deny → request CAS, audit 'request.denied'.
   * Approve and deny also insert the decider's biz_req_link `${rid}.decider.${userId}` (role 'decider',
   * whatever decidedAs) in the same commit, so "Decided by you" finds override decisions too. A request is
   * decided at most once (approved and denied leave pending for good).
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ action: 'approve'|'deny', note?: string, ackOverBudget?: string, rev: string|number }} form
   *   note ≥ 10 characters to deny or to override; ackOverBudget '1'
   * @returns {Promise<import('./types').DecideResult>}
   * @throws {AppError} 404; 403; 422 'self_approval' ("You can't decide your own trip."); 422 'note_required';
   *   422 'over_budget'; 409 'request_expired'; 409 'invalid_transition'; 409 'conflict'
   */
  async decide(actor, rid, form) {
    const first = await loadActor(this.repo, actor);
    if (!roles.canAny(first.member.role, DECIDE_PERMS)) throw forbidden(first.member.role, first.org.name);
    const f = form && typeof form === 'object' ? form : {};
    const r0 = await readRequest(this, first, rid);
    // The traveler always sees their own request; the lifecycle then refuses with 'self_approval'.
    if (!canSee(first, r0)) throw notFound();
    const action = f.action;
    if (action !== 'approve' && action !== 'deny') throw new AppError('invalid_action', 'Choose approve or deny.', 422);
    const nowIso = this.repo.iso();
    await expireIfDue(this, first, r0, nowIso);
    const rev = formRev(f.rev);
    if (rev !== revOf(r0)) throw race();
    const note = text(f.note, NOTE_INPUT_MAX, { multiline: true });
    const ack = f.ackOverBudget === '1' || f.ackOverBudget === true;
    const key = `${KINDS.request}:${r0.id}`;

    // The guards that need no price (pending, never the traveler, who may decide, the note), before the price check.
    const probe = { now: nowIso, actor: who(first), member: first.member, pooled: isPooled(r0, first.member), org: first.org };
    if (action === 'deny') this.policy.transition(r0, { type: 'deny', note }, probe);
    else this.policy.transition(r0, { type: 'approve', note, ackOverBudget: true, budget: null, draft: null }, { ...probe, recheck: { status: 'same' } });

    return this.repo.withRetry(async attempt => {
      const a = attempt === 1 ? first : await loadActor(this.repo, actor);
      if (!roles.canAny(a.member.role, DECIDE_PERMS)) throw forbidden(a.member.role, a.org.name);
      const r = attempt === 1 ? r0 : await readRequest(this, a, rid);
      if (revOf(r) !== rev) throw race();
      const me = who(a);
      const base = { now: nowIso, actor: me, member: a.member, pooled: isPooled(r, a.member), org: a.org };
      const target = { kind: KINDS.request, id: r.id };
      const memberCheck = { kind: KINDS.member, id: memberId(a.org.id, me.userId), rev: revOf(a.member), server: true };
      const deciderLink = () => missingLinks(this.repo, a.org.id, [linkInsert(a.org.id, r.id, 'decider', me.userId, nowIso)]);

      if (action === 'deny') {
        const event = { type: 'deny', note };
        const dry = this.policy.transition(r, event, base);
        const as = dry.next.approval ? dry.next.approval.decidedAs : null;
        const docs = await this.repo.commit({
          cas: [{ kind: KINDS.request, id: r.id, rev: revOf(r), fn: applyTransition(this, event, base, 'denied') }],
          checks: [memberCheck],
          inserts: [
            ...await deciderLink(),
            auditInsert(this.repo, {
              orgId: a.org.id, actor: me, action: 'request.denied', target,
              summary: `${me.name} denied ${tripOf(r)}${as === 'override' ? await overrideLabel(this.repo, a, r) : ''}`,
              changes: [{ path: 'approval.decidedAs', before: null, after: as }],
            }),
          ],
        }).catch(asRace);
        return { request: docs[key], outcome: 'denied' };
      }

      // Never approved without a check, and no check for a company Tripelyx hasn't confirmed (live prices).
      assertSearchOpen(this, a.org);
      const rc = await this.composer.recheck(r, { check: 'final' });
      if (rc.status !== 'same') {
        const draft = await repricedDraft(this, a, r, rc, nowIso);
        const event = { type: 'approve', note, ackOverBudget: ack, budget: null, draft };
        const opts = { ...base, recheck: rc };
        this.policy.transition(r, event, opts);
        const docs = await this.repo.commit({
          cas: [{ kind: KINDS.request, id: r.id, rev: revOf(r), fn: applyTransition(this, event, opts, 'returned') }],
          inserts: [auditInsert(this.repo, {
            orgId: a.org.id, actor: me, action: 'request.returned', target,
            summary: `${tripOf(r)} went back to ${r.travelerName} to confirm, because ${changedWhat(rc, r, 'an option is no longer available', 'the price changed', 'the fare or room terms changed')}`,
            changes: [{ path: 'totalCents', before: r.totalCents, after: draft.totalCents }],
          })],
        }).catch(asRace);
        return { request: docs[key], outcome: 'returned' };
      }

      // The request keeps the evaluation it was submitted with (no opts.evaluation): that is the verdict the
      // approver was shown and the one reports count. Only the budget is read fresh, for the hold.
      const budget = await budgetPreview(this, a.org, r.departmentId, tripPeriod(a.org, r.query), r.id);
      const event = { type: 'approve', note, ackOverBudget: ack, budget, draft: null };
      const opts = { ...base, recheck: rc };
      const dry = this.policy.transition(r, event, opts);
      const approval = dry.next.approval || {};
      const cas = [{ kind: KINDS.request, id: r.id, rev: revOf(r), fn: applyTransition(this, event, opts, 'approved') }];
      if (dry.next.budget && budget) {
        // Over the budget only when the decider acknowledged it on this very reading; a hold that no longer
        // fits at commit time re-runs everything (withRetry), and the lifecycle asks for the ack then.
        cas.push({ kind: KINDS.budget, id: budget.budgetId, rev: budget.rev, server: true, fn: holdFn(r.id, dry.next.budget.cents, approval.overBudgetAck === true, nowIso) });
      }
      const docs = await this.repo.commit({
        cas,
        checks: [memberCheck],
        inserts: [
          ...await deciderLink(),
          auditInsert(this.repo, {
            orgId: a.org.id, actor: me, action: 'request.approved', target,
            summary: `${me.name} approved ${tripOf(r)}${approval.decidedAs === 'override' ? await overrideLabel(this.repo, a, r) : ''}${approval.overBudgetAck ? ', over the budget' : ''}`,
            changes: [
              { path: 'approval.decidedAs', before: null, after: approval.decidedAs ?? null },
              { path: 'approval.overBudgetAck', before: false, after: approval.overBudgetAck === true },
            ],
          }),
        ],
      }).catch(asRace);
      return { request: docs[key], outcome: 'approved' };
    });
  },

  /**
   * Ask a question or answer one (POST /trips/:rid/message): the traveler, the assigned approver, pool
   * members and override holders, on a draft, pending or approved request. A pending request stays pending;
   * expiry unchanged. One commit: request CAS (messages appended), audit 'request.message' (no text in the
   * audit entry).
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @param {{ text: string }} form 2..1000 characters, card numbers refused
   * @returns {Promise<import('./types').Request>}
   * @throws {AppError} 404; 403; 422 'invalid_message'; 422 'card_number'; 409 'too_many_messages';
   *   409 'request_expired'; 409 'invalid_transition'
   */
  async message(actor, rid, form) {
    const a = await loadActor(this.repo, actor);
    const f = form && typeof form === 'object' ? form : {};
    const nowIso = this.repo.iso();
    const first = await readRequest(this, a, rid);
    if (!canSee(a, first)) throw notFound();
    await expireIfDue(this, a, first, nowIso);
    const said = text(f.text, MESSAGE_INPUT_MAX, { multiline: true });
    const me = who(a);
    const key = `${KINDS.request}:${first.id}`;
    return this.repo.withRetry(async attempt => {
      const r = attempt === 1 ? first : await readRequest(this, a, rid);
      const event = { type: 'message', text: said };
      const opts = { now: nowIso, actor: me, member: a.member, pooled: isPooled(r, a.member), org: a.org };
      this.policy.transition(r, event, opts);
      const docs = await this.repo.commit({
        cas: [{ kind: KINDS.request, id: r.id, rev: revOf(r), server: true, fn: applyTransition(this, event, opts, 'message') }],
        inserts: [auditInsert(this.repo, {
          orgId: a.org.id, actor: me, action: 'request.message', target: { kind: KINDS.request, id: r.id },
          summary: `${me.name} wrote a message on ${tripOf(r)}`,
        })],
      }).catch(asRace);
      return docs[key];
    });
  },

  /**
   * The approvals inbox (approval.decide). Pages the member's links (Repo.page on biz_req_link in member
   * scope), getIn each request and keeps those that fit the tab: 'waiting' and 'expired' read the 'approver'
   * and 'pool' links by effectiveStatus; 'decided' reads the 'decider' links (approval.decidedBy is the
   * member); 'company' (approval.override only) pages the company's requests filtered to pending. Writes nothing.
   * @param {import('./types').MemberActor} actor
   * @param {{ tab?: 'waiting'|'decided'|'company'|'expired', cursor?: string|null }} [opts]
   * @returns {Promise<import('./types').InboxView>}
   * @throws {AppError} 403; 404 bad cursor or a 'company' tab without approval.override
   */
  async inbox(actor, opts) {
    const a = await loadActor(this.repo, actor);
    need(a, 'approval.decide');
    const o = opts && typeof opts === 'object' ? opts : {};
    const tab = o.tab === undefined || o.tab === null || o.tab === '' ? 'waiting' : o.tab;
    if (!INBOX_TABS.includes(tab)) throw notFound();
    const override = roles.can(a.member.role, 'approval.override');
    if (tab === 'company' && !override) throw notFound();
    const me = a.member.userId;
    const nowIso = this.repo.iso();
    const status = r => this.policy.effectiveStatus(r, nowIso, a.org.timezone);
    const mine = r => r.travelerId !== me && !!r.approval && (r.approval.approverId === me || isPooled(r, a.member));

    const links = await scanAll(this.repo, KINDS.reqLink, memberScope(a.org.id, me));
    const decideIds = new Set(), decidedIds = new Set();
    for (const l of links) {
      if (l.role === 'approver' || l.role === 'pool') decideIds.add(l.requestId);
      else if (l.role === 'decider') decidedIds.add(l.requestId);
    }
    const read = async ids => (await Promise.all([...ids].map(id => this.repo.getIn(KINDS.request, id, a.org.id)))).filter(Boolean);
    const [toDecide, decided, company] = await Promise.all([
      read(decideIds), read(decidedIds), override ? scanAll(this.repo, KINDS.request, a.org.id) : Promise.resolve(null),
    ]);
    const oldestFirst = (x, y) => cmp(x.submittedAt, y.submittedAt) || cmp(x.id, y.id);
    const lists = {
      waiting: toDecide.filter(r => status(r) === 'pending' && mine(r)).sort(oldestFirst),
      decided: decided.filter(r => r.approval && r.approval.decidedBy && r.approval.decidedBy.userId === me)
        .sort((x, y) => cmp(y.approval.decidedAt, x.approval.decidedAt) || cmp(x.id, y.id)),
      company: company ? company.filter(r => r.travelerId !== me && status(r) === 'pending').sort(oldestFirst) : null,
      expired: toDecide.filter(r => status(r) === 'expired' && mine(r)).sort((x, y) => cmp(y.expiresAt, x.expiresAt) || cmp(x.id, y.id)),
    };
    const list = lists[tab];
    const offset = inboxOffset(o.cursor, tab);
    const rows = list.slice(offset, offset + PAGE_SIZE).map(r => inboxRow(r, status(r)));
    return {
      tab,
      counts: { waiting: lists.waiting.length, decided: lists.decided.length, company: lists.company ? lists.company.length : null, expired: lists.expired.length },
      rows,
      cursor: offset + PAGE_SIZE < list.length ? `${tab}.${offset + PAGE_SIZE}` : null,
    };
  },

  /**
   * "Waiting for you (n)" for the workspace shell (http.shellContext calls it on every workspace page). Must
   * be cheap: one bounded page of the member's links. Never throws for a member without approval.decide.
   * @param {import('./types').MemberActor} actor
   * @returns {Promise<number|null>} null when the member cannot decide
   */
  async inboxCount(actor) {
    const a = await loadActor(this.repo, actor);
    if (!roles.can(a.member.role, 'approval.decide')) return null;
    const me = a.member.userId;
    const nowIso = this.repo.iso();
    const page = await this.repo.page(KINDS.reqLink, memberScope(a.org.id, me), { limit: LINK_PAGE });
    const ids = new Set(page.rows.filter(l => l.role === 'approver' || l.role === 'pool').map(l => l.requestId));
    const reqs = await Promise.all([...ids].map(id => this.repo.getIn(KINDS.request, id, a.org.id)));
    return reqs.filter(r => r && r.travelerId !== me && !!r.approval && (r.approval.approverId === me || isPooled(r, a.member))
      && this.policy.effectiveStatus(r, nowIso, a.org.timezone) === 'pending').length;
  },

  /**
   * The approver's live price check on its own (GET; the request page embeds the same result).
   * composer.recheck(request, { check: 'peek' }): never a supplier search; writes nothing.
   * @param {import('./types').MemberActor} actor
   * @param {string} rid
   * @returns {Promise<import('./types').RecheckResult>}
   * @throws {AppError} 404; 403 when the member cannot decide this request
   */
  async liveCheck(actor, rid) {
    const a = await loadActor(this.repo, actor);
    const r = await readRequest(this, a, rid);
    if (!canSee(a, r)) throw notFound();
    if (this.policy.effectiveStatus(r, this.repo.iso(), a.org.timezone) !== 'pending' || deciderRole(a, r) === null) {
      throw forbidden(a.member.role, a.org.name);
    }
    assertSearchOpen(this, a.org);
    return this.composer.recheck(r, { check: 'peek' });
  },
};

module.exports = { methods, PURPOSE_CHARS, HOME_ROWS, LIST_SCOPES, INBOX_TABS };
