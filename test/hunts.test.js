// THE AI SAVINGS HUNTER's record keeper: a hunt is validated and run once when created; the list's
// numbers are arithmetic on stored facts; opening a hunt re-checks it only when the last check is old;
// the scheduler runs only the hunts that are due and still hunting; every answer the customer gives
// changes the rules in plain words and re-runs; an opportunity sends exactly one message, written
// without pressure; silence sends nothing; a hunt belongs to its owner alone; the sentence about
// monitoring says only what the scheduler and the outbox really do; one writer per hunt at a time,
// so a sweep never writes over an answer and nothing is told twice; every hunting hunt is swept,
// oldest check first; a month with nothing left to price is refused, or stops the hunt with a line;
// and what the customer refused is remembered past the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, quietLog, fixedNow } = require('./helpers');
const { loadConfig } = require('../server/config');
const { HuntService, ACCEPTANCE, NOTIFY_KINDS, THRESHOLDS, REFRESH_MAX_AGE_MINUTES, MAX_OPPORTUNITIES, intervalWords, monthClosed } = require('../server/trips/hunts');
const { OutboxNotifier } = require('../server/trips/integrations/notifications');
const { MemoryStore } = require('../server/booking/MemoryStore');
const hunter = require('../server/trips/hunter');

// Words no hunt message may carry: the product promises no fake scarcity, no urgency, no predictions.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict)\b/i;

// A fixed hour of the day, so moving the clock by minutes never crosses midnight UTC (the searches
// are judged on the calendar day).
function fixedClock() { const d = fixedNow(); d.setUTCHours(9, 0, 0, 0); return d; }
const minutes = n => n * 60000;

const INPUT = { budget: 300000, origin: 'NYC', travelers: 2, who: 'couple', dateMode: 'anytime', minNights: 4, maxNights: 4, style: 'beach', threshold: 'recommend' };

async function user(app, email = 'ada@example.com') {
  return app.accounts.register({ name: 'Ada Lovelace', email, password: 'correct horse battery' });
}

test('the words: monitoring says only what the scheduler and the outbox do; the acceptance line promises selectivity', () => {
  const svc = minutesOn => new HuntService({ store: null, inventory: null, settings: async () => ({}), notifier: null, config: { trips: { huntIntervalMinutes: minutesOn } } });
  // The open clause says what refresh() does (a check only when the last one is older than its own
  // limit), with the number taken from that limit, so the sentence cannot drift from the behaviour.
  assert.equal(REFRESH_MAX_AGE_MINUTES, 10);
  const open = `when you open one if its last check is more than ${intervalWords(REFRESH_MAX_AGE_MINUTES)} old`;
  assert.equal(svc(360).monitoringText(), `This site re-checks your hunts about every 6 hours while they run, and ${open}. What it finds appears here and in My Trips, and by email once notifications are connected. It says nothing when nothing meaningful happened.`);
  assert.equal(svc(60).monitoringText(), `This site re-checks your hunts about every 1 hour while they run, and ${open}. What it finds appears here and in My Trips, and by email once notifications are connected. It says nothing when nothing meaningful happened.`);
  assert.equal(svc(90).monitoringText(), `This site re-checks your hunts about every 90 minutes while they run, and ${open}. What it finds appears here and in My Trips, and by email once notifications are connected. It says nothing when nothing meaningful happened.`);
  assert.equal(svc(0).monitoringText(), `This site re-checks your hunts only ${open}; nothing runs in between. What it finds appears here and in My Trips, and by email once notifications are connected.`);
  for (const n of [360, 0]) assert.ok(!/each time you open/.test(svc(n).monitoringText()), 'an open inside the limit runs nothing, so no sentence promises a check on every open');
  assert.equal(intervalWords(1), '1 minute');
  assert.equal(ACCEPTANCE, 'Got it. I won’t contact you just because something is cheap. I’ll contact you when I find a trip that meets your rules and looks worth considering.');
  assert.equal(HuntService.ACCEPTANCE, ACCEPTANCE);
  for (const text of [svc(360).monitoringText(), svc(0).monitoringText(), ACCEPTANCE]) assert.ok(!PRESSURE.test(text), text);
  assert.deepEqual(NOTIFY_KINDS, ['under', 'beat-saved', 'drop', 'extra-night', 'nonstop', 'quality', 'destination']);
  assert.deepEqual(THRESHOLDS, [5000, 10000, 20000]);
});

test('config: HUNT_INTERVAL_MINUTES defaults to 6 hours, 0 turns the scheduler off, nonsense fails at boot', () => {
  assert.equal(loadConfig({}).trips.huntIntervalMinutes, 360);
  assert.equal(loadConfig({ HUNT_INTERVAL_MINUTES: '0' }).trips.huntIntervalMinutes, 0);
  assert.equal(loadConfig({ HUNT_INTERVAL_MINUTES: '15' }).trips.huntIntervalMinutes, 15);
  assert.throws(() => loadConfig({ HUNT_INTERVAL_MINUTES: 'soon' }), /HUNT_INTERVAL_MINUTES must be a whole number/);
  assert.throws(() => loadConfig({ HUNT_INTERVAL_MINUTES: '-5' }), /HUNT_INTERVAL_MINUTES/);
  assert.throws(() => loadConfig({ HUNT_INTERVAL_MINUTES: '1.5' }), /HUNT_INTERVAL_MINUTES/);
});

test('start() does nothing with the scheduler off and sets one unref’d timer with it on; stop() clears it', () => {
  const off = new HuntService({ store: null, inventory: null, settings: async () => ({}), notifier: null, config: { trips: { huntIntervalMinutes: 0 } } });
  assert.equal(off.start(), false);
  assert.equal(off.timer, null);
  const on = new HuntService({ store: null, inventory: null, settings: async () => ({}), notifier: null, config: { trips: { huntIntervalMinutes: 5 } } });
  try {
    assert.equal(on.start(), true);
    assert.ok(on.timer);
    assert.equal(on.start(), false, 'a second start adds no second timer');
    assert.equal(on.timer.hasRef(), false, 'the timer never keeps the process alive');
  } finally { on.stop(); }
  assert.equal(on.timer, null);
});

test('create validates every field with a 422 and a plain sentence, names the hunt from its money and style, stores it and runs it once', async () => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const u = await user(app);
    const refused = (input, re) => assert.rejects(app.hunts.create(u, { ...INPUT, ...input }), e => e.name === 'AppError' && e.code === 'invalid_hunt' && e.status === 422 && re.test(e.message), JSON.stringify(input));
    await refused({ budget: 5000 }, /between \$100 and \$50,000/);
    await refused({ budget: 5000001 }, /between/);
    await refused({ budget: 1000.5 }, /between/);
    await refused({ origin: 'XXX' }, /departure city/);
    await refused({ travelers: 9 }, /between 1 and 8/);
    await refused({ travelers: 0 }, /between 1 and 8/);
    await refused({ who: 'robots' }, /who is going/);
    await refused({ dateMode: 'exact' }, /anytime or a month/);
    await refused({ dateMode: 'flexible' }, /YYYY-MM/);
    await refused({ dateMode: 'flexible', month: '2020-05' }, /passed/);
    await refused({ dateMode: 'flexible', month: '2027-13' }, /YYYY-MM/);
    // A month with no departure left to price is refused with the reason: the engine asks about
    // dates a week out, so from the 25th the current month has nothing to ask for. Judged on the
    // clock given, so the rule is tested the same on every day of the year.
    const at = iso => new Date(`${iso}T09:00:00Z`);
    const monthHunt = m => ({ ...INPUT, dateMode: 'flexible', month: m });
    assert.throws(() => app.hunts.validate(monthHunt('2027-02'), at('2027-03-01')), /That month has passed/);
    assert.equal(app.hunts.validate(monthHunt('2027-03'), at('2027-03-01')).month, '2027-03', 'the current month is allowed while a departure in it can be priced');
    assert.equal(app.hunts.validate(monthHunt('2027-03'), at('2027-03-24')).month, '2027-03', 'the 31st can still be asked about a week ahead');
    assert.throws(() => app.hunts.validate(monthHunt('2027-03'), at('2027-03-25')), e => e.code === 'invalid_hunt' && e.status === 422 && e.message === 'March 2027 has no departure left to price (the hunt asks about dates at least a week out); pick a later month.');
    assert.throws(() => app.hunts.validate(monthHunt('2027-12'), at('2027-12-25')), /December 2027 has no departure left to price/);
    assert.equal(app.hunts.validate(monthHunt('2028-01'), at('2027-12-25')).month, '2028-01');
    assert.deepEqual([monthClosed('2027-03', at('2027-03-24')), monthClosed('2027-03', at('2027-03-25')), monthClosed('2027-12', at('2027-12-24')), monthClosed('2027-12', at('2027-12-25'))], [false, true, false, true]);
    await refused({ minNights: 1 }, /between 2 and 14/);
    await refused({ minNights: 15 }, /between 2 and 14/);
    await refused({ minNights: 5, maxNights: 4 }, /between 5 and 14/);
    await refused({ style: 'weird' }, /style/);
    await refused({ rules: { flightStops: 'one-stop' } }, /nonstop or open/);
    await refused({ rules: { flightStops: 'nonstop', flightRule: 'maybe' } }, /hard or preferred/);
    await refused({ rules: { minStars: 7 } }, /between 2 and 5/);
    await refused({ rules: { meals: 'dinner' } }, /all-inclusive, breakfast or open/);
    await refused({ rules: { bags: 'trunk' } }, /personal, carry-on or checked/);
    await refused({ rules: { refundable: 'perhaps' } }, /yes or no/);
    await refused({ excludeDests: ['atlantis'] }, /not a destination/);
    await refused({ savedToken: 'not~a~token' }, /saved trip to beat could not be read/);
    await refused({ notify: ['magic'] }, /not a kind of win/);
    await refused({ notify: 'under' }, /which wins/);
    await refused({ notify: ['beat-saved'] }, /needs a saved trip/);
    await refused({ threshold: 0 }, /worth an interruption/);
    await refused({ threshold: 300001 }, /worth an interruption/);
    await refused({ threshold: 'whenever' }, /worth an interruption/);
    await refused({ savingsLevel: 'reckless' }, /balanced or aggressive/);
    await assert.rejects(app.hunts.create(null, INPUT), e => e.code === 'sign_in_required' && e.status === 401);
    assert.deepEqual(await app.store.listRecords('hunt'), [], 'nothing is stored until the input is right');

    const h = await app.hunts.create(u, INPUT);
    assert.match(h.id, /^hnt_/);
    assert.equal(h.userId, u.id);
    assert.equal(h.name, '$3,000 Beach Hunt');
    assert.equal(h.status, 'hunting');
    assert.equal(h.maxNights, 4);
    assert.deepEqual(h.rules, { flightStops: null, flightRule: null, minStars: null, refundable: null, meals: null, bags: null });
    assert.deepEqual(h.notify, ['under', 'drop', 'extra-night', 'nonstop', 'quality', 'destination'], 'beat-saved is off without a saved trip');
    assert.equal(h.threshold, 'recommend');
    assert.equal(h.savingsLevel, 'balanced');
    assert.equal(h.target, null);
    assert.deepEqual(h.floors, { minStars: null, nonstop: false });
    assert.equal(h.runs.length, 1, 'created runs once');
    assert.equal(h.runs[0].reason, 'created');
    assert.equal(h.runs[0].at, clock.toISOString());
    assert.equal(h.lastRunAt, clock.toISOString());
    assert.ok(h.runs[0].destinations > 0 && h.runs[0].considered > 0, 'the run says what it checked');
    assert.ok(h.baseline && h.baseline.at === clock.toISOString(), 'the baseline is this run');
    assert.ok(h.baseline.best, 'a $3,000 beach hunt for two finds a qualifying trip in the demo inventory');
    assert.equal(h.baseline.best.total, h.runs[0].bestTotal);
    assert.ok(h.baseline.best.total <= h.budget);
    assert.ok(h.baseline.best.nights >= h.minNights && h.baseline.best.nights <= h.maxNights);
    assert.deepEqual(Object.keys(h.baseline.best).sort(), ['dest', 'nights', 'stars', 'stops', 'token', 'total'], 'the baseline keeps facts, not the whole trip');
    assert.ok(Array.isArray(h.baseline.byDest));
    const stored = await app.store.getRecord('hunt', h.id);
    assert.deepEqual(stored, h, 'what is returned is what is stored');
    // Opportunities, when there are any, are stored new, carry ids and were notified.
    for (const o of h.opportunities) { assert.match(o.id, /^opp_/); assert.equal(o.status, 'new'); assert.equal(o.notified, true); assert.equal(o.verifiedAt, clock.toISOString()); }
    if (h.opportunities.length) assert.equal(h.lastMeaningfulAt, clock.toISOString()); else assert.equal(h.lastMeaningfulAt, null);

    // Defaults the hunt fills in: travelers from who, a month with departures left is allowed (next
    // month, so the test does not depend on the day), a given name is kept, the saved trip switches beat-saved on.
    const nextMonth = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    const h2 = await app.hunts.create(u, { ...INPUT, travelers: undefined, who: 'family', name: '  Spring break  ', dateMode: 'flexible', month: nextMonth, savedToken: h.baseline.best.token, rules: { flightStops: 'nonstop', minStars: '4', refundable: 'true' } });
    assert.equal(h2.travelers, 4);
    assert.equal(h2.name, 'Spring break');
    assert.equal(h2.month, nextMonth);
    assert.deepEqual(h2.remembered, [], 'the memory of what was told and refused starts empty');
    assert.ok(h2.notify.includes('beat-saved'));
    assert.deepEqual(h2.rules, { flightStops: 'nonstop', flightRule: 'hard', minStars: 4, refundable: true, meals: null, bags: null }, 'nonstop with no word on firmness is a hard rule');
  } finally { await app.close(); }
});

test('list is newest first and every summary number is arithmetic on stored facts; a hunt is invisible to another user', async () => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const ada = await user(app), bob = await user(app, 'bob@example.com');
    assert.deepEqual(await app.hunts.list(ada), []);
    const a = await app.hunts.create(ada, INPUT);
    const b = await app.hunts.create(ada, { ...INPUT, budget: 120000, name: 'Cheap week' });
    const c = await app.hunts.create(bob, INPUT);
    const mine = await app.hunts.list(ada);
    assert.deepEqual(mine.map(h => h.id), [b.id, a.id], 'newest first, only mine');
    for (const h of mine) {
      const stored = await app.store.getRecord('hunt', h.id);
      const bestTotal = stored.baseline.best ? stored.baseline.best.total : null;
      assert.equal(h.summary.bestTotal, bestTotal);
      assert.equal(h.summary.kept, bestTotal === null ? null : stored.budget - bestTotal);
      assert.equal(h.summary.lastRunAt, stored.lastRunAt);
      assert.equal(h.summary.lastMeaningfulAt, stored.lastMeaningfulAt);
      assert.equal(h.summary.status, stored.status);
      assert.equal(h.summary.newOpportunities, stored.opportunities.filter(o => o.status === 'new').length);
    }
    assert.deepEqual((await app.hunts.list(bob)).map(h => h.id), [c.id]);
    assert.deepEqual(await app.hunts.list(null), []);
    assert.equal((await app.hunts.get(ada, a.id)).id, a.id);
    const notFound = p => assert.rejects(p, e => e.name === 'AppError' && e.code === 'not_found' && e.status === 404);
    await notFound(app.hunts.get(bob, a.id));
    await notFound(app.hunts.get(ada, 'hnt_nothing'));
    await notFound(app.hunts.get(null, a.id));
    await notFound(app.hunts.refresh(bob, a.id));
    await notFound(app.hunts.respond(bob, a.id, 'stop'));
    assert.equal((await app.store.getRecord('hunt', a.id)).status, 'hunting', 'another user changed nothing');
  } finally { await app.close(); }
});

test('refresh re-checks only when the last check is older than maxAge, and a stopped hunt is left alone', async () => {
  let clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const u = await user(app);
    const h = await app.hunts.create(u, INPUT);
    const sent = async () => (await app.store.listRecords('outbox')).length;
    const before = await sent();
    const same = await app.hunts.refresh(u, h.id);
    assert.equal(same.runs.length, 1, 'inside maxAge nothing runs');
    assert.deepEqual(same, h, 'the hunt comes back untouched');
    clock = new Date(clock.getTime() + minutes(10));
    assert.equal((await app.hunts.refresh(u, h.id)).runs.length, 1, 'exactly maxAge old is still fresh');
    clock = new Date(clock.getTime() + minutes(1));
    const again = await app.hunts.refresh(u, h.id);
    assert.equal(again.runs.length, 2, 'older than maxAge runs');
    assert.equal(again.runs[1].reason, 'opened');
    assert.equal(again.runs[1].at, clock.toISOString());
    assert.equal(again.lastRunAt, clock.toISOString());
    // The same day, the same prices: the second run is silent, says why, and sends nothing.
    assert.equal(again.runs[1].opportunities, 0);
    assert.equal(typeof again.runs[1].silent, 'string');
    assert.equal(again.opportunities.length, h.opportunities.length);
    assert.equal(again.lastMeaningfulAt, h.lastMeaningfulAt, 'a silent run is not meaningful');
    assert.equal(await sent(), before, 'silence sends nothing');
    assert.equal((await app.hunts.refresh(u, h.id, { maxAgeMinutes: 0 })).runs.length, 2, 'a run at this very instant is not older than 0 minutes');
    clock = new Date(clock.getTime() + minutes(1));
    assert.equal((await app.hunts.refresh(u, h.id, { maxAgeMinutes: 0 })).runs.length, 3, 'maxAge 0 re-checks on open once any time has passed');

    await app.hunts.respond(u, h.id, 'stop');
    clock = new Date(clock.getTime() + minutes(30));
    const stopped = await app.hunts.refresh(u, h.id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.runs.length, 3, 'a stopped hunt never searches');
  } finally { await app.close(); }
});

test('runDue runs every due hunting hunt of every customer and nothing else; a scheduled run that finds something is logged', async () => {
  let clock = fixedClock();
  const lines = [];
  const log = { ...quietLog, info: (...a) => lines.push(a.join(' ')) };
  const app = await startApp({ HUNT_INTERVAL_MINUTES: '60' }, { now: () => clock, log });
  try {
    const ada = await user(app), bob = await user(app, 'bob@example.com');
    const a = await app.hunts.create(ada, INPUT);
    const b = await app.hunts.create(ada, { ...INPUT, name: 'Paused' });
    await app.hunts.respond(ada, b.id, 'stop');
    const c = await app.hunts.create(bob, { ...INPUT, budget: 250000 });
    assert.deepEqual(await app.hunts.runDue(), { ran: 0, found: 0 }, 'just created: nothing is due');
    clock = new Date(clock.getTime() + minutes(59));
    assert.deepEqual(await app.hunts.runDue(), { ran: 0, found: 0 }, 'inside the interval nothing is due');
    clock = new Date(clock.getTime() + minutes(1));
    const r = await app.hunts.runDue();
    assert.equal(r.ran, 2, 'both hunting hunts, across customers');
    const [ra, rb, rc] = await Promise.all([a.id, b.id, c.id].map(id => app.store.getRecord('hunt', id)));
    assert.equal(ra.runs.length, 2); assert.equal(ra.runs[1].reason, 'scheduled'); assert.equal(ra.lastRunAt, clock.toISOString());
    assert.equal(rc.runs.length, 2); assert.equal(rc.runs[1].reason, 'scheduled');
    assert.equal(rb.runs.length, 1, 'a stopped hunt is not run');
    assert.equal(r.found, ra.runs[1].opportunities + rc.runs[1].opportunities);
    assert.equal(lines.filter(l => /scheduled run of/.test(l)).length, [ra, rc].filter(h => h.runs[1].opportunities > 0).length, 'one log line per scheduled run that found something');
    assert.deepEqual(await app.hunts.runDue(), { ran: 0, found: 0 }, 'nothing is due twice');
    // A hunt that has never run is due; a hunt whose run throws is logged, not thrown, and the others still run.
    await app.store.putRecord('hunt', 'hnt_never', { ...ra, id: 'hnt_never', runs: [], baseline: null, opportunities: [], lastRunAt: null }, { userId: ada.id });
    await app.store.putRecord('hunt', 'hnt_broken', { ...ra, id: 'hnt_broken', budget: null, lastRunAt: null }, { userId: ada.id });
    const errors = [];
    app.hunts.log = { ...log, error: (...x) => errors.push(x[0]) };
    const r2 = await app.hunts.runDue();
    assert.equal(r2.ran, 1);
    assert.equal((await app.store.getRecord('hunt', 'hnt_never')).runs.length, 1);
    assert.ok(errors.some(e => /hnt_broken/.test(e)), 'the failure is logged with the hunt id');
  } finally { await app.close(); }
});

test('an opportunity sends exactly one message, with the decision, the receipt and a link, and no pressure; the message goes to the customer’s email', async () => {
  const clock = fixedClock();
  const app = await startApp({ PUBLIC_BASE_URL: 'https://trips.example.com' }, { now: () => clock });
  try {
    const u = await user(app);
    const h = await app.hunts.create(u, INPUT);
    assert.ok(h.opportunities.length >= 1, 'a first run with $3,000 for a beach week for two is a reason to travel');
    const outbox = await app.store.listRecords('outbox');
    assert.equal(outbox.length, h.opportunities.length, 'one message per opportunity, none for anything else');
    for (const opp of h.opportunities) {
      const msg = outbox.find(m => m.body.includes(hunter.decisionText(opp, h)));
      assert.ok(msg, 'the message carries the decision text word for word');
      assert.equal(msg.to, 'ada@example.com');
      assert.equal(msg.ref, h.id);
      assert.equal(msg.status, 'not_sent_outbox', 'nothing is actually sent until a provider is connected');
      assert.ok(msg.subject.startsWith('A reason to travel: '), msg.subject);
      for (const line of opp.receipt.rules) assert.ok(msg.body.includes(line), `rule line in the message: ${line}`);
      for (const line of opp.receipt.found) assert.ok(msg.body.includes(line), `found line in the message: ${line}`);
      assert.ok(msg.body.includes(opp.receipt.why));
      assert.ok(msg.body.includes(`https://trips.example.com/hunts/${h.id}`));
      assert.ok(!PRESSURE.test(msg.subject) && !PRESSURE.test(msg.body), `${msg.subject}\n${msg.body}`);
      // Every number in the decision is a priced fact or arithmetic on one: the total is the trip's, the limit is the hunt's.
      assert.ok(msg.body.includes(`$${Math.round(opp.trip.total / 100).toLocaleString('en-US')}`));
      assert.ok(msg.body.includes(`$${Math.round(h.budget / 100).toLocaleString('en-US')}`));
      assert.equal(opp.notified, true);
    }
  } finally { await app.close(); }
});

test('the service against a scripted engine: one send per opportunity, a failed send keeps the opportunity, the run entry and baseline are the engine’s facts, runs are capped at 30', async () => {
  let clock = fixedClock();
  const store = new MemoryStore();
  const sends = [];
  const notifier = { async send(m) { if (m.subject.includes('FAIL')) throw new Error('smtp down'); sends.push(m); return m; } };
  const card = (total, dest = 'Cancun') => ({ token: `tok-${total}`, total, perTraveler: total / 2, dest, destId: dest.toLowerCase(), country: 'Mexico', image: null, depart: '2027-03-02', ret: '2027-03-06', nights: 4, travelers: 2, stops: 0, airline: 'Demo', durationMinutes: 240, fareName: 'Flex', hotel: { name: 'Hotel', stars: 4, area: 'Beach', allInclusive: false, breakfast: true, refundable: true }, transfer: false, activities: 0, bags: 'carry-on' });
  const opp = (kind, total, extra = {}) => ({ kind, at: clock.toISOString(), verifiedAt: clock.toISOString(), trip: card(total), previous: null, delta: null, why: ['because'], receipt: { rules: ['Maximum: $3,000'], found: [`$${total / 100} total, everything included`, '4 nights in Cancun'], why: 'This currently satisfies your trip rules.' }, ...extra });
  let script = [];
  const engine = {
    THRESHOLDS: [5000, 10000, 20000],
    runHunt(inv, hunt, settings, { now, previous }) {
      const next = script.shift() || { opportunities: [] };
      return { at: now.toISOString(), checked: { destinations: 3, considered: 40, eligible: 12, nightsTried: [4], versions: 40 }, best: next.best || null, closest: next.closest || null, challenger: null, byDest: next.byDest || [], nonstop: null, extraNight: null, saved: null, opportunities: next.opportunities, silent: next.opportunities.length ? null : (next.silent || 'the best trip is unchanged at $1,000'), previousSeen: previous };
    },
    decisionText(o) { return `DECISION ${o.kind} ${o.trip.total}`; },
  };
  const inventory = { maps: { getOrigin: id => (id === 'NYC' ? { id } : null), getDestination: id => (id === 'cancun' ? { id, name: 'Cancun' } : null) } };
  const svc = new HuntService({ store, inventory, settings: async () => ({}), notifier, now: () => clock, log: quietLog, config: { trips: { huntIntervalMinutes: 60 }, publicBaseUrl: null }, engine });
  await store.putRecord('user', 'usr_1', { id: 'usr_1', email: 'ada@example.com' }, { userId: 'usr_1' });
  const u = { id: 'usr_1', email: 'ada@example.com' };

  // First run: two opportunities, one of which fails to send.
  script = [{ best: { token: 'tok-100000', total: 100000, trip: {}, nights: 4, stops: 0, stars: 4, dest: 'cancun', grade: 'great' }, byDest: [{ dest: 'cancun', total: 100000, token: 'tok-100000' }], opportunities: [opp('found', 100000), opp('destination', 110000, { receipt: { rules: [], found: ['FAIL me'], why: '' } })] }];
  const h = await svc.create(u, INPUT);
  assert.equal(h.opportunities.length, 2);
  assert.equal(sends.length, 1, 'one send per opportunity; the failed one is not retried silently');
  assert.equal(sends[0].to, 'ada@example.com');
  assert.equal(sends[0].subject, 'A reason to travel: $1000 total, everything included · 4 nights in Cancun');
  assert.ok(sends[0].body.startsWith('DECISION found 100000\n'));
  assert.ok(sends[0].body.includes('/hunts/' + h.id));
  assert.equal(h.opportunities[0].notified, true);
  assert.equal(h.opportunities[1].notified, false, 'a failed send is recorded as not notified');
  assert.equal(h.opportunities[1].status, 'new', 'the opportunity itself is kept');
  assert.deepEqual(h.baseline, { at: clock.toISOString(), best: { token: 'tok-100000', total: 100000, nights: 4, stops: 0, stars: 4, dest: 'cancun' }, closest: null, byDest: [{ dest: 'cancun', total: 100000, token: 'tok-100000' }], nonstop: null, overByDest: [] });
  assert.deepEqual(h.runs[0], { at: clock.toISOString(), reason: 'created', destinations: 3, considered: 40, eligible: 12, bestTotal: 100000, opportunities: 2, silent: null });
  assert.equal(h.lastMeaningfulAt, clock.toISOString());
  assert.deepEqual(await store.getRecord('hunt', h.id), h);

  // Silent runs: the baseline is passed as previous, nothing is sent, the reason is kept, the cap holds.
  const first = clock;
  for (let i = 0; i < 35; i++) {
    clock = new Date(clock.getTime() + minutes(61));
    script = [{ best: { token: 'tok-100000', total: 100000, nights: 4, stops: 0, stars: 4, dest: 'cancun' }, opportunities: [], silent: 'the best trip is unchanged at $1,000' }];
    const { result } = await svc.run(await svc.get(u, h.id), { reason: 'scheduled' });
    assert.equal(result.previousSeen.best.token, 'tok-100000', 'the recorded baseline is what the engine judges against');
  }
  const later = await svc.get(u, h.id);
  assert.equal(later.runs.length, 30, 'runs are capped at 30, newest kept');
  assert.equal(later.runs[29].at, clock.toISOString());
  assert.equal(later.runs[29].silent, 'the best trip is unchanged at $1,000');
  assert.equal(later.lastMeaningfulAt, first.toISOString(), 'silence is never meaningful');
  assert.equal(sends.length, 1, 'silence sends nothing');

  // A later drop: notified, meaningful, previous recorded.
  clock = new Date(clock.getTime() + minutes(61));
  script = [{ best: { token: 'tok-100000', total: 94000, nights: 4, stops: 0, stars: 4, dest: 'cancun' }, opportunities: [opp('drop', 94000, { previous: { token: 'tok-100000', total: 100000 }, delta: 6000 })] }];
  assert.deepEqual(await svc.runDue(), { ran: 1, found: 1 });
  const dropped = await svc.get(u, h.id);
  assert.equal(dropped.lastMeaningfulAt, clock.toISOString());
  assert.equal(sends.length, 2);
  assert.equal(dropped.opportunities.at(-1).kind, 'drop');
  assert.equal(dropped.baseline.best.total, 94000);
  assert.deepEqual(await svc.runDue(), { ran: 0, found: 0 });
});

test('respond: every answer changes the rules in plain words, learns, and re-runs; keep waiting and stop never pressure or search', async () => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const u = await user(app);
    const h0 = await app.hunts.create(u, { ...INPUT, minNights: 4, maxNights: 5 });
    const best0 = h0.baseline.best;
    assert.ok(best0, 'the hunt found a trip to answer about');
    const runs = () => app.store.getRecord('hunt', h0.id).then(h => h.runs.length);
    const refused = (action, payload, re) => assert.rejects(app.hunts.respond(u, h0.id, action, payload), e => e.code === 'invalid_hunt' && e.status === 422 && re.test(e.message), action);

    // Keep waiting: opportunities are seen, nothing runs, and the learned line carries no pressure.
    const kw = await app.hunts.respond(u, h0.id, 'keep-waiting');
    assert.equal(kw.result, null);
    assert.ok(kw.hunt.opportunities.every(o => o.status === 'seen'));
    assert.equal(kw.hunt.runs.length, 1);
    assert.equal(kw.hunt.learned.at(-1).text, 'You chose to keep waiting; nothing changed');
    assert.equal(kw.hunt.updatedAt, clock.toISOString());

    await refused('dance', {}, /not something a hunt can do/);
    await refused('improve', { what: 'magic' }, /price, hotel, nights, nonstop or destination/);
    await refused('taken', {}, /Which trip/);

    // Nights: the minimum becomes one more than the found trip; the maximum never falls below it,
    // and when it has to follow, the line says that number too (every number that moves is said).
    const n = await app.hunts.respond(u, h0.id, 'improve', { what: 'nights' });
    assert.equal(n.hunt.minNights, best0.nights + 1);
    assert.equal(n.hunt.maxNights, Math.max(h0.maxNights, n.hunt.minNights));
    assert.equal(n.hunt.learned.at(-1).text, `Minimum nights raised to ${n.hunt.minNights}${h0.maxNights < n.hunt.minNights ? `, and the maximum to ${n.hunt.minNights} to match` : ''}`);
    assert.equal(n.hunt.runs.length, 2, 'the rules changed, so the hunt re-ran');
    assert.equal(n.hunt.runs[1].reason, 'updated');
    assert.ok(n.result && n.result.at === clock.toISOString());
    if (n.hunt.baseline.best) assert.ok(n.hunt.baseline.best.nights >= n.hunt.minNights, 'the new best obeys the new minimum');
    // The old baseline was measured under the old rules, so the re-run is a fresh start, not a comparison.
    assert.equal(n.hunt.baseline.at, clock.toISOString());

    // Reject with a reason: the opportunities are rejected and the matching rule moves, named after the reason.
    const h1 = n.hunt;
    const r = await app.hunts.respond(u, h0.id, 'reject', { reason: 'too short' });
    assert.ok(r.hunt.opportunities.filter(o => o.status === 'rejected').length >= h1.opportunities.filter(o => o.status === 'new').length);
    assert.equal(r.hunt.learned.at(-1).text, `Minimum nights raised to ${r.hunt.minNights} after 'too short'${h1.maxNights < r.hunt.minNights ? `, and the maximum to ${r.hunt.minNights} to match` : ''}`);
    assert.ok(r.hunt.minNights > h1.minNights);
    assert.equal(r.hunt.maxNights, Math.max(h1.maxNights, r.hunt.minNights));

    // Hotel: one class above what the search already requires and what it found. When that is the
    // highest class we price, nothing the search uses could change, so it is refused in words, never
    // announced as a raise.
    const beforeHotel = await app.store.getRecord('hunt', h0.id);
    const hb = beforeHotel.baseline.best;
    const have = Math.max(beforeHotel.rules.minStars || 0, beforeHotel.floors.minStars || 0, hb ? hb.stars : 0);
    if (have >= 5) {
      await refused('improve', { what: 'hotel' }, hb && hb.stars >= 5 ? /^The trip I found has a 5-star hotel, the highest class we price; there is no higher class to ask for\.$/ : /^The hotel minimum is already 5 stars, the highest class we price\.$/);
      assert.equal((await app.store.getRecord('hunt', h0.id)).rules.minStars, beforeHotel.rules.minStars, 'nothing moved');
    } else {
      const ho = await app.hunts.respond(u, h0.id, 'improve', { what: 'hotel' });
      const expectStars = (have || 3) + 1;
      assert.equal(ho.hunt.rules.minStars, expectStars);
      assert.equal(ho.hunt.learned.at(-1).text, `Hotel minimum raised to ${expectStars} stars`);
      if (ho.hunt.baseline.best) assert.ok(ho.hunt.baseline.best.stars >= expectStars);
    }

    // "Shorter flight" is about the flight: the flights rule tightens, named after the reason, and the
    // nights stay. Nonstop becomes a hard rule once; asking again is refused rather than pretended.
    const beforeFlight = await app.store.getRecord('hunt', h0.id);
    const ns = await app.hunts.respond(u, h0.id, 'reject', { reason: 'shorter flight' });
    assert.deepEqual([ns.hunt.rules.flightStops, ns.hunt.rules.flightRule], ['nonstop', 'hard']);
    assert.equal(ns.hunt.learned.at(-1).text, "Nonstop flights are now a hard rule after 'shorter flight'");
    assert.deepEqual([ns.hunt.minNights, ns.hunt.maxNights], [beforeFlight.minNights, beforeFlight.maxNights], 'the nights did not move');
    assert.equal(ns.hunt.runs.length, beforeFlight.runs.length + 1, 'the rule changed, so the hunt re-ran');
    if (ns.hunt.baseline.best) assert.equal(ns.hunt.baseline.best.stops, 0);
    await refused('improve', { what: 'nonstop' }, /already a hard rule/);

    // A "no" is written down even when the rule its reason names cannot move: the trip stays rejected,
    // the line carries the refusal, nothing searches. A reason that names two rules, or none, moves
    // nothing and says so.
    const beforeNo = await app.store.getRecord('hunt', h0.id);
    const no = await app.hunts.respond(u, h0.id, 'reject', { reason: 'too much travel' });
    assert.equal(no.result, null);
    assert.equal(no.hunt.learned.at(-1).text, "Rejected: 'too much travel'; Nonstop flights are already a hard rule. The rules stand until you say what to change");
    assert.ok(beforeNo.opportunities.filter(o => o.status === 'new').every(o => no.hunt.opportunities.find(x => x.id === o.id).status === 'rejected'));
    assert.equal(no.hunt.runs.length, beforeNo.runs.length);
    assert.equal(no.hunt.updatedAt, clock.toISOString());
    assert.deepEqual([no.hunt.rules, no.hunt.minNights, no.hunt.target], [beforeNo.rules, beforeNo.minNights, beforeNo.target], 'nothing moved');
    const two = await app.hunts.respond(u, h0.id, 'reject', { reason: 'longer stay and fewer stops' });
    assert.equal(two.hunt.learned.at(-1).text, "Rejected: 'longer stay and fewer stops'; it names more than one rule (flights and nights), so the rules stand until you say what to change");
    assert.equal(two.result, null);
    assert.equal(two.hunt.minNights, beforeNo.minNights);
    const none = await app.hunts.respond(u, h0.id, 'reject', { reason: 'not for us' });
    assert.equal(none.hunt.learned.at(-1).text, "Rejected: 'not for us'; the rules stand until you say what to change");
    assert.equal((await app.hunts.respond(u, h0.id, 'reject', {})).hunt.learned.at(-1).text, 'Rejected; the rules stand until you say what to change');

    // Destination: the found trip's destination is ruled out and the next best is somewhere else.
    const beforeDest = await app.store.getRecord('hunt', h0.id);
    if (beforeDest.baseline.best) {
      const gone = beforeDest.baseline.best.dest;
      const d = await app.hunts.respond(u, h0.id, 'improve', { what: 'destination' });
      assert.ok(d.hunt.excludeDests.includes(gone));
      assert.match(d.hunt.learned.at(-1).text, /ruled out for this hunt$/);
      if (d.hunt.baseline.best) assert.notEqual(d.hunt.baseline.best.dest, gone);
      for (const o of d.result.opportunities) assert.notEqual(o.trip.destId, gone);
    } else {
      await refused('improve', { what: 'destination' }, /no found trip/);
    }

    // Harder ("find me something even better"): the ceiling moves to the $50 step at least $50 below the found total, with its quality kept as floors.
    const beforeHard = await app.store.getRecord('hunt', h0.id);
    const bh = beforeHard.baseline.best;
    const from = bh ? bh.total : Math.min(beforeHard.budget, beforeHard.target || Infinity);
    const hd = await app.hunts.respond(u, h0.id, 'harder');
    assert.equal(hd.hunt.target % 5000, 0);
    assert.ok(from - hd.hunt.target >= 5000 && from - hd.hunt.target < 10000, `${from} -> ${hd.hunt.target}`);
    if (bh) assert.deepEqual(hd.hunt.floors, { minStars: bh.stars, nonstop: bh.stops === 0 });
    assert.match(hd.hunt.learned.at(-1).text, /^Now looking under \$[\d,]+/);
    if (hd.hunt.baseline.best) assert.ok(hd.hunt.baseline.best.total <= hd.hunt.target, 'the target is the ceiling the search uses');
    for (const o of hd.result.opportunities) assert.ok(o.trip.total <= hd.hunt.target);

    // Taken: the opportunity is marked, nothing else moves.
    const withOpp = await app.store.getRecord('hunt', h0.id);
    const opp = withOpp.opportunities.at(-1);
    if (opp) {
      const before = await runs();
      const t = await app.hunts.respond(u, h0.id, 'taken', { opportunityId: opp.id });
      assert.equal(t.hunt.opportunities.find(o => o.id === opp.id).status, 'taken');
      assert.equal(t.hunt.learned.at(-1).text, `Marked the ${opp.trip.dest} trip at $${(opp.trip.total / 100).toLocaleString('en-US', { minimumFractionDigits: opp.trip.total % 100 ? 2 : 0 })} as taken`);
      assert.equal(await runs(), before);
    }

    // Stop is simple; rules can still change while stopped but nothing searches; resume hunts again.
    const st = await app.hunts.respond(u, h0.id, 'stop');
    assert.equal(st.hunt.status, 'stopped');
    assert.equal(st.hunt.learned.at(-1).text, 'Hunt stopped');
    const before = await runs();
    const paused = await app.hunts.respond(u, h0.id, 'reject', { reason: 'too short' });
    assert.equal(paused.result, null, 'a stopped hunt does not search');
    assert.equal(await runs(), before);
    assert.match(paused.hunt.learned.at(-1).text, /^Minimum nights raised to (\d+) after 'too short'(, and the maximum to \1 to match)?$/);
    assert.equal(paused.hunt.baseline, null, 'the old baseline is not comparable under new rules; the next run starts fresh');
    const rs = await app.hunts.respond(u, h0.id, 'resume');
    assert.equal(rs.hunt.status, 'hunting');
    assert.equal(rs.hunt.learned.at(-1).text, 'Hunt resumed');
    const final = await app.store.getRecord('hunt', h0.id);
    for (const l of final.learned) { assert.ok(l.at && l.text, 'every learned line is dated'); assert.ok(!PRESSURE.test(l.text), l.text); }
    assert.ok(final.runs.length <= 30);
  } finally { await app.close(); }
});

test('an airport code is accepted as the origin and stored as the city the inventory maps it to', async t => {
  const app = await startApp();
  t.after(app.close);
  const u = await app.accounts.register({ name: 'Ada Lovelace', email: 'ada-airport@example.com', password: 'correct horse battery' });
  const hunt = await app.hunts.create(u, { budget: 100000, origin: 'jfk', travelers: 2, who: 'couple', minNights: 3, style: 'beach' });
  assert.equal(hunt.origin, 'NYC');
  await assert.rejects(app.hunts.create(u, { budget: 100000, origin: 'ZZZ', travelers: 2, who: 'couple', minNights: 3, style: 'beach' }), e => e.code === 'invalid_hunt' && /departure city/.test(e.message));
});

test('one writer per hunt: an answer given while a sweep is working stands, a Stop given during a sweep is kept, and the sweep runs nothing it finds already checked or stopped', async () => {
  let clock = fixedClock();
  const app = await startApp({ HUNT_INTERVAL_MINUTES: '60' }, { now: () => clock });
  try {
    const u = await user(app);
    const Y = await app.hunts.create(u, { ...INPUT, name: 'Older Y' }); // listed second: the sweep gets to it last
    const X = await app.hunts.create(u, { ...INPUT, name: 'Newer X' });
    const rec = id => app.store.getRecord('hunt', id);
    const outboxFor = async id => (await app.store.listRecords('outbox')).filter(m => m.ref === id);

    // "More nights" on Y lands while the sweep is on X: the rule the customer set, the learned line and
    // the check after the answer all stand; the sweep finds Y checked and leaves it as they left it.
    clock = new Date(clock.getTime() + minutes(61));
    const [sweep, answer] = await Promise.all([app.hunts.runDue(), app.hunts.respond(u, Y.id, 'improve', { what: 'nights' })]);
    const y1 = await rec(Y.id);
    assert.ok(answer.hunt.minNights > Y.minNights);
    assert.equal(y1.minNights, answer.hunt.minNights, 'the rule the customer set stands');
    assert.ok(y1.learned.some(l => /^Minimum nights raised/.test(l.text)), 'the learned line stands');
    assert.deepEqual(y1.runs.map(r => r.reason), ['created', 'updated'], 'the check after the answer is in the log, and it is the only new one');
    assert.deepEqual(sweep, { ran: 1, found: (await rec(X.id)).runs[1].opportunities }, 'the sweep ran X alone');
    assert.deepEqual((await rec(X.id)).runs.map(r => r.reason), ['created', 'scheduled']);
    assert.equal((await outboxFor(Y.id)).length, y1.opportunities.filter(o => o.notified).length, 'every message sent about Y is an opportunity on Y’s page');

    // A Stop on Y while the next sweep is on X: the hunt stays stopped, nothing of Y's is saved back as
    // hunting, and the sweeps after it never run Y.
    clock = new Date(clock.getTime() + minutes(61));
    const [sweep2, stop] = await Promise.all([app.hunts.runDue(), app.hunts.respond(u, Y.id, 'stop')]);
    assert.equal(stop.hunt.status, 'stopped');
    const y2 = await rec(Y.id);
    assert.equal(y2.status, 'stopped');
    assert.equal(y2.learned.at(-1).text, 'Hunt stopped');
    assert.deepEqual(y2.runs.map(r => r.reason), ['created', 'updated'], 'no scheduled run was written over the Stop');
    assert.equal(sweep2.ran, 1);
    clock = new Date(clock.getTime() + minutes(61));
    assert.equal((await app.hunts.runDue()).ran, 1, 'an hour later only X is due');
    assert.deepEqual((await rec(Y.id)).runs.map(r => r.reason), ['created', 'updated']);
    assert.equal((await rec(Y.id)).status, 'stopped');
  } finally { await app.close(); }
});

test('runs of one hunt never overlap and overlapping sweeps are one sweep: each run reads the record as it is, so a find is told once and every run is in the log', async () => {
  const clock = fixedClock();
  const store = new MemoryStore();
  const sends = [];
  const notifier = { async send(m) { sends.push(m); return m; } };
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const card = (tok, total) => ({ token: tok, total, perTraveler: total / 2, dest: 'Cancun', destId: 'cancun', nights: 4, travelers: 2, stops: 0, hotel: { name: 'H', stars: 4 }, bags: 'carry-on', activities: 0, transfer: false, depart: '2027-03-02', ret: '2027-03-06', airline: 'D', durationMinutes: 240, fareName: 'F' });
  // The engine mirrors hunter.js's memory: a find is fresh only while the record does not carry it.
  let inEngine = 0, maxInEngine = 0;
  const engine = {
    THRESHOLDS: [5000, 10000, 20000],
    runHunt(inv, hunt) {
      const tok = `tok-${hunt.id}`;
      const told = new Set((hunt.opportunities || []).map(o => `${o.kind}|${o.trip.token}|`));
      const opp = told.has(`found|${tok}|`) ? [] : [{ kind: 'found', at: clock.toISOString(), verifiedAt: clock.toISOString(), trip: card(tok, 100000), previous: null, delta: null, why: [], receipt: { rules: [], found: ['$1,000 total'], why: '' } }];
      return { at: clock.toISOString(), checked: { destinations: 1, considered: 1, eligible: 1 }, best: { token: tok, total: 100000, nights: 4, stops: 0, stars: 4, dest: 'cancun' }, byDest: [], opportunities: opp, silent: opp.length ? null : 'the best trip is unchanged at $1,000' };
    },
    decisionText(o) { return `DECISION ${o.kind} ${o.trip.token}`; },
  };
  // A run takes time, as a real one does: settings() is where the service yields before pricing.
  const settings = async () => { inEngine += 1; maxInEngine = Math.max(maxInEngine, inEngine); await delay(15); inEngine -= 1; return {}; };
  const inventory = { maps: { getOrigin: id => (id === 'NYC' ? { id } : null), getDestination: () => null } };
  const svc = new HuntService({ store, inventory, settings, notifier, now: () => clock, log: quietLog, config: { trips: { huntIntervalMinutes: 60 }, publicBaseUrl: null }, engine });
  await store.putRecord('user', 'usr_1', { id: 'usr_1', email: 'ada@example.com' }, { userId: 'usr_1' });
  const fresh = id => ({ id, userId: 'usr_1', ...svc.validate(INPUT), status: 'hunting', target: null, floors: { minStars: null, nonstop: false }, baseline: null, runs: [], opportunities: [], learned: [], lastRunAt: null, lastMeaningfulAt: null, createdAt: clock.toISOString(), updatedAt: clock.toISOString() });
  for (let i = 1; i <= 4; i++) await store.putRecord('hunt', `hnt_${i}`, fresh(`hnt_${i}`), { userId: 'usr_1' });

  // Three callers on one never-run hunt at once (a sweep tick, a page open, an answer): one at a time,
  // each on the record as the one before left it, so the find is mailed once and all three runs are logged.
  const copies = await Promise.all([1, 2, 3].map(() => store.getRecord('hunt', 'hnt_1')));
  const pA = svc.run(copies[0], { reason: 'scheduled' });
  await delay(3);
  await Promise.all([pA, svc.run(copies[1], { reason: 'scheduled' }), svc.run(copies[2], { reason: 'opened' })]);
  assert.equal(maxInEngine, 1, 'never two runs of one hunt at once');
  assert.equal(sends.length, 1, 'the one find was told once');
  const h1 = await store.getRecord('hunt', 'hnt_1');
  assert.deepEqual(h1.runs.map(r => r.reason), ['scheduled', 'scheduled', 'opened'], 'every run that happened is in the log');
  assert.equal(h1.opportunities.length, 1);
  assert.equal(h1.runs[1].silent, 'the best trip is unchanged at $1,000');

  // Two ticks whose sweeps would overlap are one sweep: the second joins the first, every due hunt runs
  // once, and nothing is mailed twice.
  const [s1, s2] = await Promise.all([svc.runDue(), (async () => { await delay(4); return svc.runDue(); })()]);
  assert.deepEqual(s1, { ran: 3, found: 3 }, 'hnt_2..4 were due; hnt_1 was checked a moment ago');
  assert.deepEqual(s2, s1, 'the second tick got the one sweep’s result');
  const perHunt = {};
  for (const m of sends) perHunt[m.ref] = (perHunt[m.ref] || 0) + 1;
  assert.deepEqual(perHunt, { hnt_1: 1, hnt_2: 1, hnt_3: 1, hnt_4: 1 });
  for (let i = 2; i <= 4; i++) assert.deepEqual((await store.getRecord('hunt', `hnt_${i}`)).runs.map(r => r.reason), ['scheduled']);
  assert.equal(svc.sweep, null, 'the sweep is over');
  assert.deepEqual(await svc.runDue(), { ran: 0, found: 0 }, 'a sweep right after finds nothing due');
});

test('a sweep sees every hunting hunt however many newer stopped records there are, and checks the oldest first', async () => {
  let clock = fixedClock();
  const app = await startApp({ HUNT_INTERVAL_MINUTES: '60' }, { now: () => clock });
  try {
    const u = await user(app);
    const ids = [];
    for (const name of ['Oldest check', 'Middle check', 'Newest check']) ids.push((await app.hunts.create(u, { ...INPUT, name })).id);
    // Their last checks, three, two and one hours ago; then a thousand newer records, all stopped
    // (nothing deletes a hunt), from another customer.
    for (const [i, id] of ids.entries()) {
      const h = await app.store.getRecord('hunt', id);
      await app.store.putRecord('hunt', id, { ...h, lastRunAt: new Date(clock.getTime() - minutes(60 * (3 - i))).toISOString() }, { userId: u.id });
    }
    const template = await app.store.getRecord('hunt', ids[0]);
    for (let i = 0; i < 1000; i++) await app.store.putRecord('hunt', `hnt_other_${i}`, { ...template, id: `hnt_other_${i}`, userId: 'usr_other', status: 'stopped' }, { userId: 'usr_other' });
    assert.equal((await app.store.listRecords('hunt', { limit: 1000 })).filter(h => ids.includes(h.id)).length, 0, 'none of the three is in the newest thousand');
    const order = [];
    const real = app.hunts.engine;
    app.hunts.engine = { ...real, runHunt: (inv, h, ...rest) => { order.push(h.id); return real.runHunt(inv, h, ...rest); } };
    const r = await app.hunts.runDue();
    assert.equal(r.ran, 3, 'every hunting hunt that is due is run');
    assert.deepEqual(order, ids, 'the oldest check first');
    for (const id of ids) assert.equal((await app.store.getRecord('hunt', id)).runs.at(-1).reason, 'scheduled');
    assert.deepEqual(await app.hunts.runDue(), { ran: 0, found: 0 });
  } finally { await app.close(); }
});

test('a hunt whose month has no departure left to price stops with a dated line and a log line instead of hunting forever, is skipped by the sweep and by opening it, and cannot be resumed', async () => {
  let clock = fixedClock();
  const lines = [];
  const log = { ...quietLog, info: (...a) => lines.push(a.join(' ')) };
  const app = await startApp({ HUNT_INTERVAL_MINUTES: '360' }, { now: () => clock, log });
  try {
    const u = await user(app);
    const monthWords = m => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
    const next = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth() + 1, 1));
    const month = next.toISOString().slice(0, 7);
    const h = await app.hunts.create(u, { ...INPUT, dateMode: 'flexible', month });
    assert.equal(h.status, 'hunting');
    // From the 25th the same month is refused up front, with the reason, before anything is stored.
    clock = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 25, 9));
    await assert.rejects(app.hunts.create(u, { ...INPUT, dateMode: 'flexible', month }), e => e.code === 'invalid_hunt' && e.message === `${monthWords(month)} has no departure left to price (the hunt asks about dates at least a week out); pick a later month.`);
    assert.equal((await app.store.listRecords('hunt')).length, 1);
    // The first of the month after: the window is closed, so the next scheduled check ends the hunt
    // and asks no supplier anything; no check is logged, because none happened.
    clock = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, 9));
    assert.deepEqual(await app.hunts.runDue(), { ran: 0, found: 0 });
    const ended = await app.store.getRecord('hunt', h.id);
    assert.equal(ended.status, 'stopped');
    assert.equal(ended.runs.length, 1, 'no check was logged: none happened');
    assert.equal(ended.lastRunAt, h.lastRunAt);
    assert.deepEqual(ended.learned.at(-1), { at: clock.toISOString(), text: `${monthWords(month)} has no departure left to price (the hunt asks about dates at least a week out), so the hunt stopped` });
    assert.equal(ended.updatedAt, clock.toISOString());
    assert.ok(lines.some(l => l === `[hunts] "${h.name}" (${h.id}) stopped: no departure in ${monthWords(month)} is left to price`), lines.join('\n'));
    assert.deepEqual(await app.hunts.runDue(), { ran: 0, found: 0 }, 'stopped: never due again');
    assert.equal((await app.hunts.refresh(u, h.id)).runs.length, 1, 'opening it searches nothing');
    await assert.rejects(app.hunts.respond(u, h.id, 'resume'), e => e.code === 'invalid_hunt' && e.status === 422 && e.message === `${monthWords(month)} has no departure left to price (the hunt asks about dates at least a week out); start a new hunt for a later month.`);
    assert.equal((await app.store.getRecord('hunt', h.id)).status, 'stopped');
  } finally { await app.close(); }
});

test('what the customer refused or already heard is remembered past the hundred-opportunity page: a rejected trip never comes back as the best', async () => {
  const clock = fixedClock();
  const app = await startApp({}, { now: () => clock });
  try {
    const u = await user(app);
    const h = await app.hunts.create(u, INPUT);
    assert.ok(h.opportunities.length && h.baseline.best, 'a first find to say no to');
    const X = h.baseline.best.token;
    const first = h.opportunities.find(o => o.trip.token === X);
    assert.ok(first, 'the first find is the best trip');
    const rej = await app.hunts.respond(u, h.id, 'reject', { reason: 'no', opportunityId: first.id });
    assert.equal(rej.hunt.opportunities.find(o => o.id === first.id).status, 'rejected');
    // A hundred later opportunities push the rejection off the page.
    const rec = await app.store.getRecord('hunt', h.id);
    for (let i = 0; i < MAX_OPPORTUNITIES; i++) rec.opportunities.push({ ...first, id: `opp_pad_${i}`, status: 'seen', kind: 'drop', trip: { ...first.trip, token: `pad-${i}`, total: 100 + i } });
    await app.store.putRecord('hunt', rec.id, rec, { userId: u.id });
    const seen = [];
    const real = app.hunts.engine;
    app.hunts.engine = { ...real, runHunt: (inv, hunt, ...rest) => { seen.push(hunt.opportunities.map(o => [o.trip.token, o.status])); return real.runHunt(inv, hunt, ...rest); } };
    const r2 = await app.hunts.run(h, { reason: 'manual' });
    assert.equal(r2.hunt.opportunities.length, MAX_OPPORTUNITIES, 'the page holds a hundred');
    assert.ok(!r2.hunt.opportunities.some(o => o.trip.token === X), 'the rejection is off the page');
    assert.deepEqual(r2.hunt.remembered.filter(m => m.trip.token === X), [{ kind: first.kind, status: 'rejected', trip: { token: X, total: first.trip.total, nights: first.trip.nights, dest: first.trip.dest, hotel: { name: first.trip.hotel.name }, fareName: first.trip.fareName } }], 'and kept as a few facts of memory');
    assert.ok(hunter.ruleLines(app.hunts.recall(r2.hunt), { maps: app.tripService.inv.maps }).some(l => l.startsWith(`Rejected: ${first.trip.nights} nights in ${first.trip.dest}`)), 'the rule the rejection became is still read off the memory');
    const r3 = await app.hunts.run(h, { reason: 'manual' });
    assert.ok(seen[1].some(([token, status]) => token === X && status === 'rejected'), 'the engine is handed the memory with the page');
    for (const r of [r2, r3]) { if (r.hunt.baseline.best) assert.notEqual(r.hunt.baseline.best.token, X, 'the customer’s no stands'); for (const o of r.result.opportunities) assert.notEqual(o.trip.token, X); }
    assert.equal(r3.hunt.opportunities.length, MAX_OPPORTUNITIES);
    assert.equal(r3.hunt.remembered.length, r2.hunt.remembered.length + r3.result.opportunities.length, 'the page was full, so the memory grows by exactly what the run pushed off it');
  } finally { await app.close(); }
});
