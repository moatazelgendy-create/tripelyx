// The AI Savings Hunter's record keeper and scheduler. A hunt is a customer's standing instruction:
// a ceiling, an origin, who is going, how long, the rules, and which kinds of win are worth an
// interruption. This service stores hunts, runs them (on creation, when opened, on a timer, and after
// the customer changes the rules), keeps the baseline the next run is judged against, and sends one
// notification per opportunity. It never prices anything itself: every search is hunter.runHunt over
// the inventory, so every number here is a priced fact or arithmetic on one. It says nothing when a
// run found nothing worth saying, and never implies a search happened when it did not.
//
// One record, one writer at a time: every run and every answer waits for whatever is in flight on
// that hunt and then reads the record again before it changes or saves anything, so a sweep never
// writes a copy it listed minutes ago over a rule the customer just set, a Stop they just gave, or a
// check that really happened. A sweep is one at a time as well, and judges "due" on the fresh record.
const { AppError } = require('../lib/errors');
const { id: makeId } = require('../lib/ids');
const { today, addDays } = require('../lib/dates');
const { format: fmtMoney } = require('../lib/money');
const optimizer = require('./optimizer');
const { decodeSpec } = require('./spec');
const hunter = require('./hunter');

const WHO = ['couple', 'solo', 'family', 'friends'];
const DATE_MODES = ['anytime', 'flexible'];
const NOTIFY_KINDS = ['under', 'beat-saved', 'drop', 'extra-night', 'nonstop', 'quality', 'destination'];
const SAVINGS_LEVELS = ['balanced', 'aggressive'];
const MEALS = ['all-inclusive', 'breakfast'];
const BAGS = ['personal', 'carry-on', 'checked'];
const IMPROVEMENTS = ['price', 'hotel', 'nights', 'nonstop', 'destination'];
const ACTIONS = ['keep-waiting', 'seen', 'improve', 'reject', 'harder', 'taken', 'stop', 'resume', 'threshold'];
// Thresholds the pages offer; the engine owns the list, with a fallback while it is being built.
const THRESHOLDS = Array.isArray(hunter.THRESHOLDS) ? hunter.THRESHOLDS : [5000, 10000, 20000];
const STYLE_WORD = { beach: 'Beach', city: 'City', adventure: 'Adventure', romantic: 'Romantic', family: 'Family', 'all-inclusive': 'All-Inclusive', surprise: 'Anywhere' };
const MAX_RUNS = 30;
// Opportunities are the customer's history; the record is still a single JSON document, so the
// oldest fall off the page once there are this many. What they told and what the customer refused
// is kept in `remembered` (the kind, the status and the few facts of the trip the engine reads
// back: never trimmed), so a trip the customer said no to does not come back as the best once a
// hundred later finds pushed the refusal off the page, and nothing is told twice because the record
// forgot it.
const MAX_OPPORTUNITIES = 100;
const STEP = 5000; // the $50 step "find me something even better" moves by
const MIN_BUDGET = 10000, MAX_BUDGET = 5000000;
const MAX_STARS = 5; // the highest hotel class the inventory prices
// Opening a hunt re-checks it only when the last check is older than this; the monitoring sentence
// is built from the same number, so what the page says and what runs cannot drift apart.
const REFRESH_MAX_AGE_MINUTES = 10;
// The engine asks the suppliers about departures from a week out (hunter.windowDates); a month whose
// last day is nearer than that has nothing left to price, which is why validate refuses it and a run
// ends a hunt whose month got there.
const EARLIEST_DEPARTURE_DAYS = 7;
// The store lists newest first, with no filter and no cursor: a sweep asks for this many and, when
// the page comes back full, asks again for twice as many until it is short, so every hunt is seen.
const SWEEP_PAGE = 1000;

const ACCEPTANCE = 'Got it. I won’t contact you just because something is cheap. I’ll contact you when I find a trip that meets your rules and looks worth considering.';

const money = c => fmtMoney(c, 'USD');
const invalid = message => new AppError('invalid_hunt', message, 422);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const monthWords = m => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
// Milliseconds since the hunt's last check; a hunt that never ran is infinitely old.
const ageOf = (hunt, now) => (hunt.lastRunAt ? now.getTime() - Date.parse(hunt.lastRunAt) : Infinity);
// True when no departure in the month can be priced any more: its last day is nearer than the
// earliest date the engine asks about. (The service asks the engine itself when it says which dates
// it would ask for; this is the same rule, for an engine that does not.)
function monthClosed(month, now) {
  const [y, m] = month.split('-').map(Number);
  const lastDay = addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
  return lastDay < addDays(today(now), EARLIEST_DEPARTURE_DAYS);
}
const monthClosedWords = month => `${monthWords(month)} has no departure left to price (the hunt asks about dates at least a week out)`;

// What is kept of an opportunity that fell off the page: the kind and status (told, refused), and
// the facts of the trip the engine reads back (its token and total for "already told", and what a
// rejected package is called in the rule line).
function remember(o) {
  const t = o.trip;
  return { kind: o.kind, status: o.status, trip: { token: t.token, total: t.total, nights: t.nights, dest: t.dest, hotel: { name: t.hotel && t.hotel.name }, fareName: t.fareName } };
}

function intIn(v, min, max, message) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(message);
  return n;
}
function oneOf(v, list, message, { nullable = false } = {}) {
  if (v === undefined || v === null || v === '') { if (nullable) return null; throw invalid(message); }
  if (!list.includes(v)) throw invalid(message);
  return v;
}
function boolOrNull(v, what = 'Refundable') {
  if (v === undefined || v === null || v === '') return null;
  if (v === true || v === 'true' || v === '1' || v === 1 || v === 'on') return true;
  if (v === false || v === 'false' || v === '0' || v === 0 || v === 'off') return false;
  throw invalid(`${what} must be yes or no.`);
}

// How long the interval is, in words a customer reads: "6 hours", "1 hour", "90 minutes".
function intervalWords(minutes) {
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

// The rule a rejection reason names, flight words before length words so "shorter flight" is about
// the flight; the length words are tied to the trip so "short" alone never moves the nights.
const REASON_RULES = [
  [/\b(travel|flights?|layovers?|stops?|connections?|nonstop|direct)\b/i, 'nonstop', 'flights'],
  [/\b(too short|short(er)? (trip|stay|holiday|vacation|break)|longer|more nights|more days|not long enough)\b/i, 'nights', 'nights'],
  [/expensive|price|cheap|cost|money/i, 'price', 'price'],
  [/\b(hotels?|stars?|rooms?|resorts?)\b/i, 'hotel', 'hotel'],
  [/\b(place|destination|where|somewhere|elsewhere|anywhere|country|city)\b/i, 'destination', 'destination'],
];

class HuntService {
  constructor({ store, inventory, settings, notifier, now = () => new Date(), log = console, config, engine = hunter }) {
    this.store = store;
    this.inv = inventory;
    this.settings = settings;
    this.notifier = notifier;
    this.now = now;
    this.log = log;
    this.config = config;
    this.engine = engine;
    this.timer = null;
    // One operation per hunt at a time (a run or an answer), keyed by hunt id: see exclusive().
    this.inFlight = new Map();
    // The one sweep in progress, so a timer tick that fires during a sweep joins it instead of
    // starting a second one over the same hunts.
    this.sweep = null;
  }

  get intervalMinutes() {
    const n = this.config && this.config.trips ? Number(this.config.trips.huntIntervalMinutes) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Whether a month has a departure left that the engine would ask the suppliers about: the engine's
  // own list of dates when it gives one, else the same week-out rule.
  monthClosed(month, now) {
    if (typeof this.engine.windowDates === 'function') return this.engine.windowDates({ dateMode: 'flexible', month }, now).length === 0;
    return monthClosed(month, now);
  }

  // ---- validation ------------------------------------------------------------------------------
  validate(input = {}, now = this.now()) {
    const budget = intIn(input.budget, MIN_BUDGET, MAX_BUDGET, `The limit must be between ${money(MIN_BUDGET)} and ${money(MAX_BUDGET)}.`);
    // An origin id, or an airport code the inventory maps to one (the agent's state holds "JFK").
    const typed = String(input.origin || '').trim().toUpperCase();
    const ap = typed && !this.inv.maps.getOrigin(typed) && typeof this.inv.maps.airport === 'function' ? this.inv.maps.airport(typed) : null;
    const origin = this.inv.maps.getOrigin(typed) ? typed : ap && this.inv.maps.getOrigin(ap.originId) ? ap.originId : null;
    if (!origin) throw invalid('Pick a departure city we fly from.');
    const who = oneOf(input.who, WHO, 'Say who is going: couple, solo, family or friends.');
    const travelers = intIn(input.travelers === undefined ? optimizer.WHO_DEFAULT[who] : input.travelers, 1, 8, 'Travelers must be between 1 and 8.');
    const dateMode = oneOf(input.dateMode || 'anytime', DATE_MODES, 'Dates are either anytime or a month.');
    let month = null;
    if (dateMode === 'flexible') {
      month = String(input.month || '').trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw invalid('Pick a month as YYYY-MM.');
      if (month < today(now).slice(0, 7)) throw invalid('That month has passed; pick the current month or a later one.');
      // A hunt that could never ask a supplier anything is not a hunt: refused with the reason.
      if (this.monthClosed(month, now)) throw invalid(`${monthClosedWords(month)}; pick a later month.`);
    }
    const minNights = intIn(input.minNights, 2, 14, 'Minimum nights must be between 2 and 14.');
    const maxNights = input.maxNights === undefined || input.maxNights === null || input.maxNights === ''
      ? Math.min(minNights + 3, 14)
      : intIn(input.maxNights, minNights, 14, `Maximum nights must be between ${minNights} and 14.`);
    const style = oneOf(input.style || 'surprise', optimizer.STYLES, 'Pick a trip style.');
    // What matters most steers the pick among qualifying trips (the optimizer's own weighting), as it
    // does on the canvas the hunt was started from; it never relaxes a rule.
    const priority = oneOf(input.priority, optimizer.PRIORITIES, 'What matters most is hotel, flights, longer, activities or price.', { nullable: true });
    // A destination the customer named ("to Cancun"), or international only: the search is that narrow,
    // so a hunt started from a conversation keeps the place the customer asked for instead of
    // quietly widening to anywhere. Both are carried as stated, never inferred from a trip.
    const dest = input.dest === undefined || input.dest === null || input.dest === '' ? null : String(input.dest).trim();
    if (dest && !this.inv.maps.getDestination(dest)) throw invalid(`"${dest}" is not a destination we offer.`);
    const region = oneOf(input.region, ['international'], 'The region is international or open.', { nullable: true });

    const r = input.rules || {};
    const flightStops = oneOf(r.flightStops, ['nonstop'], 'Flights are either nonstop or open.', { nullable: true });
    // "Nonstop" with no word on how firm it is counts as a hard rule: the hunt never shows a trip
    // that breaks what the customer said, and a preference must be asked for by name.
    const flightRule = flightStops ? oneOf(r.flightRule || 'hard', ['hard', 'preferred'], 'A nonstop rule is either hard or preferred.') : null;
    const minStars = r.minStars === undefined || r.minStars === null || r.minStars === '' ? null : intIn(r.minStars, 2, 5, 'Hotel stars must be between 2 and 5.');
    // Beachfront and an included transfer are hard rules the conversation can hold (the optimizer
    // filters on both); they are written on the record only when on, so a hunt stored before they
    // existed reads exactly as it did.
    const beachfront = boolOrNull(r.beachfront, 'Beachfront');
    const transfer = boolOrNull(r.transfer, 'Airport transfer');
    const rules = {
      flightStops, flightRule, minStars, refundable: boolOrNull(r.refundable),
      meals: oneOf(r.meals, MEALS, 'Meals are all-inclusive, breakfast or open.', { nullable: true }),
      bags: oneOf(r.bags, BAGS, 'Bags are personal, carry-on or checked.', { nullable: true }),
      ...(beachfront ? { beachfront: true } : {}), ...(transfer ? { transfer: true } : {}),
    };

    const excludeDests = [...new Set((Array.isArray(input.excludeDests) ? input.excludeDests : []).map(d => String(d).trim()).filter(Boolean))];
    for (const d of excludeDests) if (!this.inv.maps.getDestination(d)) throw invalid(`"${d}" is not a destination we offer.`);
    if (dest && excludeDests.includes(dest)) throw invalid('The destination to hunt cannot also be left out.');

    let savedToken = input.savedToken ? String(input.savedToken) : null;
    if (savedToken) { try { decodeSpec(savedToken); } catch { throw invalid('The saved trip to beat could not be read.'); } }

    let notify;
    if (input.notify === undefined || input.notify === null) notify = NOTIFY_KINDS.filter(k => k !== 'beat-saved' || savedToken);
    else {
      if (!Array.isArray(input.notify)) throw invalid('Say which wins are worth telling you about.');
      notify = [...new Set(input.notify.map(String))];
      for (const k of notify) if (!NOTIFY_KINDS.includes(k)) throw invalid(`"${k}" is not a kind of win I know.`);
      if (notify.includes('beat-saved') && !savedToken) throw invalid('Beating your saved trip needs a saved trip to beat.');
    }

    let threshold = input.threshold === undefined || input.threshold === null || input.threshold === '' ? 'recommend' : input.threshold;
    if (threshold !== 'recommend') {
      threshold = intIn(threshold, 1, budget, `The saving that is worth an interruption must be between $0.01 and your ${money(budget)} limit, or "recommend".`);
    }
    const savingsLevel = oneOf(input.savingsLevel || 'balanced', SAVINGS_LEVELS, 'Savings are balanced or aggressive.');

    let name = String(input.name || '').trim().slice(0, 80);
    // Named from its money, its place and its style: "$2,500 Cancun Hunt", "$3,000 Beach Hunt".
    if (!name) name = `${money(budget)} ${dest ? `${this.inv.maps.getDestination(dest).name} ` : ''}${dest && style === 'surprise' ? '' : `${STYLE_WORD[style] || style} `}Hunt`;
    return { name, budget, origin, travelers, who, dateMode, month, minNights, maxNights, style, priority, dest, region, rules, excludeDests, savedToken, notify, threshold, savingsLevel };
  }

  // ---- create / list / get ---------------------------------------------------------------------
  async create(user, input) {
    if (!user || !user.id) throw new AppError('sign_in_required', 'Sign in to start a hunt.', 401);
    const at = this.now().toISOString();
    const hunt = {
      id: makeId('hnt'), userId: user.id, ...this.validate(input), status: 'hunting', target: null, floors: { minStars: null, nonstop: false },
      baseline: null, runs: [], opportunities: [], remembered: [], learned: [], lastRunAt: null, lastMeaningfulAt: null, createdAt: at, updatedAt: at,
    };
    await this.save(hunt);
    // A hunt exists only once its first search has run: if that fails, nothing is left behind to
    // show a "hunt" that never looked, or to tempt a duplicate on retry.
    try {
      return (await this.run(hunt, { reason: 'created' })).hunt;
    } catch (e) {
      await this.store.deleteRecord('hunt', hunt.id).catch(() => {});
      throw e;
    }
  }

  async save(hunt) {
    await this.store.putRecord('hunt', hunt.id, hunt, { userId: hunt.userId });
    return hunt;
  }

  summary(hunt) {
    const bestTotal = hunt.baseline && hunt.baseline.best ? hunt.baseline.best.total : null;
    return {
      bestTotal, kept: bestTotal === null ? null : hunt.budget - bestTotal, lastMeaningfulAt: hunt.lastMeaningfulAt, lastRunAt: hunt.lastRunAt, status: hunt.status,
      newOpportunities: hunt.opportunities.filter(o => o.status === 'new').length,
    };
  }

  async list(user) {
    if (!user || !user.id) return [];
    const hunts = await this.store.listRecords('hunt', { userId: user.id, limit: 200 });
    return hunts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).map(h => ({ ...h, summary: this.summary(h) }));
  }

  async get(user, id) {
    const hunt = user && user.id ? await this.store.getRecord('hunt', String(id || '').slice(0, 60)) : null;
    if (!hunt || hunt.userId !== user.id) throw new AppError('hunt_not_found', 'This hunt could not be found.', 404);
    return hunt;
  }

  // The hunt with its whole memory: the opportunities on the page plus the compact record of the
  // ones that fell off it. This is what the engine judges against (what was told, what was refused)
  // and what the rule lines are read from, so a rejection the page no longer shows still holds.
  recall(hunt) {
    return { ...hunt, opportunities: [...(Array.isArray(hunt.remembered) ? hunt.remembered : []), ...hunt.opportunities] };
  }

  // The customer's hunt as it is once nothing is in flight on it: what an answer or a page open
  // reads, so it never acts on a copy a run is about to replace.
  async settled(user, id) {
    const hunt = await this.get(user, id);
    while (this.inFlight.has(hunt.id)) await this.inFlight.get(hunt.id).catch(() => {});
    return this.get(user, hunt.id);
  }

  // ---- running ---------------------------------------------------------------------------------
  // One operation on a hunt at a time, in this process: whoever comes second waits until nothing is
  // pending any more (not just for the one promise it saw), then does its own read-modify-write.
  async exclusive(id, work) {
    while (this.inFlight.has(id)) await this.inFlight.get(id).catch(() => {});
    const p = work();
    this.inFlight.set(id, p);
    try { return await p; } finally { if (this.inFlight.get(id) === p) this.inFlight.delete(id); }
  }

  // Run a hunt (by id; the caller's copy is never the one priced). `due`, when given, is judged on
  // the record as it is when the run's turn comes: a sweep or a page open that waited for another
  // run finds the hunt already checked and runs nothing, so one check is never two.
  async run(hunt, { reason = 'manual', due = null } = {}) {
    return this.exclusive(hunt.id, () => this.runNow(hunt.id, reason, due));
  }

  async runNow(id, reason, due) {
    const hunt = await this.store.getRecord('hunt', id);
    const skip = why => ({ hunt, result: null, skipped: why });
    if (!hunt) return skip('gone');
    // A hunt that is not hunting is never priced and never saved back as hunting, whoever asks.
    if (hunt.status !== 'hunting') return skip('not hunting');
    if (due && !due(hunt)) return skip('not due');
    const now = this.now();
    const at = now.toISOString();
    if (hunt.dateMode === 'flexible' && this.monthClosed(hunt.month, now)) {
      // Nothing in the month can be priced any more, so there is nothing left to hunt: the hunt
      // stops and says why, instead of logging a check that asked no supplier anything, forever.
      hunt.status = 'stopped';
      hunt.learned.push({ at, text: `${monthClosedWords(hunt.month)}, so the hunt stopped` });
      hunt.updatedAt = at;
      await this.save(hunt);
      this.log.info(`[hunts] "${hunt.name}" (${hunt.id}) stopped: no departure in ${monthWords(hunt.month)} is left to price`);
      return skip('month closed');
    }
    const settings = await this.settings();
    const result = this.engine.runHunt(this.inv, this.recall(hunt), settings, { now, previous: hunt.baseline });
    const added = [];
    for (const o of result.opportunities || []) {
      const opp = { ...o, id: makeId('opp'), status: 'new', notified: false };
      hunt.opportunities.push(opp);
      added.push(opp);
    }
    if (hunt.opportunities.length > MAX_OPPORTUNITIES) {
      const gone = hunt.opportunities.splice(0, hunt.opportunities.length - MAX_OPPORTUNITIES);
      hunt.remembered = [...(Array.isArray(hunt.remembered) ? hunt.remembered : []), ...gone.filter(o => o.trip && o.trip.token).map(remember)];
    }
    // The baseline is what the next run is judged against: only what this run actually priced.
    const best = result.best ? { token: result.best.token, total: result.best.total, nights: result.best.nights, stops: result.best.stops, stars: result.best.stars, dest: result.best.dest } : null;
    // `overByDest` is the cheapest package priced per destination that stayed over the ceiling: the only
    // thing that can later earn "your money just unlocked <destination>", because it is a recorded price.
    hunt.baseline = { at, best, closest: result.closest || null, byDest: result.byDest || [], nonstop: result.nonstop || null, overByDest: Array.isArray(result.overByDest) ? result.overByDest : [] };
    const checked = result.checked || {};
    hunt.runs.push({ at, reason, destinations: checked.destinations || 0, considered: checked.considered || 0, eligible: checked.eligible || 0, bestTotal: best ? best.total : null, opportunities: added.length, silent: added.length ? null : (result.silent || null) });
    if (hunt.runs.length > MAX_RUNS) hunt.runs.splice(0, hunt.runs.length - MAX_RUNS);
    hunt.lastRunAt = at;
    if (added.length) hunt.lastMeaningfulAt = at;
    await this.save(hunt);
    // Notify after the record is saved, so a notifier failure never loses what was found; a message
    // that failed to send leaves notified=false and the page still shows the opportunity.
    for (const opp of added) {
      try {
        await this.notifier.send(await this.message(hunt, opp));
        opp.notified = true;
      } catch (e) { this.log.error(`[hunts] notification failed for ${hunt.id}`, e); }
    }
    if (added.some(o => o.notified)) await this.save(hunt);
    return { hunt, result };
  }

  async message(hunt, opp) {
    const user = hunt.userId ? await this.store.getRecord('user', hunt.userId) : null;
    const to = user && user.email ? user.email : hunt.userId;
    const receipt = opp.receipt || { rules: [], found: [], why: '' };
    const found = (receipt.found || []).slice(0, 2).join(' · ') || `${money(opp.trip.total)} total`;
    const link = `${(this.config && this.config.publicBaseUrl) || ''}/hunts/${hunt.id}`;
    const body = [
      this.engine.decisionText(opp, hunt), '',
      'Your rules:', ...(receipt.rules || []).map(l => `- ${l}`), '',
      'Found:', ...(receipt.found || []).map(l => `- ${l}`), '',
      `Why I interrupted you: ${receipt.why || ''}`.trim(), '',
      `Open the hunt: ${link}`,
    ].join('\n');
    return { to, subject: `A reason to travel: ${found}`, body, ref: hunt.id };
  }

  // Opening a hunt re-checks it only when the last check is older than maxAge; otherwise the stored
  // facts stand as they are and no search is implied. The age is judged again on the fresh record
  // when the run's turn comes, so two opens at once are one check.
  async refresh(user, id, { maxAgeMinutes = REFRESH_MAX_AGE_MINUTES } = {}) {
    const stale = h => ageOf(h, this.now()) > maxAgeMinutes * 60000;
    const hunt = await this.settled(user, id);
    if (hunt.status !== 'hunting' || !stale(hunt)) return hunt;
    return (await this.run(hunt, { reason: 'opened', due: stale })).hunt;
  }

  // Every hunt that is hunting, of every customer. The store lists newest first with no status
  // filter and no cursor, and nothing deletes a stopped hunt, so the page grows until it is short:
  // every record is seen, however many stopped ones are newer than a hunting one.
  async hunting() {
    for (let limit = SWEEP_PAGE; ; limit *= 2) {
      const page = await this.store.listRecords('hunt', { limit });
      if (page.length < limit) return page.filter(h => h.status === 'hunting');
    }
  }

  // Every hunting hunt whose last check is older than the interval, oldest check first. One sweep at
  // a time: a tick that fires while the last sweep is still going joins it. Each hunt is judged due
  // again on its fresh record when its turn comes, so one the customer answered on, stopped, or
  // opened meanwhile is left as they left it.
  runDue({ now = this.now() } = {}) {
    if (!this.sweep) this.sweep = this.sweepNow(now).finally(() => { this.sweep = null; });
    return this.sweep;
  }

  async sweepNow(now) {
    const minutes = this.intervalMinutes;
    const due = h => ageOf(h, now) >= minutes * 60000;
    const hunts = (await this.hunting()).filter(due).sort((a, b) => ((a.lastRunAt || '') < (b.lastRunAt || '') ? -1 : (a.lastRunAt || '') > (b.lastRunAt || '') ? 1 : 0));
    let ran = 0, found = 0;
    for (const hunt of hunts) {
      try {
        const { result } = await this.run(hunt, { reason: 'scheduled', due });
        if (!result) continue;
        ran += 1;
        const n = (result.opportunities || []).length;
        found += n;
        if (n) this.log.info(`[hunts] scheduled run of "${hunt.name}" (${hunt.id}) found ${n} ${n === 1 ? 'opportunity' : 'opportunities'}`);
      } catch (e) { this.log.error(`[hunts] scheduled run failed for ${hunt.id}`, e); }
    }
    return { ran, found };
  }

  start() {
    if (this.timer || this.intervalMinutes <= 0) return false;
    this.timer = setInterval(() => { this.runDue().catch(e => this.log.error('[hunts] scheduler', e)); }, 60000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- the customer answers --------------------------------------------------------------------
  // The answer is applied to the record as it is once nothing is in flight on it, and saved under
  // the same turn, so a run never writes over it and it never writes over a run.
  async respond(user, id, action, payload = {}) {
    const found = await this.get(user, id);
    if (!ACTIONS.includes(action)) throw invalid('That is not something a hunt can do.');
    const { hunt, rulesChanged } = await this.exclusive(found.id, () => this.answer(user, found.id, action, payload));
    // A rule change is always followed by a real check under the new rules (the result returned is
    // that search, never an older one), unless the hunt is not hunting, when nothing searches.
    if (rulesChanged && hunt.status === 'hunting') return this.run(hunt, { reason: 'updated' });
    return { hunt, result: null };
  }

  async answer(user, id, action, payload) {
    const hunt = await this.get(user, id);
    const now = this.now();
    const at = now.toISOString();
    const learn = text => hunt.learned.push({ at, text });
    const best = hunt.baseline && hunt.baseline.best ? hunt.baseline.best : null;
    let rulesChanged = false;
    // A rule about when to speak, not about what qualifies: the record stays comparable.
    let keepBaseline = false;
    const markNew = status => { for (const o of hunt.opportunities) if (o.status === 'new') o.status = status; };

    const improve = (what, suffix = '') => {
      const ceiling = Math.min(hunt.budget, hunt.target || Infinity);
      switch (what) {
        case 'price': {
          // The next $50 step below the found total, and at least $50 below it: the same quality
          // for less, so the floors the found trip set come along.
          const from = best ? best.total : ceiling;
          let target = Math.floor((from - 1) / STEP) * STEP;
          if (from - target < STEP) target -= STEP;
          target = Math.max(target, STEP);
          if (target >= ceiling) throw invalid(`The hunt is already looking under ${money(ceiling)}; it cannot go lower than ${money(STEP)} steps.`);
          hunt.target = target;
          hunt.floors = { minStars: best ? best.stars : hunt.floors.minStars, nonstop: best ? best.stops === 0 : hunt.floors.nonstop };
          const kept = [hunt.floors.minStars ? `at least ${hunt.floors.minStars} stars` : null, hunt.floors.nonstop ? 'nonstop flights' : null].filter(Boolean);
          learn(`Now looking under ${money(target)}${kept.length ? `, keeping ${kept.join(' and ')}` : ''}${suffix}`);
          break;
        }
        case 'hotel': {
          // One class above what the search already requires (the rule, or the floor a target set)
          // and what it found: a raise the found trip already meets would change nothing the search
          // uses, so it is refused in plain words rather than announced.
          const have = Math.max(hunt.rules.minStars || 0, (hunt.floors && hunt.floors.minStars) || 0, best ? best.stars : 0);
          if (have >= MAX_STARS) throw invalid(best && best.stars >= MAX_STARS ? `The trip I found has a ${MAX_STARS}-star hotel, the highest class we price; there is no higher class to ask for.` : `The hotel minimum is already ${MAX_STARS} stars, the highest class we price.`);
          const stars = (have || 3) + 1;
          hunt.rules.minStars = stars;
          learn(`Hotel minimum raised to ${stars} stars${suffix}`);
          break;
        }
        case 'nights': {
          const nights = Math.min(14, (best ? best.nights : hunt.minNights) + 1);
          if (nights <= hunt.minNights) throw invalid('The hunt already asks for the longest trip we price, 14 nights.');
          // A fixed-length hunt's "up to" has to follow the minimum; when it does, that is said too.
          const maxMoved = hunt.maxNights < nights;
          hunt.minNights = nights;
          if (maxMoved) hunt.maxNights = nights;
          learn(`Minimum nights raised to ${nights}${suffix}${maxMoved ? `, and the maximum to ${nights} to match` : ''}`);
          break;
        }
        case 'nonstop': {
          if (hunt.rules.flightStops === 'nonstop' && hunt.rules.flightRule === 'hard') throw invalid('Nonstop flights are already a hard rule.');
          hunt.rules.flightStops = 'nonstop';
          hunt.rules.flightRule = 'hard';
          learn(`Nonstop flights are now a hard rule${suffix}`);
          break;
        }
        case 'destination': {
          if (!best) throw invalid('There is no found trip to rule out yet.');
          if (!hunt.excludeDests.includes(best.dest)) hunt.excludeDests.push(best.dest);
          const d = this.inv.maps.getDestination(best.dest);
          learn(`${d ? d.name : best.dest} ruled out for this hunt${suffix}`);
          break;
        }
        default: throw invalid('Say what to improve: price, hotel, nights, nonstop or destination.');
      }
      rulesChanged = true;
    };

    switch (action) {
      case 'keep-waiting':
        markNew('seen');
        learn('You chose to keep waiting; nothing changed');
        break;
      case 'seen':
        markNew('seen');
        break;
      case 'improve':
        markNew('seen');
        improve(oneOf(payload.what, IMPROVEMENTS, 'Say what to improve: price, hotel, nights, nonstop or destination.'));
        break;
      case 'harder':
        markNew('seen');
        improve('price');
        break;
      case 'reject': {
        // The "no" is recorded whatever the reason does: a trip the customer refused stays refused
        // even when the rule the reason names cannot move, and the line says why nothing moved.
        const reason = String(payload.reason || '').trim().slice(0, 120);
        const target = payload.opportunityId ? hunt.opportunities.find(o => o.id === payload.opportunityId) : null;
        if (target) target.status = 'rejected'; else markNew('rejected');
        const named = REASON_RULES.filter(([re]) => re.test(reason));
        const stands = 'the rules stand until you say what to change';
        if (!reason) learn(`Rejected; ${stands}`);
        else if (named.length === 1) {
          try { improve(named[0][1], ` after '${reason}'`); } catch (e) {
            if (!(e instanceof AppError)) throw e;
            learn(`Rejected: '${reason}'; ${e.message} The rules stand until you say what to change`);
          }
        } else if (named.length > 1) learn(`Rejected: '${reason}'; it names more than one rule (${named.map(n => n[2]).join(' and ')}), so ${stands}`);
        else learn(`Rejected: '${reason}'; ${stands}`);
        break;
      }
      case 'taken': {
        const opp = hunt.opportunities.find(o => o.id === payload.opportunityId);
        if (!opp) throw invalid('Which trip did you take?');
        opp.status = 'taken';
        learn(`Marked the ${opp.trip.dest} trip at ${money(opp.trip.total)} as taken`);
        break;
      }
      case 'threshold': {
        // "Tell me about $50 wins": the saving worth an interruption, said back in the same words. The
        // search is the same, so the trip on record is still the trip on record; the re-check judges
        // against it, and a drop that was under the old threshold can now be told.
        const t = intIn(payload.threshold, 1, hunt.budget, `The saving that is worth an interruption must be between $0.01 and your ${money(hunt.budget)} limit.`);
        if (t === hunt.threshold) throw invalid(`The hunt already interrupts you for wins of ${money(t)} or more.`);
        hunt.threshold = t;
        learn(`Now interrupting for wins of ${money(t)} or more`);
        rulesChanged = true;
        keepBaseline = true;
        break;
      }
      case 'stop':
        if (hunt.status !== 'stopped') { hunt.status = 'stopped'; learn('Hunt stopped'); }
        break;
      case 'resume':
        if (hunt.status !== 'hunting') {
          // A month with nothing left to price cannot be hunted again; a new hunt can name a later one.
          if (hunt.dateMode === 'flexible' && this.monthClosed(hunt.month, now)) throw invalid(`${monthClosedWords(hunt.month)}; start a new hunt for a later month.`);
          hunt.status = 'hunting';
          learn('Hunt resumed');
        }
        break;
      default: break;
    }
    hunt.updatedAt = at;
    if (rulesChanged && !keepBaseline) {
      // The recorded baseline was measured under the old rules, so it is not a comparable previous
      // search: the next run starts fresh and says what it found (or why nothing qualifies) rather
      // than inventing a drop or a breakthrough against rules the customer no longer has.
      hunt.baseline = null;
    }
    await this.save(hunt);
    return { hunt, rulesChanged };
  }

  // ---- words -----------------------------------------------------------------------------------
  // Exactly what runs: the timer while a hunt is hunting, and a page open whose last check is older
  // than refresh()'s own limit; nothing else, and nothing when nothing meaningful happened.
  monitoringText() {
    const n = this.intervalMinutes;
    const open = `when you open one if its last check is more than ${intervalWords(REFRESH_MAX_AGE_MINUTES)} old`;
    if (n > 0) return `This site re-checks your hunts about every ${intervalWords(n)} while they run, and ${open}. What it finds appears here and in My Trips, and by email once notifications are connected. It says nothing when nothing meaningful happened.`;
    return `This site re-checks your hunts only ${open}; nothing runs in between. What it finds appears here and in My Trips, and by email once notifications are connected.`;
  }
}

HuntService.ACCEPTANCE = ACCEPTANCE;
HuntService.REFRESH_MAX_AGE_MINUTES = REFRESH_MAX_AGE_MINUTES;

module.exports = { HuntService, ACCEPTANCE, NOTIFY_KINDS, THRESHOLDS, WHO, DATE_MODES, SAVINGS_LEVELS, IMPROVEMENTS, ACTIONS, MEALS, BAGS, REFRESH_MAX_AGE_MINUTES, MAX_OPPORTUNITIES, intervalWords, monthClosed };
