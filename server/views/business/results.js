// The results page (/business/o/:orgId/trips/search, plan §B6, §E4, §F7): the limits bar, then Outbound,
// Return and Hotel sections of radio cards, each option with its total, terms, policy badge and reasons; the
// options outside policy behind "Show N options outside your policy"; then the trip purpose and Review trip.
// One POST form to /trips carries the search's own fields (never a price: the draft is priced again on the
// server) and the picked row keys. GET only: the page writes nothing.
//
// Rows of one offer (one itinerary's fares, one hotel's rooms) share a card. Options inside the policy come
// first; the available options outside it that can still be requested sit in the toggle, so its count names
// only options that can be picked; options the policy blocks sit behind their own toggle, with disabled
// radios. An option the demo data doesn't have stays beside its offer's other options, with a disabled radio
// (parts.rowCard); an offer with no available option at all (a sold-out hotel) is listed last with
// "Not available in demo data" and no radio.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const f = require('./format');
const p = require('./parts');
const { places, cityOf, routeText, datesText, searchQuery, nightsBetween } = require('./trips');
const { PURPOSE_CHARS } = require('../../business/requests');
const { CABIN_LABELS } = require('../../business/constants');

/** "Sahara Wings", "Sahara Wings and Gulfstar", "A, B and C". */
function listText(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The leg's rows grouped by offer, in the order the service ranked them (first row of each offer). */
function byOffer(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.row.offerId)) groups.set(r.row.offerId, []);
    groups.get(r.row.offerId).push(r);
  }
  return [...groups.values()];
}

/** "Show 6 options blocked by policy": closed unless the traveler asked for every option (?all=1). */
function blockedToggle(count, body, { open = false } = {}) {
  if (!count) return '';
  return html`<details class="bz-outside bz-blocked-list"${open ? html` open` : ''}><summary class="bz-outside-sum">${icon('lock')}<span>Show ${f.plural(count, 'option')} blocked by policy</span></summary><div class="bz-outside-body">${body}</div></details>`;
}

/**
 * One leg: the cards inside policy, the toggle with the options outside it that can still be requested, the
 * options the policy blocks (behind their own toggle: they can't be picked), then offers with nothing
 * available. Each count names only the options in its own list.
 * @returns {{ markup: *, within: number, outside: number, blocked: number, selectable: number }}
 */
function legBody(leg, { name, checked, timeZone, open, priceToBeatCents = null, basis = 'incl_taxes' }) {
  const groups = byOffer(leg.rows);
  const main = [], outside = [], blocked = [], gone = [];
  let withinCount = 0, outsideCount = 0, blockedCount = 0;
  for (const g of groups) {
    const ok = g.filter(r => r.row.available && r.evaluation.status === 'within');
    const out = g.filter(r => r.row.available && r.evaluation.status === 'out');
    const no = g.filter(r => r.row.available && r.evaluation.status === 'blocked');
    const missing = g.filter(r => !r.row.available);
    withinCount += ok.length;
    outsideCount += out.length;
    blockedCount += no.length;
    // An option the demo data doesn't have stays with the first list its offer appears in.
    if (ok.length) main.push([...ok, ...missing]);
    if (out.length) outside.push(ok.length ? out : [...out, ...missing]);
    if (no.length) blocked.push(ok.length || out.length ? no : [...no, ...missing]);
    if (!ok.length && !out.length && !no.length) gone.push(missing);
  }
  const card = (group, input) => p.rowCard(group, { timeZone, input, level: 3, priceToBeatCents, basis });
  const input = { name, checked };
  return {
    within: withinCount, outside: outsideCount, blocked: blockedCount, selectable: withinCount + outsideCount,
    markup: html`${main.map(g => card(g, input))}
      ${p.outsideToggle(outsideCount, html`${outside.map(g => card(g, input))}`, { open: open || !withinCount })}
      ${blockedToggle(blockedCount, html`${blocked.map(g => card(g, input))}`, { open })}
      ${gone.map(g => card(g, null))}`,
  };
}

/** The search's own fields, as hidden inputs of the POST form (createRequest parses and searches them again). */
function hiddenQuery(q) {
  const fields = [['from', q.from], ['to', q.to], ['depart', q.departDate], ['return', q.returnDate || ''], ['cabin', q.cabin]];
  if (q.datesFlexible) fields.push(['flex', '1']);
  if (q.hotel) {
    fields.push(['hotel', '1']);
    if (!q.returnDate) fields.push(['nights', String(nightsBetween(q.hotel.checkIn, q.hotel.checkOut))]);
  }
  return fields.map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`);
}

/**
 * @param {object} ctx
 * @param {{ org: object, view: import('../../business/types').SearchView, all: boolean,
 *   pick?: { out: string, back: string, hotel: string, purpose: string }|null, error?: string|null,
 *   errors?: Record<string, string>, action: string }} m action: the POST /trips URL
 */
function resultsView(ctx, { org, view, all = false, pick = null, error = null, errors = {}, action }) {
  const base = `/business/o/${org.id}`;
  const timeZone = f.safeZone(org.timezone);
  const map = places(ctx);
  const q = view.query;
  const from = cityOf(map, q.from), to = cityOf(map, q.to);
  const blockMode = org.settings && org.settings.outOfPolicy === 'block';
  const legs = view.legs;
  const chosen = pick || { out: '', back: '', hotel: '', purpose: '' };

  const sections = [];
  const legSection = (id, title, sub, body) => html`<section class="bz-leg" aria-labelledby="${id}">
      <div class="bz-leg-head"><h2 id="${id}">${title}</h2>${sub ? html`<p class="bz-leg-sub">${sub}</p>` : ''}</div>
      ${body}
    </section>`;
  const noFlights = (a, b, date) => p.emptyState({ title: `No flights in the demo schedule for ${a} to ${b} on ${f.day(date)}.`, text: 'Try another date.', iconName: 'plane', action: { href: `${base}/trips/new?${searchQuery(q)}`, label: 'Change the search' } });
  const noPick = text => html`<p class="bz-leg-note">${icon('alert')}<span>${text}</span></p>`;
  const flightsNote = b => (b.blocked
    ? `None of these flights can be picked under ${org.name}'s policy. Try another date or cabin.`
    : 'None of these flights has a seat in the demo data. Try another date.');

  // Outbound
  const outLeg = legs.out;
  let outSelectable = 0;
  if (!outLeg || !outLeg.rows.length) {
    sections.push(legSection('bz-leg-out', 'Outbound', `${from} to ${to} · ${f.day(q.departDate)}`, noFlights(q.from, q.to, q.departDate)));
  } else {
    const b = legBody(outLeg, { name: 'out', checked: chosen.out, timeZone, open: all });
    outSelectable = b.selectable;
    sections.push(legSection('bz-leg-out', 'Outbound', `${from} to ${to} · ${f.day(q.departDate)}`, html`${b.selectable ? '' : noPick(flightsNote(b))}${b.markup}${outLeg.truncated ? html`<p class="bz-leg-note">${icon('info')}<span>Showing the first options of this search.</span></p>` : ''}`));
  }
  // Return
  let backSelectable = 1;
  if (q.returnDate) {
    const backLeg = legs.back;
    if (!backLeg || !backLeg.rows.length) {
      backSelectable = 0;
      sections.push(legSection('bz-leg-back', 'Return', `${to} to ${from} · ${f.day(q.returnDate)}`, noFlights(q.to, q.from, q.returnDate)));
    } else {
      const b = legBody(backLeg, { name: 'back', checked: chosen.back, timeZone, open: all });
      backSelectable = b.selectable;
      sections.push(legSection('bz-leg-back', 'Return', `${to} to ${from} · ${f.day(q.returnDate)}`, html`${b.selectable ? '' : noPick(flightsNote(b))}${b.markup}${backLeg.truncated ? html`<p class="bz-leg-note">${icon('info')}<span>Showing the first options of this search.</span></p>` : ''}`));
    }
  }
  // Hotel
  if (q.hotel) {
    const h = legs.hotel;
    const city = (h && h.city) || q.hotel.city || to;
    const sub = `${f.dayRange(q.hotel.checkIn, q.hotel.checkOut)} · ${f.plural(nightsBetween(q.hotel.checkIn, q.hotel.checkOut), 'night')}`;
    if (!h || !h.rows.length) {
      sections.push(legSection('bz-leg-hotel', `Hotel in ${city}`, sub, p.emptyState({ title: `No demo hotels in ${city} yet.`, text: 'You can still request the flights.', iconName: 'bed' })));
    } else {
      const basis = (h.rows.find(r => r.evaluation.cap && r.evaluation.cap.basis) || { evaluation: { cap: { basis: 'incl_taxes' } } }).evaluation.cap.basis;
      const b = legBody(h, { name: 'hotelKey', checked: chosen.hotel, timeZone, open: all, priceToBeatCents: h.priceToBeatCents, basis });
      const none = html`<label class="bz-choice bz-nohotel" for="t-nohotel"><input id="t-nohotel" type="radio" name="hotelKey" value=""${pick && pick.hotel === '' && pick.out ? html` checked` : ''}><span>No hotel for this trip</span></label>`;
      sections.push(legSection('bz-leg-hotel', `Hotel in ${city}`, sub, html`${b.selectable ? '' : noPick(b.blocked ? `None of these hotels can be picked under ${org.name}'s policy. You can still request the flights.` : 'None of these hotels has a room in the demo data for these dates. You can still request the flights.')}${b.markup}${none}${h.truncated ? html`<p class="bz-leg-note">${icon('info')}<span>Showing the first hotels of this search.</span></p>` : ''}`));
    }
  }

  const canReview = outSelectable > 0 && backSelectable > 0;
  const blocked = view.blockedCarrierNames || [];
  const notes = html`${blocked.length ? html`<div class="alert alert-info bz-alert" role="note">${icon('info')}<span>${listText(blocked)} ${blocked.length === 1 ? "isn't" : "aren't"} used by ${org.name}. Options on other airlines are below.</span></div>` : ''}
    ${blockMode ? html`<div class="alert alert-info bz-alert" role="note">${icon('lock')}<span>At ${org.name}, trips outside the policy can't be requested. Pick options marked Within Policy.</span></div>` : ''}`;

  const purposeError = errors.purpose || null;
  const form = html`<form class="bz-results" method="post" action="${action}">
    ${hiddenQuery(q)}
    ${sections}
    <section class="bz-card bz-purpose" aria-labelledby="bz-purpose-title">
      <h2 id="bz-purpose-title">Trip purpose</h2>
      <div class="field">
        <label for="t-purpose">What is this trip for?</label>
        <input id="t-purpose" name="purpose" type="text" required minlength="${String(PURPOSE_CHARS[0])}" maxlength="${String(PURPOSE_CHARS[1])}" value="${chosen.purpose || ''}" data-count="t-purpose-count" autocomplete="off" aria-describedby="t-purpose-count${purposeError ? ' t-purpose-err' : ''}"${purposeError ? html` aria-invalid="true"` : ''}>
        ${p.charCount('t-purpose-count', { min: PURPOSE_CHARS[0], max: PURPOSE_CHARS[1] })}
        ${purposeError ? html`<p class="field-error" id="t-purpose-err">${purposeError}</p>` : ''}
      </div>
      <p class="bz-purpose-note">Next you'll see the trip total, your policy check and any cheaper options. Nothing is booked or charged.</p>
    </section>
    ${p.actionBar(canReview
    ? html`<button class="btn btn-navy bz-btn" type="submit">${icon('arrow')}<span>Review trip</span></button>`
    : html`<p class="bz-leg-note">${icon('alert')}<span>Change the search to find flights you can take, then review the trip.</span></p><a class="btn btn-ghost bz-btn" href="${base}/trips/new?${searchQuery(q)}">Change the search</a>`)}
  </form>`;

  return html`${p.pageHead({
    title: `${routeText(map, q.from, q.to)}, ${datesText(q.departDate, q.returnDate)}`,
    sub: `${view.tierLabel} policy${view.departmentName ? ` · ${view.departmentName}` : ''} · ${f.plural(1, 'traveler')} · ${CABIN_LABELS[q.cabin] || q.cabin}`,
    actions: html`<a class="btn btn-ghost bz-btn" href="${base}/trips/new?${searchQuery(q)}">${icon('sliders')}<span>Change search</span></a>`,
  })}
  ${p.errorBox(error)}
  ${p.limitsBar(view.limits, { pricedAt: view.pricedAt, timeZone, level: 2 })}
  ${notes}
  ${form}`;
}

module.exports = { resultsView, byOffer, legBody, hiddenQuery };
