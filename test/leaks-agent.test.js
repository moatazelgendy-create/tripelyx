// The money leak hunter in conversation: "what am I paying for", strip it down, add back, remove one
// thing, the biggest leak, free savings apart from trade-off savings, the scan before "book it", the
// scorecard after applied steps, and the saver's victory on the post-booking canvas. Every number the
// agent says is asserted against priceTrip through the service, never against a figure typed here;
// every removal is a proposal the traveler takes or keeps; nothing is removed or preselected by itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { loadConfig } = require('../server/config');
const { createTripIntegrations } = require('../server/trips/integrations');
const { decodeSpec, encodeSpec } = require('../server/trips/spec');
const { classifyChanges, lineAmount } = require('../server/trips/facts');
const savemax = require('../server/trips/savemax');
const leaks = require('../server/trips/leaks');
const state = require('../server/agent/state');
const { understand } = require('../server/agent/understand');
const { bookingHome } = require('../server/agent/home');
const { agentView } = require('../server/views/trips/agent');
const { money } = require('../server/views/trips/common');
const optimizer = require('../server/trips/optimizer');
const { addDays, today } = require('../server/lib/dates');

// The pressure regex the pages tests use, widened with the engine contract's own list.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict)\b/i;
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/\s+/g, ' ');
const VISITOR = 'v-leaks-agent-000001'; // the visitor cookie's own shape, so the page can be read back
const last = s => s.messages[s.messages.length - 1];
const said = s => s.messages.filter(m => m.role === 'agent').map(m => m.text).join(' | ');
const lastSaid = s => said(s).split(' | ').pop();
const cards = (s, kind) => s.messages.filter(m => m.card && m.card.kind === kind).map(m => m.card);
const lastIdx = (s, kind) => s.messages.map(m => (m.card ? m.card.kind : null)).lastIndexOf(kind);
const linkContext = href => optimizer.parseContext(Object.fromEntries(new URLSearchParams(String(href).split('?')[1] || '')));
const rowWords = rows => rows.map(r => `${r.label.toLowerCase()}: ${r.a} → ${r.b}`);
const ask = (agent, id) => async t => { await agent.say(id, t); await agent.jobs.drain(); return agent.load(id); };
const sum = xs => xs.reduce((n, x) => n + x, 0);
const PURE = new Set(['Removed experiences', 'Removed transfer', 'Removed checked bags']);

test('understanding: the money-leak sentences become their intents and never a price cut or a rebuild; chips name items, not facts; the cut amount is never a budget', () => {
  const maps = createTripIntegrations(loadConfig({ APP_ENV: 'development' })).maps;
  const cases = { 'What am I paying for?': 'paying', 'Break the price down': 'paying', 'Where does my money go?': 'paying', 'Strip it down': 'strip', 'Give me the lean version': 'strip', 'Show me the lean version': 'strip', 'Add back what\'s worth it': 'addBack', 'Remove one thing': 'removeOne', 'Find my biggest leak': 'biggestLeak', 'What am I wasting?': 'biggestLeak', 'Money leak check': 'leakScan', 'Am I paying for anything I don\'t need?': 'leakScan', 'Cut $200 in order': 'cutInOrder', 'Trim $150': 'cutInOrder', 'Free savings': 'freeSavings', 'Savings scorecard': 'scorecard', 'My savings check': 'scorecard' };
  for (const [sentence, intent] of Object.entries(cases)) {
    const u = understand(sentence, {}, { maps });
    assert.ok(u.intents.includes(intent), `${sentence} → ${u.intents}`);
    for (const k of ['cheaper', 'better', 'build']) assert.ok(!u.intents.includes(k), `${sentence} is not ${k}`);
  }
  // The amount to cut is the words' number in cents, never the budget and never the decision layer's price cut.
  const cut = understand('Cut $200 in order', {}, { maps });
  assert.equal(cut.updates.cutBy, 20000); assert.equal(cut.updates.budget, undefined); assert.equal(cut.updates.cheaperBy, undefined);
  const trim = understand('Trim $2,000', {}, { maps });
  assert.equal(trim.updates.cutBy, 200000); assert.equal(trim.updates.budget, undefined);
  assert.equal(understand('Cut it in order', {}, { maps }).updates.cutBy, null);
  // A chip that names an item never changes the trip object: "Airport transfer" is not a transfer rule, "Beach" is not a style.
  const ab = understand('Add back Airport transfer, both ways', {}, { maps });
  assert.deepEqual(ab.intents, ['addBack']); assert.deepEqual(ab.updates, {}); assert.deepEqual(ab.ack, []);
  // "Show me the <alternative> version" is the biggest-leak chip only in the card's own words: the three
  // fixed forms, or the alternative label of the leak card on the canvas; with that card it names an
  // item, never a fact. Any other "show me the <X> version" keeps its meaning, so a rule in it is set
  // and a cheaper ask stays a cheaper ask, never swallowed into the card.
  const onCard = { messages: [{ role: 'agent', card: { kind: 'leak', alternativeLabel: 'Beach Palace Cancun' } }] };
  const sv = understand('Show me the Beach Palace Cancun version', onCard, { maps });
  assert.deepEqual(sv.intents, ['leakVersion']); assert.deepEqual(sv.updates, {});
  const noCard = understand('Show me the Beach Palace Cancun version', {}, { maps });
  assert.ok(!noCard.intents.includes('leakVersion'), 'no leak card on the canvas: the words are not its chip');
  for (const w of ['Show me the version without it', 'Show me the like-for-like version', `Show me the version leaving ${addDays(today(), 30)}`]) assert.deepEqual(understand(w, {}, { maps }).intents, ['leakVersion'], w);
  assert.ok(!understand('Show me the lean version', {}, { maps }).intents.includes('leakVersion'), 'the lean version is the strip flow\'s');
  const cheaperV = understand('Show me the cheaper version', onCard, { maps });
  assert.ok(cheaperV.intents.includes('cheaper') && !cheaperV.intents.includes('leakVersion'), 'a cheaper ask is a cheaper ask');
  const nonstopV = understand('Show me the nonstop version', onCard, { maps });
  assert.ok(!nonstopV.intents.includes('leakVersion') && nonstopV.updates.flightStops === 'nonstop' && nonstopV.updates.flightRule === 'hard', 'the rule is set, never dropped');
  assert.equal(understand('Show me the 4-star version', onCard, { maps }).updates.minStars, 4);
  assert.equal(understand('Show me the all-inclusive version', onCard, { maps }).updates.hotelAllInclusive, true);
  // "Every dollar" is the breakdown only about this price; with "cheaper" it is a cheaper ask.
  const ed = understand('Make it cheaper, every dollar counts', {}, { maps });
  assert.ok(ed.intents.includes('cheaper') && !ed.intents.includes('paying'), ed.intents);
  assert.ok(understand('Where does every dollar go?', {}, { maps }).intents.includes('paying'));
  assert.ok(understand('Show me every dollar of this', {}, { maps }).intents.includes('paying'));
  // The cut amount is the number after "cut" or "trim", never the first number in the sentence.
  assert.equal(understand('I have 2 people, cut $200 in order', {}, { maps }).updates.cutBy, 20000);
  // The answer to "how much do you want to cut?" is the amount to cut, in cents, never a budget.
  for (const [a, cents] of [['$200', 20000], ['200', 20000], ['cut 150 dollars', 15000], ['$1,250.50', 125050]]) {
    const c = understand(a, { pending: 'cutBy' }, { maps });
    assert.equal(c.updates.cutBy, cents, a); assert.equal(c.updates.budget, undefined, a); assert.ok(c.intents.includes('cutInOrder'), a);
  }
  assert.equal(understand('$200', {}, { maps }).updates.budget, 20000, 'a bare number with nothing pending is still a budget');
  assert.equal(understand('never mind', { pending: 'cutBy' }, { maps }).updates.cutBy, undefined);
  // Approvals that name a version, and the words that are their own ask.
  for (const w of ['Remove it', 'Remove $48', 'Remove $1,500.75', 'Take it out', 'Strip it', 'Take the lean version', 'take the lean', 'Take the free savings', 'Take the trade-off version', 'Take the cut']) assert.ok(understand(w, {}, { maps }).intents.includes('approve'), w);
  assert.equal(understand('Remove $148', {}, { maps }).updates.budget, undefined, 'the amount of a removal is never a budget');
  for (const w of ['Strip it', 'Take the lean', 'Take the lean version']) assert.ok(understand(w, {}, { maps }).intents.includes('strip'), `${w} is also the strip flow's`);
  for (const w of ['Keep it', 'Keep the $48', 'Keep what I have']) assert.ok(understand(w, {}, { maps }).intents.includes('decline'), w);
  assert.ok(!understand('Remove one thing', {}, { maps }).intents.includes('approve'), 'remove one thing is a question, not an approval');
  assert.ok(understand('Take the trade-off version', {}, { maps }).intents.includes('freeSavings'));
  assert.ok(understand('Take the free savings', {}, { maps }).intents.includes('freeSavings'));
  // What the data cannot compare is its own intent and never the checkout, a cheaper version or another place.
  for (const q of ['Is it cheaper if I book the hotel separately on another site?', 'Would two one-way tickets be cheaper?', 'Do you have a promo code or coupon for this?', 'Can I use my airline points on this?', 'How much is this in euros?', 'Is there a seat selection fee?', 'Does the hotel charge for parking?', 'Is the package cheaper than booking separately?', 'Should I book the flights directly with the airline?']) {
    const u = understand(q, {}, { maps });
    assert.ok(u.intents.includes('notCompared'), `${q} → ${u.intents}`);
    for (const k of ['book', 'cheaper', 'better', 'elsewhere', 'build']) assert.ok(!u.intents.includes(k), `${q} is not ${k}`);
  }
  assert.deepEqual(understand('Book it', {}, { maps }).intents, ['book']);
  const ch = understand('I found this trip for $1,800 on another site. Can you beat it?', {}, { maps });
  assert.ok(ch.intents.includes('challenge') && !ch.intents.includes('notCompared'), 'a quote to beat is a challenge');
});

test('the money leak hunter in conversation: breakdown, the scan before paying, remove one, strip it down, add back, the biggest leak, free apart from trade-off, cut in order, the scorecard, and a page without pressure', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, svc = app.ctx.tripService, inv = svc.inv;
    const settings = await agent.settings();
    const s0 = await agent.create({ visitor: VISITOR });
    const say = ask(agent, s0.id);
    let s = await say('I have $2,500, two of us from JFK, 5 nights, beach. Booking budget.');
    assert.ok(s.current, 'a trip is on the canvas');
    assert.equal(s.job.status, 'done');
    const priced = async token => (await svc.price(decodeSpec(token))).total;
    // The canvas loaded with everything optional, through the same customizer the trip page uses: two
    // experiences (not the beach kind, which the beach ask makes worth keeping, when others exist), the
    // transfer, and a bought checked bag on a fare that sells one. Every total is priceTrip's.
    const t0 = (await svc.trip(s.current.token, {})).trip;
    const fare = !t0.flight.checkedBagIncluded && t0.flight.bagFeePerTraveler > 0 ? t0.flight : (t0.flightOptions.find(f => !f.checkedBagIncluded && f.bagFeePerTraveler > 0) || t0.flight);
    const acts = [...t0.activityOptions.filter(a => a.kind !== 'beach'), ...t0.activityOptions.filter(a => a.kind === 'beach')].slice(0, 2).map(a => a.id);
    const loadedToken = svc.customize(s.current.token, { flight: fare.id, transfer: '1', bags: '1', activities: acts });
    const loaded = await svc.price(decodeSpec(loadedToken));
    assert.ok(loaded && loaded.activities.length === 2 && loaded.transfer, 'the canvas trip carries two experiences and the transfer');
    await agent.withState(s0.id, st => { st.current = { token: encodeSpec(loaded.spec), total: loaded.total, since: agent.now().toISOString() }; st.proposal = null; st.pending = null; st.history = []; });
    s = await agent.load(s0.id);
    const loadedTok = encodeSpec(loaded.spec);
    const budget = state.bookingBudget(s);
    assert.equal(budget, 250000);

    // 1. What am I paying for: rows that sum to the canvas total, the optional part named, nothing changed.
    s = await say('What am I paying for?');
    const bd = cards(s, 'breakdown').pop();
    assert.ok(bd, 'the breakdown card');
    assert.equal(sum(bd.rows.map(r => r.amount)), s.current.total, 'rows sum to the canvas total');
    assert.equal(bd.total, s.current.total);
    assert.equal(bd.optionalTotal, lineAmount(loaded, 'experiences') + lineAmount(loaded, 'transfer') + lineAmount(loaded, 'bags'));
    assert.match(lastSaid(s), /No mystery line items/);
    assert.match(lastSaid(s), new RegExp(`The ${money(bd.optionalTotal).replace(/[$.]/g, '\\$&')} of optional extras is the only part you could take out`));
    assert.equal(s.current.token, loadedTok, 'nothing changed');
    assert.equal(s.proposal, null);

    // 2. "Book it" runs the money leak check: the loaded trip carries an item nothing stated asks for, so
    // it is proposed, never removed; "keep it" declines it once, and the next "book it" reaches the
    // contract with that token not proposed again, the scorecard before the contract.
    s = await say('Book it');
    assert.ok(s.proposal && s.proposal.savingsScan && s.proposal.kind === 'leak', 'the scan proposes the leak');
    const scan = cards(s, 'scan').pop();
    assert.ok(scan && scan.found && scan.found.token === s.proposal.token && scan.kept === false);
    assert.deepEqual(scan.checks.map(c => c.key), ['addons', 'duplicates', 'bags', 'transport', 'fees', 'config']);
    assert.equal(scan.found.total, await priced(scan.found.token), 'the found version is priced');
    assert.equal(scan.found.amount, loaded.total - scan.found.total, 'the amount is the difference of two totals');
    assert.equal(s.proposal.total, scan.found.total); assert.equal(s.proposal.delta, scan.found.total - loaded.total);
    assert.equal(cards(s, 'contract').length, 0, 'no contract until the decision');
    // The scan's own sentence, as the engine wrote it (MONEY LEAK CHECK COMPLETE leads it), then the ask.
    assert.ok(lastSaid(s).startsWith(scan.text), 'the engine\'s sentence, verbatim');
    assert.match(lastSaid(s), /^MONEY LEAK CHECK COMPLETE\. I found one more optional \$[\d,.]+ you can remove: .+\. Remove it, or keep it; then say "book it" again\.$/);
    // The proposal is worded by what its version is: the found token keeps the fare, hotel and dates and
    // only the item comes out, so it is a removal, "Without <item>", and the item is named as coming
    // out; a bag add-on that comes out is never "same bags, cheaper fare". An engine note (a promo
    // code the removal ends) travels with the words.
    const foundSpec = decodeSpec(scan.found.token);
    assert.equal(foundSpec.flight, loaded.spec.flight); assert.equal(foundSpec.hotel, loaded.spec.hotel); assert.equal(foundSpec.depart, loaded.spec.depart);
    assert.equal(s.proposal.label, `Without ${scan.found.label}`);
    assert.deepEqual(s.proposal.neutral, [`${scan.found.label} comes out`, ...(scan.found.note ? [scan.found.note[0].toUpperCase() + scan.found.note.slice(1)] : [])]);
    assert.ok(!JSON.stringify(s.proposal).includes('same bags'));
    assert.equal(s.current.token, loadedTok, 'nothing removed');
    // The reminder names the removal as a version, never as if the item itself were the thing to take.
    s = await say('Stop searching');
    assert.ok(lastSaid(s).includes(`take the version without ${scan.found.label.toLowerCase()} or keep what you have`), lastSaid(s));
    assert.ok(s.proposal && s.proposal.token === scan.found.token, 'still on the table');
    const declined = s.proposal.token;
    s = await say('Keep it');
    assert.equal(s.proposal, null); assert.equal(s.declinedLeak, declined); assert.equal(s.current.token, loadedTok);
    s = await say('Book it');
    assert.equal(s.proposal, null, 'the declined leak is not proposed again');
    assert.ok(cards(s, 'contract').length, 'the contract follows');
    // The kept item: the engine's sentence again, verbatim and led by MONEY LEAK CHECK COMPLETE, with
    // the kept item said after it; the scan card (no Remove button) comes before the scorecard, which
    // comes before the contract.
    const scanKept = cards(s, 'scan').pop();
    assert.ok(scanKept.kept === true && scanKept.found.token === declined);
    const scanMsg = s.messages[lastIdx(s, 'scan')];
    assert.ok(scanMsg.text.startsWith(scanKept.text), 'the engine\'s sentence, verbatim');
    assert.match(scanMsg.text, /^MONEY LEAK CHECK COMPLETE\. I found one more optional \$[\d,.]+ you can remove: .+\. That is the one you chose to keep, so your trip stands at \$[\d,.]+\.$/);
    assert.ok(scanMsg.text.includes(`stands at ${money(loaded.total)}.`));
    assert.ok(lastIdx(s, 'scan') < lastIdx(s, 'scorecard') && lastIdx(s, 'scorecard') < lastIdx(s, 'contract'), 'scan, then scorecard, then contract');
    assert.match(lastSaid(s), /^Here is what you asked for against what you are getting\./);
    // The review link carries only what was stated: no bag, no destination, the 5 nights asked.
    const cxLink = linkContext(cards(s, 'contract').pop().href);
    assert.equal(cxLink.bags, null); assert.equal(cxLink.dest, null); assert.equal(cxLink.nightsAsked, 5); assert.equal(cxLink.dateMode, null); assert.equal(cxLink.budget, budget);
    const sc0 = cards(s, 'scorecard').pop();
    assert.ok(sc0, 'the scorecard comes with the contract');
    assert.equal(sc0.current, loaded.total); assert.equal(sc0.max, budget);
    if (loaded.total <= budget) assert.equal(sc0.notUsed, budget - loaded.total); else assert.equal(sc0.over, loaded.total - budget);
    assert.deepEqual(sc0.mixed, []); assert.equal(sc0.note, null, 'no step applied yet: nothing to subtract');

    // 3. Remove one thing: the lowest-value item by what was stated, its saving the priced difference;
    // "remove it" applies it and the history records the step.
    s = await say('Remove one thing');
    assert.ok(s.proposal && s.proposal.kind === 'removeOne', 'a proposal, not a removal');
    const r1 = s.proposal;
    assert.equal(r1.total, await priced(r1.token)); assert.equal(r1.delta, r1.total - loaded.total); assert.ok(r1.delta < 0);
    assert.match(lastSaid(s), /^I'd remove .+\. Save \$[\d,.]+\. Everything else remains\. Remove it, or keep it\.$/);
    assert.ok(lastSaid(s).includes(`Save ${money(-r1.delta)}.`), 'the saving said is the priced difference');
    const curA = await agent.currentTrip(s);
    const engine = leaks.removeOne(inv, curA.trip, settings, curA.ctx, agent.leakOpts(s));
    assert.equal(r1.token, engine.token, 'the engine\'s own choice');
    assert.equal(s.current.token, loadedTok);
    s = await say('Remove it');
    assert.equal(s.current.token, r1.token); assert.equal(s.current.total, r1.total);
    assert.equal(s.history.length, 2); assert.equal(s.history[0].label, 'Start'); assert.equal(s.history[1].label, r1.label); assert.equal(s.history[1].token, r1.token);
    const afterOne = await svc.price(decodeSpec(r1.token));

    // 4. Strip it down: the lean total is priceTrip of the lean token, same flights, hotel, dates and nights;
    // "keep it" leaves the canvas; the second time, "take the lean version" applies it and is recorded.
    s = await say('Strip it down');
    const lc = cards(s, 'lean').pop();
    assert.ok(lc, 'the lean card');
    assert.equal(lc.lean.total, await priced(lc.lean.token), 'lean total = priceTrip of the lean token');
    assert.equal(lc.current.total, afterOne.total); assert.equal(lc.difference, afterOne.total - lc.lean.total); assert.ok(lc.difference > 0);
    assert.ok(lc.givesUp.length >= 2, 'what you give up is listed');
    assert.ok(lc.kept.some(k => /^Round-trip flights \(/.test(k)) && lc.kept.some(k => /^\d nights at /.test(k)) && lc.kept.includes('Taxes, mandatory fees and the service fee'));
    assert.deepEqual(lc.notKept, [], 'no rule was stated, so none is unmet'); assert.ok(!lc.kept.some(k => /a rule you set/.test(k)));
    const leanSpec = decodeSpec(lc.lean.token);
    assert.equal(leanSpec.hotel, loaded.spec.hotel); assert.equal(leanSpec.flight, loaded.spec.flight); assert.equal(leanSpec.depart, loaded.spec.depart); assert.equal(leanSpec.nights, loaded.spec.nights);
    assert.deepEqual(leanSpec.activities, []); assert.equal(leanSpec.transfer, false); assert.equal(leanSpec.bags, false);
    assert.ok(lc.addBack.length >= 1, 'add back what\'s worth it comes with the card');
    for (const a of lc.addBack) {
      assert.ok(['worth', 'keep'].includes(a.verdict));
      assert.equal(a.total, await priced(a.token)); assert.equal(a.cost, a.total - lc.lean.total);
      assert.ok(a.text.startsWith(`+${money(a.cost)} ${a.label}: ${a.verdict === 'worth' ? 'WORTH CONSIDERING' : `I'D KEEP THE ${money(a.cost)}`}`), a.text);
    }
    assert.ok(s.proposal && s.proposal.kind === 'lean' && s.proposal.token === lc.lean.token && s.proposal.total === lc.lean.total);
    assert.deepEqual(s.proposal.tradeoffs, lc.givesUp);
    assert.match(lastSaid(s), /^Current \$[\d,.]+\. Lean \$[\d,.]+\. Difference \$[\d,.]+\. What you give up: /);
    s = await say('Keep it');
    assert.equal(s.proposal, null); assert.equal(s.current.token, r1.token, 'keep it leaves the canvas unchanged'); assert.equal(s.history.length, 2);
    // An old "Take the lean version" chip with nothing on the table prices the lean version again and
    // proposes it, never applies it; taken, it is applied and recorded.
    s = await say('Take the lean version');
    assert.ok(s.proposal && s.proposal.token === lc.lean.token, 'proposed again, not applied'); assert.equal(s.current.token, r1.token);
    s = await say('Take the lean version');
    assert.equal(s.current.token, lc.lean.token); assert.equal(s.current.total, lc.lean.total);
    assert.equal(s.leanOf, r1.token, 'the lean version remembers what it was stripped from');
    assert.equal(s.history.length, 3); assert.equal(s.history[2].label, 'Lean version');
    assert.match(lastSaid(s), /^Done\. Before \$[\d,.]+ → after \$[\d,.]+ \(you keep \$[\d,.]+ more\)\. You gave up: /);
    const leanTrip = await svc.price(decodeSpec(lc.lean.token));

    // 5. Add back what's worth it, on the lean version: each item priced alone; "Add back <item>" proposes it.
    s = await say('Add back what\'s worth it');
    const ab = cards(s, 'addback').pop();
    assert.ok(ab && ab.onLean, 'the add-back list on the lean version');
    assert.equal(ab.items.length, lc.addBack.length);
    for (const a of ab.items) { assert.equal(a.total, await priced(a.token)); assert.equal(a.cost, a.total - lc.lean.total); }
    const item = ab.items[0];
    s = await say(`Add back ${item.label}`);
    assert.ok(s.proposal && s.proposal.kind === 'addBack' && s.proposal.token === item.token && s.proposal.total === item.total, 'the named item is proposed');
    assert.equal(s.proposal.delta, item.cost);
    assert.equal(s.current.token, lc.lean.token, 'nothing added without approval');
    assert.equal(s.style, 'beach', 'the chip changed no fact on the trip object');
    assert.equal(s.transfer, false);
    s = await say('Keep what I have');
    assert.equal(s.proposal, null); assert.equal(s.current.token, lc.lean.token);
    // "Add back the transfer": the item is matched by the words of its key or label, never only by its exact label.
    const tr = ab.items.find(x => x.key === 'transfer');
    assert.ok(tr, 'the transfer was stripped (no transfer rule), so it is in the add-back list');
    s = await say('Add back the transfer');
    assert.ok(s.proposal && s.proposal.kind === 'addBack' && s.proposal.token === tr.token && s.proposal.total === tr.total, lastSaid(s));
    s = await say('Keep what I have');
    assert.equal(s.proposal, null);
    // Over the ceiling: an add-back whose total ends above the booking budget waits for "go over" like
    // every dearer version, with the overrun said as the difference of two numbers; "take it" alone
    // applies nothing and approves nothing.
    const dear = ab.items.slice().sort((a, b) => b.total - a.total)[0];
    const low = dear.total - 100;
    assert.ok(low > lc.lean.total, 'the lean version itself stays under the ceiling');
    await agent.withState(s0.id, st => { st.budget = low; st.budgetPer = 'total'; });
    s = await say(`Add back ${dear.label}`);
    assert.ok(s.proposal && s.proposal.over === true && s.proposal.token === dear.token);
    assert.ok(lastSaid(s).includes(`Total ${money(dear.total)}, ${money(dear.total - low)} over your ${money(low)} ceiling. Say "go over" to take it anyway, or keep what you have.`), lastSaid(s));
    s = await say('Take it');
    assert.equal(s.current.token, lc.lean.token, 'not applied without the word'); assert.ok(s.proposal, 'still on the table'); assert.equal(s.overApproved, false);
    assert.match(lastSaid(s), /^That version is \$[\d,.]+ over your \$[\d,.]+ ceiling\. Say "go over"/);
    s = await say('Keep what I have');
    assert.equal(s.proposal, null); assert.equal(s.current.token, lc.lean.token);
    await agent.withState(s0.id, st => { st.budget = 250000; });
    s = await agent.load(s0.id);
    // With the ceiling back, the gate is there exactly when the total ends above it.
    s = await say(`Add back ${dear.label}`);
    assert.ok(s.proposal && s.proposal.over === (dear.total > 250000));
    assert.ok(dear.total > 250000 ? /Say "go over"/.test(lastSaid(s)) : lastSaid(s).endsWith('Take it, or keep what you have.'), lastSaid(s));
    s = await say('Keep what I have');

    // 6. The biggest leak: the spec's lines, the priced difference, and the chip proposes exactly the card's token.
    s = await say('Find my biggest leak');
    const lk = cards(s, 'leak').pop();
    if (lk) {
      assert.match(lk.text, /^BIGGEST AVOIDABLE COST: .+\. Current: \$[\d,.]+\. .+: \$[\d,.]+\. Potential difference: \$[\d,.]+\./);
      assert.equal(lk.difference, lk.current - lk.alternative); assert.ok(lk.difference > 0);
      assert.equal(lk.total, await priced(lk.token)); assert.ok(lk.total < leanTrip.total);
      assert.equal(s.proposal, null, 'the leak is shown, not put on the table yet');
      // Every other difference between the canvas and that version, by the facts, is on the card and in
      // the sentence; "Nothing else changes" is said only when the facts find no other row (a like-for-
      // like fare or hotel swap differs in neutral facts, and those are named, never hidden).
      const altTrip = await svc.price(decodeSpec(lk.token));
      const own = new Set(lk.leakKind === 'extra' || lk.leakKind === 'duplicate' ? ['experiences', 'transfer', 'bags'] : []);
      const chL = classifyChanges(leanTrip, altTrip);
      const others = rowWords([...chL.improvements, ...chL.neutral, ...(lk.tradeoff ? [] : chL.tradeoffs)].filter(r => !own.has(r.key)));
      assert.deepEqual(lk.differs, others, 'every other difference by the facts is on the card');
      const shownText = s.messages[lastIdx(s, 'leak')].text;
      if (others.length) assert.ok(!/Nothing else changes/.test(shownText) && others.every(w => shownText.includes(w)), shownText);
      else if (!lk.tradeoff) assert.ok(/ Nothing else changes\. /.test(shownText), shownText);
      // "Show me the cheaper version" is a cheaper ask, never the card again and never the card's version.
      const leakCards = cards(s, 'leak').length;
      s = await say('Show me the cheaper version');
      assert.equal(cards(s, 'leak').length, leakCards); assert.ok(!s.proposal || s.proposal.kind === 'cheaper');
      if (s.proposal) s = await say('Keep what I have');
      s = await say(`Show me the ${lk.alternativeLabel} version`);
      assert.ok(s.proposal && s.proposal.token === lk.token && s.proposal.total === lk.total, 'the chip proposes the card\'s version');
      assert.deepEqual(s.proposal.tradeoffs, lk.tradeoff ? [lk.tradeoff] : []);
      // The proposal names what it is: a removal names the item that comes out; the other differences are its neutral rows and in the words.
      if (own.size) { assert.equal(s.proposal.label, `Without ${lk.label}`); assert.ok(s.proposal.neutral.includes(`${lk.label} comes out`)); assert.ok(lastSaid(s).startsWith(`${lk.label} comes out: ${money(lk.total)}, ${money(lk.difference)} less than now.`), lastSaid(s)); }
      else { assert.equal(s.proposal.label, lk.alternativeLabel); assert.ok(lastSaid(s).startsWith(`${lk.alternativeLabel}: ${money(lk.total)}, ${money(lk.difference)} less than now.`)); }
      for (const w of others) assert.ok(lastSaid(s).includes(w) && s.proposal.neutral.includes(w), w);
      if (!others.length && !lk.tradeoff) assert.ok(/ Nothing else changes\. /.test(lastSaid(s))); else assert.ok(!/Nothing else changes/.test(lastSaid(s)) || !others.length);
      assert.equal(s.current.token, lc.lean.token);
      s = await say('Keep what I have');
      assert.equal(s.proposal, null);
      assert.equal(s.declinedLeak, lk.token, 'a leak kept is remembered as kept');
    } else assert.match(lastSaid(s), /^I don't see an avoidable cost in this price: nothing optional, no duplicate, and no like-for-like cheaper version\.$/);

    // 7. Free savings apart from trade-off savings: free has no trade-off by classifyChanges; the
    // sacrifice names its trade-off and is never merged with the free number.
    s = await say('Free savings');
    const fr = cards(s, 'free').pop();
    assert.ok(fr, 'the free-savings card');
    const curTrip = (await svc.trip(s.current.token, {})).trip;
    if (fr.free) {
      const ft = await svc.price(decodeSpec(fr.free.token));
      assert.equal(fr.free.total, ft.total); assert.equal(fr.free.delta, ft.total - curTrip.total); assert.ok(fr.free.delta <= -2500);
      assert.equal(classifyChanges(curTrip, ft).tradeoffs.length, 0, 'free: zero trade-offs by classifyChanges');
      assert.match(fr.free.text, /^FREE SAVINGS: /); assert.ok(fr.free.same.length >= 1);
      // What differs is on the card, a moved departure date first, in the traveler's words.
      assert.ok(Array.isArray(fr.free.differs));
      if (ft.spec.depart !== curTrip.spec.depart) assert.match(fr.free.differs[0], /^Leaving /, 'a moved date is said first');
      const chF = classifyChanges(curTrip, ft);
      assert.equal(fr.free.differs.length, [...chF.improvements, ...chF.neutral].filter(r => r.key !== 'dates').length + (ft.spec.depart !== curTrip.spec.depart ? 1 : 0), 'every difference the facts find is listed');
    } else assert.match(lastSaid(s), /^No free saving: /);
    if (fr.sacrifice) {
      const st = await svc.price(decodeSpec(fr.sacrifice.token));
      assert.equal(fr.sacrifice.total, st.total); assert.equal(fr.sacrifice.delta, st.total - curTrip.total);
      assert.ok(classifyChanges(curTrip, st).tradeoffs.length >= 1, 'sacrifice: at least one trade-off');
      assert.ok(fr.sacrifice.but.length >= 1); assert.match(fr.sacrifice.text, /^SAVE ANOTHER \$[\d,.]+, but: /);
      assert.ok(!fr.sacrifice.text.includes('FREE'));
      if (fr.free) { assert.ok(fr.sacrifice.total < fr.free.total); assert.ok(!fr.free.text.includes(money(fr.sacrifice.total)), 'never merged'); assert.ok(fr.sacrifice.text.startsWith(`SAVE ANOTHER ${money(fr.free.total - fr.sacrifice.total)}`), 'measured from the free version'); }
    }
    assert.match(lastSaid(s), /The two are never one number\./);
    if (fr.sacrifice) {
      s = await say('Take the trade-off version');
      assert.ok(s.proposal && s.proposal.token === fr.sacrifice.token && s.proposal.total === fr.sacrifice.total);
      assert.deepEqual(s.proposal.tradeoffs, fr.sacrifice.but);
      s = await say('Keep what I have');
    }
    if (fr.free) {
      s = await say('Take the free savings');
      assert.ok(s.proposal && s.proposal.token === fr.free.token && s.proposal.tradeoffs.length === 0);
      // Every difference is said before the traveler takes it, the moved date first; "nothing given up"
      // is said only when the facts differ in no more than the fare's name.
      assert.deepEqual(s.proposal.neutral, [...fr.free.differs, ...fr.free.same]);
      for (const d of fr.free.differs) assert.ok(lastSaid(s).includes(d), d);
      const material = fr.free.differs.filter(d => !/^Flights: /.test(d));
      if (material.length) { assert.ok(!/[Nn]othing given up/.test(lastSaid(s)), lastSaid(s)); assert.ok(lastSaid(s).includes(`Before you take it: ${fr.free.differs[0]}`) && / No trade-off by the facts\. Take it, or keep what you have\.$/.test(lastSaid(s)), lastSaid(s)); }
      else assert.match(lastSaid(s), /[Nn]othing given up by the facts\. Take it, or keep what you have\.$/);
      s = await say('Keep what I have');
    }
    assert.equal(s.current.token, lc.lean.token, 'nothing applied');

    // 8. The scorecard after the applied steps: the removed-extra step of exactly one kind counts, the
    // lean step (several parts at once) is listed on its own and counted nowhere, nothing is summed.
    s = await say('Savings scorecard');
    const sc = cards(s, 'scorecard').pop();
    assert.ok(sc, 'the scorecard card');
    assert.equal(sc.current, s.current.total); assert.equal(sc.max, budget);
    const versions = [loaded, afterOne, leanTrip];
    const labels = [savemax.lineLabel(loaded, afterOne), savemax.lineLabel(afterOne, leanTrip)];
    assert.ok(PURE.has(labels[0]), `remove one thing is a step of one kind: ${labels[0]}`);
    const expectExtras = sum(labels.map((l, i) => (PURE.has(l) ? versions[i].total - versions[i + 1].total : 0)));
    const expectMixed = labels.map((l, i) => ({ label: l, delta: versions[i + 1].total - versions[i].total })).filter(m => !PURE.has(m.label) && m.label !== 'No change' && !['Date change', 'Flight swap', 'Hotel swap'].includes(m.label));
    assert.equal(sc.extrasRemoved, expectExtras, 'only the pure removed-extra steps are counted');
    assert.deepEqual(sc.mixed, expectMixed, 'a step that changed several things is listed, not counted');
    assert.equal(sc.independent, expectMixed.length === 0);
    assert.equal(sc.note, 'These are not added together: each is the difference between two versions you applied, and a step that changed two things is listed on its own.');
    const cats = sc.lines.filter(l => !['max', 'current', 'notUsed', 'over'].includes(l.key)).map(l => l.amount);
    assert.ok(!sc.lines.some(l => l.amount === sum(cats) && !cats.includes(l.amount)), 'no line is the sum of the others');
    assert.ok(!sc.lines.some(l => /total sav/i.test(l.label)));
    assert.match(lastSaid(s), /MAX BUDGET \$[\d,.]+ · CURRENT TRIP \$[\d,.]+/);

    // 9. Cut it in order: one priced change per step, in the fixed order, a proposal when any step was taken.
    s = await say('Cut $50 in order');
    const ct = cards(s, 'cut').pop();
    assert.ok(ct, 'the cut card');
    assert.equal(ct.target, leanTrip.total - 5000);
    assert.deepEqual(ct.order, leaks.PRIORITY_ORDER.map(k => leaks.ORDER_LABELS[k]));
    let running = leanTrip.total;
    for (const st of ct.steps) { assert.equal(st.before, running); assert.equal(st.after, await priced(st.token)); assert.equal(st.saving, st.before - st.after); assert.ok(st.saving > 0); running = st.after; }
    assert.equal(ct.final.total, running); assert.equal(ct.reached, running <= ct.target);
    assert.ok(ct.skipped.every(k => k.why && k.stageLabel));
    if (ct.steps.length) { assert.ok(s.proposal && s.proposal.token === ct.final.token && s.proposal.total === ct.final.total); assert.equal(s.current.token, lc.lean.token); s = await say('Keep what I have'); }
    else assert.match(lastSaid(s), /^Not reached: /);
    assert.equal(s.budget, 250000, 'the amount to cut never became the budget');

    // 10. The scan on demand, then the page: every card renders, nothing is checked or preselected, no pressure words.
    s = await say('Money leak check');
    const sc2 = cards(s, 'scan').pop();
    assert.ok(sc2 && /^MONEY LEAK CHECK COMPLETE\./.test(sc2.text));
    if (sc2.found) { assert.ok(s.proposal && s.proposal.token === sc2.found.token); s = await say('Keep it'); }
    const res = await fetch(`${app.base}/agent/${s.id}`, { headers: { cookie: `txv=${VISITOR}` } });
    assert.equal(res.status, 200);
    const page = await res.text();
    const t = text(page);
    for (const w of ['What you\'re paying for', 'Strip it down', 'Customer decides', 'Add back what\'s worth it', 'Money leak check', 'Free savings', 'Trade-off savings', 'Your savings check', 'Cut it in order', 'What am I paying for?', 'Find my biggest leak']) assert.ok(t.includes(w), `the page shows "${w}"`);
    assert.ok(!PRESSURE.test(t), 'no pressure words anywhere');
    assert.ok(!/<input[^>]*type="(?:checkbox|radio)"[^>]*\schecked\b/i.test(page), 'nothing is preselected');
    assert.ok(!/<option[^>]*\sselected\b/i.test(page));
    assert.ok(!/<input[^>]*type="(?:checkbox|radio)"/i.test(page), 'no optional item is a checkbox at all: every removal is a button that says something to the agent');
    assert.ok(!PRESSURE.test(said(s)), 'no pressure words in anything the agent said');
    for (const m of s.messages.filter(m => m.card)) assert.ok(!PRESSURE.test(JSON.stringify(m.card)), `no pressure in the ${m.card.kind} card`);

    // 11. A stated rule the trip breaks is never listed under Kept: with a star rule above this hotel,
    // the lean card and the sentence say "Not met by this trip", and Kept is said once.
    const curT = (await svc.trip(s.current.token, {})).trip;
    await agent.withState(s0.id, st => { st.hotelRules = { ...st.hotelRules, minStars: curT.hotel.stars + 1 }; st.proposal = null; });
    s = await say('Strip it down');
    const lc2 = cards(s, 'lean').pop();
    const miss = `${curT.hotel.stars + 1}-star or better (a rule you set; this hotel is ${curT.hotel.stars}-star)`;
    assert.ok(lc2.notKept.includes(miss), JSON.stringify(lc2.notKept)); assert.ok(!lc2.kept.some(k => k.startsWith(`${curT.hotel.stars + 1}-star`)), 'an unmet rule is never under Kept');
    assert.ok(lastSaid(s).includes(`Not met by this trip: ${miss}`), lastSaid(s)); assert.equal((lastSaid(s).match(/Kept: /g) || []).length, 1, 'Kept is said once');
    // The card itself renders it (a <span> inside the lean card; the spoken sentence is a plain <p>).
    assert.ok((await (await fetch(`${app.base}/agent/${s.id}`, { headers: { cookie: `txv=${VISITOR}` } })).text()).includes(`<span>Not met by this trip: ${miss}</span>`), 'the lean card renders it');
    if (s.proposal) s = await say('Keep what I have');
    await agent.withState(s0.id, st => { st.hotelRules = { ...st.hotelRules, minStars: null }; st.proposal = null; });

    // 12. A second conversation: the leak card's chip after the canvas moved, the bag the traveler
    // states riding on the agent's links, and why each optional item stays in the engine's words.
    const s1 = await agent.create({ visitor: 'v-leaks-agent-000002' });
    const say1 = ask(agent, s1.id);
    let r = await say1('I have $2,500, two of us from JFK, 5 nights, beach. Booking budget.');
    assert.ok(r.current);
    const t1 = (await svc.trip(r.current.token, {})).trip;
    const put = async (token, change) => { const p = await svc.price(decodeSpec(svc.customize(token, change))); await agent.withState(s1.id, st => { st.current = { token: encodeSpec(p.spec), total: p.total, since: agent.now().toISOString() }; st.proposal = null; st.pending = null; st.history = []; st.declinedLeak = null; }); return agent.load(s1.id); };
    r = await put(r.current.token, { transfer: '1', bags: '0', activities: t1.activityOptions.filter(a => a.kind !== 'beach').slice(0, 2).map(a => a.id) });
    r = await say1('Find my biggest leak');
    const lk1 = cards(r, 'leak').pop();
    if (lk1 && lk1.leakKind === 'extra') {
      // The item the card named comes out through "remove one thing"; the old card's chip then names
      // no item, so the leak is read again off the canvas: the canvas moved, the new card is shown and
      // nothing is proposed under the old words. The new card's chip proposes the item it names.
      r = await say1('Remove one thing');
      const rm = r.proposal;
      r = await say1('Remove it');
      assert.equal(r.current.token, rm.token);
      r = await say1('Show me the version without it');
      assert.equal(r.proposal, null, 'nothing proposed under the old card\'s words');
      const lk2 = cards(r, 'leak').pop();
      assert.ok(lk2 && lk2.token !== lk1.token, 'a new card');
      assert.match(lastSaid(r), /^The canvas moved since that card, so I read it again: the biggest avoidable cost is now .+\. BIGGEST AVOIDABLE COST: /);
      const curR = await agent.currentTrip(r);
      assert.equal(lk2.token, leaks.biggestLeak(inv, curR.trip, settings, curR.ctx, agent.leakOpts(r)).token, 'the engine\'s own leak on the canvas as it is now');
      if (lk2.leakKind === 'extra') {
        r = await say1('Show me the version without it');
        assert.ok(r.proposal && r.proposal.token === lk2.token && r.proposal.label === `Without ${lk2.label}`, 'the new card\'s version, named');
        assert.ok(lastSaid(r).startsWith(`${lk2.label} comes out: `));
        r = await say1('Keep what I have');
      }
    }
    // A bought bag on a fare that sells one, nothing else optional and no bag stated: the scan's "bags"
    // check finds either the add-on itself (the same fare without the bag: a removal, named as one) or
    // a cheaper fare carrying the same bags (the engine's label, never called a removal); which one is
    // read off the found token, and the words follow. A leak kept after the check on demand is kept:
    // "book it" says so and never proposes the same version twice.
    const sellsBag = t1.flightOptions.find(f => !f.checkedBagIncluded && f.bagFeePerTraveler > 0);
    if (sellsBag) {
      r = await put(r.current.token, { flight: sellsBag.id, bags: '1', transfer: '0', activities: [] });
      const curS = await agent.currentTrip(r);
      assert.ok(lineAmount(curS.trip, 'bags') > 0 && !curS.trip.activities.length && !curS.trip.transfer);
      r = await say1('Money leak check');
      const sc = cards(r, 'scan').pop();
      assert.ok(sc.found && sc.found.key === 'bags' && r.proposal && r.proposal.token === sc.found.token, 'the bag check is the hit');
      const fs = decodeSpec(sc.found.token), cs = curS.trip.spec;
      if (fs.flight === cs.flight && fs.bags === false) {
        assert.equal(r.proposal.label, `Without ${sc.found.label}`, 'the add-on comes out: a removal, named as one');
        assert.ok(r.proposal.neutral.includes(`${sc.found.label} comes out`));
      } else {
        assert.equal(r.proposal.label, sc.found.label[0].toUpperCase() + sc.found.label.slice(1), 'a cheaper fare with the same bags keeps the engine\'s label');
        assert.ok(r.proposal.neutral.some(w => /^the same bags on the .+ fare$/.test(w)) && !r.proposal.label.startsWith('Without '));
      }
      assert.ok(!JSON.stringify(r.proposal).includes('same bags, cheaper fare'));
      r = await say1('Stop searching');
      assert.ok(lastSaid(r).includes(`take ${r.proposal.label.startsWith('Without ') ? `the version ${r.proposal.label.toLowerCase()}` : `the ${r.proposal.label.toLowerCase()}`} or keep what you have`), lastSaid(r));
      const keptTok = r.proposal.token;
      r = await say1('Keep it');
      assert.equal(r.proposal, null); assert.equal(r.declinedLeak, keptTok, 'kept after the check on demand'); assert.equal(decodeSpec(r.current.token).bags, true, 'nothing removed');
      r = await say1('Book it');
      assert.equal(r.proposal, null, 'the kept leak is not proposed again at book it'); assert.ok(cards(r, 'contract').length, 'the contract follows');
      const sm = r.messages[lastIdx(r, 'scan')];
      assert.ok(sm.card.kept === true && sm.card.found.token === keptTok);
      assert.match(sm.text, /^MONEY LEAK CHECK COMPLETE\. I found one more optional \$[\d,.]+ you can remove: .+\. That is the one you chose to keep, so your trip stands at \$[\d,.]+\.$/);
      assert.ok(sm.text.includes(`stands at ${money(curS.trip.total)}.`));
    }
    // The bag the traveler states rides on every link the agent gives: the review page reads it off
    // the link, so its own scan agrees with the agent and never says "nothing you told me asks for a
    // checked bag" to someone who said they check one.
    r = await say1('I check a bag');
    assert.equal(r.bags, 'checked');
    const cur1 = await agent.currentTrip(r);
    assert.equal(cur1.ctx.bags, 'checked'); assert.equal(cur1.ctx.dest, null); assert.equal(cur1.ctx.dateMode, null);
    const linkCx = linkContext(`/x?${optimizer.contextParams(cur1.ctx)}`);
    assert.equal(linkCx.bags, 'checked'); assert.equal(linkCx.dest, null); assert.equal(linkCx.nightsAsked, 5);
    assert.equal(svc.leakOptions(cur1.trip, linkCx).prefs.bags, 'checked');
    const bagFare = cur1.trip.flightOptions.find(f => !f.checkedBagIncluded && f.bagFeePerTraveler > 0);
    if (bagFare) {
      r = await put(r.current.token, { flight: bagFare.id, bags: '1' });
      const curB = await agent.currentTrip(r);
      assert.ok(lineAmount(curB.trip, 'bags') > 0, 'a bought bag is in the price');
      const pageScan = (await svc.leakCheck(curB.trip, linkContext(`/x?${optimizer.contextParams(curB.ctx)}`))).scan;
      const agentScan = await agent.leakScan(r, curB);
      const bagsOf = sc => sc.checks.find(c => c.key === 'bags').text;
      assert.equal(bagsOf(pageScan), bagsOf(agentScan), 'the page and the agent say the same about the bag');
      assert.ok(!/nothing you told me asks for a checked bag/.test(bagsOf(pageScan)), bagsOf(pageScan));
      r = await say1('Book it');
      for (let k = 0; k < 4 && r.proposal; k++) {
        const fs = decodeSpec(r.proposal.token), cs = decodeSpec(r.current.token);
        assert.ok(!(fs.flight === cs.flight && cs.bags && fs.bags === false), 'the stated bag is never the leak');
        r = await say1('Keep it'); r = await say1('Book it');
      }
      const href = cards(r, 'contract').pop().href;
      assert.equal(linkContext(href).bags, 'checked', `the review link carries the stated bag: ${href}`);
    }
    // "Remove one thing" when every optional item stays: the engine's own sentence says why, and "one
    // you asked for" only when every reason is a stated ask (a beach experience kept for the beach
    // trip is the engine's reading of what was said, not an ask).
    const beach = t1.activityOptions.find(a => a.kind === 'beach');
    if (beach) {
      r = await put(r.current.token, { transfer: '0', bags: '0', activities: [beach.id] });
      r = await say1('Remove one thing');
      const curW = await agent.currentTrip(r);
      const wk = leaks.whyKept(inv, curW.trip, settings, curW.ctx, agent.leakOpts(r));
      assert.equal(wk.allStated, false); assert.equal(wk.items.length, 1);
      assert.equal(r.proposal, null);
      assert.ok(lastSaid(r).startsWith(wk.text), lastSaid(r));
      assert.ok(!/one you asked for/.test(lastSaid(r)));
      assert.equal(cards(r, 'facts').pop().title, 'Optional, and kept by what you told me');
    }
    // A leak that is a fare swap (the stated bag kept, a cheaper fare carrying it): every other
    // difference by the facts is said on the card and in the proposal, and "Nothing else changes" is
    // never said over a row the facts found.
    for (const f of t1.flightOptions.filter(x => !x.checkedBagIncluded && x.bagFeePerTraveler > 0)) {
      r = await put(r.current.token, { flight: f.id, bags: '1', transfer: '0', activities: [] });
      const curF = await agent.currentTrip(r);
      const bf = leaks.biggestLeak(inv, curF.trip, settings, curF.ctx, agent.leakOpts(r));
      if (!bf || bf.kind === 'extra' || bf.kind === 'duplicate') continue;
      const altF = await svc.price(decodeSpec(bf.token)), chF2 = classifyChanges(curF.trip, altF);
      const rowsF = rowWords([...chF2.improvements, ...chF2.neutral, ...(bf.tradeoff ? [] : chF2.tradeoffs)]);
      if (!rowsF.length) continue;
      r = await say1('Find my biggest leak');
      const lkF = cards(r, 'leak').pop();
      assert.equal(lkF.token, bf.token); assert.deepEqual(lkF.differs, rowsF);
      const saidF = r.messages[lastIdx(r, 'leak')].text;
      assert.ok(!/Nothing else changes/.test(saidF) && rowsF.every(w => saidF.includes(w)), saidF);
      assert.ok(saidF.includes(bf.tradeoff ? ` It also differs: ` : ` What differs, by the facts: `), saidF);
      r = await say1(`Show me ${leaks.showWords(bf)}`);
      assert.ok(r.proposal && r.proposal.token === bf.token && r.proposal.label === bf.alternativeLabel, lastSaid(r));
      assert.ok(!/Nothing else changes/.test(lastSaid(r)) && rowsF.every(w => lastSaid(r).includes(w) && r.proposal.neutral.includes(w)), lastSaid(r));
      assert.deepEqual(r.proposal.tradeoffs, bf.tradeoff ? [bf.tradeoff] : []);
      r = await say1('Keep what I have');
      break;
    }
    // A free version that moves the departure date: the date is said first, before the traveler takes
    // it, and "nothing given up" is not said over it.
    for (const d of [30, 33, 37, 44]) {
      const depart = addDays(today(agent.now()), d);
      let moved;
      try { moved = await put(r.current.token, { depart, bags: '0', transfer: '0', activities: [] }); } catch (e) { continue; }
      r = moved;
      const curD = await agent.currentTrip(r);
      const fd = leaks.freeSavings(inv, curD.trip, settings, curD.ctx, agent.leakOpts(r)).free;
      if (!fd || fd.trip.spec.depart === depart) continue;
      r = await say1('Free savings');
      const frD = cards(r, 'free').pop();
      assert.equal(frD.free.token, fd.token); assert.equal(frD.free.differs[0], `Leaving ${fd.differs[0].slice(8)}`); assert.match(frD.free.differs[0], /^Leaving /);
      assert.ok(text(await (await fetch(`${app.base}/agent/${r.id}`, { headers: { cookie: 'txv=v-leaks-agent-000002' } })).text()).includes(`Differs: ${frD.free.differs.join('; ')}`), 'the card renders what differs');
      r = await say1('Take the free savings');
      assert.ok(r.proposal && r.proposal.token === fd.token);
      assert.deepEqual(r.proposal.neutral, [...fd.differs, ...fd.same]);
      assert.ok(lastSaid(r).includes(`Before you take it: ${fd.differs[0]}`) && !/[Nn]othing given up/.test(lastSaid(r)), lastSaid(r));
      assert.match(lastSaid(r), / No trade-off by the facts\. Take it, or keep what you have\.$/);
      r = await say1('Keep what I have');
      assert.equal(decodeSpec(r.current.token).depart, depart, 'nothing applied');
      break;
    }
  } finally { await app.close(); }
});

// The words that apply a version name the version they apply: an old card's chip ("Take the lean
// version", "Remove $148") must never apply whatever was proposed since, dearer or not; the cut
// question keeps its answer as an amount; a question about what the data cannot compare gets the
// engine's own line, never the checkout and never a cheaper version. Every number is the engine's.
test('named approvals apply only the version their words name; the cut question keeps its amount; what the data cannot compare is said as such', async () => {
  const app = await startApp();
  try {
    const agent = app.agent, svc = app.ctx.tripService, inv = svc.inv;
    const settings = await agent.settings();
    const s0 = await agent.create({ visitor: 'v-leaks-agent-000003' });
    const say = ask(agent, s0.id);
    let s = await say('I have $2,500, two of us from JFK, 5 nights, beach. Booking budget.');
    assert.ok(s.current, 'a trip is on the canvas');
    const t0 = (await svc.trip(s.current.token, {})).trip;
    const fare = !t0.flight.checkedBagIncluded && t0.flight.bagFeePerTraveler > 0 ? t0.flight : (t0.flightOptions.find(f => !f.checkedBagIncluded && f.bagFeePerTraveler > 0) || t0.flight);
    const acts = [...t0.activityOptions.filter(a => a.kind !== 'beach'), ...t0.activityOptions.filter(a => a.kind === 'beach')].slice(0, 2).map(a => a.id);
    const loaded = await svc.price(decodeSpec(svc.customize(s.current.token, { flight: fare.id, transfer: '1', bags: '1', activities: acts })));
    assert.ok(loaded.activities.length === 2 && loaded.transfer);
    await agent.withState(s0.id, st => { st.current = { token: encodeSpec(loaded.spec), total: loaded.total, since: agent.now().toISOString() }; st.proposal = null; st.pending = null; st.history = []; });
    s = await agent.load(s0.id);
    const loadedTok = encodeSpec(loaded.spec), budget = state.bookingBudget(s);
    assert.equal(budget, 250000);
    const priced = async token => (await svc.price(decodeSpec(token))).total;
    const timesSaid = (st, sentence) => st.messages.filter(m => m.role === 'agent' && m.text === sentence).length;
    const aside = (name, version, total) => `Those words name ${name}; what was on the table was ${version} at ${money(total)}, and nothing is applied on them. It comes off the table, neither taken nor declined.`;

    // 1. "Take the lean version" while "remove one thing" is on the table: the removal is not applied,
    // the lean version is priced again and proposed, and the removal steps aside, said once, neither
    // taken nor declined (nothing recorded against it). Said again, the lean version is applied.
    s = await say('Strip it down');
    const L = s.proposal; assert.ok(L && L.kind === 'lean' && L.total === await priced(L.token));
    s = await say('Remove one thing');
    const R = s.proposal; assert.ok(R && R.kind === 'removeOne' && R.token !== L.token && R.label.startsWith('Without '));
    s = await say('Take the lean version');
    assert.equal(s.current.token, loadedTok, 'nothing applied'); assert.deepEqual(s.history, []);
    assert.ok(s.proposal && s.proposal.kind === 'lean' && s.proposal.token === L.token && s.proposal.total === L.total, 'the lean version is on the table again');
    const asideR = aside('the lean version', `the version ${R.label.toLowerCase()}`, R.total);
    assert.equal(timesSaid(s, asideR), 1, said(s));
    assert.equal(s.declinedLeak, null, 'neither taken nor declined');
    s = await say('Take the lean version');
    assert.equal(s.current.token, L.token); assert.equal(s.current.total, L.total);
    assert.equal(s.history[s.history.length - 1].label, 'Lean version');

    // 2. A dearer add-back on the table: "Remove it" applies nothing of it (a removal word never adds
    // money), says so once, and runs the scan, which proposes a removal or nothing. "Add back <item>"
    // proposes, and said again it applies, since the words name the item on the table.
    s = await say('Add back what\'s worth it');
    const ab = cards(s, 'addback').pop(); assert.ok(ab && ab.onLean && ab.items.length, 'items to add back');
    const item = ab.items[0];
    s = await say(`Add back ${item.label}`);
    const A = s.proposal; assert.ok(A && A.kind === 'addBack' && A.token === item.token && A.delta > 0, 'a dearer version on the table');
    const scans = cards(s, 'scan').length;
    s = await say('Remove it');
    assert.equal(s.current.token, L.token, 'the dearer version is not applied on a removal word'); assert.equal(s.current.total, L.total);
    assert.equal(timesSaid(s, aside('a removal', `the version with ${item.label.toLowerCase()} added back`, A.total)), 1, said(s));
    assert.equal(cards(s, 'scan').length, scans + 1, 'the scan ran'); assert.match(cards(s, 'scan').pop().text, /^MONEY LEAK CHECK COMPLETE\./);
    assert.ok(!s.proposal || (s.proposal.kind === 'leak' && s.proposal.delta < 0), 'on the table now: a removal or nothing');
    if (s.proposal) s = await say('Keep it');
    s = await say(`Add back ${item.label}`);
    assert.ok(s.proposal && s.proposal.kind === 'addBack' && s.proposal.token === item.token); assert.equal(s.current.token, L.token, 'proposed, not applied');
    s = await say(`Add back ${item.label}`);
    assert.equal(s.current.token, item.token, 'the words name the item on the table, so it is applied'); assert.equal(s.current.total, item.total);
    assert.equal(s.leanOf, loadedTok, 'still a lean version of the loaded trip, with one item back');

    // 3. "Remove $N": the amount must be the saving of the removal on the table; another amount applies
    // nothing, says so once, and the scan says no such removal is there before its own exact sentence.
    s = await say('Remove one thing');
    const R2 = s.proposal; assert.ok(R2 && R2.kind === 'removeOne' && R2.delta < 0);
    const wrong = money(-R2.delta + 100);
    const scans2 = cards(s, 'scan').length;
    s = await say(`Remove ${wrong}`);
    assert.equal(s.current.token, item.token, 'an amount that is not the one on the table applies nothing');
    assert.equal(timesSaid(s, aside(`a ${wrong} removal`, `the version ${R2.label.toLowerCase()}`, R2.total)), 1, said(s));
    assert.equal(cards(s, 'scan').length, scans2 + 1); assert.ok(!s.proposal || s.proposal.delta < 0);
    assert.equal(s.budget, budget, 'the amount of a removal never became the budget');
    if (s.proposal) s = await say('Keep it');
    s = await say('Remove one thing');
    const R3 = s.proposal; assert.ok(R3 && R3.kind === 'removeOne');
    s = await say(`Remove ${money(-R3.delta)}`);
    assert.equal(s.current.token, R3.token, 'the matching amount applies it'); assert.equal(s.current.total, R3.total);
    // With nothing on the table, "Remove $N" is the scan: no removal of that amount is said first, then the engine's sentence.
    const curX = await agent.currentTrip(s);
    const scanX = await agent.leakScan(s, curX);
    const amtX = scanX.found ? scanX.found.amount + 100 : 100;
    s = await say(`Remove ${money(amtX)}`);
    assert.equal(s.current.token, R3.token);
    assert.equal(timesSaid(s, `No ${money(amtX)} removal is on the table now; here is the check on the trip as it is.`), 1, said(s));
    assert.ok(cards(s, 'scan').pop().text === scanX.text && lastSaid(s).startsWith(scanX.text), 'the scan\'s sentence, verbatim');
    if (s.proposal) s = await say('Keep it');

    // 4. "Strip it" and "Take the lean" alone, nothing on the table: the strip flow and its card, never
    // "nothing is waiting" and never silence.
    for (const w of ['Strip it', 'Take the lean']) {
      const n = s.messages.length, leanCards = cards(s, 'lean').length;
      s = await say(w);
      assert.ok(s.messages.length > n && s.messages[s.messages.length - 1].role === 'agent', `${w} gets a reply`);
      assert.equal(cards(s, 'lean').length, leanCards + 1, `${w} shows the lean card`);
      assert.ok(!/Nothing is waiting for your approval/.test(lastSaid(s)), lastSaid(s));
      if (s.proposal) { assert.equal(s.proposal.kind, 'lean'); s = await say('Keep what I have'); }
    }

    // 5. The cut question: "cut it in order" under the ceiling asks for an amount and waits for it; the
    // bare-number answer is the amount to cut, never the budget, and nothing is rebuilt. Anything but an
    // amount lets the question lapse, said once.
    assert.ok(s.current.total <= budget);
    const before = s.current.token, jobId = s.job.id;
    s = await say('Cut it in order');
    assert.equal(s.pending, 'cutBy'); assert.match(lastSaid(s), /^How much do you want to cut\?/);
    s = await say('$200');
    assert.equal(s.pending, null); assert.equal(s.budget, budget, 'the budget never moved'); assert.equal(state.bookingBudget(s), budget);
    assert.equal(s.current.token, before, 'no rebuild'); assert.equal(s.job.id, jobId);
    const ct = cards(s, 'cut').pop(); assert.ok(ct, 'the cut card');
    assert.equal(ct.target, (await priced(before)) - 20000, 'the target is the canvas total less the amount said');
    if (ct.steps.length) { assert.ok(s.proposal && s.proposal.kind === 'cut' && s.proposal.token === ct.final.token); s = await say('Keep what I have'); } else assert.equal(s.proposal, null);
    s = await say('Cut it in order');
    assert.equal(s.pending, 'cutBy');
    s = await say('Never mind');
    assert.equal(s.pending, null); assert.equal(s.budget, budget); assert.equal(cards(s, 'cut').length, 1); assert.equal(s.current.token, before);
    assert.equal(timesSaid(s, 'No amount, so nothing is cut. Say "cut $200 in order" whenever you want to.'), 1, said(s));

    // 6. "Take the free savings" proposes the free version and, said again, applies it; nothing else is
    // ever applied by it. Without a free version, the words say so and apply nothing.
    const curF = await agent.currentTrip(s);
    const fs = leaks.freeSavings(inv, curF.trip, settings, curF.ctx, agent.leakOpts(s));
    s = await say('Take the free savings');
    if (fs.free) {
      assert.ok(s.proposal && s.proposal.kind === 'free' && s.proposal.token === fs.free.token); assert.equal(s.current.token, before);
      s = await say('Take the free savings');
      assert.equal(s.current.token, fs.free.token); assert.equal(s.current.total, fs.free.total);
    } else { assert.equal(s.proposal, null); assert.equal(s.current.token, before); assert.match(lastSaid(s), /^No free saving is priced/); }

    // 7. What the data cannot compare, in the engine's own words: never the checkout a bare "book" would
    // start, never a cheaper version, and nothing proposed.
    const curN = await agent.currentTrip(s), tN = curN.trip, na = leaks.notAvailable(tN);
    const line = k => na.find(x => x.key === k).text;
    const contracts = cards(s, 'contract').length;
    for (const [q, expect] of [
      ['Is it cheaper if I book the hotel separately on another site?', line('channel')],
      ['Would two one-way tickets be cheaper?', line('oneway')],
      ['Do you have a promo code or coupon for this?', line('promo')],
      ['Can I use my airline points on this?', line('credit')],
      ['Is there a seat selection fee?', leaks.seatFees(tN).text],
      ['Does the hotel charge for parking?', leaks.hotelFees(tN).parking.text],
      ['Is the package cheaper than booking separately?', line('package')],
    ]) {
      s = await say(q);
      assert.ok(lastSaid(s).includes(expect), `${q} → ${lastSaid(s)}`);
      assert.ok(lastSaid(s).endsWith(`Your trip stays at ${money(s.current.total)}; nothing is proposed from this.`), lastSaid(s));
      assert.equal(s.proposal, null, 'nothing proposed'); assert.equal(cards(s, 'contract').length, contracts, 'not the checkout');
      const fc = last(s).card;
      assert.ok(fc && fc.kind === 'facts' && fc.title === 'Not compared here' && fc.items.some(i => i.includes(expect)) && fc.href.endsWith('#notCompared'), JSON.stringify(fc));
    }
    s = await say('How much is this in euros?');
    assert.ok(lastSaid(s).startsWith(tN.internationalTrip ? line('currency') : 'Everything is priced in USD'), lastSaid(s));
    assert.equal(s.proposal, null);
    // "Book it" still reaches the money leak check.
    const scansB = cards(s, 'scan').length;
    s = await say('Book it');
    assert.equal(cards(s, 'scan').length, scansB + 1); assert.match(cards(s, 'scan').pop().text, /^MONEY LEAK CHECK COMPLETE\./);
  } finally { await app.close(); }
});

test('the saver\'s victory on the post-booking canvas: what was given, what the trip cost, what was kept, and only the asks the trip\'s facts meet', async () => {
  const app = await startApp();
  try {
    const svc = app.ctx.tripService, inv = svc.inv;
    const settings = await app.agent.settings();
    const q = { budget: 250000, vacationBudget: 250000, keep: 0, budgetInput: 2500, budgetType: 'total', travelers: 2, who: 'couple', origin: 'NYC', dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'beach', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
    const t = optimizer.search(inv, q, { settings, now: app.agent.now() }).picks[0].trip;
    const max = t.total + 50000;
    const asks = { nightsAsked: t.spec.nights, style: 'beach', priority: 'price', dest: t.dest.name, rules: { nonstop: t.flight.stops === 0, minStars: t.hotel.stars + 1, allInclusive: false, breakfast: false, beachfront: false, transfer: false, refundable: false } };
    const booking = { ref: 'BT-LEAK1', status: 'confirmed', total: t.total, components: [], payment: { amount: t.total }, quote: { trip: { ...t, token: encodeSpec(t.spec) }, budget: { budget: max, keep: 0, allowOver: 0, asks } } };
    const home = bookingHome(booking, { now: app.agent.now(), preview: null, origin: inv.maps.getOrigin('NYC') });
    const v = home.victory;
    assert.ok(v, 'a victory block when the quote carried a maximum');
    assert.equal(v.gave, max); assert.equal(v.trip, t.total); assert.equal(v.kept, max - t.total); assert.equal(v.over, null);
    assert.ok(v.keptRules.includes(`${t.spec.nights} nights`)); assert.ok(v.keptRules.includes(`Your destination: ${t.dest.name}`));
    if (t.flight.stops === 0) assert.ok(v.keptRules.includes('Nonstop'));
    assert.ok(v.notKept.includes(`Your hotel requirement: ${t.hotel.stars + 1}-star or better (this hotel is ${t.hotel.stars}-star)`), 'an unmet ask is listed honestly');
    assert.ok(!v.keptRules.some(r => /All-inclusive|Beachfront|Refundable|Airport transfers/.test(r)), 'a rule never stated is not listed');
    // Rendered on the agent's home canvas; over the maximum, the overrun is said and no "kept" line.
    const s = state.newState({ id: 'agt_victory' });
    s.booking = { ref: booking.ref };
    const page = text(String(agentView(app.ctx, { s, canvas: { home }, user: null })));
    assert.ok(page.includes(`You gave us ${money(max)}`) && page.includes(`Your trip ${money(t.total)}`) && page.includes(`You kept ${money(max - t.total)}`));
    assert.ok(page.includes(`And you kept: ${v.keptRules.join(' · ')}`)); assert.ok(page.includes('Not kept:'));
    // The victory block itself carries no pressure (the rest of the home is the booking's own facts, tested elsewhere).
    const block = page.slice(page.indexOf('Your savings'), page.indexOf('Important actions'));
    assert.ok(block.length > 40 && !PRESSURE.test(block), block);
    const over = bookingHome({ ...booking, quote: { ...booking.quote, budget: { budget: t.total - 100, keep: 0, allowOver: 10, asks } } }, { now: app.agent.now(), preview: null, origin: inv.maps.getOrigin('NYC') }).victory;
    assert.equal(over.kept, null); assert.equal(over.over, 100);
    const overPage = text(String(agentView(app.ctx, { s, canvas: { home: { ...home, victory: over } }, user: null })));
    assert.ok(overPage.includes(`You went over by ${money(100)}`) && overPage.includes('which you approved') && !overPage.includes('And you kept:'));
    // The money the traveler protected is part of what they gave: the whole number, the booking's
    // share and the reserve are said apart, as the booking page says them; and a destination the
    // traveler never named (asks.dest null, as the service stores it) is not a kept line, so the home
    // never lists the booked trip's own destination as something asked for.
    const keep = 50000;
    const reserved = bookingHome({ ...booking, quote: { ...booking.quote, budget: { budget: max, keep, allowOver: 0, asks: { ...asks, dest: null } } } }, { now: app.agent.now(), preview: null, origin: inv.maps.getOrigin('NYC') }).victory;
    assert.equal(reserved.gave, max + keep); assert.equal(reserved.forBooking, max); assert.equal(reserved.reserve, keep); assert.equal(reserved.kept, max - t.total); assert.equal(reserved.over, null);
    assert.ok(!reserved.keptRules.some(r => /^Your destination/.test(r)) && !reserved.notKept.some(r => /^Your destination/.test(r)), 'a destination never asked is not listed');
    assert.ok(reserved.keptRules.includes(`${t.spec.nights} nights`), 'the stated asks are still listed');
    const rPage = text(String(agentView(app.ctx, { s, canvas: { home: { ...home, victory: reserved } }, user: null })));
    assert.ok(rPage.includes(`You gave us ${money(max + keep)}`) && rPage.includes(`${money(max)} for the booking, ${money(keep)} protected`) && rPage.includes(`You kept ${money(max - t.total)}`) && rPage.includes(`of the booking's ${money(max)}; the ${money(keep)} you protected is untouched`), rPage.slice(rPage.indexOf('Your savings'), rPage.indexOf('Your savings') + 400));
    assert.ok(!rPage.includes('Your destination:'));
    // Without a reserve the whole number is the maximum, said once.
    assert.equal(home.victory.reserve, 0); assert.equal(home.victory.gave, home.victory.forBooking);
    // No maximum on the quote: no victory, nothing invented.
    assert.equal(bookingHome({ ...booking, quote: { ...booking.quote, budget: { budget: null, keep: 0, allowOver: 0 } } }, { now: app.agent.now(), preview: null, origin: null }).victory, null);
  } finally { await app.close(); }
});
