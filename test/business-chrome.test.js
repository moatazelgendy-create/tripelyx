// What Tripelyx Business adds to the shared chrome, and only when it runs (plan §B1): the "Business" menu item,
// the site-header-biz class that scopes its header CSS, the .header-name span, the trip footer link, GET /business,
// and one line each in robots.txt and sitemap.xml. With Business off (the default in every APP_ENV) none of it
// exists; test/preserve.test.js proves every page is then byte-identical to the site before Business.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser } = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { layout, NAV, TRIP_NAV, FOOTER_NAV } = require('../server/views/layout');
const { ENVS, normalise, sha256 } = require('../scripts/capture-baseline');
const manifest = require('./fixtures/baseline/manifest.json');

const now = () => new Date(FIXED_NOW);
const ON = { ENABLE_BUSINESS: 'true' };
const LIVE = ENVS.live;
const boot = (env, opts = {}) => startApp(env, { store: new MemoryStore(), now, ...opts });

const BEFORE_NAV = [['/', 'Home'], ['/brands', 'Our Brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/about', 'About'], ['/contact', 'Contact']];
const BEFORE_TRIP_NAV = [['/plan', 'Build My Trip'], ['/how-it-works', 'How It Works'], ['/destinations', 'Destinations'], ['/my-trips', 'My Trips'], ['/faq', 'Help']];
const BIZ_NAV = [...BEFORE_NAV.slice(0, 3), ['/business', 'Business'], ...BEFORE_NAV.slice(3)];
const BIZ_TRIP_NAV = [...BEFORE_TRIP_NAV, ['/business', 'Business']];
const CORPORATE_FOOTER = BEFORE_NAV.slice(1);
const BEFORE_COMPANY = [['/about', 'About us'], ['/brands', 'Our brands'], ['/technology', 'Technology'], ['/partners', 'Partners'], ['/book', 'Alamein Go booking']];
const BIZ_COMPANY = [...BEFORE_COMPANY.slice(0, 4), ['/business', 'Tripelyx Business'], BEFORE_COMPANY[4]];

const get = async (app, p, cookie) => {
  const res = await fetch(app.base + p, { headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) }, redirect: 'manual' });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const part = (page, re) => (page.match(re) || [''])[0];
const headerOf = page => part(page, /<header class="site-header[\s\S]*?<\/header>/);
const footerOf = page => part(page, /<footer class="site-footer[\s\S]*?<\/footer>/);
const navOf = page => [...part(headerOf(page), /<ul>[\s\S]*?<\/ul>/).matchAll(/<li><a href="([^"]*)"[^>]*>([^<]*)<\/a><\/li>/g)].map(m => [m[1], m[2]]);
const links = html => [...html.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map(m => [m[1], m[2]]);
const footerRow = page => links(part(footerOf(page), /<nav class="footer-nav"[\s\S]*?<\/nav>/));
const companyCol = page => links(part(footerOf(page), /<div class="tf-col"><h2>Company<\/h2>[\s\S]*?<\/div>/));
const headerClass = page => (headerOf(page).match(/^<header class="([^"]*)"/) || [])[1];
const fixture = file => fs.readFileSync(path.join(__dirname, 'fixtures', 'baseline', file), 'utf8');

test('the menus: Business is after Technology in NAV and last in TRIP_NAV; FOOTER_NAV keeps the corporate footer\'s five links', () => {
  assert.deepEqual(NAV.map(n => [n.href, n.label]), BIZ_NAV);
  assert.deepEqual(TRIP_NAV.map(n => [n.href, n.label]), BIZ_TRIP_NAV);
  assert.deepEqual(FOOTER_NAV.map(n => [n.href, n.label]), CORPORATE_FOOTER);
  // layout() decides from ctx.businessNav alone.
  for (const ctx of [{}, { businessNav: false }, { trips: true }, { trips: true, businessNav: false }, { trips: true, business: {} }]) {
    const page = String(layout({ title: 'X', body: '', ctx }));
    assert.doesNotMatch(page, /site-header-biz|href="\/business"|header-name/, JSON.stringify(ctx));
  }
  assert.match(String(layout({ title: 'X', body: '', ctx: { businessNav: true } })), /<header class="site-header site-header-biz" data-header>/);
  assert.match(String(layout({ title: 'X', body: '', ctx: { trips: true, businessNav: true } })), /<header class="site-header site-header-trips site-header-biz" data-header>/);
  assert.match(String(layout({ title: 'X', body: '', ctx: { trips: true, businessNav: true }, corporate: true })), /<header class="site-header site-header-biz" data-header>/);
});

test('Business off (the default): /business is the 404 page, and menus, footers, robots and sitemap are the baseline', async t => {
  for (const [envName, env] of Object.entries(ENVS)) {
    const app = await boot(env);
    t.after(app.close);
    assert.equal(app.ctx.business, null, envName);
    const missing = await get(app, '/nope');
    for (const p of ['/business', '/business/', '/Business']) {
      const page = await get(app, p);
      assert.equal(page.status, 404, `${envName} ${p}`);
      assert.equal(page.text, missing.text, `${envName} ${p}: the app's own 404`);
    }
    const trips = !!app.ctx.trips;
    for (const p of ['/', '/brands', '/technology', '/partners', '/about', '/contact', '/book', '/book/hotels', '/nope', ...(trips ? ['/plan', '/ai-travel-agent', '/how-it-works'] : [])]) {
      const page = (await get(app, p)).text;
      assert.doesNotMatch(page, /site-header-biz|header-name|href="\/business"|Tripelyx Business/, `${envName} ${p}: nothing of Business`);
      const tripHeader = headerClass(page) === 'site-header site-header-trips';
      assert.ok(tripHeader || headerClass(page) === 'site-header', `${envName} ${p}: ${headerClass(page)}`);
      assert.deepEqual(navOf(page), tripHeader ? BEFORE_TRIP_NAV : BEFORE_NAV, `${envName} ${p}: the menu as before`);
      if (/<footer class="site-footer trip-footer">/.test(page)) assert.deepEqual(companyCol(page), BEFORE_COMPANY, `${envName} ${p}: the trip footer as before`);
      else assert.deepEqual(footerRow(page), CORPORATE_FOOTER, `${envName} ${p}: the corporate footer as before`);
    }
    // The /book header and footer are the baseline's, byte for byte.
    const book = normalise((await get(app, '/book')).text);
    const before = fixture(manifest.envs[envName].full.book.file);
    assert.equal(headerOf(book), headerOf(before), `${envName}: the /book header`);
    assert.equal(footerOf(book), footerOf(before), `${envName}: the /book footer`);
    for (const p of ['/robots.txt', '/sitemap.xml']) {
      const r = await get(app, p);
      assert.equal(r.status, manifest.envs[envName].pages[p].status, `${envName} ${p}`);
      assert.equal(sha256(normalise(r.text)), manifest.envs[envName].pages[p].sha256, `${envName} ${p}: the baseline`);
      assert.doesNotMatch(r.text, /\/business/, `${envName} ${p}`);
    }
    if (trips) {
      const { cookie } = await seedUser(app, { name: 'Ada Lovelace' });
      const header = headerOf((await get(app, '/plan', cookie)).text);
      assert.match(header, /<a class="btn btn-ghost btn-sm" href="\/my-trips"><svg[\s\S]*?<\/svg> Ada<\/a>/, `${envName}: the name as before, no span`);
    }
  }
});

test('Business on: Business follows Technology in the corporate menu and ends the trip menu, once, with the header class', async t => {
  const app = await boot({ ...LIVE, ...ON });
  t.after(app.close);
  assert.ok(app.ctx.business && app.ctx.businessNav);
  for (const p of ['/', '/brands', '/technology', '/partners', '/about', '/contact']) {
    const page = (await get(app, p)).text;
    assert.equal(headerClass(page), 'site-header site-header-biz', p);
    assert.deepEqual(navOf(page), BIZ_NAV, `${p}: after Technology, before Partners`);
    assert.doesNotMatch(headerOf(page), /Sign in|\/signin|\/my-trips|header-account/, `${p}: no sign-in in the corporate header`);
    assert.deepEqual(footerRow(page), CORPORATE_FOOTER, `${p}: the corporate footer keeps its five links`);
    assert.doesNotMatch(footerOf(page), /business/i, `${p}: no Business in the corporate footer`);
  }
  for (const p of ['/plan', '/how-it-works', '/ai-travel-agent', '/book', '/book/hotels', '/nope']) {
    const page = (await get(app, p)).text;
    assert.equal(headerClass(page), 'site-header site-header-trips site-header-biz', p);
    assert.deepEqual(navOf(page), BIZ_TRIP_NAV, `${p}: Business last`);
    assert.equal((headerOf(page).match(/href="\/business"/g) || []).length, 1, `${p}: once in the header`);
    assert.deepEqual(companyCol(page), BIZ_COMPANY, `${p}: the trip footer lists Tripelyx Business before Alamein Go booking`);
    assert.equal((footerOf(page).match(/href="\/business"/g) || []).length, 1, `${p}: once in the footer`);
  }
  const biz = (await get(app, '/business')).text;
  assert.match(headerOf(biz), /<li><a href="\/business" aria-current="page">Business<\/a><\/li>/);

  // The account name is wrapped for the ellipsis only with Business on.
  const { cookie } = await seedUser(app, { name: 'Ada Lovelace' });
  assert.match(headerOf((await get(app, '/plan', cookie)).text), /<svg[\s\S]*?<\/svg> <span class="header-name">Ada<\/span><\/a>/);
});

test('Business on with Travel by Budget off: /business is 200, and the generic header on /book carries Business', async t => {
  const app = await boot({ ...ENVS.tripsOff, ...ON });
  t.after(app.close);
  assert.equal(app.ctx.trips, false);
  assert.ok(app.ctx.business && app.ctx.businessNav);
  const biz = await get(app, '/business');
  assert.equal(biz.status, 200);
  assert.equal(headerClass(biz.text), 'site-header site-header-biz');
  for (const p of ['/', '/book', '/book/flights', '/nope']) {
    const page = (await get(app, p)).text;
    assert.equal(headerClass(page), 'site-header site-header-biz', p);
    assert.deepEqual(navOf(page), BIZ_NAV, p);
    assert.deepEqual(footerRow(page), CORPORATE_FOOTER, `${p}: the corporate footer`);
  }
  for (const p of ['/robots.txt', '/sitemap.xml']) assert.equal((await get(app, p)).status, 404, `${p}: only with trips on`);
});

test('Business on: robots keeps crawlers out of /business/ but not /business, and the sitemap lists /business after /contact', async t => {
  for (const [env, base] of [[{ ...LIVE, ...ON }, 'https://www.tripelyx.com'], [ON, '']]) {
    const app = await boot(env);
    t.after(app.close);
    const off = await boot({ ...env, ENABLE_BUSINESS: 'false' });
    t.after(off.close);
    const robots = (await get(app, '/robots.txt')).text;
    assert.match(robots, /^Disallow: \/business\/$/m);
    assert.doesNotMatch(robots, /^Disallow: \/business$/m);
    assert.equal(robots, (await get(off, '/robots.txt')).text.replace('Disallow: /my-trips\n', 'Disallow: /my-trips\nDisallow: /business/\n'), 'one line, after /my-trips');
    const sitemap = (await get(app, '/sitemap.xml')).text;
    assert.ok(sitemap.includes(`<url><loc>${base}/contact</loc></url>\n  <url><loc>${base}/business</loc></url>\n`), sitemap);
    assert.equal((sitemap.match(/\/business</g) || []).length, 1);
    assert.equal(sitemap, (await get(off, '/sitemap.xml')).text.replace(`<url><loc>${base}/contact</loc></url>\n`, `<url><loc>${base}/contact</loc></url>\n  <url><loc>${base}/business</loc></url>\n`), 'one line, after /contact');
  }
});

test('Business on: /business keeps the security headers and has no inline style or script', async t => {
  const app = await boot({ ...ON, PAYMENT_LIVE_SECRET_KEY: 'sk_should_not_leak' });
  t.after(app.close);
  const res = await get(app, '/business');
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes('sk_should_not_leak'));
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.ok(!/unsafe-inline/.test(res.headers.get('content-security-policy')));
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.ok(!/\sstyle="/.test(res.text), 'no inline style attribute');
  assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(res.text), 'no inline script');
});

test('the header CSS Business needs applies only under .site-header-biz, and never to the company pages', () => {
  const css = name => fs.readFileSync(path.join(__dirname, '../public/css', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const band = (src, media) => { const at = src.indexOf(media); assert.ok(at >= 0, media); return src.slice(at, src.indexOf('\n}', at)); };
  const rules = block => block.split('\n').map(l => l.trim()).filter(l => l.includes('{') && !l.startsWith('@media'));
  const trips = css('trips.css');
  const site = css('site.css');
  // A signed-in visitor's first name is cut only between 1025 and 1200px, where the header is tight; from 1200px
  // it shows in full, as it does with Business off (no rule outside that band styles .header-name).
  assert.doesNotMatch(trips, /^\.site-header-biz \.header-name/m, 'no width cap on the name at every desktop width');
  assert.match(trips, /^\.site-header-biz\.site-header-trips \.main-nav a \{ white-space: nowrap; \}$/m);
  const tripBand = band(trips, '@media (min-width: 1025px) and (max-width: 1199.98px)');
  assert.deepEqual(rules(tripBand), [
    '.site-header-biz.site-header-trips .header-inner { gap: 16px; }',
    '.site-header-biz.site-header-trips .main-nav ul { gap: 18px; }',
    '.site-header-biz.site-header-trips .header-account { gap: 10px; }',
    '.site-header-biz.site-header-trips .main-nav a { font-size: 14px; }',
    '.site-header-biz .header-name { display: inline-block; max-width: 9ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }',
    '.site-header-biz .header-account .header-admin { display: none; }',
  ]);
  const nameRules = trips.split('\n').filter(l => l.includes('header-name'));
  assert.equal(nameRules.length, 1, 'the one .header-name rule is the band\'s');
  assert.ok(tripBand.includes(nameRules[0].trim()));
  assert.match(site, /^body:not\(\.corp\) \.site-header-biz:not\(\.site-header-trips\) \.main-nav a \{ white-space: nowrap; \}$/m);
  const bookBand = band(site, '@media (min-width: 1025px) and (max-width: 1279.98px)');
  assert.deepEqual(rules(bookBand), [
    'body:not(.corp) .site-header-biz:not(.site-header-trips) .main-nav { padding-left: 0; }',
    'body:not(.corp) .site-header-biz:not(.site-header-trips) .main-nav ul { gap: 18px; }',
    'body:not(.corp) .site-header-biz:not(.site-header-trips) .main-nav a { font-size: 14px; }',
  ]);
  // Nothing else in either file styles .header-name, and no rule in either band reaches the company pages.
  for (const src of [trips, site]) for (const line of src.split('\n').filter(l => l.includes('header-name'))) assert.match(line, /\.site-header-biz \.header-name/, line);
  assert.doesNotMatch(tripBand + bookBand, /(^|[\s,])\.corp\b/);
});
