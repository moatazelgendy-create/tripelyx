// The planner (one question at a time) and the results page (three trips, never hundreds).
const { html, raw, jsonScript } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { addDays, today } = require('../../lib/dates');
const { encodeSpec } = require('../../trips/spec');
const { searchParams, contextParams, tradeoffs, WHO_DEFAULT } = require('../../trips/optimizer');
const { verdict, tripDiff, classifyChanges } = require('../../trips/decision');
const { lineDiff, LINE_LABEL } = require('../../trips/facts');
const { money, dollars, shortDate, longDate, plural, hm, demoBadge, budgetMeter, fitBadge } = require('./common');

// Items joined with commas and a final "or", as an array the template renders in order.
function joinOr(items) {
  return items.flatMap((it, i) => (i === 0 ? [it] : i === items.length - 1 ? [' or ', it] : [', ', it]));
}

const STEPS = ['budget', 'keep', 'from', 'who', 'n', 'when', 'style', 'prio'];
const STYLE_OPTIONS = [
  ['beach', 'Beach', 'palm'], ['city', 'City break', 'globe'], ['adventure', 'Adventure', 'compass'], ['romantic', 'Romantic', 'heart'],
  ['family', 'Family', 'users'], ['all-inclusive', 'All-inclusive', 'sun'], ['surprise', 'Surprise me', 'sparkle'],
];
const PRIO_OPTIONS = [
  ['hotel', 'Better hotel', 'Spend more of the budget on where you sleep.'], ['flights', 'Better flights', 'Nonstop and flexible fares first.'],
  ['longer', 'Longer stay', 'More nights, even in a simpler hotel.'], ['activities', 'More experiences', 'Fill the days, not just the nights.'],
  ['price', 'Lowest price', 'Keep as much of the budget as possible.'],
];
const WHO_OPTIONS = [['solo', 'Just me', 'user'], ['couple', 'Couple', 'heart'], ['family', 'Family', 'users'], ['friends', 'Friends', 'users']];

// Hidden inputs for every answer we already have, so each step is a plain GET form.
function carry(raw, except = []) {
  const keep = ['b', 'bt', 'k', 'from', 'who', 'n', 'when', 'depart', 'month', 'nights', 'style', 'prio', 'ov', 'dest'];
  return keep.filter(k => raw[k] !== undefined && raw[k] !== '' && !except.includes(k)).map(k => html`<input type="hidden" name="${k}" value="${String(raw[k]).slice(0, 60)}">`);
}

function choice(name, options) {
  return html`<div class="tb-choices">${options.map(([v, label, ic, sub]) => html`<button class="tb-choice" type="submit" name="${name}" value="${v}">${ic ? icon(ic) : ''}<b>${label}</b>${sub ? html`<small>${sub}</small>` : ''}</button>`)}</div>`;
}

function stepView(ctx, { step, raw: given, query, origins, dream }) {
  const idx = STEPS.indexOf(step);
  const total = STEPS.length - (['family', 'friends'].includes(given.who) ? 0 : 1);
  const greet = query.budgetInput ? html`<p class="tb-greet">${icon('sparkle')} Great — let’s turn <b>${dollars(query.budgetInput * 100)}</b> into the best trip possible.</p>` : '';
  const t = today();
  const months = Array.from({ length: 11 }, (_, i) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + i + 1); return d.toISOString().slice(0, 7); });
  const monthLabel = m => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
  const nightsSelect = html`<label>How many nights? <select name="nights" id="q-nights">${[2, 3, 4, 5, 6, 7, 8, 10, 14].map(n => html`<option value="${n}"${(Number(given.nights) || 5) === n ? raw(' selected') : ''}>${n}</option>`)}</select></label>`;
  const q = {
    budget: html`<h1>How much do you want to spend?</h1><p class="tb-q-sub">Your total for the whole trip: flights, hotel, experiences, taxes and fees. You can keep part of it aside for spending next.</p>
      <div class="tb-budget-input"><span class="tb-currency" aria-hidden="true">$</span><input id="q-b" name="b" type="text" inputmode="numeric" pattern="[0-9,]*" placeholder="1,500" value="${given.b || ''}" required autofocus aria-label="Budget in dollars"><button class="btn btn-blue btn-lg" type="submit">Continue ${icon('arrow')}</button></div>
      <div class="tb-radio-row" role="radiogroup" aria-label="Budget type"><label><input type="radio" name="bt" value="total"${given.bt !== 'pp' ? raw(' checked') : ''}> Total for everyone</label><label><input type="radio" name="bt" value="pp"${given.bt === 'pp' ? raw(' checked') : ''}> Per person</label></div>`,
    keep: html`<h1>Is ${dollars(query.budgetInput * 100)} just the booking, or the whole vacation?</h1><p class="tb-q-sub">If it is the whole vacation, say how much you want available after you land, for meals, getting around, tips and shopping. We build the booking around the rest and never count that money as spent. It is your number: we don’t say how much is enough.</p>
      ${choice('k', [['0', 'Just the booking', 'wallet', `Build the booking around ${dollars(query.budgetInput * 100)}`], ['200', 'The whole vacation, keep $200', 'lock', `Booking up to ${dollars((query.budgetInput - 200) * 100)}, $200 protected`], ['300', 'The whole vacation, keep $300', 'lock', `Booking up to ${dollars((query.budgetInput - 300) * 100)}, $300 protected`], ['500', 'The whole vacation, keep $500', 'lock', `Booking up to ${dollars((query.budgetInput - 500) * 100)}, $500 protected`]])}
      <div class="tb-inline-form"><label for="q-k">How much do you want available after you land?</label><div class="tb-budget-input tb-budget-input-sm"><span class="tb-currency" aria-hidden="true">$</span><input id="q-k" name="k" type="text" inputmode="numeric" pattern="[0-9,]*" placeholder="400" aria-describedby="q-k-hint"><button class="btn btn-ghost" type="submit">Protect it</button></div><p class="tb-muted tb-small" id="q-k-hint">Any amount under ${dollars(query.budgetInput * 100)}. The booking is built from what is left.</p></div>`,
    from: html`<h1>Where are you leaving from?</h1><p class="tb-q-sub">We check your city’s main airport, and tell you when a nearby one would save money.</p>${choice('from', origins.map(o => [o.id, o.city, null, o.airports.map(a => a.code).join(' · ')]))}`,
    who: html`<h1>Who’s traveling?</h1>${choice('who', WHO_OPTIONS.map(([v, l, ic]) => [v, l, ic, v === 'solo' ? '1 traveler' : v === 'couple' ? '2 travelers, one room' : v === 'family' ? 'Family rooms, no adults-only hotels' : 'Shared rooms, two to a room']))}`,
    n: html`<h1>How many travelers?</h1><p class="tb-q-sub">Including you.</p>${choice('n', [2, 3, 4, 5, 6, 7, 8].map(n => [String(n), String(n)]))}`,
    when: html`<h1>When do you want to go?</h1><p class="tb-q-sub">Flexible dates usually save money. We’ll show you the cheapest ones.</p>
      <p class="tb-inline-field tb-nights">${nightsSelect}</p>
      <div class="tb-when">
        <div class="tb-when-opt"><b>${icon('calendar')} Exact dates</b><label for="q-depart" class="sr-only">Departure date</label><input id="q-depart" type="date" name="depart" min="${addDays(t, 3)}" max="${addDays(t, 330)}" value="${given.depart || ''}"><button class="btn btn-navy" type="submit" name="when" value="exact">Use these dates</button></div>
        <div class="tb-when-opt"><b>${icon('calendar')} Flexible, in a month</b><label for="q-month" class="sr-only">Month</label><select id="q-month" name="month">${months.map(m => html`<option value="${m}"${given.month === m ? raw(' selected') : ''}>${monthLabel(m)}</option>`)}</select><button class="btn btn-navy" type="submit" name="when" value="flexible">Find the cheapest dates</button></div>
        <div class="tb-when-opt"><b>${icon('sparkle')} Anytime</b><p>We’ll pick the best-value dates in the next five months.</p><button class="btn btn-navy" type="submit" name="when" value="anytime">Anytime works</button></div>
      </div>`,
    style: html`<h1>What kind of trip sounds good?</h1>${choice('style', STYLE_OPTIONS.map(([v, l, ic]) => [v, l, ic]))}`,
    prio: html`<h1>What matters most?</h1><p class="tb-q-sub">We’ll put more of your budget there.</p>${choice('prio', PRIO_OPTIONS.map(([v, l, sub]) => [v, l, null, sub]))}`,
  }[step];

  const body = html`
<div class="container tb-plan">
  <p class="tb-progress" aria-label="Progress">Question ${Math.min(idx + 1 - (step === 'n' || idx > STEPS.indexOf('n') ? (['family', 'friends'].includes(given.who) ? 0 : 1) : 0), total)} of ${total}${dream ? html` · building around <b>${dream.name}</b>` : ''}</p>
  ${greet}
  <form class="tb-step" method="get" action="${dream ? '/dream' : '/plan'}" data-plan-step>
    ${carry(given, [step === 'when' ? 'when' : step, ...(step === 'when' ? ['depart', 'month', 'nights'] : []), ...(step === 'budget' ? ['bt', 'k'] : []), ...(step === 'who' ? ['n'] : [])])}
    ${q}
  </form>
  ${idx > 0 ? html`<p class="tb-back"><a href="${dream ? '/dream' : '/plan'}?${new URLSearchParams(Object.entries(given).filter(([k, v]) => v && k !== step && k !== STEPS[idx - 1] && !(STEPS[idx - 1] === 'when' && ['depart', 'month'].includes(k)))).toString()}">${icon('arrow-left')} Back</a></p>` : ''}
</div>`;
  return layout({ title: 'Build my trip', active: 'plan', body, ctx, scripts: ['/js/trips.js'], noindex: true, bodyClass: 'tb-plan-page' });
}

// ---- results ----------------------------------------------------------------------------------

function includedChips(t) {
  const chips = [`Round-trip flights${t.flight.stops ? '' : ' (nonstop)'}`, `${t.hotel.stars}-star ${t.hotel.features.allInclusive ? 'all-inclusive resort' : t.hotel.features.beachfront ? 'beachfront hotel' : 'hotel'}`];
  if (t.hotel.features.breakfast && !t.hotel.features.allInclusive) chips.push('Breakfast');
  if (t.transfer) chips.push('Airport transfer');
  if (t.activities.length) chips.push(plural(t.activities.length, 'experience'));
  chips.push('Taxes & fees');
  return chips;
}

// Why "Save more" costs less than our pick: the money line by line, then what it gives up, what is
// merely different and what is better, all from the two priced trips. When the data shows no
// trade-off, we say so instead of inventing one.
function saveMoreWhy(ours, t) {
  const ch = classifyChanges(ours, t, { date: longDate });
  const lines = lineDiff(ours, t).filter(l => l.delta !== 0);
  const row = r => `${r.label}: ${r.b} (our pick: ${r.a})`;
  return html`<details class="tb-why tb-vs"><summary>Why it’s ${money(ours.total - t.total)} cheaper than our pick</summary>
    <p class="tb-vs-title">Where the money differs</p>
    <ul class="tb-why-list tb-vs-lines">${lines.map(l => html`<li class="${l.delta < 0 ? 'is-less' : 'is-more'}">${icon(l.delta < 0 ? 'trend' : 'plus')}<span>${l.label}: ${l.delta < 0 ? `${money(-l.delta)} less` : `${money(l.delta)} more`} (${money(l.b)} here, ${money(l.a)} in our pick)</span></li>`)}</ul>
    ${ch.tradeoffs.length ? html`<p class="tb-tradeoff-title">What you give up</p><ul class="tb-tradeoff-list">${ch.tradeoffs.map(r => html`<li>${icon('minus')}<span>${row(r)}</span></li>`)}</ul>` : html`<p class="tb-small tb-muted">We didn’t find a trade-off against our pick in the data we have; what you’d give up is nothing we can name.</p>`}
    ${ch.neutral.length ? html`<p class="tb-vs-title">What’s just different</p><ul class="tb-why-list tb-vs-neutral">${ch.neutral.map(r => html`<li>${icon('info')}<span>${row(r)}</span></li>`)}</ul>` : ''}
    ${ch.improvements.length ? html`<p class="tb-vs-title">What’s better here</p><ul class="tb-why-list">${ch.improvements.map(r => html`<li>${icon('check')}<span>${row(r)}</span></li>`)}</ul>` : ''}
  </details>`;
}

function tripCard(p, q, cx, { over = false, rank, vs = null } = {}) {
  const t = p.trip;
  const token = encodeSpec(t.spec);
  const link = extra => `/trip/${token}?${contextParams(cx, extra)}`;
  const diff = q.budget - t.total;
  const tos = tradeoffs(t, cx);
  const v = verdict(t, cx, p);
  return html`<article class="tb-card${over ? ' tb-card-over' : ''}" aria-labelledby="card-${p.kind || rank}">
    <div class="tb-card-media"><img src="${t.dest.image.url}" alt="${t.dest.image.alt}" width="800" height="500" loading="${rank === 0 ? 'eager' : 'lazy'}">
      <span class="tb-kicker tb-kicker-on-media">${p.label}</span>
      <span class="tb-match" title="Overall match with your answers">${p.match}% match</span></div>
    <div class="tb-card-body">
      <p class="tb-card-fit">${fitBadge(v, { compact: true })} <span>${v.action}</span></p>
      <h2 id="card-${p.kind || rank}">${t.dest.name}, ${t.dest.country}</h2>
      <p class="tb-card-meta">${longDate(t.spec.depart)} – ${shortDate(t.flight.return)} · ${plural(t.spec.nights, 'night')} · ${plural(t.spec.travelers, 'traveler')}</p>
      <ul class="tb-card-facts">
        <li>${icon('plane')}<span>${t.flight.airline}: ${t.flight.stops ? `${t.flight.stops} stop` : 'nonstop'}, ${hm(t.flight.durationMinutes)} each way, ${t.flight.name} fare</span></li>
        <li>${icon('bed')}<span>${t.hotel.name} · ${'★'.repeat(t.hotel.stars)} · rated ${t.hotel.rating}/5 <small>(${t.hotel.ratingSource})</small> · ${t.hotel.area}</span></li>
        ${t.activities.length ? html`<li>${icon('flag')}<span>${t.activities.map(a => a.name).join(' · ')}</span></li>` : ''}
        ${t.transfer ? html`<li>${icon('bus')}<span>Private airport transfer, both ways</span></li>` : ''}
      </ul>
      <ul class="chips">${includedChips(t).map(c => html`<li class="chip chip-good">${icon('check')}${c}</li>`)}</ul>
      ${p.upgrade ? html`<p class="tb-card-upgrade">${icon('trend')}<span>+${money(p.upgrade.delta)} for ${p.upgrade.gets}${p.upgrade.over ? ', using the extra you allowed' : ''}</span></p>` : ''}
      <div class="tb-card-price">
        <div><span>Total, everything included</span><b>${money(t.total)}</b><small>${money(t.perTraveler)} per traveler · ${money(t.perNight)} per night</small></div>
        <div class="${diff < 0 ? 'is-over' : ''}"><span>${diff < 0 ? `Over your ${q.keep ? 'booking budget' : 'budget'}` : q.keep ? 'Unassigned' : 'You keep'}</span><b>${money(Math.abs(diff))}</b><small>of your ${money(q.budget)} ${q.keep ? 'booking budget' : 'budget'}${q.keep ? `, plus ${money(q.keep)} protected` : ''}</small></div>
      </div>
      ${vs && p.kind === 'save-more' && vs.total > t.total ? saveMoreWhy(vs, t) : ''}
      <details class="tb-why"><summary>Why we picked this${tos.length ? ' · trade-offs' : ''}</summary>
        <ul class="tb-why-list">${p.why.map(w => html`<li>${icon('check')}${w}</li>`)}</ul>
        ${tos.length ? html`<p class="tb-tradeoff-title">Trade-offs</p><ul class="tb-tradeoff-list">${tos.map(w => html`<li>${icon('minus')}${w}</li>`)}</ul>` : ''}
      </details>
      <div class="tb-card-actions">
        <a class="btn btn-ghost" href="${link()}">Customize trip</a>
        <a class="btn btn-navy" href="${link({ review: 1 })}">${over ? 'See why it’s worth it' : 'Book this trip'} ${icon('arrow')}</a>
      </div>
    </div>
  </article>`;
}

function answerStrip(q, raw) {
  const base = searchParams(q);
  const item = (label, value, drop) => html`<li><span>${label}</span><b>${value}</b><a href="/plan?${new URLSearchParams(Object.entries(Object.fromEntries(new URLSearchParams(base))).filter(([k]) => !drop.includes(k))).toString()}" aria-label="Change ${label.toLowerCase()}">change</a></li>`;
  return html`<ul class="tb-answers" aria-label="Your answers">
    ${item('Budget', `${dollars(q.vacationBudget)}${q.keep ? ` (keeping ${dollars(q.keep)})` : ''}`, ['b', 'k'])}
    ${item('From', raw.originCity, ['from'])}
    ${item('Travelers', `${q.travelers} · ${q.who}`, ['who', 'n'])}
    ${item('When', q.dateMode === 'exact' ? longDate(q.depart) : q.dateMode === 'flexible' ? `Flexible in ${new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${q.month}-01T00:00:00Z`))}` : 'Anytime', ['when', 'depart', 'month'])}
    ${item('Nights', String(q.nights), ['nights', 'when', 'depart', 'month'])}
    ${item('Style', q.style === 'surprise' ? 'Surprise me' : q.style, ['style'])}
    ${item('Matters most', (PRIO_OPTIONS.find(p => p[0] === q.priority) || [])[1], ['prio'])}
  </ul>`;
}

// What blocked the search, in the cheapest complete trip's own numbers: where its money goes, and
// how much of the budget the flights alone take. Facts from a priced package, nothing inferred.
function costWhy(q, result) {
  const cheap = result.closest && result.closest[0];
  if (!cheap) return '';
  const t = cheap.trip;
  const lines = t.lines.filter(l => l.amount > 0);
  const flights = (t.lines.find(l => l.key === 'flights') || { amount: 0 }).amount;
  const share = Math.round((flights / q.budget) * 100);
  return html`<p class="tb-cost-why"><b>What blocks it:</b> even the cheapest complete trip we built, ${t.dest.name} for ${plural(t.spec.nights, 'night')} with ${plural(t.spec.travelers, 'traveler')}, is ${money(t.total)}: ${lines.map(l => `${(LINE_LABEL[l.key] || l.label).toLowerCase()} ${money(l.amount)}`).join(', ')}. ${flights > q.budget ? `The flight fares alone are more than your ${dollars(q.budget)}.` : `The flight fares alone take ${share}% of your ${dollars(q.budget)}.`}</p>`;
}

function noDeadEnd(q, result, originCity, relax = null) {
  const base = searchParams(q);
  // Two relaxations that land on the same trip at the same price (two nights fewer landing on
  // the one-night-fewer pick under "a longer trip") are one answer, shown once.
  const works = relax ? relax.works.filter((w, i, all) => all.findIndex(o => o.dest === w.dest && o.nights === w.nights && o.total === w.total && o.over === w.over && o.used === w.used) === i) : [];
  const without = keys => `/plan?${new URLSearchParams(Object.entries(Object.fromEntries(new URLSearchParams(base))).filter(([k]) => !keys.includes(k))).toString()}`;
  // When the one-rule-away block is on the page, the single-rule links (length, style, priority,
  // 10% over) are either offered there with a real price or named as not enough alone; repeating
  // them here would offer what we just said does not work.
  const links = [
    ['Change dates', without(['when', 'depart', 'month'])],
    ...(relax ? [] : [['Shorten the trip', `/trips?${searchParams({ ...q, nights: Math.max(2, q.nights - 2) })}`]]),
    ...(q.dest || q.region ? [['Different destination', `/trips?${searchParams({ ...q, dest: null, region: null })}`]] : []),
    ...(!relax && q.style !== 'surprise' ? [['Relax one rule: any style', `/trips?${searchParams({ ...q, style: 'surprise' })}`]] : []),
    ...(!relax && q.priority !== 'price' ? [['Relax one rule: lowest price first', `/trips?${searchParams({ ...q, priority: 'price' })}`]] : []),
    ...(!relax && !q.allowOver ? [['Allow up to 10% more', `/trips?${searchParams({ ...q, allowOver: 10 })}`]] : []),
    ...(q.keep ? [['Protect less for the destination', without(['k'])]] : []),
    ['Increase budget', without(['b', 'k'])],
    ['Ask a trip specialist', `/custom-trip?budget=${q.budgetInput}&from=${encodeURIComponent(originCity)}&travelers=${q.travelers}`],
  ];
  return html`<div class="tb-advisor">
    <h2>We couldn’t build a trip that meets all your rules for ${dollars(q.budget)}${result.cheapest ? html`. Trips start at <b>${money(result.cheapest)}</b>` : ''}.</h2>
    ${q.keep ? html`<p class="tb-collision">${icon('lock')} Your vacation budget is ${dollars(q.vacationBudget)}. You protect ${dollars(q.keep)} for the destination, which leaves ${dollars(q.budget)} for the booking${result.cheapest ? `, and the cheapest complete trip we built is ${money(result.cheapest)}` : ''}. We don’t spend your reserve to make a booking fit; you can.</p>` : ''}
    ${works.length ? html`<h3 class="tb-relax-title">${icon('sparkle')} One rule away</h3>
    <p>We re-ran your search with exactly one rule relaxed at a time. These are the ones that really get there, each re-priced in full:</p>
    <ul class="tb-relax">${works.map(w => html`<li><a href="/trips?${w.params}"><span><b>${w.label}</b><small>Instead of ${w.rule}. Our pick becomes ${w.dest}, ${plural(w.nights, 'night')}${w.over ? `, ${money(w.over)} over your ${dollars(q.budget)}` : w.used ? `, a booking of ${money(w.total)} read against ${dollars(q.budget + w.used)}` : `, within your ${dollars(q.budget)}`}.</small></span><b>${money(w.total)}</b></a></li>`)}</ul>` : relax && relax.notAlone.length ? html`<p class="tb-muted">${icon('info')} We re-ran your search with each rule relaxed on its own (${relax.notAlone.map(n => n.label.toLowerCase()).join('; ')}). None of them gets there alone, so we won’t pretend one does.</p>` : relax ? html`<p class="tb-muted">${icon('info')} Your dates, length, style and priority are already as open as they go, so there is no single rule left to relax.</p>` : ''}
    ${works.length && relax.notAlone.length ? html`<p class="tb-muted tb-small">On their own, these don’t get there: ${relax.notAlone.map(n => n.label.toLowerCase()).join('; ')}.</p>` : ''}
    ${costWhy(q, result)}
    <p>${relax ? 'Here are the closest ones, and other ways to change the search.' : 'Here are the closest ones and the smallest changes that get there.'} We never hide an over-budget amount, and we never call a trip within budget when it isn’t.</p>
    <ul class="tb-advisor-links">${links.map(([l, h]) => html`<li><a class="btn btn-ghost btn-sm" href="${h}">${l}</a></li>`)}</ul>
  </div>`;
}

// "If it were our $1,500, this is the trip we'd book": the call, the three numbers (you gave us, we
// need, you keep), what almost won and why, what would change our mind, and the honest word on the
// money left over: an upgrade only when it earns its price, otherwise keep it.
// Which difference makes the runner-up lose, said in a sentence that follows "but".
function runnerReason(best, runner, rv, q) {
  if (runner.kind === 'upgrade') return `spending the extra ${money(runner.trip.total - best.trip.total)} is your call, not ours`;
  if (rv.diff !== null && rv.diff < 0) return `it’s ${money(-rv.diff)} over the ${dollars(q.budget)} you set`;
  if (rv.compromise) return rv.compromise;
  const d = tripDiff(best.trip, runner.trip).filter(r => r.changed && ['hotel', 'area', 'flight', 'nights', 'time', 'meals', 'experiences'].includes(r.key))[0];
  if (!d) return 'it fits your answers a little less well';
  return {
    hotel: `its hotel is ${d.b}`, area: `it’s in ${d.b}`, flight: `its flights are ${d.b}`, nights: `it’s ${d.b}`,
    time: `it leaves you ${d.b}`, meals: `meals are ${d.b.toLowerCase()}`, experiences: d.b === 'None' ? 'no experiences are included' : `it includes ${d.b}`,
  }[d.key];
}

// Why the third answer is "keep your money", from the counts the engine reports. Never a number
// that is not a priced package.
function keepSentence(keep, q) {
  const where = q.allowOver ? 'within the extra you allowed' : 'within your budget';
  let priced;
  if (!keep.considered) priced = `Nothing we built ${where} costs more than this one.`;
  else {
    const apart = [];
    if (keep.extras) apart.push(`${plural(keep.extras, 'version')} that only added an experience, a transfer or bags, which you can add yourself on the trip page`);
    if (keep.tooDear) apart.push(`${plural(keep.tooDear, 'trip')} that asked more than a third more for what ${keep.tooDear === 1 ? 'it' : 'they'} added`);
    priced = `We priced ${plural(keep.considered, 'more expensive trip')} ${where}. None improved on this one without giving something up${apart.length ? `, apart from ${apart.join(', and ')}` : ''}.`;
  }
  return `We couldn’t find a good reason to spend the other ${money(keep.spare)}. ${priced}`;
}

// The third card when no upgrade earns its price: not a trip, an honest answer.
function keepMoneyCard(keep, best, q, cx) {
  const url = `/trip/${encodeSpec(best.trip.spec)}?${contextParams(cx)}#unlock`;
  // The planner's smallest budget is $100; below that a second search is not an honest offer.
  const second = keep.spare >= 10000 ? `/plan?${new URLSearchParams({ b: String(Math.floor(keep.spare / 100)), from: q.origin, who: q.who, n: String(q.travelers) })}` : null;
  return html`<article class="tb-card tb-card-keep" aria-labelledby="card-keep">
    <div class="tb-card-body">
      <span class="tb-kicker">Instead of a third trip</span>
      <h2 id="card-keep">Keep your money</h2>
      <p class="tb-card-keep-sum"><b>${money(keep.spare)}</b> stays with you.</p>
      <p>${keepSentence(keep, q)}</p>
      <p class="tb-muted">Coming in under budget is a win, not a gap we fill.${second ? ` Or put it toward a second trip: the planner starts a new search at $${Math.floor(keep.spare / 100).toLocaleString('en-US')}.` : ''}</p>
      <div class="tb-card-actions">${second ? html`<a class="btn btn-navy" href="${second}">Start a second trip with it ${icon('arrow')}</a>` : ''}<a class="btn btn-ghost" href="${url}">See what a little more would buy anyway</a></div>
    </div>
  </article>`;
}

// "Our call": the trip we would book with this budget. Our pick is at or under the budget whenever
// anything is; only when the traveler allowed 10% more and nothing fits the budget itself is the
// call over, and then the headline says so instead of calling it a fit.
function decisionBand(picks, q, cx, keepMoney, result) {
  const graded = picks.map(p => ({ ...p, v: verdict(p.trip, cx, p) }));
  const best = graded.find(p => p.kind === 'our-pick') || graded[0];
  const bv = best.v;
  const upgrade = graded.find(p => p.kind === 'upgrade') || null;
  const runner = graded.find(p => p.kind === 'save-more') || upgrade || graded.find(p => p !== best) || null;
  const bestUrl = `/trip/${encodeSpec(best.trip.spec)}?${contextParams(cx)}`;
  const spare = q.budget - best.trip.total;
  const almost = runner ? html`<p><b>What almost won:</b> ${runner.trip.dest.name} (${runner.label}) at ${money(runner.trip.total)}${runner.trip.total < best.trip.total ? `, ${money(best.trip.total - runner.trip.total)} less` : runner.trip.total > best.trip.total ? `, ${money(runner.trip.total - best.trip.total)} more` : ''}, but ${runnerReason(best, runner, runner.v, q)}.</p>` : '';
  const mind = PRIO_OPTIONS.filter(([v]) => v !== q.priority).map(([v, l]) => html`<a href="/trips?${searchParams({ ...q, priority: v })}">${l.toLowerCase()}</a>`);
  const compare = `/compare?${new URLSearchParams([...picks.map(p => ['t', encodeSpec(p.trip.spec)]), ...picks.map(p => ['l', p.label]), ...new URLSearchParams(contextParams(cx))]).toString()}`;
  const name = `${best.trip.dest.name}${runner && runner.trip.dest.name === best.trip.dest.name ? ` (${best.label})` : ''}`;
  const ce = result && result.cheapestEligible && result.cheapestEligible.trip.total < best.trip.total ? result.cheapestEligible.trip : null;
  const headline = bv.grade === 'look'
    ? html`Nothing we built fits under ${dollars(q.budget)}. The ${ce ? 'strongest fit' : 'closest'} is <a href="${bestUrl}">${name}</a>, ${money(-bv.diff)} over${ce ? html`; the closest to your budget is <a href="/trip/${encodeSpec(ce.spec)}?${contextParams(cx)}">${ce.dest.name}</a>, ${money(ce.total - q.budget)} over` : ''}.`
    : html`If it were our ${dollars(q.budget)}, we’d book <a href="${bestUrl}">${name}</a>.`;
  const figures = html`<dl class="tb-keep${spare < 0 ? ' is-over' : ''}">
    <div><dt>${q.keep ? 'For the booking' : 'You gave us'}</dt><dd>${money(q.budget)}${q.keep ? html` <small>of ${money(q.vacationBudget)}, ${money(q.keep)} protected</small>` : ''}</dd></div>
    <div><dt>We need</dt><dd>${money(best.trip.total)}</dd></div>
    <div><dt>${spare < 0 ? 'Over by' : q.keep ? 'Unassigned' : 'You keep'}</dt><dd>${money(Math.abs(spare))}</dd></div>
  </dl>`;
  const money_ = upgrade
    ? html`<p class="tb-keep-note">${icon('trend')}<span>Spending ${money(upgrade.upgrade.delta)} more would get you ${upgrade.upgrade.gets}${upgrade.upgrade.over ? ` (that is ${money(upgrade.trip.total - q.budget)} over your budget, using the extra you allowed)` : ''}. Your call: <a href="#card-upgrade">see the upgrade below</a>, or ${spare > 0 ? `keep the ${money(spare)}` : 'keep it as it is'}.</span></p>`
    : keepMoney && keepMoney.spare > 0 ? html`<p class="tb-keep-note">${icon('check')}<span>${keepSentence(keepMoney, q)}</span></p>` : '';
  return html`<section class="tb-decide" aria-labelledby="decide-title">
    <p class="tb-kicker">Our call</p>
    <h2 id="decide-title">${headline}</h2>
    ${figures}
    <p>${bv.grade === 'look' ? bv.action : `The biggest win is ${bv.win}. ${bv.action}`}</p>
    ${money_}
    ${almost}
    <p><b>What would change our mind:</b> if ${joinOr(mind)} mattered most to you instead.</p>
    ${picks.length > 1 ? html`<p><a class="btn btn-ghost btn-sm" href="${compare}">${icon('layers')} Compare all ${picks.length} side by side</a></p>` : ''}
  </section>`;
}

function resultsView(ctx, { result, relax = null, originCity, user }) {
  const q = result.query, cx = { ...result.ctx, searchParams: searchParams(q) };
  const picks = result.picks;
  const over = picks.filter(p => p.trip.total > q.budget);
  const cheapest = result.cheapestEligible;
  const best = picks.find(p => p.kind === 'our-pick') || picks[0];
  const keepCard = !!(result.keepMoney && result.keepMoney.spare > 0 && !picks.some(p => p.kind === 'upgrade'));
  const WORDS = ['No', 'One', 'Two', 'Three'];
  const heading = !picks.length ? 'Let’s get closer to a trip that works.'
    : keepCard ? `${WORDS[picks.length]} ${picks.length === 1 ? 'trip' : 'trips'}, and a reason to keep your money.`
    : best.trip.total > q.budget ? `Nothing fits under ${dollars(q.budget)}. Here is the best we could build.`
    : picks.length === 1 ? `Here is the best trip for your ${dollars(q.budget)} budget.` : `Here are the ${picks.length} best trips for your ${dollars(q.budget)} budget.`;
  const cheapestNote = cheapest && best && cheapest.trip.total < best.trip.total - 2000 && !picks.some(p => p.trip === cheapest.trip)
    ? html`<aside class="tb-note"><b>Why we didn’t pick the cheapest.</b> The cheapest trip we built is ${money(cheapest.trip.total)} (${cheapest.trip.dest.name}, ${plural(cheapest.trip.spec.nights, 'night')}), ${money(best.trip.total - cheapest.trip.total)} less than our pick, but ${tradeoffs(cheapest.trip, cx).slice(0, 3).map(s => s.toLowerCase()).join(', ') || 'it fits your answers less well'}. <a href="/trip/${encodeSpec(cheapest.trip.spec)}?${contextParams(cx)}">See it anyway</a> — you decide whether the saving is worth it.</aside>` : '';
  const body = html`
<div class="container tb-results">
  <header class="tb-results-head">
    <div>
      <p class="eyebrow">Your trips</p>
      <h1>${heading}</h1>
      <p class="tb-results-sub">From ${originCity} · ${plural(q.travelers, 'traveler')} · we priced ${result.considered.toLocaleString('en-US')} combinations across ${plural(result.destinations, 'destination')} and kept the best. ${q.keep ? `Your ${dollars(q.vacationBudget)} is the whole vacation: ${dollars(q.keep)} is protected for after you land, so ${picks.length && !over.length ? `every trip here is a booking of ${dollars(q.budget)} or less` : `every trip here is read against a ${dollars(q.budget)} booking budget, and anything marked over it would use your reserve`}.` : ''} ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p>
    </div>
    ${answerStrip(q, { originCity })}
  </header>
  <div class="tb-flex" role="group" aria-label="Budget flexibility">
    <a class="tb-flex-opt${!q.allowOver ? ' is-on' : ''}" href="/trips?${searchParams({ ...q, allowOver: 0 })}" ${!q.allowOver ? raw('aria-current="true"') : ''}>${icon('lock')} Stay under my budget</a>
    <a class="tb-flex-opt${q.allowOver ? ' is-on' : ''}" href="/trips?${searchParams({ ...q, allowOver: 10 })}" ${q.allowOver ? raw('aria-current="true"') : ''}>${icon('trend')} I can spend up to 10% more</a>
  </div>
  <div class="tb-building-wrap" data-results>
    <ol class="tb-building tb-building-page" data-building aria-live="polite">
      <li>Finding destinations within your budget…</li><li>Checking flight options…</li><li>Finding the best hotels…</li><li>Optimizing your ${dollars(q.budget)}…</li><li>Deciding what’s worth your money…</li>
    </ol>
    <div data-results-body>
      ${picks.length ? decisionBand(picks, q, cx, result.keepMoney, result) : ''}
      ${picks.length ? html`<div class="tb-cards">${picks.map((p, i) => tripCard(p, q, cx, { over: p.trip.total > q.budget, rank: i, vs: best.trip }))}${keepCard ? keepMoneyCard(result.keepMoney, best, q, cx) : ''}</div>` : ''}
      ${over.length ? html`<p class="tb-over-note">${icon('info')} Trips marked “over your ${q.keep ? 'booking budget' : 'budget'}” use the extra 10% you allowed${q.keep ? ', which would come out of what you protected' : ''}. Switch to “Stay under my budget” to hide them.</p>` : ''}
      ${cheapestNote}
      ${!picks.length ? html`${noDeadEnd(q, result, originCity, relax)}
        ${result.closest.length ? html`<h2 class="tb-closest-title">The closest we could get</h2><div class="tb-cards">${result.closest.map((p, i) => tripCard({ ...p, label: 'Closest option', why: [`${money(p.trip.total - q.budget)} over your ${dollars(q.budget)} budget`, ...p.trip.included.slice(0, 2)] }, q, cx, { over: true, rank: i }))}</div>` : ''}` : ''}
      ${picks.length ? html`<section class="tb-more" aria-label="Other options">
        <h2>Not quite right?</h2>
        <ul class="tb-advisor-links">
          <li><a class="btn btn-ghost btn-sm" href="/trips?${searchParams({ ...q, nights: Math.min(14, q.nights + 1) })}">Add a night</a></li>
          <li><a class="btn btn-ghost btn-sm" href="/trips?${searchParams({ ...q, nights: Math.max(2, q.nights - 1) })}">One night shorter</a></li>
          <li><a class="btn btn-ghost btn-sm" href="/plan?${new URLSearchParams(Object.entries(Object.fromEntries(new URLSearchParams(searchParams(q)))).filter(([k]) => k !== 'style')).toString()}">Change the style</a></li>
          <li><a class="btn btn-ghost btn-sm" href="/plan?${new URLSearchParams(Object.entries(Object.fromEntries(new URLSearchParams(searchParams(q)))).filter(([k]) => k !== 'prio')).toString()}">Change what matters most</a></li>
          <li><a class="btn btn-ghost btn-sm" href="/custom-trip?budget=${q.budgetInput}&from=${encodeURIComponent(originCity)}&travelers=${q.travelers}">Ask a trip specialist</a></li>
          ${!user ? html`<li><a class="btn btn-ghost btn-sm" href="/signin?next=${encodeURIComponent(`/trips?${searchParams(q)}`)}">Sign in to save trips</a></li>` : ''}
        </ul>
      </section>` : ''}
    </div>
  </div>
</div>
<script type="application/json" id="tb-results-data">${jsonScript({ budget: q.budget, picks: picks.map(p => ({ dest: p.trip.dest.name, total: p.trip.total })) })}</script>`;
  return layout({ title: picks.length ? `${plural(picks.length, 'trip')} for ${dollars(q.budget)}` : 'Your trips', active: 'plan', body, ctx, scripts: ['/js/trips.js'], noindex: true });
}

module.exports = { stepView, resultsView, tripCard, STEPS, STYLE_OPTIONS, PRIO_OPTIONS, WHO_OPTIONS, WHO_DEFAULT };
