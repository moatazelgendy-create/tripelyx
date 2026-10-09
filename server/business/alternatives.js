// "AI-powered cheaper alternatives": ranking (plan §G2). Pure and deterministic: every alternative is a
// priced result of the same demo search (composer.variants), never an estimate. The service holds it as
// this.alternatives.buildAlternatives (types.AlternativesEngine), so tests can use fakeAlternatives().
//
// Kept: every row available, not blocked, savesCents ≥ MIN_SAVING_CENTS; deduplicated by selection (and query).
// Ranked: within policy first; then savesCents descending; then fewer giveUps; then the smaller date shift;
// then id. At most MAX_ALTERNATIVES. cheapestWithin (the cheapest within-policy candidate) is pinned first,
// labelled CHEAPEST_WITHIN_LABEL, and stored on the request for approvers and reports.
// Labels have no digits and no currency signs:
//   fare 'Same flight, Classic fare' · flight 'Another flight the same day' · stops 'One stop via Istanbul'
//   cabin 'Premium economy instead of Business' · dates 'Leave a day later' · hotel 'Another hotel in London'
//   room 'Standard room, same hotel' · all_within 'Every part inside your policy'
// (A room label names the cheaper room rather than calling it smaller: the data says which room, not its size.)
// giveUps come from diff.giveUps(pick rows, alternative rows).
//
// Candidates that break the plan's promises are left out, never repaired: a different route, destination or
// hotel city; a date change that isn't kind 'dates', or kind 'dates' when the traveler's dates can't move; more
// than the one change its kind names (all_within and dates excepted), or a change that isn't what its kind
// says (a fare or room change on another itinerary or hotel, a flight or hotel change on the same one, a
// stops change with no more stops, a cabin change to a cabin that isn't lower); a trip shape that differs from the pick
// (a return or a hotel added or dropped); a totalCents that isn't the sum of its rows.
// The rows are checked, not only the query and the change's own words:
// - every row keeps the pick's dates (a flight's local departure date; a hotel's check-in, check-out and nights),
//   moved by the query's shift for kind 'dates' and by nothing for every other kind;
// - fare, flight and stops keep the pick's cabin (only kind 'cabin' changes it, to a lower one);
// - dates: the whole trip moves together by change.days (1 to MAX_SHIFT_DAYS either way): departure, return,
//   check-in and check-out all by the same days, with the same fare family, cabin and stops on each leg and
//   the same hotel, room and nights;
// - all_within: when pickEval is given, only components outside the policy in the pick are swapped.
// Labels say only what is true: all_within is "Every part inside your policy" when it evaluates within (and
// CHEAPEST_WITHIN_LABEL when pinned), else "Other options for the parts outside your policy"; a dates label
// takes its direction and days from the query's own shift.
// truncated is the composer's flag, or true when more than MAX_ALTERNATIVES candidates qualified.
const crypto = require('node:crypto');
const { CABIN_LABELS, CABIN_RANK } = require('./constants');
const { STATUS_RANK } = require('./policy/evaluate');
const { giveUps: diffGiveUps } = require('./diff');

/** The most alternatives a request shows. */
const MAX_ALTERNATIVES = 5;
/** An alternative must save at least this much (cents). */
const MIN_SAVING_CENTS = 100;
/** The label of the pinned cheapest within-policy option. */
const CHEAPEST_WITHIN_LABEL = 'Cheapest option inside your policy';

const COMPONENTS = Object.freeze(['out', 'back', 'hotel']);
const KIND_ORDER = Object.freeze(['fare', 'flight', 'stops', 'cabin', 'dates', 'room', 'hotel', 'all_within']);
const SINGLE = Object.freeze({ fare: ['out', 'back'], flight: ['out', 'back'], stops: ['out', 'back'], cabin: ['out', 'back'], room: ['hotel'], hotel: ['hotel'] });
const UNSAFE_LABEL = /[0-9$€£¥]|USD/;
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
const NOTHING = 'Nothing else changes';
/** The most days a 'dates' alternative moves the trip (search.FLEX_DAYS: "My dates can move by up to 3 days"). */
const MAX_SHIFT_DAYS = 3;
const DAY_MS = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An alternative's id: the first 16 hex characters of sha256 over the selection keys and the query's dates
 * (stable across searches, so a swap form can name it).
 * @param {import('./types').Selection} selection
 * @param {import('./types').TripQuery} query
 * @returns {string}
 */
function alternativeId(selection, query) {
  const s = selection || {}, q = query || {}, h = q.hotel || {};
  return crypto.createHash('sha256')
    .update(JSON.stringify([s.out ?? null, s.back ?? null, s.hotel ?? null, q.departDate ?? null, q.returnDate ?? null, h.checkIn ?? null, h.checkOut ?? null]))
    .digest('hex').slice(0, 16);
}

const sumRows = rows => COMPONENTS.reduce((n, c) => n + (rows[c] ? rows[c].totalCents : 0), 0);
const nameKey = s => String(s ?? '').normalize('NFKC').trim().toLowerCase();
const leg = (rows, c) => rows[c] && rows[c].segments && rows[c].segments.length ? rows[c].segments : null;
/** Whole days from date a to date b ('YYYY-MM-DD'); NaN unless both are dates. */
const dayShift = (a, b) => (ISO_DATE.test(a) && ISO_DATE.test(b) ? Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS) : NaN);
const departDate = row => (row.segments && row.segments.length ? String(row.segments[0].departLocal).slice(0, 10) : null);

/** Does the candidate keep the pick's route, destination, hotel city and trip shape? */
function sameTrip(pick, v) {
  const pq = pick.query, vq = v.query;
  if (!vq || vq.from !== pq.from || vq.to !== pq.to) return false;
  if (Boolean(pq.returnDate) !== Boolean(vq.returnDate) || Boolean(pq.hotel) !== Boolean(vq.hotel)) return false;
  if (pq.hotel && (nameKey(pq.hotel.city) !== nameKey(vq.hotel.city) || nameKey(pq.hotel.country) !== nameKey(vq.hotel.country))) return false;
  for (const c of COMPONENTS) if (Boolean(pick.rows[c]) !== Boolean(v.rows[c])) return false;
  // The rows themselves fly the same airports and sleep in the same city.
  for (const c of ['out', 'back']) {
    const a = leg(pick.rows, c), b = leg(v.rows, c);
    if (!a !== !b) return false;
    if (a && (a[0].from.code !== b[0].from.code || a[a.length - 1].to.code !== b[b.length - 1].to.code)) return false;
  }
  if (pick.rows.hotel && nameKey(pick.rows.hotel.city) !== nameKey(v.rows.hotel.city)) return false;
  return true;
}

/** How many days the candidate's query moves the whole trip (0 for none); NaN when its dates don't move together. */
function queryShift(pq, vq) {
  const shift = dayShift(pq.departDate, vq.departDate);
  if (!Number.isInteger(shift)) return NaN;
  if (pq.returnDate && dayShift(pq.returnDate, vq.returnDate) !== shift) return NaN;
  if (pq.hotel && (dayShift(pq.hotel.checkIn, vq.hotel.checkIn) !== shift || dayShift(pq.hotel.checkOut, vq.hotel.checkOut) !== shift)) return NaN;
  return shift;
}

/** Does every row keep the pick's dates, moved by `shift` days (a flight's departure; a hotel's stay and nights)? */
function rowsMovedBy(pick, v, shift) {
  for (const c of COMPONENTS) {
    const p = pick.rows[c], q = v.rows[c];
    if (!p) continue;
    if (c === 'hotel') {
      if (q.nights !== p.nights || dayShift(p.checkIn, q.checkIn) !== shift || dayShift(p.checkOut, q.checkOut) !== shift) return false;
    } else if (dayShift(departDate(p), departDate(q)) !== shift) {
      return false;
    }
  }
  return true;
}

/** A 'dates' candidate: the whole trip moved by change.days, with the same fares, cabins, stops, hotel and room. */
function datesOnly(pick, v, shift) {
  if (pick.query.datesFlexible !== true || shift === 0 || Math.abs(shift) > MAX_SHIFT_DAYS || v.change.days !== shift) return false;
  for (const c of ['out', 'back']) {
    const p = pick.rows[c], q = v.rows[c];
    if (p && (q.optionId !== p.optionId || q.cabin !== p.cabin || q.stops !== p.stops)) return false;
  }
  const p = pick.rows.hotel, q = v.rows.hotel;
  return !p || (q.offerId === p.offerId && q.optionId === p.optionId);
}

/** Is the candidate exactly the change its kind names? */
function oneChange(pick, v, pickEval) {
  const kind = v.change && v.change.kind;
  if (!KIND_ORDER.includes(kind)) return false;
  const shift = queryShift(pick.query, v.query);
  if (!Number.isInteger(shift) || !rowsMovedBy(pick, v, shift)) return false;
  if (kind === 'dates') return datesOnly(pick, v, shift);
  if (shift !== 0) return false;
  const changed = COMPONENTS.filter(c => (pick.rows[c] ? pick.rows[c].key : null) !== (v.rows[c] ? v.rows[c].key : null)
    || (pick.rows[c] && v.rows[c] && pick.rows[c].cabin !== v.rows[c].cabin));
  if (kind === 'all_within') {
    // Only what was outside the policy is swapped (checked when the caller hands over the pick's evaluation).
    const parts = pickEval && pickEval.components && typeof pickEval.components === 'object' ? pickEval.components : null;
    return changed.length >= 1 && (!parts || changed.every(c => !!parts[c] && parts[c].status !== 'within'));
  }
  if (changed.length !== 1 || changed[0] !== v.change.component || !SINGLE[kind].includes(changed[0])) return false;
  const c = changed[0], p = pick.rows[c], q = v.rows[c];
  if (kind === 'cabin') return CABIN_RANK[q.cabin] < CABIN_RANK[p.cabin];
  // Fare, flight and stops keep the cabin; the same itinerary or hotel for a fare or room change, another one
  // for a flight or hotel change.
  if (c !== 'hotel' && q.cabin !== p.cabin) return false;
  const sameOffer = p.offerId === q.offerId;
  if (kind === 'fare' || kind === 'room') return sameOffer;
  if (kind === 'flight' || kind === 'hotel') return !sameOffer;
  return q.stops > p.stops;
}

/** The label of an alternative: plain words, no digits, no currency, nothing its evaluation contradicts. */
function labelFor(pick, v, evaluation) {
  const c = v.change.component;
  const row = COMPONENTS.includes(c) ? v.rows[c] : null;
  const was = COMPONENTS.includes(c) ? pick.rows[c] : null;
  let label;
  switch (v.change.kind) {
    case 'fare': label = row && row.fare && row.fare.name ? `Same flight, ${row.fare.name} fare` : 'Same flight, another fare'; break;
    case 'flight': label = 'Another flight the same day'; break;
    case 'stops': {
      const n = row ? row.stops : 1;
      const via = row && row.via && row.via.length === 1 ? ` via ${row.via[0].city}` : '';
      label = `${n >= 1 && n < WORDS.length ? WORDS[n].replace(/^./, ch => ch.toUpperCase()) : 'More'} ${n === 1 ? 'stop' : 'stops'}${via}`;
      break;
    }
    case 'cabin': label = row && was ? `${CABIN_LABELS[row.cabin]} instead of ${CABIN_LABELS[was.cabin]}` : 'A lower cabin'; break;
    case 'dates': {
      const shift = queryShift(pick.query, v.query);
      const d = Math.abs(shift);
      const when = d === 1 ? 'a day' : d < WORDS.length ? `${WORDS[d]} days` : 'a few days';
      label = `Leave ${when} ${shift > 0 ? 'later' : 'earlier'}`;
      break;
    }
    case 'room': label = row && row.room && row.room.name ? `${row.room.name}, same hotel` : 'Another room, same hotel'; break;
    case 'hotel': label = row && row.city ? `Another hotel in ${row.city}` : 'Another hotel in the same city'; break;
    case 'all_within': label = evaluation && evaluation.status === 'within' ? 'Every part inside your policy' : 'Other options for the parts outside your policy'; break;
    default: label = 'A cheaper option';
  }
  if (UNSAFE_LABEL.test(label)) {
    label = { fare: 'Same flight, another fare', stops: 'A flight with a stop', cabin: 'A lower cabin', room: 'Another room, same hotel', hotel: 'Another hotel in the same city' }[v.change.kind] || 'A cheaper option';
  }
  return label;
}

const giveUpCount = list => list.filter(g => g !== NOTHING).length;
const shiftOf = a => (a.kind === 'dates' ? Math.abs(a.v.change.days) : 0);
const rank = (a, b) => STATUS_RANK[a.evaluation.status] - STATUS_RANK[b.evaluation.status]
  || b.savesCents - a.savesCents
  || giveUpCount(a.giveUps) - giveUpCount(b.giveUps)
  || shiftOf(a) - shiftOf(b)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Rank the candidates of one pick.
 * @param {import('./types').AlternativesInput} input
 * @returns {import('./types').AlternativesResult} every Alternative's note is '' (the explainer fills it)
 */
function buildAlternatives(input) {
  const { pick, pickEval = null, candidates = [], evaluate, truncated = false } = input || {};
  if (!pick || !pick.rows || !pick.query || typeof evaluate !== 'function') throw new TypeError('[business] buildAlternatives needs pick and evaluate');
  // Dedupe first (by id, preferring the most specific kind, then the plainer change text), so the order the
  // composer lists candidates in never changes the result.
  const byId = new Map();
  for (const v of Array.isArray(candidates) ? candidates : []) {
    if (!v || !v.rows || !v.selection || !v.change || !v.query) continue;
    const parts = COMPONENTS.filter(c => v.rows[c]);
    if (!parts.length || parts.some(c => v.rows[c].available !== true || !Number.isSafeInteger(v.rows[c].totalCents))) continue;
    if (sumRows(v.rows) !== v.totalCents) continue;
    if (!sameTrip(pick, v) || !oneChange(pick, v, pickEval)) continue;
    const savesCents = pick.totalCents - v.totalCents;
    if (savesCents < MIN_SAVING_CENTS) continue;
    const id = alternativeId(v.selection, v.query);
    const was = byId.get(id);
    const key = c => `${KIND_ORDER.indexOf(c.change.kind)}\u0000${c.change.fromText || ''}\u0000${c.change.toText || ''}`;
    if (!was || key(v) < key(was.v)) byId.set(id, { v, savesCents });
  }
  const all = [];
  for (const [id, { v, savesCents }] of byId) {
    const evaluation = evaluate(v);
    if (!evaluation || evaluation.status === 'blocked') continue;
    all.push({ id, kind: v.change.kind, v, savesCents, evaluation, giveUps: diffGiveUps(pick.rows, v.rows) });
  }
  // Within policy sorts first and, inside it, the biggest saving (the lowest total) first: the cheapest option
  // inside policy is therefore the first one, already pinned.
  all.sort(rank);
  const cheapest = all.length && all[0].evaluation.status === 'within' ? all[0] : null;
  const shown = all.slice(0, MAX_ALTERNATIVES);
  const toAlternative = a => ({
    id: a.id, kind: a.kind, label: a === cheapest ? CHEAPEST_WITHIN_LABEL : labelFor(pick, a.v, a.evaluation),
    change: structuredClone(a.v.change), selection: structuredClone(a.v.selection), query: structuredClone(a.v.query),
    rows: structuredClone(a.v.rows), totalCents: a.v.totalCents, savesCents: a.savesCents,
    evaluation: structuredClone(a.evaluation), giveUps: [...a.giveUps], note: '',
  });
  const alternatives = shown.map(toAlternative);
  return {
    alternatives,
    cheapestWithin: cheapest ? alternatives[0] : null,
    noneWithin: !cheapest,
    truncated: !!truncated || all.length > MAX_ALTERNATIVES,
  };
}

module.exports = { MAX_ALTERNATIVES, MIN_SAVING_CENTS, CHEAPEST_WITHIN_LABEL, buildAlternatives, alternativeId };
