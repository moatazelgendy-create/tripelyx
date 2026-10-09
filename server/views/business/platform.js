// /admin/business: the platform admin's company list (plan §I8). Companies waiting for confirmation first,
// then active, then paused; each with its size, when it was created, who created it, how many members it
// has, its time zone and other companies with a similar name; a pending company that was renamed after it was
// confirmed says "Renamed from …", and a paused one shows the staff note and when it was paused. Confirm (pending → active), Pause (a note is
// required; the company never sees it) and Reactivate, each its own small form (POST, 303 back). Then the
// company enquiries from the /business form. Nothing inside a company: no requests, policies, budgets,
// member lists or activity. With Travel by Budget on it is a tab of the admin control center (the trips
// admin chrome); with it off, a corporate page. noindex; the route sends no-store.
// Real suppliers (real-suppliers design §1.3, §2.3): when a supplier is configured, a "Flights and hotels"
// section says whether companies see supplier test data or live prices, and a supplier setting that switched
// them off (inventory.problem: a sentence that names the variable, never its value) is shown here and
// nowhere else. With demo inventory, or no supplier and no problem, the page is as it was.
// Tripelyx's own company (go-live design §3.8): a panel with one button, "Create Tripelyx Inc", while there is
// none; then its name and company id.
// Live search (go-live design §5.4, a live-keys stack only: data.suppliers is null anywhere else): the Suppliers
// panel takes the place of "Flights and hotels". Per supplier its state ("Not set", "Test key refused", "Ready
// to check", "Live", "Turned off after a mode mismatch at 3:42 PM, Fri 9 Oct (UTC)") and the problem sentence,
// never a key or any part of one; today's calls against the daily caps, with a notice once a total passes 80%;
// the last live check in counts and yes or no; "Check live connection", "Turn on live search" (only after a
// passing check for the keys in place, in the last 24 hours) and "Turn off live search"; and what was done to
// the switch lately. Supplier names appear here only, never to companies or travelers.
const { html } = require('../../lib/html');
const { layout } = require('../layout');
const { icon } = require('../icons');
const { statusPill, notice, errorBox, dataTable, emptyState, kvList } = require('./parts');
const f = require('./format');
const { textArea, zoneOption } = require('./auth');
const { adminTabs } = require('../trips/admin');
const { HOUSE_COMPANY_NAME, HOUSE_NAME_FIXED } = require('../../business/constants');

const TITLE = 'Companies';
const MOUNT = '/admin/business';
const SECTIONS = Object.freeze([
  ['pending', 'Waiting for confirmation', 'No companies are waiting for confirmation.'],
  ['active', 'Active', 'No active companies yet.'],
  ['suspended', 'Paused', 'No paused companies.'],
]);
const NOTE_HINT = 'Required. Only Tripelyx staff see this note; the company sees that Tripelyx paused it.';
/** What companies see, by the inventory's source, when a supplier is configured. */
const SUPPLIER_STATES = Object.freeze({
  sandbox: "Companies search the suppliers' test systems. Prices are supplier test data, not real fares, and are labelled TEST DATA.",
  live: 'Companies search live supplier prices. Booking is not open, so nothing is booked or charged.',
});
const HOTELS_OFF = 'Hotels are not connected, so companies can request flights only.';
const HOUSE_TITLE = "Tripelyx's own company";
const HOUSE_INTRO = `The company Tripelyx itself travels with, named ${HOUSE_COMPANY_NAME}. Sign-up refuses any name that says Tripelyx, so it's made here, once. You'll be its Owner, and it's active straight away.`;
/** Under the house company's name and id: why the id is shown (a setting for one company asks for it). */
const HOUSE_MADE = `${HOUSE_NAME_FIXED} Keep the company id: Tripelyx settings that apply to one company ask for it.`;
const SUPPLIER_OFF = 'Companies see "Supplier not connected yet" until this is fixed.';

/**
 * The "Flights and hotels" section for platform admins: what companies search, and the supplier problem
 * sentence (inventory.problem). Nothing with demo inventory, or with no supplier and no problem.
 * @param {object} ctx the app context (ctx.business.inventory)
 */
function supplierSection(ctx) {
  const inv = ctx && ctx.business ? ctx.business.inventory : null;
  if (!inv) return '';
  const problem = typeof inv.problem === 'string' && inv.problem.trim() ? inv.problem.trim() : null;
  const state = inv.status !== 'none' && Object.hasOwn(SUPPLIER_STATES, inv.source) ? SUPPLIER_STATES[inv.source] : null;
  if (!problem && !state) return '';
  return html`<section class="bz-section" aria-labelledby="bz-plat-suppliers">
    <h2 id="bz-plat-suppliers">Flights and hotels</h2>
    ${state ? html`<p>${state}</p>` : ''}
    ${state && inv.hotelsConnected === false ? html`<p class="bz-meta">${HOTELS_OFF}</p>` : ''}
    ${problem ? html`<div class="alert alert-warning bz-alert" role="status">${icon('alert')}<span class="bz-plat-problem">A supplier setting needs attention: ${problem}${inv.status === 'none' ? ` ${SUPPLIER_OFF}` : ''}</span></div>` : ''}
  </section>`;
}

/**
 * The "Tripelyx's own company" panel: the button while there is none (POST /admin/business/house), then the
 * company's name and id.
 * @param {{ id: string, name: string, status: string }|null} house PlatformView.house
 */
function housePanel(house) {
  if (house) {
    return html`<section class="bz-section bz-card" aria-labelledby="bz-plat-house">
      <div class="bz-card-head"><h2 id="bz-plat-house">${HOUSE_TITLE}</h2>${statusPill(house.status, { kind: 'org' })}</div>
      ${kvList([['Name', house.name], ['Company id', html`<code>${house.id}</code>`]])}
      <p class="bz-meta">${HOUSE_MADE}</p>
    </section>`;
  }
  return html`<section class="bz-section bz-card" aria-labelledby="bz-plat-house">
    <h2 id="bz-plat-house">${HOUSE_TITLE}</h2>
    <p>${HOUSE_INTRO}</p>
    <form class="bz-inline-form" method="post" action="${MOUNT}/house"><button class="btn btn-navy bz-btn" type="submit">Create ${HOUSE_COMPANY_NAME}</button></form>
  </section>`;
}

const LIVE_TITLE = 'Suppliers';
/** The suppliers by record name: what they are for, as the panel names them. */
const SUPPLIER_ROWS = Object.freeze([['duffel', 'Duffel', 'flights'], ['liteapi', 'LiteAPI', 'hotels']]);
/** A key's state in words (config keyState). */
const KEY_WORDS = Object.freeze({
  not_set: 'Not set',
  test_key: 'Test key refused',
  not_valid: 'Key not readable',
});
const KEY_HELP = Object.freeze({
  not_set: 'Paste the live key in AWS Secrets Manager (the README says how), then restart the service.',
  test_key: 'This site takes live keys only. Paste the live key in AWS Secrets Manager, then restart the service.',
  not_valid: 'The key could not be read. Paste it again in AWS Secrets Manager, then restart the service.',
});
const yesNo = v => (v === true ? 'yes' : v === false ? 'no' : 'not known');
const utc = iso => f.dateTimeIn('UTC', iso);

/** One supplier's state in words, from the panel data. */
function supplierState(v, key) {
  const k = v.keys ? v.keys[key] : null;
  if (k === null || k === undefined) return { label: 'Not connected', tone: 'muted', help: key === 'liteapi' ? 'Hotels are not connected, so companies can request flights only.' : '' };
  if (Object.hasOwn(KEY_WORDS, k)) return { label: KEY_WORDS[k], tone: k === 'not_set' ? 'muted' : 'warn', help: KEY_HELP[k] };
  if (!v.ready) return { label: 'Needs attention', tone: 'warn', help: '' };
  const st = v.stored;
  if (v.latched && v.latched[key]) return { label: 'Turned off after a mode mismatch', tone: 'warn', help: 'It answered in test mode on this task. A new passing check turns live search on again.' };
  if (st && st.offReason === 'mismatch' && st.mismatch && st.mismatch.supplier === key && st.mismatch.at) {
    return { label: `Turned off after a mode mismatch at ${utc(st.mismatch.at)}`, tone: 'warn', help: 'It answered in test mode. Check the key, then run the live check again.' };
  }
  if (v.on) return { label: 'Live', tone: 'good', help: '' };
  if (v.canTurnOn) return { label: 'Checked, ready to turn on', tone: 'muted', help: '' };
  return { label: 'Ready to check', tone: 'muted', help: '' };
}

/** A check answer that said test mode: thrown away whole (go-live §5.3). */
const TEST_MODE = 'answered in test mode, so nothing it sent was used';

/** The last live check, in counts and yes or no (never a price, a name or an id). */
function checkSummary(c) {
  if (!c) return html`<p class="bz-meta">No live check has run yet.</p>`;
  const d = c.details || {};
  const fl = d.flights || {}, of = d.offer || {}, ho = d.hotels || null;
  const ms = n => (Number.isFinite(n) ? `${String(n)} ms` : '');
  const parts = [
    ['Search', d.route && d.departDate ? `${d.route}, ${d.departDate}, economy, 1 adult` : ''],
    ['Duffel offer request', fl.liveMode === false ? TEST_MODE : fl.error ? `no answer (${fl.error})` : `answered: ${yesNo(fl.answered)} · live mode: ${yesNo(fl.liveMode)} · ${String(fl.usdRows || 0)} of ${String(fl.rows || 0)} fares in US dollars, ${String(fl.otherCurrency || 0)} in another currency left out · every row checked: ${yesNo(fl.rowsChecked)} · ${ms(fl.ms)}`],
    ['Duffel offer check', of.error ? `no answer (${of.error})` : `answered: ${yesNo(of.answered)} · live mode: ${yesNo(of.liveMode)} · still available: ${yesNo(of.available)} · ${ms(of.ms)}`],
    ...(ho ? [['LiteAPI rates', ho.sandbox === true ? TEST_MODE : ho.error ? `no answer (${ho.error})` : `answered: ${yesNo(ho.answered)} · test mode: ${yesNo(ho.sandbox)} · ${String(ho.usdRows || 0)} of ${String(ho.rows || 0)} rooms in US dollars, ${String(ho.otherCurrency || 0)} in another currency left out · every row checked: ${yesNo(ho.rowsChecked)}`]] : []),
  ];
  const when = `${c.passed ? 'Passed' : 'Did not pass'} at ${utc(c.at)}`;
  const STALE = {
    keys: ' The keys have changed since, so it no longer counts.',
    old: ' It is more than 24 hours old, so it no longer counts.',
    mismatch: ' A supplier answered in test mode after it, so it no longer counts.',
  };
  const note = c.stale && Object.hasOwn(STALE, c.stale) ? STALE[c.stale] : '';
  return html`<div class="bz-stack"><p><strong>Last live check:</strong> ${when}.${note}</p>${kvList(parts)}</div>`;
}

/**
 * The Suppliers panel (live-keys stack only; see the header).
 * @param {object|null} v PlatformView.suppliers (team.platformSuppliers)
 */
function livePanel(v) {
  if (!v) return '';
  const usage = v.usage && v.usage.suppliers ? v.usage.suppliers : null;
  const caps = v.caps || { company: 100, total: 500 };
  const rows = SUPPLIER_ROWS.map(([key, name, what]) => {
    const st = supplierState(v, key);
    const u = usage && usage[key] ? usage[key] : null;
    return html`<li class="bz-card bz-stack">
      <div class="bz-card-head"><h3>${name} (${what})</h3><span class="bz-pill bz-pill-${st.tone}">${st.label}</span></div>
      ${st.help ? html`<p class="bz-meta">${st.help}</p>` : ''}
      <p class="bz-meta">${u ? `Calls today: ${String(u.total)} of ${String(u.cap)}. Each company can make up to ${String(caps.company)}.` : usage ? '' : "Today's calls could not be read just now."}</p>
    </li>`;
  });
  const notices = usage ? SUPPLIER_ROWS.filter(([key]) => usage[key] && usage[key].notice).map(([key, name]) => html`<p class="alert alert-warning bz-alert" role="status">${icon('alert')}<span>${name} calls today have passed 80% of the daily total (${String(usage[key].total)} of ${String(usage[key].cap)}). At ${String(usage[key].cap)} search stops for every company until 00:00 UTC.</span></p>`) : [];
  const problem = typeof v.problem === 'string' && v.problem.trim() ? v.problem.trim() : null;
  const state = v.on ? 'Live search is on. Confirmed companies search live prices. Booking is not open, so nothing is booked or charged.'
    : 'Live search is off. Companies see "Supplier not connected yet".';
  const check = v.ready
    ? v.checksLeft > 0
      ? html`<form class="bz-inline-form" method="post" action="${MOUNT}/suppliers/check"><button class="btn btn-ghost bz-btn" type="submit">Check live connection</button></form>`
      : html`<p class="bz-meta">The live check has run 3 times in the last hour.${v.nextCheckAt ? ` It can run again at ${utc(v.nextCheckAt)}.` : ''}</p>`
    : '';
  const turnOn = v.canTurnOn ? html`<form class="bz-inline-form" method="post" action="${MOUNT}/suppliers/live">
      <input type="hidden" name="on" value="1"><input type="hidden" name="rev" value="${String(v.rev)}">
      <button class="btn btn-navy bz-btn" type="submit">Turn on live search</button>
    </form>` : '';
  const turnOff = v.stored && v.stored.on ? html`<form class="bz-inline-form" method="post" action="${MOUNT}/suppliers/live">
      <input type="hidden" name="on" value="0"><input type="hidden" name="rev" value="${String(v.rev)}">
      <button class="btn btn-ghost bz-btn" type="submit">Turn off live search</button>
    </form>` : '';
  const audit = Array.isArray(v.audit) && v.audit.length
    ? html`<details class="bz-more"><summary>What was done lately</summary><ul class="bz-stack">${v.audit.map(e => html`<li class="bz-meta">${utc(e.at)}: ${e.summary}</li>`)}</ul></details>`
    : '';
  return html`<section class="bz-section bz-card bz-stack" aria-labelledby="bz-plat-live">
    <div class="bz-card-head"><h2 id="bz-plat-live">${LIVE_TITLE}</h2><span class="bz-pill bz-pill-${v.on ? 'good' : 'muted'}">${v.on ? 'Live search is on' : 'Live search is off'}</span></div>
    <p>${state}</p>
    ${v.readable === false ? html`<p class="alert alert-warning bz-alert" role="status">${icon('alert')}<span>The live search switch could not be read just now, so live search counts as off.</span></p>` : ''}
    ${problem ? html`<div class="alert alert-warning bz-alert" role="status">${icon('alert')}<span class="bz-plat-problem">A supplier setting needs attention: ${problem}</span></div>` : ''}
    <ul class="bz-grid">${rows}</ul>
    ${notices}
    ${v.ready ? checkSummary(v.lastCheck) : ''}
    ${check || turnOn || turnOff ? html`<div class="bz-inline">${check}${turnOn}${turnOff}</div>` : ''}
    ${v.ready && !v.on && !v.canTurnOn ? html`<p class="bz-meta">Live search turns on only after a live check that passed for the keys in place, in the last 24 hours. Each check makes 3 supplier calls, and they count toward today's totals.</p>` : ''}
    ${audit}
  </section>`;
}

/** Words too common to make two company names alike on their own. */
const COMMON_WORDS = new Set(['the', 'and', 'company', 'group', 'travel', 'global', 'international', 'inc', 'ltd', 'llc', 'co']);

/** A name's words, lower case, letters and digits only ("Acme, Inc." → ['acme', 'inc']). */
const wordsOf = name => String(name || '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Other listed companies whose name starts with the same distinctive word as this one ("Acme Incorporated"
 * and "Acme Inc"), added to the service's similarNames, so a likely duplicate is easy to spot.
 */
function alsoSimilar(o, orgs) {
  const first = wordsOf(o.name)[0];
  if (!first || first.length < 3 || COMMON_WORDS.has(first)) return [];
  return orgs.filter(x => x.id !== o.id && wordsOf(x.name)[0] === first).map(x => x.name);
}

/** One company with its actions. `form`: the posted values and messages after a 422 for this company. */
function orgCard(o, form, orgs = []) {
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
        ${textArea({ id: `${idp}-note`, name: 'note', label: 'Why is it paused?', value: form ? form.note : '', error: e.note || e.status, maxlength: 300, rows: 2, required: true, hint: html`<p class="field-hint">${NOTE_HINT}</p>` })}
        <div class="bz-inline"><button class="btn btn-ghost bz-btn" type="submit">Pause ${o.name}</button></div>
      </form>
    </details>`;
  const similar = [...new Set([...(o.similarNames || []), ...alsoSimilar(o, orgs)])];
  return html`<li class="bz-card bz-stack" id="org-${o.id}">
    <div class="bz-card-head"><h3>${o.name}</h3>${statusPill(o.status, { kind: 'org' })}</div>
    <p class="bz-meta">${o.size || 'Size not given'} · ${f.plural(o.memberCount, 'member')} · ${zoneOption(f.safeZone(o.timezone))} · created ${f.dateTimeIn('UTC', o.at)}</p>
    <p class="bz-meta">Created by ${o.creatorEmail || 'an account that has left'}</p>
    ${o.status === 'pending' && o.previousName ? html`<p class="bz-meta">Renamed from ${o.previousName}, which Tripelyx had confirmed. Check the new name before you confirm it again.</p>` : ''}
    ${o.status === 'suspended' && o.statusNote ? html`<p class="bz-meta">Paused${o.statusAt ? ` on ${f.dateTimeIn('UTC', o.statusAt)}` : ''}: ${o.statusNote}</p>` : ''}
    ${similar.length ? html`<p class="alert alert-warning bz-alert" role="note">Similar name: ${similar.join(', ')}</p>` : ''}
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
      ${list.length ? html`<ul class="bz-grid">${list.map(o => orgCard(o, form && form.orgId === o.id ? form : null, orgs))}</ul>` : html`<p class="bz-meta">${empty}</p>`}
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
    ${notice(ok)}${errorBox(error)}${housePanel(data.house || null)}${data.suppliers ? livePanel(data.suppliers) : supplierSection(ctx)}
    ${orgs.length ? sections : emptyState({ title: 'No companies yet.', text: 'Companies show up here when someone creates a workspace at /business/start.', iconName: 'layers' })}
    ${enquiries}`;
  if (ctx.trips) {
    const body = html`<div class="container tb-admin bz-plat">
      <header class="tb-admin-head"><div><p class="eyebrow">Admin control center</p><h1>${TITLE}</h1></div></header>
      ${adminTabs(ctx, MOUNT)}
      <div class="bz-stack">${inner}</div>
    </div>`;
    // The trips admin chrome, without the site's environment banner: no Business page wears it (go-live design §3.4).
    return layout({ title: `${TITLE} · Admin`, body, ctx: { ...ctx, envBanner: null }, noindex: true, styles: ['/css/business.css'] });
  }
  const body = html`<div class="bz-pub-main"><div class="container bz-plat"><div class="bz-pub-card bz-pub-wide">
    <p class="eyebrow bz-pub-eyebrow">Tripelyx admin</p><h1>${TITLE}</h1>
    ${inner}
  </div></div></div>`;
  return layout({ title: `${TITLE} · Admin`, body, ctx, noindex: true, corporate: true, styles: ['/css/business.css'], bodyClass: 'bz-pub' });
}

module.exports = {
  platformView, alsoSimilar, supplierSection, housePanel, livePanel, supplierState, LIVE_TITLE, TITLE, NOTE_HINT, SUPPLIER_STATES, HOTELS_OFF, SUPPLIER_OFF, HOUSE_TITLE, HOUSE_INTRO, HOUSE_MADE,
};
