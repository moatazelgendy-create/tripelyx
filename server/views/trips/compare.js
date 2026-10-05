// Side by side: two or three trips, or a trip before and after an optimization. Only the rows that
// differ are shown by default, each column carries its verdict, and the traveler picks.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { contextParams } = require('../../trips/optimizer');
const { tripDiff, verdict } = require('../../trips/decision');
const { money, dollars, longDate, plural, demoBadge, fitBadge } = require('./common');

const LOCK_LABEL = { hotel: 'the hotel', flight: 'the flights', dates: 'the dates' };

function compareView(ctx, { items, cx, mode = 'compare', all = false, locks = {}, capMode = 'same', cap = null }) {
  const first = items[0];
  const cols = items.map((it, i) => ({ ...it, v: verdict(it.trip, cx, it.scores), diff: tripDiff(first.trip, it.trip, { date: longDate }) }));
  const rows = cols[0].diff.map((r, idx) => {
    const values = cols.map(c => (c === cols[0] ? c.diff[idx].a : c.diff[idx].b));
    return { key: r.key, label: r.label, values, changed: values.some(v => v !== values[0]) };
  });
  const shown = rows.filter(r => all || r.changed || r.key === 'total');
  const budget = cx.budget;
  const optimize = mode === 'optimize';
  const proposal = optimize ? cols[1] : null;
  const locked = Object.keys(locks).filter(k => locks[k]).map(k => LOCK_LABEL[k]);
  const tripUrl = (c, extra) => `/trip/${c.token}?${contextParams(cx, extra)}`;
  const head = optimize
    ? (proposal
      ? html`<p class="eyebrow">Before and after</p><h1>${proposal.delta <= 0 ? `A better ${first.trip.dest.name} trip for ${proposal.delta === 0 ? 'the same money' : `${money(-proposal.delta)} less`}.` : `A better ${first.trip.dest.name} trip for ${money(proposal.delta)} more, still within your ${dollars(cap)}.`}</h1>
          <p class="tb-results-sub">We re-planned everything${locked.length ? ` except ${locked.join(' and ')}` : ''} and priced every combination in full. The match score went from ${first.scores.match}% to ${proposal.scores.match}%. Nothing changes unless you choose it. ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p>`
      : html`<p class="eyebrow">Honest answer</p><h1>This is already the best version of this trip ${capMode === 'budget' && cap ? `within your ${dollars(cap)}` : 'at this price'}.</h1>
          <p class="tb-results-sub">We priced every other combination${locked.length ? ` that keeps ${locked.join(' and ')}` : ''} and none scored higher for what you told us${capMode === 'same' ? ' without costing more' : ''}. ${capMode === 'same' && budget && budget > first.trip.total ? html`You still have ${money(budget - first.trip.total)} of budget: <a href="/trip/${first.token}/optimize?${contextParams(cx, { cap: 'budget', lk: Object.keys(locks).filter(k => locks[k]).map(k => k[0]).join('') })}">see what spending some of it would improve</a>, or keep it.` : locked.length ? html`<a href="/trip/${first.token}/optimize?${contextParams(cx, { cap: capMode })}">Unlock everything</a> to see more options.` : ''}</p>`)
    : html`<p class="eyebrow">Side by side</p><h1>Compare your ${plural(items.length, 'trip')}.</h1>
        <p class="tb-results-sub">Only what differs is shown${all ? '' : html` (<a href="/compare?${new URLSearchParams([...items.map(it => ['t', it.token]), ...items.map(it => ['l', it.label || '']), ...new URLSearchParams(contextParams(cx)), ['all', '1']]).toString()}">show every row</a>)`}. Every total includes taxes, mandatory fees and our service fee. ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p>`;
  const body = html`
<div class="container tb-results tb-compare-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / ${cx.searchParams ? html`<a href="/trips?${cx.searchParams}">Your trips</a> / ` : ''}<a href="${tripUrl(first)}">${first.trip.dest.name}</a> / <span aria-current="page">${optimize ? 'Before and after' : 'Compare'}</span></nav>
  <header class="tb-results-head"><div>${head}</div></header>
  ${proposal && proposal.gains && proposal.gains.length ? html`<section class="tb-panel"><h2>${icon('sparkle')} What improves</h2><ul class="tb-list">${proposal.gains.map(g => html`<li><b>${g.label}:</b> ${g.b}</li>`)}</ul></section>` : ''}
  <div class="tb-compare-wrap">
    <table class="tb-compare">
      <thead><tr><th scope="col"><span class="sr-only">Field</span></th>${cols.map((c, i) => html`<th scope="col"><small>${c.label || `Trip ${i + 1}`}</small><b>${c.trip.dest.name}</b><small>${plural(c.trip.spec.nights, 'night')} · ${plural(c.trip.spec.travelers, 'traveler')}</small>${fitBadge(c.v, { compact: true })}</th>`)}</tr></thead>
      <tbody>
        ${shown.map(r => html`<tr class="${r.changed ? '' : 'is-same'}"><th scope="row">${r.label}</th>${r.values.map((v, i) => html`<td class="${r.key === 'total' ? 'tb-compare-total' : ''}">${v}${r.key === 'total' && budget ? html`<small class="tb-compare-vs ${cols[i].trip.total > budget ? 'is-over' : ''}">${cols[i].trip.total > budget ? `${money(cols[i].trip.total - budget)} over your budget` : `${money(budget - cols[i].trip.total)} under your budget`}</small>` : ''}</td>`)}</tr>`)}
        <tr><th scope="row">Our verdict</th>${cols.map(c => html`<td>${fitBadge(c.v, { compact: true })} ${c.v.action}</td>`)}</tr>
      </tbody>
      <tfoot><tr><td></td>${cols.map((c, i) => html`<td>${optimize
        ? (i === 0 ? html`<a class="btn btn-ghost" href="${tripUrl(c)}">Keep my original</a>` : html`<a class="btn btn-navy" href="${tripUrl(c)}#customize">Use this version ${icon('arrow')}</a>`)
        : html`<a class="btn btn-navy" href="${tripUrl(c)}">Choose this trip ${icon('arrow')}</a>`}</td>`)}</tr></tfoot>
    </table>
  </div>
  <p class="tb-muted tb-small">${optimize ? 'Locked parts never change without you. ' : ''}Prices are live and rechecked before you pay; nothing is charged until you confirm.</p>
</div>`;
  return layout({ title: optimize ? 'Before and after' : 'Compare trips', active: 'plan', body, ctx, scripts: ['/js/trips.js'], noindex: true });
}

module.exports = { compareView };
