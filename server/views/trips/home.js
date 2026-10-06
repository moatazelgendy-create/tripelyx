// The homepage: one product, the AI travel agent. One question, a sentence in the traveler's own
// words, and the agent does the searching, comparing and negotiating. Below it: a live example of
// what one sentence gets you, where a budget can take you, how the agent works, the three ways in
// (a budget, a dream destination, a trip to beat), and the promise.
const { html, raw, jsonScript } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { addDays, today } = require('../../lib/dates');
const { money, dollars, demoBadge, plural } = require('./common');
const { EXAMPLES } = require('./agent');

const BUDGET_LEVELS = [500, 1000, 1500, 2000, 3000, 5000];
const STYLE_CHIPS = [['beach', 'Beach'], ['city', 'City break'], ['adventure', 'Adventure'], ['romantic', 'Romantic'], ['family', 'Family'], ['all-inclusive', 'All-inclusive']];

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

function exampleCard(p, budget) {
  const t = p.trip;
  return html`<li class="tb-example-card">
    <img src="${t.dest.image.url}" alt="${t.dest.image.alt}" width="400" height="250" loading="lazy">
    <div>
      <span class="tb-kicker">${p.label}</span>
      <h3>${t.dest.name} <small>· ${plural(t.spec.nights, 'night')}</small></h3>
      <p>${t.flight.stops ? '1-stop' : 'Nonstop'} flights · ${t.hotel.stars}-star hotel${t.activities.length ? ` · ${plural(t.activities.length, 'experience')}` : ''}</p>
      <p class="tb-example-price"><b>${money(t.total)}</b> <span>${budget - t.total >= 0 ? `${dollars(budget - t.total)} under budget` : `${dollars(t.total - budget)} over`}</span></p>
    </div>
  </li>`;
}

// The third tile when the engine found no upgrade worth its price: the honest answer, not a filler trip.
function keepTile(keep) {
  return html`<li class="tb-example-card tb-example-keep">
    <div>
      <span class="tb-kicker">Keep your money</span>
      <h3>${dollars(keep.spare)} <small>stays with you</small></h3>
      <p>We couldn’t find a good reason to spend the other ${dollars(keep.spare)}: nothing we priced improved on our pick in a way worth its price.</p>
    </div>
  </li>`;
}

function homeView(ctx, { example, levels, dreamDestinations, origins, user, recent }) {
  const budget = example.query.budget;
  const exampleSentence = `I have ${dollars(budget)} for ${example.query.travelers} people, from ${example.originCity}, ${plural(example.query.nights, 'night')}, beach. The hotel matters most.`;
  const body = html`
<section class="tb-hero ag-hero" aria-labelledby="tb-hero-title">
  <div class="tb-hero-media" role="img" aria-label="A bright coastline with turquoise water and white sand"></div>
  <div class="container tb-hero-inner">
    <p class="eyebrow eyebrow-light">Your AI travel agent</p>
    <h1 id="tb-hero-title" class="tb-hero-title">What do you want<br>your trip to do?</h1>
    <p class="tb-hero-lead">Say it in your own words. The agent searches, compares, optimizes and negotiates complete trips inside your budget. You decide.</p>
    <form class="ag-hero-form" method="post" action="/agent">
      <label class="sr-only" for="hero-say">Tell your travel agent what you want</label>
      <textarea id="hero-say" name="say" rows="2" maxlength="600" placeholder="Tell your travel agent what you want…"></textarea>
      <div class="ag-hero-actions">
        <button class="btn btn-blue btn-lg" type="submit">Build my trip ${icon('arrow')}</button>
        <button class="btn btn-white btn-lg" type="submit" name="mode" value="surprise">${icon('sparkle')} Surprise me</button>
        <a class="btn btn-ghost-light btn-lg" href="/challenge">I already found a trip</a>
      </div>
      <p class="tb-budget-hint">Try one:</p>
      <div class="ag-chips ag-hero-examples">${EXAMPLES.map(e => html`<button class="ag-chip" type="submit" name="example" value="${e}">${e}</button>`)}</div>
    </form>
    <p class="tb-budget-hint">Every price includes taxes and fees. First strong match in seconds, then it keeps searching. Nothing is booked until you confirm.</p>
  </div>
</section>

${recent ? html`<section class="tb-section tb-section-tight" aria-label="Your unfinished trip">
  <div class="container"><div class="tb-return">
    <img src="${recent.trip.dest.image.url}" alt="" width="160" height="100">
    <div><p class="tb-kicker">Still thinking about ${recent.trip.dest.name}?</p><p>${plural(recent.trip.spec.nights, 'night')} for ${recent.trip.spec.travelers}, now <b>${money(recent.trip.total)}</b>. Prices were refreshed just now.</p></div>
    <a class="btn btn-navy" href="/trip/${recent.token}?${recent.budget ? `b=${Math.round(recent.budget / 100)}` : ''}">Continue my trip ${icon('arrow')}</a>
  </div></div>
</section>` : ''}

<section class="tb-section" aria-labelledby="tb-example-title">
  <div class="container">
    <div class="section-head">
      <div><p class="eyebrow">What one sentence gets you</p><h2 id="tb-example-title" class="section-title">“${exampleSentence}”</h2></div>
      ${demoBadge(ctx.tripService.demo, 'Demo inventory')}
    </div>
    <div class="tb-example" data-example>
      <ol class="tb-building" data-building aria-live="polite">
        <li>Reading what you asked for…</li><li>Pricing the likeliest destinations first…</li><li>First strong match…</li><li>Checking every destination…</li><li>Deciding what’s worth your money…</li>
      </ol>
      <div class="tb-example-result" data-example-result>
        <p class="tb-example-head">Three answers. One budget. You choose, or keep talking.</p>
        <ul class="tb-example-grid">${example.picks.map(p => exampleCard(p, budget))}${example.picks.length < 3 && example.keepMoney && example.keepMoney.spare > 0 ? keepTile(example.keepMoney) : ''}</ul>
        <div class="tb-example-foot">From ${example.originCity} · ${plural(example.query.travelers, 'traveler')} · every price includes taxes, mandatory fees and our service fee. <form class="ag-say" method="post" action="/agent"><input type="hidden" name="say" value="${exampleSentence}"><button class="tb-linkbtn" type="submit">Say this to your agent ${icon('arrow')}</button></form> · <a href="/trips?${example.params}">See these trips ${icon('arrow')}</a></div>
      </div>
    </div>
  </div>
</section>

<section class="tb-section tb-section-soft" aria-labelledby="tb-levels-title">
  <div class="container">
    <p class="eyebrow eyebrow-center">Explore by budget</p>
    <h2 id="tb-levels-title" class="section-title section-title-center">Where can your budget take you?</h2>
    <form class="tb-slider" action="/plan" method="get" data-budget-slider>
      <label for="tb-range" class="sr-only">Budget</label>
      <input id="tb-range" type="range" min="0" max="${BUDGET_LEVELS.length - 1}" step="1" value="2" list="tb-levels" name="lvl" data-range>
      <datalist id="tb-levels">${BUDGET_LEVELS.map((l, i) => html`<option value="${i}" label="${dollars(l * 100)}${i === BUDGET_LEVELS.length - 1 ? '+' : ''}"></option>`)}</datalist>
      <ul class="tb-slider-marks" aria-hidden="true">${BUDGET_LEVELS.map((l, i) => html`<li><a href="/trips-under-${l}">${dollars(l * 100)}${i === BUDGET_LEVELS.length - 1 ? '+' : ''}</a></li>`)}</ul>
      <input type="hidden" name="b" value="${BUDGET_LEVELS[2]}" data-range-budget>
      <div class="tb-slider-out" data-range-out>
        ${levels.map((lv, i) => html`<div class="tb-level${i === 2 ? ' is-on' : ''}" data-level="${i}"${i === 2 ? '' : raw(' hidden')}>
          <p><b>${dollars(lv.budget * 100)}</b> for two from ${lv.originCity} unlocks <b>${plural(lv.destinations, 'destination')}</b>${lv.cheapest ? html` · trips from <b>${money(lv.cheapest)}</b>` : ''}</p>
          <ul class="tb-level-dests">${lv.examples.map(e => html`<li><a href="/trips-to-${e.slug}">${e.name}</a> <span>${money(e.total)}</span></li>`)}</ul>
        </div>`)}
      </div>
      <button class="btn btn-navy" type="submit">Build a trip for this budget ${icon('arrow')}</button>
    </form>
    <ul class="tb-inspo" aria-label="Budget inspiration">
      <li><a href="/trips-under-1000"><b>Trips under $1,000</b><span>Short city breaks and beach escapes</span></a></li>
      <li><a href="/trips-under-500?nights=2&style=city"><b>Weekend trips under $500</b><span>Two nights, one bag</span></a></li>
      <li><a href="/trips-under-1500?style=beach&nights=5"><b>5-night beach trips under $1,500</b><span>Our most-built trip</span></a></li>
      <li><a href="/trips-under-2000?region=international"><b>International trips under $2,000</b><span>Passport required</span></a></li>
      <li><a href="/trips-under-3000?style=all-inclusive"><b>All-inclusive trips under $3,000</b><span>Meals and drinks in the price</span></a></li>
    </ul>
  </div>
</section>

<section class="tb-section" aria-labelledby="tb-how-title">
  <div class="container">
    <p class="eyebrow eyebrow-center">How it works</p>
    <h2 id="tb-how-title" class="section-title section-title-center">Stop searching. Tell your travel agent.</h2>
    <ol class="tb-how">
      <li><span class="tb-how-num">1</span><b>Say what you want</b><p>One message in your words: budget, who’s going, where from, what must be true. The agent asks only what it can’t go without, and never guesses.</p></li>
      <li><span class="tb-how-num">2</span><b>First strong match, then better</b><p>The likeliest destinations are priced first, so a complete trip lands in seconds. Then every destination is checked, and if a better one turns up you choose whether to switch.</p></li>
      <li><span class="tb-how-num">3</span><b>Negotiate it</b><p>“Make it $200 cheaper.” “Don’t change the hotel.” “Spend $100 if it actually helps.” Every change is shown before and after, and nothing changes without your approval.</p></li>
      <li><span class="tb-how-num">4</span><b>Book what you were promised</b><p>What you asked for against what you’re getting, the live price re-checked, every term in the open. Then you confirm. The agent never charges anything.</p></li>
    </ol>
    <p class="center"><a class="text-link" href="/how-it-works">More about how we build and price trips ${icon('arrow')}</a></p>
  </div>
</section>

<section class="tb-section tb-section-soft" aria-labelledby="tb-ways-title">
  <div class="container">
    <p class="eyebrow eyebrow-center">Three ways in</p>
    <h2 id="tb-ways-title" class="section-title section-title-center">Start from a budget, a destination, or a trip you already found.</h2>
    <div class="tb-ways">
      <form class="tb-way form" action="/plan" method="get">
        <p class="tb-kicker">I have a budget</p>
        <h3>How much do you want to spend?</h3>
        <div class="field"><label for="way-b" class="sr-only">Budget</label><div class="tb-budget-input tb-budget-input-sm"><span class="tb-currency" aria-hidden="true">$</span><input id="way-b" name="b" type="text" inputmode="numeric" placeholder="1,500" required></div></div>
        <button class="btn btn-navy" type="submit">Build my best trip ${icon('arrow')}</button>
        <p class="tb-small tb-muted">One question at a time, then three answers: our pick, save more, and an upgrade only if it’s worth it.</p>
      </form>
      <form class="tb-way form" action="/dream" method="get">
        <p class="tb-kicker">I know where I want to go</p>
        <h3>Give us the destination and your maximum.</h3>
        <div class="field"><label for="dream-dest">Destination</label><select id="dream-dest" name="dest" required>${dreamDestinations.map(d => html`<option value="${d.id}">${d.name}, ${d.country}</option>`)}</select></div>
        <div class="field"><label for="dream-b">My maximum</label><div class="tb-budget-input tb-budget-input-sm"><span class="tb-currency" aria-hidden="true">$</span><input id="dream-b" name="b" type="text" inputmode="numeric" placeholder="3,000" required></div></div>
        <div class="field"><label for="dream-from">Leaving from</label><select id="dream-from" name="from">${origins.map(o => html`<option value="${o.id}">${o.city}</option>`)}</select></div>
        <div class="field"><label for="dream-depart">I have to be there on <span class="optional">(optional)</span></label><input id="dream-depart" type="date" name="depart" min="${addDays(today(), 3)}" max="${addDays(today(), 330)}"></div>
        <button class="btn btn-navy" type="submit">Make it work ${icon('arrow')}</button>
        <p class="tb-small tb-muted">The closest version of the trip you want, what would have to change to fit, and you decide. No “no results”.</p>
      </form>
      <form class="tb-way form" action="/challenge" method="get">
        <p class="tb-kicker">Already found a trip?</p>
        <h3>Challenge us. Can we build a better vacation?</h3>
        <div class="field"><label for="beat-dest">The trip you found</label><select id="beat-dest" name="dest" required>${dreamDestinations.map(d => html`<option value="${d.id}">${d.name}, ${d.country}</option>`)}</select></div>
        <div class="field"><label for="beat-b">Their total price</label><div class="tb-budget-input tb-budget-input-sm"><span class="tb-currency" aria-hidden="true">$</span><input id="beat-b" name="total" type="text" inputmode="numeric" placeholder="2,400" required></div></div>
        <div class="field"><label for="beat-from">Leaving from</label><select id="beat-from" name="from">${origins.map(o => html`<option value="${o.id}">${o.city}</option>`)}</select></div>
        <input type="hidden" name="nights" value="5">
        <button class="btn btn-navy" type="submit">Challenge us ${icon('arrow')}</button>
        <p class="tb-small tb-muted">Like for like, complete prices only, and we don’t have to win: if your deal is better, we say keep it.</p>
      </form>
    </div>
  </div>
</section>

<section class="tb-section" aria-labelledby="tb-styles-title">
  <div class="container">
    <h2 id="tb-styles-title" class="section-title section-title-center">What kind of trip sounds good?</h2>
    <ul class="tb-style-grid">${STYLE_CHIPS.map(([k, l]) => html`<li><a class="tb-style" href="/plan?style=${k}">${l}</a></li>`)}</ul>
  </div>
</section>

<section class="tb-section tb-promise" aria-label="Our promise">
  <div class="container">
    <ul class="tb-promise-grid">
      <li>${icon('shield')}<b>The price you see is the price you pay.</b><span>Taxes, mandatory fees and our service fee are always in the total. Nothing is added at checkout.</span></li>
      <li>${icon('check')}<b>Under your budget means under your budget.</b><span>We never call a trip “within budget” if fees push it over, and we never hide an over-budget amount. Your maximum is a ceiling, not a target.</span></li>
      <li>${icon('eye')}<b>No fake urgency, no invented facts.</b><span>No made-up “only 2 left”, no invented discounts, prices, ratings or savings. When the agent doesn’t know, it says “needs verification”.</span></li>
      <li>${icon('users')}<b>Nothing happens without you.</b><span>The agent never books, charges, cancels or changes a trip on its own. Every change is shown before and after, and you approve it.</span></li>
    </ul>
  </div>
</section>
<script type="application/json" id="tb-home-data">${jsonScript({ levels: levels.map(l => l.budget) })}</script>`;
  return layout({
    title: null, active: 'home', body, ctx,
    description: 'Tell your AI travel agent what you want your trip to do. It searches, compares and negotiates complete trips (flights, hotel, experiences) inside your budget, with every tax and fee in the price.',
    scripts: ['/js/trips.js'], canonical: '/',
  });
}

module.exports = { homeView, budgetForm, BUDGET_LEVELS };
