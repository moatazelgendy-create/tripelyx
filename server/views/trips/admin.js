// The admin control center: operations numbers, the funnel, bookings search and detail (with the
// internal economics customers never see), alerts, custom trip requests, business rules, promo codes
// and the notification outbox.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { money, dollars, longDate, shortDate, plural, statusPill, demoBadge } = require('./common');

const TABS = [['/admin', 'Overview'], ['/admin/bookings', 'Bookings'], ['/admin/requests', 'Trip requests'], ['/admin/messages', 'Messages'], ['/admin/settings', 'Business rules'], ['/admin/promos', 'Promo codes'], ['/admin/outbox', 'Outbox']];

function shell(ctx, { title, active, body, notice }) {
  const page = html`
<div class="container tb-admin">
  <header class="tb-admin-head"><div><p class="eyebrow">Admin control center</p><h1>${title}</h1></div>${demoBadge(ctx.tripService.demo, 'Demo inventory')}</header>
  <nav class="tb-admin-tabs" aria-label="Admin sections"><ul>${TABS.map(([h, l]) => html`<li><a href="${h}"${h === active ? raw(' aria-current="page"') : ''}>${l}</a></li>`)}</ul></nav>
  ${notice ? html`<div class="alert alert-success" role="status">${icon('check')}<span>${notice}</span></div>` : ''}
  ${body}
</div>`;
  return layout({ title: `${title} · Admin`, body: page, ctx, noindex: true });
}

function stat(label, value, sub) {
  return html`<li class="tb-stat"><span>${label}</span><b>${value}</b>${sub ? html`<small>${sub}</small>` : ''}</li>`;
}

function overviewView(ctx, { d, bookings }) {
  const body = html`
  <p class="tb-muted">Last ${d.days} days. Revenue is Tripelyx’s take (service fees, hotel markup, commissions); gross booking value is what customers paid. Internal numbers, never shown to customers.</p>
  <ul class="tb-stats">
    ${stat('Bookings today', d.bookingsToday)}
    ${stat('Gross booking value', money(d.gbv))}
    ${stat('Revenue', money(d.revenue))}
    ${stat('Est. gross profit', money(d.profit), 'after supplier cost and card processing')}
    ${stat('Average booking', money(d.avgBookingValue))}
    ${stat('Conversion', `${d.conversionRate}%`, 'homepage visit → booking')}
    ${stat('Average budget searched', d.avgBudget ? money(d.avgBudget) : '–')}
    ${stat('Failed bookings', d.failed)}
    ${stat('Pending / processing', d.pending)}
    ${stat('Refund requests', d.refundRequests)}
    ${stat('Flagged for margin review', d.flagged, 'below the minimum profit or margin')}
  </ul>
  ${d.alerts.length ? html`<section class="tb-panel tb-panel-warn"><h2>${icon('alert')} Needs attention</h2><ul class="tb-list">${d.alerts.map(a => html`<li><a href="/admin/bookings/${a.ref}">TRIP #${a.ref}</a>: ${a.message} <small class="tb-muted">${shortDate(a.at.slice(0, 10))}</small></li>`)}</ul></section>` : ''}
  <div class="tb-admin-two">
    <section class="tb-panel"><h2>Funnel</h2><table class="tb-table"><thead><tr><th>Stage</th><th>Visitors</th><th>From previous</th><th>Drop-off</th></tr></thead><tbody>${d.funnel.map(f => html`<tr><td>${f.label}</td><td>${f.visitors}</td><td>${f.fromPrevious === null ? '–' : `${f.fromPrevious}%`}</td><td>${f.dropOff === null ? '–' : f.dropOff}</td></tr>`)}</tbody></table></section>
    <section class="tb-panel"><h2>Popular destinations</h2>${d.popular.length ? html`<ol class="tb-list">${d.popular.map(([n, c]) => html`<li>${n} <span class="tb-muted">· ${plural(c, 'booking')}</span></li>`)}</ol>` : html`<p class="tb-muted">No paid bookings yet.</p>`}</section>
  </div>
  <section class="tb-panel"><h2>Latest bookings</h2>${bookingsTable(bookings.slice(0, 10))}<p><a href="/admin/bookings">All bookings ${icon('arrow')}</a></p></section>`;
  return shell(ctx, { title: 'Overview', active: '/admin', body });
}

function bookingsTable(list) {
  if (!list.length) return html`<p class="tb-muted">No bookings match.</p>`;
  return html`<table class="tb-table"><thead><tr><th>Trip ID</th><th>Customer</th><th>Destination</th><th>Dates</th><th>Total</th><th>Est. profit</th><th>Status</th></tr></thead><tbody>
    ${list.map(b => html`<tr><td><a href="/admin/bookings/${b.ref}">${b.ref}</a></td><td>${b.traveler.firstName} ${b.traveler.lastName}<br><small>${b.traveler.email}</small></td><td>${b.quote.trip.dest.name}</td><td>${shortDate(b.quote.trip.spec.depart)} · ${plural(b.quote.trip.spec.nights, 'night')}</td><td>${money(b.total)}</td><td>${b.quote.internal ? html`${money(b.quote.internal.grossProfit)}${b.quote.internal.review.flagged ? html` <span class="tb-status tb-status-warn">review</span>` : ''}` : '–'}</td><td>${statusPill(b.status)}</td></tr>`)}
  </tbody></table>`;
}

function bookingsView(ctx, { list, q, status, statuses }) {
  const body = html`
  <form class="tb-admin-search form" method="get" action="/admin/bookings">
    <div class="field"><label for="q">Search</label><input id="q" name="q" value="${q}" placeholder="Trip ID, customer, email or destination"></div>
    <div class="field"><label for="st">Status</label><select id="st" name="status"><option value="">Any</option>${statuses.map(s => html`<option value="${s}"${s === status ? raw(' selected') : ''}>${s}</option>`)}</select></div>
    <button class="btn btn-navy" type="submit">Search</button>
  </form>
  ${bookingsTable(list)}`;
  return shell(ctx, { title: 'Bookings', active: '/admin/bookings', body });
}

function bookingDetailView(ctx, { b, messages, notice }) {
  const t = b.quote.trip, i = b.quote.internal;
  const body = html`
  <div class="tb-admin-two">
    <section class="tb-panel">
      <h2>TRIP #${b.ref} ${statusPill(b.status)} ${b.demo ? demoBadge(true, 'Demo booking') : ''}</h2>
      <dl class="tb-dl">
        <div><dt>Customer</dt><dd>${b.traveler.firstName} ${b.traveler.lastName} · ${b.traveler.email}${b.traveler.phone ? ` · ${b.traveler.phone}` : ''}${b.userId ? ' · has account' : ' · guest'}</dd></div>
        <div><dt>Trip</dt><dd>${plural(t.spec.nights, 'night')} in ${t.dest.name} from ${t.origin.city}, ${longDate(t.spec.depart)} – ${longDate(t.flight.return)}, ${plural(t.spec.travelers, 'traveler')}</dd></div>
        <div><dt>Components</dt><dd><ul class="tb-list tb-small">${(b.components || [{ kind: 'flight', name: t.flight.airline, status: 'pending' }, { kind: 'hotel', name: t.hotel.name, status: 'pending' }]).map(c => html`<li>${c.kind}: ${c.name} · <b>${c.status}</b>${c.confirmation ? ` · ref ${c.confirmation}` : ''}${c.supplier ? html` · <span class="tb-muted">${c.supplier}</span>` : ''}</li>`)}</ul></dd></div>
        <div><dt>Payment</dt><dd>${b.payment ? `${money(b.total)} · ${b.payment.brand} •••• ${b.payment.last4} (${b.payment.mode})` : `${money(b.total)} · ${b.status === 'pending_payment' ? 'awaiting payment' : 'not paid'}`}${b.refundAmount ? ` · refunded ${money(b.refundAmount)}` : ''}</dd></div>
        <div><dt>Customer notes</dt><dd>${b.traveler.notes || '–'}</dd></div>
        <div><dt>History</dt><dd><ul class="tb-list tb-small">${b.history.map(h => html`<li>${h.at.replace('T', ' ').slice(0, 16)} · ${h.status}${h.note ? ` · ${h.note}` : ''}${h.by ? ` · by ${h.by}` : ''}</li>`)}</ul></dd></div>
      </dl>
      <form class="form tb-admin-inline" method="post" action="/admin/bookings/${b.ref}/status">
        <div class="field"><label for="ns">Set status</label><select id="ns" name="status">${['confirmed', 'partially_confirmed', 'refund_pending', 'refunded', 'cancelled', 'failed'].map(s => html`<option value="${s}"${s === b.status ? raw(' selected') : ''}>${s}</option>`)}</select></div>
        <div class="field"><label for="note">Note</label><input id="note" name="note" maxlength="300" placeholder="e.g. rebooked hotel manually, ref HT123456"></div>
        <button class="btn btn-navy btn-sm" type="submit">Update</button>
      </form>
    </section>
    <div>
      ${i ? html`<section class="tb-panel"><h2>Internal economics</h2><p class="tb-muted tb-small">Never shown to customers.</p>
        <dl class="tb-dl tb-dl-nums">
          <div><dt>Customer price</dt><dd>${money(b.total)}</dd></div>
          <div><dt>Supplier costs</dt><dd>${money(i.supplierCost)}</dd></div>
          <div><dt>Service fee</dt><dd>${money(i.serviceFee)}</dd></div>
          <div><dt>Hotel markup</dt><dd>${money(i.hotelMarkup)}</dd></div>
          <div><dt>Commissions</dt><dd>${money(i.commission)}</dd></div>
          ${i.discount ? html`<div><dt>Promo discount</dt><dd>−${money(i.discount)}</dd></div>` : ''}
          <div><dt>Card processing (est.)</dt><dd>${money(i.processingCost)}</dd></div>
          <div class="tb-dl-total"><dt>Estimated gross profit</dt><dd>${money(i.grossProfit)} <small>(${i.marginPercent}%)</small></dd></div>
        </dl>
        ${i.review.flagged ? html`<div class="alert alert-warning">${icon('alert')}<span><b>Flagged for review:</b> ${i.review.reasons.join('; ')}. The customer price was not changed.</span></div>` : html`<p class="tb-small tb-muted">Meets the minimum profit and margin rules.</p>`}
      </section>` : ''}
      <section class="tb-panel"><h2>Messages</h2>
        <ul class="tb-messages">${messages.length ? messages.map(m => html`<li class="${m.from === 'customer' ? 'is-customer' : 'is-staff'}"><b>${m.from === 'customer' ? `${b.traveler.firstName}` : m.name || 'Staff'}</b> <small>${m.at.replace('T', ' ').slice(0, 16)}</small><p>${m.text}</p></li>`) : html`<li class="tb-muted">No messages.</li>`}</ul>
        <form class="form" method="post" action="/admin/bookings/${b.ref}/message"><div class="field"><label for="reply">Reply to the customer</label><textarea id="reply" name="text" maxlength="2000" required></textarea></div><button class="btn btn-navy btn-sm" type="submit">Send</button></form>
      </section>
    </div>
  </div>`;
  return shell(ctx, { title: `Booking ${b.ref}`, active: '/admin/bookings', body, notice });
}

function requestsView(ctx, { requests, notice }) {
  const body = requests.length ? html`<table class="tb-table"><thead><tr><th>Received</th><th>Customer</th><th>Budget</th><th>From</th><th>Travelers</th><th>Dates</th><th>Wants</th><th>Status</th></tr></thead><tbody>
    ${requests.map(r => html`<tr><td>${shortDate(r.at.slice(0, 10))}</td><td>${r.name}<br><small>${r.email}</small></td><td>${r.budget ? `$${r.budget}` : '–'}</td><td>${r.from || '–'}</td><td>${r.travelers || '–'}</td><td>${r.dates || '–'}</td><td class="tb-wrap">${r.wants}</td><td><form method="post" action="/admin/requests/${r.id}/status"><select name="status" aria-label="Status">${['received', 'building', 'ready', 'awaiting_approval', 'booked', 'closed'].map(s => html`<option value="${s}"${s === r.status ? raw(' selected') : ''}>${s.replace('_', ' ')}</option>`)}</select> <button class="btn btn-ghost btn-sm" type="submit">Save</button></form></td></tr>`)}
  </tbody></table>` : html`<p class="tb-muted">No custom trip requests yet.</p>`;
  return shell(ctx, { title: 'Custom trip requests', active: '/admin/requests', body, notice });
}

// Contact support and business messages, newest first. Older partner leads have no kind or trip.
function messagesView(ctx, { messages }) {
  const at = m => (m.createdAt || '').replace('T', ' ').slice(0, 16);
  const body = messages.length ? html`<table class="tb-table"><thead><tr><th>Received</th><th>From</th><th>About</th><th>Message</th></tr></thead><tbody>
    ${messages.map(m => html`<tr><td>${at(m)}</td><td>${m.name}<br><small><a href="mailto:${m.email}">${m.email}</a></small>${m.company ? html`<br><small>${m.company}</small>` : ''}</td><td>${m.kind === 'partner' ? 'Business' : m.kind === 'support' ? 'Support' : 'Partner form'}${m.type ? html`<br><small>${m.type}</small>` : ''}${m.trip ? html`<br><small><a href="/trip/${m.trip}">Open the trip</a></small>` : ''}</td><td class="tb-wrap">${m.message}</td></tr>`)}
  </tbody></table>` : html`<p class="tb-muted">No messages yet.</p>`;
  return shell(ctx, { title: 'Messages', active: '/admin/messages', body });
}

function settingsView(ctx, { settings: s, destinations, notice, error }) {
  const body = html`
  ${error ? html`<div class="alert alert-error" role="alert">${icon('alert')}<span>${error}</span></div>` : ''}
  <form class="form tb-panel" method="post" action="/admin/settings">
    <h2>Pricing and margin rules</h2>
    <p class="tb-muted">These shape the customer price (service fee, markup) and decide when a booking is flagged for review. A trip that misses the minimums is never silently repriced; it is flagged here.</p>
    <div class="form-row">
      <div class="field"><label for="sf">Service fee per traveler ($)</label><input id="sf" name="serviceFeePerTraveler" inputmode="decimal" value="${(s.serviceFeePerTraveler / 100).toFixed(2)}"></div>
      <div class="field"><label for="msf">Maximum service fee per booking ($)</label><input id="msf" name="maxServiceFee" inputmode="decimal" value="${(s.maxServiceFee / 100).toFixed(2)}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="hm">Hotel markup (%)</label><input id="hm" name="hotelMarkupPercent" inputmode="decimal" value="${s.hotelMarkupPercent}"><p class="field-hint">Applied to net hotel rates where package rates allow it.</p></div>
      <div class="field"><label for="mp">Minimum profit per booking ($)</label><input id="mp" name="minProfit" inputmode="decimal" value="${(s.minProfit / 100).toFixed(2)}"></div>
      <div class="field"><label for="mm">Minimum margin (%)</label><input id="mm" name="minMarginPercent" inputmode="decimal" value="${s.minMarginPercent}"></div>
    </div>
    <h2>Destinations</h2>
    <p class="tb-muted">Untick a destination to stop recommending it (existing bookings are unaffected).</p>
    <ul class="tb-check-grid">${destinations.map(d => html`<li><label><input type="checkbox" name="enabled" value="${d.id}"${(s.disabledDestinations || []).includes(d.id) ? '' : raw(' checked')}> ${d.name}, ${d.country}</label></li>`)}</ul>
    <button class="btn btn-navy" type="submit">Save rules</button>
  </form>`;
  return shell(ctx, { title: 'Business rules', active: '/admin/settings', body, notice });
}

function promosView(ctx, { promos, notice, error }) {
  const body = html`
  ${error ? html`<div class="alert alert-error" role="alert">${icon('alert')}<span>${error}</span></div>` : ''}
  <div class="tb-admin-two">
    <section class="tb-panel"><h2>Active codes</h2>${promos.length ? html`<table class="tb-table"><thead><tr><th>Code</th><th>Discount</th><th>Min. total</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>${promos.map(p => html`<tr><td><b>${p.code}</b></td><td>${p.type === 'percent' ? `${p.value}%` : money(p.value)}</td><td>${p.minTotal ? money(p.minTotal) : '–'}</td><td>${p.expiresAt || '–'}</td><td>${p.active ? 'active' : 'off'}</td><td><form method="post" action="/admin/promos/${p.code}/toggle"><button class="btn btn-ghost btn-sm" type="submit">${p.active ? 'Deactivate' : 'Activate'}</button></form></td></tr>`)}</tbody></table>` : html`<p class="tb-muted">No promo codes yet.</p>`}</section>
    <form class="form tb-panel" method="post" action="/admin/promos">
      <h2>New promo code</h2>
      <div class="field"><label for="pc">Code</label><input id="pc" name="code" required maxlength="30" placeholder="WELCOME25"></div>
      <div class="form-row">
        <div class="field"><label for="pt">Type</label><select id="pt" name="type"><option value="amount">Fixed amount ($)</option><option value="percent">Percent (%)</option></select></div>
        <div class="field"><label for="pv">Value</label><input id="pv" name="value" inputmode="decimal" required></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="pm">Minimum trip total ($)</label><input id="pm" name="minTotal" inputmode="decimal" value="0"></div>
        <div class="field"><label for="pe">Expires (YYYY-MM-DD)</label><input id="pe" name="expiresAt" placeholder="optional"></div>
      </div>
      <p class="tb-muted tb-small">A discount shows as its own line on the customer’s price; original prices are never inflated to fake a saving.</p>
      <button class="btn btn-navy" type="submit">Create</button>
    </form>
  </div>`;
  return shell(ctx, { title: 'Promo codes', active: '/admin/promos', body, notice });
}

function outboxView(ctx, { messages }) {
  const body = html`<p class="tb-muted">Messages the platform would have sent. Until an email/SMS provider is connected (NOTIFY_PROVIDER), they are recorded here and marked not sent.</p>
  ${messages.length ? html`<table class="tb-table"><thead><tr><th>When</th><th>To</th><th>Audience</th><th>Subject</th><th>Body</th><th>Status</th></tr></thead><tbody>${messages.map(m => html`<tr><td>${m.createdAt.replace('T', ' ').slice(0, 16)}</td><td>${m.to}</td><td>${m.audience}</td><td>${m.subject}</td><td class="tb-wrap">${m.body}</td><td>${m.status}</td></tr>`)}</tbody></table>` : html`<p class="tb-muted">Empty.</p>`}`;
  return shell(ctx, { title: 'Notification outbox', active: '/admin/outbox', body });
}

module.exports = { overviewView, bookingsView, bookingDetailView, requestsView, messagesView, settingsView, promosView, outboxView };
