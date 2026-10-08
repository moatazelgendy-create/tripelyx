// The request state machine (plan §C5). Pure: no store, no clock (opts.now is passed in), inputs never mutated.
// STUB from Stage 0 with the frozen interface; Stage 1P builds it. The service reaches it as
// this.policy.transition / effectiveStatus / expiresAt (policy/index.js), so tests can use fakePolicy().
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

function notBuilt() { throw new Error('[business] not built'); }

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

/**
 * Apply one event to a request.
 * - swap:    next = { ...event.draft, updatedAt }; history 'swapped' with savedCents = request.totalCents −
 *            event.draft.totalCents and note = the alternative's label. originalTotalCents never changes.
 * - submit:  with opts.recheck.status 'changed'|'unavailable': next = { ...event.draft, updatedAt },
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
function transition(request, event, opts) { notBuilt(); }

/**
 * What a page shows (GETs use this and write nothing): 'expired' when pending and nowIso ≥ expiresAt;
 * 'past' when approved and query.departDate is before today in `timezone`; otherwise the stored status.
 * @param {import('./types').Request} request
 * @param {string} nowIso
 * @param {string} [timezone] the org's (default 'UTC')
 * @returns {import('./types').EffectiveStatus}
 */
function effectiveStatus(request, nowIso, timezone = 'UTC') { notBuilt(); }

/**
 * When a pending request expires: min(submittedAt + approvalHours, the departure date's local midnight in
 * the company's time zone (tz.localMidnightUtc)).
 * @param {string} submittedAt ISO
 * @param {number} approvalHours 4..168
 * @param {string} departDate 'YYYY-MM-DD'
 * @param {string} timezone the org's
 * @returns {string} ISO
 */
function expiresAt(submittedAt, approvalHours, departDate, timezone) { notBuilt(); }

module.exports = {
  EVENTS, TERMINAL, REASON_MAX_CHARS, NOTE_MIN_CHARS, MESSAGE_CHARS, MESSAGES_MAX, HISTORY_MAX,
  transition, effectiveStatus, expiresAt,
};
