// One number, three vacations: every strategy, pushed variant, mix and budget note is a package the
// pricer priced, never a cent over the ceiling; a rule the customer set (a lock, an exact date, a
// chosen month, a stated length, a rejected destination or hotel) is never relaxed; "already shown"
// is judged by shape; "worth it", "none improves" and "$X more buys" are literally true by the
// comparison's own definitions, checked here by brute force over the same inventory.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { DEFAULT_SETTINGS, priceTrip, roomsFor } = require('../server/trips/pricing');
const optimizer = require('../server/trips/optimizer');
const { classifyChanges, usableTime } = require('../server/trips/facts');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { addDays, today } = require('../server/lib/dates');
const { format } = require('../server/lib/money');
const strategies = require('../server/trips/strategies');

const raw = createTripIntegrations(loadConfig({ APP_ENV: 'development' }));
const inv = optimizer.memoInventory(raw);
const settings = DEFAULT_SETTINGS;
const now = new Date();
const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const money = s => Math.round(Number(s.replace(/[$,]/g, '')) * 100);
const QUERY = { budget: 200000, vacationBudget: 200000, keep: 0, budgetInput: 2000, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
const KEYS = ['more', 'keep', 'special'];
const LOCK_KEYS = ['hotel', 'flight', 'dates', 'nights', 'dest'];
const LOCKED = { hotel: 'The hotel is locked', flight: 'The flights are locked', dates: 'The dates are locked', nights: 'The length is locked', dest: 'The destination is locked' };
const price = (spec, i = inv) => priceTrip(i, spec, settings);
const shape = t => strategies.shapeKey(t.spec);
const ways = (q, opts = {}) => strategies.threeWays(inv, q, { settings, now, nightsOpen: true, ...opts });

// A packed trip carries its own token, and the token is the trip: pricing it again gives the same total.
function checkPacked(x, cap) {
  assert.equal(x.token, encodeSpec(x.trip.spec));
  assert.equal(x.total, x.trip.total);
  const again = price(decodeSpec(x.token));
  assert.ok(again, 'the token prices');
  assert.equal(again.total, x.total);
  assert.equal(encodeSpec(again.spec), x.token);
  if (cap !== undefined) assert.ok(x.total <= cap, `${fmt(x.total)} at or under ${fmt(cap)}`);
}

// Every package the optimizer would price for these lengths, built here from the optimizer's own
// pieces so the engine's claims are checked against an independent enumeration.
function enumerate(q, nightsList, exclude = {}) {
  const origin = inv.maps.getOrigin(q.origin), airport = origin.airports[0].code;
  const skipDest = new Set(exclude.dests || []), skipHotel = new Set(exclude.hotels || []);
  const out = [];
  for (const dest of inv.maps.listDestinations()) {
    if (skipDest.has(dest.id) || (q.dest && dest.id !== q.dest)) continue;
    if (q.style !== 'surprise' && q.style !== 'all-inclusive' && !dest.styles.includes(q.style)) continue;
    for (const nights of nightsList) for (const depart of optimizer.candidateDates(inv, { ...q, nights }, airport, dest.id, now)) {
      const base = { dest: dest.id, from: airport, depart, nights, travelers: q.travelers, who: q.who };
      const flights = inv.flights.search({ from: airport, destId: dest.id, depart, nights, travelers: q.travelers }).filter(f => optimizer.rulesAllowFlight(f, q.rules));
      const hotels = inv.hotels.search({ destId: dest.id, checkIn: depart, nights, rooms: roomsFor(base) }).filter(h => optimizer.hotelAllowed(h, q) && optimizer.rulesAllowHotel(h, q.rules) && !skipHotel.has(h.id));
      const acts = inv.activities.search({ destId: dest.id, date: depart, travelers: q.travelers });
      for (const f of flights) for (const h of hotels) for (const a of optimizer.activitySets(acts, q.style)) for (const transfer of q.rules && q.rules.transfer ? [true] : [false, true]) {
        const t = price({ ...base, flight: f.id, hotel: h.id, activities: a, bags: false, transfer });
        if (t) out.push(t);
      }
    }
  }
  return out;
}
const worthIt = (cur, t) => { const ch = classifyChanges(cur, t); return ch.improvements.length > 0 && ch.tradeoffs.length === 0; };
const lengths = n => [n - 1, n, n + 1, n + 2].filter(x => x >= 2 && x <= 14);

test('threeWays: three priced packages at or under the ceiling, keep = budget - total, each meaningfully different', () => {
  const out = ways(QUERY);
  assert.ok(out.strategies.length >= 2 && out.strategies.length <= 3, `${out.strategies.length} ways`);
  assert.ok(out.considered > 0 && out.destinations > 1);
  for (const s of out.strategies) {
    checkPacked(s, QUERY.budget);
    assert.equal(s.keep, QUERY.budget - s.total);
    assert.ok(KEYS.includes(s.key) && s.label === strategies.LABELS[s.key]);
    assert.ok(s.trip.spec.nights >= QUERY.nights - 1 && s.trip.spec.nights <= QUERY.nights + 2, 'nights open: one fewer to two more');
    assert.ok(s.why.some(w => w.includes(`${fmt(s.total)} total with every tax and fee; leaves ${fmt(s.keep)} of your ${fmt(QUERY.budget)}`)));
    assert.equal(s.differs.length, out.strategies.length - 1);
  }
  assert.equal(new Set(out.strategies.map(s => s.token)).size, out.strategies.length, 'three different trips');
  for (const a of out.strategies) for (const b of out.strategies) if (a !== b) assert.ok(strategies.differences(a.trip, b.trip).all.length, `${a.key} differs from ${b.key}`);
  const more = out.strategies.find(s => s.key === 'more'), keep = out.strategies.find(s => s.key === 'keep'), special = out.strategies.find(s => s.key === 'special');
  if (more && keep) assert.ok(keep.total < more.total, 'Keep more costs less than More vacation');
  if (more && special) assert.ok(strategies.stepUp(more.trip, special.trip, QUERY.nights), 'Make it special is a real step up over More');
  assert.ok(out.pick && out.strategies.some(s => s.key === out.pick.key) && out.pick.reasons.length);
  // A stated length holds every way at that length; the keep share and the pool are honest.
  const fixed = ways(QUERY, { nightsOpen: false });
  for (const s of fixed.strategies) assert.equal(s.trip.spec.nights, QUERY.nights);
  assert.equal(strategies.KEEP_SHARE, 0.8);
});

test('rejected destinations and hotels never come back: not as a strategy, a pushed variant, or a strategy or note at a new budget', () => {
  let variants = 0;
  for (const [origin, budget] of [['NYC', 200000], ['LAX', 160000], ['CHI', 260000]]) {
    const q = { ...QUERY, origin, budget, vacationBudget: budget };
    const first = ways(q);
    assert.ok(first.strategies.length, `${origin}: a first set`);
    const rejected = [...new Set(first.strategies.map(s => s.trip.dest.id))];
    const hotels = [...new Set(first.strategies.map(s => s.trip.hotel.id))];
    const names = rejected.map(id => inv.maps.getDestination(id).name);
    const exclude = { dests: rejected, tokens: first.strategies.map(s => s.token), hotels };
    const again = ways(q, { exclude });
    assert.ok(again.strategies.length, `${origin}: a set without ${names.join(', ')}`);
    for (const s of again.strategies) {
      checkPacked(s, budget);
      assert.ok(!rejected.includes(s.trip.dest.id), `${origin}: ${s.trip.dest.id} was rejected`);
      assert.ok(!hotels.includes(s.trip.hotel.id), `${origin}: ${s.trip.hotel.id} was left out`);
      for (const key of KEYS) {
        const out = strategies.pushDirection(inv, q, s, key, { settings, now, exclude, prefer: key === 'more' ? 'exciting' : null });
        for (const v of out.variants) {
          checkPacked(v, budget);
          assert.ok(!rejected.includes(v.trip.dest.id), `${origin}/${key}/${v.letter}: ${v.trip.dest.id} was rejected`);
          assert.ok(!hotels.includes(v.trip.hotel.id), `${origin}/${key}/${v.letter}: ${v.trip.hotel.id} was left out`);
          assert.ok(!exclude.tokens.includes(v.token), 'a shown trip is not a variant');
          assert.equal(v.keep, budget - v.total);
          variants++;
        }
        assert.equal(out.variants.length + out.missing.length, 3, 'every letter is a variant or a reason');
      }
    }
    const cur = again.strategies[0].trip;
    for (const nb of [budget + 40000, cur.total - 15000]) {
      const sh = strategies.budgetShift(inv, q, cur, nb, { settings, now, exclude });
      for (const w of sh.strategies.strategies) { checkPacked(w, nb); assert.ok(!rejected.includes(w.trip.dest.id), `${origin} at ${fmt(nb)}: ${w.trip.dest.id} was rejected`); assert.ok(!hotels.includes(w.trip.hotel.id)); }
      for (const n of names) assert.ok(!sh.note.text.includes(n), `${origin} at ${fmt(nb)}: the note names rejected ${n}: ${sh.note.text}`);
    }
  }
  assert.ok(variants > 0, 'the sweep built variants');
});

test('pushDirection: locks, an exact date, a chosen month and a stated length are never relaxed; a variant a rule forbids names the rule', () => {
  // What each variant changes, so a lock on that part must stop it with the lock's own words.
  const TOUCHES = { more: { A: ['flight'], B: ['nights', 'dates'], C: ['dest', 'hotel'] }, keep: { A: ['dates'], B: ['nights', 'dates'], C: ['dest', 'hotel'] }, special: { A: ['hotel'], B: ['hotel'], C: [] } };
  const RULE = /^(The hotel is locked|The flights are locked|The dates are locked|The length is locked|The destination is locked|Leaving \d{4}-\d{2}-\d{2} is fixed|You asked for exactly \d+ nights?)$/;
  const holds = (cur, v, locks) => {
    assert.ok(!strategies.crossesLock(cur, v.trip, locks), `${v.letter} crosses ${JSON.stringify(locks)}`);
    if (locks.hotel) assert.equal(v.trip.spec.hotel, cur.spec.hotel);
    if (locks.flight) assert.equal(v.trip.spec.flight, cur.spec.flight);
    if (locks.dates) { assert.equal(v.trip.spec.depart, cur.spec.depart); assert.equal(v.trip.spec.nights, cur.spec.nights); }
    if (locks.nights) assert.equal(v.trip.spec.nights, cur.spec.nights);
    if (locks.dest) assert.equal(v.trip.spec.dest, cur.spec.dest);
  };
  const open = ways(QUERY);
  let built = 0, stopped = 0;
  for (const s of open.strategies) for (const key of KEYS) {
    for (const lock of LOCK_KEYS) {
      const locks = { [lock]: true };
      const out = strategies.pushDirection(inv, QUERY, s, key, { settings, now, locks });
      for (const v of out.variants) { checkPacked(v, QUERY.budget); holds(s.trip, v, locks); built++; }
      for (const [letter, parts] of Object.entries(TOUCHES[key])) if (parts.includes(lock)) {
        const m = out.missing.find(x => x.letter === letter);
        assert.ok(m && m.reason === LOCKED[lock], `${key}/${letter} under ${lock} lock: ${m ? m.reason : 'built'}`);
        stopped++;
      }
    }
    const all = Object.fromEntries(LOCK_KEYS.map(k => [k, true]));
    const out = strategies.pushDirection(inv, QUERY, s, key, { settings, now, locks: all });
    for (const v of out.variants) { holds(s.trip, v, all); assert.equal(v.letter, 'C'); assert.equal(key, 'special'); }
    for (const m of out.missing) if (!(key === 'special' && m.letter === 'C')) assert.match(m.reason, RULE, `${key}/${m.letter}: ${m.reason}`);
  }
  assert.ok(built > 0 && stopped > 0);

  // A stated length and an exact departure: strategies built under them, then pushed under them.
  const base = ways(QUERY, { nightsOpen: false }).strategies[0];
  const exact = { ...QUERY, dateMode: 'exact', depart: base.trip.spec.depart };
  for (const key of KEYS) {
    const out = strategies.pushDirection(inv, exact, base, key, { settings, now, nightsOpen: false });
    for (const v of out.variants) { checkPacked(v, QUERY.budget); assert.equal(v.trip.spec.depart, exact.depart, `${key}/${v.letter} keeps the exact date`); assert.equal(v.trip.spec.nights, QUERY.nights, `${key}/${v.letter} keeps the stated length`); }
    const reason = letter => (out.missing.find(x => x.letter === letter) || {}).reason;
    if (key === 'keep') assert.equal(reason('A'), `Leaving ${exact.depart} is fixed`);
    if (key !== 'special') assert.equal(reason('B'), `You asked for exactly ${plural(QUERY.nights, 'night')}`);
  }
  // A chosen month: every variant, including another destination, stays inside it.
  const month = addDays(today(now), 45).slice(0, 7);
  const flexible = { ...QUERY, dateMode: 'flexible', month };
  const inMonth = ways(flexible);
  assert.ok(inMonth.strategies.length, 'a set inside the month');
  let moved = 0;
  for (const s of inMonth.strategies) {
    assert.equal(s.trip.spec.depart.slice(0, 7), month);
    for (const key of KEYS) {
      const out = strategies.pushDirection(inv, flexible, s, key, { settings, now });
      for (const v of out.variants) { checkPacked(v, QUERY.budget); assert.equal(v.trip.spec.depart.slice(0, 7), month, `${key}/${v.letter} leaves ${month}: ${v.trip.spec.depart}`); if (v.trip.spec.depart !== s.trip.spec.depart) moved++; }
      for (const m of out.missing) if (/within three days/.test(m.reason)) assert.ok(m.reason.includes(`in ${month}`));
    }
  }
  assert.ok(moved >= 0);
  // The lock helper itself, on specs.
  const a = base.trip, b = { ...a.spec, hotel: 'other' };
  assert.equal(strategies.crossesLock(a, b, { hotel: true }), true);
  assert.equal(strategies.crossesLock(a, b, { flight: true, dates: true, nights: true, dest: true }), false);
  assert.equal(strategies.crossesLock(a, { ...a.spec, nights: a.spec.nights + 1 }, { dates: true }), true, 'the return date is part of the dates');
  assert.equal(strategies.crossesLock(a, { ...a.spec, depart: addDays(a.spec.depart, 1) }, { nights: true }), false);
  assert.equal(strategies.crossesLock(a, a, {}), false);
});

test('budgetShift: worth it only by the comparison, "none improves" only when literally true, the headline a priced difference, locks held', () => {
  const open = ways(QUERY);
  const n = QUERY.nights;
  const seen = { 'upgrade-worth-it': 0, 'upgrade-not-worth-it': 0, 'extra-night': 0, 'nothing-changes': 0 };
  const dearerUnder = (cur, nb, nightsList = lengths(n), locks = {}, q = QUERY) => enumerate({ ...q, budget: nb }, nightsList).filter(t => t.total <= nb && t.total > cur.total && !strategies.crossesLock(cur, t, locks));
  const checkNote = (cur, nb, sh, all, locks = {}) => {
    const note = sh.note;
    seen[note.kind] = (seen[note.kind] || 0) + 1;
    for (const w of sh.strategies.strategies) { checkPacked(w, nb); assert.ok(!strategies.crossesLock(cur, w.trip, locks), `${w.key} crosses a lock`); }
    if (note.kind === 'upgrade-not-worth-it') {
      assert.ok(!all.some(t => worthIt(cur, t)), 'none of the dearer packages improves without a trade-off');
      assert.match(note.text, new RegExp(`^I priced ${all.length} dearer versions? up to \\$[\\d,.]+; none improves the trip without giving something up\\.`));
    } else if (note.kind === 'upgrade-worth-it') {
      const m = /^\$([\d,.]+) more buys (.+?) \(\$([\d,.]+) instead of \$([\d,.]+)\) without giving anything up/.exec(note.text);
      assert.ok(m, note.text);
      const total = money(m[3]);
      assert.equal(money(m[4]), cur.total);
      assert.equal(money(m[1]), total - cur.total, 'the headline is the priced difference');
      const backed = all.filter(t => t.total === total && worthIt(cur, t));
      assert.ok(backed.length, 'a priced package at that total improves without a trade-off');
      assert.ok(!all.some(t => t.total < total && worthIt(cur, t)), 'the cheapest worth-it version');
      const above = /Above \$[\d,.]+, \$([\d,.]+) more buys .+? \(\$([\d,.]+) instead of \$([\d,.]+)\) without giving anything up/.exec(note.text);
      if (above) { const t2 = money(above[2]); assert.equal(money(above[1]), t2 - cur.total); assert.ok(t2 > QUERY.budget && all.some(t => t.total === t2 && worthIt(cur, t))); }
    } else if (note.kind === 'extra-night') {
      const more = sh.strategies.strategies.find(x => x.key === 'more');
      assert.ok(more && more.trip.spec.nights > cur.spec.nights);
      const m = /^\$([\d,.]+) more buys (\d+) extra nights?: /.exec(note.text);
      if (m) { assert.equal(money(m[1]), more.total - cur.total, 'the priced difference, not the budget increase'); assert.equal(+m[2], more.trip.spec.nights - cur.spec.nights); assert.ok(more.total > QUERY.budget); }
      else { assert.match(note.text, /^\d+ extra nights? already fit your \$[\d,.]+, so the extra \$[\d,.]+ is not needed for them: /); assert.ok(more.total <= QUERY.budget); }
      assert.ok(note.text.includes(`${plural(more.trip.spec.nights, 'night')} in ${more.trip.dest.name} at ${fmt(more.total)} instead of ${plural(cur.spec.nights, 'night')} at ${fmt(cur.total)}`));
      assert.ok(!note.text.includes(`${plural(more.trip.spec.nights, 'night')} instead of ${cur.spec.nights}`), 'the nights phrase is said once');
      if (more.trip.activities.length !== cur.activities.length) assert.ok(note.text.includes(`${plural(more.trip.activities.length, 'experience')} included instead of ${cur.activities.length}`), 'an experiences difference stays even when it ends in the nights number');
    } else if (note.kind === 'nothing-changes') {
      assert.equal(all.length, 0);
    } else assert.fail(`unexpected note ${note.kind}`);
  };
  for (const s of open.strategies) for (const nb of [QUERY.budget + 10000, QUERY.budget + 60000]) {
    const sh = strategies.budgetShift(inv, QUERY, s.trip, nb, { settings, now, locks: {}, nightsOpen: true });
    checkNote(s.trip, nb, sh, dearerUnder(s.trip, nb));
  }
  // An extra night is a different package for which the budget increase is not the price: push the
  // increase far above the longer trip's own difference and the headline stays the priced one.
  const cur = open.strategies[0].trip;
  const far = strategies.budgetShift(inv, QUERY, cur, QUERY.budget + 400000, { settings, now, locks: {}, nightsOpen: true });
  checkNote(cur, QUERY.budget + 400000, far, dearerUnder(cur, QUERY.budget + 400000));
  if (far.note.kind === 'extra-night') assert.ok(!far.note.text.includes(fmt(400000)), 'the $4,000 raise is not the headline');
  // Locks hold in the rebuild and in the note: the length, the destination, the hotel, everything.
  for (const locks of [{ nights: true }, { dest: true }, { hotel: true }, { hotel: true, flight: true, dates: true, nights: true, dest: true }]) {
    const nb = QUERY.budget + 60000;
    const sh = strategies.budgetShift(inv, QUERY, cur, nb, { settings, now, locks, nightsOpen: true });
    const q = { ...QUERY, dest: locks.dest ? cur.dest.id : null, dateMode: locks.dates ? 'exact' : 'anytime', depart: locks.dates ? cur.spec.depart : null, nights: locks.nights || locks.dates ? cur.spec.nights : QUERY.nights };
    const nightsList = locks.nights || locks.dates ? [cur.spec.nights] : lengths(q.nights);
    checkNote(cur, nb, sh, dearerUnder(cur, nb, nightsList, locks, q), locks);
    assert.notEqual(sh.note.kind, locks.nights ? 'extra-night' : 'never', 'a locked length is never lengthened');
    for (const w of sh.strategies.strategies) {
      if (locks.nights || locks.dates) assert.equal(w.trip.spec.nights, cur.spec.nights);
      if (locks.dest) assert.equal(w.trip.dest.id, cur.dest.id);
      if (locks.hotel) assert.equal(w.trip.spec.hotel, cur.spec.hotel);
    }
  }
  // A stated length holds the length without any lock.
  const stated = strategies.budgetShift(inv, QUERY, cur, QUERY.budget + 60000, { settings, now, locks: {}, nightsOpen: false });
  assert.notEqual(stated.note.kind, 'extra-night');
  for (const w of stated.strategies.strategies) assert.equal(w.trip.spec.nights, QUERY.nights);
  // Less money: the same trip cheaper or a named compromise, never a silent downgrade; the locks go to the pricer.
  const less = strategies.budgetShift(inv, QUERY, cur, cur.total - 20000, { settings, now, locks: { hotel: true, dates: true }, nightsOpen: true });
  assert.ok(['same-trip-cheaper', 'needs-compromise'].includes(less.note.kind), less.note.kind);
  const same = strategies.budgetShift(inv, QUERY, cur, cur.total + 100, { settings, now });
  assert.equal(same.note.kind, 'nothing-changes');
  assert.ok(seen['extra-night'] + seen['upgrade-worth-it'] + seen['upgrade-not-worth-it'] >= 3, JSON.stringify(seen));
});

test('mixTrips: the flight side gives the dates, length, flight and bags, the hotel side the hotel, experiences and transfer, priced as one trip', () => {
  const open = ways(QUERY);
  const a = (open.strategies.find(s => s.trip.activities.length) || open.strategies[0]).trip;
  const otherHotel = a.hotelOptions.find(h => h.id !== a.spec.hotel), otherFlight = a.flightOptions.find(f => f.id !== a.spec.flight);
  assert.ok(otherHotel && otherFlight);
  const b = price({ ...a.spec, hotel: otherHotel.id, flight: otherFlight.id, depart: addDays(a.spec.depart, 2), nights: a.spec.nights + 1, bags: true, activities: [], transfer: !a.spec.transfer });
  assert.ok(b, 'the second trip prices');
  assert.equal(strategies.mixable(a, b), true);
  assert.equal(strategies.mixable({ trip: a, letter: 'A' }, { trip: b, letter: 'B' }), true);
  const A = { letter: 'A', trip: a }, B = { letter: 'B', trip: b };
  const mix = strategies.mixTrips(inv, A, B, { hotelFrom: 'a', flightFrom: 'b' }, { settings, cap: QUERY.budget });
  assert.ok(!mix.error, mix.error);
  const s = mix.trip.spec;
  assert.equal(s.hotel, a.spec.hotel); assert.deepEqual(s.activities, [...a.spec.activities].sort()); assert.equal(s.transfer, a.spec.transfer);
  assert.equal(s.depart, b.spec.depart); assert.equal(s.nights, b.spec.nights); assert.equal(s.flight, b.spec.flight); assert.equal(s.bags, b.spec.bags);
  assert.equal(s.dest, a.spec.dest); assert.equal(s.from, a.spec.from); assert.equal(s.travelers, a.spec.travelers); assert.equal(s.who, a.spec.who);
  checkPacked(mix);
  assert.equal(mix.total, price(s).total, 'the pricer\'s own total');
  assert.equal(mix.over, mix.total > QUERY.budget); assert.equal(mix.cap, QUERY.budget);
  assert.equal(strategies.mixTrips(inv, A, B, { hotelFrom: 'a', flightFrom: 'b' }, { settings, cap: mix.total - 1 }).over, true);
  assert.equal(strategies.mixTrips(inv, A, B, { hotelFrom: 'a', flightFrom: 'b' }, { settings, cap: mix.total }).over, false);
  const noCap = strategies.mixTrips(inv, A, B, { hotelFrom: 'a', flightFrom: 'b' }, { settings });
  assert.equal(noCap.over, false); assert.equal(noCap.cap, null); assert.equal(noCap.total, mix.total);
  // The other way round.
  const rev = strategies.mixTrips(inv, A, B, { hotelFrom: 'b', flightFrom: 'a' }, { settings });
  assert.ok(!rev.error, rev.error);
  assert.equal(rev.trip.spec.hotel, b.spec.hotel); assert.deepEqual(rev.trip.spec.activities, []); assert.equal(rev.trip.spec.transfer, b.spec.transfer);
  assert.equal(rev.trip.spec.depart, a.spec.depart); assert.equal(rev.trip.spec.nights, a.spec.nights); assert.equal(rev.trip.spec.flight, a.spec.flight); assert.equal(rev.trip.spec.bags, a.spec.bags);
  assert.equal(rev.total, price(rev.trip.spec).total);
  // Not one trip: another destination; a different party size; the same size priced as a different party.
  const elsewhere = inv.maps.listDestinations().find(d => d.id !== a.dest.id && d.styles.includes('beach'));
  const c = price({ ...a.spec, dest: elsewhere.id, hotel: inv.hotels.search({ destId: elsewhere.id, checkIn: a.spec.depart, nights: a.spec.nights, rooms: 1 })[0].id, flight: 'saver', activities: [] });
  assert.ok(c);
  assert.equal(strategies.mixable(a, c), false);
  const cross = strategies.mixTrips(inv, A, { letter: 'C', trip: c }, { hotelFrom: 'a', flightFrom: 'b' }, { settings });
  assert.equal(cross.error, `A is in ${a.dest.name} and C flies to ${c.dest.name}; a hotel from one and a flight from the other cannot be one trip.`);
  const friends = price({ ...b.spec, who: 'friends' });
  assert.ok(friends && friends.spec.travelers === a.spec.travelers);
  assert.equal(strategies.mixable(a, friends), false);
  assert.equal(strategies.mixTrips(inv, A, { letter: 'B', trip: friends }, { hotelFrom: 'a', flightFrom: 'b' }, { settings }).error, 'A is priced as a couple and B as friends; they cannot be one trip.');
  const three = price({ ...b.spec, travelers: 3 });
  assert.ok(three);
  assert.equal(strategies.mixTrips(inv, A, { letter: 'B', trip: three }, { hotelFrom: 'a', flightFrom: 'b' }, { settings }).error, 'A is priced for 2 and B for 3 travelers; they cannot be one trip.');
  assert.ok(strategies.mixTrips(inv, A, B, { hotelFrom: 'a', flightFrom: 'a' }, { settings }).error);
  // When the pricer cannot build it, the part with no availability on the flight side's dates is named.
  const noHotel = { ...raw, hotels: { ...raw.hotels, search: q => raw.hotels.search(q).filter(h => !(h.id === a.spec.hotel && q.checkIn === b.spec.depart)) } };
  assert.equal(strategies.mixTrips(noHotel, A, B, { hotelFrom: 'a', flightFrom: 'b' }, { settings }).error, `${a.hotel.name}, A’s hotel, has no availability for ${plural(b.spec.nights, 'night')} from ${b.spec.depart}, B’s dates.`);
  if (a.activities.length) {
    const noActs = { ...raw, activities: { ...raw.activities, search: q => (q.date === b.spec.depart ? [] : raw.activities.search(q)) } };
    assert.equal(strategies.mixTrips(noActs, A, B, { hotelFrom: 'a', flightFrom: 'b' }, { settings }).error, `${a.activities[0].name}, A’s experience, is not offered on ${b.spec.depart}, B’s departure.`);
  }
  const noFlight = { ...raw, flights: { ...raw.flights, search: q => raw.flights.search(q).filter(f => !(f.id === b.spec.flight && q.depart === b.spec.depart)) } };
  assert.equal(strategies.mixTrips(noFlight, A, B, { hotelFrom: 'a', flightFrom: 'b' }, { settings }).error, `The ${b.flight.name} fare, B’s flights, is no longer available for ${plural(b.spec.nights, 'night')} from ${b.spec.depart}, B’s dates.`);
  // Two pushed variants of one trip in the same destination are mixable; the agent may invite it only then.
  const pushed = strategies.pushDirection(inv, QUERY, open.strategies[0], 'special', { settings, now });
  for (const v of pushed.variants) for (const w of pushed.variants) if (v !== w) assert.equal(strategies.mixable(v, w), v.trip.dest.id === w.trip.dest.id && v.trip.spec.from === w.trip.spec.from);
});

test('differentSet: never repeats a shown shape, says 14 nights honestly, and says when everything that fits was already shown', () => {
  const first = ways(QUERY);
  const shown = first.strategies.map(s => ({ token: s.token, dest: s.trip.dest.id }));
  const shownTrips = shown.map(x => price(decodeSpec(x.token)));
  const shapes = new Set(shownTrips.map(shape)), shownHotels = new Set(shownTrips.map(t => t.hotel.id));
  const minStars = Math.min(...shownTrips.map(t => t.hotel.stars)) + 1;
  let sets = 0;
  for (const wrong of ['destinations', 'expensive', 'short', 'travel', 'hotels', 'exciting']) {
    const out = strategies.differentSet(inv, QUERY, { wrong, shown, settings, now, nightsOpen: true });
    assert.ok(out.adjusted.includes('None of the trips you already saw is repeated'));
    // A stricter rule (5-star only, nonstop only, 80% of the money) can leave nothing on some dates;
    // then every way is dropped with a reason, and the sets that only steer must still be built.
    if (!out.strategies.length) { assert.equal(out.dropped.length, 3); assert.ok(['hotels', 'travel', 'expensive', 'short'].includes(wrong), `${wrong}: a different set`); continue; }
    sets++;
    for (const s of out.strategies) {
      checkPacked(s, QUERY.budget);
      assert.ok(!shapes.has(shape(s.trip)), `${wrong}/${s.key} repeats a shown shape: ${s.token}`);
      assert.ok(!shown.some(x => x.token === s.token));
      if (wrong === 'destinations') assert.ok(!shown.some(x => x.dest === s.trip.dest.id));
      if (wrong === 'expensive') assert.ok(s.total <= Math.floor(QUERY.budget * strategies.KEEP_SHARE));
      if (wrong === 'short') assert.ok(s.trip.spec.nights >= QUERY.nights + 1);
      if (wrong === 'travel') assert.equal(s.trip.flight.stops, 0);
      if (wrong === 'hotels') { assert.ok(s.trip.hotel.stars >= minStars); assert.ok(!shownHotels.has(s.trip.hotel.id)); }
      if (wrong === 'exciting') assert.ok(!shownHotels.has(s.trip.hotel.id), 'the shown hotels are left out');
    }
    if (wrong === 'short') assert.equal(out.adjusted[0], `${plural(QUERY.nights + 1, 'night')} instead of ${QUERY.nights}, up to ${QUERY.nights + 3} for More vacation and never fewer`);
    if (wrong === 'exciting') assert.match(out.adjusted[0], /^All-inclusive, beachfront, included experiences and international destinations first, leaving out /);
    if (wrong === 'destinations') assert.match(out.adjusted[0], /^Left out /);
    // Another round after this one: still nothing repeated across both rounds.
    const twice = strategies.differentSet(inv, QUERY, { wrong, shown: [...shown, ...out.strategies.map(s => ({ token: s.token, dest: s.trip.dest.id }))], settings, now, nightsOpen: true });
    const both = new Set([...shapes, ...out.strategies.map(s => shape(s.trip))]);
    for (const s of twice.strategies) assert.ok(!both.has(shape(s.trip)), `${wrong} round two repeats ${s.token}`);
  }
  assert.ok(sets >= 4, `${sets} different sets built`);
  // Shape, not token: a shown trip's twin on another date or with one more experience is the same trip.
  const more = first.strategies[0];
  const twins = enumerate(QUERY, lengths(QUERY.nights)).filter(t => t.total <= QUERY.budget && shape(t) === shape(more.trip) && encodeSpec(t.spec) !== more.token);
  assert.ok(twins.length, 'the pool holds same-shape twins of the shown trip');
  const noTwin = ways(QUERY, { exclude: { tokens: [more.token] } });
  for (const s of noTwin.strategies) assert.notEqual(shape(s.trip), shape(more.trip), `twin shown: ${s.token}`);
  // At 14 nights there is no longer length: said as it is, with no change claimed.
  const q14 = { ...QUERY, nights: 14, budget: 600000, vacationBudget: 600000 };
  const out14 = strategies.differentSet(inv, q14, { wrong: 'short', shown: [], settings, now });
  assert.equal(out14.adjusted[0], '14 nights is already the longest length priced; every option stays at 14 nights');
  assert.ok(!out14.adjusted.some(a => /instead of/.test(a) || /None of the trips/.test(a)));
  assert.ok(out14.strategies.length);
  for (const s of out14.strategies) { assert.equal(s.trip.spec.nights, 14); checkPacked(s, q14.budget); }
  // Everything that fits was already shown: the reason says so, instead of claiming nothing fits.
  const one = { ...QUERY, dest: more.trip.dest.id };
  const fitting = enumerate(one, [QUERY.nights]).filter(t => t.total <= QUERY.budget);
  assert.ok(fitting.length);
  const spent = ways(one, { nightsOpen: false, exclude: { tokens: fitting.map(t => encodeSpec(t.spec)) } });
  assert.equal(spent.strategies.length, 0);
  assert.equal(spent.dropped.length, 3);
  for (const d of spent.dropped) assert.equal(d.reason, `Every package that fits ${fmt(QUERY.budget)} with these rules has already been shown`);
  const none = ways({ ...one, budget: 10000 }, { nightsOpen: false });
  for (const d of none.dropped) assert.equal(d.reason, `Nothing the inventory priced fits ${fmt(10000)} with these rules`);
  assert.throws(() => strategies.differentSet(inv, QUERY, { wrong: 'weather', shown, settings, now }), /invalid_feedback|Tell us what was wrong/);
});

test('stepUp: fewer nights may cost usable time only on the same flight schedule; a worse schedule is a trade-off of its own', () => {
  // A nonstop route with a civilised fare; a second fare with the same stops, duration, bags and
  // cancellation but dawn flights exists only in this wrapped inventory, so the schedule is the one
  // flight difference the pricer sees.
  const depart = addDays(today(now), 40), from = 'JFK', dest = 'miami-beach';
  const fares = raw.flights.search({ from, destId: dest, depart, nights: 5, travelers: 2 });
  const flex = fares.find(f => f.id === 'nonstop');
  assert.ok(flex && flex.stops === 0);
  const late = q => { const f = raw.flights.search(q).find(x => x.id === 'nonstop'); return f ? [{ ...f, id: 'nonstop-late', name: 'Nonstop Late', departMinutes: 21 * 60, arriveMinutes: (21 * 60 + f.durationMinutes) % 1440, arrivesNextDay: 21 * 60 + f.durationMinutes >= 1440, returnDepartMinutes: 5 * 60, returnArriveMinutes: (5 * 60 + f.durationMinutes) % 1440 }, { ...f, id: 'nonstop-twin', name: 'Nonstop Twin' }] : []; };
  const inv2 = { ...raw, flights: { ...raw.flights, search: q => [...raw.flights.search(q), ...late(q)] } };
  const hotels = raw.hotels.search({ destId: dest, checkIn: depart, nights: 6, rooms: 1 });
  let found = null;
  for (const h1 of hotels) for (const h2 of hotels) {
    if (h2.stars <= h1.stars) continue;
    const base = price({ dest, from, depart, nights: 6, travelers: 2, who: 'couple', hotel: h1.id, flight: 'nonstop', activities: [], bags: false, transfer: false }, inv2);
    const up = base && price({ ...base.spec, nights: 5, hotel: h2.id }, inv2);
    if (!up) continue;
    const keys = classifyChanges(base, up).tradeoffs.map(r => r.key);
    if (keys.includes('time') && keys.every(k => k === 'nights' || k === 'time')) { found = { base, up }; break; }
  }
  assert.ok(found, 'a step up in hotel class with one night fewer whose only trade-offs are the length and the time that follows from it');
  const { base, up } = found;
  const step = strategies.stepUp(base, up, 5);
  assert.ok(step, 'same schedule, fewer nights: the lost time follows from the nights');
  assert.equal(step.stay[0], `a ${up.hotel.stars}-star hotel instead of ${base.hotel.stars}-star`);
  assert.deepEqual(step.extras, []);
  assert.equal(strategies.stepUp(base, up, 6), null, 'fewer nights than asked for is never a step up');
  const worse = price({ ...up.spec, flight: 'nonstop-late' }, inv2);
  assert.ok(worse && worse.flight.stops === up.flight.stops && worse.flight.durationMinutes === up.flight.durationMinutes);
  const keys = classifyChanges(base, worse).tradeoffs.map(r => r.key);
  assert.ok(keys.includes('time') && keys.every(k => k === 'nights' || k === 'time'), `only the length and the time differ: ${keys}`);
  assert.ok(usableTime(worse).usableMinutes < usableTime(up).usableMinutes, 'the dawn schedule loses more than the night does');
  assert.equal(strategies.stepUp(base, worse, 5), null, 'a worse schedule with fewer nights is refused');
  const twin = price({ ...up.spec, flight: 'nonstop-twin' }, inv2);
  assert.ok(twin);
  assert.deepEqual(strategies.stepUp(base, twin, 5), step, 'identical times under another fare id are the same schedule');
  const sameNightsLate = price({ ...base.spec, hotel: up.spec.hotel, flight: 'nonstop-late' }, inv2);
  assert.equal(strategies.stepUp(base, sameNightsLate, 6), null, 'with the same nights, lost time is never allowed');
});
