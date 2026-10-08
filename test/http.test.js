const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, clock } = require('./helpers');
const { addDays, today } = require('../server/lib/dates');

test('pages render, security headers are set, secrets are not exposed', async t => {
  const app = await startApp({ PAYMENT_LIVE_SECRET_KEY: 'sk_should_not_leak' });
  t.after(app.close);
  for (const path of ['/', '/ai-travel-agent', '/brands', '/technology', '/partners', '/about', '/contact', '/book', '/book/hotels', '/book/flights', '/book/cars', '/book/cruises', '/book/yachts', '/book/transfers', '/book/activities', '/book/experiences', '/manage']) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.ok(!body.includes('sk_should_not_leak'), `${path} leaks a secret`);
  }
  const res = await fetch(app.base + '/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/unsafe-inline/.test(csp));
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal((await fetch(app.base + '/nope')).status, 404);
  const cfg = await (await fetch(app.base + '/api/config')).json();
  assert.equal(cfg.verticals.length, 8);
  assert.ok(!JSON.stringify(cfg).includes('sk_should_not_leak'));
});

test('no inline style attributes or inline scripts (the CSP would block them)', async t => {
  const app = await startApp();
  t.after(app.close);
  for (const path of ['/', '/ai-travel-agent', '/brands', '/technology', '/partners', '/about', '/contact', '/book/hotels', '/book/experiences']) {
    const body = await (await fetch(app.base + path)).text();
    assert.ok(!/\sstyle="/.test(body), `${path} has an inline style attribute`);
    assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${path} has an inline script`);
  }
});

test('disabled verticals 404 and disappear from navigation', async t => {
  const app = await startApp({ ENABLE_CRUISES: 'false' });
  t.after(app.close);
  assert.equal((await fetch(app.base + '/book/cruises')).status, 404);
  assert.equal((await fetch(app.base + '/api/search/cruises?guests=2')).status, 404);
  const body = await (await fetch(app.base + '/book')).text();
  assert.ok(!body.includes('href="/book/cruises"'));
});

test('booking API: JSON only, cookie-scoped access, full pay flow', async t => {
  const app = await startApp();
  t.after(app.close);
  const date = addDays(today(clock()), 12);
  const search = await (await fetch(`${app.base}/api/search/transfers?from=${encodeURIComponent('El Alamein Airport (DBB)')}&to=${encodeURIComponent('Marassi')}&date=${date}`)).json();
  const offer = search.offers[0];
  const formPost = await fetch(app.base + '/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
  assert.equal(formPost.status, 415, 'non-JSON writes are refused');
  const quote = await (await fetch(app.base + '/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vertical: 'transfers', offerId: offer.id, optionId: 'ONE_WAY', query: search.query }) })).json();
  assert.ok(quote.quoteId);

  const created = await fetch(app.base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.quoteId, traveler: { firstName: 'A', lastName: 'B', email: 'a@example.com' } }) });
  assert.equal(created.status, 201);
  const cookie = created.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const { booking } = await created.json();
  const jar = cookie.split(';')[0];

  const noCookie = await fetch(`${app.base}/api/bookings/${booking.ref}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: {} }) });
  assert.equal(noCookie.status, 404);

  const pay = await fetch(`${app.base}/api/bookings/${booking.ref}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar }, body: JSON.stringify({ method: { type: 'test_card', number: '4242424242424242', expMonth: '12', expYear: '35', cvc: '123', name: 'A B' } }) });
  assert.equal(pay.status, 200);
  assert.equal((await pay.json()).booking.status, 'confirmed');

  const page = await fetch(`${app.base}/booking/${booking.ref}`, { headers: { Cookie: jar } });
  assert.match(await page.text(), /Your booking is confirmed/);
  const locked = await fetch(`${app.base}/booking/${booking.ref}`);
  assert.match(await locked.text(), /Manage your booking/);

  const lookup = await fetch(app.base + '/api/bookings/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: booking.ref, email: 'A@example.com' }) });
  assert.equal(lookup.status, 200);
  assert.match(lookup.headers.get('set-cookie'), new RegExp(`txbk_${booking.ref}=`));
});

test('no-JS paths: results, quote form post and manage form work without JavaScript', async t => {
  const app = await startApp();
  t.after(app.close);
  // The demo marks some yachts as booked on some dates: the first date from two weeks out with a free one.
  let html, m = null;
  for (let offset = 14; offset < 44 && !m; offset++) {
    html = await (await fetch(`${app.base}/book/yachts?date=${addDays(today(clock()), offset)}&duration=half_day&guests=4`)).text();
    m = html.match(/href="(\/book\/yachts\/[^"]+)"/);
  }
  assert.ok(m, 'a yacht is free on some date in the next month');
  const offerHtml = await (await fetch(app.base + m[1].replace(/&amp;/g, '&'))).text();
  const action = offerHtml.match(/action="([^"]+\/quote)"/)[1];
  const hidden = [...offerHtml.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(x => [x[1], x[2]]);
  const option = offerHtml.match(/name="optionId" value="([^"]+)" checked/)[1];
  const body = new URLSearchParams([...hidden, ['optionId', option]]);
  const res = await fetch(app.base + action, { method: 'POST', body, redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/checkout\/qt_/);
  const manage = await fetch(app.base + '/manage', { method: 'POST', body: new URLSearchParams({ ref: 'TX-NOPE', email: 'a@b.co' }) });
  assert.equal(manage.status, 404);
  assert.match(await manage.text(), /couldn’t find a booking|couldn&#39;t find a booking/);
});

test('partner form: validation, honeypot and storage', async t => {
  const app = await startApp();
  t.after(app.close);
  const post = b => fetch(app.base + '/api/partners', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const bad = await post({ name: '', email: 'x', message: 'hi' });
  assert.equal(bad.status, 422);
  const details = (await bad.json()).error.details;
  assert.ok(details.name && details.email && details.message);
  assert.equal((await post({ name: 'Bot', email: 'b@b.co', message: 'spam spam spam', website: 'x' })).status, 201);
  assert.equal(app.store.leads.length, 0, 'honeypot submissions are dropped');
  assert.equal((await post({ name: 'Omar', email: 'omar@example.com', message: 'We run 40 chalets in Hacienda Bay.' })).status, 201);
  assert.equal(app.store.leads.length, 1);
});

test('demo booking pages show no made-up scarcity: no "only N left" and no "Selling fast"', async t => {
  const { sampleQueries } = require('./helpers');
  const app = await startApp();
  t.after(app.close);
  const SCARCITY = /left at this price|only \d+ left|\d+ left<|Selling fast/i;
  const queries = sampleQueries();
  for (const v of ['hotels', 'flights', 'cars', 'cruises', 'yachts', 'transfers', 'activities', 'experiences']) {
    const qs = new URLSearchParams(queries[v]).toString();
    const results = await (await fetch(`${app.base}/book/${v}?${qs}`)).text();
    assert.match(results, /chip-demo/, `${v}: demo inventory is labelled`);
    assert.doesNotMatch(results, SCARCITY, `${v} results`);
    const links = [...new Set([...results.matchAll(new RegExp(`href="(/book/${v}/[^"?]+\\?[^"]*)"`, 'g'))].map(m => m[1].replace(/&amp;/g, '&')))].slice(0, 6);
    assert.ok(links.length, `${v}: has offers`);
    for (const link of links) {
      const page = await (await fetch(app.base + link)).text();
      assert.doesNotMatch(page, SCARCITY, link);
      if (v === 'activities' || v === 'experiences') assert.match(page, /<small>(Open|Full)<\/small>/, `${link}: time slots say open or full`);
    }
  }
});
