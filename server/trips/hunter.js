// THE SAVINGS HUNTER engine. A hunt is a customer's standing rules (a ceiling, a party, a window, a
// range of lengths, hard rules, destinations to leave out) and this module runs one pass of it over
// the inventory and decides, against what the platform recorded last time, whether anything is worth
// interrupting the customer for. It is pure: no store, no clock of its own, no I/O. The hunt service
// owns the records, the scheduler and the notifications.
//
// Every number here is a priced package (optimizer.search, pricing.priceTrip) or arithmetic on two of
// them. A "previous" price is only ever one the caller recorded (hunt.baseline) and is said as such;
// nothing is estimated, predicted or inferred about money, availability or the customer. Silence is
// the normal answer: a run that finds nothing worth saying returns `silent` with the plain reason.
//
// Auto-negotiation is what the search itself already covers, not a second mechanism: every departure
// the suppliers can be asked about in the window is asked for fares and the two cheapest dates per
// destination and length are priced in full; every hotel inside the rules; every fare inside the
// rules; the departure airport the inventory has for the origin; every length from minNights to
// maxNights; and, once a best trip stands, a savings check (savemax.savingsCheck) that re-prices it
// up to three days either way and in every cheaper version with nothing given up, so the AI beats its
// own deal before the customer sees it. `checked.negotiated` lists exactly that, read off the run, so
// a page never implies a search that did not happen.
const { addDays, today } = require('../lib/dates');
const { format } = require('../lib/money');
const { AppError } = require('../lib/errors');
const optimizer = require('./optimizer');
const { verdict } = require('./decision');
const { savingsCheck } = require('./savemax');
const { classifyChanges, hasChecked } = require('./facts');
const { priceTrip } = require('./pricing');
const { encodeSpec, decodeSpec } = require('./spec');

// The steps the pages offer for "tell me when the saving is at least": $50, $100, $200 (cents).
const THRESHOLDS = [5000, 10000, 20000];
// The kinds, strongest first: the order opportunities are returned in.
const KINDS = ['breakthrough', 'found', 'beat-saved', 'drop', 'extra-night', 'quality', 'nonstop', 'destination'];
// What the customer can ask to be told about; 'under' covers found and breakthrough.
const NOTIFY_KINDS = ['under', 'beat-saved', 'drop', 'extra-night', 'nonstop', 'quality', 'destination'];
const NOTIFY_OF = { found: 'under', breakthrough: 'under', 'beat-saved': 'beat-saved', drop: 'drop', 'extra-night': 'extra-night', quality: 'quality', nonstop: 'nonstop', destination: 'destination' };
const EXTRA_NIGHT_CAP = 2500;                       // an extra night counts when it costs at most this much more
const LENGTH_KEYS = new Set(['nights', 'time', 'dates']); // the rows a longer trip changes on its own
const BAND = 3;                                     // near-equal strongest fits, as the optimizer's pick
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const NONSTOP_LINE = 'You told me nonstop matters. This is why I\'m showing you this.';
const MEETS = 'This currently meets the rules you gave me.';
const MAY_CHANGE = 'Price and availability may change.';

const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hours = m => `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}`;
const joinAnd = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const monthName = m => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
const rowText = r => `${r.label.toLowerCase()}: ${r.b}${r.direction < 0 ? ` (was ${r.a})` : ''}`;
// What changed between two versions, in words from the facts: a date move is said as one.
const changeWords = (a, b, ch = classifyChanges(a, b)) => [...ch.neutral, ...ch.improvements].map(r => (r.key === 'dates' ? `leaving ${b.spec.depart} instead of ${a.spec.depart}` : rowText(r))).join('; ') || 'a different fare or room whose supplier facts match';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// "for $12 more than", "for $8 less than", "for the same money as".
const deltaPhrase = d => (d > 0 ? `${fmt(d)} more than` : d < 0 ? `${fmt(-d)} less than` : 'the same money as');
const stampOf = iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const bagsText = t => (hasChecked(t) ? (t.flight.carryOn ? 'Checked bag included' : 'Checked bag included (no carry-on)') : t.flight.carryOn ? 'Carry-on only' : 'Personal item only');

// ---- the hunt's numbers --------------------------------------------------------------------------
// The ceiling the search uses: the budget, or the harder target "find me something even better" set.
function ceilingOf(hunt) {
  return Number.isFinite(hunt.target) && hunt.target > 0 ? Math.min(hunt.budget, hunt.target) : hunt.budget;
}
// The saving that earns an interruption, in cents; 'recommend' means the grade alone decides.
function thresholdOf(hunt) {
  return hunt.threshold === 'recommend' || !Number.isFinite(hunt.threshold) ? 0 : Math.max(0, Math.round(hunt.threshold));
}
function nightsRange(hunt) {
  const min = clamp(Math.round(hunt.minNights || 2), 2, 14);
  const max = clamp(Math.round(hunt.maxNights || Math.min(min + 3, 14)), min, 14);
  const out = [];
  for (let n = min; n <= max; n++) out.push(n);
  return out;
}
function monthOf(hunt) {
  return hunt.dateMode === 'flexible' && MONTH.test(hunt.month || '') ? hunt.month : null;
}
// The optimizer's rules from the hunt's: a hard nonstop filters, a preferred one does not; the floors
// set with a target ("same quality for less") are rules for the search as well.
function rulesOf(hunt) {
  const r = hunt.rules || {}, f = hunt.floors || {};
  const minStars = Math.max(r.minStars || 0, f.minStars || 0) || null;
  const rules = { nonstop: (r.flightStops === 'nonstop' && r.flightRule === 'hard') || !!f.nonstop, minStars, allInclusive: r.meals === 'all-inclusive', breakfast: r.meals === 'breakfast', beachfront: false, transfer: false, refundable: !!r.refundable };
  return Object.values(rules).some(Boolean) ? rules : null;
}
const notifies = (hunt, kind) => (Array.isArray(hunt.notify) ? hunt.notify : NOTIFY_KINDS.filter(k => k !== 'beat-saved' || hunt.savedToken)).includes(NOTIFY_OF[kind]);

// The optimizer query for one length: the shape optimizer.search expects (see agent/state.js toQuery).
// The hunt's destinations to leave out are applied by the run, not here.
function huntQuery(hunt, nights) {
  const budget = ceilingOf(hunt);
  const month = monthOf(hunt);
  const who = optimizer.WHO_DEFAULT[hunt.who] ? hunt.who : 'couple';
  return {
    budget, vacationBudget: budget, keep: 0, budgetInput: Math.round(budget / 100), budgetType: 'total',
    travelers: clamp(Math.round(hunt.travelers || optimizer.WHO_DEFAULT[who]), 1, 9), who, origin: hunt.origin,
    dateMode: month ? 'flexible' : 'anytime', depart: null, month, nights,
    style: optimizer.STYLES.includes(hunt.style) ? hunt.style : 'surprise', priority: 'price', allowOver: 0,
    dest: null, region: null, rules: rulesOf(hunt), dests: null, notCountry: null,
  };
}

// ---- the hunt card ---------------------------------------------------------------------------------
// What the views render for a trip: facts of the priced package, nothing about taste.
function huntCard(t, token = encodeSpec(t.spec)) {
  const f = t.flight, h = t.hotel;
  return {
    token, total: t.total, perTraveler: t.perTraveler, dest: t.dest.name, destId: t.dest.id, country: t.dest.country, image: t.dest.image,
    depart: t.spec.depart, ret: f.return || addDays(t.spec.depart, t.spec.nights), nights: t.spec.nights, travelers: t.spec.travelers,
    stops: f.stops, airline: f.airline, durationMinutes: f.durationMinutes, fareName: f.name,
    hotel: { name: h.name, stars: h.stars, area: h.area, allInclusive: !!h.features.allInclusive, breakfast: !!h.features.breakfast, refundable: !!h.refundable },
    transfer: !!t.transfer, activities: t.activities.length, bags: bagsText(t), demo: !!t.demo,
  };
}

// ---- the receipt's rules ---------------------------------------------------------------------------
// The customer's own rules, one line each, from the record alone (with `maps`, the origin by city).
function ruleLines(hunt, { maps = null } = {}) {
  const r = hunt.rules || {};
  const nights = nightsRange(hunt);
  const out = [`Maximum: ${fmt(hunt.budget)}`];
  if (Number.isFinite(hunt.target) && hunt.target > 0 && hunt.target < hunt.budget) out.push(`Beat: ${fmt(hunt.target)} for the same quality`);
  out.push(`Minimum: ${plural(nights[0], 'night')}`);
  if (nights.length > 1) out.push(`Up to: ${plural(nights[nights.length - 1], 'night')}`);
  if (r.flightStops === 'nonstop') out.push(`Nonstop: ${r.flightRule === 'hard' ? 'required' : 'preferred'}`);
  const stars = Math.max(r.minStars || 0, (hunt.floors && hunt.floors.minStars) || 0);
  if (stars) out.push(`Hotel: ${stars}-star or better`);
  if (hunt.floors && hunt.floors.nonstop && r.flightRule !== 'hard') out.push('Nonstop: kept (same quality for less)');
  if (r.meals === 'all-inclusive') out.push('Meals: all-inclusive');
  else if (r.meals === 'breakfast') out.push('Meals: breakfast included');
  if (r.refundable) out.push('Refundable: required');
  if (r.bags) out.push(`Bags: ${{ personal: 'personal item only', 'carry-on': 'a carry-on', checked: 'a checked bag' }[r.bags] || r.bags}`);
  const month = monthOf(hunt);
  out.push(`Window: ${month ? `in ${monthName(month)}` : 'anytime'}`);
  const who = { solo: 'solo', couple: 'a couple', family: 'a family', friends: 'friends' }[hunt.who];
  const origin = maps && maps.getOrigin(hunt.origin) ? maps.getOrigin(hunt.origin).city : hunt.origin;
  out.push(`Travelers: ${hunt.travelers || optimizer.WHO_DEFAULT[hunt.who] || 2}${who ? ` (${who})` : ''} from ${origin}`);
  if (hunt.style && hunt.style !== 'surprise') out.push(`Style: ${hunt.style === 'all-inclusive' ? 'all-inclusive' : hunt.style}`);
  if (Array.isArray(hunt.excludeDests) && hunt.excludeDests.length) out.push(`Left out: ${hunt.excludeDests.map(d => (maps && maps.getDestination(d) ? maps.getDestination(d).name : d)).join(', ')}`);
  if (hunt.savingsLevel === 'aggressive') out.push('Savings: aggressive (every trade-off said)');
  return out;
}

// ---- one run ---------------------------------------------------------------------------------------
// The origin as the maps know it: an origin id, or an airport code the inventory maps to one.
function resolveOrigin(maps, origin) {
  if (!origin) return null;
  if (maps.getOrigin(origin)) return origin;
  const ap = typeof maps.airport === 'function' ? maps.airport(String(origin).toUpperCase()) : null;
  return ap && maps.getOrigin(ap.originId) ? ap.originId : null;
}

// The departure dates the window lets the suppliers be asked about (the optimizer's own windows).
function windowDates(hunt, now) {
  const t = today(now);
  const month = monthOf(hunt);
  const out = [];
  if (month) { for (let d = `${month}-01`; d.slice(0, 7) === month; d = addDays(d, 1)) if (d >= addDays(t, 7)) out.push(d); }
  else for (let i = 14; i <= 150; i += 2) out.push(addDays(t, i));
  return out;
}

// Inside a chosen month the savings check may move the dates, but never out of the month: fares on
// other dates are simply not returned to it. Nothing is guessed about those dates; they are not asked.
function windowed(inv, hunt, now) {
  const month = monthOf(hunt);
  if (!month) return inv;
  const earliest = addDays(today(now), 7);
  const ok = d => typeof d === 'string' && d.slice(0, 7) === month && d >= earliest;
  return { ...inv, flights: { ...inv.flights, search: q => (ok(q.depart) ? inv.flights.search(q) : []) } };
}

function runHunt(inventory, hunt, settings, { now = new Date(), previous = hunt.baseline } = {}) {
  const inv = optimizer.memoInventory(inventory);
  const at = now.toISOString();
  const origin = resolveOrigin(inv.maps, hunt.origin);
  if (!hunt || !Number.isFinite(hunt.budget) || hunt.budget <= 0 || !origin) throw new AppError('invalid_hunt', 'A hunt needs a budget and a departure city.', 422);
  const ceiling = ceilingOf(hunt);
  const T = thresholdOf(hunt);
  const minSaving = Math.max(T, 1);
  const aggressive = hunt.savingsLevel === 'aggressive';
  const lengths = nightsRange(hunt);
  const month = monthOf(hunt);
  const bags = hunt.rules && hunt.rules.bags;
  const excluded = new Set(Array.isArray(hunt.excludeDests) ? hunt.excludeDests : []);
  const allowed = excluded.size ? inv.maps.listDestinations().map(d => d.id).filter(id => !excluded.has(id)) : null;
  const queries = Object.fromEntries(lengths.map(n => [n, { ...huntQuery(hunt, n), origin, dests: allowed }]));
  const rules = queries[lengths[0]].rules;
  const contexts = Object.fromEntries(lengths.map(n => [n, { ...optimizer.budgetContext(queries[n]), rules }]));
  const ctxFor = t => contexts[t.spec.nights] || { ...optimizer.budgetContext({ ...queries[lengths[0]], nights: t.spec.nights }), rules };
  const floors = hunt.floors || {};
  const inWindow = d => !month || d.slice(0, 7) === month;

  // The quality floor: the ceiling, the lengths, the destinations left out, the window, every hard
  // rule (as the optimizer applies them), the floors set with a target, the bag the customer travels
  // with, and a great or good verdict by the decision layer with the budget in the picture.
  const passesFloor = t => {
    const q = queries[t.spec.nights] || queries[lengths[0]];
    return lengths.includes(t.spec.nights) && !excluded.has(t.dest.id) && inWindow(t.spec.depart)
      && optimizer.rulesAllowFlight(t.flight, rules) && optimizer.rulesAllowHotel(t.hotel, rules) && optimizer.hotelAllowed(t.hotel, q)
      && (!floors.minStars || t.hotel.stars >= floors.minStars) && (!floors.nonstop || t.flight.stops === 0)
      && (bags !== 'carry-on' || !!t.flight.carryOn) && (bags !== 'checked' || hasChecked(t));
  };
  const strong = v => v.grade === 'great' || v.grade === 'good';
  const judge = t => {
    const v = verdict(t, ctxFor(t));
    const ok = t.total <= ceiling && passesFloor(t) && strong(v);
    return { trip: t, token: encodeSpec(t.spec), total: t.total, nights: t.spec.nights, dest: t.dest.id, stops: t.flight.stops, stars: t.hotel.stars, match: v.match, grade: v.grade, verdict: v, ok };
  };
  // Bag-aware pricing: a customer who travels with a checked bag pays for it, so a fare that does not
  // include one is priced with the bag added (a real re-price, never an estimate); a customer who
  // travels with a carry-on is not offered a fare that has none when the inventory has no fee to add.
  const bagAware = t => {
    if (bags === 'checked' && !hasChecked(t)) return priceTrip(inv, { ...t.spec, bags: true }, settings);
    if (bags === 'carry-on' && !t.flight.carryOn) return null;
    return t;
  };
  const reprice = token => { try { return priceTrip(inv, decodeSpec(token), settings); } catch (e) { return null; } };
  // What the customer already heard (hunt.opportunities): a trip told for a kind is not told again for
  // that kind (a drop or a beat is new again only at a new price), and a trip they rejected is out of
  // this mission. Silence is a feature; the record is what makes it possible.
  const past = Array.isArray(hunt.opportunities) ? hunt.opportunities.filter(o => o && o.trip && o.trip.token) : [];
  const rejected = new Set(past.filter(o => o.status === 'rejected').map(o => o.trip.token));
  const toldKey = (kind, token, total) => `${kind}|${token}|${kind === 'drop' || kind === 'beat-saved' ? total : ''}`;
  const told = new Set(past.map(o => toldKey(o.kind, o.trip.token, o.trip.total)));
  const fresh = (kind, c) => !told.has(toldKey(kind, c.token, c.total));

  const pool = [], closestCands = [], dests = new Set();
  let considered = 0, eligible = 0, versions = 0;
  for (const nights of lengths) {
    const r = optimizer.search(inv, queries[nights], { settings, now });
    considered += r.considered; eligible += r.eligible; versions += r.considered;
    for (const id of Object.keys(r.cheapestByDest)) if (!excluded.has(id)) dests.add(id);
    for (const x of r.eligibleTrips) {
      if (excluded.has(x.trip.dest.id)) continue;
      const t = bagAware(x.trip);
      if (t !== x.trip) versions++;
      if (t) pool.push(judge(t));
    }
    for (const c of r.closest) if (!excluded.has(c.trip.dest.id)) closestCands.push(c.trip);
  }
  let qualifying = pool.filter(p => p.ok && !rejected.has(p.token));

  // The strongest qualifying trip: the optimizer's own way of picking, the cheapest of the near-equal
  // strongest fits, so a point of score never buys a dearer trip.
  const strongest = cands => {
    if (!cands.length) return null;
    const top = Math.max(...cands.map(c => c.match));
    return cands.filter(c => c.match >= top - BAND).sort((a, b) => a.total - b.total || b.match - a.match)[0];
  };
  let best = strongest(qualifying);

  // The AI beats its own deal before showing it: every cheaper version of the best with nothing given
  // up (dates up to three days either way inside the window, hotels and fares inside the rules), by the
  // facts and by the decision layer's compromises, is priced; the cheapest replaces the best.
  const beat = (base, material) => {
    const sc = savingsCheck(windowed(inv, hunt, now), base.trip, settings, { ...ctxFor(base.trip), dateMode: queries[base.nights].dateMode, month }, { now, material });
    versions += sc.considered || 0;
    if (sc.ok || !sc.cheaper) return null;
    const c = judge(sc.cheaper.trip);
    return c.ok && !rejected.has(c.token) && c.total < base.total && !classifyChanges(base.trip, c.trip).tradeoffs.length ? c : null;
  };
  let challenger = null, nearMiss = null;
  if (best) {
    const c = beat(best, 1);
    if (c) { challenger = { from: best.total, to: c.total, why: changeWords(best.trip, c.trip) }; qualifying = [c, ...qualifying]; best = c; }
  } else if (considered) {
    // Nothing fit the ceiling. The strongest trips just over it (up to 10% over, inside the rules, and
    // great or good on their own) are priced again the same way, looking for a version at or under
    // the ceiling with nothing given up: the way a "find me something even better" target is met.
    const over = [];
    for (const nights of lengths) {
      const q = { ...queries[nights], budget: Math.round(ceiling * 1.1), vacationBudget: Math.round(ceiling * 1.1), budgetInput: Math.round(ceiling * 1.1 / 100) };
      const r = optimizer.search(inv, q, { settings, now });
      versions += r.considered;
      for (const x of r.eligibleTrips) {
        if (x.trip.total <= ceiling || excluded.has(x.trip.dest.id)) continue;
        const t = bagAware(x.trip);
        if (!t || t.total <= ceiling || !passesFloor(t)) continue;
        const v = verdict(t, { ...ctxFor(t), budget: null, allowOver: 0 });
        if (strong(v)) over.push({ ...judge(t), plain: v.match });
      }
    }
    over.sort((a, b) => b.plain - a.plain || a.total - b.total);
    nearMiss = over[0] ? { token: over[0].token, total: over[0].total } : null;
    for (const o of over.slice(0, 3)) {
      const c = beat(o, o.total - ceiling);
      if (c) { challenger = { from: o.total, to: c.total, why: changeWords(o.trip, c.trip) }; qualifying = [c, ...qualifying]; best = c; break; }
    }
  }

  const byDestMap = new Map();
  for (const c of [...qualifying].sort((a, b) => a.total - b.total)) if (!byDestMap.has(c.dest)) byDestMap.set(c.dest, { dest: c.dest, name: c.trip.dest.name, total: c.total, token: c.token });
  const byDest = [...byDestMap.values()];
  const cheapestOf = list => [...list].sort((a, b) => a.total - b.total || b.match - a.match)[0] || null;
  const nonstopC = cheapestOf(qualifying.filter(c => c.stops === 0));
  const nonstop = nonstopC ? { token: nonstopC.token, total: nonstopC.total } : null;
  // One more night than the best, with nothing but the length itself changing, whatever it costs.
  const extraC = best ? cheapestOf(qualifying.filter(c => c.nights === best.nights + 1 && classifyChanges(best.trip, c.trip).tradeoffs.every(r => LENGTH_KEYS.has(r.key)))) : null;
  const extraNight = extraC ? { token: extraC.token, total: extraC.total, nights: extraC.nights, delta: extraC.total - best.total } : null;
  // When nothing qualifies: the cheapest trip priced inside the rules (over the ceiling, or under it
  // but not one we would book), recorded so a later run can say what changed, and only then.
  let closest = null;
  if (!best) {
    const under = pool.filter(p => !p.ok).map(p => p.trip);
    const c = [...under, ...closestCands].sort((a, b) => a.total - b.total)[0];
    if (c) closest = { token: encodeSpec(c.spec), total: c.total, dest: c.dest.id, nights: c.spec.nights, over: Math.max(0, c.total - ceiling) };
  }
  // The customer's saved trip, priced now.
  let saved = null;
  if (hunt.savedToken) { const t = reprice(hunt.savedToken); if (t) saved = { token: hunt.savedToken, total: t.total, trip: t }; }

  // ---- what, if anything, is worth saying ------------------------------------------------------
  const prevBest = previous && previous.best && previous.best.token ? previous.best : null;
  const prevNow = prevBest ? reprice(prevBest.token) : null;
  const prevJ = prevNow ? judge(prevNow) : null;
  // The trip on record is gone when it can no longer be priced, or no longer passes the floor.
  const goneWhy = prevBest && (!prevNow ? `The ${fmt(prevBest.total)} trip I found before can no longer be priced` : !prevJ.ok ? `The ${fmt(prevBest.total)} trip I found before is ${prevNow.total > ceiling ? `now ${fmt(prevNow.total)}, over your limit` : 'no longer one I would book'}` : null);
  const remaining = c => hunt.budget - c.total;
  const headroom = c => [`${fmt(remaining(c))} under your ${fmt(hunt.budget)} limit`, ...(ceiling < hunt.budget ? [`${fmt(ceiling - c.total)} under the ${fmt(ceiling)} you asked me to beat`] : [])];
  const receiptFor = c => ({
    rules: ruleLines(hunt, { maps: inv.maps }),
    found: [
      `${fmt(c.total)} total, everything included`, `${plural(c.nights, 'night')} in ${c.trip.dest.name}`,
      c.stops === 0 ? `Nonstop, ${hours(c.trip.flight.durationMinutes)} each way` : `${plural(c.stops, 'stop')}, ${hours(c.trip.flight.durationMinutes)} each way`,
      `${c.stars}-star ${c.trip.hotel.name}${c.trip.hotel.features.allInclusive ? ', all-inclusive' : c.trip.hotel.features.breakfast ? ', breakfast included' : ''}`,
      bagsText(c.trip), ...(c.trip.transfer ? ['Airport transfer included'] : []), ...(c.trip.activities.length ? [`${plural(c.trip.activities.length, 'experience')} included`] : []),
    ],
    why: `This currently satisfies your trip rules and is ${fmt(remaining(c))} below your limit.`,
  });
  // The quality gate: a candidate that gives something up against the trip the customer already has
  // is not worth interrupting them for, unless they chose aggressive savings (then it is said).
  const gate = (c, allowKeys = new Set()) => {
    if (!prevNow) return { ok: true, tradeoffs: [] };
    const tradeoffs = classifyChanges(prevNow, c.trip).tradeoffs.filter(r => !allowKeys.has(r.key)).map(rowText);
    return { ok: !tradeoffs.length || aggressive, tradeoffs };
  };
  const previousCard = () => ({ ...huntCard(prevNow, prevBest.token), total: prevBest.total, totalNow: prevNow.total, recordedAt: previous.at || null });
  const found = {};
  const make = (kind, c, { prev = null, delta = null, why = [], tradeoffs = [], lead = null }) => {
    found[kind] = { kind, at, verifiedAt: at, trip: huntCard(c.trip, c.token), previous: prev, delta, why: [...why, ...(tradeoffs.length ? [`Gives up: ${joinAnd(tradeoffs)}`] : [])], tradeoffs, lead, receipt: receiptFor(c) };
  };
  const beats = (c, s) => {
    const ch = classifyChanges(s.trip, c.trip);
    if (ch.tradeoffs.length) return null;
    if (s.total - c.total >= minSaving) return { by: s.total - c.total, improvements: ch.improvements.map(rowText) };
    if (c.total <= s.total && ch.improvements.length) return { by: s.total - c.total, improvements: ch.improvements.map(rowText) };
    return null;
  };
  const beatWords = (b, s) => `Beats your saved trip (${fmt(s.total)} now): ${b.by > 0 ? `${fmt(b.by)} less` : 'the same money'} with nothing given up${b.improvements.length ? `; better: ${joinAnd(b.improvements)}` : ''}`;
  const silentReasons = [];

  if (!best) {
    let why = `nothing qualifies inside ${fmt(ceiling)} under your rules`;
    if (!windowDates(hunt, now).length) why = `no departure date in ${monthName(month)} is left to price`;
    else if (!considered) why = `nothing in the inventory matches your rules from ${inv.maps.getOrigin(origin).city}`;
    else if (closest) why += closest.over ? `; the cheapest trip inside your rules is ${fmt(closest.total)}, ${fmt(closest.over)} over` : `; the cheapest trip inside your rules is ${fmt(closest.total)}, but it is not one I would book`;
    if (goneWhy) why += `; ${goneWhy.charAt(0).toLowerCase()}${goneWhy.slice(1)}`;
    silentReasons.push(why);
  } else if (!prevBest || goneWhy) {
    // Nothing recorded to compare with (a first run), or the trip on record is gone.
    const breakthrough = previous && previous.closest && previous.closest.total > ceiling;
    const kind = breakthrough ? 'breakthrough' : 'found';
    const why = [...headroom(best), best.verdict.action];
    if (breakthrough) why.unshift(`Last time the cheapest trip inside your rules was ${fmt(previous.closest.total)}, ${fmt(previous.closest.total - ceiling)} over your limit`);
    if (goneWhy) why.unshift(goneWhy);
    if (challenger) why.push(`I first found it at ${fmt(challenger.from)}${challenger.from > ceiling ? ', over your limit' : ''}; ${challenger.why} gets it for ${fmt(challenger.to)}`);
    if (hunt.rules && hunt.rules.flightStops === 'nonstop' && hunt.rules.flightRule !== 'hard' && best.stops > 0) why.push(nonstop ? `You prefer nonstop: the cheapest nonstop trip inside your limit is ${fmt(nonstop.total)}` : 'You prefer nonstop: no nonstop trip fits your limit');
    const beat = saved ? beats(best, saved) : null;
    if (beat) why.push(`It beats your saved trip (${fmt(saved.total)} now) by ${fmt(beat.by)} with nothing given up${beat.improvements.length ? `; better: ${joinAnd(beat.improvements)}` : ''}`);
    if (!notifies(hunt, kind)) silentReasons.push(`the best trip is ${fmt(best.total)}; you did not ask to be told about trips under the limit`);
    else if (saved && saved.total <= ceiling && !beat && best.total >= saved.total && !goneWhy) silentReasons.push(`the best trip is ${fmt(best.total)}; your saved trip is already ${fmt(saved.total)} inside your limit, and this does not beat it`);
    else if (remaining(best) < T) silentReasons.push(`the best trip is ${fmt(best.total)}, ${fmt(remaining(best))} under your limit, under your ${fmt(T)} threshold`);
    else if (!fresh(kind, best)) silentReasons.push(`the best trip is ${fmt(best.total)}, which I already told you about`);
    else make(kind, best, { prev: breakthrough ? previous.closest : null, delta: breakthrough ? previous.closest.total - best.total : null, why, lead: goneWhy ? `${goneWhy}.` : null });
    // A different trip that beats the saved one when the best does not.
    if (saved && !beat && notifies(hunt, 'beat-saved')) {
      const c = strongest(qualifying.filter(x => beats(x, saved) && fresh('beat-saved', x)));
      if (c) make('beat-saved', c, { prev: huntCard(saved.trip, saved.token), delta: c.total - saved.total, why: [beatWords(beats(c, saved), saved), ...headroom(c)] });
    }
  } else {
    // The customer already has a trip on record: everything is judged against it.
    const same = prevBest.token;
    const prevWords = `the ${fmt(prevBest.total)} ${prevBest.nights || prevNow.spec.nights}-night ${prevNow.dest.name} trip I found before`;
    // Beat the saved trip: news only when the best now beats it and the trip on record did not, so
    // the same beat is never announced run after run.
    if (saved && notifies(hunt, 'beat-saved') && !beats({ trip: prevNow, total: prevBest.total }, saved)) {
      const b = fresh('beat-saved', best) ? beats(best, saved) : null;
      if (b) make('beat-saved', best, { prev: huntCard(saved.trip, saved.token), delta: best.total - saved.total, why: [beatWords(b, saved), ...headroom(best)] });
    }
    // A drop: the same trip priced lower now, or a trip that gives nothing up against it for less.
    const drops = [];
    if (prevJ.ok && !rejected.has(same) && prevBest.total - prevNow.total > 0) drops.push({ c: prevJ, saving: prevBest.total - prevNow.total, same: true, g: { ok: true, tradeoffs: [] } });
    for (const c of qualifying) if (c.token !== same && c.total < prevBest.total) drops.push({ c, saving: prevBest.total - c.total, same: false, g: gate(c) });
    const material = drops.filter(d => d.saving >= minSaving);
    const open = material.filter(d => d.g.ok && fresh('drop', d.c)).sort((a, b) => b.saving - a.saving || (b.same ? 1 : 0) - (a.same ? 1 : 0));
    if (open.length && !notifies(hunt, 'drop')) silentReasons.push(`a trip ${fmt(open[0].saving)} cheaper than ${prevWords} fits; you did not ask to be told about drops`);
    else if (open.length) {
      const d = open[0];
      const ch = d.same ? null : classifyChanges(prevNow, d.c.trip);
      make('drop', d.c, {
        prev: d.same ? prevBest : previousCard(), delta: d.saving, tradeoffs: d.g.tradeoffs,
        why: d.same
          ? [`The same trip, now ${fmt(d.c.total)}: ${fmt(d.saving)} less than the ${fmt(prevBest.total)} I recorded${previous.at ? ` on ${previous.at.slice(0, 10)}` : ''}`, ...headroom(d.c)]
          : [`${fmt(d.saving)} less than ${prevWords}${d.g.tradeoffs.length ? '' : ', with nothing given up'}`, ...[...ch.improvements, ...ch.neutral].map(rowText).slice(0, 4), ...headroom(d.c)],
      });
    } else if (material.some(d => !d.g.ok)) {
      const d = material.filter(d => !d.g.ok).sort((a, b) => b.saving - a.saving)[0];
      silentReasons.push(`a cheaper trip exists at ${fmt(d.c.total)} but gives something up: ${joinAnd(d.g.tradeoffs)}`);
    } else if (drops.length && !material.length) {
      const d = [...drops].sort((a, b) => b.saving - a.saving)[0];
      silentReasons.push(T ? `the saving is ${fmt(d.saving)}, under your ${fmt(T)} threshold` : `the saving is ${fmt(d.saving)}`);
    }
    // An extra night for (almost) the same money, nothing but the length changing.
    if (notifies(hunt, 'extra-night')) {
      const n = (prevBest.nights || prevNow.spec.nights) + 1;
      const cands = qualifying.filter(c => c.nights === n && c.total - prevBest.total <= EXTRA_NIGHT_CAP && fresh('extra-night', c)).map(c => ({ c, g: gate(c, LENGTH_KEYS) })).filter(x => x.g.ok);
      const x = cands.sort((a, b) => a.c.total - b.c.total || b.c.match - a.c.match)[0];
      if (x) make('extra-night', x.c, { prev: previousCard(), delta: x.c.total - prevBest.total, tradeoffs: x.g.tradeoffs, why: [`${plural(n, 'night')} instead of ${n - 1} for ${deltaPhrase(x.c.total - prevBest.total)} ${prevWords}`, ...classifyChanges(prevNow, x.c.trip).improvements.filter(r => !LENGTH_KEYS.has(r.key)).map(rowText).slice(0, 3), ...headroom(x.c)] });
    }
    // Same money, better hotel.
    if (notifies(hunt, 'quality')) {
      const cands = qualifying.filter(c => c.stars > prevNow.hotel.stars && c.total <= prevBest.total && fresh('quality', c)).map(c => ({ c, g: gate(c) })).filter(x => x.g.ok);
      const x = cands.sort((a, b) => b.c.stars - a.c.stars || b.c.match - a.c.match || a.c.total - b.c.total)[0];
      if (x) make('quality', x.c, { prev: previousCard(), delta: x.c.total - prevBest.total, tradeoffs: x.g.tradeoffs, why: [`A ${x.c.stars}-star hotel instead of ${prevNow.hotel.stars}-star for ${deltaPhrase(x.c.total - prevBest.total)} ${prevWords}`, ...classifyChanges(prevNow, x.c.trip).improvements.map(rowText).slice(0, 3), ...headroom(x.c)] });
    }
    // A nonstop option enters the budget: only for a customer who prefers nonstop (a hard rule already
    // filters), whose trip on record has a stop, and only when the previous run had no nonstop inside
    // the ceiling to record, so the same option is not announced run after run.
    if (notifies(hunt, 'nonstop') && hunt.rules && hunt.rules.flightStops === 'nonstop' && hunt.rules.flightRule === 'preferred' && prevNow.flight.stops > 0 && !previous.nonstop) {
      const cands = qualifying.filter(c => c.stops === 0 && fresh('nonstop', c)).map(c => ({ c, g: gate(c) })).filter(x => x.g.ok);
      const x = cands.sort((a, b) => a.c.total - b.c.total || b.c.match - a.c.match)[0];
      if (x) make('nonstop', x.c, { prev: previousCard(), delta: x.c.total - prevBest.total, tradeoffs: x.g.tradeoffs, why: [`Nonstop instead of ${plural(prevNow.flight.stops, 'stop')} for ${deltaPhrase(x.c.total - prevBest.total)} ${prevWords}`, NONSTOP_LINE, ...headroom(x.c)] });
    }
    // A destination unlocks: a real qualifying itinerary where the recorded run had none.
    if (notifies(hunt, 'destination') && Array.isArray(previous.byDest)) {
      const had = new Set(previous.byDest.map(d => d.dest));
      const cands = qualifying.filter(c => !had.has(c.dest) && fresh('destination', c)).map(c => ({ c, g: gate(c) })).filter(x => x.g.ok);
      const x = cands.sort((a, b) => a.c.total - b.c.total || b.c.match - a.c.match)[0];
      if (x) make('destination', x.c, { prev: previousCard(), delta: x.c.total - prevBest.total, tradeoffs: x.g.tradeoffs, why: [`Your ${fmt(hunt.budget)} just unlocked ${x.c.trip.dest.name}: ${plural(x.c.nights, 'night')} for ${fmt(x.c.total)}`, `Last time nothing in ${x.c.trip.dest.name} qualified`, ...headroom(x.c)] });
    }
    if (!Object.keys(found).length && !silentReasons.length) {
      if (best.token === same) silentReasons.push(best.total === prevBest.total ? `the best trip is unchanged at ${fmt(best.total)}` : best.total < prevBest.total ? `the saving is ${fmt(prevBest.total - best.total)}${T ? `, under your ${fmt(T)} threshold` : ''}` : `the trip I found is now ${fmt(best.total)}, ${fmt(best.total - prevBest.total)} more than the ${fmt(prevBest.total)} I recorded; nothing cheaper qualifies`);
      else silentReasons.push(`the best trip is now ${fmt(best.total)} in ${best.trip.dest.name}; it is not cheaper than ${prevWords} and nothing you asked to be told about changed`);
    }
  }

  const opportunities = KINDS.filter(k => found[k]).map(k => found[k]);
  const dates = windowDates(hunt, now);
  const airport = inv.maps.getOrigin(origin).airports[0].code;
  const negotiated = [
    dates.length ? `Departures: ${month ? `every day of ${monthName(month)} from ${dates[0]}` : `every second day from ${dates[0]} to ${dates[dates.length - 1]}`} asked for fares; the two cheapest dates per destination and length priced in full` : `Departures: none left to price in ${monthName(month)}`,
    `Lengths: ${lengths.length > 1 ? `${lengths[0]} to ${lengths[lengths.length - 1]} nights` : plural(lengths[0], 'night')}`,
    `Hotels: every hotel inside your rules${rules && rules.minStars ? ` (${rules.minStars}-star or better)` : ''}`,
    `Fares: every fare inside your rules${bags === 'carry-on' ? ' with a carry-on (fares with a personal item only were left out; the inventory has no carry-on fee to add)' : bags === 'checked' ? ', a checked bag added to fares that do not include one' : ''}`,
    `Airport: ${airport} only`,
    best && (!challenger || !nearMiss) ? `Then the best trip priced again up to three days either way${month ? ` inside ${monthName(month)}` : ''} and in every cheaper version with nothing given up${challenger ? `: ${fmt(challenger.from)} became ${fmt(challenger.to)}` : ': nothing cheaper without a compromise'}`
      : nearMiss ? `Nothing fit ${fmt(ceiling)}, so the strongest trips just over it (${fmt(nearMiss.total)} first) were priced again up to three days either way${month ? ` inside ${monthName(month)}` : ''} and in every cheaper version with nothing given up${challenger ? `: ${fmt(challenger.from)} became ${fmt(challenger.to)}` : ': none came under it'}`
        : 'No trip near the ceiling to price again',
  ];
  return {
    at, ceiling,
    checked: { destinations: dests.size, considered, eligible, qualifying: qualifying.length, nightsTried: lengths, versions, negotiated },
    best: best ? { token: best.token, total: best.total, trip: best.trip, nights: best.nights, stops: best.stops, stars: best.stars, dest: best.dest, grade: best.grade } : null,
    closest, challenger, byDest, nonstop, extraNight, saved, opportunities,
    silent: opportunities.length ? null : silentReasons.join('; ') || 'nothing you asked to be told about changed',
  };
}

// ---- the notification -----------------------------------------------------------------------------
// The sentence block for the email and the page: what, the total, the limit, the rule facts, what
// remains, that it currently meets the rules, and when the price was verified. Every number is the
// opportunity's own; nothing here says a search happened that did not, and nothing is urgent.
function decisionText(o, hunt) {
  const t = o.trip, p = o.previous || null, r = hunt.rules || {};
  const ceiling = ceilingOf(hunt);
  const trip = `${t.nights}-night ${t.dest} trip`;
  const same = o.kind === 'drop' && p && p.token === t.token;
  let lead;
  switch (p ? o.kind : 'found') {
    case 'breakthrough': lead = `A ${trip} now fits: ${fmt(t.total)} total. Last time the cheapest trip inside your rules was ${fmt(p.total)}, over your limit.`; break;
    case 'drop': lead = same ? `The ${trip} I found is now ${fmt(t.total)} total, ${fmt(o.delta)} less than the ${fmt(p.total)} I recorded.`
      : `A ${trip} is ${fmt(t.total)} total, ${fmt(o.delta)} less than the ${fmt(p.total)} trip I found before${o.tradeoffs && o.tradeoffs.length ? '' : ', with nothing given up'}.`; break;
    case 'extra-night': lead = `${plural(t.nights, 'night')} in ${t.dest} for ${fmt(t.total)} total, ${deltaPhrase(o.delta)} the ${p && p.nights ? `${p.nights}-night ` : ''}trip I found.`; break;
    case 'quality': lead = `A ${t.hotel.stars}-star hotel in ${t.dest} for ${fmt(t.total)} total, ${deltaPhrase(o.delta)} the ${p && p.hotel ? `${p.hotel.stars}-star ` : ''}trip I found.`; break;
    case 'nonstop': lead = `A nonstop ${t.dest} trip fits: ${fmt(t.total)} total, ${deltaPhrase(o.delta)} the ${p && Number.isFinite(p.stops) ? `${plural(p.stops, 'stop')} ` : ''}trip I found. ${NONSTOP_LINE}`; break;
    case 'destination': lead = `Your ${fmt(hunt.budget)} just unlocked ${t.dest}: ${plural(t.nights, 'night')} for ${fmt(t.total)} total.`; break;
    case 'beat-saved': lead = `A ${trip} beats your saved trip: ${fmt(t.total)} total against ${fmt(p.total)}${o.tradeoffs && o.tradeoffs.length ? '' : ', with nothing given up'}.`; break;
    default: lead = `I found a ${trip} for ${fmt(t.total)} total.`;
  }
  const parts = [...(o.lead ? [o.lead] : []), lead, `Your limit is ${fmt(hunt.budget)}.${ceiling < hunt.budget ? ` You asked me to beat ${fmt(ceiling)}.` : ''}`];
  parts.push(t.stops === 0 ? 'Nonstop.' : `${plural(t.stops, 'stop')} each way.`);
  const stars = Math.max(r.minStars || 0, (hunt.floors && hunt.floors.minStars) || 0);
  parts.push(stars && t.hotel.stars >= stars ? `${t.hotel.stars}-star hotel, meets your ${stars}-star minimum.` : `${t.hotel.stars}-star hotel.`);
  if (r.meals === 'all-inclusive' && t.hotel.allInclusive) parts.push('All-inclusive.');
  else if (r.meals === 'breakfast' && (t.hotel.breakfast || t.hotel.allInclusive)) parts.push('Breakfast included.');
  parts.push(`${fmt(hunt.budget - t.total)} remains.`, MEETS);
  if (o.tradeoffs && o.tradeoffs.length) parts.push(`Against the trip I found before it gives up ${joinAnd(o.tradeoffs)}.`);
  parts.push(`Current price was verified at ${stampOf(o.verifiedAt)}. ${MAY_CHANGE}`);
  return parts.join(' ');
}

module.exports = { huntQuery, runHunt, huntCard, decisionText, ruleLines, ceilingOf, thresholdOf, nightsRange, THRESHOLDS, KINDS, NOTIFY_KINDS, EXTRA_NIGHT_CAP, NONSTOP_LINE };
