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

module.exports = { pageHero };
