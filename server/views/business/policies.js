// The company's travel policies (plan §B4 "Policy, budgets and people", §B6 "Policy editor", §E1):
//   /business/o/:orgId/policies                 every tier at a glance (policy.view.all), and how the company
//                                               handles trips outside the policy (settings.travel to change it)
//   /business/o/:orgId/policies/:tier           the editor (policy.edit: flights per haul, route exceptions,
//                                               airlines the company doesn't use, hotels with country and city
//                                               limits, trip limit, "What changed?") or the rules read-only
//   /business/o/:orgId/policies/:tier/history   saved versions with their field changes, 10 per page
// Form field names are types.PolicyForm's; 422 details come back keyed by them and show under each field and
// in a list at the top. Policy limits are company rules, not prices, but in this preview they are checked
// against demo prices, so every block that states an amount is a demo container saying so (§F6). With no
// demo inventory (production) the same blocks are plain: there are no demo prices to check against.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { pageHead, pager, charCount, actionBar } = require('./parts');
const f = require('./format');
const { shellView } = require('./shell');
const { textField, textArea, selectField, checkField } = require('./auth');
const { TIERS, CABINS, CABIN_LABELS } = require('../../business/constants');
const { CAP_MODES, LIMITS } = require('../../business/policy/schema');
const { DEFAULTS_NOTE } = require('../../business/policy/defaults');

const DEFAULTS_BANNER = 'Starting rules suggested by Tripelyx. Review them before your team plans trips.';
const LIMITS_NOTE = 'Demo prices: in this preview, these limits are checked against demo flight and hotel prices only.';
const OUT_OF_POLICY = Object.freeze({
  approval: 'Allow with approval: trips outside the policy go to an approver with a reason.',
  block: 'Block: trips outside the policy can\'t be requested.',
});
// Short enough for a phone's select; the field hints say what each one means.
const CAP_LABELS = Object.freeze({
  none: 'No limit',
  fixed: 'Fixed amount',
  median_pct: 'Search median + %',
  median_plus: 'Search median + amount',
});
const CAP_HINT = 'Search median: the middle fare of the flights found for the trip.';
const COUNTRIES_DONE = 'Every country in the demo data already has its own limits.';
const HOTEL_CLASS_HINT = 'Hotel class as shown in the demo hotel data.';
const STOPS = Object.freeze([['', 'Any number of stops'], ['0', 'Nonstop only'], ['1', 'Up to 1 stop']]);
const BASIS = Object.freeze([['incl_taxes', 'Taxes included'], ['excl_taxes', 'Before taxes']]);
const STARS = Object.freeze([['', 'Any hotel class'], ...[1, 2, 3, 4, 5].map(n => [String(n), `Up to ${n}-star`])]);
const BANDS = Object.freeze([['short', 'Shorter flights'], ['long', 'Long-haul flights']]);

/** Demo inventory: limits are checked against demo prices, and the page says so. */
const demoOf = ctx => Boolean(ctx.business && ctx.business.inventory && ctx.business.inventory.status === 'demo');

/** The demo container around text that states policy amounts (with no demo inventory, plain: the company's own figures). */
function limitsBox(body, cls = '', demo = true) {
  if (!demo) return html`<div${cls ? html` class="${cls}"` : ''}>${body}</div>`;
  return html`<div class="bz-demo-box${cls ? ` ${cls}` : ''}" data-price-source="demo">${body}<p class="bz-price-note">${icon('info')}<span>${LIMITS_NOTE}</span></p></div>`;
}

/** "Changed by Dana Lee on Fri 9 Oct" (or who set the starting rules). */
function changedLine(view, timeZone) {
  if (view.defaults) return `${DEFAULTS_NOTE}, version 1.`;
  const who = view.updatedBy && view.updatedBy.name ? view.updatedBy.name : 'someone';
  return `Version ${view.version}. Changed by ${who} on ${f.dayIn(timeZone, view.updatedAt)}.`;
}

const linesList = lines => html`<ul class="bz-lines-text">${(lines || []).map(l => html`<li>${l}</li>`)}</ul>`;

// ---------------------------------------------------------------------------------------------------------
// Overview

/**
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ policies: import('../../business/types').PolicyView[], org: object, canTravel: boolean,
 *   notice?: string|null, error?: string|null }} v org: getOrg() (its rev and settings.outOfPolicy)
 */
function policiesView(ctx, shell, { policies, org, canTravel, notice = null, error = null }) {
  const base = `/business/o/${org.id}`;
  const tz = f.safeZone(org.timezone);
  const demo = demoOf(ctx);
  const mode = org.settings && org.settings.outOfPolicy === 'block' ? 'block' : 'approval';
  const cards = policies.map(p => html`<article class="bz-card bz-stack" aria-labelledby="bz-tier-${p.tier}">
    <div class="bz-card-head"><h2 id="bz-tier-${p.tier}">${p.tierLabel} policy</h2><span class="bz-pill">Version ${String(p.version)}</span></div>
    <p class="bz-meta">${changedLine(p, tz)}</p>
    ${limitsBox(linesList(p.description.lines), '', demo)}
    <div class="bz-inline">
      <a class="btn btn-navy bz-btn" href="${base}/policies/${p.tier}">${p.canEdit ? 'Edit' : 'View'}<span class="sr-only"> the ${p.tierLabel} policy</span></a>
      <a class="btn btn-ghost bz-btn" href="${base}/policies/${p.tier}/history">History<span class="sr-only"> of the ${p.tierLabel} policy</span></a>
    </div>
  </article>`);
  const handling = html`<section class="bz-card bz-stack" aria-labelledby="bz-oop-title">
    <h2 id="bz-oop-title">Trips outside the policy</h2>
    ${canTravel ? html`<form class="bz-stack" method="post" action="${base}/settings">
        <input type="hidden" name="rev" value="${String(org.rev ?? 0)}"><input type="hidden" name="from" value="policies">
        <fieldset class="bz-fieldset"><legend>When a trip is outside the policy</legend>
          <div class="bz-choices">
            ${['approval', 'block'].map(m => html`<label class="bz-choice"><input type="radio" name="outOfPolicy" value="${m}"${m === mode ? raw(' checked') : ''}><span>${OUT_OF_POLICY[m]}</span></label>`)}
            <label class="bz-choice is-disabled"><input type="radio" name="outOfPolicyLater" value="book_first" disabled><span>Book first, approver can cancel within 24 hours. Available once booking is live.</span></label>
          </div>
        </fieldset>
        <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Save</button></div>
      </form>`
    : html`<p>${OUT_OF_POLICY[mode]}</p><p class="bz-meta">Owners and Travel Admins can change this.</p>`}
  </section>`;
  const body = html`${pageHead({ title: 'Travel policies', sub: `Each person in ${org.name} travels under one tier. Change a person's tier on the People page.` })}
    <div class="bz-grid">${cards}</div>
    ${handling}`;
  return shellView(ctx, shell, { title: 'Travel policies', body, notice, error });
}

// ---------------------------------------------------------------------------------------------------------
// Editor

/** One form value as text (a repeated field shows its first value). */
function val(form, key) {
  const x = form ? form[key] : undefined;
  if (Array.isArray(x)) return x.length ? String(x[0]) : '';
  return x === undefined || x === null ? '' : String(x);
}

const blankAll = (form, keys) => keys.every(k => val(form, k).trim() === '');

/** The row numbers a form holds for `re` (capture 1), the non-blank ones, ascending. */
function rowsOf(form, re, present) {
  const seen = new Set();
  for (const k of Object.keys(form || {})) {
    const m = re.exec(k);
    if (m) seen.add(Number(m[1]));
  }
  return [...seen].filter(n => present(n)).sort((a, b) => a - b);
}

/** The next free row number after `rows` (and after every number the form used, blank or not). */
const nextRow = rows => (rows.length ? Math.max(...rows) + 1 : 0);

/** A form field's element id (each field's id is bz-pol- plus its name with dots as dashes). */
const fieldId = key => `bz-pol-${String(key).replace(/[^A-Za-z0-9_]+/g, '-')}`;

/**
 * A human name for a form field, for the list of problems at the top: "Country 9, name" (the message follows
 * after one colon).
 */
function fieldLabel(key) {
  const band = /^(short|long)\.(.+)$/.exec(key);
  const bandWords = { capMode: 'price limit', capAmount: 'amount', capPct: 'percentage', fallback: 'amount with too few fares', maxCabin: 'highest cabin', minAdvanceDays: 'days ahead', maxStops: 'stops', refundableOnly: 'refunds' };
  if (band) return `${band[1] === 'short' ? 'Shorter flights' : 'Long-haul flights'}, ${bandWords[band[2]] || band[2]}`;
  const route = /^route\.(\d+)\.(.+)$/.exec(key);
  if (route) return `Route exception ${Number(route[1]) + 1}, ${{ from: 'from', to: 'to', bothWays: 'both directions', maxCabin: 'highest cabin' }[route[2]] || bandWords[route[2]] || route[2]}`;
  const city = /^country\.(\d+)\.city\.(\d+)\.(name|nightly)$/.exec(key);
  if (city) return `Country ${Number(city[1]) + 1}, city ${Number(city[2]) + 1} ${city[3] === 'name' ? 'name' : 'nightly limit'}`;
  const country = /^country\.(\d+)\.(name|nightly)$/.exec(key);
  if (country) return `Country ${Number(country[1]) + 1}, ${country[2] === 'name' ? 'name' : 'nightly limit'}`;
  const named = {
    longHaulMinutes: 'Long haul starts at', blockedCarriers: 'Airlines your company doesn\'t use', 'hotel.capBasis': 'Hotel limits are',
    'hotel.default': 'Hotel limit everywhere else', 'hotel.maxStars': 'Highest hotel class', 'hotel.minAdvanceDays': 'Hotel days ahead',
    'hotel.refundableOnly': 'Refundable hotel rates', 'trip.maxTotal': 'Trip limit', note: 'What changed?', rev: 'Version',
  };
  return named[key] || key;
}

// Each amount field says which price limits use it; a limit ignores the others (they are still checked, so
// a typo there is flagged rather than dropped).
function capFields(prefix, form, errors, idp) {
  return html`${selectField({ id: `${idp}-capMode`, name: `${prefix}.capMode`, label: 'Price limit', options: CAP_MODES.map(m => [m, CAP_LABELS[m]]), value: val(form, `${prefix}.capMode`), error: errors[`${prefix}.capMode`], hint: CAP_HINT })}
    ${textField({ id: `${idp}-capAmount`, name: `${prefix}.capAmount`, label: 'Amount (US dollars)', value: val(form, `${prefix}.capAmount`), error: errors[`${prefix}.capAmount`], inputmode: 'decimal', maxlength: 12, hint: 'Used by Fixed amount (the limit) and Search median + amount (what is added).' })}
    ${textField({ id: `${idp}-capPct`, name: `${prefix}.capPct`, label: 'Percentage above the median', value: val(form, `${prefix}.capPct`), error: errors[`${prefix}.capPct`], inputmode: 'decimal', maxlength: 5, hint: 'Used by Search median + % only.' })}
    ${textField({ id: `${idp}-fallback`, name: `${prefix}.fallback`, label: 'With fewer than 3 fares to compare, up to (US dollars)', value: val(form, `${prefix}.fallback`), error: errors[`${prefix}.fallback`], inputmode: 'decimal', maxlength: 12, hint: 'Used by both search median limits.' })}`;
}

function bandFieldset(prefix, legend, form, errors) {
  const idp = `bz-pol-${prefix}`;
  return html`<fieldset class="bz-fieldset"><legend>${legend}</legend>
    <div class="bz-grid-fields">
      ${capFields(prefix, form, errors, idp)}
      ${selectField({ id: `${idp}-maxCabin`, name: `${prefix}.maxCabin`, label: 'Highest cabin', options: CABINS.map(c => [c, CABIN_LABELS[c]]), value: val(form, `${prefix}.maxCabin`), error: errors[`${prefix}.maxCabin`] })}
      ${textField({ id: `${idp}-minAdvanceDays`, name: `${prefix}.minAdvanceDays`, label: 'Book at least this many days ahead', value: val(form, `${prefix}.minAdvanceDays`), error: errors[`${prefix}.minAdvanceDays`], inputmode: 'numeric', maxlength: 3 })}
      ${selectField({ id: `${idp}-maxStops`, name: `${prefix}.maxStops`, label: 'Stops', options: STOPS, value: val(form, `${prefix}.maxStops`), error: errors[`${prefix}.maxStops`] })}
    </div>
    ${checkField({ id: `${idp}-refundableOnly`, name: `${prefix}.refundableOnly`, label: 'Only fares that refund part of the price', checked: val(form, `${prefix}.refundableOnly`) === '1', error: errors[`${prefix}.refundableOnly`] })}
  </fieldset>`;
}

function airportOptions(airports, current, blank) {
  const opts = airports.map(a => [a.code, a.city && a.city !== a.code ? `${a.city} (${a.code})` : a.code]);
  if (current && !opts.some(([c]) => c === current)) opts.push([current, current]);
  return [['', blank], ...opts];
}

function routeFieldset(n, form, errors, refs, isNew) {
  const p = `route.${n}`;
  const idp = `bz-pol-route-${n}`;
  return html`<fieldset class="bz-fieldset"><legend>${isNew ? 'Add a route exception' : `Route exception ${n + 1}`}</legend>
    <div class="bz-grid-fields">
      ${selectField({ id: `${idp}-from`, name: `${p}.from`, label: 'From', options: airportOptions(refs.airports, val(form, `${p}.from`), isNew ? 'Choose an airport' : 'Remove this exception'), value: val(form, `${p}.from`), error: errors[`${p}.from`], hint: isNew ? '' : 'To drop this exception, choose Remove this exception.' })}
      ${selectField({ id: `${idp}-to`, name: `${p}.to`, label: 'To', options: airportOptions(refs.airports, val(form, `${p}.to`), 'Choose an airport'), value: val(form, `${p}.to`), error: errors[`${p}.to`] })}
      ${capFields(p, form, errors, idp)}
      ${selectField({ id: `${idp}-maxCabin`, name: `${p}.maxCabin`, label: 'Highest cabin', options: [['', "Band's highest cabin"], ...CABINS.map(c => [c, CABIN_LABELS[c]])], value: val(form, `${p}.maxCabin`), error: errors[`${p}.maxCabin`], hint: 'Blank keeps the highest cabin of the flight\'s band (shorter or long-haul).' })}
    </div>
    ${checkField({ id: `${idp}-bothWays`, name: `${p}.bothWays`, label: 'Both directions', checked: val(form, `${p}.bothWays`) === '1', error: errors[`${p}.bothWays`] })}
  </fieldset>`;
}

/**
 * One country's hotel limits. `used`: the countries other rows already list, left out of the add row's
 * choices (a second row for a country is refused). An existing country sits in a closed <details> with a
 * one-line summary (open when one of its fields has a problem), so the editor stays short on a phone.
 */
function countryFieldset(n, form, errors, refs, isNew, used = new Set()) {
  const p = `country.${n}`;
  const idp = `bz-pol-country-${n}`;
  const name = val(form, `${p}.name`);
  const choices = isNew ? refs.countries.filter(c => !used.has(c)) : refs.countries;
  if (isNew && refs.countries.length && !choices.length && !name) return html`<p class="bz-meta">${COUNTRIES_DONE}</p>`;
  const nameField = refs.countries.length
    ? selectField({
      id: `${idp}-name`, name: `${p}.name`, label: 'Country',
      options: [['', isNew ? 'Choose a country' : 'Remove this country'], ...choices.map(c => [c, c]), ...(name && !choices.includes(name) ? [[name, name]] : [])],
      value: name, error: errors[`${p}.name`], hint: isNew ? '' : 'To drop this country, choose Remove this country.',
    })
    : textField({ id: `${idp}-name`, name: `${p}.name`, label: 'Country', value: name, error: errors[`${p}.name`], maxlength: LIMITS.nameChars });
  const cityRe = new RegExp(`^country\\.${n}\\.city\\.(\\d+)\\.(name|nightly)$`);
  const cities = rowsOf(form, cityRe, m => !blankAll(form, [`${p}.city.${m}.name`, `${p}.city.${m}.nightly`]));
  const blankCity = cities.length < LIMITS.citiesPerCountry ? nextRow(rowsOf(form, cityRe, () => true)) : null;
  const cityRow = (m, fresh) => html`<div class="bz-grid-fields bz-subset">
      ${textField({ id: `${idp}-city-${m}-name`, name: `${p}.city.${m}.name`, label: fresh ? 'Add a city' : `City ${m + 1}`, value: val(form, `${p}.city.${m}.name`), error: errors[`${p}.city.${m}.name`], maxlength: LIMITS.nameChars, hint: fresh ? '' : 'Clear the name to remove this city.' })}
      ${textField({ id: `${idp}-city-${m}-nightly`, name: `${p}.city.${m}.nightly`, label: 'Nightly limit there (US dollars)', value: val(form, `${p}.city.${m}.nightly`), error: errors[`${p}.city.${m}.nightly`], inputmode: 'decimal', maxlength: 12 })}
    </div>`;
  const fieldset = html`<fieldset class="bz-fieldset"><legend>${isNew ? 'Add a country' : name || `Country ${n + 1}`}</legend>
    <div class="bz-grid-fields">
      ${nameField}
      ${textField({ id: `${idp}-nightly`, name: `${p}.nightly`, label: 'Nightly limit (US dollars)', value: val(form, `${p}.nightly`), error: errors[`${p}.nightly`], inputmode: 'decimal', maxlength: 12 })}
    </div>
    ${cities.map(m => cityRow(m, false))}
    ${blankCity === null ? '' : cityRow(blankCity, true)}
  </fieldset>`;
  if (isNew) return fieldset;
  const nightly = val(form, `${p}.nightly`).trim();
  const summary = `${name || `Country ${n + 1}`}: ${nightly ? `${nightly} US dollars a night` : 'no nightly limit'}${cities.length ? `, ${f.plural(cities.length, 'city', 'cities')}` : ''}`;
  const open = Object.keys(errors || {}).some(k => k.startsWith(`${p}.`));
  return html`<details class="bz-more bz-pol-country"${open ? raw(' open') : ''}><summary>${summary}<span class="sr-only">, change</span></summary>${fieldset}</details>`;
}

/**
 * The editor (or the rules read-only for members without policy.edit).
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ view: import('../../business/types').PolicyView, form?: object|null, errors?: Record<string, string>,
 *   note?: string, error?: string|null, notice?: string|null }} v form: what to show in the fields (the
 *   submitted body after a 422, else view.form)
 */
function policyEditView(ctx, shell, { view, form = null, errors = {}, note = '', error = null, notice = null }) {
  const { org } = shell;
  const base = `/business/o/${org.id}`;
  const tz = f.safeZone(org.timezone);
  const demo = demoOf(ctx);
  const title = `${view.tierLabel} policy`;
  const head = pageHead({
    title,
    sub: changedLine(view, tz),
    actions: html`<a class="btn btn-ghost bz-btn" href="${base}/policies/${view.tier}/history">History</a><a class="btn btn-ghost bz-btn" href="${base}/policies">All tiers</a>`,
  });
  if (!view.canEdit) {
    const body = html`${head}
      ${limitsBox(linesList(view.description.lines), '', demo)}
      <p class="bz-meta">Owners and Travel Admins can change policies.</p>`;
    return shellView(ctx, shell, { title, body, notice, error });
  }
  const values = form || view.form || {};
  const refs = view.refs || { airports: [], carriers: [], countries: [] };
  const problems = Object.entries(errors || {});
  const routeRe = /^route\.(\d+)\.[A-Za-z]+$/;
  const routes = rowsOf(values, routeRe, n => !blankAll(values, [`route.${n}.from`, `route.${n}.to`]));
  const routeNew = refs.airports.length && routes.length < LIMITS.routeOverrides ? nextRow(rowsOf(values, routeRe, () => true)) : null;
  const countryRe = /^country\.(\d+)\.(?:name|nightly|city\.\d+\.(?:name|nightly))$/;
  const countries = rowsOf(values, countryRe, n => !blankAll(values, Object.keys(values).filter(k => k.startsWith(`country.${n}.`))));
  const countryNew = countries.length < LIMITS.countryCaps ? nextRow(rowsOf(values, countryRe, () => true)) : null;
  const usedCountries = new Set(countries.map(n => val(values, `country.${n}.name`)).filter(Boolean));
  const blocked = new Set((Array.isArray(values.blockedCarriers) ? values.blockedCarriers : values.blockedCarriers ? [values.blockedCarriers] : []).map(String));
  const carriers = [...refs.carriers, ...[...blocked].filter(c => !refs.carriers.some(x => x.code === c)).map(code => ({ code, name: code }))];
  const body = html`${head}
    ${view.defaults ? html`<p class="alert alert-info bz-alert" role="note">${icon('info')}<span>${DEFAULTS_BANNER}</span></p>` : ''}
    ${problems.length ? html`<div class="alert alert-error bz-alert" role="alert">${icon('alert')}<div><p>Check the highlighted fields:</p><ul class="bz-warnings">${problems.map(([k, m]) => html`<li><a href="#${fieldId(k)}">${fieldLabel(k)}</a>: ${m}</li>`)}</ul></div></div>` : ''}
    <form class="bz-stack bz-policy-form" method="post" action="${base}/policies/${view.tier}">
      <input type="hidden" name="rev" value="${String(view.rev)}">
      <section class="bz-section" aria-labelledby="bz-pol-flights"><h2 id="bz-pol-flights">Flights</h2>
        <div class="bz-grid-fields">
          ${textField({ id: 'bz-pol-longHaulMinutes', name: 'longHaulMinutes', label: 'Long haul starts at (minutes in the air)', value: val(values, 'longHaulMinutes'), error: errors.longHaulMinutes, inputmode: 'numeric', maxlength: 4, hint: '360 minutes is 6 hours.' })}
        </div>
        ${BANDS.map(([p, legend]) => bandFieldset(p, legend, values, errors))}
      </section>
      <section class="bz-section" aria-labelledby="bz-pol-routes"><h2 id="bz-pol-routes">Route exceptions</h2>
        <p class="bz-meta">The first exception that matches a flight sets its price limit and cabin, instead of its band's.</p>
        ${routes.map(n => routeFieldset(n, values, errors, refs, false))}
        ${routeNew === null ? (refs.airports.length ? '' : html`<p>Route exceptions need the airport list, which arrives once a supplier is connected.</p>`) : routeFieldset(routeNew, values, errors, refs, true)}
      </section>
      <section class="bz-section" aria-labelledby="bz-pol-airlines"><h2 id="bz-pol-airlines">Airlines your company doesn't use</h2>
        ${carriers.length ? html`<fieldset class="bz-fieldset" id="${fieldId('blockedCarriers')}"><legend>Tick the airlines to block</legend>
          <div class="bz-choices bz-grid-fields">${carriers.map(c => html`<label class="bz-choice"><input type="checkbox" name="blockedCarriers" value="${c.code}"${blocked.has(c.code) ? raw(' checked') : ''}><span>${c.name}${c.name !== c.code ? ` (${c.code})` : ''}</span></label>`)}</div>
          ${errors.blockedCarriers ? html`<p class="field-error">${errors.blockedCarriers}</p>` : ''}
        </fieldset>` : html`<p>The airline list arrives once a supplier is connected.</p>`}
      </section>
      <section class="bz-section" aria-labelledby="bz-pol-hotels"><h2 id="bz-pol-hotels">Hotels</h2>
        <fieldset class="bz-fieldset"><legend>Every hotel</legend>
          <div class="bz-grid-fields">
            ${selectField({ id: 'bz-pol-hotel-capBasis', name: 'hotel.capBasis', label: 'Nightly limits are', options: BASIS, value: val(values, 'hotel.capBasis'), error: errors['hotel.capBasis'] })}
            ${textField({ id: 'bz-pol-hotel-default', name: 'hotel.default', label: 'Nightly limit everywhere else (US dollars)', value: val(values, 'hotel.default'), error: errors['hotel.default'], inputmode: 'decimal', maxlength: 12, hint: 'Leave blank for no limit.' })}
            ${selectField({ id: 'bz-pol-hotel-maxStars', name: 'hotel.maxStars', label: 'Highest hotel class', options: STARS, value: val(values, 'hotel.maxStars'), error: errors['hotel.maxStars'], hint: HOTEL_CLASS_HINT })}
            ${textField({ id: 'bz-pol-hotel-minAdvanceDays', name: 'hotel.minAdvanceDays', label: 'Book at least this many days ahead', value: val(values, 'hotel.minAdvanceDays'), error: errors['hotel.minAdvanceDays'], inputmode: 'numeric', maxlength: 3 })}
          </div>
          ${checkField({ id: 'bz-pol-hotel-refundableOnly', name: 'hotel.refundableOnly', label: 'Only rates that can be cancelled for free, or partly, before the stay', checked: val(values, 'hotel.refundableOnly') === '1', error: errors['hotel.refundableOnly'] })}
        </fieldset>
        <p class="bz-meta">Limits by country, with city exceptions. A city's limit wins over its country's, and a country's over the limit everywhere else.</p>
        ${countries.map(n => countryFieldset(n, values, errors, refs, false))}
        ${countryNew === null ? '' : countryFieldset(countryNew, values, errors, refs, true, usedCountries)}
      </section>
      <section class="bz-section" aria-labelledby="bz-pol-trip"><h2 id="bz-pol-trip">Trip limit</h2>
        <div class="bz-grid-fields">
          ${textField({ id: 'bz-pol-trip-maxTotal', name: 'trip.maxTotal', label: 'Most a whole trip can cost (US dollars)', value: val(values, 'trip.maxTotal'), error: errors['trip.maxTotal'], inputmode: 'decimal', maxlength: 12, hint: 'Leave blank for no trip limit.' })}
        </div>
      </section>
      <section class="bz-section" aria-labelledby="bz-pol-save"><h2 id="bz-pol-save">Save</h2>
        ${textArea({ id: 'bz-pol-note', name: 'note', label: 'What changed?', value: note, error: errors.note, maxlength: LIMITS.noteChars, rows: 3, count: 'bz-pol-note-count', hint: charCount('bz-pol-note-count', { max: LIMITS.noteChars }) })}
        <p class="bz-meta">Saving publishes a new version. Trips already requested keep the version they were checked with.</p>
      </section>
      ${actionBar(html`<button class="btn btn-navy bz-btn" type="submit">Save as version ${String(view.version + 1)}</button>`)}
    </form>`;
  return shellView(ctx, shell, { title, body, notice, error });
}

// ---------------------------------------------------------------------------------------------------------
// History

const yesNo = b => (b ? 'Yes' : 'No');
const money = c => (Number.isSafeInteger(c) ? f.money(c) : 'No limit');

function capText(cap) {
  if (!cap || typeof cap !== 'object') return 'None';
  switch (cap.mode) {
    case 'fixed': return `Up to ${money(cap.amountCents)}`;
    case 'median_pct': return `Median plus ${Number.isSafeInteger(cap.pctTenths) ? f.percent(cap.pctTenths) : '?'} (or ${money(cap.fallbackCents)} with too few fares)`;
    case 'median_plus': return `Median plus ${money(cap.amountCents)} (or ${money(cap.fallbackCents)} with too few fares)`;
    default: return 'No price limit';
  }
}

/**
 * A change's label and its before and after values in words. refs (PolicyView.refs) turn airline codes into
 * names ("Zambezi Air (ZM)") and airport codes into cities ("Cairo to London").
 */
function describeChange(c, refs = null) {
  const p = String(c.path || '');
  const carrierName = code => {
    const x = refs && Array.isArray(refs.carriers) ? refs.carriers.find(k => k.code === code) : null;
    return x && x.name && x.name !== code ? `${x.name} (${code})` : String(code);
  };
  const place = code => {
    const x = refs && Array.isArray(refs.airports) ? refs.airports.find(a => a.code === code) : null;
    return x && x.city ? x.city : String(code);
  };
  const band = /^flights\.(shortHaul|longHaul)\.(\w+)$/.exec(p);
  const bandName = b => (b === 'shortHaul' ? 'Shorter flights' : 'Long-haul flights');
  let label = p, show = x => (x === null || x === undefined ? 'None' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  if (p === 'flights.longHaulMinutes') { label = 'Long haul starts at'; show = x => `${x} minutes`; }
  else if (band) {
    const words = { cap: 'price limit', maxCabin: 'highest cabin', minAdvanceDays: 'days ahead', maxStops: 'stops', refundableOnly: 'refundable fares only' };
    label = `${bandName(band[1])}: ${words[band[2]] || band[2]}`;
    show = { cap: capText, maxCabin: x => CABIN_LABELS[x] || show(x), minAdvanceDays: x => f.plural(x, 'day'), maxStops: x => (x === null ? 'Any' : x === 0 ? 'Nonstop only' : `Up to ${f.plural(x, 'stop')}`), refundableOnly: yesNo }[band[2]] || show;
  } else if (/^flights\.routeOverrides\[/.test(p)) {
    const key = p.slice(p.indexOf('[') + 1, -1);
    const ends = /^([A-Z0-9]{3})-([A-Z0-9]{3})$/.exec(key);
    label = `Route exception ${ends ? `${place(ends[1])} to ${place(ends[2])}` : key}`;
    show = o => (o ? `${place(o.from)} to ${place(o.to)}${o.bothWays ? ' and back' : ''}: ${capText(o.cap)}, ${o.maxCabin ? CABIN_LABELS[o.maxCabin] : 'the band\'s cabin'}` : 'None');
  } else if (p === 'flights.blockedCarriers') { label = 'Airlines your company doesn\'t use'; show = x => (Array.isArray(x) && x.length ? x.map(carrierName).join(', ') : 'None'); }
  else if (p === 'hotels.capBasis') { label = 'Hotel limits are'; show = x => (x === 'excl_taxes' ? 'Before taxes' : 'Taxes included'); }
  else if (p === 'hotels.defaultNightlyCents') { label = 'Hotel limit everywhere else'; show = money; }
  else if (p === 'hotels.maxStars') { label = 'Highest hotel class'; show = x => (x === null ? 'Any' : `${x}-star`); }
  else if (p === 'hotels.minAdvanceDays') { label = 'Hotels: days ahead'; show = x => f.plural(x, 'day'); }
  else if (p === 'hotels.refundableOnly') { label = 'Refundable hotel rates only'; show = yesNo; }
  else if (p === 'trip.maxTotalCents') { label = 'Trip limit'; show = money; }
  else {
    const cityM = /^hotels\.countryCaps\[(.+?)\]\.cities\[(.+?)\](\.nightlyCents)?$/.exec(p);
    const countryM = /^hotels\.countryCaps\[(.+?)\](\.nightlyCents)?$/.exec(p);
    if (cityM) { label = `Hotels in ${cityM[2]}, ${cityM[1]}`; show = x => (x === null ? 'None' : typeof x === 'object' ? `${money(x.nightlyCents)} a night` : `${money(x)} a night`); }
    else if (countryM) {
      label = `Hotels in ${countryM[1]}`;
      show = x => (x === null ? 'None' : typeof x === 'object' ? `${money(x.nightlyCents)} a night${x.cities && x.cities.length ? ` (${x.cities.map(ci => `${ci.city} ${money(ci.nightlyCents)}`).join(', ')})` : ''}` : `${money(x)} a night`);
    }
  }
  return { label, before: show(c.before), after: show(c.after) };
}

/**
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ history: import('../../business/types').PolicyHistoryView, tierLabel: string, refs?: object|null }} v
 *   refs: PolicyView.refs, for airline and city names
 */
function policyHistoryView(ctx, shell, { history, tierLabel, refs = null }) {
  const { org } = shell;
  const base = `/business/o/${org.id}`;
  const tz = f.safeZone(org.timezone);
  const demo = demoOf(ctx);
  const cards = history.versions.map(v => {
    // Version 1 is Tripelyx's starting rules, saved when the company was set up: one line says so.
    if (v.version === 1) {
      return html`<li class="bz-card bz-stack">
      <div class="bz-card-head"><h2>Version 1</h2><span class="bz-meta">${f.dateTimeIn(tz, v.at)}</span></div>
      <p>${DEFAULTS_NOTE}, created when ${v.by && v.by.name ? `${v.by.name} set up the company` : 'the company was set up'}.</p>
    </li>`;
    }
    const changes = (v.changes || []).map(c => describeChange(c, refs));
    return html`<li class="bz-card bz-stack">
      <div class="bz-card-head"><h2>Version ${String(v.version)}</h2><span class="bz-meta">${f.dateTimeIn(tz, v.at)}${v.by && v.by.name ? ` by ${v.by.name}` : ''}</span></div>
      ${v.note ? html`<p><b>What changed:</b> ${v.note}</p>` : ''}
      ${changes.length
    ? limitsBox(html`<ul class="bz-changes">${changes.map(c => html`<li><b>${c.label}:</b> ${c.before} <span aria-hidden="true">→</span><span class="sr-only"> changed to</span> ${c.after}</li>`)}</ul>`, '', demo)
    : html`<p class="bz-meta">No field changes recorded.</p>`}
    </li>`;
  });
  const body = html`${pageHead({
    title: `${tierLabel} policy history`,
    sub: 'Every saved version, newest first.',
    actions: html`<a class="btn btn-ghost bz-btn" href="${base}/policies/${history.tier}">${tierLabel} policy</a>`,
  })}
    ${cards.length ? html`<ul class="bz-stack">${cards}</ul>` : html`<p>No versions to show.</p>`}
    ${pager(history.older ? `${base}/policies/${history.tier}/history?before=${history.older}` : null, 'Older versions')}`;
  return shellView(ctx, shell, { title: `${tierLabel} policy history`, body });
}

module.exports = {
  policiesView, policyEditView, policyHistoryView, describeChange, fieldLabel, limitsBox,
  DEFAULTS_BANNER, LIMITS_NOTE, OUT_OF_POLICY, CAP_LABELS, TIERS,
};
