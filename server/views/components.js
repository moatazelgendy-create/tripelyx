// Small view pieces shared by the consumer pages.
const { html } = require('../lib/html');

function pageHero({ eyebrow, title, accent, lead, actions }) {
  return html`<section class="page-hero"><div class="container"><div class="page-hero-inner">
    <p class="eyebrow eyebrow-light">${eyebrow}</p>
    <h1>${title}${accent ? html` <span class="accent">${accent}</span>` : ''}</h1>
    ${lead ? html`<p class="lead">${lead}</p>` : ''}
    ${actions ? html`<div class="hero-actions">${actions}</div>` : ''}
  </div></div></section>`;
}

// The four travel products on their own, each AVAILABLE only when its flag is on and a provider is
// registered (the same test the /book routes use), otherwise COMING SOON. Never a link to a service
// that is not connected.
const PRODUCTS = [['hotels', 'Stays'], ['flights', 'Flights'], ['cars', 'Cars'], ['cruises', 'Cruises']];
function productStates(ctx) {
  const flags = (ctx.config && ctx.config.flags) || {};
  return PRODUCTS.map(([key, label]) => {
    const on = !!(flags[key] && ctx.registry && ctx.registry.get(key));
    return { key, label, state: on ? 'available' : 'soon', href: on ? `/book/${key}` : null };
  });
}

// One product as a status line: a link when available, plain text with a COMING SOON badge otherwise.
function productItem(p, { cls = '' } = {}) {
  return p.state === 'available'
    ? html`<a class="${cls}" href="${p.href}">${p.label}</a>`
    : html`<span class="${cls} is-soon">${p.label} <small class="soon-badge">Coming soon</small></span>`;
}

module.exports = { pageHero, productStates, productItem, PRODUCTS };
