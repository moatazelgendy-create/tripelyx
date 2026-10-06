// The canonical trip object the travel agent keeps for one conversation. The conversation is never
// the source of truth: every answer the agent gives is built from this object plus what the engines
// return, and every rebuild starts from it. Money is in cents. Nothing here is a travel fact.
const { addDays, today } = require('../lib/dates');
const { WHO_DEFAULT } = require('../trips/optimizer');

const LOCK_KEYS = ['hotel', 'flight', 'dates', 'nights', 'dest', 'budget'];
const LOCK_LABEL = { hotel: 'Hotel', flight: 'Flights', dates: 'Dates', nights: 'Length', dest: 'Destination', budget: 'Budget' };
const MAX_MESSAGES = 80;

function newState({ id, visitor = null, userId = null, now = new Date() }) {
  return {
    id, visitor, userId, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    // Who, where from, where to.
    travelers: null, who: null, origin: null, destination: null, anywhere: false, region: null, notCountry: null,
    // When and how long.
    dateMode: null, depart: null, month: null, nights: null,
    // Money: the amount named, whether it covers the booking only or the whole vacation, and the
    // part protected for the destination. The booking budget is derived, never typed over.
    budget: null, budgetPer: 'total', budgetType: null, protectedMoney: null, overApproved: false,
    // Rules. A hard flight rule is never relaxed silently; a soft one steers the ranking.
    flightStops: null, flightRule: null, hotelRules: { minStars: null, allInclusive: false, breakfast: false, beachfront: false }, transfer: false, refundable: false,
    style: null, priority: null,
    locks: { hotel: false, flight: false, dates: false, nights: false, dest: false, budget: false },
    // What has been built: the current trip, the three options from the last build, a pending proposal
    // the traveler has not approved, and the running or finished search job.
    current: null, options: [], proposal: null, job: null, challenged: {},
    // A booking the conversation is about (post-booking questions).
    booking: null,
    pending: null, messages: [], turns: 0, assumed: [],
  };
}

const money = c => `$${Math.round(c / 100).toLocaleString('en-US')}`;

// The booking budget: what the trip itself may cost. A vacation budget keeps the protected money out.
function bookingBudget(s) {
  if (!s.budget) return null;
  const total = s.budgetPer === 'pp' ? s.budget * (s.travelers || 2) : s.budget;
  if (s.budgetType === 'vacation' && s.protectedMoney) return Math.max(0, total - s.protectedMoney);
  return total;
}
function vacationBudget(s) {
  if (!s.budget) return null;
  return s.budgetPer === 'pp' ? s.budget * (s.travelers || 2) : s.budget;
}

function rulesOf(s) {
  const r = {
    nonstop: s.flightStops === 'nonstop' && s.flightRule === 'hard', minStars: s.hotelRules.minStars || null,
    allInclusive: !!s.hotelRules.allInclusive, breakfast: !!s.hotelRules.breakfast, beachfront: !!s.hotelRules.beachfront, transfer: !!s.transfer, refundable: !!s.refundable,
  };
  return Object.values(r).some(Boolean) ? r : null;
}

// Apply what the understanding layer extracted. Returns which parts of the trip definition changed,
// so the agent knows whether the current trip must be rebuilt.
function applyUpdates(s, u, { now = new Date() } = {}) {
  const changed = new Set();
  const set = (k, v) => { if (JSON.stringify(s[k]) !== JSON.stringify(v)) { s[k] = v; changed.add(k); } };
  if (u.budget) { set('budget', u.budget); set('budgetPer', u.budgetPer || 'total'); if (s.locks.budget) s.locks.budget = false; }
  if (u.budgetType) set('budgetType', u.budgetType);
  if (u.protectedMoney) { set('protectedMoney', u.protectedMoney); set('budgetType', 'vacation'); }
  if (u.travelers) set('travelers', u.travelers);
  if (u.who) { set('who', u.who); if (!u.travelers && !s.travelers) set('travelers', WHO_DEFAULT[u.who]); }
  if (u.origin) set('origin', u.origin);
  if (u.destination !== undefined) { set('destination', u.destination); if (u.destination) { set('anywhere', false); set('notCountry', null); } }
  if (u.anywhere) { set('anywhere', true); set('destination', null); }
  if (u.region) set('region', u.region);
  if (u.nights) set('nights', u.nights);
  if (u.dateMode) set('dateMode', u.dateMode);
  if (u.depart !== undefined) set('depart', u.depart);
  if (u.month !== undefined) set('month', u.month);
  if (u.style) set('style', u.style);
  if (u.priority) set('priority', u.priority);
  if (u.flightStops !== undefined) { set('flightStops', u.flightStops); set('flightRule', u.flightRule || null); }
  const hr = { ...s.hotelRules };
  if (u.minStars) hr.minStars = u.minStars;
  if (u.hotelAllInclusive) hr.allInclusive = true;
  if (u.breakfast) hr.breakfast = true;
  if (u.beachfront) hr.beachfront = true;
  if (u.clearStars) hr.minStars = null;
  set('hotelRules', hr);
  if (u.allowOver) set('overApproved', true);
  if (u.useReserve && s.protectedMoney) set('protectedMoney', Math.max(0, s.protectedMoney - u.useReserve));
  if (u.transfer) set('transfer', true);
  if (u.refundable) set('refundable', true);
  if (u.locks) { const l = { ...s.locks }; for (const k of LOCK_KEYS) if (u.locks[k] !== undefined) l[k] = !!u.locks[k]; set('locks', l); }
  if (u.unlocks) { const l = { ...s.locks }; for (const k of LOCK_KEYS) if (u.unlocks[k]) l[k] = false; set('locks', l); }
  // A departure that has slipped into the past is dropped rather than searched.
  if (s.depart && s.depart < addDays(today(now), 3)) { s.depart = null; s.dateMode = s.dateMode === 'exact' ? 'anytime' : s.dateMode; changed.add('depart'); }
  s.updatedAt = now.toISOString();
  const DEF = ['budget', 'budgetPer', 'budgetType', 'protectedMoney', 'travelers', 'who', 'origin', 'destination', 'anywhere', 'region', 'nights', 'dateMode', 'depart', 'month', 'style', 'priority', 'flightStops', 'flightRule', 'hotelRules', 'transfer', 'refundable'];
  return { changed: [...changed], rebuild: [...changed].some(k => DEF.includes(k)) };
}

// The one question that still blocks a build, if any. Everything else gets a stated default.
function nextQuestion(s) {
  if (!s.budget) return { key: 'budget', text: 'How much do you want to spend, all in?' };
  if (!s.origin) return { key: 'origin', text: 'Where are you flying from?' };
  if (!s.budgetType) return { key: 'budgetType', text: `Is ${money(vacationBudget(s))} for the booking only, or your whole vacation including spending money?`, options: [['Booking only', 'just the booking'], ['Whole vacation', 'the whole vacation']] };
  if (s.budgetType === 'vacation' && !s.protectedMoney) return { key: 'reserve', text: 'How much of it do you want to keep for spending after you arrive?' };
  if (bookingBudget(s) < 10000) return { key: 'budget', text: `After the money you protect, ${money(bookingBudget(s))} is left for the trip itself. What total should I work with?` };
  return null;
}

// The search the engines run, from the trip object. Defaults are stated in `assumed` so the agent
// can say what it filled in rather than hide it.
function toQuery(s, { maps }) {
  const assumed = [];
  const travelers = s.travelers || (s.who ? WHO_DEFAULT[s.who] : 2);
  const who = s.who || (travelers === 1 ? 'solo' : travelers === 2 ? 'couple' : 'friends');
  if (!s.travelers && !s.who) assumed.push('two travelers');
  const nights = s.nights || 5;
  if (!s.nights) assumed.push('5 nights');
  const dateMode = s.dateMode || 'anytime';
  if (!s.dateMode) assumed.push('flexible dates');
  let style = s.style || 'surprise';
  if (s.destination && style !== 'surprise' && style !== 'all-inclusive') { const d = maps.getDestination(s.destination); if (d && !d.styles.includes(style)) style = 'surprise'; }
  const priority = s.priority || (s.flightStops === 'nonstop' && s.flightRule === 'soft' ? 'flights' : 'price');
  const rules = rulesOf(s);
  return {
    query: {
      budget: bookingBudget(s), vacationBudget: vacationBudget(s), keep: s.budgetType === 'vacation' ? (s.protectedMoney || 0) : 0, budgetInput: Math.round(vacationBudget(s) / 100), budgetType: 'total',
      travelers, who, origin: s.origin, dateMode, depart: dateMode === 'exact' ? s.depart : null, month: dateMode === 'flexible' ? s.month : null, nights,
      style, priority, allowOver: s.overApproved ? 10 : 0, dest: s.destination, region: s.region, rules, dests: null, notCountry: s.notCountry,
    },
    assumed,
  };
}

function budgetContext(s, q) {
  return { budget: q.budget, keep: q.keep || 0, allowOver: q.allowOver, style: q.style, priority: q.priority, nightsAsked: q.nights, rules: q.rules };
}

function lockedWords(s) {
  return LOCK_KEYS.filter(k => s.locks[k]).map(k => LOCK_LABEL[k]);
}

function pushMessage(s, role, text, card = null, now = new Date()) {
  s.messages.push({ role, text, card, at: now.toISOString() });
  if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
}

// What the traveler asked for, in the words the contract and the canvas use.
function askedFor(s, { maps }) {
  const rows = [];
  if (s.budget) rows.push(['Budget', `${money(vacationBudget(s))}${s.budgetPer === 'pp' ? ' per person' : ''}${s.budgetType === 'vacation' ? ' for the whole vacation' : s.budgetType === 'booking' ? ' for the booking' : ''}`]);
  if (s.budgetType === 'vacation' && s.protectedMoney) rows.push(['Protected for the destination', money(s.protectedMoney)]);
  if (s.travelers) rows.push(['Travelers', `${s.travelers}${s.who === 'family' ? ' (family)' : s.who === 'friends' ? ' (friends)' : ''}`]);
  if (s.origin) { const o = maps.getOrigin(s.origin); rows.push(['Leaving from', o ? o.city : s.origin]); }
  if (s.destination) { const d = maps.getDestination(s.destination); rows.push(['Destination', d ? d.name : s.destination]); } else if (s.anywhere) rows.push(['Destination', 'Anywhere']);
  if (s.notCountry) rows.push(['Region', `Outside ${s.notCountry}`]);
  else if (s.region === 'international') rows.push(['Region', 'International']);
  if (s.nights) rows.push(['Length', `${s.nights} nights`]);
  if (s.dateMode === 'exact' && s.depart) rows.push(['Leaving', s.depart]);
  else if (s.dateMode === 'flexible' && s.month) rows.push(['When', s.month]);
  else if (s.dateMode === 'anytime') rows.push(['Dates', 'Flexible']);
  if (s.style) rows.push(['Style', s.style === 'all-inclusive' ? 'All-inclusive' : s.style.charAt(0).toUpperCase() + s.style.slice(1)]);
  if (s.flightStops === 'nonstop') rows.push(['Flights', s.flightRule === 'hard' ? 'Nonstop only' : 'Nonstop if possible']);
  else if (s.flightStops === 'any') rows.push(['Flights', 'A stop is fine']);
  const h = [];
  if (s.hotelRules.minStars) h.push(`${s.hotelRules.minStars}-star or better`);
  if (s.hotelRules.allInclusive) h.push('all-inclusive');
  if (s.hotelRules.breakfast) h.push('breakfast');
  if (s.hotelRules.beachfront) h.push('beachfront');
  if (h.length) rows.push(['Hotel', h.join(', ')]);
  if (s.transfer) rows.push(['Transfers', 'Airport transfers included']);
  if (s.refundable) rows.push(['Cancellation', 'Refundable']);
  if (s.priority) rows.push(['Matters most', { hotel: 'The hotel', flights: 'The flights', longer: 'A longer trip', activities: 'Experiences', price: 'Lowest price' }[s.priority]]);
  const locks = lockedWords(s);
  if (locks.length) rows.push(['Locked', locks.join(', ')]);
  return rows;
}

module.exports = { newState, applyUpdates, nextQuestion, toQuery, budgetContext, bookingBudget, vacationBudget, rulesOf, lockedWords, pushMessage, askedFor, LOCK_KEYS, LOCK_LABEL };
