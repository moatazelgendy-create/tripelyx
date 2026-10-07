// Every address leads somewhere: links that can't be opened any more say so with a way forward,
// old and common addresses redirect, a paid checkout can't be paid twice, and sign-in never sends a
// traveler to another site.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { encodeSpec } = require('../server/trips/spec');
const { addDays, today } = require('../server/lib/dates');

const QUERY = { b: '1500', k: '0', from: 'SFO', who: 'couple', when: 'anytime', nights: '5', style: 'beach', prio: 'hotel' };
const CARD = { type: 'test_card', number: '4242424242424242', expMonth: '12', expYear: '35', cvc: '123', name: 'Ada Lovelace' };
const SPEC = { dest: 'cancun', from: 'SFO', nights: 5, travelers: 2, who: 'couple', hotel: 'cun-2', flight: 'nonstop', activities: [], bags: false, transfer: true };

function client(base) {
  const jar = {};
  const req = async (path, { method = 'GET', form, json, headers = {} } = {}) => {
    const h = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'sec-fetch-site': 'same-origin', ...headers };
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) { const [kv, ...rest] = sc.split(';'); const [k, v] = kv.split('='); if (!v || rest.some(x => /Max-Age=0/i.test(x))) delete jar[k]; else jar[k] = v; }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type'), text, json: () => JSON.parse(text) };
  };
  return { req };
}

const gone = (r, status, what = 'trip') => {
  assert.equal(r.status, status, r.text.slice(0, 300));
  assert.match(r.text, new RegExp(`This ${what} link is no longer available\\.`));
  assert.match(r.text, /href="\/agent">Start a new trip/);
  assert.match(r.text, /<meta name="robots" content="noindex/);
};

test('trip, comparison and conversation links that can no longer open say so, with a way forward', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const c = client(app.base);

  // Dates that have passed: the trip page, its review and its checkout step all say the link is gone.
  const past = encodeSpec({ ...SPEC, depart: addDays(today(), -3) });
  gone(await c.req(`/trip/${past}`), 410);
  assert.match((await c.req(`/trip/${past}`)).text, /built for dates that have passed/);
  gone(await c.req(`/trip/${past}/review`), 410);
  gone(await c.req(`/trip/${past}/quote`, { method: 'POST', form: { approvedTotal: '100', cx: '' } }), 410);
  // A link that was never valid.
  gone(await c.req('/trip/not-a-trip'), 404);

  // A comparison with one trip that still opens shows that trip; with none, the link is gone.
  const future = encodeSpec({ ...SPEC, depart: addDays(today(), 30) });
  const one = await c.req(`/compare?t=${future}&t=${past}&b=1500`);
  assert.equal(one.status, 303);
  assert.match(one.location, new RegExp(`^/trip/${future}\\?`));
  gone(await c.req(`/compare?t=${past}&t=garbage`), 410);

  // A conversation that isn't this browser's.
  const agent = await c.req('/agent/ag_doesnotexist');
  gone(agent, 404);
  assert.match(agent.text, /may belong to another browser or account/);

  // An address that never existed: the 404 still offers the agent.
  const nf = await c.req('/no-such-page');
  assert.equal(nf.status, 404);
  assert.match(nf.text, /href="\/agent">Start a new trip/);
});

test('a checkout that was paid cannot be paid again: it points at the booking instead', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const c = client(app.base);
  const results = await c.req(`/trips?${new URLSearchParams(QUERY)}`);
  const m = results.text.match(/href="(\/trip\/[^"?]+)\?([^"]*)"/);
  const tripPath = m[1], cx = m[2].replace(/&amp;/g, '&');
  const review = await c.req(`${tripPath}/review?${cx}&seen=0`);
  const approvedTotal = review.text.match(/name="approvedTotal" value="(\d+)"/)[1];
  const cxField = review.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
  const q = await c.req(`${tripPath}/quote`, { method: 'POST', form: { approvedTotal, cx: cxField, promo: '' } });
  const quoteId = q.location.split('/').pop();
  const traveler = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };

  // Before paying, the checkout can be reopened and a second booking attempt replaces nothing paid.
  const first = await c.req('/api/bookings', { method: 'POST', json: { quoteId, traveler } });
  assert.equal(first.status, 201, first.text);
  const ref = first.json().booking.ref;
  assert.equal((await c.req(`/checkout/${quoteId}`)).status, 200);
  const twin = await c.req('/api/bookings', { method: 'POST', json: { quoteId, traveler } });
  assert.equal(twin.status, 201, 'an unpaid checkout can be started again');
  const paid = await c.req(`/api/bookings/${ref}/pay`, { method: 'POST', json: { method: CARD } });
  assert.equal(paid.status, 200, paid.text);

  // After paying: the checkout page, a new booking and paying the twin are all refused.
  const again = await c.req(`/checkout/${quoteId}`);
  assert.equal(again.status, 409);
  assert.match(again.text, new RegExp(`already booked \\(Trip ID ${ref}\\)\\. Nothing more was charged\\.`));
  assert.match(again.text, new RegExp(`href="/manage\\?ref=${ref}">Find your booking`));
  const third = await c.req('/api/bookings', { method: 'POST', json: { quoteId, traveler } });
  assert.equal(third.status, 409);
  assert.equal(third.json().error.code, 'already_booked');
  const payTwin = await c.req(`/api/bookings/${twin.json().booking.ref}/pay`, { method: 'POST', json: { method: CARD } });
  assert.equal(payTwin.status, 409, payTwin.text);
  assert.equal(payTwin.json().error.code, 'already_booked');

  // Find your booking: the reference is filled in.
  const manage = await c.req(`/manage?ref=${ref.toLowerCase()}`);
  assert.match(manage.text, new RegExp(`name="ref"[^>]*value="${ref}"`));
  // A booking link opened without its cookie asks for the email instead of a 404 dead end.
  const other = client(app.base);
  const opened = await other.req(`/booking/${ref}`);
  assert.equal(opened.status, 404);
  assert.match(opened.text, /To open this booking here, enter the email you booked with\./);
  assert.match(opened.text, new RegExp(`value="${ref}"`));
});

test('sign-in only ever returns to a page on this site', async t => {
  const app = await startApp();
  t.after(() => app.close());
  let n = 0;
  const signup = async next => {
    const r = await client(app.base).req('/signup', { method: 'POST', form: { name: 'Ada Lovelace', email: `ada${++n}@example.com`, password: 'correct horse battery', next } });
    assert.equal(r.status, 303, r.text.slice(0, 200));
    return r.location;
  };
  assert.equal(await signup('/plan?b=1500'), '/plan?b=1500');
  assert.equal(await signup('//evil.example'), '/my-trips');
  assert.equal(await signup('/\\evil.example'), '/my-trips');
  assert.equal(await signup('/%5Cevil.example'), '/%5Cevil.example', 'an encoded backslash is a path here, not another site');
  assert.equal(await signup('https://evil.example'), '/my-trips');
});

test('common and old addresses redirect; accented destinations have plain addresses; robots blocks only search results', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const c = client(app.base);
  const moved = { '/help': '/faq', '/support': '/contact', '/terms': '/legal/terms', '/privacy': '/legal/privacy', '/cookies': '/legal/cookies', '/refunds': '/legal/refunds', '/cancellation': '/legal/cancellation', '/login': '/signin', '/register': '/signup', '/account': '/my-trips', '/trips-to-reykjav-k': '/trips-to-reykjavik' };
  for (const [from, to] of Object.entries(moved)) {
    const r = await c.req(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, to, from);
  }
  assert.equal((await c.req('/trips-to-reykjavik')).status, 200);
  assert.match((await c.req('/sitemap.xml')).text, /\/trips-to-reykjavik</);
  const robots = (await c.req('/robots.txt')).text;
  assert.match(robots, /^Disallow: \/trips\?$/m);
  assert.match(robots, /^Disallow: \/trips\$$/m);
  assert.doesNotMatch(robots, /^Disallow: \/trips$/m, 'a bare /trips prefix would also hide /trips-to-… and /trips-under-…');
});

test('no trip under the rules: every way forward is a link, including keeping the rules and watching', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await client(app.base).req(`/trips?${new URLSearchParams({ ...QUERY, b: '150' })}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /We couldn’t build a trip under your current rules for \$150/);
  assert.match(r.text, /href="\/plan\?[^"]*">Change airport</);
  const watch = r.text.match(/href="(\/hunts\/new\?[^"]*)">Keep my rules and watch</);
  assert.ok(watch, 'keep my rules and watch');
  const params = new URLSearchParams(watch[1].split('?')[1].replace(/&amp;/g, '&'));
  assert.equal(params.get('budget'), '150');
  assert.equal(params.get('from'), 'SFO');
  assert.equal(params.get('style'), 'beach');
});

test('too many requests: a page with a way back, and JSON for the API', async t => {
  const app = await startApp();
  t.after(() => app.close());
  const c = client(app.base);
  let last;
  for (let i = 0; i < 41; i++) last = await c.req('/manage', { method: 'POST', form: { ref: 'TX-NOPE', email: 'a@example.com' } });
  assert.equal(last.status, 429);
  assert.match(last.type, /text\/html/);
  assert.match(last.text, /Please wait a moment/);
  assert.match(last.text, /href="\/">Back to home/);
  const api = await c.req('/api/messages', { method: 'POST', json: { kind: 'support', name: 'Ada', email: 'ada@example.com', message: 'Hello there' } });
  assert.equal(api.status, 429);
  assert.equal(api.json().error.code, 'rate_limited');
});
