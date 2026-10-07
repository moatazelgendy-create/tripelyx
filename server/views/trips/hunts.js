// The AI Savings Hunter's pages: the list, the form, and the hunt page. Every sentence here is about
// a stored fact of the hunt record or a priced trip in it; every number is one of those or arithmetic
// on two of them. Nothing is urgent, nothing is scarce, nothing is predicted: when there is nothing to
// say, the page says so in the run log and stops there.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { contextParams, STYLES } = require('../../trips/optimizer');
const hunter = require('../../trips/hunter');
const { monthClosed } = require('../../trips/hunts');
const { money, plural, demoBadge } = require('./common');

const SIGNATURE = ['Don’t watch prices. Let AI watch your money.', 'Tell us your max. We’ll wait for the right trip.', 'No spam. No fake deals. Just a reason to travel.'];
const STEP = 5000; // the $50 step "find me something even better" moves by (the service's own)
// The service's own length and hotel rules (server/trips/hunts.js validate and answer): a blank "up to"
// is EXTRA_NIGHTS above the minimum but never above MAX_NIGHTS, the longest trip the inventory prices,
// so the form says the cap rather than promising three more nights to a 13-night minimum; MAX_STARS is
// the highest class it prices, above which "better hotel" is refused rather than announced.
const MAX_NIGHTS = 14, EXTRA_NIGHTS = 3, MAX_STARS = 5;
// What a check asks for, in the engine's own terms (hunter.windowDates, optimizer.candidateDates): fares
// for every second day of an anytime window, every day of a chosen month, then the two cheapest dates
// per destination and length priced in full. Never "every departure": half the days of an anytime
// window are not asked, and a page may not imply a search that did not occur.
const SEARCH_WORDS = 'asks the suppliers for fares on every second day of your window (every day of a chosen month), prices the two cheapest dates per destination and length in full';
// A stopped hunt is never priced (HuntService.run, refresh and runDue all skip it; an answer changes
// its rules but searches nothing), so its pages promise no check: the words below replace every
// monitoring or re-check sentence while the status is not "hunting".
const STOPPED_WORDS = 'This hunt is stopped: nothing is checked, on open or on schedule, until you resume it.';
const ALL_STOPPED_WORDS = 'All your hunts are stopped: nothing is checked, on open or on schedule, until you resume one.';
const STYLE_WORD = { beach: 'Beach', city: 'City', adventure: 'Adventure', romantic: 'Romantic', family: 'Family', 'all-inclusive': 'All-inclusive', surprise: 'Anywhere (surprise me)' };
const WHO_WORD = { couple: 'A couple', solo: 'Just me', family: 'Family', friends: 'Friends' };
const DEFAULT_NOTIFY = ['under', 'drop', 'extra-night', 'nonstop', 'quality', 'destination'];
const IMPROVE = [['price', 'Lower price'], ['hotel', 'Better hotel'], ['nights', 'More nights'], ['nonstop', 'Nonstop'], ['destination', 'Different destination']];
const REASON_WORD = { created: 'first check', opened: 'when you opened it', scheduled: 'on schedule', manual: 'on request', updated: 'after you changed the rules' };
const OPP_STATUS = { new: 'New', seen: 'Seen', rejected: 'Rejected', taken: 'Taken' };
const MAY_CHANGE = 'Price and availability may change.';

const stampFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const stamp = iso => (iso ? `${stampFmt.format(new Date(iso))} UTC` : '');
const monthName = m => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
const stopsText = n => (n === 0 ? 'Nonstop' : plural(n, 'stop'));
const opps = n => `${n} ${n === 1 ? 'opportunity' : 'opportunities'}`;
const tripLink = (token, hunt) => `/trip/${token}?${contextParams({ budget: hunt.budget })}`;
const isNum = v => Number.isFinite(v);
// The next $50 step at least $50 below a total: the same arithmetic the service uses for "harder".
function nextStep(from) {
  let target = Math.floor((from - 1) / STEP) * STEP;
  if (from - target < STEP) target -= STEP;
  return Math.max(target, STEP);
}
const thresholdWords = t => (isNum(t) ? `${money(t)} or more` : 'only what the AI would actually recommend');
function notifyWords(hunt) {
  const T = hunt.threshold;
  const words = {
    under: `a good trip is under ${money(hunt.budget)}`, 'beat-saved': 'you beat my saved trip',
    drop: `the same trip drops${isNum(T) ? ` by ${money(T)} or more` : ''}`, 'extra-night': 'I can get an extra night without spending more',
    nonstop: 'a nonstop option enters my budget', quality: 'same money, better hotel', destination: 'a new destination enters my budget',
  };
  return (hunt.notify || []).map(k => words[k]).filter(Boolean);
}

function huntStatus(status) {
  return html`<span class="hu-status is-${status === 'hunting' ? 'hunting' : 'stopped'}">${status === 'hunting' ? 'HUNTING' : 'STOPPED'}</span>`;
}

// ---- the list rows (the hunts page and My Trips) ------------------------------------------------
function huntRows(hunts, { destName = id => id } = {}) {
  return html`<ul class="hu-list">${hunts.map(h => {
    const s = h.summary || {};
    const best = h.baseline && h.baseline.best ? h.baseline.best : null;
    return html`<li class="hu-row">
      <div>
        <p class="tb-kicker">${huntStatus(h.status)}${s.newOpportunities ? html` · <span class="hu-new">${opps(s.newOpportunities)} to look at</span>` : ''}</p>
        <h3><a href="/hunts/${h.id}">${h.name}</a></h3>
        <p>Best current opportunity: ${best ? html`<b>${money(best.total)}</b> (${plural(best.nights, 'night')} in ${destName(best.dest)})` : html`<span class="tb-muted">${h.baseline ? 'nothing qualifies yet' : 'not checked under these rules yet'}</span>`} · Potential money kept: <b>${best ? money(h.budget - best.total) : '—'}</b></p>
        <p class="tb-small tb-muted">Last meaningful improvement: ${h.lastMeaningfulAt ? stamp(h.lastMeaningfulAt) : 'none yet'} · Last checked: ${h.lastRunAt ? stamp(h.lastRunAt) : 'not yet'}</p>
      </div>
      <a class="btn btn-ghost btn-sm" href="/hunts/${h.id}">Open hunt ${icon('arrow')}</a>
    </li>`;
  })}</ul>`;
}

// ---- the list page ------------------------------------------------------------------------------
function huntsListView(ctx, { hunts, user, monitoring, destName }) {
  const body = html`
<div class="container hu-page">
  <header class="tb-results-head"><div><p class="eyebrow">AI Savings Hunter</p><h1>${hunts.length ? 'Your hunts' : SIGNATURE[0]}</h1>
    <p class="tb-results-sub">${hunts.length ? 'Each hunt has its own limit and rules, and says something only when a trip meets them.' : SIGNATURE[1]} ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p></div>
    <a class="btn btn-navy" href="/hunts/new">${icon('search')} ${hunts.length ? 'Start another hunt' : 'Start a hunt'}</a></header>
  ${hunts.length ? huntRows(hunts, { destName }) : html`<section class="hu-empty">
    <ul class="hu-signature">${SIGNATURE.slice(2).map(l => html`<li>${l}</li>`)}</ul>
    <p>You set the ceiling and the rules. The hunt ${SEARCH_WORDS}, tries to beat its own best before showing it, and interrupts you only for a trip that meets your rules and is worth your attention.</p>
    <p class="tb-small tb-muted">${monitoring}</p>
    <a class="btn btn-navy btn-lg" href="/hunts/new">Tell us your max ${icon('arrow')}</a>
  </section>`}
  ${hunts.length ? html`<p class="hu-monitoring tb-small tb-muted">${hunts.some(h => h.status === 'hunting') ? monitoring : ALL_STOPPED_WORDS}</p>` : ''}
  <p class="tb-small"><a href="/my-trips">Back to My Trips</a></p>
</div>`;
  return layout({ title: 'Your hunts', active: 'my-trips', body, ctx, noindex: true });
}

// ---- the form -----------------------------------------------------------------------------------
function huntFormView(ctx, { values = {}, error = null, origins, months, saved = [], monitoring }) {
  const v = (k, d = '') => (values[k] !== undefined && values[k] !== null && values[k] !== '' ? String(values[k]) : d);
  const sel = (k, d, x) => (v(k, d) === String(x) ? raw(' selected') : '');
  const chk = (k, d, x) => (v(k, d) === String(x) ? raw(' checked') : '');
  const notifyOn = Array.isArray(values.notify) ? values.notify : values.notify ? [].concat(values.notify) : DEFAULT_NOTIFY;
  const budgetTyped = v('budget', v('b', ''));
  const typedCents = s => { const t = s.replace(/[,$\s]/g, ''); return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null; };
  const limitCents = typedCents(budgetTyped);
  const limitWord = limitCents ? money(limitCents) : 'my limit';
  const thr = v('threshold', 'recommend');
  const thrCents = thr === 'custom' ? typedCents(v('thresholdCustom', '')) : /^\d+$/.test(thr) ? Number(thr) : null;
  const thresholdWord = thrCents ? `${money(thrCents)} or more` : thr === 'recommend' ? 'an amount worth recommending' : 'my threshold';
  const kinds = [
    ['under', `A good trip is under ${limitWord}`],
    ...(saved.length ? [['beat-saved', 'You beat my saved trip (applies when a saved trip is chosen above)']] : []),
    ['drop', `The same trip drops by ${thresholdWord}`],
    ['extra-night', 'I can get an extra night without spending more'],
    ['nonstop', 'A nonstop option enters my budget'],
    ['quality', 'Same money, better hotel'],
    ['destination', 'A new destination enters my budget'],
  ];
  const nights = [];
  for (let n = 2; n <= MAX_NIGHTS; n++) nights.push(n);
  const body = html`
<div class="container hu-page hu-form-page">
  <header class="tb-results-head"><div><p class="eyebrow">AI Savings Hunter</p><h1>${SIGNATURE[1]}</h1>
    <p class="tb-results-sub">You set the ceiling and the rules. The hunt ${SEARCH_WORDS}, and says something only when one meets your rules and is worth your attention. Your number is a ceiling, not a target. ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p></div></header>
  ${error ? html`<div class="alert alert-error" role="alert">${icon('alert')}<span>${error}</span></div>` : ''}
  <form class="form hu-form" method="post" action="/hunts" novalidate>
    <section class="tb-panel"><h2>${icon('wallet')} Your travel money</h2>
      <div class="field"><label for="hu-budget">The most you want to spend, in dollars, for everyone and everything</label>
        <div class="tb-budget-input hu-budget"><span class="tb-currency" aria-hidden="true">$</span><input id="hu-budget" name="budget" type="text" inputmode="numeric" pattern="[0-9,.]*" placeholder="1,500" required autocomplete="off" value="${budgetTyped}" aria-describedby="hu-budget-hint"></div>
        <p class="field-hint" id="hu-budget-hint">Flights, hotel and experiences in one total, taxes and fees included. We don’t try to spend it; we try to stay under it.</p></div>
      <div class="form-row">
        <div class="field"><label for="hu-from">Leaving from</label><select id="hu-from" name="from" required><option value="">Choose a city</option>${origins.map(o => html`<option value="${o.id}"${sel('from', '', o.id)}>${o.city} (${o.airports.map(a => a.code).join(', ')})</option>`)}</select></div>
        <div class="field"><label for="hu-travelers">Travelers</label><input id="hu-travelers" name="travelers" type="number" min="1" max="8" inputmode="numeric" value="${v('travelers', '')}" placeholder="2"><p class="field-hint">Blank means the usual number for who is going.</p></div>
      </div>
      <div class="field"><span class="label">Who is going?</span><div class="tb-radio-row hu-radios" role="radiogroup" aria-label="Who is going">${Object.entries(WHO_WORD).map(([k, w]) => html`<label><input type="radio" name="who" value="${k}"${chk('who', 'couple', k)}> ${w}</label>`)}</div></div>
    </section>

    <section class="tb-panel"><h2>${icon('calendar')} When and how long</h2>
      <div class="field"><span class="label">When</span><div class="hu-radios hu-radios-col" role="radiogroup" aria-label="When">
        <label><input type="radio" name="when" value="anytime"${chk('when', 'anytime', 'anytime')}> Anytime (departures from two weeks to five months out)</label>
        <label><input type="radio" name="when" value="flexible"${chk('when', 'anytime', 'flexible')}> In a month: <select name="month" aria-label="Month">${months.map(m => html`<option value="${m}"${sel('month', months[0], m)}>${monthName(m)}</option>`)}</select></label>
      </div></div>
      <div class="form-row">
        <div class="field"><label for="hu-nights">At least</label><select id="hu-nights" name="nights">${nights.map(n => html`<option value="${n}"${sel('nights', '4', n)}>${plural(n, 'night')}</option>`)}</select></div>
        <div class="field"><label for="hu-max">Up to</label><select id="hu-max" name="maxNights"><option value=""${sel('maxNights', '', '')}>${EXTRA_NIGHTS} more nights than the minimum (never more than ${MAX_NIGHTS})</option>${nights.map(n => html`<option value="${n}"${sel('maxNights', '', n)}>${plural(n, 'night')}</option>`)}</select><p class="field-hint">Every length in between is priced.</p></div>
      </div>
      <div class="field"><label for="hu-style">Trip style</label><select id="hu-style" name="style">${STYLES.map(s => html`<option value="${s}"${sel('style', 'surprise', s)}>${STYLE_WORD[s] || s}</option>`)}</select></div>
    </section>

    <section class="tb-panel"><h2>${icon('sliders')} Your rules</h2>
      <p class="tb-small tb-muted">A trip that breaks a rule is never shown, whatever it costs.</p>
      <div class="field"><span class="label">Flights</span><div class="hu-radios hu-radios-col" role="radiogroup" aria-label="Flights">
        <label><input type="radio" name="nonstop" value="any"${chk('nonstop', 'any', 'any')}> Any flights</label>
        <label><input type="radio" name="nonstop" value="preferred"${chk('nonstop', 'any', 'preferred')}> Nonstop preferred: trips with a stop still count, and the nonstop win below tells me when one fits</label>
        <label><input type="radio" name="nonstop" value="hard"${chk('nonstop', 'any', 'hard')}> Nonstop only (a hard rule)</label>
      </div></div>
      <div class="form-row">
        <div class="field"><label for="hu-stars">Hotel</label><select id="hu-stars" name="stars"><option value=""${sel('stars', '', '')}>Any hotel class</option>${[2, 3, 4, 5].map(n => html`<option value="${n}"${sel('stars', '', n)}>${n}-star or better</option>`)}</select></div>
        <div class="field"><label for="hu-meals">Meals</label><select id="hu-meals" name="meals"><option value=""${sel('meals', '', '')}>No rule</option><option value="all-inclusive"${sel('meals', '', 'all-inclusive')}>All-inclusive</option><option value="breakfast"${sel('meals', '', 'breakfast')}>Breakfast included</option></select></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="hu-bags">Bags</label><select id="hu-bags" name="bags"><option value=""${sel('bags', '', '')}>No rule</option><option value="personal"${sel('bags', '', 'personal')}>A personal item is enough</option><option value="carry-on"${sel('bags', '', 'carry-on')}>I travel with a carry-on</option><option value="checked"${sel('bags', '', 'checked')}>I travel with a checked bag (its fee goes in the total)</option></select></div>
        <div class="field"><span class="label">Cancellation</span><label class="hu-check"><input type="checkbox" name="refundable" value="1"${values.refundable ? raw(' checked') : ''}> Refundable hotel rate only</label></div>
      </div>
      ${saved.length ? html`<div class="field"><label for="hu-saved">A saved trip to beat</label><select id="hu-saved" name="saved"><option value="">None</option>${saved.map(s => html`<option value="${s.token}"${sel('saved', '', s.token)}>${plural(s.trip.spec.nights, 'night')} in ${s.trip.dest.name}, now ${money(s.now)}</option>`)}</select><p class="field-hint">The hunt prices it again each time it checks.</p></div>` : ''}
    </section>

    <section class="tb-panel"><h2>${icon('mail')} Tell me when</h2>
      <p class="tb-small tb-muted">You define the win. Anything else stays quiet.</p>
      <div class="hu-checks">${kinds.map(([k, label]) => html`<label class="hu-check"><input type="checkbox" name="notify" value="${k}"${notifyOn.includes(k) ? raw(' checked') : ''}> ${label}</label>`)}</div>
      <div class="field hu-threshold"><span class="label">A saving worth an interruption</span><div class="hu-radios hu-radios-col" role="radiogroup" aria-label="Threshold">
        ${hunter.THRESHOLDS.map(t => html`<label><input type="radio" name="threshold" value="${t}"${chk('threshold', 'recommend', t)}> ${money(t)} or more</label>`)}
        <label><input type="radio" name="threshold" value="custom"${chk('threshold', 'recommend', 'custom')}> Custom: $<input class="hu-inline-num" name="thresholdCustom" type="text" inputmode="numeric" pattern="[0-9,.]*" value="${v('thresholdCustom', '')}" aria-label="Custom amount in dollars"> or more</label>
        <label><input type="radio" name="threshold" value="recommend"${chk('threshold', 'recommend', 'recommend')}> Only tell me when you find something you’d actually recommend</label>
      </div></div>
      <div class="field"><span class="label">Savings</span><div class="hu-radios hu-radios-col" role="radiogroup" aria-label="Savings level">
        <label><input type="radio" name="savingsLevel" value="balanced"${chk('savingsLevel', 'balanced', 'balanced')}> Balanced: a cheaper trip is shown only when it gives nothing up against the one I found</label>
        <label><input type="radio" name="savingsLevel" value="aggressive"${chk('savingsLevel', 'balanced', 'aggressive')}> Aggressive: show every cheaper trip and say exactly what it gives up (longer travel, a lower hotel class, a stricter fare)</label>
      </div></div>
    </section>

    <div class="hu-submit">
      <button class="btn btn-navy btn-lg" type="submit">${icon('search')} Hunt for a trip</button>
      <p class="tb-small tb-muted">${monitoring} Nothing is booked without your confirmation.</p>
    </div>
  </form>
</div>`;
  return layout({ title: 'Start a hunt', active: 'my-trips', body, ctx, noindex: true });
}

// ---- the hunt page --------------------------------------------------------------------------------
// The headline of an opportunity, in the spec's words; the drop has no spec headline, so it says the
// customer's own rule back: the same trip dropped by the recorded difference.
function headline(o, hunt) {
  switch (o.kind) {
    case 'breakthrough': return 'Budget breakthrough';
    case 'extra-night': return 'Your money just got an extra night';
    case 'quality': return 'Same money. Better hotel.';
    case 'nonstop': return 'Nonstop just entered your budget';
    case 'destination': return `Your ${money(hunt.budget)} just unlocked ${o.trip.dest}`;
    case 'beat-saved': return 'Beats your saved trip';
    case 'drop': return o.previous && o.previous.token === o.trip.token ? `The same trip dropped by ${money(o.delta)}` : `${money(o.delta)} less than the trip I found before`;
    default: return 'New opportunity';
  }
}

// The decision without its own verified-at sentence, which the card shows once, on its own line.
function decisionBody(o, hunt) {
  const full = hunter.decisionText(o, hunt);
  const i = full.indexOf(' Current price was verified at');
  return i > 0 ? full.slice(0, i) : full;
}

// Previous against now, only from what the engine recorded: a hunt card, the baseline's facts, or
// a bare token and total.
function previousRows(o, destName) {
  const p = o.previous, t = o.trip;
  const rows = [['Total', money(p.total), money(t.total)]];
  if (p.token === t.token) return rows; // the same trip: only its price moved
  if (isNum(p.nights)) rows.push(['Length', plural(p.nights, 'night'), plural(t.nights, 'night')]);
  if (isNum(p.stops)) rows.push(['Flights', stopsText(p.stops), stopsText(t.stops)]);
  if (p.hotel && p.hotel.name) rows.push(['Hotel', `${p.hotel.stars}-star ${p.hotel.name}`, `${t.hotel.stars}-star ${t.hotel.name}`]);
  else if (isNum(p.stars)) rows.push(['Hotel', `${p.stars}-star`, `${t.hotel.stars}-star ${t.hotel.name}`]);
  const prevDest = p.destId ? p.dest : p.dest ? destName(p.dest) : null;
  if (prevDest && prevDest !== t.dest) rows.push(['Destination', prevDest, t.dest]);
  return rows;
}

function opportunityCard(o, hunt, { destName, improveWords, recheck }) {
  const respond = (fields, label, cls = 'btn btn-ghost') => html`<form method="post" action="/hunts/${hunt.id}/respond"><input type="hidden" name="opportunityId" value="${o.id}">${Object.entries(fields).map(([k, val]) => html`<input type="hidden" name="${k}" value="${val}">`)}<button class="${cls}" type="submit">${label}</button></form>`;
  const p = o.previous && isNum(o.previous.total) ? o.previous : null;
  const compare = p && p.token && p.token !== o.trip.token;
  const t = o.trip;
  // What the "previous" column holds. For beat-saved the engine's previous is the customer's saved
  // trip priced in this same run (hunter: prev = huntCard(saved.trip, saved.token)): a price now, so
  // it is never called a record. Everything else is the trip on record: the same trip's recorded
  // price, or the recorded best (stamped when the record carries its date).
  const savedNow = o.kind === 'beat-saved';
  const caption = savedNow ? 'Your saved trip, priced now, against this trip'
    : p && p.token === t.token ? 'This trip as I recorded it, against its price now'
      : `What I recorded${p && p.recordedAt ? ` on ${stamp(p.recordedAt)}` : ' before'}, against this trip now`;
  const [prevLabel, nowLabel] = savedNow ? ['Saved trip (now)', 'This trip'] : ['Recorded', 'Now'];
  return html`<article class="hu-opp hu-opp-${o.kind} is-${o.status}" aria-labelledby="opp-${o.id}">
    <div class="hu-opp-head"><p class="tb-kicker">${headline(o, hunt)}</p><span class="hu-opp-status is-${o.status}">${OPP_STATUS[o.status] || o.status}</span></div>
    <h3 id="opp-${o.id}">${plural(t.nights, 'night')} in ${t.dest} for ${money(t.total)}</h3>
    <p class="hu-decision">${decisionBody(o, hunt)}</p>
    <p class="hu-trip-facts tb-small">${t.depart} to ${t.ret} · ${plural(t.travelers, 'traveler')} · ${stopsText(t.stops)} with ${t.airline}, ${t.fareName} fare · ${t.hotel.stars}-star ${t.hotel.name}${t.hotel.allInclusive ? ', all-inclusive' : t.hotel.breakfast ? ', breakfast included' : ''}${t.hotel.refundable ? ', refundable' : ''} · ${t.bags}${t.transfer ? ' · airport transfer' : ''}${t.activities ? ` · ${plural(t.activities, 'experience')}` : ''}</p>
    ${p ? html`<table class="hu-prev"><caption>${caption}</caption><thead><tr><th scope="col"></th><th scope="col">${prevLabel}</th><th scope="col">${nowLabel}</th></tr></thead>
      <tbody>${previousRows(o, destName).map(([l, a, b]) => html`<tr><th scope="row">${l}</th><td>${a}</td><td>${b}</td></tr>`)}</tbody></table>
      ${isNum(p.totalNow) && p.totalNow !== p.total ? html`<p class="tb-small tb-muted">The trip I recorded is itself ${money(p.totalNow)} now.</p>` : ''}` : ''}
    ${o.why && o.why.length ? html`<ul class="hu-why">${o.why.map(w => html`<li>${w}</li>`)}</ul>` : ''}
    <details class="hu-receipt"><summary>Why you’re seeing this</summary>
      <div class="hu-receipt-cols">
        <div><h4>Your rules</h4><ul>${(o.receipt.rules || []).map(l => html`<li>${l}</li>`)}</ul></div>
        <div><h4>Found</h4><ul>${(o.receipt.found || []).map(l => html`<li>${l}</li>`)}</ul></div>
      </div>
      <p><b>Why I interrupted you:</b> ${o.receipt.why}</p>
    </details>
    <p class="hu-verified tb-small">${icon('clock')} Current price was verified at ${stamp(o.verifiedAt)}. ${MAY_CHANGE}</p>
    <div class="hu-opp-actions">
      <a class="btn btn-navy" href="${tripLink(t.token, hunt)}">${o.kind === 'extra-night' ? 'Take the extra night' : 'See trip'} ${icon('arrow')}</a>
      ${compare ? html`<a class="btn btn-ghost" href="/compare?${contextParams({ budget: hunt.budget }, { t: [p.token, t.token], l: savedNow ? ['Saved trip', 'This trip'] : ['Recorded', 'Now'] })}">Compare</a>` : ''}
      ${respond({ action: 'keep-waiting' }, 'Keep waiting')}
      <details class="hu-improve"><summary class="btn btn-ghost">Not good enough</summary>
        <div class="hu-improve-body">
          <p>What should I improve? Each answer changes this hunt’s rules; ${recheck}.</p>
          <div class="ag-chips">${IMPROVE.map(([what, label]) => respond({ action: 'improve', what }, label, 'ag-chip'))}</div>
          <p class="tb-small tb-muted">${improveWords}</p>
          <form class="hu-reject" method="post" action="/hunts/${hunt.id}/respond"><input type="hidden" name="action" value="reject"><input type="hidden" name="opportunityId" value="${o.id}"><label for="rej-${o.id}">Or say it in your words</label><input id="rej-${o.id}" name="reason" type="text" maxlength="120" placeholder="too short"><button class="btn btn-ghost btn-sm" type="submit">Reject and learn</button></form>
        </div>
      </details>
    </div>
  </article>`;
}

// What each improve chip does to THIS hunt, with the service's own arithmetic (HuntService.answer):
// the price target is the next step under the trip the hunt stands on, the hotel minimum goes one
// class above what the search already requires and found (or is refused at the top), the nights
// minimum goes one night above the trip found (not one above the old minimum), and the destination
// ruled out is the found trip's, whichever card the chip sits on.
function improveWords(hunt, best, target, destName) {
  const floors = hunt.floors || {};
  const haveStars = Math.max(hunt.rules.minStars || 0, floors.minStars || 0, best ? best.stars : 0);
  const nights = Math.min(MAX_NIGHTS, (best ? best.nights : hunt.minNights) + 1);
  return [
    `Lower price sets this hunt to look for the same quality under ${money(target)}.`,
    haveStars >= MAX_STARS ? `Better hotel has no higher class to ask for: ${MAX_STARS} stars is the highest we price.` : `Better hotel raises the hotel minimum to ${(haveStars || 3) + 1} stars.`,
    nights <= hunt.minNights ? `More nights cannot go past the ${MAX_NIGHTS} nights we price.` : `More nights raises the minimum to ${nights}${hunt.maxNights < nights ? `, and the maximum to ${nights} to match` : ''}.`,
    hunt.rules.flightStops === 'nonstop' && hunt.rules.flightRule === 'hard' ? 'Nonstop is already a hard rule.' : 'Nonstop makes nonstop a hard rule.',
    best ? `Different destination rules out ${destName(best.dest)} for this hunt.` : 'Different destination needs a found trip to rule out.',
  ].join(' ');
}

function huntView(ctx, { hunt, error = null, originCity, destName, rules, monitoring, acceptance }) {
  const best = hunt.baseline && hunt.baseline.best ? hunt.baseline.best : null;
  const ceiling = isNum(hunt.target) && hunt.target > 0 ? Math.min(hunt.budget, hunt.target) : hunt.budget;
  const target = nextStep(best ? best.total : ceiling);
  const hunting = hunt.status === 'hunting';
  // A chosen month with nothing left to price cannot be resumed (the service refuses it and a run
  // stops the hunt on it), so that page offers a new hunt instead of a Resume that would be refused.
  const closed = !hunting && hunt.dateMode === 'flexible' && !!hunt.month && monthClosed(hunt.month, ctx.tripService.now());
  const stoppedWords = closed ? `This hunt is stopped: no departure in ${monthName(hunt.month)} is left to price, so nothing is checked. Start a new hunt for a later month.` : STOPPED_WORDS;
  // Every sentence that says a change is followed by a check says when: now, once resumed, or never.
  const recheck = hunting ? 'the hunt re-checks' : closed ? 'this hunt checks nothing more' : 'the hunt re-checks once you resume it';
  const chips = improveWords(hunt, best, target, destName);
  const runs = [...hunt.runs].reverse().slice(0, 10);
  const lastRun = hunt.runs.length ? hunt.runs[hunt.runs.length - 1] : null;
  const opportunities = [...hunt.opportunities].reverse();
  const act = (fields, label, cls = 'btn btn-ghost') => html`<form method="post" action="/hunts/${hunt.id}/respond">${Object.entries(fields).map(([k, val]) => html`<input type="hidden" name="${k}" value="${val}">`)}<button class="${cls}" type="submit">${label}</button></form>`;
  const body = html`
<div class="container hu-page">
  <header class="tb-results-head"><div><p class="eyebrow">AI Savings Hunter</p><h1>${hunt.name}</h1>
    <p class="tb-results-sub">${plural(hunt.travelers, 'traveler')} from ${originCity} · ${hunt.dateMode === 'flexible' && hunt.month ? `in ${monthName(hunt.month)}` : 'anytime'} · ${hunt.minNights === hunt.maxNights ? plural(hunt.minNights, 'night') : `${hunt.minNights} to ${hunt.maxNights} nights`} ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p></div>
    <a class="btn btn-ghost btn-sm" href="/hunts">All hunts</a></header>
  ${error ? html`<div class="alert alert-error" role="alert">${icon('alert')}<span>${error}</span></div>` : ''}

  <section class="hu-card" aria-labelledby="hu-card-title">
    <h2 id="hu-card-title" class="sr-only">Your travel money</h2>
    <dl class="hu-facts">
      <div class="hu-fact hu-fact-money"><dt>My travel money</dt><dd>${money(hunt.budget)}</dd></div>
      <div class="hu-fact"><dt>Status</dt><dd>${huntStatus(hunt.status)}</dd></div>
      <div class="hu-fact"><dt>Best current opportunity</dt><dd>${best ? html`<a href="${tripLink(best.token, hunt)}">${money(best.total)}</a> <small>${plural(best.nights, 'night')} in ${destName(best.dest)}</small>` : html`<span class="tb-muted">${hunt.baseline ? 'nothing qualifies yet' : 'not checked under these rules yet'}</span>`}</dd></div>
      <div class="hu-fact"><dt>Potential money kept</dt><dd>${best ? money(hunt.budget - best.total) : html`<span class="tb-muted">—</span>`}</dd></div>
      <div class="hu-fact"><dt>Last meaningful improvement</dt><dd>${hunt.lastMeaningfulAt ? stamp(hunt.lastMeaningfulAt) : 'none yet'}</dd></div>
      <div class="hu-fact"><dt>Last checked</dt><dd>${hunt.lastRunAt ? stamp(hunt.lastRunAt) : 'not yet'}</dd></div>
    </dl>
    ${isNum(hunt.target) && hunt.target > 0 && hunt.target < hunt.budget ? html`<p class="hu-target">Now looking under <b>${money(hunt.target)}</b> for the same quality${hunt.floors && (hunt.floors.minStars || hunt.floors.nonstop) ? ` (${[hunt.floors.minStars ? `at least ${hunt.floors.minStars} stars` : null, hunt.floors.nonstop ? 'nonstop flights' : null].filter(Boolean).join(' and ')})` : ''}. Your ${money(hunt.budget)} limit stands.</p>` : ''}
    ${hunting ? html`<p class="hu-acceptance">${acceptance}</p>` : ''}
    <p class="hu-monitoring tb-small tb-muted">${hunting ? monitoring : stoppedWords}</p>
  </section>

  <section class="tb-panel hu-rules" aria-labelledby="hu-rules-title"><h2 id="hu-rules-title">${icon('sliders')} Your rules</h2>
    <ul class="tb-list">${rules.map(l => html`<li>${l}</li>`)}</ul>
    <p class="tb-small">Tell me when: ${notifyWords(hunt).join('; ') || 'nothing (this hunt stays quiet)'}. A saving worth an interruption: ${thresholdWords(hunt.threshold)}.</p>
    <p class="tb-small tb-muted">The rules change only through your answers below; every change is written down under “What this hunt learned” and ${recheck}.</p>
  </section>

  <section class="hu-opps" aria-labelledby="hu-opps-title"><h2 id="hu-opps-title">Opportunities</h2>
    ${opportunities.length ? opportunities.map(o => opportunityCard(o, hunt, { destName, improveWords: chips, recheck })) : html`<p class="hu-quiet">Nothing worth interrupting you for yet${lastRun && lastRun.silent ? html`: ${lastRun.silent}` : ''}.</p>`}
  </section>

  <section class="hu-actions tb-panel" aria-labelledby="hu-actions-title"><h2 id="hu-actions-title">${icon('sparkle')} Change the hunt</h2>
    <div class="hu-action-row">
      <div>${act({ action: 'harder' }, 'Find me something even better', 'btn btn-blue')}<p class="tb-small tb-muted">${hunting ? 'Looks' : 'Sets this hunt to look'} for the same quality under ${money(target)}${best ? ` (keeping at least ${best.stars} stars${best.stops === 0 ? ' and nonstop flights' : ''})` : ''}${hunting ? '' : closed ? '; this hunt checks nothing more' : '; it looks once you resume it'}.</p></div>
      <div>${hunting ? act({ action: 'stop' }, 'Stop') : closed ? html`<a class="btn btn-navy" href="/hunts/new?${new URLSearchParams({ budget: String(hunt.budget / 100), from: hunt.origin, when: 'flexible' })}">Start a new hunt</a>` : act({ action: 'resume' }, 'Resume', 'btn btn-navy')}<p class="tb-small tb-muted">${hunting ? 'Stops the checks. Your rules and what was found stay here.' : closed ? `Resuming is refused: no departure in ${monthName(hunt.month)} is left to price. A new hunt can name a later month.` : 'Starts the checks again under the rules above.'}</p></div>
    </div>
  </section>

  <section class="hu-log" aria-labelledby="hu-log-title"><h2 id="hu-log-title">Checks</h2>
    ${runs.length ? html`<ul class="hu-runs">${runs.map(r => html`<li>Checked ${stamp(r.at)} (${REASON_WORD[r.reason] || r.reason}): ${plural(r.destinations, 'destination')}, ${plural(r.considered, 'package')}; ${r.silent ? r.silent : opps(r.opportunities)}</li>`)}</ul>` : html`<p class="tb-muted">Not checked yet.</p>`}
    ${hunt.runs.length > runs.length ? html`<p class="tb-small tb-muted">The last ${runs.length} of ${hunt.runs.length} checks.</p>` : ''}
  </section>

  <section class="hu-learned" aria-labelledby="hu-learned-title"><h2 id="hu-learned-title">What this hunt learned</h2>
    ${hunt.learned.length ? html`<ul class="hu-learned-list">${[...hunt.learned].reverse().map(l => html`<li><span class="tb-muted">${stamp(l.at)}</span> ${l.text}</li>`)}</ul>` : html`<p class="tb-muted">Nothing yet. Your answers to an opportunity are written here, in plain words.</p>`}
  </section>
</div>`;
  return layout({ title: hunt.name, active: 'my-trips', body, ctx, noindex: true });
}

module.exports = { huntsListView, huntFormView, huntView, huntRows, headline, nextStep, stamp, SIGNATURE, SEARCH_WORDS, STOPPED_WORDS, ALL_STOPPED_WORDS };
