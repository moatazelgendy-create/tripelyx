// /business: the Tripelyx Business homepage (plan §B5). A corporate page in the pages router, registered only
// when Business is enabled, and rendered with Travel by Budget on or off.
//
// It follows the section order of a well-known company travel homepage (hero with "What would you like to
// do?" cards, platform intro, three pillars, AI promo, persona cards, savings, support, closing call to
// action), in our own words. Left out on purpose: a logo bar and testimonials (we have no customers to show),
// and any price, percentage, rating, statistic or customer claim. "Tripelyx Inc" is the only company named.
//
// Switches, from what actually runs here:
//   - ctx.business missing (the service failed to build): every button says "Talk to us" (#business-form) and
//     nothing links to /business/start or /business/signin;
//   - the Business inventory's status: 'demo' (demo flights and hotels), 'sandbox' (our suppliers' test
//     systems: prices are test data, not real fares; real-suppliers design §2.3), 'none' ("Supplier not
//     connected yet") or 'live' (real airline and hotel connections; never today), for the preview note and
//     "Where it stands today".
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { leadForm } = require('../pages');
const { BUSINESS_EMAIL } = require('../../business/constants');

const START = '/business/start';
const SIGNIN = '/business/signin';
const FORM = '#business-form';

/** The page's section ids, in order (the test walks them). */
const SECTIONS = Object.freeze(['bz-hero', 'bz-start', 'bz-platform', 'bz-pillars', 'bz-ai', 'bz-people', 'bz-savings', 'bz-support', 'bz-today', 'bz-cta', 'business-form']);

/** "What would you like to do?" (§B5.2). href null: no link (the invite link is the way in). */
const PATHS = Object.freeze([
  { icon: 'layers', title: 'Set up travel for my company', text: 'Create a workspace, then add your policy, budgets and team.', href: START },
  { icon: 'plane', title: 'Plan my own work trip', text: 'Already invited? Sign in to your company.', href: SIGNIN },
  { icon: 'check', title: "Approve my team's trips", text: 'Sign in to see the requests waiting for you.', href: SIGNIN },
  { icon: 'mail', title: "Join my company's workspace", text: 'Open the invite link your travel admin sent you.', href: null },
  { icon: 'wallet', title: 'Keep travel inside budget', text: 'See how department budgets work.', href: '#bz-budgets' },
]);

/** The three pillars (§B5.5). */
const PILLARS = Object.freeze([
  { id: 'bz-policy', icon: 'shield', title: 'Policy that travels with your team', text: 'Set limits by flight length, cabin, how far ahead people plan, stops and refundability. Cap hotels per country, with city exceptions. Travelers see their limits while they search.' },
  { id: 'bz-approvals', icon: 'check', title: "Approvals that don't hold trips up", text: "Trips inside policy are approved the moment they're requested. Anything outside goes to the right person with the reason attached and the cheaper option next to it. Nobody approves their own trip." },
  { id: 'bz-budgets', icon: 'wallet', title: 'Spending you see before it happens', text: 'Give each department a budget for the month or quarter. Every approved trip counts against it straight away.' },
]);

/** The persona cards (§B5.7). */
const PERSONAS = Object.freeze([
  { icon: 'user', title: 'Employees', text: 'See your limits while you search, pick a trip that fits, and follow every request in one list.' },
  { icon: 'users', title: 'Managers', text: "One inbox for your team's requests, with the reason, the policy check, the budget impact and the cheaper option side by side." },
  { icon: 'sliders', title: 'Travel admins', text: 'Write the policy once for staff, directors and executives. Invite people and choose who approves whose trips.' },
  { icon: 'chart', title: 'Finance', text: "See what approved trips commit against each department's budget, and export every request." },
]);

/** "Where it stands today" (§B5.11): what the preview has now and what comes next, with no dates. */
const PREVIEW_NOW = Object.freeze([
  'Company workspaces with roles for owners, travel admins, finance, managers and employees',
  'Travel policies for flights and hotels, in three tiers',
  'Department budgets for the month or quarter',
  'Approvals with an in-app inbox',
  'AI-powered cheaper alternatives on demo data',
  'Reports on requests, with a CSV export',
]);
/** With no supplier connected, search (and so trips, approvals, alternatives and reports) waits for one. */
const PREVIEW_NOW_NO_SUPPLIER = Object.freeze([
  'Company workspaces with roles for owners, travel admins, finance, managers and employees',
  'Travel policies for flights and hotels, in three tiers',
  'Department budgets for the month or quarter',
]);
/** With real airline and hotel connections (inventory status 'live'): nothing on demo data any more. */
const PREVIEW_NOW_LIVE = Object.freeze(PREVIEW_NOW.map(t => t.replace(' on demo data', '')));
/** With the suppliers' test systems (inventory status 'sandbox'): the same, on their test data. */
const PREVIEW_NOW_SANDBOX = Object.freeze(PREVIEW_NOW.map(t => t.replace(' on demo data', " on our suppliers' test data")));
const COMING_NEXT = Object.freeze([
  'Real airline and hotel connections',
  'Booking and payment',
  'Company billing',
  'Reports on booked spend',
  'Email notifications',
  'Single sign-on',
]);
const COMING_NEXT_NO_SUPPLIER = Object.freeze([
  'Trip search with policy checks, approvals and AI-powered cheaper alternatives, once airlines and hotels are connected',
  ...COMING_NEXT,
]);
const COMING_NEXT_LIVE = Object.freeze(COMING_NEXT.filter(t => t !== 'Real airline and hotel connections'));

const NOTES = Object.freeze({
  demo: 'Preview: flights, hotels and prices are demo data while we connect suppliers. Nothing is booked or charged yet.',
  sandbox: "In this preview, flights and hotels come from our suppliers' test systems, so prices are test data, not real fares. Nothing is booked or charged yet.",
  none: 'Trip search turns on once we connect airlines and hotels. Nothing is booked or charged yet.',
  live: "Booking isn't open yet, so nothing is booked or charged.",
  off: "Preview: company workspaces aren't open on this site right now. Nothing is booked or charged.",
});

/**
 * The words that call Tripelyx Business a preview, used only while flights and hotels are demo data or supplier
 * test data (or no workspace runs here). With no supplier yet, or live prices, the page says what isn't open
 * instead (go-live design §3.4): www keeps its companies in its real database, so it is not a trial.
 */
const PREVIEW_WORDS = Object.freeze({ eyebrow: 'Tripelyx Business · Preview', support: 'Questions about the preview?', nowTitle: 'In the preview now', nowChip: 'In the preview' });
const OPEN_WORDS = Object.freeze({ eyebrow: 'Tripelyx Business', support: 'Questions?', nowTitle: 'Available now', nowChip: 'Available' });
const wordsFor = status => (status === 'none' || status === 'live' ? OPEN_WORDS : PREVIEW_WORDS);

/** What the page says about the inventory: 'demo', 'sandbox', 'none', 'live', or 'off' when the workspace isn't running here. */
function inventoryState(ctx) {
  if (!ctx.business) return 'off';
  const status = ctx.business.inventory && ctx.business.inventory.status;
  return status === 'demo' || status === 'sandbox' || status === 'live' ? status : 'none';
}

const SAVINGS = 'Each request keeps the cheapest option inside your policy that the traveler saw, so you can see what each choice cost or saved. Hotel searches show a Price to Beat: the lower of your nightly limit and the middle rate of that search.';
/** Added to SAVINGS only while the inventory is demo data. */
const SAVINGS_DEMO = 'In the preview these are demo prices.';
/** Added to SAVINGS while the inventory is the suppliers' test data. */
const SAVINGS_SANDBOX = 'In the preview these are supplier test data, not real fares.';
const AI_BODY = 'When a pick goes over policy, Tripelyx AI looks through the same search for a cheaper way to make the trip: another fare on the same flight, a lower cabin, one stop instead of nonstop, a day or three earlier or later if your dates can move, or a hotel under your limit in the same city. Each option is a priced result from that search, with what it saves and what you give up. It never makes up a price.';
const AI_SMALL = 'How it works today: Tripelyx AI runs on rules we write and test, and your trip data stays with Tripelyx.';

/** The two buttons of the hero and the closing band, or "Talk to us" when the workspace isn't running here. */
function actions(live) {
  if (!live) return html`<a class="btn btn-white btn-lg" href="${FORM}">Talk to us ${icon('arrow')}</a>`;
  return html`<a class="btn btn-white btn-lg" href="${START}">Create your company workspace ${icon('arrow')}</a><a class="btn btn-outline-white btn-lg" href="${SIGNIN}">Company sign in</a>`;
}

function pathCard(p, live) {
  const href = p.href && !live && (p.href === START || p.href === SIGNIN) ? FORM : p.href;
  const inner = html`<span class="card-icon">${icon(p.icon)}</span><span class="bz-mk-path-title">${p.title}</span><span class="bz-mk-path-text">${p.text}</span>`;
  return href
    ? html`<li><a class="bz-mk-path" href="${href}">${inner}<span class="bz-mk-path-go" aria-hidden="true">${icon('arrow')}</span></a></li>`
    : html`<li><div class="bz-mk-path is-static">${inner}</div></li>`;
}

/** The three product examples (§B5.4): tagged "Example", with no amounts. */
function examples() {
  return html`<div class="bz-mk-examples">
    <article class="bz-mk-ex" aria-labelledby="bz-ex-flight">
      <p class="bz-mk-ex-head"><span class="bz-mk-ex-kind">${icon('plane')}Flight</span><span class="bz-mk-ex-tag">Example</span></p>
      <h3 id="bz-ex-flight" class="bz-mk-ex-title">Cairo to London</h3>
      <p class="bz-mk-ex-meta">Light fare</p>
      <p class="bz-mk-badge is-within">${icon('check')}<span>Within Policy</span></p>
    </article>
    <article class="bz-mk-ex" aria-labelledby="bz-ex-hotel">
      <p class="bz-mk-ex-head"><span class="bz-mk-ex-kind">${icon('bed')}Hotel</span><span class="bz-mk-ex-tag">Example</span></p>
      <h3 id="bz-ex-hotel" class="bz-mk-ex-title">London hotel</h3>
      <p class="bz-mk-ex-meta">Over your city limit</p>
      <p class="bz-mk-badge is-out">${icon('alert')}<span>Out of Policy</span></p>
    </article>
    <article class="bz-mk-ex" aria-labelledby="bz-ex-request">
      <p class="bz-mk-ex-head"><span class="bz-mk-ex-kind">${icon('users')}Request</span><span class="bz-mk-ex-tag">Example</span></p>
      <h3 id="bz-ex-request" class="bz-mk-ex-title">Request Approval</h3>
      <ol class="bz-mk-steps">
        <li><span class="bz-mk-step-dot" aria-hidden="true"></span><span>Waiting for your manager</span></li>
        <li><span class="bz-mk-step-dot is-done" aria-hidden="true"></span><span>Approved to book</span></li>
      </ol>
    </article>
  </div>`;
}

/** The AI promo's picture: three example alternatives, tagged "Example", with no amounts. */
function altExamples() {
  const alts = [
    ['Same flight, Classic fare', 'What you give up: free changes'],
    ['One stop instead of nonstop', 'What you give up: a longer journey'],
    ['Another hotel in London, under your limit', 'What you give up: a different area of town'],
  ];
  return html`<div class="bz-mk-alts" aria-label="Example cheaper alternatives">
    <p class="bz-mk-alts-head">${icon('sparkle')}<span class="bz-mk-alts-name">AI-powered cheaper alternatives</span><span class="bz-mk-ex-tag">Example</span></p>
    <ul>${alts.map(([title, give]) => html`<li><span class="bz-mk-alt-title">${title}</span><span class="bz-mk-alt-give">${give}</span><span class="bz-mk-badge is-within">${icon('check')}<span>Within Policy</span></span></li>`)}</ul>
  </div>`;
}

function businessMarketingView(ctx) {
  const live = !!ctx.business;
  const status = inventoryState(ctx);
  const now = { demo: PREVIEW_NOW, sandbox: PREVIEW_NOW_SANDBOX, none: PREVIEW_NOW_NO_SUPPLIER, live: PREVIEW_NOW_LIVE, off: [] }[status];
  const next = { demo: COMING_NEXT, sandbox: COMING_NEXT, none: COMING_NEXT_NO_SUPPLIER, live: COMING_NEXT_LIVE, off: [...PREVIEW_NOW, ...COMING_NEXT] }[status];
  const words = wordsFor(status);
  const body = html`
<section class="page-hero bz-mk-hero" id="bz-hero" aria-labelledby="bz-hero-title"><div class="container"><div class="page-hero-inner">
  <p class="eyebrow eyebrow-light">${words.eyebrow}</p>
  <h1 id="bz-hero-title">Company travel, with your rules built in.</h1>
  <p class="lead">Your team plans flights and hotels for work inside your travel policy. Trips that fit are approved straight away. Anything outside goes to the right person with a cheaper option next to it, and finance sees every trip against its budget.</p>
  <div class="hero-actions">${actions(live)}</div>
  <p class="bz-mk-note">${icon('info')}<span>${NOTES[status]}</span></p>
</div></div></section>
<section class="section bz-mk-start" id="bz-start" aria-labelledby="bz-start-title">
  <div class="container">
    <h2 id="bz-start-title" class="bz-mk-start-title">What would you like to do?</h2>
    <ul class="bz-mk-paths">${PATHS.map(p => pathCard(p, live))}</ul>
  </div>
</section>
<section class="section section-soft" id="bz-platform" aria-labelledby="bz-platform-title">
  <div class="container">
    <p class="eyebrow">The platform</p>
    <h2 id="bz-platform-title" class="section-title">Every work trip in one place.</h2>
    <p class="section-lead">Each trip carries its flights, its hotel, the policy check and the approval, so the traveler, the approver and finance all see the same thing.</p>
    ${examples()}
  </div>
</section>
<section class="section" id="bz-pillars" aria-labelledby="bz-pillars-title">
  <div class="container">
    <p class="eyebrow">Policy, approvals and budgets</p>
    <h2 id="bz-pillars-title" class="section-title">Control without the back-and-forth</h2>
    <div class="grid-3 bz-mk-pillars">
      ${PILLARS.map(p => html`<article class="card bz-mk-pillar" id="${p.id}"><span class="card-icon">${icon(p.icon)}</span><h3>${p.title}</h3><p>${p.text}</p></article>`)}
    </div>
  </div>
</section>
<section class="section section-soft" id="bz-ai" aria-labelledby="bz-ai-title">
  <div class="container split split-top bz-mk-ai">
    <div>
      <p class="eyebrow">Tripelyx AI</p>
      <h2 id="bz-ai-title" class="section-title">AI-powered cheaper alternatives</h2>
      <p class="section-lead">${AI_BODY}</p>
      <p class="bz-mk-small">${icon('lock')}<span>${AI_SMALL}</span></p>
    </div>
    ${altExamples()}
  </div>
</section>
<section class="section" id="bz-people" aria-labelledby="bz-people-title">
  <div class="container">
    <p class="eyebrow">Roles</p>
    <h2 id="bz-people-title" class="section-title">Built for everyone who touches a work trip</h2>
    <div class="grid-4 bz-mk-personas">
      ${PERSONAS.map(p => html`<article class="card"><span class="card-icon">${icon(p.icon)}</span><h3>${p.title}</h3><p>${p.text}</p></article>`)}
    </div>
  </div>
</section>
<section class="section section-soft" id="bz-savings" aria-labelledby="bz-savings-title">
  <div class="container split split-top">
    <div>
      <p class="eyebrow">Savings</p>
      <h2 id="bz-savings-title" class="section-title">Every choice measured against your own limits.</h2>
      <p class="section-lead">${SAVINGS}${status === 'demo' ? ` ${SAVINGS_DEMO}` : status === 'sandbox' ? ` ${SAVINGS_SANDBOX}` : ''}</p>
    </div>
    <div class="bz-mk-beat" aria-label="How the Price to Beat is set">
      <p class="bz-mk-beat-row"><span class="card-icon">${icon('shield')}</span><span><b>Your nightly limit</b><span>From your travel policy, for that city or country.</span></span></p>
      <p class="bz-mk-beat-row"><span class="card-icon">${icon('chart')}</span><span><b>The middle rate of the search</b><span>From the hotels in that same search, with outliers left out.</span></span></p>
      <p class="bz-mk-beat-result">${icon('check')}<span><b>Price to Beat:</b> the lower of the two.</span></p>
    </div>
  </div>
</section>
<section class="section" id="bz-support" aria-labelledby="bz-support-title">
  <div class="container bz-mk-support">
    <span class="card-icon">${icon('mail')}</span>
    <div>
      <h2 id="bz-support-title" class="section-title">${words.support}</h2>
      <p class="section-lead">Write to <a href="mailto:${BUSINESS_EMAIL}">${BUSINESS_EMAIL}</a> and a person at Tripelyx will answer.</p>
    </div>
  </div>
</section>
<section class="section section-soft" id="bz-today" aria-labelledby="bz-today-title">
  <div class="container">
    <p class="eyebrow">Honest status</p>
    <h2 id="bz-today-title" class="section-title">Where it stands today</h2>
    <div class="grid-2 bz-mk-today">
      <div class="card">
        <h3>${words.nowTitle}</h3>
        ${now.length
    ? html`<ul class="bz-mk-list">${now.map(t => html`<li><span>${t}</span><span class="chip chip-good">${words.nowChip}</span></li>`)}</ul>`
    : html`<p>Company workspaces aren't open on this site right now. Tell us about your company and we can talk about what fits.</p>`}
      </div>
      <div class="card">
        <h3>Coming next</h3>
        <ul class="bz-mk-list">${next.map(t => html`<li><span>${t}</span><span class="chip">Coming soon</span></li>`)}</ul>
      </div>
    </div>
  </div>
</section>
<section class="bz-mk-cta" id="bz-cta" aria-labelledby="bz-cta-title">
  <div class="container bz-mk-cta-inner">
    <h2 id="bz-cta-title" class="bz-mk-cta-title">Bring your company's travel into one place.</h2>
    <div class="hero-actions">${actions(live)}</div>
  </div>
</section>
<section class="section section-soft" id="business-form" aria-labelledby="bz-form-title">
  <div class="container split split-top">
    <div>
      <p class="eyebrow">Talk to us</p>
      <h2 id="bz-form-title" class="section-title">Tell us about your company.</h2>
      <p class="section-lead">How your team travels for work, and what you need from a travel policy. A person at Tripelyx will reply.</p>
      <ul class="checklist">
        <li>${icon('mail')}<span>Or email <a href="mailto:${BUSINESS_EMAIL}">${BUSINESS_EMAIL}</a>.</span></li>
      </ul>
    </div>
    ${leadForm('business')}
  </div>
</section>`;
  return layout({
    title: 'Business',
    description: 'Tripelyx Business: company travel with your travel policy, approvals and department budgets built in.',
    active: 'business', body, ctx, scripts: ['/js/forms.js'], styles: ['/css/business-marketing.css'], bodyClass: 'bz-mk-page', corporate: true,
  });
}

module.exports = {
  businessMarketingView, SECTIONS, PATHS, PILLARS, PERSONAS, PREVIEW_NOW, PREVIEW_NOW_NO_SUPPLIER, PREVIEW_NOW_LIVE, COMING_NEXT,
  COMING_NEXT_NO_SUPPLIER, COMING_NEXT_LIVE, NOTES, AI_BODY, AI_SMALL, SAVINGS, SAVINGS_DEMO, PREVIEW_NOW_SANDBOX, SAVINGS_SANDBOX,
  PREVIEW_WORDS, OPEN_WORDS, wordsFor,
};
