// Our Brands, Technology, Partners, About and Contact. No reference screenshots exist for these yet,
// so they are composed from the homepage's own components and rhythm.
const { html } = require('../lib/html');
const { icon } = require('./icons');
const { layout } = require('./layout');
const { alameinGoWordmark, devices, WHY, TILES } = require('./home');

function pageHero({ eyebrow, title, accent, lead, actions }) {
  return html`<section class="page-hero"><div class="container"><div class="page-hero-inner">
    <p class="eyebrow eyebrow-light">${eyebrow}</p>
    <h1>${title}${accent ? html` <span class="accent">${accent}</span>` : ''}</h1>
    <p class="lead">${lead}</p>
    ${actions ? html`<div class="hero-actions">${actions}</div>` : ''}
  </div></div></section>`;
}

function partnerBand() {
  return html`<section class="partner-band" aria-labelledby="partner-title">
  <div class="container partner-inner">
    <div>
      <p class="eyebrow eyebrow-light">Partner with us</p>
      <h2 id="partner-title" class="partner-title">Let’s build the future of travel — together.</h2>
      <p class="partner-text">We work with property owners, transport companies, activity providers and destinations to create powerful travel experiences.</p>
    </div>
    <a class="btn btn-white btn-lg" href="/partners#partner-form">Become a Partner ${icon('arrow')}</a>
  </div>
</section>`;
}

function brandsView(ctx) {
  const body = html`
${pageHero({ eyebrow: 'Our Brands', title: 'Unique destinations.', accent: 'Powerful platforms.', lead: 'Each Tripelyx brand is a complete booking platform built around one destination — local inventory, local partners and a single place for travelers to plan everything.' })}
<section class="section brands-section">
  <div class="container">
    <article class="brand-card">
      <div class="brand-card-media" aria-hidden="true"></div>
      <div class="brand-card-body">
        <h2 class="brand-logo">${alameinGoWordmark()}</h2>
        <p class="brand-tagline">Everything Alamein. One place.</p>
        <p class="brand-text">Book stays, cars, transfers, yachts and experiences in New Alamein and the North Coast.</p>
        <a class="btn btn-navy btn-lg" href="${ctx.alameinGoUrl}">Visit Alamein Go ${icon('arrow')}</a>
      </div>
      <ul class="vertical-tiles" aria-label="Book with Alamein Go">
        ${TILES.map(t => html`<li><a class="vertical-tile" href="/book/${t.v}">${icon(t.icon)}<span>${t.label}</span></a></li>`)}
      </ul>
    </article>
  </div>
</section>
<section class="section section-soft">
  <div class="container">
    <p class="eyebrow">What every brand gets</p>
    <h2 class="section-title">One platform, many destinations.</h2>
    <p class="section-lead">New destination brands launch on the same proven stack, so travelers get the same quality everywhere and partners plug in once.</p>
    <div class="grid-3">
      <div class="card"><span class="card-icon">${icon('layers')}</span><h3>Every vertical</h3><p>Stays, flights, cars, cruises, yachts, transfers, activities and experiences in one checkout.</p></div>
      <div class="card"><span class="card-icon">${icon('users')}</span><h3>Local partners first</h3><p>Destination brands are built with local owners, operators and guides, not just global wholesalers.</p></div>
      <div class="card"><span class="card-icon">${icon('shield')}</span><h3>Trusted payments</h3><p>Secure, processor-agnostic checkout with clear cancellation rules on every booking.</p></div>
    </div>
  </div>
</section>
<section class="section">
  <div class="container split">
    <div>
      <p class="eyebrow">Coming next</p>
      <h2 class="section-title">More destinations on the way.</h2>
      <p class="section-lead">We’re working with tourism boards and developers on the next Tripelyx destination brands. If you run a destination, we’d love to talk.</p>
      <a class="btn btn-navy btn-lg" href="/partners#partner-form">Launch a destination brand ${icon('arrow')}</a>
    </div>
    <div class="split-media" role="img" aria-label="White-sand beach and turquoise sea on the Mediterranean coast"></div>
  </div>
</section>
${partnerBand()}`;
  return layout({ title: 'Our Brands', active: 'brands', body, ctx });
}

function technologyView(ctx) {
  const verticals = [
    ['bed', 'Stays', 'Hotels, apartments, villas and chalets with room-level rates, taxes and cancellation rules.'],
    ['plane', 'Flights', 'Airline itineraries with segments, cabins, fare families and baggage allowances.'],
    ['car', 'Cars', 'Rental classes from multiple suppliers, pick-up and drop-off, protection packages.'],
    ['ship', 'Cruises', 'Ships, itineraries, ports, sailing dates and cabin categories.'],
    ['yacht', 'Yachts', 'Charters by the half day, full day or sunset, with capacity and crew.'],
    ['bus', 'Transfers', 'Private and shared transfers priced by route and vehicle.'],
    ['flag', 'Activities', 'Time-slotted tickets with meeting points and live capacity.'],
    ['palm', 'Experiences', 'Curated local experiences, from dinners at sea to desert nights.'],
  ];
  const body = html`
${pageHero({ eyebrow: 'Our Technology', title: 'A complete travel commerce platform', accent: 'for modern destinations.', lead: 'Tripelyx provides the technology, infrastructure and expertise to launch and grow travel platforms — from accommodations and transport to activities and beyond.', actions: html`<a class="btn btn-white btn-lg" href="/book">Try the booking demo ${icon('arrow')}</a><a class="btn btn-outline-white btn-lg" href="/partners#partner-form">Talk to us</a>` })}
<section class="section">
  <div class="container split">
    <div>
      <p class="eyebrow">Booking engine</p>
      <h2 class="section-title">Search, book and pay — across every vertical.</h2>
      <p class="section-lead">One engine handles search, live pricing, quotes, checkout, payment and cancellation for every kind of travel product.</p>
      <ul class="checklist">
        <li>${icon('check')}<span>Normalized offers, so every supplier looks the same to travelers.</span></li>
        <li>${icon('check')}<span>Price locks, clear tax breakdowns and per-product cancellation rules.</span></li>
        <li>${icon('check')}<span>Processor-agnostic payments with a full test mode.</span></li>
      </ul>
    </div>
    <div class="split-media split-tech">${devices()}</div>
  </div>
</section>
<section class="section section-soft">
  <div class="container">
    <p class="eyebrow">Eight verticals</p>
    <h2 class="section-title">Everything a traveler books, in one place.</h2>
    <p class="section-lead">Each vertical sits behind a supplier-neutral interface. Connecting a new supplier means writing one adapter — the booking flow and the apps don’t change.</p>
    <div class="grid-4">
      ${verticals.map(([i, t, d]) => html`<div class="card"><span class="card-icon">${icon(i)}</span><h3>${t}</h3><p>${d}</p></div>`)}
    </div>
  </div>
</section>
<section class="section">
  <div class="container">
    <p class="eyebrow">Built for production</p>
    <h2 class="section-title">Secure by default.</h2>
    <div class="grid-3 mt-28">
      <div class="card"><span class="card-icon">${icon('plug')}</span><h3>Supplier adapters</h3><p>Hotels, airlines, rental companies and local operators connect through adapters that map their APIs to one model.</p></div>
      <div class="card"><span class="card-icon">${icon('lock')}</span><h3>No secrets in the browser</h3><p>Supplier and payment credentials live only on the server, per environment, never in front-end code.</p></div>
      <div class="card"><span class="card-icon">${icon('layers')}</span><h3>Separate environments</h3><p>Development, staging and production each run on their own database and credentials.</p></div>
    </div>
  </div>
</section>
${partnerBand()}`;
  return layout({ title: 'Technology', active: 'technology', body, ctx });
}

function partnersView(ctx) {
  const types = [
    ['bed', 'Property owners', 'List apartments, chalets, villas and hotels and reach travelers year-round.'],
    ['bus', 'Transport companies', 'Sell transfers, car rentals and shuttles straight into every trip.'],
    ['flag', 'Activity providers', 'Fill your time slots with real-time availability and instant confirmation.'],
    ['globe', 'Destinations', 'Launch a branded booking platform for your city, resort or region.'],
  ];
  const body = html`
${pageHero({ eyebrow: 'Partners', title: 'Let’s build the future of travel', accent: '— together.', lead: 'We work with property owners, transport companies, activity providers and destinations to create powerful travel experiences.' })}
<section class="section">
  <div class="container">
    <p class="eyebrow">Who we work with</p>
    <h2 class="section-title">Built for partners of every size.</h2>
    <div class="grid-4 mt-28">
      ${types.map(([i, t, d]) => html`<div class="card"><span class="card-icon">${icon(i)}</span><h3>${t}</h3><p>${d}</p></div>`)}
    </div>
  </div>
</section>
<section class="section section-soft" id="partner-form">
  <div class="container split">
    <div>
      <p class="eyebrow">Become a partner</p>
      <h2 class="section-title">Tell us about your business.</h2>
      <p class="section-lead">Share a few details and our partnerships team will get back to you.</p>
      <ul class="checklist">
        ${WHY.map(w => html`<li>${icon('check')}<span><b>${w.title}.</b> ${w.text}</span></li>`)}
      </ul>
    </div>
    ${leadForm('partner')}
  </div>
</section>`;
  return layout({ title: 'Partners', active: 'partners', body, ctx, scripts: ['/js/forms.js'] });
}

function leadForm(kind) {
  return html`<form class="form-card form" data-lead-form novalidate>
    <div class="form-row">
      <div class="field"><label for="lf-name">Your name</label><input id="lf-name" name="name" autocomplete="name" required maxlength="100"><p class="field-error" data-error-for="name"></p></div>
      <div class="field"><label for="lf-company">Company</label><input id="lf-company" name="company" autocomplete="organization" maxlength="120"></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="lf-email">Email</label><input id="lf-email" name="email" type="email" autocomplete="email" required maxlength="120"><p class="field-error" data-error-for="email"></p></div>
      <div class="field"><label for="lf-type">${kind === 'partner' ? 'Partnership type' : 'Topic'}</label>
        <select id="lf-type" name="type">${(kind === 'partner'
          ? ['Property owner', 'Transport company', 'Activity provider', 'Destination', 'Other']
          : ['General enquiry', 'Partnerships', 'Press', 'Careers', 'Booking support']).map(o => html`<option>${o}</option>`)}</select></div>
    </div>
    <div class="field"><label for="lf-message">Message</label><textarea id="lf-message" name="message" required maxlength="2000"></textarea><p class="field-error" data-error-for="message"></p></div>
    <div class="sr-only" aria-hidden="true"><label for="lf-website">Website</label><input id="lf-website" name="website" tabindex="-1" autocomplete="off"></div>
    <div data-form-status role="status" aria-live="polite"></div>
    <button class="btn btn-navy btn-lg" type="submit"><span class="btn-label">Send message</span> ${icon('arrow')}</button>
    <noscript><p class="alert alert-info">This form needs JavaScript. You can also reach us by email.</p></noscript>
  </form>`;
}

function aboutView(ctx) {
  const body = html`
${pageHero({ eyebrow: 'About Tripelyx', title: 'Travel technology.', accent: 'Real places.', lead: 'We build the platforms that connect travelers with the destinations they love and the local businesses that make those places special.' })}
<section class="section">
  <div class="container split">
    <div>
      <p class="eyebrow">Our story</p>
      <h2 class="section-title">Bigger possibilities for real places.</h2>
      <p class="section-lead">Tripelyx started on Egypt’s Mediterranean coast, where a new city was opening faster than travelers could find what it had to offer. We built Alamein Go to put every stay, ride, boat and experience in one place — and built it on a platform any destination can use.</p>
    </div>
    <div class="split-media" role="img" aria-label="The New Alamein coastline"></div>
  </div>
</section>
<section class="section section-soft">
  <div class="container">
    <p class="eyebrow eyebrow-center">What we believe</p>
    <h2 class="section-title section-title-center">Built for travelers. Designed for partners.</h2>
    <ul class="why-grid mt-36">
      ${WHY.map(w => html`<li class="why-item"><span class="why-icon">${icon(w.icon)}</span><span><b>${w.title}</b><span>${w.text}</span></span></li>`)}
    </ul>
  </div>
</section>
${partnerBand()}`;
  return layout({ title: 'About', active: 'about', body, ctx });
}

function contactView(ctx) {
  const body = html`
${pageHero({ eyebrow: 'Contact', title: 'Let’s talk.', lead: 'Questions about our brands, our technology or a partnership? Send us a message and the right person will reply.' })}
<section class="section">
  <div class="container split split-top">
    <div>
      <h2 class="section-title">Get in touch</h2>
      <p class="section-lead">For help with an existing booking, use <a href="/manage">Manage booking</a> with your reference and email.</p>
      <ul class="checklist">
        <li>${icon('pin')}<span>New Alamein, North Coast, Egypt</span></li>
        ${ctx.config.contactEmail ? html`<li>${icon('mail')}<span><a href="mailto:${ctx.config.contactEmail}">${ctx.config.contactEmail}</a></span></li>` : ''}
        <li>${icon('clock')}<span>Sunday–Thursday, 9:00–18:00 (Cairo)</span></li>
      </ul>
    </div>
    ${leadForm('contact')}
  </div>
</section>`;
  return layout({ title: 'Contact', active: 'contact', body, ctx, scripts: ['/js/forms.js'] });
}

module.exports = { brandsView, technologyView, partnersView, aboutView, contactView, pageHero };
