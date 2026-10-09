// The workspace home (/business/o/:orgId, plan §B4, §B6, §H5), one page for every role: the service's
// DashboardView leaves out (null) what the member's role does not reach, and this page shows what is there.
//   Employee: "Plan a work trip", My trips, "Your policy at a glance".
//   Manager: "Waiting for you (n)" with the 5 oldest and "Expires in …", team trips this period.
//   Owner and Travel Admin: the set-up checklist, pending company-wide, out-of-policy share, top reasons,
//   recent activity. Finance: the budget table and a Reports link.
// Every amount is demo-labelled; a share with nothing submitted says "No requests yet", never 0%.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { LABELS, can } = require('../../business/roles');
const f = require('./format');
const p = require('./parts');
const { places, tripTable } = require('./trips');
const { inboxTable } = require('./approvals');

const firstName = name => String(name || '').split(' ')[0] || String(name || '');
const MONEY = /[$€£¥]\s?\d/;

function section(id, title, body, { iconName = null, action = null, cls = '' } = {}) {
  return html`<section class="bz-home-block${cls ? ` ${cls}` : ''}" aria-labelledby="${id}">
    <div class="bz-block-head"><h2 class="bz-block-title" id="${id}">${iconName ? icon(iconName) : ''}<span>${title}</span></h2>${action ? html`<a class="bz-block-link" href="${action.href}">${action.label} ${icon('arrow')}</a>` : ''}</div>
    ${body}
  </section>`;
}

/** The budget table (BudgetRow[]): one demo container, "No budget set" instead of an amount where none is set. */
function budgetTable(rows, { label, timeZone }) {
  const cell = c => (c === null || c === undefined ? 'No budget set' : p.amount(c));
  const table = p.dataTable({
    caption: `Budgets for ${label}`,
    columns: [{ label: 'Department' }, { label: 'Budget', num: true }, { label: 'Committed', num: true }, { label: 'Awaiting approval', num: true }, { label: 'Remaining', num: true }],
    rows: rows.map(b => [
      b.department.archived ? `${b.department.name} (archived)` : b.department.name,
      cell(b.amountCents), p.amount(b.committedCents), p.amount(b.awaitingCents),
      b.amountCents === null || b.amountCents === undefined ? '' : p.amount(b.remainingCents),
    ]),
    empty: `No budgets for ${label}. Without a budget, trips are checked against the policy only.`,
  });
  return p.demoBox(html`${table}<p class="bz-muted">Committed is what approved trips hold. Spent shows once real bookings exist.</p>`, { pricedAt: null, timeZone, cls: 'bz-budgets-box' });
}

/**
 * @param {object} ctx
 * @param {{ org: object, member: object, dash: import('../../business/types').DashboardView, inventoryStatus: string }} m
 */
function homeView(ctx, { org, member, dash, inventoryStatus }) {
  const base = `/business/o/${org.id}`;
  const timeZone = f.safeZone(org.timezone);
  const map = places(ctx);
  const role = member.role;
  const demo = inventoryStatus === 'demo';
  const blocks = [];

  if (dash.checklist) {
    const c = dash.checklist;
    const items = [
      { text: 'Review your policy', done: c.policyReviewed, href: `${base}/policies` },
      { text: 'Add departments and budgets', done: c.departments, href: `${base}/budgets` },
      { text: 'Invite your team', done: c.invited, href: `${base}/people` },
      ...(demo ? [{ text: 'Try a demo trip', done: c.demoTrip, href: `${base}/trips/new` }] : []),
    ];
    if (items.some(i => !i.done)) blocks.push(section('bz-h-setup', `Set up ${org.name}`, p.checklist(items), { iconName: 'flag' }));
  }

  if (dash.waiting) {
    const w = dash.waiting;
    blocks.push(section('bz-h-waiting', `Waiting for you (${w.count})`, w.rows.length
      ? inboxTable(ctx, { base, rows: w.rows, tab: 'waiting', timeZone, caption: 'The oldest requests waiting for you' })
      : p.emptyState({ title: 'Nothing is waiting for you.', text: "Requests from your team arrive here, oldest first. We don't send emails yet, so check back here.", iconName: 'check' }),
    { iconName: 'check', action: { href: `${base}/approvals`, label: 'All approvals' } }));
  }

  const tiles = [];
  if (dash.pendingCompany) {
    tiles.push(html`<div class="bz-card bz-tile"><p class="bz-tile-title">Waiting for approval</p><p class="bz-tile-value">${String(dash.pendingCompany.count)}</p><p class="bz-muted">Pending requests across ${org.name}</p></div>`);
  }
  if (dash.outOfPolicyShare) {
    const s = dash.outOfPolicyShare;
    tiles.push(html`<div class="bz-card bz-tile"><p class="bz-tile-title">Outside policy, ${dash.periodLabel}</p>${Number.isSafeInteger(s.tenths)
      ? html`<p class="bz-tile-value">${f.percent(s.tenths)}</p><p class="bz-muted">${String(s.outOrBlocked)} of ${f.plural(s.submitted, 'request')}</p>`
      : html`<p class="bz-tile-value bz-tile-none">No requests yet</p>`}</div>`);
  }
  if (dash.topReasons) {
    tiles.push(html`<div class="bz-card bz-tile"><p class="bz-tile-title">Top reasons, ${dash.periodLabel}</p>${dash.topReasons.length
      ? html`<ol class="bz-top-reasons">${dash.topReasons.map(t => html`<li><span>${t.label}</span><b>${String(t.count)}</b></li>`)}</ol>`
      : html`<p class="bz-tile-value bz-tile-none">No requests yet</p>`}</div>`);
  }
  if (tiles.length) {
    blocks.push(section('bz-h-company', `${org.name} at a glance`, html`<div class="bz-tiles">${tiles}</div>`, {
      iconName: 'chart', action: can(role, 'reports.view') ? { href: `${base}/reports`, label: 'Reports' } : null,
    }));
  }

  if (dash.budgets) {
    blocks.push(section('bz-h-budgets', `Budgets, ${dash.periodLabel}`, budgetTable(dash.budgets, { label: dash.periodLabel, timeZone }), {
      iconName: 'wallet', action: { href: `${base}/budgets`, label: 'All budgets' },
    }));
    if (role === 'finance' && can(role, 'reports.view') && !tiles.length) {
      blocks.push(html`<p><a class="btn btn-ghost bz-btn" href="${base}/reports">${icon('chart')}<span>Open reports</span></a></p>`);
    }
  }

  if (dash.teamTrips) {
    blocks.push(section('bz-h-team', `Team trips, ${dash.periodLabel}`, tripTable({
      base, map, rows: dash.teamTrips, timeZone, caption: `Team trips departing in ${dash.periodLabel}`, traveler: true,
      empty: `No team trips departing in ${dash.periodLabel} yet.`,
    }), { iconName: 'users', action: { href: `${base}/trips?scope=team`, label: 'Team trips' } }));
  }

  if (can(role, 'trip.request')) {
    blocks.push(section('bz-h-plan', 'Plan a work trip', inventoryStatus === 'none'
      ? p.supplierPanel({ level: 3 })
      : html`<div class="bz-card bz-plan"><p>Search ${demo ? 'demo ' : ''}flights and hotels with your policy shown on every option. Out-of-policy picks come with cheaper options before you ask for approval.</p>
        <p><a class="btn btn-navy bz-btn" href="${base}/trips/new">${icon('plane')}<span>Plan a work trip</span></a></p></div>`, { iconName: 'plane' }));
  }

  blocks.push(section('bz-h-mine', 'My trips', dash.myTrips.length
    ? tripTable({ base, map, rows: dash.myTrips, timeZone, caption: 'Your newest trips' })
    : p.emptyState({ title: 'No work trips yet.', text: "Plan one and you'll see your policy as you search.", iconName: 'calendar', action: inventoryStatus === 'none' ? null : { href: `${base}/trips/new`, label: 'Plan a trip' } }),
  { iconName: 'calendar', action: dash.myTrips.length ? { href: `${base}/trips`, label: 'All your trips' } : null }));

  const pol = dash.policy || { sub: '', lines: [] };
  const lines = pol.lines.slice(0, 5);
  const polBody = html`<p class="bz-muted">${pol.sub}</p><ul class="bz-policy-lines">${lines.map(l => html`<li>${icon('check')}<span>${l}</span></li>`)}</ul>`;
  blocks.push(section('bz-h-policy', 'Your policy at a glance',
    lines.some(l => MONEY.test(l)) ? p.demoBox(polBody, { pricedAt: null, timeZone, cls: 'bz-card bz-policy' }) : html`<div class="bz-card bz-policy">${polBody}</div>`,
    { iconName: 'shield', action: { href: `${base}/policy`, label: 'Your whole policy' } }));

  if (dash.recent) {
    const now = ctx.now();
    const list = dash.recent.length
      ? html`<ol class="bz-timeline">${dash.recent.map(e => html`<li><span class="bz-timeline-when">${f.whenIn(timeZone, e.at, { now, zone: true })}</span>${e.summary}</li>`)}</ol>`
      : html`<p class="bz-muted">Nothing here yet.</p>`;
    blocks.push(section('bz-h-recent', 'Recent activity', dash.recent.some(e => MONEY.test(e.summary || '')) ? p.demoBox(list, { pricedAt: null, timeZone, cls: 'bz-card' }) : html`<div class="bz-card">${list}</div>`, {
      iconName: 'clock', action: can(role, 'audit.view') ? { href: `${base}/activity`, label: 'All activity' } : null,
    }));
  }

  return html`${p.pageHead({ title: `Hi, ${firstName(member.name)}`, sub: `${LABELS[role] || role} at ${org.name}` })}
  ${blocks}`;
}

module.exports = { homeView };
