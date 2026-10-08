// /business: the company page for Tripelyx Business, company travel with your travel policy, approvals and
// budgets built in. It is registered in the pages router only when Business is enabled, and renders with
// Travel by Budget on or off.
// Interim copy from Stage 0: it claims nothing that isn't built yet, links no workspace page, and offers the
// contact form. Stage 1V replaces it with the full homepage (plan §B5).
// No numbers, customers, logos or testimonials: only what Business will do and how to reach us.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { pageHero, leadForm } = require('../pages');
const { BUSINESS_EMAIL } = require('../../business/constants');

const ROADMAP = [
  'Company workspaces with roles for owners, travel admins, finance, managers and employees',
  'Travel policies for flights and hotels, shown to travelers while they search',
  'Approvals that go to the right person with the reason attached',
  'Department budgets for the month or quarter',
  'AI-powered cheaper alternatives when a pick goes over policy',
  'Reports and exports for finance',
  'Real airline and hotel connections, booking and payment',
];

function businessMarketingView(ctx) {
  const actions = html`<a class="btn btn-white btn-lg" href="#business-form">Talk to us ${icon('arrow')}</a>`;
  const body = html`
${pageHero({ eyebrow: 'Tripelyx Business', title: 'Company travel, with your rules built in.', lead: 'Travel policy, approvals and department budgets for your team’s work trips, in one place. We’re building it now, and we’d like to hear what your company needs.', actions })}
<section class="section" aria-labelledby="bz-roadmap-title">
  <div class="container split split-top">
    <div>
      <p class="eyebrow">On the roadmap</p>
      <h2 id="bz-roadmap-title" class="section-title">What we’re building.</h2>
      <p class="section-lead">Planned and not available yet, with no dates set.</p>
    </div>
    <div class="card bz-mk-today">
      <h3>Where it stands today</h3>
      <p>Company workspaces are not open on this site yet, and nothing can be booked or charged through Tripelyx Business. Tell us about your company and we can talk about what fits.</p>
    </div>
  </div>
  <div class="container">
    <ul class="bz-mk-roadmap mt-28">
      ${ROADMAP.map(r => html`<li><span>${r}</span><span class="chip">Coming soon</span></li>`)}
    </ul>
  </div>
</section>
<section class="section section-soft" id="business-form" aria-labelledby="bz-form-title">
  <div class="container split split-top">
    <div>
      <p class="eyebrow">Talk to us</p>
      <h2 id="bz-form-title" class="section-title">Talk to us about Tripelyx Business.</h2>
      <p class="section-lead">Tell us about your company and how your team travels for work.</p>
      <ul class="checklist">
        <li>${icon('mail')}<span>Or email <a href="mailto:${BUSINESS_EMAIL}">${BUSINESS_EMAIL}</a>.</span></li>
      </ul>
    </div>
    ${leadForm('business')}
  </div>
</section>`;
  return layout({ title: 'Business', description: 'Tripelyx Business: company travel with your travel policy, approvals and department budgets built in.', active: 'business', body, ctx, scripts: ['/js/forms.js'], styles: ['/css/business-marketing.css'], bodyClass: 'bz-mk-page', corporate: true });
}

module.exports = { businessMarketingView, ROADMAP };
