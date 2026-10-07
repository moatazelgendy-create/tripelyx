// About, Contact support and the page for travel businesses, plus the pre-launch homepage that "/"
// shows when the trip planner is off. Company facts come from ctx.company (server/company.js); a fact
// the owner has not confirmed is simply left out.
const { html } = require('../lib/html');
const { icon } = require('./icons');
const { layout } = require('./layout');
const { pageHero } = require('./components');

const company = ctx => ctx.company || ctx.config.company;
const startHref = ctx => (ctx.trips ? '/plan' : null);

// What the product itself enforces. Each line is a rule in the code, not a slogan.
const PROMISES = [
  ['wallet', 'Your budget is a ceiling, not a target', 'A trip is called “within budget” only when its full total, taxes and mandatory fees included, is at or under the number you gave.'],
  ['shield', 'The total you see is the total you pay', 'Nothing is added at checkout. If a supplier’s price changes before you pay, you see the difference and approve it, or nothing is charged.'],
  ['check', 'You make every decision', 'Nothing is booked, charged, cancelled or changed without your explicit approval.'],
  ['star', 'Ranked for you, not for us', 'Recommendations are ranked on what fits your trip, never on what Tripelyx earns, and a cheaper option is always shown with what it gives up.'],
];

function aboutView(ctx) {
  const c = company(ctx);
  const start = startHref(ctx);
  const body = html`
${pageHero({ eyebrow: `About ${c.brandName}`, title: 'Tell us your budget.', accent: 'We’ll build the trip.', lead: `${c.brandName} is an AI travel agent. You give it a budget and the few rules that matter; it builds and prices complete trips, explains its pick and leaves every decision to you.` })}
<section class="section"><div class="container tb-prose">
  <h2>Why ${c.brandName} exists</h2>
  <p>Most travel sites start with where. You choose a destination, then a flight, then a hotel, and only at checkout do you find out what the whole trip costs once taxes, fees and the extras you need are added. ${c.brandName} starts from the number you are comfortable spending and works the other way: it builds complete trips that fit, shows the true total of each, and tells you what you keep.</p>
  <h2>How it decides</h2>
  <p>The arithmetic happens in our pricing engine. Every total is calculated from the supplier’s prices, taxes and mandatory fees; the AI never estimates a price from a conversation. The AI’s job is to understand what you want, compare the trips that fit, explain the trade-offs plainly and ask you when only you can decide.</p>
  <h2>What we promise</h2>
  <ul class="tb-promises">${PROMISES.map(([i, t, d]) => html`<li>${icon(i)}<span><b>${t}.</b> ${d}</span></li>`)}</ul>
  ${start ? html`<p class="mt-28"><a class="btn btn-navy btn-lg" href="${start}">Build my trip ${icon('arrow')}</a></p>` : ''}
</div></section>
<section class="section section-soft" aria-labelledby="history-title"><div class="container tb-prose">
  <h2 id="history-title">Company history</h2>
  <p>${c.brandName} began on Egypt’s Mediterranean coast with Alamein Go, a local booking brand for New Alamein and the North Coast. ${c.brandName} itself is focused on one product: the AI travel agent on this site.</p>
  <p class="tb-muted tb-small">${c.brandName} is operated by ${c.legalName}.</p>
</div></section>`;
  return layout({ title: 'About', active: 'about', body, ctx, canonical: '/about', description: `Why ${c.brandName} exists: an AI travel agent that starts from your budget, prices complete trips in full and leaves every decision to you.` });
}

// The rows of "how to reach us": only the facts that are set.
function reachUs(c) {
  return html`<ul class="checklist tb-reach">
    <li>${icon('mail')}<span>Email <a href="mailto:${c.supportEmail}">${c.supportEmail}</a></span></li>
    ${c.supportPhone ? html`<li>${icon('phone')}<span>Phone ${c.supportPhone}</span></li>` : ''}
    ${c.supportHours ? html`<li>${icon('clock')}<span>${c.supportHours}</span></li>` : ''}
    ${c.businessAddress ? html`<li>${icon('pin')}<span>${c.businessAddress}</span></li>` : ''}
  </ul>`;
}

function contactView(ctx, { trip = null } = {}) {
  const c = company(ctx);
  const body = html`
${pageHero({ eyebrow: 'Support', title: 'Contact support.', lead: 'A question about a trip you’re planning or a booking you’ve made? Send us a message and we’ll reply by email.' })}
<section class="section">
  <div class="container split split-top">
    <div>
      <h2 class="section-title">How to reach us</h2>
      ${reachUs(c)}
      ${ctx.trips ? html`<p class="section-lead">Have a booking? Open it under <a href="/my-trips">My Trips</a>, or <a href="/manage">find it with your Trip ID</a>, to message support about that trip; the conversation stays with your booking.</p>` : ''}
    </div>
    ${messageForm('support', { trip })}
  </div>
</section>`;
  return layout({ title: 'Contact support', active: 'contact', body, ctx, canonical: '/contact', description: `Contact ${c.brandName} support about a trip you’re planning or a booking you’ve made.`, scripts: ['/js/forms.js'] });
}

// For travel businesses. It states what we need from a supplier; it makes no claim about volume,
// reach or features the site does not have.
function partnersView(ctx) {
  const c = company(ctx);
  const needs = [
    ['wallet', 'Complete prices', 'Every tax and mandatory fee, so the total a traveler sees is the total they pay.'],
    ['calendar', 'Real availability', 'Inventory we can confirm at booking time, with nothing shown that can’t be booked.'],
    ['shield', 'Clear terms', 'Cancellation and change rules we can show before the traveler pays.'],
    ['layers', 'A way to book', 'An API or a reliable confirmation process for each booking.'],
  ];
  const body = html`
${pageHero({ eyebrow: 'For travel businesses', title: `Work with ${c.brandName}.`, lead: `${c.brandName} builds complete trips around a traveler’s budget. We work with hotels, airlines, tour, transfer and car rental operators, cruise lines and travel technology providers whose prices and terms can be shown honestly and in full.` })}
<section class="section">
  <div class="container">
    <h2 class="section-title">What we need from a supplier</h2>
    <div class="grid-4 mt-28">
      ${needs.map(([i, t, d]) => html`<div class="card"><span class="card-icon">${icon(i)}</span><h3>${t}</h3><p>${d}</p></div>`)}
    </div>
  </div>
</section>
<section class="section section-soft" id="partner-form">
  <div class="container split">
    <div>
      <h2 class="section-title">Tell us about your business.</h2>
      <p class="section-lead">Share a few details and we’ll reply by email.</p>
      ${reachUs(c)}
    </div>
    ${messageForm('partner')}
  </div>
</section>`;
  return layout({ title: 'For travel businesses', active: 'partners', body, ctx, canonical: '/partners', description: `Suppliers and travel businesses: work with ${c.brandName}.`, scripts: ['/js/forms.js'] });
}

const TOPICS = {
  support: ['A trip I’m planning', 'A booking I’ve made', 'A business or partnership enquiry', 'Something else'],
  partner: ['Hotel or property', 'Airline', 'Tours and activities', 'Transfers or car rental', 'Cruise line', 'Travel technology', 'Other'],
};

function messageForm(kind, { trip = null } = {}) {
  return html`<form class="form-card form" data-lead-form novalidate>
    <input type="hidden" name="kind" value="${kind}">
    ${trip ? html`<input type="hidden" name="trip" value="${trip}"><p class="tb-small tb-muted">About the trip you were looking at. We’ll see the same trip and its prices.</p>` : ''}
    <div class="form-row">
      <div class="field"><label for="lf-name">Your name</label><input id="lf-name" name="name" autocomplete="name" required maxlength="100"><p class="field-error" data-error-for="name"></p></div>
      ${kind === 'partner' ? html`<div class="field"><label for="lf-company">Company</label><input id="lf-company" name="company" autocomplete="organization" maxlength="120"></div>` : ''}
    </div>
    <div class="form-row">
      <div class="field"><label for="lf-email">Email</label><input id="lf-email" name="email" type="email" autocomplete="email" required maxlength="120"><p class="field-error" data-error-for="email"></p></div>
      <div class="field"><label for="lf-type">${kind === 'partner' ? 'Type of business' : 'What it’s about'}</label>
        <select id="lf-type" name="type">${TOPICS[kind].map(o => html`<option${trip && o === TOPICS.support[0] ? ' selected' : ''}>${o}</option>`)}</select></div>
    </div>
    <div class="field"><label for="lf-message">Message</label><textarea id="lf-message" name="message" required maxlength="2000"></textarea><p class="field-error" data-error-for="message"></p></div>
    <div class="sr-only" aria-hidden="true"><label for="lf-website">Website</label><input id="lf-website" name="website" tabindex="-1" autocomplete="off"></div>
    <div data-form-status role="status" aria-live="polite"></div>
    <button class="btn btn-navy btn-lg" type="submit"><span class="btn-label">Send message</span> ${icon('arrow')}</button>
    <noscript><p class="alert alert-info">This form needs JavaScript. You can also email us at the address on this page.</p></noscript>
  </form>`;
}

// "/" while the trip planner is off (for example when demo inventory is refused and no real supplier is
// connected yet): who we are and how to reach us, with nothing to book.
function prelaunchView(ctx) {
  const c = company(ctx);
  const body = html`
${pageHero({ eyebrow: `${c.brandName} · AI travel agent`, title: c.promise, lead: `${c.brandName} isn’t taking trips right now. To hear when it does, or for anything else, write to us.` })}
<section class="section"><div class="container tb-prose">${reachUs(c)}</div></section>`;
  return layout({ body, ctx, canonical: '/' });
}

module.exports = { aboutView, contactView, partnersView, prelaunchView, TOPICS };
