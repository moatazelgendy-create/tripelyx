// THE AI SAVINGS HUNTER's pages, through HTTP: the list needs a sign-in; the form creates a hunt and
// says why when it cannot; the hunt page shows the persistent card, the opportunity with its receipt
// and its verified-at line (or the plain reason the run was silent), and a previous price only when
// one was recorded; every answer goes through one route and is written down (a "no" whose reason
// cannot move a rule included); a field sent twice is refused by name, never joined; My Trips lists
// the hunt; another customer's hunt is a 404. Every number asserted is read back from the stored record.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, fixedNow } = require('./helpers');
const { ACCEPTANCE } = require('../server/trips/hunts');
const hunter = require('../server/trips/hunter');
const { format } = require('../server/lib/money');
const { toInput, dollarsToCents, monthsFrom, prefill } = require('../server/routes/hunts');
const { nextStep, headline, stamp, SIGNATURE } = require('../server/views/trips/hunts');

const money = c => format(c, 'USD');
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
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
// Words no hunt page may carry: no urgency, no scarcity, no predictions.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict)\b/i;
// A fixed hour, so moving the clock by minutes never crosses midnight UTC.
function fixedClock() { const d = fixedNow(); d.setUTCHours(9, 0, 0, 0); return d; }
const minutes = n => n * 60000;
const FORM = [['budget', '3,000'], ['from', 'NYC'], ['travelers', '2'], ['who', 'couple'], ['when', 'anytime'], ['nights', '4'], ['maxNights', '4'], ['style', 'beach'], ['nonstop', 'preferred'], ['stars', ''], ['meals', ''], ['bags', ''], ['threshold', 'recommend'], ['savingsLevel', 'balanced'], ...['under', 'drop', 'extra-night', 'nonstop', 'quality', 'destination'].map(k => ['notify', k])];
const signup = (c, email, next = '/hunts') => c.req('/signup', { method: 'POST', form: { name: 'Ada Lovelace', email, password: 'correct horse battery', next } });

test('the form fields become the service input as typed; the page helpers are the service’s own arithmetic and the spec’s words', () => {
  assert.equal(dollarsToCents('1,500'), 150000);
  assert.equal(dollarsToCents('$912.50'), 91250);
  assert.ok(Number.isNaN(dollarsToCents('soon')), 'an unreadable amount is refused by the service, not guessed');
  const input = toInput({ budget: '3,000', from: 'nyc', who: 'couple', when: 'flexible', month: '2027-06', nights: '4', nonstop: 'preferred', stars: '4', refundable: '1', meals: 'breakfast', bags: 'checked', threshold: 'custom', thresholdCustom: '75', savingsLevel: 'aggressive', notify: ['under', 'beat-saved', 'drop'] });
  assert.equal(input.budget, 300000);
  assert.equal(input.origin, 'NYC');
  assert.equal(input.travelers, undefined, 'blank travelers lets the service fill in the usual number');
  assert.deepEqual([input.dateMode, input.month, input.minNights, input.maxNights], ['flexible', '2027-06', '4', undefined]);
  assert.deepEqual(input.rules, { flightStops: 'nonstop', flightRule: 'preferred', minStars: '4', refundable: '1', meals: 'breakfast', bags: 'checked' });
  assert.equal(input.threshold, 7500);
  assert.equal(input.savingsLevel, 'aggressive');
  assert.deepEqual(input.notify, ['under', 'drop'], 'beat-saved applies only with a saved trip chosen');
  assert.deepEqual(toInput({ nonstop: 'hard', threshold: '10000' }).rules.flightRule, 'hard');
  assert.equal(toInput({ threshold: '10000' }).threshold, '10000');
  assert.equal(toInput({}).threshold, 'recommend');
  // What the form does not offer is handed to the service as sent, which refuses it in words: a
  // cancellation answer is read as yes or no there ("false" is no rule, never the rule), an unknown
  // flights value is never "no rule".
  assert.equal(toInput({ refundable: 'false' }).rules.refundable, 'false');
  assert.equal(toInput({}).rules.refundable, null);
  assert.deepEqual([toInput({ nonstop: 'weird' }).rules.flightStops, toInput({ nonstop: '' }).rules.flightStops], ['weird', null]);
  // A field sent twice is refused by name, never joined: "1" and "500" are not $1,500, two radios with
  // one name are not a rule, and an amount that is not one typed string is unreadable.
  const twice = (body, re) => assert.throws(() => toInput(body), e => e.name === 'AppError' && e.status === 422 && re.test(e.message));
  twice({ budget: ['1', '500'] }, /^The form sent the limit more than once; send it again with one value\.$/);
  twice({ threshold: 'custom', thresholdCustom: ['2', '50'] }, /the saving worth an interruption more than once/);
  twice({ nonstop: ['hard', 'hard'] }, /the flights rule more than once/);
  twice({ refundable: ['1', '0'] }, /the cancellation rule more than once/);
  twice({ stars: ['4', '5'] }, /the hotel stars more than once/);
  twice({ saved: ['a', 'b'] }, /the saved trip more than once/);
  assert.ok(Number.isNaN(dollarsToCents(['1', '500'])) && Number.isNaN(dollarsToCents(undefined)));
  assert.deepEqual(prefill({ budget: ['1', '500'], from: 'NYC', notify: ['under', ['x']] }), { budget: '', from: 'NYC', notify: ['under'] }, 'a prefill never joins a repeated field: it comes back blank');
  assert.equal(monthsFrom(new Date('2026-11-15T12:00:00Z')).length, 12);
  assert.deepEqual(monthsFrom(new Date('2026-11-15T12:00:00Z')).slice(0, 3), ['2026-11', '2026-12', '2027-01']);
  // "Find me something even better": the next $50 step at least $50 below the total, as the service does it.
  assert.equal(nextStep(142023), 135000);
  assert.equal(nextStep(140000), 135000);
  assert.equal(nextStep(100000), 95000);
  assert.equal(nextStep(3000), 5000, 'never below one step');
  const hunt = { budget: 100000 };
  const opp = (kind, extra = {}) => ({ kind, trip: { token: 'a', dest: 'Cancun' }, previous: null, delta: 1200, ...extra });
  assert.equal(headline(opp('found'), hunt), 'New opportunity');
  assert.equal(headline(opp('breakthrough'), hunt), 'Budget breakthrough');
  assert.equal(headline(opp('extra-night'), hunt), 'Your money just got an extra night');
  assert.equal(headline(opp('quality'), hunt), 'Same money. Better hotel.');
  assert.equal(headline(opp('nonstop'), hunt), 'Nonstop just entered your budget');
  assert.equal(headline(opp('destination'), hunt), 'Your $1,000 just unlocked Cancun');
  assert.equal(headline(opp('beat-saved'), hunt), 'Beats your saved trip');
  assert.equal(headline(opp('drop', { previous: { token: 'a', total: 2000 } }), hunt), 'The same trip dropped by $12');
  assert.equal(headline(opp('drop', { previous: { token: 'b', total: 2000 } }), hunt), '$12 less than the trip I found before');
  assert.equal(stamp('2026-10-07T09:05:00.000Z'), '7 Oct 2026, 09:05 UTC');
  assert.deepEqual(SIGNATURE, ['Don’t watch prices. Let AI watch your money.', 'Tell us your max. We’ll wait for the right trip.', 'No spam. No fake deals. Just a reason to travel.']);
});

test('the hunt pages: sign-in required, the form creates a hunt or says why not, the hunt page shows the card, the opportunity with receipt and verified line, the answers, My Trips, and a 404 for another customer', async () => {
  let clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const maps = app.tripService.inv.maps;
    const c = client(app.base);
    // Anonymous: every hunt page asks for a sign-in and comes back here.
    const anon = await c.req('/hunts');
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/signin?next=%2Fhunts');
    assert.equal((await c.req('/hunts/new')).status, 303);
    assert.equal((await c.req('/hunts', { method: 'POST', form: FORM })).status, 303, 'a post without a session is sent to sign in, nothing is created');
    assert.deepEqual(await app.store.listRecords('hunt'), []);
    assert.equal((await signup(c, 'ada@example.com')).status, 303);

    // The empty list carries the signature lines and the honest monitoring sentence.
    const empty = await c.req('/hunts');
    assert.equal(empty.status, 200);
    const et = text(empty.text);
    for (const line of SIGNATURE) assert.ok(et.includes(line), line);
    assert.ok(et.includes(app.hunts.monitoringText()));
    assert.match(empty.text, /href="\/hunts\/new"/);
    assert.ok(!PRESSURE.test(et));

    // The form is prefilled from the query string and names every win in the customer's words.
    const form = await c.req('/hunts/new?budget=1500&from=NYC&who=family&nights=5&threshold=10000');
    assert.equal(form.status, 200);
    assert.match(form.text, /name="budget"[^>]*value="1500"/);
    assert.match(form.text, /<option value="NYC" selected>/);
    assert.match(form.text, /name="who" value="family" checked/);
    assert.match(form.text, /<option value="5" selected>5 nights<\/option>/);
    assert.match(form.text, /name="threshold" value="10000" checked/);
    const ft = text(form.text);
    for (const line of ['A good trip is under $1,500', 'The same trip drops by $100 or more', 'I can get an extra night without spending more', 'A nonstop option enters my budget', 'Same money, better hotel', 'A new destination enters my budget', '$50 or more', '$200 or more', 'Only tell me when you find something you’d actually recommend', 'Hunt for a trip']) assert.ok(ft.includes(line), line);
    assert.ok(!ft.includes('You beat my saved trip'), 'no saved trips: the beat-saved win is not offered');
    assert.ok(ft.includes(app.hunts.monitoringText()));
    assert.ok(!PRESSURE.test(ft));

    // A refused form comes back as typed, with the service's own sentence.
    const low = await c.req('/hunts', { method: 'POST', form: FORM.map(([k, v]) => [k, k === 'budget' ? '50' : v]) });
    assert.equal(low.status, 422);
    assert.ok(text(low.text).includes('The limit must be between $100 and $50,000.'));
    assert.match(low.text, /name="budget"[^>]*value="50"/);
    const none = await c.req('/hunts', { method: 'POST', form: FORM.filter(([k]) => k !== 'notify') });
    assert.equal(none.status, 422);
    assert.ok(text(none.text).includes('Tick at least one kind of win worth telling you about.'));
    assert.doesNotMatch(none.text, /name="notify"[^>]*checked/, 'the unticked boxes stay unticked');
    // A field sent twice (two radios with one name, a crafted post) is refused by name and comes back
    // blank, never joined into a number the customer did not type or quietly read as no rule.
    const twiceBudget = await c.req('/hunts', { method: 'POST', form: [...FORM.filter(([k]) => k !== 'budget'), ['budget', '1'], ['budget', '500']] });
    assert.equal(twiceBudget.status, 422);
    assert.ok(text(twiceBudget.text).includes('The form sent the limit more than once; send it again with one value.'));
    assert.match(twiceBudget.text, /name="budget"[^>]*value=""/, 'the repeated field comes back blank');
    assert.ok(text(twiceBudget.text).includes('A good trip is under my limit') && !text(twiceBudget.text).includes('A good trip is under $1,500'), 'nothing was read from it');
    const twiceNonstop = await c.req('/hunts', { method: 'POST', form: [...FORM, ['nonstop', 'hard']] });
    assert.equal(twiceNonstop.status, 422);
    assert.ok(text(twiceNonstop.text).includes('The form sent the flights rule more than once; send it again with one value.'));
    const oddNonstop = await c.req('/hunts', { method: 'POST', form: FORM.map(([k, v]) => [k, k === 'nonstop' ? 'sometimes' : v]) });
    assert.equal(oddNonstop.status, 422);
    assert.ok(text(oddNonstop.text).includes('Flights are either nonstop or open.'), 'an unknown flights value is refused, never read as no rule');
    assert.deepEqual(await app.store.listRecords('hunt'), [], 'nothing is stored until the form is right');
    // "refundable=false" is no rule, as the service reads it; "on" is the rule.
    const asObject = pairs => Object.fromEntries(pairs.filter(([k]) => k !== 'notify'));
    assert.equal(app.hunts.validate(toInput({ ...asObject(FORM), refundable: 'false' })).rules.refundable, false);
    assert.equal(app.hunts.validate(toInput({ ...asObject(FORM), refundable: '1' })).rules.refundable, true);
    // A prefill from a repeated query key is blank, not "1,500".
    const twiceQuery = await c.req('/hunts/new?budget=1&budget=500&from=NYC');
    assert.equal(twiceQuery.status, 200);
    assert.match(twiceQuery.text, /name="budget"[^>]*value=""/);
    assert.ok(text(twiceQuery.text).includes('A good trip is under my limit') && !text(twiceQuery.text).includes('A good trip is under $1,500'));
    assert.match(twiceQuery.text, /<option value="NYC" selected>/, 'the fields sent once are kept');

    // The form creates the hunt and lands on its page.
    const post = await c.req('/hunts', { method: 'POST', form: FORM });
    assert.equal(post.status, 303);
    assert.match(post.headers.get('location'), /^\/hunts\/hnt_/);
    const id = post.headers.get('location').split('/').pop();
    const h0 = await app.store.getRecord('hunt', id);
    assert.equal(h0.name, '$3,000 Beach Hunt');
    assert.deepEqual([h0.budget, h0.origin, h0.travelers, h0.who, h0.dateMode, h0.minNights, h0.maxNights, h0.style], [300000, 'NYC', 2, 'couple', 'anytime', 4, 4, 'beach']);
    assert.deepEqual(h0.rules, { flightStops: 'nonstop', flightRule: 'preferred', minStars: null, refundable: null, meals: null, bags: null });
    assert.deepEqual(h0.notify, ['under', 'drop', 'extra-night', 'nonstop', 'quality', 'destination']);
    assert.equal(h0.threshold, 'recommend');
    assert.equal(h0.runs.length, 1, 'created runs once');

    // The hunt page: the persistent card, the acceptance line, the monitoring sentence, the rules.
    const page = await c.req(`/hunts/${id}`);
    assert.equal(page.status, 200);
    assert.equal((await app.store.getRecord('hunt', id)).runs.length, 1, 'opening a hunt checked a moment ago runs nothing');
    const t = text(page.text);
    assert.ok(t.includes('My travel money $3,000'));
    assert.ok(t.includes('Status HUNTING'));
    const best = h0.baseline.best;
    if (best) {
      assert.ok(t.includes(`Best current opportunity ${money(best.total)} ${best.nights} nights in ${maps.getDestination(best.dest).name}`), 'the best is the stored baseline');
      assert.ok(t.includes(`Potential money kept ${money(h0.budget - best.total)}`), 'kept is the ceiling minus the stored best');
      assert.ok(page.text.includes(`href="/trip/${best.token}?b=3000"`));
    } else {
      assert.ok(t.includes('Best current opportunity nothing qualifies yet'));
      assert.ok(t.includes('Potential money kept —'));
    }
    assert.ok(t.includes(h0.lastMeaningfulAt ? `Last meaningful improvement ${stamp(h0.lastMeaningfulAt)}` : 'Last meaningful improvement none yet'));
    assert.ok(t.includes(`Last checked ${stamp(h0.lastRunAt)}`));
    assert.ok(t.includes(ACCEPTANCE));
    assert.ok(t.includes(app.hunts.monitoringText()));
    for (const line of hunter.ruleLines(h0, { maps })) assert.ok(t.includes(line), line);
    assert.ok(t.includes('Tell me when: a good trip is under $3,000; the same trip drops; I can get an extra night without spending more; a nonstop option enters my budget; same money, better hotel; a new destination enters my budget.'));
    const run0 = h0.runs[0];
    assert.ok(t.includes(`Checked ${stamp(run0.at)} (first check): ${run0.destinations} destinations, ${run0.considered} packages; ${run0.silent ? run0.silent : `${run0.opportunities} ${run0.opportunities === 1 ? 'opportunity' : 'opportunities'}`}`), 'the run log is the stored run');
    assert.ok(t.includes('Find me something even better'));
    assert.ok(t.includes(`Looks for the same quality under ${money(nextStep(best ? best.total : h0.budget))}`));
    assert.match(page.text, /name="action" value="stop"/);
    assert.doesNotMatch(page.text, /name="action" value="resume"/);
    assert.doesNotMatch(page.text, / style="|<script(?![^>]*\bsrc=)/, 'no inline styles or scripts under the strict CSP');
    assert.ok(!PRESSURE.test(t), 'no urgency anywhere');
    assert.ok(!/What I recorded|as I recorded it/.test(t), 'no previous price is shown when none was recorded');

    // The opportunity card, when the first run found one; the silent line otherwise.
    if (h0.opportunities.length) {
      const o = h0.opportunities[h0.opportunities.length - 1];
      assert.ok(['found', 'breakthrough'].includes(o.kind));
      assert.ok(t.includes(o.kind === 'found' ? 'New opportunity' : 'Budget breakthrough'));
      assert.ok(t.includes(`${o.trip.nights} nights in ${o.trip.dest} for ${money(o.trip.total)}`));
      const decision = hunter.decisionText(o, h0);
      assert.ok(t.includes(decision.slice(0, decision.indexOf(' Current price was verified at'))), 'the decision text, word for word');
      assert.ok(t.includes('This currently meets the rules you gave me.'));
      assert.ok(t.includes('Why you’re seeing this'));
      for (const line of [...o.receipt.rules, ...o.receipt.found, o.receipt.why]) assert.ok(t.includes(line), line);
      assert.ok(t.includes(`Current price was verified at ${stamp(o.verifiedAt)}. Price and availability may change.`));
      assert.ok(page.text.includes(`href="/trip/${o.trip.token}?b=3000"`), 'See trip opens the priced trip under this budget');
      assert.ok(t.includes('See trip') && t.includes('Keep waiting') && t.includes('Not good enough'));
      for (const chip of ['Lower price', 'Better hotel', 'More nights', 'Nonstop', 'Different destination']) assert.ok(t.includes(chip), chip);
      assert.equal((page.text.match(/name="action" value="improve"/g) || []).length, 5 * h0.opportunities.length, 'five improve chips per opportunity');
      assert.ok(!t.includes('Compare'), 'nothing to compare with on a first find');
    } else {
      assert.ok(t.includes(`Nothing worth interrupting you for yet: ${run0.silent}.`));
    }

    const respond = (fields, hunt = id) => c.req(`/hunts/${hunt}/respond`, { method: 'POST', form: fields });
    const stored = () => app.store.getRecord('hunt', id);

    // Keep waiting: the opportunities are seen, nothing runs, and the page says what was learned.
    const kw = await respond({ action: 'keep-waiting', opportunityId: h0.opportunities.length ? h0.opportunities[0].id : '' });
    assert.equal(kw.status, 303);
    assert.equal(kw.headers.get('location'), `/hunts/${id}`);
    const h1 = await stored();
    assert.ok(h1.opportunities.every(o => o.status === 'seen'));
    assert.equal(h1.runs.length, 1);
    assert.equal(h1.learned.at(-1).text, 'You chose to keep waiting; nothing changed');
    const p1 = text((await c.req(`/hunts/${id}`)).text);
    assert.ok(p1.includes(`${stamp(h1.learned.at(-1).at)} You chose to keep waiting; nothing changed`));
    if (h1.opportunities.length) assert.ok(p1.includes('Seen'));

    // Not good enough, more nights: the minimum rises by one and the hunt re-checks under the new rules.
    const mn = await respond({ action: 'improve', what: 'nights' });
    assert.equal(mn.status, 303);
    const h2 = await stored();
    assert.equal(h2.minNights, (best ? best.nights : h0.minNights) + 1);
    assert.equal(h2.maxNights, h2.minNights, 'a fixed-length hunt’s maximum follows the minimum');
    assert.equal(h2.learned.at(-1).text, `Minimum nights raised to ${h2.minNights}, and the maximum to ${h2.minNights} to match`, 'and the line says both numbers that moved');
    assert.equal(h2.runs.length, 2);
    assert.equal(h2.runs[1].reason, 'updated');
    const p2 = text((await c.req(`/hunts/${id}`)).text);
    assert.ok(p2.includes(`Minimum: ${h2.minNights} nights`));
    assert.ok(p2.includes(`Minimum nights raised to ${h2.minNights}`));
    assert.ok(p2.includes(`Checked ${stamp(h2.runs[1].at)} (after you changed the rules)`));

    // Find me something even better: the target is the $50 step below the found total, said on the page.
    const hd = await respond({ action: 'harder' });
    assert.equal(hd.status, 303);
    const h3 = await stored();
    assert.equal(h3.target % 5000, 0);
    assert.ok(h3.target < h3.budget);
    assert.match(h3.learned.at(-1).text, /^Now looking under \$[\d,]+/);
    const p3 = text((await c.req(`/hunts/${id}`)).text);
    assert.ok(p3.includes(`Now looking under ${money(h3.target)} for the same quality`));
    assert.ok(p3.includes(`Beat: ${money(h3.target)} for the same quality`));
    assert.ok(p3.includes('My travel money $3,000'), 'the limit stands');

    // A refused answer is said on the page, not lost: nonstop can become a hard rule only once.
    assert.equal((await respond({ action: 'improve', what: 'nonstop' })).status, 303);
    assert.deepEqual([(await stored()).rules.flightStops, (await stored()).rules.flightRule], ['nonstop', 'hard']);
    const twice = await respond({ action: 'improve', what: 'nonstop' });
    assert.equal(twice.status, 422);
    const tt = text(twice.text);
    assert.ok(tt.includes('Nonstop flights are already a hard rule.'));
    assert.ok(tt.includes('My travel money $3,000'), 'the hunt page is rendered with the message');
    assert.equal((await respond({ action: 'dance' })).status, 422);
    // "Not good enough" with a reason whose rule cannot move is still a no: the trip is rejected, the
    // line carries the refusal, nothing searched, and the page shows both.
    const beforeNo = await stored();
    const no = await respond({ action: 'reject', reason: 'too much travel', opportunityId: beforeNo.opportunities.length ? beforeNo.opportunities.at(-1).id : '' });
    assert.equal(no.status, 303);
    const afterNo = await stored();
    assert.equal(afterNo.learned.at(-1).text, "Rejected: 'too much travel'; Nonstop flights are already a hard rule. The rules stand until you say what to change");
    assert.equal(afterNo.runs.length, beforeNo.runs.length, 'nothing searched');
    if (beforeNo.opportunities.length) assert.equal(afterNo.opportunities.at(-1).status, 'rejected');
    const pNo = text((await c.req(`/hunts/${id}`)).text);
    assert.ok(pNo.includes(`${stamp(afterNo.learned.at(-1).at)} Rejected: 'too much travel'; Nonstop flights are already a hard rule. The rules stand until you say what to change`));
    if (beforeNo.opportunities.length) assert.ok(pNo.includes('Rejected'));

    // Stop is one button; resume is the other.
    assert.equal((await respond({ action: 'stop' })).status, 303);
    const h4 = await stored();
    assert.equal(h4.status, 'stopped');
    const p4 = (await c.req(`/hunts/${id}`));
    assert.ok(text(p4.text).includes('Status STOPPED'));
    assert.match(p4.text, /name="action" value="resume"/);
    assert.doesNotMatch(p4.text, /name="action" value="stop"/);
    assert.equal((await respond({ action: 'resume' })).status, 303);
    assert.equal((await stored()).status, 'hunting');

    // A previous price appears only because the platform recorded one: a second hunt whose recorded
    // best is dearer than the same trip priced now shows the drop against what was recorded.
    const post2 = await c.req('/hunts', { method: 'POST', form: FORM });
    const id2 = post2.headers.get('location').split('/').pop();
    const g0 = await app.store.getRecord('hunt', id2);
    if (g0.baseline.best) {
      const recorded = g0.baseline.best.total + 10000;
      await app.store.putRecord('hunt', id2, { ...g0, baseline: { ...g0.baseline, best: { ...g0.baseline.best, total: recorded } } }, { userId: g0.userId });
      clock = new Date(clock.getTime() + minutes(11));
      const page2 = await c.req(`/hunts/${id2}`);
      assert.equal(page2.status, 200);
      const g1 = await app.store.getRecord('hunt', id2);
      assert.equal(g1.runs.length, 2, 'opening a hunt checked over ten minutes ago re-checks it');
      assert.equal(g1.runs[1].reason, 'opened');
      const t2 = text(page2.text);
      assert.ok(t2.includes(`Checked ${stamp(g1.runs[1].at)} (when you opened it)`));
      const drop = g1.opportunities.find(o => o.kind === 'drop');
      assert.ok(drop, 'the same trip, priced lower than the recorded total, is a drop');
      assert.equal(drop.previous.total, recorded);
      assert.equal(drop.delta, 10000);
      assert.ok(t2.includes(`The same trip dropped by ${money(drop.delta)}`));
      assert.ok(t2.includes('This trip as I recorded it, against its price now'));
      assert.ok(t2.includes(`Total ${money(recorded)} ${money(drop.trip.total)}`), 'recorded against now, both from the record');
      assert.ok(t2.includes(`The 4-night ${drop.trip.dest} trip I found is now ${money(drop.trip.total)} total, ${money(drop.delta)} less than the ${money(recorded)} I recorded.`));
      assert.ok(t2.includes(`Last meaningful improvement ${stamp(g1.lastMeaningfulAt)}`));
      assert.ok(!t2.includes('Compare'), 'the same trip has nothing to compare with');

      // A saved trip to beat: the form offers it, and choosing it switches the beat-saved win on.
      assert.equal((await c.req(`/trip/${g0.baseline.best.token}/save?b=3000`, { method: 'POST', form: { kind: 'saved' } })).status, 303);
      const withSaved = await c.req('/hunts/new');
      assert.ok(withSaved.text.includes(`<option value="${g0.baseline.best.token}"`), 'the saved trip is offered');
      assert.ok(text(withSaved.text).includes('You beat my saved trip'));
      const post3 = await c.req('/hunts', { method: 'POST', form: [...FORM, ['saved', g0.baseline.best.token], ['notify', 'beat-saved']] });
      assert.equal(post3.status, 303);
      const g3 = await app.store.getRecord('hunt', post3.headers.get('location').split('/').pop());
      assert.equal(g3.savedToken, g0.baseline.best.token);
      assert.ok(g3.notify.includes('beat-saved'));
      const t3 = text((await c.req(`/hunts/${g3.id}`)).text);
      assert.match(t3, /Tell me when: a good trip is under \$3,000; [^.]*you beat my saved trip\./, 'the saved-trip win is named among the wins, in the order the form sent them');
      assert.ok(t3.includes('Travelers: 2 (a couple) from New York'));
      await app.store.deleteRecord('hunt', g3.id);
    }

    // My Trips lists the hunts from their stored facts and links to them.
    const mt = await c.req('/my-trips');
    assert.equal(mt.status, 200);
    const mtt = text(mt.text);
    assert.ok(mtt.includes('Hunts'));
    assert.ok(mtt.includes(h0.name));
    assert.ok(mt.text.includes(`href="/hunts/${id}"`) && mt.text.includes(`href="/hunts/${id2}"`));
    const list = await app.hunts.list({ id: h0.userId });
    for (const h of list) {
      assert.ok(mtt.includes(h.summary.bestTotal === null ? 'nothing qualifies yet' : `Best current opportunity: ${money(h.summary.bestTotal)}`));
      if (h.summary.bestTotal !== null) assert.ok(mtt.includes(`Potential money kept: ${money(h.summary.kept)}`));
      assert.ok(mtt.includes(`Last checked: ${stamp(h.summary.lastRunAt)}`));
    }
    assert.ok(mt.text.includes('href="/hunts"'));
    const all = text((await c.req('/hunts')).text);
    assert.ok(all.includes('Your hunts') && all.includes(h0.name));

    // The homepage offers the hunt under "Save me the most".
    const home = await c.req('/');
    assert.equal(home.status, 200);
    assert.ok(home.text.includes('href="/hunts/new"') && text(home.text).includes('I can wait: let the AI hunt for it'));

    // Another customer: the hunt does not exist for them, and nothing of theirs changes.
    const bob = client(app.base);
    assert.equal((await signup(bob, 'bob@example.com')).status, 303);
    assert.equal((await bob.req(`/hunts/${id}`)).status, 404);
    assert.equal((await bob.req(`/hunts/${id}/respond`, { method: 'POST', form: { action: 'stop' } })).status, 404);
    assert.equal((await stored()).status, 'hunting');
    assert.ok(!text((await bob.req('/hunts')).text).includes(h0.name));
    assert.ok(!text((await bob.req('/my-trips')).text).includes(h0.name));
  } finally { await app.close(); }
});

// ======== Page wording, against the service's and the engine's own facts ===========================
// A separate block from the route tests above: every assertion here is about a sentence the pages
// carry and the fact it rests on, read from the engine, the service or the inventory, never a fixed
// figure. The rules: never promise a check that does not run, never call a price now a record,
// never imply a search that did not occur, say the real rule behind a default.
const { SEARCH_WORDS, STOPPED_WORDS, ALL_STOPPED_WORDS, huntView } = require('../server/views/trips/hunts');
const { REFRESH_MAX_AGE_MINUTES, monthClosed } = require('../server/trips/hunts');
const { priceTrip } = require('../server/trips/pricing');
const { encodeSpec, decodeSpec } = require('../server/trips/spec');
const { addDays } = require('../server/lib/dates');
const DAY = 86400000;
const gaps = dates => [...new Set(dates.slice(1).map((d, i) => (Date.parse(d) - Date.parse(dates[i])) / DAY))];

test('page wording: the search sentence says what the engine asks (every second day of an anytime window, every day of a chosen month), and the blank "up to" says the service’s real cap', async () => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const c = client(app.base);
    await signup(c, 'words@example.com');
    // The engine's own grid: an anytime window is asked every second day, a chosen month every day.
    assert.deepEqual(gaps(hunter.windowDates({ dateMode: 'anytime', month: null }, clock)), [2], 'the engine skips every other day of an anytime window');
    assert.deepEqual(gaps(hunter.windowDates({ dateMode: 'flexible', month: monthsFrom(clock)[1] }, clock)), [1], 'the engine asks every day of a chosen month');
    assert.ok(SEARCH_WORDS.includes('every second day of your window') && SEARCH_WORDS.includes('every day of a chosen month'));
    // The form, the empty list and the empty Hunts section of My Trips all carry that sentence and
    // never claim every departure.
    for (const path of ['/hunts/new', '/hunts', '/my-trips']) {
      const t = text((await c.req(path)).text);
      assert.ok(t.includes(SEARCH_WORDS), `${path} says what a check asks for`);
      assert.doesNotMatch(t, /every departure/, `${path} never claims every departure is asked`);
    }
    // The blank "up to" is the service's own rule, read back from validate for a run of minimums: a
    // fixed number of extra nights up to a cap, so a long minimum gets fewer; the option says both.
    const base = toInput({ ...Object.fromEntries(FORM.filter(([k]) => k !== 'notify')), notify: ['under'] });
    const mins = [2, 4, 11, 12, 13, 14];
    const maxes = mins.map(n => app.hunts.validate({ ...base, minNights: String(n), maxNights: undefined }, clock).maxNights);
    const extra = maxes[0] - mins[0], cap = Math.max(...maxes);
    assert.ok(mins.some((n, i) => maxes[i] - n < extra), 'the cap is real: a long minimum gets fewer extra nights');
    assert.ok(mins.every((n, i) => maxes[i] === Math.min(n + extra, cap)), 'the option’s two numbers are the whole rule');
    const form = text((await c.req('/hunts/new')).text);
    assert.ok(form.includes(`${extra} more nights than the minimum (never more than ${cap})`));
    assert.doesNotMatch(form, /I hear when a nonstop one fits/, 'hearing about a nonstop trip is the ticked win, not the flights rule');
  } finally { await app.close(); }
});

test('page wording: a stopped hunt promises no check, on open, on schedule or after an answer, and the list says so when every hunt is stopped', async () => {
  let clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const c = client(app.base);
    await signup(c, 'stopped@example.com');
    const post = await c.req('/hunts', { method: 'POST', form: FORM });
    assert.equal(post.status, 303);
    const id = post.headers.get('location').split('/').pop();
    const stored = () => app.store.getRecord('hunt', id);
    const respond = form => c.req(`/hunts/${id}/respond`, { method: 'POST', form });
    const monitoring = app.hunts.monitoringText();
    const promises = [monitoring, ACCEPTANCE, 'and the hunt re-checks.', 'rules; the hunt re-checks.', 'Looks for the same quality under'];
    const running = text((await c.req(`/hunts/${id}`)).text);
    for (const p of promises) assert.ok(running.includes(p), `a running hunt says: ${p.slice(0, 40)}`);
    assert.ok(!running.includes(STOPPED_WORDS));

    assert.equal((await respond({ action: 'stop' })).status, 303);
    clock = new Date(clock.getTime() + minutes(REFRESH_MAX_AGE_MINUTES + 1));
    const before = await stored();
    const page = text((await c.req(`/hunts/${id}`)).text);
    const after = await stored();
    assert.equal(after.runs.length, before.runs.length, 'opening a stopped hunt checks nothing, however old its last check');
    assert.ok(page.includes('Status STOPPED') && page.includes(STOPPED_WORDS));
    for (const p of promises) assert.ok(!page.includes(p), `a stopped hunt never says: ${p.slice(0, 40)}`);
    assert.ok(page.includes('and the hunt re-checks once you resume it.'));
    assert.ok(page.includes('Sets this hunt to look for the same quality under') && page.includes('; it looks once you resume it.'));
    if (after.opportunities.length) assert.ok(page.includes('Each answer changes this hunt’s rules; the hunt re-checks once you resume it.'));

    // An answer on the stopped hunt changes the rules, is written down and searches nothing; the
    // page after says it was not checked and still promises nothing.
    assert.equal((await respond({ action: 'improve', what: 'nights' })).status, 303);
    const changed = await stored();
    assert.equal(changed.runs.length, before.runs.length, 'nothing searched');
    assert.equal(changed.baseline, null);
    assert.match(changed.learned.at(-1).text, /^Minimum nights raised to/);
    const page2 = text((await c.req(`/hunts/${id}`)).text);
    assert.ok(page2.includes('not checked under these rules yet') && page2.includes(STOPPED_WORDS) && !page2.includes(monitoring));

    // The list carries the monitoring sentence only while a listed hunt is hunting.
    const list = text((await c.req('/hunts')).text);
    assert.ok(list.includes(ALL_STOPPED_WORDS) && !list.includes(monitoring));
    assert.equal((await respond({ action: 'resume' })).status, 303);
    const resumed = text((await c.req(`/hunts/${id}`)).text);
    assert.ok(resumed.includes(monitoring) && resumed.includes(ACCEPTANCE) && !resumed.includes(STOPPED_WORDS) && !resumed.includes('once you resume it'));
    assert.ok(text((await c.req('/hunts')).text).includes(monitoring));

    // A chosen month with nothing left to price: the run stops the hunt, the page says why, offers
    // a new hunt instead of a Resume the service refuses, and promises no later check.
    const month = monthsFrom(clock)[1];
    const postM = await c.req('/hunts', { method: 'POST', form: [...FORM.filter(([k]) => k !== 'when'), ['when', 'flexible'], ['month', month]] });
    assert.equal(postM.status, 303);
    const idM = postM.headers.get('location').split('/').pop();
    const [y, m] = month.split('-').map(Number);
    clock = new Date(Date.UTC(y, m, 9, 9)); // the 9th of the month after: the whole month is nearer than a week
    assert.ok(monthClosed(month, clock));
    // The sign-in session runs on the same clock and has expired with it: sign in again.
    assert.equal((await c.req('/signin', { method: 'POST', form: { email: 'stopped@example.com', password: 'correct horse battery', next: '/hunts' } })).status, 303);
    const runsBefore = (await app.store.getRecord('hunt', idM)).runs.length;
    const pageM = (await c.req(`/hunts/${idM}`)).text;
    const hM = await app.store.getRecord('hunt', idM);
    assert.equal(hM.status, 'stopped');
    assert.equal(hM.runs.length, runsBefore, 'a closed month is not logged as a check');
    const tM = text(pageM);
    assert.ok(tM.includes('This hunt is stopped: no departure in') && tM.includes('is left to price, so nothing is checked. Start a new hunt for a later month.'));
    assert.ok(tM.includes('this hunt checks nothing more') && !tM.includes('once you resume it') && !tM.includes(monitoring) && !tM.includes(ACCEPTANCE));
    assert.doesNotMatch(pageM, /name="action" value="resume"/);
    assert.match(pageM, /href="\/hunts\/new\?[^"]*when=flexible"/);
    assert.equal((await c.req(`/hunts/${idM}/respond`, { method: 'POST', form: { action: 'resume' } })).status, 422, 'the service refuses the resume the page no longer offers');
  } finally { await app.close(); }
});

test('page wording: the beat-saved card calls the saved trip’s price now a price now, and "recorded" is kept for what the record holds', async () => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const inv = app.tripService.inv, settings = await app.tripService.settings();
    const user = { id: 'usr_words', email: 'card@example.com' };
    const hunt = await app.hunts.create(user, { budget: 300000, origin: 'NYC', who: 'couple', dateMode: 'anytime', minNights: 4, maxNights: 4, style: 'beach', notify: ['under', 'drop'], threshold: 'recommend' });
    const best = hunt.baseline && hunt.baseline.best;
    if (!best) return; // nothing qualified today: no card to word
    const spec = decodeSpec(best.token);
    const trip = priceTrip(inv, spec, settings);
    // A saved trip: the same package on another date the inventory prices.
    let saved = null, savedToken = null;
    for (let k = 1; k <= 60 && !saved; k++) for (const d of [addDays(spec.depart, k), addDays(spec.depart, -k)]) { const t = priceTrip(inv, { ...spec, depart: d }, settings); if (t) { saved = t; savedToken = encodeSpec({ ...spec, depart: d }); break; } }
    assert.ok(saved, 'the inventory prices the package on another date');
    const render = opp => String(huntView(app.ctx, { hunt: { ...hunt, savedToken, opportunities: [opp] }, originCity: 'New York', destName: x => x, rules: [], monitoring: app.hunts.monitoringText(), acceptance: ACCEPTANCE }));
    const card = page => { const i = page.indexOf('<article class="hu-opp'); return page.slice(i, page.indexOf('</article>', i)); };
    const opp = (kind, previous) => ({ id: `opp_${kind}`, kind, status: 'new', at: clock.toISOString(), verifiedAt: clock.toISOString(), trip: hunter.huntCard(trip, best.token), previous, delta: 0, why: [], tradeoffs: [], receipt: { rules: [], found: [], why: '' } });

    // beat-saved: the engine's previous is the saved trip priced in the same run (a price now).
    const savedNow = hunter.huntCard(saved, savedToken);
    assert.equal(savedNow.total, priceTrip(inv, decodeSpec(savedToken), settings).total, 'the previous of a beat-saved card is the saved trip priced now');
    assert.equal(savedNow.recordedAt, undefined);
    const beat = card(render(opp('beat-saved', savedNow)));
    const bt = text(beat);
    assert.ok(bt.includes('Your saved trip, priced now, against this trip'));
    assert.ok(bt.includes(`Saved trip (now) This trip Total ${money(savedNow.total)} ${money(trip.total)}`));
    assert.doesNotMatch(bt, /[Rr]ecorded/, 'nothing on a beat-saved card is called a record');
    assert.match(beat, /\/compare\?[^"]*l=Saved\+trip&amp;l=This\+trip/);

    // The same trip's recorded price (a drop): recorded is recorded.
    const same = text(card(render(opp('drop', { token: best.token, total: trip.total + 100 }))));
    assert.ok(same.includes('This trip as I recorded it, against its price now') && same.includes(`Recorded Now Total ${money(trip.total + 100)} ${money(trip.total)}`));
    // Another trip the record holds, with its date: recorded on that date.
    const at = new Date(clock.getTime() - minutes(90)).toISOString();
    const other = text(card(render(opp('quality', { ...savedNow, recordedAt: at }))));
    assert.ok(other.includes(`What I recorded on ${stamp(at)}, against this trip now`) && other.includes('Recorded Now'));
    await app.store.deleteRecord('hunt', hunt.id);
  } finally { await app.close(); }
});
