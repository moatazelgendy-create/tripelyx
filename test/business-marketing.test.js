// /business, the Tripelyx Business homepage (plan §B5, §B6). It exists only with Business on
// (ENABLE_BUSINESS=true), as a corporate page, with Travel by Budget on or off. Its sections follow the order of
// a well-known company travel homepage in our own words, and the copy is held to the owner's rules: Tripelyx
// Inc is the only company named, and there are no amounts, percentages, "N+" figures, testimonials, customers,
// ratings, reviews, em dashes or pressure words, and no AI Travel Agent. The shared chrome (menus, footers,
// robots, sitemap, header CSS) is tested in test/business-chrome.test.js and test/preserve.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser } = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { layout } = require('../server/views/layout');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LEAD_TYPES, LEAD_SUCCESS, leadForm } = require('../server/views/pages');
const mk = require('../server/views/business/marketing');

const now = () => new Date(FIXED_NOW);
const ON = { ENABLE_BUSINESS: 'true' };
const LIVE = { APP_ENV: 'staging', ENABLE_TRIPS: 'true', ALLOW_DEMO_INVENTORY: 'true', PAYMENT_MODE: 'test', DATABASE_URL: 'memory', PUBLIC_BASE_URL: 'https://www.tripelyx.com', ...ON };
const CORPORATE_NAV = [['/', 'Home'], ['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/business', 'Business'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const CORPORATE_FOOTER = [['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const COMPANY_SIZES = ['1-10 people', '11-50 people', '51-200 people', '201-1,000 people', 'More than 1,000 people'];
const KIND_INPUT = '<input type="hidden" name="kind" value="business">';
// The same list as test/experience-pages.test.js.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
// What the plan rules out on this page: social proof, ratings, customers and the consumer AI agent.
const NO_CLAIMS = /testimonial|trusted by|\bcustomers?\b|\bclients?\b|\brat(?:ed|ing|ings)\b|\breviews?\b|\bstars?\b|★|award|ai-travel-agent|AI Travel Agent/i;
// The advisor product this page once described is gone (plan §K, W1A row).
const ADVISOR = /advisor|agency|agencies|proposal|your client|markup|commission|real inventory|Budget Trip Engine/i;
const HEADINGS = [
  ['h1', 'Company travel, with your rules built in.'],
  ['h2', 'What would you like to do?'],
  ['h2', 'Every work trip in one place.'],
  ['h3', 'Cairo to London'], ['h3', 'London hotel'], ['h3', 'Request Approval'],
  ['h2', 'Control without the back-and-forth'],
  ['h3', 'Policy that travels with your team'], ['h3', "Approvals that don't hold trips up"], ['h3', 'Spending you see before it happens'],
  ['h2', 'AI-powered cheaper alternatives'],
  ['h2', 'Built for everyone who touches a work trip'],
  ['h3', 'Employees'], ['h3', 'Managers'], ['h3', 'Travel admins'], ['h3', 'Finance'],
  ['h2', 'Every choice measured against your own limits.'],
  ['h2', 'Questions about the preview?'],
  ['h2', 'Where it stands today'],
  ['h3', 'In the preview now'], ['h3', 'Coming next'],
  ['h2', "Bring your company's travel into one place."],
  ['h2', 'Tell us about your company.'],
];

const get = async (app, path, cookie) => {
  const res = await fetch(app.base + path, { headers: { 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) }, redirect: 'manual' });
  return { status: res.status, text: await res.text() };
};
const part = (page, re) => (page.match(re) || [''])[0];
const headerOf = page => part(page, /<header class="site-header[\s\S]*?<\/header>/);
const footerOf = page => part(page, /<footer class="site-footer[\s\S]*?<\/footer>/);
const mainOf = page => part(page, /<main id="main"[\s\S]*?<\/main>/);
const sectionOf = (page, id) => part(page, new RegExp(`<section [^>]*id="${id}"[\\s\\S]*?</section>`));
const navOf = page => [...part(headerOf(page), /<ul>[\s\S]*?<\/ul>/).matchAll(/<li><a href="([^"]*)"[^>]*>([^<]*)<\/a><\/li>/g)].map(m => [m[1], m[2]]);
const textOf = page => page.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const hrefs = s => [...s.matchAll(/<a [^>]*href="([^"]*)"/g)].map(m => m[1]);
const headings = main => [...main.matchAll(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/g)].map(m => [m[1], textOf(m[2]).trim()]);
const listItems = (s, chip) => [...s.matchAll(new RegExp(`<li><span>([^<]*)</span><span class="chip[^"]*">${chip}</span></li>`, 'g'))].map(m => m[1].replace(/&#39;/g, '\''));
const view = (business, extra = {}) => String(mk.businessMarketingView({ assetVersion: '1', now, config: {}, businessNav: true, ...(business === undefined ? {} : { business }), ...extra }));

/** The owner's copy rules, on the page's text. */
function assertHonestCopy(page, label) {
  const text = textOf(mainOf(page));
  const all = textOf(page);
  assert.doesNotMatch(text, /\$/, `${label}: no amounts`);
  assert.doesNotMatch(text, /\d\s*[%+]/, `${label}: no percentages or "N+" figures`);
  assert.doesNotMatch(all, /—/, `${label}: no em dashes`);
  assert.doesNotMatch(text, PRESSURE, `${label}: no pressure words`);
  assert.doesNotMatch(all, NO_CLAIMS, `${label}: no testimonials, customers, ratings, reviews or AI Travel Agent`);
  assert.doesNotMatch(page, /ai-travel-agent/i, `${label}: no AI Travel Agent link`);
  assert.doesNotMatch(text, ADVISOR, `${label}: no advisor copy`);
  assert.doesNotMatch(all, /Alamein|Egypt|\bLLC\b|\bLtd\b|GmbH|navan/i, `${label}: no address, other entity or other company`);
  // "Tripelyx Inc" is the only company named: every "<Name> Inc"/"Corp" is Tripelyx's.
  const companies = [...all.matchAll(/\b([A-Z][\w&-]*)\s+(Inc|Corp|Corporation|Company Ltd)\b/g)].map(m => `${m[1]} ${m[2]}`);
  assert.ok(companies.length > 0 && companies.every(c => c === 'Tripelyx Inc'), `${label}: ${companies}`);
  assert.doesNotMatch(text, /\b(?:Acme|Example Corp|Mediterra|Sahara Wings)\b/, `${label}: no sample company or airline names`);
  assert.ok(text.includes('Tripelyx AI runs on rules we write and test'), `${label}: says how Tripelyx AI works today`);
  assert.doesNotMatch(page, /\sstyle="/, `${label}: no inline style attributes`);
  assert.doesNotMatch(page, /<style\b/, `${label}: no <style>`);
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/, `${label}: no inline scripts`);
  assert.doesNotMatch(page, /\son[a-z]+="/i, `${label}: no on* handlers`);
}

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
  assert.doesNotMatch(page.text, /\/css\/business\.css|\/js\/business\.js/, 'not the workspace styles or script');
  assert.doesNotMatch(page.text, /<aside class="env-banner"/, 'no environment banner');
  assert.match(page.text, /<link rel="stylesheet" href="\/css\/site\.css\?v=[^"]+">\n<link rel="stylesheet" href="\/css\/business-marketing\.css\?v=[^"]+">\n/, 'the page stylesheet on the trips.css line');
  assert.match(page.text, /<script src="\/js\/forms\.js\?v=[^"]+" defer><\/script>/);
  assert.match(page.text, /<body class="corp bz-mk-page">/);
  assertHonestCopy(page.text, 'live');
}

/** The sections in the homepage's order, then each one's headings; no level skipped; every field labelled. */
function assertStructure(page) {
  const main = mainOf(page);
  assert.deepEqual([...main.matchAll(/<section [^>]*\bid="([^"]+)"/g)].map(m => m[1]), mk.SECTIONS, 'the sections, in order');
  assert.deepEqual(headings(main), HEADINGS, 'the headings, in order, one h1');
  const levels = [...page.matchAll(/<h([1-6])\b/g)].map(m => Number(m[1]));
  assert.equal(levels[0], 1);
  levels.forEach((l, i) => assert.ok(!i || l <= levels[i - 1] + 1, `h${levels[i - 1]} then h${l} skips a level`));
  for (const s of mk.SECTIONS) {
    const id = (sectionOf(main, s).match(/aria-labelledby="([^"]+)"/) || [])[1];
    assert.ok(id && new RegExp(`<h[1-6] id="${id}"`).test(main), `${s} is labelled by its heading`);
  }
  // The company form: every field has its label, and every label names a field.
  const form = sectionOf(main, 'business-form');
  const fors = [...form.matchAll(/<label for="([^"]+)">/g)].map(m => m[1]);
  const fields = [...form.matchAll(/<(?:input|select|textarea) id="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(fors, fields);
  assert.deepEqual(fields, ['lf-name', 'lf-company', 'lf-email', 'lf-type', 'lf-message', 'lf-website']);
  assert.equal((form.match(/<(?:input|select|textarea)\b/g) || []).length, fields.length + 1, 'and the hidden kind');
}

test('/business, with Business on, is a corporate page with the homepage sections in order and the company form', async t => {
  const app = await startApp(LIVE, { store: new MemoryStore(), now });
  t.after(app.close);
  assert.ok(app.ctx.trips && app.ctx.business, 'trips and Business run');
  assert.equal(app.ctx.business.inventory.status, 'demo', 'demo inventory is allowed here');
  const page = await get(app, '/business');
  assertCorporateBusiness(page);
  assertStructure(page.text);
  const main = mainOf(page.text);
  const text = textOf(main);

  // Hero: the preview eyebrow, the line, the two ways in, and what the preview is.
  const hero = sectionOf(main, 'bz-hero');
  assert.match(hero, /<p class="eyebrow eyebrow-light">Tripelyx Business · Preview<\/p>\s*<h1 id="bz-hero-title">Company travel, with your rules built in\.<\/h1>/);
  assert.match(hero, /<div class="hero-actions"><a class="btn btn-white btn-lg" href="\/business\/start">Create your company workspace <svg[\s\S]*?<\/svg><\/a><a class="btn btn-outline-white btn-lg" href="\/business\/signin">Company sign in<\/a><\/div>/);
  assert.ok(textOf(hero).includes(mk.NOTES.demo));
  // The closing band repeats them.
  assert.deepEqual(hrefs(sectionOf(main, 'bz-cta')), ['/business/start', '/business/signin']);

  // "What would you like to do?": five paths; the invite one has no link (the invite link is the way in).
  const start = sectionOf(main, 'bz-start');
  assert.deepEqual(hrefs(start), ['/business/start', '/business/signin', '/business/signin', '#bz-budgets']);
  assert.deepEqual([...start.matchAll(/<span class="bz-mk-path-title">([^<]*)<\/span>/g)].map(m => m[1].replace(/&#39;/g, '\'')), mk.PATHS.map(p => p.title));
  assert.match(start, /<div class="bz-mk-path is-static">[\s\S]*?Join my company&#39;s workspace/);
  for (const id of ['bz-policy', 'bz-approvals', 'bz-budgets']) assert.match(main, new RegExp(`<article class="card bz-mk-pillar" id="${id}">`), id);

  // The product examples and the alternatives picture: each tagged Example, and none prints an amount.
  const platform = sectionOf(main, 'bz-platform');
  assert.equal((platform.match(/<span class="bz-mk-ex-tag">Example<\/span>/g) || []).length, 3);
  assert.match(platform, /<p class="bz-mk-badge is-within">[\s\S]*?Within Policy/);
  assert.match(platform, /<p class="bz-mk-badge is-out">[\s\S]*?Out of Policy/);
  const ai = sectionOf(main, 'bz-ai');
  assert.match(ai, /<span class="bz-mk-alts-name">AI-powered cheaper alternatives<\/span><span class="bz-mk-ex-tag">Example<\/span>/);
  assert.ok(textOf(ai).includes(mk.AI_BODY.replace(/'/g, '\'')) && textOf(ai).includes(mk.AI_SMALL));
  assert.doesNotMatch(main, /bz-money|data-price-source/, 'no prices on the homepage at all');

  // Savings: the demo-price sentence only while the inventory is demo data.
  assert.ok(textOf(sectionOf(main, 'bz-savings')).includes(`${mk.SAVINGS} ${mk.SAVINGS_DEMO}`));
  // Support: the confirmed address.
  assert.match(sectionOf(main, 'bz-support'), /Write to <a href="mailto:go@tripelyx\.com">go@tripelyx\.com<\/a> and a person at Tripelyx will answer\./);

  // Where it stands today: what the preview has, then what comes next, every item with its chip and no dates.
  const today = sectionOf(main, 'bz-today');
  assert.deepEqual(listItems(today, 'In the preview'), mk.PREVIEW_NOW);
  assert.deepEqual(listItems(today, 'Coming soon'), mk.COMING_NEXT);
  assert.doesNotMatch(textOf(today), /\b20\d\d\b|\b(?:Q[1-4]|spring|summer|autumn|fall|winter|January|February|March|April|May|June|July|August|September|October|November|December)\b/i, 'no dates');

  // The form: id business-form, the company sizes, the hidden kind, and the confirmed email.
  const form = sectionOf(main, 'business-form');
  assert.ok(form.includes(`<form class="form-card form" data-lead-form data-success="${LEAD_SUCCESS.business}" novalidate>`), 'its own thank-you line');
  assert.match(form, /<label for="lf-type">Company size<\/label>/);
  assert.deepEqual([...form.matchAll(/<option>([^<]*)<\/option>/g)].map(m => m[1]), COMPANY_SIZES);
  assert.equal(page.text.split(KIND_INPUT).length - 1, 1, 'one kind input on the page, in the business form');
  assert.ok(form.includes(`${KIND_INPUT}<div data-form-status`), 'just before the form status');
  assert.match(form, /Or email <a href="mailto:go@tripelyx\.com">go@tripelyx\.com<\/a>\./);
  assert.doesNotMatch(text, /Available now/);

  // GET /business stays with the pages router: Business's own routers never swallow it.
  assert.equal((await get(app, '/business/')).status, 200);
  assert.equal((await get(app, '/business?x=1')).status, 200);

  // The form posts to the existing partner leads endpoint with a company size, and the kind it carries.
  for (const body of [
    { name: 'Rana', company: 'Blue Door Logistics', email: 'rana@example.com', type: '51-200 people', kind: 'business', message: 'We would like our team to plan work trips inside a policy.' },
    { name: 'Sam', company: 'North Pier', email: 'sam@example.com', type: '1-10 people', message: 'A small team that travels to Dubai every month.' },
  ]) {
    const res = await fetch(app.base + '/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
    assert.equal(res.status, 201, body.name);
  }
  assert.deepEqual((await app.store.listPartnerLeads()).map(l => [l.type, l.company]).sort(), [['1-10 people', 'North Pier'], ['51-200 people', 'Blue Door Logistics']]);
});

test('/business renders with Travel by Budget off when Business is on, and is the 404 page whenever Business is off', async t => {
  const offTrips = await startApp({ ENABLE_TRIPS: 'false', ...ON }, { now });
  t.after(offTrips.close);
  assert.equal(offTrips.ctx.trips, false);
  assert.ok(offTrips.ctx.business);
  const page = await get(offTrips, '/business');
  assertCorporateBusiness(page);
  assertStructure(page.text);

  for (const env of [{}, { ENABLE_BUSINESS: 'false' }, { ENABLE_TRIPS: 'false' }, { ENABLE_TRIPS: 'false', ENABLE_BUSINESS: 'false' }]) {
    const off = await startApp(env, { now });
    t.after(off.close);
    assert.equal(off.ctx.business, null, JSON.stringify(env));
    const missing = (await get(off, '/nope')).text;
    for (const path of ['/business', '/business/', '/business/app', '/business/o/x']) {
      const res = await get(off, path);
      assert.equal(res.status, 404, `${JSON.stringify(env)} ${path}`);
      assert.equal(res.text, missing, `${JSON.stringify(env)} ${path}: the app's own 404`);
    }
  }
});

test('without a running workspace every button is "Talk to us" and nothing links to start or sign-in', () => {
  const page = view(undefined);
  assertHonestCopy(page, 'off');
  assertStructure(page);
  const main = mainOf(page);
  assert.doesNotMatch(page, /\/business\/(start|signin|app|o\/|invite)/, 'no workspace links');
  for (const id of ['bz-hero', 'bz-cta']) {
    assert.match(sectionOf(main, id), /<div class="hero-actions"><a class="btn btn-white btn-lg" href="#business-form">Talk to us <svg[\s\S]*?<\/svg><\/a><\/div>/, id);
  }
  assert.deepEqual(hrefs(sectionOf(main, 'bz-start')), ['#business-form', '#business-form', '#business-form', '#bz-budgets']);
  assert.ok(textOf(sectionOf(main, 'bz-hero')).includes(mk.NOTES.off));
  const today = sectionOf(main, 'bz-today');
  assert.deepEqual(listItems(today, 'In the preview'), []);
  assert.ok(textOf(today).includes("Company workspaces aren't open on this site right now."));
  assert.deepEqual(listItems(today, 'Coming soon'), [...mk.PREVIEW_NOW, ...mk.COMING_NEXT]);
  assert.ok(!textOf(main).includes(mk.SAVINGS_DEMO));
});

test('with no supplier connected the page says so and claims no demo data or search', () => {
  const page = view({ inventory: { status: 'none' } });
  assertHonestCopy(page, 'none');
  assertStructure(page);
  const main = mainOf(page);
  assert.deepEqual(hrefs(sectionOf(main, 'bz-hero')), ['/business/start', '/business/signin']);
  assert.ok(textOf(sectionOf(main, 'bz-hero')).includes(mk.NOTES.none));
  assert.doesNotMatch(textOf(sectionOf(main, 'bz-hero')), /demo data/);
  const today = sectionOf(main, 'bz-today');
  assert.deepEqual(listItems(today, 'In the preview'), mk.PREVIEW_NOW_NO_SUPPLIER);
  assert.deepEqual(listItems(today, 'Coming soon'), mk.COMING_NEXT_NO_SUPPLIER);
  assert.ok(!textOf(main).includes(mk.SAVINGS_DEMO), 'no demo prices to speak of');
  // A missing inventory reads the same way.
  assert.ok(textOf(mainOf(view({}))).includes(mk.NOTES.none));

  // Live inventory (never today): no demo-data wording and no "Real airline and hotel connections" to come.
  const live = mainOf(view({ inventory: { status: 'live' } }));
  assert.ok(textOf(sectionOf(live, 'bz-hero')).includes(mk.NOTES.live));
  assert.deepEqual(listItems(sectionOf(live, 'bz-today'), 'In the preview'), mk.PREVIEW_NOW_LIVE);
  assert.deepEqual(listItems(sectionOf(live, 'bz-today'), 'Coming soon'), mk.COMING_NEXT_LIVE);
  assert.doesNotMatch(textOf(live), /demo/i);
});

test('the account name sits in .header-name with Business on, and an admin keeps the Admin link', async t => {
  const app = await startApp({ ...LIVE, ADMIN_EMAILS: 'boss@example.com' }, { store: new MemoryStore(), now });
  t.after(app.close);
  const { cookie } = await seedUser(app, { name: 'Bartholomew-Alexander Fitzgerald', email: 'bart@example.com' });
  const header = headerOf((await get(app, '/plan', cookie)).text);
  assert.match(header, /<a class="btn btn-ghost btn-sm" href="\/my-trips"><svg[\s\S]*?<\/svg> <span class="header-name">Bartholomew-Alexander<\/span><\/a>/);
  assert.doesNotMatch(header, /header-admin/);
  const admin = await seedUser(app, { name: 'Dana Boss', email: 'boss@example.com' });
  await app.accounts.grantPlatformAdmin(admin.user.id, { by: 'test' }); // D1: listed and granted
  const adminHeader = headerOf((await get(app, '/plan', admin.cookie)).text);
  assert.match(adminHeader, /<a class="text-link header-admin" href="\/admin">Admin<\/a>/);
  assert.match(adminHeader, /<span class="header-name">Dana<\/span>/);
  // Escaped like every other interpolation.
  const odd = await seedUser(app, { name: '<b>Eve</b> Smith', email: 'eve@example.com' });
  assert.match(headerOf((await get(app, '/plan', odd.cookie)).text), /<span class="header-name">&lt;b&gt;Eve&lt;\/b&gt;<\/span>/);
});

test('layout() adds page stylesheets after the site and trip styles; only the business lead form carries a kind', () => {
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

  assert.deepEqual(LEAD_TYPES.business, ['Company size', COMPANY_SIZES, 'business']);
  assert.deepEqual(LEAD_TYPES.partner, ['Partnership type', ['Property owner', 'Transport company', 'Activity provider', 'Destination', 'Other']]);
  assert.deepEqual(LEAD_TYPES.contact, ['Topic', ['General enquiry', 'Partnerships', 'Press', 'Careers', 'Booking support']]);
  const business = String(leadForm('business'));
  assert.equal(business.split(KIND_INPUT).length - 1, 1);
  for (const kind of ['partner', 'contact', 'nonsense']) {
    const form = String(leadForm(kind));
    assert.doesNotMatch(form, /name="kind"/, `${kind}: no kind input`);
    // Otherwise the same form: only the select and the kind input differ.
    assert.match(form, /^<form class="form-card form" data-lead-form novalidate>/, `${kind}: no data-success, exactly as before`);
    const strip = s => s.replace(/<label for="lf-type">[^<]*<\/label>\s*<select[\s\S]*?<\/select>/, '').replace(KIND_INPUT, '')
      .replace(` data-success="${LEAD_SUCCESS.business}"`, '');
    assert.equal(strip(form), strip(business), `${kind}: the same form as before`);
  }
});

// Lead decision on the 1V need: the corporate forms keep forms.js's original thank-you line; only the Business
// form carries data-success, and its text has no em dash.
test('forms.js shows the form\'s own data-success line (the Business form, no em dash) and keeps the corporate thank-you as it was', async () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'forms.js'), 'utf8');
  assert.deepEqual(Object.keys(LEAD_SUCCESS), ['business']);
  assert.doesNotMatch(LEAD_SUCCESS.business, /[\u2013\u2014]/);
  assert.doesNotMatch(LEAD_SUCCESS.business, PRESSURE);
  async function send(success) {
    const status = { innerHTML: 'old', children: [], appendChild(c) { this.children.push(c); } };
    const btn = { disabled: false };
    let submit = null;
    let posted = null;
    const form = {
      elements: {},
      querySelector: sel => (sel === '[data-form-status]' ? status : sel === 'button[type=submit]' ? btn : null),
      querySelectorAll: () => [],
      getAttribute: name => (name === 'data-success' ? success : null),
      addEventListener: (type, fn) => { if (type === 'submit') submit = fn; },
      reset() {},
    };
    const document = { querySelectorAll: sel => (sel === '[data-lead-form]' ? [form] : []), createElement: () => ({ className: '', textContent: '' }) };
    class FormData { entries() { return Object.entries({ name: 'Ana', email: 'ana@example.com', message: 'Twelve of us travel each month.' }); } }
    const fetch = async (url, opts) => { posted = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ ok: true }) }; };
    vm.runInNewContext(js, { document, FormData, fetch });
    assert.equal(typeof submit, 'function');
    submit({ preventDefault() {} });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(posted.url, '/api/partners');
    assert.equal(btn.disabled, false);
    return status;
  }
  const corporate = await send(null);
  assert.equal(corporate.innerHTML, '<div class="alert alert-success">Thanks \u2014 your message is in. We\u2019ll be in touch soon.</div>', 'unchanged');
  assert.deepEqual(corporate.children, []);
  const business = await send(LEAD_SUCCESS.business);
  assert.equal(business.innerHTML, '', 'cleared when the send starts, then only the form\'s own line');
  assert.deepEqual(business.children.map(c => [c.className, c.textContent]), [['alert alert-success', LEAD_SUCCESS.business]]);
  // The /business page renders that attribute; /partners and /contact do not (test/preserve.test.js holds their HTML).
  const app = await startApp({ ...LIVE }, { store: new MemoryStore(), now });
  try {
    const page = await (await fetch(`${app.base}/business`)).text();
    assert.ok(page.includes(`data-success="${LEAD_SUCCESS.business}"`));
    for (const p of ['/partners', '/contact']) assert.doesNotMatch(await (await fetch(`${app.base}${p}`)).text(), /data-success/, p);
  } finally { await app.close(); }
});
