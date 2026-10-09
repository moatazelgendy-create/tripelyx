// /admin/business: the platform admin's company list (plan §I8). Companies waiting for confirmation first,
// then active, then paused; each with its size, when it was created, who created it, how many members it
// has, its time zone and other companies with a similar name. Confirm (pending → active), Pause (a note is
// required; the company never sees it) and Reactivate, each its own small form (POST, 303 back). Then the
// company enquiries from the /business form. Nothing inside a company: no requests, policies, budgets,
// member lists or activity. With Travel by Budget on it is a tab of the admin control center (the trips
// admin chrome); with it off, a corporate page. noindex; the route sends no-store.
const { html } = require('../../lib/html');
const { layout } = require('../layout');
const { statusPill, notice, errorBox, dataTable, emptyState } = require('./parts');
const f = require('./format');
const { textArea } = require('./auth');
const { adminTabs } = require('../trips/admin');

const TITLE = 'Companies';
const MOUNT = '/admin/business';
const SECTIONS = Object.freeze([
  ['pending', 'Waiting for confirmation', 'No companies are waiting for confirmation.'],
  ['active', 'Active', 'No active companies yet.'],
  ['suspended', 'Paused', 'No paused companies.'],
]);
const NOTE_HINT = 'Required. Only Tripelyx staff see this note; the company sees that Tripelyx paused it.';

/** One company with its actions. `form`: the posted values and messages after a 422 for this company. */
function orgCard(o, form) {
  const e = (form && form.errors) || {};
  const idp = `bz-plat-${o.id}`;
  const confirm = o.status === 'active' ? '' : html`<form class="bz-inline-form" method="post" action="${MOUNT}/${o.id}/status">
      <input type="hidden" name="status" value="active"><input type="hidden" name="rev" value="${String(o.rev)}">
      <button class="btn btn-navy bz-btn" type="submit">${o.status === 'pending' ? 'Confirm' : 'Reactivate'}<span class="sr-only"> ${o.name}</span></button>
    </form>`;
  const pause = o.status === 'suspended' ? '' : html`<details class="bz-more"${form ? html` open` : ''}>
      <summary>Pause this company<span class="sr-only"> (${o.name})</span></summary>
      <form class="bz-stack" method="post" action="${MOUNT}/${o.id}/status">
        <input type="hidden" name="status" value="suspended"><input type="hidden" name="rev" value="${String(o.rev)}">
        ${textArea({ id: `${idp}-note`, name: 'note', label: 'Why is it paused?', value: form ? form.note : '', error: e.note || e.status, maxlength: 300, rows: 2, hint: html`<p class="field-hint">${NOTE_HINT}</p>` })}
        <div class="bz-inline"><button class="btn btn-ghost bz-btn" type="submit">Pause ${o.name}</button></div>
      </form>
    </details>`;
  return html`<li class="bz-card bz-stack" id="org-${o.id}">
    <div class="bz-card-head"><h3>${o.name}</h3>${statusPill(o.status, { kind: 'org' })}</div>
    <p class="bz-meta">${o.size || 'Size not given'} · ${f.plural(o.memberCount, 'member')} · ${o.timezone} · created ${f.dateTimeIn('UTC', o.at)}</p>
    <p class="bz-meta">Created by ${o.creatorEmail || 'an account that has left'}</p>
    ${o.similarNames && o.similarNames.length ? html`<p class="alert alert-warning bz-alert" role="note">Similar name: ${o.similarNames.join(', ')}</p>` : ''}
    ${confirm || pause ? html`<div class="bz-stack">${confirm ? html`<div class="bz-inline">${confirm}</div>` : ''}${pause}</div>` : ''}
  </li>`;
}

/**
 * @param {object} ctx
 * @param {{ data: import('../../business/types').PlatformView, notice?: string|null, error?: string|null,
 *   form?: { orgId: string, note: string, errors: Record<string, string> }|null }} v
 */
function platformView(ctx, { data, notice: ok = null, error = null, form = null }) {
  const orgs = data.orgs || [];
  const leads = data.leads || [];
  const sections = SECTIONS.map(([status, label, empty]) => {
    const list = orgs.filter(o => o.status === status);
    return html`<section class="bz-section" aria-labelledby="bz-plat-${status}">
      <h2 id="bz-plat-${status}">${label} (${String(list.length)})</h2>
      ${list.length ? html`<ul class="bz-grid">${list.map(o => orgCard(o, form && form.orgId === o.id ? form : null))}</ul>` : html`<p class="bz-meta">${empty}</p>`}
    </section>`;
  });
  const enquiries = html`<section class="bz-section" aria-labelledby="bz-plat-leads">
    <h2 id="bz-plat-leads">Company enquiries (${String(leads.length)})</h2>
    ${dataTable({
    caption: 'Company enquiries', captionVisible: false,
    columns: [{ label: 'Received' }, { label: 'Name' }, { label: 'Company' }, { label: 'Email' }, { label: 'Size' }, { label: 'Message' }],
    rows: leads.map(l => [l.createdAt ? f.dateTimeIn('UTC', l.createdAt) : '', l.name || '', l.company || '', l.email || '', l.type || '', l.message || '']),
    empty: 'No enquiries yet.',
  })}
  </section>`;
  const inner = html`<p class="bz-meta">Confirm a company once you know it is real. Until then, its people can't join by invite. Times in UTC.</p>
    ${notice(ok)}${errorBox(error)}
    ${orgs.length ? sections : emptyState({ title: 'No companies yet.', text: 'Companies show up here when someone creates a workspace at /business/start.', iconName: 'layers' })}
    ${enquiries}`;
  if (ctx.trips) {
    const body = html`<div class="container tb-admin bz-plat">
      <header class="tb-admin-head"><div><p class="eyebrow">Admin control center</p><h1>${TITLE}</h1></div></header>
      ${adminTabs(ctx, MOUNT)}
      <div class="bz-stack">${inner}</div>
    </div>`;
    return layout({ title: `${TITLE} · Admin`, body, ctx, noindex: true, styles: ['/css/business.css'] });
  }
  const body = html`<div class="bz-pub-main"><div class="container bz-plat"><div class="bz-pub-card bz-pub-wide">
    <p class="eyebrow bz-pub-eyebrow">Tripelyx admin</p><h1>${TITLE}</h1>
    ${inner}
  </div></div></div>`;
  return layout({ title: `${TITLE} · Admin`, body, ctx, noindex: true, corporate: true, styles: ['/css/business.css'], bodyClass: 'bz-pub' });
}

module.exports = { platformView, TITLE, NOTE_HINT };
