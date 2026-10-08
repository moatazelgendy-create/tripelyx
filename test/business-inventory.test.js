// Stage 1I (plan §F1, §F2, §F5): Business's own demo inventory, the inventory seam and the allow-list rows.
// Time-zone-correct flight times, honest fare terms, the 29 demo hotels, and rows that carry nothing a company
// may not see.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BusinessDemoFlights, FARE_TERMS, OFFER_CANCELLATION } = require('../server/business/demo/flights');
const { BusinessDemoHotels } = require('../server/business/demo/hotels');
const { BUSINESS_HOTELS, BUSINESS_CITIES } = require('../server/business/demo/hotels-data');
const { createBusinessInventory } = require('../server/business/inventory');
const dto = require('../server/business/dto');
const tz = require('../server/business/tz');
const { defaultPolicy } = require('../server/business/policy/defaults');
const { assertProvider, validateOffer, validateQuote } = require('../server/providers/contracts');
const MockFlightProvider = require('../server/providers/mock/MockFlightProvider');
const MockHotelProvider = require('../server/providers/mock/MockHotelProvider');
const ALAMEIN_HOTELS = require('../server/providers/mock/demo-data/hotels');
const FLIGHT_DATA = require('../server/providers/mock/demo-data/flights');
const { overrideProvider } = require('./business-fakes');

const MINUTE = 60000;
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const flightQuery = (from, to, departDate, cabin = 'economy') => ({ from, to, departDate, cabin, passengers: 1 });
const demoInventory = () => createBusinessInventory({ allowDemoInventory: true }, { registry: { get: () => null } });

/** Local wall time 'YYYY-MM-DDTHH:MM' read at a fixed offset (minutes east of UTC), as epoch ms. */
const utcOf = (local, offset) => Date.parse(`${local}:00Z`) - offset * MINUTE;

// ---------------------------------------------------------------------------------------------------------
// Flights: local times

/**
 * Every segment's local departure and arrival agree with its duration under the given offsets, the elapsed
 * time is first departure to last arrival in UTC, and each day offset is the local date difference.
 */
function checkTimes(offers, offsets) {
  assert.ok(offers.length >= 2, 'a schedule');
  for (const o of offers) {
    const segs = o.details.segments;
    let firstUtc = null, lastUtc = null;
    for (const s of segs) {
      const dep = utcOf(s.departAt, offsets[s.from.code]);
      const arr = utcOf(s.arriveAt, offsets[s.to.code]);
      assert.equal((arr - dep) / MINUTE, s.durationMinutes, `${o.id} ${s.flightNumber}: local times match the flight time`);
      assert.equal(s.arriveDayOffset, Math.round((Date.parse(`${s.arriveAt.slice(0, 10)}T00:00:00Z`) - Date.parse(`${s.departAt.slice(0, 10)}T00:00:00Z`)) / 86400000));
      if (lastUtc != null) assert.ok(dep - lastUtc >= 65 * MINUTE, `${o.id}: the connection leaves after a layover`);
      if (firstUtc == null) firstUtc = dep;
      lastUtc = arr;
    }
    assert.equal(o.details.elapsedMinutes, (lastUtc - firstUtc) / MINUTE, `${o.id}: elapsed time in UTC`);
  }
}

test('demo flights: CAI to LHR in November leaves in Cairo time (UTC+2) and lands in London time (UTC+0)', () => {
  const p = new BusinessDemoFlights();
  const offers = p.buildOffers(flightQuery('CAI', 'LHR', '2026-11-12'));
  assert.equal(tz.offsetMinutes('Africa/Cairo', '2026-11-12T08:00:00Z'), 120);
  assert.equal(tz.offsetMinutes('Europe/London', '2026-11-12T08:00:00Z'), 0);
  checkTimes(offers, { CAI: 120, LHR: 0, IST: 180, DXB: 240 });
  const nonstop = offers.find(o => o.details.stops === 0);
  const s = nonstop.details.segments[0];
  assert.equal(s.durationMinutes, 307, 'CAI to LHR is 5 h 07 min of flying: short haul under 360');
  // The local clock moves 307 − 120 minutes: an 08:35 departure would land at 11:42 London time.
  assert.equal((Date.parse(`${s.arriveAt}:00Z`) - Date.parse(`${s.departAt}:00Z`)) / MINUTE, 307 - 120);
});

test('demo flights: CAI to DXB lands in Dubai time (UTC+4), and LHR to DXB evening flights land the next day (+1)', () => {
  const p = new BusinessDemoFlights();
  const cai = p.buildOffers(flightQuery('CAI', 'DXB', '2026-11-12'));
  checkTimes(cai, { CAI: 120, DXB: 240, IST: 180 });
  for (const o of cai.filter(x => x.details.stops === 0)) {
    const s = o.details.segments[0];
    assert.equal((Date.parse(`${s.arriveAt}:00Z`) - Date.parse(`${s.departAt}:00Z`)) / MINUTE, s.durationMinutes + 120, 'the clock runs 2 hours ahead');
  }
  const lhr = p.buildOffers(flightQuery('LHR', 'DXB', '2026-11-12'));
  checkTimes(lhr, { LHR: 0, DXB: 240, IST: 180, CAI: 120 });
  const late = lhr.filter(o => o.details.segments.at(-1).arriveAt.slice(0, 10) === '2026-11-13');
  assert.ok(late.length >= 1, 'at least one LHR to DXB itinerary lands the next day');
  for (const o of late) {
    assert.equal(o.details.segments.at(-1).arriveAt.slice(0, 10), '2026-11-13');
    assert.ok(o.details.segments.some(s => s.arriveDayOffset === 1), 'its arrival carries +1');
    assert.match(o.attributes.find(a => a.label === 'Arrive').value, /\(\+1\)$/);
  }
});

test('demo flights: the times follow daylight saving time on both sides of the change', () => {
  const p = new BusinessDemoFlights();
  // London moves to UTC+1 at 01:00 UTC on 29 March 2026; Cairo stays at UTC+2 until late April.
  checkTimes(p.buildOffers(flightQuery('CAI', 'LHR', '2026-03-28')), { CAI: 120, LHR: 0, IST: 180, DXB: 240 });
  checkTimes(p.buildOffers(flightQuery('CAI', 'LHR', '2026-03-29')), { CAI: 120, LHR: 60, IST: 180, DXB: 240 });
  // London is back on UTC+0 from 25 October 2026 while Cairo keeps summer time (UTC+3) until 29 October.
  checkTimes(p.buildOffers(flightQuery('CAI', 'LHR', '2026-10-27')), { CAI: 180, LHR: 0, IST: 180, DXB: 240 });
  checkTimes(p.buildOffers(flightQuery('LHR', 'CAI', '2026-10-27')), { CAI: 180, LHR: 0, IST: 180, DXB: 240 });
  // An overnight flight across London's change: leaves on the 28th (UTC+0), lands on the 29th.
  checkTimes(p.buildOffers(flightQuery('LHR', 'DXB', '2026-03-28')), { LHR: 0, DXB: 240, IST: 180, CAI: 120 });
});

test('demo flights: nonstops on a route are spread over the day, at least an hour apart', () => {
  const p = new BusinessDemoFlights();
  const codes = BUSINESS_CITIES.map(c => c.iata);
  let routes = 0;
  for (const from of codes) {
    for (const to of codes) {
      if (from === to) continue;
      for (let d = 1; d <= 28; d += 3) {
        const date = `2026-11-${String(d).padStart(2, '0')}`;
        const offers = p.buildOffers(flightQuery(from, to, date));
        const deps = offers.filter(o => o.details.stops === 0).map(o => {
          const t = o.details.segments[0].departAt;
          assert.equal(t.slice(0, 10), date, 'nonstops leave on the day searched');
          return Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
        }).sort((a, b) => a - b);
        assert.ok(deps.length >= 2 && deps.length <= 4, `${from}-${to} ${date}: 2 to 4 nonstops`);
        assert.ok(deps[0] >= 360 && deps.at(-1) <= 1260, 'between 06:00 and 21:00');
        for (let i = 1; i < deps.length; i++) assert.ok(deps[i] - deps[i - 1] >= 60, `${from}-${to} ${date}: ${deps.join(', ')}`);
        assert.equal(new Set(offers.map(o => o.id)).size, offers.length, 'offer ids are unique');
        routes += 1;
      }
    }
  }
  assert.ok(routes >= 800);
});

test('demo flights: Light and Classic are non-refundable, Flex refunds 70%, each quote passes the provider contract', async () => {
  const p = new BusinessDemoFlights();
  assertProvider(p, 'flights');
  assert.equal(p.name, 'BusinessDemoFlights');
  assert.equal(p.latencyMs, 0);
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(p)), MockFlightProvider.prototype, 'a subclass of the mock');
  const q = flightQuery('CAI', 'LHR', '2026-11-12');
  const offers = await p.search(q);
  const seen = new Set();
  for (const offer of offers) {
    validateOffer(offer, 'flights');
    assert.deepEqual(offer.cancellation, { ...OFFER_CANCELLATION }, 'the offer says the terms depend on the fare');
    assert.ok(!/7 days/.test(JSON.stringify(offer)), 'no "free cancellation up to 7 days" anywhere');
    for (const option of offer.options.filter(o => o.available)) {
      const quote = validateQuote(await p.quote({ offerId: offer.id, optionId: option.id, query: q }), 'flights');
      assert.deepEqual(quote.cancellation, { ...FARE_TERMS[option.id] });
      assert.deepEqual(quote.offer.cancellation, { ...FARE_TERMS[option.id] });
      const row = dto.flightRow(offer, option, quote, { leg: 'out', pricedAt: '2026-10-09T09:00:00.000Z' });
      dto.assertRow(row);
      if (option.id === 'FLEX') {
        assert.equal(quote.cancellation.type, 'partial');
        assert.equal(quote.cancellation.penaltyPercent, 30);
        assert.equal(row.fare.refundablePercent, 70);
        assert.equal(row.fare.terms, '70% refundable. Free changes.');
        assert.equal(row.fare.changeable, true);
        assert.equal(row.fare.checkedBags, 2);
      } else {
        assert.equal(quote.cancellation.type, 'non_refundable');
        assert.equal(quote.cancellation.penaltyPercent, 100);
        assert.equal(row.fare.refundablePercent, 0);
        assert.equal(row.fare.changeable, option.id === 'CLASSIC');
        assert.equal(row.fare.terms, option.id === 'LIGHT' ? 'Non-refundable. No changes.' : 'Non-refundable. Changes for a fee.');
        assert.equal(row.fare.checkedBags, option.id === 'LIGHT' ? 0 : 1);
      }
      seen.add(option.id);
    }
  }
  assert.deepEqual([...seen].sort(), ['CLASSIC', 'FLEX', 'LIGHT']);
});

test('demo flights: prices and carriers follow the Alamein Go schedule rules (same fare families, cabin multipliers)', () => {
  const p = new BusinessDemoFlights();
  const eco = p.buildOffers(flightQuery('CAI', 'LHR', '2026-11-12', 'economy'));
  const biz = p.buildOffers(flightQuery('CAI', 'LHR', '2026-11-12', 'business'));
  assert.deepEqual(eco.map(o => o.details.segments.map(s => s.flightNumber).join('-')).sort(), biz.map(o => o.details.segments.map(s => s.flightNumber).join('-')).sort(), 'the same flights in every cabin');
  for (const o of eco) {
    assert.deepEqual(o.options.map(x => x.id), FLIGHT_DATA.fareFamilies.map(f => f.code));
    assert.ok(o.options.every(x => x.price.amount > 0 && x.price.currency === 'USD'));
    assert.match(o.id, /^flt_[A-Z0-9-]+_2026-11-12_economy$/);
  }
  const cheapest = rows => Math.min(...rows.flatMap(o => o.options.map(x => x.price.amount)));
  assert.ok(cheapest(biz) > 2.5 * cheapest(eco), 'business costs about 3.1 times economy');
  assert.throws(() => p.buildOffers(flightQuery('CAI', 'XXX', '2026-11-12')), e => e.code === 'unknown_airport');
  assert.throws(() => p.buildOffers(flightQuery('CAI', 'CAI', '2026-11-12')), e => e.code === 'same_airport');
});

// ---------------------------------------------------------------------------------------------------------
// Hotels

/** The Standard nightly cap (taxes included) for a city: city, then country, then the default. */
function standardCap(city, country) {
  const h = defaultPolicy('standard').hotels;
  const c = h.countryCaps.find(x => x.country === country);
  const ci = c && c.cities.find(x => x.city === city);
  return ci ? ci.nightlyCents : c ? c.nightlyCents : h.defaultNightlyCents;
}

/** Each room's nightly total with taxes, in cents, from the provider's own price lines (1 night). */
function nightlyIncl(p, h) {
  const offer = p.toOffer(h, { checkIn: '2026-11-12', checkOut: '2026-11-13', guests: 1 }, 1);
  return offer.options.map(o => p.priceLines(offer, o).reduce((n, l) => n + l.amount, 0));
}

test('demo hotels: 29 fictional properties, no ratings or reviews, every Business city with a 3-, 4- and 5-star', () => {
  assert.equal(BUSINESS_HOTELS.length, 29);
  assert.ok(Object.isFrozen(BUSINESS_HOTELS) && Object.isFrozen(BUSINESS_HOTELS[0].rooms[0]), 'frozen data');
  const codes = BUSINESS_HOTELS.map(h => h.hotel_code);
  assert.equal(new Set(codes).size, 29);
  const all = [...ALAMEIN_HOTELS, ...BUSINESS_HOTELS];
  assert.equal(new Set(all.map(h => h.hotel_code)).size, all.length, 'no code clashes with the Alamein Go data');
  assert.equal(new Set(all.map(h => h.name)).size, all.length, 'no name clashes either');
  const brands = /\b(hilton|marriott|hyatt|sheraton|westin|ritz|carlton|four seasons|intercontinental|holiday inn|crowne|radisson|novotel|ibis|sofitel|mercure|pullman|accor|fairmont|raffles|kempinski|shangri|mandarin|peninsula|jumeirah|rotana|m[öo]venpick|swiss[öo]tel|steigenberger|wyndham|ramada|best western|hampton|conrad|waldorf|st\.? regis|m[ée]ridien|aloft|premier inn|travelodge|rosewood|aman|armani|atlantis|rixos|hard rock|banyan|anantara|one ?& ?only|kimpton|citizenm|motel one|melia|barcel[óo]|iberostar|savoy|dorchester|claridge|langham|corinthia|belmond|oberoi|taj|ascott|citadines|adagio|doubletree|bulgari|cipriani|hassler|pera palace|[cç][ıi]ra[gğ]an|grande bretagne|bayerischer|mena house|le bristol|plaza ath[ée]n[ée]e|george v|address|vida|rove|emaar|nobu|sls|w hotel|edition|mgallery|nh |leonardo|scandic|hotel indigo|staybridge|novum|motel)\b/i;
  // A same-city web search on all 29 names (8 Oct 2026) found real hotels whose distinctive name these demo
  // names used to share: Riverside Hotel (Cairo), Aureliano and Hotel Fontanella Borghese (Rome), Elia Ermou
  // (Athens), Hotel Bel Oranger (Paris); Lotus Hotel (Cairo) and Hotel Vespasiano (Rome) sat close to names
  // tried in their place. No demo hotel, code or room may carry those words in that city.
  const realHere = { Cairo: /\b(riverside|lotus)\b/i, Rome: /\b(aureliano|fontanella|vespasiano)\b/i, Athens: /\belia\b/i, Paris: /\boranger\b/i };
  for (const h of BUSINESS_HOTELS) {
    if (realHere[h.city]) {
      assert.doesNotMatch([h.name, h.hotel_code, ...h.rooms.map(r => r.name)].join(' '), realHere[h.city], `${h.name}: not the name of a real hotel in ${h.city}`);
    }
  }
  for (const h of BUSINESS_HOTELS) {
    assert.ok(!('review_score' in h) && !('review_count' in h), `${h.hotel_code}: no review score or count`);
    assert.doesNotMatch(h.name, brands, `${h.name}: no well-known hotel brand`);
    const text = [h.name, h.area, h.blurb, ...h.amenities, ...h.rooms.flatMap(r => [r.name, r.bed, ...r.features])].join(' ');
    assert.doesNotMatch(text, PRESSURE, `${h.hotel_code}: no pressure words`);
    assert.doesNotMatch(text, /—|\b(rated|rating|review|award|guest favou?rite|best|only \d|left|sold out|popular|booked)\b/i, `${h.hotel_code}: no claims`);
    assert.ok(h.cancel.nonrefundable === true || (h.cancel.free_days >= 1 && h.cancel.free_days <= 3), `${h.hotel_code}: non-refundable or free for 1 to 3 days`);
    assert.ok(h.rooms.length >= 2 && h.rooms.every(r => Number.isFinite(r.rate_usd) && r.rate_usd > 0 && r.sleeps >= 2));
    assert.ok(/^[A-Z]{2}-[A-Z]+$/.test(h.hotel_code) && dto.ROW_KEY_RE.test(`h.htl_${h.hotel_code}|${h.rooms[0].code}`), 'codes a form can carry');
    assert.ok(BUSINESS_CITIES.some(c => c.city === h.city && c.country === h.country), `${h.hotel_code}: a Business city`);
  }
  const taxes = new Map();
  for (const h of [...BUSINESS_HOTELS, ALAMEIN_HOTELS.find(x => x.hotel_code === 'CA-NILE')]) {
    const t = `${h.vat_pct}% VAT, $${h.city_tax_usd_per_night} a night`;
    assert.equal(taxes.get(h.country) || t, t, `${h.hotel_code}: one set of demo taxes per country (Egypt as CA-NILE)`);
    taxes.set(h.country, t);
  }
  assert.equal(taxes.size, 9);
  assert.ok(BUSINESS_HOTELS.some(h => h.cancel.nonrefundable) && BUSINESS_HOTELS.some(h => h.cancel.free_days === 1)
    && BUSINESS_HOTELS.some(h => h.cancel.free_days === 2) && BUSINESS_HOTELS.some(h => h.cancel.free_days === 3), 'mixed terms');

  const p = new BusinessDemoHotels();
  assertProvider(p, 'hotels');
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(p)), MockHotelProvider.prototype, 'a subclass of the mock');
  const where = p.lookups().where;
  for (const c of BUSINESS_CITIES) {
    const here = p.hotels.filter(h => h.city === c.city && h.country === c.country);
    assert.ok(here.length >= 3, `${c.city}: at least 3 hotels`);
    assert.deepEqual([...new Set(here.map(h => h.stars))].sort(), [3, 4, 5], `${c.city}: a 3-, 4- and 5-star`);
    assert.ok(where.includes(c.city), `${c.city}: in lookups()`);
    for (const h of here) assert.ok(where.includes(`${h.area}, ${h.city}`));
  }
  assert.equal(p.hotels.filter(h => h.city === 'Cairo').length, 3, 'Cairo: CA-NILE plus 2 new');
});

test('demo hotels: rates sit under, across and over each city\'s Standard cap (taxes included)', () => {
  const p = new BusinessDemoHotels();
  for (const c of BUSINESS_CITIES) {
    const cap = standardCap(c.city, c.country);
    const byStars = Object.fromEntries(p.hotels.filter(h => h.city === c.city).map(h => [h.stars, nightlyIncl(p, h)]));
    assert.ok(byStars[3].every(v => v < cap), `${c.city} 3-star under ${cap}: ${byStars[3]}`);
    assert.ok(Math.min(...byStars[4]) < cap && Math.max(...byStars[4]) > cap, `${c.city} 4-star across ${cap}: ${byStars[4]}`);
    assert.ok(byStars[5].every(v => v > cap), `${c.city} 5-star over ${cap}: ${byStars[5]}`);
  }
});

test('demo hotels: offers come from this.hotels, carry no rating, and price with VAT and city tax lines', async () => {
  const p = new BusinessDemoHotels();
  const q = { where: 'London', checkIn: '2026-11-12', checkOut: '2026-11-16', guests: 1 };
  const offers = await p.search(q);
  assert.deepEqual(offers.map(o => o.id).sort(), ['htl_LN-ALDERMOOR', 'htl_LN-KESTREL', 'htl_LN-LARKSPUR']);
  for (const o of offers) {
    validateOffer(o, 'hotels');
    assert.ok(!('rating' in o), `${o.id}: no rating`);
    assert.equal(o.details.nights, 4);
    assert.ok(o.options.every(x => typeof x.bed === 'string' && x.bed));
  }
  const kestrel = offers.find(o => o.id === 'htl_LN-KESTREL');
  const option = kestrel.options.find(x => x.available);
  const quote = validateQuote(await p.quote({ offerId: kestrel.id, optionId: option.id, query: q }), 'hotels');
  assert.deepEqual(quote.lines.map(l => l.code), ['room', 'vat'], 'London has no city tax, so no $0 line');
  assert.equal(quote.lines[1].amount, Math.round(quote.lines[0].amount * 20 / 100));
  const cairo = await p.search({ where: 'Cairo', checkIn: '2026-11-12', checkOut: '2026-11-14', guests: 1 });
  assert.deepEqual(cairo.map(o => o.id).sort(), ['htl_CA-DOKKI', 'htl_CA-NILE', 'htl_CA-ZAMALEK']);
  const nile = cairo.find(o => o.id === 'htl_CA-NILE');
  assert.deepEqual(nile.rating, { score: 4.6, count: 1290 }, 'the Alamein Go hotel keeps its own data (rows never show it)');
  const dokki = cairo.find(o => o.id === 'htl_CA-DOKKI');
  const dq = await p.quote({ offerId: dokki.id, optionId: dokki.options.find(x => x.available).id, query: { where: 'Cairo', checkIn: '2026-11-12', checkOut: '2026-11-14', guests: 1 } });
  assert.deepEqual(dq.lines.map(l => l.code), ['room', 'vat', 'city_tax']);
  assert.equal(dq.lines[2].amount, 300 * 2);
  assert.deepEqual(await p.search({ where: 'Hurghada', checkIn: '2026-11-12', checkOut: '2026-11-14', guests: 1 }), [], 'no demo hotels in Hurghada');
});

// ---------------------------------------------------------------------------------------------------------
// The inventory seam

test('inventory: overrides, then real providers, then Business demo inventory, else none', () => {
  const flights = overrideProvider(new BusinessDemoFlights());
  assert.equal(createBusinessInventory({ allowDemoInventory: false }, { registry: { get: () => null }, overrides: { flights } }).status, 'demo');
  const live = v => ({ name: `Live${v}`, vertical: v, isDemo: false });
  const reg = { get: v => live(v) };
  const l = createBusinessInventory({ allowDemoInventory: true }, { registry: reg });
  assert.equal(l.status, 'live');
  assert.deepEqual(l.carriers(), [], 'a real supplier names its own carriers');
  assert.equal(l.airports().length, FLIGHT_DATA.airports.length);
  const d = demoInventory();
  assert.equal(d.status, 'demo');
  assert.ok(d.flights instanceof BusinessDemoFlights && d.hotels instanceof BusinessDemoHotels);
  assert.equal(d.flights.latencyMs, 0);
  const demoRegistry = { get: v => (v === 'flights' ? new MockFlightProvider() : new MockHotelProvider()) };
  const d2 = createBusinessInventory({ allowDemoInventory: true }, { registry: demoRegistry });
  assert.ok(d2.flights instanceof BusinessDemoFlights, 'the registry\'s mock providers are never used');
  const none = createBusinessInventory({ allowDemoInventory: false }, { registry: demoRegistry });
  assert.equal(none.status, 'none');
  assert.equal(none.flights, null);
  assert.equal(none.hotels, null);
  assert.deepEqual(none.airports(), []);
  assert.deepEqual(none.carriers(), []);
  assert.equal(none.cityFor('LHR'), null);
});

test('inventory: airports with time zones, the demo carriers, and the hotel city for each airport', () => {
  const inv = demoInventory();
  const airports = inv.airports();
  assert.equal(airports.length, 14);
  for (const a of airports) {
    assert.deepEqual(Object.keys(a), ['code', 'name', 'city', 'country', 'tz']);
    assert.ok(tz.isTimeZone(a.tz), `${a.code}: ${a.tz}`);
  }
  airports[0].name = 'changed';
  assert.notEqual(inv.airports()[0].name, 'changed', 'copies');
  assert.deepEqual(inv.carriers(), FLIGHT_DATA.carriers.map(c => ({ code: c.code, name: c.name })));
  assert.deepEqual(inv.carriers().find(c => c.code === 'ZS'), { code: 'ZS', name: 'Sahara Wings' });
  assert.deepEqual(inv.cityFor('DBB'), { city: 'New Alamein', country: 'Egypt' });
  assert.deepEqual(inv.cityFor('CAI'), { city: 'Cairo', country: 'Egypt' });
  assert.deepEqual(inv.cityFor('lhr'), { city: 'London', country: 'United Kingdom' });
  assert.deepEqual(inv.cityFor(' HRG '), { city: 'Hurghada', country: 'Egypt' });
  assert.equal(inv.cityFor('XXX'), null);
  assert.equal(inv.cityFor(null), null);
  assert.equal(inv.cityFor(['LHR']), null);
  for (const c of BUSINESS_CITIES) assert.deepEqual(inv.cityFor(c.iata), { city: c.city, country: c.country }, c.iata);
});

test('inventory: production gives "Supplier not connected yet" and never loads the demo data', () => {
  const { execFileSync } = require('node:child_process');
  const code = `
    const { loadConfig } = require('./server/config');
    const { createRegistry } = require('./server/providers/registry');
    const { createBusinessInventory } = require('./server/business/inventory');
    const config = loadConfig({ APP_ENV: 'production', DATABASE_URL: 'postgres://x/prod', ENABLE_BUSINESS: 'true', ENABLE_TRIPS: 'false' });
    const inv = createBusinessInventory(config, { registry: createRegistry(config) });
    const loaded = Object.keys(require.cache).filter(f => /demo-data|business[\\\\/]demo[\\\\/]/.test(f));
    process.stdout.write(JSON.stringify({ allow: config.allowDemoInventory, status: inv.status, airports: inv.airports().length, loaded }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' }));
  assert.deepEqual(out, { allow: false, status: 'none', airports: 0, loaded: [] });
});

// ---------------------------------------------------------------------------------------------------------
// The allow-list rows

const PRICED_AT = '2026-10-09T09:00:00.000Z';
const FORBIDDEN_KEY = /^(net|internal|remaining|provider|rating|reviews?|reviewCount|media|badges|supplierQuoteRef|description|attributes|distanceKm|commission|markup|margin|aircraft|selection|startDate|capacity|features|subtitle|title|location)/i;

/** Every key of `value` matches the schema exactly, level by level (the key walk). */
function keyWalk(value, schema, path = 'row') {
  if (schema === true) {
    assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), `${path}: a plain value`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path}: finite`);
    return;
  }
  if (Array.isArray(schema)) {
    assert.ok(Array.isArray(value), `${path}: a list`);
    value.forEach((v, i) => keyWalk(v, schema[0], `${path}[${i}]`));
    return;
  }
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path}: an object`);
  assert.deepEqual(Object.keys(value).sort(), Object.keys(schema).sort(), `${path}: exactly the allowed keys`);
  for (const k of Object.keys(value)) {
    assert.doesNotMatch(k, FORBIDDEN_KEY, `${path}.${k}`);
    keyWalk(value[k], schema[k], `${path}.${k}`);
  }
}

async function demoRows() {
  const flights = new BusinessDemoFlights();
  const hotels = new BusinessDemoHotels();
  const hq = { where: 'Cairo', checkIn: '2026-11-12', checkOut: '2026-11-15', guests: 1 };
  const rows = [];
  for (const fq of [flightQuery('CAI', 'LHR', '2026-11-12'), flightQuery('LHR', 'DXB', '2026-11-12', 'business')]) {
    for (const offer of await flights.search(fq)) {
      for (const option of offer.options) {
        const quote = option.available ? await flights.quote({ offerId: offer.id, optionId: option.id, query: fq }) : null;
        rows.push(dto.flightRow(offer, option, quote, { leg: 'out', pricedAt: PRICED_AT }));
      }
    }
  }
  for (const offer of await hotels.search(hq)) {
    for (const option of offer.options) {
      const quote = option.available ? await hotels.quote({ offerId: offer.id, optionId: option.id, query: hq }) : null;
      rows.push(dto.hotelRow(offer, option, quote, { pricedAt: PRICED_AT, checkIn: hq.checkIn, checkOut: hq.checkOut }));
    }
  }
  return rows;
}

test('rows: the key walk finds exactly the allowed keys at every level, on real demo offers', async () => {
  const rows = await demoRows();
  assert.ok(rows.some(r => r.kind === 'flight' && r.available) && rows.some(r => r.kind === 'hotel' && r.available));
  assert.ok(rows.some(r => !r.available), 'the demo data has unavailable options too');
  for (const row of rows) {
    keyWalk(row, row.kind === 'flight' ? dto.FLIGHT_ROW_KEYS : dto.HOTEL_ROW_KEYS);
    assert.deepEqual(dto.extraKeys(row, row.kind === 'flight' ? dto.FLIGHT_ROW_KEYS : dto.HOTEL_ROW_KEYS), []);
    assert.equal(dto.assertRow(row), row);
    const text = JSON.stringify(row);
    assert.doesNotMatch(text, /BusinessDemo|Mock|MQ-|\/media\/|"rating"|review|remaining|seatsLeft|distanceKm/, 'nothing from the provider internals');
    assert.equal(row.demo, true);
    assert.equal(row.pricedAt, PRICED_AT);
    if (row.available) {
      assert.equal(row.totalCents, row.lines.reduce((n, l) => n + l.cents, 0), 'the total is the sum of the lines');
      assert.ok(row.lines.length >= 2);
    }
  }
  const hotel = rows.find(r => r.kind === 'hotel' && r.offerId === 'htl_CA-NILE');
  assert.ok(hotel && !('rating' in hotel), 'the Alamein Go hotel\'s rating never reaches a row');
  const h = rows.find(r => r.kind === 'hotel' && r.available && r.offerId === 'htl_CA-DOKKI');
  assert.equal(h.nights, 3);
  assert.equal(h.nightlyCents * 3, h.lines.find(l => l.kind === 'base').cents);
  assert.equal(h.nightlyInclCents, Math.round(h.totalCents / 3));
  assert.deepEqual(h.cancellation, { refundable: false, freeUntilHours: 0, text: 'Non-refundable. No refund if you cancel.' });
  assert.ok(h.amenities.length <= 4);
  const z = rows.find(r => r.kind === 'hotel' && r.available && r.offerId === 'htl_CA-ZAMALEK');
  assert.equal(z.cancellation.refundable, true);
  assert.equal(z.cancellation.freeUntilHours, 24);
  const f = rows.find(r => r.kind === 'flight' && r.stops === 1);
  assert.deepEqual(f.via, [{ code: f.segments[0].to.code, city: f.segments[0].to.city }]);
  assert.equal(f.flyingMinutes, f.segments[0].durationMinutes + f.segments[1].durationMinutes);
  assert.ok(f.elapsedMinutes > f.flyingMinutes, 'elapsed time includes the layover');
});

test('rows: an unavailable option has the flag and no price', async () => {
  const rows = await demoRows();
  for (const row of rows.filter(r => !r.available)) {
    assert.equal(row.totalCents, null);
    assert.deepEqual(row.lines, []);
    if (row.kind === 'hotel') {
      assert.equal(row.nightlyCents, null);
      assert.equal(row.nightlyInclCents, null);
    }
    dto.assertRow(row);
  }
});

test('rows: assertRow refuses an extra key at any level, a missing key, a stray null, NaN, a wrong key or a wrong total', async () => {
  const rows = await demoRows();
  const flight = rows.find(r => r.kind === 'flight' && r.available);
  const hotel = rows.find(r => r.kind === 'hotel' && r.available);
  const bad = (mutate, base = flight) => { const r = structuredClone(base); mutate(r); return r; };
  const cases = [
    [bad(r => { r.remaining = 3; }), /may not carry remaining/],
    [bad(r => { r.segments[0].aircraft = 'A320'; }), /segments\[0\]\.aircraft/],
    [bad(r => { r.fare.netCents = 100; }), /fare\.netCents/],
    [bad(r => { r.carrier = 'ZM'; }), /may not carry carrier$/],
    [bad(r => { r.carrier = null; }), /carrier is not an object/],
    [bad(r => { r.carrier.name = { internal: 1 }; }), /carrier\.name/],
    [bad(r => { r.flightNumbers = 'ZM1'; }), /flightNumbers/],
    [bad(r => { delete r.pricedAt; }), /pricedAt is missing/],
    [bad(r => { r.stops = null; }), /stops is null/],
    [bad(r => { r.elapsedMinutes = NaN; }), /not a finite number/],
    [bad(r => { r.totalCents += 1; }), /sum of the lines/],
    [bad(r => { r.key = r.key.replace('|', '|X'); }), /key does not match/],
    [bad(r => { r.leg = 'hotel'; }), /leg/],
    [bad(r => { r.demo = false; }), /demo is not true/],
    [bad(r => { r.available = false; }), /unavailable row may not carry a price/],
    [bad(r => { r.rating = { score: 4.5 }; }, hotel), /may not carry rating/],
    [bad(r => { r.nightlyCents = null; }, hotel), /nightlyCents is null/],
    [bad(r => { r.room.size = 30; }, hotel), /room\.size/],
    [bad(r => { r.kind = 'car'; }), /flight or a hotel/],
  ];
  for (const [row, re] of cases) assert.throws(() => dto.assertRow(row), re);
  const gone = bad(r => { r.available = false; r.lines = []; r.totalCents = null; r.nightlyCents = null; r.nightlyInclCents = null; }, hotel);
  assert.equal(dto.assertRow(gone), gone, 'a gone hotel row with every price null is fine');
});

test('rows: extraKeys reports dotted paths, and row keys round-trip through parseRowKey', () => {
  assert.deepEqual(dto.extraKeys({ key: 'k', extra: 1, segments: [{ flightNumber: 'x', supplier: 'y' }, { cost: 2 }] }, dto.FLIGHT_ROW_KEYS),
    ['extra', 'segments[0].supplier', 'segments[1].cost']);
  assert.deepEqual(dto.extraKeys({ carrier: ['ZM'], via: {}, lines: [{ cents: 1, net: 2 }] }, dto.FLIGHT_ROW_KEYS), ['carrier', 'via', 'lines[0].net']);
  assert.deepEqual(dto.extraKeys({ name: { a: 1 } }, dto.HOTEL_ROW_KEYS), ['name']);
  assert.deepEqual(dto.extraKeys([], dto.HOTEL_ROW_KEYS), ['(root)']);
  assert.deepEqual(dto.extraKeys({ checkIn: null, room: null }, dto.HOTEL_ROW_KEYS), []);

  const k = dto.rowKey('flight', 'flt_ZM429_2026-11-12_economy', 'LIGHT');
  assert.equal(k, 'f.flt_ZM429_2026-11-12_economy|LIGHT');
  assert.deepEqual(dto.parseRowKey(k), { kind: 'flight', offerId: 'flt_ZM429_2026-11-12_economy', optionId: 'LIGHT' });
  assert.deepEqual(dto.parseRowKey('h.htl_LN-KESTREL|DLX-DBL'), { kind: 'hotel', offerId: 'htl_LN-KESTREL', optionId: 'DLX-DBL' });
  for (const bad of ['f.htl_X|A', 'h.flt_X|A', 'f.flt_X', 'f.flt_X|', 'f.flt_X|A|B', 'x.flt_X|A', 'f.flt_X Y|A', `f.flt_${'x'.repeat(161)}|A`, 'f.flt_X|A\n', null, 42, ['f.flt_X|A']]) {
    assert.equal(dto.parseRowKey(bad), null, String(bad));
  }
  assert.throws(() => dto.rowKey('car', 'x', 'y'), TypeError);
});
