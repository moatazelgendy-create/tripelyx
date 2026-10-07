// SAVE MAX: how low a trip can responsibly go. Every number is a priced package; the cheapest version
// found is kept apart from the lowest we would recommend and only ever shown with the facts that
// keep it from being recommended; breakpoints buy something real with nothing given up; fares are
// compared with the bag the traveler needs, inside the traveler's rules, named by fare and with their
// differences said, and unknown fees are never guessed; a receipt never counts a saving twice and
// never says "you keep" a negative; the pre-payment check only surfaces a material saving without a
// compromise (by the facts and by decision.compromises), keeps the traveler's own experiences and an
// exact date, and says when a pass was cut off; relabeling never mutates and "Lowest I recommend" is
// only ever a trip we would recommend.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { DEFAULT_SETTINGS, priceTrip } = require('../server/trips/pricing');
const optimizer = require('../server/trips/optimizer');
const decision = require('../server/trips/decision');
const { usableTime, direction, hasChecked } = require('../server/trips/facts');
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
const qctx = { ...ctx, budget: null, allowOver: 0 };
const price = spec => priceTrip(inv, spec, settings);
const nearby = (t, keep) => [-3, -2, -1, 1, 2, 3].map(o => price({ ...t.spec, depart: addDays(t.spec.depart, o) })).filter(p => p && keep(p));
const sortedIds = ids => [...ids].sort();
// Compromises of weight 2 or more a version carries that the trip it is proposed for does not.
const newHeavy = (base, p) => { const had = new Set(decision.compromises(base, qctx).map(c => c.text)); return decision.compromises(p, qctx).filter(c => c.w >= 2 && !had.has(c.text)).map(c => c.text); };
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
  if ((m = /^(\d)-star hotel rated ([\d.]+)\/5 \((.+); (.+)\)$/.exec(line))) return h.stars === +m[1] && h.rating === +m[2] && h.name === m[3] && h.ratingSource === m[4];
  if ((m = /^not beachfront: (.+)$/.exec(line))) return !h.features.beachfront && h.area === m[1];
  if (line === 'breakfast only, not all-inclusive') return h.features.breakfast && !h.features.allInclusive;
  if (line === 'no meals included' || line === 'no breakfast included') return !h.features.breakfast && !h.features.allInclusive;
  if (line === 'personal item only, no carry-on') return !f.carryOn && !f.checkedBagIncluded && !s.bags;
  if (line === 'checked bag but no carry-on') return !f.carryOn && (f.checkedBagIncluded || s.bags);
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
  // The one line said when nothing displayed differs: only ever true when nothing displayed differs.
  if (line === savemax.IDENTICAL) return decision.tripDiff(against, cheap).every(r => !r.changed || ['total', 'perTraveler', 'perNight'].includes(r.key));
  if (decision.compromises(cheap, qctx).some(x => x.text === line)) return true;
  return decision.tripDiff(against, cheap).some(r => r.changed && `${r.label}: ${r.b}` === line);
}

test('howLow: the lowest version we would still recommend, apart from the cheapest found and the facts that keep it from being recommended', () => {
  const low = savemax.howLow(inv, trip, settings, ctx, { now, locks: {} });
  checkPacked(low.recommend);
  assert.ok(low.recommend.total <= trip.total);
  assert.equal(low.recommend.trip.dest.id, trip.dest.id);
  assert.ok(Array.isArray(low.recommend.changes.tradeoffs) && Array.isArray(low.recommend.changes.neutral));
  assert.equal(typeof low.truncated, 'boolean');
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
  // An exactly stated date holds the same way, with no lock passed at all.
  const exact = savemax.howLow(inv, trip, settings, { ...ctx, dateMode: 'exact', depart: trip.spec.depart }, { now, locks: {} });
  for (const c of [exact.recommend, exact.cheapest].filter(Boolean)) { assert.equal(c.trip.spec.depart, trip.spec.depart); assert.equal(c.trip.spec.nights, trip.spec.nights); }
  // Rules are never relaxed: with a 4-star rule, only the hotel the traveler already has or a 4-star one.
  const rules = { nonstop: false, minStars: 4, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false };
  const ruled = savemax.howLow(inv, trip, settings, { ...ctx, rules }, { now });
  for (const c of [ruled.recommend, ruled.cheapest].filter(Boolean)) assert.ok(c.trip.spec.hotel === trip.spec.hotel || c.trip.hotel.stars >= 4, 'rules kept');
});

test('whyNot: never empty; a twin whose displayed facts match the recommended version gets the one line that says so', () => {
  const twin = { ...trip, spec: { ...trip.spec, flight: `${trip.spec.flight}-twin` }, flight: { ...trip.flight, id: `${trip.spec.flight}-twin` }, total: trip.total - 3000 };
  assert.equal(decision.classifyChanges(trip, twin).neutral.length, 0, 'nothing displayed differs');
  assert.deepEqual(savemax.whyNot(twin, trip, ctx), [savemax.IDENTICAL]);
  assert.match(savemax.IDENTICAL, /needs verification/);
  // The same experiences in another order are the same experiences: never a line about them.
  assert.ok(trip.activityOptions.length >= 2, 'the demo offers experiences here');
  const ids = trip.activityOptions.slice(0, 2).map(a => a.id);
  const a = price({ ...trip.spec, activities: sortedIds(ids) }), b = price({ ...trip.spec, activities: sortedIds(ids).reverse() });
  assert.ok(a && b);
  assert.equal(decision.tripDiff(a, b).find(r => r.key === 'experiences').changed, false);
  assert.ok(!decision.classifyChanges(a, b).neutral.some(r => r.key === 'experiences'));
  assert.ok(!savemax.whyNot({ ...b, total: b.total - 3000 }, a, ctx).some(l => l.startsWith('Experiences:')));
  assert.equal(decision.tripDiff(a, b).find(r => r.key === 'experiences').b, [...b.activities.map(x => x.name)].sort().join(', '), 'shown sorted by name');
});

test('bags: a finer, monotone rank (personal item < carry-on < checked without carry-on < checked with carry-on) and wording that tells them apart', () => {
  const basic = trip.flightOptions.find(f => !f.carryOn && !f.checkedBagIncluded), main = trip.flightOptions.find(f => f.carryOn && !f.checkedBagIncluded);
  assert.ok(basic && main, 'the demo has a personal-item fare and a carry-on fare on this route');
  const ladder = [
    [price({ ...trip.spec, flight: basic.id, bags: false }), 'Personal item only'],
    [price({ ...trip.spec, flight: main.id, bags: false }), 'Carry-on only'],
    [price({ ...trip.spec, flight: basic.id, bags: true }), 'Checked bag included (no carry-on)'],
    [price({ ...trip.spec, flight: main.id, bags: true }), 'Checked bag included'],
  ];
  for (const [t, text] of ladder) { assert.ok(t); assert.equal(decision.tripDiff(trip, t).find(r => r.key === 'bags').b, text); }
  for (let i = 1; i < ladder.length; i++) {
    assert.equal(direction('bags', ladder[i - 1][0], ladder[i][0]), 1, `${ladder[i - 1][1]} -> ${ladder[i][1]} is a step up`);
    assert.equal(direction('bags', ladder[i][0], ladder[i - 1][0]), -1, `${ladder[i][1]} -> ${ladder[i - 1][1]} is a step down`);
  }
  // The defect: with a bought bag on both, a carry-on fare to a personal-item fare is a step down, and the why-not line says what is lost.
  const down = decision.classifyChanges(ladder[3][0], ladder[2][0]);
  assert.ok(down.tradeoffs.some(r => r.key === 'bags'));
  assert.ok(savemax.whyNot({ ...ladder[2][0], total: ladder[2][0].total - 3000 }, ladder[3][0], ctx).includes('checked bag but no carry-on'));
  assert.equal(hasChecked(ladder[2][0]), true); assert.equal(hasChecked(ladder[1][0]), false);
});

test('priceBreakpoints: where money starts buying something, each a real version that improves with nothing given up, at or under the cap', () => {
  const cap = ctx.budget;
  const bps = savemax.priceBreakpoints(inv, trip, settings, ctx, { now, cap });
  assert.ok(bps.length >= 1 && bps.length <= 5, `${bps.length} breakpoints`);
  assert.equal(bps.truncated, false, 'the pass was not cut off, and says so');
  const backed = {
    'Nonstop flight': b => b.flight.stops === 0 && trip.flight.stops > 0,
    'Fewer stops': b => b.flight.stops > 0 && b.flight.stops < trip.flight.stops,
    'Shorter flights': b => b.flight.stops === trip.flight.stops && b.flight.durationMinutes <= trip.flight.durationMinutes - 60,
    'Better flight': b => decision.classifyChanges(trip, b).improvements.some(r => r.key === 'flight'),
    'Extra night': b => b.spec.nights === trip.spec.nights + 1,
    '2 extra nights': b => b.spec.nights === trip.spec.nights + 2,
    'Included transfer': b => !!b.transfer && !trip.transfer,
    'Checked bags': b => hasChecked(b) && !hasChecked(trip),
    'Better hotel class': b => b.hotel.stars > trip.hotel.stars,
    'Higher-rated hotel': b => b.hotel.stars === trip.hotel.stars && b.hotel.rating > trip.hotel.rating,
    Beachfront: b => b.hotel.features.beachfront && !trip.hotel.features.beachfront,
    'All-inclusive': b => b.hotel.features.allInclusive && !trip.hotel.features.allInclusive,
    'Breakfast included': b => b.hotel.features.breakfast && !trip.hotel.features.breakfast,
    'Refundable flights': b => b.flight.refundable && !trip.flight.refundable,
    'Free hotel cancellation': b => b.hotel.refundable && !trip.hotel.refundable,
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
    assert.deepEqual(newHeavy(trip, b.trip), [], `${b.gets} brings no new compromise of weight 2 or more`);
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
  const none = savemax.priceBreakpoints(inv, trip, settings, ctx, { now, cap: trip.total });
  assert.equal(none.length, 0); assert.equal(none.truncated, false);
  for (const b of savemax.priceBreakpoints(inv, trip, settings, ctx, { now, cap: trip.total + 10000 })) assert.ok(b.total <= trip.total + 10000);
  for (const b of savemax.priceBreakpoints(inv, trip, settings, { ...ctx, budget: trip.total + 10000 }, { now })) assert.ok(b.total <= trip.total + 10000);
  // Locks hold: with the dates and length locked nothing moves them; an exact date holds them alike.
  for (const b of savemax.priceBreakpoints(inv, trip, settings, ctx, { now, cap, locks: { dates: true, nights: true } })) { assert.equal(b.trip.spec.depart, trip.spec.depart); assert.equal(b.trip.spec.nights, trip.spec.nights); }
  for (const b of savemax.priceBreakpoints(inv, trip, settings, { ...ctx, dateMode: 'exact' }, { now, cap })) { assert.equal(b.trip.spec.depart, trip.spec.depart); assert.equal(b.trip.spec.nights, trip.spec.nights); }
});

test('getsLabel: a flight is labelled by what changed, never "shorter" for fewer stops that fly longer', () => {
  const fl = (stops, durationMinutes) => ({ flight: { stops, durationMinutes } });
  assert.equal(savemax.getsLabel('flight', fl(1, 300), fl(0, 400)), 'Nonstop flight');
  assert.equal(savemax.getsLabel('flight', fl(2, 300), fl(1, 400)), 'Fewer stops');
  assert.equal(savemax.getsLabel('flight', fl(1, 400), fl(1, 340)), 'Shorter flights');
  assert.equal(savemax.getsLabel('flight', fl(1, 400), fl(1, 350)), 'Better flight');
  assert.equal(savemax.getsLabel('flight', fl(0, 400), fl(0, 300)), 'Shorter flights');
  const bg = (carryOn, checked, bags) => ({ flight: { carryOn, checkedBagIncluded: checked }, spec: { bags } });
  assert.equal(savemax.getsLabel('bags', bg(true, false, false), bg(false, false, true)), 'Checked bags');
  assert.equal(savemax.getsLabel('bags', bg(false, false, true), bg(true, false, true)), 'Carry-on bag');
  assert.equal(savemax.getsLabel('bags', bg(false, false, false), bg(true, false, false)), 'Carry-on bag');
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
// How a fare is named: by fare name and price, with every way it differs from the trip's own fare.
const st = f => (f.farePerTraveler + f.taxesPerTraveler) * 2;
const hm = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
function named(mine, other) {
  const d = [];
  if (other.stops !== mine.stops) d.push(other.stops ? `${other.stops} stop${other.stops === 1 ? '' : 's'}` : 'nonstop');
  if (Math.abs(other.durationMinutes - mine.durationMinutes) >= 60) d.push(`${hm(other.durationMinutes)} each way`);
  if (!!other.carryOn !== !!mine.carryOn) d.push(other.carryOn ? 'carry-on included' : 'personal item only');
  if (!!other.refundable !== !!mine.refundable) d.push(other.refundable ? 'refundable' : 'non-refundable');
  return `the ${fmt(st(other))} ${other.name} fare${d.length ? ` (${d.join(', ')})` : ''}`;
}

test('cheapTrap: fares compared with the bag the traveler needs, from the fare\'s own fee fields; unknown fees are never guessed', () => {
  const pair = findBagTrap();
  assert.ok(pair, 'the demo inventory has a long-haul date where the cheapest fare costs more with the checked bag');
  const { basic, saver } = pair;
  const rel = f => st(f) + (f.checkedBagIncluded ? 0 : f.bagFeePerTraveler * 2);
  // The dearer fare is cheaper overall for a checked bag, and the text carries the real totals, each fare named with its differences.
  const over = savemax.cheapTrap(saver, [basic], { bags: 'checked' });
  assert.equal(over.badge, 'cheaper-overall');
  assert.equal(over.mine.relevant, rel(saver.flight)); assert.equal(over.against.relevant, rel(basic.flight));
  assert.equal(over.text, `The ${fmt(st(saver.flight))} ${saver.flight.name} fare is ${fmt(rel(basic.flight) - rel(saver.flight))} cheaper for the way you're traveling (a checked bag, 2 travelers): ${named(saver.flight, basic.flight)} comes to ${fmt(rel(basic.flight))} once a checked bag is added.`);
  assert.ok(!basic.flight.carryOn && saver.flight.carryOn && over.text.includes('(personal item only'), 'the cheaper-looking fare\'s missing carry-on is said');
  // Seen from the cheap fare, it only looks cheaper.
  const looks = savemax.cheapTrap(basic, [saver], { bags: 'checked' });
  assert.equal(looks.badge, 'looks-cheaper');
  assert.equal(looks.text, `The ${fmt(st(basic.flight))} ${basic.flight.name} fare looks cheaper, but with a checked bag it comes to ${fmt(rel(basic.flight))}. The ${named(basic.flight, saver.flight).slice(4)} is ${fmt(rel(basic.flight) - rel(saver.flight))} cheaper for the way you're traveling (a checked bag, 2 travelers).`);
  // Travelling with a personal item only, the cheap fare really is cheaper: no trap, said plainly, the fare named.
  const personal = savemax.cheapTrap(saver, [basic], { bags: 'personal' });
  assert.equal(personal.badge, null);
  assert.equal(personal.text, `No bag trap here: ${named(saver.flight, basic.flight)} is ${fmt(st(saver.flight) - st(basic.flight))} cheaper for the way you're traveling (a personal item, 2 travelers).`);
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

test('cheapTrap: rules and locks are kept, every fare is named by name with its differences, and a tie on the sticker is not a tie with the bag', () => {
  const fares = trip.flightOptions;
  const basic = fares.find(f => f.id === 'basic'), nonstop = fares.find(f => f.stops === 0);
  assert.ok(basic && nonstop && trip.flight.stops > 0 && basic.stops > 0, 'the pick flies with a stop and a nonstop fare exists');
  // A nonstop-only rule: the one-stop fares are never held up as cheaper, by name or by price.
  const ruled = savemax.cheapTrap(trip, fares, { bags: 'checked', rules: { nonstop: true, minStars: null, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false } });
  assert.ok(!ruled.text.includes(basic.name) && !ruled.text.includes(fmt(st(basic))), ruled.text);
  assert.ok(ruled.text.includes(`the ${fmt(st(trip.flight))} ${trip.flight.name} fare`), 'the trip\'s own fare is named');
  assert.equal(savemax.cheapTrap(trip, [basic], { bags: 'checked', rules: { nonstop: true } }).text, 'No other fare inside your rules to compare against.');
  // Locked flights: nothing compared, no badge.
  assert.deepEqual(savemax.cheapTrap(trip, fares, { bags: 'checked', locks: { flight: true } }), { badge: null, text: 'Flights are locked, so no other fare is compared.' });
  // Without rules the cheaper fare is named with what differs: its stops, its missing carry-on, its refundability.
  const open = savemax.cheapTrap(trip, [basic], { bags: 'checked' });
  assert.ok(open.text.includes(named(trip.flight, basic)), `${open.text} names ${named(trip.flight, basic)}`);
  const nsTrip = price({ ...trip.spec, flight: nonstop.id });
  const back = savemax.cheapTrap(nsTrip, [trip.flight], { bags: 'personal' });
  assert.equal(back.badge, null);
  assert.ok(back.text.includes(named(nonstop, trip.flight)) && /\d+ stop/.test(back.text) && back.text.includes('non-refundable'), back.text);
  assert.ok(Math.abs(nonstop.durationMinutes - trip.flight.durationMinutes) >= 60 && back.text.includes(`${hm(trip.flight.durationMinutes)} each way`), 'a duration an hour or more apart is said');
  // Two fares at one sticker price where only one includes the bag: the one without it only looks as cheap.
  const mk = (id, name, o) => ({ id, name, depart: '2027-01-01', farePerTraveler: 20000, taxesPerTraveler: 2050, stops: 1, durationMinutes: 300, carryOn: true, checkedBagIncluded: false, bagFeePerTraveler: 7000, refundable: false, ...o });
  const main = mk('main', 'Main', {}), plus = mk('plus', 'Main Plus', { checkedBagIncluded: true, bagFeePerTraveler: 0 });
  const tripOf = f => ({ spec: { travelers: 2 }, flight: f });
  const tie = savemax.cheapTrap(tripOf(main), [plus], { bags: 'checked' });
  assert.equal(tie.badge, 'looks-cheaper');
  assert.equal(tie.text, `The ${fmt(44100)} Main fare matches the ${fmt(44100)} Main Plus fare on the sticker, but with a checked bag it comes to ${fmt(58100)}. That fare is ${fmt(14000)} cheaper for the way you're traveling (a checked bag, 2 travelers).`);
  const tie2 = savemax.cheapTrap(tripOf(plus), [main], { bags: 'checked' });
  assert.equal(tie2.badge, 'cheaper-overall');
  assert.equal(tie2.text, `The ${fmt(44100)} Main Plus fare is ${fmt(14000)} cheaper for the way you're traveling (a checked bag, 2 travelers): the ${fmt(44100)} Main fare comes to ${fmt(58100)} once a checked bag is added.`);
  // The same price with the bag too: no trap, and never "cheaper".
  const same = savemax.cheapTrap(tripOf(main), [mk('main2', 'Main', {})], { bags: 'checked' });
  assert.equal(same.badge, null);
  assert.ok(same.text.startsWith('No bag trap here') && !same.text.includes('cheaper') && same.text.includes(fmt(58100)), same.text);
  // One traveler: no traveler count in the words.
  assert.ok(savemax.cheapTrap({ spec: { travelers: 1 }, flight: main }, [plus], { bags: 'checked' }).text.includes('(a checked bag)'));
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
  assert.equal(r.original, moved.total); assert.equal(r.final, shorter.total); assert.equal(r.max, max); assert.equal(r.keep, max - shorter.total); assert.equal(r.over, null);
  r.lines.forEach((l, i) => {
    assert.equal(l.from, versions[i].trip.total); assert.equal(l.to, versions[i + 1].trip.total); assert.equal(l.delta, l.to - l.from);
    assert.equal(l.fromLabel, versions[i].label); assert.equal(l.toLabel, versions[i + 1].label);
    if (i) assert.equal(l.from, r.lines[i - 1].to, 'no overlap between lines');
  });
  // The same package priced again is a price refresh, not a change; no maximum means no "you keep".
  const again = savemax.savingsReceipt([{ label: 'a', trip }, { label: 'b', trip: { ...trip, total: trip.total - 100 } }]);
  assert.equal(again.lines[0].label, 'Price refresh, same trip'); assert.equal(again.lines[0].delta, -100); assert.equal(again.keep, null); assert.equal(again.over, null);
  assert.equal(savemax.savingsReceipt([{ label: 'a', trip }, { label: 'b', trip }]).lines[0].label, 'No change');
  assert.deepEqual(savemax.savingsReceipt([], max), { lines: [], original: null, final: null, max, keep: null, over: null });
  // A party, traveler count or departure airport change is named, never called a price refresh.
  const three = price({ ...trip.spec, travelers: 3 }), friends = price({ ...trip.spec, who: 'friends' }), otherAirport = price({ ...trip.spec, from: 'EWR' });
  assert.ok(three && friends && otherAirport, 'the demo prices the party, count and airport changes');
  assert.equal(savemax.savingsReceipt([{ trip }, { trip: three }]).lines[0].label, 'Travelers: 2 → 3');
  assert.equal(savemax.savingsReceipt([{ trip }, { trip: friends }]).lines[0].label, 'Party change');
  assert.equal(savemax.savingsReceipt([{ trip }, { trip: otherAirport }]).lines[0].label, 'Departure airport change');
  assert.equal(savemax.lineLabel(three, { ...three, spec: { ...three.spec, travelers: 2, from: 'EWR' }, total: three.total - 1 }), 'Travelers: 3 → 2, Departure airport change');
  // Over the maximum: never a negative "you keep"; the overrun is carried apart. A zero or absent maximum: no "you keep".
  assert.ok(three.total > trip.total);
  const overMax = savemax.savingsReceipt([{ trip }, { trip: three }], trip.total);
  assert.equal(overMax.keep, null); assert.equal(overMax.over, three.total - trip.total); assert.equal(overMax.max, trip.total);
  for (const m of [0, null, undefined, NaN, Infinity]) { const x = savemax.savingsReceipt([{ trip }, { trip: three }], m); assert.equal(x.keep, null); assert.equal(x.over, null); }
  const atMax = savemax.savingsReceipt([{ trip }, { trip: three }], three.total);
  assert.equal(atMax.keep, 0); assert.equal(atMax.over, null);
});

test('savingsCheck: before paying, a materially cheaper version with nothing given up is shown; otherwise the check is complete', () => {
  // Walk down from the search's pick: every step is at least $25 cheaper with no trade-off and no
  // new compromise of weight 2 or more, keeps the traveler's own experiences, and the walk ends on a
  // trip where the check is complete and says how many versions it compared.
  let cur = trip, steps = 0, r;
  for (;;) {
    r = savemax.savingsCheck(inv, cur, settings, ctx, { now, locks: {} });
    assert.equal(r.total, cur.total, 'priced again before comparing');
    assert.equal(r.repriced, 0);
    assert.equal(typeof r.truncated, 'boolean'); assert.ok(Number.isInteger(r.considered) && r.considered >= 1);
    if (r.ok) break;
    assert.ok(steps++ < 6, 'the walk ends');
    checkPacked(r.cheaper);
    assert.ok(r.cheaper.total <= cur.total - 2500, 'material');
    assert.equal(r.cheaper.delta, r.cheaper.total - cur.total);
    assert.equal(decision.classifyChanges(cur, r.cheaper.trip).tradeoffs.length, 0, 'no compromise by the facts');
    assert.deepEqual(newHeavy(cur, r.cheaper.trip), [], 'no new compromise of weight 2 or more');
    assert.deepEqual(sortedIds(r.cheaper.trip.spec.activities), sortedIds(cur.spec.activities), 'the traveler\'s own experiences');
    assert.match(r.text, /^A version of this trip is \$[\d,.]+ cheaper \(.*\) without a compromise: /);
    cur = r.cheaper.trip;
  }
  assert.equal(r.text, `Savings check complete: nothing cheaper without a compromise among the ${r.considered} versions priced`);
  assert.equal(r.truncated, false);
  assert.equal(r.cheaper, undefined);
  const floor = cur;
  // The same trip on a dearer nearby date: the check finds the way back down, since a date move
  // gives nothing up; with the dates locked, or an exact date stated, the date move is off the table
  // and nothing is relaxed to reach it; a saving under the material threshold never counts.
  const dearer = nearby(floor, p => p.total >= floor.total + 2500).sort((a, b) => b.total - a.total)[0];
  assert.ok(dearer, 'the demo prices nearby dates more than $25 apart');
  const r2 = savemax.savingsCheck(inv, dearer, settings, ctx, { now, locks: {} });
  assert.equal(r2.ok, false);
  checkPacked(r2.cheaper);
  assert.ok(r2.cheaper.total <= floor.total, 'at least as cheap as the floor');
  assert.equal(decision.classifyChanges(dearer, r2.cheaper.trip).tradeoffs.length, 0);
  assert.ok(r2.text.includes(fmt(dearer.total - r2.cheaper.total)) && r2.text.includes('Dates: '));
  assert.equal(typeof r2.truncated, 'boolean'); assert.ok(r2.considered >= 1);
  const r3 = savemax.savingsCheck(inv, dearer, settings, ctx, { now, locks: { dates: true } });
  if (!r3.ok) assert.equal(r3.cheaper.trip.spec.depart, dearer.spec.depart);
  for (const c of [{ ...ctx, dateMode: 'exact', depart: dearer.spec.depart }, { ...ctx, dateMode: 'exact' }]) {
    const r4 = savemax.savingsCheck(inv, dearer, settings, c, { now, locks: {} });
    if (!r4.ok) { assert.equal(r4.cheaper.trip.spec.depart, dearer.spec.depart, 'an exact date is never moved'); assert.equal(r4.cheaper.trip.spec.nights, dearer.spec.nights); }
    else assert.doesNotMatch(r4.text, /Dates:/);
  }
  assert.equal(savemax.savingsCheck(inv, dearer, settings, ctx, { now, material: dearer.total }).ok, true);
  // A trip that can no longer be priced is never waved through.
  const r5 = savemax.savingsCheck(inv, { ...trip, spec: { ...trip.spec, hotel: 'nope' } }, settings, ctx, { now });
  assert.equal(r5.ok, false); assert.equal(r5.cheaper, null); assert.match(r5.text, /needs verification/); assert.equal(r5.truncated, false); assert.equal(r5.considered, 0);
  // The promo the checkout carries is applied to the fresh price and to every version compared.
  const promo = { code: 'TEN', type: 'percent', value: 10 };
  const rp = savemax.savingsCheck(inv, dearer, settings, ctx, { now, locks: {}, promo });
  assert.equal(rp.total, priceTrip(inv, dearer.spec, settings, { promo }).total, 'priced again with the promo');
  assert.ok(rp.total < dearer.total);
  if (!rp.ok) { assert.ok(rp.cheaper.trip.lines.some(l => l.key === 'promo'), 'the cheaper version carries the promo too'); assert.equal(rp.cheaper.total, priceTrip(inv, rp.cheaper.trip.spec, settings, { promo }).total); }
});

test('savingsCheck: a version the facts rows let through but that carries a new compromise of weight 2 or more is never proposed', () => {
  // A supplier whose cheapest fare includes a carry-on but flies at dawn: by the facts rows the fare
  // swap gives nothing up (more usable time, same bags), yet it brings a Basic fare and a 2:50 AM
  // hotel departure the trip does not have. Dates held so the fare swap is the only cheaper version.
  const dawnInv = { ...inv, flights: { ...inv.flights, search: q => inv.flights.search(q).map(f => (f.id === 'basic' ? { ...f, carryOn: true } : f)) } };
  const base = priceTrip(dawnInv, trip.spec, settings), dawn = priceTrip(dawnInv, { ...trip.spec, flight: 'basic' }, settings);
  assert.ok(base && dawn && dawn.total <= base.total - 2500, 'the dawn fare is materially cheaper');
  assert.equal(decision.classifyChanges(base, dawn).tradeoffs.length, 0, 'the facts rows alone would let it through');
  assert.ok(newHeavy(base, dawn).length >= 1, `new compromises: ${newHeavy(base, dawn).join('; ')}`);
  const r = savemax.savingsCheck(dawnInv, base, settings, ctx, { now, locks: { dates: true } });
  if (!r.ok) { assert.notEqual(r.cheaper.trip.spec.flight, 'basic'); assert.deepEqual(newHeavy(base, r.cheaper.trip), []); }
  else assert.match(r.text, /^Savings check complete: nothing cheaper without a compromise among the \d+ versions priced$/);
  // The traveler's own experiences are kept: a cheaper set of the same count is a swap, not a saving.
  assert.ok(trip.activityOptions.length >= 3, 'the demo offers three experiences here');
  const pair = optimizer.activitySets(trip.activityOptions, ctx.style).find(s => s.length === 2);
  const dearest = trip.activityOptions.filter(a => !pair.includes(a.id)).sort((a, b) => b.pricePerPerson - a.pricePerPerson)[0];
  const own = sortedIds([pair[0], dearest.id]);
  const mine = price({ ...trip.spec, activities: own }), swap = price({ ...trip.spec, activities: sortedIds(pair) });
  assert.ok(mine && swap && swap.total <= mine.total - 2500, 'the swap is materially cheaper');
  assert.equal(decision.classifyChanges(mine, swap).tradeoffs.length, 0, 'the facts rows alone would let it through');
  const rs = savemax.savingsCheck(inv, mine, settings, ctx, { now, locks: { dates: true } });
  if (!rs.ok) assert.deepEqual(sortedIds(rs.cheaper.trip.spec.activities), own);
  else assert.match(rs.text, /^Savings check complete/);
});

test('truncation: when a pass hits the pricing limit every result says so instead of claiming completeness', () => {
  // A supplier returning three hundred rooms like the trip's own: more versions than the limit.
  const many = { ...inv, hotels: { ...inv.hotels, search: q => { const hs = inv.hotels.search(q); const own = hs.find(h => h.id === trip.spec.hotel) || hs[0]; return [...hs, ...Array.from({ length: 300 }, (_, i) => ({ ...own, id: `${own.id}-twin${i}`, name: `${own.name} twin ${i}` }))]; } } };
  const t = priceTrip(many, trip.spec, settings);
  assert.ok(t && t.hotelOptions.length > 300);
  const sc = savemax.savingsCheck(many, t, settings, ctx, { now, locks: { dates: true } });
  assert.equal(sc.truncated, true);
  assert.ok(sc.considered >= 1);
  if (sc.ok) assert.equal(sc.text, `Savings check complete: nothing cheaper without a compromise among the ${sc.considered} versions priced (the pass was cut off at the pricing limit, so it is not exhaustive)`);
  else assert.match(sc.text, /^A version of this trip is/);
  const v = savemax.saverVerdict(many, t, settings, ctx, { now, locks: { dates: true } });
  assert.equal(v.truncated, true);
  assert.ok(v.text.endsWith('The pass was cut off at the pricing limit, so it is not exhaustive.'), v.text);
  assert.doesNotMatch(v.text, /it means \./);
  const bps = savemax.priceBreakpoints(many, t, settings, ctx, { now, cap: ctx.budget, locks: { dates: true } });
  assert.equal(bps.truncated, true);
  assert.ok(Array.isArray(bps) && bps.length <= 5);
  // The ordinary pass is not cut off and never says it was.
  const v2 = savemax.saverVerdict(inv, trip, settings, ctx, { now });
  assert.equal(v2.truncated, false); assert.doesNotMatch(v2.text, /cut off/);
});

test('saverVerdict: cut when a version we would still recommend costs less; otherwise stop and say what the cheapest would mean', () => {
  // Walk down until there is nothing cheaper we would recommend.
  let cur = trip, steps = 0, v;
  for (;;) {
    v = savemax.saverVerdict(inv, cur, settings, ctx, { now });
    assert.equal(typeof v.truncated, 'boolean');
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
    assert.ok(v.cheapest.whyNot.length >= 1);
    for (const line of v.cheapest.whyNot) assert.ok(v.text.includes(line), `names the compromise: ${line}`);
    assert.doesNotMatch(v.text, /it means \./);
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
  // An exact date is never moved, even by the saver's verdict.
  const held = savemax.saverVerdict(inv, dearer, settings, { ...ctx, dateMode: 'exact', depart: dearer.spec.depart }, { now });
  if (held.canCut) assert.equal(held.alternative.trip.spec.depart, dearer.spec.depart);
  if (held.cheapest) assert.equal(held.cheapest.trip.spec.depart, dearer.spec.depart);
});

test('labelsFor: saver-mode names on a new array, nothing mutated, never Best, Premium or Luxury; save-more is never called "Lowest I recommend"', () => {
  const before = JSON.stringify(result.picks.map(p => ({ kind: p.kind, label: p.label, blurb: p.blurb })));
  const out = savemax.labelsFor(result.picks);
  assert.notEqual(out, result.picks);
  // The optimizer's save-more pick is the strongest cheaper trip whatever its grade: without a trip
  // lowestRecommended vouches for, nothing is named "Lowest I recommend", and save-more is dropped.
  const kept = result.picks.filter(p => p.kind !== 'save-more');
  assert.ok(result.picks.length > kept.length, 'this search has a save-more pick');
  assert.equal(out.length, kept.length);
  assert.ok(!out.some(o => o.label === 'Lowest I recommend' || o.kind === 'save-more'));
  const names = { 'our-pick': 'Best value', upgrade: 'Keep more comfort' };
  out.forEach((o, i) => {
    assert.notEqual(o, kept[i], 'a copy');
    assert.equal(o.trip, kept[i].trip, 'the same priced trip');
    assert.equal(o.label, names[kept[i].kind]);
    assert.doesNotMatch(o.label, /^Best$|premium|luxury/i);
  });
  assert.equal(JSON.stringify(result.picks.map(p => ({ kind: p.kind, label: p.label, blurb: p.blurb }))), before, 'input untouched');
  const odd = [{ kind: 'closest', label: 'Closest we found' }];
  assert.deepEqual(savemax.labelsFor(odd), odd);
  assert.notEqual(savemax.labelsFor(odd)[0], odd[0]);
  assert.deepEqual(savemax.labelsFor(), []);
});

test('lowestRecommended: the cheapest eligible trip graded great or good, never above the save-more pick when that is recommended, and labelsFor names it second with save-more dropped', () => {
  // search hands out its eligible set, cheapest first, and the trips near the pick, strongest first.
  const el = result.eligibleTrips;
  assert.ok(Array.isArray(el) && el.length === result.eligible, 'every eligible candidate, with no 10% allowance');
  el.forEach((x, i) => { assert.ok(x.trip && Number.isFinite(x.match)); assert.ok(x.trip.total <= QUERY.budget); if (i) assert.ok(x.trip.total >= el[i - 1].trip.total, 'cheapest first'); });
  assert.ok(result.picks.every(p => el.some(x => x.trip === p.trip)), 'references to the packages already priced');
  const near = result.near;
  assert.ok(Array.isArray(near) && near.length <= 40);
  near.forEach((x, i) => { assert.ok(x.trip !== trip && Math.abs(x.trip.total - trip.total) <= 5000); if (i) assert.ok(x.match <= near[i - 1].match, 'strongest first'); });
  // The lowest recommended: cheapest among those decision.verdict grades great or good with the budget
  // taken out. Here the pick itself is that trip and the save-more pick is graded budget: it was never
  // the lowest we recommend, whatever its label said.
  const grade = t => decision.verdict(t, qctx).grade;
  const recommended = t => ['great', 'good'].includes(grade(t));
  const saveMore = result.picks.find(p => p.kind === 'save-more');
  assert.ok(saveMore && saveMore.trip.total < trip.total, 'the search has a cheaper save-more pick');
  const low = savemax.lowestRecommended(el, ctx);
  assert.ok(low, 'an eligible trip we would recommend exists');
  assert.equal(low.token, encodeSpec(low.trip.spec)); assert.equal(low.total, low.trip.total);
  assert.ok(recommended(low.trip)); assert.equal(low.verdict.grade, grade(low.trip));
  for (const x of el) if (x.trip.total < low.total) assert.ok(!recommended(x.trip), 'nothing cheaper is recommended');
  if (recommended(saveMore.trip)) assert.ok(low.total <= saveMore.trip.total); else assert.notEqual(low.token, encodeSpec(saveMore.trip.spec));
  assert.equal(low.match, el.find(x => x.trip === low.trip).match);
  // Which trip that is depends on the day's inventory: the pick itself when nothing cheaper than it is
  // recommended, otherwise the cheapest recommended trip below it; never anything else.
  const cheaperRecommended = el.filter(x => x.trip.total < trip.total && recommended(x.trip));
  assert.equal(low.token, encodeSpec((cheaperRecommended.length ? cheaperRecommended[0].trip : trip).spec), 'the cheapest recommended trip, the pick when nothing cheaper is recommended');
  if (!recommended(saveMore.trip)) assert.equal(grade(saveMore.trip), 'budget');
  // A lowest that is the pick itself is not listed twice; a cheaper lowest is listed second; save-more is
  // dropped either way.
  const asPick = savemax.labelsFor(result.picks, { lowest: { kind: 'lowest', token: low.token, total: low.total, trip: low.trip } });
  if (low.token === encodeSpec(trip.spec)) {
    assert.deepEqual(asPick.map(o => o.label), ['Best value', 'Keep more comfort']);
    assert.ok(!asPick.some(o => o.label === 'Lowest I recommend'));
  } else {
    assert.deepEqual(asPick.map(o => o.label), ['Best value', 'Lowest I recommend', 'Keep more comfort']);
    assert.equal(asPick[1].token, low.token);
  }
  assert.ok(!asPick.some(o => o.kind === 'save-more'));
  // Excluding the pick yields the next recommended trip, which may cost more than the pick: then the
  // pick is the lowest recommended and labelsFor never lists a dearer "lowest".
  const next = savemax.lowestRecommended(el, ctx, { exclude: [low.token] });
  assert.ok(!next || (next.token !== low.token && next.total >= low.total && recommended(next.trip)));
  if (next && next.total >= trip.total) assert.deepEqual(savemax.labelsFor(result.picks, { lowest: { kind: 'lowest', token: next.token, total: next.total, trip: next.trip } }).map(o => o.label), ['Best value', 'Keep more comfort']);
  assert.equal(savemax.lowestRecommended(el, ctx, { exclude: el.map(x => encodeSpec(x.trip.spec)) }), null);
  assert.equal(savemax.lowestRecommended([], ctx), null);
  // A bigger budget: a trip far cheaper than the save-more pick is graded good, so it is the lowest
  // recommended, and the labels read Best value, Lowest I recommend (second), Keep more comfort.
  const big = optimizer.search(inv, { ...QUERY, budget: 300000, vacationBudget: 300000, budgetInput: 3000 }, { settings, now });
  const bigPick = big.picks[0], bigSave = big.picks.find(p => p.kind === 'save-more');
  assert.ok(bigSave && big.picks.some(p => p.kind === 'upgrade'), 'the search has a save-more pick and an upgrade');
  const bq = { ...big.ctx, budget: null, allowOver: 0 };
  const bigLow = savemax.lowestRecommended(big.eligibleTrips, big.ctx);
  assert.ok(bigLow && bigLow.total < bigSave.trip.total && bigLow.total < bigPick.trip.total, `${fmt(bigLow.total)} under save more's ${fmt(bigSave.trip.total)}`);
  assert.ok(['great', 'good'].includes(decision.verdict(bigLow.trip, bq).grade));
  for (const x of big.eligibleTrips) if (x.trip.total < bigLow.total) assert.ok(!['great', 'good'].includes(decision.verdict(x.trip, bq).grade), 'nothing cheaper is recommended');
  const lowest = { kind: 'lowest', token: bigLow.token, total: bigLow.total, trip: bigLow.trip };
  const before = JSON.stringify(big.picks.map(p => ({ kind: p.kind, label: p.label })));
  const out = savemax.labelsFor(big.picks, { lowest });
  assert.deepEqual(out.map(o => o.label), ['Best value', 'Lowest I recommend', 'Keep more comfort']);
  assert.ok(!out.some(o => o.kind === 'save-more'));
  assert.equal(out[1].kind, 'lowest'); assert.equal(out[1].token, bigLow.token); assert.equal(out[1].trip, bigLow.trip);
  assert.notEqual(out[0], big.picks[0]); assert.equal(out[0].trip, big.picks[0].trip);
  assert.ok(out.every(o => !/^Best$|premium|luxury/i.test(o.label)));
  assert.equal(out.filter(o => o.total < big.picks[0].trip.total).length, 1, 'exactly one cheaper option');
  assert.equal(JSON.stringify(big.picks.map(p => ({ kind: p.kind, label: p.label }))), before, 'input untouched');
  // Without an upgrade the lowest is still second.
  assert.deepEqual(savemax.labelsFor(big.picks.filter(p => p.kind !== 'upgrade'), { lowest }).map(o => o.label), ['Best value', 'Lowest I recommend']);
});
