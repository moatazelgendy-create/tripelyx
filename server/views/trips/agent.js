// The travel agent page: the conversation on the left, the live Trip Canvas on the right (the
// conversation first on phones, with a sticky total at the bottom). Every button is a form that says
// something to the agent, so the page works without JavaScript; /js/agent.js only polls the live
// regions while a search job runs and keeps the composer in place.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { money, dollars, longDate, plural, demoBadge, hiddenParams, fitBadge } = require('./common');
const { askedFor, bookingBudget, vacationBudget, missionRules, LOCK_KEYS, LOCK_LABEL } = require('../../agent/state');
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
    <div class="ag-actions">${c.variants.length > 1 ? sayForm(id, 'Mix them', 'Mix them') : ''}${sayForm(id, 'Keep what I have', 'Keep what I have')}</div>
    <p class="tb-small tb-muted">Mixing: say which pieces, like “the hotel from C with the flight from A”. I rebuild it as one package and re-check the live total.</p>
  </div>`;
}

function card(id, m, { current }) {
  const c = m.card;
  if (!c) return '';
  switch (c.kind) {
    case 'ask': return html`<div class="ag-actions">${c.options.map(o => sayForm(id, o.say, o.label, 'btn btn-ghost btn-sm'))}</div>`;
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
        ${c.keep !== null ? html`<tr class="ag-receipt-keep"><td>You keep of your ${money(c.max)}</td><td class="ag-num">${money(c.keep)}</td></tr>` : ''}
      </tbody></table>
      <p class="tb-small tb-muted">Each line is one version's live price minus the one before it: sequential, nothing counted twice, no market “savings”.</p>
    </div>`;
    case 'variants': return variantsCard(id, c, current);
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

function chat(ctx, s, { canvas }) {
  const running = !!(s.job && s.job.status === 'running');
  const current = s.current;
  return html`<div id="live-chat" data-live="chat" data-running="${running ? '1' : '0'}">
    <ol class="ag-messages">
      ${s.messages.length ? '' : html`<li class="ag-msg is-agent"><div class="ag-bubble"><p>What do you want your trip to do? Tell me the budget, who is going, where you fly from, and anything that must be true. I search, compare and negotiate; you decide.</p></div></li>`}
      ${s.messages.map(m => html`<li class="ag-msg is-${m.role}"><div class="ag-bubble"><p>${m.text}</p>${m.role === 'agent' ? card(s.id, m, { current }) : ''}</div></li>`)}
    </ol>
    ${progress(s.job, { mission: s.mission ? bookingBudget(s) : null })}
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

// The mission on the canvas: what the agent is building, its status, and what it is optimizing
// (hard rules, preferences, what it is free to change), from the conversation's facts.
function missionPanel(ctx, s, { canvas }) {
  if (!s.mission) return '';
  const booking = bookingBudget(s);
  const running = !!(s.job && s.job.status === 'running');
  const o = s.origin ? ctx.tripService.inv.maps.getOrigin(s.origin) : null;
  const status = running ? 'Building…' : s.proposal ? 'One decision away' : s.mission.strategies && s.mission.strategies.length && !s.mission.signal ? `${plural(s.mission.strategies.length, 'way')} built, waiting for which feels like you` : canvas ? 'A trip to beat is on the canvas' : s.pending === 'origin' ? 'Waiting for where you fly from' : 'Waiting for the budget';
  const rules = missionRules(s, { maps: ctx.tripService.inv.maps });
  return html`<div class="ag-mission">
    <div class="ag-mission-head"><div><p class="tb-kicker">Your mission</p><b>Build the best vacation${booking ? ` for ${money(booking)}` : ''}</b></div><span class="ag-mission-status${running ? ' is-running' : ''}">${status}</span></div>
    <dl class="ag-mission-facts"><div><dt>Budget</dt><dd>${booking ? `${money(booking)} max` : 'not set'}</dd></div><div><dt>Travelers</dt><dd>${s.travelers ? plural(s.travelers, 'traveler') : 'open'}</dd></div><div><dt>From</dt><dd>${o ? o.city : 'not set'}</dd></div></dl>
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

function canvasPanel(ctx, s, canvas) {
  if (canvas && canvas.home) return homePanel(ctx, s, canvas.home);
  const booking = bookingBudget(s), vacation = vacationBudget(s);
  const locks = LOCK_KEYS.filter(k => s.locks[k]);
  const lock = k => (s.locks[k] ? html`<span class="ag-lock" title="Locked">${icon('lock')}</span>` : '');
  const running = !!(s.job && s.job.status === 'running');
  const saver = !!(s.mission && s.mission.mode === 'save');
  const head = html`<div class="ag-canvas-head"><p class="tb-kicker">${saver && canvas ? 'You told us your max. We found your minimum.' : 'Your trip'}</p>${demoBadge(ctx.tripService.demo, 'Demo inventory')}</div>`;
  if (!canvas) {
    const rows = askedFor(s, { maps: ctx.tripService.inv.maps });
    return html`<div id="live-canvas" data-live="canvas">${head}${missionPanel(ctx, s, { canvas })}
      ${running ? html`<p class="ag-empty">Building your trip. Each line fills in as suppliers return real data; the first strong trip lands here.</p>${draftRows(ctx, s)}` : html`<p class="ag-empty">${s.mission ? 'Nothing built yet. Give me the number, and where you fly from, and I do the rest.' : 'Nothing built yet. Tell me what you want your trip to do.'}</p>`}
      ${rows.length && !running ? html`<dl class="ag-known">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ''}
    </div>`;
  }
  const t = canvas.trip;
  const cx = optimizer.contextParams(canvas.ctx);
  return html`<div id="live-canvas" data-live="canvas">${head}${missionPanel(ctx, s, { canvas })}
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
      ${saver ? html`${sayForm(s.id, 'Find $100', 'Find $100', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'How low can you go?', 'How low can you go?', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'Same trip for less', 'Same trip for less', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'Get me more for this money', 'More for this money', 'btn btn-ghost btn-sm')}` : html`${sayForm(s.id, 'Make it cheaper', 'Make it cheaper', 'btn btn-ghost btn-sm')}${sayForm(s.id, 'Make it better', 'Make it better', 'btn btn-ghost btn-sm')}`}
      <details class="ag-change"><summary class="btn btn-ghost btn-sm">Change something</summary><div class="ag-chips">${(saver ? ['Give me one more night', 'One night less', 'Show me what one stop saves', 'Try another country', 'Upgrades worth considering', 'Make this easier'] : ['Give me one more night', 'One night less', 'Only nonstop', 'Try another country', 'Show me what one stop saves', 'Make this easier']).map(c => sayForm(s.id, c, c, 'ag-chip'))}<a class="ag-chip" href="/trip/${canvas.token}?${cx}#customize">Pick a different hotel or flight</a></div></details>
      ${saver ? html`<details class="ag-change"><summary class="btn btn-ghost btn-sm">Never cut below</summary><div class="ag-chips">${[['Only nonstop', 'Never a connection'], ['Refundable only', 'Never a non-refundable hotel'], ['3-star or better', 'Never below 3-star'], ['4-star or better', 'Never below 4-star'], ['Carry-on only', 'I pack carry-on only'], ['I check a bag', 'I check a bag'], ['Aggressive savings', 'Aggressive: every trade-off said'], ['Balanced savings', 'Balanced']].map(([say, label]) => sayForm(s.id, say, label, 'ag-chip'))}</div><p class="tb-small tb-muted">Each is a rule the search keeps; only rules the suppliers' data can check are offered.</p></details>` : ''}
      ${sayForm(s.id, locks.length ? 'Unlock everything' : 'Lock everything', locks.length ? 'Unlock' : 'Lock this', 'btn btn-ghost btn-sm')}
      ${sayForm(s.id, 'Book it', 'Book', 'btn btn-blue btn-sm')}
    </div>
    ${running ? '' : budgetSlider(s, booking)}
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
      <div class="ag-chat-head"><p class="tb-kicker">Your travel agent</p><h1>${s.mission && bookingBudget(s) ? `Your ${money(bookingBudget(s))} mission.` : 'Tell me what you want your trip to do.'}</h1></div>
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
