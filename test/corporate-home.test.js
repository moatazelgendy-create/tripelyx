// "/" is the corporate homepage, with Travel by Budget on or off; the AI travel agent's homepage lives at
// /ai-travel-agent, and every link of the AI product that led to its homepage leads there.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { addDays, today } = require('../server/lib/dates');

// The live site: a staging build with trips and demo inventory on, payments in test mode, behind HTTPS.
const LIVE = { APP_ENV: 'staging', ENABLE_TRIPS: 'true', ALLOW_DEMO_INVENTORY: 'true', PAYMENT_MODE: 'test', DATABASE_URL: 'memory', PUBLIC_BASE_URL: 'https://www.tripelyx.com' };
const live = () => startApp(LIVE, { store: new MemoryStore() });

const CORPORATE = [['/', null], ['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const CORPORATE_NAV = [['/', 'Home'], ['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const TRIP_NAV = [['/plan', 'Build My Trip'], ['/how-it-works', 'How It Works'], ['/destinations', 'Destinations'], ['/my-trips', 'My Trips'], ['/faq', 'Help']];
const AI_HEADINGS = [
  ['tb-example-title', '“I have $1,500 for 2 people, from San Francisco, 5 nights, beach. The hotel matters most.”'],
  ['tb-levels-title', 'Where can your budget take you?'],
  ['tb-how-title', 'Stop searching. Tell your travel agent.'],
  ['tb-ways-title', 'Start from a budget, a destination, or a trip you already found.'],
  ['tb-styles-title', 'What kind of trip sounds good?'],
];
const QUERY = { b: '1500', k: '0', from: 'SFO', who: 'couple', when: 'anytime', nights: '5', style: 'beach', prio: 'hotel' };
const COPYRIGHT = `<p class="copyright">© ${new Date().getFullYear()} Tripelyx Inc. All rights reserved.</p>`;
const BANNER = /<aside class="env-banner" aria-label="Environment notice">/;

const get = async (app, path, { method = 'GET', form } = {}) => {
  const headers = { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' };
  let body;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(app.base + path, { method, headers, body, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), cache: res.headers.get('cache-control'), text: await res.text() };
};
const part = (page, re) => (page.match(re) || [''])[0];
const headerOf = page => part(page, /<header class="site-header[\s\S]*?<\/header>/);
const footerOf = page => part(page, /<footer class="site-footer[\s\S]*?<\/footer>/);
const navOf = page => [...part(headerOf(page), /<ul>[\s\S]*?<\/ul>/).matchAll(/<li><a href="([^"]*)"[^>]*>([^<]*)<\/a><\/li>/g)].map(m => [m[1], m[2]]);
const titleOf = page => (page.match(/<title>([^<]*)<\/title>/) || [])[1];

// The corporate header, footer and title, and no environment banner and no trip styles.
function assertCorporate(path, title, page) {
  assert.equal(page.status, 200, path);
  const header = headerOf(page.text);
  assert.match(header, /^<header class="site-header" data-header>/, `${path}: the corporate header`);
  assert.deepEqual(navOf(page.text), CORPORATE_NAV, `${path}: the corporate navigation`);
  assert.match(header, /<a class="header-logo" href="\/" aria-label="Tripelyx home">/, `${path}: the logo leads to the corporate homepage`);
  assert.match(header, /<a class="btn btn-navy btn-sm header-cta" href="\/partners#partner-form">Partner With Us /, `${path}: the Partner With Us pill`);
  assert.doesNotMatch(header, /Sign in|\/signin|\/my-trips/, `${path}: no account area`);
  const footer = footerOf(page.text);
  assert.match(footer, /^<footer class="site-footer">/, `${path}: the corporate footer, not the trip footer`);
  assert.deepEqual([...part(footer, /<nav class="footer-nav"[\s\S]*?<\/nav>/).matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map(m => [m[1], m[2]]), CORPORATE_NAV.slice(1), `${path}: the footer row`);
  assert.match(footer, /<a class="footer-logo" href="\/" aria-label="Tripelyx home">/);
  assert.ok(footer.includes(COPYRIGHT), `${path}: ${COPYRIGHT}`);
  assert.equal(titleOf(page.text), title ? `${title} | Tripelyx` : 'Tripelyx — Travel technology that powers better journeys', `${path}: title`);
  assert.doesNotMatch(page.text, BANNER, `${path}: no environment banner`);
  assert.doesNotMatch(page.text, /\/css\/trips\.css/, `${path}: no trip styles`);
  assert.doesNotMatch(page.text, /LLC/);
}

function assertCorporateHome(page) {
  assert.match(page.text, /<h1 id="hero-title" class="hero-title">Travel technology<br> that powers<br> <span class="accent">better journeys\.<\/span><\/h1>/);
  assert.match(page.text, /Unique destinations\. Powerful platforms\./);
  assert.match(page.text, /A complete travel commerce<br> platform for modern destinations\./);
  assert.match(page.text, /Built for travelers\. Designed for partners\./);
  assert.match(page.text, /Let’s build the future of travel — together\./);
  assert.doesNotMatch(page.text, /How much do you|tb-hero|action="\/agent"|\/js\/trips\.js/, 'the AI travel agent is not on the corporate homepage');
  assert.doesNotMatch(page.text, /home-search|data-tabs|role="tablist"|<form/, 'no booking search on the homepage; it lives on /book');
  assert.deepEqual([...page.text.matchAll(/<a class="vertical-tile" href="([^"]*)">/g)].map(m => m[1]), ['/book/hotels', '/book/cars', '/book/transfers', '/book/yachts', '/book/experiences'], 'the Alamein Go tiles open the booking pages');
}

// The AI travel agent's homepage as main served it at "/": the trip chrome, its title, its headings and forms.
function assertAiHome(page, { banner }) {
  assert.equal(page.status, 200);
  assert.equal(page.cache, 'no-cache');
  assert.match(headerOf(page.text), /^<header class="site-header site-header-trips" data-header>/);
  assert.deepEqual(navOf(page.text), TRIP_NAV);
  assert.match(headerOf(page.text), /<a class="header-logo" href="\/ai-travel-agent" aria-label="Tripelyx home">/);
  assert.match(footerOf(page.text), /^<footer class="site-footer trip-footer">/);
  assert.match(footerOf(page.text), /<a class="footer-logo" href="\/ai-travel-agent" aria-label="Tripelyx home">/);
  assert.ok(footerOf(page.text).includes(COPYRIGHT));
  assert.equal(titleOf(page.text), 'Tripelyx — Tell us what you want your trip to do. The AI builds it.');
  assert.match(page.text, banner);
  assert.match(page.text, /<link rel="stylesheet" href="\/css\/trips\.css\?v=/);
  assert.match(page.text, /<script src="\/js\/trips\.js\?v=[^"]*" defer><\/script>/);
  assert.match(page.text, /<p class="eyebrow eyebrow-light">Your AI travel agent<\/p>/);
  assert.match(page.text, /<h1 id="tb-hero-title" class="tb-hero-title">How much do you<br>want to spend\?<\/h1>/);
  assert.deepEqual([...page.text.matchAll(/<h2 id="(tb-[a-z]+-title)" class="section-title[^"]*">([^<]*)<\/h2>/g)].map(m => [m[1], m[2]]), AI_HEADINGS);
  assert.match(page.text, /<form class="ag-hero-form ag-hero-number" method="post" action="\/agent">/);
  assert.match(page.text, /<form class="tb-way form" action="\/dream" method="get">/);
  assert.match(page.text, /<form class="tb-way form" action="\/challenge" method="get">/);
  assert.match(page.text, /<a class="hu-hero-wait" href="\/hunts\/new">I can wait: let the AI hunt for it<\/a>/);
  assert.match(page.text, /<a class="btn btn-ghost-light" href="#tb-ways-title">I already know where I want to go<\/a>/);
}

test('the live site: "/" is the corporate homepage with the corporate header and footer, /company sends there, and the AI travel agent has its own homepage', async t => {
  const app = await live();
  t.after(app.close);
  assert.ok(app.ctx.trips, 'Travel by Budget is on, as on the live site');

  for (const [path, title] of CORPORATE) assertCorporate(path, title, await get(app, path));
  const home = await get(app, '/');
  assertCorporateHome(home);
  assert.equal(home.cache, 'no-cache');

  const company = await get(app, '/company');
  assert.equal(company.status, 301);
  assert.equal(company.location, '/');

  const events = async () => (await app.store.listRecords('event')).filter(e => e.type === 'home_visit').length;
  assert.equal(await events(), 0, 'the corporate homepage is not an AI homepage visit');
  const ai = await get(app, '/ai-travel-agent');
  assertAiHome(ai, { banner: /<aside class="env-banner" aria-label="Environment notice">Staging build · demo inventory · payments in test mode — no real charges<\/aside>/ });
  assert.match(ai.text, /<link rel="canonical" href="https:\/\/www\.tripelyx\.com\/ai-travel-agent">/);
  assert.equal(await events(), 1, 'the AI homepage visit is tracked as before');
  assert.doesNotMatch(home.text, /rel="canonical"/);

  // The sitemap lists the corporate homepage and the AI travel agent's homepage.
  const sitemap = (await get(app, '/sitemap.xml')).text;
  assert.ok(sitemap.includes('<url><loc>https://www.tripelyx.com/</loc></url>\n  <url><loc>https://www.tripelyx.com/ai-travel-agent</loc></url>\n  <url><loc>https://www.tripelyx.com/how-it-works</loc></url>'), sitemap);
});

test('development: the same corporate pages and the same AI homepage, with the development banner on the AI side only', async t => {
  const app = await startApp();
  t.after(app.close);
  for (const [path, title] of CORPORATE) assertCorporate(path, title, await get(app, path));
  assertCorporateHome(await get(app, '/'));
  assert.deepEqual([(await get(app, '/company')).status, (await get(app, '/company')).location], [301, '/']);
  assertAiHome(await get(app, '/ai-travel-agent'), { banner: /<aside class="env-banner" aria-label="Environment notice">Development build · demo inventory · payments in test mode — no real charges<\/aside>/ });
});

test('every other page keeps the trip header, trip footer and environment banner; the AI pages lead home to /ai-travel-agent', async t => {
  const app = await live();
  t.after(app.close);
  const results = await get(app, `/trips?${new URLSearchParams(QUERY)}`);
  assert.equal(results.status, 200);
  const tripPath = results.text.match(/href="(\/trip\/[^"?#/]+)\?([^"#]*)"/);
  assert.ok(tripPath, 'the results link a trip');
  const trip = `${tripPath[1]}?${tripPath[2].replace(/&amp;/g, '&')}`;
  const paths = ['/plan', '/plan?b=1500', `/trips?${new URLSearchParams(QUERY)}`, trip, '/agent', '/challenge', '/dream?dest=cancun&b=3000&from=NYC', '/how-it-works', '/faq', '/destinations', '/trips-under-1500', '/trips-to-cancun', '/beach-vacations', '/legal/terms', '/custom-trip', '/signin', '/book', '/book/hotels', '/manage', '/nope'];
  for (const path of paths) {
    const page = await get(app, path);
    assert.equal(page.status, path === '/nope' ? 404 : 200, path);
    assert.match(page.text, BANNER, `${path}: the environment banner stays`);
    assert.match(headerOf(page.text), /^<header class="site-header site-header-trips" data-header>/, `${path}: the trip header`);
    assert.deepEqual(navOf(page.text), TRIP_NAV, `${path}: the trip navigation`);
    assert.match(headerOf(page.text), /<a class="header-logo" href="\/ai-travel-agent" aria-label="Tripelyx home">/, `${path}: the logo leads to the AI homepage`);
    assert.match(footerOf(page.text), /^<footer class="site-footer trip-footer">/, `${path}: the trip footer`);
    assert.match(footerOf(page.text), /<a class="footer-logo" href="\/ai-travel-agent" aria-label="Tripelyx home">/, path);
    assert.ok(footerOf(page.text).includes(COPYRIGHT), `${path}: ${COPYRIGHT}`);
    assert.match(page.text, /<link rel="stylesheet" href="\/css\/trips\.css\?v=/, path);
    assert.doesNotMatch(page.text, /href="\/"|href="\/#|href="\/\?|action="\/"/, `${path}: nothing in the AI product leads to the corporate homepage as its home`);
    assert.doesNotMatch(page.text, /LLC/, path);
  }

  // Breadcrumbs: Home is the AI homepage on every page that has them.
  const crumb = '<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/ai-travel-agent">Home</a>';
  const [tokenPath, cx] = [tripPath[1], tripPath[2].replace(/&amp;/g, '&')];
  for (const path of [trip, `${tokenPath}/guide?${cx}`, `${tokenPath}/leaks?${cx}`, `${tokenPath}/memories?${cx}`, `${tokenPath}/optimize?${cx}`, `${tokenPath}/price?${cx}&target=1000`, '/challenge', '/dream?dest=cancun&b=3000&from=NYC']) {
    const page = await get(app, path);
    assert.equal(page.status, 200, path);
    assert.ok(page.text.includes(crumb), `${path}: Home in the breadcrumbs is the AI homepage`);
  }
  const DEPART = addDays(today(), 60);
  const challenge = { dest: 'paris', from: 'nyc', depart: DEPART, nights: '6', who: 'couple', n: '2', total: '3,200', flight: 'stops', stars: '3', meals: 'none', bags: 'carry-on', transfer: 'no', cancel: 'nonrefundable', taxes: 'included' };
  const review = await get(app, `/challenge/review?${new URLSearchParams(challenge)}`);
  assert.ok(review.text.includes(crumb), 'the trip to beat');
  const result = await get(app, `/challenge/result?${new URLSearchParams({ ...challenge, mode: 'less' })}`);
  assert.ok(result.text.includes(crumb), 'the challenge result');
  assert.match(result.text, /<a class="btn btn-(?:navy|ghost)" href="\/ai-travel-agent">Keep my deal<\/a>/, 'Keep my deal goes back to the AI homepage');

  // The 404 page inside the AI product, a dream with no destination, and signing out.
  assert.match((await get(app, '/nope')).text, /<a class="btn btn-navy btn-lg" href="\/ai-travel-agent">Back to home /);
  const dream = await get(app, '/dream');
  assert.deepEqual([dream.status, dream.location], [303, '/ai-travel-agent#tb-dream-title']);
  const signout = await get(app, '/signout', { method: 'POST', form: {} });
  assert.deepEqual([signout.status, signout.location], [303, '/ai-travel-agent']);
});

test('Our Brands lists the Tripelyx AI Travel Agent as a brand card next to Alamein Go and links to it, only where it runs', async t => {
  const app = await live();
  t.after(app.close);
  const card = /<article class="brand-card brand-card-ai">\s*<div class="brand-card-media" aria-hidden="true"><svg class="icon"[^>]*><use href="#i-sparkle"\/><\/svg><\/div>\s*<div class="brand-card-body">\s*<h2 class="brand-logo"><span class="ai-wordmark">Tripelyx <span>AI Travel Agent<\/span><\/span><\/h2>\s*<p class="brand-tagline">Tell us what you want your trip to do\. The AI builds it\.<\/p>\s*<p class="brand-text">One number\. The agent finds where, when, how long, which flight and which hotel, builds three different vacations for it, and asks you only when it needs a real decision\.<\/p>\s*<a class="btn btn-navy btn-lg" href="\/ai-travel-agent">Tell us your budget /;
  const brands = (await get(app, '/brands')).text;
  assert.match(brands, card);
  assert.deepEqual(brands.match(/<article class="brand-card[^"]*">/g), ['<article class="brand-card">', '<article class="brand-card brand-card-ai">'], 'the second brand card, after Alamein Go');
  assert.ok(brands.indexOf('Visit Alamein Go') < brands.indexOf('brand-card-ai'), 'listed after Alamein Go');
  assert.equal(brands.match(/href="\/ai-travel-agent"/g).length, 1, 'one link to it on Our Brands');
  for (const path of ['/', '/technology', '/partners', '/about', '/contact']) assert.doesNotMatch((await get(app, path)).text, /ai-travel-agent|AI Travel Agent/, `${path}: the AI travel agent is only on Our Brands`);

  const off = await startApp({ ENABLE_TRIPS: 'false' });
  t.after(off.close);
  assert.equal(off.ctx.trips, false);
  for (const [path, title] of CORPORATE) {
    const page = await get(off, path);
    assertCorporate(path, title, page);
    assert.doesNotMatch(page.text, /ai-travel-agent|AI Travel Agent/, `${path}: nothing links to a product that is off`);
  }
  assertCorporateHome(await get(off, '/'));
  assert.deepEqual([(await get(off, '/company')).status, (await get(off, '/company')).location], [301, '/']);
  assert.equal((await get(off, '/ai-travel-agent')).status, 404);
  const book = await get(off, '/book');
  assert.match(book.text, BANNER, 'the booking pages keep the banner');
  assert.match(headerOf(book.text), /^<header class="site-header" data-header>/);
  assert.ok(footerOf(book.text).includes(COPYRIGHT));
  assert.match((await get(off, '/nope')).text, /<a class="btn btn-navy btn-lg" href="\/">Back to home /);
});

test('the laptop and phone picture on Home and Technology shows the coming summer\'s dates and no sample price or rating', async t => {
  const { sampleStayYear } = require('../server/views/home');
  assert.equal(sampleStayYear(new Date('2026-10-09T09:00:00Z')), 2027, 'after this summer: next summer');
  assert.equal(sampleStayYear(new Date('2027-03-01T00:00:00Z')), 2027, 'before the summer: this summer');
  assert.equal(sampleStayYear(new Date('2027-07-14T23:59:00Z')), 2027, 'the day before: this summer');
  assert.equal(sampleStayYear(new Date('2027-07-15T00:00:00Z')), 2028, 'from Jul 15: next summer, never a check-in that is already past');
  assert.equal(sampleStayYear(new Date('2028-12-31T23:59:00Z')), 2029);

  const app = await live();
  t.after(app.close);
  const year = sampleStayYear(app.ctx.now());
  for (const path of ['/', '/technology']) {
    const devices = part((await get(app, path)).text, /<div class="devices" aria-hidden="true">[\s\S]*?<div class="phone-btn">Book Now<\/div>/);
    assert.ok(devices, `${path}: the picture is there`);
    assert.ok(devices.includes(`<small>Check in</small><b>Jul 15, ${year}</b>`) && devices.includes(`<small>Check out</small><b>Jul 20, ${year}</b>`), `${path}: Jul 15 to 20, ${year}`);
    assert.match(devices, /<div class="phone-title">Luxury Beach Apartment<\/div>\s*<div class="phone-place"><svg class="icon"[^>]*><use href="#i-pin"\/><\/svg> New Alamein, North Coast<\/div>\s*<div class="phone-stay"><b>5 nights<\/b> · 2 guests<\/div>/);
    assert.doesNotMatch(devices, /2025|\$|review|rating|night<|i-star/, `${path}: no past dates, prices or ratings`);
  }

  // The year comes from the app's clock on both pages, not from the calendar the code was written in.
  const later = await startApp(LIVE, { store: new MemoryStore(), now: () => new Date('2028-03-01T12:00:00Z') });
  t.after(later.close);
  for (const path of ['/', '/technology']) assert.ok((await get(later, path)).text.includes('<small>Check in</small><b>Jul 15, 2028</b>'), `${path}: the clock's year`);
});

test('the AI travel agent homepage claims no booking activity it cannot show', async t => {
  const app = await live();
  t.after(app.close);
  const ai = (await get(app, '/ai-travel-agent')).text;
  assert.ok(ai.includes('<b>5-night beach trips under $1,500</b><span>Five nights by the sea</span>'));
  assert.doesNotMatch(ai, /most-built|most popular|most booked/i);
});
