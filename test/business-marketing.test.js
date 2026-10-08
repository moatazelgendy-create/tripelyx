// /business, the Tripelyx Business company page (interim copy from Stage 0; Stage 1V rewrites the page and this
// test for plan §B5). It exists only with Business on (ENABLE_BUSINESS=true), as a corporate page, with Travel by
// Budget on or off. The shared chrome (menus, footers, robots, sitemap, header CSS) is tested in
// test/business-chrome.test.js and test/preserve.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser } = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { layout } = require('../server/views/layout');
const { LEAD_TYPES } = require('../server/views/pages');
const { ROADMAP } = require('../server/views/business/marketing');

const now = () => new Date(FIXED_NOW);
const ON = { ENABLE_BUSINESS: 'true' };
const LIVE = { APP_ENV: 'staging', ENABLE_TRIPS: 'true', ALLOW_DEMO_INVENTORY: 'true', PAYMENT_MODE: 'test', DATABASE_URL: 'memory', PUBLIC_BASE_URL: 'https://www.tripelyx.com', ...ON };
const CORPORATE_NAV = [['/', 'Home'], ['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/business', 'Business'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const CORPORATE_FOOTER = [['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const COMPANY_SIZES = ['1-10 people', '11-50 people', '51-200 people', '201-1,000 people', 'More than 1,000 people'];
// The same list as test/experience-pages.test.js, plus what the plan rules out for this page.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const NO_CLAIMS = /testimonial|trusted by|rated \d|\d[\d,]*\+?\s*(agencies|advisors|partners|customers|clients|bookings|companies)|ai-travel-agent|AI Travel Agent|★/i;
// The advisor product this page used to describe, and its claims, are gone (plan §K, W1A row).
const ADVISOR = /advisor|agency|agencies|proposal|your client|markup|commission|real inventory|Budget Trip Engine/i;

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
  assert.match(header, /^<header class="site-header site-header-biz" data-header>/, 'the corporate header, with Business on');
  assert.deepEqual(navOf(page.text), CORPORATE_NAV);
  assert.match(header, /<li><a href="\/business" aria-current="page">Business<\/a><\/li>/, 'Business is the current page');
  assert.equal((header.match(/aria-current/g) || []).length, 1);
  assert.doesNotMatch(header, /Sign in|\/signin|\/my-trips/, 'no sign-in in the corporate header');
  const footer = footerOf(page.text);
  assert.match(footer, /^<footer class="site-footer">/, 'the corporate footer');
  assert.deepEqual([...part(footer, /<nav class="footer-nav"[\s\S]*?<\/nav>/).matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map(m => [m[1], m[2]]), CORPORATE_FOOTER);
  assert.match(page.text, /<title>Business \| Tripelyx<\/title>/);
  assert.doesNotMatch(page.text, /\/css\/trips\.css/, 'no trip styles');
  assert.doesNotMatch(page.text, /<aside class="env-banner"/, 'no environment banner');
  assert.match(page.text, /<link rel="stylesheet" href="\/css\/site\.css\?v=[^"]+">\n<link rel="stylesheet" href="\/css\/business-marketing\.css\?v=[^"]+">\n/, 'the page stylesheet on the trips.css line');
  assert.match(page.text, /<script src="\/js\/forms\.js\?v=[^"]+" defer><\/script>/);
  assert.doesNotMatch(page.text, /\sstyle="/, 'no inline style attributes');
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/, 'no inline scripts');

  const main = mainOf(page.text);
  const text = textOf(main);
  assert.match(main, /<p class="eyebrow eyebrow-light">Tripelyx Business<\/p>\s*<h1>Company travel, with your rules built in\.<\/h1>\s*<p class="lead">Travel policy, approvals and department budgets for your team’s work trips, in one place\. We’re building it now, and we’d like to hear what your company needs\.<\/p>/);
  assert.match(main, /<div class="hero-actions"><a class="btn btn-white btn-lg" href="#business-form">Talk to us <svg[\s\S]*?<\/svg><\/a><\/div>/, 'Talk to us is the only hero action');
  assert.doesNotMatch(page.text, /\/business\/(app|o\/|start|signin|p\/|invite)/, 'no workspace link: none of those pages exist yet');
  for (const line of ['What we’re building.', 'Where it stands today', 'Company workspaces are not open on this site yet, and nothing can be booked or charged through Tripelyx Business.', 'Talk to us about Tripelyx Business.', 'Tell us about your company and how your team travels for work.']) {
    assert.ok(text.includes(line), `the page says: ${line}`);
  }
  // Every roadmap item carries its own Coming soon chip, with no dates.
  const roadmap = part(main, /<ul class="bz-mk-roadmap[^"]*">[\s\S]*?<\/ul>/);
  assert.deepEqual([...roadmap.matchAll(/<li><span>([^<]*)<\/span><span class="chip">Coming soon<\/span><\/li>/g)].map(m => m[1]), ROADMAP);
  assert.doesNotMatch(textOf(roadmap), /\b20\d\d\b|\b(?:Q[1-4]|spring|summer|autumn|fall|winter|January|February|March|April|May|June|July|August|September|October|November|December)\b/i, 'no dates on the roadmap');
  assert.doesNotMatch(text, /Available now/, 'nothing is available yet');
  // The form: id business-form, the company sizes, and the confirmed email.
  const form = part(main, /<section class="section section-soft" id="business-form"[\s\S]*?<\/section>/);
  assert.ok(form, 'the #business-form section');
  assert.match(form, /<form class="form-card form" data-lead-form novalidate>/);
  assert.match(form, /<label for="lf-type">Company size<\/label>/);
  assert.deepEqual([...form.matchAll(/<option>([^<]*)<\/option>/g)].map(m => m[1]), COMPANY_SIZES);
  assert.match(form, /Or email <a href="mailto:go@tripelyx\.com">go@tripelyx\.com<\/a>\./);

  // Honest copy: no pressure, no claims, no advisor product, no em-dashes, no phone, address, prices or percentages.
  assert.doesNotMatch(text, PRESSURE);
  assert.doesNotMatch(page.text, NO_CLAIMS);
  assert.doesNotMatch(text, ADVISOR, 'the advisor copy is gone');
  assert.doesNotMatch(text, /—/, 'no em-dashes in the copy');
  assert.doesNotMatch(text, /Alamein|Egypt|\+\d|\bLLC\b/, 'no address, phone or other entity');
  assert.doesNotMatch(text, /\$|\d%/, 'no amounts or percentages');
  return { main, text };
}

test('/business, with Business on, is a corporate page with the interim copy and the company form', async t => {
  const app = await startApp(LIVE, { store: new MemoryStore(), now });
  t.after(app.close);
  assert.ok(app.ctx.trips && app.ctx.business, 'trips and Business run');
  assertCorporateBusiness(await get(app, '/business'));

  // GET /business stays with the pages router: Business's own routers never swallow it.
  assert.equal((await get(app, '/business/')).status, 200);
  assert.equal((await get(app, '/business?x=1')).status, 200);

  // The form posts to the existing partner leads endpoint with a company size.
  const res = await fetch(app.base + '/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ name: 'Rana', company: 'Blue Door Logistics', email: 'rana@example.com', type: '51-200 people', message: 'We would like our team to plan work trips inside a policy.' }) });
  assert.equal(res.status, 201);
  assert.deepEqual((await app.store.listPartnerLeads()).map(l => [l.type, l.company]), [['51-200 people', 'Blue Door Logistics']]);
});

test('/business renders with Travel by Budget off when Business is on, and is the 404 page whenever Business is off', async t => {
  const offTrips = await startApp({ ENABLE_TRIPS: 'false', ...ON }, { now });
  t.after(offTrips.close);
  assert.equal(offTrips.ctx.trips, false);
  assert.ok(offTrips.ctx.business);
  assertCorporateBusiness(await get(offTrips, '/business'));
  for (const path of ['/business/app', '/business/p/x', '/business/start']) assert.equal((await get(offTrips, path)).status, 404, path);

  for (const env of [{}, { ENABLE_BUSINESS: 'false' }, { ENABLE_TRIPS: 'false' }, { ENABLE_TRIPS: 'false', ENABLE_BUSINESS: 'false' }]) {
    const off = await startApp(env, { now });
    t.after(off.close);
    assert.equal(off.ctx.business, null, JSON.stringify(env));
    const missing = (await get(off, '/nope')).text;
    for (const path of ['/business', '/business/', '/business/app', '/business/o/x']) {
      const page = await get(off, path);
      assert.equal(page.status, 404, `${JSON.stringify(env)} ${path}`);
      assert.equal(page.text, missing, `${JSON.stringify(env)} ${path}: the app's own 404`);
    }
  }
});

test('the account name sits in .header-name with Business on, and an admin keeps the Admin link', async t => {
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

test('layout() adds page stylesheets after the site and trip styles on the trips.css line; the lead form kinds keep their selects', () => {
  const page = String(layout({ title: 'X', body: '', styles: ['/css/a.css', '/css/b.css'], ctx: { trips: true, assetVersion: '7' } }));
  const at = ['/css/site.css?v=7', '/css/trips.css?v=7', '/css/a.css?v=7', '/css/b.css?v=7'].map(s => page.indexOf(`<link rel="stylesheet" href="${s}">`));
  assert.ok(at.every(i => i > 0) && at.every((v, i) => !i || v > at[i - 1]), `in order: ${at}`);
  assert.ok(page.includes('<link rel="stylesheet" href="/css/trips.css?v=7"><link rel="stylesheet" href="/css/a.css?v=7"><link rel="stylesheet" href="/css/b.css?v=7">\n'));
  const corp = String(layout({ title: 'X', body: '', styles: ['/css/a.css'], ctx: { trips: true }, corporate: true }));
  assert.match(corp, /<link rel="stylesheet" href="\/css\/site\.css\?v=1">\n<link rel="stylesheet" href="\/css\/a\.css\?v=1">\n/);
  assert.doesNotMatch(corp, /trips\.css/);
  // No styles: no extra line, exactly as before Business.
  assert.match(String(layout({ title: 'X', body: '', ctx: {} })), /<link rel="stylesheet" href="\/css\/site\.css\?v=1">\n\n/);
  assert.match(String(layout({ title: 'X', body: '', ctx: { trips: true } })), /<link rel="stylesheet" href="\/css\/trips\.css\?v=1">\n\n/);
  assert.deepEqual(LEAD_TYPES.business, ['Company size', COMPANY_SIZES]);
  assert.deepEqual(LEAD_TYPES.partner, ['Partnership type', ['Property owner', 'Transport company', 'Activity provider', 'Destination', 'Other']]);
  assert.deepEqual(LEAD_TYPES.contact, ['Topic', ['General enquiry', 'Partnerships', 'Press', 'Careers', 'Booking support']]);
});
