// One trip request (/business/o/:orgId/trips/:rid, plan §B6, §H1 to §H3): the draft review, and the pending,
// approved, denied, cancelled, expired and past views; the approver's panel (the fresh price check, requested
// vs the cheapest option inside policy, the traveler's reason, the budget impact, Approve · Deny · Ask a
// question); messages and history. `view.can` (from the service) decides which forms show; the service checks
// everything again on every POST.
//
// Copy (§B6, Stage 1 lead decisions): a submit that found the trip changed says "This trip changed before it
// was sent. Review it and send it again." A price change is claimed only when the totals differ; the same
// total with new terms says the terms changed. The Request Approval form shows whenever the stored verdict is
// 'out' (a blocked trip cannot be requested: its verdict says what to do instead).
//
// Amounts: every one sits in a demo container that says "Demo price · Priced at …" (parts.demoBox and
// friends), in the company's time zone. With real suppliers (real-suppliers design §2.3, §2.4) the containers
// carry the request's source (source.requestSource: an old request reads as demo): supplier test data is
// dashed and tagged TEST DATA; an option that is gone is "no longer in the supplier's test data"; an approved
// test-data trip says "Approved (test data). Nothing was booked."; and an approver whose live price check
// could not run (view.liveError) is told the price is checked again when they approve.
//
// Live prices (go-live design §5.6): every amount says "US dollars, from the airline · Priced at … · Can change
// until booked" (who priced it from the trip's own rows: format.requestKind), the approved banner says
// "Approved. Booking in Tripelyx isn't open yet, so this fare is not held and can change.", a trip inside the
// policy is "approved" (never "approved to book"), and a draft or waiting trip's total says it is checked again
// before it is approved. With live search off (inventory status 'none': turned off, or a mode mismatch) a trip
// priced on live prices can't be checked, so nothing is confirmed, sent or approved until it is on again: the
// traveler's draft and the approver's panel say so (PRICE_CHECK_COPY.searchOff*) instead of offering Confirm,
// Request Approval or Approve; deny, cancel and messages still work. A switch to a cheaper option searches again,
// so the draft's options show with no "Use this option" and their summary says why (searchOffSwap), never that
// the trip can still be sent for approval.
//
// What the page never does: blame the company policy for an option that is gone from the demo data (that is
// said as availability, with a way to plan the trip again); offer a form that can only fail (a draft whose
// departure date has passed shows how to plan it again instead); let the traveler write to "your approver"
// when nobody named will read it; count a supplier's price move as a saving (the saved line sums the swaps'
// own savings, as reports.savedBySwitching does); or cancel an approved trip in one tap.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const f = require('./format');
const p = require('./parts');
const { LABELS, can: roleCan } = require('../../business/roles');
const { REASON_CATEGORIES, REASON_CATEGORY_LABELS, REASON_MIN_CHARS, TIER_LABELS, CABIN_LABELS } = require('../../business/constants');
const tz = require('../../business/tz');
const { REASON_MAX_CHARS, NOTE_MIN_CHARS, MESSAGE_CHARS } = require('../../business/lifecycle');
const { periodKey, periodLabel } = require('../../business/budgets');
const { places, cityOf, routeText, datesText, searchQuery, nightsBetween } = require('./trips');
const { PRICE_CHECK_COPY, SEARCH_CLOSED } = require('../../business/source');

/** Where a gone option went, by the request's source: "no longer in the demo data". */
const GONE = Object.freeze({
  demo: 'no longer in the demo data',
  sandbox: "no longer in the supplier's test data",
  live: 'no longer available from the supplier',
});
const goneWords = source => GONE[source] || GONE.demo;

/**
 * Live search is off (inventory status 'none') and this trip was priced on live prices: its price can't be
 * checked, so it can't be confirmed, sent or approved until a platform admin turns live search on again.
 */
const searchOffFor = (ctx, source) => source === 'live' && !!(ctx && ctx.business && ctx.business.inventory) && ctx.business.inventory.status === 'none';

const COMPONENTS = Object.freeze(['out', 'back', 'hotel']);
/** Who priced a request's amounts, for its labels: from its own rows on live prices, 'price' otherwise. */
const labelKind = (r, source) => f.liveKind(source, f.tripRows(r && r.rows));
const firstName = name => String(name || '').split(' ')[0] || String(name || '');
/** "Denied by Dana Lee: too expensive." without a doubled stop. */
const sentence = s => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Who an ActorRef is, in words. */
function actorName(by, { self = null } = {}) {
  if (!by) return 'Someone';
  if (by.system === 'policy') return 'The policy check';
  if (by.system === 'clock') return 'The clock';
  if (self && by.userId === self) return 'You';
  return by.name || 'Someone';
}

// The statuses each ?ok= code can follow: a notice that no longer fits (someone acted since, or the address
// was typed) is left out rather than shown wrong. 'message' fits any status.
const OK_STATUS = Object.freeze({
  swapped: ['draft'], auto_approved: ['approved', 'past'], submitted: ['pending'], repriced: ['draft'],
  cancelled: ['cancelled'], approved: ['approved', 'past'], denied: ['denied'], returned: ['draft'],
});

/**
 * Who reads what the viewer writes in Messages, by name, or null when nobody named does: the traveler for
 * anyone else; for the traveler, the approver while the request waits, then whoever decided it by hand. A
 * draft is in nobody's inbox, and a trip approved by policy has no approver.
 */
function messageTo(r, view) {
  if (!view.self) return r.travelerName || null;
  const ap = r.approval || {};
  if (view.status === 'pending') return view.approver ? view.approver.name : null;
  if (['approved', 'past', 'denied'].includes(view.status) && ap.mode === 'manual' && ap.decidedBy && ap.decidedBy.userId && ap.decidedBy.name) return ap.decidedBy.name;
  return null;
}

/** The fixed text of each ?ok= code. */
function okText(code, r, view) {
  if (OK_STATUS[code] && view.status && !OK_STATUS[code].includes(view.status)) return null;
  const first = firstName(r.travelerName);
  const ret = r.returned || {};
  const approverName = view.approver ? view.approver.name : 'your approver';
  switch (code) {
    case 'swapped': return 'Switched to the cheaper option. Here is your updated trip.';
    case 'auto_approved': return "Inside your policy, so it's approved. Nothing else is needed from you.";
    case 'submitted': return `Sent for approval. We don't send emails yet, so ${approverName} will see it under Approvals.`;
    case 'repriced': return 'This trip changed before it was sent. Review it and send it again.';
    case 'cancelled': return view.self || !r.travelerName ? 'Trip cancelled.' : `Trip cancelled. ${first} sees it on this trip.`;
    case 'approved': return `Approval saved. ${first} sees it on this trip.`;
    case 'denied': return `Decision saved. ${first} sees your note on this trip.`;
    case 'returned':
      if (ret.why === 'unavailable') return `An option is ${goneWords(f.requestSource(r))}, so this went back to ${first}. Nothing was approved.`;
      if (ret.why === 'price_changed' && ret.toCents !== ret.fromCents) return `The price changed, so this went back to ${first} to confirm. Nothing was approved.`;
      return `The fare or room terms changed, so this went back to ${first} to confirm. Nothing was approved.`;
    case 'message': {
      const to = messageTo(r, view);
      return to ? `Message sent to ${to}.` : 'Message sent. It shows on this trip.';
    }
    default: return null;
  }
}

/**
 * The ?ok= notice. A trip that changed (repriced, returned) is a warning, never a success, and is left out
 * when the banner under it already says so.
 */
function okNotice(code, r, view, { banner }) {
  const changed = code === 'repriced' || code === 'returned';
  if (changed && banner) return '';
  const text = okText(code, r, view);
  if (!text) return '';
  return changed ? html`<div class="alert alert-warning bz-alert" role="status">${icon('alert')}<span>${text}</span></div>` : p.notice(text);
}

/** A form that only POSTs the request's rev (cancel, confirm). */
function revForm(action, rev, button, { cls = 'btn btn-ghost bz-btn', bar = false } = {}) {
  const b = html`<button class="${cls}" type="submit">${button}</button>`;
  return html`<form method="post" action="${action}"><input type="hidden" name="rev" value="${String(rev)}">${bar ? p.actionBar(b) : b}</form>`;
}

/**
 * The banner of a draft that a price check sent back (or changed before it was sent). `pick` is true when
 * the page offers other options to pick (alternatives the traveler can use): only then does it say so.
 */
function returnedBanner(r, { self, timeZone, pick = false, source = 'demo' }) {
  const ret = r.returned;
  const gone = goneWords(source);
  const last = (r.history || [])[r.history.length - 1];
  if (!ret || !last || (last.action !== 'returned' && last.action !== 'repriced')) return '';
  const waiting = last.action === 'returned';
  const first = firstName(r.travelerName);
  const priced = ret.why === 'price_changed' && Number.isSafeInteger(ret.toCents) && ret.toCents !== ret.fromCents;
  // The submit that found the trip changed leads with the settled sentence (Stage 1 lead decisions), then
  // says what changed. A trip with an option gone cannot be sent as it is, so it is not asked to be.
  const LEAD = 'This trip changed before it was sent.';
  const next = pick ? 'Pick another option below, or plan the trip again.' : 'Plan the trip again to choose new options.';
  let text;
  if (ret.why === 'unavailable') {
    text = waiting
      ? (self ? `An option in this trip is ${gone}, so it came back to you. Nothing was approved. ${next}` : `An option in this trip is ${gone}, so it went back to ${first}. Nothing was approved.`)
      : `${LEAD} An option in it is ${gone}. ${next}`;
  } else if (priced) {
    text = waiting
      ? (self ? 'The price changed while this was waiting, so it came back to you. Nothing was approved. Review the new total and request approval again.' : `The price changed while this was waiting, so it went back to ${first}. Nothing was approved.`)
      : `${LEAD} Review it and send it again. The price changed.`;
  } else {
    text = waiting
      ? (self ? 'The fare or room terms changed while this was waiting, so it came back to you. The price is the same. Nothing was approved. Review the trip and request approval again.' : `The fare or room terms changed while this was waiting, so it went back to ${first}. The price is the same. Nothing was approved.`)
      : `${LEAD} Review it and send it again. The fare or room terms changed. The price is the same.`;
  }
  const body = html`<div class="alert alert-warning bz-alert bz-returned" role="note">${icon('alert')}<div><p>${text}</p>${priced ? html`<p class="bz-returned-price">Was ${p.amount(ret.fromCents)}, now ${p.amount(ret.toCents)}.</p>` : ''}</div></div>`;
  return priced ? p.demoBox(body, { pricedAt: r.pricedAt, timeZone, cls: 'bz-returned-box', source, kind: labelKind(r, source) }) : body;
}

const PART_LABELS = Object.freeze({ out: 'Outbound flight', back: 'Return flight', hotel: 'Hotel' });

/**
 * Violations with the trip part named where two parts break the same rule in the same words (Business
 * class on both flights), so the list never shows one sentence twice.
 */
function namedViolations(violations) {
  const list = Array.isArray(violations) ? violations : [];
  const seen = new Map();
  for (const v of list) seen.set(v.text, (seen.get(v.text) || 0) + 1);
  return list.map(v => (seen.get(v.text) > 1 && PART_LABELS[v.component] ? { ...v, text: `${PART_LABELS[v.component]}: ${v.text}` } : v));
}

/**
 * The stored reasons speak to the traveler ("above your limit", "Your policy allows"). Anyone else reads
 * them about the traveler: "above Sam's limit", "Sam's policy allows".
 */
function forViewer(violations, view, first) {
  const list = Array.isArray(violations) ? violations : [];
  if (view.self || !first) return list;
  const who = `${first}'s`;
  return list.map(v => ({ ...v, text: String(v.text).replace(/\byour\b/g, who).replace(/\bYour\b/g, who) }));
}

/** Is every reason that blocks this trip an option gone from the demo data (not the company's policy)? */
function goneOnly(ev) {
  const blocking = (ev.violations || []).filter(v => v.severity === 'block');
  return ev.status === 'blocked' && blocking.length > 0 && blocking.every(v => v.rule === 'inventory.unavailable');
}

/** An option gone from the demo data (or the supplier's), said as which part it is. */
const goneText = (v, source = 'demo') => (v.rule === 'inventory.unavailable' && PART_LABELS[v.component] ? { ...v, text: `${PART_LABELS[v.component]}: ${goneWords(source)}.` } : v);

/**
 * The verdict of the traveler's own draft inside the policy, by the request's source: on live prices booking is
 * not open, so confirming approves it, never "approved to book".
 */
const WITHIN_DRAFT = Object.freeze({
  demo: "Every part of this trip is inside your policy. Confirm and it's approved to book.",
  sandbox: "Every part of this trip is inside your policy. Confirm and it's approved to book.",
  live: "Every part of this trip is inside your policy. Confirm and it's approved.",
});

/** The policy verdict and its reasons. `again` is the "Plan this trip again" link, for a draft that has no way forward here. */
function policyBlock(r, view, { org, timeZone, pick = false, again = '', source = 'demo', off = false }) {
  const ev = r.evaluation || { status: 'within', violations: [] };
  const n = (ev.violations || []).length;
  const first = firstName(r.travelerName);
  const kind = labelKind(r, source);
  const reasons = p.violationList(namedViolations(forViewer(ev.violations, view, first).map(v => goneText(v, source))), { pricedAt: r.pricedAt, timeZone, source, kind });
  const changed = view.policyChanged ? html`<p class="bz-note">${icon('info')}<span>Policy updated since this request (v${String(view.policyChanged.from)} → v${String(view.policyChanged.to)}). It was checked against v${String(view.policyChanged.from)}.</span></p>` : '';
  if (goneOnly(ev)) {
    // Availability, not policy: no "Blocked by policy" badge, and the way forward that really exists.
    const text = `An option in this trip is ${goneWords(source)}, so the trip can't be sent as it is.`;
    return html`<section class="bz-policy-check" aria-label="Policy check">
      <div class="bz-verdict bz-verdict-blocked">${icon('alert')}<p class="bz-verdict-text">${text}</p></div>
      ${reasons}
      ${again}
      ${changed}
    </section>`;
  }
  let text;
  if (ev.status === 'within' && view.status === 'draft' && view.self && off) text = 'Every part of this trip is inside your policy.';
  else if (ev.status === 'within') text = view.status === 'draft' && view.self ? (WITHIN_DRAFT[source] || WITHIN_DRAFT.demo) : 'Every part of this trip is inside the policy.';
  else if (ev.status === 'out') text = `Out of policy: ${f.plural(n, 'reason')}`;
  else if (view.status === 'draft' && !view.self) text = `This trip can't be requested under ${org.name}'s policy.`;
  else if (view.status === 'draft') text = pick ? `This trip can't be requested under ${org.name}'s policy. Pick one of the options below.` : `This trip can't be requested under ${org.name}'s policy. Plan it again with options marked Within Policy.`;
  else text = 'Blocked by policy.';
  return html`<section class="bz-policy-check" aria-label="Policy check">
    ${p.verdict(ev.status, text, { source, kind })}
    ${reasons}
    ${ev.status === 'blocked' ? again : ''}
    ${changed}
  </section>`;
}

/** The status banner of a request that is not a draft. */
/** The approved banner's lead, by the request's source. */
const APPROVED = Object.freeze({
  demo: html`<b>Approved to book.</b> Booking opens once Tripelyx connects airlines and hotels. Nothing has been booked or charged.`,
  sandbox: html`<b>Approved (test data).</b> Nothing was booked.`,
  live: html`<b>Approved.</b> Booking in Tripelyx isn't open yet, so this fare is not held and can change.`,
});

function statusBanner(ctx, r, view, { member, base, timeZone, expiredSaid = false, source = 'demo' }) {
  const now = ctx.now();
  const first = firstName(r.travelerName);
  const ap = r.approval || {};
  const again = view.self ? html`<a class="btn btn-ghost bz-btn" href="${base}/trips/search?${searchQuery(r.query)}">${icon('arrow')}<span>Plan this trip again</span></a>` : '';
  switch (view.status) {
    case 'pending': {
      const since = r.submittedAt ? f.whenIn(timeZone, r.submittedAt, { now }) : null;
      const until = r.expiresAt ? f.whenIn(timeZone, r.expiresAt, { now, zone: true }) : null;
      const who = view.can.decide && !view.can.override ? null : view.approver ? view.approver.name : 'an approver';
      const lead = who
        ? `Waiting for ${who}${since ? ` since ${since}` : ''}.`
        : `${r.travelerName} asked for your approval${since ? ` at ${since}` : ''}.`;
      return html`<div class="bz-status bz-status-pending">${icon('clock')}<p>${lead}${until ? ` Expires at ${until}.` : ''}</p></div>`;
    }
    case 'approved':
    case 'past': {
      let by;
      if (ap.mode === 'auto') by = 'Approved by policy.';
      else if (ap.decidedAs === 'override' && ap.decidedBy) by = `Approved by ${ap.decidedBy.name} as ${LABELS[ap.decidedBy.role] || ap.decidedBy.role}${view.approver ? ` (assigned to ${view.approver.name})` : ''}.`;
      else by = ap.decidedBy && ap.decidedBy.name ? `Approved by ${ap.decidedBy.name}.` : 'Approved.';
      return html`<div class="bz-status bz-status-approved">${icon('check')}<div>
        <p>${APPROVED[source] || APPROVED.demo}</p>
        <p>${by}${view.status === 'past' ? ' This trip has started.' : ''}</p>
        ${ap.note ? html`<p class="bz-quote">Note from ${ap.decidedBy ? ap.decidedBy.name : 'the approver'}: “${ap.note}”</p>` : ''}
        ${ap.overBudgetAck ? html`<p>Approved even though it goes over the department's budget.</p>` : ''}
      </div></div>`;
    }
    case 'denied': {
      const name = ap.decidedBy ? ap.decidedBy.name : 'the approver';
      const as = ap.decidedAs === 'override' && ap.decidedBy ? ` as ${LABELS[ap.decidedBy.role] || ap.decidedBy.role}` : '';
      return html`<div class="bz-status bz-status-denied">${icon('alert')}<div>
        <p>${ap.note ? sentence(`Denied by ${name}${as}: ${ap.note}`) : `Denied by ${name}${as}.`}</p>
        ${view.self ? html`<p>Nothing was booked or charged. You can plan the trip again with other options.</p>` : ''}
        ${again}
      </div></div>`;
    }
    case 'cancelled': {
      const last = [...(r.history || [])].reverse().find(h => h.action === 'cancelled');
      const who = last ? actorName(last.by, { self: member.userId }) : null;
      const when = last ? f.dateTimeIn(timeZone, last.at) : null;
      return html`<div class="bz-status bz-status-cancelled">${icon('minus')}<div>
        <p>${who ? `${who} cancelled this trip at ${when}.` : 'This trip was cancelled.'} Nothing was booked or charged.</p>
        ${again}
      </div></div>`;
    }
    case 'expired': {
      // A refused decision already said when it expired, in the error above: the time is said once.
      const when = r.expiresAt && !expiredSaid ? f.dateTimeIn(timeZone, r.expiresAt) : null;
      return html`<div class="bz-status bz-status-expired">${icon('clock')}<div>
        <p>${when ? `Expired at ${when}.` : 'Expired.'} Nothing was approved.</p>
        ${view.self ? again : html`<p>${first} can plan it again.</p>`}
      </div></div>`;
    }
    default: return '';
  }
}

/**
 * The note under the trip total. Live prices: nothing is charged while booking is not open, so it says what the
 * total is, and a draft or waiting trip adds that the price is checked again before it is approved (the submit
 * and the decision both check it).
 */
function totalNote(view, source) {
  if (source !== 'live') return 'The total is everything charged for these options: each fee and tax is under Price details.';
  const note = 'The total is the whole price of these options, with every fee and tax: each one is under Price details.';
  return view.status === 'draft' || view.status === 'pending' ? `${note} It is checked again before it is approved.` : note;
}

/** The trip's parts and its total, with every price line one tap away. */
function tripParts(r, view, { timeZone, map, source = 'demo' }) {
  const evals = (r.evaluation && r.evaluation.components) || {};
  const basis = evals.hotel && evals.hotel.cap && evals.hotel.cap.basis ? evals.hotel.cap.basis : 'incl_taxes';
  const first = firstName(r.travelerName);
  const evalOf = c => (evals[c] ? { ...evals[c], violations: forViewer(evals[c].violations, view, first) } : { status: null, violations: [] });
  const cards = COMPONENTS.filter(c => r.rows && r.rows[c]).map(c => p.rowCard({ row: r.rows[c], evaluation: evalOf(c) }, { timeZone, level: 3, basis }));
  const label = c => {
    if (c === 'out') return `Outbound flight, ${routeText(map, r.query.from, r.query.to)}`;
    if (c === 'back') return `Return flight, ${routeText(map, r.query.to, r.query.from)}`;
    const h = r.rows.hotel;
    return `${h.name}, ${f.plural(h.nights || nightsBetween(h.checkIn, h.checkOut), 'night')}`;
  };
  const parts = COMPONENTS.filter(c => r.rows && r.rows[c]);
  const missing = parts.some(c => !r.rows[c].available || !Number.isSafeInteger(r.rows[c].totalCents));
  // What switching saved is the swaps' own savings (as reports.savedBySwitching counts it): a supplier's
  // later price move, either way, is not something the traveler saved.
  const saved = (r.history || [])
    .filter(h => h.action === 'swapped' && Number.isSafeInteger(h.savedCents) && h.savedCents > 0)
    .reduce((n, h) => n + h.savedCents, 0);
  const lines = html`<dl class="bz-lines">
    ${parts.map(c => {
    const row = r.rows[c];
    const ok = row.available && Number.isSafeInteger(row.totalCents);
    return html`<div class="bz-line"><dt>${label(c)}</dt><dd>${ok ? p.amount(row.totalCents) : html`<span class="bz-unavailable">${p.unavailableText(row)}</span>`}</dd></div>`;
  })}
    <div class="bz-line bz-line-total"><dt>${missing ? 'Total without the missing option' : 'Trip total'}</dt><dd>${p.amount(r.totalCents)}</dd></div>
  </dl>
  ${saved > 0 ? html`<p class="bz-saved">${icon('check')}<span>Saved ${p.amount(saved)} by switching to cheaper options.</span></p>` : ''}
  <p class="bz-total-note">${totalNote(view, source)}</p>`;
  return html`<section class="bz-trip-parts" aria-labelledby="bz-parts-title">
    <h2 id="bz-parts-title">The trip</h2>
    ${cards}
    ${p.demoBox(html`<h3 class="bz-total-title">Trip total</h3>${lines}`, { pricedAt: r.pricedAt, timeZone, tag: 'section', cls: 'bz-card bz-total', label: 'Trip total', source, kind: labelKind(r, source) })}
  </section>`;
}

/** The department's budget for this trip, in the words the page's status calls for. */
function budgetBlock(r, view, { org, departmentName, timeZone, deciding, level = 2, source = 'demo' }) {
  // The service reads the budget for a draft, a pending request and an approved one only: a denied,
  // cancelled or expired request holds nothing, so the page says nothing about the budget.
  if (!['draft', 'pending', 'approved', 'past'].includes(view.status)) return '';
  const b = view.budget;
  const dept = (b && b.departmentName) || departmentName;
  let label = b ? b.periodLabel : null;
  if (!label) {
    try { label = periodLabel(periodKey(r.query.departDate, (org.settings && org.settings.budgetPeriod) || 'quarter')); } catch { label = null; }
  }
  let body;
  if (!r.departmentId || !dept) body = html`<p>No department is set for this trip, so no budget applies.</p>`;
  else if (!b && (view.status === 'approved' || view.status === 'past')) body = html`<p>Nothing is held against a budget for this trip: ${dept} had no budget${label ? ` for ${label}` : ''} when it was approved.</p>`;
  else if (!b) body = html`<p>No budget set for ${dept}${label ? ` in ${label}` : ''}.</p>`;
  else if (view.status === 'approved' || view.status === 'past') {
    const own = r.budget && Number.isSafeInteger(r.budget.cents) ? r.budget.cents : 0;
    body = html`<p>This trip holds ${p.amount(own)} of ${dept}'s ${b.periodLabel} budget. In all, ${p.amount(b.committedCents + own)} of ${p.amount(b.amountCents)} is committed.</p>`;
  } else if (deciding) {
    if (b.remainingCents <= 0) {
      body = html`<p>${dept} has no budget left for ${b.periodLabel}${b.remainingCents < 0 ? html` (already ${p.amount(-b.remainingCents)} over)` : ''}. This trip adds ${p.amount(r.totalCents)}.</p>`;
    } else if (r.totalCents > b.remainingCents) {
      body = html`<p>${dept} has ${p.amount(b.remainingCents)} left for ${b.periodLabel}. This trip needs ${p.amount(r.totalCents)}, so approving it goes ${p.amount(r.totalCents - b.remainingCents)} over.</p>`;
    } else {
      body = html`<p>Uses ${p.amount(r.totalCents)} of ${p.amount(b.remainingCents)} left in ${dept} for ${b.periodLabel}.</p>`;
    }
  } else if (view.status === 'draft' || view.status === 'pending') {
    body = html`<p>${dept} · ${b.periodLabel}: ${p.amount(b.committedCents)} of ${p.amount(b.amountCents)} committed. This trip adds ${p.amount(r.totalCents)}${view.status === 'pending' ? ' once approved' : ''}.</p>`;
  } else {
    return '';
  }
  const money = b && r.departmentId && dept;
  const box = html`${p.heading(level, html` class="bz-block-title"`, html`${icon('wallet')}<span>Budget</span>`)}${body}`;
  return money
    ? p.demoBox(box, { pricedAt: r.pricedAt, timeZone, tag: 'section', cls: 'bz-card bz-budget', label: 'Budget', source, kind: labelKind(r, source) })
    : html`<section class="bz-card bz-budget" aria-label="Budget">${box}</section>`;
}

/** How much the trip would take the department over its budget (0 when it fits or has none). */
function overBy(r, view) {
  const b = view.budget;
  if (!b || !Number.isSafeInteger(b.remainingCents)) return 0;
  return r.totalCents > b.remainingCents ? r.totalCents - b.remainingCents : 0;
}

/** The approver's panel: price check, comparison, reason, decision form. */
function deciderPanel(ctx, r, view, { base, timeZone, form, failed, refusal, error, role, budget, source = 'demo', off = false }) {
  const now = ctx.now();
  const first = firstName(r.travelerName);
  const live = view.live;
  // Approve on a trip that changed sends it back instead: the button says so.
  const sendsBack = !!live && live.status !== 'same';
  let check;
  if (off) {
    // Live search is off: nothing can be checked, so there is no Approve until it is on again.
    check = html`<p>${icon('info')}<span>${PRICE_CHECK_COPY.searchOffDecide}</span></p>`;
  } else if (!live && view.liveError) {
    // A supplier's price check could not run on a page view (the approver's page always opens): it runs when
    // they approve.
    // A company Tripelyx hasn't confirmed (live prices, go-live design §5.5) checks nothing until it is.
    const words = view.liveError === 'live_check_skipped' ? PRICE_CHECK_COPY.skipped : view.liveError === 'company_not_confirmed' ? SEARCH_CLOSED : PRICE_CHECK_COPY.failed;
    check = html`<p>${icon('info')}<span>${words}</span></p>`;
  } else if (!live) {
    check = html`<p>${icon('info')}<span>We couldn't check the price again just now. Approving checks it once more.</span></p>`;
  } else {
    const at = f.whenIn(timeZone, live.at, { now });
    if (live.status === 'same') check = html`<p>${icon('check')}<span>Price checked again at ${at}: unchanged.</span></p>`;
    else if (live.status === 'unavailable') check = html`<p>${icon('alert')}<span>Price checked again at ${at}: an option is ${goneWords(source)}. Approving sends it back to ${first}, and nothing is approved.</span></p>`;
    else if (Number.isSafeInteger(live.newTotalCents) && live.newTotalCents !== r.totalCents) check = html`<p>${icon('alert')}<span>Price checked again at ${at}: now ${p.amount(live.newTotalCents)} (was ${p.amount(r.totalCents)}). If you approve, it goes back to ${first} to confirm the new price.</span></p>`;
    else check = html`<p>${icon('alert')}<span>Price checked again at ${at}: the fare or room terms changed. The price is the same. If you approve, it goes back to ${first} to confirm.</span></p>`;
  }
  const kind = labelKind(r, source);
  const checkBox = p.demoBox(html`<div class="bz-live">${check}</div>`, { pricedAt: live ? live.at : r.pricedAt, timeZone, cls: 'bz-live-box', source, kind });

  let compare;
  if (view.comparison) {
    const c = view.comparison;
    // Both trips' amounts: the least real of the request's source and the cheaper trip's rows, and on live
    // prices whoever priced either trip.
    const both = f.leastReal([source, r.cheapestWithin ? p.tripSource(r.cheapestWithin.rows) : source]);
    const rows = c.rows.map(x => [x.label, x.a === null || x.a === undefined ? 'None' : x.a, x.b === null || x.b === undefined ? 'None' : x.b]);
    rows.push(['Trip total', p.amount(c.totalCents.a), p.amount(c.totalCents.b)]);
    compare = p.demoBox(html`<h3 class="bz-block-title">Requested vs cheapest option inside policy</h3>
      ${p.dataTable({ caption: 'Requested vs cheapest option inside policy', columns: [{ label: 'Detail' }, { label: 'Requested' }, { label: 'Cheapest inside policy' }], rows })}
      ${c.totalCents.delta < 0 ? html`<p class="bz-compare-delta">The option inside the policy costs ${p.amount(-c.totalCents.delta)} less.</p>` : ''}`, {
      pricedAt: r.cheapestWithin && r.cheapestWithin.rows && r.cheapestWithin.rows.out ? r.cheapestWithin.rows.out.pricedAt : r.pricedAt, timeZone, tag: 'section', cls: 'bz-compare', label: 'Requested vs cheapest option inside policy',
      source: both,
      kind: f.liveKind(both, [...f.tripRows(r.rows), ...f.tripRows(r.cheapestWithin && r.cheapestWithin.rows)]),
    });
  } else {
    // A search in a cabin above the limit fetched no fare in the allowed cabin, so there was nothing to
    // compare with: say that, rather than that nothing inside the policy exists.
    const cabin = ((r.evaluation && r.evaluation.violations) || []).find(v => v.rule === 'flight.cabin' && CABIN_LABELS[v.limit]);
    const searched = r.query && CABIN_LABELS[r.query.cabin];
    const none = cabin && searched && r.query.cabin !== cabin.limit
      ? `${first} searched ${searched} class, so there is no ${CABIN_LABELS[cabin.limit]} fare to compare.`
      : `No option inside the policy turned up when ${first} searched.`;
    compare = html`<section class="bz-compare" aria-label="Cheapest option inside policy"><h3 class="bz-block-title">Requested vs cheapest option inside policy</h3><p>${none}</p></section>`;
  }

  const reason = r.reason && r.reason.text
    ? html`<section class="bz-reason-block" aria-label="Reason"><h3 class="bz-block-title">${first}'s reason</h3><blockquote class="bz-quote">“${r.reason.text}”</blockquote>${r.reason.category ? html`<p class="bz-muted">Category: ${REASON_CATEGORY_LABELS[r.reason.category] || r.reason.category}</p>` : ''}</section>`
    : '';

  const over = overBy(r, view);
  const b = view.budget;
  const showAck = over > 0 || refusal === 'over_budget';
  const mine = failed === 'decide';
  const noteError = mine && (refusal === 'note_required' || refusal === 'card_number' || refusal === 'self_approval') ? error : null;
  const ackError = mine && refusal === 'over_budget' ? error : null;
  // The box's label is one sentence; the one demo note sits under it, in the same demo container.
  const ackInput = html`<input id="d-ack" type="checkbox" name="ackOverBudget" value="1"${mine && form.ack ? html` checked` : ''}${ackError ? html` aria-invalid="true" aria-describedby="d-ack-err"` : ''}>`;
  const ackErr = ackError ? html`<p class="field-error" id="d-ack-err">${ackError}</p>` : '';
  let ack = '';
  // With live search off there is no Approve, so nothing to acknowledge.
  if (off) ack = '';
  else if (showAck && over > 0 && b) {
    ack = html`<div class="bz-ack">${p.demoBox(html`<div class="bz-choices${ackError ? ' is-invalid' : ''}"><label class="bz-choice" for="d-ack">${ackInput}<span>Approve even though ${b.departmentName} goes ${p.amount(over)} over its ${b.periodLabel} budget.</span></label>${ackErr}</div>`, { pricedAt: r.pricedAt, timeZone, cls: 'bz-ack-box', source, kind })}</div>`;
  } else if (showAck) {
    ack = html`<div class="bz-choices${ackError ? ' is-invalid' : ''}"><label class="bz-choice" for="d-ack">${ackInput}<span>Approve even though it goes over the department's budget.</span></label>${ackErr}</div>`;
  }
  const assigned = view.approver ? view.approver.name : null;
  const action = `${base}/trips/${r.id}/decide`;
  const hint = view.can.override ? `Needed: at least ${NOTE_MIN_CHARS} characters. ${first} sees this note.` : `Needed to deny: tell ${first} why, in at least ${NOTE_MIN_CHARS} characters. ${first} sees this note.`;
  return html`<section class="bz-card bz-decide" id="decide" aria-labelledby="bz-decide-title">
    <h2 id="bz-decide-title">Your decision</h2>
    ${view.can.override ? html`<p class="bz-note">${icon('shield')}<span>You're deciding as ${LABELS[role] || 'an admin'}${assigned ? ` for ${assigned}, the assigned approver` : ''}. Add a note of at least ${String(NOTE_MIN_CHARS)} characters.</span></p>` : ''}
    ${checkBox}
    ${compare}
    ${reason}
    ${budget}
    <form class="bz-form bz-decide-form" method="post" action="${action}">
      <input type="hidden" name="rev" value="${String(r.rev)}">
      <div class="field">
        <label for="d-note">Note to ${first}</label>
        <textarea id="d-note" name="note" maxlength="500" data-count="d-note-count" aria-describedby="d-note-hint d-note-count${noteError ? ' d-note-err' : ''}"${noteError ? html` aria-invalid="true"` : ''}>${mine ? form.note || '' : ''}</textarea>
        <p class="field-hint" id="d-note-hint">${hint}</p>
        ${p.charCount('d-note-count', { max: 500 })}
        ${noteError ? html`<p class="field-error" id="d-note-err">${noteError}</p>` : ''}
        ${view.can.message ? html`<p class="bz-ask-line"><a class="bz-ask" href="#message">${icon('mail')}<span>Ask ${first} a question</span></a></p>` : ''}
      </div>
      ${ack}
      ${p.actionBar(html`${off ? '' : html`<button class="btn btn-navy bz-btn" type="submit" name="action" value="approve">${sendsBack ? html`${icon('arrow')}<span>Send back to ${first}</span>` : html`${icon('check')}<span>Approve</span>`}</button>
        `}<button class="btn btn-ghost bz-btn" type="submit" name="action" value="deny">${icon('close')}<span>Deny</span></button>`)}
    </form>
  </section>`;
}

/** The traveler's primary action on a draft: Confirm trip, Request Approval, or what to do instead. */
function submitPanel(r, view, { org, member, base, form, failed, refusal, error, soon = false, source = 'demo', off = false }) {
  const ev = r.evaluation || { status: 'within' };
  const action = `${base}/trips/${r.id}/submit`;
  const hours = org.settings && Number.isInteger(org.settings.approvalHours) ? org.settings.approvalHours : 24;
  if (ev.status === 'out' && soon) {
    // Leaving today: a request would expire before anyone could decide it, so there is no form to fill in.
    return html`<section class="bz-card bz-submit" aria-labelledby="bz-submit-title">
      <h2 id="bz-submit-title">Request Approval</h2>
      <p>This trip leaves today, too soon to wait for an approval. Choose an option inside your policy, or plan the trip again with a later date.</p>
      <p><a class="btn btn-ghost bz-btn" href="${base}/trips/new?${searchQuery(r.query)}">${icon('arrow')}<span>Plan it again with new dates</span></a></p>
    </section>`;
  }
  if (ev.status === 'within' && off) {
    return html`<section class="bz-card bz-submit" aria-labelledby="bz-submit-title">
      <h2 id="bz-submit-title">Confirm your trip</h2>
      <p>${PRICE_CHECK_COPY.searchOffConfirm}</p>
    </section>`;
  }
  if (ev.status === 'within') {
    return html`<section class="bz-card bz-submit" aria-labelledby="bz-submit-title">
      <h2 id="bz-submit-title">Confirm your trip</h2>
      <p>${source === 'live' ? "This trip is inside your policy, so confirming approves it. Booking in Tripelyx isn't open yet, so nothing is booked or charged." : 'This trip is inside your policy, so confirming approves it to book. Nothing is booked or charged.'}</p>
      ${revForm(action, r.rev, html`${icon('check')}<span>Confirm trip</span>`, { cls: 'btn btn-navy bz-btn', bar: true })}
    </section>`;
  }
  if (ev.status !== 'out') return '';
  if (!view.approver) {
    const invite = roleCan(member.role, 'members.manage');
    return html`<section class="bz-card bz-submit" aria-labelledby="bz-submit-title">
      <h2 id="bz-submit-title">Request Approval</h2>
      <p>No one else at ${org.name} can approve this yet, and nobody approves their own trip. Invite a Manager or Travel Admin, or choose an option inside your policy.</p>
      ${invite ? p.actionBar(html`<a class="btn btn-navy bz-btn" href="${base}/people">${icon('users')}<span>Invite</span></a>`) : ''}
    </section>`;
  }
  if (off) {
    return html`<section class="bz-card bz-submit" aria-labelledby="bz-submit-title">
      <h2 id="bz-submit-title">Request Approval</h2>
      <p>${PRICE_CHECK_COPY.searchOffRequest}</p>
    </section>`;
  }
  const min = org.settings && Number.isInteger(org.settings.reasonMinChars) ? org.settings.reasonMinChars : REASON_MIN_CHARS;
  const mine = failed === 'submit';
  // A trip that came back keeps what the traveler wrote: the form starts from it.
  const kept = r.reason || {};
  const reasonValue = mine ? form.reason || '' : kept.text || '';
  const categoryValue = mine ? form.category : kept.category;
  const reasonError = mine && (refusal === 'reason_too_short' || refusal === 'card_number') ? error : null;
  const rule = { approver: 'your approver', manager: 'your manager', admin: org.name ? `${org.name}'s admins` : 'your admins' }[view.approver.rule] || 'your approver';
  return html`<section class="bz-card bz-submit" aria-labelledby="bz-submit-title">
    <h2 id="bz-submit-title">Request Approval</h2>
    <p class="bz-goes">${icon('user')}<span>Goes to ${view.approver.name} (${rule}).</span></p>
    <form class="bz-form" method="post" action="${action}">
      <input type="hidden" name="rev" value="${String(r.rev)}">
      <div class="field">
        <label for="s-reason">Why does this trip need an exception?</label>
        <textarea id="s-reason" name="reason" required minlength="${String(min)}" maxlength="${String(REASON_MAX_CHARS)}" data-count="s-reason-count" aria-describedby="s-reason-count${reasonError ? ' s-reason-err' : ''}"${reasonError ? html` aria-invalid="true"` : ''}>${reasonValue}</textarea>
        ${p.charCount('s-reason-count', { min, max: REASON_MAX_CHARS })}
        ${reasonError ? html`<p class="field-error" id="s-reason-err">${reasonError}</p>` : ''}
      </div>
      <div class="field">
        <label for="s-category">Category</label>
        <select id="s-category" name="category">
          <option value="">Choose one (optional)</option>
          ${REASON_CATEGORIES.map(c => html`<option value="${c}"${categoryValue === c ? html` selected` : ''}>${REASON_CATEGORY_LABELS[c]}</option>`)}
        </select>
      </div>
      <p class="bz-muted">If no one decides within ${f.plural(hours, 'hour')}, the request expires and nothing is approved. We don't send emails yet: ${firstName(view.approver.name)} sees it under Approvals.</p>
      ${p.actionBar(html`<button class="btn btn-navy bz-btn" type="submit">${icon('arrow')}<span>Request Approval</span></button>`)}
    </form>
  </section>`;
}

/**
 * Cancel, as the status and the viewer allow. An approved trip takes two steps: a link to ?confirm=cancel,
 * where the page says what is lost and the button is marked as destructive.
 */
function cancelPanel(r, view, { base, confirm = '', dest = '' }) {
  if (!view.can.cancel) return '';
  const action = `${base}/trips/${r.id}/cancel`;
  if (view.status === 'draft') return html`<div class="bz-cancel">${revForm(action, r.rev, 'Cancel this trip')}</div>`;
  if (view.status === 'pending') return html`<div class="bz-cancel">${revForm(action, r.rev, 'Cancel request')}<p class="bz-muted">Cancelling withdraws it from your approver. Nothing was booked or charged.</p></div>`;
  const here = `${base}/trips/${r.id}`;
  if (confirm !== 'cancel') {
    return html`<div class="bz-cancel" id="cancel"><a class="btn btn-ghost bz-btn" href="${here}?confirm=cancel#cancel">${view.self ? 'Cancel this trip' : 'Cancel this approved trip'}</a></div>`;
  }
  const ap = r.approval || {};
  const where = dest ? ` to ${dest}` : '';
  let text;
  if (!view.self) text = `Cancel ${r.travelerName}'s approved trip${where}? Its approval ends, and ${firstName(r.travelerName)} would need to request it again. What it holds of the department's budget is released. Nothing was booked or charged.`;
  else if (ap.mode === 'manual' && ap.decidedBy && ap.decidedBy.name) text = `Cancel your approved trip${where}? ${ap.decidedBy.name}'s approval is lost, and you'd need to request it again. Nothing was booked or charged.`;
  else text = `Cancel your approved trip${where}? Its approval ends, and you'd need to plan and confirm it again. Nothing was booked or charged.`;
  return html`<section class="bz-card bz-cancel-confirm" id="cancel" aria-labelledby="bz-cancel-title">
    <h2 id="bz-cancel-title">Cancel this trip?</h2>
    <p>${text}</p>
    <div class="bz-cancel-actions">${revForm(action, r.rev, 'Yes, cancel this trip', { cls: 'btn bz-btn bz-btn-danger' })}<a class="btn btn-ghost bz-btn" href="${here}">Keep this trip</a></div>
  </section>`;
}

/** Messages and the form to write one. */
function messagesPanel(ctx, r, view, { base, timeZone, form, failed, refusal, error, member, canRequest = false }) {
  const list = r.messages || [];
  // The form shows only when a named person reads the thread (messageTo): never "your approver" on a draft
  // that is in nobody's inbox, or on a trip approved by policy, which has no approver.
  const to = view.can.message ? messageTo(r, view) : null;
  if (!list.length && !to) {
    return view.self && view.status === 'draft' && canRequest
      ? html`<section class="bz-messages" id="message" aria-labelledby="bz-msg-title"><h2 id="bz-msg-title">Messages</h2><p class="bz-muted">Messages open once you send this for approval.</p></section>`
      : '';
  }
  const now = ctx.now();
  const mine = failed === 'message';
  const textError = mine && (refusal === 'invalid_message' || refusal === 'card_number' || refusal === 'too_many_messages') ? error : null;
  const first = firstName(r.travelerName);
  let label, reads;
  if (view.self) {
    label = `Write to ${to}`;
    reads = view.status === 'pending' ? `We don't send emails yet. ${to} sees it on this trip under Approvals.` : `We don't send emails yet. ${to} sees it on this trip.`;
  } else {
    label = view.can.decide ? `Ask ${first} a question` : `Write to ${first}`;
    reads = `We don't send emails yet. ${first} sees it on this trip.`;
  }
  return html`<section class="bz-messages" id="message" aria-labelledby="bz-msg-title">
    <h2 id="bz-msg-title">Messages</h2>
    ${list.length ? html`<ol class="bz-thread">${list.map(m => html`<li class="bz-msg"><p class="bz-msg-head"><b>${m.by === member.userId ? 'You' : m.name}</b><span>${f.whenIn(timeZone, m.at, { now })}</span></p><p>${m.text}</p></li>`)}</ol>` : html`<p class="bz-muted">No messages yet.</p>`}
    ${to ? html`<form class="bz-form" method="post" action="${base}/trips/${r.id}/message">
      <div class="field">
        <label for="m-text">${label}</label>
        <textarea id="m-text" name="text" required minlength="${String(MESSAGE_CHARS[0])}" maxlength="${String(MESSAGE_CHARS[1])}" data-count="m-text-count" aria-describedby="m-text-count${textError ? ' m-text-err' : ''}"${textError ? html` aria-invalid="true"` : ''}>${mine ? form.text || '' : ''}</textarea>
        ${p.charCount('m-text-count', { min: MESSAGE_CHARS[0], max: MESSAGE_CHARS[1] })}
        ${textError ? html`<p class="field-error" id="m-text-err">${textError}</p>` : ''}
      </div>
      <p class="bz-muted">${reads}</p>
      <div><button class="btn btn-ghost bz-btn" type="submit">${icon('mail')}<span>Send message</span></button></div>
    </form>` : ''}
  </section>`;
}

/** The request's history, oldest first. */
function historyPanel(ctx, r, { timeZone, member, source = 'demo' }) {
  const list = r.history || [];
  if (!list.length) return '';
  const now = ctx.now();
  // The trip went back to its traveler: "you" on the traveler's own page, their first name for anyone else.
  const back = r.travelerId === member.userId ? 'you' : firstName(r.travelerName);
  const line = h => {
    const who = actorName(h.by, { self: member.userId });
    switch (h.action) {
      case 'drafted': return `${who} planned this trip.`;
      case 'swapped': return html`${who} switched to a cheaper option${h.note ? `: ${h.note}` : ''}.${Number.isSafeInteger(h.savedCents) && h.savedCents > 0 ? html` Saved ${p.demoPrice(h.savedCents, { pricedAt: h.at, timeZone, source, kind: labelKind(r, source) })}` : ''}`;
      case 'repriced': return 'The trip changed before it was sent, so it was updated.';
      case 'submitted': return `${who} asked for approval.`;
      case 'auto_approved': return 'Approved by policy.';
      case 'approved': return `${who} approved it.`;
      case 'denied': return `${who} denied it.`;
      case 'returned': return `It went back to ${back} to confirm: the trip changed while it was waiting.`;
      case 'cancelled': return `${who} cancelled it.`;
      case 'expired': return 'It expired with no decision.';
      default: return `${who}: ${h.action}`;
    }
  };
  return html`<section class="bz-history" aria-labelledby="bz-history-title">
    <h2 id="bz-history-title">History</h2>
    <ol class="bz-timeline">${list.map(h => html`<li><span class="bz-timeline-when">${f.whenIn(timeZone, h.at, { now, zone: true })}</span>${line(h)}</li>`)}</ol>
  </section>`;
}

const LEG_NAMES = Object.freeze({ out: 'Outbound flight', back: 'Return flight' });

/**
 * Alternatives whose titles would repeat get what tells them apart (the heading list never shows one title
 * twice): the leg for a flight change ("Return flight: One stop via Istanbul"), the hotel or room for a stay
 * ("Another hotel in London: Kestrel Yard Hotel"), then the departure time for two flights on one leg. The
 * pinned "Cheapest option inside your policy" is unique already and is never renamed.
 */
function distinctTitles(list) {
  const counts = l => l.reduce((m, a) => m.set(a.label, (m.get(a.label) || 0) + 1), new Map());
  const pass = (l, rename) => {
    const seen = counts(l);
    return l.map(a => (seen.get(a.label) > 1 && a.label !== p.CHEAPEST_WITHIN_LABEL ? { ...a, label: rename(a) || a.label } : a));
  };
  const partOf = a => (a.change && a.change.component) || null;
  let out = pass(list, a => {
    const c = partOf(a);
    const row = c && a.rows ? a.rows[c] : null;
    if (LEG_NAMES[c]) return `${LEG_NAMES[c]}: ${a.label}`;
    if (c === 'hotel' && row && a.kind === 'room' && row.room && row.room.name) return `${a.label}: ${row.room.name}`;
    if (c === 'hotel' && row && row.name) return `${a.label}: ${row.name}`;
    return null;
  });
  out = pass(out, a => {
    const c = partOf(a);
    const row = c && a.rows ? a.rows[c] : null;
    const seg = row && Array.isArray(row.segments) && row.segments[0];
    const at = seg ? f.clock24(seg.departLocal) : '';
    return at ? `${a.label}, leaves ${at}` : null;
  });
  // Anything still the same (two identical changes) is numbered, in the order shown.
  const seen = counts(out);
  const n = new Map();
  return out.map(a => {
    if (seen.get(a.label) < 2 || a.label === p.CHEAPEST_WITHIN_LABEL) return a;
    n.set(a.label, (n.get(a.label) || 0) + 1);
    return { ...a, label: `${a.label} (option ${n.get(a.label)})` };
  });
}

/**
 * The explainer's summary, without a sentence that offers to request approval when this draft cannot be
 * requested (nobody to approve it, a blocked trip, a date that has passed).
 */
function summaryFor(summary, { canRequest, hasAlternatives }) {
  const text = String(summary || '');
  if (canRequest) return text;
  const kept = (text.match(/[^.!?]+[.!?]+/g) || []).map(x => x.trim()).filter(x => !/request(ing)? approval/i.test(x)).join(' ');
  return kept || (hasAlternatives ? '' : 'No cheaper option inside your policy turned up in this search.');
}

/** "Plan this trip again": the same search, to choose new options. */
const againLink = (base, r) => html`<p class="bz-again"><a class="btn btn-ghost bz-btn" href="${base}/trips/search?${searchQuery(r.query)}">${icon('arrow')}<span>Plan this trip again</span></a></p>`;

/**
 * @param {object} ctx
 * @param {{ org: object, member: object, view: import('../../business/types').RequestView, departmentName: string|null,
 *   ok?: string, error?: string|null, failed?: string|null, form?: object, refusal?: string|null, base: string,
 *   confirm?: string }} m confirm 'cancel' shows the second step of cancelling an approved trip
 */
function requestView(ctx, { org, member, view, departmentName = null, ok = '', error = null, failed = null, form = {}, refusal = null, base, confirm = '' }) {
  const r = view.request;
  const timeZone = f.safeZone(view.timezone || org.timezone);
  const map = places(ctx);
  const dest = r.rows && r.rows.hotel ? r.rows.hotel.city : cityOf(map, r.query.to);
  const title = view.self ? (view.status === 'draft' ? 'Review your trip' : `Your trip to ${dest}`) : `${r.travelerName}'s trip to ${dest}`;
  const deciding = view.can.decide;
  const first = firstName(r.travelerName);
  const evStatus = r.evaluation ? r.evaluation.status : 'within';
  const draftSelf = view.status === 'draft' && view.self;
  // Where this request's prices came from (an old request with no source reads as demo).
  const source = f.requestSource(r);
  const off = searchOffFor(ctx, source);

  // A draft whose departure date has passed (in the company's time zone) can't be sent: the page says so and
  // links to plan it again, with no form that would only fail. Leaving today is fine inside policy, and too
  // soon to wait for an approval outside it.
  const today = tz.localDate(timeZone, ctx.now());
  const depart = r.query && r.query.departDate;
  const late = draftSelf && typeof depart === 'string' && depart < today;
  const soon = draftSelf && !late && depart === today && evStatus === 'out';
  const canRequest = evStatus === 'out' && !!view.approver && !late && !soon;

  // The alternatives this draft offers: none once the date has passed, and never one a swap just found gone.
  const goneId = refusal === 'alternative_gone' && form.altId ? form.altId : null;
  const altList = late ? [] : (r.alternatives || []).filter(a => a.id !== goneId);
  const showAlts = view.status === 'draft' && !late && (evStatus === 'out' || (evStatus === 'blocked' && altList.length));
  // A switch searches again: with live search off there is none to offer (the options still show, with no form).
  const swappable = !!view.can.swap && !off;
  const pick = swappable && altList.length > 0 && showAlts;

  // A field-level refusal shows at its field; the box at the top says what is wrong and links to it.
  const FIELD = {
    submit: { reason_too_short: 's-reason', card_number: 's-reason' },
    decide: { note_required: 'd-note', card_number: 'd-note', self_approval: 'd-note', over_budget: 'd-ack' },
    message: { invalid_message: 'm-text', card_number: 'm-text', too_many_messages: 'm-text' },
  };
  const field = error && failed && FIELD[failed] ? FIELD[failed][refusal] : null;
  let topError = error;
  if (field) topError = html`<a href="#${field}">${error}</a>`;
  const expiredSaid = refusal === 'request_expired' && failed === 'decide' && !!r.expiresAt;
  if (expiredSaid) topError = `This request expired at ${f.dateTimeIn(timeZone, r.expiresAt)}. Ask ${first} to plan it again.`;
  if (goneId) {
    topError = altList.length
      ? `That option isn't available anymore. ${canRequest ? 'Pick another one, or request approval for the trip as it is.' : 'Pick another one, or plan the trip again.'}`
      : `That option isn't available anymore. ${canRequest ? 'You can request approval for the trip as it is, or plan it again.' : 'Plan the trip again to choose new options.'}`;
  }
  // The traveler's own second click (or another tab) is not "someone else".
  if (refusal === 'conflict' && view.self) topError = 'This trip changed since you opened this page, maybe in another tab or with a second click. Here is where it stands now.';
  // The late banner says what too_late says, with the way forward.
  if (refusal === 'too_late' && late) topError = null;

  const facts = p.kvList([
    ['Traveler', view.self ? '' : r.travelerName],
    ['Purpose', r.purpose],
    ['Dates', datesText(r.query.departDate, r.query.returnDate)],
    ['Department', departmentName || ''],
    ['Policy', `${TIER_LABELS[r.tier] || r.tier} policy${r.evaluation && r.evaluation.policy ? `, version ${r.evaluation.policy.version}` : ''}`],
    ['Planned', f.whenIn(timeZone, r.at, { now: ctx.now(), zone: true })],
  ]);

  // What the traveler wrote when they asked: on their own pages once sent, and for anyone else who is not
  // deciding (the decider's panel shows it already).
  const reasonBlock = r.reason && r.reason.text && view.status !== 'draft' && (view.self || !deciding)
    ? html`<section class="bz-card bz-reason-block" aria-labelledby="bz-reason-title"><h2 class="bz-block-title" id="bz-reason-title">${view.self ? 'Your reason' : `${first}'s reason`}</h2><blockquote class="bz-quote">“${r.reason.text}”</blockquote>${r.reason.category ? html`<p class="bz-muted">Category: ${REASON_CATEGORY_LABELS[r.reason.category] || r.reason.category}</p>` : ''}</section>`
    : '';

  const lateBanner = late
    ? html`<div class="alert alert-warning bz-alert bz-late" role="${refusal === 'too_late' ? 'alert' : 'note'}">${icon('alert')}<div><p>This trip was planned to leave on ${f.day(depart)}, which has passed, so it can't be sent. Plan it again with new dates.</p><p><a class="btn btn-ghost bz-btn" href="${base}/trips/new?${searchQuery(r.query)}">${icon('arrow')}<span>Plan it again with new dates</span></a></p></div></div>`
    : '';

  const alts = showAlts
    ? p.alternativesPanel(
      {
        alternatives: distinctTitles(altList).map(a => (a.evaluation ? { ...a, evaluation: { ...a.evaluation, violations: namedViolations(forViewer(a.evaluation.violations, view, first)) } } : a)),
        cheapestWithin: r.cheapestWithin && altList.some(a => a.id === r.cheapestWithin.id) ? r.cheapestWithin : null,
        truncated: !!r.alternativesTruncated,
        // With live search off the traveler can neither switch nor send the trip yet: the summary says so.
        summary: view.can.swap && off && altList.length
          ? PRICE_CHECK_COPY.searchOffSwap
          : summaryFor(r.explanation ? r.explanation.summary : '', { canRequest: (canRequest && !off) || !view.self, hasAlternatives: altList.length > 0 }),
      },
      { timeZone, action: swappable ? `${base}/trips/${r.id}/swap` : null, rev: r.rev, level: 2, source },
    )
    : '';
  const selfCannotDecide = view.self && view.status === 'pending' && roleCan(member.role, 'approval.decide')
    ? html`<p class="bz-note">${icon('info')}<span>You can't decide your own trip.</span></p>` : '';

  const banner = view.status === 'draft' ? returnedBanner(r, { self: view.self, timeZone, pick, source }) : statusBanner(ctx, r, view, { member, base, timeZone, expiredSaid, source });
  // A self draft that can't be sent and has nothing to pick here gets the way to plan it again.
  const again = draftSelf && !late && !pick ? againLink(base, r) : '';

  return html`${p.pageHead({ title, sub: `${routeText(map, r.query.from, r.query.to)} · ${datesText(r.query.departDate, r.query.returnDate)}`, actions: p.statusPill(view.status, { source }) })}
  ${okNotice(ok, r, view, { banner })}
  ${p.errorBox(topError)}
  ${lateBanner}
  ${banner}
  ${policyBlock(r, view, { org, timeZone, pick, again, source, off })}
  ${selfCannotDecide}
  ${deciding ? deciderPanel(ctx, r, view, { base, timeZone, form, failed, refusal, error, role: member.role, budget: budgetBlock(r, view, { org, departmentName, timeZone, deciding, level: 3, source }), source, off }) : ''}
  ${facts ? html`<div class="bz-card bz-facts">${facts}</div>` : ''}
  ${reasonBlock}
  ${tripParts(r, view, { timeZone, map, source })}
  ${deciding ? '' : budgetBlock(r, view, { org, departmentName, timeZone, deciding, level: 2, source })}
  ${alts}
  ${draftSelf && !late ? submitPanel(r, view, { org, member, base, form, failed, refusal, error, soon, source, off }) : ''}
  ${cancelPanel(r, view, { base, confirm, dest })}
  ${messagesPanel(ctx, r, view, { base, timeZone, form, failed, refusal, error, member, canRequest })}
  ${historyPanel(ctx, r, { timeZone, member, source })}`;
}

module.exports = { requestView, okText, GONE, APPROVED, WITHIN_DRAFT, totalNote };
