// /business/o/:orgId/reports?period=2026-Q4 (reports.view, plan §B4, §B6, §H5, §H6): "Reports for Q4 2026" with
// tiles (requests by status, out-of-policy share, top reasons, committed vs budget, saved by switching to
// cheaper options), the Coming soon tiles (never a number, never $0), requests by traveler, the filtered
// request list, and Download CSV (POST /reports/export with the same filters, reports.export). An empty period
// says "No requests yet", never $0. Every amount sits in a demo container (§F6). With real suppliers
// (real-suppliers design §2.3) the tiles are labelled with the least real source of the requests they count
// (dash.priceSource, else the workspace's): "Includes supplier test data"; each listed request carries its
// own source's label, and the CSV's price_source column says it per row. Once any request counted or listed
// is not demo, the "Requests by status" tile and the status filter say "Approved" (never "Approved to book").
const { html } = require('../../lib/html');
const { pageHead, tabs, dataTable, emptyState, amount, budgetBar, demoBox, demoPrice, comingSoon, statusPill, policyBadge, pager } = require('./parts');
const f = require('./format');
const { shellView } = require('./shell');
const { selectField } = require('./auth');
const { PILLS } = require('./parts');
const { periodLabel } = require('../../business/budgets');
const { SCAN_CAP } = require('../../business/constants');

const NO_REQUESTS = 'No requests yet';
/** The approved status once supplier prices are counted (booking isn't open for them: design §2.3). */
const APPROVED = 'Approved';
const COMING_TEXT = Object.freeze({
  spend: 'Shows once trips are booked through Tripelyx.',
  invoices: 'Shows once booking and billing are live.',
});
const STATUS_ORDER = Object.freeze(['pending', 'approved', 'past', 'denied', 'cancelled', 'expired', 'draft']);
/** The page's sub-heading, by the least real source of its amounts. */
const MONEY_SUBS = Object.freeze({
  demo: 'Money here is calculated on demo prices. Nothing is charged.',
  sandbox: 'Money here includes supplier test data, not real fares. Nothing is charged.',
  live: 'Money here is calculated on supplier prices. Nothing is booked or charged.',
});
/** Beside Download CSV once a request may be priced by a supplier. */
const CSV_SOURCES = "The CSV's price_source column says where each amount came from: demo prices, supplier test data or supplier prices.";

function tile(title, body) {
  return html`<section class="bz-card bz-tile" aria-label="${title}"><h2 class="bz-tile-title">${title}</h2>${body}</section>`;
}

/**
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ dash: import('../../business/types').DashboardView, choices: string[], list: import('../../business/types').Page<import('../../business/types').RequestRow>,
 *   filters: { departmentId?: string, status?: string, travelerId?: string }, departments: object[], canExport: boolean,
 *   moreHref?: string|null, notice?: string|null, error?: string|null }} v
 */
function reportsView(ctx, shell, { dash, choices, list, filters = {}, departments = [], canExport, moreHref = null, notice = null, error = null }) {
  const { org } = shell;
  const base = `/business/o/${org.id}`;
  const tz = f.safeZone(org.timezone);
  const t = dash.reports;
  const label = dash.periodLabel;
  const total = Object.values(t.byStatus).reduce((s, n) => s + n, 0);
  const share = t.outOfPolicyShare;
  const budgets = (t.committedVsBudget || []).filter(b => b.budgetId);
  // What the tiles add up: the period's requests' least real source, else the workspace's ('demo' as before).
  const source = f.isSource(dash.priceSource) ? dash.priceSource : (f.ctxSource(ctx) || 'demo');
  // Nothing priced by a supplier can be booked yet: once any is counted or listed, "Approved", not "Approved to book".
  const supplier = source !== 'demo' || list.rows.some(r => f.isSource(r.source) && r.source !== 'demo');
  const statusLabel = s => (s === 'approved' && supplier ? APPROVED : PILLS.request[s] ? PILLS.request[s][0] : s);
  const box = { pricedAt: null, timeZone: tz, source, totals: true };
  const tiles = html`<div class="bz-tiles">
    ${tile('Requests by status', total
    ? html`<ul class="bz-lines-text">${STATUS_ORDER.filter(s => t.byStatus[s]).map(s => html`<li>${statusLabel(s)}: <b>${String(t.byStatus[s])}</b></li>`)}</ul>`
    : html`<p>${NO_REQUESTS}</p>`)}
    ${tile('Out-of-policy share', share.tenths === null
    ? html`<p>${NO_REQUESTS}</p>`
    : html`<p class="bz-tile-value">${f.percent(share.tenths)}</p><p class="bz-meta">${String(share.outOrBlocked)} of ${f.plural(share.submitted, 'sent request')} were outside the policy or blocked.</p>`)}
    ${tile('Top reasons', t.topReasons.length
    ? html`<ul class="bz-lines-text">${t.topReasons.map(r => html`<li>${r.label}: <b>${String(r.count)}</b></li>`)}</ul>`
    : html`<p>${total ? 'No trips outside the policy.' : NO_REQUESTS}</p>`)}
    ${tile('Committed vs budget', !total
    ? html`<p>${NO_REQUESTS}</p>`
    : budgets.length
      // Both parts of the bar named: committed (approved while the budget was set) and awaiting approval.
      ? demoBox(html`<ul class="bz-lines-text">${budgets.map(b => html`<li><span class="bz-budget-name">${b.department.name}</span>${amount(b.committedCents)} committed and ${amount(b.awaitingCents)} awaiting approval, of ${amount(b.amountCents)}${budgetBar(b)}</li>`)}</ul>
        <p class="bz-meta">Committed counts trips approved while their department had a budget for ${label}.</p>`, box)
      : html`<p>No budgets set for ${label}.</p>`)}
    ${tile('Saved by switching to cheaper options', !total
    ? html`<p>${NO_REQUESTS}</p>`
    : t.savedBySwitchingCents > 0
      ? demoBox(html`<p class="bz-tile-value">${amount(t.savedBySwitchingCents)}</p><p class="bz-meta">On approved trips where the traveler picked a cheaper option.</p>`, box)
      : html`<p>Nothing saved by switching yet.</p>`)}
  </div>
  <div class="bz-tiles">${t.comingSoon.map(c => comingSoon(c.label, COMING_TEXT[c.key] || '', { level: 2 }))}</div>`;
  const travelers = t.byTraveler.length
    ? demoBox(html`${dataTable({
      caption: `Requests by traveler, ${label}`, captionVisible: false,
      columns: [{ label: 'Traveler' }, { label: 'Requests', num: true }, { label: 'Approved', num: true }],
      rows: t.byTraveler.map(x => [x.name, String(x.requests), amount(x.committedCents)]),
    })}
    <p class="bz-meta">Approved: the total of each traveler's approved trips departing in ${label}, whether or not a budget counts them.</p>`, { ...box, tag: 'section', label: 'Requests by traveler' })
    : '';
  const statusOptions = [['', 'Any status'], ...STATUS_ORDER.map(s => [s, statusLabel(s)])];
  const depOptions = [['', 'Every department'], ...departments.map(d => [d.id, d.archivedAt ? `${d.name} (archived)` : d.name])];
  const travelerOptions = [['', 'Every traveler'], ...t.byTraveler.map(x => [x.userId, x.name])];
  const filterForm = html`<form class="bz-card bz-stack" method="get" action="${base}/reports">
    <input type="hidden" name="period" value="${dash.periodKey}">
    <div class="bz-grid-fields">
      ${selectField({ id: 'bz-rep-dep', name: 'departmentId', label: 'Department', options: depOptions, value: filters.departmentId || '' })}
      ${selectField({ id: 'bz-rep-status', name: 'status', label: 'Status', options: statusOptions, value: filters.status || '' })}
      ${selectField({ id: 'bz-rep-traveler', name: 'travelerId', label: 'Traveler', options: travelerOptions, value: filters.travelerId || '' })}
    </div>
    <div class="bz-inline"><button class="btn btn-ghost bz-btn" type="submit">Show requests</button></div>
  </form>`;
  const route = r => `${r.from} to ${r.to}, ${f.dayRange(r.departDate, r.returnDate)}`;
  const listTable = list.rows.length
    ? dataTable({
      caption: `Requests departing in ${label}`,
      columns: [{ label: 'Traveler' }, { label: 'Trip' }, { label: 'Total', num: true }, { label: 'Status' }, { label: 'Policy' }],
      rows: list.rows.map(r => [
        r.travelerName,
        html`<a href="${base}/trips/${r.id}">${route(r)}</a>`,
        demoPrice(r.totalCents, { pricedAt: r.pricedAt, timeZone: tz, source: f.isSource(r.source) ? r.source : 'demo' }),
        statusPill(r.status, { source: r.source }),
        policyBadge(r.policyStatus),
      ]),
    })
    : html`<p class="bz-table-empty">No requests match these filters.</p>`;
  const csvNote = canExport && source !== 'demo' ? html`<p class="bz-meta">${CSV_SOURCES}</p>` : '';
  const exportForm = canExport ? html`<form class="bz-inline-form" method="post" action="${base}/reports/export">
      <input type="hidden" name="period" value="${dash.periodKey}">
      ${filters.departmentId ? html`<input type="hidden" name="departmentId" value="${filters.departmentId}">` : ''}
      ${filters.status ? html`<input type="hidden" name="status" value="${filters.status}">` : ''}
      ${filters.travelerId ? html`<input type="hidden" name="travelerId" value="${filters.travelerId}">` : ''}
      <button class="btn btn-navy bz-btn" type="submit">Download CSV</button>
    </form>` : '';
  const body = html`${pageHead({ title: `Reports for ${label}`, sub: MONEY_SUBS[source] || MONEY_SUBS.demo, actions: exportForm })}${csvNote}
    ${tabs(choices.map(k => ({ href: `${base}/reports?period=${encodeURIComponent(k)}`, label: periodLabel(k), current: k === dash.periodKey })), { label: 'Report period' })}
    ${t.truncated ? html`<p class="bz-meta">Based on the ${SCAN_CAP.toLocaleString('en-US')} most recent requests.</p>` : ''}
    ${total ? '' : emptyState({ title: `No requests in ${label} yet.`, text: 'Tiles fill in as your team plans trips.', iconName: 'chart' })}
    ${tiles}
    ${travelers ? html`<section class="bz-section" aria-labelledby="bz-rep-trav"><h2 id="bz-rep-trav">By traveler</h2>${travelers}</section>` : ''}
    <section class="bz-section" aria-labelledby="bz-rep-list"><h2 id="bz-rep-list">Requests</h2>
      ${filterForm}
      ${listTable}
      ${pager(moreHref, 'Older')}
    </section>`;
  return shellView(ctx, shell, { title: `Reports for ${label}`, body, notice, error });
}

module.exports = { reportsView, NO_REQUESTS, COMING_TEXT, MONEY_SUBS, CSV_SOURCES };
