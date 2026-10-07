// The travel agent page: the conversation on the left, the live Trip Canvas on the right (the
// conversation first on phones, with a sticky total at the bottom). Every button is a form that says
// something to the agent, so the page works without JavaScript; /js/agent.js only polls the live
// regions while a search job runs and keeps the composer in place.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { money, dollars, longDate, plural, demoBadge, hiddenParams, fitBadge } = require('./common');
const { askedFor, memoriesContext, bookingBudget, vacationBudget, missionRules, LOCK_KEYS, LOCK_LABEL, experienceMode, protectedId, goalWords } = require('../../agent/state');
const { COMMANDS } = require('../../agent/agent');
const optimizer = require('../../trips/optimizer');
const { showWords } = require('../../trips/leaks');

const EXAMPLES = [
  'Build me the best beach trip under $1,500.',
  'I found this trip for $1,800. Can you beat it?',
  'I have $2,000 total. Keep $500 for spending after I arrive.',
  'I want 5 nights, nonstop, somewhere warm.',
  'I don’t care where. Pick the best trip my money can buy.',
];
const AFTER_BOOKING = ['What do I need to do next?', 'What if I cancel?', 'Can I extend one night?', 'Do I need a car?', 'What happens if my flight changes?', 'Can I afford a $200 excursion?'];

const sayForm = (id, say, label, cls = 'btn btn-ghost btn-sm', extra = '') => html`<form method="post" action="/agent/${id}" class="ag-say"><input type="hidden" name="say" value="${say}"><button class="${cls}" type="submit">${extra}${label}</button></form>`;

function tripLine(c) {
  return html`<div class="ag-trip">
    <img src="${c.image.url}" alt="" width="160" height="100" loading="lazy">
    <div class="ag-trip-body">
      <p class="ag-trip-title"><b>${plural(c.nights, 'night')} in ${c.dest}</b> <span>· ${longDate(c.depart)} – ${longDate(c.ret)} · ${plural(c.travelers, 'traveler')}</span></p>
      <p>${icon('plane')} ${c.flight.stops ? `${c.flight.stops}-stop` : 'Nonstop'} ${/nonstop/i.test(c.flight.name) ? '' : `${c.flight.name} `}flights · ${Math.floor(c.flight.minutes / 60)}h ${String(c.flight.minutes % 60).padStart(2, '0')}m each way</p>
      <p>${icon('bed')} ${c.hotel.name} · ${c.hotel.stars}-star${c.hotel.beachfront ? ' · beachfront' : ''}${c.hotel.allInclusive ? ' · all-inclusive' : c.hotel.breakfast ? ' · breakfast' : ''}</p>
      ${c.activities.length || c.transfer ? html`<p>${icon('flag')} ${[...c.activities, ...(c.transfer ? ['airport transfer'] : [])].join(' · ')}</p>` : ''}
      <p class="ag-trip-price"><b>${money(c.total)}</b> <span>all in · ${c.match}% match</span></p>
    </div>
  </div>`;
}

function diffCard(id, card) {
  return html`<div class="ag-card ag-diff">
    <div class="ag-diff-cols">
      <div><p class="tb-kicker">Before</p><p><b>${money(card.before.total)}</b></p><p class="tb-small">${card.before.summary}</p></div>
      <div><p class="tb-kicker">After</p><p><b>${money(card.after.total)}</b></p><p class="tb-small">${card.after.summary}</p></div>
    </div>
    ${card.improvements.length ? html`<p class="ag-up">${icon('trend')} <span>Better: ${card.improvements.join('; ')}</span></p>` : ''}
    ${card.tradeoffs.length ? html`<p class="ag-down">${icon('minus')} <span>Given up: ${card.tradeoffs.join('; ')}</span></p>` : ''}
    ${card.neutral.length ? html`<p class="ag-same">${icon('info')} <span>Different: ${card.neutral.join('; ')}</span></p>` : ''}
    ${card.lines ? html`<details class="ag-lines"><summary>Where the money moved</summary><ul>${card.lines.filter(l => l.delta).map(l => html`<li><span>${l.label}</span><b>${l.delta > 0 ? '+' : '−'}${money(Math.abs(l.delta))}</b></li>`)}</ul></details>` : ''}
  </div>`;
}

function proposalCard(id, p, { current, budget = null } = {}) {
  const over = p.over;
  // How far over the maximum: the version's priced total minus the ceiling (never its difference from the trip now,
  // which is what it costs, not what it goes over by).
  const by = !over ? 0 : budget ? Math.max(0, p.total - budget) : p.overBy || 0;
  return html`<div class="ag-card ag-proposal${over ? ' is-over' : ''}">
    <div class="ag-proposal-nums">
      <div><span>Now</span><b>${current ? money(current.total) : '—'}</b></div>
      <div><span>${p.label}</span><b>${money(p.total)}</b></div>
      <div><span>${p.delta <= 0 ? 'You keep' : 'Costs'}</span><b class="${p.delta <= 0 ? 'is-save' : 'is-add'}">${p.delta <= 0 ? '+' : ''}${money(Math.abs(p.delta))}</b></div>
    </div>
    ${p.improvements && p.improvements.length ? html`<p class="ag-up">${icon('trend')} <span>${p.improvements.join('; ')}</span></p>` : ''}
    ${p.tradeoffs && p.tradeoffs.length ? html`<p class="ag-down">${icon('minus')} <span>${p.tradeoffs.join('; ')}</span></p>` : ''}
    ${p.neutral && p.neutral.length ? html`<p class="ag-same">${icon('info')} <span>${p.neutral.join('; ')}</span></p>` : ''}
    ${over ? html`<p class="ag-over">${icon('alert')} <span>${by ? `${money(by)} over your ${budget ? `${money(budget)} ` : ''}ceiling` : 'Over your ceiling'}. Your maximum is a ceiling, not a target; only you can raise it.</span></p>` : ''}
    <div class="ag-actions">
      ${sayForm(id, over ? 'Go over' : 'Take it', over ? (by ? `Go over by ${money(by)}` : 'Go over') : 'Take it', 'btn btn-blue btn-sm')}
      ${sayForm(id, 'Keep what I have', p.delta > 0 ? `Keep the ${money(p.delta)}` : 'Keep what I have')}
      ${p.anyway ? sayForm(id, 'Do it anyway', `Do it anyway (${money(p.anyway.total)})`) : ''}
      ${p.alternative && p.alternative.total ? sayForm(id, 'Take the upgrade', `Take the upgrade instead (${money(p.alternative.total)})`) : ''}
    </div>
  </div>`;
}

function optionsCard(id, card, current) {
  return html`<div class="ag-card ag-options">
    <ul>${card.options.map((o, i) => html`<li class="${current && current.token === o.token ? 'is-current' : ''}">
      <p class="tb-kicker">${o.label}${o.over ? ' · needs the extra you allowed' : ''}</p>
      ${o.kind === 'lowest' && o.blurb ? html`<p class="ag-way-line">${o.blurb}</p>` : ''}
      ${tripLine(o)}
      ${o.upgrade ? html`<p class="tb-card-upgrade">${icon('sparkle')} +${money(o.upgrade.delta)} gets ${o.upgrade.gets}.</p>` : ''}
      <div class="ag-actions">${current && current.token === o.token ? html`<span class="tb-pill">On your canvas</span>` : sayForm(id, o.kind === 'upgrade' ? 'Take the upgrade' : o.kind === 'lowest' ? 'Take the lowest' : o.kind === 'save-more' ? 'Take save more' : 'Take our pick', o.kind === 'upgrade' ? 'Take the upgrade' : o.kind === 'lowest' ? 'Take the lowest' : `Take ${o.label.toLowerCase()}`, 'btn btn-navy btn-sm')}<a class="text-link" href="/trip/${o.token}">Full trip page ${icon('arrow')}</a></div>
    </li>`)}
    ${card.keepMoney && card.keepMoney.spare > 0 && !card.options.some(o => o.kind === 'upgrade') ? html`<li class="ag-keep"><p class="tb-kicker">Keep your money</p><p><b>${money(card.keepMoney.spare)}</b> stays with you: nothing I priced improved on our pick in a way worth its price.</p></li>` : ''}</ul>
  </div>`;
}

const FEEL = [['love this', 'Love this'], ['too expensive', 'Too expensive'], ['too short', 'Too short'], ['too far', 'Too far'], ['wrong vibe', 'Wrong vibe']];
const WAY_LINE = { more: 'The most vacation the money buys', keep: 'A strong trip well under the ceiling', special: 'Money spent only where it improves the trip' };

// Three meaningfully different ways to use one number, side by side: total, what stays with you,
// what makes each one different, one-tap reactions, and the single question.
function waysCard(id, c, current) {
  const n = i => i + 1;
  return html`<div class="ag-card ag-ways-card${c.compact ? ' is-compact' : ''}">
    ${c.saver ? html`<div class="ag-saver-nums"><div><span>Your max</span><b>${money(c.saver.max)}</b></div><div><span>We built it for</span><b>${money(c.saver.total)}</b><small>${c.saver.dest}</small></div><div class="is-keep"><span>You keep</span><b>${money(c.saver.keep)}</b><small>max minus the verified total</small></div></div>
    <div class="ag-actions ag-saver-actions">${sayForm(id, 'Take this trip', 'Take this trip', 'btn btn-blue btn-sm')}${sayForm(id, 'Find $100', 'Find $100 more')}${sayForm(id, 'How low can you go?', 'How low can you go?')}${sayForm(id, 'Same trip for less', 'Same trip for less')}</div>` : ''}
    ${c.saver ? html`<p class="tb-kicker">${c.ways.length === 1 ? 'The way to use the number' : `${c.ways.length === 3 ? 'Three' : 'Two'} ways to use the number`}</p>` : ''}
    <ol class="ag-ways">${c.ways.map((w, i) => html`<li class="ag-way${w.pick ? ' is-pick' : ''}${current && current.token === w.trip.token ? ' is-current' : ''}">
      <p class="ag-way-head"><span class="ag-way-num">${n(i)}</span><b>${w.label}</b>${w.pick ? html`<span class="tb-pill">I'd pick this</span>` : ''}</p>
      <p class="ag-way-line">${WAY_LINE[w.key] || ''}</p>
      ${tripLine(w.trip)}
      <div class="ag-way-nums"><div><span>Total</span><b>${money(w.trip.total)}</b></div><div class="${w.keep >= 0 ? 'is-keep' : 'is-over'}"><span>${w.keep >= 0 ? 'Keep' : 'Over'}</span><b>${money(Math.abs(w.keep))}</b></div></div>
      ${w.differs && w.differs.length ? html`<p class="ag-way-diff">${icon('info')} <span>${w.differs.join('; ')}</span></p>` : ''}
      ${w.pick && w.why && w.why.length ? html`<p class="ag-up">${icon('trend')} <span>${w.why.slice(0, 2).join('; ')}</span></p>` : ''}
      ${c.compact ? '' : html`<div class="ag-chips ag-way-feel">${FEEL.map(([say, label]) => sayForm(id, `${n(i)}: ${say}`, label, 'ag-chip ag-chip-sm'))}</div>`}
      <p class="ag-actions"><a class="text-link" href="/trip/${w.trip.token}">Full trip page ${icon('arrow')}</a></p>
    </li>`)}</ol>
    <p class="ag-ways-q"><b>Which feels more like you?</b> <span class="tb-muted">Your answer steers this trip only; nothing is saved unless you ask.</span></p>
    <div class="ag-actions">${c.ways.map((w, i) => sayForm(id, String(n(i)), `${n(i)} · ${w.label}`, 'btn btn-navy btn-sm'))}${sayForm(id, 'None — try again', 'None, try again')}</div>
  </div>`;
}

// The direction pushed: three real versions beside the chosen trip, pick one or mix them.
function variantsCard(id, c, current) {
  return html`<div class="ag-card ag-variants-card">
    <p class="tb-kicker">Pushing that direction · beside ${c.chosen.dest} at ${money(c.chosen.total)}</p>
    <ol class="ag-ways ag-variants">${c.variants.map(v => html`<li class="ag-way${current && current.token === v.trip.token ? ' is-current' : ''}">
      <p class="ag-way-head"><span class="ag-way-num">${v.letter}</span><b>${v.label}</b></p>
      ${tripLine(v.trip)}
      <div class="ag-way-nums"><div><span>Total</span><b>${money(v.trip.total)}</b></div><div class="${v.keep >= 0 ? 'is-keep' : 'is-over'}"><span>${v.keep >= 0 ? 'Keep' : 'Over'}</span><b>${money(Math.abs(v.keep))}</b></div></div>
      ${v.changes.improvements.length ? html`<p class="ag-up">${icon('trend')} <span>${v.changes.improvements.join('; ')}</span></p>` : ''}
      ${v.changes.tradeoffs.length ? html`<p class="ag-down">${icon('minus')} <span>${v.changes.tradeoffs.join('; ')}</span></p>` : ''}
      <p class="ag-actions">${sayForm(id, `Pick ${v.letter}`, `Pick ${v.letter}`, 'btn btn-navy btn-sm')}<a class="text-link" href="/trip/${v.trip.token}">Full trip page ${icon('arrow')}</a></p>
    </li>`)}</ol>
    ${c.missing && c.missing.length ? html`<p class="ag-same">${icon('info')} <span>Not offered: ${c.missing.join('; ')}.</span></p>` : ''}
    <div class="ag-actions">${c.variants.length > 1 && c.mixable !== false ? sayForm(id, c.pair ? `The hotel from ${c.pair[0]} with the flights from ${c.pair[1]}` : 'Mix them', c.pair ? `Hotel from ${c.pair[0]}, flights from ${c.pair[1]}` : 'Mix them') : ''}${sayForm(id, 'Keep what I have', 'Keep what I have')}</div>
    ${c.variants.length > 1 && c.mixable === false ? html`<p class="tb-small tb-muted">These cannot be mixed into one trip: they are in different places or on different dates, so each stands on its own.</p>` : html`<p class="tb-small tb-muted">Mixing: say which pieces, like “the hotel from C with the flight from A”. I rebuild it as one package and re-check the live total${c.variants.length > 1 ? ', and a mix over your ceiling is only said, never applied' : ''}.</p>`}
  </div>`;
}

// Every destination checked: what beat one of the three ways, as what stays the same, what gets
// better and what it costs, beside the trip it replaces.
function beatCard(id, c, current) {
  return html`<div class="ag-card ag-beat">
    <p class="tb-kicker">${icon('trend')} Beats Option ${c.n} · ${c.label}</p>
    ${tripLine(c.after)}
    <div class="ag-beat-cols">
      <div><span>Same</span>${c.same && c.same.length ? html`<ul>${c.same.map(x => html`<li>${x}</li>`)}</ul>` : html`<p class="tb-muted">A different shape; see the lines above</p>`}</div>
      <div class="is-better"><span>Better</span>${c.better && c.better.length ? html`<ul>${c.better.map(x => html`<li>${x}</li>`)}</ul>` : html`<p class="tb-muted">Nothing changes but the price</p>`}</div>
      <div class="${c.delta < 0 ? 'is-less' : c.delta > 0 ? 'is-more' : ''}"><span>Price</span><b>${c.delta < 0 ? `${money(-c.delta)} less` : c.delta > 0 ? `${money(c.delta)} more` : 'The same'}</b><small>${money(c.after.total)} total${c.before ? ` against ${money(c.before.total)}` : ''}</small></div>
    </div>
    ${c.neutral && c.neutral.length ? html`<p class="ag-same">${icon('info')} <span>Also different: ${c.neutral.join('; ')}.</span></p>` : ''}
    <div class="ag-actions">${current && current.token === c.after.token ? html`<span class="tb-pill">On your canvas</span>` : sayForm(id, String(c.n), `Take Option ${c.n}`, 'btn btn-navy btn-sm')}<a class="text-link" href="/trip/${c.after.token}">Full trip page ${icon('arrow')}</a></div>
  </div>`;
}

// Today's prices for the same trip on other departure dates: the cheapest strong week first, each
// window a verified total, and the range the priced windows really cover. Never a forecast.
function weeksCard(id, c, current) {
  const sign = d => (d < 0 ? `${money(-d)} less` : d > 0 ? `${money(d)} more` : 'same price');
  return html`<div class="ag-card ag-weeks${c.compact ? ' is-compact' : ''}">
    <p class="tb-kicker">${c.compact ? 'Cheapest strong week' : 'When can you go for less?'} · today's prices, not a forecast</p>
    <ol class="ag-weeks-list">
      <li class="is-current"><span class="ag-week-dates">${longDate(c.current.depart)} – ${longDate(c.current.ret)}</span><b>${money(c.current.total)}</b><small>on your canvas</small></li>
      ${c.windows.map(w => html`<li class="${w.over ? 'is-over' : ''}">${w.letter ? html`<span class="ag-way-num">${w.letter}</span>` : ''}<span class="ag-week-dates">${longDate(w.depart)} – ${longDate(w.ret)}</span><b>${money(w.total)}</b><small class="${w.delta < 0 ? 'is-save' : w.delta > 0 ? 'is-add' : ''}">${sign(w.delta)}${w.sameDates ? ' · your dates' : ''}${w.changed ? ` · ${w.changed}` : `${w.hotelChanged ? ' · different hotel, same class' : ''}${w.flightChanged ? ' · different flights' : ''}`}${w.over ? ' · over your ceiling' : ''}</small>${w.letter ? sayForm(id, `Option ${w.letter}`, w.sameDates ? 'Take this version' : `Leave ${longDate(w.depart)}`, 'btn btn-ghost btn-sm') : ''}</li>`)}
    </ol>
    <p class="tb-small tb-muted">${c.range && c.range.count > 1 ? `The ${plural(c.range.count, 'window')} priced run ${money(c.range.min)} to ${money(c.range.max)}. ` : ''}${plural(c.datesSearched, 'departure date')} priced in full${c.truncated ? '; the pass was cut off before every date was priced' : ''}. ${c.honesty || ''}</p>
    ${c.compact ? '' : html`<div class="ag-actions">${sayForm(id, 'Keep my dates', 'Keep my dates', 'btn btn-navy btn-sm')}</div>`}
  </div>`;
}

// The hunt on the conversation, compact: the persistent card's facts from the record (my travel money,
// status, the best current opportunity, what it keeps), the receipt when a decision was made, and the
// answers. Keep waiting is always there and never pressured; Not good enough asks what to improve;
// See trip opens the priced trip. Nothing here is urgent, scarce or predicted. The numbers are the
// check the card was said with (stamped); the status and the answers follow the record as it is now
// (`live`, read by the route), so a hunt stopped from its own page is not offered "keep waiting" here.
function huntCard(id, c, { live = null } = {}) {
  const h = c.hunt, best = h.best, o = h.opportunity;
  const status = live && live.id === h.id ? live.status : h.status;
  const hunting = status === 'hunting';
  return html`<div class="ag-card ag-hunt">
    <div class="ag-canvas-head"><p class="tb-kicker">My travel money · ${h.name}</p><span class="hu-status is-${hunting ? 'hunting' : 'stopped'}">${hunting ? 'HUNTING' : 'STOPPED'}</span></div>
    <div class="ag-saver-nums">
      <div><span>My travel money</span><b>${money(h.budget)}</b><small>a ceiling, not a target</small></div>
      <div><span>Best current opportunity</span><b>${best ? money(best.total) : '—'}</b><small>${best ? `${plural(best.nights, 'night')} in ${best.dest}${h.checked ? `, as checked ${h.checked}` : best.recorded ? ', as last checked' : ''}` : h.underRules && h.checked ? `nothing qualifies, as checked ${h.checked}` : 'not checked under these rules yet'}</small></div>
      <div class="${best ? 'is-keep' : ''}"><span>Potential money kept</span><b>${best ? money(h.kept) : '—'}</b><small>${best ? 'limit minus the total that check verified' : ''}</small></div>
    </div>
    ${o && o.receipt ? html`<details class="ag-lines"><summary>Why you’re seeing this</summary>
      <div class="ag-contract-cols"><div><p class="tb-kicker">Your rules</p><ul class="tb-list tb-small">${(o.receipt.rules || []).map(l => html`<li>${l}</li>`)}</ul></div><div><p class="tb-kicker">Found</p><ul class="tb-list tb-small">${(o.receipt.found || []).map(l => html`<li>${l}</li>`)}</ul></div></div>
      <p class="tb-small"><b>Why I interrupted you:</b> ${o.receipt.why}</p></details>` : ''}
    <div class="ag-actions">
      ${best ? html`<a class="btn btn-navy btn-sm" href="/trip/${best.token}?${optimizer.contextParams({ budget: h.budget })}">See trip ${icon('arrow')}</a>` : ''}
      ${hunting ? html`<form method="post" action="/hunts/${h.id}/respond" class="ag-say"><input type="hidden" name="action" value="keep-waiting"><button class="btn btn-ghost btn-sm" type="submit">Keep waiting</button></form>` : ''}
      ${hunting && best ? sayForm(id, 'Not good enough', 'Not good enough') : ''}
      <a class="text-link" href="/hunts/${h.id}">The hunt: every check and what it learned ${icon('arrow')}</a>
    </div>
  </div>`;
}

// ---- the money leak hunter's cards -------------------------------------------------------------
// Every number on these cards is leaks.js's (a priced version of the trip); every button says
// something to the agent, and nothing is removed or preselected on the page itself.
const KIND_WORD = { core: 'Flights and stay', mandatory: 'Mandatory', optional: 'Optional', discount: 'Discount' };
function breakdownCard(c) {
  return html`<div class="ag-card ag-breakdown">
    <p class="tb-kicker">What you're paying for · ${money(c.total)} in all</p>
    <table class="ag-receipt-table"><tbody>
      ${c.rows.map(r => html`<tr><td>${r.label}${r.note ? html` <small class="tb-muted">· ${r.note}</small>` : ''}</td><td class="ag-tag-cell"><span class="ag-tag is-${r.kind}">${KIND_WORD[r.kind]}</span></td><td class="ag-num">${r.amount < 0 ? '−' : ''}${money(Math.abs(r.amount))}</td></tr>`)}
      <tr class="ag-receipt-final"><td>Flights and stay</td><td></td><td class="ag-num">${money(c.coreTotal)}</td></tr>
      <tr><td>Taxes, mandatory fees and the service fee</td><td></td><td class="ag-num">${money(c.mandatoryTotal)}</td></tr>
      <tr><td>Optional extras</td><td></td><td class="ag-num">${money(c.optionalTotal)}</td></tr>
      <tr class="ag-receipt-final"><td>Total, everything included</td><td></td><td class="ag-num">${money(c.total)}</td></tr>
    </tbody></table>
    <p class="tb-small tb-muted">No mystery line items: every row is in the total, and nothing is added later.</p>
  </div>`;
}
// Each item priced back alone onto the lean version, with the verdict from what the traveler said.
function addBackList(id, items, { chips }) {
  return html`<ul class="ag-addback">${items.map(a => html`<li><div><b>+${money(a.cost)}</b> ${a.label} <span class="ag-tag is-${a.verdict}">${a.verdict === 'worth' ? 'Worth considering' : `I'd keep the ${money(a.cost)}`}</span><small>${a.why}</small></div>${chips ? sayForm(id, `Add back ${a.label}`, 'Add back', 'btn btn-ghost btn-sm') : ''}</li>`)}</ul>`;
}
function leanCard(id, c) {
  return html`<div class="ag-card ag-lean">
    <p class="tb-kicker">Strip it down</p>
    <div class="ag-proposal-nums"><div><span>Current</span><b>${money(c.current.total)}</b></div><div><span>Lean</span><b>${money(c.lean.total)}</b></div><div><span>Difference</span><b class="${c.difference > 0 ? 'is-save' : ''}">${money(c.difference)}</b></div></div>
    ${c.givesUp.length ? html`<p class="ag-down">${icon('minus')} <span>What you give up: ${c.givesUp.join('; ')}</span></p>` : html`<p class="ag-same">${icon('info')} <span>Nothing optional is in this price: it is already the lean version.</span></p>`}
    <p class="ag-same">${icon('check')} <span>Kept: ${c.kept.join('; ')}</span></p>
    ${c.notKept && c.notKept.length ? html`<p class="ag-down">${icon('alert')} <span>Not met by this trip: ${c.notKept.join('; ')}</span></p>` : ''}
    ${c.difference > 0 ? html`<p class="tb-small"><b>Customer decides.</b></p><div class="ag-actions">${sayForm(id, 'Take the lean version', `Take the lean version (${money(c.lean.total)})`, 'btn btn-navy btn-sm')}${sayForm(id, 'Keep what I have', 'Keep what I have')}</div>` : ''}
    ${c.addBack && c.addBack.length ? html`<p class="tb-kicker">Add back what's worth it</p>${addBackList(id, c.addBack, { chips: true })}<p class="tb-small tb-muted">Each is priced alone onto the lean version; the verdict comes from what you told me, never from our margin.</p>` : ''}
  </div>`;
}
function leakCard(id, c) {
  return html`<div class="ag-card ag-leak">
    <p class="tb-kicker">Biggest avoidable cost</p>
    <p><b>${c.label}</b></p>
    <div class="ag-proposal-nums"><div><span>Current</span><b>${money(c.current)}</b></div><div><span>${c.alternativeLabel}</span><b>${money(c.alternative)}</b></div><div><span>Potential difference</span><b class="is-save">${money(c.difference)}</b></div></div>
    ${c.tradeoff ? html`<p class="ag-down">${icon('minus')} <span>It changes: ${c.tradeoff}</span></p>` : ''}
    ${c.differs && c.differs.length ? html`<p class="ag-same">${icon('info')} <span>${c.tradeoff ? 'It also differs' : 'No trade-off by the facts; what differs'}: ${c.differs.join('; ')}</span></p>` : c.tradeoff ? '' : html`<p class="ag-up">${icon('check')} <span>Nothing else changes: no trade-off by the facts.</span></p>`}
    ${c.note ? html`<p class="tb-small">${c.note}</p>` : ''}
    <div class="ag-actions">${sayForm(id, `Show me ${showWords(c)}`, `Show me ${showWords(c)}`, 'btn btn-navy btn-sm')}</div>
    <p class="tb-small tb-muted">Nothing comes out until you take that version.</p>
  </div>`;
}
const SCAN_WORD = { ok: 'OK', found: 'Found', na: 'Not compared' };
function scanCard(id, c) {
  return html`<div class="ag-card ag-scan">
    <p class="tb-kicker">Money leak check</p>
    <ul class="ag-scan-list">${c.checks.map(k => html`<li class="is-${k.status}"><span class="ag-tag is-${k.status}">${SCAN_WORD[k.status]}</span><div><b>${k.label}</b><small>${k.text}</small></div></li>`)}</ul>
    <p class="ag-scan-done"><b>${c.text}</b></p>
    ${c.found && !c.kept ? html`<div class="ag-actions">${sayForm(id, 'Remove it', `Remove ${money(c.found.amount)}`, 'btn btn-navy btn-sm')}${sayForm(id, 'Keep it', 'Keep it')}</div>` : c.found ? html`<p class="tb-small tb-muted">You chose to keep it, so it is not proposed again.</p>` : ''}
  </div>`;
}
function cutCard(c) {
  return html`<div class="ag-card ag-cut">
    <p class="tb-kicker">Cut it in order · target ${money(c.target)} · ${c.reached ? 'reached' : 'not reached'}</p>
    ${c.steps.length ? html`<table class="ag-receipt-table"><thead><tr><th>Stage</th><th>What changed</th><th class="ag-num">Saving</th><th class="ag-num">Running total</th></tr></thead><tbody>${c.steps.map(st => html`<tr><td>${st.stageLabel}</td><td>${st.label}${st.givesUp.filter(g => !st.label.includes(g)).length ? html` <small class="tb-muted">· gives up ${st.givesUp.filter(g => !st.label.includes(g)).join('; ')}</small>` : ''}</td><td class="ag-num is-save">−${money(st.saving)}</td><td class="ag-num">${money(st.after)}</td></tr>`)}</tbody></table>` : html`<p class="tb-small">No step was taken.</p>`}
    ${c.skipped.length ? html`<details class="ag-lines"><summary>Not touched (${c.skipped.length})</summary><ul>${c.skipped.map(k => html`<li><span>${k.stageLabel}</span><small class="tb-muted">${k.why}</small></li>`)}</ul></details>` : ''}
    <p class="tb-small tb-muted">The order is fixed: ${c.order.join(' → ')}. Rules and locks are never relaxed.</p>
  </div>`;
}
function freeCard(id, c) {
  return html`<div class="ag-card ag-free">
    <div class="ag-contract-cols">
      <div><p class="tb-kicker">Free savings · nothing given up</p>${c.free ? html`<b class="ag-howlow-num">${money(c.free.total)}</b><small class="tb-muted">${money(-c.free.delta)} less than now</small>${c.free.differs && c.free.differs.length ? html`<p class="ag-same">${icon('info')} <span>Differs: ${c.free.differs.join('; ')}</span></p>` : ''}<ul class="tb-list tb-small">${c.free.same.map(x => html`<li>${x}</li>`)}</ul><div class="ag-actions">${sayForm(id, 'Take the free savings', 'Take the free savings', 'btn btn-navy btn-sm')}</div>` : html`<p class="tb-small tb-muted">None priced: no version of this trip is cheaper with nothing given up, by the facts.</p>`}</div>
      <div><p class="tb-kicker">Trade-off savings · something given up</p>${c.sacrifice ? html`<b class="ag-howlow-num">${money(c.sacrifice.total)}</b><small class="tb-muted">${money(-c.sacrifice.delta)} less than now</small><p class="ag-down">${icon('minus')} <span>But: ${c.sacrifice.but.join('; ')}</span></p><div class="ag-actions">${sayForm(id, 'Take the trade-off version', 'Take the trade-off version')}</div>` : html`<p class="tb-small tb-muted">None priced below ${c.free ? 'the free version' : 'what you have'}.</p>`}</div>
    </div>
    <p class="tb-small tb-muted">Two separate things, never one number: a free saving gives nothing up by the facts; a trade-off saving says what it costs you.</p>
  </div>`;
}
const SCORE_TOTALS = ['max', 'current', 'notUsed', 'over'];
function scorecardCard(c) {
  return html`<div class="ag-card ag-scorecard">
    <p class="tb-kicker">Your savings check</p>
    <table class="ag-receipt-table"><tbody>${c.lines.map(l => html`<tr class="${SCORE_TOTALS.includes(l.key) ? 'ag-receipt-final' : ''}"><td>${l.label}</td><td class="ag-num ${l.key === 'over' ? 'is-add' : SCORE_TOTALS.includes(l.key) ? '' : l.amount >= 0 ? 'is-save' : 'is-add'}">${money(l.amount)}</td></tr>`)}</tbody></table>
    ${c.note ? html`<p class="tb-small tb-muted">${c.note}</p>` : ''}
  </div>`;
}
const LEAK_CHIPS = ['What am I paying for?', 'Strip it down', 'Find my biggest leak', 'Money leak check'];

// ---- Experience Max cards ----------------------------------------------------------------------
// Every amount on these cards is the experience engine's: a priced total for a token, or the
// difference between two. Every button says something to the agent; nothing is applied, removed or
// preselected on the page itself, and a free thing is shown only with its source and checked date.
const sgn = d => `${d < 0 ? '−' : '+'}${money(Math.abs(d))}`;
const withProposal = (id, c, current, budget = null) => (c.proposal && c.proposal.token && c.proposal.total !== null ? proposalCard(id, c.proposal, { current, budget }) : '');
// The chips the canvas offers in Experience Max, each one sentence the agent understands.
const X_CHIPS = ['Hotel or experience?', 'Make $100 memorable', 'Give me one amazing thing', 'Pack the trip', 'Find free things worth doing', 'Surprise me with one thing', 'Give me more free time', 'Same feeling for less', 'Find an alternative experience', 'Experience ladder', 'Trade something for this', 'One big memory or more things to do?', 'Plan my days', 'Your experience budget', 'What if it rains?', 'Surprise me completely'];
const X_SAY = { memories: 'More memories', pick: 'Our pick', comfort: 'More comfort' };

// EXPERIENCE MAX RESULTS: MORE MEMORIES / OUR PICK ★ / MORE COMFORT, the reason sentence and the
// version the pick passed on, each picked by its name.
function xwaysCard(id, c, current) {
  const on = w => !!(current && current.token === w.trip.token);
  return html`<div class="ag-card ag-ways-card ag-xways">
    <p class="tb-kicker">Experience Max results · ${c.goals}</p>
    ${c.signature ? html`<p class="ag-x-signature"><b>${c.signature}</b></p>` : ''}
    <ol class="ag-ways">${c.ways.map((w, i) => html`<li class="ag-way${w.star ? ' is-pick' : ''}${on(w) ? ' is-current' : ''}">
      <p class="ag-way-head"><span class="ag-way-num">${i + 1}</span><b>${w.label}${w.star ? ' ★' : ''}</b>${on(w) ? html`<span class="tb-pill">On your canvas</span>` : ''}</p>
      ${w.blurbs && w.blurbs.length ? html`<p class="ag-way-line">${w.blurbs.join(' · ')}</p>` : ''}
      ${tripLine(w.trip)}
      <div class="ag-way-nums"><div><span>Total</span><b>${money(w.total)}</b></div>${w.keep !== null && w.keep !== undefined ? html`<div class="${w.keep >= 0 ? 'is-keep' : 'is-over'}"><span>${w.keep >= 0 ? 'Keep' : 'Over'}</span><b>${money(Math.abs(w.keep))}</b></div>` : ''}</div>
      ${w.main ? html`<p class="ag-same">${icon('flag')} <span>Main experience: ${w.main}</span></p>` : ''}
      <p class="ag-actions">${on(w) ? '' : sayForm(id, X_SAY[w.key] || w.label, `Take ${(X_SAY[w.key] || w.label).toLowerCase()}`, 'btn btn-navy btn-sm')}<a class="text-link" href="/trip/${w.trip.token}">Full trip page ${icon('arrow')}</a></p>
    </li>`)}</ol>
    <p class="tb-small"><b>Why:</b> ${c.reason}</p>
    ${c.rejected ? html`<p class="ag-down">${icon('minus')} <span>Rejected: ${c.rejected.label}${c.rejected.gets && c.rejected.gets.length ? ` (${c.rejected.gets.join('; ')})` : ''}, ${money(c.rejected.total)}. ${c.rejected.text}</span></p>` : ''}
    ${c.dropped && c.dropped.length ? html`<p class="ag-same">${icon('info')} <span>Not built: ${c.dropped.join('; ')}</span></p>` : ''}
    ${c.notes && c.notes.length ? html`<p class="tb-small tb-muted">${c.notes.join(' ')}</p>` : ''}
    <p class="ag-ways-q"><b>${c.onCanvas ? 'Which feels more like you?' : 'Pick one to put it on your canvas, or keep what you have.'}</b> <span class="tb-muted">Spend on the memories, not the labels.</span></p>
    ${c.onCanvas ? html`<div class="ag-actions">${sayForm(id, 'None — try again', 'None of these: ask me again')}</div>` : ''}
  </div>`;
}

// Two priced versions side by side (HOTEL OR EXPERIENCE?, ONE BIG MEMORY vs MORE THINGS TO DO,
// LOCATION): each side's total, its difference from the trip, and the words that take it.
function abCard(id, c) {
  // A side over the maximum is shown with its amount and is never "my pick": the maximum is a ceiling, not a target.
  const pick = x => c.verdict === x.key && !x.over;
  const col = x => (x ? html`<div class="${pick(x) ? 'is-pick' : ''}">
      <p class="tb-kicker">${x.head || x.key.toUpperCase()}${pick(x) ? ' · my pick' : ''}</p>
      <p><b>${x.label}</b></p>
      ${x.lines && x.lines.length ? html`<ul class="tb-list tb-small">${x.lines.filter(Boolean).map(l => html`<li>${l}</li>`)}</ul>` : ''}
      <p><b>${money(x.total)}</b> <small class="tb-muted">${x.own ? x.ownText || 'your hotel now' : sgn(x.delta)}${overWords(x)}</small></p>
      ${x.say ? html`<div class="ag-actions">${sayForm(id, x.say, x.say, 'btn btn-navy btn-sm')}</div>` : ''}
    </div>` : html`<div><p class="tb-small tb-muted">Not priced for this trip.</p></div>`);
  return html`<div class="ag-card ag-ab">
    <p class="tb-kicker">${c.title}</p>
    <div class="ag-contract-cols">${col(c.a)}${col(c.b)}</div>
    ${c.text ? html`<p class="tb-small">${c.text}</p>` : ''}
    ${c.proposal ? html`<div class="ag-actions">${sayForm(id, 'Keep what I have', 'Keep what I have')}</div>` : ''}
  </div>`;
}

// The words a lettered button sends: its letter and its version's own label ("Option C: An airport
// transfer"), so an older card's button never takes whatever another card put on the table since.
const optionSay = it => it.say || `Option ${it.letter}: ${it.label}`;
// Over the maximum, said with the amount (the version's priced total minus the ceiling) whenever the card carries it.
const overWords = x => (x.over ? ` · ${x.overBy ? `${money(x.overBy)} ` : ''}over your ceiling` : '');
// A lettered list of priced versions: each one's difference, what it gives up, its total, and its button.
// A signed amount in the engine's words ("−$68.12", "+$104") stays on one line: wrapped in .ag-amt (white-space:
// nowrap), so a narrow phone column never leaves the sign alone at the end of a line and the amount on the next.
const SIGNED_AMOUNT = /([−+–-]\s?\$[\d,]+(?:\.\d{2})?)/;
const amounts = t => String(t ?? '').split(SIGNED_AMOUNT).map((part, i) => (i % 2 ? html`<span class="ag-amt">${part}</span>` : part));
function xversions(id, items) {
  return html`<ol class="ag-bp-list ag-x-list">${items.map(it => html`<li class="${it.current ? 'is-current' : ''}"><span class="ag-way-num">${it.letter || '·'}</span><div><b class="ag-amt">${it.delta !== undefined ? sgn(it.delta) : money(it.total)}</b> <span>${amounts(it.label)}</span>${it.text && it.text !== it.label ? html`<small>${amounts(it.text)}</small>` : ''}${it.differences && it.differences.length ? html`<small>Differs: ${amounts(it.differences.join('; '))}</small>` : ''}${it.givesUp && it.givesUp.length ? html`<small class="ag-down">Gives up: ${amounts(it.givesUp.join('; '))}</small>` : ''}<small>${money(it.total)} total${it.gain ? ` · experience score +${it.gain}` : ''}${overWords(it)}${it.pick && !it.over ? ' · my pick' : ''}</small></div>${it.letter ? sayForm(id, optionSay(it), 'Take it', 'btn btn-ghost btn-sm') : html`<span></span>`}</li>`)}</ol>`;
}
// A free thing is never booked or priced: it is named only with the guide's source and the date checked.
function xfreeList(items) {
  return html`<ul class="tb-list tb-small">${items.map(f => html`<li><b>${f.name}</b>${f.note ? html` · ${f.note}` : ''}${f.goal ? html` · ${f.goal}` : ''} <span class="tb-muted">(free according to ${f.source}, as of ${longDate(f.checkedAt)})</span></li>`)}</ul>`;
}

function memoryCard(id, c, current, budget = null) {
  return html`<div class="ag-card ag-memory">
    <p class="tb-kicker">${c.title}</p>
    ${c.items.length ? xversions(id, c.items) : html`<p class="tb-small tb-muted">No paid version is priced in that range.</p>`}
    ${c.free && c.free.length ? html`<p class="tb-kicker">Free, nothing to book</p>${xfreeList(c.free)}` : ''}
    ${withProposal(id, c, current, budget)}
  </div>`;
}

function moreCard(id, c) {
  return html`<div class="ag-card ag-more">
    <p class="tb-kicker">${c.title} · now ${money(c.current)}</p>
    ${c.items.length ? xversions(id, c.items) : html`<p class="tb-small tb-muted">Nothing ${c.zeroMore ? `at or under ${money(c.current)} ` : ''}makes this trip more memorable by what you told me with nothing given up.</p>`}
    ${c.trades && c.trades.length ? html`<p class="tb-kicker">Each of these gives something up</p>${xversions(id, c.trades)}` : ''}
    ${c.things && c.things.length ? html`<p class="tb-kicker">Free, nothing to book</p>${xfreeList(c.things)}` : ''}
    ${c.zeroMore ? html`<p class="tb-small tb-muted">Every version listed here is at or under your current total.</p>` : ''}
    ${c.items.length || (c.trades && c.trades.length) ? html`<div class="ag-actions">${sayForm(id, 'Keep what I have', 'Keep what I have')}</div>` : ''}
  </div>`;
}

function xmenuCard(id, c) {
  return html`<div class="ag-card ag-menu">
    <p class="tb-kicker">${c.title}</p>
    ${c.items.length ? xversions(id, c.items) : html`<p class="tb-small tb-muted">No version is priced.</p>`}
    ${c.note ? html`<p class="tb-small tb-muted">${c.note}</p>` : ''}
  </div>`;
}

// The traveler's own event day (BUILD AROUND AN EVENT) is marked as theirs: labelled "Event day" by the rhythm, with the
// event among its items and no experience on it unless the two cannot overlap.
function xdays(days) {
  return html`<ol class="ag-bp-list ag-x-days">${days.map(d => html`<li${d.event ? raw(' class="is-event" data-event="1"') : ''}><span class="ag-way-num">${d.n}</span><div><b>${d.label}</b> <small>${longDate(d.date)}${d.items && d.items.length ? ` · ${d.items.join(', ')}` : ''}</small></div><span></span></li>`)}</ol>`;
}
function xconflicts(id, conflicts) {
  return html`${conflicts.map(k => html`<div class="ag-x-conflict"><p class="ag-down">${icon('alert')} <span>${k.text}</span></p>${k.fixes.length ? html`<ul class="tb-list tb-small">${k.fixes.map(f => html`<li>${f.letter ? html`<b>${f.letter}</b> · ` : ''}${f.text}${f.letter ? sayForm(id, f.say || `Option ${f.letter}: ${f.text}`, 'Take this fix', 'btn btn-ghost btn-sm') : ''}</li>`)}</ul>` : ''}</div>`)}`;
}
// THE RHYTHM: a suggested rhythm, not a schedule; conflicts with their priced fixes by letter.
function rhythmCard(id, c) {
  return html`<div class="ag-card ag-rhythm">
    <p class="tb-kicker">The rhythm · ${plural(c.openDays, 'open day')} · a suggestion, not a schedule</p>
    ${xdays(c.days)}
    ${c.conflicts && c.conflicts.length ? xconflicts(id, c.conflicts) : ''}
    ${c.scheduled ? html`<p class="ag-same">${icon('info')} <span>This itinerary is very scheduled: ${c.scheduled.join('; ')}.</span></p><div class="ag-actions">${sayForm(id, 'Give me more free time', 'Give me more free time')}</div>` : ''}
    ${c.text ? html`<p class="tb-small tb-muted">${c.text}</p>` : ''}
  </div>`;
}

// EXPERIENCE PROTECTION: what was re-checked and what still needs verification, never hidden. Laid out as the pages'
// PROTECTION table (tb-mem-protect): three columns where there is room; on a phone each row stacks (trips.css:
// .ag-protect-table), the check and its status on one line and what we know under it, so "What we know" is never
// squeezed to a word a line. The roles keep it a table for screen readers when the rows are laid out as blocks.
const PROTECT_LABEL = { availability: 'Availability', operating: 'Operating days', age: 'Age requirements', restrictions: 'Current restrictions', meeting: 'Meeting location', duration: 'Duration', cancellation: 'Cancellation', transport: 'Transport' };
function protectionCard(id, c) {
  const ok = r => r.verified === true || r.known === true;
  return html`<div class="ag-card ag-protection">
    <p class="tb-kicker">${c.protected ? 'Main experience 🔒 protected' : 'Experience protection'} · ${c.name}</p>
    ${c.rows && c.rows.length ? html`<table class="ag-receipt-table ag-protect-table" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Check</th><th scope="col" role="columnheader">What we know</th><th scope="col" role="columnheader" class="ag-num">Status</th></tr></thead><tbody role="rowgroup">${c.rows.map(r => html`<tr role="row" class="${ok(r) ? 'is-ok' : 'is-verify'}" data-key="${r.key}"><td role="cell">${PROTECT_LABEL[r.key] || r.key.charAt(0).toUpperCase() + r.key.slice(1)}</td><td role="cell">${r.value}</td><td role="cell" class="ag-num">${ok(r) ? 'Verified' : 'Needs verification'}</td></tr>`)}</tbody></table>` : ''}
    ${c.reasons && c.reasons.length ? html`<p class="tb-kicker">The best day${c.day ? ` · day ${c.day.n}, ${longDate(c.day.date)}` : ''}</p><ul class="tb-list tb-small">${c.reasons.map(r => html`<li>${r.ok ? '✓' : '·'} ${r.text}</li>`)}</ul>` : ''}
    ${c.weather ? html`<p class="tb-small">${c.weather}</p>` : ''}
    ${c.checkedAt ? html`<p class="tb-small tb-muted">Re-checked ${longDate(c.checkedAt)}. I never build around an unverified experience.</p>` : ''}
    ${c.protected ? html`<div class="ag-actions">${sayForm(id, 'Unprotect', 'Unprotect')}</div>` : ''}
  </div>`;
}

// WHY THIS TRIP IS BUILT THIS WAY: each line the difference between two priced versions.
function xreceiptCard(c) {
  const row = (l, cls, sign) => html`<tr><td>${l.label}</td><td class="ag-num ${cls}">${sign}${money(l.amount)}</td></tr>`;
  return html`<div class="ag-card ag-receipt ag-xreceipt">
    <p class="tb-kicker">Why this trip is built this way</p>
    <p class="tb-small"><b>${c.goal}</b></p>
    <table class="ag-receipt-table"><tbody>
      ${c.lessOn.length ? html`<tr class="ag-receipt-final"><td>We spent less on</td><td></td></tr>${c.lessOn.map(l => row(l, 'is-save', '−'))}` : ''}
      ${c.usedFor.length ? html`<tr class="ag-receipt-final"><td>We used money for</td><td></td></tr>${c.usedFor.map(l => row(l, 'is-add', '+'))}` : ''}
      <tr class="ag-receipt-final"><td>Final</td><td class="ag-num">${money(c.final)}</td></tr>
      ${c.max !== null && c.max !== undefined ? html`<tr><td>Your max</td><td class="ag-num">${money(c.max)}</td></tr><tr class="ag-receipt-keep"><td>${c.keep >= 0 ? 'Keep' : 'Over'}</td><td class="ag-num">${money(Math.abs(c.keep))}</td></tr>` : ''}
    </tbody></table>
    <p class="tb-small tb-muted">Against ${c.baseline.label} (${money(c.baseline.total)}).</p>
  </div>`;
}

// EXPERIENCE LADDER with the MEMORY SWEET SPOT: where more money stops buying memories.
function ladderCard(id, c) {
  return html`<div class="ag-card ag-ladder">
    <p class="tb-kicker">Experience ladder${c.sweet && c.sweet.total !== null && c.sweet.total !== undefined ? ` · memory sweet spot ${money(c.sweet.total)}` : ''}</p>
    <ol class="ag-bp-list ag-x-list">${c.rungs.map(r => html`<li class="${r.current ? 'is-current' : ''}"><span class="ag-way-num">${r.letter || '·'}</span><div><b>${money(r.total)}</b> <span>${r.label}</span><small>${r.dest}${r.gain ? ` · experience score +${r.gain}` : ''}${c.sweet && r.total === c.sweet.total ? ' · memory sweet spot' : ''}${r.current ? ' · your trip' : ''}</small></div>${r.letter ? sayForm(id, r.say || `Option ${r.letter}: ${r.label} (${r.dest})`, 'Take it', 'btn btn-ghost btn-sm') : html`<span></span>`}</li>`)}
      ${c.top ? html`<li><span class="ag-way-num">·</span><div><b>${money(c.top.total)}</b> <small>${c.top.text}</small></div><span></span></li>` : ''}</ol>
    ${c.sweet ? html`<p class="tb-small"><b>${c.sweet.text}</b>${c.sweet.reasons && c.sweet.reasons.length ? ` ${c.sweet.reasons.join(' · ')}` : ''}</p>` : ''}
  </div>`;
}

// YOUR EXPERIENCE BUDGET: the trip's own price lines; the downsell is two buttons, neither preselected.
function allocationCard(id, c) {
  return html`<div class="ag-card ag-allocation">
    <p class="tb-kicker">Your experience budget</p>
    <table class="ag-receipt-table"><tbody>${c.lines.map(l => html`<tr><td>${l.label}</td><td class="ag-num">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</td></tr>`)}
      <tr class="ag-receipt-final"><td>Total</td><td class="ag-num">${money(c.total)}</td></tr>
      ${c.keep !== null && c.keep !== undefined ? html`<tr class="ag-receipt-keep"><td>${c.keep >= 0 ? 'Keep' : 'Over'}${c.max ? ` of your ${money(c.max)}` : ''}</td><td class="ag-num">${money(Math.abs(c.keep))}</td></tr>` : ''}</tbody></table>
    ${c.text ? html`<p class="tb-small">${c.text}</p>` : ''}
    ${c.downsell ? html`<p class="ag-up">${icon('trend')} <span>${c.downsell.hotel} saves ${money(c.downsell.saved)}, for ${c.downsell.experience}${c.proposal ? `: ${money(c.proposal.total)} in all (${sgn(c.proposal.delta)})` : ''}.</span></p><div class="ag-actions">${sayForm(id, c.downsell.say, c.downsell.say, 'btn btn-navy btn-sm')}${sayForm(id, 'Keep the hotel', 'Keep the hotel')}</div>` : ''}
  </div>`;
}

// TRADE SOMETHING FOR THIS: what goes in, what comes out, and the new total beside the current one.
function tradeCard(id, c) {
  return html`<div class="ag-card ag-trade">
    <p class="tb-kicker">Trade something for this</p>
    <table class="ag-receipt-table"><tbody>
      ${c.add ? html`<tr><td>${c.add.label} in</td><td class="ag-num is-add">+${money(c.add.amount)}</td></tr>` : ''}
      ${c.remove.map(r => html`<tr><td>${r.label} out</td><td class="ag-num is-save">−${money(r.amount)}</td></tr>`)}
      <tr class="ag-receipt-final"><td>New total</td><td class="ag-num">${money(c.total)}</td></tr>
      <tr><td>Now</td><td class="ag-num">${money(c.current)}</td></tr>
    </tbody></table>
    <div class="ag-actions">${sayForm(id, 'Make the trade', 'Make the trade', 'btn btn-navy btn-sm')}${sayForm(id, 'Keep what I have', 'Keep what I have')}</div>
  </div>`;
}

function xfreeCard(id, c, current, budget = null) {
  return html`<div class="ag-card ag-xfree">
    <p class="tb-kicker">Free things worth doing · ${c.dest}</p>
    ${xfreeList(c.items.map(it => ({ ...it, source: c.source, checkedAt: c.checkedAt })))}
    ${withProposal(id, c, current, budget)}
  </div>`;
}

function onebigCard(id, c, current, budget = null) {
  return html`<div class="ag-card ag-onebig">
    <p class="tb-kicker">One amazing thing · ${c.main}</p>
    ${c.trip ? tripLine(c.trip) : ''}
    ${c.days && c.days.length ? xdays(c.days) : ''}
    ${c.protection && c.protection.length ? html`<ul class="tb-list tb-small">${c.protection.map(r => html`<li>${r.key}: ${r.value}${r.verified === true || r.known === true ? '' : ' (needs verification)'}</li>`)}</ul>` : ''}
    ${withProposal(id, c, current, budget)}
  </div>`;
}

// FINAL EXPERIENCE CHECK before the contract: each reason the check passed or did not.
function finalCard(id, c, current, budget = null) {
  return html`<div class="ag-card ag-final">
    <p class="tb-kicker">Final experience check · ${c.ok ? 'passed' : 'not passed'}</p>
    <ul class="tb-list tb-small">${c.reasons.map(r => html`<li>${r.ok ? '✓' : '✗'} ${r.text}</li>`)}</ul>
    ${withProposal(id, c, current, budget)}
  </div>`;
}

function card(id, m, { current, hunt = null, budget = null }) {
  const c = m.card;
  if (!c) return '';
  switch (c.kind) {
    case 'breakdown': return breakdownCard(c);
    case 'lean': return leanCard(id, c);
    case 'addback': return html`<div class="ag-card ag-lean"><p class="tb-kicker">${c.onLean ? 'Add back what\'s worth it' : 'What each optional item is worth'}</p>${addBackList(id, c.items, { chips: !!c.onLean })}${c.onLean ? '' : html`<div class="ag-actions">${sayForm(id, 'Strip it down', 'Strip it down', 'btn btn-ghost btn-sm')}</div>`}</div>`;
    case 'leak': return leakCard(id, c);
    case 'scan': return scanCard(id, c);
    case 'cut': return cutCard(c);
    case 'free': return freeCard(id, c);
    case 'scorecard': return scorecardCard(c);
    case 'hunt': return huntCard(id, c, { live: hunt });
    case 'ask': return html`<div class="ag-actions${c.chips ? ' ag-chips' : ''}">${c.options.map(o => sayForm(id, o.say, o.label, c.chips ? 'ag-chip' : 'btn btn-ghost btn-sm'))}</div>`;
    case 'xways': return xwaysCard(id, c, current);
    case 'ab': return abCard(id, c);
    case 'memory': return memoryCard(id, c, current, budget);
    case 'more': return moreCard(id, c);
    case 'menu': return xmenuCard(id, c);
    case 'ladder': return ladderCard(id, c);
    case 'xreceipt': return xreceiptCard(c);
    case 'allocation': return allocationCard(id, c);
    case 'trade': return tradeCard(id, c);
    case 'rhythm': return rhythmCard(id, c);
    case 'collision': return html`<div class="ag-card ag-collision"><p class="tb-kicker">Schedule conflicts</p>${xconflicts(id, c.conflicts)}</div>`;
    case 'protection': return protectionCard(id, c);
    case 'xfree': return xfreeCard(id, c, current, budget);
    case 'onebig': return onebigCard(id, c, current, budget);
    case 'final': return finalCard(id, c, current, budget);
    case 'trip': return html`<div class="ag-card${c.over ? ' is-over' : ''}">${c.label ? html`<p class="tb-kicker">${c.label}</p>` : ''}${tripLine(c.trip)}${c.first ? html`<p class="ag-still">${icon('search')} <span>This is currently the trip to beat. Still checking whether I can get you more vacation or better quality without spending more.</span></p>` : ''}<div class="ag-actions">${c.first ? html`${sayForm(id, 'I like this one', 'I like this', 'btn btn-navy btn-sm')}${sayForm(id, 'Keep building', 'Keep building')}` : ''}<a class="text-link" href="/trip/${c.trip.token}">Full trip page ${icon('arrow')}</a></div></div>`;
    case 'options': return html`${optionsCard(id, c, current)}${c.final ? html`<div class="ag-actions">${sayForm(id, 'Book it', 'Verify & book', 'btn btn-blue btn-sm')}${sayForm(id, 'Challenge it again', 'Challenge it again')}</div>` : ''}`;
    case 'ways': return waysCard(id, c, current);
    case 'howlow': return html`<div class="ag-card ag-howlow">
      <div class="ag-howlow-cols">
        <div><p class="tb-kicker">Lowest I would recommend</p><b class="ag-howlow-num">${money(c.recommend.total)}</b>${c.recommend.total < c.current ? html`<small>${money(c.current - c.recommend.total)} less than now</small>` : html`<small>what you have</small>`}
          ${c.recommend.changes.neutral.length || c.recommend.changes.improvements.length ? html`<p class="ag-same">${icon('info')} <span>${[...c.recommend.changes.neutral, ...c.recommend.changes.improvements].join('; ')}</span></p>` : ''}
          ${c.recommend.changes.tradeoffs.length ? html`<p class="ag-down">${icon('minus')} <span>${c.recommend.changes.tradeoffs.join('; ')}</span></p>` : ''}</div>
        <div>${c.cheapest ? html`<p class="tb-kicker">Absolute cheapest found</p><b class="ag-howlow-num">${money(c.cheapest.total)}</b><small>${money(c.current - c.cheapest.total)} less than now</small><p class="tb-kicker">Why I don't recommend it</p><ul class="tb-list tb-small">${c.cheapest.whyNot.map(w => html`<li>${w}</li>`)}</ul>` : html`<p class="tb-kicker">Absolute cheapest found</p><p class="tb-small tb-muted">Nothing cheaper than the recommended version was priced with your rules${c.locks && c.locks.length ? ` and locks (${c.locks.join(', ')})` : ''}.</p>`}</div>
      </div>
      <div class="ag-actions">${c.recommend.total < c.current ? sayForm(id, 'Take the recommended version', `Take ${money(c.recommend.total)}`, 'btn btn-navy btn-sm') : ''}${c.cheapest ? sayForm(id, 'Take the cheapest', `Take ${money(c.cheapest.total)} anyway`) : ''}${sayForm(id, 'Keep what I have', 'Keep what I have')}</div>
      ${c.truncated ? html`<p class="tb-small tb-muted">Not every version could be priced in this pass; the numbers above are from the ones that were.</p>` : ''}
    </div>`;
    case 'breakpoints': return html`<div class="ag-card ag-breakpoints">
      <p class="tb-kicker">Where money starts buying something · from ${money(c.base)}, up to ${money(c.max)}</p>
      <ol class="ag-bp-list">${c.items.map(b => html`<li><span class="ag-way-num">${b.letter}</span><div><b>+${money(b.delta)}</b> <span>${b.gets}${b.also.length ? html` <small class="tb-muted">and ${b.also.join(', ').toLowerCase()}</small>` : ''}</span><small>${money(b.total)} total · nothing given up</small></div>${sayForm(id, `Option ${b.letter}`, 'Take it', 'btn btn-ghost btn-sm')}</li>`)}</ol>
      <div class="ag-actions">${sayForm(id, 'Keep the money', 'Keep the money', 'btn btn-navy btn-sm')}</div>
    </div>`;
    case 'receipt': return html`<div class="ag-card ag-receipt">
      <p class="tb-kicker">How we kept your cost down</p>
      <table class="ag-receipt-table"><tbody>
        <tr><td>Started at</td><td class="ag-num">${money(c.original)}</td></tr>
        ${c.lines.map(l => html`<tr><td>${l.label}</td><td class="ag-num ${l.delta <= 0 ? 'is-save' : 'is-add'}">${l.delta <= 0 ? '−' : '+'}${money(Math.abs(l.delta))}</td></tr>`)}
        <tr class="ag-receipt-final"><td>Now</td><td class="ag-num">${money(c.final)}</td></tr>
        ${c.keep !== null ? html`<tr class="ag-receipt-keep"><td>You keep of your ${money(c.max)}</td><td class="ag-num">${money(c.keep)}</td></tr>` : c.over ? html`<tr class="ag-receipt-over"><td>Over your ${money(c.max)}, which you approved</td><td class="ag-num">${money(c.over)}</td></tr>` : ''}
      </tbody></table>
      <p class="tb-small tb-muted">Each line is one version's priced total minus the one before it: sequential, nothing counted twice, no market “savings”.</p>
    </div>`;
    case 'variants': return variantsCard(id, c, current);
    case 'beat': return beatCard(id, c, current);
    case 'weeks': return weeksCard(id, c, current);
    case 'decision': return html`<div class="ag-card ag-decision">
      <p class="tb-kicker">One decision away · ${c.trip.dest}, ${plural(c.trip.nights, 'night')}</p>
      <div class="ag-decision-opts">${c.options.map(o => html`<form method="post" action="/agent/${id}" class="ag-say"><input type="hidden" name="say" value="Option ${o.letter}: ${o.label}"><button class="ag-decision-btn" type="submit"><span class="ag-way-num">${o.letter}</span><b>${o.label}</b><small>${money(o.total)} total, everything included</small></button></form>`)}</div>
      <p class="ag-ways-q"><b>Which matters more?</b> <span class="tb-muted">Both are priced and verified; I don't pick this one for you. Your answer steers this trip only.</span></p>
    </div>`;
    case 'switch': return html`<div class="ag-card ag-switch">
      <p class="tb-kicker">I beat my first option</p>
      <div class="ag-proposal-nums"><div><span>First</span><b>${money(c.first.total)}</b></div><div><span>Better</span><b>${money(c.better.total)}</b></div><div><span>${c.better.total <= c.first.total ? 'You keep' : 'Costs'}</span><b class="${c.better.total <= c.first.total ? 'is-save' : 'is-add'}">${c.better.total <= c.first.total ? '+' : ''}${money(Math.abs(c.first.total - c.better.total))}</b></div></div>
      ${tripLine(c.better)}
      ${c.proposal.improvements.length ? html`<p class="ag-up">${icon('trend')} <span>${c.proposal.improvements.join('; ')}</span></p>` : ''}
      ${c.proposal.tradeoffs.length ? html`<p class="ag-down">${icon('minus')} <span>${c.proposal.tradeoffs.join('; ')}</span></p>` : ''}
      ${c.proposal.neutral.length ? html`<p class="ag-same">${icon('info')} <span>${c.proposal.neutral.join('; ')}</span></p>` : ''}
      <div class="ag-actions">${sayForm(id, 'Switch to the better option', 'Switch to the better option', 'btn btn-blue btn-sm')}${sayForm(id, 'Keep the first one', 'Keep the first one')}</div>
    </div>`;
    case 'proposal': return proposalCard(id, c.proposal, { current, budget });
    case 'diff': return diffCard(id, c);
    case 'facts': return html`<div class="ag-card">${c.title ? html`<p class="tb-kicker">${c.title}</p>` : ''}<ul class="tb-list">${c.items.map(i => html`<li>${i}</li>`)}</ul>${c.href ? html`<p><a class="text-link" href="${c.href}">${c.label} ${icon('arrow')}</a></p>` : ''}</div>`;
    case 'link': return html`<p class="ag-actions"><a class="btn btn-ghost btn-sm" href="${c.href}">${c.label} ${icon('arrow')}</a></p>`;
    case 'commands': return html`<div class="ag-actions ag-chips">${c.items.map(t => sayForm(id, t, t, 'ag-chip'))}</div>`;
    case 'verdict': return html`<div class="ag-card ag-verdict is-${c.state}">
      <p class="ag-verdict-head">${c.state === 'beat' ? 'We beat it' : c.state === 'tradeoff' ? 'A different trade-off' : c.state === 'info' ? 'We need more information' : 'Your deal wins'}</p>
      <div class="ag-proposal-nums"><div><span>Their price</span><b>${money(c.theirs)}</b></div>${c.ours ? html`<div><span>Our version</span><b>${money(c.ours.total)}</b></div><div><span>${c.ours.total <= c.theirs ? 'Stays with you' : 'Ours costs more by'}</span><b class="${c.ours.total <= c.theirs ? 'is-save' : 'is-add'}">${money(Math.abs(c.theirs - c.ours.total))}</b></div>` : ''}</div>
      ${c.ours ? tripLine(c.ours) : ''}
      ${c.unknowns && c.unknowns.length ? html`<p class="ag-same">${icon('info')} <span>Unknown about their trip: ${c.unknowns.join(', ')}. No win is claimed with unknowns.</span></p>` : ''}
      <div class="ag-actions"><a class="btn btn-ghost btn-sm" href="${c.href}">Full comparison, line by line ${icon('arrow')}</a>${c.ours && c.state !== 'keep' ? sayForm(id, 'Take the challenger', 'Put it on my canvas', 'btn btn-navy btn-sm') : ''}</div>
    </div>`;
    case 'contract': return html`<div class="ag-card ag-contract">
      <div class="ag-contract-cols">
        <div><p class="tb-kicker">You asked for</p><dl>${c.asked.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl></div>
        <div><p class="tb-kicker">You are getting</p><dl>${c.getting.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl></div>
      </div>
      ${c.unmet.length ? html`<p class="ag-down">${icon('alert')} <span>Not as asked: ${c.unmet.join('; ')}.</span></p>` : html`<p class="ag-up">${icon('check')} <span>Everything you asked for is in this trip.</span></p>`}
      <div class="ag-actions"><a class="btn btn-blue" href="${c.href}">Check the final price and book ${icon('arrow')}</a></div>
      <p class="tb-small tb-muted">Nothing is charged here. The next page re-checks the price, shows every term, and you confirm.</p>
    </div>`;
    case 'relax': return html`<div class="ag-card ag-relax">
      ${c.closest ? html`<p class="tb-kicker">Closest, over budget</p>${tripLine(c.closest)}` : ''}
      <p class="tb-kicker">One change gets there</p>
      <ul class="ag-relax-list">${c.works.map(w => html`<li><form method="post" action="/agent/${id}" class="ag-say"><input type="hidden" name="say" value="${w.say}"><button class="btn btn-ghost btn-sm" type="submit">${w.label}</button></form><span>${w.dest}, ${plural(w.nights, 'night')} · <b>${money(w.total)}</b>${w.over ? ` (${money(w.over)} over)` : ''}</span></li>`)}</ul>
      <p class="ag-actions">${sayForm(id, 'Watch for an exact match', 'Watch for an exact match')}</p>
    </div>`;
    default: return '';
  }
}

function feed(job, { open = false } = {}) {
  if (!job.feed || !job.feed.length) return '';
  return html`<details class="ag-feed" ${open ? raw('open') : ''}><summary>What I checked (${job.feed.length})</summary><ul>${job.feed.map(f => html`<li>${icon('check')} <span>${f}</span></li>`)}</ul></details>`;
}

function progress(job, { mission = null } = {}) {
  if (!job) return '';
  const secs = ms => (ms === null ? '' : `${(ms / 1000).toFixed(1)} s`);
  if (job.status !== 'running') {
    const done = job.steps.filter(s => s.status === 'done');
    const last = done[done.length - 1];
    return html`<p class="ag-progress-done tb-small tb-muted">${icon(job.status === 'cancelled' ? 'close' : 'check')} ${job.status === 'cancelled' ? 'Search stopped.' : `Searched ${job.considered.toLocaleString('en-US')} complete packages${job.destinations ? ` across ${plural(job.destinations, 'destination')}` : ''} in ${secs(last ? last.ms : null)}.`}${job.firstAtMs !== null ? ` First match at ${secs(job.firstAtMs)}.` : ''}${job.bestAtMs !== null && job.improved ? ` Better one at ${secs(job.bestAtMs)}.` : ''}</p>${feed(job)}`;
  }
  return html`<div class="ag-progress-wrap">${mission ? html`<p class="ag-progress-head">Your ${money(mission)} is building…</p>` : ''}<ol class="ag-progress" aria-live="polite" aria-label="Search progress">${job.steps.map(s => html`<li class="is-${s.status}"><span class="ag-step-dot"></span><span class="ag-step-text"><b>${s.label}</b>${s.detail ? html`<small>${s.detail}</small>` : ''}</span>${s.ms !== null && s.status !== 'pending' ? html`<span class="ag-step-ms">${secs(s.ms)}</span>` : ''}</li>`)}</ol>${feed(job, { open: true })}</div>`;
}

// The hunt the page shows: the record as the route read it now (`hunt`, with its live status and
// summary), else what the conversation last saw of it. A stopped hunt is no "Hunting" status and no
// link in the hunt's place; the chip to start (or resume) one comes back.
const huntOf = (s, hunt) => (hunt !== undefined ? hunt : (s.mission ? s.mission.hunt : s.hunt) || null);
const huntingOf = (s, hunt) => { const h = huntOf(s, hunt); return h && h.status !== 'stopped' ? h : null; };

function chat(ctx, s, { canvas, hunt }) {
  const running = !!(s.job && s.job.status === 'running');
  const current = s.current;
  const live = huntOf(s, hunt);
  return html`<div id="live-chat" data-live="chat" data-running="${running ? '1' : '0'}">
    <ol class="ag-messages">
      ${s.messages.length ? '' : html`<li class="ag-msg is-agent"><div class="ag-bubble"><p>What do you want your trip to do? Tell me the budget, who is going, where you fly from, and anything that must be true. I search, compare and price; you decide.</p></div></li>`}
      ${s.messages.map(m => html`<li class="ag-msg is-${m.role}"><div class="ag-bubble"><p>${m.text}</p>${m.role === 'agent' ? card(s.id, m, { current, hunt: live, budget: bookingBudget(s) }) : ''}</div></li>`)}
    </ol>
    ${progress(s.job, { mission: s.mission ? bookingBudget(s) : null })}
  </div>`;
}

// WHAT WAS ACTUALLY WORTH IT? after the trip (the service says when it is open): one chip per answer,
// each one sentence to the agent. The answer stays on this booking; only a "yes" to "Remember this
// for next time?" from the signed-in owner puts it on the account, so nothing here is preselected.
// Where the answer is kept, as the service decided it (`defaults`), and what became of an answer this
// booking left on the account before (`earlier`): a booking made without an account belongs to none.
function worthKept(a) {
  if (a.defaults === 'saved') return `Remembered on your account, as you asked${a.earlier === 'replaced' ? '; it replaced the earlier answer from this booking' : ''}.`;
  if (a.defaults === 'guest') return 'Kept on this booking only: it was made without an account, so there is no account to remember it on.';
  return `Kept on this booking only${a.earlier === 'removed' ? '; the earlier answer remembered from it was removed from your account' : a.earlier === 'kept' ? '; an earlier answer from it is still remembered on the account that booked it' : ''}.`;
}
function worthItBlock(s, w) {
  if (!w || (!w.ask && !w.answered)) return '';
  const a = w.answered;
  return html`<div class="ag-worth">
    <p class="tb-kicker">WHAT WAS ACTUALLY WORTH IT?</p>
    ${a ? html`<p class="tb-small">${a.worth && a.worth.length ? html`<b>Worth it:</b> ${a.worth.join(', ')}. ` : ''}${a.notWorth && a.notWorth.length ? html`<b>Not worth it:</b> ${a.notWorth.join(', ')}. ` : ''}<span class="tb-muted">${worthKept(a)}</span></p>` : ''}
    ${w.ask ? html`<div class="ag-chips">${w.chips.map(c => sayForm(s.id, `Worth it: ${c}`, `Worth it: ${c}`, 'ag-chip'))}</div><div class="ag-chips">${w.chips.map(c => sayForm(s.id, `Not worth it: ${c}`, `Not worth it: ${c}`, 'ag-chip ag-chip-sm'))}</div>` : ''}
  </div>`;
}

// After booking, the canvas is the agent's home for that trip: today, next, status, money, the next
// reservation and the actions that matter, each from the booking's own facts.
function homePanel(ctx, s, home) {
  const dot = st => html`<span class="ag-step-dot is-${st}" aria-hidden="true"></span>`;
  return html`<div id="live-canvas" data-live="canvas"><div class="ag-canvas-head"><p class="tb-kicker">Your trip · ${home.ref}</p>${demoBadge(ctx.tripService.demo, 'Demo booking')}</div>
    <dl class="ag-home-grid">
      <div><dt>Today</dt><dd><b>${home.today.title}</b><small>${home.today.detail}</small></dd></div>
      <div><dt>Next</dt><dd><b>${home.next.title}</b><small>${home.next.detail}</small></dd></div>
      <div><dt>Trip status</dt><dd><b>${home.status.title}</b><small>${home.status.detail}</small></dd></div>
      <div><dt>Remaining trip money</dt><dd><b>${home.remaining.title}</b><small>${home.remaining.detail}</small></dd></div>
      <div class="ag-home-wide"><dt>Next reservation</dt><dd><b>${home.reservation.title}</b><small>${home.reservation.detail}</small></dd></div>
    </dl>
    ${home.victory ? html`<div class="ag-victory">
      <p class="tb-kicker">Your savings</p>
      <div class="ag-saver-nums"><div><span>You gave us</span><b>${money(home.victory.gave)}</b><small>${home.victory.reserve ? `as your maximum: ${money(home.victory.forBooking)} for the booking, ${money(home.victory.reserve)} protected` : 'as your maximum'}</small></div><div><span>Your trip</span><b>${money(home.victory.trip)}</b><small>everything included</small></div>${home.victory.kept !== null ? html`<div class="is-keep"><span>You kept</span><b>${money(home.victory.kept)}</b><small>${home.victory.reserve ? `of the booking's ${money(home.victory.forBooking)}; the ${money(home.victory.reserve)} you protected is untouched` : 'max minus the booked total'}</small></div>` : html`<div class="is-over"><span>You went over by</span><b>${money(home.victory.over)}</b><small>${home.victory.reserve ? `the booking's ${money(home.victory.forBooking)}, which you approved` : 'which you approved'}</small></div>`}</div>
      ${home.victory.kept !== null && home.victory.keptRules.length ? html`<p class="tb-small"><b>And you kept:</b> ${home.victory.keptRules.join(' · ')}</p>` : ''}
      ${home.victory.notKept.length ? html`<p class="ag-down">${icon('alert')} <span>Not kept: ${home.victory.notKept.join('; ')}</span></p>` : ''}
    </div>` : ''}
    <p class="tb-kicker">Important actions</p>
    ${home.actions.length ? html`<ul class="ag-home-actions">${home.actions.map(a => html`<li>${dot(a.status)}<span>${a.text}</span></li>`)}</ul>` : html`<p class="tb-small tb-muted">Nothing is due from you.</p>`}
    <div class="ag-chips ag-home-asks">${AFTER_BOOKING.map(c => sayForm(s.id, c, c, 'ag-chip'))}</div>
    ${worthItBlock(s, home.worthIt)}
    <p class="ag-canvas-foot"><a class="text-link" href="${home.bookingHref}">The booking page: every confirmation, every term ${icon('arrow')}</a></p>
  </div>`;
}

// The mission on the canvas: what the agent is building, its status, and what it is optimizing
// (hard rules, preferences, what it is free to change), from the conversation's facts.
function missionPanel(ctx, s, { canvas, hunt: huntIn }) {
  if (!s.mission) return '';
  const booking = bookingBudget(s);
  const running = !!(s.job && s.job.status === 'running');
  const o = s.origin ? ctx.tripService.inv.maps.getOrigin(s.origin) : null;
  // A hunt on the account: the mission's status is the hunt's, by name, while it hunts, with what it
  // found that nobody has seen yet; but a search running here or a decision waiting on the canvas
  // comes first, since that is what the traveler is being asked about now.
  const hunt = huntingOf(s, huntIn);
  const fresh = hunt && hunt.summary && hunt.summary.newOpportunities ? ` · ${plural(hunt.summary.newOpportunities, 'new find')}` : '';
  // Only a status the conversation's state bears out: a version the traveler took from a proposal ("Take it", "Take the
  // rebuild", a lettered option) is their choice, so once it is on the canvas the status says what is there, never that the
  // results are still waiting for one. It stands while that version is on the canvas and no new results were built since.
  // The amount is the canvas's own total, priced now, so the status and the canvas never show two numbers for one trip.
  const tk = s.mission.taken, taken = tk && canvas && canvas.trip && s.current && tk.token === s.current.token && canvas.token === tk.token && tk.round === s.mission.round ? tk : null;
  const status = running ? 'Building…' : s.proposal ? 'One decision away' : hunt ? `Hunting: ${hunt.name}${fresh}` : taken ? `Your choice is on the canvas: ${taken.label ? `${taken.label} · ` : ''}${money(canvas.trip.total)}` : s.mission.strategies && s.mission.strategies.length && !s.mission.signal ? `${plural(s.mission.strategies.length, 'way')} built, waiting for which feels like you` : canvas ? 'A trip to beat is on the canvas' : s.pending === 'origin' ? 'Waiting for where you fly from' : 'Waiting for the budget';
  const rules = missionRules(s, { maps: ctx.tripService.inv.maps });
  // Experience Max: what they want to remember, and the main experience no version drops on a plain
  // approval, with the words that free it (the protection is the traveler's to lift, never the page's).
  // The name is set off from the sentence about it, and every word the traveler can say is quoted one way
  // in this panel (“drop …”, “unprotect”, “lock the hotel”), the rules list included (state.missionRules). The name is bold
  // at the sentence's own size (the size is set once, on the paragraph), so every line of it is spaced the same.
  const xmax = experienceMode(s), px = protectedId(s);
  return html`<div class="ag-mission">
    <div class="ag-mission-head"><div><p class="tb-kicker">Your mission${xmax ? ' · Experience Max' : ''}</p><b class="ag-mission-title">${xmax ? `The most experience${booking ? ` from ${money(booking)}` : ' from your budget'}` : `Build the best vacation${booking ? ` for ${money(booking)}` : ''}`}</b></div><span class="ag-mission-status${running ? ' is-running' : ''}">${status}</span></div>
    <dl class="ag-mission-facts"><div><dt>Budget</dt><dd>${booking ? `${money(booking)} max` : 'not set'}</dd></div><div><dt>Travelers</dt><dd>${s.travelers ? plural(s.travelers, 'traveler') : 'open'}</dd></div><div><dt>From</dt><dd>${o ? o.city : 'not set'}</dd></div>${xmax ? html`<div class="ag-mission-wide"><dt>What you want to remember</dt><dd>${s.goals && s.goals.length ? goalWords(s.goals) : 'not asked yet'}</dd></div>` : ''}</dl>
    ${px ? html`<div class="ag-protected"><p class="tb-kicker">MAIN EXPERIENCE 🔒 PROTECTED</p><p class="tb-small ag-protected-line"><b>${s.mainName || s.mainExperience}</b>: <span class="tb-muted">${s.protectAuto ? 'I protected it from the results' : 'protected, as you asked'}; no version I offer drops it unless you say “drop ${s.mainName || 'it'}”; say “unprotect” to free it.</span></p>${sayForm(s.id, 'Unprotect', 'Unprotect', 'btn btn-ghost btn-sm')}</div>` : ''}
    <details class="ag-mission-rules"><summary>What are you optimizing?</summary>
      <div class="ag-mission-cols">
        <div><p class="tb-kicker">Hard rules</p>${rules.locked.length ? html`<ul>${rules.locked.map(r => html`<li>${icon('lock')} <span>${r}</span></li>`)}</ul>` : html`<p class="tb-small tb-muted">Only the budget ceiling.</p>`}</div>
        <div><p class="tb-kicker">Preferences</p>${rules.preferred.length ? html`<ul>${rules.preferred.map(r => html`<li>${icon('trend')} <span>${r}</span></li>`)}</ul>` : html`<p class="tb-small tb-muted">None yet.</p>`}</div>
        <div><p class="tb-kicker">Free to change</p>${rules.open.length ? html`<ul>${rules.open.map(r => html`<li>${icon('sliders')} <span>${r}</span></li>`)}</ul>` : ''}</div>
      </div>
      <p class="tb-small tb-muted">Say “lock the hotel”, “only nonstop” or “try Europe” and this list changes; I never relax a hard rule on my own.</p>
    </details>
  </div>`;
}

// The live draft while the first trip is being built: each component with its real state, never a
// blank loading screen and never a value the suppliers have not returned.
function draftRows(ctx, s) {
  const job = s.job;
  const step = k => (job.steps.find(x => x.key === k) || {}).status;
  const booking = bookingBudget(s);
  const fastOn = step('fast') === 'running' || step('fast') === 'done', deepOn = step('deep') === 'running';
  const st = (state, text) => html`<span class="ag-draft-state is-${state}">${text}</span>`;
  const searching = (what, dest) => (fastOn || deepOn ? st('searching', what) : st('pending', 'Waiting'));
  return html`<ul class="ag-draft">
    <li><span>Budget</span><b>${booking ? `${money(booking)} max` : '—'}</b>${booking ? st('verified', 'Understood') : st('needs', 'Needs input')}</li>
    <li><span>Destination</span><b>${s.dest ? ctx.tripService.inv.maps.getDestination(s.dest).name : deepOn ? 'All destinations' : 'Comparing'}</b>${searching('Comparing')}</li>
    <li><span>Flight</span><b>${s.flightStops === 'nonstop' ? 'Nonstop' : 'Any'}</b>${searching('Finding')}</li>
    <li><span>Hotel</span><b>${s.hotelRules.minStars ? `${s.hotelRules.minStars}-star or better` : 'Any that fits'}</b>${searching('Matching')}</li>
    <li><span>Trip length</span><b>${s.nights ? plural(s.nights, 'night') : 'Open'}</b>${s.nights ? st('verified', 'Your rule') : searching('Optimizing')}</li>
    <li><span>Total</span><b>—</b>${searching('Calculating')}</li>
  </ul>`;
}

function budgetSlider(s, booking) {
  if (!booking || !s.mission) return '';
  const lo = Math.max(20000, Math.floor(booking * 2 / 3 / 5000) * 5000), hi = Math.ceil(booking * 4 / 3 / 5000) * 5000;
  return html`<form class="ag-slider" method="post" action="/agent/${s.id}" data-slider>
    <label for="ag-budget-range">Try a different ceiling <output for="ag-budget-range" data-slider-out>${money(booking)}</output></label>
    <input id="ag-budget-range" name="budget" type="range" min="${dollars(lo).replace(/[^\d]/g, '')}" max="${dollars(hi).replace(/[^\d]/g, '')}" step="50" value="${dollars(booking).replace(/[^\d]/g, '')}" data-current="${dollars(booking).replace(/[^\d]/g, '')}">
    <div class="ag-slider-ends"><span>${money(lo)}</span><span>${money(hi)}</span></div>
    <button class="btn btn-ghost btn-sm" type="submit" data-slider-btn>Rebuild at this ceiling</button>
    <p class="tb-small tb-muted">I say what the extra money really buys, or how the same trip keeps fitting under less. Nothing is downgraded silently.</p>
  </form>`;
}

function canvasPanel(ctx, s, canvas, { hunt: huntIn } = {}) {
  if (canvas && canvas.home) return homePanel(ctx, s, canvas.home);
  const booking = bookingBudget(s), vacation = vacationBudget(s);
  // The protected experience has its own line on the mission panel, so it is not listed as a lock.
  const locks = LOCK_KEYS.filter(k => k !== 'experience' && s.locks[k]);
  const lock = k => (s.locks[k] ? html`<span class="ag-lock" title="Locked">${icon('lock')}</span>` : '');
  const running = !!(s.job && s.job.status === 'running');
  const saver = !!(s.mission && s.mission.mode === 'save');
  const xmax = experienceMode(s);
  // Hunt mode on the saver's canvas: the chip starts a hunt; once one hunts, its name links to it.
  const hunt = s.mission ? huntingOf(s, huntIn) : null;
  const head = html`<div class="ag-canvas-head"><p class="tb-kicker">${saver && canvas ? 'You told us your max. We found your minimum.' : 'Your trip'}</p>${demoBadge(ctx.tripService.demo, 'Demo inventory')}</div>`;
  if (!canvas) {
    const rows = askedFor(s, { maps: ctx.tripService.inv.maps });
    return html`<div id="live-canvas" data-live="canvas">${head}${missionPanel(ctx, s, { canvas, hunt: huntIn })}
      ${running ? html`<p class="ag-empty">Building your trip. Each line fills in as prices come back; the first strong trip lands here.</p>${draftRows(ctx, s)}` : html`<p class="ag-empty">${s.mission ? 'Nothing built yet. Give me the number, and where you fly from, and I do the rest.' : 'Nothing built yet. Tell me what you want your trip to do.'}</p>`}
      ${rows.length && !running ? html`<dl class="ag-known">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ''}
    </div>`;
  }
  const t = canvas.trip;
  const cx = optimizer.contextParams(canvas.ctx);
  return html`<div id="live-canvas" data-live="canvas">${head}${missionPanel(ctx, s, { canvas, hunt: huntIn })}
    <div class="ag-canvas-nums">
      <div><span>Budget${s.budgetType === 'vacation' ? ' for the trip' : ''}</span><b>${booking ? money(booking) : '—'}</b><small>${booking ? 'a ceiling, not a target' : 'not set'}</small></div>
      <div><span>Total, everything included</span><b>${money(t.total)}</b><small>${running ? 'current winner · still searching' : `${money(t.perTraveler)} per traveler`}</small></div>
      <div class="${booking && t.total > booking ? 'is-over' : 'is-keep'}"><span>${booking ? (t.total > booking ? 'Over by' : 'You keep') : 'Limit'}</span><b>${booking ? money(Math.abs(booking - t.total)) : '—'}</b><small>${s.budgetType === 'vacation' && s.protectedMoney ? `plus ${money(s.protectedMoney)} protected` : vacation && booking !== vacation ? `of ${money(vacation)}` : ''}</small></div>
    </div>
    <ul class="ag-canvas-rows">
      <li>${icon('pin')}<div><b>${t.dest.name}, ${t.dest.country}</b><span>${plural(t.spec.nights, 'night')} · ${longDate(t.spec.depart)} – ${longDate(t.flight.return)} · ${plural(t.spec.travelers, 'traveler')} from ${canvas.originCity}</span></div>${lock('dest')}${lock('dates')}${lock('nights')}</li>
      <li>${icon('plane')}<div><b>${t.flight.stops ? `${t.flight.stops}-stop` : 'Nonstop'} · ${t.flight.airline}</b><span>${t.flight.name} fare · ${Math.floor(t.flight.durationMinutes / 60)}h ${String(t.flight.durationMinutes % 60).padStart(2, '0')}m each way${t.flight.refundable ? ' · refundable' : ''}</span>${canvas.trap && canvas.trap.badge ? html`<span class="ag-trap is-${canvas.trap.badge}" title="${canvas.trap.text}">${canvas.trap.badge === 'cheaper-overall' ? 'Cheaper overall' : 'Looks cheaper'}</span><small class="ag-trap-text">${canvas.trap.text}</small>` : ''}</div>${lock('flight')}</li>
      <li>${icon('bed')}<div><b>${t.hotel.name}</b><span>${t.hotel.stars}-star · ${t.hotel.area}${t.hotel.features.allInclusive ? ' · all-inclusive' : t.hotel.features.breakfast ? ' · breakfast' : ''}</span></div>${lock('hotel')}</li>
      <li>${icon('flag')}<div><b>${t.activities.length ? plural(t.activities.length, 'experience') : 'No experiences'}${t.transfer ? ' · airport transfer' : ''}</b><span>${t.activities.map(a => a.name).join(', ') || 'Add one in the customizer'}${t.transfer ? '' : ' · no transfer'}</span></div></li>
    </ul>
    <p class="ag-canvas-fit">${fitBadge(canvas.verdict, { compact: true })} <span>${canvas.verdict.win || ''}</span></p>
    ${locks.length ? html`<p class="ag-canvas-locks">${icon('lock')} Locked: ${locks.map(k => LOCK_LABEL[k]).join(', ')}</p>` : ''}
    ${canvas.receipt && canvas.receipt.lines.length ? html`<details class="ag-receipt-wrap"><summary>How we kept your cost down (${canvas.receipt.lines.length})</summary><table class="ag-receipt-table"><tbody><tr><td>Started at</td><td class="ag-num">${money(canvas.receipt.original)}</td></tr>${canvas.receipt.lines.map(l => html`<tr><td>${l.label}</td><td class="ag-num ${l.delta <= 0 ? 'is-save' : 'is-add'}">${l.delta <= 0 ? '−' : '+'}${money(Math.abs(l.delta))}</td></tr>`)}<tr class="ag-receipt-final"><td>Now</td><td class="ag-num">${money(canvas.receipt.final)}</td></tr>${canvas.receipt.keep !== null ? html`<tr class="ag-receipt-keep"><td>You keep</td><td class="ag-num">${money(canvas.receipt.keep)}</td></tr>` : ''}</tbody></table></details>` : ''}
    <div class="ag-canvas-actions">
      ${saver ? html`${sayForm(s.id, 'Find $100', 'Find $100', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'How low can you go?', 'How low can you go?', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'Same trip for less', 'Same trip for less', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'Get me more for this money', 'More for this money', 'btn btn-ghost btn-sm')}${hunt ? html`<a class="btn btn-ghost btn-sm" href="/hunts/${hunt.id}">${icon('search')} Hunting: ${hunt.name}</a>` : sayForm(s.id, 'Hunt for a better deal', 'Hunt for a better deal', 'btn btn-ghost btn-sm', html`${icon('search')} `)}` : xmax ? html`${sayForm(s.id, 'Make it more memorable', 'Make it more memorable', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'Make it better for $0 more', 'Better for $0 more', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'Why this trip is built this way', 'Why it is built this way', 'btn btn-ghost btn-sm')}<a class="btn btn-ghost btn-sm" href="/trip/${canvas.token}/memories?${optimizer.contextParams(memoriesContext(s, canvas.ctx, t))}">${icon('flag')} Memories page</a>` : html`${sayForm(s.id, 'Make it cheaper', 'Make it cheaper', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'Make it better', 'Make it better', 'btn btn-ghost btn-sm')}`}
      ${xmax ? html`<details class="ag-change" open><summary class="btn btn-ghost btn-sm">More from the same money</summary><div class="ag-chips ag-x-chips">${X_CHIPS.map(c => sayForm(s.id, c, c, 'ag-chip'))}</div><p class="tb-small tb-muted">Each one prices real versions of this trip; nothing changes until you take one.</p></details>` : ''}
      <details class="ag-change"><summary class="btn btn-ghost btn-sm">Change something</summary><div class="ag-chips">${(saver ? ['Give me one more night', 'One night less', 'Show me what one stop saves', 'Try another country', 'Upgrades worth considering', 'Make this easier'] : ['Give me one more night', 'One night less', 'Only nonstop', 'Try another country', 'Show me what one stop saves', 'Make this easier']).map(c => sayForm(s.id, c, c, 'ag-chip'))}<a class="ag-chip" href="/trip/${canvas.token}?${cx}#customize">Pick a different hotel or flight</a></div></details>
      ${saver ? html`<details class="ag-change"><summary class="btn btn-ghost btn-sm">Never cut below</summary><div class="ag-chips">${[['Only nonstop', 'Never a connection'], ['Refundable only', 'Never a non-refundable hotel'], ['3-star or better', 'Never below 3-star'], ['4-star or better', 'Never below 4-star'], ['Carry-on only', 'I pack carry-on only'], ['I check a bag', 'I check a bag'], ['Aggressive savings', 'Aggressive: every trade-off said'], ['Balanced savings', 'Balanced']].map(([say, label]) => sayForm(s.id, say, label, 'ag-chip'))}</div><p class="tb-small tb-muted">Each is a rule the search keeps; only rules the suppliers' data can check are offered.</p></details>` : ''}
      ${saver && !hunt ? html`<p class="ag-canvas-hunt tb-small tb-muted">Hunt mode: “I can wait. Only come back when my money can do something better.” A hunt keeps these rules on your account and says something only when a trip meets them.</p>` : ''}
      <div class="ag-chips ag-leak-chips" aria-label="What you don't need to pay for">${LEAK_CHIPS.map(c => sayForm(s.id, c, c, 'ag-chip'))}</div>
      ${sayForm(s.id, locks.length ? 'Unlock everything' : 'Lock everything', locks.length ? 'Unlock' : 'Lock this', 'btn btn-ghost btn-sm')}
      ${running ? '' : sayForm(s.id, 'Watch this trip', 'Watch this trip', 'btn btn-ghost btn-sm', html`${icon('eye')} `)}
      ${sayForm(s.id, 'Book it', 'Book', 'btn btn-blue btn-sm')}
    </div>
    ${running ? '' : budgetSlider(s, booking)}
    ${s.options.length > 1 ? html`<details class="ag-alts"><summary>Alternatives (${s.options.length})</summary><ul>${s.options.map(o => html`<li class="${s.current && s.current.token === o.token ? 'is-current' : ''}"><span><b>${o.label}</b> · ${o.dest}, ${plural(o.nights, 'night')} · ${money(o.total)}</span>${s.current && s.current.token === o.token ? html`<span class="tb-pill">Current</span>` : sayForm(s.id, o.kind === 'upgrade' ? 'Take the upgrade' : o.kind === 'lowest' ? 'Take the lowest' : o.kind === 'save-more' ? 'Take save more' : 'Take our pick', 'Take', 'btn btn-ghost btn-sm')}</li>`)}</ul></details>` : ''}
    <p class="ag-canvas-foot"><a class="text-link" href="/trip/${canvas.token}?${cx}">Full trip page: every line, every term ${icon('arrow')}</a></p>
  </div>`;
}

function stickyBar(s, canvas) {
  if (!canvas) return '';
  if (canvas.home) { const h = canvas.home; return html`<div class="ag-sticky" data-sticky><span><b>${money(h.total)}</b> ${h.paid ? 'paid' : 'due'}</span><span>${h.toGo > 0 && !h.cancelled ? html`<b>${h.toGo}</b> days to go` : h.today.title}</span><a class="btn btn-navy btn-sm" href="#canvas">View trip</a></div>`; }
  const booking = bookingBudget(s);
  const t = canvas.trip;
  return html`<div class="ag-sticky" data-sticky><span><b>${money(t.total)}</b> total</span><span>${booking ? (t.total > booking ? html`<b class="is-over">${money(t.total - booking)}</b> over` : html`<b>${money(booking - t.total)}</b> left`) : ''}</span><a class="btn btn-navy btn-sm" href="#canvas">View trip</a></div>`;
}

// The two live regions, swapped in place by /js/agent.js while a job runs.
function agentLive(ctx, { s, canvas, hunt }) {
  return html`${chat(ctx, s, { canvas, hunt })}${canvasPanel(ctx, s, canvas, { hunt })}`;
}

function composer(s, { autofocus = true } = {}) {
  const action = s ? `/agent/${s.id}` : '/agent';
  return html`<form class="ag-composer" method="post" action="${action}" data-composer>
    <label class="sr-only" for="ag-say">Tell your travel agent what you want</label>
    <textarea id="ag-say" name="say" rows="2" maxlength="600" placeholder="Tell your travel agent what you want…" ${autofocus ? raw('autofocus') : ''}></textarea>
    <button class="btn btn-blue" type="submit">Send ${icon('arrow')}</button>
    ${s ? html`<div class="ag-chips ag-chips-quick">${COMMANDS.slice(0, 6).map(c => html`<button class="ag-chip" type="submit" name="say" value="${c}">${c}</button>`)}</div>` : ''}
  </form>`;
}

// `hunt` is the hunt record as the route read it (live status and summary), or undefined to show what
// the conversation last saw; a page rendered without the route (tests, previews) reads the latter.
function agentView(ctx, { s, canvas, user, originCity, hunt }) {
  const running = !!(s.job && s.job.status === 'running');
  const body = html`
<section class="ag-page" aria-label="Your travel agent">
  <div class="container ag-layout">
    <div class="ag-chat">
      <div class="ag-chat-head"><p class="tb-kicker">Your travel agent</p><h1>${s.mission && bookingBudget(s) ? `Your ${money(bookingBudget(s))} mission.` : 'Tell me what you want your trip to do.'}</h1></div>
      <div class="ag-live-chat">${chat(ctx, s, { canvas, hunt })}</div>
      ${composer(s)}
      <p class="ag-foot tb-small tb-muted">I only quote prices and terms the suppliers return, every total includes taxes and fees, and I never book or charge anything: you confirm every change and the booking yourself.${ctx.tripService.demo ? ' Demo inventory in this preview.' : ''}</p>
    </div>
    <aside class="ag-canvas" id="canvas" aria-label="Your trip canvas">${canvasPanel(ctx, s, canvas, { hunt })}</aside>
  </div>
</section>
${stickyBar(s, canvas)}`;
  return layout({
    title: canvas && canvas.home ? `Trip ${canvas.home.ref} · Your travel agent` : canvas ? `${plural(canvas.trip.spec.nights, 'night')} in ${canvas.trip.dest.name} · Your travel agent` : 'Your travel agent', active: 'plan', body, ctx: running ? { ...ctx, preload: raw('<meta http-equiv="refresh" content="3">') } : ctx,
    scripts: ['/js/agent.js'], noindex: true, bodyClass: 'ag-body',
  });
}

function agentStartView(ctx, { user, booking = null }) {
  const body = html`
<section class="ag-page" aria-label="Your travel agent">
  <div class="container ag-layout ag-layout-start">
    <div class="ag-chat">
      <div class="ag-chat-head"><p class="tb-kicker">Your travel agent</p><h1>What do you want your trip to do?</h1>
        <p class="tb-muted">Tell me the budget, who is going, where you fly from, and anything that must be true. I do the searching, comparing and pricing. You decide.</p></div>
      ${composer(null)}
      <div class="ag-chips ag-examples">${EXAMPLES.map(e => html`<form method="post" action="/agent" class="ag-say"><input type="hidden" name="say" value="${e}"><button class="ag-chip" type="submit">${e}</button></form>`)}</div>
      <p class="ag-foot tb-small tb-muted">Prices and terms come from suppliers, every total includes taxes and fees, and nothing is booked or charged until you confirm it yourself.${ctx.tripService.demo ? ' Demo inventory in this preview.' : ''}</p>
    </div>
    <aside class="ag-canvas" id="canvas" aria-label="Your trip canvas"><div id="live-canvas"><div class="ag-canvas-head"><p class="tb-kicker">Your trip</p></div><p class="ag-empty">Your trip canvas fills in as we talk: flights, hotel, total, what you keep, and what is locked.</p>
      <ul class="tb-list tb-small"><li>Say what must be true: “only nonstop”, “don’t change the hotel”.</li><li>Negotiate: “make it $200 cheaper”, “spend $100 if it actually helps”.</li><li>Challenge: “I found this for $1,800, can you beat it?”</li></ul></div></aside>
  </div>
</section>`;
  return layout({ title: 'Your travel agent', active: 'plan', body, ctx, scripts: ['/js/agent.js'], canonical: '/agent', description: 'Tell your travel agent what you want your trip to do. It searches, compares and prices complete trips inside your budget; you decide.' });
}

module.exports = { agentView, agentStartView, agentLive, EXAMPLES };
