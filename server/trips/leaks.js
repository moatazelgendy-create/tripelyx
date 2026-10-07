// THE MONEY LEAK HUNTER: not "is there a cheaper trip" but "what is the customer paying for that they
// may not need". Every number here is priceTrip's: a removal is a priced version of the trip without
// the item, and its saving is the difference between the two totals (never a line read on its own,
// since a promo moves with it). Nothing is removed by this module: it describes, prices and hands
// back tokens; the customer takes a link or says the word, and nothing optional is ever preselected.
// No fee outside the inventory is ever guessed (parking, seat fees, a shuttle's price: "needs
// verification"), no-compromise savings are never mixed with trade-off savings, scorecard numbers
// are never added together, and the platform's margin is never an input. Words live in `text` fields
// so pages and the agent say the same thing. Pure: no store, no HTTP.
const { format } = require('../lib/money');
const { priceTrip } = require('./pricing');
const { memoInventory, hotelAllowed, rulesAllowHotel, rulesAllowFlight } = require('./optimizer');
const { nameYourPrice, compromises } = require('./decision');
const { savingsCheck, lineLabel, whyNot, nearbyDates } = require('./savemax');
const { usableTime, classifyChanges, clock, lineAmount, hasChecked } = require('./facts');
const { encodeSpec, decodeSpec } = require('./spec');

const SIGNATURE = 'We don\'t just find cheaper. We find what you don\'t need to pay for.';
const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const signed = cents => `${cents < 0 ? '−' : '+'}${fmt(Math.abs(cents))}`;
const joinAnd = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pack = t => ({ trip: t, token: encodeSpec(t.spec), total: t.total });
const sameSet = (a, b) => [...a].sort().join(',') === [...b].sort().join(',');
// The taxes line carries its parts in `detail`; each is read by its label, never estimated.
const detail = (t, re) => (((t.lines.find(l => l.key === 'taxes') || {}).detail || []).find(d => re.test(d.label)) || { amount: 0 }).amount;
const flightTaxes = t => detail(t, /^Flight taxes/), hotelTaxes = t => detail(t, /^Hotel taxes/), resortFee = t => detail(t, /resort fee/i);
// Common options: only facts the traveler stated live in prefs (null = unknown); rules come from
// prefs first, then the page context. Dates are held by a lock or by a date stated exactly.
// The rules are resolved once, here, for every function: `prefs.rules` is always rulesOf(ctx, prefs)
// after opt(), so no two checks of one scan (a duplicate found, a transfer "a rule you set") can read
// different rules and contradict each other.
const rulesOf = (ctx, prefs) => (prefs && prefs.rules) || (ctx && ctx.rules) || null;
const opt = (o = {}, ctx = null) => { const prefs = o.prefs || {}; return { now: o.now || new Date(), locks: o.locks || {}, prefs: { ...prefs, rules: rulesOf(ctx, prefs) }, promo: o.promo || null }; };
const holds = (ctx, locks) => (ctx && ctx.dateMode === 'exact' ? { ...locks, dates: true } : { ...locks });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = iso => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : String(iso));
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const promoLabel = t => (lineAmount(t, 'promo') ? t.lines.find(l => l.key === 'promo').label : null);
const pricer = (inventory, settings, promo) => { const inv = memoInventory(inventory); return spec => priceTrip(inv, spec, settings, { promo }); };
// What a version gives up against the trip it replaces, in words: the facts' trade-off rows (savemax
// .whyNot says exactly those when any exist), any compromise of weight 2 or more it brings that the
// trip did not carry (a dawn fare's 2:50 AM hotel departure is invisible to the facts rows, as
// savemax.savingsCheck already knows), and, for the keys asked, what merely differs. Empty means
// "nothing given up" by every test this codebase has.
const rowText = r => `${r.label}: ${r.b}`;
function changeWords(from, to, ctx, neutralKeys = []) {
  const ch = classifyChanges(from, to), qctx = { ...(ctx || {}), budget: null, allowOver: 0 };
  const words = ch.tradeoffs.length ? whyNot(to, from, ctx || {}) : [];
  const had = new Set(compromises(from, qctx).map(c => c.text));
  const heavy = compromises(to, qctx).filter(c => c.w >= 2 && !had.has(c.text)).map(c => c.text);
  return [...new Set([...words, ...heavy, ...ch.neutral.filter(r => neutralKeys.includes(r.key)).map(rowText)])];
}
const bagWords = t => (hasChecked(t) ? (t.flight.carryOn ? 'checked bag' : 'checked bag, no carry-on') : t.flight.carryOn ? 'carry-on only' : 'personal item only');
const bagKey = t => (hasChecked(t) ? 'checked' : t.flight.carryOn ? 'carry-on' : 'personal');
const configLabel = t => { const add = lineAmount(t, 'bags'); return `${t.flight.name} fare: ${bagWords(t)}${add ? ` (add-on ${fmt(add)})` : t.flight.checkedBagIncluded ? ' (included)' : ''}`; };
const RULE_WORDS = { nonstop: 'Nonstop flights', allInclusive: 'All-inclusive', breakfast: 'Breakfast included', beachfront: 'Beachfront', transfer: 'Airport transfer', refundable: 'Refundable' };
// Whether a trip's own facts meet a stated rule, and why not when they don't: one test shared by the
// lean version's "kept" list and the victory screen, so a rule is never called kept by the facts of
// a trip that breaks it (a 1-stop fare under a nonstop rule is listed as not met, never as kept).
const MEETS = {
  nonstop: t => t.flight.stops === 0,
  minStars: (t, n) => t.hotel.stars >= n,
  allInclusive: t => !!t.hotel.features.allInclusive,
  breakfast: t => !!(t.hotel.features.breakfast || t.hotel.features.allInclusive),
  beachfront: t => !!t.hotel.features.beachfront,
  refundable: t => !!(t.flight.refundable && t.hotel.refundable),
  transfer: t => !!t.transfer,
};
const MISSED = {
  nonstop: t => `this trip has ${plural(t.flight.stops, 'stop')}`,
  minStars: t => `this hotel is ${t.hotel.stars}-star`,
  allInclusive: () => 'this hotel is not',
  breakfast: () => 'not at this hotel',
  beachfront: t => `this hotel is in ${t.hotel.area}`,
  refundable: () => 'not every part of this trip is',
  transfer: () => 'not in this price',
};
const RULE_KEYS = ['minStars', 'nonstop', 'allInclusive', 'breakfast', 'beachfront', 'transfer', 'refundable'];
const ruleName = (k, rules) => (k === 'minStars' ? `${rules.minStars}-star or better` : RULE_WORDS[k]);
// The stated rules sorted by the trip's facts: `kept` only those the trip meets, `notKept` the rest with why.
function ruleFacts(trip, rules) {
  const kept = [], notKept = [];
  if (rules) for (const k of RULE_KEYS) { if (!rules[k]) continue; if (MEETS[k](trip, rules[k])) kept.push(`${ruleName(k, rules)} (a rule you set)`); else notKept.push(`${ruleName(k, rules)} (a rule you set; ${MISSED[k](trip)})`); }
  return { kept, notKept };
}
// What a like-for-like version actually is, read off its spec: the fare, hotel, date, length, bags or
// transfer it differs on. "The same trip" is never said without naming that difference, since a
// cheaper twin is a different fare or hotel whose facts merely match.
function likeWords(from, to) {
  const parts = [];
  if (to.spec.flight !== from.spec.flight) parts.push(`on the ${to.flight.name} fare`);
  if (to.spec.hotel !== from.spec.hotel) parts.push(`at ${to.hotel.name}`);
  if (to.spec.from !== from.spec.from) parts.push(`from ${to.spec.from}`);
  if (to.spec.depart !== from.spec.depart) parts.push(`leaving ${dateWords(to.spec.depart)} instead of ${dateWords(from.spec.depart)}`);
  if (to.spec.nights !== from.spec.nights) parts.push(`for ${plural(to.spec.nights, 'night')}`);
  if (hasChecked(to) !== hasChecked(from) || !!to.flight.carryOn !== !!from.flight.carryOn) parts.push(`with ${bagWords(to)}`);
  if (!!to.transfer !== !!from.transfer) parts.push(to.transfer ? 'with the airport transfer' : 'without the airport transfer');
  return parts.length ? `the same trip ${joinAnd(parts)}` : 'a twin of this trip (its supplier facts look identical; needs verification)';
}
const EXP = 'experience:';
const TRANSFER_LABEL = 'Airport transfer, both ways', BAGS_LABEL = 'Checked bag for each traveler, both ways';

// ---- 20. what am I paying for -----------------------------------------------------------------
// Every material dollar, each row a part of a price line (the experiences line split per activity,
// the taxes line split into its parts), so the rows sum exactly to the total and nothing is a
// mystery. A checked bag the fare includes has no row: it costs nothing on top, and the flights row
// says so. A transfer rule (prefs.rules first, then the page context `ctx`) makes the transfer
// mandatory (a rule the traveler set).
function breakdown(trip, o, ctx) {
  const { prefs } = opt(o, ctx);
  const s = trip.spec, f = trip.flight, h = trip.hotel, T = s.travelers;
  const rows = [];
  const row = (key, label, amount, kind, note = null) => rows.push({ key, label, amount, kind, note });
  row('flights', `Flight fares for ${T}`, lineAmount(trip, 'flights'), 'core', `${f.name} fare, ${f.checkedBagIncluded ? 'checked bag included in the fare' : f.carryOn ? 'carry-on included' : 'personal item only'}`);
  row('hotel', `${s.nights}-night stay, ${plural(trip.rooms, 'room')}`, lineAmount(trip, 'hotel'), 'core', h.name);
  row('flightTaxes', 'Flight taxes and airport fees', flightTaxes(trip), 'mandatory');
  row('hotelTaxes', `Hotel taxes (${h.taxPercent}%)`, hotelTaxes(trip), 'mandatory');
  if (resortFee(trip)) row('resortFee', 'Mandatory resort fee', resortFee(trip), 'mandatory', 'paid in this total, not at the hotel');
  if (lineAmount(trip, 'bags') > 0) row('bags', BAGS_LABEL, lineAmount(trip, 'bags'), 'optional');
  if (trip.transfer) { const rule = !!(prefs.rules && prefs.rules.transfer); row('transfer', TRANSFER_LABEL, lineAmount(trip, 'transfer'), rule ? 'mandatory' : 'optional', rule ? 'a rule you set' : null); }
  for (const a of trip.activities) row(`${EXP}${a.id}`, a.name, a.pricePerPerson * T, 'optional', `${fmt(a.pricePerPerson)} per person`);
  row('service', 'Tripelyx service fee (platform fee)', lineAmount(trip, 'service'), 'mandatory');
  if (lineAmount(trip, 'promo')) row('promo', trip.lines.find(l => l.key === 'promo').label, lineAmount(trip, 'promo'), 'discount');
  const sum = kind => rows.filter(r => r.kind === kind).reduce((n, r) => n + r.amount, 0);
  const mandatoryTotal = sum('mandatory'), optionalTotal = sum('optional'), coreTotal = sum('core'), discount = sum('discount');
  const text = `What you're paying for: ${fmt(trip.total)} in all. Flights and stay ${fmt(coreTotal)}; taxes, mandatory fees and the service fee ${fmt(mandatoryTotal)}; optional extras ${fmt(optionalTotal)}${discount ? `; promo code ${fmt(-discount)} off` : ''}. No mystery line items: every row is in the total, and nothing is added later.`;
  return { rows, total: trip.total, mandatoryTotal, optionalTotal, coreTotal, text };
}

// ---- 5. the real hotel total ------------------------------------------------------------------
// Room price + mandatory fees = real hotel total, from the hotel line and the taxes detail. Parking
// is not in the inventory, so it is never priced.
function hotelFees(trip) {
  const room = lineAmount(trip, 'hotel'), taxes = hotelTaxes(trip), fee = resortFee(trip);
  const mandatory = taxes + fee, real = room + mandatory, nights = trip.spec.nights, rooms = trip.rooms;
  const parking = { known: false, text: 'Parking: not in our data (needs verification)' };
  const text = `Room price ${fmt(room)} + mandatory fees ${fmt(mandatory)} (hotel taxes ${fmt(taxes)}${fee ? `, resort fee ${fmt(fee)}` : ', no resort fee'}) = real hotel total ${fmt(real)} for ${plural(nights, 'night')}, ${plural(rooms, 'room')}: ${fmt(Math.round(real / nights))} a night, all in. ${parking.text}.`;
  return { room, taxes, resortFee: fee, mandatory, real, perNight: Math.round(real / nights), nights, rooms, parking, text };
}

// ---- 3 & 4. seats and cars --------------------------------------------------------------------
// No seat fee exists in the data and no rental car is part of a package: both are said as facts of
// this price, never as a comparison. Nothing about sitting together is ever claimed.
function seatFees(trip) {
  const f = trip.flight;
  return { inPrice: 0, optional: true, text: `No seat selection fee is in this price. ${f.name}: ${f.seatSelection ? 'seat selection included' : 'seat chosen at check-in'}. Any fee for choosing a seat early is the airline's and is not in our data (needs verification).` };
}
function carCheck(trip) {
  return { inPrice: false, text: `No rental car is in this trip. ${trip.transfer ? `A private airport transfer both ways (${fmt(lineAmount(trip, 'transfer'))}) is.` : 'No airport transfer is in the price either.'} Rental cars are not part of trip packages here, so there is no car version to compare.` };
}

// ---- 1 & 9. paying twice for one need ---------------------------------------------------------
// Only from facts: a bought bag on a fare that includes one; a private transfer at a hotel that lists
// an airport shuttle. The shuttle's price and schedule are not in the data, so the line says so, and
// a transfer the traveler made a rule is never offered for removal (no token). The rules are the
// engine's one source (prefs first, then the page context `ctx`, an optional last argument).
function duplicates(inventory, trip, settings, o, ctx) {
  const { prefs, promo } = opt(o, ctx);
  const price = pricer(inventory, settings, promo);
  const s = trip.spec, f = trip.flight, h = trip.hotel, out = [];
  const bags = lineAmount(trip, 'bags');
  if (s.bags && f.checkedBagIncluded && bags > 0) {
    const p = price({ ...s, bags: false });
    out.push({ key: 'bags-included', label: 'Checked-bag add-on on a fare that already includes one', amount: bags, token: p ? encodeSpec(p.spec) : null, total: p ? p.total : null,
      text: `You may be paying twice for the same need: this fare already includes a checked bag for each traveler, and a checked-bag add-on (${fmt(bags)}) is in the price.` });
  }
  if (trip.transfer && h.features && h.features.airportShuttle) {
    const rule = !!(prefs.rules && prefs.rules.transfer);
    const p = rule ? null : price({ ...s, transfer: false });
    out.push({ key: 'shuttle-transfer', label: `Private transfer at a hotel that lists an airport shuttle (${h.name})`, amount: lineAmount(trip, 'transfer'), token: p ? encodeSpec(p.spec) : null, total: p ? p.total : null,
      text: `You may be paying twice for the same need: ${h.name} lists an airport shuttle, and a private transfer both ways (${fmt(lineAmount(trip, 'transfer'))}) is in the price. Whether the shuttle is free, scheduled, and suits your flight times needs verification.${rule ? ' The transfer is a rule you set, so I don\'t offer removing it; say the word if that changes.' : ''}` });
  }
  return out;
}

// ---- 2. bag configurations --------------------------------------------------------------------
// Every fare on the trip's date inside the rules (only the trip's own fare when flights are locked),
// priced without a bought bag and, when the fare sells one (a fee in the data), with it. A fare that
// includes the bag is 'checked' with no add-on; a fare with no fee gets no guessed configuration.
// Fares outside the rules or the lock are not listed at all, so nothing shown is something the engine
// would not offer. The saving is only ever against a current checked bag: a traveler without one is
// told what each configuration costs and nothing is assumed about how they pack. `cheapestSameBags`
// is the cheapest configuration that carries exactly the traveler's bags with no trade-off by the
// facts: the cheapest checked configuration may carry one (a Basic fare with no carry-on), so the
// checks that promise "the same bags for less" read this, never `cheapestChecked` alone.
function bagConfigs(inventory, trip, settings, ctx, o) {
  const { locks, prefs, promo } = opt(o, ctx);
  const rules = prefs.rules;
  const price = pricer(inventory, settings, promo);
  const s = trip.spec;
  const fares = locks.flight ? [trip.flight] : trip.flightOptions.filter(f => rulesAllowFlight(f, rules));
  if (!fares.some(f => f.id === s.flight)) fares.push(trip.flight);
  const configs = [];
  const add = (f, bags) => {
    const p = price({ ...s, flight: f.id, bags });
    if (p) configs.push({ key: bagKey(p), label: configLabel(p), flight: { id: f.id, name: f.name }, bagIncluded: !!f.checkedBagIncluded, carryOn: !!p.flight.carryOn, addOn: lineAmount(p, 'bags'), total: p.total, delta: p.total - trip.total, token: encodeSpec(p.spec), allowed: true, tradeoffs: changeWords(trip, p, ctx) });
  };
  for (const f of fares) { add(f, false); if (!f.checkedBagIncluded && Number.isFinite(f.bagFeePerTraveler) && f.bagFeePerTraveler > 0) add(f, true); }
  configs.sort((a, b) => a.total - b.total);
  const current = { key: bagKey(trip), label: configLabel(trip), total: trip.total };
  const cheapestChecked = configs.find(c => c.key === 'checked') || null;
  const saving = current.key === 'checked' && cheapestChecked && cheapestChecked.total < trip.total ? trip.total - cheapestChecked.total : 0;
  const cheapestSameBags = configs.find(c => c.key === current.key && c.carryOn === !!trip.flight.carryOn && !c.tradeoffs.length && c.total < trip.total) || null;
  const sameBagsSaving = cheapestSameBags ? trip.total - cheapestSameBags.total : 0;
  const shared = { supported: false, text: 'One shared checked bag: the fares here price bags per traveler; sharing one bag is not offered, so I don\'t price it.' };
  const locked = locks.flight ? ' Flights are locked, so only the fare you have is priced.' : '';
  const withBag = c => `${c.flight.name} fare ${fmt(c.total)}${c.bagIncluded ? ', bag included' : ` with the bag added (${fmt(c.addOn)})`}`;
  let text;
  if (saving > 0) {
    const c = cheapestChecked, bought = lineAmount(trip, 'bags');
    text = `Your ${trip.flight.name} fare with ${bought ? `a bought checked bag: ${fmt(trip.total)} (${fmt(bought)} of it the bag)` : `the bag included: ${fmt(trip.total)}`} vs ${withBag(c)}: you save ${fmt(saving)} and keep a checked bag${c.tradeoffs.length ? `. It changes: ${joinAnd(c.tradeoffs)}` : ''}.`;
    if (cheapestSameBags && cheapestSameBags !== c) text += ` Without a trade-off: ${withBag(cheapestSameBags)}, ${fmt(sameBagsSaving)} less for the same bags.`;
  } else if (current.key === 'checked') text = `You have a checked bag (${current.label}) at ${fmt(trip.total)}; no other fare inside your rules prices the same bag for less.${locked}`;
  else text = `No checked bag is in this price (${current.label}). Priced for these dates: ${configs.map(c => `${c.label} ${fmt(c.total)}`).join('; ')}. Nothing is assumed about how you pack.${locked}`;
  return { current, configs, cheapestChecked, saving, cheapestSameBags, sameBagsSaving, shared, text };
}

// ---- 6. meals ---------------------------------------------------------------------------------
// Compared only when both versions are priced: same destination, dates, nights and flight, a hotel of
// the same stars or better inside the rules. Never under a hotel lock, a meals rule, or the
// all-inclusive style (the traveler's own ask is then what excludes every alternative, and the text
// says so rather than blaming the dates). No hotel here sells two meal plans, so a meal comparison is
// always a comparison of two hotels: every difference between them by the facts is named (`differs`),
// the other trade-offs apart from the meals (`also`), and the price difference is attributed to the
// whole swap, never to the meal plan alone. All-inclusive is never assumed to save money: whether it
// does depends on meals the data cannot know, so the traveler is asked.
const MEAL_BASIS = h => (h.features.allInclusive ? 'all-inclusive' : h.features.breakfast ? 'breakfast' : 'room-only');
const MEAL_WORD = /all-inclusive|breakfast|meals/i;
function mealCheck(inventory, trip, settings, ctx, o) {
  const { locks, prefs, promo } = opt(o, ctx);
  const rules = prefs.rules;
  const basis = MEAL_BASIS(trip.hotel);
  const none = text => ({ basis, alternatives: [], text, question: null });
  if (locks.hotel) return none('The hotel is locked, so no other meal plan is compared.');
  if (rules && (rules.allInclusive || rules.breakfast)) return none(`${rules.allInclusive ? 'All-inclusive' : 'Breakfast included'} is a rule you set, so no other meal plan is compared.`);
  if (basis === 'all-inclusive' && ctx && ctx.style === 'all-inclusive') return none('All-inclusive is the style you asked for, so no other meal plan is compared.');
  const price = pricer(inventory, settings, promo);
  const s = trip.spec;
  const cands = trip.hotelOptions.filter(h => h.id !== s.hotel && h.stars >= trip.hotel.stars && hotelAllowed(h, { who: s.who, style: ctx && ctx.style }) && rulesAllowHotel(h, rules))
    .map(h => price({ ...s, hotel: h.id })).filter(Boolean).sort((a, b) => a.total - b.total);
  const alt = p => {
    const ch = classifyChanges(trip, p), tradeoffs = changeWords(trip, p, ctx);
    return { basis: MEAL_BASIS(p.hotel), hotel: { id: p.hotel.id, name: p.hotel.name, stars: p.hotel.stars, rating: p.hotel.rating, area: p.hotel.area }, token: encodeSpec(p.spec), total: p.total, delta: p.total - trip.total, tradeoffs, also: tradeoffs.filter(w => !MEAL_WORD.test(w)), differs: [...ch.improvements, ...ch.neutral, ...ch.tradeoffs].map(rowText) };
  };
  const cheapest = b => { const p = cands.find(c => MEAL_BASIS(c.hotel) === b); return p ? alt(p) : null; };
  const whole = (a, x) => `That is a different hotel (${a.differs.join('; ')}), so the ${x} is the difference between the two hotels, not the meal plan alone.${a.also.length ? ` ${a.hotel.name} also gives up ${joinAnd(a.also)}.` : ''}`;
  if (basis !== 'all-inclusive') {
    const ai = cheapest('all-inclusive');
    if (!ai) return none('No comparable meal plan is priced for these dates');
    return { basis, alternatives: [ai], text: `All-inclusive at ${ai.hotel.name} would be ${signed(ai.delta)}. ${whole(ai, signed(ai.delta))} I don't assume all-inclusive saves money; it depends on how many meals you'd have there.`, question: null };
  }
  const alternatives = [cheapest('breakfast'), cheapest('room-only')].filter(Boolean);
  if (!alternatives.length) return none('No comparable meal plan is priced for these dates');
  const a = alternatives[0], plan = a.basis === 'breakfast' ? 'with breakfast' : 'room only';
  if (a.delta >= 0) return { basis, alternatives, text: `The all-inclusive at ${trip.hotel.name} costs no more than ${a.hotel.name} ${plan} (${signed(a.delta)}), so there is no meal money to take out here.`, question: null };
  const x = fmt(-a.delta);
  const call = a.also.length
    ? `If you plan to spend most days outside the resort, I wouldn't automatically pay for the meals; what ${a.hotel.name} gives up is part of the same ${x}, and only you can say what that is worth to you. Your call.`
    : `If you plan to spend most days outside the resort, I wouldn't automatically pay the extra ${x}; if you'll eat there, it may be the better value. Your call.`;
  return { basis, alternatives, text: `The all-inclusive at ${trip.hotel.name} is ${x} more than ${a.hotel.name} ${plan}. ${whole(a, x)} ${call}`, question: 'Will you eat at the resort most days?' };
}

// ---- 7 & 8. the first night and the last day --------------------------------------------------
// From facts.usableTime's flags only, and in their words: an overnight flight is "spent in the air"
// only when the facts say so; one that lands before 4 AM reaches the hotel that night, so the first
// night is "a short one" (`short`), and a late arrival loses the day, not the bed. A night's cost is
// the hotel line's share plus its taxes and resort fee. Nothing is removed (the traveler is never
// left without lodging; starting the hotel on arrival day cannot be booked here): other fares on the
// same date that land the same day, or leave later, are priced as alternatives with their real
// difference, and when none is priced the text says why (a lock, the rules, or no such fare) instead
// of promising one.
function nightChecks(inventory, trip, settings, ctx, o) {
  const { locks, prefs, promo } = opt(o, ctx);
  const u = usableTime(trip);
  if (!u) return { firstNight: null, lastDay: null };
  const rules = prefs.rules;
  const price = pricer(inventory, settings, promo);
  const s = trip.spec, f = trip.flight, h = trip.hotel;
  const nightCost = Math.round((lineAmount(trip, 'hotel') + hotelTaxes(trip) + resortFee(trip)) / s.nights);
  const others = locks.flight ? [] : trip.flightOptions.filter(x => x.id !== f.id && rulesAllowFlight(x, rules));
  const priced = x => { const p = price({ ...s, flight: x.id }); return p ? { p, delta: p.total - trip.total } : null; };
  let firstNight = null, lastDay = null;
  const first = u.flags.find(x => x.kind === 'overnight' || x.kind === 'late-arrival');
  if (first) {
    const alternatives = others.filter(x => !x.arrivesNextDay && (f.arrivesNextDay || x.arriveMinutes < f.arriveMinutes)).map(priced).filter(Boolean)
      .map(({ p, delta }) => ({ flight: { id: p.flight.id, name: p.flight.name, arrive: clock(p.flight.arriveMinutes) }, token: encodeSpec(p.spec), total: p.total, delta, sameDay: !p.flight.arrivesNextDay, text: `${p.flight.name} lands at ${clock(p.flight.arriveMinutes)}: ${signed(delta)}` }));
    const short = first.kind === 'overnight' && f.arriveMinutes < 4 * 60;
    const words = short ? `You land at ${u.firstDay.arrive} the night after you leave and reach the hotel around ${u.firstDay.settled}, so the first night at ${h.name} (${fmt(nightCost)} with taxes) is a short one.`
      : first.kind === 'overnight' ? `Your flight lands at ${u.firstDay.arrive} the next day, so the first night at ${h.name} (${fmt(nightCost)} with taxes) is spent in the air.`
        : `You land at ${u.firstDay.arrive} and reach the hotel around ${u.firstDay.settled}, so the first day is mostly gone: the first night at ${h.name} (${fmt(nightCost)} with taxes) buys you a bed, not a day.`;
    firstNight = { kind: first.kind, short, arrive: u.firstDay.arrive, settled: u.firstDay.settled, nightCost, alternatives, text: `${words} Starting the hotel on arrival day is not something I can book here yet, and I never leave you without lodging.` };
  }
  if (u.flags.some(x => x.kind === 'early-return')) {
    const laterAll = trip.flightOptions.filter(x => x.id !== f.id && x.returnDepartMinutes > f.returnDepartMinutes), later = others.filter(x => x.returnDepartMinutes > f.returnDepartMinutes);
    const alternatives = later.map(priced).filter(Boolean)
      .map(({ p, delta }) => { const t = usableTime(p); return { flight: { id: p.flight.id, name: p.flight.name, returnDepart: clock(p.flight.returnDepartMinutes) }, token: encodeSpec(p.spec), total: p.total, delta, leaveHotel: t.lastDay.leaveHotel, text: `${p.flight.name} leaves at ${clock(p.flight.returnDepartMinutes)}, so you leave the hotel around ${t.lastDay.leaveHotel}: ${signed(delta)}` }; });
    const tail = alternatives.length ? `a later flight would give you the day back: ${alternatives.map(a => a.text).join('; ')}.`
      : locks.flight ? 'flights are locked, so no later fare is priced.'
        : !laterAll.length ? 'no fare on this date flies home later.'
          : !later.length ? `the later ${laterAll.length === 1 ? 'fare' : 'fares'} on this date (${laterAll.map(x => x.name).join(', ')}) ${laterAll.length === 1 ? 'is' : 'are'} outside your rules, so none is priced.`
            : 'no later fare on this date could be priced.';
    lastDay = { kind: 'early-return', depart: u.lastDay.depart, leaveHotel: u.lastDay.leaveHotel, nightCost, alternatives,
      text: `The flight home leaves at ${u.lastDay.depart}, so you leave ${h.name} around ${u.lastDay.leaveHotel}: the last night (${fmt(nightCost)}) buys you a bed, not a day. I don't remove it; ${tail}` };
  }
  return { firstNight, lastDay };
}

// ---- 10. everything optional in the price -----------------------------------------------------
// Each with the priced saving of the version without it (the difference of two totals, so a promo
// moves with it) and that version's token. A stated rule keeps an item listed but not removable
// (`stated`). A promo code with a minimum total can end when an item comes out: `amount` is then what
// the total actually drops by, `lineOnly` what the item itself costs, and `note` says the two apart
// ("removing it also ends the promo code: the total drops by $A, not $B"). When removing an item
// would cost more, it is listed as not removable with that reason, so no page offers a REMOVE that
// costs money and a negative difference is never called a saving.
function optionalExtras(inventory, trip, settings, ctx, o) {
  const { prefs, promo } = opt(o, ctx);
  const rules = prefs.rules;
  const price = pricer(inventory, settings, promo);
  const s = trip.spec, out = [], code = promoLabel(trip);
  const item = (key, label, spec, required, reason, lineOnly) => {
    const p = price(spec);
    if (!p) return;
    const amount = trip.total - p.total, promoChange = lineAmount(p, 'promo') - lineAmount(trip, 'promo'), promoLost = promoChange > 0 && lineAmount(p, 'promo') === 0;
    const ends = promoLost ? 'ends' : 'shrinks';
    const note = promoChange > 0 ? (amount > 0 ? `removing it also ${ends} the ${code}: the total drops by ${fmt(amount)}, not ${fmt(lineOnly)}` : `removing it ${ends} the ${code}, so the total would ${amount === 0 ? 'not change' : `rise by ${fmt(-amount)}`}`) : null;
    const costly = note && amount <= 0 && !required;
    out.push({ key, label, amount, lineOnly, token: encodeSpec(p.spec), total: p.total, required: required || !!costly, stated: required, reason: costly ? `removing it would not save money: ${note}` : reason, promoLost, promoChange, note });
  };
  for (const a of trip.activities) item(`${EXP}${a.id}`, a.name, { ...s, activities: s.activities.filter(x => x !== a.id) }, false, 'optional: booking the flights and the hotel does not need it', a.pricePerPerson * s.travelers);
  if (trip.transfer) { const rule = !!(rules && rules.transfer); item('transfer', TRANSFER_LABEL, { ...s, transfer: false }, rule, rule ? 'a rule you set' : 'optional: booking the flights and the hotel does not need it', lineAmount(trip, 'transfer')); }
  if (s.bags && lineAmount(trip, 'bags') > 0) { const asked = prefs.bags === 'checked'; item('bags', BAGS_LABEL, { ...s, bags: false }, asked, asked ? 'you said you travel with a checked bag' : 'optional: booking the flights and the hotel does not need it', lineAmount(trip, 'bags')); }
  return out;
}

// ---- shared judgement: is this item worth its money for this traveler ------------------------
// From stated preferences and the trip's facts only; margin is never an input. Unknown is never
// "not worth" by assumption: it is "nothing you told me asks for it", said as such. The rules are
// the engine's one source (prefs first, then the page context `ctx`, an optional last argument).
const STYLE_ACTIVITY = { beach: ['beach'], adventure: ['adventure'], romantic: ['romantic', 'beach'], family: ['family', 'beach'], city: ['culture', 'nightlife'] }; // mirrors optimizer's mapping (not exported there)
function valueOf(item, trip, prefs = {}, ctx = null) {
  const key = typeof item === 'string' ? item : item.key;
  const rules = rulesOf(ctx, prefs);
  const no = { worth: false, why: 'nothing you told me asks for it' };
  if (key.startsWith(EXP)) {
    if (prefs.priority === 'activities') return { worth: true, why: 'you said experiences matter' };
    const a = [...trip.activities, ...(trip.activityOptions || [])].find(x => x.id === key.slice(EXP.length));
    if (a && prefs.style && (STYLE_ACTIVITY[prefs.style] || []).includes(a.kind)) return { worth: true, why: `a ${a.kind} experience fits the ${prefs.style} trip you asked for` };
    return no;
  }
  if (key === 'transfer') {
    const u = usableTime(trip);
    if (u && u.flags.some(f => f.kind === 'overnight' || f.kind === 'late-arrival')) return { worth: true, why: 'you land late' };
    if (prefs.who === 'family') return { worth: true, why: 'with a family, a private transfer is worth considering' };
    if (rules && rules.transfer) return { worth: true, why: 'a transfer is a rule you set' };
    return no;
  }
  if (key === 'bags') return prefs.bags === 'checked' ? { worth: true, why: 'you said you travel with a checked bag' } : no;
  return no;
}
// Which of valueOf's reasons are the traveler's own words (a stated ask) rather than the engine's
// inference from the trip's facts: "you land late" is the engine's reading of a schedule, never
// something the traveler asked for, so it is never said as "one you asked for".
const STATED_WHY = new Set(['you said experiences matter', 'you said you travel with a checked bag', 'a transfer is a rule you set', 'a rule you set']);
// Why an optional item stays: a stated rule's reason, or (when it is listed as not removable for
// another reason, a promo code it would end) that reason, else valueOf's verdict.
const keepWhy = (e, v) => (e.stated || (e.required && !v.worth) ? e.reason : v.why);

// ---- why each optional item stays ------------------------------------------------------------
// The honest sentence for "every optional item stays": each item with valueOf's reason and whether
// that reason is a stated ask or the engine's inference, so a page or the agent never says "one you
// asked for" about a transfer kept because the flight lands late. `kept` lists the items valueOf keeps.
function whyKept(inventory, trip, settings, ctx, o) {
  const { prefs } = opt(o, ctx);
  const items = optionalExtras(inventory, trip, settings, ctx, o).map(e => { const v = e.stated ? { worth: true, why: e.reason } : valueOf(e.key, trip, prefs); return { key: e.key, label: e.label, amount: e.amount, worth: v.worth || e.required, why: keepWhy(e, v), stated: e.stated || (v.worth && STATED_WHY.has(v.why)) }; });
  const kept = items.filter(i => i.worth), allStated = kept.every(i => i.stated);
  const list = kept.map(i => `${i.label} (${i.why})`).join('; ');
  const text = !items.length ? 'Nothing optional is in this price.'
    : kept.length < items.length ? `${plural(items.length - kept.length, 'optional item')} in this price ${items.length - kept.length === 1 ? 'is' : 'are'} not asked for by anything you told me.`
      : allStated ? `Every optional item in this price is one you asked for: ${list}.` : `Every optional item in this price is one I'd keep by what you told me and the trip's facts: ${list}.`;
  return { items, kept, allStated, text };
}

// ---- 11 & 12. strip it down, then add back what is worth it -----------------------------------
// The lean version keeps the same flights, hotel, dates and nights (core transport, valid lodging,
// mandatory charges, hard requirements) and drops every optional item a stated rule does not ask
// for. Both versions are priced in full; "what you give up" is the list of what was dropped. `kept`
// lists only what the lean version's own facts meet: a stated rule the trip breaks goes under
// `notKept`, never under "Kept". A promo code that ends with the extras is said: the difference is
// then what the total actually drops by, not the sum of the items, and a lean version that costs no
// less says so instead of offering a saving. Add-back prices each item alone onto the lean version;
// the verdict is valueOf's, from stated preferences.
function lean(inventory, trip, settings, ctx, o) {
  const { prefs, promo } = opt(o, ctx);
  const rules = prefs.rules;
  const price = pricer(inventory, settings, promo);
  const s = trip.spec, T = s.travelers, code = promoLabel(trip);
  const keepTransfer = !!(rules && rules.transfer), keepBag = prefs.bags === 'checked' || !lineAmount(trip, 'bags');
  const removed = [];
  for (const a of trip.activities) removed.push({ key: `${EXP}${a.id}`, label: a.name, amount: a.pricePerPerson * T });
  if (trip.transfer && !keepTransfer) removed.push({ key: 'transfer', label: TRANSFER_LABEL, amount: lineAmount(trip, 'transfer') });
  if (s.bags && !keepBag) removed.push({ key: 'bags', label: BAGS_LABEL, amount: lineAmount(trip, 'bags') });
  const current = { total: trip.total, token: encodeSpec(s) };
  const p = removed.length ? price({ ...s, activities: [], transfer: keepTransfer ? s.transfer : false, bags: keepBag ? s.bags : false }) : null;
  const facts = ruleFacts(p || trip, rules);
  const kept = [`Round-trip flights (${trip.flight.name})`, `${plural(s.nights, 'night')} at ${trip.hotel.name}`, 'Taxes, mandatory fees and the service fee', ...facts.kept, ...(prefs.bags === 'checked' && hasChecked(p || trip) ? ['Checked bag for each traveler (you said you travel with one)'] : [])];
  const notKept = facts.notKept, keptText = `Kept: ${joinAnd(kept)}.${notKept.length ? ` Not met by this trip: ${joinAnd(notKept)}.` : ''}`;
  if (!p) return { current, lean: pack(trip), difference: 0, removed: [], givesUp: [], kept, notKept, promoLost: false, text: `Nothing optional is in this price: it is already the lean version.${notKept.length ? ` ${keptText}` : ''}` };
  const givesUp = removed.map(r => r.label), difference = trip.total - p.total, lineTotal = removed.reduce((n, r) => n + r.amount, 0);
  const promoLost = lineAmount(trip, 'promo') < 0 && lineAmount(p, 'promo') > lineAmount(trip, 'promo');
  if (difference <= 0) return { current, lean: pack(p), difference, removed, givesUp, kept, notKept, promoLost, text: `Current ${fmt(trip.total)}. Lean ${fmt(p.total)}: no less, because without ${joinAnd(givesUp)} the ${code} no longer applies. Taking the lean version would not save money. ${keptText}` };
  const promoNote = promoLost ? ` Removing them also ends the ${code}: the difference is ${fmt(difference)}, not ${fmt(lineTotal)}.` : '';
  return { current, lean: pack(p), difference, removed, givesUp, kept, notKept, promoLost, text: `Current ${fmt(trip.total)}. Lean ${fmt(p.total)}. Difference ${fmt(difference)}. What you give up: ${joinAnd(givesUp)}.${promoNote} ${keptText} Your call: take the lean version or keep what you have.` };
}

function addBack(inventory, leanTrip, removed, settings, ctx, o) {
  const { prefs, promo } = opt(o, ctx);
  const price = pricer(inventory, settings, promo);
  const s = leanTrip.spec, out = [];
  for (const r of removed || []) {
    const spec = r.key.startsWith(EXP) ? { ...s, activities: [...new Set([...s.activities, r.key.slice(EXP.length)])].sort() } : r.key === 'transfer' ? { ...s, transfer: true } : r.key === 'bags' ? { ...s, bags: true } : null;
    const p = spec && price(spec);
    if (!p || encodeSpec(p.spec) === encodeSpec(s)) continue;
    const cost = p.total - leanTrip.total, v = valueOf(r.key, p, prefs);
    out.push({ key: r.key, label: r.label, cost, token: encodeSpec(p.spec), total: p.total, verdict: v.worth ? 'worth' : 'keep', why: v.why, text: v.worth ? `+${fmt(cost)} ${r.label}: WORTH CONSIDERING (${v.why})` : `+${fmt(cost)} ${r.label}: I'D KEEP THE ${fmt(cost)} (${v.why})` });
  }
  return out;
}

// ---- 21. remove one thing ---------------------------------------------------------------------
// The lowest-value optional component: among the removable items nothing stated asks for, the one
// whose removal saves most. Null when every optional item is one the traveler asked for, and null
// when nothing optional is in the price; the caller tells the two apart with optionalExtras (or says
// why each stays with whyKept). A promo code the removal ends is said, never hidden behind
// "everything else remains".
function removeOne(inventory, trip, settings, ctx, o) {
  const { prefs } = opt(o, ctx);
  const cands = optionalExtras(inventory, trip, settings, ctx, o).filter(e => !e.required && e.amount > 0).map(e => ({ e, v: valueOf(e.key, trip, prefs) })).filter(x => !x.v.worth).sort((a, b) => b.e.amount - a.e.amount);
  if (!cands.length) return null;
  const { e, v } = cands[0];
  return { key: e.key, label: e.label, saving: e.amount, token: e.token, total: e.total, why: v.why, note: e.note, text: `I'd remove ${e.label}. Save ${fmt(e.amount)}.${e.note ? ` ${cap(e.note)}. Everything else in the trip remains.` : ' Everything else remains.'}` };
}

// ---- 24. free savings (nothing given up) and, apart, the trade-off version -------------------
// `free` is savemax.savingsCheck's cheaper version: at least $25 cheaper, no trade-off by the facts,
// no new compromise, the traveler's own experiences kept. `same` lists only the facts that are truly
// equal, and `differs` every difference the facts find (a moved departure date above all, said in
// the traveler's words first), so the page and the agent say what changes before the traveler takes
// it: a free version is one that gives nothing up, not one where nothing differs. "Same flights" is
// said only on the same date; the same fare on another date is "same fare". `sacrifice` is the
// cheapest version decision.nameYourPrice still calls strong below the free version (below the
// current trip when there is none) that gives something up; its "but" is the facts' trade-off rows
// in words. The two are never one number.
function freeVersion(inventory, trip, settings, ctx, o) {
  const { now, locks, prefs, promo } = opt(o, ctx);
  const cx = { ...(ctx || {}), rules: prefs.rules };
  const check = savingsCheck(inventory, trip, settings, cx, { now, locks, material: 2500, promo });
  if (!check.cheaper) return null;
  const c = check.cheaper, b = c.trip, a = trip, same = [], differs = [];
  const ch = classifyChanges(a, b), changed = new Set([...ch.improvements, ...ch.neutral, ...ch.tradeoffs].map(r => r.key));
  const sameDate = b.spec.depart === a.spec.depart, sameFare = b.spec.flight === a.spec.flight && !changed.has('flight') && !changed.has('time');
  if (b.spec.hotel === a.spec.hotel) same.push('Same hotel');
  if (b.spec.nights === a.spec.nights) same.push('Same nights');
  if (sameDate) same.push('Same dates');
  if (sameFare) same.push(sameDate ? 'Same flights' : `Same fare (${b.flight.name})`); else if (b.flight.stops === 0 && a.flight.stops === 0) same.push('Same nonstop rule');
  if (hasChecked(b) === hasChecked(a) && !!b.flight.carryOn === !!a.flight.carryOn) same.push('Same bags');
  if (sameSet(b.spec.activities, a.spec.activities)) same.push('Same experiences');
  if (!sameDate) differs.push(`Leaving ${dateWords(b.spec.depart)} instead of ${dateWords(a.spec.depart)}`);
  for (const r of [...ch.improvements, ...ch.neutral, ...ch.tradeoffs]) if (r.key !== 'dates') differs.push(`${r.label}: ${r.b} instead of ${r.a}`);
  const words = [...differs, same.map(x => x.replace(/^Same/, 'same')).join(', ')].filter(Boolean).join('; ');
  return { trip: b, token: c.token, total: c.total, delta: c.delta, same, differs, text: `FREE SAVINGS: ${words}; ${fmt(a.total)} → ${fmt(c.total)}, you keep ${fmt(-c.delta)} more.` };
}
function freeSavings(inventory, trip, settings, ctx, o) {
  const { now, locks, prefs } = opt(o, ctx);
  const free = freeVersion(inventory, trip, settings, ctx, o);
  const bound = free ? free.total : trip.total;
  const nyp = nameYourPrice(memoInventory(inventory), trip, settings, { ...(ctx || {}), rules: prefs.rules }, bound - 1, { now, locks: holds(ctx, locks) });
  const seen = new Set(free ? [free.token] : []);
  const strong = [nyp.recommended, nyp.floor, ...nyp.ladder.filter(r => !r.current)].filter(c => c && c.label === 'strong' && c.total < bound && c.changes.tradeoffs.length)
    .filter(c => { const k = encodeSpec(c.trip.spec); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.total - b.total);
  let sacrifice = null;
  if (strong[0]) {
    const c = strong[0], but = whyNot(c.trip, trip, ctx || {});
    sacrifice = { trip: c.trip, token: encodeSpec(c.trip.spec), total: c.total, delta: c.total - trip.total, but, text: `SAVE ANOTHER ${fmt(bound - c.total)}, but: ${joinAnd(but)}.` };
  }
  return { free, sacrifice };
}

// ---- 22. the biggest avoidable cost -----------------------------------------------------------
// Every avoidable cost present, each priced: optional extras, duplicates, a cheaper fare with the
// same bags, breakfast instead of all-inclusive, the like-for-like cheaper version on the same dates,
// the cheapest nearby date. A candidate carries its trade-off when it has one; candidates without
// one always rank first, so a trade-off is never named while a free cut exists.
function biggestLeak(inventory, trip, settings, ctx, o) {
  const { now, locks, prefs, promo } = opt(o, ctx);
  const price = pricer(inventory, settings, promo);
  const s = trip.spec, cands = [];
  const add = (kind, label, alternativeLabel, current, alternative, token, total, tradeoff, note = null) => { if (token && current - alternative > 0) cands.push({ kind, label, alternativeLabel, current, alternative, difference: current - alternative, token, total, tradeoff, note }); };
  for (const e of optionalExtras(inventory, trip, settings, ctx, o)) { if (e.required) continue; const v = valueOf(e.key, trip, prefs); add('extra', e.label, 'Without it', e.amount, 0, e.token, e.total, v.worth ? v.why : null, e.note); }
  for (const d of duplicates(inventory, trip, settings, o, ctx)) { const v = d.key === 'shuttle-transfer' ? valueOf('transfer', trip, prefs) : { worth: false }; add('duplicate', d.label, 'Without it', d.amount, 0, d.token, d.total, v.worth ? v.why : null); }
  const bags = bagConfigs(inventory, trip, settings, ctx, o);
  if (bags.saving > 0) { const c = bags.cheapestChecked; add('bags', `${c.label} instead of ${bags.current.label}`, c.label, trip.total, c.total, c.token, c.total, c.tradeoffs.length ? joinAnd(c.tradeoffs) : null); }
  // The same bags for less with no trade-off, when the cheapest checked configuration is not that.
  if (hasChecked(trip) && bags.cheapestSameBags && bags.cheapestSameBags !== bags.cheapestChecked) { const c = bags.cheapestSameBags; add('bags', `${c.label} instead of ${bags.current.label}`, c.label, trip.total, c.total, c.token, c.total, null); }
  if (trip.hotel.features.allInclusive) {
    const a = mealCheck(inventory, trip, settings, ctx, o).alternatives.filter(x => x.delta < 0).sort((x, y) => x.total - y.total)[0];
    // A meal comparison is a hotel swap: the trade-off names the hotel, the meals and everything else the alternative gives up, never the meal plan alone.
    if (a) { const plan = a.basis === 'breakfast' ? 'breakfast' : 'room only'; add('meals', `${a.hotel.name} (${plan}) instead of all-inclusive at ${trip.hotel.name}`, a.hotel.name, trip.total, a.total, a.token, a.total, joinAnd([`hotel: ${a.hotel.name} instead of ${trip.hotel.name}`, `meals: ${plan} instead of all-inclusive`, ...a.also])); }
  }
  const free = freeVersion(inventory, trip, settings, ctx, { ...opt(o, ctx), locks: { ...locks, dates: true } });
  if (free) add('config', `${cap(likeWords(trip, free.trip))} (like-for-like)`, 'Like-for-like version', trip.total, free.total, free.token, free.total, null);
  const held = holds(ctx, locks);
  if (!held.dates) {
    const d = nearbyDates(s.depart, now, held, ctx || {}).slice(1).map(depart => price({ ...s, depart })).filter(Boolean).sort((a, b) => a.total - b.total)[0];
    if (d) add('dates', `Leaving ${d.spec.depart} instead of ${s.depart}`, `Leaving ${d.spec.depart}`, trip.total, d.total, encodeSpec(d.spec), d.total, `dates: leaving ${d.spec.depart} instead of ${s.depart}`);
  }
  const byDiff = (a, b) => b.difference - a.difference;
  const pick = cands.filter(c => !c.tradeoff).sort(byDiff)[0] || cands.filter(c => c.tradeoff).sort(byDiff)[0] || null;
  if (!pick) return null;
  return { ...pick, text: `BIGGEST AVOIDABLE COST: ${pick.label}. Current: ${fmt(pick.current)}. ${pick.alternativeLabel}: ${fmt(pick.alternative)}. Potential difference: ${fmt(pick.difference)}.${pick.tradeoff ? ` It changes: ${pick.tradeoff}.` : ''}${pick.note ? ` ${cap(pick.note)}.` : ''}` };
}

// ---- 23. cut it in order ----------------------------------------------------------------------
// Money is cut in the spec's order, one priced change per step, stopping at the first total at or
// under the target. Rules and locks are never relaxed: a stage they forbid is skipped and says why,
// and every candidate is re-checked on the trip it actually priced (its flight's stops, its hotel's
// stars, its dates), never on the spec it started from, so a supplier whose fare facts differ by
// airport or by date cannot slip a 1-stop fare under a nonstop rule. Every step is the whole trip
// priced again; "gives up" names what that step changes, from the facts.
const PRIORITY_ORDER = ['extras', 'duplicates', 'config', 'dates', 'transport', 'hotel', 'flightTiming', 'airports', 'destination', 'nights'];
const ORDER_LABELS = { extras: 'Optional extras', duplicates: 'Paid twice', config: 'Same bags, cheaper fare', dates: 'Nearby dates', transport: 'Transport', hotel: 'Hotel', flightTiming: 'Flight timing', airports: 'Departure airport', destination: 'Destination', nights: 'Nights' };
// What a priced version would break, in words, or null: the locks and the holds on the spec, the
// rules on the priced flight and hotel (optimizer's own tests), the who/style constraints.
function breaksWhat(p, trip, { rules, locks, held, who, style }) {
  if (locks.flight && (p.spec.flight !== trip.spec.flight || p.spec.from !== trip.spec.from)) return 'the flight lock';
  if (locks.hotel && p.spec.hotel !== trip.spec.hotel) return 'the hotel lock';
  if (held.dates && (p.spec.depart !== trip.spec.depart || p.spec.nights !== trip.spec.nights)) return 'your held dates';
  if (held.nights && p.spec.nights !== trip.spec.nights) return 'the length lock';
  if (rules && !rulesAllowFlight(p.flight, rules)) return rules.nonstop && p.flight.stops > 0 ? `your nonstop rule (${plural(p.flight.stops, 'stop')})` : 'your refundable rule (the flights)';
  if (rules && !rulesAllowHotel(p.hotel, rules)) {
    const h = p.hotel;
    return rules.minStars && h.stars < rules.minStars ? `your ${rules.minStars}-star rule (${h.stars}-star)` : rules.allInclusive && !h.features.allInclusive ? 'your all-inclusive rule' : rules.breakfast && !h.features.breakfast && !h.features.allInclusive ? 'your breakfast rule' : rules.beachfront && !h.features.beachfront ? 'your beachfront rule' : 'your refundable rule (the hotel)';
  }
  if (rules && rules.transfer && !p.transfer) return 'your transfer rule';
  if (!hotelAllowed(p.hotel, { who, style })) return who === 'family' && p.hotel.features.adultsOnly ? 'an adults-only hotel with a family' : 'the all-inclusive style you asked for';
  return null;
}
function cutInOrder(inventory, trip, settings, ctx, target, o) {
  const { now, locks, prefs, promo } = opt(o, ctx);
  const rules = prefs.rules, held = holds(ctx, locks);
  const price = pricer(inventory, settings, promo);
  const steps = [], skipped = [];
  let cur = trip;
  const done = () => cur.total <= target;
  const breaks = p => breaksWhat(p, trip, { rules, locks, held, who: trip.spec.who, style: ctx && ctx.style });
  const skip = (stage, why) => { skipped.push({ stage, why }); return false; };
  // A step is taken only when the priced trip keeps every rule and lock; otherwise the stage is skipped with what it would have broken.
  const step = (stage, label, p, givesUp) => { const bad = breaks(p); if (bad) return skip(stage, `${label} would break ${bad}`); steps.push({ stage, label, before: cur.total, after: p.total, saving: cur.total - p.total, token: encodeSpec(p.spec), givesUp }); cur = p; return true; };
  // The cheapest priced version that keeps the rules and locks, and, when cheaper ones exist that do not, why none of them is taken.
  const cheapestOf = specs => {
    const ps = specs.map(price).filter(p => p && p.total < cur.total).sort((a, b) => a.total - b.total);
    const p = ps.find(x => !breaks(x)) || null;
    const why = !p && ps.length ? `${plural(ps.length, 'cheaper version')} priced, but each would break ${joinAnd([...new Set(ps.map(breaks))])}` : null;
    return { p, why };
  };
  const stages = {
    extras() {
      for (;;) {
        const r = removeOne(inventory, cur, settings, ctx, o), p = r && price(decodeSpec(r.token));
        if (!p) { const k = whyKept(inventory, cur, settings, ctx, o); return skip('extras', k.items.length ? `every optional item left is one ${k.allStated ? 'you asked for' : 'I\'d keep by what you told me and the trip\'s facts'}: ${k.kept.map(i => `${i.label} (${i.why})`).join('; ')}` : 'no optional item left to cut'); }
        if (!step('extras', `Removed ${r.label}`, p, [r.label]) || done()) return;
      }
    },
    duplicates() {
      const dups = duplicates(inventory, cur, settings, o, ctx);
      if (!dups.length) return skip('duplicates', 'nothing is paid for twice');
      for (const d of dups) {
        if (done()) return;
        const p = d.token && price(decodeSpec(d.token));
        if (!p || p.total >= cur.total) { skip('duplicates', `${d.label}: ${d.token ? 'not cheaper without it' : 'the transfer is a rule you set'}`); continue; }
        const v = d.key === 'shuttle-transfer' ? valueOf('transfer', cur, prefs) : { worth: false };
        step('duplicates', `Removed ${d.label}`, p, d.key === 'shuttle-transfer' ? [`the private transfer (the hotel shuttle needs verification${v.worth ? `; ${v.why}` : ''})`] : []);
      }
    },
    config() {
      const b = bagConfigs(inventory, cur, settings, ctx, o), c = hasChecked(cur) ? b.cheapestSameBags : null;
      if (c) step('config', `${c.label} instead of ${b.current.label}`, price(decodeSpec(c.token)), []);
      else skip('config', hasChecked(cur) ? `no cheaper fare carries the same bags without a trade-off (${plural(b.configs.length, 'configuration')} priced)` : 'no checked bag is in the price, so there is no bag configuration to cut');
    },
    dates() {
      if (held.dates) return skip('dates', 'your dates are held');
      const { p, why } = cheapestOf(nearbyDates(cur.spec.depart, now, held, ctx || {}).slice(1).map(depart => ({ ...cur.spec, depart })));
      if (p) step('dates', `Leaving ${p.spec.depart} instead of ${cur.spec.depart}`, p, [`leaving ${p.spec.depart} instead of ${cur.spec.depart}`]); else skip('dates', why || 'no cheaper date within 3 days');
    },
    transport() { skip('transport', cur.transfer ? `the transfer stays (${valueOf('transfer', cur, prefs).why})` : 'nothing left: no transfer or rental car is in the price'); },
    hotel() {
      if (locks.hotel) return skip('hotel', 'the hotel is locked');
      const { p, why } = cheapestOf(cur.hotelOptions.filter(h => h.id !== cur.spec.hotel && h.stars >= cur.hotel.stars && hotelAllowed(h, { who: cur.spec.who, style: ctx && ctx.style }) && rulesAllowHotel(h, rules)).map(h => ({ ...cur.spec, hotel: h.id })));
      if (p) step('hotel', `${p.hotel.name} instead of ${cur.hotel.name}`, p, changeWords(cur, p, ctx, ['hotel', 'area', 'meals'])); else skip('hotel', why || 'no cheaper hotel of the same class or better inside your rules');
    },
    flightTiming() {
      if (locks.flight) return skip('flightTiming', 'the flights are locked');
      const { p, why } = cheapestOf(cur.flightOptions.filter(f => f.id !== cur.spec.flight && rulesAllowFlight(f, rules)).map(f => ({ ...cur.spec, flight: f.id })));
      if (p) step('flightTiming', `${p.flight.name} fare instead of ${cur.flight.name}`, p, changeWords(cur, p, ctx, ['flight', 'time', 'bags', 'flex'])); else skip('flightTiming', why || 'no cheaper fare on the same date inside your rules');
    },
    airports() {
      if (locks.flight) return skip('airports', 'the flights are locked');
      const maps = inventory.maps || {};
      const ap = maps.airport ? maps.airport(cur.spec.from) : null, origin = ap && maps.getOrigin ? maps.getOrigin(ap.originId) : null;
      const others = origin ? origin.airports.filter(a => a.code !== cur.spec.from) : [];
      if (!others.length) return skip('airports', 'no other airport is listed for your departure city');
      const { p, why } = cheapestOf(others.map(a => ({ ...cur.spec, from: a.code })));
      if (!p) return skip('airports', why || 'no cheaper fare from another airport of your city');
      const a = others.find(x => x.code === p.spec.from);
      step('airports', `Flying from ${a.name} (${a.code})`, p, [`flying from ${a.name} (${a.code})${a.note ? `: ${a.note}` : ''}`]);
    },
    destination() { skip('destination', 'a destination change is not a cut; say the word'); },
    nights() {
      const asked = prefs.nightsAsked || (ctx && ctx.nightsAsked) || null;
      if (held.nights || held.dates) return skip('nights', held.nights ? 'the length is locked' : 'your dates are held, and the length is part of them');
      if (asked && cur.spec.nights <= asked) return skip('nights', `you asked for ${plural(asked, 'night')}`);
      if (cur.spec.nights <= 2) return skip('nights', 'already the shortest stay priced here');
      const { p, why } = cheapestOf([{ ...cur.spec, nights: cur.spec.nights - 1 }]);
      if (p) step('nights', `${cur.spec.nights - 1} nights instead of ${cur.spec.nights}`, p, [`${plural(cur.spec.nights - 1, 'night')} instead of ${cur.spec.nights}`]); else skip('nights', why || 'one night fewer is not cheaper here');
    },
  };
  for (const stage of PRIORITY_ORDER) { if (done()) break; stages[stage](); }
  const reached = done();
  const did = steps.map(s => `${ORDER_LABELS[s.stage]}: ${s.label} (−${fmt(s.saving)})`).join('; ');
  const text = reached
    ? (steps.length ? `Cut to ${fmt(cur.total)}, at or under ${fmt(target)}, in ${plural(steps.length, 'step')}, in this order: ${did}. Rules and locks were never relaxed.` : `${fmt(cur.total)} is already at or under ${fmt(target)}: nothing to cut.`)
    : `Not reached: ${fmt(cur.total)} after ${plural(steps.length, 'step')}, still ${fmt(cur.total - target)} over ${fmt(target)}.${steps.length ? ` Done, in order: ${did}.` : ''} Not touched: ${skipped.map(k => `${ORDER_LABELS[k.stage]} (${k.why})`).join('; ')}. Rules and locks were never relaxed.`;
  return { target, steps, reached, final: pack(cur), skipped, text };
}

// ---- 26. the savings scorecard ----------------------------------------------------------------
// Max budget, current trip, what is not used (or the overrun), and, when the agent passes the
// versions the traveler applied, the money each kind of step made: between consecutive versions,
// savemax.lineLabel names the step, and only a step of exactly one kind counts in its category. A
// step that changed several things is listed on its own and counted nowhere, since its parts cannot
// be told apart; the numbers are never added together. Each amount is money saved (negative when
// the step cost more).
const PURE = { 'Removed experiences': 'extrasRemoved', 'Removed transfer': 'extrasRemoved', 'Removed checked bags': 'extrasRemoved', 'Date change': 'dateDifference', 'Flight swap': 'transportDifference', 'Hotel swap': 'hotelDifference' };
const CAT_LABEL = { extrasRemoved: 'Removed extras', dateDifference: 'Date difference', transportDifference: 'Flight difference', hotelDifference: 'Hotel difference' };
const NOTE = 'These are not added together: each is the difference between two versions you applied, and a step that changed two things is listed on its own.';
function scorecard({ max, trip, history = [] }, inventory, settings) {
  const inv = memoInventory(inventory);
  const fromToken = token => { try { return priceTrip(inv, decodeSpec(token), settings); } catch (e) { return null; } }; // a version that no longer decodes or prices is left out, never guessed
  const versions = (history || []).map(h => (h && h.trip) || (h && h.token ? fromToken(h.token) : null)).filter(Boolean);
  if (versions.length && encodeSpec(versions[versions.length - 1].spec) !== encodeSpec(trip.spec)) versions.push(trip);
  const ceiling = Number.isFinite(max) && max > 0 ? max : null, current = trip.total;
  const notUsed = ceiling !== null && current <= ceiling ? ceiling - current : null, over = ceiling !== null && current > ceiling ? current - ceiling : null;
  const cat = { extrasRemoved: 0, dateDifference: 0, transportDifference: 0, hotelDifference: 0 }, counts = { ...cat }, mixed = [];
  for (let i = 1; i < versions.length; i++) {
    const a = versions[i - 1], b = versions[i], label = lineLabel(a, b);
    if (label === 'No change') continue;
    const k = PURE[label];
    if (k) { cat[k] += a.total - b.total; counts[k]++; } else mixed.push({ label, delta: b.total - a.total });
  }
  const lines = [];
  if (ceiling !== null) lines.push({ key: 'max', label: 'MAX BUDGET', amount: ceiling });
  lines.push({ key: 'current', label: 'CURRENT TRIP', amount: current });
  if (notUsed !== null) lines.push({ key: 'notUsed', label: 'BUDGET NOT USED', amount: notUsed });
  if (over !== null) lines.push({ key: 'over', label: 'OVER YOUR MAX', amount: over });
  for (const k of Object.keys(cat)) if (counts[k]) lines.push({ key: k, label: CAT_LABEL[k], amount: cat[k] });
  mixed.forEach((m, i) => lines.push({ key: `mixed:${i}`, label: `${m.label} (one step, listed on its own)`, amount: -m.delta }));
  const withHistory = versions.length > 1;
  const text = `${lines.map(l => `${l.label} ${fmt(l.amount)}`).join(' · ')}.${withHistory ? ` ${NOTE}` : ''}`;
  return { max: ceiling, current, notUsed, over, ...cat, mixed, lines, independent: mixed.length === 0, note: withHistory ? NOTE : null, text };
}

// ---- 27. the money leak check before checkout -------------------------------------------------
// Immediately before paying. Only a removal or configuration with no trade-off qualifies as a leak
// in the approved trip: an optional item nothing stated asks for, a duplicate, a cheaper fare with
// the same bags, the same trip priced lower on the same dates. Fees are always in the total.
function finalScan(inventory, trip, settings, ctx, o) {
  const { locks, prefs } = opt(o, ctx);
  const checks = [], found = [];
  const check = (key, label, status, text, hit) => { checks.push({ key, label, status, text }); if (hit) found.push({ key, ...hit }); };
  const hit = e => ({ label: e.label, amount: e.amount, token: e.token, total: e.total, note: e.note || null });
  const extras = optionalExtras(inventory, trip, settings, ctx, o).map(e => ({ ...e, v: valueOf(e.key, trip, prefs) }));
  const leak = xs => xs.filter(e => !e.required && !e.v.worth && e.amount > 0).sort((a, b) => b.amount - a.amount)[0] || null;
  // An item that stays is said with its reason: "one you asked for" only when the reason is a stated ask, otherwise as the engine's reading of what the traveler said.
  const stays = xs => { const all = xs.every(e => e.stated || (e.v.worth && STATED_WHY.has(e.v.why))); return `${all ? 'is one you asked for' : 'is one I\'d keep by what you told me and the trip\'s facts'}: ${xs.map(e => `${e.label} (${keepWhy(e, e.v)})`).join('; ')}`; };
  const exp = extras.filter(e => e.key.startsWith(EXP)), e1 = leak(exp);
  check('addons', 'Optional add-ons', e1 ? 'found' : 'ok', !exp.length ? 'No optional experiences are in this price.' : e1 ? `${e1.label} (${fmt(e1.amount)}) is in the price and nothing you told me asks for it.${e1.note ? ` ${cap(e1.note)}.` : ''}` : `Every experience in this price ${stays(exp)}.`, e1 && hit(e1));
  const dups = duplicates(inventory, trip, settings, o, ctx).map(d => ({ ...d, v: d.key === 'shuttle-transfer' ? valueOf('transfer', trip, prefs) : { worth: false } }));
  const d1 = dups.filter(d => d.token && !d.v.worth && d.amount > 0).sort((a, b) => b.amount - a.amount)[0] || null;
  check('duplicates', 'Paid twice', d1 ? 'found' : 'ok', d1 ? d1.text : dups.length ? `${dups[0].text}${dups[0].v.worth && dups[0].token ? ` The transfer stays: ${dups[0].v.why}.` : ''}` : 'Nothing is paid for twice.', d1 && hit(d1));
  // The same bags for less: the cheapest configuration with exactly these bags and no trade-off, not merely the cheapest checked one.
  const bag = leak(extras.filter(e => e.key === 'bags')), cfg = bagConfigs(inventory, trip, settings, ctx, o);
  const c = hasChecked(trip) ? cfg.cheapestSameBags : null, cSaving = c ? trip.total - c.total : 0;
  const bagLeak = !!bag && (!c || bag.amount >= cSaving);
  const bagHit = bagLeak ? hit(bag) : c ? { label: `${c.label} instead of ${cfg.current.label}`, amount: cSaving, token: c.token, total: c.total, note: null } : null;
  check('bags', 'Bags', bagHit ? 'found' : locks.flight && hasChecked(trip) ? 'na' : 'ok', bagHit ? `${bagHit.label} (${fmt(bagHit.amount)}): ${bagLeak ? 'nothing you told me asks for a checked bag' : 'the same bags for less'}.${bagHit.note ? ` ${cap(bagHit.note)}.` : ''}` : locks.flight && hasChecked(trip) ? 'Flights are locked, so no other fare is compared.' : hasChecked(trip) ? `No cheaper fare carries the same bags without a trade-off (${plural(cfg.configs.length, 'configuration')} priced).` : 'No checked bag is in the price.', bagHit);
  const tr = extras.find(e => e.key === 'transfer'), t1 = tr && !tr.required && !tr.v.worth && tr.amount > 0 ? hit(tr) : null;
  check('transport', 'Transport', t1 ? 'found' : 'ok', !tr ? 'No airport transfer or rental car is in the price.' : t1 ? `The private transfer (${fmt(tr.amount)}) is in the price and nothing you told me asks for it.${tr.note ? ` ${cap(tr.note)}.` : ''}` : `The private transfer stays: ${tr.required ? tr.reason : tr.v.why}.`, t1);
  check('fees', 'Taxes and fees', 'ok', 'Taxes, mandatory fees and the resort fee are in the total.', null);
  const free = freeVersion(inventory, trip, settings, ctx, { ...opt(o, ctx), locks: { ...locks, dates: true } });
  // The check's heading is the contract's category; the version it finds is named by what it differs on (likeWords), never as "the same trip priced lower".
  check('config', 'Same trip, priced lower', free ? 'found' : 'ok', free ? free.text : 'No like-for-like version of this trip is priced lower for these dates.', free && { label: `${likeWords(trip, free.trip)} (like-for-like)`, amount: -free.delta, token: free.token, total: free.total, note: null });
  const best = found.sort((a, b) => b.amount - a.amount)[0] || null;
  const text = best ? `MONEY LEAK CHECK COMPLETE. I found one more optional ${fmt(best.amount)} you can remove: ${best.label}.${best.note ? ` ${cap(best.note)}.` : ''}` : 'MONEY LEAK CHECK COMPLETE. I don\'t see another cost I\'d remove without changing the trip you approved.';
  return { checks, found: best ? { ...best, text } : null, text, complete: true };
}

// ---- 28. the saver's victory ------------------------------------------------------------------
// What the traveler gave, what the trip costs, what they kept, and which of their stated asks the
// trip's facts meet (the same tests as the lean version's "kept" list). `max` is the money for the
// booking; a `reserve` the traveler asked to protect is part of what they gave, so `gave` is the
// whole number (max + reserve) and `forBooking` the part the trip could use: "you gave us $2,469"
// is never said of a traveler who gave $2,469 and protected $500 as if they gave $1,969. `kept` is
// the unspent booking money; an overrun says how much of the reserve it reaches into (`reserveUsed`)
// and anything beyond the whole (`beyond`). An ask the trip does not meet is listed as not kept; an
// ask never stated is not listed. Null without a maximum.
function victory({ max, trip, asks = {}, reserve = 0 }) {
  if (!Number.isFinite(max) || max <= 0 || !trip) return null;
  const a = asks || {}, f = trip.flight, h = trip.hotel, s = trip.spec, keptRules = [], notKept = [];
  const ask = (stated, met, kept, missed) => { if (stated) (met ? keptRules : notKept).push(met ? kept : missed); };
  ask(a.nightsAsked, s.nights >= a.nightsAsked, `${plural(s.nights, 'night')}`, `${plural(a.nightsAsked, 'night')} (this trip has ${s.nights})`);
  ask(a.nonstop, MEETS.nonstop(trip), 'Nonstop', `Nonstop (${MISSED.nonstop(trip)})`);
  ask(a.minStars, MEETS.minStars(trip, a.minStars), `Your hotel requirement: ${a.minStars}-star or better`, `Your hotel requirement: ${a.minStars}-star or better (${MISSED.minStars(trip)})`);
  ask(a.allInclusive, MEETS.allInclusive(trip), 'All-inclusive', `All-inclusive (${MISSED.allInclusive(trip)})`);
  ask(a.breakfast, MEETS.breakfast(trip), 'Breakfast included', `Breakfast included (${MISSED.breakfast(trip)})`);
  ask(a.beachfront, MEETS.beachfront(trip), 'Beachfront', `Beachfront (${MISSED.beachfront(trip)})`);
  ask(a.refundable, MEETS.refundable(trip), 'Refundable', `Refundable (${MISSED.refundable(trip)})`);
  ask(a.transfer, MEETS.transfer(trip), 'Airport transfers', `Airport transfers (${MISSED.transfer(trip)})`);
  const destName = trip.dest && trip.dest.name;
  ask(a.dest, !!destName && [destName, trip.dest.id].map(x => String(x).toLowerCase()).includes(String(a.dest).toLowerCase()), `Your destination: ${destName}`, `Your destination: ${a.dest} (this trip goes to ${destName || s.dest})`);
  const keep = Number.isFinite(reserve) && reserve > 0 ? reserve : 0, forBooking = max, gave = max + keep;
  const kept = trip.total <= forBooking ? forBooking - trip.total : null, over = trip.total > forBooking ? trip.total - forBooking : null;
  const reserveUsed = over !== null ? Math.min(over, keep) : 0, beyond = Math.max(0, trip.total - gave);
  const text = keep
    ? `You gave us ${fmt(gave)} and asked to protect ${fmt(keep)} of it: ${fmt(forBooking)} for the booking. Your trip is ${fmt(trip.total)}${kept !== null ? `, so ${fmt(kept)} of the booking money is unspent and the ${fmt(keep)} you protected is untouched.` : `: ${fmt(over)} over the booking money, ${reserveUsed >= keep ? `all of the ${fmt(keep)} you protected${beyond ? ` and ${fmt(beyond)} beyond your whole ${fmt(gave)}` : ''}` : `${fmt(reserveUsed)} of the ${fmt(keep)} you protected`}.`}`
    : `You gave us ${fmt(gave)} as a maximum. Your trip is ${fmt(trip.total)}${kept !== null ? `: ${fmt(kept)} of it is unspent.` : `, ${fmt(over)} over it.`}`;
  return { gave, forBooking, reserve: keep, trip: trip.total, kept, over, reserveUsed, beyond, keptRules, notKept, text };
}

// ---- 13-19. what is not compared here, said plainly -----------------------------------------
// Each line names what the inventory does not have, so no saving is ever claimed from it.
function notAvailable(trip) {
  const out = [
    { key: 'channel', label: 'Booking-channel comparison', text: 'I don\'t compare this price with booking each part elsewhere: there is no second booking channel in our data, so no saving is claimed either way.' },
    { key: 'package', label: 'Package vs separate rates', text: 'The package is the same supplier offers plus one service fee; there is no separate package rate in our data to compare, so no saving is claimed.' },
    { key: 'oneway', label: 'One-way fare structures', text: 'No one-way fares are in our data: the round trip is priced as one fare, so no one-way combination is compared and no saving is claimed.' },
    { key: 'split', label: 'Hotel split stays', text: 'Splitting the stay across two hotels is not priced here, so no saving is claimed from it.' },
    { key: 'credit', label: 'Credits, points and loyalty', text: 'No loyalty credits or points are in our data; none is valued, applied or claimed.' },
  ];
  if (trip.internationalTrip) out.push({ key: 'currency', label: 'Currency', text: 'Everything is priced in USD; no exchange rate is applied or compared, so no currency saving is claimed.' });
  out.push({ key: 'promo', label: 'Promo codes', text: lineAmount(trip, 'promo') ? `${trip.lines.find(l => l.key === 'promo').label} is applied in this total. I never invent a code and never claim another one exists.` : 'A promo code is applied only when you enter one the rules accept; I never invent a code and never claim one exists.' });
  return out;
}

// The words that name a biggest-leak alternative as a version to show, the same on the page and in the
// conversation: "the version without it", "the like-for-like version", "the version leaving 2026-10-22",
// "the Basic fare: checked bag version". Never "the without it version".
function showWords(b) {
  const a = String(b.alternativeLabel || '');
  if (/^without it$/i.test(a)) return 'the version without it';
  if (/version$/i.test(a)) return `the ${a.toLowerCase()}`;
  if (/^leaving /i.test(a)) return `the version ${a.toLowerCase()}`;
  return `the ${a.toLowerCase()} version`;
}

module.exports = { showWords, breakdown, hotelFees, seatFees, carCheck, duplicates, bagConfigs, mealCheck, nightChecks, optionalExtras, valueOf, whyKept, lean, addBack, removeOne, biggestLeak, freeSavings, cutInOrder, scorecard, finalScan, victory, notAvailable, PRIORITY_ORDER, ORDER_LABELS, SIGNATURE };
