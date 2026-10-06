// SAVE MAX: how low a trip can responsibly go. Every number is a priced package; the cheapest version
// found is kept apart from the lowest we would recommend and only ever shown with the facts that
// keep it from being recommended; breakpoints buy something real with nothing given up; fares are
// compared with the bag the traveler needs and unknown fees are never guessed; a receipt never
// counts a saving twice; the pre-payment check only surfaces a material saving without a
// compromise; relabeling never mutates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { DEFAULT_SETTINGS, priceTrip } = require('../server/trips/pricing');
const optimizer = require('../server/trips/optimizer');
const decision = require('../server/trips/decision');
const { usableTime } = require('../server/trips/facts');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { addDays, today } = require('../server/lib/dates');
const { format } = require('../server/lib/money');
const savemax = require('../server/trips/savemax');

const inv = createTripIntegrations(loadConfig({ APP_ENV: 'development' }));
const settings = DEFAULT_SETTINGS;
const now = new Date();
const fmt = cents => format(cents, 'USD');
const QUERY = { budget: 200000, vacationBudget: 200000, keep: 0, budgetInput: 2000, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
const result = optimizer.search(inv, QUERY, { settings, now });
const trip = result.picks[0].trip;
const ctx = result.ctx;
const price = spec => priceTrip(inv, spec, settings);
const nearby = (t, keep) => [-3, -2, -1, 1, 2, 3].map(o => price({ ...t.spec, depart: addDays(t.spec.depart, o) })).filter(p => p && keep(p));
// A packed version carries its own token, and the token is the trip.
function checkPacked(x) {
  assert.equal(x.token, encodeSpec(x.trip.spec));
  assert.equal(encodeSpec(decodeSpec(x.token)), x.token);
  assert.equal(x.total, x.trip.total);
}

// Every "why not" line must be a fact of the cheaper trip: each known wording is checked against the
// field it is read from; a wording this table does not know fails the test.
function factOf(line, cheap, against, c) {
  const f = cheap.flight, h = cheap.hotel, s = cheap.spec;
  let m;
  if ((m = /^(\d+) nights?, (\d+) nights? fewer than you asked for$/.exec(line))) return s.nights === +m[1] && c.nightsAsked - s.nights === +m[2];
  if ((m = /^(\d+) nights? instead of (\d+)$/.exec(line))) return s.nights === +m[1] && against.spec.nights === +m[2] && s.nights < against.spec.nights;
  if ((m = /^(\d+) stops?, (\d+)h (\d+)m each way$/.exec(line))) return f.stops === +m[1] && f.stops > 0 && f.durationMinutes === +m[2] * 60 + +m[3];
  if ((m = /^(\d+)h (\d+)m each way on the (.+) fare$/.exec(line))) return f.durationMinutes === +m[1] * 60 + +m[2] && f.name === m[3];
  if ((m = /^(\d)-star hotel rated ([\d.]+)\/5 \((.+)\)$/.exec(line))) return h.stars === +m[1] && h.rating === +m[2] && h.name === m[3];
  if ((m = /^not beachfront: (.+)$/.exec(line))) return !h.features.beachfront && h.area === m[1];
  if (line === 'breakfast only, not all-inclusive') return h.features.breakfast && !h.features.allInclusive;
  if (line === 'no meals included' || line === 'no breakfast included') return !h.features.breakfast && !h.features.allInclusive;
  if (line === 'personal item only, no carry-on') return !f.carryOn && !f.checkedBagIncluded && !s.bags;
  if (line === 'no checked bag') return !f.checkedBagIncluded && !s.bags;
  if (line === 'non-refundable flights') return !f.refundable;
  if (line === 'non-refundable hotel rate') return !h.refundable;
  if ((m = /^less usable vacation time \((.+); lands (.+?)( the next day)?, flight home (.+?)(, leaving the hotel around (.+))?\)$/.exec(line))) {
    const u = usableTime(cheap);
    return !!u && u.usableLabel === m[1] && u.firstDay.arrive === m[2] && !!m[3] === u.firstDay.nextDay && u.lastDay.depart === m[4] && (!m[6] || u.lastDay.leaveHotel === m[6]);
  }
  if ((m = /^(\d+) experiences? instead of (\d+)$/.exec(line))) return cheap.activities.length === +m[1] && against.activities.length === +m[2];
  if (line === 'no experiences included') return cheap.activities.length === 0;
  if (line === 'no airport transfer') return !cheap.transfer;
  const qctx = { ...c, budget: null, allowOver: 0 };
  if (decision.compromises(cheap, qctx).some(x => x.text === line)) return true;
  return decision.tripDiff(against, cheap).some(r => r.changed && `${r.label}: ${r.b}` === line);
}

test('howLow: the lowest version we would still recommend, apart from the cheapest found and the facts that keep it from being recommended', () => {
  const low = savemax.howLow(inv, trip, settings, ctx, { now, locks: {} });
  checkPacked(low.recommend);
  assert.ok(low.recommend.total <= trip.total);
  assert.equal(low.recommend.trip.dest.id, trip.dest.id);
  assert.ok(Array.isArray(low.recommend.changes.tradeoffs) && Array.isArray(low.recommend.changes.neutral));
  if (low.recommend.total === trip.total) assert.equal(low.recommend.token, encodeSpec(trip.spec), 'nothing cheaper to recommend: the trip itself');
  else assert.notEqual(low.recommend.token, encodeSpec(trip.spec));
  const nyp = decision.nameYourPrice(inv, trip, settings, ctx, trip.total - 1, { now, locks: {} });
  if (low.cheapest) {
    checkPacked(low.cheapest);
    assert.ok(low.cheapest.total < low.recommend.total, 'cheapest is cheaper than what we recommend');
    assert.notEqual(low.cheapest.token, low.recommend.token);
    assert.equal(low.cheapest.token, encodeSpec(nyp.cheapest.trip.spec), 'the absolute cheapest nameYourPrice found, nothing else');
    assert.ok(low.cheapest.whyNot.length >= 1, 'why not is named');
    for (const line of low.cheapest.whyNot) assert.ok(factOf(line, low.cheapest.trip, low.recommend.trip, ctx), `a fact of the cheapest trip: ${line}`);
    assert.equal(new Set(low.cheapest.whyNot).size, low.cheapest.whyNot.length);
  } else {
    assert.ok(!nyp.cheapest || nyp.cheapest.total >= low.recommend.total, 'cheapest is null only when nothing cheaper than the recommendation exists');
  }
  // Locks hold: nothing moves what the traveler locked.
  const held = savemax.howLow(inv, trip, settings, ctx, { now, locks: { hotel: true, flight: true, dates: true, nights: true } });
  for (const c of [held.recommend, held.cheapest].filter(Boolean)) {
    assert.equal(c.trip.spec.hotel, trip.spec.hotel); assert.equal(c.trip.spec.flight, trip.spec.flight);
    assert.equal(c.trip.spec.depart, trip.spec.depart); assert.equal(c.trip.spec.nights, trip.spec.nights);
  }
  // Rules are never relaxed: with a 4-star rule, only the hotel the traveler already has or a 4-star one.
  const rules = { nonstop: false, minStars: 4, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false };
  const ruled = savemax.howLow(inv, trip, settings, { ...ctx, rules }, { now });
  for (const c of [ruled.recommend, ruled.cheapest].filter(Boolean)) assert.ok(c.trip.spec.hotel === trip.spec.hotel || c.trip.hotel.stars >= 4, 'rules kept');
});

test('priceBreakpoints: where money starts buying something, each a real version that improves with nothing given up, at or under the cap', () => {
  const cap = ctx.budget;
  const bps = savemax.priceBreakpoints(inv, trip, settings, ctx, { now, cap });
  assert.ok(bps.length >= 1 && bps.length <= 5, `${bps.length} breakpoints`);
  const backed = {
    'Nonstop flight': b => b.flight.stops === 0 && trip.flight.stops > 0,
    'Extra night': b => b.spec.nights === trip.spec.nights + 1,
    '2 extra nights': b => b.spec.nights === trip.spec.nights + 2,
    'Included transfer': b => !!b.transfer && !trip.transfer,
    'Checked bags': b => (b.flight.checkedBagIncluded || b.spec.bags) && !(trip.flight.checkedBagIncluded || trip.spec.bags),
    'Better hotel class': b => b.hotel.stars > trip.hotel.stars,
    'Higher-rated hotel': b => b.hotel.stars === trip.hotel.stars && b.hotel.rating > trip.hotel.rating,
    Beachfront: b => b.hotel.features.beachfront && !trip.hotel.features.beachfront,
    'All-inclusive': b => b.hotel.features.allInclusive && !trip.hotel.features.allInclusive,
    'Breakfast included': b => b.hotel.features.breakfast && !trip.hotel.features.breakfast,
    'Refundable flights': b => b.flight.refundable && !trip.flight.refundable,
    'Free hotel cancellation': b => b.hotel.refundable && !trip.hotel.refundable,
    'Shorter flights': b => b.flight.stops <= trip.flight.stops && b.flight.durationMinutes < trip.flight.durationMinutes,
    'Carry-on bag': b => b.flight.carryOn && !trip.flight.carryOn,
    'More usable vacation time': b => usableTime(b).usableMinutes > usableTime(trip).usableMinutes + 59,
    'An extra experience': b => b.activities.length === trip.activities.length + 1,
    'More experiences': b => b.activities.length > trip.activities.length + 1,
  };
  const seen = new Set();
  bps.forEach((b, i) => {
    checkPacked(b);
    if (i) assert.ok(b.delta >= bps[i - 1].delta, 'ascending by delta');
    assert.equal(b.delta, b.total - trip.total);
    assert.ok(b.delta > 0 && b.total <= cap, `${b.gets}: above the trip, at or under the cap`);
    assert.equal(b.trip.dest.id, trip.dest.id, 'same destination');
    const ch = decision.classifyChanges(trip, b.trip);
    assert.ok(ch.improvements.length >= 1, `${b.gets} improves something`);
    assert.equal(ch.tradeoffs.length, 0, `${b.gets} gives nothing up`);
    assert.ok(!seen.has(b.gets), `one breakpoint per kind: ${b.gets}`); seen.add(b.gets);
    if (b.trip.spec.depart !== trip.spec.depart) assert.match(b.gets, / \(leaving \d{4}-\d{2}-\d{2} instead of \d{4}-\d{2}-\d{2}\)$/, 'a date move is stated');
    else assert.doesNotMatch(b.gets, /leaving/);
    const kind = b.gets.replace(/ \(leaving .*\)$/, '');
    assert.ok(backed[kind], `a known kind: ${kind}`);
    assert.ok(backed[kind](b.trip), `${b.gets} is backed by the trip's facts`);
    for (const a of b.also) assert.ok(backed[a] && backed[a](b.trip), `also "${a}" is backed by the trip's facts`);
  });
  // The cap is a ceiling: nothing above it, nothing at all when the trip already sits on it, and
  // the budget is the cap when none is given.
  assert.deepEqual(savemax.priceBreakpoints(inv, trip, settings, ctx, { now, cap: trip.total }), []);
  for (const b of savemax.priceBreakpoints(inv, trip, settings, ctx, { now, cap: trip.total + 10000 })) assert.ok(b.total <= trip.total + 10000);
  for (const b of savemax.priceBreakpoints(inv, trip, settings, { ...ctx, budget: trip.total + 10000 }, { now })) assert.ok(b.total <= trip.total + 10000);
  // Locks hold: with the dates and length locked nothing moves them.
  for (const b of savemax.priceBreakpoints(inv, trip, settings, ctx, { now, cap, locks: { dates: true, nights: true } })) { assert.equal(b.trip.spec.depart, trip.spec.depart); assert.equal(b.trip.spec.nights, trip.spec.nights); }
});

// The demo inventory prices checked bags on every fare (bagFeePerTraveler, checkedBagIncluded) and
// says whether a carry-on is included; it has no carry-on fee. On some long-haul dates the cheapest
// fare costs more once the checked bag is added, because the dearer fares include it.
function findBagTrap() {
  const t = today(now);
  for (const dest of ['barcelona', 'rome', 'honolulu', 'new-alamein', 'tokyo']) {
    for (let i = 14; i <= 150; i++) {
      const depart = addDays(t, i);
      const hotel = inv.hotels.search({ destId: dest, checkIn: depart, nights: 5, rooms: 1 })[0];
      const basic = price({ dest, from: 'JFK', depart, nights: 5, travelers: 2, who: 'couple', hotel: hotel.id, flight: 'basic', activities: [], bags: false, transfer: false });
      const saver = basic && price({ ...basic.spec, flight: 'saver' });
      if (!basic || !saver) continue;
      const st = f => (f.farePerTraveler + f.taxesPerTraveler) * 2;
      const rel = f => st(f) + (f.checkedBagIncluded ? 0 : f.bagFeePerTraveler * 2);
      if (st(basic.flight) < st(saver.flight) && rel(basic.flight) > rel(saver.flight)) return { basic, saver };
    }
  }
  return null;
}

test('cheapTrap: fares compared with the bag the traveler needs, from the fare\'s own fee fields; unknown fees are never guessed', () => {
  const pair = findBagTrap();
  assert.ok(pair, 'the demo inventory has a long-haul date where the cheapest fare costs more with the checked bag');
  const { basic, saver } = pair;
  const st = f => (f.farePerTraveler + f.taxesPerTraveler) * 2;
  const rel = f => st(f) + (f.checkedBagIncluded ? 0 : f.bagFeePerTraveler * 2);
  // The dearer fare is cheaper overall for a checked bag, and the text carries the real totals.
  const over = savemax.cheapTrap(saver, [basic], { bags: 'checked' });
  assert.equal(over.badge, 'cheaper-overall');
  assert.equal(over.mine.relevant, rel(saver.flight)); assert.equal(over.against.relevant, rel(basic.flight));
  assert.equal(over.text, `The ${fmt(st(saver.flight))} fare is ${fmt(rel(basic.flight) - rel(saver.flight))} cheaper for the way you're traveling (a checked bag, 2 travelers): the ${fmt(st(basic.flight))} fare comes to ${fmt(rel(basic.flight))} once a checked bag is added.`);
  // Seen from the cheap fare, it only looks cheaper.
  const looks = savemax.cheapTrap(basic, [saver], { bags: 'checked' });
  assert.equal(looks.badge, 'looks-cheaper');
  assert.ok(looks.text.includes(`with a checked bag it comes to ${fmt(rel(basic.flight))}`) && looks.text.includes(`The ${fmt(st(saver.flight))} fare is ${fmt(rel(basic.flight) - rel(saver.flight))} cheaper for the way you're traveling`));
  // Travelling with a personal item only, the cheap fare really is cheaper: no trap, said plainly.
  const personal = savemax.cheapTrap(saver, [basic], { bags: 'personal' });
  assert.equal(personal.badge, null);
  assert.ok(personal.text.startsWith('No bag trap here') && personal.text.includes(`${fmt(st(basic.flight))} fare is ${fmt(st(saver.flight) - st(basic.flight))} cheaper`));
  // A carry-on on a personal-item fare: the inventory has no carry-on fee, so nothing is guessed.
  assert.ok(!basic.flight.carryOn && basic.flight.carryOnFeePerTraveler === undefined);
  assert.deepEqual(savemax.cheapTrap(saver, [basic], { bags: 'carry-on' }), { badge: null, text: 'bag fees need verification' });
  // A real adapter that returns no bag fee at all: the same answer, never a number.
  const noFee = { ...basic, flight: { ...basic.flight, bagFeePerTraveler: undefined } };
  assert.deepEqual(savemax.cheapTrap(saver, [noFee], { bags: 'checked' }), { badge: null, text: 'bag fees need verification' });
  assert.deepEqual(savemax.cheapTrap(noFee, [saver], { bags: 'checked' }), { badge: null, text: 'bag fees need verification' });
  // Nothing to compare against, or no bag need stated: no badge, no claim.
  assert.equal(savemax.cheapTrap(saver, [saver], { bags: 'checked' }).badge, null);
  assert.equal(savemax.cheapTrap(saver, [basic], {}).badge, null);
  // The search's own pick against its alternatives, with the bag it was priced for.
  const picks = result.picks.map(p => p.trip);
  const own = savemax.cheapTrap(trip, picks, { bags: trip.spec.bags ? 'checked' : trip.flight.carryOn ? 'carry-on' : 'personal' });
  assert.ok(['cheaper-overall', 'looks-cheaper', null].includes(own.badge) && typeof own.text === 'string' && own.text.length);
});

test('savingsReceipt: sequential deltas that sum exactly, lines named by what changed, you keep = max minus final', () => {
  const withTransfer = price({ ...trip.spec, transfer: true });
  const moved = price({ ...withTransfer.spec, depart: addDays(trip.spec.depart, 2) });
  const other = trip.hotelOptions.find(h => h.id !== trip.spec.hotel);
  const swapped = price({ ...trip.spec, hotel: other.id });
  const shorter = price({ ...swapped.spec, nights: trip.spec.nights - 1 });
  assert.ok(withTransfer && moved && swapped && shorter);
  const versions = [{ label: 'Original qualifying candidate', trip: moved }, { label: 'Date change', trip: withTransfer }, { label: 'Without the transfer', trip }, { label: 'Hotel swap', trip: swapped }, { label: 'One night fewer', trip: shorter }];
  const max = ctx.budget;
  const r = savemax.savingsReceipt(versions, max);
  assert.deepEqual(r.lines.map(l => l.label), ['Date change', 'Removed transfer', 'Hotel swap', '1 night fewer']);
  assert.equal(r.lines.reduce((s, l) => s + l.delta, 0), r.final - r.original, 'deltas sum exactly to final minus original');
  assert.equal(r.original, moved.total); assert.equal(r.final, shorter.total); assert.equal(r.max, max); assert.equal(r.keep, max - shorter.total);
  r.lines.forEach((l, i) => {
    assert.equal(l.from, versions[i].trip.total); assert.equal(l.to, versions[i + 1].trip.total); assert.equal(l.delta, l.to - l.from);
    assert.equal(l.fromLabel, versions[i].label); assert.equal(l.toLabel, versions[i + 1].label);
    if (i) assert.equal(l.from, r.lines[i - 1].to, 'no overlap between lines');
  });
  // The same package priced again is a price refresh, not a change; no maximum means no "you keep".
  const again = savemax.savingsReceipt([{ label: 'a', trip }, { label: 'b', trip: { ...trip, total: trip.total - 100 } }]);
  assert.equal(again.lines[0].label, 'Price refresh, same trip'); assert.equal(again.lines[0].delta, -100); assert.equal(again.keep, null);
  assert.equal(savemax.savingsReceipt([{ label: 'a', trip }, { label: 'b', trip }]).lines[0].label, 'No change');
  assert.deepEqual(savemax.savingsReceipt([], max), { lines: [], original: null, final: null, max, keep: null });
});

test('savingsCheck: before paying, a materially cheaper version with nothing given up is shown; otherwise the check is complete', () => {
  // Walk down from the search's pick: every step is at least $25 cheaper with no trade-off, and
  // the walk ends on a trip where the check is complete.
  let cur = trip, steps = 0, r;
  for (;;) {
    r = savemax.savingsCheck(inv, cur, settings, ctx, { now, locks: {} });
    assert.equal(r.total, cur.total, 'priced again before comparing');
    assert.equal(r.repriced, 0);
    if (r.ok) break;
    assert.ok(steps++ < 6, 'the walk ends');
    checkPacked(r.cheaper);
    assert.ok(r.cheaper.total <= cur.total - 2500, 'material');
    assert.equal(r.cheaper.delta, r.cheaper.total - cur.total);
    assert.equal(decision.classifyChanges(cur, r.cheaper.trip).tradeoffs.length, 0, 'no compromise');
    assert.match(r.text, /^A version of this trip is \$[\d,.]+ cheaper \(.*\) without a compromise: /);
    cur = r.cheaper.trip;
  }
  assert.equal(r.text, 'Savings check complete: nothing cheaper without a compromise');
  assert.equal(r.cheaper, undefined);
  const floor = cur;
  // The same trip on a dearer nearby date: the check finds the way back down, since a date move
  // gives nothing up; with the dates locked the date move is off the table and nothing is relaxed
  // to reach it; a saving under the material threshold never counts.
  const dearer = nearby(floor, p => p.total >= floor.total + 2500).sort((a, b) => b.total - a.total)[0];
  assert.ok(dearer, 'the demo prices nearby dates more than $25 apart');
  const r2 = savemax.savingsCheck(inv, dearer, settings, ctx, { now, locks: {} });
  assert.equal(r2.ok, false);
  checkPacked(r2.cheaper);
  assert.ok(r2.cheaper.total <= floor.total, 'at least as cheap as the floor');
  assert.equal(decision.classifyChanges(dearer, r2.cheaper.trip).tradeoffs.length, 0);
  assert.ok(r2.text.includes(fmt(dearer.total - r2.cheaper.total)) && r2.text.includes('Dates: '));
  const r3 = savemax.savingsCheck(inv, dearer, settings, ctx, { now, locks: { dates: true } });
  if (!r3.ok) assert.equal(r3.cheaper.trip.spec.depart, dearer.spec.depart);
  assert.equal(savemax.savingsCheck(inv, dearer, settings, ctx, { now, material: dearer.total }).ok, true);
  // A trip that can no longer be priced is never waved through.
  const r5 = savemax.savingsCheck(inv, { ...trip, spec: { ...trip.spec, hotel: 'nope' } }, settings, ctx, { now });
  assert.equal(r5.ok, false); assert.equal(r5.cheaper, null); assert.match(r5.text, /needs verification/);
});

test('saverVerdict: cut when a version we would still recommend costs less; otherwise stop and say what the cheapest would mean', () => {
  // Walk down until there is nothing cheaper we would recommend.
  let cur = trip, steps = 0, v;
  for (;;) {
    v = savemax.saverVerdict(inv, cur, settings, ctx, { now });
    if (!v.canCut) break;
    assert.ok(steps++ < 6, 'the walk ends');
    checkPacked(v.alternative);
    assert.ok(v.alternative.total < cur.total);
    assert.equal(v.alternative.delta, v.alternative.total - cur.total);
    assert.match(v.text, /^I found a way to keep another \$[\d,.]+: /);
    assert.ok(v.text.includes(fmt(cur.total - v.alternative.total)) && v.text.includes(fmt(v.alternative.total)));
    cur = v.alternative.trip;
  }
  assert.equal(v.alternative, null);
  if (v.cheapest) {
    assert.ok(v.text.startsWith('I\'d stop cutting here. The next cheaper options require compromises I don\'t think justify the savings based on your rules.'));
    assert.ok(v.cheapest.total < cur.total && v.text.includes(fmt(v.cheapest.total)));
    for (const line of v.cheapest.whyNot) assert.ok(v.text.includes(line), `names the compromise: ${line}`);
  } else {
    assert.match(v.text, /^I'd stop cutting here: \$[\d,.]+ is the lowest price found for this trip/);
  }
  // The floor on a dearer nearby date can be cut: the date move back is a version we recommend.
  const dearer = nearby(cur, p => p.total > cur.total).sort((a, b) => b.total - a.total)[0];
  assert.ok(dearer, 'the demo has a dearer nearby date');
  const cut = savemax.saverVerdict(inv, dearer, settings, ctx, { now });
  assert.equal(cut.canCut, true);
  checkPacked(cut.alternative);
  assert.ok(cut.alternative.total <= cur.total);
  assert.equal(decision.classifyChanges(dearer, cut.alternative.trip).tradeoffs.length, 0);
  assert.ok(cut.text.startsWith(`I found a way to keep another ${fmt(dearer.total - cut.alternative.total)}: ${fmt(cut.alternative.total)} instead of ${fmt(dearer.total)}`) && cut.text.endsWith('Nothing given up.'));
});

test('labelsFor: saver-mode names on a new array, nothing mutated, never Best, Premium or Luxury', () => {
  const before = JSON.stringify(result.picks.map(p => ({ kind: p.kind, label: p.label, blurb: p.blurb })));
  const out = savemax.labelsFor(result.picks);
  assert.notEqual(out, result.picks);
  assert.equal(out.length, result.picks.length);
  const names = { 'our-pick': 'Best value', 'save-more': 'Lowest I recommend', upgrade: 'Keep more comfort' };
  out.forEach((o, i) => {
    assert.notEqual(o, result.picks[i], 'a copy');
    assert.equal(o.trip, result.picks[i].trip, 'the same priced trip');
    assert.equal(o.label, names[result.picks[i].kind]);
    assert.doesNotMatch(o.label, /^Best$|premium|luxury/i);
  });
  assert.equal(JSON.stringify(result.picks.map(p => ({ kind: p.kind, label: p.label, blurb: p.blurb }))), before, 'input untouched');
  const odd = [{ kind: 'closest', label: 'Closest we found' }];
  assert.deepEqual(savemax.labelsFor(odd), odd);
  assert.notEqual(savemax.labelsFor(odd)[0], odd[0]);
  assert.deepEqual(savemax.labelsFor(), []);
});
