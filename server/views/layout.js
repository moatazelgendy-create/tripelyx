const { html, raw } = require('../lib/html');
const { sprite, icon } = require('./icons');
const { current } = require('../lib/requestContext');

const NAV = [
  { href: '/', label: 'Home', key: 'home' },
  { href: '/brands', label: 'Our Brands', key: 'brands' },
  { href: '/technology', label: 'Technology', key: 'technology' },
  { href: '/partners', label: 'Partners', key: 'partners' },
  { href: '/about', label: 'About', key: 'about' },
  { href: '/contact', label: 'Contact', key: 'contact' },
];

// With Travel by Budget on, the site leads with trip planning; the company pages move to the footer.
const TRIP_NAV = [
  { href: '/plan', label: 'Build My Trip', key: 'plan' },
  { href: '/how-it-works', label: 'How It Works', key: 'how' },
  { href: '/destinations', label: 'Destinations', key: 'destinations' },
  { href: '/my-trips', label: 'My Trips', key: 'my-trips' },
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
  const nav = trips ? TRIP_NAV : NAV;
  const { user } = current();
  return html`
<header class="site-header${trips ? ' site-header-trips' : ''}" data-header>
  <div class="container header-inner">
    <a class="header-logo" href="/" aria-label="Tripelyx home">${logo()}</a>
    <nav class="main-nav" id="main-nav" aria-label="Main">
      <ul>
        ${nav.map(n => html`<li><a href="${n.href}"${n.key === active ? raw(' aria-current="page"') : ''}>${n.label}</a></li>`)}
      </ul>
      ${trips
        ? html`<a class="btn btn-navy btn-sm nav-cta-mobile" href="${user ? '/my-trips' : '/signin'}">${user ? 'My account' : 'Sign in'} ${icon('arrow')}</a>`
        : html`<a class="btn btn-navy btn-sm nav-cta-mobile" href="/partners#partner-form">Partner With Us ${icon('arrow')}</a>`}
    </nav>
    ${trips ? accountArea(user) : html`<a class="btn btn-navy btn-sm header-cta" href="/partners#partner-form">Partner With Us ${icon('arrow')}</a>`}
    <button class="nav-toggle" type="button" aria-controls="main-nav" aria-expanded="false" data-nav-toggle>
      <span class="sr-only">Menu</span>${icon('menu', 'icon-open')}${icon('close', 'icon-close')}
    </button>
  </div>
</header>`;
}

function tripFooter() {
  const col = (title, links) => html`<div class="tf-col"><h2>${title}</h2><ul>${links.map(([h, l]) => html`<li><a href="${h}">${l}</a></li>`)}</ul></div>`;
  return html`
<footer class="site-footer trip-footer">
  <div class="container">
    <div class="tf-top">
      <div class="tf-brand"><a class="footer-logo" href="/" aria-label="Tripelyx home">${logo()}</a><p>You set the budget. We build the trip, and keep the numbers clear.</p></div>
      ${col('Plan', [['/plan', 'Build My Trip'], ['/plan?style=surprise', 'Surprise Me'], ['/destinations', 'Destinations'], ['/trips-under-1000', 'Trips under $1,000'], ['/trips-under-1500', 'Trips under $1,500'], ['/beach-vacations', 'Beach vacations']])}
      ${col('Help', [['/how-it-works', 'How it works'], ['/faq', 'FAQ'], ['/my-trips', 'My Trips'], ['/manage', 'Find a booking'], ['/custom-trip', 'Request a custom trip'], ['/contact', 'Contact us']])}
      ${col('Company', [['/about', 'About us'], ['/brands', 'Our brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/book', 'Alamein Go booking']])}
      ${col('Policies', [['/legal/terms', 'Terms & Conditions'], ['/legal/privacy', 'Privacy Policy'], ['/legal/cancellation', 'Cancellation Policy'], ['/legal/refunds', 'Refund Policy'], ['/legal/cookies', 'Cookie Policy'], ['/legal/travel-disclosures', 'Travel Disclosures']])}
    </div>
    <p class="copyright">© ${new Date().getFullYear()} Tripelyx LLC. All rights reserved.</p>
  </div>
</footer>`;
}

function footer() {
  return html`
<footer class="site-footer">
  <div class="container footer-inner">
    <a class="footer-logo" href="/" aria-label="Tripelyx home">${logo()}</a>
    <nav class="footer-nav" aria-label="Footer">
      <ul>${NAV.slice(1).map(n => html`<li><a href="${n.href}">${n.label}</a></li>`)}</ul>
    </nav>
    <ul class="social" aria-label="Tripelyx on social media">
      <li><a href="https://www.linkedin.com/" rel="noopener" target="_blank" aria-label="LinkedIn">${icon('linkedin')}</a></li>
      <li><a href="https://www.instagram.com/" rel="noopener" target="_blank" aria-label="Instagram">${icon('instagram')}</a></li>
      <li><a href="https://www.youtube.com/" rel="noopener" target="_blank" aria-label="YouTube">${icon('youtube')}</a></li>
    </ul>
    <p class="copyright">© ${new Date().getFullYear()} Tripelyx LLC. All rights reserved.</p>
  </div>
</footer>`;
}

function layout({ title, description, active, body, scripts = [], bodyClass = '', ctx = {}, canonical = null, noindex = false }) {
  const trips = !!(ctx.trips);
  const fullTitle = title ? `${title} | Tripelyx` : trips ? 'Tripelyx — Tell us what you want your trip to do. The AI builds it.' : 'Tripelyx — Travel technology that powers better journeys';
  const desc = description || 'Tripelyx builds travel platforms and technology that connect travelers, destinations and local businesses across the world.';
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
<meta property="og:image" content="/img/coast-hero.jpg">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css?v=${ctx.assetVersion || '1'}">
${trips ? html`<link rel="stylesheet" href="/css/trips.css?v=${ctx.assetVersion || '1'}">` : ''}
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
${trips ? tripFooter() : footer()}
<script src="/js/site.js?v=${ctx.assetVersion || '1'}" defer></script>
${scripts.map(s => html`<script src="${s}?v=${ctx.assetVersion || '1'}" defer></script>`)}
</body>
</html>`;
}

module.exports = { layout, logo, NAV, TRIP_NAV };
