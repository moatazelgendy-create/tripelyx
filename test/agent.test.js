// The AI travel agent: words become a trip object, every answer comes from the engines, a build
// answers fast and keeps searching with real progress, nothing changes without approval, and the
// agent never books, never invents a fact and never claims a win it cannot support.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const optimizer = require('../server/trips/optimizer');
const { understand } = require('../server/agent/understand');
const state = require('../server/agent/state');
const { decodeSpec } = require('../server/trips/spec');

const inv = createTripIntegrations(loadConfig({ APP_ENV: 'development' }));
const maps = inv.maps;
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

function client(base) {
  const jar = {};
  const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = async (path, { method = 'GET', form, headers = {} } = {}) => {
    const h = { cookie: cookies(), 'sec-fetch-site': 'same-origin', ...headers };
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) { const [kv, ...rest] = sc.split(';'); const [k, v] = kv.split('='); if (!v || rest.some(x => /Max-Age=0/i.test(x))) delete jar[k]; else jar[k] = v; }
    const t = await res.text();
    return { status: res.status, location: res.headers.get('location'), text: t };
  };
  return { req, jar };
}

const last = s => s.messages[s.messages.length - 1];
const agentSays = s => s.messages.filter(m => m.role === 'agent').map(m => m.text).join(' | ');

test('understanding: the spec sentences become structured updates and intents, and nothing is guessed', () => {
  const u = understand('I have $2,000. Me and my girlfriend. Leaving from JFK. 5 nights. Beach. I hate connections.', {}, { maps });
  assert.equal(u.updates.budget, 200000);
  assert.equal(u.updates.who, 'couple'); assert.equal(u.updates.travelers, 2);
  assert.equal(u.updates.origin, 'NYC');
  assert.equal(u.updates.nights, 5);
  assert.equal(u.updates.style, 'beach');
  assert.equal(u.updates.flightStops, 'nonstop'); assert.equal(u.updates.flightRule, 'hard');
  assert.equal(u.updates.destination, undefined, 'no destination was named, none is invented');
  const r = understand('I have $2,000 total. Keep $500 for spending after I arrive.', {}, { maps });
  assert.equal(r.updates.protectedMoney, 50000); assert.equal(r.updates.budgetType, 'vacation');
  assert.equal(understand('Paris for max $1,500 from Boston in June, me and my wife', {}, { maps }).updates.destination, 'paris');
  assert.equal(understand('flying from Miami to Cancun', {}, { maps }).updates.origin, 'MIA');
  assert.equal(understand('flying from Miami to Cancun', {}, { maps }).updates.destination, 'cancun');
  const cmds = { 'Make it $200 cheaper.': ['cheaper', 20000], 'Take $100 back.': ['cheaper', 10000], 'Spend $100 if it actually helps.': ['better', null], "Don't change the hotel.": ['lock'], 'Give me one more night.': ['extend'], 'Only nonstop.': ['nonstopRule'], 'Try another country.': ['elsewhere'], 'Make this easier.': ['easier'], 'Show me what one stop saves.': ['stopSaves'], 'Can you beat this?': ['challenge'], "What's the catch?": ['catch'], 'Which one would you pick?': ['recommend'], 'Start over.': ['restart'] };
  for (const [sentence, [intent, amount]] of Object.entries(cmds)) {
    const out = understand(sentence, {}, { maps });
    assert.ok(out.intents.includes(intent), `${sentence} → ${out.intents}`);
    if (amount) assert.equal(out.updates.cheaperBy, amount);
  }
  assert.deepEqual(understand('Keep everything except the flight.', {}, { maps }).updates.locks, { hotel: true, flight: false, dates: true, nights: true, dest: true });
  assert.equal(understand('Price matters more. Take the connection.', {}, { maps }).updates.flightStops, 'any');
  // A pending question reads the answer in its light; gibberish is admitted, not interpreted.
  assert.equal(understand('500', { pending: 'reserve' }, { maps }).updates.protectedMoney, 50000);
  assert.equal(understand('the whole vacation', { pending: 'budgetType' }, { maps }).updates.budgetType, 'vacation');
  const g = understand('asdf qwerty', {}, { maps });
  assert.equal(g.unknown, true); assert.deepEqual(g.updates, {});
});

test('the trip object: a ceiling, a protected reserve, standing rules and locks drive the search, and the minimum question is asked', () => {
  const s = state.newState({ id: 'agt_test' });
  assert.equal(state.nextQuestion(s).key, 'budget');
  state.applyUpdates(s, understand('I have $3,000 from JFK, 5 nights, beach, only nonstop, 4-star', {}, { maps }).updates);
  assert.equal(state.nextQuestion(s).key, 'budgetType', 'booking only or whole vacation is the one question left');
  state.applyUpdates(s, { budgetType: 'vacation' });
  assert.equal(state.nextQuestion(s).key, 'reserve');
  state.applyUpdates(s, { protectedMoney: 50000 });
  assert.equal(state.nextQuestion(s), null);
  assert.equal(state.bookingBudget(s), 250000, 'the booking budget is the total minus the protected money');
  const { query: q, assumed } = state.toQuery(s, { maps });
  assert.equal(q.budget, 250000); assert.equal(q.keep, 50000); assert.equal(q.vacationBudget, 300000);
  assert.deepEqual(assumed, ['two travelers', 'flexible dates']);
  assert.equal(q.rules.nonstop, true); assert.equal(q.rules.minStars, 4);
  // Rules are kept by the optimizer: every package obeys them, and the URL round-trips them.
  const r = optimizer.search(inv, q, { settings: require('../server/trips/pricing').DEFAULT_SETTINGS });
  assert.ok(r.picks.length);
  for (const p of r.picks) { assert.equal(p.trip.flight.stops, 0); assert.ok(p.trip.hotel.stars >= 4); }
  const back = optimizer.parseSearch(Object.fromEntries(new URLSearchParams(optimizer.searchParams(q))), { maps }).query;
  assert.deepEqual(back.rules, q.rules);
  // A soft rule steers the ranking instead of filtering.
  state.applyUpdates(s, { flightStops: 'nonstop', flightRule: 'soft' });
  const soft = state.toQuery(s, { maps }).query;
  assert.ok(!soft.rules.nonstop, 'a soft nonstop preference is not a filter');
  assert.equal(soft.rules.minStars, 4, 'the hotel rule still is');
  assert.equal(soft.priority, 'flights');
  // Locks and unlocks.
  state.applyUpdates(s, { locks: { hotel: true, dates: true } });
  assert.deepEqual(state.lockedWords(s), ['Hotel', 'Dates']);
  state.applyUpdates(s, { unlocks: { hotel: true } });
  assert.deepEqual(state.lockedWords(s), ['Dates']);
});

test('a build answers fast, keeps searching, shows real progress, and never claims an exhaustive search it did not run', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-build' });
    await agent.say(s0.id, 'I have $2,000, two of us from JFK, 5 nights, beach, only nonstop. Booking budget.');
    await agent.jobs.drain();
    const s = await agent.load(s0.id);
    assert.equal(s.job.status, 'done');
    const steps = Object.fromEntries(s.job.steps.map(st => [st.key, st]));
    assert.equal(steps.understand.status, 'done');
    assert.equal(steps.fast.status, 'done'); assert.match(steps.fast.detail, /\d+ complete packages priced across \d destinations?/);
    assert.equal(steps.deep.status, 'done'); assert.match(steps.deep.detail, /across \d+ destinations/);
    assert.equal(steps.expand.status, 'skipped', 'widening is not run, and is shown as not run, when a trip fits');
    assert.ok(s.job.first && s.job.first.token, 'a first strong match was found on the fast path');
    assert.ok(s.job.best, 'the deep search produced a best current match');
    assert.ok(s.job.firstAtMs !== null && s.job.bestAtMs !== null && s.job.bestAtMs >= s.job.firstAtMs, 'real timestamps, first before best');
    assert.ok(s.current, 'the first match went on the canvas at once');
    for (const o of s.options) assert.equal(decodeSpec(o.token).travelers, 2);
    const said = agentSays(s);
    assert.match(said, /First strong match/);
    assert.match(said, /Still checking whether I can beat this/);
    assert.ok(/my first option holds|I beat my first option/.test(said), 'the deep result is reported either way');
    assert.doesNotMatch(said, /only \d+ left|selling fast|\d+ people (are )?looking/i, 'no fake scarcity');
    // A proposal to switch is never applied by itself.
    if (s.job.improved) { assert.equal(s.proposal.kind, 'switch'); assert.equal(s.current.token, s.job.first.token); }
    // Nothing fits: the job widens one rule at a time and says what each relaxation really produces.
    const s1 = await agent.create({ visitor: 'v-none' });
    await agent.say(s1.id, 'I have $1,500 for two from JFK, 5 nights, beach, only nonstop, 5-star. Booking budget.');
    await agent.jobs.drain();
    const n = await agent.load(s1.id);
    assert.equal(n.job.status, 'done');
    assert.equal(n.current, null);
    assert.equal(Object.fromEntries(n.job.steps.map(st => [st.key, st.status])).expand, 'done');
    assert.match(agentSays(n), /Nothing fits/);
    assert.ok(n.job.relax && n.job.relax.works.length, 'relaxations were priced, and one rule away gets there');
    assert.equal(last(n).card.kind, 'relax');
    for (const w of n.job.relax.works) assert.ok(w.total > 0 && w.say, 'each relaxation carries a real priced trip and the words that accept it');
    assert.ok(n.job.relax.works.every(w => w.total <= 150000), 'every relaxation offered really lands inside the budget');
  } finally { await app.close(); }
});

test('negotiation: cheaper and better come from priced versions, honor locks, challenge a bad trade once, and never act without approval', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-neg' });
    await agent.say(s0.id, 'I have $2,000, two of us from JFK, 5 nights, beach. Booking budget.');
    await agent.jobs.drain();
    let s = await agent.load(s0.id);
    const before = s.current.token;
    // One more night is priced and proposed, not applied.
    await agent.say(s0.id, 'Give me one more night.');
    s = await agent.load(s0.id);
    assert.equal(s.proposal.kind, 'nights'); assert.equal(decodeSpec(s.proposal.token).nights, 6);
    assert.equal(s.current.token, before, 'nothing changed without approval');
    assert.equal(s.nights, 5, 'what the traveler asked for is not rewritten by a proposal');
    await agent.say(s0.id, 'keep it');
    s = await agent.load(s0.id);
    assert.equal(s.proposal, null); assert.equal(s.current.token, before);
    // Make it cheaper respects a hotel lock: every version keeps the hotel.
    await agent.say(s0.id, "Don't change the hotel.");
    await agent.say(s0.id, 'Make it $100 cheaper.');
    s = await agent.load(s0.id);
    const hotel = decodeSpec(before).hotel;
    if (s.proposal) assert.equal(decodeSpec(s.proposal.token).hotel, hotel, 'the locked hotel stays');
    assert.match(last(s).text, /hotel locked|can't find|cheapest version|only reach|take .* off/i);
    // Approval applies the proposal and shows before and after; a decline leaves it.
    if (s.proposal) {
      await agent.say(s0.id, 'take it');
      s = await agent.load(s0.id);
      assert.notEqual(s.current.token, before);
      assert.equal(last(s).card.kind, 'diff');
      assert.ok(last(s).card.before && last(s).card.after);
    }
    // Make it better: either a priced improvement with nothing given up, or "keep the money".
    await agent.say(s0.id, 'Spend $100 if it actually helps.');
    s = await agent.load(s0.id);
    if (s.proposal) { assert.equal(s.proposal.kind, 'better'); assert.ok(s.proposal.delta <= 10000); assert.equal(s.proposal.tradeoffs.length, 0); }
    else assert.match(last(s).text, /don't see a strong reason|Keep it/);
    // The ceiling: a version over budget is flagged and needs an explicit "go over".
    s.budget = s.current.total + 1000; s.budgetType = 'booking'; await agent.save(s);
    await agent.say(s0.id, 'Give me one more night.');
    s = await agent.load(s0.id);
    if (s.proposal) {
      assert.equal(s.proposal.over, true);
      await agent.say(s0.id, 'take it');
      s = await agent.load(s0.id);
      assert.ok(s.proposal, 'a plain yes does not cross the ceiling');
      assert.match(last(s).text, /over your .* ceiling/);
      await agent.say(s0.id, 'go over');
      s = await agent.load(s0.id);
      assert.equal(s.proposal, null); assert.equal(s.overApproved, true);
    }
    // A stop is never shown as a switch while the nonstop rule is hard.
    await agent.say(s0.id, 'Only nonstop.');
    await agent.say(s0.id, 'Show me what one stop saves.');
    s = await agent.load(s0.id);
    assert.match(last(s).text, /allow one stop|no nonstop|nonstop/i);
    assert.ok(!s.proposal || s.proposal.kind !== 'flight' || decodeSpec(s.proposal.token).flight !== 'basic', 'no one-stop proposal under a hard nonstop rule');
    // Start over clears everything; a bare approval with nothing pending says so.
    await agent.say(s0.id, 'Start over.');
    s = await agent.load(s0.id);
    assert.equal(s.current, null); assert.equal(s.budget, null);
    await agent.say(s0.id, 'yes');
    s = await agent.load(s0.id);
    assert.match(last(s).text, /Nothing is waiting/);
  } finally { await app.close(); }
});

test('honesty: no win with unknowns, the contract names what is not as asked, and the agent never books', async () => {
  const app = await startApp();
  try {
    const agent = app.agent;
    const s0 = await agent.create({ visitor: 'v-honest' });
    await agent.say(s0.id, 'I have $2,000, two of us from JFK, 5 nights in Cancun. Booking budget.');
    await agent.jobs.drain();
    await agent.say(s0.id, 'Can you beat this? I found it for $1,300.');
    let s = await agent.load(s0.id);
    const v = last(s).card;
    assert.equal(v.kind, 'verdict');
    assert.equal(v.state, 'info', 'unknown attributes mean no verdict either way');
    assert.doesNotMatch(last(s).text, /We beat it|we saved you/i);
    assert.match(last(s).text, /won't claim a win/);
    // Book: a contract, a link to the live price check, no quote and no charge from the agent.
    const bookings = (await app.store.listBookings({ limit: 10 })).length;
    await agent.say(s0.id, 'Only nonstop.');
    s = await agent.load(s0.id);
    if (s.proposal) await agent.say(s0.id, 'keep it');
    await agent.say(s0.id, 'Book it');
    s = await agent.load(s0.id);
    const c = last(s).card;
    assert.equal(c.kind, 'contract');
    assert.match(c.href, /^\/trip\/.+\/review\?/);
    assert.ok(c.asked.some(([k]) => k === 'Flights'), 'what was asked for is listed');
    assert.ok(c.getting.some(([k]) => k === 'Total, everything included'));
    const cur = await app.tripService.price(decodeSpec(s.current.token));
    if (cur.flight.stops > 0) assert.ok(c.unmet.some(u => /not nonstop/.test(u)), 'a stated rule the trip does not meet is named, never silent');
    assert.equal((await app.store.listBookings({ limit: 10 })).length, bookings, 'the agent created no booking');
    assert.equal((await app.store.listRecords('quote', { limit: 10 })).length, 0, 'and no quote');
  } finally { await app.close(); }
});

test('pages: the homepage leads with the agent, a conversation has a page, a live region and an owner, and progress is real while a slow search runs', async () => {
  const app = await startApp();
  try {
    const c = client(app.base);
    const home = await c.req('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /What do you want.*your trip to do\?/s);
    assert.match(home.text, /action="\/agent"/);
    assert.match(home.text, /action="\/challenge"/);
    assert.match(home.text, /Challenge us/);
    assert.equal((await c.req('/agent')).status, 200);
    // The job is held between its fast and deep phases, the way slow suppliers would hold it, so the
    // page can be looked at mid-search: a real first match, real phases, nothing invented.
    let reached, release;
    const atGate = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    let breaths = 0;
    app.agent.breathe = async () => { breaths += 1; if (breaths === 2) { reached(); await gate; } };
    let r = await c.req('/agent', { method: 'POST', form: { say: 'I have $2,000, two of us from JFK, 5 nights, beach, only nonstop. Booking budget.' } });
    assert.equal(r.status, 303); assert.match(r.location, /^\/agent\/agt_/);
    const page = r.location;
    await atGate;
    const mid = await c.req(page);
    assert.equal(mid.status, 200);
    assert.match(mid.text, /data-running="1"/);
    assert.match(mid.text, /http-equiv="refresh"/, 'without JavaScript the page refreshes itself while the job runs');
    const midText = text(mid.text);
    assert.match(midText, /First strong match: 5 nights in/);
    assert.match(midText, /Still checking whether I can beat this/);
    assert.match(mid.text, /<li class="is-done">[^]*?Searching the likeliest destinations first[^]*?\d+ complete packages priced across \d destinations?/);
    assert.match(mid.text, /<li class="is-pending">[^]*?Checking every destination/);
    assert.doesNotMatch(midText, /\d+% (done|complete)/, 'no invented percentages');
    assert.match(midText, /Total, everything included \$[\d,]+\.\d\d/, 'the first match is on the canvas already');
    release();
    await app.agent.jobs.drain();
    const live = await c.req(`${page}/live`);
    assert.equal(live.status, 200);
    assert.match(live.text, /data-running="0"/);
    assert.match(live.text, /id="live-canvas"/);
    assert.match(text(live.text), /Checked all \d+ destinations/);
    assert.match(text(live.text), /Searched \d+ complete packages across \d+ destinations in \d+\.\d s\. First match at \d+\.\d s\./);
    const done = await c.req(page);
    assert.doesNotMatch(done.text, /http-equiv="refresh"/);
    assert.doesNotMatch(done.text, /<script>|style="/, 'no inline scripts or styles (strict CSP)');
    // Buttons say things: a cheaper ask, then the booking contract with its review link.
    r = await c.req(page, { method: 'POST', form: { say: 'Make it cheaper' } });
    assert.equal(r.status, 303);
    r = await c.req(page, { method: 'POST', form: { say: 'Book it' } });
    const booked = await c.req(page);
    assert.match(booked.text, /ag-contract/);
    assert.match(booked.text, /href="\/trip\/[^"]+\/review\?[^"]*seen=\d+"/);
    // Another visitor cannot read it; a bad id is not found.
    const other = await fetch(app.base + page, { redirect: 'manual' });
    assert.equal(other.status, 404);
    assert.equal((await c.req('/agent/agt_nope')).status, 404);
  } finally { await app.close(); }
});

test('after booking: the booking page offers the agent, and its answers come from the booking itself', async () => {
  const app = await startApp();
  try {
    const c = client(app.base);
    const results = await c.req('/trips?' + new URLSearchParams({ b: '1500', k: '0', from: 'SFO', who: 'couple', when: 'anytime', nights: '5', style: 'beach', prio: 'hotel' }));
    const m = results.text.match(/href="(\/trip\/[^"?]+)\?([^"]*)"/);
    const tripPath = m[1], cx = m[2].replace(/&amp;/g, '&');
    const review = await c.req(`${tripPath}/review?${cx}&seen=0`);
    const approvedTotal = Number(review.text.match(/name="approvedTotal" value="(\d+)"/)[1]);
    const cxField = review.text.match(/name="cx" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
    const q = await c.req(`${tripPath}/quote`, { method: 'POST', form: { approvedTotal, cx: cxField, promo: '' } });
    const quoteId = q.location.split('/').pop();
    await c.req(q.location);
    const created = await fetch(app.base + '/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json', cookie: Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: JSON.stringify({ quoteId, traveler: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' } }) });
    assert.equal(created.status, 201);
    const b = (await created.json()).booking;
    for (const sc of created.headers.getSetCookie()) { const [kv] = sc.split(';'); const [k, v] = kv.split('='); c.jar[k] = v; }
    const paid = await fetch(app.base + `/api/bookings/${b.ref}/pay`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: JSON.stringify({ method: { type: 'test_card', number: '4242424242424242', expMonth: '12', expYear: '35', cvc: '123', name: 'Ada Lovelace' } }) });
    assert.equal(paid.status, 200, await paid.text());
    const page = await c.req(`/booking/${b.ref}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Ask your travel agent/);
    assert.match(page.text, new RegExp(`name="ref" value="${b.ref}"`));
    const r = await c.req('/agent', { method: 'POST', form: { ref: b.ref, say: 'What if I cancel?' } });
    assert.equal(r.status, 303);
    const conv = await c.req(r.location);
    const t = text(conv.text);
    assert.match(t, /If you cancel now you get \$[\d,.]+ back/);
    assert.match(t, /Nothing is cancelled unless you do it yourself/);
    const s = await app.agent.load(r.location.split('/').pop());
    assert.equal(s.booking.ref, b.ref);
    await app.agent.say(s.id, 'Do I need a car?');
    assert.match(last(await app.agent.load(s.id)).text, /I don't know yet/);
    await app.agent.say(s.id, 'What do I need to do next?');
    assert.equal(last(await app.agent.load(s.id)).card.kind, 'facts');
    const booking = await app.store.getBookingByRef(b.ref);
    assert.equal(booking.status, 'confirmed', 'the agent changed nothing on the booking');
  } finally { await app.close(); }
});
