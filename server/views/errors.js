const { html } = require('../lib/html');
const { icon } = require('./icons');
const { layout } = require('./layout');

// With Travel by Budget on these pages wear the trip header, so "Back to home" goes where its logo goes.
const homeHref = ctx => (ctx.trips ? '/ai-travel-agent' : '/');

function notFoundView(ctx) {
  return layout({
    title: 'Page not found', ctx,
    body: html`<section class="container notfound"><p class="eyebrow">Error 404</p><h1>Page not found</h1>
      <p class="section-lead">The page you’re looking for has moved or never existed.</p>
      <a class="btn btn-navy btn-lg" href="${homeHref(ctx)}">Back to home ${icon('arrow')}</a></section>`,
  });
}

function errorView(ctx, { status, message, ref }) {
  return layout({
    title: status >= 500 ? 'Something went wrong' : 'Request problem', ctx,
    body: html`<section class="container notfound"><p class="eyebrow">Error ${status}</p><h1>${status >= 500 ? 'Something went wrong' : 'We couldn’t do that'}</h1>
      <p class="section-lead">${message}</p>
      ${ref ? html`<p class="error-ref">Reference: <code>${ref}</code></p>` : ''}
      <a class="btn btn-navy btn-lg" href="${homeHref(ctx)}">Back to home ${icon('arrow')}</a></section>`,
  });
}

module.exports = { notFoundView, errorView };
