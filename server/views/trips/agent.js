// The travel agent page: the conversation on the left, the live Trip Canvas on the right (the
// conversation first on phones, with a sticky total at the bottom). Every button is a form that says
// something to the agent, so the page works without JavaScript; /js/agent.js only polls the live
// regions while a search job runs and keeps the composer in place.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { money, dollars, longDate, plural, demoBadge, hiddenParams, fitBadge } = require('./common');
const { askedFor, bookingBudget, vacationBudget, LOCK_KEYS, LOCK_LABEL } = require('../../agent/state');
const { COMMANDS } = require('../../agent/agent');
const optimizer = require('../../trips/optimizer');

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

function proposalCard(id, p, { current } = {}) {
  const over = p.over;
  return html`<div class="ag-card ag-proposal${over ? ' is-over' : ''}">
    <div class="ag-proposal-nums">
      <div><span>Now</span><b>${current ? money(current.total) : '—'}</b></div>
      <div><span>${p.label}</span><b>${money(p.total)}</b></div>
      <div><span>${p.delta <= 0 ? 'You keep' : 'Costs'}</span><b class="${p.delta <= 0 ? 'is-save' : 'is-add'}">${p.delta <= 0 ? '+' : ''}${money(Math.abs(p.delta))}</b></div>
    </div>
    ${p.improvements && p.improvements.length ? html`<p class="ag-up">${icon('trend')} <span>${p.improvements.join('; ')}</span></p>` : ''}
    ${p.tradeoffs && p.tradeoffs.length ? html`<p class="ag-down">${icon('minus')} <span>${p.tradeoffs.join('; ')}</span></p>` : ''}
    ${p.neutral && p.neutral.length ? html`<p class="ag-same">${icon('info')} <span>${p.neutral.join('; ')}</span></p>` : ''}
    ${over ? html`<p class="ag-over">${icon('alert')} <span>Over your ceiling. Your maximum is a ceiling, not a target; only you can raise it.</span></p>` : ''}
    <div class="ag-actions">
      ${sayForm(id, over ? 'Go over' : 'Take it', over ? `Go over by ${money(Math.abs(p.delta))}` : 'Take it', 'btn btn-blue btn-sm')}
      ${sayForm(id, 'Keep what I have', p.delta > 0 ? `Keep the ${money(p.delta)}` : 'Keep what I have')}
      ${p.anyway ? sayForm(id, 'Do it anyway', `Do it anyway (${money(p.anyway.total)})`) : ''}
    </div>
  </div>`;
}

function optionsCard(id, card, current) {
  return html`<div class="ag-card ag-options">
    <ul>${card.options.map((o, i) => html`<li class="${current && current.token === o.token ? 'is-current' : ''}">
      <p class="tb-kicker">${o.label}${o.over ? ' · needs the extra you allowed' : ''}</p>
      ${tripLine(o)}
      ${o.upgrade ? html`<p class="tb-card-upgrade">${icon('sparkle')} +${money(o.upgrade.delta)} gets ${o.upgrade.gets}.</p>` : ''}
      <div class="ag-actions">${current && current.token === o.token ? html`<span class="tb-pill">On your canvas</span>` : sayForm(id, o.kind === 'upgrade' ? 'Take the upgrade' : o.kind === 'save-more' ? 'Take save more' : 'Take our pick', o.kind === 'upgrade' ? 'Take the upgrade' : `Take ${o.label.toLowerCase()}`, 'btn btn-navy btn-sm')}<a class="text-link" href="/trip/${o.token}">Full trip page ${icon('arrow')}</a></div>
    </li>`)}
    ${card.keepMoney && card.keepMoney.spare > 0 && !card.options.some(o => o.kind === 'upgrade') ? html`<li class="ag-keep"><p class="tb-kicker">Keep your money</p><p><b>${money(card.keepMoney.spare)}</b> stays with you: nothing I priced improved on our pick in a way worth its price.</p></li>` : ''}</ul>
  </div>`;
}

function card(id, m, { current }) {
  const c = m.card;
  if (!c) return '';
  switch (c.kind) {
    case 'ask': return html`<div class="ag-actions">${c.options.map(o => sayForm(id, o.say, o.label, 'btn btn-ghost btn-sm'))}</div>`;
    case 'trip': return html`<div class="ag-card${c.over ? ' is-over' : ''}">${c.label ? html`<p class="tb-kicker">${c.label}</p>` : ''}${tripLine(c.trip)}${c.first ? html`<p class="ag-still">${icon('search')} <span>Still checking whether I can beat this.</span></p>` : ''}<p class="ag-actions"><a class="text-link" href="/trip/${c.trip.token}">Full trip page ${icon('arrow')}</a></p></div>`;
    case 'options': return optionsCard(id, c, current);
    case 'switch': return html`<div class="ag-card ag-switch">
      <p class="tb-kicker">I beat my first option</p>
      <div class="ag-proposal-nums"><div><span>First</span><b>${money(c.first.total)}</b></div><div><span>Better</span><b>${money(c.better.total)}</b></div><div><span>${c.better.total <= c.first.total ? 'You keep' : 'Costs'}</span><b class="${c.better.total <= c.first.total ? 'is-save' : 'is-add'}">${c.better.total <= c.first.total ? '+' : ''}${money(Math.abs(c.first.total - c.better.total))}</b></div></div>
      ${tripLine(c.better)}
      ${c.proposal.improvements.length ? html`<p class="ag-up">${icon('trend')} <span>${c.proposal.improvements.join('; ')}</span></p>` : ''}
      ${c.proposal.tradeoffs.length ? html`<p class="ag-down">${icon('minus')} <span>${c.proposal.tradeoffs.join('; ')}</span></p>` : ''}
      ${c.proposal.neutral.length ? html`<p class="ag-same">${icon('info')} <span>${c.proposal.neutral.join('; ')}</span></p>` : ''}
      <div class="ag-actions">${sayForm(id, 'Switch to the better option', 'Switch to the better option', 'btn btn-blue btn-sm')}${sayForm(id, 'Keep the first one', 'Keep the first one')}</div>
    </div>`;
    case 'proposal': return proposalCard(id, c.proposal, { current });
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
      <div class="ag-actions"><a class="btn btn-blue" href="${c.href}">Check the live price and book ${icon('arrow')}</a></div>
      <p class="tb-small tb-muted">Nothing is charged here. The next page re-checks the live price, shows every term, and you confirm.</p>
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

function progress(job) {
  if (!job) return '';
  const secs = ms => (ms === null ? '' : `${(ms / 1000).toFixed(1)} s`);
  if (job.status !== 'running') {
    const done = job.steps.filter(s => s.status === 'done');
    const last = done[done.length - 1];
    return html`<p class="ag-progress-done tb-small tb-muted">${icon(job.status === 'cancelled' ? 'close' : 'check')} ${job.status === 'cancelled' ? 'Search stopped.' : `Searched ${job.considered.toLocaleString('en-US')} complete packages${job.destinations ? ` across ${plural(job.destinations, 'destination')}` : ''} in ${secs(last ? last.ms : null)}.`}${job.firstAtMs !== null ? ` First match at ${secs(job.firstAtMs)}.` : ''}${job.bestAtMs !== null && job.improved ? ` Better one at ${secs(job.bestAtMs)}.` : ''}</p>`;
  }
  return html`<ol class="ag-progress" aria-live="polite" aria-label="Search progress">${job.steps.map(s => html`<li class="is-${s.status}"><span class="ag-step-dot"></span><span class="ag-step-text"><b>${s.label}</b>${s.detail ? html`<small>${s.detail}</small>` : ''}</span>${s.ms !== null && s.status !== 'pending' ? html`<span class="ag-step-ms">${secs(s.ms)}</span>` : ''}</li>`)}</ol>`;
}

function chat(ctx, s, { canvas }) {
  const running = !!(s.job && s.job.status === 'running');
  const current = s.current;
  return html`<div id="live-chat" data-live="chat" data-running="${running ? '1' : '0'}">
    <ol class="ag-messages">
      ${s.messages.length ? '' : html`<li class="ag-msg is-agent"><div class="ag-bubble"><p>What do you want your trip to do? Tell me the budget, who is going, where you fly from, and anything that must be true. I search, compare and negotiate; you decide.</p></div></li>`}
      ${s.messages.map(m => html`<li class="ag-msg is-${m.role}"><div class="ag-bubble"><p>${m.text}</p>${m.role === 'agent' ? card(s.id, m, { current }) : ''}</div></li>`)}
    </ol>
    ${progress(s.job)}
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
    <p class="tb-kicker">Important actions</p>
    ${home.actions.length ? html`<ul class="ag-home-actions">${home.actions.map(a => html`<li>${dot(a.status)}<span>${a.text}</span></li>`)}</ul>` : html`<p class="tb-small tb-muted">Nothing is due from you.</p>`}
    <div class="ag-chips ag-home-asks">${AFTER_BOOKING.map(c => sayForm(s.id, c, c, 'ag-chip'))}</div>
    <p class="ag-canvas-foot"><a class="text-link" href="${home.bookingHref}">The booking page: every confirmation, every term ${icon('arrow')}</a></p>
  </div>`;
}

function canvasPanel(ctx, s, canvas) {
  if (canvas && canvas.home) return homePanel(ctx, s, canvas.home);
  const booking = bookingBudget(s), vacation = vacationBudget(s);
  const locks = LOCK_KEYS.filter(k => s.locks[k]);
  const lock = k => (s.locks[k] ? html`<span class="ag-lock" title="Locked">${icon('lock')}</span>` : '');
  const head = html`<div class="ag-canvas-head"><p class="tb-kicker">Your trip</p>${demoBadge(ctx.tripService.demo, 'Demo inventory')}</div>`;
  if (!canvas) {
    const rows = askedFor(s, { maps: ctx.tripService.inv.maps });
    return html`<div id="live-canvas" data-live="canvas">${head}
      <p class="ag-empty">${s.job && s.job.status === 'running' ? 'Building your trip. The first strong match lands here.' : 'Nothing built yet. Tell me what you want your trip to do.'}</p>
      ${rows.length ? html`<dl class="ag-known">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ''}
    </div>`;
  }
  const t = canvas.trip;
  const cx = optimizer.contextParams(canvas.ctx);
  return html`<div id="live-canvas" data-live="canvas">${head}
    <div class="ag-canvas-nums">
      <div><span>Budget${s.budgetType === 'vacation' ? ' for the trip' : ''}</span><b>${booking ? money(booking) : '—'}</b><small>${booking ? 'a ceiling, not a target' : 'not set'}</small></div>
      <div><span>Total, everything included</span><b>${money(t.total)}</b><small>${money(t.perTraveler)} per traveler</small></div>
      <div class="${booking && t.total > booking ? 'is-over' : 'is-keep'}"><span>${booking ? (t.total > booking ? 'Over by' : 'You keep') : 'Limit'}</span><b>${booking ? money(Math.abs(booking - t.total)) : '—'}</b><small>${s.budgetType === 'vacation' && s.protectedMoney ? `plus ${money(s.protectedMoney)} protected` : vacation && booking !== vacation ? `of ${money(vacation)}` : ''}</small></div>
    </div>
    <ul class="ag-canvas-rows">
      <li>${icon('pin')}<div><b>${t.dest.name}, ${t.dest.country}</b><span>${plural(t.spec.nights, 'night')} · ${longDate(t.spec.depart)} – ${longDate(t.flight.return)} · ${plural(t.spec.travelers, 'traveler')} from ${canvas.originCity}</span></div>${lock('dest')}${lock('dates')}${lock('nights')}</li>
      <li>${icon('plane')}<div><b>${t.flight.stops ? `${t.flight.stops}-stop` : 'Nonstop'} · ${t.flight.airline}</b><span>${t.flight.name} fare · ${Math.floor(t.flight.durationMinutes / 60)}h ${String(t.flight.durationMinutes % 60).padStart(2, '0')}m each way${t.flight.refundable ? ' · refundable' : ''}</span></div>${lock('flight')}</li>
      <li>${icon('bed')}<div><b>${t.hotel.name}</b><span>${t.hotel.stars}-star · ${t.hotel.area}${t.hotel.features.allInclusive ? ' · all-inclusive' : t.hotel.features.breakfast ? ' · breakfast' : ''}</span></div>${lock('hotel')}</li>
      <li>${icon('flag')}<div><b>${t.activities.length ? plural(t.activities.length, 'experience') : 'No experiences'}${t.transfer ? ' · airport transfer' : ''}</b><span>${t.activities.map(a => a.name).join(', ') || 'Add one in the customizer'}${t.transfer ? '' : ' · no transfer'}</span></div></li>
    </ul>
    <p class="ag-canvas-fit">${fitBadge(canvas.verdict, { compact: true })} <span>${canvas.verdict.win || ''}</span></p>
    ${locks.length ? html`<p class="ag-canvas-locks">${icon('lock')} Locked: ${locks.map(k => LOCK_LABEL[k]).join(', ')}</p>` : ''}
    <div class="ag-canvas-actions">
      ${sayForm(s.id, 'Make it cheaper', 'Make it cheaper', 'btn btn-ghost btn-sm')}
      ${sayForm(s.id, 'Make it better', 'Make it better', 'btn btn-ghost btn-sm')}
      <details class="ag-change"><summary class="btn btn-ghost btn-sm">Change something</summary><div class="ag-chips">${['Give me one more night', 'One night less', 'Only nonstop', 'Try another country', 'Show me what one stop saves', 'Make this easier'].map(c => sayForm(s.id, c, c, 'ag-chip'))}<a class="ag-chip" href="/trip/${canvas.token}?${cx}#customize">Pick a different hotel or flight</a></div></details>
      ${sayForm(s.id, locks.length ? 'Unlock everything' : 'Lock everything', locks.length ? 'Unlock' : 'Lock this', 'btn btn-ghost btn-sm')}
      ${sayForm(s.id, 'Book it', 'Book', 'btn btn-blue btn-sm')}
    </div>
    ${s.options.length > 1 ? html`<details class="ag-alts"><summary>Alternatives (${s.options.length})</summary><ul>${s.options.map(o => html`<li class="${s.current && s.current.token === o.token ? 'is-current' : ''}"><span><b>${o.label}</b> · ${o.dest}, ${plural(o.nights, 'night')} · ${money(o.total)}</span>${s.current && s.current.token === o.token ? html`<span class="tb-pill">Current</span>` : sayForm(s.id, o.kind === 'upgrade' ? 'Take the upgrade' : o.kind === 'save-more' ? 'Take save more' : 'Take our pick', 'Take', 'btn btn-ghost btn-sm')}</li>`)}</ul></details>` : ''}
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
function agentLive(ctx, { s, canvas }) {
  return html`${chat(ctx, s, { canvas })}${canvasPanel(ctx, s, canvas)}`;
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

function agentView(ctx, { s, canvas, user, originCity }) {
  const running = !!(s.job && s.job.status === 'running');
  const body = html`
<section class="ag-page" aria-label="Your travel agent">
  <div class="container ag-layout">
    <div class="ag-chat">
      <div class="ag-chat-head"><p class="tb-kicker">Your travel agent</p><h1>Tell me what you want your trip to do.</h1></div>
      <div class="ag-live-chat">${chat(ctx, s, { canvas })}</div>
      ${composer(s)}
      <p class="ag-foot tb-small tb-muted">I only quote prices and terms the suppliers return, every total includes taxes and fees, and I never book or charge anything: you confirm every change and the booking yourself.${ctx.tripService.demo ? ' Demo inventory in this preview.' : ''}</p>
    </div>
    <aside class="ag-canvas" id="canvas" aria-label="Your trip canvas">${canvasPanel(ctx, s, canvas)}</aside>
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
        <p class="tb-muted">Tell me the budget, who is going, where you fly from, and anything that must be true. I do the searching, comparing and negotiating. You decide.</p></div>
      ${composer(null)}
      <div class="ag-chips ag-examples">${EXAMPLES.map(e => html`<form method="post" action="/agent" class="ag-say"><input type="hidden" name="say" value="${e}"><button class="ag-chip" type="submit">${e}</button></form>`)}</div>
      <p class="ag-foot tb-small tb-muted">Prices and terms come from suppliers, every total includes taxes and fees, and nothing is booked or charged until you confirm it yourself.</p>
    </div>
    <aside class="ag-canvas" id="canvas" aria-label="Your trip canvas"><div id="live-canvas"><div class="ag-canvas-head"><p class="tb-kicker">Your trip</p></div><p class="ag-empty">Your trip canvas fills in as we talk: flights, hotel, total, what you keep, and what is locked.</p>
      <ul class="tb-list tb-small"><li>Say what must be true: “only nonstop”, “don’t change the hotel”.</li><li>Negotiate: “make it $200 cheaper”, “spend $100 if it actually helps”.</li><li>Challenge: “I found this for $1,800, can you beat it?”</li></ul></div></aside>
  </div>
</section>`;
  return layout({ title: 'Your travel agent', active: 'plan', body, ctx, scripts: ['/js/agent.js'], canonical: '/agent', description: 'Tell your travel agent what you want your trip to do. It searches, compares and negotiates complete trips inside your budget; you decide.' });
}

module.exports = { agentView, agentStartView, agentLive, EXAMPLES };
