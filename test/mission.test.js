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
// `user` is who the request is signed in as: an account action (a hunt, a watch) is taken as them.
const ask = (agent, id, user = null) => async t => { await agent.say(id, t, { user }); await agent.jobs.drain(); return agent.load(id); };

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
    const say = ask(agent, w0.id, u);
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
const optimizer = require('../server/trips/optimizer');
const agentState = require('../server/agent/state');
const { addDays, today } = require('../server/lib/dates');
const { agentView } = require('../server/views/trips/agent');
const { quietLog } = require('./helpers');
const stampOf = iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
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
    const say = ask(agent, s0.id, u);
    await say('$1,500');
    let s = await say('JFK');
    assert.ok(s.current, 'the saver has a trip on the canvas');
    const saved = s.current.token;
    // Without the account's owner on the request (a browser that signed out), nothing is created on
    // the account, whatever id the conversation stores.
    s = await ask(agent, s0.id)('Hunt for a better deal');
    assert.match(said(s).split(' | ').pop(), /^A hunt lives on your account, so only you, signed in, can start the hunt from here\./);
    assert.equal((await store.listRecords('hunt', { userId: u.id, limit: 10 })).length, 0);
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
    assert.equal(s.mission.hunt.id, h.id); assert.equal(s.mission.hunt.name, h.name); assert.equal(s.mission.hunt.status, 'hunting');
    assert.equal(s.mission.hunt.input.budget, h.budget, 'the ref keeps the input the hunt was started from, so a later ask can say what changed here since');
    const line = said(s).split(' | ').pop();
    // The monitoring sentence is the service's own, with where a find appears said for the
    // conversation: on the hunt page and in My Trips, never "here" (nothing posts into this chat).
    assert.ok(line.startsWith(`${HuntService.ACCEPTANCE} ${agent.huntMonitoring()}`), line);
    assert.equal(agent.huntMonitoring(), agent.hunts.monitoringText().replace('What it finds appears here and in My Trips', 'What it finds appears on the hunt page and in My Trips'));
    assert.ok(line.includes('What it finds appears on the hunt page and in My Trips'), line);
    assert.ok(!line.includes('appears here'), line);
    assert.match(line, /re-checks your hunts/);
    assert.ok(!PRESSURE.test(line), line);
    // The threshold is said, never only chosen; so is the range of lengths when none was named, and
    // an open length keeps the extra-night win.
    assert.equal(s.nights, null);
    assert.ok(h.minNights < h.maxNights);
    assert.ok(line.includes(`I look at ${h.minNights} to ${h.maxNights} nights, since no length was named.`), line);
    assert.ok(h.notify.includes('extra-night'));
    assert.ok(line.includes('I interrupt you for wins of $100 or more; say "tell me about $50 wins" to change it.'), line);
    const card = last(s).card;
    assert.equal(card.kind, 'hunt');
    assert.equal(card.hunt.id, h.id);
    assert.equal(card.hunt.budget, 150000);
    assert.equal(card.hunt.status, 'hunting');
    assert.equal(card.hunt.checked, stampOf(h.lastRunAt), 'the card says when the check it shows was');
    if (card.hunt.best) {
      assert.equal(card.hunt.best.token, h.baseline.best.token);
      assert.equal(card.hunt.best.total, h.baseline.best.total, 'the total the check verified, never a re-price');
      assert.equal(card.hunt.kept, 150000 - card.hunt.best.total, 'kept is the limit minus the verified total');
    }
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

test('hunt mode carries every hard rule the mission panel lists: the destination with beachfront and an included transfer, international only, a country left out, a stated and locked length as the exact length (no extra-night win), what matters most; a lock a hunt cannot keep is asked about, never dropped in silence', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, store = app.ctx.store, maps = app.ctx.tripService.inv.maps;
    const start = async (userId, first, before = []) => {
      const s0 = await agent.create({ visitor: `v-${userId}`, userId, mission: true, mode: 'save' });
      const say = ask(agent, s0.id, { id: userId });
      let s = await say(first);
      if (s.pending === 'origin') s = await say('JFK');
      for (const b of before) s = await say(b);
      return { s, say };
    };
    const huntOf = async userId => (await store.listRecords('hunt', { userId, limit: 10 }))[0];
    const priced = async token => (await app.ctx.tripService.trip(token, {})).trip;

    // A destination, a beachfront hotel and an airport transfer: the hunt searches Cancun alone, and
    // every trip it stands on or tells of keeps both rules, as its rule lines say.
    let { s, say } = await start('u-rules-1', '$2,500 to Cancun, beachfront hotel with airport transfer');
    assert.equal(s.destination, 'cancun'); assert.equal(s.hotelRules.beachfront, true); assert.equal(s.transfer, true);
    s = await say('Hunt for a better deal');
    let h = await huntOf('u-rules-1');
    assert.equal(h.dest, 'cancun');
    assert.equal(h.rules.beachfront, true); assert.equal(h.rules.transfer, true);
    assert.equal(h.name, '$2,500 Cancun Hunt');
    const lines = hunter.ruleLines(h, { maps });
    for (const l of ['Destination: Cancun', 'Hotel: beachfront', 'Airport transfer: included']) assert.ok(lines.includes(l), l);
    assert.ok(h.runs[0].destinations <= 1, 'one destination was searched');
    for (const x of [h.baseline.best, ...h.baseline.byDest, ...h.opportunities.map(o => o.trip)].filter(Boolean)) {
      const t = await priced(x.token);
      assert.equal(t.dest.id, 'cancun'); assert.equal(!!t.hotel.features.beachfront, true); assert.equal(!!t.transfer, true);
    }
    for (const o of h.opportunities) assert.ok(o.receipt.rules.includes('Hotel: beachfront') && o.receipt.rules.includes('Destination: Cancun'));
    assert.ok(said(s).split(' | ').pop().includes(`I look at ${h.minNights} to ${h.maxNights} nights, since no length was named.`));

    // A stated and locked length is the hunt's exact length (no range said, no extra-night win), and
    // what matters most steers the pick as it does on the canvas.
    ({ s, say } = await start('u-rules-2', '$2,500, 7 nights, nice hotel', ['Lock the nights']));
    assert.equal(s.nights, 7); assert.equal(s.locks.nights, true); assert.equal(s.priority, 'hotel');
    s = await say('Hunt for a better deal');
    h = await huntOf('u-rules-2');
    assert.equal(h.minNights, 7); assert.equal(h.maxNights, 7);
    assert.ok(!h.notify.includes('extra-night'), 'a fixed length asks for no extra night');
    assert.equal(h.priority, 'hotel');
    assert.ok(hunter.ruleLines(h, { maps }).includes('Matters most: the hotel'));
    assert.doesNotMatch(said(s).split(' | ').pop(), /I look at \d+ to \d+ nights/);
    if (h.baseline.best) assert.equal(h.baseline.best.nights, 7);

    // International only: nothing in the origin's country is priced, let alone told.
    ({ s, say } = await start('u-rules-3', '$2,500 somewhere international, 4-star'));
    assert.equal(s.region, 'international');
    s = await say('Hunt for a better deal');
    h = await huntOf('u-rules-3');
    assert.equal(h.region, 'international'); assert.equal(h.rules.minStars, 4);
    assert.ok(hunter.ruleLines(h, { maps }).includes('Destinations: international only'));
    for (const x of [h.baseline.best, ...h.baseline.byDest, ...h.baseline.overByDest].filter(Boolean)) assert.ok(!optimizer.sameCountry(maps.getDestination(x.dest).country, 'United States'), x.dest);
    assert.ok(h.runs[0].destinations < maps.listDestinations().length);

    // "Try another country": that country is left out as the destinations the inventory has there.
    ({ s, say } = await start('u-rules-4', '$2,500 to Cancun'));
    s = await say('Try another country');
    assert.equal(s.notCountry, 'Mexico'); assert.equal(s.destination, null);
    s = await say('Hunt for a better deal');
    h = await huntOf('u-rules-4');
    assert.deepEqual([...h.excludeDests].sort(), maps.listDestinations().filter(d => optimizer.sameCountry(d.country, 'Mexico')).map(d => d.id).sort());
    assert.equal(h.dest, null);
    for (const x of [h.baseline.best, ...h.baseline.byDest].filter(Boolean)) assert.ok(!optimizer.sameCountry(maps.getDestination(x.dest).country, 'Mexico'));

    // A lock a hunt cannot keep: one question, nothing created until the answer, the answer said back
    // with the hunt, the canvas keeping its lock, and the question not asked twice once answered yes.
    ({ s, say } = await start('u-rules-5', '$2,500', ['Don’t change the hotel']));
    assert.equal(s.locks.hotel, true);
    s = await say('Hunt for a better deal');
    assert.equal(s.pending, 'huntWithout');
    assert.equal(await huntOf('u-rules-5'), undefined, 'nothing is created before the answer');
    assert.match(said(s).split(' | ').pop(), /so it cannot keep the hotel you locked\. Hunt without it \(the canvas keeps your lock\), or not now\?$/);
    assert.deepEqual(last(s).card.options.map(o => o.label), ['Hunt without it', 'Not now']);
    s = await say('Not now');
    assert.equal(await huntOf('u-rules-5'), undefined);
    assert.equal(said(s).split(' | ').pop(), 'No hunt started. Your locks stand and the canvas is as it was.');
    s = await say('Hunt for a better deal');
    assert.equal(s.pending, 'huntWithout', 'asked again; a no is not remembered as a yes');
    s = await say('Hunt without it');
    h = await huntOf('u-rules-5');
    assert.ok(h, 'created on the traveler\'s word');
    assert.equal(s.locks.hotel, true, 'the canvas keeps the lock');
    assert.ok(said(s).split(' | ').pop().includes('Hunting without the hotel you locked, as you said; the canvas keeps it.'));
    s = await say('Hunt for a better deal');
    assert.equal(s.pending, null, 'the lock the traveler let the hunt go without is not asked about twice');
    assert.match(said(s).split(' | ').pop(), /is already hunting under these rules\. This site re-checks/);
    assert.equal((await store.listRecords('hunt', { userId: 'u-rules-5', limit: 10 })).length, 1);
    for (const m of s.messages.filter(x => x.role === 'agent')) assert.ok(!PRESSURE.test(m.text), m.text);
  } finally { await app.close(); }
});

test('hunt mode never duplicates a hunt in silence: a changed limit or a new hard rule is said and asked about; "leave it" leaves both, "keep both" says the first keeps running and where to stop it, "add it" moves the rule on the hunt itself, "replace it" stops the hunt this conversation follows and says so', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, store = app.ctx.store;
    const u = { id: 'u-differs' };
    const s0 = await agent.create({ visitor: 'v-differs', userId: u.id, mission: true, mode: 'save' });
    const say = ask(agent, s0.id, u);
    const hunts = () => store.listRecords('hunt', { userId: u.id, limit: 10 });
    await say('$1,500');
    let s = await say('JFK');
    assert.ok(s.current);
    s = await say('Hunt for a better deal');
    const first = (await hunts())[0];
    assert.equal(first.budget, 150000);
    // A new limit: no second hunt; the difference is said in both values and one question is asked.
    s = await say('$2,000');
    s = await say('Hunt for a better deal');
    assert.equal(s.pending, 'huntDiffers');
    assert.equal((await hunts()).length, 1, 'no second hunt in silence');
    let line = said(s).split(' | ').pop();
    assert.ok(line.startsWith(`${first.name} is hunting with the rules it was started with, and this conversation has changed since: `), line);
    assert.ok(line.includes('the limit ($1,500 then, $2,000 now)'), line);
    assert.deepEqual(last(s).card.options.map(o => o.label), ['Replace it', 'Keep both', 'Leave it']);
    s = await say('Leave it');
    assert.equal((await hunts()).length, 1);
    assert.equal(s.mission.hunt.id, first.id);
    assert.match(said(s).split(' | ').pop(), /^Left as it is: .* keeps hunting under the rules it was started with, and this conversation keeps its own\.$/);
    // Keep both: the second hunt is created, the first keeps running, and that is said with where to stop it.
    s = await say('Hunt for a better deal');
    assert.equal(s.pending, 'huntDiffers', 'the rules still differ, so it is asked again');
    s = await say('Keep both');
    let all = await hunts();
    assert.equal(all.length, 2);
    const second = all.find(h => h.id !== first.id);
    assert.equal(second.budget, 200000);
    assert.equal((await store.getRecord('hunt', first.id)).status, 'hunting');
    assert.equal(s.mission.hunt.id, second.id);
    line = said(s).split(' | ').pop();
    assert.ok(line.includes(`${first.name} keeps running too; this conversation now follows ${second.name}, and the other is stopped from its page or from My Trips.`), line);
    // A new hard rule: the hunt lacks it, so "already hunting under its rules" is never said; the rule
    // can be added to the hunt as it is (the service's own nonstop answer), and then it is.
    const canvasBefore = s.current.token;
    s = await say('Only nonstop');
    assert.equal(s.flightStops, 'nonstop'); assert.equal(s.flightRule, 'hard');
    const canvasMoved = s.current.token !== canvasBefore;
    s = await say('Hunt for a better deal');
    assert.equal(s.pending, 'huntDiffers');
    assert.equal((await hunts()).length, 2);
    line = said(s).split(' | ').pop();
    assert.ok(line.includes('nonstop (not a rule then, a hard rule now)'), line);
    if (canvasMoved) assert.ok(line.includes('the trip to beat (the trip on the canvas changed since)'), line);
    assert.doesNotMatch(line, /already hunting under/);
    assert.deepEqual(last(s).card.options.map(o => o.label), ['Add it to the hunt', 'Replace it', 'Keep both', 'Leave it']);
    s = await say('Add it to the hunt');
    const h2 = await store.getRecord('hunt', second.id);
    assert.deepEqual([h2.rules.flightStops, h2.rules.flightRule], ['nonstop', 'hard']);
    assert.equal(h2.learned[h2.learned.length - 1].text, 'Nonstop flights are now a hard rule');
    assert.equal(h2.runs[h2.runs.length - 1].reason, 'updated');
    assert.equal((await hunts()).length, 2);
    assert.ok(said(s).split(' | ').pop().startsWith('Nonstop flights are now a hard rule. '));
    s = await say('Hunt for a better deal');
    if (canvasMoved) { assert.equal(s.pending, 'huntDiffers'); assert.ok(said(s).split(' | ').pop().includes('the trip to beat')); s = await say('Leave it'); }
    else { assert.equal(s.pending, null); assert.ok(said(s).split(' | ').pop().startsWith(`${second.name} is already hunting under these rules. This site re-checks`)); }
    assert.equal((await hunts()).length, 2);
    // Replace: the hunt this conversation follows is stopped and the new one says so; the first, an
    // instruction this conversation stopped following, is untouched.
    s = await say('$2,500');
    s = await say('Hunt for a better deal');
    assert.equal(s.pending, 'huntDiffers');
    s = await say('Replace it');
    all = await hunts();
    assert.equal(all.length, 3);
    const third = all.find(h => h.budget === 250000);
    assert.ok(third && third.status === 'hunting');
    assert.equal((await store.getRecord('hunt', second.id)).status, 'stopped');
    assert.equal((await store.getRecord('hunt', first.id)).status, 'hunting');
    assert.equal(s.mission.hunt.id, third.id);
    line = said(s).split(' | ').pop();
    assert.ok(line.includes(`${second.name} is stopped; this hunt replaces it, and what it learned stays on its page.`), line);
    assert.deepEqual([third.rules.flightStops, third.rules.flightRule], ['nonstop', 'hard'], 'the replacement carries the rules on the canvas');
    for (const m of s.messages.filter(x => x.role === 'agent')) assert.ok(!PRESSURE.test(m.text), m.text);
  } finally { await app.close(); }
});

test('hunt mode: the saving worth an interruption is said with the hunt, and "tell me about $N wins" moves it: before the hunt it is kept for it (nothing saved to the account), on the hunt it is the record’s own answer, re-checked against the same record; the amount is never read as a budget, and a refusal is the service’s sentence', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, store = app.ctx.store;
    const u = { id: 'u-thr' };
    const s0 = await agent.create({ visitor: 'v-thr', userId: u.id, mission: true, mode: 'save' });
    const say = ask(agent, s0.id, u);
    const hunts = () => store.listRecords('hunt', { userId: u.id, limit: 10 });
    await say('$1,500');
    let s = await say('JFK');
    s = await say('Tell me about $50 wins');
    assert.equal(s.huntThreshold, 5000);
    assert.equal(agentState.bookingBudget(s), 150000, 'the amount is the threshold, not a budget');
    assert.equal(said(s).split(' | ').pop(), 'Noted for this conversation: once a hunt starts, I interrupt you for wins of $50 or more. Nothing is saved to your account by this.');
    assert.equal((await hunts()).length, 0);
    s = await say('Hunt for a better deal');
    let h = (await hunts())[0];
    assert.equal(h.threshold, 5000);
    assert.ok(said(s).split(' | ').pop().includes('I interrupt you for wins of $50 or more; say "tell me about $100 wins" to change it.'));
    const before = h.baseline;
    s = await say('Tell me about $200 wins');
    h = await store.getRecord('hunt', h.id);
    assert.equal(h.threshold, 20000);
    assert.equal(agentState.bookingBudget(s), 150000);
    assert.equal(h.learned[h.learned.length - 1].text, 'Now interrupting for wins of $200 or more');
    assert.equal(h.runs[h.runs.length - 1].reason, 'updated', 'the hunt checks again under the new threshold');
    assert.ok(h.baseline, 'the record stays comparable: a threshold is about when to speak, not what qualifies');
    if (before && before.best && h.baseline.best) assert.equal(h.baseline.best.token, before.best.token, 'the trip on record is still the trip on record');
    assert.ok(said(s).split(' | ').pop().startsWith('Now interrupting for wins of $200 or more. '));
    s = await say('Hunt for a better deal');
    assert.equal(s.pending, null, 'the threshold the hunt now has is the one this conversation holds: nothing differs');
    assert.match(said(s).split(' | ').pop(), /is already hunting under these rules/);
    assert.equal((await hunts()).length, 1);
    s = await say('Tell me about $2,000 wins');
    assert.equal((await store.getRecord('hunt', h.id)).threshold, 20000, 'refused, unchanged');
    assert.equal(said(s).split(' | ').pop(), 'The saving that is worth an interruption must be between $0.01 and your $1,500 limit.');
  } finally { await app.close(); }
});

test('hunt mode: the conversation’s hunt card is the record as the service’s own check verified it, never a live re-price with no judgement: inside the refresh limit an answer runs nothing and the card is stamped with the check it shows; months later "keep waiting" re-checks the hunt (said), the departed trip is said gone, and the card stands on the new best', async () => {
  let clock = new Date(); clock.setUTCHours(9, 0, 0, 0);
  const app = await startApp({}, { now: () => new Date(clock) });
  try {
    const agent = app.agent, store = app.ctx.store;
    const u = { id: 'u-card' };
    const s0 = await agent.create({ visitor: 'v-card', userId: u.id, mission: true, mode: 'save' });
    const say = ask(agent, s0.id, u);
    await say('$1,500');
    let s = await say('JFK');
    s = await say('Hunt for a better deal');
    const h = (await store.listRecords('hunt', { userId: u.id, limit: 10 }))[0];
    if (!h.baseline.best) return; // nothing qualifies today: nothing recorded to stand on
    const recorded = h.baseline.best;
    clock = new Date(clock.getTime() + 5 * 60000);
    s = await say('Not good enough');
    s = await say('Keep waiting');
    let card = last(s).card;
    assert.equal((await store.getRecord('hunt', h.id)).runs.length, h.runs.length, 'no check inside the limit');
    assert.doesNotMatch(said(s).split(' | ').pop(), /checked it again/);
    assert.equal(card.hunt.best.token, recorded.token);
    assert.equal(card.hunt.best.total, recorded.total, 'the total the check verified, not a price looked up now');
    assert.equal(card.hunt.best.recorded, true);
    assert.equal(card.hunt.kept, h.budget - recorded.total);
    assert.equal(card.hunt.checked, stampOf(h.lastRunAt));
    // Long after the recorded departure: the card comes from a real check, which says the recorded
    // trip left the window and what the hunt stands on now, stamped with that check.
    const depart = decodeSpec(recorded.token).depart;
    clock = new Date(Date.parse(`${depart}T09:00:00Z`) + 40 * 86400000);
    s = await say('Not good enough');
    s = await say('Keep waiting');
    const h2 = await store.getRecord('hunt', h.id);
    assert.equal(h2.runs.length, h.runs.length + 1);
    assert.equal(h2.runs[h2.runs.length - 1].reason, 'opened');
    card = last(s).card;
    const line = said(s).split(' | ').pop();
    assert.match(line, /^Kept as it is\. The rules stand and I say nothing until one of them is met\. I checked it again just now/);
    assert.ok(line.includes(`trip I found before has left the window: it left on ${depart}`), line);
    if (h2.baseline.best) {
      assert.equal(card.hunt.best.token, h2.baseline.best.token);
      assert.equal(card.hunt.best.total, h2.baseline.best.total);
      assert.ok(decodeSpec(card.hunt.best.token).depart >= addDays(today(clock), 3), 'the card never stands on a departed trip');
      assert.ok(card.hunt.best.total <= h2.budget);
      assert.equal(card.hunt.kept, h2.budget - h2.baseline.best.total);
      assert.notEqual(card.hunt.best.token, recorded.token);
    } else assert.equal(card.hunt.best, null);
    assert.equal(card.hunt.checked, stampOf(h2.lastRunAt));
    const view = text(String(agentView(app.ctx, { s, canvas: null, user: u })));
    assert.ok(view.includes(`as checked ${card.hunt.checked}`), 'the page says which check the number is from');
    assert.doesNotMatch(view, /limit minus the verified total/, 'no hunt card calls a recorded total verified now');
    assert.ok(!PRESSURE.test(line), line);
  } finally { await app.close(); }
});

test('hunt mode: an exactly stated date becomes the hunt’s month, named in words; "start over" says the hunt keeps running (or stays stopped) on the account and where to stop or resume it, and the record is untouched', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, store = app.ctx.store;
    const monthName = m => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
    const u = { id: 'u-restart' };
    const s0 = await agent.create({ visitor: 'v-restart', userId: u.id, mission: true, mode: 'save' });
    const say = ask(agent, s0.id, u);
    // A date far enough out that its month has departures left to price whatever today is.
    const depart = addDays(today(), 45);
    let s = await say(`$2,000 leaving ${depart}`);
    if (s.pending === 'origin') s = await say('JFK');
    assert.equal(s.dateMode, 'exact'); assert.equal(s.depart, depart);
    s = await say('Hunt for a better deal');
    const h = (await store.listRecords('hunt', { userId: u.id, limit: 10 }))[0];
    assert.equal(h.month, depart.slice(0, 7));
    const line = said(s).split(' | ').pop();
    assert.ok(line.includes(`A hunt searches a window, not one date, so it looks at ${monthName(h.month)}.`), line);
    assert.ok(!line.includes(`looks at ${h.month}`), 'never the raw month');
    s = await say('Start over');
    assert.equal(s.mission, null); assert.equal(s.hunt, null);
    assert.equal((await store.getRecord('hunt', h.id)).status, 'hunting', 'a standing instruction is never stopped without the customer’s word');
    assert.equal(said(s), `Fresh start. ${h.name} keeps running on your account, untouched by this: stop it from its page or from My Trips. What do you want your trip to do?`);
    assert.deepEqual(last(s).card, { kind: 'link', href: `/hunts/${h.id}`, label: `${h.name}: stop or resume it there` });
    // A stopped hunt is said as stopped, with where to resume it.
    const v = { id: 'u-restart-2' };
    const t0 = await agent.create({ visitor: 'v-restart-2', userId: v.id, mission: true, mode: 'save' });
    const tell = ask(agent, t0.id, v);
    await tell('$1,500');
    let t = await tell('JFK');
    t = await tell('Hunt for a better deal');
    const g = (await store.listRecords('hunt', { userId: v.id, limit: 10 }))[0];
    t = await tell('Stop hunting');
    t = await tell('Start over');
    assert.equal((await store.getRecord('hunt', g.id)).status, 'stopped');
    assert.equal(said(t), `Fresh start. ${g.name} stays stopped on your account: resume it from its page or from My Trips. What do you want your trip to do?`);
  } finally { await app.close(); }
});

test('hunt mode: "what should I improve?" takes only its own answers (a chip, or a few words naming one of the five and nothing else); a canvas sentence or chip goes to the canvas with the hunt untouched and the lapse said in one line; "not enough" inside a trip change is that change, rebuilt; "I can wait until December" is a date, never a hunt; "not good enough" without a hunt is told so', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, store = app.ctx.store;
    const LEFT = 'Left the hunt as it is; that was not one of its answers, so I take it as being about the trip on the canvas.';
    const lines = s => said(s).split(' | ');
    const u = { id: 'u-improve' };
    const s0 = await agent.create({ visitor: 'v-improve', userId: u.id, mission: true, mode: 'save' });
    const say = ask(agent, s0.id, u);
    await say('$1,500');
    let s = await say('JFK');
    assert.ok(s.current, 'the saver has a trip on the canvas');
    // No hunt yet: the dedicated answer, never "I did not understand that".
    s = await say('Not good enough');
    assert.equal(lines(s).pop(), 'There is no hunt on this conversation yet. Say "hunt for a better deal" and I start one with your rules.');
    assert.equal(s.pending, null);
    s = await say('Hunt for a better deal');
    const h = (await store.listRecords('hunt', { userId: u.id, limit: 10 }))[0];
    assert.ok(h && h.status === 'hunting');
    const rulesOf = async () => { const r = await store.getRecord('hunt', h.id); return { minNights: r.minNights, maxNights: r.maxNights, minStars: r.rules.minStars, target: r.target, excludeDests: r.excludeDests, flightStops: r.rules.flightStops, learned: r.learned.length, runs: r.runs.length }; };

    // Canvas sentences and the saver's own chips while the question is pending: the hunt's rules stand
    // exactly as they were, the lapse is said in one line, and the words do on the canvas what they
    // always do. ("One night less" is a change of one night, never a two-night length; "try another
    // country" leaves the country out on the canvas, the chip under the composer, not the hunt's rule.)
    for (const [words, check] of [
      ['Lock the hotel', st => { assert.equal(st.locks.hotel, true); assert.match(lines(st).pop(), /^Locked: Hotel\./); }],
      ['Keep my money', st => assert.equal(lines(st).pop(), LEFT)],
      ['Why this hotel?', st => assert.doesNotMatch(lines(st).pop(), /Hotel minimum raised/)],
      ['One night less', st => { assert.equal(st.nights, null, 'one night less is not a length'); assert.doesNotMatch(lines(st).pop(), /Minimum nights raised/); }],
      ['Make it $200 cheaper', st => assert.doesNotMatch(lines(st).pop(), /Now looking under/)],
      ['Try another country', st => { assert.ok(st.notCountry, 'the country is left out on the canvas'); assert.doesNotMatch(said(st), /ruled out for this hunt/); }],
    ]) {
      const before = await rulesOf();
      s = await say('Not good enough');
      assert.equal(s.pending, 'improve');
      const asked = lines(s).length;
      s = await say(words);
      assert.deepEqual(await rulesOf(), before, `"${words}" never moves a hunt rule`);
      assert.equal(s.pending === 'improve', false, 'the question lapsed');
      const after = lines(s).slice(asked);
      assert.equal(after[0], LEFT, `the lapse is the first thing said: ${after.join(' | ')}`);
      assert.equal(after.filter(l => l === LEFT).length, 1, 'said once');
      check(s);
    }
    assert.equal(s.hotelRules.minStars, null, 'no answer about the hunt touched the canvas rules');

    // Real answers: a chip, or a few words naming exactly one of the five with no other ask in them.
    let before = await rulesOf();
    s = await say('Not good enough');
    s = await say('direct');
    let r = await store.getRecord('hunt', h.id);
    assert.equal(r.rules.flightStops, 'nonstop'); assert.equal(r.rules.flightRule, 'hard');
    assert.equal(r.learned[r.learned.length - 1].text, 'Nonstop flights are now a hard rule');
    assert.equal(r.runs.length, before.runs + 1, 're-checked under the new rule');
    assert.ok(lines(s).pop().startsWith('Nonstop flights are now a hard rule. '), lines(s).pop());
    assert.equal(s.flightStops, null, 'the canvas keeps its own rules');
    before = await rulesOf();
    const bestBefore = (await store.getRecord('hunt', h.id)).baseline.best;
    s = await say('Not good enough');
    s = await say('more nights');
    r = await store.getRecord('hunt', h.id);
    assert.equal(r.minNights, Math.min(14, (bestBefore ? bestBefore.nights : before.minNights) + 1), 'one night more than the found trip, the record’s own rule');
    assert.ok(r.learned[r.learned.length - 1].text.startsWith(`Minimum nights raised to ${r.minNights}`));
    assert.equal(s.nights, null);
    before = await rulesOf();
    s = await say('Not good enough');
    s = await say('Lower price');
    r = await store.getRecord('hunt', h.id);
    assert.ok(r.target !== null && r.target < h.budget, 'the chip moves the price target');
    assert.match(r.learned[r.learned.length - 1].text, /^Now looking under /);
    assert.equal(r.runs.length, before.runs + 1);
    assert.ok(!said(s).includes(`${LEFT} | ${LEFT}`), 'the lapse line is never doubled');

    // "5 nights is not enough, make it 7 nights" with a hunt on the conversation: the length asked for
    // is applied and the canvas rebuilt to it; the hunt is not asked about and not changed.
    before = await rulesOf();
    const spokenBefore = lines(s).length;
    s = await say('5 nights is not enough, make it 7 nights');
    assert.equal(s.nights, 7);
    assert.ok(s.current && decodeSpec(s.current.token).nights === 7, 'the canvas trip is the rebuilt 7-night trip');
    assert.ok(s.job && s.job.status !== 'running');
    assert.notEqual(s.pending, 'improve');
    const spokenAfter = lines(s).slice(spokenBefore);
    assert.ok(!spokenAfter.some(l => l.startsWith('What should I improve?')), `no hunt question was asked: ${spokenAfter.join(' | ')}`);
    assert.equal(spokenAfter[0], 'Got it: 7 nights.', spokenAfter.join(' | '));
    assert.deepEqual(await rulesOf(), before, 'the hunt is untouched by a change to the trip');

    // A sentence about dates that happens to say "I can wait" is about the trip: the month is applied
    // and nothing standing is created on the account. "I can wait" on its own is the hunt's own words.
    const w = { id: 'u-wait' };
    const w0 = await agent.create({ visitor: 'v-wait', userId: w.id, mission: true, mode: 'save' });
    const tell = ask(agent, w0.id, w);
    await tell('$1,500');
    let t = await tell('JFK');
    const t0 = today(agent.now());
    const december = [t0.slice(0, 4), String(Number(t0.slice(0, 4)) + 1)].map(y => `${y}-12`).find(m => m > t0.slice(0, 7));
    t = await tell('I can wait until December if it is cheaper then');
    assert.equal((await store.listRecords('hunt', { userId: w.id, limit: 10 })).length, 0, 'no hunt from a sentence about dates');
    assert.equal(t.mission.hunt, undefined);
    assert.equal(t.month, december); assert.equal(t.dateMode, 'flexible');
    assert.ok(!said(t).includes(HuntService.ACCEPTANCE), said(t));
    t = await tell('I can wait.');
    assert.equal((await store.listRecords('hunt', { userId: w.id, limit: 10 })).length, 1, '"I can wait" alone starts the hunt');
    assert.equal((await store.listRecords('hunt', { userId: w.id, limit: 10 }))[0].month, december, 'the hunt carries the month the conversation holds');
    // Anonymous, in one breath with the budget and a month: built, not sent to sign in for a hunt.
    const a0 = await agent.create({ visitor: 'v-anon-wait' });
    const anon = ask(agent, a0.id);
    const a = await anon('I have $2,000 from JFK, two of us, and I can wait for a good week in March');
    assert.doesNotMatch(said(a), /A hunt lives on your account/);
    assert.ok(a.current, 'the trip is built from the sentence');
    assert.equal(a.dateMode, 'flexible'); assert.match(a.month, /-03$/);
  } finally { await app.close(); }
});

test('hunt mode: the canvas shows the hunt as the record is now, never as the conversation last saw it: a stop made on the hunt page takes "Hunting" off the status, brings the chip back and marks the card stopped with no "keep waiting"; a resume there brings it back; a search running here and an open decision come before the hunt in the status', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, store = app.ctx.store;
    const c = client(app.base);
    const creds = { name: 'Ada Lovelace', email: 'hunter@example.com', password: 'correct horse battery' };
    assert.equal((await c.req('/signup', { method: 'POST', form: { ...creds, next: '/my-trips' } })).status, 303);
    const start = await c.req('/agent', { method: 'POST', form: { budget: '1,500', mode: 'save' } });
    const page = start.headers.get('location'), id = page.split('/').pop();
    await c.req(page, { method: 'POST', form: { say: 'JFK' } });
    await agent.jobs.drain();
    await c.req(page, { method: 'POST', form: { say: 'Hunt for a better deal' } });
    await agent.jobs.drain();
    let s = await agent.load(id);
    const user = { id: s.userId };
    const h = (await store.listRecords('hunt', { userId: s.userId, limit: 10 }))[0];
    assert.ok(h && h.status === 'hunting');
    // The canvas region alone: the chat above it carries the traveler's own "Hunt for a better deal".
    const canvasOf = html => text(html.slice(html.indexOf('id="live-canvas"')));
    const view = async () => { const html = (await c.req(page)).text; return { canvas: canvasOf(html), all: text(html) }; };
    const status = t => (t.match(/Build the best vacation for \$[\d,]+ (.*?) Budget/) || ['', ''])[1];
    const badge = t => (t.match(/My travel money · [^·]*? (HUNTING|STOPPED)/) || ['', ''])[1];
    if (s.proposal) { await c.req(page, { method: 'POST', form: { say: 'Keep what I have' } }); s = await agent.load(id); }
    assert.equal(s.proposal, null);
    let t = await view();
    assert.equal(status(t.canvas), `Hunting: ${h.name}`);
    assert.equal(badge(t.all), 'HUNTING');
    assert.ok(t.canvas.includes(`Hunting: ${h.name}`) && !t.canvas.includes('Hunt for a better deal'), 'the chip is the link to the hunt');
    assert.ok(t.all.includes('Keep waiting'));
    // Stopped from its own page (the hunt route's own answer): the conversation's ref is what the agent
    // last saw, but the page reads the record.
    await app.hunts.respond(user, h.id, 'stop');
    assert.equal((await agent.load(id)).mission.hunt.status, 'hunting', 'a page read never writes the conversation');
    t = await view();
    assert.notEqual(status(t.canvas), `Hunting: ${h.name}`);
    assert.ok(!/Hunting: /.test(t.canvas), 'a stopped hunt is not the status');
    assert.ok(t.canvas.includes('Hunt for a better deal'), 'the chip to start (resume) a hunt is back');
    assert.equal(badge(t.all), 'STOPPED');
    assert.ok(!t.all.includes('Keep waiting'), 'no answer is offered on a hunt that is not hunting');
    const live = (await c.req(`${page}/live`)).text;
    assert.equal(badge(text(live)), 'STOPPED');
    assert.ok(!/Hunting: /.test(canvasOf(live)));
    await app.hunts.respond(user, h.id, 'resume');
    t = await view();
    assert.equal(status(t.canvas), `Hunting: ${h.name}`);
    assert.equal(badge(t.all), 'HUNTING');
    // A rebuild running here comes first in the status, then the hunt again once it is done.
    let reached, release, held = false;
    const atGate = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    const breathe = agent.breathe;
    agent.breathe = async () => { if (held) return; held = true; reached(); await gate; };
    await c.req(page, { method: 'POST', form: { say: '7 nights' } });
    await atGate;
    s = await agent.load(id);
    assert.equal(s.job.status, 'running');
    t = await view();
    assert.equal(status(t.canvas), 'Building…');
    release();
    agent.breathe = breathe;
    await agent.jobs.drain();
    s = await agent.load(id);
    if (s.proposal) { await c.req(page, { method: 'POST', form: { say: 'Keep what I have' } }); s = await agent.load(id); }
    t = await view();
    assert.equal(status(t.canvas), `Hunting: ${h.name}`);
    // An open decision comes before the hunt too (when today's prices give one to make).
    await c.req(page, { method: 'POST', form: { say: 'How low can you go?' } });
    s = await agent.load(id);
    if (!s.proposal) { await c.req(page, { method: 'POST', form: { say: 'Find $50' } }); s = await agent.load(id); }
    if (s.proposal) {
      t = await view();
      assert.equal(status(t.canvas), 'One decision away');
      assert.ok(t.canvas.includes(`Hunting: ${h.name}`), 'the hunt is still linked from the canvas');
    }
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
