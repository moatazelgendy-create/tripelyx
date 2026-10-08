// The request state machine (plan §C5). Pure: no store, no clock (opts.now is passed in), inputs never mutated.
// The service reaches it as this.policy.transition / effectiveStatus / expiresAt (policy/index.js), so tests
// can use fakePolicy().
//
// Every guard below is re-checked inside the Repo.commit CAS fn on the freshly read document: the CAS fn
// calls transition(doc, event, opts) and assigns result.next onto doc, appends result.history (keeping the
// newest 50) and throws whatever transition throws. "Booked" is not a state in phase 1.
//
//   from              event     to                          guard
//   (new)             create    draft                       trip.request (requests.createRequest; not a transition)
//   draft             swap      draft                       traveler; the alternative is one of request.alternatives
//   draft             submit    approved (auto)             traveler; recheck same; evaluation within and budget fits
//   draft             submit    pending                     out of policy (outOfPolicy 'approval') or budget-only; reason
//                                                           ≥ org.settings.reasonMinChars and ≤ 500, no card number;
//                                                           approver resolved (else 422 no_approver)
//   draft             submit    (refused 422, stays draft)  blocked
//   draft             submit    draft (re-priced)           recheck changed or unavailable: event.draft is written
//   draft, pending    cancel    cancelled                   traveler
//   approved          cancel    cancelled                   traveler before the departure date (org time zone), or
//                                                           approval.override; the service releases the budget hold
//   pending           approve   approved (manual)           decider ≠ traveler; assigned approver, pool member or
//                                                           approval.override (note required); now < expiresAt; recheck
//                                                           same; budget fits or ackOverBudget
//   pending           approve   draft with `returned`       recheck changed or unavailable (approval cleared)
//   pending           deny      denied                      note ≥ 10 characters; decider rules as approve
//   pending           expire    expired                     now ≥ expiresAt (the service persists it, then answers 409)
//   draft, pending,   message   (unchanged)                 traveler, assigned approver, pool member or override holder;
//   approved                                                text 2..1000, no card number; ≤ 50 messages
//   denied, cancelled, expired: terminal ("Plan this trip again" is a GET search link).
// Automatic events (expire, a price-changed return) never override a human decision.
//
// Errors (AppError code, status):
//   'invalid_transition' 409  the event is not legal from the stored status (or the request is terminal)
//   'request_expired'    409  pending and now ≥ expiresAt, for any event but 'expire'
//   'alternative_gone'   410  swap to an alternative the request no longer lists
//   'departed'           409  the traveler cancels an approved trip on or after its departure date
//   'not_found'          404  the actor is not someone this event allows (the route gate normally stops them first)
//   'self_approval'      422  the decider is the traveler (every role, Owner included)
//   'policy_blocked'     422  submit of a blocked trip
//   'reason_too_short'   422  reason.text shorter than org.settings.reasonMinChars (or longer than 500)
//   'card_number'        422  a card number in a reason, note or message (cards.hasCardNumber)
//   'no_approver'        422  nobody can approve (single-person company copy)
//   'too_late'           422  the computed expiresAt is not after now (the trip leaves too soon to wait)
//   'note_required'      422  deny or override without a note of at least 10 characters
//   'over_budget'        422  approve past the budget without ackOverBudget
//   'invalid_message'    422  message text outside 2..1000 characters
//   'too_many_messages'  409  the request already holds 50 messages
//
// Settled details:
// - Checks run in this order: terminal → invalid_transition; pending past expiresAt (any event but expire) →
//   request_expired; the event's own from-status; who may act (self_approval comes before not_found for
//   approve and deny); the event's fields.
// - submit and approve need opts.recheck (the service always prices again); deny, cancel, expire and message
//   do not. submit needs opts.evaluation unless the recheck re-priced the draft.
// - A submit whose evaluation says within but whose total no longer fits event.budget goes the pending way
//   (reason and approver needed): "within and budget fits" is what auto-approves.
// - An approver resolution naming the traveler (it never should) counts as nobody: 422 no_approver, and the
//   traveler is never written into poolIds.
// - 'assigned' needs the actor to be approval.approverId and still hold approval.decide; 'pool' needs
//   opts.pooled, approval.pool and approval.decide; anyone else needs approval.override, on a request that is
//   not their own. The same override rule lets someone else cancel an approved trip; it never lets the
//   traveler cancel their own after departure.
// - Texts (reason, notes, messages) are cleaned with validate.text (NFKC, invisible characters removed),
//   then measured; a decider's note is kept to its first 1,000 characters. A reason category outside
//   REASON_CATEGORIES is stored as null.
// - submit clears `returned` (the traveler has seen the new price), and a within submit clears `reason`.
const { AppError } = require('../lib/errors');
const roles = require('./roles');
const cards = require('./cards');
const tz = require('./tz');
const v = require('./validate');
const { REASON_CATEGORIES } = require('./constants');

/** Event types transition() accepts. */
const EVENTS = Object.freeze(['swap', 'submit', 'cancel', 'approve', 'deny', 'expire', 'message']);
/** Statuses no event leaves. */
const TERMINAL = Object.freeze(['denied', 'cancelled', 'expired']);
/** Longest exception reason (the shortest is the company's reasonMinChars). */
const REASON_MAX_CHARS = 500;
/** Shortest note on a deny or an override approval. */
const NOTE_MIN_CHARS = 10;
/** Message length range, and the most messages one request keeps. */
const MESSAGE_CHARS = Object.freeze([2, 1000]);
const MESSAGES_MAX = 50;
/** The most history lines one request keeps (the audit log keeps everything). */
const HISTORY_MAX = 50;

const HOUR_MS = 3600000;
const err = (code, message, status) => new AppError(code, message, status);
const invalidTransition = () => err('invalid_transition', 'Someone just acted on this request. Here is where it stands now.', 409);
const notFound = () => err('not_found', 'Not found.', 404);
const POLICY = Object.freeze({ system: 'policy' });
const CLOCK = Object.freeze({ system: 'clock' });

/** An ISO instant as epoch milliseconds; a programming error otherwise. */
function ms(iso, what) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) throw new TypeError(`[business] ${what} must be an ISO time`);
  return t;
}

const isPastExpiry = (request, nowMs) => request.status === 'pending' && typeof request.expiresAt === 'string' && nowMs >= Date.parse(request.expiresAt);
const holds = (member, perm) => !!member && member.status === 'active' && roles.can(member.role, perm);
const copy = x => (x === undefined || x === null ? null : structuredClone(x));

/** How the actor may decide (or message) this pending request: 'assigned', 'pool', 'override' or null. */
function decidedAs(request, actor, member, pooled) {
  const a = request.approval || {};
  const me = actor && actor.userId;
  if (!me || me === request.travelerId) return null;
  if (member && member.userId && member.userId !== me) return null;
  if (a.approverId && me === a.approverId && holds(member, 'approval.decide')) return 'assigned';
  if (pooled === true && a.pool === true && holds(member, 'approval.decide')) return 'pool';
  if (holds(member, 'approval.override')) return 'override';
  return null;
}

/** The budget hold an approval writes: the request's whole total against that budget. */
function hold(request, budget) {
  return budget ? { budgetId: budget.budgetId, periodKey: budget.periodKey, cents: request.totalCents } : null;
}
const overBudget = (request, budget) => !!budget && Number.isFinite(budget.remainingCents) && request.totalCents > budget.remainingCents;

/** A decider's note (deny, approval) cleaned and kept to NOTE_MAX_CHARS, like any free text: '' when none. */
const NOTE_MAX_CHARS = 1000;
const noteText = raw => v.text(raw, NOTE_MAX_CHARS, { multiline: true });

function needDraft(event) {
  if (!event.draft || typeof event.draft !== 'object') throw new TypeError(`[business] a re-priced ${event.type} needs event.draft`);
  return copy(event.draft);
}

/**
 * Apply one event to a request.
 * - swap:    next = { ...event.draft, updatedAt }; history 'swapped' with savedCents = request.totalCents −
 *            event.draft.totalCents and note = the alternative's label. originalTotalCents never changes.
 * - submit:  with opts.recheck.status 'changed'|'unavailable': next = { ...event.draft, updatedAt: opts.now },
 *            outcome 'repriced' (event.draft required). Otherwise by opts.evaluation.status:
 *            within and budget fits → status 'approved', approval { mode 'auto', approverId null, pool false,
 *            poolIds [], rule null, decidedBy { system: 'policy' }, decidedAt now, decidedAs null, note '',
 *            overBudgetAck false }, budget { budgetId, periodKey, cents: totalCents } when event.budget,
 *            submittedAt now, expiresAt null; history by { system: 'policy' }, outcome 'auto_approved'.
 *            out → status 'pending', reason, approval { mode 'manual', approverId, pool, poolIds, rule, rest null/''/false },
 *            submittedAt now, expiresAt = expiresAt(now, org.settings.approvalHours, query.departDate, org.timezone);
 *            outcome 'submitted'. blocked → throws 422 'policy_blocked'. evaluation is stored with evaluatedAt now.
 * - cancel:  status 'cancelled'; request.budget is left as it was. outcome 'cancelled'.
 * - approve: recheck changed/unavailable → status 'draft', { ...event.draft }, returned { at now, why
 *            'price_changed'|'unavailable', fromCents request.totalCents, toCents recheck.newTotalCents },
 *            approval null, submittedAt null, expiresAt null; history by { system: 'policy' }, outcome 'returned'.
 *            Otherwise status 'approved', approval.decidedBy actor, decidedAt now, decidedAs ('assigned' when
 *            actor is approval.approverId; 'pool' when opts.pooled and approval.pool; else 'override' when the
 *            member holds approval.override), note, overBudgetAck; budget hold as for an auto approval.
 *            outcome 'approved'.
 * - deny:    status 'denied', approval.decidedBy/decidedAt/decidedAs/note. outcome 'denied'.
 * - expire:  status 'expired'; history by { system: 'clock' }. outcome 'expired'.
 * - message: next = { messages: [...messages, { at now, by actor user id, name, text }], updatedAt }; history null.
 * Every result sets next.updatedAt = opts.now; every history line has at = opts.now.
 * @param {import('./types').Request} request the freshly read document (not mutated)
 * @param {import('./types').LifecycleEvent} event
 * @param {import('./types').TransitionOpts} opts
 * @returns {import('./types').TransitionResult}
 * @throws {AppError} see the error table above
 */
function transition(request, event, opts) {
  if (!request || typeof request !== 'object') throw new TypeError('[business] transition needs a request');
  if (!event || !EVENTS.includes(event.type)) throw new TypeError(`[business] unknown event ${event && event.type}`);
  const o = opts || {};
  const now = o.now;
  const nowMs = ms(now, 'opts.now');
  const { actor = null, member = null, pooled = false, org = null } = o;
  const from = request.status;
  if (TERMINAL.includes(from)) throw invalidTransition();
  if (event.type !== 'expire' && isPastExpiry(request, nowMs)) {
    throw err('request_expired', 'This request expired, so nothing was approved. The traveler can plan it again.', 409);
  }
  const isTraveler = !!actor && typeof actor.userId === 'string' && actor.userId === request.travelerId;
  const line = (action, to, extra = {}) => ({ at: now, by: copy(actor), action, from, to, note: '', ...extra });

  switch (event.type) {
    case 'swap': {
      if (from !== 'draft') throw invalidTransition();
      if (!isTraveler) throw notFound();
      const alt = event.alternative;
      if (!alt || typeof alt.id !== 'string' || !(request.alternatives || []).some(a => a && a.id === alt.id)) {
        throw err('alternative_gone', "That option isn't available anymore. Here are the current ones.", 410);
      }
      const draft = needDraft(event);
      return {
        next: { ...draft, updatedAt: now },
        history: line('swapped', 'draft', { note: String(alt.label || ''), savedCents: request.totalCents - draft.totalCents }),
        outcome: 'swapped',
      };
    }

    case 'submit': {
      if (from !== 'draft') throw invalidTransition();
      if (!isTraveler) throw notFound();
      if (!o.recheck || typeof o.recheck.status !== 'string') throw new TypeError('[business] submit needs opts.recheck');
      if (o.recheck.status !== 'same') {
        return { next: { ...needDraft(event), updatedAt: now }, history: line('repriced', 'draft'), outcome: 'repriced' };
      }
      const ev = o.evaluation;
      if (!ev || typeof ev.status !== 'string') throw new TypeError('[business] submit needs opts.evaluation');
      if (ev.status === 'blocked') {
        throw err('policy_blocked', `This trip can't be requested under ${(org && org.name) || 'your company'}'s policy. Pick one of the options below.`, 422);
      }
      const evaluation = { ...copy(ev), evaluatedAt: now };
      const budget = event.budget || null;
      if (ev.status === 'within' && !overBudget(request, budget)) {
        return {
          next: {
            status: 'approved', evaluation, reason: null, returned: null, budget: hold(request, budget), submittedAt: now, expiresAt: null, updatedAt: now,
            approval: { mode: 'auto', approverId: null, pool: false, poolIds: [], rule: null, decidedBy: { ...POLICY }, decidedAt: now, decidedAs: null, note: '', overBudgetAck: false },
          },
          history: { ...line('auto_approved', 'approved'), by: { ...POLICY } },
          outcome: 'auto_approved',
        };
      }
      if (!org || !org.settings) throw new TypeError('[business] submit needs opts.org');
      const min = org.settings.reasonMinChars;
      const text = v.text(event.reason && event.reason.text, REASON_MAX_CHARS + 1, { multiline: true });
      if (text.length < min || text.length > REASON_MAX_CHARS) {
        throw err('reason_too_short', `Tell your approver why this trip needs an exception, in ${min} to ${REASON_MAX_CHARS} characters.`, 422);
      }
      if (cards.hasCardNumber(text)) throw err('card_number', cards.CARD_MESSAGE, 422);
      const category = event.reason && REASON_CATEGORIES.includes(event.reason.category) ? event.reason.category : null;
      const ap = event.approver;
      const poolIds = ap && Array.isArray(ap.poolIds) ? ap.poolIds.filter(id => typeof id === 'string' && id && id !== request.travelerId) : [];
      const named = ap && typeof ap.approverId === 'string' && ap.approverId && ap.approverId !== request.travelerId ? ap.approverId : null;
      const resolved = !!ap && ((ap.rule === 'admin' && ap.pool === true && poolIds.length > 0) || ((ap.rule === 'approver' || ap.rule === 'manager') && !!named));
      if (!resolved) {
        throw err('no_approver', `No one else at ${org.name || 'your company'} can approve this yet, and nobody approves their own trip. `
          + 'Invite a Manager or Travel Admin, or choose an option inside your policy.', 422);
      }
      const exp = expiresAt(now, org.settings.approvalHours, request.query.departDate, org.timezone);
      if (Date.parse(exp) <= nowMs) {
        throw err('too_late', 'This trip leaves too soon to wait for an approval. Choose a later date or an option inside your policy.', 422);
      }
      return {
        next: {
          status: 'pending', evaluation, reason: { text, category }, returned: null, submittedAt: now, expiresAt: exp, updatedAt: now,
          approval: {
            mode: 'manual', approverId: ap.rule === 'admin' ? null : named, pool: ap.rule === 'admin', poolIds: ap.rule === 'admin' ? poolIds : [],
            rule: ap.rule, decidedBy: null, decidedAt: null, decidedAs: null, note: '', overBudgetAck: false,
          },
        },
        history: line('submitted', 'pending'),
        outcome: 'submitted',
      };
    }

    case 'cancel': {
      if (!['draft', 'pending', 'approved'].includes(from)) throw invalidTransition();
      if (from === 'approved') {
        if (!org || !org.timezone) throw new TypeError('[business] cancelling an approved trip needs opts.org');
        const beforeDeparture = tz.localDate(org.timezone, nowMs) < request.query.departDate;
        const override = !isTraveler && holds(member, 'approval.override') && (!member.userId || member.userId === (actor && actor.userId));
        if (!(isTraveler && beforeDeparture) && !override) {
          if (isTraveler) throw err('departed', 'This trip has already started, so it can no longer be cancelled here.', 409);
          throw notFound();
        }
      } else if (!isTraveler) {
        throw notFound();
      }
      return { next: { status: 'cancelled', updatedAt: now }, history: line('cancelled', 'cancelled'), outcome: 'cancelled' };
    }

    case 'approve':
    case 'deny': {
      if (from !== 'pending') throw invalidTransition();
      if (isTraveler) throw err('self_approval', "You can't decide your own trip.", 422);
      const as = decidedAs(request, actor, member, pooled);
      if (!as) throw notFound();
      const note = noteText(event.note);
      if ((event.type === 'deny' || as === 'override') && note.length < NOTE_MIN_CHARS) {
        throw err('note_required', event.type === 'deny' ? `Tell the traveler why, in at least ${NOTE_MIN_CHARS} characters.`
          : `Add a note of at least ${NOTE_MIN_CHARS} characters to approve a request assigned to someone else.`, 422);
      }
      if (cards.hasCardNumber(note)) throw err('card_number', cards.CARD_MESSAGE, 422);
      if (event.type === 'deny') {
        return {
          next: { status: 'denied', approval: { ...copy(request.approval), decidedBy: copy(actor), decidedAt: now, decidedAs: as, note }, updatedAt: now },
          history: line('denied', 'denied', { note }),
          outcome: 'denied',
        };
      }
      if (!o.recheck || typeof o.recheck.status !== 'string') throw new TypeError('[business] approve needs opts.recheck');
      if (o.recheck.status !== 'same') {
        return {
          next: {
            ...(event.draft ? copy(event.draft) : {}), status: 'draft', approval: null, submittedAt: null, expiresAt: null, updatedAt: now,
            returned: {
              at: now, why: o.recheck.status === 'unavailable' ? 'unavailable' : 'price_changed', fromCents: request.totalCents,
              toCents: Number.isSafeInteger(o.recheck.newTotalCents) ? o.recheck.newTotalCents : null,
            },
          },
          history: { ...line('returned', 'draft'), by: { ...POLICY } },
          outcome: 'returned',
        };
      }
      const budget = event.budget || null;
      const over = overBudget(request, budget);
      if (over && event.ackOverBudget !== true) {
        const where = budget.departmentName ? `${budget.departmentName} over its${budget.periodLabel ? ` ${budget.periodLabel}` : ''} budget` : 'the department over its budget';
        throw err('over_budget', `Approving this takes ${where}. Tick the box to approve it anyway.`, 422);
      }
      return {
        next: {
          status: 'approved', budget: hold(request, budget), updatedAt: now,
          evaluation: o.evaluation ? { ...copy(o.evaluation), evaluatedAt: now } : copy(request.evaluation),
          approval: { ...copy(request.approval), decidedBy: copy(actor), decidedAt: now, decidedAs: as, note, overBudgetAck: over },
        },
        history: line('approved', 'approved', { note }),
        outcome: 'approved',
      };
    }

    case 'expire': {
      if (!isPastExpiry(request, nowMs)) throw invalidTransition();
      return { next: { status: 'expired', updatedAt: now }, history: { ...line('expired', 'expired'), by: { ...CLOCK } }, outcome: 'expired' };
    }

    case 'message': {
      if (!['draft', 'pending', 'approved'].includes(from)) throw invalidTransition();
      const a = request.approval || {};
      const me = actor && actor.userId;
      const allowed = isTraveler || (!!me && !!a.approverId && me === a.approverId) || (!!me && pooled === true && a.pool === true)
        || (!!me && holds(member, 'approval.override') && (!member.userId || member.userId === me));
      if (!allowed) throw notFound();
      const text = v.text(event.text, MESSAGE_CHARS[1] + 1, { multiline: true });
      if (text.length < MESSAGE_CHARS[0] || text.length > MESSAGE_CHARS[1]) throw err('invalid_message', 'Write 2 to 1,000 characters.', 422);
      if (cards.hasCardNumber(text)) throw err('card_number', cards.CARD_MESSAGE, 422);
      const messages = Array.isArray(request.messages) ? request.messages : [];
      if (messages.length >= MESSAGES_MAX) throw err('too_many_messages', `This request has reached ${MESSAGES_MAX} messages.`, 409);
      return {
        next: { messages: [...copy(messages), { at: now, by: me, name: String(actor.name || ''), text }], updatedAt: now },
        history: null,
        outcome: 'message',
      };
    }

    default:
      throw new TypeError('[business] unreachable');
  }
}

/**
 * What a page shows (GETs use this and write nothing): 'expired' when pending and nowIso ≥ expiresAt;
 * 'past' when approved and query.departDate is before today in `timezone`; otherwise the stored status.
 * @param {import('./types').Request} request
 * @param {string} nowIso
 * @param {string} [timezone] the org's (default 'UTC')
 * @returns {import('./types').EffectiveStatus}
 */
function effectiveStatus(request, nowIso, timezone = 'UTC') {
  const nowMs = ms(nowIso, 'nowIso');
  if (isPastExpiry(request, nowMs)) return 'expired';
  if (request.status === 'approved' && request.query && typeof request.query.departDate === 'string'
    && request.query.departDate < tz.localDate(timezone, nowMs)) return 'past';
  return request.status;
}

/**
 * When a pending request expires: min(submittedAt + approvalHours, the departure date's local midnight in
 * the company's time zone (tz.localMidnightUtc)).
 * @param {string} submittedAt ISO
 * @param {number} approvalHours 4..168
 * @param {string} departDate 'YYYY-MM-DD'
 * @param {string} timezone the org's
 * @returns {string} ISO
 */
function expiresAt(submittedAt, approvalHours, departDate, timezone) {
  const start = ms(submittedAt, 'submittedAt');
  if (!Number.isSafeInteger(approvalHours) || approvalHours <= 0) throw new TypeError('[business] approvalHours must be a whole number of hours');
  const byHours = start + approvalHours * HOUR_MS;
  const midnight = Date.parse(tz.localMidnightUtc(timezone, departDate));
  return new Date(Math.min(byHours, midnight)).toISOString();
}

module.exports = {
  EVENTS, TERMINAL, REASON_MAX_CHARS, NOTE_MIN_CHARS, MESSAGE_CHARS, MESSAGES_MAX, HISTORY_MAX,
  transition, effectiveStatus, expiresAt,
};
