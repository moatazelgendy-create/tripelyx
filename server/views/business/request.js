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
// friends), in the company's time zone.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const f = require('./format');
const p = require('./parts');
const { LABELS, can: roleCan } = require('../../business/roles');
const { REASON_CATEGORIES, REASON_CATEGORY_LABELS, REASON_MIN_CHARS, TIER_LABELS } = require('../../business/constants');
const { REASON_MAX_CHARS, NOTE_MIN_CHARS, MESSAGE_CHARS } = require('../../business/lifecycle');
const { periodKey, periodLabel } = require('../../business/budgets');
const { places, cityOf, routeText, datesText, searchQuery, nightsBetween } = require('./trips');

const COMPONENTS = Object.freeze(['out', 'back', 'hotel']);
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

/** The fixed text of each ?ok= code. */
function okText(code, r, view) {
  if (OK_STATUS[code] && view.status && !OK_STATUS[code].includes(view.status)) return null;
  const first = firstName(r.travelerName);
  const ret = r.returned || {};
  const approverName = view.approver ? view.approver.name : 'your approver';
  switch (code) {
    case 'swapped': return 'Switched to the cheaper option. Here is your updated trip.';
    case 'auto_approved': return 'Confirmed. Your trip is approved to book under your policy.';
    case 'submitted': return `Sent for approval. We don't send emails yet, so ${approverName} will see it under Approvals.`;
    case 'repriced': return 'This trip changed before it was sent. Review it and send it again.';
    case 'cancelled': return 'Cancelled. Nothing was booked or charged.';
    case 'approved': return 'Approved. The trip is approved to book.';
    case 'denied': return `Denied. ${first} can see your note on this page.`;
    case 'returned':
      if (ret.why === 'unavailable') return `An option is no longer available, so this went back to ${first} to confirm.`;
      if (ret.why === 'price_changed' && ret.toCents !== ret.fromCents) return `The price changed, so this went back to ${first} to confirm.`;
      return `The fare or room terms changed, so this went back to ${first} to confirm.`;
    case 'message': return 'Message sent. They will see it on this page.';
    default: return null;
  }
}

/** A form that only POSTs the request's rev (cancel, confirm). */
function revForm(action, rev, button, { cls = 'btn btn-ghost bz-btn', bar = false } = {}) {
  const b = html`<button class="${cls}" type="submit">${button}</button>`;
  return html`<form method="post" action="${action}"><input type="hidden" name="rev" value="${String(rev)}">${bar ? p.actionBar(b) : b}</form>`;
}

/** The banner of a draft that a price check sent back (or changed before it was sent). */
function returnedBanner(r, { self, timeZone }) {
  const ret = r.returned;
  const last = (r.history || [])[r.history.length - 1];
  if (!ret || !last || (last.action !== 'returned' && last.action !== 'repriced')) return '';
  const waiting = last.action === 'returned';
  const first = firstName(r.travelerName);
  const priced = ret.why === 'price_changed' && Number.isSafeInteger(ret.toCents) && ret.toCents !== ret.fromCents;
  let text;
  if (ret.why === 'unavailable') {
    text = waiting
      ? (self ? 'An option in this trip is no longer in the demo data, so it came back to you. Nothing was approved. Pick another option below or plan the trip again.' : `An option in this trip is no longer in the demo data, so it went back to ${first}. Nothing was approved.`)
      : 'An option in this trip is no longer in the demo data. Pick another option below or plan the trip again.';
  } else if (priced) {
    text = waiting
      ? (self ? 'The price changed while this was waiting, so it came back to you. Nothing was approved. Review the new total and request approval again.' : `The price changed while this was waiting, so it went back to ${first}. Nothing was approved.`)
      : 'The price changed before this was sent. Review the new total and send it again.';
  } else {
    text = waiting
      ? (self ? 'The fare or room terms changed while this was waiting, so it came back to you. The price is the same. Nothing was approved. Review the trip and request approval again.' : `The fare or room terms changed while this was waiting, so it went back to ${first}. The price is the same. Nothing was approved.`)
      : 'The fare or room terms changed before this was sent. The price is the same. Review the trip and send it again.';
  }
  const body = html`<div class="alert alert-warning bz-alert bz-returned" role="note">${icon('alert')}<div><p>${text}</p>${priced ? html`<p class="bz-returned-price">Was ${p.amount(ret.fromCents)}, now ${p.amount(ret.toCents)}.</p>` : ''}</div></div>`;
  return priced ? p.demoBox(body, { pricedAt: r.pricedAt, timeZone, cls: 'bz-returned-box' }) : body;
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

/** The policy verdict and its reasons. */
function policyBlock(r, view, { org, timeZone }) {
  const ev = r.evaluation || { status: 'within', violations: [] };
  const n = (ev.violations || []).length;
  let text;
  if (ev.status === 'within') text = view.status === 'draft' && view.self ? "Every part of this trip is inside your policy. Confirm and it's approved to book." : 'Every part of this trip is inside the policy.';
  else if (ev.status === 'out') text = `Out of policy: ${f.plural(n, 'reason')}`;
  else if (view.status === 'draft' && !view.self) text = `This trip can't be requested under ${org.name}'s policy.`;
  else if (view.status === 'draft') text = (r.alternatives || []).length ? `This trip can't be requested under ${org.name}'s policy. Pick one of the options below.` : `This trip can't be requested under ${org.name}'s policy. Plan it again with options marked Within Policy.`;
  else text = 'Blocked by policy.';
  return html`<section class="bz-policy-check" aria-label="Policy check">
    ${p.verdict(ev.status, text)}
    ${p.violationList(namedViolations(ev.violations), { pricedAt: r.pricedAt, timeZone })}
    ${view.policyChanged ? html`<p class="bz-note">${icon('info')}<span>Policy updated since this request (v${String(view.policyChanged.from)} → v${String(view.policyChanged.to)}). It was checked against v${String(view.policyChanged.from)}.</span></p>` : ''}
  </section>`;
}

/** The status banner of a request that is not a draft. */
function statusBanner(ctx, r, view, { org, member, base, timeZone }) {
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
        <p><b>Approved to book.</b> Booking opens once Tripelyx connects airlines and hotels. Nothing has been booked or charged.</p>
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
      const when = r.expiresAt ? f.dateTimeIn(timeZone, r.expiresAt) : null;
      return html`<div class="bz-status bz-status-expired">${icon('clock')}<div>
        <p>${when ? `Expired at ${when}.` : 'Expired.'} Nothing was approved.</p>
        ${view.self ? again : html`<p>${first} can plan it again.</p>`}
      </div></div>`;
    }
    default: return '';
  }
}

/** The trip's parts and its total, with every price line one tap away. */
function tripParts(r, { timeZone, map }) {
  const evals = (r.evaluation && r.evaluation.components) || {};
  const basis = evals.hotel && evals.hotel.cap && evals.hotel.cap.basis ? evals.hotel.cap.basis : 'incl_taxes';
  const cards = COMPONENTS.filter(c => r.rows && r.rows[c]).map(c => p.rowCard({ row: r.rows[c], evaluation: evals[c] || { status: null, violations: [] } }, { timeZone, level: 3, basis }));
  const label = c => {
    if (c === 'out') return `Outbound flight, ${routeText(map, r.query.from, r.query.to)}`;
    if (c === 'back') return `Return flight, ${routeText(map, r.query.to, r.query.from)}`;
    const h = r.rows.hotel;
    return `${h.name}, ${f.plural(h.nights || nightsBetween(h.checkIn, h.checkOut), 'night')}`;
  };
  const parts = COMPONENTS.filter(c => r.rows && r.rows[c]);
  const missing = parts.some(c => !r.rows[c].available || !Number.isSafeInteger(r.rows[c].totalCents));
  const saved = Number.isSafeInteger(r.originalTotalCents) && r.originalTotalCents > r.totalCents && (r.history || []).some(h => h.action === 'swapped')
    ? r.originalTotalCents - r.totalCents : 0;
  const lines = html`<dl class="bz-lines">
    ${parts.map(c => {
    const row = r.rows[c];
    const ok = row.available && Number.isSafeInteger(row.totalCents);
    return html`<div class="bz-line"><dt>${label(c)}</dt><dd>${ok ? p.amount(row.totalCents) : html`<span class="bz-unavailable">${p.UNAVAILABLE}</span>`}</dd></div>`;
  })}
    <div class="bz-line bz-line-total"><dt>${missing ? 'Total of the options still available' : 'Trip total'}</dt><dd>${p.amount(r.totalCents)}</dd></div>
  </dl>
  ${saved > 0 ? html`<p class="bz-saved">${icon('check')}<span>Saved ${p.amount(saved)} by switching to cheaper options.</span></p>` : ''}
  <p class="bz-total-note">The total is everything charged for these options: each fee and tax is under Price details.</p>`;
  return html`<section class="bz-trip-parts" aria-labelledby="bz-parts-title">
    <h2 id="bz-parts-title">The trip</h2>
    ${cards}
    ${p.demoBox(html`<h3 class="bz-total-title">Trip total</h3>${lines}`, { pricedAt: r.pricedAt, timeZone, tag: 'section', cls: 'bz-card bz-total', label: 'Trip total' })}
  </section>`;
}

/** The department's budget for this trip, in the words the page's status calls for. */
function budgetBlock(r, view, { org, departmentName, timeZone, deciding, level = 2 }) {
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
    ? p.demoBox(box, { pricedAt: r.pricedAt, timeZone, tag: 'section', cls: 'bz-card bz-budget', label: 'Budget' })
    : html`<section class="bz-card bz-budget" aria-label="Budget">${box}</section>`;
}

/** How much the trip would take the department over its budget (0 when it fits or has none). */
function overBy(r, view) {
  const b = view.budget;
  if (!b || !Number.isSafeInteger(b.remainingCents)) return 0;
  return r.totalCents > b.remainingCents ? r.totalCents - b.remainingCents : 0;
}

/** The approver's panel: price check, comparison, reason, decision form. */
function deciderPanel(ctx, r, view, { base, timeZone, form, failed, refusal, error, role, budget }) {
  const now = ctx.now();
  const first = firstName(r.travelerName);
  const live = view.live;
  let check;
  if (!live) {
    check = html`<p>${icon('info')}<span>We couldn't check the price again just now. Approving checks it once more.</span></p>`;
  } else {
    const at = f.whenIn(timeZone, live.at, { now });
    if (live.status === 'same') check = html`<p>${icon('check')}<span>Price checked again at ${at}: unchanged.</span></p>`;
    else if (live.status === 'unavailable') check = html`<p>${icon('alert')}<span>Price checked again at ${at}: an option is no longer in the demo data. If you approve, it goes back to ${first} to pick another option.</span></p>`;
    else if (Number.isSafeInteger(live.newTotalCents) && live.newTotalCents !== r.totalCents) check = html`<p>${icon('alert')}<span>Price checked again at ${at}: now ${p.amount(live.newTotalCents)} (was ${p.amount(r.totalCents)}). If you approve, it goes back to ${first} to confirm the new price.</span></p>`;
    else check = html`<p>${icon('alert')}<span>Price checked again at ${at}: the fare or room terms changed. The price is the same. If you approve, it goes back to ${first} to confirm.</span></p>`;
  }
  const checkBox = p.demoBox(html`<div class="bz-live">${check}</div>`, { pricedAt: live ? live.at : r.pricedAt, timeZone, cls: 'bz-live-box' });

  let compare;
  if (view.comparison) {
    const c = view.comparison;
    const rows = c.rows.map(x => [x.label, x.a === null || x.a === undefined ? 'None' : x.a, x.b === null || x.b === undefined ? 'None' : x.b]);
    rows.push(['Trip total', p.amount(c.totalCents.a), p.amount(c.totalCents.b)]);
    compare = p.demoBox(html`<h3 class="bz-block-title">Requested vs cheapest option inside policy</h3>
      ${p.dataTable({ caption: 'Requested vs cheapest option inside policy', columns: [{ label: 'Detail' }, { label: 'Requested' }, { label: 'Cheapest inside policy' }], rows })}
      ${c.totalCents.delta < 0 ? html`<p class="bz-compare-delta">The option inside the policy costs ${p.amount(-c.totalCents.delta)} less.</p>` : ''}`, { pricedAt: r.cheapestWithin && r.cheapestWithin.rows && r.cheapestWithin.rows.out ? r.cheapestWithin.rows.out.pricedAt : r.pricedAt, timeZone, tag: 'section', cls: 'bz-compare', label: 'Requested vs cheapest option inside policy' });
  } else {
    compare = html`<section class="bz-compare" aria-label="Cheapest option inside policy"><h3 class="bz-block-title">Requested vs cheapest option inside policy</h3><p>No option inside the policy turned up when ${first} searched.</p></section>`;
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
  const overText = over > 0 && b
    ? html`<span class="bz-demo-price" data-price-source="demo">Approve even though ${b.departmentName} goes ${p.amount(over)} over its ${b.periodLabel} budget (demo prices). ${p.priceNote(r.pricedAt, timeZone, { inline: true })}</span>`
    : html`<span>Approve even though it goes over the department's budget.</span>`;
  const assigned = view.approver ? view.approver.name : null;
  const action = `${base}/trips/${r.id}/decide`;
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
        <textarea id="d-note" name="note" maxlength="500" data-count="d-note-count" aria-describedby="d-note-count${noteError ? ' d-note-err' : ''}"${noteError ? html` aria-invalid="true"` : ''}>${mine ? form.note || '' : ''}</textarea>
        <p class="field-hint" id="d-note-count">${view.can.override ? `Needed: at least ${NOTE_MIN_CHARS} characters. ${first} sees this note.` : `Needed to deny: tell ${first} why, in at least ${NOTE_MIN_CHARS} characters. ${first} sees this note.`}</p>
        ${noteError ? html`<p class="field-error" id="d-note-err">${noteError}</p>` : ''}
      </div>
      ${showAck ? html`<div class="bz-choices${ackError ? ' is-invalid' : ''}"><label class="bz-choice" for="d-ack"><input id="d-ack" type="checkbox" name="ackOverBudget" value="1"${mine && form.ack ? html` checked` : ''}${ackError ? html` aria-invalid="true" aria-describedby="d-ack-err"` : ''}>${overText}</label>${ackError ? html`<p class="field-error" id="d-ack-err">${ackError}</p>` : ''}</div>` : ''}
      ${p.actionBar(html`<button class="btn btn-navy bz-btn" type="submit" name="action" value="approve">${icon('check')}<span>Approve</span></button>
        <button class="btn btn-ghost bz-btn" type="submit" name="action" value="deny">${icon('close')}<span>Deny</span></button>
        <a class="btn btn-ghost bz-btn" href="#message">${icon('mail')}<span>Ask a question</span></a>`)}
    </form>
  </section>`;
}

/** The traveler's primary action on a draft: Confirm trip, Request Approval, or what to do instead. */
function submitPanel(r, view, { org, member, base, form, failed, refusal, error }) {
  const ev = r.evaluation || { status: 'within' };
  const action = `${base}/trips/${r.id}/submit`;
  const hours = org.settings && Number.isInteger(org.settings.approvalHours) ? org.settings.approvalHours : 24;
  if (ev.status === 'within') {
    return html`<section class="bz-card bz-submit" aria-labelledby="bz-submit-title">
      <h2 id="bz-submit-title">Confirm your trip</h2>
      <p>This trip is inside your policy, so confirming approves it to book. Nothing is booked or charged.</p>
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
  const min = org.settings && Number.isInteger(org.settings.reasonMinChars) ? org.settings.reasonMinChars : REASON_MIN_CHARS;
  const mine = failed === 'submit';
  const reasonError = mine && (refusal === 'reason_too_short' || refusal === 'card_number') ? error : null;
  const rule = { approver: 'your approver', manager: 'your manager', admin: org.name ? `${org.name}'s admins` : 'your admins' }[view.approver.rule] || 'your approver';
  return html`<section class="bz-card bz-submit" aria-labelledby="bz-submit-title">
    <h2 id="bz-submit-title">Request Approval</h2>
    <p class="bz-goes">${icon('user')}<span>Goes to ${view.approver.name} (${rule}).</span></p>
    <form class="bz-form" method="post" action="${action}">
      <input type="hidden" name="rev" value="${String(r.rev)}">
      <div class="field">
        <label for="s-reason">Why does this trip need an exception?</label>
        <textarea id="s-reason" name="reason" required minlength="${String(min)}" maxlength="${String(REASON_MAX_CHARS)}" data-count="s-reason-count" aria-describedby="s-reason-count${reasonError ? ' s-reason-err' : ''}"${reasonError ? html` aria-invalid="true"` : ''}>${mine ? form.reason || '' : ''}</textarea>
        ${p.charCount('s-reason-count', { min, max: REASON_MAX_CHARS })}
        ${reasonError ? html`<p class="field-error" id="s-reason-err">${reasonError}</p>` : ''}
      </div>
      <div class="field">
        <label for="s-category">Category</label>
        <select id="s-category" name="category">
          <option value="">Choose one (optional)</option>
          ${REASON_CATEGORIES.map(c => html`<option value="${c}"${mine && form.category === c ? html` selected` : ''}>${REASON_CATEGORY_LABELS[c]}</option>`)}
        </select>
      </div>
      <p class="bz-muted">If no one decides within ${f.plural(hours, 'hour')}, the request expires and nothing is approved. We don't send emails yet: ${firstName(view.approver.name)} sees it under Approvals.</p>
      ${p.actionBar(html`<button class="btn btn-navy bz-btn" type="submit">${icon('arrow')}<span>Request Approval</span></button>`)}
    </form>
  </section>`;
}

/** Cancel, as the status and the viewer allow. */
function cancelPanel(r, view, { base }) {
  if (!view.can.cancel) return '';
  const action = `${base}/trips/${r.id}/cancel`;
  if (view.status === 'draft') return html`<div class="bz-cancel">${revForm(action, r.rev, 'Cancel this trip')}</div>`;
  if (view.status === 'pending') return html`<div class="bz-cancel">${revForm(action, r.rev, 'Cancel request')}<p class="bz-muted">Cancelling withdraws it from your approver. Nothing was booked or charged.</p></div>`;
  return html`<div class="bz-cancel">${revForm(action, r.rev, view.self ? 'Cancel this trip' : 'Cancel this approved trip')}<p class="bz-muted">Cancelling releases what this trip holds of the department's budget. Nothing was booked or charged.</p></div>`;
}

/** Messages and the form to write one. */
function messagesPanel(ctx, r, view, { base, timeZone, form, failed, refusal, error, member }) {
  const list = r.messages || [];
  if (!list.length && !view.can.message) return '';
  const now = ctx.now();
  const mine = failed === 'message';
  const textError = mine && (refusal === 'invalid_message' || refusal === 'card_number' || refusal === 'too_many_messages') ? error : null;
  return html`<section class="bz-messages" id="message" aria-labelledby="bz-msg-title">
    <h2 id="bz-msg-title">Messages</h2>
    ${list.length ? html`<ol class="bz-thread">${list.map(m => html`<li class="bz-msg"><p class="bz-msg-head"><b>${m.by === member.userId ? 'You' : m.name}</b><span>${f.whenIn(timeZone, m.at, { now })}</span></p><p>${m.text}</p></li>`)}</ol>` : html`<p class="bz-muted">No messages yet.</p>`}
    ${view.can.message ? html`<form class="bz-form" method="post" action="${base}/trips/${r.id}/message">
      <div class="field">
        <label for="m-text">${view.self ? 'Write to your approver' : `Ask ${firstName(r.travelerName)} a question`}</label>
        <textarea id="m-text" name="text" required minlength="${String(MESSAGE_CHARS[0])}" maxlength="${String(MESSAGE_CHARS[1])}" data-count="m-text-count" aria-describedby="m-text-count${textError ? ' m-text-err' : ''}"${textError ? html` aria-invalid="true"` : ''}>${mine ? form.text || '' : ''}</textarea>
        ${p.charCount('m-text-count', { min: MESSAGE_CHARS[0], max: MESSAGE_CHARS[1] })}
        ${textError ? html`<p class="field-error" id="m-text-err">${textError}</p>` : ''}
      </div>
      <p class="bz-muted">We don't send emails yet. They'll see it on this page.</p>
      <div><button class="btn btn-ghost bz-btn" type="submit">${icon('mail')}<span>Send message</span></button></div>
    </form>` : ''}
  </section>`;
}

/** The request's history, oldest first. */
function historyPanel(ctx, r, { timeZone, member }) {
  const list = r.history || [];
  if (!list.length) return '';
  const now = ctx.now();
  const first = firstName(r.travelerName);
  const line = h => {
    const who = actorName(h.by, { self: member.userId });
    switch (h.action) {
      case 'drafted': return `${who} planned this trip.`;
      case 'swapped': return html`${who} switched to a cheaper option${h.note ? `: ${h.note}` : ''}.${Number.isSafeInteger(h.savedCents) && h.savedCents > 0 ? html` Saved ${p.demoPrice(h.savedCents, { pricedAt: h.at, timeZone })}` : ''}`;
      case 'repriced': return 'The trip changed before it was sent, so it was updated.';
      case 'submitted': return `${who} asked for approval.`;
      case 'auto_approved': return 'Approved by policy.';
      case 'approved': return `${who} approved it.`;
      case 'denied': return `${who} denied it.`;
      case 'returned': return `It went back to ${who === 'You' ? 'you' : first} to confirm: the trip changed while it was waiting.`;
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

/**
 * @param {object} ctx
 * @param {{ org: object, member: object, view: import('../../business/types').RequestView, departmentName: string|null,
 *   ok?: string, error?: string|null, failed?: string|null, form?: object, refusal?: string|null, base: string }} m
 */
function requestView(ctx, { org, member, view, departmentName = null, ok = '', error = null, failed = null, form = {}, refusal = null, base }) {
  const r = view.request;
  const timeZone = f.safeZone(view.timezone || org.timezone);
  const map = places(ctx);
  const dest = r.rows && r.rows.hotel ? r.rows.hotel.city : cityOf(map, r.query.to);
  const title = view.self ? (view.status === 'draft' ? 'Review your trip' : `Your trip to ${dest}`) : `${r.travelerName}'s trip to ${dest}`;
  const deciding = view.can.decide;

  // A field-level refusal shows at its field; the box at the top says where to look.
  const FIELD = { submit: ['reason_too_short', 'card_number'], decide: ['note_required', 'card_number', 'over_budget'], message: ['invalid_message', 'card_number', 'too_many_messages'] };
  let topError = error;
  if (error && failed && (FIELD[failed] || []).includes(refusal)) topError = 'Check the highlighted field below.';
  if (refusal === 'request_expired' && failed === 'decide' && r.expiresAt) topError = `This request expired at ${f.dateTimeIn(timeZone, r.expiresAt)}. Ask ${firstName(r.travelerName)} to plan it again.`;

  const facts = p.kvList([
    ['Traveler', view.self ? '' : r.travelerName],
    ['Purpose', r.purpose],
    ['Dates', datesText(r.query.departDate, r.query.returnDate)],
    ['Department', departmentName || ''],
    ['Policy', `${TIER_LABELS[r.tier] || r.tier} policy${r.evaluation && r.evaluation.policy ? `, version ${r.evaluation.policy.version}` : ''}`],
    ['Planned', f.whenIn(timeZone, r.at, { now: ctx.now(), zone: true })],
  ]);

  const draftSelf = view.status === 'draft' && view.self;
  const evStatus = r.evaluation ? r.evaluation.status : 'within';
  // A blocked trip with no alternative has nothing to offer here: its verdict already says to plan it again
  // (the stored summary may suggest requesting approval, which a blocked trip cannot do).
  const altList = r.alternatives || [];
  const alts = view.status === 'draft' && (evStatus === 'out' || (evStatus === 'blocked' && altList.length))
    ? p.alternativesPanel(
      {
        alternatives: altList.map(a => (a.evaluation ? { ...a, evaluation: { ...a.evaluation, violations: namedViolations(a.evaluation.violations) } } : a)),
        cheapestWithin: r.cheapestWithin || null, truncated: !!r.alternativesTruncated, summary: r.explanation ? r.explanation.summary : '',
      },
      { timeZone, action: view.can.swap ? `${base}/trips/${r.id}/swap` : null, rev: r.rev, level: 2 },
    )
    : '';
  const selfCannotDecide = view.self && view.status === 'pending' && roleCan(member.role, 'approval.decide')
    ? html`<p class="bz-note">${icon('info')}<span>You can't decide your own trip.</span></p>` : '';

  return html`${p.pageHead({ title, sub: `${routeText(map, r.query.from, r.query.to)} · ${datesText(r.query.departDate, r.query.returnDate)}`, actions: p.statusPill(view.status) })}
  ${p.notice(okText(ok, r, view))}
  ${p.errorBox(topError)}
  ${view.status === 'draft' ? returnedBanner(r, { self: view.self, timeZone }) : statusBanner(ctx, r, view, { org, member, base, timeZone })}
  ${policyBlock(r, view, { org, timeZone })}
  ${selfCannotDecide}
  ${deciding ? deciderPanel(ctx, r, view, { base, timeZone, form, failed, refusal, error, role: member.role, budget: budgetBlock(r, view, { org, departmentName, timeZone, deciding, level: 3 }) }) : ''}
  ${facts ? html`<div class="bz-card bz-facts">${facts}</div>` : ''}
  ${tripParts(r, { timeZone, map })}
  ${deciding ? '' : budgetBlock(r, view, { org, departmentName, timeZone, deciding, level: 2 })}
  ${alts}
  ${draftSelf ? submitPanel(r, view, { org, member, base, form, failed, refusal, error }) : ''}
  ${cancelPanel(r, view, { base })}
  ${messagesPanel(ctx, r, view, { base, timeZone, form, failed, refusal, error, member })}
  ${historyPanel(ctx, r, { timeZone, member })}`;
}

module.exports = { requestView, okText };
