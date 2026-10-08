// /business: the company page for Tripelyx Business ("Budget Trip Engine for Business"). It is a corporate page
// in the always-mounted pages router, so it renders with Travel by Budget off and with Business off; the
// workspace links and "Available now" appear only when the workspace runs here (ctx.business).
// No numbers, customers, logos or testimonials: only what the product does today and what is coming.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { pageHero, leadForm } = require('../pages');
const { BUSINESS_EMAIL } = require('../../business/constants');

const chip = live => (live
  ? html`<span class="chip chip-good">Available now</span>`
  : html`<span class="chip">Coming soon</span>`);

const STEPS = [
  'Enter the brief: your client’s maximum, departure city, travelers, dates, what they like and what they won’t give up.',
  'Get up to three different options, each priced in full with every tax and fee, inside your client’s maximum with your own fees included.',
  'Send a proposal under your agency’s name, logo and colors.',
  'Your client answers: I Love This, Make It Cheaper, Make It Better, Show Me Another or Ask My Advisor.',
  'Revise with the budget negotiator and send V2. Your client sees exactly what changed.',
];

const FEATURES = [
  ['wallet', 'Budget negotiator', 'See what each change saves, priced on its own.'],
  ['layers', 'Versions', 'V1, V2, V3, and exactly what changed.'],
  ['sparkle', 'Your brand', 'Your name, logo, colors and contact details.'],
  ['sliders', 'Your pricing rules', 'Service fee, per-booking fee, markup and minimum profit. Clients see one complete total with every fee shown, never your margin.'],
  ['users', 'Team roles', 'Owner, Manager, Advisor, Support Agent, Finance and Read Only, with an audit log.'],
  ['clock', 'Follow-ups', 'Reminders for your team. Nothing is sent to clients automatically.'],
];

const HONEST = [
  'Every price comes from priced inventory, never an estimate.',
  'Options are ranked on fit for your client, never on your fee or on commission.',
  'The total your client sees is the full total, with every fee shown as a line.',
  'No countdowns, made-up reviews or “only N left”.',
  'Demo inventory is labeled DEMO.',
];

const ROADMAP = [
  'Online booking and secure payment links',
  'Payments, documents and booking status in the shared workspace',
  'Conversion analytics',
  'Partner revenue reporting',
  'Group trips, room blocks and group payments',
  'Traveler document requests',
  'Creator storefronts, affiliate trip pages and budget challenges',
  'Corporate travel benefits',
  'Partner API',
  'White-label search widget',
  'More than one brand per account',
];

function businessMarketingView(ctx) {
  const live = !!ctx.business;
  const selfServe = !!(ctx.config && ctx.config.business && ctx.config.business.selfServe);
  const demo = live && !!(ctx.tripService && ctx.tripService.demo);
  const actions = live
    ? html`<a class="btn btn-white btn-lg" href="/business/app">Open your agency workspace ${icon('arrow')}</a><a class="btn btn-outline-white btn-lg" href="#business-form">Talk to us</a>`
    : html`<a class="btn btn-white btn-lg" href="#business-form">Talk to us ${icon('arrow')}</a>`;
  const ways = [
    ['plane', 'Travelers', '“I have $2,000. Where can I go?”', 'People planning their own trip start from what they want to spend and see complete trips that fit it.', !!ctx.trips],
    ['compass', 'Advisors', '“My client has $2,000. Build me 3 strong options.”', 'Travel advisors turn a client’s budget into priced options and send them as a proposal under their own brand.', live],
    ['plug', 'Partner API', '“Send us a budget. We return bookable trip possibilities.”', 'Platforms send a budget and get complete trips back to show their own customers.', false],
  ];
  const body = html`
${pageHero({ eyebrow: 'Tripelyx Business', title: 'Budget Trip Engine', accent: 'for Business', lead: 'Give your customers a budget-first travel experience without building the technology from scratch.', actions })}
<section class="section" aria-labelledby="bz-ways-title">
  <div class="container">
    <p class="eyebrow">One engine</p>
    <h2 id="bz-ways-title" class="section-title">Three ways to use it.</h2>
    <p class="section-lead">The same engine that turns a budget into complete, fully priced trips, for travelers, for travel advisors and, later, for other platforms.</p>
    <div class="grid-3 bz-mk-ways">
      ${ways.map(([i, title, quote, text, on]) => html`<div class="card bz-mk-way">
        <span class="card-icon">${icon(i)}</span>
        <h3>${title}</h3>
        <p class="bz-mk-quote">${quote}</p>
        <p>${text}</p>
        <p class="bz-mk-status">${chip(on)}</p>
      </div>`)}
    </div>
  </div>
</section>
<section class="section section-soft" aria-labelledby="bz-how-title">
  <div class="container split split-top">
    <div>
      <p class="eyebrow">Advisor mode</p>
      <h2 id="bz-how-title" class="section-title">How advisor mode works.</h2>
      <p class="section-lead">From your client’s budget to an approved proposal, with every price checked against real inventory.</p>
    </div>
    <ol class="bz-mk-steps">
      ${STEPS.map((s, n) => html`<li><span class="step-num" aria-hidden="true">${String(n + 1)}</span><span>${s}</span></li>`)}
    </ol>
  </div>
</section>
<section class="section" aria-labelledby="bz-tools-title">
  <div class="container">
    <p class="eyebrow">In the workspace</p>
    <h2 id="bz-tools-title" class="section-title">Everything around the proposal.</h2>
    <div class="grid-3 mt-28">
      ${FEATURES.map(([i, t, d]) => html`<div class="card"><span class="card-icon">${icon(i)}</span><h3>${t}</h3><p>${d}</p></div>`)}
    </div>
  </div>
</section>
<section class="section section-soft" aria-labelledby="bz-honest-title">
  <div class="container split split-top">
    <div>
      <p class="eyebrow">Honest by design</p>
      <h2 id="bz-honest-title" class="section-title">Clear numbers for you and your client.</h2>
      <ul class="checklist bz-mk-honest">
        ${HONEST.map(h => html`<li>${icon('check')}<span>${h}</span></li>`)}
      </ul>
    </div>
    <div class="card bz-mk-today">
      <h3>Where it stands today</h3>
      ${live
        ? html`<p>Today: proposals and client approvals. Booking and secure payment through Tripelyx Business are not open yet; an approved proposal is your client’s choice, not a booking.${selfServe ? '' : ' New agency workspaces are reviewed by our team before client sharing is turned on.'}</p>`
        : html`<p>Agency workspaces are not open on this site yet. Booking and secure payment through Tripelyx Business are not open yet either. Tell us about your business and we can talk about what fits.</p>`}
      ${demo ? html`<p class="alert alert-info">${icon('info')}<span>This preview runs on demo inventory: sample trips and prices, clearly labeled, that cannot be booked.</span></p>` : ''}
    </div>
  </div>
</section>
<section class="section" aria-labelledby="bz-roadmap-title">
  <div class="container">
    <p class="eyebrow">On the roadmap</p>
    <h2 id="bz-roadmap-title" class="section-title">What comes next.</h2>
    <p class="section-lead">Planned and not available yet, with no dates set.</p>
    <ul class="bz-mk-roadmap">
      ${ROADMAP.map(r => html`<li><span>${r}</span><span class="chip">Coming soon</span></li>`)}
    </ul>
  </div>
</section>
<section class="section section-soft" id="business-form" aria-labelledby="bz-form-title">
  <div class="container split split-top">
    <div>
      <p class="eyebrow">Talk to us</p>
      <h2 id="bz-form-title" class="section-title">Talk to us about Tripelyx Business.</h2>
      <p class="section-lead">Tell us about your agency, platform or program and what you would like to offer your customers.</p>
      <ul class="checklist">
        <li>${icon('mail')}<span>Or email <a href="mailto:${BUSINESS_EMAIL}">${BUSINESS_EMAIL}</a>.</span></li>
      </ul>
    </div>
    ${leadForm('business')}
  </div>
</section>`;
  return layout({ title: 'Business', description: 'Tripelyx Business: the Budget Trip Engine for travel advisors and travel businesses. Turn a client’s budget into complete, fully priced trip options.', active: 'business', body, ctx, scripts: ['/js/forms.js'], styles: ['/css/business-marketing.css'], bodyClass: 'bz-mk-page', corporate: true });
}

module.exports = { businessMarketingView, STEPS, FEATURES, HONEST, ROADMAP };
