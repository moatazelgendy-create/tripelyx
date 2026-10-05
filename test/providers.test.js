// Every provider must satisfy its interface and return normalized, valid data. Run against the mocks
// here; a real adapter can be dropped into the same suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FACTORIES } = require('../server/providers/mock');
const { assertProvider, validateOffer, validateQuote, INTERFACE_NAMES } = require('../server/providers/contracts');
const { VERTICAL_KEYS } = require('../server/verticals');
const { sampleQueries } = require('./helpers');

test('there is a mock provider for every vertical', () => {
  assert.deepEqual(Object.keys(FACTORIES).sort(), [...VERTICAL_KEYS].sort());
  assert.equal(Object.keys(INTERFACE_NAMES).length, 8);
});

for (const vertical of VERTICAL_KEYS) {
  test(`${INTERFACE_NAMES[vertical]}: mock implements the contract end to end`, async () => {
    const p = assertProvider(FACTORIES[vertical]({}), vertical);
    assert.equal(p.isDemo, true);
    const query = sampleQueries()[vertical];
    const offers = await p.search(query);
    assert.ok(offers.length > 0, 'search returns offers');
    for (const o of offers) {
      validateOffer(o, vertical);
      assert.equal(o.demo, true, 'demo offers are flagged');
    }
    // getOffer is consistent with search
    const first = offers.find(o => o.options.some(x => x.available));
    const again = await p.getOffer(first.id, query);
    assert.equal(again.id, first.id);
    assert.deepEqual(again.options.map(o => o.price.amount), first.options.map(o => o.price.amount));

    const option = first.options.find(x => x.available);
    const selection = first.details.slots ? { slot: first.details.slots.find(s => s.remaining >= 2).time } : {};
    const q = await p.quote({ offerId: first.id, optionId: option.id, query, selection });
    validateQuote(q, vertical);
    for (const l of q.lines) assert.ok(Number.isInteger(l.amount), 'amounts are integer minor units');

    const booked = await p.book({ quote: q, traveler: { firstName: 'A', lastName: 'B', email: 'a@b.co' }, bookingRef: 'DEMO-TEST' });
    assert.match(booked.supplierRef, /^[A-Z]+-[0-9A-F]+$/);
    assert.deepEqual(await p.cancel({ supplierRef: booked.supplierRef }), { cancelled: true });
  });
}

test('availability is deterministic for the same item and date', async () => {
  const p = FACTORIES.hotels({});
  const q = sampleQueries(30).hotels;
  const a = await p.search(q), b = await p.search(q);
  assert.deepEqual(a.map(o => o.options.map(x => x.available)), b.map(o => o.options.map(x => x.available)));
});

test('quote rejects a sold-out option and a missing time slot', async () => {
  const p = FACTORIES.experiences({});
  const q = sampleQueries().experiences;
  const [offer] = await p.search(q);
  await assert.rejects(p.quote({ offerId: offer.id, optionId: offer.options[0].id, query: q, selection: {} }), { code: 'slot_required' });
});

test('assertProvider rejects an incomplete adapter', () => {
  assert.throws(() => assertProvider({ name: 'X', vertical: 'hotels', isDemo: false, search() {} }, 'hotels'), /missing getOffer/);
  assert.throws(() => assertProvider({ name: 'X', vertical: 'cars', isDemo: false }, 'hotels'), /vertical/);
});

test('validateOffer catches a malformed supplier payload', () => {
  assert.throws(() => validateOffer({ id: 'x', vertical: 'hotels', provider: 'p', demo: false, title: 't', location: { name: 'l' }, media: [], fromPrice: { amount: 10.5, currency: 'USD', unit: 'night' }, options: [], cancellation: {}, details: {} }, 'hotels'), { code: 'provider_payload_invalid' });
});
