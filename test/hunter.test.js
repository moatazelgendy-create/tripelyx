// THE SAVINGS HUNTER engine: a first run finds a qualifying trip or says why not; every opportunity's
// total is the pricer's own for its token; a second run with the same clock is silent; a previous price
// appears only when the platform recorded one; the threshold suppresses a small drop; the quality gate
// ignores a cheaper trip with a trade-off unless the customer chose aggressive savings; nonstop fires
// only with a preferred nonstop rule and a recorded best with a stop; extra-night and quality obey
// their conditions; excluded destinations and the target ceiling are honoured; and the words never
// pressure, predict or claim a search that did not happen.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const optimizer = require('../server/trips/optimizer');
const decision = require('../server/trips/decision');
const { classifyChanges } = require('../server/trips/facts');
const { priceTrip } = require('../server/trips/pricing');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { addDays, today } = require('../server/lib/dates');
const { format } = require('../server/lib/money');
const hunter = require('../server/trips/hunter');

const fmt = cents => format(cents, 'USD');
const now = new Date();
let app, inv, settings;
before(async () => {
  app = await startApp();
  inv = app.tripService.inv;
  settings = app.tripService.settings ? await app.tripService.settings() : app.agent.svc.settings();
});
after(() => app && app.close());

// A hunt record as the service keeps it; everything a test changes is passed in.
function H(over = {}) {
  return {
    id: 'hnt_test', userId: 'usr_test', name: '$1,000 Beach Hunt', budget: 100000, origin: 'NYC', travelers: 2, who: 'couple',
    dateMode: 'anytime', month: null, minNights: 3, maxNights: 6, style: 'beach',
    rules: { flightStops: null, flightRule: null, minStars: null, refundable: null, meals: null, bags: null },
    excludeDests: [], savedToken: null, notify: ['under', 'drop', 'extra-night', 'nonstop', 'quality', 'destination'], threshold: 5000,
    savingsLevel: 'balanced', status: 'hunting', target: null, floors: { minStars: null, nonstop: false }, baseline: null,
    runs: [], opportunities: [], learned: [], lastRunAt: null, lastMeaningfulAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    ...over,
  };
}
const run = (hunt, previous = null) => hunter.runHunt(inv, hunt, settings, { now, previous });
// What the service records after a run: the baseline shape, from the run's own fields.
const baselineOf = r => ({ at: r.at, best: r.best && { token: r.best.token, total: r.best.total, nights: r.best.nights, stops: r.best.stops, stars: r.best.stars, dest: r.best.dest }, closest: r.closest, byDest: r.byDest, nonstop: r.nonstop });
const rec = c => ({ token: c.token, total: c.total, nights: c.nights, stops: c.stops, stars: c.stars, dest: c.dest });
const price = token => priceTrip(inv, decodeSpec(token), settings);

// The qualifying pool, built independently of the engine from the libraries it must use: every
// eligible package of the optimizer's search for each length, graded great or good by the decision
// layer with the budget in the picture, inside the floors and outside the destinations left out.
function pool(hunt) {
  const origin = inv.maps.getOrigin(hunt.origin) ? hunt.origin : inv.maps.airport(hunt.origin).originId;
  const excluded = new Set(hunt.excludeDests || []);
  const f = hunt.floors || {};
  const out = [];
  for (const n of hunter.nightsRange(hunt)) {
    const q = { ...hunter.huntQuery(hunt, n), origin };
    const r = optimizer.search(inv, q, { settings, now });
    const ctx = { ...r.ctx, rules: q.rules };
    for (const x of r.eligibleTrips) {
      const t = x.trip;
      if (excluded.has(t.dest.id)) continue;
      const v = decision.verdict(t, ctx);
      if (!['great', 'good'].includes(v.grade) || (f.minStars && t.hotel.stars < f.minStars) || (f.nonstop && t.flight.stops > 0)) continue;
      out.push({ trip: t, token: encodeSpec(t.spec), total: t.total, nights: t.spec.nights, match: v.match, stars: t.hotel.stars, stops: t.flight.stops, dest: t.dest.id });
    }
  }
  return out;
}
// The optimizer's way of picking, as the engine must: the cheapest of the near-equal strongest.
const strongest = cands => { const top = Math.max(...cands.map(c => c.match)); return cands.filter(c => c.match >= top - 3).sort((a, b) => a.total - b.total || b.match - a.match)[0]; };
// A token judged by the libraries alone: priced now, great or good by the decision layer with the
// hunt's budget in the picture, at or under the ceiling, inside the lengths, the rules, the floors,
// the window and outside the destinations left out. The engine's best may be a version the optimizer
// never prices (a day moved by the savings check), so membership of the pool is not the test; this is.
function judgeToken(hunt, token) {
  const t = price(token);
  if (!t) return false;
  const q = hunter.huntQuery(hunt, t.spec.nights);
  const v = decision.verdict(t, { ...optimizer.budgetContext(q), rules: q.rules });
  const f = hunt.floors || {};
  return ['great', 'good'].includes(v.grade) && t.total <= hunter.ceilingOf(hunt) && hunter.nightsRange(hunt).includes(t.spec.nights)
    && !(hunt.excludeDests || []).includes(t.dest.id) && optimizer.rulesAllowFlight(t.flight, q.rules) && optimizer.rulesAllowHotel(t.hotel, q.rules)
    && (!f.minStars || t.hotel.stars >= f.minStars) && (!f.nonstop || t.flight.stops === 0) && (q.dateMode !== 'flexible' || t.spec.depart.slice(0, 7) === q.month);
}
// The pool plus the engine's own best when the savings check moved it off the optimizer's dates.
const poolWith = (hunt, r) => (r.challenger && r.best ? [{ ...rec(r.best), trip: r.best.trip, match: decision.verdict(r.best.trip, { ...optimizer.budgetContext(hunter.huntQuery(hunt, r.best.nights)), rules: hunter.huntQuery(hunt, r.best.nights).rules }).match }, ...pool(hunt)] : pool(hunt));

// Words: no urgency, no scarcity, no prediction; every amount spoken is one of the priced facts given.
const FORBIDDEN = /typical|usually|predict|forecast|hurry|don.t miss|only \d+ left|last chance|limited time|act now|expir|selling fast|book now|countdown/i;
const amounts = text => text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
function checkWords(text, allowed) {
  assert.doesNotMatch(text, FORBIDDEN);
  const ok = new Set(allowed.filter(Number.isFinite).map(fmt));
  for (const a of amounts(text)) assert.ok(ok.has(a), `${a} is a priced fact in: ${text}`);
}
// Every opportunity is a priced package and carries its receipt and decision; `allowed` are the extra
// amounts its words may name beyond its own total, the limit and what remains.
function checkOpportunity(o, hunt, allowed = []) {
  const t = price(o.trip.token);
  assert.ok(t, 'the token prices');
  assert.equal(o.trip.total, t.total, 'the total is the pricer\'s own for this token');
  assert.equal(o.trip.token, encodeSpec(t.spec));
  assert.ok(o.trip.total <= hunter.ceilingOf(hunt));
  assert.ok(hunter.nightsRange(hunt).includes(o.trip.nights));
  assert.ok(!(hunt.excludeDests || []).includes(o.trip.destId));
  assert.ok(judgeToken(hunt, o.trip.token), 'the opportunity passes the floor by the libraries\' own judgement');
  assert.equal(o.at, now.toISOString()); assert.equal(o.verifiedAt, now.toISOString());
  assert.ok(hunter.KINDS.includes(o.kind));
  assert.deepEqual(o.receipt.rules, hunter.ruleLines(hunt, { maps: inv.maps }));
  assert.equal(o.receipt.found[0], `${fmt(o.trip.total)} total, everything included`);
  assert.equal(o.receipt.found[1], `${o.trip.nights} nights in ${o.trip.dest}`);
  assert.equal(o.receipt.why, `This currently satisfies your trip rules and is ${fmt(hunt.budget - o.trip.total)} below your limit.`);
  assert.ok(Array.isArray(o.why) && o.why.length >= 1);
  const text = hunter.decisionText(o, hunt);
  assert.match(text, /Your limit is \$[\d,]+(?:\.\d{2})?\./);
  assert.ok(text.includes(`${fmt(hunt.budget - o.trip.total)} remains.`));
  assert.ok(text.includes('This currently meets the rules you gave me.'));
  assert.ok(text.includes(`Current price was verified at ${o.verifiedAt.slice(0, 10)} ${o.verifiedAt.slice(11, 16)} UTC. Price and availability may change.`));
  const known = [o.trip.total, hunt.budget, hunt.budget - o.trip.total, hunter.ceilingOf(hunt), hunter.ceilingOf(hunt) - o.trip.total, o.delta, o.delta !== null ? -o.delta : null, o.previous && o.previous.total, ...allowed];
  checkWords(text, known);
  for (const w of [...o.why, ...o.receipt.found, o.receipt.why]) assert.doesNotMatch(w, FORBIDDEN);
  return text;
}
// A dearer inventory: every hotel rate multiplied, so a run records "nothing fits" with a real closest.
const dearer = factor => ({ ...inv, hotels: { ...inv.hotels, search: q => inv.hotels.search(q).map(h => ({ ...h, netNightly: Math.round(h.netNightly * factor) })) } });

test('a first run finds a qualifying trip (the strongest, then beaten by its own cheaper version) or says why not; every number is a priced fact', () => {
  const hunt = H();
  const t0 = Date.now();
  const r = run(hunt);
  assert.ok(Date.now() - t0 < 3000, 'a run stays under three seconds on the demo');
  assert.equal(r.at, now.toISOString());
  assert.equal(r.ceiling, 100000);
  assert.deepEqual(r.checked.nightsTried, [3, 4, 5, 6]);
  assert.ok(r.checked.destinations >= 1 && r.checked.considered >= r.checked.eligible && r.checked.eligible >= r.checked.qualifying);
  assert.ok(r.checked.versions >= r.checked.considered);
  assert.ok(r.checked.negotiated.includes('Airport: JFK only'), 'the airport searched is named, and no other');
  assert.ok(r.checked.negotiated.some(l => l.startsWith('Lengths: 3 to 6 nights')));
  for (const l of r.checked.negotiated) assert.doesNotMatch(l, FORBIDDEN);
  assert.ok(r.best, 'the demo prices a qualifying beach trip under $1,000 from New York');
  // The best is the strongest of the independent pool, or that trip beaten by a cheaper version of
  // itself with nothing given up (the challenger), never anything else.
  const P = pool(hunt);
  assert.equal(r.checked.qualifying, P.length + (r.challenger ? 1 : 0));
  const top = strongest(P);
  if (r.challenger) {
    assert.equal(r.challenger.from, top.total);
    assert.equal(r.challenger.to, r.best.total);
    assert.ok(r.best.total < top.total);
    assert.deepEqual(classifyChanges(top.trip, r.best.trip).tradeoffs, []);
    assert.match(r.checked.negotiated[5], new RegExp(`${fmt(top.total).replace(/[$.]/g, '\\$&')} became ${fmt(r.best.total).replace(/[$.]/g, '\\$&')}$`));
  } else {
    assert.equal(r.best.token, top.token);
    assert.match(r.checked.negotiated[5], /nothing cheaper without a compromise$/);
  }
  assert.equal(r.best.total, price(r.best.token).total);
  assert.ok(['great', 'good'].includes(r.best.grade));
  assert.ok(judgeToken(hunt, r.best.token), 'the best passes the floor by the libraries\' own judgement');
  assert.equal(r.closest, null, 'closest is only recorded when nothing qualifies');
  // byDest: the cheapest qualifying trip per destination, each a priced token; nonstop: the cheapest nonstop.
  for (const d of r.byDest) { const t = price(d.token); assert.equal(d.total, t.total); assert.equal(d.dest, t.dest.id); assert.equal(d.total, Math.min(...[...P, ...(r.challenger ? [r.best] : [])].filter(c => c.dest === d.dest).map(c => c.total))); }
  if (r.nonstop) { const t = price(r.nonstop.token); assert.equal(r.nonstop.total, t.total); assert.equal(t.flight.stops, 0); assert.equal(r.nonstop.total, Math.min(...P.filter(c => c.stops === 0).map(c => c.total))); }
  // The decision: one opportunity, kind found, no previous price (none was recorded).
  assert.equal(r.silent, null);
  assert.equal(r.opportunities.length, 1);
  const o = r.opportunities[0];
  assert.equal(o.kind, 'found');
  assert.equal(o.previous, null); assert.equal(o.delta, null);
  assert.equal(o.trip.token, r.best.token);
  const text = checkOpportunity(o, hunt, r.challenger ? [r.challenger.from] : []);
  assert.ok(text.startsWith(`I found a ${o.trip.nights}-night ${o.trip.dest} trip for ${fmt(o.trip.total)} total. Your limit is $1,000.`));
  assert.ok(text.includes(o.trip.stops === 0 ? ' Nonstop. ' : ` ${o.trip.stops} stop each way. `));
  assert.ok(text.includes(` ${o.trip.hotel.stars}-star hotel. `));
  assert.equal(o.why[0], `${fmt(100000 - o.trip.total)} under your $1,000 limit`);
  if (r.challenger) assert.ok(o.why.some(w => w === `I first found it at ${fmt(r.challenger.from)}; ${r.challenger.why} gets it for ${fmt(r.challenger.to)}`));
  assert.ok(!text.includes('recorded') && !text.includes('before') && !text.includes('Last time'), 'no previous price is implied');
  // The hunt card is the trip's facts.
  const t = r.best.trip;
  assert.deepEqual(o.trip, hunter.huntCard(t, r.best.token));
  assert.equal(o.trip.ret, t.flight.return); assert.equal(o.trip.destId, t.dest.id); assert.equal(o.trip.airline, t.flight.airline); assert.equal(o.trip.fareName, t.flight.name);
  assert.equal(o.trip.hotel.name, t.hotel.name); assert.equal(o.trip.activities, t.activities.length); assert.equal(o.trip.bags, t.flight.carryOn ? 'Carry-on only' : 'Personal item only');
  assert.equal(o.trip.perTraveler, t.perTraveler);

  // Why not: a budget nothing fits says so, names the cheapest trip inside the rules and how far over
  // it is, records it as `closest`, and interrupts nobody.
  const low = run(H({ budget: 30000 }));
  assert.equal(low.best, null);
  assert.deepEqual(low.opportunities, []);
  assert.ok(low.closest, 'the cheapest trip inside the rules is recorded');
  assert.equal(low.closest.total, price(low.closest.token).total);
  assert.ok(low.closest.total > 30000);
  assert.equal(low.closest.over, low.closest.total - 30000);
  assert.equal(low.silent, `nothing qualifies inside $300 under your rules; the cheapest trip inside your rules is ${fmt(low.closest.total)}, ${fmt(low.closest.over)} over`);
  assert.deepEqual(low.byDest, []); assert.equal(low.nonstop, null); assert.equal(low.extraNight, null); assert.equal(low.challenger, null);
  checkWords(low.silent, [30000, low.closest.total, low.closest.over]);
  // Not asked to hear about trips under the limit: the find is recorded, the customer is not interrupted.
  const quiet = run(H({ notify: ['drop'] }));
  assert.ok(quiet.best); assert.deepEqual(quiet.opportunities, []);
  assert.equal(quiet.silent, `the best trip is ${fmt(quiet.best.total)}; you did not ask to be told about trips under the limit`);
});

test('a second run with the same clock is silent: the best is unchanged, and nothing is said twice', () => {
  const hunt = H();
  const r1 = run(hunt);
  const r2 = run(hunt, baselineOf(r1));
  assert.equal(r2.best.token, r1.best.token);
  assert.equal(r2.best.total, r1.best.total);
  assert.deepEqual(r2.opportunities, []);
  assert.equal(r2.silent, `the best trip is unchanged at ${fmt(r1.best.total)}`);
  // The same again: still silent, still the same reason.
  const r3 = run(hunt, baselineOf(r2));
  assert.deepEqual(r3.opportunities, []);
  assert.equal(r3.silent, r2.silent);
  // The record's best gone (a token the suppliers no longer have): the find is news again, and says why.
  const gone = run(hunt, { ...baselineOf(r1), best: { ...baselineOf(r1).best, token: 'nowhere~JFK~2026-12-01~3~2c~x-1~saver~00~-' } });
  assert.equal(gone.opportunities.length, 1);
  assert.equal(gone.opportunities[0].kind, 'found');
  assert.equal(gone.opportunities[0].why[0], `The ${fmt(r1.best.total)} trip I found before can no longer be priced`);
  assert.equal(gone.opportunities[0].lead, `The ${fmt(r1.best.total)} trip I found before can no longer be priced.`);
  assert.ok(hunter.decisionText(gone.opportunities[0], hunt).startsWith(`The ${fmt(r1.best.total)} trip I found before can no longer be priced. I found a `));
  // A trip the customer rejected is out of this mission: the next strongest stands, and the rejected
  // token appears nowhere.
  const rejected = run({ ...hunt, opportunities: [{ ...r1.opportunities[0], id: 'opp_1', status: 'rejected', notified: true }] });
  assert.ok(rejected.best && rejected.best.token !== r1.best.token);
  assert.ok(rejected.byDest.every(d => d.token !== r1.best.token));
  for (const o of rejected.opportunities) assert.notEqual(o.trip.token, r1.best.token);
  assert.ok(judgeToken(hunt, rejected.best.token));
  // The find already told (the record's best gone, the same trip found again): not told twice.
  const again = run({ ...hunt, opportunities: [{ ...r1.opportunities[0], id: 'opp_1', status: 'seen', notified: true }] }, { ...baselineOf(r1), best: { ...baselineOf(r1).best, token: 'nowhere~JFK~2026-12-01~3~2c~x-1~saver~00~-' } });
  assert.deepEqual(again.opportunities, []);
  assert.equal(again.silent, `the best trip is ${fmt(r1.best.total)}, which I already told you about`);
});

test('a previous price appears only when the platform recorded one: breakthrough against a recorded closest, found otherwise', () => {
  const hunt = H();
  // Last time, at dearer hotel rates, nothing fit: the run recorded the cheapest trip inside the rules.
  const before = hunter.runHunt(dearer(2), hunt, settings, { now });
  assert.equal(before.best, null);
  assert.ok(before.closest && before.closest.total > 100000, 'the recorded closest is over the ceiling');
  assert.match(before.silent, /^nothing qualifies inside \$1,000 under your rules; the cheapest trip inside your rules is \$[\d,.]+, \$[\d,.]+ over$/);
  const r = run(hunt, baselineOf(before));
  assert.equal(r.opportunities.length, 1);
  const o = r.opportunities[0];
  assert.equal(o.kind, 'breakthrough');
  assert.deepEqual(o.previous, before.closest, 'the previous price is the one recorded, and only that');
  assert.equal(o.delta, before.closest.total - o.trip.total);
  assert.equal(o.why[0], `Last time the cheapest trip inside your rules was ${fmt(before.closest.total)}, ${fmt(before.closest.total - 100000)} over your limit`);
  const text = checkOpportunity(o, hunt, [before.closest.total, r.challenger && r.challenger.from]);
  assert.ok(text.startsWith(`A ${o.trip.nights}-night ${o.trip.dest} trip now fits: ${fmt(o.trip.total)} total. Last time the cheapest trip inside your rules was ${fmt(before.closest.total)}, over your limit.`));
  // A record with nothing in it is a first run: found, no previous.
  const first = run(hunt, { at: now.toISOString(), best: null, closest: null, byDest: [], nonstop: null });
  assert.equal(first.opportunities[0].kind, 'found');
  assert.equal(first.opportunities[0].previous, null);
  assert.ok(!hunter.decisionText(first.opportunities[0], hunt).includes('Last time'));
  // A recorded closest that was not over this ceiling is not a breakthrough either.
  const under = run(hunt, { at: now.toISOString(), best: null, closest: run(H({ budget: 30000 })).closest, byDest: [], nonstop: null });
  assert.equal(under.opportunities[0].kind, 'found');
  assert.equal(under.opportunities[0].previous, null);
  // The threshold gates a find too: a trip a dollar under the limit is not worth an interruption at $500+.
  const r1 = run(hunt);
  const limit = (r1.challenger ? r1.challenger.from : r1.best.total) + 100;
  const tight = run(H({ budget: limit, threshold: 50000 }));
  assert.ok(tight.best);
  assert.ok(limit - tight.best.total < 50000);
  assert.deepEqual(tight.opportunities, []);
  assert.equal(tight.silent, `the best trip is ${fmt(tight.best.total)}, ${fmt(limit - tight.best.total)} under your limit, under your $500 threshold`);
});

test('the threshold suppresses a small drop of the same trip; "recommend" lets any saving through; the drop names the recorded price', () => {
  const hunt = H();
  const r1 = run(hunt);
  const base = baselineOf(r1);
  // The record says the trip cost $10 more when it was recorded.
  const small = { ...base, best: { ...base.best, total: base.best.total + 1000 } };
  const r2 = run(hunt, small);
  assert.deepEqual(r2.opportunities, []);
  assert.equal(r2.silent, 'the saving is $10, under your $50 threshold');
  // Only what the customer would actually recommend: the grade alone, so a $10 drop of the same trip counts.
  const r3 = run(H({ threshold: 'recommend' }), small);
  assert.equal(r3.opportunities.length, 1);
  const o = r3.opportunities[0];
  assert.equal(o.kind, 'drop');
  assert.equal(o.trip.token, base.best.token);
  assert.deepEqual(o.previous, small.best, 'the previous is the record itself');
  assert.equal(o.delta, 1000);
  assert.equal(o.why[0], `The same trip, now ${fmt(o.trip.total)}: $10 less than the ${fmt(small.best.total)} I recorded on ${base.at.slice(0, 10)}`);
  const text = checkOpportunity(o, H({ threshold: 'recommend' }));
  assert.ok(text.startsWith(`The ${o.trip.nights}-night ${o.trip.dest} trip I found is now ${fmt(o.trip.total)} total, $10 less than the ${fmt(small.best.total)} I recorded.`));
  // A $60 drop clears a $50 threshold.
  const sixty = { ...base, best: { ...base.best, total: base.best.total + 6000 } };
  const r4 = run(hunt, sixty);
  assert.equal(r4.opportunities.length, 1);
  assert.equal(r4.opportunities[0].kind, 'drop');
  assert.equal(r4.opportunities[0].delta, 6000);
  // Told once: the same drop at the same price is not told again; a further drop (the same trip
  // priced lower still, here at cheaper hotel rates) is.
  const toldOnce = { ...hunt, opportunities: [{ ...r4.opportunities[0], id: 'opp_1', status: 'seen', notified: true }] };
  assert.deepEqual(run(toldOnce, sixty).opportunities, []);
  const further = hunter.runHunt(dearer(0.9), toldOnce, settings, { now, previous: sixty });
  assert.equal(further.opportunities.length, 1);
  assert.equal(further.opportunities[0].kind, 'drop');
  assert.ok(further.opportunities[0].trip.total < r4.opportunities[0].trip.total);
  assert.equal(further.opportunities[0].delta, sixty.best.total - further.opportunities[0].trip.total);
  assert.equal(further.opportunities[0].trip.total, priceTrip(dearer(0.9), decodeSpec(further.opportunities[0].trip.token), settings).total);
  // Not asked to hear about drops: the drop is not announced, and the reason says so.
  const nd = run(H({ notify: ['under'] }), sixty);
  assert.deepEqual(nd.opportunities, []);
  assert.match(nd.silent, /^a trip \$60 cheaper than the \$[\d,.]+ \d+-night .+ trip I found before fits; you did not ask to be told about drops$/);
  // A rise is not a drop and is not announced; the reason says what happened.
  const r5 = run(hunt, { ...base, best: { ...base.best, total: base.best.total - 2000 } });
  assert.deepEqual(r5.opportunities, []);
  assert.equal(r5.silent, `the trip I found is now ${fmt(base.best.total)}, $20 more than the ${fmt(base.best.total - 2000)} I recorded; nothing cheaper qualifies`);
  assert.deepEqual(hunter.THRESHOLDS, [5000, 10000, 20000]);
  assert.equal(hunter.thresholdOf(H({ threshold: 'recommend' })), 0);
  assert.equal(hunter.thresholdOf(H({ threshold: 20000 })), 20000);
});

test('the quality gate: a cheaper trip that gives something up is ignored, unless the customer chose aggressive savings, and then every trade-off is said', () => {
  const hunt = H({ budget: 120000, notify: ['drop'] });
  const P = poolWith(hunt, run(hunt));
  // The trip on record: the longest, best-appointed qualifying trip such that every cheaper qualifying
  // trip gives something up against it (fewer nights, a lesser hotel, a lesser fare).
  const longest = Math.max(...P.map(c => c.nights));
  const prev = P.filter(c => c.nights === longest).sort((a, b) => b.stars - a.stars || b.total - a.total)
    .find(p => P.filter(c => c.total < p.total).length && P.filter(c => c.total < p.total).every(c => classifyChanges(p.trip, c.trip).tradeoffs.length));
  assert.ok(prev, 'the demo has a recorded trip every cheaper trip trades something against');
  const base = { at: now.toISOString(), best: rec(prev), closest: null, byDest: [], nonstop: null };
  const cheapest = [...P.filter(c => c.total < prev.total)].sort((a, b) => a.total - b.total)[0];
  // Balanced: silence, with the cheaper trip's price and what it gives up as the reason.
  const r = run(hunt, base);
  assert.deepEqual(r.opportunities, []);
  assert.match(r.silent, /^a cheaper trip exists at \$[\d,.]+ but gives something up: .+/);
  const named = amounts(r.silent)[0];
  assert.ok(P.some(c => fmt(c.total) === named && c.total < prev.total), 'the price named is a qualifying trip\'s own');
  // Aggressive: the saving is reported with its trade-offs, in the receipt and the decision alike.
  const aggressive = { ...hunt, savingsLevel: 'aggressive' };
  const a = run(aggressive, base);
  assert.equal(a.opportunities.length, 1);
  const o = a.opportunities[0];
  assert.equal(o.kind, 'drop');
  assert.equal(o.trip.total, cheapest.total, 'the largest saving');
  assert.equal(o.delta, prev.total - o.trip.total);
  assert.ok(o.tradeoffs.length >= 1);
  const ch = classifyChanges(price(prev.token), price(o.trip.token));
  assert.deepEqual(o.tradeoffs, ch.tradeoffs.map(x => `${x.label.toLowerCase()}: ${x.b} (was ${x.a})`));
  assert.ok(o.why.some(w => w.startsWith('Gives up: ')));
  assert.ok(!o.why[0].includes('nothing given up'));
  assert.equal(o.previous.token, prev.token); assert.equal(o.previous.total, prev.total); assert.equal(o.previous.totalNow, price(prev.token).total);
  const text = checkOpportunity(o, aggressive);
  assert.ok(text.includes(`${fmt(o.delta)} less than the ${fmt(prev.total)} trip I found before.`));
  assert.ok(text.includes('Against the trip I found before it gives up '));
  assert.ok(!text.includes('nothing given up'));
  // The same recorded trip, nothing cheaper without a compromise: a different, dearer best is not news.
  const notify = run({ ...hunt, threshold: 'recommend' }, { ...base, best: { ...base.best, total: base.best.total } });
  assert.ok(notify.opportunities.every(x => x.kind !== 'quality' && x.kind !== 'extra-night'));
});

test('nonstop fires only with a preferred nonstop rule, a recorded best with a stop, and no nonstop on the previous record', () => {
  const preferred = H({ budget: 120000, rules: { ...H().rules, flightStops: 'nonstop', flightRule: 'preferred' } });
  const r1 = run(preferred);
  assert.ok(r1.best && r1.best.stops > 0, 'the demo\'s best at $1,200 has a stop, so the preference is live');
  assert.ok(r1.nonstop, 'a nonstop trip fits the ceiling');
  assert.deepEqual(hunter.huntQuery(preferred, 3).rules, null, 'a preferred nonstop is not a filter');
  assert.ok(r1.opportunities[0].why.includes(`You prefer nonstop: the cheapest nonstop trip inside your limit is ${fmt(r1.nonstop.total)}`));
  assert.ok(r1.opportunities[0].receipt.rules.includes('Nonstop: preferred'));
  // The record had no nonstop inside the ceiling; now one does: that is the news, said as the customer asked.
  const base = { ...baselineOf(r1), nonstop: null };
  const r2 = run(preferred, base);
  const o = r2.opportunities.find(x => x.kind === 'nonstop');
  assert.ok(o, `nonstop fires: ${r2.silent} ${r2.opportunities.map(x => x.kind)}`);
  assert.equal(o.trip.stops, 0);
  assert.equal(o.trip.total, r2.nonstop.total);
  assert.equal(o.delta, o.trip.total - base.best.total);
  assert.ok(o.why.includes(hunter.NONSTOP_LINE));
  assert.equal(o.previous.token, base.best.token); assert.equal(o.previous.stops, base.best.stops);
  const text = checkOpportunity(o, preferred);
  assert.ok(text.startsWith(`A nonstop ${o.trip.dest} trip fits: ${fmt(o.trip.total)} total, ${o.delta > 0 ? `${fmt(o.delta)} more than` : o.delta < 0 ? `${fmt(-o.delta)} less than` : 'the same money as'} the ${base.best.stops} stop trip I found. ${hunter.NONSTOP_LINE}`));
  assert.ok(text.includes(' Nonstop. '));
  assert.equal(r2.opportunities.filter(x => x.kind === 'nonstop').length, 1);
  // Not when the previous record already had a nonstop inside the ceiling (it was announced then).
  assert.ok(!run(preferred, baselineOf(r1)).opportunities.some(x => x.kind === 'nonstop'));
  // Not without the preference.
  assert.ok(!run(H({ budget: 120000 }), base).opportunities.some(x => x.kind === 'nonstop'));
  // Not when the rule is hard: every trip is nonstop already, and the rule is a filter.
  const hard = H({ budget: 120000, rules: { ...H().rules, flightStops: 'nonstop', flightRule: 'hard' } });
  assert.equal(hunter.huntQuery(hard, 3).rules.nonstop, true);
  const h1 = run(hard);
  if (h1.best) { assert.equal(h1.best.stops, 0); for (const d of h1.byDest) assert.equal(price(d.token).flight.stops, 0); }
  assert.ok(!run(hard, { ...base, best: { ...base.best } }).opportunities.some(x => x.kind === 'nonstop'));
  // Not when the recorded best is already nonstop.
  const ns = price(r1.nonstop.token);
  assert.ok(!run(preferred, { ...base, best: { token: r1.nonstop.token, total: ns.total, nights: ns.spec.nights, stops: 0, stars: ns.hotel.stars, dest: ns.dest.id } }).opportunities.some(x => x.kind === 'nonstop'));
  // Not when the customer did not ask to hear about it.
  assert.ok(!run({ ...preferred, notify: ['under', 'drop'] }, base).opportunities.some(x => x.kind === 'nonstop'));
});

test('extra-night and quality obey their conditions, judged against the trip on record by the facts', () => {
  const hunt = H({ name: '$1,800 Beach Hunt', budget: 180000, minNights: 4, maxNights: 7, notify: ['extra-night'] });
  const P = pool(hunt);
  const lengthOnly = (a, b) => classifyChanges(a.trip, b.trip).tradeoffs.every(r => ['nights', 'time', 'dates'].includes(r.key));
  // An extra night for at most $25 more, nothing but the length changing, from two real priced trips.
  let pair = null;
  for (const a of P) {
    const bs = P.filter(b => b.nights === a.nights + 1 && b.total - a.total <= 2500 && lengthOnly(a, b)).sort((x, y) => x.total - y.total || y.match - x.match);
    if (bs.length) { pair = { a, b: bs[0] }; break; }
  }
  assert.ok(pair, 'the demo prices a longer trip within $25 of a shorter one');
  const base = { at: now.toISOString(), best: rec(pair.a), closest: null, byDest: [], nonstop: null };
  const r = run(hunt, base);
  const o = r.opportunities.find(x => x.kind === 'extra-night');
  assert.ok(o, `extra-night fires: ${r.silent}`);
  assert.equal(r.opportunities.length, 1);
  assert.equal(o.trip.nights, pair.a.nights + 1);
  assert.equal(o.trip.token, pair.b.token, 'the cheapest such trip');
  assert.equal(o.delta, pair.b.total - pair.a.total);
  assert.ok(o.delta <= 2500);
  assert.equal(o.previous.token, pair.a.token); assert.equal(o.previous.total, pair.a.total); assert.equal(o.previous.nights, pair.a.nights);
  assert.deepEqual(o.tradeoffs, []);
  assert.equal(o.why[0], `${pair.a.nights + 1} nights instead of ${pair.a.nights} for ${o.delta > 0 ? `${fmt(o.delta)} more than` : o.delta < 0 ? `${fmt(-o.delta)} less than` : 'the same money as'} the ${fmt(pair.a.total)} ${pair.a.nights}-night ${pair.a.trip.dest.name} trip I found before`);
  const text = checkOpportunity(o, hunt);
  assert.ok(text.startsWith(`${o.trip.nights} nights in ${o.trip.dest} for ${fmt(o.trip.total)} total, ${o.delta > 0 ? `${fmt(o.delta)} more than` : o.delta < 0 ? `${fmt(-o.delta)} less than` : 'the same money as'} the ${pair.a.nights}-night trip I found.`));
  // Told once, never again for that trip; rejected, never that trip again.
  const told = run({ ...hunt, opportunities: [{ ...o, id: 'opp_1', status: 'seen', notified: true }] }, base);
  assert.ok(!told.opportunities.some(x => x.kind === 'extra-night' && x.trip.token === o.trip.token));
  const rej = run({ ...hunt, opportunities: [{ ...o, id: 'opp_1', status: 'rejected', notified: true }] }, base);
  assert.ok(rej.opportunities.every(x => x.trip.token !== o.trip.token) && rej.byDest.every(d => d.token !== o.trip.token));
  // No candidate within the cap: nothing fires.
  const far = P.find(a => !P.some(b => b.nights === a.nights + 1 && b.total - a.total <= 2500 && lengthOnly(a, b)));
  assert.ok(far, 'a recorded trip with no extra night within $25');
  const rf = run(hunt, { ...base, best: rec(far) });
  assert.ok(!rf.opportunities.some(x => x.kind === 'extra-night'));
  // The longest length on record: no longer trip is in the range, so nothing fires.
  const longest = P.find(a => a.nights === 7);
  if (longest) assert.ok(!run(hunt, { ...base, best: rec(longest) }).opportunities.some(x => x.kind === 'extra-night'));

  // Quality: same money (or less), a better hotel class, nothing given up.
  const qh = { ...hunt, notify: ['quality'] };
  let qpair = null;
  for (const a of P) {
    const bs = P.filter(b => b.stars > a.stars && b.total <= a.total && !classifyChanges(a.trip, b.trip).tradeoffs.length);
    if (bs.length) { qpair = { a, bs }; break; }
  }
  assert.ok(qpair, 'the demo prices a better hotel class for the same money');
  const q = run(qh, { ...base, best: rec(qpair.a) });
  const qo = q.opportunities.find(x => x.kind === 'quality');
  assert.ok(qo, `quality fires: ${q.silent}`);
  assert.equal(q.opportunities.length, 1);
  assert.ok(qo.trip.hotel.stars > qpair.a.stars);
  assert.ok(qo.trip.total <= qpair.a.total);
  assert.equal(qo.delta, qo.trip.total - qpair.a.total);
  assert.deepEqual(classifyChanges(qpair.a.trip, price(qo.trip.token)).tradeoffs, []);
  assert.equal(qo.trip.hotel.stars, Math.max(...qpair.bs.map(b => b.stars)), 'the best class for the money');
  assert.deepEqual(qo.tradeoffs, []);
  assert.equal(qo.previous.token, qpair.a.token); assert.equal(qo.previous.hotel.stars, qpair.a.stars);
  const qt = checkOpportunity(qo, qh);
  assert.ok(qt.startsWith(`A ${qo.trip.hotel.stars}-star hotel in ${qo.trip.dest} for ${fmt(qo.trip.total)} total, ${qo.delta < 0 ? `${fmt(-qo.delta)} less than` : 'the same money as'} the ${qpair.a.stars}-star trip I found.`));
  // The best class on record: nothing better to show.
  const topStars = Math.max(...P.map(c => c.stars));
  const topRec = P.find(c => c.stars === topStars);
  assert.ok(!run(qh, { ...base, best: rec(topRec) }).opportunities.some(x => x.kind === 'quality'));
  // A destination unlocks only when the record had none there, and the trip gives nothing up.
  const dh = { ...hunt, notify: ['destination'] };
  const r1 = run(dh);
  const dropped = r1.byDest.filter(d => d.dest !== r1.best.dest);
  if (dropped.length) {
    const without = { ...baselineOf(r1), byDest: r1.byDest.filter(d => d.dest === r1.best.dest) };
    const d = run(dh, without);
    for (const x of d.opportunities) {
      assert.equal(x.kind, 'destination');
      assert.ok(dropped.some(y => y.dest === x.trip.destId));
      assert.deepEqual(classifyChanges(price(r1.best.token), price(x.trip.token)).tradeoffs, []);
      assert.equal(x.why[0], `Your ${fmt(hunt.budget)} just unlocked ${x.trip.dest}: ${x.trip.nights} nights for ${fmt(x.trip.total)}`);
      checkOpportunity(x, dh);
    }
    assert.ok(d.opportunities.length <= 1);
    assert.ok(!run(dh, baselineOf(r1)).opportunities.some(x => x.kind === 'destination'), 'every destination already on record: silence');
  }
});

test('excluded destinations, the target ceiling and the floors are honoured everywhere, and the receipt says so', () => {
  const hunt = H();
  const r1 = run(hunt);
  const out = r1.best.dest;
  const ex = H({ excludeDests: [out] });
  assert.equal(hunter.huntQuery(ex, 3).dests, null, 'the query itself is the contract\'s shape; the run applies the exclusion');
  const r2 = run(ex);
  assert.ok(r2.best && r2.best.dest !== out);
  assert.ok(r2.byDest.every(d => d.dest !== out));
  assert.ok(r2.checked.destinations < r1.checked.destinations);
  for (const o of r2.opportunities) { assert.notEqual(o.trip.destId, out); checkOpportunity(o, ex, [r2.challenger && r2.challenger.from]); }
  assert.ok(r2.opportunities[0].receipt.rules.includes(`Left out: ${inv.maps.getDestination(out).name}`));
  const P = pool(ex);
  assert.ok(P.every(c => c.dest !== out));
  assert.equal(r2.checked.qualifying, P.length + (r2.challenger ? 1 : 0));
  // "Find me something even better": the target is the ceiling the search uses; the budget stays the limit.
  const target = r1.best.total - 1;
  const th = H({ target });
  assert.equal(hunter.huntQuery(th, 3).budget, target);
  assert.equal(hunter.ceilingOf(th), target);
  assert.ok(hunter.ruleLines(th).includes(`Beat: ${fmt(target)} for the same quality`));
  assert.equal(hunter.ruleLines(th)[0], 'Maximum: $1,000');
  const r3 = run(th);
  assert.equal(r3.ceiling, target);
  if (r3.best) {
    assert.ok(r3.best.total <= target);
    for (const d of r3.byDest) assert.ok(d.total <= target);
    const o = r3.opportunities[0];
    if (o) {
      assert.ok(o.why.includes(`${fmt(target - o.trip.total)} under the ${fmt(target)} you asked me to beat`));
      const text = checkOpportunity(o, th);
      assert.ok(text.includes(`Your limit is $1,000. You asked me to beat ${fmt(target)}.`));
      assert.ok(text.includes(`${fmt(100000 - o.trip.total)} remains.`), 'what remains is read against the limit');
    }
  } else {
    assert.match(r3.silent, new RegExp(`^nothing qualifies inside ${fmt(target).replace(/[$.]/g, '\\$&')} under your rules; the cheapest trip inside your rules is \\$[\\d,.]+, (\\$[\\d,.]+ over|but it is not one I would book)$`));
    assert.ok(r3.closest && r3.closest.total === price(r3.closest.token).total);
    assert.equal(r3.closest.over, Math.max(0, r3.closest.total - target));
  }
  // Floors set with the target keep the quality: a 4-star floor is a rule for the search and the judge.
  const fl = H({ budget: 180000, minNights: 4, maxNights: 7, floors: { minStars: 4, nonstop: false } });
  assert.equal(hunter.huntQuery(fl, 4).rules.minStars, 4);
  const r4 = run(fl);
  assert.ok(r4.best && r4.best.stars >= 4);
  for (const d of r4.byDest) assert.ok(price(d.token).hotel.stars >= 4);
  assert.ok(r4.opportunities[0].receipt.rules.includes('Hotel: 4-star or better'));
  assert.ok(hunter.decisionText(r4.opportunities[0], fl).includes(`${r4.best.stars}-star hotel, meets your 4-star minimum.`));
  const nsFloor = H({ budget: 180000, minNights: 4, maxNights: 7, floors: { minStars: null, nonstop: true } });
  assert.equal(hunter.huntQuery(nsFloor, 4).rules.nonstop, true);
  const r5 = run(nsFloor);
  if (r5.best) { assert.equal(r5.best.stops, 0); for (const d of r5.byDest) assert.equal(price(d.token).flight.stops, 0); }
  // A chosen month: every trip, the best beaten by its own cheaper version included, leaves inside it.
  const month = addDays(today(now), 60).slice(0, 7);
  const mh = H({ budget: 180000, minNights: 4, maxNights: 5, dateMode: 'flexible', month });
  const q = hunter.huntQuery(mh, 4);
  assert.equal(q.dateMode, 'flexible'); assert.equal(q.month, month);
  const r6 = run(mh);
  assert.ok(r6.best);
  assert.equal(r6.best.trip.spec.depart.slice(0, 7), month);
  for (const d of r6.byDest) assert.equal(decodeSpec(d.token).depart.slice(0, 7), month);
  assert.ok(r6.checked.negotiated[0].startsWith(`Departures: every day of ${new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}`));
  assert.ok(r6.opportunities[0].receipt.rules.some(l => l.startsWith('Window: in ')));
  // A month with no day left to price says so instead of pretending a search happened.
  const past = run(H({ dateMode: 'flexible', month: '2000-01' }));
  assert.equal(past.best, null);
  assert.equal(past.silent, 'no departure date in January 2000 is left to price');
  assert.equal(past.checked.considered, 0);
});

test('the saved trip: beaten only with nothing given up, folded into the find, never announced twice, never guessed', () => {
  const hunt = H();
  const r1 = run(hunt);
  const best = r1.best.trip;
  // The customer's saved trip: the same package on a dearer date, a real priced token.
  let saved = null;
  for (let i = 14; i <= 150 && !saved; i += 2) {
    const d = addDays(today(now), i);
    const t = priceTrip(inv, { ...best.spec, depart: d }, settings);
    if (t && t.total >= best.total + 5000 && !classifyChanges(t, best).tradeoffs.length) saved = t;
  }
  assert.ok(saved, 'a dearer date for the same trip');
  const sh = H({ savedToken: encodeSpec(saved.spec), notify: ['under', 'beat-saved', 'drop'] });
  const r = run(sh);
  assert.ok(r.saved && r.saved.total === saved.total && r.saved.token === encodeSpec(saved.spec));
  assert.equal(r.opportunities.length, 1, 'the beat is folded into the find, not a second opportunity');
  const o = r.opportunities[0];
  assert.equal(o.kind, 'found');
  assert.ok(o.why.some(w => w.startsWith(`It beats your saved trip (${fmt(saved.total)} now) by ${fmt(saved.total - o.trip.total)} with nothing given up`)));
  checkOpportunity(o, sh, [saved.total, saved.total - o.trip.total, r.challenger && r.challenger.from]);
  // Next run: the trip on record already beats the saved one, so nothing is said again.
  const r2 = run(sh, baselineOf(r));
  assert.deepEqual(r2.opportunities, []);
  assert.equal(r2.silent, `the best trip is unchanged at ${fmt(r.best.total)}`);
  // The record did not beat it (a dearer recorded total): now the best does, and that is said once.
  const r3 = run(sh, { ...baselineOf(r), best: { ...baselineOf(r).best, total: saved.total + 100 } });
  const b = r3.opportunities.find(x => x.kind === 'beat-saved');
  assert.ok(b, `beat-saved fires: ${r3.silent} ${r3.opportunities.map(x => x.kind)}`);
  assert.equal(b.trip.token, r.best.token);
  assert.equal(b.previous.token, encodeSpec(saved.spec)); assert.equal(b.previous.total, saved.total);
  assert.equal(b.delta, b.trip.total - saved.total);
  const text = checkOpportunity(b, sh, [saved.total, saved.total - b.trip.total]);
  assert.ok(text.startsWith(`A ${b.trip.nights}-night ${b.trip.dest} trip beats your saved trip: ${fmt(b.trip.total)} total against ${fmt(saved.total)}, with nothing given up.`));
  // A saved trip cheaper than anything found is not beaten, and nothing says it is.
  const cheap = run(H({ savedToken: encodeSpec(best.spec), notify: ['under', 'beat-saved'] }), null);
  assert.ok(cheap.opportunities.every(x => x.kind !== 'beat-saved' && !x.why.some(w => w.includes('beats your saved trip'))));
  // A token the suppliers cannot price: no saved trip, no claim.
  const bad = run(H({ savedToken: 'not-a-token', notify: ['under', 'beat-saved'] }));
  assert.equal(bad.saved, null);
  assert.ok(bad.opportunities.every(x => x.kind !== 'beat-saved'));
  // Default notify: everything but beat-saved unless a trip is saved.
  const def = run(H({ notify: undefined }));
  assert.equal(def.opportunities[0].kind, 'found');
});

test('ruleLines and huntCard read the record and the trip alone; nothing is inferred', () => {
  const hunt = H({ rules: { flightStops: 'nonstop', flightRule: 'preferred', minStars: 4, refundable: true, meals: 'all-inclusive', bags: 'checked' }, target: 95000, excludeDests: ['cancun'], savingsLevel: 'aggressive', dateMode: 'flexible', month: '2027-06', who: 'family', travelers: 4 });
  assert.deepEqual(hunter.ruleLines(hunt, { maps: inv.maps }), ['Maximum: $1,000', 'Beat: $950 for the same quality', 'Minimum: 3 nights', 'Up to: 6 nights', 'Nonstop: preferred', 'Hotel: 4-star or better', 'Meals: all-inclusive', 'Refundable: required', 'Bags: a checked bag', 'Window: in June 2027', 'Travelers: 4 (a family) from New York', 'Style: beach', 'Left out: Cancun', 'Savings: aggressive (every trade-off said)']);
  assert.deepEqual(hunter.ruleLines(H({ minNights: 5, maxNights: 5 })), ['Maximum: $1,000', 'Minimum: 5 nights', 'Window: anytime', 'Travelers: 2 (a couple) from NYC', 'Style: beach']);
  const q = hunter.huntQuery(hunt, 4);
  assert.deepEqual(q.rules, { nonstop: false, minStars: 4, allInclusive: true, breakfast: false, beachfront: false, transfer: false, refundable: true });
  assert.equal(q.budget, 95000); assert.equal(q.vacationBudget, 95000); assert.equal(q.keep, 0); assert.equal(q.budgetType, 'total'); assert.equal(q.travelers, 4); assert.equal(q.who, 'family');
  assert.equal(q.priority, 'price'); assert.equal(q.allowOver, 0); assert.equal(q.dest, null); assert.equal(q.region, null); assert.equal(q.dests, null); assert.equal(q.notCountry, null); assert.equal(q.depart, null); assert.equal(q.nights, 4);
  // A checked-bag customer: every trip shown is priced with the bag, so the total is what they would pay.
  const bagged = run(H({ budget: 180000, minNights: 4, maxNights: 5, rules: { ...H().rules, bags: 'checked' } }));
  assert.ok(bagged.best);
  assert.equal(bagged.opportunities[0].trip.bags.startsWith('Checked bag included'), true);
  assert.ok(bagged.best.trip.flight.checkedBagIncluded || bagged.best.trip.spec.bags);
  assert.equal(bagged.best.total, price(bagged.best.token).total);
  assert.ok(bagged.checked.negotiated[3].includes('a checked bag added to fares that do not include one'));
  for (const d of bagged.byDest) { const t = price(d.token); assert.ok(t.flight.checkedBagIncluded || t.spec.bags); }
  const carry = run(H({ budget: 180000, minNights: 4, maxNights: 5, rules: { ...H().rules, bags: 'carry-on' } }));
  if (carry.best) { assert.ok(carry.best.trip.flight.carryOn); for (const d of carry.byDest) assert.ok(price(d.token).flight.carryOn); }
  assert.ok(carry.checked.negotiated[3].includes('fares with a personal item only were left out'));
  // The card.
  const t = run(H()).best.trip;
  const card = hunter.huntCard(t);
  assert.equal(card.token, encodeSpec(t.spec));
  assert.deepEqual(Object.keys(card).sort(), ['activities', 'airline', 'bags', 'country', 'demo', 'depart', 'dest', 'destId', 'durationMinutes', 'fareName', 'hotel', 'image', 'nights', 'perTraveler', 'ret', 'stops', 'token', 'total', 'transfer', 'travelers']);
  assert.deepEqual(Object.keys(card.hotel).sort(), ['allInclusive', 'area', 'breakfast', 'name', 'refundable', 'stars']);
  assert.equal(card.total, t.total); assert.equal(card.dest, t.dest.name); assert.equal(card.country, t.dest.country); assert.equal(card.nights, t.spec.nights); assert.equal(card.travelers, t.spec.travelers);
  assert.equal(card.hotel.refundable, !!t.hotel.refundable); assert.equal(card.transfer, !!t.transfer);
  // An origin given as an airport code resolves to its city; an unknown one is refused, not guessed.
  assert.ok(run(H({ origin: 'JFK' })).best);
  assert.throws(() => run(H({ origin: 'XXX' })), /departure city/);
  assert.throws(() => run(H({ budget: 0 })), /budget/);
});

test('a saved trip already inside the limit: a find that does not beat it is no news, and the silence says why', () => {
  const r1 = run(H());
  assert.ok(r1.best);
  // The saved trip is the best itself: nothing found beats it, so nothing is said about trips under the limit.
  const same = run(H({ savedToken: r1.best.token, notify: ['under', 'beat-saved', 'drop'] }));
  assert.equal(same.saved.total, r1.best.total);
  assert.deepEqual(same.opportunities, []);
  assert.match(same.silent, new RegExp(`your saved trip is already ${fmt(r1.best.total).replace(/[$.]/g, '\\$&')} inside your limit, and this does not beat it`));
  // Without a saved trip the same run is the find it always was.
  assert.equal(run(H({ notify: ['under', 'beat-saved', 'drop'] })).opportunities[0].kind, 'found');
});
