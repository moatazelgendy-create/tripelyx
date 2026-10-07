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
const strategies = require('../trips/strategies');
const savemax = require('../trips/savemax');
const weeks = require('../trips/weeks');
const hunter = require('../trips/hunter');
const leaks = require('../trips/leaks');
const { HuntService, NOTIFY_KINDS: HUNT_NOTIFY_KINDS, intervalWords } = require('../trips/hunts');
const { classifyChanges, lineDiff } = require('../trips/facts');
const { encodeSpec, decodeSpec } = require('../trips/spec');
const { priceTrip } = require('../trips/pricing');
const { understand, NOT_COMPARED } = require('./understand');
const state = require('./state');
const { JobRunner, breathe, newJob, setStep } = require('./jobs');

const money = c => fmtMoney(c, 'USD');
const dollars = c => `$${Math.round(c / 100).toLocaleString('en-US')}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hm = m => `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}`;
const joinAnd = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const longDate = d => new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const monthWords = m => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
const stampOf = iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const FAST_DESTINATIONS = 4;
const MATERIAL_SAVING = 2500; // $25: a better option must be at least this much cheaper with nothing given up, or clearly stronger for the same money
const DECISION_BAND = 5000;   // $50: two priced trips this close that trade exactly one thing for another are one decision, the traveler's
const DECISION_PRIORITY = { length: 'longer', flights: 'flights', stay: 'hotel' }; // the extras set no priority
const WATCH_DEFAULT = { kind: 'drop', amount: 10000 };
// A hunt's threshold from the conversation: aggressive savers hear of $50 wins, balanced ones of $100.
// It is said with the hunt, never only chosen: "tell me about $50 wins" moves it (THRESHOLD_SAID).
const HUNT_THRESHOLD = { balanced: 10000, aggressive: 5000 };
const THRESHOLD_SAID = /^\s*(?:tell me about|interrupt me for|only tell me about)\s+\$?\s*([\d,]+)\s*(?:dollar\s+)?wins?\s*[.!]*\s*$/i;
// "Not good enough": the five things a hunt can be asked to improve, as chips and as words. An answer
// is a chip, or a short reply that names one of the five and nothing else: a sentence about the trip
// on the canvas ("one night less", "lock the hotel", "keep my money") is never read as a hunt rule,
// so "short", "less" and "money" are not hunt words, and a reply that changes the trip is the trip's.
const IMPROVE_CHIPS = [['Lower price', 'price'], ['Better hotel', 'hotel'], ['More nights', 'nights'], ['Nonstop', 'nonstop'], ['Different destination', 'destination']];
const IMPROVE_WORDS = [['nonstop', /\b(nonstop|non-stop|non stop|direct)\b/], ['nights', /\b(more nights?|longer|extra nights?|another night|more days)\b/], ['hotel', /\b(hotel|stars?|resort|room)\b/], ['destination', /\b(destination|somewhere else|different place|elsewhere|another (?:place|country|city))\b/], ['price', /\b(price|cheaper|cheap|cost|lower|expensive)\b/]];
// A short reply that also reads as one of the canvas's own asks ("cheaper", "try another country": the
// chips under the composer) is the canvas's, since the same words on screen mean that; the hunt has
// its own five chips for the same five things.
const IMPROVE_MAX_WORDS = 3;
const sentences = arr => (arr.length ? ` ${arr.map(x => x.replace(/\.?$/, '.')).join(' ')}` : '');
// The words that name a pending proposal in a reminder ("take ... or keep what you have"): a removal
// ("Without <item>") or an add-back is a version, so it is named as one, never read as if the item
// itself were the thing to take ("take the checked bag" must never mean removing it).
const proposalWords = p => (!p.label ? 'the proposal' : /^(?:without|add back)\b/i.test(p.label) ? `the version ${p.label.toLowerCase().replace(/^add back\b/, 'with').replace(/^with (.+)$/, 'with $1 added back')}` : `the ${p.label.toLowerCase()}`);
// The money leak hunter's asks, each answered from leaks.js on the trip on the canvas; without a trip
// they get the same "nothing on the canvas yet" answer as a price cut would.
const LEAK_INTENTS = ['leakScan', 'biggestLeak', 'leakVersion', 'removeOne', 'strip', 'addBack', 'cutInOrder', 'freeSavings', 'scorecard', 'paying', 'notCompared'];
const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
// The words of an item a chip names ("the transfer", "bags", part of an experience's name): articles
// off, plurals trimmed, and every word must be in the item's key or label; never only its exact label.
const itemWords = want => String(want || '').trim().toLowerCase().replace(/^(?:the|my|a|an|our)\s+/, '').split(/[^a-z0-9]+/i).filter(Boolean).map(w => w.replace(/s$/, ''));
const wordsFit = (words, hay) => words.length > 0 && words.every(w => String(hay).toLowerCase().includes(w));
// An approval that names the version it applies: the lean version, a removal ("remove it", "remove
// $148", "take it out"), the free savings, the trade-off version, the cut, an add-back of one item.
// Such words may apply only a pending proposal of the kind they name (and, with an amount, of that
// saving; with an item, of that item), because the cards stay on the page with their chips while the
// table moves on: "Take the lean version" on an old card must never apply a dearer version that was
// proposed since. Said while another kind waits, they apply nothing, and their own flow (`intent`)
// prices the version named and proposes it again. A bare "take it" or "yes" names nothing and stays
// a plain approval of what the agent last put on the table.
const NAMED_APPROVALS = [
  { re: /^(?:take the lean(?: version)?|strip it)$/, kinds: ['lean'], intent: 'strip', name: () => 'the lean version' },
  { re: /^(?:remove it|take it out)$/, kinds: ['removeOne', 'leak'], intent: 'leakScan', name: () => 'a removal' },
  { re: /^remove \$?([\d,]+(?:\.\d{1,2})?)$/, kinds: ['removeOne', 'leak'], intent: 'leakScan', amount: m => Math.round(Number(m[1].replace(/,/g, '')) * 100), name: (m, amount) => `a ${money(amount)} removal` },
  { re: /^take the free savings$/, kinds: ['free'], intent: 'freeSavings', name: () => 'the free savings' },
  { re: /^take the trade-?off version$/, kinds: ['sacrifice'], intent: 'freeSavings', name: () => 'the trade-off version' },
  { re: /^take the cut(?: version)?$/, kinds: ['cut'], intent: 'cutInOrder', name: () => 'the cut' },
  { re: /^add back (.+)$/, kinds: ['addBack'], intent: 'addBack', item: m => m[1].trim(), name: m => `adding back ${m[1].trim()}` },
];
function namedApproval(text) {
  const lower = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '').trim();
  for (const n of NAMED_APPROVALS) {
    const m = lower.match(n.re);
    if (!m) continue;
    const item = n.item ? n.item(m) : null;
    if (item !== null && /^what(?:'s| is) worth it$/.test(item)) return null; // "add back what's worth it" asks for the list; it names no item
    const amount = n.amount ? n.amount(m) : null;
    return { kinds: n.kinds, intent: n.intent, amount, item, name: n.name(m, amount) };
  }
  return null;
}
// Whether the pending proposal is the one the named words may apply.
const namedFits = (n, p) => !!p && n.kinds.includes(p.kind) && (n.amount === null || p.delta === -n.amount) && (n.item === null || wordsFit(itemWords(n.item), `${p.itemKey || ''} ${p.label || ''}`));

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
// What a priced departure window changes besides its dates (the fare, the flights, the hotel, the
// bags, the cancellation terms), from the pricer's own comparison; empty when it is the same trip.
const windowChanges = w => (w && w.changes ? changeWords([...w.changes.tradeoffs, ...w.changes.neutral, ...w.changes.improvements].filter(r => !['dates', 'time'].includes(r.key))) : []);

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
  constructor({ tripService, store, now = () => new Date(), log = console, hunts = null }) {
    this.svc = tripService;
    this.store = store;
    this.now = now;
    this.log = log;
    // The Savings Hunter (server/trips/hunts.js): hunts live on the account and run outside this
    // conversation. Without it the agent says so instead of pretending to hunt.
    this.hunts = hunts;
    this.jobs = new JobRunner({ log });
    this.breathe = breathe; // how a job yields between phases; tests hold a job here to look at it mid-search
    this.chains = new Map();
    this.discoveryCache = new Map();
  }

  get inv() { return this.svc.inv; }
  get maps() { return this.svc.inv.maps; }

  // ---- persistence: one writer at a time per conversation ----
  async create({ visitor = null, userId = null, booking = null, mission = false, mode = null } = {}) {
    const s = state.newState({ id: makeId('agt'), visitor, userId, now: this.now() });
    if (booking) s.booking = booking;
    if (mission) s.mission = { mode: mode === 'save' ? 'save' : null, startedAt: this.now().toISOString(), accepted: false, signal: null, strategies: [], shown: [], variants: [], chosen: null, round: 0, wrong: [], rounds: 0, fastRound: null };
    // Defaults the traveler approved earlier are applied and always shown, never silently.
    if (userId && !booking) {
      const d = await this.store.getRecord('travel_defaults', userId);
      if (d) { this.applyDefaults(s, d); s.defaults = d; }
    }
    await this.save(s);
    return s;
  }
  applyDefaults(s, d) {
    if (d.origin && !s.origin) s.origin = d.origin;
    if (d.travelers && !s.travelers) { s.travelers = d.travelers; s.who = d.who || null; }
    if (d.flightStops && !s.flightStops) { s.flightStops = d.flightStops; s.flightRule = d.flightRule || null; }
    if (d.minStars && !s.hotelRules.minStars) s.hotelRules.minStars = d.minStars;
    if (d.nights && !s.nights) s.nights = d.nights;
    if (d.bags && !s.bags) s.bags = d.bags;
    if (d.flexibleDates && !s.dateMode) s.dateMode = 'anytime';
    if (d.savingsLevel && !s.savingsLevel) s.savingsLevel = d.savingsLevel;
  }
  defaultsWords(d) {
    const o = d.origin ? this.maps.getOrigin(d.origin) : null;
    return [o ? `from ${o.city}` : null, d.travelers ? plural(d.travelers, 'traveler') : null, d.flexibleDates ? 'flexible dates' : null, d.flightStops === 'nonstop' ? (d.flightRule === 'hard' ? 'nonstop only' : 'nonstop if possible') : null, d.minStars ? `${d.minStars}-star or better` : null, d.nights ? plural(d.nights, 'night') : null, d.bags ? { personal: 'personal item only', 'carry-on': 'carry-on only', checked: 'a checked bag' }[d.bags] : null, d.savingsLevel === 'aggressive' ? 'aggressive savings' : null].filter(Boolean);
  }
  saver(s) { return !!(s.mission && s.mission.mode === 'save'); }
  async load(id) { return (await this.store.getRecord('agent', String(id || '').slice(0, 60))) || null; }
  async save(s) { await this.store.putRecord('agent', s.id, s, { userId: s.userId }); }
  // Whose conversation this is. Once it belongs to an account it is that account's alone, whatever
  // browser cookie comes with the request: a hunt or a watch said here lands on that account, so a
  // browser that signed out, or into another account, is not its owner. Before that, the browser's.
  owns(s, { visitor = null, user = null } = {}) {
    if (!s) return false;
    if (s.userId) return !!(user && user.id === s.userId);
    return !!(visitor && s.visitor === visitor);
  }
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
  // `user` is who the request is signed in as: the account actions (a hunt, a watch) are taken as that
  // person when the conversation is theirs, and refused otherwise; never as an id stored on the record.
  async say(id, text, { user = null } = {}) {
    return this.withState(id, s => this.handle(s, text, { user }));
  }

  // One traveler message: understand, update the trip object, route the asks, answer from facts.
  async handle(s, rawText, { user = null } = {}) {
    const text = String(rawText || '').trim().slice(0, 600);
    if (!text) return s;
    const now = this.now();
    const actor = this.actorFor(s, user);
    state.pushMessage(s, 'user', text, null, now);
    s.turns += 1;
    // The hunt's own sentence about its threshold, answered before the words are read as a trip: an
    // amount here is the saving worth an interruption, never a budget.
    const thr = text.match(THRESHOLD_SAID);
    if (thr) { s.pending = null; await this.thresholdFlow(s, Number(thr[1].replace(/,/g, '')) * 100, actor); return this.afterTurn(s); }
    const u = understand(text, s, { maps: this.maps, now });
    const intents = new Set(u.intents);
    const pending = s.pending;
    s.pending = null;
    // A menu (compromises, breakpoints, a decision, priced weeks) is answered on the next turn or not at all.
    const option = pending === 'options' ? (u.updates.option || (s.decision ? this.decisionByWords(s, text) : null)) : null;
    if (!option) { if (s.compromises && s.compromises.length) s.compromises = []; if (s.breakpoints && s.breakpoints.length) s.breakpoints = []; s.decision = null; s.decisionFacts = null; s.weeks = []; }

    if (intents.has('restart')) return this.restart(s, actor);
    if (intents.has('stop') && !intents.has('keepLooking')) {
      const was = this.jobs.cancel(s.id);
      if (s.job && s.job.status === 'running') { s.job.status = 'cancelled'; s.job.finishedAt = now.toISOString(); s.job.note = 'Stopped at your request.'; }
      // "I'm happy, stop searching": the optional search stops, and the trip on the canvas is laid
      // out for verification; nothing is booked by this.
      if (s.proposal) { this.speak(s, `${was ? 'Stopped the search. ' : ''}One decision is still open on the canvas: take ${proposalWords(s.proposal)} or keep what you have, then say "book it".`); return s; }
      const curNow = s.current ? await this.currentTrip(s) : null;
      this.speak(s, was ? `Stopped the optional search.${curNow ? ' This is your trip; here is what you asked for against what you are getting, then the live price check.' : ' Whatever I had already found stays on your canvas.'}` : curNow ? 'Nothing is running. This is your trip; here is what you asked for against what you are getting, then the live price check.' : 'Nothing is running. Your trip stays as it is.');
      if (curNow) await this.bookFlow(s, curNow);
      return s;
    }
    if (intents.has('remember')) { await this.rememberDefaults(s); return this.afterTurn(s); }
    if (intents.has('forget')) { await this.forgetDefaults(s, /\bforget\b/.test(text.toLowerCase())); return this.afterTurn(s); }
    // The answer to "what should I improve?" changes the hunt's rules, never the trip on the canvas:
    // a bare "Nonstop" here is about the hunt, so it is read before the trip object is touched. Anything
    // that is not one of its answers is about the trip: the question lapses, said in one line, the hunt
    // stands exactly as it was, and the message goes where it would have gone without the question.
    if (pending === 'improve' && this.huntRef(s)) {
      if (await this.improveFlow(s, text, u, actor)) return this.afterTurn(s);
      this.speak(s, 'Left the hunt as it is; that was not one of its answers, so I take it as being about the trip on the canvas.');
    }
    // The two questions a hunt asks before anything is created on the account: whether to hunt without a
    // lock it cannot keep, and what to do with the hunt this conversation already started now that the
    // rules here differ from it. Anything but an answer lets the question lapse, like every menu.
    if (pending === 'huntWithout') { if (await this.huntWithoutFlow(s, text, actor)) return this.afterTurn(s); }
    if (pending === 'huntDiffers') { if (await this.huntDiffersFlow(s, text, actor)) return this.afterTurn(s); }
    // "How much do you want to cut?" lapses with anything but an amount, said in one line: nothing is
    // cut by it, the budget never moves, and the message goes where it would have gone unasked.
    if (pending === 'cutBy' && !intents.has('cutInOrder')) this.speak(s, 'No amount, so nothing is cut. Say "cut $200 in order" whenever you want to.');

    // Answers to what I asked, approvals and declines come first: they are about the thing on the table.
    if (option) { await this.chooseOption(s, option); return this.afterTurn(s); }
    // Words that name a version ("take the lean version", "remove $148", "add back the transfer")
    // apply only a pending proposal of that kind; otherwise they are their own ask, routed below.
    const named = namedApproval(text);
    if ((intents.has('approve') || named) && !intents.has('cheaper') && !intents.has('better')) {
      if (await this.approve(s, text, pending, named)) return this.afterTurn(s);
      if (named) intents.add(named.intent);
    }
    if (intents.has('decline')) {
      if (this.decline(s, pending)) return this.afterTurn(s);
    }
    if (u.updates.theirs) { await this.theirsFlow(s, u.updates.theirs); return this.afterTurn(s); }

    const budgetBefore = state.bookingBudget(s);
    const { rebuild } = state.applyUpdates(s, u.updates, { now });
    const ack = u.ack.length ? `Got it: ${joinAnd(u.ack)}.` : null;
    let handled = false;
    // A mission starts from one number: the agent says what it will do, then asks only what it cannot
    // go without (where you fly from), with any saved defaults stated.
    if (s.mission && !s.mission.accepted && s.budget) {
      s.mission.accepted = true;
      this.speak(s, this.saver(s)
        ? `Mission accepted: ${money(state.vacationBudget(s))} is your maximum, and I'll try not to use it. I'll build the strongest trip I can for well under it, say exactly how I kept the cost down and compared with what, and interrupt you only for a real decision.${s.defaults ? ` Using your saved savings style: ${joinAnd(this.defaultsWords(s.defaults))}. Say "not this time" to drop it.` : ''}`
        : `Mission accepted: ${money(state.vacationBudget(s))} is the ceiling, not a target. I'll find the strongest vacation I can build for it, protect the budget, and only interrupt you when I need a real decision.${s.defaults ? ` Using your saved defaults: ${joinAnd(this.defaultsWords(s.defaults))}. Say "not this time" to drop them.` : ''}`);
    }

    // Post-booking questions, when this conversation is about a booked trip.
    if (s.booking) {
      for (const k of ['next', 'cancelInfo', 'extend', 'afford', 'car', 'flightChange']) if (intents.has(k)) { await this.bookingAnswer(s, k, u); handled = true; }
      if (handled) return this.afterTurn(s);
    }

    const cur = s.current ? await this.currentTrip(s) : null;
    for (const k of ['next', 'cancelInfo', 'afford', 'car', 'flightChange']) if (!handled && intents.has(k)) { this.generalAnswer(s, k, cur); handled = true; }
    if (handled) return this.afterTurn(s);
    // Hunt mode comes before the trip's own asks: "hunt for a better deal" carries the word "better"
    // but asks for a hunt, not a dearer version of the trip.
    if (intents.has('hunt')) { await this.huntFlow(s, u, cur, actor); handled = true; }
    else if (intents.has('stopHunt')) { await this.stopHuntFlow(s, actor); handled = true; }
    else if (intents.has('notGoodEnough')) { await this.notGoodEnoughFlow(s, actor); handled = true; }
    else if (intents.has('watch')) { await this.watchFlow(s, u, cur, actor); handled = true; }
    else if (intents.has('ways') && s.mission) {
      const next = await this.waysFlow(s, u, cur);
      if (next !== 'continue') handled = true;
      else { const c2 = s.current ? await this.currentTrip(s) : null; return this.routeRest(s, u, c2, { intents, rebuild: rebuild || next === 'continue' && u.updates.way && Object.keys(u.updates).some(k => !['way', 'warm'].includes(k)) && rebuild, ack }); }
    } else if (intents.has('challenge')) { await this.challengeFlow(s, u, cur); handled = true; }
    // A question about what the data cannot compare (booking elsewhere, one-way fares, points, a
    // promo code, another currency, seat fees, parking) is answered as such, before "book" could
    // start the checkout or "cheaper" chase a version: nothing is compared, so nothing is proposed.
    else if (intents.has('notCompared') && cur) { await this.notComparedFlow(s, cur, text); handled = true; }
    else if (intents.has('book')) { await this.bookFlow(s, cur); handled = true; }
    // The money leak hunter, before any price cut or rebuild: each answer is a priced version the
    // traveler takes or keeps, never a removal.
    else if (intents.has('leakScan') && cur) { await this.leakScanFlow(s, cur, { amount: named && !named.aside ? named.amount : null }); handled = true; }
    else if (intents.has('leakVersion') && cur) { await this.biggestLeakFlow(s, cur, { show: true, text }); handled = true; }
    else if (intents.has('biggestLeak') && cur) { await this.biggestLeakFlow(s, cur); handled = true; }
    else if (intents.has('removeOne') && cur) { await this.removeOneFlow(s, cur); handled = true; }
    else if (intents.has('strip') && cur) { await this.stripFlow(s, cur); handled = true; }
    else if (intents.has('addBack') && cur) { await this.addBackFlow(s, cur, text); handled = true; }
    else if (intents.has('cutInOrder') && cur) { await this.cutInOrderFlow(s, cur, u.updates.cutBy || null); handled = true; }
    else if (intents.has('freeSavings') && cur) { await this.freeSavingsFlow(s, cur, text); handled = true; }
    else if (intents.has('scorecard') && cur) { await this.scorecardFlow(s, cur); handled = true; }
    else if (intents.has('paying') && cur) { await this.payingFlow(s, cur); handled = true; }
    else if (intents.has('whyPick') && cur) { await this.whyPick(s, cur, u.updates.destinationAsked || null); handled = true; }
    else if (intents.has('sameTripLess') && cur) { await this.sameTripFlow(s, cur); handled = true; }
    else if (intents.has('howLow') && cur) { await this.howLowFlow(s, cur); handled = true; }
    else if (intents.has('cutMore') && cur) { await this.cutMoreFlow(s, cur); handled = true; }
    else if (intents.has('breakpoints') && cur) { await this.breakpointsFlow(s, cur); handled = true; }
    else if (intents.has('receipt')) { await this.receiptFlow(s, cur); handled = true; }
    else if (intents.has('whenLess')) { await this.weeksFlow(s, cur); handled = true; }
    else if ((intents.has('howLow') || intents.has('cutMore') || intents.has('sameTripLess') || intents.has('breakpoints')) && !cur) { this.speak(s, 'There is nothing on the canvas to cut yet. Give me the number and where you fly from, and I build first.'); handled = true; }
    else if (intents.has('keepLooking')) { await this.keepLooking(s, cur); handled = true; }
    else if (u.updates.budget && s.mission && cur && budgetBefore && state.bookingBudget(s) !== budgetBefore && !intents.has('cheaper') && !intents.has('better')) { await this.shiftFlow(s, cur, budgetBefore); handled = true; }
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
    } else if (!handled && !cur && ['cheaper', 'better', 'extend', 'shorten', 'catch', 'recommend', 'why', 'compare', 'stopSaves', 'easier', 'elsewhere', ...LEAK_INTENTS].some(k => intents.has(k)) && !rebuild && !u.updates.budget) {
      this.speak(s, 'There is no trip on the canvas yet. Tell me your budget and where you are flying from, and I will build one first.');
      handled = true;
    }
    if (handled) { if (ack && !s.messages.some(m => m.text === ack)) { /* the engine answer already covers it */ } return this.afterTurn(s); }
    return this.routeRest(s, u, cur, { intents, rebuild, ack });
  }

  // The rest of a message once a way was chosen: a change to the trip (rebuild), cheaper, better.
  async routeRest(s, u, cur, { intents, rebuild, ack }) {
    if (cur) {
      if (intents.has('cheaper')) { await this.makeCheaper(s, cur, u.updates.cheaperBy || null); return this.afterTurn(s); }
      if (intents.has('better')) { await this.makeBetter(s, cur, u.updates.moreBy || null); return this.afterTurn(s); }
      if (intents.has('extend')) { await this.changeNights(s, cur, +1); return this.afterTurn(s); }
      if (intents.has('shorten')) { await this.changeNights(s, cur, -1); return this.afterTurn(s); }
    }

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

  // "Start over": the trip object is new. A hunt this conversation started stays on the account exactly
  // as it is (a standing instruction is never stopped without the customer's word), so its status is
  // read from the record and said, with where to stop or resume it, because this conversation can no
  // longer name it.
  async restart(s, actor = null) {
    const ref = this.huntRef(s);
    let hunt = null;
    if (ref && this.hunts && actor) { try { hunt = await this.hunts.get(actor, ref.id); } catch (e) { if (!(e instanceof AppError)) throw e; } }
    const fresh = state.newState({ id: s.id, visitor: s.visitor, userId: s.userId, now: this.now() });
    this.jobs.cancel(s.id);
    for (const k of Object.keys(fresh)) s[k] = fresh[k];
    s.hunt = null; s.huntThreshold = null; s.huntWithout = null;
    const name = hunt ? hunt.name : ref ? ref.name : null;
    const note = !ref ? '' : hunt
      ? ` ${name} ${hunt.status === 'hunting' ? 'keeps running on your account, untouched by this: stop it from its page or from My Trips' : 'stays stopped on your account: resume it from its page or from My Trips'}.`
      : ` ${name} stays on your account as it is (this conversation last saw it ${ref.status}): stop or resume it from its page or from My Trips.`;
    this.speak(s, `Fresh start.${note} What do you want your trip to do?`, ref ? { kind: 'link', href: `/hunts/${ref.id}`, label: `${name}: stop or resume it there` } : null);
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
      const options = ask.options ? ask.options.map(([label, say]) => ({ label, say })) : ask.origins ? this.maps.listOrigins().map(o => ({ label: `${o.city} (${o.airports[0].code})`, say: o.airports[0].code })) : null;
      this.speak(s, ask.text, options ? { kind: 'ask', options } : null);
      return;
    }
    const { query: q, assumed } = state.toQuery(s, { maps: this.maps });
    s.assumed = assumed;
    s.proposal = null;
    s.options = [];
    s.decision = null; s.decisionFacts = null;
    s.weeks = [];
    // A rebuild from a changed definition (other travelers, another month) starts a new receipt: the
    // lines of the old one would attribute the change to a price move of the same trip.
    if (reason === 'rebuild') s.history = [];
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
    const snapshot = await this.withState(id, s => ({ q: state.toQuery(s, { maps: this.maps }).query, jobId: s.job && s.job.id, previous: s.job && s.job.previous, mission: !!s.mission, nightsStated: !!s.nightsStated, locks: state.effectiveLocks(s), ...(s.mission ? this.missionOpts(s) : { exclude: null, prefer: null }) }));
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
      s.job.feed = s.job.feed || [];
      if (first) {
        const c = card(first);
        s.job.first = c;
        s.job.firstAtMs = Date.parse(now().toISOString()) - Date.parse(s.job.startedAt);
        s.current = { token: c.token, total: c.total, since: now().toISOString() };
        s.job.feed.push(`First strong trip at ${(s.job.firstAtMs / 1000).toFixed(1)} s: ${c.dest}, ${money(c.total)}, from ${fast.considered} packages in ${joinAnd(names)}`);
        this.speak(s, `First strong match: ${c.summary}. ${money(c.total)} all in, ${q.budget - c.total >= 0 ? `${money(q.budget - c.total)} under your limit` : `${money(c.total - q.budget)} over your limit`}. Still checking whether I can beat this.`, { kind: 'trip', trip: c, label: 'First strong match', first: true });
      } else if (fast) s.job.feed.push(`Nothing in ${joinAnd(names)} fits every rule at ${money(q.budget)}; checking the rest`);
    });
    await this.breathe();
    if (job.cancelled) return;
    // A mission: three ways from the likeliest destinations first, so the traveler reads real options
    // while every other destination tries to beat them. A way is replaced only by something
    // materially better, and the replacement is said.
    const wayOpts = { settings, now: now(), nightsOpen: !snapshot.nightsStated, exclude: snapshot.exclude || undefined, prefer: snapshot.prefer || null, locks: snapshot.locks };
    const fastWays = snapshot.mission && !q.dest && first ? strategies.threeWays(this.inv, { ...q, dests: likely }, wayOpts) : null;
    if (fastWays && fastWays.strategies.length) {
      await this.patch(id, s => { if (!mine(s)) return; this.presentWays(s, fastWays, q, ctx, { stage: 'fast', names, all: this.maps.listDestinations().filter(d => !(settings.disabledDestinations || []).includes(d.id)).length }); });
      await this.breathe();
      if (job.cancelled) return;
    }

    // Deep: every destination, every combination inside the rules.
    const all = this.maps.listDestinations().filter(d => !(settings.disabledDestinations || []).includes(d.id)).length;
    await this.patch(id, s => { if (!mine(s)) return; setStep(s.job, 'deep', 'running', snapshot.mission ? (fastWays && fastWays.strategies.length ? `Trying to beat the ${fastWays.strategies.length === 3 ? 'three ways' : plural(fastWays.strategies.length, 'way')}: checking every destination we serve from ${this.maps.getOrigin(q.origin).city}` : `Checking every destination we serve from ${this.maps.getOrigin(q.origin).city}, then building three ways to use ${money(q.budget)}`) : `Checking every destination we serve from ${this.maps.getOrigin(q.origin).city}`, now()); });
    await this.breathe();
    if (job.cancelled) return;
    const deep = optimizer.search(this.inv, q, { settings, now: now() });
    const best = deep.picks[0] || null;
    // A mission from one number: three meaningfully different ways to use it, from the same search rules.
    const ways = snapshot.mission && !q.dest && best ? strategies.threeWays(this.inv, q, wayOpts) : null;
    let improved = false;
    if (first && best && !ways) {
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
      if (this.saver(s)) {
        // The saver's second option is the cheapest trip the engine would still recommend, not the
        // optimizer's "save more" (the strongest cheaper trip), so "Lowest I recommend" is literally that.
        const low = best ? savemax.lowestRecommended(deep.eligibleTrips || [], ctx) : null;
        s.options = savemax.labelsFor(s.options, { lowest: low ? { kind: 'lowest', label: 'Lowest I recommend', blurb: 'The cheapest trip I would still recommend for your rules.', over: false, upgrade: null, ...card(low) } : null });
      }
      s.job.keepMoney = deep.keepMoney ? { spare: deep.keepMoney.spare, considered: deep.keepMoney.considered } : null;
      s.job.improved = improved;
      s.job.feed = s.job.feed || [];
      s.job.feed.push(`Checked ${plural(deep.destinations, 'destination')}: ${deep.considered} complete packages, ${deep.eligible} inside your rules and budget`);
      if (best && deep.cheaperThanPick) s.job.feed.push(`Rejected ${plural(deep.cheaperThanPick, 'cheaper package')} that fit the budget: each gives something up against the pick`);
      if (best) s.job.feed.push(best.trip.total <= q.budget ? `Current winner is ${money(q.budget - best.trip.total)} below your limit` : `Nothing at or under ${money(q.budget)}: the closest is ${money(best.trip.total - q.budget)} over`);
      if (best && deep.keepMoney && deep.keepMoney.dear) s.job.feed.push(`No upgrade worth the money: ${plural(deep.keepMoney.dear, 'dearer package')} improved something, ${deep.keepMoney.tooDear ? `${deep.keepMoney.tooDear} asked more than a third more` : ''}${deep.keepMoney.tooDear && deep.keepMoney.extras ? ', ' : ''}${deep.keepMoney.extras ? `${deep.keepMoney.extras} only added an extra you can add yourself` : ''}`);
      else if (best && s.options.some(o => o.kind === 'upgrade')) { const u = s.options.find(o => o.kind === 'upgrade'); s.job.feed.push(`One upgrade is worth it: +${money(u.upgrade.delta)} buys ${u.upgrade.gets}`); }
      if (ways) {
        const m = s.mission;
        if (fastWays && fastWays.strategies.length && m.fastRound === m.round) this.beatWays(s, fastWays, ways, deep, q, ctx);
        else if (!fastWays || !fastWays.strategies.length) this.presentWays(s, ways, q, ctx, { stage: 'deep' });
        else s.job.feed.push(`Checked all ${plural(deep.destinations, 'destination')}: ${deep.considered} complete packages; you had already moved on from the first three ways, so nothing was replaced`);
        setStep(s.job, 'expand', 'skipped', 'Not needed: a trip inside your rules and budget was found', now());
        s.job.status = 'done';
        s.job.finishedAt = now().toISOString();
        return;
      }
      if (best) {
        const c = card(best);
        s.job.best = c;
        s.job.bestAtMs = Date.parse(now().toISOString()) - Date.parse(s.job.startedAt);
        if (first && improved) {
          const ch = classifyChanges(first.trip, best.trip);
          s.proposal = { kind: 'switch', token: c.token, total: c.total, delta: c.total - first.trip.total, from: s.job.first.token, label: 'Better option', improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over: c.total > q.budget };
          this.speak(s, `I beat my first option. First ${money(first.trip.total)}, better ${money(c.total)}${c.total < first.trip.total ? `, you keep ${money(first.trip.total - c.total)} more` : ''}: ${c.summary}. Switch, or keep the first one.`, { kind: 'switch', first: s.job.first, better: c, proposal: s.proposal });
        } else if (first) {
          // A real decision first, when the search is one answer away from it; otherwise the signature
          // moment: the agent finishes, says what it tested, and picks, with the claim kept to what
          // the search really covered.
          if (!this.oneDecision(s, best, deep, q, ctx)) this.speak(s, this.stopLine(deep, q, s.options), this.finalCard(s));
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
        if (q.dateMode === 'flexible' && q.month && s.current) this.flexibleWeek(s, deep.picks.find(p => encodeSpec(p.trip.spec) === s.current.token) || best, q, ctx, settings);
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

  async approve(s, text, pending, named = null) {
    const lower = text.toLowerCase();
    if (s.proposal) {
      const p = s.proposal;
      // Words that name a version apply only that version. With another kind on the table nothing is
      // applied on them; one version is on the table at a time, so the pending one steps aside, neither
      // taken nor declined (nothing is recorded against it, and it can be proposed again), and that is
      // said once before the named flow prices the version the words asked for.
      if (named && !namedFits(named, p)) {
        named.aside = p;
        s.proposal = null;
        this.speak(s, `Those words name ${named.name}; what was on the table was ${proposalWords(p)} at ${money(p.total)}, and nothing is applied on them. It comes off the table, neither taken nor declined.`);
        return false;
      }
      if (p.anyway && /\b(anyway|the \$|cheap(?:er|est)|lower|target)\b/.test(lower) && !/\b(floor|recommend)/.test(lower)) return this.applyProposal(s, { ...p, token: p.anyway.token, total: p.anyway.total, delta: p.anyway.delta, label: p.anyway.label, challengedAccepted: true });
      if (p.over && !s.overApproved && !/\b(over|allow|exceed|above|anyway)\b/.test(lower)) { this.speak(s, `That version is ${money(p.total - state.bookingBudget(s))} over your ${money(state.bookingBudget(s))} ceiling. Say "go over" to take it anyway, or "keep" to stay.`); return true; }
      if (p.over) s.overApproved = true;
      return this.applyProposal(s, p);
    }
    // Nothing of the kind the words name is on the table: they are their own ask (an old "Take the
    // lean version" chip or "strip it" prices the lean version again; "remove it" runs the scan), and
    // never a pick among the build's options, which "add back the first thing" must not read as.
    if (named) return false;
    if (s.options.length) {
      const pick = /upgrade|comfort/.test(lower) ? s.options.find(o => o.kind === 'upgrade') : /lowest/.test(lower) ? s.options.find(o => o.kind === 'lowest') : /save more|cheaper/.test(lower) ? s.options.find(o => o.kind === 'save-more') || s.options.find(o => o.kind === 'lowest') : /our pick|first|best value/.test(lower) ? s.options.find(o => o.kind === 'our-pick') : /^(?:option\s*)?([abc])\b/.test(lower) ? s.options['abc'.indexOf(lower.match(/^(?:option\s*)?([abc])\b/)[1])] : null;
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
      if (p.savingsCheck) s.declinedCheaper = p.token; // the savings check will not propose this version again
      // A removal the traveler kept, whether the money leak check offered it before paying, on demand,
      // as the biggest leak or as "remove one thing", is kept: the scan at "book it" says it once and
      // never proposes the same version twice.
      if (p.savingsScan || p.kind === 'leak' || p.kind === 'removeOne') s.declinedLeak = p.token;
      this.speak(s, p.kind === 'switch' ? `Kept your first option at ${money(s.current.total)}. The better one stays in your options if you change your mind.` : `Kept your trip as it is${p.delta < 0 || p.silent ? `, at ${money(s.current.total)}` : ''}.`);
      return true;
    }
    if (pending === 'options' && s.current) { this.speak(s, `Kept your trip as it is, at ${money(s.current.total)}.`); return true; }
    if (s.options.length && !pending) { this.speak(s, `Kept our pick at ${money(s.current ? s.current.total : 0)}.`); return true; }
    return false;
  }

  async chooseOption(s, kind) {
    if (typeof kind === 'string' && /^[AB]$/.test(kind) && s.decision) return this.decide(s, kind);
    if (typeof kind === 'string' && /^[A-E]$/.test(kind) && s.weeks && s.weeks.length) {
      const w = s.weeks.find(x => x.letter === kind);
      if (!w) { this.speak(s, 'That week is not on the table any more.'); return true; }
      s.weeks = [];
      const budget = state.bookingBudget(s);
      const sameDates = s.current && decodeSpec(s.current.token).depart === w.depart;
      const over = !!(budget && w.total > budget);
      const p = { kind: 'dates', token: w.token, total: w.total, delta: s.current ? w.total - s.current.total : 0, label: sameDates ? 'Cheaper version, same dates' : `Leaving ${longDate(w.depart)}`, over };
      // A week over the ceiling is never applied by letter: like every other path over the number,
      // it is a proposal that waits for "go over".
      if (over && !s.overApproved) { this.propose(s, p, `${p.label} is ${money(w.total)}, ${money(w.total - budget)} over your ${money(budget)} ceiling. Say "go over" to take it anyway, or "keep" to stay on your dates.`); return true; }
      return this.applyProposal(s, p);
    }
    if (typeof kind === 'string' && /^[A-E]$/.test(kind) && s.breakpoints && s.breakpoints.length) {
      const b = s.breakpoints.find(x => x.letter === kind);
      if (!b) { this.speak(s, 'That upgrade is not on the table any more.'); return true; }
      s.breakpoints = [];
      return this.applyProposal(s, { kind: 'upgrade', token: b.token, total: b.total, delta: s.current ? b.total - s.current.total : 0, label: b.gets, over: false });
    }
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
    if (!s.history.length && before) s.history.push({ label: 'Start', token: s.current.token, total: before.total, at: s.current.since || this.now().toISOString() });
    // The lean version remembers the trip it was stripped from, so "add back" prices that trip's
    // items onto the canvas; adding one back keeps it, and any other applied version ends it.
    s.leanOf = p.kind === 'lean' && s.current ? s.current.token : p.kind === 'addBack' ? s.leanOf : null;
    s.current = { token: p.token, total: after.total, since: this.now().toISOString() };
    s.history.push({ label: p.label || p.kind, token: p.token, total: after.total, at: this.now().toISOString() });
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
    const locks = state.effectiveLocks(s);
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
        const anyway = { token: encodeSpec(a.trip.spec), total: a.total, delta: a.total - t.total, label: `${money(a.total)} version`, compromises: this.newCompromises(t, a, cur.ctx) };
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
      ? `You are already at the cheapest version I would recommend${lockNote}. Going lower means ${joinAnd(this.newCompromises(t, a, cur.ctx)) || words(a)} for ${money(a.total)}; say "take $${Math.round((t.total - a.total) / 100)} back" if you want that trade.`
      : `This is already the cheapest version of this trip in what suppliers returned${lockNote}. To go lower, unlock something or change the destination.`);
  }

  // One rule or lock relaxed at a time, each priced: the single changes that would reach the target.
  // Nothing is offered that was not priced, and the traveler picks the compromise, never the agent.
  oneMoreCompromise(s, cur, target, settings) {
    const t = cur.trip, ctx = cur.ctx, locks = state.effectiveLocks(s);
    const rules = ctx.rules || {};
    const cands = [];
    if (rules.nonstop) cands.push({ key: 'nonstop', label: 'Allow one connection', ctx: { ...ctx, rules: { ...rules, nonstop: false } }, locks: { ...locks, flight: false } });
    else if (locks.flight) cands.push({ key: 'flight', label: 'Change the flights', ctx, locks: { ...locks, flight: false } });
    if (rules.minStars) cands.push({ key: 'stars', label: `Allow a hotel under ${rules.minStars} stars`, ctx: { ...ctx, rules: { ...rules, minStars: 0 } }, locks });
    if (locks.hotel) cands.push({ key: 'hotel', label: 'Change the hotel', ctx, locks: { ...locks, hotel: false } });
    if (locks.dates) cands.push({ key: 'dates', label: s.locks.dates ? 'Unlock the dates and move to the cheapest I find' : `Move the ${s.depart} departure to the cheapest date I find`, ctx, locks: { ...locks, dates: false } });
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
          const comp = hit === r.anyway ? this.newCompromises(t, hit, cur.ctx) : [];
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
    // Moving a date the traveler stated exactly is their choice here; the date stops being a rule.
    if (key === 'dates' && s.dateMode === 'exact') { s.dateMode = 'anytime'; s.depart = null; }
  }

  async makeBetter(s, cur, moreBy) {
    const t = cur.trip, ctx = cur.ctx;
    const settings = await this.settings();
    const budget = state.bookingBudget(s);
    const cap = moreBy ? t.total + moreBy : Math.max(t.total, budget || t.total);
    const room = budget ? budget - t.total : 0;
    const best = decision.optimizeAround(this.inv, t, settings, ctx, { locks: state.effectiveLocks(s), cap, now: this.now() });
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
    let check = '';
    if (s.mission) {
      // The savings check before payment: the trip priced again, every cheaper version looked for once
      // more; a materially cheaper one with nothing given up is a decision for the traveler first.
      const sc = savemax.savingsCheck(this.inv, t, await this.settings(), cur.ctx, { now: this.now(), locks: state.effectiveLocks(s) });
      if (!sc.ok && sc.cheaper && sc.cheaper.token !== s.declinedCheaper) {
        const ch = sc.cheaper.changes;
        this.propose(s, { kind: 'cheaper', savingsCheck: true, token: sc.cheaper.token, total: sc.cheaper.total, delta: sc.cheaper.delta, label: 'Same trip, cheaper', improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over: false }, `Savings check before you pay: ${sc.text} Take it, or keep what you have; then say "book it" again.`);
        return;
      }
      // The cheaper version the traveler already chose not to take is said, not proposed a second time.
      check = sc.ok ? `${sc.text}${sc.repriced ? ` (the live price moved ${sc.repriced > 0 ? 'up' : 'down'} ${money(Math.abs(sc.repriced))} since it was built)` : ''}. `
        : sc.cheaper && sc.cheaper.token === s.declinedCheaper ? `Savings check before you pay: the cheaper version I found (${money(sc.cheaper.total)}) is the one you chose not to take, so your trip stands at ${money(t.total)}. `
        : `${sc.text} `;
    }
    // The money leak check before paying, for every conversation: the approved trip scanned once more
    // for an optional cost with no trade-off (an item nothing stated asks for, a duplicate, the same
    // bags for less, the same trip priced lower on these dates). One is a decision for the traveler
    // first, with the savings check's own words kept in front of it; one they already chose to keep
    // (after this check, the one on demand, or "remove one thing") or a version they chose not to
    // take is said, never proposed twice. The scan's own sentence is spoken as the engine wrote it
    // (one of its two exact sentences, led by MONEY LEAK CHECK COMPLETE), with the kept item said
    // after it, and its card comes before the scorecard, whose lines are never added together.
    const scan = await this.leakScan(s, cur);
    const kept = !!scan.found && (scan.found.token === s.declinedLeak || scan.found.token === s.declinedCheaper);
    const scanCard = { kind: 'scan', checks: scan.checks, found: scan.found, text: scan.text, kept };
    if (scan.found && !kept) {
      this.propose(s, this.leakProposal(scan.found, t, { savingsScan: true }), `${check}${scan.text} Remove it, or keep it; then say "book it" again.`, scanCard);
      return;
    }
    this.speak(s, `${check}${scan.text}${kept ? ` ${scan.found.token === s.declinedLeak ? 'That is the one you chose to keep' : 'That is the version you chose not to take'}, so your trip stands at ${money(t.total)}.` : ''}`, scanCard);
    const card = await this.scorecardFor(s, cur);
    this.speak(s, `Your savings check: ${card.text}`, this.scorecardCard(card));
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
    if (s.dateMode === 'exact' && s.depart && t.spec.depart !== s.depart) out.push(`leaving ${longDate(t.spec.depart)} instead of ${longDate(s.depart)}`);
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

  // ---- the mission: three ways, the traveler's reaction, the direction pushed ------------------------
  // `chosen` names the decision the traveler took over the trip the search would have picked: the
  // counts are then said against that pick, and the canvas is called theirs, not the strongest found.
  stopLine(deep, q, options, { chosen = null } = {}) {
    const o = this.maps.getOrigin(q.origin);
    const up = options.find(x => x.kind === 'upgrade');
    return `I'd stop here. I checked all ${plural(deep.destinations, 'destination')} we serve from ${o ? o.city : q.origin}: ${deep.considered} complete packages, every hotel and flight combination suppliers returned inside your rules${q.dateMode === 'anytime' ? ', on the departure dates they offered' : q.dateMode === 'flexible' ? ` in ${q.month}` : ' on your dates'}. ${deep.cheaperThanPick ? `${plural(deep.cheaperThanPick, 'cheaper package')} fit your budget; each gives something up against ${chosen ? 'the one I would have picked' : 'this one'}.` : 'Nothing cheaper fit your rules.'} ${up ? `One upgrade is worth it: +${money(up.upgrade.delta)} buys ${up.upgrade.gets}; it is in your options.` : 'The dearer ones don\'t improve what matters enough to pay for.'} ${chosen ? `You chose ${chosen} over the one I would have picked, so that is the trip on your canvas; nothing else I checked changes it.` : 'This is the strongest option I found for your current rules.'}`;
  }

  async waysFlow(s, u, cur) {
    const m = s.mission;
    if (u.updates.variant) return this.pickVariant(s, u.updates.variant);
    if (u.updates.mix) return this.mixFlow(s, u.updates.mix);
    if (u.updates.wrong) return this.differentSetFlow(s, u.updates.wrong);
    if (u.updates.way === 'none') {
      s.pending = 'wrong';
      this.speak(s, 'Fair. What was wrong with them? I will build a genuinely different set, not the same three again.', { kind: 'ask', options: [['Destinations', 'The destinations'], ['Too expensive', 'Too expensive'], ['Too short', 'Too short'], ['Too much travel', 'Too much travel'], ['Hotels', 'The hotels'], ['Not exciting', 'Not exciting']].map(([label, say]) => ({ label, say })) });
      return true;
    }
    if (u.updates.way) {
      const w = m.strategies.find(x => x.key === u.updates.way);
      if (!w) { this.speak(s, 'That way is not on the table any more. Say "keep looking" and I will build a fresh set.'); return true; }
      const others = Object.keys(u.updates).filter(k => !['way'].includes(k)).length || ['cheaper', 'better', 'extend', 'shorten'].some(k => u.intents.includes(k));
      await this.chooseWay(s, w, { push: !others });
      return others ? 'continue' : true;
    }
    this.speak(s, 'Say 1, 2 or 3 for the way that feels like you, or "none" and tell me what was wrong.');
    return true;
  }

  // The chosen way is a signal for this trip only: it steers what the agent pushes next and is not
  // saved anywhere unless the traveler asks to remember it.
  async chooseWay(s, w, { push = true } = {}) {
    const m = s.mission;
    m.signal = w.key;
    m.chosen = { key: w.key, token: w.token };
    s.priority = { more: 'longer', keep: 'price', special: 'hotel' }[w.key];
    const before = s.current && s.current.token !== w.token ? await this.priceToken(s.current.token) : null;
    s.current = { token: w.token, total: w.total, since: this.now().toISOString() };
    if (!s.nightsStated) s.nights = w.card.nights;
    const learned = { more: 'getting more vacation from the budget', keep: 'keeping money, not spending it', special: 'spending only where it makes the trip better' }[w.key];
    this.speak(s, `Got it. You seem to prefer ${learned}; I'll push that direction for this trip (I don't save that unless you tell me to). ${w.card.dest} is on your canvas at ${money(w.total)}${before ? `, ${before.total > w.total ? `${money(before.total - w.total)} less than` : before.total < w.total ? `${money(w.total - before.total)} more than` : 'the same as'} what was there` : ''}.`);
    if (push) await this.pushVariants(s, w);
  }

  async pushVariants(s, w) {
    const settings = await this.settings();
    const { query: q } = state.toQuery(s, { maps: this.maps });
    const ctx = state.budgetContext(s, q);
    const chosen = await this.priceToken(w.token);
    if (!chosen) { this.speak(s, 'That version is no longer available from the suppliers; say "keep looking" and I will rebuild.'); return; }
    const mo = this.missionOpts(s);
    const out = strategies.pushDirection(this.inv, q, { trip: chosen, token: w.token, total: chosen.total }, w.key, { settings, now: this.now(), locks: state.effectiveLocks(s), nightsOpen: !s.nightsStated, exclude: mo.exclude, prefer: mo.prefer });
    s.mission.variants = out.variants.map(v => ({ letter: v.letter, label: v.label, token: v.token, total: v.total, keep: v.keep, changes: { improvements: changeWords(v.changes.improvements), tradeoffs: changeWords(v.changes.tradeoffs), neutral: changeWords(v.changes.neutral) }, card: tripCard(v.trip, v.token, ctx) }));
    const missing = (out.missing || []).map(x => x.reason);
    if (!s.mission.variants.length) { this.speak(s, `I tried to push that direction and found nothing the suppliers price that I'd put beside it${missing.length ? `: ${missing.join('; ')}` : ''}. Your pick stands; say "book it" when ready, or tell me what to change.`); return; }
    s.pending = 'variants';
    const vs = s.mission.variants;
    // Mixing is offered only when two of these can really be one trip (same destination and airport).
    let pair = null;
    for (let i = 0; i < out.variants.length && !pair; i++) for (let j = 0; j < out.variants.length && !pair; j++) if (i !== j && strategies.mixable && strategies.mixable(out.variants[i].trip, out.variants[j].trip)) pair = [out.variants[i].letter, out.variants[j].letter];
    s.mission.mixable = !!pair;
    this.speak(s, `Pushing that direction, ${vs.length === 1 ? 'one real version' : `${vs.length === 3 ? 'three' : 'two'} real versions`}: ${vs.map(v => `${v.letter}. ${v.label}, ${money(v.total)}`).join('; ')}.${missing.length ? ` Not offered: ${joinAnd(missing.map(r => r.charAt(0).toLowerCase() + r.slice(1)))}.` : ''} ${vs.length > 1 ? `Pick one${pair ? `, mix two of them ("the hotel from ${pair[0]} with the flight from ${pair[1]}")` : ''}, or keep what's on the canvas.` : 'Pick it, or keep what\'s on the canvas.'}${vs.length > 1 && !pair ? ' These cannot be mixed into one trip: they are in different places or on different dates, so each stands on its own.' : ''}`, { kind: 'variants', chosen: w.card, variants: vs.map(v => ({ letter: v.letter, label: v.label, trip: v.card, keep: v.keep, changes: v.changes })), missing, mixable: !!pair, pair });
  }

  async pickVariant(s, letter) {
    const v = (s.mission.variants || []).find(x => x.letter === letter);
    if (!v) { this.speak(s, 'That version is not on the table any more.'); return true; }
    await this.applyProposal(s, { kind: 'variant', token: v.token, total: v.total, delta: s.current ? v.total - s.current.total : 0, label: v.label, over: false });
    s.mission.variants = [];
    return true;
  }

  async mixFlow(s, mix) {
    const vs = s.mission.variants || [];
    if (!vs.length) { this.speak(s, 'There is nothing to mix yet: pick a way first and I will push three versions you can mix.'); return true; }
    if (!mix.hotelFrom || !mix.flightFrom) { s.pending = 'variants'; this.speak(s, `Which hotel and which flight? Say it like "the hotel from ${vs[vs.length - 1].letter} with the flight from ${vs[0].letter}".`); return true; }
    const a = vs.find(x => x.letter === mix.hotelFrom), b = vs.find(x => x.letter === mix.flightFrom);
    if (!a || !b) { this.speak(s, 'I only have ' + joinAnd(vs.map(x => x.letter)) + ' to mix.'); return true; }
    const ta = await this.priceToken(a.token), tb = await this.priceToken(b.token);
    if (!ta || !tb) { this.speak(s, 'One of those versions is no longer available from the suppliers.'); return true; }
    const settings = await this.settings();
    const budget = state.bookingBudget(s);
    const out = strategies.mixTrips(this.inv, { letter: a.letter, trip: ta }, { letter: b.letter, trip: tb }, { hotelFrom: 'a', flightFrom: 'b' }, { settings, cap: budget || null });
    if (out.error) { this.speak(s, out.error); return true; }
    const label = `Hotel from ${a.letter}, flights and dates from ${b.letter}`;
    if (out.over) {
      // A mix over the ceiling is never applied on "mix them": it is said, and needs "go over" by name.
      const ch = classifyChanges(s.current && s.current.token === a.token ? ta : tb, out.trip);
      this.propose(s, { kind: 'mix', token: out.token, total: out.total, delta: s.current ? out.total - s.current.total : 0, label, improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over: true }, `That mix prices at ${money(out.total)}, ${money(out.total - budget)} over your ${money(budget)} ceiling. Say "go over" to take it anyway, or keep what you have.`);
      return true;
    }
    await this.applyProposal(s, { kind: 'mix', token: out.token, total: out.total, delta: s.current ? out.total - s.current.total : 0, label, over: false });
    s.mission.variants = [];
    return true;
  }

  async differentSetFlow(s, wrong) {
    const m = s.mission;
    m.wrong.push(wrong);
    const settings = await this.settings();
    const { query: q } = state.toQuery(s, { maps: this.maps });
    const ctx = state.budgetContext(s, q);
    const out = strategies.differentSet(this.inv, q, { wrong, shown: m.shown, settings, now: this.now(), nightsOpen: !s.nightsStated });
    // What the reaction changed stays a rule for this trip, visible on the mission panel and honoured
    // by every later step; the traveler can drop it ("a stop is fine", "any star class").
    let kept = '';
    if (wrong === 'travel' && !(s.flightStops === 'nonstop' && s.flightRule === 'hard')) { s.flightStops = 'nonstop'; s.flightRule = 'hard'; kept = ' Nonstop only is now a rule for this trip; say "a stop is fine" to drop it.'; }
    if (wrong === 'hotels') {
      const stars = m.shown.map(x => x.stars).filter(Boolean);
      const minStars = Math.min(5, ((s.hotelRules.minStars) || (stars.length ? Math.min(...stars) : 3)) + 1);
      if (minStars > (s.hotelRules.minStars || 0)) { s.hotelRules.minStars = minStars; kept = ` ${minStars}-star or better is now a rule for this trip; say "any star class" to drop it.`; }
    }
    m.round += 1;
    m.strategies = out.strategies.map(w => this.wayEntry(w, ctx));
    m.shown = [...m.shown, ...out.strategies.map(w => this.shownEntry(w))];
    m.pick = out.pick;
    m.variants = [];
    const pick = out.pick ? m.strategies.find(w => w.key === out.pick.key) : null;
    const champion = pick || m.strategies[0] || null;
    if (champion) s.current = { token: champion.token, total: champion.total, since: this.now().toISOString() };
    if (!m.strategies.length) { this.speak(s, `I changed the search (${joinAnd(out.adjusted)}) and nothing in what suppliers returned fits at ${money(q.budget)} now. Tell me what to relax, or raise the ceiling.`); return true; }
    s.pending = 'ways';
    this.speak(s, `A different set: ${joinAnd(out.adjusted.map(a => a.charAt(0).toLowerCase() + a.slice(1)))}.${kept}${sentences(out.dropped.map(d => d.reason))}${out.pick && champion ? ` I'd start with ${champion.card.dest}: ${joinAnd(out.pick.reasons.map(r => r.charAt(0).toLowerCase() + r.slice(1)))}.` : ''} Which feels more like you?`, this.waysCard(s, m, q));
    return true;
  }

  // The budget moved after the results: what the extra money really buys, or how the same trip
  // keeps fitting under less, with the three ways rebuilt at the new ceiling.
  async shiftFlow(s, cur, budgetBefore) {
    const settings = await this.settings();
    const { query: q } = state.toQuery(s, { maps: this.maps });
    const ctx = state.budgetContext(s, q);
    const mo = this.missionOpts(s);
    const out = strategies.budgetShift(this.inv, q, cur.trip, q.budget, { settings, now: this.now(), locks: state.effectiveLocks(s), nightsOpen: !s.nightsStated && !s.locks.nights, exclude: mo.exclude, prefer: mo.prefer });
    const note = out.note, st = out.strategies, m = s.mission;
    if (st.strategies.length) {
      m.round += 1;
      m.strategies = st.strategies.map(w => this.wayEntry(w, ctx));
      m.shown = [...m.shown, ...st.strategies.map(w => this.shownEntry(w))];
      m.pick = st.pick;
      m.variants = [];
    }
    const more = st.strategies.find(w => w.key === 'more');
    if (note.kind === 'extra-night' && more) {
      const ch = classifyChanges(cur.trip, more.trip);
      this.propose(s, { kind: 'nights', token: more.token, total: more.total, delta: more.total - cur.trip.total, label: `${plural(more.trip.spec.nights, 'night')} version`, improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over: more.total > q.budget, nights: more.trip.spec.nights }, `${note.text} Add the night, or keep the ${money(q.budget - cur.trip.total)}.`);
    } else if (q.budget < cur.trip.total) {
      this.speak(s, `${money(budgetBefore)} down to ${money(q.budget)}. ${note.text}`);
      await this.makeCheaper(s, cur, cur.trip.total - q.budget);
    } else this.speak(s, `${money(budgetBefore)} ${q.budget > budgetBefore ? 'up' : 'down'} to ${money(q.budget)}. ${note.text}`);
    if (m.strategies.length && !s.proposal) this.speak(s, `The ${m.strategies.length === 3 ? 'three' : m.strategies.length === 2 ? 'two' : ''} ways at ${money(q.budget)}:`, this.waysCard(s, m, q, { compact: true }));
    if (!s.proposal && m.strategies.length) s.pending = 'ways';
  }

  // Another round, honestly: the length moved by a night each way, then one rule relaxed at a time;
  // a replacement only for a materially better verified trip, otherwise the recommendation stands.
  async keepLooking(s, cur) {
    if (s.job && s.job.status === 'running') { this.speak(s, 'Still building. I will only interrupt you if something beats what is on the canvas.'); return; }
    if (s.proposal) { this.speak(s, `One decision is open first: take ${proposalWords(s.proposal)} or keep what you have. Then I look again.`); return; }
    if (!cur) { this.speak(s, 'There is nothing to beat yet. Give me a budget and where you fly from and I will build.'); return; }
    const rounds = (s.rounds || 0) + 1;
    s.rounds = rounds;
    if (rounds > 2) { this.speak(s, 'Another round would repeat what I already checked: every destination, every combination inside your rules, and a night either way. My recommendation stands; change a rule or the budget and I will search again.'); return; }
    const settings = await this.settings();
    const { query: q } = state.toQuery(s, { maps: this.maps });
    const ctx = state.budgetContext(s, q);
    const tried = [];
    let bestAlt = null, more = 0;
    for (const d of (s.locks.nights ? [] : [-1, +1])) {
      const n = q.nights + d;
      if (n < 2 || n > 14) continue;
      const r = optimizer.search(this.inv, { ...q, nights: n }, { settings, now: this.now() });
      more += r.considered;
      tried.push(`${plural(n, 'night')}: ${r.eligible} fit`);
      if (r.picks[0] && (!bestAlt || r.picks[0].match > bestAlt.match || (r.picks[0].match === bestAlt.match && r.picks[0].trip.total < bestAlt.trip.total))) bestAlt = r.picks[0];
    }
    let relax = null;
    if (q.rules) { relax = optimizer.oneRuleAway(this.inv, q, { settings, now: this.now() }); tried.push(`${plural(relax.works.length, 'rule')} relaxed on its own would change the trip`); }
    const curTrip = cur.trip;
    let better = false;
    if (bestAlt) {
      const ch = classifyChanges(curTrip, bestAlt.trip);
      const saving = curTrip.total - bestAlt.trip.total;
      better = encodeSpec(bestAlt.trip.spec) !== encodeSpec(curTrip.spec) && ((saving >= MATERIAL_SAVING && ch.tradeoffs.length === 0) || (bestAlt.match >= optimizer.scoreTrip(curTrip, ctx).match + 5 && bestAlt.trip.total <= curTrip.total));
      if (better) {
        const c = tripCard(bestAlt.trip, encodeSpec(bestAlt.trip.spec), ctx);
        this.propose(s, { kind: 'switch', token: c.token, total: c.total, delta: c.total - curTrip.total, from: s.current.token, label: 'Better option', improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over: c.total > q.budget, nights: bestAlt.trip.spec.nights }, `Another round found something that beats it: ${c.summary} for ${money(c.total)}${c.total < curTrip.total ? `, ${money(curTrip.total - c.total)} less` : ''}. Switch, or keep what you have.`);
        return;
      }
    }
    this.speak(s, `I checked another round: ${more} more complete packages with the length moved a night each way (${tried.join('; ')}). I still haven't found anything I'd choose over the current trip. You can keep searching, but my recommendation hasn't changed.${relax && relax.works.length ? ' Relaxing a rule is your call; say which and I will price it.' : ''}`, relax && relax.works.length ? { kind: 'relax', works: relax.works.map(w => ({ key: w.key, label: w.label, rule: w.rule, total: w.total, dest: w.dest, nights: w.nights, over: w.over, say: relaxSay(w, q) })), closest: null } : null);
  }

  // "Why Puerto Rico?": the pick against the named place, from the trips both were priced at.
  async whyPick(s, cur, destAsked) {
    const t = cur.trip;
    if (!destAsked || destAsked === t.dest.id) return this.why(s, cur);
    const settings = await this.settings();
    const { query: q } = state.toQuery(s, { maps: this.maps });
    const d = this.maps.getDestination(destAsked);
    const r = optimizer.search(this.inv, { ...q, dest: destAsked, dests: null, notCountry: null, region: null }, { settings, now: this.now() });
    const mine = `${t.dest.name} gives you ${plural(t.spec.nights, 'night')}, ${t.flight.stops ? `${t.flight.stops}-stop flights` : 'a nonstop flight'}, a ${t.hotel.stars}-star hotel${t.hotel.features.allInclusive ? ', all-inclusive' : t.hotel.features.beachfront ? ', beachfront' : ''}, ${q.budget >= t.total ? `${money(q.budget - t.total)} below your limit` : `${money(t.total - q.budget)} over your limit`}`;
    if (!r.picks[0]) {
      const close = r.closest[0] || null;
      this.speak(s, `Among the options I checked, ${mine}. Nothing in ${d ? d.name : destAsked} fits your rules at ${money(q.budget)}${close ? `; the closest there is ${money(close.trip.total)}, ${money(close.trip.total - q.budget)} over` : ''}.`, close ? { kind: 'trip', trip: tripCard(close.trip, encodeSpec(close.trip.spec), cur.ctx), label: `Closest in ${d ? d.name : destAsked}, over budget`, over: true } : null);
      return;
    }
    const o = r.picks[0];
    const ch = classifyChanges(t, o.trip);
    const diff = o.trip.total - t.total;
    const cost = diff > 0 ? `costs ${money(diff)} more` : diff < 0 ? `costs ${money(-diff)} less` : 'costs the same';
    const give = changeWords(ch.tradeoffs), gain = changeWords(ch.improvements);
    this.speak(s, `Among the options I checked, ${mine}. The closest ${d ? d.name : destAsked} version I found ${cost}${give.length ? `; it gives up ${give.join('; ')}` : ''}${gain.length ? `${give.length ? '; and' : ';'} it improves ${gain.join('; ')}` : ''}.${ch.tradeoffs.length || diff > 0 ? ` That is why I'd still pick ${t.dest.name}.` : ' It is a different trade-off; say "take it" to put it on your canvas.'}`, { kind: 'trip', trip: tripCard(o.trip, encodeSpec(o.trip.spec), cur.ctx), label: `Closest in ${d ? d.name : destAsked}` });
    if (!ch.tradeoffs.length && diff <= 0) s.proposal = { kind: 'option', token: encodeSpec(o.trip.spec), total: o.trip.total, delta: diff, label: `${d ? d.name : destAsked} version`, improvements: changeWords(ch.improvements), tradeoffs: [], neutral: changeWords(ch.neutral), over: false };
  }

  // Saved defaults, only on the traveler's word, and only facts about how they travel.
  async rememberDefaults(s) {
    if (!s.userId) { this.speak(s, 'I can remember your defaults once you are signed in; without an account nothing is kept.'); return; }
    const d = { origin: s.origin, travelers: s.travelers, who: s.who, flightStops: s.flightStops, flightRule: s.flightRule, minStars: s.hotelRules.minStars, nights: s.nights, bags: s.bags, flexibleDates: s.dateMode === 'anytime' || null, savingsLevel: s.savingsLevel, savedAt: this.now().toISOString() };
    const words = this.defaultsWords(d);
    if (!words.length) { this.speak(s, 'There is nothing to remember yet: tell me where you fly from, who travels, how you pack, and any rule that always holds.'); return; }
    await this.store.putRecord('travel_defaults', s.userId, d, { userId: s.userId });
    s.defaults = d;
    this.speak(s, `Saved as your ${this.saver(s) ? 'savings style' : 'defaults'}: ${joinAnd(words)}. I will use them next time and say so; "forget my defaults" removes them. I never keep, infer or use anything about your income or finances: only how you like to travel.`);
  }
  async forgetDefaults(s, permanently) {
    if (permanently && s.userId) await this.store.deleteRecord('travel_defaults', s.userId);
    if (s.defaults) {
      const d = s.defaults;
      if (d.origin && s.origin === d.origin) s.origin = null;
      if (d.travelers && s.travelers === d.travelers) { s.travelers = null; s.who = null; }
      if (d.flightStops && s.flightStops === d.flightStops) { s.flightStops = null; s.flightRule = null; }
      if (d.minStars && s.hotelRules.minStars === d.minStars) s.hotelRules.minStars = null;
      if (d.nights && s.nights === d.nights) s.nights = null;
      if (d.bags && s.bags === d.bags) s.bags = null;
      if (d.flexibleDates && s.dateMode === 'anytime') s.dateMode = null;
      if (d.savingsLevel && s.savingsLevel === d.savingsLevel) s.savingsLevel = null;
      s.defaults = null;
      this.speak(s, permanently ? 'Forgotten, and removed from your account. Tell me the trip from scratch.' : 'Dropped for this trip; your saved defaults stay for next time. Tell me the trip from scratch.');
      await this.startBuild(s, { reason: 'build' });
    } else this.speak(s, permanently && s.userId ? 'You have no saved defaults; nothing to forget.' : 'No saved defaults are in use on this trip.');
  }

  // ---- Save Max: how low, the breakpoints, the same trip for less, the receipt ------------------------
  // The compromises a cheaper version carries that the trip on the canvas does not already have.
  newCompromises(t, v, ctx) {
    const qctx = { ...(ctx || {}), budget: null, allowOver: 0 };
    const had = new Set(decision.compromises(t, qctx).map(c => c.text));
    return (v.compromises || []).map(c => c.text).filter(x => !had.has(x));
  }

  cheaperProposal(s, cur, v, label, text) {
    const ch = v.changes;
    this.propose(s, { kind: 'cheaper', token: v.token, total: v.total, delta: v.total - cur.trip.total, label, improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over: false }, text);
  }

  // "How low can you get it?" The lowest version I'd still recommend, apart from the cheapest found
  // and the facts of that trip that keep it from being recommended. The traveler decides.
  async howLowFlow(s, cur) {
    const settings = await this.settings();
    const r = savemax.howLow(this.inv, cur.trip, settings, cur.ctx, { now: this.now(), locks: state.effectiveLocks(s) });
    const t = cur.trip, rec = r.recommend, ch = r.cheapest;
    const aggressive = s.savingsLevel === 'aggressive';
    const card = { kind: 'howlow', current: t.total, recommend: { total: rec.total, token: rec.token, changes: { improvements: changeWords(rec.changes.improvements), tradeoffs: changeWords(rec.changes.tradeoffs), neutral: changeWords(rec.changes.neutral) } }, cheapest: ch ? { total: ch.total, token: ch.token, whyNot: ch.whyNot } : null, locks: state.lockedWords(s), truncated: !!r.truncated };
    if (rec.total >= t.total && !ch) { this.speak(s, `${money(t.total)} is already the lowest I priced for this trip with your rules${state.lockedWords(s).length ? ` and locks (${state.lockedWords(s).join(', ')})` : ''}. I'd stop cutting here.`, card); return; }
    if (rec.total >= t.total && ch) {
      this.speak(s, `Lowest I would recommend: what you have, ${money(t.total)}. Absolute cheapest found: ${money(ch.total)}, ${money(t.total - ch.total)} less, and I don't recommend it because it means ${joinAnd(ch.whyNot)}. ${aggressive ? 'You asked for aggressive savings, so it is on the table: say "take the cheapest" and it goes on your canvas, with every trade-off said.' : 'Say "take the cheapest" if that is a trade you want to make.'}`, card);
      s.proposal = { kind: 'cheaper', token: rec.token, total: rec.total, delta: 0, label: 'What you have', improvements: [], tradeoffs: [], neutral: [], over: false, anyway: { token: ch.token, total: ch.total, delta: ch.total - t.total, label: `${money(ch.total)} version` }, silent: true };
      return;
    }
    const words = [...changeWords(rec.changes.neutral), ...changeWords(rec.changes.improvements)];
    this.propose(s, { kind: 'cheaper', token: rec.token, total: rec.total, delta: rec.total - t.total, label: 'Lowest I would recommend', improvements: changeWords(rec.changes.improvements), tradeoffs: changeWords(rec.changes.tradeoffs), neutral: changeWords(rec.changes.neutral), over: false, anyway: ch ? { token: ch.token, total: ch.total, delta: ch.total - t.total, label: `${money(ch.total)} version` } : null },
      `Lowest I would recommend: ${money(rec.total)}, ${money(t.total - rec.total)} less than now${words.length ? ` (${words.join('; ')})` : ''}${rec.changes.tradeoffs.length ? `; it means ${joinAnd(changeWords(rec.changes.tradeoffs))}` : ', nothing given up'}.${ch ? ` Absolute cheapest found: ${money(ch.total)}, but that means ${joinAnd(ch.whyNot)}; I don't recommend it.` : ''} Take the ${money(rec.total)} version${ch ? `, say "do it anyway" for ${money(ch.total)}` : ''}, or keep what you have.`, card);
  }

  // "Can it go any lower?" Yes only when a version I'd still recommend costs less; otherwise I stop.
  async cutMoreFlow(s, cur) {
    const settings = await this.settings();
    const v = savemax.saverVerdict(this.inv, cur.trip, settings, cur.ctx, { now: this.now(), locks: state.effectiveLocks(s) });
    if (v.canCut && v.alternative) { this.cheaperProposal(s, cur, v.alternative, 'Cheaper, still recommended', `${v.text} Take it, or keep what you have.`); return; }
    this.speak(s, v.text, v.cheapest ? { kind: 'howlow', current: cur.trip.total, recommend: { total: cur.trip.total, token: s.current.token, changes: { improvements: [], tradeoffs: [], neutral: [] } }, cheapest: { total: v.cheapest.total, token: v.cheapest.token, whyNot: v.cheapest.whyNot }, locks: state.lockedWords(s) } : null);
    if (v.cheapest) s.proposal = { kind: 'cheaper', token: s.current.token, total: cur.trip.total, delta: 0, label: 'What you have', improvements: [], tradeoffs: [], neutral: [], over: false, anyway: { token: v.cheapest.token, total: v.cheapest.total, delta: v.cheapest.total - cur.trip.total, label: `${money(v.cheapest.total)} version` }, silent: true };
  }

  // "Same trip for less": destination, length and the core of the stay held; dates, fares,
  // like-for-like hotels, room, transport and airport may move.
  async sameTripFlow(s, cur) {
    const settings = await this.settings();
    const locks = { ...state.effectiveLocks(s), dest: true, nights: true };
    const r = savemax.howLow(this.inv, cur.trip, settings, cur.ctx, { now: this.now(), locks });
    const t = cur.trip, rec = r.recommend;
    if (rec.total >= t.total) { this.speak(s, `I couldn't make the same trip cheaper: ${money(t.total)} is the lowest priced for ${plural(t.spec.nights, 'night')} in ${t.dest.name} with your rules, across the dates, fares and comparable hotels I can price.${r.cheapest ? ` The cheapest version there, ${money(r.cheapest.total)}, means ${joinAnd(r.cheapest.whyNot)}; that is not the same trip.` : ''}`); return; }
    const words = [...changeWords(rec.changes.neutral), ...changeWords(rec.changes.improvements)];
    this.cheaperProposal(s, cur, rec, 'Same trip for less', `Same trip, ${money(t.total - rec.total)} less: ${money(rec.total)} instead of ${money(t.total)}${words.length ? ` by ${joinAnd(words)}` : ''}${rec.changes.tradeoffs.length ? `; it means ${joinAnd(changeWords(rec.changes.tradeoffs))}` : '; destination, length and the stay unchanged'}. Take it, or keep what you have.`);
  }

  // "Where does money start buying something?" One priced version per kind of improvement, each
  // with nothing given up, at or under the ceiling; the traveler picks by letter.
  async breakpointsFlow(s, cur) {
    const settings = await this.settings();
    const q = cur.q, t = cur.trip;
    const bps = savemax.priceBreakpoints(this.inv, t, settings, cur.ctx, { now: this.now(), cap: q.budget, locks: state.effectiveLocks(s) });
    const partial = bps.truncated ? ' Not every version could be priced in this pass, so a breakpoint I did not reach may exist.' : '';
    if (!bps.length) { this.speak(s, `Up to ${money(q.budget)}, nothing I priced improves this trip without giving something up.${partial} I'd keep the ${money(q.budget - t.total)}.`); return; }
    s.breakpoints = bps.map((b, i) => ({ letter: 'ABCDE'[i], token: b.token, total: b.total, delta: b.delta, gets: b.gets, also: b.also }));
    s.pending = 'options';
    const spare = q.budget - t.total;
    this.speak(s, `Where money starts buying something, from ${money(t.total)}: ${s.breakpoints.map(b => `${b.letter}. +${money(b.delta)} buys ${b.gets.toLowerCase()}${b.also.length ? ` (and ${joinAnd(b.also.map(x => x.toLowerCase()))})` : ''}`).join('; ')}. Each is a priced version with nothing given up${spare > 0 ? `; you have ${money(spare)} unused` : ''}.${partial} Pick a letter, or keep the money.`, { kind: 'breakpoints', base: t.total, max: q.budget, items: s.breakpoints.map(b => ({ letter: b.letter, delta: b.delta, gets: b.gets, also: b.also, total: b.total, token: b.token })) });
  }

  // "How did you keep my cost down?" Sequential lines between the versions this conversation applied,
  // each priced again now; "you keep" is the maximum minus the final total.
  async receiptFlow(s, cur) {
    if (!cur || !s.history.length) { this.speak(s, cur ? `No change has been applied in this conversation yet: ${money(cur.trip.total)} is the trip as built, ${state.bookingBudget(s) ? `${money(state.bookingBudget(s) - cur.trip.total)} under your ${money(state.bookingBudget(s))}` : 'with no ceiling set'}. Say "find $100" or "how low can you go?" and the receipt starts.` : 'Nothing on the canvas yet.'); return; }
    const versions = [];
    for (const h of s.history) { const t = await this.priceToken(h.token); if (t) versions.push({ label: h.label, trip: t }); }
    const r = savemax.savingsReceipt(versions, state.bookingBudget(s));
    if (!r.lines.length) { this.speak(s, 'Only one version has been on the canvas, so there is nothing to subtract yet.'); return; }
    const saved = r.original - r.final;
    this.speak(s, `How we kept your cost down, step by step from ${money(r.original)} to ${money(r.final)}${saved >= 0 ? ` (${money(saved)} less)` : ` (${money(-saved)} more)`}: ${r.lines.map(l => `${l.label}: ${l.delta <= 0 ? '−' : '+'}${money(Math.abs(l.delta))}`).join('; ')}.${r.keep !== null ? ` You keep ${money(r.keep)} of your ${money(r.max)}.` : r.over ? ` The trip is ${money(r.over)} over your ${money(r.max)}, which you approved.` : ''} Each line is the live price of one version minus the one before it, so nothing is counted twice.`, { kind: 'receipt', lines: r.lines, original: r.original, final: r.final, max: r.max, keep: r.keep, over: r.over || null });
  }

  // "When can I go for less?" Today's prices for the same trip on every other departure date I can
  // search, never a forecast: the cheapest strong week, and the range of the windows actually priced.
  async weeksFlow(s, cur) {
    if (!cur) { this.speak(s, 'I don\'t predict prices. Build a trip first and I price the same trip on every other departure date I can search, today\'s prices only.'); return; }
    const settings = await this.settings();
    const locks = state.effectiveLocks(s);
    if (locks.dates) { this.speak(s, `Your departure is fixed on ${longDate(cur.trip.spec.depart)}, so that is the only date I priced. Say "my dates are flexible" and I price the other weeks I can search; I never predict what a date will cost.`); return; }
    const ctx = { ...cur.ctx, month: s.dateMode === 'flexible' ? s.month : null, dateMode: s.dateMode || 'anytime' };
    const out = weeks.cheapestWeeks(this.inv, cur.trip, settings, ctx, { now: this.now(), locks });
    const w = weeks.windowWords(out, { fmtDate: longDate });
    const t = cur.trip;
    // "Strong" only against a trip that is strong itself; a weaker trip is compared like for like.
    const std = out.standard === 'strong' ? 'strong' : 'comparable';
    // Every priced window but the trip itself.
    const others = out.windows.filter(x => x.token !== cur.token).slice(0, 5);
    const budget = state.bookingBudget(s);
    const partial = out.truncated ? ' Not every date could be priced in this pass.' : '';
    const weakAll = out.weak || [];
    const lockOut = weakAll.filter(x => x.kind === 'lock'), weakOther = weakAll.filter(x => x.kind !== 'lock');
    const why = weakOther.length ? (weakOther[0].kind === 'grade' ? `the same trip grades only "${weakOther[0].reason}" that week` : weakOther[0].reason) : '';
    const weak = `${weakOther.length ? ` ${plural(weakOther.length, 'other window')} I priced would mean a version I don't recommend (for example ${why}), so they are not offered.` : ''}${lockOut.length ? ` ${plural(lockOut.length, 'other date')} would need a change you locked (${lockOut[0].reason}), so they are not offered.` : ''}`;
    if (!out.windows.length) { this.speak(s, `No other departure date I can search prices this trip as one I'd recommend; ${longDate(t.spec.depart)} at ${money(t.total)} stands.${weak}${partial} Today's prices only; nothing predicted.`); return; }
    s.weeks = others.map((x, i) => ({ letter: 'ABCDE'[i], token: x.token, total: x.total, depart: x.depart }));
    const card = { kind: 'weeks', standard: std, current: { depart: t.spec.depart, ret: t.flight.return, total: t.total }, windows: others.map((x, i) => ({ letter: 'ABCDE'[i], depart: x.depart, ret: x.ret, total: x.total, delta: x.delta, sameDates: x.depart === t.spec.depart, hotelChanged: !!x.hotelChanged, flightChanged: !!x.flightChanged, changed: joinAnd(windowChanges(x)) || null, over: !!(budget && x.total > budget), token: x.token })), range: out.range, priced: out.priced, datesSearched: out.datesSearched, truncated: !!out.truncated, honesty: w.honesty, month: ctx.month };
    // `cheaper` is a window strictly cheaper than the trip in hand; a dearer week is never "the
    // cheapest week I found", and the trip's own dates are the answer when nothing beats them.
    const c = out.cheaper;
    if (!c) {
      this.speak(s, `Your dates are already the cheapest ${std} week I priced for this trip: ${longDate(t.spec.depart)} – ${longDate(t.flight.return)} at ${money(t.total)}.${w.compared ? ` ${w.compared}.` : ''}${others.length ? ' The other windows are below if a different week suits you better; each says what it changes besides the date.' : ''}${weak}${partial} ${w.honesty}`, others.length ? card : null);
      if (others.length) s.pending = 'options';
      return;
    }
    s.pending = 'options';
    const differs = joinAnd(windowChanges(c));
    this.speak(s, `Today's prices, not a forecast: the cheapest ${std} week I priced for this trip is ${w.headline}, ${money(t.total - c.total)} less than ${longDate(t.spec.depart)} at ${money(t.total)}.${differs ? ` That week is not identical: ${differs}; the card says so.` : ' Same hotel, same fare.'}${w.compared ? ` ${w.compared}.` : ''}${weak}${partial} Pick a letter to move to that week, or keep your dates. ${w.honesty}`, card);
  }

  // "Watch this trip": a real watch on the traveler's account with the rule they named, or the stated
  // default; re-priced when My Trips is opened, and it speaks only when the rule is met. Never a nudge.
  async watchFlow(s, u, cur, actor) {
    const closest = s.job && s.job.closest ? s.job.closest : null;
    const target = cur ? { token: s.current.token, total: cur.trip.total } : closest ? { token: closest.token, total: closest.total } : null;
    if (!target) { this.speak(s, 'There is no trip to watch yet. Give me a budget and a departure city first.'); return; }
    // The watch is set as the signed-in person this request belongs to, never as an id on the record.
    if (!actor) { this.speak(s, 'A watch lives on your account, so it outlives this conversation. Sign in (this conversation stays yours) and say "watch this trip" again, and tell me the rule if you want one: "tell me when it drops $50", "when it is under $1,200", or any drop.', { kind: 'link', href: `/signin?next=${encodeURIComponent(`/agent/${s.id}`)}`, label: 'Sign in to watch it' }); return; }
    const rule = u.updates.watchRule || WATCH_DEFAULT;
    let rec;
    try { rec = await this.svc.watchTrip(actor, target.token, { budget: state.bookingBudget(s), rule }); } catch (e) { if (e instanceof AppError) { this.speak(s, e.message); return; } throw e; }
    this.speak(s, `Watching it. ${rec.ruleText}. I re-price it each time you open My Trips and say something only when that rule is met${u.updates.watchRule ? '' : '; say "tell me when it drops $50" or "when it is under $1,200" for a different rule'}. No other nudges, ever.${this.svc.demo ? ' Email alerts arrive once notifications are connected.' : ''}`, { kind: 'link', href: '/my-trips', label: 'Your watches in My Trips' });
  }

  // ---- the money leak hunter: what the traveler is paying for that they may not need ----------------
  // "We don't just find cheaper. We find what you don't need to pay for." Every number in these flows
  // is leaks.js's, which is priceTrip's: a removal is a priced version of the trip without the item,
  // and its saving is the difference of two totals. No flow removes anything: each is a proposal the
  // traveler takes or keeps, nothing optional is preselected, and the verdict on what is worth its
  // money comes from what the traveler stated, never from margin. The only facts handed to the engine
  // are the ones the traveler said (null when unknown) and the locks every engine honours.
  leakOpts(s) {
    return { now: this.now(), locks: state.effectiveLocks(s), prefs: { style: s.style, priority: s.priority, who: s.who, bags: s.bags, rules: state.rulesOf(s), nightsAsked: s.nightsStated ? s.nights : null }, promo: null };
  }
  async leakScan(s, cur) { return leaks.finalScan(this.inv, cur.trip, await this.settings(), cur.ctx, this.leakOpts(s)); }
  // The ceiling gate every proposal shares: a version that costs more than now and ends above the
  // booking budget waits for "go over" (the maximum is a ceiling, and only the traveler's word crosses
  // it); a version cheaper than now never waits, since it only lowers an overrun they already approved.
  overCeiling(s, total, from) { const budget = state.bookingBudget(s); return !!(budget && total > budget && total > from); }
  // A leak found by the scan as a proposal, worded by what its version actually is, read off its token
  // rather than the check it came from: the scan's "bags" check finds either the bag add-on itself (the
  // same fare without the bought bag: a removal, "Without <bag>", "<bag> comes out") or a cheaper fare
  // that carries the same bags (the engine's own label, "<fare>: <bags> instead of <fare>: <bags>",
  // which is never called a removal); an add-on, a duplicate or the transfer is a removal; the
  // like-for-like version keeps the engine's label, which names what it differs on. A note the engine
  // attached (a promo code the removal ends) travels with the words, so the saving said is the real
  // drop in the total. None carries a trade-off by construction.
  leakProposal(found, t, extra = {}) {
    const spec = decodeSpec(found.token), s0 = t.spec;
    const sameFareNoBag = spec.flight === s0.flight && spec.from === s0.from && spec.bags === false && !!s0.bags;
    const removal = found.key !== 'config' && (found.key !== 'bags' || sameFareNoBag);
    const fare = found.key === 'bags' && !removal ? (t.flightOptions || []).find(f => f.id === spec.flight) : null;
    const neutral = removal ? [`${found.label} comes out`] : found.key === 'bags' ? [`the same bags on the ${fare ? fare.name : spec.flight} fare`] : ['like-for-like: nothing given up by the facts'];
    if (found.note) neutral.push(cap(found.note));
    // A leak's version is cheaper than now by construction, so it never waits at the ceiling (see overCeiling).
    return { kind: 'leak', token: found.token, total: found.total, delta: found.total - t.total, label: removal ? `Without ${found.label}` : cap(found.label), improvements: [], tradeoffs: [], neutral, over: false, ...extra };
  }
  async scorecardFor(s, cur) { return leaks.scorecard({ max: state.bookingBudget(s), trip: cur.trip, history: s.history.map(h => ({ token: h.token, label: h.label })) }, this.inv, await this.settings()); }
  scorecardCard(sc) { return { kind: 'scorecard', max: sc.max, current: sc.current, notUsed: sc.notUsed, over: sc.over, extrasRemoved: sc.extrasRemoved, dateDifference: sc.dateDifference, transportDifference: sc.transportDifference, hotelDifference: sc.hotelDifference, lines: sc.lines, mixed: sc.mixed, independent: sc.independent, note: sc.note }; }

  // "What am I paying for?" Every material dollar, rows that sum to the total, no mystery line.
  async payingFlow(s, cur) {
    const b = leaks.breakdown(cur.trip, this.leakOpts(s));
    const optional = b.optionalTotal > 0 ? `The ${money(b.optionalTotal)} of optional extras is the only part you could take out; ` : 'Nothing optional is in this price; ';
    this.speak(s, `${b.text} ${optional}taxes, mandatory fees and the service fee (${money(b.mandatoryTotal)}) are in the total and stay whatever you remove.`, { kind: 'breakdown', rows: b.rows, total: b.total, mandatoryTotal: b.mandatoryTotal, optionalTotal: b.optionalTotal, coreTotal: b.coreTotal });
  }

  // What the data cannot compare, said as such and never as a checkout or a cheaper version: the
  // engine's own line for each thing asked (no second booking channel, package rate, one-way fare,
  // split stay, points or exchange rate is in the inventory; no seat fee is in this price; parking is
  // not priced), so no saving is claimed or denied from any of them, and nothing is proposed.
  async notComparedFlow(s, cur, text) {
    const t = cur.trip, lower = text.toLowerCase();
    const na = leaks.notAvailable(t), line = k => { const l = na.find(x => x.key === k); return l ? l.text : null; };
    const asked = NOT_COMPARED.filter(([, re]) => re.test(lower)).map(([k]) => k);
    const items = asked.map(k => (k === 'seat' ? leaks.seatFees(t).text
      : k === 'parking' ? `${leaks.hotelFees(t).parking.text}: I don't price parking, so I can't say whether this hotel charges for it.`
      // The engine lists the currency line for international trips; a domestic trip priced in USD gets the same fact.
      : k === 'currency' ? line(k) || 'Everything is priced in USD, and I don\'t convert it: no exchange rate is in our data, so no currency saving is claimed.'
      : line(k))).filter(Boolean);
    if (!items.length) items.push(...na.map(x => x.text));
    this.speak(s, `${items.join(' ')} Your trip stays at ${money(t.total)}; nothing is proposed from this.`, { kind: 'facts', title: 'Not compared here', items, href: `/trip/${s.current.token}/leaks?${optimizer.contextParams(cur.ctx)}#notCompared`, label: 'Everything this price is compared with, and what it is not' });
  }

  // "Strip it down": the same flights, hotel, dates and nights with every optional item a stated rule
  // does not ask for taken out, priced in full, beside what each item costs to add back alone and
  // whether it is worth it by what the traveler said. The customer decides: the lean version is a
  // proposal, and the card says what it gives up.
  async stripFlow(s, cur) {
    const settings = await this.settings(), o = this.leakOpts(s), t = cur.trip;
    const L = leaks.lean(this.inv, t, settings, cur.ctx, o);
    const addBack = L.difference > 0 ? leaks.addBack(this.inv, L.lean.trip, L.removed, settings, cur.ctx, o) : [];
    // `kept` is only what the lean version's own facts meet; a stated rule this trip breaks is `notKept`,
    // said as such and never listed under Kept. The engine's text already carries both when it has them.
    const notKept = L.notKept || [];
    const card = { kind: 'lean', current: { total: L.current.total, token: L.current.token }, lean: { token: L.lean.token, total: L.lean.total }, difference: L.difference, givesUp: L.givesUp, kept: L.kept, notKept, addBack };
    const keptWords = /\bKept: /.test(L.text) ? '' : ` Kept: ${joinAnd(L.kept)}.${notKept.length ? ` Not met by this trip: ${joinAnd(notKept)}.` : ''}`;
    if (L.difference <= 0) { this.speak(s, `${L.text}${keptWords}`, card); return; }
    this.propose(s, { kind: 'lean', token: L.lean.token, total: L.lean.total, delta: L.lean.total - t.total, label: 'Lean version', improvements: [], tradeoffs: L.givesUp, neutral: [], over: false }, `${L.text}${keptWords}`, card);
  }

  // "Add back what's worth it": on the lean version the traveler took, each item of the trip it was
  // stripped from priced back alone onto what is on the canvas now (an item already back is left
  // out by the engine); "Add back <item>" proposes that one. On any other trip nothing was taken
  // out, so the verdicts are said and the lean version is pointed to, never assumed.
  async addBackFlow(s, cur, text) {
    const settings = await this.settings(), o = this.leakOpts(s), t = cur.trip;
    const core = x => [x.spec.dest, x.spec.from, x.spec.depart, x.spec.nights, x.spec.travelers, x.spec.hotel, x.spec.flight].join('|');
    let original = s.leanOf ? await this.priceToken(s.leanOf) : null;
    if (original && core(original) !== core(t)) { original = null; s.leanOf = null; } // the canvas moved on: no longer a lean version of that trip
    const m = text.toLowerCase().match(/\badd back\s+(.+?)[.!?]*\s*$/);
    const want = m && !/^what(?:'s| is) worth it$/.test(m[1].trim()) ? m[1].trim() : null;
    if (!original) {
      const L = leaks.lean(this.inv, t, settings, cur.ctx, o);
      const items = L.difference > 0 ? leaks.addBack(this.inv, L.lean.trip, L.removed, settings, cur.ctx, o) : [];
      if (!items.length) { this.speak(s, 'Nothing optional is in this price, so there is nothing to strip and nothing to add back.'); return; }
      this.speak(s, `Your trip is not a lean version, so nothing was taken out to add back. What each optional item in it is worth, by what you told me: ${items.map(i => i.text).join('; ')}. Say "strip it down" to see the lean version and take it; then add back what's worth it.`, { kind: 'addback', onLean: false, lean: { token: L.lean.token, total: L.lean.total }, items });
      return;
    }
    const removed = leaks.lean(this.inv, original, settings, cur.ctx, o).removed;
    const items = leaks.addBack(this.inv, t, removed, settings, cur.ctx, o);
    if (want) {
      // The item is matched loosely, by the words of its key or label ("the transfer", "bags", "a
      // checked bag", part of an experience's name), never only by its exact label; two items the words
      // fit equally are asked about, never guessed between.
      const words = itemWords(want);
      const fits = items.filter(x => wordsFit(words, `${x.key} ${x.label}`));
      const it = items.find(x => x.label.toLowerCase() === want) || (fits.length === 1 ? fits[0] : null);
      if (!it && fits.length > 1) { this.speak(s, `"${want}" fits more than one item here: ${joinAnd(fits.map(x => x.label))}. Say which one.`); return; }
      if (!it) { this.speak(s, `"${want}" is not something I can add back here. ${items.length ? `I can price back ${joinAnd(items.map(x => x.label))}.` : 'Everything stripped from this trip is already back.'}`); return; }
      // Adding back costs more: a total above the ceiling waits for "go over" like every dearer version.
      const budget = state.bookingBudget(s), over = this.overCeiling(s, it.total, t.total);
      this.propose(s, { kind: 'addBack', token: it.token, total: it.total, delta: it.total - t.total, label: `Add back ${it.label}`, itemKey: it.key, improvements: [it.label], tradeoffs: [], neutral: [], over },
        `${it.text}. Total ${money(it.total)}${over ? `, ${money(it.total - budget)} over your ${money(budget)} ceiling. Say "go over" to take it anyway, or keep what you have.` : '. Take it, or keep what you have.'}`);
      return;
    }
    if (!items.length) { this.speak(s, `Everything stripped from this trip is already back: ${money(t.total)} is what you have.`); return; }
    this.speak(s, `Add back what's worth it, each priced alone onto the ${money(t.total)} version you have: ${items.map(i => i.text).join('; ')}. Say "add back" and the item's name, and I put that version on the table.`, { kind: 'addback', onLean: true, lean: { token: s.current.token, total: t.total }, items });
  }

  // "Remove one thing": the lowest-value optional component, by what the traveler stated; a proposal,
  // never a removal. When every optional item is one they asked for, or nothing is optional, that is said.
  async removeOneFlow(s, cur) {
    const settings = await this.settings(), o = this.leakOpts(s), t = cur.trip;
    const r = leaks.removeOne(this.inv, t, settings, cur.ctx, o);
    if (r) { this.propose(s, { kind: 'removeOne', token: r.token, total: r.total, delta: r.total - t.total, label: `Without ${r.label}`, improvements: [], tradeoffs: [`${r.label} comes out (${r.why})`], neutral: [], over: false }, `${r.text} Remove it, or keep it.`); return; }
    // Why each item stays is the engine's sentence: "one you asked for" only when every reason is a
    // stated ask; a transfer kept because the flight lands late is the engine's reading, said as such.
    const k = leaks.whyKept(this.inv, t, settings, cur.ctx, o);
    if (!k.items.length) { this.speak(s, 'Nothing optional is in this price: flights, the stay, taxes, mandatory fees and the service fee only. There is nothing to remove.'); return; }
    this.speak(s, `${k.text} Say which one and I'll price it.`, { kind: 'facts', title: k.allStated ? 'Optional, and asked for' : 'Optional, and kept by what you told me', items: k.items.map(e => `${e.label} (${money(e.amount)} of the total): ${e.why}`), href: `/trip/${s.current.token}?${optimizer.contextParams(cur.ctx)}#customize`, label: 'Take one out in the customizer' });
  }

  // "Find my biggest leak": the largest avoidable cost present, priced; a candidate without a trade-off
  // always ranks first, and one with a trade-off says it. The chip under the card ("Show me the
  // <alternative> version") puts that version on the table; nothing comes out until it is taken.
  async biggestLeakFlow(s, cur, { show = false, text = '' } = {}) {
    const t = cur.trip;
    const b = leaks.biggestLeak(this.inv, t, await this.settings(), cur.ctx, this.leakOpts(s));
    if (!b) { this.speak(s, 'I don\'t see an avoidable cost in this price: nothing optional, no duplicate, and no like-for-like cheaper version.'); return; }
    // Every difference between the trip and that version, by the facts, said before the traveler takes
    // it: a removal names the item that comes out and anything else that differs; a fare or hotel swap
    // with no trade-off still differs in neutral facts (the fare's name, its times, a hotel of the same
    // class), and those are listed rather than hidden under "nothing else changes", which is said only
    // when the facts find no other row. A trade-off the engine named is said in its words.
    const alt = await this.priceToken(b.token);
    const ch = alt ? classifyChanges(t, alt) : { improvements: [], neutral: [], tradeoffs: [] };
    const item = b.kind === 'extra' || b.kind === 'duplicate';
    const own = new Set(item ? ['experiences', 'transfer', 'bags'] : []);
    const differs = changeWords([...ch.improvements, ...ch.neutral, ...(b.tradeoff ? [] : ch.tradeoffs)].filter(r => !own.has(r.key)));
    const otherWords = b.tradeoff ? (differs.length ? ` It also differs: ${joinAnd(differs)}.` : '') : differs.length ? ` ${item ? 'What else differs' : 'What differs'}, by the facts: ${joinAnd(differs)}.` : ' Nothing else changes.';
    const note = b.note ? ` ${cap(b.note)}.` : '';
    const card = { kind: 'leak', leakKind: b.kind, label: b.label, alternativeLabel: b.alternativeLabel, current: b.current, alternative: b.alternative, difference: b.difference, token: b.token, total: b.total, tradeoff: b.tradeoff, differs, note: b.note || null, text: b.text };
    // "Show me the <alternative> version" puts the version on the table only when the words name the
    // alternative the card shows; any other "show me the ... version" gets the card, never a version
    // it did not ask for. The chip's words name no item, so the leak is read again off the canvas as it
    // is now and compared with the card the traveler last saw: a canvas that moved since (the item was
    // removed, another applied) gets the new card and a sentence saying so, never a different item
    // proposed under the old card's words.
    if (show && !text.toLowerCase().includes(b.alternativeLabel.toLowerCase())) show = false;
    const seen = [...s.messages].reverse().map(m => m.card).find(c => c && c.kind === 'leak') || null;
    const moved = show && (!seen || seen.token !== b.token || seen.label !== b.label);
    if (!show || moved) {
      const lead = moved ? (seen ? `The canvas moved since that card, so I read it again: the biggest avoidable cost is now ${b.label}. ` : 'Here is the biggest avoidable cost on your canvas first. ') : '';
      this.speak(s, `${lead}${b.text}${otherWords} Say "show me ${leaks.showWords(b)}" and I put it on the table; nothing comes out until you take it.`, card);
      return;
    }
    const label = item ? `Without ${b.label}` : b.alternativeLabel;
    const neutral = [...(item ? [`${b.label} comes out`] : []), ...differs, ...(b.note ? [cap(b.note)] : [])];
    this.propose(s, { kind: 'leak', token: b.token, total: b.total, delta: b.total - t.total, label, improvements: [], tradeoffs: b.tradeoff ? [b.tradeoff] : [], neutral, over: false },
      `${item ? `${b.label} comes out` : b.alternativeLabel}: ${money(b.total)}, ${money(b.difference)} less than now.${b.tradeoff ? ` It changes: ${b.tradeoff}.` : ''}${otherWords}${note} Take it, or keep what you have.`);
  }

  // "Money leak check" on demand: the six checks the scan runs before paying, and the one leak it
  // would remove without changing the trip, as a proposal.
  async leakScanFlow(s, cur, { amount = null } = {}) {
    const f = await this.leakScan(s, cur);
    const card = { kind: 'scan', checks: f.checks, found: f.found, text: f.text };
    // "Remove $148" names a saving: when no removal of that amount is on the table, that is said first,
    // on its own, so the scan's sentence still reads exactly as the engine wrote it.
    if (amount !== null && !(f.found && f.found.amount === amount)) this.speak(s, `No ${money(amount)} removal is on the table now; here is the check on the trip as it is.`);
    if (f.found) { this.propose(s, this.leakProposal(f.found, cur.trip), `${f.text} Remove it, or keep it.`, card); return; }
    this.speak(s, f.text, card);
  }

  // "Cut $200 in order": money taken out in the spec's fixed order, one priced change per step,
  // stopping at the target; rules and locks are never relaxed, and a stage they forbid says why. The
  // result is a proposal whether or not the target was reached; how far it got is said either way.
  async cutInOrderFlow(s, cur, amount) {
    const t = cur.trip, budget = state.bookingBudget(s);
    const target = amount ? t.total - amount : budget && t.total > budget ? budget : null;
    // The question waits for its answer: a bare "$200" next is the amount to cut, never a budget.
    if (target === null) { s.pending = 'cutBy'; this.speak(s, `How much do you want to cut? Say "cut $200 in order" and I take money out in a fixed order (${leaks.PRIORITY_ORDER.map(k => leaks.ORDER_LABELS[k].toLowerCase()).join(', ')}), one priced change at a time, stopping as soon as the total is there. Your rules and locks are never relaxed.`); return; }
    if (target < 10000) { this.speak(s, `${money(amount)} off would take the trip under ${money(10000)}; nothing we sell is that cheap. Name a smaller amount.`); return; }
    const c = leaks.cutInOrder(this.inv, t, await this.settings(), cur.ctx, target, this.leakOpts(s));
    const card = { kind: 'cut', target: c.target, reached: c.reached, final: { token: c.final.token, total: c.final.total }, steps: c.steps.map(st => ({ ...st, stageLabel: leaks.ORDER_LABELS[st.stage] })), skipped: c.skipped.map(k => ({ ...k, stageLabel: leaks.ORDER_LABELS[k.stage] })), order: leaks.PRIORITY_ORDER.map(k => leaks.ORDER_LABELS[k]) };
    if (!c.steps.length) { this.speak(s, c.text, card); return; }
    const gives = [...new Set(c.steps.flatMap(st => st.givesUp))];
    this.propose(s, { kind: 'cut', token: c.final.token, total: c.final.total, delta: c.final.total - t.total, label: c.reached ? 'Cut in order' : 'Cut in order, as far as it goes', improvements: [], tradeoffs: gives, neutral: [], over: false },
      `${c.text} ${c.reached ? 'Take it, or keep what you have.' : `The ${money(c.final.total)} version is on the table: take it, or keep what you have.`}`, card);
  }

  // "Free savings": the cheaper version with nothing given up by the facts, and, apart from it, the
  // cheapest strong version that gives something up with what it costs. Two objects, two chips, never
  // one number; each chip proposes its version.
  async freeSavingsFlow(s, cur, text) {
    const t = cur.trip, lower = text.toLowerCase();
    const f = leaks.freeSavings(this.inv, t, await this.settings(), cur.ctx, this.leakOpts(s));
    if (/take the free savings/.test(lower)) {
      if (!f.free) { this.speak(s, 'No free saving is priced for this trip right now: nothing at least $25 cheaper with nothing given up, by the facts.'); return; }
      // A free version gives nothing up by the facts, but it is not one where nothing differs: every
      // difference the engine found (a moved departure date first) is said before the traveler takes
      // it, and "nothing given up" is said only when the facts differ in no more than the fare's name.
      const differs = f.free.differs || [], material = differs.filter(d => !/^Flights: /.test(d));
      this.propose(s, { kind: 'free', token: f.free.token, total: f.free.total, delta: f.free.delta, label: 'Free savings', improvements: [], tradeoffs: [], neutral: [...differs, ...f.free.same], over: false },
        `${f.free.text}${material.length ? ` Before you take it: ${joinAnd(differs)}. No trade-off by the facts.` : differs.length ? ` ${joinAnd(differs)}; nothing given up by the facts.` : ' Nothing given up by the facts.'} Take it, or keep what you have.`);
      return;
    }
    if (/take the trade-?off version/.test(lower)) {
      if (!f.sacrifice) { this.speak(s, `No trade-off version is priced below ${f.free ? 'the free version' : 'what you have'} right now.`); return; }
      this.propose(s, { kind: 'sacrifice', token: f.sacrifice.token, total: f.sacrifice.total, delta: f.sacrifice.delta, label: 'Trade-off version', improvements: [], tradeoffs: f.sacrifice.but, neutral: [], over: false }, `${f.sacrifice.text} Total ${money(f.sacrifice.total)}, ${money(-f.sacrifice.delta)} less than now. Take it, or keep what you have.`);
      return;
    }
    const slim = x => (x ? { token: x.token, total: x.total, delta: x.delta, same: x.same || null, differs: x.differs || null, but: x.but || null, text: x.text } : null);
    const free = f.free ? f.free.text : 'No free saving: no version of this trip is priced at least $25 lower with nothing given up (same hotel, nights, dates, bags and experiences by the facts).';
    const sacrifice = f.sacrifice ? `Apart from that, ${f.sacrifice.text}` : `No trade-off version is priced below ${f.free ? 'it' : 'what you have'} either.`;
    const hints = [f.free ? '"take the free savings"' : null, f.sacrifice ? '"take the trade-off version"' : null].filter(Boolean);
    this.speak(s, `${free} ${sacrifice} The two are never one number.${hints.length ? ` Say ${hints.join(' or ')}, or keep what you have.` : ''}`, { kind: 'free', free: slim(f.free), sacrifice: slim(f.sacrifice) });
  }

  // "Savings scorecard": max, current, not used, and what each kind of applied step made; a step
  // that changed two things is listed on its own and counted nowhere, and nothing is added together.
  async scorecardFlow(s, cur) {
    const sc = await this.scorecardFor(s, cur);
    this.speak(s, `${sc.text}${s.history.length > 1 ? '' : ' No step has been applied in this conversation yet, so there is nothing to subtract.'}`, this.scorecardCard(sc));
  }

  // ---- hunt mode: "I can wait. Only come back when my money can do something better." ----------------
  // A hunt is a record on the account (server/trips/hunts.js) that the service re-runs on its own; the
  // conversation only refers to it by id and name, on the mission when there is one (so the canvas can
  // show it) and on the conversation itself otherwise, together with the input it was started from, so
  // a later "hunt for a better deal" can say exactly what changed here since. Every number spoken here
  // is the record's. Every account action is taken as the signed-in person this request belongs to
  // (`actor`, from the route), never as an id stored on the conversation: a browser that signed out,
  // or signed into another account, cannot start, change or stop a hunt on the first account.
  huntRef(s) { return (s.mission ? s.mission.hunt : s.hunt) || null; }
  setHuntRef(s, hunt, input = null) {
    const prev = this.huntRef(s);
    const ref = hunt ? { id: hunt.id, name: hunt.name, status: hunt.status, input: input || (prev && prev.id === hunt.id ? prev.input || null : null) } : null;
    if (s.mission) s.mission.hunt = ref; else s.hunt = ref;
    return ref;
  }
  // The signed-in person this turn acts for, when the conversation is theirs; nobody otherwise.
  actorFor(s, user) { return user && user.id && s.userId && user.id === s.userId ? { id: user.id } : null; }
  // Sign in first: an anonymous conversation is told what a hunt is; an account's conversation reached
  // without its owner signed in (a browser that signed out) is told who can act on it.
  signInToHunt(s, what = null) {
    const w = what || (s.userId ? 'start the hunt' : null);
    this.speak(s, w ? `A hunt lives on your account, so only you, signed in, can ${w} from here. Sign in and say it again.` : 'A hunt lives on your account, so it keeps checking after this conversation. Sign in (this conversation stays yours) and say "hunt for a better deal" again.', { kind: 'link', href: `/signin?next=${encodeURIComponent(`/agent/${s.id}`)}`, label: what ? 'Sign in' : 'Sign in to start the hunt' });
  }

  // The hunt's rules from the trip object: every hard rule the mission panel lists that a hunt can hold
  // (the ceiling, where from, who, the window as a month, the place, nonstop, stars, meals, bags,
  // refundable, beachfront, an included transfer, what matters most), with the same stated defaults the
  // search uses, so "this meets the rules you gave me" is true of the rules given here. A hunt searches
  // a window, never one date, so an exactly stated departure becomes its month, and that is said. A
  // length the traveler named, chose or saved is the hunt's exact length (an extra night is then not a
  // win they asked about); otherwise the trip on the canvas gives the minimum and the range is said.
  huntInput(s, cur) {
    const travelers = s.travelers || (s.who ? optimizer.WHO_DEFAULT[s.who] : 2);
    const who = s.who || (travelers === 1 ? 'solo' : travelers === 2 ? 'couple' : 'friends');
    const month = s.dateMode === 'flexible' && s.month ? s.month : s.dateMode === 'exact' && s.depart ? s.depart.slice(0, 7) : null;
    const fixed = !!s.nights || !!(s.locks.nights && cur);
    const nights = s.nights || (cur ? cur.trip.spec.nights : 3);
    // The place: a destination named, or locked (the canvas trip's, when locked without a name); else
    // the country left out ("try another country") as the destinations the inventory has there.
    const dest = s.destination || (s.locks.dest && cur ? cur.trip.dest.id : null);
    const notCountry = !dest && s.notCountry ? s.notCountry : null;
    const excludeDests = notCountry ? this.maps.listDestinations().filter(d => optimizer.sameCountry(d.country, notCountry)).map(d => d.id) : [];
    const savedToken = s.current ? s.current.token : null;
    return {
      budget: state.bookingBudget(s), origin: s.origin, travelers, who, dateMode: month ? 'flexible' : 'anytime', month,
      minNights: nights, maxNights: fixed ? nights : null, style: s.style || 'surprise', priority: s.priority || null,
      dest, region: s.region === 'international' ? 'international' : null, excludeDests,
      rules: {
        flightStops: s.flightStops === 'nonstop' ? 'nonstop' : null, flightRule: s.flightStops === 'nonstop' ? (s.flightRule === 'hard' ? 'hard' : 'preferred') : null,
        minStars: s.hotelRules.minStars || null, refundable: s.refundable ? true : null,
        meals: s.hotelRules.allInclusive ? 'all-inclusive' : s.hotelRules.breakfast ? 'breakfast' : null, bags: s.bags || null,
        beachfront: s.hotelRules.beachfront ? true : null, transfer: s.transfer ? true : null,
      },
      savedToken,
      notify: HUNT_NOTIFY_KINDS.filter(k => (k !== 'beat-saved' || savedToken) && (k !== 'extra-night' || !fixed)),
      threshold: s.huntThreshold || HUNT_THRESHOLD[s.savingsLevel] || HUNT_THRESHOLD.balanced,
      savingsLevel: s.savingsLevel || 'balanced',
    };
  }

  // What a hunt cannot keep: it searches every hotel and every fare inside the rules on every date of
  // its window, so a locked hotel, locked flights or locked dates are rules it would break. They are
  // never dropped in silence: the traveler is asked once (huntWithout remembers the locks they let the
  // hunt go without), and the answer is said back with the hunt.
  huntLocks(s) { return [s.locks.hotel ? 'the hotel you locked' : null, s.locks.flight ? 'the flights you locked' : null, s.locks.dates ? 'the dates you locked' : null].filter(Boolean); }
  huntCannotKeep(s) { const ok = Array.isArray(s.huntWithout) ? s.huntWithout : []; return this.huntLocks(s).filter(l => !ok.includes(l)); }

  // What changed on this conversation since the hunt was started from it, in words: the input the hunt
  // was made with (validated, as the ref keeps it) against the input it would be made with now. A rule
  // the hunt moved through its own answers (more nights, a better hotel) is not a difference: that was
  // the traveler's word on the hunt itself. Each line names the rule and both values; `improve` names
  // the hunt answer that takes the new rule exactly, when one does (only a hard nonstop rule).
  huntDiff(had, now) {
    if (!had) return [];
    const out = [];
    const diff = (key, text, improve = null) => out.push({ key, text, improve });
    const city = o => { const c = o && this.maps.getOrigin(o); return c ? c.city : o; };
    const destName = d => (d ? (this.maps.getDestination(d) || { name: d }).name : 'anywhere');
    const range = i => (i.maxNights === i.minNights ? plural(i.minNights, 'night') : `${i.minNights} to ${i.maxNights} nights`);
    const onOff = v => (v ? 'on' : 'off');
    const thr = t => (Number.isFinite(t) ? dollars(t) : 'what I would recommend');
    if (had.budget !== now.budget) diff('budget', `the limit (${money(had.budget)} then, ${money(now.budget)} now)`);
    if (had.origin !== now.origin) diff('origin', `where you fly from (${city(had.origin)} then, ${city(now.origin)} now)`);
    if (had.travelers !== now.travelers || had.who !== now.who) diff('travelers', `who is going (${plural(had.travelers, 'traveler')} then, ${plural(now.travelers, 'traveler')} now)`);
    if ((had.month || null) !== (now.month || null)) diff('window', `the window (${had.month ? monthWords(had.month) : 'anytime'} then, ${now.month ? monthWords(now.month) : 'anytime'} now)`);
    if (had.minNights !== now.minNights || had.maxNights !== now.maxNights) diff('nights', `the length (${range(had)} then, ${range(now)} now)`);
    if (had.style !== now.style) diff('style', `the style (${had.style} then, ${now.style} now)`);
    if ((had.priority || null) !== (now.priority || null)) diff('priority', `what matters most (${had.priority || 'nothing named'} then, ${now.priority || 'nothing named'} now)`);
    if ((had.dest || null) !== (now.dest || null)) diff('dest', `the destination (${destName(had.dest)} then, ${destName(now.dest)} now)`);
    if ((had.region || null) !== (now.region || null)) diff('region', `international only (${onOff(had.region)} then, ${onOff(now.region)} now)`);
    const left = i => [...(i.excludeDests || [])].sort().map(destName).join(', ') || 'none';
    if (left(had) !== left(now)) diff('excludeDests', `the destinations left out (${left(had)} then, ${left(now)} now)`);
    const hr = had.rules || {}, nr = now.rules || {};
    const ns = r => (r.flightStops === 'nonstop' ? (r.flightRule === 'hard' ? 'a hard rule' : 'preferred') : 'not a rule');
    if (ns(hr) !== ns(nr)) diff('nonstop', `nonstop (${ns(hr)} then, ${ns(nr)} now)`, ns(nr) === 'a hard rule' ? 'nonstop' : null);
    if ((hr.minStars || null) !== (nr.minStars || null)) diff('minStars', `the hotel minimum (${hr.minStars ? `${hr.minStars}-star` : 'none'} then, ${nr.minStars ? `${nr.minStars}-star` : 'none'} now)`);
    if ((hr.meals || null) !== (nr.meals || null)) diff('meals', `meals (${hr.meals || 'no rule'} then, ${nr.meals || 'no rule'} now)`);
    if ((hr.bags || null) !== (nr.bags || null)) diff('bags', `bags (${hr.bags || 'no rule'} then, ${nr.bags || 'no rule'} now)`);
    if (!!hr.refundable !== !!nr.refundable) diff('refundable', `refundable only (${onOff(hr.refundable)} then, ${onOff(nr.refundable)} now)`);
    if (!!hr.beachfront !== !!nr.beachfront) diff('beachfront', `beachfront (${onOff(hr.beachfront)} then, ${onOff(nr.beachfront)} now)`);
    if (!!hr.transfer !== !!nr.transfer) diff('transfer', `an included airport transfer (${onOff(hr.transfer)} then, ${onOff(nr.transfer)} now)`);
    if ((had.savedToken || null) !== (now.savedToken || null)) diff('savedToken', 'the trip to beat (the trip on the canvas changed since)');
    if (had.threshold !== now.threshold) diff('threshold', `the saving worth an interruption (${thr(had.threshold)} then, ${thr(now.threshold)} now)`);
    if (had.savingsLevel !== now.savingsLevel) diff('savingsLevel', `the savings level (${had.savingsLevel} then, ${now.savingsLevel} now)`);
    return out;
  }

  // What runs for a hunt, in the service's own words (the timer, the open, the silence), with where a
  // find appears said for this place: on the hunt's page and in My Trips. Not "here": this conversation
  // learns of a find only when the agent next speaks of the hunt, and a sentence that promised more
  // would promise monitoring the conversation does not do.
  huntMonitoring() {
    const t = this.hunts.monitoringText();
    return t.replace('What it finds appears here and in My Trips', 'What it finds appears on the hunt page and in My Trips');
  }

  // The compact card: the persistent card's facts from the record alone (the limit, the status, the
  // trip the hunt stands on as its last check verified it, what it keeps, when that check was), plus
  // the newest decision. Nothing is priced here: a price looked up with no judgement (is the departure
  // still ahead, is it still under the limit, does it still pass the rules) is not a "best current
  // opportunity"; the service's own check is (huntChecked), and the record says when it was.
  huntCardFor(hunt, { opportunity = null } = {}) {
    const b = hunt.baseline && hunt.baseline.best ? hunt.baseline.best : null;
    let best = null;
    if (b && opportunity && opportunity.trip && opportunity.trip.token === b.token) best = { ...opportunity.trip, recorded: true };
    else if (b) { const d = this.maps.getDestination(b.dest); best = { token: b.token, total: b.total, nights: b.nights, dest: d ? d.name : b.dest, destId: b.dest, stops: b.stops, hotel: { stars: b.stars }, recorded: true }; }
    return { kind: 'hunt', hunt: { id: hunt.id, name: hunt.name, budget: hunt.budget, status: hunt.status, best, kept: best ? hunt.budget - best.total : null, opportunity, checked: hunt.lastRunAt ? stampOf(hunt.lastRunAt) : null, underRules: !!hunt.baseline } };
  }

  // The record once the service has had its chance to re-check it (hunts.refresh: a run only when the
  // last check is older than its own limit, never for a stopped hunt), so the card shows what a check
  // verified. A check that ran here is said, with what it found or why it stayed quiet; so is a hunt
  // the check stopped (a month with nothing left to price).
  async huntChecked(actor, hunt) {
    const fresh = await this.hunts.refresh(actor, hunt.id);
    const ran = fresh.lastRunAt !== hunt.lastRunAt;
    const run = ran ? fresh.runs[fresh.runs.length - 1] : null;
    const opp = run && run.opportunities ? fresh.opportunities[fresh.opportunities.length - 1] : null;
    let words = '';
    if (opp) words = ` I checked it again just now. ${hunter.decisionText(opp, fresh)}`;
    else if (ran) words = ` I checked it again just now, its last check being more than ${intervalWords(HuntService.REFRESH_MAX_AGE_MINUTES)} old: ${run.silent}.`;
    else if (fresh.status !== hunt.status && fresh.learned.length) words = ` ${fresh.learned[fresh.learned.length - 1].text}.`;
    return { hunt: fresh, ran, opp, words, card: this.huntCardFor(fresh, { opportunity: opp }) };
  }

  // "Hunt for a better deal": a hunt on the account with this conversation's rules, run once now, and
  // only the words that are true of what runs later. Anonymous travelers sign in first; nothing is
  // stored for them. A lock a hunt cannot keep is asked about before anything is created. A hunt this
  // conversation already started is confirmed (re-checked when its last check is old) or resumed when
  // nothing changed here since; when something did, the difference is said and one question asked
  // (replace it, keep both, resume it as it was, leave it): never a second hunt in silence, and never
  // "under its rules" when the rules here are not the hunt's.
  async huntFlow(s, u, cur, actor) {
    if (!actor) { this.signInToHunt(s); return; }
    if (!this.hunts) { this.speak(s, 'Hunting needs the hunt service, which is not running here.'); return; }
    const ask = state.nextQuestion(s);
    if (ask) {
      s.pending = ask.key;
      const options = ask.origins ? this.maps.listOrigins().map(o => ({ label: `${o.city} (${o.airports[0].code})`, say: o.airports[0].code })) : null;
      this.speak(s, `To hunt I need one thing first. ${ask.text} Then say "hunt for a better deal".`, options ? { kind: 'ask', options } : null);
      return;
    }
    const cannot = this.huntCannotKeep(s);
    if (cannot.length) {
      s.pending = 'huntWithout';
      this.speak(s, `A hunt searches every hotel and fare inside your rules on every date of its window, so it cannot keep ${joinAnd(cannot)}. Hunt without ${cannot.length > 1 ? 'them' : 'it'} (the canvas keeps ${cannot.length > 1 ? 'your locks' : 'your lock'}), or not now?`, { kind: 'ask', options: [{ label: 'Hunt without it', say: 'Hunt without it' }, { label: 'Not now', say: 'Not now' }] });
      return;
    }
    await this.huntStart(s, cur, actor);
  }

  // The answer to "hunt without the lock?": yes creates the hunt and remembers which locks it goes
  // without, so they are said with it and not asked twice; no creates nothing and says so.
  async huntWithoutFlow(s, text, actor) {
    const lower = text.toLowerCase().trim().replace(/[.!]+$/, '');
    if (/^(?:hunt without (?:it|them|that|the locks?)|hunt anyway|without (?:it|them)|yes|yes please|ok|okay|go ahead|do it|sure)$/.test(lower)) {
      if (!actor) { this.signInToHunt(s); return true; }
      s.huntWithout = [...new Set([...(Array.isArray(s.huntWithout) ? s.huntWithout : []), ...this.huntLocks(s)])];
      await this.huntStart(s, s.current ? await this.currentTrip(s) : null, actor);
      return true;
    }
    if (/^(?:not now|no|no thanks|never mind|leave it|cancel|keep (?:it|them|the locks?|my locks?))$/.test(lower)) {
      this.speak(s, 'No hunt started. Your locks stand and the canvas is as it was.');
      return true;
    }
    return false;
  }

  // The hunt the conversation has, against the rules here now, then confirm, resume, ask or create.
  async huntStart(s, cur, actor, { replaced = null, kept = null } = {}) {
    const input = this.huntInput(s, cur);
    let want;
    try { want = this.hunts.validate(input); } catch (e) { if (e instanceof AppError) { this.speak(s, e.message); return; } throw e; }
    const ref = this.huntRef(s);
    if (ref && !replaced && !kept) {
      let hunt = null;
      try { hunt = await this.hunts.get(actor, ref.id); } catch (e) { if (!(e instanceof AppError)) throw e; this.setHuntRef(s, null); }
      if (hunt) {
        // A ref from before the input was kept with it compares only what the record itself holds.
        const diffs = this.huntDiff(ref.input || { ...want, budget: hunt.budget, origin: hunt.origin }, want);
        if (diffs.length) { this.askHuntDiffers(s, hunt, diffs); return; }
        if (hunt.status === 'hunting') {
          const c = await this.huntChecked(actor, hunt);
          this.setHuntRef(s, c.hunt);
          this.speak(s, `${hunt.name} is already hunting under these rules. ${this.huntMonitoring()}${c.words}`, c.card);
          return;
        }
        await this.huntResume(s, hunt, actor);
        return;
      }
    }
    await this.huntCreate(s, input, want, actor, { replaced, kept });
  }

  askHuntDiffers(s, hunt, diffs) {
    const hunting = hunt.status === 'hunting';
    // "Add it" when every changed rule has a hunt answer that takes it exactly; a changed trip to beat
    // rides along (it is said, and asked about again next time, since no answer moves it).
    const addable = diffs.some(d => d.improve) && diffs.every(d => d.improve || d.key === 'savedToken');
    const options = [
      ...(addable ? [['Add it to the hunt', 'Add it to the hunt']] : []),
      ['Replace it', 'Replace it'], hunting ? ['Keep both', 'Keep both'] : ['Resume it as it was', 'Resume it as it was'], ['Leave it', 'Leave it'],
    ].map(([label, say]) => ({ label, say }));
    s.pending = 'huntDiffers';
    this.speak(s, `${hunt.name} ${hunting ? 'is hunting' : 'is stopped'} with the rules it was started with, and this conversation has changed since: ${joinAnd(diffs.map(d => d.text))}. ${addable ? `Add it to the hunt (its other rules and what it learned stay), replace` : 'Replace'} the hunt with one on the rules here (it stops; what it learned stays on its page), ${hunting ? 'keep both running' : 'resume it as it was'}, or leave it as it is?`, { kind: 'ask', options });
  }

  // The answer about a hunt whose rules differ from the canvas: each choice is said in full, and the
  // old hunt is stopped only by "replace it", never by the new one appearing.
  async huntDiffersFlow(s, text, actor) {
    const lower = text.toLowerCase().trim().replace(/[.!]+$/, '');
    const ref = this.huntRef(s);
    if (!ref) return false;
    const choice = /^(?:replace(?: it| the hunt| them)?|new hunt|start a new (?:one|hunt))$/.test(lower) ? 'replace'
      : /^(?:keep both|both|keep (?:them )?both)$/.test(lower) ? 'both'
        : /^(?:resume(?: it)?(?: as it was)?)$/.test(lower) ? 'resume'
          : /^(?:add (?:it|them|that|nonstop|the rule)(?: to (?:it|the hunt))?)$/.test(lower) ? 'add'
            : /^(?:leave it(?: as it is)?|leave|no|not now|never mind|keep it(?: as it is)?)$/.test(lower) ? 'leave' : null;
    if (!choice) return false;
    if (!actor) { this.signInToHunt(s, 'change the hunt'); return true; }
    let hunt = null;
    try { hunt = await this.hunts.get(actor, ref.id); } catch (e) { if (!(e instanceof AppError)) throw e; this.setHuntRef(s, null); this.speak(s, e.message); return true; }
    const cur = s.current ? await this.currentTrip(s) : null;
    if (choice === 'leave') { this.speak(s, `Left as it is: ${hunt.name} ${hunt.status === 'hunting' ? 'keeps hunting' : 'stays stopped'} under the rules it was started with, and this conversation keeps its own.`, this.huntCardFor(hunt)); return true; }
    if (choice === 'add') {
      const diffs = this.huntDiff(ref.input, this.hunts.validate(this.huntInput(s, cur)));
      const what = diffs.some(d => d.improve) && diffs.every(d => d.improve || d.key === 'savedToken') ? diffs.find(d => d.improve).improve : null;
      if (!what) { this.speak(s, `That rule cannot be added to ${hunt.name} as it is; say "replace it" for a hunt on the rules here, or "leave it".`); s.pending = 'huntDiffers'; return true; }
      let out;
      try { out = await this.hunts.respond(actor, hunt.id, 'improve', { what }); } catch (e) { if (!(e instanceof AppError)) throw e; this.speak(s, e.message); return true; }
      // The ref's input now carries the rule, so the next "hunt for a better deal" finds no difference.
      if (what === 'nonstop' && ref.input) ref.input.rules = { ...ref.input.rules, flightStops: 'nonstop', flightRule: 'hard' };
      await this.huntUpdated(s, out);
      return true;
    }
    if (choice === 'resume') {
      if (hunt.status === 'hunting') { this.speak(s, `${hunt.name} is already hunting under the rules it was started with; this conversation keeps its own.`, this.huntCardFor(hunt)); return true; }
      await this.huntResume(s, hunt, actor, { note: ' This conversation keeps its own rules; the hunt keeps the ones it was started with.' });
      return true;
    }
    if (choice === 'replace') {
      if (hunt.status === 'hunting') {
        try { hunt = (await this.hunts.respond(actor, hunt.id, 'stop')).hunt; } catch (e) { if (!(e instanceof AppError)) throw e; this.speak(s, e.message); return true; }
      }
      await this.huntStart(s, cur, actor, { replaced: hunt });
      return true;
    }
    await this.huntStart(s, cur, actor, { kept: hunt });
    return true;
  }

  async huntResume(s, hunt, actor, { note = '' } = {}) {
    let out;
    try { out = await this.hunts.respond(actor, hunt.id, 'resume'); } catch (e) { if (e instanceof AppError) { this.speak(s, e.message); return; } throw e; }
    const c = await this.huntChecked(actor, out.hunt);
    this.setHuntRef(s, c.hunt);
    this.speak(s, `${c.hunt.name} is hunting again under the rules it had.${note} ${this.huntMonitoring()}${c.words}`, c.card);
  }

  // Create and say it: the acceptance, what runs later, what this hunt goes without or replaces (said,
  // never implied), the window a stated date became, the range of lengths when none was named, the
  // saving that earns an interruption and how to change it, then what the first check found.
  async huntCreate(s, input, want, actor, { replaced = null, kept = null } = {}) {
    let hunt;
    try { hunt = await this.hunts.create(actor, input); } catch (e) { if (e instanceof AppError) { this.speak(s, e.message); return; } throw e; }
    this.setHuntRef(s, hunt, want);
    const run = hunt.runs[hunt.runs.length - 1];
    const opp = hunt.opportunities.length ? hunt.opportunities[hunt.opportunities.length - 1] : null;
    const notes = [];
    if (replaced) notes.push(`${replaced.name} is stopped; this hunt replaces it, and what it learned stays on its page`);
    if (kept) notes.push(`${kept.name} keeps running too; this conversation now follows ${hunt.name}, and the other is stopped from its page or from My Trips`);
    const without = this.huntLocks(s);
    if (without.length) notes.push(`Hunting without ${joinAnd(without)}, as you said; the canvas keeps ${without.length > 1 ? 'them' : 'it'}`);
    if (s.dateMode === 'exact' && s.depart) notes.push(`A hunt searches a window, not one date, so it looks at ${monthWords(hunt.month)}`);
    if (hunt.minNights !== hunt.maxNights) notes.push(`I look at ${hunt.minNights} to ${hunt.maxNights} nights, since no length was named`);
    const other = hunter.THRESHOLDS.find(t => t !== hunt.threshold) || 5000;
    notes.push(`I interrupt you for wins of ${dollars(hunt.threshold)} or more; say "tell me about ${dollars(other)} wins" to change it`);
    const first = opp ? hunter.decisionText(opp, hunt) : `The first check priced ${plural(run.considered, 'complete package')} across ${plural(run.destinations, 'destination')} and found nothing worth interrupting you for: ${run.silent}.`;
    this.speak(s, `${HuntService.ACCEPTANCE} ${this.huntMonitoring()}${sentences(notes)} ${first}`, this.huntCardFor(hunt, { opportunity: opp }));
  }

  // "Tell me about $50 wins": the saving worth an interruption, on the hunt when there is one (the
  // record's own answer, re-checked), or kept for the hunt this conversation will start.
  async thresholdFlow(s, cents, actor) {
    if (!(cents >= 100)) { this.speak(s, 'Say a whole dollar amount: "tell me about $50 wins".'); return; }
    const ref = this.huntRef(s);
    if (ref && this.hunts) {
      if (!actor) { this.signInToHunt(s, 'change the hunt'); return; }
      let out;
      try { out = await this.hunts.respond(actor, ref.id, 'threshold', { threshold: cents }); } catch (e) { if (!(e instanceof AppError)) throw e; if (e.status === 404) this.setHuntRef(s, null); this.speak(s, e.message); return; }
      s.huntThreshold = cents;
      if (ref.input) ref.input.threshold = cents;
      await this.huntUpdated(s, out);
      return;
    }
    s.huntThreshold = cents;
    this.speak(s, `Noted for this conversation: once a hunt starts, I interrupt you for wins of ${dollars(cents)} or more. Nothing is saved to your account by this.`);
  }

  // "Not good enough": what should the hunt improve? Five answers, each moving one rule of the hunt.
  async notGoodEnoughFlow(s, actor) {
    const ref = this.huntRef(s);
    if (!this.hunts || !ref) { this.speak(s, 'There is no hunt on this conversation yet. Say "hunt for a better deal" and I start one with your rules.'); return; }
    if (!actor) { this.signInToHunt(s, 'change the hunt'); return; }
    s.pending = 'improve';
    this.speak(s, 'What should I improve? Each answer changes one rule of the hunt and re-checks; the rest stays as you set it.', { kind: 'ask', options: IMPROVE_CHIPS.map(([label]) => ({ label, say: label })) });
  }

  // The answer: one rule of the hunt moves, in the record's own words, and the hunt checks again now.
  // "Keep waiting" (or any no) leaves the rules alone. An answer is one of the five chips, or a reply
  // of a few words that names exactly one of the five, changes nothing on the trip and asks nothing
  // else; anything else was not an answer to this question, and the caller sends it where it belongs.
  async improveFlow(s, text, u, actor) {
    const lower = text.toLowerCase().trim().replace(/[.!]+$/, '');
    const ref = this.huntRef(s);
    if (/^(?:keep waiting|never mind|nothing|leave it|no|no thanks)$/.test(lower)) {
      if (!actor) { this.signInToHunt(s, 'change the hunt'); return true; }
      let out;
      try { out = await this.hunts.respond(actor, ref.id, 'keep-waiting'); } catch (e) { if (!(e instanceof AppError)) throw e; if (e.status === 404) this.setHuntRef(s, null); this.speak(s, e.message); return true; }
      const c = await this.huntChecked(actor, out.hunt);
      this.setHuntRef(s, c.hunt);
      this.speak(s, `Kept as it is. The rules stand and I say nothing until one of them is met.${c.words}`, c.card);
      return true;
    }
    const chip = IMPROVE_CHIPS.find(([label]) => label.toLowerCase() === lower);
    let what = chip ? chip[1] : null;
    if (!what && lower.split(/\s+/).filter(Boolean).length <= IMPROVE_MAX_WORDS && !Object.keys(u.updates).length && !u.intents.length) {
      const named = IMPROVE_WORDS.filter(([, re]) => re.test(lower)).map(([k]) => k);
      if (named.length === 1) what = named[0];
    }
    if (!what) return false;
    if (!actor) { this.signInToHunt(s, 'change the hunt'); return true; }
    let out;
    try { out = await this.hunts.respond(actor, ref.id, 'improve', { what }); } catch (e) { if (!(e instanceof AppError)) throw e; if (e.status === 404) this.setHuntRef(s, null); this.speak(s, e.message); return true; }
    await this.huntUpdated(s, out);
    return true;
  }

  // After a rule moved: what changed, in the words the record keeps, then what the re-check found or
  // why it stayed quiet, with the card. A stopped hunt is not re-run, and that is said rather than implied.
  async huntUpdated(s, { hunt, result }) {
    this.setHuntRef(s, hunt);
    const learned = hunt.learned.length ? hunt.learned[hunt.learned.length - 1].text : 'Nothing changed';
    const added = result ? (result.opportunities || []).length : 0;
    const opp = added ? hunt.opportunities[hunt.opportunities.length - 1] : null;
    const text = !result ? `${learned}. The hunt is stopped, so I did not check again; say "hunt for it" to start it again.`
      : opp ? `${learned}. ${hunter.decisionText(opp, hunt)}`
        : `${learned}. I checked again with the new rule: ${result.silent}.`;
    this.speak(s, text, this.huntCardFor(hunt, { opportunity: opp }));
  }

  // "Stop hunting": the hunt stops; its rules and what it found stay on the account.
  async stopHuntFlow(s, actor) {
    const ref = this.huntRef(s);
    if (!this.hunts || !ref) { this.speak(s, 'There is no hunt on this conversation to stop.'); return; }
    if (!actor) { this.signInToHunt(s, 'stop the hunt'); return; }
    let out;
    try { out = await this.hunts.respond(actor, ref.id, 'stop'); } catch (e) { if (!(e instanceof AppError)) throw e; if (e.status === 404) this.setHuntRef(s, null); this.speak(s, e.message); return; }
    this.setHuntRef(s, out.hunt);
    this.speak(s, 'Stopped. Nothing runs for this hunt any more; say "hunt for it" to start again.', this.huntCardFor(out.hunt));
  }

  // ---- the mission: three ways fast, every destination tries to beat them ----------------------------
  // What the traveler's reactions rule out for every later strategy call: the destinations and the
  // hotels they rejected, and the order they asked for (shorter flights, more exciting). Never inferred.
  missionOpts(s) {
    const m = s.mission || { wrong: [], shown: [] };
    const wrong = m.wrong || [], shown = m.shown || [];
    const last = [...wrong].reverse().find(w => w === 'travel' || w === 'exciting');
    return {
      exclude: { dests: wrong.includes('destinations') ? [...new Set(shown.map(x => x.dest).filter(Boolean))] : [], hotels: wrong.includes('hotels') || wrong.includes('exciting') ? [...new Set(shown.map(x => x.hotel).filter(Boolean))] : [], tokens: [] },
      prefer: last === 'travel' ? 'shorter-flights' : last === 'exciting' ? 'exciting' : null,
    };
  }

  wayEntry(w, ctx) {
    return { key: w.key, label: w.label, token: w.token, total: w.total, keep: w.keep, match: w.match, why: w.why, differs: w.differs, card: tripCard(w.trip, w.token, ctx) };
  }
  shownEntry(w) { return { token: w.token, dest: w.trip.dest.id, hotel: w.trip.spec.hotel, stars: w.trip.hotel.stars }; }
  waysCard(s, m, q, { compact = false } = {}) {
    const saver = this.saver(s);
    const champion = m.pick ? m.strategies.find(w => w.key === m.pick.key) : m.strategies[0];
    return { kind: 'ways', ways: m.strategies.map(w => ({ key: w.key, label: w.label, trip: w.card, keep: w.keep, differs: w.differs, why: w.why, pick: m.pick && m.pick.key === w.key })), round: m.round, compact, saver: saver && champion ? { max: q.budget, total: champion.total, keep: q.budget - champion.total, dest: champion.card.dest } : null };
  }

  // Materially better, the one rule for replacing what the traveler can already see: a different
  // trip at least $25 cheaper with nothing given up, or clearly stronger (+5 match) for the same or
  // less money. Anything else is just another available option, and the traveler is not bothered with it.
  materiallyBetter(a, b) {
    if (encodeSpec(a.trip.spec) === encodeSpec(b.trip.spec)) return false;
    const ch = classifyChanges(a.trip, b.trip);
    if (ch.tradeoffs.length) return false; // a replacement never gives anything up, whatever it saves or scores
    return a.trip.total - b.trip.total >= MATERIAL_SAVING || (b.match >= a.match + 5 && b.trip.total <= a.trip.total);
  }

  // The three ways on the table: from the likeliest destinations (stage 'fast', while the rest is
  // checked) or from every destination (stage 'deep'). Sets the champion, the question and the feed.
  presentWays(s, ways, q, ctx, { stage, names = [], all = 0 } = {}) {
    const m = s.mission, now = this.now();
    m.round += 1;
    if (stage === 'fast') m.fastRound = m.round;
    m.strategies = ways.strategies.map(w => this.wayEntry(w, ctx));
    m.shown = [...m.shown, ...ways.strategies.map(w => this.shownEntry(w))];
    m.pick = ways.pick;
    m.dropped = ways.dropped;
    m.variants = [];
    const saver = this.saver(s);
    const pick = saver ? (m.strategies.find(w => w.key === 'keep') || (ways.pick ? m.strategies.find(w => w.key === ways.pick.key) : null)) : ways.pick ? m.strategies.find(w => w.key === ways.pick.key) : null;
    const champion = pick || m.strategies[0] || null;
    if (saver && champion) m.pick = { key: champion.key, reasons: champion.key === 'keep' ? [`Leaves ${money(champion.keep)} of your ${money(q.budget)} with you`, ...(ways.pick && ways.pick.key === 'keep' ? ways.pick.reasons.filter(r => !/^Leaves/.test(r)) : [])] : (ways.pick ? ways.pick.reasons : []) };
    if (champion) s.current = { token: champion.token, total: champion.total, since: now.toISOString() };
    s.job.best = champion ? champion.card : null;
    s.job.bestAtMs = Date.parse(now.toISOString()) - Date.parse(s.job.startedAt);
    s.job.feed = s.job.feed || [];
    s.job.feed.push(`${stage === 'fast' ? `Built ${plural(m.strategies.length, 'way')} to use ${money(q.budget)} from ${joinAnd(names)}` : `Built ${plural(m.strategies.length, 'way')} to use ${money(q.budget)}`}${ways.dropped.length ? `; ${ways.dropped.map(d => `${d.key}: ${d.reason}`).join('; ')}` : ''}`);
    const n = m.strategies.length;
    const pickWords = m.pick && champion ? ` I'd start with ${champion.card.dest}: ${joinAnd(m.pick.reasons.map(r => r.charAt(0).toLowerCase() + r.slice(1)))}.` : '';
    const next = stage === 'fast' ? ' I\'m now checking every destination we serve from here and replace one of these only if something materially better turns up; I\'ll say so.' : '';
    const where = stage === 'fast' ? ` from the likeliest destinations (${joinAnd(names)})` : '';
    const card = n ? this.waysCard(s, m, q) : null;
    if (saver) this.speak(s, n ? `You gave me ${money(q.budget)}. I don't think you need to spend it: ${champion.card.summary} comes to ${money(champion.total)} with every tax and fee, and you keep ${money(q.budget - champion.total)}.${sentences(ways.dropped.map(d => d.reason))}${n > 1 ? ` ${n === 3 ? 'Three ways' : 'Two ways'} to use the number${where} are below; which feels more like you? Or say "find $100", "how low can you go?" or "same trip for less".` : ' Say "find $100", "how low can you go?" or "same trip for less".'}${next}` : `Nothing I built fits ${money(q.budget)} as a trip I'd recommend; here is what fits.`, card);
    else this.speak(s, n ? `I found ${n === 3 ? 'three ways' : plural(n, 'way')} to use your ${money(q.budget)}${where}.${sentences(ways.dropped.map(d => d.reason))}${pickWords}${next} Which feels more like you?` : `Nothing I built reads as different ways to use ${money(q.budget)}; here is what fits.`, card);
    s.pending = n ? 'ways' : null;
  }

  // Every destination has been checked against the three ways on the table. A way is replaced only
  // by a materially better verified trip, and each replacement is said as what stays the same, what
  // gets better and what it costs; a way the traveler already chose is never swapped under them, it
  // becomes a proposal. Nothing else interrupts.
  beatWays(s, fastWays, ways, deep, q, ctx) {
    const m = s.mission, now = this.now();
    const beaten = [], added = [], proposals = [];
    for (const w of ways.strategies) {
      const old = fastWays.strategies.find(x => x.key === w.key);
      const i = m.strategies.findIndex(x => x.key === w.key);
      if (!old || i < 0) { if (i < 0) added.push(w); continue; }
      if (old.token === w.token || !this.materiallyBetter(old, w)) continue;
      if (m.chosen && m.chosen.key === w.key) { proposals.push({ old, w }); continue; }
      beaten.push({ i, old, w, n: i + 1 });
    }
    for (const b of beaten) m.strategies[b.i] = this.wayEntry(b.w, ctx);
    for (const w of added) m.strategies.push(this.wayEntry(w, ctx));
    m.strategies.sort((a, b) => ['more', 'keep', 'special'].indexOf(a.key) - ['more', 'keep', 'special'].indexOf(b.key));
    // How each way differs from the others is recomputed for the set now on the table, so the card
    // never compares a way with one it replaced or states a delta against a trip that is not shown.
    const wayFor = key => (beaten.find(b => b.w.key === key) || {}).w || added.find(w => w.key === key) || fastWays.strategies.find(w => w.key === key) || null;
    const shown = m.strategies.map(e => wayFor(e.key)).filter(Boolean);
    strategies.describeDiffers(shown);
    for (const e of m.strategies) { const w = shown.find(x => x.key === e.key); if (w) e.differs = w.differs; }
    m.shown = [...m.shown, ...[...beaten.map(b => b.w), ...added].map(w => this.shownEntry(w))];
    if (ways.pick && m.strategies.some(w => w.key === ways.pick.key) && (!m.pick || beaten.some(b => b.w.key === m.pick.key) || added.some(w => w.key === ways.pick.key))) m.pick = this.saver(s) && m.strategies.some(w => w.key === 'keep') ? m.pick : ways.pick;
    const champion = m.pick ? m.strategies.find(w => w.key === m.pick.key) : m.strategies[0];
    // The canvas follows the champion only while it still shows an untouched way from the first pass.
    // A version the traveler applied meanwhile, or a decision still open, is never swapped under them:
    // a new champion is then a proposal, like a way they chose by number.
    const fastTokens = new Set(fastWays.strategies.map(w => w.token));
    const untouched = !s.current || (fastTokens.has(s.current.token) && !s.proposal);
    if (!m.chosen && champion && untouched) s.current = { token: champion.token, total: champion.total, since: now.toISOString() };
    else if (!m.chosen && champion && s.current && champion.token !== s.current.token && (beaten.length || added.length)) {
      const old = fastWays.strategies.find(w => w.key === champion.key) || fastWays.strategies[0];
      if (old && old.token !== champion.token && !s.proposal) proposals.push({ old, w: wayFor(champion.key), applied: true });
      else s.job.feed.push(`The set changed, but your canvas keeps the version you applied (${money(s.current.total)})`);
    }
    s.job.best = champion ? champion.card : null;
    s.job.bestAtMs = Date.parse(now.toISOString()) - Date.parse(s.job.startedAt);
    s.job.improved = beaten.length > 0;
    s.job.feed.push(`Checked all ${plural(deep.destinations, 'destination')}: ${deep.considered} complete packages, ${deep.eligible} inside your rules and budget; ${beaten.length ? `${beaten.length} of the ${fastWays.strategies.length} ways replaced by something materially better` : `nothing beat the ${fastWays.strategies.length === 1 ? 'way' : 'ways'} from the first pass`}${added.length ? `; ${plural(added.length, 'way')} added` : ''}`);
    const same = (a, b) => { const ch = classifyChanges(a, b); const moved = new Set([...ch.improvements, ...ch.tradeoffs, ...ch.neutral].map(r => r.key)); return ['nights', 'flight', 'hotel', 'meals', 'area', 'transfer'].filter(k => !moved.has(k)).map(k => this.shortFact({ key: k, label: k, a: '', b: '' }, 'b', b)); };
    const givenUp = ch => (ch.tradeoffs.length ? `Given up: ${joinAnd(changeWords(ch.tradeoffs))}.` : 'Nothing given up.');
    for (const b of beaten) {
      const ch = classifyChanges(b.old.trip, b.w.trip);
      const delta = b.w.total - b.old.total;
      const n = m.strategies.findIndex(x => x.key === b.w.key) + 1;
      const entry = m.strategies.find(x => x.key === b.w.key);
      this.speak(s, `I found something that beats Option ${n} (${b.old.label}): ${b.w.trip.dest.name}${b.w.trip.dest.id !== b.old.trip.dest.id ? ` instead of ${b.old.trip.dest.name}` : ''}, ${delta < 0 ? `${money(-delta)} less` : delta > 0 ? `${money(delta)} more` : 'the same price'}${ch.improvements.length ? `; better: ${joinAnd(changeWords(ch.improvements))}` : ''}. ${givenUp(ch)} It replaces Option ${n}.`, { kind: 'beat', n, label: b.old.label, before: b.old.trip ? tripCard(b.old.trip, b.old.token, ctx) : null, after: entry.card, same: same(b.old.trip, b.w.trip), better: changeWords(ch.improvements), neutral: changeWords(ch.neutral), delta });
    }
    for (const p of proposals) {
      if (s.proposal) { s.job.feed.push(`A materially better ${p.w.label} exists (${p.w.trip.dest.name}, ${money(p.w.total)}); a decision is already open, so it waits`); continue; }
      const ch = classifyChanges(p.old.trip, p.w.trip);
      const text = p.applied
        ? `Every destination checked: the strongest way is now ${p.w.trip.dest.name} at ${money(p.w.total)}${p.w.total < p.old.total ? `, ${money(p.old.total - p.w.total)} less than the ${p.old.label} it replaces` : ''}. You changed your trip meanwhile, so your canvas stays as you made it (${money(s.current.total)}). Switch, or keep what you have.`
        : `Every destination checked: I found something that beats the ${p.old.label} you chose: ${p.w.trip.dest.name}, ${money(p.w.total)}${p.w.total < p.old.total ? `, ${money(p.old.total - p.w.total)} less` : ''}${ch.improvements.length ? `; better: ${joinAnd(changeWords(ch.improvements))}` : ''}. ${givenUp(ch)} Switch, or keep what you chose.`;
      this.propose(s, { kind: 'switch', token: p.w.token, total: p.w.total, delta: s.current ? p.w.total - s.current.total : p.w.total - p.old.total, from: s.current ? s.current.token : p.old.token, label: p.applied ? 'Strongest way after every destination' : 'Better version of your pick', improvements: changeWords(ch.improvements), tradeoffs: changeWords(ch.tradeoffs), neutral: changeWords(ch.neutral), over: p.w.total > q.budget, nights: p.w.trip.spec.nights }, text);
    }
    const o = this.maps.getOrigin(q.origin);
    const stop = `I'd stop here. I checked all ${plural(deep.destinations, 'destination')} we serve from ${o ? o.city : q.origin}: ${deep.considered} complete packages, every hotel and flight combination suppliers returned inside your rules${q.dateMode === 'anytime' ? ', on the departure dates they offered' : q.dateMode === 'flexible' ? ` in ${q.month}` : ' on your dates'}.`;
    if (beaten.length || added.length) this.speak(s, `${stop} ${beaten.length ? `${beaten.length === 1 ? 'One way was' : `${beaten.length} ways were`} replaced` : ''}${beaten.length && added.length ? ' and ' : ''}${added.length ? `${plural(added.length, 'way')} added` : ''}; the set now:${m.chosen ? '' : ' Which feels more like you?'}`, this.waysCard(s, m, q, { compact: true }));
    else this.speak(s, `${stop} Nothing beat the ${fastWays.strategies.length === 1 ? 'way' : 'ways'} from the first pass, so they stand${m.chosen ? '' : '; which feels more like you?'}`);
    if (!m.chosen && m.strategies.length && !s.proposal) s.pending = 'ways';
  }

  // The group a changed fact belongs to. A decision trades one group against another; a change
  // inside one group (a fare with bags but a stop) is a version, not a decision.
  decisionGroup(key, changed) {
    if (key === 'time') return changed.has('nights') || changed.has('flight') ? null : 'flights';
    if (key === 'flex') return changed.has('flight') && changed.has('hotel') ? 'both' : changed.has('hotel') ? 'stay' : 'flights';
    return { flight: 'flights', bags: 'flights', nights: 'length', hotel: 'stay', area: 'stay', meals: 'stay', transfer: 'extras', experiences: 'extras' }[key] || null;
  }

  // One changed fact of a trip, in the words a decision button uses.
  shortFact(row, side, t) {
    switch (row.key) {
      case 'nights': return plural(t.spec.nights, 'night');
      case 'flight': return `${t.flight.stops ? `${t.flight.stops}-stop` : 'nonstop'} flights (${hm(t.flight.durationMinutes)} each way${/nonstop/i.test(t.flight.name) ? '' : `, ${t.flight.name} fare`})`;
      case 'hotel': return `${t.hotel.stars}-star ${t.hotel.name}`;
      case 'meals': return t.hotel.features.allInclusive ? 'all-inclusive' : t.hotel.features.breakfast ? 'breakfast included' : 'no meals included';
      case 'area': return t.hotel.features.beachfront ? `beachfront in ${t.hotel.area}` : `in ${t.hotel.area}`;
      case 'transfer': return t.transfer ? 'airport transfer included' : 'no airport transfer';
      default: return `${row.label.toLowerCase()}: ${String(row[side]).toLowerCase()}`;
    }
  }

  // "I'm one decision away": when a priced trip in the same destination within $50 of the pick trades
  // exactly one thing for another (the flights against a transfer, the hotel against the flights, nights
  // against stops), that is a real decision and the traveler makes it. Everything that differs is on
  // the buttons; the agent never picks a side; the signature stop follows the answer.
  oneDecision(s, best, deep, q, ctx) {
    if (s.mission || !best) return false;
    const pool = (deep.eligibleTrips && deep.eligibleTrips.length ? deep.eligibleTrips : deep.near) || [];
    if (!pool.length) return false;
    const locks = state.effectiveLocks(s);
    let found = null;
    for (const c of pool) {
      if (c.trip === best.trip || c.trip.dest.id !== best.trip.dest.id || Math.abs(c.trip.total - best.trip.total) > DECISION_BAND) continue;
      const ch = classifyChanges(best.trip, c.trip);
      if (ch.neutral.some(r => r.key === 'dest')) continue;
      const rows = [...ch.improvements, ...ch.tradeoffs];
      if (!rows.length) continue;
      const changed = new Set([...rows, ...ch.neutral].map(r => r.key));
      const groupOf = r => this.decisionGroup(r.key, changed);
      if (rows.some(r => groupOf(r) === 'both')) continue;
      const ups = new Set(ch.improvements.map(groupOf).filter(Boolean)), downs = new Set(ch.tradeoffs.map(groupOf).filter(Boolean));
      if (ups.size !== 1 || downs.size !== 1 || [...ups][0] === [...downs][0]) continue;
      if (strategies.crossesLock && strategies.crossesLock(best.trip, c.trip, locks)) continue;
      if ((locks.nights || s.nightsStated) && c.trip.spec.nights !== best.trip.spec.nights) continue;
      found = { c, up: [...ups][0], down: [...downs][0], rows: rows.filter(groupOf) }; break;
    }
    if (!found) return false;
    const { c, up, down, rows } = found;
    const label = (t, side) => rows.map(r => this.shortFact(r, side, t)).join(', ');
    const when = c.trip.spec.depart !== best.trip.spec.depart ? `, leaving ${longDate(c.trip.spec.depart)}` : '';
    const matters = { flights: 'the flights', stay: 'the hotel', length: 'more nights', extras: 'the extras' };
    const a = { letter: 'A', token: encodeSpec(best.trip.spec), total: best.trip.total, label: label(best.trip, 'a'), priority: DECISION_PRIORITY[down] || null, matters: matters[down] };
    const b = { letter: 'B', token: encodeSpec(c.trip.spec), total: c.trip.total, label: `${label(c.trip, 'b')}${when}`, priority: DECISION_PRIORITY[up] || null, matters: matters[up] };
    s.decision = [a, b];
    // Kept on the state itself, not on the array: a property on the array is lost in JSON (Postgres).
    s.decisionFacts = { deep: { destinations: deep.destinations, considered: deep.considered, cheaperThanPick: deep.cheaperThanPick }, q: { origin: q.origin, dateMode: q.dateMode, month: q.month }, pick: a.token };
    s.pending = 'options';
    const diff = Math.abs(c.trip.total - best.trip.total);
    this.speak(s, `I'm one decision away. For ${diff ? `almost the same total (${money(best.trip.total)} against ${money(c.trip.total)})` : `the same total, ${money(best.trip.total)}`} in ${best.trip.dest.name} I can give you A: ${a.label}, or B: ${b.label}. Which matters more?`, { kind: 'decision', options: [a, b].map(x => ({ letter: x.letter, label: x.label, total: x.total })), trip: tripCard(best.trip, a.token, ctx) });
    return true;
  }

  decisionByWords(s, text) {
    const lower = text.toLowerCase();
    const hit = s.decision.filter(d => d.label.toLowerCase().split(', ').some(part => part && lower.includes(part.replace(/^in /, ''))));
    return hit.length === 1 ? hit[0].letter : null;
  }

  async decide(s, letter) {
    const d = s.decision.find(x => x.letter === letter);
    const facts = s.decisionFacts || null;
    s.decision = null; s.decisionFacts = null;
    if (!d) { this.speak(s, 'That choice is not on the table any more.'); return true; }
    if (d.priority) s.priority = d.priority;
    const matters = d.matters || { longer: 'more nights', flights: 'the flights', hotel: 'the hotel' }[d.priority] || 'that';
    if (s.current && s.current.token === d.token) this.speak(s, `${d.label} it is: ${matters} matters more, and I keep that in mind for this trip (not saved unless you ask). It stays on your canvas at ${money(d.total)}.`);
    else { this.speak(s, `${d.label} it is: ${matters} matters more, and I keep that in mind for this trip (not saved unless you ask).`); await this.applyProposal(s, { kind: 'decision', token: d.token, total: d.total, delta: s.current ? d.total - s.current.total : 0, label: d.label, over: false }); }
    if (facts) this.speak(s, this.stopLine(facts.deep, facts.q, s.options, { chosen: d.token !== facts.pick ? d.label : null }), this.finalCard(s));
    return true;
  }

  finalCard(s) {
    return s.options.length > 1 ? { kind: 'options', options: s.options, keepMoney: s.job ? s.job.keepMoney : null, final: true } : { kind: 'ask', options: [{ label: 'Verify & book', say: 'Book it' }, { label: 'Challenge it again', say: 'Challenge it again' }] };
  }

  // "Anytime in June": the cheapest strong week for the pick, with the range of the other windows
  // actually priced for it. Today's prices only; a cheaper week is a proposal, never applied.
  flexibleWeek(s, best, q, ctx, settings) {
    let out;
    try { out = weeks.cheapestWeeks(this.inv, best.trip, settings, { ...ctx, month: q.month, dateMode: 'flexible' }, { now: this.now(), locks: state.effectiveLocks(s) }); } catch (e) { this.log.error('[agent weeks]', e); return; }
    if (!out || !out.windows.length) return;
    const w = weeks.windowWords(out, { fmtDate: longDate });
    const monthWord = weeks.monthName(q.month);
    const std = out.standard === 'strong' ? 'strong' : 'comparable';
    const cur = best.trip;
    // The cheapest week is the trip's own dates unless a window is strictly cheaper (out.cheaper).
    const isCurrent = !out.cheaper;
    const c = out.cheaper || { depart: cur.spec.depart, ret: cur.flight.return || out.current.ret, total: cur.total };
    s.job.feed.push(`Cheapest ${std} week in ${monthWord}: ${isCurrent ? `your dates, ${longDate(c.depart)} – ${longDate(c.ret)} at ${money(c.total)}` : w.headline}${out.range && out.range.count > 1 ? `; the ${plural(out.range.count, 'window')} priced run ${money(out.range.min)} to ${money(out.range.max)}` : ''}`);
    const budget = state.bookingBudget(s);
    const others = out.windows.filter(x => x.token !== encodeSpec(cur.spec)).slice(0, 5);
    const differs = isCurrent ? '' : joinAnd(windowChanges(c));
    this.speak(s, `${isCurrent ? `Your dates are also the cheapest ${std} week I priced for it` : `Cheapest ${std} week I found for this trip`} in ${monthWord}: ${isCurrent ? `${longDate(c.depart)} – ${longDate(c.ret)}` : w.headline}.${differs ? ` That week is not identical: ${differs}; the card says so.` : ''}${w.compared ? ` ${w.compared}.` : ''} ${w.honesty}`, { kind: 'weeks', standard: std, current: { depart: cur.spec.depart, ret: cur.flight.return, total: cur.total }, windows: others.map(x => ({ depart: x.depart, ret: x.ret, total: x.total, delta: x.delta, sameDates: x.depart === cur.spec.depart, hotelChanged: !!x.hotelChanged, flightChanged: !!x.flightChanged, changed: joinAnd(windowChanges(x)) || null, over: !!(budget && x.total > budget), token: x.token })), range: out.range, priced: out.priced, datesSearched: out.datesSearched, truncated: !!out.truncated, honesty: w.honesty, month: q.month, compact: true });
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
