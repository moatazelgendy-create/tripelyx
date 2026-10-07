// The AI Savings Hunter's record keeper and scheduler. A hunt is a customer's standing instruction:
// a ceiling, an origin, who is going, how long, the rules, and which kinds of win are worth an
// interruption. This service stores hunts, runs them (on creation, when opened, on a timer, and after
// the customer changes the rules), keeps the baseline the next run is judged against, and sends one
// notification per opportunity. It never prices anything itself: every search is hunter.runHunt over
// the inventory, so every number here is a priced fact or arithmetic on one. It says nothing when a
// run found nothing worth saying, and never implies a search happened when it did not.
const { AppError } = require('../lib/errors');
const { id: makeId } = require('../lib/ids');
const { today } = require('../lib/dates');
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
const ACTIONS = ['keep-waiting', 'seen', 'improve', 'reject', 'harder', 'taken', 'stop', 'resume'];
// Thresholds the pages offer; the engine owns the list, with a fallback while it is being built.
const THRESHOLDS = Array.isArray(hunter.THRESHOLDS) ? hunter.THRESHOLDS : [5000, 10000, 20000];
const STYLE_WORD = { beach: 'Beach', city: 'City', adventure: 'Adventure', romantic: 'Romantic', family: 'Family', 'all-inclusive': 'All-Inclusive', surprise: 'Anywhere' };
const MAX_RUNS = 30;
// Opportunities are the customer's history; the record is still a single JSON document, so the
// oldest fall off once there are this many.
const MAX_OPPORTUNITIES = 100;
const STEP = 5000; // the $50 step "find me something even better" moves by
const MIN_BUDGET = 10000, MAX_BUDGET = 5000000;

const ACCEPTANCE = 'Got it. I won’t contact you just because something is cheap. I’ll contact you when I find a trip that meets your rules and looks worth considering.';

const money = c => fmtMoney(c, 'USD');
const invalid = message => new AppError('invalid_hunt', message, 422);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

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
function boolOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v === true || v === 'true' || v === '1' || v === 1 || v === 'on') return true;
  if (v === false || v === 'false' || v === '0' || v === 0 || v === 'off') return false;
  throw invalid('Refundable must be yes or no.');
}

// How long the interval is, in words a customer reads: "6 hours", "1 hour", "90 minutes".
function intervalWords(minutes) {
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

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
    // One run per hunt at a time: a scheduled sweep and a customer opening the page must not both
    // append the same opportunity.
    this.inFlight = new Map();
  }

  get intervalMinutes() {
    const n = this.config && this.config.trips ? Number(this.config.trips.huntIntervalMinutes) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
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
    }
    const minNights = intIn(input.minNights, 2, 14, 'Minimum nights must be between 2 and 14.');
    const maxNights = input.maxNights === undefined || input.maxNights === null || input.maxNights === ''
      ? Math.min(minNights + 3, 14)
      : intIn(input.maxNights, minNights, 14, `Maximum nights must be between ${minNights} and 14.`);
    const style = oneOf(input.style || 'surprise', optimizer.STYLES, 'Pick a trip style.');

    const r = input.rules || {};
    const flightStops = oneOf(r.flightStops, ['nonstop'], 'Flights are either nonstop or open.', { nullable: true });
    // "Nonstop" with no word on how firm it is counts as a hard rule: the hunt never shows a trip
    // that breaks what the customer said, and a preference must be asked for by name.
    const flightRule = flightStops ? oneOf(r.flightRule || 'hard', ['hard', 'preferred'], 'A nonstop rule is either hard or preferred.') : null;
    const minStars = r.minStars === undefined || r.minStars === null || r.minStars === '' ? null : intIn(r.minStars, 2, 5, 'Hotel stars must be between 2 and 5.');
    const rules = {
      flightStops, flightRule, minStars, refundable: boolOrNull(r.refundable),
      meals: oneOf(r.meals, MEALS, 'Meals are all-inclusive, breakfast or open.', { nullable: true }),
      bags: oneOf(r.bags, BAGS, 'Bags are personal, carry-on or checked.', { nullable: true }),
    };

    const excludeDests = [...new Set((Array.isArray(input.excludeDests) ? input.excludeDests : []).map(d => String(d).trim()).filter(Boolean))];
    for (const d of excludeDests) if (!this.inv.maps.getDestination(d)) throw invalid(`"${d}" is not a destination we offer.`);

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
    if (!name) name = `${money(budget)} ${STYLE_WORD[style] || style} Hunt`;
    return { name, budget, origin, travelers, who, dateMode, month, minNights, maxNights, style, rules, excludeDests, savedToken, notify, threshold, savingsLevel };
  }

  // ---- create / list / get ---------------------------------------------------------------------
  async create(user, input) {
    if (!user || !user.id) throw new AppError('sign_in_required', 'Sign in to start a hunt.', 401);
    const at = this.now().toISOString();
    const hunt = {
      id: makeId('hnt'), userId: user.id, ...this.validate(input), status: 'hunting', target: null, floors: { minStars: null, nonstop: false },
      baseline: null, runs: [], opportunities: [], learned: [], lastRunAt: null, lastMeaningfulAt: null, createdAt: at, updatedAt: at,
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
    if (!hunt || hunt.userId !== user.id) throw new AppError('not_found', 'This hunt could not be found.', 404);
    return hunt;
  }

  // ---- running ---------------------------------------------------------------------------------
  async run(hunt, { reason = 'manual' } = {}) {
    const pending = this.inFlight.get(hunt.id);
    if (pending) await pending.catch(() => {});
    const p = this.runNow(hunt, reason);
    this.inFlight.set(hunt.id, p);
    try { return await p; } finally { if (this.inFlight.get(hunt.id) === p) this.inFlight.delete(hunt.id); }
  }

  async runNow(hunt, reason) {
    const now = this.now();
    const at = now.toISOString();
    const settings = await this.settings();
    const result = this.engine.runHunt(this.inv, hunt, settings, { now, previous: hunt.baseline });
    const added = [];
    for (const o of result.opportunities || []) {
      const opp = { ...o, id: makeId('opp'), status: 'new', notified: false };
      hunt.opportunities.push(opp);
      added.push(opp);
    }
    if (hunt.opportunities.length > MAX_OPPORTUNITIES) hunt.opportunities.splice(0, hunt.opportunities.length - MAX_OPPORTUNITIES);
    // The baseline is what the next run is judged against: only what this run actually priced.
    const best = result.best ? { token: result.best.token, total: result.best.total, nights: result.best.nights, stops: result.best.stops, stars: result.best.stars, dest: result.best.dest } : null;
    hunt.baseline = { at, best, closest: result.closest || null, byDest: result.byDest || [], nonstop: result.nonstop || null };
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
  // facts stand as they are and no search is implied.
  async refresh(user, id, { maxAgeMinutes = 10 } = {}) {
    let hunt = await this.get(user, id);
    const pending = this.inFlight.get(hunt.id);
    if (pending) { await pending.catch(() => {}); hunt = await this.get(user, id); }
    if (hunt.status !== 'hunting') return hunt;
    const age = hunt.lastRunAt ? this.now().getTime() - Date.parse(hunt.lastRunAt) : Infinity;
    if (age <= maxAgeMinutes * 60000) return hunt;
    return (await this.run(hunt, { reason: 'opened' })).hunt;
  }

  // Every hunting hunt, of every customer, whose last check is older than the interval.
  async runDue({ now = this.now() } = {}) {
    const minutes = this.intervalMinutes;
    const hunts = await this.store.listRecords('hunt', { limit: 1000 });
    let ran = 0, found = 0;
    for (const hunt of hunts) {
      if (hunt.status !== 'hunting') continue;
      const age = hunt.lastRunAt ? now.getTime() - Date.parse(hunt.lastRunAt) : Infinity;
      if (age < minutes * 60000) continue;
      try {
        const { result } = await this.run(hunt, { reason: 'scheduled' });
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
  async respond(user, id, action, payload = {}) {
    const hunt = await this.get(user, id);
    if (!ACTIONS.includes(action)) throw invalid('That is not something a hunt can do.');
    const at = this.now().toISOString();
    const learn = text => hunt.learned.push({ at, text });
    const best = hunt.baseline && hunt.baseline.best ? hunt.baseline.best : null;
    let rulesChanged = false;
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
          const base = best ? best.stars : (hunt.rules.minStars || 3);
          const stars = Math.min(5, base + 1);
          if (hunt.rules.minStars === stars) throw invalid(`The hotel minimum is already ${stars} stars.`);
          hunt.rules.minStars = stars;
          learn(`Hotel minimum raised to ${stars} stars${suffix}`);
          break;
        }
        case 'nights': {
          const nights = Math.min(14, (best ? best.nights : hunt.minNights) + 1);
          if (nights <= hunt.minNights) throw invalid('The hunt already asks for the longest trip we price, 14 nights.');
          hunt.minNights = nights;
          hunt.maxNights = Math.max(hunt.maxNights, hunt.minNights);
          learn(`Minimum nights raised to ${hunt.minNights}${suffix}`);
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
        const reason = String(payload.reason || '').trim().slice(0, 120);
        const target = payload.opportunityId ? hunt.opportunities.find(o => o.id === payload.opportunityId) : null;
        if (target) target.status = 'rejected'; else markNew('rejected');
        const what = /short|longer|more nights/i.test(reason) ? 'nights'
          : /expensive|price|cheap|cost|money/i.test(reason) ? 'price'
            : /hotel|star|room|resort/i.test(reason) ? 'hotel'
              : /travel|stop|layover|flight|connection/i.test(reason) ? 'nonstop'
                : /place|destination|where|somewhere|country|city/i.test(reason) ? 'destination' : null;
        if (what) improve(what, ` after '${reason}'`);
        else learn(reason ? `Rejected: '${reason}'; the rules stand until you say what to change` : 'Rejected; the rules stand until you say what to change');
        break;
      }
      case 'taken': {
        const opp = hunt.opportunities.find(o => o.id === payload.opportunityId);
        if (!opp) throw invalid('Which trip did you take?');
        opp.status = 'taken';
        learn(`Marked the ${opp.trip.dest} trip at ${money(opp.trip.total)} as taken`);
        break;
      }
      case 'stop':
        if (hunt.status !== 'stopped') { hunt.status = 'stopped'; learn('Hunt stopped'); }
        break;
      case 'resume':
        if (hunt.status !== 'hunting') { hunt.status = 'hunting'; learn('Hunt resumed'); }
        break;
      default: break;
    }
    hunt.updatedAt = at;
    if (rulesChanged) {
      // The recorded baseline was measured under the old rules, so it is not a comparable previous
      // search: the next run starts fresh and says what it found (or why nothing qualifies) rather
      // than inventing a drop or a breakthrough against rules the customer no longer has.
      hunt.baseline = null;
    }
    await this.save(hunt);
    if (rulesChanged && hunt.status === 'hunting') return this.run(hunt, { reason: 'updated' });
    return { hunt, result: null };
  }

  // ---- words -----------------------------------------------------------------------------------
  monitoringText() {
    const n = this.intervalMinutes;
    if (n > 0) return `This site re-checks your hunts about every ${intervalWords(n)} while it is running and each time you open them. What it finds appears here and in My Trips, and by email once notifications are connected. It says nothing when nothing meaningful happened.`;
    return 'This site re-checks your hunts each time you open them; nothing runs in between. What it finds appears here and in My Trips, and by email once notifications are connected.';
  }
}

HuntService.ACCEPTANCE = ACCEPTANCE;

module.exports = { HuntService, ACCEPTANCE, NOTIFY_KINDS, THRESHOLDS, WHO, DATE_MODES, SAVINGS_LEVELS, IMPROVEMENTS, ACTIONS, MEALS, BAGS, intervalWords };
