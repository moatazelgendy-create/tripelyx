// SAVE MAX: the relentless-savings view of one priced trip. The job is "how low can we responsibly
// get this trip", never "spend the budget". Every number here is a priced package (optimizer.search,
// pricing.priceTrip or decision.nameYourPrice); nothing is estimated and no saving is ever claimed
// without saying compared with what. The lowest version we would still recommend is kept apart from
// the absolute cheapest version found, and the cheapest is only ever shown with the facts of that
// trip that keep it from being recommended. Rules and locks are never relaxed here: a relaxed rule
// is a compromise the traveler picks, not something the engine applies on its own.
const { addDays, today } = require('../lib/dates');
const { format } = require('../lib/money');
const { priceTrip } = require('./pricing');
const { memoInventory, activitySets, hotelAllowed, rulesAllowHotel, rulesAllowFlight } = require('./optimizer');
const { nameYourPrice, compromises } = require('./decision');
const { classifyChanges, usableTime } = require('./facts');
const { encodeSpec } = require('./spec');

const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dur = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const joinAnd = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const rowText = r => `${r.label}: ${r.b}`;
const pack = (t, changes) => ({ trip: t, token: encodeSpec(t.spec), total: t.total, changes });
const MAX_PRICED = 2500;

// ---- versions of one trip --------------------------------------------------------------------
// Every version of a trip the saver tools may price: same destination, the trip's own hotel and
// flight options filtered by the traveler's rules, locks kept. The caller picks what may vary.
function nearbyDates(depart, now, locks = {}) {
  if (locks.dates) return [depart];
  const earliest = addDays(today(now), 3);
  return [depart, ...[-3, -2, -1, 1, 2, 3].map(o => addDays(depart, o)).filter(d => d >= earliest)];
}

function versions(inv, t, settings, ctx, { locks = {}, dates, nightsList, sets, transfers, bagsList }) {
  const s = t.spec;
  const hotels = locks.hotel ? [s.hotel] : t.hotelOptions.filter(h => hotelAllowed(h, { who: s.who, style: ctx.style }) && rulesAllowHotel(h, ctx.rules)).map(h => h.id);
  if (!hotels.includes(s.hotel)) hotels.push(s.hotel);
  const flights = locks.flight ? [s.flight] : t.flightOptions.filter(f => rulesAllowFlight(f, ctx.rules)).map(f => f.id);
  if (!flights.includes(s.flight)) flights.push(s.flight);
  const seen = new Set([encodeSpec(s)]);
  const out = [];
  let priced = 0, truncated = false;
  outer: for (const depart of dates) for (const nights of nightsList) for (const hotel of hotels) for (const flight of flights) for (const activities of sets) for (const transfer of transfers) for (const bags of bagsList) {
    const spec = { ...s, depart, nights, hotel, flight, activities: [...activities].sort(), transfer, bags };
    const key = encodeSpec(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    if (priced++ >= MAX_PRICED) { truncated = true; break outer; }
    const p = priceTrip(inv, spec, settings);
    if (p) out.push(p);
  }
  return { versions: out, truncated };
}

// ---- how low ---------------------------------------------------------------------------------
// The facts of a cheaper trip that keep it from being recommended, each read off that trip itself,
// never off its price: what it gives up against the version we would recommend, then any compromise
// it carries that the recommended version does not, then (if nothing else differs) what is simply
// different. A line is only ever a fact of the cheaper trip.
function whyNot(cheap, against, ctx = {}) {
  const f = cheap.flight, h = cheap.hotel, s = cheap.spec;
  const out = [];
  const ch = classifyChanges(against, cheap);
  for (const row of ch.tradeoffs) {
    switch (row.key) {
      case 'nights': out.push(ctx.nightsAsked && s.nights < ctx.nightsAsked ? `${plural(s.nights, 'night')}, ${plural(ctx.nightsAsked - s.nights, 'night')} fewer than you asked for` : `${plural(s.nights, 'night')} instead of ${against.spec.nights}`); break;
      case 'flight': out.push(f.stops > 0 ? `${plural(f.stops, 'stop')}, ${dur(f.durationMinutes)} each way` : `${dur(f.durationMinutes)} each way on the ${f.name} fare`); break;
      case 'hotel': out.push(`${h.stars}-star hotel rated ${h.rating}/5 (${h.name})`); break;
      case 'area': out.push(`not beachfront: ${h.area}`); break;
      case 'meals': out.push(h.features.breakfast ? 'breakfast only, not all-inclusive' : against.hotel.features.allInclusive ? 'no meals included' : 'no breakfast included'); break;
      case 'bags': out.push(!f.carryOn ? 'personal item only, no carry-on' : 'no checked bag'); break;
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
  return [...new Set(out)];
}

// "How low can you get it?" The lowest version of this trip we would still recommend (decision.
// nameYourPrice asked for anything cheaper: its recommended version, else its floor), and the
// absolute cheapest version found when that is not the one we recommend, with the facts that keep
// it from being recommended. When nothing cheaper exists the trip itself is the answer.
function howLow(inventory, trip, settings, ctx = {}, { now = new Date(), locks = {} } = {}) {
  const out = nameYourPrice(inventory, trip, settings, ctx, trip.total - 1, { now, locks });
  const rec = [out.recommended, out.floor].find(c => c && c.total < trip.total) || null;
  const recommend = rec ? pack(rec.trip, rec.changes) : pack(trip, classifyChanges(trip, trip));
  const c = out.cheapest;
  const cheapest = c && c.total < recommend.total && encodeSpec(c.trip.spec) !== recommend.token
    ? { ...pack(c.trip, c.changes), whyNot: whyNot(c.trip, recommend.trip, ctx) }
    : null;
  return { recommend, cheapest, considered: out.considered, truncated: out.truncated };
}

// ---- price breakpoints -----------------------------------------------------------------------
// "Where does money start buying something meaningful?" One breakpoint per kind of improvement: the
// cheapest priced version of the trip that buys it with nothing given up, at or under the cap. Same
// destination and dates; a date move is only offered when it is the only way to buy something, and
// the label says so.
const GETS_ORDER = ['nights', 'flight', 'hotel', 'area', 'meals', 'transfer', 'flex', 'bags', 'time', 'experiences'];
function getsLabel(key, a, b) {
  switch (key) {
    case 'nights': return b.spec.nights - a.spec.nights === 1 ? 'Extra night' : `${b.spec.nights - a.spec.nights} extra nights`;
    case 'flight': return b.flight.stops === 0 && a.flight.stops > 0 ? 'Nonstop flight' : 'Shorter flights';
    case 'hotel': return b.hotel.stars > a.hotel.stars ? 'Better hotel class' : 'Higher-rated hotel';
    case 'area': return 'Beachfront';
    case 'meals': return b.hotel.features.allInclusive ? 'All-inclusive' : 'Breakfast included';
    case 'transfer': return 'Included transfer';
    case 'flex': return b.flight.refundable && !a.flight.refundable ? 'Refundable flights' : 'Free hotel cancellation';
    case 'bags': return b.flight.checkedBagIncluded || b.spec.bags ? 'Checked bags' : 'Carry-on bag';
    case 'time': return 'More usable vacation time';
    case 'experiences': return b.activities.length - a.activities.length === 1 ? 'An extra experience' : 'More experiences';
    default: return null;
  }
}

function priceBreakpoints(inventory, base, settings, ctx = {}, { now = new Date(), cap, locks = {} } = {}) {
  const inv = memoInventory(inventory);
  const s = base.spec;
  const limit = Number.isFinite(cap) ? cap : Number.isFinite(ctx.budget) ? ctx.budget : Infinity;
  const nightsList = locks.nights || locks.dates ? [s.nights] : [s.nights, s.nights + 1, s.nights + 2].filter(n => n <= 14);
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
  for (const p of versions(inv, base, settings, ctx, { locks, dates: [s.depart], nightsList, sets, transfers, bagsList }).versions) consider(p, false);
  // On other dates only the fares and the hotels can change (a nonstop that flies on other days, a
  // hotel with rooms then), so that is all a date move is tried for.
  if (!locks.dates) {
    const dates = nearbyDates(s.depart, now).slice(1);
    for (const p of versions(inv, base, settings, ctx, { locks, dates, nightsList: [s.nights], sets: [s.activities], transfers: [s.transfer], bagsList: [s.bags] }).versions) consider(p, true);
  }
  return [...found.values()].sort((a, b) => a.delta - b.delta || a.total - b.total).slice(0, 5);
}

// ---- the cheap trap --------------------------------------------------------------------------
// A cheap fare plus the bag the traveler needs is not always the cheap fare. The fares are compared
// on what they really cost for the way the traveler packs, from the fare's own bag fields; when the
// inventory has no fee for the bag they need, nothing is guessed.
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

function cheapTrap(trip, alternatives = [], { bags } = {}) {
  if (!BAG_NEEDS[bags]) return { badge: null, text: 'Tell us how you pack (personal item, carry-on or checked bag) and we will compare fares for the way you travel.' };
  const T = trip.spec.travelers;
  const fareKey = f => `${f.id}|${f.depart}|${f.farePerTraveler}|${f.taxesPerTraveler}`;
  const seen = new Set([fareKey(trip.flight)]);
  const flights = alternatives.map(a => (a && a.flight) || a).filter(f => f && f.id && !seen.has(fareKey(f)) && seen.add(fareKey(f)));
  if (!flights.length) return { badge: null, text: 'No other fare to compare against.' };
  const mine = relevantFare(trip.flight, bags, T);
  const alts = flights.map(f => relevantFare(f, bags, T));
  if (!mine || alts.some(a => !a)) return { badge: null, text: 'bag fees need verification' };
  const need = BAG_NEEDS[bags];
  const way = `for the way you're traveling (${need}${T > 1 ? `, ${T} travelers` : ''})`;
  const bySticker = alts.reduce((m, a) => (a.sticker < m.sticker ? a : m));
  const byRelevant = alts.reduce((m, a) => (a.relevant < m.relevant ? a : m));
  if (mine.sticker < bySticker.sticker && mine.relevant > byRelevant.relevant) {
    return { badge: 'looks-cheaper', mine, against: byRelevant, text: `The ${fmt(mine.sticker)} fare looks cheaper, but with ${need} it comes to ${fmt(mine.relevant)}. The ${fmt(byRelevant.sticker)} fare is ${fmt(mine.relevant - byRelevant.relevant)} cheaper ${way}.` };
  }
  if (mine.sticker > bySticker.sticker && mine.relevant <= byRelevant.relevant) {
    const a = bySticker;
    const diff = a.relevant - mine.relevant;
    return { badge: 'cheaper-overall', mine, against: a, text: diff > 0
      ? `The ${fmt(mine.sticker)} fare is ${fmt(diff)} cheaper ${way}: the ${fmt(a.sticker)} fare comes to ${fmt(a.relevant)} once ${need} is added.`
      : `The ${fmt(mine.sticker)} fare costs the same as the ${fmt(a.sticker)} fare ${way}: both come to ${fmt(mine.relevant)} once ${need} is added.` };
  }
  const best = mine.relevant <= byRelevant.relevant ? mine : byRelevant;
  return { badge: null, mine, against: byRelevant, text: best === mine
    ? `No bag trap here: the ${fmt(mine.sticker)} fare is also the cheapest ${way}${mine.fee ? `, ${fmt(mine.relevant)} with ${need}` : ''}.`
    : `No bag trap here: the ${fmt(byRelevant.sticker)} fare is ${fmt(mine.relevant - byRelevant.relevant)} cheaper ${way}${byRelevant.fee ? ` (${fmt(byRelevant.relevant)} with ${need})` : ''}.` };
}

// ---- the savings receipt ---------------------------------------------------------------------
// "How we kept your cost down": one line per step between consecutive versions of the trip, named
// by what changed between the two. Deltas are sequential, so they sum exactly to final minus
// original and nothing is counted twice. YOU KEEP is the traveler's maximum minus the final total.
function lineLabel(a, b) {
  const rows = classifyChanges(a, b);
  const changed = new Set([...rows.improvements, ...rows.tradeoffs, ...rows.neutral].map(r => r.key));
  const parts = [];
  if (changed.has('dest')) parts.push('Destination change');
  if (a.spec.depart !== b.spec.depart) parts.push('Date change');
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
  if (!vs.length) return { lines: [], original: null, final: null, max, keep: null };
  const lines = [];
  for (let i = 1; i < vs.length; i++) {
    const a = vs[i - 1], b = vs[i];
    lines.push({ label: lineLabel(a.trip, b.trip), delta: b.trip.total - a.trip.total, from: a.trip.total, to: b.trip.total, fromLabel: a.label || null, toLabel: b.label || null });
  }
  const original = vs[0].trip.total, final = vs[vs.length - 1].trip.total;
  return { lines, original, final, max, keep: Number.isFinite(max) ? max - final : null };
}

// ---- the savings check before payment --------------------------------------------------------
// Right before paying: the trip is priced again, then every cheaper version is looked for once more
// (decision.nameYourPrice asked for anything cheaper, with the traveler's locks). Only a version
// that is at least `material` cheaper with nothing given up counts; the traveler decides.
function savingsCheck(inventory, trip, settings, ctx = {}, { now = new Date(), locks = {}, material = 2500 } = {}) {
  const inv = memoInventory(inventory);
  const fresh = priceTrip(inv, trip.spec, settings);
  if (!fresh) return { ok: false, cheaper: null, total: null, repriced: null, text: 'Part of this trip could not be priced again; it needs verification before payment.' };
  const out = nameYourPrice(inv, fresh, settings, ctx, fresh.total - 1, { now, locks });
  const pool = [out.recommended, out.floor, out.anyway, out.cheapest, ...out.ladder.filter(r => !r.current)].filter(Boolean).map(c => c.trip);
  // The ladder is sampled, so a cheaper version that changes nothing of substance (other dates, a
  // like-for-like hotel or fare, the same number of experiences) can fall between its rungs: those
  // are priced directly as well.
  const s = fresh.spec;
  const sets = [s.activities, ...activitySets(fresh.activityOptions, ctx.style || 'surprise').filter(a => a.length === s.activities.length)];
  const same = versions(inv, fresh, settings, ctx, { locks, dates: nearbyDates(s.depart, now, locks), nightsList: [s.nights], sets, transfers: [s.transfer], bagsList: [s.bags] });
  let best = null;
  for (const p of [...pool, ...same.versions]) {
    if (p.total > fresh.total - material) continue;
    const ch = classifyChanges(fresh, p);
    if (ch.tradeoffs.length) continue;
    if (!best || p.total < best.trip.total || (p.total === best.trip.total && ch.neutral.length < best.changes.neutral.length)) best = { trip: p, changes: ch };
  }
  const repriced = fresh.total - trip.total;
  if (!best) return { ok: true, total: fresh.total, repriced, text: 'Savings check complete: nothing cheaper without a compromise' };
  const delta = best.trip.total - fresh.total;
  const facts = [...best.changes.improvements, ...best.changes.neutral].map(rowText);
  return {
    ok: false, total: fresh.total, repriced,
    cheaper: { ...pack(best.trip, best.changes), delta },
    text: `A version of this trip is ${fmt(-delta)} cheaper (${fmt(best.trip.total)} instead of ${fmt(fresh.total)}) without a compromise: ${facts.join('; ')}.`,
  };
}

// ---- the saver's verdict ---------------------------------------------------------------------
// "Can I responsibly make this cheaper?" Yes when a version we would still recommend costs less;
// otherwise we stop, and say what the cheapest version found would mean.
function saverVerdict(inventory, trip, settings, ctx = {}, opts = {}) {
  const { recommend, cheapest } = howLow(inventory, trip, settings, ctx, opts);
  if (recommend.total < trip.total) {
    const delta = trip.total - recommend.total;
    const given = recommend.changes.tradeoffs.map(rowText);
    const words = [...recommend.changes.neutral, ...recommend.changes.improvements].map(rowText);
    const text = `I found a way to keep another ${fmt(delta)}: ${fmt(recommend.total)} instead of ${fmt(trip.total)}${words.length ? ` (${words.join('; ')})` : ''}. ${given.length ? `It means ${joinAnd(given)}.` : 'Nothing given up.'}`;
    return { canCut: true, alternative: { ...recommend, delta: -delta }, cheapest, text };
  }
  const text = cheapest
    ? `I'd stop cutting here. The next cheaper options require compromises I don't think justify the savings based on your rules. The cheapest version found is ${fmt(cheapest.total)}, ${fmt(trip.total - cheapest.total)} less than ${fmt(trip.total)}, but it means ${joinAnd(cheapest.whyNot)}.`
    : `I'd stop cutting here: ${fmt(trip.total)} is the lowest price found for this trip with your rules and locks kept.`;
  return { canCut: false, alternative: null, cheapest, text };
}

// ---- saver-mode labels -----------------------------------------------------------------------
// The optimizer's three answers, named for a saver: never Best, Premium or Luxury.
const SAVER_LABELS = { 'our-pick': 'Best value', 'save-more': 'Lowest I recommend', upgrade: 'Keep more comfort' };
function labelsFor(options = []) {
  return options.map(o => (o && SAVER_LABELS[o.kind] ? { ...o, label: SAVER_LABELS[o.kind] } : { ...o }));
}

module.exports = { howLow, priceBreakpoints, cheapTrap, savingsReceipt, savingsCheck, saverVerdict, labelsFor, whyNot, lineLabel, relevantFare, SAVER_LABELS };
