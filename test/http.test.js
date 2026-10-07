const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { addDays, today } = require('../server/lib/dates');

test('pages render, security headers are set, secrets are not exposed', async t => {
  const app = await startApp({ PAYMENT_LIVE_SECRET_KEY: 'sk_should_not_leak' });
  t.after(app.close);
  for (const path of ['/', '/partners', '/about', '/contact', '/how-it-works', '/faq', '/legal/terms', '/book', '/book/hotels', '/book/flights', '/book/cars', '/book/cruises', '/book/yachts', '/book/transfers', '/book/activities', '/book/experiences', '/manage']) {
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
  // One company identity: the confirmed legal entity and support email, nothing unconfirmed, no old brand pages.
  const home = await (await fetch(app.base + '/')).text();
  assert.match(home, new RegExp(`© ${new Date().getUTCFullYear()} Tripelyx Inc\\. All rights reserved\\.`));
  assert.match(home, /AI-powered travel planning and booking\./);
  for (const old of ['Tripelyx LLC', 'Alamein Go booking', 'Our brands', 'Travel technology', 'travel platforms and technology']) assert.ok(!home.includes(old), `the homepage still says "${old}"`);
  const contact = await (await fetch(app.base + '/contact')).text();
  assert.match(contact, /go@tripelyx\.com/);
  assert.ok(!/New Alamein|Sunday–Thursday/.test(contact), 'unconfirmed address and hours are not shown');
  for (const [from, to] of [['/brands', '/about'], ['/company', '/about'], ['/technology', '/partners']]) {
    const r = await fetch(app.base + from, { redirect: 'manual' });
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.get('location'), to, from);
  }
  const terms = await (await fetch(app.base + '/legal/terms')).text();
  assert.match(terms, /operated by Tripelyx Inc/);
  assert.ok(!/Draft for professional review|placeholder/i.test(terms), 'no development wording on the policies');
  const cfg = await (await fetch(app.base + '/api/config')).json();
  assert.equal(cfg.verticals.length, 8);
  assert.ok(!JSON.stringify(cfg).includes('sk_should_not_leak'));
});

test('no inline style attributes or inline scripts (the CSP would block them)', async t => {
  const app = await startApp();
  t.after(app.close);
  for (const path of ['/', '/partners', '/about', '/contact', '/contact?trip=cancun~NYC~2027-03-02~5~2c~cun-1', '/book/hotels', '/book/experiences']) {
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
  const date = addDays(today(), 12);
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
    html = await (await fetch(`${app.base}/book/yachts?date=${addDays(today(), offset)}&duration=half_day&guests=4`)).text();
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

test('contact and business messages: validation, honeypot, storage, support is told, admin can read them', async t => {
  const app = await startApp({ ADMIN_EMAILS: 'ops@example.com' });
  t.after(app.close);
  const post = (b, path = '/api/messages') => fetch(app.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const bad = await post({ name: '', email: 'x', message: 'hi' });
  assert.equal(bad.status, 422);
  const details = (await bad.json()).error.details;
  assert.ok(details.name && details.email && details.message);
  assert.equal((await post({ name: 'Bot', email: 'b@b.co', message: 'spam spam spam', website: 'x' })).status, 201);
  assert.equal(app.store.leads.length, 0, 'honeypot submissions are dropped');
  assert.equal((await post({ kind: 'support', type: 'A booking I’ve made', name: 'Omar', email: 'omar@example.com', message: 'Can I add a bag to my trip?', trip: 'cancun~NYC~2027-03-02~5~2c~cun-1' })).status, 201);
  assert.equal((await post({ kind: 'partner', name: 'Lina', company: 'Bay Chalets', email: 'lina@example.com', message: 'We run 40 chalets.' }, '/api/partners')).status, 201, 'the old address still works');
  assert.equal(app.store.leads.length, 2);
  assert.equal(app.store.leads[0].trip, 'cancun~NYC~2027-03-02~5~2c~cun-1');
  assert.equal((await post({ name: 'X', email: 'x@example.com', message: 'A message long enough', trip: '"><script>' })).status, 201);
  assert.equal(app.store.leads[2].trip, null, 'a malformed trip reference is dropped');
  const outbox = await app.store.listRecords('outbox');
  assert.ok(outbox.some(m => /Support message/.test(m.subject) && /Omar/.test(m.body)), 'support is told about the message');
});
