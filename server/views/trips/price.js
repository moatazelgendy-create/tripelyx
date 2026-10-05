// Name your price: the traveler names what they'd love to pay for this trip and we search downward,
// stopping at the cheapest version that is still strong. Three honest answers (we got there; we can
// but we don't think we should; no version gets there), each with the value ladder and a real next
// step. Every number on this page is a priced package; nothing is estimated.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { contextParams, searchParams } = require('../../trips/optimizer');
const { encodeSpec } = require('../../trips/spec');
const { tripDiff, verdict } = require('../../trips/decision');
const { money, dollars, longDate, plural, demoBadge, fitBadge } = require('./common');

const dateSpan = t => `${longDate(t.spec.depart)} – ${longDate(t.flight.return)}`;
// The engine's rows carry ISO dates; the page shows them the way the rest of the site does.
const fmtRow = (r, a, b) => (r.key === 'dates' ? { ...r, a: dateSpan(a), b: dateSpan(b) } : r);

// What changed between the current trip and a candidate: trade-offs first, then plain differences,
// then anything that happens to get better.
function changedList(t, c) {
  const rows = [...c.changes.tradeoffs.map(r => ({ ...fmtRow(r, t, c.trip), kind: 'tradeoff' })), ...c.changes.neutral.map(r => ({ ...fmtRow(r, t, c.trip), kind: 'neutral' })), ...c.changes.improvements.map(r => ({ ...fmtRow(r, t, c.trip), kind: 'improvement' }))];
  if (!rows.length) return html`<p class="tb-muted">Nothing about the trip itself changes.</p>`;
  return html`<ul class="tb-price-changes">${rows.map(r => html`<li class="is-${r.kind}">${icon(r.kind === 'tradeoff' ? 'minus' : r.kind === 'improvement' ? 'plus' : 'sliders')}<span><b>${r.label}:</b> ${r.a} → ${r.b}</span></li>`)}</ul>`;
}

// What stays the same, as chips: the things a traveler is most afraid of losing.
function unchangedChips(t, c) {
  const same = new Set(tripDiff(t, c.trip).filter(r => !r.changed).map(r => r.key));
  const chips = [];
  if (same.has('dest')) chips.push(`Still ${t.dest.name}`);
  if (same.has('dates')) chips.push('Same dates');
  if (same.has('nights')) chips.push(plural(t.spec.nights, 'night'));
  if (same.has('hotel')) chips.push(`Same hotel (${t.hotel.name})`);
  if (same.has('flight')) chips.push(t.flight.stops ? 'Same flights' : 'Still nonstop');
  if (same.has('experiences') && t.activities.length) chips.push(`${plural(t.activities.length, 'experience')} kept`);
  if (same.has('transfer') && t.transfer) chips.push('Transfer kept');
  if (!chips.length) return '';
  return html`<h3>Unchanged</h3><ul class="tb-chips">${chips.map(x => html`<li>${icon('check')}${x}</li>`)}</ul>`;
}

// "It means: ..." for a version we don't recommend: its compromises for this traveler, then what it gives up.
function meansList(c) {
  const texts = [...new Set([...c.compromises.filter(x => x.w >= 2).map(x => x.text), ...c.changes.tradeoffs.map(r => `${r.label.toLowerCase()}: ${r.b}`)])];
  return texts.length ? html`<ul class="tb-list">${texts.map(x => html`<li>${x}</li>`)}</ul>` : '';
}

function ladderView(t, ladder, cx, picks) {
  return html`<section class="tb-panel" aria-labelledby="ladder-title">
    <h2 id="ladder-title">${icon('layers')} The value ladder</h2>
    <p class="tb-muted">Every version of this trip we priced, from what you have down to the cheapest we can build. Each one is a complete package, taxes and fees included. Strong means no step down from the trip you have on anything you said matters.</p>
    <ol class="tb-ladder">${ladder.map(r => {
      const row = r.noteRow ? fmtRow(r.noteRow, t, r.trip) : null;
      const url = r.current ? `/trip/${encodeSpec(t.spec)}?${contextParams(cx)}` : `/trip/${encodeSpec(r.trip.spec)}?${contextParams(cx)}`;
      return html`<li class="${r.cliff ? 'is-cliff' : ''}${r.current ? ' is-current' : ''}"><b><a href="${url}">${money(r.total)}</a></b><div><span class="tb-rung tb-rung-${r.label}">${r.labelText}</span>${r.current ? html`<span class="tb-rung tb-rung-now">Your trip now</span>` : ''}${picks.has(r.total) ? html`<span class="tb-rung tb-rung-pick">${picks.get(r.total)}</span>` : ''}<small>${r.current ? `${r.trip.hotel.name} · ${r.trip.flight.stops ? `${r.trip.flight.stops}-stop` : 'nonstop'} · ${plural(r.trip.spec.nights, 'night')}` : row ? `${row.label}: ${row.b}` : `${money(-r.delta)} less`}</small></div></li>`;
    })}</ol>
  </section>`;
}

function priceView(ctx, { data, cx, user }) {
  const { current, target, recommended, floor, anyway, ladder, cheapest, considered } = data;
  const t = current.trip, token = current.token, s = t.spec;
  const tripUrl = (tok, hash = '') => `/trip/${tok}?${contextParams(cx)}${hash}`;
  const keepUrl = tripUrl(token);
  const picks = new Map();
  if (recommended) picks.set(recommended.total, 'Our answer');
  else if (floor) picks.set(floor.total, 'Where we’d stop');
  if (anyway) picks.set(anyway.total, 'Your price');
  const demo = demoBadge(ctx.tripService.demo, 'Demo inventory and prices');
  const pricedLine = `We priced ${plural(considered, 'cheaper version')} of this trip in full.`;

  let head, main;
  if (recommended) {
    const r = recommended;
    const left = target - r.total;
    const v = verdict(r.trip, { ...cx, budget: null }, r.scores);
    head = html`<h1>You named ${dollars(target)}. We got there: ${money(r.total)}, and it’s still a strong trip.</h1>
      <p class="tb-results-sub">${pricedLine} This is the cheapest version that is no step down on anything you told us matters. ${left > 0 ? `That leaves ${money(left)} of your ${dollars(target)}.` : ''} ${demo}</p>`;
    main = html`<section class="tb-panel" aria-labelledby="after-title">
      <h2 id="after-title">${icon('check')} Before and after</h2>
      <dl class="tb-keep"><div><dt>Before</dt><dd>${money(t.total)}</dd></div><div><dt>After</dt><dd>${money(r.total)}</dd></div><div><dt>You save</dt><dd>${money(t.total - r.total)}</dd></div></dl>
      <div class="tb-price-grid">
        <div><h3>What changed</h3>${changedList(t, r)}</div>
        <div>${unchangedChips(t, r)}<h3>Our verdict on it</h3><p>${fitBadge(v, { compact: true })} ${v.action}</p></div>
      </div>
      <div class="tb-price-actions">
        <a class="btn btn-navy" href="${tripUrl(r.token)}">Use this version · ${money(r.total)} ${icon('arrow')}</a>
        <a class="btn btn-ghost" href="${keepUrl}">Keep my original · ${money(t.total)}</a>
      </div>
    </section>`;
  } else if (anyway) {
    const a = anyway;
    const cliffRung = ladder.find(r => r.cliff);
    const cliffText = a.compromises.find(x => x.w >= 3)?.text || (a.changes.tradeoffs[0] ? `${a.changes.tradeoffs[0].label.toLowerCase()}: ${fmtRow(a.changes.tradeoffs[0], t, a.trip).b}` : null) || (cliffRung && cliffRung.noteRow ? `${cliffRung.noteRow.label.toLowerCase()}: ${fmtRow(cliffRung.noteRow, t, cliffRung.trip).b}` : null);
    head = html`<h1>We can make it cheaper. We don’t think we should.</h1>
      <p class="tb-results-sub">${pricedLine} There is a ${money(a.total)} version at or under your ${dollars(target)}, but it gives up something you told us matters. ${demo}</p>`;
    main = html`<section class="tb-panel" aria-labelledby="floor-title">
      <h2 id="floor-title">${icon('shield')} Where we’d stop</h2>
      ${floor ? html`<p>The cheapest version we’d still recommend is <b>${money(floor.total)}</b>, ${money(t.total - floor.total)} less than now.</p>
        <dl class="tb-keep"><div><dt>Now</dt><dd>${money(t.total)}</dd></div><div><dt>Where we’d stop</dt><dd>${money(floor.total)}</dd></div><div><dt>You save</dt><dd>${money(t.total - floor.total)}</dd></div></dl>
        <h3>What changes at ${money(floor.total)}</h3>${changedList(t, floor)}${unchangedChips(t, floor)}
        ${cliffText ? html`<p class="tb-price-cliff">${icon('alert')}<span>Below ${money(floor.total)} the trip starts losing things you said matter: ${cliffText}.</span></p>` : ''}
        <div class="tb-price-actions"><a class="btn btn-navy" href="${tripUrl(floor.token)}">Use the ${money(floor.total)} version ${icon('arrow')}</a><a class="btn btn-ghost" href="${keepUrl}">Keep my original · ${money(t.total)}</a></div>`
      : html`<p>${data.currentLabel === 'strong' ? `This ${money(t.total)} trip is already the cheapest version we’d recommend.` : `This trip already has compromises for what you told us, and every cheaper version adds more.`} ${cliffText ? `Below ${money(t.total)} it starts losing things you said matter: ${cliffText}.` : ''}</p>
        <div class="tb-price-actions"><a class="btn btn-navy" href="${keepUrl}">Keep my trip at ${money(t.total)} ${icon('arrow')}</a>${cx.searchParams ? html`<a class="btn btn-ghost" href="/trips?${cx.searchParams}">Back to my three trips</a>` : ''}</div>`}
      <div class="tb-price-anyway">
        <p><b>Your price, if you want it anyway.</b> The best version we can build at or under ${dollars(target)} is ${money(a.total)} (${a.labelText.toLowerCase()}). It means:</p>
        ${meansList(a)}
        <a class="btn btn-ghost" href="${tripUrl(a.token)}">Show me the ${money(a.total)} version anyway</a>
      </div>
    </section>`;
  } else {
    const c = cheapest;
    const q = { budgetInput: Math.round(target / 100), keep: 0, budgetType: 'total', origin: s.from, who: s.who, travelers: s.travelers, dateMode: 'anytime', nights: s.nights, style: cx.style, priority: cx.priority, allowOver: cx.allowOver };
    head = html`<h1>No version of this trip gets to ${dollars(target)}.</h1>
      <p class="tb-results-sub">${pricedLine} ${c ? html`The cheapest we can build is <b>${money(c.total)}</b>${c.changes.tradeoffs.length ? ` (${c.changes.tradeoffs.map(r => fmtRow(r, t, c.trip).b.toLowerCase()).slice(0, 3).join(', ')})` : ''}, and that is ${money(c.total - target)} over your price.` : 'Nothing about this trip can be removed or swapped for less with the inventory we have.'} ${demo}</p>`;
    main = html`<section class="tb-panel" aria-labelledby="next-title">
      <h2 id="next-title">${icon('compass')} What would get you to ${dollars(target)}</h2>
      <p class="tb-muted">None of these is a dead end. Every one is a real search or a real change you can make now.</p>
      <ul class="tb-changes">
        <li><a href="/trips?${searchParams(q)}"><span>Try another destination for ${dollars(target)}</span><span class="tb-delta tb-delta-same">new search</span><small>Same travelers and length from ${current.origin ? current.origin.city : s.from}; we build the three best trips for that money.</small></a></li>
        <li><a href="${tripUrl(token, '#dates')}"><span>Change dates</span><span class="tb-delta tb-delta-same">customizer</span><small>Nearby departures, each with its real new total.</small></a></li>
        <li><a href="${tripUrl(token, '#nights')}"><span>Shorten the trip</span><span class="tb-delta tb-delta-same">customizer</span><small>Fewer nights, priced in full.</small></a></li>
        ${c ? html`<li><a href="${tripUrl(encodeSpec(c.trip.spec))}"><span>See the cheapest version, ${money(c.total)}</span><span class="tb-delta tb-delta-save">−${money(t.total - c.total)}</span><small>${c.labelText}${c.changes.tradeoffs[0] ? `: ${c.changes.tradeoffs.map(r => fmtRow(r, t, c.trip).b).slice(0, 3).join(' · ')}` : ''}</small></a></li>` : ''}
      </ul>
      <div class="tb-price-actions"><a class="btn btn-navy" href="${keepUrl}">Keep my trip at ${money(t.total)} ${icon('arrow')}</a><a class="btn btn-ghost" href="/custom-trip?budget=${Math.round(target / 100)}&from=${current.origin ? encodeURIComponent(current.origin.city) : ''}&travelers=${s.travelers}&dest=${encodeURIComponent(t.dest.name)}">Ask a trip specialist</a></div>
    </section>`;
  }

  const body = html`
<div class="container tb-results tb-price-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / ${cx.searchParams ? html`<a href="/trips?${cx.searchParams}">Your trips</a> / ` : ''}<a href="${keepUrl}">${t.dest.name}</a> / <span aria-current="page">Name your price</span></nav>
  <header class="tb-results-head"><div><p class="eyebrow">Name your price</p>${head}</div></header>
  ${main}
  ${ladderView(t, ladder, cx, picks)}
  <p class="tb-muted tb-small">Every total on this page is a complete trip we priced just now, taxes and fees included. Nothing changes unless you choose it, and nothing is charged until you confirm.</p>
</div>`;
  return layout({ title: `Name your price · ${t.dest.name}`, active: 'plan', body, ctx, scripts: ['/js/trips.js'], noindex: true });
}

module.exports = { priceView };
