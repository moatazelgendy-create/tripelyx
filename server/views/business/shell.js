// The Tripelyx Business workspace shell (plan §B3): the document every /business/o/:orgId page renders in.
// It is its own document, not layout(): the corporate and trip chrome stay exactly as they are, and a
// company workspace gets a top bar, a section menu and a footer of its own.
//
//   shellView(ctx, shell, { title, body, notice, error, searchPage, scripts, bodyClass })
//   shellErrorView(ctx, shell, { title, message })   the workspace 404, role 403 and 429 (business/http.js)
//
// `shell` is http.shellContext(ctx, req) (types.ShellModel: org, member, companies, approvalsCount, nav), so the
// shell shows only what the member's role reaches (nav is filtered by roles.can). Routes set the status and
// the private headers (memberGate: Cache-Control no-store, X-Robots-Tag noindex); the document also says
// noindex. It loads site.css, business.css and /js/business.js (deferred, progressive enhancement only):
// the switcher, the user menu and the phone menu are <details>, so everything works without JavaScript.
//
// Ribbons, first inside <main>: the demo ribbon always (it names demo data only when demo inventory runs); the
// pending-company ribbon while Tripelyx confirms the company (it offers a demo trip only with demo inventory);
// and "Supplier not connected yet" on search pages (searchPage: true) when no supplier is connected.
// With real suppliers (real-suppliers design §2.3) the first ribbon says where prices come from: supplier test
// data ("Preview with supplier test data: …", marked bz-ribbon-test) or live prices; the pending ribbon then
// offers "a trip with supplier test data".
const { html, raw } = require('../../lib/html');
const { sprite, icon } = require('../icons');
const { logo } = require('../layout');
const { LABELS } = require('../../business/roles');
const { BUSINESS_EMAIL } = require('../../business/constants');
const tz = require('../../business/tz');
const { safeZone } = require('./format');
const { statusPill, notice: noticeBox, errorBox, NO_SUPPLIER, DEMO_RIBBON, SANDBOX_RIBBON, LIVE_RIBBON } = require('./parts');

/** The icon beside each section of the workspace menu (http.NAV keys). */
const NAV_ICONS = Object.freeze({
  home: 'compass', plan: 'plane', trips: 'calendar', approvals: 'check', policy: 'shield', budgets: 'wallet',
  people: 'users', reports: 'chart', activity: 'clock', settings: 'sliders',
});

/** The ribbon with no demo inventory: no demo flights or hotels exist to talk about. */
const PREVIEW_RIBBON = 'Preview: nothing is booked or charged. No emails are sent.';

/**
 * The pending-company ribbon (§B3). It offers a demo trip only when demo inventory runs here: with no
 * supplier (production) or a live one there is no demo trip to try, as with the demo ribbon. With supplier
 * test data it offers a trip with that.
 * @param {string} name the company's
 * @param {{ demo?: boolean, sandbox?: boolean }} [opts] demo: the inventory status is 'demo'; sandbox: 'sandbox'
 */
const pendingRibbon = (name, { demo = false, sandbox = false } = {}) => `Tripelyx is confirming ${name}. You can set up policies, departments and budgets${demo ? ' and try a demo trip' : sandbox ? ' and try a trip with supplier test data' : ''} now. Teammates can join once it's confirmed.`;

const inventoryStatus = ctx => (ctx.business && ctx.business.inventory && ctx.business.inventory.status) || 'none';

/** The first ribbon's text and class, by inventory status. */
function firstRibbon(status) {
  if (status === 'demo') return { text: DEMO_RIBBON, cls: 'bz-ribbon bz-ribbon-demo' };
  if (status === 'sandbox') return { text: SANDBOX_RIBBON, cls: 'bz-ribbon bz-ribbon-demo bz-ribbon-test', tag: true };
  if (status === 'live') return { text: LIVE_RIBBON, cls: 'bz-ribbon bz-ribbon-demo' };
  return { text: PREVIEW_RIBBON, cls: 'bz-ribbon bz-ribbon-demo' };
}

function ribbons(ctx, shell, { searchPage }) {
  const status = inventoryStatus(ctx);
  const first = firstRibbon(status);
  return html`<div class="bz-ribbons">
    <p class="${first.cls}" role="note">${icon('info')}${first.tag ? html`<span class="bz-test-tag">TEST DATA</span>` : ''}<span>${first.text}</span></p>
    ${shell.org.status === 'pending' ? html`<p class="bz-ribbon bz-ribbon-pending" role="note">${icon('clock')}<span>${pendingRibbon(shell.org.name, { demo: status === 'demo', sandbox: status === 'sandbox' })}</span></p>` : ''}
    ${searchPage && status === 'none' ? html`<p class="bz-ribbon bz-ribbon-supplier" role="note">${icon('plug')}<span><b>${NO_SUPPLIER.title}</b> ${NO_SUPPLIER.text}</span></p>` : ''}
  </div>`;
}

const countChip = n => (Number.isInteger(n) && n > 0 ? html`<span class="bz-count">${String(n)}<span class="sr-only"> waiting</span></span>` : '');

function navList(shell) {
  return html`<ul class="bz-nav-list">${shell.nav.map(n => html`<li><a class="bz-nav-link" href="${n.href}"${n.current ? raw(' aria-current="page"') : ''}>${icon(NAV_ICONS[n.key] || 'arrow')}<span>${n.label}</span>${n.key === 'approvals' ? countChip(shell.approvalsCount) : ''}</a></li>`)}</ul>`;
}

function switcher(ctx, shell) {
  const { org, member } = shell;
  const companies = Array.isArray(shell.companies) ? shell.companies : [];
  const max = ctx.config && ctx.config.business ? ctx.config.business.maxOrgsPerUser : 0;
  const list = companies.some(c => c.id === org.id) ? companies : [{ id: org.id, name: org.name, status: org.status, role: member.role, roleLabel: LABELS[member.role] }, ...companies];
  return html`<details class="bz-pop-wrap bz-switch">
    <summary class="bz-chipbtn bz-switch-sum"><span class="bz-switch-org">${org.name}</span><span class="bz-switch-role"> · ${LABELS[member.role] || member.role}</span><span class="bz-caret" aria-hidden="true">▾</span></summary>
    <div class="bz-pop">
      <p class="bz-pop-title">Your companies</p>
      <ul class="bz-switch-list">${list.map(c => html`<li><a href="/business/o/${c.id}"${c.id === org.id ? raw(' aria-current="true"') : ''}><span class="bz-switch-name">${c.name}</span><span class="bz-switch-meta"><span>${c.roleLabel || LABELS[c.role] || c.role}</span>${statusPill(c.status, { kind: 'org' })}</span></a></li>`)}</ul>
      <ul class="bz-pop-links">
        ${list.length < max ? html`<li><a href="/business/start">${icon('plus')}<span>Create another company</span></a></li>` : ''}
        <li><a href="/business/app">${icon('layers')}<span>Your companies</span></a></li>
      </ul>
    </div>
  </details>`;
}

function userMenu(ctx, shell) {
  const { org, member } = shell;
  const name = String(member.name || '');
  return html`<details class="bz-pop-wrap bz-user">
    <summary class="bz-chipbtn bz-user-sum">${icon('user')}<span class="bz-user-first">${name.split(' ')[0]}</span><span class="sr-only"> (account menu)</span></summary>
    <div class="bz-pop bz-pop-end">
      <p class="bz-user-name">${name}</p>
      <p class="bz-user-role">${LABELS[member.role] || member.role} at ${org.name}</p>
      <p class="bz-user-note">${icon('lock')}<span>Your personal trips stay private to you.</span></p>
      <ul class="bz-pop-links">
        ${ctx.trips ? html`<li><a href="/my-trips">${icon('plane')}<span>Personal trips</span></a></li>` : ''}
        <li><form method="post" action="/business/signout"><button class="bz-linkbtn" type="submit">${icon('arrow-left')}<span>Sign out</span></button></form></li>
      </ul>
    </div>
  </details>`;
}

/**
 * A workspace page.
 * @param {object} ctx the app context (assetVersion, now, trips, config.business.maxOrgsPerUser, business)
 * @param {import('../../business/types').ShellModel} shell from http.shellContext
 * @param {{ title?: string, body: *, notice?: string|null, error?: string|null, searchPage?: boolean,
 *   scripts?: string[], bodyClass?: string }} page
 *   title: the page's name ('' on the company home); notice/error: fixed texts the route chose (a success after a
 *   303, or a 4xx re-render); searchPage: show "Supplier not connected yet" when no supplier is connected;
 *   scripts: extra same-origin scripts, deferred, after /js/business.js
 * @returns {import('../../lib/html').SafeHtml}
 */
function shellView(ctx, shell, { title = '', body, notice = null, error = null, searchPage = false, scripts = [], bodyClass = '' } = {}) {
  if (!shell || !shell.org || !shell.member || !Array.isArray(shell.nav)) throw new Error('[business] shellView needs http.shellContext()');
  const { org } = shell;
  const v = ctx.assetVersion || '1';
  const base = `/business/o/${org.id}`;
  const year = ctx.now ? tz.localDate(safeZone(org.timezone), ctx.now()).slice(0, 4) : '';
  const current = shell.nav.find(n => n.current);
  const approvals = shell.approvalsCount === null || shell.approvalsCount === undefined ? '' : html`<a class="bz-chipbtn bz-top-approvals" href="${base}/approvals">${icon('check')}<span class="bz-top-label">Approvals</span>${countChip(shell.approvalsCount)}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title ? `${title} · ` : ''}${org.name} | Tripelyx Business</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0b2545">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css?v=${v}">
<link rel="stylesheet" href="/css/business.css?v=${v}">
</head>
<body class="bz-app${bodyClass ? ` ${bodyClass}` : ''}">
${sprite}
<a class="skip-link" href="#main">Skip to content</a>
<header class="bz-top">
  <div class="bz-top-inner">
    <a class="bz-brand" href="${base}">${logo('bz-wordmark')}<span class="bz-brand-sub">Business</span></a>
    ${switcher(ctx, shell)}
    ${approvals}
    ${userMenu(ctx, shell)}
  </div>
  <details class="bz-menu">
    <summary class="bz-menu-sum">${icon('menu')}<span>Menu</span>${current ? html`<span class="bz-menu-current"> · ${current.label}</span>` : ''}</summary>
    <nav class="bz-nav" aria-label="Workspace">${navList(shell)}</nav>
  </details>
</header>
<div class="bz-frame">
  <nav class="bz-side bz-nav" aria-label="Workspace">${navList(shell)}</nav>
  <main id="main" class="bz-main" tabindex="-1">
    ${ribbons(ctx, shell, { searchPage })}
    ${noticeBox(notice)}${errorBox(error)}
    ${body}
  </main>
</div>
<footer class="bz-foot">
  <p>Tripelyx Business is a Tripelyx Inc product · <a href="mailto:${BUSINESS_EMAIL}">${BUSINESS_EMAIL}</a> · © ${year ? `${year} ` : ''}Tripelyx Inc.</p>
</footer>
<script src="/js/business.js?v=${v}" defer></script>
${scripts.map(s => html`<script src="${s}?v=${v}" defer></script>`)}
</body>
</html>`;
}

/**
 * A refusal inside the workspace (lead decision L2-1): the 404, the role's 403 and the 429 for a member whose
 * company and member record the gate knows, drawn in the shell (switcher, menu, ribbons, the Business footer)
 * with a way back to the company home, instead of the consumer error page. The route sets the status.
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ title: string, message: string }} page
 */
function shellErrorView(ctx, shell, { title, message }) {
  const base = `/business/o/${shell.org.id}`;
  const body = html`<section class="bz-card bz-stack" aria-labelledby="bz-refusal-title">
    <h1 id="bz-refusal-title">${title}</h1>
    <p>${message}</p>
    <p class="bz-inline"><a class="btn btn-navy bz-btn" href="${base}">${icon('arrow-left')}<span>Back to ${shell.org.name} home</span></a></p>
  </section>`;
  return shellView(ctx, shell, { title, body });
}

module.exports = { shellView, shellErrorView, pendingRibbon, PREVIEW_RIBBON, NAV_ICONS };
