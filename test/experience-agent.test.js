// EXPERIENCE MAX in conversation: the entry modes, WHAT DO YOU WANT TO REMEMBER? before anything is
// built, the three results with the recommendation the engine's facts make, the protected experience
// (never dropped on a plain approval, dropped by "drop <it>"), every chip answering with the engine's
// numbers, the event lock, $0 more, the trade, the final check before the contract and WHAT WAS
// ACTUALLY WORTH IT? kept on the account only on the traveler's yes. Every total the agent puts on the
// table is asserted against priceTrip of its token through the service, never against a typed figure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { decodeSpec, encodeSpec } = require('../server/trips/spec');
const X = require('../server/trips/experience');
const optimizer = require('../server/trips/optimizer');
const { understand } = require('../server/agent/understand');
const state = require('../server/agent/state');
const { bookingHome } = require('../server/agent/home');
const { agentView } = require('../server/views/trips/agent');
const { money } = require('../server/views/trips/common');
const { addDays, today } = require('../server/lib/dates');
const { longDate } = require('../server/trips/words');

// The pressure regex the pages tests use, widened with the engine contract's own list.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict)\b/i;
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const ask = (agent, id, user = null) => async t => { await agent.say(id, t, { user }); await agent.jobs.drain(); return agent.load(id); };
const agentTexts = (s, from = 0) => s.messages.slice(from).filter(m => m.role === 'agent').map(m => m.text);
const lastCard = (s, kind, from = 0) => { const m = s.messages.slice(from).filter(x => x.card && x.card.kind === kind).pop(); return m ? m.card : null; };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const spoken = iso => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const maps = createTripIntegrations(loadConfig({ APP_ENV: 'development' })).maps;

// An Experience Max conversation up to the results: the number, the goals, then where from.
async function built(app, visitor, { budget = '$2,000', goals = 'beach and food', from = 'two of us from NYC', userId = null } = {}) {
  const agent = app.agent;
  const s0 = await agent.create({ visitor, userId, mission: true, mode: 'experience' });
  const say = ask(agent, s0.id);
  await say(budget); await say(goals);
  const s = await say(from);
  return { id: s0.id, say, s };
}
const pricer = svc => async token => { const p = await svc.price(decodeSpec(token)); return p ? p.total : null; };

test('understanding: the goal chips are the goals, in order and at most three; the chips are Experience Max\'s only in that mode; an event is its name, date and slot', () => {
  const st = { pending: 'goals', mission: { mode: 'experience' } };
  for (const g of X.GOALS) assert.deepEqual(understand(g.label, st, { maps }).updates.goals, [g.key], g.label);
  assert.deepEqual(understand('food first, then the beach', st, { maps }).updates.goals, ['food', 'beach']);
  assert.deepEqual(understand('beach, food, nightlife and culture', st, { maps }).updates.goals.length, 3, 'at most three');
  assert.deepEqual(understand('I don\'t know', st, { maps }).updates.goals, ['surprise']);
  const xs = { 'Hotel or experience?': 'xHotelOrExp', 'Make $100 memorable': 'xMemorable', 'Give me one amazing thing': 'xOneBig', 'Pack the trip': 'xPack', 'Find free things worth doing': 'xFree', 'Surprise me with one thing': 'xSurpriseOne', 'Give me more free time': 'xFreeTime', 'Same feeling for less': 'xSameFeeling', 'Find an alternative experience': 'xAlternative', 'Experience ladder': 'xLadder', 'Trade something for this': 'xTrade', 'One big memory or more things to do?': 'xBigVsMany', 'Plan my days': 'xRhythm', 'Your experience budget': 'xBudget', 'What if it rains?': 'xBackup', 'Surprise me completely': 'xSurpriseAll', 'Make it more memorable': 'xMore', 'Make it better for $0 more': 'xZero', 'Why this trip is built this way': 'xReceipt' };
  for (const [t, k] of Object.entries(xs)) {
    assert.deepEqual(understand(t, { mission: { mode: 'experience' }, goals: ['beach'] }, { maps }).intents, [k], t);
    assert.ok(!understand(t, { mission: { mode: null } }, { maps }).intents.some(i => /^x[A-Z]/.test(i)), `${t} is not an Experience Max chip outside the mode`);
  }
  assert.equal(understand('Make $250 memorable', { mission: { mode: 'experience' } }, { maps }).updates.memAmount, 25000);
  const ev = understand('I already have concert tickets on December 12, in the evening', { mission: { mode: 'experience' } }, { maps });
  assert.deepEqual(ev.intents, ['xEvent']);
  assert.equal(ev.updates.event.name, 'your concert'); assert.equal(ev.updates.event.slot, 'evening'); assert.match(ev.updates.event.date, /^\d{4}-12-12$/);
  assert.equal(understand('Keep $500 for spending', { mission: { mode: 'experience' } }, { maps }).updates.memAmount, undefined, 'a reserve is never a memory amount');
});

test('the entry modes: Experience Max accepts the number as a ceiling for memories and asks the goals before anything is built; easy mode says what it sets; any other mode is the plain mission', async t => {
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent;
  // EXPERIENCE: the acceptance line, then WHAT DO YOU WANT TO REMEMBER? with one chip per goal; no job.
  const x = await agent.create({ visitor: 'v-xagent-entry-001', mission: true, mode: 'experience' });
  assert.equal(x.mission.mode, 'experience');
  let s = await ask(agent, x.id)('$2,000');
  const said = agentTexts(s);
  assert.equal(said[0], 'Mission accepted: $2,000 is the ceiling, and I\'ll spend it on the memories, not the labels: hotel stars, brands and upgrades only when they matter to what you want to remember.');
  assert.equal(s.pending, 'goals');
  assert.ok(said[said.length - 1].startsWith('WHAT DO YOU WANT TO REMEMBER?'));
  const chips = lastCard(s, 'ask');
  assert.ok(chips.chips, 'the goals are chips');
  assert.deepEqual(chips.options.map(o => o.label), X.GOALS.map(g => g.label));
  assert.ok(!s.job && !s.current, 'nothing is built before the goals');
  // EASY: nonstop if possible, the transfer in the price, the flight-time check before paying; said.
  const e = await agent.create({ visitor: 'v-xagent-entry-002', mission: true, mode: 'easy' });
  s = await ask(agent, e.id)('$2,000');
  assert.ok(agentTexts(s)[0].startsWith('Mission accepted: $2,000 is the ceiling, not a target, and I\'ll make the trip easy: nonstop flights if possible, an airport transfer in the price'));
  assert.equal(s.flightStops, 'nonstop'); assert.equal(s.flightRule, 'soft'); assert.equal(s.transfer, true); assert.equal(s.priority, 'flights');
  assert.equal(s.pending, 'origin', 'no goals question outside Experience Max');
  const e2 = await agent.create({ visitor: 'v-xagent-entry-003', mission: true, mode: 'easy' });
  s = await ask(agent, e2.id)('$2,000, no transfer');
  assert.equal(s.transfer, false, '"no transfer" is kept');
  assert.ok(!agentTexts(s)[0].includes('an airport transfer in the price'));
  // Anything else is the mission as it is.
  assert.equal((await agent.create({ visitor: 'v-xagent-entry-004', mission: true, mode: 'bogus' })).mission.mode, null);
  for (const line of [...agentTexts(await agent.load(x.id)), ...agentTexts(s)]) assert.doesNotMatch(line, PRESSURE, line);
});

test('the goals question before the build, then EXPERIENCE MAX RESULTS: the recommendation the engine\'s facts make, every total priceTrip\'s, the main experience protected and said; the page renders it', async t => {
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService, priced = pricer(svc);
  const s0 = await agent.create({ visitor: 'v-xagent-res-0001', mission: true, mode: 'experience' });
  const say = ask(agent, s0.id);
  await say('$2,000');
  let s = await say('beach and food');
  assert.deepEqual(s.goals, ['beach', 'food']);
  assert.ok(agentTexts(s).includes('What you want to remember: Amazing beach (#1), Incredible food (#2).'));
  assert.equal(s.pending, 'origin'); assert.ok(!s.current, 'one question at a time: where from, still nothing built');
  s = await say('two of us from NYC');
  const card = lastCard(s, 'xways');
  assert.ok(card, 'the results card');
  // The same engine call with the same query: the same pick, the same reason, the same signature.
  const x = agent.xctx(s, await agent.settings());
  const W = X.experienceWays(svc.inv, x.q, x.gs, x.o);
  assert.ok(W.pick);
  const pick = card.ways.find(w => w.star);
  assert.equal(pick.key, 'pick'); assert.equal(pick.trip.token, W.pick.token);
  assert.equal(card.reason, W.reason); assert.equal(card.signature, W.signature);
  assert.ok(card.ways.every(w => ['memories', 'pick', 'comfort'].includes(w.key)));
  assert.deepEqual(card.ways.map(w => w.key), ['memories', 'pick', 'comfort'].filter(k => card.ways.some(w => w.key === k)), 'in their order');
  for (const w of card.ways) {
    assert.equal(w.total, await priced(w.trip.token), `${w.label} = priceTrip of its token`);
    assert.equal(w.keep, 200000 - w.total, `${w.label}: keep = max minus total`);
  }
  // The pick is on the canvas, under the ceiling; the results protected its main experience, said aloud.
  assert.equal(s.current.token, W.pick.token); assert.ok(s.current.total <= 200000);
  assert.equal(s.mainExperience, W.pick.main.id); assert.equal(s.locks.experience, true); assert.equal(s.protectAuto, true);
  const res = agentTexts(s).pop();
  // The results set this protection, not the customer: it is said as the agent's (never "you protected").
  assert.ok(res.includes(`MAIN EXPERIENCE: ${W.pick.main.name}, PROTECTED: it is the main experience I'm protecting for you, so no version I offer drops it unless you say "drop ${W.pick.main.name}"; say "unprotect" to free it.`), res);
  assert.doesNotMatch(res, /you protected/);
  assert.ok(res.endsWith('Which feels more like you?'));
  if (W.pick.total < 200000) assert.ok(res.startsWith(W.signature), 'the signature line when the pick is under the number');
  // The page: the results card, the protected line on the mission panel, Experience Max's chips.
  const page = await fetch(`${app.base}/agent/${s0.id}`, { headers: { cookie: 'txv=v-xagent-res-0001' } });
  assert.equal(page.status, 200);
  const p = text(await page.text());
  assert.ok(p.includes('Experience Max results') && p.includes('OUR PICK ★'));
  // The name set off from its sentence, the words to say quoted one way (E).
  assert.ok(p.replace(/ :/g, ':').includes(`MAIN EXPERIENCE 🔒 PROTECTED ${W.pick.main.name}: I protected it from the results; no version I offer drops it unless you say “drop ${W.pick.main.name}”; say “unprotect” to free it.`), p);
  assert.ok(p.includes('What you want to remember Amazing beach (#1), Incredible food (#2)'));
  for (const chip of ['Hotel or experience?', 'Make $100 memorable', 'Plan my days', 'What if it rains?']) assert.ok(p.includes(chip), chip);
  assert.ok(!/Locked: [^.]*Main experience/.test(p), 'the protection is its own line, not a lock');
  assert.doesNotMatch(p.slice(p.indexOf('Experience Max results'), p.indexOf('Tell your travel agent')), PRESSURE);
  // A result picked by name goes through the same proposal path, and the protection follows it.
  const other = card.ways.find(w => !w.star);
  if (other) {
    s = await say(other.key === 'comfort' ? 'More comfort' : 'More memories');
    assert.equal(s.current.token, other.trip.token);
    assert.equal(s.current.total, await priced(other.trip.token));
  }
});

test('the protected experience is never removed by a plain approval; "drop <it>" removes it and frees it, said', async t => {
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService, priced = pricer(svc);
  const { id, say, s: s1 } = await built(app, 'v-xagent-prot-001');
  const px = s1.mainExperience, name = s1.mainName, before = s1.current.token;
  assert.ok(px && name);
  // GIVE ME ONE AMAZING THING is a different trip without it: offered, said, and held at "take it".
  let s = await say('Give me one amazing thing');
  const p = s.proposal;
  assert.equal(p.kind, 'onebig'); assert.equal(p.total, await priced(p.token));
  assert.ok(!decodeSpec(p.token).activities.includes(px));
  assert.ok(agentTexts(s).pop().includes(`taking it needs "drop ${name}"`));
  for (const yes of ['Take it', 'Yes']) {
    s = await say(yes);
    assert.equal(s.current.token, before, `"${yes}" never drops the protected experience`);
    assert.equal(agentTexts(s).pop(), `That version removes ${name}, the main experience I'm protecting for you (say "unprotect" to free it); say "drop ${name}" if you want that.`);
    assert.ok(s.proposal && s.proposal.removesProtected, 'the version stays on the table');
    assert.equal(s.locks.experience, true);
  }
  // Dropping something else keeps the protection; dropping it takes the held version and frees it.
  s = await say(`Drop ${name}`);
  assert.equal(s.current.token, p.token); assert.equal(s.current.total, await priced(p.token));
  assert.ok(!decodeSpec(s.current.token).activities.includes(px));
  assert.equal(s.locks.experience, false); assert.equal(s.mainExperience, null);
  assert.ok(agentTexts(s).pop().includes(`${name} is no longer protected: you said to drop it.`));
  // On a fresh conversation: "drop <it>" with nothing held prices the trip without it as a proposal.
  const b = await built(app, 'v-xagent-prot-002');
  const other = decodeSpec(b.s.current.token).activities.find(a => a !== b.s.mainExperience);
  s = await b.say(`Protect ${b.s.mainName}`);
  assert.equal(s.protectAuto, false); assert.ok(agentTexts(s).pop().startsWith(`MAIN EXPERIENCE: ${b.s.mainName}, PROTECTED.`));
  if (other) {
    const t1 = await svc.price(decodeSpec(b.s.current.token));
    const oa = t1.activities.find(a => a.id === other);
    s = await b.say(`Drop ${oa.name}`);
    assert.equal(s.proposal.kind, 'drop'); assert.equal(s.proposal.total, await priced(s.proposal.token));
    assert.equal(s.current.token, b.s.current.token, 'a proposal, nothing applied');
    s = await b.say('Take it');
    assert.equal(s.mainExperience, b.s.mainExperience, 'dropping another experience keeps the protection');
  }
  s = await b.say(`Drop ${b.s.mainName}`);
  assert.equal(s.proposal.kind, 'drop'); assert.equal(s.proposal.dropProtected, true);
  assert.ok(agentTexts(s).pop().includes(`${b.s.mainName} is the experience you protected, and taking this version frees it`));
  s = await b.say('Unprotect');
  assert.equal(s.locks.experience, false);
  assert.ok(agentTexts(s).pop().startsWith(`Unprotected: ${b.s.mainName} is now like any other experience in the trip.`));
  for (const line of agentTexts(await agent.load(id))) assert.doesNotMatch(line, PRESSURE, line);
});

test('every chip answers with the engine\'s numbers: each total on the table is priceTrip of its token, nothing is applied, and the page renders every card', async t => {
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService, priced = pricer(svc);
  const V = 'v-xagent-chips-01';
  const { id, say, s: s0 } = await built(app, V);
  const start = s0.current.token, total0 = s0.current.total;
  const check = async (s, chip) => {
    const nums = [];
    if (s.proposal && s.proposal.token && s.proposal.total !== null) nums.push([s.proposal.token, s.proposal.total, 'proposal']);
    for (const c of Object.values((s.proposal && s.proposal.choices) || {})) if (c) nums.push([c.token, c.total, `choice ${c.key}`]);
    for (const m of s.xmenu || []) nums.push([m.token, m.total, `option ${m.letter}`]);
    if (s.proposal && s.proposal.alternative) nums.push([s.proposal.alternative.token, s.proposal.alternative.total, 'the upgrade']);
    for (const [token, total, what] of nums) assert.equal(total, await priced(token), `${chip}: ${what} = priceTrip of its token`);
    if (s.proposal && s.proposal.total !== null && s.proposal.delta !== null && s.proposal.delta !== undefined) assert.equal(s.proposal.delta, s.proposal.total - total0, `${chip}: the difference is two priced totals`);
    return nums.length;
  };
  let n = 0, priced0 = 0;
  const CHIPS = ['Hotel or experience?', 'Make $100 memorable', 'Give me one amazing thing', 'Pack the trip', 'Find free things worth doing', 'Surprise me with one thing', 'Give me more free time', 'Same feeling for less', 'Find an alternative experience', 'Experience ladder', 'Trade something for this', 'One big memory or more things to do?', 'Plan my days', 'Any conflicts?', 'Your experience budget', 'Location check', 'What if it rains?', 'Experience protection', 'Why this destination?', 'Better hotel', 'Make it more memorable', 'Why this trip is built this way'];
  for (const chip of CHIPS) {
    const from = (await agent.load(id)).messages.length;
    const s = await say(chip);
    const lines = agentTexts(s, from);
    assert.ok(lines.length >= 1, `${chip}: an answer`);
    for (const l of lines) assert.doesNotMatch(l, PRESSURE, `${chip}: ${l}`);
    for (const l of lines) assert.doesNotMatch(l, /\b\d{4}-\d\d-\d\d\b/, `${chip}: every date in words, never ISO: ${l}`);
    assert.equal(s.current.token, start, `${chip}: nothing applied by itself`);
    priced0 += await check(s, chip);
    // The cards' own numbers: the budget is the trip's lines, the receipt ends at the trip's total.
    const al = lastCard(s, 'allocation', from);
    if (al) { assert.equal(al.total, total0); assert.equal(al.lines.reduce((a, l) => a + l.amount, 0), total0); assert.equal(al.keep, 200000 - total0); }
    const rc = lastCard(s, 'xreceipt', from);
    if (rc) { assert.equal(rc.final, total0); assert.equal(rc.max, 200000); assert.equal(rc.keep, 200000 - total0); }
    const mem = lastCard(s, 'memory', from);
    if (mem) for (const it of mem.items) assert.equal(it.total, await priced(s.xmenu.find(m => m.letter === it.letter).token));
    const ab = lastCard(s, 'ab', from);
    if (ab) for (const side of [ab.a, ab.b].filter(Boolean)) { assert.equal(side.total, await priced(side.token)); assert.equal(side.delta, side.total - total0); }
    if (s.proposal || s.pending === 'options') await say('Keep what I have');
    n += 1;
  }
  assert.equal(n, CHIPS.length);
  assert.ok(priced0 >= 8, `the chips put priced versions on the table (${priced0})`);
  // MAKE $X MEMORABLE takes the amount; a letter takes that version through the same gates.
  let s = await say('Make $250 memorable');
  assert.ok(agentTexts(s).pop().startsWith('MAKE $250 MEMORABLE'));
  if ((s.xmenu || []).length) {
    const a = s.xmenu[0];
    s = await say('Option A');
    if (!s.proposal) { assert.equal(s.current.token, a.token); assert.equal(s.current.total, await priced(a.token)); }
    else await say('Keep what I have');
  }
  // The words on the cards' buttons take only what they name: a downsell amount is never a budget, the
  // better location and the upgrade go through the ceiling gate, and "keep" with nothing waiting says so.
  const b0 = state.bookingBudget(await agent.load(id));
  s = await say('Move $300 to the experience');
  assert.equal(state.bookingBudget(s), b0, 'the amount to move is never the budget');
  s = await say('Keep what I have');
  assert.ok(agentTexts(s).pop().startsWith('Nothing was waiting for your word'));
  s = await say('Location check');
  const loc = s.proposal;
  if (loc && loc.kind === 'location') {
    const cur = s.current.token;
    s = await say('Use the better location');
    if (loc.over) { assert.equal(s.current.token, cur, 'over the ceiling: it waits for "go over"'); assert.ok(agentTexts(s).pop().includes('Say "go over" to take it anyway')); await say('Keep what I have'); }
    else { assert.equal(s.current.token, loc.token); assert.equal(s.current.total, await priced(loc.token)); }
  }
  s = await say('Better hotel');
  const up = s.proposal;
  if (up && (up.kind === 'upgrade' || up.alternative)) {
    const target = up.alternative || up;
    s = await say('Take the upgrade');
    if (target.over) assert.equal(s.proposal.token, target.token, 'the upgrade, held at the ceiling, never a new search');
    else assert.equal(s.current.token, target.token);
  }
  // Every card rendered on the page, without pressure.
  const page = await fetch(`${app.base}/agent/${id}`, { headers: { cookie: `txv=${V}` } });
  assert.equal(page.status, 200);
  const body = text(await page.text());
  for (const k of ['Hotel or experience?', 'Make $100 memorable', 'The rhythm', 'Your experience budget', 'Why this trip is built this way', 'Experience ladder']) assert.ok(body.toLowerCase().includes(k.toLowerCase()), k);
  assert.doesNotMatch(body.slice(body.indexOf('Experience Max results'), body.indexOf('Tell your travel agent')), PRESSURE);
  assert.doesNotMatch(body.slice(body.indexOf('Experience Max results'), body.indexOf('Tell your travel agent')), /\b\d{4}-\d\d-\d\d\b/, 'the cards say dates in words');
});

test('the event lock: the dates move to cover it with a day\'s buffer either side, said and priced; once taken the dates are locked around it and never moved', async t => {
  const app = await startApp();
  t.after(app.close);
  const svc = app.ctx.tripService, priced = pricer(svc);
  const { say, s: s0 } = await built(app, 'v-xagent-event-01');
  const trip = await svc.price(decodeSpec(s0.current.token));
  const date = addDays(trip.flight.return, 14);
  let s = await say(`I already have concert tickets on ${spoken(date)}`);
  const p = s.proposal;
  assert.equal(p.kind, 'event'); assert.equal(p.eventLock, true);
  assert.equal(p.total, await priced(p.token)); assert.equal(p.delta, p.total - s0.current.total);
  const v = await svc.price(decodeSpec(p.token));
  assert.ok(v.spec.depart <= addDays(date, -1), 'arrives a day before at the latest');
  assert.ok(v.flight.return >= addDays(date, 1), 'flies home a day after at the earliest');
  assert.equal(v.spec.nights, trip.spec.nights, 'the same trip on other dates');
  const said = agentTexts(s).pop();
  assert.ok(said.includes(`your concert on ${longDate(date)} falls after you fly home`) && said.includes('a day\'s buffer'), said);
  assert.equal(s.current.token, s0.current.token, 'a proposal, nothing moved yet');
  s = await say('Take it');
  assert.equal(s.current.token, p.token);
  assert.equal(s.locks.dates, true); assert.equal(s.dateMode, 'exact'); assert.equal(s.depart, v.spec.depart);
  // The agent's own words carry dates as the pages and the engine write them (trips/words), never ISO.
  assert.ok(agentTexts(s).some(l => l.startsWith(`Dates locked around your concert on ${longDate(date)}`) && l.includes('a day\'s buffer either side')));
  for (const l of agentTexts(s)) assert.doesNotMatch(l, /\b\d{4}-\d\d-\d\d\b/, l);
  // Locked: another reservation outside the trip is said, and the dates are not moved.
  s = await say(`I have a dinner reservation on ${spoken(addDays(date, 30))}`);
  assert.ok(agentTexts(s).pop().includes('The dates are locked, so I won\'t move them'));
  assert.ok(!s.proposal); assert.equal(s.current.token, p.token);
  // One asked without a date: the date question, then the answer inside the trip keeps the lock.
  s = await say('We booked a show');
  assert.equal(s.pending, 'eventDate');
  s = await say(spoken(date));
  const inside = agentTexts(s).pop();
  assert.ok(inside.startsWith(`Your show on ${longDate(date)} is inside your trip`), inside); assert.doesNotMatch(inside, /\b\d{4}-\d\d-\d\d\b/, inside);
});

test('MAKE IT BETTER FOR $0 MORE never lists or applies a version above the current total; MAKE THE TRADE keeps the total and the protected experience', async t => {
  const app = await startApp();
  t.after(app.close);
  const svc = app.ctx.tripService, priced = pricer(svc);
  const a = await built(app, 'v-xagent-zero-001');
  const total0 = a.s.current.total;
  let s = await a.say('Make it better for $0 more');
  const card = lastCard(s, 'more');
  assert.equal(card.zeroMore, true);
  for (const m of s.xmenu || []) { assert.ok(m.total <= total0, `${m.label}: ${m.total} ≤ ${total0}`); assert.equal(m.total, await priced(m.token)); }
  for (const it of card.items) assert.ok(it.delta <= 0);
  for (const f of card.things) assert.ok(f.source && f.checkedAt, 'a free thing only with its source and date');
  if ((s.xmenu || []).length) {
    s = await a.say('Option A');
    if (s.proposal && s.proposal.removesProtected) s = await a.say('Keep what I have');
    assert.ok(s.current.total <= total0, 'never above the current total');
  }
  // The trade: an experience in, the reductions out, a total at or under the current one, protected kept.
  const b = await built(app, 'v-xagent-trade-01', { goals: 'adventure' });
  const t0 = await svc.price(decodeSpec(b.s.current.token)), px = b.s.mainExperience;
  const xo = app.agent.xctx(b.s, await app.agent.settings()).o;
  const want = t0.activityOptions.find(o => !t0.spec.activities.includes(o.id) && X.trade(svc.inv, t0, o, { ...xo, goals: b.s.goals }).trip);
  assert.ok(want, 'a trade the inventory can make');
  s = await b.say(`Trade something for ${want.name}`);
  const p = s.proposal, tc = lastCard(s, 'trade');
  assert.equal(p.kind, 'trade'); assert.equal(p.total, await priced(p.token));
  assert.ok(p.total <= t0.total, 'the trade keeps the total');
  assert.equal(tc.total, p.total); assert.equal(tc.current, t0.total);
  assert.equal(t0.total + tc.add.amount - tc.remove.reduce((x, r) => x + r.amount, 0), p.total, 'in minus out is the new total');
  assert.ok(decodeSpec(p.token).activities.includes(want.id));
  assert.ok(decodeSpec(p.token).activities.includes(px), 'the protected experience is never traded away');
  assert.equal(s.current.token, b.s.current.token);
  s = await b.say('Make the trade');
  assert.equal(s.current.token, p.token); assert.equal(s.current.total, p.total);
});

test('the final experience check runs after the savings and leak checks and before the contract: a trip that fails it gets a rebuild as a proposal; kept, the contract follows', async t => {
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService, priced = pricer(svc);
  // Passing: one line, then the receipt, then the contract.
  const a = await built(app, 'v-xagent-final-01');
  let from = a.s.messages.length;
  let s = await a.say('Book it');
  for (let i = 0; i < 4 && s.proposal; i += 1) { await a.say('Keep what I have'); from = (await agent.load(a.id)).messages.length; s = await a.say('Book it'); }
  const kinds = s.messages.slice(from).map(m => m.card && m.card.kind).filter(Boolean);
  assert.ok(kinds.includes('final') && kinds.includes('contract'), kinds.join());
  assert.ok(kinds.indexOf('final') < kinds.indexOf('contract'));
  assert.ok(kinds.indexOf('xreceipt') < kinds.indexOf('contract'));
  assert.equal(lastCard(s, 'final', from).ok, true);
  assert.ok(agentTexts(s, from).includes('FINAL EXPERIENCE CHECK: this trip serves what you told me.'));
  // Failing: the adventure trip without its experiences; the rebuild is priced, proposed, and the contract waits.
  const b = await built(app, 'v-xagent-final-02', { goals: 'adventure' });
  const sp = decodeSpec(b.s.current.token);
  const bare = await svc.price({ ...sp, activities: [] });
  await agent.withState(b.id, st => { st.current = { token: encodeSpec(bare.spec), total: bare.total, since: agent.now().toISOString() }; st.proposal = null; st.pending = null; st.locks.experience = false; st.mainExperience = null; st.mainName = null; });
  let found = null;
  for (let i = 0; i < 4 && !found; i += 1) {
    from = (await agent.load(b.id)).messages.length;
    s = await b.say('Book it');
    if (s.proposal && s.proposal.kind === 'final') found = s.proposal;
    else if (s.proposal) await b.say('Keep what I have');
  }
  assert.ok(found, 'the rebuild is proposed');
  assert.equal(found.total, await priced(found.token));
  assert.ok(!s.messages.slice(from).some(m => m.card && m.card.kind === 'contract'), 'no contract while the check waits');
  const fc = lastCard(s, 'final', from);
  assert.equal(fc.ok, false); assert.ok(fc.reasons.some(r => !r.ok && r.text.includes('adventure')));
  assert.ok(agentTexts(s, from).pop().startsWith('FINAL EXPERIENCE CHECK: No experience in this trip serves adventure'));
  assert.equal(s.current.token, encodeSpec(bare.spec), 'nothing applied');
  await b.say('Keep what I have');
  from = (await agent.load(b.id)).messages.length;
  s = await b.say('Book it');
  const k2 = s.messages.slice(from).map(m => m.card && m.card.kind).filter(Boolean);
  assert.ok(k2.indexOf('final') >= 0 && k2.indexOf('final') < k2.indexOf('contract'), k2.join());
  assert.ok(agentTexts(s, from).some(l => l.includes(`The rebuild that passes (${money(found.total)}) is the one you chose not to take, so your trip stands.`)));
  // The check failed and the trip stands: the contract never says everything asked for is in it.
  const ct = lastCard(s, 'contract', from);
  assert.ok(ct.unmet.some(u => u.startsWith('the final experience check did not pass: No experience in this trip serves adventure')), ct.unmet.join(' | '));
});

// The screenshot: concert tickets on November 10, "Keep what I have", then "Book it". The check said SCHEDULE CONFLICT, then
// "No rebuild inside your rules and ceiling passes it either" although the agent had just priced the version that covers
// the concert under the maximum, and the contract said "Built around: your concert on 2026-11-10" and "✓ Everything you
// asked for is in this trip." The rebuild is looked for among the versions the conversation priced (the covering dates it
// offered included, whatever the engine's own search finds), offered with its price and what it changes, and taken only on
// the traveler's word; "no rebuild passes" only when none does; the contract says the miss, every date in words.
test('the final check at "book it" reads the event-covering version the conversation priced: offered as the rebuild, never "no rebuild passes"; the contract says the miss, dates in words', async t => {
  const clock = new Date('2026-10-07T09:00:00Z');
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService, priced = pricer(svc), ISO = /\b\d{4}-\d\d-\d\d\b/;
  // Book it until the final check speaks, keeping the savings and leak checks' versions on the way.
  const bookIt = async (b, from) => {
    let s = await b.say('Book it');
    for (let i = 0; i < 4 && s.proposal && s.proposal.kind !== 'final'; i += 1) { await b.say('Keep what I have'); s = await b.say('Book it'); }
    return { s, said: agentTexts(s, from) };
  };
  const withEvent = async visitor => {
    const b = await built(app, visitor);
    const t0 = await svc.price(decodeSpec(b.s.current.token)), date = addDays(t0.flight.return, 14);
    let s = await b.say(`I already have concert tickets on ${spoken(date)}`);
    const offer = s.proposal;
    assert.equal(offer.kind, 'event'); assert.equal(offer.total, await priced(offer.token));
    s = await b.say('Keep what I have');
    assert.equal(s.current.token, b.s.current.token, 'the dates were kept');
    return { b, t0, date, offer, ev: { name: 'your concert', date } };
  };
  const contract = async (b, s, from) => {
    const c = lastCard(s, 'contract', from);
    assert.ok(c, 'the contract follows');
    for (const [k, v] of [...c.asked, ...c.getting]) assert.doesNotMatch(String(v), ISO, `${k}: ${v}`);
    for (const u of c.unmet) assert.doesNotMatch(u, ISO, u);
    const page = text(await (await fetch(`${app.base}/agent/${b.id}`, { headers: { cookie: `txv=${b.visitor}` } })).text());
    const at = page.lastIndexOf('You asked for');
    return { c, page: page.slice(at, page.indexOf('Check the live price and book', at)) };
  };

  // 1. The engine's rebuild: the version that covers the concert, under the maximum, proposed with its price; nothing applied.
  const A = await withEvent('v-xagent-fcev-001'); A.b.visitor = 'v-xagent-fcev-001';
  let from = (await agent.load(A.b.id)).messages.length;
  let { s, said } = await bookIt(A.b, from);
  assert.ok(s.proposal && s.proposal.kind === 'final', `the rebuild is proposed: ${said.join(' | ')}`);
  let p = s.proposal, v = await svc.price(decodeSpec(p.token));
  assert.equal(p.total, v.total, 'priceTrip of its token'); assert.ok(p.total <= 200000, 'inside the maximum');
  assert.equal(X.eventCollision(v, A.ev), null, 'it covers the concert with a day\'s buffer');
  assert.ok(X.finalCheck(v, s.goals, { now: clock }).ok, 'it passes the check itself');
  assert.ok(v.spec.activities.includes(s.mainExperience), 'it keeps the protected experience');
  const fsaid = said.find(l => l.startsWith('FINAL EXPERIENCE CHECK'));
  assert.ok(fsaid.includes(`A rebuild that passes: ${money(p.total)}`) && fsaid.endsWith('Take the rebuild, or keep what you have; then say "book it" again.'), fsaid);
  assert.doesNotMatch(fsaid, /No rebuild/); assert.doesNotMatch(fsaid, ISO);
  assert.equal(s.current.token, A.b.s.current.token, 'a proposal, nothing applied');
  // Kept: the trip stands, said with the rebuild's price; the contract says the miss and never "Everything you asked for".
  await A.b.say('Keep what I have');
  from = (await agent.load(A.b.id)).messages.length;
  ({ s, said } = await bookIt(A.b, from));
  assert.ok(said.some(l => l.endsWith(`The rebuild that passes (${money(p.total)}) is the one you chose not to take, so your trip stands.`)), said.join(' | '));
  let { c, page } = await contract(A.b, s, from);
  assert.deepEqual(c.asked.find(r => r[0] === 'Built around'), ['Built around', `your concert on ${longDate(A.date)}`]);
  assert.ok(c.unmet.some(u => u.startsWith(`your concert on ${longDate(A.date)} falls after you fly home`)), c.unmet.join(' | '));
  assert.ok(c.unmet.includes('the final experience check did not pass'), c.unmet.join(' | '));
  assert.ok(!page.includes('Everything you asked for is in this trip') && page.includes('Not as asked:'), page);
  assert.ok(agentTexts(s, from).pop().startsWith(`Before you book, ${c.unmet.length} things are not what you asked for:`));

  // 2. An engine that finds no rebuild (as the engine before this fix did): the version the agent itself offered for the
  // concert is read by the same check and offered as the rebuild; taken on the traveler's word, the dates lock around it.
  const B = await withEvent('v-xagent-fcev-002'); B.b.visitor = 'v-xagent-fcev-002';
  const fc0 = X.finalCheck;
  X.finalCheck = (trip, goals, o) => { const r = fc0(trip, goals, o); return r.ok || !o.inv ? r : { ...r, rebuild: null, noRebuild: 'No rebuild I priced inside your rules and your $2,000 maximum passes this check.', text: r.text.replace(/ A rebuild that passes:.*$/, '') }; };
  try {
    from = (await agent.load(B.b.id)).messages.length;
    ({ s, said } = await bookIt(B.b, from));
    assert.ok(s.proposal && s.proposal.kind === 'final', `the conversation's own version is proposed: ${said.join(' | ')}`);
    p = s.proposal;
    assert.equal(p.token, B.offer.token, 'the event-covering version the agent offered');
    assert.equal(p.total, await priced(p.token)); assert.equal(p.eventLock, true);
    const l = said.find(x => x.startsWith('FINAL EXPERIENCE CHECK'));
    assert.ok(l.includes(`A rebuild that passes: ${money(p.total)} (${p.delta < 0 ? '−' : '+'}${money(Math.abs(p.delta))})`) && l.includes(`it covers your concert on ${longDate(B.date)} with a day's buffer either side; a proposal, nothing applied.`), l);
    assert.doesNotMatch(l, /No rebuild/); assert.doesNotMatch(l, ISO);
    // D: what it gives up is said in plain words: the experiences it drops by name, the pricer's trade-offs, or "gives up
    // nothing else" when both are empty; never left unsaid, never "nothing is given up by the facts".
    const pv = await svc.price(decodeSpec(p.token)), t1 = await svc.price(decodeSpec(B.b.s.current.token)), dropped = t1.activities.filter(a => !pv.spec.activities.includes(a.id));
    const traded = classifyChanges(t1, pv).tradeoffs.filter(r => r.key !== 'experiences');
    assert.doesNotMatch(l, /given up by the facts/, l);
    if (!dropped.length && !traded.length) assert.match(l, /(?: and gives up nothing else|; it gives up nothing else); it covers your concert/, l);
    for (const a of dropped) assert.ok(l.includes(`gives up ${a.name}`) || new RegExp(`gives up [^;]*${a.name}`).test(l), l);
    if (traded.length) assert.match(l, /; the trade-offs?: /, l);
  } finally { X.finalCheck = fc0; }
  s = await B.b.say('Take the rebuild');
  v = await svc.price(decodeSpec(p.token));
  assert.equal(s.current.token, p.token); assert.equal(s.locks.dates, true); assert.equal(s.depart, v.spec.depart);
  from = (await agent.load(B.b.id)).messages.length;
  ({ s, said } = await bookIt(B.b, from));
  assert.ok(said.includes('FINAL EXPERIENCE CHECK: this trip serves what you told me.'), said.join(' | '));
  ({ c } = await contract(B.b, s, from));
  assert.ok(!c.unmet.some(u => /concert|final experience check/.test(u)), c.unmet.join(' | '));
  assert.ok(c.asked.some(([k, val]) => k === 'Leaving' && val === longDate(v.spec.depart)), 'the fixed date in words');

  // 3. A maximum the covering dates cross (and no engine rebuild): nothing is offered as the fix; the engine's own sentence,
  // then what the covering version is: priced, and its amount over the maximum.
  const C = await withEvent('v-xagent-fcev-003'); C.b.visitor = 'v-xagent-fcev-003';
  assert.ok(C.offer.total > C.t0.total, 'fixture: the dates that cover the concert cost more than the trip');
  const cap = C.t0.total;
  await agent.withState(C.b.id, st => { st.budget = cap; });
  X.finalCheck = (trip, goals, o) => { const r = fc0(trip, goals, o); return r.ok || !o.inv ? r : { ...r, rebuild: null, noRebuild: `No rebuild I priced inside your rules and your ${money(cap)} maximum passes this check.`, text: r.text.replace(/ A rebuild that passes:.*$/, '') }; };
  try {
    from = (await agent.load(C.b.id)).messages.length;
    ({ s, said } = await bookIt(C.b, from));
  } finally { X.finalCheck = fc0; }
  assert.ok(!s.proposal, 'nothing offered as the fix');
  const l3 = said.find(x => x.startsWith('FINAL EXPERIENCE CHECK'));
  assert.ok(l3.includes(`No rebuild I priced inside your rules and your ${money(cap)} maximum passes this check. The dates that cover your concert pass it`) && l3.includes(`${money(C.offer.total)}), but it is ${money(C.offer.total - cap)} over your ${money(cap)} maximum, so I don't offer that version as the fix. It is your call.`), l3);
  assert.doesNotMatch(l3, /No rebuild inside your rules and ceiling/); assert.doesNotMatch(l3, ISO);
  ({ c, page } = await contract(C.b, s, from));
  assert.ok(!page.includes('Everything you asked for is in this trip'));
});

// Two sweet spots for one goal (the screenshot: "Where should I stop?" said "I'd stop at $1,530.79" and the canvas's Memories
// page link opened a ladder that said "I'd stop at $1,652.84" with "7 nights" as a reason). The agent reads the ladder for
// the trip on its canvas, and the link carries the rules the ladder reads (a length only when stated or locked, the dates
// when held), so the same trip, goals and rules say the same "I'd stop at" in both places, whatever the conversation assumed
// or the traveler took. And the build line says the lengths the build reads: never "I assumed 5 nights" over 6-night results.
test('"Where should I stop?" and the canvas\'s Memories page say the same "I\'d stop at" for the same trip and rules; the build line says the lengths it searched', async t => {
  const clock = new Date('2026-10-07T09:00:00Z');
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService, priced = pricer(svc);
  const dec = h => h.replace(/&amp;/g, '&').replace(/&#39;/g, '\'');
  const compare = async (b, visitor, why) => {
    await agent.withState(b.id, st => { st.proposal = null; st.pending = null; st.xmenu = []; });
    const s = await b.say('Where should I stop?'), card = lastCard(s, 'ladder');
    assert.ok(card && card.stop, `${why}: the ladder`);
    const rung = (s.xmenu || []).find(x => x.total === card.stop) || null;
    if (rung) assert.equal(rung.total, await priced(rung.token), `${why}: the stop is a priced rung`);
    const html = await (await fetch(`${app.base}/agent/${b.id}`, { headers: { cookie: `txv=${visitor}` } })).text();
    const href = dec((html.match(/href="(\/trip\/[^"]+\/memories\?[^"]+)"/) || [])[1] || '');
    assert.ok(href.startsWith(`/trip/${s.current.token}/memories?`), `${why}: the link opens the canvas trip (${href})`);
    const page = await (await fetch(app.base + href)).text();
    const stop = (dec(page).replace(/<[^>]+>/g, ' ').match(/I'd stop at (\$[\d,]+\.\d\d)/) || [])[1];
    assert.equal(stop, money(card.stop), `${why}: the page says the agent's "I'd stop at" (${href})`);
    return new URLSearchParams(href.split('?')[1]);
  };
  const seven = async (b, s) => { const t7 = await svc.price({ ...decodeSpec(s.current.token), nights: 7 }); await agent.withState(b.id, st => { st.current = { token: encodeSpec(t7.spec), total: t7.total, since: agent.now().toISOString() }; }); };
  // Nothing stated: the build line says the length is open and the lengths it prices; every result is one of them.
  const a = await built(app, 'v-xagent-stop-001');
  const line = agentTexts(a.s).find(l => l.startsWith('Building around what you want to remember'));
  const q = agent.xctx(a.s, await agent.settings()).q, said = [q.nights, q.nights + 1];
  assert.doesNotMatch(line, /I assumed[^.;]*\bnights\b/, line);
  assert.ok(line.includes(`You didn't state a length, so it is open: I price ${said[0]} and ${said[1]} nights, and each result says its own; say a length and I hold it.`), line);
  for (const w of lastCard(a.s, 'xways').ways) assert.ok(said.includes(decodeSpec(w.trip.token).nights), `${w.label}: one of the lengths said`);
  // A 7-night trip on the canvas, nothing stated: the agent's ladder is read for it, not for the assumed length.
  await seven(a, a.s);
  let P = await compare(a, 'v-xagent-stop-001', 'a 7-night canvas');
  assert.equal(P.get('nights'), null, 'no length the traveler did not state');
  // A length that came with a version they took is not a rule either: the link carries no nights= for it.
  await agent.withState(a.id, st => { st.nights = 7; });
  P = await compare(a, 'v-xagent-stop-001', 'a length taken, not stated');
  assert.equal(P.get('nights'), null);
  // Locked: the trip's own length, on both.
  await agent.withState(a.id, st => { st.locks.nights = true; });
  P = await compare(a, 'v-xagent-stop-001', 'the length locked');
  assert.equal(P.get('nights'), '7');
  // Stated: held by the build (no "open" sentence, every result that length) and carried by the link.
  const b = await built(app, 'v-xagent-stop-002', { from: 'two of us from NYC for 5 nights' });
  const line2 = agentTexts(b.s).find(l => l.startsWith('Building around what you want to remember'));
  assert.ok(!line2.includes('so it is open') && !/I assumed[^.;]*\bnights\b/.test(line2), line2);
  for (const w of lastCard(b.s, 'xways').ways) assert.equal(decodeSpec(w.trip.token).nights, 5);
  P = await compare(b, 'v-xagent-stop-002', 'the length stated');
  assert.equal(P.get('nights'), '5');
});

test('WHAT WAS ACTUALLY WORTH IT? after the trip: kept on the booking chip by chip; the account remembers it only on the owner\'s yes, and the next Experience Max names it', async t => {
  const clock = new Date(); clock.setUTCHours(9, 0, 0, 0);
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService;
  const q = { budget: 250000, vacationBudget: 250000, keep: 0, budgetInput: 2500, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
  const t0 = optimizer.search(svc.inv, q, { settings: await agent.settings(), now: agent.now() }).picks[0].trip;
  const dep = addDays(today(clock), -10);
  const trip = { ...t0, token: encodeSpec(t0.spec), spec: { ...t0.spec, depart: dep }, flight: { ...t0.flight, return: addDays(dep, t0.spec.nights) } };
  const user = { id: 'usr_xagent_worth', email: 'worth-agent@example.com', name: 'Worth' };
  const mk = (ref, status) => app.store.createBooking({ id: `bk_${ref}`, ref, vertical: 'trips', status, userId: user.id, total: t0.total, currency: 'USD', quote: { trip }, createdAt: clock.toISOString(), history: [] });
  await mk('BT-XWORTH1', 'confirmed');
  const s0 = await agent.create({ visitor: 'v-xagent-worth-01', userId: user.id, booking: { ref: 'BT-XWORTH1' } });
  const say = ask(agent, s0.id, user);
  let s = await say('Worth it: Main experience');
  assert.equal(s.pending, 'worthRemember');
  assert.ok(agentTexts(s).pop().endsWith('Remember this for next time?'));
  assert.deepEqual(lastCard(s, 'ask').options.map(o => o.say), ['Yes, remember it', 'No, this trip only']);
  let b = await app.store.getBookingByRef('BT-XWORTH1');
  assert.deepEqual(b.worthIt.worth, ['Main experience']); assert.equal(b.worthIt.defaults, 'not-asked');
  assert.equal(await app.store.getRecord('travel_defaults', user.id), null, 'nothing on the account before the yes');
  // A second chip adds to the answer; the question stays open and still nothing reaches the account.
  s = await say('Not worth it: Hotel');
  assert.equal(s.pending, 'worthRemember');
  b = await app.store.getBookingByRef('BT-XWORTH1');
  assert.deepEqual(b.worthIt.worth, ['Main experience']); assert.deepEqual(b.worthIt.notWorth, ['Hotel']);
  assert.equal(await app.store.getRecord('travel_defaults', user.id), null);
  // The yes from the signed-in owner: on the account, said in words.
  s = await say('Yes, remember it');
  const saved = await app.store.getRecord('travel_defaults', user.id);
  const learned = X.learn({ worth: ['Main experience'], notWorth: ['Hotel'] });
  assert.deepEqual({ ...saved.experiencePrefs, savedAt: undefined, from: undefined }, { ...learned.prefs, savedAt: undefined, from: undefined });
  assert.equal(saved.experiencePrefs.from, 'BT-XWORTH1');
  assert.ok(agentTexts(s).pop().startsWith('Remembered on your account: the hotel did not matter much to you and the main experience was worth it.'));
  // The agent's home for the booking asks the question with one chip per answer and shows what was kept.
  const home = bookingHome({ ...(await app.store.getBookingByRef('BT-XWORTH1')), components: [], payment: { amount: t0.total } }, { now: clock, preview: null, origin: svc.inv.maps.getOrigin('NYC') });
  assert.equal(home.worthIt.ask, true); assert.deepEqual(home.worthIt.chips, X.WORTH_IT_CHIPS);
  const hp = text(String(agentView(app.ctx, { s: await agent.load(s0.id), canvas: { home }, user })));
  assert.ok(hp.includes('WHAT WAS ACTUALLY WORTH IT?') && hp.includes('Worth it: Main experience. Not worth it: Hotel.') && hp.includes('Remembered on your account, as you asked.'));
  for (const c of X.WORTH_IT_CHIPS) assert.ok(hp.includes(`Worth it: ${c}`) && hp.includes(`Not worth it: ${c}`), c);
  assert.doesNotMatch(hp.slice(hp.indexOf('WHAT WAS ACTUALLY WORTH IT?'), hp.indexOf('The booking page')), PRESSURE);
  // A no keeps it on the booking only, on another booking of the same account.
  await mk('BT-XWORTH2', 'confirmed');
  const s2 = await agent.create({ visitor: 'v-xagent-worth-02', userId: user.id, booking: { ref: 'BT-XWORTH2' } });
  const say2 = ask(agent, s2.id, user);
  await say2('The food was worth it');
  s = await say2('No, this trip only');
  assert.equal(agentTexts(s).pop(), 'Kept only on this booking; nothing goes to your account.');
  assert.equal((await app.store.getBookingByRef('BT-XWORTH2')).worthIt.defaults, 'not-asked');
  assert.deepEqual((await app.store.getRecord('travel_defaults', user.id)).experiencePrefs.from, 'BT-XWORTH1', 'the account is unchanged');
  // Not open before the trip is over: the service's reason, nothing kept.
  await app.store.createBooking({ id: 'bk_BT-XWORTH3', ref: 'BT-XWORTH3', vertical: 'trips', status: 'confirmed', userId: user.id, total: t0.total, currency: 'USD', quote: { trip: { ...trip, spec: { ...trip.spec, depart: addDays(today(clock), 10) }, flight: { ...trip.flight, return: addDays(today(clock), 15) } } }, createdAt: clock.toISOString(), history: [] });
  const s3 = await agent.create({ visitor: 'v-xagent-worth-03', userId: user.id, booking: { ref: 'BT-XWORTH3' } });
  s = await ask(agent, s3.id, user)('Worth it: Hotel');
  assert.ok(agentTexts(s).pop().startsWith('This question is for after the trip'));
  assert.equal((await app.store.getBookingByRef('BT-XWORTH3')).worthIt, undefined);
  // The next Experience Max for this account names what it learned, and only because they said yes.
  const n = await agent.create({ visitor: 'v-xagent-worth-04', userId: user.id, mission: true, mode: 'experience' });
  assert.equal(n.prefs.mainMatters, true); assert.equal(n.prefs.stayMatters, false);
  s = await ask(agent, n.id, user)('$2,000');
  assert.ok(agentTexts(s).some(l => l.includes('the hotel did not matter much to you') && l.includes('the main experience was worth it')), agentTexts(s).join(' | '));
  for (const l of agentTexts(s)) assert.doesNotMatch(l, PRESSURE, l);
});

// ---- Review 12: the customer's word, said and kept ----------------------------------------------------

const { classifyChanges } = require('../server/trips/facts');

test('understanding: a goals answer about remembering is never "remember my defaults"; way words and sentences starting with a letter pick nothing; an earlier card\'s letter is never an approval; "2 more nights" is two', () => {
  const goals = { pending: 'goals', mission: { mode: 'experience' } };
  for (const t of ['I want to remember this trip with my partner forever', 'Remember this: beach and food', 'remember my defaults']) assert.ok(!understand(t, goals, { maps }).intents.some(i => i === 'remember' || i === 'forget'), t);
  assert.deepEqual(understand('Remember this: beach and food', goals, { maps }).updates.goals, ['beach', 'food']);
  assert.ok(understand('Remember these as my defaults', { mission: { mode: null } }, { maps }).intents.includes('remember'), 'the defaults words still work outside the question');
  // After the results: only a card's name or its number picks it; the plain mission's way words do not.
  const ways = { pending: 'ways', goals: ['beach'], mission: { mode: 'experience', strategies: [{ key: 'pick' }, { key: 'comfort' }] } };
  for (const t of ['I would rather keep more money', 'We want 2 experiences, not 1', 'Make it special', 'Give me 3', 'I want 2 more nights']) assert.equal(understand(t, ways, { maps }).updates.way, undefined, t);
  assert.equal(understand('2', ways, { maps }).updates.way, 'comfort');
  assert.equal(understand('More comfort', ways, { maps }).updates.way, 'comfort');
  const more = understand('I want 2 more nights', ways, { maps });
  assert.ok(more.intents.includes('extend')); assert.equal(more.updates.addNights, 2);
  // A lettered menu: the letter as the whole message (or the card button's "Option X: label"), never a
  // sentence that starts with "a".
  const opts = { pending: 'options', goals: ['beach'], mission: { mode: 'experience' } };
  for (const t of ['A stop is fine', 'A cheaper flight would be nice', 'a nonstop flight would be better', 'B&B would be nice']) assert.equal(understand(t, opts, { maps }).updates.option, undefined, t);
  assert.equal(understand('A', opts, { maps }).updates.option, 'A');
  assert.equal(understand('Option b', opts, { maps }).updates.option, 'B');
  const lab = understand('Option C: An airport transfer', opts, { maps }).updates;
  assert.equal(lab.option, 'C'); assert.equal(lab.optionLabel, 'An airport transfer');
  // With no menu open, an old card's button is a stale letter, never an approval of what is on the table.
  for (const t of ['Option C', 'Option C: An airport transfer']) {
    const u = understand(t, { pending: null, goals: ['beach'], mission: { mode: 'experience' }, proposal: { kind: 'surprise' } }, { maps });
    assert.ok(!u.intents.includes('approve'), t); assert.equal(u.updates.staleOption.letter, 'C', t);
  }
});

test('"Remember this for next time?": a no in any words keeps it on the booking only; only a plain yes reaches the account; a goals answer saves nothing', async t => {
  const clock = new Date(); clock.setUTCHours(9, 0, 0, 0);
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService;
  const q = { budget: 250000, vacationBudget: 250000, keep: 0, budgetInput: 2500, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
  const t0 = optimizer.search(svc.inv, q, { settings: await agent.settings(), now: agent.now() }).picks[0].trip;
  const dep = addDays(today(clock), -10);
  const trip = { ...t0, token: encodeSpec(t0.spec), spec: { ...t0.spec, depart: dep }, flight: { ...t0.flight, return: addDays(dep, t0.spec.nights) } };
  const user = { id: 'usr_xagent_refuse', email: 'refuse-agent@example.com', name: 'Refuse' };
  await app.store.createBooking({ id: 'bk_BT-XREFUSE', ref: 'BT-XREFUSE', vertical: 'trips', status: 'confirmed', userId: user.id, total: t0.total, currency: 'USD', quote: { trip }, createdAt: clock.toISOString(), history: [] });
  let i = 0;
  for (const no of ['Please don\'t', 'Do not remember this', 'Please never remember that', 'Sure, but I\'d rather you didn\'t', 'No thanks', 'This trip only']) {
    const c = await agent.create({ visitor: `v-xagent-refuse-${String(i++).padStart(2, '0')}`, userId: user.id, booking: { ref: 'BT-XREFUSE' } });
    const say = ask(agent, c.id, user);
    let s = await say('Not worth it: Hotel');
    assert.equal(s.pending, 'worthRemember');
    s = await say(no);
    assert.equal(agentTexts(s).pop(), 'Kept only on this booking; nothing goes to your account.', no);
    assert.equal(await app.store.getRecord('travel_defaults', user.id), null, `"${no}" puts nothing on the account`);
  }
  // A plain yes still does.
  const c = await agent.create({ visitor: 'v-xagent-refuse-yes', userId: user.id, booking: { ref: 'BT-XREFUSE' } });
  const say = ask(agent, c.id, user);
  await say('Not worth it: Hotel');
  const s = await say('Yes please');
  assert.ok(agentTexts(s).pop().startsWith('Remembered on your account'));
  assert.equal((await app.store.getRecord('travel_defaults', user.id)).experiencePrefs.from, 'BT-XREFUSE');
  // WHAT DO YOU WANT TO REMEMBER? answered with "remember this ...": a memory, not the account's defaults.
  const u2 = { id: 'usr_xagent_goalword', email: 'goalword@example.com', name: 'Goal' };
  const g = await agent.create({ visitor: 'v-xagent-goalword', userId: u2.id, mission: true, mode: 'experience' });
  const gsay = ask(agent, g.id, u2);
  let gs = await gsay('$2,000 for two of us from NYC');
  assert.equal(gs.pending, 'goals');
  gs = await gsay('I want to remember this trip with my partner forever');
  assert.equal(await app.store.getRecord('travel_defaults', u2.id), null, 'nothing saved to the account unasked');
  assert.equal(gs.pending, 'goals', 'no goal in it: the question is asked again');
  assert.ok(agentTexts(gs).pop().startsWith('WHAT DO YOU WANT TO REMEMBER?'));
});

test('WORTH IT from the agent: the yes or no reaches the service with who is asking, and what it decided is said: replaced, removed, kept on the account that booked it, or no account at all', async t => {
  const clock = new Date(); clock.setUTCHours(9, 0, 0, 0);
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService;
  const q = { budget: 250000, vacationBudget: 250000, keep: 0, budgetInput: 2500, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
  const t0 = optimizer.search(svc.inv, q, { settings: await agent.settings(), now: agent.now() }).picks[0].trip;
  const dep = addDays(today(clock), -10);
  const trip = { ...t0, token: encodeSpec(t0.spec), spec: { ...t0.spec, depart: dep }, flight: { ...t0.flight, return: addDays(dep, t0.spec.nights) } };
  const user = { id: 'usr_xagent_earlier', email: 'earlier@example.com', name: 'Earlier' };
  const mk = (ref, userId) => app.store.createBooking({ id: `bk_${ref}`, ref, vertical: 'trips', status: 'confirmed', userId, total: t0.total, currency: 'USD', quote: { trip }, createdAt: clock.toISOString(), history: [] });
  let n = 0;
  const conv = async (ref, u, lines) => { const c = await agent.create({ visitor: `v-xagent-earlier-${String(n++).padStart(2, '0')}`, userId: u ? u.id : null, booking: { ref } }); let s; for (const l of lines) s = await ask(agent, c.id, u)(l); return s; };
  const prefs = async () => { const d = await app.store.getRecord('travel_defaults', user.id); return d && d.experiencePrefs ? d.experiencePrefs : null; };
  const learned = a => X.learn(a).prefs;
  await mk('BT-XEARLY1', user.id);
  // Remembered once on the owner's yes.
  await conv('BT-XEARLY1', user, ['Not worth it: Hotel', 'Yes, remember it']);
  assert.equal((await prefs()).stayMatters, learned({ notWorth: ['Hotel'] }).stayMatters);
  // A changed answer: the question says what each reply does to the earlier one; the no removes it, said.
  let s = await conv('BT-XEARLY1', user, ['Worth it: Hotel']);
  assert.ok(agentTexts(s).pop().includes('Your account already has an answer from this booking that you asked me to remember: a yes replaces it with this one, a no removes it.'));
  assert.equal((await prefs()).from, 'BT-XEARLY1', 'nothing moves on the account before the reply');
  s = await conv('BT-XEARLY1', user, ['Worth it: Hotel', 'No, this trip only']);
  assert.ok(agentTexts(s).pop().startsWith('Kept only on this booking; nothing goes to your account. The answer from this booking you asked me to remember before is removed from your account'));
  assert.equal(await prefs(), null, 'the latest no leaves no contradicting preference on the account');
  assert.equal((await app.store.getBookingByRef('BT-XEARLY1')).worthIt.earlier, 'removed');
  // Remembered again, then a changed answer with a yes replaces it, said.
  await conv('BT-XEARLY1', user, ['Not worth it: Hotel', 'Yes, remember it']);
  s = await conv('BT-XEARLY1', user, ['Worth it: Hotel', 'Yes, remember it']);
  assert.ok(agentTexts(s).pop().includes('It replaces the answer from this booking you asked me to remember before.'));
  assert.equal((await prefs()).stayMatters, learned({ worth: ['Hotel'] }).stayMatters);
  // Signed out, a no cannot change the account: kept there, and said who can change it.
  s = await conv('BT-XEARLY1', null, ['Not worth it: Hotel', 'No']);
  assert.ok(agentTexts(s).pop().includes('still on the account that booked it: only that account, signed in, can change it'));
  assert.equal((await prefs()).stayMatters, learned({ worth: ['Hotel'] }).stayMatters, 'unchanged');
  // A booking made without an account: no promise of a save, signed in or not, and never "sign in".
  await mk('BT-XGUEST1', null);
  for (const u of [user, null]) {
    s = await conv('BT-XGUEST1', u, ['Not worth it: Hotel']);
    const ask1 = agentTexts(s).pop();
    assert.ok(!ask1.includes('Remember this for next time?') && ask1.includes('made without an account'), ask1);
    s = await ask(agent, s.id, u)('Yes, remember it');
    const said = agentTexts(s).pop();
    assert.ok(said.startsWith('This booking was made without an account') && !/sign in/i.test(said), said);
    assert.equal((await app.store.getBookingByRef('BT-XGUEST1')).worthIt.defaults, 'guest');
  }
  assert.equal((await prefs()).stayMatters, learned({ worth: ['Hotel'] }).stayMatters, 'the account is untouched by a guest booking');
  const home = bookingHome({ ...(await app.store.getBookingByRef('BT-XGUEST1')), components: [], payment: { amount: t0.total } }, { now: clock, preview: null, origin: svc.inv.maps.getOrigin('NYC') });
  const hp = text(String(agentView(app.ctx, { s: await agent.load(s.id), canvas: { home }, user })));
  assert.ok(hp.includes('Kept on this booking only: it was made without an account'), 'the booking home says where it is kept');
});

test('a card\'s letter takes only the version it names: an old card\'s button applies nothing else, said; a version that gives something up is a proposal that says it first', async t => {
  const app = await startApp();
  t.after(app.close);
  const svc = app.ctx.tripService, priced = pricer(svc);
  const b = await built(app, 'v-xagent-stale-01');
  let s = await b.say('Make $100 memorable');
  const menu = s.xmenu.map(x => ({ ...x }));
  assert.ok(menu.length >= 2);
  // Another chip puts something else on the table; the old card's buttons still send their own words.
  s = await b.say('What if it rains?');
  const held = s.proposal;
  for (const m of menu) {
    s = await b.say(`Option ${m.letter}: ${m.label}`);
    assert.equal(s.current.token, b.s.current.token, `Option ${m.letter} from the old card applies nothing`);
    assert.ok(agentTexts(s).pop().startsWith(`Those words name option ${m.letter} (${m.label}) from an earlier card, which is not on the table now, so nothing is applied on them.`));
    if (held) assert.equal(s.proposal && s.proposal.token, held.token, 'what is on the table stays there, untaken');
  }
  // The card's own proposal: its button takes that version and no other.
  const c = await built(app, 'v-xagent-stale-02');
  s = await c.say('Make $100 memorable');
  const own = s.proposal, menu2 = s.xmenu.map(x => ({ ...x }));
  assert.ok(own && own.letter && own.optLabel);
  s = await c.say('Why this trip is built this way');
  const other = menu2.find(m => m.letter !== own.letter);
  if (other) { s = await c.say(`Option ${other.letter}: ${other.label}`); assert.equal(s.current.token, c.s.current.token); }
  s = await c.say(`Option ${own.letter}: ${own.optLabel}`);
  assert.equal(s.current.token, own.token); assert.equal(s.current.total, await priced(own.token));
  // MAKE IT BETTER FOR $0 MORE: a version that gives something up (the carry-on on a Basic fare) is never
  // listed as a no-loss change, and its letter is a proposal that says the loss before anything is taken.
  const d = await built(app, 'v-xagent-stale-03');
  s = await d.say('Make it better for $0 more');
  const card = lastCard(s, 'more'), cur = await svc.price(decodeSpec(d.s.current.token)), xm = (s.xmenu || []).map(x => ({ ...x }));
  const tokenOf = it => it.token || (xm.find(x => x.letter === it.letter) || {}).token;
  for (const it of card.items || []) {
    const v = await svc.price(decodeSpec(tokenOf(it)));
    assert.deepEqual(classifyChanges(cur, v).tradeoffs, [], `${it.label} gives nothing up`);
  }
  for (const tr of card.trades || []) assert.ok(tr.givesUp && tr.givesUp.length, tr.label);
  const tr = (card.trades || [])[0];
  assert.ok(tr, 'this trip has a cheaper version that gives something up (the Basic fare)');
  {
    s = await d.say(tr.say);
    assert.equal(s.current.token, d.s.current.token, 'nothing taken on the letter');
    assert.equal(s.proposal.token, tokenOf(tr)); assert.equal(s.proposal.total, await priced(tokenOf(tr)));
    const said = agentTexts(s).pop();
    assert.ok(said.includes('It gives up') && said.endsWith('Take it, or keep what you have.'), 'the loss is said before anything is taken');
    s = await d.say('Take it');
    assert.equal(s.current.token, tokenOf(tr), 'taken on the customer\'s word');
  }
  // The ladder's lower rung (a night and an experience fewer) by its letter: said first, never applied.
  const e = await built(app, 'v-xagent-stale-04');
  s = await e.say('Experience ladder');
  const lad = (s.xmenu || []).map(x => ({ ...x })), cur2 = await svc.price(decodeSpec(e.s.current.token)), loses = [];
  for (const m of lad) if (classifyChanges(cur2, await svc.price(decodeSpec(m.token))).tradeoffs.length) loses.push(m);
  assert.ok(loses.length, 'the ladder has a rung that gives something up');
  s = await e.say(loses[0].letter);
  assert.equal(s.current.token, e.s.current.token, 'nothing taken on the letter');
  assert.equal(s.proposal.token, loses[0].token);
  assert.ok(agentTexts(s).pop().includes('It gives up'));
});

test('one protected main experience, and who protected it is said truthfully: the results\' protection is the agent\'s; a second protect replaces the first, said; a surprise never frees it', async t => {
  const app = await startApp();
  t.after(app.close);
  const svc = app.ctx.tripService;
  const b = await built(app, 'v-xagent-prot-who-1');
  const px = b.s.mainExperience, name = b.s.mainName;
  assert.equal(b.s.protectAuto, true);
  // Set by the results: not on "what you asked for", and never "you protected" in what is said.
  assert.ok(!state.askedFor(b.s, { maps }).some(([k]) => k === 'Main experience'), 'the agent\'s protection is not something the customer asked for');
  assert.ok(state.missionRules(b.s, { maps }).locked.some(l => l.startsWith(`Main experience: ${name} (protected by me`)));
  let from = b.s.messages.length;
  let s = await b.say('Same feeling for less');
  if (s.proposal) s = await b.say('Yes');
  for (const l of agentTexts(s, from)) assert.doesNotMatch(l, /you protected/, l);
  // SURPRISE ME COMPLETELY keeps the protection, said; "our pick" never drops it.
  from = s.messages.length;
  s = await b.say('Surprise me completely');
  assert.equal(state.protectedId(s), px, 'still protected');
  assert.ok(agentTexts(s, from).some(l => l.includes(`${name} stays protected`)), agentTexts(s, from).join(' | '));
  if (s.pending === 'ways') {
    s = await b.say('Our pick');
    assert.ok(decodeSpec(s.current.token).activities.includes(px), 'the protected experience is still in the trip');
  }
  // The customer protects it: now on what they asked for.
  const c = await built(app, 'v-xagent-prot-who-2');
  const trip = await svc.price(decodeSpec(c.s.current.token));
  const first = trip.activities.find(a => a.id === c.s.mainExperience), second = trip.activities.find(a => a.id !== c.s.mainExperience);
  s = await c.say(`Protect the ${first.name}`);
  assert.equal(s.protectAuto, false);
  assert.ok(state.askedFor(s, { maps }).some(([k, v]) => k === 'Main experience' && v.startsWith(first.name)));
  // Only one main experience: protecting another replaces it, and the release is said.
  assert.ok(second, 'the fixture trip has a second experience');
  s = await c.say(`Protect the ${second.name}`);
  assert.equal(state.protectedId(s), second.id);
  assert.ok(agentTexts(s).pop().includes(`${second.name} is now the experience I protect; ${first.name} is no longer protected.`));
});

test('the engines name the protection neutrally and the agent says who set it: the customer\'s own "protect <it>" is theirs, the results\' lock is the agent\'s and never "you protected"', async t => {
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService;
  // The engines' neutral words, as each engine writes them (experience, decision, leaks, strategies).
  const ENGINE = ['Kayak tour is the protected experience: it stays unless you say to drop it', 'without Kayak tour, the protected experience', 'Kayak tour, the protected experience, is offered in Cancun', 'what is left is what I keep (the main experience and the protected one)', 'The protected experience: no swap is offered for it.'];
  const NEUTRAL = /\b[Tt]he protected (?:experience|one)\b/;
  const said = (auto, px = 'kayak') => {
    const s = state.newState({ id: 'x-who' });
    if (px) { s.locks.experience = true; s.mainExperience = px; s.mainName = 'Kayak tour'; s.protectAuto = auto; }
    for (const line of ENGINE) agent.speak(s, line, { kind: 'note', text: line });
    return s.messages.map(m => [m.text, m.card.text]);
  };
  for (const [text, card] of said(false)) {
    assert.doesNotMatch(text, NEUTRAL, text); assert.match(text, /\b(?:experience|one) you protected\b/i, text); assert.equal(card, text, 'the card says the same');
  }
  for (const [text, card] of said(true)) {
    assert.doesNotMatch(text, NEUTRAL, text); assert.doesNotMatch(text, /you protected/, text); assert.match(text, /\bI'm protecting for you\b/, text); assert.equal(card, text);
  }
  // Nothing protected in the session: the engine's words are said as they are, owned by nobody.
  for (const [text] of said(false, null)) { assert.doesNotMatch(text, /you protected|protecting for you/, text); assert.match(text, NEUTRAL, text); }
  // In conversation: ONE BIG MEMORY's "beside the protected experience" said as the results' lock, then as the customer's.
  const b = await built(app, 'v-xagent-who-big-1', { budget: '$3,000', goals: 'adventure and nature' });
  assert.equal(b.s.protectAuto, true);
  for (const own of [false, true]) {
    let s = own ? await b.say(`Protect ${b.s.mainName}`) : b.s;
    assert.equal(s.protectAuto, !own);
    const from = s.messages.length;
    s = await b.say('One big memory or more things to do?');
    const x = agent.xctx(s, await agent.settings());
    const r = X.bigVsMany(svc.inv, await svc.price(decodeSpec(s.current.token)), x.gs, x.o);
    const all = s.messages.slice(from).filter(m => m.role === 'agent').map(m => `${m.text} ${JSON.stringify(m.card || {})}`).join(' | ');
    assert.doesNotMatch(all, NEUTRAL, all);
    if (!own) assert.doesNotMatch(all, /you protected/, all);
    if (r.text.includes('beside the protected experience')) assert.ok(all.includes(own ? 'beside the experience you protected' : 'beside the main experience I\'m protecting for you'), all);
  }
});

test('"None of these" then the same goals builds a different set; ONE BIG MEMORY never offers the trip already on the canvas', async t => {
  const app = await startApp();
  t.after(app.close);
  const svc = app.ctx.tripService;
  const b = await built(app, 'v-xagent-none-01');
  const was = await svc.price(decodeSpec(b.s.current.token));
  let s = await b.say('None of these');
  assert.equal(s.pending, 'goals');
  const from = s.messages.length;
  s = await b.say('Beach and food');
  const now = await svc.price(decodeSpec(s.current.token));
  assert.notEqual(now.dest.id, was.dest.id, 'a different set, as promised');
  assert.ok(agentTexts(s, from).some(l => l.includes(`I leave out ${was.dest.name}`)), agentTexts(s, from).join(' | '));
  // The trip already has the one big memory: nothing is offered at +$0 against itself.
  const c = await built(app, 'v-xagent-bigmany-1');
  const trip = await svc.price(decodeSpec(c.s.current.token));
  const small = trip.activities.find(a => a.id !== c.s.mainExperience);
  assert.ok(small);
  await c.say(`Protect the ${small.name}`);
  s = await c.say('One big memory or more things to do?');
  const p = s.proposal;
  if (p) {
    assert.notEqual(p.token, s.current.token);
    for (const ch of Object.values(p.choices || {})) if (ch) assert.notEqual(ch.token, s.current.token, 'no side is the trip already on the canvas');
  }
});

test('BUILD AROUND AN EVENT: an overnight flight\'s landing day counts, and a version on dates its seasonal experience does not run says what it drops', async t => {
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService;
  // An overnight flight: the traveler lands the day after they leave.
  const b = await built(app, 'v-xagent-overnight', { budget: '$4,000', goals: 'culture and food' });
  const t0 = await svc.price(decodeSpec(b.s.current.token));
  let t1 = null;
  for (const d of svc.inv.maps.listDestinations()) {
    const fl = svc.inv.flights.search({ from: 'JFK', destId: d.id, depart: t0.spec.depart, nights: t0.spec.nights, travelers: 2 }).find(f => f.arrivesNextDay);
    if (!fl) continue;
    const h = svc.inv.hotels.search({ destId: d.id, checkIn: t0.spec.depart, nights: t0.spec.nights, rooms: 1 })[0];
    t1 = h && await svc.price({ ...t0.spec, dest: d.id, flight: fl.id, hotel: h.id, activities: [] });
    if (t1) break;
  }
  assert.ok(t1 && t1.flight.arrivesNextDay, 'the demo data has an overnight flight');
  const reset = () => agent.withState(b.id, st => { st.current = { token: encodeSpec(t1.spec), total: t1.total, since: agent.now().toISOString() }; st.proposal = null; st.pending = null; st.locks.experience = false; st.locks.dates = false; st.mainExperience = null; st.mainName = null; st.event = null; st.dateMode = 'anytime'; st.depart = null; });
  await reset();
  const lands = addDays(t1.spec.depart, 1);
  // On the landing day: a conflict, and the latest departure said lands a day before it.
  const ISO = /\b\d{4}-\d\d-\d\d\b/;
  let s = await b.say(`I already have concert tickets on ${spoken(lands)}`);
  let said = agentTexts(s).pop();
  assert.ok(!said.includes('inside your trip'), said);
  assert.doesNotMatch(said, ISO, 'every date in the reply in words, the engine\'s and the agent\'s alike');
  assert.ok(!s.locks.dates);
  // The engine says its dates in words; the range it says is the one it computed, and its last day lands a day before.
  const rg = X.eventRange({ date: lands, name: 'your concert' }, t1.spec.nights, t1.flight);
  assert.ok(rg.to && said.includes(`Leave between ${longDate(rg.from)} and ${longDate(rg.to)}`) && addDays(rg.to, 1) <= addDays(lands, -1), `the latest departure lands a day before: ${said}`);
  if (s.proposal) {
    const v = await svc.price(decodeSpec(s.proposal.token));
    assert.ok((v.flight.arrivesNextDay ? addDays(v.spec.depart, 1) : v.spec.depart) <= addDays(lands, -1), 'the proposal lands a day before');
  }
  // Inside the trip: the day they land is said, not the day they leave.
  await reset();
  s = await b.say(`I already have concert tickets on ${spoken(addDays(t1.spec.depart, 3))}`);
  said = agentTexts(s).pop();
  assert.ok(said.includes('is inside your trip') && said.includes(`you land ${longDate(lands)}`), said);
  assert.doesNotMatch(said, ISO, said);
  assert.equal(s.locks.dates, true);
  // A seasonal experience (the Northern lights, Sep–Mar) and a concert in May: the version never keeps it
  // out of season, and says what it drops before anything is taken.
  const r = await built(app, 'v-xagent-season-ev', { budget: '$4,000', goals: 'nature', from: 'two of us from NYC to Reykjavik' });
  const rt = await svc.price(decodeSpec(r.s.current.token));
  assert.ok(rt.activities.some(a => a.months && a.months.length), 'the fixture trip has a seasonal experience');
  const ev = `${Number(rt.spec.depart.slice(0, 4)) + 1}-05-20`;
  s = await r.say(`I already have concert tickets on ${spoken(ev)}`);
  assert.ok(s.proposal && s.proposal.kind === 'event');
  const v = await svc.price(decodeSpec(s.proposal.token));
  assert.deepEqual(X.collisions(v, { goals: s.goals }).filter(c => c.kind === 'season').map(c => c.text), [], 'every experience in the version runs on its dates');
  const gone = rt.activities.filter(a => !v.spec.activities.includes(a.id));
  said = agentTexts(s).pop();
  for (const a of gone) assert.ok(said.includes('this version drops') && said.includes(a.name), said);
  s = await r.say('Take it');
  const done = agentTexts(s).find(l => l.startsWith('Done.'));
  for (const a of gone) assert.ok(done.includes(a.name) && !done.includes('Nothing given up'), done);
});

test('the hotel the customer asked for is never argued against: "the room matters to us" and "the hotel matters most" price the upgrade without the challenge', async t => {
  const app = await startApp();
  t.after(app.close);
  for (const [i, words] of [['the hotel matters most', 'Upgrade the hotel'], [null, 'Upgrade the hotel, the room matters to us']].entries()) {
    const b = await built(app, `v-xagent-stay-${i}`, { budget: '$3,000', goals: 'adventure' });
    if (words[0]) await b.say(words[0]);
    const before = (await app.agent.load(b.id)).current.token;
    const s = await b.say(words[1]);
    const said = agentTexts(s).pop();
    assert.doesNotMatch(said, /told me the trip itself matters more than the room/, said);
    assert.ok(s.proposal && s.proposal.token !== before, 'the upgrade is priced as a proposal');
    assert.equal(s.current.token, before, 'nothing applied without the customer\'s word');
  }
});

test('the stay in the customer\'s own words: "an upgrade you told me you don\'t care about" only after they said it; never from a negation or from another thing; their latest word counts', async t => {
  // Understanding: the words that say the stay does not matter, and the ones that never do.
  const xs = { mission: { mode: 'experience' }, goals: ['adventure'] };
  for (const w of ['The hotel doesn\'t matter', 'We don\'t care about the hotel', 'the room doesn\'t matter', 'It\'s just a place to sleep', 'Honestly, any hotel is fine', 'I don\'t really care which hotel', 'The hotel matters less to us', 'the hotel isn\'t that important', 'I don\'t think the hotel matters', 'We don\'t need a fancy hotel']) {
    const u = understand(w, xs, { maps }).updates;
    assert.equal(u.stayLow, true, w); assert.ok(!u.statedStay && u.priority !== 'hotel', `${w}: never read as asking for the stay`);
  }
  for (const w of ['The hotel matters most', 'the room matters to us', 'I don\'t care about the price', 'the hotel price doesn\'t matter', 'how long we stay doesn\'t matter', 'I never said the hotel doesn\'t matter', 'If the hotel doesn\'t matter, what then?', 'The hotel doesn\'t matter?', 'we don\'t care about the room service', 'the room doesn\'t matter but the hotel matters most']) assert.ok(!understand(w, xs, { maps }).updates.stayLow, w);
  // Asking for the stay is the customer's own statement that it matters: never a question about it, the
  // hotel's price, or how long they stay ("Got it: where you stay matters to you" would put words in their mouth).
  for (const w of ['Does the hotel matter?', 'does the room matter much?', 'the hotel price matters', 'The hotel\'s price matters to us', 'how long we stay matters']) assert.ok(!understand(w, xs, { maps }).updates.statedStay, `${w}: never read as asking for the stay`);
  for (const w of ['the room matters to us', 'where we stay matters', 'we care about the hotel', 'The hotel matters most', 'the stay is the point']) assert.equal(understand(w, xs, { maps }).updates.statedStay, true, w);
  assert.ok(!understand('The hotel doesn\'t matter', { mission: { mode: null } }, { maps }).updates.stayLow, 'Experience Max only');
  assert.equal(understand('The hotel doesn\'t matter, make $100 memorable', xs, { maps }).updates.stayLow, true, 'rides with a chip');
  // The session: whichever they said last replaces the other.
  const st = state.newState({ id: 'x-stay' });
  assert.equal(st.stayLow, false);
  state.applyUpdates(st, { stayLow: true }); assert.deepEqual([st.stayLow, st.statedStay], [true, false]);
  state.applyUpdates(st, { statedStay: true }); assert.deepEqual([st.stayLow, st.statedStay], [false, true]);
  state.applyUpdates(st, { stayLow: true }); assert.deepEqual([st.stayLow, st.statedStay], [true, false]);
  // In conversation: the engine's own rejected line, with the customer's words only when they said them.
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService;
  for (const said of [false, true]) {
    const b = await built(app, `v-xagent-staylow-${said ? 1 : 0}`, { budget: said ? '$3,000, the hotel doesn\'t matter' : '$3,000', goals: 'adventure' });
    assert.equal(!!b.s.stayLow, said);
    const x = agent.xctx(b.s, await agent.settings());
    assert.equal(x.o.stayLow, said, 'the engine hears it');
    const W = X.experienceWays(svc.inv, x.q, x.gs, x.o);
    assert.ok(W.rejected, 'the fixture has a hotel step-up the pick rejects');
    assert.equal(W.rejected.saidLow, said);
    const card = lastCard(b.s, 'xways');
    assert.equal(card.rejected.text, W.rejected.text);
    const res = agentTexts(b.s).find(l => l.includes(W.rejected.text));
    assert.ok(res, 'the results say the engine\'s line');
    if (said) assert.match(res, /upgrade you told me you don't care about/);
    else { assert.doesNotMatch(res, /you told me you don't care/); assert.match(res, /upgrade you didn't ask for/); }
    // The upgrade challenge: "You told me ..." only when they did; otherwise what is true.
    const t0 = await svc.price(decodeSpec(b.s.current.token)), h = X.hotelOrExperience(svc.inv, t0, x.gs, x.o);
    const challenged = !!h.a && X.challengeUpgrade(t0, h.a.trip, x.gs, svc.inv, x.o).challenge;
    assert.ok(challenged, 'the fixture\'s upgrade is one the engine challenges');
    const s = await b.say('Upgrade the hotel');
    const ch = agentTexts(s).pop();
    if (said) assert.ok(ch.startsWith('You told me the trip itself matters more than the room.'), ch);
    else { assert.doesNotMatch(ch, /You told me/, ch); assert.ok(ch.startsWith('Nothing you told me asks for a better room.'), ch); }
    // Their later word that the stay matters replaces it, said, and the engine no longer hears "don't care".
    if (said) {
      const s2 = await b.say('The room matters to us');
      assert.equal(s2.stayLow, false); assert.equal(s2.statedStay, true);
      assert.ok(agentTexts(s2).pop().startsWith('Got it: where you stay matters to you.'));
      assert.equal(agent.xctx(s2, await agent.settings()).o.stayLow, false);
    }
  }
});

test('over the maximum on the agent\'s cards: every version over it carries its amount (its priced total minus the ceiling) and is never the pick; the amount is said once; "go over" names that amount', async t => {
  const app = await startApp();
  t.after(app.close);
  const agent = app.agent, priced = pricer(app.ctx.tripService);
  const V = 'v-xagent-overmax-1';
  const b = await built(app, V);
  // A ceiling just above the trip, so the engines' versions land on both sides of it.
  await agent.withState(b.id, st => { st.budget = st.current.total + 4000; });
  let s = await agent.load(b.id);
  const cap = state.bookingBudget(s), total0 = s.current.total;
  assert.ok(cap > total0);
  let overRows = 0;
  const amountSaidOnce = (line, by) => assert.ok(line.split(`${money(by)} over your`).length <= 2, `the amount over is said once: ${line}`);
  for (const chip of ['Make $100 memorable', 'What if it rains?', 'Hotel or experience?', 'Location check', 'Make it more memorable', 'Better hotel']) {
    const from = s.messages.length;
    s = await b.say(chip);
    for (const m of s.messages.slice(from).filter(x => x.role === 'agent')) {
      const c = m.card || {};
      const rows = [...(c.items || []), ...(c.trades || []), ...[c.a, c.b].filter(x => x && !x.own)].filter(r => r.token && r.total !== null);
      for (const r of rows) {
        assert.equal(r.total, await priced(r.token), `${chip}: ${r.label}`);
        assert.equal(r.over, r.total > cap && r.total > total0, `${chip}: ${r.label} over is the ceiling's arithmetic`);
        assert.equal(r.overBy, r.over ? r.total - cap : 0, `${chip}: ${r.label} carries the amount over`);
        if (r.over) { overRows += 1; assert.ok(!r.pick, `${chip}: an over version is never the pick`); assert.notEqual(c.verdict, r.key, `${chip}: never the verdict`); amountSaidOnce(m.text, r.overBy); }
      }
      const p = c.proposal || (m === s.messages[s.messages.length - 1] ? s.proposal : null);
      if (p && p.over && p.total) { assert.equal(p.overBy, p.total - cap, `${chip}: the proposal's amount over`); amountSaidOnce(m.text, p.overBy); assert.ok(m.text.includes('go over'), `${chip}: the gate is said`); }
    }
    if (chip === 'What if it rains?' && s.proposal && s.proposal.over) {
      // The page's button names the amount over the ceiling, never the version's difference from the trip.
      const page = text(await (await fetch(`${app.base}/agent/${b.id}`, { headers: { cookie: `txv=${V}` } })).text());
      assert.ok(page.includes(`Go over by ${money(s.proposal.total - cap)}`), 'the button says the amount over');
      assert.ok(page.includes(`${money(s.proposal.total - cap)} over your ${money(cap)} ceiling`));
      if (s.proposal.delta !== s.proposal.total - cap) assert.ok(!page.includes(`Go over by ${money(s.proposal.delta)}`), 'never the difference from the trip as the amount over');
    }
    if (s.proposal || s.pending === 'options') s = await b.say('Keep what I have');
  }
  assert.ok(overRows >= 2, `the fixture puts versions over the ceiling (${overRows})`);
});

// GIVE ME ONE AMAZING THING is a new build around one experience: it may have fewer nights, another fare,
// hotel or dates. Every row its card shows (each loss, each other change) is said before "Take it", dates in
// words, and nothing is applied on the offer.
test('GIVE ME ONE AMAZING THING says every loss and every other change of its new build before "Take it", dates in words', async t => {
  const app = await startApp();
  t.after(app.close);
  let rows = 0;
  for (const [i, [budget, goals]] of [['$1,500', 'nightlife'], ['$2,500', 'culture and food'], ['$1,500', 'adventure'], ['$2,500', 'beach and food']].entries()) {
    const b = await built(app, `v-xagent-onebig-diff-${i}`, { budget, goals }), before = b.s.current.token;
    const s = await b.say('Give me one amazing thing'), p = s.proposal, said = agentTexts(s).pop();
    if (!p || p.kind !== 'onebig') continue;
    assert.equal(s.current.token, before, 'nothing applied on the offer');
    for (const row of [...p.improvements, ...p.tradeoffs, ...p.neutral]) assert.doesNotMatch(row, /\b\d{4}-\d\d-\d\d\b/, `${row}: dates in words`);
    for (const row of [...p.tradeoffs, ...p.neutral]) { rows++; assert.ok(said.includes(row) && said.indexOf(row) < said.lastIndexOf('Take it'), `"${row}" is said before "Take it": ${said}`); }
  }
  assert.ok(rows > 0, 'a build that changes the trip was exercised');
});

// A (the screenshot): "I already have concert tickets on November 10", the version that covers it taken, then "Plan my
// days" put the 7h catamaran on day 2, the concert day itself, with no conflict, and the final check passed it. The
// agent reads the engine's rhythm with the event: the event's date is the EVENT DAY, named as theirs, with no experience
// on it (its time is not known); the take line, THE RHYTHM, the conflict check and the final check all say so.
test('BUILD AROUND AN EVENT: the event\'s date is the rhythm\'s EVENT DAY, no experience on it, said when the dates are taken, in THE RHYTHM and at the final check', async t => {
  const clock = new Date('2026-10-07T09:00:00Z');
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService, V = 'v-xagent-evday-001';
  const b = await built(app, V);
  let s = await b.say('I already have concert tickets on November 10');
  assert.equal(s.proposal && s.proposal.kind, 'event', 'the dates that cover it are proposed');
  const date = s.event.date, on = longDate(date);
  s = await b.say('Take it');
  const trip = await svc.price(decodeSpec(s.current.token)), names = trip.activities.map(a => a.name);
  assert.equal(X.eventCollision(trip, s.event), null, 'fixture: the trip taken covers the concert');
  const evDay = X.rhythm(trip, s.goals, { event: s.event }).eventDay;
  assert.ok(evDay && evDay.full, 'fixture: the concert falls on a full day of the trip');
  const mine = `Your concert has day ${evDay.n} (${on}) to itself: no experience goes on it.`;
  const take = agentTexts(s).find(l => l.startsWith('Dates locked around your concert'));
  assert.ok(take && take.includes(mine), take);
  // THE RHYTHM: the event's date is the EVENT DAY, the concert named on it, no experience; the main one on another day.
  s = await b.say('Plan my days');
  const c = lastCard(s, 'rhythm'), said = agentTexts(s).pop(), row = c.days.find(d => d.date === date);
  assert.equal(row.label, 'Event day'); assert.equal(row.event, true); assert.ok(row.items.includes('Your concert'), JSON.stringify(row));
  assert.ok(!row.items.some(i => names.includes(i)), `no experience on the concert day: ${JSON.stringify(row)}`);
  for (const d of c.days.filter(x => x.date !== date)) assert.ok(!d.event && d.label !== 'Event day');
  assert.ok(said.includes(mine), said);
  const m = said.match(/ on day (\d+) \(([^)]+)\)/);
  if (m) assert.notEqual(m[2], on, `the main experience is never placed on the concert day: ${said}`);
  assert.ok(!said.includes(`on day ${evDay.n} (${on})`), said);
  const page = await (await fetch(`${app.base}/agent/${b.id}`, { headers: { cookie: `txv=${V}` } })).text();
  assert.match(page, new RegExp(`<li class="is-event" data-event="1"><span class="ag-way-num">${evDay.n}</span><div><b>Event day</b>`));
  // The conflict check: "No schedule conflict" only with the concert's day said as its own; never over a conflict.
  s = await b.say('Schedule conflicts');
  const chk = agentTexts(s).pop(), col = X.collisions(trip, { event: s.event, goals: s.goals });
  if (col.length) assert.doesNotMatch(chk, /No schedule conflict/, chk); else assert.ok(chk.includes(`No schedule conflict: every experience has a full day of its own, in season. ${mine}`), chk);
  // The final check reads the same rhythm: it passes only with the concert's day to itself, and says so.
  let n0 = (await agent.load(b.id)).messages.length;
  s = await b.say('Book it');
  for (let i = 0; i < 4 && s.proposal && s.proposal.kind !== 'final'; i += 1) { await b.say('Keep what I have'); s = await b.say('Book it'); }
  const fc = lastCard(s, 'final', n0);
  assert.ok(fc, 'the final check spoke');
  assert.ok(fc.reasons.some(r => r.ok && r.text === `Your concert on ${on} has its day to itself: no experience is on it`), JSON.stringify(fc.reasons));
  assert.equal(fc.ok, fc.reasons.every(r => r.ok));
});

// A, the other half: the event inside a trip whose full days are all taken pushes an experience off its only free day.
// That is a SCHEDULE CONFLICT named with the event (never "No schedule conflict"), the rhythm keeps the event's day
// clear, and the final check at "book it" does not pass the trip.
test('an event inside the trip that leaves an experience no free day is a SCHEDULE CONFLICT naming the event; the final check does not pass it', async t => {
  const clock = new Date('2026-10-07T09:00:00Z');
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService;
  const b = await built(app, 'v-xagent-evday-002');
  const t0 = await svc.price(decodeSpec(b.s.current.token)), gs = b.s.goals;
  // The fixture: the same trip at a length whose full days the experiences fill, and a full day for the event.
  let fx = null;
  for (let n = 2; n <= 8 && !fx; n += 1) {
    const v = await svc.price({ ...t0.spec, nights: n });
    if (!v || X.rhythm(v, gs).unplaced.length) continue;
    for (const d of X.rhythm(v, gs).days.filter(x => x.full)) { const ev = { name: 'your concert', date: d.date, slot: null }; if (!X.eventCollision(v, ev) && X.rhythm(v, gs, { event: ev }).unplaced.length) { fx = { v, ev }; break; } }
  }
  assert.ok(fx, 'fixture: a length whose full days the experiences fill');
  const off = X.rhythm(fx.v, gs, { event: fx.ev }).unplaced.map(a => a.name), on = longDate(fx.ev.date);
  await agent.withState(b.id, st => { st.current = { token: encodeSpec(fx.v.spec), total: fx.v.total, since: agent.now().toISOString() }; st.proposal = null; st.pending = null; });
  let s = await b.say(`I already have concert tickets on ${spoken(fx.ev.date)}`);
  const inside = agentTexts(s).pop();
  assert.ok(inside.includes('is inside your trip') && inside.includes(`(${on}) to itself: no experience goes on it.`), inside);
  for (const name of off) assert.ok(inside.includes(`SCHEDULE CONFLICT: ${name} fits no free full day: ${on} is the day of your concert`), inside);
  s = await b.say('Schedule conflicts');
  const chk = agentTexts(s).pop();
  assert.doesNotMatch(chk, /No schedule conflict/, chk);
  assert.ok(off.every(name => chk.includes(`SCHEDULE CONFLICT: ${name} fits no free full day: ${on} is the day of your concert`)), chk);
  s = await b.say('Plan my days');
  const c = lastCard(s, 'rhythm'), row = c.days.find(d => d.date === fx.ev.date);
  assert.equal(row.label, 'Event day'); assert.ok(!row.items.some(i => fx.v.activities.some(a => a.name === i)), JSON.stringify(row));
  assert.ok(c.conflicts.length && c.conflicts.some(k => k.text.includes('is the day of your concert')), JSON.stringify(c.conflicts));
  const n0 = (await agent.load(b.id)).messages.length;
  s = await b.say('Book it');
  for (let i = 0; i < 4 && s.proposal && s.proposal.kind !== 'final'; i += 1) { await b.say('Keep what I have'); s = await b.say('Book it'); }
  const fc = lastCard(s, 'final', n0);
  assert.ok(fc && fc.ok === false, `the final check does not pass a trip whose experience the concert pushes off: ${JSON.stringify(fc)}`);
  assert.ok(!fc.reasons.some(r => r.ok && r.text === 'No schedule conflict'), JSON.stringify(fc.reasons));
  assert.ok(fc.reasons.some(r => !r.ok && r.text.includes('is the day of your concert')), JSON.stringify(fc.reasons));
  if (s.proposal && s.proposal.kind === 'final') {
    const v = await svc.price(decodeSpec(s.proposal.token));
    assert.equal(s.proposal.total, v.total, 'the rebuild is a priced total');
    assert.equal(X.rhythm(v, gs, { event: fx.ev }).unplaced.length, 0, 'the rebuild gives every experience it keeps a day off the concert');
  }
  // A short experience may share the event's day only when the event's time is known and the two sit at its two ends;
  // the agent says it as that, never "to itself".
  const d = { n: 3, date: fx.ev.date }, shared = agent.eventDayWords({ eventDay: d, event: { name: 'your concert', date: fx.ev.date, slot: 'evening' }, placed: [{ day: d, activity: { name: 'Sunrise kayak', hours: 2, slot: 'morning' } }] });
  assert.equal(shared, `Your concert has day 3 (${on}); only Sunrise kayak (2h, morning) shares it, at the other end of the day from its evening time, so the two cannot overlap.`);
});

// E: the mission panel sets the protected name off from its sentence and quotes every word to say one way (curly
// double quotes), the rules list included; who protected it is said truthfully.
test('the mission panel: the protected name is set off from its sentence, and every word to say is in the same curly quotes', async t => {
  const app = await startApp();
  t.after(app.close);
  const V = 'v-xagent-panel-001', b = await built(app, V), name = b.s.mainName;
  assert.ok(name && b.s.protectAuto, 'fixture: the results protected the main experience');
  // The page's text as a reader sees it: text() puts a space where each tag was, so " :" is the name's own "</b>:".
  const panel = async () => { const h = text(await (await fetch(`${app.base}/agent/${b.id}`, { headers: { cookie: `txv=${V}` } })).text()).replace(/ :/g, ':'); const at = h.indexOf('Your mission'); return h.slice(at, h.indexOf('I never relax a hard rule on my own.', at) + 40); };
  let p = await panel();
  assert.ok(p.includes(`MAIN EXPERIENCE 🔒 PROTECTED ${name}: I protected it from the results; no version I offer drops it unless you say “drop ${name}”; say “unprotect” to free it.`), p);
  assert.ok(p.includes(`Main experience: ${name} (protected by me from the results; say “unprotect” to free it)`), p);
  assert.ok(!p.includes('"') && !/'[a-z][^']*'/i.test(p), `one kind of quote in the panel: ${p}`);
  await b.say(`Protect ${name}`);
  p = await panel();
  assert.ok(p.includes(`MAIN EXPERIENCE 🔒 PROTECTED ${name}: protected, as you asked; no version I offer drops it unless you say “drop ${name}”; say “unprotect” to free it.`), p);
  assert.ok(!p.includes('"') && !/'[a-z][^']*'/i.test(p), p);
});

// G: the locks set with the agent ride on every canvas link (locked=hotel,flight), so the Memories page opened from the
// canvas offers no version that changes the hotel or the flights the traveler locked; the review link carries them too.
test('the canvas links carry the agent\'s locks: the Memories page from the canvas never offers a version across a hotel or flight lock', async t => {
  const clock = new Date('2026-10-07T09:00:00Z');
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, V = 'v-xagent-locks-001', b = await built(app, V);
  await b.say('Lock the hotel');
  let s = await b.say('Lock the flights');
  assert.ok(s.locks.hotel && s.locks.flight, 'fixture: both locked');
  const cur = decodeSpec(s.current.token), dec = h => h.replace(/&amp;/g, '&');
  const html = dec(await (await fetch(`${app.base}/agent/${b.id}`, { headers: { cookie: `txv=${V}` } })).text());
  const links = [...html.matchAll(/href="(\/trip\/[^"?#]+(?:\/memories)?\?[^"#]*)/g)].map(x => x[1]).filter(l => l.startsWith(`/trip/${s.current.token}`));
  assert.ok(links.some(l => l.includes('/memories?')) && links.length >= 3, `the canvas links: ${links.join(' | ')}`);
  for (const l of links) assert.deepEqual(optimizer.parseContext(Object.fromEntries(new URLSearchParams(l.split('?')[1]))).locks, { hotel: true, flight: true }, l);
  // The page from the link holds them; the same page without them offers versions that move them (so the lock matters).
  const mem = links.find(l => l.includes('/memories?'));
  const versions = async href => [...new Set([...dec(await (await fetch(app.base + href)).text()).matchAll(/href="\/trip\/([^"?/#]+)/g)].map(x => x[1]))].map(k => { try { return decodeSpec(k); } catch (e) { return null; } }).filter(Boolean);
  const moved = xs => xs.filter(v => v.hotel !== cur.hotel || v.flight !== cur.flight);
  assert.deepEqual(moved(await versions(mem)).map(encodeSpec), [], 'no version across the hotel or flight lock');
  assert.ok(moved(await versions(mem.replace(/&locked=[^&]*/, ''))).length > 0, 'fixture: without the locks the page offers versions that move them');
  // The context the agent builds: only lock names a page can hold, from the effective locks (a fixed date is the dates).
  const st = await agent.load(b.id);
  const P = new URLSearchParams(optimizer.contextParams(state.memoriesContext(st, state.budgetContext(st, state.toQuery(st, { maps }).query), null)));
  assert.equal(P.get('locked'), 'hotel,flight');
  const fixed = { ...st, dateMode: 'exact', depart: cur.depart, locks: { ...st.locks, hotel: false, flight: false } };
  assert.equal(new URLSearchParams(optimizer.contextParams(state.budgetContext(fixed, state.toQuery(fixed, { maps }).query))).get('locked'), 'dates', 'budget and the protected experience are never lock names on a link');
});

// The event the traveler built the trip around rides on every canvas link (ev=, evn=, and evt= when they said a time): no
// URL parameter carried it, so the Memories page opened from the canvas drew THE RHYTHM without the EVENT DAY and put the
// main experience on the concert's day. Now the page draws the day the agent draws, says the agent's sentence about it,
// every link it builds carries the event on, and the review page's FINAL EXPERIENCE CHECK lists the agent's own reasons.
test('the canvas links carry the event: the Memories page draws the EVENT DAY with no experience on it, and the review page\'s final check is the agent\'s', async t => {
  const clock = new Date('2026-10-07T09:00:00Z');
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService, V = 'v-xagent-evlink-001', dec = h => h.replace(/&amp;/g, '&');
  const b = await built(app, V);
  await b.say('I already have concert tickets on November 10');
  let s = await b.say('Take it');
  const ev = s.event, on = longDate(ev.date);
  const trip = await svc.price(decodeSpec(s.current.token)), names = trip.activities.map(a => a.name);
  const evDay = X.rhythm(trip, s.goals, { event: ev }).eventDay;
  assert.ok(evDay && !X.eventCollision(trip, ev), 'fixture: the dates taken cover the concert, on a full day of the trip');
  // Every canvas link to this trip carries the event, as the agent holds it (no time said, so no slot).
  const html = dec(await (await fetch(`${app.base}/agent/${b.id}`, { headers: { cookie: `txv=${V}` } })).text());
  const links = [...html.matchAll(/href="(\/trip\/[^"?#]+(?:\/memories)?\?[^"#]*)/g)].map(x => x[1]).filter(l => l.startsWith(`/trip/${s.current.token}`));
  assert.ok(links.some(l => l.includes('/memories?')) && links.length >= 3, links.join(' | '));
  for (const l of links) assert.deepEqual(optimizer.parseContext(Object.fromEntries(new URLSearchParams(l.split('?')[1]))).event, { name: 'your concert', date: ev.date, slot: null }, l);
  const P = new URLSearchParams(optimizer.contextParams(state.memoriesContext(s, state.budgetContext(s, state.toQuery(s, { maps }).query), trip)));
  assert.equal(P.get('ev'), ev.date); assert.equal(P.get('evn'), 'your concert'); assert.equal(P.get('evt'), null, 'a time never said is never carried');
  // The Memories page from the canvas: the concert's day is the EVENT DAY, the concert named on it, no experience on it.
  const mem = links.find(l => l.includes('/memories?'));
  const rows = page => [...page.matchAll(/<li class="([^"]*)" data-day="(\d+)" data-label="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g)].map(m => ({ cls: m[1].split(' '), n: Number(m[2]), label: m[3], text: text(m[4]) }));
  const page = dec(await (await fetch(app.base + mem)).text()), days = rows(page), row = days.find(d => d.n === evDay.n);
  assert.equal(row.label, 'Event day'); assert.ok(row.cls.includes('is-event') && row.text.includes('Your concert'), JSON.stringify(row));
  assert.ok(!names.some(n => row.text.includes(n)), `no experience on the concert's day: ${JSON.stringify(row)}`);
  assert.deepEqual(days.filter(d => d.cls.includes('is-event') || d.label === 'Event day').map(d => d.n), [evDay.n], 'one event day');
  assert.ok(text(page).includes(`Your concert has day ${evDay.n} (${on}) to itself: no experience goes on it.`), 'the agent\'s sentence about the day');
  for (const [, l] of page.matchAll(/href="(\/trip\/[^"#]+)/g)) assert.equal(new URLSearchParams(l.split('?')[1] || '').get('ev'), ev.date, `every link on the page carries the event on: ${l}`);
  // Without the event the same page puts an experience on the concert's day: the parameter is what keeps the day free.
  const bare = rows(dec(await (await fetch(app.base + mem.replace(/&ev(?:t|n)?=[^&]*/g, ''))).text())).find(d => d.n === evDay.n);
  assert.ok(names.some(n => bare.text.includes(n)), `fixture: without the event an experience lands on ${on}: ${JSON.stringify(bare)}`);
  // The review page opened with the canvas's context reads the same event: its FINAL EXPERIENCE CHECK is the agent's.
  let n0 = (await agent.load(b.id)).messages.length;
  s = await b.say('Book it');
  for (let i = 0; i < 4 && s.proposal && s.proposal.kind !== 'final'; i += 1) { await b.say('Keep what I have'); n0 = (await agent.load(b.id)).messages.length; s = await b.say('Book it'); }
  const fc = lastCard(s, 'final', n0);
  assert.ok(fc && fc.reasons.some(r => r.text.includes(on)), `the agent's final check reads the concert: ${JSON.stringify(fc)}`);
  const contract = s.messages.slice(n0).map(m => m.card && m.card.href).filter(h => h && h.includes('/review?'));
  for (const h of contract) assert.equal(new URLSearchParams(h.split('?')[1]).get('ev'), ev.date, `the contract's review link carries the event: ${h}`);
  const full = links.find(l => !l.includes('/memories?') && !l.includes('#'));
  const rv = dec(await (await fetch(`${app.base}/trip/${s.current.token}/review?${full.split('?')[1]}&seen=${s.current.total}`)).text());
  const at = rv.indexOf('id="final-check"'), fcs = rv.slice(at, rv.indexOf('</section>', at));
  assert.ok(at >= 0, 'the review page has the final check');
  assert.deepEqual([...fcs.matchAll(/<li class="([^"]*)">[\s\S]*?<span>([\s\S]*?)<\/span><\/li>/g)].map(m => ({ ok: m[1] !== 'is-miss', text: text(m[2]).trim() })), fc.reasons.map(r => ({ ok: r.ok, text: r.text })), 'the review page lists the agent\'s reasons, the concert\'s day among them');
});

// "Only show statuses that reflect actual system state": the mission status read "2 ways built, waiting for which feels like
// you" after the traveler took the version that covers their concert, or the rebuild the final check proposed, because only
// picking a result set the mission's signal. A version taken on their word is their choice; the status says what is on the
// canvas now (the version's label and the canvas's own total), and a new set of results waits for a pick again.
test('the mission status follows what the traveler did: a version they took is their choice, said with what is on the canvas, never "waiting for which feels like you"', async t => {
  const clock = new Date('2026-10-07T09:00:00Z');
  const app = await startApp({}, { now: () => clock });
  t.after(app.close);
  const agent = app.agent, svc = app.ctx.tripService;
  const statusOf = async (id, v) => text(((await (await fetch(`${app.base}/agent/${id}`, { headers: { cookie: `txv=${v}` } })).text()).match(/<span class="ag-mission-status[^"]*">([\s\S]*?)<\/span>/) || [])[1] || '').trim();
  const V = 'v-xagent-status-001', b = await built(app, V);
  assert.match(await statusOf(b.id, V), /^\d+ ways? built, waiting for which feels like you$/, 'fixture: the results wait for a pick');
  let s = await b.say('I already have concert tickets on November 10');
  assert.equal(s.proposal && s.proposal.kind, 'event', 'fixture: the dates that cover it are proposed');
  const p = s.proposal;
  assert.equal(await statusOf(b.id, V), 'One decision away');
  s = await b.say('Take it');
  assert.equal(s.current.token, p.token, 'the version was taken');
  const took = (await svc.price(decodeSpec(s.current.token))).total;
  assert.equal(await statusOf(b.id, V), `Your choice is on the canvas: ${p.label} · ${money(took)}`);
  // "Take the rebuild": the trip without its experiences fails the final check; the rebuild taken is what the status says.
  const V2 = 'v-xagent-status-002', c = await built(app, V2, { goals: 'adventure' });
  const bare = await svc.price({ ...decodeSpec(c.s.current.token), activities: [] });
  await agent.withState(c.id, st => { st.current = { token: encodeSpec(bare.spec), total: bare.total, since: agent.now().toISOString() }; st.proposal = null; st.pending = null; st.locks.experience = false; st.mainExperience = null; st.mainName = null; });
  let found = null;
  for (let i = 0; i < 4 && !found; i += 1) { s = await c.say('Book it'); if (s.proposal && s.proposal.kind === 'final') found = s.proposal; else if (s.proposal) await c.say('Keep what I have'); }
  assert.ok(found, 'fixture: the rebuild is proposed');
  assert.equal(await statusOf(c.id, V2), 'One decision away', 'the rebuild waits for the traveler\'s word');
  s = await c.say('Take the rebuild');
  assert.equal(s.current.token, found.token, 'the rebuild was taken');
  assert.equal(await statusOf(c.id, V2), `Your choice is on the canvas: ${found.label} · ${money((await svc.price(decodeSpec(found.token))).total)}`);
  // A new set of results is a new question: the status waits for a pick again, never names the version taken before it.
  await agent.withState(c.id, st => { st.mission.round += 1; });
  assert.match(await statusOf(c.id, V2), /^\d+ ways? built, waiting for which feels like you$/);
});

// The MAIN EXPERIENCE 🔒 PROTECTED line: the protected name was bold at the panel's 16px inside a 14px sentence, so the
// first line stood taller than the rest. The size is now set once, on the paragraph, and the name is bold at it; the
// Playwright probe at 1280 and 390 measures every line box of the paragraph at the same height.
test('the mission panel\'s protected line: the name is bold at its sentence\'s own size, set once on the paragraph', async t => {
  const app = await startApp();
  t.after(app.close);
  const V = 'v-xagent-panel-002', b = await built(app, V), name = b.s.mainName;
  assert.ok(name, 'fixture: the results protected the main experience');
  const h = await (await fetch(`${app.base}/agent/${b.id}`, { headers: { cookie: `txv=${V}` } })).text();
  const box = (h.match(/<div class="ag-protected">[\s\S]*?<\/div>/) || [''])[0];
  const line = box.match(/<p class="([^"]*)"><b>([^<]*)<\/b>: <span class="([^"]*)">/);
  assert.ok(line, box);
  assert.ok(line[1].split(' ').includes('tb-small') && line[1].split(' ').includes('ag-protected-line'), `the size is the paragraph's: ${line[1]}`);
  assert.equal(text(line[2]).trim(), name);
  assert.ok(!line[3].split(' ').includes('tb-small'), `the sentence is never set smaller than the name inside it: ${line[3]}`);
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/trips.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.ag-protected-line, \.ag-protected-line b \{ font-size: 14px; line-height: 1\.5; \}/, 'one size and one line height for the name and its sentence');
  assert.doesNotMatch(css, /\.ag-protected[^{,]*\bb\b[^{,]*\{[^}]*font-size: (?!14px)/, 'no rule sets the name at another size');
});
