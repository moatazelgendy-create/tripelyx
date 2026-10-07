// EXPERIENCE MAX's pages: /trip/:token/memories (MAKE IT MORE MEMORABLE: why this trip is built this
// way, the experience budget, the rhythm and every experience control), the trip and review pages'
// MAIN EXPERIENCE 🔒 PROTECTED line, the review page's experience additions, and the booking page's
// WHAT WAS ACTUALLY WORTH IT? form. Every number is the experience engine's (server/trips/experience.js
// prices every version with priceTrip), every sentence is the engine's `text`, and every control is a
// link to a priced version by its token with the whole context on it (rules, mem, px, promo, dm, bg):
// nothing is applied, added or removed on a page, nothing is preselected, and "worth it" is judged
// only by the goals the traveler ranked. No urgency, no scarcity, no prediction, no weather promise.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { contextParams } = require('../../trips/optimizer');
const { money, dollars, longDate, shortDate, plural, joinAnd, demoBadge } = require('./common');
const X = require('../../trips/experience');
const { decodeSpec } = require('../../trips/spec');

// Every link carries the context, so a version opened from here keeps the goals, the protected
// experience, the rules and the promo the page was read with. `extra` overrides one key (a different
// trip that cannot hold the protected experience leaves `px` behind, and says so beside the link).
const tripUrl = (token, cx, extra = {}, hash = '') => `/trip/${token}?${contextParams(cx, extra)}${hash}`;
const memUrl = (token, cx, extra = {}, hash = '') => `/trip/${token}/memories?${contextParams(cx, extra)}${hash}`;
const reviewUrl = (token, cx, seen) => `/trip/${token}/review?${contextParams(cx, { seen })}`;
const changeUrl = (token, cx, change) => `/trip/${token}/change?${contextParams(cx, change)}`;
const memParam = gs => (gs.length ? gs.join(',') : undefined);
const rankWord = (key, gs) => `the ${X.goalLabel(key).toLowerCase()} you ranked #${gs.indexOf(key) + 1}`;

function deltaTag(d) {
  if (d === 0) return html`<span class="tb-delta tb-delta-same">same price</span>`;
  return html`<span class="tb-delta ${d < 0 ? 'tb-delta-save' : 'tb-delta-add'}">${d < 0 ? '−' : '+'}${money(Math.abs(d))}</span>`;
}
// The maximum is a ceiling, not a target: a version over it says so beside its link, wherever it is
// offered on the page (inline here; overNote below for a version shown as a block).
const overTag = (v, cap) => (v && cap && v.total > cap ? html` <span class="tb-mem-over" data-over="${v.total - cap}">${icon('alert')} ${money(v.total - cap)} over your ${money(cap)} maximum</span>` : '');
// A link to one priced version: its token, its total as data (a test or a script reads it without
// parsing money), and the total in the words, so the amount shown is the amount that opens. With `cap`,
// a version over the ceiling carries the over tag beside it.
function versionLink(v, cx, words, { cls = 'btn btn-ghost btn-sm', extra = {}, cap = null } = {}) {
  return html`<a class="${cls}" href="${tripUrl(v.token, cx, extra)}" data-total="${v.total}">${words} · ${money(v.total)}</a>${overTag(v, cap)}`;
}
// Engine sentences as the page prints them. The engine already writes dates as the pages do (the shared
// trips/words formatter) and joins sentences with one stop; this stays as a guard, so an ISO date or a
// doubled stop from any other engine text never reaches the page either.
const say = t => String(t ?? '').replace(/\b(\d{4}-\d{2}-\d{2})\b/g, d => longDate(d)).replace(/\.(?=[.;])/g, '');
// The engine writes a candidate as "<label>, <delta>: <what it adds>"; the row already shows the label
// and the amount, so it says only what the version adds.
const afterLabel = (text, label) => { const t = String(text || ''); if (!label || !t.startsWith(label)) return t; const i = t.indexOf(': ', label.length); return i < 0 ? t : t.slice(i + 2); };
// A version over the ceiling is shown so the traveler can see it, never as a target. The one exception the
// engine makes is a version that is over only because this trip already is, and costs less than it: then
// the note says that instead of "never a target" beside a recommendation.
function overNote(v, cap, { pick = false, trip = null } = {}) {
  if (!v || !cap || !(v.over || v.total > cap)) return '';
  if (pick && trip && trip.total > cap && v.total < trip.total) return html`<p class="tb-tip tb-tip-warn">${icon('alert')} ${money(v.total - cap)} over your ${money(cap)} ceiling, as this trip is: it costs ${money(trip.total - v.total)} less than this trip.</p>`;
  return html`<p class="tb-tip tb-tip-warn">${icon('alert')} ${money(v.total - cap)} over your ${money(cap)} ceiling: shown so you can see it, never a target.</p>`;
}

// ---- the main experience, on every page that shows the trip ----------------------------------
// MAIN EXPERIENCE 🔒 PROTECTED while the trip has the experience the link protects (px=), with the way
// out ("Unprotect"); a protected experience this version lacks is said by its name, with the way back,
// never dropped quietly; otherwise the strongest experience for the goals, with "Protect this
// experience". An id the destination does not offer names nothing: it is said in words, never printed.
// The link's px= may be the customer's or the agent's (it protects the main experience from the
// results), so every line says "the protected experience", never "the experience you protected".
function mainLine(m, { token, cx, trip, here = 'memories' }) {
  const back = here === 'trip' ? (extra, hash = '') => tripUrl(token, cx, extra, hash) : (extra, hash = '') => memUrl(token, cx, extra, hash);
  if (m.protected && m.main) return html`<p class="tb-mem-main is-protected" data-protected="${m.main.id}"><b>MAIN EXPERIENCE 🔒 PROTECTED:</b> ${m.main.name}. No version I offer leaves it out; a different trip that can't hold it says so. <a href="${back({ px: undefined })}">Unprotect it</a></p>`;
  if (m.foreign) return html`<p class="tb-mem-main is-missing tb-tip tb-tip-warn">${icon('alert')} <span>The experience this link protects is not offered here, so nothing is protected on this trip. <a href="${back({ px: undefined })}">Open it without that protection</a>.</span></p>`;
  if (m.missing) {
    const add = trip && (trip.activityOptions || []).some(a => a.id === m.missing.id) ? changeUrl(token, cx, { activities: [...trip.spec.activities, m.missing.id] }) : null;
    return html`<p class="tb-mem-main is-missing tb-tip tb-tip-warn">${icon('alert')} <span><b>MAIN EXPERIENCE 🔒 PROTECTED:</b> ${m.missing.name} is not in this version of the trip. ${add ? html`<a href="${add}">Add it back</a> or ` : ''}<a href="${back({ px: undefined })}">unprotect it</a>.</span></p>`;
  }
  if (m.main) return html`<p class="tb-mem-main"><b>MAIN EXPERIENCE:</b> ${m.main.name}. <a href="${back({ px: m.main.id })}" data-protect="${m.main.id}">Protect this experience</a></p>`;
  return '';
}

// ---- the receipt and the budget (shared with the review page) ----------------------------------
// WHY THIS TRIP IS BUILT THIS WAY: the lines are the price-line differences between the baseline the
// engine priced and this trip, so they add up to FINAL − baseline exactly (each row carries its signed
// cents as data-diff). Over the maximum, the overrun is named, never called "keep".
function receiptBlock(r, cx, { cap = null } = {}) {
  const rows = (xs, sign) => xs.map(l => html`<li data-diff="${sign * l.amount}"><span>${l.label}</span><b>${money(l.amount)}</b></li>`);
  const own = r.baseline.label.startsWith('this trip itself');
  // The baseline is a reference, not an offer: when it does not hold the protected experience, its
  // link leaves the protection behind and says so, like every other version that can't hold it.
  const spec = own ? null : decodeSpec(r.baseline.token);
  const drops = !!(cx.protect && spec && !spec.activities.includes(cx.protect));
  // A baseline that moves a part the traveler locked (locked= on the link) is named with its total, never linked.
  const crosses = (r.baseline.crosses || []);
  return html`<dl class="tb-dl tb-mem-goal"><div><dt>YOUR GOAL</dt><dd>${r.goal.replace(/^YOUR GOAL: /, '')}</dd></div></dl>
    <div class="tb-leak-two tb-mem-receipt">
      <div><h3>${icon('minus')} WE SPENT LESS ON</h3>${r.lessOn.length ? html`<ul class="tb-mem-lines">${rows(r.lessOn, -1)}</ul>` : html`<p class="tb-muted tb-small">Nothing: no line of this trip is cheaper than the baseline's.</p>`}</div>
      <div><h3>${icon('plus')} WE USED MONEY FOR</h3>${r.usedFor.length ? html`<ul class="tb-mem-lines">${rows(r.usedFor, 1)}</ul>` : html`<p class="tb-muted tb-small">Nothing: no line of this trip is dearer than the baseline's.</p>`}</div>
    </div>
    <div class="tb-final-nums tb-leak-nums${r.keep !== null && r.keep < 0 ? ' is-over' : ''}"><div><span>FINAL</span><b>${money(r.final)}</b></div>${r.max !== null ? html`<div><span>YOUR MAX</span><b>${money(r.max)}</b></div><div class="${r.keep < 0 ? 'is-over' : ''}"><span>${r.keep < 0 ? 'OVER YOUR MAX' : 'KEEP'}</span><b>${money(Math.abs(r.keep))}</b></div>` : ''}</div>
    <p class="tb-small tb-muted">Measured against ${r.baseline.label}${own ? '' : crosses.length ? ` (${money(r.baseline.total)}; it changes ${joinAnd(crosses)} you locked, so it is a reference here, not a version to open)` : html`: <a href="${tripUrl(r.baseline.token, cx, drops ? { px: undefined } : {})}" data-total="${r.baseline.total}">see it · ${money(r.baseline.total)}</a>${overTag(r.baseline, cap)}${drops ? ' (it does not hold the protected experience, so opening it leaves the protection behind)' : ''}`}. Every line is that version's price line against this trip's, so they add up to the difference between the two totals; nothing is estimated.</p>`;
}

// PROTECTION rows for the main experience: what the data verifies, and what needs verification. On a phone
// each row stacks (the check and its status on one line, what we know under it: trips.css), so no
// header sits over the wrong column and no status is clipped; the roles keep it a table for screen
// readers when the rows are laid out as blocks.
const PROTECT_LABEL = { availability: 'Availability', operating: 'Operating days', age: 'Age requirements', restrictions: 'Current restrictions', meeting: 'Meeting location', duration: 'Duration', cancellation: 'Cancellation', transport: 'Transport' };
function protectionTable(p) {
  return html`<table class="tb-mem-table tb-mem-protect" role="table">
    <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Check</th><th scope="col" role="columnheader">What we know</th><th scope="col" role="columnheader">Status</th></tr></thead>
    <tbody role="rowgroup">${p.rows.map(r => html`<tr role="row" class="${r.verified ? 'is-ok' : 'is-verify'}" data-key="${r.key}"><td role="cell">${PROTECT_LABEL[r.key] || r.key}</td><td role="cell">${say(r.value)}</td><td role="cell">${r.verified ? 'Verified' : 'Needs verification'}</td></tr>`)}</tbody>
  </table>`;
}

// FINAL EXPERIENCE CHECK: each reason with its status, then the rebuild as a link when one passes.
// On the review page the rebuild is priced with the page's promo code (service.experienceReview), so
// the amount beside its link is the total its review opens on, named as the one seen: "still", not
// "dropped" because of the code. When no rebuild keeps what the trip is for, the engine's plain words
// say so (and what the versions that pass would drop); no link is offered as "the rebuild".
function finalCheckBlock(fc, cx, { review = false, promo = false, cap = null } = {}) {
  const rb = fc.rebuild;
  return html`<ul class="tb-ready tb-ready-wrap tb-mem-checks">${fc.reasons.map(r => html`<li class="${r.ok ? '' : 'is-miss'}">${icon(r.ok ? 'check' : 'alert')}<span>${say(r.text)}</span></li>`)}</ul>
    <p class="tb-mem-say">${say(fc.ok ? fc.text : fc.text.replace(rb ? ` ${rb.text}` : '', ''))}</p>
    ${!fc.ok && !rb && fc.noRebuild ? html`<p class="tb-tip tb-tip-warn" data-no-rebuild>${icon('info')} <span>${say(fc.noRebuild)}</span></p>` : ''}
    ${rb ? html`<p class="tb-mem-actions">${review ? html`<a class="btn btn-navy" href="${reviewUrl(rb.token, cx, rb.total)}" data-total="${rb.total}">See the rebuild that passes · ${money(rb.total)}</a>${overTag(rb, cap)}` : versionLink(rb, cx, 'See the rebuild that passes', { cls: 'btn btn-navy', cap })} <span class="tb-small tb-muted">${say(rb.text)}${promo ? ' Priced with your promo code, like the total on this page.' : ''}</span></p>` : ''}`;
}

// ---- the review page's experience additions ----------------------------------------------------
// Only when the link carries goals or a protected experience (service.experienceReview): the
// EXPERIENCE RECEIPT, the PROTECTION rows for the main experience, the FINAL EXPERIENCE CHECK (ok, or
// the rebuild as a link re-checked on arrival; a pass lists its reasons too, as the agent's card and the Memories page
// do, so the event's day and every check the agent read are on the page) and the "very scheduled" line when fatigue says so. With
// a promo code every version here is priced with it, as the page's own total is (each link's amount is
// the total its review opens on, and the one it names as seen).
function experienceReviewPanels(e, { token, cx, promo = false }) {
  if (!e) return '';
  const ft = e.fatigue && e.fatigue.scheduled ? e.fatigue.freeTime : null, cap = cx.budget || null;
  return html`<div class="tb-mem-review">
    ${e.receipt ? html`<section class="tb-panel" id="experience-receipt" aria-labelledby="xr-title">
      <h2 id="xr-title">${icon('layers')} EXPERIENCE RECEIPT</h2>
      <p class="tb-muted">WHY THIS TRIP IS BUILT THIS WAY: where the money went, by the goals you ranked.</p>
      ${receiptBlock(e.receipt, cx, { cap })}
    </section>` : ''}
    ${e.main || e.missing ? html`<section class="tb-panel" id="experience-protection" aria-labelledby="xp-title">
      <h2 id="xp-title">${icon('shield')} EXPERIENCE PROTECTION</h2>
      ${mainLine(e, { token, cx, here: 'trip' })}
      ${e.protection ? html`${e.missing ? html`<p class="tb-muted tb-small">The rows below check ${e.main.name}, this trip's own main experience.</p>` : ''}${protectionTable(e.protection)}<p class="tb-small">${say(e.protection.text)}</p>` : ''}
    </section>` : ''}
    ${e.finalCheck ? html`<section class="tb-panel" id="final-check" aria-labelledby="fc-title">
      <h2 id="fc-title">${icon(e.finalCheck.ok ? 'check' : 'alert')} FINAL EXPERIENCE CHECK</h2>
      ${finalCheckBlock(e.finalCheck, cx, { review: true, promo, cap })}
    </section>` : ''}
    ${e.fatigue && e.fatigue.scheduled ? html`<p class="tb-tip tb-tip-warn tb-mem-scheduled">${icon('clock')} <span>${say(e.fatigue.text)}${ft && ft.trip ? html` <a href="${reviewUrl(ft.token, cx, ft.total)}" data-total="${ft.total}">Open up a day: without ${ft.removed.name} · ${money(ft.total)}</a>${promo ? ' (with your promo code)' : ''}${overTag(ft, cap)}` : ''} <a href="${memUrl(token, cx, {}, '#schedule')}">See the schedule</a></span></p>` : ''}
  </div>`;
}

// ---- the booking page: WHAT WAS ACTUALLY WORTH IT? ----------------------------------------------
const WHERE = {
  saved: 'Kept on this booking and saved to your account’s travel defaults for next time, as you asked.',
  'not-asked': 'Kept on this booking only: you did not ask me to remember it.',
  'signed-out': 'Kept on this booking only: remembering it for next time needs you signed in as the account that booked it.',
  'not-owner': 'Kept on this booking only: it belongs to another account, so nothing was saved to yours.',
  guest: 'Kept on this booking only: this trip was booked without an account, and remembering needs an account that owns the booking, so nothing was saved to one.',
  nothing: 'Kept on this booking. Nothing in it changes how I plan the next trip ("Other" stays your words only), so nothing was saved to your account.',
};
// What happened to an answer from this booking saved to the account earlier (service.setWorthIt).
const EARLIER = {
  replaced: 'It replaces the answer from this booking you asked me to remember earlier.',
  removed: 'The answer from this booking you asked me to remember earlier is removed from your account’s travel defaults: I go by your latest answer.',
  kept: 'An answer from this booking saved earlier is still on the account that booked it: only that account, signed in, can change it.',
};
// The form promises a save only to the account that booked the trip ('owner'); everyone else is told
// plainly why remembering is not possible from here, before they answer (routes/pages.js reads `who`).
function rememberLine(b, who, remembered) {
  if (who === 'owner') return remembered ? 'An answer from this booking is already saved to your account’s travel defaults. Ticked, this answer replaces it; unticked, it is removed and this answer stays on this booking only.' : 'Ticked, it is saved to your account’s travel defaults for next time. Unticked, it stays on this booking only.';
  if (who === 'guest') return 'This trip was booked without an account, and remembering needs an account that owns the booking, so your answer stays on this booking only.';
  if (who === 'other') return 'Remembering needs you signed in as the account that booked this trip; you are signed in with another one, so your answer stays on this booking only.';
  return html`Remembering needs you signed in as the account that booked this trip (<a href="/signin?next=${encodeURIComponent(`/booking/${b.ref}`)}">sign in</a>); otherwise your answer stays on this booking only.`;
}
const WORTH_ERRORS = {
  both: 'You marked the same thing as both worth it and not worth it, so nothing was kept. Choose one for each.',
  empty: 'Nothing was chosen, so nothing was kept. Choose what was worth it, what was not, or say it in your words.',
  early: 'This question is for after the trip: it opens the day after you fly home.',
  status: 'This question is for a trip that went ahead.',
};
function worthItPanel(b, { open, error = null, sent = false, user = null, who = null, remembered = false }) {
  const w = b.worthIt || null, viewer = who || (user ? 'other' : 'signed-out');
  if (!open && !w) return '';
  const said = w ? [w.worth.length ? `Worth it: ${joinAnd(w.worth)}` : null, w.notWorth.length ? `Not worth it: ${joinAnd(w.notWorth)}` : null, w.other ? `In your words: “${w.other}”` : null].filter(Boolean) : [];
  const learned = w && Object.keys(w.prefs || {}).length ? w.text.replace(/^Remembered only if you say so: /, '') : null;
  const chips = name => X.WORTH_IT_CHIPS.map((c, i) => html`<label class="tb-mem-chip tb-mem-pick"><input type="checkbox" name="${name}" value="${c}" id="${name}-${i}"> ${c}</label>`);
  return html`<section class="tb-panel tb-mem-worth" id="worth-it" aria-labelledby="worth-title">
    <h2 id="worth-title">${icon('sparkle')} WHAT WAS ACTUALLY WORTH IT?</h2>
    ${error ? html`<p class="tb-tip tb-tip-warn" role="alert">${icon('alert')} ${WORTH_ERRORS[error] || WORTH_ERRORS.empty}</p>` : ''}
    ${w ? html`<div class="tb-mem-kept${sent ? ' is-new' : ''}" role="${sent ? 'status' : 'note'}">
      <p><b>${sent ? 'Thanks. Here is what was kept, and where.' : 'What you told us'}</b> (${shortDate(w.at.slice(0, 10))})</p>
      <ul class="tb-list tb-small">${said.map(x => html`<li>${x}</li>`)}</ul>
      ${learned ? html`<p class="tb-small">What I take from it: ${learned}</p>` : ''}
      <p class="tb-small tb-mem-iconline">${icon(w.defaults === 'saved' ? 'check' : 'lock')}<span>${WHERE[w.defaults] || WHERE['not-asked']}${w.earlier && EARLIER[w.earlier] ? ` ${EARLIER[w.earlier]}` : ''}</span></p>
    </div>` : ''}
    ${open ? html`<details class="tb-mem-worth-form"${w ? '' : ' open'}><summary>${w ? 'Change your answer' : 'Tell me, so the next trip spends where it counts'}</summary>
      <form class="form" method="post" action="/booking/${b.ref}/worth-it">
        <p class="tb-muted tb-small">Nothing is preselected. Pick what was worth the money and what was not; one is enough.</p>
        <fieldset class="tb-mem-chipset"><legend>Worth it</legend>${chips('worth')}</fieldset>
        <fieldset class="tb-mem-chipset"><legend>Not worth it</legend>${chips('not')}</fieldset>
        <div class="field"><label for="worth-other">Other, in your words <span class="optional">(optional)</span></label><input id="worth-other" name="other" maxlength="300" autocomplete="off"></div>
        ${viewer === 'owner' ? html`<label class="tb-mem-remember"><input type="checkbox" name="remember" value="1"> Remember this for next time</label>` : ''}
        <p class="tb-small tb-muted">${rememberLine(b, viewer, remembered)}</p>
        <button class="btn btn-navy btn-sm" type="submit">Send ${icon('arrow')}</button>
      </form>
    </details>` : ''}
  </section>`;
}

// ---- the memories page ---------------------------------------------------------------------------

// WHAT DO YOU WANT TO REMEMBER? The chips as links that reload the page with another `mem=`: a chosen
// chip (with its rank) takes itself out; another one goes in last, up to three. Nothing is chosen for
// the traveler: a page opened without goals shows them all unchosen.
function goalChips(token, cx, gs) {
  return html`<ul class="tb-mem-chips">${X.GOALS.map(g => {
    const at = gs.indexOf(g.key);
    if (at >= 0) return html`<li><a class="tb-mem-chip is-on" href="${memUrl(token, cx, { mem: memParam(gs.filter(k => k !== g.key)) }, '#goals')}" aria-pressed="true" data-goal="${g.key}"><span class="tb-mem-rank">#${at + 1}</span> ${g.label}</a></li>`;
    if (gs.length >= 3) return html`<li><span class="tb-mem-chip is-off" aria-disabled="true">${g.label}</span></li>`;
    return html`<li><a class="tb-mem-chip" href="${memUrl(token, cx, { mem: memParam([...gs, g.key]) }, '#goals')}" aria-pressed="false" data-goal="${g.key}">${g.label}</a></li>`;
  })}</ul>`;
}

const AMOUNTS = [10000, 25000, 50000];

// `promo` is { code, total, off } when the link carries a code: the page prices before it, says what it
// takes off, and its review link names the total with the code as the one seen (the review then says
// "still", never "dropped" because the code was applied). `pxNote` says a protection the link carried
// that this destination does not offer (dropped by the route); `evNote` says an event the link carried that cannot
// belong to this trip (dropped by the route: service.dropFarEvent).
function memoriesView(ctx, { data, cx, mem: d, promo = null, promoError = null, amountNote = null, pxNote = null, evNote = null, user }) {
  const { trip: t, token, origin } = data;
  const s = t.spec, gs = d.goals, cap = cx.budget || null;
  const pxGone = cx.protect ? { px: undefined } : {};
  const head = html`
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / ${cx.searchParams ? html`<a href="/trips?${cx.searchParams}">Your trips</a> / ` : ''}<a href="${tripUrl(token, cx)}">${t.dest.name}</a> / <span aria-current="page">Make it more memorable</span></nav>
  <header class="tb-mem-head">
    <p class="eyebrow">${plural(s.nights, 'night')} in ${t.dest.name} · ${longDate(s.depart)} – ${longDate(t.flight.return)} · ${plural(s.travelers, 'traveler')} · from ${origin ? origin.city : s.from} ${demoBadge(t.demo)}</p>
    <h1>Make it more memorable</h1>
    <p class="tb-mem-signature">${X.SIGNATURE_LINE}</p>
    <p class="tb-muted">This trip is ${money(t.total)} all in. Below: what it gives the goals you ranked, where the money goes, and every version that could make it more memorable, each priced in full. Nothing changes on this page: every button opens that version, and you decide. Hotel stars, brands and upgrades count only when they matter to what you want to remember.</p>
    ${promo ? html`<p class="tb-tip" data-promo="${promo.code}">${icon('info')} Promo code ${promo.code} goes with you to every version you open from here: ${money(promo.off)} off this trip, so ${money(promo.total)} with it. The totals on this page are before the code; the review page applies it.</p>` : promoError ? html`<p class="tb-tip tb-tip-warn">${icon('alert')} ${promoError} The code is not carried on from here.</p>` : ''}
    ${pxNote ? html`<p class="tb-mem-main is-missing tb-tip tb-tip-warn">${icon('alert')} <span>${pxNote}</span></p>` : ''}
    ${evNote ? html`<p class="tb-mem-main is-missing tb-tip tb-tip-warn" data-event-note>${icon('alert')} <span>${evNote}</span></p>` : ''}
    ${mainLine(d, { token, cx, trip: t })}
  </header>
  <section class="tb-panel" id="goals" aria-labelledby="goals-title">
    <h2 id="goals-title">${icon('sparkle')} WHAT DO YOU WANT TO REMEMBER?</h2>
    <p class="tb-muted">Up to three, in the order that matters most: the first you pick is the one you ranked #1. Everything below is judged by these and by this trip's facts, never by stars, brand or what Tripelyx earns.</p>
    ${goalChips(token, cx, gs)}
    ${gs.includes('new') ? html`<p class="tb-small tb-muted">${X.NEW_NOTE}</p>` : ''}
  </section>`;
  if (!gs.length) {
    const body = html`<div class="container tb-trip tb-mem">${head}
  <p class="tb-tip">${icon('info')} Pick what you want to remember and I'll judge this trip by it. Until then nothing here is called worth it, and nothing is suggested.</p>
  <p class="tb-mem-foot"><a class="btn btn-navy" href="${tripUrl(token, cx)}">${icon('arrow-left')} Back to this trip · ${money(t.total)}</a></p>
</div>`;
    return layout({ title: 'Make it more memorable', active: 'plan', body, ctx, noindex: true, description: `${t.dest.name}: what this ${money(t.total)} trip gives the goals you rank, and every version that could make it more memorable.` });
  }

  const r = d.receipt, al = d.allocation, rh = d.rhythm, hoe = d.hotelOrExperience, mt = d.memoryTest, bvm = d.bigVsMany, loc = d.location, fa = d.fatigue, L = d.ladder, ss = d.sweetSpot, sf = d.sameFeeling, mm = d.more, fc = d.finalCheck;
  const mainName = d.main ? d.main.name : null;
  // The review link names the total with the code as the one seen when a code rides along.
  const seen = promo ? promo.total : t.total;
  const free = d.free ? { ...d.free, items: d.free.items.filter(it => it.onDates !== false), off: d.free.items.filter(it => it.onDates === false) } : null;
  const body = html`
<div class="container tb-trip tb-mem">
  ${head}
  <nav class="tb-quick" aria-label="On this page">
    <a class="btn btn-ghost btn-sm" href="#receipt">Why this trip is built this way</a><a class="btn btn-ghost btn-sm" href="#rhythm">The rhythm</a><a class="btn btn-ghost btn-sm" href="#hotel-or-experience">Hotel or experience?</a><a class="btn btn-ghost btn-sm" href="#make-memorable">Make ${dollars(d.amount)} memorable</a><a class="btn btn-ghost btn-sm" href="#ladder">Where should I stop?</a><a class="btn btn-ghost btn-sm" href="#more">Make it better for $0 more</a>
    <a class="btn btn-ghost btn-sm" href="${tripUrl(token, cx)}">${icon('arrow-left')} Back to the trip</a>
  </nav>

  <section class="tb-panel" id="receipt" aria-labelledby="receipt-title">
    <h2 id="receipt-title">${icon('layers')} WHY THIS TRIP IS BUILT THIS WAY</h2>
    ${receiptBlock(r, cx, { cap })}
  </section>

  <section class="tb-panel" id="budget" aria-labelledby="budget-title">
    <h2 id="budget-title">${icon('wallet')} YOUR EXPERIENCE BUDGET</h2>
    <p class="tb-muted">Where this trip's money goes, from its own price lines. The rows add up to the total.</p>
    <table class="tb-mem-table tb-mem-alloc">
      <thead><tr><th scope="col">Part of the trip</th><th scope="col" class="tb-mem-num">Amount</th></tr></thead>
      <tbody>${al.lines.map(l => html`<tr data-cents="${l.amount}" data-key="${l.key}"><td>${l.label}</td><td class="tb-mem-num">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</td></tr>`)}</tbody>
      <tfoot><tr class="tb-mem-total" data-total="${al.total}"><td>Total</td><td class="tb-mem-num">${money(al.total)}</td></tr>${al.keep !== null ? html`<tr><td>${al.keep < 0 ? `Over your ${money(cap)}` : `Left of your ${money(cap)}`}</td><td class="tb-mem-num">${money(Math.abs(al.keep))}</td></tr>` : ''}</tfoot>
    </table>
    <p class="tb-mem-say">${say(al.text)}</p>
  </section>

  <section class="tb-panel" id="rhythm" aria-labelledby="rhythm-title">
    <h2 id="rhythm-title">${icon('calendar')} THE RHYTHM</h2>
    <p class="tb-muted">${say(rh.text)}</p>
    <ol class="tb-mem-days">${rh.days.map(day => html`<li class="${[day.open ? 'is-open' : '', mainName && day.items.includes(mainName) ? 'is-main' : '', day.event ? 'is-event' : ''].filter(Boolean).join(' ')}" data-day="${day.n}" data-label="${day.label}"${mainName && day.items.includes(mainName) ? html` data-main="${d.main.id}"` : ''}${day.event ? html` data-event="${day.event.date}"` : ''}><span class="tb-mem-day">Day ${day.n} · ${shortDate(day.date)}</span><b>${day.label}</b>${day.items.length ? html`<small>${day.items.join(', ')}</small>` : ''}</li>`)}</ol>
    <p class="tb-small tb-muted">${plural(rh.fullDays, 'full day')}, ${plural(rh.openDays, 'open day')}. No experience on the day you arrive or the day you fly home.${rh.eventDay ? ` ${X.eventDayWords(rh)}` : ''}${rh.unplaced.length ? ` ${joinAnd(rh.unplaced.map(a => a.name))} ${rh.unplaced.length === 1 ? 'has' : 'have'} no full day of ${rh.unplaced.length === 1 ? 'its' : 'their'} own: see SCHEDULE CONFLICT below.` : ''}</p>
  </section>

  <section class="tb-panel" id="hotel-or-experience" aria-labelledby="hoe-title">
    <h2 id="hoe-title">${icon('bed')} HOTEL OR EXPERIENCE?</h2>
    <p class="tb-muted">The cheapest hotel step-up for this trip against the best goal experiences not in it yet, both priced in full on the same flights and dates.</p>
    <div class="tb-leak-two">
      <div class="tb-leak-block${hoe.verdict === 'a' && !hoe.a.over ? ' is-pick' : ''}"><h3>A · ${hoe.a ? hoe.a.text : 'Hotel upgrade'}</h3>
        ${hoe.a ? html`<p>${hoe.a.hotel.name}: ${joinAnd(hoe.a.gets)}.</p>${overNote(hoe.a, cap)}<p class="tb-mem-actions">${versionLink(hoe.a, cx, 'See the hotel version')}</p>` : html`<p class="tb-muted">No hotel step-up is priced for this trip inside your rules.</p>`}</div>
      <div class="tb-leak-block${hoe.verdict === 'b' && !hoe.b.over ? ' is-pick' : ''}"><h3>B · ${hoe.b ? hoe.b.text : 'Experiences'}</h3>
        ${hoe.b ? html`<p>${joinAnd(hoe.b.names)}.</p>${overNote(hoe.b, cap)}<p class="tb-mem-actions">${versionLink(hoe.b, cx, 'See the experiences version')}</p>` : html`<p class="tb-muted">No goal experience is left to add that a free day can hold.</p>`}</div>
    </div>
    <p class="tb-mem-say">${say(hoe.text)}</p>
  </section>

  <section class="tb-panel" id="make-memorable" aria-labelledby="mt-title">
    <h2 id="mt-title">${icon('sparkle')} MAKE ${dollars(d.amount)} MEMORABLE</h2>
    <p class="tb-muted">Every version priced between ${money(Math.round(d.amount * 0.5))} and ${money(Math.round(d.amount * 1.5))} above this trip, and anything free in the guide data, ranked by what it adds to the goals you gave me. Try ${AMOUNTS.filter(a => a !== d.amount).map((a, i) => html`${i ? ' or ' : ''}<a href="${memUrl(token, cx, { amt: a / 100 }, '#make-memorable')}">${dollars(a)}</a>`)}.</p>
    ${amountNote ? html`<p class="tb-tip tb-tip-warn">${icon('info')} ${amountNote}</p>` : ''}
    <p class="tb-mem-say">${say(mt.text)}</p>
    ${mt.candidates.length ? html`<ul class="tb-leak-list tb-mem-list">${mt.candidates.slice(0, 8).map(c => html`<li data-kind="${c.kind}"${c === mt.pick ? html` data-pick="1"` : ''}>
        <div class="tb-leak-item"><b>${c.label}</b><small>${say(afterLabel(c.text, c.label))}</small></div>
        <span class="tb-leak-amt">${c.kind === 'free' ? '+$0' : html`${deltaTag(c.delta)}`}</span>
        <span class="tb-leak-actions">${c.kind === 'free' ? html`<span class="tb-small tb-muted">${c.source}, checked ${longDate(c.checkedAt)}</span>` : versionLink(c, cx, 'See it', { cap })}</span>
      </li>`)}</ul>` : ''}
  </section>

  <section class="tb-panel" id="big-or-many" aria-labelledby="bvm-title">
    <h2 id="bvm-title">${icon('flag')} ONE BIG MEMORY vs MORE THINGS TO DO</h2>
    <p class="tb-muted">One big experience against two or three smaller ones within 15% of its price, both for your goals. Your call: I don't pick between them.</p>
    ${bvm.a ? html`<div class="tb-leak-two">
      <div class="tb-leak-block"><h3>ONE BIG MEMORY</h3><p><b>${bvm.a.activity.name}</b>: ${bvm.a.activity.hours}h, ${money(bvm.a.cost)} for ${plural(s.travelers, 'traveler')}.</p>${overNote(bvm.a, cap)}<p class="tb-mem-actions">${versionLink(bvm.a, cx, 'See it')} ${deltaTag(bvm.a.delta)}</p></div>
      <div class="tb-leak-block"><h3>MORE THINGS TO DO</h3>${bvm.b ? html`<p><b>${joinAnd(bvm.b.activities.map(x => x.name))}</b>: ${bvm.b.activities.reduce((n, x) => n + x.hours, 0)}h in all, ${money(bvm.b.cost)}.</p>${overNote(bvm.b, cap)}<p class="tb-mem-actions">${versionLink(bvm.b, cx, 'See it')} ${deltaTag(bvm.b.delta)}</p>` : html`<p class="tb-muted">No two or three smaller experiences here come within 15% of its price.</p>`}</div>
    </div>` : ''}
    <p class="tb-small">${say(bvm.text)}</p>
  </section>

  <section class="tb-panel" id="free" aria-labelledby="free-title">
    <h2 id="free-title">${icon('compass')} FIND FREE THINGS WORTH DOING</h2>
    ${free ? html`<p class="tb-muted" data-source="${free.source}">Free according to ${free.source}, checked ${longDate(free.checkedAt)}. Nothing here is booked or added to your total.</p>
      ${free.items.length ? html`<ul class="tb-list tb-mem-free">${free.items.map(it => html`<li><b>${it.name}</b>: ${it.note}${it.when ? ` (${say(it.when)})` : ''}. <small>${it.matches ? `Matches ${rankWord(it.matches, gs)}.` : 'Outside the goals you gave me.'}</small></li>`)}</ul>` : ''}
      ${free.off.length ? html`<p class="tb-small tb-muted">Not free on your dates: ${free.off.map(it => `${it.name} (${say(it.when)})`).join('; ')}.</p>` : ''}
      ${d.freeOverPaid ? html`<p class="tb-mem-say">${say(d.freeOverPaid.text)}</p>` : ''}`
      : html`<p class="tb-tip">${icon('info')} No verified free options for ${t.dest.name} in our data. I don't call anything free without a source and the date it was checked.</p>`}
  </section>

  <section class="tb-panel" id="location" aria-labelledby="loc-title">
    <h2 id="loc-title">${icon('pin')} LOCATION</h2>
    ${loc.unknown ? html`<p>${loc.unknown}</p>` : html`<div class="tb-leak-two">
      ${!(loc.a && loc.a.own) && !(loc.b && loc.b.own) ? html`<div class="tb-leak-block"><h3>${t.hotel.name}</h3><p>${t.hotel.area}.</p><p class="tb-small tb-muted">This trip's hotel, by its listed location.</p></div>` : ''}
      ${loc.a ? html`<div class="tb-leak-block"><h3>${loc.a.hotel.name}</h3><p>${loc.a.text}.</p>${loc.a.own ? html`<p class="tb-small tb-muted">This trip's hotel.</p>` : html`${overNote(loc.a, cap)}<p class="tb-mem-actions">${versionLink(loc.a, cx, 'See it')}</p>`}</div>` : ''}
      ${loc.b ? html`<div class="tb-leak-block${loc.verdict ? ' is-pick' : ''}"><h3>${loc.b.hotel.name}</h3><p>${loc.b.text}.</p>${loc.b.own ? html`<p class="tb-small tb-muted">This trip's hotel.</p>` : html`${overNote(loc.b, cap, { pick: !!loc.verdict, trip: t })}<p class="tb-mem-actions">${versionLink(loc.b, cx, 'See it')}</p>`}</div>` : ''}
    </div><p class="tb-mem-say">${say(loc.text)}</p>`}
  </section>

  <section class="tb-panel" id="schedule" aria-labelledby="sched-title">
    <h2 id="sched-title">${icon('clock')} SCHEDULE CONFLICT</h2>
    ${d.collisions.length ? html`<ul class="tb-mem-conflicts">${d.collisions.map(c => html`<li><p class="tb-mem-say">${say(c.text)}</p>${c.fixes.length ? html`<ul class="tb-list tb-small">${c.fixes.map(f => html`<li>${f.trip && f.token ? versionLink(f, cx, say(f.text), { cls: '', cap }) : f.protected ? html`<span class="tb-mem-iconline">${icon('lock')}<span>${say(f.text)}</span></span>` : say(f.text)}</li>`)}</ul>` : ''}</li>`)}</ul>`
      : html`<p class="tb-tip">${icon('check')} No schedule conflict: every experience has a full day of its own, none on the day you arrive or the day you fly home.</p>`}
    <h3>${icon('sun')} GIVE ME MORE FREE TIME</h3>
    <p>${say(fa.text)}</p>
    ${fa.reasons.length ? html`<ul class="tb-list tb-small">${fa.reasons.map(x => html`<li>${say(x)}</li>`)}</ul>` : ''}
    ${fa.freeTime && fa.freeTime.trip ? html`<p class="tb-mem-actions">${versionLink(fa.freeTime, cx, `Open up a day: without ${fa.freeTime.removed.name}`, { cls: 'btn btn-navy', cap })} ${deltaTag(fa.freeTime.delta)}</p>` : ''}
  </section>

  <section class="tb-panel" id="ladder" aria-labelledby="ladder-title">
    <h2 id="ladder-title">${icon('trend')} EXPERIENCE LADDER</h2>
    <p class="tb-muted">${t.dest.name} on your dates${L.nights && L.nights.length ? `, ${L.nights.length === 1 ? plural(L.nights[0], 'night') : `${L.nights.slice(0, -1).join(', ')} or ${plural(L.nights[L.nights.length - 1], 'night')}`}` : ''}, from the cheapest trip I'd still recommend for your goals: each step the cheapest priced version that is meaningfully more memorable, with nothing given up.</p>
    ${L.rungs.length ? html`<ol class="tb-mem-ladder">${L.rungs.map(g => html`<li class="${[g === ss.rung ? 'is-sweet' : '', g.token === token ? 'is-this' : ''].filter(Boolean).join(' ')}"><span class="tb-mem-rung">${g.label}</span>${versionLink(g, cx, g.token === token ? 'This trip' : 'See it', { cls: 'tb-small' })}${g === ss.rung ? html` <b class="tb-mem-sweet">MEMORY SWEET SPOT</b>` : ''}</li>`)}${L.top ? html`<li class="is-top"><span class="tb-mem-rung">${L.top.text}</span><span class="tb-small">${money(L.top.total)}, your maximum</span></li>` : ''}</ol>
      <p class="tb-mem-say">${say(ss.text)}</p>${ss.reasons.length ? html`<ul class="tb-leak-kept">${ss.reasons.map(x => html`<li>${say(x)}</li>`)}</ul>` : ''}`
      : html`<p>${say(L.text)}</p>`}
  </section>

  <section class="tb-panel" id="same-feeling" aria-labelledby="sf-title">
    <h2 id="sf-title">${icon('globe')} SAME FEELING FOR LESS</h2>
    ${sf.trip ? html`<p class="tb-mem-say">${say(sf.text)}</p>${cx.protect ? html`<p class="tb-small tb-muted">A different trip can't hold ${mainName || 'the protected experience'}: opening it leaves that protection behind, and the trip page says so.</p>` : ''}<p class="tb-mem-actions">${versionLink(sf, cx, 'See the different trip', { extra: pxGone, cap })} ${deltaTag(sf.delta)}</p>` : html`<p>${say(sf.text)}</p>`}
  </section>

  <section class="tb-panel" id="alternative" aria-labelledby="alt-title">
    <h2 id="alt-title">${icon('search')} FIND AN ALTERNATIVE EXPERIENCE</h2>
    ${d.dupes.length ? html`<ul class="tb-mem-dupes">${d.dupes.map(x => html`<li><h3>${x.activity.name} <small>${money(x.activity.pricePerPerson)} a person</small></h3>
      ${x.protected ? html`<p class="tb-small tb-mem-iconline">${icon('lock')}<span>The protected experience: no swap is offered for it.</span></p>`
        : x.dupe && x.dupe.alternative ? html`<p>${x.dupe.alternative.name}: ${money(x.dupe.alternative.pricePerPerson)} a person.</p><p class="tb-small"><b>Similar:</b> ${say(joinAnd(x.dupe.similar))}. <b>Different:</b> ${say(joinAnd(x.dupe.different))}.</p>${x.dupe.trip ? html`<p class="tb-mem-actions">${versionLink(x.dupe, cx, `Swap for ${x.dupe.alternative.name}`, { cap })} ${deltaTag(x.dupe.delta)}</p>` : ''}`
        : html`<p class="tb-small tb-muted">${X.NO_DUPE}</p>`}</li>`)}</ul>`
      : html`<p class="tb-muted">No paid experience in this trip to find an alternative for.</p>`}
  </section>

  <section class="tb-panel" id="protection" aria-labelledby="prot-title">
    <h2 id="prot-title">${icon('shield')} PROTECTION</h2>
    ${d.protection ? html`<p class="tb-muted">${mainName}, ${d.protected ? 'the protected experience' : 'this trip\'s main experience'}: what our data verifies, and what needs verification before you count on it.${d.missing ? ` The protected experience, ${d.missing.name}, is not in this version, so these rows check the main experience it has.` : ''}</p>
      ${protectionTable(d.protection)}<p class="tb-small">${say(d.protection.text)}</p>
      ${d.bestDay ? html`<ul class="tb-ready tb-ready-wrap tb-mem-checks">${d.bestDay.reasons.map(x => html`<li class="${x.ok ? '' : 'is-miss'}">${icon(x.ok ? 'check' : 'info')}<span>${say(x.text)}</span></li>`)}</ul>${d.bestDay.weather ? html`<p class="tb-small tb-mem-iconline">${icon('sun')}<span>${say(d.bestDay.weather)}</span></p>` : ''}` : ''}
      <h3>${icon('info')} BACKUP</h3>
      ${d.backup ? html`<p>${say(d.backup.text)}</p>${[d.backup, d.backup.overChoice].filter(v => v && v.trip).map(v => html`<p class="tb-mem-actions">${versionLink(v, cx, `See the trip with ${v.activity.name} added`, { cap })} ${deltaTag(v.delta)}</p>`)}` : html`<p class="tb-small tb-muted">${mainName} is not marked weather-dependent in our data, so no backup is suggested.</p>`}`
      : t.activities.length ? html`<p class="tb-muted">The main experience could not be checked here.</p>`
        : html`<p class="tb-muted">This trip has no paid experience yet, so there is nothing to protect. Add one from the sections above.</p>`}
  </section>

  <section class="tb-panel" id="final-check" aria-labelledby="fc-title">
    <h2 id="fc-title">${icon(fc.ok ? 'check' : 'alert')} FINAL EXPERIENCE CHECK</h2>
    ${finalCheckBlock(fc, cx, { cap })}
  </section>

  <section class="tb-panel" id="more" aria-labelledby="more-title">
    <h2 id="more-title">${icon('sparkle')} MAKE IT BETTER FOR $0 MORE</h2>
    <p class="tb-muted">Changes that keep or raise what this trip gives your goals, each at or under this trip's ${money(t.total)}.</p>
    ${mm.free.length ? html`<ul class="tb-leak-list tb-mem-list" data-list="free">${mm.free.map(f => html`<li data-kind="${f.kind}">
        <div class="tb-leak-item"><small>${say(f.text)}</small></div>
        <span class="tb-leak-amt">${f.kind === 'free-thing' ? '+$0' : deltaTag(f.delta)}</span>
        <span class="tb-leak-actions">${f.kind === 'free-thing' ? html`<span class="tb-small tb-muted">${f.source}, checked ${longDate(f.checkedAt)}</span>` : versionLink(f, cx, 'See it', f.kind === 'destination' ? { extra: pxGone, cap } : { cap })}</span>
      </li>`)}</ul>` : html`<p class="tb-tip">${icon('check')} Nothing at or under ${money(t.total)} makes this trip more memorable by what you told me${mm.givesUp.length ? ' with nothing given up' : ''}.</p>`}
    ${mm.givesUp.length ? html`<h3 id="more-trades">${icon('alert')} Each of these gives something up</h3>
      <p class="tb-muted tb-small">Also at or under ${money(t.total)}, and never mixed with the list above: each one's trade-off is said with it, and nothing is taken unless you open it and choose it.</p>
      <ul class="tb-leak-list tb-mem-list tb-mem-trades" data-list="gives-up">${mm.givesUp.map(f => html`<li data-kind="${f.kind}">
        <div class="tb-leak-item"><small>${say(f.text)}</small></div>
        <span class="tb-leak-amt">${deltaTag(f.delta)}</span>
        <span class="tb-leak-actions">${versionLink(f, cx, 'See it', f.kind === 'destination' ? { extra: pxGone, cap } : { cap })}</span>
      </li>`)}</ul>` : ''}
    <h3 id="more-paid">${icon('plus')} MAKE IT MORE MEMORABLE</h3>
    <p class="tb-muted tb-small">With more money: each step the cheapest priced version above this one that is meaningfully more memorable, nothing given up${cap ? `, at or under your ${money(cap)}` : ''}.</p>
    ${mm.paid.length ? html`<ul class="tb-leak-list tb-mem-list">${mm.paid.map(p => html`<li><div class="tb-leak-item"><b>${p.label}</b></div><span class="tb-leak-amt">${deltaTag(p.total - t.total)}</span><span class="tb-leak-actions">${versionLink(p, cx, 'See it', { cap })}</span></li>`)}</ul>`
      : html`<p class="tb-tip">${icon('check')} No paid step adds an experience gain with nothing given up. ${X.PERSONALITY[2]}</p>`}
  </section>

  <section class="tb-mem-close" aria-label="Our promise">
    <p class="tb-mem-signature">${X.FINAL_LINE}</p>
    <p class="tb-mem-foot"><a class="btn btn-navy" href="${tripUrl(token, cx)}">${icon('arrow-left')} Back to this trip · ${money(t.total)}</a> <a class="btn btn-ghost" href="${reviewUrl(token, cx, seen)}">Review and book ${icon('arrow')}</a>${user ? '' : html` <span class="tb-small tb-muted">Nothing is charged until you confirm on the payment page.</span>`}</p>
  </section>
</div>`;
  return layout({
    title: 'Make it more memorable', active: 'plan', body, ctx, noindex: true,
    description: `${t.dest.name}: what this ${money(t.total)} trip gives the goals you ranked, and every version that could make it more memorable, priced in full.`,
  });
}

module.exports = { memoriesView, mainLine, receiptBlock, protectionTable, experienceReviewPanels, worthItPanel, goalChips };
