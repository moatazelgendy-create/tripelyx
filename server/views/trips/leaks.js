// THE MONEY LEAK HUNTER's pages: the Money Leak page (what you don't need to pay for), the review
// page's savings check and money leak check, and the booking page's saver victory screen. Every
// number here is the engine's (server/trips/leaks.js prices every version with priceTrip), every
// sentence is the engine's `text`, and every REMOVE / SHOW / TAKE control is a link to a priced
// version by its token: nothing is removed on a page by itself, nothing optional is preselected, and
// "keep" is an anchor that changes nothing. No urgency, no scarcity, no prediction anywhere.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { contextParams } = require('../../trips/optimizer');
const { decodeSpec } = require('../../trips/spec');
const { money, longDate, plural, joinAnd, demoBadge, hiddenParams } = require('./common');
const { SIGNATURE, ORDER_LABELS, PRIORITY_ORDER, showWords } = require('../../trips/leaks');

// Every link carries the context, and with it the promo code the review page verified (`cx.promo`),
// so a version opened from here is priced the way this page priced it.
const tripUrl = (token, cx, hash = '') => `/trip/${token}?${contextParams(cx)}${hash}`;
const leaksUrl = (token, cx, hash = '') => `/trip/${token}/leaks?${contextParams(cx)}${hash}`;
const reviewUrl = (token, cx, seen) => `/trip/${token}/review?${contextParams(cx, { seen })}`;
const slug = s => String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const KIND_LABEL = { core: 'Core', mandatory: 'Mandatory', optional: 'Optional', discount: 'Discount' };
const CHECK_STATUS = { ok: 'OK', found: 'Found', na: 'Not compared' };

// A difference against the current trip, with its sign; the same shape the trip page uses.
function deltaTag(d) {
  if (d === 0) return html`<span class="tb-delta tb-delta-same">same price</span>`;
  return html`<span class="tb-delta ${d < 0 ? 'tb-delta-save' : 'tb-delta-add'}">${d < 0 ? '−' : '+'}${money(Math.abs(d))}</span>`;
}

// The breakdown table: every row a part of a price line, the three kinds totalled, the total last.
// Each row carries its cents as data so a test (or a script) can add them up without parsing money.
function breakdownTable(b) {
  const discount = b.rows.filter(r => r.kind === 'discount').reduce((n, r) => n + r.amount, 0);
  return html`<table class="tb-leak-table tb-leak-breakdown">
    <thead><tr><th scope="col">Item</th><th scope="col">Kind</th><th scope="col" class="tb-leak-num">Amount</th></tr></thead>
    <tbody>${b.rows.map(r => html`<tr class="is-${r.kind}" data-cents="${r.amount}"><td><b>${r.label}</b>${r.note ? html`<small>${r.note}</small>` : ''}</td><td>${KIND_LABEL[r.kind]}</td><td class="tb-leak-num">${r.amount < 0 ? '−' : ''}${money(Math.abs(r.amount))}</td></tr>`)}</tbody>
    <tfoot>
      <tr><td>Core: flights and the stay</td><td></td><td class="tb-leak-num">${money(b.coreTotal)}</td></tr>
      <tr><td>Mandatory: taxes, fees and the service fee</td><td></td><td class="tb-leak-num">${money(b.mandatoryTotal)}</td></tr>
      <tr><td>Optional</td><td></td><td class="tb-leak-num">${money(b.optionalTotal)}</td></tr>
      ${discount ? html`<tr><td>Promo code</td><td></td><td class="tb-leak-num">−${money(-discount)}</td></tr>` : ''}
      <tr class="tb-leak-total" data-total="${b.total}"><td>Total</td><td></td><td class="tb-leak-num">${money(b.total)}</td></tr>
    </tfoot>
  </table>`;
}

// ---- the review page's pieces -------------------------------------------------------------------

// YOUR SAVINGS CHECK: the max, the trip and what is not used (or the overrun), from the scorecard with
// no history (a page applies nothing). Without a budget, only the trip. When part of the money was
// protected for the destination, the maximum here is the booking's share and the page says so with
// the whole number, as the trips page does: the traveler gave the whole, not the share.
function savingsCheckPanel(sc, { keep = 0 } = {}) {
  return html`<section class="tb-panel tb-leak-check" id="savings-check" aria-labelledby="savings-check-title">
    <h2 id="savings-check-title">${icon('wallet')} YOUR SAVINGS CHECK</h2>
    <div class="tb-final-nums tb-leak-nums${sc.over ? ' is-over' : ''}">${sc.lines.map(l => html`<div class="${l.key === 'over' ? 'is-over' : ''}"><span>${l.label}</span><b>${money(l.amount)}</b></div>`)}</div>
    <p class="tb-muted tb-small">${sc.max ? (sc.over ? `${money(sc.over)} over the ${money(sc.max)} you gave as a maximum: your call, and never charged without the button below.` : `The ${money(sc.notUsed)} not used stays yours: the maximum was a ceiling, not a target.`) : 'No maximum was given for this trip, so there is nothing to measure it against here.'}${sc.max && keep ? ` The ${money(sc.max)} is the booking's share of the ${money(sc.max + keep)} you gave: ${money(keep)} is protected for the destination and no part of the booking.` : ''}</p>
  </section>`;
}

// The control for the check's finding, worded by what that version changes, never one word for all:
// a removal when the flights, hotel, dates and nights are the same ("REMOVE $X · $Y without it"); a
// fare switch that keeps the same bags ("SWITCH FARE"); and the like-for-like version, which is a
// hotel or fare swap and so is shown, not "removed". A removal or switch opens that version's review,
// re-checked on arrival; the like-for-like version opens its trip page, where every change is listed.
function foundControl(f, token, cx) {
  if (f.key === 'config') return { href: tripUrl(f.token, cx), words: `SHOW ME THE LIKE-FOR-LIKE VERSION · ${money(f.total)}` };
  const a = decodeSpec(token), b = decodeSpec(f.token);
  const removal = a.flight === b.flight && a.hotel === b.hotel && a.depart === b.depart && a.nights === b.nights;
  return { href: reviewUrl(f.token, cx, f.total), words: removal ? `REMOVE ${money(f.amount)} · ${money(f.total)} without it` : `SWITCH FARE · ${money(f.total)}, the same bags` };
}

// MONEY LEAK CHECK: the six checks with their status words, the completion sentence, and, when one
// more cost qualifies, its control (a link to that version, re-checked on arrival) and KEEP IT (an
// anchor: nothing changes). The links carry the verified promo code with the rest of the context.
function leakCheckPanel(scan, { token, cx }) {
  const f = scan.found, control = f ? foundControl(f, token, cx) : null;
  return html`<section class="tb-panel tb-leak-check" id="leak-check" aria-labelledby="leak-check-title">
    <h2 id="leak-check-title">${icon('search')} MONEY LEAK CHECK</h2>
    <p class="tb-muted tb-small">Before you pay: is there a cost in this price you don't need? Only a removal with no trade-off counts.</p>
    <ul class="tb-ready tb-ready-wrap tb-leak-checks">${scan.checks.map(c => html`<li class="is-${c.status}">${icon(c.status === 'found' ? 'alert' : c.status === 'na' ? 'info' : 'check')}<span><b>${c.label}</b> <span class="tb-leak-status">${CHECK_STATUS[c.status]}</span><br>${c.text}</span></li>`)}</ul>
    <p class="tb-leak-say">${scan.text}</p>
    ${f ? html`<p class="tb-leak-actions"><a class="btn btn-navy" href="${control.href}" data-found="${f.key}">${control.words}</a> <a class="btn btn-ghost" href="#leak-check">KEEP IT</a> <a class="tb-small" href="${leaksUrl(token, cx)}">See everything you don't need to pay for</a></p>`
      : html`<p class="tb-small"><a href="${leaksUrl(token, cx)}">See everything you are paying for, and what you could take out with a trade-off</a>.</p>`}
  </section>`;
}

// "What am I paying for?" folded under the review's trip summary.
function breakdownDetails(b) {
  return html`<details class="tb-leak-details" id="paying"><summary>What am I paying for?</summary>${breakdownTable(b)}<p class="tb-small tb-muted">${b.text}</p></details>`;
}

// ---- the booking page's saver victory screen -------------------------------------------------
// YOU GAVE US / YOUR TRIP / YOU KEPT, then AND YOU KEPT: only the asks the trip's facts meet; an ask
// the trip does not meet is listed as not kept; an ask never stated is not listed. Over the maximum:
// the overrun, as approved, and no "kept" number. With money protected for the destination the
// engine's maximum is the booking's share (`forBooking`), and YOU GAVE US says the whole number the
// traveler gave with the protected part named, the wording the trips page uses; the engine's own
// `forBooking` / `keep` are used when it gives them, else the quote's `keep` is passed in.
function victoryPanel(v, { keep = 0 } = {}) {
  const kept = v.kept !== null;
  const forBooking = Number.isFinite(v.forBooking) ? v.forBooking : v.gave;
  const reserve = Number.isFinite(v.reserve) ? v.reserve : Number.isFinite(v.keep) ? v.keep : keep || 0;
  const whole = forBooking + reserve;
  return html`<section class="tb-panel tb-leak-victory${kept ? '' : ' tb-panel-warn'}" id="victory" aria-labelledby="victory-title">
    <h2 id="victory-title">${icon(kept ? 'sparkle' : 'alert')} ${kept ? 'You set the maximum. You kept part of it.' : 'You went over your maximum, as you approved.'}</h2>
    <div class="tb-final-nums tb-leak-nums${kept ? '' : ' is-over'}">
      <div><span>YOU GAVE US</span><b>${money(whole)} max</b>${reserve ? html`<small>for the booking ${money(forBooking)}, ${money(reserve)} protected</small>` : ''}</div>
      <div><span>YOUR TRIP</span><b>${money(v.trip)}</b></div>
      ${kept ? html`<div><span>YOU KEPT</span><b>${money(v.kept)}</b>${reserve ? html`<small>of the booking's ${money(forBooking)}</small>` : ''}</div>` : html`<div class="is-over"><span>YOU WENT OVER BY</span><b>${money(v.over)}</b>${reserve ? html`<small>the booking's ${money(forBooking)}</small>` : ''}</div>`}
    </div>
    <p class="tb-small">${kept
      ? (reserve ? `You came in ${money(v.kept)} under your ${money(forBooking)} booking budget, the booking's share of the ${money(whole)} you gave; the ${money(reserve)} you protected for the destination was never part of the booking and stays yours too. The maximum was a ceiling, not a target.` : `You came in ${money(v.kept)} under your ${money(v.gave)} budget. The maximum was a ceiling, not a target; the rest stays yours.`)
      : `YOU WENT OVER BY ${money(v.over)}, which you approved on the review page. Nothing was taken quietly.${reserve ? (Number.isFinite(v.reserveUsed) ? ` Of the ${money(whole)} you gave, ${money(reserve)} was protected for the destination; this booking took ${v.reserveUsed >= reserve ? `all of it${v.beyond ? ` and ${money(v.beyond)} beyond your whole ${money(whole)}` : ''}` : `${money(v.reserveUsed)} of it`}, as you approved.` : ` Of the ${money(whole)} you gave, ${money(reserve)} was protected for the destination; what this booking took of it is said under Payment below.`) : ''}`}</p>
    ${v.keptRules.length ? html`<h3>${icon('check')} AND YOU KEPT</h3><ul class="tb-leak-kept">${v.keptRules.map(r => html`<li>${r}</li>`)}</ul>` : ''}
    ${v.notKept.length ? html`<h3>${icon('minus')} Not kept</h3><ul class="tb-leak-kept is-miss">${v.notKept.map(r => html`<li>${r}</li>`)}</ul>` : ''}
  </section>`;
}

// ---- the Money Leak page -----------------------------------------------------------------------

// The "show me" button for the biggest leak: words by the kind of alternative, never a bare label.
function showButton(L) {
  return `SHOW ME ${showWords(L).toUpperCase()}`;
}

// What the biggest leak's version gives up, from the facts of the two priced versions (the route's
// `givesUp`: classifyChanges' trade-off rows in words), never from the preference judgement that
// ranked it: "nothing is given up" is said only when the facts' rows are empty. An extra names the
// item itself and that nothing stated asks for it; a duplicate names what the facts lose, if
// anything; a trade-off the engine already named gets the facts' list beside it when they add to it.
function leakTip(L) {
  const gives = L.givesUp || [];
  if (L.tradeoff) return gives.length ? html`<p class="tb-tip tb-tip-warn">${icon('alert')} By the facts, this version gives up: ${joinAnd(gives)}.</p>` : '';
  if (L.kind === 'extra') return html`<p class="tb-tip">${icon('info')} You give up: ${L.label}; nothing you told me asks for it.</p>`;
  if (L.kind === 'duplicate') return gives.length ? html`<p class="tb-tip">${icon('info')} You give up: ${joinAnd(gives)}; nothing you told me asks for it.</p>` : html`<p class="tb-tip">${icon('check')} Nothing is given up by the facts of the two versions: the same need stays covered.</p>`;
  return gives.length ? html`<p class="tb-tip tb-tip-warn">${icon('alert')} You give up: ${joinAnd(gives)}.</p>` : html`<p class="tb-tip">${icon('check')} Nothing is given up by the facts of the two versions.</p>`;
}

// Why no cut ran, in the traveler's own terms: the amount as typed is shown back, never a different
// number cut in its place.
function cutNote(problem, typed, cents, total) {
  if (!problem) return '';
  const words = problem === 'unreadable' ? `I couldn't read "${typed}" as a dollar amount, so nothing was cut. Dollars, or dollars and cents (100 or 100.50), off the ${money(total)} total.`
    : problem === 'zero' ? 'Cutting $0 changes nothing, so nothing was cut.'
    : `${money(cents)} is ${cents === total ? 'the whole' : 'more than the whole'} ${money(total)} price: nothing we sell is that cheap, so nothing was cut. Name an amount under ${money(total)}, or take the lean version above for the most that comes off without changing the trip.`;
  return html`<p class="tb-tip tb-tip-warn" role="status">${icon('alert')} ${words}</p>`;
}

function leaksView(ctx, { data, cx, hunt: h, cutTyped = '', cutProblem = null, cutCents = null, promo = null, promoError = null, user }) {
  const { trip: t, token, origin } = data;
  const s = t.spec;
  const extras = h.extras, lean = h.lean, L = h.biggestLeak, fs = h.freeSavings, cut = h.cut, b = h.bags, n = h.nights;
  const order = PRIORITY_ORDER.map(k => ORDER_LABELS[k]).join(' → ');
  const promoOff = promo ? -h.breakdown.rows.filter(r => r.kind === 'discount').reduce((x, r) => x + r.amount, 0) : 0;
  const body = html`
<div class="container tb-trip tb-leak">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / ${cx.searchParams ? html`<a href="/trips?${cx.searchParams}">Your trips</a> / ` : ''}<a href="${tripUrl(token, cx)}">${t.dest.name}</a> / <span aria-current="page">What you don't need to pay for</span></nav>
  <header class="tb-leak-head">
    <p class="eyebrow">${plural(s.nights, 'night')} in ${t.dest.name} · ${longDate(s.depart)} – ${longDate(t.flight.return)} · ${plural(s.travelers, 'traveler')} · from ${origin ? origin.city : s.from} ${demoBadge(t.demo)}</p>
    <h1>What you don't need to pay for</h1>
    <p class="tb-leak-signature">${SIGNATURE}</p>
    <p class="tb-muted">This trip is ${money(t.total)} all in. Below, every dollar of it, and every version of the trip with a dollar taken out, each priced in full. Nothing is removed on this page: every button opens that version, and you decide. Nothing optional is chosen for you.</p>
    ${promo ? html`<p class="tb-tip">${icon('check')} Promo code ${promo} (${money(promoOff)} off) is in every total on this page and goes with you to every version you open from it; a trip page shows the price before the code and names the total with it.</p>` : promoError ? html`<p class="tb-tip tb-tip-warn">${icon('alert')} ${promoError} These totals are before any code, and the code is not carried on from here.</p>` : ''}
    <nav class="tb-quick" aria-label="On this page">
      <a class="btn btn-ghost btn-sm" href="#paying">What am I paying for?</a><a class="btn btn-ghost btn-sm" href="#extras">You do not need these</a><a class="btn btn-ghost btn-sm" href="#lean">Strip it down</a><a class="btn btn-ghost btn-sm" href="#leak">Biggest leak</a><a class="btn btn-ghost btn-sm" href="#free">Free savings</a><a class="btn btn-ghost btn-sm" href="#cut">Cut it in order</a>
      <a class="btn btn-ghost btn-sm" href="${tripUrl(token, cx)}">${icon('arrow-left')} Back to the trip</a>
    </nav>
  </header>

  <section class="tb-panel" id="paying" aria-labelledby="paying-title">
    <h2 id="paying-title">${icon('wallet')} What am I paying for?</h2>
    <p class="tb-muted">Every material dollar in this price, each row a part of a price line. The rows add up to the total: no mystery line items, and nothing is added later.</p>
    ${breakdownTable(h.breakdown)}
    <p class="tb-small tb-muted">${h.breakdown.text}</p>
  </section>

  <section class="tb-panel" id="extras" aria-labelledby="extras-title">
    <h2 id="extras-title">${icon('minus')} YOU DO NOT NEED THESE TO BOOK</h2>
    <p class="tb-muted">Everything optional in this price, each with what the trip costs without it, priced in full. Remove opens that version; Keep leaves everything as it is. Nothing is removed here.</p>
    ${extras.length ? html`<ul class="tb-leak-list">${extras.map(e => html`<li id="extra-${slug(e.key)}" data-cents="${e.amount}" data-key="${e.key}">
        <div class="tb-leak-item"><b>${e.label}</b><small>${e.required ? `Listed, not offered for removal: ${e.reason}` : e.reason}</small></div>
        <span class="tb-leak-amt">${money(e.amount)}</span>
        <span class="tb-leak-actions">${e.required ? html`<span class="tb-leak-rule">${icon('lock')} kept</span>` : html`<a class="btn btn-ghost btn-sm" href="${leaksUrl(e.token, cx, '#extras')}" data-remove="${e.key}">REMOVE · ${money(e.total)} without it</a><a class="btn btn-ghost btn-sm" href="#extra-${slug(e.key)}">KEEP</a>`}</span>
      </li>`)}</ul>`
      : html`<p class="tb-tip">${icon('check')} Nothing optional is in this price: flights, the stay, taxes, mandatory fees and the service fee only.</p>`}
  </section>

  <section class="tb-panel" id="lean" aria-labelledby="lean-title">
    <h2 id="lean-title">${icon('sliders')} STRIP IT DOWN</h2>
    <p class="tb-muted">The same flights, the same hotel, the same dates and nights: core transport, valid lodging, mandatory charges and your hard requirements. Everything optional comes off, and both versions are priced in full.</p>
    <div class="tb-final-nums tb-leak-nums"><div><span>CURRENT</span><b>${money(lean.current.total)}</b></div><div><span>LEAN</span><b>${money(lean.lean.total)}</b></div><div><span>DIFFERENCE</span><b>${money(lean.difference)}</b></div></div>
    ${lean.difference > 0 ? html`
      <div class="tb-leak-two">
        <div><h3>${icon('minus')} WHAT YOU GIVE UP</h3><ul class="tb-list">${lean.givesUp.map(g => html`<li>${g}</li>`)}</ul></div>
        <div><h3>${icon('check')} What stays</h3><ul class="tb-list tb-small">${lean.kept.map(k => html`<li>${k}</li>`)}</ul>${lean.notKept && lean.notKept.length ? html`<h3>${icon('minus')} Not met by this trip</h3><ul class="tb-list tb-small is-miss">${lean.notKept.map(k => html`<li>${k}</li>`)}</ul>` : ''}</div>
      </div>
      <p class="tb-leak-decide"><b>Customer decides.</b> <a class="btn btn-navy" href="${tripUrl(lean.lean.token, cx)}" data-lean="${lean.lean.token}">Take the lean version · ${money(lean.lean.total)}</a> <a class="btn btn-ghost" href="#lean">Keep what I have</a></p>
      <h3>${icon('plus')} ADD BACK WHAT'S WORTH IT</h3>
      <p class="tb-muted tb-small">Each item priced back onto the lean version on its own. The verdict comes only from what you told us; what Tripelyx earns is never part of it.</p>
      <ul class="tb-leak-list">${h.addBack.map(a => html`<li data-cents="${a.cost}">
        <div class="tb-leak-item"><b>+${money(a.cost)} ${a.label}</b><small><span class="tb-leak-verdict is-${a.verdict}">${a.verdict === 'worth' ? 'WORTH CONSIDERING' : `I'D KEEP THE ${money(a.cost)}`}</span> ${a.why}</small></div>
        <span class="tb-leak-actions"><a class="btn btn-ghost btn-sm" href="${tripUrl(a.token, cx)}">Add it back · ${money(a.total)}</a></span>
      </li>`)}</ul>`
      : html`<p class="tb-tip">${icon('check')} ${lean.text}</p>`}
  </section>

  <section class="tb-panel" id="removeOne" aria-labelledby="remove-title">
    <h2 id="remove-title">${icon('minus')} REMOVE ONE THING</h2>
    <p class="tb-muted">The lowest-value optional component, judged only by what you told us.</p>
    ${h.removeOne ? html`<p class="tb-leak-say">${h.removeOne.text} <small class="tb-muted">(${h.removeOne.why})</small></p>
      <p class="tb-leak-actions"><a class="btn btn-navy" href="${leaksUrl(h.removeOne.token, cx, '#extras')}">REMOVE IT · ${money(h.removeOne.total)}</a> <a class="btn btn-ghost" href="#removeOne">KEEP IT</a></p>`
      : extras.length ? html`<p class="tb-tip">${icon('check')} ${h.whyKept && h.whyKept.text ? h.whyKept.text : 'Every optional item in this price is one you asked for.'} So I don't pick one to remove; each is listed above with its price if you want to take one out.</p>`
      : html`<p class="tb-tip">${icon('check')} Nothing optional is in this price, so there is nothing to remove.</p>`}
  </section>

  <section class="tb-panel" id="leak" aria-labelledby="leak-title">
    <h2 id="leak-title">${icon('search')} FIND MY BIGGEST MONEY LEAK</h2>
    <p class="tb-muted">The largest avoidable cost in this price. A version with nothing given up always comes first; a trade-off is named only when no free cut exists.</p>
    ${L ? html`<p class="tb-leak-say">${L.text}</p>
      ${leakTip(L)}
      <p class="tb-leak-actions"><a class="btn btn-navy" href="${tripUrl(L.token, cx)}" data-leak="${L.token}">${showButton(L)} · ${money(L.total)}</a></p>`
      : html`<p class="tb-tip">${icon('check')} I don't see an avoidable cost in this price: nothing optional, no duplicate, and no like-for-like cheaper version.</p>`}
  </section>

  <section class="tb-panel" id="free" aria-labelledby="free-title">
    <h2 id="free-title">${icon('trend')} FREE SAVINGS</h2>
    <p class="tb-muted">A cheaper version with nothing given up, by the facts, and, kept apart, the cheapest version I'd still recommend that gives something up. The two are never one number.</p>
    <div class="tb-leak-two">
      <div class="tb-leak-block" id="free-savings"><h3>${icon('check')} Nothing given up</h3>
        ${fs.free ? html`<p class="tb-leak-say">${fs.free.text}</p><p class="tb-leak-actions"><a class="btn btn-navy" href="${tripUrl(fs.free.token, cx)}">Take the free savings · ${money(fs.free.total)}</a></p>`
          : html`<p class="tb-muted">No version of this trip with nothing given up is priced materially lower for your rules right now.</p>`}
      </div>
      <div class="tb-leak-block is-sacrifice" id="sacrifice-savings"><h3>${icon('minus')} With a trade-off</h3>
        ${fs.sacrifice ? html`<p class="tb-leak-say">${fs.sacrifice.text}</p><p class="tb-leak-actions"><a class="btn btn-ghost" href="${tripUrl(fs.sacrifice.token, cx)}">Take the trade-off version · ${money(fs.sacrifice.total)}</a></p>`
          : html`<p class="tb-muted">No cheaper version I'd still recommend gives something up for less.</p>`}
      </div>
    </div>
  </section>

  <section class="tb-panel" id="cut" aria-labelledby="cut-title">
    <h2 id="cut-title">${icon('sliders')} Cut it in order</h2>
    <p class="tb-muted">Say how much to take out and I cut it in this order, one priced change at a time, stopping as soon as the total is there: ${order}. Rules and locks are never relaxed; a stage they forbid is skipped and says why.</p>
    <form class="tb-price-form" method="get" action="/trip/${token}/leaks#cut" aria-labelledby="cut-label">
      ${hiddenParams(contextParams(cx))}
      <label id="cut-label" for="cut-amount">How much should I cut?</label>
      <div class="tb-price-row"><span class="tb-price-currency" aria-hidden="true">$</span><input id="cut-amount" name="cut" type="text" inputmode="decimal" pattern="[0-9,.]*" value="${cutTyped}" placeholder="100" autocomplete="off" aria-describedby="cut-hint" required><button class="btn btn-navy" type="submit">Cut it in order ${icon('arrow')}</button></div>
      <p class="tb-muted tb-small" id="cut-hint">In dollars, off the ${money(t.total)} total.</p>
    </form>
    ${cutNote(cutProblem, cutTyped, cutCents, t.total)}
    ${cut ? html`
      <h3>${icon('trend')} Cutting ${money(t.total - cut.target)}, to ${money(cut.target)} or under</h3>
      ${cut.steps.length ? html`<table class="tb-leak-table tb-leak-steps">
        <thead><tr><th scope="col">Stage</th><th scope="col">What changed</th><th scope="col" class="tb-leak-num">Saving</th><th scope="col" class="tb-leak-num">Running total</th></tr></thead>
        <tbody>${cut.steps.map(st => html`<tr data-cents="${st.saving}"><td>${ORDER_LABELS[st.stage]}</td><td>${st.label}${st.givesUp.length ? html`<small>Gives up: ${joinAnd(st.givesUp)}</small>` : html`<small>Nothing given up by the facts</small>`}</td><td class="tb-leak-num">−${money(st.saving)}</td><td class="tb-leak-num">${money(st.after)} <a class="tb-small" href="${tripUrl(st.token, cx)}">see it</a></td></tr>`)}</tbody>
      </table>` : ''}
      <p class="tb-tip${cut.reached ? '' : ' tb-tip-warn'}">${icon(cut.reached ? 'check' : 'alert')} ${cut.text}</p>
      ${cut.reached && cut.steps.length ? html`<p class="tb-leak-actions"><a class="btn btn-navy" href="${tripUrl(cut.final.token, cx)}">Take this version · ${money(cut.final.total)}</a> <a class="btn btn-ghost" href="#cut">Keep what I have</a></p>` : ''}
      ${cut.skipped.length ? html`<h3>${icon('info')} Not touched</h3><ul class="tb-list tb-small">${cut.skipped.map(k => html`<li><b>${ORDER_LABELS[k.stage]}:</b> ${k.why}</li>`)}</ul>` : ''}` : ''}
  </section>

  <section class="tb-panel" id="fees" aria-labelledby="fees-title">
    <h2 id="fees-title">${icon('bed')} Hotel fees</h2>
    <div class="tb-final-nums tb-leak-nums"><div><span>ROOM PRICE</span><b>${money(h.hotelFees.room)}</b></div><div><span>+ MANDATORY FEES</span><b>${money(h.hotelFees.mandatory)}</b></div><div><span>= REAL HOTEL TOTAL</span><b>${money(h.hotelFees.real)}</b></div></div>
    <p>${h.hotelFees.text}</p>
  </section>

  <section class="tb-panel" id="bags" aria-labelledby="bags-title">
    <h2 id="bags-title">${icon('bag')} Bags</h2>
    <p>${b.text}</p>
    <table class="tb-leak-table tb-leak-bags">
      <thead><tr><th scope="col">Configuration</th><th scope="col">Checked bag</th><th scope="col" class="tb-leak-num">Total</th><th scope="col" class="tb-leak-num">Difference</th><th scope="col"></th></tr></thead>
      <tbody>${b.configs.map(c => html`<tr class="${c.token === token ? 'is-on' : ''}"><td>${c.label}${c.tradeoffs.length ? html`<small>Changes: ${joinAnd(c.tradeoffs)}</small>` : ''}</td><td>${c.bagIncluded ? 'included in the fare' : c.addOn ? `add-on ${money(c.addOn)}` : 'none'}</td><td class="tb-leak-num">${money(c.total)}</td><td class="tb-leak-num">${deltaTag(c.delta)}</td><td>${c.token === token ? html`<span class="tb-delta tb-delta-same">this trip</span>` : html`<a class="tb-small" href="${tripUrl(c.token, cx)}">See it</a>`}</td></tr>`)}</tbody>
    </table>
    <p class="tb-small tb-muted">${b.shared.text}</p>
  </section>

  <section class="tb-panel" id="seats" aria-labelledby="seats-title">
    <h2 id="seats-title">${icon('plane')} Seats</h2>
    <p>${h.seats.text}</p>
  </section>

  <section class="tb-panel" id="meals" aria-labelledby="meals-title">
    <h2 id="meals-title">${icon('sun')} Meals</h2>
    <p class="tb-muted tb-small">This hotel: ${h.meals.basis === 'all-inclusive' ? 'all-inclusive' : h.meals.basis === 'breakfast' ? 'breakfast included' : 'room only'}. A meal plan is compared only when both versions are priced for these dates, same stars or better, inside your rules.</p>
    <p>${h.meals.text}${h.meals.question ? html` <b>${h.meals.question}</b>` : ''}</p>
    ${h.meals.alternatives.length ? html`<ul class="tb-changes">${h.meals.alternatives.map(a => html`<li><a href="${tripUrl(a.token, cx)}"><span>${a.hotel.name} (${a.hotel.stars}-star, ${a.hotel.area}): ${a.basis === 'all-inclusive' ? 'all-inclusive' : a.basis === 'breakfast' ? 'breakfast included' : 'room only'}${a.tradeoffs.length ? ` · changes: ${joinAnd(a.tradeoffs)}` : ''}</span>${deltaTag(a.delta)}<small>new total ${money(a.total)}</small></a></li>`)}</ul>` : ''}
  </section>

  ${n.firstNight || n.lastDay ? html`<section class="tb-panel" id="nights" aria-labelledby="nights-title">
    <h2 id="nights-title">${icon('clock')} Your first night / your last day</h2>
    ${n.firstNight ? html`<h3>${icon('plane')} The first night</h3><p>${n.firstNight.text}</p>
      ${n.firstNight.alternatives.length ? html`<ul class="tb-changes">${n.firstNight.alternatives.map(a => html`<li><a href="${tripUrl(a.token, cx)}"><span>${a.text}</span><small>new total ${money(a.total)}</small></a></li>`)}</ul>` : html`<p class="tb-muted tb-small">No other fare on this date lands earlier inside your rules.</p>`}` : ''}
    ${n.lastDay ? html`<h3>${icon('sun')} The last day</h3><p>${n.lastDay.text}</p>
      ${n.lastDay.alternatives.length ? html`<ul class="tb-changes">${n.lastDay.alternatives.map(a => html`<li><a href="${tripUrl(a.token, cx)}"><span>${a.text}</span><small>new total ${money(a.total)}</small></a></li>`)}</ul>` : html`<p class="tb-muted tb-small">No later flight home is priced on this date inside your rules.</p>`}` : ''}
  </section>` : ''}

  <section class="tb-panel" id="transfers" aria-labelledby="transfers-title">
    <h2 id="transfers-title">${icon('bus')} Transfers and cars</h2>
    ${h.duplicates.length ? html`<ul class="tb-leak-list">${h.duplicates.map(d => html`<li data-cents="${d.amount}" data-key="${d.key}">
        <div class="tb-leak-item"><b>${d.label}</b><small>${d.text}</small></div>
        <span class="tb-leak-amt">${money(d.amount)}</span>
        <span class="tb-leak-actions">${d.token ? html`<a class="btn btn-ghost btn-sm" href="${leaksUrl(d.token, cx, '#transfers')}" data-remove="${d.key}">REMOVE · ${money(d.total)} without it</a><a class="btn btn-ghost btn-sm" href="#transfers">KEEP</a>` : html`<span class="tb-leak-rule">${icon('lock')} kept</span>`}</span>
      </li>`)}</ul>` : html`<p class="tb-tip">${icon('check')} Nothing is paid for twice: no bought bag on a fare that includes one, no private transfer at a hotel that lists an airport shuttle.</p>`}
    <p>${h.car.text}</p>
  </section>

  <section class="tb-panel" id="notCompared" aria-labelledby="nc-title">
    <h2 id="nc-title">${icon('info')} Not compared here</h2>
    <p class="tb-muted tb-small">What our data does not have, said plainly, so no saving is ever claimed from it.</p>
    <ul class="tb-list tb-small">${h.notAvailable.map(x => html`<li><b>${x.label}:</b> ${x.text}</li>`)}</ul>
  </section>

  <p class="tb-leak-foot"><a class="btn btn-navy" href="${tripUrl(token, cx)}">${icon('arrow-left')} Back to this trip · ${money(t.total)}</a> <a class="btn btn-ghost" href="${reviewUrl(token, cx, t.total)}">Review and book ${icon('arrow')}</a>${user ? '' : html` <span class="tb-small tb-muted">Nothing is charged until you confirm on the payment page.</span>`}</p>
</div>`;
  return layout({
    title: 'What you don\'t need to pay for', active: 'plan', body, ctx, noindex: true,
    description: `${t.dest.name}: every dollar of this ${money(t.total)} trip, and every version with a dollar taken out, priced in full.`,
  });
}

module.exports = { leaksView, savingsCheckPanel, leakCheckPanel, breakdownDetails, breakdownTable, victoryPanel };
