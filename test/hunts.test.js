// THE AI SAVINGS HUNTER's record keeper: a hunt is validated and run once when created; the list's
// numbers are arithmetic on stored facts; opening a hunt re-checks it only when the last check is old;
// the scheduler runs only the hunts that are due and still hunting; every answer the customer gives
// changes the rules in plain words and re-runs; an opportunity sends exactly one message, written
// without pressure; silence sends nothing; a hunt belongs to its owner alone; and the sentence about
// monitoring says only what the scheduler and the outbox really do.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, quietLog } = require('./helpers');
const { loadConfig } = require('../server/config');
const { HuntService, ACCEPTANCE, NOTIFY_KINDS, THRESHOLDS, intervalWords } = require('../server/trips/hunts');
const { OutboxNotifier } = require('../server/trips/integrations/notifications');
const { MemoryStore } = require('../server/booking/MemoryStore');
const hunter = require('../server/trips/hunter');

// Words no hunt message may carry: the product promises no fake scarcity, no urgency, no predictions.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict)\b/i;

// A fixed hour of the day, so moving the clock by minutes never crosses midnight UTC (the searches
// are judged on the calendar day).
function fixedClock() { const d = new Date(); d.setUTCHours(9, 0, 0, 0); return d; }
const minutes = n => n * 60000;

const INPUT = { budget: 300000, origin: 'NYC', travelers: 2, who: 'couple', dateMode: 'anytime', minNights: 4, maxNights: 4, style: 'beach', threshold: 'recommend' };

async function user(app, email = 'ada@example.com') {
  return app.accounts.register({ name: 'Ada Lovelace', email, password: 'correct horse battery' });
}

test('the words: monitoring says only what the scheduler and the outbox do; the acceptance line promises selectivity', () => {
  const svc = minutesOn => new HuntService({ store: null, inventory: null, settings: async () => ({}), notifier: null, config: { trips: { huntIntervalMinutes: minutesOn } } });
  assert.equal(svc(360).monitoringText(), 'This site re-checks your hunts about every 6 hours while it is running and each time you open them. What it finds appears here and in My Trips, and by email once notifications are connected. It says nothing when nothing meaningful happened.');
  assert.equal(svc(60).monitoringText(), 'This site re-checks your hunts about every 1 hour while it is running and each time you open them. What it finds appears here and in My Trips, and by email once notifications are connected. It says nothing when nothing meaningful happened.');
  assert.equal(svc(90).monitoringText(), 'This site re-checks your hunts about every 90 minutes while it is running and each time you open them. What it finds appears here and in My Trips, and by email once notifications are connected. It says nothing when nothing meaningful happened.');
  assert.equal(svc(0).monitoringText(), 'This site re-checks your hunts each time you open them; nothing runs in between. What it finds appears here and in My Trips, and by email once notifications are connected.');
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

    // Defaults the hunt fills in: travelers from who, the current month is allowed, a given name is kept, the saved trip switches beat-saved on.
    const h2 = await app.hunts.create(u, { ...INPUT, travelers: undefined, who: 'family', name: '  Spring break  ', dateMode: 'flexible', month: clock.toISOString().slice(0, 7), savedToken: h.baseline.best.token, rules: { flightStops: 'nonstop', minStars: '4', refundable: 'true' } });
    assert.equal(h2.travelers, 4);
    assert.equal(h2.name, 'Spring break');
    assert.equal(h2.month, clock.toISOString().slice(0, 7));
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
  assert.deepEqual(h.baseline, { at: clock.toISOString(), best: { token: 'tok-100000', total: 100000, nights: 4, stops: 0, stars: 4, dest: 'cancun' }, closest: null, byDest: [{ dest: 'cancun', total: 100000, token: 'tok-100000' }], nonstop: null });
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

    // Nights: the minimum becomes one more than the found trip; the maximum never falls below it.
    const n = await app.hunts.respond(u, h0.id, 'improve', { what: 'nights' });
    assert.equal(n.hunt.minNights, best0.nights + 1);
    assert.ok(n.hunt.maxNights >= n.hunt.minNights);
    assert.equal(n.hunt.learned.at(-1).text, `Minimum nights raised to ${best0.nights + 1}`);
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
    assert.match(r.hunt.learned.at(-1).text, /^Minimum nights raised to \d+ after 'too short'$/);
    assert.ok(r.hunt.minNights > h1.minNights);

    // Hotel: one star above the found trip (or the rule), capped at five.
    const beforeHotel = await app.store.getRecord('hunt', h0.id);
    const hb = beforeHotel.baseline.best;
    const ho = await app.hunts.respond(u, h0.id, 'improve', { what: 'hotel' });
    const expectStars = Math.min(5, (hb ? hb.stars : (beforeHotel.rules.minStars || 3)) + 1);
    assert.equal(ho.hunt.rules.minStars, expectStars);
    assert.equal(ho.hunt.learned.at(-1).text, `Hotel minimum raised to ${expectStars} stars`);
    if (ho.hunt.baseline.best) assert.ok(ho.hunt.baseline.best.stars >= expectStars);

    // Nonstop becomes a hard rule once; asking again is refused rather than pretended.
    const ns = await app.hunts.respond(u, h0.id, 'improve', { what: 'nonstop' });
    assert.deepEqual([ns.hunt.rules.flightStops, ns.hunt.rules.flightRule], ['nonstop', 'hard']);
    assert.equal(ns.hunt.learned.at(-1).text, 'Nonstop flights are now a hard rule');
    if (ns.hunt.baseline.best) assert.equal(ns.hunt.baseline.best.stops, 0);
    await refused('improve', { what: 'nonstop' }, /already a hard rule/);
    await refused('reject', { reason: 'too much travel' }, /already a hard rule/);

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
    assert.match(paused.hunt.learned.at(-1).text, /^Minimum nights raised to \d+ after 'too short'$/);
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
