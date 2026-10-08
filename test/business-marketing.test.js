// /business, the Tripelyx Business company page, and the "Business" item in both menus (plan §B, §C Public, §C SEO).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser } = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { layout } = require('../server/views/layout');
const { LEAD_TYPES } = require('../server/views/pages');
const { STEPS, FEATURES, HONEST, ROADMAP } = require('../server/views/business/marketing');

const now = () => new Date(FIXED_NOW);
const LIVE = { APP_ENV: 'staging', ENABLE_TRIPS: 'true', ALLOW_DEMO_INVENTORY: 'true', PAYMENT_MODE: 'test', DATABASE_URL: 'memory', PUBLIC_BASE_URL: 'https://www.tripelyx.com' };
const CORPORATE_NAV = [['/', 'Home'], ['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/business', 'Business'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const CORPORATE_FOOTER = [['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const BUSINESS_TYPES = ['Travel agency', 'Independent travel advisor', 'Host agency or consortium', 'Travel creator', 'Employer or benefits platform', 'Bank or rewards program', 'Other'];
// The same list as test/experience-pages.test.js, plus what the plan rules out for this page.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const NO_CLAIMS = /testimonial|trusted by|rated \d|\d[\d,]*\+?\s*(agencies|advisors|partners|customers|clients|bookings)|ai-travel-agent|AI Travel Agent|★/i;

const get = async (app, path, cookie) => {
  const res = await fetch(app.base + path, { headers: { 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) }, redirect: 'manual' });
  return { status: res.status, text: await res.text() };
};
const part = (page, re) => (page.match(re) || [''])[0];
const headerOf = page => part(page, /<header class="site-header[\s\S]*?<\/header>/);
const footerOf = page => part(page, /<footer class="site-footer[\s\S]*?<\/footer>/);
const mainOf = page => part(page, /<main id="main"[\s\S]*?<\/main>/);
const navOf = page => [...part(headerOf(page), /<ul>[\s\S]*?<\/ul>/).matchAll(/<li><a href="([^"]*)"[^>]*>([^<]*)<\/a><\/li>/g)].map(m => [m[1], m[2]]);
const textOf = page => page.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

function assertCorporateBusiness(page) {
  assert.equal(page.status, 200);
  const header = headerOf(page.text);
  assert.match(header, /^<header class="site-header" data-header>/, 'the corporate header');
  assert.deepEqual(navOf(page.text), CORPORATE_NAV);
  assert.match(header, /<li><a href="\/business" aria-current="page">Business<\/a><\/li>/, 'Business is the current page');
  assert.equal((header.match(/aria-current/g) || []).length, 1);
  const footer = footerOf(page.text);
  assert.match(footer, /^<footer class="site-footer">/, 'the corporate footer');
  assert.deepEqual([...part(footer, /<nav class="footer-nav"[\s\S]*?<\/nav>/).matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map(m => [m[1], m[2]]), CORPORATE_FOOTER);
  assert.match(page.text, /<title>Business \| Tripelyx<\/title>/);
  assert.doesNotMatch(page.text, /\/css\/trips\.css/, 'no trip styles');
  assert.doesNotMatch(page.text, /<aside class="env-banner"/, 'no environment banner');
  assert.match(page.text, /<link rel="stylesheet" href="\/css\/business-marketing\.css\?v=[^"]+">/);
  assert.match(page.text, /<script src="\/js\/forms\.js\?v=[^"]+" defer><\/script>/);
  assert.doesNotMatch(page.text, /\sstyle="/, 'no inline style attributes');
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/, 'no inline scripts');

  const main = mainOf(page.text);
  const text = textOf(main);
  assert.match(main, /<p class="eyebrow eyebrow-light">Tripelyx Business<\/p>\s*<h1>Budget Trip Engine <span class="accent">for Business<\/span><\/h1>\s*<p class="lead">Give your customers a budget-first travel experience without building the technology from scratch\.<\/p>/);
  for (const line of ['Three ways to use it.', '“I have $2,000. Where can I go?”', '“My client has $2,000. Build me 3 strong options.”', '“Send us a budget. We return bookable trip possibilities.”', 'How advisor mode works.', ...STEPS, ...FEATURES.flatMap(([, t, d]) => [t, d]), 'Honest by design', ...HONEST, 'On the roadmap', 'Talk to us about Tripelyx Business.']) {
    assert.ok(text.includes(line), `the page says: ${line}`);
  }
  assert.equal(STEPS.length, 5);
  assert.equal(FEATURES.length, 6);
  // Every roadmap item carries its own Coming soon chip, with no dates.
  const roadmap = part(main, /<ul class="bz-mk-roadmap">[\s\S]*?<\/ul>/);
  assert.deepEqual([...roadmap.matchAll(/<li><span>([^<]*)<\/span><span class="chip">Coming soon<\/span><\/li>/g)].map(m => m[1]), ROADMAP);
  assert.doesNotMatch(textOf(roadmap), /\b20\d\d\b|\b(?:Q[1-4]|spring|summer|autumn|fall|winter|January|February|March|April|May|June|July|August|September|October|November|December)\b/i, 'no dates on the roadmap');
  assert.match(text, /Partner API “Send us a budget\. We return bookable trip possibilities\.” .* Coming soon/);
  // The form: id business-form, the business types, and the confirmed email.
  const form = part(main, /<section class="section section-soft" id="business-form"[\s\S]*?<\/section>/);
  assert.ok(form, 'the #business-form section');
  assert.match(form, /<form class="form-card form" data-lead-form novalidate>/);
  assert.match(form, /<label for="lf-type">Business type<\/label>/);
  assert.deepEqual([...form.matchAll(/<option>([^<]*)<\/option>/g)].map(m => m[1]), BUSINESS_TYPES);
  assert.match(form, /Or email <a href="mailto:go@tripelyx\.com">go@tripelyx\.com<\/a>\./);

  // Honest copy: no pressure, no claims, no AI Travel Agent, no em-dashes, no phone, address or prices of our own.
  assert.doesNotMatch(text, PRESSURE);
  assert.doesNotMatch(page.text, NO_CLAIMS);
  assert.doesNotMatch(text, /—/, 'no em-dashes in the copy');
  assert.doesNotMatch(text, /Alamein|Egypt|\+\d|\bLLC\b/, 'no address, phone or other entity');
  assert.deepEqual([...new Set(text.match(/\$[\d,]+/g))], ['$2,000'], 'the only amount is the example budget in the quotes');
  return { main, text };
}

test('/business is a corporate page with the plan\'s copy; with Business running it links the workspace', async t => {
  const app = await startApp(LIVE, { store: new MemoryStore(), now });
  t.after(app.close);
  assert.ok(app.ctx.trips && app.ctx.business, 'trips and Business run, as on the live site');
  const page = await get(app, '/business');
  const { main, text } = assertCorporateBusiness(page);
  assert.match(main, /<div class="hero-actions"><a class="btn btn-white btn-lg" href="\/business\/app">Open your agency workspace <svg[\s\S]*?<\/svg><\/a><a class="btn btn-outline-white btn-lg" href="#business-form">Talk to us<\/a><\/div>/);
  assert.equal((main.match(/href="\/business\/app"/g) || []).length, 1);
  assert.match(text, /Advisors “My client has \$2,000\. Build me 3 strong options\.” .* Available now Partner API/, 'advisor mode is available');
  assert.match(text, /Travelers “I have \$2,000\. Where can I go\?” .* Available now Advisors/);
  assert.ok(text.includes('Today: proposals and client approvals. Booking and secure payment through Tripelyx Business are not open yet; an approved proposal is your client’s choice, not a booking. New agency workspaces are reviewed by our team before client sharing is turned on.'));
  assert.ok(text.includes('This preview runs on demo inventory: sample trips and prices, clearly labeled, that cannot be booked.'), 'the demo note');

  // GET /business stays with the pages router: Business's own routers never swallow it.
  assert.equal((await get(app, '/business/')).status, 200);
  assert.equal((await get(app, '/business?x=1')).status, 200);

  // The form posts to the existing partner leads endpoint with a business type.
  const res = await fetch(app.base + '/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ name: 'Rana', company: 'Blue Door Travel', email: 'rana@example.com', type: 'Employer or benefits platform', message: 'We would like to offer budget trips to our staff.' }) });
  assert.equal(res.status, 201);
  assert.deepEqual((await app.store.listPartnerLeads()).map(l => [l.type, l.company]), [['Employer or benefits platform', 'Blue Door Travel']]);
});

test('/business with self-serve sharing drops the review sentence', async t => {
  const app = await startApp({ BUSINESS_SELF_SERVE: 'true' }, { now });
  t.after(app.close);
  const text = textOf(mainOf((await get(app, '/business')).text));
  assert.ok(text.includes('an approved proposal is your client’s choice, not a booking.'));
  assert.doesNotMatch(text, /reviewed by our team/);
});

test('/business renders with Travel by Budget off and with Business off, and then links no workspace', async t => {
  const off = await startApp({ ENABLE_TRIPS: 'false' }, { now });
  t.after(off.close);
  assert.equal(off.ctx.trips, false);
  assert.ok(!off.ctx.business);
  const page = await get(off, '/business');
  const { main, text } = assertCorporateBusiness(page);
  assert.doesNotMatch(page.text, /\/business\/(app|o\/|start|p\/)/, 'no workspace link');
  assert.match(main, /<div class="hero-actions"><a class="btn btn-white btn-lg" href="#business-form">Talk to us <svg[\s\S]*?<\/svg><\/a><\/div>/);
  assert.doesNotMatch(text, /Available now/);
  assert.equal((text.match(/Coming soon/g) || []).length, 3 + ROADMAP.length, 'every way in and every roadmap item says Coming soon');
  assert.ok(text.includes('Agency workspaces are not open on this site yet.'));
  assert.doesNotMatch(text, /Today: proposals|demo inventory/);
  for (const path of ['/business/app', '/business/p/x', '/business/start']) assert.equal((await get(off, path)).status, 404, path);
  // The corporate pages and the generic header carry Business, once.
  for (const path of ['/', '/brands', '/book', '/nope']) assert.equal((headerOf((await get(off, path)).text).match(/href="\/business"/g) || []).length, 1, path);

  const noBiz = await startApp({ ENABLE_TRIPS: 'true', ENABLE_BUSINESS: 'false' }, { now });
  t.after(noBiz.close);
  assert.ok(noBiz.ctx.trips && !noBiz.ctx.business);
  const page2 = await get(noBiz, '/business');
  const r2 = assertCorporateBusiness(page2);
  assert.doesNotMatch(page2.text, /\/business\/(app|o\/|start|p\/)/, 'no workspace link');
  assert.match(r2.text, /Travelers “I have \$2,000\. Where can I go\?” .* Available now Advisors .* Coming soon Partner API/, 'travelers available, advisors not');
  for (const path of ['/business/app', '/business/p/x', '/business/o/x']) assert.equal((await get(noBiz, path)).status, 404, path);
});

test('"Business" is in both menus exactly once, the trip footer lists Tripelyx Business, and the corporate footer is unchanged', async t => {
  const app = await startApp(LIVE, { store: new MemoryStore(), now });
  t.after(app.close);
  for (const path of ['/', '/brands', '/plan', '/nope', '/how-it-works']) {
    const page = await get(app, path);
    const header = headerOf(page.text);
    assert.equal((header.match(/>Business</g) || []).length, 1, `${path}: Business once in the header`);
    assert.equal((header.match(/href="\/business"/g) || []).length, 1, path);
  }
  const plan = (await get(app, '/plan')).text;
  assert.deepEqual(navOf(plan).at(-1), ['/business', 'Business'], 'last in the trip menu');
  const company = part(footerOf(plan), /<div class="tf-col"><h2>Company<\/h2>[\s\S]*?<\/div>/);
  assert.deepEqual([...company.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map(m => [m[1], m[2]]), [['/about', 'About us'], ['/brands', 'Our brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/business', 'Tripelyx Business'], ['/book', 'Alamein Go booking']]);
  const home = (await get(app, '/')).text;
  assert.deepEqual(navOf(home).slice(2, 5), [['/technology', 'Technology'], ['/business', 'Business'], ['/partners', 'Partners']], 'after Technology, before Partners');
  assert.doesNotMatch(footerOf(home), /business/i, 'the corporate footer has no Business link');
  assert.match(footerOf(home), /<ul><li><a href="\/brands">Our Brands<\/a><\/li><li><a href="\/technology">Technology<\/a><\/li><li><a href="\/partners">Partners<\/a><\/li><li><a href="\/about">About<\/a><\/li><li><a href="\/contact">Contact<\/a><\/li><\/ul>/);
});

test('the account name sits in .header-name, and an admin keeps the Admin link', async t => {
  const app = await startApp({ ...LIVE, ADMIN_EMAILS: 'boss@example.com' }, { store: new MemoryStore(), now });
  t.after(app.close);
  const { cookie } = await seedUser(app, { name: 'Bartholomew-Alexander Fitzgerald', email: 'bart@example.com' });
  const header = headerOf((await get(app, '/plan', cookie)).text);
  assert.match(header, /<a class="btn btn-ghost btn-sm" href="\/my-trips"><svg[\s\S]*?<\/svg> <span class="header-name">Bartholomew-Alexander<\/span><\/a>/);
  assert.doesNotMatch(header, /header-admin/);
  const admin = await seedUser(app, { name: 'Dana Boss', email: 'boss@example.com' });
  const adminHeader = headerOf((await get(app, '/plan', admin.cookie)).text);
  assert.match(adminHeader, /<a class="text-link header-admin" href="\/admin">Admin<\/a>/);
  assert.match(adminHeader, /<span class="header-name">Dana<\/span>/);
  // Escaped like every other interpolation.
  const odd = await seedUser(app, { name: '<b>Eve</b> Smith', email: 'eve@example.com' });
  assert.match(headerOf((await get(app, '/plan', odd.cookie)).text), /<span class="header-name">&lt;b&gt;Eve&lt;\/b&gt;<\/span>/);
});

test('robots keeps crawlers out of /business/ but not /business, and the sitemap lists /business after /contact', async t => {
  const app = await startApp(LIVE, { store: new MemoryStore(), now });
  t.after(app.close);
  const robots = (await get(app, '/robots.txt')).text;
  assert.match(robots, /^Disallow: \/business\/$/m);
  assert.doesNotMatch(robots, /^Disallow: \/business$/m);
  const sitemap = (await get(app, '/sitemap.xml')).text;
  assert.ok(sitemap.includes('<url><loc>https://www.tripelyx.com/contact</loc></url>\n  <url><loc>https://www.tripelyx.com/business</loc></url>\n'), sitemap);
  assert.equal((sitemap.match(/\/business</g) || []).length, 1);
});

test('layout() adds page stylesheets after the site and trip styles; the lead form kinds keep their selects', () => {
  const page = String(layout({ title: 'X', body: '', styles: ['/css/a.css', '/css/b.css'], ctx: { trips: true, assetVersion: '7' } }));
  const at = ['/css/site.css?v=7', '/css/trips.css?v=7', '/css/a.css?v=7', '/css/b.css?v=7'].map(s => page.indexOf(`<link rel="stylesheet" href="${s}">`));
  assert.ok(at.every(i => i > 0) && at.every((v, i) => !i || v > at[i - 1]), `in order: ${at}`);
  const corp = String(layout({ title: 'X', body: '', styles: ['/css/a.css'], ctx: { trips: true }, corporate: true }));
  assert.match(corp, /<link rel="stylesheet" href="\/css\/a\.css\?v=1">/);
  assert.doesNotMatch(corp, /trips\.css/);
  assert.doesNotMatch(String(layout({ title: 'X', body: '', ctx: {} })), /a\.css/);
  assert.deepEqual(LEAD_TYPES.business, ['Business type', BUSINESS_TYPES]);
  assert.deepEqual(LEAD_TYPES.partner[0], 'Partnership type');
  assert.deepEqual(LEAD_TYPES.contact[0], 'Topic');
});

test('the header keeps one line from 1025px with Business added: the band rules measured in the browser stay in place', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = name => fs.readFileSync(path.join(__dirname, '../public/css', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const band = (src, media) => { const at = src.indexOf(media); assert.ok(at >= 0, media); return src.slice(at, src.indexOf('\n}', at)); };
  const trips = css('trips.css');
  assert.match(trips, /^\.header-name \{ display: inline-block; max-width: 9ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/m);
  const tripBand = band(trips, '@media (min-width: 1025px) and (max-width: 1199.98px)');
  for (const rule of ['.site-header-trips .header-inner { gap: 16px; }', '.site-header-trips .main-nav ul { gap: 18px; }', '.site-header-trips .main-nav a { font-size: 14px; }', '.header-account .header-admin { display: none; }']) assert.ok(tripBand.includes(rule), rule);
  const site = css('site.css');
  const bookBand = band(site, '@media (min-width: 1025px) and (max-width: 1279.98px)');
  for (const rule of ['body:not(.corp) .site-header:not(.site-header-trips) .main-nav { padding-left: 0; }', 'body:not(.corp) .site-header:not(.site-header-trips) .main-nav a { font-size: 14px; }']) assert.ok(bookBand.includes(rule), rule);
  // The company pages' header is untouched: nothing in either band reaches .corp.
  assert.doesNotMatch(tripBand + bookBand, /(^|[\s,])\.corp\b/);
});
