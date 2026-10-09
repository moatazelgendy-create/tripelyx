// Shared Tripelyx Business view parts (plan §B3, §B6, §E4, §F6, §F7, §G3). Every workspace page builds on
// these; their styles are in public/css/business.css, which the workspace shell (views/business/shell.js)
// loads. Salvaged from 1B's parts (money, linesTable, termsList, checkedAt, comingSoon, demoBanner), rewritten
// for company travel, plus the new demoPrice, policyBadge, statusPill, violationList, limitsBar, rowCard and
// altCard, and the page furniture every workspace page shares (dataTable, emptyState, pageHead, tabs, pager,
// kvList, checklist, verdict, budgetBar) and the markup /js/business.js enhances (outsideToggle, copyLink,
// charCount). Their classes are in business.css, so a page needs no style of its own; business.css also has
// .bz-form, .bz-fieldset, .bz-choices/.bz-choice, .bz-tiles/.bz-tile, .bz-thread/.bz-msg and .bz-timeline for
// markup a page writes itself (site.css .field, .alert and .btn work inside the shell too).
//
// The demo rule (§F6): every amount renders as <span class="bz-money"> inside an element marked
// data-price-source="demo" that also shows "Demo price · Priced at 3:42 PM, Fri 9 Oct (Cairo time)". The parts
// that print money make that container themselves (demoPrice, demoBox, linesTable, limitsBar, rowCard,
// altCard, alternativesPanel, and violationList and verdict when their text quotes an amount); linesTable,
// violationList and verdict skip theirs with { inDemo: true } when they sit inside one already. A page that
// prints an amount anywhere else (a table cell, a fact) wraps it in demoBox(). Amounts are whole cents: a
// missing one throws (format.money) instead of reading "$0", and demoPrice(null) prints nothing.
//
// Views render the allow-listed DTOs only (types.FlightRow, HotelRow, Alternative, Evaluation): no provider,
// rating, review count, net rate or `internal` field exists to print. Times come from the rows and requests
// (pricedAt, from the injected clock) and read in the company's time zone, passed as `timeZone`.
//
// Price sources (real-suppliers design §2.3). The same parts take `{ source }` ('demo' by default, so demo
// pages are byte for byte what they were): the container says data-price-source="<source>" and its label
// names the source (format.pricedAtText). A supplier test data container ('sandbox') also gets the class
// bz-price-test (a dashed outline) and a visible "TEST DATA" tag in its label, so no screenshot of it can
// pass for a real fare. rowCard and altCard read the source from their own rows (source.sourceOf), so a
// caller cannot mislabel them. Supplier rows also read differently where the supplier says less than the
// demo data: stars 0 is "No star rating from the supplier" (and 4.5 is "4.5-star"), a weight of 0 kg is not
// stated (never printed), stops name their airports ("1 stop in Doha"), a flight sold by one airline and
// flown by another says "operated by", and a hotel's fee lines are paid at the hotel ("You pay $X when
// booked and $Y at the hotel" on live prices; "Of this total, $Y is paid at the hotel." on test data).
//
// Live prices (go-live design §5.6): every amount says "US dollars, from the airline · Priced at 3:42 PM, Fri
// 9 Oct (Cairo time) · Can change until booked" (a hotel's "from the hotel supplier"), in a container marked
// data-price-source="live", with no TEST DATA tag. The parts take `{ kind }` (format.PRICE_KINDS) to say who
// priced the amount; rowCard and altCard work it out from their own rows (format.priceKind), and a caller
// that labels a trip's amounts passes format.requestKind or format.priceKind of the trip's rows. No supplier
// is ever named.
const crypto = require('node:crypto');
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const f = require('./format');

const { money, plural } = f;
const { sourceOf, leastReal, TERMS } = require('../../business/source');

/** The label kind of a row: a flight's fare or a hotel's room rate. */
const rowKind = row => (row && row.kind === 'hotel' ? 'room' : 'fare');
/** A source this part knows ('demo' for anything else, so a mistake only looks less real). */
const known = source => (source === 'sandbox' || source === 'live' ? source : 'demo');
/** The container's class: a sandbox one also gets bz-price-test. */
const boxClass = (cls, source) => `${cls}${known(source) === 'sandbox' ? ' bz-price-test' : ''}`;
/** What the company's own policy limits are checked against, by supplier source (the /policies page's words). */
const LIMITS_CHECKED = Object.freeze({
  sandbox: "Supplier test data: in this preview, these limits are checked against flight and hotel prices from our suppliers' test systems, not real fares.",
  live: 'Supplier prices: these limits are checked against flight and hotel prices from our suppliers, which can change until booked.',
});
/** The visible "TEST DATA" tag of a sandbox label. */
const testTag = source => (known(source) === 'sandbox' ? html`<span class="bz-test-tag">TEST DATA</span>` : '');

/**
 * One amount, for a page that already sits inside a demo container: <span class="bz-money">$842</span>. Whole
 * cents only (format.money throws a TypeError on null, undefined, NaN or a string): a missing amount is the
 * page's to explain ("No budget set", "no longer in the demo data"), never a "$0".
 */
function amount(cents) {
  return html`<span class="bz-money">${money(cents)}</span>`;
}

/** "4:12 PM, Fri 9 Oct (Cairo time)": when a price was checked, in the company's zone. */
function checkedAt(iso, timeZone) {
  return f.dateTimeIn(timeZone, iso);
}

/** "4-star", "4.5-star" (a supplier's half star). Hotel class only (the DTO carries no rating or reviews). */
const stars = n => (Number.isInteger(n * 2) && n > 0 ? `${n}-star` : '');

/** A heading of level 2 to 6 with the given attributes (markup from html``) and body. */
function heading(level, attrs, body) {
  const n = Math.min(6, Math.max(2, Number(level) || 2));
  return html`${raw(`<h${n}`)}${attrs}>${body}${raw(`</h${n}>`)}`;
}

/** A stable element id from a row key (keys hold '.' and '|', and two keys must never share an id). */
const keyId = (prefix, key) => `${prefix}-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12)}`;

// ---------------------------------------------------------------------------------------------------------
// Demo labelling

/**
 * The visible price label: "Demo price · Priced at 3:42 PM, Fri 9 Oct (Cairo time)" (just "Demo price" when no
 * time is known), or the supplier test data or live label (format.pricedAtText), with the "TEST DATA" tag
 * for supplier test data.
 * @param {string|null} pricedAt
 * @param {string} timeZone the company's
 * @param {{ inline?: boolean, source?: import('../../business/types').PriceSource, kind?: string, totals?: boolean, limits?: boolean, counted?: boolean }} [opts]
 *   inline: a <span> for use inside a sentence; totals: the container adds many requests up (budgets, reports,
 *   home), so a supplier source says format.SOURCE_TOTALS ("Includes supplier test data"); counted: false when
 *   such a live container adds up no trip priced on supplier prices (only budgets the company set), so it says
 *   format.LIVE_UNCOUNTED instead of "from our airline and hotel suppliers"; limits: the container holds the
 *   company's own policy limits, so a supplier source says what they are checked against (LIMITS_CHECKED), never
 *   "not a real price"; demo is unchanged; kind: who priced the amount (format.PRICE_KINDS)
 */
function priceNote(pricedAt, timeZone, { inline = false, source = 'demo', kind = 'price', totals = false, limits = false, counted = true } = {}) {
  const text = limits && known(source) !== 'demo' ? LIMITS_CHECKED[known(source)]
    : totals && known(source) === 'live' && counted === false ? f.LIVE_UNCOUNTED
    : totals && known(source) !== 'demo' ? f.SOURCE_TOTALS[known(source)] : f.pricedAtText(pricedAt, timeZone, { source: known(source), kind });
  if (known(source) !== 'sandbox') {
    return inline
      ? html`<span class="bz-price-note">${text}</span>`
      : html`<p class="bz-price-note">${icon('info')}<span>${text}</span></p>`;
  }
  return inline
    ? html`<span class="bz-price-note">${testTag(source)} ${text}</span>`
    : html`<p class="bz-price-note">${icon('info')}${testTag(source)}<span>${text}</span></p>`;
}

/**
 * One amount with its label, as its own price container:
 * <span data-price-source="demo"><span class="bz-money">$842</span> <span>Demo price · Priced at …</span></span>.
 * No amount (null or undefined, e.g. a budget's remaining with no budget set) prints nothing at all, so it can
 * never read as a "$0" price; anything else that is not whole cents throws a TypeError.
 * @param {number|null} cents
 * @param {{ pricedAt: string|null, timeZone: string, source?: import('../../business/types').PriceSource, kind?: string }} opts
 */
function demoPrice(cents, { pricedAt, timeZone, source = 'demo', kind = 'price' }) {
  if (cents === null || cents === undefined) return '';
  const s = known(source);
  return html`<span class="${boxClass('bz-demo-price', s)}" data-price-source="${s}">${amount(cents)} ${priceNote(pricedAt, timeZone, { inline: true, source: s, kind })}</span>`;
}

const BOX_TAGS = Object.freeze(['div', 'section', 'article', 'aside']);

/**
 * Wrap money-bearing markup in a price container that ends with its label.
 * @param {*} body markup from html``
 * @param {{ pricedAt: string|null, timeZone: string, tag?: 'div'|'section'|'article'|'aside', cls?: string, label?: string,
 *   source?: import('../../business/types').PriceSource, kind?: string, totals?: boolean, limits?: boolean, counted?: boolean }} opts
 *   label: an aria-label for a section or aside; totals, counted, limits, kind: see priceNote
 */
function demoBox(body, { pricedAt, timeZone, tag = 'div', cls = '', label = '', source = 'demo', kind = 'price', totals = false, limits = false, counted = true }) {
  const t = BOX_TAGS.includes(tag) ? tag : 'div';
  const s = known(source);
  return html`${raw(`<${t}`)} class="${boxClass(`bz-demo-box${cls ? ` ${cls}` : ''}`, s)}" data-price-source="${s}"${label ? html` aria-label="${label}"` : ''}>${body}${priceNote(pricedAt, timeZone, { source: s, kind, totals, limits, counted })}${raw(`</${t}>`)}`;
}

/** The workspace's demo ribbon (§B3): shown on every workspace page. */
const DEMO_RIBBON = 'Preview: flights, hotels and prices are demo data. Nothing is booked or charged. No emails are sent.';
/** The ribbon while flights and hotels come from the suppliers' test systems (real-suppliers design §2.3). */
const SANDBOX_RIBBON = "Preview with supplier test data: flights and hotels come from our suppliers' test systems. Prices are not real fares. Nothing is booked or charged.";
/** The ribbon with live supplier prices (go-live design §5.6). */
const LIVE_RIBBON = "Prices are live from our airline and hotel suppliers and can change until booked. Booking isn't open in Tripelyx yet: nothing is booked or charged.";

function demoBanner() {
  return html`<p class="bz-ribbon bz-ribbon-demo" role="note">${icon('info')}<span>${DEMO_RIBBON}</span></p>`;
}

/** "Supplier not connected yet" (§B6): the shell's ribbon on search pages (results), or the panel on the trip
 * form, which then leaves the ribbon out (searchPage false) so the page says it once. */
const NO_SUPPLIER = Object.freeze({
  title: 'Supplier not connected yet.',
  text: "Tripelyx hasn't connected airlines and hotels for company travel. Your policies, people and budgets work today, and search turns on when suppliers are connected.",
});

/**
 * The empty "your trips" list (the Trips page and home): how to start one, or, with no supplier, when search
 * turns on instead of asking for a trip nobody can plan yet; with live prices and a company Tripelyx has not
 * confirmed yet, when its search opens (go-live design §5.5).
 */
const NO_TRIPS = Object.freeze({
  title: 'No work trips yet.',
  text: "Plan one and you'll see your policy as you search.",
  textNoSupplier: 'Trip search turns on when Tripelyx connects airlines and hotels.',
  textWaiting: f.SEARCH_AFTER_CONFIRM,
});

/**
 * Where search would be, while live search waits for Tripelyx to confirm the company (go-live design §5.5): the
 * trip form shows this instead of the "Supplier not connected yet" panel.
 */
const AWAITING_CONFIRMATION = Object.freeze({ title: 'Waiting for confirmation', text: f.SEARCH_AFTER_CONFIRM });

function confirmPanel({ level = 2 } = {}) {
  return html`<section class="bz-card bz-supplier" aria-labelledby="bz-confirm-title">
    ${heading(level, html` class="bz-supplier-title" id="bz-confirm-title"`, html`${icon('clock')}<span>${AWAITING_CONFIRMATION.title}</span>`)}
    <p>${AWAITING_CONFIRMATION.text}</p>
  </section>`;
}

function supplierPanel({ level = 2 } = {}) {
  return html`<section class="bz-card bz-supplier" aria-labelledby="bz-supplier-title">
    ${heading(level, html` class="bz-supplier-title" id="bz-supplier-title"`, html`${icon('plug')}<span>${NO_SUPPLIER.title}</span>`)}
    <p>${NO_SUPPLIER.text}</p>
  </section>`;
}

// ---------------------------------------------------------------------------------------------------------
// Prices and terms

const LINE_KINDS = Object.freeze(['base', 'tax', 'fee', 'discount']);

/**
 * A supplier hotel's fee lines are paid at the hotel and are in its total (real-suppliers design §3.4). Live
 * prices: "You pay $X when booked and $Y at the hotel". Supplier test data is never booked, so it says only
 * "Of this total, $Y is paid at the hotel." Nothing when it has none, or for a demo row.
 * @param {import('../../business/types').Row} row
 */
function paidAtHotel(row) {
  const source = row ? sourceOf(row) : 'demo';
  if (!row || row.kind !== 'hotel' || source === 'demo' || !Array.isArray(row.lines)) return '';
  const fees = row.lines.filter(l => l && l.kind === 'fee' && Number.isSafeInteger(l.cents)).reduce((n, l) => n + l.cents, 0);
  if (fees <= 0 || !Number.isSafeInteger(row.totalCents)) return '';
  if (source !== 'live') return html`<p class="bz-paid-split">Of this total, ${amount(fees)} is paid at the hotel.</p>`;
  return html`<p class="bz-paid-split">You pay ${amount(row.totalCents - fees)} when booked and ${amount(fees)} at the hotel.</p>`;
}

/**
 * Every line of a price and the total (the sum of the lines, so the total shown is the total charged). A line
 * without whole cents throws a TypeError: a total that left it out would not be the total charged.
 * @param {import('../../business/types').RowLine[]} lines
 * @param {{ pricedAt?: string|null, timeZone?: string, inDemo?: boolean, totalLabel?: string,
 *   source?: import('../../business/types').PriceSource, kind?: string, row?: object|null }} [opts]
 *   inDemo: the caller's price container already labels it (no container of its own); row: the supplier
 *   hotel row the lines belong to, for the paid-at-the-hotel split
 */
function linesTable(lines, { pricedAt = null, timeZone = 'UTC', inDemo = false, totalLabel = 'Total', source = 'demo', kind = 'price', row = null } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.every(l => l && Number.isSafeInteger(l.cents))) throw new TypeError('[business] linesTable: every price line needs whole cents');
  const total = list.reduce((s, l) => s + l.cents, 0);
  const table = html`<dl class="bz-lines">
    ${list.map(l => html`<div class="bz-line is-${LINE_KINDS.includes(l.kind) ? l.kind : 'base'}"><dt>${l.label}</dt><dd>${amount(l.cents)}</dd></div>`)}
    <div class="bz-line bz-line-total"><dt>${totalLabel}</dt><dd>${amount(total)}</dd></div>
  </dl>${paidAtHotel(row)}`;
  return inDemo ? table : demoBox(table, { pricedAt, timeZone, cls: 'bz-lines-box', source, kind });
}

/**
 * Cancellation and change terms, one row per part of the trip. A row that needs verification is marked.
 * @param {Array<{ component: string, text: string, when?: string|null }>} items
 */
function termsList(items) {
  return html`<ul class="bz-terms">${(items || []).map(c => {
    const verify = /needs verification/i.test(`${c.text} ${c.when || ''}`);
    return html`<li${verify ? raw(' class="is-verify"') : ''}><b>${c.component}</b><span>${c.text}</span>${c.when ? html`<span class="bz-terms-when">${verify ? icon('alert') : icon('clock')}<span>${c.when}</span></span>` : ''}</li>`;
  })}</ul>`;
}

/**
 * A "Coming soon" panel. Never a number and never $0 (reports.COMING_SOON tiles).
 * @param {string} title
 * @param {string} text
 * @param {{ level?: number }} [opts]
 */
function comingSoon(title, text, { level = 2 } = {}) {
  return html`<section class="bz-soon">
    <div class="bz-soon-head">${heading(level, html` class="bz-soon-title"`, title)}<span class="bz-soon-chip">Coming soon</span></div>
    ${text ? html`<p>${text}</p>` : ''}
  </section>`;
}

// ---------------------------------------------------------------------------------------------------------
// Policy and status

/** Policy status → [label, icon] (§E4): always text plus an icon, never colour alone. */
const BADGES = Object.freeze({
  within: Object.freeze(['Within Policy', 'check']),
  out: Object.freeze(['Out of Policy', 'alert']),
  blocked: Object.freeze(['Blocked by policy', 'lock']),
});

/** The policy badge of a row, an alternative or a trip. An unknown status renders nothing. */
function policyBadge(status) {
  const b = BADGES[status];
  if (!b) return '';
  return html`<span class="bz-badge bz-badge-${status}">${icon(b[1])}<span>${b[0]}</span></span>`;
}

/** Pill labels and tones, per kind of record. Request statuses are the effective ones (types.EffectiveStatus). */
const PILLS = Object.freeze({
  request: Object.freeze({
    draft: ['Draft', 'neutral'],
    pending: ['Waiting for approval', 'warn'],
    approved: ['Approved to book', 'good'],
    denied: ['Denied', 'bad'],
    cancelled: ['Cancelled', 'muted'],
    expired: ['Expired', 'muted'],
    past: ['Past trip', 'muted'],
  }),
  org: Object.freeze({
    pending: ['Waiting for confirmation', 'warn'],
    active: ['Active', 'good'],
    suspended: ['Paused', 'bad'],
  }),
  member: Object.freeze({
    active: ['Active', 'good'],
    removed: ['Removed', 'muted'],
  }),
});

/**
 * A request approved on supplier prices is not "approved to book": test data can never be booked, and booking
 * isn't open for live prices yet (real-suppliers design §2.3). Demo keeps "Approved to book".
 */
const APPROVED_PILLS = Object.freeze({ sandbox: 'Approved (test data)', live: 'Approved' });

/**
 * A status pill: a request's effective status ("Approved to book"), a company's ("Waiting for confirmation")
 * or a member's.
 * @param {string} status
 * @param {{ kind?: 'request'|'org'|'member', source?: import('../../business/types').PriceSource }} [opts]
 *   source: the request's price source ('demo' by default): an approved supplier request says so
 */
function statusPill(status, { kind = 'request', source = 'demo' } = {}) {
  const table = PILLS[kind] || PILLS.request;
  let [label, tone] = table[status] || [String(status || 'Unknown'), 'neutral'];
  if (kind === 'request' && status === 'approved' && APPROVED_PILLS[known(source)]) label = APPROVED_PILLS[known(source)];
  return html`<span class="bz-pill bz-pill-${tone}">${label}</span>`;
}

const CURRENCY_RE = /[$€£¥]|\bUSD\b/;

/**
 * The reasons a row or trip is outside policy (Violation.text, written by the policy engine).
 * @param {import('../../business/types').Violation[]} violations
 * @param {{ collapse?: boolean, pricedAt?: string|null, timeZone?: string, inDemo?: boolean, source?: string, kind?: string }} [opts]
 *   collapse: the first reason, then "+N more" in a <details> (§E4). Texts can hold amounts ("Over your $712
 *   limit by $86"), so a list with an amount gets its own demo container, unless inDemo says the caller's
 *   container already labels it. That container says when the amounts were priced, so it needs pricedAt:
 *   without one a list with an amount throws a TypeError (a reason without amounts needs no time).
 */
function violationList(violations, { collapse = false, pricedAt, timeZone = 'UTC', inDemo = false, source = 'demo', kind = 'price' } = {}) {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) return '';
  const item = v => html`<li class="bz-reason${v.severity === 'block' ? ' is-block' : ''}">${icon(v.severity === 'block' ? 'lock' : 'alert')}<span>${v.text}</span></li>`;
  const body = collapse && list.length > 1
    ? html`<div class="bz-reasons-wrap"><ul class="bz-reasons">${item(list[0])}</ul><details class="bz-reasons-more"><summary>+${String(list.length - 1)} more</summary><ul class="bz-reasons">${list.slice(1).map(item)}</ul></details></div>`
    : html`<ul class="bz-reasons">${list.map(item)}</ul>`;
  const hasMoney = list.some(v => CURRENCY_RE.test(String(v.text || '')));
  if (inDemo || !hasMoney) return body;
  if (!pricedAt) throw new TypeError('[business] violationList: a reason with an amount needs pricedAt (or inDemo inside a priced demo container)');
  return demoBox(body, { pricedAt, timeZone, cls: 'bz-reasons-box', source, kind });
}

/** Why a policy limit sits beside a price label: what the limits are checked against here, by price source. */
const LIMITS_NOTES = Object.freeze({
  demo: 'Limits are in US dollars. In this preview, the fares and rates they are checked against are demo prices.',
  sandbox: 'Limits are in US dollars. In this preview, the fares and rates they are checked against are supplier test data, not real fares.',
  live: 'Limits are in US dollars. The fares and rates they are checked against are supplier prices, which can change until booked.',
});
const limitsNote = source => LIMITS_NOTES[source] || LIMITS_NOTES.demo;

/**
 * Is a limits-bar item's amount worked out from the search's prices (a median cap, the Price to Beat) rather
 * than a limit the company set? Read from the reason policy/describe.limitsBar wrote: a median cap says
 * "(median of …", and the Price to Beat is the company's limit only when "this search has too few … hotels to
 * compare".
 * @param {import('../../business/types').LimitItem} item
 */
function fromSearch(item) {
  if (!item || item.cents === null || item.cents === undefined) return false;
  const suffix = String(item.suffix || '');
  if (item.key === 'hotel.priceToBeat') return !/too few (?:test )?hotels to compare/.test(suffix);
  return /^flight\./.test(String(item.key)) && suffix.includes('(median of ');
}

/** The chip beside each amount of the limits bar, by source. */
const LIMIT_CHIPS = Object.freeze({ demo: 'Demo price', sandbox: 'Test data', live: 'Supplier price' });

/**
 * "Your limits for this search" (§E4, policy/describe.limitsBar): each amount in a chip that says
 * "Demo price" ("Test data" for supplier test data), and the bar's own price label. On supplier prices only an
 * amount worked out from the search (fromSearch: a median cap, the Price to Beat) gets the chip; a
 * limit the company set is its own amount, not a supplier price.
 * @param {import('../../business/types').LimitsBar} bar
 * @param {{ pricedAt: string|null, timeZone: string, level?: number, source?: import('../../business/types').PriceSource, kind?: string }} opts
 *   kind: who priced the search the bar's amounts come from (format.priceKind of its rows)
 */
function limitsBar(bar, { pricedAt, timeZone, level = 2, source = 'demo', kind = 'price' }) {
  if (!bar || !Array.isArray(bar.items)) return '';
  const s = known(source);
  // Only supplier test data gets the dashed test chip; a live price's chip is plain (go-live design §5.6).
  const chip = s === 'sandbox' ? 'bz-chip-demo bz-chip-test' : 'bz-chip-demo';
  return html`<section class="${boxClass('bz-limits', s)}" data-price-source="${s}" aria-labelledby="bz-limits-title">
    ${heading(level, html` class="bz-limits-title" id="bz-limits-title"`, html`${icon('shield')}<span>${bar.heading}</span>`)}
    <ul class="bz-limits-list">
      ${bar.items.map(it => html`<li data-limit="${it.key}"><span>${it.text}</span>${it.cents === null || it.cents === undefined ? '' : html` <span class="bz-limit-amount">${amount(it.cents)}${s === 'demo' || fromSearch(it) ? html`<span class="${chip}">${LIMIT_CHIPS[s]}</span>` : ''}</span>`}${it.suffix ? html` <span>${it.suffix}</span>` : ''}</li>`)}
    </ul>
    ${priceNote(pricedAt, timeZone, { source: s, kind })}
  </section>`;
}

// ---------------------------------------------------------------------------------------------------------
// Search rows

const offset = (fromLocal, toLocal) => Math.round((Date.parse(`${String(toLocal).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(fromLocal).slice(0, 10)}T00:00:00Z`)) / 86400000);

/**
 * "BA2490 operated by Iberia": a supplier flight's segments flown by another airline than the one whose
 * flight number they carry (the number's two-character prefix is the marketing airline).
 */
function operatedBy(row) {
  if (sourceOf(row) === 'demo') return [];
  return (row.segments || [])
    .filter(sg => sg && sg.carrier && sg.carrier.code && typeof sg.flightNumber === 'string' && sg.flightNumber.slice(0, 2) !== sg.carrier.code)
    .map(sg => `${sg.flightNumber} operated by ${sg.carrier.name || sg.carrier.code}`);
}

function flightHead(row, level, titleId) {
  const segs = row.segments || [];
  const first = segs[0], last = segs[segs.length - 1];
  if (!first || !last) return heading(level, html` class="bz-row-title" id="${titleId}"`, row.carrier ? row.carrier.name : 'Flight');
  const plus = offset(first.departLocal, last.arriveLocal);
  // A supplier's stops include stops inside a flight (row.via names each airport): "1 stop in Doha".
  const places = (row.via || []).map(v => v.city || v.code).filter(Boolean).join(', ');
  const stops = !row.stops ? 'Nonstop'
    : sourceOf(row) === 'demo' ? `${plural(row.stops, 'stop')} via ${(row.via || []).map(v => v.city).join(', ')}`
      : `${plural(row.stops, 'stop')}${places ? ` in ${places}` : ''}`;
  const operated = operatedBy(row);
  return html`<div class="bz-row-head">
    <p class="bz-row-kicker">${icon('plane')}<span>${row.leg === 'back' ? 'Return' : 'Outbound'} · ${f.day(first.departLocal.slice(0, 10))}</span></p>
    ${heading(level, html` class="bz-row-title" id="${titleId}"`, html`${f.clock24(first.departLocal)} <span aria-hidden="true">→</span><span class="sr-only"> to </span> ${f.clock24(last.arriveLocal)}${plus > 0 ? html`<sup class="bz-plus" title="${plural(plus, 'day')} later">+${String(plus)}</sup>` : ''}`)}
    <p class="bz-row-sub">${first.from.city} (${first.from.code}) to ${last.to.city} (${last.to.code})</p>
    <p class="bz-row-meta">${[stops, f.duration(row.elapsedMinutes), row.carrier ? row.carrier.name : '', (row.flightNumbers || []).join(', '), row.cabinLabel].filter(Boolean).join(' · ')}</p>${operated.length ? html`
    <p class="bz-row-meta">${operated.join(' · ')}</p>` : ''}
  </div>`;
}

/** No star rating, said as the supplier's (a demo hotel always has one). */
const NO_STARS = 'No star rating from the supplier';

function hotelHead(row, level, titleId) {
  const cls = sourceOf(row) !== 'demo' && row.stars === 0 ? NO_STARS : stars(row.stars);
  return html`<div class="bz-row-head">
    <p class="bz-row-kicker">${icon('bed')}<span>Hotel · ${f.dayRange(row.checkIn, row.checkOut)} · ${plural(row.nights, 'night')}</span></p>
    ${heading(level, html` class="bz-row-title" id="${titleId}"`, row.name)}
    <p class="bz-row-sub">${[cls, [row.area, row.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</p>
    ${row.amenities && row.amenities.length ? html`<p class="bz-row-meta">${row.amenities.slice(0, 4).join(' · ')}</p>` : ''}
  </div>`;
}

/** The unavailable option's text (§B6). */
const UNAVAILABLE = 'Not available in demo data';
/** The unavailable text by where the row came from. */
const UNAVAILABLE_BY_SOURCE = Object.freeze({ demo: UNAVAILABLE, sandbox: "Not available in the supplier's test data", live: 'No longer available from the supplier' });
/** An unavailable row's text: "Not available in demo data", or the supplier's. */
const unavailableText = row => UNAVAILABLE_BY_SOURCE[sourceOf(row)] || UNAVAILABLE;

/** Does a supplier row's fare state its checked bags? (Its terms say "not stated" when the airline doesn't.) */
const checkedStated = fare => !(typeof fare.terms === 'string' && (fare.terms.includes(TERMS.bagsUnknown) || fare.terms.includes('checked bags not stated')));

function optionText(row) {
  if (row.kind === 'flight') {
    const fare = row.fare || {};
    // A supplier's 0 kg means "not stated" (never printed), and bags it doesn't state are left to its terms.
    const stated = sourceOf(row) === 'demo' || checkedStated(fare);
    const bags = !stated ? '' : fare.checkedBags ? `${plural(fare.checkedBags, 'checked bag')}${fare.checkedKg ? ` (${fare.checkedKg} kg each)` : ''}` : 'No checked bag';
    return { name: `${fare.name || row.optionId} fare`, facts: [bags, fare.cabinKg ? `${fare.cabinKg} kg cabin bag` : ''].filter(Boolean).join(' · '), terms: fare.terms || '' };
  }
  const room = row.room || {};
  return {
    name: room.name || row.optionId,
    facts: [room.bed, room.sleeps ? `Sleeps ${room.sleeps}` : ''].filter(Boolean).join(' · '),
    terms: row.cancellation ? row.cancellation.text : '',
  };
}

/**
 * An option's price. A hotel also shows its nightly rate on the policy's basis (hotels.capBasis: the room-only
 * rate "before taxes", or the rate "with taxes"), and how far under the Price to Beat that same rate is, so
 * the rate shown and the saving claimed never disagree.
 */
function optionPrice(row, { priceToBeatCents, basis }) {
  if (!row.available || row.totalCents === null || row.totalCents === undefined) {
    return html`<p class="bz-opt-price is-unavailable">${unavailableText(row)}</p>`;
  }
  if (row.kind !== 'hotel') return html`<p class="bz-opt-price">${amount(row.totalCents)} <span class="bz-opt-unit">total</span></p>`;
  const excl = basis === 'excl_taxes';
  const nightly = excl ? row.nightlyCents : row.nightlyInclCents;
  const under = Number.isSafeInteger(priceToBeatCents) ? priceToBeatCents - nightly : null;
  return html`<p class="bz-opt-price">${amount(row.totalCents)} <span class="bz-opt-unit">total</span></p>
    <p class="bz-opt-nightly">${amount(nightly)} a night ${excl ? 'before taxes' : 'with taxes'}</p>
    ${under !== null && under > 0 ? html`<p class="bz-opt-beat">${icon('check')}<span>${amount(under)} a night under the Price to Beat</span></p>` : ''}${paidAtHotel(row)}`;
}

/**
 * A search result card (§F7): one itinerary with its fares, or one hotel with its rooms, each option with its
 * total, terms, policy badge and reasons. With `input`, each option is a radio of a form (unavailable and
 * blocked options are disabled). The whole card is one demo container. An option the demo data doesn't have
 * says "Not available in demo data" once: the policy engine marks it blocked (inventory.unavailable), but no
 * company rule blocks it, so it gets no "Blocked by policy" badge and no second "not available" reason.
 * @param {import('../../business/types').ResultRow|import('../../business/types').ResultRow[]} group rows of
 *   one offer (same offerId), in the order to show them
 * @param {{ timeZone: string, input?: { name: string, checked?: string|null, required?: boolean }|null,
 *   level?: number, priceToBeatCents?: number|null, basis?: 'incl_taxes'|'excl_taxes', lines?: boolean }} opts
 *   lines: a "Price details" disclosure with every price line under each option (default true)
 */
function rowCard(group, { timeZone, input = null, level = 3, priceToBeatCents = null, basis = 'incl_taxes', lines = true } = {}) {
  const list = (Array.isArray(group) ? group : [group]).filter(r => r && r.row);
  if (!list.length) return '';
  const head = list[0].row;
  const source = known(leastReal(list.map(r => sourceOf(r.row))));
  const titleId = keyId('bz-row', head.key);
  const options = list.map(({ row, evaluation }) => {
    const ev = evaluation || { status: null, violations: [] };
    const missing = !row.available;
    const reasons = missing ? (ev.violations || []).filter(v => v.rule !== 'inventory.unavailable') : ev.violations;
    const state = missing ? 'unavailable' : ev.status;
    const text = optionText(row);
    const id = keyId('bz-opt', `${input ? input.name : ''}|${row.key}`);
    const disabled = missing || ev.status === 'blocked';
    const checked = input && !disabled && input.checked === row.key;
    const label = html`<span class="bz-opt-name">${text.name}</span>${text.facts ? html`<span class="bz-opt-facts">${text.facts}</span>` : ''}${text.terms ? html`<span class="bz-opt-terms">${text.terms}</span>` : ''}`;
    return html`<li class="bz-opt${disabled ? ' is-disabled' : ''}${state ? ` is-${state}` : ''}">
      <div class="bz-opt-main">
        ${input ? html`<input class="bz-opt-radio" type="radio" id="${id}" name="${input.name}" value="${row.key}"${checked ? raw(' checked') : ''}${disabled ? raw(' disabled') : ''}${input.required ? raw(' required') : ''}><label class="bz-opt-label" for="${id}">${label}</label>` : html`<div class="bz-opt-label">${label}</div>`}
        <div class="bz-opt-side">${optionPrice(row, { priceToBeatCents, basis })}${missing ? '' : policyBadge(ev.status)}</div>
      </div>
      ${violationList(reasons, { collapse: true, inDemo: true })}
      ${lines && row.available && row.lines && row.lines.length ? html`<details class="bz-more"><summary>Price details</summary>${linesTable(row.lines, { inDemo: true, row })}</details>` : ''}
    </li>`;
  });
  return html`<article class="${boxClass(`bz-card bz-row bz-row-${head.kind === 'hotel' ? 'hotel' : 'flight'}`, source)}" data-price-source="${source}" aria-labelledby="${titleId}">
    ${head.kind === 'hotel' ? hotelHead(head, level, titleId) : flightHead(head, level, titleId)}
    <ul class="bz-opts">${options}</ul>
    ${priceNote(head.pricedAt, timeZone, { source, kind: rowKind(head) })}
  </article>`;
}

// ---------------------------------------------------------------------------------------------------------
// Cheaper alternatives (§G3)

const CHEAPEST_WITHIN_LABEL = 'Cheapest option inside your policy';
// The small pin badge, shown only when the pinned card's heading is not already CHEAPEST_WITHIN_LABEL
// (alternatives.buildAlternatives gives the pinned one that label, so its heading says it once).
const PIN_BADGE = 'Cheapest inside policy';

/** What "Saves $X vs your pick" adds, by source. */
const SAVES_NOTE = Object.freeze({ demo: ' (demo price)', sandbox: ' (test data)', live: '' });
/** The least real source of an alternative's (or any trip's) rows. */
const tripSource = rows => known(f.rowsSource(rows ? ['out', 'back', 'hotel'].map(c => rows[c]) : []));

/**
 * One cheaper alternative: label, saving, new total, badge, what you give up, the explainer's note, and
 * "Use this option" (POST swap) when `action` is given. Amounts come from the alternative's own numbers;
 * the label and note never hold one. The heading is alt.label, said once: a pinned card whose label is
 * already CHEAPEST_WITHIN_LABEL gets no badge; any other pinned card gets the small PIN_BADGE.
 * @param {import('../../business/types').Alternative} alt
 * @param {{ timeZone: string, pricedAt?: string|null, action?: string|null, rev?: number|string|null,
 *   pinned?: boolean, level?: number }} opts pricedAt: defaults to the alternative's outbound row's
 */
function altCard(alt, { timeZone, pricedAt = null, action = null, rev = null, pinned = false, level = 3 } = {}) {
  const at = pricedAt || (alt.rows && alt.rows.out ? alt.rows.out.pricedAt : null);
  const ev = alt.evaluation || { status: null, violations: [] };
  const give = (alt.giveUps || []).filter(Boolean);
  const source = tripSource(alt.rows);
  const kind = f.liveKind(source, f.tripRows(alt.rows));
  return html`<article class="${boxClass(`bz-card bz-alt${pinned ? ' is-pinned' : ''}`, source)}" data-price-source="${source}">
    ${pinned && alt.label !== CHEAPEST_WITHIN_LABEL ? html`<p class="bz-alt-pin">${icon('shield')}<span>${PIN_BADGE}</span></p>` : ''}
    ${heading(level, html` class="bz-alt-title"`, alt.label)}
    <p class="bz-alt-save">Saves ${amount(alt.savesCents)} vs your pick${SAVES_NOTE[source]}</p>
    <p class="bz-alt-total">New trip total: ${amount(alt.totalCents)}</p>
    <div class="bz-alt-policy">${policyBadge(ev.status)}${violationList(ev.violations, { collapse: true, inDemo: true })}</div>
    ${give.length ? html`<div class="bz-alt-give"><p class="bz-alt-give-title">What you give up</p><ul>${give.map(g => html`<li>${g}</li>`)}</ul></div>` : ''}
    ${alt.note ? html`<p class="bz-alt-note">${icon('sparkle')}<span>${alt.note}</span></p>` : ''}
    ${action ? html`<form class="bz-alt-form" method="post" action="${action}">
      <input type="hidden" name="altId" value="${alt.id}">
      ${rev === null || rev === undefined ? '' : html`<input type="hidden" name="rev" value="${String(rev)}">`}
      <button class="btn btn-navy bz-btn" type="submit">Use this option</button>
    </form>` : ''}
    ${priceNote(at, timeZone, { source, kind })}
  </article>`;
}

const ALT_HEADING = 'AI-powered cheaper alternatives';
const ALT_SUB = 'Found by Tripelyx AI in this same search. Every price here is a demo price from it; nothing is estimated.';
/** ALT_SUB by where the search's prices came from. */
const ALT_SUBS = Object.freeze({
  demo: ALT_SUB,
  sandbox: "Found by Tripelyx AI in this same search. Every price here is supplier test data from it, not a real fare; nothing is estimated.",
  live: 'Found by Tripelyx AI in this same search. Every price here is the supplier price from it; nothing is estimated.',
});
const ALT_TRUNCATED = 'We checked the closest options first; there may be other cheaper ones.';
const ALT_NONE = 'No cheaper option inside your policy turned up in this search. You can still request approval with a reason.';

/**
 * The "AI-powered cheaper alternatives" section of a draft (§G3): the cheapest option inside policy pinned
 * first, then the rest in the stored order.
 * @param {{ alternatives: import('../../business/types').Alternative[], cheapestWithin?: import('../../business/types').Alternative|null,
 *   truncated?: boolean, summary?: string }} result e.g. a draft request's alternatives, cheapestWithin,
 *   alternativesTruncated and explanation.summary
 * @param {{ timeZone: string, action?: string|null, rev?: number|string|null, level?: number }} opts
 */
function alternativesPanel({ alternatives = [], cheapestWithin = null, truncated = false, summary = '' } = {}, { timeZone, action = null, rev = null, level = 2, source = null } = {}) {
  const pinId = cheapestWithin ? cheapestWithin.id : null;
  const list = Array.isArray(alternatives) ? alternatives : [];
  const ordered = [...list.filter(a => a.id === pinId), ...list.filter(a => a.id !== pinId)];
  // The search's source: the caller's (the request's), else the alternatives' own rows.
  const s = source ? known(source) : known(leastReal(list.map(a => tripSource(a.rows))) || 'demo');
  return html`<section class="bz-alts" aria-labelledby="bz-alts-title">
    ${heading(level, html` class="bz-alts-title" id="bz-alts-title"`, html`${icon('sparkle')}<span>${ALT_HEADING}</span>`)}
    <p class="bz-alts-sub">${ALT_SUBS[s]}</p>
    ${ordered.length
    ? html`${summary ? html`<p class="bz-alts-summary">${summary}</p>` : ''}
      <div class="bz-alt-grid">${ordered.map(a => altCard(a, { timeZone, action, rev, pinned: a.id === pinId, level: Math.min(6, level + 1) }))}</div>`
    : html`<p class="bz-alts-summary">${summary || ALT_NONE}</p>`}
    ${truncated ? html`<p class="bz-alts-note">${ALT_TRUNCATED}</p>` : ''}
  </section>`;
}

// ---------------------------------------------------------------------------------------------------------
// Page furniture

/**
 * A table that turns into stacked rows on phones: each cell repeats its column label in a
 * <span class="bz-cell-label">, shown only when the header row is hidden.
 * @param {{ caption: string, columns: Array<{ label: string, num?: boolean }>, rows: Array<Array<*>>,
 *   empty?: string, captionVisible?: boolean }} t cells are text or markup from html``
 */
function dataTable({ caption, columns, rows, empty = 'Nothing here yet.', captionVisible = false }) {
  if (!rows || !rows.length) return html`<p class="bz-table-empty">${empty}</p>`;
  return html`<div class="bz-table-wrap"><table class="bz-table">
    <caption${captionVisible ? '' : raw(' class="sr-only"')}>${caption}</caption>
    <thead><tr>${columns.map(c => html`<th scope="col"${c.num ? raw(' class="is-num"') : ''}>${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map(r => html`<tr>${columns.map((c, i) => html`<td${c.num ? raw(' class="is-num"') : ''}><span class="bz-cell-label">${c.label}</span><span class="bz-cell-value">${r[i] === undefined ? '' : r[i]}</span></td>`)}</tr>`)}</tbody>
  </table></div>`;
}

/**
 * An empty state (§B6): a short title, a sentence, and an optional action.
 * @param {{ title: string, text?: string, action?: { href: string, label: string }|null, iconName?: string }} e
 */
function emptyState({ title, text = '', action = null, iconName = 'info' }) {
  return html`<div class="bz-empty">${icon(iconName)}<p class="bz-empty-title">${title}</p>${text ? html`<p>${text}</p>` : ''}${action ? html`<a class="btn btn-navy bz-btn" href="${action.href}">${action.label}</a>` : ''}</div>`;
}

/** A success notice after a 303 (`?ok=` mapped to fixed text by the route). */
function notice(text) {
  return text ? html`<div class="alert alert-success bz-alert" role="status">${icon('check')}<span>${text}</span></div>` : '';
}

/** An error message (a 4xx re-render). */
function errorBox(text) {
  return text ? html`<div class="alert alert-error bz-alert" role="alert">${icon('alert')}<span>${text}</span></div>` : '';
}

/** The primary actions of a page (Review trip, Request Approval, Approve): sticky at the bottom on phones. */
function actionBar(body) {
  return html`<div class="bz-actionbar">${body}</div>`;
}

/**
 * A page's heading block: the one h1, an optional line under it, and optional actions beside it.
 * @param {{ title: string, sub?: *, actions?: * }} h sub and actions: text or markup from html``
 */
function pageHead({ title, sub = '', actions = '' }) {
  return html`<div class="bz-page-head"><div class="bz-page-titles"><h1>${title}</h1>${sub ? html`<p class="bz-page-sub">${sub}</p>` : ''}</div>${actions ? html`<div class="bz-page-actions">${actions}</div>` : ''}</div>`;
}

/**
 * Tabs that are links (Mine · Team · Company; Waiting for you (3) · Decided by you; the policy tiers): the
 * current one is marked with aria-current. A count of 0 shows; null or undefined shows none.
 * @param {Array<{ href: string, label: string, count?: number|null, current?: boolean }>} items
 * @param {{ label: string }} opts the navigation's name for screen readers, e.g. 'Trips'
 */
function tabs(items, { label }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  return html`<nav class="bz-tabs" aria-label="${label}"><ul class="bz-tabs-list">${list.map(t => html`<li><a class="bz-tab" href="${t.href}"${t.current ? raw(' aria-current="page"') : ''}><span>${t.label}</span>${Number.isInteger(t.count) && t.count >= 0 ? html`<span class="bz-tab-count">${String(t.count)}</span>` : ''}</a></li>`)}</ul></nav>`;
}

/** "Older" (or "Show older") paging: a plain link to the next page, or nothing when there is none. */
function pager(href, label = 'Older') {
  return href ? html`<p class="bz-pager"><a class="btn btn-ghost bz-btn" href="${href}">${label} ${icon('arrow')}</a></p>` : '';
}

/**
 * Facts as label and value pairs (Department · Engineering). Values are text or markup from html``.
 * @param {Array<[string, *]>} pairs pairs with an empty value ('' / null / undefined) are left out
 */
function kvList(pairs) {
  const list = (Array.isArray(pairs) ? pairs : []).filter(([, v]) => v !== '' && v !== null && v !== undefined);
  if (!list.length) return '';
  return html`<dl class="bz-kv">${list.map(([k, v]) => html`<div class="bz-kv-row"><dt>${k}</dt><dd>${typeof v === 'number' ? String(v) : v}</dd></div>`)}</dl>`;
}

/**
 * A checklist ticked from data (the welcome page's set-up steps). Each step says whether it is done in
 * words as well as with its icon.
 * @param {Array<{ text: string, done: boolean, href?: string|null }>} items
 */
function checklist(items) {
  return html`<ul class="bz-checklist">${(items || []).map(s => {
    const text = s.href ? html`<a href="${s.href}">${s.text}</a>` : s.text;
    return html`<li class="bz-check${s.done ? ' is-done' : ''}"><span class="bz-check-mark" aria-hidden="true">${s.done ? icon('check') : ''}</span><span class="sr-only">${s.done ? 'Done: ' : 'To do: '}</span><span class="bz-check-text">${text}</span></li>`;
  })}</ul>`;
}

/**
 * A trip's policy verdict in one line, e.g. "Within policy. Confirm and it's approved to book." with its
 * badge. A verdict that quotes an amount ("over your $2,500 trip limit by $310") becomes its own demo
 * container with "Demo price · Priced at …", so it needs pricedAt (a TypeError without one), unless inDemo
 * says the caller's container already labels it.
 * @param {'within'|'out'|'blocked'} status
 * @param {*} text text or markup from html``
 * @param {{ pricedAt?: string|null, timeZone?: string, inDemo?: boolean, source?: string, kind?: string }} [opts]
 */
function verdict(status, text, { pricedAt = null, timeZone = 'UTC', inDemo = false, source = 'demo', kind = 'price' } = {}) {
  const tone = BADGES[status] ? status : 'out';
  const box = html`<div class="bz-verdict bz-verdict-${tone}">${policyBadge(status)}<p class="bz-verdict-text">${text}</p></div>`;
  if (inDemo || !CURRENCY_RE.test(String(text))) return box;
  if (!pricedAt) throw new TypeError('[business] verdict: a verdict with an amount needs pricedAt (or inDemo inside a priced demo container)');
  return demoBox(box, { pricedAt, timeZone, cls: 'bz-verdict-box', source, kind });
}

/**
 * Rows outside the traveler's policy, behind "Show 4 options outside your policy" (§E4). Open for ?all=1;
 * /js/business.js keeps ?all=1 in the address while it is open. Nothing when there are none.
 * @param {number} count how many options it holds
 * @param {*} body the rows (markup from html``)
 * @param {{ open?: boolean }} [opts]
 */
function outsideToggle(count, body, { open = false } = {}) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (!n) return '';
  return html`<details class="bz-outside" data-outside${open ? raw(' open') : ''}><summary class="bz-outside-sum">${icon('alert')}<span>Show ${plural(n, 'option')} outside your policy</span></summary><div class="bz-outside-body">${body}</div></details>`;
}

/**
 * A link to copy (the invite link page, §B6): a read-only field with its label, and a "Copy link" button that
 * /js/business.js shows and wires up (without JavaScript the field is selected by hand).
 * @param {{ id: string, value: string, label?: string }} c
 */
function copyLink({ id, value, label = 'Invite link' }) {
  return html`<div class="bz-copy">
    <label class="bz-copy-label" for="${id}">${label}</label>
    <div class="bz-copy-row"><input class="bz-copy-input" id="${id}" type="text" value="${value}" readonly spellcheck="false" autocomplete="off"><button class="btn btn-navy bz-btn" type="button" data-copy="${id}" hidden>Copy link</button></div>
    <p class="bz-copy-status" data-copy-status role="status"></p>
  </div>`;
}

/**
 * The hint under a field with a length rule ("Why does this trip need an exception?"): it states the rule,
 * and /js/business.js turns it into a live count for the field that has data-count="<id>".
 * @param {string} id
 * @param {{ min?: number, max: number }} rule
 */
function charCount(id, { min = 0, max }) {
  const text = min ? `Write ${min} to ${max} characters.` : `Up to ${max} characters.`;
  return html`<p class="field-hint bz-charcount" id="${id}" aria-live="polite">${text}</p>`;
}

/**
 * A department's budget as a bar (§H4, §H5): committed, then awaiting approval, out of the budget. An SVG
 * with width attributes, so it needs no style attribute (CSP). It prints no amount: the page writes the
 * numbers beside it in text, inside a demo container. Nothing when there is no budget to measure against.
 * Widths are in tenths of a percent, rounded down, and never pass the end of the bar; `is-over` marks a
 * department whose commitments are over its budget, `is-full` one that would be with what awaits approval.
 * @param {{ amountCents: number|null, committedCents: number, awaitingCents?: number }} b
 */
function budgetBar({ amountCents, committedCents, awaitingCents = 0 }) {
  const budget = Number(amountCents);
  if (!Number.isFinite(budget) || budget <= 0) return '';
  const part = c => Math.max(0, Math.floor((Math.max(0, Number(c) || 0) * 1000) / budget));
  const committed = Math.min(1000, part(committedCents));
  const awaiting = Math.min(1000 - committed, part(awaitingCents));
  const over = (Number(committedCents) || 0) > budget;
  const full = !over && (Number(committedCents) || 0) + (Number(awaitingCents) || 0) > budget;
  return html`<svg class="bz-bar${over ? ' is-over' : full ? ' is-full' : ''}" viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="bz-bar-track" width="1000" height="12"/>${committed ? html`<rect class="bz-bar-committed" width="${String(committed)}" height="12"/>` : ''}${awaiting ? html`<rect class="bz-bar-awaiting" x="${String(committed)}" width="${String(awaiting)}" height="12"/>` : ''}</svg>`;
}

module.exports = {
  money, amount, checkedAt, stars, heading,
  priceNote, demoPrice, demoBox, demoBanner, supplierPanel, linesTable, termsList, comingSoon,
  policyBadge, statusPill, violationList, limitsBar, rowCard, altCard, alternativesPanel,
  dataTable, emptyState, notice, errorBox, actionBar,
  pageHead, tabs, pager, kvList, checklist, verdict, outsideToggle, copyLink, charCount, budgetBar,
  DEMO_RIBBON, NO_SUPPLIER, NO_TRIPS, BADGES, PILLS, CHEAPEST_WITHIN_LABEL, PIN_BADGE, ALT_HEADING, ALT_SUB, ALT_TRUNCATED, ALT_NONE,
  UNAVAILABLE,
  // Price sources (real-suppliers design §2.3)
  SANDBOX_RIBBON, LIVE_RIBBON, APPROVED_PILLS, ALT_SUBS, LIMIT_CHIPS, LIMITS_NOTES, LIMITS_CHECKED, limitsNote, fromSearch, NO_STARS, UNAVAILABLE_BY_SOURCE, unavailableText, paidAtHotel, tripSource,
  // Live prices (go-live design §5.5, §5.6)
  AWAITING_CONFIRMATION, confirmPanel,
};
