// EXPERIENCE MAX: every number the engine shows is priceTrip's total for a token or arithmetic on two
// such totals; every verdict comes from the goals the customer ranked and the trip's own facts, never
// from stars, brand, price or margin (the results are identical at 0% and 90% commission); the rhythm
// never puts the main experience on a travel day and keeps a day open; conflicts, fatigue, free things,
// dupes, the ladder, the receipt, the trade and the final check each say only what the inventory can
// show; the protected experience survives every other engine; nothing here pressures anyone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { DEFAULT_SETTINGS, priceTrip } = require('../server/trips/pricing');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { usableTime, classifyChanges, tripDiff } = require('../server/trips/facts');
const optimizer = require('../server/trips/optimizer');
const leaks = require('../server/trips/leaks');
const savemax = require('../server/trips/savemax');
const strategies = require('../server/trips/strategies');
const decision = require('../server/trips/decision');
const { addDays, today } = require('../server/lib/dates');
const { format } = require('../server/lib/money');
const { startApp, clock } = require('./helpers');
const X = require('../server/trips/experience');
const { GUIDE_CHECKED_AT } = require('../server/trips/demo-data/destinations');
const { longDate } = require('../server/trips/words');

const inv = createTripIntegrations(loadConfig({ APP_ENV: 'development' }), { now: clock });
const settings = DEFAULT_SETTINGS;
const now = clock();
const fmt = cents => format(cents, 'USD');
const Q = { budget: 250000, vacationBudget: 250000, keep: 0, budgetInput: 2500, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'surprise', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
const GOALS = ['beach', 'food', 'nature'];
const o = { now, settings, locks: {}, cap: Q.budget };
const price = spec => priceTrip(inv, spec, settings);
const monthOf = iso => Number(iso.slice(5, 7));
const esc = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // a literal inside a RegExp
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const TEXTS = [];
// Deep walkers: every packed version anywhere in a result, every priced trip, every sentence.
function walk(v, onPack, onTrip, onText, seen = new Set()) {
  if (typeof v === 'string') { onText(v); return; }
  if (!v || typeof v !== 'object' || seen.has(v)) return;
  seen.add(v);
  if (v.token && v.trip && Number.isFinite(v.total)) onPack(v);
  if (v.spec && Number.isFinite(v.total) && Array.isArray(v.lines)) { onTrip(v); return; }
  for (const [k, x] of Object.entries(v)) if (!['search', 'ladder', 'inv'].includes(k)) walk(x, onPack, onTrip, onText, seen);
}
// A packed version carries its own token; the token is the trip; the total is priceTrip's.
function checkPacked(x) {
  assert.equal(x.token, encodeSpec(x.trip.spec));
  const p = price(decodeSpec(x.token));
  assert.ok(p, `the token prices: ${x.token}`);
  assert.equal(x.total, p.total); assert.equal(x.trip.total, p.total);
}
const audit = r => { walk(r, checkPacked, () => {}, t => TEXTS.push(t)); return r; };
const tripsIn = r => { const out = []; walk(r, () => {}, t => out.push(t), () => {}); return out; };
const goalActs = (t, gs) => t.activities.filter(a => X.goalScore(a, gs) > 0).length;
const res = audit(X.experienceSearch(inv, Q, GOALS, o));
const ways = audit(X.experienceWays(inv, Q, GOALS, o));
const pick = ways.pick.trip, main = X.mainOf(pick, GOALS);

test('goals: the chips in order, validated, capped at three; goalScore reads only the goals and the activity\'s kind and tags', () => {
  assert.deepEqual(X.GOALS.map(g => g.key), optimizer.GOAL_KEYS);
  assert.deepEqual(X.goalsOf({ goals: ['food', 'x', 'beach', 'food', 'nature', 'culture'] }), ['food', 'beach', 'nature']);
  assert.equal(X.goalLabel('new'), 'Something I’ve never done');
  const acts = inv.activities.search({ destId: 'cancun', date: addDays(today(now), 30), travelers: 2 });
  const beach = acts.find(a => a.kind === 'beach' && !a.tags.includes('nature')), culture = acts.find(a => a.kind === 'culture'), nature = acts.find(a => a.tags.includes('nature') && a.kind !== 'beach');
  assert.equal(X.goalScore(beach, ['beach', 'nature']), 3); assert.equal(X.goalScore(beach, ['nature', 'beach']), 2); assert.equal(X.goalScore(nature, ['beach', 'culture', 'nature']), 1); assert.equal(X.goalScore(culture, ['beach']), 0);
  assert.equal(X.goalScore(culture, ['beach', 'new']), 2, '"new" is an experience outside the other goals and outside the beach-and-hotel shape');
  assert.equal(X.goalScore(beach, ['new']), 0); assert.equal(X.goalScore(culture, ['surprise']), 3, 'surprise: every experience counts');
  assert.match(X.NEW_NOTE, /can’t know what you have done/);
  const date = addDays(today(now), 30), actsOf = d => inv.activities.search({ destId: d.id, date, travelers: 2 }), hotelsOf = d => inv.hotels.search({ destId: d.id, checkIn: date, nights: 5, rooms: 1 });
  const quiet = inv.maps.listDestinations().find(d => !d.styles.includes('nightlife') && !actsOf(d).some(a => a.kind === 'nightlife') && actsOf(d).some(a => a.kind === 'culture'));
  const match = X.destGoalMatch(quiet, actsOf(quiet), hotelsOf(quiet), ['culture', 'nightlife']);
  assert.deepEqual(match.met.map(m => m.key), ['culture']); assert.deepEqual(match.unmet.map(m => m.key), ['nightlife']); assert.match(match.unmet[0].why, /^no nightlife experience, style or hotel in /);
  const HOTEL_FACT = /^a (beachfront hotel|family-friendly hotel|hotel near the beach \(.+\))$/;
  assert.ok(match.met[0].facts.every(f => /destination by its style|experiences? for it/.test(f) || HOTEL_FACT.test(f)), match.met[0].facts.join('; '));
  const beachMet = X.destGoalMatch(pick.dest, pick.activityOptions, pick.hotelOptions, GOALS).met.find(m => m.key === 'beach');
  assert.ok(beachMet && beachMet.facts.some(f => HOTEL_FACT.test(f)), 'beach access by a hotel counts');
  if (pick.hotelOptions.some(h => h.features.beachfront)) assert.ok(beachMet.facts.includes('a beachfront hotel'), 'the best access the inventory lists is named');
});

test('experienceSearch: experience first, every candidate priced, in season, with a rhythm that keeps the main experience off the travel days and a day open', () => {
  assert.ok(res.candidates.length > 100 && res.considered >= res.candidates.length);
  const meets = new Map(res.destinations.map(d => [d.dest.id, d.match.met.some(m => m.key === GOALS[0])]));
  for (const c of res.candidates) {
    assert.ok(meets.get(c.dest), `${c.dest} meets goal #1 by its inventory`);
    assert.ok([Q.nights, Q.nights + 1].includes(c.trip.spec.nights));
    assert.equal(c.score, X.experienceScore(c.trip, GOALS));
    const r = X.rhythm(c.trip, GOALS), u = usableTime(c.trip);
    assert.equal(r.unplaced.length, 0); assert.equal(r.lateThenEarly.length, 0);
    assert.ok(c.trip.activities.length <= Math.max(0, u.fullDays - 1), 'never more experiences than full days minus one');
    if (c.trip.spec.nights >= 4) assert.ok(r.openDays >= 1, 'an open day when nights >= 4');
    const m = X.mainOf(c.trip, GOALS);
    if (m) { const d = r.placed.find(p => p.activity === m).day; assert.ok(d.full && d.n !== 1 && d.n !== c.trip.spec.nights + 1, 'the main experience has a full day of its own'); assert.equal(d.label, 'Main experience'); }
    for (const p of r.placed) if (p.activity.months) assert.ok(p.activity.months.includes(monthOf(p.day.date)), 'seasonal months respected');
    for (const p of r.placed) assert.ok(!(p.activity.slot === 'morning' && r.days[p.day.n - 2] && r.days[p.day.n - 2].slot && ['evening', 'night'].includes(r.days[p.day.n - 2].slot)), 'a morning slot never after an evening one');
  }
  assert.ok(res.candidates.every((c, i) => i === 0 || res.candidates[i - 1].score > c.score || (res.candidates[i - 1].score === c.score && res.candidates[i - 1].total <= c.total)), 'sorted by experience score, then price');
  assert.match(X.rhythm(pick, GOALS).text, /^A suggested rhythm, not a schedule/);
  assert.deepEqual(res.candidates[0].fit.map(f => f.split(' (#')[0]), ['Amazing beach', 'Incredible food', 'Nature']);
});

// OUR PICK's location blurb is the listing's own fact, never a quality word, and never for a hotel the
// LOCATION check would move away from (L06).
function checkWhere(P, gs, cap) {
  assert.ok(!P.blurbs.some(b => /Strong location|Good location/.test(b)), P.blurbs.join());
  const h = P.trip.hotel, word = ['Beachfront hotel', 'Near the beach', 'Family-friendly hotel'].find(w => P.blurbs.includes(w)), moves = gs.includes('beach') && !h.features.beachfront && !!X.locationCheck(inv, P.trip, gs, { ...o, cap }).verdict;
  if (word === 'Beachfront hotel') assert.ok(h.features.beachfront); if (word === 'Near the beach') assert.ok(X.beachAccess(h) && !h.features.beachfront && !moves); if (word === 'Family-friendly hotel') assert.ok(h.features.familyFriendly);
  assert.equal(!!word, X.hotelFit(h, gs) > 0 && !moves);
}
// Item 36's sentence: each clause only when its fact holds, read back against the trips it names.
function checkReason(w, gs) {
  const P = w.pick, parts = w.reason.split(/(?<=\.) (?=The )/);
  assert.equal(parts[0], `I'd pick ${fmt(P.total)}.`);
  const M = w.memories, C = w.comfort;
  const mClause = parts.find(p => p.includes('saves money')), cClause = parts.find(p => /is easier|has a better hotel|adds a transfer/.test(p));
  assert.equal(!!mClause, !!M); assert.equal(!!cClause, !!C);
  if (M) {
    assert.ok(mClause.startsWith(`The ${fmt(M.total)} version saves money`)); assert.ok(M.total < P.total);
    const ch = classifyChanges(P.trip, M.trip);
    if (/removes an experience you ranked highly/.test(mClause)) assert.ok(P.trip.activities.some(a => X.goalScore(a, gs) >= 2 && !M.trip.spec.activities.includes(a.id)));
    else if (/is a different trip/.test(mClause)) assert.ok(M.trip.dest.id !== P.trip.dest.id && mClause.includes(`${M.trip.dest.name} instead of ${P.trip.dest.name}`));
    else if (/but means /.test(mClause)) assert.ok(ch.tradeoffs.length > 0);
    else if (/but changes /.test(mClause)) assert.ok(ch.neutral.length > 0 && !ch.tradeoffs.length);
    else assert.match(mClause, /differs only in experiences I rank lower/);
  }
  if (C) {
    assert.ok(cClause.startsWith(`The ${fmt(C.total)} version`)); assert.ok(C.total > P.total);
    const imp = classifyChanges(P.trip, C.trip).improvements.map(r => r.key), gain = Math.round((C.score - P.score) * 10) / 10;
    if (/is easier/.test(cClause)) assert.ok(imp.some(k => k === 'flight' || k === 'time'));
    else if (/has a better hotel/.test(cClause)) assert.ok(imp.some(k => ['hotel', 'area', 'meals'].includes(k)));
    else assert.ok(imp.includes('transfer'));
    if (/doesn't make the vacation meaningfully more memorable/.test(cClause)) assert.ok(gain < X.THRESHOLD); else { assert.match(cClause, /adds to the experience/); assert.ok(gain >= X.THRESHOLD); }
  }
}

test('experienceWays: three priced results at or under the ceiling that differ as their blurbs claim; the reason, the rejected upgrade and the signature only from facts', () => {
  const combos = [[GOALS, 250000], [GOALS, 350000], [['nature', 'food', 'adventure'], 300000], [['culture', 'food'], 250000], [['romantic', 'nightlife'], 220000], [['adventure', 'nature', 'culture'], 350000], [['beach'], 200000]];
  // Ceilings read off the inventory's own ladders (never a fixed figure): at a rung's total the pick has
  // bought that step and not the next, which is where a cheaper version with more experiences and a
  // simpler hotel can exist (a pick that paid for the location instead of another experience).
  for (const gs of [['beach'], ['nature', 'beach'], ['beach', 'romantic']]) for (const r of X.ladder(inv, { ...Q, budget: 350000, vacationBudget: 350000 }, gs, { ...o, cap: 350000 }).rungs.slice(1)) combos.push([gs, r.total]);
  let memories = 0, comfort = 0, rejected = 0, stayChecked = 0;
  for (const [gs, budget] of combos) {
    const q = { ...Q, budget, vacationBudget: budget }, w = audit(X.experienceWays(inv, q, gs, { ...o, cap: budget }));
    const P = w.pick; assert.ok(P && P.total <= budget, 'OUR PICK at or under the ceiling');
    assert.equal(P.label, 'OUR PICK'); assert.equal(P.keep, budget - P.total); assert.equal(P.token, w.ladder.stop.token, 'the pick is the memory sweet spot');
    assert.ok(P.blurbs.includes(`${P.trip.spec.nights} nights`) && (P.blurbs.includes('Main experience') === (X.goalScore(X.mainOf(P.trip, gs) || { kind: '' }, gs) > 0)) && (P.blurbs.includes('Open time') === (X.rhythm(P.trip, gs).openDays >= 1)));
    checkWhere(P, gs, budget);
    if (w.memories) {
      memories++; const M = w.memories; assert.equal(M.label, 'MORE MEMORIES'); assert.ok(M.total < P.total && M.total <= budget);
      assert.ok(goalActs(M.trip, gs) > goalActs(P.trip, gs), 'more goal experiences'); assert.ok(M.trip.hotel.stars <= P.trip.hotel.stars, 'a simpler or same-class hotel');
      assert.ok(M.blurbs.includes('More experiences') && M.blurbs.includes(M.trip.spec.hotel === P.trip.spec.hotel ? 'Same hotel' : 'Simpler hotel'));
      if (M.trip.dest.id !== P.trip.dest.id) assert.ok(M.blurbs.some(b => b.startsWith('A different trip')));
    } else assert.ok(w.dropped.some(d => d.key === 'memories' && /No cheaper version/.test(d.reason)));
    if (w.comfort) {
      comfort++; const C = w.comfort; assert.equal(C.label, 'MORE COMFORT'); assert.ok(C.total > P.total && C.total <= budget);
      assert.deepEqual([...C.trip.spec.activities].sort(), [...P.trip.spec.activities].sort(), 'the same experiences, the main one included');
      const ch = classifyChanges(P.trip, C.trip); assert.equal(ch.tradeoffs.length, 0); assert.ok(ch.improvements.some(r => ['flight', 'time', 'hotel', 'area', 'meals', 'transfer'].includes(r.key)));
      assert.equal(C.blurbs[0], 'Same core experience');
    } else assert.ok(w.dropped.some(d => d.key === 'comfort'));
    checkReason(w, gs);
    if (w.rejected) {
      rejected++; const R = w.rejected, up = strategies.stepUp(P.trip, R.trip, q.nights);
      assert.ok(up && up.stay.length && R.total > P.total && R.total <= budget, 'a priced hotel step-up with a stay gain'); assert.equal(R.delta, R.total - P.total);
      assert.ok(R.trip.spec.flight === P.trip.spec.flight && R.trip.spec.depart === P.trip.spec.depart && R.trip.spec.hotel !== P.trip.spec.hotel); assert.deepEqual([...R.trip.spec.activities].sort(), [...P.trip.spec.activities].sort());
      assert.ok(X.experienceScore(R.trip, gs) <= X.experienceScore(P.trip, gs), 'the step-up buys a label, not a goal');
      // Nothing the customer said is put in their mouth: with no word about the stay, the upgrade is one they didn't ask for.
      assert.equal(R.label, `+${fmt(R.delta)} Hotel upgrade`); assert.equal(R.saidLow, false); assert.equal(R.text, `I'd rather leave you ${fmt(budget - P.total)} than put it into a hotel upgrade you didn't ask for.`);
      assert.ok(X.hotelFit(R.trip.hotel, gs) <= X.hotelFit(P.trip.hotel, gs), 'a step-up that gives access a goal asks for is never rejected as a label');
      if (!stayChecked++) {
        // "you told me you don't care about" is only said when nothing they said asks for the stay; the pick itself does not move.
        for (const w2 of [X.experienceWays(inv, { ...q, priority: 'hotel' }, gs, { ...o, cap: budget }), X.experienceWays(inv, q, gs, { ...o, cap: budget, prefs: { stayMatters: true } })]) { assert.equal(w2.rejected, null); assert.equal(w2.pick.token, P.token); }
        // The owner's line, word for word, only on the customer's own words: "the hotel doesn't matter" (o.stayLow, set by the
        // agent from what they said) or a "not worth it: Hotel" remembered with their permission. The pick and the step-up do not move.
        for (const said of [{ stayLow: true }, { prefs: { stayMatters: false } }]) {
          const w3 = X.experienceWays(inv, q, gs, { ...o, cap: budget, ...said });
          assert.equal(w3.pick.token, P.token); assert.equal(w3.rejected.token, R.token); assert.equal(w3.rejected.saidLow, true);
          assert.equal(w3.rejected.text, `I'd rather leave you ${fmt(budget - P.total)} than put it into a hotel upgrade you told me you don't care about.`);
        }
        // Words that ask for the stay win over any earlier "doesn't matter": no rejected upgrade at all.
        assert.equal(X.experienceWays(inv, { ...q, priority: 'hotel' }, gs, { ...o, cap: budget, stayLow: true }).rejected, null);
        // Without a ceiling the same rule holds in the cap-less line.
        const open = { ...q, budget: null, vacationBudget: null }, w4 = X.experienceWays(inv, open, gs, { ...o, cap: null }), w5 = X.experienceWays(inv, open, gs, { ...o, cap: null, stayLow: true });
        if (w4.rejected) {
          assert.equal(w4.rejected.text, `I'd rather not put ${fmt(w4.rejected.delta)} into a hotel upgrade you didn't ask for.`);
          assert.equal(w5.rejected.text, `I'd rather not put ${fmt(w5.rejected.delta)} into a hotel upgrade you told me you don't care about.`);
          stayChecked++;
        }
      }
    }
    assert.equal(w.signature, P.total < budget ? `I wouldn't spend ${fmt(budget)}.` : null);
    const exact = X.experienceWays(inv, { ...q, budget: P.total, vacationBudget: P.total }, gs, { ...o, cap: P.total });
    assert.equal(exact.pick.token, P.token, 'a ceiling lowered to the pick gives the same pick back'); assert.equal(exact.signature, null, 'no signature when the pick is the budget');
  }
  assert.ok(memories > 0 && comfort > 0 && rejected > 0 && stayChecked > 1, `the invariants were exercised (${memories} memories, ${comfort} comfort, ${rejected} rejected, ${stayChecked} stay checks)`);
  // The maximum is a ceiling, not a target: a bigger number never buys a less memorable pick, and the
  // pick only moves when the money buys a meaningful gain (in one destination as well as across all).
  for (const [gs, q] of [[['beach'], { ...Q, dest: 'cancun' }], [GOALS, Q], [['culture', 'food'], Q]]) {
    const caps = X.ladder(inv, { ...q, budget: 400000, vacationBudget: 400000 }, gs, { ...o, cap: 400000 }).rungs.flatMap(r => [r.total, r.total + 1500]);
    let prev = null;
    for (const cap of caps.sort((a, b) => a - b)) {
      const w = X.experienceWays(inv, { ...q, budget: cap, vacationBudget: cap }, gs, { ...o, cap });
      if (!w.pick) continue;
      if (prev) { assert.ok(w.pick.score >= prev.score, `${gs} at ${cap}: ${w.pick.score} after ${prev.score}`); if (w.pick.token !== prev.token) assert.ok(w.pick.score >= prev.score + X.THRESHOLD || w.pick.total < prev.total, 'a dearer pick is a meaningful gain'); }
      prev = w.pick;
    }
  }
  // A step-up that serves a goal is never "an upgrade you told me you don't care about": for a romantic goal, a beachfront step-up raises the score and is not rejected.
  for (const w of [X.experienceWays(inv, Q, ['romantic', 'food'], o)]) if (w.rejected) assert.ok(!(w.rejected.trip.hotel.features.beachfront && !w.pick.trip.hotel.features.beachfront), 'a beachfront step-up for a romantic goal is not rejected as a label');
});

test('margin is never an input: the engine\'s results are identical at 0% and 90% commission', () => {
  const at = n => ({ ...inv, activities: { ...inv.activities, search: q => inv.activities.search(q).map(a => ({ ...a, commissionPercent: n })) } });
  const strip = v => JSON.stringify(v, (k, x) => (k === 'internal' || k === 'commissionPercent' ? undefined : x));
  const run = i => { const w = X.experienceWays(i, Q, GOALS, o), p = w.pick.trip; return [w, X.memoryTest(i, p, GOALS, o), X.hotelOrExperience(i, p, GOALS, o), X.ladder(i, Q, GOALS, o).rungs, X.trade(i, p, p.activityOptions.find(a => !p.spec.activities.includes(a.id)), { ...o, goals: GOALS }), X.moreMemorable(i, p, GOALS, { ...o, q: Q }, { zeroMore: true }), X.downsell(i, p, GOALS, o), X.bigVsMany(i, p, GOALS, o), X.receipt(i, Q, w.pick, GOALS, o), X.sameFeeling(i, Q, GOALS, p, o), X.destinationMatch(i, Q, GOALS, o).why, X.oneBigThing(i, Q, GOALS, o).why, X.surpriseOne(i, p, GOALS, null, o), X.finalCheck(price({ ...p.spec, activities: [] }), GOALS, { ...o, inv: i })]; };
  assert.equal(strip(run(at(0))), strip(run(at(90))));
  assert.ok(!/commissionPercent/.test(require('fs').readFileSync(require.resolve('../server/trips/experience.js'), 'utf8').replace(/\/\/.*$/gm, '')), 'the engine never reads commissionPercent');
});

test('goalScore drives every verdict: change the goals and the verdict changes', () => {
  assert.equal(X.finalCheck(pick, GOALS).ok, true);
  const other = X.finalCheck(pick, ['nightlife']); assert.equal(other.ok, false); assert.match(other.reasons[0].text, /No experience in this trip serves nightlife, the goal you ranked #1/);
  assert.match(X.valueCheck(inv, pick, main, GOALS).rows.find(r => r.key === 'priority').value, /you ranked #1/);
  assert.equal(X.valueCheck(inv, pick, main, ['culture']).rows.find(r => r.key === 'priority').value, 'outside the goals you gave me');
  const beachLoc = X.locationCheck(inv, pick, ['beach'], o), otherLoc = X.locationCheck(inv, pick, ['culture'], o);
  assert.ok(beachLoc.verdict); assert.equal(otherLoc.verdict, null); assert.match(otherLoc.unknown, /Distance from the hotel to your experiences is not in our data \(needs verification\)/);
  const w1 = X.experienceWays(inv, Q, ['culture', 'food'], o), w2 = X.experienceWays(inv, Q, ['beach', 'nature'], o);
  assert.notEqual(w1.pick.token, w2.pick.token); assert.equal(X.goalScore(X.mainOf(w1.pick.trip, ['culture', 'food']), ['culture', 'food']), 3);
});

test('collisions: an evening or night slot before a return flight earlier than 9:00, and not otherwise', () => {
  let fired = 0, quiet = 0;
  const depart = addDays(today(now), 30);
  for (const d of inv.maps.listDestinations()) {
    const evening = inv.activities.search({ destId: d.id, date: depart, travelers: 2 }).filter(a => a.slot === 'evening' || a.slot === 'night')[0];
    const flights = inv.flights.search({ from: 'JFK', destId: d.id, depart, nights: 2, travelers: 2 });
    if (!evening || !flights.length) continue;
    for (const f of flights) {
      // One full day only, so the evening experience can only sit the night before the flight home (an overnight flight eats a day, so it gets one more night).
      const nights = f.arrivesNextDay ? 3 : 2, hotel = inv.hotels.search({ destId: d.id, checkIn: depart, nights, rooms: 1 })[0];
      const t = hotel && price({ dest: d.id, from: 'JFK', depart, nights, travelers: 2, who: 'couple', flight: f.id, hotel: hotel.id, activities: [evening.id], bags: false, transfer: false });
      if (!t) continue;
      const col = audit(X.collisions(t, { inv, settings })), hit = col.find(c => c.kind === 'late-then-early'), early = f.returnDepartMinutes < 9 * 60;
      assert.equal(!!hit, early, `${d.id} ${f.name} home at ${f.returnDepartMinutes}`);
      if (!hit) { quiet++; continue; }
      fired++;
      const hhmm = `${String(Math.floor(f.returnDepartMinutes / 60)).padStart(2, '0')}:${String(f.returnDepartMinutes % 60).padStart(2, '0')}`;
      assert.equal(hit.text, `SCHEDULE CONFLICT: ${evening.name} is ${evening.slot === 'night' ? 'a night' : 'an evening'} experience and your flight home leaves at ${hhmm}.`);
      const later = flights.filter(x => x.returnDepartMinutes >= 9 * 60), fix = hit.fixes.find(x => x.kind === 'flight');
      assert.equal(!!fix, later.length > 0); if (fix) { assert.ok(fix.trip.flight.returnDepartMinutes >= 9 * 60); assert.equal(fix.delta, fix.total - t.total); }
      const rm = hit.fixes.find(x => x.kind === 'remove'); assert.ok(rm && !rm.trip.spec.activities.includes(evening.id));
      assert.ok(hit.fixes.some(x => x.kind === 'move' && x.trip === null));
    }
  }
  assert.ok(fired > 0 && quiet > 0, `both cases found in the inventory (${fired} conflicts, ${quiet} clear)`);
  for (const c of res.candidates.slice(0, 200)) assert.equal(X.collisions(c.trip, {}).length, 0, 'a trip the search built never carries a conflict');
  const ev = X.eventCollision(pick, { date: addDays(pick.spec.depart, 1), name: 'Dinner' }); assert.equal(ev, null);
  assert.match(X.eventCollision(pick, { date: pick.spec.depart, name: 'Dinner' }).text, /^SCHEDULE CONFLICT: Dinner on .* falls on your arrival day/);
  const range = X.eventRange({ date: '2027-03-10', name: 'Concert' }, 4); assert.deepEqual([range.from, range.to, range.latestDepart, range.earliestReturn, range.buffer], ['2027-03-07', '2027-03-09', '2027-03-09', '2027-03-11', 1]);
  assert.equal(X.eventRange({ date: '2027-03-10' }, 1).from, null);
});

test('fatigue fires only on its four facts, never with medical words; freeTime removes the lowest-goal non-main experience', () => {
  const versions = X.versionsOf(inv, pick, GOALS, o, null).map(c => c.trip);
  const extra = pick.activityOptions.filter(a => !pick.spec.activities.includes(a.id)).map(a => price({ ...pick.spec, activities: [...pick.spec.activities, a.id].sort() })).filter(Boolean);
  let scheduled = 0;
  for (const t of [...versions, ...extra, price({ ...pick.spec, nights: 3 }), price({ ...pick.spec, nights: 2, activities: pick.spec.activities.slice(0, 1) })].filter(Boolean)) {
    const u = usableTime(t), acts = t.activities, f = audit(X.fatigue(t, GOALS, { ...o, inv }));
    const expected = acts.length > u.fullDays - 1 || acts.filter(a => a.hours >= 8).length >= 2 || X.rhythm(t, GOALS).openDays === 0 || acts.filter(a => a.slot === 'morning').length >= 2;
    assert.equal(f.scheduled, expected, encodeSpec(t.spec)); assert.equal(f.reasons.length > 0, expected);
    assert.doesNotMatch(`${f.text} ${f.reasons.join(' ')}`, /\b(exhaust|burnout|health|stress|fatigue|tired|rest)\b/i);
    if (expected) { scheduled++; assert.equal(f.text, 'This itinerary is very scheduled. I can open up a day without changing the main experiences.'); if (f.freeTime) { const m = X.mainOf(t, GOALS); assert.notEqual(f.freeTime.removed.id, m.id); assert.ok(f.freeTime.trip.spec.activities.length === acts.length - 1 && acts.filter(a => a.id !== m.id).every(a => X.goalScore(a, GOALS) >= X.goalScore(f.freeTime.removed, GOALS))); } }
  }
  assert.ok(scheduled > 0, 'a scheduled version was exercised');
});

test('free things carry a source and a checked date, are null where the guide has nothing, and a missing guide never crashes', () => {
  let some = 0, none = 0;
  for (const d of inv.maps.listDestinations()) {
    const f = audit(X.freeThings(inv, d, GOALS)), raw = inv.guides.freeThings({ destId: d.id });
    assert.equal(!!f, !!raw);
    if (!f) { none++; continue; }
    some++; assert.equal(f.source, 'Demo guide data (invented for this demo)'); assert.equal(f.checkedAt, GUIDE_CHECKED_AT, 'the demo data\'s own fixed date, never today\'s');
    for (const it of f.items) { assert.ok(it.name && it.kind && it.note); assert.ok(it.matches === null || GOALS.includes(it.matches)); }
  }
  assert.ok(some >= 10 && none >= 5);
  // Where demo inventory is refused and no real guide adapter is named, the capability is null (sold
  // inventory keeps the stricter rule), and every caller reads that as "no free data".
  const sold = createTripIntegrations({ allowDemoInventory: false, trips: { providers: {} } }, { overrides: { maps: inv.maps, weather: inv.weather, flights: inv.flights, hotels: inv.hotels, activities: inv.activities, transfers: inv.transfers } });
  assert.ok(sold && sold.guides === null && sold.flights === inv.flights); assert.equal(X.freeThings(sold, pick.dest, GOALS), null);
  assert.equal(createTripIntegrations({ allowDemoInventory: false, trips: { providers: {} } }), null, 'demo sold inventory still turns the planner off');
  const noGuide = { ...inv, guides: null };
  assert.equal(X.freeThings(noGuide, pick.dest, GOALS), null); assert.equal(X.freeOverPaid(noGuide, pick, GOALS), null);
  assert.ok(X.memoryTest(noGuide, pick, GOALS, o).candidates.every(c => c.kind !== 'free')); assert.ok(X.moreMemorable(noGuide, pick, GOALS, o, { zeroMore: true }).free.every(c => c.kind !== 'free-thing'));
  for (const c of X.memoryTest(inv, pick, GOALS, o).candidates.filter(c => c.kind === 'free')) { assert.equal(c.delta, 0); assert.match(c.text, new RegExp(`\\+\\$0: .* according to Demo guide data \\(invented for this demo\\) as of ${esc(longDate(GUIDE_CHECKED_AT))}$`)); }
  const fop = X.freeOverPaid(inv, pick, GOALS);
  if (fop) { assert.ok(fop.paid.id !== main.id && X.goalScore(fop.paid, GOALS) < X.goalScore(main, GOALS) && fop.free.matches === X.goalOf(fop.paid, GOALS)); assert.match(fop.text, new RegExp(`^I found a free option I'd choose over the \\$[\\d,.]+ (tour|experience): .*, according to Demo guide data \\(invented for this demo\\) as of ${esc(longDate(GUIDE_CHECKED_AT))}\\.$`)); }
});

test('dupe only for the same kind, cheaper, not in the trip, with what is similar and what differs said', () => {
  let found = 0;
  for (const c of res.candidates.filter((x, i) => i % 97 === 0)) for (const a of c.trip.activities) {
    const d = audit(X.dupe(inv, c.trip, a, o));
    const cheaper = c.trip.activityOptions.filter(x => x.id !== a.id && !c.trip.spec.activities.includes(x.id) && x.pricePerPerson < a.pricePerPerson && x.kind === a.kind);
    assert.equal(!!d.alternative, cheaper.length > 0);
    if (!d.alternative) { assert.equal(d.text, X.NO_DUPE); continue; }
    found++; assert.equal(d.alternative.kind, a.kind); assert.ok(d.similar[0] === `same kind: ${a.kind}` && d.different.some(x => x.startsWith('a different experience: ')));
    assert.equal(d.delta, d.total - c.trip.total); assert.ok(d.trip.spec.activities.includes(d.alternative.id) && !d.trip.spec.activities.includes(a.id));
  }
  assert.ok(found > 0);
});

test('ladder: GOOD TRIP then rungs with strictly rising totals and a positive gain, one change each; the top only when money remains; the sweet spot stops before a small gain', () => {
  for (const [gs, budget] of [[GOALS, 250000], [['culture', 'food'], 300000], [['nature', 'adventure'], 150000]]) {
    const L = audit(X.ladder(inv, { ...Q, budget, vacationBudget: budget }, gs, { ...o, cap: budget }));
    assert.equal(L.rungs[0].label, 'GOOD TRIP'); assert.ok(['great', 'good'].includes(decision.verdict(L.rungs[0].trip, { style: 'surprise', priority: 'price', budget: null, allowOver: 0 }).grade));
    for (let i = 1; i < L.rungs.length; i++) {
      const a = L.rungs[i - 1], b = L.rungs[i];
      assert.ok(b.total > a.total && b.gain > 0 && b.total <= budget); assert.equal(b.gain, Math.round((b.score - a.score) * 10) / 10);
      assert.equal(classifyChanges(a.trip, b.trip).tradeoffs.length, 0, 'nothing given up');
      assert.match(b.label, /^\+ (Main experience|Extra night|(Second|Third|Another) (major )?experience|Better location|Food experience|More usable time)$/);
      if (/^\+ (Second|Third) /.test(b.label)) assert.equal(b.trip.activities.length, b.label.includes('Second') ? 2 : 3, 'the ordinal is the trip\'s own count');
      assert.equal(b.dest, a.dest);
    }
    const last = L.rungs[L.rungs.length - 1];
    assert.deepEqual(L.top, budget > last.total ? { total: budget, text: 'No meaningful improvement found' } : null);
    const S = X.sweetSpot(L, last.trip), i = L.rungs.indexOf(S.rung);
    assert.ok(i >= 0 && (i + 1 === L.rungs.length || L.rungs[i + 1].gain < X.THRESHOLD) && L.rungs.slice(1, i + 1).every(r => r.gain >= X.THRESHOLD));
    assert.ok(S.text.startsWith(`I'd stop at ${fmt(S.total)}.`)); assert.equal(L.text, `I'd stop at ${fmt(S.total)}.`); assert.equal(L.stop, S.rung);
    assert.ok(S.reasons.includes(`${S.rung.trip.spec.nights} nights`));
  }
});

// Two sweet spots for one goal (the screenshot: the agent said "I'd stop at" the 6-night pick while the memories page, built
// from the link, read 6 and 7 nights and stopped a night higher). The ladder read for a trip is a function of the trip and the
// stated rules only: the agent's query (an assumed length, anywhere, any date) and the page's (the link's context) agree.
test('the ladder read for a trip: the same trip, goals and rules give the same rungs and "I\'d stop at" from any query; the length opens the same way and never above the trip', () => {
  const P = pick, s = P.spec, oc = { ...o, cap: Q.budget, nightsOpen: true };
  const agentQ = { ...Q }, pageQ = { ...Q, origin: inv.maps.airport(s.from).originId, dest: s.dest, dateMode: 'exact', depart: s.depart, nights: s.nights };
  const La = X.ladder(inv, agentQ, GOALS, { ...oc, trip: P }), Lp = X.ladder(inv, pageQ, GOALS, { ...oc, trip: P });
  assert.ok(Lp.rungs.length, 'a ladder for the trip');
  assert.deepEqual(La.rungs.map(r => r.token), Lp.rungs.map(r => r.token)); assert.equal(La.text, Lp.text);
  assert.equal(X.sweetSpot(La, P).text, X.sweetSpot(Lp, P).text);
  assert.deepEqual(Lp.nights, [...new Set([Math.max(2, s.nights - 1), s.nights])], 'the trip\'s nights and one fewer');
  for (const r of Lp.rungs) { assert.equal(r.trip.dest.id, s.dest); assert.equal(r.trip.spec.depart, s.depart); assert.ok(Lp.nights.includes(r.trip.spec.nights)); assert.ok(r.total <= Q.budget); }
  // Taking the sweet spot never moves it a night higher: the ceiling is not a target.
  const S = Lp.stop.trip, Ls = X.ladder(inv, { ...pageQ, nights: S.spec.nights, depart: S.spec.depart }, GOALS, { ...oc, trip: S });
  assert.ok(Ls.stop.trip.spec.nights <= S.spec.nights); if (S.spec.nights === s.nights) assert.equal(Ls.stop.token, Lp.stop.token, 'the sweet spot read again is the same');
  // A stated length holds on both sides; a lock on the length holds the trip's own.
  const stated = s.nights - 1, Lh = X.ladder(inv, { ...agentQ, nights: stated }, GOALS, { ...oc, nightsOpen: false, trip: P }), Lh2 = X.ladder(inv, { ...pageQ, nights: stated }, GOALS, { ...oc, nightsOpen: false, trip: P });
  assert.deepEqual(Lh.nights, [stated]); assert.ok(Lh.rungs.every(r => r.trip.spec.nights === stated)); assert.deepEqual(Lh.rungs.map(r => r.token), Lh2.rungs.map(r => r.token));
  assert.deepEqual(X.ladder(inv, agentQ, GOALS, { ...oc, locks: { nights: true }, trip: P }).nights, [s.nights]);
  // Without a trip the ladder is the search's own (the results' OUR PICK), unchanged.
  assert.equal(X.experienceWays(inv, Q, GOALS, { ...o, trip: P }).pick.token, ways.pick.token);
});

test('receipt: the lines sum exactly to pick minus baseline; FINAL, YOUR MAX and KEEP are the priced totals', () => {
  for (const [w, q] of [[ways, Q], [X.experienceWays(inv, { ...Q, budget: 350000, vacationBudget: 350000 }, ['culture', 'food'], { ...o, cap: 350000 }), { ...Q, budget: 350000 }]]) {
    const r = audit(X.receipt(inv, q, w.pick, w.goals, { ...o, cap: q.budget }));
    const sum = r.usedFor.reduce((n, l) => n + l.amount, 0) - r.lessOn.reduce((n, l) => n + l.amount, 0);
    assert.equal(sum, r.final - r.baseline.total); assert.equal(r.final, w.pick.total); assert.equal(r.max, q.budget); assert.equal(r.keep, q.budget - w.pick.total);
    assert.ok([...r.usedFor, ...r.lessOn].every(l => l.amount > 0));
    assert.match(r.text, /^WHY THIS TRIP IS BUILT THIS WAY\. YOUR GOAL: .*FINAL \$[\d,.]+\. YOUR MAX \$[\d,.]+\. KEEP \$[\d,.]+\./);
    assert.ok(r.baseline.trip.dest.id === w.pick.trip.dest.id);
  }
});

test('trade: the total stays at or under the current one when unchanged is true; the protected experience, the main one and a lock are never touched', () => {
  const wanted = pick.activityOptions.find(a => !pick.spec.activities.includes(a.id));
  const t = audit(X.trade(inv, pick, wanted, { ...o, goals: GOALS, protect: main.id }));
  assert.ok(t.trip.spec.activities.includes(wanted.id)); assert.ok(t.unchanged && t.total <= pick.total);
  assert.ok(t.trip.spec.activities.includes(main.id) && !t.remove.some(r => r.label === main.name)); assert.equal(t.add.label, wanted.name);
  assert.equal(t.remove.reduce((n, r) => n + r.amount, 0), t.add.amount + pick.total - t.total, 'what comes out pays for what goes in');
  assert.match(t.text, /^MAKE THE TRADE: /);
  const locked = X.trade(inv, pick, wanted, { ...o, goals: GOALS, protect: main.id, locks: { hotel: true, flight: true } });
  if (locked.trip) assert.ok(locked.trip.spec.hotel === pick.spec.hotel && locked.trip.spec.flight === pick.spec.flight); else assert.match(locked.text, /^No trade keeps the total: the closest is \+\$[\d,.]+ over/);
  const protectAll = X.trade(inv, pick, wanted, { ...o, goals: GOALS, protect: pick.activities.find(a => a.id !== main.id).id, locks: { hotel: true, flight: true } });
  for (const x of tripsIn(protectAll)) assert.ok(x.spec.activities.includes(main.id));
});

test('MAKE IT BETTER FOR $0 MORE never exceeds the current total; MAKE IT MORE MEMORABLE lists reallocations first, then priced rungs', () => {
  const z = audit(X.moreMemorable(inv, pick, GOALS, { ...o, q: Q }, { zeroMore: true }));
  assert.ok(z.free.every(f => f.total <= pick.total && f.delta <= 0 && f.gain >= 0)); assert.deepEqual(z.paid, []); assert.ok(z.text.startsWith(`Total stays at or under ${fmt(pick.total)}.`));
  const m = audit(X.moreMemorable(inv, pick, GOALS, { ...o, q: Q }));
  assert.ok(m.free.every(f => ['timing', 'location', 'free-thing', 'schedule', 'swap', 'date', 'destination'].includes(f.kind) && f.total <= pick.total));
  for (let i = 0; i < m.paid.length; i++) assert.ok(m.paid[i].total > (i ? m.paid[i - 1].total : pick.total) && m.paid[i].gain > 0 && m.paid[i].total <= Q.budget);
  if (m.free.some(f => f.kind === 'date')) assert.match(m.free.find(f => f.kind === 'date').text, /today's prices, not a forecast/);
});

test('finalCheck: the rebuild passes the check; the reasons are the trip\'s facts', () => {
  const ok = audit(X.finalCheck(pick, GOALS, { ...o, inv })); assert.ok(ok.ok && ok.rebuild === null); assert.equal(ok.text, 'FINAL EXPERIENCE CHECK: this trip serves what you told me.');
  assert.ok(ok.reasons.every(r => r.ok) && ok.reasons.some(r => r.text === `Main experience for amazing beach: ${main.name}`));
  const bare = price({ ...pick.spec, activities: [] }), fail = audit(X.finalCheck(bare, ['nature'], { ...o, inv }));
  assert.equal(fail.ok, false); assert.match(fail.reasons[0].text, /No experience in this trip serves nature, the goal you ranked #1/);
  assert.ok(fail.rebuild && X.finalCheck(fail.rebuild.trip, ['nature']).ok, 'the rebuild passes'); assert.equal(fail.rebuild.delta, fail.rebuild.total - bare.total); assert.match(fail.rebuild.text, /a proposal, nothing applied\.$/);
  // The smallest change, not the cheapest version: when one nature experience on the same flights, hotel and dates passes,
  // the rebuild is that (the fewest trade-offs, then the lowest total), never a cheaper hotel or fare swapped in as well.
  const adds = bare.activityOptions.filter(a => X.goalScore(a, ['nature']) > 0).map(a => price({ ...bare.spec, activities: [a.id] })).filter(p => p && p.total <= o.cap && X.finalCheck(p, ['nature']).ok);
  if (adds.length) {
    for (const k of ['nights', 'depart', 'hotel', 'flight']) assert.equal(fail.rebuild.trip.spec[k], bare.spec[k], `the rebuild keeps the ${k}`);
    const least = Math.min(...adds.map(p => classifyChanges(bare, p).tradeoffs.length));
    assert.equal(fail.rebuild.total, Math.min(...adds.filter(p => classifyChanges(bare, p).tradeoffs.length === least).map(p => p.total)));
  }
  const beachDay = X.finalCheck(bare, ['beach']); if (bare.hotel.features.beachfront) assert.ok(beachDay.reasons[0].ok && /open beach day/i.test(beachDay.reasons[0].text));
  assert.equal(X.finalCheck(price({ ...pick.spec, nights: 2 }), GOALS).ok, false, 'fewer than two full days fails');
});

// The rebuild a customer with these goals would take (the screenshot: a three-night Cancun trip with three experiences for
// two full days was offered "the rebuild that passes" as a cheaper hotel, other flights and no experience at all, passing only
// through "an open beach day"). Read off the inventory: the busy trip is the search's own, crowded with its top goal experiences.
test('finalCheck\'s rebuild keeps the main and the protected experience, never drops every experience, is the smallest change and says what it gives up', () => {
  const oc = { ...o, cap: 400000 }, s3 = X.experienceSearch(inv, { ...Q, nights: 3, dest: 'cancun', budget: 400000 }, GOALS, { ...oc, nightsOpen: false });
  const host = s3.candidates.find(c => X.rhythm(c.trip, GOALS).fullDays === 2).trip;
  const top = host.activityOptions.filter(a => X.goalScore(a, GOALS) > 0 && !a.months).sort((a, b) => X.goalScore(b, GOALS) - X.goalScore(a, GOALS) || b.hours - a.hours).slice(0, 3);
  const busy = price({ ...host.spec, activities: top.map(a => a.id).sort() }), m = X.mainOf(busy, GOALS), nameOf = id => busy.activities.find(a => a.id === id).name;
  const fc = audit(X.finalCheck(busy, GOALS, { ...oc, inv }));
  assert.equal(fc.ok, false, 'three experiences for two full days do not pass');
  const rb = fc.rebuild; assert.ok(rb, 'a rebuild that keeps what the trip is for passes');
  assert.ok(rb.trip.activities.length > 0, 'never passes by dropping every experience'); assert.ok(rb.trip.spec.activities.includes(m.id), 'the main experience stays');
  assert.ok(X.finalCheck(rb.trip, GOALS, oc).ok && rb.total <= oc.cap);
  // The smallest change: every same-frame version that keeps the main experience and passes changes at least as much, and of
  // those with as few changes none gives up less goal value (goal fit × size of what it drops).
  const frame = t => ['nights', 'depart', 'hotel', 'flight'].filter(k => t.spec[k] !== busy.spec[k]).length;
  const out = t => busy.spec.activities.filter(id => !t.spec.activities.includes(id)), changes = t => frame(t) + out(t).length + t.spec.activities.filter(id => !busy.spec.activities.includes(id)).length;
  const worth = t => out(t).reduce((n, id) => { const a = busy.activities.find(x => x.id === id); return n + X.goalScore(a, GOALS) * (a.hours >= X.BIG ? 2 : 1); }, 0);
  const same = busy.spec.activities.reduce((acc, id) => acc.concat(acc.map(x => [...x, id])), [[]]).filter(x => x.length && x.includes(m.id) && x.length < busy.spec.activities.length)
    .map(x => price({ ...busy.spec, activities: [...x].sort() })).filter(p => p && p.total <= oc.cap && X.finalCheck(p, GOALS, oc).ok);
  assert.ok(same.length, 'opening a day on the same frame passes');
  const fewest = Math.min(...same.map(changes)); assert.ok(changes(rb.trip) <= fewest, 'the smallest change');
  if (changes(rb.trip) === fewest && frame(rb.trip) === 0) assert.ok(worth(rb.trip) <= Math.min(...same.filter(p => changes(p) === fewest).map(worth)), 'the least goal value given up');
  // What it keeps and what it gives up are said, by name.
  for (const id of out(rb.trip)) assert.match(rb.text, new RegExp(`gives up [^;]*${esc(nameOf(id))}`));
  for (const id of busy.spec.activities.filter(x => rb.trip.spec.activities.includes(x))) assert.match(rb.text, new RegExp(`keeps [^;]*${esc(nameOf(id))}`));
  assert.match(rb.text, /^A rebuild that passes: .*; a proposal, nothing applied\.$/); assert.equal(fc.noRebuild, null);
  // The experience it dropped, protected: it stays as well, or no rebuild is offered and that is said plainly.
  const dropped = out(rb.trip)[0];
  if (dropped) {
    const fp = audit(X.finalCheck(busy, GOALS, { ...oc, protect: dropped, inv }));
    if (fp.rebuild) assert.ok(fp.rebuild.trip.spec.activities.includes(dropped) && fp.rebuild.trip.spec.activities.includes(m.id) && fp.rebuild.trip.activities.length > 0);
    else assert.match(fp.noRebuild, /^No rebuild I priced inside your rules and your \$4,000 maximum passes this check/);
  }
});

test('finalCheck: when only versions that drop the protected experience pass, no rebuild is offered and that is said plainly', () => {
  // A protected whale-watching cruise in July does not run: every version that keeps it fails; the ones that pass drop it.
  const gs = ['adventure'], t = build('los-cabos', ahead(7, 10), 5, ['sjd-a2', 'sjd-a3']), oc = { ...o, cap: 10000000, inv };
  const fc = audit(X.finalCheck(t, gs, { ...oc, protect: 'sjd-a2' }));
  assert.equal(fc.ok, false); assert.equal(fc.rebuild, null, 'never a rebuild without the protected experience');
  assert.match(fc.noRebuild, /^No rebuild I priced inside your rules and your \$100,000 maximum passes this check and keeps Whale-watching cruise \(Dec–Apr\)[^:]*: the versions that pass drop Whale-watching cruise \(Dec–Apr\), so I don't offer one as the fix\.$/);
  assert.ok(!/A rebuild that passes/.test(fc.text));
  // Unprotected and no longer the main one, it may go: the rebuild keeps the ATV ride and says what it gives up.
  const free = audit(X.finalCheck(t, gs, oc));
  if (free.rebuild) { assert.ok(free.rebuild.trip.spec.activities.includes('sjd-a3') && X.finalCheck(free.rebuild.trip, gs).ok); assert.match(free.rebuild.text, /gives up Whale-watching cruise/); }
});

test('finalCheck: an event the dates miss gets the rebuild that covers it with the experiences kept; with the dates fixed none, said plainly', () => {
  const t = res.candidates.find(c => c.trip.activities.length >= 1 && X.finalCheck(c.trip, GOALS).ok).trip, event = { name: 'your concert', date: addDays(t.spec.depart, t.spec.nights + 14) };
  const oc = { ...o, cap: 400000, inv, event }, fc = audit(X.finalCheck(t, GOALS, oc));
  assert.equal(fc.ok, false); assert.ok(fc.reasons.some(r => !r.ok && /falls after you fly home/.test(r.text)));
  assert.ok(fc.rebuild, 'the version that covers it, inside the ceiling, is the rebuild');
  assert.equal(X.eventCollision(fc.rebuild.trip, event), null); assert.ok(X.finalCheck(fc.rebuild.trip, GOALS, { ...o, cap: 400000, event }).ok);
  assert.deepEqual(fc.rebuild.trip.spec.activities, t.spec.activities, 'the experiences stay'); assert.ok(fc.rebuild.total <= oc.cap);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(fc.rebuild.text), 'dates in words'); assert.match(fc.rebuild.text, new RegExp(esc(longDate(fc.rebuild.trip.spec.depart))));
  const fixed = audit(X.finalCheck(t, GOALS, { ...oc, locks: { dates: true } }));
  assert.equal(fixed.rebuild, null); assert.match(fixed.noRebuild, /^No rebuild I priced inside your rules and your \$4,000 maximum passes this check\.$/);
});

test('protection marks exactly what the data can verify; the backup only for a weather-dependent main and never weather-dependent itself', () => {
  for (const c of res.candidates.filter((x, i) => i % 211 === 0).concat([ways.pick])) {
    const m = X.mainOf(c.trip, GOALS); if (!m) continue;
    const p = audit(X.protection(inv, c.trip, m, o)), by = Object.fromEntries(p.rows.map(r => [r.key, r.verified]));
    assert.deepEqual(Object.keys(by), ['availability', 'operating', 'age', 'restrictions', 'meeting', 'duration', 'cancellation', 'transport']);
    assert.deepEqual(by, { availability: true, operating: !!m.months, age: false, restrictions: false, meeting: false, duration: true, cancellation: true, transport: false });
    assert.ok(p.rows.filter(r => !r.verified).every(r => /not in our data/.test(r.value))); assert.ok(p.text.includes(`re-checked on ${longDate(today(now))}`), p.text);
    // The status ("Needs verification") comes from `verified`; a value that said it too read "not in our data: needs verification (needs verification)".
    for (const r of p.rows) assert.ok(!/needs verification|\(.*verif/i.test(r.value), `${r.key}: ${r.value}`);
    const b = X.backup(inv, c.trip, m, { ...o, goals: GOALS });
    assert.equal(b === null, !m.weather);
    if (b && b.activity) { assert.ok(!b.activity.weather && b.activity.kind !== m.kind && !c.trip.spec.activities.includes(b.activity.id)); checkPacked(b); assert.equal(b.over, b.total > o.cap); assert.equal(b.text, `Weather can't be guaranteed. If ${m.name} is called off, ${b.activity.name} is the fallback I'd book that day${b.overChoice ? ` within your ${fmt(o.cap)} maximum` : ''}; it is not added unless you say so.${b.overChoice ? ` ${b.overChoice.activity.name} would be my first fallback for your goals, but with it the trip is ${fmt(b.overChoice.total - o.cap)} over your maximum; going over is your call.` : b.over ? ` With it the trip is ${fmt(b.total - o.cap)} over your ${fmt(o.cap)} maximum; going over is your call.` : ''}`); }
  }
  const bd = X.bestDay(pick, main, { ...o, inv, goals: GOALS });
  assert.ok(bd.day && bd.day.full && bd.reasons.some(r => /Transport to the meeting point is not in our data/.test(r.text) && !r.ok) && bd.reasons.some(r => /Operating days are not in our data|Operating in|Not operating in/.test(r.text)));
  if (main.weather) assert.match(bd.weather, /^Weather-dependent: .* for \w+ according to .*; the weather itself can't be guaranteed; see the backup\.$/); else assert.equal(bd.weather, null);
});

test('the clock moved to another month changes the seasonal months verdict', () => {
  const destId = inv.maps.listDestinations().find(d => inv.activities.search({ destId: d.id, date: '2027-02-10', travelers: 2 }).some(a => a.id === 'sjd-a2')).id;
  const q = { ...Q, dest: destId };
  const winter = X.experienceSearch(inv, q, ['nature'], { ...o, now: new Date('2026-12-01T12:00:00Z') }), summer = X.experienceSearch(inv, q, ['nature'], { ...o, now: new Date('2027-05-01T12:00:00Z') });
  assert.ok(winter.candidates.some(c => c.trip.spec.activities.includes('sjd-a2')), 'whale-watching is built in season');
  assert.ok(summer.candidates.length > 0 && summer.candidates.every(c => !c.trip.spec.activities.includes('sjd-a2')), 'never out of season');
  const on = d => { const f = inv.flights.search({ from: 'JFK', destId, depart: d, nights: 4, travelers: 2 })[0], h = inv.hotels.search({ destId, checkIn: d, nights: 4, rooms: 1 })[0]; return price({ dest: destId, from: 'JFK', depart: d, nights: 4, travelers: 2, who: 'couple', flight: f.id, hotel: h.id, activities: ['sjd-a2'], bags: false, transfer: false }); };
  const feb = X.protection(inv, on('2027-02-10'), 'sjd-a2', o).rows.find(r => r.key === 'operating'), jul = X.protection(inv, on('2027-07-10'), 'sjd-a2', o).rows.find(r => r.key === 'operating');
  assert.ok(feb.verified && !jul.verified && /^in season/.test(feb.value) && /^out of season/.test(jul.value), 'the operating row is verified only in season');
  const julP = X.protection(inv, on('2027-07-10'), 'sjd-a2', o); assert.equal(julP.rows.find(r => r.key === 'availability').verified, false); assert.ok(julP.blocked && /does not run on these dates .*: this trip should not be built around it\.$/.test(julP.text));
  assert.equal(X.bestDay(on('2027-07-10'), 'sjd-a2', { inv }).reasons.find(r => /operating/i.test(r.text)).ok, false);
});

test('hotel or experience, the $100 test, one big thing, pack, big vs many, location, destination, alternative, same feeling, surprise, downsell, value check, allocation', () => {
  const h = audit(X.hotelOrExperience(inv, pick, GOALS, o));
  if (h.a) { assert.ok(h.a.delta > 0 && strategies.stepUp(pick, h.a.trip, pick.spec.nights).stay.length); assert.equal(h.a.text, `Hotel upgrade +${fmt(h.a.delta)}`); }
  if (h.b) { assert.ok(h.b.names.length >= 1 && h.b.names.length <= 2 && h.b.activities.every(a => X.goalScore(a, GOALS) > 0)); assert.equal(h.b.text, `${h.b.names.length === 2 ? 'Two' : 'One'} experience${h.b.names.length === 2 ? 's' : ''} +${fmt(h.b.delta)}`); }
  assert.ok(h.verdict !== 'b' || /^(Based on what you told me|Within your \$[\d,.]+), I'd take the experiences/.test(h.text)); assert.ok(h.verdict !== 'a' || (h.gains.a > 0 && /^(Based on what you told me|Within your \$[\d,.]+), I'd take the hotel: /.test(h.text)));
  if (h.verdict) assert.equal(h[h.verdict].over, false, 'the recommendation is never over the ceiling');
  const mt = audit(X.memoryTest(inv, pick, GOALS, o));
  for (const c of mt.candidates) { assert.ok(['activity', 'night', 'location', 'food', 'timing', 'transfer', 'free'].includes(c.kind)); if (c.kind !== 'free') assert.ok(c.delta >= 5000 && c.delta <= 15000); }
  if (mt.pick) { assert.ok(mt.candidates.every(c => c.gain < mt.pick.gain || (c.gain === mt.pick.gain && c.delta >= mt.pick.delta))); assert.ok(mt.text.startsWith(`Where about $100 makes the biggest difference: ${mt.pick.label}, ${mt.pick.kind === 'free' ? '+$0' : `+${fmt(mt.pick.delta)}`}: `)); }
  const mt2 = X.memoryTest(inv, pick, GOALS, o, 25000); assert.ok(mt2.candidates.filter(c => c.kind !== 'free').every(c => c.delta >= 12500 && c.delta <= 37500));
  const big = audit(X.oneBigThing(inv, Q, GOALS, o));
  assert.ok(big.main && X.goalScore(big.main, GOALS) === 3 && big.total <= Q.budget && big.day.full && big.day.label === 'Main experience' && big.rhythm.days.filter(d => d.items.includes(big.main.name)).length === 1);
  if (['evening', 'night'].includes(big.main.slot)) assert.ok(big.trip.flight.returnDepartMinutes >= 9 * 60 || big.day !== big.rhythm.days[big.trip.spec.nights - 1]);
  assert.ok(big.protection.rows.length === 8 && /strongest single experience/.test(big.why));
  const pk = audit(X.packTrip(inv, pick, GOALS, o)), pr = X.rhythm(pk.trip, GOALS);
  assert.ok(pk.trip.activities.length <= pr.fullDays - 1 && pr.openDays >= 1 && pk.total <= Q.budget); assert.equal(pk.text, `I stopped at ${pk.trip.activities.length}: this trip has ${pr.fullDays} full days and I keep one open.`); assert.doesNotMatch(pk.text, /fill every day/i);
  const bm = audit(X.bigVsMany(inv, pick, GOALS, o));
  if (bm.a) { assert.ok(bm.a.activity.hours >= X.BIG && X.goalScore(bm.a.activity, GOALS) > 0); if (bm.b) assert.ok(bm.b.activities.length >= 2 && bm.b.activities.length <= 3 && Math.abs(bm.b.cost - bm.a.cost) <= bm.a.cost * 0.15 && bm.b.activities.every(a => a.hours < X.BIG)); assert.doesNotMatch(bm.text, /I'd (take|pick|choose)/); }
  const lc = audit(X.locationCheck(inv, pick, ['beach', 'food'], o));
  if (lc.a) assert.ok(!X.beachAccess(lc.a.hotel) && /, but not on the beach you said is the point$/.test(lc.a.text)); if (lc.b) assert.ok(lc.b.hotel.features.beachfront && /, beachfront$/.test(lc.b.text)); assert.equal(lc.verdict, lc.b && !lc.b.over ? 'For Experience Max, I\'d use the better location.' : null);
  const dm = audit(X.destinationMatch(inv, Q, GOALS, o));
  assert.ok(dm.finalists.length >= 2 && dm.finalists.every(f => f.dest.name && f.met.length && f.total <= Q.budget)); assert.ok(dm.why.startsWith(`WHY THIS DESTINATION: ${dm.finalists[0].dest.name} meets `)); assert.doesNotMatch(dm.why, /famous/i);
  assert.equal(dm.whyNot.length, dm.finalists.length - 1); dm.whyNot.forEach((line, i) => assert.ok(line.startsWith(`${dm.finalists[i + 1].dest.name}: `) && /no .* experience|dearer for the same goals|less usable time|lower experience score/.test(line)));
  const wanted = pick.activityOptions.find(a => !pick.spec.activities.includes(a.id)), al = audit(X.alternative(inv, pick, GOALS, wanted, { ...o, cap: pick.total + 2000 }));
  assert.equal(al.fits, false); assert.doesNotMatch(al.text, /over budget/i); assert.match(al.provider, /no second provider/);
  assert.ok(al.options.every(x => x.total <= pick.total + 2000 && ['destination', 'date', 'similar', 'shorter', 'configuration'].includes(x.kind) && x.differences));
  assert.equal(X.alternative(inv, pick, GOALS, wanted, { ...o, cap: pick.total + 100000 }).fits, X.fitsSchedule(price({ ...pick.spec, activities: [...pick.spec.activities, wanted.id].sort() }), GOALS), 'fits only when the money and the rhythm both hold it');
  const sf = audit(X.sameFeeling(inv, Q, GOALS, pick, o));
  if (sf.trip) { assert.ok(sf.trip.dest.id !== pick.dest.id && sf.total < pick.total && sf.text.startsWith('Different trip. Similar goal. ') && sf.differences.length > 0); assert.ok(X.goalScore(X.mainOf(sf.trip, GOALS), GOALS) >= X.goalScore(main, GOALS)); } else assert.equal(sf.text, 'Nothing elsewhere meets the same goals for less.');
  const s1 = audit(X.surpriseOne(inv, pick, GOALS, null, o));
  if (s1.activity) { assert.ok(X.goalScore(s1.activity, GOALS) === 0 && !pick.spec.activities.includes(s1.activity.id) && s1.total <= Q.budget && s1.day.full); assert.match(s1.why, new RegExp(`^outside what you asked for \\(its kind: ${esc(s1.activity.kind)}.*\\), (in season on ${esc(longDate(s1.day.date))} \\(runs .*\\)|its operating days are not in our data), on a day that was open \\(${esc(longDate(s1.day.date))}\\); [+−]\\$`)); assert.equal(/in season/.test(s1.why), !!s1.activity.months, '"in season" only from the partner\'s months'); }
  const sc = audit(X.surpriseCompletely(inv, Q, o)); assert.ok(sc.pick && sc.required.length === sc.pick.trip.policies.length && /review page's terms are the ones the quote already carries/.test(sc.text));
  let ds = null; for (const c of res.candidates) { ds = X.downsell(inv, c.trip, GOALS, o); if (ds) { audit(ds); assert.ok(ds.saved === c.trip.total - ds.hotelOnly.total && ds.saved > 0 && X.hotelFit(ds.cheaper, GOALS) >= X.hotelFit(c.trip.hotel, GOALS)); assert.ok(ds.text.startsWith(`I found another hotel that meets your requirements for ${fmt(ds.saved)} less: ${ds.cheaper.name}`)); assert.equal(/; the trade-offs?: /.test(ds.text), classifyChanges(c.trip, ds.hotelOnly.trip).tradeoffs.length > 0, 'what the cheaper hotel gives up is said'); if (ds.experience) assert.equal(ds.covers, ds.total <= c.trip.total); break; } }
  assert.ok(ds, 'a downsell was exercised');
  const vc = X.valueCheck(inv, pick, main, GOALS); assert.deepEqual(vc.rows.map(r => `${r.key}:${r.known}`), ['price:true', 'duration:true', 'transport:false', 'scheduling:true', 'included:false', 'cancellation:true', 'priority:true']);
  const al1 = X.allocation(pick, Q.budget), al2 = X.allocation(pick, Q.budget, { inv, o });
  assert.equal(al1.lines.reduce((n, l) => n + l.amount, 0), pick.total); assert.equal(al1.keep, Q.budget - pick.total); assert.ok(al1.text.startsWith('Where the money goes: '));
  // "keep $X for the experiences" only when the step-up it passed on would have fit the max: the money is really there.
  assert.equal(/^I'd choose the simpler hotel and keep \$[\d,.]+ for the experiences you said are the reason you're going\.$/.test(al2.text), !!h.a && h.a.delta <= Q.budget - pick.total);
  if (h.a && h.a.delta <= Q.budget - pick.total) assert.ok(al2.text.includes(`keep ${fmt(h.a.delta)} for`));
  let kept = 0;
  for (const c of res.candidates.filter((x, i) => i % 61 === 0)) {
    const up = X.hotelOrExperience(inv, c.trip, GOALS, o).a, al = X.allocation(c.trip, Q.budget, { inv, o }), fits = !!up && up.delta <= Q.budget - c.total;
    assert.equal(al.text.startsWith('I\'d choose the simpler hotel'), fits); if (fits) { kept++; assert.ok(al.text.includes(`keep ${fmt(up.delta)} for`)); }
  }
  assert.ok(kept > 0, 'the simpler-hotel line was exercised');
  const cu = audit(X.challengeUpgrade(pick, h.a, GOALS, inv, o));
  if (h.a) { assert.equal(cu.challenge, cu.gain <= 0); if (cu.challenge) { assert.equal(cu.text, 'You told me the trip itself matters more than the room. I\'d keep the standard room and use the money outside the hotel.'); assert.equal(cu.instead.amount, h.a.delta); } }
  assert.deepEqual(X.learn({ worth: ['Food', 'Main experience'], notWorth: ['Hotel'] }).prefs, { stayMatters: false, mainMatters: true, goalsAdd: ['food'] }); assert.deepEqual(X.WORTH_IT_CHIPS, ['Hotel', 'Food', 'Main experience', 'Free time', 'Nightlife', 'Location', 'Other']);
});

test('the protected experience survives every other engine', () => {
  const protect = main.id, ctx = { ...optimizer.budgetContext(Q), protect, goals: GOALS, rules: null, dateMode: null }, po = { now, locks: {}, prefs: { rules: null }, protect };
  const keeps = (label, r) => { const ts = tripsIn(r); assert.ok(ts.length > 0, `${label} priced something`); for (const t of ts) assert.ok(t.spec.activities.includes(protect), `${label} keeps the protected experience`); };
  const has = tok => decodeSpec(tok).activities.includes(protect);
  const lean = leaks.lean(inv, pick, settings, ctx, po); assert.ok(has(lean.lean.token) && lean.kept.some(k => k === `${main.name} (the protected experience)`) && !lean.givesUp.includes(main.name));
  const ex = leaks.optionalExtras(inv, pick, settings, ctx, po).find(e => e.key.endsWith(protect)); assert.ok(ex.required && !ex.stated && ex.reason === leaks.PROTECTED, 'required, never "stated": the agent may have protected it');
  const r1 = leaks.removeOne(inv, pick, settings, ctx, po); assert.ok(r1 && has(r1.token) && r1.label !== main.name);
  const bl = leaks.biggestLeak(inv, pick, settings, ctx, po); assert.ok(bl && has(bl.token));
  const ci = leaks.cutInOrder(inv, pick, settings, ctx, pick.total - 60000, po); assert.ok(ci.steps.length && ci.steps.every(s => has(s.token)));
  const fs = leaks.finalScan(inv, pick, settings, ctx, po); assert.ok(!fs.found || has(fs.found.token)); assert.match(fs.checks.find(c => c.key === 'addons').text, /the protected experience|nothing you told me asks for it/);
  assert.equal(leaks.whyKept(inv, pick, settings, ctx, po).kept.find(i => i.label === main.name).why, 'the protected experience');
  const hl = savemax.howLow(inv, pick, settings, ctx, { now, locks: {} }); assert.ok(has(hl.recommend.token) && (!hl.cheapest || has(hl.cheapest.token)));
  keeps('savingsCheck', savemax.savingsCheck(inv, pick, settings, ctx, { now, locks: {} }).cheaper || { trip: pick });
  keeps('nameYourPrice', decision.nameYourPrice(inv, pick, settings, ctx, pick.total - 40000, { now, locks: {} }));
  const q2 = { ...Q, protect, dest: pick.dest.id }, tw = strategies.threeWays(inv, q2, { settings, now }); keeps('threeWays', tw);
  keeps('budgetShift down', strategies.budgetShift(inv, q2, pick, pick.total - 20000, { settings, now, protect })); keeps('budgetShift up', strategies.budgetShift(inv, q2, pick, pick.total + 40000, { settings, now, protect }));
  const chosen = tw.strategies[0]; for (const k of ['more', 'keep']) { const pd = strategies.pushDirection(inv, q2, chosen, k, { settings, now, protect }); if (tripsIn(pd).length) keeps(`pushDirection ${k}`, pd); }
  const comp = decision.compromises(price({ ...pick.spec, activities: [] }), ctx); assert.ok(comp.some(c => c.w === 3 && c.text === `without ${main.name}, the protected experience`));
  assert.ok(!decision.compromises(pick, ctx).some(c => /protected/.test(c.text)));
  const lowest = savemax.lowestRecommended(res.candidates.map(c => ({ trip: c.trip, token: c.token, total: c.total })), { style: 'surprise', priority: 'price', protect }); if (lowest) assert.ok(lowest.trip.spec.activities.includes(protect));
});

test('context: mem= and px= ride on every link, validated; the quote stores asks.goals and protect only when the link carried them', async () => {
  const cx = optimizer.parseContext({ mem: 'beach,food,x,nature,culture', px: main.id, b: '2500' });
  assert.deepEqual(cx.goals, ['beach', 'food', 'nature']); assert.equal(cx.protect, main.id);
  assert.deepEqual(optimizer.parseContext({ mem: ['food,beach', 'x'], px: ['cun-a1', 'y'] }).goals, ['food', 'beach'], 'a repeated key reads its first value');
  assert.equal(optimizer.parseContext({ px: 'bad id!' }).protect, null); assert.deepEqual(optimizer.parseContext({}).goals, []);
  const params = new URLSearchParams(optimizer.contextParams(cx)); assert.equal(params.get('mem'), 'beach,food,nature'); assert.equal(params.get('px'), main.id);
  assert.equal(new URLSearchParams(optimizer.contextParams(optimizer.parseContext({ b: '2500' }))).has('mem'), false);
  const app = await startApp({}, { now: () => now });
  try {
    const token = encodeSpec(pick.spec), v = await app.tripService.verify(token, 0), make = c => app.tripService.createQuote(token, { approvedTotal: v.trip.total, budget: Q.budget, keep: 0, allowOver: 0, promoCode: null, user: null, cx: c });
    const withGoals = await make(cx); assert.deepEqual(withGoals.budget.asks.goals, ['beach', 'food', 'nature']); assert.equal(withGoals.budget.protect, main.id);
    const plain = await make(optimizer.parseContext({ b: '2500' })); assert.equal('goals' in plain.budget.asks, false); assert.equal('protect' in plain.budget, false);
    const lo = app.tripService.leakOptions(v.trip, cx), lc = app.tripService.leakContext(cx); assert.equal(lo.protect, main.id); assert.deepEqual(lo.prefs.goals, cx.goals); assert.equal(lc.protect, main.id); assert.deepEqual(lc.goals, cx.goals);
  } finally { await app.close(); }
});

test('no text pressures anyone, promises weather, or calls two trips identical', () => {
  TEXTS.push(...X.PERSONALITY, ...X.BRAND_LINES, X.SIGNATURE_LINE, X.FINAL_LINE, X.NEW_NOTE, X.NO_DUPE, ways.reason, ways.signature || '');
  assert.ok(TEXTS.length > 500);
  for (const t of TEXTS) assert.doesNotMatch(t, PRESSURE, t);
  assert.ok(!X.PERSONALITY.some(l => /fill every day|money left/i.test(l)));
  assert.equal(X.SIGNATURE_LINE, 'SPEND ON THE MEMORIES. NOT THE LABELS.'); assert.equal(X.FINAL_LINE, 'DON\'T JUST UPGRADE THE TRIP. UPGRADE THE MEMORY.');
});

test('inside the engine the protected experience stays: search, versions, free time, $0-more, big vs many, conflicts, trade and the rebuild', () => {
  const host = res.candidates.find(c => c.trip.activities.length >= 2 && c.trip.spec.nights >= 5).trip, m = X.mainOf(host, GOALS);
  const px = host.activities.filter(a => a.id !== m.id).sort((a, b) => X.goalScore(a, GOALS) - X.goalScore(b, GOALS))[0].id; // the one an engine would drop first
  const po = { ...o, protect: px, inv }, keeps = (label, ts) => { for (const t of ts) assert.ok(t.spec.activities.includes(px), `${label} keeps the protected experience`); };
  const s2 = X.experienceSearch(inv, { ...Q, dest: host.dest.id }, GOALS, po); assert.ok(s2.candidates.length > 0); keeps('experienceSearch', s2.candidates.map(c => c.trip));
  keeps('versionsOf', X.versionsOf(inv, host, GOALS, po, null).map(c => c.trip));
  const crowded = price({ ...host.spec, activities: host.activityOptions.filter(a => X.goalScore(a, GOALS) > 0 || a.id === px).map(a => a.id).sort() });
  if (crowded) { const f = X.fatigue(crowded, GOALS, po); if (f.freeTime) assert.notEqual(f.freeTime.removed.id, px); keeps('collisions', tripsIn(X.collisions(crowded, { inv, settings, goals: GOALS, protect: px }))); }
  const mm = audit(X.moreMemorable(inv, host, GOALS, { ...po, q: Q })); keeps('moreMemorable', tripsIn(mm).filter(t => t !== host)); assert.ok(!mm.free.some(f => f.kind === 'destination'));
  const bm = audit(X.bigVsMany(inv, host, GOALS, po)); keeps('bigVsMany', tripsIn(bm));
  const wanted = host.activityOptions.find(a => !host.spec.activities.includes(a.id)); if (wanted) keeps('trade', tripsIn(X.trade(inv, host, wanted, { ...po, goals: GOALS })));
  const bare = price({ ...host.spec, activities: [m.id] }), fc = X.finalCheck(bare, GOALS, po);
  assert.equal(fc.ok, false); assert.ok(fc.reasons.some(r => !r.ok && r.text.startsWith('Without ') && r.text.endsWith(', the protected experience')));
  if (fc.rebuild) { keeps('finalCheck rebuild', [fc.rebuild.trip]); assert.ok(X.finalCheck(fc.rebuild.trip, GOALS, { ...po, inv: null }).ok); }
  // An explicit ask for a different trip is not held to it (another destination cannot offer it); the agent's gate says so.
  const sf = X.sameFeeling(inv, Q, GOALS, host, po); if (sf.trip) assert.ok(sf.differences.some(d => / instead of /.test(d)));
});

test('hotel or experience: the hotel wins only when its step-up gives access a goal asks for, ranked at or above the experiences\' goals', () => {
  let a = 0, flips = 0;
  for (const c of res.candidates.filter((x, i) => i % 23 === 0)) {
    const t = c.trip, rom = X.hotelOrExperience(inv, t, ['romantic', 'food'], o), food = X.hotelOrExperience(inv, t, ['food', 'culture'], o);
    assert.notEqual(food.verdict, 'a', 'no goal asks for the stay'); if (food.b) assert.equal(food.verdict, food.b.over ? null : 'b', 'the experiences, unless over the ceiling');
    if (rom.a && rom.a.hotel.features.beachfront && !t.hotel.features.beachfront && !rom.a.over) { a++; assert.equal(rom.verdict, 'a', 'goal #1 romantic with a beachfront step-up counts as the experience'); assert.match(rom.text, /^Based on what you told me, I'd take the hotel: a beachfront hotel for the romantic you ranked #1\.$/); if (food.verdict === 'b') flips++; }
    if (rom.verdict === 'a') assert.ok(rom.a && X.hotelFit(rom.a.hotel, ['romantic', 'food']) > X.hotelFit(t.hotel, ['romantic', 'food']));
  }
  assert.ok(a > 0 && flips > 0, `the goals decided the verdict (${a} hotel verdicts, ${flips} flips)`);
});

test('every suggested version keeps a schedule the rhythm can hold, in season; empty goals never crash', () => {
  const holds = t => { const r = X.rhythm(t, GOALS); return !r.unplaced.length && !r.lateThenEarly.length && r.placed.every(p => !p.activity.months || p.activity.months.includes(monthOf(p.day.date))); };
  for (const c of res.candidates.filter((x, i) => i % 157 === 0).concat([ways.pick])) {
    for (const v of X.memoryTest(inv, c.trip, GOALS, o).candidates) assert.ok(holds(v.trip), `memoryTest ${v.kind}`);
    for (const v of X.moreMemorable(inv, c.trip, GOALS, { ...o, q: Q }, { zeroMore: true }).free) assert.ok(holds(v.trip) || !holds(c.trip), `moreMemorable ${v.kind}`);
    const ds = X.downsell(inv, c.trip, GOALS, o); if (ds && ds.experience) { assert.ok(holds(ds.trip)); const g = X.goalOf(ds.experience, GOALS); assert.ok(ds.text.includes(`the ${X.goalLabel(g).toLowerCase()} experience you ranked #${GOALS.indexOf(g) + 1}`)); }
    const pk = X.packTrip(inv, c.trip, GOALS, o); assert.ok(holds(pk.trip));
  }
  const none = X.experienceWays(inv, Q, [], o); assert.ok(none.pick ? none.pick.total <= Q.budget : /Nothing the inventory priced/.test(none.reason));
  const ev = { date: pick.spec.depart, name: 'Concert' }, fc = X.finalCheck(pick, GOALS, { ...o, event: ev }); assert.equal(fc.ok, false); assert.ok(fc.reasons.some(r => !r.ok && /^SCHEDULE CONFLICT: Concert on/.test(r.text)));
  const wanted = pick.activityOptions.find(a => !pick.spec.activities.includes(a.id)), held = X.alternative(inv, pick, GOALS, wanted, { ...o, cap: pick.total + 2000, locks: { dates: true } });
  assert.ok(held.options.every(x => x.kind !== 'date' && x.trip.spec.depart === pick.spec.depart), 'locked dates: every option leaves on the same day');
});

// ---- the rules each review finding broke, asserted from the inventory's facts ---------------------------
// A date with this month and day at least three weeks out (this year or next), so a test reads the same
// calendar facts whatever today is; prices move with it, the rules do not.
const ahead = (m, d) => { const t0 = addDays(today(now), 21), iso = `${t0.slice(0, 4)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return iso < t0 ? `${Number(t0.slice(0, 4)) + 1}${iso.slice(4)}` : iso; };
const build = (destId, depart, nights, activities, { flight = fs => fs[0], hotel = hs => hs[0] } = {}) => {
  const f = flight(inv.flights.search({ from: 'JFK', destId, depart, nights, travelers: 2 })), h = hotel(inv.hotels.search({ destId, checkIn: depart, nights, rooms: 1 }));
  return f && h ? price({ dest: destId, from: 'JFK', depart, nights, travelers: 2, who: 'couple', flight: f.id, hotel: h.id, activities: [...activities].sort(), bags: false, transfer: false }) : null;
};
const runsOnDay = (a, iso) => !a.months || a.months.includes(monthOf(iso));
const seasonHolds = (t, gs) => X.rhythm(t, gs).placed.every(p => runsOnDay(p.activity, p.day.date));

test('C00: no suggestion fills every day of a trip of 4 nights or more; each keeps the open day the final check asks for', () => {
  const o4 = { ...o, cap: 400000 }, s4 = X.experienceSearch(inv, { ...Q, nights: 4, dest: 'cancun', budget: 400000 }, GOALS, { ...o4, nightsOpen: false });
  const hosts = s4.candidates.filter(c => c.trip.spec.nights === 4 && c.trip.activities.length === 2 && X.rhythm(c.trip, GOALS).openDays === 1).filter((c, i) => i % 7 === 0).slice(0, 4);
  assert.ok(hosts.length, 'a 4-night trip with two experiences and one open day');
  let seen = 0;
  for (const { trip: t } of hosts) {
    assert.ok(X.fitsSchedule(t, GOALS) && X.finalCheck(t, GOALS).ok);
    const fine = (label, r) => { for (const v of tripsIn(r).filter(x => x !== t && x.spec.nights >= 4)) { seen++; assert.ok(X.fitsSchedule(v, GOALS), `${label}: ${encodeSpec(v.spec)} keeps an open day`); assert.ok(!X.finalCheck(v, GOALS).reasons.some(x => /No open day/.test(x.text)), label); } };
    fine('hotelOrExperience', X.hotelOrExperience(inv, t, GOALS, o4)); fine('memoryTest', X.memoryTest(inv, t, GOALS, o4)); fine('downsell', X.downsell(inv, t, GOALS, o4) || {});
    fine('surpriseOne', X.surpriseOne(inv, t, GOALS, null, o4)); fine('bigVsMany', X.bigVsMany(inv, t, GOALS, o4)); fine('packTrip', X.packTrip(inv, t, GOALS, o4));
    fine('moreMemorable', X.moreMemorable(inv, t, GOALS, { ...o4, q: Q }));
    for (const w of t.activityOptions.filter(a => !t.spec.activities.includes(a.id))) {
      fine('trade', X.trade(inv, t, w, { ...o4, goals: GOALS }));
      const al = X.alternative(inv, t, GOALS, w, o4); fine('alternative', al.options);
      if (al.fits) assert.ok(X.fitsSchedule(al.trip, GOALS), 'fits only when the rhythm holds it');
    }
  }
  assert.ok(seen > 10, `suggestions were read (${seen})`);
});

test('C01-C03: season is read on the day the rhythm gives each experience; out of season is never available, in season or a suggestion', () => {
  const gs = ['adventure', 'nature'], nl = 'kef-a3';
  // Late March into April: the northern lights run in March only, so the rhythm puts them on a March day.
  const spring = build('reykjavik', ahead(3, 29), 5, ['kef-a1', nl]), rs = X.rhythm(spring, gs);
  assert.ok(rs.placed.some(p => p.activity.id === nl) && seasonHolds(spring, gs), 'placed on a day it runs');
  assert.ok(!X.finalCheck(spring, gs).reasons.some(r => /does not run/.test(r.text)));
  // All of the full days in April: unplaced, said as a season conflict, never "available", a blocker.
  const april = build('reykjavik', ahead(4, 1), 4, ['kef-a1', nl]), ra = X.rhythm(april, gs);
  assert.ok(ra.unplaced.some(a => a.id === nl) && !ra.placed.some(p => p.activity.id === nl) && !X.fitsSchedule(april, gs) && !X.fitsSchedule(april, gs, { strict: false }));
  assert.ok(X.collisions(april, { goals: gs }).some(c => c.kind === 'season' && c.activity.id === nl)); assert.equal(X.finalCheck(april, gs).ok, false);
  const pa = X.protection(inv, april, nl, o), by = Object.fromEntries(pa.rows.map(r => [r.key, r.verified]));
  assert.ok(!by.availability && !by.operating && pa.blocked && /should not be built around it/.test(pa.text));
  assert.equal(X.alternative(inv, build('reykjavik', ahead(4, 1), 4, ['kef-a1']), gs, nl, { ...o, cap: 10000000 }).fits, false, 'never "fits" out of season');
  // Late August into September: a September day exists, so the lights go there and the check agrees.
  const fall = build('reykjavik', ahead(8, 29), 5, [nl]), rf = X.rhythm(fall, gs), at = rf.placed.find(p => p.activity.id === nl);
  assert.ok(at && monthOf(at.day.date) === 9 && X.finalCheck(fall, gs).ok); assert.ok(X.protection(inv, fall, nl, o).rows.find(r => r.key === 'operating').verified);
  // The suggestions put each added experience on a day it runs.
  for (const base of [build('reykjavik', ahead(3, 29), 5, ['kef-a1']), build('reykjavik', ahead(3, 30), 6, [])]) {
    const pk = X.packTrip(inv, base, gs, o); assert.ok(seasonHolds(pk.trip, gs) && X.fitsSchedule(pk.trip, gs));
    const s1 = X.surpriseOne(inv, base, ['culture'], null, o); if (s1.activity) assert.ok(runsOnDay(s1.activity, s1.day.date) && seasonHolds(s1.trip, ['culture']));
  }
  const cabos = build('los-cabos', ahead(7, 10), 5, ['sjd-a3']), tr = X.trade(inv, cabos, 'sjd-a2', { ...o, goals: ['nature'] });
  assert.ok(tr.trip === null && /does not run on these dates/.test(tr.text)); assert.equal(X.alternative(inv, cabos, ['nature'], 'sjd-a2', { ...o, cap: 10000000 }).fits, false);
});

test('C04: the rhythm places by search, not first come: two experiences that fit two full days are both placed', () => {
  const gs = ['nightlife', 'culture'], t = build('bangkok', ahead(11, 16), 4, ['bkk-a2', 'bkk-a3'], { flight: fs => fs.find(f => f.returnDepartMinutes >= 9 * 60) });
  const r = X.rhythm(t, gs);
  assert.ok(t.flight.arrivesNextDay && r.fullDays === 2);
  assert.equal(r.unplaced.length, 0, 'the morning market before the evening tour: both fit'); assert.equal(r.main.id, 'bkk-a2', 'goal #1 keeps the main day');
  for (const p of r.placed) { const prev = r.days[p.day.n - 2]; assert.ok(!(p.activity.slot === 'morning' && prev && ['evening', 'night'].includes(prev.slot))); }
  assert.ok(!X.collisions(t, { goals: gs }).some(c => /only day left is your arrival day/.test(c.text)));
});

// ONE BIG MEMORY vs MORE THINGS TO DO under a protected experience on a short trip: a big experience the
// destination offers but this trip cannot hold is named with the rhythm's reason, never "none is offered".
test('ONE BIG MEMORY vs MORE THINGS TO DO never says no big experience is offered while one is; one that does not fit is named with why', () => {
  const gs = ['adventure', 'culture', 'food'], q = { ...Q, nights: 3, budget: 900000, vacationBudget: 900000 }, seen = new Set();
  let named = 0;
  for (const c of X.experienceSearch(inv, q, gs, { now, settings, locks: {}, cap: 900000 }).candidates) {
    const k = `${c.trip.spec.dest}~${c.trip.spec.flight}`; if (seen.has(k)) continue; seen.add(k);
    for (const px of c.trip.activityOptions.map(a => a.id)) {
      const t = price({ ...c.trip.spec, activities: [...new Set([...c.trip.spec.activities, px])].sort() }); if (!t) continue;
      const r = X.bigVsMany(inv, t, gs, { now, settings, cap: 900000, q, protect: px });
      if (r.a) continue;
      const big = t.activityOptions.filter(x => X.goalScore(x, gs) > 0 && x.hours >= X.BIG && x.id !== px);
      if (!big.length) { assert.match(r.text, /^No big experience/); continue; }
      named++;
      assert.doesNotMatch(r.text, /No big experience/, `${encodeSpec(t.spec)} protecting ${px}: ${r.text}`);
      assert.ok(big.some(b => r.text.startsWith(`${b.name} (${b.hours}h) is the big experience for your goals in ${t.dest.name}, but it does not`)), r.text);
    }
  }
  assert.ok(named > 0, 'a big experience that does not fit was exercised');
});

test('C05: the all-inclusive style and the stated hotel rules survive every hotel move; "meets your requirements" names what it gives up', () => {
  const q = { ...Q, style: 'all-inclusive', budget: 400000, vacationBudget: 400000 }, oa = { ...o, cap: 400000, q }, sr = X.experienceSearch(inv, q, GOALS, oa);
  const ai = t => optimizer.hotelAllowed(t.hotel, { who: t.spec.who, style: 'all-inclusive' });
  assert.ok(sr.candidates.length && sr.candidates.every(c => ai(c.trip)));
  let moves = 0;
  for (const { trip: t } of sr.candidates.filter((c, i) => i % 59 === 0)) {
    const every = (label, r) => { for (const v of tripsIn(r).filter(x => x.spec.hotel !== t.spec.hotel)) { moves++; assert.ok(ai(v), `${label}: ${v.hotel.name} keeps the all-inclusive style`); } };
    const ds = X.downsell(inv, t, GOALS, oa); every('downsell', ds || {});
    if (ds) assert.equal(/; the trade-offs?: /.test(ds.text), classifyChanges(t, ds.hotelOnly.trip).tradeoffs.length > 0);
    every('memoryTest', X.memoryTest(inv, t, GOALS, oa)); every('locationCheck', X.locationCheck(inv, t, GOALS, oa)); every('hotelOrExperience', X.hotelOrExperience(inv, t, GOALS, oa));
    every('moreMemorable', X.moreMemorable(inv, t, GOALS, oa, { zeroMore: true }));
    const w = t.activityOptions.find(a => !t.spec.activities.includes(a.id)); if (w) every('trade', X.trade(inv, t, w, { ...oa, goals: GOALS }));
    const fc = X.finalCheck(price({ ...t.spec, activities: [] }), ['nature'], { ...oa, inv }); if (fc.rebuild) every('finalCheck', fc.rebuild);
  }
  assert.ok(moves > 0, 'hotel moves were read');
});

test('C06: "Different trip. Similar goal." says every difference classifyChanges reads, other dates, bags and terms included', () => {
  let said = 0;
  for (const c of [{ trip: pick }, ...res.candidates.filter((x, i) => i % 97 === 0)]) {
    const sf = X.sameFeeling(inv, Q, GOALS, c.trip, o); if (!sf.trip) continue;
    for (const r of tripDiff(c.trip, sf.trip).filter(x => x.changed && ['bags', 'flex', 'time'].includes(x.key))) { said++; assert.ok(sf.differences.some(d => d.startsWith(`${r.label.toLowerCase()}: `)), `${r.label} said`); }
    if (sf.trip.spec.depart !== c.trip.spec.depart) { said++; assert.ok(sf.differences.some(d => /^dates: /.test(d)), 'other dates said'); }
    assert.ok(sf.text.includes(joinAndTest(sf.differences)));
  }
  assert.ok(said > 0, 'a difference beyond the frame was exercised');
});
const joinAndTest = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// savemax.whyNot names the state a version is in ("personal item only, no carry-on", "breakfast only, not
// all-inclusive"); said after "gives up" it would name what the customer keeps as what they lose.
test('a version\'s trade-offs are said as its trade-offs, never as "gives up" the state it is left in', () => {
  let said = 0;
  for (const c of [{ trip: pick }, ...res.candidates.filter((x, i) => i % 23 === 0)]) {
    const t = c.trip, z = X.moreMemorable(inv, t, GOALS, { ...o, q: Q }, { zeroMore: true }), ds = X.downsell(inv, t, GOALS, o);
    for (const v of [...X.memoryTest(inv, t, GOALS, o).candidates, ...z.givesUp, ...(ds ? [ds] : [])].filter(x => x.givesUp && x.givesUp.length)) {
      said++;
      for (const w of v.givesUp) assert.ok(!v.text.includes(`gives up ${w}`), v.text);
      assert.ok(v.text.includes(`the trade-off${v.givesUp.length > 1 ? 's' : ''}: `), v.text);
    }
  }
  assert.ok(said > 0, 'trade-offs were said');
});

// SURPRISE ME WITH ONE THING names the experience's own kinds, never as a list after "what you asked for",
// which would read as the customer's goals.
test('SURPRISE ME WITH ONE THING says the experience\'s kinds as its own, never as what the customer asked for', () => {
  let said = 0;
  for (const c of [{ trip: pick }, ...res.candidates.filter((x, i) => i % 17 === 0)]) {
    const s1 = X.surpriseOne(inv, c.trip, GOALS, null, o); if (!s1.activity) continue;
    said++;
    assert.ok(s1.why.startsWith(`outside what you asked for (its kind: ${s1.activity.kind}`), s1.why);
    assert.doesNotMatch(s1.why, new RegExp(`what you asked for \\((?!its kind: )`), s1.why);
  }
  assert.ok(said > 0, 'a surprise was offered');
});

test('C07 + C15 + C27: $0 more never crosses a lock, a fixed date or a stated length, and lists only what gives nothing up', () => {
  let gaveUp = 0, nights = 0;
  for (const c of [{ trip: pick }, ...res.candidates.filter((x, i) => i % 89 === 0)]) {
    const t = c.trip, s = t.spec;
    const lk = X.moreMemorable(inv, t, GOALS, { ...o, q: Q, locks: { dates: true, nights: true, hotel: true, flight: true } }, { zeroMore: true });
    for (const f of [...lk.free, ...lk.givesUp]) { assert.ok(!['destination', 'date'].includes(f.kind), f.kind); const v = f.trip.spec; assert.ok(v.dest === s.dest && v.depart === s.depart && v.nights === s.nights && v.hotel === s.hotel && v.flight === s.flight, f.text); }
    const ex = X.moreMemorable(inv, t, GOALS, { ...o, q: Q, ctx: { dateMode: 'exact' } }, { zeroMore: true });
    for (const f of [...ex.free, ...ex.givesUp]) assert.ok(f.trip.spec.depart === s.depart && f.kind !== 'destination', 'an exact date stays');
    const z = X.moreMemorable(inv, t, GOALS, { ...o, q: Q }, { zeroMore: true });
    for (const f of z.free) assert.equal(classifyChanges(t, f.trip).tradeoffs.length, 0, `${f.kind} gives nothing up`);
    for (const f of z.givesUp) { gaveUp++; assert.ok(classifyChanges(t, f.trip).tradeoffs.length > 0 && /; the trade-offs?: /.test(f.text) && z.text.includes(f.text)); }
    // An extra night only when the length is open.
    for (const oo of [{ ...o, nightsOpen: false }, { ...o, locks: { nights: true } }, { ...o, locks: { dates: true } }]) assert.ok(!X.memoryTest(inv, t, GOALS, oo).candidates.some(x => x.kind === 'night' || x.trip.spec.nights !== s.nights));
    if (X.memoryTest(inv, t, GOALS, o).candidates.some(x => x.kind === 'night')) nights++;
  }
  assert.ok(gaveUp > 0 && nights > 0, `trade-offs (${gaveUp}) and open lengths (${nights}) were exercised`);
});

test('C09 + C31: the recommendation is never a side over the maximum; going over is the customer\'s call', () => {
  let over = 0;
  for (const c of res.candidates.filter((x, i) => i % 41 === 0)) {
    const t = c.trip;
    for (const cap of [t.total, t.total + 15000, Q.budget]) {
      const h = X.hotelOrExperience(inv, t, GOALS, { ...o, cap });
      for (const k of ['a', 'b']) if (h[k]) assert.equal(h[k].over, h[k].total > cap);
      if (h.verdict) assert.ok(!h[h.verdict].over, h.text); else if (h.b && h.b.over) { over++; assert.match(h.text, /over your \$[\d,.]+ maximum|is already \$[\d,.]+ over it/); }
      const lc = X.locationCheck(inv, t, ['beach', 'food'], { ...o, cap });
      if (lc.b && lc.b.over) { over++; assert.equal(lc.verdict, null); assert.match(lc.text, /over your \$[\d,.]+ maximum; within it, I'd keep this hotel\. Going over is your call\./); }
    }
  }
  assert.ok(over > 0, 'an over-the-ceiling side was exercised');
});

test('C22 + C24: an event is read against the day the traveler lands; an overnight flight lands the next day', () => {
  const nights = 4, ev = { date: ahead(11, 20), name: 'Concert' }, fl = inv.flights.search({ from: 'JFK', destId: 'bangkok', depart: ev.date, nights, travelers: 2 })[0];
  assert.ok(fl.arrivesNextDay);
  const range = X.eventRange(ev, nights, fl);
  assert.ok(range.overnight && range.landBy === addDays(ev.date, -1) && range.latestDepart === addDays(ev.date, -2) && range.from === addDays(ev.date, 1 - nights));
  const at = d => build('bangkok', d, nights, [], { flight: fs => fs.find(f => f.id === fl.id) });
  for (const d of [range.from, range.to]) { const t = at(d), b = X.eventBuffer(t, ev); assert.ok(b.ok && !X.eventCollision(t, ev) && b.landing < ev.date && b.home > ev.date, `${d} leaves a day either side`); assert.match(b.text, new RegExp(`^you land ${esc(longDate(b.landing))}.*, the day after you leave \\(an overnight flight\\) and fly home ${esc(longDate(b.home))}:`)); }
  const late = at(addDays(range.to, 1)), L = X.landing(late), hit = X.eventCollision(late, ev);
  assert.ok(L.nextDay && L.date === ev.date && L.date === addDays(late.spec.depart, 1)); assert.ok(hit && /on your arrival day \(the overnight flight lands/.test(hit.text), 'leaving the day before lands on the event day');
  assert.ok(X.collisions(late, { event: ev, inv, settings, goals: GOALS }).find(c => c.kind === 'event').fixes.every(f => !f.trip || !X.eventCollision(f.trip, ev)), 'the move fixes it');
  assert.equal(X.eventRange(ev, 2, fl).from, null); assert.match(X.eventRange(ev, 2, fl).text, /3 nights is the minimum/);
  assert.equal(X.eventRange(ev, 2).from, addDays(ev.date, -1), 'a same-day arrival keeps the two-night minimum');
});

test('C28 + L03: a guide item free only on some days is offered only when the trip\'s own dates meet it, said with the date; the checked date is the guide\'s', () => {
  const gs = ['culture', 'romantic'], name = 'First-Sunday free museum day', mk = d => build('paris', d, 4, ['cdg-a1', 'cdg-a3']);
  let sun = ahead(1, 1); while (!(new Date(`${sun}T12:00:00Z`).getUTCDay() === 0 && Number(sun.slice(8, 10)) <= 7)) sun = addDays(sun, 1);
  const without = mk(ahead(2, 10)), within = mk(addDays(sun, -2));
  const item = t => X.freeThings(inv, t, gs).items.find(i => i.name === name);
  assert.deepEqual(item(without).condition, { days: 'first-sunday' }); assert.equal(item(without).onDates, false); assert.equal(X.freeThings(inv, 'paris', gs).items.find(i => i.name === name).onDates, null, 'no dates: unknown');
  assert.ok(item(within).onDates === true && item(within).freeOn === sun && item(within).when.includes(longDate(sun)) && !item(within).when.includes(sun));
  const offered = t => [...X.memoryTest(inv, t, gs, o).candidates.filter(c => c.kind === 'free').map(c => c.label), ...X.moreMemorable(inv, t, gs, { ...o, q: Q }, { zeroMore: true }).free.filter(f => f.kind === 'free-thing').map(f => f.free.name), ...[X.freeOverPaid(inv, t, gs)].filter(Boolean).map(f => f.free.name)];
  assert.ok(!offered(without).includes(name), 'never offered when no full day is a first Sunday');
  const mt = X.memoryTest(inv, within, gs, o).candidates.find(c => c.label === name); assert.ok(mt && mt.text.includes(longDate(sun)) && !mt.text.includes(sun), 'offered with its date, in words');
  const later = createTripIntegrations(loadConfig({ APP_ENV: 'development' }), { now: () => new Date('2031-05-01T12:00:00Z') });
  assert.equal(later.guides.freeThings({ destId: 'paris' }).checkedAt, GUIDE_CHECKED_AT, 'the guide\'s own date, whatever the clock says');
});

test('C29 + C30: a surprise abroad says the passport; the upgrade challenge is never said when the stay was asked for', () => {
  const sc = X.surpriseCompletely(inv, Q, o);
  assert.equal(sc.passport, !!sc.pick.trip.internationalTrip); assert.equal(/valid passport/.test(sc.text), sc.passport); assert.equal(/^Nothing new is required of you/.test(sc.text.slice(sc.reason.length + 1)), !sc.passport);
  if (sc.passport) assert.equal(X.surpriseCompletely(inv, Q, { ...o, current: sc.pick.trip }).passport, false, 'the same country as the trip it replaces');
  let argued = 0;
  for (const c of res.candidates.filter((x, i) => i % 29 === 0)) {
    const up = X.hotelOrExperience(inv, c.trip, GOALS, { ...o, cap: null }).a; if (!up || !X.challengeUpgrade(c.trip, up, GOALS, null, o).challenge) continue;
    argued++;
    for (const oo of [{ q: { ...Q, priority: 'hotel' } }, { q: { ...Q, style: 'luxury' } }, { ctx: { style: 'all-inclusive' } }, { statedStay: true }, { prefs: { stayMatters: true } }]) {
      const cu = X.challengeUpgrade(c.trip, up, GOALS, inv, { ...o, ...oo });
      assert.ok(!cu.challenge && cu.stayAsked && cu.instead === null && !/matters more than the room/.test(cu.text), JSON.stringify(oo));
    }
  }
  assert.ok(argued > 0, 'a challenge was exercised');
});

test('L02: the GOOD TRIP floor is graded on the goal facts, never skipped for the hotel\'s stars alone', () => {
  const L = ways.ladder, qctx = { style: 'surprise', priority: 'price', rules: null, budget: null, allowOver: 0 };
  assert.ok(decision.compromises(price({ ...pick.spec }), { ...qctx, priority: 'hotel' }).filter(c => /-star hotel/.test(c.text)).every(c => c.key === 'stars'));
  for (const ch of L.chains) {
    const g = ch.rungs[0];
    for (const c of L.search.candidates.filter(x => x.dest === ch.dest && x.total < g.total && x.total <= Q.budget)) assert.ok(decision.compromises(c.trip, qctx).some(x => x.w >= 2 && x.key !== 'stars'), `${encodeSpec(c.trip.spec)} skipped only with a real downside`);
  }
});

// ---- the protected experience, the ceiling and the words, as every caller (the pages and the agent) reads them ----------------
test('the protected experience is said as protected, never as one "you protected" or "asked for": the agent may have set it from the results', () => {
  const px = main.id, ctx = { ...optimizer.budgetContext(Q), protect: px, goals: GOALS, rules: null, dateMode: null }, po = { now, locks: {}, prefs: { rules: null }, protect: px };
  const said = [], xo = { ...o, protect: px, inv, goals: GOALS }, YOU = /\byou protected\b|\bwhich you protected\b|\byour link protected\b/;
  const without = price({ ...pick.spec, activities: pick.spec.activities.filter(a => a !== px) });
  const comp = decision.compromises(without, ctx).find(c => c.w === 3); assert.equal(comp.text, `without ${main.name}, the protected experience`); said.push(comp.text);
  const fc = X.finalCheck(without, GOALS, { ...xo, inv: null }); assert.ok(fc.reasons.some(r => r.text === `Without ${main.name}, the protected experience`)); said.push(fc.text);
  said.push(X.bigVsMany(inv, pick, GOALS, xo).text);
  // A crowded trip whose protected experience has no full day: its conflict fix says it stays, in neutral words.
  const crowded = price({ ...pick.spec, nights: 3, activities: pick.activityOptions.filter(a => X.goalScore(a, GOALS) > 0).map(a => a.id).sort() }), left = X.rhythm(crowded, GOALS).unplaced[0];
  assert.ok(left, 'the crowded trip leaves an experience without a day');
  const fix = X.collisions(crowded, { inv, settings, goals: GOALS, protect: left.id }).flatMap(c => c.fixes).find(f => f.protected);
  assert.equal(fix.text, `${left.name} is the protected experience: it stays unless you say to drop it`); said.push(fix.text);
  for (const w of pick.activityOptions.filter(a => !pick.spec.activities.includes(a.id))) said.push(X.trade(inv, pick, w, xo).text);
  // The money leak engine: listed and never removable, but never counted as "one you asked for".
  const lean = leaks.lean(inv, pick, settings, ctx, po); assert.ok(lean.kept.includes(`${main.name} (${leaks.PROTECTED})`)); said.push(...lean.kept);
  const only = price({ ...pick.spec, activities: [px], transfer: false, bags: false });
  const wk = leaks.whyKept(inv, only, settings, ctx, po);
  assert.deepEqual([wk.allStated, wk.items.map(i => [i.label, i.worth, i.stated, i.why])], [false, [[main.name, true, false, leaks.PROTECTED]]]);
  assert.equal(wk.text, `Every optional item in this price is one I'd keep by what you told me and the trip's facts: ${main.name} (the protected experience).`);
  const scan = leaks.finalScan(inv, only, settings, ctx, po).checks.find(c => c.key === 'addons');
  assert.equal(scan.text, `Every experience in this price is one I'd keep by what you told me and the trip's facts: ${main.name} (the protected experience).`); said.push(wk.text, scan.text);
  // Another destination is held back by the protection, in the same words.
  const q2 = { ...Q, protect: px, dest: pick.dest.id }, chosen = strategies.threeWays(inv, q2, { settings, now }).strategies[0];
  const away = strategies.pushDirection(inv, q2, chosen, 'keep', { settings, now, protect: px }).missing.find(m => m.letter === 'C');
  assert.equal(away.reason, `${chosen.trip.activities.find(a => a.id === px).name}, the protected experience, is offered in ${chosen.trip.dest.name}`); said.push(away.reason);
  for (const t of said) assert.doesNotMatch(t, YOU, t);
});

test('the maximum is a ceiling in the engine: MAKE $X MEMORABLE and BACKUP mark what is over it, never pick it while one fits, and name a bigger one with its amount as the customer\'s call', () => {
  let named = 0, overSeen = 0, alreadyOver = 0, backups = 0, swapped = 0;
  for (const c of [ways.pick, ...res.candidates.filter((x, i) => i % 97 === 0)]) {
    const t = c.trip;
    // Ceilings read off the trip itself: $40 and $90 above it (inside the $50–$150 window), and $10 under it.
    for (const cap of [t.total + 4000, t.total + 9000, t.total - 1000, null]) {
      const mt = X.memoryTest(inv, t, GOALS, { ...o, cap }, 10000);
      for (const x of mt.candidates) { const over = x.kind !== 'free' && cap !== null && x.total > cap; assert.equal(x.over, over, x.label); assert.equal(x.overBy, over ? x.total - cap : 0); overSeen += over ? 1 : 0; }
      const fits = mt.candidates.filter(x => x.gain > 0 && !x.over), best = mt.candidates.find(x => x.gain > 0) || null;
      assert.equal(mt.pick, fits[0] || null, 'the pick is the biggest difference that fits');
      assert.equal(mt.overChoice, best && best.over ? best : null, 'a bigger one over the ceiling is named, never picked');
      if (!mt.overChoice) { assert.doesNotMatch(mt.text, /going over/); continue; }
      named++; assert.ok(mt.overChoice.gain > (mt.pick ? mt.pick.gain : 0), 'named because it makes more difference');
      assert.ok(mt.text.includes(`${mt.overChoice.label} (+${fmt(mt.overChoice.delta)})`) && mt.text.includes(`${fmt(mt.overChoice.total - cap)} over your maximum; going over is your call.`), mt.text);
      if (t.total > cap) { alreadyOver++; assert.ok(mt.text.startsWith(`This trip is already ${fmt(t.total - cap)} over your ${fmt(cap)} maximum.`), mt.text); }
      if (mt.pick) assert.ok(mt.text.includes(`${mt.pick.label}, ${mt.pick.kind === 'free' ? '+$0' : `+${fmt(mt.pick.delta)}`}: `), mt.text);
    }
    // BACKUP: the fallback is the first for the goals whose version fits; a first one over the ceiling is named with its amount.
    const wx = t.activities.find(a => a.weather), b0 = wx && X.backup(inv, t, wx, { ...o, cap: null, goals: GOALS });
    if (!b0 || !b0.trip) continue;
    backups++; assert.deepEqual([b0.over, b0.overBy, b0.overChoice], [false, 0, null]);
    for (const cap of [b0.total - 1, t.total - 1]) {
      const b = X.backup(inv, t, wx, { ...o, cap, goals: GOALS });
      assert.equal(b.over, b.total > cap); assert.equal(b.overBy, Math.max(0, b.total - cap)); checkPacked(b);
      if (b.overChoice) {
        swapped++; assert.ok(!b.over && b.overChoice.over && b.overChoice.activity.id === b0.activity.id && b.activity.id !== b0.activity.id, 'the one that fits is the fallback');
        assert.ok(b.text.includes(`fallback I'd book that day within your ${fmt(cap)} maximum`) && b.text.endsWith(`${b0.activity.name} would be my first fallback for your goals, but with it the trip is ${fmt(b.overChoice.total - cap)} over your maximum; going over is your call.`), b.text);
      } else {
        assert.equal(b.activity.id, b0.activity.id); assert.ok(b.over, 'nothing fits: the first, with what it takes over');
        assert.ok(b.text.endsWith(` With it the trip is ${fmt(b.total - cap)} over your ${fmt(cap)} maximum; going over is your call.`), b.text);
      }
    }
  }
  // A first fallback for the goals that only fits over the ceiling while another fits under it: Barcelona with food ranked #1,
  // whose food walk is the first fallback for a weather-dependent day and dearer than the culture visit after it.
  const bcn0 = build('barcelona', ahead(5, 12), 5, []), wxb = bcn0 && bcn0.activityOptions.find(a => a.weather), bcn = wxb && build('barcelona', ahead(5, 12), 5, [wxb.id]), gsb = ['food', 'culture'];
  const f0 = X.backup(inv, bcn, wxb, { ...o, cap: null, goals: gsb }), f1 = X.backup(inv, bcn, wxb, { ...o, cap: f0.total - 1, goals: gsb });
  assert.ok(f1.overChoice && !f1.over && f1.overChoice.activity.id === f0.activity.id && f1.total <= f0.total - 1, f1.text); swapped++;
  assert.equal(f1.text, `Weather can't be guaranteed. If ${wxb.name} is called off, ${f1.activity.name} is the fallback I'd book that day within your ${fmt(f0.total - 1)} maximum; it is not added unless you say so. ${f0.activity.name} would be my first fallback for your goals, but with it the trip is ${fmt(1)} over your maximum; going over is your call.`);
  assert.ok(named > 0 && overSeen > 0 && alreadyOver > 0 && backups > 0 && swapped > 0, `exercised: ${named} named, ${overSeen} over, ${alreadyOver} already over, ${backups} backups, ${swapped} swapped`);
});

// The words every engine sentence carries, wherever the agent or a page prints it: no ISO date (the pages' own format, from
// the one shared formatter) and never a doubled stop from a join. The data fields keep their ISO dates.
const DATA_KEYS = new Set(['search', 'ladder', 'inv', 'trip', 'token', 'spec', 'date', 'from', 'to', 'landing', 'home', 'depart', 'checkedAt', 'freeOn', 'latestDepart', 'earliestReturn', 'landBy', 'event', 'days', 'day', 'condition', 'checkIn', 'checkOut']);
function sentencesIn(v, out = [], seen = new Set()) {
  if (typeof v === 'string') { out.push(v); return out; }
  if (!v || typeof v !== 'object' || seen.has(v)) return out;
  seen.add(v);
  if (v.spec && Array.isArray(v.lines)) return out;
  for (const [k, x] of Object.entries(v)) if (!DATA_KEYS.has(k)) sentencesIn(x, out, seen);
  return out;
}
test('engine sentences write dates as the pages do and never stop twice: every text the agent prints raw', () => {
  const gs = ['adventure', 'nature'], nl = 'kef-a3', results = [];
  const run = (label, f) => { results.push([label, f()]); };
  const bkk = build('bangkok', ahead(11, 18), 4, []), crowded = price({ ...pick.spec, nights: 3 }), april = build('reykjavik', ahead(4, 1), 4, ['kef-a1', nl]), sunday = (() => { let d = ahead(1, 1); while (!(new Date(`${d}T12:00:00Z`).getUTCDay() === 0 && Number(d.slice(8, 10)) <= 7)) d = addDays(d, 1); return build('paris', addDays(d, -2), 4, ['cdg-a1', 'cdg-a3']); })();
  assert.ok(bkk && bkk.flight.arrivesNextDay && crowded && april && sunday, 'the fixture trips price');
  const evs = t => [0, 1, 2, t.spec.nights, t.spec.nights + 3, -2].map((n, i) => ({ name: ['A dinner', 'Concert', 'A show', 'A game', 'A wedding', 'A tour'][i], date: addDays(t.spec.depart, n) }));
  for (const t of [pick, crowded, bkk, april, sunday]) {
    const m = X.mainOf(t, GOALS) || t.activities[0], po = { ...o, protect: m && m.id, inv, goals: GOALS, q: Q };
    run('finalCheck', () => X.finalCheck(t, GOALS, { ...po, event: evs(t)[1] }));
    for (const ev of evs(t)) { run('eventCollision', () => X.eventCollision(t, ev)); run('eventBuffer', () => X.eventBuffer(t, ev)); run('collisions', () => X.collisions(t, { inv, settings, goals: GOALS, event: ev, protect: m && m.id })); }
    run('eventRange', () => [X.eventRange(evs(t)[1], t.spec.nights, t.flight), X.eventRange(evs(t)[1], 2, t.flight), X.eventRange(evs(t)[1], 1)]);
    if (m) { run('protection', () => X.protection(inv, t, m, po)); run('bestDay', () => X.bestDay(t, m, { ...po, event: evs(t)[2] })); run('valueCheck', () => X.valueCheck(inv, t, m, GOALS)); run('backup', () => (t.activities.find(a => a.weather) ? X.backup(inv, t, t.activities.find(a => a.weather), { ...po, cap: t.total }) : null)); }
    run('surpriseOne', () => X.surpriseOne(inv, t, GOALS, null, po)); run('memoryTest', () => X.memoryTest(inv, t, GOALS, { ...po, cap: t.total + 4000 }));
    run('moreMemorable', () => [X.moreMemorable(inv, t, GOALS, po), X.moreMemorable(inv, t, GOALS, po, { zeroMore: true })]);
    run('freeThings', () => [X.freeThings(inv, t, ['culture', 'romantic', 'beach']), X.freeOverPaid(inv, t, GOALS)]);
    for (const w of t.activityOptions.filter(a => !t.spec.activities.includes(a.id)).slice(0, 3)) run('alternative', () => [X.alternative(inv, t, GOALS, w, { ...po, cap: t.total }), X.trade(inv, t, w, po)]);
    run('rest', () => [X.sameFeeling(inv, Q, GOALS, t, po), X.downsell(inv, t, GOALS, po), X.hotelOrExperience(inv, t, GOALS, po), X.locationCheck(inv, t, ['beach'], po), X.fatigue(t, GOALS, po), X.bigVsMany(inv, t, GOALS, po), X.packTrip(inv, t, GOALS, po), X.receipt(inv, Q, t, GOALS, po), X.allocation(t, Q.budget, { inv, o: po }), X.rhythm(t, GOALS)]);
  }
  run('results', () => [X.experienceWays(inv, Q, GOALS, o), X.oneBigThing(inv, Q, GOALS, o), X.destinationMatch(inv, Q, GOALS, o), X.surpriseCompletely(inv, Q, o), X.oneBigThing(inv, { ...Q, dest: 'reykjavik' }, gs, o)]);
  let n = 0;
  for (const [label, r] of results) for (const t of sentencesIn(r)) {
    n++;
    assert.doesNotMatch(t, /\b\d{4}-\d{2}-\d{2}\b/, `${label}: a date in words, never ISO: ${t}`);
    assert.doesNotMatch(t, /[^.]\.\.(?!\.)|\.\s*;|\.\s+\.(?!\.)/, `${label}: one stop: ${t}`);
  }
  assert.ok(n > 500, `sentences read (${n})`);
  // The words are the pages' own, and the data keeps its ISO dates.
  const ev = { name: 'Concert', date: addDays(pick.spec.depart, pick.spec.nights + 3) }, hit = X.eventCollision(pick, ev);
  assert.equal(hit.text, `SCHEDULE CONFLICT: Concert on ${longDate(ev.date)} falls after you fly home; the dates ${longDate(pick.spec.depart)} – ${longDate(hit.landing.home)} don't cover it with a day's buffer.`);
  assert.equal(hit.landing.home, addDays(pick.spec.depart, pick.spec.nights));
  // Availability is said for the day the rhythm gives the main experience, never the arrival day the trip leaves on.
  const pr = X.protection(inv, pick, main, o), prDay = X.rhythm(pick, [], { main }).placed.find(p => p.activity.id === main.id).day; assert.equal(pr.checkedAt, today(now));
  assert.ok(pr.text.includes(`re-checked on ${longDate(today(now))}`) && pr.rows[0].value.includes(longDate(prDay.date)) && !pr.rows[0].value.includes(longDate(pick.spec.depart)), pr.rows[0].value);
  const rg = X.eventRange({ name: 'Concert', date: addDays(pick.spec.depart, 3) }, pick.spec.nights); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(rg.from) && rg.text.startsWith(`Leave between ${longDate(rg.from)} and ${longDate(rg.to)} `));
  const fc = X.finalCheck(crowded, GOALS, { ...o, inv }); if (!fc.ok) assert.ok(fc.text.startsWith(`FINAL EXPERIENCE CHECK: ${fc.reasons.filter(r => !r.ok).map(r => r.text.replace(/[\s.;:,]+$/, '')).join('; ')}.`), fc.text);
});

test('an event after the trip falls "after you fly home", never the ambiguous "after you leave"; each side of the trip is said for what it is', () => {
  const s = pick.spec, home = addDays(s.depart, s.nights), L = X.landing(pick);
  const where = d => (X.eventCollision(pick, { name: 'Concert', date: d }) || { text: null }).text;
  assert.match(where(addDays(home, 2)), /falls after you fly home;/); assert.doesNotMatch(where(addDays(home, 2)), /after you leave/);
  assert.match(where(home), /falls on your departure day;/); assert.match(where(L.date), /falls on your arrival day/);
  assert.match(where(addDays(L.date, -3)), /falls before you arrive;/); assert.equal(where(addDays(L.date, 1)), null, 'inside the trip: no conflict');
});

// A locked event (BUILD AROUND AN EVENT) takes its day. The second screenshot pass caught the 7h main experience put on the
// concert day itself ("Isla Mujeres catamaran day on day 2", the concert day) with no conflict and "✓ No schedule conflict"
// in the final check. Read off the inventory's own trips, every full day as the event's day and every time the agent can
// parse (unknown, evening, morning): the EVENT DAY is never open and holds no experience unless the event's time is known
// and the two cannot overlap (a short one at the other end of the day); an experience the event pushes off its only day is
// a SCHEDULE CONFLICT naming the event, and the final check never passes such a trip.
test('A: the event day is taken: never an open day, no experience on it unless the time is known and they cannot overlap; one pushed off it is a conflict and the final check fails', () => {
  const gs = GOALS, goalsIn = t => t.activityOptions.filter(a => X.goalScore(a, gs) > 0 && a.hours >= X.BIG).sort((a, b) => b.hours - a.hours);
  const tight = (() => { const big = goalsIn(pick).slice(0, 2).map(a => a.id); return big.length === 2 ? price({ ...pick.spec, nights: 3, activities: big.sort() }) : null; })();
  const trips = [pick, tight, build('honolulu', ahead(11, 9), 3, ['hnl-a1']), build('paris', ahead(10, 20), 3, ['cdg-a2']), build('bali', ahead(11, 9), 4, ['dps-a1'])].filter(Boolean);
  assert.ok(trips.length >= 4 && tight && tight.activities.length === 2, 'the fixture trips price');
  let shared = 0, pushed = 0, checked = 0;
  for (const t of trips) for (const day of X.rhythm(t, gs).days.filter(d => d.full)) for (const slot of [null, 'evening', 'morning']) {
    const event = { name: 'your concert', date: day.date, slot }, rh = X.rhythm(t, gs, { event }), ed = rh.days.find(d => d.date === day.date);
    assert.equal(ed.label, 'Event day'); assert.equal(ed.open, false, 'an event day is never an open day');
    assert.ok(ed.items.includes(`Your concert${slot ? ` (${slot})` : ''}`), 'the event is named on its day');
    for (const p of rh.placed.filter(x => x.day === ed)) {
      shared++;
      assert.ok(slot && p.activity.hours < X.BIG && ((slot === 'evening' && p.activity.slot === 'morning') || (slot === 'morning' && ['evening', 'night'].includes(p.activity.slot))), `${p.activity.name} (${p.activity.hours}h, ${p.activity.slot}) shares the ${slot || 'unknown-time'} event's day only when they cannot overlap`);
    }
    assert.equal(rh.placed.length + rh.unplaced.length, t.activities.length);
    const col = X.collisions(t, { goals: gs, event, inv, settings }), fc = X.finalCheck(t, gs, { ...o, event });
    for (const a of rh.unplaced) {
      pushed++;
      assert.ok(col.some(c => c.activity === a || (c.activities || []).includes(a)), `${a.name} without a day is a conflict`);
      assert.equal(fc.ok, false, `the final check never passes ${encodeSpec(t.spec)} with ${a.name} pushed off ${longDate(day.date)}`);
    }
    if (!rh.unplaced.length && X.rhythm(t, gs).placed.length === t.activities.length) {
      checked++;
      assert.ok(fc.reasons.some(r => r.ok && r.text.startsWith(`Your concert on ${longDate(day.date)}`)), 'the final check says the event has its day');
      if (fc.ok) assert.ok(!rh.placed.some(p => p.day === ed && !(slot && p.activity.hours < X.BIG)), 'a pass never double-books the event day');
    }
  }
  assert.ok(shared > 0 && pushed > 0 && checked > 0, `every branch is read (shared ${shared}, pushed ${pushed}, checked ${checked})`);
  // The screenshot's case: the main experience's own day becomes the event's, and the main experience moves to another full day.
  const blind = X.rhythm(pick, gs), mDay = blind.placed.find(p => p.activity === blind.main).day, ev = { name: 'your concert', date: mDay.date, slot: null };
  const moved = X.rhythm(pick, gs, { event: ev }), at = moved.placed.find(p => p.activity.id === blind.main.id);
  if (at) assert.ok(at.day.date !== ev.date && at.day.full, 'the main experience moves off the concert day');
  // Two big experiences, two full days, the concert on one: the one it pushes off is named against the event.
  const tf = X.rhythm(tight, gs).days.filter(d => d.full), tev = { name: 'your concert', date: tf[0].date, slot: null }, tc = X.collisions(tight, { goals: gs, event: tev, inv, settings });
  const evc = tc.find(c => c.kind === 'event-day');
  assert.ok(evc && evc.text.includes(`${longDate(tev.date)} is the day of your concert`) && /its time is not known/.test(evc.text), evc && evc.text);
  const tfc = X.finalCheck(tight, gs, { ...o, event: tev });
  assert.ok(!tfc.ok && tfc.reasons.some(r => !r.ok && r.text === evc.text) && tfc.text.includes('the day of your concert'), tfc.text);
});

// B: availability is checked and said for the day the rhythm gives the experience, the same day the rhythm (and its event)
// gives it, never the arrival day the trip leaves on; the best-day reasons say the same day.
test('B: PROTECTION and the best day say availability for the day the rhythm gives the experience, the event read too', () => {
  for (const t of [pick, build('honolulu', ahead(11, 9), 3, ['hnl-a1'])].filter(Boolean)) {
    const m = X.mainOf(t, GOALS) || t.activities[0], full = X.rhythm(t, GOALS, { main: m }).days.filter(d => d.full);
    for (const event of [null, { name: 'your concert', date: full[0].date, slot: null }]) {
      const ox = { ...o, goals: GOALS, event }, day = X.rhythm(t, GOALS, { main: m, event }).placed.find(p => p.activity.id === m.id);
      const av = X.protection(inv, t, m, ox).rows.find(r => r.key === 'availability'), bd = X.bestDay(t, m, { ...ox, inv });
      assert.ok(day, `${m.name} has a day`);
      assert.ok(av.value.includes(`for ${longDate(day.day.date)}`) && !av.value.includes(longDate(t.spec.depart)), av.value);
      assert.equal(av.date, day.day.date);
      assert.ok(bd.reasons.some(r => r.text === `Available on the demo partner for ${longDate(day.day.date)}`) && bd.reasons.some(r => r.text.startsWith(`Not your arrival day (${longDate(t.spec.depart)})`)), JSON.stringify(bd.reasons));
      if (event) assert.notEqual(day.day.date, event.date, 'never the event\'s day');
    }
  }
});

// D: the final check's rebuild says what it gives up in plain words: "gives up nothing else" after what it keeps, never "nothing
// is given up by the facts".
test('D: a rebuild that drops nothing and trades nothing off says it gives up nothing, in plain words', () => {
  let seen = 0;
  for (const n of [3, 6, 10]) {
    const event = { name: 'your concert', date: addDays(pick.spec.depart, pick.spec.nights + n), slot: null }, fc = X.finalCheck(pick, GOALS, { ...o, inv, goals: GOALS, event, q: Q });
    if (!fc.rebuild) continue;
    seen++;
    assert.doesNotMatch(fc.rebuild.text, /by the facts/);
    if (!fc.rebuild.removed.length && !fc.rebuild.givesUp.length) assert.match(fc.rebuild.text, /(?:and gives up nothing else|; it gives up nothing(?: else)?); a proposal, nothing applied\.$/, fc.rebuild.text);
  }
  assert.ok(seen, 'a rebuild that moves the dates onto the event is priced');
});

// F: one labelling rule for the ladder and MAKE IT MORE MEMORABLE: "major" only for an experience of BIG hours or more, and
// the ordinal counts what the label names in the version the step lands on ("Second major experience" = two of BIG hours or
// more; "Third experience" = three in all). The first pass showed "+ Third major experience" for a trip with two major ones.
test('F: rung labels follow one rule on the ladder and in MAKE IT MORE MEMORABLE, read off the version each step lands on', () => {
  const ORD = { Second: 2, Third: 3, Fourth: 4, Fifth: 5 };
  let n = 0;
  const check = (where, rungs) => rungs.forEach(r => {
    const m = r.label.match(/^\+ (?:(Major) experience|(\w+) (major )?experience)$/); if (!m || m[2] === 'Main' || m[2] === 'Food') return;
    n++;
    const big = r.trip.activities.filter(a => a.hours >= X.BIG).length;
    if (m[1]) assert.equal(big, 1, `${where}: "${r.label}" is the first experience of ${X.BIG}h or more`);
    else if (m[3]) assert.equal(ORD[m[2]], big, `${where}: "${r.label}" counts the experiences of ${X.BIG}h or more (${big})`);
    else assert.equal(ORD[m[2]], r.trip.activities.length, `${where}: "${r.label}" counts every experience (${r.trip.activities.length})`);
  });
  for (const t of [pick, price({ ...pick.spec, activities: [] }), price({ ...pick.spec, activities: pick.activityOptions.filter(a => X.goalScore(a, GOALS) > 0 && a.hours < X.BIG).slice(0, 1).map(a => a.id) })].filter(Boolean)) {
    const ox = { ...o, q: { ...Q, dest: t.spec.dest } };
    check('ladder', X.ladder(inv, ox.q, GOALS, { ...ox, trip: t }).rungs.slice(1)); check('more', X.moreMemorable(inv, t, GOALS, ox).paid);
  }
  assert.ok(n > 0, 'an experience step is labelled');
});

// G (engine side): a locked hotel or flights hold in every engine a page reads: LOCATION prices no other hotel, SAME FEELING
// FOR LESS prices no other destination, and the receipt's baseline says the lock it crosses (a reference, never an offer).
test('G: hotel and flight locks hold in LOCATION, SAME FEELING FOR LESS and the receipt\'s baseline', () => {
  const t = pick, ox = { ...o, goals: GOALS, q: Q };
  for (const locks of [{ hotel: true }, { flight: true }, { hotel: true, flight: true }]) {
    const lo = { ...ox, locks }, loc = X.locationCheck(inv, t, ['beach'], lo), sf = X.sameFeeling(inv, Q, GOALS, t, lo), rc = X.receipt(inv, Q, t, GOALS, lo);
    if (locks.hotel) assert.ok(!loc.a && !loc.b && !loc.verdict && /^The hotel is locked/.test(loc.unknown), loc.text);
    assert.ok(!sf.trip && /you locked, so I don't price one/.test(sf.text), sf.text);
    const moves = rc.baseline.trip.spec.hotel !== t.spec.hotel && locks.hotel;
    assert.equal(rc.baseline.crosses.includes('the hotel'), !!moves);
    for (const r of [loc, sf]) for (const v of tripsIn(r)) assert.ok((!locks.hotel || v.spec.hotel === t.spec.hotel) && (!locks.flight || v.spec.flight === t.spec.flight), 'no version moves a lock');
  }
  const open = X.locationCheck(inv, t, ['beach'], ox);
  assert.ok(open.a || open.b, 'without the lock, LOCATION compares hotels');
});
