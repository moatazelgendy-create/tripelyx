const { html, raw } = require('../lib/html');
const { sprite, icon } = require('./icons');
const { current } = require('../lib/requestContext');
const { productStates, productItem } = require('./components');

// The navigation. Desktop: the four travel products (each AVAILABLE or COMING SOON from its flag),
// the AI Trip Builder and My Trips. Mobile: Search, AI Agent, Trips, Account. Every page that builds
// or shows a trip passes active: 'plan', so the AI Trip Builder is marked on all of them.
const TRIP_NAV = [
  { href: '/agent', label: 'AI Trip Builder', key: 'plan' },
  { href: '/my-trips', label: 'My Trips', key: 'my-trips' },
];
// With the trip planner off there is no agent and no trips to show: how it works and help instead.
const INFO_NAV = [
  { href: '/how-it-works', label: 'How it works', key: 'how' },
  { href: '/faq', label: 'Help', key: 'faq' },
];

function logo(cls = '') {
  return html`<span class="wordmark ${cls}">TRIPELY<span class="wordmark-x">X</span></span>`;
}

function accountArea(user) {
  if (!user) return html`<a class="btn btn-ghost btn-sm header-cta" href="/signin">${icon('user')} Sign in</a>`;
  return html`<div class="header-account header-cta">
    ${user.isAdmin ? html`<a class="text-link header-admin" href="/admin">Admin</a>` : ''}
    <a class="btn btn-ghost btn-sm" href="/my-trips#account">${icon('user')} ${user.name.split(' ')[0]}</a>
  </div>`;
}

// The products as one group when none is connected yet (one COMING SOON for the four), one by one
// as soon as any of them is available.
function productNav(products) {
  if (products.every(p => p.state === 'soon')) {
    return html`<li class="nav-products is-soon"><span>${products.map(p => p.label).join(' · ')}</span> <small class="soon-badge">Coming soon</small></li>`;
  }
  return products.map(p => html`<li class="nav-product">${productItem(p)}</li>`);
}

function header(active, ctx) {
  const trips = !!ctx.trips;
  const { user } = current();
  const nav = trips ? TRIP_NAV : INFO_NAV;
  const mobile = trips
    ? [['/#search', 'Search', 'search', 'search'], ['/agent', 'AI Agent', 'plan', 'sparkle'], ['/my-trips', 'Trips', 'my-trips', 'bag'], [user ? '/my-trips#account' : '/signin', 'Account', 'account', 'user']]
    : [['/how-it-works', 'How it works', 'how', 'compass'], ['/faq', 'Help', 'faq', 'info'], ['/contact', 'Contact', 'contact', 'mail']];
  const here = key => (key === active ? raw(' aria-current="page"') : '');
  return html`
<header class="site-header site-header-trips" data-header>
  <div class="container header-inner">
    <a class="header-logo" href="/" aria-label="Tripelyx home">${logo()}</a>
    <nav class="main-nav" id="main-nav" aria-label="Main">
      <ul class="nav-desktop">
        ${productNav(productStates(ctx))}
        ${nav.map(n => html`<li><a href="${n.href}"${here(n.key)}>${n.label}</a></li>`)}
      </ul>
      <ul class="nav-mobile">
        ${mobile.map(([href, label, key, ic]) => html`<li><a href="${href}"${here(key)}>${icon(ic)} ${label}</a></li>`)}
      </ul>
    </nav>
    ${trips ? accountArea(user) : ''}
    <button class="nav-toggle" type="button" aria-controls="main-nav" aria-expanded="false" data-nav-toggle>
      <span class="sr-only">Menu</span>${icon('menu', 'icon-open')}${icon('close', 'icon-close')}
    </button>
  </div>
</header>`;
}

// Explore / Company / Support / Legal, the brand line and the legal entity from the company config.
function footer(company, trips) {
  const col = (title, links) => html`<div class="tf-col"><h2>${title}</h2><ul>${links.map(([h, l]) => html`<li><a href="${h}">${l}</a></li>`)}</ul></div>`;
  const year = company.copyrightYear || new Date().getUTCFullYear();
  return html`
<footer class="site-footer trip-footer">
  <div class="container">
    <div class="tf-top">
      <div class="tf-brand"><a class="footer-logo" href="/" aria-label="Tripelyx home">${logo()}</a><p>${company.footerLine}</p></div>
      ${col('Explore', trips
        ? [['/agent', 'AI Trip Builder'], ['/challenge', 'Beat my trip'], ['/destinations', 'Destinations'], ['/how-it-works', 'How it works']]
        : [['/how-it-works', 'How it works']])}
      ${col('Company', [['/about', 'About Tripelyx'], ['/partners', 'For travel businesses']])}
      ${col('Support', [['/faq', 'Help and FAQ'], ['/contact', 'Contact support'], ...(trips ? [['/manage', 'Find a booking'], ['/my-trips', 'My Trips']] : [])])}
      ${col('Legal', [['/legal/terms', 'Terms'], ['/legal/privacy', 'Privacy'], ['/legal/cookies', 'Cookies'], ['/legal/cancellation', 'Cancellation'], ['/legal/refunds', 'Refunds'], ['/legal/travel-disclosures', 'Travel disclosures']])}
    </div>
    <p class="copyright">© ${year} ${company.legalName}. All rights reserved.</p>
  </div>
</footer>`;
}

function layout({ title, description, active, body, scripts = [], bodyClass = '', ctx = {}, canonical = null, noindex = false }) {
  const trips = !!(ctx.trips);
  const company = ctx.company || (ctx.config && ctx.config.company);
  const brand = company.brandName;
  const fullTitle = title ? `${title} | ${brand}` : `${brand} — AI travel agent. ${company.promise}`;
  const desc = description || company.description;
  const base = ctx.config && ctx.config.publicBaseUrl ? ctx.config.publicBaseUrl.replace(/\/$/, '') : '';
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${fullTitle}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#0b2545">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${brand}">
<meta property="og:image" content="${base}/img/coast-hero.jpg">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css?v=${ctx.assetVersion || '1'}">
<link rel="stylesheet" href="/css/trips.css?v=${ctx.assetVersion || '1'}">
${canonical && ctx.config && ctx.config.publicBaseUrl ? html`<link rel="canonical" href="${ctx.config.publicBaseUrl}${canonical}">` : ''}
${noindex ? raw('<meta name="robots" content="noindex">') : ''}
${ctx.preload || ''}
</head>
<body class="${bodyClass}">
${sprite}
<a class="skip-link" href="#main">Skip to content</a>
${ctx.envBanner ? html`<aside class="env-banner" aria-label="Environment notice">${ctx.envBanner}</aside>` : ''}
${header(active, ctx)}
<main id="main" tabindex="-1">
${body}
</main>
${footer(company, trips)}
<script src="/js/site.js?v=${ctx.assetVersion || '1'}" defer></script>
${scripts.map(s => html`<script src="${s}?v=${ctx.assetVersion || '1'}" defer></script>`)}
</body>
</html>`;
}

module.exports = { layout, logo, TRIP_NAV };
