// Company administration routes (plan §B4 "Policy, budgets and people" and "Reports, activity and
// settings", §B6, §I5, §I6). Paths are relative to MOUNT ('/business'). Every route runs memberGate per route
// (never a path-less r.use()), which sends Cache-Control no-store and X-Robots-Tag noindex, answers 404 to
// anyone who is not a member (platform admins included) and 403 to a role without the permission.
//
//   GET  /o/:orgId/welcome                          settings.company                        → dashboard (checklist)
//   GET  /o/:orgId/policies                         policy.view.all                         → getPolicy per tier
//   GET  /o/:orgId/policies/:tier                   policy.view.all                         → getPolicy
//   POST /o/:orgId/policies/:tier                   policy.edit         bizWrite            → savePolicy
//   GET  /o/:orgId/policies/:tier/history           policy.view.all                         → policyHistory
//   GET  /o/:orgId/budgets                          budget.view.dept|all                    → listBudgets
//   POST /o/:orgId/budgets                          budget.edit         bizWrite            → setBudget
//   GET  /o/:orgId/people                           members.view                            → listMembers
//   POST /o/:orgId/people/invite                    members.manage      bizWrite            → invite (200 show-once page)
//   POST /o/:orgId/people/invites/:publicId/revoke  members.manage      bizWrite            → revokeInvite
//   POST /o/:orgId/people/:userId                   members.manage      bizWrite            → updateMember
//   POST /o/:orgId/people/:userId/remove            members.manage      bizWrite            → removeMember
//   POST /o/:orgId/departments                      departments.manage  bizWrite            → saveDepartment
//   GET  /o/:orgId/reports                          reports.view                            → dashboard({ view: 'reports' })
//   POST /o/:orgId/reports/export                   reports.export      bizWrite            → exportCsv (200 attachment)
//   GET  /o/:orgId/activity                         audit.view                              → listAudit
//   GET  /o/:orgId/settings                         org.view                                → getOrg
//   POST /o/:orgId/settings                         settings.company|settings.travel bizWrite → saveSettings
//   POST /o/:orgId/settings/export                  settings.company    bizWrite            → exportCompany (200 attachment)
//
// Mounted from TABLE by table.mountTable, so the Express stack and ROUTES cannot disagree: a POST runs
// bizWrite → sameOrigin → the form parser → memberGate → the handler, then 303 to a GET with ?ok=<code>
// (the page maps the code to fixed text). Exceptions: the invite-link page answers 200 (the token is shown
// once, Referrer-Policy no-referrer) and the two downloads answer 200 with an attachment. A 422 or 409
// re-renders the page with what was typed and the message; a 403 from the service (a role this member may
// not grant) re-renders People with the reason. GETs never write.
const express = require('express');
const { gates: makeGates } = require('../../business/http');
const { send, clientError, routesOf, mountTable } = require('./table');
const { can, LABELS } = require('../../business/roles');
const { TIERS, MEMBER_CAP, PAGE_SIZE, AUDIT_GROUPS } = require('../../business/constants');
const { periodChoices, currentPeriodKey, PERIOD_KEY_RE } = require('../../business/budgets');
const { welcomeView } = require('../../views/business/welcome');
const { peopleView } = require('../../views/business/people');
const { inviteLinkView } = require('../../views/business/inviteLink');
const { policiesView, policyEditView, policyHistoryView } = require('../../views/business/policies');
const { budgetsView } = require('../../views/business/budgets');
const { reportsView } = require('../../views/business/reports');
const { activityView } = require('../../views/business/activity');
const { settingsView } = require('../../views/business/settings');

const TABLE = [
  { method: 'GET', path: '/o/:orgId/welcome', perm: 'settings.company', own: false, limiter: [], who: 'member', handler: 'welcomePage' },
  { method: 'GET', path: '/o/:orgId/policies', perm: 'policy.view.all', own: false, limiter: [], who: 'member', handler: 'policiesPage' },
  { method: 'GET', path: '/o/:orgId/policies/:tier', perm: 'policy.view.all', own: false, limiter: [], who: 'member', handler: 'policyPage' },
  { method: 'POST', path: '/o/:orgId/policies/:tier', perm: 'policy.edit', own: false, limiter: ['bizWrite'], who: 'member', handler: 'policyPost' },
  { method: 'GET', path: '/o/:orgId/policies/:tier/history', perm: 'policy.view.all', own: false, limiter: [], who: 'member', handler: 'historyPage' },
  { method: 'GET', path: '/o/:orgId/budgets', perm: ['budget.view.dept', 'budget.view.all'], own: false, limiter: [], who: 'member', handler: 'budgetsPage' },
  { method: 'POST', path: '/o/:orgId/budgets', perm: 'budget.edit', own: false, limiter: ['bizWrite'], who: 'member', handler: 'budgetPost' },
  { method: 'GET', path: '/o/:orgId/people', perm: 'members.view', own: false, limiter: [], who: 'member', handler: 'peoplePage' },
  // Before /people/:userId, so "invite" is never read as a user id.
  { method: 'POST', path: '/o/:orgId/people/invite', perm: 'members.manage', own: false, limiter: ['bizWrite'], who: 'member', handler: 'invitePost' },
  { method: 'POST', path: '/o/:orgId/people/invites/:publicId/revoke', perm: 'members.manage', own: false, limiter: ['bizWrite'], who: 'member', handler: 'revokePost' },
  { method: 'POST', path: '/o/:orgId/people/:userId', perm: 'members.manage', own: false, limiter: ['bizWrite'], who: 'member', handler: 'memberPost' },
  { method: 'POST', path: '/o/:orgId/people/:userId/remove', perm: 'members.manage', own: false, limiter: ['bizWrite'], who: 'member', handler: 'removePost' },
  { method: 'POST', path: '/o/:orgId/departments', perm: 'departments.manage', own: false, limiter: ['bizWrite'], who: 'member', handler: 'departmentPost' },
  { method: 'GET', path: '/o/:orgId/reports', perm: 'reports.view', own: false, limiter: [], who: 'member', handler: 'reportsPage' },
  { method: 'POST', path: '/o/:orgId/reports/export', perm: 'reports.export', own: false, limiter: ['bizWrite'], who: 'member', handler: 'csvPost' },
  { method: 'GET', path: '/o/:orgId/activity', perm: 'audit.view', own: false, limiter: [], who: 'member', handler: 'activityPage' },
  { method: 'GET', path: '/o/:orgId/settings', perm: 'org.view', own: false, limiter: [], who: 'member', handler: 'settingsPage' },
  { method: 'POST', path: '/o/:orgId/settings', perm: ['settings.company', 'settings.travel'], own: false, limiter: ['bizWrite'], who: 'member', handler: 'settingsPost' },
  { method: 'POST', path: '/o/:orgId/settings/export', perm: 'settings.company', own: false, limiter: ['bizWrite'], who: 'member', handler: 'exportPost' },
];

/** This router's routes (types.RouteEntry). */
const ROUTES = routesOf(TABLE);

/** ?ok= codes → the notice each page shows after its 303. Unknown codes show nothing. */
const NOTICES = Object.freeze({
  policies: Object.freeze({ handling: 'Saved how trips outside the policy are handled.' }),
  policy: Object.freeze({ saved: 'Saved as a new version. Trips planned from now on are checked against it.', unchanged: 'Nothing changed, so no new version was saved.' }),
  budgets: Object.freeze({ budget: 'Budget saved.' }),
  people: Object.freeze({
    revoked: 'Invite revoked. That link no longer works.',
    member: 'Changes saved.',
    removed: 'Removed from the company. Their own Tripelyx account is untouched.',
    department: 'Department saved.',
    archived: 'Department archived.',
  }),
  settings: Object.freeze({
    saved: 'Settings saved.',
    renamed: 'Settings saved. Tripelyx will confirm the new name before anyone else can join.',
  }),
});

/** One query or body value as text ('' for a missing or repeated one). */
const one = v => (typeof v === 'string' ? v : '');
const okText = (page, code) => (Object.hasOwn(NOTICES[page], one(code)) ? NOTICES[page][one(code)] : null);
/** A download's file name, kept to safe characters. */
const safeName = (name, fallback) => (String(name || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120) || fallback);
/** A 422's message with its field messages, for forms that show one message (people, departments). */
function errorText(e) {
  const details = e.details && typeof e.details === 'object' ? Object.values(e.details).filter(x => typeof x === 'string') : [];
  return details.length ? `${e.message} ${details.join(' ')}` : e.message;
}
/** Body keys that are not policy fields (rev, note) or could never be one (an object's own machinery). */
const POLICY_FIELDS_SKIP = new Set(['rev', 'note', '__proto__', 'constructor', 'prototype']);
const STALE = 'Someone changed this while you were looking. Here is the latest version.';

/**
 * @param {object} ctx the app context
 * @param {import('../../business/types').RouterDeps} deps
 * @returns {import('express').Router}
 */
function router(ctx, deps) {
  const r = express.Router();
  const svc = ctx.business;
  const biz = ctx.config.business;
  const g = makeGates(ctx);
  const gate = row => [g.memberGate(row.perm)];

  const actorOf = req => req.biz.actor;
  const baseOf = req => `/business/o/${req.biz.org.id}`;
  const roleOf = req => req.biz.member.role;

  /** Render a workspace page: the shell (switcher, nav) plus the view. */
  async function page(req, res, status, view, args) {
    const shell = await g.shellContext(req);
    return send(res, status, view(ctx, shell, args));
  }

  /**
   * A service refusal a page answers itself: 404 → the not-found page, a suspended company → 403, any other
   * 403 → the forbidden page, else render(e) (422, 409, 410). Anything else is rethrown for the app.
   */
  function refuse(req, res, e, render) {
    if (!clientError(e)) throw e;
    if (e.status === 404) return g.notFound(res);
    if (e.code === 'org_suspended') return g.forbidden(res, { message: e.message, role: null, reason: 'suspended' });
    if (e.status === 403 && !render.forbidden) return g.forbidden(res, { message: e.message, role: roleOf(req), reason: 'role' });
    // A lost compare-and-set: the page is drawn again from the latest records, so it says so (§B6 "Stale rev").
    if (e.code === 'conflict') e.message = STALE;
    return render(e);
  }

  // ---- policies ----

  async function renderPolicies(req, res, { status = 200, notice = null, error = null } = {}) {
    const actor = actorOf(req);
    const [policies, org] = await Promise.all([Promise.all(TIERS.map(t => svc.getPolicy(actor, t))), svc.getOrg(actor)]);
    return page(req, res, status, policiesView, { policies, org, canTravel: can(roleOf(req), 'settings.travel'), notice, error });
  }

  /** The posted editor fields (the PolicyForm), without rev and note. */
  function policyForm(body) {
    const out = {};
    for (const [k, v] of Object.entries(body || {})) if (!POLICY_FIELDS_SKIP.has(k)) out[k] = v;
    return out;
  }

  // ---- budgets ----

  async function renderBudgets(req, res, { period = '', status = 200, values = {}, errors = {}, notice = null, error = null } = {}) {
    const actor = actorOf(req);
    const org = req.biz.org;
    const current = currentPeriodKey(org, ctx.now());
    let key = one(period);
    if (key && !PERIOD_KEY_RE.test(key)) {
      key = current;
      status = 422;
      error = error || 'Choose a period like 2026-Q4.';
    }
    key = key || current;
    const rows = await svc.listBudgets(actor, key);
    const near = periodChoices(current);
    const choices = near.includes(key) ? near : periodChoices(key);
    return page(req, res, status, budgetsView, {
      rows, periodKey: key, choices, canEdit: can(roleOf(req), 'budget.edit'), periodKind: org.settings && org.settings.budgetPeriod === 'month' ? 'month' : 'quarter',
      ownOnly: !can(roleOf(req), 'budget.view.all'), values, errors, notice, error,
    });
  }

  // ---- people ----

  /** Every member of the company, for the manager and approver choices (paged in full, up to MEMBER_CAP). */
  async function everyone(actor, first, cursor) {
    if (!cursor && !first.cursor) return first.members;
    const all = [];
    let next = null;
    for (let i = 0; i <= Math.ceil(MEMBER_CAP / PAGE_SIZE); i += 1) {
      const p = await svc.listMembers(actor, { cursor: next });
      all.push(...p.members);
      next = p.cursor;
      if (!next) break;
    }
    return all;
  }

  async function renderPeople(req, res, { status = 200, cursor = null, invite = {}, notice = null, error = null } = {}) {
    const actor = actorOf(req);
    const people = await svc.listMembers(actor, { cursor: cursor || null });
    const all = await everyone(actor, people, cursor);
    const moreHref = people.cursor ? `${baseOf(req)}/people?cursor=${encodeURIComponent(people.cursor)}` : null;
    return page(req, res, status, peopleView, { people, everyone: all, moreHref, invite, notice, error });
  }

  /** A People form's refusal: 403 here is a role this member may not grant, said on the page. */
  const peopleRefusal = (req, res) => Object.assign(e => renderPeople(req, res, {
    status: e.status,
    error: e.status === 403 ? `Your role (${LABELS[roleOf(req)]}) can't give, change or remove that role. Ask an Owner.` : errorText(e),
  }), { forbidden: true });

  // ---- reports ----

  async function renderReports(req, res, { query, status = 200, error = null } = {}) {
    const actor = actorOf(req);
    const org = req.biz.org;
    const q = query || {};
    const filters = { departmentId: one(q.departmentId), status: one(q.status), travelerId: one(q.travelerId) };
    let period = one(q.period);
    if (period && !PERIOD_KEY_RE.test(period)) {
      period = '';
      status = 422;
      error = error || 'Choose a period like 2026-Q4.';
    }
    const dash = await svc.dashboard(actor, { periodKey: period || null, view: 'reports' });
    let list = { rows: [], cursor: null };
    try {
      list = await svc.listRequests(actor, { scope: 'all', ...filters, period: dash.periodKey, cursor: one(q.cursor) || null });
    } catch (e) {
      if (!clientError(e) || e.status !== 422) throw e;
      status = 422;
      error = error || errorText(e);
      for (const k of Object.keys(e.details || {})) if (Object.hasOwn(filters, k)) filters[k] = '';
    }
    const departments = await svc.listDepartments(actor);
    const near = periodChoices(currentPeriodKey(org, ctx.now()));
    const choices = near.includes(dash.periodKey) ? near : periodChoices(dash.periodKey);
    const params = new URLSearchParams({ period: dash.periodKey });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    if (list.cursor) params.set('cursor', list.cursor);
    const moreHref = list.cursor ? `${baseOf(req)}/reports?${params}` : null;
    return page(req, res, status, reportsView, { dash, choices, list, filters, departments, canExport: can(roleOf(req), 'reports.export'), moreHref, error });
  }

  // ---- settings ----

  async function renderSettings(req, res, { status = 200, values = {}, errors = {}, rev = null, notice = null, error = null } = {}) {
    const org = await svc.getOrg(actorOf(req));
    const role = roleOf(req);
    return page(req, res, status, settingsView, {
      org, rev, canCompany: can(role, 'settings.company'), canTravel: can(role, 'settings.travel'), selfServe: biz.selfServe === true, values, errors, notice, error,
    });
  }

  /** A download: no-store (memberGate set it), an attachment with a safe file name. */
  function download(res, { type, filename, body }) {
    res.status(200);
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }

  const handlers = {
    async welcomePage(req, res) {
      const dash = await svc.dashboard(actorOf(req), { view: 'home' });
      const demo = !!(svc.inventory && svc.inventory.status === 'demo');
      return page(req, res, 200, welcomeView, { checklist: dash.checklist, demo });
    },

    async policiesPage(req, res) {
      return renderPolicies(req, res, { notice: okText('policies', req.query.ok) });
    },

    async policyPage(req, res) {
      try {
        const view = await svc.getPolicy(actorOf(req), req.params.tier);
        return page(req, res, 200, policyEditView, { view, notice: okText('policy', req.query.ok) });
      } catch (e) {
        return refuse(req, res, e, () => g.notFound(res));
      }
    },

    async policyPost(req, res) {
      const b = req.body || {};
      const actor = actorOf(req);
      const tier = req.params.tier;
      const form = policyForm(b);
      try {
        const { version } = await svc.savePolicy(actor, tier, { form, rev: b.rev, note: one(b.note) });
        return res.redirect(303, `${baseOf(req)}/policies/${encodeURIComponent(tier)}?ok=${version ? 'saved' : 'unchanged'}`);
      } catch (e) {
        return refuse(req, res, e, async err => {
          const view = await svc.getPolicy(actor, tier);
          if (err.status === 409) {
            // The latest rules, with the note kept so it can be sent again.
            return page(req, res, 409, policyEditView, { view, note: one(b.note), error: err.message });
          }
          // What was typed, at the rev it was loaded at (a later change still answers 409 on the next save).
          const rev = /^\d{1,9}$/.test(one(b.rev)) ? Number(b.rev) : view.rev;
          return page(req, res, err.status, policyEditView, {
            view: { ...view, rev }, form, errors: err.details || {}, note: one(b.note), error: err.details ? 'Check the highlighted fields.' : err.message,
          });
        });
      }
    },

    async historyPage(req, res) {
      try {
        const history = await svc.policyHistory(actorOf(req), req.params.tier, { before: one(req.query.before) || null });
        const view = await svc.getPolicy(actorOf(req), req.params.tier);
        return page(req, res, 200, policyHistoryView, { history, tierLabel: view.tierLabel });
      } catch (e) {
        return refuse(req, res, e, () => g.notFound(res));
      }
    },

    async budgetsPage(req, res) {
      return renderBudgets(req, res, { period: one(req.query.period), notice: okText('budgets', req.query.ok) });
    },

    async budgetPost(req, res) {
      const b = req.body || {};
      const departmentId = one(b.departmentId);
      const period = one(b.period);
      try {
        await svc.setBudget(actorOf(req), departmentId, period, one(b.rev), one(b.amount));
        return res.redirect(303, `${baseOf(req)}/budgets?period=${encodeURIComponent(period)}&ok=budget`);
      } catch (e) {
        return refuse(req, res, e, err => renderBudgets(req, res, {
          period: PERIOD_KEY_RE.test(period) ? period : '',
          status: err.status,
          values: err.status === 422 ? { [departmentId]: one(b.amount) } : {},
          errors: err.status === 422 ? { [departmentId]: err.details || {} } : {},
          error: err.message,
        }));
      }
    },

    async peoplePage(req, res) {
      try {
        return await renderPeople(req, res, { cursor: one(req.query.cursor) || null, notice: okText('people', req.query.ok) });
      } catch (e) {
        return refuse(req, res, e, () => g.notFound(res));
      }
    },

    async invitePost(req, res) {
      const b = req.body || {};
      const form = {
        email: one(b.email), role: one(b.role), departmentId: one(b.departmentId), managerId: one(b.managerId), approverId: one(b.approverId), tier: one(b.tier),
      };
      try {
        const created = await svc.invite(actorOf(req), form);
        const base = (ctx.config.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return page(req, res, 200, inviteLinkView, {
          created, url: `${base}/business/invite/${encodeURIComponent(created.token)}`, tier: TIERS.includes(form.tier) ? form.tier : null,
        });
      } catch (e) {
        return refuse(req, res, e, Object.assign(err => renderPeople(req, res, {
          status: err.status,
          invite: { values: form, errors: err.status === 422 ? err.details || {} : {} },
          error: err.status === 403 ? `Your role (${LABELS[roleOf(req)]}) can't give that role. Ask an Owner.` : err.message,
        }), { forbidden: true }));
      }
    },

    async revokePost(req, res) {
      try {
        await svc.revokeInvite(actorOf(req), req.params.publicId);
        return res.redirect(303, `${baseOf(req)}/people?ok=revoked#invites`);
      } catch (e) {
        return refuse(req, res, e, peopleRefusal(req, res));
      }
    },

    async memberPost(req, res) {
      const b = req.body || {};
      try {
        await svc.updateMember(actorOf(req), req.params.userId, {
          role: one(b.role), departmentId: one(b.departmentId), managerId: one(b.managerId), approverId: one(b.approverId), tier: one(b.tier), rev: one(b.rev),
        });
        return res.redirect(303, `${baseOf(req)}/people?ok=member`);
      } catch (e) {
        return refuse(req, res, e, peopleRefusal(req, res));
      }
    },

    async removePost(req, res) {
      try {
        await svc.removeMember(actorOf(req), req.params.userId, { rev: one((req.body || {}).rev) });
        return res.redirect(303, `${baseOf(req)}/people?ok=removed`);
      } catch (e) {
        return refuse(req, res, e, peopleRefusal(req, res));
      }
    },

    async departmentPost(req, res) {
      const b = req.body || {};
      const archive = b.archive === '1';
      try {
        // The archive form sends no name: only a posted name is a rename.
        await svc.saveDepartment(actorOf(req), {
          departmentId: one(b.departmentId) || undefined, ...(Object.hasOwn(b, 'name') ? { name: one(b.name) } : {}), archive, rev: one(b.rev),
        });
        return res.redirect(303, `${baseOf(req)}/people?ok=${archive ? 'archived' : 'department'}#departments`);
      } catch (e) {
        return refuse(req, res, e, err => renderPeople(req, res, { status: err.status, error: errorText(err) }));
      }
    },

    async reportsPage(req, res) {
      try {
        return await renderReports(req, res, { query: req.query });
      } catch (e) {
        // A period the service refuses: the current one, with the message.
        return refuse(req, res, e, err => renderReports(req, res, { query: {}, status: err.status, error: err.message }));
      }
    },

    async csvPost(req, res) {
      const b = req.body || {};
      const filters = { period: one(b.period), departmentId: one(b.departmentId), status: one(b.status), travelerId: one(b.travelerId) };
      try {
        const out = await svc.exportCsv(actorOf(req), filters);
        return download(res, { type: 'text/csv; charset=utf-8', filename: safeName(out.filename, 'tripelyx-requests.csv'), body: out.body });
      } catch (e) {
        const keep = PERIOD_KEY_RE.test(filters.period) && !(e.details && e.details.period);
        return refuse(req, res, e, err => renderReports(req, res, { query: keep ? { period: filters.period } : {}, status: err.status, error: errorText(err) }));
      }
    },

    async activityPage(req, res) {
      const group = one(req.query.group) || null;
      try {
        const p = await svc.listAudit(actorOf(req), { group, cursor: one(req.query.cursor) || null });
        const known = AUDIT_GROUPS.includes(group) ? group : null;
        const params = new URLSearchParams();
        if (known) params.set('group', known);
        if (p.cursor) params.set('cursor', p.cursor);
        const moreHref = p.cursor ? `${baseOf(req)}/activity?${params}` : null;
        return page(req, res, 200, activityView, { page: p, group: known, moreHref });
      } catch (e) {
        return refuse(req, res, e, () => g.notFound(res));
      }
    },

    async settingsPage(req, res) {
      return renderSettings(req, res, { notice: okText('settings', req.query.ok) });
    },

    async settingsPost(req, res) {
      const b = req.body || {};
      const fromPolicies = b.from === 'policies';
      const form = { rev: one(b.rev) };
      for (const k of ['name', 'timezone', 'outOfPolicy', 'approvalHours', 'budgetPeriod']) if (Object.hasOwn(b, k)) form[k] = one(b[k]);
      const before = req.biz.org.status;
      try {
        const org = await svc.saveSettings(actorOf(req), form);
        if (fromPolicies) return res.redirect(303, `${baseOf(req)}/policies?ok=handling`);
        return res.redirect(303, `${baseOf(req)}/settings?ok=${before === 'active' && org.status === 'pending' ? 'renamed' : 'saved'}`);
      } catch (e) {
        return refuse(req, res, e, err => {
          if (fromPolicies) return renderPolicies(req, res, { status: err.status, error: errorText(err) });
          // A stale form shows the latest settings; a 422 shows what was typed with each field's message.
          if (err.status === 409) return renderSettings(req, res, { status: 409, error: err.message });
          // What was typed, at the rev it was loaded at (a later change still answers 409 on the next save).
          const { rev, ...values } = form;
          return renderSettings(req, res, { status: err.status, values, errors: err.details || {}, rev: /^\d{1,9}$/.test(rev) ? Number(rev) : null, error: err.message });
        });
      }
    },

    async exportPost(req, res) {
      try {
        const out = await svc.exportCompany(actorOf(req));
        return download(res, { type: 'application/json; charset=utf-8', filename: safeName(out.filename, 'tripelyx-company.json'), body: out.json });
      } catch (e) {
        return refuse(req, res, e, err => renderSettings(req, res, { status: err.status, error: err.message }));
      }
    },
  };

  return mountTable(r, TABLE, { deps, gate, handlers });
}

module.exports = { router, ROUTES };
