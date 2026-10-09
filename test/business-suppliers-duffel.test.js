// DuffelFlights (real-suppliers design §3.2, §5.2, §7.1): the mapping from a Duffel offer request to provider
// offers and rows, the filters, the mode check, and every price-check path. No network: an injected fetch
// answers from test/fixtures/suppliers/duffel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { supplierKit, testClock, loadFixture } = require('./supplier-fetch');
const { withCompany } = require('../server/business/scope');
const { validateOffer, validateQuote } = require('../server/providers/contracts');
const dto = require('../server/business/dto');
const { TERMS, sourceOf } = require('../server/business/source');
const { createPolicyEngine } = require('../server/business/policy');
const { defaultPolicy } = require('../server/business/policy/defaults');
const { MAX_PRICED_PER_LEG } = require('../server/business/search');
const { MAX_OPTIONS, parseDuration } = require('../server/business/suppliers/duffel');
const { parseMinor } = require('../server/business/suppliers/money');
const ids = require('../server/business/suppliers/ids');

const ORG = 'org_duffelTest000001';
const OFFER_REQUESTS = 'https://api.duffel.com/air/offer_requests';
const OFFERS = /^https:\/\/api\.duffel\.com\/air\/offers\//;
const PQ = Object.freeze({ from: 'CAI', to: 'LHR', departDate: '2026-11-12', passengers: 1, cabin: 'economy' });
const I1 = 'flt_t.ZZ1234_20261112T0835_economy';
const I2 = 'flt_t.ZZ88_20261112T1340_economy';
const I3 = 'flt_t.ZZ402-ZZ403_20261112T0510_economy';
const I4 = 'flt_t.ZZ990_20261112T1000_economy';
const I5 = 'flt_t.ZZ77_20261112T1520_economy';
const I6 = 'flt_t.BA154_20261112T0700_economy';

const inOrg = fn => withCompany(ORG, fn);
const search = (routes, opts = {}) => {
  const kit = supplierKit({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.cai-lhr.json' }, ...routes], ...opts });
  return kit;
};
/** Every row of one search, as the composer would build it (quote per option, then dto). */
async function rowsOf(kit, pq = PQ) {
  const { offers } = await kit.flights.searchDetailed(pq);
  const rows = [];
  for (const offer of offers) {
    validateOffer(offer, 'flights');
    for (const option of offer.options) {
      const quote = validateQuote(await kit.flights.quote({ offerId: offer.id, optionId: option.id, query: pq, offer }), 'flights');
      rows.push(dto.assertRow(dto.flightRow(offer, option, quote, { leg: 'out', pricedAt: offer.details.answeredAt })));
    }
  }
  return rows;
}
const row = (rows, offerId, optionId) => rows.find(r => r.offerId === offerId && r.optionId === optionId);

test('search: one request with the documented body and headers, the key only in Authorization', () => inOrg(async () => {
  const kit = search([]);
  await kit.flights.search(PQ);
  assert.equal(kit.ff.calls.length, 1);
  const call = kit.ff.calls[0];
  assert.equal(call.url, `${OFFER_REQUESTS}?return_offers=true&supplier_timeout=10000`);
  assert.deepEqual(call.body, { data: { slices: [{ origin: 'CAI', destination: 'LHR', departure_date: '2026-11-12' }], passengers: [{ type: 'adult' }], cabin_class: 'economy', max_connections: 1 } });
  assert.equal(call.headers['duffel-version'], 'v2');
  assert.equal(call.headers.accept, 'application/json');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['accept-encoding'], 'gzip');
  assert.match(call.headers['x-client-correlation-id'], /^[0-9a-f-]{36}$/);
  kit.ff.assertClean();
  // The cabin names Duffel uses.
  for (const [cabin, duffel] of [['premium', 'premium_economy'], ['business', 'business']]) {
    const k = search([]);
    await k.flights.search({ ...PQ, cabin });
    assert.equal(k.ff.calls[0].body.data.cabin_class, duffel);
  }
}));

test('search: itineraries grouped, fares as options cheapest first, filters counted', () => inOrg(async () => {
  const kit = search([]);
  const { offers, skipped, truncated } = await kit.flights.searchDetailed(PQ);
  assert.deepEqual(offers.map(o => o.id).sort(), [I1, I2, I3, I4, I5, I6].sort());
  assert.deepEqual(skipped, { firstCabin: 1, mixedCabin: 1, unknownCarrier: 1 });
  assert.equal(truncated, false);
  const byId = Object.fromEntries(offers.map(o => [o.id, o]));
  assert.deepEqual(byId[I1].options.map(o => [o.id, o.price.amount, o.price.currency]), [['basic', 24530, 'USD'], ['standard', 28990, 'USD'], ['flexible', 41200, 'USD']]);
  assert.deepEqual(byId[I2].options.map(o => [o.id, o.price.currency]), [['basic', 'USD'], ['standard', 'USD'], ['saver', 'GBP']], 'another currency is passed through, after the dollar fares');
  assert.deepEqual(byId[I3].options.map(o => o.id), ['economy-r0cx', 'standard'], 'no brand: the cabin name with its condition flags');
  assert.deepEqual(byId[I6].options.map(o => o.id), ['economy-basic-r0c1']);
  for (const o of offers) {
    validateOffer(o, 'flights');
    assert.equal(o.demo, true);
    assert.equal(sourceOf(o.id), 'sandbox');
    assert.equal(o.provider, 'DuffelFlights');
    assert.equal(o.details.cabin, 'economy');
    assert.equal(o.details.answeredAt, '2026-10-09T09:00:00.000Z');
    assert.ok(!JSON.stringify(o).includes('off_'), 'no Duffel offer id leaves the adapter');
    assert.ok(!JSON.stringify(o).includes('pas_'), 'no passenger id either');
  }
  kit.ff.assertClean();
}));

test('search: ids are stable across two searches (fresh adapters, same answer)', () => inOrg(async () => {
  const a = await search([]).flights.search(PQ);
  const b = await search([]).flights.search(PQ);
  assert.deepEqual(a.map(o => [o.id, o.options.map(x => x.id)]), b.map(o => [o.id, o.options.map(x => x.id)]));
  for (const o of a) for (const opt of o.options) assert.match(dto.rowKey('flight', o.id, opt.id), dto.ROW_KEY_RE);
  assert.equal(ids.flightOptionId({ brand: 'A'.repeat(60), cabin: 'economy' }).length, 40);
  assert.notEqual(ids.flightOptionId({ brand: `${'A'.repeat(60)}1`, cabin: 'economy' }), ids.flightOptionId({ brand: `${'A'.repeat(60)}2`, cabin: 'economy' }));
}));

test('search: the cheapest 60 options are kept and `truncated` says more existed', () => inOrg(async () => {
  assert.equal(MAX_OPTIONS, MAX_PRICED_PER_LEG, 'the adapter keeps what one leg prices');
  const kit = supplierKit({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply: 'duffel/offer-request.many.json' }] });
  const { offers, truncated } = await kit.flights.searchDetailed(PQ);
  const prices = offers.flatMap(o => o.options.map(x => x.price.amount)).sort((x, y) => x - y);
  assert.equal(prices.length, 60);
  assert.equal(truncated, true);
  assert.equal(prices[0], 15000);
  assert.equal(prices[59], 15000 + 59 * 350, 'the 60 cheapest, not the first 60 answered');
}));

test('rows: every field of §3.2 for a nonstop ZZ fare', () => inOrg(async () => {
  const rows = await rowsOf(search([]));
  const r = row(rows, I1, 'standard');
  assert.deepEqual(r.carrier, { code: 'ZZ', name: 'Test airline' });
  assert.deepEqual(r.flightNumbers, ['ZZ1234']);
  assert.deepEqual(r.segments, [{
    carrier: { code: 'ZZ', name: 'Test airline' }, flightNumber: 'ZZ1234', from: { code: 'CAI', city: 'Cairo' }, to: { code: 'LHR', city: 'London' },
    departLocal: '2026-11-12T08:35', arriveLocal: '2026-11-12T12:50', arriveDayOffset: 0, durationMinutes: 375,
  }]);
  assert.equal(r.stops, 0);
  assert.deepEqual(r.via, []);
  assert.equal(r.flyingMinutes, 375);
  assert.equal(r.elapsedMinutes, 375);
  assert.equal(r.cabin, 'economy');
  assert.deepEqual(r.fare, {
    code: 'standard', name: 'Standard', cabinKg: 0, checkedBags: 1, checkedKg: 0, changeable: true,
    refundablePercent: 82, // floor((289.90 − 50.00) × 100 / 289.90)
    terms: 'Refunds: allowed for a fee of 50.00 USD set by the airline. Changes: allowed for a fee of 25.00 USD set by the airline. Bags: 1 checked bag, 1 carry-on bag.',
  });
  assert.deepEqual(r.lines, [{ label: 'Fare', kind: 'base', cents: 24000 }, { label: 'Taxes and airline charges', kind: 'tax', cents: 4990 }]);
  assert.equal(r.totalCents, 28990);
  assert.equal(r.currency, 'USD');
  assert.equal(r.demo, true);
  assert.equal(r.available, true);
  assert.deepEqual(dto.extraKeys(r, dto.FLIGHT_ROW_KEYS), []);
  // Basic: nothing allowed; Flexible: free.
  assert.equal(row(rows, I1, 'basic').fare.terms, 'Refunds: not allowed. Changes: not allowed. Bags: no checked bag, 1 carry-on bag.');
  assert.equal(row(rows, I1, 'basic').fare.refundablePercent, 0);
  assert.equal(row(rows, I1, 'basic').fare.changeable, false);
  assert.equal(row(rows, I1, 'flexible').fare.refundablePercent, 100);
  assert.equal(row(rows, I1, 'flexible').fare.terms, 'Refunds: allowed with no fee. Changes: free changes allowed. Bags: 2 checked bags, 1 carry-on bag.');
}));

test('quote: cancellation from the refund rule, the summary is the whole terms text', () => inOrg(async () => {
  const kit = search([]);
  const offers = await kit.flights.search(PQ);
  const i1 = offers.find(o => o.id === I1);
  const q = async (offer, optionId) => kit.flights.quote({ offerId: offer.id, optionId, query: PQ, offer });
  const standard = await q(i1, 'standard');
  const terms = 'Refunds: allowed for a fee of 50.00 USD set by the airline. Changes: allowed for a fee of 25.00 USD set by the airline. Bags: 1 checked bag, 1 carry-on bag.';
  assert.deepEqual(standard.cancellation, { type: 'partial', freeUntilHours: 0, penaltyPercent: 18, summary: terms }, 'ceil(50.00 × 100 / 289.90)');
  assert.equal((await q(i1, 'flexible')).cancellation.type, 'free');
  assert.equal((await q(i1, 'basic')).cancellation.type, 'non_refundable');
  assert.equal(standard.startDate, '2026-11-12');
  assert.equal(standard.currency, 'USD');
  await assert.rejects(q(i1, 'nope'), e => e.status === 404);
}));

test('rows: an in-segment stop is a stop, `via` names it, and a nonstop-only policy rejects the fare', () => inOrg(async () => {
  const rows = await rowsOf(search([]));
  const r = row(rows, I4, 'basic');
  assert.equal(r.segments.length, 1, 'one segment');
  assert.equal(r.stops, 1);
  assert.deepEqual(r.via, [{ code: 'ATH', city: 'Athens' }]);
  const connection = row(rows, I3, 'standard');
  assert.equal(connection.stops, 1);
  assert.deepEqual(connection.via, [{ code: 'IST', city: 'Istanbul' }]);
  assert.equal(connection.elapsedMinutes, 470, 'the slice duration (Cairo UTC+2 to Istanbul UTC+3 to London UTC+0)');
  assert.equal(connection.flyingMinutes, 100 + 250);
  const rules = defaultPolicy('standard');
  rules.flights.longHaul.maxStops = 0;
  rules.flights.longHaul.minAdvanceDays = 0;
  const e = createPolicyEngine().evaluateComponent(r, { rules, policy: { tier: 'standard', version: 1 }, outOfPolicy: 'approval', today: '2026-10-09', benchmarks: {}, carriers: {}, orgName: 'Acme Inc' });
  assert.ok(e.violations.some(v => v.rule === 'flight.stops' && v.actual === 1), 'nonstop only: the in-segment stop counts');
}));

test('rows: the conditions are read slice first, then offer; unknown ones never become "not allowed"', () => inOrg(async () => {
  const rows = await rowsOf(search([]));
  assert.equal(row(rows, I2, 'standard').fare.terms, 'Refunds: allowed for a fee of 60.00 GBP set by the airline. Changes: allowed for a fee of 40.00 USD set by the airline. Bags: 1 checked bag, 1 carry-on bag.', 'the slice-level change penalty');
  assert.equal(row(rows, I2, 'standard').fare.refundablePercent, 0, 'a fee in another currency is not counted as known');
  assert.equal(row(rows, I2, 'basic').fare.terms, 'Refunds: the airline doesn\'t say (NEEDS VERIFICATION). Changes: not allowed. Bags: no checked bag, 1 carry-on bag.');
  const unknown = row(rows, I3, 'economy-r0cx');
  assert.equal(unknown.fare.terms, `${TERMS.fare({ refund: { allowed: false, penaltyAmount: null, penaltyCurrency: null }, change: null, bags: { checked: 1, carryOn: 1 } })}`);
  assert.ok(unknown.fare.terms.includes("Changes: the airline doesn't say (NEEDS VERIFICATION)."), 'priced row: change null at both levels');
  assert.equal(unknown.fare.changeable, false);
}));

test('rows: ZZ is "Test airline", another owner keeps its name, the seller is the row carrier in a codeshare', () => inOrg(async () => {
  const rows = await rowsOf(search([]));
  const ba = row(rows, I6, 'economy-basic-r0c1');
  assert.deepEqual(ba.carrier, { code: 'BA', name: 'British Airways' });
  assert.equal(ba.fare.name, 'Economy Basic');
  const share = row(rows, I5, 'basic');
  assert.deepEqual(share.carrier, { code: 'ZZ', name: 'Test airline' }, 'the airline selling the fare');
  assert.deepEqual(share.segments[0].carrier, { code: 'MS', name: 'EgyptAir' }, 'the airline flying it');
  assert.equal(share.segments[0].flightNumber, 'ZZ77');
  assert.equal(share.segments[0].durationMinutes, 375, 'no duration from Duffel: from the local times');
}));

test('rows: a null tax gives one line; amounts are exact minor units', () => inOrg(async () => {
  const rows = await rowsOf(search([]));
  assert.deepEqual(row(rows, I3, 'standard').lines, [{ label: 'Fare including taxes', kind: 'base', cents: 23600 }]);
  assert.deepEqual(parseMinor('245.30', 'USD'), { minor: 24530, rounded: false });
  assert.deepEqual(parseMinor('0.1', 'USD'), { minor: 10, rounded: false });
  assert.deepEqual(parseMinor('1.005', 'USD'), { minor: 101, rounded: true }, 'half-up, never floating point');
  assert.deepEqual(parseMinor(105.5, 'USD'), { minor: 10550, rounded: false });
  assert.deepEqual(parseMinor('12.345', 'KWD'), { minor: 12345, rounded: false });
  assert.deepEqual(parseMinor('1200', 'JPY'), { minor: 1200, rounded: false });
  for (const bad of ['-1', '1e3', 'abc', '', null, Infinity, -5]) assert.equal(parseMinor(bad, 'USD'), null);
  assert.equal(parseMinor('1.00', 'usd'), null);
}));

test('search: DST and the duration cross-check (local times are airport-local)', () => inOrg(async () => {
  // 25 Oct 2026: London leaves summer time at 01:00 UTC; Cairo is still UTC+3 until 29 Oct.
  const onChangeDay = body => {
    const o = body.data.offers[0];
    const seg = o.slices[0].segments[0];
    seg.departing_at = '2026-10-25T08:35:00';
    seg.arriving_at = '2026-10-25T12:50:00';
    seg.duration = 'PT7H15M'; // 05:35Z to 12:50Z
    o.slices[0].duration = 'PT7H15M';
    body.data.offers = [o];
    return body;
  };
  const kit = supplierKit({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply: { fixture: 'duffel/offer-request.cai-lhr.json', transform: onChangeDay } }] });
  const offers = await kit.flights.search({ ...PQ, departDate: '2026-10-25' });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].details.elapsedMinutes, 435);
  assert.equal(offers[0].details.segments[0].durationMinutes, 435);
  // A duration that disagrees with the local times by more than a minute: dropped and counted.
  const wrong = body => { body.data.offers[0].slices[0].segments[0].duration = 'PT5H15M'; return body; };
  const k2 = supplierKit({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply: { fixture: 'duffel/offer-request.cai-lhr.json', transform: wrong } }] });
  const d = await k2.flights.searchDetailed(PQ);
  assert.equal(d.skipped.timeMismatch, 1);
  assert.deepEqual(d.offers.find(o => o.id === I1).options.map(o => o.id), ['standard', 'flexible']);
  // No duration at all (I5): the check is skipped, never failed.
  assert.ok(d.offers.some(o => o.id === I5));
  assert.equal(parseDuration('PT02H26M'), 146);
  assert.equal(parseDuration('P1DT2H'), 1560);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration('PT'), null);
}));

test('mode: live_mode true, or missing, fails closed with 503 and latches flights off', async () => {
  for (const fixture of ['duffel/offer-request.live-mode-true.json', 'duffel/offer-request.live-mode-missing.json']) {
    const kit = supplierKit({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply: fixture }] });
    await withCompany(ORG, async () => {
      await assert.rejects(kit.flights.search(PQ), e => e.code === 'supplier_unavailable' && e.status === 503 && e.message === 'Flights are not available right now. Please try again in a few minutes.');
      assert.equal(kit.state.latched.duffel, true);
      assert.match(kit.state.problem(), /DUFFEL_ACCESS_TOKEN/);
      await assert.rejects(kit.flights.search(PQ), e => e.code === 'supplier_unavailable');
      await assert.rejects(kit.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'basic' }), e => e.code === 'supplier_unavailable');
      assert.equal(kit.ff.calls.length, 1, 'latched: no further call');
      assert.equal(kit.log.lines.filter(l => l.text.includes('mode_mismatch')).length, 1, 'logged once');
      assert.ok(!kit.log.text().includes('off_'), 'the answer is not logged');
    });
  }
  // A single offer in the wrong mode is enough.
  const oneLive = body => { body.data.offers[3].live_mode = true; return body; };
  const kit = supplierKit({ routes: [{ method: 'POST', url: OFFER_REQUESTS, reply: { fixture: 'duffel/offer-request.cai-lhr.json', transform: oneLive } }] });
  await withCompany(ORG, () => assert.rejects(kit.flights.search(PQ), e => e.code === 'supplier_unavailable'));
  assert.equal(kit.state.latched.duffel, true);
});

test('mode: a GET /air/offers answer with live_mode true, or none, fails closed at confirm and at peek, and latches', async () => {
  const cases = [['true', b => { b.data.live_mode = true; return b; }], ['missing', b => { delete b.data.live_mode; return b; }]];
  for (const check of ['confirm', 'peek']) {
    for (const [label, transform] of cases) {
      const clock = testClock();
      const kit = search([{ method: 'GET', url: OFFERS, reply: { fixture: 'duffel/offer.get.json', transform } }], { clock });
      await withCompany(ORG, async () => {
        await kit.flights.search(PQ);
        if (check === 'peek') clock.advance(301 * 1000); // the search is stale, its Duffel offer is not: peek GETs it
        await assert.rejects(kit.flights.getOffer(I1, { ...PQ, check }, { optionId: 'standard' }),
          e => e.code === 'supplier_unavailable' && e.status === 503, `${check}, live_mode ${label}: an outage, never skipped or stale`);
        assert.equal(kit.ff.calls.filter(c => c.method === 'GET').length, 1, `${check}, live_mode ${label}`);
        assert.equal(kit.state.latched.duffel, true, `${check}, live_mode ${label}: latched`);
        assert.match(kit.state.problem(), /DUFFEL_ACCESS_TOKEN/);
        const n = kit.ff.calls.length;
        await assert.rejects(kit.flights.search({ ...PQ, departDate: '2026-11-13' }), e => e.code === 'supplier_unavailable');
        await assert.rejects(kit.flights.getOffer(I1, { ...PQ, check: 'auto' }, { optionId: 'standard' }), e => e.code === 'supplier_unavailable');
        await assert.rejects(kit.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' }), e => e.code === 'supplier_unavailable');
        assert.equal(kit.ff.calls.length, n, 'latched: later calls fail fast, with no call');
        assert.equal(kit.log.lines.filter(l => l.text.includes('mode_mismatch')).length, 1, 'logged once');
        assert.ok(!kit.log.text().includes('off_'), 'the answer is not logged');
      });
    }
  }
});

test('a price check refreshes the cached search: auto and peek then serve the newer price, with no extra call', () => inOrg(async () => {
  const clock = testClock();
  const kit = search([{ method: 'GET', url: OFFERS, reply: 'duffel/offer.get.price-changed.json' }], { clock });
  const price = async check => {
    const o = await kit.flights.getOffer(I1, { ...PQ, check }, { optionId: 'standard' });
    const q = await kit.flights.quote({ offerId: I1, optionId: 'standard', query: { ...PQ, check }, offer: o });
    return q.lines.reduce((n, l) => n + l.amount, 0);
  };
  const before = await kit.flights.searchDetailed(PQ);
  assert.equal(await price('auto'), 28990);
  clock.advance(60 * 1000);
  assert.equal(await price('confirm'), 30140, 'the GET shows a new total_amount');
  const n = kit.ff.calls.length;
  assert.equal(await price('peek'), 30140, 'peek: the newer price');
  assert.equal(await price('auto'), 30140, 'auto: the newer price');
  const after = await kit.flights.searchDetailed(PQ);
  const i1 = after.offers.find(o => o.id === I1);
  assert.deepEqual(i1.options.map(o => [o.id, o.price.amount]), [['basic', 24530], ['standard', 30140], ['flexible', 41200]], 'the other fares keep theirs');
  assert.equal(i1.details.answeredAt, '2026-10-09T09:00:00.000Z', 'never claims a fresher time than its oldest fare');
  const others = r => r.offers.filter(o => o.id !== I1);
  assert.deepEqual(others(after), others(before), 'the other itineraries are untouched');
  assert.deepEqual(after.skipped, before.skipped);
  assert.equal(kit.ff.calls.length, n, 'all from the cache');
  // Times that moved make the cached itinerary stale as a whole: it is not served again from the old search.
  const moved = body => { const seg = body.data.slices[0].segments[0]; seg.departing_at = '2026-11-12T08:50:00'; seg.arriving_at = '2026-11-12T13:05:00'; return body; };
  const k2 = search([{ method: 'GET', url: OFFERS, reply: { fixture: 'duffel/offer.get.json', transform: moved } }]);
  await k2.flights.search(PQ);
  const fresh = await k2.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' });
  assert.equal(fresh.details.segments[0].departAt, '2026-11-12T08:50');
  const auto = await k2.flights.getOffer(I1, { ...PQ, check: 'auto' }, { optionId: 'standard' });
  assert.equal(auto.details.segments[0].departAt, '2026-11-12T08:50', 'auto: the times the check saw');
}));

test('getOffer: another namespace answers null with no call', () => inOrg(async () => {
  const kit = search([]);
  for (const id of ['flt_ZM429_2026-11-12_economy', 'flt_l.ZZ1234_20261112T0835_economy', 'htl_t.lp1001', 'flt_T.x', null]) {
    assert.equal(await kit.flights.getOffer(id, { ...PQ, check: 'confirm' }, { optionId: 'basic' }), null);
  }
  assert.equal(kit.ff.calls.length, 0);
}));

test('getOffer auto and peek: a cached search answers with no call', () => inOrg(async () => {
  const kit = search([{ method: 'GET', url: OFFERS, reply: 'duffel/offer.get.json' }]);
  await kit.flights.search(PQ);
  for (const check of [undefined, 'auto', 'peek']) {
    const o = await kit.flights.getOffer(I1, { ...PQ, check }, { optionId: 'standard' });
    assert.equal(o.id, I1);
    assert.equal(o.details.answeredAt, '2026-10-09T09:00:00.000Z');
  }
  assert.equal(kit.ff.calls.length, 1, 'only the search');
}));

test('getOffer peek: never a search; one GET while the cached Duffel offer is valid; else live_check_skipped', () => inOrg(async () => {
  const clock = testClock();
  const kit = search([{ method: 'GET', url: OFFERS, reply: 'duffel/offer.get.json' }], { clock });
  // Nothing searched yet: skipped, no call.
  await assert.rejects(kit.flights.getOffer(I1, { ...PQ, check: 'peek' }, { optionId: 'standard' }), e => e.code === 'live_check_skipped' && e.status === 503 && e.message === 'The price is checked again when you approve.');
  assert.equal(kit.ff.calls.length, 0);
  await kit.flights.search(PQ);
  clock.advance(301 * 1000); // the search's results are stale; its Duffel offers still have 23 minutes
  const o = await kit.flights.getOffer(I1, { ...PQ, check: 'peek' }, { optionId: 'standard' });
  assert.deepEqual(o.options.map(x => [x.id, x.price.amount]), [['standard', 28990]]);
  assert.equal(kit.ff.calls.length, 2);
  assert.equal(kit.ff.calls[1].method, 'GET');
  assert.equal(kit.ff.calls[1].url, 'https://api.duffel.com/air/offers/off_0000AAAA0000000000000002');
  // The Duffel offer now expires within the minute: no GET, no search.
  clock.set('2026-10-09T09:29:30.000Z');
  await assert.rejects(kit.flights.getOffer(I1, { ...PQ, check: 'peek' }, { optionId: 'standard' }), e => e.code === 'live_check_skipped');
  assert.equal(kit.ff.calls.filter(c => c.method === 'POST').length, 1, 'peek never searched');
}));

test('getOffer peek: a GET that fails ends as skipped, never as an outage', () => inOrg(async () => {
  const clock = testClock();
  const kit = search([{ method: 'GET', url: OFFERS, reply: 'duffel/error.500.json' }], { clock });
  await kit.flights.search(PQ);
  clock.advance(301 * 1000);
  await assert.rejects(kit.flights.getOffer(I1, { ...PQ, check: 'peek' }, { optionId: 'standard' }), e => e.code === 'live_check_skipped');
}));

test('getOffer confirm: GET the selected fare; a new total_amount is the new price', () => inOrg(async () => {
  const kit = search([{ method: 'GET', url: OFFERS, reply: ['duffel/offer.get.json', 'duffel/offer.get.price-changed.json', 'duffel/offer.get.terms-changed.json'] }]);
  await kit.flights.search(PQ);
  const check = async () => {
    const o = await kit.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' });
    const q = await kit.flights.quote({ offerId: I1, optionId: 'standard', query: PQ, offer: o });
    return dto.flightRow(o, o.options[0], q, { leg: 'out', pricedAt: o.details.answeredAt });
  };
  const same = await check();
  assert.equal(same.totalCents, 28990);
  const moved = await check();
  assert.equal(moved.totalCents, 30140);
  assert.equal(moved.optionId, 'standard');
  const terms = await check();
  assert.equal(terms.totalCents, 28990);
  assert.match(terms.fare.terms, /^Refunds: not allowed\./);
  assert.equal(kit.ff.calls.filter(c => c.method === 'POST').length, 1, 'no search while the offer is valid');
  assert.equal(kit.ff.calls.filter(c => c.method === 'GET').length, 3);
  assert.ok(kit.ff.calls.every(c => c.method === 'POST' || c.url.endsWith('off_0000AAAA0000000000000002')));
}));

test('getOffer confirm and final: an unknown or expired Duffel offer re-runs the search first', () => inOrg(async () => {
  const clock = testClock();
  // Each answer's offers expire 30 minutes after it is given.
  const fresh = body => {
    const expires = new Date(clock.now().getTime() + 30 * 60 * 1000).toISOString();
    for (const o of body.data.offers || [body.data]) o.expires_at = expires;
    return body;
  };
  const kit = supplierKit({ clock, routes: [
    { method: 'POST', url: OFFER_REQUESTS, reply: { fixture: 'duffel/offer-request.cai-lhr.json', transform: fresh } },
    { method: 'GET', url: OFFERS, reply: { fixture: 'duffel/offer.get.json', transform: fresh } },
  ] });
  const o = await kit.flights.getOffer(I1, { ...PQ, check: 'final' }, { optionId: 'standard' });
  assert.equal(o.options[0].price.amount, 28990);
  assert.deepEqual(kit.ff.calls.map(c => c.method), ['POST', 'GET']);
  // The re-search is stored: the search that follows (submit's benchmark search) is a cache hit.
  await kit.flights.search(PQ);
  assert.equal(kit.ff.calls.length, 2);
  // Hours later: the Duffel offers have expired, so the leg is searched again before the GET.
  clock.set('2026-10-09T15:00:00.000Z');
  await kit.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' });
  assert.deepEqual(kit.ff.calls.map(c => c.method), ['POST', 'GET', 'POST', 'GET']);
}));

test('getOffer confirm: offer_expired re-searches once; gone from the fresh search is null (unavailable)', () => inOrg(async () => {
  const kit = search([{ method: 'GET', url: OFFERS, reply: ['duffel/error.offer-expired.json', 'duffel/offer.get.json'] }]);
  await kit.flights.search(PQ);
  const o = await kit.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' });
  assert.equal(o.options[0].price.amount, 28990);
  assert.deepEqual(kit.ff.calls.map(c => c.method), ['POST', 'GET', 'POST', 'GET']);
  // Gone: offer_no_longer_available, and the fresh search no longer has the itinerary.
  let searches = 0;
  const withoutI1 = body => { searches += 1; if (searches > 1) body.data.offers = body.data.offers.filter(x => x.slices[0].segments[0].marketing_carrier_flight_number !== '1234'); return body; };
  const k2 = supplierKit({ routes: [
    { method: 'POST', url: OFFER_REQUESTS, reply: { fixture: 'duffel/offer-request.cai-lhr.json', transform: withoutI1 } },
    { method: 'GET', url: OFFERS, reply: 'duffel/error.offer-no-longer-available.json' },
  ] });
  await k2.flights.search(PQ);
  assert.equal(await k2.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' }), null);
  // A 404 is gone too; still gone after the re-search: null.
  const k3 = search([{ method: 'GET', url: OFFERS, reply: { status: 404, body: { errors: [{ type: 'invalid_request_error', code: 'not_found' }] } } }]);
  await k3.flights.search(PQ);
  assert.equal(await k3.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' }), null);
  assert.deepEqual(k3.ff.calls.map(c => c.method), ['POST', 'GET', 'POST', 'GET'], 'one re-search, never a loop');
  // A fare that is no longer offered after the re-search: null.
  const k4 = search([{ method: 'GET', url: OFFERS, reply: 'duffel/offer.get.json' }]);
  assert.equal(await k4.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'no-such-fare' }), null);
}));

test('getOffer confirm: an outage answers 503, never stale data', () => inOrg(async () => {
  const kit = search([{ method: 'GET', url: OFFERS, reply: { fixture: 'duffel/error.500.json', status: 503 } }]);
  await kit.flights.search(PQ);
  await assert.rejects(kit.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' }), e => e.code === 'supplier_unavailable' && e.status === 503);
  assert.equal(kit.ff.calls.filter(c => c.method === 'GET').length, 3, 'a GET answered 503 is retried twice');
  const k500 = search([{ method: 'GET', url: OFFERS, reply: 'duffel/error.500.json' }]);
  await k500.flights.search(PQ);
  await assert.rejects(k500.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' }), e => e.code === 'supplier_unavailable');
  assert.equal(k500.ff.calls.filter(c => c.method === 'GET').length, 1, 'a 500 is not in the retry list (§4.2)');
  const auth = search([{ method: 'GET', url: OFFERS, reply: 'duffel/error.auth.json' }]);
  await auth.flights.search(PQ);
  await assert.rejects(auth.flights.getOffer(I1, { ...PQ, check: 'confirm' }, { optionId: 'standard' }), e => e.code === 'supplier_unavailable');
  assert.equal(auth.ff.calls.filter(c => c.method === 'GET').length, 1, 'never retried');
  assert.ok(auth.log.text().includes('Duffel refused the access token'));
  assert.ok(!auth.log.text().includes(auth.keys.token));
}));

test('book and cancel: booking is not open', async () => {
  const kit = search([]);
  await assert.rejects(kit.flights.book(), e => e.code === 'booking_not_open' && e.status === 409 && e.message === 'Booking is not open yet.');
  await assert.rejects(kit.flights.cancel(), e => e.code === 'booking_not_open');
  assert.equal(kit.flights.isDemo, true);
  assert.equal(kit.flights.vertical, 'flights');
  assert.ok(!Object.keys(kit.flights).some(k => /token|key|auth/i.test(k)), 'the token is not a field');
  assert.ok(!JSON.stringify(kit.flights, (k, v) => (typeof v === 'function' ? undefined : v)).includes(kit.keys.token));
});

test('fixtures: every Duffel fixture names its documentation page', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, 'fixtures', 'suppliers', 'duffel');
  for (const f of fs.readdirSync(dir)) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.match(raw._source, /^https:\/\/(duffel\.com\/docs|raw\.githubusercontent\.com\/duffelhq)\//, f);
    assert.ok(loadFixture(`duffel/${f}`).body, f);
  }
});
