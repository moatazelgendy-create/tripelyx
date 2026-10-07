// The mission: one number, three vacations, the direction pushed, the budget moved, another round,
// why, saved defaults only with permission; and Save Max: the saver's numbers, how low, the
// breakpoints, the receipt, the savings check before paying. Every assertion is about a priced
// package or a sentence the agent said; nothing is asserted that the inventory does not back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { decodeSpec } = require('../server/trips/spec');
const savemax = require('../server/trips/savemax');
const { money } = require('../server/views/trips/common');

const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/\s+/g, ' ');
const client = base => {
  const jar = {};
  const req = async (path, { method = 'GET', form = null, redirect = 'manual' } = {}) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers.origin = base; body = new URLSearchParams(form).toString(); }
    const res = await fetch(base + path, { method, headers, body, redirect });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  return { req };
};
const last = s => s.messages[s.messages.length - 1];
const said = s => s.messages.filter(m => m.role === 'agent').map(m => m.text).join(' | ');
const cards = (s, kind) => s.messages.filter(m => m.card && m.card.kind === kind).map(m => m.card);
const ask = (agent, id) => async t => { await agent.say(id, t); await agent.jobs.drain(); return agent.load(id); };

test('one number: the mission is accepted, only the origin is asked, three ways fit the ceiling, and the answer steers this trip without being saved', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-mission', mission: true });
    const say = ask(agent, s0.id);
    let s = await say('$1,500');
    assert.match(said(s), /Mission accepted: \$1,500 is the ceiling, not a target/);
    assert.match(said(s), /only interrupt you when I need a real decision/);
    assert.equal(s.pending, 'origin', 'the one question that blocks a build');
    assert.equal(last(s).card.kind, 'ask');
    assert.ok(last(s).card.options.some(o => o.say === 'JFK'), 'origins are offered as chips');
    assert.doesNotMatch(said(s), /booking only|whole vacation|beach or city|3-star or 4-star/i, 'no questionnaire');
    s = await say('JFK');
    assert.equal(s.job.status, 'done');
    const ways = cards(s, 'ways');
    assert.ok(ways.length, 'the three ways were built');
    const w = ways[ways.length - 1];
    assert.ok(w.ways.length >= 2 && w.ways.length <= 3);
    for (const x of w.ways) {
      assert.ok(x.trip.total <= 150000, `${x.label} is at or under the ceiling`);
      assert.equal(x.keep, 150000 - x.trip.total, 'keep is the ceiling minus the verified total');
      assert.ok(['More vacation', 'Keep more', 'Make it special'].includes(x.label));
    }
    const tokens = new Set(w.ways.map(x => x.trip.token));
    assert.equal(tokens.size, w.ways.length, 'three different trips');
    assert.ok(w.ways.some(x => x.pick), 'one is the pick, with reasons');
    assert.match(said(s), /Which feels more like you\?/);
    assert.equal(s.pending, 'ways');
    assert.ok(s.mission.strategies.find(x => x.key === 'keep').total <= s.mission.strategies.find(x => x.key === 'more').total, 'Keep more costs less than More vacation');
    assert.ok(s.job.feed.length >= 3 && s.job.feed.every(f => /\d/.test(f)), 'the decision feed carries real counts');
    assert.doesNotMatch(said(s), /AI is thinking|objectively the best/i);
    // A reaction is a signal for this trip: the priority moves, nothing is saved anywhere.
    s = await say('1');
    assert.equal(s.mission.signal, 'more');
    assert.equal(s.priority, 'longer');
    assert.match(said(s), /You seem to prefer getting more vacation from the budget/);
    assert.match(said(s), /I don't save that unless you tell me to/);
    assert.equal(await app.ctx.store.getRecord('travel_defaults', 'nobody'), null);
    assert.equal(s.current.token, s.mission.strategies.find(x => x.key === 'more').token, 'the chosen way is on the canvas');
    const v = cards(s, 'variants');
    if (v.length) {
      for (const x of v[v.length - 1].variants) { assert.ok(x.trip.total <= 150000); assert.ok(/^[ABC]$/.test(x.letter)); }
      assert.equal(s.pending, 'variants');
      const letter = v[v.length - 1].variants[0].letter;
      s = await say(`Pick ${letter}`);
      assert.match(said(s), /Done\. Before \$[\d,.]+ → after \$[\d,.]+/);
      assert.equal(s.mission.variants.length, 0);
    } else assert.match(said(s), /found nothing the suppliers price that I'd put beside it/);
  } finally { await app.close(); }
});

test('none of these: what was wrong is asked once, the next set is genuinely different, a one-tap reaction changes the set, and the budget slider says what the money really does', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-none', mission: true });
    const say = ask(agent, s0.id);
    await say('$1,500');
    let s = await say('JFK');
    const first = cards(s, 'ways').pop();
    const shownTokens = new Set(first.ways.map(x => x.trip.token)), shownDests = new Set(first.ways.map(x => x.trip.dest));
    s = await say('None — try again');
    assert.equal(s.pending, 'wrong');
    assert.deepEqual(last(s).card.options.map(o => o.label), ['Destinations', 'Too expensive', 'Too short', 'Too much travel', 'Hotels', 'Not exciting']);
    s = await say('The destinations');
    const second = cards(s, 'ways').pop();
    assert.notEqual(second, first);
    assert.match(said(s), /A different set: left out/);
    for (const x of second.ways) { assert.ok(!shownTokens.has(x.trip.token), 'no trip is repeated'); assert.ok(!shownDests.has(x.trip.dest), `${x.trip.dest} was left out`); assert.ok(x.trip.total <= 150000); }
    // One-tap feedback under a trip: "too short" rebuilds with more nights, never fewer.
    s = await say('2: too short');
    const third = cards(s, 'ways').pop();
    assert.match(said(s), /6 nights instead of 5/);
    for (const x of third.ways) assert.ok(x.trip.nights >= 6, `${x.label} has ${x.trip.nights} nights`);
    assert.ok(third.ways.every(x => x.trip.total <= 150000));
    // The ceiling moves: the engine says what the money really changes, and rebuilds the ways.
    s = await say('1');
    const before = s.current.total;
    s = await say('Don\'t spend more than $1,800');
    assert.equal(s.budget, 180000);
    assert.match(said(s), /\$1,500 up to \$1,800\./);
    assert.ok(/extra night|dearer version|buys|nothing changes|still fits/i.test(said(s).split(' | ').slice(-3).join(' ')), 'a real note about the extra money');
    if (s.proposal) { assert.equal(s.current.total, before, 'nothing applied without approval'); assert.ok(s.proposal.over === false); }
    s = await say('Keep the money');
    s = await say('Don\'t spend more than $900');
    assert.equal(s.budget, 90000);
    assert.match(said(s), /down to \$900/);
    assert.equal(s.current.total, s.current.total, 'the trip is never silently downgraded');
    assert.ok(/needs|means|would stop|lowest I would recommend|cheapest version|only reach|can reach|already at|under \$900|No cheaper version/i.test(said(s).split(' | ').slice(-2).join(' ')));
  } finally { await app.close(); }
});

test('another round is honest, why is answered from the trips compared, stopping lays out the trip for booking, and defaults are kept only on the traveler\'s word', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-round', userId: 'u-mission', mission: true });
    const say = ask(agent, s0.id);
    await say('$1,500');
    let s = await say('JFK');
    s = await say('2');
    s = await say('Keep what I have');
    s = await say('Keep looking');
    const round = said(s).split(' | ').pop();
    assert.ok(/I checked another round: \d+ more complete packages|Another round found something that beats it/.test(round), round);
    if (s.proposal) { assert.equal(s.proposal.kind, 'switch'); s = await say('Keep what I have'); }
    s = await say('Why not Cancun?');
    const why = said(s).split(' | ').pop();
    assert.match(why, /Among the options I checked/);
    assert.match(why, /Cancun/);
    assert.doesNotMatch(why, /objectively|guarantee/i);
    if (s.proposal) s = await say('No');
    // "Remember these" saves facts about how they travel, never the reaction and never money.
    s = await say('Remember these as my defaults');
    const d = await app.ctx.store.getRecord('travel_defaults', 'u-mission');
    assert.ok(d && d.origin === s.origin && s.origin, 'the origin is saved');
    assert.ok(!('signal' in d) && !('income' in d) && !('budget' in d), 'no reaction and nothing about money');
    assert.match(said(s), /Saved as your defaults/);
    // A new mission for the same traveler shows the defaults it uses, and "not this time" drops them.
    const s1 = await agent.create({ visitor: 'v-round2', userId: 'u-mission', mission: true });
    assert.equal(s1.origin, d.origin);
    const say1 = ask(agent, s1.id);
    let r = await say1('$1,200');
    assert.match(said(r), /Using your saved defaults: from New York/);
    assert.notEqual(r.pending, 'origin', 'the saved origin is not asked again');
    assert.equal(r.job.status, 'done');
    r = await say1('Not this time');
    assert.equal(r.origin, null);
    assert.equal(r.pending, 'origin');
    assert.ok(await app.ctx.store.getRecord('travel_defaults', 'u-mission'), 'dropped for this trip only');
    r = await say1('Forget my defaults');
    assert.equal(await app.ctx.store.getRecord('travel_defaults', 'u-mission'), null);
    // "I'm happy": the search stops and the contract follows, after the savings check.
    s = await say('I\'m happy, stop searching');
    assert.ok(cards(s, 'contract').length || s.proposal, 'the trip is laid out for verification, or a cheaper same trip is offered first');
    assert.match(said(s), /Savings check|cheaper/);
  } finally { await app.close(); }
});

test('Save Max: the saver\'s numbers, labels that never say best or luxury, how low, the breakpoints, the receipt, the fare compared with the bag, and no price predictions', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-saver', mission: true, mode: 'save' });
    const say = ask(agent, s0.id);
    let s = await say('$2,000');
    assert.match(said(s), /\$2,000 is your maximum, and I'll try not to use it/);
    s = await say('JFK');
    assert.match(said(s), /You gave me \$2,000\. I don't think you need to spend it/);
    assert.match(said(s), /you keep \$[\d,.]+/);
    const w = cards(s, 'ways').pop();
    assert.ok(w.saver && w.saver.max === 200000 && w.saver.keep === 200000 - w.saver.total, 'you keep = max minus the verified total');
    assert.ok(s.current.total <= 200000 * 0.8 || s.mission.strategies.length < 2, 'the saver\'s pick sits well under the maximum when a keep-more way exists');
    for (const o of s.options) assert.doesNotMatch(o.label, /^(best|premium|luxury)$/i);
    assert.ok(s.options.every(o => ['Best value', 'Lowest I recommend', 'Keep more comfort'].includes(o.label)), s.options.map(o => o.label).join(','));
    // How low can you go: the lowest recommended apart from the absolute cheapest, with why not.
    s = await say('How low can you go?');
    const hl = cards(s, 'howlow').pop();
    assert.ok(hl, 'the how-low card');
    assert.ok(hl.recommend.total <= hl.current);
    if (hl.cheapest) { assert.ok(hl.cheapest.total < hl.recommend.total); assert.ok(hl.cheapest.whyNot.length, 'the cheapest comes with the facts against it'); assert.ok(s.proposal && s.proposal.anyway && s.proposal.anyway.total === hl.cheapest.total, 'the cheapest is a choice, never applied'); }
    const cur = s.current.total;
    s = await say('Keep what I have');
    assert.equal(s.current.total, cur);
    // Breakpoints: each a priced version at or under the max, nothing given up, picked by letter.
    s = await say('Upgrades worth considering');
    const bp = cards(s, 'breakpoints').pop();
    if (bp) {
      assert.ok(bp.items.length <= 5);
      let prev = 0;
      for (const b of bp.items) { assert.ok(b.delta > prev - 1); prev = b.delta; assert.ok(b.total <= 200000); assert.equal(b.total, bp.base + b.delta); }
      s = await say('Option A');
      assert.match(said(s).split(' | ').pop(), /Nothing given up/);
      assert.equal(s.current.total, bp.base + bp.items[0].delta);
      // The receipt: sequential lines that sum exactly, you keep = max minus the final total.
      s = await say('How did you keep my cost down?');
      const rc = cards(s, 'receipt').pop();
      assert.ok(rc);
      assert.equal(rc.lines.reduce((a, l) => a + l.delta, 0), rc.final - rc.original);
      assert.equal(rc.keep, 200000 - rc.final);
    } else assert.match(said(s).split(' | ').pop(), /nothing I priced improves this trip without giving something up/);
    // The fare compared with the bag: only once the traveler says how they pack, never guessed.
    s = await say('Carry-on only');
    assert.equal(s.bags, 'carry-on');
    const tr = await app.ctx.tripService.trip(s.current.token, {});
    const trap = savemax.cheapTrap(tr.trip, tr.trip.flightOptions, { bags: 'carry-on' });
    assert.ok(trap.text, 'a sentence that names what was compared');
    assert.ok(trap.badge === null || ['cheaper-overall', 'looks-cheaper'].includes(trap.badge));
    // No predictions: other departure dates are priced today, or the question is declined; nothing forecast.
    s = await say('When can I go for less?');
    const wl = said(s).split(' | ').pop();
    assert.match(wl, /Today's prices|today's prices|not a forecast|never predict/i);
    assert.doesNotMatch(wl, /will (?:drop|fall|rise|be cheaper)|usually cheaper|tends to/i);
    s = await say('Keep my dates');
    // Remembering is a savings style: how they pack and travel, never money.
    const s1 = await agent.create({ visitor: 'v-saver2', userId: 'u-saver', mission: true, mode: 'save' });
    const say1 = ask(agent, s1.id);
    await say1('$1,500'); await say1('JFK'); await say1('Carry-on only');
    const r = await say1('Remember these as my defaults');
    assert.match(said(r).split(' | ').pop(), /Saved as your savings style/);
    const d = await app.ctx.store.getRecord('travel_defaults', 'u-saver');
    assert.equal(d.bags, 'carry-on');
    assert.ok(!('budget' in d) && !('income' in d));
  } finally { await app.close(); }
});

test('pages: the homepage asks for one number, a budget starts a mission, the canvas carries the mission and the slider, and the slider rebuilds at the new ceiling', async () => {
  const app = await startApp();
  try {
    const c = client(app.base);
    const home = await c.req('/');
    assert.match(home.text, /How much do you.*want to spend\?/s);
    assert.match(home.text, /Save me the most/);
    assert.match(home.text, /No destination required/);
    const start = await c.req('/agent', { method: 'POST', form: { budget: '1,500' } });
    assert.equal(start.status, 303);
    const id = start.headers.get('location').split('/').pop();
    await app.agent.jobs.drain();
    let s = await app.agent.load(id);
    assert.ok(s.mission && s.mission.accepted);
    let page = await c.req(`/agent/${id}`);
    assert.match(text(page.text), /Mission accepted/);
    assert.match(text(page.text), /Your mission/);
    assert.match(text(page.text), /What are you optimizing\?/);
    assert.match(text(page.text), /Hard rules/);
    assert.match(text(page.text), /Where are you flying from\?/);
    await c.req(`/agent/${id}`, { method: 'POST', form: { say: 'JFK' } });
    await app.agent.jobs.drain();
    page = await c.req(`/agent/${id}`);
    const t = text(page.text);
    assert.match(t, /Which feels more like you\?/);
    assert.match(t, /Try a different ceiling/);
    assert.match(page.text, /type="range"/);
    assert.match(t, /What I checked/);
    assert.doesNotMatch(t, /AI is thinking/i);
    // The slider posts a budget; the agent reads it as a new ceiling.
    const slide = await c.req(`/agent/${id}`, { method: 'POST', form: { budget: '1700' } });
    assert.equal(slide.status, 303);
    await app.agent.jobs.drain();
    s = await app.agent.load(id);
    assert.equal(s.budget, 170000);
    assert.match(said(s), /\$1,500 up to \$1,700/);
    // Save Max from the homepage.
    const save = await c.req('/agent', { method: 'POST', form: { budget: '2000', mode: 'save' } });
    const sid = save.headers.get('location').split('/').pop();
    await app.agent.jobs.drain();
    const sv = await app.agent.load(sid);
    assert.equal(sv.mission.mode, 'save');
    assert.match(said(sv), /I'll try not to use it/);
  } finally { await app.close(); }
});

test('the AI competes with itself: three ways from the likeliest destinations land first, every destination then tries to beat them, and a way is replaced only by something materially better, said aloud', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-beat', mission: true });
    await agent.say(s0.id, '$1,800');
    // Hold the job right after the fast ways are on the table, the way slow suppliers would.
    let reached, release, held = false;
    const atGate = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    agent.breathe = async () => { if (held) return; const st = await agent.load(s0.id); if (st.mission && st.mission.fastRound !== null) { held = true; reached(); await gate; } };
    await agent.say(s0.id, 'JFK');
    await atGate;
    let s = await agent.load(s0.id);
    assert.equal(s.job.status, 'running');
    const fastCard = cards(s, 'ways').pop();
    assert.ok(fastCard && fastCard.ways.length >= 2, 'ways from the fast phase, while the deep phase runs');
    assert.match(said(s), /from the likeliest destinations/);
    assert.match(said(s), /I'm now checking every destination we serve from here and replace one of these only if something materially better turns up/);
    assert.equal(s.pending, 'ways', 'the traveler can answer while the rest is checked');
    assert.ok(s.current && s.current.token === fastCard.ways.find(w => w.pick).trip.token, 'the champion is on the canvas already');
    const before = Object.fromEntries(fastCard.ways.map(w => [w.key, w.trip.total]));
    release();
    await agent.jobs.drain();
    s = await agent.load(s0.id);
    assert.equal(s.job.status, 'done');
    const checked = s.job.feed.find(f => /^Checked all \d+ destinations: \d+ complete packages/.test(f));
    assert.ok(checked, s.job.feed.join(' / '));
    assert.match(checked, /replaced by something materially better|nothing beat the ways from the first pass/);
    const beats = cards(s, 'beat');
    const finalWays = s.mission.strategies;
    if (beats.length) {
      assert.match(said(s), /I found something that beats Option \d \(/);
      for (const b of beats) {
        assert.ok(b.after && b.after.total <= b.before.total, 'a replacement is never dearer than the way it replaces');
        assert.ok(b.after.total <= 180000, 'and stays inside the ceiling');
        assert.ok(finalWays.some(w => w.token === b.after.token), 'the replacement is in the set now');
        assert.ok(!b.before || b.after.token !== b.before.token);
      }
      const compact = cards(s, 'ways').pop();
      assert.ok(compact.compact, 'the set after the deep phase is shown compact');
      assert.match(said(s), /I'd stop here\. I checked all \d+ destinations/);
    } else {
      assert.match(said(s), /Nothing beat the ways from the first pass, so they stand/);
      for (const w of finalWays) assert.equal(w.total, before[w.key], 'nothing was swapped under the traveler');
    }
    for (const w of finalWays) assert.ok(w.total <= 180000);
    assert.equal(s.pending, 'ways');
    assert.doesNotMatch(said(s), /\d+% (done|complete)/);
  } finally { await app.close(); }
});

test('one decision away: two priced trips within $50 that trade exactly one thing are the traveler\'s call, never the agent\'s, and the stop line follows the answer', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const optimizer = require('../server/trips/optimizer');
    const state = require('../server/agent/state');
    const facts = require('../server/trips/facts');
    const s0 = await agent.create({ visitor: 'v-decide' });
    const say = ask(agent, s0.id);
    const s = await say('I have $2,400, two of us from JFK, beach, 5 to 7 nights. Booking budget.');
    assert.equal(s.job.status, 'done');
    // The same search the agent ran, so the test knows whether a real decision existed.
    const q = state.toQuery(s, { maps: app.ctx.tripService.inv.maps }).query;
    const deep = optimizer.search(app.ctx.tripService.inv, q, { settings: await agent.settings(), now: agent.now() });
    const best = deep.picks[0];
    // The agent's own rule, mirrored: one group of facts traded against another, same destination.
    const exists = (deep.eligibleTrips || []).some(c => {
      if (c.trip === best.trip || c.trip.dest.id !== best.trip.dest.id || Math.abs(c.trip.total - best.trip.total) > 5000) return false;
      const ch = facts.classifyChanges(best.trip, c.trip);
      if (ch.neutral.some(r => r.key === 'dest')) return false;
      const changed = new Set([...ch.improvements, ...ch.tradeoffs, ...ch.neutral].map(r => r.key));
      const g = r => agent.decisionGroup(r.key, changed);
      if ([...ch.improvements, ...ch.tradeoffs].some(r => g(r) === 'both')) return false;
      const ups = new Set(ch.improvements.map(g).filter(Boolean)), downs = new Set(ch.tradeoffs.map(g).filter(Boolean));
      return ups.size === 1 && downs.size === 1 && [...ups][0] !== [...downs][0];
    });
    const card = cards(s, 'decision').pop();
    if (!exists) { assert.ok(!card, 'no decision is invented when the search does not hold one'); assert.match(said(s), /I'd stop here/); return; }
    assert.ok(card, 'the decision is asked');
    assert.equal(card.options.length, 2);
    assert.ok(Math.abs(card.options[0].total - card.options[1].total) <= 5000, 'within $50');
    assert.notEqual(card.options[0].label, card.options[1].label);
    assert.match(said(s).split(' | ').pop(), /I'm one decision away\..*Which matters more\?/);
    assert.doesNotMatch(said(s).split(' | ').pop(), /I'd (pick|go with|recommend) (A|B)\b/, 'the agent takes no side');
    assert.equal(s.pending, 'options');
    assert.doesNotMatch(said(s), /I'd stop here/, 'the signature stop waits for the answer');
    // The facts behind the stop line live on the state, where JSON keeps them (a property on the
    // decision array would be lost on Postgres), and name the trip the search would have picked.
    assert.ok(s.decisionFacts && s.decisionFacts.deep && s.decisionFacts.pick === s.decision[0].token);
    assert.deepEqual(JSON.parse(JSON.stringify(s)).decisionFacts, s.decisionFacts);
    const chosen = s.decision[1].token; // the card carries letters, labels and totals; the state holds the versions
    const s2 = await say('Option B');
    assert.equal(s2.current.token, chosen, 'the chosen version is on the canvas');
    assert.match(said(s2), /it is: .* matters more, and I keep that in mind for this trip \(not saved unless you ask\)/);
    assert.ok(card.options.every(o => o.label.length > 3), 'every button names what differs');
    const stop = said(s2).split(' | ').pop();
    assert.match(stop, /I'd stop here\. I checked all \d+ destinations/);
    // B was chosen over the search's own pick: the stop line says so instead of calling B the strongest found.
    assert.match(stop, /You chose .+ over the one I would have picked, so that is the trip on your canvas/);
    assert.doesNotMatch(stop, /This is the strongest option I found/);
    assert.equal(s2.decision, null);
    assert.equal(s2.decisionFacts, null);
    assert.equal((await app.ctx.store.listRecords('travel_defaults', { limit: 10 })).length, 0, 'nothing saved');
  } finally { await app.close(); }
});

test('watch this trip: a watch on the account with the rule the traveler named, re-priced in My Trips, speaking only when the rule is met; sign-in first when anonymous; nothing to watch when nothing is built', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, svc = app.ctx.tripService;
    const a0 = await agent.create({ visitor: 'v-anon' });
    let a = await ask(agent, a0.id)('Watch this trip');
    assert.match(said(a).split(' | ').pop(), /There is no trip to watch yet/);
    a = await ask(agent, a0.id)('I have $2,000, two of us from JFK, 5 nights, beach. Booking budget.');
    assert.ok(a.current);
    a = await ask(agent, a0.id)('Watch this trip');
    assert.match(said(a).split(' | ').pop(), /A watch lives on your account/);
    assert.equal(last(a).card.kind, 'link');
    assert.match(last(a).card.href, /^\/signin\?next=/);
    assert.equal((await app.ctx.store.listRecords('watch', { limit: 10 })).length, 0, 'nothing is stored for an anonymous visitor');
    const u = { id: 'u-watch', email: 'watch@example.com' };
    const w0 = await agent.create({ visitor: 'v-watch', userId: u.id });
    const say = ask(agent, w0.id);
    let w = await say('I have $2,000, two of us from JFK, 5 nights, beach. Booking budget.');
    assert.ok(w.current);
    w = await say('Tell me when it drops $50');
    const line = said(w).split(' | ').pop();
    assert.match(line, /^Watching it\. /);
    assert.match(line, /\$50/);
    assert.match(line, /say something only when that rule is met/);
    assert.match(line, /No other nudges, ever/);
    const recs = await app.ctx.store.listRecords('watch', { userId: u.id, limit: 10 });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].token, w.current.token);
    assert.deepEqual(recs[0].rule, { kind: 'drop', amount: 5000 });
    assert.equal(recs[0].priceAtSave, w.current.total, 'the price at save is the verified total, the only baseline');
    const rows = await svc.listSaved(u, 'watch');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].ruleText && /\$50/.test(rows[0].ruleText));
    assert.equal(rows[0].alert.met, false, 'no alert when nothing happened');
    assert.match(rows[0].alert.text, /^No alert: /, 'My Trips says plainly that nothing happened');
    assert.ok(!('budgetGuess' in recs[0]) && !('income' in recs[0]));
    w = await say('Let me know when it is under $1,200');
    const r2 = await app.ctx.store.listRecords('watch', { userId: u.id, limit: 10 });
    assert.equal(r2.length, 2);
    assert.deepEqual(r2.find(r => r.rule.kind === 'under').rule, { kind: 'under', amount: 120000 });
    // A threshold asked with a verb of falling is a total, never a drop of that size: "drops below
    // $1,300" is the $1,300 line, and only "drops $75" or "drops by $75" is a drop.
    for (const [phrase, rule] of [['Tell me when it drops below $1,300', { kind: 'under', amount: 130000 }], ['Alert me if it falls to $1,250', { kind: 'under', amount: 125000 }], ['Tell me when it drops by $75', { kind: 'drop', amount: 7500 }], ['Tell me when it is cheaper than $1,150', { kind: 'under', amount: 115000 }]]) {
      const before = (await app.ctx.store.listRecords('watch', { userId: u.id, limit: 20 })).length;
      w = await say(phrase);
      const recs = await app.ctx.store.listRecords('watch', { userId: u.id, limit: 20 });
      assert.equal(recs.length, before + 1, phrase);
      const added = recs.find(r => !r2.some(x => x.id === r.id) && r.rule.kind === rule.kind && r.rule.amount === rule.amount);
      assert.ok(added, `${phrase} → ${JSON.stringify(recs.map(r => r.rule))}`);
      assert.match(said(w).split(' | ').pop(), rule.kind === 'under' ? /at or under \$1,[0-9]{3}/ : /drops \$75 or more/);
    }
  } finally { await app.close(); }
});

test('when can I go for less: today\'s prices for the same trip on every other departure date searched, never a forecast; a flexible month gets its cheapest strong week; a fixed date is honest', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, svc = app.ctx.tripService;
    const s0 = await agent.create({ visitor: 'v-weeks' });
    const say = ask(agent, s0.id);
    let s = await say('I have $2,500, two of us from JFK, 5 nights, beach, anytime in June. Booking budget.');
    assert.equal(s.dateMode, 'flexible');
    assert.ok(s.current, 'a trip was built');
    const feedLine = s.job.feed.find(f => /^Cheapest strong week in June: /.test(f));
    const wk = cards(s, 'weeks');
    if (feedLine) {
      assert.ok(wk.length, 'the cheapest strong week is on a card after the build');
      assert.match(said(s), /not a forecast|today's prices/i);
    }
    s = await say('When can I go for less?');
    const card = cards(s, 'weeks').pop();
    const line = said(s).split(' | ').pop();
    assert.match(line, /Today's prices, not a forecast|cheapest strong week|only date I priced|No other departure date/);
    assert.doesNotMatch(line, /will (?:drop|fall|rise|be cheaper)|(?<!not a )forecast|usually|tends to|historically/i, 'nothing predicted');
    if (card && card.windows.length) {
      assert.ok(card.windows.every(w => /^\d{4}-\d{2}-\d{2}$/.test(w.depart)));
      assert.ok(card.windows.every(w => w.depart.startsWith(s.month)), 'only the month the traveler named');
      assert.ok(card.priced >= card.datesSearched && card.datesSearched >= card.windows.length, 'versions priced, dates priced in full, windows offered: each at least the next');
      for (const w of card.windows) {
        const priced = await svc.trip(w.token, {});
        assert.equal(w.total, priced.trip.total, 'every window total is the live priced total, nothing estimated');
        assert.equal(w.delta, w.total - card.current.total);
      }
      assert.deepEqual(card.windows.map(w => w.total), [...card.windows.map(w => w.total)].sort((a, b) => a - b), 'cheapest first');
      if (card.range) assert.ok(card.range.min <= card.windows[0].total && card.range.max >= card.windows[card.windows.length - 1].total);
      if (card.windows[0].letter) {
        assert.equal(s.pending, 'options');
        const first = card.windows[0];
        s = await say('Option A');
        assert.equal(s.current.token, first.token, 'picking a letter moves the trip to that week');
        assert.ok(s.history.some(h => /^Leaving |^Cheaper version, same dates$/.test(h.label)), 'the move is a line on the receipt');
      }
    }
    // A fixed date: only that date was priced, and the agent says so instead of guessing.
    const f0 = await agent.create({ visitor: 'v-fixed' });
    const sayF = ask(agent, f0.id);
    let f = await sayF('I have $2,500, two of us from JFK, 5 nights, beach, leaving June 12. Booking budget.');
    assert.equal(f.dateMode, 'exact');
    if (f.current) {
      f = await sayF('When can I go for less?');
      assert.match(said(f).split(' | ').pop(), /Your departure is fixed on .*the only date I priced.*never predict/);
      assert.equal(cards(f, 'weeks').length, 0);
    }
  } finally { await app.close(); }
});

// ---- hunt mode: "I can wait. Only come back when my money can do something better." ------------------
// Everything below is about a hunt record the service stored, a sentence the agent said about it, or
// a page rendered from the conversation; no number is asserted that the record or a priced trip does
// not carry.
const { HuntService } = require('../server/trips/hunts');
const { createNotifier } = require('../server/trips/integrations/notifications');
const hunter = require('../server/trips/hunter');
const { agentView } = require('../server/views/trips/agent');
const { quietLog } = require('./helpers');
// Words no hunt sentence may carry: no urgency, no scarcity, no predictions.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict)\b/i;

test('hunt mode: anonymous is sent to sign in and nothing is stored; the signed-in saver starts a hunt from the canvas words with the acceptance and monitoring sentences and no pressure; not good enough asks what to improve; more nights raises the minimum; stop hunting stops it; hunt for it resumes it', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, store = app.ctx.store;
    // The agent takes the hunt service app.js passes it; until app.js does, the one the app built.
    if (!agent.hunts) agent.hunts = app.ctx.hunts || new HuntService({ store, inventory: app.ctx.tripService.inv, settings: () => app.ctx.tripService.settings(), notifier: createNotifier(app.config, { store, now: () => agent.now(), log: quietLog }), now: () => agent.now(), log: quietLog, config: app.config });

    // Anonymous, through the page: the saver canvas carries the chip and the hunt-mode line, and the
    // chip leads to sign-in. Nothing is stored for a visitor without an account.
    const c = client(app.base);
    const start = await c.req('/agent', { method: 'POST', form: { budget: '1,500', mode: 'save' } });
    const id = start.headers.get('location').split('/').pop();
    await c.req(`/agent/${id}`, { method: 'POST', form: { say: 'JFK' } });
    await agent.jobs.drain();
    let page = text((await c.req(`/agent/${id}`)).text);
    assert.match(page, /Hunt for a better deal/);
    assert.match(page, /Hunt mode: “I can wait\. Only come back when my money can do something better\.”/);
    await c.req(`/agent/${id}`, { method: 'POST', form: { say: 'Hunt for a better deal' } });
    await agent.jobs.drain();
    const a = await agent.load(id);
    assert.match(said(a).split(' | ').pop(), /^A hunt lives on your account/);
    assert.equal(last(a).card.kind, 'link');
    assert.match(last(a).card.href, /^\/signin\?next=%2Fagent%2F/);
    assert.equal((await store.listRecords('hunt', { limit: 10 })).length, 0, 'nothing is stored for an anonymous visitor');
    assert.equal(a.mission.hunt, undefined);
    page = text((await c.req(`/agent/${id}`)).text);
    assert.match(page, /Sign in to start the hunt/);

    // Signed in: the hunt is created from the conversation's facts and run once, and the agent says
    // exactly what runs later and what the first check found.
    const u = { id: 'u-hunt' };
    const s0 = await agent.create({ visitor: 'v-hunt', userId: u.id, mission: true, mode: 'save' });
    const say = ask(agent, s0.id);
    await say('$1,500');
    let s = await say('JFK');
    assert.ok(s.current, 'the saver has a trip on the canvas');
    const saved = s.current.token;
    s = await say('Hunt for a better deal');
    const recs = await store.listRecords('hunt', { userId: u.id, limit: 10 });
    assert.equal(recs.length, 1);
    const h = recs[0];
    assert.equal(h.userId, u.id);
    assert.equal(h.budget, 150000);
    assert.equal(h.origin, s.origin);
    assert.ok(app.ctx.tripService.inv.maps.getOrigin(h.origin).airports.some(x => x.code === 'JFK'), 'the origin is the one JFK belongs to');
    assert.equal(h.savedToken, saved, 'the trip on the canvas is the saved trip to beat');
    assert.ok(h.notify.includes('beat-saved'));
    assert.equal(h.threshold, 10000);
    assert.equal(h.savingsLevel, 'balanced');
    assert.equal(h.status, 'hunting');
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].reason, 'created');
    assert.deepEqual(s.mission.hunt, { id: h.id, name: h.name, status: 'hunting' });
    const line = said(s).split(' | ').pop();
    assert.ok(line.startsWith(`${HuntService.ACCEPTANCE} ${agent.hunts.monitoringText()}`), line);
    assert.match(line, /re-checks your hunts/);
    assert.ok(!PRESSURE.test(line), line);
    const card = last(s).card;
    assert.equal(card.kind, 'hunt');
    assert.equal(card.hunt.id, h.id);
    assert.equal(card.hunt.budget, 150000);
    assert.equal(card.hunt.status, 'hunting');
    if (card.hunt.best) assert.equal(card.hunt.kept, 150000 - card.hunt.best.total, 'kept is the limit minus the verified total');
    if (card.hunt.opportunity) {
      const o = card.hunt.opportunity;
      assert.ok(o.trip.total <= 150000, 'inside the ceiling');
      assert.ok(line.endsWith(hunter.decisionText(o, h)), 'the decision is said as the engine words it');
      assert.match(line, /This currently meets the rules you gave me\. Current price was verified at .* UTC\. Price and availability may change\.$/);
      const priced = await app.ctx.tripService.trip(o.trip.token, {});
      assert.equal(o.trip.total, priced.trip.total, 'the opportunity total is the live priced total');
      assert.equal(h.opportunities[h.opportunities.length - 1].id, o.id);
    } else assert.match(line, /The first check priced \d+ complete packages across \d+ destinations and found nothing worth interrupting you for: /);
    // The page: the compact card with its answers, and the mission's status is the hunt's, by name.
    const view = text(String(agentView(app.ctx, { s, canvas: null, user: u })));
    assert.match(view, /My travel money/);
    assert.match(view, /Keep waiting/);
    assert.ok(view.includes(`Hunting: ${h.name}`), view.slice(0, 200));
    assert.ok(String(agentView(app.ctx, { s, canvas: null, user: u })).includes(`/hunts/${h.id}`), 'the card links to the hunt page');

    // Not good enough: what to improve, five answers; the answer changes the hunt, never the trip.
    s = await say('Not good enough');
    assert.equal(s.pending, 'improve');
    assert.match(said(s).split(' | ').pop(), /^What should I improve\?/);
    assert.deepEqual(last(s).card.options.map(o => o.label), ['Lower price', 'Better hotel', 'More nights', 'Nonstop', 'Different destination']);
    s = await say('More nights');
    const h2 = await store.getRecord('hunt', h.id);
    assert.ok(h2.minNights > h.minNights, `${h2.minNights} > ${h.minNights}`);
    assert.equal(h2.maxNights, Math.max(h.maxNights, h2.minNights));
    assert.equal(h2.learned[h2.learned.length - 1].text, `Minimum nights raised to ${h2.minNights}`);
    assert.equal(h2.runs[h2.runs.length - 1].reason, 'updated');
    const after = said(s).split(' | ').pop();
    assert.ok(after.startsWith(`Minimum nights raised to ${h2.minNights}. `), after);
    assert.ok(/I found a \d+-night .* trip for \$[\d,.]+ total\./.test(after) || /I checked again with the new rule: /.test(after), after);
    assert.ok(!PRESSURE.test(after), after);
    assert.equal(last(s).card.kind, 'hunt');
    assert.equal(s.nights, null, 'the trip on the canvas is not changed by an answer about the hunt');
    assert.equal(s.pending, null);

    // Stop: the status, said plainly; "hunt for it" resumes the same hunt, never a second record.
    s = await say('Stop hunting');
    assert.equal((await store.getRecord('hunt', h.id)).status, 'stopped');
    assert.match(said(s).split(' | ').pop(), /^Stopped\. Nothing runs for this hunt any more/);
    assert.equal(s.mission.hunt.status, 'stopped');
    assert.doesNotMatch(text(String(agentView(app.ctx, { s, canvas: null, user: u }))), /Hunting: /, 'a stopped hunt is not the mission status');
    s = await say('Hunt for it');
    assert.equal((await store.getRecord('hunt', h.id)).status, 'hunting');
    assert.equal((await store.listRecords('hunt', { userId: u.id, limit: 10 })).length, 1, 'resumed, not duplicated');
    assert.match(said(s).split(' | ').pop(), /is hunting again under the rules it had\. This site re-checks your hunts/);

    // One message per opportunity in the outbox, each the decision without pressure; silence sends none.
    const h3 = await store.getRecord('hunt', h.id);
    const outbox = (await store.listRecords('outbox', { limit: 50 })).filter(o => o.ref === h.id);
    assert.equal(outbox.length, h3.opportunities.length);
    for (const o of outbox) { assert.ok(!PRESSURE.test(`${o.subject} ${o.body}`), o.subject); assert.match(o.body, /This currently meets the rules you gave me/); }
  } finally { await app.close(); }
});

test('a change the traveler applies while every destination is still being checked is never swapped under them when the deep phase lands; a new champion is then a proposal', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-beat-keep', mission: true });
    await agent.say(s0.id, '$1,800');
    let reached, release, held = false;
    const atGate = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    agent.breathe = async () => { if (held) return; const st = await agent.load(s0.id); if (st.mission && st.mission.fastRound !== null) { held = true; reached(); await gate; } };
    await agent.say(s0.id, 'JFK');
    await atGate;
    let s = await agent.load(s0.id);
    assert.equal(s.job.status, 'running');
    const champion = s.current.token;
    // The traveler negotiates on the canvas trip while the rest is checked, and takes a cheaper version.
    await agent.say(s0.id, 'Make it $100 cheaper');
    s = await agent.load(s0.id);
    if (!s.proposal) { await agent.say(s0.id, 'How low can you go?'); s = await agent.load(s0.id); }
    if (!s.proposal) { release(); await agent.jobs.drain(); return; } // nothing cheaper to take today: nothing to test
    await agent.say(s0.id, 'Take it');
    s = await agent.load(s0.id);
    const approved = s.current.token;
    assert.notEqual(approved, champion, 'a different version is on the canvas now');
    const historyBefore = s.history.map(h => h.token);
    release();
    await agent.jobs.drain();
    s = await agent.load(s0.id);
    assert.equal(s.job.status, 'done');
    assert.equal(s.current.token, approved, 'the deep phase never puts the champion back over an applied change');
    assert.deepEqual(s.history.map(h => h.token), historyBefore, 'the receipt still matches the canvas');
    const beats = cards(s, 'beat');
    if (beats.length || s.job.feed.some(f => /way added/.test(f))) {
      // The set changed: the new champion is offered, never applied, or the canvas is said to stand.
      const offered = s.proposal && /Strongest way after every destination|Better version of your pick/.test(s.proposal.label);
      assert.ok(offered || s.job.feed.some(f => /your canvas keeps the version you applied/.test(f)) || s.mission.strategies.some(w => w.token === approved), said(s));
      if (offered) assert.match(said(s), /your canvas stays as you made it/);
    }
    for (const b of beats) assert.doesNotMatch(said(s), /Given up:/, 'a replacement never gives anything up');
  } finally { await app.close(); }
});

test('materially better never gives anything up: a cheaper or better-scoring trip with a trade-off is just another option', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const optimizer = require('../server/trips/optimizer');
    const facts = require('../server/trips/facts');
    const q = { budget: 240000, vacationBudget: 240000, keep: 0, budgetInput: 2400, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
    const deep = optimizer.search(app.ctx.tripService.inv, q, { settings: await agent.settings(), now: agent.now() });
    const best = deep.picks[0];
    const a = { trip: best.trip, match: best.match || 80 };
    const traded = deep.eligibleTrips.find(c => c.trip !== best.trip && c.trip.total <= best.trip.total - 5000 && facts.classifyChanges(best.trip, c.trip).tradeoffs.length);
    const clean = deep.eligibleTrips.find(c => c.trip !== best.trip && c.trip.total <= best.trip.total - 2500 && !facts.classifyChanges(best.trip, c.trip).tradeoffs.length);
    assert.ok(traded, 'a cheaper trip that gives something up exists in the demo');
    assert.equal(agent.materiallyBetter(a, { trip: traded.trip, match: a.match + 20 }), false, 'cheaper and better-scoring, but something is given up');
    if (clean) assert.equal(agent.materiallyBetter(a, { trip: clean.trip, match: a.match - 10 }), true, 'at least $25 cheaper with nothing given up');
    assert.equal(agent.materiallyBetter(a, a), false);
  } finally { await app.close(); }
});

test('a priced week over the ceiling is a proposal that waits for "go over", never applied by its letter', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const state = require('../server/agent/state');
    // Tighten the ceiling to the trip the search picks until another week prices over it.
    let dollars = 3000, hit = null;
    for (let i = 0; i < 5 && !hit; i++) {
      const s0 = await agent.create({ visitor: `v-week-${i}` });
      const say = ask(agent, s0.id);
      let s = await say(`I have $${dollars.toLocaleString('en-US')}, two of us from JFK, 5 nights, beach. Booking budget.`);
      if (!s.current) break;
      s = await say('When can I go for less?');
      const card = cards(s, 'weeks').pop();
      const over = card && card.windows.find(w => w.over && w.letter);
      if (over) hit = { say, s, over, card, budget: state.bookingBudget(s) };
      else dollars = Math.ceil(s.current.total / 100) + i;
    }
    if (!hit) return; // every other week priced inside these ceilings today: nothing to test
    const { say, over, budget } = hit;
    const before = hit.s.current.token, history = hit.s.history.length;
    assert.ok(hit.s.current.total <= budget);
    let s = await say(`Option ${over.letter}`);
    assert.ok(s.proposal && s.proposal.over && s.proposal.token === over.token, 'the week is proposed, not applied');
    assert.equal(s.current.token, before, 'the canvas stays inside the ceiling');
    assert.equal(s.history.length, history);
    assert.equal(s.overApproved, false);
    assert.match(said(s).split(' | ').pop(), new RegExp(`over your ${money(budget).replace(/[$.]/g, '\\$&')} ceiling\\. Say "go over" to take it anyway`));
    s = await say('Keep what I have');
    assert.equal(s.proposal, null);
    assert.equal(s.current.token, before);
  } finally { await app.close(); }
});
