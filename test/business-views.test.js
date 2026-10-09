// The Tripelyx Business view layer (plan §B3, §B6, §E4, §F6, §F7, §G3): views/business/format.js (money,
// dates and times in the company's zone), parts.js (the shared parts every workspace page builds on) and
// shell.js (the workspace document). Pure renders over the fakes' rows: no app, no store.
//
// The demo rule is checked on the markup itself: every <span class="bz-money"> sits inside an element marked
// data-price-source="demo" whose text says "Demo price" and "Priced at".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { html } = require('../server/lib/html');
const { icon } = require('../server/views/icons');
const f = require('../server/views/business/format');
const parts = require('../server/views/business/parts');
const { shellView, pendingRibbon, PREVIEW_RIBBON, NAV_ICONS } = require('../server/views/business/shell');
const { navFor, NAV } = require('../server/business/http');
const { LABELS } = require('../server/business/roles');
const { fakeInventory, fakePolicy } = require('./business-fakes');

const FIXED_NOW = '2026-10-09T09:00:00.000Z';
const PRICED = '2026-10-09T12:42:00.000Z';
const TZ = 'Africa/Cairo';
const NOTE = 'Demo price · Priced at 3:42 PM, Fri 9 Oct (Cairo time)';
const FLIGHT_Q = { leg: 'out', from: 'CAI', to: 'LHR', date: '2026-11-12', cabin: 'economy' };
const HOTEL_Q = { city: 'London', country: 'United Kingdom', checkIn: '2026-11-12', checkOut: '2026-11-16' };
const EVAL_CTX = { orgName: 'Acme Inc', carriers: {}, outOfPolicy: 'approval' };

// The same list as test/experience-pages.test.js.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Every element of the markup with its parent and where its content ends (a small tag-stack walker). */
function elements(markup) {
  const all = [], stack = [];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const [whole, close, name, attrs] = m;
    const tag = name.toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        for (const el of stack.splice(i)) el.end = m.index;
        break;
      }
      continue;
    }
    const el = { tag, attrs, start: m.index, inner: m.index + whole.length, end: markup.length, parent: stack[stack.length - 1] || null };
    all.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push(el);
  }
  return all;
}
const textOf = s => String(s).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const hasClass = (el, cls) => new RegExp(`\\bclass="[^"]*\\b${cls}\\b`).test(el.attrs);

/** An amount written in text: "$86", "$ 1,240", "−$50", "€20". */
const TEXT_AMOUNT = /[$€£¥]\s?\d/;

/**
 * The demo rule (§F6): each .bz-money, and each amount written as plain text anywhere (a reason, a verdict, a
 * table cell, a fact), has an ancestor marked data-price-source="demo" that says "Demo price" and, when
 * `priced`, "Priced at". Returns how many .bz-money amounts it checked.
 */
function assertDemoMoney(markup, { priced = true, label = '' } = {}) {
  const s = String(markup);
  const all = elements(s);
  const check = (el, what) => {
    let box = el;
    while (box && !/\bdata-price-source="demo"/.test(box.attrs)) box = box.parent;
    assert.ok(box, `${label}: ${what} sits in a demo container`);
    const text = textOf(s.slice(box.inner, box.end));
    assert.ok(text.includes('Demo price'), `${label}: the container of ${what} says Demo price: ${text.slice(0, 160)}`);
    if (priced) assert.ok(text.includes('Priced at'), `${label}: the container of ${what} says Priced at: ${text.slice(0, 160)}`);
  };
  let n = 0;
  for (const el of all) {
    if (!hasClass(el, 'bz-money')) continue;
    n += 1;
    check(el.parent, s.slice(el.start, el.start + 80));
  }
  // Amounts in text nodes: the innermost element around each one must sit in a demo container too.
  for (const m of s.matchAll(/>([^<]+)</g)) {
    const text = textOf(m[1]);
    if (!TEXT_AMOUNT.test(text)) continue;
    const at = m.index + 1;
    const owner = all.filter(el => !VOID.has(el.tag) && !/\/\s*$/.test(el.attrs) && el.inner <= at && at < el.end)
      .reduce((a, el) => (!a || el.inner > a.inner ? el : a), null);
    check(owner, `"${text.slice(0, 60)}"`);
  }
  return n;
}

function assertNoInline(markup, label) {
  const s = String(markup);
  assert.doesNotMatch(s, /\sstyle=/, `${label}: no inline style`);
  assert.doesNotMatch(s, /<style\b/, `${label}: no <style>`);
  assert.doesNotMatch(s, /<script(?![^>]*\bsrc=)[^>]*>/, `${label}: no inline script`);
  assert.doesNotMatch(s, /\son[a-z]+\s*=/i, `${label}: no on* handlers`);
  assert.doesNotMatch(textOf(s), /—/, `${label}: no em dash`);
}

/** Every visible form control has a label (label[for] or aria-label), and every label[for] names a control. */
function assertLabelled(markup, label) {
  const s = String(markup);
  const fors = [...s.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map(m => m[1]);
  const ids = new Set([...s.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(m => m[1]));
  for (const f of fors) assert.ok(ids.has(f), `${label}: label for="${f}" names a control`);
  let n = 0;
  for (const m of s.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    if (/\btype="(?:hidden|submit|button)"/.test(m[2])) continue;
    n += 1;
    const id = (m[2].match(/\bid="([^"]+)"/) || [])[1];
    assert.ok((id && fors.includes(id)) || /\baria-label(?:ledby)?="[^"]+"/.test(m[2]), `${label}: <${m[1]}${m[2].slice(0, 80)}> has a label`);
  }
  return n;
}

/** One h1, first; no heading level skipped on the way down. */
function assertHeadingOrder(markup, label) {
  const levels = [...String(markup).matchAll(/<h([1-6])\b/g)].map(m => Number(m[1]));
  assert.equal(levels[0], 1, `${label}: starts with the h1`);
  assert.equal(levels.filter(l => l === 1).length, 1, `${label}: one h1`);
  levels.forEach((l, i) => assert.ok(!i || l <= levels[i - 1] + 1, `${label}: h${levels[i - 1]} then h${l} skips a level`));
  return levels;
}

function searchRows() {
  const inv = fakeInventory();
  const pol = fakePolicy();
  const ev = row => ({ row, evaluation: pol.evaluateComponent(row, EVAL_CTX) });
  const flights = inv.peekFlightRows(FLIGHT_Q, PRICED).map(ev);
  const hotels = inv.peekHotelRows(HOTEL_Q, PRICED).map(ev);
  const group = (rows, offerId) => rows.filter(r => r.row.offerId === offerId);
  const offers = rows => [...new Set(rows.map(r => r.row.offerId))].map(id => group(rows, id));
  return { flights, hotels, flightGroups: offers(flights), hotelGroups: offers(hotels) };
}

function sampleAlts(flights) {
  const pick = flights.find(r => r.row.key.endsWith('_1|FLEX'));
  const cheaper = flights.filter(r => r.row.available && r.evaluation.status === 'within' && r.row.totalCents < pick.row.totalCents).slice(0, 3);
  return cheaper.map((r, i) => ({
    id: `alt${i}0123456789ab`, kind: i ? 'flight' : 'fare', label: i ? 'Another flight the same day' : 'Same flight, Classic fare', change: {},
    selection: { out: r.row.key, back: null, hotel: null }, query: {}, rows: { out: r.row, back: null, hotel: null },
    totalCents: r.row.totalCents, savesCents: pick.row.totalCents - r.row.totalCents,
    evaluation: { status: r.evaluation.status, violations: r.evaluation.violations, components: {}, totalCents: r.row.totalCents },
    giveUps: ['No free changes'], note: 'Same flight with the Classic fare.',
  }));
}

const LIMITS = {
  heading: 'Your limits for this search (Standard policy, v3)',
  items: [
    { key: 'flight.short', text: 'Flights under 6 hours: Economy, up to', cents: 71200, suffix: 'each way' },
    { key: 'flight.advance', text: 'Plan 7 days ahead', cents: null, suffix: '' },
    { key: 'hotel.priceToBeat', text: 'Price to Beat:', cents: 26400, suffix: 'a night' },
  ],
};

// ---------------------------------------------------------------------------------------------------------
// format.js

test('format: zones, money, percentages, durations and travel dates', () => {
  assert.equal(f.safeZone('Africa/Cairo'), 'Africa/Cairo');
  assert.equal(f.safeZone('Not/AZone'), 'UTC');
  assert.equal(f.safeZone(undefined), 'UTC');
  assert.equal(f.zoneLabel('Africa/Cairo'), 'Cairo time');
  assert.equal(f.zoneLabel('America/Los_Angeles'), 'Los Angeles time');
  assert.equal(f.zoneLabel('UTC'), 'UTC');
  assert.equal(f.zoneLabel('Not/AZone'), 'UTC', 'an unknown zone reads as UTC, never throws');

  assert.equal(f.money(84250), '$842.50');
  assert.equal(f.money(120000), '$1,200');
  assert.equal(f.money(0), '$0');
  assert.equal(f.money(-5000), '−$50', 'a real minus sign');
  assert.equal(f.plural(1, 'night'), '1 night');
  assert.equal(f.plural(3, 'night'), '3 nights');
  assert.equal(f.percent(200), '20%');
  assert.equal(f.percent(125), '12.5%');
  assert.equal(f.duration(304), '5h 04m');
  assert.equal(f.duration(120), '2h');
  assert.equal(f.duration(45), '45m');

  assert.equal(f.day('2026-11-12'), 'Thu 12 Nov');
  assert.equal(f.day('2026-11-12', { year: true }), 'Thu 12 Nov 2026');
  assert.equal(f.day('2026-02-30'), '2026-02-30', 'not a real date: as given');
  assert.equal(f.day('soon'), 'soon');
  assert.equal(f.dayRange('2026-11-12', '2026-11-16'), 'Thu 12 Nov to Mon 16 Nov');
  assert.equal(f.dayRange('2026-11-12', null), 'Thu 12 Nov');
  assert.equal(f.clock24('2026-11-12T08:35'), '08:35');
  assert.equal(f.clock24('nope'), '');
});

test('format: money and percent take whole numbers only, so a missing amount never prints as "$0" or "0%"', () => {
  for (const bad of [null, undefined, NaN, Infinity, '1234', '', 12.5, 2 ** 53, {}, true]) {
    assert.throws(() => f.money(bad), TypeError, `money(${String(bad)})`);
    assert.throws(() => f.percent(bad), TypeError, `percent(${String(bad)})`);
  }
  assert.equal(f.money(0), '$0', 'a real zero still prints');
  assert.equal(f.money(-0), '$0', 'never "-$0"');
  assert.equal(f.money(-15050), '−$150.50');
  assert.equal(f.percent(0), '0%');
  assert.equal(f.percent(-125), '-12.5%');
});

test('format: times read in the company zone on a 12-hour clock, named, with no narrow spaces', () => {
  // Cairo is UTC+3 on 9 Oct 2026 and UTC+2 on 31 Dec.
  assert.equal(f.timeIn(TZ, PRICED), '3:42 PM');
  assert.equal(f.timeIn(TZ, FIXED_NOW), '12:00 PM');
  assert.equal(f.timeIn(TZ, '2026-10-08T21:05:00.000Z'), '12:05 AM');
  assert.equal(f.dateTimeIn(TZ, PRICED), '3:42 PM, Fri 9 Oct (Cairo time)');
  assert.equal(f.dateTimeIn(TZ, '2026-12-31T22:30:00.000Z', { year: true }), '12:30 AM, Fri 1 Jan 2027 (Cairo time)', 'the local date, not the UTC one');
  assert.equal(f.dateTimeIn('UTC', '2026-12-31T22:30:00.000Z', { zone: false }), '10:30 PM, Thu 31 Dec');
  assert.equal(f.dateTimeIn('Bogus/Zone', PRICED), '12:42 PM, Fri 9 Oct (UTC)');
  assert.equal(parts.checkedAt(PRICED, TZ), '3:42 PM, Fri 9 Oct (Cairo time)');
  for (const s of [f.timeIn(TZ, PRICED), f.dateTimeIn(TZ, PRICED)]) assert.doesNotMatch(s, /[  ]/);

  assert.equal(f.pricedAtText(PRICED, TZ), NOTE);
  assert.equal(f.pricedAtText(null, TZ), 'Demo price');

  // whenIn: today, tomorrow and yesterday are the company's days.
  assert.equal(f.whenIn(TZ, '2026-10-09T13:10:00.000Z', { now: FIXED_NOW }), '4:10 PM today');
  assert.equal(f.whenIn(TZ, '2026-10-10T13:10:00.000Z', { now: FIXED_NOW }), '4:10 PM tomorrow');
  assert.equal(f.whenIn(TZ, '2026-10-08T13:10:00.000Z', { now: FIXED_NOW, zone: true }), '4:10 PM yesterday (Cairo time)');
  assert.equal(f.whenIn(TZ, '2026-10-12T13:10:00.000Z', { now: FIXED_NOW }), '4:10 PM, Mon 12 Oct');
  // 21:30 UTC is already the 10th in Cairo while "now" (20:00 UTC) is still the 9th there.
  assert.equal(f.whenIn(TZ, '2026-10-09T21:30:00.000Z', { now: '2026-10-09T20:00:00.000Z' }), '12:30 AM tomorrow');
  assert.equal(f.whenIn('UTC', '2026-10-09T21:30:00.000Z', { now: '2026-10-09T20:00:00.000Z' }), '9:30 PM today');
});

test('format: timeLeft rounds down and is null once the moment has passed', () => {
  const at = ms => new Date(Date.parse(FIXED_NOW) + ms).toISOString();
  const MIN = 60000, H = 60 * MIN, D = 24 * H;
  assert.equal(f.timeLeft(FIXED_NOW, at(30 * 1000)), 'under 1 min');
  assert.equal(f.timeLeft(FIXED_NOW, at(MIN)), '1 min');
  assert.equal(f.timeLeft(FIXED_NOW, at(45 * MIN + 59 * 1000)), '45 min');
  assert.equal(f.timeLeft(FIXED_NOW, at(H + 59 * MIN)), '1 h');
  assert.equal(f.timeLeft(FIXED_NOW, at(2 * D - MIN)), '47 h');
  assert.equal(f.timeLeft(FIXED_NOW, at(2 * D)), '2 days');
  assert.equal(f.timeLeft(FIXED_NOW, at(3 * D - 1)), '2 days');
  assert.equal(f.timeLeft(FIXED_NOW, at(D)), '24 h');
  assert.equal(f.timeLeft(FIXED_NOW, FIXED_NOW), null);
  assert.equal(f.timeLeft(FIXED_NOW, at(-MIN)), null);
  assert.equal(f.timeLeft(FIXED_NOW, 'nonsense'), null);
});

// ---------------------------------------------------------------------------------------------------------
// parts.js

test('the demo rule: every amount every part prints sits in a demo container that says when it was priced', () => {
  const { flightGroups, hotelGroups, flights } = searchRows();
  const alts = sampleAlts(flights);
  const pick = flights.find(r => r.row.key.endsWith('_1|FLEX'));
  const opts = { pricedAt: PRICED, timeZone: TZ };
  const pieces = {
    demoPrice: parts.demoPrice(84200, opts),
    demoBox: parts.demoBox(html`<p>Total ${parts.amount(84200)}</p>`, opts),
    demoBoxSection: parts.demoBox(html`<p>${parts.amount(100)}</p>`, { ...opts, tag: 'section', label: 'Totals' }),
    linesTable: parts.linesTable(pick.row.lines, opts),
    limitsBar: parts.limitsBar(LIMITS, opts),
    flightCards: html`${flightGroups.map(g => parts.rowCard(g, { timeZone: TZ, input: { name: 'out', checked: g[0].row.key } }))}`,
    hotelCards: html`${hotelGroups.map(g => parts.rowCard(g, { timeZone: TZ, input: { name: 'hotelKey' }, priceToBeatCents: 30000 }))}`,
    staticCard: parts.rowCard(pick, { timeZone: TZ }),
    altCard: parts.altCard(alts[0], { timeZone: TZ, action: '/swap', rev: 2 }),
    alternativesPanel: parts.alternativesPanel({ alternatives: alts, cheapestWithin: alts[1], truncated: true }, { timeZone: TZ, action: '/swap', rev: 2 }),
    table: parts.demoBox(parts.dataTable({ caption: 'Trips', columns: [{ label: 'Trip' }, { label: 'Total', num: true }], rows: [['CAI to LHR', parts.amount(84200)]] }), opts),
  };
  for (const [name, markup] of Object.entries(pieces)) {
    assert.ok(assertDemoMoney(markup, { label: name }) > 0, `${name} prints at least one amount`);
    assertNoInline(markup, name);
    assert.ok(String(markup).includes(NOTE), `${name} shows "${NOTE}"`);
  }
  // All together on one page, too.
  assertDemoMoney(html`${Object.values(pieces)}`, { label: 'all' });

  // The checker itself catches a bare amount, also one written as text, and a label without "Priced at".
  assert.throws(() => assertDemoMoney(html`<p>${parts.amount(100)}</p>`), /demo container/);
  assert.throws(() => assertDemoMoney(html`<div><p>Over by $86</p></div>`), /"Over by \$86" sits in a demo container/);
  assert.throws(() => assertDemoMoney(html`<td><span class="bz-cell-value">−$50</span></td>`), /demo container/);
  assert.throws(() => assertDemoMoney(html`<div data-price-source="demo"><p>Over by $86</p><p>Demo price</p></div>`), /says Priced at/);
  assert.equal(assertDemoMoney(html`<div data-price-source="demo"><input name="x"><p>Over by $86</p><p>${NOTE}</p></div>`), 0, 'a text amount in a labelled container passes');
  assert.equal(assertDemoMoney(html`<p>Plan 7 days ahead. Q4 2026. 20% over.</p>`), 0, 'digits without a currency sign are not amounts');
  // Without a priced-at time the label still says Demo price.
  assert.match(String(parts.demoPrice(500, { pricedAt: null, timeZone: TZ })), /<span class="bz-demo-price" data-price-source="demo"><span class="bz-money">\$5<\/span> <span class="bz-price-note">Demo price<\/span><\/span>/);
  assert.equal(assertDemoMoney(parts.demoPrice(500, { pricedAt: null, timeZone: TZ }), { priced: false }), 1);
  // demoBox only takes the block tags it knows.
  assert.match(String(parts.demoBox('x', { ...opts, tag: 'script' })), /^<div class="bz-demo-box" data-price-source="demo">/);
});

test('linesTable: every line and a total that is their sum; inDemo leaves out its own container', () => {
  const lines = [{ label: 'Fare', kind: 'base', cents: 62000 }, { label: 'Taxes and charges', kind: 'tax', cents: 4200 }, { label: 'Corporate discount', kind: 'discount', cents: -1000 }];
  const s = String(parts.linesTable(lines, { pricedAt: PRICED, timeZone: TZ }));
  assert.deepEqual([...s.matchAll(/<dt>([^<]*)<\/dt><dd><span class="bz-money">([^<]*)<\/span><\/dd>/g)].map(m => [m[1], m[2]]),
    [['Fare', '$620'], ['Taxes and charges', '$42'], ['Corporate discount', '−$10'], ['Total', '$652']]);
  assert.match(s, /<div class="bz-line is-discount">/);
  assert.match(s, /^<div class="bz-demo-box bz-lines-box" data-price-source="demo">/);
  const bare = String(parts.linesTable(lines, { inDemo: true, totalLabel: 'Trip total' }));
  assert.doesNotMatch(bare, /data-price-source/);
  assert.match(bare, /<dt>Trip total<\/dt>/);
});

test('a missing amount is never a priced "$0": demoPrice prints nothing, amount and linesTable refuse it', () => {
  const opts = { pricedAt: PRICED, timeZone: TZ };
  // No amount (a budget that isn't set, a recheck with no new total): nothing to label, nothing printed.
  assert.equal(parts.demoPrice(null, opts), '');
  assert.equal(parts.demoPrice(undefined, opts), '');
  // Anything else that is not whole cents is a bug in the page: it fails loudly instead of reading "$0".
  for (const bad of ['abc', '100', NaN, 12.5]) {
    assert.throws(() => parts.demoPrice(bad, opts), TypeError, String(bad));
    assert.throws(() => parts.amount(bad), TypeError, String(bad));
  }
  assert.throws(() => parts.amount(undefined), TypeError);
  assert.throws(() => parts.amount(null), TypeError);
  assert.throws(() => parts.linesTable([{ label: 'Fare', kind: 'base' }], opts), TypeError, 'a line without cents');
  assert.throws(() => parts.linesTable([{ label: 'Fare', kind: 'base', cents: 62000 }, { label: 'Taxes', kind: 'tax', cents: '4200' }], opts), TypeError);
  assert.throws(() => parts.limitsBar({ heading: 'x', items: [{ key: 'k', text: 'Up to', cents: 'x', suffix: '' }] }, opts), TypeError);
  // A real zero is still a price.
  assert.match(String(parts.demoPrice(0, opts)), /<span class="bz-money">\$0<\/span>/);
});

test('policy badges and status pills: text and an icon for every state, escaped when unknown', () => {
  const expect = { within: ['Within Policy', 'check'], out: ['Out of Policy', 'alert'], blocked: ['Blocked by policy', 'lock'] };
  for (const [status, [label, iconName]] of Object.entries(expect)) {
    const s = String(parts.policyBadge(status));
    assert.match(s, new RegExp(`^<span class="bz-badge bz-badge-${status}"><svg[^>]*><use href="#i-${iconName}"/></svg><span>${label}</span></span>$`), s);
  }
  assert.equal(parts.policyBadge('maybe'), '');
  assert.equal(parts.policyBadge(undefined), '');

  const request = { draft: 'Draft', pending: 'Waiting for approval', approved: 'Approved to book', denied: 'Denied', cancelled: 'Cancelled', expired: 'Expired', past: 'Past trip' };
  for (const [status, label] of Object.entries(request)) assert.match(String(parts.statusPill(status)), new RegExp(`^<span class="bz-pill bz-pill-\\w+">${label}</span>$`));
  const org = { pending: 'Waiting for confirmation', active: 'Active', suspended: 'Paused' };
  for (const [status, label] of Object.entries(org)) assert.match(String(parts.statusPill(status, { kind: 'org' })), new RegExp(`>${label}</span>$`));
  assert.match(String(parts.statusPill('removed', { kind: 'member' })), />Removed<\/span>$/);
  assert.equal(String(parts.statusPill('<b>odd</b>')), '<span class="bz-pill bz-pill-neutral">&lt;b&gt;odd&lt;/b&gt;</span>');
  assert.match(String(parts.statusPill('approved')), /bz-pill-good/);
  assert.match(String(parts.statusPill('pending')), /bz-pill-warn/);
  assert.match(String(parts.statusPill('denied')), /bz-pill-bad/);
});

test('violationList: reasons with icons, "+N more" when collapsed, a demo container only when a reason holds an amount', () => {
  const v = [
    { rule: 'flight.cap', severity: 'approval', text: '$62 over the limit of $600.' },
    { rule: 'flight.carrier', severity: 'block', text: 'Sahara Wings isn\'t used by <Acme>.' },
    { rule: 'flight.cabin', severity: 'approval', text: 'Business is above Economy.' },
  ];
  const all = String(parts.violationList(v, { pricedAt: PRICED, timeZone: TZ }));
  assert.match(all, /^<div class="bz-demo-box bz-reasons-box" data-price-source="demo">/, 'an amount in a reason: its own demo container');
  assert.ok(all.includes(NOTE));
  assert.equal((all.match(/<li class="bz-reason/g) || []).length, 3);
  assert.match(all, /<li class="bz-reason is-block"><svg[^>]*><use href="#i-lock"\/><\/svg><span>Sahara Wings isn&#39;t used by &lt;Acme&gt;\.<\/span><\/li>/);

  const collapsed = String(parts.violationList(v, { collapse: true, inDemo: true }));
  assert.doesNotMatch(collapsed, /data-price-source/, 'inDemo: the caller labels it');
  assert.match(collapsed, /^<div class="bz-reasons-wrap"><ul class="bz-reasons"><li class="bz-reason">[\s\S]*?\$62 over the limit of \$600\.<\/span><\/li><\/ul><details class="bz-reasons-more"><summary>\+2 more<\/summary>/);
  const one = String(parts.violationList(v.slice(2), { collapse: true }));
  assert.doesNotMatch(one, /details/, 'one reason: nothing to collapse');
  assert.doesNotMatch(one, /data-price-source/, 'no amount: no demo label');
  assert.equal(parts.violationList([]), '');
  assert.equal(parts.violationList(null), '');

  // A reason with an amount, outside a demo container, needs its priced-at time: "Demo price" alone is not
  // the label (§F6), so the part refuses rather than print an amount without one.
  assert.throws(() => parts.violationList([{ text: 'Over your $712 limit by $86' }], { timeZone: TZ }), TypeError);
  assert.throws(() => parts.violationList([{ text: 'Over your $712 limit by $86' }], { timeZone: TZ, pricedAt: null }), TypeError);
  assert.equal(assertDemoMoney(parts.violationList(v, { pricedAt: PRICED, timeZone: TZ })), 0, 'its text amounts sit in a priced container');
  // No amount: no time needed.
  assert.doesNotMatch(String(parts.violationList(v.slice(2), { timeZone: TZ })), /data-price-source/);
});

test('verdict: a verdict that quotes an amount gets its own priced demo container', () => {
  const plain = String(parts.verdict('within', "Within policy. Confirm and it's approved to book."));
  assert.match(plain, /^<div class="bz-verdict bz-verdict-within">/, 'no amount: just the verdict');
  const priced = String(parts.verdict('out', 'Over your trip limit by $310', { pricedAt: PRICED, timeZone: TZ }));
  assert.match(priced, /^<div class="bz-demo-box bz-verdict-box" data-price-source="demo"><div class="bz-verdict bz-verdict-out">/);
  assert.ok(priced.includes(NOTE));
  assertDemoMoney(priced, { label: 'verdict' });
  assert.throws(() => parts.verdict('out', 'Over by $86'), TypeError, 'an amount without a priced-at time');
  // Inside a container that already labels it, no second one.
  assert.match(String(parts.verdict('out', 'Over by $86', { inDemo: true })), /^<div class="bz-verdict bz-verdict-out">/);
});

test('rowCard: one card per offer, a radio per option, unavailable and blocked options disabled', () => {
  const { flightGroups, hotelGroups } = searchRows();
  const page = String(html`${flightGroups.map(g => parts.rowCard(g, { timeZone: TZ, input: { name: 'out', checked: g[g.length - 1].row.key, required: true } }))}${hotelGroups.map(g => parts.rowCard(g, { timeZone: TZ, input: { name: 'hotelKey' }, priceToBeatCents: 30000 }))}`);
  assertNoInline(page, 'cards');
  const cards = page.split('<article ').slice(1);
  assert.equal(cards.length, flightGroups.length + hotelGroups.length);
  for (const c of cards) assert.match(c, /^class="bz-card bz-row bz-row-(flight|hotel)" data-price-source="demo" aria-labelledby="bz-row-[0-9a-f]{12}">/);

  // Ids: unique, and every radio has its label.
  const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  const radios = [...page.matchAll(/<input class="bz-opt-radio" type="radio" id="([^"]+)" name="([^"]+)" value="([^"]+)"([^>]*)>/g)];
  assert.equal(radios.length, flightGroups.flat().length + hotelGroups.flat().length);
  for (const [, id] of radios) assert.ok(page.includes(`<label class="bz-opt-label" for="${id}">`), id);

  const all = [...flightGroups.flat(), ...hotelGroups.flat()];
  for (const [, , , value, rest] of radios) {
    const key = value.replace(/&amp;/g, '&');
    const r = all.find(x => x.row.key === key);
    assert.ok(r, key);
    const off = !r.row.available || r.evaluation.status === 'blocked';
    assert.equal(/\sdisabled/.test(rest), off, `${key} disabled: ${off}`);
    // checked only on the asked-for key, never on a disabled option
    const asked = flightGroups.some(g => g[g.length - 1].row.key === key);
    assert.equal(/\schecked/.test(rest), asked && !off, `${key} checked`);
  }
  assert.ok(all.some(r => !r.row.available) && all.some(r => r.evaluation.status === 'blocked'), 'the fakes have both kinds');
  assert.equal((page.match(/<p class="bz-opt-price is-unavailable">Not available in demo data<\/p>/g) || []).length, all.filter(r => !r.row.available).length);
  assert.match(page, /\srequired>/);

  // An option the demo data doesn't have says so once, and is never called "Blocked by policy": the policy
  // engine marks it blocked (inventory.unavailable), but no company rule blocks it.
  const unavailable = all.filter(r => !r.row.available);
  assert.ok(unavailable.every(r => r.evaluation.status === 'blocked' && r.evaluation.violations.some(x => x.rule === 'inventory.unavailable')), 'the engine blocks them');
  for (const r of unavailable) {
    const li = String(parts.rowCard(r, { timeZone: TZ, input: { name: 'out' } })).match(/<li class="bz-opt[\s\S]*<\/li>/)[0];
    assert.match(li, /^<li class="bz-opt is-disabled is-unavailable">/, r.row.key);
    assert.doesNotMatch(li, /Blocked by policy|bz-badge/, `${r.row.key}: no policy badge`);
    assert.equal(textOf(li).match(/Not available in demo data/g).length, 1, `${r.row.key}: said once`);
  }
  // A real policy block (Sahara Wings) keeps its badge and its reason.
  const carrier = all.find(r => r.row.available && r.evaluation.status === 'blocked');
  const blockedLi = String(parts.rowCard(carrier, { timeZone: TZ, input: { name: 'out' } }));
  assert.match(blockedLi, /<li class="bz-opt is-disabled is-blocked">/);
  assert.match(blockedLi, /<span class="bz-badge bz-badge-blocked">[\s\S]*?<span>Blocked by policy<\/span><\/span>/);
  assert.match(blockedLi, /<li class="bz-reason is-block">/);
  // Another reason on an unavailable option stays; only the duplicate "not available" one goes.
  const other = { ...unavailable[0], evaluation: { status: 'blocked', violations: [...unavailable[0].evaluation.violations, { rule: 'flight.cabin', severity: 'approval', text: 'Business class is above your limit.' }] } };
  const otherLi = textOf(parts.rowCard(other, { timeZone: TZ }));
  assert.ok(otherLi.includes('Business class is above your limit.'));
  assert.doesNotMatch(otherLi, /Not available in demo data\./);

  // The overnight flight says +1; a nonstop says Nonstop; the times are the airports' own, 24-hour.
  assert.match(page, /22:10 <span aria-hidden="true">→<\/span><span class="sr-only"> to <\/span> 08:35<sup class="bz-plus" title="1 day later">\+1<\/sup>/);
  assert.match(page, /<p class="bz-row-meta">Nonstop · 5h · [^<]* · ZM102 · Economy<\/p>/);
  assert.match(page, /<p class="bz-row-sub">Cairo \(CAI\) to London \(LHR\)<\/p>/);
  // Hotels: dates, nights, class, nightly price with taxes, and the Price to Beat line under it.
  assert.match(page, /Hotel · Thu 12 Nov to Mon 16 Nov · 4 nights/);
  assert.match(page, /<p class="bz-row-sub">3-star · [^<]*London<\/p>/);
  assert.match(page, /<p class="bz-opt-nightly"><span class="bz-money">\$199\.50<\/span> a night with taxes<\/p>/);
  assert.match(page, /<p class="bz-opt-beat"><svg[\s\S]*?<\/svg><span><span class="bz-money">\$100\.50<\/span> a night under the Price to Beat<\/span><\/p>/);
  // Price details: the lines and their total.
  const light = flightGroups[0][0].row;
  assert.ok(page.includes(`<details class="bz-more"><summary>Price details</summary><dl class="bz-lines">`));
  assert.ok(page.includes(`<dt>Total</dt><dd><span class="bz-money">${f.money(light.totalCents)}</span></dd>`));
  // No rating, review, provider or internal figure.
  assert.doesNotMatch(textOf(page), /rating|review|provider|net rate|commission|markup|Fake/i);
});

test('rowCard escapes what the rows carry and renders without a form', () => {
  const { hotelGroups } = searchRows();
  const odd = hotelGroups[0].map(r => ({ ...r, row: { ...r.row, name: '<img src=x>Hotel "Q"', area: 'Soho & Co' } }));
  const s = String(parts.rowCard(odd, { timeZone: TZ }));
  assert.ok(s.includes('&lt;img src=x&gt;Hotel &quot;Q&quot;'));
  assert.ok(s.includes('Soho &amp; Co'));
  assert.doesNotMatch(s, /<img|<input/);
  assert.match(s, /<div class="bz-opt-label">/);
  assert.equal(parts.rowCard([], { timeZone: TZ }), '');
  assert.equal(parts.stars(undefined), '');
  assert.equal(parts.stars(4), '4-star');
});

test('rowCard: a hotel\'s nightly rate and its Price to Beat saving are on the same basis as the policy', () => {
  const { hotels } = searchRows();
  // Fixture London STD: $375 a night room only, $427.50 with taxes. A Price to Beat of $401.25 sits between.
  const std = hotels.find(r => r.row.key === 'h.htl_fake_LHR_1|STD');
  assert.deepEqual([std.row.nightlyCents, std.row.nightlyInclCents], [37500, 42750]);
  const line = (s, cls) => { const m = String(s).match(new RegExp(`<p class="${cls}">([\\s\\S]*?)</p>`)); return m ? textOf(m[1]) : null; };

  const excl = parts.rowCard(std, { timeZone: TZ, priceToBeatCents: 40125, basis: 'excl_taxes' });
  assert.equal(line(excl, 'bz-opt-nightly'), '$375 a night before taxes', 'the room-only rate the policy compares');
  assert.equal(line(excl, 'bz-opt-beat'), '$26.25 a night under the Price to Beat', '$375 + $26.25 = $401.25');
  assert.doesNotMatch(String(excl), /a night with taxes/);

  const incl = parts.rowCard(std, { timeZone: TZ, priceToBeatCents: 40125, basis: 'incl_taxes' });
  assert.equal(line(incl, 'bz-opt-nightly'), '$427.50 a night with taxes');
  assert.equal(line(incl, 'bz-opt-beat'), null, 'over the Price to Beat with taxes: no saving claimed');
  const under = parts.rowCard(std, { timeZone: TZ, priceToBeatCents: 45000 });
  assert.equal(line(under, 'bz-opt-beat'), '$22.50 a night under the Price to Beat', 'the default basis is with taxes');
  // At the Price to Beat exactly: nothing "under" it.
  assert.equal(line(parts.rowCard(std, { timeZone: TZ, priceToBeatCents: 37500, basis: 'excl_taxes' }), 'bz-opt-beat'), null);
  for (const s of [excl, incl, under]) assertDemoMoney(s, { label: 'hotel card' });
});

test('altCard and alternativesPanel: saving, new total, give-ups, the swap form, the pinned option first', () => {
  const { flights } = searchRows();
  const alts = sampleAlts(flights);
  assert.ok(alts.length >= 2);
  const card = String(parts.altCard({ ...alts[0], label: '<script>x</script>' }, { timeZone: TZ, action: '/business/o/org_1/trips/btr_1/swap', rev: 4 }));
  assertNoInline(card, 'altCard');
  assert.ok(card.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(card.includes(`<p class="bz-alt-save">Saves <span class="bz-money">${f.money(alts[0].savesCents)}</span> vs your pick (demo price)</p>`));
  assert.ok(card.includes(`<p class="bz-alt-total">New trip total: <span class="bz-money">${f.money(alts[0].totalCents)}</span></p>`));
  assert.match(card, /<p class="bz-alt-give-title">What you give up<\/p><ul><li>No free changes<\/li><\/ul>/);
  assert.match(card, /<form class="bz-alt-form" method="post" action="\/business\/o\/org_1\/trips\/btr_1\/swap">\s*<input type="hidden" name="altId" value="alt00123456789ab">\s*<input type="hidden" name="rev" value="4">\s*<button class="btn btn-navy bz-btn" type="submit">Use this option<\/button>/);
  assert.ok(card.includes(NOTE), 'priced at the alternative\'s outbound row');
  assert.doesNotMatch(String(parts.altCard(alts[0], { timeZone: TZ })), /<form/, 'no action: no form');
  assert.doesNotMatch(card, /bz-alt-pin/);

  const panel = String(parts.alternativesPanel({ alternatives: alts, cheapestWithin: alts[1], truncated: true, summary: 'Two cheaper ways.' }, { timeZone: TZ, action: '/swap', rev: 1 }));
  assert.match(panel, /<h2 class="bz-alts-title" id="bz-alts-title"><svg[\s\S]*?<\/svg><span>AI-powered cheaper alternatives<\/span><\/h2>/);
  assert.ok(panel.includes(parts.ALT_SUB) && panel.includes(parts.ALT_TRUNCATED) && panel.includes('Two cheaper ways.'));
  const order = [...panel.matchAll(/name="altId" value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, [alts[1].id, alts[0].id, ...alts.slice(2).map(a => a.id)], 'the cheapest inside policy first, then the stored order');
  assert.equal((panel.match(/class="bz-card bz-alt is-pinned"/g) || []).length, 1);
  // A pinned card whose heading is not the cheapest-inside-policy label gets the small pin badge.
  assert.ok(panel.includes(`<p class="bz-alt-pin"><svg`) && panel.includes(`<span>${parts.PIN_BADGE}</span>`));
  assert.equal(parts.PIN_BADGE, 'Cheapest inside policy');
  assert.match(panel, /<h3 class="bz-alt-title">/, 'cards one level under the panel');

  // Lead decision on 1P finding 11: buildAlternatives labels the pinned one CHEAPEST_WITHIN_LABEL, so the card says
  // it once, in its heading, with no badge repeating it.
  assert.equal(parts.CHEAPEST_WITHIN_LABEL, require('../server/business/alternatives').CHEAPEST_WITHIN_LABEL);
  const labelled = alts.map((a, i) => (i === 1 ? { ...a, label: parts.CHEAPEST_WITHIN_LABEL } : a));
  const once = String(parts.alternativesPanel({ alternatives: labelled, cheapestWithin: labelled[1] }, { timeZone: TZ }));
  assert.equal(once.split(parts.CHEAPEST_WITHIN_LABEL).length - 1, 1, 'the label is printed once');
  assert.match(once, new RegExp(`<h3 class="bz-alt-title">${parts.CHEAPEST_WITHIN_LABEL}</h3>`));
  assert.doesNotMatch(once, /bz-alt-pin/);
  assert.ok(!once.includes(parts.PIN_BADGE));
  assert.equal((once.match(/class="bz-card bz-alt is-pinned"/g) || []).length, 1, 'still pinned first and marked');

  const none = String(parts.alternativesPanel({ alternatives: [] }, { timeZone: TZ }));
  assert.ok(none.includes(parts.ALT_NONE));
  assert.doesNotMatch(none, /bz-money|bz-alts-note/);
});

test('limitsBar, terms, coming soon, tables, empty states and notices', () => {
  const bar = String(parts.limitsBar(LIMITS, { pricedAt: PRICED, timeZone: TZ }));
  assert.match(bar, /^<section class="bz-limits" data-price-source="demo" aria-labelledby="bz-limits-title">/);
  assert.match(bar, /<li data-limit="flight\.short"><span>Flights under 6 hours: Economy, up to<\/span> <span class="bz-limit-amount"><span class="bz-money">\$712<\/span><span class="bz-chip-demo">Demo price<\/span><\/span> <span>each way<\/span><\/li>/);
  assert.match(bar, /<li data-limit="flight\.advance"><span>Plan 7 days ahead<\/span><\/li>/, 'no amount, no chip');
  assert.equal(parts.limitsBar(null, { timeZone: TZ }), '');

  const terms = String(parts.termsList([{ component: 'Outbound flight', text: '70% refundable.' }, { component: 'Hotel', text: 'Free cancellation.', when: 'Needs verification: the hotel has not stated its cutoff.' }]));
  assert.match(terms, /<li><b>Outbound flight<\/b><span>70% refundable\.<\/span><\/li>/);
  assert.match(terms, /<li class="is-verify"><b>Hotel<\/b>/);

  const soon = String(parts.comingSoon('Spend booked', 'Shows once real bookings exist.', { level: 3 }));
  assert.match(soon, /<h3 class="bz-soon-title">Spend booked<\/h3><span class="bz-soon-chip">Coming soon<\/span>/);
  assert.doesNotMatch(textOf(soon), /\d|\$/, 'never a number');

  const table = String(parts.dataTable({ caption: 'Trips', columns: [{ label: 'Traveler' }, { label: 'Total', num: true }], rows: [['<Sam>', parts.amount(100)]] }));
  assert.match(table, /<caption class="sr-only">Trips<\/caption>/);
  assert.match(table, /<th scope="col">Traveler<\/th><th scope="col" class="is-num">Total<\/th>/);
  assert.match(table, /<td><span class="bz-cell-label">Traveler<\/span><span class="bz-cell-value">&lt;Sam&gt;<\/span><\/td>/);
  assert.equal(String(parts.dataTable({ caption: 'x', columns: [], rows: [], empty: 'No trips yet.' })), '<p class="bz-table-empty">No trips yet.</p>');

  assert.match(String(parts.emptyState({ title: 'No work trips yet.', text: 'Plan one.', action: { href: '/x?a=1&b=2', label: 'Plan a trip' } })), /<p class="bz-empty-title">No work trips yet\.<\/p><p>Plan one\.<\/p><a class="btn btn-navy bz-btn" href="\/x\?a=1&amp;b=2">Plan a trip<\/a>/);
  assert.match(String(parts.notice('Saved.')), /role="status"[\s\S]*<span>Saved\.<\/span>/);
  assert.match(String(parts.errorBox('Nope.')), /role="alert"[\s\S]*<span>Nope\.<\/span>/);
  assert.equal(parts.notice(null), '');
  assert.equal(parts.errorBox(''), '');
  assert.match(String(parts.supplierPanel()), /<h2 class="bz-supplier-title" id="bz-supplier-title">[\s\S]*Supplier not connected yet\./);
  assert.match(String(parts.demoBanner()), /role="note"[\s\S]*Preview: flights, hotels and prices are demo data\. Nothing is booked or charged\. No emails are sent\./);
  assert.match(String(parts.heading(9, html` class="x"`, 'Hi')), /^<h6 class="x">Hi<\/h6>$/);
  assert.match(String(parts.actionBar(html`<button>Go</button>`)), /^<div class="bz-actionbar"><button>Go<\/button><\/div>$/);
});

test('page head, tabs, pager, facts, checklist and verdict', () => {
  const head = String(parts.pageHead({ title: 'Trips', sub: 'Acme <Inc>', actions: html`<a class="btn btn-navy bz-btn" href="/n">Plan a trip</a>` }));
  assert.equal(head, '<div class="bz-page-head"><div class="bz-page-titles"><h1>Trips</h1><p class="bz-page-sub">Acme &lt;Inc&gt;</p></div><div class="bz-page-actions"><a class="btn btn-navy bz-btn" href="/n">Plan a trip</a></div></div>');
  assert.equal(String(parts.pageHead({ title: 'Activity' })), '<div class="bz-page-head"><div class="bz-page-titles"><h1>Activity</h1></div></div>');

  const t = String(parts.tabs([
    { href: '/t?scope=mine', label: 'Mine', current: true },
    { href: '/t?scope=team&x=1', label: 'Team', count: 0 },
    { href: '/t?scope=all', label: 'Company', count: 12 },
  ], { label: 'Trips' }));
  assert.match(t, /^<nav class="bz-tabs" aria-label="Trips"><ul class="bz-tabs-list">/);
  assert.match(t, /<a class="bz-tab" href="\/t\?scope=mine" aria-current="page"><span>Mine<\/span><\/a>/, 'no count: no chip');
  assert.match(t, /<a class="bz-tab" href="\/t\?scope=team&amp;x=1"><span>Team<\/span><span class="bz-tab-count">0<\/span><\/a>/, 'a zero count shows');
  assert.match(t, /<span>Company<\/span><span class="bz-tab-count">12<\/span>/);
  assert.equal((t.match(/aria-current/g) || []).length, 1);
  assert.equal(parts.tabs([], { label: 'x' }), '');

  assert.match(String(parts.pager('/a?cursor=abc&x=1')), /^<p class="bz-pager"><a class="btn btn-ghost bz-btn" href="\/a\?cursor=abc&amp;x=1">Older <svg/);
  assert.match(String(parts.pager('/a', 'Show older')), />Show older </);
  assert.equal(parts.pager(null), '');

  const kv = String(parts.kvList([['Department', 'Engineering'], ['Manager', null], ['Approver', ''], ['Tier', html`<b>Standard</b>`], ['Members', 0]]));
  assert.equal(kv, '<dl class="bz-kv"><div class="bz-kv-row"><dt>Department</dt><dd>Engineering</dd></div><div class="bz-kv-row"><dt>Tier</dt><dd><b>Standard</b></dd></div><div class="bz-kv-row"><dt>Members</dt><dd>0</dd></div></dl>', 'empty values left out, 0 kept');
  assert.equal(parts.kvList([['A', null]]), '');

  const steps = String(parts.checklist([{ text: 'Review your policy', done: true, href: '/p' }, { text: 'Invite your team', done: false }]));
  assert.match(steps, /<li class="bz-check is-done"><span class="bz-check-mark" aria-hidden="true"><svg[\s\S]*?<\/svg><\/span><span class="sr-only">Done: <\/span><span class="bz-check-text"><a href="\/p">Review your policy<\/a><\/span><\/li>/);
  assert.match(steps, /<li class="bz-check"><span class="bz-check-mark" aria-hidden="true"><\/span><span class="sr-only">To do: <\/span><span class="bz-check-text">Invite your team<\/span><\/li>/);

  assert.match(String(parts.verdict('within', "Within policy. Confirm and it's approved to book.")), /^<div class="bz-verdict bz-verdict-within"><span class="bz-badge bz-badge-within">[\s\S]*<p class="bz-verdict-text">Within policy\. Confirm and it&#39;s approved to book\.<\/p><\/div>$/);
  assert.match(String(parts.verdict('blocked', 'x')), /bz-verdict-blocked/);
  assert.match(String(parts.verdict('odd', 'x')), /^<div class="bz-verdict bz-verdict-out"><p/, 'an unknown status: no badge');
});

test('outsideToggle, copyLink and charCount: the markup /js/business.js works on', () => {
  const body = html`<p>rows</p>`;
  const closed = String(parts.outsideToggle(4, body));
  assert.equal(closed, `<details class="bz-outside" data-outside><summary class="bz-outside-sum">${icon('alert')}<span>Show 4 options outside your policy</span></summary><div class="bz-outside-body"><p>rows</p></div></details>`);
  assert.match(String(parts.outsideToggle(1, body, { open: true })), /^<details class="bz-outside" data-outside open><summary[^>]*>[\s\S]*<span>Show 1 option outside your policy<\/span>/);
  for (const n of [0, -1, 1.5, null, undefined, '3']) assert.equal(parts.outsideToggle(n, body), '', String(n));

  const copy = String(parts.copyLink({ id: 'invite-link', value: 'https://www.tripelyx.com/business/invite/a"b<c' }));
  assertNoInline(copy, 'copyLink');
  assert.equal(assertLabelled(copy, 'copyLink'), 1);
  assert.match(copy, /<label class="bz-copy-label" for="invite-link">Invite link<\/label>/);
  assert.match(copy, /<input class="bz-copy-input" id="invite-link" type="text" value="https:\/\/www\.tripelyx\.com\/business\/invite\/a&quot;b&lt;c" readonly spellcheck="false" autocomplete="off">/);
  assert.match(copy, /<button class="btn btn-navy bz-btn" type="button" data-copy="invite-link" hidden>Copy link<\/button>/, 'hidden until the script runs');
  assert.match(copy, /<p class="bz-copy-status" data-copy-status role="status"><\/p>/);
  assert.match(String(parts.copyLink({ id: 'x', value: 'v', label: 'Link' })), /for="x">Link<\/label>/);

  assert.equal(String(parts.charCount('reason-count', { min: 10, max: 500 })), '<p class="field-hint bz-charcount" id="reason-count" aria-live="polite">Write 10 to 500 characters.</p>');
  assert.match(String(parts.charCount('m', { max: 1000 })), />Up to 1000 characters\.</);
});

test('budgetBar: committed then awaiting, in tenths of a percent rounded down, never past the end, no style attribute', () => {
  const rects = s => [...String(s).matchAll(/<rect class="bz-bar-(\w+)"(?: x="(\d+)")? width="(\d+)"/g)].map(m => [m[1], m[2] === undefined ? 0 : Number(m[2]), Number(m[3])]);
  const cls = s => (String(s).match(/^<svg class="([^"]+)"/) || [])[1];
  const b = parts.budgetBar({ amountCents: 1000000, committedCents: 312000, awaitingCents: 84200 });
  assert.match(String(b), /^<svg class="bz-bar" viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true" focusable="false">/);
  assert.doesNotMatch(String(b), /style=/);
  assert.deepEqual(rects(b), [['track', 0, 1000], ['committed', 0, 312], ['awaiting', 312, 84]]);
  // Rounded down: 1 cent of $3,000 is a thirtieth of a tenth, so nothing; 2/3 of the budget is 666, not 667.
  assert.deepEqual(rects(parts.budgetBar({ amountCents: 300000, committedCents: 1 })), [['track', 0, 1000]]);
  assert.deepEqual(rects(parts.budgetBar({ amountCents: 300, committedCents: 200 })), [['track', 0, 1000], ['committed', 0, 666]]);
  // Exactly the budget: full, not over.
  const exact = parts.budgetBar({ amountCents: 500000, committedCents: 500000 });
  assert.deepEqual(rects(exact), [['track', 0, 1000], ['committed', 0, 1000]]);
  assert.equal(cls(exact), 'bz-bar');
  // Awaiting approval would take it over: what awaits stops at the end, and the bar says so.
  const full = parts.budgetBar({ amountCents: 1000000, committedCents: 900000, awaitingCents: 200000 });
  assert.deepEqual(rects(full), [['track', 0, 1000], ['committed', 0, 900], ['awaiting', 900, 100]]);
  assert.equal(cls(full), 'bz-bar is-full');
  // Committed over the budget (an acknowledged overrun): the whole bar, marked over, nothing left for awaiting.
  const over = parts.budgetBar({ amountCents: 1000000, committedCents: 1041200, awaitingCents: 50000 });
  assert.deepEqual(rects(over), [['track', 0, 1000], ['committed', 0, 1000]]);
  assert.equal(cls(over), 'bz-bar is-over');
  // Nothing to measure against: no bar. Bad parts count as nothing.
  for (const amountCents of [null, undefined, 0, -100, NaN, 'x']) assert.equal(parts.budgetBar({ amountCents, committedCents: 100 }), '', String(amountCents));
  assert.deepEqual(rects(parts.budgetBar({ amountCents: 1000, committedCents: -500, awaitingCents: 'x' })), [['track', 0, 1000]]);
});

// ---------------------------------------------------------------------------------------------------------
// shell.js

const ORG = { id: 'org_AAAAAAAAAAAAAAAA', name: 'Acme Inc', status: 'active', timezone: TZ };
function shellFor(role, { org = ORG, name = 'Dana Lee', companies, approvalsCount, path = '/trips' } = {}) {
  const member = { orgId: org.id, userId: 'usr_BBBBBBBBBBBBBBBB', name, role, status: 'active' };
  const decides = ['owner', 'travel_admin', 'manager'].includes(role);
  return {
    org, member,
    companies: companies || [{ id: org.id, name: org.name, status: org.status, role, roleLabel: LABELS[role] }],
    approvalsCount: approvalsCount !== undefined ? approvalsCount : decides ? 2 : null,
    nav: navFor(org, member, `/business/o/${org.id}${path}`),
  };
}
const ctxFor = ({ status = 'demo', trips = true, now = FIXED_NOW, max = 3 } = {}) => ({
  assetVersion: 'v9', now: () => new Date(now), trips, config: { business: { maxOrgsPerUser: max } }, business: { inventory: { status } },
});
const navLinks = (s, cls) => [...(s.match(new RegExp(`<nav class="${cls}"[^>]*>[\\s\\S]*?</nav>`)) || [''])[0].matchAll(/<a class="bz-nav-link" href="([^"]+)"( aria-current="page")?>/g)].map(m => [m[1], !!m[2]]);

test('shell: its own private document with the workspace chrome, and no inline style or script', () => {
  const body = html`<h1>Trips</h1><p>Body</p>`;
  const s = String(shellView(ctxFor(), shellFor('travel_admin'), { title: 'Trips', body, scripts: ['/js/trip-form.js'] }));
  assertNoInline(s, 'shell');
  assert.match(s, /^<!doctype html>\n<html lang="en">/);
  assert.match(s, /<title>Trips · Acme Inc \| Tripelyx Business<\/title>/);
  assert.match(s, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(s, /<link rel="stylesheet" href="\/css\/site\.css\?v=v9">\n<link rel="stylesheet" href="\/css\/business\.css\?v=v9">/);
  assert.match(s, /<script src="\/js\/business\.js\?v=v9" defer><\/script>\n<script src="\/js\/trip-form\.js\?v=v9" defer><\/script>/);
  assert.match(s, /<a class="skip-link" href="#main">Skip to content<\/a>/);
  assert.match(s, /<main id="main" class="bz-main" tabindex="-1">/);
  assert.match(s, /<a class="bz-brand" href="\/business\/o\/org_AAAAAAAAAAAAAAAA">/);
  assert.equal((s.match(/<h1[\s>]/g) || []).length, 1, 'the page brings its one h1; the shell adds none');
  assert.ok(s.indexOf('bz-ribbons') < s.indexOf('<h1>Trips</h1>'), 'ribbons come first in main');
  assert.doesNotMatch(s, /site-header|site-footer|AI Travel Agent|ai-travel-agent/, 'not the corporate or trip chrome');
  assert.doesNotMatch(textOf(s), /LLC/);
  // The company home has no page title before the company name.
  assert.match(String(shellView(ctxFor(), shellFor('owner', { path: '' }), { body: '' })), /<title>Acme Inc \| Tripelyx Business<\/title>/);
  assert.throws(() => shellView(ctxFor(), { org: ORG }, { body: '' }), /shellContext/);
});

test('shell: the menu shows only what the role reaches, twice (sidebar and phone menu), with the current page marked', () => {
  for (const role of ['owner', 'travel_admin', 'finance', 'manager', 'employee']) {
    const shell = shellFor(role, { path: '/trips/btr_1' });
    const s = String(shellView(ctxFor(), shell, { title: 'Trip', body: '' }));
    const want = shell.nav.map(n => [n.href, n.current]);
    assert.ok(want.length > 0 && want.length <= NAV.length, role);
    assert.deepEqual(navLinks(s, 'bz-side bz-nav'), want, `${role}: the sidebar is navFor()`);
    assert.deepEqual(navLinks(s, 'bz-nav'), want, `${role}: the phone menu is the same list`);
    assert.equal((s.match(/aria-current="page"/g) || []).length, 2, `${role}: one current item in each`);
    assert.match(s, /<summary class="bz-menu-sum"><svg[\s\S]*?<\/svg><span>Menu<\/span><span class="bz-menu-current"> · Trips<\/span><\/summary>/);
    for (const n of shell.nav) assert.ok(NAV_ICONS[n.key], `${n.key} has an icon`);
  }
  const employee = shellFor('employee').nav.map(n => n.key);
  const owner = shellFor('owner').nav.map(n => n.key);
  assert.ok(owner.length > employee.length, 'an owner reaches more than an employee');
  assert.ok(!employee.includes('approvals') && owner.includes('approvals'));
});

test('shell: the approvals chip only for members who decide, with the count when there is one', () => {
  const chip = s => (s.match(/<a class="bz-chipbtn bz-top-approvals"[\s\S]*?<\/a>/) || [''])[0];
  const three = chip(String(shellView(ctxFor(), shellFor('manager', { approvalsCount: 3 }), { body: '' })));
  assert.match(three, /^<a class="bz-chipbtn bz-top-approvals" href="\/business\/o\/org_AAAAAAAAAAAAAAAA\/approvals"><svg[\s\S]*?<\/svg><span class="bz-top-label">Approvals<\/span><span class="bz-count">3<span class="sr-only"> waiting<\/span><\/span><\/a>$/);
  const zero = chip(String(shellView(ctxFor(), shellFor('manager', { approvalsCount: 0 }), { body: '' })));
  assert.ok(zero && !zero.includes('bz-count'), 'nothing waiting: the chip without a count');
  assert.equal(chip(String(shellView(ctxFor(), shellFor('employee'), { body: '' }))), '', 'an employee has no approvals chip');
  // The count also sits beside Approvals in the menu.
  assert.match(String(shellView(ctxFor(), shellFor('owner', { approvalsCount: 5 }), { body: '' })), /<span>Approvals<\/span><span class="bz-count">5<span class="sr-only"> waiting<\/span><\/span><\/a>/);
});

test('shell: the company switcher lists every company with role and status, and offers another only under the cap', () => {
  const companies = [
    { id: ORG.id, name: 'Acme Inc', status: 'active', role: 'travel_admin', roleLabel: 'Travel Admin' },
    { id: 'org_CCCCCCCCCCCCCCCC', name: '<Blue> Door', status: 'pending', role: 'employee', roleLabel: 'Employee' },
  ];
  const s = String(shellView(ctxFor({ max: 3 }), shellFor('travel_admin', { companies }), { body: '' }));
  assert.match(s, /<summary class="bz-chipbtn bz-switch-sum"><span class="bz-switch-org">Acme Inc<\/span><span class="bz-switch-role"> · Travel Admin<\/span>/);
  assert.match(s, /<a href="\/business\/o\/org_AAAAAAAAAAAAAAAA" aria-current="true"><span class="bz-switch-name">Acme Inc<\/span><span class="bz-switch-meta"><span>Travel Admin<\/span><span class="bz-pill bz-pill-good">Active<\/span><\/span><\/a>/);
  assert.match(s, /<a href="\/business\/o\/org_CCCCCCCCCCCCCCCC"><span class="bz-switch-name">&lt;Blue&gt; Door<\/span><span class="bz-switch-meta"><span>Employee<\/span><span class="bz-pill bz-pill-warn">Waiting for confirmation<\/span>/);
  assert.match(s, /<a href="\/business\/start">[\s\S]*?<span>Create another company<\/span><\/a>/);
  assert.match(s, /<a href="\/business\/app">[\s\S]*?<span>Your companies<\/span><\/a>/);
  const full = String(shellView(ctxFor({ max: 2 }), shellFor('travel_admin', { companies }), { body: '' }));
  assert.doesNotMatch(full, /Create another company|\/business\/start/, 'at the cap: no create link');
  // The current company is listed even when the list left it out.
  const missing = String(shellView(ctxFor(), shellFor('owner', { companies: [] }), { body: '' }));
  assert.match(missing, /<a href="\/business\/o\/org_AAAAAAAAAAAAAAAA" aria-current="true"><span class="bz-switch-name">Acme Inc<\/span><span class="bz-switch-meta"><span>Owner<\/span>/);
});

test('shell: the user menu names the member and role, links personal trips only when they run, and signs out by POST', () => {
  const s = String(shellView(ctxFor({ trips: true }), shellFor('finance', { name: '<Rana> Haddad' }), { body: '' }));
  assert.match(s, /<span class="bz-user-first">&lt;Rana&gt;<\/span><span class="sr-only"> \(account menu\)<\/span>/);
  assert.match(s, /<p class="bz-user-name">&lt;Rana&gt; Haddad<\/p>\s*<p class="bz-user-role">Finance at Acme Inc<\/p>/);
  assert.ok(s.includes('Your personal trips stay private to you.'));
  assert.match(s, /<a href="\/my-trips">[\s\S]*?<span>Personal trips<\/span><\/a>/);
  assert.match(s, /<form method="post" action="\/business\/signout"><button class="bz-linkbtn" type="submit">[\s\S]*?<span>Sign out<\/span><\/button><\/form>/);
  const noTrips = String(shellView(ctxFor({ trips: false }), shellFor('finance'), { body: '' }));
  assert.doesNotMatch(noTrips, /\/my-trips|Personal trips/);
  assert.match(noTrips, /action="\/business\/signout"/);
});

test('shell: the ribbons say what runs here (demo, pending company, no supplier on search pages)', () => {
  const ribbons = s => [...s.matchAll(/<p class="bz-ribbon bz-ribbon-(\w+)" role="note"><svg[\s\S]*?<\/svg><span>([\s\S]*?)<\/span><\/p>/g)].map(m => [m[1], textOf(m[2])]);
  assert.deepEqual(ribbons(String(shellView(ctxFor(), shellFor('owner'), { body: '', searchPage: true }))), [['demo', parts.DEMO_RIBBON]]);
  assert.deepEqual(ribbons(String(shellView(ctxFor({ status: 'none' }), shellFor('owner'), { body: '' }))), [['demo', PREVIEW_RIBBON]], 'no demo data: no demo-data claim');
  assert.deepEqual(ribbons(String(shellView(ctxFor({ status: 'none' }), shellFor('owner'), { body: '', searchPage: true }))),
    [['demo', PREVIEW_RIBBON], ['supplier', `${parts.NO_SUPPLIER.title} ${parts.NO_SUPPLIER.text}`]]);
  const pendingOrg = { ...ORG, name: 'Blue & Co', status: 'pending' };
  const pending = String(shellView(ctxFor(), shellFor('owner', { org: pendingOrg }), { body: '' }));
  assert.deepEqual(ribbons(pending), [['demo', parts.DEMO_RIBBON], ['pending', pendingRibbon('Blue & Co', { demo: true })]]);
  assert.ok(pending.includes('Tripelyx is confirming Blue &amp; Co.'), 'escaped');
  assert.ok(pending.includes('try a demo trip now'), 'demo inventory: a demo trip can be tried');
  assert.equal(pendingRibbon('X', { demo: true }), "Tripelyx is confirming X. You can set up policies, departments and budgets and try a demo trip now. Teammates can join once it's confirmed.");
  assert.equal(pendingRibbon('X'), "Tripelyx is confirming X. You can set up policies, departments and budgets now. Teammates can join once it's confirmed.");
  // No supplier (production) or a live one: no demo trip to offer, so the pending ribbon offers none.
  for (const status of ['none', 'live']) {
    const r = ribbons(String(shellView(ctxFor({ status }), shellFor('owner', { org: pendingOrg }), { body: '', searchPage: true })));
    assert.deepEqual(r.find(x => x[0] === 'pending'), ['pending', pendingRibbon('Blue & Co')], status);
    assert.doesNotMatch(r.map(x => x[1]).join(' '), /demo trip|demo data/, `${status}: no demo claim in any ribbon`);
  }
  // A live inventory (never today) is not called demo data either.
  assert.deepEqual(ribbons(String(shellView(ctxFor({ status: 'live' }), shellFor('owner'), { body: '', searchPage: true }))), [['demo', PREVIEW_RIBBON]]);
  // No Business context at all reads as "no supplier".
  assert.deepEqual(ribbons(String(shellView({ ...ctxFor(), business: null }, shellFor('owner'), { body: '' }))), [['demo', PREVIEW_RIBBON]]);

  const msgs = String(shellView(ctxFor(), shellFor('owner'), { body: html`<h1>X</h1>`, notice: 'Policy saved.', error: 'Someone changed this.' }));
  assert.ok(msgs.indexOf('role="status"') < msgs.indexOf('role="alert"') && msgs.indexOf('role="alert"') < msgs.indexOf('<h1>X</h1>'));
});

test('shell: the footer names Tripelyx Inc and go@tripelyx.com, with the year in the company zone from the injected clock', () => {
  const foot = s => textOf((s.match(/<footer class="bz-foot">[\s\S]*?<\/footer>/) || [''])[0]);
  assert.equal(foot(String(shellView(ctxFor(), shellFor('owner'), { body: '' }))), 'Tripelyx Business is a Tripelyx Inc product · go@tripelyx.com · © 2026 Tripelyx Inc.');
  // 22:30 UTC on 31 Dec is already 1 Jan in Cairo.
  assert.match(foot(String(shellView(ctxFor({ now: '2026-12-31T22:30:00.000Z' }), shellFor('owner'), { body: '' }))), /© 2027 Tripelyx Inc\.$/);
  const utc = { ...ORG, timezone: 'UTC' };
  assert.match(foot(String(shellView(ctxFor({ now: '2026-12-31T22:30:00.000Z' }), shellFor('owner', { org: utc }), { body: '' }))), /© 2026 Tripelyx Inc\.$/);
  assert.match(String(shellView(ctxFor(), shellFor('owner'), { body: '' })), /<a href="mailto:go@tripelyx\.com">go@tripelyx\.com<\/a>/);
});

test('a composed workspace page: one h1, no skipped heading level, every control labelled, every amount demo-labelled', () => {
  const { flightGroups, hotelGroups, flights } = searchRows();
  const alts = sampleAlts(flights);
  const opts = { pricedAt: PRICED, timeZone: TZ };
  const within = flightGroups.filter(g => g.some(r => r.evaluation.status === 'within'));
  const outside = flightGroups.filter(g => !g.some(r => r.evaluation.status === 'within'));
  const body = html`${parts.pageHead({ title: 'Cairo to London, Thu 12 Nov to Mon 16 Nov', sub: 'Your department: Engineering · Your policy: Standard' })}
    ${parts.limitsBar(LIMITS, opts)}
    <form method="post" action="/business/o/org_AAAAAAAAAAAAAAAA/trips">
      <h2>Outbound</h2>
      ${within.map(g => parts.rowCard(g, { timeZone: TZ, input: { name: 'out', required: true } }))}
      ${parts.outsideToggle(outside.length || 1, html`${outside.map(g => parts.rowCard(g, { timeZone: TZ, input: { name: 'out' } }))}`)}
      <h2>Hotel in London</h2>
      ${hotelGroups.map(g => parts.rowCard(g, { timeZone: TZ, input: { name: 'hotelKey' }, priceToBeatCents: 26400 }))}
      <div class="field"><label for="purpose">Trip purpose</label><textarea id="purpose" name="purpose" data-count="purpose-count" minlength="3" maxlength="140" aria-describedby="purpose-count"></textarea>${parts.charCount('purpose-count', { min: 3, max: 140 })}</div>
      ${parts.actionBar(html`<button class="btn btn-navy bz-btn" type="submit">Review trip</button>`)}
    </form>
    ${parts.alternativesPanel({ alternatives: alts, cheapestWithin: alts[0] }, { timeZone: TZ, action: '/swap', rev: 1 })}
    ${parts.verdict('out', 'Out of policy: 2 reasons', opts)}
    ${parts.verdict('out', 'The trip total is over your $2,500 trip limit by $310', opts)}
    ${parts.violationList([{ rule: 'budget', severity: 'approval', text: 'This trip would use $1,240 of the $900 left in Engineering for Q4 2026' }], opts)}
    ${parts.demoBox(html`<h2>Budget</h2><p>Committed ${parts.amount(312000)} of ${parts.amount(1000000)}</p>${parts.budgetBar({ amountCents: 1000000, committedCents: 312000 })}${parts.kvList([['Remaining', parts.amount(688000)], ['Department', 'Engineering']])}`, opts)}
    ${parts.comingSoon('Spend booked', 'Shows once real bookings exist.')}
    ${parts.supplierPanel()}
    ${parts.copyLink({ id: 'link', value: 'https://example.test/x' })}`;
  const page = String(shellView(ctxFor(), shellFor('employee', { path: '/trips/search' }), { title: 'Cairo to London', body, searchPage: true }));
  assertNoInline(page, 'page');
  assert.doesNotMatch(textOf(page), PRESSURE, 'no pressure words');
  assert.doesNotMatch(textOf(page), /\b(?:reviews|review score|ratings?|sold out|ticketed|PNR)\b/i, 'no booking or review claims ("Review trip" is a button)');
  const levels = assertHeadingOrder(page, 'page');
  assert.ok(levels.includes(3), 'cards sit a level under their section');
  assert.ok(assertLabelled(page, 'page') > 10, 'radios, the purpose and the copy field');
  assert.ok(assertDemoMoney(page, { label: 'page' }) > 20);
  assert.ok(/\$310/.test(textOf(page)) && /\$1,240/.test(textOf(page)), 'the text amounts were on the page and checked');
  const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
});

// ---------------------------------------------------------------------------------------------------------
// The static files

test('business.css and business-marketing.css are flat, every rule a bz- class; business.js parses and stays progressive', () => {
  for (const file of ['business.css', 'business-marketing.css']) {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /&/, `${file}: no nesting`);
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(m => m[1].trim());
    assert.ok(selectors.length > 50, file);
    for (const sel of selectors) for (const one of sel.split(',')) assert.match(one, /\.bz-/, `${file}: "${one.trim()}" is a bz- rule`);
    // Every @media block holds only rules (one level deep at most).
    for (const m of css.matchAll(/@media[^{]+\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) assert.ok(m[1].trim(), file);
  }
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'business.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'business.js' }));
  assert.doesNotMatch(js, /innerHTML|eval\(|new Function|fetch\(|XMLHttpRequest/, 'no markup from strings, no requests');
  // It runs against an empty page without throwing.
  const listeners = [];
  const doc = { querySelectorAll: () => [], querySelector: () => null, addEventListener: (t, fn) => listeners.push(t), activeElement: null };
  vm.runInNewContext(js, { document: doc, window: { location: { href: 'http://x/' }, history: {} }, navigator: {}, URL, setTimeout, clearTimeout });
});

/** Every declaration of business.css as [selector, property, value, media] (media '' outside @media). */
function cssDeclarations(css) {
  const out = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (text, media) => {
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1].split(',').map(s => s.trim())) {
        for (const d of m[2].split(';')) {
          const i = d.indexOf(':');
          if (i > 0) out.push([sel, d.slice(0, i).trim(), d.slice(i + 1).trim(), media]);
        }
      }
    }
  };
  const mediaRe = /@media([^{]+)\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g;
  for (const m of src.matchAll(mediaRe)) walk(m[2], m[1].trim());
  walk(src.replace(mediaRe, ''), '');
  return out;
}

test('business.css: the switcher fits its box at every width, [hidden] hides, and touch targets are 44px', () => {
  const decls = cssDeclarations(fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'business.css'), 'utf8'));
  const values = (sel, prop) => decls.filter(d => d[0] === sel && d[1] === prop);
  // The switcher's summary is a block-level flex box, so it is exactly as wide as the shrinking <details>
  // around it (an inline-flex summary spilled out and covered the Approvals chip from 641 to 1023px).
  assert.deepEqual(values('.bz-switch-sum', 'display').map(d => [d[2], d[3]]), [['flex', '']]);
  assert.ok(values('.bz-switch-org', 'min-width').some(d => d[2] === '0' && d[3] === ''), 'the name gives way');
  assert.ok(values('.bz-pop-wrap', 'min-width').some(d => d[2] === '0'));
  assert.equal(values('.bz-switch', 'overflow').length, 0, 'never clip the switcher: its list hangs below it');
  // The hidden attribute wins over .btn's display (the "Copy link" button without JavaScript).
  const hidden = decls.filter(d => /\[hidden\]$/.test(d[0]) && d[1] === 'display' && d[3] === '');
  assert.ok(hidden.some(d => d[0] === '.bz-app [hidden]' && d[2] === 'none !important'), JSON.stringify(hidden));
  assert.ok(hidden.some(d => d[0] === '.bz-copy [hidden]'), 'the copy block too, wherever it is used');
  // Touch targets (§B3): the "+N more" reasons, "Price details" and the wordmark link are 44px tall or more,
  // and nothing at a narrower width takes that back.
  for (const sel of ['.bz-reasons-more > summary', '.bz-more > summary', '.bz-brand']) {
    const mins = values(sel, 'min-height');
    assert.ok(mins.length > 0 && mins.every(d => parseFloat(d[2]) >= 44), `${sel}: ${JSON.stringify(mins)}`);
  }
});

/** Just enough DOM for /js/business.js: elements by id and the selectors the script asks for. */
function fakeDom(build) {
  const byId = {}, bySelector = {}, docListeners = {};
  const el = (attrs = {}, extra = {}) => {
    const listeners = {};
    const e = {
      attrs, hidden: true, textContent: attrs.text || '', value: attrs.value || '', open: !!attrs.open, parent: null, focused: 0,
      getAttribute: k => (k in attrs ? String(attrs[k]) : null),
      hasAttribute: k => k in attrs,
      setAttribute(k, v) { attrs[k] = String(v); },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      fire(t, ev = {}) { (listeners[t] || []).forEach(fn => fn(ev)); },
      focus() { e.focused += 1; }, select() {},
      closest: sel => { let p = e.parent; while (p && !(p.attrs.class || '').split(' ').includes(sel.replace(/^\./, ''))) p = p.parent; return p || null; },
      querySelector: sel => (e.children || []).find(c => sel === '[data-copy-status]' && 'data-copy-status' in c.attrs) || null,
      contains: x => x === e || (e.children || []).includes(x),
      classList: { contains: c => (attrs.class || '').split(' ').includes(c) },
      ...extra,
    };
    if (attrs.id) byId[attrs.id] = e;
    return e;
  };
  build({ el, add: (sel, ...els) => { bySelector[sel] = (bySelector[sel] || []).concat(els); } });
  const replaced = [];
  const document = {
    querySelectorAll: sel => bySelector[sel] || [],
    querySelector: sel => (bySelector[sel] || [])[0] || null,
    getElementById: id => byId[id] || null,
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    activeElement: null,
  };
  const window = {
    location: { href: 'https://www.tripelyx.com/business/o/org_A/trips/search?from=CAI&to=LHR#out' },
    history: { state: null, replaceState(state, title, url) { replaced.push(url); window.location.href = `https://www.tripelyx.com${url}`; } },
    isSecureContext: true,
  };
  return { document, window, byId, replaced, docListeners };
}

test('business.js: copy link, the character count, the out-of-policy toggle and the menus, on a fake page', async () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'business.js'), 'utf8');
  const copied = [];
  const dom0 = {};
  const dom = fakeDom(({ el, add }) => {
    // Two copy blocks, each with its own status line.
    for (const id of ['link-a', 'link-b']) {
      const box = el({ class: 'bz-copy' });
      const field = el({ id, value: `https://example.test/${id}` });
      const btn = el({ 'data-copy': id });
      const status = el({ 'data-copy-status': '' });
      btn.parent = box; field.parent = box; status.parent = box;
      box.children = [field, btn, status];
      add('[data-copy]', btn);
      dom0[id] = { btn, status };
    }
    add('[data-copy]', el({ 'data-copy': 'missing' }));
    const reason = el({ id: 'reason', 'data-count': 'reason-count', minlength: '10', maxlength: '500' });
    el({ id: 'reason-count', text: 'Write 10 to 500 characters.' });
    add('textarea[data-count], input[data-count]', reason);
    const d1 = el({}), d2 = el({});
    add('details[data-outside]', d1, d2);
    const sw = el({ class: 'bz-pop-wrap bz-switch' }), user = el({ class: 'bz-pop-wrap bz-user' }), menu = el({ class: 'bz-menu' });
    add('details.bz-pop-wrap, details.bz-menu', sw, user, menu);
    Object.assign(dom0, { reason, d1, d2, sw, user, menu });
  });
  const navigator = { clipboard: { writeText: async v => { copied.push(v); } } };
  vm.runInNewContext(js, { document: dom.document, window: dom.window, navigator, URL });

  // Copy link: the buttons show, and each reports in its own block.
  assert.equal(dom0['link-a'].btn.hidden, false);
  dom0['link-b'].btn.fire('click');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(copied, ['https://example.test/link-b']);
  assert.equal(dom0['link-b'].status.textContent, 'Link copied. Paste it into a message to send it.');
  assert.equal(dom0['link-a'].status.textContent, '', 'the other block is untouched');

  // Character count: how many more are needed, then how many of the most.
  const out = dom.byId['reason-count'];
  assert.equal(out.textContent, 'Write at least 10 characters (10 more).');
  assert.equal(out.getAttribute('aria-live'), 'polite');
  dom0.reason.value = '  Client  ';
  dom0.reason.fire('input');
  assert.equal(out.textContent, 'Write at least 10 characters (4 more).', 'spaces at the ends do not count');
  dom0.reason.value = 'Client meeting in London';
  dom0.reason.fire('input');
  assert.equal(out.textContent, '24 of 500 characters');

  // The toggle keeps ?all=1 while any section is open, and keeps the rest of the address.
  dom0.d2.open = true;
  dom0.d2.fire('toggle');
  assert.equal(dom.replaced.at(-1), '/business/o/org_A/trips/search?from=CAI&to=LHR&all=1#out');
  dom0.d1.open = true; dom0.d1.fire('toggle');
  dom0.d2.open = false; dom0.d2.fire('toggle');
  assert.match(dom.replaced.at(-1), /all=1/, 'one still open');
  dom0.d1.open = false; dom0.d1.fire('toggle');
  assert.equal(dom.replaced.at(-1), '/business/o/org_A/trips/search?from=CAI&to=LHR#out');

  // Menus: opening one popover closes the other; Escape and a click outside close them.
  dom0.sw.open = true; dom0.sw.fire('toggle');
  dom0.user.open = true; dom0.user.fire('toggle');
  assert.equal(dom0.sw.open, false);
  dom.docListeners.click[0]({ target: {} });
  assert.equal(dom0.user.open, false);
  dom0.menu.open = true;
  dom.docListeners.keydown[0]({ key: 'Escape' });
  assert.equal(dom0.menu.open, false, 'Escape closes the phone menu too');
});
