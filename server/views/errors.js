const { html } = require('../lib/html');
const { icon } = require('./icons');
const { layout } = require('./layout');

// Where "start a new trip" goes: the agent when the planner is on, else the homepage.
const startHref = ctx => (ctx.trips ? '/agent' : '/');

// Every dead end offers a way forward: never a page with nothing to do but go home.
function actions(ctx, extra = '') {
  return html`<div class="notfound-actions">${extra}${ctx.trips ? html`<a class="btn btn-navy btn-lg" href="${startHref(ctx)}">Start a new trip ${icon('arrow')}</a>` : ''}<a class="btn btn-ghost btn-lg" href="/">Back to home</a></div>`;
}

function notFoundView(ctx) {
  return layout({
    title: 'Page not found', ctx, noindex: true,
    body: html`<section class="container notfound"><p class="eyebrow">Error 404</p><h1>Page not found</h1>
      <p class="section-lead">This page doesn’t exist. If you followed a link to a trip, it may have been built for dates that have passed.</p>
      ${actions(ctx)}</section>`,
  });
}

// A trip, conversation, checkout or hunt link that can no longer be opened: past dates, a link that
// was never valid, or one that belongs to someone else (which looks the same, on purpose).
function linkGoneView(ctx, { message = null, what = 'trip' } = {}) {
  return layout({
    title: `This ${what} link is no longer available`, ctx, noindex: true,
    body: html`<section class="container notfound"><p class="eyebrow">Link no longer available</p><h1>This ${what} link is no longer available.</h1>
      <p class="section-lead">${message || 'It may be for dates that have passed, or it may belong to another browser or account. Nothing was charged.'}</p>
      ${actions(ctx)}</section>`,
  });
}

function errorView(ctx, { status, message, ref, code, details }) {
  if (Object.prototype.hasOwnProperty.call(LINK_GONE, code)) return linkGoneView(ctx, LINK_GONE[code]());
  const booked = code === 'already_booked' && details && details.ref;
  return layout({
    title: status >= 500 ? 'Something went wrong' : status === 429 ? 'Too many requests' : 'Request problem', ctx, noindex: true,
    body: html`<section class="container notfound"><p class="eyebrow">Error ${status}</p><h1>${status >= 500 ? 'Something went wrong' : status === 429 ? 'Please wait a moment' : 'We couldn’t do that'}</h1>
      <p class="section-lead">${message}</p>
      ${ref ? html`<p class="error-ref">Reference: <code>${ref}</code></p>` : ''}
      ${actions(ctx, booked ? html`<a class="btn btn-navy btn-lg" href="/manage?ref=${booked}">Find your booking ${icon('arrow')}</a>` : '')}</section>`,
  });
}

// The codes that mean "this link can't be opened any more", with what to say for each.
const LINK_GONE = {
  trip_not_found: () => ({ what: 'trip' }),
  trip_expired: () => ({ what: 'trip', message: 'This trip was built for dates that have passed. Nothing was charged.' }),
  trip_unavailable: () => ({ what: 'trip', message: 'A supplier no longer offers part of this trip at any price. Nothing was charged; a new search builds around what’s available now.' }),
  quote_not_found: () => ({ what: 'checkout', message: 'This checkout link was never valid or has been removed. Nothing was charged.' }),
  agent_not_found: () => ({ what: 'trip', message: 'This conversation may belong to another browser or account, or it may have been removed.' }),
  hunt_not_found: () => ({ what: 'hunt', message: 'This hunt may belong to another account, or it may have been removed. Your own hunts are under My Trips.' }),
};

module.exports = { notFoundView, errorView, linkGoneView, LINK_GONE };
