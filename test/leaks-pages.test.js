// THE MONEY LEAK HUNTER's pages, through HTTP: the Money Leak page renders every section for a trip
// found by scanning the inventory, its breakdown rows sum to the total on the page, every REMOVE link
// is a token that prices to exactly the amount shown, the lean and biggest-leak links price to the
// totals shown, the cut-in-order walk is priced step by step, the rules travel on the links, the
// review page shows the savings check and the money leak check (with the engine's own finding), the
// quote keeps the asks and the booking page shows the victory numbers (max − total) with only the
// stated asks the booked trip's facts meet; nothing optional is preselected and no page pressures.
// No dollar figure is hard-coded: every number is read from the inventory or priced by the service.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { lineAmount, classifyChanges } = require('../server/trips/facts');
const { addDays, today } = require('../server/lib/dates');
const { leakCheckPanel } = require('../server/views/trips/leaks');
const { format } = require('../server/lib/money');
const optimizer = require('../server/trips/optimizer');
const leaks = require('../server/trips/leaks');

const money = c => format(c, 'USD');
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
// Words no page may carry: no urgency, no scarcity, no predictions (the hunts pages' own list).
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict)\b/i;
const noInline = (p, body) => { assert.ok(!/\sstyle="/.test(body), `${p} inline style`); assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${p} inline script`); };
const CARD = { type: 'test_card', number: '4242424242424242', expMonth: '12', expYear: '35', cvc: '123', name: 'Ada Lovelace' };
const TRAVELER = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };
const QUERY = { b: '2000', k: '0', from: 'NYC', who: 'couple', when: 'anytime', nights: '5', style: 'beach', prio: 'price' };
// A fixed hour, so a test that runs near midnight UTC never prices two days.
function fixedClock() { const d = new Date(); d.setUTCHours(9, 0, 0, 0); return d; }
const sum = xs => xs.reduce((n, x) => n + x, 0);
const cents = (html, re = /data-cents="(-?\d+)"/g) => [...html.matchAll(re)].map(m => Number(m[1]));

// A browser-like client: keeps cookies, follows nothing, sends same-origin form posts.
function client(base) {
  const jar = {};
  const req = async (path, { method = 'GET', form, json, headers = {} } = {}) => {
    const h = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'sec-fetch-site': 'same-origin', ...headers };
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) { const [kv, ...rest] = sc.split(';'); const [k, v] = kv.split('='); if (!v || rest.some(x => /Max-Age=0/i.test(x))) delete jar[k]; else jar[k] = v; }
    const t = await res.text();
    return { status: res.status, location: res.headers.get('location'), text: t, json: () => JSON.parse(t) };
  };
  return { req, jar };
}

// A trip with everything optional in it, from the search's own pick: a fare that sells a bag (so the
// bag is a bought add-on), two experiences, the transfer and the bag. Every price is the app's own.
async function loadedTrip(app) {
  const svc = app.tripService;
  const { query, missing } = svc.parse(QUERY);
  assert.deepEqual(missing, []);
  const result = await svc.search(query, { visitor: 'test', user: null });
  const pick = result.picks[0].trip;
  const fare = pick.flight.checkedBagIncluded ? pick.flightOptions.find(f => !f.checkedBagIncluded && f.bagFeePerTraveler > 0).id : pick.spec.flight;
  const loaded = await svc.price({ ...pick.spec, flight: fare, transfer: true, bags: true, activities: pick.activityOptions.slice(0, 2).map(a => a.id).sort() });
  assert.ok(loaded && loaded.activities.length === 2 && loaded.transfer && lineAmount(loaded, 'bags') > 0, 'the pick carries two experiences, a transfer and a bought bag');
  return { loaded, token: encodeSpec(loaded.spec) };
}

test('the Money Leak page: every section, rows that sum, links that price to the amounts shown, rules on the links, nothing preselected, no pressure', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { loaded, token } = await loadedTrip(app);
  const cxq = 'b=2000&style=beach&nights=5';
  const page = await c.req(`/trip/${token}/leaks?${cxq}`);
  assert.equal(page.status, 200);
  const body = page.text, plain = text(body);
  noInline('/leaks', body);
  assert.doesNotMatch(plain, PRESSURE);
  assert.match(body, /<title>What you don(?:'|&#39;)t need to pay for/);

  // Every section, in the contract's order, and the spec's words where it uses them as labels.
  const ids = ['paying', 'extras', 'lean', 'removeOne', 'leak', 'free', 'cut', 'fees', 'bags', 'seats', 'meals', 'transfers', 'notCompared'];
  const at = ids.map(id => body.indexOf(`id="${id}"`));
  at.forEach((i, k) => { assert.ok(i > 0, ids[k]); if (k) assert.ok(i > at[k - 1], `${ids[k]} after ${ids[k - 1]}`); });
  for (const words of [leaks.SIGNATURE, 'What am I paying for?', 'No mystery line items', 'YOU DO NOT NEED THESE TO BOOK', 'STRIP IT DOWN', 'CURRENT', 'LEAN', 'DIFFERENCE', 'WHAT YOU GIVE UP', 'Customer decides', 'ADD BACK WHAT\'S WORTH IT', 'REMOVE ONE THING', 'FIND MY BIGGEST MONEY LEAK', 'FREE SAVINGS', 'Cut it in order', 'ROOM PRICE', 'MANDATORY FEES', 'REAL HOTEL TOTAL', 'Parking: not in our data (needs verification)', 'No seat selection fee is in this price', 'One shared checked bag', 'No rental car is in this trip', 'Not compared here', 'Booking-channel comparison', 'Promo codes']) assert.ok(plain.includes(words), words);
  assert.doesNotMatch(plain, /sit(?:ting)? together/i);

  // 1. The breakdown rows sum to the total on the page, and each row's money is its own cents.
  const bd = body.match(/<table class="tb-leak-table tb-leak-breakdown">[\s\S]*?<\/table>/)[0];
  const total = Number(bd.match(/data-total="(\d+)"/)[1]);
  assert.equal(total, loaded.total);
  assert.equal(sum(cents(bd)), total, 'the rows on the page add up to the total');
  for (const m of bd.matchAll(/<tr class="is-\w+" data-cents="(-?\d+)">[\s\S]*?<td class="tb-leak-num">([^<]+)<\/td>/g)) { const n = Number(m[1]); assert.equal(m[2], `${n < 0 ? '−' : ''}${money(Math.abs(n))}`); }
  assert.ok(bd.includes(`<td class="tb-leak-num">${money(total)}</td>`));
  for (const a of loaded.activities) assert.ok(bd.includes(`<b>${a.name}</b>`), a.name);
  assert.match(bd, /Tripelyx service fee \(platform fee\)/);

  // 2. Every REMOVE link is a version without that item: its token prices to exactly the amount shown.
  const removes = [...body.matchAll(/<li id="extra-[^"]+" data-cents="(\d+)" data-key="([^"]+)">[\s\S]*?<a class="btn btn-ghost btn-sm" href="\/trip\/([^/"]+)\/leaks\?[^"]*" data-remove="/g)].map(m => ({ amount: Number(m[1]), key: m[2], token: m[3] }));
  assert.equal(removes.length, 4, 'two experiences, the transfer and the bought bag are each removable');
  for (const r of removes) {
    const p = await svc.price(decodeSpec(r.token));
    assert.equal(loaded.total - p.total, r.amount, `${r.key}: the saving shown is the difference of the two priced totals`);
    assert.ok(body.includes(`REMOVE · ${money(p.total)} without it`), `${r.key}: the total without it is the priced total`);
    const without = p.spec;
    if (r.key === 'transfer') assert.equal(without.transfer, false);
    else if (r.key === 'bags') assert.equal(without.bags, false);
    else assert.ok(!without.activities.includes(r.key.slice('experience:'.length)));
  }
  assert.equal(body.match(/>KEEP<\/a>/g).length, removes.length, 'every removable item has a Keep anchor that changes nothing');
  assert.ok(!/<input[^>]*\schecked\b/.test(body) && !/<option[^>]*\sselected\b/.test(body), 'nothing optional is preselected');

  // 3. Strip it down: the lean link prices to the lean total shown; the difference is the sum of the removed extras.
  const leanTok = body.match(/data-lean="([^"]+)"/)[1];
  const leanTrip = await svc.price(decodeSpec(leanTok));
  assert.deepEqual(leanTrip.activities, []); assert.equal(leanTrip.transfer, null); assert.equal(lineAmount(leanTrip, 'bags'), 0);
  assert.deepEqual({ ...leanTrip.spec, activities: loaded.spec.activities, transfer: true, bags: true }, loaded.spec, 'the same flights, hotel, dates and nights');
  assert.ok(plain.includes(`CURRENT ${money(loaded.total)} LEAN ${money(leanTrip.total)} DIFFERENCE ${money(loaded.total - leanTrip.total)}`));
  assert.ok(body.includes(`Take the lean version · ${money(leanTrip.total)}`));
  for (const a of loaded.activities) assert.ok(plain.includes(a.name));
  assert.match(plain, /WORTH CONSIDERING|I'D KEEP THE \$/);
  const addBacks = [...body.matchAll(/Add it back · ([^<]+)<\/a>/g)].map(m => m[1]);
  assert.equal(addBacks.length, 4, 'each removed item can be added back to the lean version on its own');

  // 4 and 5. Remove one thing and the biggest leak: each link's token prices to the total shown.
  const one = body.match(/REMOVE IT · ([^<]+)<\/a>/);
  assert.ok(one, 'two experiences nothing stated asks for: one is the lowest-value item');
  const oneTok = body.match(/href="\/trip\/([^/"]+)\/leaks\?[^"]*#extras">REMOVE IT/)[1];
  assert.equal(money((await svc.price(decodeSpec(oneTok))).total), one[1]);
  assert.match(plain, /I'd remove .+\. Save \$[\d,.]+\. Everything else remains\./);
  const leakTok = body.match(/data-leak="([^"]+)"/)[1];
  const leakTrip = await svc.price(decodeSpec(leakTok));
  assert.ok(plain.includes(`BIGGEST AVOIDABLE COST: `));
  assert.ok(new RegExp(`data-leak="${leakTok}">SHOW ME THE [^<]*VERSION[^<]* · ${money(leakTrip.total).replace(/[$.]/g, '\\$&')}</a>`).test(body), 'show me the version: its total is the priced total');
  assert.ok(plain.includes(`Potential difference ${money(loaded.total - leakTrip.total)}`) || plain.includes(`Potential difference: ${money(loaded.total - leakTrip.total)}`));
  // What the version gives up is said from the facts of the two priced versions: "nothing is given
  // up" only when classifyChanges has no trade-off row; an extra names itself and that nothing
  // stated asks for it (the ranking's preference judgement is never passed off as a fact).
  const leakBlock = text(body.slice(body.indexOf('id="leak"'), body.indexOf('id="free"')));
  if (classifyChanges(loaded, leakTrip).tradeoffs.length) assert.doesNotMatch(leakBlock, /Nothing is given up by the facts/);
  else assert.match(leakBlock, /Nothing is given up by the facts of the two versions/);
  const big = leaks.biggestLeak(svc.inv, loaded, await svc.settings(), svc.leakContext(optimizer.parseContext({ b: '2000', style: 'beach', nights: '5' })), svc.leakOptions(loaded, optimizer.parseContext({ b: '2000', style: 'beach', nights: '5' })));
  assert.equal(big.token, leakTok);
  if (big.kind === 'extra') assert.ok(leakBlock.includes(`You give up: ${big.label}; nothing you told me asks for it.`), leakBlock);

  // 6. Free savings and the trade-off version are two blocks, never one number.
  assert.ok(body.indexOf('id="free-savings"') < body.indexOf('id="sacrifice-savings"'));
  const free = body.match(/Take the free savings · ([^<]+)<\/a>/), sac = body.match(/Take the trade-off version · ([^<]+)<\/a>/);
  if (free) {
    assert.match(plain, /FREE SAVINGS: /);
    const freeTok = body.match(/href="\/trip\/([^/"?]+)\?[^"]*">Take the free savings/)[1];
    const freeTotal = (await svc.price(decodeSpec(freeTok))).total;
    assert.equal(money(freeTotal), free[1], 'the free version prices to the total shown');
    assert.ok(plain.includes(`you keep ${money(loaded.total - freeTotal)} more`), 'what you keep is the difference of the two priced totals');
  }
  if (sac) assert.match(plain, /SAVE ANOTHER \$[\d,.]+, but: /);
  if (!free) assert.match(plain, /No version of this trip with nothing given up is priced materially lower/);

  // 7. Cut it in order: the form, then the steps priced one by one; the running totals are priced totals.
  assert.match(body, /<input id="cut-amount" name="cut"[^>]*>/);
  assert.ok(!/<input id="cut-amount"[^>]*value="[^"]/.test(body), 'no amount is filled in for the traveler');
  const transfer = removes.find(r => r.key === 'transfer');
  const cutDollars = Math.ceil(transfer.amount / 100);
  const cutPage = await c.req(`/trip/${token}/leaks?${cxq}&cut=${cutDollars}`);
  assert.equal(cutPage.status, 200);
  const cutText = text(cutPage.text);
  assert.ok(cutText.includes(`Cutting ${money(cutDollars * 100)}, to ${money(loaded.total - cutDollars * 100)} or under`));
  const steps = cutPage.text.match(/<table class="tb-leak-table tb-leak-steps">[\s\S]*?<\/table>/);
  assert.ok(steps, 'an optional extra alone covers it, so at least one step was priced');
  const savings = cents(steps[0]);
  const seen = [...steps[0].matchAll(/href="\/trip\/([^/"?]+)\?[^"]*">see it<\/a>/g)].map(m => m[1]);
  assert.equal(seen.length, savings.length);
  let running = loaded.total;
  for (let i = 0; i < seen.length; i++) { const p = await svc.price(decodeSpec(seen[i])); assert.equal(running - p.total, savings[i], `step ${i + 1}: the saving is the difference of two priced totals`); assert.ok(steps[0].includes(`${money(p.total)} <a`)); running = p.total; }
  assert.ok(running <= loaded.total - cutDollars * 100, 'reached');
  const take = cutPage.text.match(/Take this version · ([^<]+)<\/a>/);
  assert.ok(take && take[1] === money(running));
  assert.match(cutText, /Rules and locks were never relaxed/);
  assert.match(cutText, /Optional extras: Removed /);
  assert.doesNotMatch(cutText, PRESSURE);
  assert.ok((await c.req(`/trip/${token}/leaks?${cxq}&cut=soon`)).status === 200, 'an unreadable amount runs no cut and shows the page');

  // The rules travel: nonstop and 4-star on the link are on every link out, and the lean version names them as kept.
  const ruled = await c.req(`/trip/${token}/leaks?${cxq}&ns=1&stars=4`);
  assert.equal(ruled.status, 200);
  // Each rule is sorted by the trip's own facts: kept when met, otherwise under "Not met by this trip" with why.
  const rt = text(ruled.text);
  assert.ok(rt.includes(loaded.flight.stops === 0 ? 'Nonstop flights (a rule you set)' : `Nonstop flights (a rule you set; this trip has ${loaded.flight.stops} stop`), 'the nonstop rule by the fare\'s facts');
  assert.ok(rt.includes(loaded.hotel.stars >= 4 ? '4-star or better (a rule you set)' : `4-star or better (a rule you set; this hotel is ${loaded.hotel.stars}-star`), 'the stars rule by the hotel\'s facts');
  if (loaded.flight.stops > 0 || loaded.hotel.stars < 4) assert.match(rt, /Not met by this trip/);
  assert.ok(ruled.text.match(/href="\/trip\/[^"]*ns=1[^"]*"/), 'links keep the rules');
  const cx = optimizer.parseContext({ b: '2000', ns: '1', stars: '4' });
  assert.deepEqual(cx.rules, { nonstop: true, minStars: 4, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false });
  assert.match(optimizer.contextParams(cx), /ns=1&stars=4/);
  assert.equal(optimizer.parseContext({ b: '2000' }).rules, null);
  // A transfer rule: the transfer is listed as a rule you set, with no Remove link, and stays in the lean version.
  const tr = await c.req(`/trip/${token}/leaks?${cxq}&tr=1`);
  const row = tr.text.match(/<li id="extra-transfer"[\s\S]*?<\/li>/)[0];
  assert.match(row, /a rule you set/); assert.doesNotMatch(row, /data-remove="transfer"/);
  assert.equal((await svc.price(decodeSpec(tr.text.match(/data-lean="([^"]+)"/)[1]))).spec.transfer, true);
  assert.ok(text(tr.text).includes('Airport transfer (a rule you set)'));

  // The trip page carries the three buttons, each to this page.
  const tp = await c.req(`/trip/${token}?${cxq}`);
  for (const [words, hash] of [['What am I paying for?', 'paying'], ['Strip it down', 'lean'], ['Find my biggest money leak', 'leak']]) assert.ok(tp.text.includes(`href="/trip/${token}/leaks?${cxq.replace(/&/g, '&amp;')}#${hash}">`) && tp.text.includes(words), words);
});

test('the review page shows the savings check and the money leak check; the quote keeps the asks; the booking page shows the victory numbers and only the rules the trip meets', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { loaded, token } = await loadedTrip(app);
  const settings = await svc.settings();
  const budget = (Math.ceil(loaded.total / 100) + 300) * 100;
  const cxq = `b=${budget / 100}&nights=5&ns=1&stars=4&style=beach`;
  const cx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(cxq)));
  const review = await c.req(`/trip/${token}/review?${cxq}&seen=0`);
  assert.equal(review.status, 200);
  const plain = text(review.text);
  noInline('/review', review.text);
  // The review page's own "we don't predict where it goes" is a denial the blunt regex would catch;
  // the sweep covers the sections this slice adds.
  assert.doesNotMatch(text(review.text.slice(review.text.indexOf('id="savings-check"'), review.text.indexOf('<form class="tb-confirm"'))), PRESSURE);
  assert.doesNotMatch(text(review.text.match(/<details class="tb-leak-details"[\s\S]*?<\/details>/)[0]), PRESSURE);

  // (a) YOUR SAVINGS CHECK: the scorecard with no history.
  assert.ok(plain.includes(`YOUR SAVINGS CHECK MAX BUDGET ${money(budget)} CURRENT TRIP ${money(loaded.total)} BUDGET NOT USED ${money(budget - loaded.total)}`));
  assert.doesNotMatch(plain, /Removed extras|Date difference|Flight difference|Hotel difference/);
  // (b) MONEY LEAK CHECK: the six checks with status words, then the completion sentence; the engine's
  // own finding is the REMOVE link (two experiences nothing stated asks for, so one is found).
  for (const label of ['Optional add-ons', 'Paid twice', 'Bags', 'Transport', 'Taxes and fees', 'Same trip, priced lower']) assert.ok(plain.includes(label), label);
  assert.match(plain, /Taxes and fees OK Taxes, mandatory fees and the resort fee are in the total\./);
  assert.match(plain, /MONEY LEAK CHECK COMPLETE\. I found one more optional \$[\d,.]+ you can remove: /);
  const scan = leaks.finalScan(svc.inv, loaded, settings, svc.leakContext(cx), svc.leakOptions(loaded, cx));
  assert.ok(scan.found, 'the engine finds the experience');
  assert.ok(review.text.includes(`href="/trip/${scan.found.token}/review?${optimizer.contextParams(cx, { seen: scan.found.total }).replace(/&/g, '&amp;')}"`), 'REMOVE links to the version without it, with its rules, re-checked on arrival');
  assert.ok(plain.includes(`REMOVE ${money(scan.found.amount)} · ${money(scan.found.total)} without it`));
  assert.ok(plain.includes('KEEP IT'));
  assert.equal((await svc.price(decodeSpec(scan.found.token))).total, scan.found.total);
  assert.equal(loaded.total - scan.found.total, scan.found.amount);
  // Taking the link lands on a review of that version at its own price, with the check run again.
  const without = await c.req(`/trip/${scan.found.token}/review?${cxq}&seen=${scan.found.total}`);
  assert.equal(without.status, 200); assert.match(without.text, /your price is still/); assert.match(text(without.text), /MONEY LEAK CHECK COMPLETE/);
  // (c) "What am I paying for?" folded under the trip, its rows summing to the total.
  const details = review.text.match(/<details class="tb-leak-details" id="paying"><summary>What am I paying for\?<\/summary>[\s\S]*?<\/details>/);
  assert.ok(details);
  assert.equal(sum(cents(details[0])), loaded.total); assert.equal(Number(details[0].match(/data-total="(\d+)"/)[1]), loaded.total);
  // Without a budget, only the current trip; over the maximum, the overrun by name.
  const noBudget = text((await c.req(`/trip/${token}/review?seen=0`)).text);
  assert.ok(noBudget.includes(`YOUR SAVINGS CHECK CURRENT TRIP ${money(loaded.total)}`) && !noBudget.includes('MAX BUDGET') && !noBudget.includes('BUDGET NOT USED'));
  const overBy = Math.max(100, Math.floor(loaded.total / 100) - 100);
  const over = text((await c.req(`/trip/${token}/review?b=${overBy}&ov=10&seen=0`)).text);
  assert.ok(over.includes(`OVER YOUR MAX ${money(loaded.total - overBy * 100)}`) && !over.includes('BUDGET NOT USED'));

  // The quote keeps the asks (the rules travel through the review form), then the booking is paid.
  const approvedTotal = Number(review.text.match(/name="approvedTotal" value="(\d+)"/)[1]);
  assert.equal(approvedTotal, loaded.total);
  const cxField = review.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
  assert.match(cxField, /ns=1/); assert.match(cxField, /stars=4/); assert.match(cxField, /nights=5/);
  const q = await c.req(`/trip/${token}/quote`, { method: 'POST', form: { approvedTotal, cx: cxField, promo: '' } });
  assert.equal(q.status, 303, q.text);
  const quoteId = q.location.split('/').pop();
  const quote = await app.store.getQuote(quoteId);
  assert.equal(quote.budget.budget, budget);
  assert.deepEqual(quote.budget.asks.rules, { nonstop: true, minStars: 4, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false });
  assert.equal(quote.budget.asks.nightsAsked, 5); assert.equal(quote.budget.asks.style, 'beach'); assert.equal(quote.budget.asks.priority, null, 'the default is not an ask');
  assert.equal(quote.budget.asks.dest, null, 'no destination was asked: the trip\'s own destination is not written down as an ask');
  assert.equal(quote.budget.asks.nonstop, true, 'the rules are also flat on the asks, so either reader finds them');
  // A destination the traveler named, on the context or in the search it came from, is an ask.
  for (const extra of [`&dest=${loaded.dest.id}`, `&s=${encodeURIComponent(`dest=${loaded.dest.id}`)}`, `&s=${encodeURIComponent(`ds=${loaded.dest.id}`)}`]) {
    const qd = await c.req(`/trip/${token}/quote`, { method: 'POST', form: { approvedTotal, cx: cxField + extra, promo: '' } });
    assert.equal(qd.status, 303, qd.text);
    assert.equal((await app.store.getQuote(qd.location.split('/').pop())).budget.asks.dest, loaded.dest.name, extra);
  }
  assert.equal((await app.store.getQuote((await c.req(`/trip/${token}/quote`, { method: 'POST', form: { approvedTotal, cx: cxField + `&s=${encodeURIComponent('ds=a,b')}`, promo: '' } })).location.split('/').pop())).budget.asks.dest, null, 'a list of destinations is not one destination asked');
  const created = await c.req('/api/bookings', { method: 'POST', json: { quoteId, traveler: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' } } });
  assert.equal(created.status, 201, created.text);
  const booking = created.json().booking;
  assert.equal(booking.total, loaded.total);
  const paid = await c.req(`/api/bookings/${booking.ref}/pay`, { method: 'POST', json: { method: CARD } });
  assert.equal(paid.status, 200, paid.text);

  // The booking page: YOU GAVE US / YOUR TRIP / YOU KEPT equal max − total, AND YOU KEPT only the
  // stated asks the trip's facts meet, an unmet ask under Not kept, nothing unstated listed.
  const page = await c.req(`/booking/${booking.ref}`);
  assert.equal(page.status, 200);
  const bp = text(page.text);
  noInline('/booking', page.text);
  assert.doesNotMatch(bp, PRESSURE);
  assert.ok(bp.includes(`YOU GAVE US ${money(budget)} max YOUR TRIP ${money(booking.total)} YOU KEPT ${money(budget - booking.total)}`), bp.slice(0, 2000));
  assert.ok(bp.includes(`under your ${money(budget)} budget`));
  assert.ok(bp.includes('AND YOU KEPT'));
  const v = leaks.victory({ max: budget, trip: quote.trip, asks: quote.budget.asks });
  assert.equal(v.kept, budget - booking.total);
  for (const r of v.keptRules) assert.ok(bp.includes(r), `kept: ${r}`);
  for (const r of v.notKept) assert.ok(bp.includes(r), `not kept: ${r}`);
  assert.equal(bp.includes('Not kept'), v.notKept.length > 0);
  // The facts decide, by the trip's own data.
  assert.ok(v.keptRules.includes('5 nights'));
  if (loaded.flight.stops === 0) assert.ok(v.keptRules.includes('Nonstop')); else assert.ok(v.notKept.some(r => r.startsWith('Nonstop (this trip has')));
  if (loaded.hotel.stars >= 4) assert.ok(v.keptRules.includes('Your hotel requirement: 4-star or better')); else assert.ok(v.notKept.some(r => r.startsWith('Your hotel requirement: 4-star or better (this hotel is')));
  assert.ok(![...v.keptRules, ...v.notKept].some(r => /Your destination/.test(r)) && !bp.includes('Your destination'), 'a destination never asked is not listed as kept');
  assert.ok(![...v.keptRules, ...v.notKept].some(r => /All-inclusive|Breakfast|Beachfront|Refundable|Airport transfers/.test(r)), 'rules never stated are not listed');
  assert.doesNotMatch(bp, /Great choice/);

  // Over the maximum, approved: YOU WENT OVER BY, which you approved; no "kept" number.
  const overReview = await c.req(`/trip/${token}/review?b=${overBy}&ov=10&seen=0`);
  const overCx = overReview.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
  const q2 = await c.req(`/trip/${token}/quote`, { method: 'POST', form: { approvedTotal, cx: overCx, promo: '' } });
  assert.equal(q2.status, 303, q2.text);
  const b2 = (await c.req('/api/bookings', { method: 'POST', json: { quoteId: q2.location.split('/').pop(), traveler: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' } } })).json().booking;
  assert.equal((await c.req(`/api/bookings/${b2.ref}/pay`, { method: 'POST', json: { method: CARD } })).status, 200);
  const overPage = text((await c.req(`/booking/${b2.ref}`)).text);
  assert.ok(overPage.includes(`YOU GAVE US ${money(overBy * 100)} max YOUR TRIP ${money(b2.total)} YOU WENT OVER BY ${money(b2.total - overBy * 100)}`));
  assert.ok(overPage.includes(`YOU WENT OVER BY ${money(b2.total - overBy * 100)}, which you approved`));
  assert.ok(!/YOU KEPT \$/.test(overPage) && !overPage.includes('under your'));
  assert.doesNotMatch(overPage, PRESSURE);

  // Money protected for the destination: the review's check and the victory say the whole number the
  // traveler gave and the protected part, as the trips page does; YOU KEPT is the booking money unspent.
  const keep = 50000, whole = budget + keep;
  const kReview = await c.req(`/trip/${token}/review?b=${budget / 100}&k=${keep / 100}&nights=5&seen=0`);
  assert.ok(text(kReview.text).includes(`MAX BUDGET ${money(budget)}`) && text(kReview.text).includes(`The ${money(budget)} is the booking's share of the ${money(whole)} you gave: ${money(keep)} is protected for the destination`));
  const kCx = kReview.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
  const q3 = await c.req(`/trip/${token}/quote`, { method: 'POST', form: { approvedTotal, cx: kCx, promo: '' } });
  assert.equal(q3.status, 303, q3.text);
  const b3 = (await c.req('/api/bookings', { method: 'POST', json: { quoteId: q3.location.split('/').pop(), traveler: TRAVELER } })).json().booking;
  assert.equal((await c.req(`/api/bookings/${b3.ref}/pay`, { method: 'POST', json: { method: CARD } })).status, 200);
  const kPage = text((await c.req(`/booking/${b3.ref}`)).text);
  assert.ok(kPage.includes(`YOU GAVE US ${money(whole)} max for the booking ${money(budget)}, ${money(keep)} protected YOUR TRIP ${money(b3.total)} YOU KEPT ${money(budget - b3.total)}`), kPage.slice(kPage.indexOf('YOU GAVE US'), kPage.indexOf('YOU GAVE US') + 300));
  assert.ok(kPage.includes(`under your ${money(budget)} booking budget, the booking's share of the ${money(whole)} you gave; the ${money(keep)} you protected for the destination was never part of the booking`));
  assert.ok(!kPage.includes(`YOU GAVE US ${money(budget)} max`), 'the booking\'s share is never called what the traveler gave');
  assert.doesNotMatch(kPage, PRESSURE);
});

// A promo code the review page verified rides on every link out of it and out of the leaks page, so a
// clicked REMOVE lands on the total it promised with the code still in the form, and the leaks page
// prices every version with the same code; a code the rules refuse is said and carried nowhere. A bag
// the traveler said they travel with is never offered as a leak.
test('the verified promo code travels with every link; a stated bag is never a leak', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { loaded, token } = await loadedTrip(app);
  await app.store.putRecord('promo', 'SAVE20', { code: 'SAVE20', type: 'amount', value: 2000, minTotal: 0, expiresAt: null, active: true, createdAt: new Date().toISOString(), by: 'test' });
  const promo = await svc.promo('SAVE20');
  const coded = await svc.price(loaded.spec, { promo });
  assert.ok(coded.total < loaded.total, 'the code takes something off');
  const cxq = 'b=5000&nights=5&style=beach';
  const review = await c.req(`/trip/${token}/review?${cxq}&seen=0&promo=SAVE20`);
  assert.equal(review.status, 200);
  assert.ok(text(review.text).includes(`your price is still ${money(coded.total)}`));
  // The check's control: its token prices, with the code, to the total it names; the link carries the code.
  const ctl = review.text.match(/<a class="btn btn-navy" href="([^"]+)" data-found="([^"]+)">([^<]+)<\/a>/);
  assert.ok(ctl, 'the check finds the experience nothing stated asks for');
  const href = ctl[1].replace(/&amp;/g, '&');
  assert.match(href, /[?&]promo=SAVE20(&|$)/);
  const foundTok = href.match(/^\/trip\/([^/?]+)\/review\?/)[1];
  const without = await svc.price(decodeSpec(foundTok), { promo });
  assert.equal(Number(new URL(`http://x${href}`).searchParams.get('seen')), without.total);
  assert.equal(ctl[3], `REMOVE ${money(coded.total - without.total)} · ${money(without.total)} without it`);
  const landed = await c.req(href);
  assert.equal(landed.status, 200);
  assert.ok(text(landed.text).includes(`your price is still ${money(without.total)}`), 'no price change is announced: the code went with the link');
  assert.match(landed.text, /name="promo" maxlength="30" value="SAVE20"/);
  assert.match(landed.text.match(/name="cx" value="([^"]*)"/)[1], /promo=SAVE20/);
  // The leaks link carries the code; that page prices every total with it, says so, and every link out carries it.
  const leaksHref = review.text.match(/href="(\/trip\/[^"]+\/leaks\?[^"]*)">See everything/)[1].replace(/&amp;/g, '&');
  assert.match(leaksHref, /promo=SAVE20/);
  const lk = await c.req(leaksHref);
  assert.equal(lk.status, 200);
  const lp = text(lk.text);
  assert.ok(lp.includes(`This trip is ${money(coded.total)} all in`));
  assert.ok(lp.includes(`Promo code SAVE20 (${money(loaded.total - coded.total)} off) is in every total on this page`));
  assert.doesNotMatch(lp, PRESSURE);
  const hrefs = [...lk.text.matchAll(/href="(\/trip\/[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  assert.ok(hrefs.length > 5);
  for (const h of hrefs) assert.match(h, /[?&]promo=SAVE20(&|#|$)/, h);
  const bd = lk.text.match(/<table class="tb-leak-table tb-leak-breakdown">[\s\S]*?<\/table>/)[0];
  assert.equal(sum(cents(bd)), coded.total); assert.match(bd, /Promo code/);
  const rm = lk.text.match(/href="\/trip\/([^/"]+)\/leaks\?[^"]*" data-remove="([^"]+)">REMOVE · ([^<]+) without it/);
  assert.equal(money((await svc.price(decodeSpec(rm[1]), { promo })).total), rm[3], 'a REMOVE on the leaks page prices with the code to the total shown');
  // A trip page opened from here names the total with the code and sends it to the review as the one seen, which then says "still".
  const leanTok = lk.text.match(/data-lean="([^"]+)"/)[1];
  const leanCoded = await svc.price(decodeSpec(leanTok), { promo }), leanPlain = await svc.price(decodeSpec(leanTok));
  const tp = await c.req(`/trip/${leanTok}?${cxq}&promo=SAVE20`);
  assert.equal(tp.status, 200);
  assert.ok(text(tp.text).includes(`Book this trip · ${money(leanPlain.total)}`), 'the trip page prices before the code');
  assert.ok(text(tp.text).includes(`Promo code SAVE20 comes with you from the review page: ${money(leanPlain.total - leanCoded.total)} off, so ${money(leanCoded.total)} with it`));
  const tpReview = tp.text.match(/href="(\/trip\/[^"]+\/review\?[^"]*)">Book this trip/)[1].replace(/&amp;/g, '&');
  assert.match(tpReview, /promo=SAVE20/);
  assert.equal(Number(new URL(`http://x${tpReview}`).searchParams.get('seen')), leanCoded.total);
  assert.ok(text((await c.req(tpReview)).text).includes(`your price is still ${money(leanCoded.total)}`));
  // A code the rules refuse: said on the page, totals before any code, and carried on no link.
  const bad = await c.req(`/trip/${token}/leaks?${cxq}&promo=NOPE`);
  assert.equal(bad.status, 200);
  assert.ok(/isn.t valid/.test(text(bad.text)) && text(bad.text).includes(`This trip is ${money(loaded.total)} all in`));
  assert.ok(![...bad.text.matchAll(/href="(\/trip\/[^"]+)"/g)].some(m => /promo=/.test(m[1])), 'an invalid code is not carried');
  const badTrip = await c.req(`/trip/${token}?${cxq}&promo=NOPE`);
  assert.ok(/isn.t valid/.test(text(badTrip.text)) && !/promo=/.test(badTrip.text.match(/href="(\/trip\/[^"]+\/review\?[^"]*)">Book this trip/)[1]));
  // A changed price sends the traveler back with the code as typed, never with the code dropped.
  const stale = await c.req(`/trip/${token}/quote`, { method: 'POST', form: { approvedTotal: coded.total - 100, cx: review.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&'), promo: 'SAVE20' } });
  assert.equal(stale.status, 303); assert.match(stale.location, /promo=SAVE20/);

  // A stated bag (bg=checked on the link): the check never says nothing asks for it, the leaks page
  // lists it as not offered for removal, and the lean version keeps it.
  const bagged = text((await c.req(`/trip/${token}/review?${cxq}&prio=activities&bg=checked&seen=0`)).text);
  assert.doesNotMatch(bagged, /nothing you told me asks for a checked bag/);
  assert.doesNotMatch(bagged, /you can remove: Checked bag/);
  const unsaid = text((await c.req(`/trip/${token}/review?${cxq}&prio=activities&seen=0`)).text);
  assert.match(unsaid, /nothing you told me asks for a checked bag/, 'without a stated bag the check says so, as before');
  const bagPage = await c.req(`/trip/${token}/leaks?${cxq}&bg=checked`);
  const bagRow = bagPage.text.match(/<li id="extra-bags"[\s\S]*?<\/li>/)[0];
  assert.match(bagRow, /not offered for removal: you said you travel with a checked bag/); assert.doesNotMatch(bagRow, /data-remove="bags"/);
  assert.equal((await svc.price(decodeSpec(bagPage.text.match(/data-lean="([^"]+)"/)[1]))).spec.bags, true, 'the lean version keeps the stated bag');
  assert.match(bagPage.text.match(/href="\/trip\/[^"]*\/leaks\?([^"#]*)/)[1], /bg=checked/, 'the stated bag travels on the links');
  assert.deepEqual([optimizer.parseContext({ bg: '1' }).bags, optimizer.parseContext({ bg: 'carry-on' }).bags, optimizer.parseContext({ bg: 'x' }).bags], ['checked', 'carry-on', null]);
});

// A dream trip built around "I have to be there on <date>": the date is held on every link and no
// page moves it (cut-in-order skips the dates stage, no version offered leaves on another day); the
// destination the traveler named is an ask; a length and a priority the form never asked for are not.
test('a dream trip holds its fixed date everywhere, names its destination as an ask and writes down nothing unstated', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const depart = addDays(today(clock), 30);
  let found = null;
  for (const d of svc.inv.maps.listDestinations()) {
    const page = await c.req(`/dream?dest=${d.id}&b=6000&from=NYC&depart=${depart}`);
    if (page.status !== 200) continue;
    const m = /href="\/trip\/([^/"?]+)\?([^"#]*)[^"]*"/.exec(page.text);
    if (m) { found = { dest: d, token: m[1], cxq: m[2].replace(/&amp;/g, '&') }; break; }
  }
  assert.ok(found, 'a dream trip link');
  const params = new URLSearchParams(found.cxq);
  assert.equal(params.get('dm'), 'exact'); assert.equal(params.get('dest'), found.dest.id);
  assert.equal(params.get('nights'), null, 'the dream form never asked for a length'); assert.equal(params.get('prio'), null, 'the dream default is not a stated priority');
  const spec = decodeSpec(found.token);
  assert.equal(spec.depart, depart);
  const cx = optimizer.parseContext(Object.fromEntries(params));
  assert.equal(svc.leakContext(cx).dateMode, 'exact'); assert.equal(svc.leakOptions(await svc.price(spec), cx).locks.dates, true);
  const total = (await svc.price(spec)).total;
  const lk = await c.req(`/trip/${found.token}/leaks?${found.cxq}&cut=${Math.floor(total / 100) - 1}`);
  assert.equal(lk.status, 200);
  const lp = text(lk.text);
  assert.match(lp, /Nearby dates: [^.]*held/, 'the dates stage is skipped and says why');
  assert.doesNotMatch(lp, /Leaving \d{4}-\d{2}-\d{2} instead of/);
  const links = [...lk.text.matchAll(/href="\/trip\/([^/"?]+)\?([^"#]*)/g)];
  assert.ok(links.length > 5);
  for (const [, tok, q] of links) { assert.equal(decodeSpec(tok).depart, depart, 'no version offered moves the fixed date'); assert.match(q, /dm=exact/); assert.match(q, new RegExp(`dest=${found.dest.id}`)); }
  // The quote and the victory: the destination is an ask the trip meets; no length or priority is written down.
  const review = await c.req(`/trip/${found.token}/review?${found.cxq}&seen=0`);
  assert.equal(review.status, 200);
  const cxField = review.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
  assert.match(cxField, /dm=exact/); assert.doesNotMatch(cxField, /nights=/);
  const approvedTotal = Number(review.text.match(/name="approvedTotal" value="(\d+)"/)[1]);
  const q = await c.req(`/trip/${found.token}/quote`, { method: 'POST', form: { approvedTotal, cx: cxField, promo: '' } });
  assert.equal(q.status, 303, q.text);
  const quote = await app.store.getQuote(q.location.split('/').pop());
  assert.equal(quote.budget.asks.nightsAsked, null); assert.equal(quote.budget.asks.priority, null); assert.equal(quote.budget.asks.dest, found.dest.name);
  const v = leaks.victory({ max: quote.budget.budget, trip: quote.trip, asks: quote.budget.asks });
  assert.ok(v.keptRules.includes(`Your destination: ${found.dest.name}`));
  assert.ok(!v.keptRules.some(r => /night/.test(r)) && !v.notKept.length, 'nothing unstated is listed');
});

// cut= and the context keys are read as typed: a repeated key is its first value, never a joined
// number; cents are exact; a word, a zero or an amount at or above the total runs no cut and the page
// says which it was. A fare swap or the like-for-like version found by the check is never worded as a
// removal: the control says what that version is.
test('cut= and context keys as typed; the check\'s control is worded by what the version changes', async t => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const c = client(app.base), svc = app.tripService;
  const { loaded, token } = await loadedTrip(app);
  const page = async p => { const r = await c.req(`/trip/${token}/leaks?${p}`); assert.equal(r.status, 200, p); return { html: r.text, plain: text(r.text) }; };
  const r1 = await page('b=2000&cut=100&cut=200');
  assert.ok(r1.plain.includes(`Cutting ${money(10000)}, to ${money(loaded.total - 10000)} or under`), 'a repeated cut is its first value'); assert.match(r1.html, /id="cut-amount"[^>]*value="100"/);
  const r2 = await page('b=2000&cut=100.50');
  assert.ok(r2.plain.includes(`Cutting ${money(10050)}, to ${money(loaded.total - 10050)} or under`), 'cents are cut exactly, not rounded'); assert.match(r2.html, /id="cut-amount"[^>]*value="100.50"/);
  const r3 = await page('b=2000&cut=soon');
  assert.match(r3.plain, /I couldn't read "soon" as a dollar amount, so nothing was cut/); assert.doesNotMatch(r3.plain, /Cutting \$/);
  const r4 = await page('b=2000&cut=100.555');
  assert.match(r4.plain, /I couldn't read "100.555" as a dollar amount/, 'more than two decimals is refused, not rounded quietly');
  const r5 = await page('b=2000&cut=0');
  assert.match(r5.plain, /Cutting \$0 changes nothing, so nothing was cut/);
  const whole = Math.ceil(loaded.total / 100) + 1;
  const r6 = await page(`b=2000&cut=${whole}`);
  assert.ok(r6.plain.includes(`${money(whole * 100)} is more than the whole ${money(loaded.total)} price: nothing we sell is that cheap, so nothing was cut`)); assert.doesNotMatch(r6.plain, /to \$0 or under/);
  assert.match((await page('b=2000&cut=99999999999')).plain, /nothing we sell is that cheap/);
  assert.match((await page('b=2000&cut=1e9')).plain, /I couldn't read "1e9"/);
  // Repeated context keys: the first value on the page's links, never a joined number.
  const r7 = await page('nights=5&nights=6&b=100&b=200&stars=4&stars=5');
  const link = new URLSearchParams(r7.html.match(/href="\/trip\/[^"]*\/leaks\?([^"#]*)/)[1].replace(/&amp;/g, '&'));
  assert.deepEqual([link.get('b'), link.get('nights'), link.get('stars')], ['100', '5', '4']);
  const rep = optimizer.parseContext({ b: ['100', '200'], nights: ['5', '6'], stars: ['4', '5'], style: ['beach'], s: ['when=exact'] });
  assert.deepEqual([rep.budget, rep.nightsAsked, rep.rules.minStars, rep.style, rep.searchParams], [10000, 5, 4, 'beach', 'when=exact']);
  // The control's words, by what the found version changes, from priced tokens: a removal says REMOVE
  // and "without it"; a fare switch with the same bags says SWITCH FARE; the like-for-like version is
  // shown (its trip page), never "removed".
  const cx = optimizer.parseContext({ b: '2000' });
  const scanOf = found => ({ checks: [], text: 'x', complete: true, found });
  const noAct = await svc.price({ ...loaded.spec, activities: loaded.spec.activities.slice(1) });
  const removal = String(leakCheckPanel(scanOf({ key: 'addons', label: loaded.activities[0].name, amount: loaded.total - noAct.total, token: encodeSpec(noAct.spec), total: noAct.total }), { token, cx }));
  assert.ok(removal.includes(`REMOVE ${money(loaded.total - noAct.total)} · ${money(noAct.total)} without it`) && removal.includes(`href="/trip/${encodeSpec(noAct.spec)}/review?b=2000&amp;seen=${noAct.total}"`));
  const other = loaded.flightOptions.find(f => f.id !== loaded.spec.flight);
  const swapT = await svc.price({ ...loaded.spec, flight: other.id }), swapTok = encodeSpec(swapT.spec);
  const swap = String(leakCheckPanel(scanOf({ key: 'bags', label: `${other.name} fare instead of ${loaded.flight.name}`, amount: loaded.total - swapT.total, token: swapTok, total: swapT.total }), { token, cx }));
  assert.ok(swap.includes(`SWITCH FARE · ${money(swapT.total)}, the same bags`) && !swap.includes('without it') && swap.includes(`href="/trip/${swapTok}/review?b=2000&amp;seen=${swapT.total}"`));
  const cfg = String(leakCheckPanel(scanOf({ key: 'config', label: 'the same trip priced lower (like-for-like)', amount: loaded.total - swapT.total, token: swapTok, total: swapT.total }), { token, cx }));
  assert.ok(cfg.includes(`SHOW ME THE LIKE-FOR-LIKE VERSION · ${money(swapT.total)}`) && !cfg.includes('without it') && !/VERSION VERSION/.test(cfg) && cfg.includes(`href="/trip/${swapTok}?b=2000"`));
  assert.equal(`SHOW ME ${leaks.showWords({ alternativeLabel: 'Like-for-like version' }).toUpperCase()}`, 'SHOW ME THE LIKE-FOR-LIKE VERSION', 'the leaks page\'s button for a config leak');
  for (const h of [removal, swap, cfg]) assert.doesNotMatch(text(h), PRESSURE);
});
