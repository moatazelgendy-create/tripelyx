// The homepage: one product, the AI travel agent, and one question above the fold: how much do you
// want to spend? Below it, in this order: the two ways to start (help me figure it out, or search for
// what I already know), how the agent works, one labelled example, what we promise, and the same
// question once more at the end. Nothing here is a timed animation or a claim the engine can't back.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { productStates, productItem } = require('../components');
const { addDays, today } = require('../../lib/dates');
const { money, dollars, demoBadge, plural } = require('./common');
const { EXAMPLES } = require('./agent');

// WHAT MATTERS MOST? One agent, four ways to optimize, each a submit of the number with its mode:
// SAVE THE MOST (Save Max), BEST VALUE (the mission as it is: routes/agent.js reads no mode from it),
// MAKE IT EASY (Comfort Max) and MAKE IT MEMORABLE (Experience Max).
const ENTRY_MODES = [['save', 'SAVE THE MOST', 'wallet'], ['value', 'BEST VALUE', 'check'], ['easy', 'MAKE IT EASY', 'plane'], ['experience', 'MAKE IT MEMORABLE', 'sparkle']];

function budgetForm({ id = 'home', value = '', cta = 'Build my best trip', surprise = true, autofocus = false } = {}) {
  return html`<form class="tb-budget-form" action="/plan" method="get" data-budget-form>
    <label class="tb-budget-label" for="${id}-budget">How much do you want to spend?</label>
    <div class="tb-budget-input">
      <span class="tb-currency" aria-hidden="true">$</span>
      <input id="${id}-budget" name="b" type="text" inputmode="numeric" pattern="[0-9,]*" placeholder="1,500" value="${value}" required autocomplete="off" ${autofocus ? raw('autofocus') : ''} aria-describedby="${id}-budget-hint">
      <button class="btn btn-blue btn-lg" type="submit">${cta} ${icon('arrow')}</button>
    </div>
    <p class="tb-budget-hint" id="${id}-budget-hint">Flights, hotel and experiences in one price. We don’t try to spend your budget. We try to beat it.</p>
    ${surprise ? html`<p class="tb-surprise"><a href="/plan?style=surprise&prio=price" class="text-link">${icon('sparkle')} I don’t know where to go — surprise me</a></p>` : ''}
  </form>`;
}

// The budget box that starts the agent: the hero's and the closing section's. `id` keeps labels unique.
function agentBudget(id, { cta = 'Show me what my money can do' } = {}) {
  return html`<form class="ag-hero-form ag-hero-number" method="post" action="/agent">
      <label class="sr-only" for="${id}-budget">The most you want to spend, in dollars</label>
      <div class="tb-budget-input">
        <span class="tb-currency" aria-hidden="true">$</span>
        <input id="${id}-budget" name="budget" type="text" inputmode="numeric" pattern="[0-9,]*" placeholder="1,500" required autocomplete="off" aria-describedby="${id}-budget-hint">
        <button class="btn btn-blue btn-lg" type="submit">${cta} ${icon('arrow')}</button>
      </div>
      <p class="tb-budget-hint" id="${id}-budget-hint"><b>No destination required.</b> Your number is a ceiling, not a target: every total includes taxes and fees, and nothing is booked until you confirm.</p>
    </form>`;
}

// P36: one example, labelled as one. Every number on it is the engine's own (the route prices it);
// with no trip under the example's budget there is no example, never a made-up one.
function oneExample(ctx, ex) {
  const p = ex && ex.picks && ex.picks[0];
  if (!p) return '';
  const t = p.trip, budget = ex.query.budget;
  const flight = `${t.flight.stops ? `${plural(t.flight.stops, 'stop')}` : 'nonstop'} flights from ${ex.originCity}`;
  const hotel = `a ${t.hotel.stars}-star${t.hotel.features.beachfront ? ' beachfront' : ''} hotel`;
  const extras = [t.activities.length ? plural(t.activities.length, 'experience') : '', t.transfer ? 'airport transfers' : ''].filter(Boolean);
  return html`<section class="tb-section" aria-labelledby="tb-example-title">
  <div class="container">
    <div class="section-head">
      <div><p class="eyebrow">Example</p><h2 id="tb-example-title" class="section-title">What one number builds</h2></div>
      ${ctx.tripService.demo ? demoBadge(true, 'Example · demo inventory') : ''}
    </div>
    <div class="tb-one-example">
      <dl class="tb-one-rows">
        <div><dt>You give us</dt><dd>${dollars(budget)}</dd></div>
        <div class="tb-one-builds"><dt>Tripelyx builds</dt><dd>${plural(t.spec.nights, 'night')} in ${t.dest.name} for ${t.spec.travelers}: ${flight}, ${hotel}${extras.length ? `, ${extras.join(' and ')}` : ''}, with every tax and mandatory fee in the price</dd></div>
        <div><dt>Total</dt><dd>${money(t.total)}</dd></div>
        <div class="tb-one-keep"><dt>You keep</dt><dd>${money(budget - t.total)}</dd></div>
      </dl>
      <p class="tb-one-actions"><a class="btn btn-navy btn-lg" href="/agent">Build my trip ${icon('arrow')}</a> <a class="text-link" href="/trips?${ex.params}">See this example in full ${icon('arrow')}</a></p>
    </div>
  </div>
</section>`;
}

function homeView(ctx, { example, dreamDestinations, origins, user, recent }) {
  const company = ctx.company || ctx.config.company;
  const products = productStates(ctx);
  const body = html`
<section class="tb-hero ag-hero" aria-labelledby="tb-hero-title">
  <div class="tb-hero-media" role="img" aria-label="A bright coastline with turquoise water and white sand"></div>
  <div class="container tb-hero-inner">
    <p class="eyebrow eyebrow-light">${company.brandName} · AI travel agent</p>
    <h1 id="tb-hero-title" class="tb-hero-title">How much do you want to spend?</h1>
    <p class="tb-hero-lead">${company.promise}</p>
    ${agentBudget('hero')}
    <div class="tb-hero-alt">
      <p>Already know where you’re going? <a class="btn btn-ghost-light btn-sm" href="#search">Search travel</a></p>
      <a class="btn btn-ghost-light btn-sm" href="/challenge">I found a trip — beat it</a>
    </div>
  </div>
</section>

${recent ? html`<section class="tb-section tb-section-tight" aria-label="Your unfinished trip">
  <div class="container"><div class="tb-return">
    <img src="${recent.trip.dest.image.url}" alt="" width="160" height="100">
    <div><p class="tb-kicker">Still thinking about ${recent.trip.dest.name}?</p><p>${plural(recent.trip.spec.nights, 'night')} for ${recent.trip.spec.travelers}, now <b>${money(recent.trip.total)}</b>. Prices were refreshed just now.</p></div>
    <a class="btn btn-navy" href="/trip/${recent.token}?${recent.budget ? `b=${Math.round(recent.budget / 100)}` : ''}">Continue my trip ${icon('arrow')}</a>
  </div></div>
</section>` : ''}

<section class="tb-section tb-section-soft" aria-labelledby="tb-paths-title" id="start">
  <div class="container">
    <p class="eyebrow eyebrow-center">Two ways to start</p>
    <h2 id="tb-paths-title" class="section-title section-title-center">${company.line}</h2>
    <div class="tb-paths">
      <div class="tb-path" id="figure-it-out">
        <p class="tb-kicker">Help me figure it out</p>
        <h3>Give the agent your budget and what matters most.</h3>
        <form method="post" action="/agent" class="form">
          <div class="field"><label for="path-budget">Your maximum</label><div class="tb-budget-input tb-budget-input-sm"><span class="tb-currency" aria-hidden="true">$</span><input id="path-budget" name="budget" type="text" inputmode="numeric" pattern="[0-9,]*" placeholder="1,500" required autocomplete="off"></div></div>
          <fieldset class="tb-modes"><legend>What matters most?</legend>
            <div class="tb-modes-grid">${ENTRY_MODES.map(([value, label, ic]) => html`<button class="btn btn-white tb-mode" type="submit" name="mode" value="${value}">${icon(ic)} ${label}</button>`)}</div>
          </fieldset>
        </form>
        <details class="tb-say">
          <summary>Or say it in your own words</summary>
          <form method="post" action="/agent" class="form">
            <label class="sr-only" for="path-say">Tell your travel agent what you want</label>
            <textarea id="path-say" name="say" rows="3" maxlength="600" placeholder="I have $2,000 for two of us from Chicago, five nights, somewhere warm…"></textarea>
            <button class="btn btn-navy" type="submit">Build my trip ${icon('arrow')}</button>
            <div class="ag-chips">${EXAMPLES.map(e => html`<button class="ag-chip" type="submit" name="example" value="${e}">${e}</button>`)}</div>
          </form>
        </details>
        <p class="tb-small tb-muted">Not in a hurry? <a href="/hunts/new">I can wait: let the AI hunt for it</a>.</p>
      </div>
      <div class="tb-path" id="search">
        <p class="tb-kicker">I know what I need</p>
        <h3>Search travel.</h3>
        <form class="form" action="/dream" method="get">
          <div class="field"><label for="dream-dest">Destination</label><select id="dream-dest" name="dest" required>${dreamDestinations.map(d => html`<option value="${d.id}">${d.name}, ${d.country}</option>`)}</select></div>
          <div class="form-row">
            <div class="field"><label for="dream-b">My maximum</label><div class="tb-budget-input tb-budget-input-sm"><span class="tb-currency" aria-hidden="true">$</span><input id="dream-b" name="b" type="text" inputmode="numeric" pattern="[0-9,]*" placeholder="3,000" required autocomplete="off"></div></div>
            <div class="field"><label for="dream-from">Leaving from</label><select id="dream-from" name="from">${origins.map(o => html`<option value="${o.id}">${o.city}</option>`)}</select></div>
          </div>
          <div class="field"><label for="dream-depart">I have to be there on <span class="optional">(optional)</span></label><input id="dream-depart" type="date" name="depart" min="${addDays(today(), 3)}" max="${addDays(today(), 330)}"></div>
          <button class="btn btn-navy" type="submit">Search this trip ${icon('arrow')}</button>
        </form>
        <p class="tb-small tb-muted">Flights, hotel and the extras for one destination, priced in full. On their own:</p>
        ${products.every(p => p.state === 'soon')
          ? html`<p class="tb-products-soon">${products.map(p => p.label).join(' · ')} <small class="soon-badge">Coming soon</small></p>`
          : html`<ul class="tb-products" aria-label="Travel products">${products.map(p => html`<li>${productItem(p)}</li>`)}</ul>`}
      </div>
    </div>
    <p class="tb-paths-more tb-small tb-muted">Already found a trip somewhere else? <a href="/challenge">Challenge us</a>: like for like, complete prices only, and if your deal is better we say keep it.</p>
  </div>
</section>

<section class="tb-section" aria-labelledby="tb-how-title">
  <div class="container">
    <p class="eyebrow eyebrow-center">How it works</p>
    <h2 id="tb-how-title" class="section-title section-title-center">Tell us your budget. The agent does the rest.</h2>
    <ol class="tb-how">
      <li><span class="tb-how-num">1</span><b>Say what you want</b><p>Your budget, who’s going, where from, and anything that must be true. The agent asks only what it can’t go without, and never guesses.</p></li>
      <li><span class="tb-how-num">2</span><b>It builds complete trips</b><p>Flights, hotel and the extras, priced in full by our pricing engine, never estimated by the AI. The first strong trip comes first; then every destination is checked.</p></li>
      <li><span class="tb-how-num">3</span><b>Change anything</b><p>“Make it $200 cheaper.” “Don’t change the hotel.” Every change is shown before and after, with the price difference, and nothing changes without your approval.</p></li>
      <li><span class="tb-how-num">4</span><b>You book, it never does</b><p>What you asked for against what you’re getting, the price re-checked, every term in the open. Then you confirm. The agent never charges anything.</p></li>
    </ol>
    <p class="center"><a class="text-link" href="/how-it-works">More about how we build and price trips ${icon('arrow')}</a></p>
  </div>
</section>

${oneExample(ctx, example)}

<section class="tb-section tb-promise" aria-labelledby="tb-promise-title">
  <div class="container">
    <h2 id="tb-promise-title" class="sr-only">What we promise</h2>
    <ul class="tb-promise-grid">
      <li>${icon('shield')}<b>The price you see is the price you pay.</b><span>Taxes, mandatory fees and our service fee are always in the total. Nothing is added at checkout.</span></li>
      <li>${icon('check')}<b>Under your budget means under your budget.</b><span>We never call a trip “within budget” if fees push it over, and we never hide an over-budget amount. Your maximum is a ceiling, not a target.</span></li>
      <li>${icon('eye')}<b>No fake urgency.</b><span>No made-up “only 2 left”, no invented discounts or savings. When the agent doesn’t know, it says “needs verification”.${ctx.tripService.demo ? ' In this preview the trips, prices and ratings themselves are demo examples, not real offers.' : ''}</span></li>
      <li>${icon('users')}<b>Nothing happens without you.</b><span>The agent never books, charges, cancels or changes a trip on its own. Every change is shown before and after, and you approve it.</span></li>
    </ul>
  </div>
</section>

<section class="tb-section tb-final" aria-labelledby="tb-final-title">
  <div class="container">
    <h2 id="tb-final-title" class="section-title">${company.promise}</h2>
    ${agentBudget('final')}
  </div>
</section>`;
  return layout({
    title: null, active: 'home', body, ctx,
    description: `${company.brandName} is an AI travel agent. Tell it your budget and it builds complete trips (flights, hotel, experiences) with every tax and fee in the price, then you decide.`,
    scripts: ['/js/trips.js'], canonical: '/',
  });
}

module.exports = { homeView, budgetForm, ENTRY_MODES };
