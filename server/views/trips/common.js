// Shared pieces of the Travel by Budget pages: money and date formatting, the budget meter, the trip
// recipe (price breakdown), the scorecard and trip status labels.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { format } = require('../../lib/money');
const { date } = require('../format');
const { clock } = require('../../trips/decision');
const { cutoffs, isOpen, fullRefundApplies, FULL_REFUND_MIN_DAYS } = require('../../trips/deadlines');
const { addDays } = require('../../lib/dates');

const money = c => format(c, 'USD');
const dollars = c => `$${Math.round(c / 100).toLocaleString('en-US')}`;
const shortDate = d => date(d, { day: 'numeric', month: 'short' });
// One date format for customer text, shared with the engines' sentences (trips/words).
const { longDate } = require('../../trips/words');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const joinAnd = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// A cutoff as a moment the traveler can act on. Cutoffs fall at midnight UTC at the start of a day
// (see trips/deadlines), which is "the end of" the day before, in UTC; the zone is always named,
// because a bare date would read as the traveler's own midnight, hours after the refund closes.
function cutoffText(iso) {
  if (!iso) return '';
  const day = iso.slice(0, 10);
  if (iso.slice(11, 19) === '00:00:00') return `by the end of ${longDate(addDays(day, -1))} (UTC)`;
  return `by ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(iso))} UTC on ${longDate(day)}`;
}

// Each part's cancellation terms with its dated cutoff where the supplier states one, read at `now`:
// a cutoff still ahead, one that has passed, one the supplier has not stated (needs verification),
// and, for a trip leaving in under 7 days, that the 24-hour window the terms mention does not apply.
function termsFor(t, { now = null, bookedAt = null } = {}) {
  const { items } = cutoffs(t, { bookedAt });
  const window = now ? fullRefundApplies(t, now) : true;
  return t.policies.map(p => {
    const it = items.find(x => x.key === p.key) || null;
    let when = null, tone = null;
    if (it && it.unverified) { when = 'The supplier has not stated its free-cancellation cutoff: needs verification.'; tone = 'verify'; }
    else if (it && it.cutoff && now && !isOpen(it, now)) { when = `The free-cancellation cutoff (${cutoffText(it.cutoff)}) has passed.`; tone = 'passed'; }
    else if (it && it.cutoff) { when = `Free to cancel ${cutoffText(it.cutoff)}${p.key.startsWith('activity:') ? '; we count it from the day you arrive, since the activity’s day is set after booking' : ''}.`; tone = 'ok'; }
    if (!window && (p.key === 'service' || (p.key === 'flights' && !(it && it.cutoff)))) { when = `${when ? `${when} ` : ''}No 24-hour window on this trip: departure is under ${FULL_REFUND_MIN_DAYS} days away.`; tone = tone || 'passed'; }
    return { ...p, cutoff: it ? it.cutoff : null, when, tone };
  });
}

function hm(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h}h${m ? ` ${String(m).padStart(2, '0')}m` : ''}`;
}

const TRIP_STATUS = {
  pending_payment: ['Pending', 'warn'], confirming: ['Processing', 'warn'], pending_supplier: ['Processing', 'warn'],
  confirmed: ['Confirmed', 'good'], partially_confirmed: ['Partially confirmed', 'warn'], failed: ['Failed', 'bad'],
  cancelled: ['Canceled', 'bad'], cancelling: ['Canceling', 'warn'], refund_pending: ['Refund pending', 'warn'],
  refunded: ['Refunded', 'bad'], expired: ['Expired', 'bad'],
};

function statusPill(status) {
  const [label, tone] = TRIP_STATUS[status] || [status, 'warn'];
  return html`<span class="tb-status tb-status-${tone}">${label}</span>`;
}

function demoBadge(on, text = 'Demo data') {
  return on ? html`<span class="tb-demo" title="Invented inventory for development and preview. Not bookable for real.">${icon('info')}${text}</span>` : '';
}

// Budget health meter. Never hides an over-budget amount.
function budgetMeter(total, budget, { compact = false, title = 'Your budget' } = {}) {
  if (!budget) return '';
  const diff = budget - total;
  const used = total / budget;
  const state = diff < 0 ? 'over' : used >= 0.98 ? 'full' : used >= 0.85 ? 'near' : 'good';
  const label = diff < 0 ? `${money(-diff)} over budget` : state === 'full' ? 'Budget fully used' : state === 'near' ? 'Within budget' : 'Comfortably within budget';
  return html`<div class="tb-meter tb-meter-${state}${compact ? ' tb-meter-compact' : ''}">
    <div class="tb-meter-nums">
      <div><span>${title}</span><b>${money(budget)}</b></div>
      <div><span>This trip</span><b>${money(total)}</b></div>
      <div><span>${diff < 0 ? 'Over by' : 'You keep'}</span><b>${money(Math.abs(diff))}</b></div>
    </div>
    <meter min="0" max="${Math.max(budget, total)}" low="${Math.round(budget * 0.85)}" high="${budget}" optimum="0" value="${total}" aria-label="Trip total compared with your budget">${Math.round(used * 100)}%</meter>
    <p class="tb-meter-label">${icon(diff < 0 ? 'alert' : 'check')}${label}</p>
  </div>`;
}

// The trip recipe: exactly where every dollar goes.
function recipe(t, budget) {
  return html`<div class="tb-recipe">
    ${budget ? html`<p class="tb-recipe-title">Your ${dollars(budget)} trip</p>` : ''}
    <dl>
      ${t.lines.map(l => html`<div class="tb-recipe-row${l.amount < 0 ? ' is-discount' : ''}">
        <dt>${l.label}${l.detail ? html`<details class="tb-recipe-detail"><summary>What’s in this</summary><ul>${l.detail.filter(d => d.amount).map(d => html`<li><span>${d.label}</span><span>${money(d.amount)}</span></li>`)}</ul></details>` : ''}</dt>
        <dd>${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</dd>
      </div>`)}
      <div class="tb-recipe-row tb-recipe-total"><dt>Total</dt><dd>${money(t.total)}</dd></div>
      ${budget ? html`<div class="tb-recipe-row tb-recipe-left${budget - t.total < 0 ? ' is-over' : ''}"><dt>${budget - t.total < 0 ? 'Over your budget' : 'Left in your budget'}</dt><dd>${money(Math.abs(budget - t.total))}</dd></div>` : ''}
    </dl>
    <p class="tb-recipe-note">${money(t.perNight)} per night for the complete trip · ${money(t.perTraveler)} per traveler. Every tax and mandatory fee is included; nothing is added at checkout.</p>
  </div>`;
}

const SCORE_HELP = {
  budget: 'Budget fit: 10 when the total is at or under your budget, lower the further over it goes.',
  hotel: 'Hotel: from the star class and the supplier’s guest rating.',
  flight: 'Flight: nonstop scores higher than one stop, flexible fares higher than basic, very long journeys a little lower.',
  location: 'Location: from the hotel’s area in supplier data, with a lift for beachfront stays on beach trips.',
  value: 'Value: this trip’s price compared with its typical price for the same parts.',
};

function scorecard(scores, demo) {
  const rows = [['budget', 'Budget fit'], ['hotel', 'Hotel'], ['flight', 'Flight'], ['location', 'Location'], ['value', 'Value']];
  return html`<div class="tb-scorecard">
    <div class="tb-score-match"><b>${scores.match}%</b><span>overall match</span></div>
    <ul>${rows.map(([k, l]) => html`<li><span>${l}</span><meter min="0" max="10" value="${scores.card[k]}" aria-label="${l} score">${scores.card[k]}</meter><b>${scores.card[k].toFixed(1)}</b></li>`)}</ul>
    <details class="tb-score-how"><summary>How we score trips</summary><ul>${rows.map(([k]) => html`<li>${SCORE_HELP[k]}</li>`)}</ul>
      <p>The overall match weighs these with your answers (what matters most to you, the trip style). How much Tripelyx earns on a trip is never part of the score.${demo ? ' Ratings and typical prices come from demo data in this preview.' : ''}</p></details>
  </div>`;
}

// The verdict badge: Great fit / Good fit / Budget fit / We'd keep looking.
function fitBadge(v, { compact = false } = {}) {
  return html`<span class="tb-fit tb-fit-${v.tone}${compact ? ' tb-fit-compact' : ''}" title="${v.action}">${v.label}</span>`;
}

// Hidden inputs carrying a query string into a GET form.
function hiddenParams(qs) {
  return [...new URLSearchParams(qs)].map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
}

function stepsBar(current) {
  const steps = ['Your trip', 'Price check', 'Traveler & payment', 'Confirmation'];
  return html`<ol class="progress-steps tb-steps" aria-label="Booking steps">${steps.map((s, i) => html`<li class="${i < current ? 'is-done' : i === current ? 'is-current' : ''}"${i === current ? raw(' aria-current="step"') : ''}><span class="step-dot">${i + 1}</span>${s}</li>`)}</ol>`;
}

module.exports = { money, dollars, shortDate, longDate, plural, joinAnd, cutoffText, termsFor, hm, clock, statusPill, demoBadge, budgetMeter, recipe, scorecard, stepsBar, fitBadge, hiddenParams, TRIP_STATUS };
