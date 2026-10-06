// The Trip Challenge pages: the trip to beat (what the traveler told us, unknowns and all), how we
// should beat it (five modes, "don't touch these"), and the scoreboard with one of four verdicts:
// we beat it, a different trade-off, your deal wins, or we need more information. The platform is
// allowed to lose, and says so in plain words.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { addDays, today } = require('../../lib/dates');
const { encodeSpec } = require('../../trips/spec');
const { contextParams } = require('../../trips/optimizer');
const { cutoffs } = require('../../trips/deadlines');
const { lineAmount, LINE_ORDER, LINE_LABEL } = require('../../trips/facts');
const { challengerParams, MODES, LOCKS, UNKNOWN, UNKNOWN_LABELS, FLIGHT, MEALS, BAGS, TRANSFER, CANCEL, TAXES } = require('../../trips/challenge');
const { money, dollars, longDate, plural, joinAnd, cutoffText, hm, demoBadge } = require('./common');

const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sel = on => (on ? raw(' selected') : '');
const chk = on => (on ? raw(' checked') : '');

const WORD = {
  flight: { nonstop: 'Nonstop', stops: 'With a stop', [UNKNOWN]: 'Unknown' },
  meals: { none: 'Not included', breakfast: 'Breakfast included', 'all-inclusive': 'All-inclusive', [UNKNOWN]: 'Unknown' },
  bags: { personal: 'Personal item only', 'carry-on': 'Carry-on', checked: 'Checked bag', [UNKNOWN]: 'Unknown' },
  transfer: { yes: 'Included', no: 'Not included', [UNKNOWN]: 'Unknown' },
  cancel: { nonrefundable: 'Non-refundable', refundable: 'Refundable', [UNKNOWN]: 'Unknown' },
  taxes: { included: 'Included', excluded: 'Not in the price', [UNKNOWN]: 'Unknown' },
};
const ROW_WORD = { nights: 'the length', dates: 'the dates', dest: 'the destination', flight: 'the flights', hotel: 'the hotel', meals: 'meals', bags: 'bags', transfer: 'the airport transfer', cancel: 'the cancellation terms', taxes: 'taxes and fees' };
const LOCK_WORD = { nonstop: 'Nonstop flights', stars: 'The hotel class', nights: 'The number of nights', dates: 'The dates', meals: 'The meal plan', dest: 'The destination' };
const MEAL_WORD = ['Not included', 'Breakfast included', 'All-inclusive'];
const BAG_WORD = ['Personal item only', 'Carry-on', 'Checked bag included'];

// ---- the form: the trip you found --------------------------------------------------------------
function challengeFormView(ctx, { raw: given = {}, destinations, origins, hotels, missing = [] }) {
  const radios = (name, list, words, legend) => html`<fieldset class="tb-chal-radios"><legend>${legend}</legend><div class="tb-radio-row tb-radio-wrap" role="radiogroup">${list.map(v => html`<label><input type="radio" name="${name}" value="${v}"${chk((given[name] || UNKNOWN) === v)}> ${words[v]}</label>`)}</div></fieldset>`;
  const need = k => (missing.includes(k) ? raw(' aria-invalid="true"') : '');
  const body = html`
<div class="container tb-chal-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span aria-current="page">Challenge us</span></nav>
  <header class="tb-results-head">
    <div>
      <p class="eyebrow">Already found a trip?</p>
      <h1>Can we build a better vacation?</h1>
      <p class="tb-results-sub">Don’t start another search. Bring the trip you’re considering; we build a comparable version and say honestly whether we beat it. If your deal is better, we’ll tell you to keep it. ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p>
    </div>
  </header>
  ${missing.length ? html`<div class="alert alert-error" role="alert">${icon('alert')}<span>To compare at all we need ${joinAnd(missing.map(m => ({ dest: 'the destination', from: 'where you’re leaving from', nights: 'the number of nights', total: 'their total price' })[m]))}.</span></div>` : ''}
  <form class="form tb-chal-form" action="/challenge/review" method="get">
    <section class="tb-panel">
      <h2>${icon('flag')} The trip you found</h2>
      <div class="form-row">
        <div class="field"><label for="ch-dest">Destination</label><select id="ch-dest" name="dest" required${need('dest')}><option value="">Choose…</option>${destinations.map(d => html`<option value="${d.id}"${sel(given.dest === d.id)}>${d.name}, ${d.country}</option>`)}</select></div>
        <div class="field"><label for="ch-from">Leaving from</label><select id="ch-from" name="from"${need('from')}>${origins.map(o => html`<option value="${o.id}"${sel((given.from || '').toUpperCase() === o.id)}>${o.city}</option>`)}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="ch-depart">Departure date <span class="optional">(blank if unknown; without it we compare but can’t call a win)</span></label><input id="ch-depart" type="date" name="depart" value="${given.depart || ''}" min="${addDays(today(), 3)}" max="${addDays(today(), 330)}"></div>
        <div class="field"><label for="ch-nights">Nights</label><select id="ch-nights" name="nights" required${need('nights')}><option value="">Choose…</option>${Array.from({ length: 13 }, (_, i) => i + 2).map(n => html`<option value="${n}"${sel(String(given.nights) === String(n))}>${n}</option>`)}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="ch-who">Who’s going</label><select id="ch-who" name="who">${[['couple', 'A couple'], ['solo', 'Just me'], ['family', 'A family'], ['friends', 'Friends']].map(([v, l]) => html`<option value="${v}"${sel((given.who || 'couple') === v)}>${l}</option>`)}</select></div>
        <div class="field"><label for="ch-n">Travelers</label><select id="ch-n" name="n">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => html`<option value="${n}"${sel(String(given.n || 2) === String(n))}>${n}</option>`)}</select></div>
      </div>
      <div class="field"><label for="ch-total">Their total price, for everyone</label><div class="tb-budget-input tb-budget-input-sm"><span class="tb-currency" aria-hidden="true">$</span><input id="ch-total" name="total" type="text" inputmode="numeric" placeholder="1,860" value="${given.total || ''}" required${need('total')}></div><p class="field-hint">The number on their page. Say below whether taxes and fees are in it.</p></div>
    </section>
    <section class="tb-panel">
      <h2>${icon('layers')} What it includes</h2>
      <p class="tb-muted">Leave anything you’re not sure of on Unknown. We never guess: an unknown stays unknown on the scoreboard, and we won’t claim a win until it’s known.</p>
      ${radios('flight', FLIGHT, WORD.flight, 'Flights')}
      <fieldset class="tb-chal-radios"><legend>Hotel class</legend><div class="tb-radio-row tb-radio-wrap" role="radiogroup">${['3', '4', '5', UNKNOWN].map(v => html`<label><input type="radio" name="stars" value="${v}"${chk(String(given.stars || UNKNOWN) === v)}> ${v === UNKNOWN ? 'Unknown' : `${v}-star`}</label>`)}</div></fieldset>
      ${radios('meals', MEALS, WORD.meals, 'Meals')}
      ${radios('bags', BAGS, WORD.bags, 'Bags')}
      ${radios('transfer', TRANSFER, WORD.transfer, 'Airport transfer')}
      ${radios('cancel', CANCEL, WORD.cancel, 'Cancellation')}
      ${radios('taxes', TAXES, WORD.taxes, 'Taxes and fees in their price')}
      <div class="field"><label for="ch-hotel">I love this hotel <span class="optional">(optional: one of ours, and we keep it)</span></label><select id="ch-hotel" name="hotel"><option value="">No, any comparable hotel</option>${hotels.map(g => html`<optgroup label="${g.dest.name}">${g.hotels.map(h => html`<option value="${h.id}"${sel(given.hotel === h.id)}>${h.name} · ${h.stars}-star</option>`)}</optgroup>`)}</select></div>
    </section>
    <div class="tb-chal-actions"><button class="btn btn-navy btn-lg" type="submit">Review the challenger ${icon('arrow')}</button></div>
    <p class="tb-muted tb-small">A link or a screenshot: not yet. Type what you know. We compare complete prices only: ours always includes taxes, mandatory fees and our service fee.</p>
  </form>
</div>`;
  return layout({ title: 'Challenge us: can we build a better vacation?', description: 'Bring the trip you found. We build a comparable version and say honestly whether we beat it, or that your deal wins.', active: 'challenge', body, ctx });
}

// ---- the trip to beat ---------------------------------------------------------------------------
function challengerRows(ch, { theirDest, originCity, hotelName }) {
  return [
    ['Destination', `${theirDest.name}, ${theirDest.country}`],
    ['Leaving from', originCity],
    ['Dates', ch.depart ? `${longDate(ch.depart)} – ${longDate(addDays(ch.depart, ch.nights))}` : null],
    ['Nights', plural(ch.nights, 'night')],
    ['Travelers', plural(ch.travelers, 'traveler')],
    ['Flight', ch.flight === UNKNOWN ? null : WORD.flight[ch.flight]],
    ['Hotel', ch.stars ? `${ch.stars}-star${hotelName ? ` · ${hotelName}` : ''}` : hotelName || null],
    ['Meals', ch.meals === UNKNOWN ? null : WORD.meals[ch.meals]],
    ['Bags', ch.bags === UNKNOWN ? null : WORD.bags[ch.bags]],
    ['Airport transfer', ch.transfer === UNKNOWN ? null : WORD.transfer[ch.transfer]],
    ['Cancellation', ch.cancel === UNKNOWN ? null : WORD.cancel[ch.cancel]],
    ['Taxes and fees', ch.taxes === UNKNOWN ? null : WORD.taxes[ch.taxes]],
    ['Total', `${money(ch.total)}${ch.taxes === 'excluded' ? ' before taxes and fees' : ''}`],
  ];
}

// What our version must carry so the fight is fair, in words.
function fairFight(ch) {
  const parts = [];
  if (ch.flight === 'nonstop' || ch.locks.includes('nonstop')) parts.push('nonstop flights');
  if (ch.stars) parts.push(`a ${ch.stars}-star hotel or better`);
  if (ch.hotel) parts.push('your hotel');
  if (ch.meals === 'breakfast') parts.push('breakfast');
  if (ch.meals === 'all-inclusive') parts.push('all-inclusive');
  if (ch.bags === 'checked') parts.push('a checked bag per traveler');
  if (ch.bags === 'carry-on') parts.push('a carry-on');
  if (ch.transfer === 'yes') parts.push('airport transfers both ways');
  if (ch.cancel === 'refundable') parts.push('a refundable fare and rate');
  return parts;
}

function challengeReviewView(ctx, { ch, unknowns, theirDest, originCity, hotelName }) {
  const rows = challengerRows(ch, { theirDest, originCity, hotelName });
  const floor = fairFight(ch);
  const hidden = [...new URLSearchParams(challengerParams({ ...ch, locks: [] }))].map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  const lockable = LOCKS.filter(l => (l === 'stars' ? !!ch.stars : l === 'dates' ? !!ch.depart : l === 'meals' ? ch.meals !== UNKNOWN : true));
  const body = html`
<div class="container tb-chal-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/challenge?${challengerParams(ch)}">Challenge us</a> / <span aria-current="page">The trip to beat</span></nav>
  <header class="tb-results-head"><div><p class="eyebrow">Review the challenger</p><h1>What exactly are we trying to beat?</h1><p class="tb-results-sub">This is the trip as you described it. Anything you didn’t give is marked unknown, and stays unknown: we don’t fill gaps in your favor or ours. ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p></div></header>
  <div class="tb-chal-grid">
    <section class="tb-panel tb-challenger" aria-labelledby="ch-title">
      <h2 id="ch-title">${icon('flag')} The trip to beat</h2>
      <dl class="tb-challenger-rows">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd class="${v === null ? 'is-unknown' : ''}">${v === null ? 'Unknown' : v}</dd></div>`)}</dl>
      ${unknowns.length ? html`<p class="tb-small tb-muted">${plural(unknowns.length, 'item')} unknown: ${joinAnd(unknowns.map(u => UNKNOWN_LABELS[u]))}. We can still compare, and we won’t call anything a win until these are known. <a href="/challenge?${challengerParams(ch)}">Add what you know</a>.</p>` : html`<p class="tb-small tb-muted">Everything we need is here. <a href="/challenge?${challengerParams(ch)}">Change something</a>.</p>`}
    </section>
    <section class="tb-panel" aria-labelledby="fair-title">
      <h2 id="fair-title">${icon('shield')} Make it a fair fight</h2>
      <p>We compare like for like. Our version will carry ${floor.length ? joinAnd(floor) : 'the same length for the same travelers'}, and our price always includes taxes, mandatory fees and our service fee, so a lower number here is a lower number at checkout.</p>
      <p class="tb-muted tb-small">We don’t say “we saved you $300” unless the comparison supports it. If your deal is better, the verdict says so.</p>
    </section>
  </div>
  <form class="tb-panel tb-chal-modes" action="/challenge/result" method="get" aria-labelledby="how-title">
    ${hidden}
    <h2 id="how-title">${icon('sparkle')} How should we beat it?</h2>
    <div class="tb-modes">${Object.entries(MODES).map(([k, m]) => html`<button class="tb-mode" type="submit" name="mode" value="${k}"${k === 'surprise' && ch.locks.includes('dest') ? raw(' disabled') : ''}><b>${m.label}</b><span>${m.blurb}</span></button>`)}</div>
    <h3>${icon('lock')} Don’t touch these</h3>
    <p class="tb-muted tb-small">Everything your trip is known to include is already protected. Lock more if you want it kept in every mode.</p>
    <div class="tb-radio-row tb-radio-wrap">${lockable.map(l => html`<label><input type="checkbox" name="lock" value="${l}"${chk(ch.locks.includes(l))}> ${LOCK_WORD[l]}</label>`)}</div>
  </form>
</div>`;
  return layout({ title: 'The trip to beat', description: 'What we are trying to beat, and how.', active: 'challenge', body, ctx, noindex: true });
}

// ---- the scoreboard and the verdict --------------------------------------------------------------
function ourCancel(t) {
  const { items } = cutoffs(t);
  const f = items.find(i => i.key === 'flights'), h = items.find(i => i.key === 'hotel');
  const part = (label, it) => (it.cutoff ? `${label} free to cancel ${cutoffText(it.cutoff)}` : `${label} non-refundable`);
  return `${cap(part('flights', f))}; ${part('hotel', h)}`;
}
function rowText(row, { theirDest, ours }) {
  const unknown = 'Unknown';
  switch (row.key) {
    case 'price': return [`${money(row.theirs.value)} (${row.theirs.note})`, ours ? `${money(row.ours.value)} (everything included)` : null];
    case 'nights': return [plural(row.theirs, 'night'), ours ? plural(row.ours, 'night') : null];
    case 'dates': return [row.theirs ? longDate(row.theirs) : unknown, ours ? `${longDate(row.ours.depart)} – ${longDate(row.ours.back)}` : null];
    case 'dest': return [theirDest.name, ours ? ours.dest.name : null];
    case 'flight': return [WORD.flight[row.theirs], ours ? `${row.ours.stops ? `${row.ours.stops} stop` : 'Nonstop'}, ${hm(row.ours.durationMinutes)} each way, ${row.ours.name} fare` : null];
    case 'hotel': return [row.theirs ? `${row.theirs}-star` : unknown, ours ? `${row.ours.name} · ${row.ours.stars}-star · ${row.ours.rating}/5 · ${row.ours.area}` : null];
    case 'meals': return [WORD.meals[row.theirs], ours ? MEAL_WORD[row.ours] : null];
    case 'bags': return [WORD.bags[row.theirs], ours ? BAG_WORD[row.ours] : null];
    case 'transfer': return [WORD.transfer[row.theirs], ours ? (row.ours ? 'Included, both ways' : 'Not included') : null];
    case 'cancel': return [WORD.cancel[row.theirs], ours ? ourCancel(ours) : null];
    case 'taxes': return [WORD.taxes[row.theirs], ours ? 'Included' : null];
    default: return ['', ''];
  }
}
const MARK = { ours: ['check', 'Ours is ahead'], theirs: ['minus', 'Theirs is ahead'], same: ['check', 'Same'], diff: ['info', 'Different'], unknown: ['alert', 'Unknown'] };

function verdictBlock(out, { theirDest }) {
  const { verdict: v, ours, challenger: ch, cheapest, mode } = out;
  const ups = v.ups && v.ups.length ? joinAnd(v.ups.map(k => ROW_WORD[k])) : '';
  if (v.state === 'beat') {
    const less = ch.total - ours.total;
    return { cls: 'is-beat', title: 'We beat it.', text: mode === 'less'
      ? `Same ${theirDest.name}, ${plural(ours.spec.nights, 'night')}, everything you listed, for ${money(less)} less: ${money(ours.total)} with taxes, mandatory fees and our service fee in.`
      : `${cap(ups)} better, nothing worse on what you told us, for ${less > 0 ? `${money(less)} less` : 'the same money'}: ${money(ours.total)}, everything included.` };
  }
  if (v.state === 'tradeoff') {
    const diff = joinAnd(v.different.map(k => ROW_WORD[k]));
    const less = ch.total - ours.total;
    return { cls: 'is-tradeoff', title: 'We found a different trade-off.', text: `${ups ? `${cap(ups)} better` : 'Nothing worse on what you told us'}, ${less > 0 ? `${money(less)} less` : less === 0 ? 'the same money' : `${money(-less)} more`}, but ${diff} ${v.different.length === 1 ? 'is' : 'are'} different. That’s not a win we can call for you; it’s a choice.` };
  }
  if (v.state === 'info') {
    const onPaper = !ours ? 'We won’t call it either way until they are known.'
      : ours.total < ch.total ? `Our version is ${money(ours.total)} against your ${money(ch.total)}, ${money(ch.total - ours.total)} less on paper, but we won’t call that a win until those are known.`
        : `Our version is ${money(ours.total)} against your ${money(ch.total)}, so on what we know your deal is ahead on price; we won’t call it either way until those are known.`;
    return { cls: 'is-info', title: 'We need more information.', text: `We can compare, but ${plural(v.unknowns.length, 'item')} ${v.unknowns.length === 1 ? 'is' : 'are'} still unknown: ${joinAnd(v.unknowns.map(u => UNKNOWN_LABELS[u]))}. ${onPaper}` };
  }
  const reason = v.reason === 'none' ? `We couldn’t build a comparable version of this trip from ${theirDest.name}’s inventory on those dates, so we won’t pretend to.`
    : v.reason === 'dearer' ? `The cheapest version we can build that keeps everything you listed is ${money(cheapest.total)}, ${money(cheapest.total - ch.total)} more than yours. Your current deal is stronger than what we have right now.`
      : `We found ${cheapest && cheapest.total < ch.total ? 'cheaper versions' : 'other versions'}, but none that improves the trip within your money without giving something up. Keep your current trip.`;
  return { cls: 'is-keep', title: 'Your deal wins.', text: reason };
}

function otherModesList(out, ch, { theirDest }) {
  const line = (k, t) => {
    if (!t) return ({ less: 'no comparable version under your price', better: 'nothing improves it within your money', more: 'no extra night within your money', easier: 'nothing easier within your money', surprise: ch.locks.includes('dest') ? 'the destination is locked' : 'nowhere else beats it for the money' })[k];
    switch (k) {
      case 'less': return t.total < ch.total ? `${money(t.total)}, ${money(ch.total - t.total)} less` : `${money(t.total)}, ${money(t.total - ch.total)} more than yours`;
      case 'better': return `${money(t.total)}: ${t.hotel.stars}-star, ${t.flight.stops ? `${t.flight.stops} stop` : 'nonstop'}${t.transfer ? ', transfer included' : ''}`;
      case 'more': return `${plural(t.spec.nights, 'night')} for ${money(t.total)}`;
      case 'easier': return `${money(t.total)}: nonstop, ${hm(t.flight.durationMinutes)} each way${t.transfer ? ', transfer included' : ''}`;
      case 'surprise': return `${t.dest.name} for ${money(t.total)}`;
      default: return '';
    }
  };
  return html`<ul class="tb-list tb-other-modes">${Object.entries(MODES).filter(([k]) => k !== out.mode).map(([k, m]) => html`<li><a href="/challenge/result?${challengerParams(ch, { mode: k })}">${m.label}</a>: ${line(k, out.modes[k])}.</li>`)}</ul>`;
}

const PLUS_KEYS = ['nights', 'hotel', 'area', 'meals', 'flight', 'bags', 'experiences', 'transfer', 'flex', 'dest'];
function plusWords(plus) {
  const t = plus.trip;
  const rows = plus.changes ? plus.changes.improvements.filter(i => PLUS_KEYS.includes(i.key)) : [];
  if (rows.length) return joinAnd(rows.map(i => `${i.label.toLowerCase()}: ${i.b}`));
  return `${t.hotel.stars}-star ${t.hotel.name}, ${t.flight.stops ? `${t.flight.stops} stop` : 'nonstop'}${t.transfer ? ', transfer included' : ''}`;
}

function challengeResultView(ctx, { out, theirDest, originCity, user }) {
  const { challenger: ch, ours, rows, verdict: v, receipt, mode, plus } = out;
  const vb = verdictBlock(out, { theirDest });
  if (out.fallback) vb.text = `“${MODES[mode].label}” finds nothing within your money, but the same trip costs less. ${vb.text}`;
  const cx = { budget: ch.total, keep: 0, allowOver: 0, style: out.ctx.style, priority: 'hotel', nightsAsked: ch.nights, searchParams: null };
  const token = ours ? encodeSpec(ours.spec) : null;
  const tripUrl = token ? `/trip/${token}?${contextParams(cx)}` : null;
  const reviewUrl = `/challenge/review?${challengerParams(ch)}`;
  const protectedWords = fairFight(ch);
  const body = html`
<div class="container tb-chal-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/challenge?${challengerParams(ch)}">Challenge us</a> / <a href="${reviewUrl}">The trip to beat</a> / <span aria-current="page">${MODES[mode].label}</span></nav>
  <header class="tb-results-head"><div><p class="eyebrow">${MODES[mode].label}</p><h1>Their trip vs our challenger</h1><p class="tb-results-sub">${theirDest.name} from ${originCity} · ${plural(ch.nights, 'night')} · ${plural(ch.travelers, 'traveler')} · their price ${money(ch.total)}. ${protectedWords.length ? `Protected: ${joinAnd(protectedWords)}.` : ''} Prices are checked live each time this page loads. ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p></div></header>

  <section class="tb-verdict ${vb.cls}" aria-labelledby="verdict-title">
    <p class="eyebrow">The verdict</p>
    <h2 id="verdict-title">${vb.title}</h2>
    <p>${vb.text}</p>
    <div class="tb-card-actions">
      ${ours && v.state !== 'keep' ? html`<a class="btn btn-navy" href="${tripUrl}">${v.state === 'info' ? 'See our version anyway' : 'Take the challenger'} ${icon('arrow')}</a>` : ''}
      ${v.state === 'info' ? html`<a class="btn btn-ghost" href="/challenge?${challengerParams(ch)}">Add what you know</a>` : ''}
      ${v.state === 'keep' ? html`<a class="btn btn-navy" href="/">Keep my deal</a>` : html`<a class="btn btn-ghost" href="/">Keep my deal</a>`}
      <a class="btn btn-ghost" href="/challenge/result?${challengerParams(ch, { mode })}">Challenge it again</a>
    </div>
  </section>

  ${ours ? html`
  <section class="tb-panel" aria-labelledby="score-title">
    <h2 id="score-title">${icon('chart')} The scoreboard</h2>
    <div class="tb-compare-wrap"><table class="tb-compare tb-score">
      <thead><tr><th scope="col"><span class="sr-only">Row</span></th><th scope="col">Their trip</th><th scope="col">Our challenger</th><th scope="col"><span class="sr-only">Who is ahead</span></th></tr></thead>
      <tbody>${rows.map(r => { const [a, b] = rowText(r, { theirDest, ours }); const [ic, label] = MARK[r.who]; return html`<tr class="is-${r.who}"><th scope="row">${r.label}</th><td>${a}</td><td>${b}</td><td class="tb-score-mark"><span>${icon(ic)}<span>${label}</span></span></td></tr>`; })}</tbody>
    </table></div>
    <p class="tb-small tb-muted">Ours lists what is not in the price too: ${(ours.notIncluded || []).length ? joinAnd(ours.notIncluded.map(i => i.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase())) : 'nothing beyond what you pay at the destination'}. For theirs, anything not in their price is ${out.unknowns.length ? 'unknown to us' : 'whatever their page leaves out'}.</p>
  </section>

  ${receipt ? html`<section class="tb-panel tb-receipt" aria-labelledby="receipt-title">
    <h2 id="receipt-title">${icon('layers')} The challenge receipt</h2>
    <div class="tb-receipt-grid">
      <div><span>We kept</span><b>${receipt.kept.length ? joinAnd(receipt.kept.map(k => ROW_WORD[k] || k)) : 'nothing matched exactly'}</b></div>
      <div><span>We changed</span><b>${receipt.changed.length ? joinAnd(receipt.changed.map(k => ROW_WORD[k])) : 'nothing'}</b></div>
      ${receipt.unknown.length ? html`<div><span>Still unknown</span><b>${joinAnd(receipt.unknown.map(k => ROW_WORD[k]))}</b></div>` : ''}
      <div class="${receipt.diff < 0 ? 'is-over' : ''}"><span>${receipt.saving ? 'You keep' : receipt.diff < 0 ? 'Ours costs' : 'Stated price difference'}</span><b>${money(Math.abs(receipt.diff))}${receipt.diff < 0 ? ' more' : ''}</b>${!receipt.saving && receipt.diff > 0 ? html`<small>Not a saving until the unknowns are known.</small>` : ''}</div>
    </div>
  </section>` : ''}

  <details class="tb-why"><summary>${v.state === 'keep' ? 'Why is their deal better?' : v.state === 'beat' ? 'Why did we win?' : 'Where our money goes'}</summary>
    <p class="tb-small tb-muted">We don’t have their breakdown, so we can’t say which part of their price is high. Here is where ours goes:</p>
    <ul class="tb-why-list">${LINE_ORDER.filter(k => lineAmount(ours, k)).map(k => html`<li>${icon('info')}<span>${LINE_LABEL[k]}: ${money(lineAmount(ours, k))}</span></li>`)}</ul>
  </details>` : html`
  ${out.cheapest ? html`<details class="tb-why" open><summary>${v.state === 'keep' ? 'Why is their deal better?' : 'What we could build'}</summary>
    <p class="tb-small tb-muted">The cheapest version we can build that keeps everything you listed is ${money(out.cheapest.total)}: ${joinAnd(LINE_ORDER.filter(k => lineAmount(out.cheapest, k)).map(k => `${LINE_LABEL[k].toLowerCase()} ${money(lineAmount(out.cheapest, k))}`))}. We don’t have their breakdown, so we won’t invent a reason beyond that.</p>
  </details>` : ''}`}

  <section class="tb-panel" aria-labelledby="other-title">
    <h2 id="other-title">${icon('compass')} Other ways to beat it</h2>
    ${otherModesList(out, ch, { theirDest })}
    <h3>${icon('plus')} What $100 more can do</h3>
    ${plus ? html`<p>${plus.trip.total <= ch.total ? `You don’t need the $100: ${money(plus.trip.total)}, still ${money(ch.total - plus.trip.total)} under your price,` : `${money(plus.trip.total - ch.total)} more than your price (${money(plus.trip.total)} in all)`} buys ${plusWords(plus)}, with nothing given up${ours ? ' against our version' : ''}. <a href="/trip/${encodeSpec(plus.trip.spec)}?${contextParams({ ...cx, budget: ch.total + 10000 })}">See it</a>.</p>` : html`<p>Keep the $100. Nothing within $100 more improves this trip without giving something up.</p>`}
    ${ours && v.state !== 'keep' ? html`<h3>${icon('minus')} Save me $100 without ruining it</h3><p><a href="/trip/${token}/price?${contextParams(cx)}&target=${Math.max(1, Math.round(ours.total / 100) - 100)}">Name your price at ${dollars(ours.total - 10000)}</a>: every cheaper version of our challenger, with what each one gives up.</p>` : ''}
    <h3>${icon('lock')} Don’t touch these</h3>
    <p class="tb-small tb-muted">${ch.locks.length ? `Locked: ${joinAnd(ch.locks.map(l => LOCK_WORD[l].toLowerCase()))}.` : 'Nothing locked beyond what your trip is known to include.'} <a href="${reviewUrl}">Change the locks or the mode</a>.</p>
    <p class="tb-small tb-muted">${icon('share')} This page’s address holds only what you typed above, nothing private: share it, and a friend can run the same challenge from their own city or budget.</p>
  </section>
</div>`;
  return layout({ title: `${vb.title} ${theirDest.name} for ${dollars(ch.total)}`, description: 'Their trip against our challenger, row by row, with an honest verdict.', active: 'challenge', body, ctx, noindex: true });
}

module.exports = { challengeFormView, challengeReviewView, challengeResultView, challengerRows, fairFight };
