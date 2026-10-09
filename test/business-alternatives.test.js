// Cheaper alternatives (plan §G2-G4, Stage 1P): buildAlternatives' filters and ranking, the explainer and its
// guard, diff's give-ups and side-by-side comparison, and the 200-candidate ranking budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const alts = require('../server/business/alternatives');
const explain = require('../server/business/explain');
const diff = require('../server/business/diff');
const { evaluateTrip, STATUS_RANK } = require('../server/business/policy/evaluate');
const { defaultPolicy } = require('../server/business/policy/defaults');
const { fakeComposer } = require('./business-fakes');
const fx = require('./fixtures/business-rows');

const { flight, hotel, query, variant, ctx, deepFreeze } = fx;
const { buildAlternatives, alternativeId, MAX_ALTERNATIVES, MIN_SAVING_CENTS, CHEAPEST_WITHIN_LABEL } = alts;
const NO_AMOUNTS = /^[^$\d]*$/;
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;

/** Standard rules with fixed caps: short haul $500 in Economy, London hotels $300 a night, up to 4 stars. */
function rules() {
  const r = defaultPolicy('standard');
  r.flights.shortHaul.cap = { mode: 'fixed', amountCents: 50000 };
  r.flights.shortHaul.minAdvanceDays = 0;
  r.flights.longHaul.minAdvanceDays = 0;
  r.flights.blockedCarriers = ['ZS'];
  return r;
}
const evaluator = (r = rules(), extra = {}) => v => evaluateTrip(v.rows, ctx(r, extra), { budget: null });

// The pick: Business class on a Flex fare out (over the cap and above the cabin), Flex back, a Deluxe room.
const PICK_ROWS = deepFreeze({
  out: flight({ n: 1, fare: 'FLEX', cabin: 'business', totalCents: 90000 }),
  back: flight({ leg: 'back', n: 1, fare: 'FLEX', totalCents: 48000 }),
  hotel: hotel({ n: 1, room: 'DLX', roomName: 'Deluxe room', nightlyCents: 25000 }), // (25000 + 3500) × 4 = 114000
});
const PICK = deepFreeze(fx.pick(PICK_ROWS));

/** Seven qualifying candidates, one per kind but dates, plus every kind of candidate that must be left out. */
function candidates(pick = PICK) {
  const v = (kind, component, changes, opts) => variant(pick, kind, component, changes, opts);
  return {
    fare: v('fare', 'out', { out: flight({ n: 1, fare: 'CLASSIC', cabin: 'business', totalCents: 80000 }) }, { fromText: 'Flex', toText: 'Classic' }),
    cabin: v('cabin', 'out', { out: flight({ n: 1, fare: 'FLEX', totalCents: 49000 }) }, { fromText: 'Business', toText: 'Economy' }),
    flight: v('flight', 'out', { out: flight({ n: 2, depart: '13:40', fare: 'FLEX', cabin: 'business', totalCents: 85000 }) }),
    stops: v('stops', 'out', { out: flight({ n: 3, stops: 1, minutes: 330, fare: 'FLEX', cabin: 'business', totalCents: 70000 }) }),
    room: v('room', 'hotel', { hotel: hotel({ n: 1, room: 'STD', nightlyCents: 22000 }) }), // 100320
    hotel: v('hotel', 'hotel', { hotel: hotel({ n: 2, name: 'Fixture Inn Heathrow', area: 'Near the airport', stars: 3, nightlyCents: 15000 }) }), // 68400
    all_within: v('all_within', 'trip', { out: flight({ n: 1, fare: 'CLASSIC', totalCents: 45000 }) }),
  };
}

function leftOut(pick = PICK) {
  const v = (kind, component, changes, opts) => variant(pick, kind, component, changes, opts);
  const c = candidates(pick);
  const otherCity = v('hotel', 'hotel', { hotel: hotel({ n: 9, city: 'Manchester', nightlyCents: 10000 }) });
  const otherDestination = v('flight', 'out', { out: flight({ n: 4, to: 'DXB', minutes: 225, cabin: 'business', totalCents: 30000 }) }, { q: query({ to: 'DXB', hotel: false }) });
  return {
    blocked: v('flight', 'out', { out: flight({ n: 5, carrier: 'ZS', fare: 'FLEX', cabin: 'business', totalCents: 60000 }) }),
    unavailable: v('flight', 'out', { out: flight({ n: 6, available: false }) }),
    tooSmall: v('fare', 'back', { back: flight({ leg: 'back', n: 1, fare: 'CLASSIC', totalCents: 48000 - (MIN_SAVING_CENTS - 1) }) }),
    dearer: v('flight', 'back', { back: flight({ leg: 'back', n: 7, fare: 'FLEX', totalCents: 52000 }) }),
    badSum: { ...c.flight, totalCents: c.flight.totalCents - 5000 },
    twoChanges: v('flight', 'out', { out: c.flight.rows.out, hotel: c.hotel.rows.hotel }),
    fareOnAnotherFlight: v('fare', 'out', { out: flight({ n: 8, fare: 'CLASSIC', cabin: 'business', totalCents: 75000 }) }),
    flightThatIsTheSameOne: { ...c.fare, change: { ...c.fare.change, kind: 'flight' } },
    stopsWithNoStop: { ...c.flight, change: { ...c.flight.change, kind: 'stops' } },
    cabinNotLower: v('cabin', 'back', { back: flight({ leg: 'back', n: 1, fare: 'CLASSIC', cabin: 'premium', totalCents: 40000 }) }),
    wrongComponent: { ...c.room, change: { ...c.room.change, component: 'out' } },
    roomInAnotherHotel: { ...c.hotel, change: { ...c.hotel.change, kind: 'room' } },
    datesNotFlexible: v('dates', 'trip', datesRows(pick, 1), { q: shiftedQuery(pick.query, 1), days: 1 }),
    datesDisguised: v('flight', 'out', datesRows(pick, 1), { q: shiftedQuery(pick.query, 1) }),
    otherCity, otherDestination,
    droppedReturn: v('all_within', 'trip', { back: null }),
    unknownKind: { ...c.fare, change: { ...c.fare.change, kind: 'magic' } },
    // Changes hidden in the rows under the pick's own query: the query alone says nothing moved.
    flightOnAnotherDay: v('flight', 'out', { out: flight({ n: 2, date: '2026-11-13', fare: 'FLEX', cabin: 'business', totalCents: 80000 }) }),
    shorterStay: v('hotel', 'hotel', { hotel: hotel({ n: 2, name: 'Fixture Court London', nights: 3, nightlyCents: 25000 }) }),
    roomForFewerNights: v('room', 'hotel', { hotel: hotel({ n: 1, room: 'STD', nights: 3, nightlyCents: 22000 }) }),
    flightAndLowerCabin: v('flight', 'out', { out: flight({ n: 2, depart: '13:40', fare: 'FLEX', totalCents: 45000 }) }),
    stopsAndLowerCabin: v('stops', 'out', { out: flight({ n: 3, stops: 1, minutes: 330, fare: 'FLEX', totalCents: 46000 }) }),
    fareAndLowerCabin: v('fare', 'out', { out: asOffer(flight({ n: 1, fare: 'CLASSIC', totalCents: 44000 }), pick.rows.out) }),
    unchangedLegMoved: v('room', 'hotel', { out: asOffer(flight({ n: 1, date: '2026-11-13', fare: 'FLEX', cabin: 'business', totalCents: 90000 }), pick.rows.out), hotel: c.room.rows.hotel }),
    allWithinOnAnotherDay: v('all_within', 'trip', { out: flight({ n: 1, date: '2026-11-13', fare: 'CLASSIC', totalCents: 45000 }) }),
  };
}

/** `row` under `as`'s offer id (the same itinerary, as a provider would key it). */
const asOffer = (row, as) => ({ ...row, offerId: as.offerId, key: `f.${as.offerId}|${row.optionId}` });

function shiftedQuery(q, days) {
  const n = structuredClone(q);
  n.departDate = fx.addDays(q.departDate, days);
  if (n.returnDate) n.returnDate = fx.addDays(q.returnDate, days);
  if (n.hotel) Object.assign(n.hotel, { checkIn: fx.addDays(q.hotel.checkIn, days), checkOut: fx.addDays(q.hotel.checkOut, days) });
  return n;
}
function datesRows(pick, days, cents = { out: 80000, back: 40000, nightly: 22000 }) {
  const r = pick.rows;
  return {
    out: flight({ n: 1, date: fx.addDays('2026-11-12', days), fare: r.out.fare.code, cabin: r.out.cabin, totalCents: cents.out }),
    back: flight({ leg: 'back', n: 1, date: fx.addDays('2026-11-16', days), fare: r.back.fare.code, totalCents: cents.back }),
    hotel: hotel({ n: 1, room: r.hotel.optionId, roomName: r.hotel.room.name, checkIn: fx.addDays('2026-11-12', days), nightlyCents: cents.nightly }),
  };
}

const sum = rows => ['out', 'back', 'hotel'].reduce((n, c) => n + (rows[c] ? rows[c].totalCents : 0), 0);
const changedComponents = (pick, a) => ['out', 'back', 'hotel'].filter(c => (pick.rows[c] ? pick.rows[c].key : null) !== (a.rows[c] ? a.rows[c].key : null));

// ---------------------------------------------------------------------------------------------------------

test('buildAlternatives: within policy first, then the biggest saving; at most five; the cheapest within pinned', () => {
  const list = Object.values(candidates());
  const res = buildAlternatives({ pick: PICK, pickEval: evaluator()(PICK), candidates: list, evaluate: evaluator(), truncated: false });
  assert.equal(res.alternatives.length, MAX_ALTERNATIVES);
  assert.deepEqual(res.alternatives.map(a => [a.kind, a.evaluation.status, a.savesCents]), [
    ['all_within', 'within', 45000], ['cabin', 'within', 41000], ['hotel', 'out', 45600], ['stops', 'out', 20000], ['room', 'out', 13680],
  ]);
  assert.equal(res.truncated, true, 'seven qualified, five shown');
  assert.equal(res.noneWithin, false);
  assert.equal(res.cheapestWithin, res.alternatives[0]);
  assert.equal(res.alternatives[0].label, CHEAPEST_WITHIN_LABEL);
  assert.deepEqual(res.alternatives.slice(1).map(a => a.label), ['Economy instead of Business', 'Another hotel in London', 'One stop via Istanbul', 'Standard room, same hotel']);
  for (const a of res.alternatives) {
    assert.equal(a.id, alternativeId(a.selection, a.query));
    assert.match(a.id, /^[0-9a-f]{16}$/);
    assert.equal(a.savesCents, PICK.totalCents - a.totalCents, a.kind);
    assert.equal(a.totalCents, sum(a.rows), a.kind);
    assert.ok(a.savesCents >= MIN_SAVING_CENTS && a.totalCents < PICK.totalCents, a.kind);
    assert.notEqual(a.evaluation.status, 'blocked');
    assert.equal(a.note, '');
    assert.match(a.label, NO_AMOUNTS);
    assert.ok(a.giveUps.length >= 1 && a.giveUps.every(g => !/[$€£¥]|USD/.test(g)), a.kind);
    assert.equal(a.query.to, PICK.query.to, 'the destination never changes');
    assert.equal(a.rows.hotel.city, 'London');
    if (a.kind !== 'all_within' && a.kind !== 'dates') assert.deepEqual(changedComponents(PICK, a), [a.change.component], `${a.kind}: one change`);
  }
  for (let i = 1; i < res.alternatives.length; i++) {
    const [x, y] = [res.alternatives[i - 1], res.alternatives[i]];
    assert.ok(STATUS_RANK[x.evaluation.status] <= STATUS_RANK[y.evaluation.status], 'within before out');
    if (x.evaluation.status === y.evaluation.status) assert.ok(x.savesCents >= y.savesCents, 'bigger saving first');
  }
  // The labels of the two not shown, and their give-ups.
  const all = buildAlternatives({ pick: PICK, candidates: [candidates().fare, candidates().flight], evaluate: evaluator(), truncated: false });
  assert.deepEqual(all.alternatives.map(a => [a.kind, a.label]), [['fare', 'Same flight, Classic fare'], ['flight', 'Another flight the same day']]);
  assert.deepEqual(all.alternatives[0].giveUps, ['Outbound: 1 checked bag instead of 2', 'Outbound: 8 kg cabin bag instead of 10 kg', 'Outbound: refunds nothing (yours refunds 70%)', 'Outbound: no free changes']);
  assert.deepEqual(all.alternatives[1].giveUps, ['Outbound: leaves 13:40 instead of 08:35', 'Outbound: arrives 5h 5m later']);
  assert.equal(all.truncated, false);
  assert.equal(all.noneWithin, true);
  assert.equal(all.cheapestWithin, null);
});

test('buildAlternatives leaves out what breaks a promise, and never offers a blocked or dearer option', () => {
  for (const [name, v] of Object.entries(leftOut())) {
    const res = buildAlternatives({ pick: PICK, candidates: [v], evaluate: evaluator(), truncated: false });
    assert.deepEqual(res.alternatives, [], name);
    assert.deepEqual([res.noneWithin, res.cheapestWithin, res.truncated], [true, null, false], name);
  }
  // Mixed in with good candidates, they still change nothing.
  const good = Object.values(candidates());
  const mixed = buildAlternatives({ pick: PICK, candidates: [...Object.values(leftOut()), ...good], evaluate: evaluator(), truncated: false });
  assert.deepEqual(mixed, buildAlternatives({ pick: PICK, candidates: good, evaluate: evaluator(), truncated: false }));
  // Junk entries are skipped, not fatal.
  assert.deepEqual(buildAlternatives({ pick: PICK, candidates: [null, 1, {}, { rows: {} }], evaluate: evaluator() }).alternatives, []);
  assert.throws(() => buildAlternatives({ pick: PICK, candidates: [] }), TypeError);
  assert.throws(() => buildAlternatives(null), TypeError);
});

test('dates only when the traveler said the dates can move; the give-up says how far', () => {
  const flexPick = fx.pick(PICK_ROWS, query({ datesFlexible: true }));
  const later = variant(flexPick, 'dates', 'trip', datesRows(flexPick, 1), { q: shiftedQuery(flexPick.query, 1), days: 1 });
  const earlier = variant(flexPick, 'dates', 'trip', datesRows(flexPick, -2, { out: 85000, back: 40000, nightly: 22000 }), { q: shiftedQuery(flexPick.query, -2), days: -2 });
  const res = buildAlternatives({ pick: flexPick, candidates: [earlier, later], evaluate: evaluator(), truncated: false });
  assert.deepEqual(res.alternatives.map(a => [a.label, a.savesCents]), [['Leave a day later', 252000 - 220320], ['Leave two days earlier', 252000 - 225320]]);
  assert.deepEqual(res.alternatives[0].giveUps, ['Your trip moves 1 day later'], 'the same times a day later: nothing else');
  assert.deepEqual(res.alternatives[1].giveUps, ['Your trip moves 2 days earlier']);
  assert.equal(res.alternatives[0].query.departDate, '2026-11-13');
  // Without datesFlexible, the same candidates are left out; a date shift needs a days count.
  assert.deepEqual(buildAlternatives({ pick: PICK, candidates: [later], evaluate: evaluator() }).alternatives, []);
  const noDays = { ...later, change: { ...later.change } };
  delete noDays.change.days;
  assert.deepEqual(buildAlternatives({ pick: flexPick, candidates: [noDays], evaluate: evaluator() }).alternatives, []);
  // Ties on status and saving go to fewer give-ups, then the smaller shift.
  const a = variant(flexPick, 'dates', 'trip', datesRows(flexPick, 1), { q: shiftedQuery(flexPick.query, 1), days: 1 });
  const b = variant(flexPick, 'dates', 'trip', datesRows(flexPick, -1), { q: shiftedQuery(flexPick.query, -1), days: -1 });
  const c = variant(flexPick, 'dates', 'trip', datesRows(flexPick, 2), { q: shiftedQuery(flexPick.query, 2), days: 2 });
  assert.deepEqual(buildAlternatives({ pick: flexPick, candidates: [c, b, a], evaluate: evaluator() }).alternatives.map(x => x.change.days).slice(2), [2]);
});

test('a dates alternative is the whole trip moved together by change.days, and nothing else', () => {
  const flexPick = fx.pick(PICK_ROWS, query({ datesFlexible: true }));
  const moved = (days, changes = {}, o = {}) => variant(flexPick, 'dates', 'trip', { ...datesRows(flexPick, days), ...changes }, { q: shiftedQuery(flexPick.query, days), days, ...o });
  const returnLater = structuredClone(flexPick.query);
  Object.assign(returnLater, { returnDate: '2026-11-17' });
  returnLater.hotel.checkOut = '2026-11-17';
  const shrunk = structuredClone(flexPick.query);
  Object.assign(shrunk, { departDate: '2026-11-13', returnDate: '2026-11-15' });
  Object.assign(shrunk.hotel, { checkIn: '2026-11-13', checkOut: '2026-11-15' });
  const cases = {
    wrongDirection: moved(-3, {}, { days: 2 }),
    daysMismatch: moved(1, {}, { days: 3 }),
    tooFar: moved(4),
    returnOnly: variant(flexPick, 'dates', 'trip', { back: flight({ leg: 'back', n: 1, date: '2026-11-17', fare: 'FLEX', totalCents: 30000 }) }, { q: returnLater, days: 1 }),
    shrunkStay: variant(flexPick, 'dates', 'trip', {
      out: flight({ n: 1, date: '2026-11-13', fare: 'FLEX', cabin: 'business', totalCents: 80000 }),
      back: flight({ leg: 'back', n: 1, date: '2026-11-15', fare: 'FLEX', totalCents: 40000 }),
      hotel: hotel({ n: 1, room: 'DLX', roomName: 'Deluxe room', checkIn: '2026-11-13', nights: 2, nightlyCents: 25000 }),
    }, { q: shrunk, days: 1 }),
    otherHotel: moved(1, { hotel: hotel({ n: 3, name: 'Fixture Lodge London', stars: 3, room: 'DLX', checkIn: '2026-11-13', nightlyCents: 12000 }) }),
    otherRoom: moved(1, { hotel: hotel({ n: 1, room: 'STD', checkIn: '2026-11-13', nightlyCents: 12000 }) }),
    lowerCabin: moved(1, { out: flight({ n: 1, date: '2026-11-13', fare: 'FLEX', totalCents: 45000 }) }),
    otherFare: moved(1, { out: flight({ n: 1, date: '2026-11-13', fare: 'LIGHT', cabin: 'business', totalCents: 60000 }) }),
    moreStops: moved(1, { out: flight({ n: 3, date: '2026-11-13', stops: 1, minutes: 330, fare: 'FLEX', cabin: 'business', totalCents: 60000 }) }),
  };
  for (const [name, v] of Object.entries(cases)) {
    assert.ok(v.totalCents < flexPick.totalCents - MIN_SAVING_CENTS, `${name} is cheaper`);
    assert.deepEqual(buildAlternatives({ pick: flexPick, candidates: [v], evaluate: evaluator() }).alternatives, [], name);
  }
  // The same trip three days earlier on another carrier at another time is still the same trip moved.
  const otherCarrier = moved(-3, { out: flight({ n: 5, date: '2026-11-09', carrier: 'ZG', depart: '10:15', fare: 'FLEX', cabin: 'business', totalCents: 80000 }) });
  assert.deepEqual(buildAlternatives({ pick: flexPick, candidates: [otherCarrier], evaluate: evaluator() }).alternatives.map(a => a.label), ['Leave three days earlier']);
});

test('the all_within label claims only what is true: inside your policy only when it is, cheapest only when pinned', () => {
  const c = candidates();
  // Within policy, but a cheaper within-policy option (the cabin change) is pinned.
  const dearAll = variant(PICK, 'all_within', 'trip', { out: flight({ n: 4, depart: '13:40', fare: 'CLASSIC', totalCents: 49500 }) });
  const res = buildAlternatives({ pick: PICK, pickEval: evaluator()(PICK), candidates: [c.cabin, dearAll], evaluate: evaluator(), truncated: false });
  assert.deepEqual(res.alternatives.map(a => [a.kind, a.evaluation.status, a.label]), [
    ['cabin', 'within', CHEAPEST_WITHIN_LABEL], ['all_within', 'within', 'Every part inside your policy'],
  ]);
  // Out of policy (it overruns the department budget): no claim about being inside the policy.
  const budget = { remainingCents: 50000, periodKey: '2026-Q4', periodLabel: 'Q4 2026', departmentName: 'Engineering' };
  const tight = v => evaluateTrip(v.rows, ctx(rules()), { budget });
  const over = buildAlternatives({ pick: PICK, pickEval: tight(PICK), candidates: [c.all_within], evaluate: tight, truncated: false });
  assert.deepEqual(over.alternatives.map(a => [a.kind, a.evaluation.status, a.evaluation.violations.map(x => x.rule)]), [['all_within', 'out', ['budget']]]);
  assert.equal(over.noneWithin, true);
  assert.equal(over.alternatives[0].label, 'Other options for the parts outside your policy');
  assert.doesNotMatch(over.alternatives[0].label, /inside your policy|cheapest/i);
  // It swaps only what was outside the policy: an all_within that also changes a part inside it is left out.
  const alsoHotel = variant(PICK, 'all_within', 'trip', { out: c.all_within.rows.out, hotel: c.hotel.rows.hotel });
  assert.deepEqual(buildAlternatives({ pick: PICK, pickEval: evaluator()(PICK), candidates: [alsoHotel], evaluate: evaluator() }).alternatives, []);
});

test('noneWithin, truncated from the composer, and duplicate candidates kept once', () => {
  const c = candidates();
  const outOnly = buildAlternatives({ pick: PICK, candidates: [c.fare, c.hotel, c.room], evaluate: evaluator(), truncated: true });
  assert.deepEqual([outOnly.noneWithin, outOnly.cheapestWithin, outOnly.truncated, outOnly.alternatives.length], [true, null, true, 3]);
  assert.ok(outOnly.alternatives.every(a => a.label !== CHEAPEST_WITHIN_LABEL));
  // A candidate listed under two kinds (the same rows) appears once, under the more specific kind.
  const twice = { ...c.all_within, change: { ...c.all_within.change } };
  const asFare = { ...c.all_within, change: { kind: 'fare', component: 'out', fromText: 'Flex', toText: 'Classic' } };
  const fareAndCabin = buildAlternatives({ pick: PICK, candidates: [twice, c.all_within, asFare], evaluate: evaluator() });
  assert.equal(fareAndCabin.alternatives.length, 1);
  // Out of policy because the cap is $500 and the trip's out leg is $450 now in Economy: all within.
  assert.equal(fareAndCabin.alternatives[0].evaluation.status, 'within');
  // Five or fewer candidates: not truncated.
  assert.equal(buildAlternatives({ pick: PICK, candidates: [c.fare, c.cabin, c.flight, c.stops, c.room], evaluate: evaluator() }).truncated, false);
});

test('determinism: shuffled and frozen candidates give the same result; outputs are copies', () => {
  const list = deepFreeze([...Object.values(candidates()), ...Object.values(leftOut())]);
  const first = buildAlternatives({ pick: PICK, candidates: list, evaluate: evaluator(), truncated: false });
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 10; i++) {
    const shuffled = [...list].sort(() => rand() - 0.5);
    assert.deepEqual(buildAlternatives({ pick: PICK, candidates: shuffled, evaluate: evaluator(), truncated: false }), first);
  }
  first.alternatives[0].rows.out.totalCents = 1;
  assert.notEqual(list.find(v => v.change.kind === 'all_within').rows.out.totalCents, 1);
});

test('the 200-candidate ranking takes under 20 ms (real evaluateTrip and give-ups)', () => {
  const list = [];
  for (let n = 2; n < 202; n++) {
    const cabin = n % 3 === 0 ? 'economy' : 'business';
    list.push(variant(PICK, cabin === 'economy' ? 'cabin' : 'flight', 'out', {
      out: flight({ n, depart: `${String(6 + (n % 14)).padStart(2, '0')}:${String((n * 7) % 60).padStart(2, '0')}`, stops: 0, fare: ['LIGHT', 'CLASSIC', 'FLEX'][n % 3], cabin, totalCents: 40000 + ((n * 7919) % 49000) }),
    }));
  }
  const input = { pick: PICK, candidates: list, evaluate: evaluator(), truncated: false };
  for (let i = 0; i < 3; i++) buildAlternatives(input); // warm up
  // Best of 15 runs, each timed by the wall clock and by this process's CPU time, keeping the lower: when the
  // full suite shares the machine with other work, the wall clock also counts time this process spent waiting
  // for a CPU, which is not the ranking's cost. A slow ranking is slow by both measures.
  let best = Infinity;
  for (let i = 0; i < 15; i++) {
    const cpu = process.cpuUsage();
    const t = process.hrtime.bigint();
    const res = buildAlternatives(input);
    const wallMs = Number(process.hrtime.bigint() - t) / 1e6;
    const used = process.cpuUsage(cpu);
    best = Math.min(best, wallMs, (used.user + used.system) / 1000);
    assert.equal(res.alternatives.length, MAX_ALTERNATIVES);
    assert.equal(res.truncated, true);
  }
  assert.ok(best < 20, `ranking took ${best.toFixed(2)} ms`);
  if (process.env.SHOW_TIMING) console.log(`ranking ${best.toFixed(2)} ms`);
});

test('with the fake composer: every variant it offers is a real, cheaper, single change', async () => {
  const composer = fakeComposer();
  const q = composer.parseQuery({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', flex: '1' }, { today: '2026-10-09' });
  const s = await composer.search(q);
  const dearest = rows => rows.filter(r => r.available).sort((a, b) => b.totalCents - a.totalCents)[0];
  const rows = { out: dearest(s.legs.out.rows), back: dearest(s.legs.back.rows), hotel: dearest(s.legs.hotel.rows) };
  const pick = fx.pick(rows, q);
  const { candidates: list, truncated } = await composer.variants(q, pick.selection, { datesFlexible: true });
  assert.ok(list.length > 3);
  const r = defaultPolicy('standard');
  const res = buildAlternatives({ pick, candidates: list, evaluate: v => evaluateTrip(v.rows, ctx(r), { budget: null }), truncated });
  assert.ok(res.alternatives.length >= 1 && res.alternatives.length <= MAX_ALTERNATIVES);
  for (const a of res.alternatives) {
    assert.equal(a.savesCents, pick.totalCents - a.totalCents);
    assert.equal(a.totalCents, sum(a.rows));
    assert.match(a.label, NO_AMOUNTS);
    if (a.kind !== 'dates') assert.equal(changedComponents(pick, a).length, 1);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Explainer

const explainInput = res => ({
  violations: [{ rule: 'flight.cap' }, { rule: 'flight.cabin' }],
  alternatives: res.alternatives.map((a, i) => ({ id: a.id, kind: a.kind, withinPolicy: a.evaluation.status === 'within', savingsRank: i + 1, giveUps: a.giveUps })),
  noneWithin: res.noneWithin,
});
const builtRes = () => buildAlternatives({ pick: PICK, candidates: Object.values(candidates()), evaluate: evaluator(), truncated: false });

test('RuleExplainer: a note per alternative and a summary, with no digits, currency or pressure words', async () => {
  const input = explainInput(builtRes());
  const out = await new explain.RuleExplainer().explain(input);
  assert.deepEqual(out.order, input.alternatives.map(a => a.id));
  assert.deepEqual(Object.keys(out.notes).sort(), [...out.order].sort());
  assert.equal(out.summary, 'Your pick is outside your policy on price and cabin. These options come from the same search, with the ones inside your policy first.');
  const byKind = Object.fromEntries(input.alternatives.map(a => [a.kind, out.notes[a.id]]));
  assert.equal(byKind.cabin, 'A lower cabin on the same route. It fits your policy.');
  assert.equal(byKind.hotel, 'Another hotel in the same city, with fewer stars. It still needs approval.');
  assert.equal(byKind.stops, 'A flight with a stop on the way, so the trip takes longer, with different times. It still needs approval.');
  for (const text of [...Object.values(out.notes), out.summary]) {
    assert.match(text, NO_AMOUNTS);
    assert.ok(!PRESSURE.test(text) && !/\u2014/.test(text), text);
    assert.equal(explain.guardExplanation({ notes: { x: text }, order: ['x'] }, { alternatives: [{ id: 'x' }] }).notes.x, text.slice(0, explain.NOTE_MAX).trimEnd());
  }
  const fare = await new explain.RuleExplainer().explain({ violations: [], alternatives: [{ id: 'f', kind: 'fare', withinPolicy: true, savingsRank: 1, giveUps: ['1 checked bag instead of 2', 'No free changes'] }], noneWithin: false });
  assert.equal(fare.notes.f, 'Same flight on a cheaper fare: you keep your times, with fewer bags and stricter change rules. It fits your policy.');
  // all_within swaps only the parts outside the policy, and says so.
  const all = await new explain.RuleExplainer().explain({ violations: [], alternatives: [{ id: 'w', kind: 'all_within', withinPolicy: true, savingsRank: 1, giveUps: ['Outbound: leaves 07:05 instead of 13:40'] }], noneWithin: false });
  assert.equal(all.notes.w, 'The parts of your trip outside your policy swapped for their cheapest options inside it, with different times. It fits your policy.');
  // Another hotel never "changes nothing else": the hotel and its room show in the give-ups, and the note follows.
  const grand = hotel({ n: 1, stars: 4, room: 'DLX', roomName: 'Deluxe room', sleeps: 2, bed: 'King bed' });
  const court = hotel({ n: 2, name: 'Fixture Court London', stars: 4, room: 'SGL', roomName: 'Single room', sleeps: 1, bed: 'Single bed' });
  const swapped = await new explain.RuleExplainer().explain({ violations: [], alternatives: [{ id: 'h', kind: 'hotel', withinPolicy: true, savingsRank: 1, giveUps: diff.giveUps({ hotel: grand }, { hotel: court }) }], noneWithin: false });
  assert.equal(swapped.notes.h, 'Another hotel in the same city, with a smaller room. It fits your policy.');
  const none = await new explain.RuleExplainer().explain({ violations: [{ rule: 'budget' }], alternatives: [], noneWithin: true });
  assert.deepEqual(none, { order: [], notes: {}, summary: 'No cheaper option inside your policy turned up in this search. You can still request approval with a reason.' });
  // Every note fits the guard's length.
  for (const kind of ['fare', 'flight', 'stops', 'cabin', 'dates', 'room', 'hotel', 'all_within']) {
    const many = await new explain.RuleExplainer().explain({ violations: [], alternatives: [{ id: 'k', kind, withinPolicy: false, savingsRank: 1, giveUps: ['No checked bag instead of 1', 'Refunds nothing (yours refunds 70%)', 'No changes allowed', 'Leaves 07:05 instead of 13:40', "Can't be cancelled (yours can)"] }], noneWithin: false });
    assert.ok(many.notes.k.length <= explain.NOTE_MAX, kind);
  }
});

test('guardExplanation: drops any amount in any spelling, keeps every id once, cuts long text whole', async () => {
  const input = { alternatives: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const out = explain.guardExplanation({
    order: ['c', 'zzz', 'c', 'a', 7],
    notes: { a: 'Saves $50 on the fare', b: 'Fifty dollars less', c: 'Costs 50 less', zzz: 'Unknown' },
    summary: 'You save £40.',
  }, input);
  assert.deepEqual(out, { order: ['c', 'a', 'b'], notes: { a: '', b: '', c: '' }, summary: '' });
  for (const bad of ['50', '$', '€ less', 'USD', 'save ５０', 'about twenty percent', 'two hundred', 'cents off', '٣', '½ the price', '₹ less', 'EGP', 'a few euros']) {
    assert.equal(explain.guardExplanation({ notes: { a: bad } }, input).notes.a, '', bad);
  }
  assert.equal(explain.guardExplanation({ notes: { a: 'Same flight, fewer bags' } }, input).notes.a, 'Same flight, fewer bags');
  // Pressure, scarcity, popularity and rating claims, and long dashes, are dropped like amounts.
  for (const bad of ['Only a few seats left', 'Book now before it sells out!', 'Rated best by travelers.', 'Hurry, prices are rising fast.', 'Last chance on this fare',
    'Limited availability', 'Same flight \u2014 fewer bags', 'Same flight \u2013 fewer bags', 'Popular with travelers', 'Great reviews', 'Selling fast', 'Seats are going fast',
    'This one usually sells out', 'Guaranteed lower price', 'High demand on this route', 'Travelers love this hotel', 'A top-rated hotel', 'Still available today']) {
    assert.equal(explain.guardExplanation({ notes: { a: bad }, summary: bad }, input).notes.a, '', bad);
    assert.equal(explain.guardExplanation({ notes: { a: bad }, summary: bad }, input).summary, '', bad);
  }
  const evil = await explain.createExplainer({ business: { explainer: 'rules' } }, { explainer: { name: 'x', explain: async () => ({ order: ['a'], notes: { a: 'Only a few seats left \u2014 book now!' }, summary: 'Hurry, last chance.' }) } }).explain(input);
  assert.deepEqual([evil.notes.a, evil.summary], ['', '']);
  const long = explain.guardExplanation({ notes: { a: 'é'.repeat(400), b: `${'x'.repeat(159)}😀😀` }, summary: 'word '.repeat(100) }, input);
  assert.equal(Array.from(long.notes.a).length, explain.NOTE_MAX);
  assert.equal(long.notes.b, `${'x'.repeat(159)}😀`, 'never half a surrogate pair');
  assert.ok(long.summary.length <= explain.SUMMARY_MAX);
  assert.equal(explain.guardExplanation({ notes: { a: 'line\u0000one\u2028two' } }, input).notes.a, 'line one two');
  assert.deepEqual(explain.guardExplanation(null, input), { order: ['a', 'b', 'c'], notes: { a: '', b: '', c: '' }, summary: '' });
  assert.deepEqual(explain.guardExplanation({ notes: { a: 5 }, summary: {} }, input).notes.a, '');
});

test('createExplainer: unknown names refuse at boot; a throwing or slow explainer falls back; never rejects', async () => {
  assert.throws(() => explain.createExplainer({ business: { explainer: 'x' } }), /unknown explainer/);
  assert.throws(() => explain.createExplainer({}), /unknown explainer/);
  const config = { business: { explainer: 'rules' } };
  const input = explainInput(builtRes());
  const rules = await explain.createExplainer(config).explain(input);
  assert.equal(explain.createExplainer(config).name, 'rules');
  assert.deepEqual(rules, explain.guardExplanation(await new explain.RuleExplainer().explain(input), input));
  const throwing = explain.createExplainer(config, { explainer: { name: 't', explain: async () => { throw new Error('nope'); } } });
  assert.deepEqual(await throwing.explain(input), rules);
  const syncThrow = explain.createExplainer(config, { explainer: { name: 't', explain: () => { throw new Error('nope'); } } });
  assert.deepEqual(await syncThrow.explain(input), rules);
  let aborted = false;
  const slow = explain.createExplainer(config, {
    explainer: { name: 's', explain: (i, { signal }) => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; }); setTimeout(() => resolve({ order: [], notes: {}, summary: 'late' }), 2000).unref(); }) },
  });
  const t = Date.now();
  assert.deepEqual(await slow.explain(input), rules);
  const took = Date.now() - t;
  assert.ok(took >= explain.EXPLAIN_TIMEOUT_MS - 5 && took < 1500, `fell back after ${took} ms`);
  assert.equal(aborted, true, 'the slow explainer is told to stop');
  // What a plugged-in explainer sees: only the ExplainInput fields, frozen; whatever it says goes through the guard.
  let seen;
  const nosy = explain.createExplainer(config, {
    explainer: { name: 'n', explain: async i => { seen = i; return { order: [...i.alternatives.map(a => a.id)].reverse(), notes: { [i.alternatives[0].id]: 'Saves 40 dollars' }, summary: 'Cheaper options' }; } },
  });
  const extra = { ...input, totalCents: 252000, orgName: 'Acme Inc', alternatives: input.alternatives.map(a => ({ ...a, savesCents: 1, rows: {} })) };
  const said = await nosy.explain(extra);
  assert.deepEqual(Object.keys(seen).sort(), ['alternatives', 'noneWithin', 'violations']);
  assert.deepEqual(Object.keys(seen.alternatives[0]).sort(), ['giveUps', 'id', 'kind', 'savingsRank', 'withinPolicy']);
  assert.ok(Object.isFrozen(seen) && Object.isFrozen(seen.alternatives[0]) && Object.isFrozen(seen.alternatives[0].giveUps));
  assert.deepEqual(said.order, input.alternatives.map(a => a.id).reverse());
  assert.equal(said.notes[input.alternatives[0].id], '');
  assert.equal(said.summary, 'Cheaper options');
  // Garbage in: still resolves.
  for (const junk of [null, undefined, 5, { alternatives: 'x' }]) {
    const o = await explain.createExplainer(config).explain(junk);
    assert.deepEqual(o.order, []);
  }
});

// ---------------------------------------------------------------------------------------------------------
// diff

test('giveUps: one line per thing that gets worse, never a price; legs prefixed on a return trip', () => {
  const p = flight({ fare: 'FLEX' });
  assert.deepEqual(diff.giveUps({ out: p }, { out: flight({ fare: 'LIGHT' }) }), ['No checked bag instead of 2', '7 kg cabin bag instead of 10 kg', 'Refunds nothing (yours refunds 70%)', 'No changes allowed']);
  const fareRow = (fare, override, o = {}) => { const r = flight({ fare, fareOverride: override, ...o }); return { ...r, optionId: r.fare.code, key: `f.${r.offerId}|${r.fare.code}` }; };
  assert.deepEqual(diff.giveUps({ out: flight({ fare: 'CLASSIC' }) }, { out: fareRow('CLASSIC', { code: 'SAVER', name: 'Saver' }) }), ['Saver fare instead of Classic']);
  assert.deepEqual(diff.giveUps({ out: flight({ fare: 'FLEX' }) }, { out: fareRow('FLEX', { code: 'FLEX30', name: 'Flex 30', refundablePercent: 30 }) }), ['Refunds 30% (yours refunds 70%)']);
  assert.deepEqual(diff.giveUps({ out: p }, { out: flight({ n: 3, stops: 1, minutes: 330, depart: '13:40', carrier: 'ZG', fare: 'FLEX' }) }),
    ['Flies with Gulfstar instead of Mediterra Airways', 'Leaves 13:40 instead of 08:35', 'Arrives 7h 5m later', '1 stop in Istanbul, adds 2h']);
  assert.deepEqual(diff.giveUps({ out: flight({ cabin: 'business' }) }, { out: flight({ cabin: 'premium' }) }), ['Premium economy instead of Business']);
  assert.deepEqual(diff.giveUps({ out: p, back: flight({ leg: 'back' }) }, { out: flight({ fare: 'CLASSIC' }), back: flight({ leg: 'back' }) }),
    ['Outbound: 1 checked bag instead of 2', 'Outbound: 8 kg cabin bag instead of 10 kg', 'Outbound: refunds nothing (yours refunds 70%)', 'Outbound: no free changes']);
  // An earlier departure or arrival is not a give-up beyond the new time.
  assert.deepEqual(diff.giveUps({ out: p }, { out: flight({ n: 2, depart: '06:10', fare: 'FLEX' }) }), ['Leaves 06:10 instead of 08:35']);
  // Hotels.
  const h = hotel({ room: 'DLX', roomName: 'Deluxe room', stars: 5, sleeps: 3 });
  assert.deepEqual(diff.giveUps({ hotel: h }, { hotel: hotel({ room: 'STD', stars: 5, sleeps: 2, freeUntilHours: 72 }) }),
    ['Standard room instead of Deluxe room', 'Sleeps 2 instead of 3', 'Free cancellation ends 72 hours before check-in instead of 48']);
  assert.deepEqual(diff.giveUps({ hotel: h }, { hotel: hotel({ n: 2, name: 'Fixture Inn', area: 'Near the airport', stars: 4, refundable: false }) }),
    ['Stays at Fixture Inn instead of Fixture Grand London', 'Near the airport instead of City centre', 'Standard room instead of Deluxe room', 'Sleeps 2 instead of 3', '4-star instead of 5-star', "Can't be cancelled (yours can)"]);
  // Another hotel with the same stars and area but a smaller room: the hotel and the room both show.
  const grand = hotel({ n: 1, name: 'Fixture Grand London', stars: 4, room: 'DLX', roomName: 'Deluxe room', sleeps: 2, bed: 'King bed', nightlyCents: 28000 });
  const court = hotel({ n: 2, name: 'Fixture Court London', stars: 4, room: 'SGL', roomName: 'Single room', sleeps: 1, bed: 'Single bed', nightlyCents: 20000 });
  assert.deepEqual(diff.giveUps({ hotel: grand }, { hotel: court }),
    ['Stays at Fixture Court London instead of Fixture Grand London', 'Single room instead of Deluxe room', 'Single bed instead of King bed', 'Sleeps 1 instead of 2']);
  // The same room name in another hotel still names the hotel.
  assert.deepEqual(diff.giveUps({ hotel: hotel({ n: 1 }) }, { hotel: hotel({ n: 2, name: 'Fixture Court London' }) }), ['Stays at Fixture Court London instead of Fixture Grand London']);
  const swap = buildAlternatives({ pick: fx.pick({ out: flight(), back: flight({ leg: 'back' }), hotel: grand }), candidates: [variant(fx.pick({ out: flight(), back: flight({ leg: 'back' }), hotel: grand }), 'hotel', 'hotel', { hotel: court })], evaluate: evaluator(defaultPolicy('standard')) });
  assert.deepEqual(swap.alternatives.map(a => [a.label, a.giveUps.includes('Nothing else changes')]), [[CHEAPEST_WITHIN_LABEL, false]]);
  // On a return trip, a cabin or fare name keeps its capital after the leg.
  const back = flight({ leg: 'back' });
  assert.deepEqual(diff.giveUps({ out: flight({ cabin: 'business' }), back }, { out: flight({ cabin: 'premium' }), back }), ['Outbound: Premium economy instead of Business']);
  assert.deepEqual(diff.giveUps({ out: flight(), back: flight({ leg: 'back', fare: 'CLASSIC' }) }, { out: flight(), back: fareRow('CLASSIC', { code: 'SAVER', name: 'Saver' }, { leg: 'back' }) }), ['Return: Saver fare instead of Classic']);
  // Same rows, or only cheaper: nothing else changes.
  assert.deepEqual(diff.giveUps({ out: p, hotel: h }, { out: p, hotel: h }), ['Nothing else changes']);
  assert.deepEqual(diff.giveUps({ out: flight({ fare: 'LIGHT' }) }, { out: flight({ fare: 'FLEX' }) }), ['Flex fare instead of Light']);
  for (const lines of [diff.giveUps({ out: p }, { out: flight({ fare: 'LIGHT', carrier: 'ZG' }) })]) for (const l of lines) assert.ok(!/[$€£¥]/.test(l));
});

test('compareTrips: rows that differ in DIFF_FIELDS order, null for a missing side, the totals delta; lineDeltas add up', () => {
  const a = { rows: { out: flight({ fare: 'FLEX', cabin: 'business', totalCents: 90000 }), hotel: hotel({ stars: 5 }) }, totalCents: 90000 + 114000 };
  const b = { rows: { out: flight({ fare: 'CLASSIC', totalCents: 45000 }), hotel: hotel({ stars: 5 }) }, totalCents: 45000 + 114000 };
  const cmp = diff.compareTrips(a, b);
  assert.deepEqual(cmp.rows, [
    { label: 'Outbound cabin', a: 'Business', b: 'Economy' },
    { label: 'Outbound fare', a: 'Flex', b: 'Classic' },
    { label: 'Outbound bags', a: '10 kg cabin bag, 2 checked bags (23 kg)', b: '8 kg cabin bag, 1 checked bag (23 kg)' },
    { label: 'Outbound refunds', a: 'Refunds 70%', b: 'Refunds nothing' },
    { label: 'Outbound fare terms', a: '70% refundable. Free changes.', b: 'Non-refundable. Changes for a fee.' },
  ]);
  assert.deepEqual(cmp.totalCents, { a: 204000, b: 159000, delta: -45000 });
  const later = diff.compareTrips(a, { rows: { out: flight({ date: '2026-11-13', depart: '07:05', carrier: 'ZG', fare: 'FLEX', cabin: 'business', totalCents: 80000 }), hotel: hotel({ checkIn: '2026-11-13', stars: 5 }) }, totalCents: 194000 });
  // The declared order of the TripComparison typedef: carrier, times, stops, cabin, fare, bags, refunds, hotel,
  // room, stars, dates (with fare terms after refunds and hotel cancellation after stars).
  assert.deepEqual([...diff.DIFF_FIELDS], ['carrier', 'times', 'stops', 'cabin', 'fare', 'bags', 'refunds', 'changes', 'hotel', 'room', 'stars', 'hotelRefunds', 'dates']);
  assert.deepEqual(later.rows.map(r => r.label), ['Outbound flight', 'Outbound times', 'Dates']);
  assert.deepEqual(later.rows.at(-1), { label: 'Dates', a: 'Thu 12 Nov to Mon 16 Nov', b: 'Fri 13 Nov to Tue 17 Nov' });
  const noHotel = diff.compareTrips(a, { rows: { out: a.rows.out }, totalCents: 90000 });
  assert.deepEqual(noHotel.rows.find(r => r.label === 'Hotel'), { label: 'Hotel', a: 'Fixture Grand London, City centre', b: null });
  // lineDeltas: matched by label and kind, summing to the totals' delta.
  const x = hotel({ nightlyCents: 25000 }), y = hotel({ nightlyCents: 22000 });
  const d = diff.lineDeltas(x, y);
  assert.deepEqual(d, [
    { label: '4 nights', kind: 'base', from: 100000, to: 88000, delta: -12000 },
    { label: 'Taxes and fees', kind: 'tax', from: 14000, to: 12320, delta: -1680 },
  ]);
  assert.equal(d.reduce((n, l) => n + l.delta, 0), y.totalCents - x.totalCents);
  const three = hotel({ nights: 3, nightlyCents: 22000 });
  const e = diff.lineDeltas(x, three);
  assert.deepEqual(e.map(l => l.label), ['4 nights', 'Taxes and fees', '3 nights']);
  assert.equal(e.reduce((n, l) => n + l.delta, 0), three.totalCents - x.totalCents);
  assert.deepEqual(diff.lineDeltas(null, x).map(l => l.delta), [100000, 14000]);
});

// ---------------------------------------------------------------------------------------------------------
// Supplier test data (real-suppliers design §7.1 B items, §8.3): what the airline or hotel supplier doesn't say
// is never turned into a fact. Rows in the flt_t./htl_t. namespace; weights 0 mean "not stated".

test('giveUps and compareTrips on supplier rows: an unknown change rule is never "No changes allowed"; "No refund confirmed"; "No star rating"; never "0 kg"', () => {
  const { sandboxRow } = require('./business-sandbox');
  const { TERMS } = require('../server/business/source');
  const usd = amount => ({ allowed: true, penaltyAmount: amount, penaltyCurrency: 'USD' });
  const sFlight = (o, terms) => sandboxRow(flight({ ...o, fareOverride: { cabinKg: 0, checkedKg: 0, ...o.fareOverride, terms: TERMS.fare(terms) } }));
  // The pick: refunds for a fee, changes for a fee, one checked bag (weights not stated).
  const p = sFlight({ fare: 'CLASSIC', fareOverride: { name: 'Economy Standard', refundablePercent: 80, changeable: true, checkedBags: 1 } },
    { refund: usd('30.00'), change: usd('50.00'), bags: { checked: 1, carryOn: 1 } });
  // The alternative: the airline says nothing about refunds or changes.
  const unknown = sFlight({ n: 2, fare: 'LIGHT', fareOverride: { name: 'Economy Basic', refundablePercent: 0, changeable: false, checkedBags: 1 } },
    { refund: null, change: null, bags: { checked: 1, carryOn: 1 } });
  const lines = diff.giveUps({ out: p }, { out: unknown });
  assert.deepEqual(lines, ['No refund confirmed (yours refunds 80%)', 'Changes not confirmed by the airline']);
  assert.ok(!lines.includes('No changes allowed'), 'an unknown change rule is not "No changes allowed"');
  // The airline's own "not allowed" is a lost change; its own "not allowed" refund is "Refunds nothing".
  const no = sFlight({ n: 3, fare: 'LIGHT', fareOverride: { name: 'Economy Basic', refundablePercent: 0, changeable: false, checkedBags: 1 } },
    { refund: { allowed: false }, change: { allowed: false }, bags: { checked: 1, carryOn: 1 } });
  assert.deepEqual(diff.giveUps({ out: p }, { out: no }), ['Refunds nothing (yours refunds 80%)', 'No changes allowed']);
  // Two unknowns are not a give-up against each other.
  assert.deepEqual(diff.giveUps({ out: unknown }, { out: sFlight({ n: 4, fare: 'LIGHT', fareOverride: { name: 'Economy Basic', refundablePercent: 0, changeable: false, checkedBags: 1 } }, { refund: null, change: null, bags: { checked: 1, carryOn: 1 } }) }), ['Nothing else changes']);
  // Bags the airline doesn't state are not compared; weights of 0 are never printed.
  const noBags = sFlight({ n: 5, fare: 'CLASSIC', fareOverride: { name: 'Economy Standard', refundablePercent: 80, changeable: true, checkedBags: 0 } },
    { refund: usd('30.00'), change: usd('50.00'), bags: null });
  assert.deepEqual(diff.giveUps({ out: p }, { out: noBags }), ['Nothing else changes'], 'a bag count the airline did not state is not "No checked bag"');
  const stated = sFlight({ n: 6, fare: 'CLASSIC', fareOverride: { name: 'Economy Standard', refundablePercent: 80, changeable: true, checkedBags: 0 } },
    { refund: usd('30.00'), change: usd('50.00'), bags: { checked: 0, carryOn: 1 } });
  assert.deepEqual(diff.giveUps({ out: p }, { out: stated }), ['No checked bag instead of 1']);
  // Demo rows keep every rule: the fixture's own "No changes allowed".
  assert.ok(diff.giveUps({ out: flight({ fare: 'FLEX' }) }, { out: flight({ fare: 'LIGHT' }) }).includes('No changes allowed'));

  const cmp = diff.compareTrips({ rows: { out: p }, totalCents: p.totalCents }, { rows: { out: unknown }, totalCents: unknown.totalCents });
  const row = label => cmp.rows.find(r => r.label === label);
  assert.deepEqual(row('Outbound refunds'), { label: 'Outbound refunds', a: 'Refunds 80%', b: 'No refund confirmed' });
  const bags = diff.compareTrips({ rows: { out: p }, totalCents: 1 }, { rows: { out: noBags }, totalCents: 1 }).rows.find(r => r.label === 'Outbound bags');
  assert.deepEqual(bags, { label: 'Outbound bags', a: '1 checked bag', b: 'Checked bags not stated by the airline' });
  for (const r of [...cmp.rows, bags]) assert.ok(!/\b0 kg\b/.test(`${r.a} ${r.b}`), `no "0 kg": ${r.a} | ${r.b}`);
  for (const l of [...lines, ...diff.giveUps({ out: p }, { out: noBags })]) assert.ok(!/\b0 kg\b/.test(l), l);
  // A stated weight still prints.
  const kg = sandboxRow(flight({ fare: 'CLASSIC', fareOverride: { cabinKg: 8, checkedKg: 23, checkedBags: 1, terms: TERMS.fare({ refund: { allowed: false }, change: usd('50.00'), bags: { checked: 1, carryOn: 1 } }) } }));
  assert.equal(diff.compareTrips({ rows: { out: kg }, totalCents: 1 }, { rows: { out: p }, totalCents: 1 }).rows.find(r => r.label === 'Outbound bags').a, '8 kg cabin bag, 1 checked bag (23 kg)');

  // Hotels: stars 0 from a supplier is "No star rating"; a half star reads as given.
  const four = sandboxRow(hotel({ stars: 4 }));
  const unrated = sandboxRow(hotel({ n: 2, name: 'Fixture Inn London', stars: 0 }));
  assert.deepEqual(diff.giveUps({ hotel: four }, { hotel: unrated }), ['Stays at Fixture Inn London instead of Fixture Grand London', 'No star rating instead of 4-star']);
  assert.deepEqual(diff.giveUps({ hotel: sandboxRow(hotel({ stars: 4.5 })) }, { hotel: sandboxRow(hotel({ n: 3, name: 'Fixture Court London', stars: 4 })) }),
    ['Stays at Fixture Court London instead of Fixture Grand London', '4-star instead of 4.5-star']);
  const stars = diff.compareTrips({ rows: { hotel: four }, totalCents: 1 }, { rows: { hotel: unrated }, totalCents: 1 }).rows.find(r => r.label === 'Hotel class');
  assert.deepEqual([stars && stars.a, stars && stars.b], ['4-star', 'No star rating']);
});
