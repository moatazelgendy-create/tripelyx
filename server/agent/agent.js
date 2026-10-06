// The AI travel agent. One conversation, one canonical trip object (state.js), and a tool router
// that sends every ask to the deterministic engines: the optimizer builds and prices, the decision
// layer makes it cheaper or better, the challenge engine compares like for like. The language layer
// (understand.js) only turns words into structured updates and intents; it never prices, never
// invents availability, and never books. Every change to the trip is a proposal the traveler approves.
//
// Instant response: a build answers at once and runs as a job (jobs.js) in real phases: the likeliest
// destinations first (first strong match), then every destination (best current match), then, only
// when nothing fits, one relaxation at a time. The page shows the real phase it is in.
const { id: makeId } = require('../lib/ids');
const { AppError } = require('../lib/errors');
const { addDays, today } = require('../lib/dates');
const { format: fmtMoney } = require('../lib/money');
const optimizer = require('../trips/optimizer');
const decision = require('../trips/decision');
const challenge = require('../trips/challenge');
const { classifyChanges, lineDiff } = require('../trips/facts');
const { encodeSpec, decodeSpec } = require('../trips/spec');
const { priceTrip } = require('../trips/pricing');
const { understand } = require('./understand');
const state = require('./state');
const { JobRunner, breathe, newJob, setStep } = require('./jobs');

const money = c => fmtMoney(c, 'USD');
const dollars = c => `$${Math.round(c / 100).toLocaleString('en-US')}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hm = m => `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}`;
const joinAnd = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const longDate = d => new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const FAST_DESTINATIONS = 4;
const MATERIAL_SAVING = 2500; // $25: a better option must be at least this much cheaper with nothing given up, or clearly stronger for the same money

const THEIRS_ORDER = ['taxes', 'stars', 'meals', 'flight', 'cancel', 'bags', 'transfer', 'dates'];
const THEIRS_QUESTIONS = {
  taxes: { text: c => `Is their ${money(c.total)} the final price with taxes and fees inside, or before them?`, options: [['Taxes included', 'Taxes included'], ['Taxes extra', 'Taxes extra']] },
  stars: { text: 'What class is their hotel?', options: [['3-star', '3-star'], ['4-star', '4-star'], ['5-star', '5-star']] },
  meals: { text: 'What meals does their price include?', options: [['All-inclusive', 'All-inclusive'], ['Breakfast', 'Breakfast included'], ['No meals', 'No meals']] },
  flight: { text: 'Are their flights nonstop?', options: [['Nonstop', 'Nonstop'], ['One stop or more', 'One stop or more']] },
  cancel: { text: 'Can their trip be cancelled for a refund?', options: [['Refundable', 'Refundable'], ['Non-refundable', 'Non-refundable']] },
  bags: { text: 'Are bags in their price?', options: [['Checked bag included', 'Checked bag included'], ['Carry-on only', 'Carry-on only'], ['Personal item only', 'Personal item only']] },
  transfer: { text: 'Is an airport transfer in their price?', options: [['Transfer included', 'Transfer included'], ['No transfer', 'No transfer']] },
  dates: { text: 'What date does their trip leave? Type the date, or say you don’t know.', options: [] },
};
const THEIRS_WORDS = {
  stars: v => `a ${v}-star hotel`, meals: v => (v === 'none' ? 'no meals' : v === 'breakfast' ? 'breakfast included' : 'all-inclusive'), bags: v => (v === 'checked' ? 'a checked bag included' : v === 'carry-on' ? 'carry-on only' : 'a personal item only'),
  transfer: v => (v === 'yes' ? 'transfer included' : 'no transfer'), cancel: v => (v === 'refundable' ? 'refundable' : 'non-refundable'), taxes: v => (v === 'included' ? 'taxes and fees in the price' : 'taxes and fees extra'),
  flight: v => (v === 'nonstop' ? 'nonstop flights' : 'flights with a stop'), depart: v => `leaving ${longDate(v)}`, nights: v => plural(v, 'night'),
};

const COMMANDS = ['Make it $200 cheaper', 'Don’t change the hotel', 'Give me one more night', 'Only nonstop', 'Try another country', 'Spend $100 if it actually helps', 'Make this easier', 'What’s the catch?', 'Which one would you pick?', 'Can you beat this?', 'Start over'];

// ---- words from facts --------------------------------------------------------------------------
const flightWords = f => `${f.stops ? `${f.stops}-stop` : 'nonstop'} ${/nonstop/i.test(f.name) ? '' : `${f.name} `}flights, ${hm(f.durationMinutes)} each way`;
const hotelWords = h => `${h.name} (${h.stars}-star${h.features.beachfront ? ', beachfront' : ''}${h.features.allInclusive ? ', all-inclusive' : h.features.breakfast ? ', breakfast included' : ''})`;
const changeWords = rows => rows.map(r => `${r.label.toLowerCase()}: ${r.a} → ${r.b}`);

function tripCard(t, token, ctx = {}) {
  const sc = optimizer.scoreTrip(t, ctx);
  return {
    token, total: t.total, perTraveler: t.perTraveler, destId: t.dest.id, dest: t.dest.name, country: t.dest.country, image: t.dest.image,
    depart: t.spec.depart, ret: t.flight.return, nights: t.spec.nights, travelers: t.spec.travelers,
    flight: { stops: t.flight.stops, name: t.flight.name, minutes: t.flight.durationMinutes, airline: t.flight.airline, refundable: !!t.flight.refundable },
    hotel: { name: t.hotel.name, stars: t.hotel.stars, rating: t.hotel.rating, area: t.hotel.area, beachfront: !!t.hotel.features.beachfront, allInclusive: !!t.hotel.features.allInclusive, breakfast: !!t.hotel.features.breakfast },
    activities: t.activities.map(a => a.name), transfer: !!t.transfer, bags: !!(t.flight.checkedBagIncluded || t.spec.bags), match: sc.match, demo: !!t.demo,
    summary: `${plural(t.spec.nights, 'night')} in ${t.dest.name} · ${flightWords(t.flight)} · ${hotelWords(t.hotel)}`,
  };
}

class AgentService {
  constructor({ tripService, store, now = () => new Date(), log = console }) {
    this.svc = tripService;
    this.store = store;
    this.now = now;
    this.log = log;
    this.jobs = new JobRunner({ log });
    this.breathe = breathe; // how a job yields between phases; tests hold a job here to look at it mid-search
    this.chains = new Map();
    this.discoveryCache = new Map();
  }

  get inv() { return this.svc.inv; }
  get maps() { return this.svc.inv.maps; }

  // ---- persistence: one writer at a time per conversation ----
  async create({ visitor = null, userId = null, booking = null } = {}) {
    const s = state.newState({ id: makeId('agt'), visitor, userId, now: this.now() });
    if (booking) s.booking = booking;
    await this.save(s);
    return s;
  }
  async load(id) { return (await this.store.getRecord('agent', String(id || '').slice(0, 60))) || null; }
  async save(s) { await this.store.putRecord('agent', s.id, s, { userId: s.userId }); }
  owns(s, { visitor = null, user = null } = {}) { return !!s && ((visitor && s.visitor === visitor) || (user && s.userId === user.id)); }
  withState(id, fn) {
    const prev = this.chains.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const s = await this.load(id);
      if (!s) throw new AppError('not_found', 'This conversation is gone. Start a new one.', 404);
      const out = await fn(s);
      s.updatedAt = this.now().toISOString();
      await this.save(s);
      return out;
    });
    this.chains.set(id, run);
    run.finally(() => { if (this.chains.get(id) === run) this.chains.delete(id); });
    return run;
  }

  // ---- the conversation ----
  async say(id, text) {
    return this.withState(id, s => this.handle(s, text));
  }

  // One traveler message: understand, update the trip object, route the asks, answer from facts.
  async handle(s, rawText) {
    const text = String(rawText || '').trim().slice(0, 600);
    if (!text) return s;
    const now = this.now();
    state.pushMessage(s, 'user', text, null, now);
    s.turns += 1;
    const u = understand(text, s, { maps: this.maps, now });
    const intents = new Set(u.intents);
    const pending = s.pending;
    s.pending = null;
    // A compromise menu is answered on the next turn or not at all.
    if (s.compromises && s.compromises.length && !(pending === 'options' && u.updates.option)) s.compromises = [];

    if (intents.has('restart')) return this.restart(s);
    if (intents.has('stop')) {
      const was = this.jobs.cancel(s.id);
      if (s.job && s.job.status === 'running') { s.job.status = 'cancelled'; s.job.finishedAt = now.toISOString(); s.job.note = 'Stopped at your request.'; }
      this.speak(s, was ? 'Stopped the search. Whatever I had already found stays on your canvas.' : 'Nothing is running. Your trip stays as it is.');
      return s;
    }

    // Answers to what I asked, approvals and declines come first: they are about the thing on the table.
    if (pending === 'options' && u.updates.option) { await this.chooseOption(s, u.updates.option); return this.afterTurn(s); }
    if (intents.has('approve') && !intents.has('cheaper') && !intents.has('better')) {
      if (await this.approve(s, text, pending)) return this.afterTurn(s);
    }
    if (intents.has('decline')) {
      if (this.decline(s, pending)) return this.afterTurn(s);
    }
    if (u.updates.theirs) { await this.theirsFlow(s, u.updates.theirs); return this.afterTurn(s); }

    const { rebuild } = state.applyUpdates(s, u.updates, { now });
    const ack = u.ack.length ? `Got it: ${joinAnd(u.ack)}.` : null;
    let handled = false;

    // Post-booking questions, when this conversation is about a booked trip.
    if (s.booking) {
      for (const k of ['next', 'cancelInfo', 'extend', 'afford', 'car', 'flightChange']) if (intents.has(k)) { await this.bookingAnswer(s, k, u); handled = true; }
      if (handled) return this.afterTurn(s);
    }

    const cur = s.current ? await this.currentTrip(s) : null;
    for (const k of ['next', 'cancelInfo', 'afford', 'car', 'flightChange']) if (!handled && intents.has(k)) { this.generalAnswer(s, k, cur); handled = true; }
    if (handled) return this.afterTurn(s);
    if (intents.has('watch')) {
      const closest = s.job && s.job.closest ? s.job.closest : null;
      const target = cur ? { token: s.current.token, total: cur.trip.total } : closest ? { token: closest.token, total: closest.total } : null;
      this.speak(s, target
        ? `I can't watch from this conversation yet. A price watch lives on the trip page: open it, sign in, and choose “Watch this trip”; we re-price it and show changes in My Trips.${s.userId ? '' : ' You will need an account for that.'}`
        : 'There is no trip to watch yet. Give me a budget and a departure city first.', target ? { kind: 'link', href: `/trip/${target.token}?${optimizer.contextParams(cur ? cur.ctx : {})}#save`, label: 'Open the trip page to watch it' } : null);
      handled = true;
    } else if (intents.has('challenge')) { await this.challengeFlow(s, u, cur); handled = true; }
    else if (intents.has('book')) { await this.bookFlow(s, cur); handled = true; }
    else if (u.updates.unlocks && !intents.has('cheaper') && !intents.has('better')) {
      const words = state.lockedWords(s);
      this.speak(s, words.length ? `Unlocked. Still locked: ${words.join(', ')}.` : 'Unlocked everything. I may change any part of the trip now, and I will still ask before I do.');
      handled = true;
    } else if (intents.has('lock') && !intents.has('cheaper') && !intents.has('better')) {
      const words = state.lockedWords(s);
      this.speak(s, words.length ? `Locked: ${words.join(', ')}. I will change anything else, never these, until you say otherwise.` : 'Tell me what to lock: the hotel, the flights, the dates, the length or the destination.');
      handled = true;
    }
    if (!handled && cur) {
      if (intents.has('nonstopRule') && cur) { await this.nonstopFlow(s, cur); handled = true; }
      else if (intents.has('stopSaves')) { await this.stopSaves(s, cur); handled = true; }
      else if (intents.has('extend')) { await this.changeNights(s, cur, +1); handled = true; }
      else if (intents.has('shorten')) { await this.changeNights(s, cur, -1); handled = true; }
      else if (intents.has('elsewhere')) { s.notCountry = cur.trip.dest.country; s.destination = null; this.speak(s, `Leaving ${cur.trip.dest.country} out. Rebuilding somewhere else with the same money and rules.`); await this.startBuild(s, { previous: s.current.token }); handled = true; }
      else if (intents.has('easier')) { await this.makeEasier(s, cur); handled = true; }
      else if (intents.has('cheaper')) { await this.makeCheaper(s, cur, u.updates.cheaperBy || null); handled = true; }
      else if (intents.has('better')) { await this.makeBetter(s, cur, u.updates.moreBy || null); handled = true; }
      else if (intents.has('catch')) { this.theCatch(s, cur); handled = true; }
      else if (intents.has('recommend')) { this.recommend(s, cur); handled = true; }
      else if (intents.has('why')) { this.why(s, cur); handled = true; }
      else if (intents.has('compare')) { this.compare(s); handled = true; }
    } else if (!handled && !cur && ['cheaper', 'better', 'extend', 'shorten', 'catch', 'recommend', 'why', 'compare', 'stopSaves', 'easier', 'elsewhere'].some(k => intents.has(k)) && !rebuild && !u.updates.budget) {
      this.speak(s, 'There is no trip on the canvas yet. Tell me your budget and where you are flying from, and I will build one first.');
      handled = true;
    }
    if (handled) { if (ack && !s.messages.some(m => m.text === ack)) { /* the engine answer already covers it */ } return this.afterTurn(s); }

    // Nothing specific was asked: the message defined or changed the trip. Build, rebuild, or ask the one missing thing.
    if (intents.has('nonstopRule') && !cur) { /* the rule is now on the trip object; the build honors it */ }
    if (rebuild || intents.has('build') || !s.current) {
      if (ack) this.speak(s, ack);
      await this.startBuild(s, { previous: s.current && rebuild ? s.current.token : null, reason: rebuild && s.current ? 'rebuild' : 'build' });
      return this.afterTurn(s);
    }
    if (u.unknown) {
      this.speak(s, 'I did not understand that, and I would rather say so than guess. You can tell me a budget, where you are flying from, who is going, when, or ask me to change the trip on the canvas.', { kind: 'commands', items: COMMANDS });
      return this.afterTurn(s);
    }
    if (ack) this.speak(s, `${ack} Nothing on the trip needed to change for that.`);
    return this.afterTurn(s);
  }

  afterTurn(s) { return s; }

  speak(s, text, card = null) { state.pushMessage(s, 'agent', text, card, this.now()); }

  restart(s) {
    const fresh = state.newState({ id: s.id, visitor: s.visitor, userId: s.userId, now: this.now() });
    this.jobs.cancel(s.id);
    for (const k of Object.keys(fresh)) s[k] = fresh[k];
    this.speak(s, 'Fresh start. What do you want your trip to do?');
    return s;
  }

  async settings() { return this.svc.settings(); }

  async currentTrip(s) {
    try {
      const q = state.toQuery(s, { maps: this.maps }).query;
      const ctx = state.budgetContext(s, q);
      const data = await this.svc.trip(s.current.token, ctx);
      return { ...data, ctx, q };
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      s.current = null;
      this.speak(s, 'Part of the trip on your canvas is no longer available from the suppliers, so I cleared it. Say "build it again" and I will rebuild from what you told me.');
      return null;
    }
  }

  // ---- building: fast first, deep second ---------------------------------------------------------
  async startBuild(s, { previous = null, reason = 'build' } = {}) {
    const ask = state.nextQuestion(s);
    if (ask) {
      s.pending = ask.key;
      this.speak(s, ask.text, ask.options ? { kind: 'ask', options: ask.options.map(([label, say]) => ({ label, say })) } : null);
      return;
    }
    const { query: q, assumed } = state.toQuery(s, { maps: this.maps });
    s.assumed = assumed;
    s.proposal = null;
    s.options = [];
    s.job = newJob(makeId('job'), ['understand', 'fast', 'deep', 'expand'], this.now());
    s.job.previous = previous;
    s.job.reason = reason;
    setStep(s.job, 'understand', 'done', this.describe(q, assumed), this.now());
    this.speak(s, `${reason === 'rebuild' ? 'Rebuilding' : 'Building'}: ${this.describe(q, assumed)}.${assumed.length ? ` I assumed ${joinAnd(assumed)}; say otherwise and I will change it.` : ''} First strong match in a moment; I keep searching after that.`);
    this.jobs.start(s.id, job => this.runBuild(s.id, job));
  }

  describe(q, assumed = []) {
    const o = this.maps.getOrigin(q.origin);
    const d = q.dest ? this.maps.getDestination(q.dest) : null;
    const bits = [`${plural(q.nights, 'night')}${q.style && q.style !== 'surprise' ? ` ${q.style === 'all-inclusive' ? 'all-inclusive' : q.style}` : ''} trip for ${q.travelers}`, `from ${o ? o.city : q.origin}`, d ? `to ${d.name}` : q.notCountry ? `outside ${q.notCountry}` : q.region === 'international' ? 'international' : 'anywhere'];
    bits.push(`at or under ${money(q.budget)}${q.keep ? ` with ${money(q.keep)} protected for the destination` : ''}`);
    if (q.rules && q.rules.nonstop) bits.push('nonstop only');
    if (q.rules && q.rules.minStars) bits.push(`${q.rules.minStars}-star or better`);
    if (q.dateMode === 'exact') bits.push(`leaving ${longDate(q.depart)}`);
    else if (q.dateMode === 'flexible') bits.push(`in ${q.month}`);
    return bits.join(', ');
  }

  // Destination discovery is cached (which destinations an origin reaches and roughly what they
  // cost); every price shown to the traveler is re-priced live inside the job itself.
  discovery(origin, settings) {
    const key = `${origin}:${JSON.stringify(settings.disabledDestinations || [])}`;
    const hit = this.discoveryCache.get(key);
    if (hit && hit.at > Date.now() - 600000) return hit.value;
    const q = { budget: 10000000, vacationBudget: 10000000, keep: 0, budgetInput: 100000, budgetType: 'total', travelers: 2, who: 'couple', origin, dateMode: 'anytime', depart: null, month: null, nights: 5, style: 'surprise', priority: 'price', allowOver: 0, dest: null, region: null, rules: null, dests: null, notCountry: null };
    const r = optimizer.search(this.inv, q, { settings, now: this.now() });
    const value = { cheapestByDest: r.cheapestByDest, at: this.now().toISOString() };
    this.discoveryCache.set(key, { at: Date.now(), value });
    return value;
  }

  likelyDestinations(q, settings) {
    if (q.dest) return [q.dest];
    const origin = this.maps.getOrigin(q.origin);
    const disabled = new Set(settings.disabledDestinations || []);
    const disc = this.discovery(q.origin, settings);
    const cands = this.maps.listDestinations().filter(d => !disabled.has(d.id)
      && !(q.notCountry && optimizer.sameCountry(d.country, q.notCountry))
      && !(q.region === 'international' && optimizer.sameCountry(d.country, origin.country || 'United States'))
      && (q.style === 'surprise' || q.style === 'all-inclusive' || d.styles.includes(q.style))
      && disc.cheapestByDest[d.id]);
    const price = d => disc.cheapestByDest[d.id];
    const fits = cands.filter(d => price(d) <= q.budget).sort((a, b) => price(a) - price(b));
    const rest = cands.filter(d => price(d) > q.budget).sort((a, b) => price(a) - price(b));
    return [...fits, ...rest].slice(0, FAST_DESTINATIONS).map(d => d.id);
  }

  patch(id, fn) { return this.withState(id, s => { if (!s.job) return null; return fn(s); }); }

  async runBuild(id, job) {
    const settings = await this.settings();
    const now = () => this.now();
    const snapshot = await this.withState(id, s => ({ q: state.toQuery(s, { maps: this.maps }).query, jobId: s.job && s.job.id, previous: s.job && s.job.previous }));
    if (!snapshot.jobId) return;
    const { q } = snapshot;
    const ctx = { budget: q.budget, keep: q.keep, allowOver: q.allowOver, style: q.style, priority: q.priority, nightsAsked: q.nights, rules: q.rules };
    const card = p => tripCard(p.trip, encodeSpec(p.trip.spec), ctx);
    const mine = s => s.job && s.job.id === snapshot.jobId && !job.cancelled;

    // Fast path: the likeliest destinations, priced live.
    const likely = this.likelyDestinations(q, settings);
    const names = likely.map(d => this.maps.getDestination(d).name);
    await this.patch(id, s => { if (!mine(s)) return; setStep(s.job, 'fast', 'running', likely.length ? `Pricing ${joinAnd(names)} first` : 'No likely destination found yet', now()); });
    await this.breathe();
    if (job.cancelled) return;
    const fast = likely.length ? optimizer.search(this.inv, { ...q, dests: likely }, { settings, now: now() }) : null;
    const first = fast && fast.picks[0] ? fast.picks[0] : null;
    await this.patch(id, s => {
      if (!mine(s)) return;
      setStep(s.job, 'fast', 'done', fast ? `${fast.considered} complete packages priced across ${plural(likely.length, 'destination')}` : 'Skipped', now());
      s.job.considered = fast ? fast.considered : 0;
      if (first) {
        const c = card(first);
        s.job.first = c;
        s.job.firstAtMs = Date.parse(now().toISOString()) - Date.parse(s.job.startedAt);
        s.current = { token: c.token, total: c.total, since: now().toISOString() };
        this.speak(s, `First strong match: ${c.summary}. ${money(c.total)} all in, ${q.budget - c.total >= 0 ? `${money(q.budget - c.total)} under your limit` : `${money(c.total - q.budget)} over your limit`}. Still checking whether I can beat this.`, { kind: 'trip', trip: c, label: 'First strong match', first: true });
      }
    });
    await this.breathe();
    if (job.cancelled) return;

    // Deep: every destination, every combination inside the rules.
    const all = this.maps.listDestinations().filter(d => !(settings.disabledDestinations || []).includes(d.id)).length;
    await this.patch(id, s => { if (!mine(s)) return; setStep(s.job, 'deep', 'running', `Checking all ${plural(all, 'destination')} we serve from ${this.maps.getOrigin(q.origin).city}`, now()); });
    await this.breathe();
    if (job.cancelled) return;
    const deep = optimizer.search(this.inv, q, { settings, now: now() });
    const best = deep.picks[0] || null;
    let improved = false;
    if (first && best) {
      const ch = classifyChanges(first.trip, best.trip);
      const saving = first.trip.total - best.trip.total;
      improved = encodeSpec(best.trip.spec) !== encodeSpec(first.trip.spec) && ((saving >= MATERIAL_SAVING && ch.tradeoffs.length === 0) || (best.match >= first.match + 5 && best.trip.total <= first.trip.total));
    }
    const previousTrip = snapshot.previous ? await this.priceToken(snapshot.previous) : null;
    await this.patch(id, s => {
      if (!mine(s)) return;
      setStep(s.job, 'deep', 'done', `${deep.considered} complete packages priced across ${plural(deep.destinations, 'destination')}; ${plural(deep.eligibleDestinations, 'destination')} had a trip inside your rules and budget`, now());
      s.job.considered = deep.considered;
      s.job.destinations = deep.destinations;
      s.options = deep.picks.map(p => ({ kind: p.kind, label: p.label, blurb: p.blurb, over: !!p.over, upgrade: p.upgrade ? { delta: p.upgrade.delta, gets: p.upgrade.gets, over: p.upgrade.over } : null, ...card(p) }));
      s.job.keepMoney = deep.keepMoney ? { spare: deep.keepMoney.spare, considered: deep.keepMoney.considered } : null;
      s.job.improved = improved;
      if (best) {
        const c = card(best);
        s.job.best = c;
        s.job.bestAtMs = Date.parse(now().toISOString()) - Date.parse(s.job.startedAt);
        if (first && improved) {
          const ch = classifyChanges(first.trip, best.trip);
          s.proposal = { kind: 'switch', token: c.token, total: c.total, delta: c.total - first.trip.total, from: s.job.first.token, label: 'Better option', improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over: c.total > q.budget };
          this.speak(s, `I beat my first option. First ${money(first.trip.total)}, better ${money(c.total)}${c.total < first.trip.total ? `, you keep ${money(first.trip.total - c.total)} more` : ''}: ${c.summary}. Switch, or keep the first one.`, { kind: 'switch', first: s.job.first, better: c, proposal: s.proposal });
        } else if (first) {
          this.speak(s, `Checked all ${plural(deep.destinations, 'destination')}: my first option holds as our pick.${s.options.length > 1 ? ' Here are your options.' : ''}`, s.options.length > 1 ? { kind: 'options', options: s.options, keepMoney: s.job.keepMoney } : null);
        } else {
          s.current = { token: c.token, total: c.total, since: now().toISOString() };
          this.speak(s, `Here is what fits: ${c.summary}, ${money(c.total)} all in.${s.options.length > 1 ? ' Your options:' : ''}`, s.options.length > 1 ? { kind: 'options', options: s.options, keepMoney: s.job.keepMoney } : { kind: 'trip', trip: c, label: 'Our pick' });
        }
        if (previousTrip && s.current) {
          const after = deep.picks.find(p => encodeSpec(p.trip.spec) === s.current.token) || best;
          const ch = classifyChanges(previousTrip, after.trip);
          this.speak(s, `Before ${money(previousTrip.total)} → after ${money(after.trip.total)}.`, { kind: 'diff', before: tripCard(previousTrip, encodeSpec(previousTrip.spec), ctx), after: card(after), improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), lines: lineDiff(previousTrip, after.trip) });
        }
        if (s.job.keepMoney && s.job.keepMoney.spare > 0 && !s.options.some(o => o.kind === 'upgrade')) this.speak(s, `I don't see a strong reason to spend the remaining ${money(s.job.keepMoney.spare)}: nothing I priced improves on our pick without giving something up. Keep it.`);
        setStep(s.job, 'expand', 'skipped', 'Not needed: a trip inside your rules and budget was found', now());
        s.job.status = 'done';
        s.job.finishedAt = now().toISOString();
      } else {
        setStep(s.job, 'expand', 'running', 'Nothing fits every rule. Pricing one relaxation at a time', now());
      }
    });
    if (best) return;
    await this.breathe();
    if (job.cancelled) return;

    // Nothing fits: which single rule, relaxed on its own, really produces a trip. Never a dead end.
    const relax = optimizer.oneRuleAway(this.inv, q, { settings, now: now() });
    await this.patch(id, s => {
      if (!mine(s)) return;
      setStep(s.job, 'expand', 'done', `${plural(relax.works.length, 'relaxation')} produced a real trip; ${relax.notAlone.length} did not on their own`, now());
      s.job.relax = { works: relax.works.map(w => ({ key: w.key, label: w.label, rule: w.rule, total: w.total, dest: w.dest, nights: w.nights, over: w.over, say: relaxSay(w, q) })), notAlone: relax.notAlone };
      const closest = deep.closest[0] ? card(deep.closest[0]) : null;
      s.job.closest = closest;
      s.job.status = 'done';
      s.job.finishedAt = now().toISOString();
      if (relax.works.length) this.speak(s, `Nothing fits all of your rules at ${money(q.budget)}.${closest ? ` The closest is ${closest.summary} at ${money(closest.total)}, ${money(closest.total - q.budget)} over.` : ''} One change gets there; pick one or tell me something else:`, { kind: 'relax', works: s.job.relax.works, closest });
      else this.speak(s, `Nothing fits at ${money(q.budget)}${closest ? `; the closest is ${closest.summary} at ${money(closest.total)}` : ''}, and no single rule relaxed on its own gets there either. I don't know a way to reach this budget with what suppliers returned. A higher budget, fewer nights, or a different departure city would change that.`, closest ? { kind: 'trip', trip: closest, label: 'Closest, over budget', over: true } : null);
    });
  }

  async priceToken(token) {
    try { return await this.svc.price(decodeSpec(token)); } catch { return null; }
  }

  // ---- proposals and approvals -----------------------------------------------------------------
  propose(s, p, text, card = null) {
    s.proposal = p;
    this.speak(s, text, card || { kind: 'proposal', proposal: p });
  }

  async approve(s, text, pending) {
    const lower = text.toLowerCase();
    if (s.proposal) {
      const p = s.proposal;
      if (p.anyway && /\b(anyway|the \$|cheap(?:er|est)|lower|target)\b/.test(lower) && !/\b(floor|recommend)/.test(lower)) return this.applyProposal(s, { ...p, token: p.anyway.token, total: p.anyway.total, delta: p.anyway.delta, label: p.anyway.label, challengedAccepted: true });
      if (p.over && !s.overApproved && !/\b(over|allow|exceed|above|anyway)\b/.test(lower)) { this.speak(s, `That version is ${money(p.total - state.bookingBudget(s))} over your ${money(state.bookingBudget(s))} ceiling. Say "go over" to take it anyway, or "keep" to stay.`); return true; }
      if (p.over) s.overApproved = true;
      return this.applyProposal(s, p);
    }
    if (s.options.length) {
      const pick = /upgrade/.test(lower) ? s.options.find(o => o.kind === 'upgrade') : /save more|cheaper/.test(lower) ? s.options.find(o => o.kind === 'save-more') : /our pick|first/.test(lower) ? s.options.find(o => o.kind === 'our-pick') : /^(?:option\s*)?([abc])\b/.test(lower) ? s.options['abc'.indexOf(lower.match(/^(?:option\s*)?([abc])\b/)[1])] : null;
      if (pick) return this.chooseOption(s, pick.kind);
    }
    if (pending) return false; // the answer was to a question; let the updates handle it
    this.speak(s, 'Nothing is waiting for your approval right now. Tell me what to change, or say "book it" when the canvas is right.');
    return true;
  }

  decline(s, pending) {
    if (s.proposal) {
      const p = s.proposal;
      s.proposal = null;
      this.speak(s, p.kind === 'switch' ? `Kept your first option at ${money(s.current.total)}. The better one stays in your options if you change your mind.` : `Kept your trip as it is${p.delta < 0 ? `, at ${money(s.current.total)}` : ''}.`);
      return true;
    }
    if (pending === 'options' && s.current) { this.speak(s, `Kept your trip as it is, at ${money(s.current.total)}.`); return true; }
    if (s.options.length && !pending) { this.speak(s, `Kept our pick at ${money(s.current ? s.current.total : 0)}.`); return true; }
    return false;
  }

  async chooseOption(s, kind) {
    if (typeof kind === 'string' && /^[A-C]$/.test(kind) && s.compromises && s.compromises.length) {
      const c = s.compromises.find(x => x.letter === kind);
      if (!c) { this.speak(s, 'That option is not on the table any more.'); return true; }
      s.compromises = [];
      return this.applyProposal(s, { kind: 'cheaper', token: c.token, total: c.total, delta: s.current ? c.total - s.current.total : 0, label: c.label, over: false, relax: c.key || null });
    }
    const o = typeof kind === 'string' ? s.options.find(x => x.kind === kind) : kind;
    if (!o) { this.speak(s, 'That option is not on the table any more.'); return true; }
    if (s.current && s.current.token === o.token) { this.speak(s, `${o.label} is already your current trip.`); return true; }
    return this.applyProposal(s, { kind: 'option', token: o.token, total: o.total, delta: s.current ? o.total - s.current.total : 0, label: o.label, over: !!o.over });
  }

  async applyProposal(s, p) {
    const before = s.current ? await this.priceToken(s.current.token) : null;
    const after = await this.priceToken(p.token);
    if (!after) { s.proposal = null; this.speak(s, 'That version is no longer available from the suppliers, so I did not switch. Your trip is unchanged.'); return true; }
    if (p.relax) this.applyRelax(s, p.relax);
    const q = state.toQuery(s, { maps: this.maps }).query;
    const ctx = state.budgetContext(s, q);
    s.current = { token: p.token, total: after.total, since: this.now().toISOString() };
    s.proposal = null;
    if (p.nights) s.nights = p.nights;
    if (p.challengedAccepted) s.challenged[p.kind] = true;
    const c = tripCard(after, p.token, ctx);
    if (before) {
      const ch = classifyChanges(before, after);
      this.speak(s, `Done. Before ${money(before.total)} → after ${money(after.total)} (${after.total <= before.total ? `you keep ${money(before.total - after.total)} more` : `${money(after.total - before.total)} more`}).${ch.tradeoffs.length ? ` You gave up: ${joinAnd(changeWords(ch.tradeoffs))}.` : ' Nothing given up.'}`,
        { kind: 'diff', before: tripCard(before, encodeSpec(before.spec), ctx), after: c, improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), lines: lineDiff(before, after) });
    } else {
      this.speak(s, `Your trip: ${c.summary}, ${money(c.total)}.`, { kind: 'trip', trip: c, label: p.label || 'Your trip' });
    }
    return true;
  }

  // ---- the tool router's answers --------------------------------------------------------------
  async makeCheaper(s, cur, cheaperBy) {
    const t = cur.trip, ctx = cur.ctx;
    const settings = await this.settings();
    const target = cheaperBy ? t.total - cheaperBy : t.total - 1;
    const locks = s.locks;
    if (target < 10000) { this.speak(s, `${money(cheaperBy)} off would take the trip under ${money(10000)}; nothing we sell is that cheap. Name a smaller amount.`); return; }
    const out = decision.nameYourPrice(this.inv, t, settings, ctx, target, { now: this.now(), locks });
    const lockNote = state.lockedWords(s).length ? ` (${state.lockedWords(s).join(', ').toLowerCase()} locked, as you asked)` : '';
    const words = c => joinAnd(changeWords(c.changes.tradeoffs.concat(c.changes.neutral))) || 'the same trip';
    if (cheaperBy) {
      if (out.recommended) {
        const c = out.recommended;
        this.propose(s, { kind: 'cheaper', token: encodeSpec(c.trip.spec), total: c.total, delta: c.total - t.total, label: 'Cheaper version', improvements: changeWords(c.changes.improvements), tradeoffs: changeWords(c.changes.tradeoffs), neutral: changeWords(c.changes.neutral), over: false },
          `I can take ${money(t.total - c.total)} off${lockNote}: ${words(c)}. New total ${money(c.total)}, still a strong trip. Take it, or keep what you have.`);
        return;
      }
      if (out.anyway) {
        const a = out.anyway, f = out.floor;
        const anyway = { token: encodeSpec(a.trip.spec), total: a.total, delta: a.total - t.total, label: `${money(a.total)} version`, compromises: a.compromises.map(c => c.text) };
        if (f && f.total < t.total) {
          this.propose(s, { kind: 'cheaper', token: encodeSpec(f.trip.spec), total: f.total, delta: f.total - t.total, label: 'Cheapest version I would still recommend', improvements: changeWords(f.changes.improvements), tradeoffs: changeWords(f.changes.tradeoffs), neutral: changeWords(f.changes.neutral), over: false, anyway },
            `I can only reach ${money(target)} by giving something up: ${joinAnd(anyway.compromises) || words(a)}. I would stop at ${money(f.total)} (${words(f)}), which saves ${money(t.total - f.total)}${lockNote}. Take the ${money(f.total)} version, say "do it anyway" for ${money(a.total)}, or keep what you have.`);
        } else {
          this.propose(s, { kind: 'cheaper', token: anyway.token, total: anyway.total, delta: anyway.delta, label: anyway.label, improvements: changeWords(a.changes.improvements), tradeoffs: changeWords(a.changes.tradeoffs), neutral: changeWords(a.changes.neutral), over: false, challenged: true },
            `I can reach ${money(a.total)}, but only by giving something up: ${joinAnd(anyway.compromises) || words(a)}. I would not recommend it. Take it anyway, or keep what you have${lockNote}.`);
        }
        return;
      }
      const menu = this.oneMoreCompromise(s, cur, target, settings);
      if (menu.length) {
        const floorOpt = out.floor && out.floor.total < t.total ? { key: null, short: `Stop at ${money(out.floor.total)}, nothing given up`, label: `Stop at ${money(out.floor.total)}, nothing given up`, total: out.floor.total, token: encodeSpec(out.floor.trip.spec) } : null;
        s.compromises = [...menu.slice(0, floorOpt ? 2 : 3), ...(floorOpt ? [floorOpt] : [])].map((m, i) => ({ key: m.key, short: m.short, label: m.label, total: m.total, token: m.token, letter: 'ABC'[i] }));
        s.pending = 'options';
        const more = s.compromises.some(c => c.key && c.label !== c.short);
        this.speak(s, `${floorOpt ? `Without giving anything up I can get it to ${money(out.floor.total)}${lockNote}, not ${money(target)}. ` : `I can't find ${money(cheaperBy)} without breaking what you asked for${lockNote}. `}To reach ${money(target)} I need one more compromise: ${s.compromises.filter(c => c.key).map(c => `${c.letter}. ${c.short}: ${money(c.total)}`).join('; ')}. Which one do you prefer?${more ? ' Each button says everything that version gives up.' : ''}${floorOpt ? ` Or ${floorOpt.short.toLowerCase()} (${s.compromises[s.compromises.length - 1].letter}).` : ''} You can also keep what you have.`,
          { kind: 'ask', options: [...s.compromises.map(c => ({ label: `${c.letter}. ${c.label} · ${money(c.total)}`, say: `Option ${c.letter}` })), { label: 'Keep what I have', say: 'Keep what I have' }] });
        return;
      }
      this.speak(s, out.floor && out.floor.total < t.total
        ? `I can't find ${money(cheaperBy)} without breaking what you asked for${lockNote}. The most I can take off is ${money(t.total - out.floor.total)} (${words(out.floor)}). Say "take it" for that version.`
        : `I can't find ${money(cheaperBy)} without breaking what you asked for${lockNote}. There is no cheaper version of this trip in what suppliers returned that I would recommend. Keep what you have, or unlock something.`);
      if (out.floor && out.floor.total < t.total) s.proposal = { kind: 'cheaper', token: encodeSpec(out.floor.trip.spec), total: out.floor.total, delta: out.floor.total - t.total, label: 'Cheapest version I would still recommend', improvements: changeWords(out.floor.changes.improvements), tradeoffs: changeWords(out.floor.changes.tradeoffs), neutral: changeWords(out.floor.changes.neutral), over: false };
      return;
    }
    const f = out.floor;
    if (f && f.total < t.total) {
      this.propose(s, { kind: 'cheaper', token: encodeSpec(f.trip.spec), total: f.total, delta: f.total - t.total, label: 'Cheapest version I would still recommend', improvements: changeWords(f.changes.improvements), tradeoffs: changeWords(f.changes.tradeoffs), neutral: changeWords(f.changes.neutral), over: false },
        `The cheapest version I would still recommend is ${money(f.total)}, ${money(t.total - f.total)} less${lockNote}: ${words(f)}. Take it, or keep what you have.`);
      return;
    }
    const a = out.cheapest;
    this.speak(s, a && a.total < t.total
      ? `You are already at the cheapest version I would recommend${lockNote}. Going lower means ${joinAnd(a.compromises.map(c => c.text)) || words(a)} for ${money(a.total)}; say "take $${Math.round((t.total - a.total) / 100)} back" if you want that trade.`
      : `This is already the cheapest version of this trip in what suppliers returned${lockNote}. To go lower, unlock something or change the destination.`);
  }

  // One rule or lock relaxed at a time, each priced: the single changes that would reach the target.
  // Nothing is offered that was not priced, and the traveler picks the compromise, never the agent.
  oneMoreCompromise(s, cur, target, settings) {
    const t = cur.trip, ctx = cur.ctx, locks = s.locks;
    const rules = ctx.rules || {};
    const cands = [];
    if (rules.nonstop) cands.push({ key: 'nonstop', label: 'Allow one connection', ctx: { ...ctx, rules: { ...rules, nonstop: false } }, locks: { ...locks, flight: false } });
    else if (locks.flight) cands.push({ key: 'flight', label: 'Change the flights', ctx, locks: { ...locks, flight: false } });
    if (rules.minStars) cands.push({ key: 'stars', label: `Allow a hotel under ${rules.minStars} stars`, ctx: { ...ctx, rules: { ...rules, minStars: 0 } }, locks });
    if (locks.hotel) cands.push({ key: 'hotel', label: 'Change the hotel', ctx, locks: { ...locks, hotel: false } });
    if (locks.dates) cands.push({ key: 'dates', label: 'Move the dates by a day or two', ctx, locks: { ...locks, dates: false } });
    if (locks.nights && !locks.dates) cands.push({ key: 'nights', label: 'Fewer nights', ctx, locks: { ...locks, nights: false } });
    const out = [];
    for (const c of cands) {
      // First with the nights held, so the relaxed rule is the only compromise; failing that, with
      // the nights lever back, and whatever else is given up named in the label so "one more"
      // never hides a second one.
      let hit = null, extra = [];
      for (const hold of [true, false]) {
        if (!hold && (c.key === 'nights' || locks.nights)) break;
        const r = decision.nameYourPrice(this.inv, t, settings, c.ctx, target, { now: this.now(), locks: hold && c.key !== 'nights' ? { ...c.locks, nights: true } : c.locks });
        hit = r.recommended && r.recommended.total <= target ? r.recommended : r.anyway && r.anyway.total <= target ? r.anyway : null;
        if (hit) {
          // Everything else this version gives up, in words, so the choice is made with open eyes:
          // the compromises the pricer names, then any other tradeoff against the current trip
          // except the relaxed rule itself and what follows from a shorter stay.
          const own = c.key === 'nonstop' || c.key === 'flight' ? /^flights:/ : c.key === 'stars' || c.key === 'hotel' ? /^hotel:/ : /^$/;
          const comp = hit === r.anyway ? (hit.compromises || []).map(x => x.text) : [];
          const shorter = comp.some(x => /night/.test(x));
          extra = [...comp, ...changeWords(hit.changes.tradeoffs).filter(w => !own.test(w) && !(shorter && /^(length|usable vacation time):/.test(w)))];
          break;
        }
      }
      if (!hit) continue;
      out.push({ key: c.key, short: c.label, label: extra.length ? `${c.label}, plus ${joinAnd(extra)}` : c.label, total: hit.total, token: encodeSpec(hit.trip.spec) });
    }
    return out.sort((a, b) => b.total - a.total);
  }

  // The rule or lock a chosen compromise lifts, by the traveler's own choice and nothing else.
  applyRelax(s, key) {
    if (key === 'nonstop') { s.flightStops = 'any'; s.flightRule = null; }
    else if (key === 'stars') s.hotelRules.minStars = null;
    else if (['hotel', 'flight', 'dates', 'nights'].includes(key)) s.locks[key] = false;
  }

  async makeBetter(s, cur, moreBy) {
    const t = cur.trip, ctx = cur.ctx;
    const settings = await this.settings();
    const budget = state.bookingBudget(s);
    const cap = moreBy ? t.total + moreBy : Math.max(t.total, budget || t.total);
    const room = budget ? budget - t.total : 0;
    const best = decision.optimizeAround(this.inv, t, settings, ctx, { locks: s.locks, cap, now: this.now() });
    if (!best) {
      this.speak(s, moreBy
        ? `I don't see a strong reason to spend another ${money(moreBy)}: nothing I priced within it improves on what you have without giving something up. Keep it.`
        : room > 0 ? `I don't see a strong reason to spend the remaining ${money(room)}: nothing I priced improves on this trip without giving something up. Keep the money.` : `Nothing I priced at this money improves on what you have without giving something up. This is the strong version.`);
      return;
    }
    const over = budget ? best.trip.total > budget : false;
    this.propose(s, { kind: 'better', token: encodeSpec(best.trip.spec), total: best.trip.total, delta: best.delta, label: 'Better version', improvements: changeWords(best.improvements), tradeoffs: changeWords(best.tradeoffs), neutral: changeWords(best.changes), over },
      `${best.delta > 0 ? `For ${money(best.delta)} more` : 'For the same money'} you get ${joinAnd(changeWords(best.improvements))}.${best.tradeoffs.length ? ` You give up ${joinAnd(changeWords(best.tradeoffs))}.` : ' Nothing given up.'} Total ${money(best.trip.total)}${over ? `, ${money(best.trip.total - budget)} over your ceiling` : budget ? `, ${money(budget - best.trip.total)} under your limit` : ''}. Take it, or keep the ${money(best.delta > 0 ? best.delta : room)}.`);
  }

  async changeNights(s, cur, delta) {
    const t = cur.trip;
    const n = t.spec.nights + delta;
    if (s.locks.nights || s.locks.dates) { this.speak(s, `The ${s.locks.nights ? 'length' : 'dates'} are locked, so I did not change them. Unlock them if you want ${plural(n, 'night')}.`); return; }
    const opt = cur.options.nights.find(x => x.nights === n);
    if (!opt) { this.speak(s, n > 14 || n < 2 ? `${plural(n, 'night')} is outside what I can build (2 to 14).` : `The hotel has no availability for ${plural(n, 'night')} on these dates, so I can't price it.`); return; }
    const spec = { ...t.spec, nights: n };
    const budget = state.bookingBudget(s);
    const over = budget ? opt.total > budget : false;
    this.propose(s, { kind: 'nights', nights: n, token: encodeSpec(spec), total: opt.total, delta: opt.delta, label: `${plural(n, 'night')}`, improvements: delta > 0 ? [`length: ${plural(t.spec.nights, 'night')} → ${plural(n, 'night')}`] : [], tradeoffs: delta < 0 ? [`length: ${plural(t.spec.nights, 'night')} → ${plural(n, 'night')}`] : [], neutral: [], over },
      `${delta > 0 ? 'One more night' : 'One night less'} is ${opt.delta >= 0 ? `+${money(opt.delta)}` : `−${money(-opt.delta)}`}: ${plural(n, 'night')} for ${money(opt.total)}${over ? `, which is ${money(opt.total - budget)} over your ${money(budget)} ceiling` : budget ? `, ${money(budget - opt.total)} under your limit` : ''}. ${over ? 'Say "go over" to take it, or keep the current length.' : 'Take it, or keep the current length.'}`);
  }

  async nonstopFlow(s, cur) {
    const t = cur.trip;
    if (t.flight.stops === 0) { this.speak(s, 'Your flights are already nonstop. Rule kept: I will never show you a connection unless you say so.'); return; }
    const ns = cur.options.flights.filter(f => f.flight.stops === 0).sort((a, b) => a.total - b.total)[0];
    if (!ns) {
      this.speak(s, `No nonstop flights on ${this.maps.getOrigin(s.origin).city} to ${t.dest.name} in what the airlines returned. I kept the rule and I am rebuilding somewhere it holds.`);
      await this.startBuild(s, { previous: s.current.token, reason: 'rebuild' });
      return;
    }
    const budget = state.bookingBudget(s);
    const over = budget ? ns.total > budget : false;
    this.propose(s, { kind: 'flight', token: encodeSpec({ ...t.spec, flight: ns.flight.id }), total: ns.total, delta: ns.delta, label: 'Nonstop flights', improvements: [`flights: ${flightWords(t.flight)} → ${flightWords(ns.flight)}`], tradeoffs: [], neutral: [], over },
      `Nonstop is ${ns.delta >= 0 ? `+${money(ns.delta)}` : `−${money(-ns.delta)}`}: ${flightWords(ns.flight)}, total ${money(ns.total)}${over ? `, ${money(ns.total - budget)} over your ceiling` : ''}. Rule kept either way. ${over ? 'Say "go over" to take it.' : 'Take it, or keep the current flights.'}`);
  }

  async stopSaves(s, cur) {
    const t = cur.trip;
    const withStop = cur.options.flights.filter(f => f.flight.stops > 0).sort((a, b) => a.total - b.total)[0];
    const nonstop = cur.options.flights.filter(f => f.flight.stops === 0).sort((a, b) => a.total - b.total)[0];
    if (t.flight.stops === 0) {
      if (!withStop) { this.speak(s, 'There is no one-stop option on this route in what the airlines returned, so there is nothing to save there.'); return; }
      this.speak(s, `One stop saves ${money(-withStop.delta)}: ${flightWords(withStop.flight)} instead of ${hm(t.flight.durationMinutes)} nonstop, total ${money(withStop.total)}. ${s.flightRule === 'hard' ? 'Your rule is nonstop only, so I will not switch unless you say "allow one stop".' : 'Say "take the one stop" if you want it.'}`);
      if (s.flightRule !== 'hard') s.proposal = { kind: 'flight', token: encodeSpec({ ...t.spec, flight: withStop.flight.id }), total: withStop.total, delta: withStop.delta, label: 'One-stop flights', improvements: [], tradeoffs: [`flights: ${flightWords(t.flight)} → ${flightWords(withStop.flight)}`], neutral: [], over: false };
      return;
    }
    this.speak(s, nonstop
      ? `You are on ${flightWords(t.flight)}. Nonstop would be ${nonstop.delta >= 0 ? `+${money(nonstop.delta)}` : `−${money(-nonstop.delta)}`} (${hm(nonstop.flight.durationMinutes)} each way). Say "only nonstop" to switch.`
      : `You are on ${flightWords(t.flight)}, and there is no nonstop option on this route in what the airlines returned.`);
  }

  // Easier means fewer moving parts, not a different trip: the same hotel, dates and length, with
  // nonstop flights and a private transfer, priced in full. Nothing else is touched.
  async makeEasier(s, cur) {
    const t = cur.trip, ctx = cur.ctx;
    const settings = await this.settings();
    const budget = state.bookingBudget(s);
    if (t.flight.stops === 0 && t.transfer) { this.speak(s, 'This is already the easy version: nonstop flights and a private transfer both ways. Fewer moving parts than this would mean fewer experiences, which I can remove if you like.'); return; }
    const nonstop = t.flight.stops === 0 ? t.flight : cur.options.flights.filter(f => f.flight.stops === 0 && !s.locks.flight).sort((a, b) => a.total - b.total).map(f => f.flight)[0] || null;
    const spec = { ...t.spec, flight: nonstop ? nonstop.id : t.spec.flight, transfer: true };
    const p = priceTrip(this.inv, spec, settings);
    if (!p || encodeSpec(p.spec) === s.current.token) { this.speak(s, `I can't make this easier here: ${!nonstop ? `there is no nonstop flight on this route in what the airlines returned${s.locks.flight ? ' that your flight lock allows' : ''}` : 'the transfer could not be priced'}. Say "try another country" and I will look where it is easier.`); return; }
    const ch = classifyChanges(t, p);
    const over = budget ? p.total > budget : false;
    const what = [nonstop && t.flight.stops > 0 ? 'nonstop flights' : null, !t.transfer ? 'a private transfer both ways' : null].filter(Boolean);
    this.propose(s, { kind: 'easier', token: encodeSpec(p.spec), total: p.total, delta: p.total - t.total, label: 'Easier version', improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over },
      `Easier: ${joinAnd(what)}, same hotel and dates, ${p.total > t.total ? `for ${money(p.total - t.total)} more` : p.total < t.total ? `and ${money(t.total - p.total)} less` : 'for the same money'} (total ${money(p.total)}${over ? `, ${money(p.total - budget)} over your ceiling` : ''}). ${over ? 'Say "go over" to take it, or keep what you have.' : 'Take it, or keep what you have.'}`);
  }

  theCatch(s, cur) {
    const t = cur.trip;
    const v = decision.verdict(t, cur.ctx, cur.scores);
    const cons = v.compromises.map(c => c.text);
    const all = (cons.length ? cons : optimizer.tradeoffs(t, cur.ctx)).slice(0, 6);
    this.speak(s, all.length ? `The catch, from the facts: ${joinAnd(all)}.${v.compromise ? ` The one that matters most: ${v.compromise}` : ''}` : 'No catch I can find: every part is inside your rules, the price is complete, and nothing you said matters is given up.', all.length ? { kind: 'facts', title: 'What you give up', items: all } : null);
  }

  recommend(s, cur) {
    const ours = s.options.find(o => o.kind === 'our-pick');
    const why = optimizer.whyThisTrip(cur.trip, cur.ctx).slice(0, 3);
    if (ours && s.current && ours.token !== s.current.token) this.speak(s, `I would book our pick: ${ours.summary} for ${money(ours.total)}. Say "take our pick" to switch to it.`);
    else this.speak(s, `I would book what is on your canvas: ${cur.trip.dest.name}, ${money(cur.trip.total)}. ${why.length ? `Because: ${joinAnd(why.map(w => w.charAt(0).toLowerCase() + w.slice(1)))}.` : ''}`, { kind: 'facts', title: 'Why this one', items: why });
  }

  why(s, cur) {
    const why = optimizer.whyThisTrip(cur.trip, cur.ctx);
    this.speak(s, `Why this one: ${joinAnd(why.map(w => w.charAt(0).toLowerCase() + w.slice(1)))}.`, { kind: 'facts', title: 'Why this one', items: why });
  }

  compare(s) {
    if (s.options.length < 2) { this.speak(s, 'There is only one trip to look at right now. Ask me to make it cheaper or better and I will show the two side by side.'); return; }
    this.speak(s, 'Side by side, every difference on one page:', { kind: 'link', href: `/compare?${s.options.map(o => `t=${encodeURIComponent(o.token)}&l=${encodeURIComponent(o.label)}`).join('&')}&b=${Math.round(state.bookingBudget(s) / 100)}`, label: 'Compare your options' });
  }

  async challengeFlow(s, u, cur) {
    const c = s.challenger || (s.challenger = {});
    const total = (u.updates && u.updates.competitorTotal) || c.total || null;
    const dest = s.destination || (cur ? cur.trip.dest.id : null);
    c.total = total;
    if (u.updates && u.updates.competitorTotal) { c.asked = []; c.asking = null; }
    if (!total || !dest || !s.origin) {
      const need = [!total && 'their complete price (taxes and fees included)', !dest && 'the destination', !s.origin && 'where you fly from'].filter(Boolean);
      s.pending = 'challenge';
      this.speak(s, `I will compare like for like and tell you honestly who wins. I still need ${joinAnd(need)}. Say it here, or use the full challenge form for every detail.`, { kind: 'link', href: `/challenge?${new URLSearchParams(Object.entries({ dest: dest || '', total: total ? Math.round(total / 100) : '', from: s.origin || '', nights: s.nights || '' }).filter(([, v]) => v)).toString()}`, label: 'Open the challenge form' });
      return;
    }
    // What is shared between the trip they are planning and the one they found: the place, the
    // origin, the party, the length and (when their dates are fixed) the dates. Everything about the
    // found trip's quality comes only from what they told me about it; my own rules become the
    // floor our version must meet, never a claim about theirs.
    const raw = {
      dest, from: s.origin, nights: String(c.nights || s.nights || (cur ? cur.trip.spec.nights : 5)), who: s.who || 'couple', n: String(s.travelers || 2), total: String(Math.round(total / 100)),
      depart: c.depart || (s.dateMode === 'exact' && s.depart ? s.depart : ''), flight: c.flight || '', stars: c.stars ? String(c.stars) : '', meals: c.meals || '', bags: c.bags || '', transfer: c.transfer || '', cancel: c.cancel || '', taxes: c.taxes || '',
      lock: [s.flightStops === 'nonstop' && s.flightRule === 'hard' ? 'nonstop' : null, s.locks.nights ? 'nights' : null, s.locks.dest ? 'dest' : null].filter(Boolean),
    };
    const { challenger: ch, missing } = challenge.parseChallenger(raw, { maps: this.maps, now: this.now() });
    if (missing.length) { this.speak(s, `I can't compare yet: ${joinAnd(missing)} missing.`); return; }
    const mode = /\b(better|same money|improve)\b/.test((u.text || '').toLowerCase()) ? 'better' : 'less';
    const out = challenge.runChallenge(this.inv, ch, await this.settings(), { mode, now: this.now() });
    const href = `/challenge/result?${challenge.challengerParams(ch, { mode })}`;
    const v = out.verdict;
    const ours = out.ours ? tripCard(out.ours, encodeSpec(out.ours.spec), out.ctx) : null;
    const unknownWords = (v.unknowns || []).map(k => challenge.UNKNOWN_LABELS[k] || k);
    const toAsk = (v.unknowns || []).filter(k => !(c.asked || []).includes(k));
    let text;
    if (v.state === 'beat') text = `We beat it, like for like: ${ours.summary} for ${money(ours.total)} against their ${money(ch.total)}, so ${money(ch.total - ours.total)} stays with you. Everything their trip is known to include is in ours.`;
    else if (v.state === 'tradeoff') text = `We found a different trade-off, not a clean win: ${ours.summary} for ${money(ours.total)} against their ${money(ch.total)}. ${v.different.length ? `Different: ${joinAnd(v.different)}.` : ''} ${v.downs.length ? `Theirs is better on ${joinAnd(v.downs)}.` : ''} You decide.`;
    else if (v.state === 'info') text = `${ours ? `Our closest like-for-like version is ${money(ours.total)} against their ${money(ch.total)}, but I` : 'I'} won't claim a win with unknowns. About their trip I don't know ${joinAnd(unknownWords)}.${toAsk.length ? ' One question at a time:' : ' With those unknown, that is as far as an honest comparison goes; the full comparison shows the paper difference line by line.'}`;
    else text = `Your deal wins. ${out.cheapest ? `The same trip costs ${money(out.cheapest.total)} with us` : 'I could not build the same trip'}, which does not beat ${money(ch.total)}. Keep your current deal.`;
    this.speak(s, text, { kind: 'verdict', state: v.state, ours, theirs: ch.total, href, unknowns: unknownWords });
    if (ours && v.state !== 'keep' && (!s.current || s.current.token !== ours.token)) s.proposal = { kind: 'challenge', token: ours.token, total: ours.total, delta: s.current ? ours.total - s.current.total : 0, label: 'Our challenger', improvements: v.ups || [], tradeoffs: v.downs || [], neutral: v.different || [], over: false };
    if (v.state === 'info' && toAsk.length) this.askTheirs(s, THEIRS_ORDER.find(k => toAsk.includes(k)) || toAsk[0]);
  }

  // One question about the trip they found, with the answers as buttons. "Don't know" is an answer.
  askTheirs(s, key) {
    const c = s.challenger;
    const q = THEIRS_QUESTIONS[key];
    c.asking = key;
    s.pending = 'theirs';
    this.speak(s, typeof q.text === 'function' ? q.text(c) : q.text, { kind: 'ask', options: [...q.options.map(([label, say]) => ({ label, say })), ['Don’t know', 'Don’t know'], ['That’s all I know, compare now', 'That’s all I know']].map(o => (Array.isArray(o) ? { label: o[0], say: o[1] } : o)) });
  }

  // An answer about their trip: record what was said, skip what they don't know, then ask the next
  // thing or run the comparison. Their facts never become rules on the traveler's own trip.
  async theirsFlow(s, t) {
    const c = s.challenger || (s.challenger = {});
    c.asked = c.asked || [];
    const got = [];
    for (const k of ['stars', 'meals', 'bags', 'transfer', 'cancel', 'taxes', 'flight', 'depart', 'nights']) if (t[k] !== undefined && t[k] !== null) { c[k] = t[k]; got.push(k); }
    if (t.skip && c.asking) c.asked.push(c.asking);
    const said = got.map(k => THEIRS_WORDS[k] ? THEIRS_WORDS[k](c[k]) : `${k}: ${c[k]}`);
    const ackText = said.length ? `Got it about their trip: ${joinAnd(said)}.` : t.skip ? 'Fine, that stays unknown.' : null;
    const known = k => (k === 'dates' ? !!c.depart : k === 'stars' ? !!c.stars : !!c[k]);
    const open = Object.keys(challenge.UNKNOWN_LABELS).filter(k => !known(k) && !c.asked.includes(k));
    const cur = s.current ? await this.currentTrip(s) : null;
    if (t.done || !open.length) {
      if (ackText) this.speak(s, ackText);
      c.asking = null;
      // "That's all I know": whatever is still open stays unknown and is not asked again; the
      // verdict then says plainly how far an honest comparison goes.
      if (t.done) for (const k of open) if (!c.asked.includes(k)) c.asked.push(k);
      await this.challengeFlow(s, { updates: {}, text: '' }, cur);
      return;
    }
    const next = THEIRS_ORDER.find(k => open.includes(k)) || open[0];
    if (ackText) this.speak(s, ackText);
    this.askTheirs(s, next);
  }

  async bookFlow(s, cur) {
    if (!cur) { this.speak(s, 'There is nothing on the canvas to book yet. Tell me what you want and I will build it first.'); return; }
    if (s.proposal) { this.speak(s, 'There is a proposal waiting. Take it or keep your trip first, so you book exactly what you see.'); return; }
    const t = cur.trip;
    const q = cur.q;
    const budget = state.bookingBudget(s);
    const c = tripCard(t, s.current.token, cur.ctx);
    const getting = [
      ['Trip', `${plural(t.spec.nights, 'night')} in ${t.dest.name}, ${t.dest.country}`],
      ['Dates', `${longDate(t.spec.depart)} to ${longDate(t.flight.return)}`],
      ['Travelers', String(t.spec.travelers)],
      ['Flights', flightWords(t.flight)],
      ['Hotel', hotelWords(t.hotel)],
      ['Experiences', t.activities.length ? t.activities.map(a => a.name).join(', ') : 'None'],
      ['Transfer', t.transfer ? 'Private, both ways' : 'Not included'],
      ['Total, everything included', money(t.total)],
      [budget ? (t.total <= budget ? 'Under your limit by' : 'Over your limit by') : 'Limit', budget ? money(Math.abs(budget - t.total)) : 'Not set'],
    ];
    const cx = optimizer.contextParams(cur.ctx, { seen: t.total });
    const unmet = this.unmet(s, t);
    this.speak(s, `${unmet.length ? `Before you book, one thing is not what you asked for: ${joinAnd(unmet)}. ` : ''}Here is what you asked for against what you are getting. I don't charge anything: the next page re-checks the live price, and you confirm there.`, { kind: 'contract', asked: state.askedFor(s, { maps: this.maps }), getting, href: `/trip/${s.current.token}/review?${cx}`, trip: c, unmet });
  }

  // What the current trip does not satisfy of the rules the traveler stated. Never silent.
  unmet(s, t) {
    const out = [];
    if (s.flightStops === 'nonstop' && s.flightRule === 'hard' && t.flight.stops > 0) out.push('the flights are not nonstop');
    if (s.hotelRules.minStars && t.hotel.stars < s.hotelRules.minStars) out.push(`the hotel is ${t.hotel.stars}-star, not ${s.hotelRules.minStars}-star`);
    if (s.hotelRules.allInclusive && !t.hotel.features.allInclusive) out.push('the hotel is not all-inclusive');
    if (s.hotelRules.breakfast && !t.hotel.features.breakfast && !t.hotel.features.allInclusive) out.push('breakfast is not included');
    if (s.hotelRules.beachfront && !t.hotel.features.beachfront) out.push('the hotel is not beachfront');
    if (s.transfer && !t.transfer) out.push('no airport transfer is included');
    if (s.nights && t.spec.nights !== s.nights) out.push(`${plural(t.spec.nights, 'night')} instead of ${s.nights}`);
    const budget = state.bookingBudget(s);
    if (budget && t.total > budget) out.push(`the total is ${money(t.total - budget)} over your ceiling`);
    return out;
  }

  // Questions a traveler asks before booking, answered from the trip's own facts, or with "I don't know".
  generalAnswer(s, kind, cur) {
    const t = cur ? cur.trip : null;
    if (kind === 'next') {
      this.speak(s, t ? `Next is yours to decide: say "book it" and I show you what you asked for against what you are getting, then the trip page re-checks the live price and you confirm. Or keep changing it: cheaper, better, a different place.` : 'Next: tell me a budget and where you fly from, and I build the first trip.');
      return;
    }
    if (kind === 'cancelInfo') {
      if (!t) { this.speak(s, 'Cancellation terms belong to a specific trip. Build one and I will read you its terms, part by part, with the dates that apply.'); return; }
      const terms = t.policies.map(p => `${p.component}: ${p.text}`);
      this.speak(s, 'Each part keeps its own terms; here they are as the suppliers state them. Where a supplier has not stated a cutoff, it needs verification, and I will not guess it.', { kind: 'facts', title: 'Cancellation, part by part', items: terms, href: `/trip/${s.current.token}?${optimizer.contextParams(cur.ctx)}#know`, label: 'Dated cutoffs on the trip page' });
      return;
    }
    if (kind === 'afford') {
      const budget = state.bookingBudget(s);
      this.speak(s, t && budget ? `What I know: this trip is ${money(t.total)} against your ${money(budget)} ceiling, so ${money(Math.max(0, budget - t.total))} is unspent${s.protectedMoney ? `, plus the ${money(s.protectedMoney)} you protected` : ''}. Whether that covers what you have in mind, I don't know yet: I know trip prices, not local costs.` : 'I don\'t know yet. I know the prices of the trips I build, not the cost of what you have in mind. Give me a budget and I can at least say what stays unspent.');
      return;
    }
    if (kind === 'car') {
      this.speak(s, t ? `I don't know yet. What I know: ${t.transfer ? 'a private airport transfer both ways is in this trip' : 'no transfer is in this trip yet (say "add a transfer" and I price one)'}, and the hotel is in ${t.hotel.area}. Whether you need a car depends on what you plan to do there.` : 'I don\'t know yet: it depends on the trip and what you plan to do there. Build the trip first and I will tell you what is in it.');
      return;
    }
    if (kind === 'flightChange') {
      this.speak(s, t ? `If the airline changes the schedule, the airline's own rules apply and we tell you by email. This fare: ${t.flight.name}, ${t.flight.refundable ? 'refundable' : 'not refundable after 24 hours'}. I never rebook on my own; any change needs your approval first.` : 'Airline schedule changes follow the airline\'s own rules for the fare you book; we tell you by email, and nothing is rebooked without your approval. Build a trip and I will read you its fare rules.');
    }
  }

  // ---- after booking: the same agent, answering from the booking's facts ------------------------
  async bookingAnswer(s, kind, u) {
    const b = await this.store.getBookingByRef(s.booking.ref);
    if (!b) { this.speak(s, 'I can’t find that booking any more.'); return; }
    const t = b.quote.trip;
    const now = this.now();
    if (kind === 'next') {
      const spec = decodeSpec(t.token);
      const priced = await this.priceToken(t.token);
      const guide = priced ? decision.tripGuide(priced, { origin: this.maps.airport(spec.from) }) : null;
      const first = guide ? guide.steps.slice(0, 3).map(st => `${st.title}: ${st.lines[0] ? st.lines[0].text : ''}`) : [];
      const days = Math.ceil((Date.parse(`${t.spec.depart}T00:00:00Z`) - now.getTime()) / 86400000);
      this.speak(s, `${days > 0 ? `${plural(days, 'day')} to go. ` : ''}Your trip is ${b.status.replace(/_/g, ' ')}; nothing is due from you right now${b.status === 'confirmed' ? ' beyond having your documents ready' : ''}. The step-by-step guide covers the rest.`, { kind: 'facts', title: 'Next', items: first, href: `/trip/${t.token}/guide`, label: 'Open the step-by-step guide' });
      return;
    }
    if (kind === 'cancelInfo') {
      const p = this.svc.bookingProvider().cancellationPreview(b, now);
      if (!p.allowed) { this.speak(s, `Cancelling is not possible from here right now: ${p.reason}`); return; }
      const next = p.nextCutoff ? ` The next cutoff is ${p.nextCutoff.component}, ${p.nextCutoff.cutoff.slice(0, 10)}.` : '';
      this.speak(s, `If you cancel now you get ${money(p.refundAmount)} back of the ${money((b.payment && b.payment.amount) || b.total)} you paid. ${p.policy}${next} Nothing is cancelled unless you do it yourself on the booking page.`, { kind: 'facts', title: 'Refund by part', items: p.breakdown.map(x => `${x.component}: ${money(x.amount)}`), href: `/booking/${b.ref}`, label: 'Open the booking page' });
      return;
    }
    if (kind === 'extend') {
      const spec = decodeSpec(t.token);
      const longer = priceTrip(this.inv, { ...spec, nights: spec.nights + 1 }, await this.settings());
      this.speak(s, longer
        ? `One more night at ${t.hotel.name} prices today at ${money(longer.total - b.total)} more for the whole trip (flights move a day, so the fare is re-priced too). I can't change a confirmed booking myself: send a message on the booking page and our team arranges it, and nothing changes until you confirm the new price.`
        : `I can't price an extra night: the hotel or the flights have no availability for ${plural(spec.nights + 1, 'night')} in what suppliers returned. Our team can check by hand from the booking page.`, { kind: 'link', href: `/booking/${b.ref}#message`, label: 'Message the team' });
      return;
    }
    if (kind === 'afford') {
      const bud = (b.quote && b.quote.budget) || b.budget || null;
      const budget = bud && bud.budget;
      const left = budget ? budget - b.total : null;
      this.speak(s, left !== null
        ? `Of the ${money(budget)} you set, ${money(b.total)} is paid and ${money(Math.max(0, left))} is left${bud.keep ? `, plus the ${money(bud.keep)} you protected for the destination` : ''}. Whether that covers what you have in mind I don't know yet: I only know your trip's prices, not local costs.`
        : `I don't know yet: I know your trip's price (${money(b.total)}) but not the cost of what you have in mind, and no budget was set on this booking.`);
      return;
    }
    if (kind === 'car') {
      this.speak(s, `I don't know yet. What I do know: ${t.transfer ? 'a private airport transfer both ways is in your trip' : 'no airport transfer is included'}, and ${t.hotel.area ? `the hotel is in ${t.hotel.area}` : 'the hotel area is on your voucher'}. Whether you need a car depends on what you plan to do; I would rather say that than guess.`);
      return;
    }
    if (kind === 'flightChange') {
      this.speak(s, `If the airline changes your flight, the airline's own rules apply and we tell you by email. Your fare: ${t.flight.name}. ${t.flight.refundable ? 'It is refundable.' : 'It is not refundable after 24 hours.'} I can't rebook anything myself; a change goes through our team and needs your approval first.`);
    }
  }
}

// The words a traveler would say to accept a relaxation, so the no-dead-end buttons go through the
// same understanding as typed text.
function relaxSay(w, q) {
  switch (w.key) {
    case 'dates': return 'My dates are flexible';
    case 'nights': return `${q.nights - 1} nights`;
    case 'nights2': return `${q.nights - 2} nights`;
    case 'style': return 'Any style';
    case 'prio': return 'Price first';
    case 'over': return 'Allow 10% over';
    case 'keep': return `Use $${Math.round(w.used / 100)} of my reserve`;
    case 'nonstop': return 'Allow one stop';
    case 'stars': return 'Any star class';
    default: return w.label;
  }
}

module.exports = { AgentService, tripCard, COMMANDS, relaxSay };
