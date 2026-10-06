// Your trip, step by step: a walk through the trip in order for first trips and nervous flyers. Every
// line comes from this trip's booking facts or is marked as general guidance; where only the
// itinerary, voucher or boarding pass can answer, it says "Check required". Nothing here sells anything.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { contextParams } = require('../../trips/optimizer');
const { tripGuide } = require('../../trips/decision');
const { plural, longDate, demoBadge } = require('./common');

const STATUS = {
  ready: { label: 'We know this', tone: 'good', cls: 'ok', icon: 'check' },
  check: { label: 'Check required', tone: 'warn', cls: 'verify', icon: 'alert' },
  info: { label: 'General guidance', tone: 'info', cls: 'heads-up', icon: 'info' },
};

function pill(status) {
  const st = STATUS[status];
  return html`<span class="tb-status tb-status-${st.tone}">${st.label}</span>`;
}

function guideView(ctx, { data, cx }) {
  const { trip: t, token, origin } = data;
  const s = t.spec;
  const { steps, counts } = tripGuide(t, { origin });
  const tripUrl = `/trip/${token}?${contextParams(cx)}`;
  const body = html`
<div class="container tb-results tb-guide-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / ${cx.searchParams ? html`<a href="/trips?${cx.searchParams}">Your trips</a> / ` : ''}<a href="${tripUrl}">${t.dest.name}</a> / <span aria-current="page">Step by step</span></nav>
  <header class="tb-results-head"><div>
    <p class="eyebrow">Your trip, step by step</p>
    <h1>${t.dest.name}, ${plural(s.nights, 'night')} from ${longDate(s.depart)}: what happens, in order.</h1>
    <p class="tb-results-sub">For first trips and nervous flyers. Everything below comes from this trip’s booking facts or is marked as general guidance. Where only your itinerary, voucher or boarding pass can tell you, it says “Check required”. Nothing here is a sales pitch, and nothing here is a promise about the day itself: airlines, airports and hotels change things, and your boarding pass always wins. ${demoBadge(ctx.tripService.demo, 'Demo inventory and schedule')}</p>
    <ul class="tb-guide-counts" aria-label="What we know">
      <li class="is-ready">${icon('check')} ${plural(counts.ready, 'thing')} we know from your booking</li>
      <li class="is-check">${icon('alert')} ${counts.check} to confirm on your documents</li>
      <li class="is-info">${icon('info')} ${plural(counts.info, 'piece')} of general guidance</li>
    </ul>
  </div></header>
  <ol class="tb-guide">${steps.map((st, i) => html`<li class="tb-guide-step" id="step-${st.key}">
    <div class="tb-guide-head"><span class="tb-guide-num" aria-hidden="true">${i + 1}</span><h2>${st.title}</h2>${pill(st.status)}</div>
    <ul class="tb-reality">${st.lines.map(l => html`<li class="is-${STATUS[l.status].cls}">${icon(STATUS[l.status].icon)}<div><span class="tb-reality-status">${STATUS[l.status].label}</span><p>${l.text}</p></div></li>`)}</ul>
  </li>`)}</ol>
  <section class="tb-panel" aria-labelledby="guide-next-title">
    <h2 id="guide-next-title">${icon('compass')} Still unsure about something?</h2>
    <p class="tb-muted">A person can answer what a page can’t. Asking changes nothing about your trip or its price.</p>
    <div class="tb-price-actions">
      <a class="btn btn-navy" href="${tripUrl}">Back to my trip ${icon('arrow')}</a>
      <a class="btn btn-ghost" href="/custom-trip?budget=${cx.budget ? Math.round(cx.budget / 100) : ''}&from=${origin ? encodeURIComponent(origin.city) : ''}&travelers=${s.travelers}&dest=${encodeURIComponent(t.dest.name)}">Ask a trip specialist</a>
    </div>
  </section>
</div>`;
  return layout({ title: `Step by step · ${t.dest.name}`, active: 'plan', body, ctx, noindex: true });
}

module.exports = { guideView };
