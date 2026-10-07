const { html, raw } = require('../lib/html');
const { sprite, icon } = require('./icons');
const { current } = require('../lib/requestContext');

// The consumer navigation. Links that need the trip planner are left out when it is off.
const TRIP_NAV = [
  { href: '/plan', label: 'Build My Trip', key: 'plan', trips: true },
  { href: '/how-it-works', label: 'How It Works', key: 'how' },
  { href: '/destinations', label: 'Destinations', key: 'destinations', trips: true },
  { href: '/my-trips', label: 'My Trips', key: 'my-trips', trips: true },
  { href: '/faq', label: 'Help', key: 'faq' },
];

function logo(cls = '') {
  return html`<span class="wordmark ${cls}">TRIPELY<span class="wordmark-x">X</span></span>`;
}

function accountArea(user) {
  if (!user) return html`<a class="btn btn-ghost btn-sm header-cta" href="/signin">${icon('user')} Sign in</a>`;
  return html`<div class="header-account header-cta">
    ${user.isAdmin ? html`<a class="text-link header-admin" href="/admin">Admin</a>` : ''}
    <a class="btn btn-ghost btn-sm" href="/my-trips">${icon('user')} ${user.name.split(' ')[0]}</a>
  </div>`;
}

function header(active, trips) {
  const nav = TRIP_NAV.filter(n => trips || !n.trips);
  const { user } = current();
  return html`
<header class="site-header site-header-trips" data-header>
  <div class="container header-inner">
    <a class="header-logo" href="/" aria-label="Tripelyx home">${logo()}</a>
    <nav class="main-nav" id="main-nav" aria-label="Main">
      <ul>
        ${nav.map(n => html`<li><a href="${n.href}"${n.key === active ? raw(' aria-current="page"') : ''}>${n.label}</a></li>`)}
      </ul>
      ${trips ? html`<a class="btn btn-navy btn-sm nav-cta-mobile" href="${user ? '/my-trips' : '/signin'}">${user ? 'My account' : 'Sign in'} ${icon('arrow')}</a>` : ''}
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
        ? [['/plan', 'Build my trip'], ['/challenge', 'Beat my trip'], ['/destinations', 'Destinations'], ['/how-it-works', 'How it works']]
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
${header(active, trips)}
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
