// Travel by Budget: the trip engine (tokens, pricing, optimizer), the pages, and the full journey from
// budget to a confirmed trip, including price-change protection, partial bookings and the admin center.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { loadConfig } = require('../server/config');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { priceTrip, publicTrip, DEFAULT_SETTINGS } = require('../server/trips/pricing');
const optimizer = require('../server/trips/optimizer');
const decision = require('../server/trips/decision');
const { singleChanges } = require('../server/views/trips/trip');
const { addDays, today } = require('../server/lib/dates');
const { createTripIntegrations } = require('../server/trips/integrations');
const { vacationPlan } = require('../server/trips/vacation');

const inv = createTripIntegrations(loadConfig({ APP_ENV: 'development' }));
const QUERY = { b: '1500', k: '0', from: 'SFO', who: 'couple', when: 'anytime', nights: '5', style: 'beach', prio: 'hotel' };
const CARD = { type: 'test_card', number: '4242424242424242', expMonth: '12', expYear: '35', cvc: '123', name: 'Ada Lovelace' };

// A browser-like client: keeps cookies, follows nothing, sends same-origin form posts.
function client(base) {
  const jar = {};
  const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = async (path, { method = 'GET', form, json, headers = {} } = {}) => {
    const h = { cookie: cookies(), 'sec-fetch-site': 'same-origin', ...headers };
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) { const [kv, ...rest] = sc.split(';'); const [k, v] = kv.split('='); if (!v || rest.some(x => /Max-Age=0/i.test(x))) delete jar[k]; else jar[k] = v; }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  };
  return { req, jar };
}

async function buildTrip(c) {
  const results = await c.req(`/trips?${new URLSearchParams(QUERY)}`);
  assert.equal(results.status, 200);
  const m = results.text.match(/href="(\/trip\/[^"?]+)\?([^"]*)"/);
  const tripPath = m[1], cx = m[2].replace(/&amp;/g, '&');
  const review = await c.req(`${tripPath}/review?${cx}&seen=0`);
  assert.equal(review.status, 200);
  const approvedTotal = Number(review.text.match(/name="approvedTotal" value="(\d+)"/)[1]);
  const cxField = review.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
  return { tripPath, cx, approvedTotal, cxField };
}

async function quoteAndBook(c, trip, traveler = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }) {
  const q = await c.req(`${trip.tripPath}/quote`, { method: 'POST', form: { approvedTotal: trip.approvedTotal, cx: trip.cxField, promo: '' } });
  assert.equal(q.status, 303, q.text);
  assert.match(q.location, /^\/checkout\//);
  const quoteId = q.location.split('/').pop();
  assert.equal((await c.req(q.location)).status, 200);
  const created = await c.req('/api/bookings', { method: 'POST', json: { quoteId, traveler } });
  assert.equal(created.status, 201, created.text);
  return { quoteId, booking: created.json().booking };
}

test('trip tokens round-trip and reject garbage', () => {
  const spec = { dest: 'cancun', from: 'SFO', depart: '2027-03-02', nights: 5, travelers: 2, who: 'couple', hotel: 'cun-2', flight: 'nonstop', activities: ['cun-a1'], bags: true, transfer: false };
  assert.deepEqual(decodeSpec(encodeSpec(spec)), spec);
  assert.throws(() => decodeSpec('not~a~token'), e => e.code === 'trip_not_found' && e.status === 404);
});

test('pricing: lines add up, taxes and fees are inside the total, internals never leave the server', () => {
  const t = priceTrip(inv, { dest: 'cancun', from: 'SFO', depart: '2027-03-02', nights: 5, travelers: 2, who: 'couple', hotel: 'cun-2', flight: 'nonstop', activities: [], bags: false, transfer: true }, DEFAULT_SETTINGS);
  assert.ok(t, 'trip priced');
  assert.equal(t.lines.reduce((s, l) => s + l.amount, 0), t.total);
  assert.ok(t.lines.some(l => l.key === 'taxes') && t.lines.some(l => l.key === 'service'));
  assert.equal(t.perTraveler, Math.round(t.total / 2));
  assert.ok(t.internal.supplierCost < t.total);
  assert.equal(t.internal.grossProfit, t.total - t.internal.supplierCost - t.internal.processingCost - (t.internal.discount || 0));
  const pub = publicTrip(t);
  assert.equal(pub.internal, undefined);
  assert.ok(!JSON.stringify(pub).includes('supplierCost'));
});

test('optimizer: our pick, save more, an upgrade only if worth it (or keep your money); margin is not an input', () => {
  const settings = DEFAULT_SETTINGS;
  const { query, missing } = optimizer.parseSearch(QUERY, { maps: inv.maps });
  assert.deepEqual(missing, []);
  const r = optimizer.search(inv, query, { settings });
  assert.ok(r.picks.length >= 2 && r.picks.length <= 3, 'two or three answers');
  assert.deepEqual(r.picks.slice(0, 2).map(p => p.kind), ['our-pick', 'save-more']);
  assert.match(r.picks[0].why[0], /^Leaves \$[\d,]+ of your budget unspent$/);

  // The invariants, for every budget and priority: our pick is at or under the budget whenever
  // anything is; save more is cheaper; an upgrade improves something real and gives nothing up,
  // scores higher with the budget taken out, and costs at most 35% more; otherwise keepMoney says so.
  const check = (res, budget, cap, name) => {
    const kinds = res.picks.map(p => p.kind);
    assert.ok(kinds.every(k => ['our-pick', 'save-more', 'upgrade'].includes(k)), name);
    assert.equal(new Set(kinds).size, kinds.length, `${name}: one of each kind`);
    assert.equal(new Set(res.picks.map(p => JSON.stringify(p.trip.spec))).size, res.picks.length, `${name}: never the same package twice`);
    const ours = res.picks.find(p => p.kind === 'our-pick');
    if (!ours) { assert.equal(res.picks.length, 0, name); assert.ok(res.closest.length > 0 || res.considered === 0, name); return; }
    for (const p of res.picks) { assert.ok(p.trip.total <= cap, `${name}: ${p.kind} ${p.trip.total} <= ${cap}`); assert.ok(p.why.length >= 2 && p.match > 0 && p.label, name); }
    if (ours.over) assert.ok(ours.trip.total > budget && res.cheapestEligible.trip.total > budget, `${name}: over only when nothing fits the budget`);
    else assert.ok(ours.trip.total <= budget, `${name}: our pick ${ours.trip.total} <= ${budget}`);
    const save = res.picks.find(p => p.kind === 'save-more');
    if (save) assert.ok(save.trip.total < ours.trip.total && save.match >= 50, `${name}: save more really saves`);
    const up = res.picks.find(p => p.kind === 'upgrade');
    const plain = { ...res.ctx, budget: null };
    if (up) {
      const ch = decision.classifyChanges(ours.trip, up.trip);
      assert.ok(ch.improvements.length >= 1, `${name}: upgrade improves something`);
      assert.equal(ch.tradeoffs.length, 0, `${name}: upgrade gives nothing up`);
      assert.ok(optimizer.scoreTrip(up.trip, plain).match > optimizer.scoreTrip(ours.trip, plain).match, `${name}: upgrade scores higher without the budget`);
      assert.equal(up.upgrade.delta, up.trip.total - ours.trip.total, name);
      assert.ok(up.upgrade.delta > 0 && up.upgrade.delta <= ours.trip.total * 0.35, `${name}: worth it`);
      assert.ok(up.upgrade.improvements.some(i => ['hotel', 'flight', 'nights', 'area', 'meals', 'time'].includes(i.key)), `${name}: a real improvement`);
      assert.equal(up.upgrade.over, up.trip.total > budget, name);
      assert.ok(up.upgrade.gets && up.blurb.startsWith('+$'), name);
      if (/checked bags/.test(up.upgrade.gets)) assert.ok(up.trip.flight.checkedBagIncluded || up.trip.spec.bags, `${name}: "checked bags" only when they are in the price`);
      if (/carry-on bag/.test(up.upgrade.gets)) assert.ok(up.trip.flight.carryOn && !ours.trip.flight.carryOn, `${name}: "a carry-on bag" only when the pick had none`);
      assert.equal(res.keepMoney, null, name);
    } else {
      assert.ok(res.keepMoney, `${name}: keepMoney when no upgrade`);
      assert.equal(res.keepMoney.spare, budget - ours.trip.total, name);
      assert.ok(res.keepMoney.considered >= 0 && res.keepMoney.dear <= res.keepMoney.considered, name);
      assert.equal(res.keepMoney.tooDear + res.keepMoney.extras, res.keepMoney.dear, `${name}: every rejected improvement has a reason`);
    }
  };
  check(r, query.budget, query.budget, '$1500 hotel');
  for (const b of [900, 1200, 1500, 2500, 4000]) for (const prio of ['hotel', 'price', 'flights']) {
    const res = optimizer.search(inv, { ...query, budget: b * 100, priority: prio }, { settings });
    check(res, b * 100, b * 100, `$${b} ${prio}`);
  }
  for (const b of [900, 1500]) {
    const res = optimizer.search(inv, { ...query, budget: b * 100, allowOver: 10 }, { settings });
    check(res, b * 100, Math.round(b * 100 * 1.1), `$${b} +10%`);
  }

  const over = optimizer.search(inv, { ...query, allowOver: 10 }, { settings });
  for (const p of over.picks) assert.ok(p.trip.total <= Math.round(query.budget * 1.1));

  // A budget nothing fits: no dead end, the closest trips are shown with their over-budget amount.
  const tight = optimizer.search(inv, { ...query, budget: 30000 }, { settings });
  assert.equal(tight.picks.length, 0);
  assert.ok(tight.closest.length > 0 && tight.cheapest > 30000);

  // Ranking only sees customer-facing facts: a trip with absurd internal profit scores the same.
  const t = r.picks[0].trip;
  const a = optimizer.scoreTrip(t, r.ctx), b = optimizer.scoreTrip({ ...t, internal: { ...t.internal, grossProfit: 10 ** 9 } }, r.ctx);
  assert.deepEqual(a, b);

  // The planner asks only what is still missing.
  assert.deepEqual(optimizer.parseSearch({ b: '1500' }, { maps: inv.maps }).missing, ['keep', 'from', 'who', 'when', 'style', 'prio']);
  assert.deepEqual(optimizer.parseSearch({ b: '1500', k: '200', from: 'SFO', who: 'family', when: 'anytime', style: 'beach', prio: 'hotel' }, { maps: inv.maps }).missing, ['n']);
  assert.equal(optimizer.parseSearch({ b: '1500', k: '300' }, { maps: inv.maps }).query.budget, 120000, 'money kept aside comes off the trip budget');
});

test('decision layer: verdicts, usable vacation time, unlocks and make-it-better only ever tell the truth', () => {
  const settings = DEFAULT_SETTINGS;
  const { query } = optimizer.parseSearch(QUERY, { maps: inv.maps });
  const r = optimizer.search(inv, query, { settings });
  const best = r.picks[0];

  // A verdict within budget says what we'd do; over budget it is never called a fit, whatever the match.
  const v = decision.verdict(best.trip, r.ctx, best);
  assert.ok(['great', 'good', 'budget'].includes(v.grade), v.grade);
  assert.ok(v.win && v.action && v.label);
  const over = decision.verdict(best.trip, { ...r.ctx, budget: best.trip.total - 100 }, best);
  assert.equal(over.grade, 'look');
  assert.match(over.action, /over the/);
  assert.equal(decision.verdict(best.trip, { ...r.ctx, budget: best.trip.total - 100, allowOver: 10 }, best).grade, 'look');
  // Margin is never an input.
  assert.deepEqual(decision.verdict({ ...best.trip, internal: { ...best.trip.internal, grossProfit: 10 ** 9 } }, r.ctx, best), v);
  // Contradicting an answer is always flagged as the compromise.
  const short = decision.verdict(best.trip, { ...r.ctx, nightsAsked: best.trip.spec.nights + 2 }, best);
  assert.equal(short.grade, 'budget');
  assert.match(short.compromise, /shorter than you asked/);

  // Usable time comes from the flight schedule: the dawn Basic fare costs the whole last day.
  const spec = { dest: 'cancun', from: 'SFO', depart: addDays(today(), 60), nights: 5, travelers: 2, who: 'couple', hotel: 'cun-2', flight: 'basic', activities: [], bags: false, transfer: false };
  const basic = priceTrip(inv, spec, settings);
  const nonstop = priceTrip(inv, { ...spec, flight: 'nonstop' }, settings);
  const tb = decision.usableTime(basic), tn = decision.usableTime(nonstop);
  assert.equal(tb.lastDay.minutes, 0);
  assert.ok(tb.flags.some(f => f.kind === 'early-return'));
  assert.ok(tn.lastDay.minutes > 0 && tn.usableMinutes > tb.usableMinutes);
  assert.equal(tb.fullDays, 4);
  assert.equal(decision.usableTime({ ...basic, flight: { ...basic.flight, departMinutes: undefined } }), null, 'no schedule, no claims');
  // An overnight flight loses the night, not the arrival day: landing at 12:21 AM still leaves a full day.
  const bcn = f => priceTrip(inv, { ...spec, dest: 'barcelona', hotel: 'bcn-2', flight: f }, settings);
  const bcnSaver = decision.usableTime(bcn('saver')), bcnBasic = decision.usableTime(bcn('basic'));
  assert.ok(bcnSaver.firstDay.nextDay && bcnSaver.flags.some(f => f.kind === 'overnight'));
  assert.ok(bcnSaver.firstDay.minutes > 0, 'the arrival day is credited');
  assert.equal(bcnSaver.firstDay.minutes, 14 * 60, 'at the hotel at 1:51 AM: the arrival day is a full day');
  assert.equal(bcnSaver.fullDays, 3, 'the night in the air costs one of the full days, not two');
  assert.ok(bcnSaver.usableMinutes > bcnBasic.usableMinutes, 'a dawn-return Basic fare is not sold as more vacation than the overnight one');
  assert.ok(!decision.timeAlternatives(bcn('saver'), optimizer.customizerOptions(inv, bcn('saver'), settings)).some(a => a.flight.id === 'basic'));
  const options = optimizer.customizerOptions(inv, basic, settings);
  const alts = decision.timeAlternatives(basic, options);
  assert.ok(alts.length > 0);
  for (const a of alts) { assert.ok(a.gain >= 60); assert.equal(a.total, basic.total + a.delta); }

  // "Make it better" never costs more than the cap, never shortens the trip, keeps every locked part,
  // always improves something real, never earns a worse verdict, and never adds a compromise that
  // contradicts an answer; "nothing better" is a legitimate answer.
  const rank = { look: 0, budget: 1, good: 2, great: 3 };
  const checkBetter = (o, p, ctx) => {
    assert.ok(o.match > o.baseMatch);
    assert.ok(o.improvements.length > 0, 'a proposal improves at least one thing');
    assert.ok(o.improvements.every(g => g.direction > 0) && o.tradeoffs.every(g => g.direction < 0));
    assert.ok(!o.improvements.some(g => ['Per traveler', 'Per night', 'Total, everything included'].includes(g.label)));
    const noBudget = { ...ctx, budget: null, allowOver: 0 };
    assert.ok(rank[decision.verdict(o.trip, noBudget).grade] >= rank[decision.verdict(p.trip, noBudget).grade], 'never a worse verdict');
    assert.ok(decision.compromises(o.trip, ctx).filter(c => c.w >= 3).length <= decision.compromises(p.trip, ctx).filter(c => c.w >= 3).length);
  };
  for (const p of r.picks) {
    const same = decision.optimizeAround(inv, p.trip, settings, r.ctx, { cap: p.trip.total, locks: { dates: true } });
    if (same) {
      assert.ok(same.trip.total <= p.trip.total);
      assert.equal(same.trip.spec.depart, p.trip.spec.depart);
      assert.equal(same.trip.spec.nights, p.trip.spec.nights);
      checkBetter(same, p, r.ctx);
    }
    const locked = decision.optimizeAround(inv, p.trip, settings, r.ctx, { cap: query.budget, locks: { hotel: true, flight: true } });
    if (locked) {
      assert.equal(locked.trip.spec.hotel, p.trip.spec.hotel);
      assert.equal(locked.trip.spec.flight, p.trip.spec.flight);
      assert.ok(locked.trip.total <= query.budget);
      assert.ok(locked.trip.spec.nights >= p.trip.spec.nights);
      checkBetter(locked, p, r.ctx);
    }
  }
  assert.equal(decision.optimizeAround(inv, basic, settings, r.ctx, { cap: 1, locks: {} }), null, 'nothing fits under $0.01');
  // A price-first traveler is never sold a strip-down as "better": cheaper with only downgrades is null.
  for (const style of ['beach', 'city']) {
    const pq = optimizer.parseSearch({ ...QUERY, b: '1200', style, prio: 'price' }, { maps: inv.maps }).query;
    const pr = optimizer.search(inv, pq, { settings });
    for (const p of pr.picks) {
      const o = decision.optimizeAround(inv, p.trip, settings, pr.ctx, { cap: p.trip.total, locks: { dates: true } });
      if (o) checkBetter(o, p, pr.ctx);
    }
  }
  // Optimizing around an all-inclusive trip never proposes a hotel that isn't all-inclusive.
  const aq = optimizer.parseSearch({ ...QUERY, b: '2000', style: 'all-inclusive', prio: 'price' }, { maps: inv.maps }).query;
  const ar = optimizer.search(inv, aq, { settings });
  for (const p of ar.picks) for (const opts of [{ cap: p.trip.total, locks: { dates: true } }, { cap: aq.budget, locks: {} }]) {
    const o = decision.optimizeAround(inv, p.trip, settings, ar.ctx, opts);
    if (o) assert.ok(o.trip.hotel.features.allInclusive, `${p.trip.dest.name}: ${o.trip.hotel.name} is not all-inclusive`);
  }
  // classifyChanges reads direction from the facts: a transfer removed is a trade-off, never an improvement.
  const withTransfer = priceTrip(inv, { ...spec, transfer: true }, settings);
  const cls = decision.classifyChanges(withTransfer, basic);
  assert.ok(cls.tradeoffs.some(g => g.key === 'transfer') && !cls.improvements.some(g => g.key === 'transfer'));
  assert.ok(cls.improvements.length === 0 && !cls.neutral.some(g => g.key === 'total'));

  // Budget unlocks are real re-priced improvements; "within" respects what is left of the budget.
  const changes = singleChanges(basic, options, encodeSpec(spec), r.ctx);
  const u = decision.budgetUnlocks(changes, 10000);
  assert.ok(u.steps.length > 0 && u.steps.every(c => c.delta > 0 && c.better));
  assert.ok(u.steps.every(c => c.within === (c.delta <= 10000)));
  assert.equal(new Set(u.steps.map(c => c.kind)).size, u.steps.length, 'one step per kind of change');
  assert.equal(decision.budgetUnlocks(changes, 1).keep, true);
  assert.equal(decision.budgetUnlocks(changes, null).keep, false);

  // Side by side lists what differs; the reality check asks for documents only on international trips.
  const diff = decision.tripDiff(basic, nonstop);
  assert.ok(diff.find(d => d.key === 'flight').changed && diff.find(d => d.key === 'total').changed);
  assert.ok(!diff.find(d => d.key === 'hotel').changed);
  assert.equal(decision.realityCheck(basic).find(x => x.label === 'Travel documents').status, 'verify');
  const domestic = priceTrip(inv, { ...spec, dest: 'san-diego', hotel: 'san-1', flight: 'saver' }, settings);
  assert.ok(domestic, 'domestic trip priced');
  assert.equal(decision.realityCheck(domestic).find(x => x.label === 'Travel documents').status, 'verify', 'no document is ever guaranteed');
  assert.equal(decision.realityCheck(basic).find(x => x.label === 'Last day').status, 'heads-up');
});

test('decide-for-me pages: our call, compare, before and after, the reality check and beat my quote', async t => {
  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  const noInline = (p, body) => { assert.ok(!/\sstyle="/.test(body), `${p} inline style`); assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${p} inline script`); };

  const results = await c.req(`/trips?${new URLSearchParams(QUERY)}`);
  assert.match(results.text, /If it were our \$1,500, we’d book/);
  // With 10% more allowed, "we'd book" never names a trip that is over the budget.
  for (const b of ['900', '1000', '1100', '1200']) {
    const page = (await c.req(`/trips?${new URLSearchParams({ ...QUERY, b, ov: '10' })}`)).text;
    const m = page.match(/we’d book <a href="\/trip\/([^"?]+)\?/);
    if (m) assert.ok(priceTrip(inv, decodeSpec(m[1]), DEFAULT_SETTINGS).total <= Number(b) * 100, `our call for $${b} is over budget`);
    else assert.match(page, /Nothing we built fits under \$|Let’s get closer/);
  }
  assert.match(results.text, /What almost won/);
  assert.match(results.text, /What would change our mind/);
  assert.ok((results.text.match(/tb-fit-/g) || []).length >= 2, 'every trip card carries a verdict');
  // You gave us / we need / you keep, then either an upgrade worth its price or "keep your money".
  assert.match(results.text, /You gave us/);
  assert.match(results.text, /You keep/);
  assert.match(results.text, /couldn’t find a good reason|Upgrade, only if worth it/);
  for (const extra of [{ b: '900', ov: '10' }, { b: '1200' }, { b: '2500' }, { b: '4000' }, { prio: 'price' }, { prio: 'flights' }]) {
    const res = await c.req(`/trips?${new URLSearchParams({ ...QUERY, ...extra })}`);
    assert.equal(res.status, 200, JSON.stringify(extra));
    noInline(`/trips ${JSON.stringify(extra)}`, res.text);
    if (/we’d book|The closest is/.test(res.text)) {
      assert.match(res.text, /You gave us/, JSON.stringify(extra));
      if (/Keep your money/.test(res.text)) assert.match(res.text, /trips?, and a reason to keep your money|couldn’t find a good reason/);
      else if (/we’d book/.test(res.text)) assert.match(res.text, /Upgrade, only if worth it/, JSON.stringify(extra));
    }
  }
  const compare = results.text.match(/href="(\/compare\?[^"]*)"/)[1].replace(/&amp;/g, '&');
  const cmp = await c.req(compare);
  assert.equal(cmp.status, 200);
  assert.match(cmp.text, /Compare your [23] trips/);
  assert.match(cmp.text, /Our verdict/);
  assert.match(cmp.text, /Our pick/);
  noInline('/compare', cmp.text);
  assert.ok((await c.req(compare + '&all=1')).text.match(/<tr/g).length >= cmp.text.match(/<tr/g).length);

  const trip = await buildTrip(c);
  const page = await c.req(`${trip.tripPath}?${trip.cx}`);
  assert.match(page.text, /Biggest win/);
  assert.match(page.text, /Your time there/);
  assert.match(page.text, /Protect the magic/);
  assert.match(page.text, /Weekdays/);
  assert.match(page.text, /PTO days if you work Monday to Friday/);
  assert.match(page.text, /Make it cheaper<\/a>/);
  assert.match(page.text, /Change one thing/);
  assert.match(page.text, /Make it better for the same money/);
  const same = await c.req(`${trip.tripPath}/optimize?${trip.cx}&cap=same&lk=d`);
  assert.equal(same.status, 200);
  assert.match(same.text, /Before and after|already the best version/);
  noInline('/optimize', same.text);
  const locked = await c.req(`${trip.tripPath}/optimize?${trip.cx}&cap=budget&lk=h&lk=f`);
  assert.equal(locked.status, 200);
  if (/Use this version/.test(locked.text)) {
    const proposed = locked.text.match(/href="(\/trip\/[^"#?]+)\?[^"]*#customize"/)[1];
    const a = decodeSpec(trip.tripPath.split('/').pop()), b = decodeSpec(proposed.split('/').pop());
    assert.equal(a.hotel, b.hotel); assert.equal(a.flight, b.flight);
  }
  const review = await c.req(`${trip.tripPath}/review?${trip.cx}&seen=0`);
  assert.match(review.text, /Travel reality check/);
  assert.match(review.text, /Our honest take/);
  assert.match(review.text, /What’s not in this price/);
  noInline('/review', review.text);

  // Beat my quote: an honest yes, or "keep it". I have to be there: a fixed date.
  const beat = await c.req('/dream?beat=1&dest=cancun&b=2400&from=SFO&nights=5');
  assert.match(beat.text, /You found Cancun for \$2,400/);
  assert.match(beat.text, /We can (beat|match) it/);
  const cannot = await c.req('/dream?beat=1&dest=paris&b=900&from=NYC&nights=5');
  assert.match(cannot.text, /Honestly, we can’t beat it/);
  assert.match(cannot.text, /keep it/);
  const fixed = await c.req(`/dream?dest=cancun&b=2400&from=SFO&depart=${addDays(today(), 40)}`);
  assert.equal(fixed.status, 200);
  assert.match(fixed.text, /fixed dates/);
  assert.match((await c.req('/dream?dest=cancun&b=2400&from=SFO&depart=2020-01-01')).text, /any dates/);
  assert.equal((await c.req('/compare?t=one')).status, 303);
  assert.equal((await c.req('/compare?t=bad~x&t=worse~y')).status, 410);
});

test('name your price: searches downward, stops at the cheapest strong version, never hides a cheaper one', async t => {
  const settings = DEFAULT_SETTINGS;
  const rank = { strong: 0, compromise: 1, major: 2 };
  // Engine invariants over a few travelers: the ladder descends, paying less never buys a better
  // version, every number is a priced package, and every answer is at or under the named price.
  for (const [extra, frac] of [[{ prio: 'price' }, 0.9], [{ prio: 'flights', from: 'NYC', b: '2500', nights: '6', style: 'city' }, 0.97], [{ prio: 'activities', who: 'family', n: '4', b: '3000', style: 'family' }, 0.85]]) {
    const { query } = optimizer.parseSearch({ ...QUERY, ...extra }, { maps: inv.maps });
    const r = optimizer.search(inv, query, { settings });
    const trip = r.picks[0].trip;
    const target = Math.round(trip.total * frac);
    const out = decision.nameYourPrice(inv, trip, settings, r.ctx, target);
    assert.ok(out.considered > 0);
    assert.equal(out.ladder[0].total, trip.total);
    for (let i = 1; i < out.ladder.length; i++) {
      assert.ok(out.ladder[i].total < out.ladder[i - 1].total, 'ladder descends with distinct totals');
      if (i >= 2) assert.ok(rank[out.ladder[i].label] >= rank[out.ladder[i - 1].label], 'paying less never buys a better version');
      assert.equal(priceTrip(inv, out.ladder[i].trip.spec, settings).total, out.ladder[i].total, 'every rung is a priced package');
    }
    for (const c of [out.recommended, out.floor, out.anyway, out.cheapest].filter(Boolean)) {
      assert.equal(priceTrip(inv, c.trip.spec, settings).total, c.total);
      assert.ok(c.total < trip.total, 'never widened above the current total');
    }
    const PRIO_KEYS = { hotel: ['hotel', 'area', 'meals'], flights: ['flight'], activities: ['experiences'], longer: ['nights'], price: [] };
    for (const c of out.ladder.slice(1)) if (c.label === 'strong') assert.ok(!c.changes.tradeoffs.some(x => PRIO_KEYS[r.ctx.priority].includes(x.key)), `strong never steps down on ${r.ctx.priority}`);
    assert.ok(['great', 'good', 'budget', 'look'].includes(out.currentVerdict.grade), 'the trip you have is judged on its own verdict');
    assert.equal(out.truncated, false);
    if (out.recommended) { assert.ok(out.recommended.total <= target); assert.equal(out.recommended.label, 'strong'); assert.equal(out.anyway, null); }
    else if (out.anyway) { assert.ok(out.anyway.total <= target); assert.notEqual(out.anyway.label, 'strong'); }
    assert.ok(out.floor === null || out.floor.label === 'strong');
    assert.ok(!out.recommended || !out.floor || out.floor.total <= out.recommended.total, 'the floor is the cheapest version we recommend');
    if (out.floor) for (const tgt of [out.floor.total, out.floor.total + 1000, out.floor.total + 1999]) {
      const o = decision.nameYourPrice(inv, trip, settings, r.ctx, tgt);
      assert.ok(!o.recommended || o.recommended.total <= tgt, `"we got there" is never above the ${tgt} named`);
    }
    const none = decision.nameYourPrice(inv, trip, settings, r.ctx, 30000);
    assert.equal(none.recommended, null); assert.equal(none.anyway, null);
    assert.ok(none.cheapest && none.cheapest.total > 30000, 'an impossible price gets the real cheapest version, not a dead end');
  }

  // Pages: the form on the trip page, the three honest answers, the ladder, and the redirects.
  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  const noInline = (p, body) => { assert.ok(!/\sstyle="/.test(body), `${p} inline style`); assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${p} inline script`); };
  const answers = new Set();
  for (const extra of [{ prio: 'price' }, { prio: 'flights' }, { prio: 'activities', who: 'family', n: '4', b: '3000', style: 'family' }]) {
    const results = await c.req(`/trips?${new URLSearchParams({ ...QUERY, ...extra })}`);
    const m = results.text.match(/href="(\/trip\/[^"?]+)\?([^"]*)"/);
    const tripPath = m[1], qs = m[2].replace(/&amp;/g, '&');
    const page = await c.req(`${tripPath}?${qs}`);
    assert.match(page.text, /How much would you love to pay\?/);
    const total = Number(page.text.match(/"total":(\d+)/)[1]);
    // Targets the engine itself says exist for this trip today (its floor, its cheapest version
    // and a price below it), plus a few fractions, so every one of the three answers is exercised
    // whatever the demo calendar holds on the day the tests run.
    const probeCtx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(qs)));
    const probeTrip = priceTrip(inv, decodeSpec(tripPath.split('/').pop()), settings);
    const probe = decision.nameYourPrice(inv, probeTrip, settings, probeCtx, total - 1);
    const fracs = [0.97, 0.8, 0.5, ...(probe.floor ? [probe.floor.total / total] : []), ...(probe.cheapest ? [probe.cheapest.total / total, (probe.cheapest.total - 10000) / total] : [])].filter(f => f > 0.01 && f < 1);
    for (const frac of fracs) {
      const res = await c.req(`${tripPath}/price?${qs}&target=${Math.round(total * frac / 100)}`);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      const h1 = res.text.match(/<h1>([^<]*)<\/h1>/)[1];
      assert.match(h1, /We got there|We don’t think we should|No version of this trip gets to/);
      answers.add(h1.replace(/\$[\d,.]+/g, '$'));
      assert.match(res.text, /The value ladder/);
      assert.match(res.text, /Your trip now/);
      noInline('/price', res.text);
      if (/don’t think we should/.test(h1)) { assert.match(res.text, /version anyway/); assert.match(res.text, /It means:/); }
      if (/We got there/.test(h1)) { assert.match(res.text, /Use this version/); assert.match(res.text, /Keep my original/); }
      if (/No version/.test(h1)) assert.match(res.text, /Try another destination for/);
      if (/is-cliff/.test(res.text)) assert.match(res.text, /Value cliff/, 'the cliff is named in the markup, not only in CSS');
      if (/We got there: \$([\d,.]+)/.test(h1)) assert.ok(Number(h1.match(/We got there: \$([\d,.]+)/)[1].replace(/,/g, '')) * 100 <= Math.round(total * frac), 'never "got there" above the price named');
    }
    const high = await c.req(`${tripPath}/price?${qs}&target=${Math.round(total / 100) + 100}`);
    assert.equal(high.status, 303, 'a price above the total goes back to the trip');
    assert.match(high.location, /named=high/);
    assert.match((await c.req(high.location)).text, /at or above this trip’s total/, 'the trip page says why');
    for (const bad of ['', '0', '-5', '50', 'abc', '1e308', '%20']) {
      const res = await c.req(`${tripPath}/price?${qs}&target=${bad}`);
      assert.equal(res.status, 303, `target=${bad} never shows a number the traveler did not type`);
      assert.match(res.location, /named=low/);
    }
    assert.match((await c.req(`${tripPath}?${qs}&named=low`)).text, /at least \$100/);
  }
  assert.ok(answers.size >= 3, `all three answers appear across targets: ${[...answers].join(' | ')}`);
});

test('money and time: weekdays are a second budget, never a claim about anyone’s calendar; no search dead-ends', async t => {
  const mondays = [];
  for (let d = addDays(today(), 20); mondays.length < 1; d = addDays(d, 1)) if (new Date(`${d}T00:00:00Z`).getUTCDay() === 1) mondays.push(d);
  const monday = mondays[0], friday = addDays(monday, 4), saturday = addDays(monday, 5);
  assert.equal(decision.weekdaysAway(monday, 4), 5, 'Monday to Friday');
  assert.equal(decision.weekdaysAway(friday, 2), 1, 'Friday to Sunday');
  assert.equal(decision.weekdaysAway(saturday, 1), 0, 'Saturday to Sunday');
  assert.equal(decision.weekdaysAway(friday, 3), 2, 'Friday to Monday');
  const settings = DEFAULT_SETTINGS;
  const { query } = optimizer.parseSearch(QUERY, { maps: inv.maps });
  const trip = optimizer.search(inv, query, { settings }).picks[0].trip;
  const options = optimizer.customizerOptions(inv, trip, settings);
  const base = decision.weekdaysAway(trip.spec.depart, trip.spec.nights);
  for (const a of decision.ptoAlternatives(trip, options)) {
    assert.ok(a.weekdays < base && a.saves === base - a.weekdays, 'only ever fewer weekdays');
    const d = options.dates.find(x => x.depart === a.depart);
    assert.equal(a.delta, d.delta, 'the price difference is the re-priced date');
    assert.equal(priceTrip(inv, { ...trip.spec, depart: a.depart }, settings).total, a.total);
  }

  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  const none = await c.req(`/trips?${new URLSearchParams({ ...QUERY, b: '300' })}`);
  assert.equal(none.status, 200);
  assert.match(none.text, /couldn’t build a trip that meets all your rules for \$300/);
  for (const offer of ['Change dates', 'Shorten the trip', 'Relax one rule: any style', 'Relax one rule: lowest price first', 'Allow up to 10% more', 'Increase budget']) assert.match(none.text, new RegExp(offer));
  assert.doesNotMatch(none.text, /No results found/i);
  const home = await c.req('/');
  assert.match(home.text, /Tell us how much\./);
  assert.match(home.text, /We try to beat it\./);
  assert.match(home.text, /Build my best trip/);
  assert.match(home.text, /Your budget\. Your trip\. Your way\./);
});

test('your trip, step by step: built from the trip’s facts, honest about what only the itinerary can tell', async t => {
  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  const noInline = (p, body) => { assert.ok(!/\sstyle="/.test(body), `${p} inline style`); assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${p} inline script`); };
  const trip = await buildTrip(c);
  const g = await c.req(`${trip.tripPath}/guide?${trip.cx}`);
  assert.equal(g.status, 200);
  assert.match(g.text, /what happens, in order/);
  assert.match(g.text, /Check required/);
  assert.match(g.text, /General guidance/);
  assert.match(g.text, /Going home/);
  assert.match(g.text, /boarding time is not departure time/);
  assert.doesNotMatch(g.text, /only \d+ left|book now|last chance|hurry/i, 'no fear selling');
  assert.doesNotMatch(g.text, /is enough for US travelers/, 'no document is ever guaranteed');
  noInline('/guide', g.text);
  const built = decision.tripGuide(priceTrip(inv, decodeSpec(trip.tripPath.split('/').pop()), DEFAULT_SETTINGS));
  for (const st of built.steps) {
    const want = st.lines.some(l => l.status === 'check') ? 'check' : st.lines.some(l => l.status === 'info') ? 'info' : 'ready';
    assert.equal(st.status, want, `${st.key}: the pill follows the lines`);
  }
  // Nonstop vs a connection: the connection step appears only when the flight has a stop, and the
  // connecting airport is "check required" because the demo data does not carry it.
  const spec = decodeSpec(trip.tripPath.split('/').pop());
  const priced = priceTrip(inv, spec, DEFAULT_SETTINGS);
  const nonstop = priced.flightOptions.find(f => f.stops === 0), onestop = priced.flightOptions.find(f => f.stops > 0);
  const ns = await c.req(`/trip/${encodeSpec({ ...spec, flight: nonstop.id })}/guide?${trip.cx}`);
  assert.match(ns.text, /Nonstop: you board once/);
  assert.doesNotMatch(ns.text, /Your connection/);
  const st = await c.req(`/trip/${encodeSpec({ ...spec, flight: onestop.id })}/guide?${trip.cx}`);
  assert.match(st.text, /Your connection/);
  assert.match(st.text, /connecting airport and the time between flights are on your itinerary/);
  // The engine never invents a schedule: without flight times the steps say where to look.
  const guide = decision.tripGuide({ ...priced, flight: { ...priced.flight, departMinutes: undefined, arriveMinutes: undefined, returnDepartMinutes: undefined } }, { origin: inv.maps.airport(spec.from) });
  assert.ok(guide.steps.find(s => s.key === 'boarding').lines.some(l => l.status === 'check' && /on your itinerary/.test(l.text)));
  assert.ok(guide.steps.every(s => s.lines.every(l => ['ready', 'check', 'info'].includes(l.status))));
  // Entry points, and bad tokens fail like the trip page.
  assert.match((await c.req(`${trip.tripPath}?${trip.cx}`)).text, /Walk me through it/);
  assert.match((await c.req(`${trip.tripPath}/review?${trip.cx}&seen=0`)).text, /Walk through the trip step by step/);
  const bad = await c.req('/trip/nowhere~XXX~2020-01-01~5~2c~none~basic~00~-/guide');
  assert.ok(bad.status >= 400 && bad.status < 500, String(bad.status));
});

test('Journey B: a dream destination gets the gap and real single-change closers', async t => {
  const app = await startApp();
  t.after(app.close);
  const page = await (await fetch(`${app.base}/dream?dest=paris&b=1500&from=NYC`)).text();
  assert.match(page, /Paris for \$1,500/);
  assert.match(page, /We need to save/);
  assert.match(page, /new total/);
  const missing = await fetch(`${app.base}/dream?dest=paris`, { redirect: 'manual' });
  assert.equal(missing.status, 200);
  assert.match(await missing.text(), /How much do you want to spend\?/);
});

test('pages render without inline scripts or styles; corporate site moves to /company; flag turns it all off', async t => {
  const app = await startApp();
  t.after(app.close);
  const paths = ['/', '/plan', '/plan?b=1500', '/plan?b=1500&k=0&from=SFO&who=family', `/trips?${new URLSearchParams(QUERY)}`, '/how-it-works', '/faq', '/legal/terms', '/legal/privacy', '/custom-trip', '/destinations', '/trips-to-cancun', '/beach-vacations', '/trips-under-1500', '/trips-under-2000?region=international', '/signin', '/signup', '/company', '/about', '/book/hotels', '/robots.txt', '/sitemap.xml'];
  for (const p of paths) {
    const res = await fetch(app.base + p);
    assert.equal(res.status, 200, p);
    const body = await res.text();
    assert.ok(!/\sstyle="/.test(body), `${p} has an inline style attribute`);
    assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${p} has an inline script`);
  }
  const home = await (await fetch(app.base + '/')).text();
  assert.match(home, /How much do you<br>want to spend\?/);
  assert.match(home, /Surprise me/i);
  assert.match(home, /Demo inventory/);
  assert.match(home, /Three answers\. One budget\. You choose\./);
  assert.match(home, /Our pick/);
  assert.match(home, /Beat my quote/);
  assert.match(home, /I have to be there on/);
  assert.equal((await fetch(app.base + '/trips-under-7')).status, 404);
  assert.equal((await fetch(app.base + '/legal/nope')).status, 404);
  assert.equal((await fetch(app.base + '/plan?b=1500&k=0&from=SFO&who=couple&when=anytime&style=beach&prio=hotel', { redirect: 'manual' })).status, 303, 'a complete plan goes straight to results');
  assert.equal((await fetch(app.base + '/my-trips', { redirect: 'manual' })).status, 303, 'My Trips needs an account');
  assert.equal((await fetch(app.base + '/admin')).status, 404, 'admin is invisible to the public');

  const off = await startApp({ ENABLE_TRIPS: 'false' });
  t.after(off.close);
  assert.match(await (await fetch(off.base + '/')).text(), /Travel technology/);
  assert.equal((await fetch(off.base + '/plan')).status, 404);
  const prod = await startApp({ APP_ENV: 'production', ENABLE_TRIPS: 'true', ALLOW_DEMO_INVENTORY: 'false', DATABASE_URL: 'memory', PAYMENT_MODE: 'test', HTTPS_ONLY: 'true', DATABASE_ENV: 'production' }).catch(e => e);
  if (!(prod instanceof Error)) { t.after(prod.close); assert.equal((await fetch(prod.base + '/plan')).status, 404, 'mock trip inventory is refused where demo data is not allowed'); }
});

test('the full journey: account, search, customize, price check, quote, pay, My Trips, support', async t => {
  const app = await startApp({ ADMIN_EMAILS: 'ops@example.com' });
  t.after(app.close);
  const c = client(app.base);

  // Accounts.
  const bad = await c.req('/signup', { method: 'POST', form: { name: 'Ada', email: 'ada@example.com', password: 'short' } });
  assert.equal(bad.status, 422);
  const ok = await c.req('/signup', { method: 'POST', form: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse battery', next: '/my-trips' } });
  assert.equal(ok.status, 303); assert.equal(ok.location, '/my-trips');
  assert.ok(c.jar.txs, 'session cookie set');
  assert.equal((await c.req('/signup', { method: 'POST', form: { name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' } })).status, 409);
  assert.match((await c.req('/my-trips')).text, /Welcome back, Ada/);

  // Search and customize: every change re-prices the whole trip server-side.
  const trip = await buildTrip(c);
  const page = await c.req(`${trip.tripPath}?${trip.cx}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Customize your trip/);
  assert.match(page.text, /Know before you book/);
  assert.ok(!page.text.includes('supplierCost') && !page.text.includes('grossProfit'), 'no internal economics on the page');
  const change = page.text.match(/href="(\/trip\/[^"]+\/change\?[^"]*)"/)[1].replace(/&amp;/g, '&');
  const changed = await c.req(change);
  assert.equal(changed.status, 303);
  assert.match(changed.location, /^\/trip\//);
  assert.notEqual(changed.location.split('?')[0], trip.tripPath, 'a change produces a new trip token');
  assert.equal((await c.req(changed.location)).status, 200);

  // Save and watch, then review: the live price is checked before the quote.
  assert.equal((await c.req(`${trip.tripPath}/save?${trip.cx}`, { method: 'POST', form: { kind: 'saved' } })).status, 303);
  assert.equal((await c.req(`${trip.tripPath}/save?${trip.cx}`, { method: 'POST', form: { kind: 'watch' } })).status, 303);
  const mine = await c.req('/my-trips');
  assert.match(mine.text, /Saved · /); assert.match(mine.text, /Watching price/);
  const review = await c.req(`${trip.tripPath}/review?${trip.cx}&seen=${trip.approvedTotal}`);
  assert.match(review.text, /your price is still/);
  const stale = await c.req(`${trip.tripPath}/review?${trip.cx}&seen=${trip.approvedTotal - 5000}`);
  assert.match(stale.text, /Your trip price changed by \$50/);
  const badPromo = await c.req(`${trip.tripPath}/review?${trip.cx}&seen=${trip.approvedTotal}&promo=NOPE`);
  assert.equal(badPromo.status, 200);
  assert.match(badPromo.text, /isn’t valid|not valid|unknown/i);

  // A stale approved total never becomes a quote.
  const refused = await c.req(`${trip.tripPath}/quote`, { method: 'POST', form: { approvedTotal: trip.approvedTotal - 100, cx: trip.cxField } });
  assert.equal(refused.status, 303);
  assert.match(refused.location, /\/review\?.*seen=/);

  // Quote, booking (linked to the account), payment with a test card, confirmation.
  const { booking } = await quoteAndBook(c, trip);
  assert.equal(booking.status, 'pending_payment');
  assert.match(booking.ref, /^DEMO-BT-[A-Z0-9]{8}$/);
  assert.equal(booking.vertical, 'trips');
  assert.equal(booking.total, trip.approvedTotal);
  const paid = await c.req(`/api/bookings/${booking.ref}/pay`, { method: 'POST', json: { method: CARD } });
  assert.equal(paid.status, 200, paid.text);
  const b = paid.json().booking;
  assert.equal(b.status, 'confirmed');
  assert.equal(b.components.length, 2 + b.trip.activities.length + (b.trip.transfer ? 1 : 0), 'flights, hotel, and one component per experience and transfer');
  assert.ok(b.components.every(x => x.status === 'confirmed' && x.confirmation));
  const bookingPage = await c.req(`/booking/${booking.ref}`);
  assert.match(bookingPage.text, /Your trip is booked/);
  assert.match(bookingPage.text, new RegExp(`TRIP #${booking.ref}`));
  assert.match(bookingPage.text, /under your \$1,500 budget/);

  // Cancellation preview: within 24 hours of booking the whole trip is refundable.
  const data = await app.engine.getBooking(booking.ref, { token: decodeURIComponent(c.jar[`txbk_${booking.ref}`]) });
  assert.equal(data.cancellationPreview.allowed, true);
  assert.equal(data.cancellationPreview.refundAmount, booking.total);

  // Support messages carry the Trip ID; My Trips lists the booking; the owner can open it without the cookie.
  const msg = await c.req(`/booking/${booking.ref}/message`, { method: 'POST', form: { text: 'Can I add a night?' } });
  assert.equal(msg.status, 303);
  assert.match((await c.req(`/booking/${booking.ref}?sent=1`)).text, /Can I add a night\?/);
  assert.match((await c.req('/my-trips')).text, new RegExp(`TRIP #${booking.ref}`));
  const cookies = { ...c.jar };
  for (const k of Object.keys(c.jar)) if (k !== 'txs') delete c.jar[k];
  assert.equal((await c.req(`/booking/${booking.ref}`)).status, 200, 'signed-in owner without the booking cookie');
  Object.assign(c.jar, cookies);

  // Funnel events were recorded for the admin center.
  const events = await app.store.listRecords('event', { limit: 500 });
  for (const type of ['search_started', 'results_viewed', 'trip_selected', 'checkout_started', 'payment_attempted', 'booking_confirmed']) assert.ok(events.some(e => e.type === type), type);

  // Sign out ends the session.
  assert.equal((await c.req('/signout', { method: 'POST', form: {} })).status, 303);
  assert.equal((await c.req('/my-trips')).status, 303);
});

test('a price that moves between the quote and payment is never charged', async t => {
  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  const trip = await buildTrip(c);
  const { booking } = await quoteAndBook(c, trip);
  // The business rules change (a higher service fee) after the quote, so the live price differs.
  await app.tripService.saveSettings({ ...DEFAULT_SETTINGS, serviceFeePerTraveler: 25, maxServiceFee: 60, hotelMarkupPercent: 8, minProfit: 20, minMarginPercent: 2 });
  const pay = await c.req(`/api/bookings/${booking.ref}/pay`, { method: 'POST', json: { method: CARD } });
  assert.equal(pay.status, 409, pay.text);
  const err = pay.json().error;
  assert.equal(err.code, 'price_changed');
  assert.match(err.details.url, /\/review\?seen=/);
  assert.ok(err.details.newTotal > booking.total);
  const again = await app.store.getBookingByRef(booking.ref);
  assert.equal(again.status, 'pending_payment', 'nothing was charged');
  assert.ok(!again.payment, 'no payment recorded');
});

test('a later component failing after payment leaves a partially confirmed trip with an alert, not silence', async t => {
  const app = await startApp({ ADMIN_EMAILS: 'ops@example.com' });
  t.after(app.close);
  const c = client(app.base);
  const trip = await buildTrip(c);
  const { booking } = await quoteAndBook(c, trip, { firstName: 'Ada', lastName: 'Failhotel', email: 'ada@example.com' });
  const paid = await c.req(`/api/bookings/${booking.ref}/pay`, { method: 'POST', json: { method: CARD } });
  assert.equal(paid.status, 200, paid.text);
  const b = paid.json().booking;
  assert.equal(b.status, 'partially_confirmed');
  assert.equal(b.components.find(x => x.kind === 'flight').status, 'confirmed');
  assert.equal(b.components.find(x => x.kind === 'hotel').status, 'failed');
  const page = await c.req(`/booking/${booking.ref}`);
  assert.match(page.text, /one part needs our team/);
  const alerts = await app.store.listRecords('alert', { limit: 10 });
  assert.equal(alerts.length, 1); assert.equal(alerts[0].ref, booking.ref);
  const outbox = await app.store.listRecords('outbox', { limit: 20 });
  assert.ok(outbox.some(m => m.audience === 'admin' && m.status === 'not_sent_outbox'), 'ops notified through the outbox');
  assert.ok(outbox.some(m => m.to === 'ada@example.com'), 'customer notified through the outbox');
});

test('admin control center: hidden from non-admins, rules and promo codes change prices, bookings are searchable', async t => {
  const app = await startApp({ ADMIN_EMAILS: 'ops@example.com' });
  t.after(app.close);
  const guest = client(app.base);
  await guest.req('/signup', { method: 'POST', form: { name: 'Guest', email: 'guest@example.com', password: 'correct horse battery' } });
  assert.equal((await guest.req('/admin')).status, 404);
  const admin = client(app.base);
  await admin.req('/signup', { method: 'POST', form: { name: 'Ops Person', email: 'ops@example.com', password: 'correct horse battery' } });
  for (const p of ['/admin', '/admin/bookings', '/admin/requests', '/admin/settings', '/admin/promos', '/admin/outbox']) assert.equal((await admin.req(p)).status, 200, p);

  // Promo codes show as their own line; the original price is never inflated.
  assert.equal((await admin.req('/admin/promos', { method: 'POST', form: { code: 'welcome10', type: 'percent', value: '10', minTotal: '0', expiresAt: '' } })).status, 303);
  const trip = await buildTrip(guest);
  const withPromo = await guest.req(`${trip.tripPath}/review?${trip.cx}&seen=0&promo=WELCOME10`);
  assert.match(withPromo.text, /WELCOME10/);
  const discounted = Number(withPromo.text.match(/name="approvedTotal" value="(\d+)"/)[1]);
  assert.ok(discounted < trip.approvedTotal);

  // Business rules: disabling a destination removes it from recommendations; bad values are refused.
  assert.equal((await admin.req('/admin/settings', { method: 'POST', form: { serviceFeePerTraveler: '15', maxServiceFee: '60', hotelMarkupPercent: '8', minProfit: '20', minMarginPercent: '2', enabled: ['paris'] } })).status, 303);
  const settings = await app.tripService.settings();
  assert.ok(settings.disabledDestinations.includes('cancun') && !settings.disabledDestinations.includes('paris'));
  assert.equal((await admin.req('/admin/settings', { method: 'POST', form: { serviceFeePerTraveler: '-1', maxServiceFee: '60', hotelMarkupPercent: '8', minProfit: '20', minMarginPercent: '2' } })).status, 422);
  const results = await guest.req(`/trips?${new URLSearchParams(QUERY)}`);
  assert.ok(!/Cancun, Mexico/.test(results.text) || /over your budget/.test(results.text));

  // A booking shows up with its internal economics for staff only, and status changes are logged.
  const { booking } = await quoteAndBook(guest, trip);
  await guest.req(`/api/bookings/${booking.ref}/pay`, { method: 'POST', json: { method: CARD } });
  const detail = await admin.req(`/admin/bookings/${booking.ref}`);
  assert.match(detail.text, /Internal economics/);
  assert.match(detail.text, /Estimated gross profit/);
  assert.equal((await admin.req(`/admin/bookings/${booking.ref}/status`, { method: 'POST', form: { status: 'refund_pending', note: 'Customer asked by phone' } })).status, 303);
  assert.equal((await app.store.getBookingByRef(booking.ref)).status, 'refund_pending');
  assert.match((await admin.req('/admin/bookings?q=' + booking.ref)).text, new RegExp(booking.ref));
  assert.equal((await admin.req(`/admin/bookings/${booking.ref}/message`, { method: 'POST', form: { text: 'On it.' } })).status, 303);
  assert.match((await guest.req(`/booking/${booking.ref}`)).text, /On it\./);
  assert.equal((await guest.req(`/admin/bookings/${booking.ref}`)).status, 404, 'customers never see the admin view');

  // Custom trip requests land in the queue.
  assert.equal((await guest.req('/custom-trip', { method: 'POST', form: { name: 'Guest', email: 'guest@example.com', budget: '4000', from: 'Boston', travelers: '2', dates: 'March', wants: 'A honeymoon somewhere warm with a great pool.' } })).status, 200);
  assert.match((await admin.req('/admin/requests')).text, /honeymoon somewhere warm/);
});

test('cross-site form posts are refused', async t => {
  const app = await startApp();
  t.after(app.close);
  const res = await fetch(app.base + '/signin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }, body: 'email=a@b.co&password=x', redirect: 'manual' });
  assert.equal(res.status, 403);
});

test('the whole vacation: money protected for the destination travels with the trip and is never spent quietly', async t => {
  const settings = DEFAULT_SETTINGS;
  const money = c => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  // The reserve rides on the trip-page context only together with the budget it belongs to.
  const cx = optimizer.parseContext({ b: '1600', k: '400', style: 'beach' });
  assert.equal(cx.budget, 160000); assert.equal(cx.keep, 40000);
  assert.match(optimizer.contextParams(cx), /^b=1600&k=400/);
  assert.equal(optimizer.parseContext({ k: '400' }).keep, 0, 'no reserve without a budget');
  assert.ok(!/k=/.test(optimizer.contextParams(optimizer.parseContext({ b: '1600' }))));
  assert.equal(optimizer.parseContext(Object.fromEntries(new URLSearchParams(optimizer.contextParams(cx)))).keep, 40000, 'round trip');

  // A vacation budget with a reserve is a booking budget of the difference: a $1,900 booking is
  // never "within" a $2,000 vacation that protects $400.
  const { query } = optimizer.parseSearch({ ...QUERY, b: '2000', k: '400' }, { maps: inv.maps });
  assert.equal(query.vacationBudget, 200000); assert.equal(query.keep, 40000); assert.equal(query.budget, 160000);
  const r = optimizer.search(inv, query, { settings });
  assert.ok(r.picks.length);
  assert.ok(r.picks.every(p => p.trip.total <= 160000));
  assert.equal(r.ctx.keep, 40000);

  // The plan is the traveler's numbers and the booking's price, nothing estimated.
  const t0 = r.picks[0].trip;
  const options = optimizer.customizerOptions(inv, t0, settings);
  const plan = vacationPlan(t0, r.ctx, options);
  assert.equal(plan.vacation, 200000); assert.equal(plan.keep, 40000); assert.equal(plan.booking, t0.total);
  assert.equal(plan.unassigned, 160000 - t0.total); assert.equal(plan.raid, 0); assert.equal(plan.arrive, 200000 - t0.total);
  assert.equal(plan.planned, t0.total + 40000); assert.equal(plan.fits, true); assert.equal(plan.days, t0.spec.nights + 1);
  assert.equal(plan.perDay % 100, 0, 'a planning figure in whole dollars, never false precision');
  assert.ok(plan.unknown.length >= 3 && !('estimated' in plan), 'we never put a number on what we cannot know');
  const transfer = plan.optional.find(o => o.key === 'transfer');
  if (transfer) assert.equal(transfer.amount, options.transfer.delta, 'an optional amount is the customizer’s real price');
  const over = vacationPlan(t0, { budget: t0.total - 10000, keep: 40000 });
  assert.equal(over.fits, false); assert.equal(over.raid, 10000); assert.equal(over.reserveLeft, 30000); assert.equal(over.over, 0); assert.equal(over.arrive, 30000);
  const beyond = vacationPlan(t0, { budget: t0.total - 50000, keep: 40000 });
  assert.equal(beyond.raid, 40000); assert.equal(beyond.over, 10000); assert.equal(beyond.arrive, 0);
  assert.equal(vacationPlan(t0, {}), null);

  // One rule away: every relaxation offered was really searched, leads to the same pick at the
  // same price, and every candidate rule is accounted for, offered or named as not enough alone.
  for (const raw of [{ ...QUERY, b: '1300', k: '300', nights: '7' }, { ...QUERY, b: '700', k: '300', nights: '5', style: 'city', prio: 'flights' }, { ...QUERY, b: '900', k: '0', who: 'family', n: '4', nights: '7' }]) {
    const nq = optimizer.parseSearch(raw, { maps: inv.maps }).query;
    const nr = optimizer.search(inv, nq, { settings });
    if (nr.picks.length) continue;
    const relax = optimizer.oneRuleAway(inv, nq, { settings });
    const candidates = (nq.dateMode !== 'anytime') + (nq.nights > 2) + (nq.nights > 3) + (nq.style !== 'surprise') + (nq.priority !== 'price') + (!nq.allowOver) + (nq.keep > 0);
    assert.equal(relax.works.length + relax.notAlone.length, candidates, 'no rule is dropped silently');
    for (const w of relax.works) {
      const rq = optimizer.parseSearch(Object.fromEntries(new URLSearchParams(w.params)), { maps: inv.maps }).query;
      const rr = optimizer.search(inv, rq, { settings });
      assert.ok(rr.picks.length, `${w.key}: the page it links to has trips`);
      assert.equal(rr.picks[0].trip.total, w.total, `${w.key}: the price named is the pick on that page`);
      if (w.key === 'over') assert.ok(w.over > 0 && w.total <= Math.round(nq.budget * 1.1));
      else assert.ok(w.total <= rq.budget, `${w.key}: within the budget it is read against`);
      if (w.key === 'keep') { assert.equal(w.used % 100, 0); assert.ok(w.used > 0 && w.used <= nq.keep); assert.equal(rq.keep, nq.keep - w.used); assert.equal(rq.budget, nq.budget + w.used); }
    }
  }

  // The pages: the question, the picture on the trip page, the review's fit check, a price rise
  // that names where the money comes from, and the plan at checkout and after booking.
  const app = await startApp();
  t.after(app.close);
  const c = client(app.base);
  const noInline = (p, body) => { assert.ok(!/\sstyle="/.test(body), `${p} inline style`); assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(body), `${p} inline script`); };
  assert.match((await c.req('/plan?b=2000')).text, /just the booking, or the whole vacation\?[\s\S]*How much do you want available after you land\?/);
  const results = await c.req(`/trips?${new URLSearchParams({ ...QUERY, b: '2000', k: '400' })}`);
  assert.match(results.text, /\$400 is protected for after you land/);
  assert.match(results.text, /Unassigned/);
  const m = results.text.match(/href="(\/trip\/[^"?]+)\?([^"]*)"/);
  const tripPath = m[1], qs = m[2].replace(/&amp;/g, '&');
  assert.match(qs, /^b=1600&k=400/, 'the trip link carries the reserve with the booking budget');
  const page = await c.req(`${tripPath}?${qs}`);
  const total = Number(page.text.match(/"total":(\d+)/)[1]);
  noInline('/trip', page.text);
  assert.match(page.text, /Your money, the whole vacation/);
  assert.match(page.text, /Your booking budget/);
  assert.ok(page.text.includes(`Protected for the destination`) && page.text.includes(`<dd>${money(40000)}</dd>`));
  assert.ok(page.text.includes(`you arrive with</span><b>${money(200000 - total)}</b>`), 'arrive = vacation − booking');
  assert.match(page.text, /that is about \$\d{1,3}(,\d{3})* a day/, 'per day in whole dollars');
  assert.match(page.text, /We don’t put a number on/);
  assert.ok(!/estimated/i.test(page.text.slice(page.text.indexOf('id="vacation"'), page.text.indexOf('id="vacation"') + 6000)), 'nothing in the picture is an estimate');
  assert.match(page.text, /href="\/plan\?b=2000&amp;from=SFO[^"]*"/, 'changing the reserve keeps the search');
  const booking0 = await c.req(`${tripPath}?b=1600`);
  assert.match(booking0.text, /You told us \$1,600 is the booking/);

  const same = await c.req(`${tripPath}/review?${qs}&seen=${total}`);
  assert.match(same.text, /Your vacation plan/); assert.match(same.text, /Does the whole trip fit\?<\/b> Yes\./); assert.match(same.text, /Yes — continue to book/);
  assert.match(same.text, /A booking under \$1,600, keeping \$400 for the destination/);
  noInline('/review', same.text);
  const unassigned = 160000 - total;
  const small = await c.req(`${tripPath}/review?${qs}&seen=${total - 5000}`);
  assert.match(small.text, /went up by \$50\. Where should it come from\?/);
  assert.match(small.text, /reserve stays untouched/); assert.match(small.text, new RegExp(`Approve ${money(total).replace(/[$.]/g, '\\$&')} from unassigned money`));
  assert.ok(!/from my reserve/.test(small.text));
  // A rise bigger than the unassigned money names the part that would come out of the reserve.
  const bBelow = Math.floor((total - 5000) / 100); // a booking budget $50 below the price
  const rose = await c.req(`${tripPath}/review?b=${bBelow}&k=400&ov=10&seen=${bBelow * 100 - 2000}`);
  const fromReserve = total - bBelow * 100;
  assert.match(rose.text, /Where should it come from\?/);
  assert.ok(rose.text.includes(`take ${money(fromReserve)} from my reserve`), 'the button says exactly what it takes from the reserve');
  assert.match(rose.text, /Change my reserve/); assert.match(rose.text, /Don’t accept the new price/);
  // Over the booking budget without a rise: the trip page and the review say so by name.
  const raidPage = await c.req(`${tripPath}?b=${bBelow}&k=400&ov=10`);
  assert.match(raidPage.text, /Taken from your reserve/); assert.match(raidPage.text, /We never do that quietly/);
  assert.match(raidPage.text, /tb-meter tb-meter-over/); assert.ok(!/tb-meter-(good|near|full)|Comfortably within budget|>Within budget</.test(raidPage.text), 'never "within budget" when the booking eats the reserve');
  const raidReview = await c.req(`${tripPath}/review?b=${bBelow}&k=400&ov=10&seen=${total}`);
  assert.match(raidReview.text, /Not as planned/); assert.ok(raidReview.text.includes(`using ${money(fromReserve)} of my reserve`));

  // Checkout and the confirmation carry the plan; only the booking is charged.
  const cxField = same.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
  assert.match(cxField, /k=400/);
  const { quoteId, booking } = await quoteAndBook(c, { tripPath, approvedTotal: total, cxField });
  const checkout = await c.req(`/checkout/${quoteId}`);
  assert.match(checkout.text, /Your vacation plan/); assert.match(checkout.text, /Pay today/); assert.ok(checkout.text.includes(`<dd>${money(40000)}</dd>`));
  assert.match(checkout.text, new RegExp(`Confirm &amp; pay ${money(total).replace(/[$.]/g, '\\$&')}`), 'the charge is the booking alone');
  const paid = await c.req(`/api/bookings/${booking.ref}/pay`, { method: 'POST', json: { method: CARD } });
  assert.equal(paid.status, 200, paid.text);
  const confirmed = await c.req(`/booking/${booking.ref}`);
  assert.ok(confirmed.text.includes(`You protected <b>${money(40000)}</b> for the destination`));
  assert.match(confirmed.text, /under your \$1,600 booking budget/);

  // No fit with a reserve: the collision is spelled out and only real relaxations are offered.
  const nofit = await c.req(`/trips?${new URLSearchParams({ ...QUERY, b: '1300', k: '300', nights: '7' })}`);
  if (/couldn’t build a trip/.test(nofit.text)) {
    assert.match(nofit.text, /Your vacation budget is \$1,300\. You protect \$300 for the destination, which leaves \$1,000 for the booking/);
    assert.match(nofit.text, /Protect less for the destination/);
    assert.match(nofit.text, /One rule away|None of them gets there alone/);
    for (const [, href] of nofit.text.matchAll(/<ul class="tb-relax">[\s\S]*?<\/ul>/g).next().value ? [...nofit.text.match(/<ul class="tb-relax">[\s\S]*?<\/ul>/)[0].matchAll(/href="([^"]+)"/g)] : []) {
      const linked = await c.req(href.replace(/&amp;/g, '&'));
      assert.equal(linked.status, 200); assert.match(linked.text, /Our pick/); assert.ok(!/couldn’t build a trip/.test(linked.text), 'a one-rule-away link never lands on another dead end');
    }
  }
});
