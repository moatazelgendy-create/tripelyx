// Real suppliers, step R1-0 (real-suppliers design §2.2, §2.4, §3.2, §8.1): server/business/source.js, the price
// source of a row or request, the row id namespaces, the frozen fare-term sentences and the supplier error copy.
// Both builders code against these; nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = require('../server/business/source');
const dto = require('../server/business/dto');
const { AppError } = require('../server/lib/errors');
const { BusinessDemoFlights } = require('../server/business/demo/flights');
const { BUSINESS_HOTELS } = require('../server/business/demo/hotels-data');
const { createBusinessInventory } = require('../server/business/inventory');
const ALAMEIN_HOTELS = require('../server/providers/mock/demo-data/hotels');
const { fakeInventory } = require('./business-fakes');
const rows = require('./fixtures/business-rows');

const {
  SOURCES, NAMESPACES, isSource, sourceOf, offerPrefix, leastReal, requestSource,
  NEEDS_VERIFICATION, TERMS, saysNoChanges, refundsUnconfirmed, changesUnconfirmed,
  SUPPLIER_ERRORS, LIVE_ERROR_CODES, PRICE_CHECK_COPY, supplierError,
} = source;

const ROOT = path.join(__dirname, '..');
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const SANDBOX_FLIGHT = 'flt_t.ZZ1234-ZZ88_20261112T0835_economy';
const SANDBOX_HOTEL = 'htl_t.lp1897';

/** A fixture row moved into another offer id (the key follows). */
function renamed(row, offerId, optionId = row.optionId) {
  return { ...row, offerId, optionId, key: dto.rowKey(row.kind, offerId, optionId) };
}

// ---------------------------------------------------------------------------------------------------------
// Sources and namespaces

test('SOURCES are demo, sandbox, live (least real first), frozen; isSource knows only those', () => {
  assert.deepEqual([...SOURCES], ['demo', 'sandbox', 'live']);
  assert.ok(Object.isFrozen(SOURCES));
  for (const s of SOURCES) assert.equal(isSource(s), true);
  for (const s of ['none', 'Demo', 'test', '', null, undefined, 0, {}, 'toString', '__proto__']) assert.equal(isSource(s), false, String(s));
});

test('the row id namespaces: flt_t. and htl_t. are sandbox, flt_l. and htl_l. are live', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(NAMESPACES)), {
    flight: { sandbox: 'flt_t.', live: 'flt_l.' },
    hotel: { sandbox: 'htl_t.', live: 'htl_l.' },
  });
  assert.ok(Object.isFrozen(NAMESPACES) && Object.isFrozen(NAMESPACES.flight) && Object.isFrozen(NAMESPACES.hotel));
  assert.equal(offerPrefix('flight', 'sandbox'), 'flt_t.');
  assert.equal(offerPrefix('flight', 'live'), 'flt_l.');
  assert.equal(offerPrefix('hotel', 'sandbox'), 'htl_t.');
  assert.equal(offerPrefix('hotel', 'live'), 'htl_l.');
  for (const [kind, src] of [['flight', 'demo'], ['hotel', 'none'], ['car', 'sandbox'], ['toString', 'live'], [undefined, 'sandbox'], ['flight', undefined]]) {
    assert.throws(() => offerPrefix(kind, src), TypeError, `${kind} ${src}`);
  }
});

test('sourceOf reads the namespace of an offer id, a row key or a row', () => {
  assert.equal(sourceOf(SANDBOX_FLIGHT), 'sandbox');
  assert.equal(sourceOf(SANDBOX_HOTEL), 'sandbox');
  assert.equal(sourceOf('flt_l.ZZ1234_20261112T0835_economy'), 'live');
  assert.equal(sourceOf('htl_l.lp1897'), 'live');
  assert.equal(sourceOf(`f.${SANDBOX_FLIGHT}|economy-r0c1`), 'sandbox');
  assert.equal(sourceOf('h.htl_l.lp1897|std-room-ro-r'), 'live');
  assert.equal(sourceOf({ offerId: SANDBOX_HOTEL }), 'sandbox');
  assert.equal(sourceOf({ offerId: 'flt_l.X' }), 'live');
  // Demo and fixture ids.
  for (const id of ['flt_ZM429_2026-11-12_economy', 'flt_ZM101-ZM999_2026-11-12_economy', 'htl_CA-NILE', 'htl_LN-KESTREL',
    'flt_fake_CAILHR_2026-11-12_1', 'htl_fake_LHR_1', 'flt_fix_CAILHR_2026-11-12_1', 'htl_fix_London_1', 'f.flt_x|LIGHT']) {
    assert.equal(sourceOf(id), 'demo', id);
  }
});

test('sourceOf never throws and reads anything it does not recognise as demo (never as more real)', () => {
  const odd = [null, undefined, 0, 42, true, '', 'flt_t.', 'htl_l.', 'f.flt_t.', 'FLT_T.x', 'flt_T.x', 'flt_L.x', 'flt_x.y', 'flt_tx.y',
    ' flt_t.x', 'xflt_t.y', 'h.f.flt_t.x', 'btr_123', {}, [], [SANDBOX_FLIGHT], { id: SANDBOX_FLIGHT }, { key: `f.${SANDBOX_FLIGHT}|x` },
    { offerId: 42 }, { offerId: null }, Object.create(null), () => SANDBOX_FLIGHT, Symbol('x')];
  for (const value of odd) assert.equal(sourceOf(value), 'demo', String(typeof value === 'symbol' ? 'symbol' : JSON.stringify(value)));
});

test('every demo, fake and fixture id in the repo reads as demo', () => {
  const inv = createBusinessInventory({ business: { demoInventory: true } });
  const codes = inv.airports().map(a => a.code);
  assert.ok(codes.length >= 10, 'the demo airports');
  const flights = new BusinessDemoFlights();
  let n = 0;
  for (const from of codes) {
    for (const to of codes) {
      if (from === to) continue;
      for (const cabin of ['economy', 'business']) {
        for (const offer of flights.buildOffers({ from, to, departDate: '2026-11-12', cabin, passengers: 1 })) {
          assert.equal(sourceOf(offer.id), 'demo', offer.id);
          for (const option of offer.options) assert.equal(sourceOf(dto.rowKey('flight', offer.id, option.id)), 'demo');
          n += 1;
        }
      }
    }
  }
  assert.ok(n > 500, `${n} demo flight offers`);
  for (const h of [...BUSINESS_HOTELS, ...ALAMEIN_HOTELS]) assert.equal(sourceOf(`htl_${h.hotel_code}`), 'demo', h.hotel_code);
  const fake = fakeInventory();
  for (const r of fake.peekFlightRows({ leg: 'out', from: 'CAI', to: 'LHR', date: '2026-11-12', cabin: 'economy' }, rows.PRICED_AT)) assert.equal(sourceOf(r), 'demo', r.key);
  for (const r of fake.peekHotelRows({ city: 'London', country: 'United Kingdom', checkIn: '2026-11-12', checkOut: '2026-11-14' }, rows.PRICED_AT)) assert.equal(sourceOf(r), 'demo', r.key);
  assert.equal(sourceOf(rows.flight()), 'demo');
  assert.equal(sourceOf(rows.hotel()), 'demo');
});

test('a sandbox row fits the FINAL row key pattern and passes today\'s assertRow with demo:true', () => {
  const f = renamed(rows.flight(), SANDBOX_FLIGHT, 'economy-r0c1');
  assert.match(f.key, dto.ROW_KEY_RE);
  assert.deepEqual(dto.parseRowKey(f.key), { kind: 'flight', offerId: SANDBOX_FLIGHT, optionId: 'economy-r0c1' });
  assert.equal(sourceOf(f), 'sandbox');
  assert.equal(sourceOf(f.key), 'sandbox');
  assert.doesNotThrow(() => dto.assertRow(f));
  const h = renamed(rows.hotel(), SANDBOX_HOTEL, 'deluxe-king-ro-r-0a1b2c3d');
  assert.match(h.key, dto.ROW_KEY_RE);
  assert.deepEqual(dto.parseRowKey(h.key), { kind: 'hotel', offerId: SANDBOX_HOTEL, optionId: 'deluxe-king-ro-r-0a1b2c3d' });
  assert.doesNotThrow(() => dto.assertRow(h));
  // The longest ids the design allows: a 40-character option id, and an offer id of 160 characters after 'flt_'.
  const longOption = `${'a'.repeat(31)}-0a1b2c3d`;
  assert.equal(longOption.length, 40);
  const longOffer = `flt_t.${'Z'.repeat(158)}`;
  assert.match(dto.rowKey('flight', longOffer, longOption), dto.ROW_KEY_RE);
  assert.doesNotMatch(dto.rowKey('flight', `${longOffer}Z`, longOption), dto.ROW_KEY_RE);
});

test('leastReal: demo beats sandbox beats live; unknown values count as demo; none gives null', () => {
  assert.equal(leastReal([]), null);
  assert.equal(leastReal(['live']), 'live');
  assert.equal(leastReal(['live', 'live']), 'live');
  assert.equal(leastReal(['live', 'sandbox']), 'sandbox');
  assert.equal(leastReal(['sandbox', 'live', 'sandbox']), 'sandbox');
  assert.equal(leastReal(['sandbox', 'demo', 'live']), 'demo');
  assert.equal(leastReal([undefined, 'live']), 'demo', 'a request stored before real suppliers has no source');
  assert.equal(leastReal([null]), 'demo');
  assert.equal(leastReal(['Live', 'live']), 'demo');
  assert.equal(leastReal(new Set(['live', 'sandbox'])), 'sandbox');
  assert.equal(leastReal(['live', 'sandbox'].values()), 'sandbox');
  for (const bad of [undefined, null, 42, 'live', {}, { length: 1, 0: 'live' }]) assert.throws(() => leastReal(bad), TypeError, String(bad));
});

test('requestSource: the stored source and every row, least real; old requests read as demo', () => {
  const sbFlight = renamed(rows.flight(), SANDBOX_FLIGHT, 'economy-r0c1');
  const sbHotel = renamed(rows.hotel(), SANDBOX_HOTEL, 'std-ro-r');
  const liveFlight = renamed(rows.flight(), 'flt_l.ZZ1_20261112T0835_economy', 'economy-r0c1');
  const liveHotel = renamed(rows.hotel(), 'htl_l.lp1', 'std-ro-r');
  const req = (src, r) => ({ id: 'btr_x', ...(src === undefined ? {} : { source: src }), rows: { out: r.out, back: r.back || null, hotel: r.hotel || null } });
  assert.equal(requestSource(req(undefined, { out: rows.flight(), hotel: rows.hotel() })), 'demo', 'stored before real suppliers');
  assert.equal(requestSource(req('sandbox', { out: sbFlight, back: sbFlight, hotel: sbHotel })), 'sandbox');
  assert.equal(requestSource(req('sandbox', { out: sbFlight })), 'sandbox');
  assert.equal(requestSource(req('live', { out: liveFlight, back: liveFlight, hotel: liveHotel })), 'live');
  assert.equal(requestSource(req('live', { out: liveFlight, hotel: sbHotel })), 'sandbox', 'a test-data row makes the request test data');
  assert.equal(requestSource(req(undefined, { out: liveFlight })), 'demo', 'no stored source is never live');
  assert.equal(requestSource(req('real', { out: liveFlight })), 'demo');
  assert.equal(requestSource(req('demo', { out: liveFlight })), 'demo');
  assert.equal(requestSource({ source: 'live' }), 'live', 'no rows: the stored source');
  assert.equal(requestSource({ source: 'live', rows: null }), 'live');
  for (const bad of [null, undefined, 'live', 42]) assert.equal(requestSource(bad), 'demo');
});

// ---------------------------------------------------------------------------------------------------------
// Fare terms

const SENTENCES = {
  refundsNotAllowed: 'Refunds: not allowed.',
  refundsFree: 'Refunds: allowed with no fee.',
  refundsFeeUnknown: "Refunds: allowed, but the airline doesn't say the fee (NEEDS VERIFICATION).",
  refundsUnknown: "Refunds: the airline doesn't say (NEEDS VERIFICATION).",
  changesNotAllowed: 'Changes: not allowed.',
  freeChanges: 'Changes: free changes allowed.',
  changesFeeUnknown: "Changes: allowed, but the airline doesn't say the fee (NEEDS VERIFICATION).",
  changesUnknown: "Changes: the airline doesn't say (NEEDS VERIFICATION).",
  bagsUnknown: "Bags: the airline doesn't say (NEEDS VERIFICATION).",
  hotelNonRefundable: 'Non-refundable.',
  hotelNoDeadline: 'Refundable, but the supplier gave no deadline (NEEDS VERIFICATION).',
};

test('TERMS: the frozen sentences, word for word', () => {
  assert.ok(Object.isFrozen(TERMS));
  assert.equal(NEEDS_VERIFICATION, 'NEEDS VERIFICATION');
  for (const [k, v] of Object.entries(SENTENCES)) assert.equal(TERMS[k], v, k);
  const functions = Object.keys(TERMS).filter(k => typeof TERMS[k] === 'function').sort();
  assert.deepEqual(functions, ['bags', 'changes', 'changesFee', 'fare', 'refunds', 'refundsFee']);
  assert.deepEqual(Object.keys(TERMS).filter(k => typeof TERMS[k] === 'string').sort(), Object.keys(SENTENCES).sort());
  assert.equal(Reflect.set(TERMS, 'changesNotAllowed', 'x'), false);
  assert.equal(TERMS.changesNotAllowed, SENTENCES.changesNotAllowed);
  // No sentence holds another one (the predicates match by inclusion), and none is a substring of another.
  const all = Object.values(SENTENCES);
  for (const a of all) for (const b of all) if (a !== b) assert.ok(!a.includes(b), `${a} holds ${b}`);
});

test('TERMS.fare: refunds, changes, bags in that order, as in the design example', () => {
  assert.equal(
    TERMS.fare({ refund: { allowed: false, penaltyAmount: null, penaltyCurrency: null }, change: { allowed: true, penaltyAmount: '50.00', penaltyCurrency: 'USD' }, bags: { checked: 1, carryOn: 1 } }),
    'Refunds: not allowed. Changes: allowed for a fee of 50.00 USD set by the airline. Bags: 1 checked bag, 1 carry-on bag.',
  );
  assert.equal(TERMS.fare({ refund: null, change: null, bags: null }), `${SENTENCES.refundsUnknown} ${SENTENCES.changesUnknown} ${SENTENCES.bagsUnknown}`);
  assert.equal(TERMS.fare(), `${SENTENCES.refundsUnknown} ${SENTENCES.changesUnknown} ${SENTENCES.bagsUnknown}`);
  assert.equal(
    TERMS.fare({ refund: { allowed: true, penaltyAmount: '0.00', penaltyCurrency: 'USD' }, change: { allowed: true, penaltyAmount: '0', penaltyCurrency: 'USD' }, bags: { checked: 0, carryOn: 1 } }),
    'Refunds: allowed with no fee. Changes: free changes allowed. Bags: no checked bag, 1 carry-on bag.',
  );
});

test('TERMS.refunds and TERMS.changes cover every condition the airline can give', () => {
  const cases = [
    [null, 'refundsUnknown', 'changesUnknown'],
    [undefined, 'refundsUnknown', 'changesUnknown'],
    ['allowed', 'refundsUnknown', 'changesUnknown'],
    [{}, 'refundsUnknown', 'changesUnknown'],
    [{ allowed: null, penaltyAmount: '10.00', penaltyCurrency: 'USD' }, 'refundsUnknown', 'changesUnknown'],
    [{ allowed: 'true' }, 'refundsUnknown', 'changesUnknown'],
    [{ allowed: false, penaltyAmount: '10.00', penaltyCurrency: 'USD' }, 'refundsNotAllowed', 'changesNotAllowed'],
    [{ allowed: true, penaltyAmount: '0', penaltyCurrency: 'USD' }, 'refundsFree', 'freeChanges'],
    [{ allowed: true, penaltyAmount: '0.00', penaltyCurrency: null }, 'refundsFree', 'freeChanges'],
    [{ allowed: true, penaltyAmount: '000.0', penaltyCurrency: 'GBP' }, 'refundsFree', 'freeChanges'],
    [{ allowed: true, penaltyAmount: null, penaltyCurrency: 'USD' }, 'refundsFeeUnknown', 'changesFeeUnknown'],
    [{ allowed: true }, 'refundsFeeUnknown', 'changesFeeUnknown'],
    [{ allowed: true, penaltyAmount: '25.00', penaltyCurrency: null }, 'refundsFeeUnknown', 'changesFeeUnknown'],
    [{ allowed: true, penaltyAmount: '25.00', penaltyCurrency: 'usd' }, 'refundsFeeUnknown', 'changesFeeUnknown'],
    [{ allowed: true, penaltyAmount: 25, penaltyCurrency: 'USD' }, 'refundsFeeUnknown', 'changesFeeUnknown'],
    [{ allowed: true, penaltyAmount: '-5.00', penaltyCurrency: 'USD' }, 'refundsFeeUnknown', 'changesFeeUnknown'],
    [{ allowed: true, penaltyAmount: '<b>5</b>', penaltyCurrency: 'USD' }, 'refundsFeeUnknown', 'changesFeeUnknown'],
    [{ allowed: true, penaltyAmount: '1e3', penaltyCurrency: 'USD' }, 'refundsFeeUnknown', 'changesFeeUnknown'],
  ];
  for (const [cond, refund, change] of cases) {
    assert.equal(TERMS.refunds(cond), SENTENCES[refund], `refunds ${JSON.stringify(cond)}`);
    assert.equal(TERMS.changes(cond), SENTENCES[change], `changes ${JSON.stringify(cond)}`);
  }
  // A fee is printed as the airline gave it, in its own currency, never converted.
  assert.equal(TERMS.changes({ allowed: true, penaltyAmount: '40.00', penaltyCurrency: 'GBP' }), 'Changes: allowed for a fee of 40.00 GBP set by the airline.');
  assert.equal(TERMS.refunds({ allowed: true, penaltyAmount: '125.5', penaltyCurrency: 'EUR' }), 'Refunds: allowed for a fee of 125.5 EUR set by the airline.');
  assert.equal(TERMS.changesFee('50.00', 'USD'), 'Changes: allowed for a fee of 50.00 USD set by the airline.');
  assert.equal(TERMS.refundsFee('75.00', 'AED'), 'Refunds: allowed for a fee of 75.00 AED set by the airline.');
  assert.equal(TERMS.changesFee('fifty', 'USD'), SENTENCES.changesFeeUnknown);
  assert.equal(TERMS.refundsFee('50.00', 'US'), SENTENCES.refundsFeeUnknown);
});

test('TERMS.bags: each part counted or "not stated", NEEDS VERIFICATION when either is unknown', () => {
  assert.equal(TERMS.bags({ checked: 1, carryOn: 1 }), 'Bags: 1 checked bag, 1 carry-on bag.');
  assert.equal(TERMS.bags({ checked: 2, carryOn: 2 }), 'Bags: 2 checked bags, 2 carry-on bags.');
  assert.equal(TERMS.bags({ checked: 0, carryOn: 0 }), 'Bags: no checked bag, no carry-on bag.');
  assert.equal(TERMS.bags({ checked: 2 }), 'Bags: 2 checked bags, carry-on bags not stated (NEEDS VERIFICATION).');
  assert.equal(TERMS.bags({ carryOn: 1, checked: null }), 'Bags: checked bags not stated, 1 carry-on bag (NEEDS VERIFICATION).');
  for (const bad of [undefined, null, {}, { checked: -1, carryOn: 1.5 }, { checked: '1', carryOn: NaN }, 'two']) {
    assert.equal(TERMS.bags(bad), SENTENCES.bagsUnknown, JSON.stringify(bad));
  }
});

test('the predicates diff.js and evaluate.js read: no changes, refunds unconfirmed, changes unconfirmed', () => {
  const t = (refund, change) => TERMS.fare({ refund, change, bags: { checked: 1, carryOn: 1 } });
  const no = { allowed: false }, free = { allowed: true, penaltyAmount: '0', penaltyCurrency: 'USD' };
  const fee = { allowed: true, penaltyAmount: '50.00', penaltyCurrency: 'USD' }, feeUnknown = { allowed: true, penaltyAmount: null };
  assert.equal(saysNoChanges(t(no, no)), true);
  assert.equal(saysNoChanges(t(no, null)), false, 'an unknown change rule is never "No changes allowed"');
  assert.equal(saysNoChanges(t(no, feeUnknown)), false);
  assert.equal(saysNoChanges(t(no, fee)), false);
  assert.equal(saysNoChanges(t(no, free)), false, 'refunds not allowed is not changes not allowed');
  assert.equal(refundsUnconfirmed(t(null, no)), true);
  assert.equal(refundsUnconfirmed(t(feeUnknown, no)), true);
  assert.equal(refundsUnconfirmed(t(no, null)), false);
  assert.equal(refundsUnconfirmed(t(fee, null)), false);
  assert.equal(refundsUnconfirmed(t(free, null)), false);
  // A refund fee in another currency than the fare is printed as given, so the refund share is not known.
  const gbpFee = { allowed: true, penaltyAmount: '40.00', penaltyCurrency: 'GBP' };
  assert.equal(refundsUnconfirmed(t(gbpFee, null)), true);
  assert.equal(refundsUnconfirmed(t(gbpFee, null), { currency: 'GBP' }), false);
  assert.equal(refundsUnconfirmed(t(fee, null), { currency: 'GBP' }), true);
  assert.equal(refundsUnconfirmed(t(no, gbpFee)), false, 'a change fee in GBP says nothing about refunds');
  assert.equal(changesUnconfirmed(t(no, null)), true);
  assert.equal(changesUnconfirmed(t(no, feeUnknown)), true);
  assert.equal(changesUnconfirmed(t(null, free)), false);
  for (const fn of [saysNoChanges, refundsUnconfirmed, changesUnconfirmed]) {
    for (const bad of [null, undefined, 42, {}, ['Changes: not allowed.']]) assert.equal(fn(bad), false);
    // Demo fare terms never match: the demo keeps its own rules.
    for (const demo of ['Non-refundable. No changes.', 'Non-refundable. Changes for a fee.', '70% refundable. Free changes.']) assert.equal(fn(demo), false, demo);
  }
  // diff.js finds free changes with /free changes/i (the "No free changes" give-up); the supplier sentence matches it.
  assert.match(TERMS.freeChanges, /free changes/i);
  assert.doesNotMatch(TERMS.changesFee('10.00', 'USD'), /free changes/i);
  assert.doesNotMatch(TERMS.changesUnknown, /free changes/i);
});

// ---------------------------------------------------------------------------------------------------------
// Supplier errors and page copy (design §2.4)

test('SUPPLIER_ERRORS and supplierError: the §2.4 codes, statuses and copy', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SUPPLIER_ERRORS)), {
    supplier_unavailable: {
      status: 503,
      flights: 'Flights are not available right now. Please try again in a few minutes.',
      hotels: 'Hotels are not available right now.',
    },
    supplier_busy: { status: 429, message: 'Your company has run a lot of searches in the last hour. Please try again in a few minutes.' },
    live_check_skipped: { status: 503, message: 'The price is checked again when you approve.' },
  });
  assert.ok(Object.isFrozen(SUPPLIER_ERRORS) && Object.values(SUPPLIER_ERRORS).every(Object.isFrozen));
  const f = supplierError('supplier_unavailable', { vertical: 'flights' });
  assert.ok(f instanceof AppError);
  assert.deepEqual([f.code, f.status, f.message], ['supplier_unavailable', 503, 'Flights are not available right now. Please try again in a few minutes.']);
  const h = supplierError('supplier_unavailable', { vertical: 'hotels' });
  assert.deepEqual([h.code, h.status, h.message], ['supplier_unavailable', 503, 'Hotels are not available right now.']);
  const b = supplierError('supplier_busy');
  assert.deepEqual([b.code, b.status, b.message], ['supplier_busy', 429, SUPPLIER_ERRORS.supplier_busy.message]);
  const s = supplierError('live_check_skipped');
  assert.deepEqual([s.code, s.status, s.message], ['live_check_skipped', 503, 'The price is checked again when you approve.']);
  assert.throws(() => supplierError('supplier_unavailable'), TypeError);
  assert.throws(() => supplierError('supplier_unavailable', { vertical: 'cars' }), TypeError);
  for (const code of ['no_supplier', 'unsupported_currency', 'toString', undefined]) assert.throws(() => supplierError(code), TypeError, String(code));
  assert.deepEqual([...LIVE_ERROR_CODES], ['supplier_unavailable', 'supplier_busy', 'live_check_skipped', 'unsupported_currency']);
  assert.ok(Object.isFrozen(LIVE_ERROR_CODES));
});

test('PRICE_CHECK_COPY: the request and results page copy around a price check', () => {
  assert.deepEqual({ ...PRICE_CHECK_COPY }, {
    skipped: 'The price is checked again when you approve.',
    failed: "We couldn't check the price just now. It is checked again when you approve.",
    unchanged: "The price couldn't be checked just now, so nothing changed. Try again in a few minutes.",
    hotelsLeg: 'Hotels are not available right now. You can still request the flights.',
  });
  assert.ok(Object.isFrozen(PRICE_CHECK_COPY));
});

test('every sentence is plain, honest copy: no em or en dash, no pressure words, no curly quotes, no markup', () => {
  const texts = [
    ...Object.values(SENTENCES), TERMS.fare({ refund: { allowed: true, penaltyAmount: '50.00', penaltyCurrency: 'USD' }, change: null, bags: { checked: 1 } }),
    ...Object.values(SUPPLIER_ERRORS).flatMap(e => Object.values(e).filter(v => typeof v === 'string')), ...Object.values(PRICE_CHECK_COPY),
  ];
  for (const t of texts) {
    assert.doesNotMatch(t, /[\u2013\u2014\u2018\u2019\u201c\u201d<>&]/, t);
    assert.doesNotMatch(t, PRESSURE, t);
    assert.match(t, /^[A-Z].*\.$/, `${t}: a sentence`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The module itself

test('source.js is pure: no clock, no network, no store; it requires only lib/errors', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'business', 'source.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  assert.deepEqual(requires, ['../lib/errors']);
  assert.doesNotMatch(src, /Date\.now|new Date\b|\bfetch\s*\(|process\.env/);
  assert.doesNotMatch(src, /\u2014/, 'no em dash');
});

test('types.js documents the real-suppliers round 1 contracts', () => {
  const types = fs.readFileSync(path.join(ROOT, 'server', 'business', 'types.js'), 'utf8');
  assert.match(types, /@typedef \{'demo'\|'sandbox'\|'live'\|'none'\} InventoryStatus/);
  assert.match(types, /@typedef \{'demo'\|'sandbox'\|'live'\} PriceSource/);
  assert.match(types, /@typedef \{'auto'\|'peek'\|'confirm'\|'final'\} CheckLevel/);
  assert.match(types, /@typedef \{'supplier_unavailable'\|'supplier_busy'\|'live_check_skipped'\|'unsupported_currency'\} LiveCheckError/);
  assert.doesNotMatch(types, /@property \{true\} demo/, 'demo is a boolean everywhere');
  assert.equal((types.match(/@property \{boolean\} demo not a real price/g) || []).length, 3, 'FlightRow, HotelRow, Request');
  for (const re of [
    /@property \{PriceSource\} \[source\] where the rows' prices came from/,
    /@typedef \{object\} SkipCounts/,
    /@property \{SkipCounts\} \[skipped\]/,
    /@property \{'unavailable'\|null\} \[error\]/,
    /@property \{LiveCheckError\|null\} \[liveError\]/,
    /@property \{PriceSource\} \[priceSource\]/,
    /@typedef \{object\} BusinessFlightQuery/,
    /@typedef \{object\} BusinessHotelQuery/,
    /@property \{string\} \[country\]/,
    /@property \{CheckLevel\} \[check\]/,
    /@typedef \{object\} SupplierOfferDetails/,
    /@property \{\{ code: string, name: string \}\} \[owner\]/,
    /@property \{Array<\{ code: string, city: string \}>\} \[via\]/,
    /@property \{string\} \[answeredAt\]/,
    /@typedef \{object\} DetailedSearch/,
    /SearchDetailed/,
    /@property \{PriceSource\|null\} \[source\]/,
    /@property \{boolean\} \[hotelsConnected\]/,
    /@property \{number\} \[maxVariantSearches\]/,
    /@property \{string\|null\} \[problem\]/,
    /check\?: CheckLevel/,
  ]) assert.match(types, re);
  for (const key of ['mixedCabin', 'firstCabin', 'unknownCarrier', 'timeMismatch', 'duplicateOption', 'feeOtherCurrency', 'noHotelData', 'otherCurrency']) {
    assert.match(types, new RegExp(`@property \\{number\\} \\[${key}\\]`), key);
  }
  assert.match(types, /@property \{string\[\]\} \[currencies\]/);
});

test('types.js documents what the R1-m merge added (both builders\' needs)', () => {
  const types = fs.readFileSync(path.join(ROOT, 'server', 'business', 'types.js'), 'utf8');
  for (const re of [
    // Builder A: the provider calls the composer makes.
    /@typedef \{\{ optionId\?: string\|null \}\} GetOfferOpts/,
    /@typedef \{\{ offerId: string, optionId: string, query: BusinessFlightQuery\|BusinessHotelQuery, offer\?: object\|null \}\} QuoteInput/,
    /provider\.getOffer\(offerId, pq, \{ optionId \}\)/,
    /provider\.quote\(\{ offerId, optionId, query, offer \}\)/,
    // Builder B: the view models and options.
    /@property \{PriceSource\} source source\.requestSource\(request\)/,
    /@property \{PriceSource\|null\} \[priceSource\] where the counted requests' prices came from/,
    /@property \{PriceSource\|null\} \[priceSource\] the source of the totals this page shows/,
    /each request carries\n \* `price_source`/,
    /demo\?: boolean, source\?: PriceSource\|null \}\) => PolicyDescription\} describe/,
    /parts\.fromSearch reads that from the suffix/,
  ]) assert.match(types, re);
  // Every exported request row carries its source, and the inbox rows inherit it.
  const requestsSrc = fs.readFileSync(path.join(ROOT, 'server', 'business', 'requests.js'), 'utf8');
  assert.match(requestsSrc, /function requestRow\(r, status\) \{[\s\S]*?source: requestSource\(r\),/);
  assert.match(requestsSrc, /function inboxRow\(r, status\) \{[\s\S]*?\.\.\.requestRow\(r, status\),/);
});
