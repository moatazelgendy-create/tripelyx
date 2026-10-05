const { html, raw } = require('../lib/html');
const { sprite, icon } = require('./icons');

const NAV = [
  { href: '/', label: 'Home', key: 'home' },
  { href: '/brands', label: 'Our Brands', key: 'brands' },
  { href: '/technology', label: 'Technology', key: 'technology' },
  { href: '/partners', label: 'Partners', key: 'partners' },
  { href: '/about', label: 'About', key: 'about' },
  { href: '/contact', label: 'Contact', key: 'contact' },
];

function logo(cls = '') {
  return html`<span class="wordmark ${cls}">TRIPELY<span class="wordmark-x">X</span></span>`;
}

function header(active) {
  return html`
<header class="site-header" data-header>
  <div class="container header-inner">
    <a class="header-logo" href="/" aria-label="Tripelyx home">${logo()}</a>
    <nav class="main-nav" id="main-nav" aria-label="Main">
      <ul>
        ${NAV.map(n => html`<li><a href="${n.href}"${n.key === active ? raw(' aria-current="page"') : ''}>${n.label}</a></li>`)}
      </ul>
      <a class="btn btn-navy btn-sm nav-cta-mobile" href="/partners#partner-form">Partner With Us ${icon('arrow')}</a>
    </nav>
    <a class="btn btn-navy btn-sm header-cta" href="/partners#partner-form">Partner With Us ${icon('arrow')}</a>
    <button class="nav-toggle" type="button" aria-controls="main-nav" aria-expanded="false" data-nav-toggle>
      <span class="sr-only">Menu</span>${icon('menu', 'icon-open')}${icon('close', 'icon-close')}
    </button>
  </div>
</header>`;
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

function layout({ title, description, active, body, scripts = [], bodyClass = '', ctx = {} }) {
  const fullTitle = title ? `${title} | Tripelyx` : 'Tripelyx — Travel technology that powers better journeys';
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
${ctx.preload || ''}
</head>
<body class="${bodyClass}">
${sprite}
<a class="skip-link" href="#main">Skip to content</a>
${ctx.envBanner ? html`<aside class="env-banner" aria-label="Environment notice">${ctx.envBanner}</aside>` : ''}
${header(active)}
<main id="main" tabindex="-1">
${body}
</main>
${footer()}
<script src="/js/site.js?v=${ctx.assetVersion || '1'}" defer></script>
${scripts.map(s => html`<script src="${s}?v=${ctx.assetVersion || '1'}" defer></script>`)}
</body>
</html>`;
}

module.exports = { layout, logo, NAV };
