// Information pages (How it works, FAQ, legal placeholders), SEO landing pages, the custom trip
// request, the trip-specific checkout and the trip page after booking (the traveler's command center).
const { html, raw, jsonScript } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { pageHero } = require('../pages');
const { encodeSpec } = require('../../trips/spec');
const { contextParams, searchParams } = require('../../trips/optimizer');
const { money, dollars, longDate, shortDate, plural, joinAnd, cutoffText, hm, statusPill, demoBadge, budgetMeter, recipe, stepsBar } = require('./common');
const { budgetForm } = require('./home');
const { vacationPlan, coveredBy, unpricedFor } = require('../../trips/vacation');
const { tripCard } = require('./plan');

function howItWorksView(ctx) {
  const body = html`
${pageHero({ eyebrow: 'How it works', title: 'You set the budget.', accent: 'We build the trip.', lead: 'Traditional travel sites ask where you want to go, then show you hundreds of options. We ask how much you want to spend, do the searching and comparing, and show you the three best complete trips.' })}
<section class="section"><div class="container tb-prose">
  <h2>1. Tell us your budget</h2><p>One number for the whole trip: flights, hotel, experiences, transfers, taxes and fees. If you want, keep part of it aside for food and spending and we build the trip around the rest, so your budget covers the vacation, not just the booking.</p>
  <h2>2. A few quick questions</h2><p>Who’s going, where you’re leaving from, when (exact dates, a flexible month, or anytime), the kind of trip, and what matters most to you. One question at a time; no long forms.</p>
  <h2>3. We build and price every combination</h2><p>For every destination we check the flights, hotels, experiences and transfers available for your dates, build every sensible combination, and price each one completely. Then we keep three answers: <b>Our pick</b> (the trip we’d book: the cheapest of the near-equal strongest fits at or under your budget), <b>Save more</b> (a strong trip that leaves real money unspent) and <b>Upgrade, only if worth it</b> (it costs more and improves something real without giving anything up). When no upgrade earns its price, the third answer is “keep your money”, and we say why. Every trip comes with the reasons we picked it, its trade-offs, and a scorecard you can read.</p>
  <h2>4. Change anything</h2><p>Swap the hotel or flight, add or remove nights, experiences, bags or a transfer, move the dates. Every option shows the new total before you click. A budget meter shows exactly where you stand, and we never hide an over-budget amount.</p>
  <h2>5. We check the live price, then you decide</h2><p>Travel prices move. Right before checkout we re-check every supplier. If the price is the same, we say so. If it dropped, you pay less. If it went up, we show the difference and ask you to approve it: a changed price is never charged automatically. Then traveler details, payment, and your confirmation with a Trip ID for everything.</p>
  <h2>How we make money</h2><p>A clear service fee that is always shown in the total, plus commissions and package rates from suppliers where they allow it. Our recommendations are ranked on what’s good for you (price, hotel, flight, location, your preferences), never on what earns us more, and we show when a cheaper option exists and what you’d give up.</p>
  <h2>What we never do</h2><ul><li>Call a trip “within budget” when fees push it over.</li><li>Add fees at checkout.</li><li>Invent urgency (“only 1 left!”) or fake discounts.</li><li>Change your price or your trip without telling you.</li></ul>
  <p class="mt-28"><a class="btn btn-navy btn-lg" href="/plan">Build my trip ${icon('arrow')}</a></p>
</div></section>`;
  return layout({ title: 'How it works', active: 'how', body, ctx, canonical: '/how-it-works', description: 'How Tripelyx turns a budget into a complete trip: flights, hotel and experiences priced in full, three best fits, live price check before payment.' });
}

const FAQ = [
  ['Is the price I see really the final price?', 'Yes. Every trip total includes the flights, hotel, experiences and transfers you chose, all taxes, mandatory fees (including hotel resort fees) and our service fee. Nothing is added at checkout. Optional extras you haven’t added (checked bags on some fares, travel insurance, meals outside the plan) are listed under “Not included”.'],
  ['What does “within budget” mean on Tripelyx?', 'The complete total, fees included, is at or below the budget you entered. If you allow “up to 10% more”, trips above your budget are shown but always labeled with the over-budget amount.'],
  ['Can I keep money aside for spending?', 'Yes. After your budget we ask whether to keep some for food and spending ($200, $300, $500 or any amount). We then build the trip around what’s left.'],
  ['Why only three trips?', 'Because the decision is the hard part. We price every combination we can build and show the three that best fit what you told us, with the reasons and the trade-offs. You can change anything on each one, and we tell you when a cheaper trip exists and what it gives up.'],
  ['What happens if the price changes before I pay?', 'We re-check every supplier right before checkout and again when you pay. If the price dropped, you pay less. If it went up, we show the difference and ask you to approve it; we never charge a changed price automatically. If part of the trip is no longer available, nothing is charged.'],
  ['Can I cancel or change my trip?', 'Each part has its own terms, shown on the trip page before you book and on your trip page afterwards. Within 24 hours of booking (with departure at least 7 days away) the whole trip is refundable. After that, refundable hotel rates and flexible fares can be canceled within their windows; experiences and transfers until 24 hours before.'],
  ['Is my payment safe?', 'Card details go to the payment provider’s secure fields and never touch our servers; we store only the card brand and last four digits. Nothing is charged until you explicitly confirm on the payment page.'],
  ['What if one part of my trip fails after I pay?', 'If the flights can’t be confirmed, the whole booking fails and your payment is refunded in full. If a later part fails (for example the hotel), your trip is marked “Partially confirmed”, our team is alerted immediately, and we contact you with options or a refund for that part. You are never left guessing.'],
  ['Do I need a passport?', 'For international destinations each traveler needs a valid passport, and entry rules depend on your nationality. We remind you before booking, but we can’t guarantee entry to any country; check the official requirements.'],
  ['Where do your prices and ratings come from?', 'From our travel suppliers. Hotel ratings are labeled with their source (a supplier rating or verified booking reviews); we never merge sources into one number. In this preview, inventory, prices and ratings are demo data and are labeled as such.'],
];

function faqView(ctx) {
  const body = html`
${pageHero({ eyebrow: 'Help', title: 'Questions, answered plainly.', lead: 'Pricing, budgets, changes and what happens if something goes wrong.' })}
<section class="section"><div class="container tb-prose">
  ${FAQ.map(([q, a]) => html`<details class="tb-faq"><summary>${q}</summary><p>${a}</p></details>`)}
  <p class="mt-28">Still stuck? <a href="/contact">Contact us</a>, or if you have a booking, open it under <a href="/my-trips">My Trips</a> (or <a href="/manage">find it by Trip ID</a>) to message support about that trip.</p>
</div></section>`;
  return layout({ title: 'FAQ', active: 'faq', body, ctx, canonical: '/faq' });
}

const LEGAL = {
  terms: ['Terms & Conditions', ['These Terms govern your use of Tripelyx and the booking of travel products through it. Tripelyx acts as an agent for the airlines, hotels, activity and transfer suppliers who provide each part of your trip; their own conditions of carriage and terms also apply and are shown before you book.', 'Prices shown include all taxes, mandatory fees and the Tripelyx service fee. A price is not guaranteed until payment is confirmed. If a price changes before payment, you will be asked to approve the new price.', 'Each part of a trip has its own cancellation and change terms, shown before booking and in your confirmation.', 'You are responsible for valid travel documents for every traveler. Tripelyx does not guarantee entry to any country.']],
  privacy: ['Privacy Policy', ['We collect the information needed to plan and book your trip (contact details, traveler names, your searches and preferences) and the information you give us when you create an account.', 'Payment card details are collected directly by our payment provider and never stored by Tripelyx; we keep only the card brand and last four digits.', 'We share booking details with the suppliers who provide each part of your trip, and with our payment provider. We do not sell personal information.', 'You can ask us to delete your account and data at any time.']],
  cancellation: ['Cancellation Policy', ['Within 24 hours of booking, with departure at least 7 days away, you may cancel the whole trip for a full refund.', 'After that, each part follows its own terms: refundable hotel rates until the hotel’s deadline; flexible flight fares until the airline’s deadline; experiences and transfers until 24 hours before. Non-refundable rates and basic fares are not refundable.', 'The Tripelyx service fee is refundable only within the first 24 hours.', 'The exact terms for your trip are shown before booking and on your trip page.']],
  refunds: ['Refund Policy', ['Refunds are made to the original payment method. Processing times depend on your bank, typically 5–10 business days after we issue the refund.', 'If a supplier fails to confirm part of your trip after payment, we refund that part in full, or the whole trip if the flights cannot be confirmed.', 'Refund amounts are always shown to you before you cancel.']],
  cookies: ['Cookie Policy', ['Tripelyx uses strictly necessary cookies: a session cookie when you sign in, a per-booking access cookie after you book, and a random first-party visitor id used to count how travelers move through the planning steps. None of them track you across other sites and we use no third-party advertising cookies.']],
  'travel-disclosures': ['Travel Disclosures', ['Flight schedules, hotel details and activity descriptions are supplied by the providers named on each trip and may change. Hotel ratings are labeled with their source and are not Tripelyx’s own assessment.', 'Weather information is based on historical climate data and is not a forecast.', 'Travel document and entry requirements change; always check official sources for your nationality before traveling.', 'In this preview environment, inventory and prices are demo data for development and are not real offers.']],
};

function legalView(ctx, key) {
  const [title, paras] = LEGAL[key];
  const body = html`
${pageHero({ eyebrow: 'Policies', title })}
<section class="section"><div class="container tb-prose">
  <div class="alert alert-warning" role="note">${icon('alert')}<span><b>Draft for professional review.</b> This text is a placeholder written for the preview. It must be reviewed and approved by a qualified legal professional before launch and does not create any guarantee beyond the terms actually shown at booking.</span></div>
  ${paras.map(p => html`<p>${p}</p>`)}
  <p class="tb-muted tb-small">Last updated: ${new Date().toISOString().slice(0, 10)} (draft).</p>
</div></section>`;
  return layout({ title, body, ctx, canonical: `/legal/${key}`, noindex: true });
}

function customTripView(ctx, { values = {}, errors = {}, done = false, user }) {
  const body = html`
${pageHero({ eyebrow: 'Custom trip', title: 'Build a trip for me.', lead: 'If the automated planner didn’t find it, a trip specialist will. Tell us the budget and what you want; we reply with a personalized trip you can accept and book.' })}
<section class="section"><div class="container tb-auth">
  ${done ? html`<div class="tb-auth-card"><h2>${icon('check')} Request received</h2><p>We’ll build your trip and email you a private link to it, with everything priced in full. Status: <b>Request received → Building your trip → Trip ready → Waiting for your approval → Booked</b>.</p>${user ? html`<p><a class="btn btn-navy" href="/my-trips">Back to My Trips</a></p>` : html`<p><a class="btn btn-navy" href="/plan">Keep exploring</a></p>`}</div>`
    : html`<form class="tb-auth-card form" method="post" action="/custom-trip" novalidate>
    <div class="form-row">
      <div class="field"><label for="ct-name">Your name</label><input id="ct-name" name="name" required maxlength="80" value="${values.name || ''}" autocomplete="name"><p class="field-error">${errors.name || ''}</p></div>
      <div class="field"><label for="ct-email">Email</label><input id="ct-email" name="email" type="email" required maxlength="120" value="${values.email || ''}" autocomplete="email"><p class="field-error">${errors.email || ''}</p></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="ct-budget">My budget ($)</label><input id="ct-budget" name="budget" inputmode="numeric" maxlength="20" value="${values.budget || ''}"></div>
      <div class="field"><label for="ct-from">Where I’m leaving from</label><input id="ct-from" name="from" maxlength="80" value="${values.from || ''}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label for="ct-trav">Number of travelers</label><input id="ct-trav" name="travelers" inputmode="numeric" maxlength="10" value="${values.travelers || ''}"></div>
      <div class="field"><label for="ct-dates">Dates</label><input id="ct-dates" name="dates" maxlength="80" placeholder="e.g. first week of March, flexible" value="${values.dates || ''}"></div>
    </div>
    <div class="field"><label for="ct-wants">What I want</label><textarea id="ct-wants" name="wants" required maxlength="1500">${values.wants || (values.dest ? `${values.dest}. ` : '')}</textarea><p class="field-error">${errors.wants || ''}</p></div>
    <button class="btn btn-navy btn-lg" type="submit">Build a trip for me ${icon('arrow')}</button>
  </form>`}
</div></section>`;
  return layout({ title: 'Request a custom trip', body, ctx, noindex: true });
}

// ---- SEO landing pages ----
function destinationsView(ctx, { destinations }) {
  const body = html`
${pageHero({ eyebrow: 'Destinations', title: 'Where can your budget take you?', lead: 'Every destination we build complete trips for. Prices are the cheapest complete trip for two from New York over the next five months, taxes and fees included.' })}
<section class="section"><div class="container">
  <ul class="tb-dest-grid">${destinations.map(d => html`<li><a class="tb-dest" href="/trips-to-${d.slug}"><img src="${d.image.url}" alt="${d.image.alt}" width="400" height="250" loading="lazy"><span class="tb-dest-body"><b>${d.name}</b><small>${d.country}${d.from ? ` · from ${money(d.from)}` : ''}</small></span></a></li>`)}</ul>
</div></section>`;
  return layout({ title: 'Destinations', active: 'destinations', body, ctx, canonical: '/destinations' });
}

function landingView(ctx, { title, eyebrow, lead, intro, result, q, originCity, canonical, budgetValue, origins, moreLinks = [] }) {
  const cx = { ...result.ctx, searchParams: searchParams(q) };
  const body = html`
${pageHero({ eyebrow, title, lead })}
<section class="section"><div class="container">
  <div class="tb-landing-form">${budgetForm({ id: 'landing', value: budgetValue, cta: 'Build my trip', surprise: false })}</div>
  <p class="tb-results-sub">${intro} Example trips below are for ${plural(q.travelers, 'traveler')} from ${originCity}, ${plural(q.nights, 'night')}, over the next five months. ${demoBadge(ctx.tripService.demo, 'Demo inventory and prices')}</p>
  ${result.picks.length ? html`<div class="tb-cards">${result.picks.map((p, i) => tripCard(p, q, cx, { rank: i }))}</div>` : html`<p class="tb-advisor"><b>No complete trip fits this budget from ${originCity} right now.</b> Try a higher budget or another city.</p>`}
  <p class="tb-muted mt-28">From another city: ${origins.map(o => html`<a href="?from=${o.id}">${o.city}</a> `)}</p>
  ${moreLinks.length ? html`<ul class="tb-inspo mt-28">${moreLinks.map(([h, t, s]) => html`<li><a href="${h}"><b>${t}</b><span>${s}</span></a></li>`)}</ul>` : ''}
</div></section>`;
  return layout({ title, body, ctx, canonical, description: lead });
}

// ---- checkout for a trip quote ----
// The checkout aside shows the whole-vacation plan next to what is paid today, in the traveler's
// own numbers: pay today, the reserve they protected, and what is left unassigned.
function vacationSummary(plan) {
  if (!plan || !plan.keep) return '';
  return html`<div class="tb-vac-final tb-vac-compact"><p class="tb-recipe-title">Your vacation plan</p>
    <dl class="tb-vac-rows">
      <div class="tb-vac-row"><dt>Pay today</dt><dd>${money(plan.booking)}</dd></div>
      <div class="tb-vac-row${plan.raid ? ' is-over' : ''}"><dt>${plan.raid ? 'Left of your reserve' : 'Protected for the destination'}</dt><dd>${money(plan.reserveLeft)}</dd></div>
      ${plan.raid ? html`<div class="tb-vac-row is-over"><dt>Taken from your reserve</dt><dd>−${money(plan.raid)}</dd></div>` : html`<div class="tb-vac-row"><dt>Unassigned</dt><dd>${money(plan.unassigned)}</dd></div>`}
      <div class="tb-vac-row tb-vac-total"><dt>Total planned</dt><dd>${money(plan.planned)} <small>of ${money(plan.vacation)}</small></dd></div>
    </dl>
    <p class="tb-small tb-muted">${plan.arrive ? `You arrive with ${money(plan.arrive)}: about ${money(plan.perDay)} a day over ${plural(plan.days, 'day')}. Only the booking is charged; the rest stays yours.` : `This booking uses all of your ${money(plan.vacation)}${plan.over ? ` and ${money(plan.over)} more` : ''}, as you approved; nothing of it is left for after you land.`}</p></div>`;
}

// After booking: what was protected, what this booking took of it (only ever by the traveler's
// approval), and what that leaves.
function afterWords(plan) {
  const protectedPart = html`You protected <b>${money(plan.keep)}</b> for the destination`;
  if (!plan.raid) return html`${protectedPart}${plan.unassigned ? `, plus ${money(plan.unassigned)} unassigned` : ''}: about ${money(plan.perDay)} a day over ${plural(plan.days, 'day')}, arrival to departure. Nothing on this page spends it.`;
  const used = plan.raid >= plan.keep ? `all of it${plan.over ? ` and ${money(plan.over)} beyond your whole ${money(plan.vacation)}` : ''}` : `${money(plan.raid)} of it`;
  return html`${protectedPart}. This booking used ${used}, as you approved${plan.reserveLeft ? `; ${money(plan.reserveLeft)} is left: about ${money(plan.perDay)} a day over ${plural(plan.days, 'day')}, arrival to departure` : ''}.`;
}

function tripCheckoutView(ctx, { quote: q, paymentConfig }) {
  const t = q.trip;
  const b = q.budget && q.budget.budget;
  const bcx = { budget: b, keep: (q.budget && q.budget.keep) || 0, allowOver: q.budget && q.budget.allowOver };
  const plan = vacationPlan(t, bcx);
  const tripUrl = `/trip/${t.token}?${contextParams(bcx)}`;
  const body = html`
<div class="container tb-checkout">
  ${stepsBar(2)}
  ${q.expired ? html`<div class="empty-state">${icon('clock')}<h3>This price has expired</h3><p>Prices are held for ${ctx.config.quoteTtlMinutes} minutes. Go back to re-check the live price.</p><a class="btn btn-navy btn-sm" href="/trip/${t.token}/review?${contextParams(bcx, { seen: q.total })}">Re-check the price</a></div>`
    : html`<div class="checkout-layout">
    <div>
      <p class="alert alert-info" data-quote-timer data-expires="${q.expiresAt}">${icon('clock')}<span>Your price of ${money(q.total)} is confirmed and held for <span class="timer" data-timer>${ctx.config.quoteTtlMinutes}:00</span>. We check it once more when you pay; a changed price is never charged without your approval.</span></p>
      <form class="checkout-step form" data-traveler-form novalidate>
        <h2><span class="step-num">1</span> Lead traveler</h2>
        <div class="form-row">
          <div class="field"><label for="t-first">First name</label><input id="t-first" name="firstName" autocomplete="given-name" required maxlength="60"><p class="field-error" data-error-for="firstName"></p></div>
          <div class="field"><label for="t-last">Last name</label><input id="t-last" name="lastName" autocomplete="family-name" required maxlength="60"><p class="field-error" data-error-for="lastName"></p></div>
        </div>
        <div class="form-row">
          <div class="field"><label for="t-email">Email</label><input id="t-email" name="email" type="email" autocomplete="email" required maxlength="120"><p class="field-hint">Your confirmation and Trip ID are sent here.</p><p class="field-error" data-error-for="email"></p></div>
          <div class="field"><label for="t-phone">Phone <span class="optional">(optional)</span></label><input id="t-phone" name="phone" type="tel" autocomplete="tel" maxlength="30"><p class="field-error" data-error-for="phone"></p></div>
        </div>
        <div class="field"><label for="t-notes">Requests for the hotel or airline <span class="optional">(optional)</span></label><textarea id="t-notes" name="notes" maxlength="500"></textarea></div>
        <p class="tb-muted tb-small">${t.spec.travelers > 1 ? `Names of the other ${t.spec.travelers - 1} traveler${t.spec.travelers > 2 ? 's' : ''} are collected after booking, before tickets are issued.` : ''} ${t.internationalTrip ? 'Names must match passports exactly.' : 'Names must match government ID.'}</p>
      </form>
      <section class="checkout-step" aria-labelledby="addons-title">
        <h2 id="addons-title"><span class="step-num">2</span> Optional add-ons</h2>
        <p class="tb-muted">Nothing is pre-selected and nothing is added automatically. To add bags, a transfer or experiences, <a href="${tripUrl}#customize">go back to the customizer</a>; the price updates before you return here.</p>
      </section>
      <form class="checkout-step form" data-payment-form novalidate>
        <h2><span class="step-num">3</span> Payment</h2>
        <ul class="tb-ready tb-ready-compact">
          <li>${icon('check')} Price rechecked: ${money(q.total)}</li><li>${icon('check')} Dates ${shortDate(t.spec.depart)} – ${shortDate(t.flight.return)}</li><li>${icon('check')} ${plural(t.spec.travelers, 'traveler')}</li><li>${icon('check')} ${t.hotel.name}</li><li>${icon('check')} ${t.flight.stops ? '1-stop' : 'Nonstop'} flights</li><li>${icon('check')} Mandatory fees included</li><li>${icon('check')} Cancellation terms shown below</li>
        </ul>
        <div data-payment-widget data-mode="${paymentConfig.mode}"></div>
        <div data-form-status role="alert" aria-live="assertive"></div>
        <button class="btn btn-navy btn-lg btn-block" type="submit" data-pay-button><span class="btn-label">Confirm &amp; pay ${money(q.total)}</span> ${icon('lock')}</button>
        <p class="secure-note">${icon('lock')}${paymentConfig.mode === 'test' ? 'Test mode — no real charge is made.' : 'Card details are collected by our payment partner and never reach Tripelyx.'} Nothing is charged until you press this button.</p>
        <noscript><p class="alert alert-warning">Checkout needs JavaScript to take payment securely. Please enable it and reload.</p></noscript>
      </form>
    </div>
    <aside class="summary-card tb-summary" aria-label="Trip summary">
      <img class="summary-img" src="${t.dest.image.url}" alt="${t.dest.image.alt}" width="400" height="250">
      <h2>${plural(t.spec.nights, 'night')} in ${t.dest.name}</h2>
      <p class="summary-meta">${longDate(t.spec.depart)} – ${shortDate(t.flight.return)} · ${plural(t.spec.travelers, 'traveler')} · from ${t.origin.city}</p>
      <ul class="tb-list tb-small">${t.included.map(i => html`<li>${i}</li>`)}</ul>
      ${recipe(t, b)}
      ${plan && plan.keep ? vacationSummary(plan) : b ? budgetMeter(q.total, b, { compact: true }) : ''}
      <details class="tb-small"><summary>Cancellation terms</summary><ul class="tb-list">${t.policies.map(p => html`<li><b>${p.component}:</b> ${p.text}</li>`)}</ul></details>
      ${q.demo ? html`<p class="policy">${icon('info')}Demo inventory — this booking won’t reach a real supplier.</p>` : ''}
      <p class="tb-small"><a href="${tripUrl}">${icon('arrow-left')} Change something</a></p>
    </aside>
  </div>`}
</div>
<script type="application/json" id="checkout-data">${jsonScript({ quoteId: q.id, payment: paymentConfig, total: q.total, currency: q.currency })}</script>`;
  const scripts = ['/js/book.js', '/js/checkout.js'];
  if (paymentConfig.mode === 'test') scripts.unshift('/js/payments-test.js');
  return layout({ title: 'Checkout', active: 'plan', body, ctx, scripts, noindex: true });
}

// ---- the trip after booking: one place for everything ----
function componentStatus(c) {
  const map = { confirmed: ['Confirmed', 'good'], failed: ['Could not be confirmed', 'bad'], not_booked: ['Not booked', 'warn'] };
  const [l, tone] = map[c.status] || [c.status, 'warn'];
  return html`<span class="tb-status tb-status-${tone}">${l}</span>`;
}

function tripBookingView(ctx, { booking: b, cancellationPreview: preview, payment, notice, messages = [], user, messageError }) {
  const t = b.trip;
  const ok = b.status === 'confirmed';
  const partial = b.status === 'partially_confirmed';
  const days = Math.ceil((Date.parse(`${t.spec.depart}T00:00:00Z`) - Date.now()) / 86400000);
  const headline = {
    confirmed: 'Your trip is booked', partially_confirmed: 'Payment received — one part needs our team', pending_payment: 'Your trip is awaiting payment',
    pending_supplier: 'Payment received — confirming with suppliers', confirming: 'Confirming your trip', cancelled: 'This trip is canceled', expired: 'This booking expired before payment',
    failed: 'This trip couldn’t be confirmed', refund_pending: 'Refund in progress', refunded: 'Refunded',
  }[b.status] || b.status;
  const budget = b.budget && b.budget.budget;
  const plan = vacationPlan(t, { budget, keep: (b.budget && b.budget.keep) || 0 });
  const body = html`
<div class="container tb-command">
  ${ok ? stepsBar(3) : ''}
  <header class="confirm-hero tb-confirm-hero">
    <div class="confirm-badge${ok ? '' : partial || ['pending_payment', 'pending_supplier', 'confirming', 'refund_pending'].includes(b.status) ? ' is-warn' : ' is-bad'}">${icon(ok ? 'check' : 'info')}</div>
    <h1>${headline}</h1>
    <p>Trip ID <span class="ref">TRIP #${b.ref}</span> ${statusPill(b.status)}</p>
    ${ok && days > 0 ? html`<p class="tb-countdown">${icon('calendar')} ${days === 1 ? 'Tomorrow!' : `${days} days to go`}</p>` : ''}
    ${b.demo ? html`<p class="demo-note">${icon('info')}Demo booking — test payment, no real supplier was contacted.</p>` : ''}
  </header>
  ${notice ? html`<div class="alert alert-success mb-16" role="status">${icon('check')}<span>${notice}</span></div>` : ''}
  ${partial ? html`<div class="alert alert-warning mb-16" role="alert">${icon('alert')}<span><b>One part of your trip couldn’t be confirmed</b> (see below). Our team has been alerted and will contact you at ${b.traveler.email} with options or a refund for that part. The confirmed parts are safe. Nothing else is needed from you right now.</span></div>` : ''}
  ${b.status === 'failed' ? html`<div class="alert alert-error mb-16" role="alert">${icon('alert')}<span>The flights couldn’t be confirmed, so your payment of ${money(b.refundAmount || b.total)} has been refunded in full. <a href="/plan">Build another trip</a>.</span></div>` : ''}
  <div class="tb-command-grid">
    <div>
      <section class="tb-panel" aria-labelledby="it-title">
        <h2 id="it-title">${plural(t.spec.nights, 'night')} in ${t.dest.name}, ${t.dest.country}</h2>
        <p class="tb-muted">${longDate(t.spec.depart)} – ${longDate(t.flight.return)} · ${plural(t.spec.travelers, 'traveler')} · from ${t.origin.city} (${t.origin.code})</p>
        <ul class="tb-components">
          <li>${icon('plane')}<div><b>Flights · ${t.flight.airline}</b><p>${t.origin.code} → ${t.dest.airport} on ${longDate(t.spec.depart)}, back ${longDate(t.flight.return)} · ${t.flight.stops ? `${t.flight.stops} stop` : 'nonstop'} · ${hm(t.flight.durationMinutes)} each way · ${t.flight.name} fare</p>${confirmationFor(b, 'flight')}</div></li>
          <li>${icon('bed')}<div><b>Hotel · ${t.hotel.name}</b><p>${t.hotel.stars}-star · ${t.hotel.area} · ${t.rooms} room${t.rooms > 1 ? 's' : ''} · check-in from 3:00 PM ${shortDate(t.spec.depart)}, check-out by 11:00 AM ${shortDate(t.flight.return)}</p>${confirmationFor(b, 'hotel')}</div></li>
          ${t.activities.map(a => html`<li>${icon('flag')}<div><b>${a.name}</b><p>${a.hours}h · ${a.supplier}</p>${confirmationFor(b, 'activity', a.name)}</div></li>`)}
          ${t.transfer ? html`<li>${icon('bus')}<div><b>Private airport transfer, both ways</b><p>${t.transfer.supplier} · pickup details are sent 24 hours before each ride</p>${confirmationFor(b, 'transfer')}</div></li>` : ''}
        </ul>
      </section>
      <section class="tb-panel" aria-labelledby="pay-title">
        <h2 id="pay-title">Payment</h2>
        ${recipe(t, budget)}
        ${b.payment ? html`<p class="secure-note">${icon('card')}Paid ${money(b.total)} with ${b.payment.brand} •••• ${b.payment.last4}${b.payment.mode === 'test' ? ' (test mode)' : ''}. Remaining balance: ${money(0)}.</p>` : ''}
        ${b.refundAmount ? html`<p class="secure-note">${icon('info')}Refund: ${money(b.refundAmount)}</p>` : ''}
        ${budget && b.total <= budget ? html`<p class="tb-celebrate">${icon('sparkle')} Great choice. You came in <b>${money(budget - b.total)}</b> under your ${dollars(budget)}${plan && plan.keep ? ' booking' : ''} budget.</p>` : ''}
        ${plan && plan.keep ? html`<p class="tb-vac-after">${icon('lock')}<span>${afterWords(plan)}</span></p>` : ''}
      </section>
      ${coversPanel(b, t)}
      ${['confirmed', 'partially_confirmed', 'pending_supplier', 'confirming'].includes(b.status) ? html`<section class="tb-panel ag-after" aria-labelledby="ag-after-title">
        <h2 id="ag-after-title">${icon('sparkle')} Ask your travel agent</h2>
        <p class="tb-muted tb-small">The same agent that built this trip, now with your booking in front of it. It answers from the booking’s own facts, says “I don’t know yet” when it doesn’t, and never changes a booked trip on its own.</p>
        <form class="ag-after-form" method="post" action="/agent">
          <input type="hidden" name="ref" value="${b.ref}">
          <label class="sr-only" for="ag-after-say">Ask your travel agent anything</label>
          <textarea id="ag-after-say" name="say" rows="2" maxlength="600" placeholder="Ask your travel agent anything…"></textarea>
          <button class="btn btn-navy btn-sm" type="submit">Ask ${icon('arrow')}</button>
          <div class="ag-chips">${['What do I need to do next?', 'What if I cancel?', 'Can I extend one night?', 'Do I need a car?', 'What happens if my flight changes?'].map(q => html`<button class="ag-chip" type="submit" name="example" value="${q}">${q}</button>`)}</div>
        </form>
      </section>` : ''}
      <section class="tb-panel" aria-labelledby="info-title">
        <h2 id="info-title">Important travel information</h2>
        <ul class="tb-list">
          ${t.internationalTrip ? html`<li><b>Passports.</b> Every traveler needs a valid passport for ${t.dest.country}; check entry rules for your nationality. We can’t guarantee entry.</li>` : html`<li><b>ID.</b> Bring a government-issued photo ID for each traveler.</li>`}
          <li><b>Baggage.</b> ${t.flight.carryOn ? 'One carry-on' : 'One personal item'} per traveler${t.flight.checkedBagIncluded || t.spec.bags ? ' plus one checked bag each way' : '; checked bags were not added'}.</li>
          <li><b>Hotel.</b> ${t.hotel.policy} ${t.hotel.resortFeePerNight ? 'The resort fee is already paid in your total.' : ''}</li>
          <li><b>Flights.</b> ${t.flight.policy}</li>
          ${t.policies.filter(p => !['Flights', 'Hotel', 'Service fee'].includes(p.component)).map(p => html`<li><b>${p.component}.</b> ${p.text}</li>`)}
        </ul>
        <p class="tb-muted tb-small">Who provides each part: ${t.providers.map(p => `${p.component}: ${p.provider}`).join(' · ')}.</p>
      </section>
      ${preview && preview.allowed ? html`<form class="tb-panel" method="post" action="/booking/${b.ref}/cancel" data-cancel-form>
        <h2>Cancel this trip</h2>
        <p>${preview.policy} If you cancel now you’ll be refunded <b>${money(preview.refundAmount, preview.currency)}</b>.</p>
        ${cancelDeadlines(preview)}
        <div data-form-status role="alert"></div>
        <button class="btn btn-ghost" type="submit" data-confirm="Cancel TRIP #${b.ref}? You’ll be refunded ${money(preview.refundAmount, preview.currency)}."><span class="btn-label">Cancel trip</span></button>
      </form>` : preview && !preview.allowed ? html`<p class="tb-muted">${preview.reason}</p>` : ''}
    </div>
    <aside>
      ${payment ? html`<p class="alert alert-warning">${icon('clock')}<span>Payment is due by ${shortDate(b.paymentDueAt.slice(0, 10))}. Return to checkout from the same browser to pay.</span></p>` : ''}
      <section class="tb-panel" aria-labelledby="sup-title">
        <h2 id="sup-title">Support for this trip</h2>
        <p class="tb-muted tb-small">Quote <b>TRIP #${b.ref}</b>. Messages here go to our team with your trip, supplier references and payment status attached, so you never repeat yourself.</p>
        <ul class="tb-messages">${messages.length ? messages.map(m => html`<li class="${m.from === 'customer' ? 'is-customer' : 'is-staff'}"><b>${m.from === 'customer' ? 'You' : 'Tripelyx'}</b> <small>${shortDate(m.at.slice(0, 10))}</small><p>${m.text}</p></li>`) : html`<li class="tb-muted">No messages yet.</li>`}</ul>
        <form class="form" method="post" action="/booking/${b.ref}/message">
          <div class="field"><label for="msg">Message</label><textarea id="msg" name="text" maxlength="2000" required></textarea><p class="field-error">${messageError || ''}</p></div>
          <button class="btn btn-navy btn-sm" type="submit">Send ${icon('arrow')}</button>
        </form>
        <p class="tb-small tb-muted">Lead traveler: ${b.traveler.firstName} ${b.traveler.lastName} · ${b.traveler.email}</p>
      </section>
      <section class="tb-panel"><h2>After this trip</h2><ul class="tb-list tb-small"><li><a href="/plan?b=${budget ? Math.round(budget / 100) : Math.round(b.total / 100)}">Same budget, new destination</a></li><li><a href="/dream?dest=${t.dest.id}&b=${budget ? Math.round(budget / 100) : Math.round(b.total / 100)}&from=${t.origin.code.slice(0, 3)}">Same destination, better hotel</a></li>${!user ? html`<li><a href="/signup">Create an account</a> to see all your trips in one place</li>` : html`<li><a href="/my-trips">All my trips</a></li>`}</ul></section>
    </aside>
  </div>
</div>`;
  return layout({ title: `TRIP #${b.ref}`, active: 'my-trips', body, ctx, scripts: ['/js/book.js'], noindex: true });
}

// What this booking pays for, what it leaves out and what we never price, from the booking's own
// facts; plus any part a supplier has not confirmed yet. Not shown once a booking has failed,
// expired, been cancelled or refunded: it covers nothing then.
function coversPanel(b, t) {
  if (['failed', 'expired', 'cancelled', 'refund_pending', 'refunded'].includes(b.status)) return '';
  const covered = coveredBy(t);
  // Things the price leaves out that are bookable or required (bags, a transfer, insurance); what
  // the traveler pays on the spot or must carry (meals, tips, passports) is on the lines below.
  const notIn = (t.notIncluded || []).filter(i => !/^(meals|tips|passports)/i.test(i)).map(i => i.replace(/\s*\([^)]*\)\s*$/, '')).map(i => i.charAt(0).toLowerCase() + i.slice(1));
  const pending = (b.components || []).filter(c => c.status !== 'confirmed');
  const name = c => (c.kind === 'flight' ? 'flights' : c.kind === 'hotel' ? 'the hotel' : c.kind === 'transfer' ? 'the airport transfer' : c.name);
  const state = c => (c.status === 'failed' ? ' (could not be confirmed)' : c.status === 'not_booked' ? ' (not booked)' : '');
  const heading = ['confirmed', 'partially_confirmed', 'pending_supplier', 'confirming'].includes(b.status) ? 'Paid for already' : b.status === 'pending_payment' ? 'In this booking, once paid' : 'In this booking';
  return html`<section class="tb-panel" aria-labelledby="cov-title">
    <h2 id="cov-title">${icon('layers')} What this booking covers, and what it doesn’t</h2>
    <ul class="tb-ready tb-ready-wrap">
      <li>${icon('check')}<span><b>${heading}:</b> round-trip flights, ${plural(t.spec.nights, 'night')} at ${t.hotel.name}${covered.length ? `, ${covered.join(', ')}` : ''}, taxes, mandatory fees and our service fee.</span></li>
      ${notIn.length ? html`<li class="is-miss">${icon('minus')}<span><b>Not in this booking:</b> ${notIn.join(', ')}.</span></li>` : ''}
      <li>${icon('info')}<span><b>Not priced by us, you pay there:</b> ${unpricedFor(t).join(', ')}. We don’t guess those amounts.</span></li>
      ${pending.length ? html`<li class="is-miss">${icon('alert')}<span><b>Still to confirm:</b> ${joinAnd(pending.map(c => `${name(c)}${state(c)}`))}. ${b.status === 'partially_confirmed' ? 'Our team is on it and will contact you.' : 'We’ll update this page as each supplier answers.'}</span></li>` : ''}
    </ul>
  </section>`;
}

// The refund you would get now, part by part, with each part's dated cutoff from the suppliers'
// own terms: the full-refund window when it is open, then what is still free to cancel and until
// when, and what is not refundable once the window closes. Dates, never countdowns.
function cancelDeadlines(preview) {
  const all = preview.deadlines || [];
  const byKey = new Map(all.map(d => [d.key, d]));
  const window = !!preview.fullRefundUntil;
  const when = x => {
    const d = x.key ? byKey.get(x.key) : null;
    if (!d) return '';
    if (d.unverified) return ' · free-cancellation cutoff not stated by the supplier: needs verification';
    if (d.cutoff && d.open) return ` · free to cancel ${cutoffText(d.cutoff)}`;
    if (d.cutoff) return ' · the free-cancellation cutoff has passed';
    if (d.key === 'service') return window ? ' · refunded only in the first 24 hours' : ' · non-refundable: no 24-hour window on this trip';
    return ' · non-refundable';
  };
  const whole = preview.breakdown && preview.breakdown[0] && preview.breakdown[0].component === 'Whole trip';
  const until = window ? Date.parse(preview.fullRefundUntil) : 0;
  // A cutoff that falls inside the window adds nothing to it: that part closes with the window.
  const later = all.filter(d => d.open && Date.parse(d.cutoff) > until);
  const closing = all.filter(d => d.key !== 'service' && !d.unverified && !later.includes(d));
  const unverified = all.filter(d => d.unverified);
  return html`${window ? html`<p class="tb-small">${preview.freeWindowOpen && whole
      ? `Full refund ${cutoffText(preview.fullRefundUntil)}, 24 hours after you booked. After that, each part follows its own cutoff: ${later.length ? joinAnd(later.map(d => `${d.component} ${cutoffText(d.cutoff)}`)) : 'nothing on this trip is free to cancel'}; ${closing.length ? `${joinAnd(closing.map(d => d.component))} and the service fee are` : 'the service fee is'} not refundable after the window${unverified.length ? `; ${joinAnd(unverified.map(d => d.component))}: cutoff not stated by the supplier, needs verification` : ''}.`
      : `The 24-hour full-refund window closed ${cutoffText(preview.fullRefundUntil).replace(/^by /, 'at ')}.`}</p>` : ''}
    ${preview.breakdown ? html`<ul class="tb-list tb-small">${preview.breakdown.map(x => html`<li>${x.component}: ${money(x.amount)}${when(x)}</li>`)}</ul>` : ''}
    ${preview.nextCutoff && !whole ? html`<p class="tb-small tb-muted">Next cutoff: ${preview.nextCutoff.component}, ${cutoffText(preview.nextCutoff.cutoff)}. These are the suppliers’ own terms, dated; nothing here is a countdown.</p>` : ''}`;
}

function confirmationFor(b, kind, name) {
  const c = (b.components || []).find(x => x.kind === kind && (!name || x.name === name));
  if (!c) return b.status === 'pending_payment' ? html`<p class="tb-small tb-muted">Confirmed after payment</p>` : '';
  return html`<p class="tb-small">${componentStatus(c)} ${c.confirmation ? html`Confirmation <b class="ref">${c.confirmation}</b>` : ''}</p>`;
}

module.exports = { howItWorksView, faqView, legalView, LEGAL, customTripView, destinationsView, landingView, tripCheckoutView, tripBookingView };
