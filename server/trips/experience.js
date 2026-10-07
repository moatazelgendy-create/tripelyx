// EXPERIENCE MAX (customer level 4): "How do I get the most experience from my travel budget?" The
// customer does not optimize for the lowest price, luxury, stars, brands or convenience; the budget
// goes to the parts of the trip they will actually experience. Everything here is judged by the
// memory goals they ranked (GOALS) and the trip's own facts: goalScore is the only measure of "worth
// it", the experience score counts goal fit × size, beach access for a beach goal, usable days and an
// open day, and never stars, brand, price or margin (commissionPercent is never read: a test sets it
// to 0 and to 90 and the results are the same). Every number is priceTrip's total for a token or
// arithmetic on two such totals; nothing is estimated. What the inventory cannot say (distances,
// operating days, age limits, meeting points, room categories, weather) is said as not in our data;
// weather is never guaranteed; free is said only with a source and a checked date. Nothing is applied:
// every function returns priced versions with tokens, and the customer takes one or keeps what they
// have. The maximum is a ceiling, never a target, so "I wouldn't spend $2,000" is a real answer.
const { addDays, today } = require('../lib/dates'), { format } = require('../lib/money'), { encodeSpec } = require('./spec');
const { priceTrip, roomsFor, DEFAULT_SETTINGS } = require('./pricing'), optimizer = require('./optimizer');
const { memoInventory, candidateDates, hotelAllowed, rulesAllowFlight, rulesAllowHotel, GOAL_KEYS } = optimizer;
const { usableTime, classifyChanges, tripDiff, lineDiff, lineAmount, clock, LINE_LABEL, FULL_DAY } = require('./facts');
const { timeAlternatives, compromises } = require('./decision'), { stepUp, differences } = require('./strategies');
const { whyNot } = require('./savemax'), { cheapestWeeks } = require('./weeks'), { longDate, clause } = require('./words');

const fmt = cents => format(cents, 'USD'), plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const joinAnd = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const signed = c => `${c < 0 ? '−' : '+'}${fmt(Math.abs(c))}`, cap1 = w => w.charAt(0).toUpperCase() + w.slice(1);
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = iso => Number(String(iso).slice(5, 7)), monthList = ms => joinAnd(ms.map(m => MONTHS[m - 1].slice(0, 3)));
const uniq = xs => [...new Set(xs)], r1 = x => Math.round(x * 10) / 10;
const sameSet = (a, b) => [...a].sort().join(',') === [...b].sort().join(','), rowText = r => `${r.label}: ${r.b}`;
const pack = (t, extra = {}) => ({ trip: t, token: encodeSpec(t.spec), total: t.total, ...extra });
// Season is read on the days an experience can take: the full days (not the arrival or departure day,
// and not the night spent on an overnight flight). Without months the operating days are not in our
// data, which no check reads as "out of season".
const inSeason = (a, iso) => !a.months || a.months.includes(monthOf(iso));
const fullDates = (depart, nights, overnight = false) => Array.from({ length: Math.max(0, nights - 1 - (overnight ? 1 : 0)) }, (_, i) => addDays(depart, i + 1 + (overnight ? 1 : 0)));
const runsOn = (a, t) => !a.months || fullDates(t.spec.depart, t.spec.nights, !!(t.flight && t.flight.arrivesNextDay)).some(d => inSeason(a, d));
const runsIn = (a, days) => !a.months || days.some(d => inSeason(a, d.date));
const dayRange = days => (days.length ? `${longDate(days[0].date)} to ${longDate(days[days.length - 1].date)}` : 'no full day');

// ---- the memory chips ----------------------------------------------------------------------------
// In the spec's order. `kinds`/`tags` are the activity facts a goal counts; `styles` the destination
// styles; `stay` the hotel fact that counts as access (beach: beachfront or near the beach; family:
// family-friendly; romantic: beachfront). 'new' is an experience outside the other goals chosen and
// outside the usual beach-and-hotel shape (the engine cannot know what the customer has done, and says
// so); 'surprise' is no goal: every experience counts and the strongest overall match wins.
const GOALS = [
  { key: 'beach', label: 'Amazing beach', styles: ['beach'], kinds: ['beach'], stay: 'beach' }, { key: 'food', label: 'Incredible food', tags: ['food'] }, { key: 'adventure', label: 'Adventure', kinds: ['adventure'] },
  { key: 'nightlife', label: 'Nightlife', styles: ['nightlife'], kinds: ['nightlife'] }, { key: 'romantic', label: 'Romantic', styles: ['romantic'], kinds: ['romantic'], stay: 'romantic' }, { key: 'nature', label: 'Nature', tags: ['nature'] },
  { key: 'culture', label: 'Culture', kinds: ['culture'] }, { key: 'family', label: 'Family memories', styles: ['family'], kinds: ['family', 'beach'], stay: 'family' }, { key: 'new', label: 'Something I’ve never done' }, { key: 'surprise', label: 'Surprise me' },
];
const BY_KEY = Object.fromEntries(GOALS.map(g => [g.key, g]));
if (GOALS.map(g => g.key).join() !== GOAL_KEYS.join()) throw new Error('experience.GOALS and optimizer.GOAL_KEYS disagree');
const USUAL = ['beach', 'relaxing']; // the usual beach-and-hotel shape 'new' steps outside of
const NEW_NOTE = 'I can’t know what you have done before: "something I’ve never done" here means an experience outside the other goals you gave me and outside the usual beach-and-hotel shape.';
const BIG = 5;        // hours from which an experience is a "big" one (needs its own full day)
const THRESHOLD = 2;  // the experience-score gain under which a dearer rung is not "meaningfully more memorable"
const goalLabel = key => (BY_KEY[key] ? BY_KEY[key].label : key);
const goalsOf = ctx => { const raw = Array.isArray(ctx) ? ctx : (ctx && ctx.goals) || []; return uniq(raw.filter(k => BY_KEY[k])).slice(0, 3); };
const tagsOf = a => (a.tags && a.tags.length ? a.tags : [a.kind]);
function matches(key, act, gs) {
  const g = BY_KEY[key];
  if (!g || key === 'surprise') return !!g;
  if (key === 'new') { const taken = new Set(gs.filter(k => k !== 'new' && k !== 'surprise').flatMap(k => [...(BY_KEY[k].kinds || []), ...(BY_KEY[k].tags || [])])); return !taken.has(act.kind) && !tagsOf(act).some(t => taken.has(t)) && !USUAL.includes(act.kind); }
  return (g.kinds || []).includes(act.kind) || (g.tags || []).some(t => tagsOf(act).includes(t));
}
// 3 for goal #1's kinds/tags, 2 for #2, 1 for #3, 0 otherwise: the one measure of "worth it" here.
function goalScore(act, goals) { const gs = goalsOf(goals); for (let i = 0; i < gs.length; i++) if (matches(gs[i], act, gs)) return 3 - i; return 0; }
const goalOf = (act, goals) => { const gs = goalsOf(goals); return gs.find(k => matches(k, act, gs)) || null; };
const rankOf = (key, goals) => goalsOf(goals).indexOf(key) + 1;
const nearBeach = h => !h.features.beachfront && /\b(beach|sand)\b/i.test(h.area || '');
const beachAccess = h => !!(h.features.beachfront || nearBeach(h));
const accessWord = h => (h.features.beachfront ? 'beachfront' : nearBeach(h) ? 'near the beach' : null);
// The hotel fact a goal counts, in words: the listing's own location text for "near the beach", since
// a distance to the sand is not in our data.
const hotelPhrase = (h, k) => (k === 'family' ? 'a family-friendly hotel' : h.features.beachfront ? 'a beachfront hotel' : nearBeach(h) ? `a hotel near the beach (${h.area})` : 'a hotel');
const STAY_FIT = { beach: h => (h.features.beachfront ? 8 : nearBeach(h) ? 4 : 0), romantic: h => (h.features.beachfront ? 3 : 0), family: h => (h.features.familyFriendly ? 3 : 0) };
// The hotel's part of the experience score: access the goals ask for, weighted by rank; never stars.
function hotelFit(h, goals) { let n = 0; goalsOf(goals).forEach((k, i) => { if (STAY_FIT[k]) n += (STAY_FIT[k](h) * (3 - i)) / 3; }); return r1(n); }
// The hotel fact a ranked goal counts, as a blurb: what the listing says, never "strong" or "good".
const stayWord = (h, goals) => { const k = goalsOf(goals).find(x => STAY_FIT[x] && STAY_FIT[x](h) > 0); return !k ? null : k === 'family' ? 'Family-friendly hotel' : h.features.beachfront ? 'Beachfront hotel' : 'Near the beach'; };
const hotelFitWords = (h, goals) => goalsOf(goals).map((k, i) => (STAY_FIT[k] && STAY_FIT[k](h) ? `${hotelPhrase(h, k)} for the ${goalLabel(k).toLowerCase()} you ranked #${i + 1}` : null)).filter(Boolean);

// What a destination's inventory meets, goal by goal, with the facts: a matching style, matching
// experiences, a hotel with access. Nothing about fame or taste.
function destGoalMatch(dest, acts, hotels, goals) {
  const gs = goalsOf(goals), met = [], unmet = [];
  for (const k of gs) {
    const g = BY_KEY[k], facts = [];
    if (k === 'surprise') { facts.push('no goal given: every experience counts'); }
    if ((g.styles || []).some(s => dest.styles.includes(s))) facts.push(`a ${g.styles.find(s => dest.styles.includes(s))} destination by its style`);
    const a = acts.filter(x => matches(k, x, gs));
    if (a.length) facts.push(`${plural(a.length, 'experience')} for it: ${joinAnd(a.map(x => `${x.name} (${x.hours}h)`))}`);
    const stay = STAY_FIT[k] ? hotels.filter(h => STAY_FIT[k](h)).sort((x, y) => STAY_FIT[k](y) - STAY_FIT[k](x))[0] : null; // the best access listed
    if (stay) facts.push(hotelPhrase(stay, k));
    if (k === 'new' && a.length) facts.push(NEW_NOTE);
    if (facts.length) met.push({ key: k, label: g.label, facts }); else unmet.push({ key: k, label: g.label, why: `no ${g.label.toLowerCase()} experience, style or hotel in ${dest.name}’s inventory` });
  }
  return { met, unmet };
}

// ---- the rhythm -----------------------------------------------------------------------------------
// A suggested rhythm, never a schedule: days from the flight schedule (facts.usableTime), the main
// experience on the first full day that fits it, every other experience on its own full day, the rest
// open. No experience on the arrival or departure day; a seasonal one only on a day it runs (else it
// stays unplaced and is said); a morning slot never after an evening one; an evening or night slot not
// on the last full day when the flight home leaves before 9:00 unless no other day can take it
// (collisions() then names it). The first fit in order is kept when it places everything; when it
// leaves something out, a small search over the full days finds the arrangement that places the most
// (the main one first), so a conflict is never invented while a full day could hold the experience.
// The experience score reads `placed` and `openDays`.
const EVENING = a => a.slot === 'evening' || a.slot === 'night';
const byStrength = goals => (a, b) => goalScore(b, goals) - goalScore(a, goals) || b.hours - a.hours || b.pricePerPerson - a.pricePerPerson || a.name.localeCompare(b.name);
const mainOf = (t, goals) => (t.activities.length ? [...t.activities].sort(byStrength(goals))[0] : null);
// An activity named by id or by an object from another search resolves to the trip's own object, so a
// placement never counts the same experience twice (once as the main, once as the trip's copy).
const resolveAct = (t, x) => { if (!x) return null; const id = typeof x === 'string' ? x : x.id; return [...t.activities, ...(t.activityOptions || [])].find(a => a.id === id) || (typeof x === 'string' ? null : x); };
function rhythm(trip, goals, { main = null } = {}) {
  const gs = goalsOf(goals), s = trip.spec, f = trip.flight, u = usableTime(trip), overnight = !!f.arrivesNextDay, fullDays = u ? u.fullDays : Math.max(0, s.nights - 1);
  const first = u ? u.firstDay.minutes : 0, last = u ? u.lastDay.minutes : 0, early = Number.isFinite(f.returnDepartMinutes) && f.returnDepartMinutes < 9 * 60;
  const mainAct = resolveAct(trip, main) || mainOf(trip, gs), order = [mainAct, ...trip.activities.filter(a => a !== mainAct).sort(byStrength(gs))].filter(Boolean);
  const days = Array.from({ length: s.nights + 1 }, (_, i) => ({ n: i + 1, date: addDays(s.depart, i), label: 'Open day', items: [], open: false, full: false, slot: null }));
  const ai = overnight ? 1 : 0, full = days.slice(ai + 1, s.nights), lastFull = full[full.length - 1] || null, at = new Map();
  if (overnight) days[0].label = 'Overnight flight';
  days[ai].label = first >= 180 ? 'Arrive + explore' : 'Arrive'; days[s.nights].label = last >= 180 ? 'Easy morning + depart' : 'Depart'; full.forEach(d => { d.full = true; });
  const late = (a, d) => EVENING(a) && early && d === lastFull;
  const fits = (a, d) => { if (d.slot || !inSeason(a, d.date)) return false; const i = days.indexOf(d), prev = days[i - 1], next = days[i + 1]; return !(a.slot === 'morning' && prev && EVENING({ slot: prev.slot })) && !(EVENING(a) && next && next.slot === 'morning'); };
  const put = (a, d) => { at.set(a, d); d.slot = a.slot || 'day'; }, take = a => { at.get(a).slot = null; at.delete(a); };
  const options = a => full.filter(d => fits(a, d)).sort((x, y) => late(a, x) - late(a, y));
  for (const a of order) { const d = options(a)[0]; if (d) put(a, d); }
  const score = () => { let n = 0; for (const [a, d] of at) if (late(a, d)) n -= 1; return [at.has(mainAct) ? 1 : 0, at.size, n]; };
  const better = (x, y) => { const i = x.findIndex((v, k) => v !== y[k]); return i >= 0 && x[i] > y[i]; };
  let best = score(), bestAt = new Map(at);
  if ((best[1] < order.length || best[2] < 0) && order.length <= 6) {
    const dfs = i => {
      if (i === order.length) { const sc = score(); if (better(sc, best)) { best = sc; bestAt = new Map(at); } return; }
      if (!better([at.has(mainAct) || order.indexOf(mainAct) >= i ? 1 : 0, at.size + order.length - i, 0], best)) return; // cannot beat the best found
      for (const d of options(order[i])) { put(order[i], d); dfs(i + 1); take(order[i]); }
      dfs(i + 1);
    };
    [...at.keys()].forEach(take); dfs(0); for (const [a, d] of bestAt) put(a, d);
  }
  const placed = order.filter(a => at.has(a)).map(a => ({ activity: a, day: at.get(a) })), unplaced = order.filter(a => !at.has(a));
  for (const { activity: a, day } of placed) { day.items.push(a.name); day.label = a === mainAct ? 'Main experience' : tagsOf(a).includes('food') ? 'Food + neighborhood' : 'Explore day'; }
  const access = beachAccess(trip.hotel) && gs.includes('beach'), foodOpen = gs.includes('food') && !trip.activities.some(a => tagsOf(a).includes('food'));
  let foodUsed = false;
  full.forEach((d, i) => {
    if (d.items.length) return;
    d.open = true; const prev = full[i - 1], heavy = prev && prev.items.length && trip.activities.some(a => prev.items.includes(a.name) && (a.hours >= 8 || a.slot === 'night'));
    if (heavy) d.label = 'Easy day';
    else if (foodOpen && !foodUsed) { d.label = 'Food + neighborhood'; foodUsed = true; }
    else if (access) d.label = 'Open beach day';
    else if (gs.some(k => ['culture', 'nightlife', 'new', 'surprise'].includes(k)) && !trip.activities.length) d.label = 'Explore day';
    else d.label = 'Open day';
  });
  const openDays = full.filter(d => d.open).length, lateThenEarly = placed.filter(p => late(p.activity, p.day)).map(p => p.activity);
  return { days, openDays, fullDays, placed, unplaced, lateThenEarly, main: mainAct, text: 'A suggested rhythm, not a schedule: nothing here is booked for a day; times come with your vouchers.' };
}

// ---- the experience score ----------------------------------------------------------------------
// Goal fit × size of every experience the rhythm can place (a big one counts double), the hotel's
// access for the goals, usable days (two points a day, read off the flight schedule) and an open day.
// Never stars, brand or price: a dearer hotel with the same access scores the same.
function experienceScore(t, goals) {
  const gs = goalsOf(goals), r = rhythm(t, gs), u = usableTime(t);
  const acts = r.placed.reduce((n, p) => n + goalScore(p.activity, gs) * (p.activity.hours >= BIG ? 2 : 1), 0);
  const days = u ? u.usableMinutes / FULL_DAY : Math.max(0, t.spec.nights - 1);
  return r1(acts + hotelFit(t.hotel, gs) + days * 2 + (r.openDays >= 1 ? 2 : 0));
}
// What a trip gives each goal, in words from its facts.
function fitWords(t, goals) {
  const gs = goalsOf(goals);
  return gs.map((k, i) => {
    const acts = t.activities.filter(a => matches(k, a, gs)).map(a => `${a.name} (${a.hours}h)`), parts = [...acts, ...(STAY_FIT[k] && STAY_FIT[k](t.hotel) ? [hotelPhrase(t.hotel, k)] : [])];
    return `${goalLabel(k)} (#${i + 1}): ${parts.length ? joinAnd(parts) : 'nothing paid for it in this trip'}${k === 'new' && acts.length ? `. ${NEW_NOTE}` : ''}`;
  });
}

// ---- common pieces ----------------------------------------------------------------------------
const settingsOf = o => (o && o.settings) || DEFAULT_SETTINGS, nowOf = o => (o && o.now) || new Date(), locksOf = o => (o && o.locks) || {};
const rulesOf = o => (o && (o.rules || (o.ctx && o.ctx.rules) || (o.q && o.q.rules))) || null;
const capOf = (q, o) => (o && Number.isFinite(o.cap) ? o.cap : q && Number.isFinite(q.budget) ? q.budget : null);
const pricer = (inv, o) => { const m = memoInventory(inv); const settings = settingsOf(o); return spec => priceTrip(m, spec, settings, { promo: (o && o.promo) || null }); };
// The style the customer asked for (all-inclusive is a hotel rule) rides on every hotel move with the
// stated rules: no engine here offers a hotel the customer's own words rule out.
const styleOf = o => (o && ((o.q && o.q.style) || (o.ctx && o.ctx.style) || o.style)) || 'surprise';
const hotelsOk = (t, o) => t.hotelOptions.filter(h => hotelAllowed(h, { who: t.spec.who, style: styleOf(o) }) && rulesAllowHotel(h, rulesOf(o)));
const flightsOk = (t, o) => t.flightOptions.filter(f => rulesAllowFlight(f, rulesOf(o)));
// A version that moves a locked part, a fixed date, or the length the customer stated is never a
// suggestion; each move happens only when its lock is off.
function crossesLock(p, t, o) {
  const L = locksOf(o), a = p.spec, b = t.spec, fixed = L.dates || (o && o.ctx && o.ctx.dateMode === 'exact');
  return (L.dest && a.dest !== b.dest) || (fixed && a.depart !== b.depart) || ((L.nights || L.dates || (o && o.nightsOpen === false)) && a.nights !== b.nights) || (L.hotel && a.hotel !== b.hotel) || (L.flight && (a.flight !== b.flight || a.from !== b.from));
}
// "You told me the stay matters" is only said when it is true: a hotel priority, an all-inclusive or
// luxury style, a learned "the hotel was worth it" kept with permission, or words that asked for the stay.
function stayAskedOf(q, o = {}) {
  const qq = q || o.q || {}, style = qq.style || (o.ctx && o.ctx.style) || null;
  const why = qq.priority === 'hotel' ? 'You told me the hotel matters most' : style === 'all-inclusive' ? 'You asked for an all-inclusive stay' : style === 'luxury' ? 'You asked for a luxury stay' : o.statedStay ? 'You asked for a better stay' : null;
  return { asked: !!why || !!(o.prefs && o.prefs.stayMatters === true), why };
}
// Every difference two trips have, said: the frame's words (strategies.differences) and each row of
// facts.tripDiff they do not cover (other dates, bags, cancellation, usable time, the fare, the hotel by
// name and area), so "Different trip. Similar goal." never leaves a change to be found later.
function sayDiffs(p, t) {
  const out = differences(p, t).all, beach = p.hotel.features.beachfront === t.hotel.features.beachfront;
  for (const r of tripDiff(t, p, { date: longDate }).filter(x => x.changed)) {
    if ((r.key === 'dates' && p.spec.depart !== t.spec.depart) || ['bags', 'flex', 'time'].includes(r.key) || (r.key === 'flight' && (p.flight.stops === 0) === (t.flight.stops === 0)) || (r.key === 'hotel' && p.hotel.stars === t.hotel.stars) || (r.key === 'area' && beach)) out.push(`${r.label.toLowerCase()}: ${r.b} instead of ${r.a}`);
  }
  return out;
}
const withAct = (s, id) => ({ ...s, activities: uniq([...s.activities, id]).sort() }), withoutAct = (s, id) => ({ ...s, activities: s.activities.filter(x => x !== id) });
// The protected main experience (`px=` on the link, ctx.protect or o.protect): every version this engine
// builds or recommends keeps it, as the other engines do; only an explicit "different trip" ask (SAME
// FEELING FOR LESS, another destination) may price one without it, and the agent's gate never applies
// that on a plain approval. The customer may have protected it, or the agent from the results (its
// canvas links carry px= too), and the engine cannot tell which: every sentence here says "the
// protected experience", never "the experience you protected"; who set it is the agent's to say.
const protectOf = o => (o && (o.protect || (o.ctx && o.ctx.protect))) || null;
const keepsPx = (spec, px) => !px || spec.activities.includes(px);
const withPx = (sets, px, fullDays) => (px ? uniq(sets.map(x => uniq([...x, px]).sort().join(','))).map(k => k.split(',')).filter(x => x.length <= Math.max(1, fullDays - 1)) : sets);
// A version is offered only when the rhythm can hold it the way the final check reads it: every
// experience in season on the day it falls on (the rhythm never places one on a day it does not run, and
// one it cannot place must at least run on some full day), and, when `strict`, each on a full day of its
// own, no evening experience before an early flight home, and an open day on a trip of 4 nights or more
// ("Do not fill every day"). A schedule conflict is never a suggestion.
function fitsSchedule(t, gs, { strict = true } = {}) {
  const r = rhythm(t, goalsOf(gs)), fd = r.days.filter(d => d.full);
  if (!r.unplaced.every(a => runsIn(a, fd))) return false;
  return !strict || (!r.unplaced.length && !r.lateThenEarly.length && (t.spec.nights < 4 || r.openDays >= 1));
}
// Why a version does not fit the schedule, in the rhythm's own facts.
function scheduleWhy(t, gs, a = null) {
  const r = rhythm(t, gs), fd = r.days.filter(d => d.full), off = r.unplaced.filter(x => !runsIn(x, fd));
  if (off.length) return `${joinAnd(off.map(x => x.name))} ${off.length === 1 ? 'does' : 'do'} not run on these dates (runs ${joinAnd(off.map(x => monthList(x.months)))})`;
  if (r.unplaced.length) return `${joinAnd(r.unplaced.map(x => x.name))} would have no full day of ${r.unplaced.length === 1 ? 'its' : 'their'} own (${plural(fd.length, 'full day')} for ${plural(t.activities.length, 'experience')})`;
  if (r.lateThenEarly.length) return `${joinAnd(r.lateThenEarly.map(x => x.name))} would sit the night before a flight home at ${hhmm(t.flight.returnDepartMinutes)}`;
  if (t.spec.nights >= 4 && r.openDays < 1) return `${a ? `with ${a.name}, ` : ''}every full day would hold an experience, and I keep one open on a trip of ${plural(t.spec.nights, 'night')}`;
  return null;
}
const scoreOf = (c, gs) => (Number.isFinite(c.score) ? c.score : experienceScore(c.trip || c, gs));
const candidate = (t, gs) => pack(t, { score: experienceScore(t, gs), main: mainOf(t, gs), fit: fitWords(t, gs), dest: t.dest.id });
// The activity sets the goals build for one destination on one flight: none; the main experience (the
// top goalScore, then the longer and pricier "big" one); main + the best second of another goal; main +
// second + a third only when the rhythm has room (never more than full days − 1, so an open day stays).
function goalSets(acts, gs, fullDays) {
  const scored = acts.filter(a => goalScore(a, gs) > 0).sort(byStrength(gs)), main = scored[0] || null;
  const second = main ? scored.find(a => a !== main && goalOf(a, gs) !== goalOf(main, gs)) || scored.find(a => a !== main) || null : null;
  const third = second ? scored.find(a => a !== main && a !== second) || null : null, room = Math.max(0, fullDays - 1);
  return [[], main && [main.id], second && [main.id, second.id], third && [main.id, second.id, third.id]].filter(Boolean).filter(x => x.length <= room).map(x => [...x].sort());
}

// ---- EXPERIENCE → DESTINATION → DATES → FLIGHT → HOTEL ---------------------------------------
function experienceSearch(inv, q, goals, o = {}) {
  const gs = goalsOf(goals), settings = settingsOf(o), now = nowOf(o), locks = locksOf(o), m = memoInventory(inv), origin = m.maps.getOrigin(q.origin);
  if (!origin) return { candidates: [], considered: 0, destinations: [], goals: gs, notes: [] };
  const airport = origin.airports[0].code, disabled = new Set(settings.disabledDestinations || []);
  const nightsList = o.nightsOpen === false || locks.nights || locks.dates ? [q.nights] : uniq([q.nights, q.nights + 1].filter(n => n <= 14));
  const open = !gs.length || gs[0] === 'surprise' || gs[0] === 'new', px = protectOf(o);
  const destinations = [], candidates = []; let considered = 0;
  for (const dest of m.maps.listDestinations()) {
    if (disabled.has(dest.id) || (q.dest && dest.id !== q.dest) || (q.dests && !q.dests.includes(dest.id))) continue;
    if (q.notCountry && optimizer.sameCountry(dest.country, q.notCountry)) continue;
    if (q.region === 'international' && optimizer.sameCountry(dest.country, origin.country || 'United States')) continue;
    const dates = candidateDates(m, q, airport, dest.id, now); if (!dates.length) continue;
    const acts = m.activities.search({ destId: dest.id, date: dates[0], travelers: q.travelers });
    const hotelsAll = m.hotels.search({ destId: dest.id, checkIn: dates[0], nights: q.nights, rooms: roomsFor({ who: q.who, travelers: q.travelers }) });
    const match = destGoalMatch(dest, acts, hotelsAll, gs); destinations.push({ dest, match });
    if (!(open ? match.met.length > 0 || !gs.length : match.met.some(x => x.key === gs[0]))) continue;
    for (const depart of dates) for (const nights of nightsList) {
      const base = { dest: dest.id, from: airport, depart, nights, travelers: q.travelers, who: q.who };
      const flights = m.flights.search({ from: airport, destId: dest.id, depart, nights, travelers: q.travelers }).filter(f => rulesAllowFlight(f, q.rules));
      const hotels = m.hotels.search({ destId: dest.id, checkIn: depart, nights, rooms: roomsFor(base) }).filter(h => hotelAllowed(h, q) && rulesAllowHotel(h, q.rules));
      const days = fullDates(depart, nights), onDate = m.activities.search({ destId: dest.id, date: depart, travelers: q.travelers }).filter(a => !a.months || days.some(d => inSeason(a, d))); // the rhythm then puts each on a day it runs
      if (px && !onDate.some(a => a.id === px)) continue; // the protected experience is not offered here on this date
      const transfers = q.rules && q.rules.transfer ? [true] : [false, true];
      for (const f of flights) {
        const fullDays = Math.max(0, nights - 1 - (f.arrivesNextDay ? 1 : 0));
        for (const set of withPx(goalSets(onDate, gs, fullDays), px, fullDays)) for (const h of hotels) for (const transfer of transfers) {
          considered++; const t = priceTrip(m, { ...base, flight: f.id, hotel: h.id, activities: set, bags: false, transfer }, settings);
          if (!t || !fitsSchedule(t, gs)) continue; // never a trip built on a schedule conflict or out of season
          candidates.push(candidate(t, gs));
        }
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.total - b.total);
  return { candidates, considered, destinations, goals: gs, notes: gs.includes('new') ? [NEW_NOTE] : [] };
}

// ---- the ladder and the sweet spot ------------------------------------------------------------
// Each rung is the cheapest priced version one change above the rung below (one experience
// improvement, nothing given up: classifyChanges) whose experience score rises by at least THRESHOLD,
// the "meaningfully more memorable" step. Taking the cheapest meaningful step first makes the ladder
// the same whatever the ceiling: a lower ceiling only cuts it shorter, so a bigger number never moves
// "I'd stop at $X" to a dearer or less memorable trip, and when the next rung does not fit, nothing
// within the ceiling is meaningfully more memorable with nothing given up. (Largest-gain-first is not
// stable: an expensive early step can block a cheaper path to a better trip.) The label names what
// changed, read off the two trips.
function rungLabel(cur, c, gs) {
  const a = cur.trip, b = c.trip, added = b.activities.filter(x => !a.spec.activities.includes(x.id)), removed = a.activities.filter(x => !b.spec.activities.includes(x.id));
  if (removed.length || added.length > 1) return null;
  const changes = (added.length ? 1 : 0) + (b.spec.nights > a.spec.nights ? 1 : 0) + (b.spec.hotel !== a.spec.hotel ? 1 : 0) + (b.spec.flight !== a.spec.flight ? 1 : 0) + (!!b.transfer !== !!a.transfer ? 1 : 0) + (b.spec.depart !== a.spec.depart ? 1 : 0);
  if (changes !== 1) return null;
  if (added.length) {
    const x = added[0], m = mainOf(a, gs), n = b.activities.length, nth = n === 2 ? 'Second' : n === 3 ? 'Third' : 'Another';
    if (!m || goalScore(x, gs) > goalScore(m, gs)) return '+ Main experience';
    if (tagsOf(x).includes('food') && gs.includes('food')) return '+ Food experience';
    return x.hours >= BIG ? `+ ${nth} major experience` : `+ ${nth} experience`;
  }
  if (b.spec.nights > a.spec.nights) return '+ Extra night';
  if (b.spec.hotel !== a.spec.hotel) return hotelFit(b.hotel, gs) > hotelFit(a.hotel, gs) ? '+ Better location' : null;
  if (b.spec.flight !== a.spec.flight) return '+ More usable time';
  return null;
}
const gainOf = (a, b, gs) => r1(scoreOf(b, gs) - scoreOf(a, gs));
function climb(start, cands, gs, cap) {
  const rungs = [{ ...start, label: 'GOOD TRIP', gain: 0 }], pool = cands.filter(c => c.dest === start.dest).sort((a, b) => a.total - b.total); let cur = start;
  for (;;) {
    let next = null;
    for (const c of pool) {
      if (c.total <= cur.total) continue;
      if (next && c.total > next.c.total) break; // the cheapest meaningful step (ties: the larger gain)
      const gain = gainOf(cur, c, gs);
      if (gain < THRESHOLD || (next && gain <= next.gain)) continue;
      const label = rungLabel(cur, c, gs); if (label && !classifyChanges(cur.trip, c.trip).tradeoffs.length) next = { c, label, gain };
    }
    if (!next || (cap !== null && next.c.total > cap)) break;
    rungs.push({ ...next.c, label: next.label, gain: next.gain }); cur = next.c;
  }
  return rungs;
}
function ladder(inv, q, goals, o = {}) {
  const gs = goalsOf(goals), cap = capOf(q, o), res = experienceSearch(inv, q, gs, o);
  const under = res.candidates.filter(c => cap === null || c.total <= cap);
  const qctx = { style: 'surprise', priority: 'price', rules: q.rules || null, budget: null, allowOver: 0 };
  // EXPERIENCE → DESTINATION first: a ladder is climbed in every destination that has a GOOD TRIP (the
  // cheapest eligible trip there with no real downside by decision.compromises, weight 2 or more, the
  // budget taken out and the hotel's stars set aside: stars are labels, so a cheaper version with the
  // same goal facts is never skipped for them). The pick is read off every rung of every ladder from
  // the cheapest up: a dearer rung replaces it only when it is meaningfully more memorable (THRESHOLD),
  // so the money above the pick buys nothing the goals call a gain; never the cheapest destination for
  // its own sake, never the most famous; and a ceiling lowered to the pick's own total gives the same
  // pick back (every rung under it is the same).
  const recommended = c => !compromises(c.trip, qctx).some(x => x.w >= 2 && x.key !== 'stars');
  const points = [], chains = [];
  for (const dest of uniq(under.map(c => c.dest))) {
    const here = under.filter(c => c.dest === dest), good = [...here].sort((a, b) => a.total - b.total).find(recommended);
    if (!good) continue;
    const rungs = climb(good, here, gs, cap); chains.push({ dest, rungs }); rungs.forEach((r, i) => points.push({ r, rungs, i }));
  }
  points.sort((a, b) => a.r.total - b.r.total || b.r.score - a.r.score || (a.r.token < b.r.token ? -1 : 1));
  let best = null;
  for (const p of points) if (!best || p.r.score >= best.r.score + THRESHOLD) best = p;
  if (!best) return { rungs: [], top: null, stop: null, text: `Nothing the inventory priced fits ${cap === null ? 'these goals' : fmt(cap)} as a trip I would recommend for ${joinAnd(gs.map(goalLabel)) || 'your goals'}.`, search: res, chains, goals: gs, cap };
  // The pick's own ladder up to it; its next rung does not fit (or would have been the pick).
  const rungs = best.rungs.slice(0, best.i + 1), stop = rungs[rungs.length - 1];
  const top = cap !== null && cap > stop.total ? { total: cap, text: 'No meaningful improvement found' } : null;
  return { rungs, top, stop, text: `I'd stop at ${fmt(stop.total)}.`, search: res, chains, goals: gs, cap };
}
// The rung after which the next rung's gain is below the threshold, or the last rung.
const stopIndex = rungs => { let i = 0; while (i + 1 < rungs.length && rungs[i + 1].gain >= THRESHOLD) i++; return i; };
function sweetSpot(ladderOut, trip = null) {
  const rungs = (ladderOut && ladderOut.rungs) || [], gs = (ladderOut && ladderOut.goals) || [];
  if (!rungs.length) return { total: null, rung: null, reasons: [], text: 'No ladder could be built for these goals.' };
  const r = rungs[stopIndex(rungs)], t = r.trip, main = mainOf(t, gs), rh = rhythm(t, gs);
  const reasons = [plural(t.spec.nights, 'night'), main && goalScore(main, gs) > 0 ? 'Main experience' : null, stayWord(t.hotel, gs), rh.openDays >= 1 ? 'Enough open time' : null].filter(Boolean);
  const diff = trip ? trip.total - r.total : 0;
  return { total: r.total, rung: r, reasons, text: `I'd stop at ${fmt(r.total)}.${diff ? ` Your trip is ${fmt(Math.abs(diff))} ${diff > 0 ? 'above' : 'below'} it.` : ''}` };
}

// ---- MORE MEMORIES / OUR PICK / MORE COMFORT ---------------------------------------------------
function experienceWays(inv, q, goals, o = {}) {
  const gs = goalsOf(goals), cap = capOf(q, o), L = ladder(inv, q, gs, o), cands = L.search.candidates;
  const dropped = [], none = { memories: null, pick: null, comfort: null, dropped, reason: L.text, rejected: null, keep: null, signature: null, ladder: L, goals: gs, considered: L.search.considered };
  if (!L.stop) { dropped.push(...['memories', 'pick', 'comfort'].map(key => ({ key, reason: L.text }))); return none; }
  const P = L.stop, pt = P.trip, main = mainOf(pt, gs), where = pt.dest.name;
  const under = cands.filter(c => c.token !== P.token && (cap === null || c.total <= cap)), same = under.filter(c => c.dest === P.dest);
  const goalActs = t => t.activities.filter(a => goalScore(a, gs) > 0).length;
  // MORE MEMORIES: cheaper, more goal experiences, a simpler or same-class hotel; in the pick's
  // destination first, elsewhere only when its inventory has no such version (then said as a
  // different trip, never as the same one for less).
  const more = c => c.total < P.total && goalActs(c.trip) > goalActs(pt) && c.trip.hotel.stars <= pt.hotel.stars;
  const M = [same, under].map(xs => xs.filter(more).sort((a, b) => b.score - a.score || a.total - b.total)[0]).find(Boolean) || null;
  // MORE COMFORT: the same experiences, a better flight (stops, usable time), hotel or transfer, dearer, nothing worse.
  const keepsCore = c => sameSet(c.trip.spec.activities, pt.spec.activities), comfortKeys = ['flight', 'time', 'hotel', 'area', 'meals', 'transfer'];
  const travelKeys = ['flight', 'time', 'hotel', 'area', 'meals'], gets = (x, keys) => x.ch.improvements.some(r => keys.includes(r.key));
  const C = same.map(c => ({ c, ch: classifyChanges(pt, c.trip) })).filter(x => x.c.total > P.total && keepsCore(x.c) && !x.ch.tradeoffs.length && gets(x, comfortKeys)).sort((a, b) => gets(b, travelKeys) - gets(a, travelKeys) || a.c.total - b.c.total)[0] || null;
  const rh = rhythm(pt, gs), way = (c, label, blurbs) => ({ ...c, label, blurbs, keep: cap === null ? null : cap - c.total });
  // The location blurb is the listing's own fact, never a quality word, and none when LOCATION would move this hotel.
  const loc = gs.includes('beach') && !pt.hotel.features.beachfront ? locationCheck(inv, pt, gs, { ...o, cap }) : null;
  const pick = way(P, 'OUR PICK', [main && goalScore(main, gs) > 0 ? 'Main experience' : null, plural(pt.spec.nights, 'night'), loc && loc.verdict ? null : stayWord(pt.hotel, gs), rh.openDays >= 1 ? 'Open time' : null].filter(Boolean));
  const memories = M ? way(M, 'MORE MEMORIES', ['More experiences', M.trip.spec.hotel === pt.spec.hotel ? 'Same hotel' : 'Simpler hotel', ...(M.dest !== P.dest ? [`A different trip: ${M.trip.dest.name}`] : [])]) : null;
  if (!M) dropped.push({ key: 'memories', reason: `No cheaper version with more goal experiences and a simpler or same-class hotel was priced${cap === null ? '' : ` under ${fmt(cap)}`}, in ${where} or elsewhere` });
  let comfort = null;
  if (C) {
    const imp = C.ch.improvements.map(r => r.key), flight = imp.some(k => k === 'flight' || k === 'time'), hotel = imp.some(k => ['hotel', 'area', 'meals'].includes(k));
    comfort = way(C.c, 'MORE COMFORT', ['Same core experience', flight && hotel ? 'Better flight and hotel' : flight ? 'Better flight' : hotel ? 'Better hotel' : 'Airport transfer']);
  } else dropped.push({ key: 'comfort', reason: `No dearer version in ${where} keeps ${main ? main.name : 'the same experiences'} with a better flight or hotel and nothing given up${cap === null ? '' : ` under ${fmt(cap)}`}` });
  // Item 36's sentence, each clause only when its fact holds.
  const parts = [`I'd pick ${fmt(P.total)}.`];
  if (M) {
    const lost = pt.activities.filter(a => goalScore(a, gs) >= 2 && !M.trip.spec.activities.includes(a.id));
    const ch = classifyChanges(pt, M.trip, { date: longDate }), words = ch.tradeoffs.length ? whyNot(M.trip, pt, {}) : [];
    const clause = M.dest !== P.dest ? `is a different trip: ${M.trip.dest.name} instead of ${where}${words.length ? `, ${joinAnd(words)}` : ''}` : lost.length ? 'removes an experience you ranked highly' : words.length ? `means ${joinAnd(words)}` : ch.neutral.length ? `changes ${joinAnd(ch.neutral.map(rowText))}` : null;
    parts.push(clause ? `The ${fmt(M.total)} version saves money, but ${clause}.` : `The ${fmt(M.total)} version saves money; it differs only in experiences I rank lower for your goals.`);
  }
  if (C) {
    const imp = C.ch.improvements.map(r => r.key), lead = imp.some(k => k === 'flight' || k === 'time') ? 'is easier' : imp.some(k => ['hotel', 'area', 'meals'].includes(k)) ? 'has a better hotel' : 'adds a transfer';
    const gain = r1(C.c.score - P.score);
    parts.push(gain < THRESHOLD ? `The ${fmt(C.c.total)} version ${lead}, but doesn't make the vacation meaningfully more memorable.` : `The ${fmt(C.c.total)} version ${lead} and adds to the experience (${gain} points on my score); it sits above the sweet spot, so it's your call.`);
  }
  // The hotel step-up the pick could have bought: same flights, dates and experiences, a stay gain
  // (strategies.stepUp) and no experience gain, so it buys a label, not a memory.
  const ups = same.filter(c => c.total > P.total && c.trip.spec.flight === pt.spec.flight && c.trip.spec.depart === pt.spec.depart && c.trip.spec.nights === pt.spec.nights && sameSet(c.trip.spec.activities, pt.spec.activities) && !!c.trip.transfer === !!pt.transfer && c.trip.spec.hotel !== pt.spec.hotel)
    .map(c => ({ c, up: stepUp(pt, c.trip, q.nights) })).filter(x => x.up && x.up.stay.length && x.c.score <= P.score).sort((a, b) => a.c.total - b.c.total)[0] || null;
  // Never said when anything they said asks for the stay (stayAskedOf). The owner's line "…an upgrade you told me you
  // don't care about" only when the customer did say it: o.stayLow (their words, e.g. "the hotel doesn't matter", "just a
  // place to sleep") or a "not worth it: Hotel" remembered with their permission (prefs.stayMatters === false). Otherwise
  // the upgrade is one they didn't ask for, and that is all it says: words are never put in the customer's mouth. "room"
  // when the step-up is a room category on the same hotel, "hotel" when it changes the hotel (room categories are not in
  // our data, so today every step-up here is another hotel).
  const saidLow = o.stayLow === true || !!(o.prefs && o.prefs.stayMatters === false);
  const upWords = ups && `${ups.c.trip.spec.hotel === pt.spec.hotel ? 'room' : 'hotel'} upgrade ${saidLow ? 'you told me you don\'t care about' : 'you didn\'t ask for'}`;
  const rejected = ups && !stayAskedOf(q, o).asked ? { ...pack(ups.c.trip), delta: ups.c.total - P.total, label: `+${fmt(ups.c.total - P.total)} Hotel upgrade`, gets: ups.up.stay, saidLow, text: cap === null ? `I'd rather not put ${fmt(ups.c.total - P.total)} into a ${upWords}.` : `I'd rather leave you ${fmt(cap - P.total)} than put it into a ${upWords}.` } : null;
  const signature = Number.isFinite(q.budget) && P.total < q.budget ? `I wouldn't spend ${fmt(q.budget)}.` : null;
  return { ...none, memories, pick, comfort, reason: parts.join(' '), rejected, keep: cap === null ? null : cap - P.total, signature };
}

// ---- YOUR EXPERIENCE BUDGET ---------------------------------------------------------------------
// The trip's own price lines. The sentence names a dearer hotel the pick passed on only when one was
// priced (hotelOrExperience's A, handed in as `hotelUp` or found here when `inv` is given); otherwise
// it says where the money goes, nothing more.
function allocation(trip, max, { hotelUp = null, inv = null, o = {} } = {}) {
  const lines = trip.lines.map(l => ({ key: l.key, label: LINE_LABEL[l.key] || l.label, amount: l.amount }));
  const keep = Number.isFinite(max) ? max - trip.total : null;
  if (!hotelUp && inv) { const up = hotelStepUp(trip, { ...o, inv }); hotelUp = up ? { ...pack(up.p), delta: up.p.total - trip.total } : null; }
  const text = hotelUp && hotelUp.delta > 0 && (keep === null || hotelUp.delta <= keep) ? `I'd choose the simpler hotel and keep ${fmt(hotelUp.delta)} for the experiences you said are the reason you're going.` : `Where the money goes: ${lines.map(l => `${l.label.toLowerCase()} ${fmt(l.amount)}`).join(', ')}; ${fmt(trip.total)} in all${keep !== null ? `, ${keep >= 0 ? `${fmt(keep)} of your ${fmt(max)} unspent` : `${fmt(-keep)} over your ${fmt(max)}`}` : ''}.`;
  return { lines, total: trip.total, keep, text };
}

// ---- HOTEL OR EXPERIENCE? ------------------------------------------------------------------------
function hotelStepUp(trip, o) {
  const price = pricer(o.inv, o), s = trip.spec;
  return hotelsOk(trip, o).filter(h => h.id !== s.hotel && !locksOf(o).hotel).map(h => price({ ...s, hotel: h.id })).filter(Boolean).map(p => ({ p, up: stepUp(trip, p, s.nights) })).filter(x => x.up && x.up.stay.length).sort((a, b) => a.p.total - b.p.total)[0] || null;
}
function bestAdditions(trip, gs, n = 2) {
  return (trip.activityOptions || []).filter(a => !trip.spec.activities.includes(a.id) && goalScore(a, gs) > 0 && runsOn(a, trip)).sort(byStrength(gs)).slice(0, n);
}
function hotelOrExperience(inv, trip, goals, o = {}) {
  const gs = goalsOf(goals), cap = capOf(null, o), price = pricer(inv, o), base = experienceScore(trip, gs);
  const up = hotelStepUp(trip, { ...o, inv }), over = t => (cap === null ? false : t.total > cap);
  const a = up ? { ...pack(up.p), delta: up.p.total - trip.total, hotel: up.p.hotel, gets: up.up.stay, over: over(up.p), text: `Hotel upgrade +${fmt(up.p.total - trip.total)}` } : null;
  let b = null;
  for (let n = 2; n >= 1 && !b; n--) {
    const adds = bestAdditions(trip, gs, n); if (adds.length < n) continue;
    const p = price({ ...trip.spec, activities: uniq([...trip.spec.activities, ...adds.map(x => x.id)]).sort() });
    if (!p || !fitsSchedule(p, gs)) continue;
    b = { ...pack(p), delta: p.total - trip.total, names: adds.map(x => x.name), activities: adds, over: over(p), text: `${n === 2 ? 'Two experiences' : 'One experience'} +${fmt(p.total - trip.total)}` };
  }
  const gainA = a ? r1(experienceScore(a.trip, gs) - base) : null, gainB = b ? r1(experienceScore(b.trip, gs) - base) : null;
  // The goals pick the side, never the prices: the hotel wins only when its step-up gives the access a goal asks for
  // (beach: beachfront or near it; romantic: beachfront; family: family-friendly) and that goal ranks at or above the
  // experiences' goals ("goal #1 romantic with a beachfront step-up counts as the experience"). The ceiling decides what
  // I recommend: a side over the maximum is shown (`over`), never recommended while the other fits; if none fits, I say so.
  const stayGoal = a ? gs.find(k => STAY_FIT[k] && STAY_FIT[k](a.hotel) > STAY_FIT[k](trip.hotel)) || null : null;
  const expRank = b ? Math.min(...b.activities.map(x => rankOf(goalOf(x, gs), gs) || 99)) : 99;
  const goalKey = stayGoal && rankOf(stayGoal, gs) <= expRank ? 'a' : b ? 'b' : null, side = { a, b };
  const fact = stayGoal ? `${hotelPhrase(a.hotel, stayGoal)} for the ${goalLabel(stayGoal).toLowerCase()} you ranked #${rankOf(stayGoal, gs)}` : null;
  const alt = goalKey === 'a' ? (b ? 'b' : null) : goalKey === 'b' && stayGoal ? 'a' : null; // a hotel step-up that serves no goal is a label, never the fallback
  const name = k => (k === 'a' ? `the hotel step-up (${fact || a.hotel.name})` : 'the experiences version'), by = k => fmt(side[k].total - cap);
  let verdictKey = goalKey, text;
  if (goalKey && side[goalKey].over) {
    verdictKey = alt && !side[alt].over ? alt : null;
    const rest = `${name(goalKey)} is ${by(goalKey)} over your ${fmt(cap)} maximum`;
    text = verdictKey === 'b' ? `Within your ${fmt(cap)}, I'd take the experiences: ${rest}; going over is your call.` : verdictKey === 'a' ? `Within your ${fmt(cap)}, I'd take the hotel: ${fact}. ${cap1(rest)}; going over is your call.`
      : `${cap1(rest)}${alt ? `, and ${name(alt)} is ${by(alt)} over it` : goalKey === 'b' && a ? ', and nothing you told me asks for the hotel step-up' : ''}; ${trip.total <= cap ? 'within it, I\'d keep this trip as it is' : `this trip is already ${fmt(trip.total - cap)} over it, so I'd add neither`}. Going over is your call.`;
  } else text = verdictKey === 'b' ? 'Based on what you told me, I\'d take the experiences.' : verdictKey === 'a' ? `Based on what you told me, I'd take the hotel: ${fact}.` : !a && !b ? 'Neither a hotel step-up nor another goal experience could be priced for this trip.' : 'Nothing you told me asks for the hotel step-up, and no goal experience is left to add.';
  return { a, b, verdict: verdictKey, gains: { a: gainA, b: gainB }, text };
}

// ---- MAKE $100 MEMORABLE --------------------------------------------------------------------------
// Every priced version within 0.5×–1.5× of `amount` over the current total (a free thing at $0).
const freeGain = (it, gs) => r1((4 - rankOf(it.matches, gs)) / 2); // half of a paid experience for the same goal: #1 1.5, #2 1, #3 0.5
// Other flights that change the usable time, each priced: what timeAlternatives() can compare.
function timing(trip, o, price) {
  const s = trip.spec, options = flightsOk(trip, o).filter(f => f.id !== s.flight).map(f => { const p = price({ ...s, flight: f.id }); return p ? { flight: f, delta: p.total - trip.total, total: p.total, p } : null; }).filter(Boolean);
  return timeAlternatives(trip, { flights: options }).map(t => ({ ...t, p: options.find(x => x.flight.id === t.flight.id).p }));
}
// A guide item may be free only on some days (`condition`, e.g. { days: 'first-sunday' }): it is free on
// this trip only when one of the trip's full days meets the condition, said with that date; with no
// trip, or a condition the engine cannot read, it is unknown (null). Only items free on the trip's own
// dates are ever offered as free (FIND FREE THINGS, the $100 test, $0 more), each with its note.
const DAY_RULES = { 'first-sunday': iso => new Date(`${iso}T12:00:00Z`).getUTCDay() === 0 && Number(iso.slice(8, 10)) <= 7 };
const DAY_WORDS = { 'first-sunday': 'the first Sunday of the month' };
function freeOn(it, trip) {
  const c = it.condition && it.condition.days;
  if (!c) return { onDates: true, freeOn: null, when: null };
  const words = DAY_WORDS[c] || 'some days', d = trip && DAY_RULES[c] ? fullDates(trip.spec.depart, trip.spec.nights, !!(trip.flight && trip.flight.arrivesNextDay)).find(DAY_RULES[c]) || null : null;
  if (!trip || !DAY_RULES[c]) return { onDates: null, freeOn: null, when: `free only on ${words}; needs verification for your dates` };
  return d ? { onDates: true, freeOn: d, when: `free on ${longDate(d)}, ${words}` } : { onDates: false, freeOn: null, when: `free only on ${words}, and none of your full days is one` };
}
// `dest` is a destination (or its id) or a trip; with a trip, each item says whether its dates meet it.
function freeThings(inv, dest, goals, trip = dest && dest.spec ? dest : null) {
  const gs = goalsOf(goals), d = dest && dest.spec ? dest.dest : dest, destId = typeof d === 'string' ? d : d && d.id;
  const g = inv && inv.guides && typeof inv.guides.freeThings === 'function' ? inv.guides.freeThings({ destId }) : null;
  if (!g || !g.source || !g.checkedAt || !Array.isArray(g.items) || !g.items.length) return null;
  return { source: g.source, checkedAt: g.checkedAt, items: g.items.map(it => ({ name: it.name, kind: it.kind, note: it.note, condition: it.condition || null, ...freeOn(it, trip), matches: gs.find(k => matches(k, { kind: it.kind, tags: [it.kind] }, gs)) || null })) };
}
const freeNote = it => `${it.note}${it.when ? ` (${it.when})` : ''}`;
// What a version gives up, in words (savemax.whyNot reads classifyChanges' trade-offs), or [] when nothing.
const givesUpOf = (p, t) => (classifyChanges(t, p).tradeoffs.length ? whyNot(p, t) : []);
// whyNot's words name the state the version is in ("personal item only, no carry-on"), so they are said as
// its trade-off: "it gives up personal item only" would name the very thing the customer would be left with.
const tradeOff = lost => `the trade-off${lost.length > 1 ? 's' : ''}: ${joinAnd(lost)}`;
function memoryTest(inv, trip, goals, o = {}, amount = 10000) {
  const gs = goalsOf(goals), price = pricer(inv, o), s = trip.spec, base = experienceScore(trip, gs), lo = Math.round(amount * 0.5), hi = Math.round(amount * 1.5), cands = [];
  const add = (kind, p, label, why) => {
    if (!p || crossesLock(p, trip, o) || !fitsSchedule(p, gs)) return; // never across a lock or a stated length; never a schedule conflict or out of season
    const delta = p.total - trip.total, lost = givesUpOf(p, trip);
    if (kind !== 'free' && (delta < lo || delta > hi)) return;
    cands.push({ kind, ...pack(p), delta, gain: r1(experienceScore(p, gs) - base), label, givesUp: lost, text: `${label}, ${signed(delta)}: ${why}${lost.length ? `; ${tradeOff(lost)}` : ''}` });
  };
  for (const a of (trip.activityOptions || []).filter(x => !s.activities.includes(x.id) && goalScore(x, gs) > 0 && runsOn(x, trip))) {
    const p = price(withAct(s, a.id));
    add(tagsOf(a).includes('food') && gs.includes('food') ? 'food' : 'activity', p, a.name, `${a.hours}h for the ${goalLabel(goalOf(a, gs)).toLowerCase()} you ranked #${rankOf(goalOf(a, gs), gs)}`);
  }
  if (s.nights < 14) add('night', price({ ...s, nights: s.nights + 1 }), 'An extra night', `${plural(s.nights + 1, 'night')} instead of ${s.nights}: one more full day`);
  if (!locksOf(o).hotel) for (const h of hotelsOk(trip, { ...o, inv }).filter(h => h.id !== s.hotel && hotelFit(h, gs) > hotelFit(trip.hotel, gs))) add('location', price({ ...s, hotel: h.id }), `${h.name} (${accessWord(h) || 'family-friendly'})`, joinAnd(hotelFitWords(h, gs)));
  if (!locksOf(o).flight) for (const t of timing(trip, o, price)) add('timing', t.p, `${t.flight.name} flights`, `${t.time.usableLabel} instead of ${usableTime(trip).usableLabel}`);
  if (!s.transfer) add('transfer', price({ ...s, transfer: true }), 'An airport transfer', 'the arrival gets easier; the experience score does not move');
  // A free thing is not booked and does not change the trip, so the score cannot see it: freeGain(), said
  // with its source and note, and only when the guide's own condition holds on this trip's dates.
  const free = freeThings(inv, trip.dest, gs, trip);
  if (free) for (const it of free.items.filter(x => x.matches && x.onDates === true)) cands.push({ kind: 'free', ...pack(trip), delta: 0, gain: freeGain(it, gs), label: it.name, free: it, source: free.source, checkedAt: free.checkedAt, givesUp: [], text: `${it.name}, +$0: ${freeNote(it)}; matches the ${goalLabel(it.matches).toLowerCase()} you ranked #${rankOf(it.matches, gs)}, free according to ${free.source} as of ${longDate(free.checkedAt)}` });
  // The maximum is a ceiling, not a target: a paid version over it is marked (`over`, and `overBy` in cents; a free thing
  // changes no price, so it never is), the pick is the biggest difference among the versions that fit, and a bigger one
  // over the ceiling is named with its amount as the customer's call (`overChoice`), never picked.
  const cap = capOf(null, o), amt = fmt(amount);
  for (const c of cands) { c.overBy = c.kind !== 'free' && cap !== null ? Math.max(0, c.total - cap) : 0; c.over = c.overBy > 0; }
  cands.sort((a, b) => b.gain - a.gain || a.delta - b.delta);
  const best = cands.find(c => c.gain > 0) || null, pick = cands.find(c => c.gain > 0 && !c.over) || null, overChoice = best && best.over ? best : null;
  const said = c => `${c.label}, ${c.kind === 'free' ? '+$0' : signed(c.delta)}: ${clause(c.text.split(': ').slice(1).join(': '))}`;
  let text = pick ? `Where about ${amt} makes the biggest difference: ${said(pick)}.` : `Nothing priced within about ${amt} makes this trip more memorable by what you told me; I'd keep the money.`;
  if (overChoice) {
    const max = fmt(cap), more = `${overChoice.label} (${signed(overChoice.delta)})`, by = fmt(overChoice.overBy);
    text = trip.total > cap
      ? `This trip is already ${fmt(trip.total - cap)} over your ${max} maximum. ${pick ? `Where about ${amt} makes the biggest difference without adding to that: ${said(pick)}.` : 'I would add nothing that costs more.'} ${more} would make the most difference, but it takes the trip ${by} over your maximum; going over is your call.`
      : pick ? `Where about ${amt} makes the biggest difference within your ${max} maximum: ${said(pick)}. ${more} would make more, but it is ${by} over your maximum; going over is your call.`
        : `Within your ${max} maximum, nothing priced within about ${amt} makes this trip more memorable by what you told me; I'd keep the money. ${more} would make the biggest difference, but it is ${by} over your maximum; going over is your call.`;
  }
  return { candidates: cands, pick, overChoice, amount, cap, text };
}

// ---- GIVE ME ONE AMAZING THING ----------------------------------------------------------------
function oneBigThing(inv, q, goals, o = {}) {
  // A new build around one experience (an explicit ask): not held to an experience protected on another trip.
  const gs = goalsOf(goals), cap = capOf(q, o), res = experienceSearch(inv, q, gs, { ...o, protect: null, ctx: null });
  const acts = res.destinations.flatMap(d => (d.match.met.some(x => x.key === gs[0]) || gs[0] === 'surprise' || gs[0] === 'new' ? memoInventory(inv).activities.search({ destId: d.dest.id, date: today(nowOf(o)), travelers: q.travelers }).map(a => ({ a, dest: d.dest, met: d.match.met.length })) : []));
  acts.sort((x, y) => goalScore(y.a, gs) - goalScore(x.a, gs) || (y.a.hours >= BIG) - (x.a.hours >= BIG) || y.met - x.met || y.a.hours - x.a.hours);
  for (const { a, dest } of acts.filter(x => goalScore(x.a, gs) > 0)) {
    const t = res.candidates.filter(c => c.dest === dest.id && (cap === null || c.total <= cap) && sameSet(c.trip.spec.activities, [a.id])).sort((x, y) => x.total - y.total)[0];
    if (!t) continue;
    const rh = rhythm(t.trip, gs, { main: a }), day = rh.placed.find(p => p.activity.id === a.id).day, u = usableTime(t.trip);
    const why = `${a.name} is the strongest single experience for what you told me: ${goalLabel(goalOf(a, gs)).toLowerCase()} ranked #${rankOf(goalOf(a, gs), gs)}, ${a.hours}h${a.hours >= BIG ? ', a full-day experience' : ''}${a.months ? `, running in ${monthList(a.months)}` : ''}. It has its own full day (${longDate(day.date)}), not your arrival or departure day${EVENING(a) && u ? `, and the flight home leaves at ${u.lastDay.depart}` : ''}; ${fmt(t.total)} in all${cap !== null ? `, ${fmt(cap - t.total)} under your ${fmt(cap)}` : ''}.`;
    return { main: a, ...t, day, why, protection: protection(inv, t.trip, a, o), rhythm: rh };
  }
  return { main: null, trip: null, day: null, why: `No single experience for ${joinAnd(gs.map(goalLabel)) || 'your goals'} could be built into a trip${cap !== null ? ` at or under ${fmt(cap)}` : ''} with its own full day.`, protection: null };
}

// ---- PACK THE TRIP -------------------------------------------------------------------------------
function packTrip(inv, trip, goals, o = {}) {
  const gs = goalsOf(goals), cap = capOf(null, o), price = pricer(inv, o), added = [];
  let cur = trip;
  for (const a of (trip.activityOptions || []).filter(x => !trip.spec.activities.includes(x.id) && goalScore(x, gs) > 0 && runsOn(x, trip)).sort(byStrength(gs))) {
    if (cur.activities.length + 1 > rhythm(cur, gs).fullDays - 1) break;
    const p = price(withAct(cur.spec, a.id));
    if (!p || (cap !== null && p.total > cap)) continue;
    if (!fitsSchedule(p, gs) || rhythm(p, gs).openDays < 1) continue; // each on a day it runs, one day kept open
    cur = p; added.push(a);
  }
  const r = rhythm(cur, gs);
  return { ...pack(cur), added, delta: cur.total - trip.total, text: `I stopped at ${cur.activities.length}: this trip has ${plural(r.fullDays, 'full day')} and I keep one open.` };
}

// ---- ONE BIG MEMORY vs MORE THINGS TO DO ---------------------------------------------------------
function bigVsMany(inv, trip, goals, o = {}) {
  const gs = goalsOf(goals), price = pricer(inv, o), s = trip.spec, T = s.travelers;
  // Both sides keep the protected experience (when the trip has it) and compare what goes beside it.
  const px = protectOf(o), base = px && s.activities.includes(px) ? [px] : [];
  const pool = (trip.activityOptions || []).filter(x => goalScore(x, gs) > 0 && runsOn(x, trip) && !base.includes(x.id));
  const big = pool.filter(x => x.hours >= BIG).sort((x, y) => y.pricePerPerson - x.pricePerPerson)[0] || null;
  const A0 = big && price({ ...s, activities: [...base, big.id].sort() }), A = A0 && fitsSchedule(A0, gs) ? A0 : null;
  const a = A ? { activity: big, ...pack(A), delta: A.total - trip.total, cost: big.pricePerPerson * T } : null;
  let b = null;
  if (a) {
    const small = pool.filter(x => x.id !== big.id && x.hours < BIG), combos = [];
    for (let i = 0; i < small.length; i++) for (let j = i + 1; j < small.length; j++) { combos.push([small[i], small[j]]); for (let k = j + 1; k < small.length; k++) combos.push([small[i], small[j], small[k]]); }
    const cost = xs => xs.reduce((n, x) => n + x.pricePerPerson * T, 0);
    const near = combos.filter(xs => Math.abs(cost(xs) - a.cost) <= a.cost * 0.15).map(xs => ({ xs, p: price({ ...s, activities: [...base, ...xs.map(x => x.id)].sort() }) })).filter(x => x.p && fitsSchedule(x.p, gs))
      .sort((x, y) => y.xs.reduce((n, z) => n + goalScore(z, gs), 0) - x.xs.reduce((n, z) => n + goalScore(z, gs), 0) || x.p.total - y.p.total)[0];
    if (near) b = { activities: near.xs, ...pack(near.p), delta: near.p.total - trip.total, cost: cost(near.xs) };
  }
  // A big experience that is offered but does not fit this trip is named with the rhythm's reason: "none is
  // offered" would be a check that was never made.
  const off = !big && (trip.activityOptions || []).find(x => goalScore(x, gs) > 0 && x.hours >= BIG && !base.includes(x.id) && x.months);
  const none = big ? `${big.name} (${big.hours}h) is the big experience for your goals in ${trip.dest.name}, but it does not fit this trip: ${(A0 && scheduleWhy(A0, gs, big)) || 'it could not be priced on these dates'}.`
    : off ? `${off.name} (${off.hours}h) is the big experience for your goals in ${trip.dest.name}, but it does not run on these dates (runs ${monthList(off.months)}).`
      : `No big experience (${BIG}h or more) for your goals is offered in ${trip.dest.name}.`;
  const text = !a ? none : `ONE BIG MEMORY: ${big.name} (${big.hours}h, ${fmt(a.cost)} for ${T})${base.length ? ' beside the protected experience' : ' as the one experience'}, ${fmt(a.total)} (${signed(a.delta)} against your trip). ${b ? `MORE THINGS TO DO: ${joinAnd(b.activities.map(x => x.name))} (${b.activities.reduce((n, x) => n + x.hours, 0)}h in all, ${fmt(b.cost)}), ${fmt(b.total)} (${signed(b.delta)}). The two are within 15% of each other on price; your call.` : 'No two or three smaller experiences here come within 15% of its price.'}`;
  return { a, b, text };
}

// ---- FIND FREE THINGS WORTH DOING ------------------------------------------------------------------
function freeOverPaid(inv, trip, goals) {
  // Only an item the guide calls free on this trip's own dates, its note said with it.
  const gs = goalsOf(goals), free = freeThings(inv, trip.dest, gs, trip);
  if (!free) return null;
  const main = mainOf(trip, gs), paid = trip.activities.filter(a => a !== main && goalScore(a, gs) > 0 && goalScore(a, gs) < goalScore(main, gs)).sort((a, b) => goalScore(a, gs) - goalScore(b, gs))[0] || null;
  const item = paid && free.items.find(it => it.matches && it.onDates === true && it.matches === goalOf(paid, gs));
  if (!item) return null;
  return { paid, free: item, source: free.source, checkedAt: free.checkedAt, text: `I found a free option I'd choose over the ${fmt(paid.pricePerPerson)} ${/tour|walk|ticket/i.test(paid.name) ? 'tour' : 'experience'}: ${item.name} (${freeNote(item)}), according to ${free.source} as of ${longDate(free.checkedAt)}.` };
}

// ---- THE BEST DAY FOR THE MAIN EXPERIENCE ----------------------------------------------------------
function bestDay(trip, main, o = {}) {
  const a = resolveAct(trip, main), gs = goalsOf(o.goals || []);
  if (!a) return { day: null, reasons: [{ ok: false, text: 'The main experience is not part of this trip.' }], weather: null };
  const rh = rhythm(trip, gs, { main: a }), hit = rh.placed.find(p => p.activity === a), day = hit ? hit.day : null, u = usableTime(trip), runs = !!day || runsIn(a, rh.days.filter(d => d.full));
  const reasons = [], push = (ok, text) => reasons.push({ ok, text });
  if (!day && runs) push(false, `No full day is free for ${a.name}: ${plural(rh.fullDays, 'full day')} and ${plural(trip.activities.length, 'experience')}.`);
  else { push(true, `Not your arrival day (${longDate(rh.days[trip.flight.arrivesNextDay ? 1 : 0].date)})`); push(true, `Not your departure day (${longDate(rh.days[trip.spec.nights].date)})`); }
  push(false, 'Transport to the meeting point is not in our data');
  const month = monthOf(day ? day.date : trip.spec.depart);
  if (a.months) push(a.months.includes(month), a.months.includes(month) ? `Operating in ${MONTHS[month - 1]} (${monthList(a.months)})` : `Not operating in ${MONTHS[month - 1]}: it runs in ${monthList(a.months)}`); else push(false, 'Operating days are not in our data');
  const inv = o.inv ? memoInventory(o.inv) : null;
  const offered = inv ? inv.activities.search({ destId: trip.spec.dest, date: trip.spec.depart, travelers: trip.spec.travelers }).some(x => x.id === a.id) : trip.activityOptions.some(x => x.id === a.id);
  // The demo partner's search does not read the date: "available" needs the season to hold as well.
  push(offered && runs, !offered ? 'Not offered by the partner for these dates' : runs ? 'Available on the demo partner for these dates' : `Offered by the demo partner, but it does not run on these dates (runs ${monthList(a.months)})`);
  const ev = o.event && day && o.event.date === day.date ? o.event : null;
  push(!ev, ev ? `${ev.name || 'Your reservation'} is on ${longDate(ev.date)}, the same day` : `Nothing you told me is on ${day ? longDate(day.date) : 'that day'}`);
  if (EVENING(a) && u && day === rh.days[trip.spec.nights - 1] && trip.flight.returnDepartMinutes < 9 * 60) push(false, `${a.name} is an evening experience and the flight home leaves at ${hhmm(trip.flight.returnDepartMinutes)} the next morning`);
  let weather = null;
  if (a.weather) {
    const w = inv && inv.weather && typeof inv.weather.outlook === 'function' ? inv.weather.outlook(trip.spec.dest, month) : null;
    weather = w ? `Weather-dependent: ${w.label} for ${MONTHS[month - 1]} according to ${w.source}; the weather itself can't be guaranteed; see the backup.` : 'Weather-dependent: no climate data is available here; the weather itself can\'t be guaranteed; see the backup.';
  }
  return { day, reasons, weather };
}

// ---- LOCATION -----------------------------------------------------------------------------------
function locationCheck(inv, trip, goals, o = {}) {
  const gs = goalsOf(goals), price = pricer(inv, o), s = trip.spec, cap = capOf(null, o);
  if (!gs.includes('beach')) return { a: null, b: null, verdict: null, text: 'Distance from the hotel to your experiences is not in our data (needs verification).', unknown: 'Distance from the hotel to your experiences is not in our data (needs verification).' };
  // A: the cheapest hotel with no beach access; B: the cheapest beachfront one (either may be the trip's own, said as
  // such). The verdict reads the beach goal and the listed location, never stars or brand, and the ceiling: a beachfront
  // version over the maximum (and dearer than this trip) is shown with `over`, never recommended; "go over" decides that.
  const priced = hotelsOk(trip, { ...o, inv }).map(h => price({ ...s, hotel: h.id })).filter(Boolean).sort((x, y) => x.total - y.total);
  const A = priced.find(p => !beachAccess(p.hotel)) || null, B = priced.find(p => p.hotel.features.beachfront) || null;
  const money = p => (p.spec.hotel === s.hotel ? 'Your hotel' : p.total < trip.total ? `Save ${fmt(trip.total - p.total)}` : signed(p.total - trip.total));
  const side = (p, access) => p && { ...pack(p), delta: p.total - trip.total, hotel: p.hotel, own: p.spec.hotel === s.hotel, over: cap !== null && p.total > cap && p.total > trip.total, text: access ? `${money(p)}, beachfront` : `${money(p)}, but not on the beach you said is the point` };
  const a = side(A, false), b = side(B, true), verdictText = b && !b.over ? 'For Experience Max, I\'d use the better location.' : null;
  const text = verdictText || (b ? `The beachfront version (${b.hotel.name}) is ${fmt(b.total - cap)} over your ${fmt(cap)} maximum; within it, I'd keep this hotel. Going over is your call.` : a ? `No beachfront hotel is priced in ${trip.dest.name} inside your rules.` : 'No alternative hotel is priced for these dates.');
  return { a, b, verdict: verdictText, text, unknown: null };
}

// ---- WHY THIS DESTINATION --------------------------------------------------------------------------
function destinationMatch(inv, q, goals, o = {}) {
  // The finalists are each destination's own sweet spot under the ceiling (its ladder's last rung), the
  // pick's first: the destination experienceWays picks, compared on the same footing as the others.
  const gs = goalsOf(goals), cap = capOf(q, o), L = ladder(inv, q, gs, o), res = L.search;
  const stops = (L.chains || []).map(c => c.rungs[c.rungs.length - 1]).filter(r => !L.stop || r.dest !== L.stop.dest).sort((a, b) => b.score - a.score || a.total - b.total);
  const finalists = [...(L.stop ? [L.stop] : []), ...stops].slice(0, 4).map(c => { const d = res.destinations.find(x => x.dest.id === c.dest); return { ...c, dest: d.dest, met: d.match.met, unmet: d.match.unmet }; });
  const pick = finalists[0] || null; if (!pick) return { finalists, why: `No destination could be built for ${joinAnd(gs.map(goalLabel)) || 'your goals'}${cap !== null ? ` at or under ${fmt(cap)}` : ''}.`, whyNot: [] };
  const why = `WHY THIS DESTINATION: ${pick.dest.name} meets ${joinAnd(pick.met.map(m => `${m.label.toLowerCase()} (${m.facts.filter(f => f !== NEW_NOTE).join('; ')})`))}; ${pick.fit.join('; ')}; ${fmt(pick.total)} in all.`;
  const up = t => { const u = usableTime(t); return u ? u.usableMinutes : null; };
  const whyNotLines = finalists.slice(1).map(f => {
    const unmetKey = f.unmet.find(x => !pick.unmet.some(y => y.key === x.key));
    if (unmetKey) return `${f.dest.name}: no ${unmetKey.label.toLowerCase()} experience, style or hotel in its inventory`;
    const kindMissing = gs.find(k => pick.trip.activities.some(a => matches(k, a, gs)) && !f.trip.activities.some(a => matches(k, a, gs)));
    if (kindMissing) return `${f.dest.name}: no ${goalLabel(kindMissing).toLowerCase()} experience in its best version`;
    if (f.total > pick.total) return `${f.dest.name}: ${fmt(f.total - pick.total)} dearer for the same goals`;
    if (up(f.trip) !== null && up(pick.trip) !== null && up(f.trip) < up(pick.trip)) return `${f.dest.name}: less usable time (${usableTime(f.trip).usableLabel} against ${usableTime(pick.trip).usableLabel})`;
    return `${f.dest.name}: a lower experience score for your goals (${f.score} against ${pick.score})`;
  });
  return { finalists, pick, why, whyNot: whyNotLines };
}

// ---- FIND AN ALTERNATIVE EXPERIENCE ---------------------------------------------------------------
function alternative(inv, trip, goals, wanted, o = {}) {
  const gs = goalsOf(goals), cap = capOf(null, o), price = pricer(inv, o), s = trip.spec, m = memoInventory(inv), L = locksOf(o), fixed = L.dates || (o.ctx && o.ctx.dateMode === 'exact');
  const act = wanted && wanted.spec ? null : resolveAct(trip, wanted && wanted.id ? wanted.id : wanted);
  const target = act ? price(withAct(s, act.id)) : wanted && wanted.spec ? wanted : null;
  const ceiling = cap === null ? null : cap, underCap = !!target && (ceiling === null || target.total <= ceiling);
  // "Fits" only when the money and the rhythm both hold it: in season on a day of its own, an open day kept.
  const why = act && target ? scheduleWhy(target, gs, act) : null;
  if (underCap && !why) return { fits: true, wanted: act, ...pack(target), options: [], provider: null, text: `${act ? act.name : 'That version'} fits: ${fmt(target.total)} in all.` };
  const options = [], seen = new Set([encodeSpec(s)]), nearDates = [-3, -2, -1, 1, 2, 3].map(x => addDays(s.depart, x)).filter(d => d >= addDays(today(nowOf(o)), 3));
  const opt = (kind, p, text) => { if (!p || (ceiling !== null && p.total > ceiling) || seen.has(encodeSpec(p.spec)) || crossesLock(p, trip, o) || !fitsSchedule(p, gs)) return; seen.add(encodeSpec(p.spec)); options.push({ kind, ...pack(p), delta: p.total - trip.total, differences: sayDiffs(p, trip), text }); };
  if (act) {
    const kind = act.kind, goal = goalOf(act, gs);
    if (!fixed) for (const d of nearDates) opt('date', price({ ...withAct(s, act.id), depart: d }), `${act.name} leaving ${longDate(d)} instead of ${longDate(s.depart)}`);
    const sameKind = (trip.activityOptions || []).filter(x => x.id !== act.id && x.kind === kind && !s.activities.includes(x.id) && runsOn(x, trip)).sort((x, y) => x.pricePerPerson - y.pricePerPerson);
    for (const x of sameKind.filter(x => x.pricePerPerson < act.pricePerPerson)) opt('similar', price(withAct(s, x.id)), `${x.name} (${kind}, ${x.hours}h) instead of ${act.name}`);
    for (const x of sameKind.filter(x => x.hours < act.hours)) opt('shorter', price(withAct(s, x.id)), `${x.name}: the same kind in ${x.hours}h instead of ${act.hours}h`);
    // Another destination moves the hotel and the flights too: only when none of them is locked.
    if (goal && !L.dest && !L.hotel && !L.flight) {
      for (const dest of m.maps.listDestinations().filter(d => d.id !== s.dest)) {
        const acts = m.activities.search({ destId: dest.id, date: s.depart, travelers: s.travelers }).filter(x => x.kind === kind && matches(goal, x, gs)).sort(byStrength(gs));
        if (!acts.length) continue; let best = null;
        for (const depart of fixed ? [s.depart] : candidateDates(m, { dateMode: 'anytime', nights: s.nights, travelers: s.travelers }, s.from, dest.id, nowOf(o))) {
          const base = { dest: dest.id, from: s.from, depart, nights: s.nights, travelers: s.travelers, who: s.who };
          for (const f of m.flights.search({ from: s.from, destId: dest.id, depart, nights: s.nights, travelers: s.travelers }).filter(x => rulesAllowFlight(x, rulesOf(o)))) for (const h of m.hotels.search({ destId: dest.id, checkIn: depart, nights: s.nights, rooms: roomsFor(base) }).filter(x => hotelAllowed(x, { who: s.who, style: styleOf(o) }) && rulesAllowHotel(x, rulesOf(o)))) {
            const p = price({ ...base, flight: f.id, hotel: h.id, activities: [acts[0].id], bags: false, transfer: false });
            if (p && (!best || p.total < best.total) && fitsSchedule(p, gs)) best = p;
          }
        }
        if (best) opt('destination', best, `${acts[0].name} in ${dest.name} instead of ${trip.dest.name}`);
      }
    }
    const tr = trade(inv, trip, act, { ...o, goals: gs }); if (tr.trip) opt('configuration', tr.trip, tr.text);
  } else if (target && !fixed) {
    // A whole version over the ceiling: the same version on nearby dates (today's prices, never a forecast).
    for (const d of nearDates) opt('date', price({ ...target.spec, depart: d }), `The same version leaving ${longDate(d)} instead of ${longDate(target.spec.depart)}`);
  }
  options.sort((a, b) => a.total - b.total);
  const provider = 'One demo activity partner: there is no second provider to price the same experience with.';
  const head = act && why ? `${cap1(why)}${!underCap && ceiling !== null ? `; with it the trip is ${fmt(target.total)}, over the ${fmt(ceiling)} ceiling` : ''}.` : `${act ? act.name : 'That version'} doesn't fit ${ceiling === null ? 'this trip' : `the ${fmt(ceiling)} ceiling`}${target ? ` (${fmt(target.total)})` : ' as priced'}.`;
  const text = `${head} ${options.length ? `${plural(options.length, 'alternative')} priced inside it.` : 'No alternative was priced inside it.'} ${provider}`;
  return { fits: false, wanted: act, ...(target ? pack(target) : { trip: null, token: null, total: null }), options, provider, text };
}

// ---- SAME FEELING FOR LESS -------------------------------------------------------------------------
function sameFeeling(inv, q, goals, trip, o = {}) {
  // An explicit ask for a different trip: not held to the protected experience (another destination cannot offer it),
  // but held to the locked or fixed dates and the locked or stated length; every change is named in the differences.
  const L = locksOf(o), fixed = L.dates || (o.ctx && o.ctx.dateMode === 'exact');
  const hq = { ...q, dest: null, dests: null, ...(fixed ? { dateMode: 'exact', depart: trip.spec.depart, month: null } : {}), ...(L.nights || L.dates ? { nights: trip.spec.nights } : {}) };
  const gs = goalsOf(goals), res = experienceSearch(inv, hq, gs, { ...o, protect: null, ctx: o.ctx ? { ...o.ctx, protect: null } : null });
  const here = res.destinations.find(d => d.dest.id === trip.dest.id), need = here ? here.match.met.map(x => x.key) : gs.slice(0, 1);
  const alt = res.candidates.filter(c => c.dest !== trip.dest.id && c.total < trip.total && c.main && goalScore(c.main, gs) >= Math.max(1, goalScore(mainOf(trip, gs) || { kind: '' }, gs)))
    .filter(c => { const d = res.destinations.find(x => x.dest.id === c.dest); return need.every(k => d.match.met.some(x => x.key === k)); }).sort((a, b) => a.total - b.total)[0] || null;
  if (!alt) return { trip: null, token: null, total: null, differences: [], text: 'Nothing elsewhere meets the same goals for less.' };
  // Every difference is said before the customer takes it: every row classifyChanges reads (sayDiffs:
  // dates, bags, cancellation, usable time included) and the experiences by name, since two trips with
  // the same count are never the same experiences.
  const names = t => (t.activities.length ? joinAnd(t.activities.map(a => a.name)) : 'no paid experience');
  const diffs = [...sayDiffs(alt.trip, trip), ...(sameSet(alt.trip.activities.map(a => a.name), trip.activities.map(a => a.name)) ? [] : [`${names(alt.trip)} instead of ${names(trip)}`])];
  return { ...alt, delta: alt.total - trip.total, differences: diffs, givesUp: givesUpOf(alt.trip, trip), text: `Different trip. Similar goal. ${joinAnd(diffs)}; ${fmt(alt.total)} instead of ${fmt(trip.total)}.` };
}

// ---- a cheaper experience of the same kind ---------------------------------------------------------
const NO_DUPE = 'No alternative I\'d call similar.';
function dupe(inv, trip, activity, o = {}) {
  const a = resolveAct(trip, activity && activity.id ? activity.id : activity), price = pricer(inv, o), s = trip.spec;
  if (!a) return null;
  const cheaper = (trip.activityOptions || []).filter(x => x.id !== a.id && !s.activities.includes(x.id) && x.pricePerPerson < a.pricePerPerson);
  const alt = cheaper.filter(x => x.kind === a.kind && runsOn(x, trip)).sort((x, y) => x.pricePerPerson - y.pricePerPerson)[0] || null;
  if (!alt) return { alternative: null, similar: [], different: [], delta: 0, trip: null, token: null, total: null, text: NO_DUPE };
  const similar = [`same kind: ${a.kind}`, ...tagsOf(a).filter(t => t !== a.kind && tagsOf(alt).includes(t)).map(t => `same tag: ${t}`), ...(Math.abs(a.hours - alt.hours) <= 2 ? [`hours within 2h (${a.hours}h and ${alt.hours}h)`] : [])];
  const different = [...(Math.abs(a.hours - alt.hours) > 2 ? [`${alt.hours}h instead of ${a.hours}h`] : []), ...((alt.slot || 'day') !== (a.slot || 'day') ? [`a ${alt.slot || 'day'} slot instead of ${a.slot || 'day'}`] : []), ...(!!alt.weather !== !!a.weather ? [alt.weather ? 'weather-dependent, which yours is not' : 'not weather-dependent, which yours is'] : []), `a different experience: ${alt.name}`];
  const p = price({ ...s, activities: uniq([...s.activities.filter(x => x !== a.id), alt.id]).sort() });
  return { alternative: alt, similar, different, delta: p ? p.total - trip.total : null, ...(p ? pack(p) : { trip: null, token: null, total: null }), text: `${alt.name} is ${fmt(a.pricePerPerson - alt.pricePerPerson)} a person less than ${a.name}. Similar: ${joinAnd(similar)}. Different: ${joinAnd(different)}.${p ? ` ${fmt(p.total)} with the swap (${signed(p.total - trip.total)}).` : ''}` };
}

// ---- the hotel-upgrade challenge --------------------------------------------------------------------
const STAY_KEYS = new Set(['hotel', 'area', 'meals', 'flex']);
function challengeUpgrade(trip, upgrade, goals, inv = null, o = {}) {
  const gs = goalsOf(goals), up = (upgrade && upgrade.trip) || upgrade;
  if (!up || !up.spec) return { challenge: false, text: 'No priced upgrade to compare.', delta: null, instead: null };
  const ch = classifyChanges(trip, up, { date: longDate }), delta = up.total - trip.total, gain = r1(experienceScore(up, gs) - experienceScore(trip, gs));
  const stayOnly = ch.improvements.length > 0 && ch.improvements.every(r => STAY_KEYS.has(r.key)) && ch.tradeoffs.length === 0;
  // "You told me the trip itself matters more than the room" only when it is true: never after the customer asked for
  // the stay (stayAskedOf: a hotel priority, an all-inclusive or luxury style, o.statedStay, a learned "worth it").
  const stay = stayAskedOf(null, o || {}), challenge = stayOnly && gain <= 0 && !stay.asked;
  const instead = inv && delta > 0 && challenge ? memoryTest(inv, trip, gs, o, delta) : null;
  const changes = `This version changes ${joinAnd([...ch.improvements, ...ch.neutral, ...ch.tradeoffs].map(rowText)) || 'nothing the comparison reads'}; it's your call.`;
  const text = challenge ? 'You told me the trip itself matters more than the room. I\'d keep the standard room and use the money outside the hotel.' : gain > 0 ? `This upgrade also serves what you told me (${joinAnd(hotelFitWords(up.hotel, gs))}); it's your call.` : stay.why ? `${stay.why}, so I won't argue against a better hotel. ${changes}` : changes;
  return { challenge, text, delta, gain, improvements: ch.improvements, instead, stayAsked: stay.asked };
}

// ---- is this experience worth it ---------------------------------------------------------------------
const cancelWords = a => (Number.isFinite(a.freeCancelHours) ? `free cancellation until ${a.freeCancelHours} hours before` : 'not in our data');
function valueCheck(inv, trip, activity, goals) {
  const gs = goalsOf(goals), a = resolveAct(trip, activity && activity.id ? activity.id : activity), T = trip.spec.travelers;
  if (!a) return { rows: [], text: 'That experience is not offered for this trip.' };
  const rh = rhythm(trip, gs), hit = rh.placed.find(p => p.activity.id === a.id), openDay = rh.days.find(d => d.open) || null;
  const goal = goalOf(a, gs), row = (key, value, known) => ({ key, value, known });
  const rows = [
    row('price', `${fmt(a.pricePerPerson)} a person, ${fmt(a.pricePerPerson * T)} for ${T}`, true), row('duration', `${a.hours}h${a.slot && a.slot !== 'day' ? `, ${a.slot} slot` : ''}`, true), row('transport', 'not in our data', false),
    { key: 'scheduling', value: hit ? `${hit.day.label}, day ${hit.day.n} (${longDate(hit.day.date)})` : openDay ? `an open full day: day ${openDay.n} (${longDate(openDay.date)})` : 'no full day free', known: true },
    { key: 'included', value: a.policy ? `partner terms: ${a.policy} What's included is not in our data` : 'what\'s included is not in our data', known: false },
    row('cancellation', cancelWords(a), Number.isFinite(a.freeCancelHours)), { key: 'priority', value: goal ? `the ${goalLabel(goal).toLowerCase()} you ranked #${rankOf(goal, gs)}` : 'outside the goals you gave me', known: true },
  ];
  return { rows, activity: a, text: `${a.name}: ${rows.map(r => `${r.key} ${r.value}`).join('; ')}.` };
}

// ---- SCHEDULE CONFLICT ------------------------------------------------------------------------------
// Fixes are priced where a token exists (a later flight home inside the rules, the trip without the
// experience, other dates for an event), never across a lock, and the protected experience is never
// priced away: its fix says it stays unless the customer drops it.
const slotWords = slot => (slot === 'night' ? 'a night' : slot === 'evening' ? 'an evening' : `a ${slot || 'day'}`);
function collisions(trip, { event = null, inv = null, settings = null, goals = [], protect = null, rules = null, locks = {} } = {}) {
  const gs = goalsOf(goals), rh = rhythm(trip, gs), f = trip.flight, u = usableTime(trip), out = [];
  const price = inv ? pricer(inv, { settings: settings || DEFAULT_SETTINGS }) : null;
  const laterFlights = () => (price && !(locks && locks.flight) ? (trip.flightOptions || []).filter(x => x.id !== trip.spec.flight && x.returnDepartMinutes >= 9 * 60 && rulesAllowFlight(x, rules)).map(x => price({ ...trip.spec, flight: x.id })).filter(Boolean).sort((x, y) => x.total - y.total) : []);
  const flightFix = p => ({ kind: 'flight', ...pack(p), delta: p.total - trip.total, text: `${p.flight.name} flights home at ${hhmm(p.flight.returnDepartMinutes)}: ${signed(p.total - trip.total)}` });
  const without = a => {
    if (a.id === protect) return { kind: 'remove', trip: null, protected: true, text: `${a.name} is the protected experience: it stays unless you say to drop it` };
    const p = price ? price(withoutAct(trip.spec, a.id)) : null;
    return p ? { kind: 'remove', ...pack(p), delta: p.total - trip.total, text: `Without ${a.name}: ${signed(p.total - trip.total)}` } : { kind: 'remove', trip: null, text: `Without ${a.name}` };
  };
  for (const a of rh.lateThenEarly) {
    const fixes = [...laterFlights().slice(0, 1).map(flightFix), without(a), { kind: 'move', trip: null, text: `${a.name} on an earlier day, if another full day opens up` }];
    out.push({ kind: 'late-then-early', activity: a, text: `SCHEDULE CONFLICT: ${a.name} is ${slotWords(a.slot)} experience and your flight home leaves at ${hhmm(f.returnDepartMinutes)}.`, fixes });
  }
  // An experience with no full day of its own, named by the fact that leaves it out: a season that misses every full day
  // ('season'); free full days it cannot take, each with its reason ('slot'); or no free full day at all, a big one
  // against the arrival day and the rest together as too many. Each experience appears in one conflict only.
  if (rh.unplaced.length) {
    const fd = rh.days.filter(d => d.full), free = fd.filter(d => !d.items.length), off = rh.unplaced.filter(a => !runsIn(a, fd)), left = rh.unplaced.filter(a => !off.includes(a));
    for (const a of off) out.push({ kind: 'season', activity: a, text: `SCHEDULE CONFLICT: ${a.name} does not run on these dates: it runs in ${monthList(a.months)}, and ${fd.length ? `none of this trip's full days (${dayRange(fd)}) falls in it` : 'this trip has no full day'}.`, fixes: [without(a)] });
    const dayWhy = (a, d) => { const i = rh.days.indexOf(d), prev = rh.days[i - 1], next = rh.days[i + 1]; const on = longDate(d.date); return !inSeason(a, d.date) ? `${on} is outside its season (${monthList(a.months)})` : a.slot === 'morning' && prev && EVENING({ slot: prev.slot }) ? `${on} follows an evening experience (${prev.items.join(', ')}), and a morning one never comes after it` : `${on} is the night before a morning experience (${next.items.join(', ')})`; };
    if (free.length) for (const a of left) out.push({ kind: 'slot', activity: a, text: `SCHEDULE CONFLICT: ${a.name} fits no free full day: ${joinAnd(free.map(d => dayWhy(a, d)))}.`, fixes: [without(a)] });
    else {
      const big = left.filter(a => a.hours >= BIG), rest = left.filter(a => a.hours < BIG);
      for (const a of big) out.push({ kind: 'arrival-day', activity: a, text: `SCHEDULE CONFLICT: ${a.name} needs a full day and the only day left is your arrival day (${longDate(rh.days[f.arrivesNextDay ? 1 : 0].date)}).`, fixes: [without(a)] });
      if (rest.length) out.push({ kind: 'too-many', activities: rest, text: `SCHEDULE CONFLICT: ${plural(trip.activities.length, 'experience')} for ${plural(rh.fullDays, 'full day')}; ${joinAnd(rest.map(a => a.name))} ${rest.length === 1 ? 'has' : 'have'} no full day.`, fixes: rest.map(without) });
    }
  }
  const ev = eventCollision(trip, event);
  if (ev) {
    const range = eventRange(event, trip.spec.nights, trip.flight), moved = price && range.from && !(locks && locks.dates) ? [range.to, range.from].map(d => price({ ...trip.spec, depart: d })).filter(p => p && !eventCollision(p, event)).sort((x, y) => x.total - y.total)[0] : null;
    out.push({ ...ev, fixes: [moved ? { kind: 'move', ...pack(moved), delta: moved.total - trip.total, text: `Leaving ${longDate(moved.spec.depart)} instead of ${longDate(trip.spec.depart)}, home ${longDate(addDays(moved.spec.depart, trip.spec.nights))}: ${signed(moved.total - trip.total)}` } : { kind: 'move', trip: null, text: range.text }] });
  }
  if (u && out.length === 0 && event && event.slot && EVENING(event) && event.date === rh.days[trip.spec.nights - 1].date && f.returnDepartMinutes < 9 * 60) out.push({ kind: 'event', text: `SCHEDULE CONFLICT: ${event.name || 'your reservation'} is in the ${event.slot} and your flight home leaves at ${hhmm(f.returnDepartMinutes)} the next morning.`, fixes: laterFlights().slice(0, 1).map(flightFix) });
  return out;
}

// ---- very scheduled ---------------------------------------------------------------------------------
function fatigue(trip, goals, o = {}) {
  const gs = goalsOf(goals), rh = rhythm(trip, gs), acts = trip.activities, reasons = [];
  if (acts.length > rh.fullDays - 1) reasons.push(`${plural(acts.length, 'experience')} for ${plural(rh.fullDays, 'full day')}: more than full days minus one`);
  if (acts.filter(a => a.hours >= 8).length >= 2) reasons.push(`${acts.filter(a => a.hours >= 8).length} experiences of 8h or more`);
  if (rh.openDays === 0) reasons.push('no open day');
  if (acts.filter(a => a.slot === 'morning').length >= 2) reasons.push(`${acts.filter(a => a.slot === 'morning').length} morning slots`);
  const scheduled = reasons.length > 0; let freeTime = null;
  const main = mainOf(trip, gs), px = protectOf(o), lowest = acts.filter(a => a !== main && a.id !== px).sort((a, b) => goalScore(a, gs) - goalScore(b, gs) || a.hours - b.hours)[0] || null;
  if (scheduled && lowest) { const p = o.inv ? pricer(o.inv, o)(withoutAct(trip.spec, lowest.id)) : null; freeTime = { ...(p ? pack(p) : { trip: null, token: null, total: null }), removed: lowest, delta: p ? p.total - trip.total : null }; }
  return { scheduled, reasons, text: scheduled ? 'This itinerary is very scheduled. I can open up a day without changing the main experiences.' : `This itinerary leaves ${plural(rh.openDays, 'open day')}; nothing here is overloaded.`, freeTime };
}

// ---- SURPRISE ME --------------------------------------------------------------------------------------
function surpriseOne(inv, trip, goals, rules, o = {}) {
  const gs = goalsOf(goals), cap = capOf(null, o), price = pricer(inv, { ...o, rules: rules || rulesOf(o) }), s = trip.spec;
  const pool = (trip.activityOptions || []).filter(a => !s.activities.includes(a.id) && goalScore(a, gs) === 0 && runsOn(a, trip)).sort((a, b) => b.hours - a.hours || a.pricePerPerson - b.pricePerPerson);
  for (const a of pool) {
    const p = price(withAct(s, a.id)); if (!p || (cap !== null && p.total > cap) || !fitsSchedule(p, gs)) continue; // on a day it runs, one day kept open
    const day = rhythm(p, gs).placed.find(x => x.activity.id === a.id).day;
    // "In season" only from the partner's months on the day it falls on; without months, said as unknown.
    // The kinds are named as the experience's own ("its kind: adventure, nature"): a bare "(adventure, nature)"
    // after "what you asked for" reads as what the customer asked for.
    return { activity: a, ...pack(p), delta: p.total - trip.total, day, why: `outside what you asked for (its kind: ${a.kind}${tagsOf(a).filter(t => t !== a.kind).length ? `, ${tagsOf(a).filter(t => t !== a.kind).join(', ')}` : ''}), ${a.months ? `in season on ${longDate(day.date)} (runs ${monthList(a.months)})` : 'its operating days are not in our data'}, on a day that was open (${longDate(day.date)}); ${signed(p.total - trip.total)}` };
  }
  return { activity: null, trip: null, token: null, total: null, delta: null, why: `No experience outside your goals fits an open day of this trip${cap !== null ? ` at or under ${fmt(cap)}` : ''} with one day still open.` };
}
function surpriseCompletely(inv, q, o = {}) {
  // What changes about the requirements is said: abroad, a passport for every traveler and entry rules by nationality
  // (the review page's Travel documents check). "Nothing new is required" only at home or in the country of o.current.
  const ways = experienceWays(inv, q, ['surprise'], { ...o, protect: null, ctx: null });
  const required = ways.pick ? ways.pick.trip.policies : [], t = ways.pick ? ways.pick.trip : null, cur = o.current && (o.current.trip || o.current);
  const terms = `the review page's terms are the ones the quote already carries (${required.length} ${required.length === 1 ? 'policy' : 'policies'})`;
  const abroad = !!(t && t.internationalTrip && !(cur && cur.internationalTrip && cur.dest && cur.dest.country === t.dest.country));
  const docs = abroad ? `${t.dest.name} is in ${t.dest.country}, an international trip: every traveler needs a valid passport, and entry rules depend on nationality; the review page's Travel documents check lists what to verify before booking. Beyond that, ${terms}.` : `Nothing new is required of you: ${terms}.`;
  return { ...ways, required, passport: abroad, text: `${ways.reason} ${docs}` };
}

// ---- the downsell ------------------------------------------------------------------------------------
function downsell(inv, trip, goals, o = {}) {
  const gs = goalsOf(goals), price = pricer(inv, o), s = trip.spec; if (locksOf(o).hotel) return null;
  // "Meets your requirements" is true by construction: the style, every stated hotel rule (hotelsOk) and no less of the
  // access the goals ask for; anything else it gives up (meals, stars, the cancellation terms) is said in the sentence.
  const cheaper = hotelsOk(trip, { ...o, inv }).filter(h => h.id !== s.hotel && hotelFit(h, gs) >= hotelFit(trip.hotel, gs)).map(h => price({ ...s, hotel: h.id })).filter(p => p && p.total < trip.total).sort((a, b) => a.total - b.total)[0] || null;
  if (!cheaper) return null;
  const saved = trip.total - cheaper.total, lost = givesUpOf(cheaper, trip);
  // The best goal experience the rhythm can hold, named by its goal's rank ("ranked #1" only when it is goal #1's).
  let top = null, withExp = null;
  for (const a of bestAdditions(trip, gs, 99)) { const p = price(withAct(cheaper.spec, a.id)); if (p && fitsSchedule(p, gs)) { top = a; withExp = p; break; } }
  const covers = withExp ? withExp.total <= trip.total : false, g = top ? goalOf(top, gs) : null, which = top ? `the ${goalLabel(g).toLowerCase()} experience you ranked #${rankOf(g, gs)}` : null;
  const text = `I found another hotel that meets your requirements for ${fmt(saved)} less: ${cheaper.hotel.name}${lost.length ? `; ${tradeOff(lost)}` : ''}.${top ? covers ? ` That ${fmt(saved)} can cover ${which}: ${top.name}, ${fmt(withExp.total)} in all.` : ` ${top.name}, ${which}, costs ${fmt(withExp.total - trip.total)} more than that saving: ${fmt(withExp.total)} with it.` : ' No goal experience that fits a free day, with one day still open, is left to add.'}`;
  return { cheaper: cheaper.hotel, saved, givesUp: lost, experience: top, ...(withExp ? pack(withExp) : pack(cheaper)), covers, hotelOnly: pack(cheaper), text };
}

// ---- BUILD AROUND AN EVENT -----------------------------------------------------------------------------
// The buffer is counted from the day the traveler lands, not the day they leave: an overnight flight lands the next day,
// so an event that day has no day before it ("arrive at the latest the day before"). landing() is what the agent says as
// "you land"; eventBuffer() says whether a version leaves the buffer either side.
function landing(trip) {
  const f = trip.flight || {}, next = !!f.arrivesNextDay;
  return { date: addDays(trip.spec.depart, next ? 1 : 0), nextDay: next, time: Number.isFinite(f.arriveMinutes) ? clock(f.arriveMinutes) : null, depart: trip.spec.depart, home: addDays(trip.spec.depart, trip.spec.nights) };
}
const validEvent = e => !!e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || ''));
function eventRange(event, nights, flight = null) {
  const f = flight && flight.flight ? flight.flight : flight, lag = f && f.arrivesNextDay ? 1 : 0;
  if (!validEvent(event)) return { from: null, to: null, latestDepart: null, earliestReturn: null, buffer: 1, text: 'No event date to build around.' };
  const landBy = addDays(event.date, -1), latestDepart = addDays(landBy, -lag), earliestReturn = addDays(event.date, 1), from = addDays(earliestReturn, -nights), ok = from <= latestDepart, name = event.name || 'the event';
  return { from: ok ? from : null, to: ok ? latestDepart : null, latestDepart, landBy, earliestReturn, buffer: 1, nights, overnight: !!lag, text: ok ? `Leave between ${longDate(from)} and ${longDate(latestDepart)} (${lag ? `the overnight flight lands the next day, so landing ${longDate(landBy)}, ` : ''}a day before ${name} at the latest) and fly home ${longDate(earliestReturn)} or later (a day after at the earliest): ${plural(nights, 'night')} covers it.` : `${plural(nights, 'night')} cannot both ${lag ? 'land' : 'arrive'} a day before ${longDate(event.date)} and leave a day after it${lag ? ' on an overnight flight' : ''}; ${plural(2 + lag, 'night')} is the minimum.` };
}
function eventCollision(trip, event) {
  if (!validEvent(event)) return null;
  const s = trip.spec, L = landing(trip), ret = L.home, inside = event.date > L.date && event.date < ret; if (inside) return null;
  const where = event.date === L.date ? `on your arrival day${L.nextDay ? ` (the overnight flight lands${L.time ? ` at ${L.time}` : ''} that day)` : ''}` : event.date < L.date ? 'before you arrive' : event.date === ret ? 'on your departure day' : 'after you fly home';
  return { kind: 'event', event, landing: L, text: `SCHEDULE CONFLICT: ${event.name || 'your reservation'} on ${longDate(event.date)} falls ${where}; the dates ${longDate(s.depart)} – ${longDate(ret)} don't cover it with a day's buffer.` };
}
// For the agent: the landing date and whether this version leaves a day's buffer either side.
function eventBuffer(trip, event) {
  const L = landing(trip), clash = eventCollision(trip, event);
  return { landing: L.date, landTime: L.time, nextDay: L.nextDay, home: L.home, ok: !clash, clash, text: clash ? clash.text : `you land ${longDate(L.date)}${L.nextDay ? `${L.time ? ` at ${L.time}` : ''}, the day after you leave (an overnight flight)` : ''} and fly home ${longDate(L.home)}: a day's buffer either side of ${event.name || 'it'} on ${longDate(event.date)}` };
}

// ---- PROTECTION ----------------------------------------------------------------------------------------
function protection(inv, trip, main, o = {}) {
  const a = resolveAct(trip, main && main.id ? main.id : main), checked = today(nowOf(o)), checkedOn = longDate(checked), leave = longDate(trip.spec.depart); // checkedAt stays ISO data
  if (!a) return { rows: [], text: 'No main experience to check.' };
  const m = memoInventory(inv), offered = m.activities.search({ destId: trip.spec.dest, date: trip.spec.depart, travelers: trip.spec.travelers }).find(x => x.id === a.id) || null;
  // Availability is verified only when the partner offers it AND it runs on the day the rhythm gives it (the demo search
  // does not read the date); the operating row only when the season holds. Out of season is a blocker.
  const rh = rhythm(trip, goalsOf(o.goals || (o.ctx && o.ctx.goals) || []), { main: a }), hit = rh.placed.find(p => p.activity === a) || null, fd = rh.days.filter(d => d.full);
  const runs = !a.months || !!hit || runsIn(a, fd), months = uniq((fd.length ? fd : [{ date: trip.spec.depart }]).map(d => MONTHS[monthOf(d.date) - 1]));
  const rows = [
    { key: 'availability', value: !offered ? `not offered by the partner for ${leave}` : runs ? `available on the demo partner for ${leave} (re-checked ${checkedOn})` : `offered by the demo partner, but it does not run on these dates (runs ${monthList(a.months)})`, verified: !!offered && runs },
    { key: 'operating', value: a.months ? (runs ? `in season ${hit ? `on ${longDate(hit.day.date)}` : `for ${joinAnd(months)}`} (runs ${monthList(a.months)})` : `out of season for ${joinAnd(months)} (runs ${monthList(a.months)})`) : 'operating days not in our data', verified: !!a.months && runs },
    ...[['age', 'not in our data: needs verification', false], ['restrictions', 'not in our data: needs verification', false], ['meeting', 'on the voucher; not in our data before booking', false], ['duration', `${a.hours}h`, true],
      ['cancellation', cancelWords(a), Number.isFinite(a.freeCancelHours)], ['transport', 'not in our data', false]].map(([key, value, verified]) => ({ key, value, verified })),
  ];
  const GAP = { availability: 'availability', operating: 'operating days', age: 'age requirements', restrictions: 'current restrictions', meeting: 'the meeting location', duration: 'the duration', cancellation: 'the cancellation terms', transport: 'transport to it' };
  const gaps = rows.filter(r => !r.verified).map(r => GAP[r.key]);
  const text = !offered ? `The main experience could not be re-checked on ${checkedOn}: ${a.name} is not offered by the partner for ${leave}.` : !runs ? `${a.name} does not run on these dates (${dayRange(fd)}; it runs in ${monthList(a.months)}): this trip should not be built around it.` : `Never built around an unverified experience: the main experience was re-checked on ${checkedOn}. Still to verify before booking: ${joinAnd(gaps)}.`;
  return { rows, activity: a, checkedAt: checked, blocked: !offered || !runs, text };
}

// ---- BACKUP ---------------------------------------------------------------------------------------------
function backup(inv, trip, main, o = {}) {
  const gs = goalsOf(o.goals || []), a = resolveAct(trip, main && main.id ? main.id : main);
  if (!a || !a.weather) return null;
  const price = pricer(inv, o), s = trip.spec, hit = rhythm(trip, gs, { main: a }).placed.find(p => p.activity === a), runsThatDay = x => (hit ? inSeason(x, hit.day.date) : runsOn(x, trip)); // the fallback for that day runs that day
  const pool = (trip.activityOptions || []).filter(x => x.id !== a.id && !s.activities.includes(x.id) && !x.weather && x.kind !== a.kind && (['culture', 'relaxing'].includes(x.kind) || tagsOf(x).includes('food')) && runsThatDay(x)).sort((x, y) => goalScore(y, gs) - goalScore(x, gs) || x.pricePerPerson - y.pricePerPerson);
  if (!pool.length) return { activity: null, trip: null, token: null, total: null, delta: null, over: false, overBy: 0, overChoice: null, text: `Weather can't be guaranteed. No experience of another kind that does not depend on the weather is offered in ${trip.dest.name} as a fallback for ${a.name}.` };
  // The maximum is a ceiling, not a target: the fallback is the first for the goals whose version fits it. When the first
  // fits only over it, that one is named with its amount as the customer's call (`overChoice`), never as the fallback; when
  // none fits, the first is said with what it takes over the maximum. Each version carries `over` and `overBy` (cents).
  const cap = capOf(null, o), overBy = p => (p && cap !== null ? Math.max(0, p.total - cap) : 0);
  let first = null, chosen = null;
  for (const x of pool) { const c = { x, p: price(withAct(s, x.id)) }; first = first || c; if (c.p && !overBy(c.p)) { chosen = c; break; } }
  chosen = chosen || first;
  const version = c => ({ activity: c.x, ...(c.p ? pack(c.p) : { trip: null, token: null, total: null }), delta: c.p ? c.p.total - trip.total : null, over: overBy(c.p) > 0, overBy: overBy(c.p) });
  const v = version(chosen), oc = chosen !== first && overBy(first.p) ? version(first) : null, alt = chosen.x;
  const head = `Weather can't be guaranteed. If ${a.name} is called off, ${alt.name} is the fallback I'd book that day${oc ? ` within your ${fmt(cap)} maximum` : ''}; it is not added unless you say so.`;
  const tail = oc ? ` ${oc.activity.name} would be my first fallback for your goals, but with it the trip is ${fmt(oc.overBy)} over your maximum; going over is your call.` : v.over ? ` With it the trip is ${fmt(v.overBy)} over your ${fmt(cap)} maximum; going over is your call.` : '';
  return { ...v, overChoice: oc, text: `${head}${tail}` };
}

// ---- WHY THIS TRIP IS BUILT THIS WAY (the receipt) ----------------------------------------------------
// Baseline = the hotel-first version we priced: optimizer.search with priority 'hotel' in the pick's
// destination (the same q otherwise), else the pick's own dearest priced hotel version. The lines are
// facts.lineDiff between the two, so they sum exactly to pick minus baseline; when the nights differ,
// the part of the hotel line that the extra nights account for is its own line.
function receipt(inv, q, pick, goals, o = {}) {
  const gs = goalsOf(goals), settings = settingsOf(o), now = nowOf(o), price = pricer(inv, o), t = pick.trip || pick, max = capOf(q, o);
  let baseline = null, label = 'the hotel-first version we priced';
  try {
    const r = optimizer.search(inv, { ...q, priority: 'hotel', dest: t.dest.id, dests: null, style: t.dest.styles.includes(q.style) || ['surprise', 'all-inclusive'].includes(q.style) ? q.style : 'surprise' }, { settings, now });
    baseline = r.picks[0] ? r.picks[0].trip : null;
  } catch (e) { baseline = null; }
  if (!baseline || encodeSpec(baseline.spec) === encodeSpec(t.spec)) {
    baseline = hotelsOk(t, { ...o, inv }).map(h => price({ ...t.spec, hotel: h.id })).filter(Boolean).sort((a, b) => b.total - a.total)[0] || t;
    label = baseline === t ? 'this trip itself (no dearer hotel version was priced)' : 'the dearest hotel version of this trip we priced';
  }
  const rows = lineDiff(baseline, t), lessOn = [], usedFor = [];
  for (const r of rows) {
    if (!r.delta) continue;
    if (r.key === 'hotel' && t.spec.nights !== baseline.spec.nights) {
      const nightsPart = Math.round((lineAmount(t, 'hotel') / t.spec.nights) * (t.spec.nights - baseline.spec.nights)), rest = r.delta - nightsPart;
      if (nightsPart > 0) usedFor.push({ key: 'nights', label: `${plural(t.spec.nights - baseline.spec.nights, 'extra night')}`, amount: nightsPart }); else if (nightsPart < 0) lessOn.push({ key: 'nights', label: `${plural(baseline.spec.nights - t.spec.nights, 'night')} fewer`, amount: -nightsPart });
      if (rest > 0) usedFor.push({ key: 'hotel', label: r.label, amount: rest }); else if (rest < 0) lessOn.push({ key: 'hotel', label: r.label, amount: -rest });
      continue;
    }
    if (r.delta < 0) lessOn.push({ key: r.key, label: r.label, amount: -r.delta }); else usedFor.push({ key: r.key, label: r.label, amount: r.delta });
  }
  const keep = max === null ? null : max - t.total;
  const goal = `YOUR GOAL: ${gs.length ? joinAnd(gs.map((k, i) => `${goalLabel(k)} (#${i + 1})`)) : 'the most experience from the budget'}`;
  const text = `WHY THIS TRIP IS BUILT THIS WAY. ${goal}. ${lessOn.length ? `WE SPENT LESS ON: ${lessOn.map(l => `${l.label} ${fmt(l.amount)}`).join(', ')}. ` : ''}${usedFor.length ? `WE USED MONEY FOR: ${usedFor.map(l => `${l.label} ${fmt(l.amount)}`).join(', ')}. ` : ''}FINAL ${fmt(t.total)}${max !== null ? `. YOUR MAX ${fmt(max)}. KEEP ${fmt(keep)}` : ''}. Against ${label} (${fmt(baseline.total)}).`;
  return { goal, lessOn, usedFor, final: t.total, max, keep, baseline: { ...pack(baseline), label }, text };
}

// ---- MAKE IT MORE MEMORABLE / MAKE IT BETTER FOR $0 MORE ----------------------------------------------
// Every version of one trip the goals can build in its destination on its date: nights, hotels and
// fares inside the rules and locks, the goal activity sets plus each goal experience added one at a
// time, the transfer either way. Priced in full; used for the paid rungs and the final-check rebuild.
function versionsOf(inv, trip, gs, o = {}, cap = null) {
  const price = pricer(inv, o), s = trip.spec, locks = locksOf(o), rules = rulesOf(o), px = protectOf(o), seen = new Set(), out = [];
  const most = o.q && Number.isFinite(o.q.nights) ? o.q.nights + 1 : s.nights + 1; // the search's own length range: the asked nights, or one more
  const nightsList = locks.nights || locks.dates || o.nightsOpen === false ? [s.nights] : uniq([s.nights, s.nights + 1].filter(n => n <= Math.min(14, Math.max(most, s.nights))));
  const hotels = locks.hotel ? [s.hotel] : uniq([s.hotel, ...hotelsOk(trip, o).map(h => h.id)]), flights = locks.flight ? [s.flight] : uniq([s.flight, ...flightsOk(trip, o).map(f => f.id)]);
  const acts = (trip.activityOptions || []).filter(a => runsOn(a, trip)), transfers = rules && rules.transfer ? [true] : [s.transfer, !s.transfer];
  for (const nights of nightsList) for (const flight of flights) {
    const f = trip.flightOptions.find(x => x.id === flight) || trip.flight, fullDays = Math.max(0, nights - 1 - (f.arrivesNextDay ? 1 : 0));
    const room = Math.max(0, fullDays - 1); // never more experiences than full days − 1: an open day stays
    const sets = [s.activities, ...withPx(goalSets(acts, gs, fullDays), px, fullDays), ...acts.filter(a => !s.activities.includes(a.id) && goalScore(a, gs) > 0).map(a => uniq([...s.activities, a.id]).sort())].filter(x => x.length <= room || x === s.activities);
    for (const hotel of hotels) for (const activities of sets) for (const transfer of transfers) {
      const spec = { ...s, nights, hotel, flight, activities: [...activities].sort(), transfer }, key = encodeSpec(spec);
      if (seen.has(key)) continue; seen.add(key); const p = price(spec);
      if (!p || (cap !== null && p.total > cap) || !keepsPx(p.spec, px) || !fitsSchedule(p, gs)) continue;
      out.push(candidate(p, gs));
    }
  }
  return out;
}
function moreMemorable(inv, trip, goals, o = {}, { zeroMore = false } = {}) {
  const gs = goalsOf(goals), cap = capOf(null, o), price = pricer(inv, o), s = trip.spec, base = experienceScore(trip, gs), free = [], givesUp = [], L = locksOf(o);
  // A reallocation is listed only at or under the current total and only when the experience score does not drop (a
  // cheaper, less memorable trip is not "more memorable for $0"); it keeps the protected experience, crosses no lock, fixed
  // date or stated length, and the rhythm holds it as the final check reads it. `free` carries only versions that give up
  // nothing by classifyChanges; one with a trade-off (a fare without the carry-on, a lower-rated hotel) goes to `givesUp`, said.
  const px = protectOf(o);
  const entry = (kind, p, text, gain = null) => {
    if (!p || p.total > trip.total || !keepsPx(p.spec, px) || crossesLock(p, trip, o) || !fitsSchedule(p, gs)) return;
    const g = gain === null ? r1(experienceScore(p, gs) - base) : gain, lost = givesUpOf(p, trip);
    if (g < 0) return;
    (lost.length ? givesUp : free).push({ kind, ...pack(p), delta: p.total - trip.total, gain: g, givesUp: lost, text: lost.length ? `${text}; ${tradeOff(lost)}` : text });
  };
  if (!L.flight) for (const t of timing(trip, o, price).filter(x => x.delta <= 0)) entry('timing', t.p, `${t.flight.name} flights: ${t.time.usableLabel} instead of ${usableTime(trip).usableLabel}, ${signed(t.delta)}`);
  if (!L.hotel) for (const h of hotelsOk(trip, o).filter(h => h.id !== s.hotel && hotelFit(h, gs) > hotelFit(trip.hotel, gs))) { const p = price({ ...s, hotel: h.id }); if (p) entry('location', p, `${h.name} (${accessWord(h) || 'family-friendly'}) for ${p.total < trip.total ? `${fmt(trip.total - p.total)} less` : 'the same total'}: ${joinAnd(hotelFitWords(h, gs))}`); }
  const ft = freeThings(inv, trip.dest, gs, trip);
  if (ft) for (const it of ft.items.filter(x => x.matches && x.onDates === true)) free.push({ kind: 'free-thing', ...pack(trip), delta: 0, gain: freeGain(it, gs), free: it, source: ft.source, checkedAt: ft.checkedAt, givesUp: [], text: `${it.name} (${freeNote(it)}) matches the ${goalLabel(it.matches).toLowerCase()} you ranked #${rankOf(it.matches, gs)}, +$0 according to ${ft.source} as of ${longDate(ft.checkedAt)}` });
  const fa = fatigue(trip, gs, { ...o, inv });
  // An opened day is what GIVE ME MORE FREE TIME asks for; the score counts only the first open day, so
  // it is listed with a nominal gain of 1 whenever fatigue() says the itinerary is very scheduled.
  if (fa.scheduled && fa.freeTime && fa.freeTime.trip) entry('schedule', fa.freeTime.trip, `Open up a day: without ${fa.freeTime.removed.name}, ${signed(fa.freeTime.delta)}`, 1);
  const main = mainOf(trip, gs), lowest = trip.activities.filter(a => a !== main && a.id !== px).sort((a, b) => goalScore(a, gs) - goalScore(b, gs))[0] || null;
  if (lowest) for (const a of (trip.activityOptions || []).filter(x => !s.activities.includes(x.id) && goalScore(x, gs) > goalScore(lowest, gs) && runsOn(x, trip))) { const p = price({ ...s, activities: uniq([...s.activities.filter(x => x !== lowest.id), a.id]).sort() }); if (p) entry('swap', p, `${a.name} instead of ${lowest.name}: a ${goalLabel(goalOf(a, gs)).toLowerCase()} experience you ranked higher, ${signed(p.total - trip.total)}`); }
  const fixed = L.dates || (o.ctx || {}).dateMode === 'exact';
  if (!fixed) { const w = cheapestWeeks(inv, trip, settingsOf(o), { rules: rulesOf(o), style: styleOf(o) }, { now: nowOf(o), locks: L }); if (w.cheaper) entry('date', w.cheaper.trip, `The same trip leaving ${longDate(w.cheaper.depart)} for ${fmt(trip.total - w.cheaper.total)} less (today's prices, not a forecast)`); }
  // Another destination moves the hotel, the flights and often the dates and length: only when none of
  // them is locked or fixed, and never for a protected experience another destination cannot offer.
  if (o.q && !px && !fixed && !['dest', 'nights', 'hotel', 'flight'].some(k => L[k])) { const sf = sameFeeling(inv, o.q, gs, trip, o); if (sf.trip) entry('destination', sf.trip, clause(sf.text), r1(sf.score - base)); }
  free.sort((a, b) => b.gain - a.gain || a.delta - b.delta); givesUp.sort((a, b) => b.gain - a.gain || a.delta - b.delta);
  const paid = zeroMore ? [] : climb(candidate(trip, gs), versionsOf(inv, trip, gs, o, cap), gs, cap).slice(1);
  const tail = givesUp.length ? ` Each of these gives something up: ${givesUp.map(f => clause(f.text)).join('; ')}.` : '';
  const text = zeroMore ? `Total stays at or under ${fmt(trip.total)}. ${free.length ? `${plural(free.length, 'change')} at or under it with nothing given up: ${free.map(f => clause(f.text)).join('; ')}.` : 'Nothing at or under it makes this trip more memorable by what you told me with nothing given up.'}${tail}` : `${free.length ? `For $0 more: ${free.map(f => clause(f.text)).join('; ')}. ` : ''}${paid.length ? `With more money: ${paid.map(r => `${r.label} ${fmt(r.total)}`).join(', ')}.` : 'No paid step adds an experience gain with nothing given up.'}${tail}`;
  return { free, givesUp, paid, text };
}

// ---- TRADE SOMETHING FOR THIS ---------------------------------------------------------------------------
// Reductions in the leak engine's order: the transfer (unless a rule), a cheaper fare with the same bags,
// a cheaper hotel inside the rules with no less goal fit, then the lowest-goal experience that is not
// the main one; never the protected experience, never a locked part. Stops at the first total at or
// under the current one.
function trade(inv, trip, wanted, o = {}) {
  const gs = goalsOf(o.goals || []), price = pricer(inv, o), locks = locksOf(o), rules = rulesOf(o), protect = protectOf(o);
  const want = resolveAct(trip, wanted && wanted.id ? wanted.id : wanted);
  const none = { remove: [], add: null, trip: null, token: null, total: null, unchanged: false };
  if (!want) return { ...none, text: 'That experience is not offered for this trip.' };
  if (trip.spec.activities.includes(want.id)) return { ...none, text: `${want.name} is already in this trip.` };
  // No reduction makes an experience run outside its season: said, and nothing traded.
  if (!runsOn(want, trip)) return { ...none, text: `${want.name} does not run on these dates (runs ${monthList(want.months)}): no trade makes room for it.` };
  let cur = price(withAct(trip.spec, want.id));
  if (!cur) return { ...none, text: `${want.name} could not be priced on this trip.` };
  const add = { label: want.name, amount: cur.total - trip.total };
  const remove = [];
  const step = (p, label) => { if (!p || p.total >= cur.total) return; remove.push({ label, amount: cur.total - p.total }); cur = p; };
  const over = () => cur.total > trip.total;
  const crowded = () => !fitsSchedule(cur, gs); // a day of its own, in season, one day kept open
  // Of the cheaper versions one reduction can buy, the smallest that pays for it, else the largest:
  // a trade gives up no more than it has to.
  const least = ps => { const xs = ps.filter(Boolean).filter(p => p.total < cur.total).sort((a, b) => b.total - a.total); return xs.find(p => p.total <= trip.total) || xs[xs.length - 1] || null; };
  if (over() && cur.transfer && !(rules && rules.transfer)) step(price({ ...cur.spec, transfer: false }), 'Airport transfer');
  if (over() && !locks.flight) { const f = least(flightsOk(trip, o).filter(x => x.id !== cur.spec.flight && !!x.carryOn === !!cur.flight.carryOn && (!!x.checkedBagIncluded || !!cur.spec.bags) === (!!cur.flight.checkedBagIncluded || !!cur.spec.bags)).map(x => price({ ...cur.spec, flight: x.id })).filter(p => p && !classifyChanges(cur, p).tradeoffs.some(r => r.key === 'bags') && !rhythm(p, gs).lateThenEarly.length)); if (f) step(f, `${f.flight.name} fare instead of ${cur.flight.name}`); }
  if (over() && !locks.hotel) { const h = least(hotelsOk(trip, o).filter(x => x.id !== cur.spec.hotel && hotelFit(x, gs) >= hotelFit(cur.hotel, gs)).map(x => price({ ...cur.spec, hotel: x.id }))); if (h) step(h, `${h.hotel.name} instead of ${cur.hotel.name}`); }
  // Then the lowest-goal experience, never the main or the protected one, until it is paid for and has a day of its own.
  const mainId = (mainOf(trip, gs) || {}).id || null; // by id: a re-priced version carries its own activity objects
  while (over() || crowded()) {
    const cand = cur.activities.filter(a => a.id !== want.id && a.id !== protect && a.id !== mainId).sort((a, b) => goalScore(a, gs) - goalScore(b, gs) || a.pricePerPerson - b.pricePerPerson)[0];
    if (!cand) break; const p = price(withoutAct(cur.spec, cand.id)); if (!p) break;
    remove.push({ label: cand.name, amount: cur.total - p.total }); cur = p;
  }
  if (!over() && !crowded()) return { remove, add, ...pack(cur), unchanged: true, text: `MAKE THE TRADE: ${want.name} in, ${remove.length ? `${joinAnd(remove.map(r => `${r.label} out (${fmt(r.amount)})`))}` : 'nothing out'}: ${fmt(cur.total)}, ${cur.total === trip.total ? 'the same total' : `${fmt(trip.total - cur.total)} under your current total`}.` };
  if (!over()) return { remove, add, trip: null, token: null, total: cur.total, closest: pack(cur), unchanged: false, text: `No trade makes room for ${want.name}: ${scheduleWhy(cur, gs, want) || 'the rhythm cannot hold it'}, and what is left is what I keep (the main experience${protect ? ' and the protected one' : ''}).` };
  return { remove, add, trip: null, token: null, total: cur.total, closest: pack(cur), unchanged: false, text: `No trade keeps the total: the closest is ${signed(cur.total - trip.total)} over${remove.length ? ` (${joinAnd(remove.map(r => r.label))} out)` : ''}.` };
}

// ---- FINAL EXPERIENCE CHECK --------------------------------------------------------------------------------
function finalCheck(trip, goals, o = {}) {
  const gs = goalsOf(goals), rh = rhythm(trip, gs), main = mainOf(trip, gs), reasons = [];
  const ok = (v, text) => reasons.push({ ok: v, text }), g1 = gs[0] || null;
  const hasMain = !!(main && (g1 ? matches(g1, main, gs) : true));
  const beachDay = g1 === 'beach' && beachAccess(trip.hotel) && rh.days.some(d => d.label === 'Open beach day');
  ok(hasMain || beachDay, hasMain ? `Main experience for ${goalLabel(g1 || 'surprise').toLowerCase()}: ${main.name}` : beachDay ? `An open beach day with ${hotelPhrase(trip.hotel, 'beach')} for the beach you ranked #1` : `No experience in this trip serves ${g1 ? `${goalLabel(g1).toLowerCase()}, the goal you ranked #1` : 'your goals'}`);
  ok(rh.fullDays >= 2, `${plural(rh.fullDays, 'full day')}${rh.fullDays >= 2 ? '' : ': fewer than two'}`);
  if (trip.spec.nights >= 4) ok(rh.openDays >= 1, rh.openDays >= 1 ? `${plural(rh.openDays, 'open day')}` : 'No open day in a trip of 4 nights or more');
  // Season and schedule are read off the trip's own rhythm (collisions): an experience off its season on
  // every full day is said as not running; everything else the rhythm cannot hold is the conflict.
  const px = protectOf(o), col = collisions(trip, { goals: gs, event: o.event || null, protect: px }), sched = col.filter(c => c.kind !== 'season'), off = col.filter(c => c.kind === 'season').map(c => c.activity);
  ok(!sched.length, sched.length ? sched[0].text : 'No schedule conflict');
  if (off.length) ok(false, `${joinAnd(off.map(a => a.name))} ${off.length === 1 ? 'does' : 'do'} not run on these dates (${joinAnd(off.map(a => monthList(a.months)))})`);
  if (px && !trip.spec.activities.includes(px)) ok(false, `Without ${(resolveAct(trip, px) || { name: px }).name}, the protected experience`);
  if (g1 === 'beach') ok(beachAccess(trip.hotel), beachAccess(trip.hotel) ? `Hotel location fits: ${hotelPhrase(trip.hotel, 'beach')}` : `Hotel not on or near the beach (${trip.hotel.area})`);
  else if (g1 === 'family') ok(!!trip.hotel.features.familyFriendly, trip.hotel.features.familyFriendly ? 'Family-friendly hotel' : 'The hotel is not listed as family-friendly');
  else reasons.push({ ok: true, text: 'Hotel location against your experiences: distances are not in our data (needs verification)' });
  const pass = reasons.every(r => r.ok); let rebuild = null;
  if (!pass && o.inv) {
    const cands = versionsOf(o.inv, trip, gs, o, capOf(null, o)).filter(c => finalCheck(c.trip, gs, { ...o, inv: null }).ok).sort((a, b) => a.total - b.total);
    if (cands[0]) rebuild = { ...cands[0], delta: cands[0].total - trip.total, text: `A rebuild that passes: ${fmt(cands[0].total)} (${signed(cands[0].total - trip.total)}), ${joinAnd(sayDiffs(cands[0].trip, trip)) || 'the same frame with the experiences changed'}; a proposal, nothing applied.` };
  }
  // Each reason is a sentence of its own on a page (a conflict's ends with its stop); joined here, each is a clause, so the
  // text never reads ".." or ".;".
  return { ok: pass, reasons, rebuild, text: pass ? 'FINAL EXPERIENCE CHECK: this trip serves what you told me.' : `FINAL EXPERIENCE CHECK: ${reasons.filter(r => !r.ok).map(r => clause(r.text)).join('; ')}.${rebuild ? ` ${rebuild.text}` : ''}` };
}

// ---- WHAT WAS ACTUALLY WORTH IT? -----------------------------------------------------------------------------
const WORTH_IT_CHIPS = ['Hotel', 'Food', 'Main experience', 'Free time', 'Nightlife', 'Location', 'Other'];
// Preference deltas from the answer; the caller applies them only with the customer's permission.
function learn(feedback = {}) {
  const worth = (feedback.worth || []).filter(c => WORTH_IT_CHIPS.includes(c)), notWorth = (feedback.notWorth || []).filter(c => WORTH_IT_CHIPS.includes(c));
  const prefs = {}, goalsAdd = [], notes = [];
  for (const [chip, key] of [['Hotel', 'stayMatters'], ['Main experience', 'mainMatters'], ['Free time', 'openDays'], ['Location', 'locationMatters']]) { if (worth.includes(chip)) prefs[key] = true; if (notWorth.includes(chip)) prefs[key] = false; }
  for (const [chip, key] of [['Food', 'food'], ['Nightlife', 'nightlife']]) if (worth.includes(chip)) goalsAdd.push(key);
  if (worth.includes('Other') || notWorth.includes('Other')) notes.push('"Other" is kept as your words only; nothing is inferred from it.');
  if (goalsAdd.length) prefs.goalsAdd = goalsAdd;
  const WORDS = { stayMatters: v => (v ? 'the hotel mattered to you' : 'the hotel did not matter much to you'), mainMatters: v => (v ? 'the main experience was worth it' : 'the main experience was not worth it'), openDays: v => (v ? 'free time was worth it' : 'free time mattered less'), locationMatters: v => (v ? 'the location was worth it' : 'the location mattered less'), goalsAdd: v => `${joinAnd(v.map(k => goalLabel(k).toLowerCase()))} as a goal next time` };
  return { prefs, text: Object.keys(prefs).length ? `Remembered only if you say so: ${Object.entries(prefs).map(([k, v]) => WORDS[k](v)).join('; ')}.` : 'Nothing to remember from this answer.', notes };
}

// ---- the voice ------------------------------------------------------------------------------------------------
const PERSONALITY = ['I\'d downgrade the room and spend the money on the trip.', 'You don\'t need another paid activity. This day is already strong.', 'I wouldn\'t spend it all. The memories are already in the price.', 'That upgrade buys a label, not a memory.'];
const BRAND_LINES = ['MAKE THE TRIP BETTER, NOT JUST THE HOTEL.', 'YOUR MONEY SHOULD BUY A BETTER STORY.', 'DON\'T JUST GO SOMEWHERE. DO SOMETHING WORTH GOING FOR.'];
const SIGNATURE_LINE = 'SPEND ON THE MEMORIES. NOT THE LABELS.';
const FINAL_LINE = 'DON\'T JUST UPGRADE THE TRIP. UPGRADE THE MEMORY.';

module.exports = {
  GOALS, goalLabel, goalsOf, goalScore, goalOf, destGoalMatch, experienceScore, hotelFit, beachAccess, mainOf, fitWords,
  experienceSearch, experienceWays, allocation, hotelOrExperience, memoryTest, oneBigThing, packTrip, bigVsMany, freeThings, freeOverPaid,
  rhythm, bestDay, locationCheck, destinationMatch, alternative, sameFeeling, dupe, challengeUpgrade, valueCheck, collisions, fatigue,
  surpriseOne, surpriseCompletely, ladder, sweetSpot, downsell, eventRange, eventCollision, eventBuffer, landing, protection, backup, receipt, moreMemorable, trade, finalCheck,
  versionsOf, fitsSchedule, sayDiffs, WORTH_IT_CHIPS, learn, PERSONALITY, BRAND_LINES, SIGNATURE_LINE, FINAL_LINE, NEW_NOTE, NO_DUPE, THRESHOLD, BIG,
};
