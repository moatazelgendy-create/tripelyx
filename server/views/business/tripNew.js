// "Plan a work trip" (/business/o/:orgId/trips/new, plan §B4, §B6, §F3): the search form. It is a GET form to
// /trips/search, so a search can be shared, bookmarked and run again; nothing is stored until the traveler
// picks options and presses Review trip. With no supplier connected it shows the "Supplier not connected yet"
// panel, the fields disabled and no Search button; with live prices, a company Tripelyx hasn't confirmed sees
// "Search opens once Tripelyx confirms your company." the same way (go-live design §5.5). A search the form must fix comes back here with each
// field's message.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const tz = require('../../business/tz');
const { CABINS, CABIN_LABELS } = require('../../business/constants');
const { SEARCH_CLOSED } = require('../../business/source');
const f = require('./format');
const p = require('./parts');

const MAX_DAYS_AHEAD = 330;
const NIGHTS = Object.freeze([1, 14]);
const CHECKED = new Set(['1', 'on', 'true', 'yes']);

/** One form value as a string ('' for a repeated or missing field). */
const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * The form's values from a raw query (types.RawTripQuery): what the traveler typed, kept as typed.
 * @param {Record<string, unknown>} raw
 * @returns {{ from: string, to: string, depart: string, return: string, hotel: boolean, nights: string, cabin: string, flex: boolean }}
 */
function formValues(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    from: str(r.from).toUpperCase(), to: str(r.to).toUpperCase(), depart: str(r.depart), return: str(r.return),
    hotel: CHECKED.has(str(r.hotel)), nights: str(r.nights), cabin: str(r.cabin) || 'economy', flex: CHECKED.has(str(r.flex)),
  };
}

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A field's error attributes and message. */
const errAttrs = (id, error) => (error ? html` aria-invalid="true" aria-describedby="${id}-err"` : '');
const errText = (id, error) => (error ? html`<p class="field-error" id="${id}-err">${error}</p>` : '');

function airportSelect({ id, name, label, value, airports, error }) {
  return html`<div class="field">
    <label for="${id}">${label}</label>
    <select id="${id}" name="${name}" required${errAttrs(id, error)}>
      <option value="">Choose an airport</option>
      ${airports.map(a => html`<option value="${a.code}"${a.code === value ? html` selected` : ''}>${a.city} (${a.code})</option>`)}
    </select>
    ${errText(id, error)}
  </div>`;
}

/**
 * @param {object} ctx
 * @param {{ org: object, inventory: { status: string, airports: Function }, values: ReturnType<typeof formValues>,
 *   errors?: Record<string, string>, error?: string|null, departmentName: string|null, tierLabel: string }} m
 */
function tripNewView(ctx, { org, inventory, values, errors = {}, error = null, departmentName, tierLabel }) {
  const base = `/business/o/${org.id}`;
  // Live prices for a company Tripelyx hasn't confirmed yet (go-live design §5.5): the form is shown but off.
  const closed = !!inventory && inventory.status === 'live' && !!org && org.status !== 'active';
  const off = !inventory || inventory.status === 'none' || closed;
  let airports = [];
  try { airports = off ? [] : inventory.airports(); } catch { airports = []; }
  airports = [...airports].sort((a, b) => (a.city < b.city ? -1 : a.city > b.city ? 1 : 0));
  const today = tz.localDate(f.safeZone(org.timezone), ctx.now());
  const v = values || formValues({});
  const nights = [];
  for (let n = NIGHTS[0]; n <= NIGHTS[1]; n += 1) nights.push(n);

  const fields = html`<fieldset class="bz-search-fields"${off ? html` disabled` : ''}>
    <legend class="sr-only">Your trip</legend>
    <div class="bz-search-grid">
      ${airportSelect({ id: 't-from', name: 'from', label: 'From', value: v.from, airports, error: errors.from })}
      ${airportSelect({ id: 't-to', name: 'to', label: 'To', value: v.to, airports, error: errors.to })}
      <div class="field">
        <label for="t-depart">Leave on</label>
        <input id="t-depart" name="depart" type="date" required min="${today}" max="${addDays(today, MAX_DAYS_AHEAD)}" value="${v.depart}"${errAttrs('t-depart', errors.depart)}>
        ${errText('t-depart', errors.depart)}
      </div>
      <div class="field">
        <label for="t-return">Return on</label>
        <input id="t-return" name="return" type="date" min="${today}" max="${addDays(today, MAX_DAYS_AHEAD + 30)}" value="${v.return}" aria-describedby="t-return-hint${errors.return ? ' t-return-err' : ''}"${errors.return ? html` aria-invalid="true"` : ''}>
        <p class="field-hint" id="t-return-hint">Leave it blank for a one-way trip.</p>
        ${errText('t-return', errors.return)}
      </div>
      <div class="field">
        <label for="t-cabin">Cabin</label>
        <select id="t-cabin" name="cabin"${errAttrs('t-cabin', errors.cabin)}>
          ${CABINS.map(c => html`<option value="${c}"${c === v.cabin ? html` selected` : ''}>${CABIN_LABELS[c] || c}</option>`)}
        </select>
        ${errText('t-cabin', errors.cabin)}
      </div>
    </div>
    <div class="bz-choices">
      <label class="bz-choice" for="t-hotel"><input id="t-hotel" type="checkbox" name="hotel" value="1"${v.hotel ? html` checked` : ''}><span>I need a hotel</span></label>
      ${errText('t-hotel', errors.hotel)}
      <div class="field bz-nights">
        <label for="t-nights">Nights</label>
        <select id="t-nights" name="nights" aria-describedby="t-nights-hint${errors.nights ? ' t-nights-err' : ''}"${errors.nights ? html` aria-invalid="true"` : ''}>
          ${nights.map(n => html`<option value="${String(n)}"${String(n) === (v.nights || '1') ? html` selected` : ''}>${f.plural(n, 'night')}</option>`)}
        </select>
        <p class="field-hint" id="t-nights-hint">For one-way trips. With a return date, the hotel covers every night until you fly back.</p>
        ${errText('t-nights', errors.nights)}
      </div>
      <label class="bz-choice" for="t-flex"><input id="t-flex" type="checkbox" name="flex" value="1"${v.flex ? html` checked` : ''}><span>My dates can move by up to 3 days</span></label>
      ${errText('t-flex', errors.flex)}
    </div>
  </fieldset>`;
  // Outside the fieldset, so a form that is off (no supplier) never dims this line with its controls.
  const who = html`<p class="bz-search-who">${icon('shield')}<span>Your department: ${departmentName || 'None yet'} · Your policy: ${tierLabel}</span></p>`;

  return html`${p.pageHead({ title: 'Plan a work trip', sub: 'Your policy shows on every option as you search. Nothing is booked.' })}
  ${closed ? html`<section class="bz-card bz-supplier" aria-labelledby="bz-closed-title">
    <h2 class="bz-supplier-title" id="bz-closed-title">${icon('clock')}<span>Not open yet</span></h2>
    <p>${SEARCH_CLOSED}</p>
  </section>` : off ? p.supplierPanel() : ''}
  ${closed && error === SEARCH_CLOSED ? '' : p.errorBox(error)}
  <form class="bz-card bz-search" method="get" action="${base}/trips/search">
    ${fields}
    ${who}
    ${off ? '' : p.actionBar(html`<button class="btn btn-navy bz-btn" type="submit">${icon('search')}<span>Search</span></button>`)}
  </form>`;
}

module.exports = { tripNewView, formValues };
