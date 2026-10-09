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
//
// Real suppliers (real-suppliers design §2.3, §2.4): the page's source is the least real source of its rows
// (else the search's inventory status), and every empty state and note says where the options came from: "in
// the supplier's test system" for supplier test data. A supplier search says what it left out and why
// (leg.skipped: fares in another currency, mixed cabins, fees paid in another currency, hotels with no
// name), that it shows the 40 lowest-priced hotels when the supplier sent that many, that each way of a
// return trip is its own one-way ticket, and, when the hotel supplier failed (leg.error), that the flights
// can still be requested. Demo pages are unchanged. On live prices (go-live design §5.6) each card says "US
// dollars, from the airline · Priced at … · Can change until booked" ("from the hotel supplier" for a hotel),
// and the limits bar names who priced the search its amounts come from.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const f = require('./format');
const p = require('./parts');
const { places, cityOf, routeText, datesText, searchQuery, nightsBetween } = require('./trips');
const { PURPOSE_CHARS } = require('../../business/requests');
const { CABIN_LABELS } = require('../../business/constants');
const { PRICE_CHECK_COPY } = require('../../business/source');

/** The hotels a supplier is asked for (LiteAPI limit 40, sorted by price; real-suppliers design §3.1). */
const SUPPLIER_HOTELS = 40;
/** Per-source copy of the results page ('demo' is today's). */
const COPY = Object.freeze({
  demo: Object.freeze({
    noFlights: (a, b, day) => `No flights in the demo schedule for ${a} to ${b} on ${day}.`,
    noSeats: 'None of these flights has a seat in the demo data. Try another date.',
    noHotels: city => `No demo hotels in ${city} yet.`,
    noRooms: 'None of these hotels has a room in the demo data for these dates. You can still request the flights.',
    flightsTruncated: 'Showing the first options of this search.',
    hotelsTruncated: 'Showing the first hotels of this search.',
  }),
  sandbox: Object.freeze({
    noFlights: (a, b, day) => `No flights found from ${a} to ${b} on ${day} in the supplier's test system.`,
    noSeats: "None of these flights has a seat in the supplier's test data. Try another date.",
    noHotels: city => `No hotels found in ${city} in the supplier's test system.`,
    noRooms: "None of these hotels has a room in the supplier's test data for these dates. You can still request the flights.",
    flightsTruncated: 'Showing the lowest-priced fares of this search.',
    hotelsTruncated: 'Showing the lowest-priced rooms of this search.',
  }),
  live: Object.freeze({
    noFlights: (a, b, day) => `No flights found from ${a} to ${b} on ${day}.`,
    // Every option unavailable means the supplier didn't confirm it again, not that it sold out: no scarcity claim.
    noSeats: 'None of these flights can be picked from the supplier right now. Try another date.',
    noHotels: city => `No hotels found in ${city}.`,
    noRooms: 'None of these hotels can be picked from the supplier for these dates. You can still request the flights.',
    flightsTruncated: 'Showing the lowest-priced fares of this search.',
    hotelsTruncated: 'Showing the lowest-priced rooms of this search.',
  }),
});
const HOTELS_NOT_CONNECTED = 'Hotels are not connected yet.';
const SUPPLIER_HOTELS_NOTE = `Showing the ${SUPPLIER_HOTELS} lowest-priced hotels the supplier returned.`;
const ONE_WAY_EACH = 'Each way is priced as its own one-way ticket.';

/** "GBP", "GBP and EUR". */
const codesText = codes => listText((Array.isArray(codes) ? codes : []).filter(c => typeof c === 'string' && /^[A-Z]{3}$/.test(c)));

/**
 * What a supplier search left out of one leg, from leg.skipped (types.SkipCounts), as sentences. `kind`
 * 'flight' says fares, 'hotel' says rates; `empty`: the leg has no row left to show.
 * @param {import('../../business/types').SkipCounts|undefined} skipped
 * @param {{ kind: 'flight'|'hotel', empty: boolean }} opts
 * @returns {string[]}
 */
function skippedNotes(skipped, { kind, empty }) {
  const k = skipped && typeof skipped === 'object' ? skipped : {};
  const n = key => (Number.isSafeInteger(k[key]) && k[key] > 0 ? k[key] : 0);
  const word = kind === 'hotel' ? 'rate' : 'fare';
  const out = [];
  if (n('otherCurrency')) {
    const codes = codesText(k.currencies);
    out.push(empty
      ? `This supplier priced every ${word} in ${codes || 'another currency'}. Tripelyx Business shows US dollar prices only for now, so none can be shown.`
      : `${f.plural(n('otherCurrency'), word)} priced in another currency ${n('otherCurrency') === 1 ? 'is' : 'are'} not shown.`);
  }
  if (kind === 'flight' && n('mixedCabin')) out.push('Fares that mix cabins are not shown yet.');
  if (kind === 'hotel' && n('feeOtherCurrency')) out.push('Some rates have fees paid at the hotel in another currency and are not shown yet.');
  if (kind === 'hotel' && n('noHotelData')) out.push('Hotels with no name from the supplier are not shown.');
  return out;
}

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

const MISSING = Object.freeze({
  out: ['bz-leg-out', 'an outbound flight'],
  back: ['bz-leg-back', 'a return flight'],
  hotel: ['bz-leg-hotel', 'a hotel'],
});

/**
 * "Choose an outbound flight, a return flight and a hotel (or No hotel for this trip)." with each choice a
 * link to its section, so one answer names everything Review trip still needs.
 * @param {string[]} missing of 'out', 'back', 'hotel'
 */
function missingText(missing) {
  const list = (missing || []).filter(k => MISSING[k]);
  if (!list.length) return '';
  const links = list.map(k => html`<a href="#${MISSING[k][0]}">${MISSING[k][1]}</a>`);
  const joined = links.length === 1 ? links[0] : html`${links.slice(0, -1).map((l, i) => html`${i ? ', ' : ''}${l}`)} and ${links[links.length - 1]}`;
  return html`Choose ${joined}${list.includes('hotel') ? ' (or No hotel for this trip)' : ''}.`;
}

/**
 * @param {object} ctx
 * @param {{ org: object, view: import('../../business/types').SearchView, all: boolean,
 *   pick?: { out: string, back: string, hotel: string, purpose: string }|null, error?: string|null,
 *   errors?: Record<string, string>, missing?: string[], action: string }} m action: the POST /trips URL;
 *   missing: the choices a refused Review trip still needs ('out', 'back', 'hotel')
 */
function resultsView(ctx, { org, view, all = false, pick = null, error = null, errors = {}, missing = [], action }) {
  const base = `/business/o/${org.id}`;
  const timeZone = f.safeZone(org.timezone);
  const map = places(ctx);
  const q = view.query;
  const from = cityOf(map, q.from), to = cityOf(map, q.to);
  const blockMode = org.settings && org.settings.outOfPolicy === 'block';
  const legs = view.legs;
  const chosen = pick || { out: '', back: '', hotel: '', purpose: '' };
  // Where this search's prices came from: its rows' least real source, else the inventory's status.
  const legRows = ['out', 'back', 'hotel'].flatMap(k => (legs[k] && Array.isArray(legs[k].rows) ? legs[k].rows.map(r => r.row) : []));
  const source = legRows.length ? f.rowsSource(legRows) : (f.isSource(view.status) ? view.status : 'demo');
  const copy = COPY[source] || COPY.demo;
  const supplier = source !== 'demo';
  const inv = ctx.business && ctx.business.inventory ? ctx.business.inventory : null;

  const sections = [];
  const legSection = (id, title, sub, body) => html`<section class="bz-leg" aria-labelledby="${id}">
      <div class="bz-leg-head"><h2 id="${id}">${title}</h2>${sub ? html`<p class="bz-leg-sub">${sub}</p>` : ''}</div>
      ${body}
    </section>`;
  const noFlights = (a, b, date) => p.emptyState({ title: copy.noFlights(a, b, f.day(date)), text: 'Try another date.', iconName: 'plane', action: { href: `${base}/trips/new?${searchQuery(q)}`, label: 'Change the search' } });
  const noPick = text => html`<p class="bz-leg-note">${icon('alert')}<span>${text}</span></p>`;
  const infoNote = text => html`<p class="bz-leg-note">${icon('info')}<span>${text}</span></p>`;
  // A supplier leg's notices: what it left out (leg.skipped), and the leg's own notes.
  const legNotes = (leg, kind, extra = []) => {
    if (!supplier || !leg) return '';
    const list = [...skippedNotes(leg.skipped, { kind, empty: !leg.rows.length }), ...extra];
    return list.length ? html`${list.map(infoNote)}` : '';
  };
  const flightsNote = b => (b.blocked
    ? `None of these flights can be picked under ${org.name}'s policy. Try another date or cabin.`
    : copy.noSeats);

  // Outbound
  const outLeg = legs.out;
  let outSelectable = 0;
  if (!outLeg || !outLeg.rows.length) {
    sections.push(legSection('bz-leg-out', 'Outbound', `${from} to ${to} · ${f.day(q.departDate)}`, html`${legNotes(outLeg, 'flight')}${noFlights(q.from, q.to, q.departDate)}`));
  } else {
    const b = legBody(outLeg, { name: 'out', checked: chosen.out, timeZone, open: all });
    outSelectable = b.selectable;
    sections.push(legSection('bz-leg-out', 'Outbound', `${from} to ${to} · ${f.day(q.departDate)}`, html`${b.selectable ? '' : noPick(flightsNote(b))}${legNotes(outLeg, 'flight')}${b.markup}${outLeg.truncated ? html`<p class="bz-leg-note">${icon('info')}<span>${copy.flightsTruncated}</span></p>` : ''}`));
  }
  // Return
  let backSelectable = 1;
  if (q.returnDate) {
    const backLeg = legs.back;
    // A supplier prices each way as its own one-way ticket (one offer request per leg).
    const oneWay = supplier ? [ONE_WAY_EACH] : [];
    if (!backLeg || !backLeg.rows.length) {
      backSelectable = 0;
      sections.push(legSection('bz-leg-back', 'Return', `${to} to ${from} · ${f.day(q.returnDate)}`, html`${legNotes(backLeg, 'flight')}${noFlights(q.to, q.from, q.returnDate)}`));
    } else {
      const b = legBody(backLeg, { name: 'back', checked: chosen.back, timeZone, open: all });
      backSelectable = b.selectable;
      sections.push(legSection('bz-leg-back', 'Return', `${to} to ${from} · ${f.day(q.returnDate)}`, html`${b.selectable ? '' : noPick(flightsNote(b))}${legNotes(backLeg, 'flight', oneWay)}${b.markup}${backLeg.truncated ? html`<p class="bz-leg-note">${icon('info')}<span>${copy.flightsTruncated}</span></p>` : ''}`));
    }
  }
  // Hotel
  if (q.hotel) {
    const h = legs.hotel;
    const city = (h && h.city) || q.hotel.city || to;
    const sub = `${f.dayRange(q.hotel.checkIn, q.hotel.checkOut)} · ${f.plural(nightsBetween(q.hotel.checkIn, q.hotel.checkOut), 'night')}`;
    if (h && h.error === 'unavailable') {
      // The hotel supplier failed: the flights still show (PRICE_CHECK_COPY.hotelsLeg).
      sections.push(legSection('bz-leg-hotel', `Hotel in ${city}`, sub, html`<div class="alert alert-warning bz-alert" role="status">${icon('alert')}<span>${PRICE_CHECK_COPY.hotelsLeg}</span></div>`));
    } else if (!h || !h.rows.length) {
      const off = supplier && inv && inv.hotelsConnected === false;
      sections.push(legSection('bz-leg-hotel', `Hotel in ${city}`, sub, html`${legNotes(h, 'hotel')}${p.emptyState({ title: off ? HOTELS_NOT_CONNECTED : copy.noHotels(city), text: 'You can still request the flights.', iconName: 'bed' })}`));
    } else {
      const basis = (h.rows.find(r => r.evaluation.cap && r.evaluation.cap.basis) || { evaluation: { cap: { basis: 'incl_taxes' } } }).evaluation.cap.basis;
      const b = legBody(h, { name: 'hotelKey', checked: chosen.hotel, timeZone, open: all, priceToBeatCents: h.priceToBeatCents, basis });
      // hotelChoice tells POST /trips that this form offered hotels, so leaving them all unpicked is a
      // missing choice (No hotel is a choice: the empty hotelKey).
      const none = html`<input type="hidden" name="hotelChoice" value="1"><label class="bz-choice bz-nohotel" for="t-nohotel"><input id="t-nohotel" type="radio" name="hotelKey" value=""${pick && pick.hotel === '' && pick.out ? html` checked` : ''}><span>No hotel for this trip</span></label>`;
      // A supplier is asked for its 40 lowest-priced hotels: say so when it sent that many.
      const hotels = new Set(h.rows.map(r => r.row.offerId)).size;
      const forty = hotels >= SUPPLIER_HOTELS ? [SUPPLIER_HOTELS_NOTE] : [];
      sections.push(legSection('bz-leg-hotel', `Hotel in ${city}`, sub, html`${b.selectable ? '' : noPick(b.blocked ? `None of these hotels can be picked under ${org.name}'s policy. You can still request the flights.` : copy.noRooms)}${legNotes(h, 'hotel', forty)}${b.markup}${none}${h.truncated ? html`<p class="bz-leg-note">${icon('info')}<span>${copy.hotelsTruncated}</span></p>` : ''}`));
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
  ${p.errorBox(missing && missing.length ? missingText(missing) : error)}
  ${p.limitsBar(view.limits, { pricedAt: view.pricedAt, timeZone, level: 2, source, kind: f.liveKind(source, legRows) })}
  ${notes}
  ${form}`;
}

module.exports = {
  resultsView, byOffer, legBody, hiddenQuery, missingText,
  skippedNotes, COPY, SUPPLIER_HOTELS_NOTE, ONE_WAY_EACH, HOTELS_NOT_CONNECTED,
};
