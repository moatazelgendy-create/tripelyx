// Booking pages: vertical search + results, offer detail, checkout, booking confirmation / manage.
// Everything renders on the server from normalized Offers and Quotes, so these views never know which
// supplier is behind a vertical. Client scripts only add loading states and the payment step.
const { html, raw, jsonScript } = require('../lib/html');
const { icon } = require('./icons');
const { layout } = require('./layout');
const { VERTICALS, getVertical } = require('../verticals');
const { addDays, today } = require('../lib/dates');
const { money, date, month, minutes, querySummary, UNIT_LABEL, STATUS_LABEL } = require('./format');

function qs(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return p.toString();
}

function offerUrl(vertical, offer, query) {
  return `/book/${vertical}/${encodeURIComponent(offer.id)}?${qs(query)}`;
}

// Default values for the search form (dates relative to today).
function defaultsFor(meta, now = new Date()) {
  const t = today(now);
  const out = {};
  for (const f of meta.search) {
    if (f.type === 'date') out[f.name] = addDays(t, f.offsetDays || 0);
    else if (f.type === 'month') out[f.name] = addDays(t, f.offsetDays || 0).slice(0, 7);
    else if (f.default !== undefined) out[f.name] = f.default;
  }
  return out;
}

const SELECT_LABELS = {
  economy: 'Economy', premium: 'Premium economy', business: 'Business',
  half_day: 'Half day (4h)', full_day: 'Full day (8h)', sunset: 'Sunset (2.5h)',
};

function lookupLabel(item) {
  return typeof item === 'string' ? item : `${item.code} — ${item.name} (${item.city})`;
}

function searchForm(meta, values, lookups, errors = {}) {
  return html`<form class="search-form" method="get" action="/book/${meta.key}" data-search-form novalidate>
    ${meta.search.map(f => {
      const id = `f-${f.name}`;
      const v = values[f.name] ?? '';
      const err = errors[f.name];
      const list = lookups && lookups[f.name];
      const listId = list ? `dl-${meta.key}-${f.name}` : null;
      const wide = f.type === 'text' || f.type === 'airport';
      const display = f.type === 'airport' && v && list ? (list.find(a => a.code === v) ? lookupLabel(list.find(a => a.code === v)) : v) : v;
      let input;
      if (f.type === 'select') {
        input = html`<select id="${id}" name="${f.name}">${f.options.map(o => html`<option value="${o}"${o === v ? raw(' selected') : ''}>${SELECT_LABELS[o] || o}</option>`)}</select>`;
      } else {
        const type = f.type === 'airport' ? 'text' : f.type;
        input = html`<input id="${id}" name="${f.name}" type="${type}" value="${display}"${f.required ? raw(' required') : ''}${f.min !== undefined ? html` min="${f.min}"` : ''}${f.max !== undefined ? html` max="${f.max}"` : ''}${f.type === 'date' ? html` min="${today()}"` : ''}${f.placeholder ? html` placeholder="${f.placeholder}"` : ''}${listId ? html` list="${listId}" autocomplete="off"` : ''}${err ? raw(' aria-invalid="true"') : ''} aria-describedby="${id}-err">`;
      }
      return html`<div class="field${wide ? ' field-wide' : ''}">
        <label for="${id}">${f.label}</label>${input}
        ${listId ? html`<datalist id="${listId}">${list.map(item => html`<option value="${lookupLabel(item)}"></option>`)}</datalist>` : ''}
        <p class="field-error" id="${id}-err">${err || ''}</p>
      </div>`;
    })}
    <button class="btn btn-blue" type="submit">${icon('search')}<span class="btn-label">Search</span></button>
  </form>`;
}

function chipsFor(offer) {
  return html`<div class="chips">
    ${offer.rating ? html`<span class="rating">${icon('star')}${offer.rating.score.toFixed(1)} <span>(${offer.rating.count})</span></span>` : ''}
    ${(offer.badges || []).map(b => html`<span class="chip">${b}</span>`)}
    ${offer.cancellation.type !== 'non_refundable' ? html`<span class="chip chip-good">${icon('check')}Free cancellation</span>` : html`<span class="chip">Non-refundable</span>`}
    ${offer.demo ? html`<span class="chip chip-demo">Demo inventory</span>` : ''}
  </div>`;
}

function resultCard(vertical, offer, query) {
  const url = offerUrl(vertical, offer, query);
  const avail = offer.options.filter(o => o.available);
  const best = (avail.length ? avail : offer.options).reduce((a, b) => (a.price.amount <= b.price.amount ? a : b));
  return html`<article class="result">
    <a class="result-media" href="${url}" tabindex="-1" aria-hidden="true"><img src="${offer.media[0] ? offer.media[0].url : ''}" alt="" loading="lazy" width="400" height="250"></a>
    <div class="result-body">
      <h3><a href="${url}">${offer.title}</a></h3>
      <p class="result-sub">${offer.subtitle || offer.location.name}</p>
      ${offer.description ? html`<p class="result-desc">${offer.description}</p>` : ''}
      ${offer.attributes && offer.attributes.length ? html`<div class="chips result-attrs">${offer.attributes.slice(0, 4).map(a => html`<span class="chip"><b>${a.label}:</b>&nbsp;${a.value}</span>`)}</div>` : ''}
      ${chipsFor(offer)}
    </div>
    <div class="result-price">
      <div>
        <span class="price-from">${avail.length ? 'from' : 'Sold out'}</span>
        <div class="price-amount">${money(offer.fromPrice.amount, offer.fromPrice.currency)}</div>
        <span class="price-unit">${UNIT_LABEL[offer.fromPrice.unit] || offer.fromPrice.unit}</span>
        ${best.total && best.total.amount !== best.price.amount ? html`<div class="price-total">${money(best.total.amount, best.total.currency)} before taxes</div>` : ''}
      </div>
      <a class="btn btn-navy btn-sm" href="${url}" aria-label="View ${offer.title}">View ${icon('arrow')}</a>
    </div>
  </article>`;
}

function resultsBlock(vertical, state) {
  const meta = getVertical(vertical);
  if (state.error) {
    const isInput = state.error.status === 422 || state.error.status === 400;
    return html`<div class="${isInput ? 'empty-state' : 'error-state'}" role="alert">${icon(isInput ? 'info' : 'alert')}
      <h3>${isInput ? 'Check your search' : 'We couldn’t load results'}</h3>
      <p>${state.error.details ? Object.values(state.error.details).join(' ') : state.error.message}</p>
      ${isInput ? '' : html`<a class="btn btn-navy btn-sm" href="">Try again</a>`}
    </div>`;
  }
  const { query, offers } = state;
  if (!offers.length) {
    return html`<div class="empty-state">${icon('search')}<h3>No ${meta.label.toLowerCase()} match your search</h3>
      <p>Try different dates, fewer travelers or another destination.</p></div>`;
  }
  return html`<div class="results-head"><h2>${offers.length} ${offers.length === 1 ? meta.noun : `${meta.label.toLowerCase()}`} found</h2><span class="count">${querySummary(vertical, query)}</span></div>
    <div class="results">${offers.map(o => resultCard(vertical, o, query))}</div>`;
}

function skeletons() {
  return html`<div class="results" aria-hidden="true">${[0, 1, 2].map(() => html`<div class="result-skeleton"><div class="skeleton"></div><div class="sk-body"><div class="skeleton sk-line"></div></div><div></div></div>`)}</div>`;
}

function bookTabs(ctx, active) {
  const enabled = VERTICALS.filter(v => ctx.config.flags[v.key]);
  return html`<nav class="vertical-tabs" aria-label="Travel services">
    ${enabled.map(v => html`<a href="/book/${v.key}"${v.key === active ? raw(' aria-current="page"') : ''}>${icon(v.icon)}${v.label}</a>`)}
  </nav>`;
}

function bookView(ctx, { vertical, values, state, lookups }) {
  const meta = getVertical(vertical);
  const errors = state.error && state.error.details ? state.error.details : {};
  const body = html`
<section class="book-hero">
  <div class="container">
    <h1>${meta.headline}</h1>
    <p>Search ${meta.label.toLowerCase()} and book in one secure checkout.</p>
    ${bookTabs(ctx, vertical)}
    <div class="search-panel">
      ${searchForm(meta, values, lookups, errors)}
      ${ctx.publicConfig.verticals.find(v => v.key === vertical && v.demo) ? html`<p class="demo-note">${icon('info')}Demo inventory: properties, operators and prices are illustrative and payments run in test mode.</p>` : ''}
    </div>
  </div>
</section>
<section class="results-section" aria-live="polite" aria-busy="false" data-results>
  <div class="container" data-results-inner>${resultsBlock(vertical, state)}</div>
</section>
<template data-skeleton>${skeletons()}</template>`;
  return layout({ title: meta.headline, body, ctx, scripts: ['/js/book.js'] });
}

function bookIndexView(ctx) {
  const enabled = VERTICALS.filter(v => ctx.config.flags[v.key]);
  const body = html`
<section class="book-hero">
  <div class="container">
    <h1>Where to next?</h1>
    <p>Stays, flights, cars, cruises, yachts, transfers, activities and experiences — one checkout.</p>
    ${bookTabs(ctx, null)}
  </div>
</section>
<section class="results-section">
  <div class="container">
    <div class="grid-4">
      ${enabled.map(v => html`<a class="card" href="/book/${v.key}"><span class="card-icon">${icon(v.icon)}</span><h2>${v.label}</h2><p>${v.headline}</p></a>`)}
    </div>
    ${enabled.length ? '' : html`<div class="empty-state">${icon('info')}<h3>Booking is not available right now</h3><p>Please check back soon.</p></div>`}
    <p class="demo-note">${icon('info')}Already booked? <a href="/manage">Manage your booking</a>.</p>
  </div>
</section>`;
  return layout({ title: 'Book', body, ctx });
}

// ---- offer detail ------------------------------------------------------------------------------

function verticalDetails(vertical, offer) {
  const d = offer.details;
  switch (vertical) {
    case 'hotels':
      return html`<div class="offer-section"><h2>Amenities</h2><ul class="amenities">${d.amenities.map(a => html`<li>${icon('check')}${a}</li>`)}</ul></div>`;
    case 'flights':
      return html`<div class="offer-section"><h2>Itinerary</h2>${d.segments.map(s => html`<div class="segment">
        <div><div class="time">${s.departAt.slice(11)}</div><b>${s.from.code}</b> · ${s.from.city}<br><small>${date(s.departAt.slice(0, 10))}</small></div>
        <div class="mid">${minutes(s.durationMinutes)}${icon('plane')}${s.carrier.name} ${s.flightNumber}<br>${s.aircraft}</div>
        <div class="end"><div class="time">${s.arriveAt.slice(11)}</div><b>${s.to.code}</b> · ${s.to.city}<br><small>${date(s.arriveAt.slice(0, 10))}</small></div>
      </div>`)}</div>
      <div class="offer-section"><h2>Fares and baggage</h2><div class="attr-grid">${d.fareFamilies.map(f => html`<div class="attr"><small>${f.code[0] + f.code.slice(1).toLowerCase()}</small><b>${f.cabinKg} kg cabin${f.checkedBags ? `, ${f.checkedBags} × ${f.checkedKg} kg checked` : ', no checked bag'}</b></div>`)}</div></div>`;
    case 'cars':
      return html`<div class="offer-section"><h2>Pick-up and drop-off</h2><div class="attr-grid">
        <div class="attr"><small>Pick-up</small><b>${d.pickup.location}</b><br>${date(d.pickup.at.slice(0, 10))}, ${d.pickup.at.slice(11)}</div>
        <div class="attr"><small>Drop-off</small><b>${d.dropoff.location}</b><br>${date(d.dropoff.at.slice(0, 10))}, ${d.dropoff.at.slice(11)}</div>
        <div class="attr"><small>Rental</small><b>${d.days} day${d.days > 1 ? 's' : ''}</b></div>
        <div class="attr"><small>Transmission</small><b>${d.transmission === 'automatic' ? 'Automatic' : 'Manual'}</b></div>
      </div></div>`;
    case 'cruises':
      return html`<div class="offer-section"><h2>Itinerary</h2><ol class="itinerary">${d.itinerary.map(p => html`<li><b>Day ${p.day} · ${p.port}</b>${p.country ? `, ${p.country}` : ''}<small>${date(p.date)}${p.arrive ? ` · arrive ${p.arrive}` : ''}${p.depart ? ` · depart ${p.depart}` : ''}</small></li>`)}</ol></div>
      <div class="offer-section"><h2>The ship</h2><p>${d.ship.name} (${d.ship.line}) · built ${d.ship.yearBuilt} · ${d.ship.guests.toLocaleString('en')} guests</p></div>`;
    case 'yachts':
      return html`<div class="offer-section"><h2>Included</h2><ul class="amenities">${d.inclusions.map(a => html`<li>${icon('check')}${a}</li>`)}</ul></div>
      <div class="offer-section"><h2>Your charter</h2><p>${d.durationLabel} on ${date(d.date)}, departing ${d.departs} from ${d.marina}. Operated by ${d.operator}.</p></div>`;
    case 'transfers':
      return html`<div class="offer-section"><h2>Your transfer</h2><div class="attr-grid">
        <div class="attr"><small>From</small><b>${d.from}</b></div><div class="attr"><small>To</small><b>${d.to}</b></div>
        <div class="attr"><small>Date</small><b>${date(d.date)}</b></div><div class="attr"><small>Journey</small><b>about ${d.durationMinutes} min</b></div>
      </div>${d.meetAndGreet ? html`<p class="policy">${icon('check')}Your driver meets you with a name sign and helps with luggage.</p>` : ''}</div>`;
    default:
      return html`<div class="offer-section"><h2>Included</h2><ul class="amenities">${d.includes.map(a => html`<li>${icon('check')}${a}</li>`)}</ul></div>
      <div class="offer-section"><h2>Meeting point</h2><p><b>${d.meetingPoint.name}</b><br>${d.meetingPoint.address}</p><p class="policy">${icon('info')}${d.meetingPoint.instructions}</p></div>`;
  }
}

function offerView(ctx, { vertical, offer, query, error, selected = {} }) {
  const meta = getVertical(vertical);
  const firstAvailable = offer.options.find(o => o.available);
  const chosen = selected.optionId || (firstAvailable && firstAvailable.id);
  const slots = offer.details.slots;
  const firstSlot = slots && slots.find(s => s.remaining >= (query.participants || 1));
  const body = html`
<div class="container">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/book">Book</a> / <a href="/book/${vertical}?${qs(query)}">${meta.label}</a> / <span aria-current="page">${offer.title}</span></nav>
  <div class="offer-layout">
    <div>
      <div class="offer-gallery${offer.media.length < 3 ? ' single' : ''}">
        ${offer.media.slice(0, offer.media.length < 3 ? 1 : 3).map((m, i) => html`<img src="${m.url}" alt="${m.alt}" ${i ? raw('loading="lazy"') : raw('fetchpriority="high"')} width="800" height="500">`)}
      </div>
      <div class="offer-head">
        <h1>${offer.title}</h1>
        <p class="result-sub">${offer.subtitle}</p>
        ${chipsFor(offer)}
      </div>
      ${offer.description ? html`<div class="offer-section"><p>${offer.description}</p></div>` : ''}
      ${offer.attributes && offer.attributes.length ? html`<div class="offer-section"><div class="attr-grid">${offer.attributes.map(a => html`<div class="attr"><small>${a.label}</small><b>${a.value}</b></div>`)}</div></div>` : ''}
      ${verticalDetails(vertical, offer)}
      <div class="offer-section"><h2>Cancellation</h2><p class="policy">${icon('shield')}${offer.cancellation.summary}</p></div>
    </div>

    <form class="summary-card" method="post" action="/book/${vertical}/${encodeURIComponent(offer.id)}/quote" data-quote-form>
      <h2>Choose your option</h2>
      <p class="summary-meta">${querySummary(vertical, query)}</p>
      ${Object.entries(query).map(([k, v]) => html`<input type="hidden" name="q_${k}" value="${v}">`)}
      ${error ? html`<div class="alert alert-error" role="alert">${icon('alert')}<span>${error}</span></div>` : ''}
      <fieldset class="options">
        <legend class="sr-only">Options</legend>
        ${offer.options.map(o => html`<label class="option${o.available ? '' : ' is-disabled'}">
          <input type="radio" name="optionId" value="${o.id}"${o.id === chosen ? raw(' checked') : ''}${o.available ? '' : raw(' disabled')} required>
          <span><b>${o.name}</b><small>${o.available ? (o.description || '') : 'Not available for your search'}${o.available && o.remaining !== undefined && o.remaining > 0 && o.remaining <= 3 ? ` · only ${o.remaining} left` : ''}</small></span>
          <span class="option-price"><b>${money(o.price.amount, o.price.currency)}</b><small>${UNIT_LABEL[offer.fromPrice.unit] || ''}</small>${o.total && o.total.amount !== o.price.amount ? html`<small>${money(o.total.amount, o.total.currency)} total</small>` : ''}</span>
        </label>`)}
      </fieldset>
      ${slots ? html`<div class="offer-section"><h2>Start time</h2><div class="slots" role="radiogroup" aria-label="Start time">${slots.map(s => {
        const ok = s.remaining >= (query.participants || 1);
        const isSel = selected.slot ? selected.slot === s.time : firstSlot && firstSlot.time === s.time;
        return html`<label class="slot"><input type="radio" name="slot" value="${s.time}"${isSel && ok ? raw(' checked') : ''}${ok ? '' : raw(' disabled')} required><span>${s.time}<small>${s.remaining ? `${s.remaining} left` : 'Full'}</small></span></label>`;
      })}</div></div>` : ''}
      <button class="btn btn-navy btn-lg btn-block" type="submit"${firstAvailable ? '' : raw(' disabled')}><span class="btn-label">${firstAvailable ? 'Continue to checkout' : 'Sold out'}</span> ${icon('arrow')}</button>
      <p class="secure-note">${icon('lock')}Final price with taxes is shown before you pay.</p>
    </form>
  </div>
</div>`;
  return layout({ title: offer.title, body, ctx, scripts: ['/js/book.js'] });
}

// ---- checkout ----------------------------------------------------------------------------------

function priceLines(lines, total, currency) {
  return html`<div class="price-lines">
    ${lines.map(l => html`<div><span>${l.label}</span><span>${money(l.amount, currency)}</span></div>`)}
    <div class="total"><span>Total</span><span>${money(total, currency)}</span></div>
  </div>`;
}

function summaryCard(q) {
  return html`<aside class="summary-card" aria-label="Booking summary">
    ${q.offer.media[0] ? html`<img class="summary-img" src="${q.offer.media[0].url}" alt="${q.offer.media[0].alt}" width="400" height="250">` : ''}
    <h2>${q.offer.title}</h2>
    <p class="summary-meta">${q.option.name}${q.selection && q.selection.slot ? ` · ${q.selection.slot}` : ''}<br>${querySummary(q.vertical, q.query)}</p>
    ${priceLines(q.lines, q.total, q.currency)}
    <p class="policy">${icon('shield')}${q.cancellation.summary}</p>
    ${q.demo ? html`<p class="policy">${icon('info')}Demo inventory — this booking won’t reach a real supplier.</p>` : ''}
  </aside>`;
}

function checkoutView(ctx, { quote, paymentConfig }) {
  const expired = quote.expired;
  const body = html`
<div class="container">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/book">Book</a> / <a href="/book/${quote.vertical}/${encodeURIComponent(quote.offer.id)}?${qs(quote.query)}">${quote.offer.title}</a> / <span aria-current="page">Checkout</span></nav>
  ${expired
    ? html`<div class="empty-state">${icon('clock')}<h3>This price has expired</h3><p>Prices are held for ${ctx.config.quoteTtlMinutes} minutes. Go back to get a fresh price.</p><a class="btn btn-navy btn-sm" href="/book/${quote.vertical}/${encodeURIComponent(quote.offer.id)}?${qs(quote.query)}">Get a new price</a></div>`
    : html`<div class="checkout-layout">
    <div>
      <p class="alert alert-info" data-quote-timer data-expires="${quote.expiresAt}">${icon('clock')}<span>We’re holding this price for <span class="timer" data-timer>${ctx.config.quoteTtlMinutes}:00</span>.</span></p>
      <form class="checkout-step form" data-traveler-form novalidate>
        <h2><span class="step-num">1</span> Lead traveler</h2>
        <div class="form-row">
          <div class="field"><label for="t-first">First name</label><input id="t-first" name="firstName" autocomplete="given-name" required maxlength="60"><p class="field-error" data-error-for="firstName"></p></div>
          <div class="field"><label for="t-last">Last name</label><input id="t-last" name="lastName" autocomplete="family-name" required maxlength="60"><p class="field-error" data-error-for="lastName"></p></div>
        </div>
        <div class="form-row">
          <div class="field"><label for="t-email">Email</label><input id="t-email" name="email" type="email" autocomplete="email" required maxlength="120"><p class="field-hint">Your confirmation is sent here.</p><p class="field-error" data-error-for="email"></p></div>
          <div class="field"><label for="t-phone">Phone <span class="optional">(optional)</span></label><input id="t-phone" name="phone" type="tel" autocomplete="tel" maxlength="30"><p class="field-error" data-error-for="phone"></p></div>
        </div>
        <div class="field"><label for="t-notes">Requests for the partner <span class="optional">(optional)</span></label><textarea id="t-notes" name="notes" maxlength="500"></textarea></div>
      </form>

      <form class="checkout-step form" data-payment-form novalidate>
        <h2><span class="step-num">2</span> Payment</h2>
        <div data-payment-widget data-mode="${paymentConfig.mode}"></div>
        <div data-form-status role="alert" aria-live="assertive"></div>
        <button class="btn btn-navy btn-lg btn-block" type="submit" data-pay-button><span class="btn-label">Pay ${money(quote.total, quote.currency)}</span> ${icon('lock')}</button>
        <p class="secure-note">${icon('lock')}${paymentConfig.mode === 'test' ? 'Test mode — no real charge is made.' : 'Payments are processed securely by our payment partner.'}</p>
        <noscript><p class="alert alert-warning">Checkout needs JavaScript to take payment securely. Please enable it and reload.</p></noscript>
      </form>
    </div>
    ${summaryCard(quote)}
  </div>`}
</div>
<script type="application/json" id="checkout-data">${jsonScript({ quoteId: quote.id, payment: paymentConfig, total: quote.total, currency: quote.currency })}</script>`;
  const scripts = ['/js/book.js', '/js/checkout.js'];
  if (paymentConfig.mode === 'test') scripts.unshift('/js/payments-test.js');
  return layout({ title: 'Checkout', body, ctx, scripts });
}

// ---- booking / manage --------------------------------------------------------------------------

function bookingView(ctx, { booking: b, cancellationPreview: preview, payment, notice }) {
  const good = b.status === 'confirmed';
  const warn = ['pending_payment', 'confirming', 'pending_supplier', 'cancelling'].includes(b.status);
  const headline = {
    confirmed: 'Your booking is confirmed',
    pending_payment: 'Your booking is awaiting payment',
    pending_supplier: 'Payment received — awaiting partner confirmation',
    cancelled: 'This booking is cancelled',
    expired: 'This booking expired before payment',
    failed: 'This booking couldn’t be confirmed',
  }[b.status] || STATUS_LABEL[b.status];
  const body = html`
<div class="container">
  <div class="confirm-hero">
    <div class="confirm-badge${good ? '' : warn ? ' is-warn' : ' is-bad'}">${icon(good ? 'check' : warn ? 'clock' : 'info')}</div>
    <h1>${headline}</h1>
    <p>Booking reference <span class="ref">${b.ref}</span></p>
    ${b.demo ? html`<p class="demo-note">${icon('info')}Demo booking — test payment, no real supplier was contacted.</p>` : ''}
  </div>
  <div class="confirm-card">
    ${notice ? html`<div class="alert alert-success mb-16" role="status">${icon('check')}<span>${notice}</span></div>` : ''}
    <div class="checkout-step">
      <h2>${b.title}</h2>
      <p class="summary-meta">${b.subtitle}<br>${b.option.name}${b.selection && b.selection.slot ? ` · ${b.selection.slot}` : ''} · ${querySummary(b.vertical, b.query)}</p>
      <p><span class="status-pill status-${b.status}">${STATUS_LABEL[b.status]}</span></p>
      ${priceLines(b.lines, b.total, b.currency)}
      ${b.payment ? html`<p class="secure-note">${icon('card')}Paid with ${b.payment.brand} •••• ${b.payment.last4}${b.payment.mode === 'test' ? ' (test mode)' : ''}</p>` : ''}
      ${b.refundAmount !== null && b.refundAmount !== undefined && (b.status === 'cancelled' || b.status === 'failed') ? html`<p class="secure-note">${icon('info')}Refund: ${money(b.refundAmount, b.currency)}</p>` : ''}
      ${b.supplierRef ? html`<p class="secure-note">${icon('check')}Partner reference ${b.supplierRef}</p>` : ''}
      <p class="policy">${icon('shield')}${b.cancellation.summary}</p>
      <p class="policy">${icon('mail')}Lead traveler: ${b.traveler.firstName} ${b.traveler.lastName} · ${b.traveler.email}</p>
    </div>
    ${payment ? html`<p class="alert alert-warning">${icon('clock')}<span>Payment is due by ${date(b.paymentDueAt, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })} (UTC). Return to checkout from the same browser to pay.</span></p>` : ''}
    ${preview && preview.allowed ? html`<form class="checkout-step" method="post" action="/booking/${b.ref}/cancel" data-cancel-form>
      <h2>Cancel this booking</h2>
      <p>${b.cancellation.type === 'non_refundable' ? 'This booking is non-refundable.' : preview.freeWindowOpen ? 'You’re inside the free cancellation window.' : 'The free cancellation window has passed.'} If you cancel now you’ll be refunded <b>${money(preview.refundAmount, preview.currency)}</b>.</p>
      <div data-form-status role="alert"></div>
      <button class="btn btn-ghost" type="submit" data-confirm="Cancel booking ${b.ref}? You’ll be refunded ${money(preview.refundAmount, preview.currency)}."><span class="btn-label">Cancel booking</span></button>
    </form>` : ''}
    <p class="center"><a class="text-link" href="/book">Book something else ${icon('arrow')}</a></p>
  </div>
</div>`;
  return layout({ title: `Booking ${b.ref}`, body, ctx, scripts: ['/js/book.js'] });
}

function manageView(ctx, { error, ref = '', email = '' } = {}) {
  const body = html`
<div class="container">
  <div class="confirm-hero"><div class="confirm-badge is-warn">${icon('search')}</div><h1>Manage your booking</h1><p>Enter your booking reference and the email you booked with.</p></div>
  <form class="form-card form confirm-card" method="post" action="/manage">
    ${error ? html`<div class="alert alert-error" role="alert">${icon('alert')}<span>${error}</span></div>` : ''}
    <div class="form-row">
      <div class="field"><label for="m-ref">Booking reference</label><input id="m-ref" name="ref" value="${ref}" required maxlength="20" autocomplete="off" placeholder="TX-XXXXXXXX"></div>
      <div class="field"><label for="m-email">Email</label><input id="m-email" name="email" type="email" value="${email}" required maxlength="120" autocomplete="email"></div>
    </div>
    <button class="btn btn-navy btn-lg" type="submit">Find booking ${icon('arrow')}</button>
  </form>
</div>`;
  return layout({ title: 'Manage booking', body, ctx });
}

module.exports = { bookView, bookIndexView, offerView, checkoutView, bookingView, manageView, resultsBlock, defaultsFor, qs };
