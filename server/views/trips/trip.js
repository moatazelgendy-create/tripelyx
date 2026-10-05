// The trip page (details, customizer, budget meter, Know Before You Book) and the review page (live
// price check, final trip review, readiness checklist) that leads into checkout.
const { html, raw, jsonScript } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { contextParams, tradeoffs } = require('../../trips/optimizer');
const { verdict, usableTime, timeAlternatives, budgetUnlocks, realityCheck, hoursLabel } = require('../../trips/decision');
const { money, dollars, shortDate, longDate, plural, hm, clock, demoBadge, budgetMeter, recipe, scorecard, stepsBar, fitBadge, hiddenParams } = require('./common');

const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const FEATURE_LABEL = { breakfast: 'Breakfast included', pool: 'Pool', beachfront: 'Beachfront', adultsOnly: 'Adults only', allInclusive: 'All-inclusive', freeCancellation: 'Free cancellation', familyFriendly: 'Family friendly', spa: 'Spa' };

function delta(d) {
  if (d === 0) return html`<span class="tb-delta tb-delta-same">same price</span>`;
  return html`<span class="tb-delta ${d < 0 ? 'tb-delta-save' : 'tb-delta-add'}">${d < 0 ? '−' : '+'}${money(Math.abs(d))}</span>`;
}

function changeUrl(token, cx, change) {
  return `/trip/${token}/change?${contextParams(cx, change)}`;
}

function hotelLine(h) {
  const feats = Object.entries(h.features).filter(([, v]) => v).map(([k]) => FEATURE_LABEL[k]);
  return html`<b>${h.name}</b> <span class="tb-stars" aria-label="${h.stars} star">${'★'.repeat(h.stars)}</span> · ${h.rating}/5 <small>(${h.ratingSource})</small><br><small>${h.area} · ${feats.join(' · ')}</small>`;
}

function flightLine(f) {
  const times = Number.isFinite(f.departMinutes) ? ` · out ${clock(f.departMinutes)}–${clock(f.arriveMinutes)}${f.arrivesNextDay ? ' next day' : ''}, back ${clock(f.returnDepartMinutes)}–${clock(f.returnArriveMinutes)}` : '';
  return html`<b>${f.name}</b> · ${f.stops ? `${f.stops} stop` : 'nonstop'} · ${hm(f.durationMinutes)} each way<br><small>${f.airline}${times} · ${f.carryOn ? 'carry-on included' : 'personal item only'}${f.checkedBagIncluded ? ' · checked bag included' : ''} · ${f.refundable ? 'refundable' : f.changeable ? 'changeable, non-refundable' : 'no changes or refunds'}</small>`;
}

// The verdict panel: what we'd actually do with this trip, and why, in plain words.
function verdictPanel(v, scores, { compact = false } = {}) {
  if (compact) return html`<div class="tb-verdict tb-verdict-${v.tone} tb-verdict-compact" role="note">${fitBadge(v)}<p><b>Our honest take:</b> ${v.action}</p></div>`;
  return html`<section class="tb-verdict tb-verdict-${v.tone}" aria-labelledby="verdict-title">
    <div class="tb-verdict-head">${fitBadge(v)}<span class="tb-verdict-match">${scores.match}% match with your answers</span></div>
    <h2 id="verdict-title">${v.action}</h2>
    <dl class="tb-verdict-facts">
      <div><dt>Biggest win</dt><dd>${cap(v.win)}</dd></div>
      <div><dt>Biggest compromise</dt><dd>${v.compromise ? cap(v.compromise) : 'None we can see'}</dd></div>
    </dl>
    <p class="tb-muted tb-small">The verdict uses only your answers and the facts of this trip. What Tripelyx earns is never part of it.</p>
  </section>`;
}

// "Your time there": what the flight schedule leaves of the first and last day, and the flights
// that would give a day back.
function timePanel(t, time, alts, token, cx) {
  const s = t.spec;
  return html`<section class="tb-panel" id="time" aria-labelledby="time-title">
    <h2 id="time-title">${icon('clock')} Your time there</h2>
    <p class="tb-muted">${plural(s.nights, 'night')} on paper. Here is what the flight times leave you, counting 8 AM to 10 PM as usable.${t.demo ? ' Times come from the demo schedule.' : ''}</p>
    <div class="tb-time">
      <div><span>First day</span><b>${time.firstDay.label}</b><small>land ${time.firstDay.arrive}, at the hotel about ${time.firstDay.settled}</small></div>
      <div><span>Full days</span><b>${time.fullDays}</b><small>wake up there, go to sleep there</small></div>
      <div><span>Last day</span><b>${time.lastDay.label}</b><small>leave the hotel about ${time.lastDay.leaveHotel} for the ${time.lastDay.depart} flight</small></div>
    </div>
    ${time.flags.map(f => html`<p class="tb-tip tb-tip-warn">${icon('alert')} ${f.text}</p>`)}
    ${alts.length ? html`<h3>${icon('sun')} Get my day back</h3><ul class="tb-changes">${alts.map(a => html`<li><a href="${changeUrl(token, cx, { flight: a.flight.id })}"><span>${a.flight.name} fare: ${a.flight.stops ? `${a.flight.stops} stop` : 'nonstop'}, out ${a.time.outbound}, back ${a.time.inbound}</span>${delta(a.delta)}<small>${hoursLabel(a.gain)} more vacation · new total ${money(a.total)}</small></a></li>`)}</ul>` : ''}
  </section>`;
}

// Budget unlocks: what a little more buys, from real re-priced changes; "make it better for the same
// money"; and the locks that let the engine re-plan everything else.
function unlockPanel(t, unlock, { budget, diff, token, cx, reviewUrl }) {
  const title = unlock.within.length ? `You still have ${money(diff)} available` : budget ? 'What a little more would get you' : 'Make it better';
  return html`<section class="tb-panel" id="unlock" aria-labelledby="unlock-title">
    <h2 id="unlock-title">${icon('sparkle')} ${title}</h2>
    ${unlock.steps.length ? html`<p class="tb-muted">Real re-priced changes, cheapest first.${unlock.within.length ? ' Or keep the savings: coming in under budget is a win.' : ''}</p>
      <ul class="tb-unlock">${unlock.steps.map(u => html`<li class="${u.within ? 'is-within' : ''}"><a href="${u.url}"><b>+${money(u.delta)}</b><span>${u.label}</span><small>new total ${money(u.total)}${u.within ? ' · within your budget' : diff !== null && diff > 0 ? ` · ${money(u.delta - diff)} over your budget` : ''}</small></a></li>`)}</ul>` : html`<p class="tb-muted">There is nothing left to upgrade on this trip with the inventory we have.</p>`}
    ${unlock.keep ? html`<p class="tb-tip">${icon('check')} Nothing within your remaining ${money(diff)} is a real improvement. Keep it: that is ${money(diff)} for the trip itself.</p>` : ''}
    <div class="tb-better-row">
      <a class="btn btn-navy" href="/trip/${token}/optimize?${contextParams(cx, { cap: 'same', lk: 'd' })}">${icon('sparkle')} Make it better for the same money</a>
      ${diff !== null && diff > 0 ? html`<a class="btn btn-ghost" href="${reviewUrl}">Keep my ${money(diff)} and book</a>` : ''}
    </div>
    <h3>${icon('lock')} Lock what you love, improve the rest</h3>
    <p class="tb-muted tb-small">Tick what must not change. We re-plan everything else${budget ? ` within your ${dollars(budget)}` : ' for the same money'} and show you before and after. Locked parts never change without you.</p>
    <form class="tb-locks" method="get" action="/trip/${token}/optimize">
      ${hiddenParams(contextParams(cx))}
      <input type="hidden" name="cap" value="${budget ? 'budget' : 'same'}">
      <label><input type="checkbox" name="lk" value="h"> ${icon('bed')} Keep ${t.hotel.name}</label>
      <label><input type="checkbox" name="lk" value="f"> ${icon('plane')} Keep these flights</label>
      <label><input type="checkbox" name="lk" value="d" checked> ${icon('calendar')} Keep these dates</label>
      <button class="btn btn-ghost" type="submit">Optimize everything else ${icon('arrow')}</button>
    </form>
  </section>`;
}

// Smart alternatives / Make it cheaper / Make it better, all from real re-priced single changes.
function singleChanges(t, options, token, cx) {
  const s = t.spec;
  const out = [];
  for (const h of options.hotels) if (h.hotel.id !== s.hotel) out.push({ label: `${h.hotel.stars > t.hotel.stars ? 'Upgrade' : h.hotel.stars < t.hotel.stars ? 'Switch' : 'Switch'} to ${h.hotel.name} (${h.hotel.stars}-star${h.hotel.features.beachfront && !t.hotel.features.beachfront ? ', beachfront' : ''})`, delta: h.delta, total: h.total, url: changeUrl(token, cx, { hotel: h.hotel.id }), kind: 'hotel', better: h.hotel.stars > t.hotel.stars || h.hotel.rating > t.hotel.rating });
  for (const f of options.flights) if (f.flight.id !== s.flight) out.push({ label: `${f.flight.stops === 0 && t.flight.stops > 0 ? 'Nonstop flight' : f.flight.name + ' fare'} (${f.flight.stops ? `${f.flight.stops} stop` : 'nonstop'}, ${hm(f.flight.durationMinutes)})`, delta: f.delta, total: f.total, url: changeUrl(token, cx, { flight: f.flight.id }), kind: 'flight', better: (f.flight.stops < t.flight.stops) || (f.flight.refundable && !t.flight.refundable) });
  for (const n of options.nights) if (n.nights !== s.nights) out.push({ label: `${n.nights > s.nights ? 'Add' : 'Remove'} ${plural(Math.abs(n.nights - s.nights), 'night')} (${n.nights} nights)`, delta: n.delta, total: n.total, url: changeUrl(token, cx, { nights: n.nights }), kind: 'nights', better: n.nights > s.nights });
  for (const d of options.dates) out.push({ label: `Leave ${longDate(d.depart)} instead`, delta: d.delta, total: d.total, url: changeUrl(token, cx, { depart: d.depart }), kind: 'dates', better: false });
  for (const a of options.activities) out.push({ label: `${a.selected ? 'Remove' : 'Add'} ${a.activity.name}`, delta: a.selected ? -a.cost : a.cost, total: t.total + (a.selected ? -a.cost : a.cost), url: changeUrl(token, cx, { activities: a.selected ? s.activities.filter(x => x !== a.activity.id) : [...s.activities, a.activity.id] }), kind: 'activity', better: !a.selected });
  if (options.transfer) out.push({ label: s.transfer ? 'Remove the airport transfer' : 'Add a private airport transfer, both ways', delta: options.transfer.delta, total: options.transfer.total, url: changeUrl(token, cx, { transfer: s.transfer ? '0' : '1' }), kind: 'transfer', better: !s.transfer });
  if (options.bags) out.push({ label: s.bags ? 'Remove checked bags' : 'Add a checked bag for each traveler', delta: options.bags.delta, total: options.bags.total, url: changeUrl(token, cx, { bags: s.bags ? '0' : '1' }), kind: 'bags', better: !s.bags });
  return out;
}

function changeList(items, { empty }) {
  if (!items.length) return html`<p class="tb-muted">${empty}</p>`;
  return html`<ul class="tb-changes">${items.map(c => html`<li><a href="${c.url}"><span>${c.label}</span>${delta(c.delta)}<small>new total ${money(c.total)}</small></a></li>`)}</ul>`;
}

function knowBeforeYouBook(t, { weather, origin }) {
  const h = t.hotel, f = t.flight;
  const flexCount = [f.refundable, h.refundable, ...(t.activities.length ? [true] : []), ...(t.transfer ? [true] : [])].filter(Boolean).length;
  const parts = 2 + (t.activities.length ? 1 : 0) + (t.transfer ? 1 : 0);
  const flex = flexCount === parts ? ['High flexibility', 'Every part of this trip can be canceled within its own window.'] : flexCount ? ['Moderate flexibility', 'Some parts can be canceled or changed; the flights or hotel rate cannot.'] : ['Low flexibility', 'The flight fare and hotel rate are non-refundable after 24 hours.'];
  return html`<section class="tb-kbyb" id="know" aria-labelledby="kbyb-title">
    <h2 id="kbyb-title">Know before you book</h2>
    <p class="tb-muted">Everything that matters, before payment. No surprises after.</p>
    <div class="tb-kbyb-grid">
      <div><h3>${icon('check')} What’s included</h3><ul class="tb-list">${t.included.map(i => html`<li>${i}</li>`)}</ul></div>
      <div><h3>${icon('minus')} Not included</h3><ul class="tb-list">${t.notIncluded.map(i => html`<li>${i}</li>`)}</ul></div>
      <div><h3>${icon('bag')} Baggage</h3><p>${f.carryOn ? 'One carry-on bag' : 'One personal item only (no carry-on)'} per traveler. ${f.checkedBagIncluded || t.spec.bags ? 'One checked bag per traveler each way is in the price.' : `Checked bags cost ${money(f.bagFeePerTraveler)} per traveler both ways; add them in the customizer so they’re in your total.`} ${f.seatSelection ? 'Seat selection is available on this fare.' : 'Seats are assigned at check-in on this fare.'}</p></div>
      <div><h3>${icon('shield')} Cancellation and changes · ${flex[0]}</h3><p>${flex[1]}</p><ul class="tb-list">${t.policies.map(p => html`<li><b>${p.component}:</b> ${p.text}</li>`)}</ul></div>
      <div><h3>${icon('bed')} Hotel terms</h3><p>Check-in from 3:00 PM, check-out by 11:00 AM (confirm on your voucher). ${h.resortFeePerNight ? `This hotel charges a mandatory resort fee of ${money(h.resortFeePerNight)} per room per night. It is already in your total, so you won’t pay it at the desk.` : 'No resort fee at this hotel.'} ${h.features.adultsOnly ? 'Adults only (18+).' : ''}</p></div>
      <div><h3>${icon('bus')} Getting there</h3><p>Fly from ${origin ? `${origin.name} (${origin.code})` : t.spec.from} to ${t.dest.airport}. ${t.transfer ? `A private transfer meets you at the airport and takes you back for your return flight (${t.transfer.vehicles} vehicle${t.transfer.vehicles > 1 ? 's' : ''}).` : 'No transfer is included; taxis and shuttles are available at the airport, or add our private transfer above.'}</p></div>
      ${t.internationalTrip ? html`<div><h3>${icon('globe')} Travel documents</h3><p>${t.dest.country} is an international destination. Each traveler needs a valid passport, and entry rules depend on nationality. Check the official requirements for your passport before booking; we can’t guarantee entry to any country.</p></div>` : html`<div><h3>${icon('globe')} Travel documents</h3><p>A domestic trip: a government-issued photo ID is enough for US travelers.</p></div>`}
      ${weather ? html`<div><h3>${icon('sun')} Weather</h3><p>${weather.label} in ${new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${t.spec.depart}T00:00:00Z`))}, going by ${weather.source}. Not a forecast.</p></div>` : ''}
      <div><h3>${icon('users')} Who provides each part</h3><ul class="tb-list">${t.providers.map(p => html`<li><b>${p.component}:</b> ${p.provider}</li>`)}</ul></div>
    </div>
  </section>`;
}

function confidenceQuestions(t) {
  const h = t.hotel, f = t.flight;
  const qa = [
    ['Can I cancel?', `Within 24 hours of booking (with departure at least 7 days away), yes, in full. After that: ${h.refundable ? `the hotel is free to cancel until ${h.freeCancelHours} hours before check-in` : 'the hotel rate is non-refundable'}; ${f.refundable ? `the flights are refundable until ${f.freeCancelHours} hours before departure` : 'the flights are non-refundable'}; experiences and transfers are free to cancel until 24 hours before. Our service fee is refundable only in the first 24 hours.`],
    ['Can I change my dates?', `${f.changeable ? 'Flight dates can be changed for the fare difference.' : 'This basic fare can’t be changed; you would cancel and rebook.'} Hotel dates follow the hotel’s cancellation terms above. Changing dates before booking is free: use the customizer.`],
    ['What happens if the airline changes my flight?', 'If the airline cancels or significantly changes a flight, you can take the new schedule or a full refund of the flight portion under the airline’s rules. We’ll help you rebook the rest of the trip around it.'],
    ['Are taxes included?', `Yes. ${money(t.lines.find(l => l.key === 'taxes').amount)} of taxes and mandatory fees and our ${money(t.lines.find(l => l.key === 'service').amount)} service fee are in the total of ${money(t.total)}. Nothing is added at checkout.`],
    ['Are there additional hotel fees?', h.resortFeePerNight ? `The hotel’s mandatory resort fee is already in your total. Incidentals (minibar, parking, spa) are extra.` : 'No mandatory hotel fees. Incidentals (minibar, parking, spa) are extra.'],
    ['Who do I contact if something goes wrong?', 'Tripelyx support, from your trip page after booking (every booking gets a Trip ID), or the trip specialist link on this page before booking. Suppliers are listed above so you know who provides each part.'],
  ];
  return html`<section class="tb-faq-inline" aria-labelledby="cq-title"><h2 id="cq-title">Simple answers before you book</h2>${qa.map(([q, a]) => html`<details><summary>${q}</summary><p>${a}</p></details>`)}</section>`;
}

function tripView(ctx, { data, cx, user, saved, dreamGap }) {
  const { trip: t, token, scores, why, options, origin, weather } = data;
  const s = t.spec;
  const budget = cx.budget;
  const diff = budget ? budget - t.total : null;
  const changes = singleChanges(t, options, token, cx);
  const cheaper = changes.filter(c => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 6);
  const rescue = diff !== null && diff < 0 ? changes.filter(c => c.total <= budget).sort((a, b) => b.total - a.total).slice(0, 5) : [];
  const v = verdict(t, cx, scores);
  const time = usableTime(t);
  const timeAlts = time ? timeAlternatives(t, options) : [];
  const unlock = budgetUnlocks(changes, diff);
  const reviewUrl = `/trip/${token}/review?${contextParams(cx, { seen: t.total })}`;
  const tos = tradeoffs(t, cx);
  const body = html`
<div class="container tb-trip">
  <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / ${cx.searchParams ? html`<a href="/trips?${cx.searchParams}">Your trips</a> / ` : ''}<span aria-current="page">${t.dest.name}</span></nav>
  ${dreamGap || ''}
  <header class="tb-trip-head">
    <div class="tb-trip-media"><img src="${t.dest.image.url}" alt="${t.dest.image.alt}" width="800" height="500"></div>
    <div class="tb-trip-title">
      <p class="eyebrow">${plural(s.nights, 'night')} · ${plural(s.travelers, 'traveler')} · from ${origin ? origin.city : s.from} ${demoBadge(t.demo)}</p>
      <h1>${t.dest.name}, ${t.dest.country}</h1>
      <p class="tb-trip-dates">${longDate(s.depart)} – ${longDate(t.flight.return)}</p>
      <p class="tb-trip-blurb">${t.dest.blurb}</p>
      <div class="tb-trip-actions">
        <a class="btn btn-navy btn-lg" href="${reviewUrl}">Book this trip · ${money(t.total)} ${icon('arrow')}</a>
        <button class="btn btn-ghost" type="button" data-share="${token}" data-share-title="${s.nights} nights in ${t.dest.name} · ${money(t.perTraveler)}/person">${icon('share')} Share</button>
        ${user ? html`<form method="post" action="/trip/${token}/save?${contextParams(cx)}" class="tb-inline"><button class="btn btn-ghost" type="submit" name="kind" value="saved"${saved && saved.saved ? raw(' disabled') : ''}>${icon(saved && saved.saved ? 'heart-fill' : 'heart')} ${saved && saved.saved ? 'Saved' : 'Save trip'}</button><button class="btn btn-ghost" type="submit" name="kind" value="watch"${saved && saved.watch ? raw(' disabled') : ''}>${icon('eye')} ${saved && saved.watch ? 'Watching price' : 'Watch price'}</button></form>`
          : html`<a class="btn btn-ghost" href="/signin?next=${encodeURIComponent(`/trip/${token}?${contextParams(cx)}`)}">${icon('heart')} Save or watch</a>`}
      </div>
      <p class="tb-checked">${icon('check')} Price checked moments ago. We check it again before you pay, and nothing is charged until you confirm.</p>
    </div>
  </header>

  <div class="tb-trip-grid">
    <div class="tb-trip-main">
      ${verdictPanel(v, scores)}
      ${budget ? budgetMeter(t.total, budget) : ''}
      ${rescue.length ? html`<section class="tb-panel tb-panel-warn" aria-labelledby="rescue-title"><h2 id="rescue-title">${icon('alert')} Get me back to my price</h2><p>This trip is ${money(-diff)} over your ${dollars(budget)}. Any one of these gets it back under:</p>${changeList(rescue, { empty: '' })}</section>` : ''}
      ${unlockPanel(t, unlock, { budget, diff, token, cx, reviewUrl })}
      ${time ? timePanel(t, time, timeAlts, token, cx) : ''}

      <section class="tb-panel" aria-labelledby="rec-title"><h2 id="rec-title">Your trip recipe</h2>${recipe(t, budget)}</section>

      <section class="tb-panel" id="customize" aria-labelledby="cust-title">
        <h2 id="cust-title">Customize your trip</h2>
        <p class="tb-muted">Change anything. Every option shows the new total, with taxes and fees included.</p>
        <h3>${icon('bed')} Hotel</h3>
        <ul class="tb-options">${options.hotels.map(h => html`<li class="${h.hotel.id === s.hotel ? 'is-on' : ''}">${h.hotel.id === s.hotel ? html`<span class="tb-opt">${hotelLine(h.hotel)}<span class="tb-delta tb-delta-same">selected</span></span>` : html`<a class="tb-opt" href="${changeUrl(token, cx, { hotel: h.hotel.id })}">${hotelLine(h.hotel)}${delta(h.delta)}</a>`}</li>`)}</ul>
        <h3>${icon('plane')} Flights</h3>
        <ul class="tb-options">${options.flights.map(f => html`<li class="${f.flight.id === s.flight ? 'is-on' : ''}">${f.flight.id === s.flight ? html`<span class="tb-opt">${flightLine(f.flight)}<span class="tb-delta tb-delta-same">selected</span></span>` : html`<a class="tb-opt" href="${changeUrl(token, cx, { flight: f.flight.id })}">${flightLine(f.flight)}${delta(f.delta)}</a>`}</li>`)}</ul>
        <div class="tb-two">
          <div><h3>${icon('calendar')} Nights</h3><ul class="tb-pills">${options.nights.map(n => html`<li>${n.nights === s.nights ? html`<span class="tb-pill is-on">${n.nights} nights<small>${money(n.total)}</small></span>` : html`<a class="tb-pill" href="${changeUrl(token, cx, { nights: n.nights })}">${n.nights} nights<small>${money(n.total)}</small></a>`}</li>`)}</ul>
            ${(() => { const cheapestExtra = options.nights.filter(n => n.nights > s.nights).sort((a, b) => a.delta - b.delta)[0]; return cheapestExtra && cheapestExtra.delta < t.perNight * 0.6 * (cheapestExtra.nights - s.nights) ? html`<p class="tb-tip">${icon('sparkle')} ${cheapestExtra.nights - s.nights === 1 ? 'One more night' : `${cheapestExtra.nights - s.nights} more nights`} is only ${money(cheapestExtra.delta)} more${cheapestExtra.delta < 0 ? ' (cheaper flights on those dates)' : ''}.</p>` : ''; })()}
          </div>
          <div><h3>${icon('calendar')} Nearby dates</h3>${options.dates.length ? html`<ul class="tb-pills">${options.dates.map(d => html`<li><a class="tb-pill" href="${changeUrl(token, cx, { depart: d.depart })}">${shortDate(d.depart)}<small>${d.delta === 0 ? 'same' : (d.delta < 0 ? '−' : '+') + money(Math.abs(d.delta))}</small></a></li>`)}</ul>` : html`<p class="tb-muted">No other dates nearby.</p>`}
            ${(() => { const best = options.dates.filter(d => d.delta < -2000).sort((a, b) => a.delta - b.delta)[0]; return best ? html`<p class="tb-tip">${icon('trend')} Leave ${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${best.depart}T00:00:00Z`))} instead of ${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${s.depart}T00:00:00Z`))} and save ${money(-best.delta)}.</p>` : ''; })()}
          </div>
        </div>
        <h3>${icon('flag')} Experiences</h3>
        <ul class="tb-options tb-options-check">${options.activities.map(a => html`<li class="${a.selected ? 'is-on' : ''}"><a class="tb-opt" href="${changeUrl(token, cx, { activities: a.selected ? s.activities.filter(x => x !== a.activity.id) : [...s.activities, a.activity.id] })}" aria-pressed="${a.selected ? 'true' : 'false'}">${icon(a.selected ? 'check' : 'plus')}<span><b>${a.activity.name}</b><br><small>${a.activity.hours}h · ${money(a.activity.pricePerPerson)} per person · ${a.activity.supplier}</small></span>${a.selected ? html`<span class="tb-delta tb-delta-same">included · remove</span>` : delta(a.cost)}</a></li>`)}</ul>
        <h3>${icon('bus')} Extras</h3>
        <ul class="tb-options tb-options-check">
          ${options.transfer ? html`<li class="${s.transfer ? 'is-on' : ''}"><a class="tb-opt" href="${changeUrl(token, cx, { transfer: s.transfer ? '0' : '1' })}" aria-pressed="${s.transfer ? 'true' : 'false'}">${icon(s.transfer ? 'check' : 'plus')}<span><b>Private airport transfer, both ways</b><br><small>${options.transfer.quote.vehicles} vehicle${options.transfer.quote.vehicles > 1 ? 's' : ''} · ${options.transfer.quote.supplier}</small></span>${s.transfer ? html`<span class="tb-delta tb-delta-same">included · remove</span>` : delta(options.transfer.delta)}</a></li>` : ''}
          ${options.bags ? html`<li class="${s.bags ? 'is-on' : ''}"><a class="tb-opt" href="${changeUrl(token, cx, { bags: s.bags ? '0' : '1' })}" aria-pressed="${s.bags ? 'true' : 'false'}">${icon(s.bags ? 'check' : 'plus')}<span><b>Checked bag for each traveler, both ways</b><br><small>${money(t.flight.bagFeePerTraveler)} per traveler on this fare</small></span>${s.bags ? html`<span class="tb-delta tb-delta-same">included · remove</span>` : delta(options.bags.delta)}</a></li>` : html`<li class="is-on"><span class="tb-opt">${icon('check')}<span><b>Checked bag for each traveler</b><br><small>Included in this fare</small></span></span></li>`}
        </ul>
      </section>

      <section class="tb-panel" aria-labelledby="cheaper-title"><h2 id="cheaper-title">${icon('trend')} Make it cheaper</h2><p class="tb-muted">Single changes, biggest saving first. We never remove anything without showing you.</p>${changeList(cheaper, { empty: 'This is already the cheapest version of this trip we can build.' })}</section>

      ${knowBeforeYouBook(t, { weather, origin })}
      ${confidenceQuestions(t)}
    </div>

    <aside class="tb-trip-side">
      <div class="tb-sticky">
        <div class="tb-side-price"><span>Total for ${plural(s.travelers, 'traveler')}</span><b>${money(t.total)}</b><small>${money(t.perTraveler)} per traveler · ${money(t.perNight)} per night · taxes and fees included</small>
          ${budget ? html`<p class="${diff < 0 ? 'tb-side-over' : 'tb-side-under'}">${diff < 0 ? `${money(-diff)} over your budget` : `${money(diff)} under your ${dollars(budget)} budget`}</p>` : ''}
          <a class="btn btn-navy btn-block" href="${reviewUrl}">Review and book ${icon('arrow')}</a>
          <p class="tb-muted tb-small">Nothing is charged until you confirm on the payment page.</p></div>
        ${scorecard(scores, t.demo)}
        <div class="tb-side-why"><h3>Why we picked this</h3><ul class="tb-why-list">${why.map(w => html`<li>${icon('check')}${w}</li>`)}</ul>
          ${tos.length ? html`<h3>Trade-offs</h3><ul class="tb-tradeoff-list">${tos.map(w => html`<li>${icon('minus')}${w}</li>`)}</ul>` : ''}</div>
        <div class="tb-side-help"><h3>Need help with this trip?</h3><ul class="tb-list"><li><a href="/custom-trip?budget=${budget ? Math.round(budget / 100) : ''}&from=${origin ? encodeURIComponent(origin.city) : ''}&travelers=${s.travelers}&dest=${encodeURIComponent(t.dest.name)}">Ask a trip specialist to build it for me</a></li><li><a href="/contact">Ask a question about this trip</a></li>${cx.searchParams ? html`<li><a href="/trips?${cx.searchParams}">Back to my three trips</a></li>` : ''}</ul></div>
      </div>
    </aside>
  </div>
</div>
<script type="application/json" id="tb-trip-data">${jsonScript({ token, total: t.total, budget })}</script>`;
  return layout({
    title: `${plural(s.nights, 'night')} in ${t.dest.name} for ${money(t.total)}`, active: 'plan', body, ctx, scripts: ['/js/trips.js'], noindex: true,
    description: `${t.dest.name}: round-trip flights, ${t.hotel.name} and more for ${plural(s.travelers, 'traveler')}, ${money(t.total)} all in.`,
  });
}

// ---- review: live price check, final trip review, readiness, then the quote ----------------------

function reviewView(ctx, { data, cx, verify, user, promoError, promoCode }) {
  const { trip: t, token, origin, weather } = data;
  const s = t.spec;
  const budget = cx.budget;
  const diff = budget ? budget - t.total : null;
  const v = verdict(t, cx, data.scores);
  const reality = realityCheck(t, { weather });
  const REALITY_STATUS = { ok: 'Fine', 'heads-up': 'Heads-up', verify: 'Check before paying' };
  const changes = verify.status !== 'same' && diff !== null && diff < 0 ? singleChanges(t, data.options, token, cx).filter(c => c.total <= budget).sort((a, b) => b.total - a.total).slice(0, 4) : [];
  const said = [];
  if (budget) said.push([`Under ${dollars(budget)}`, t.total <= budget]);
  if (cx.style && cx.style !== 'surprise') said.push([cx.style === 'city' ? 'A city break' : cx.style === 'all-inclusive' ? 'All-inclusive' : `A ${cx.style} trip`, cx.style === 'all-inclusive' ? t.hotel.features.allInclusive : t.dest.styles.includes(cx.style)]);
  if (cx.nightsAsked) said.push([plural(cx.nightsAsked, 'night'), s.nights >= cx.nightsAsked]);
  if (cx.priority === 'flights') said.push(['Nonstop flights', t.flight.stops === 0]);
  if (cx.priority === 'hotel') said.push(['A 4-star or better hotel', t.hotel.stars >= 4]);
  said.push([plural(s.travelers, 'traveler'), true]);
  const statusBlock = {
    same: html`<div class="alert alert-success tb-price-status" role="status">${icon('check')}<span><b>Great news — your price is still ${money(t.total)}.</b> Every supplier confirmed availability and price just now.</span></div>`,
    cheaper: html`<div class="alert alert-success tb-price-status" role="status">${icon('trend')}<span><b>Good news — your trip dropped to ${money(t.total)}</b> (${money(verify.diff)} less than when you last looked).</span></div>`,
    higher: html`<div class="alert alert-warning tb-price-status" role="alert">${icon('alert')}<span><b>Your trip price changed by ${money(verify.diff)}</b> and is now ${money(t.total)}. We never charge a changed price without your approval: continue only if that’s fine, or change something below.</span></div>`,
  }[verify.status];
  const body = html`
<div class="container tb-review">
  ${stepsBar(1)}
  <div class="tb-checking" data-checking aria-live="polite"><span class="spinner" aria-hidden="true"></span> Checking your final price…</div>
  <div data-checked>
    ${statusBlock}
    ${verdictPanel(v, data.scores, { compact: true })}
    ${changes.length ? html`<section class="tb-panel tb-panel-warn"><h2>${icon('alert')} Get me back to my price</h2><p>The new price is ${money(-diff)} over your ${dollars(budget)}. Any of these brings it back under:</p>${changeList(changes, { empty: '' })}</section>` : ''}
    <div class="tb-review-grid">
      <section class="tb-panel" aria-labelledby="this-title">
        <h2 id="this-title">This is your trip</h2>
        <dl class="tb-dl">
          <div><dt>Destination</dt><dd>${t.dest.name}, ${t.dest.country}</dd></div>
          <div><dt>Travelers</dt><dd>${s.travelers} (${s.who})</dd></div>
          <div><dt>Dates</dt><dd>${longDate(s.depart)} – ${longDate(t.flight.return)} · ${plural(s.nights, 'night')}</dd></div>
          <div><dt>Flights</dt><dd>${t.flight.airline}, ${t.flight.stops ? `${t.flight.stops} stop` : 'nonstop'} round trip from ${origin ? origin.code : s.from}, ${t.flight.name} fare</dd></div>
          <div><dt>Hotel</dt><dd>${t.hotel.name}, ${t.hotel.stars}-star${t.hotel.features.beachfront ? ' beachfront' : ''}${t.hotel.features.allInclusive ? ', all-inclusive' : ''} · ${t.rooms} room${t.rooms > 1 ? 's' : ''}</dd></div>
          <div><dt>Experiences</dt><dd>${t.activities.length ? t.activities.map(a => a.name).join(', ') : 'None added'}</dd></div>
          <div><dt>Extras</dt><dd>${[t.transfer && 'Private airport transfer', (s.bags || t.flight.checkedBagIncluded) && 'Checked bags'].filter(Boolean).join(', ') || 'None'}</dd></div>
        </dl>
        ${budget ? html`<div class="tb-final-nums"><div><span>Your original budget</span><b>${money(budget)}</b></div><div><span>Final price</span><b>${money(t.total)}</b></div><div class="${diff < 0 ? 'is-over' : ''}"><span>${diff < 0 ? 'Over budget' : 'You keep'}</span><b>${money(Math.abs(diff))}</b></div></div>` : html`<div class="tb-final-nums"><div><span>Final price</span><b>${money(t.total)}</b></div></div>`}
        ${recipe(t, budget)}
      </section>
      <aside>
        <section class="tb-panel" aria-labelledby="ready-title">
          <h2 id="ready-title">${icon('check')} Your trip is ready</h2>
          <ul class="tb-ready">
            <li>${icon('check')} Price rechecked with every supplier</li>
            <li>${icon('check')} Dates: ${shortDate(s.depart)} – ${shortDate(t.flight.return)}</li>
            <li>${icon('check')} Travelers: ${s.travelers}</li>
            <li>${icon('check')} Hotel: ${t.hotel.name}</li>
            <li>${icon('check')} Flights: ${t.flight.stops ? '1 stop' : 'nonstop'}, ${t.flight.name}</li>
            <li>${icon('check')} Taxes, mandatory fees and service fee included</li>
            <li>${icon('info')} Remaining: review the cancellation terms below</li>
          </ul>
        </section>
        <section class="tb-panel" aria-labelledby="reality-title">
          <h2 id="reality-title">${icon('eye')} Travel reality check</h2>
          <ul class="tb-reality">${reality.map(r => html`<li class="is-${r.status}">${icon(r.status === 'ok' ? 'check' : r.status === 'verify' ? 'alert' : 'info')}<div><b>${r.label}</b><span class="tb-reality-status">${REALITY_STATUS[r.status]}</span><p>${r.text}</p></div></li>`)}</ul>
          <h3>${icon('minus')} What’s not in this price</h3>
          <ul class="tb-list tb-small">${t.notIncluded.map(i => html`<li>${i}</li>`)}</ul>
        </section>
        ${said.length ? html`<section class="tb-panel" aria-labelledby="said-title"><h2 id="said-title">You said you wanted</h2><ul class="tb-ready">${said.map(([l, ok]) => html`<li class="${ok ? '' : 'is-miss'}">${icon(ok ? 'check' : 'minus')} ${l}${ok ? '' : ' · not quite'}</li>`)}</ul></section>` : ''}
        <section class="tb-panel" aria-labelledby="terms-title">
          <h2 id="terms-title">Cancellation terms</h2>
          <ul class="tb-list tb-small">${t.policies.map(p => html`<li><b>${p.component}:</b> ${p.text}</li>`)}</ul>
          <p class="tb-small tb-muted">Full details, baggage and hotel terms are on the <a href="/trip/${token}?${contextParams(cx)}#know">trip page</a>.</p>
        </section>
      </aside>
    </div>
    <form class="tb-confirm" method="post" action="/trip/${token}/quote">
      <input type="hidden" name="cx" value="${contextParams(cx)}">
      <input type="hidden" name="approvedTotal" value="${t.total}">
      <div class="field tb-promo"><label for="promo">Promo code <span class="optional">(optional)</span></label><input id="promo" name="promo" maxlength="30" value="${promoCode || ''}" autocomplete="off"><p class="field-error">${promoError || ''}</p></div>
      <h2>Happy with everything?</h2>
      <p class="tb-muted">Next: traveler details and payment. <b>Nothing will be charged until you confirm.</b></p>
      <div class="tb-confirm-actions">
        <button class="btn btn-navy btn-lg" type="submit">${verify.status === 'higher' ? `Approve ${money(t.total)} and continue` : 'Yes — continue to book'} ${icon('arrow')}</button>
        <a class="btn btn-ghost btn-lg" href="/trip/${token}?${contextParams(cx)}#customize">Change something</a>
      </div>
      <p class="tb-muted tb-small">Not sure yet? ${user ? html`<a href="/trip/${token}?${contextParams(cx)}">Save or watch this trip</a>` : html`<a href="/signin?next=${encodeURIComponent(`/trip/${token}?${contextParams(cx)}`)}">Sign in to save or watch it</a>`} · <button class="tb-linkbtn" type="button" data-share="${token}" data-share-title="${s.nights} nights in ${t.dest.name}">share it with someone</button> · <a href="/contact">talk to support</a>. We don’t do pressure.</p>
    </form>
  </div>
</div>`;
  return layout({ title: 'Review your trip', active: 'plan', body, ctx, scripts: ['/js/trips.js'], noindex: true });
}

function unavailableView(ctx, { token, cx }) {
  const body = html`<div class="container tb-review">${stepsBar(1)}
    <div class="empty-state">${icon('clock')}<h3>Part of this trip just became unavailable</h3><p>Nothing was charged. A supplier no longer offers one of the parts at any price, so let’s rebuild around what’s left.</p>
      <p>${cx.searchParams ? html`<a class="btn btn-navy" href="/trips?${cx.searchParams}">Rebuild my trips</a>` : html`<a class="btn btn-navy" href="/plan${cx.budget ? `?b=${Math.round(cx.budget / 100)}` : ''}">Start again with my budget</a>`} <a class="btn btn-ghost" href="/custom-trip">Ask a trip specialist</a></p></div></div>`;
  return layout({ title: 'Trip unavailable', body, ctx, noindex: true });
}

module.exports = { tripView, reviewView, unavailableView, singleChanges, changeList };
