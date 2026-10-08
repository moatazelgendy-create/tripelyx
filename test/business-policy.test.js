// The Business policy engine (plan §E, Stage 1P): normalizePolicy and its form round trip, the benchmark with
// outliers removed, every evaluate rule within and out with exact limits, the haul threshold, caps, overrides,
// advance days in the company's time zone, roll-up and block mode, the budget check, Price to Beat, describe()
// and the limits bar, and purity (frozen inputs, no clock).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tz = require('../server/business/tz');
const schema = require('../server/business/policy/schema');
const evaluate = require('../server/business/policy/evaluate');
const bench = require('../server/business/policy/benchmark');
const describeMod = require('../server/business/policy/describe');
const { createPolicyEngine, POLICY_ENGINE_METHODS } = require('../server/business/policy');
const { defaultPolicy, DEFAULT_POLICIES } = require('../server/business/policy/defaults');
const { AppError } = require('../server/lib/errors');
const money = require('../server/lib/money');
const fx = require('./fixtures/business-rows');

const { flight, hotel, ctx, deepFreeze } = fx;
const { evaluateComponent, evaluateTrip, flightCap, hotelCap, priceToBeat, RULE_IDS } = evaluate;
// The experience engine's list (test/experience-pages.test.js:49).
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const REFS = { airports: ['CAI', 'LHR', 'DXB', 'IST'], carriers: ['ZM', 'ZS', 'ZG'], countries: ['United Arab Emirates', 'United Kingdom', 'France', 'Germany', 'Italy', 'Türkiye', 'Greece', 'Saudi Arabia', 'Egypt'] };

/** Standard rules with a fixed short-haul cap, so a flight's limit is exact. */
function fixedRules(cents = 50000) {
  const r = defaultPolicy('standard');
  r.flights.shortHaul.cap = { mode: 'fixed', amountCents: cents };
  r.flights.shortHaul.minAdvanceDays = 0;
  r.flights.longHaul.minAdvanceDays = 0;
  return r;
}
const pick = (e, rule) => e.violations.filter(v => v.rule === rule).map(v => ({ rule: v.rule, limit: v.limit, actual: v.actual, severity: v.severity, component: v.component }));
const rules = e => e.violations.map(v => v.rule);

// ---------------------------------------------------------------------------------------------------------
// Benchmark

test('benchmark: fewer than 3 values give no median; 3 the plain median; 4+ drop outliers (integer math)', () => {
  for (const values of [[], [100], [100, 110]]) assert.deepEqual(bench.benchmark(values), { medianCents: null, sampleSize: values.length, excluded: [] });
  assert.deepEqual(bench.benchmark([120, 100, 110]), { medianCents: 110, sampleSize: 3, excluded: [] });
  assert.deepEqual(bench.benchmark([300, 310, 320, 330, 2000]), { medianCents: 315, sampleSize: 4, excluded: [2000] });
  assert.deepEqual(bench.benchmark([100, 110, 120, 130, 1000]), { medianCents: 115, sampleSize: 4, excluded: [1000] });
  assert.deepEqual(bench.benchmark([500, 500, 500, 500, 500]), { medianCents: 500, sampleSize: 5, excluded: [] });
  // Even counts floor the mean of the middle two.
  assert.equal(bench.benchmark([100, 101, 102, 104]).medianCents, 101);
  assert.equal(bench.benchmark([1, 2, 3, 4, 5, 6]).medianCents, 3);
  // A low outlier too, and both at once.
  assert.deepEqual(bench.benchmark([5, 300, 310, 320, 330]), { medianCents: 315, sampleSize: 4, excluded: [5] });
  assert.deepEqual(bench.benchmark([1, 300, 305, 310, 315, 320, 9999]), { medianCents: 310, sampleSize: 5, excluded: [1, 9999] });
  // Not mutated, order-free, and stray values left out before counting.
  const values = deepFreeze([330, 2000, 300, 320, 310]);
  assert.deepEqual(bench.benchmark(values), bench.benchmark([300, 310, 320, 330, 2000]));
  assert.deepEqual(bench.benchmark([100, null, 110, NaN, 1.5, -3, 120]), { medianCents: 110, sampleSize: 3, excluded: [] });
  assert.ok(Number.isInteger(bench.benchmark([101, 102, 103, 104, 105, 106]).medianCents));
});

test('benchmark values: one per itinerary or hotel, the cheapest available, on the hotel cap basis', () => {
  const rows = [
    flight({ n: 1, fare: 'LIGHT', totalCents: 44200 }), flight({ n: 1, fare: 'FLEX', totalCents: 70000 }),
    flight({ n: 2, fare: 'CLASSIC', totalCents: 50000 }), flight({ n: 2, fare: 'LIGHT', totalCents: 41000 }),
    flight({ n: 3, fare: 'LIGHT', available: false }),
  ];
  assert.deepEqual(bench.flightValues(rows), [41000, 44200]);
  const hotels = [
    hotel({ n: 1, nightlyCents: 20000 }), hotel({ n: 1, room: 'DLX', nightlyCents: 26000 }), hotel({ n: 2, nightlyCents: 30000, available: false }),
    hotel({ n: 3, nightlyCents: 10000, taxPercent: 10 }),
  ];
  assert.deepEqual(bench.hotelValues(hotels, 'incl_taxes'), [11000, 22800]);
  assert.deepEqual(bench.hotelValues(hotels, 'excl_taxes'), [10000, 20000]);
  assert.throws(() => bench.hotelValues(hotels, 'gross'), TypeError);
});

// ---------------------------------------------------------------------------------------------------------
// Flight caps

test('flight haul: 359 flying minutes is short haul, 360 and 361 long haul', () => {
  const r = defaultPolicy('standard');
  assert.equal(flightCap(r, flight({ minutes: 359 }), null).haul, 'short');
  assert.equal(flightCap(r, flight({ minutes: 360 }), null).haul, 'long');
  assert.equal(flightCap(r, flight({ minutes: 361 }), null).haul, 'long');
  // Layovers do not count: two segments of 170 and 170 minutes with a long connection are 340 flying minutes.
  assert.equal(flightCap(r, flight({ minutes: 340, stops: 1, layover: 300 }), null).haul, 'short');
  // The cabin rule follows the band: Premium economy is above Economy at 359, within Premium at 360.
  const c = ctx(fixedRules(999999));
  assert.deepEqual(pick(evaluateComponent(flight({ minutes: 359, cabin: 'premium' }), c), 'flight.cabin'), [{ rule: 'flight.cabin', limit: 'economy', actual: 'premium', severity: 'approval', component: 'out' }]);
  assert.deepEqual(rules(evaluateComponent(flight({ minutes: 360, cabin: 'premium' }), c)), []);
});

test('flight caps: fixed, median_pct (floored), median_plus, fallback below 3 fares, none', () => {
  const r = defaultPolicy('standard');
  const row = flight({ totalCents: 70000 });
  const median = { medianCents: 59335, sampleSize: 5, excluded: [] };
  // median_pct 20%: 59335 + floor(59335 × 200 / 1000) = 59335 + 11867 = 71202.
  assert.deepEqual(flightCap(r, row, median), { cents: 71202, source: 'median_pct', haul: 'short', medianCents: 59335 });
  r.flights.shortHaul.cap = { mode: 'median_pct', pctTenths: 75, fallbackCents: 60000 };
  // 7.5%: floor(59335 × 75 / 1000) = floor(4450.125) = 4450.
  assert.equal(flightCap(r, row, median).cents, 63785);
  assert.deepEqual(flightCap(r, row, { medianCents: null, sampleSize: 2, excluded: [] }), { cents: 60000, source: 'fallback', haul: 'short', medianCents: null });
  assert.deepEqual(flightCap(r, row, null), { cents: 60000, source: 'fallback', haul: 'short', medianCents: null });
  r.flights.shortHaul.cap = { mode: 'median_plus', amountCents: 5000, fallbackCents: 55000 };
  assert.deepEqual(flightCap(r, row, median), { cents: 64335, source: 'median_plus', haul: 'short', medianCents: 59335 });
  assert.equal(flightCap(r, row, null).source, 'fallback');
  r.flights.shortHaul.cap = { mode: 'fixed', amountCents: 50000 };
  assert.deepEqual(flightCap(r, row, median), { cents: 50000, source: 'fixed', haul: 'short', medianCents: 59335 });
  r.flights.shortHaul.cap = { mode: 'none' };
  assert.deepEqual(flightCap(r, row, median), { cents: null, source: 'none', haul: 'short', medianCents: 59335 });
  assert.deepEqual(rules(evaluateComponent(flight({ totalCents: 9999999 }), ctx(r))), [], 'no cap, no flight.cap violation');
});

test('flight.cap: the cap is within, a cent over is out, with exact limit, actual and overCents', () => {
  const c = ctx(fixedRules(50000));
  const at = evaluateComponent(flight({ totalCents: 50000 }), c);
  assert.equal(at.status, 'within');
  assert.deepEqual(at.violations, []);
  assert.deepEqual(at.cap, { cents: 50000, source: 'fixed', haul: 'short' });
  assert.equal(at.overCents, 0);
  const over = evaluateComponent(flight({ totalCents: 50001 }), c);
  assert.equal(over.status, 'out');
  assert.deepEqual(pick(over, 'flight.cap'), [{ rule: 'flight.cap', limit: 50000, actual: 50001, severity: 'approval', component: 'out' }]);
  assert.equal(over.overCents, 1);
  assert.equal(over.violations[0].text, 'Over your $500 limit by $0.01.');
  // Amounts read exactly as lib/money.format writes them.
  for (const [cap, price] of [[1, 2], [99, 199], [100000, 123456], [123456789, 123456790], [50, 150]]) {
    const e = evaluateComponent(flight({ totalCents: price }), ctx(fixedRules(cap)));
    assert.equal(e.violations[0].text, `Over your ${money.format(cap)} limit by ${money.format(price - cap)}.`);
  }
  // The median text names where the cap comes from.
  const r = defaultPolicy('standard');
  r.flights.shortHaul.minAdvanceDays = 0;
  const e = evaluateComponent(flight({ totalCents: 79800 }), ctx(r, { benchmarks: { out: { medianCents: 59335, sampleSize: 5, excluded: [] } } }));
  assert.equal(e.violations[0].text, 'Over your $712.02 limit by $85.98 (median of these demo fares plus 20%).');
  const fb = evaluateComponent(flight({ totalCents: 61000 }), ctx(r));
  assert.match(fb.violations[0].text, /^Over your \$600 limit by \$10 \(your set limit, as this search has too few demo fares to compare\)\.$/);
});

test('route overrides: the first match beats the band, bothWays matches the reverse, maxCabin null keeps the band cabin', () => {
  const r = fixedRules(50000);
  r.flights.routeOverrides = [
    { from: 'CAI', to: 'LHR', bothWays: true, cap: { mode: 'fixed', amountCents: 90000 }, maxCabin: 'business' },
    { from: 'CAI', to: 'DXB', bothWays: false, cap: { mode: 'fixed', amountCents: 20000 }, maxCabin: null },
    { from: 'LHR', to: 'CAI', bothWays: false, cap: { mode: 'fixed', amountCents: 10000 }, maxCabin: null },
  ];
  const c = ctx(r);
  assert.deepEqual(flightCap(r, flight({ totalCents: 80000 }), null), { cents: 90000, source: 'route', haul: 'short', medianCents: null });
  // The reverse direction matches the first (bothWays) override, not the later one-way LHR-CAI row.
  assert.equal(flightCap(r, flight({ leg: 'back', totalCents: 80000 }), null).cents, 90000);
  const biz = evaluateComponent(flight({ cabin: 'business', totalCents: 80000 }), c);
  assert.deepEqual(rules(biz), [], 'business class and $800 are fine on CAI-LHR');
  // One way only: DXB to CAI falls back to the band; CAI to DXB uses the override's cap and the band's cabin.
  assert.equal(flightCap(r, flight({ from: 'DXB', to: 'CAI', minutes: 225, totalCents: 30000 }), null).source, 'fixed');
  const dxb = evaluateComponent(flight({ to: 'DXB', minutes: 225, cabin: 'premium', totalCents: 30000 }), c);
  assert.deepEqual(rules(dxb), ['flight.cap', 'flight.cabin']);
  assert.equal(dxb.violations[0].limit, 20000);
  assert.equal(dxb.violations[0].text, 'Over your $200 limit for this route by $100.');
  assert.equal(dxb.violations[1].text, 'Premium economy is above your limit (Economy) for flights under 6 hours.');
  // An override with mode none removes the price limit on that route only.
  r.flights.routeOverrides = [{ from: 'CAI', to: 'LHR', bothWays: false, cap: { mode: 'none' }, maxCabin: null }];
  assert.deepEqual(rules(evaluateComponent(flight({ totalCents: 900000 }), ctx(r))), []);
  // A route override's median cap uses the same leg benchmark.
  r.flights.routeOverrides = [{ from: 'CAI', to: 'LHR', bothWays: false, cap: { mode: 'median_plus', amountCents: 10000, fallbackCents: 70000 }, maxCabin: null }];
  assert.equal(flightCap(r, flight(), { medianCents: 45000, sampleSize: 4, excluded: [] }).cents, 55000);
});

test('flight.cabin: every cabin pair, economy < premium < business', () => {
  for (const [max, cabin, out] of [
    ['economy', 'economy', false], ['economy', 'premium', true], ['economy', 'business', true],
    ['premium', 'economy', false], ['premium', 'premium', false], ['premium', 'business', true],
    ['business', 'economy', false], ['business', 'premium', false], ['business', 'business', false],
  ]) {
    const r = fixedRules(9999999);
    r.flights.shortHaul.maxCabin = max;
    const e = evaluateComponent(flight({ cabin }), ctx(r));
    assert.deepEqual(pick(e, 'flight.cabin'), out ? [{ rule: 'flight.cabin', limit: max, actual: cabin, severity: 'approval', component: 'out' }] : [], `${max} ${cabin}`);
  }
  const r = fixedRules(9999999);
  const text = evaluateComponent(flight({ cabin: 'business' }), ctx(r)).violations[0].text;
  assert.equal(text, 'Business class is above your limit (Economy) for flights under 6 hours.');
  r.flights.longHaul.maxCabin = 'premium';
  assert.equal(evaluateComponent(flight({ cabin: 'business', minutes: 430 }), ctx(r)).violations.find(v => v.rule === 'flight.cabin').text,
    'Business class is above your limit (Premium economy) for flights of 6 hours or more.');
});

test('flight.advance and hotel.advance: min − 1 is out, min and min + 1 within, on the company time zone date', () => {
  const r = defaultPolicy('standard'); // short haul: 7 days ahead
  r.flights.shortHaul.cap = { mode: 'none' };
  for (const [date, days, out] of [['2026-10-15', 6, true], ['2026-10-16', 7, false], ['2026-10-17', 8, false]]) {
    const e = evaluateComponent(flight({ date }), ctx(r));
    assert.deepEqual(pick(e, 'flight.advance'), out ? [{ rule: 'flight.advance', limit: 7, actual: days, severity: 'approval', component: 'out' }] : [], date);
  }
  assert.equal(evaluateComponent(flight({ date: '2026-10-12' }), ctx(r)).violations[0].text, 'Planned 3 days ahead. Your policy asks for 7.');
  assert.equal(evaluateComponent(flight({ date: '2026-10-10' }), ctx(r)).violations[0].text, 'Planned 1 day ahead. Your policy asks for 7.');
  assert.equal(evaluateComponent(flight({ date: '2026-10-09' }), ctx(r)).violations[0].text, 'Planned for the same day. Your policy asks for 7.');
  // A date already past is never "the same day".
  assert.deepEqual(pick(evaluateComponent(flight({ date: '2026-10-01' }), ctx(r)), 'flight.advance'), [{ rule: 'flight.advance', limit: 7, actual: -8, severity: 'approval', component: 'out' }]);
  assert.equal(evaluateComponent(flight({ date: '2026-10-01' }), ctx(r)).violations[0].text, 'This date has already passed. Your policy asks for 7 days ahead.');
  assert.equal(evaluateComponent(flight({ date: '2026-10-08' }), ctx({ ...r, flights: { ...r.flights, shortHaul: { ...r.flights.shortHaul, minAdvanceDays: 1 } } })).violations[0].text,
    'This date has already passed. Your policy asks for 1 day ahead.');
  // In Africa/Cairo (UTC+3 on these dates): 23:30 local on 9 Oct and 00:30 local on 10 Oct are both 9 Oct in UTC.
  const lateEvening = tz.localToUtc('Africa/Cairo', '2026-10-09T23:30');
  const afterMidnight = tz.localToUtc('Africa/Cairo', '2026-10-10T00:30');
  assert.equal(lateEvening.toISOString().slice(0, 10), '2026-10-09');
  assert.equal(afterMidnight.toISOString().slice(0, 10), '2026-10-09', 'the UTC date is still the 9th');
  const today = when => tz.localDate('Africa/Cairo', when);
  assert.deepEqual([today(lateEvening), today(afterMidnight)], ['2026-10-09', '2026-10-10']);
  const leave = flight({ date: '2026-10-16' });
  assert.deepEqual(rules(evaluateComponent(leave, ctx(r, { today: today(lateEvening) }))), [], '7 days ahead at 23:30 on the 9th');
  assert.deepEqual(pick(evaluateComponent(leave, ctx(r, { today: today(afterMidnight) })), 'flight.advance').map(v => v.actual), [6], '6 days ahead at 00:30 on the 10th');
  // Hotels count from checkIn.
  const h = defaultPolicy('standard');
  h.hotels.minAdvanceDays = 3;
  h.hotels.countryCaps = [];
  h.hotels.defaultNightlyCents = null;
  for (const [checkIn, days, out] of [['2026-10-11', 2, true], ['2026-10-12', 3, false], ['2026-10-13', 4, false]]) {
    assert.deepEqual(pick(evaluateComponent(hotel({ checkIn }), ctx(h)), 'hotel.advance'), out ? [{ rule: 'hotel.advance', limit: 3, actual: days, severity: 'approval', component: 'hotel' }] : [], checkIn);
  }
});

test('flight.stops: null allows any, 0 nonstop only, 1 up to one stop', () => {
  for (const [max, stops, out] of [[null, 0, false], [null, 1, false], [0, 0, false], [0, 1, true], [1, 0, false], [1, 1, false]]) {
    const r = fixedRules(9999999);
    r.flights.shortHaul.maxStops = max;
    const e = evaluateComponent(flight({ stops, minutes: 300 }), ctx(r));
    assert.deepEqual(pick(e, 'flight.stops'), out ? [{ rule: 'flight.stops', limit: max, actual: stops, severity: 'approval', component: 'out' }] : [], `${max} ${stops}`);
  }
  const r = fixedRules(9999999);
  r.flights.shortHaul.maxStops = 0;
  assert.equal(evaluateComponent(flight({ stops: 1 }), ctx(r)).violations[0].text, '1 stop. Your policy allows nonstop only.');
});

test('flight.refundable: a 0% fare is out when refunds are required, 70% is within; off by default', () => {
  const r = fixedRules(9999999);
  assert.deepEqual(rules(evaluateComponent(flight({ fare: 'LIGHT' }), ctx(r))), []);
  r.flights.shortHaul.refundableOnly = true;
  const light = evaluateComponent(flight({ fare: 'LIGHT' }), ctx(r));
  assert.deepEqual(pick(light, 'flight.refundable'), [{ rule: 'flight.refundable', limit: null, actual: 0, severity: 'approval', component: 'out' }]);
  assert.equal(light.violations[0].text, 'Your policy asks for a fare that refunds at least part of the price. Light refunds nothing.');
  assert.deepEqual(rules(evaluateComponent(flight({ fare: 'FLEX' }), ctx(r))), []);
});

test('flight.carrier: a blocked carrier on any segment blocks the row, named from the carriers list', () => {
  const r = fixedRules(9999999);
  r.flights.blockedCarriers = ['ZS'];
  const second = flight({ stops: 1, segmentCarriers: ['ZM', 'ZS'] });
  assert.equal(second.carrier.code, 'ZM', 'the itinerary is sold by ZM');
  const e = evaluateComponent(second, ctx(r));
  assert.equal(e.status, 'blocked');
  assert.deepEqual(pick(e, 'flight.carrier'), [{ rule: 'flight.carrier', limit: 'ZS', actual: 'ZS', severity: 'block', component: 'out' }]);
  assert.equal(e.violations[0].text, "Sahara Wings isn't used by Acme Inc.");
  assert.equal(evaluateComponent(flight({ carrier: 'ZS' }), ctx(r)).status, 'blocked');
  assert.equal(evaluateComponent(flight({ carrier: 'ZM' }), ctx(r)).status, 'within');
  // Each blocked carrier once.
  r.flights.blockedCarriers = ['ZS', 'ZG'];
  assert.deepEqual(evaluateComponent(flight({ stops: 1, carrier: 'ZS', segmentCarriers: ['ZS', 'ZG'] }), ctx(r)).violations.map(v => v.limit), ['ZS', 'ZG']);
});

test('inventory.unavailable blocks; the price rules skip an unpriced row, the others still apply', () => {
  const r = fixedRules(100);
  const e = evaluateComponent(flight({ available: false, cabin: 'business' }), ctx(r));
  assert.equal(e.status, 'blocked');
  assert.deepEqual(rules(e), ['flight.cabin', 'inventory.unavailable']);
  assert.deepEqual(pick(e, 'inventory.unavailable'), [{ rule: 'inventory.unavailable', limit: null, actual: null, severity: 'block', component: 'out' }]);
  const h = evaluateComponent(hotel({ available: false }), ctx(defaultPolicy('standard')));
  assert.deepEqual([h.status, rules(h), h.overCents], ['blocked', ['inventory.unavailable'], 0]);
});

// ---------------------------------------------------------------------------------------------------------
// Hotels

test('hotel caps: city beats country beats default; names match case-insensitively; none without any', () => {
  const r = defaultPolicy('standard');
  assert.deepEqual(hotelCap(r, hotel({ city: 'London', country: 'United Kingdom' })), { cents: 30000, source: 'city', basis: 'incl_taxes' });
  assert.deepEqual(hotelCap(r, hotel({ city: 'Manchester', country: 'United Kingdom' })), { cents: 26000, source: 'country', basis: 'incl_taxes' });
  assert.deepEqual(hotelCap(r, hotel({ city: 'Athens', country: 'Greece' })), { cents: 17000, source: 'country', basis: 'incl_taxes' });
  assert.deepEqual(hotelCap(r, hotel({ city: 'Lisbon', country: 'Portugal' })), { cents: 18000, source: 'default', basis: 'incl_taxes' });
  assert.deepEqual(hotelCap(r, hotel({ city: 'istanbul', country: 'TÜRKIYE' })), { cents: 18000, source: 'city', basis: 'incl_taxes' });
  r.hotels.defaultNightlyCents = null;
  assert.deepEqual(hotelCap(r, hotel({ city: 'Lisbon', country: 'Portugal' })), { cents: null, source: 'none', basis: 'incl_taxes' });
  assert.deepEqual(rules(evaluateComponent(hotel({ city: 'Lisbon', country: 'Portugal', nightlyCents: 999999, stars: 3 }), ctx(r))), []);
});

test('hotel.cap: the whole stay on the basis against cap × nights; equal is within, a cent over is out', () => {
  const r = defaultPolicy('standard'); // London $300 a night, taxes included
  r.hotels.maxStars = null;
  // 4 nights at a nightly total of exactly $300: (26316 + 3684 tax) is not how the fixture rounds, so use a 0% tax row.
  const at = evaluateComponent(hotel({ nightlyCents: 30000, taxPercent: 0 }), ctx(r));
  assert.deepEqual([at.status, at.overCents, at.cap], ['within', 0, { cents: 30000, source: 'city', basis: 'incl_taxes' }]);
  const row = hotel({ nightlyCents: 30000, taxPercent: 0 });
  const plusCent = { ...row, totalCents: row.totalCents + 1, lines: [{ ...row.lines[0], cents: row.lines[0].cents + 1 }, row.lines[1]] };
  const over = evaluateComponent(plusCent, ctx(r));
  assert.deepEqual(pick(over, 'hotel.cap'), [{ rule: 'hotel.cap', limit: 120000, actual: 120001, severity: 'approval', component: 'hotel' }]);
  assert.equal(over.overCents, 1, 'a stay total, never per night');
  assert.equal(over.violations[0].text, '$300.01 a night is over the London limit of $300 (taxes included).', 'never reads as equal to the cap');
  // No per-night rounding: 3 nights at 10000.34 average is 30001 against 30000.
  const three = hotel({ nights: 3, nightlyCents: 10000, taxPercent: 0 });
  r.hotels.countryCaps = [{ country: 'United Kingdom', nightlyCents: 10000, cities: [] }];
  const odd = { ...three, totalCents: 30001, lines: [{ ...three.lines[0], cents: 30001 }, three.lines[1]] };
  assert.deepEqual(pick(evaluateComponent(odd, ctx(r)), 'hotel.cap').map(v => [v.limit, v.actual]), [[30000, 30001]]);
  // The plan's example: $340 a night over London's $300.
  const r2 = defaultPolicy('standard');
  const big = evaluateComponent(hotel({ nightlyCents: 29825, taxPercent: 14, stars: 4 }), ctx(r2)); // 29825 + 4176 = 34001 a night
  assert.equal(big.violations[0].text, '$340.01 a night is over the London limit of $300 (taxes included).');
  assert.equal(big.overCents, 34001 * 4 - 120000);
  const country = evaluateComponent(hotel({ city: 'Leeds', nightlyCents: 30000, taxPercent: 0 }), ctx(r2));
  assert.equal(country.violations[0].text, '$300 a night is over the United Kingdom limit of $260 (taxes included).');
  const dflt = evaluateComponent(hotel({ city: 'Lisbon', country: 'Portugal', nightlyCents: 20000, taxPercent: 0 }), ctx(r2));
  assert.equal(dflt.violations[0].text, '$200 a night is over your hotel limit of $180 (taxes included).');
});

test('hotel capBasis: incl_taxes compares the total, excl_taxes the total less its tax lines', () => {
  const r = defaultPolicy('standard');
  r.hotels.maxStars = null;
  const row = hotel({ nightlyCents: 28000, taxPercent: 14 }); // 28000 + 3920 = 31920 a night incl, 28000 excl
  assert.deepEqual(rules(evaluateComponent(row, ctx(r))), ['hotel.cap']);
  assert.deepEqual(pick(evaluateComponent(row, ctx(r)), 'hotel.cap').map(v => [v.limit, v.actual]), [[120000, 127680]]);
  r.hotels.capBasis = 'excl_taxes';
  const e = evaluateComponent(row, ctx(r));
  assert.deepEqual([rules(e), e.cap.basis], [[], 'excl_taxes']);
  const over = evaluateComponent(hotel({ nightlyCents: 31000, taxPercent: 14 }), ctx(r));
  assert.deepEqual(pick(over, 'hotel.cap').map(v => [v.limit, v.actual]), [[120000, 124000]]);
  assert.equal(over.violations[0].text, '$310 a night is over the London limit of $300 (before taxes).');
});

test('hotel.stars and hotel.refundable', () => {
  const r = defaultPolicy('standard');
  r.hotels.countryCaps = [];
  r.hotels.defaultNightlyCents = null;
  assert.deepEqual(rules(evaluateComponent(hotel({ stars: 4 }), ctx(r))), []);
  const five = evaluateComponent(hotel({ stars: 5 }), ctx(r));
  assert.deepEqual(pick(five, 'hotel.stars'), [{ rule: 'hotel.stars', limit: 4, actual: 5, severity: 'approval', component: 'hotel' }]);
  assert.equal(five.violations[0].text, '5-star hotel. Your policy allows up to 4 stars.');
  r.hotels.maxStars = null;
  assert.deepEqual(rules(evaluateComponent(hotel({ stars: 5 }), ctx(r))), []);
  r.hotels.refundableOnly = true;
  assert.deepEqual(pick(evaluateComponent(hotel({ refundable: false }), ctx(r)), 'hotel.refundable'), [{ rule: 'hotel.refundable', limit: null, actual: false, severity: 'approval', component: 'hotel' }]);
  assert.deepEqual(rules(evaluateComponent(hotel({ refundable: true }), ctx(r))), []);
});

// ---------------------------------------------------------------------------------------------------------
// Trips: roll-up, block mode, trip cap, budget

const BUDGET = { remainingCents: 100000, periodKey: '2026-Q4', periodLabel: 'Q4 2026', departmentName: 'Engineering' };

function tripRules() {
  const r = fixedRules(50000);
  r.flights.shortHaul.maxCabin = 'economy';
  r.hotels.maxStars = 5;
  return r;
}

test('evaluateTrip: one out component makes the trip out; violations flatten in component order; total is Σ rows', () => {
  const rows = { out: flight({ totalCents: 40000 }), back: flight({ leg: 'back', totalCents: 60000 }), hotel: hotel({ nightlyCents: 20000, taxPercent: 0 }) };
  const e = evaluateTrip(rows, ctx(tripRules()), { budget: null });
  assert.equal(e.status, 'out');
  assert.deepEqual([e.components.out.status, e.components.back.status, e.components.hotel.status], ['within', 'out', 'within']);
  assert.deepEqual(e.violations.map(v => [v.rule, v.component]), [['flight.cap', 'back']]);
  assert.equal(e.totalCents, 40000 + 60000 + 80000);
  assert.deepEqual(e.policy, { tier: 'standard', version: 3 });
  // Only the components given.
  const oneWay = evaluateTrip({ out: rows.out, back: null, hotel: null }, ctx(tripRules()), { budget: null });
  assert.deepEqual(Object.keys(oneWay.components), ['out']);
  assert.equal(oneWay.status, 'within');
  // Blocked beats out.
  const r = tripRules();
  r.flights.blockedCarriers = ['ZS'];
  assert.equal(evaluateTrip({ ...rows, out: flight({ carrier: 'ZS', totalCents: 40000 }) }, ctx(r), { budget: null }).status, 'blocked');
});

test('block mode: out becomes blocked; a budget-only overrun stays out', () => {
  const c = ctx(tripRules(), { outOfPolicy: 'block' });
  const out = evaluateComponent(flight({ totalCents: 50001 }), c);
  assert.equal(out.status, 'blocked');
  assert.equal(out.violations[0].severity, 'approval', 'the violation keeps its severity; the mode blocks it');
  const rows = { out: flight({ totalCents: 40000 }), back: null, hotel: null };
  const budgetOnly = evaluateTrip(rows, c, { budget: { ...BUDGET, remainingCents: 39999 } });
  assert.deepEqual([budgetOnly.status, budgetOnly.violations.map(v => v.rule)], ['out', ['budget']]);
  const tripCap = tripRules();
  tripCap.trip.maxTotalCents = 30000;
  assert.equal(evaluateTrip(rows, ctx(tripCap, { outOfPolicy: 'block' }), { budget: null }).status, 'blocked', 'trip.cap is not a budget rule');
});

test('trip.cap: the limit is within, a cent over is out', () => {
  const r = tripRules();
  r.trip.maxTotalCents = 90000;
  const at = evaluateTrip({ out: flight({ totalCents: 45000 }), back: flight({ leg: 'back', totalCents: 45000 }) }, ctx(r), { budget: null });
  assert.equal(at.status, 'within');
  const over = evaluateTrip({ out: flight({ totalCents: 45000 }), back: flight({ leg: 'back', totalCents: 45001 }) }, ctx(r), { budget: null });
  assert.deepEqual(over.violations.map(v => ({ rule: v.rule, limit: v.limit, actual: v.actual, component: v.component, severity: v.severity })),
    [{ rule: 'trip.cap', limit: 90000, actual: 90001, component: 'trip', severity: 'approval' }]);
  assert.equal(over.status, 'out');
  r.trip.maxTotalCents = 250000;
  const text = evaluateTrip({ out: flight({ totalCents: 50000 }), hotel: hotel({ nightlyCents: 70000, taxPercent: 0, city: 'Lisbon', country: 'Portugal', nights: 3 }) },
    ctx({ ...r, hotels: { ...r.hotels, defaultNightlyCents: null } }), { budget: null }).violations.find(v => v.rule === 'trip.cap').text;
  assert.equal(text, 'The trip total is over your $2,500 trip limit by $100.');
});

test('budget: remaining − 1 and remaining are within, remaining + 1 is out with the period in words', () => {
  const rows = { out: flight({ totalCents: 40000 }), back: null, hotel: null };
  const c = ctx(tripRules());
  for (const [remaining, out] of [[40001, false], [40000, false], [39999, true]]) {
    const e = evaluateTrip(rows, c, { budget: { ...BUDGET, remainingCents: remaining } });
    assert.equal(e.status, out ? 'out' : 'within', String(remaining));
    assert.deepEqual(e.violations.map(v => ({ rule: v.rule, limit: v.limit, actual: v.actual, severity: v.severity, component: v.component })),
      out ? [{ rule: 'budget', limit: 39999, actual: 40000, severity: 'approval', component: 'trip' }] : []);
  }
  const big = evaluateTrip({ out: flight({ totalCents: 40000 }), back: flight({ leg: 'back', totalCents: 44000 }) }, c, { budget: { ...BUDGET, remainingCents: 90000 - 5000 } });
  assert.deepEqual(big.violations.map(v => v.rule), []);
  const over = evaluateTrip({ out: flight({ totalCents: 50000 }), back: flight({ leg: 'back', totalCents: 50000 }) }, c, { budget: { ...BUDGET, remainingCents: 90000 } });
  assert.equal(over.violations[0].text, 'This trip would use $1,000 of the $900 left in Engineering for Q4 2026.');
  const none = evaluateTrip(rows, c, { budget: { ...BUDGET, remainingCents: -500 } });
  assert.equal(none.violations[0].text, 'This trip would use $400, and Engineering has nothing left for Q4 2026.');
  assert.deepEqual(evaluateTrip(rows, c, { budget: null }).violations, [], 'no budget for the period: no budget check');
  assert.throws(() => evaluateTrip(rows, c, { budget: { remainingCents: 1, periodKey: '2026-Q4', departmentName: 'Engineering' } }), /periodLabel/);
  // Unpriced trips (something unavailable) skip trip.cap and budget: the total is unknown.
  const gone = evaluateTrip({ out: rows.out, hotel: hotel({ available: false }) }, c, { budget: { ...BUDGET, remainingCents: 1 } });
  assert.deepEqual([gone.status, gone.violations.map(v => v.rule)], ['blocked', ['inventory.unavailable']]);
});

test('priceToBeat: the lower of cap and median when both exist, else whichever exists, else null', () => {
  const b = m => ({ medianCents: m, sampleSize: m == null ? 2 : 5, excluded: [] });
  assert.equal(priceToBeat(30000, b(26400)), 26400);
  assert.equal(priceToBeat(26000, b(26400)), 26000);
  assert.equal(priceToBeat(30000, b(null)), 30000);
  assert.equal(priceToBeat(30000, null), 30000);
  assert.equal(priceToBeat(null, b(26400)), 26400);
  assert.equal(priceToBeat(null, b(null)), null);
  assert.equal(priceToBeat(null, null), null);
});

test('violations follow RULE_IDS order, every rule id is reachable, and texts carry no em dash or pressure words', () => {
  const r = defaultPolicy('standard');
  r.flights.shortHaul.cap = { mode: 'fixed', amountCents: 100 };
  r.flights.shortHaul.maxStops = 0;
  r.flights.shortHaul.refundableOnly = true;
  r.flights.blockedCarriers = ['ZS'];
  r.hotels.refundableOnly = true;
  r.hotels.minAdvanceDays = 60;
  r.trip.maxTotalCents = 100;
  const rows = {
    out: flight({ date: '2026-10-10', cabin: 'business', stops: 1, carrier: 'ZS', totalCents: 90000 }),
    back: flight({ leg: 'back', available: false }),
    hotel: hotel({ stars: 5, refundable: false, nightlyCents: 90000 }),
  };
  const out = evaluateTrip({ out: rows.out, hotel: rows.hotel }, ctx(r), { budget: { ...BUDGET, remainingCents: 10 } });
  assert.deepEqual(out.violations.map(v => v.rule), [
    'flight.cap', 'flight.cabin', 'flight.advance', 'flight.stops', 'flight.refundable', 'flight.carrier',
    'hotel.cap', 'hotel.stars', 'hotel.advance', 'hotel.refundable', 'trip.cap', 'budget',
  ]);
  const gone = evaluateComponent(rows.back, ctx(r));
  const seen = new Set([...out.violations, ...gone.violations].map(v => v.rule));
  assert.deepEqual([...RULE_IDS].filter(id => !seen.has(id)), []);
  for (const v of [...out.violations, ...gone.violations]) {
    assert.ok(!/\u2014/.test(v.text) && !PRESSURE.test(v.text), v.text);
    assert.match(v.text, /\.$/, v.text);
  }
});

test('purity: deep-frozen inputs, the same output twice, and no clock anywhere under policy/', () => {
  const r = deepFreeze(defaultPolicy('director'));
  const rows = deepFreeze({ out: flight({ cabin: 'business', totalCents: 120000 }), back: flight({ leg: 'back' }), hotel: hotel({ stars: 5, nightlyCents: 40000 }) });
  const c = deepFreeze(ctx(r, { benchmarks: { out: { medianCents: 50000, sampleSize: 4, excluded: [] }, back: { medianCents: null, sampleSize: 1, excluded: [] }, hotel: { medianCents: 30000, sampleSize: 3, excluded: [] } } }));
  const budget = deepFreeze({ ...BUDGET });
  const a = evaluateTrip(rows, c, { budget });
  const b = evaluateTrip(rows, c, { budget });
  assert.deepEqual(a, b);
  assert.notEqual(a.components.out.violations, b.components.out.violations, 'fresh objects every call');
  const search = deepFreeze({ query: fx.query(), legs: { out: { rows: [rows.out], benchmark: c.benchmarks.out, truncated: false }, back: { rows: [rows.back], benchmark: c.benchmarks.back, truncated: false }, hotel: { rows: [rows.hotel], benchmark: { incl_taxes: c.benchmarks.hotel, excl_taxes: c.benchmarks.hotel }, truncated: false } } });
  assert.deepEqual(describeMod.limitsBar(r, c, search), describeMod.limitsBar(r, c, search));
  assert.deepEqual(describeMod.describe(r, { tier: 'director', version: 2, orgName: 'Acme Inc', carriers: {} }), describeMod.describe(r, { tier: 'director', version: 2, orgName: 'Acme Inc', carriers: {} }));
  const form = deepFreeze(schema.formFromPolicy(defaultPolicy('standard')));
  assert.deepEqual(schema.normalizePolicy(form, REFS), defaultPolicy('standard'));
  schema.policyChanges(r, deepFreeze(defaultPolicy('standard')));
  const dir = path.join(__dirname, '..', 'server', 'business', 'policy');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/Date\.now|new Date\b/.test(src), `${file} reads no clock`);
    assert.ok(!/require\(['"][^'"]*(?:repo|store|booking|http|https|net)['"]\)/.test(src), `${file} needs no store or network`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// normalizePolicy, formFromPolicy, policyChanges

test('normalizePolicy: the form of every default tier round-trips to the same rules', () => {
  for (const tier of ['standard', 'director', 'executive']) {
    const form = schema.formFromPolicy(DEFAULT_POLICIES[tier]);
    for (const [k, value] of Object.entries(form)) assert.ok(typeof value === 'string' || (k === 'blockedCarriers' && Array.isArray(value)), k);
    assert.deepEqual(schema.normalizePolicy(form, REFS), defaultPolicy(tier), tier);
    assert.deepEqual(schema.normalizePolicy(form, { airports: [], carriers: [], countries: [] }), defaultPolicy(tier), `${tier} with no supplier`);
  }
  // A full policy with every list in use round-trips too.
  const r = defaultPolicy('standard');
  r.flights.longHaulMinutes = 390;
  r.flights.shortHaul.cap = { mode: 'median_plus', amountCents: 0, fallbackCents: 45050 };
  r.flights.longHaul.cap = { mode: 'fixed', amountCents: 199999 };
  r.flights.shortHaul.maxStops = 0;
  r.flights.longHaul.maxStops = null;
  r.flights.longHaul.refundableOnly = true;
  r.flights.routeOverrides = [
    { from: 'CAI', to: 'LHR', bothWays: true, cap: { mode: 'median_pct', pctTenths: 75, fallbackCents: 90000 }, maxCabin: 'business' },
    { from: 'DXB', to: 'IST', bothWays: false, cap: { mode: 'none' }, maxCabin: null },
  ];
  r.flights.blockedCarriers = ['ZS', 'ZG'];
  r.hotels.capBasis = 'excl_taxes';
  r.hotels.defaultNightlyCents = null;
  r.hotels.maxStars = null;
  r.hotels.minAdvanceDays = 2;
  r.hotels.refundableOnly = true;
  r.trip.maxTotalCents = 250050;
  assert.deepEqual(schema.normalizePolicy(schema.formFromPolicy(r), REFS), r);
  // blockedCarriers as a single string, lowercase codes and repeats are fine.
  const f = schema.formFromPolicy(r);
  assert.deepEqual(schema.normalizePolicy({ ...f, blockedCarriers: 'zs' }, REFS).flights.blockedCarriers, ['ZS']);
  assert.deepEqual(schema.normalizePolicy({ ...f, blockedCarriers: ['ZG', 'zs', 'ZG', ''] }, REFS).flights.blockedCarriers, ['ZG', 'ZS']);
  // Extra fields (rev, note) are ignored; country names take the inventory's spelling.
  const named = schema.normalizePolicy({ ...f, rev: '4', note: 'Tighter London', _csrf: 'x' }, REFS);
  assert.deepEqual(named, r);
  const uk = schema.normalizePolicy({ ...schema.formFromPolicy(defaultPolicy('standard')), 'country.1.name': 'UNITED KINGDOM' }, REFS);
  assert.equal(uk.hotels.countryCaps[1].country, 'United Kingdom');
});

test('normalizePolicy refuses, with details by form field: unknown keys, first class, bad money, unknown codes, long lists', () => {
  const base = schema.formFromPolicy(defaultPolicy('standard'));
  const details = (patch, refs = REFS) => {
    try { schema.normalizePolicy({ ...base, ...patch }, refs); } catch (e) {
      assert.ok(e instanceof AppError);
      assert.deepEqual([e.code, e.status, e.message], ['invalid_policy', 422, 'Check the highlighted fields.']);
      return e.details;
    }
    assert.fail(`accepted ${JSON.stringify(patch)}`);
  };
  assert.deepEqual(Object.keys(details({ 'short.bogus': '1', 'trip.x': '2', 'route.0.city': 'Paris', 'route.00.from': 'CAI' })).sort(), ['route.0.city', 'route.00.from', 'short.bogus', 'trip.x']);
  assert.match(details({ 'short.maxCabin': 'first' })['short.maxCabin'], /Economy, Premium economy or Business/);
  assert.ok(details({ 'route.0.from': 'CAI', 'route.0.to': 'LHR', 'route.0.capMode': 'none', 'route.0.maxCabin': 'first' })['route.0.maxCabin']);
  assert.ok(details({ 'short.fallback': '-5' })['short.fallback']);
  assert.ok(details({ 'short.fallback': '0' })['short.fallback'], 'a fallback above $0');
  assert.ok(details({ 'short.fallback': '' })['short.fallback'], 'a median cap needs its fallback');
  assert.ok(details({ 'short.capPct': '100' })['short.capPct'], 'at most 99.9%');
  assert.ok(details({ 'short.capPct': '7.55' })['short.capPct']);
  assert.ok(details({ 'short.capMode': 'fixed', 'short.capAmount': '' })['short.capAmount']);
  assert.ok(details({ 'short.capMode': 'percent' })['short.capMode']);
  assert.ok(details({ 'hotel.default': '-1' })['hotel.default']);
  assert.ok(details({ 'hotel.default': '12.345' })['hotel.default'], 'never rounded');
  assert.ok(details({ 'trip.maxTotal': '0' })['trip.maxTotal']);
  assert.ok(details({ 'country.0.nightly': '-200' })['country.0.nightly']);
  assert.ok(details({ 'country.1.city.0.nightly': 'lots' })['country.1.city.0.nightly']);
  assert.ok(details({ longHaulMinutes: '59' }).longHaulMinutes);
  assert.ok(details({ longHaulMinutes: '1201' }).longHaulMinutes);
  assert.ok(details({ longHaulMinutes: '6h' }).longHaulMinutes);
  assert.ok(details({ 'short.minAdvanceDays': '366' })['short.minAdvanceDays']);
  assert.ok(details({ 'short.maxStops': '2' })['short.maxStops']);
  assert.ok(details({ 'hotel.maxStars': '6' })['hotel.maxStars']);
  assert.ok(details({ 'hotel.capBasis': 'gross' })['hotel.capBasis']);
  assert.ok(details({ 'short.refundableOnly': 'yes' })['short.refundableOnly']);
  assert.ok(details({ 'short.capMode': ['fixed', 'none'] })['short.capMode'], 'one value only');
  // Codes from the inventory only; empty lists refuse every code.
  assert.ok(details({ 'route.0.from': 'XXX', 'route.0.to': 'LHR', 'route.0.capMode': 'none' })['route.0.from']);
  assert.ok(details({ 'route.0.from': 'CAI', 'route.0.to': 'CAI', 'route.0.capMode': 'none' })['route.0.to']);
  assert.ok(details({ 'route.0.from': 'CAI', 'route.0.to': 'LHR', 'route.0.capMode': 'none' }, { ...REFS, airports: [] })['route.0.from']);
  assert.ok(details({ blockedCarriers: ['ZS', 'QQ'] }).blockedCarriers);
  assert.ok(details({ blockedCarriers: ['ZS'] }, { ...REFS, carriers: [] }).blockedCarriers);
  assert.ok(details({ 'country.0.name': 'Atlantis' })['country.0.name'], 'countries from the inventory when it knows any');
  assert.deepEqual(details({ 'country.7.name': 'egypt' }), { 'country.8.name': 'This country is already listed.' }, 'no country twice: the later row is flagged');
  assert.ok(details({ 'country.1.city.1.name': 'london', 'country.1.city.1.nightly': '310' })['country.1.city.1.name'], 'no city twice');
  assert.ok(details({ 'country.1.city.0.name': 'L'.repeat(81) })['country.1.city.0.name']);
  // Shadowed route rows: the first match wins, so a later duplicate could never apply.
  const routes = { 'route.0.from': 'CAI', 'route.0.to': 'LHR', 'route.0.bothWays': '1', 'route.0.capMode': 'none', 'route.1.from': 'LHR', 'route.1.to': 'CAI', 'route.1.capMode': 'none' };
  assert.ok(details(routes)['route.1.from']);
  // Over-long lists.
  const many = {};
  for (let i = 0; i <= 50; i++) Object.assign(many, { [`route.${i}.from`]: i % 2 ? 'CAI' : 'DXB', [`route.${i}.to`]: ['LHR', 'IST', 'CAI', 'DXB'][i % 4] === (i % 2 ? 'CAI' : 'DXB') ? 'IST' : 'LHR', [`route.${i}.capMode`]: 'none' });
  assert.ok(Object.keys(details(many)).some(k => k.startsWith('route.')), 'more than 50 routes');
  const cities = {};
  for (let i = 0; i <= 20; i++) Object.assign(cities, { [`country.0.city.${i}.name`]: `Town ${i}`, [`country.0.city.${i}.nightly`]: '100' });
  assert.match(details(cities)['country.0.city.20.name'], /Up to 20 cities/);
  const countries = {};
  for (let i = 0; i <= 60; i++) Object.assign(countries, { [`country.${i}.name`]: `Land ${i}`, [`country.${i}.nightly`]: '100' });
  assert.match(details(countries, { ...REFS, countries: [] })['country.60.name'], /Up to 60 countries/);
  assert.match(details({ blockedCarriers: Array.from({ length: 21 }, (_, i) => `Z${String.fromCharCode(65 + i)}`) }, { ...REFS, carriers: Array.from({ length: 26 }, (_, i) => `Z${String.fromCharCode(65 + i)}`) }).blockedCarriers, /Up to 20/);
  // Blank rows are ignored; a field in an ignored row is never checked.
  const kept = schema.normalizePolicy({ ...base, 'route.3.from': '', 'route.3.capMode': 'bogus', 'country.20.name': ' ', 'country.20.nightly': 'x' }, REFS);
  assert.deepEqual(kept, defaultPolicy('standard'));
  // Required fields that are missing.
  const noThreshold = { ...base };
  delete noThreshold.longHaulMinutes;
  assert.throws(() => schema.normalizePolicy(noThreshold, REFS), e => !!(e.details && e.details.longHaulMinutes));
});

test('policyChanges: declared paths in order, lists matched by natural key, key order ignored', () => {
  const a = defaultPolicy('standard');
  assert.deepEqual(schema.policyChanges(a, defaultPolicy('standard')), []);
  // JSONB-style key reordering is not a change.
  const reorder = v => (Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v);
  const shuffled = reorder(a);
  shuffled.flights.shortHaul = { ...a.flights.shortHaul, cap: { fallbackCents: 60000, pctTenths: 200, mode: 'median_pct' } };
  assert.deepEqual(schema.policyChanges(a, shuffled), []);
  const b = defaultPolicy('standard');
  b.flights.shortHaul.maxCabin = 'premium';
  b.flights.routeOverrides = [{ from: 'CAI', to: 'LHR', bothWays: true, cap: { mode: 'fixed', amountCents: 90000 }, maxCabin: null }];
  b.flights.blockedCarriers = ['ZS'];
  b.hotels.countryCaps[1].cities[0].nightlyCents = 32000;
  b.hotels.countryCaps[1].cities.push({ city: 'Manchester', nightlyCents: 20000 });
  b.hotels.countryCaps = b.hotels.countryCaps.filter(c => c.country !== 'Greece');
  b.hotels.countryCaps.push({ country: 'Portugal', nightlyCents: 15000, cities: [] });
  b.trip.maxTotalCents = 300000;
  const changes = schema.policyChanges(a, b);
  assert.deepEqual(changes.map(c => c.path), [
    'flights.shortHaul.maxCabin',
    'flights.routeOverrides[CAI-LHR]',
    'flights.blockedCarriers',
    'hotels.countryCaps[United Kingdom].cities[London].nightlyCents',
    'hotels.countryCaps[United Kingdom].cities[Manchester]',
    'hotels.countryCaps[Portugal]',
    'hotels.countryCaps[Greece]',
    'trip.maxTotalCents',
  ]);
  assert.deepEqual(changes[0], { path: 'flights.shortHaul.maxCabin', before: 'economy', after: 'premium' });
  assert.deepEqual([changes[1].before, changes[1].after.cap], [null, { mode: 'fixed', amountCents: 90000 }]);
  assert.deepEqual(changes[3], { path: 'hotels.countryCaps[United Kingdom].cities[London].nightlyCents', before: 30000, after: 32000 });
  assert.deepEqual([changes[6].before.nightlyCents, changes[6].after], [17000, null]);
  // The changes are copies.
  changes[1].after.cap.amountCents = 1;
  assert.equal(b.flights.routeOverrides[0].cap.amountCents, 90000);
  // Blocked carriers compare as a set.
  const c1 = defaultPolicy('standard'), c2 = defaultPolicy('standard');
  c1.flights.blockedCarriers = ['ZS', 'ZG'];
  c2.flights.blockedCarriers = ['ZG', 'ZS'];
  assert.deepEqual(schema.policyChanges(c1, c2), []);
  // Every default tier against Standard: only declared paths.
  const PATH = /^(flights\.(longHaulMinutes|(shortHaul|longHaul)\.(cap|maxCabin|minAdvanceDays|maxStops|refundableOnly)|routeOverrides\[[A-Z]{3}-[A-Z]{3}\]|blockedCarriers)|hotels\.(capBasis|defaultNightlyCents|maxStars|minAdvanceDays|refundableOnly|countryCaps\[[^\]]+\](\.nightlyCents|\.cities\[[^\]]+\](\.nightlyCents)?)?)|trip\.maxTotalCents)$/;
  for (const tier of ['director', 'executive']) for (const ch of schema.policyChanges(a, defaultPolicy(tier))) assert.match(ch.path, PATH);
});

// ---------------------------------------------------------------------------------------------------------
// describe and the limits bar

test('describe(): the policy in plain words, with no em dash and no pressure words', () => {
  const r = defaultPolicy('standard');
  r.flights.blockedCarriers = ['ZS'];
  const d = describeMod.describe(r, { tier: 'standard', version: 3, orgName: 'Acme Inc', carriers: { ZS: 'Sahara Wings' } });
  assert.equal(d.title, 'Your travel policy');
  assert.equal(d.sub, 'Standard policy, version 3');
  assert.deepEqual(d.lines, [
    "Flights under 6 hours: Economy, with fares up to the median of the demo fares in your search plus 20% (or $600 if there aren't enough fares to compare), at most 1 stop.",
    "Flights of 6 hours or more: up to Premium economy, with fares up to the median of the demo fares in your search plus 20% (or $1,500 if there aren't enough fares to compare), at most 1 stop.",
    'Plan flights under 6 hours at least 7 days ahead, and longer ones at least 14 days ahead.',
    'Hotels: up to $180 a night, taxes included.',
    'Nightly limits by country: United Arab Emirates $220 (Dubai $240), United Kingdom $260 (London $300), France $240 (Paris $280), Germany $200 (Munich $220), Italy $200 (Rome $220), Türkiye $160 (Istanbul $180), Greece $170, Saudi Arabia $200 (Riyadh $220), Egypt $150 (Cairo $160).',
    'Up to 4-star hotels.',
    "Sahara Wings isn't used by Acme Inc.",
  ]);
  const x = defaultPolicy('executive');
  x.flights.shortHaul.cap = { mode: 'fixed', amountCents: 80000 };
  x.flights.shortHaul.maxStops = 0;
  x.flights.shortHaul.refundableOnly = true;
  x.flights.routeOverrides = [{ from: 'CAI', to: 'LHR', bothWays: true, cap: { mode: 'none' }, maxCabin: 'business' }];
  x.hotels.defaultNightlyCents = null;
  x.hotels.minAdvanceDays = 2;
  x.hotels.refundableOnly = true;
  x.trip.maxTotalCents = 500000;
  const e = describeMod.describe(x, { tier: 'executive', version: 1, orgName: 'Acme Inc', carriers: {} });
  assert.equal(e.sub, 'Executive policy, version 1');
  assert.ok(e.lines.includes('Flights under 6 hours: up to Premium economy, with fares up to $800 each way, nonstop only, on a fare that refunds at least part of the price.'));
  assert.ok(e.lines.includes('Plan flights at least 3 days ahead.'));
  assert.ok(e.lines.includes('CAI to LHR and back: up to Business class, with no price limit.'));
  assert.ok(e.lines.includes('Hotels: no nightly limit outside the countries below (limits taxes included).'));
  assert.ok(e.lines.includes('Book hotels at least 2 days ahead.'));
  assert.ok(e.lines.includes('Trips up to $5,000 in total.'));
  for (const tier of ['standard', 'director', 'executive']) {
    for (const line of [...describeMod.describe(defaultPolicy(tier), { tier, version: 1, orgName: 'Acme Inc', carriers: {} }).lines, ...e.lines, ...d.lines]) {
      assert.ok(!/\u2014/.test(line), `em dash: ${line}`);
      assert.ok(!PRESSURE.test(line), `pressure: ${line}`);
    }
  }
});

test('limitsBar: each band in the search with its cap, advance days, the hotel city cap and Price to Beat', () => {
  const r = defaultPolicy('standard');
  const outRows = [flight({ totalCents: 44200 }), flight({ n: 2, totalCents: 41000 })];
  const backRows = [flight({ leg: 'back', totalCents: 45000 })];
  const hotels = [hotel({ nightlyCents: 20000 })];
  const median = { medianCents: 59335, sampleSize: 5, excluded: [] };
  const search = {
    query: fx.query(), pricedAt: fx.PRICED_AT, status: 'demo',
    legs: {
      out: { rows: outRows, benchmark: median, truncated: false },
      back: { rows: backRows, benchmark: median, truncated: false },
      hotel: { rows: hotels, benchmark: { incl_taxes: { medianCents: 26400, sampleSize: 3, excluded: [] }, excl_taxes: { medianCents: 23000, sampleSize: 3, excluded: [] } }, truncated: false },
    },
  };
  const bar = describeMod.limitsBar(r, ctx(r), search);
  assert.equal(bar.heading, 'Your limits for this search (Standard policy, v3)');
  assert.deepEqual(bar.items, [
    { key: 'flight.short', text: 'Flights under 6 hours: Economy, up to', cents: 71202, suffix: 'each way (median of these demo fares plus 20%)' },
    { key: 'flight.advance', text: 'Plan 7 days ahead', cents: null, suffix: '' },
    { key: 'hotel.cap', text: 'Hotels in London: up to', cents: 30000, suffix: 'a night, taxes included' },
    { key: 'hotel.priceToBeat', text: 'Price to Beat:', cents: 26400, suffix: 'a night (the lower of your limit and the middle rate of this search)' },
    { key: 'hotel.stars', text: 'Up to 4-star hotels', cents: null, suffix: '' },
  ]);
  // Different medians per leg: one item per leg.
  const split = describeMod.limitsBar(r, ctx(r), { ...search, legs: { ...search.legs, back: { ...search.legs.back, benchmark: { medianCents: null, sampleSize: 1, excluded: [] } } } });
  assert.deepEqual(split.items.slice(0, 2), [
    { key: 'flight.out.short', text: 'Outbound flights under 6 hours: Economy, up to', cents: 71202, suffix: '(median of these demo fares plus 20%)' },
    { key: 'flight.back.short', text: 'Return flights under 6 hours: Economy, up to', cents: 60000, suffix: '(this search has too few demo fares to compare, so your set limit applies)' },
  ]);
  // One way, a route override, no hotel, a trip cap.
  const o = defaultPolicy('standard');
  o.flights.routeOverrides = [{ from: 'CAI', to: 'LHR', bothWays: false, cap: { mode: 'fixed', amountCents: 90000 }, maxCabin: 'premium' }];
  o.trip.maxTotalCents = 200000;
  const oneWay = describeMod.limitsBar(o, ctx(o), { query: fx.query({ returnDate: null, hotel: false }), legs: { out: search.legs.out, back: null, hotel: null } });
  // A route override sets the cap and cabin; the band's advance days still apply (evaluate checks them).
  assert.deepEqual(oneWay.items, [
    { key: 'flight.route', text: 'Flights between CAI and LHR: up to Premium economy, up to', cents: 90000, suffix: '' },
    { key: 'flight.advance', text: 'Plan 7 days ahead', cents: null, suffix: '' },
    { key: 'trip.cap', text: 'Trip total: up to', cents: 200000, suffix: '' },
  ]);
  const routed = describeMod.limitsBar(o, ctx(o), { query: fx.query({ hotel: false }), legs: { out: { rows: [flight({ date: '2026-10-12' })], benchmark: null }, back: null, hotel: null } });
  assert.deepEqual(routed.items.map(i => i.text), ['Flights between CAI and LHR: up to Premium economy, up to', 'Plan 7 days ahead', 'Trip total: up to']);
  assert.deepEqual(evaluateComponent(flight({ date: '2026-10-12' }), ctx(o)).violations.map(v => v.rule), ['flight.advance'], 'the rule the bar states is the rule evaluate applies');
  // Short and long flights in one search, with different advance days: one item per band, never only the larger.
  const mixed = describeMod.limitsBar(r, ctx(r), { query: fx.query({ returnDate: null, hotel: false }), legs: {
    out: { rows: [flight({ totalCents: 44200 }), flight({ n: 3, stops: 1, minutes: 430, totalCents: 52000 })], benchmark: median }, back: null, hotel: null,
  } });
  assert.deepEqual(mixed.items.filter(i => /ahead/.test(i.text)), [
    { key: 'flight.advance.short', text: 'Flights under 6 hours: plan 7 days ahead', cents: null, suffix: '' },
    { key: 'flight.advance.long', text: 'Flights of 6 hours or more: plan 14 days ahead', cents: null, suffix: '' },
  ]);
  // A route whose flights fall in both bands names both bands' advance days.
  const both = describeMod.limitsBar(o, ctx(o), { query: fx.query({ returnDate: null, hotel: false }), legs: { out: { rows: [flight(), flight({ n: 3, stops: 1, minutes: 430 })], benchmark: null }, back: null, hotel: null } });
  assert.deepEqual(both.items.filter(i => /ahead/.test(i.text)).map(i => i.key), ['flight.advance.short', 'flight.advance.long']);
  // The same advance days in every band: one item. No advance days in a band: nothing for it.
  const same = defaultPolicy('standard');
  same.flights.longHaul.minAdvanceDays = 7;
  assert.deepEqual(describeMod.limitsBar(same, ctx(same), { query: fx.query({ returnDate: null, hotel: false }), legs: { out: { rows: [flight(), flight({ n: 3, stops: 1, minutes: 430 })], benchmark: median }, back: null, hotel: null } })
    .items.filter(i => /ahead/.test(i.text)).map(i => [i.key, i.text]), [['flight.advance', 'Plan 7 days ahead']]);
  const shortOnly = defaultPolicy('standard');
  shortOnly.flights.longHaul.minAdvanceDays = 0;
  assert.deepEqual(describeMod.limitsBar(shortOnly, ctx(shortOnly), { query: fx.query({ returnDate: null, hotel: false }), legs: { out: { rows: [flight(), flight({ n: 3, stops: 1, minutes: 430 })], benchmark: median }, back: null, hotel: null } })
    .items.filter(i => /ahead/.test(i.text)).map(i => [i.key, i.text]), [['flight.advance.short', 'Flights under 6 hours: plan 7 days ahead']]);
  for (const item of [...bar.items, ...split.items, ...oneWay.items, ...mixed.items]) assert.ok(!PRESSURE.test(`${item.text} ${item.suffix}`) && !/\u2014/.test(`${item.text} ${item.suffix}`));
});

test('createPolicyEngine: all 17 methods delegate to the real modules', () => {
  const engine = createPolicyEngine();
  assert.equal(POLICY_ENGINE_METHODS.length, 17);
  assert.deepEqual(engine.benchmark([300, 310, 320, 330, 2000]).medianCents, 315);
  assert.equal(engine.priceToBeat(30000, { medianCents: 26400 }), 26400);
  assert.equal(engine.evaluateComponent(flight({ totalCents: 50001 }), ctx(fixedRules(50000))).status, 'out');
  assert.equal(engine.describe(defaultPolicy('standard'), { tier: 'standard', version: 1, orgName: 'Acme Inc', carriers: {} }).title, 'Your travel policy');
  assert.equal(engine.expiresAt('2026-10-09T09:00:00.000Z', 24, '2026-11-12', 'Africa/Cairo'), '2026-10-10T09:00:00.000Z');
  assert.equal(engine.resolveApprover({ userId: 'a', orgId: 'o' }, {}).rule, null);
  assert.deepEqual(engine.formFromPolicy(defaultPolicy('standard')), schema.formFromPolicy(defaultPolicy('standard')));
});
