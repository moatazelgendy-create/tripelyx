const { html, raw } = require('../lib/html');
const { icon } = require('./icons');
const { layout } = require('./layout');
const { today } = require('../lib/dates');

// "ALAMEIN GO" wordmark: typeset, with the two-stroke wave under GO.
function alameinGoWordmark() {
  return html`<span class="ag-wordmark" role="img" aria-label="Alamein Go">
    <span class="ag-alamein" aria-hidden="true">ALAMEIN</span>
    <span class="ag-go" aria-hidden="true">GO<svg class="ag-wave" viewBox="0 0 96 24" aria-hidden="true"><path d="M3.5 7c8.5-.5 18.5 3 27.5 3.2 8 .2 13-6.7 21-6.4 4 .2 7 1.4 9 2.8-6 .4-12 2.9-19 6.2-6 2.8-13 3.6-20 1.8C15 12.8 9 9.2 3.5 7z" fill="currentColor"/><path d="M34 19c10-1.4 20-4.5 29-9 7-3.6 13-7.4 19-7 4 .2 7 1.6 9.5 3.6-7.5.8-13.5 4-21.5 8.4-9 4.8-20 6-36 4z" fill="currentColor"/></svg></span>
  </span>`;
}

const TILES = [
  { v: 'hotels', label: 'Stays', icon: 'bed-solid' },
  { v: 'cars', label: 'Cars', icon: 'car' },
  { v: 'transfers', label: 'Transfers', icon: 'bus' },
  { v: 'yachts', label: 'Yachts', icon: 'yacht-solid' },
  { v: 'experiences', label: 'Experiences', icon: 'island' },
];

const WHY = [
  { icon: 'rocket', title: 'Modern Technology', text: 'Scalable, flexible and built for growth.' },
  { icon: 'globe', title: 'Global Reach', text: 'Connect to travelers worldwide.' },
  { icon: 'users', title: 'Local Impact', text: 'Empower destinations and local businesses.' },
  { icon: 'chart', title: 'Long-Term Value', text: 'More bookings, stronger partnerships.' },
];

// The sample stay in the device mockup: Jul 15 to 20, two guests, in the coming North Coast summer,
// so its dates are never in the past. The mockup is an illustration, not an offer, so it shows no
// price and no rating.
function sampleStayYear(now = new Date()) {
  const year = now.getUTCFullYear();
  return today(now) <= `${year}-07-15` ? year : year + 1;
}

// The laptop + phone composition in the Technology section is live HTML (a miniature of the real
// booking UI), not a screenshot, so it stays crisp at every size.
function devices(now) {
  const year = sampleStayYear(now);
  return html`
<div class="devices" aria-hidden="true">
  <div class="laptop">
    <div class="laptop-lid">
      <div class="laptop-screen">
        <div class="mini-photo"></div>
        <div class="mini-search">
          <div class="mini-title">Find your next stay</div>
          <div class="mini-tabs">
            <span class="on">${icon('bed')}Stays</span><span>${icon('car')}Cars</span><span>${icon('bus')}Transfers</span><span>${icon('yacht')}Yachts</span><span>${icon('palm')}Experiences</span>
          </div>
          <div class="mini-field mini-where"><small>Where are you going?</small><b>New Alamein</b>${icon('pin')}</div>
          <div class="mini-row">
            <div class="mini-field"><small>Check in</small><b>Jul 15, ${year}</b></div>
            <div class="mini-field"><small>Check out</small><b>Jul 20, ${year}</b></div>
            <div class="mini-field"><small>Guests</small><b>2 Guests</b></div>
          </div>
          <div class="mini-btn">Search</div>
        </div>
      </div>
    </div>
    <div class="laptop-base"></div>
  </div>
  <div class="phone">
    <div class="phone-screen">
      <div class="phone-notch"></div>
      <div class="phone-bar"><span>${icon('arrow-left')}</span><i></i><span>${icon('user')}</span></div>
      <div class="phone-photo"></div>
      <div class="phone-title">Luxury Beach Apartment</div>
      <div class="phone-place">${icon('pin')} New Alamein, North Coast</div>
      <div class="phone-stay"><b>5 nights</b> · 2 guests</div>
      <div class="phone-btn">Book Now</div>
    </div>
  </div>
</div>`;
}

function homeView(ctx) {
  const body = html`
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-media" role="img" aria-label="Aerial view of New Alamein: towers, beach and turquoise water on the Mediterranean coast"></div>
  <div class="container hero-inner">
    <p class="eyebrow eyebrow-light">Travel technology. Real places. Bigger possibilities.</p>
    <h1 id="hero-title" class="hero-title">Travel technology<br> that powers<br> <span class="accent">better journeys.</span></h1>
    <p class="hero-lead">Tripelyx builds travel platforms and technology that connects travelers, destinations and local businesses across the world.</p>
    <div class="hero-actions">
      <a class="btn btn-white btn-lg" href="/brands">Our Brands ${icon('arrow')}</a>
      <a class="btn btn-outline-white btn-lg" href="/partners">Partner With Us</a>
    </div>
    <div class="location-chip">${icon('pin')}<span><b>New Alamein</b><small>Egypt</small></span></div>
  </div>
</section>

<section class="brands-section" aria-labelledby="brands-title">
  <div class="container">
    <div class="section-head">
      <div>
        <p class="eyebrow">Our Brands</p>
        <h2 id="brands-title" class="section-title">Unique destinations. Powerful platforms.</h2>
      </div>
      <a class="text-link" href="/brands">View All Brands ${icon('arrow')}</a>
    </div>
    <article class="brand-card">
      <div class="brand-card-media" aria-hidden="true"></div>
      <div class="brand-card-body">
        <h3 class="brand-logo">${alameinGoWordmark()}</h3>
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

<section class="tech-section" aria-labelledby="tech-title">
  <div class="container tech-inner">
    <div class="tech-copy">
      <p class="eyebrow">Our Technology</p>
      <h2 id="tech-title" class="section-title">A complete travel commerce<br> platform for modern destinations.</h2>
      <p class="section-lead">Tripelyx provides the technology, infrastructure and expertise to launch and grow travel platforms — from accommodations and transport to activities and beyond.</p>
      <a class="btn btn-navy btn-lg" href="/technology">Explore Our Technology ${icon('arrow')}</a>
    </div>
    ${devices(ctx.now && ctx.now())}
  </div>
</section>

<section class="why-section" aria-labelledby="why-title">
  <div class="container">
    <p class="eyebrow eyebrow-center">Why work with Tripelyx</p>
    <h2 id="why-title" class="section-title section-title-center">Built for travelers. Designed for partners.</h2>
    <ul class="why-grid">
      ${WHY.map(w => html`<li class="why-item"><span class="why-icon">${icon(w.icon)}</span><span><b>${w.title}</b><span>${w.text}</span></span></li>`)}
    </ul>
  </div>
</section>

<section class="partner-band" aria-labelledby="partner-title">
  <div class="container partner-inner">
    <div>
      <p class="eyebrow eyebrow-light">Partner with us</p>
      <h2 id="partner-title" class="partner-title">Let’s build the future of travel — together.</h2>
      <p class="partner-text">We work with property owners, transport companies, activity providers and destinations to create powerful travel experiences.</p>
    </div>
    <a class="btn btn-white btn-lg" href="/partners#partner-form">Become a Partner ${icon('arrow')}</a>
  </div>
</section>`;
  return layout({
    active: 'home', body, corporate: true, bodyClass: 'home',
    ctx: { ...ctx, preload: raw('<link rel="preload" as="image" href="/img/home-hero.webp" imagesrcset="/img/home-hero.webp 1x, /img/home-hero-2x.webp 2x" fetchpriority="high">') },
  });
}

module.exports = { homeView, alameinGoWordmark, devices, sampleStayYear, WHY, TILES };
