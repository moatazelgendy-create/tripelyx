// LiteApiHotels (real-suppliers design §3.1, §3.3, §3.4, §5.3, §7.1): rates to hotel offers and rows, lines and
// taxes, the sandbox check, the price-check levels and every prebook path. No network: an injected fetch answers
// from test/fixtures/suppliers/liteapi.
const test = require('node:test');
const assert = require('node:assert/strict');
const { supplierKit, testClock, loadFixture } = require('./supplier-fetch');
const { withCompany } = require('../server/business/scope');
const { validateOffer, validateQuote } = require('../server/providers/contracts');
const dto = require('../server/business/dto');
const { TERMS, sourceOf } = require('../server/business/source');

const ORG = 'org_liteapiTest00001';
const RATES = 'https://api.liteapi.travel/v3.0/hotels/rates';
const PREBOOK = /^https:\/\/book\.liteapi\.travel\/v3\.0\/rates\/prebook\?timeout=\d+$/;
const PQ = Object.freeze({ where: 'Cairo', country: 'Egypt', checkIn: '2026-11-12', checkOut: '2026-11-14', guests: 1 });
const inOrg = fn => withCompany(ORG, fn);
const cityOrHotel = c => (c.body.hotelIds ? 'liteapi/rates.hotel.json' : 'liteapi/rates.cairo.json');
const kitWith = (prebook = [], opts = {}) => supplierKit({
  routes: [{ method: 'POST', url: RATES, reply: cityOrHotel }, { method: 'POST', url: PREBOOK, reply: prebook }],
  ...opts,
});

async function rowsOf(kit, pq = PQ) {
  const { offers } = await kit.hotels.searchDetailed(pq);
  const rows = [];
  for (const offer of offers) {
    validateOffer(offer, 'hotels');
    for (const option of offer.options) {
      const quote = validateQuote(await kit.hotels.quote({ offerId: offer.id, optionId: option.id, query: pq, offer }), 'hotels');
      rows.push(dto.assertRow(dto.hotelRow(offer, option, quote, { pricedAt: offer.details.answeredAt, checkIn: pq.checkIn, checkOut: pq.checkOut })));
    }
  }
  return rows;
}
const row = (rows, offerId, optionId) => rows.find(r => r.offerId === offerId && r.optionId === optionId);

test('rates: the documented body (sort by price, 40 hotels, countryCode from pq.country), the key only in X-API-Key', () => inOrg(async () => {
  const kit = kitWith();
  await kit.hotels.search(PQ);
  assert.equal(kit.ff.calls.length, 1);
  const call = kit.ff.calls[0];
  assert.equal(call.url, RATES);
  assert.deepEqual(call.body, {
    cityName: 'Cairo', countryCode: 'EG', checkin: '2026-11-12', checkout: '2026-11-14', occupancies: [{ adults: 1 }],
    currency: 'USD', guestNationality: 'US', timeout: 8, limit: 40, sort: [{ field: 'price', direction: 'ascending' }],
    maxRatesPerHotel: 3, includeHotelData: true, roomMapping: true,
  });
  assert.equal(call.headers['x-api-key'], kit.keys.apiKey);
  kit.ff.assertClean();
  const eg = kitWith([], { guestNationality: 'EG' });
  await eg.hotels.search({ ...PQ, where: 'New Alamein' });
  assert.equal(eg.ff.calls[0].body.guestNationality, 'EG');
  assert.equal(eg.ff.calls[0].body.cityName, 'New Alamein');
  // A country with no ISO code: nothing is sent.
  const none = kitWith();
  assert.deepEqual(await none.hotels.search({ ...PQ, country: 'Atlantis' }), []);
  assert.equal(none.ff.calls.length, 0);
}));

test('rates: hotels, rooms and what was left out (no hotel data, a fee in another currency)', () => inOrg(async () => {
  const kit = kitWith();
  const { offers, skipped, truncated } = await kit.hotels.searchDetailed(PQ);
  assert.deepEqual(skipped, { feeOtherCurrency: 1, noHotelData: 1 });
  assert.equal(truncated, false);
  assert.deepEqual(offers.map(o => o.id), ['htl_t.lp1004', 'htl_t.lp1003', 'htl_t.lp1002', 'htl_t.lp1001'], 'cheapest stay first');
  const byId = Object.fromEntries(offers.map(o => [o.id, o]));
  assert.deepEqual(byId['htl_t.lp1001'].options.map(o => o.id), ['standard-room-ro-r', 'deluxe-room-bb-n', 'family-room-ro-n']);
  assert.deepEqual(byId['htl_t.lp1004'].options.map(o => o.id), ['double-room-ro-n'], 'the AED-fee rate is not shown');
  for (const o of offers) {
    validateOffer(o, 'hotels');
    assert.equal(o.demo, true);
    assert.equal(sourceOf(o.id), 'sandbox');
    assert.equal(o.location.city, 'Cairo', 'the searched city');
    assert.equal(o.location.country, 'Egypt', 'the searched country');
    assert.equal(o.details.nights, 2);
    assert.equal(o.details.answeredAt, '2026-10-09T09:00:00.000Z');
    assert.ok(!JSON.stringify(o).includes('offer_PLACEHOLDER'), 'no LiteAPI offerId leaves the adapter');
  }
  assert.equal(byId['htl_t.lp1002'].location.area, '5 Kasr El Aini Street, Garden City', 'the supplier city when it differs');
  assert.equal(byId['htl_t.lp1001'].location.area, '12 Corniche El Nil');
}));

test('rows: lines and totals (§3.4): included taxes, the paid-at-hotel fee counted, null taxesAndFees, a foreign included tax', () => inOrg(async () => {
  const rows = await rowsOf(kitWith());
  const std = row(rows, 'htl_t.lp1001', 'standard-room-ro-r');
  assert.deepEqual(std.lines, [{ label: 'Room, 2 nights', kind: 'base', cents: 21000 }, { label: 'VAT', kind: 'tax', cents: 3050 }]);
  assert.equal(std.totalCents, 24050);
  assert.equal(std.nightlyCents, 10500);
  assert.equal(std.nightlyInclCents, 12025);
  const fee = row(rows, 'htl_t.lp1002', 'superior-room-ro-n');
  assert.deepEqual(fee.lines, [{ label: 'Room total including taxes', kind: 'base', cents: 19999 }, { label: 'Resort fee, paid at the hotel', kind: 'fee', cents: 2000 }]);
  assert.equal(fee.totalCents, 21999, 'the fee paid at the hotel is in the total the policy sees');
  assert.deepEqual(row(rows, 'htl_t.lp1003', 'standard-room-ro-r').lines, [{ label: 'Room total including taxes', kind: 'base', cents: 15000 }], 'taxesAndFees null: all included');
  assert.deepEqual(row(rows, 'htl_t.lp1001', 'family-room-ro-n').lines, [{ label: 'Room total including taxes', kind: 'base', cents: 36000 }], 'an included tax in EGP is never converted');
  for (const r of rows) {
    assert.equal(r.currency, 'USD');
    assert.deepEqual(dto.extraKeys(r, dto.HOTEL_ROW_KEYS), []);
    const text = JSON.stringify(r);
    for (const word of ['commission', 'suggestedSellingPrice', 'initialPrice', 'nuitee', 'supplierId', 'offer_PLACEHOLDER', 'rate_PLACEHOLDER', 'main_photo', 'rating']) {
      assert.ok(!text.includes(word), `${word} never reaches a row`);
    }
  }
}));

test('rows: stars as given (4.5 stays 4.5, null is 0 = unrated); room name and sleeps; no bed or amenities', () => inOrg(async () => {
  const rows = await rowsOf(kitWith());
  assert.equal(row(rows, 'htl_t.lp1001', 'standard-room-ro-r').stars, 4);
  assert.equal(row(rows, 'htl_t.lp1002', 'superior-room-ro-n').stars, 4.5);
  assert.equal(row(rows, 'htl_t.lp1003', 'standard-room-ro-r').stars, 0);
  assert.equal(row(rows, 'htl_t.lp1004', 'double-room-ro-n').stars, 3);
  const fam = row(rows, 'htl_t.lp1001', 'family-room-ro-n');
  assert.deepEqual(fam.room, { name: 'Family Room, Room Only', sleeps: 4, bed: '' });
  assert.deepEqual(fam.amenities, []);
  assert.equal(fam.name, 'Nile View Hotel');
  assert.equal(fam.checkIn, '2026-11-12');
  assert.equal(fam.checkOut, '2026-11-14');
}));

test('rows: cancellation (RFN with a deadline ahead, RFN without one, NRFN, a deadline already passed)', () => inOrg(async () => {
  const rows = await rowsOf(kitWith());
  const std = row(rows, 'htl_t.lp1001', 'standard-room-ro-r');
  // 2026-11-10 12:00 GMT to check-in at 00:00 Cairo time (UTC+2) on 12 Nov = 34 hours.
  assert.deepEqual(std.cancellation, {
    refundable: true, freeUntilHours: 34,
    text: "Free cancellation until 2026-11-10 12:00 GMT (the supplier's time). After that, cancelling costs 120.50 USD.",
  });
  assert.deepEqual(row(rows, 'htl_t.lp1003', 'standard-room-ro-r').cancellation, { refundable: false, freeUntilHours: 0, text: TERMS.hotelNoDeadline });
  assert.deepEqual(row(rows, 'htl_t.lp1001', 'deluxe-room-bb-n').cancellation, { refundable: false, freeUntilHours: 0, text: TERMS.hotelNonRefundable });
  // The same rate after its deadline: not refundable, the text says so.
  const late = kitWith([], { clock: testClock('2026-11-10T13:00:00.000Z') });
  const lateRows = await rowsOf(late);
  const passed = row(lateRows, 'htl_t.lp1001', 'standard-room-ro-r');
  assert.equal(passed.cancellation.refundable, false);
  assert.equal(passed.cancellation.freeUntilHours, 0);
  assert.match(passed.cancellation.text, /deadline \(2026-11-10 12:00 GMT, the supplier's time\) has passed/);
}));

test('rates 2001 (HTTP 200, no availability): no hotels, and no sandbox check', () => inOrg(async () => {
  const kit = supplierKit({ routes: [{ method: 'POST', url: RATES, reply: 'liteapi/rates.no-availability-2001.json' }] });
  assert.deepEqual(await kit.hotels.searchDetailed(PQ), { offers: [], skipped: {}, truncated: false });
  assert.equal(kit.state.latched.liteapi, false);
}));

test('mode: sandbox false, or missing, fails closed with 503 and latches hotels off (flights unaffected)', async () => {
  const missing = body => { delete body.sandbox; return body; };
  for (const reply of ['liteapi/rates.sandbox-mismatch.json', { fixture: 'liteapi/rates.cairo.json', transform: missing }]) {
    const kit = supplierKit({ routes: [{ method: 'POST', url: RATES, reply }] });
    await withCompany(ORG, async () => {
      await assert.rejects(kit.hotels.search(PQ), e => e.code === 'supplier_unavailable' && e.status === 503 && e.message === 'Hotels are not available right now.');
      assert.equal(kit.state.latched.liteapi, true);
      assert.equal(kit.state.latched.duffel, false);
      assert.match(kit.state.problem(), /LITEAPI_API_KEY/);
      await assert.rejects(kit.hotels.getOffer('htl_t.lp1001', { ...PQ, check: 'confirm' }), e => e.code === 'supplier_unavailable');
      assert.equal(kit.ff.calls.length, 1, 'latched: no further call');
      assert.equal(kit.log.lines.filter(l => l.text.includes('mode_mismatch')).length, 1);
    });
  }
});

test('getOffer: another namespace answers null with no call', () => inOrg(async () => {
  const kit = kitWith();
  for (const id of ['htl_CA-NILE', 'htl_l.lp1001', 'flt_t.ZZ1_20261112T0835_economy', 'htl_t.lp/1', 'htl_t.']) {
    assert.equal(await kit.hotels.getOffer(id, { ...PQ, check: 'confirm' }), null);
  }
  assert.equal(kit.ff.calls.length, 0);
}));

test('getOffer levels: auto and peek read the cache; peek never calls; confirm and final ask for that hotel', () => inOrg(async () => {
  const kit = kitWith();
  await assert.rejects(kit.hotels.getOffer('htl_t.lp1001', { ...PQ, check: 'peek' }), e => e.code === 'live_check_skipped');
  assert.equal(kit.ff.calls.length, 0);
  await kit.hotels.search(PQ);
  for (const check of [undefined, 'auto', 'peek']) assert.equal((await kit.hotels.getOffer('htl_t.lp1001', { ...PQ, check })).id, 'htl_t.lp1001');
  assert.equal(kit.ff.calls.length, 1);
  const confirm = await kit.hotels.getOffer('htl_t.lp1001', { ...PQ, check: 'confirm' });
  assert.deepEqual(confirm.options.map(o => o.id), ['standard-room-ro-r', 'deluxe-room-bb-n']);
  assert.deepEqual(kit.ff.calls[1].body.hotelIds, ['lp1001']);
  assert.ok(!('cityName' in kit.ff.calls[1].body));
  // A hotel the fresh rates don't have: null (unavailable).
  assert.equal(await kit.hotels.getOffer('htl_t.lp9999', { ...PQ, check: 'confirm' }), null);
  // auto with no city search cached asks for that hotel too, and caches it.
  const auto = kitWith();
  await auto.hotels.getOffer('htl_t.lp1001', PQ);
  await auto.hotels.getOffer('htl_t.lp1001', { ...PQ, check: 'peek' });
  assert.equal(auto.ff.calls.length, 1);
}));

test('quote: prebook only for final; confirm quotes the fresh rates', () => inOrg(async () => {
  const kit = kitWith(['liteapi/prebook.json']);
  const pick = async check => {
    const pq = { ...PQ, check };
    const o = await kit.hotels.getOffer('htl_t.lp1001', pq);
    return kit.hotels.quote({ offerId: o.id, optionId: 'standard-room-ro-r', query: pq, offer: o });
  };
  await pick('confirm');
  await pick('auto');
  assert.equal(kit.ff.calls.filter(c => PREBOOK.test(c.url)).length, 0);
  const q = await pick('final');
  const prebooks = kit.ff.calls.filter(c => PREBOOK.test(c.url));
  assert.equal(prebooks.length, 1);
  assert.equal(prebooks[0].url, 'https://book.liteapi.travel/v3.0/rates/prebook?timeout=20');
  assert.deepEqual(prebooks[0].body, { offerId: 'offer_PLACEHOLDER_lp1001_std_v2', usePaymentSdk: false }, 'the fresh rate, never the payment SDK');
  const before = kit.ff.calls.indexOf(prebooks[0]);
  assert.deepEqual(kit.ff.calls[before - 1].body.hotelIds, ['lp1001'], 'every prebook follows a checked rates call');
  assert.equal(q.lines.reduce((n, l) => n + l.amount, 0), 24050, 'same price');
  assert.equal(q.cancellation.freeUntilHours, 34);
  validateQuote(q, 'hotels');
}));

async function finalRow(prebook) {
  const kit = kitWith(prebook);
  return withCompany(ORG, async () => {
    const pq = { ...PQ, check: 'final' };
    const o = await kit.hotels.getOffer('htl_t.lp1001', pq);
    let quote = null;
    try { quote = await kit.hotels.quote({ offerId: o.id, optionId: 'standard-room-ro-r', query: pq, offer: o }); } catch (e) { return { kit, error: e }; }
    return { kit, row: dto.hotelRow(o, o.options.find(x => x.id === 'standard-room-ro-r'), quote, { pricedAt: o.details.answeredAt, checkIn: PQ.checkIn, checkOut: PQ.checkOut }) };
  });
}
const prebookCalls = kit => kit.ff.calls.filter(c => PREBOOK.test(c.url));
const ratesCalls = kit => kit.ff.calls.filter(c => c.url === RATES);

test('prebook: price changed, terms changed', async () => {
  const moved = await finalRow(['liteapi/prebook.price-changed.json']);
  assert.equal(moved.row.totalCents, 25275);
  assert.deepEqual(moved.row.lines, [{ label: 'Room, 2 nights', kind: 'base', cents: 22225 }, { label: 'VAT', kind: 'tax', cents: 3050 }]);
  const terms = await finalRow(['liteapi/prebook.cancellation-changed.json']);
  assert.equal(terms.row.totalCents, 24050);
  assert.deepEqual(terms.row.cancellation, { refundable: false, freeUntilHours: 0, text: TERMS.hotelNonRefundable });
});

test('prebook 2001 or 4040: fresh rates for that hotel, then one more prebook of the same room', async () => {
  for (const stale of ['liteapi/prebook.2001.json', 'liteapi/prebook.4040-outdated.json']) {
    const r = await finalRow([stale, 'liteapi/prebook.price-changed.json']);
    assert.equal(r.row.totalCents, 25275, `${stale}: re-found and priced`);
    assert.equal(prebookCalls(r.kit).length, 2);
    assert.equal(ratesCalls(r.kit).length, 2, 'the getOffer rates, then the fresh rates');
    assert.deepEqual(r.kit.ff.calls.map(c => (c.url === RATES ? 'rates' : 'prebook')), ['rates', 'prebook', 'rates', 'prebook']);
  }
});

test('prebook 2001 then the room is missing from the fresh rates, or the second prebook fails: option_sold_out', async () => {
  let n = 0;
  const kit = supplierKit({ routes: [
    { method: 'POST', url: RATES, reply: c => { n += 1; return n === 1 ? cityOrHotel(c) : { fixture: 'liteapi/rates.hotel.json', transform: b => { b.data[0].roomTypes = b.data[0].roomTypes.slice(1); return b; } }; } },
    { method: 'POST', url: PREBOOK, reply: 'liteapi/prebook.2001.json' },
  ] });
  await withCompany(ORG, async () => {
    const pq = { ...PQ, check: 'final' };
    const o = await kit.hotels.getOffer('htl_t.lp1001', pq);
    await assert.rejects(kit.hotels.quote({ offerId: o.id, optionId: 'standard-room-ro-r', query: pq, offer: o }), e => e.code === 'option_sold_out' && e.status === 409);
    assert.equal(prebookCalls(kit).length, 1, 'no second prebook without the room');
  });
  const twice = await finalRow(['liteapi/prebook.2001.json', 'liteapi/prebook.2001.json']);
  assert.equal(twice.error.code, 'option_sold_out');
  assert.equal(prebookCalls(twice.kit).length, 2, 'never a third');
});

test('prebook 4016: once more with the longer timeout; 5000: once more; 4002 and anything else: 503', async () => {
  const slow = await finalRow(['liteapi/prebook.4016-timeout.json', 'liteapi/prebook.json']);
  assert.equal(slow.row.totalCents, 24050);
  assert.deepEqual(prebookCalls(slow.kit).map(c => c.url.split('?')[1]), ['timeout=20', 'timeout=30']);
  const busy = await finalRow([{ status: 500, body: { error: { code: 5000, message: 'retry' } } }, 'liteapi/prebook.json']);
  assert.equal(busy.row.totalCents, 24050);
  assert.equal(prebookCalls(busy.kit).length, 2);
  const invalid = await finalRow([{ status: 400, body: { error: { code: 4002, description: 'invalid offerId' } } }]);
  assert.equal(invalid.error.code, 'supplier_unavailable');
  assert.equal(prebookCalls(invalid.kit).length, 1, '4002 is never retried');
  const lost = await finalRow([{ status: 500, body: { error: { code: 4020, description: 'hotel could not be loaded' } } }, 'liteapi/prebook.json']);
  assert.equal(lost.row.totalCents, 24050, '4020: fresh rates, then a fresh prebook');
  assert.equal(ratesCalls(lost.kit).length, 2);
});

test('rates retries: one retry on 5xx, 429/4290, 4291 and 4011; never on a 4xx', () => inOrg(async () => {
  for (const [first, calls] of [
    ['liteapi/error.429.json', 2], ['liteapi/error.4290.json', 2], ['liteapi/error.4291.json', 2],
    [{ status: 408, body: { error: { code: 4011, message: 'timeout' } } }, 2],
    [{ status: 400, body: { error: { code: 4002, message: 'bad' } } }, 1],
  ]) {
    const kit = supplierKit({ routes: [{ method: 'POST', url: RATES, reply: [first, 'liteapi/rates.cairo.json'] }] });
    if (calls === 2) assert.equal((await kit.hotels.search(PQ)).length, 4);
    else await assert.rejects(kit.hotels.search(PQ), e => e.code === 'supplier_unavailable');
    assert.equal(kit.ff.calls.length, calls, JSON.stringify(first));
  }
  const down = supplierKit({ routes: [{ method: 'POST', url: RATES, reply: 'liteapi/error.4291.json' }] });
  await assert.rejects(down.hotels.search(PQ), e => e.code === 'supplier_unavailable' && e.message === 'Hotels are not available right now.');
  assert.equal(down.ff.calls.length, 2, 'one retry, then 503');
}));

test('book and cancel: booking is not open', async () => {
  const kit = kitWith();
  await assert.rejects(kit.hotels.book(), e => e.code === 'booking_not_open' && e.status === 409);
  await assert.rejects(kit.hotels.cancel(), e => e.code === 'booking_not_open');
  assert.ok(!JSON.stringify(kit.hotels, (k, v) => (typeof v === 'function' ? undefined : v)).includes(kit.keys.apiKey));
});

test('fixtures: every LiteAPI fixture names its documentation page', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, 'fixtures', 'suppliers', 'liteapi');
  for (const f of fs.readdirSync(dir)) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.match(raw._source, /^https:\/\/docs\.liteapi\.travel\//, f);
    assert.ok(loadFixture(`liteapi/${f}`).body, f);
  }
});
