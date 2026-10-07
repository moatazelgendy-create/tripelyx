// Sign in, create account, and My Trips.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { contextParams } = require('../../trips/optimizer');
const { money, dollars, longDate, shortDate, plural, statusPill, demoBadge } = require('./common');
const { huntRows } = require('./hunts');

function authView(ctx, { mode, error, errors = {}, values = {}, next = '' }) {
  const signin = mode === 'signin';
  const body = html`
<div class="container tb-auth">
  <div class="tb-auth-card">
    <h1>${signin ? 'Sign in' : 'Create your account'}</h1>
    <p class="tb-muted">${signin ? 'Your saved trips, price watches and bookings in one place.' : 'Save trips, watch prices and find every booking without digging through emails.'}</p>
    ${error ? html`<div class="alert alert-error" role="alert">${icon('alert')}<span>${error}</span></div>` : ''}
    <form class="form" method="post" action="/${signin ? 'signin' : 'signup'}" novalidate>
      <input type="hidden" name="next" value="${next}">
      ${signin ? '' : html`<div class="field"><label for="a-name">Your name</label><input id="a-name" name="name" autocomplete="name" required maxlength="80" value="${values.name || ''}"${errors.name ? raw(' aria-invalid="true"') : ''}><p class="field-error">${errors.name || ''}</p></div>`}
      <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="email" required maxlength="120" value="${values.email || ''}"${errors.email ? raw(' aria-invalid="true"') : ''}><p class="field-error">${errors.email || ''}</p></div>
      <div class="field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" autocomplete="${signin ? 'current-password' : 'new-password'}" required minlength="10" maxlength="200"${errors.password ? raw(' aria-invalid="true"') : ''}><p class="field-hint">${signin ? '' : 'At least 10 characters.'}</p><p class="field-error">${errors.password || ''}</p></div>
      <button class="btn btn-navy btn-lg btn-block" type="submit">${signin ? 'Sign in' : 'Create account'} ${icon('arrow')}</button>
    </form>
    <p class="tb-auth-switch">${signin ? html`New here? <a href="/signup?next=${encodeURIComponent(next)}">Create an account</a>` : html`Already have an account? <a href="/signin?next=${encodeURIComponent(next)}">Sign in</a>`} · <a href="/manage">Find a booking without an account</a></p>
  </div>
</div>`;
  return layout({ title: signin ? 'Sign in' : 'Create account', active: 'my-trips', body, ctx, noindex: true });
}

function tripRow(b) {
  const t = b.trip || b.quote.trip;
  return html`<li class="tb-mytrip">
    <img src="${t.dest.image.url}" alt="" width="200" height="125" loading="lazy">
    <div>
      <p class="tb-kicker">TRIP #${b.ref} ${statusPill(b.status)} ${b.demo ? demoBadge(true, 'Demo booking') : ''}</p>
      <h3><a href="/booking/${b.ref}">${plural(t.spec.nights, 'night')} in ${t.dest.name}</a></h3>
      <p>${longDate(t.spec.depart)} – ${shortDate(t.flight.return)} · ${plural(t.spec.travelers, 'traveler')} · ${t.hotel.name}</p>
      <p class="tb-small tb-muted">Total paid ${money(b.total)}</p>
    </div>
    <div class="tb-mytrip-actions"><a class="btn btn-ghost btn-sm" href="/booking/${b.ref}">Open trip ${icon('arrow')}</a>${b.status === 'cancelled' || b.status === 'refunded' ? '' : html`<form method="post" action="/agent"><input type="hidden" name="ref" value="${b.ref}"><button class="btn btn-ghost btn-sm" type="submit">Ask your travel agent</button></form>`}</div>
  </li>`;
}

// A saved trip or a price watch, re-priced. A watch also shows the rule it waits for and the honest
// line from the service (listSaved's `alert`): the "Alert" pill and the is-alert class appear only
// when that rule is met; otherwise the line says what moved and why no alert.
function savedRow(r, kind) {
  const t = r.trip;
  const watch = kind === 'watch';
  const met = watch && !!(r.alert && r.alert.met);
  const remove = html`<form method="post" action="/my-trips/remove"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="id" value="${r.id}"><button class="btn btn-ghost btn-sm" type="submit">Remove</button></form>`;
  if (!t) return html`<li class="tb-mytrip tb-mytrip-gone"><div><h3>${r.title}</h3><p class="tb-muted">This trip is no longer available (saved at ${money(r.priceAtSave)}).</p>${watch ? html`<p class="tb-small tb-muted">${r.ruleText}. No alert: the trip can no longer be priced.</p>` : ''}</div>${remove}</li>`;
  const cx = { budget: r.budget };
  return html`<li class="tb-mytrip${met ? ' is-alert' : ''}">
    <img src="${t.dest.image.url}" alt="" width="200" height="125" loading="lazy">
    <div>
      <p class="tb-kicker">${watch ? 'Watching price' : 'Saved'} · ${r.departed ? 'dates passed' : `saved ${shortDate(r.savedAt.slice(0, 10))}`}${met ? html` <span class="tb-delta tb-delta-save">Alert</span>` : ''}</p>
      <h3><a href="/trip/${r.token}?${contextParams(cx)}">${plural(t.spec.nights, 'night')} in ${t.dest.name}</a></h3>
      <p>${longDate(t.spec.depart)} · ${plural(t.spec.travelers, 'traveler')} · ${t.hotel.name}</p>
      <p class="tb-small">When you saved it: <b>${money(r.priceAtSave)}</b> · now: <b>${money(r.now)}</b> ${r.change === 0 ? html`<span class="tb-delta tb-delta-same">no change</span>` : html`<span class="tb-delta ${r.change < 0 ? 'tb-delta-save' : 'tb-delta-add'}">${r.change < 0 ? '−' : '+'}${money(Math.abs(r.change))}</span>`}${r.budget ? html` · ${r.now <= r.budget ? html`<span class="tb-delta tb-delta-save">under your ${dollars(r.budget)}</span>` : html`<span class="tb-delta tb-delta-add">${money(r.now - r.budget)} over your ${dollars(r.budget)}</span>`}` : ''}</p>
      ${watch ? html`<p class="tb-small tb-watch-rule"><span class="tb-muted">${r.ruleText}.</span> ${r.alert ? html`<span class="tb-watch-alert">${r.alert.text}.</span>` : ''}</p>` : ''}
    </div>
    ${remove}
  </li>`;
}

// The Hunts section: each hunt's stored facts (server/trips/hunts.js list summary), nothing searched
// here. `destName` turns a baseline's destination id into its name.
function huntsSection(hunts, destName) {
  return html`<section aria-labelledby="hu-title"><h2 id="hu-title">Hunts</h2>
    ${hunts.length ? huntRows(hunts, { destName }) : html`<p class="tb-muted">Tell the AI your max and it waits for the right trip: it asks the suppliers about every departure in your window, prices the cheapest trips inside your rules in full, and says something only when one is worth your attention. <a href="/hunts/new">Start a hunt</a>.</p>`}
    <p class="tb-small"><a href="/hunts">${hunts.length ? 'All hunts' : 'About hunts'}</a>${hunts.length ? html` · <a href="/hunts/new">Start another hunt</a>` : ''}</p>
  </section>`;
}

function myTripsView(ctx, { user, upcoming, past, saved, watches, recent, lastSearch, notice, hunts = [], destName = id => id }) {
  const body = html`
<div class="container tb-mytrips">
  <header class="tb-results-head"><div><p class="eyebrow">My Trips</p><h1>Welcome back, ${user.name.split(' ')[0]}.</h1>
    ${lastSearch ? html`<p class="tb-results-sub">Last time you looked for a ${plural(lastSearch.query.nights, 'night')} ${lastSearch.query.style === 'surprise' ? '' : `${lastSearch.query.style} `}trip around ${dollars(lastSearch.query.budget)}. <a href="/trips?${lastSearch.params}">See new deals</a> · <a href="/plan?${new URLSearchParams(Object.entries(Object.fromEntries(new URLSearchParams(lastSearch.params))).filter(([k]) => k !== 'style')).toString()}">Try a different style</a></p>` : ''}</div>
    <form method="post" action="/signout"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form></header>
  ${notice ? html`<div class="alert alert-success" role="status">${icon('check')}<span>${notice}</span></div>` : ''}
  ${recent ? html`<section class="tb-return"><img src="${recent.trip.dest.image.url}" alt="" width="160" height="100"><div><p class="tb-kicker">Still thinking about ${recent.trip.dest.name}?</p><p>Your trip is waiting: ${plural(recent.trip.spec.nights, 'night')} for ${recent.trip.spec.travelers}, now <b>${money(recent.trip.total)}</b> (price refreshed just now).</p></div><a class="btn btn-navy" href="/trip/${recent.token}?${recent.budget ? `b=${Math.round(recent.budget / 100)}` : ''}">Continue my trip ${icon('arrow')}</a></section>` : ''}
  <section aria-labelledby="up-title"><h2 id="up-title">Upcoming trips</h2>${upcoming.length ? html`<ul class="tb-mytrip-list">${upcoming.map(tripRow)}</ul>` : html`<p class="empty-state tb-empty">${icon('compass')} No upcoming trips yet. <a href="/plan">Build one from your budget</a>.</p>`}</section>
  <section aria-labelledby="sv-title"><h2 id="sv-title">Saved trips</h2>${saved.length ? html`<ul class="tb-mytrip-list">${saved.map(r => savedRow(r, 'saved'))}</ul>` : html`<p class="tb-muted">Save a trip from its page to come back to it later.</p>`}</section>
  <section aria-labelledby="w-title"><h2 id="w-title">Price watches</h2>${watches.length ? html`<ul class="tb-mytrip-list">${watches.map(r => savedRow(r, 'watch'))}</ul>` : html`<p class="tb-muted">Watch a trip and we’ll show you here when its price changes${ctx.tripService.demo ? ' (email alerts arrive once notifications are connected)' : ''}.</p>`}</section>
  ${huntsSection(hunts, destName)}
  <section aria-labelledby="past-title"><h2 id="past-title">Past trips</h2>${past.length ? html`<ul class="tb-mytrip-list">${past.map(tripRow)}</ul>` : html`<p class="tb-muted">Nothing here yet.</p>`}</section>
</div>`;
  return layout({ title: 'My Trips', active: 'my-trips', body, ctx, noindex: true });
}

module.exports = { authView, myTripsView };
