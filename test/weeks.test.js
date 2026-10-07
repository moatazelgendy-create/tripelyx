// WHEN CAN I GO FOR LESS? Every window is a package the pricer priced for that date (its total is
// priceTrip of its own token); every window is strong by decision.verdict and decision.compromises
// against the trip the traveler has; the current date, when searched, never loses to itself; a named
// month is searched in full and nothing outside it is offered; a locked or exactly stated departure
// is the only date priced; a pass cut off at the limit says so; the range is the lowest and highest
// of the windows priced and nothing else; weak dates carry a real reason; and the words never say
// typical, usually or predict, and their numbers are the windows' own.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { DEFAULT_SETTINGS, priceTrip, roomsFor } = require('../server/trips/pricing');
const optimizer = require('../server/trips/optimizer');
const decision = require('../server/trips/decision');
const { classifyChanges } = require('../server/trips/facts');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { addDays, today } = require('../server/lib/dates');
const { format } = require('../server/lib/money');
const weeks = require('../server/trips/weeks');

const inv = createTripIntegrations(loadConfig({ APP_ENV: 'development' }));
const settings = DEFAULT_SETTINGS;
const now = new Date();
const t0 = today(now);
const fmt = cents => format(cents, 'USD');
const QUERY = { budget: 200000, vacationBudget: 200000, keep: 0, budgetInput: 2000, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
const result = optimizer.search(inv, QUERY, { settings, now });
const trip = result.picks[0].trip;
const ctx = result.ctx;
const qctx = { ...ctx, budget: null, allowOver: 0 };
const longDate = d => new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const price = (i, spec) => priceTrip(i, spec, settings);
const grades = Object.keys(decision.GRADES);
const labels = Object.values(decision.GRADES).map(g => g.label);

// Strong, by the engine's own definitions: a great or good verdict with the budget taken out and no
// compromise of weight 2 or more that the trip the traveler has does not already carry.
function newHeavy(base, p, c = qctx) {
  const had = new Set(decision.compromises(base, c).map(x => x.text));
  return decision.compromises(p, c).filter(x => x.w >= 2 && !had.has(x.text)).map(x => x.text);
}
const isStrong = (base, p, c = qctx) => ['great', 'good'].includes(decision.verdict(p, c).grade) && newHeavy(base, p, c).length === 0;

// Every version the engine may have priced on one date for this trip: the trip's own hotel when the
// supplier has it (else the allowed hotels of its class or better) times the fares inside the rules.
function versionsOn(i, t, depart, c = ctx) {
  const s = t.spec;
  const hs = i.hotels.search({ destId: s.dest, checkIn: depart, nights: s.nights, rooms: roomsFor(s) });
  const own = hs.find(h => h.id === s.hotel);
  const hotels = own ? [own] : hs.filter(h => h.stars >= t.hotel.stars && optimizer.hotelAllowed(h, { who: s.who, style: c.style }) && optimizer.rulesAllowHotel(h, c.rules));
  const fs = i.flights.search({ from: s.from, destId: s.dest, depart, nights: s.nights, travelers: s.travelers });
  const ownF = fs.find(f => f.id === s.flight) || fs.find(f => f.name === t.flight.name) || null;
  const flights = ownF ? [ownF] : fs.filter(f => optimizer.rulesAllowFlight(f, c.rules));
  const out = [];
  for (const h of hotels) for (const f of flights) { const p = price(i, { ...s, depart, hotel: h.id, flight: f.id }); if (p) out.push(p); }
  return out;
}

function checkWindow(w, base, c = qctx, i = inv) {
  const spec = decodeSpec(w.token);
  assert.equal(w.token, encodeSpec(w.trip.spec));
  assert.equal(w.total, w.trip.total);
  assert.equal(w.total, price(i, spec).total, 'the total is the pricer\'s for this token');
  assert.equal(w.depart, spec.depart);
  assert.equal(w.ret, addDays(w.depart, spec.nights));
  assert.equal(w.nights, base.spec.nights);
  // The same trip: only the date, and with it the hotel or fare on offer that day, may differ.
  for (const k of ['dest', 'from', 'nights', 'travelers', 'who', 'bags', 'transfer']) assert.deepEqual(spec[k], base.spec[k], k);
  assert.deepEqual(spec.activities, [...base.spec.activities].sort());
  assert.equal(w.hotelChanged, spec.hotel !== base.spec.hotel);
  if (w.hotelChanged) assert.ok(w.trip.hotel.stars >= base.hotel.stars, 'a changed hotel is of the same class or better');
  assert.equal(typeof w.flightChanged, 'boolean');
  assert.equal(w.delta, w.total - base.total);
  assert.deepEqual(w.changes, classifyChanges(base, w.trip));
  assert.ok(isStrong(base, w.trip, c), `strong by the definitions: ${w.depart} ${decision.verdict(w.trip, c).grade} ${newHeavy(base, w.trip, c).join('; ')}`);
}

test('every window is a priced package of the same trip, strong, sorted, with the range read off the windows and nothing else', () => {
  const out = weeks.cheapestWeeks(inv, trip, settings, ctx, { now });
  assert.ok(out.windows.length >= 1, 'the demo prices at least one strong window');
  for (const w of out.windows) checkWindow(w, trip);
  for (let i = 1; i < out.windows.length; i++) {
    const a = out.windows[i - 1], b = out.windows[i];
    assert.ok(a.total < b.total || (a.total === b.total && a.depart <= b.depart), 'sorted by total, then date');
  }
  assert.equal(out.cheapest, out.windows[0]);
  assert.deepEqual(out.range, { min: out.cheapest.total, max: Math.max(...out.windows.map(w => w.total)), count: out.windows.length });
  // `cheaper` is the window worth moving to: strictly cheaper than the trip and not the trip itself;
  // the label exists only then, so a dearer week is never "the cheapest week found".
  assert.equal(out.cheaper, out.cheapest.total < trip.total && out.cheapest.token !== encodeSpec(trip.spec) ? out.cheapest : null);
  assert.equal(out.label, out.cheaper ? 'Cheapest strong week I found' : null);
  assert.equal(out.standard, 'strong');
  assert.equal(out.truncated, false);
  assert.equal(out.month, null);
  // The anytime set: every second day from two weeks to five months out, each searched exactly once.
  const expected = []; for (let i = 14; i <= 150; i += 2) expected.push(addDays(t0, i));
  assert.deepEqual(out.dates, expected);
  assert.equal(out.datesSearched, expected.length);
  assert.deepEqual(out.span, { from: expected[0], to: expected[expected.length - 1] });
  // Every date searched is either offered or recorded as weak, never silently dropped (the demo has
  // rooms and fares on every day), and each date appears once.
  const seen = [...out.windows.map(w => w.depart), ...out.weak.map(w => w.depart)].sort();
  assert.deepEqual(seen, expected);
  // The versions counted are the ones the pricer was asked for.
  assert.equal(out.priced, expected.reduce((n, d) => n + versionsOn(inv, trip, d).length, 0));
  // The current trip, judged as its own page judges it.
  assert.deepEqual(out.current, { depart: trip.spec.depart, ret: trip.flight.return, total: trip.total, token: encodeSpec(trip.spec), strong: ['great', 'good'].includes(decision.verdict(trip, qctx).grade), grade: decision.verdict(trip, qctx).grade, priced: true });
  // The current date is in the searched set here (the search picked it from the same windows): the
  // cheapest window is at least as cheap as the trip, and so is the window on the trip's own date.
  assert.ok(out.dates.includes(trip.spec.depart));
  assert.equal(out.current.strong, isStrong(trip, trip));
  const own = out.windows.find(w => w.depart === trip.spec.depart);
  if (out.current.strong) { assert.ok(out.cheapest.total <= trip.total); assert.ok(own && own.total <= trip.total, 'the trip\'s own date never loses to itself'); }
  else assert.ok(!own || own.token !== encodeSpec(trip.spec), 'a trip that is not strong is never offered as a strong window');
  // Each window is the cheapest strong version priced on its date, and a date is weak only when no
  // version priced on it is strong.
  for (const w of out.windows) {
    const strong = versionsOn(inv, trip, w.depart).filter(p => isStrong(trip, p));
    assert.equal(w.total, Math.min(...strong.map(p => p.total)), `cheapest strong on ${w.depart}`);
  }
  for (const w of out.weak) {
    const vs = versionsOn(inv, trip, w.depart);
    assert.ok(vs.length >= 1 && vs.every(p => !isStrong(trip, p)), `no strong version on ${w.depart}`);
    assert.equal(w.total, Math.min(...vs.map(p => p.total)), 'the cheapest total priced that day');
  }
});

test('like for like: the trip\'s own hotel and own fare are the only ones priced on a date the supplier offers them', () => {
  const out = weeks.cheapestWeeks(inv, trip, settings, ctx, { now });
  assert.ok(out.windows.length > 1);
  for (const w of out.windows) {
    assert.equal(w.hotelChanged, false, 'the demo has the hotel every day, so it is never swapped');
    assert.equal(w.trip.spec.hotel, trip.spec.hotel);
    const offered = inv.flights.search({ from: trip.spec.from, destId: trip.spec.dest, depart: w.depart, nights: trip.spec.nights, travelers: trip.spec.travelers });
    const ownF = offered.find(f => f.id === trip.spec.flight) || offered.find(f => f.name === trip.flight.name) || null;
    // A different fare never makes a week "cheaper": it stands in only when the own fare is not offered that day.
    if (ownF) { assert.equal(w.flightChanged, false); assert.equal(w.trip.spec.flight, ownF.id); } else assert.equal(w.flightChanged, true);
  }
  // Without the trip's own fare on other dates, allowed fares stand in and the swap is flagged.
  const noFare = { ...inv, flights: { ...inv.flights, search: q => { const fs = inv.flights.search(q); return q.depart === trip.spec.depart ? fs : fs.filter(f => f.id !== trip.spec.flight && f.name !== trip.flight.name); } } };
  const swapped = weeks.cheapestWeeks(noFare, trip, settings, ctx, { now });
  for (const w of swapped.windows) {
    if (w.depart === trip.spec.depart) { assert.equal(w.flightChanged, false); continue; }
    assert.equal(w.flightChanged, true);
    assert.notEqual(w.trip.spec.flight, trip.spec.flight);
    assert.ok(optimizer.rulesAllowFlight(w.trip.flight, ctx.rules));
  }
});

test('a locked hotel or locked flights the supplier does not offer that week are never swapped: the date is not offered, with the reason', () => {
  const noHotel = { ...inv, hotels: { ...inv.hotels, search: q => { const hs = inv.hotels.search(q); return q.checkIn === trip.spec.depart ? hs : hs.filter(h => h.id !== trip.spec.hotel); } } };
  const out = weeks.cheapestWeeks(noHotel, trip, settings, ctx, { now, locks: { hotel: true } });
  assert.ok(out.windows.every(w => w.depart === trip.spec.depart && w.trip.spec.hotel === trip.spec.hotel), 'only the trip\'s own date, at its own hotel');
  const locked = out.weak.filter(w => w.kind === 'lock');
  assert.ok(locked.length >= 1);
  for (const w of locked) { assert.equal(w.total, null); assert.match(w.reason, /locked hotel is not offered/); assert.notEqual(w.depart, trip.spec.depart); }
  assert.equal(out.windows.length + out.weak.length, out.datesSearched);
  const noFare = { ...inv, flights: { ...inv.flights, search: q => { const fs = inv.flights.search(q); return q.depart === trip.spec.depart ? fs : fs.filter(f => f.id !== trip.spec.flight && f.name !== trip.flight.name); } } };
  const out2 = weeks.cheapestWeeks(noFare, trip, settings, ctx, { now, locks: { flight: true } });
  assert.ok(out2.windows.every(w => w.depart === trip.spec.depart));
  assert.ok(out2.weak.some(w => w.kind === 'lock' && /locked flights/.test(w.reason)));
});

test('a named month: every day of it from a week out, nothing outside it, and the month carried for the words', () => {
  const month = addDays(t0, 45).slice(0, 7);
  const out = weeks.cheapestWeeks(inv, trip, settings, { ...ctx, month, dateMode: 'flexible' }, { now });
  const expected = []; for (let d = `${month}-01`; d.slice(0, 7) === month; d = addDays(d, 1)) if (d >= addDays(t0, 7)) expected.push(d);
  assert.deepEqual(out.dates, expected);
  assert.equal(out.datesSearched, expected.length);
  assert.equal(out.month, month);
  for (const w of [...out.windows, ...out.weak]) { assert.equal(w.depart.slice(0, 7), month); assert.ok(w.depart >= addDays(t0, 7)); }
  for (const w of out.windows) checkWindow(w, trip);
  assert.deepEqual([...out.windows.map(w => w.depart), ...out.weak.map(w => w.depart)].sort(), expected);
  // The current trip is reported whether or not its date falls in the month.
  assert.equal(out.current.depart, trip.spec.depart);
  assert.equal(out.current.total, trip.total);
  // A month with no day a week or more away prices nothing and says so, never guessing.
  const gone = weeks.cheapestWeeks(inv, trip, settings, { ...ctx, month: '2000-01', dateMode: 'flexible' }, { now });
  assert.equal(gone.datesSearched, 0); assert.equal(gone.cheapest, null); assert.equal(gone.range, null); assert.equal(gone.label, null); assert.equal(gone.truncated, false);
  const words = weeks.windowWords(gone);
  assert.equal(words.headline, null); assert.equal(words.compared, null); assert.equal(words.honesty, weeks.HONESTY);
  // A badly formed month falls back to the anytime windows rather than inventing a month.
  const bad = weeks.cheapestWeeks(inv, trip, settings, { ...ctx, month: 'June' }, { now });
  assert.equal(bad.month, null); assert.equal(bad.datesSearched, 69);
});

test('a locked or exactly stated departure is the only date priced, whatever else is asked', () => {
  for (const [c, locks] of [[ctx, { dates: true }], [{ ...ctx, dateMode: 'exact', depart: trip.spec.depart }, {}], [{ ...ctx, month: addDays(t0, 45).slice(0, 7), dateMode: 'exact' }, {}]]) {
    const out = weeks.cheapestWeeks(inv, trip, settings, c, { now, locks, dates: [addDays(t0, 20), addDays(t0, 30)] });
    assert.deepEqual(out.dates, [trip.spec.depart]);
    assert.equal(out.datesSearched, 1);
    assert.equal(out.month, null);
    for (const w of [...out.windows, ...out.weak]) assert.equal(w.depart, trip.spec.depart);
    assert.ok(out.windows.length + out.weak.length === 1);
    if (out.cheapest) { checkWindow(out.cheapest, trip); if (out.current.strong) assert.ok(out.cheapest.total <= trip.total, 'a strong trip never loses to itself on its own date'); }
    const words = weeks.windowWords(out, { fmtDate: longDate });
    assert.equal(words.compared, null, 'nothing to compare a single date with');
  }
  // A caller's own list is searched as given: valid dates only, each once, in order.
  const list = [addDays(t0, 30), addDays(t0, 20), addDays(t0, 20), 'not-a-date', addDays(t0, 40)];
  const own = weeks.cheapestWeeks(inv, trip, settings, ctx, { now, dates: list });
  assert.deepEqual(own.dates, [addDays(t0, 20), addDays(t0, 30), addDays(t0, 40)]);
  for (const w of own.windows) checkWindow(w, trip);
});

test('rules are never relaxed: fares outside the rules and hotels below the rule are never a window', () => {
  const rules = { nonstop: true, minStars: null, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false };
  // A nonstop trip under a nonstop rule: every window flies nonstop, and so does every weak version counted.
  const nonstop = trip.flightOptions.find(f => f.stops === 0);
  const nsTrip = nonstop ? price(inv, { ...trip.spec, flight: nonstop.id }) : null;
  if (nsTrip) {
    const out = weeks.cheapestWeeks(inv, nsTrip, settings, { ...ctx, rules }, { now });
    assert.equal(out.windows.length + out.weak.length, out.datesSearched);
    for (const w of out.windows) { checkWindow(w, nsTrip, { ...qctx, rules }); assert.equal(w.trip.flight.stops, 0); }
    for (const w of out.weak) { const vs = versionsOn(inv, nsTrip, w.depart, { ...ctx, rules }); assert.ok(vs.every(p => p.flight.stops === 0)); assert.equal(w.total, Math.min(...vs.map(p => p.total))); }
  }
  // A one-stop trip under a nonstop rule keeps only the fare the traveler already has: the rule is
  // never relaxed to another one-stop fare, and never used to drop the trip's own fare either.
  const oneStop = trip.flightOptions.find(f => f.stops > 0);
  const osTrip = oneStop ? price(inv, { ...trip.spec, flight: oneStop.id }) : null;
  if (osTrip) for (const w of weeks.cheapestWeeks(inv, osTrip, settings, { ...ctx, rules }, { now }).windows) assert.ok(w.trip.flight.stops === 0 || w.trip.spec.flight === osTrip.spec.flight);
  // When the supplier no longer has the trip's hotel on other dates, only allowed hotels of its class
  // or better stand in, inside a star rule and the party's needs, and the swap is flagged.
  const noHotel = { ...inv, hotels: { ...inv.hotels, search: q => { const hs = inv.hotels.search(q); return q.checkIn === trip.spec.depart ? hs : hs.filter(h => h.id !== trip.spec.hotel); } } };
  const starRules = { ...rules, nonstop: false, minStars: 4 };
  const swapped = weeks.cheapestWeeks(noHotel, trip, settings, { ...ctx, rules: starRules }, { now });
  const sctx = { ...qctx, rules: starRules };
  const offered = new Set(swapped.windows.map(w => w.depart));
  for (const d of swapped.dates) assert.equal(offered.has(d), versionsOn(noHotel, trip, d, { ...ctx, rules: starRules }).some(p => isStrong(trip, p, sctx)), `${d} is offered exactly when a strong version inside the rules exists`);
  for (const w of swapped.windows) {
    checkWindow(w, trip, { ...qctx, rules: starRules }, noHotel);
    if (w.depart === trip.spec.depart) { assert.equal(w.hotelChanged, false); assert.equal(w.trip.spec.hotel, trip.spec.hotel); }
    else { assert.equal(w.hotelChanged, true); assert.ok(w.trip.hotel.stars >= 4 && w.trip.hotel.stars >= trip.hotel.stars); assert.ok(optimizer.hotelAllowed(w.trip.hotel, { who: trip.spec.who, style: ctx.style })); }
    const vs = versionsOn(noHotel, trip, w.depart, { ...ctx, rules: starRules }).filter(p => isStrong(trip, p, { ...qctx, rules: starRules }));
    assert.equal(w.total, Math.min(...vs.map(p => p.total)));
  }
  // A family never gets an adults-only room standing in for its hotel.
  const famTrip = price(inv, { ...trip.spec, who: 'family', travelers: 4 });
  assert.ok(famTrip);
  const fam = weeks.cheapestWeeks(noHotel, famTrip, settings, ctx, { now });
  for (const w of fam.windows) { assert.equal(w.trip.hotel.features.adultsOnly, false); checkWindow(w, famTrip, qctx, noHotel); }
});

test('truncation: a tiny limit cuts the pass off and says so; the ordinary pass is not cut off and never says so', () => {
  const one = weeks.cheapestWeeks(inv, trip, settings, ctx, { now, limit: 1 });
  assert.equal(one.truncated, true);
  assert.ok(one.priced <= 1);
  assert.equal(weeks.windowWords(one).partial, weeks.PARTIAL);
  // A limit that covers exactly the first date: that date is kept, the next is cut off, and only
  // dates priced in full are counted or offered.
  const first = addDays(t0, 14);
  const n = versionsOn(inv, trip, first).length;
  const some = weeks.cheapestWeeks(inv, trip, settings, ctx, { now, limit: n });
  assert.equal(some.truncated, true);
  assert.equal(some.priced, n);
  assert.equal(some.datesSearched, 1);
  assert.deepEqual(some.dates, [first]);
  for (const w of [...some.windows, ...some.weak]) assert.equal(w.depart, first);
  for (const w of some.windows) checkWindow(w, trip);
  // A partly priced date is dropped rather than offered as "cheapest strong" when it was not established:
  // without the trip's hotel on later dates, several stand-ins are priced there, and a limit that covers
  // the first date plus one of them cuts the second date off unfinished.
  const twins = { ...inv, hotels: { ...inv.hotels, search: q => { const hs = inv.hotels.search(q); const own = hs.find(h => h.id === trip.spec.hotel); return q.checkIn === first ? hs : [...hs.filter(h => h.id !== own.id), ...Array.from({ length: 3 }, (_, i) => ({ ...own, id: `${own.id}-twin${i}`, name: `${own.name} twin ${i}` }))]; } } };
  const part = weeks.cheapestWeeks(twins, trip, settings, ctx, { now, limit: n + 1 });
  assert.equal(part.truncated, true); assert.equal(part.datesSearched, 1); assert.equal(part.priced, n + 1);
  const full = weeks.cheapestWeeks(inv, trip, settings, ctx, { now });
  assert.equal(full.truncated, false);
  assert.equal(weeks.windowWords(full).partial, null);
  assert.ok(full.priced <= weeks.MAX_PRICED);
  // The default limit is the same discipline as the other engines, and is reported honestly when hit.
  const many = { ...inv, hotels: { ...inv.hotels, search: q => { const hs = inv.hotels.search(q); const own = hs.find(h => h.id === trip.spec.hotel); return q.checkIn === trip.spec.depart ? hs : [...hs.filter(h => h.id !== own.id), ...Array.from({ length: 300 }, (_, i) => ({ ...own, id: `${own.id}-twin${i}`, name: `${own.name} twin ${i}` }))]; } } };
  const big = weeks.cheapestWeeks(many, trip, settings, ctx, { now });
  assert.equal(big.truncated, true);
  assert.equal(big.priced, weeks.MAX_PRICED);
  assert.ok(big.datesSearched < 69);
  for (const w of big.windows) checkWindow(w, trip, qctx, many);
});

test('weak dates: searched, counted, and carrying the cheapest total priced that day with a real reason', () => {
  // Other dates only have the Basic fare: every one of them is weak with that new compromise named.
  const basicOnly = { ...inv, flights: { ...inv.flights, search: q => { const fs = inv.flights.search(q); return q.depart === trip.spec.depart ? fs : fs.filter(f => f.id === 'basic'); } } };
  const base = trip.spec.flight === 'basic' ? price(inv, { ...trip.spec, flight: trip.flightOptions.find(f => f.id !== 'basic').id }) : trip;
  assert.ok(base && base.spec.flight !== 'basic');
  const out = weeks.cheapestWeeks(basicOnly, base, settings, ctx, { now });
  assert.ok(out.windows.length <= 1 && out.windows.every(w => w.depart === base.spec.depart), 'no other date has a strong version');
  assert.equal(out.weak.length, out.datesSearched - out.windows.length);
  for (const w of out.weak.filter(x => x.depart !== base.spec.depart)) {
    assert.equal(w.kind, 'compromise');
    assert.equal(w.reason, 'a Basic fare: personal item only, no changes');
    const vs = versionsOn(basicOnly, base, w.depart);
    assert.equal(w.total, Math.min(...vs.map(p => p.total)));
    assert.ok(vs.some(p => decision.compromises(p, qctx).some(c => c.text === w.reason && c.w >= 2)), 'a compromise a version priced that day really carries');
    assert.ok(!decision.compromises(base, qctx).some(c => c.text === w.reason), 'and one the current trip does not carry');
  }
  if (out.cheapest) {
    const words = weeks.windowWords(out, { fmtDate: longDate });
    assert.equal(words.compared, null, 'one window: nothing priced to compare it with');
    assert.equal(words.headline, `${longDate(out.cheapest.depart)} – ${longDate(out.cheapest.ret)} at ${fmt(out.cheapest.total)}`);
  }
  // Weak for the grade alone (no new compromise): the reason is the grade's own label and the key is carried.
  const plain = weeks.cheapestWeeks(inv, trip, settings, ctx, { now });
  for (const w of plain.weak) {
    assert.ok(['compromise', 'grade'].includes(w.kind));
    assert.ok(grades.includes(w.grade));
    const vs = versionsOn(inv, trip, w.depart);
    if (w.kind === 'grade') { assert.equal(w.reason, decision.GRADES[w.grade].label); assert.ok(labels.includes(w.reason)); assert.ok(vs.some(p => decision.verdict(p, qctx).grade === w.grade && newHeavy(trip, p).length === 0)); }
    else assert.ok(vs.some(p => newHeavy(trip, p).includes(w.reason)));
    assert.equal(w.total, Math.min(...vs.map(p => p.total)));
  }
  // A trip that is itself not strong (a compromise it already carries) sets the standard: like for
  // like, a window must be graded at least as well as the trip. With its date locked the only
  // window is its own version, nothing is cheaper, and there is no label and no headline to give.
  const aiCtx = { ...ctx, style: 'all-inclusive' };
  const plainHotel = trip.hotelOptions.find(h => !h.features.allInclusive);
  const plainTrip = price(inv, { ...trip.spec, hotel: plainHotel.id });
  assert.ok(plainTrip && !plainTrip.hotel.features.allInclusive);
  const ai = weeks.cheapestWeeks(inv, plainTrip, settings, aiCtx, { now, locks: { dates: true } });
  assert.equal(ai.current.strong, false); assert.equal(ai.current.grade, 'budget'); assert.equal(ai.standard, 'comparable');
  assert.ok(ai.windows.length <= 1 && ai.windows.every(w => w.depart === plainTrip.spec.depart && w.total <= plainTrip.total));
  assert.equal(ai.cheaper, ai.windows[0] && ai.windows[0].total < plainTrip.total ? ai.windows[0] : null);
  assert.equal(ai.label, ai.cheaper ? 'Cheapest comparable week I found' : null);
  assert.equal(ai.weak.length, 1 - ai.windows.length);
  if (!ai.cheaper) assert.ok(!ai.windows.length || ai.windows[0].token === encodeSpec(plainTrip.spec));
});

test('a trip graded below good is compared like for like: every window is graded at least as well, never called strong, and "cheaper" only when it really is', () => {
  const aiCtx = { ...ctx, style: 'all-inclusive' };
  const plainHotel = trip.hotelOptions.find(h => !h.features.allInclusive);
  const plainTrip = price(inv, { ...trip.spec, hotel: plainHotel.id });
  const aiq = { ...aiCtx, budget: null, allowOver: 0 };
  assert.equal(decision.verdict(plainTrip, aiq).grade, 'budget');
  const out = weeks.cheapestWeeks(inv, plainTrip, settings, aiCtx, { now });
  assert.equal(out.standard, 'comparable');
  assert.equal(out.current.strong, false);
  assert.ok(out.windows.length >= 1, 'other dates price the same kind of trip');
  const rank = { look: 0, budget: 1, good: 2, great: 3 };
  for (const w of out.windows) {
    assert.ok(rank[decision.verdict(w.trip, aiq).grade] >= rank.budget, 'never below the trip\'s own grade');
    assert.equal(newHeavy(plainTrip, w.trip).length, 0, 'no new compromise of weight 2 or more');
  }
  assert.ok(out.dates.includes(plainTrip.spec.depart), 'the trip competes on its own date');
  const own = out.windows.find(w => w.depart === plainTrip.spec.depart);
  assert.ok(own && own.total <= plainTrip.total, 'its own date never loses to itself');
  assert.equal(out.cheapest, out.windows[0]);
  if (out.cheapest.total < plainTrip.total && out.cheapest.token !== encodeSpec(plainTrip.spec)) { assert.equal(out.cheaper, out.cheapest); assert.equal(out.label, 'Cheapest comparable week I found'); }
  else { assert.equal(out.cheaper, null); assert.equal(out.label, null); }
  assert.ok(!/strong/.test(out.label || ''), 'never "strong" against a trip that is not');
});

test('the trip\'s own departure is always priced while it is ahead, whatever day the question is asked, so a dearer week is never the cheapest found', () => {
  // Asked a day (and three days) after the trip was built, the grid from today no longer lands on
  // the trip's date; the date is added anyway, in anytime and in month mode, and never twice.
  for (const shift of [1, 3]) {
    const later = new Date(now.getTime() + shift * 86400000);
    const dates = weeks.windowDates(trip, ctx, { now: later });
    assert.ok(dates.includes(trip.spec.depart), `shift ${shift}: own date present`);
    assert.equal(new Set(dates).size, dates.length, 'no date twice');
    assert.deepEqual(dates, [...dates].sort(), 'sorted');
    const out = weeks.cheapestWeeks(inv, trip, settings, ctx, { now: later });
    assert.equal(out.current.priced, true);
    if (out.current.strong) {
      const own = out.windows.find(w => w.depart === trip.spec.depart);
      assert.ok(own && own.total <= trip.total, 'the trip never loses to itself on its own date');
      assert.ok(!out.cheaper || out.cheaper.total < trip.total, 'cheaper means cheaper');
      assert.ok(!out.label || out.cheaper, 'a label only with something cheaper');
    }
    const month = trip.spec.depart.slice(0, 7);
    const inMonth = weeks.windowDates(trip, { ...ctx, month }, { now: later });
    assert.ok(inMonth.includes(trip.spec.depart) && inMonth.every(d => d.slice(0, 7) === month));
    const other = `${Number(month.slice(0, 4)) + 1}-${month.slice(5)}`;
    assert.ok(!weeks.windowDates(trip, { ...ctx, month: other }, { now: later }).includes(trip.spec.depart), 'a month the trip is not in does not get its date');
  }
  // A departure already behind us is not added: nothing is priced in the past.
  const past = { ...trip, spec: { ...trip.spec, depart: addDays(t0, -2) } };
  assert.ok(!weeks.windowDates(past, ctx, { now }).includes(past.spec.depart));
});

test('windowWords: the cheapest window\'s own dates and price, the other windows\' range and count, and the honesty line; never typical, usually or predict', () => {
  const forbidden = /typical|usually|predict/i;
  const amounts = text => (text.match(/\$[\d,]+(?:\.\d{2})?/g) || []);
  for (const c of [ctx, { ...ctx, month: addDays(t0, 45).slice(0, 7), dateMode: 'flexible' }]) {
    const out = weeks.cheapestWeeks(inv, trip, settings, c, { now });
    for (const fmtDate of [undefined, longDate]) {
      const w = weeks.windowWords(out, fmtDate ? { fmtDate } : undefined);
      const f = fmtDate || (d => d);
      const sep = fmtDate ? ' – ' : '–';
      assert.equal(w.headline, `${f(out.cheapest.depart)}${sep}${f(out.cheapest.ret)} at ${fmt(out.cheapest.total)}`);
      const others = out.windows.filter(x => x.depart !== out.cheapest.depart);
      if (!others.length) { assert.equal(w.compared, null); continue; }
      const lo = Math.min(...others.map(x => x.total)), hi = Math.max(...others.map(x => x.total));
      const range = lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
      if (c.month) {
        const name = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${c.month}-01T00:00:00Z`));
        assert.equal(w.compared, `Compared with the ${others.length} other ${name} window${others.length === 1 ? '' : 's'} I priced and would recommend for this trip: ${range}`);
      } else {
        assert.equal(w.compared, `Compared with the ${others.length} other window${others.length === 1 ? '' : 's'} I priced and would recommend for this trip between ${f(out.span.from)} and ${f(out.span.to)}: ${range}`);
      }
      assert.equal(w.honesty, 'Today\'s prices for those dates, not a forecast; dates I did not price are not covered');
      assert.equal(w.partial, null);
      for (const text of [w.headline, w.compared]) assert.doesNotMatch(text, /typical|usually|predict|forecast/i);
      assert.doesNotMatch(w.honesty, forbidden);
      assert.equal((w.honesty.match(/forecast/g) || []).length, 1);
      assert.match(w.honesty, /not a forecast/);
      // Every number spoken is a window's total, and the range is the min and max of the others.
      const totals = new Set(out.windows.map(x => fmt(x.total)));
      const spoken = [...amounts(w.headline), ...amounts(w.compared)];
      assert.ok(spoken.length >= 2);
      for (const a of spoken) assert.ok(totals.has(a), `${a} is a window's total`);
      assert.deepEqual(amounts(w.compared), lo === hi ? [fmt(lo)] : [fmt(lo), fmt(hi)], 'the range is the lowest and highest of the other windows');
    }
  }
  // The label itself claims nothing beyond what it is.
  assert.equal(weeks.LABEL, 'Cheapest strong week I found');
  assert.doesNotMatch(weeks.LABEL + weeks.HONESTY + weeks.PARTIAL, forbidden);
});
