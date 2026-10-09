// Supplier test data for the Business service and page tests (real-suppliers design §7.1 B items, §8.3): rows in
// the supplier test namespace (flt_t., htl_t.), with no supplier, no key and no network. Not a test file itself
// (it doesn't match *.test.js).
//
// - sandboxInventory(inner): a fakeInventory() (test/business-fakes.js) whose rows carry the sandbox namespace,
//   with status and source 'sandbox'. fakeComposer({ inventory: sandboxInventory() }) prices them as usual.
// - sandboxProvider(inner): a real demo provider (BusinessDemoFlights, BusinessDemoHotels) whose offer ids carry
//   the sandbox namespace; another namespace is not its own (getOffer null, quote 409).
// - useSandbox(app, opts): the running app's Business inventory and TripComposer swapped for ones over those
//   providers, as status 'sandbox' (BusinessService.inventory and .composer are writable).
// - instrument(composer): records the check level of every search, price, variants and recheck call, and can
//   make a method throw what a failing real supplier throws (source.supplierError, or 422 unsupported_currency).
// - assertSourceMoney(markup, source): every amount sits in a data-price-source="<source>" container whose text
//   names where it came from (supplier test data: the TEST DATA tag and "Supplier test data" or "Includes
//   supplier test data"), and nothing on the page says "Demo price".
const assert = require('node:assert/strict');
const { AppError } = require('../server/lib/errors');
const { TripComposer } = require('../server/business/search');
const { sourceOf, supplierError } = require('../server/business/source');
const { fakeInventory } = require('./business-fakes');

/** 'f.flt_fake_…|LIGHT' → 'f.flt_t.fake_…|LIGHT', 'htl_CA-NILE' → 'htl_t.CA-NILE' (an id already in it stays). */
const toSandbox = id => String(id).replace(/^([fh]\.)?(flt|htl)_(?!t\.)/, (m, key, kind) => `${key || ''}${kind}_t.`);
/** The reverse: the inner provider's own id. */
const fromSandbox = id => String(id).replace(/^([fh]\.)?(flt|htl)_t\./, (m, key, kind) => `${key || ''}${kind}_`);

/** A row moved into the sandbox namespace (its key and offer id; nothing else changes). */
const sandboxRow = row => (row ? { ...row, key: toSandbox(row.key), offerId: toSandbox(row.offerId) } : row);

/**
 * A fakeInventory whose rows are supplier test data. Keys from another namespace find nothing.
 * @param {object} [inner] fakeInventory()
 */
function sandboxInventory(inner = fakeInventory()) {
  const mine = key => sourceOf(key) === 'sandbox';
  const rows = list => list.map(sandboxRow);
  return {
    status: 'sandbox', source: 'sandbox', hotelsConnected: true, maxVariantSearches: 4, problem: null,
    inner,
    flights: inner.flights,
    hotels: inner.hotels,
    airports: () => inner.airports(),
    carriers: () => inner.carriers(),
    cityFor: iata => inner.cityFor(iata),
    get searches() { return inner.searches; },
    get quotes() { return inner.quotes; },
    flightRows: (q, pricedAt) => rows(inner.flightRows(q, pricedAt)),
    hotelRows: (q, pricedAt) => rows(inner.hotelRows(q, pricedAt)),
    quoteRow: (key, q, pricedAt) => (mine(key) ? sandboxRow(inner.quoteRow(fromSandbox(key), q, pricedAt)) : null),
    peekFlightRows: (q, pricedAt) => rows(inner.peekFlightRows(q, pricedAt)),
    peekHotelRows: (q, pricedAt) => rows(inner.peekHotelRows(q, pricedAt)),
    setPrice: (key, totalCents) => inner.setPrice(fromSandbox(key), totalCents),
    setUnavailable: (key, unavailable = true) => inner.setUnavailable(fromSandbox(key), unavailable),
    clearOverrides: () => inner.clearOverrides(),
  };
}

/**
 * A provider-contract provider over a real demo provider, its offer ids in the sandbox namespace.
 * @param {object} inner BusinessDemoFlights or BusinessDemoHotels
 */
function sandboxProvider(inner) {
  const offer = o => (o ? { ...o, id: toSandbox(o.id) } : o);
  const gone = () => new AppError('option_sold_out', 'This option is no longer available.', 409);
  return {
    name: inner.name, vertical: inner.vertical, isDemo: true,
    async search(pq) { return (await inner.search(pq)).map(offer); },
    async getOffer(offerId, pq) {
      if (sourceOf(offerId) !== 'sandbox') return null;
      return offer(await inner.getOffer(fromSandbox(offerId), pq));
    },
    async quote({ offerId, optionId, query }) {
      if (sourceOf(offerId) !== 'sandbox') throw gone();
      const q = await inner.quote({ offerId: fromSandbox(offerId), optionId, query });
      return { ...q, offer: offer(q.offer) };
    },
    async book() { throw new AppError('not_supported', 'Business never books.', 400); },
    async cancel() { throw new AppError('not_supported', 'Business never books.', 400); },
  };
}

/**
 * Swap a running app's Business inventory and composer for supplier test data over its demo providers.
 * @param {object} app from startApp() with ENABLE_BUSINESS
 * @param {{ hotels?: boolean, problem?: string|null }} [opts] hotels false: flights only ("Hotels are not
 *   connected yet"); problem: inventory.problem
 * @returns {{ inventory: object, composer: object, restore: () => void }}
 */
function useSandbox(app, { hotels = true, problem = null } = {}) {
  const svc = app.business;
  const was = { inventory: svc.inventory, composer: svc.composer };
  const demo = was.inventory;
  assert.equal(demo.status, 'demo', 'useSandbox wraps the demo inventory');
  const inventory = {
    status: 'sandbox', source: 'sandbox',
    flights: sandboxProvider(demo.flights),
    hotels: hotels ? sandboxProvider(demo.hotels) : null,
    airports: () => demo.airports(),
    carriers: () => demo.carriers(),
    cityFor: iata => demo.cityFor(iata),
    hotelsConnected: hotels, maxVariantSearches: 4, problem,
  };
  svc.inventory = inventory;
  svc.composer = new TripComposer({ inventory, now: app.ctx.now });
  return {
    inventory, composer: svc.composer,
    restore() { svc.inventory = was.inventory; svc.composer = was.composer; },
  };
}

/** The AppError a failing real supplier throws for `code`. */
function failure(code, vertical = 'flights') {
  if (code === 'unsupported_currency') return new AppError('unsupported_currency', 'This trip has a price in another currency.', 422);
  return code === 'supplier_unavailable' ? supplierError(code, { vertical }) : supplierError(code);
}

/** Where each method's options argument sits. */
const OPTS_AT = Object.freeze({ search: -1, price: 2, variants: 2, recheck: 1 });

/**
 * Record every composer call's check level, and make calls fail on demand. Works on fakeComposer() and on a
 * TripComposer (instance methods shadow the prototype's; the composer's own inner calls go through them too).
 * @param {object} composer
 * @returns {{ calls: Array<{ method: string, check: string|null }>, checks: (method: string) => Array<string|null>,
 *   fail: (method: string, code: string, opts?: { times?: number, vertical?: string }) => void, heal: () => void }}
 *   fail: times -1 (default) fails every call until heal()
 */
function instrument(composer) {
  const calls = [];
  const fails = new Map();
  for (const [method, at] of Object.entries(OPTS_AT)) {
    const inner = composer[method];
    composer[method] = async (...args) => {
      const opts = at >= 0 ? args[at] : null;
      calls.push({ method, check: opts && typeof opts === 'object' && typeof opts.check === 'string' ? opts.check : null });
      const f = fails.get(method);
      if (f && f.times !== 0) {
        if (f.times > 0) f.times -= 1;
        throw failure(f.code, f.vertical);
      }
      return inner.apply(composer, args);
    };
  }
  return {
    calls,
    checks: method => calls.filter(c => c.method === method).map(c => c.check),
    fail(method, code, { times = -1, vertical = 'flights' } = {}) { fails.set(method, { code, times, vertical }); },
    heal() { fails.clear(); },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Markup

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Every element with its parent and where its content ends (the walker of test/business-views.test.js). */
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
const textOf = s => String(s).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const hasClass = (el, cls) => new RegExp(`\\bclass="[^"]*\\b${cls}\\b`).test(el.attrs);
const TEXT_AMOUNT = /[$€£¥]\s?\d/;

/** What a container of each source says. */
const SAYS = Object.freeze({
  sandbox: text => text.includes('TEST DATA') && /Supplier test data|Includes supplier test data/.test(text),
  live: text => /from the airline|from the hotel supplier|from airlines and hotels|Supplier prices/.test(text),
});

/**
 * Every amount (a .bz-money, or an amount written in text) sits in a data-price-source="<source>" container
 * that says so; no container of another source, and no "Demo price" anywhere.
 * @param {string} markup
 * @param {'sandbox'|'live'} source
 * @param {{ label?: string, min?: number }} [opts] min: at least this many .bz-money amounts
 * @returns {number} the .bz-money amounts checked
 */
function assertSourceMoney(markup, source, { label = '', min = 0 } = {}) {
  const s = String(markup);
  const all = elements(s);
  // The demo labels ("Demo price", "Demo prices", an alternative's "(demo price)"); a sentence that lists every
  // source ("demo prices, supplier test data or supplier prices") is not a label.
  assert.doesNotMatch(textOf(s), /Demo prices?\b|\(demo price\)/, `${label}: nothing says Demo price`);
  for (const m of s.matchAll(/data-price-source="([^"]*)"/g)) assert.equal(m[1], source, `${label}: every container is ${source}`);
  const check = (el, what) => {
    let box = el;
    while (box && !new RegExp(`\\bdata-price-source="${source}"`).test(box.attrs)) box = box.parent;
    assert.ok(box, `${label}: ${what} sits in a ${source} container`);
    const text = textOf(s.slice(box.inner, box.end));
    assert.ok(SAYS[source](text), `${label}: the container of ${what} says where it came from: ${text.slice(0, 200)}`);
    if (source === 'sandbox') assert.ok(hasClass(box, 'bz-price-test'), `${label}: the container of ${what} has the test outline`);
  };
  let n = 0;
  for (const el of all) {
    if (!hasClass(el, 'bz-money')) continue;
    n += 1;
    check(el.parent, s.slice(el.start, el.start + 80));
  }
  for (const m of s.matchAll(/>([^<]+)</g)) {
    const text = textOf(m[1]);
    if (!TEXT_AMOUNT.test(text)) continue;
    const at = m.index + 1;
    const owner = all.filter(el => !VOID.has(el.tag) && !/\/\s*$/.test(el.attrs) && el.inner <= at && at < el.end)
      .reduce((a, el) => (!a || el.inner > a.inner ? el : a), null);
    check(owner, `"${text.slice(0, 60)}"`);
  }
  assert.ok(n >= min, `${label}: at least ${min} amounts (found ${n})`);
  return n;
}

module.exports = {
  toSandbox, fromSandbox, sandboxRow, sandboxInventory, sandboxProvider, useSandbox, instrument, failure,
  elements, textOf, assertSourceMoney,
};
