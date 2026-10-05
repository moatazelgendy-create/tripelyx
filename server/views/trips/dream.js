// Journey B: "I want to go to Italy. I only have $3,000. Make it work." The Budget Negotiator's first
// version: the best version of the trip under budget, the dream version, the gap, and the single
// changes (with their real savings) that close it. The traveler approves every change.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { encodeSpec } = require('../../trips/spec');
const { contextParams, tradeoffs } = require('../../trips/optimizer');
const { money, dollars, plural, longDate, hm, demoBadge, budgetMeter } = require('./common');
const { tripCard } = require('./plan');
const { singleChanges, changeList } = require('./trip');

function diffLine(label, a, b) {
  return html`<li><span>${label}</span><b>${a}</b><span class="tb-arrow" aria-hidden="true">→</span><b class="${a === b ? 'tb-muted' : ''}">${a === b ? 'unchanged' : b}</b></li>`;
}

function dreamView(ctx, { dest, q, originCity, best, under, gap, closers, cx, user, beat = false }) {
  const budget = q.budget;
  const dreamT = best && best.trip;
  const underT = under && under.trip;
  const dreamToken = dreamT ? encodeSpec(dreamT.spec) : null;
  const body = html`
<div class="container tb-dream-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span aria-current="page">Make it work</span></nav>
  <header class="tb-results-head">
    <div>
      <p class="eyebrow">${beat ? 'Beat my quote' : q.dateMode === 'exact' ? 'I have to be there' : 'Budget Negotiator'}</p>
      <h1>${beat ? `You found ${dest.name} for ${dollars(budget)}. ${underT ? (budget - underT.total >= 2500 ? 'We can beat it.' : 'We can match it.') : 'Honestly, we can’t beat it.'}` : `${dest.name} for ${dollars(budget)}${gap > 0 ? ': let’s close the gap.' : ': it works.'}`}</h1>
      <p class="tb-results-sub">From ${originCity} · ${plural(q.travelers, 'traveler')} · ${plural(q.nights, 'night')} · ${q.dateMode === 'exact' ? `fixed dates, ${longDate(q.depart)}` : q.dateMode === 'flexible' ? 'flexible dates' : 'any dates'}. ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p>
      ${beat ? html`<p class="tb-results-sub">${underT ? html`Our best complete ${dest.name} trip under your price is <b>${money(underT.total)}</b>, ${money(budget - underT.total)} less, with flights, hotel, taxes, mandatory fees and our service fee all in.` : dreamT ? html`Our closest complete trip is <b>${money(dreamT.total)}</b>, ${money(dreamT.total - budget)} more than your quote. If your quote really includes taxes, fees and bags for ${plural(q.travelers, 'traveler')}, it is a good deal: keep it.` : ''} Compare like with like: our price always includes taxes, mandatory fees, bags as listed and our service fee.</p>` : ''}
    </div>
    <ul class="tb-answers"><li><span>Dream trip</span><b>${dest.name}</b><a href="/dream?${new URLSearchParams({ b: q.budgetInput, from: q.origin, who: q.who, n: q.travelers, nights: q.nights }).toString()}" aria-label="Change destination">change</a></li><li><span>Maximum</span><b>${dollars(budget)}</b><a href="/dream?${new URLSearchParams({ dest: dest.id, from: q.origin, who: q.who, n: q.travelers, nights: q.nights }).toString()}" aria-label="Change budget">change</a></li><li><span>Travelers</span><b>${q.travelers}</b><a href="/dream?${new URLSearchParams({ dest: dest.id, b: q.budgetInput, from: q.origin, nights: q.nights }).toString()}">change</a></li><li><span>Nights</span><b>${q.nights}</b><a href="/dream?${new URLSearchParams({ dest: dest.id, b: q.budgetInput, from: q.origin, who: q.who, n: q.travelers }).toString()}">change</a></li></ul>
  </header>

  ${!dreamT ? html`<div class="tb-advisor"><h2>We can’t build ${dest.name} from ${originCity} right now.</h2><p>No flights are on sale for this route in our inventory. <a href="/plan?b=${q.budgetInput}">See where ${dollars(budget)} can take you instead</a> or <a href="/custom-trip?dest=${encodeURIComponent(dest.name)}&budget=${q.budgetInput}">ask a trip specialist</a>.</p></div>` : html`
  <section class="tb-gap" aria-labelledby="gap-title">
    <div class="tb-gap-nums">
      <div><span>Your maximum</span><b>${money(budget)}</b></div>
      <div><span>${gap > 0 ? 'Closest strong option' : 'Best trip under your budget'}</span><b>${money((gap > 0 ? dreamT : underT).total)}</b></div>
      <div class="${gap > 0 ? 'is-over' : ''}"><span>${gap > 0 ? 'You’re only' : 'You keep'}</span><b>${money(Math.abs(gap > 0 ? gap : budget - underT.total))}${gap > 0 ? ' away' : ''}</b></div>
    </div>
    ${budgetMeter((gap > 0 ? dreamT : underT).total, budget, { compact: true })}
    ${gap > 0 ? html`<h2 id="gap-title">${beat ? `A stronger version costs ${money(dreamT.total)}, ${money(gap)} over your quote. Here’s what would close that gap.` : `We need to save ${money(gap)}. Here’s what would do it.`}</h2>
      <p class="tb-muted">Each line is a real re-priced version of the trip. Pick the compromises you’re willing to make; we never change anything without you.</p>
      ${changeList(closers, { empty: 'No single change closes the gap; try the trip under budget below, or combine changes on the trip page.' })}
      <p class="tb-muted">Or <a href="/trip/${dreamToken}?${contextParams(cx)}#customize">open the customizer</a> to combine several changes, or <a href="/trip/${dreamToken}?${contextParams(cx)}&review=1">keep the dream version at ${money(dreamT.total)}</a>.</p>` : html`<h2 id="gap-title">${dest.name} fits your budget.</h2>`}
  </section>

  ${underT && gap > 0 ? html`<section class="tb-panel" aria-labelledby="dvr-title">
    <h2 id="dvr-title">Dream vs reality</h2>
    <div class="tb-dvr">
      <div><p class="tb-kicker">Your dream version</p><b>${money(dreamT.total)}</b><small>${dreamT.hotel.stars}-star · ${plural(dreamT.spec.nights, 'night')} · ${dreamT.flight.stops ? '1 stop' : 'nonstop'}</small></div>
      <div><p class="tb-kicker">Your budget</p><b>${money(budget)}</b></div>
      <div><p class="tb-kicker">Best version under budget</p><b>${money(underT.total)}</b><small>${underT.hotel.stars}-star · ${plural(underT.spec.nights, 'night')} · ${underT.flight.stops ? '1 stop' : 'nonstop'}</small></div>
    </div>
    <p class="tb-muted">What changed:</p>
    <ul class="tb-diff">
      ${diffLine('Hotel', `${dreamT.hotel.stars}-star ${dreamT.hotel.name}`, `${underT.hotel.stars}-star ${underT.hotel.name}`)}
      ${diffLine('Trip', plural(dreamT.spec.nights, 'night'), plural(underT.spec.nights, 'night'))}
      ${diffLine('Flight', `${dreamT.flight.stops ? '1 stop' : 'Nonstop'}, ${dreamT.flight.name}`, `${underT.flight.stops ? '1 stop' : 'Nonstop'}, ${underT.flight.name}`)}
      ${diffLine('Dates', longDate(dreamT.spec.depart), longDate(underT.spec.depart))}
      ${diffLine('Experiences', plural(dreamT.activities.length, 'experience'), plural(underT.activities.length, 'experience'))}
      ${diffLine('Destination', dest.name, dest.name)}
    </ul>
    <p class="tb-muted">You decide whether the compromises are acceptable.</p>
  </section>` : ''}

  <div class="tb-cards tb-cards-2">
    ${underT ? tripCard({ ...under, label: gap > 0 ? 'Best version under budget' : 'Best Match', why: under.why }, q, cx, { rank: 0 }) : ''}
    ${gap > 0 ? tripCard({ ...best, label: 'Your dream version', why: best.why }, q, cx, { over: true, rank: 1 }) : (best && underT && best.trip !== underT ? tripCard({ ...best, label: 'Best Match', why: best.why }, q, cx, { rank: 1 }) : '')}
  </div>

  <section class="tb-more" aria-label="Other options">
    <h2>Rather wait than compromise?</h2>
    <ul class="tb-advisor-links">
      ${user && dreamToken ? html`<li><form method="post" action="/trip/${dreamToken}/save?${contextParams(cx)}&back=dream"><button class="btn btn-ghost btn-sm" type="submit" name="kind" value="watch">${icon('eye')} Watch ${dest.name} for under ${dollars(budget)}</button></form></li>` : html`<li><a class="btn btn-ghost btn-sm" href="/signin?next=${encodeURIComponent(`/dream?${new URLSearchParams({ dest: dest.id, b: q.budgetInput, from: q.origin, who: q.who, n: q.travelers, nights: q.nights }).toString()}`)}">${icon('eye')} Sign in to watch this destination</a></li>`}
      <li><a class="btn btn-ghost btn-sm" href="/plan?b=${q.budgetInput}&from=${q.origin}&who=${q.who}&n=${q.travelers}&nights=${q.nights}">See where ${dollars(budget)} can take you</a></li>
      <li><a class="btn btn-ghost btn-sm" href="/custom-trip?dest=${encodeURIComponent(dest.name)}&budget=${q.budgetInput}&from=${encodeURIComponent(originCity)}&travelers=${q.travelers}">Ask a trip specialist</a></li>
    </ul>
  </section>`}
</div>`;
  return layout({ title: `${dest.name} for ${dollars(budget)}`, active: 'plan', body, ctx, scripts: ['/js/trips.js'], noindex: true });
}

module.exports = { dreamView };
