// SAVE MAX: the relentless-savings view of one priced trip. The job is "how low can we responsibly
// get this trip", never "spend the budget". Every number here is a priced package (optimizer.search,
// pricing.priceTrip or decision.nameYourPrice); nothing is estimated and no saving is ever claimed
// without saying compared with what. The lowest version we would still recommend is kept apart from
// the absolute cheapest version found, and the cheapest is only ever shown with the facts of that
// trip that keep it from being recommended. Rules and locks are never relaxed here: a relaxed rule
// is a compromise the traveler picks, not something the engine applies on its own.
// Dates: locks.dates holds the departure, and so does ctx.dateMode === 'exact' (a date the traveler
// stated exactly), with ctx.depart optionally carrying the stated date for the record. Either way the
// trip's own departure (and its length) is the only one priced; nothing here moves a stated date.
// A pass that hits the pricing limit says so: every result that prices versions carries `truncated`,
// and its words never claim the pass was exhaustive when it was not.
const { addDays, today } = require('../lib/dates');
const { format } = require('../lib/money');
const { priceTrip } = require('./pricing');
const { memoInventory, activitySets, hotelAllowed, rulesAllowHotel, rulesAllowFlight } = require('./optimizer');
const { nameYourPrice, compromises, verdict } = require('./decision');
const { classifyChanges, usableTime, hasChecked } = require('./facts');
const { encodeSpec } = require('./spec');

const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dur = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const joinAnd = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const rowText = r => `${r.label}: ${r.b}`;
const pack = (t, changes) => ({ trip: t, token: encodeSpec(t.spec), total: t.total, changes });
const sameSet = (a, b) => [...a].sort().join(',') === [...b].sort().join(',');
const MAX_PRICED = 2500;
const PARTIAL = 'the pass was cut off at the pricing limit, so it is not exhaustive';
const PARTIAL_SENTENCE = ' The pass was cut off at the pricing limit, so it is not exhaustive.';

// ---- versions of one trip --------------------------------------------------------------------
// Every version of a trip the saver tools may price: same destination, the trip's own hotel and
// flight options filtered by the traveler's rules, locks kept. The caller picks what may vary.
// The holds in force are the traveler's locks plus the dates whenever they stated an exact date
// (ctx.dateMode === 'exact'); a date hold keeps the length too, since the return date is part of it.
function holds(ctx, locks = {}) {
  return ctx && ctx.dateMode === 'exact' ? { ...locks, dates: true } : { ...locks };
}

function nearbyDates(depart, now, locks = {}, ctx = {}) {
  if (holds(ctx, locks).dates) return [depart];
  const earliest = addDays(today(now), 3);
  return [depart, ...[-3, -2, -1, 1, 2, 3].map(o => addDays(depart, o)).filter(d => d >= earliest)];
}

function versions(inv, t, settings, ctx, { locks = {}, dates, nightsList, sets, transfers, bagsList, promo = null }) {
  const s = t.spec;
  const held = holds(ctx, locks);
  const dateList = held.dates ? [s.depart] : dates;
  const nightsIn = held.dates || held.nights ? [s.nights] : nightsList;
  const hotels = held.hotel ? [s.hotel] : t.hotelOptions.filter(h => hotelAllowed(h, { who: s.who, style: ctx.style }) && rulesAllowHotel(h, ctx.rules)).map(h => h.id);
  if (!hotels.includes(s.hotel)) hotels.push(s.hotel);
  const flights = held.flight ? [s.flight] : t.flightOptions.filter(f => rulesAllowFlight(f, ctx.rules)).map(f => f.id);
  if (!flights.includes(s.flight)) flights.push(s.flight);
  const seen = new Set([encodeSpec(s)]);
  const out = [];
  let priced = 0, truncated = false;
  outer: for (const depart of dateList) for (const nights of nightsIn) for (const hotel of hotels) for (const flight of flights) for (const activities of sets) for (const transfer of transfers) for (const bags of bagsList) {
    if (ctx && ctx.protect && !activities.includes(ctx.protect)) continue; // the protected main experience (Experience Max) is never priced away
    const spec = { ...s, depart, nights, hotel, flight, activities: [...activities].sort(), transfer, bags };
    const key = encodeSpec(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    if (priced++ >= MAX_PRICED) { truncated = true; break outer; }
    const p = priceTrip(inv, spec, settings, { promo });
    if (p) out.push(p);
  }
  return { versions: out, truncated };
}

// ---- how low ---------------------------------------------------------------------------------
// The facts of a cheaper trip that keep it from being recommended, each read off that trip itself,
// never off its price: what it gives up against the version we would recommend, then any compromise
// it carries that the recommended version does not, then (if nothing else differs) what is simply
// different. A line is only ever a fact of the cheaper trip. When nothing displayed differs at all
// (a twin fare or room whose supplier facts match the recommended version's), the one line says so
// and asks for verification, so a caller never has an empty "it means".
const IDENTICAL = 'a different flight or hotel whose supplier facts look identical to the recommended version\'s; it needs verification before I could recommend it';
function whyNot(cheap, against, ctx = {}) {
  const f = cheap.flight, h = cheap.hotel, s = cheap.spec;
  const out = [];
  const ch = classifyChanges(against, cheap);
  for (const row of ch.tradeoffs) {
    switch (row.key) {
      case 'nights': out.push(ctx.nightsAsked && s.nights < ctx.nightsAsked ? `${plural(s.nights, 'night')}, ${plural(ctx.nightsAsked - s.nights, 'night')} fewer than you asked for` : `${plural(s.nights, 'night')} instead of ${against.spec.nights}`); break;
      case 'flight': out.push(f.stops > 0 ? `${plural(f.stops, 'stop')}, ${dur(f.durationMinutes)} each way` : `${dur(f.durationMinutes)} each way on the ${f.name} fare`); break;
      case 'hotel': out.push(`${h.stars}-star hotel rated ${h.rating}/5 (${h.name}; ${h.ratingSource})`); break;
      case 'area': out.push(`not beachfront: ${h.area}`); break;
      case 'meals': out.push(h.features.breakfast ? 'breakfast only, not all-inclusive' : against.hotel.features.allInclusive ? 'no meals included' : 'no breakfast included'); break;
      case 'bags': out.push(!f.carryOn ? (hasChecked(cheap) ? 'checked bag but no carry-on' : 'personal item only, no carry-on') : 'no checked bag'); break;
      case 'flex':
        if (!f.refundable && against.flight.refundable) out.push('non-refundable flights');
        if (!h.refundable && against.hotel.refundable) out.push('non-refundable hotel rate');
        break;
      case 'time': {
        const u = usableTime(cheap);
        if (u) out.push(`less usable vacation time (${u.usableLabel}; lands ${u.firstDay.arrive}${u.firstDay.nextDay ? ' the next day' : ''}, flight home ${u.lastDay.depart}${u.flags.some(x => x.kind === 'early-return') ? `, leaving the hotel around ${u.lastDay.leaveHotel}` : ''})`);
        break;
      }
      case 'experiences': out.push(cheap.activities.length ? `${plural(cheap.activities.length, 'experience')} instead of ${against.activities.length}` : 'no experiences included'); break;
      case 'transfer': out.push('no airport transfer'); break;
      default: break;
    }
  }
  if (!out.length) {
    const qctx = { ...ctx, budget: null, allowOver: 0 };
    const had = new Set(compromises(against, qctx).map(c => c.text));
    for (const c of compromises(cheap, qctx)) if (!had.has(c.text)) out.push(c.text);
  }
  if (!out.length) for (const r of ch.neutral) out.push(rowText(r));
  if (!out.length) out.push(IDENTICAL);
  return [...new Set(out)];
}

// "How low can you get it?" The lowest version of this trip we would still recommend (decision.
// nameYourPrice asked for anything cheaper: its recommended version, else its floor), and the
// absolute cheapest version found when that is not the one we recommend, with the facts that keep
// it from being recommended. When nothing cheaper exists the trip itself is the answer. `truncated`
// says the pass hit the pricing limit, so "lowest found" is not "lowest there is".
function howLow(inventory, trip, settings, ctx = {}, { now = new Date(), locks = {} } = {}) {
  const out = nameYourPrice(inventory, trip, settings, ctx, trip.total - 1, { now, locks: holds(ctx, locks) });
  const rec = [out.recommended, out.floor].find(c => c && c.total < trip.total) || null;
  const recommend = rec ? pack(rec.trip, rec.changes) : pack(trip, classifyChanges(trip, trip));
  const c = out.cheapest;
  const cheapest = c && c.total < recommend.total && encodeSpec(c.trip.spec) !== recommend.token
    ? { ...pack(c.trip, c.changes), whyNot: whyNot(c.trip, recommend.trip, ctx) }
    : null;
  return { recommend, cheapest, considered: out.considered, truncated: !!out.truncated };
}

// ---- price breakpoints -----------------------------------------------------------------------
// "Where does money start buying something meaningful?" One breakpoint per kind of improvement: the
// cheapest priced version of the trip that buys it with nothing given up, at or under the cap. Same
// destination and dates; a date move is only offered when it is the only way to buy something, and
// the label says so. Each label names what changed, read off the two trips: a flight that loses its
// stops is "Nonstop flight", one that loses some is "Fewer stops", one with the same stops that is
// an hour or more shorter is "Shorter flights"; a fewer-stops-but-longer flight is never "shorter".
const GETS_ORDER = ['nights', 'flight', 'hotel', 'area', 'meals', 'transfer', 'flex', 'bags', 'time', 'experiences'];
function getsLabel(key, a, b) {
  switch (key) {
    case 'nights': return b.spec.nights - a.spec.nights === 1 ? 'Extra night' : `${b.spec.nights - a.spec.nights} extra nights`;
    case 'flight':
      if (b.flight.stops === 0 && a.flight.stops > 0) return 'Nonstop flight';
      if (b.flight.stops < a.flight.stops) return 'Fewer stops';
      if (b.flight.stops === a.flight.stops && a.flight.durationMinutes - b.flight.durationMinutes >= 60) return 'Shorter flights';
      return 'Better flight';
    case 'hotel': return b.hotel.stars > a.hotel.stars ? 'Better hotel class' : 'Higher-rated hotel';
    case 'area': return 'Beachfront';
    case 'meals': return b.hotel.features.allInclusive ? 'All-inclusive' : 'Breakfast included';
    case 'transfer': return 'Included transfer';
    case 'flex': return b.flight.refundable && !a.flight.refundable ? 'Refundable flights' : 'Free hotel cancellation';
    case 'bags': return hasChecked(b) && !hasChecked(a) ? 'Checked bags' : 'Carry-on bag';
    case 'time': return 'More usable vacation time';
    case 'experiences': return b.activities.length - a.activities.length === 1 ? 'An extra experience' : 'More experiences';
    default: return null;
  }
}

// Returns an array of at most five breakpoints (ascending by delta) that also carries a `truncated`
// property: true when a pass hit the pricing limit, so the agent can say the list is partial.
function priceBreakpoints(inventory, base, settings, ctx = {}, { now = new Date(), cap, locks = {} } = {}) {
  const inv = memoInventory(inventory);
  const held = holds(ctx, locks);
  const s = base.spec;
  const limit = Number.isFinite(cap) ? cap : Number.isFinite(ctx.budget) ? ctx.budget : Infinity;
  const nightsList = held.nights || held.dates ? [s.nights] : [s.nights, s.nights + 1, s.nights + 2].filter(n => n <= 14);
  const sets = [s.activities, ...activitySets(base.activityOptions, ctx.style || 'surprise')];
  const transfers = s.transfer ? [true] : [false, true];
  const bagsList = s.bags || base.flight.checkedBagIncluded ? [s.bags] : [false, true];
  // A breakpoint must also bring no compromise the base does not already have (weight 2 or more in
  // decision.compromises): a bought bag on a no-changes dawn fare is not a clean "checked bags".
  const qctx = { ...ctx, budget: null, allowOver: 0 };
  const baseTexts = new Set(compromises(base, qctx).map(c => c.text));
  const found = new Map(); // kind of improvement -> the cheapest version that buys it
  const consider = (p, moved) => {
    if (p.total <= base.total || p.total > limit) return;
    const ch = classifyChanges(base, p);
    if (!ch.improvements.length || ch.tradeoffs.length) return;
    if (compromises(p, qctx).some(c => c.w >= 2 && !baseTexts.has(c.text))) return;
    const keys = GETS_ORDER.filter(k => ch.improvements.some(r => r.key === k));
    if (!keys.length) return;
    const kind = getsLabel(keys[0], base, p);
    if (moved && found.has(kind)) return; // the same dates already buy it
    const prev = found.get(kind);
    if (prev && prev.total <= p.total) return;
    const gets = moved ? `${kind} (leaving ${p.spec.depart} instead of ${s.depart})` : kind;
    found.set(kind, { delta: p.total - base.total, gets, also: keys.slice(1).map(k => getsLabel(k, base, p)), trip: p, token: encodeSpec(p.spec), total: p.total, changes: ch });
  };
  const onDate = versions(inv, base, settings, ctx, { locks: held, dates: [s.depart], nightsList, sets, transfers, bagsList });
  for (const p of onDate.versions) consider(p, false);
  let truncated = onDate.truncated;
  // On other dates only the fares and the hotels can change (a nonstop that flies on other days, a
  // hotel with rooms then), so that is all a date move is tried for.
  if (!held.dates) {
    const dates = nearbyDates(s.depart, now, held, ctx).slice(1);
    const moved = versions(inv, base, settings, ctx, { locks: held, dates, nightsList: [s.nights], sets: [s.activities], transfers: [s.transfer], bagsList: [s.bags] });
    for (const p of moved.versions) consider(p, true);
    truncated = truncated || moved.truncated;
  }
  const out = [...found.values()].sort((a, b) => a.delta - b.delta || a.total - b.total).slice(0, 5);
  out.truncated = truncated;
  return out;
}

// ---- the cheap trap --------------------------------------------------------------------------
// A cheap fare plus the bag the traveler needs is not always the cheap fare. The fares are compared
// on what they really cost for the way the traveler packs, from the fare's own bag fields; when the
// inventory has no fee for the bag they need, nothing is guessed. Only fares the traveler's rules
// allow are compared (a nonstop-only rule never has a one-stop fare held up as cheaper), locked
// flights are not compared at all, and a fare is always named by its fare name and price together
// with every way it differs from the fare the trip has (stops, a duration an hour or more apart,
// the carry-on, refundability), so "cheaper" never hides a different flight.
const BAG_NEEDS = { personal: 'a personal item', 'carry-on': 'a carry-on', checked: 'a checked bag' };
function relevantFare(f, bags, travelers) {
  if (!f || !Number.isFinite(f.farePerTraveler) || !Number.isFinite(f.taxesPerTraveler)) return null;
  const sticker = (f.farePerTraveler + f.taxesPerTraveler) * travelers;
  let fee = 0;
  if (bags === 'carry-on' && !f.carryOn) fee = Number.isFinite(f.carryOnFeePerTraveler) ? f.carryOnFeePerTraveler : null;
  if (bags === 'checked' && !f.checkedBagIncluded) fee = Number.isFinite(f.bagFeePerTraveler) ? f.bagFeePerTraveler : null;
  if (fee === null) return null;
  return { flight: f, sticker, fee: fee * travelers, relevant: sticker + fee * travelers };
}

function fareDiffs(mine, other) {
  const out = [];
  if (other.stops !== mine.stops) out.push(other.stops ? plural(other.stops, 'stop') : 'nonstop');
  if (Number.isFinite(other.durationMinutes) && Number.isFinite(mine.durationMinutes) && Math.abs(other.durationMinutes - mine.durationMinutes) >= 60) out.push(`${dur(other.durationMinutes)} each way`);
  if (!!other.carryOn !== !!mine.carryOn) out.push(other.carryOn ? 'carry-on included' : 'personal item only');
  if (!!other.refundable !== !!mine.refundable) out.push(other.refundable ? 'refundable' : 'non-refundable');
  return out;
}

function cheapTrap(trip, alternatives = [], { bags, rules = null, locks = {} } = {}) {
  if (locks && locks.flight) return { badge: null, text: 'Flights are locked, so no other fare is compared.' };
  if (!BAG_NEEDS[bags]) return { badge: null, text: 'Tell us how you pack (personal item, carry-on or checked bag) and we will compare fares for the way you travel.' };
  const T = trip.spec.travelers;
  const fareKey = f => `${f.id}|${f.depart}|${f.farePerTraveler}|${f.taxesPerTraveler}`;
  const seen = new Set([fareKey(trip.flight)]);
  const others = alternatives.map(a => (a && a.flight) || a).filter(f => f && f.id && !seen.has(fareKey(f)) && seen.add(fareKey(f)));
  const flights = others.filter(f => rulesAllowFlight(f, rules));
  if (!flights.length) return { badge: null, text: others.length ? 'No other fare inside your rules to compare against.' : 'No other fare to compare against.' };
  const mine = relevantFare(trip.flight, bags, T);
  const alts = flights.map(f => relevantFare(f, bags, T));
  if (!mine || alts.some(a => !a)) return { badge: null, text: 'bag fees need verification' };
  const need = BAG_NEEDS[bags];
  const way = `for the way you're traveling (${need}${T > 1 ? `, ${T} travelers` : ''})`;
  const name = a => `the ${fmt(a.sticker)} ${a.flight.name} fare`;
  const other = a => { const d = fareDiffs(trip.flight, a.flight); return `${name(a)}${d.length ? ` (${d.join(', ')})` : ''}`; };
  const cap = x => x[0].toUpperCase() + x.slice(1);
  const bySticker = alts.reduce((m, a) => (a.sticker < m.sticker ? a : m));
  const byRelevant = alts.reduce((m, a) => (a.relevant < m.relevant ? a : m));
  // A tie on the sticker counts when the totals with the bag differ: two fares at one price where
  // only one includes the bag are not the same price for this traveler.
  if (mine.sticker <= bySticker.sticker && mine.relevant > byRelevant.relevant) {
    const looks = mine.sticker < bySticker.sticker ? `${cap(name(mine))} looks cheaper` : `${cap(name(mine))} matches ${other(bySticker)} on the sticker`;
    const against = bySticker === byRelevant && mine.sticker === bySticker.sticker ? 'That fare' : cap(other(byRelevant));
    return { badge: 'looks-cheaper', mine, against: byRelevant, text: `${looks}, but with ${need} it comes to ${fmt(mine.relevant)}. ${against} is ${fmt(mine.relevant - byRelevant.relevant)} cheaper ${way}.` };
  }
  if ((mine.sticker > bySticker.sticker && mine.relevant <= byRelevant.relevant) || (mine.sticker === bySticker.sticker && mine.relevant < byRelevant.relevant)) {
    const a = bySticker;
    const diff = a.relevant - mine.relevant;
    return { badge: 'cheaper-overall', mine, against: a, text: diff > 0
      ? `${cap(name(mine))} is ${fmt(diff)} cheaper ${way}: ${other(a)} comes to ${fmt(a.relevant)} once ${need} is added.`
      : `${cap(name(mine))} costs the same as ${other(a)} ${way}: both come to ${fmt(mine.relevant)} once ${need} is added.` };
  }
  if (mine.relevant === byRelevant.relevant) return { badge: null, mine, against: byRelevant, text: `No bag trap here: ${name(mine)} comes to the same ${fmt(mine.relevant)} ${way} as ${other(byRelevant)}.` };
  const best = mine.relevant < byRelevant.relevant ? mine : byRelevant;
  return { badge: null, mine, against: byRelevant, text: best === mine
    ? `No bag trap here: ${name(mine)} is also the cheapest ${way}${mine.fee ? `, ${fmt(mine.relevant)} with ${need}` : ''}.`
    : `No bag trap here: ${other(byRelevant)} is ${fmt(mine.relevant - byRelevant.relevant)} cheaper ${way}${byRelevant.fee ? ` (${fmt(byRelevant.relevant)} with ${need})` : ''}.` };
}

// ---- the savings receipt ---------------------------------------------------------------------
// "How we kept your cost down": one line per step between consecutive versions of the trip, named
// by what changed between the two (every field of the spec is looked at, so a party, traveler count
// or departure airport change is never called a price refresh). Deltas are sequential, so they sum
// exactly to final minus original and nothing is counted twice. YOU KEEP is the traveler's maximum
// minus the final total, only when the final total is at or under the maximum; otherwise `keep` is
// null and `over` carries the overrun, so a caller never says "you keep" a negative. No maximum (or
// a zero one) means no "you keep" at all.
function lineLabel(a, b) {
  const rows = classifyChanges(a, b);
  const changed = new Set([...rows.improvements, ...rows.tradeoffs, ...rows.neutral].map(r => r.key));
  const parts = [];
  if (changed.has('dest')) parts.push('Destination change');
  if (a.spec.depart !== b.spec.depart) parts.push('Date change');
  if (a.spec.travelers !== b.spec.travelers) parts.push(`Travelers: ${a.spec.travelers} → ${b.spec.travelers}`);
  if (a.spec.who !== b.spec.who) parts.push('Party change');
  if (a.spec.from !== b.spec.from) parts.push('Departure airport change');
  if (changed.has('nights')) parts.push(b.spec.nights > a.spec.nights ? `${plural(b.spec.nights - a.spec.nights, 'extra night')}` : `${plural(a.spec.nights - b.spec.nights, 'night')} fewer`);
  if (a.spec.hotel !== b.spec.hotel) parts.push('Hotel swap');
  if (a.spec.flight !== b.spec.flight) parts.push('Flight swap');
  if (changed.has('experiences')) parts.push(b.activities.length > a.activities.length ? 'Added experiences' : b.activities.length < a.activities.length ? 'Removed experiences' : 'Experience change');
  if (changed.has('transfer')) parts.push(b.transfer ? 'Added transfer' : 'Removed transfer');
  if (a.spec.bags !== b.spec.bags) parts.push(b.spec.bags ? 'Added checked bags' : 'Removed checked bags');
  if (!parts.length) parts.push(a.total === b.total ? 'No change' : 'Price refresh, same trip');
  return parts.join(', ');
}

function savingsReceipt(versions = [], max = null) {
  const vs = versions.filter(v => v && v.trip);
  if (!vs.length) return { lines: [], original: null, final: null, max, keep: null, over: null };
  const lines = [];
  for (let i = 1; i < vs.length; i++) {
    const a = vs[i - 1], b = vs[i];
    lines.push({ label: lineLabel(a.trip, b.trip), delta: b.trip.total - a.trip.total, from: a.trip.total, to: b.trip.total, fromLabel: a.label || null, toLabel: b.label || null });
  }
  const original = vs[0].trip.total, final = vs[vs.length - 1].trip.total;
  const ceiling = Number.isFinite(max) && max > 0 ? max : null;
  return { lines, original, final, max, keep: ceiling !== null && final <= ceiling ? ceiling - final : null, over: ceiling !== null && final > ceiling ? final - ceiling : null };
}

// ---- the savings check before payment --------------------------------------------------------
// Right before paying: the trip is priced again (with the promo the checkout carries, when the
// caller passes `promo`, so the check compares like with like), then every cheaper version is looked
// for once more (decision.nameYourPrice asked for anything cheaper, with the traveler's locks and
// an exact date held). Only a version that is at least `material` cheaper with nothing given up
// counts: no trade-off by the facts, no compromise of weight 2 or more the fresh trip does not
// already carry, the traveler's own experiences kept; the traveler decides. The result carries
// `considered` (distinct versions compared) and `truncated` (a pass hit the pricing limit), and its
// words say when the pass was not exhaustive.
function savingsCheck(inventory, trip, settings, ctx = {}, { now = new Date(), locks = {}, material = 2500, promo = null } = {}) {
  const inv = memoInventory(inventory);
  const held = holds(ctx, locks);
  const fresh = priceTrip(inv, trip.spec, settings, { promo });
  if (!fresh) return { ok: false, cheaper: null, total: null, repriced: null, truncated: false, considered: 0, text: 'Part of this trip could not be priced again; it needs verification before payment.' };
  const out = nameYourPrice(inv, fresh, settings, ctx, fresh.total - 1, { now, locks: held });
  const reprice = t => (promo ? priceTrip(inv, t.spec, settings, { promo }) : t);
  const pool = [out.recommended, out.floor, out.anyway, out.cheapest, ...out.ladder.filter(r => !r.current)].filter(Boolean).map(c => reprice(c.trip)).filter(Boolean);
  // The ladder is sampled, so a cheaper version that changes nothing of substance (other dates, a
  // like-for-like hotel or fare) can fall between its rungs: those are priced directly as well, with
  // the trip's own experiences only.
  const s = fresh.spec;
  const same = versions(inv, fresh, settings, ctx, { locks: held, dates: nearbyDates(s.depart, now, held, ctx), nightsList: [s.nights], sets: [s.activities], transfers: [s.transfer], bagsList: [s.bags], promo });
  const qctx = { ...ctx, budget: null, allowOver: 0 };
  const had = new Set(compromises(fresh, qctx).map(c => c.text));
  const seen = new Set([encodeSpec(s)]);
  let best = null, considered = 0;
  for (const p of [...pool, ...same.versions]) {
    const key = encodeSpec(p.spec);
    if (seen.has(key)) continue;
    seen.add(key);
    considered++;
    if (p.total > fresh.total - material) continue;
    if (!sameSet(p.spec.activities, s.activities)) continue;
    if (ctx.protect && !p.spec.activities.includes(ctx.protect)) continue; // never a cheaper version without the protected experience
    const ch = classifyChanges(fresh, p);
    if (ch.tradeoffs.length) continue;
    if (compromises(p, qctx).some(c => c.w >= 2 && !had.has(c.text))) continue;
    if (!best || p.total < best.trip.total || (p.total === best.trip.total && ch.neutral.length < best.changes.neutral.length)) best = { trip: p, changes: ch };
  }
  const truncated = !!(out.truncated || same.truncated);
  const repriced = fresh.total - trip.total;
  if (!best) return { ok: true, total: fresh.total, repriced, truncated, considered, text: `Savings check complete: nothing cheaper without a compromise among the ${considered} versions priced${truncated ? ` (${PARTIAL})` : ''}` };
  const delta = best.trip.total - fresh.total;
  const facts = [...best.changes.improvements, ...best.changes.neutral].map(rowText);
  return {
    ok: false, total: fresh.total, repriced, truncated, considered,
    cheaper: { ...pack(best.trip, best.changes), delta },
    text: `A version of this trip is ${fmt(-delta)} cheaper (${fmt(best.trip.total)} instead of ${fmt(fresh.total)}) without a compromise: ${facts.join('; ')}.`,
  };
}

// ---- the saver's verdict ---------------------------------------------------------------------
// "Can I responsibly make this cheaper?" Yes when a version we would still recommend costs less;
// otherwise we stop, and say what the cheapest version found would mean. When the pass hit the
// pricing limit the words say so and `truncated` is set: "lowest found" is then not "lowest there is".
function saverVerdict(inventory, trip, settings, ctx = {}, opts = {}) {
  const { recommend, cheapest, truncated } = howLow(inventory, trip, settings, ctx, opts);
  const partial = truncated ? PARTIAL_SENTENCE : '';
  if (recommend.total < trip.total) {
    const delta = trip.total - recommend.total;
    const given = recommend.changes.tradeoffs.map(rowText);
    const words = [...recommend.changes.neutral, ...recommend.changes.improvements].map(rowText);
    const text = `I found a way to keep another ${fmt(delta)}: ${fmt(recommend.total)} instead of ${fmt(trip.total)}${words.length ? ` (${words.join('; ')})` : ''}. ${given.length ? `It means ${joinAnd(given)}.` : 'Nothing given up.'}${partial}`;
    return { canCut: true, alternative: { ...recommend, delta: -delta }, cheapest, truncated, text };
  }
  const means = cheapest && cheapest.whyNot.length ? cheapest.whyNot : [IDENTICAL];
  const text = cheapest
    ? `I'd stop cutting here. The next cheaper options require compromises I don't think justify the savings based on your rules. The cheapest version found is ${fmt(cheapest.total)}, ${fmt(trip.total - cheapest.total)} less than ${fmt(trip.total)}, but it means ${joinAnd(means)}.${partial}`
    : `I'd stop cutting here: ${fmt(trip.total)} is the lowest price found for this trip with your rules and locks kept.${partial}`;
  return { canCut: false, alternative: null, cheapest, truncated, text };
}

// ---- saver-mode labels -----------------------------------------------------------------------
// The optimizer's answers, named for a saver: never Best, Premium or Luxury. The optimizer's
// save-more pick is the highest-match trip among the clearly cheaper ones, not the cheapest trip
// we would still recommend: trips far cheaper than it that decision.verdict grades great or good
// sit in the same eligible set, and save-more itself can be graded budget. So "Lowest I recommend"
// is only ever the option the caller built from lowestRecommended() (search's eligibleTrips, judged
// by decision.verdict with the budget taken out), placed second; save-more is then dropped, so there
// are never two cheaper options and never a cheaper option called lowest that is not. A lowest that
// is the pick itself, or not cheaper than it, is not listed: the pick is then the lowest we
// recommend, and save-more (cheaper, but not a trip we would recommend) is still dropped. With no
// `lowest` the options are relabelled as before (callers in saver mode should pass one).
// The optimizer's "save more" pick (the strongest cheaper trip, whatever its grade) has no saver name:
// "Lowest I recommend" is only ever the trip lowestRecommended() vouches for.
const SAVER_LABELS = { 'our-pick': 'Best value', lowest: 'Lowest I recommend', upgrade: 'Keep more comfort' };
function lowestRecommended(eligibleTrips = [], ctx = {}, { exclude = [] } = {}) {
  const qctx = { ...ctx, budget: null, allowOver: 0 };
  const skip = new Set(exclude);
  let best = null;
  for (const x of eligibleTrips) {
    const t = x && x.trip;
    if (!t || (best && t.total > best.total)) continue;
    const token = encodeSpec(t.spec);
    if (skip.has(token)) continue;
    if (ctx.protect && !t.spec.activities.includes(ctx.protect)) continue; // a trip without the protected experience is never "lowest I recommend"
    const v = verdict(t, qctx);
    if (v.grade !== 'great' && v.grade !== 'good') continue;
    const match = Number.isFinite(x.match) ? x.match : v.match;
    if (!best || t.total < best.total || match > best.match) best = { trip: t, token, total: t.total, match, verdict: v };
  }
  return best;
}

// An option is the agent's card (token, total) or a search pick (trip); both are read the same way.
const tokenOf = o => (o && (o.token || (o.trip && o.trip.spec ? encodeSpec(o.trip.spec) : null))) || null;
const totalOf = o => (o && Number.isFinite(o.total) ? o.total : o && o.trip ? o.trip.total : NaN);
function labelsFor(options = [], { lowest = null } = {}) {
  const relabel = o => (o && SAVER_LABELS[o.kind] ? { ...o, label: SAVER_LABELS[o.kind] } : { ...o });
  // Save-more is dropped either way: when nothing cheaper is recommended there is no second option
  // to name, and the cheapest trip is still reachable through "how low can you go?", said as what it is.
  const out = options.filter(o => !(o && o.kind === 'save-more')).map(relabel);
  if (!lowest) return out;
  const low = { ...lowest, kind: 'lowest', label: SAVER_LABELS.lowest };
  const token = tokenOf(low);
  if (token && out.some(o => tokenOf(o) === token)) return out; // already on the list (the pick itself): never the same package twice
  const i = out.findIndex(o => o.kind === 'our-pick');
  if (i >= 0 && Number.isFinite(totalOf(out[i])) && !(totalOf(low) < totalOf(out[i]))) return out; // the pick is the lowest we recommend
  out.splice(i >= 0 ? i + 1 : Math.min(1, out.length), 0, low);
  return out;
}

module.exports = { howLow, priceBreakpoints, cheapTrap, savingsReceipt, savingsCheck, saverVerdict, labelsFor, lowestRecommended, whyNot, lineLabel, relevantFare, fareDiffs, getsLabel, nearbyDates, SAVER_LABELS, IDENTICAL };
