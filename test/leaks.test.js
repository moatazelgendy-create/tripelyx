// MONEY LEAK HUNTER: every number is a priced version of the trip (never a line read on its own, never
// an estimate); every removal is a token the traveler takes, never applied here; duplicates, meal
// plans, bag configurations and night checks only ever follow the inventory's own facts; the verdict
// on what is worth its money comes from stated preferences alone; no-compromise savings and
// trade-off savings are never one number; the scorecard never adds its lines; the cut order is the
// spec's, never relaxing a rule or a lock; and nothing anywhere pressures the traveler.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { DEFAULT_SETTINGS, priceTrip, publicTrip } = require('../server/trips/pricing');
const optimizer = require('../server/trips/optimizer');
const decision = require('../server/trips/decision');
const savemax = require('../server/trips/savemax');
const { usableTime, classifyChanges, lineAmount, hasChecked } = require('../server/trips/facts');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { addDays, today } = require('../server/lib/dates');
const { format } = require('../server/lib/money');
const leaks = require('../server/trips/leaks');

const inv = createTripIntegrations(loadConfig({ APP_ENV: 'development' }));
const settings = DEFAULT_SETTINGS;
const now = new Date();
const fmt = cents => format(cents, 'USD');
const QUERY = { budget: 200000, vacationBudget: 200000, keep: 0, budgetInput: 2000, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
const result = optimizer.search(inv, QUERY, { settings, now });
const pick = result.picks[0].trip;
const ctx = result.ctx;
const price = (spec, promo = null) => priceTrip(inv, spec, settings, { promo });
const priced = (token, promo = null) => price(decodeSpec(token), promo);
const sum = xs => xs.reduce((n, x) => n + x, 0);
const detail = (t, re) => t.lines.find(l => l.key === 'taxes').detail.find(d => re.test(d.label));
const NO_PREFS = { style: null, priority: null, who: null, bags: null, rules: null, nightsAsked: null };
const RULES = r => ({ nonstop: false, minStars: null, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false, ...r });
const O = (prefs = {}, extra = {}) => ({ now, locks: {}, prefs: { ...NO_PREFS, ...prefs }, ...extra });
// The pressure regex the pages tests use, widened with the engine contract's own list.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict)\b/i;
const TEXTS = [];
function keep(x, depth = 0) { // every string the engine wrote, for one sweep at the end (inventory trips excluded: their policies are not the engine's words)
  if (typeof x === 'string') TEXTS.push(x);
  else if (Array.isArray(x)) x.forEach(v => keep(v, depth + 1));
  else if (x && typeof x === 'object' && !x.spec) Object.values(x).forEach(v => keep(v, depth + 1));
  return x;
}

// A trip with everything optional in it: the search's pick (a fare that sells a bag, so the bag is a
// bought add-on) with two experiences, the transfer and the bag added.
const fare = pick.flight.checkedBagIncluded ? pick.flightOptions.find(f => !f.checkedBagIncluded && f.bagFeePerTraveler > 0).id : pick.spec.flight;
const loaded = price({ ...pick.spec, flight: fare, transfer: true, bags: true, activities: pick.activityOptions.slice(0, 2).map(a => a.id).sort() });
assert.ok(loaded && loaded.activities.length === 2 && loaded.transfer && lineAmount(loaded, 'bags') > 0, 'the pick carries two experiences, a transfer and a bought bag');
const DEPART = addDays(today(now), 30);
const base = (dest, hotel, flight, o = {}) => ({ dest, from: 'JFK', depart: DEPART, nights: 5, travelers: 2, who: 'couple', hotel, flight, activities: [], bags: false, transfer: false, ...o });
function findHotelTrip(want, o) {
  for (const d of inv.maps.listDestinations()) {
    const h = inv.hotels.search({ destId: d.id, checkIn: DEPART, nights: 5, rooms: 1 }).find(want);
    const t = h && price(base(d.id, h.id, 'saver', o));
    if (t) return t;
  }
  return null;
}
const sorted = ids => [...ids].sort();
// Something is given up when the facts rows say so, or when the version brings a compromise of weight
// 2 or more that the trip it replaces does not carry (the test savemax.savingsCheck applies).
const qctx = { ...ctx, budget: null, allowOver: 0 };
const givesUp = (a, b) => classifyChanges(a, b).tradeoffs.length > 0 || decision.compromises(b, qctx).some(x => x.w >= 2 && !decision.compromises(a, qctx).some(y => y.text === x.text));
const joinAnd = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = s => s[0].toUpperCase() + s.slice(1);
// A date the way the engine says it ('Oct 22'), rebuilt from the ISO date so the test asserts the fact, not the engine's own string.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = iso => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
// A supplier with a fourth fare: a twin of the Nonstop Flex fare 8% cheaper with the same schedule, bags and flex. The
// cheapest checked configuration (a Basic fare, no carry-on) then carries a trade-off while a dearer one carries the
// same bags for less with none: the checks that promise "the same bags for less" must find the dearer one.
const twin = { ...inv, flights: { ...inv.flights, search: q => { const fl = inv.flights.search(q); const n = fl.find(f => f.id === 'nonstop'); return n ? [...fl, { ...n, id: 'nonstop2', name: 'Nonstop Twin', farePerTraveler: Math.round(n.farePerTraveler * 0.92), taxesPerTraveler: Math.round(n.taxesPerTraveler * 0.92) }] : fl; } } };
const twinTrip = loaded.flightOptions.some(f => f.id === 'nonstop') ? priceTrip(twin, { ...loaded.spec, flight: 'nonstop', bags: true }, settings) : null;
const twinPrice = token => priceTrip(twin, decodeSpec(token), settings);
// A promo code with a minimum total just under the loaded trip's: removing any optional item ends it, and removing
// the smallest item then costs more than it saves (the discount is bigger than the item).
const promoLine = t => lineAmount(t, 'promo');
const smallest = Math.min(...loaded.activities.map(a => a.pricePerPerson * loaded.spec.travelers), lineAmount(loaded, 'transfer'), lineAmount(loaded, 'bags'));
const BIG = { code: 'BIG', type: 'amount', value: smallest + 5000, minTotal: loaded.total - Math.floor(smallest / 2) };
const withBig = price(loaded.spec, BIG);
assert.ok(withBig && promoLine(withBig) === -(smallest + 5000) && withBig.total === loaded.total - smallest - 5000, 'the promo applies to the loaded trip');

test('breakdown: the rows sum exactly to the total for every pick and for a loaded trip, each row a fact of the price, no mystery line', () => {
  const KINDS = new Set(['mandatory', 'optional', 'core', 'discount']);
  const check = (t, o) => {
    const b = keep(leaks.breakdown(t, o));
    assert.equal(sum(b.rows.map(r => r.amount)), t.total, 'rows sum exactly to the total');
    assert.equal(b.total, t.total);
    assert.equal(b.mandatoryTotal + b.optionalTotal + b.coreTotal + sum(b.rows.filter(r => r.kind === 'discount').map(r => r.amount)), t.total);
    for (const r of b.rows) { assert.ok(KINDS.has(r.kind), r.kind); assert.ok(Number.isInteger(r.amount)); }
    assert.equal(b.rows.find(r => r.key === 'flights').label, `Flight fares for ${t.spec.travelers}`);
    assert.equal(b.rows.find(r => r.key === 'hotel').label, t.lines.find(l => l.key === 'hotel').label);
    assert.equal(b.rows.find(r => r.key === 'flightTaxes').amount, detail(t, /^Flight taxes/).amount);
    assert.equal(b.rows.find(r => r.key === 'hotelTaxes').amount, detail(t, /^Hotel taxes/).amount);
    const fee = detail(t, /resort fee/i), feeRow = b.rows.find(r => r.key === 'resortFee');
    if (fee) { assert.equal(feeRow.amount, fee.amount); assert.equal(feeRow.kind, 'mandatory'); assert.equal(feeRow.note, 'paid in this total, not at the hotel'); } else assert.equal(feeRow, undefined);
    for (const a of t.activities) { const r = b.rows.find(x => x.key === `experience:${a.id}`); assert.equal(r.amount, a.pricePerPerson * t.spec.travelers); assert.equal(r.kind, 'optional'); assert.equal(r.label, a.name); }
    assert.equal(b.rows.filter(r => r.key.startsWith('experience:')).length, t.activities.length);
    assert.equal(!!b.rows.find(r => r.key === 'bags'), lineAmount(t, 'bags') > 0, 'a bag row only when a bag is bought');
    assert.equal(!!b.rows.find(r => r.key === 'transfer'), !!t.transfer);
    assert.equal(b.rows.find(r => r.key === 'service').label, 'Tripelyx service fee (platform fee)');
    assert.match(b.text, /No mystery line items/);
    return b;
  };
  for (const p of result.picks) check(p.trip);
  const b = check(loaded);
  assert.equal(b.rows.find(r => r.key === 'transfer').kind, 'optional');
  assert.equal(b.optionalTotal, lineAmount(loaded, 'experiences') + lineAmount(loaded, 'transfer') + lineAmount(loaded, 'bags'));
  // A transfer the traveler made a rule is mandatory, and says so.
  const ruled = check(loaded, O({ rules: RULES({ transfer: true }) }));
  assert.equal(ruled.rows.find(r => r.key === 'transfer').kind, 'mandatory'); assert.equal(ruled.rows.find(r => r.key === 'transfer').note, 'a rule you set');
  // A resort fee, a transfer, bags and experiences all at once.
  const resort = findHotelTrip(h => h.resortFeePerNight > 0, { transfer: true, bags: true });
  assert.ok(resort, 'the demo has a hotel with a resort fee reachable from JFK');
  const withActs = price({ ...resort.spec, activities: sorted(resort.activityOptions.slice(0, 2).map(a => a.id)) });
  const rb = check(withActs);
  assert.ok(rb.rows.find(r => r.key === 'resortFee') && rb.rows.find(r => r.key === 'bags') && rb.rows.find(r => r.key === 'transfer') && rb.rows.filter(r => r.key.startsWith('experience:')).length === 2);
  // A promo is a discount row, and the sum still holds; a fare that includes the bag has no bag row and says so on the flights row.
  const pb = check(price(withActs.spec, { code: 'TEN', type: 'percent', value: 10 }));
  assert.equal(pb.rows.find(r => r.key === 'promo').kind, 'discount'); assert.ok(pb.rows.find(r => r.key === 'promo').amount < 0);
  const incl = inv.maps.listDestinations().map(d => price(base(d.id, inv.hotels.search({ destId: d.id, checkIn: DEPART, nights: 5, rooms: 1 })[0].id, 'saver', { bags: true }))).find(t => t && t.flight.checkedBagIncluded);
  assert.ok(incl, 'a long-haul fare includes the bag');
  const ib = check(incl);
  assert.equal(ib.rows.find(r => r.key === 'bags'), undefined); assert.match(ib.rows.find(r => r.key === 'flights').note, /checked bag included in the fare/);
});

test('hotelFees: room price + mandatory fees = real hotel total, from the lines; parking is never priced', () => {
  const resort = findHotelTrip(h => h.resortFeePerNight > 0);
  for (const t of [loaded, resort]) {
    const h = keep(leaks.hotelFees(t));
    assert.equal(h.room, lineAmount(t, 'hotel')); assert.equal(h.taxes, detail(t, /^Hotel taxes/).amount);
    assert.equal(h.resortFee, detail(t, /resort fee/i) ? detail(t, /resort fee/i).amount : 0);
    assert.equal(h.mandatory, h.taxes + h.resortFee); assert.equal(h.real, h.room + h.mandatory);
    assert.equal(h.real, lineAmount(t, 'hotel') + detail(t, /^Hotel taxes/).amount + h.resortFee, 'the hotel line plus hotel taxes plus the resort fee');
    assert.equal(h.perNight, Math.round(h.real / t.spec.nights)); assert.equal(h.nights, t.spec.nights); assert.equal(h.rooms, t.rooms);
    assert.deepEqual(h.parking, { known: false, text: 'Parking: not in our data (needs verification)' });
    assert.ok(h.text.includes(fmt(h.room)) && h.text.includes(fmt(h.real)) && h.text.includes('Parking: not in our data (needs verification)'));
  }
  assert.ok(leaks.hotelFees(resort).resortFee > 0 && leaks.hotelFees(resort).text.includes(`resort fee ${fmt(leaks.hotelFees(resort).resortFee)}`));
  assert.ok(leaks.hotelFees(loaded).resortFee === 0 && leaks.hotelFees(loaded).text.includes('no resort fee'));
});

test('seatFees and carCheck: facts of this price only, never a seat fee, never a car to compare, never "together"', () => {
  const basic = price({ ...loaded.spec, flight: 'basic' }), seated = price({ ...loaded.spec, flight: loaded.flightOptions.find(f => f.seatSelection).id });
  for (const t of [loaded, basic, seated]) {
    const s = keep(leaks.seatFees(t));
    assert.deepEqual(s, { inPrice: 0, optional: true, text: `No seat selection fee is in this price. ${t.flight.name}: ${t.flight.seatSelection ? 'seat selection included' : 'seat chosen at check-in'}. Any fee for choosing a seat early is the airline's and is not in our data (needs verification).` });
    assert.doesNotMatch(s.text, /together/i);
  }
  assert.equal(basic.flight.seatSelection, false); assert.match(leaks.seatFees(basic).text, /seat chosen at check-in/);
  assert.equal(seated.flight.seatSelection, true); assert.match(leaks.seatFees(seated).text, /seat selection included/);
  assert.deepEqual(keep(leaks.carCheck(loaded)), { inPrice: false, text: `No rental car is in this trip. A private airport transfer both ways (${fmt(lineAmount(loaded, 'transfer'))}) is. Rental cars are not part of trip packages here, so there is no car version to compare.` });
  assert.deepEqual(keep(leaks.carCheck(price({ ...loaded.spec, transfer: false }))), { inPrice: false, text: 'No rental car is in this trip. No airport transfer is in the price either. Rental cars are not part of trip packages here, so there is no car version to compare.' });
});

test('duplicates: only when the facts hold; the shuttle hotel found by scanning; a transfer rule never offers removal', () => {
  const shuttle = findHotelTrip(h => h.features.airportShuttle, { transfer: true });
  assert.ok(shuttle && shuttle.hotel.features.airportShuttle && shuttle.transfer, 'a demo hotel lists an airport shuttle');
  const d = keep(leaks.duplicates(inv, shuttle, settings, O()));
  assert.equal(d.length, 1); assert.equal(d[0].key, 'shuttle-transfer');
  assert.equal(d[0].amount, lineAmount(shuttle, 'transfer'));
  const without = priced(d[0].token);
  assert.equal(without.transfer, null); assert.equal(without.total, d[0].total); assert.deepEqual({ ...without.spec, transfer: true }, shuttle.spec);
  assert.ok(d[0].text.startsWith(`You may be paying twice for the same need: ${shuttle.hotel.name} lists an airport shuttle, and a private transfer both ways (${fmt(d[0].amount)}) is in the price. Whether the shuttle is free, scheduled, and suits your flight times needs verification.`));
  assert.ok(d[0].label.includes(shuttle.hotel.name));
  // Under a transfer rule: listed, but no version without it is offered.
  const ruled = keep(leaks.duplicates(inv, shuttle, settings, O({ rules: RULES({ transfer: true }) })));
  assert.equal(ruled.length, 1); assert.equal(ruled[0].token, null); assert.equal(ruled[0].total, null); assert.match(ruled[0].text, /a rule you set/);
  // One rules source: the same rule carried on the page context alone (prefs.rules null) is read by duplicates, breakdown
  // and valueOf too, so one scan never calls the transfer a duplicate in one check and a rule you set in the next.
  const cx = { ...ctx, rules: RULES({ transfer: true }) };
  const viaCtx = keep(leaks.duplicates(inv, shuttle, settings, O(), cx));
  assert.equal(viaCtx.length, 1); assert.equal(viaCtx[0].token, null); assert.match(viaCtx[0].text, /a rule you set/);
  assert.equal(leaks.breakdown(shuttle, O(), cx).rows.find(r => r.key === 'transfer').kind, 'mandatory');
  assert.equal(leaks.valueOf('transfer', shuttle, NO_PREFS, cx).worth, true);
  if (!usableTime(shuttle).flags.some(f => f.kind === 'overnight' || f.kind === 'late-arrival')) assert.deepEqual(leaks.valueOf('transfer', shuttle, NO_PREFS, cx), { worth: true, why: 'a transfer is a rule you set' });
  const scan = keep(leaks.finalScan(inv, shuttle, settings, cx, O()));
  assert.equal(scan.checks.find(c => c.key === 'duplicates').status, 'ok'); assert.ok(!scan.found || scan.found.key !== 'duplicates');
  assert.equal(scan.checks.find(c => c.key === 'transport').text, 'The private transfer stays: a rule you set.');
  const cut = keep(leaks.cutInOrder(inv, shuttle, settings, { ...cx, dateMode: 'exact' }, 1, O({}, { locks: { hotel: true, flight: true } })));
  assert.ok(cut.final.trip.transfer && !cut.steps.some(s => s.stage === 'duplicates'), 'a rule on the context is never relaxed by the cut');
  const bl = leaks.biggestLeak(inv, shuttle, settings, { ...cx, dateMode: 'exact' }, O());
  assert.ok(!bl || bl.kind !== 'duplicate');
  // No transfer, or a hotel without a shuttle: no duplicate.
  assert.deepEqual(leaks.duplicates(inv, price({ ...shuttle.spec, transfer: false }), settings, O()), []);
  const plain = shuttle.hotelOptions.find(h => !h.features.airportShuttle);
  assert.deepEqual(leaks.duplicates(inv, price({ ...shuttle.spec, hotel: plain.id }), settings, O()), []);
  assert.deepEqual(leaks.duplicates(inv, loaded, settings, O()), [], 'a bought bag on a fare that sells one is not a duplicate');
  // A bought bag on a fare that includes one is a duplicate only when the add-on costs something: the
  // demo prices it at zero (no line, no duplicate); a supplier that charged for it would be caught.
  const incl = inv.maps.listDestinations().map(d => price(base(d.id, inv.hotels.search({ destId: d.id, checkIn: DEPART, nights: 5, rooms: 1 })[0].id, 'saver', { bags: true }))).find(t => t && t.flight.checkedBagIncluded);
  assert.ok(incl && lineAmount(incl, 'bags') === 0);
  assert.deepEqual(leaks.duplicates(inv, incl, settings, O()), []);
  const charging = { ...inv, flights: { ...inv.flights, search: q => inv.flights.search(q).map(f => (f.checkedBagIncluded ? { ...f, bagFeePerTraveler: 7000 } : f)) } };
  const twice = priceTrip(charging, incl.spec, settings);
  assert.ok(twice.flight.checkedBagIncluded && lineAmount(twice, 'bags') === 14000);
  const dd = keep(leaks.duplicates(charging, twice, settings, O()));
  assert.equal(dd.length, 1); assert.equal(dd[0].key, 'bags-included'); assert.equal(dd[0].amount, 14000);
  assert.equal(dd[0].total, priceTrip(charging, { ...twice.spec, bags: false }, settings).total); assert.equal(decodeSpec(dd[0].token).bags, false);
  assert.equal(dd[0].text, 'You may be paying twice for the same need: this fare already includes a checked bag for each traveler, and a checked-bag add-on ($140) is in the price.');
});

test('bagConfigs: every total is the priced total of its token, keys follow the facts, the saving is the spec\'s arithmetic, rules and locks hold', () => {
  const b = keep(leaks.bagConfigs(inv, loaded, settings, ctx, O()));
  assert.ok(b.configs.length >= 3);
  for (const c of b.configs) {
    const p = priced(c.token);
    assert.equal(c.total, p.total); assert.equal(c.delta, p.total - loaded.total);
    assert.equal(c.key, hasChecked(p) ? 'checked' : p.flight.carryOn ? 'carry-on' : 'personal', 'the key is what the priced trip lets you bring');
    assert.equal(c.flight.id, p.flight.id); assert.equal(c.bagIncluded, !!p.flight.checkedBagIncluded); assert.equal(c.addOn, lineAmount(p, 'bags'));
    assert.deepEqual({ ...p.spec, flight: loaded.spec.flight, bags: loaded.spec.bags }, loaded.spec, 'only the fare and the bag change');
    assert.ok(loaded.flightOptions.some(f => f.id === c.flight.id)); assert.equal(c.allowed, true);
    if (c.key === 'checked' && !c.bagIncluded) assert.ok(c.addOn > 0, 'a bought bag is priced only on a fare that sells one');
    assert.equal(c.tradeoffs.length > 0, givesUp(loaded, p), 'trade-offs listed exactly when something is given up by the facts or a new compromise of weight 2 or more');
  }
  b.configs.forEach((c, i) => { if (i) assert.ok(c.total >= b.configs[i - 1].total, 'cheapest first'); });
  assert.deepEqual(b.current, { key: 'checked', label: b.configs.find(c => c.token === encodeSpec(loaded.spec)).label, total: loaded.total });
  const checked = b.configs.filter(c => c.key === 'checked');
  assert.equal(b.cheapestChecked, checked[0]);
  assert.equal(b.saving, checked[0].total < loaded.total ? loaded.total - checked[0].total : 0, 'vs the current checked configuration');
  if (b.saving) assert.ok(b.text.includes(`you save ${fmt(b.saving)}`) && b.text.includes(fmt(loaded.total)) && b.text.includes(fmt(checked[0].total)));
  assert.deepEqual(b.shared, { supported: false, text: 'One shared checked bag: the fares here price bags per traveler; sharing one bag is not offered, so I don\'t price it.' });
  // The spec's example: CHEAP FARE + required bag vs OTHER FARE bag included. A supplier whose Main
  // fare includes the bag: the Basic fare with a bought bag is compared with it, and the saving is
  // exactly the difference of the two priced trips.
  const incl = { ...inv, flights: { ...inv.flights, search: q => inv.flights.search(q).map(f => (f.id === 'saver' ? { ...f, checkedBagIncluded: true, bagFeePerTraveler: 0 } : f)) } };
  const cheap = priceTrip(incl, { ...loaded.spec, flight: 'basic', bags: true }, settings), other = priceTrip(incl, { ...loaded.spec, flight: 'saver', bags: false }, settings);
  assert.ok(cheap && other && lineAmount(cheap, 'bags') > 0 && other.flight.checkedBagIncluded && lineAmount(other, 'bags') === 0);
  const e = keep(leaks.bagConfigs(incl, cheap, settings, ctx, O()));
  const main = e.configs.find(c => c.flight.id === 'saver');
  assert.equal(main.key, 'checked'); assert.equal(main.bagIncluded, true); assert.equal(main.addOn, 0); assert.equal(main.total, other.total);
  assert.equal(e.configs.filter(c => c.flight.id === 'saver').length, 1, 'a fare that includes the bag has one configuration');
  if (other.total < cheap.total) {
    assert.equal(e.cheapestChecked.token, e.configs.filter(c => c.key === 'checked')[0].token);
    assert.equal(e.saving, cheap.total - e.cheapestChecked.total);
    if (e.cheapestChecked === main) assert.ok(e.text.includes(`${fmt(lineAmount(cheap, 'bags'))} of it the bag`) && e.text.includes(`Main fare ${fmt(other.total)}, bag included: you save ${fmt(cheap.total - other.total)}`), e.text);
  }
  // Rules and locks: a nonstop rule lists only nonstop fares (plus the trip's own), a flight lock only the trip's own fare.
  const ruled = leaks.bagConfigs(inv, loaded, settings, ctx, O({ rules: RULES({ nonstop: true }) }));
  for (const c of ruled.configs) assert.ok(c.flight.id === loaded.spec.flight || priced(c.token).flight.stops === 0);
  const locked = leaks.bagConfigs(inv, loaded, settings, ctx, O({}, { locks: { flight: true } }));
  assert.ok(locked.configs.length >= 1 && locked.configs.every(c => c.flight.id === loaded.spec.flight)); assert.match(locked.text, /locked/);
  // No checked bag: no saving is claimed and nothing is assumed about how they pack.
  const none = keep(leaks.bagConfigs(inv, price({ ...loaded.spec, bags: false }), settings, ctx, O()));
  assert.equal(none.current.key, loaded.flight.carryOn ? 'carry-on' : 'personal'); assert.equal(none.saving, 0); assert.match(none.text, /Nothing is assumed about how you pack/);
  // cheapestSameBags: exactly the traveler's bags, no trade-off, cheaper; carryOn on every configuration is the priced fare's.
  const sameAs = (cfgs, t) => cfgs.find(c => c.key === (hasChecked(t) ? 'checked' : t.flight.carryOn ? 'carry-on' : 'personal') && c.carryOn === !!t.flight.carryOn && !c.tradeoffs.length && c.total < t.total) || null;
  assert.equal(b.cheapestSameBags, sameAs(b.configs, loaded)); assert.equal(b.sameBagsSaving, b.cheapestSameBags ? loaded.total - b.cheapestSameBags.total : 0);
  for (const c of b.configs) assert.equal(c.carryOn, !!priced(c.token).flight.carryOn);
  // A fourth fare that carries the same bags for less with no trade-off while the cheapest checked configuration carries
  // one: cheapestSameBags is that fare, never the cheapest checked one, and the text says both.
  if (twinTrip) {
    const t = keep(leaks.bagConfigs(twin, twinTrip, settings, ctx, O()));
    const same = sameAs(t.configs, twinTrip);
    assert.ok(same && same.flight.id === 'nonstop2', 'the twin fare prices the same bags for less without a trade-off');
    assert.equal(t.cheapestSameBags, same); assert.equal(t.sameBagsSaving, twinTrip.total - same.total);
    for (const c of t.configs) assert.equal(c.carryOn, !!twinPrice(c.token).flight.carryOn);
    if (t.cheapestChecked !== same) {
      assert.ok(t.cheapestChecked.tradeoffs.length, 'the cheapest checked configuration carries a trade-off');
      assert.ok(t.text.includes(`Without a trade-off: Nonstop Twin fare ${fmt(same.total)}${same.bagIncluded ? ', bag included' : ` with the bag added (${fmt(same.addOn)})`}, ${fmt(t.sameBagsSaving)} less for the same bags.`), t.text);
    }
  }
});

test('mealCheck: alternatives priced with the same flight and dates at the same stars or better; absent under a meals rule or a hotel lock', () => {
  // The lowest-star all-inclusive hotel of a destination that also has a hotel of that class or better without the plan.
  const lowestAi = t => t.hotelOptions.filter(h => h.features.allInclusive).sort((a, b) => a.stars - b.stars)[0];
  const comparable = t => { const a = lowestAi(t); return a && t.hotelOptions.some(h => !h.features.allInclusive && h.stars >= a.stars); };
  const home = comparable(pick) ? pick : findHotelTrip(h => h.features.allInclusive) && inv.maps.listDestinations().map(d => price(base(d.id, inv.hotels.search({ destId: d.id, checkIn: DEPART, nights: 5, rooms: 1 })[0].id, 'saver'))).find(t => t && comparable(t));
  assert.ok(home, 'a destination has an all-inclusive hotel and a comparable one without the plan');
  const ai = price({ ...home.spec, hotel: lowestAi(home).id });
  const m = keep(leaks.mealCheck(inv, ai, settings, ctx, O()));
  assert.equal(m.basis, 'all-inclusive');
  for (const a of m.alternatives) {
    const p = priced(a.token);
    assert.equal(a.total, p.total); assert.equal(a.delta, p.total - ai.total);
    assert.deepEqual({ ...p.spec, hotel: ai.spec.hotel }, ai.spec, 'same flight, dates, nights; only the hotel changes');
    assert.ok(p.hotel.stars >= ai.hotel.stars, 'same stars or better');
    assert.equal(a.basis, p.hotel.features.allInclusive ? 'all-inclusive' : p.hotel.features.breakfast ? 'breakfast' : 'room-only');
    assert.notEqual(a.basis, 'all-inclusive'); assert.deepEqual(a.hotel, { id: p.hotel.id, name: p.hotel.name, stars: p.hotel.stars, rating: p.hotel.rating, area: p.hotel.area });
    assert.ok(Array.isArray(a.tradeoffs));
    // The cheapest of its basis among the hotels the rules allow.
    const cheaper = ai.hotelOptions.filter(h => h.id !== ai.spec.hotel && h.stars >= ai.hotel.stars && (h.features.allInclusive ? 'all-inclusive' : h.features.breakfast ? 'breakfast' : 'room-only') === a.basis).map(h => price({ ...ai.spec, hotel: h.id })).filter(Boolean);
    assert.equal(a.total, Math.min(...cheaper.map(x => x.total)));
  }
  assert.ok(m.alternatives.length >= 1, 'a breakfast or room-only alternative exists');
  // Every alternative is a different hotel: every difference by the facts is listed, the trade-offs other than the meals
  // are set apart, and the price difference is attributed to the whole swap, never to the meal plan alone.
  const mealWord = /all-inclusive|breakfast|meals/i;
  for (const x of m.alternatives) {
    const p = priced(x.token), ch = classifyChanges(ai, p);
    assert.deepEqual(x.differs, [...ch.improvements, ...ch.neutral, ...ch.tradeoffs].map(r => `${r.label}: ${r.b}`));
    assert.ok(x.differs.some(w => w.startsWith('Hotel: ')) && x.differs.some(w => w.startsWith('Meals: ')), 'the hotel and the meals always differ');
    assert.deepEqual(x.also, x.tradeoffs.filter(w => !mealWord.test(w)));
  }
  const a = m.alternatives[0], B = a.hotel.name, plan = a.basis === 'breakfast' ? 'with breakfast' : 'room only';
  if (a.delta < 0) {
    const x = fmt(-a.delta), head = `The all-inclusive at ${ai.hotel.name} is ${x} more than ${B} ${plan}. That is a different hotel (${a.differs.join('; ')}), so the ${x} is the difference between the two hotels, not the meal plan alone.`;
    assert.equal(m.question, 'Will you eat at the resort most days?');
    if (a.also.length) assert.equal(m.text, `${head} ${B} also gives up ${joinAnd(a.also)}. If you plan to spend most days outside the resort, I wouldn't automatically pay for the meals; what ${B} gives up is part of the same ${x}, and only you can say what that is worth to you. Your call.`);
    else assert.equal(m.text, `${head} If you plan to spend most days outside the resort, I wouldn't automatically pay the extra ${x}; if you'll eat there, it may be the better value. Your call.`);
  } else { assert.equal(m.question, null); assert.doesNotMatch(m.text, /is \$[\d,.]+ more than/); }
  for (const o of [O({ rules: RULES({ allInclusive: true }) }), O({ rules: RULES({ breakfast: true }) }), O({}, { locks: { hotel: true } })]) {
    const r = keep(leaks.mealCheck(inv, ai, settings, ctx, o));
    assert.deepEqual(r.alternatives, []); assert.equal(r.question, null); assert.equal(r.basis, 'all-inclusive');
  }
  // The all-inclusive style is the traveler's own ask: it is named as what excludes every alternative, never the dates.
  const st = keep(leaks.mealCheck(inv, ai, settings, { ...ctx, style: 'all-inclusive' }, O()));
  assert.deepEqual([st.alternatives, st.question, st.text], [[], null, 'All-inclusive is the style you asked for, so no other meal plan is compared.']);
  // An alternative that also gives up the beachfront (found by scanning the all-inclusive hotels): the text sets that
  // apart and never says "pay the extra $X" as if the $X bought meals alone; the biggest-leak 'meals' candidate carries
  // the hotel, the meals and every other trade-off.
  const aiTrips = inv.maps.listDestinations().flatMap(d => inv.hotels.search({ destId: d.id, checkIn: DEPART, nights: 5, rooms: 1 }).filter(h => h.features.allInclusive).map(h => price(base(d.id, h.id, 'saver')))).filter(Boolean);
  const cheapestAlt = mm => mm.alternatives.filter(x => x.delta < 0).sort((x, y) => x.total - y.total)[0];
  const withAlso = aiTrips.map(t => ({ t, mm: leaks.mealCheck(inv, t, settings, ctx, O()) })).find(({ mm }) => cheapestAlt(mm) && cheapestAlt(mm).also.length);
  if (withAlso) {
    const { t, mm } = withAlso, alt = cheapestAlt(mm);
    keep(mm);
    if (alt === mm.alternatives[0]) assert.ok(mm.text.includes(`${alt.hotel.name} also gives up ${joinAnd(alt.also)}.`) && !mm.text.includes('pay the extra'), mm.text);
    const bl = leaks.biggestLeak(inv, t, settings, { ...ctx, dateMode: 'exact' }, O({}, { locks: { flight: true } }));
    if (bl && bl.kind === 'meals') {
      assert.equal(bl.tradeoff, joinAnd([`hotel: ${alt.hotel.name} instead of ${t.hotel.name}`, `meals: ${alt.basis === 'breakfast' ? 'breakfast' : 'room only'} instead of all-inclusive`, ...alt.also]));
      for (const w of alt.also) assert.ok(bl.text.includes(w), `the biggest-leak text names ${w}`);
    }
  }
  // Not all-inclusive: the cheapest all-inclusive upgrade, said as a cost, never as a saving.
  const plain = price({ ...home.spec, hotel: home.hotelOptions.filter(h => !h.features.allInclusive).sort((a, b) => a.stars - b.stars)[0].id });
  const n = keep(leaks.mealCheck(inv, plain, settings, ctx, O()));
  assert.equal(n.basis, plain.hotel.features.breakfast ? 'breakfast' : 'room-only');
  assert.equal(n.alternatives.length, 1); assert.equal(n.alternatives[0].basis, 'all-inclusive'); assert.equal(n.question, null);
  const u = n.alternatives[0];
  assert.equal(u.total, priced(u.token).total); assert.ok(priced(u.token).hotel.stars >= plain.hotel.stars);
  assert.equal(u.total, Math.min(...plain.hotelOptions.filter(h => h.features.allInclusive && h.stars >= plain.hotel.stars).map(h => price({ ...plain.spec, hotel: h.id }).total)), 'the cheapest all-inclusive of the same class or better');
  const signedU = `${u.delta < 0 ? '−' : '+'}${fmt(Math.abs(u.delta))}`;
  assert.equal(n.text, `All-inclusive at ${u.hotel.name} would be ${signedU}. That is a different hotel (${u.differs.join('; ')}), so the ${signedU} is the difference between the two hotels, not the meal plan alone.${u.also.length ? ` ${u.hotel.name} also gives up ${joinAnd(u.also)}.` : ''} I don't assume all-inclusive saves money; it depends on how many meals you'd have there.`);
});

// Scan origins x destinations for a schedule with the flag asked, on a fare other flights can replace.
function findFlagged(kind, flightId, want = () => true) {
  for (const o of inv.maps.listOrigins()) for (const d of inv.maps.listDestinations()) {
    const from = o.airports[0].code;
    const fl = inv.flights.search({ from, destId: d.id, depart: DEPART, nights: 5, travelers: 2 });
    const f = fl.find(x => x.id === flightId) || fl[0];
    if (!f) continue;
    const t = price(base(d.id, inv.hotels.search({ destId: d.id, checkIn: DEPART, nights: 5, rooms: 1 })[0].id, f.id, { from }));
    const u = t && usableTime(t);
    if (u && u.flags.some(x => x.kind === kind) && want(t, u)) return t;
  }
  return null;
}
const TAIL = 'Starting the hotel on arrival day is not something I can book here yet, and I never leave you without lodging.';
// The first-night sentence the facts allow: "a short one" when the overnight flight lands before 4 AM (the hotel is
// reached that night), "spent in the air" for any other overnight flight, and a late arrival loses the day, not the bed.
const firstNightWords = (t, u, nightCost) => (t.flight.arrivesNextDay
  ? t.flight.arriveMinutes < 4 * 60 ? `You land at ${u.firstDay.arrive} the night after you leave and reach the hotel around ${u.firstDay.settled}, so the first night at ${t.hotel.name} (${fmt(nightCost)} with taxes) is a short one.` : `Your flight lands at ${u.firstDay.arrive} the next day, so the first night at ${t.hotel.name} (${fmt(nightCost)} with taxes) is spent in the air.`
  : `You land at ${u.firstDay.arrive} and reach the hotel around ${u.firstDay.settled}, so the first day is mostly gone: the first night at ${t.hotel.name} (${fmt(nightCost)} with taxes) buys you a bed, not a day.`);

test('nightChecks: fire only when usableTime flags do; every alternative total is the priced total of its token', () => {
  const over = findFlagged('overnight', 'saver');
  assert.ok(over, 'an overnight arrival exists somewhere in the demo');
  const u = usableTime(over);
  const nightCost = Math.round((lineAmount(over, 'hotel') + detail(over, /^Hotel taxes/).amount + (detail(over, /resort fee/i) ? detail(over, /resort fee/i).amount : 0)) / over.spec.nights);
  const n = keep(leaks.nightChecks(inv, over, settings, ctx, O()));
  assert.ok(n.firstNight); assert.equal(n.firstNight.kind, 'overnight'); assert.equal(n.firstNight.nightCost, nightCost);
  assert.equal(n.firstNight.arrive, u.firstDay.arrive); assert.equal(n.firstNight.settled, u.firstDay.settled);
  assert.equal(n.firstNight.text, `${firstNightWords(over, u, nightCost)} ${TAIL}`);
  assert.equal(n.firstNight.short, over.flight.arriveMinutes < 4 * 60);
  // The words follow the facts' own flag: "a short one" exactly when usableTime says so, "spent in the air" only otherwise.
  assert.equal(/is a short one\./.test(n.firstNight.text), /the first night is a short one/.test(u.flags.find(x => x.kind === 'overnight').text));
  assert.equal(/spent in the air/.test(n.firstNight.text), !/the first night is a short one/.test(u.flags.find(x => x.kind === 'overnight').text));
  for (const want of [(t, uu) => t.flight.arriveMinutes < 4 * 60, (t, uu) => t.flight.arriveMinutes >= 4 * 60]) {
    const t = findFlagged('overnight', 'basic', want) || findFlagged('overnight', 'saver', want) || findFlagged('overnight', 'nonstop', want);
    if (!t) continue;
    const x = keep(leaks.nightChecks(inv, t, settings, ctx, O()).firstNight), ut = usableTime(t);
    assert.equal(x.text, `${firstNightWords(t, ut, x.nightCost)} ${TAIL}`); assert.equal(x.short, t.flight.arriveMinutes < 4 * 60);
    assert.ok(x.text.startsWith(ut.flags.find(f => f.kind === 'overnight').text.split(', so the first night')[0]) || !x.short, 'the short night is said in the facts\' own words');
  }
  const late = findFlagged('late-arrival', 'saver') || findFlagged('late-arrival', 'basic') || findFlagged('late-arrival', 'nonstop');
  if (late) {
    const ul = usableTime(late), x = keep(leaks.nightChecks(inv, late, settings, ctx, O()).firstNight);
    assert.equal(x.kind, 'late-arrival'); assert.equal(x.short, false); assert.equal(x.text, `${firstNightWords(late, ul, x.nightCost)} ${TAIL}`);
    assert.doesNotMatch(x.text, /spent in the air|mostly unused/);
  }
  const sameDay = over.flightOptions.filter(f => f.id !== over.spec.flight && !f.arrivesNextDay);
  assert.equal(n.firstNight.alternatives.length, sameDay.length, 'every other fare that lands the same day, and only those');
  for (const a of n.firstNight.alternatives) {
    const p = priced(a.token);
    assert.equal(a.total, p.total); assert.equal(a.delta, p.total - over.total); assert.equal(a.sameDay, true); assert.equal(p.flight.arrivesNextDay, false);
    assert.deepEqual({ ...p.spec, flight: over.spec.flight }, over.spec);
    assert.equal(a.text, `${p.flight.name} lands at ${a.flight.arrive}: ${a.delta < 0 ? '−' : '+'}${fmt(Math.abs(a.delta))}`);
  }
  assert.equal(n.lastDay, u.flags.some(x => x.kind === 'early-return') ? n.lastDay : null);
  // The Basic fare flies home at dawn: an early return, with the later fares priced as alternatives.
  const early = findFlagged('early-return', 'basic');
  assert.ok(early && early.spec.flight === 'basic');
  const ue = usableTime(early);
  const e = keep(leaks.nightChecks(inv, early, settings, ctx, O()));
  assert.ok(e.lastDay); assert.equal(e.lastDay.kind, 'early-return'); assert.equal(e.lastDay.depart, ue.lastDay.depart); assert.equal(e.lastDay.leaveHotel, ue.lastDay.leaveHotel);
  const later = early.flightOptions.filter(f => f.id !== 'basic' && f.returnDepartMinutes > early.flight.returnDepartMinutes);
  assert.equal(e.lastDay.alternatives.length, later.length);
  // The text lists the later fares it priced, or says plainly that none exists; it never dangles on "the day back:".
  const head = `The flight home leaves at ${ue.lastDay.depart}, so you leave ${early.hotel.name} around ${ue.lastDay.leaveHotel}: the last night (${fmt(e.lastDay.nightCost)}) buys you a bed, not a day. I don't remove it; `;
  assert.equal(e.lastDay.text, `${head}${later.length ? `a later flight would give you the day back: ${e.lastDay.alternatives.map(a => a.text).join('; ')}.` : 'no fare on this date flies home later.'}`);
  for (const a of e.lastDay.alternatives) { const p = priced(a.token); assert.equal(a.total, p.total); assert.equal(a.delta, p.total - early.total); assert.ok(p.flight.returnDepartMinutes > early.flight.returnDepartMinutes); assert.equal(a.leaveHotel, usableTime(p).lastDay.leaveHotel); assert.ok(e.lastDay.text.includes(a.text)); }
  assert.equal(e.firstNight, ue.flags.some(x => x.kind === 'overnight' || x.kind === 'late-arrival') ? e.firstNight : null);
  // Locks and rules hold: a locked flight has no alternatives; a nonstop rule only nonstop ones; each says why nothing is listed.
  const lk = keep(leaks.nightChecks(inv, early, settings, ctx, O({}, { locks: { flight: true } })).lastDay);
  assert.deepEqual(lk.alternatives, []); assert.equal(lk.text, `${head}flights are locked, so no later fare is priced.`);
  const ns = keep(leaks.nightChecks(inv, early, settings, ctx, O({ rules: RULES({ nonstop: true }) })).lastDay);
  for (const a of ns.alternatives) assert.equal(priced(a.token).flight.stops, 0);
  if (later.length && !later.some(f => f.stops === 0)) assert.equal(ns.text, `${head}the later ${later.length === 1 ? 'fare' : 'fares'} on this date (${later.map(x => x.name).join(', ')}) ${later.length === 1 ? 'is' : 'are'} outside your rules, so none is priced.`);
  else if (ns.alternatives.length) assert.ok(ns.text.includes('a later flight would give you the day back: '));
  for (const t of [e.lastDay.text, lk.text, ns.text]) assert.doesNotMatch(t, /day back:$/);
  // No flags, nothing: the pick's own fare, and an adapter with no schedule.
  const calm = [pick, ...result.picks.map(p => p.trip)].find(t => usableTime(t) && !usableTime(t).flags.length);
  if (calm) assert.deepEqual(leaks.nightChecks(inv, calm, settings, ctx, O()), { firstNight: null, lastDay: null });
  assert.deepEqual(leaks.nightChecks(inv, { ...early, flight: { ...early.flight, departMinutes: undefined } }, settings, ctx, O()), { firstNight: null, lastDay: null });
});

test('optionalExtras: each amount is the trip total minus the priced version without it; a stated rule keeps it listed but required', () => {
  const x = keep(leaks.optionalExtras(inv, loaded, settings, ctx, O()));
  assert.deepEqual(x.map(e => e.key), [...loaded.activities.map(a => `experience:${a.id}`), 'transfer', 'bags']);
  for (const e of x) {
    const p = priced(e.token);
    assert.equal(e.amount, loaded.total - p.total); assert.equal(e.total, p.total); assert.equal(e.required, false);
    const back = e.key === 'transfer' ? { ...p.spec, transfer: true } : e.key === 'bags' ? { ...p.spec, bags: true } : { ...p.spec, activities: sorted([...p.spec.activities, e.key.slice(11)]) };
    assert.deepEqual(back, loaded.spec, 'the version without exactly this item');
  }
  assert.equal(sum(x.map(e => e.amount)), lineAmount(loaded, 'experiences') + lineAmount(loaded, 'transfer') + lineAmount(loaded, 'bags'));
  const ruled = leaks.optionalExtras(inv, loaded, settings, ctx, O({ rules: RULES({ transfer: true }), bags: 'checked' }));
  assert.equal(ruled.find(e => e.key === 'transfer').required, true); assert.equal(ruled.find(e => e.key === 'transfer').reason, 'a rule you set'); assert.equal(ruled.find(e => e.key === 'transfer').stated, true);
  assert.equal(ruled.find(e => e.key === 'bags').required, true); assert.ok(ruled.find(e => e.key === 'bags').token, 'still priced, never removed'); assert.equal(ruled.find(e => e.key === 'bags').stated, true);
  for (const e of x) assert.deepEqual([e.stated, e.promoLost, e.promoChange, e.note, e.lineOnly], [false, false, 0, null, e.amount], 'without a promo the item\'s own price is the saving');
  // With a promo the amounts are differences of promo prices, not line amounts.
  const promo = { code: 'TEN', type: 'percent', value: 10 };
  const lp = price(loaded.spec, promo);
  for (const e of leaks.optionalExtras(inv, lp, settings, ctx, O({}, { promo }))) { assert.equal(e.amount, lp.total - priced(e.token, promo).total); assert.equal(e.promoLost, false); assert.equal(e.promoChange, promoLine(priced(e.token, promo)) - promoLine(lp)); }
  // A promo code with a minimum total: the amount is what the total actually drops by, lineOnly the item's own price,
  // the note says both, and a removal that would cost more is listed as not removable with that reason: a negative
  // difference is never called a saving and no page is handed a REMOVE link that costs money.
  const xb = keep(leaks.optionalExtras(inv, withBig, settings, ctx, O({}, { promo: BIG })));
  assert.deepEqual(xb.map(e => e.key), x.map(e => e.key));
  for (const e of xb) {
    const p = priced(e.token, BIG);
    assert.equal(e.amount, withBig.total - p.total); assert.equal(e.total, p.total);
    assert.equal(e.promoLost, promoLine(p) === 0); assert.equal(e.promoChange, promoLine(p) - promoLine(withBig)); assert.ok(e.promoLost && e.promoChange === smallest + 5000, 'removing any item ends the code');
    assert.equal(e.lineOnly, x.find(y => y.key === e.key).amount, 'the item\'s own price'); assert.equal(e.stated, false);
    if (e.amount > 0) { assert.equal(e.required, false); assert.equal(e.note, `removing it also ends the Promo code BIG: the total drops by ${fmt(e.amount)}, not ${fmt(e.lineOnly)}`); }
    else { assert.equal(e.required, true); assert.equal(e.reason, `removing it would not save money: removing it ends the Promo code BIG, so the total would ${e.amount === 0 ? 'not change' : `rise by ${fmt(-e.amount)}`}`); }
  }
  assert.ok(xb.some(e => e.amount < 0), 'removing the smallest item costs more than it saves');
  if (x.some(e => e.amount > smallest + 5000)) assert.ok(xb.some(e => e.amount > 0 && e.note), 'a larger item still saves, and the note says how much');
  assert.deepEqual(leaks.optionalExtras(inv, price({ ...loaded.spec, activities: [], transfer: false, bags: false }), settings, ctx, O()), []);
});

test('valueOf: from stated preferences and trip facts only; change a preference and the verdict changes; margin is never an input', () => {
  // A trip whose destination offers a beach experience and one of another kind (the pick's, or any).
  const offers = t => t && t.activityOptions.some(a => a.kind === 'beach') && t.activityOptions.some(a => a.kind !== 'beach');
  const tb = offers(loaded) ? loaded : inv.maps.listDestinations().map(d => price(base(d.id, inv.hotels.search({ destId: d.id, checkIn: DEPART, nights: 5, rooms: 1 })[0].id, 'saver'))).find(offers);
  const beach = tb.activityOptions.find(a => a.kind === 'beach'), other = tb.activityOptions.find(a => a.kind !== 'beach');
  const key = a => `experience:${a.id}`;
  assert.deepEqual(leaks.valueOf(key(beach), tb, NO_PREFS), { worth: false, why: 'nothing you told me asks for it' });
  assert.deepEqual(leaks.valueOf(key(beach), tb, { ...NO_PREFS, style: 'beach' }), { worth: true, why: 'a beach experience fits the beach trip you asked for' });
  assert.equal(leaks.valueOf(key(other), tb, { ...NO_PREFS, style: 'beach' }).worth, false, `a ${other.kind} experience is not asked for by a beach trip`);
  assert.deepEqual(leaks.valueOf(key(other), tb, { ...NO_PREFS, priority: 'activities' }), { worth: true, why: 'you said experiences matter' });
  assert.equal(leaks.valueOf(key(beach), tb, { ...NO_PREFS, style: 'city' }).worth, false);
  assert.equal(leaks.valueOf({ key: key(beach) }, tb, { ...NO_PREFS, style: 'romantic' }).worth, true, 'an item object works too');
  assert.equal(leaks.valueOf(key(beach), price({ ...tb.spec, activities: [beach.id] }), { ...NO_PREFS, style: 'beach' }).worth, true, 'an experience in the trip reads the same');
  // The transfer: a late landing, a family or a rule; otherwise nothing asks for it.
  const calm = usableTime(loaded).flags.some(f => f.kind === 'overnight' || f.kind === 'late-arrival');
  assert.equal(leaks.valueOf('transfer', loaded, NO_PREFS).worth, calm);
  if (!calm) assert.deepEqual(leaks.valueOf('transfer', loaded, NO_PREFS), { worth: false, why: 'nothing you told me asks for it' });
  assert.deepEqual(leaks.valueOf('transfer', loaded, { ...NO_PREFS, who: 'family' }), calm ? { worth: true, why: 'you land late' } : { worth: true, why: 'with a family, a private transfer is worth considering' });
  assert.equal(leaks.valueOf('transfer', loaded, { ...NO_PREFS, rules: RULES({ transfer: true }) }).worth, true);
  const over = findFlagged('overnight', 'saver');
  assert.deepEqual(leaks.valueOf('transfer', over, NO_PREFS), { worth: true, why: 'you land late' });
  assert.deepEqual(leaks.valueOf('bags', loaded, NO_PREFS), { worth: false, why: 'nothing you told me asks for it' });
  assert.deepEqual(leaks.valueOf('bags', loaded, { ...NO_PREFS, bags: 'checked' }), { worth: true, why: 'you said you travel with a checked bag' });
  assert.equal(leaks.valueOf('bags', loaded, { ...NO_PREFS, bags: 'carry-on' }).worth, false);
  // The internal economics are not read: the same verdict without them, and with them changed.
  for (const k of [key(beach), 'transfer', 'bags']) for (const p of [NO_PREFS, { ...NO_PREFS, style: 'beach', who: 'family', bags: 'checked' }]) {
    assert.deepEqual(leaks.valueOf(k, publicTrip(loaded), p), leaks.valueOf(k, loaded, p));
    assert.deepEqual(leaks.valueOf(k, { ...loaded, internal: { ...loaded.internal, marginPercent: 99, grossProfit: 10 ** 9 } }, p), leaks.valueOf(k, loaded, p));
  }
});

test('lean: removes only optional items, keeps flight, hotel, dates and nights; the difference is exactly the removed items, priced', () => {
  const L = keep(leaks.lean(inv, loaded, settings, ctx, O()));
  const lt = L.lean.trip;
  assert.equal(L.lean.token, encodeSpec(lt.spec)); assert.equal(L.lean.total, priced(L.lean.token).total); assert.equal(L.current.token, encodeSpec(loaded.spec)); assert.equal(L.current.total, loaded.total);
  assert.deepEqual({ ...lt.spec, activities: loaded.spec.activities, transfer: true, bags: true }, loaded.spec, 'only the optional items changed');
  assert.deepEqual(lt.spec.activities, []); assert.equal(lt.transfer, null); assert.equal(lt.spec.bags, false);
  assert.equal(L.difference, loaded.total - lt.total);
  assert.equal(L.difference, sum(L.removed.map(r => r.amount)), 'the difference is the removed items and nothing more');
  assert.deepEqual(L.removed.map(r => r.key), [...loaded.activities.map(a => `experience:${a.id}`), 'transfer', 'bags']);
  assert.deepEqual(L.givesUp, L.removed.map(r => r.label));
  assert.deepEqual(L.kept, [`Round-trip flights (${loaded.flight.name})`, `5 nights at ${loaded.hotel.name}`, 'Taxes, mandatory fees and the service fee']);
  assert.ok(L.text.startsWith(`Current ${fmt(loaded.total)}. Lean ${fmt(lt.total)}. Difference ${fmt(L.difference)}. What you give up: `));
  // A transfer rule keeps the transfer; a stated checked bag keeps the bag; both are named as kept.
  const R = keep(leaks.lean(inv, loaded, settings, ctx, O({ rules: RULES({ transfer: true, minStars: 3 }), bags: 'checked' })));
  assert.ok(R.lean.trip.transfer && R.lean.trip.spec.bags); assert.deepEqual(R.removed.map(r => r.key), loaded.activities.map(a => `experience:${a.id}`));
  assert.equal(R.difference, loaded.total - R.lean.total); assert.equal(R.lean.total, priced(R.lean.token).total);
  assert.ok(R.kept.includes('Airport transfer (a rule you set)') && R.kept.includes('Checked bag for each traveler (you said you travel with one)'));
  if (loaded.hotel.stars >= 3) assert.ok(R.kept.includes('3-star or better (a rule you set)')); else assert.ok(R.notKept.includes(`3-star or better (a rule you set; this hotel is ${loaded.hotel.stars}-star)`));
  assert.deepEqual([L.notKept, L.promoLost, R.promoLost], [[], false, false]);
  // A stated rule the lean trip's facts do not meet is never "kept": it goes under notKept with why, and the text says
  // so (a 1-stop fare under a nonstop rule, a lower-star hotel under a star rule), from prefs or from the page context alike.
  const oneStop = loaded.flightOptions.find(f => f.stops > 0), low = loaded.hotelOptions.find(h => h.stars < 4);
  if (oneStop && low) {
    const bad = price({ ...loaded.spec, flight: oneStop.id, hotel: low.id });
    const rules = RULES({ nonstop: true, minStars: 4, beachfront: true, refundable: true, allInclusive: true, breakfast: true, transfer: true });
    for (const [cx, o] of [[ctx, O({ rules })], [{ ...ctx, rules }, O()]]) {
      const B = keep(leaks.lean(inv, bad, settings, cx, o)), lt2 = B.lean.trip;
      assert.ok(lt2.transfer, 'the transfer rule keeps the transfer in the lean version');
      const expect = { 'Nonstop flights': [lt2.flight.stops === 0, `this trip has ${lt2.flight.stops} stop${lt2.flight.stops === 1 ? '' : 's'}`], '4-star or better': [lt2.hotel.stars >= 4, `this hotel is ${lt2.hotel.stars}-star`], 'All-inclusive': [!!lt2.hotel.features.allInclusive, 'this hotel is not'], 'Breakfast included': [!!(lt2.hotel.features.breakfast || lt2.hotel.features.allInclusive), 'not at this hotel'], Beachfront: [!!lt2.hotel.features.beachfront, `this hotel is in ${lt2.hotel.area}`], 'Airport transfer': [!!lt2.transfer, 'not in this price'], Refundable: [!!(lt2.flight.refundable && lt2.hotel.refundable), 'not every part of this trip is'] };
      for (const [w, [met, why]] of Object.entries(expect)) { assert.equal(B.kept.includes(`${w} (a rule you set)`), met, `${w} is kept only when the facts meet it`); assert.equal(B.notKept.includes(`${w} (a rule you set; ${why})`), !met, `${w} not met says why`); }
      assert.ok(B.notKept.length >= 2 && !B.kept.some(k => /^(Nonstop flights|4-star or better) \(a rule you set\)$/.test(k)));
      assert.ok(B.text.includes(` Kept: ${joinAnd(B.kept)}. Not met by this trip: ${joinAnd(B.notKept)}.`), B.text);
    }
  }
  // The promo code with a minimum ends with the extras: the difference is the real drop, said as not the sum of the items.
  const PB = keep(leaks.lean(inv, withBig, settings, ctx, O({}, { promo: BIG })));
  assert.equal(PB.difference, withBig.total - priced(PB.lean.token, BIG).total); assert.equal(PB.lean.total, priced(PB.lean.token, BIG).total);
  assert.equal(PB.promoLost, true); assert.equal(promoLine(PB.lean.trip), 0);
  if (PB.difference > 0) assert.ok(PB.text.includes(` What you give up: ${joinAnd(PB.givesUp)}. Removing them also ends the Promo code BIG: the difference is ${fmt(PB.difference)}, not ${fmt(sum(PB.removed.map(r => r.amount)))}. Kept: `), PB.text);
  else assert.ok(PB.text.includes('no less, because without') && PB.text.includes('Taking the lean version would not save money'), PB.text);
  // Already lean: the same version, difference zero, said plainly.
  const Z = keep(leaks.lean(inv, lt, settings, ctx, O()));
  assert.equal(Z.difference, 0); assert.equal(Z.lean.token, Z.current.token); assert.deepEqual([Z.removed, Z.givesUp], [[], []]);
  assert.equal(Z.text, 'Nothing optional is in this price: it is already the lean version.');
  const ZR = keep(leaks.lean(inv, lt, settings, ctx, O({ rules: RULES({ minStars: 5 }) })));
  if (lt.hotel.stars < 5) assert.equal(ZR.text, `Nothing optional is in this price: it is already the lean version. Kept: ${joinAnd(ZR.kept)}. Not met by this trip: 5-star or better (a rule you set; this hotel is ${lt.hotel.stars}-star).`);
});

test('addBack: each cost is the priced difference on the lean version alone; verdicts follow valueOf from stated preferences', () => {
  const L = leaks.lean(inv, loaded, settings, ctx, O());
  const items = keep(leaks.addBack(inv, L.lean.trip, L.removed, settings, ctx, O()));
  assert.deepEqual(items.map(i => i.key), L.removed.map(r => r.key));
  for (const i of items) {
    const p = priced(i.token);
    assert.equal(i.cost, p.total - L.lean.total); assert.equal(i.total, p.total);
    const without = i.key === 'transfer' ? { ...p.spec, transfer: false } : i.key === 'bags' ? { ...p.spec, bags: false } : { ...p.spec, activities: p.spec.activities.filter(x => x !== i.key.slice(11)) };
    assert.deepEqual(without, L.lean.trip.spec, 'the lean version plus exactly this item');
    assert.equal(i.verdict, 'keep'); assert.equal(i.text, `+${fmt(i.cost)} ${i.label}: I'D KEEP THE ${fmt(i.cost)} (nothing you told me asks for it)`);
  }
  const beach = loaded.activities.find(a => a.kind === 'beach');
  const prefs = { style: 'beach', who: 'family', bags: 'checked' };
  const flipped = keep(leaks.addBack(inv, L.lean.trip, L.removed, settings, ctx, O(prefs)));
  for (const i of flipped) {
    const v = leaks.valueOf(i.key, priced(i.token), { ...NO_PREFS, ...prefs });
    assert.equal(i.verdict, v.worth ? 'worth' : 'keep'); assert.equal(i.why, v.why);
    if (v.worth) assert.equal(i.text, `+${fmt(i.cost)} ${i.label}: WORTH CONSIDERING (${v.why})`);
  }
  if (beach) assert.equal(flipped.find(i => i.key === `experience:${beach.id}`).verdict, 'worth');
  assert.equal(flipped.find(i => i.key === 'bags').verdict, 'worth'); assert.equal(flipped.find(i => i.key === 'transfer').verdict, 'worth');
  assert.deepEqual(flipped.map(i => i.cost), items.map(i => i.cost), 'a preference changes the verdict, never the price');
  assert.deepEqual(leaks.addBack(inv, L.lean.trip, [], settings, ctx, O()), []);
});

test('removeOne: the largest saving among items nothing stated asks for; null when every optional item was asked for or nothing is optional', () => {
  const r = keep(leaks.removeOne(inv, loaded, settings, ctx, O()));
  const x = leaks.optionalExtras(inv, loaded, settings, ctx, O()).filter(e => !leaks.valueOf(e.key, loaded, NO_PREFS).worth);
  assert.ok(r && x.length);
  assert.equal(r.saving, Math.max(...x.map(e => e.amount))); assert.equal(r.total, priced(r.token).total); assert.equal(r.saving, loaded.total - r.total);
  assert.equal(r.text, `I'd remove ${r.label}. Save ${fmt(r.saving)}. Everything else remains.`); assert.equal(r.why, 'nothing you told me asks for it');
  // A preference changes which item goes: a stated bag keeps the bag.
  const kept = leaks.removeOne(inv, loaded, settings, ctx, O({ bags: 'checked' }));
  assert.ok(kept && kept.key !== 'bags');
  // Everything asked for: null. Nothing optional: null.
  const all = { priority: 'activities', who: usableTime(loaded).flags.some(f => f.kind === 'overnight' || f.kind === 'late-arrival') ? null : 'family', bags: 'checked' };
  assert.ok(leaks.optionalExtras(inv, loaded, settings, ctx, O(all)).every(e => leaks.valueOf(e.key, loaded, { ...NO_PREFS, ...all }).worth));
  assert.equal(leaks.removeOne(inv, loaded, settings, ctx, O(all)), null);
  assert.equal(leaks.removeOne(inv, leaks.lean(inv, loaded, settings, ctx, O()).lean.trip, settings, ctx, O()), null);
  assert.equal(leaks.removeOne(inv, price({ ...loaded.spec, activities: [], bags: false }), settings, ctx, O({ rules: RULES({ transfer: true }) })), null, 'a rule is never removed');
  assert.equal(r.note, null);
  // Across a promo minimum: the saving is the real drop, the note says the code ends, and "everything else remains" is never said alone.
  const rb = keep(leaks.removeOne(inv, withBig, settings, ctx, O({}, { promo: BIG })));
  const xb = leaks.optionalExtras(inv, withBig, settings, ctx, O({}, { promo: BIG })).filter(e => !e.required && e.amount > 0);
  if (xb.length) {
    assert.ok(rb); assert.equal(rb.saving, Math.max(...xb.map(e => e.amount))); assert.equal(rb.saving, withBig.total - priced(rb.token, BIG).total);
    assert.equal(rb.note, xb.find(e => e.key === rb.key).note); assert.equal(rb.text, `I'd remove ${rb.label}. Save ${fmt(rb.saving)}. ${cap(rb.note)}. Everything else in the trip remains.`);
  } else assert.equal(rb, null, 'nothing is offered when every removal would cost more');
  // whyKept: the honest sentence behind a null. "One you asked for" only for a stated ask; an engine inference ("you land late") is worded as that.
  const k = keep(leaks.whyKept(inv, loaded, settings, ctx, O(all)));
  assert.equal(k.items.length, leaks.optionalExtras(inv, loaded, settings, ctx, O(all)).length); assert.equal(k.kept.length, k.items.length);
  for (const i of k.items) { assert.equal(i.why, leaks.valueOf(i.key, loaded, { ...NO_PREFS, ...all }).why); assert.ok(k.text.includes(`${i.label} (${i.why})`)); assert.equal(i.stated, /^you said|a rule you set$/.test(i.why)); }
  assert.equal(k.allStated, k.items.every(i => i.stated));
  assert.ok(k.text.startsWith(k.allStated ? 'Every optional item in this price is one you asked for: ' : 'Every optional item in this price is one I\'d keep by what you told me and the trip\'s facts: '), k.text);
  const landsLate = price({ ...findFlagged('overnight', 'saver').spec, transfer: true });
  assert.ok(landsLate.transfer && !landsLate.activities.length && !lineAmount(landsLate, 'bags') && leaks.valueOf('transfer', landsLate, NO_PREFS).why === 'you land late');
  assert.equal(leaks.removeOne(inv, landsLate, settings, ctx, O()), null);
  const kl = keep(leaks.whyKept(inv, landsLate, settings, ctx, O()));
  assert.equal(kl.text, 'Every optional item in this price is one I\'d keep by what you told me and the trip\'s facts: Airport transfer, both ways (you land late).');
  assert.deepEqual([kl.allStated, kl.items.map(i => i.stated), kl.kept.length], [false, [false], 1]);
  assert.equal(keep(leaks.whyKept(inv, price({ ...landsLate.spec, transfer: false }), settings, ctx, O())).text, 'Nothing optional is in this price.');
  const kr = keep(leaks.whyKept(inv, landsLate, settings, ctx, O({ rules: RULES({ transfer: true }) })));
  assert.deepEqual([kr.allStated, kr.text], [true, 'Every optional item in this price is one you asked for: Airport transfer, both ways (a rule you set).']);
  const kn = keep(leaks.whyKept(inv, loaded, settings, ctx, O()));
  assert.ok(kn.kept.length < kn.items.length && /^\d+ optional items? in this price (is|are) not asked for by anything you told me\.$/.test(kn.text), kn.text);
});

test('biggestLeak: never a trade-off candidate while a no-trade-off candidate exists; the difference is current minus alternative, priced', () => {
  const b = keep(leaks.biggestLeak(inv, loaded, settings, ctx, O()));
  assert.ok(b); assert.equal(b.tradeoff, null, 'free cuts exist, so no trade-off is named');
  assert.equal(b.difference, b.current - b.alternative); assert.ok(b.difference > 0); assert.equal(b.total, priced(b.token).total);
  assert.equal(b.text, `BIGGEST AVOIDABLE COST: ${b.label}. Current: ${fmt(b.current)}. ${b.alternativeLabel}: ${fmt(b.alternative)}. Potential difference: ${fmt(b.difference)}.`);
  if (b.kind === 'extra') { assert.equal(b.alternative, 0); assert.equal(b.difference, loaded.total - b.total); assert.ok(leaks.optionalExtras(inv, loaded, settings, ctx, O()).some(e => e.token === b.token && e.amount === b.current)); }
  else assert.equal(b.current, loaded.total);
  // Every free cut must be at most the one named: the largest optional item nothing asks for is a lower bound.
  const freeExtras = leaks.optionalExtras(inv, loaded, settings, ctx, O()).filter(e => !leaks.valueOf(e.key, loaded, NO_PREFS).worth);
  assert.ok(b.difference >= Math.max(...freeExtras.map(e => e.amount)));
  assert.equal(b.note, null);
  // A like-for-like version is named by what it differs on, never "the same trip, priced lower": the twin fare, 8%
  // cheaper with the same schedule and bags, is "the same trip on the Nonstop Twin fare" or the same-bags configuration.
  if (twinTrip) {
    const tb = keep(leaks.biggestLeak(twin, twinTrip, settings, { ...ctx, dateMode: 'exact' }, O({ priority: 'activities', who: 'family', bags: 'checked' })));
    assert.ok(tb && tb.tradeoff === null && ['bags', 'config'].includes(tb.kind), tb && tb.text);
    const p = twinPrice(tb.token);
    assert.equal(hasChecked(p), true); assert.equal(classifyChanges(twinTrip, p).tradeoffs.length, 0); assert.doesNotMatch(tb.label, /priced lower/);
    if (tb.kind === 'bags') { assert.equal(p.flight.id, 'nonstop2'); assert.ok(tb.label.startsWith('Nonstop Twin fare: checked bag')); }
    else assert.equal(tb.label, `The same trip ${joinAnd([...(p.spec.flight !== twinTrip.spec.flight ? [`on the ${p.flight.name} fare`] : []), ...(p.spec.hotel !== twinTrip.spec.hotel ? [`at ${p.hotel.name}`] : [])])} (like-for-like)`);
  }
  // Across a promo minimum the text carries the note, and the numbers stay differences of two totals.
  const pb = keep(leaks.biggestLeak(inv, withBig, settings, { ...ctx, dateMode: 'exact' }, O({}, { promo: BIG })));
  if (pb && pb.kind === 'extra') { assert.ok(pb.note && pb.text.endsWith(` ${cap(pb.note)}.`)); assert.equal(pb.difference, withBig.total - priced(pb.token, BIG).total); }
  // When every optional item is asked for and the dates are held, only trade-off candidates remain and the text says what changes.
  const all = { priority: 'activities', who: 'family', bags: 'checked' };
  const t = keep(leaks.biggestLeak(inv, loaded, settings, { ...ctx, dateMode: 'exact' }, O(all)));
  if (t) {
    assert.ok(t.tradeoff, 'a trade-off candidate is named only when no free one exists');
    assert.ok(t.text.endsWith(` It changes: ${t.tradeoff}.`)); assert.equal(t.difference, t.current - t.alternative); assert.equal(t.total, priced(t.token).total);
    assert.notEqual(t.kind, 'dates', 'an exact date is never moved');
    const scan = leaks.finalScan(inv, loaded, settings, { ...ctx, dateMode: 'exact' }, O(all));
    assert.equal(scan.found, null, 'no free cut exists by the final scan either');
  }
  // Nothing avoidable: a lean trip with everything held.
  const lt = leaks.lean(inv, loaded, settings, ctx, O()).lean.trip;
  const held = leaks.biggestLeak(inv, lt, settings, { ...ctx, dateMode: 'exact' }, O({}, { locks: { hotel: true, flight: true, dates: true, nights: true } }));
  assert.ok(held === null || (held.kind === 'config' && held.tradeoff === null && held.difference >= 2500));
});

test('freeSavings: free has no trade-off by the facts and lists only equal facts; sacrifice has a trade-off and is a separate object', () => {
  // The same trip on a dearer nearby date: the way back down gives nothing up.
  const dearer = [-3, -2, -1, 1, 2, 3].map(o => price({ ...pick.spec, depart: addDays(pick.spec.depart, o) })).filter(p => p && p.total >= pick.total + 2500).sort((a, b) => b.total - a.total)[0];
  assert.ok(dearer, 'the demo prices a nearby date more than $25 dearer');
  const f = keep(leaks.freeSavings(inv, dearer, settings, ctx, O()));
  assert.ok(f.free, 'a free saving exists');
  const fr = f.free;
  assert.equal(fr.token, encodeSpec(fr.trip.spec)); assert.equal(fr.total, fr.trip.total); assert.equal(fr.total, priced(fr.token).total); assert.equal(fr.delta, fr.total - dearer.total); assert.ok(fr.delta <= -2500);
  const ch = classifyChanges(dearer, fr.trip), changedKeys = new Set([...ch.improvements, ...ch.neutral].map(r => r.key));
  assert.equal(ch.tradeoffs.length, 0, 'zero trade-offs by classifyChanges');
  const sameDate = fr.trip.spec.depart === dearer.spec.depart, sameFare = fr.trip.spec.flight === dearer.spec.flight && !changedKeys.has('flight') && !changedKeys.has('time');
  // "Same" only for what is truly the same: the same fare on another date is not "same flights".
  const facts = { 'Same hotel': fr.trip.spec.hotel === dearer.spec.hotel, 'Same nights': fr.trip.spec.nights === dearer.spec.nights, 'Same dates': sameDate, 'Same flights': sameFare && sameDate, [`Same fare (${fr.trip.flight.name})`]: sameFare && !sameDate, 'Same nonstop rule': !sameFare && fr.trip.flight.stops === 0 && dearer.flight.stops === 0, 'Same bags': hasChecked(fr.trip) === hasChecked(dearer) && !!fr.trip.flight.carryOn === !!dearer.flight.carryOn, 'Same experiences': sorted(fr.trip.spec.activities).join() === sorted(dearer.spec.activities).join() };
  for (const s of fr.same) assert.equal(facts[s], true, `${s} is a fact`);
  for (const [k, v] of Object.entries(facts)) if (v) assert.ok(fr.same.includes(k), `${k} is listed`);
  assert.ok(fr.same.includes('Same experiences'), 'the traveler\'s own experiences are always kept');
  // Every difference is said before the traveler takes it: a moved departure date first, in plain words, then every
  // other changed fact row; the text names them ahead of what is the same.
  assert.deepEqual(fr.differs, [...(sameDate ? [] : [`Leaving ${dateWords(fr.trip.spec.depart)} instead of ${dateWords(dearer.spec.depart)}`]), ...[...ch.improvements, ...ch.neutral].filter(r => r.key !== 'dates').map(r => `${r.label}: ${r.b} instead of ${r.a}`)]);
  if (!sameDate) { assert.ok(!fr.same.includes('Same flights') && !fr.same.includes('Same dates')); assert.ok(fr.text.startsWith(`FREE SAVINGS: Leaving ${dateWords(fr.trip.spec.depart)} instead of ${dateWords(dearer.spec.depart)}; `), fr.text); }
  assert.equal(fr.text, `FREE SAVINGS: ${[...fr.differs, fr.same.map(s => s.replace(/^Same/, 'same')).join(', ')].filter(Boolean).join('; ')}; ${fmt(dearer.total)} → ${fmt(fr.total)}, you keep ${fmt(-fr.delta)} more.`);
  if (f.sacrifice) {
    const s = f.sacrifice;
    assert.notEqual(s, fr); assert.notEqual(s.token, fr.token); assert.ok(s.total < fr.total);
    assert.ok(classifyChanges(dearer, s.trip).tradeoffs.length >= 1, 'at least one trade-off'); assert.equal(s.total, priced(s.token).total); assert.equal(s.delta, s.total - dearer.total);
    assert.deepEqual(s.but, savemax.whyNot(s.trip, dearer, ctx)); assert.ok(s.but.length >= 1);
    assert.ok(s.text.startsWith(`SAVE ANOTHER ${fmt(fr.total - s.total)}, but: `) && s.but.every(w => s.text.includes(w)));
    assert.ok(!fr.text.includes(fmt(s.total)) && !s.text.includes('FREE'), 'never merged');
  }
  // The loaded trip: whatever is free gives nothing up; the trade-off version names what it gives up.
  const g = keep(leaks.freeSavings(inv, loaded, settings, ctx, O()));
  if (g.free) { assert.equal(classifyChanges(loaded, g.free.trip).tradeoffs.length, 0); if (g.free.trip.spec.depart !== loaded.spec.depart) assert.ok(g.free.differs[0].startsWith('Leaving ') && g.free.text.includes(g.free.differs[0])); }
  if (g.sacrifice) { assert.ok(classifyChanges(loaded, g.sacrifice.trip).tradeoffs.length >= 1); assert.ok(g.sacrifice.total < (g.free ? g.free.total : loaded.total)); assert.match(g.sacrifice.text, /^SAVE ANOTHER \$[\d,.]+, but: /); }
  // An exact date is never moved for a free saving, and no date move is then said.
  const e = leaks.freeSavings(inv, dearer, settings, { ...ctx, dateMode: 'exact' }, O());
  if (e.free) { assert.equal(e.free.trip.spec.depart, dearer.spec.depart); assert.ok(e.free.same.includes('Same dates') && !e.free.differs.some(d => d.startsWith('Leaving '))); }
  // A twin fare on the same date: the free version names the fare it moves to, in the flights row, before the traveler takes it.
  if (twinTrip) {
    const tf = leaks.freeSavings(twin, twinTrip, settings, { ...ctx, dateMode: 'exact' }, O()).free;
    if (tf && tf.trip.spec.flight === 'nonstop2') { assert.ok(tf.differs.some(d => d.startsWith('Flights: ') && d.includes('Nonstop Twin fare instead of')), tf.differs.join(' | ')); assert.ok(!tf.same.includes('Same flights') && tf.same.includes('Same dates')); }
  }
});

test('cutInOrder: the spec\'s order, one priced step at a time, stopping at the first total at or under the target, never relaxing a rule or a lock', () => {
  assert.deepEqual(leaks.PRIORITY_ORDER, ['extras', 'duplicates', 'config', 'dates', 'transport', 'hotel', 'flightTiming', 'airports', 'destination', 'nights']);
  assert.deepEqual(Object.keys(leaks.ORDER_LABELS), leaks.PRIORITY_ORDER);
  const idx = s => leaks.PRIORITY_ORDER.indexOf(s);
  const check = (c, t) => {
    assert.equal(c.target, t.target);
    let prev = t.total, stage = -1;
    for (const s of c.steps) {
      const p = priced(s.token);
      assert.equal(s.before, prev); assert.equal(s.after, p.total); assert.equal(s.saving, s.before - s.after); assert.ok(s.saving > 0);
      assert.ok(idx(s.stage) >= stage, 'stage indexes never go back'); stage = idx(s.stage); prev = s.after;
      assert.ok(Array.isArray(s.givesUp) && leaks.ORDER_LABELS[s.stage]);
    }
    assert.equal(c.final.total, prev); assert.equal(c.final.token, encodeSpec(c.final.trip.spec)); assert.equal(c.final.total, priced(c.final.token).total);
    assert.equal(c.reached, c.final.total <= c.target);
    if (c.steps.length) assert.ok(c.steps[c.steps.length - 1].before > c.target, 'stops at the first step that reaches the target');
    for (const k of c.skipped) assert.ok(leaks.ORDER_LABELS[k.stage] && typeof k.why === 'string');
    assert.match(c.text, /Rules and locks were never relaxed|already at or under/);
    return c;
  };
  const x = leaks.optionalExtras(inv, loaded, settings, ctx, O());
  const two = x.map(e => e.amount).sort((a, b) => b - a).slice(0, 2);
  const c1 = check(keep(leaks.cutInOrder(inv, loaded, settings, ctx, loaded.total - two[0] - 1, O())), { total: loaded.total, target: loaded.total - two[0] - 1 });
  assert.equal(c1.reached, true); assert.ok(c1.steps.length === 2 && c1.steps.every(s => s.stage === 'extras'), 'extras first, two of them');
  assert.ok(c1.steps[0].saving >= c1.steps[1].saving, 'largest avoidable saving first');
  assert.deepEqual(c1.skipped, []);
  // Unreachable: every stage visited in order; destination is never done by this function.
  const c2 = check(keep(leaks.cutInOrder(inv, loaded, settings, ctx, 1, O({ nightsAsked: 5 }))), { total: loaded.total, target: 1 });
  assert.equal(c2.reached, false);
  const visited = [...new Set([...c2.steps.map(s => s.stage), ...c2.skipped.map(k => k.stage)])];
  for (const s of leaks.PRIORITY_ORDER) assert.ok(visited.includes(s), `${s} visited`);
  assert.ok(c2.skipped.some(k => k.stage === 'destination' && k.why === 'a destination change is not a cut; say the word'));
  assert.ok(c2.skipped.some(k => k.stage === 'transport'), 'transport records honestly that nothing is left');
  assert.ok(c2.skipped.some(k => k.stage === 'nights' && k.why === 'you asked for 5 nights'), 'never fewer nights than asked');
  assert.ok(!c2.steps.some(s => s.stage === 'nights') && c2.final.trip.spec.nights === 5);
  assert.ok(c2.steps.some(s => s.stage === 'extras') && c2.final.trip.activities.length === 0 && !c2.final.trip.transfer);
  assert.match(c2.text, /^Not reached: /);
  // Rules hold at every step; locks hold at every step.
  const ns = loaded.flightOptions.find(f => f.stops === 0);
  if (ns) {
    const rules = RULES({ nonstop: true, minStars: loaded.hotel.stars }), nsTrip = price({ ...loaded.spec, flight: ns.id });
    const c3 = check(keep(leaks.cutInOrder(inv, nsTrip, settings, ctx, 1, O({ rules }))), { total: nsTrip.total, target: 1 });
    for (const s of c3.steps) { const p = priced(s.token); assert.equal(p.flight.stops, 0, 'nonstop rule kept'); assert.ok(p.hotel.stars >= loaded.hotel.stars, 'star rule kept'); }
    assert.ok(!c3.steps.some(s => s.stage === 'flightTiming') || c3.steps.every(s => priced(s.token).flight.stops === 0));
  }
  const locks = { hotel: true, flight: true, dates: true, nights: true };
  const c4 = check(keep(leaks.cutInOrder(inv, loaded, settings, ctx, 1, O({}, { locks }))), { total: loaded.total, target: 1 });
  for (const s of c4.steps) { const p = priced(s.token); assert.equal(p.spec.hotel, loaded.spec.hotel); assert.equal(p.spec.flight, loaded.spec.flight); assert.equal(p.spec.depart, loaded.spec.depart); assert.equal(p.spec.nights, loaded.spec.nights); assert.equal(p.spec.from, loaded.spec.from); }
  assert.ok(['hotel', 'flightTiming', 'dates', 'nights', 'airports'].every(st => c4.skipped.some(k => k.stage === st)));
  // One night fewer only when the trip is longer than asked; never when the dates are held.
  const c5 = leaks.cutInOrder(inv, loaded, settings, ctx, 1, O({ nightsAsked: loaded.spec.nights - 1 }));
  if (c5.steps.some(s => s.stage === 'nights')) assert.equal(c5.final.trip.spec.nights, loaded.spec.nights - 1);
  assert.ok(leaks.cutInOrder(inv, loaded, settings, { ...ctx, dateMode: 'exact' }, 1, O()).skipped.some(k => k.stage === 'dates'));
  // Already there: nothing to cut.
  const c6 = check(keep(leaks.cutInOrder(inv, loaded, settings, ctx, loaded.total, O())), { total: loaded.total, target: loaded.total });
  assert.deepEqual([c6.reached, c6.steps, c6.final.token], [true, [], encodeSpec(loaded.spec)]);
  // Every candidate is re-checked on the trip it actually priced: a supplier whose "nonstop" fare id from the other
  // airport is a 1-stop fare never slips under a nonstop rule, and the airports stage says what it would have broken.
  if (loaded.flightOptions.some(f => f.id === 'nonstop')) {
    const lga = { ...inv, flights: { ...inv.flights, search: q => { const fl = inv.flights.search(q); if (q.from !== 'LGA') return fl; const m = fl.find(f => f.id === 'saver') || fl[0]; return [...fl.filter(f => f.id !== 'nonstop'), { ...m, id: 'nonstop', name: 'Nonstop Flex', stops: 1, farePerTraveler: Math.round(m.farePerTraveler * 0.7), refundable: true }]; } } };
    const rules = RULES({ nonstop: true }), cur = priceTrip(lga, { ...loaded.spec, flight: 'nonstop', activities: [], transfer: false, bags: false }, settings);
    const other = priceTrip(lga, { ...cur.spec, from: 'LGA' }, settings);
    assert.ok(cur.flight.stops === 0 && other && other.flight.stops === 1 && other.total < cur.total, 'the LGA twin id is a cheaper 1-stop fare');
    const c7 = keep(leaks.cutInOrder(lga, cur, settings, { ...ctx, dateMode: 'exact', rules }, 1, O({ rules }, { locks: { hotel: true } })));
    for (const s of c7.steps) assert.equal(priceTrip(lga, decodeSpec(s.token), settings).flight.stops, 0, 'the nonstop rule holds on every priced step');
    assert.equal(priceTrip(lga, decodeSpec(c7.final.token), settings).flight.stops, 0);
    assert.ok(!c7.steps.some(s => s.stage === 'airports'));
    assert.equal(c7.skipped.find(k => k.stage === 'airports').why, '1 cheaper version priced, but each would break your nonstop rule (1 stop)');
    assert.match(c7.text, /Rules and locks were never relaxed\.$/);
    // Without the rule the cheaper 1-stop fare from LaGuardia is a step: the check is on the rule, not on the airport.
    const c7b = leaks.cutInOrder(lga, cur, settings, { ...ctx, dateMode: 'exact' }, 1, O({}, { locks: { hotel: true } }));
    assert.ok(c7b.steps.some(s => s.stage === 'airports' && priceTrip(lga, decodeSpec(s.token), settings).spec.from === 'LGA'));
  }
  // The config stage takes the same bags for less with no trade-off even when the cheapest checked configuration carries one.
  if (twinTrip) {
    const c8 = keep(leaks.cutInOrder(twin, twinTrip, settings, { ...ctx, dateMode: 'exact' }, twinTrip.total - 1, O({ bags: 'checked', priority: 'activities', who: 'family' }, { locks: { hotel: true } })));
    const st = c8.steps.find(s => s.stage === 'config');
    assert.ok(st, 'the config stage takes the twin fare'); assert.deepEqual(st.givesUp, []);
    const p8 = twinPrice(st.token);
    assert.equal(p8.flight.id, 'nonstop2'); assert.equal(hasChecked(p8), true); assert.equal(st.saving, twinTrip.total - p8.total); assert.ok(st.saving > 0);
    const cfg = leaks.bagConfigs(twin, twinTrip, settings, ctx, O());
    assert.ok(cfg.cheapestChecked.tradeoffs.length, 'the cheapest checked configuration carries a trade-off, so the old test would have skipped');
  }
  const bc = leaks.cutInOrder(inv, loaded, settings, { ...ctx, dateMode: 'exact' }, 1, O({ bags: 'checked', priority: 'activities', who: 'family' }, { locks: { hotel: true } }));
  const bk = bc.skipped.find(k => k.stage === 'config');
  if (bk) assert.equal(bk.why, `no cheaper fare carries the same bags without a trade-off (${leaks.bagConfigs(inv, loaded, settings, ctx, O()).configs.length} configurations priced)`);
  // The extras skip never says "one you asked for" for an engine inference: a transfer kept because the flight lands late.
  const late = price({ ...findFlagged('overnight', 'saver').spec, transfer: true });
  const c9 = keep(leaks.cutInOrder(inv, late, settings, { ...ctx, dateMode: 'exact' }, 1, O({}, { locks: { hotel: true, flight: true } })));
  assert.equal(c9.skipped.find(k => k.stage === 'extras').why, 'every optional item left is one I\'d keep by what you told me and the trip\'s facts: Airport transfer, both ways (you land late)');
  const c10 = keep(leaks.cutInOrder(inv, late, settings, { ...ctx, dateMode: 'exact' }, 1, O({ rules: RULES({ transfer: true }) }, { locks: { hotel: true, flight: true } })));
  assert.equal(c10.skipped.find(k => k.stage === 'extras').why, 'every optional item left is one you asked for: Airport transfer, both ways (a rule you set)');
  assert.ok(c10.final.trip.transfer);
});

test('scorecard: a pure step counts in its category, a mixed step is listed only, and the numbers are never summed', () => {
  const L = leaks.lean(inv, loaded, settings, ctx, O());
  const v1 = price({ ...loaded.spec, activities: loaded.spec.activities.slice(1) });              // Removed experiences
  const v2 = price({ ...v1.spec, transfer: false, bags: false });                                  // Removed transfer, Removed checked bags: mixed
  const v3 = [-3, -2, -1, 1, 2, 3].map(o => price({ ...v2.spec, depart: addDays(v2.spec.depart, o) })).find(Boolean); // Date change
  const v4 = price({ ...v3.spec, flight: v3.flightOptions.find(f => f.id !== v3.spec.flight).id }); // Flight swap
  const v5 = price({ ...v4.spec, hotel: v4.hotelOptions.find(h => h.id !== v4.spec.hotel).id });    // Hotel swap
  assert.ok(v1 && v2 && v3 && v4 && v5);
  assert.deepEqual([savemax.lineLabel(loaded, v1), savemax.lineLabel(v1, v2), savemax.lineLabel(v2, v3), savemax.lineLabel(v3, v4), savemax.lineLabel(v4, v5)], ['Removed experiences', 'Removed transfer, Removed checked bags', 'Date change', 'Flight swap', 'Hotel swap']);
  const max = loaded.total + 50000;
  const s = keep(leaks.scorecard({ max, trip: v5, history: [{ trip: loaded, label: 'start' }, { token: encodeSpec(v1.spec), label: 'one' }, { trip: v2 }, { token: encodeSpec(v3.spec) }, { trip: v4 }, { trip: v5 }] }, inv, settings));
  assert.equal(s.max, max); assert.equal(s.current, v5.total); assert.equal(s.notUsed, max - v5.total); assert.equal(s.over, null);
  assert.equal(s.extrasRemoved, loaded.total - v1.total, 'the pure removed-extras step only');
  assert.equal(s.dateDifference, v2.total - v3.total); assert.equal(s.transportDifference, v3.total - v4.total); assert.equal(s.hotelDifference, v4.total - v5.total);
  assert.deepEqual(s.mixed, [{ label: 'Removed transfer, Removed checked bags', delta: v2.total - v1.total }]);
  assert.equal(s.independent, false);
  assert.equal(s.note, 'These are not added together: each is the difference between two versions you applied, and a step that changed two things is listed on its own.');
  assert.deepEqual(s.lines.map(l => l.key), ['max', 'current', 'notUsed', 'extrasRemoved', 'dateDifference', 'transportDifference', 'hotelDifference', 'mixed:0']);
  const cats = s.lines.filter(l => /Difference|extrasRemoved|mixed/.test(l.key)).map(l => l.amount);
  assert.ok(!s.lines.some(l => l.amount === sum(cats) && !cats.includes(l.amount)), 'no line is the sum of the others');
  assert.ok(!s.lines.some(l => /total sav/i.test(l.label)));
  assert.ok(s.text.includes(s.note) && s.text.includes(`BUDGET NOT USED ${fmt(max - v5.total)}`));
  // The current trip is appended when the history stops short of it; nothing is counted twice when it is already last.
  assert.equal(leaks.scorecard({ max, trip: v5, history: [{ trip: loaded }, { trip: v1 }] }, inv, settings).extrasRemoved, loaded.total - v1.total);
  assert.deepEqual(leaks.scorecard({ max, trip: v1, history: [{ trip: loaded }, { trip: v1 }] }, inv, settings).mixed, []);
  // No history: only the budget lines; over the maximum: the overrun, never a negative "not used"; no maximum: the current trip only.
  const n = keep(leaks.scorecard({ max, trip: v5, history: [] }, inv, settings));
  assert.deepEqual(n.lines.map(l => l.key), ['max', 'current', 'notUsed']); assert.equal(n.note, null); assert.equal(n.independent, true); assert.deepEqual([n.extrasRemoved, n.dateDifference, n.transportDifference, n.hotelDifference, n.mixed], [0, 0, 0, 0, []]);
  const o = leaks.scorecard({ max: v5.total - 100, trip: v5 }, inv, settings);
  assert.equal(o.over, 100); assert.equal(o.notUsed, null); assert.deepEqual(o.lines.map(l => l.key), ['max', 'current', 'over']);
  const z = leaks.scorecard({ max: null, trip: v5 }, inv, settings);
  assert.deepEqual([z.max, z.notUsed, z.over, z.lines.map(l => l.key)], [null, null, null, ['current']]);
});

test('finalScan: six checks, fees always ok, found never carries a trade-off, and the text is one of the two sentences', () => {
  const KEYS = ['addons', 'duplicates', 'bags', 'transport', 'fees', 'config'];
  const SENT = s => s === 'MONEY LEAK CHECK COMPLETE. I don\'t see another cost I\'d remove without changing the trip you approved.' || /^MONEY LEAK CHECK COMPLETE\. I found one more optional \$[\d,.]+ you can remove: .+\.$/.test(s);
  const check = (t, o) => {
    const s = keep(leaks.finalScan(inv, t, settings, ctx, o));
    assert.deepEqual(s.checks.map(c => c.key), KEYS); assert.equal(s.complete, true);
    for (const c of s.checks) assert.ok(['ok', 'found', 'na'].includes(c.status) && c.label && c.text);
    assert.deepEqual(s.checks.find(c => c.key === 'fees'), { key: 'fees', label: 'Taxes and fees', status: 'ok', text: 'Taxes, mandatory fees and the resort fee are in the total.' });
    assert.ok(SENT(s.text), s.text);
    if (s.found) {
      const f = s.found, p = priced(f.token);
      assert.equal(f.total, p.total); assert.equal(f.amount, t.total - p.total); assert.ok(f.amount > 0);
      assert.equal(s.text, `MONEY LEAK CHECK COMPLETE. I found one more optional ${fmt(f.amount)} you can remove: ${f.label}.${f.note ? ` ${cap(f.note)}.` : ''}`); assert.equal(f.text, s.text);
      assert.ok(s.checks.some(c => c.key === f.key && c.status === 'found'));
      // Never a trade-off: an item nothing asks for, a duplicate, the same bags for less, or a like-for-like version.
      const extras = leaks.optionalExtras(inv, t, settings, ctx, o);
      const item = extras.find(e => e.token === f.token);
      if (item) assert.ok(!item.required && !leaks.valueOf(item.key, t, o.prefs).worth, 'an optional item nothing stated asks for');
      else if (f.key === 'duplicates') assert.ok(leaks.duplicates(inv, t, settings, o).some(d => d.token === f.token));
      else if (f.key === 'bags') { const c = leaks.bagConfigs(inv, t, settings, ctx, o); assert.equal(c.cheapestSameBags.token, f.token); assert.deepEqual(c.cheapestSameBags.tradeoffs, []); assert.equal(hasChecked(p), hasChecked(t)); assert.equal(!!p.flight.carryOn, !!t.flight.carryOn); }
      else { assert.equal(f.key, 'config'); assert.equal(classifyChanges(t, p).tradeoffs.length, 0); assert.equal(p.spec.depart, t.spec.depart); assert.match(f.label, /^(the same trip .+|a twin of this trip .+) \(like-for-like\)$/); assert.doesNotMatch(f.label, /priced lower/); }
      // The largest qualifying amount, recomputed from the engines it is built from.
      const prefs = { ...NO_PREFS, ...o.prefs };
      const dups = leaks.duplicates(inv, t, settings, o).filter(d => d.token && !(d.key === 'shuttle-transfer' && leaks.valueOf('transfer', t, prefs).worth));
      const cfg = leaks.bagConfigs(inv, t, settings, ctx, o), free = leaks.freeSavings(inv, t, settings, ctx, { ...o, locks: { ...o.locks, dates: true } }).free;
      const amounts = [...extras.filter(e => !e.required && !leaks.valueOf(e.key, t, prefs).worth).map(e => e.amount), ...dups.map(d => d.amount), hasChecked(t) && cfg.cheapestSameBags ? t.total - cfg.cheapestSameBags.total : 0, free ? -free.delta : 0];
      assert.equal(f.amount, Math.max(...amounts));
    } else assert.ok(s.checks.every(c => c.status !== 'found'));
    return s;
  };
  const s1 = check(loaded, O());
  assert.ok(s1.found, 'the loaded trip carries items nothing asks for');
  assert.equal(s1.found.amount, Math.max(...leaks.optionalExtras(inv, loaded, settings, ctx, O()).map(e => e.amount)));
  // Everything asked for: addons, bags and transport are ok, and the trip is clean unless a like-for-like version is cheaper.
  const all = { priority: 'activities', who: 'family', bags: 'checked' };
  const s2 = check(loaded, O(all));
  for (const k of ['addons', 'transport']) assert.equal(s2.checks.find(c => c.key === k).status, 'ok');
  if (s2.found) assert.ok(['bags', 'config'].includes(s2.found.key));
  // The shuttle duplicate is found when the transfer is not otherwise worth it, and left alone when the traveler lands late.
  const shuttle = findHotelTrip(h => h.features.airportShuttle, { transfer: true });
  const s3 = check(shuttle, O());
  assert.equal(s3.checks.find(c => c.key === 'duplicates').status, usableTime(shuttle).flags.some(f => f.kind === 'overnight' || f.kind === 'late-arrival') ? 'ok' : 'found');
  check(shuttle, O({ rules: RULES({ transfer: true }) }));
  check(leaks.lean(inv, loaded, settings, ctx, O()).lean.trip, O({}, { locks: { flight: true, hotel: true } }));
  // The bags check's "ok" text names what it looked at: every configuration priced, none cheaper with the same bags and no trade-off.
  const b1 = s2.checks.find(c => c.key === 'bags');
  if (b1.status === 'ok' && hasChecked(loaded)) assert.equal(b1.text, `No cheaper fare carries the same bags without a trade-off (${leaks.bagConfigs(inv, loaded, settings, ctx, O(all)).configs.length} configurations priced).`);
  // The same bags for less with no trade-off is found on the twin fare although the cheapest checked configuration
  // carries one, and the like-for-like label names the fare, never "the same trip priced lower".
  if (twinTrip) {
    const o = O({ bags: 'checked', priority: 'activities', who: 'family' }), cx = { ...ctx, dateMode: 'exact' };
    const st = keep(leaks.finalScan(twin, twinTrip, settings, cx, o)), bc = st.checks.find(c => c.key === 'bags'), cfg = leaks.bagConfigs(twin, twinTrip, settings, cx, o);
    assert.ok(cfg.cheapestChecked.tradeoffs.length && cfg.cheapestSameBags && cfg.cheapestChecked !== cfg.cheapestSameBags, 'the cheapest checked configuration carries a trade-off; a dearer one has the same bags for less');
    assert.equal(bc.status, 'found');
    assert.equal(bc.text, `${cfg.cheapestSameBags.label} instead of ${cfg.current.label} (${fmt(twinTrip.total - cfg.cheapestSameBags.total)}): the same bags for less.`);
    assert.ok(st.found && st.found.amount >= twinTrip.total - cfg.cheapestSameBags.total && st.found.amount === twinTrip.total - twinPrice(st.found.token).total);
    const cc = st.checks.find(c => c.key === 'config');
    if (cc.status === 'found') { const f = leaks.freeSavings(twin, twinTrip, settings, cx, { ...o, locks: { dates: true } }).free; assert.equal(cc.text, f.text); assert.ok(f.differs.length >= 1, 'the free version says what differs'); }
    assert.doesNotMatch(st.found.label, /same trip,? priced lower/i); for (const c of st.checks) assert.doesNotMatch(c.text, /same trip,? priced lower/i);
  }
  // Across a promo minimum the found text says the code ends and what the total actually drops by.
  const sb = keep(leaks.finalScan(inv, withBig, settings, { ...ctx, dateMode: 'exact' }, O({}, { promo: BIG })));
  if (sb.found && sb.found.note) { assert.ok(sb.found.text.endsWith(` ${cap(sb.found.note)}.`)); assert.equal(sb.found.amount, withBig.total - priced(sb.found.token, BIG).total); assert.match(sb.found.note, /^removing it also ends the Promo code BIG: the total drops by \$[\d,.]+, not \$[\d,.]+$/); }
  for (const c of sb.checks.filter(c => c.status === 'found' && ['addons', 'transport'].includes(c.key))) assert.match(c.text, /Removing it also ends the Promo code BIG: the total drops by/);
  // "One you asked for" only for a stated ask: an experience kept because it fits the stated style is said as the engine's reading.
  const beachAct = loaded.activities.find(a => a.kind === 'beach');
  if (beachAct) {
    const one = price({ ...loaded.spec, activities: [beachAct.id] });
    assert.equal(keep(leaks.finalScan(inv, one, settings, ctx, O({ style: 'beach' }))).checks.find(c => c.key === 'addons').text, `Every experience in this price is one I'd keep by what you told me and the trip's facts: ${beachAct.name} (a beach experience fits the beach trip you asked for).`);
    assert.equal(keep(leaks.finalScan(inv, one, settings, ctx, O({ priority: 'activities' }))).checks.find(c => c.key === 'addons').text, `Every experience in this price is one you asked for: ${beachAct.name} (you said experiences matter).`);
  }
  const late = price({ ...findFlagged('overnight', 'saver').spec, transfer: true });
  assert.equal(keep(leaks.finalScan(inv, late, settings, ctx, O())).checks.find(c => c.key === 'transport').text, 'The private transfer stays: you land late.');
});

test('victory: only asks the trip\'s facts meet are kept, unmet asks are named, null without a maximum', () => {
  const t = loaded, s = t.spec, f = t.flight, h = t.hotel;
  const asks = { nightsAsked: s.nights, nonstop: true, minStars: h.stars, allInclusive: true, breakfast: true, beachfront: true, refundable: true, transfer: true, dest: t.dest.name };
  const v = keep(leaks.victory({ max: t.total + 12345, trip: t, asks }));
  assert.deepEqual([v.gave, v.trip, v.kept, v.over], [t.total + 12345, t.total, 12345, null]);
  const expectKept = [[true, `${s.nights} nights`], [f.stops === 0, 'Nonstop'], [true, `Your hotel requirement: ${h.stars}-star or better`], [!!h.features.allInclusive, 'All-inclusive'], [!!(h.features.breakfast || h.features.allInclusive), 'Breakfast included'], [!!h.features.beachfront, 'Beachfront'], [!!(f.refundable && h.refundable), 'Refundable'], [true, 'Airport transfers'], [true, `Your destination: ${t.dest.name}`]];
  assert.deepEqual(v.keptRules, expectKept.filter(([met]) => met).map(([, w]) => w));
  assert.equal(v.notKept.length, expectKept.filter(([met]) => !met).length);
  for (const w of v.notKept) assert.ok(/\(/.test(w), `says why: ${w}`);
  // Asks not stated are not listed; an unmet ask is never "kept".
  const bare = keep(leaks.victory({ max: t.total, trip: t, asks: {} }));
  assert.deepEqual(bare, { gave: t.total, forBooking: t.total, reserve: 0, trip: t.total, kept: 0, over: null, reserveUsed: 0, beyond: 0, keptRules: [], notKept: [], text: `You gave us ${fmt(t.total)} as a maximum. Your trip is ${fmt(t.total)}: $0 of it is unspent.` });
  const miss = leaks.victory({ max: t.total, trip: t, asks: { nightsAsked: s.nights + 1, minStars: 5, dest: 'Nowhere' } });
  assert.deepEqual(miss.keptRules, []); assert.equal(miss.notKept.length, 3);
  // Over the maximum: the overrun, never "kept".
  const over = leaks.victory({ max: t.total - 1000, trip: t, asks: { nightsAsked: 2 } });
  assert.deepEqual([over.kept, over.over, over.keptRules], [null, 1000, [`${s.nights} nights`]]);
  for (const m of [null, 0, undefined, NaN]) assert.equal(leaks.victory({ max: m, trip: t, asks }), null);
  assert.equal(leaks.victory({ max: 1, trip: null }), null);
  // A protected reserve is part of what the traveler gave: the whole number is said with what was protected and what
  // was for the booking; "kept" is the unspent booking money, and an overrun says how far into the reserve it reaches.
  assert.deepEqual([v.gave, v.forBooking, v.reserve], [t.total + 12345, t.total + 12345, 0]);
  const r = keep(leaks.victory({ max: t.total + 12345, trip: t, asks: { nightsAsked: s.nights }, reserve: 50000 }));
  assert.deepEqual([r.gave, r.forBooking, r.reserve, r.trip, r.kept, r.over, r.reserveUsed, r.beyond, r.keptRules, r.notKept], [t.total + 62345, t.total + 12345, 50000, t.total, 12345, null, 0, 0, [`${s.nights} nights`], []]);
  assert.equal(r.text, `You gave us ${fmt(t.total + 62345)} and asked to protect $500 of it: ${fmt(t.total + 12345)} for the booking. Your trip is ${fmt(t.total)}, so $123.45 of the booking money is unspent and the $500 you protected is untouched.`);
  const into = keep(leaks.victory({ max: t.total - 20000, trip: t, asks: {}, reserve: 50000 }));
  assert.deepEqual([into.gave, into.forBooking, into.kept, into.over, into.reserveUsed, into.beyond], [t.total + 30000, t.total - 20000, null, 20000, 20000, 0]);
  assert.equal(into.text, `You gave us ${fmt(t.total + 30000)} and asked to protect $500 of it: ${fmt(t.total - 20000)} for the booking. Your trip is ${fmt(t.total)}: $200 over the booking money, $200 of the $500 you protected.`);
  const past = keep(leaks.victory({ max: t.total - 20000, trip: t, asks: {}, reserve: 10000 }));
  assert.deepEqual([past.gave, past.over, past.reserveUsed, past.beyond], [t.total - 10000, 20000, 10000, 10000]);
  assert.ok(past.text.endsWith(`: $200 over the booking money, all of the $100 you protected and $100 beyond your whole ${fmt(t.total - 10000)}.`), past.text);
  assert.equal(leaks.victory({ max: t.total, trip: t, asks: {}, reserve: -5 }).gave, t.total, 'a nonsense reserve is ignored');
  assert.ok(leaks.victory({ max: t.total - 1000, trip: t, asks: {} }).text.endsWith(`, $10 over it.`));
});

test('notAvailable: the honest lines, currency only for an international trip; the signature', () => {
  const trips = inv.maps.listDestinations().map(d => price(base(d.id, inv.hotels.search({ destId: d.id, checkIn: DEPART, nights: 5, rooms: 1 })[0].id, 'saver'))).filter(Boolean);
  const intl = trips.find(t => t.internationalTrip), dom = trips.find(t => !t.internationalTrip);
  assert.ok(intl && dom);
  const a = keep(leaks.notAvailable(intl)), b = keep(leaks.notAvailable(dom));
  assert.deepEqual(a.map(x => x.key), ['channel', 'package', 'oneway', 'split', 'credit', 'currency', 'promo']);
  assert.deepEqual(b.map(x => x.key), ['channel', 'package', 'oneway', 'split', 'credit', 'promo']);
  for (const x of [...a, ...b]) { assert.ok(x.label && x.text); assert.match(x.text, /saving is claimed|never invent|never claim|none is valued/); }
  assert.match(leaks.notAvailable(price(intl.spec, { code: 'TEN', type: 'percent', value: 10 })).find(x => x.key === 'promo').text, /^Promo code TEN is applied in this total\./);
  assert.equal(leaks.SIGNATURE, 'We don\'t just find cheaper. We find what you don\'t need to pay for.');
});

test('no pressure anywhere: nothing the engine wrote hurries, predicts or sells', () => {
  assert.ok(TEXTS.length > 200, `${TEXTS.length} strings collected`);
  for (const t of [...TEXTS, leaks.SIGNATURE, ...Object.values(leaks.ORDER_LABELS)]) assert.doesNotMatch(t, PRESSURE, t);
});
