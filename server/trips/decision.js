// The travel decision layer: everything that helps a traveler *decide*, built only from facts the
// engine already has. Nothing here invents data: verdicts come from the score and the trade-offs,
// usable vacation time from the flight schedule, budget unlocks from real re-priced changes, and
// "make it better" from enumerating and pricing every alternative package for the same trip. The
// platform's margin is never an input (the internal economics aren't passed in anywhere here).
const { addDays, today } = require('../lib/dates');
const { priceTrip } = require('./pricing');
const { scoreTrip, memoInventory, activitySets, hotelAllowed } = require('./optimizer');
// The fact-only comparison helpers live in facts.js (shared with the optimizer); re-exported here so
// every page keeps requiring them from the decision layer.
const { usableTime, classifyChanges, tripDiff, clock, hoursLabel } = require('./facts');

const { format } = require('../lib/money');
const fmt = cents => format(cents, 'USD');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// "Get my day back": other flights on this trip that add usable time, with their real price difference.
function timeAlternatives(t, options) {
  const base = usableTime(t);
  if (!base) return [];
  return options.flights.filter(f => f.flight.id !== t.spec.flight).map(f => {
    const u = usableTime({ ...t, flight: f.flight });
    return u ? { flight: f.flight, delta: f.delta, total: f.total, gain: u.usableMinutes - base.usableMinutes, time: u } : null;
  }).filter(x => x && x.gain >= 60).sort((a, b) => b.gain - a.gain || a.delta - b.delta);
}

// ---- the verdict -----------------------------------------------------------------------------
// Compromises weighted by how much they matter for what the traveler told us. Weight 3 means it
// contradicts an answer they gave; 2 is a real downside; 1 is worth knowing.
function compromises(t, ctx = {}, time = usableTime(t)) {
  const style = ctx.style || 'surprise', prio = ctx.priority || 'price';
  const out = [];
  if (ctx.nightsAsked && t.spec.nights < ctx.nightsAsked) out.push({ w: 3, text: `${plural(ctx.nightsAsked - t.spec.nights, 'night')} shorter than you asked for` });
  if (style === 'all-inclusive' && !t.hotel.features.allInclusive) out.push({ w: 3, text: 'not an all-inclusive resort' });
  else if (style !== 'surprise' && style !== 'all-inclusive' && !t.dest.styles.includes(style)) out.push({ w: 3, text: `not really a ${style === 'city' ? 'city-break' : style} destination (${t.dest.name})` });
  if (prio === 'hotel' && t.hotel.stars <= 3) out.push({ w: 2, text: `a ${t.hotel.stars}-star hotel, when the hotel mattered most to you` });
  else if (t.hotel.stars <= 2) out.push({ w: 2, text: `a ${t.hotel.stars}-star hotel` });
  else if (t.hotel.stars === 3) out.push({ w: 1, text: 'a 3-star hotel' });
  if (prio === 'flights' && t.flight.stops > 0) out.push({ w: 2, text: `${t.flight.stops}-stop flights, when flights mattered most to you` });
  else if (t.flight.stops > 0 && t.flight.durationMinutes >= 8 * 60) out.push({ w: 1, text: `long ${t.flight.stops}-stop flights (${Math.round(t.flight.durationMinutes / 60)}h each way)` });
  if (t.flight.id === 'basic') out.push({ w: 2, text: 'a Basic fare: personal item only, no changes' });
  if (!t.hotel.features.beachfront && t.dest.styles.includes('beach') && ['beach', 'romantic', 'all-inclusive'].includes(style)) out.push({ w: 2, text: `not on the beach (${t.hotel.area})` });
  if (time) for (const fl of time.flags) out.push({ w: fl.kind === 'early-return' ? 2 : 1, text: fl.kind === 'early-return' ? `a ${time.lastDay.leaveHotel} hotel departure on your last day` : fl.kind === 'overnight' ? `an overnight flight (you land at ${time.firstDay.arrive} the next day)` : fl.kind === 'late-arrival' ? `a late arrival (${time.firstDay.arrive}) that uses up the first day` : `a short last day (you leave the hotel at ${time.lastDay.leaveHotel})` });
  if (!t.hotel.refundable) out.push({ w: 1, text: 'a non-refundable hotel rate' });
  if (!t.hotel.features.breakfast && !t.hotel.features.allInclusive) out.push({ w: 0.5, text: 'no breakfast included' });
  return out.sort((a, b) => b.w - a.w);
}

// The single best thing about this trip for this traveler.
function biggestWin(t, ctx = {}) {
  const budget = ctx.budget, prio = ctx.priority || 'price', style = ctx.style || 'surprise';
  const diff = budget ? budget - t.total : null;
  if (prio === 'hotel' && t.hotel.stars >= 4) return `a ${t.hotel.stars}-star hotel rated ${t.hotel.rating}/5, which is what you said mattered most`;
  if (prio === 'flights' && t.flight.stops === 0) return 'nonstop flights, which is what you said mattered most';
  if (prio === 'longer' && ctx.nightsAsked && t.spec.nights > ctx.nightsAsked) return `${plural(t.spec.nights - ctx.nightsAsked, 'extra night')} over what you asked for`;
  if (prio === 'activities' && t.activities.length >= 2) return `${plural(t.activities.length, 'experience')} already in the price`;
  if (prio === 'price' && diff !== null && diff >= budget * 0.15) return `${fmt(diff)} of your budget left over`;
  if (t.hotel.features.beachfront && ['beach', 'romantic', 'surprise', 'all-inclusive', 'family'].includes(style) && t.dest.styles.includes('beach')) return `a beachfront ${t.hotel.stars}-star hotel`;
  if (t.hotel.features.allInclusive) return 'meals and drinks included at the resort';
  if (t.typical > t.total * 1.1) return `a price about ${Math.round((1 - t.total / t.typical) * 100)}% below typical for these parts${t.demo ? ' (demo price history)' : ''}`;
  if (diff !== null && diff >= budget * 0.1) return `${fmt(diff)} of your budget left over`;
  if (t.flight.stops === 0) return `nonstop flights and a ${t.hotel.stars}-star hotel`;
  return `a ${t.hotel.stars}-star hotel rated ${t.hotel.rating}/5, every fee in the price`;
}

const GRADES = {
  great: { label: 'Great fit', tone: 'good' },
  good: { label: 'Good fit', tone: 'good' },
  budget: { label: 'Budget fit', tone: 'warn' },
  look: { label: 'We’d keep looking', tone: 'bad' },
};

// What we'd actually do with this trip, said plainly. Transparent rules, no scarcity, no pressure.
function verdict(t, ctx = {}, scores = scoreTrip(t, ctx)) {
  const budget = ctx.budget;
  const diff = budget ? budget - t.total : null;
  const time = usableTime(t);
  const cons = compromises(t, ctx, time);
  const win = biggestWin(t, ctx);
  const heavy = cons.filter(c => c.w >= 2);
  const top = cons[0] || null;
  let grade, action;
  if (diff !== null && diff < 0) {
    grade = 'look';
    action = ctx.allowOver
      ? `You allowed up to 10% more, so it’s your call: we’d only book it if ${win} is worth the extra ${fmt(-diff)}.`
      : `It’s ${fmt(-diff)} over the ${fmt(budget)} you set. We don’t call that within budget; see what gets it back under.`;
  } else if (cons.some(c => c.w >= 3)) {
    grade = 'budget';
    action = `It fits the money, but it’s ${top.text}. We’d book it only if that’s fine with you.`;
  } else if (scores.match >= 78 && heavy.length === 0) {
    grade = 'great';
    action = top ? `We’d book it. The only thing to know: ${top.text}.` : 'We’d book it.';
  } else if ((scores.match >= 66 && heavy.length <= 1) || !top) {
    grade = 'good';
    action = heavy.length ? `We’d book it, knowing it means ${heavy[0].text}.` : `We’d book it.${top ? ` Worth knowing: ${top.text}.` : ''}`;
  } else {
    grade = 'budget';
    action = `It fits the money, but it means ${heavy.slice(0, 2).map(c => c.text).join(' and ') || top.text}. We’d see what a little more buys before booking.`;
  }
  return { grade, ...GRADES[grade], win, compromise: top ? top.text : null, compromises: cons, action, match: scores.match, diff };
}

// ---- budget unlocks ---------------------------------------------------------------------------
// "What does another $100 get me?" from real re-priced single changes (see views/trips/trip.js
// singleChanges). One step per kind of change, cheapest first; `within` are the ones the remaining
// budget already covers. When nothing within budget is a real improvement we say so.
const KIND_RANK = { hotel: 0, flight: 1, nights: 2, transfer: 3, activity: 4, bags: 5, dates: 6 };
function budgetUnlocks(changes, diff) {
  const ups = changes.filter(c => c.delta > 0 && c.better).sort((a, b) => a.delta - b.delta || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  const steps = [];
  const seen = new Set();
  for (const c of ups) {
    if (seen.has(c.kind)) continue;
    seen.add(c.kind);
    steps.push({ ...c, within: diff !== null && c.delta <= diff });
    if (steps.length === 4) break;
  }
  return { steps, within: steps.filter(s => s.within), keep: diff !== null && diff > 0 && !steps.some(s => s.within) };
}

// ---- make it better / optimize around what's locked ------------------------------------------
// Enumerate every alternative package for this trip (hotel × flight × experiences × transfer, and
// nearby dates and lengths unless the dates are locked), price each in full, and return the one
// that scores highest for this traveler at or under `cap`. Returns null when nothing beats the
// current trip, which the pages say honestly instead of showing a lateral change.
// "Better" is judged on the trip itself, with the budget taken out of the score: a package that only
// scores higher because it is cheaper is "make it cheaper", which the customizer already offers. A
// proposal must improve at least one thing, must not earn a worse verdict than the trip it replaces,
// and must not add a compromise that contradicts an answer the traveler gave.
const GRADE_RANK = { look: 0, budget: 1, good: 2, great: 3 };
function optimizeAround(inventory, t, settings, ctx = {}, { locks = {}, cap = t.total, now = new Date() } = {}) {
  const inv = memoInventory(inventory);
  const s = t.spec;
  const qctx = { ...ctx, budget: null, allowOver: 0 };
  const base = scoreTrip(t, qctx);
  const baseGrade = GRADE_RANK[verdict(t, qctx, base).grade];
  const baseHard = compromises(t, ctx).filter(c => c.w >= 3).length;
  const hotels = locks.hotel ? [s.hotel] : t.hotelOptions.filter(h => hotelAllowed(h, { who: s.who, style: ctx.style })).map(h => h.id);
  const flights = locks.flight ? [s.flight] : t.flightOptions.map(f => f.id);
  const earliest = addDays(today(now), 3);
  const dates = locks.dates ? [s.depart] : [s.depart, ...[-2, -1, 1, 2].map(o => addDays(s.depart, o)).filter(d => d >= earliest)];
  const nightsList = locks.dates ? [s.nights] : [s.nights, s.nights + 1].filter(n => n <= 14); // never shorter: that is "make it cheaper", not "better"
  const sets = [s.activities, ...activitySets(t.activityOptions, ctx.style || 'surprise')];
  const seen = new Set();
  let best = null;
  for (const depart of dates) for (const nights of nightsList) for (const hotel of hotels) for (const flight of flights) for (const activities of sets) for (const transfer of [s.transfer, !s.transfer]) {
    const spec = { ...s, depart, nights, hotel, flight, activities: [...activities].sort(), transfer };
    const key = JSON.stringify(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === JSON.stringify({ ...s, activities: [...s.activities].sort() })) continue;
    const p = priceTrip(inv, spec, settings);
    if (!p || p.total > cap) continue;
    const sc = scoreTrip(p, qctx);
    if (sc.match <= base.match) continue;
    if (best && (sc.match < best.match || (sc.match === best.match && p.total >= best.trip.total))) continue;
    const changes = classifyChanges(t, p);
    if (!changes.improvements.length) continue;
    if (GRADE_RANK[verdict(p, qctx, sc).grade] < baseGrade) continue;
    if (compromises(p, ctx).filter(c => c.w >= 3).length > baseHard) continue;
    best = { trip: p, ...sc, changes };
  }
  if (!best) return null;
  return { trip: best.trip, match: best.match, baseMatch: base.match, delta: best.trip.total - t.total, improvements: best.changes.improvements, tradeoffs: best.changes.tradeoffs, changes: best.changes.neutral };
}

// ---- name your price -------------------------------------------------------------------------
// "I'd love to pay $1,200 for this trip." We enumerate every cheaper version of the same trip (hotels,
// flights, nearby dates, fewer nights, fewer experiences, no transfer, no bags), price each in full,
// and search downward: the answer is the cheapest version that is still a strong trip for what the
// traveler told us. Every number here is a priced package; nothing is widened above the current
// total and no saving is ever estimated. A version that reaches the price with real compromises is
// still shown (the "show me anyway" option) with those compromises listed: valid inventory is never
// hidden, it is just not what we would book.
const RUNG_LABELS = { strong: 'Strong', compromise: 'Some compromise', major: 'Major compromise' };
const RUNG_RANK = { strong: 0, compromise: 1, major: 2 };
// A rung is "strong" when it is a great or good trip on its own, or when it is no step down from the
// trip the traveler already has (same verdict, nothing new they said matters). "Major" means a new
// compromise that contradicts an answer they gave, or three or more things given up at once.
function rungLabel(v, changes, base) {
  const fresh = w => v.compromises.filter(c => c.w >= w && !base.texts.has(c.text));
  if (fresh(3).length || changes.tradeoffs.length >= 3) return 'major';
  if (v.grade === 'great' || v.grade === 'good') return 'strong';
  return GRADE_RANK[v.grade] >= GRADE_RANK[base.grade] && !fresh(2).length ? 'strong' : 'compromise';
}
const changeText = r => `${r.label}: ${r.b}`;

function nameYourPrice(inventory, t, settings, ctx = {}, target, { now = new Date() } = {}) {
  const inv = memoInventory(inventory);
  const s = t.spec;
  const qctx = { ...ctx, budget: null, allowOver: 0 };
  const hotels = t.hotelOptions.filter(h => hotelAllowed(h, { who: s.who, style: ctx.style })).map(h => h.id);
  if (!hotels.includes(s.hotel)) hotels.push(s.hotel);
  const flights = t.flightOptions.map(f => f.id);
  const earliest = addDays(today(now), 3);
  const dates = [s.depart, ...[-3, -2, -1, 1, 2, 3].map(o => addDays(s.depart, o)).filter(d => d >= earliest)];
  const nightsList = [];
  for (let n = s.nights; n >= Math.max(2, s.nights - 2); n--) nightsList.push(n);
  const sets = [s.activities, [], ...activitySets(t.activityOptions, ctx.style || 'surprise')];
  const transfers = s.transfer ? [true, false] : [false];
  const bagsList = s.bags ? [true, false] : [s.bags];
  const currentV = verdict(t, qctx);
  const base = { grade: currentV.grade, texts: new Set(currentV.compromises.map(c => c.text)) };
  const currentKey = JSON.stringify({ ...s, activities: [...s.activities].sort() });
  const seen = new Set([currentKey]);
  const candidates = [];
  for (const depart of dates) for (const nights of nightsList) for (const hotel of hotels) for (const flight of flights) for (const activities of sets) for (const transfer of transfers) for (const bags of bagsList) {
    const spec = { ...s, depart, nights, hotel, flight, activities: [...activities].sort(), transfer, bags };
    const key = JSON.stringify(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    const p = priceTrip(inv, spec, settings);
    if (!p || p.total > t.total) continue;
    const v = verdict(p, qctx);
    const changes = classifyChanges(t, p);
    const label = rungLabel(v, changes, base);
    candidates.push({ trip: p, total: p.total, match: v.match, grade: v.grade, label, labelText: RUNG_LABELS[label], compromises: v.compromises, changes, delta: p.total - t.total });
  }
  // Quality order: label first, then match. A version is "better" than another when it has a better
  // label, or the same label with a higher match.
  const better = (a, b) => (RUNG_RANK[a.label] !== RUNG_RANK[b.label] ? RUNG_RANK[a.label] < RUNG_RANK[b.label] : a.match > b.match);
  const byPriceThenQuality = (a, b) => a.total - b.total || RUNG_RANK[a.label] - RUNG_RANK[b.label] || b.match - a.match;
  candidates.sort(byPriceThenQuality);
  // The value ladder is the set of versions where paying less costs you something: walking up in
  // price, a candidate earns a rung only when it is better than every cheaper candidate. A version
  // that costs more than a cheaper one of the same or better quality is simply a worse deal and is
  // never shown, so the ladder reads Strong, Strong, Some compromise, Major compromise as it goes down.
  const frontier = [];
  for (const c of candidates) if (!frontier.length || better(c, frontier[frontier.length - 1])) frontier.push(c);
  const strong = candidates.filter(c => c.label === 'strong');
  const cheapestStrongUnder = strong.find(c => c.total <= target) || null;
  // Within $20 of the cheapest strong version under the price, the one that changes the least.
  const recommended = cheapestStrongUnder
    ? strong.filter(c => c.total <= cheapestStrongUnder.total + 2000).sort((a, b) => a.changes.tradeoffs.length - b.changes.tradeoffs.length || a.total - b.total)[0]
    : null;
  const floor = strong[0] || null;
  // The best version at or under the price when none is strong: shown with its compromises, never hidden.
  const underTarget = frontier.filter(c => c.total <= target);
  const anyway = recommended ? null : underTarget[underTarget.length - 1] || null;
  const cheapest = candidates[0] || null;
  const currentLabel = rungLabel(currentV, { tradeoffs: [] }, base);

  const rungs = [...frontier].reverse(); // dearest first
  if (recommended && !rungs.includes(recommended)) { rungs.push(recommended); rungs.sort((a, b) => b.total - a.total); }
  const cliffRung = rungs.find(c => c.label !== 'strong' && (!floor || c.total < floor.total)) || null;
  // At most six rungs under the current trip: the ones that matter always stay, the rest are sampled evenly.
  let picked = rungs;
  if (rungs.length > 6) {
    const keep = new Set([recommended, floor, anyway, cheapest, cliffRung, rungs[0]].filter(Boolean));
    const room = 6 - keep.size;
    const rest = rungs.filter(c => !keep.has(c));
    const step = rest.length / (room + 1);
    for (let i = 1; i <= room && rest.length; i++) keep.add(rest[Math.min(rest.length - 1, Math.round(i * step) - 1)]);
    picked = rungs.filter(c => keep.has(c));
  }
  // Each rung's note is the biggest new compromise (first trade-off), or else the first plain difference.
  const rung = c => {
    const row = c.changes.tradeoffs[0] || c.changes.neutral[0] || c.changes.improvements[0] || null;
    const noteKind = c.changes.tradeoffs[0] ? 'tradeoff' : c.changes.neutral[0] ? 'neutral' : c.changes.improvements[0] ? 'improvement' : null;
    return { total: c.total, label: c.label, labelText: RUNG_LABELS[c.label], trip: c.trip, match: c.match, delta: c.delta, cliff: c === cliffRung, current: false, note: row ? changeText(row) : null, noteRow: row, noteKind };
  };
  const ladder = [
    { total: t.total, label: currentLabel, labelText: RUNG_LABELS[currentLabel], trip: t, match: currentV.match, delta: 0, cliff: false, current: true, note: null, noteRow: null, noteKind: null },
    ...picked.map(rung),
  ];
  return { target, current: t.total, currentLabel, recommended, floor, anyway, ladder, cheapest, considered: candidates.length, labels: RUNG_LABELS };
}

// ---- money + time: weekdays as a second budget ------------------------------------------------
// Days away counted Monday to Friday, from the departure date to the return date inclusive. We do
// not know the traveler's holidays, employer or school calendar, so this is a plain weekday count
// and the page says so.
function weekdaysAway(depart, nights) {
  let n = 0;
  for (let i = 0; i <= nights; i++) {
    const day = new Date(`${addDays(depart, i)}T00:00:00Z`).getUTCDay();
    if (day >= 1 && day <= 5) n++;
  }
  return n;
}

// "Keep a PTO day": the same trip on a nearby date that uses fewer weekdays, with its real re-priced
// difference (from the customizer's nearby dates). Only ever fewer weekdays, same length.
function ptoAlternatives(t, options) {
  const base = weekdaysAway(t.spec.depart, t.spec.nights);
  return options.dates
    .map(d => ({ depart: d.depart, weekdays: weekdaysAway(d.depart, t.spec.nights), delta: d.delta, total: d.total }))
    .filter(a => a.weekdays < base)
    .map(a => ({ ...a, saves: base - a.weekdays }))
    .sort((a, b) => b.saves - a.saves || a.delta - b.delta)
    .slice(0, 4);
}

// ---- your trip, step by step ------------------------------------------------------------------
// A walk through the trip in order, for first-time travelers and nervous flyers. Each step is built
// from this trip's facts. A line we cannot know from the booking is marked "check" (confirm it on
// the itinerary, voucher or boarding pass); general advice is marked "info" and is never a promise.
// No fear, no upsell: nothing here sells anything, and nothing guesses an entry requirement.
function tripGuide(t, { origin } = {}) {
  const f = t.flight, h = t.hotel, s = t.spec;
  const time = usableTime(t);
  const hasTimes = Number.isFinite(f.departMinutes) && Number.isFinite(f.arriveMinutes) && Number.isFinite(f.returnDepartMinutes);
  const from = origin ? `${origin.name} (${origin.code})` : s.from;
  const steps = [];
  const step = (key, title, status, lines) => steps.push({ key, title, status, lines: lines.filter(Boolean) });

  step('before', 'Before you leave', t.internationalTrip ? 'check' : 'ready', [
    t.internationalTrip
      ? { status: 'check', text: `${t.dest.country} is an international destination: every traveler needs a valid passport, and entry rules depend on nationality. Check the official requirements for your passport before you go. We can’t guarantee entry to any country.` }
      : { status: 'ready', text: 'A domestic trip: a government-issued photo ID is enough for US travelers. Keep it with you from the airport to the hotel.' },
    { status: 'info', text: `Most airlines open online check-in 24 hours before departure; ${f.airline} will say exactly when. Checking in early is general advice, not a rule of this fare.` },
    { status: 'ready', text: `Your confirmation carries a Trip ID and a confirmation number for each part (flights, hotel${t.activities.length ? ', experiences' : ''}${t.transfer ? ', transfer' : ''}). Keep it on your phone and, if you like, on paper.` },
  ]);

  step('airport', 'At the airport', 'info', [
    { status: 'info', text: `Arrive about ${t.internationalTrip ? '3 hours' : '2 hours'} before your flight. That is general guidance for ${t.internationalTrip ? 'international' : 'domestic'} flights, not a promise about ${origin ? origin.name : 'your airport'} on the day.` },
    { status: 'check', text: 'Terminal and gate: on your boarding pass and the airport screens. They can change on the day, so check the screens once you are inside.' },
    { status: 'ready', text: `You are flying ${f.airline}, ${f.name} fare, from ${from} to ${t.dest.airport}.` },
  ]);

  step('bags', 'Bags', f.checkedBagIncluded || s.bags || f.carryOn ? 'ready' : 'check', [
    { status: 'ready', text: f.checkedBagIncluded || s.bags
      ? 'One checked bag per traveler each way is in your price: drop it at the airline desk or bag drop after check-in.'
      : `${f.carryOn ? 'One carry-on bag' : 'One personal item only (no carry-on)'} per traveler on this fare. Checked bags are not in your price; they cost ${fmt(f.bagFeePerTraveler)} per traveler both ways if you add them on the trip page.` },
    { status: 'info', text: 'Liquids in a carry-on go through security in containers of 100 ml (3.4 oz) or less, together in one clear bag. That is the standard rule at US airports; the airport’s own page has the details.' },
  ]);

  step('boarding', 'Security and boarding', hasTimes ? 'ready' : 'check', [
    { status: 'info', text: 'Security: ID and boarding pass ready, laptops and liquids out if asked. Lines vary by airport and hour; we have no reliable way to predict them.' },
    hasTimes
      ? { status: 'ready', text: `Your flight departs at ${clock(f.departMinutes)}. Boarding starts before that and the gate usually closes 10 to 15 minutes before departure. The boarding pass shows the boarding time, and boarding time is not departure time.` }
      : { status: 'check', text: 'Departure and boarding times: on your itinerary and boarding pass. Boarding time is not departure time.' },
    { status: 'ready', text: f.seatSelection ? 'Seat selection is available on this fare.' : 'Seats are assigned at check-in on this fare; ask at the desk if you want to sit together.' },
  ]);

  if (f.stops > 0) step('connection', 'Your connection', 'check', [
    { status: 'ready', text: `Your flight has ${plural(f.stops, 'stop')}: about ${Math.round(f.durationMinutes / 60)} hours each way in total.` },
    { status: 'check', text: 'The connecting airport and the time between flights are on your itinerary after booking. On a single ticket the airline normally moves you to a later flight if the first one runs late, and your bags normally transfer on their own; confirm both at check-in.' },
    { status: 'info', text: 'At the connection: follow the signs for connecting flights, find your next gate on the screens, and only leave the secure area if your itinerary says you must.' },
  ]);
  else step('connection', 'No connection', 'ready', [{ status: 'ready', text: 'Nonstop: you board once and get off at your destination.' }]);

  step('arrival', 'Arrival', t.transfer ? 'ready' : 'check', [
    hasTimes && time
      ? { status: 'ready', text: `You land at ${clock(f.arriveMinutes)}${f.arrivesNextDay ? ' the next day' : ''} and should be at the hotel around ${time.firstDay.settled}.` }
      : { status: 'check', text: 'Arrival time: on your itinerary.' },
    t.internationalTrip
      ? { status: 'info', text: 'Passport control and customs come before the arrivals hall. Have your passport and the hotel’s name and address (below) ready.' }
      : { status: 'info', text: 'Follow the signs to baggage claim, then to the exit.' },
    t.transfer
      ? { status: 'ready', text: `A private transfer is in your price (${t.transfer.vehicles} vehicle${t.transfer.vehicles > 1 ? 's' : ''}, ${t.transfer.supplier}): the driver meets you in arrivals and brings you back for the return flight. Meeting instructions come with your confirmation.` }
      : { status: 'check', text: 'No transfer is in your price. Taxis, rideshares and shuttles run from the airport; the fare to the hotel is not something we can quote here (needs verification). A private transfer can be added on the trip page so it is in your total.' },
  ]);

  step('hotel', 'Your hotel', 'ready', [
    { status: 'ready', text: `${h.name}, ${h.area}, ${t.dest.name}. ${plural(s.nights, 'night')}${h.features.allInclusive ? ', all-inclusive' : h.features.breakfast ? ', breakfast included' : ''}.` },
    { status: 'check', text: 'Check-in is from 3:00 PM and check-out by 11:00 AM at most hotels; your voucher has this hotel’s exact times. Arriving early? Hotels usually hold bags until the room is ready.' },
    h.resortFeePerNight
      ? { status: 'ready', text: `The resort fee (${fmt(h.resortFeePerNight)} per room per night) is already in your total; you won’t pay it at the desk. Incidentals like the minibar are extra.` }
      : { status: 'ready', text: 'No mandatory hotel fees. Incidentals like the minibar or parking are extra.' },
  ]);

  if (t.activities.length) step('during', 'Your experiences', 'check', t.activities.map(a => ({ status: 'check', text: `${a.name} (${a.hours}h, ${a.supplier}): the meeting point and start time are on the voucher that comes with your confirmation.` })));

  step('home', 'Going home', hasTimes ? 'ready' : 'check', [
    hasTimes && time
      ? { status: 'ready', text: `Your flight home leaves at ${clock(f.returnDepartMinutes)}. Leave the hotel around ${time.lastDay.leaveHotel}${t.internationalTrip ? ' (three hours before, for an international flight)' : ''}.` }
      : { status: 'check', text: 'Return flight time: on your itinerary. Plan to be at the airport two to three hours before it.' },
    { status: 'info', text: 'Check out, settle any incidentals, and keep your ID or passport where you can reach it. Online check-in for the flight home opens the day before, just like the way out.' },
  ]);

  const counts = { ready: 0, check: 0, info: 0 };
  for (const st of steps) for (const l of st.lines) counts[l.status]++;
  return { steps, counts };
}

// ---- the reality check before paying ----------------------------------------------------------
// Each row is a fact with a status: ok (nothing to do), heads-up (good to know, in the price or
// the schedule) or verify (only the traveler can check it, e.g. passport validity).
function realityCheck(t, { weather } = {}) {
  const time = usableTime(t);
  const rows = [];
  rows.push(t.internationalTrip
    ? { status: 'verify', label: 'Travel documents', text: `${t.dest.country} needs a valid passport for every traveler, and entry rules depend on nationality. Check the official requirements before paying; we can’t guarantee entry.` }
    : { status: 'ok', label: 'Travel documents', text: 'Domestic trip: a government-issued photo ID is enough for US travelers.' });
  if (time) {
    rows.push({ status: time.flags.some(f => f.kind === 'overnight' || f.kind === 'late-arrival') ? 'heads-up' : 'ok', label: 'Arrival day', text: time.flags.find(f => f.kind === 'overnight' || f.kind === 'late-arrival')?.text || `You land at ${time.firstDay.arrive} and should be at the hotel around ${time.firstDay.settled}: about ${time.firstDay.label} of your first day to enjoy.` });
    rows.push({ status: time.flags.some(f => f.kind === 'early-return' || f.kind === 'short-last-day') ? 'heads-up' : 'ok', label: 'Last day', text: time.flags.find(f => f.kind === 'early-return' || f.kind === 'short-last-day')?.text || `Your flight home leaves at ${time.lastDay.depart}; leave the hotel around ${time.lastDay.leaveHotel}, so you still have about ${time.lastDay.label} that day.` });
  }
  rows.push(t.flight.checkedBagIncluded || t.spec.bags
    ? { status: 'ok', label: 'Bags', text: 'A checked bag for each traveler, both ways, is in the price.' }
    : { status: 'heads-up', label: 'Bags', text: `${t.flight.carryOn ? 'Carry-on only' : 'Personal item only (no carry-on)'} on this fare. Checked bags are ${fmt(t.flight.bagFeePerTraveler)} per traveler both ways and are not in this price unless you add them.` });
  rows.push(t.hotel.resortFeePerNight
    ? { status: 'ok', label: 'Hotel fees', text: `The mandatory resort fee (${fmt(t.hotel.resortFeePerNight)} per room per night) is already in your total. Incidentals are extra.` }
    : { status: 'ok', label: 'Hotel fees', text: 'No mandatory hotel fees. Incidentals (minibar, parking, spa) are extra.' });
  rows.push({ status: t.flight.refundable && t.hotel.refundable ? 'ok' : 'heads-up', label: 'Changing your mind', text: t.flight.refundable && t.hotel.refundable ? 'Every part can be canceled within its own window; the terms are listed below.' : `Full refund within 24 hours of booking (departure 7+ days away). After that: ${t.flight.refundable ? 'flights refundable' : 'flights non-refundable'}, ${t.hotel.refundable ? `hotel free to cancel until ${t.hotel.freeCancelHours} hours before` : 'hotel non-refundable'}.` });
  rows.push(t.transfer
    ? { status: 'ok', label: 'Getting to the hotel', text: 'A private transfer meets you at the airport and brings you back.' }
    : { status: 'heads-up', label: 'Getting to the hotel', text: 'No transfer is included. Taxis and shuttles are available at the airport; a private transfer can be added on the trip page so it’s in your total.' });
  if (weather) rows.push({ status: weather.warm ? 'ok' : 'heads-up', label: 'Weather', text: `${weather.label}, going by ${weather.source}. Not a forecast.` });
  return rows;
}

module.exports = { usableTime, timeAlternatives, compromises, biggestWin, verdict, budgetUnlocks, optimizeAround, nameYourPrice, weekdaysAway, ptoAlternatives, tripGuide, classifyChanges, tripDiff, realityCheck, clock, hoursLabel, GRADES, RUNG_LABELS };
