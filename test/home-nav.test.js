// The homepage asks one question above the fold and offers two ways to start; the navigation lists the
// four travel products, each a link only when it is connected and COMING SOON otherwise; the one
// example on the homepage is labelled and its numbers are the engine's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');

const PROD = { APP_ENV: 'production', DATABASE_URL: 'postgres://x/p', ENABLE_TRIPS: 'true', ALLOW_DEMO_INVENTORY: 'true', PAYMENT_MODE: 'test' };
const get = (app, p) => fetch(app.base + p, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } }).then(async r => ({ status: r.status, location: r.headers.get('location'), text: await r.text() }));
const cents = s => Math.round(Number(s.replace(/[$,]/g, '')) * 100);
const between = (s, from, to) => { const i = s.indexOf(from); assert.ok(i >= 0, from); return s.slice(i, s.indexOf(to, i)); };

test('above the fold: the question, one number, one primary button, search travel and beat it; nothing else', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const home = (await get(app, '/')).text;
  const hero = between(home, '<section class="tb-hero ag-hero"', '</section>');
  assert.match(hero, /AI travel agent/);
  assert.match(hero, /<h1[^>]*>How much do you want to spend\?<\/h1>/);
  assert.match(hero, /Tell us your budget\. We’ll build the trip\./);
  assert.match(hero, /<b>No destination required\.<\/b>/);
  const controls = hero.match(/<(a|button|input|select|textarea)\b/g) || [];
  assert.ok(controls.length <= 5, `no wall of choices: ${controls.length} controls`);
  assert.equal((hero.match(/class="btn btn-blue/g) || []).length, 1, 'one primary action');
  assert.match(hero, /Already know where you’re going\? <a [^>]*href="#search">Search travel<\/a>/);
  assert.match(hero, /href="\/challenge">I found a trip — beat it<\/a>/);
  // The two paths, in that order, and search travel lands on its own path.
  assert.ok(home.indexOf('id="figure-it-out"') < home.indexOf('id="search"'));
  assert.match(between(home, 'id="search"', '</form>'), /action="\/dream"/);
  const dream = await get(app, '/dream');
  assert.equal(dream.status, 303);
  assert.equal(dream.location, '/#search', 'a search with no destination goes back to the search');
  // The page ends with the same question, and nothing on it is a timed animation.
  assert.match(between(home, 'class="tb-section tb-final"', '</section>'), /Show me what my money can do/);
  assert.doesNotMatch(home, /data-level|data-slider|data-building/);
});

test('one example, labelled, with numbers that add up: what you give, what it builds, the total and what you keep', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const home = (await get(app, '/')).text;
  const ex = between(home, 'aria-labelledby="tb-example-title"', '</section>');
  assert.match(ex, /<p class="eyebrow">Example<\/p>/);
  assert.match(ex, /Example · demo inventory/);
  const dd = label => ex.match(new RegExp(`<dt>${label}</dt><dd>([^<]*)</dd>`))[1];
  const budget = cents(dd('You give us')), total = cents(dd('Total')), keep = cents(dd('You keep'));
  assert.equal(budget, 2000_00);
  assert.ok(total > 0 && total <= budget, 'the example is under its budget');
  assert.equal(keep, budget - total, 'You keep is the budget less the total');
  assert.match(dd('Tripelyx builds'), /^\d+ nights in .+ for 2: .+ with every tax and mandatory fee in the price$/);
  assert.match(ex, /href="\/agent">Build my trip/);
  // "See this example in full" opens the same trip at the same price.
  const full = ex.match(/href="(\/trips\?[^"]*)">See this example in full/)[1].replace(/&amp;/g, '&');
  assert.match((await get(app, full)).text, new RegExp(dd('Total').replace(/[$.]/g, '\\$&')));
});

test('navigation: products are links only when connected, COMING SOON otherwise; the agent and trips once each', async t => {
  // Production with the booking verticals off: the four products are one COMING SOON item, no links.
  const prod = await startApp(PROD, { store: new MemoryStore() });
  t.after(() => prod.close());
  const page = (await get(prod, '/')).text;
  const desktop = between(page, '<ul class="nav-desktop">', '</ul>');
  assert.match(desktop, /Stays · Flights · Cars · Cruises<\/span> <small class="soon-badge">Coming soon<\/small>/);
  assert.doesNotMatch(desktop, /href="\/book/);
  assert.equal((desktop.match(/href="\/agent"/g) || []).length, 1);
  assert.equal((desktop.match(/href="\/my-trips"/g) || []).length, 1);
  assert.match(desktop, /href="\/agent"[^>]*>AI Trip Builder</);
  assert.match(page, /<p class="tb-products-soon">Stays · Flights · Cars · Cruises <small class="soon-badge">Coming soon<\/small><\/p>/);
  assert.doesNotMatch(page, /href="\/book\//, 'no link anywhere on the page to a product that is not connected');
  const mobile = between(page, '<ul class="nav-mobile">', '</ul>');
  assert.deepEqual([...mobile.matchAll(/<\/svg> ([^<]+)<\/a>/g)].map(m => m[1]), ['Search', 'AI Agent', 'Trips', 'Account']);
  assert.match(mobile, /href="\/#search"/);
  assert.match(mobile, /href="\/signin"[^>]*>.*Account/);
  // The trip pages mark the AI Trip Builder as the current page.
  assert.match((await get(prod, '/agent')).text, /href="\/agent" aria-current="page">AI Trip Builder/);

  // Development, with the demo verticals switched on: each is a link to its own search.
  const dev = await startApp();
  t.after(() => dev.close());
  const devNav = between((await get(dev, '/')).text, '<ul class="nav-desktop">', '</ul>');
  for (const [key, label] of [['hotels', 'Stays'], ['flights', 'Flights'], ['cars', 'Cars'], ['cruises', 'Cruises']]) assert.match(devNav, new RegExp(`href="/book/${key}">${label}</a>`));
  assert.match(between((await get(dev, '/')).text, '<ul class="tb-products"', '</ul>'), /href="\/book\/flights">Flights</);
  assert.doesNotMatch(devNav, /Coming soon/);
});

test('how it works speaks for the agent and ends at it', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const how = (await get(app, '/how-it-works')).text;
  assert.match(how, /Tell us your budget\./);
  assert.match(how, /Tell the agent what matters/);
  assert.match(how, /href="\/agent"/);
});
