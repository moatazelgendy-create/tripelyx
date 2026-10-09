// The plan §A3 flows over real HTTP, as a person clicks them on a local preview: shared by business-e2e.test.js
// and business-nobooking.test.js (not a test file itself: it doesn't match *.test.js). Every form is read from
// the page and posted with the fields a browser sends, through a cookie jar, with same-origin fetch metadata
// and no automatic redirects. The real modules throughout (createApp with Business on: demo inventory,
// TripComposer, the policy engine, alternatives, the rule explainer, D1 accounts); the clock is a
// mutableClock held at FIXED_NOW, so the trips and their demo prices are the same on every run.
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const { mutableClock, storeSnapshot } = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { createBusinessInventory } = require('../server/business/inventory');
const { CSV_COLUMNS } = require('../server/business/csv');
const { money, percent } = require('../server/views/business/format');
const { overrideProvider } = require('./business-fakes');

const PASSWORD = 'correct horse battery';
const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });
const BQ = Object.freeze({ ...Q, cabin: 'business' });
const REASON = 'The board meets at the client office, and this is the only flight that lands in time.';

// ---------------------------------------------------------------------------------------------------------
// Page helpers

const decode = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = s => decode(String(s).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const mainOf = page => (String(page).match(/<main\b[\s\S]*<\/main>/) || [''])[0];
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const short = s => String(s).slice(0, 600);
// The experience engine's list (test/experience-pages.test.js): urgency, scarcity, predictions, guarantees.
const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;

/** Every <form action="..."> on the page, as its inner markup. */
function formsOf(page, action) {
  const re = new RegExp(`<form[^>]*action="${escRe(action)}"[^>]*>([\\s\\S]*?)</form>`, 'g');
  return [...String(page).matchAll(re)].map(m => m[1]);
}

/** The fields a browser sends for a form body: inputs, checked boxes and radios, selects, textareas. */
function fieldsOf(body) {
  const attr = (tag, name) => { const a = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return a ? decode(a[1]) : null; };
  const has = (tag, name) => new RegExp(`\\s${name}(\\s|>|=|$)`).test(tag);
  const out = [];
  for (const [tag] of String(body).matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, 'name');
    if (!name || has(tag, 'disabled')) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && !has(tag, 'checked')) continue;
    out.push([name, attr(tag, 'value') ?? (type === 'checkbox' ? 'on' : '')]);
  }
  for (const [, open, inner] of String(body).matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(open, 'name');
    if (!name) continue;
    const opts = [...inner.matchAll(/<option\b([^>]*)>/g)].map(o => o[1]);
    const chosen = opts.find(o => has(o, 'selected')) || opts[0];
    out.push([name, chosen ? attr(chosen, 'value') ?? '' : '']);
  }
  for (const [, open, inner] of String(body).matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = attr(open, 'name');
    if (name) out.push([name, decode(inner)]);
  }
  return out;
}

/** The fields of the first form posting to `action` (or the first one `pick` accepts). */
function formOf(page, action, pick = null) {
  const all = formsOf(page, action);
  const body = pick ? all.find(pick) : all[0];
  assert.ok(body, `a form posting to ${action}`);
  return fieldsOf(body);
}
const setField = (pairs, name, value) => (pairs.some(([k]) => k === name) ? pairs.map(([k, v]) => [k, k === name ? value : v]) : [...pairs, [name, value]]);
const setFields = (pairs, values) => Object.entries(values).reduce((p, [k, v]) => setField(p, k, v), pairs);
const getField = (pairs, name) => (pairs.find(([k]) => k === name) || [])[1];

/** The value of the <option> whose text starts with `label`, in the select named `name`. */
function optionValue(body, name, label) {
  const sel = new RegExp(`<select\\b[^>]*name="${escRe(name)}"[^>]*>([\\s\\S]*?)</select>`).exec(body);
  if (!sel) return null;
  for (const m of sel[1].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)) {
    if (textOf(m[2]).startsWith(label)) return decode(m[1]);
  }
  return null;
}

const EM_DASH = /\u2014|&mdash;|&#8212;|&#x2014;/i;
/**
 * Nothing internal in a page, the company export or the CSV: supplier references, net rates, commission,
 * markup, provider names or fields, `internal`, and the staff fields of a company (statusBy, statusNote).
 */
const INTERNAL = /supplierQuoteRef|supplierRef|netCents|netNightly|commission|markup|BusinessDemo|Mock\w*Provider|"internal"|"provider"|"statusBy"|"statusNote"/i;
const INTERNAL_CSV = /supplierQuoteRef|supplierRef|netCents|netNightly|commission|markup|BusinessDemo|Mock\w*Provider|\bprovider\b|\binternal\b|statusBy|statusNote/i;

/** The honest sentences that name what does not happen, written out before the claim checks. */
const HONEST = [
  /\bnothing (?:is|was|has been) (?:booked or charged|booked|charged)(?: yet)?/gi,
  /\bno emails are sent\b/gi,
  /\bwe don't send emails? yet\b/gi,
  /\bNothing is charged\b/g,
  // What is coming on Reports, marked Coming soon; a hotel rate's own cancellation terms; what a total holds.
  /\bSpend booked Coming soon Shows once trips are booked through Tripelyx\./g,
  /\bReports on booked spend Coming soon\b/g,
  /\bAfter that \d+% of the total is charged\./g,
  /\bThe total is everything charged for these options\b/g,
];
/** Claims no Business page makes in phase 1: nothing is booked, ticketed, charged, emailed or sold out. */
const CLAIMS = [
  ['booked', /\bbooked\b/i],
  ['charged', /\bcharged\b/i],
  ['ticket', /\b(?:e-?)?tickets?\b|\bticketed\b/i],
  ['PNR', /\bPNRs?\b|\bbooking reference\b|\bconfirmation (?:number|code)\b|\brecord locator\b/i],
  ['emailed', /\bemailed\b|\bemails? (?:was |were |has been |have been |is |are )?sent\b|\bsent (?:you |them |him |her )?(?:an? )?(?:e-?mails?|e-ticket)\b/i],
  ['Sold out', /\bsold out\b/i],
];

/**
 * The words of a page's <main> claim nothing untrue: no booked, ticketed, charged, emailed or sold-out claim
 * (after the honest negations), "confirmed" only about a company (Tripelyx confirms companies, never trips),
 * and "remaining" only as the budget column.
 */
function claimsCheck(label, main) {
  const markup = String(main).replace(/<th scope="col" class="is-num">Remaining<\/th>/g, '').replace(/<span class="bz-cell-label">Remaining<\/span>/g, '');
  let words = textOf(markup);
  for (const re of HONEST) words = words.replace(re, ' ');
  for (const [name, re] of CLAIMS) {
    const m = re.exec(words);
    assert.ok(!m, `${label}: claims "${m && m[0]}" (${name}): ${m && words.slice(Math.max(0, m.index - 100), m.index + 80)}`);
  }
  // A sentence ends at . ! ? or at the end of a block (a list row, a paragraph, a cell): ¶ marks those.
  let blocks = textOf(markup.replace(/<\/(?:li|p|h[1-6]|td|th|tr|div|dt|dd|section|article|blockquote|caption|figcaption|summary|label)>/gi, '$&\u00b6'));
  for (const re of HONEST) blocks = blocks.replace(re, ' ');
  // "confirmed" is about a company: its block names the company, Tripelyx or joining ("... is waiting for
  // Tripelyx to confirm it. Try this link again once it's confirmed."), and its sentence names no trip part.
  for (const block of blocks.split('\u00b6')) {
    for (const m of block.matchAll(/[^.!?]*\bconfirmed\b[^.!?]*/gi)) {
      assert.match(block, /\b(?:company|name|Tripelyx|join)\b/i, `${label}: "confirmed" is about a company: ${block.trim()}`);
      assert.doesNotMatch(m[0], /\b(?:trips?|flights?|hotels?|rooms?|seats?|fares?|bookings?|reservations?)\b/i, `${label}: a trip is never "confirmed": ${m[0].trim()}`);
    }
  }
  const rem = /\bremaining\b/i.exec(words);
  assert.ok(!rem, `${label}: "remaining" outside the budget column: ${rem && words.slice(Math.max(0, rem.index - 100), rem.index + 60)}`);
}

// Elements of a markup string with their extent, to find the container an amount sits in.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
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

/**
 * Every amount in a page's <main> (each .bz-money, and each "$1,234" in a text run) with the text of the
 * nearest data-price-source="demo" container around it (null when there is none).
 * @returns {{ what: string, box: string|null }[]}
 */
function amountsOf(main) {
  const s = String(main).replace(/<svg[\s\S]*?<\/svg>/g, '');
  const all = elements(s);
  const boxOf = el => {
    let box = el;
    while (box && !/\bdata-price-source="demo"/.test(box.attrs)) box = box.parent;
    return box ? textOf(s.slice(box.inner, box.end)) : null;
  };
  const out = [];
  for (const el of all) if (/\bclass="[^"]*\bbz-money\b/.test(el.attrs)) out.push({ what: textOf(s.slice(el.inner, el.end)), box: boxOf(el.parent) });
  for (const m of s.matchAll(/>([^<]+)</g)) {
    const text = textOf(m[1]);
    if (!/[$€£¥]\s?\d/.test(text)) continue;
    const at = m.index + 1;
    const owner = all.filter(el => !VOID.has(el.tag) && !/\/\s*$/.test(el.attrs) && el.inner <= at && at < el.end)
      .reduce((a, el) => (!a || el.inner > a.inner ? el : a), null);
    out.push({ what: text, box: boxOf(owner) });
  }
  return out;
}

/**
 * What every workspace page passes: a <main>, CSP-safe markup and a strict script CSP, no em dash, no pressure
 * words, no claim of a booking, ticket, charge or email, nothing internal; and (demo) every single amount
 * inside a demo container that says "Demo price" (with no demo inventory: no demo label at all).
 * @returns {string} the page's <main>
 */
function pageChecks(label, res, { demo = true } = {}) {
  const page = res.text;
  const main = mainOf(page);
  assert.ok(main, `${label}: has <main>`);
  assert.doesNotMatch(page, /<style\b/, `${label}: no <style>`);
  assert.doesNotMatch(page, /\son[a-z]+\s*=\s*["']/i, `${label}: no on* handlers`);
  assert.doesNotMatch(page, /<script\b(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/, `${label}: no inline <script>`);
  assert.doesNotMatch(page, /\sstyle="/, `${label}: no inline style attribute`);
  assert.doesNotMatch(textOf(main), EM_DASH, `${label}: no em dash`);
  assert.doesNotMatch(textOf(main), PRESSURE, `${label}: no pressure words`);
  claimsCheck(label, main);
  const leak = INTERNAL.exec(page);
  assert.ok(!leak, `${label}: nothing internal ("${leak && leak[0]}")`);
  const csp = res.headers.get('content-security-policy') || '';
  const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src')) || '';
  assert.ok(/script-src 'self'/.test(csp) && !/unsafe-inline/.test(scriptSrc), `${label}: strict script CSP (${csp})`);
  if (demo) {
    for (const { what, box } of amountsOf(main)) {
      assert.ok(box !== null, `${label}: "${what.slice(0, 80)}" sits in a demo-price container`);
      assert.match(box, /Demo price/, `${label}: the container of "${what.slice(0, 60)}" says Demo price: ${box.slice(0, 160)}`);
    }
  } else {
    assert.doesNotMatch(main, /data-price-source="demo"|Demo price/, `${label}: no demo price label without demo inventory`);
  }
  return main;
}

/**
 * Every Business page a browser loads in a world (under /business or /admin/business; the consumer site's
 * pages are not Business copy): no pressure words anywhere on it (header, menu and footer included), no em
 * dash in its own copy (<main>), and no claim it cannot keep.
 */
function wordsCheck(label, page, path) {
  if (!/^\/(?:business|admin\/business)(?:[/?]|$)/.test(path)) return;
  assert.doesNotMatch(textOf(page), PRESSURE, `${label}: no pressure words anywhere on the page`);
  const main = mainOf(page);
  if (!main) return;
  assert.doesNotMatch(textOf(main), EM_DASH, `${label}: no em dash`);
  claimsCheck(label, main);
}

/** Cache-Control no-store and X-Robots-Tag noindex. */
const privateHeaders = r => /no-store/.test(r.headers.get('cache-control') || '') && /noindex/.test(r.headers.get('x-robots-tag') || '');

// ---------------------------------------------------------------------------------------------------------
// A browser: a cookie jar, same-origin fetch metadata, no automatic redirects.

/**
 * The worlds by base URL, so every browser on a world's server checks, on every request it makes: a GET
 * writes nothing to the store (plan §B4: GETs never write); a state-changing POST is first sent once as a
 * cross-site request, which must answer 403 and write nothing (sameOrigin on every POST); and every HTML page
 * passes wordsCheck. Browsers on any other server (business-demo.test.js) make none of these checks.
 */
const WORLDS = new Map();

function browser(base, extraHeaders = {}) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = res => {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      const gone = value === '' || attrs.some(a => /^\s*max-age=0\s*$/i.test(a))
        || attrs.some(a => /^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now());
      if (gone) jar.delete(name); else jar.set(name, value);
    }
  };
  const req = async (path, { method = 'GET', pairs = null, headers = {} } = {}) => {
    const world = WORLDS.get(base) || null;
    const h = { 'sec-fetch-site': 'same-origin', ...extraHeaders, ...headers };
    const c = cookie();
    if (c) h.cookie = c;
    let body;
    if (pairs) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(pairs).toString(); }
    if (world && method === 'POST' && !('sec-fetch-site' in headers) && !('sec-fetch-site' in extraHeaders)) {
      // The same POST from another site, with the same cookie: refused before anything is read or written.
      const before = world.writes.n;
      const xs = await fetch(base + path, { method, headers: { ...h, 'sec-fetch-site': 'cross-site' }, body, redirect: 'manual' });
      await xs.text();
      assert.equal(xs.status, 403, `a cross-site POST ${path} is refused (${xs.status})`);
      assert.equal(world.writes.n, before, `a cross-site POST ${path} writes nothing: ${world.writes.names.slice(before).join(', ')}`);
    }
    const before = world ? world.writes.n : 0;
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    take(res);
    const text = await res.text();
    if (world && method === 'GET') {
      assert.equal(world.writes.n, before, `GET ${path} writes nothing: ${world.writes.names.slice(before).join(', ')}`);
    }
    if (world && /text\/html/.test(res.headers.get('content-type') || '')) wordsCheck(`${method} ${path}`, text, path);
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text, path };
  };
  return {
    jar,
    get: (path, opts) => req(path, opts),
    post: (path, pairs, opts = {}) => req(path, { ...opts, method: 'POST', pairs: Array.isArray(pairs) ? pairs : Object.entries(pairs || {}) }),
    /** Follow 303/302 redirects with GETs, as a browser does. */
    async follow(res, max = 5) {
      let r = res;
      for (let i = 0; i < max && r.status >= 300 && r.status < 400 && r.location; i++) {
        const u = new URL(r.location, base);
        r = await req(u.pathname + u.search);
      }
      return r;
    },
  };
}

/** The enabled radio choices on a results page: { name, value, state, card, kind }. */
function choices(page) {
  const out = [];
  for (const art of String(page).matchAll(/<article class="bz-card bz-row bz-row-(hotel|flight)"[\s\S]*?<\/article>/g)) {
    const card = art[0];
    for (const li of card.matchAll(/<li class="bz-opt([^"]*)">([\s\S]*?)<\/li>/g)) {
      const radio = /<input class="bz-opt-radio" type="radio"[^>]*name="([^"]+)" value="([^"]*)"([^>]*)>/.exec(li[2]);
      if (!radio || /\sdisabled/.test(radio[3])) continue;
      const state = (li[1].match(/is-(within|out|blocked|unavailable)/) || [])[1] || null;
      out.push({ name: radio[1], value: decode(radio[2]), state, card, kind: art[1] });
    }
  }
  return out;
}

/** A row key 'h.<offerId>|<optionId>' (or 'f.…') as its parts. */
function rowKeyParts(key) {
  const m = /^[fh]\.(.+)\|([^|]+)$/.exec(key);
  assert.ok(m, `a row key: ${key}`);
  return { offerId: m[1], optionId: m[2] };
}

// ---------------------------------------------------------------------------------------------------------
// Worlds

/**
 * Names for one run. With a tag (a Postgres run on a shared database), every email and company name carries
 * it, so reruns never collide.
 */
function namesFor(tag = '') {
  const dom = tag ? `${tag}.sample.example` : 'sample.example';
  return {
    tag,
    company: tag ? `Sample Company ${tag} (demo)` : 'Sample Company (demo)',
    second: tag ? `Second Sample Co ${tag}` : 'Second Sample Co',
    prodCompany: tag ? `Prod Sample Co ${tag}` : 'Prod Sample Co',
    opsEmail: tag ? `ops.${tag}@tripelyx.example` : 'ops@tripelyx.example',
    email: local => `${local}@${dom}`,
  };
}

/**
 * The development app (Business on, demo inventory) on a held clock, with the platform admin's address in
 * ADMIN_EMAILS. `store` defaults to a fresh MemoryStore; `env` adds config (a Postgres DATABASE_URL, say).
 * @returns {Promise<object>} w: { app, base, clock, names, close, ... } that the flows below fill in
 */
/**
 * Count every store write from now on (any store): { n, names }. Installed once per world; watchWrites and
 * the no-booking spies wrap on top of it.
 */
function countWrites(store) {
  const counter = { n: 0, names: [] };
  for (const name of WRITE_METHODS) {
    if (typeof store[name] !== 'function') continue;
    const real = store[name];
    store[name] = function counted(...args) { counter.n += 1; counter.names.push(name); return real.apply(this, args); };
  }
  return counter;
}

/** Register a world's server, so its browsers check every request (see WORLDS). */
function register(w) {
  w.writes = countWrites(w.app.store);
  WORLDS.set(w.base, w);
  const close = w.close;
  w.close = async () => { WORLDS.delete(w.base); await close(); };
  return w;
}

/**
 * The development app (Business on, demo inventory) on a held clock, with the platform admin's address in
 * ADMIN_EMAILS. `store` defaults to a fresh MemoryStore; `env` adds config (a Postgres DATABASE_URL, say).
 * One traveler runs whole flows here within a minute, and every POST is also tried once cross-site, so the
 * world allows more compute and sign-in requests than one person makes (the limiters themselves are tested in
 * business-traveler and business-public).
 * @returns {Promise<object>} w: { app, base, clock, names, close, ... } that the flows below fill in
 */
async function devWorld({ tag = '', env = {}, store, clock = mutableClock(FIXED_NOW) } = {}) {
  const names = namesFor(tag);
  const app = await startApp({ ENABLE_BUSINESS: 'true', ADMIN_EMAILS: names.opsEmail, BUSINESS_COMPUTE_LIMIT: '200', BUSINESS_AUTH_LIMIT: '100', ...env }, { now: clock.now, ...(env.DATABASE_URL ? {} : { store: store || new MemoryStore() }) });
  const w = { app, base: app.base, clock, names, people: {}, rids: {} };
  w.close = async () => { await app.close(); if (app.store.kind !== 'memory') await app.store.close(); };
  return register(w);
}

/** The production config (APP_ENV=production, a dummy DATABASE_URL, trips off, Business on) on an injected MemoryStore. */
async function prodWorld({ tag = '', clock = mutableClock(FIXED_NOW) } = {}) {
  const names = namesFor(tag);
  const env = { APP_ENV: 'production', DATABASE_URL: 'postgres://e2e-unused@127.0.0.1:9/none', ENABLE_BUSINESS: 'true', ENABLE_TRIPS: 'false' };
  const app = await startApp(env, { now: clock.now, store: new MemoryStore() });
  return register({ app, base: app.base, clock, names, close: () => app.close() });
}

// ---------------------------------------------------------------------------------------------------------
// A3 1: the site, /business, then "Create your company workspace": the Owner of a pending company.

async function signUpOwner(w) {
  const { names } = w;
  const owner = browser(w.base);
  let res = await owner.get('/');
  assert.equal(res.status, 200, 'GET /');
  assert.match(res.text, /<a[^>]*href="\/business"[^>]*>\s*Business\s*</, 'the header has the Business item');
  res = await owner.get('/business');
  assert.equal(res.status, 200, 'GET /business');
  assert.match(res.text, /href="\/business\/start"/, '/business links to /business/start');
  assert.match(textOf(res.text), /Company sign in|Sign in/, '/business has the company sign in');
  assert.ok(!privateHeaders(res), 'the /business marketing page is indexable');
  res = await owner.get('/business/start');
  assert.equal(res.status, 200);
  assert.match(textOf(res.text), /Create your company workspace/, '/business/start shows the sign-up form');
  assert.ok(privateHeaders(res), '/business/start is no-store and noindex');
  const pairs = setFields(formOf(res.text, '/business/start'), {
    name: 'Moataz Owner', email: names.email('moataz'), password: PASSWORD, companyName: names.company, size: '11-50 people', timezone: 'Africa/Cairo', ack: '1',
  });
  res = await owner.post('/business/start', pairs);
  assert.equal(res.status, 303, `POST /business/start: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /^\/business\/o\/[^/]+\/welcome$/, 'answers 303 to the welcome page');
  w.orgId = res.location.split('/')[3];
  w.B = `/business/o/${w.orgId}`;
  res = await owner.follow(res);
  pageChecks('welcome', res);
  assert.ok(privateHeaders(res), 'a workspace page is no-store and noindex');
  const all = textOf(res.text);
  assert.ok(all.includes(`Tripelyx is confirming ${names.company}`), 'the pending ribbon names the company');
  assert.match(all, /Preview: flights, hotels and prices are demo data\. Nothing is booked or charged\. No emails are sent\./, 'the demo ribbon');
  assert.match(all, /Owner/, 'the switcher shows the Owner role');
  assert.match(res.text, /bz-switch/, 'the company switcher is in the top bar');
  w.owner = owner;
  return owner;
}

// A3 2: the platform admin (ADMIN_EMAILS plus a platform_admin record, D1) confirms the company.

/**
 * Run `fn` (a refused request) and check that it wrote nothing: no store write at all, the memory store
 * unchanged, and (with `rid`) the request's status and rev as they were.
 * @returns {Promise<object>} the response
 */
async function refused(w, label, fn, { status, text = null, rid = null } = {}) {
  const snap = w.app.store.kind === 'memory' ? storeSnapshot(w.app) : null;
  const before = rid ? await w.app.store.getRecord('biz_request', rid) : null;
  const watch = watchWrites(w.app);
  let res, writes;
  try { res = await fn(); } finally { writes = watch.stop(); }
  assert.equal(res.status, status, `${label}: answers ${status} (${res.status}: ${short(textOf(mainOf(res.text)))})`);
  if (text) assert.match(textOf(mainOf(res.text)), text, `${label}: says why`);
  assert.deepEqual(writes, [], `${label}: writes nothing`);
  if (snap !== null) assert.equal(storeSnapshot(w.app), snap, `${label}: the store is unchanged`);
  if (rid) {
    const after = await w.app.store.getRecord('biz_request', rid);
    assert.deepEqual([after.status, after.rev], [before.status, before.rev], `${label}: the request is untouched`);
  }
  return res;
}

async function platformAdmin(w) {
  if (w.ops) return w.ops;
  // ADMIN_EMAILS alone makes nobody a platform admin (D1): the listed account, signed in before its grant,
  // gets the 404 a stranger gets, and its status POST changes nothing.
  const user = await w.app.accounts.register({ name: 'Pat Platform', email: w.names.opsEmail, password: PASSWORD });
  const ops = browser(w.base);
  let res = await ops.get('/business/signin');
  assert.equal(res.status, 200, 'GET /business/signin');
  res = await ops.post('/business/signin', setFields(formOf(res.text, '/business/signin'), { email: w.names.opsEmail, password: PASSWORD }));
  assert.equal(res.status, 303, `the platform admin signs in: ${short(textOf(mainOf(res.text)))}`);
  assert.equal(await w.app.accounts.isPlatformAdmin(user), false, 'listed in ADMIN_EMAILS, but no platform_admin record yet');
  assert.equal((await ops.get('/admin/business')).status, 404, 'ADMIN_EMAILS alone: /admin/business is a 404');
  if (w.orgId) {
    const org = await w.app.store.getRecord('biz_org', w.orgId);
    await refused(w, 'ADMIN_EMAILS alone: the status POST', () => ops.post(`/admin/business/${w.orgId}/status`, { status: 'active', rev: String(org.rev) }), { status: 404 });
  }
  await w.app.accounts.grantPlatformAdmin(user.id, { by: 'test', note: 'e2e' });
  res = await ops.get('/admin/business');
  assert.equal(res.status, 200, 'with the grant, the same session opens /admin/business');
  assert.match(res.text, /href="\/admin\/business"/, 'and the admin menu links to it');
  w.ops = ops;
  w.opsUserId = user.id;
  return ops;
}

async function confirmCompany(w, orgId, name) {
  const ops = await platformAdmin(w);
  let res = await ops.get('/admin/business');
  assert.equal(res.status, 200, `GET /admin/business: ${short(textOf(res.text))}`);
  assert.ok(privateHeaders(res), '/admin/business is no-store and noindex');
  assert.ok(textOf(res.text).includes(name), `${name} is listed`);
  const confirm = formsOf(res.text, `/admin/business/${orgId}/status`).find(f => /value="active"/.test(f));
  assert.ok(confirm, `a Confirm form for ${name}`);
  res = await ops.post(`/admin/business/${orgId}/status`, fieldsOf(confirm));
  assert.equal(res.status, 303, `POST status=active: ${short(textOf(mainOf(res.text)))}`);
  res = await ops.follow(res);
  assert.equal(res.status, 200, 'the list again');
  return res;
}

async function platformConfirm(w) {
  const { names, owner, B, orgId } = w;
  // Before the platform admin acts: the owner is no platform admin, and the company is pending.
  assert.equal((await owner.get('/admin/business')).status, 404, 'a company owner gets 404 on /admin/business');
  const ops = await platformAdmin(w);
  const list = await ops.get('/admin/business');
  assert.ok(textOf(list.text).includes(`Created by ${names.email('moataz')}`), 'the list says who created the company');
  await confirmCompany(w, orgId, names.company);
  const res = await owner.get(B);
  assert.equal(res.status, 200);
  assert.ok(!textOf(res.text).includes('Tripelyx is confirming'), 'the owner home no longer shows the pending ribbon');
  // The platform admin is not a member: a workspace URL is a 404.
  assert.equal((await ops.get(B)).status, 404, 'the platform admin gets 404 inside the company');
  const org = await w.app.store.getRecord('biz_org', orgId);
  const opsLink = await w.app.store.getRecord('user_email', names.opsEmail);
  assert.deepEqual([org.status, org.statusBy], ['active', opsLink.userId], 'confirmed by the platform admin');
}

// A3 3: policies (review the three tiers, edit one: v2 in history), departments with Q4 budgets.

async function policiesDepartmentsBudgets(w) {
  const { owner, B } = w;
  let res = await owner.get(`${B}/policies`);
  let main = pageChecks('/policies', res);
  for (const tier of ['Standard', 'Director', 'Executive']) assert.ok(textOf(main).includes(tier), `/policies lists ${tier}`);
  for (const tier of ['standard', 'director', 'executive']) {
    const r = await owner.get(`${B}/policies/${tier}`);
    assert.equal(r.status, 200, `/policies/${tier}`);
    pageChecks(`/policies/${tier}`, r);
  }
  res = await owner.get(`${B}/policies/director`);
  let pairs = formOf(res.text, `${B}/policies/director`);
  const newTotal = String((Number(getField(pairs, 'trip.maxTotal')) || 8000) + 500);
  pairs = setFields(pairs, { 'trip.maxTotal': newTotal, note: 'Raised the trip limit for client visits.' });
  res = await owner.post(`${B}/policies/director`, pairs);
  assert.equal(res.status, 303, `saving the Director policy: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /\?ok=saved$/);
  res = await owner.follow(res);
  assert.match(textOf(res.text), /Saved as a new version/, 'the saved notice');
  res = await owner.get(`${B}/policies/director/history`);
  main = pageChecks('/policies/director/history', res);
  assert.match(textOf(main), /Version 2|v2\b/, 'the history shows version 2');
  assert.match(textOf(main), /Raised the trip limit for client visits\./, 'the history shows the note');
  assert.match(textOf(main), /Trip limit/, 'the history names the changed field');

  res = await owner.get(`${B}/people`);
  pageChecks('/people', res);
  for (const name of ['Sales', 'Engineering']) {
    const form = formsOf(res.text, `${B}/departments`).find(f => !/name="departmentId"/.test(f));
    assert.ok(form, 'an Add department form');
    const r = await owner.post(`${B}/departments`, setField(fieldsOf(form), 'name', name));
    assert.equal(r.status, 303, `adding ${name}: ${short(textOf(mainOf(r.text)))}`);
    res = await owner.follow(r);
  }
  assert.ok(textOf(res.text).includes('Sales') && textOf(res.text).includes('Engineering'), 'People lists both departments');

  res = await owner.get(`${B}/budgets?period=2026-Q4`);
  pageChecks('/budgets', res);
  w.deptIds = {};
  for (const [name, amount] of [['Sales', '15000'], ['Engineering', '30000']]) {
    const form = formsOf(res.text, `${B}/budgets`).find(f => textOf(f).includes(name));
    assert.ok(form, `a budget form for ${name}`);
    let fp = fieldsOf(form);
    w.deptIds[name] = getField(fp, 'departmentId');
    assert.equal(getField(fp, 'period'), '2026-Q4', `the ${name} budget form is for Q4 2026`);
    fp = setField(fp, 'amount', amount);
    const r = await owner.post(`${B}/budgets`, fp);
    assert.equal(r.status, 303, `the ${name} budget saves: ${short(textOf(mainOf(r.text)))}`);
    res = await owner.follow(r);
  }
  main = pageChecks('/budgets after', res);
  assert.ok(/\$30,000/.test(textOf(main)) && /\$15,000/.test(textOf(main)), 'both budgets show');
}

// A3 4: invites, each accepted in a fresh browser that creates its account.

async function inviteAndJoin(w, key, name, local, role, extra = {}) {
  const { owner, B, names } = w;
  const email = names.email(local);
  let r = await owner.get(`${B}/people`);
  const body = formsOf(r.text, `${B}/people/invite`)[0];
  assert.ok(body, `${key}: the invite form`);
  let fp = setFields(fieldsOf(body), { email, role });
  if (extra.department) fp = setField(fp, 'departmentId', optionValue(body, 'departmentId', extra.department) || '');
  if (extra.manager) {
    fp = setField(fp, 'managerId', optionValue(body, 'managerId', extra.manager) || '');
    assert.ok(getField(fp, 'managerId'), `${key}: the manager is offered in the invite form`);
  }
  r = await owner.post(`${B}/people/invite`, fp);
  assert.equal(r.status, 200, `${key}: the invite link page: ${r.location} ${short(textOf(mainOf(r.text)))}`);
  assert.ok(/no-store/.test(r.headers.get('cache-control') || '') && r.headers.get('referrer-policy') === 'no-referrer', `${key}: no-store and no-referrer on the link page`);
  assert.match(textOf(r.text), /We don't send email yet\./, `${key}: the page says no email is sent`);
  pageChecks(`${key} invite link`, r);
  const m = /\/business\/invite\/([A-Za-z0-9_-]{16,})/.exec(r.text);
  assert.ok(m, `${key}: the link is on the page`);
  const token = m[1];
  const b = browser(w.base);
  r = await b.get(`/business/invite/${token}`);
  assert.equal(r.status, 200);
  assert.match(textOf(r.text), /Create your account to join/, `${key}: the invite page offers "Create your account to join"`);
  assert.ok(textOf(r.text).includes(names.company), `${key}: the invite names the company`);
  assert.match(textOf(r.text), /\(Cairo time\)/, `${key}: the expiry is in the company's time`);
  r = await b.post(`/business/invite/${token}/join`, setFields(formOf(r.text, `/business/invite/${token}/join`), { name, password: PASSWORD }));
  assert.equal(r.status, 303, `${key}: join: ${short(textOf(mainOf(r.text)))}`);
  r = await b.follow(r);
  assert.equal(r.status, 200);
  assert.ok(r.path.startsWith(B), `${key}: lands in the company (${r.path})`);
  assert.equal((await browser(w.base).get(`/business/invite/${token}`)).status, 410, `${key}: the used link answers 410`);
  w.people[key] = { b, name, email };
  return b;
}

async function invites(w) {
  const { owner, B } = w;
  await inviteAndJoin(w, 'travelAdmin', 'Tara Travel', 'tara', 'travel_admin');
  await inviteAndJoin(w, 'manager', 'Dana Lee', 'dana', 'manager', { department: 'Engineering' });
  await inviteAndJoin(w, 'finance', 'Fay Finance', 'fay', 'finance');
  await inviteAndJoin(w, 'employee', 'Sam Rivera', 'sam', 'employee', { department: 'Engineering', manager: 'Dana Lee' });
  const res = await owner.get(`${B}/people`);
  const main = pageChecks('/people (five)', res);
  for (const n of ['Moataz Owner', 'Tara Travel', 'Dana Lee', 'Fay Finance', 'Sam Rivera']) assert.ok(textOf(main).includes(n), `People lists ${n}`);
  for (const role of ['Travel Admin', 'Manager', 'Finance', 'Employee']) assert.ok(textOf(main).includes(role), `People shows the ${role} role`);
  assert.equal((await w.people.travelAdmin.b.get(`${B}/people`)).status, 200, 'the Travel Admin opens People');
  const r = await w.people.finance.b.get(`${B}/approvals`);
  assert.equal(r.status, 403, 'Finance cannot open Approvals');
  assert.match(r.text, /class="bz-app"/, 'the role refusal is drawn inside the workspace');
  assert.ok(textOf(r.text).includes(`Back to ${w.names.company} home`), 'with a way back');
}

/** A3 1 to 4: a confirmed company with departments, Q4 budgets and five members, all over HTTP. */
async function company(w) {
  await signUpOwner(w);
  await platformConfirm(w);
  await policiesDepartmentsBudgets(w);
  await invites(w);
  return w;
}

// ---------------------------------------------------------------------------------------------------------
// A3 5: the Employee plans CAI to LHR with a return and a London hotel.

/** A search page as the employee, and the trip form's fields minus the picks. */
async function search(w, who, q) {
  const r = await who.get(`${w.B}/trips/search?${new URLSearchParams(q)}`);
  assert.equal(r.status, 200, `the search: ${short(textOf(mainOf(r.text)))}`);
  return r;
}

/** Review trip: POST /trips with the picks, then the draft page. */
async function reviewTrip(w, who, page, picks, purpose) {
  let fp = formOf(page, `${w.B}/trips`).filter(([k]) => !['out', 'back', 'hotelKey'].includes(k));
  fp.push(['out', picks.out], ['back', picks.back], ['hotelKey', picks.hotelKey]);
  fp = setField(fp, 'purpose', purpose);
  const r = await who.post(`${w.B}/trips`, fp);
  assert.equal(r.status, 303, `Review trip (${purpose}): ${short(textOf(mainOf(r.text)))}`);
  assert.match(r.location || '', /\/trips\/btr_/, 'to the draft');
  const rid = r.location.split('/').pop();
  return { rid, res: await who.follow(r) };
}

/** Within-policy picks on every leg (a 3-star London hotel). */
function withinPicks(page) {
  const ch = choices(page);
  const pick = name => ch.find(c => c.name === name && c.state === 'within');
  const hotel3 = ch.find(c => c.name === 'hotelKey' && c.state === 'within' && /3-star/.test(c.card));
  assert.ok(pick('out') && pick('back') && hotel3, `within-policy choices on each leg: ${JSON.stringify(ch.map(c => [c.name, c.state])).slice(0, 300)}`);
  return { out: pick('out').value, back: pick('back').value, hotelKey: hotel3.value };
}

/** A within-policy draft (not sent yet). */
async function withinDraft(w, purpose, who = w.people.employee.b) {
  const res = await search(w, who, Q);
  const picks = withinPicks(res.text);
  const { rid, res: draft } = await reviewTrip(w, who, res.text, picks, purpose);
  const main = pageChecks('draft within', draft);
  assert.match(textOf(main), /Every part of this trip is inside your policy/, 'the draft says it is inside the policy');
  return { rid, page: draft, picks };
}

async function confirmWithin(w, rid, page, who = w.people.employee.b) {
  let res = await who.post(`${w.B}/trips/${rid}/submit`, formOf(page.text, `${w.B}/trips/${rid}/submit`));
  assert.equal(res.status, 303);
  assert.match(res.location || '', /\?ok=auto_approved$/, `Confirm trip answers auto_approved (${res.location})`);
  res = await who.follow(res);
  const main = pageChecks('approved by policy', res);
  assert.match(textOf(main), /Approved to book\./, '"Approved to book"');
  assert.match(textOf(main), /Nothing has been booked or charged\./, 'nothing booked or charged');
  return res;
}

async function employeeWithin(w) {
  const sam = w.people.employee.b;
  let res = await sam.get(w.B);
  pageChecks('employee home', res);
  assert.match(textOf(res.text), /Plan a trip/, 'the employee home offers Plan a trip');
  res = await sam.get(`${w.B}/trips/new`);
  const main = pageChecks('/trips/new', res);
  assert.match(textOf(main), /Your department: Engineering · Your policy: Standard/, 'the trip form names the department and policy');
  res = await search(w, sam, Q);
  const m = pageChecks('/trips/search economy', res);
  assert.match(m, /class="bz-limits"/, 'the limits bar');
  assert.match(textOf(m), /Within Policy/, 'Within Policy badges');
  assert.match(textOf(m), /Price to Beat/, 'the Price to Beat');
  assert.ok(/Demo price/.test(textOf(m)) && /Priced at/.test(textOf(m)), 'Demo price · Priced at');
  const { rid, res: draft } = await reviewTrip(w, sam, res.text, withinPicks(res.text), 'Client workshop in London');
  assert.match(textOf(pageChecks('draft within', draft)), /Every part of this trip is inside your policy/);
  await confirmWithin(w, rid, draft);
  w.rids.within = rid;
  return rid;
}

/**
 * An out-of-policy trip: Business class and a 5-star hotel (cabin 'business'), or Economy flights inside the
 * policy and a 5-star hotel outside it (cabin 'economy', so the cheapest option inside the policy exists);
 * alternatives, an optional swap, Request Approval. `goesTo` is the approver line the draft shows.
 */
async function outTrip(w, purpose, { swap = false, who = w.people.employee.b, cabin = 'business', goesTo = /Goes to Dana Lee \(your manager\)\./ } = {}) {
  let r = await search(w, who, cabin === 'business' ? BQ : Q);
  pageChecks(`/trips/search ${cabin}`, r);
  assert.match(textOf(mainOf(r.text)), /Out of Policy/, `${purpose}: Out of Policy badges`);
  const ch = choices(r.text);
  const flight = cabin === 'business' ? 'out' : 'within';
  const out = ch.find(c => c.name === 'out' && c.state === flight);
  const back = ch.find(c => c.name === 'back' && c.state === flight);
  const h5 = ch.find(c => c.name === 'hotelKey' && /5-star/.test(c.card) && c.state === 'out');
  assert.ok(out && back && h5, `${purpose}: ${cabin} flights (${flight}) and a 5-star hotel outside the policy to pick`);
  const made = await reviewTrip(w, who, r.text, { out: out.value, back: back.value, hotelKey: h5.value }, purpose);
  const rid = made.rid;
  r = made.res;
  let body = textOf(pageChecks(`${purpose} draft`, r));
  assert.match(body, /Out of policy: \d+ reasons?/, `${purpose}: says out of policy with reasons`);
  const altsAt = body.indexOf('AI-powered cheaper alternatives');
  assert.ok(altsAt > 0 && body.indexOf('Request Approval') > altsAt, `${purpose}: AI-powered cheaper alternatives come before Request Approval`);
  assert.match(body, goesTo, `${purpose}: names the approver`);
  if (swap) {
    const alt = formsOf(r.text, `${w.B}/trips/${rid}/swap`)[0];
    assert.ok(alt, `${purpose}: a "Use this option" form`);
    r = await who.post(`${w.B}/trips/${rid}/swap`, fieldsOf(alt));
    assert.equal(r.status, 303, `${purpose}: the swap: ${short(textOf(mainOf(r.text)))}`);
    assert.match(r.location || '', /\?ok=swapped$/);
    r = await who.follow(r);
    body = textOf(pageChecks(`${purpose} swapped`, r));
    assert.match(body, /Switched to the cheaper option/, `${purpose}: the swap notice`);
    assert.match(body, /Saved \$[\d,]+ by switching/, `${purpose}: the saving shows`);
  }
  let fp = formOf(r.text, `${w.B}/trips/${rid}/submit`);
  const stillOut = /Out of policy/.test(textOf(mainOf(r.text)));
  if (stillOut) {
    // A reason under the company's minimum is refused (422), says why, and nothing is sent or written.
    await refused(w, `${purpose}: a 7-character reason`, () => who.post(`${w.B}/trips/${rid}/submit`, setFields(fp, { reason: 'Need it', category: 'client_meeting' })), {
      status: 422, text: /Tell your approver why this trip needs an exception, in 10 to 500 characters\./, rid,
    });
    fp = setFields(fp, { reason: REASON, category: 'client_meeting' });
  }
  r = await who.post(`${w.B}/trips/${rid}/submit`, fp);
  assert.equal(r.status, 303, `${purpose}: Request Approval: ${short(textOf(mainOf(r.text)))}`);
  assert.match(r.location || '', stillOut ? /\?ok=submitted$/ : /\?ok=(submitted|auto_approved)$/);
  r = await who.follow(r);
  if (stillOut && who === w.people.employee.b) {
    assert.match(textOf(pageChecks(`${purpose} pending`, r)), /Sent for approval\. We don't send emails yet, so Dana Lee will see it under Approvals\./, `${purpose}: sent to Dana`);
  }
  return { rid, page: r, picks: { out: out.value, back: back.value, hotelKey: h5.value } };
}

async function employeeOut(w) {
  w.rids.approve = (await outTrip(w, 'Board meeting in London', { swap: true })).rid;
  // Economy flights inside the policy and a 5-star hotel: the manager sees the cheapest option inside policy.
  w.rids.deny = (await outTrip(w, 'Partner summit in London', { cabin: 'economy' })).rid;
  w.rids.ask = (await outTrip(w, 'Sales conference in London')).rid;
}

// A3 6: the Manager: inbox, then the request with the fresh price check, budget impact and the cheapest
// option inside policy. Approve one, deny one with a reason, ask a question on a third.

/** A budget's commits as cents (a commit is a number or { cents }). */
const commitCents = c => (typeof c === 'number' ? c : c.cents);
/** The Engineering (or another department's) Q4 budget record, and what it has committed and left. */
async function budgetOf(w, dept = 'Engineering', period = '2026-Q4') {
  const b = await w.app.store.getRecord('biz_budget', `${w.orgId}.${w.deptIds[dept]}.${period}`);
  const committedCents = Object.values(b.commits).reduce((n, c) => n + commitCents(c), 0);
  return { record: b, committedCents, remainingCents: b.amountCents - committedCents };
}

/**
 * The approver's view of a pending request, checked against the store: the fresh price check, the exact
 * budget impact ("Uses $total of $left left in Engineering for Q4 2026.", what is left after every hold), the
 * cheapest option inside the policy with its stored total (or why there is none), and the reason.
 */
async function managerView(w, rid, label, who = w.people.manager.b) {
  const r = await who.get(`${w.B}/trips/${rid}`);
  assert.equal(r.status, 200);
  const main = pageChecks(`request ${label}`, r);
  const body = textOf(main);
  const stored = await w.app.store.getRecord('biz_request', rid);
  const budget = await budgetOf(w);
  assert.match(body, /Price checked again at \d{1,2}:\d\d [AP]M today: unchanged\./, `${label}: the fresh price check`);
  assert.ok(stored.totalCents <= budget.remainingCents, `${label}: the trip fits what is left`);
  assert.ok(body.includes(`Uses ${money(stored.totalCents)} of ${money(budget.remainingCents)} left in Engineering for Q4 2026.`), `${label}: the budget impact names the trip and what is left after every hold (${money(budget.remainingCents)}): ${body.slice(body.indexOf('Budget'), body.indexOf('Budget') + 120)}`);
  const compare = textOf((main.match(/<section class="[^"]*\bbz-compare\b[\s\S]*?<\/section>/) || [''])[0]);
  assert.ok(compare.startsWith('Requested vs cheapest option inside policy'), `${label}: the comparison with the cheapest option inside policy`);
  if (stored.cheapestWithin) {
    const cheap = stored.cheapestWithin.totalCents;
    assert.ok(compare.includes(`Trip total Requested ${money(stored.totalCents)} Cheapest inside policy ${money(cheap)}`), `${label}: the trip total next to the cheapest option inside policy (${money(cheap)}): ${compare}`);
    assert.ok(compare.includes(`The option inside the policy costs ${money(stored.totalCents - cheap)} less.`), `${label}: what the option inside the policy saves`);
  } else {
    assert.ok(compare.includes(`Sam searched Business class, so there is no Economy fare to compare.`), `${label}: why there is nothing to compare: ${compare}`);
  }
  assert.ok(body.includes(REASON.slice(0, 40)), `${label}: the reason`);
  return r;
}

async function decide(w, rid, action, note) {
  const dana = w.people.manager.b;
  const page = await managerView(w, rid, action);
  let fp = setField(formOf(page.text, `${w.B}/trips/${rid}/decide`), 'action', action);
  if (note) fp = setField(fp, 'note', note);
  const r = await dana.post(`${w.B}/trips/${rid}/decide`, fp);
  assert.equal(r.status, 303, `${action}: ${short(textOf(mainOf(r.text)))}`);
  return pageChecks(`after ${action}`, await dana.follow(r));
}

async function managerDecisions(w) {
  const dana = w.people.manager.b, sam = w.people.employee.b;
  const { approve, deny, ask } = w.rids;
  let res = await dana.get(`${w.B}/approvals`);
  let main = pageChecks('/approvals', res);
  for (const rid of [approve, deny, ask]) assert.ok(main.includes(`href="${w.B}/trips/${rid}"`), `the inbox links to ${rid}`);
  assert.ok((textOf(main).match(/Sam Rivera/g) || []).length >= 3, 'the inbox shows Sam three times');
  assert.match(textOf(main), /Waiting for you 3 /, 'Waiting for you 3');
  assert.ok(/Approvals/.test(textOf(res.text)) && /bz-count|>3</.test(res.text), 'the Approvals item carries a count');
  assert.ok((await w.app.store.getRecord('biz_request', deny)).cheapestWithin, 'the economy trip has a cheapest option inside policy');
  // Sam cannot approve his own trip: no decide form is his, and a forged POST is refused by his role.
  await refused(w, 'the traveler deciding his own trip', () => sam.post(`${w.B}/trips/${approve}/decide`, { action: 'approve', rev: '0' }), {
    status: 403, text: /Your role \(Employee\) can't open this page\./, rid: approve,
  });

  main = await decide(w, approve, 'approve');
  assert.match(textOf(main), /Approved/, 'approve: the request shows Approved');
  // Deny needs a reason: a short note is refused, says why, and leaves the request waiting.
  const page = await managerView(w, deny, 'deny (short note)');
  await refused(w, 'deny with a 3-character note', () => dana.post(`${w.B}/trips/${deny}/decide`, setFields(formOf(page.text, `${w.B}/trips/${deny}/decide`), { action: 'deny', note: 'No.' })), {
    status: 422, text: /Tell the traveler why, in at least 10 characters\./, rid: deny,
  });
  main = await decide(w, deny, 'deny', 'Please pick a hotel inside the policy for this one; the summit is a short trip.');
  assert.ok(/Denied/.test(textOf(main)) && /Please pick a hotel inside the policy for this one/.test(textOf(main)), 'deny: Denied with the note');

  res = await dana.get(`${w.B}/trips/${ask}`);
  res = await dana.post(`${w.B}/trips/${ask}/message`, setField(formOf(res.text, `${w.B}/trips/${ask}/message`), 'text', 'Could you share the agenda for the conference?'));
  assert.equal(res.status, 303, `ask: ${short(textOf(mainOf(res.text)))}`);
  main = pageChecks('after ask', await dana.follow(res));
  assert.match(textOf(main), /Could you share the agenda/, 'ask: the question shows on the request');
  res = await sam.get(`${w.B}/trips/${ask}`);
  assert.match(textOf(mainOf(res.text)), /Could you share the agenda/, 'ask: the employee sees the question');
  res = await sam.post(`${w.B}/trips/${ask}/message`, setField(formOf(res.text, `${w.B}/trips/${ask}/message`), 'text', 'The agenda is in the shared folder; day one is the client keynote.'));
  assert.equal(res.status, 303, 'the employee answers the question');
  res = await sam.get(`${w.B}/trips`);
  main = pageChecks('/trips (employee)', res);
  assert.ok(/Approved/.test(textOf(main)) && /Denied/.test(textOf(main)) && /Waiting|Pending/.test(textOf(main)), 'the employee trip list shows each status');
  res = await sam.get(`${w.B}/trips/${deny}`);
  assert.match(textOf(mainOf(res.text)), /Please pick a hotel inside the policy for this one/, 'the employee sees the deny reason');
}

// A3 7: Finance: Q4 reports (committed vs budget, out-of-policy share, top reasons, saved by switching), then the CSV.

/** A CSV body as rows of cells (quotes and doubled quotes read back), BOM and CRLF line ends allowed. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && s[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Whole cents as the CSV writes dollars ('1347.58'). */
const dollars = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
/** What switching saved on one request: its swaps' savedCents (the Reports tile's rule), floored at 0. */
const switched = r => Math.max(0, (r.history || []).filter(h => h.action === 'swapped' && Number.isSafeInteger(h.savedCents)).reduce((n, h) => n + h.savedCents, 0));
/** Labels of the policy rules the walk's trips break, for the Top reasons tile. */
const REASON_LABELS = Object.freeze({
  'flight.cabin': /^Cabin above the policy$/, 'hotel.cap': /^Hotel over the nightly limit$/, 'hotel.stars': /^Hotel above the star limit$/,
  'flight.cap': /^Flight over the price limit$/, 'trip.cap': /^Trip over the total limit$/, 'flight.carrier': /airline/, budget: /budget/,
});

/** The tiles of a Reports page by their title: { 'Out-of-policy share': text, ... }. */
function tilesOf(main) {
  const out = {};
  for (const m of String(main).matchAll(/<section class="bz-card bz-tile" aria-label="([^"]+)">([\s\S]*?)<\/section>/g)) out[decode(m[1])] = { text: textOf(m[2]), html: m[2] };
  return out;
}

async function financeReports(w) {
  const fay = w.people.finance.b;
  let res = await fay.get(`${w.B}/reports?period=2026-Q4`);
  const main = pageChecks('/reports', res);
  // The figures, worked out from the store (not from the reports module): every request of the walk so far.
  const reqs = [];
  for (const rid of Object.values(w.rids)) reqs.push(await w.app.store.getRecord('biz_request', rid));
  const eng = await budgetOf(w);
  const approvedEng = reqs.filter(r => r.status === 'approved' && r.departmentId === w.deptIds.Engineering);
  assert.equal(eng.committedCents, approvedEng.reduce((n, r) => n + r.totalCents, 0), 'Engineering holds exactly its approved trips');
  assert.ok(eng.committedCents > 0);
  const awaiting = reqs.filter(r => r.status === 'pending' && r.departmentId === w.deptIds.Engineering).reduce((n, r) => n + r.totalCents, 0);
  const submitted = reqs.filter(r => r.submittedAt);
  const outOf = submitted.filter(r => ['out', 'blocked'].includes(r.evaluation.status)).length;
  const tenths = Math.floor((outOf * 2000 + submitted.length) / (2 * submitted.length));
  const counts = new Map();
  for (const r of submitted) for (const rule of new Set(r.evaluation.violations.map(v => v.rule))) counts.set(rule, (counts.get(rule) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5);
  const saved = reqs.filter(r => r.status === 'approved').reduce((n, r) => n + switched(r), 0);
  assert.ok(saved > 0, 'the swap saved something');

  const tiles = tilesOf(main);
  const byStatus = {};
  for (const r of reqs) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const pill = { pending: 'Waiting for approval', approved: 'Approved to book', denied: 'Denied' };
  for (const [status, n] of Object.entries(byStatus)) assert.ok(tiles['Requests by status'].text.includes(`${pill[status]}: ${n}`), `Requests by status: ${pill[status]}: ${n} (${tiles['Requests by status'].text})`);
  assert.equal(tiles['Out-of-policy share'].text, `Out-of-policy share ${percent(tenths)} ${outOf} of ${submitted.length} sent requests were outside the policy or blocked.`);
  assert.ok(tenths > 0 && tenths < 1000, 'some, not all, out of policy');
  const reasons = [...tiles['Top reasons'].html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => textOf(m[1]));
  assert.equal(reasons.length, top.length, `Top reasons lists ${top.length} rules: ${reasons.join(' | ')}`);
  top.forEach(([rule, n], k) => {
    const [label, count] = reasons[k].split(/: (?=\d+$)/);
    assert.equal(Number(count), n, `Top reason ${k + 1} counts ${n} (${reasons[k]})`);
    if (REASON_LABELS[rule]) assert.match(label, REASON_LABELS[rule], `Top reason ${k + 1} names ${rule}`);
  });
  assert.ok(tiles['Committed vs budget'].text.includes(`Engineering ${money(eng.committedCents)} committed and ${money(awaiting)} awaiting approval, of ${money(3000000)}`), `committed vs budget: ${tiles['Committed vs budget'].text}`);
  assert.ok(tiles['Committed vs budget'].text.includes(`Sales ${money(0)} committed and ${money(0)} awaiting approval, of ${money(1500000)}`));
  assert.ok(tiles['Saved by switching to cheaper options'].text.startsWith(`Saved by switching to cheaper options ${money(saved)} On approved trips`), `saved by switching: ${tiles['Saved by switching to cheaper options'].text}`);

  res = await fay.post(`${w.B}/reports/export`, formOf(res.text, `${w.B}/reports/export`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/, 'the CSV answers text/csv');
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="[^"]+\.csv"/, 'as an attachment');
  const leak = INTERNAL_CSV.exec(res.text);
  assert.ok(!leak, `the CSV holds nothing internal ("${leak && leak[0]}")`);
  if (w.opsUserId) assert.ok(!res.text.includes(w.opsUserId), 'and no staff user id');
  const [header, ...rows] = parseCsv(res.text);
  assert.deepEqual(header, [...CSV_COLUMNS], 'the header is the 21 columns');
  assert.equal(rows.length, reqs.length, `one row per request (${rows.length})`);
  const col = Object.fromEntries(CSV_COLUMNS.map((c, k) => [c, k]));
  for (const r of reqs) {
    const row = rows.find(x => x[col.request_id] === r.id);
    assert.ok(row, `the CSV has ${r.id}`);
    assert.equal(row.length, CSV_COLUMNS.length, `${r.id}: 21 cells`);
    const cell = name => row[col[name]];
    assert.equal(cell('price_source'), 'Demo price');
    assert.deepEqual([cell('traveler'), cell('department'), cell('from'), cell('to'), cell('depart_date'), cell('return_date'), cell('hotel_city'), cell('nights')],
      ['Sam Rivera', 'Engineering', 'CAI', 'LHR', '2026-11-12', '2026-11-16', 'London', '4'], `${r.id}: the trip`);
    assert.equal(cell('status'), r.status, `${r.id}: status`);
    assert.equal(cell('approval_mode'), r.approval.mode, `${r.id}: approval mode`);
    assert.equal(cell('approver'), r.approval.decidedBy && r.approval.decidedBy.system === 'policy' ? 'Approved by policy' : 'Dana Lee', `${r.id}: approver`);
    assert.equal(cell('policy_status'), r.evaluation.status, `${r.id}: policy status`);
    assert.equal(cell('total_usd'), dollars(r.totalCents), `${r.id}: total`);
    assert.equal(cell('cheapest_in_policy_usd'), r.cheapestWithin ? dollars(r.cheapestWithin.totalCents) : '', `${r.id}: cheapest inside policy`);
    assert.equal(cell('saved_by_switching_usd'), r.status === 'approved' ? dollars(switched(r)) : '', `${r.id}: saved by switching`);
    assert.equal(cell('currency'), 'USD');
  }
  const csvOf = rid => rows.find(x => x[col.request_id] === rid);
  assert.deepEqual([csvOf(w.rids.within)[col.status], csvOf(w.rids.within)[col.approval_mode]], ['approved', 'auto'], 'the trip inside policy: approved, auto');
  assert.deepEqual([csvOf(w.rids.approve)[col.status], csvOf(w.rids.approve)[col.approval_mode]], ['approved', 'manual'], 'the approved trip: manual');
  assert.equal(csvOf(w.rids.deny)[col.status], 'denied', 'the denied trip says denied');
  assert.equal(csvOf(w.rids.ask)[col.status], 'pending', 'the trip with a question is still pending');
  assert.ok(Number(csvOf(w.rids.approve)[col.saved_by_switching_usd]) > 0, 'the swapped trip shows what switching saved');
}

// A3 8: activity, settings and export, the company switcher (a user in two companies).

/** The rows of an Activity page, as text ("<summary> <time> · <who> · <group>"). */
const activityRows = page => [...mainOf(page).matchAll(/<li class="bz-activity-row">([\s\S]*?)<\/li>/g)].map(m => ({ text: textOf(m[1]), html: m[1] }));

/** Nothing of the platform admin in a page or a download: no staff user id, name or address. */
function noStaff(w, label, text) {
  const ids = [w.opsUserId].filter(Boolean).map(escRe);
  const re = new RegExp([...ids, 'Pat Platform', escRe(w.names.opsEmail)].join('|'));
  const m = re.exec(String(text));
  assert.ok(!m, `${label}: nothing of the platform admin ("${m && m[0]}")`);
}

async function activitySettings(w) {
  const { owner, B } = w;
  let res = await owner.get(`${B}/activity`);
  const at = textOf(pageChecks('/activity', res));
  for (const what of [/invite/i, /polic/i, /approv/i, /denied|deny/i, /budget/i]) assert.match(at, what, `activity mentions ${what}`);
  noStaff(w, '/activity', mainOf(res.text));
  res = await owner.get(`${B}/settings`);
  pageChecks('/settings', res);
  assert.ok(res.text.includes(w.names.company.replace(/&/g, '&amp;')) || textOf(res.text).includes(w.names.company), 'settings show the company name');
  // A real change: approvers get 48 hours instead of 24.
  let fp = formOf(res.text, `${B}/settings`);
  assert.equal(getField(fp, 'approvalHours'), '24', 'the approval window starts at 24 hours');
  res = await owner.post(`${B}/settings`, setField(fp, 'approvalHours', '48'));
  assert.equal(res.status, 303, `saving settings: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /\?ok=saved$/);
  res = await owner.follow(res);
  assert.match(textOf(res.text), /Settings saved\./, 'the saved notice');
  fp = formOf(res.text, `${B}/settings`);
  assert.equal(getField(fp, 'approvalHours'), '48', 'the form shows the new window');
  assert.equal((await w.app.store.getRecord('biz_org', w.orgId)).settings.approvalHours, 48, 'the company keeps it');
  // Its effect: a trip sent now waits 48 hours for a decision.
  const { rid } = await outTrip(w, 'Approval window check in London');
  const sent = await w.app.store.getRecord('biz_request', rid);
  assert.equal(Date.parse(sent.expiresAt) - Date.parse(sent.submittedAt), 48 * 3600000, 'a request sent after the change has 48 hours');
  const asked = await w.app.store.getRecord('biz_request', w.rids.ask);
  assert.equal(Date.parse(asked.expiresAt) - Date.parse(asked.submittedAt), 24 * 3600000, 'one sent before keeps its 24 hours');
  w.rids.window = rid;

  res = await owner.post(`${B}/settings/export`, formOf(res.text, `${B}/settings/export`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment/, 'the company export downloads');
  assert.doesNotMatch(res.text, /passwordHash|tokenHash|"token"/, 'the export holds no secrets');
  const data = JSON.parse(res.text);
  // Members see the company without who at Tripelyx changed its status or the note they wrote (types.Org).
  assert.deepEqual([data.org.statusBy, data.org.statusNote], [null, null], 'the export names no platform admin and holds no staff note');
  const leak = INTERNAL.exec(res.text.replace(/"status(?:By|Note)":\s*null/g, ''));
  assert.ok(!leak, `the export holds nothing internal ("${leak && leak[0]}")`);
  noStaff(w, 'the company export', res.text);
  const staffRows = data.audit.filter(e => e.actor && Object.hasOwn(e.actor, 'platformAdmin'));
  assert.ok(staffRows.some(e => e.action === 'org.confirmed'), 'the export keeps the confirmation');
  for (const e of staffRows) assert.deepEqual(e.actor, { platformAdmin: true, name: 'Tripelyx' }, `${e.action}: the platform admin is Tripelyx, with no id`);
  assert.ok(JSON.stringify(data).includes(w.rids.within), 'the export holds the company trips');
}

/**
 * A second company for the owner, confirmed by the platform admin, and Sam invited to it: his switcher, the
 * chooser and both workspaces. `beforeConfirm(orgId, base)` runs while the second company is still pending.
 */
async function switcher(w, { beforeConfirm = null } = {}) {
  const { owner, names, B } = w;
  const sam = w.people.employee.b;
  let res = await owner.get('/business/start');
  res = await owner.post('/business/start', setFields(formOf(res.text, '/business/start'), { companyName: names.second, size: '1-10 people', timezone: 'Africa/Cairo', ack: '1' }));
  assert.equal(res.status, 303, `the owner creates a second company: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /\/welcome$/);
  const org2 = res.location.split('/')[3];
  const B2 = `/business/o/${org2}`;
  w.B2 = B2;
  w.org2 = org2;
  if (beforeConfirm) await beforeConfirm(org2, B2);
  await confirmCompany(w, org2, names.second);
  res = await owner.get(`${B2}/people`);
  const ib = formsOf(res.text, `${B2}/people/invite`)[0];
  res = await owner.post(`${B2}/people/invite`, setFields(fieldsOf(ib || ''), { email: names.email('sam'), role: 'employee' }));
  assert.equal(res.status, 200, 'the owner invites Sam to the second company');
  const t2 = (/\/business\/invite\/([A-Za-z0-9_-]{16,})/.exec(res.text) || [])[1];
  res = await sam.get(`/business/invite/${t2}`);
  assert.equal(res.status, 200);
  assert.equal(formsOf(res.text, `/business/invite/${t2}/accept`).length, 1, 'signed in, Sam sees the accept form');
  res = await sam.post(`/business/invite/${t2}/accept`, formOf(res.text, `/business/invite/${t2}/accept`));
  assert.equal(res.status, 303);
  assert.equal(res.location, B2, 'accept answers 303 to the second company');
  res = await sam.get(B);
  const sw = (res.text.match(/<details class="[^"]*\bbz-switch\b[^"]*"[\s\S]*?<\/details>/) || [''])[0];
  assert.ok(textOf(sw).includes(names.company) && textOf(sw).includes(names.second), "Sam's switcher shows both companies");
  assert.match(sw, new RegExp(`href="${escRe(B2)}"`), 'the switcher links to the second company');
  res = await sam.get('/business/app');
  assert.equal(res.status, 200);
  assert.ok(privateHeaders(res), '/business/app is no-store and noindex');
  assert.ok(textOf(res.text).includes(names.second) && textOf(res.text).includes(names.company), '/business/app lists both');
  res = await sam.get(B2);
  assert.equal(res.status, 200);
  assert.ok(textOf(res.text).includes(names.second), 'Sam opens the second company');
  const sw2 = (res.text.match(/<details class="[^"]*\bbz-switch\b[^"]*"[\s\S]*?<\/details>/) || [''])[0];
  assert.match(sw2, new RegExp(`href="${escRe(B)}"`), 'and can switch back');
  // Isolation: nothing of the first company is reachable or shown from the second, for Sam (in both) and for
  // the owner (who owns both): no request id, no link to one, no department, no member of the first only.
  const firstIds = [...Object.values(w.rids), ...Object.values(w.deptIds || {})];
  const firstOnly = ['Dana Lee', 'Tara Travel', 'Fay Finance', ...Object.values(w.people).map(x => x.name).filter(n => n !== 'Sam Rivera')];
  const noneOfFirst = (label, text) => {
    for (const id of firstIds) assert.ok(!String(text).includes(id), `${label}: holds no first-company id (${id})`);
    for (const name of new Set(firstOnly)) assert.ok(!String(text).includes(name), `${label}: names no first-company member (${name})`);
    assert.doesNotMatch(String(text), new RegExp(`${escRe(B2)}/trips/btr_`), `${label}: links to no trip`);
  };
  assert.equal((await sam.get(`${B2}/trips/${w.rids.within}`)).status, 404, 'a first-company trip under the second company URL is 404');
  res = await sam.get(`${B2}/trips`);
  noneOfFirst("Sam's second-company trips", res.text);
  for (const path of ['/activity', '/approvals', '/people', '/budgets', '/reports', `/trips/${w.rids.approve}`]) {
    res = await owner.get(`${B2}${path}`);
    assert.ok([200, 404].includes(res.status), `${path}: ${res.status}`);
    if (path.startsWith('/trips/')) assert.equal(res.status, 404, 'a first-company trip id under the second company is 404');
    noneOfFirst(`the second company ${path}`, res.text);
  }
  res = await owner.get(`${B2}/reports`);
  res = await owner.post(`${B2}/reports/export`, formOf(res.text, `${B2}/reports/export`));
  assert.equal(res.status, 200, 'the second company CSV');
  noneOfFirst('the second company CSV', res.text);
  assert.equal(parseCsv(res.text).length, 1, 'the second company CSV has only its header');
  // Dana is in one company only: no second company in her switcher, and the second company is a 404 for her.
  assert.equal((await w.people.manager.b.get(B2)).status, 404, 'a member of the first company only gets 404 in the second');
  // Each company's Activity says Tripelyx confirmed it, and names nobody on the platform staff.
  for (const [base, name] of [[B, names.company], [B2, names.second]]) {
    res = await owner.get(`${base}/activity`);
    const rows = activityRows(res.text).filter(r => /confirmed/.test(r.text));
    assert.deepEqual(rows.map(r => r.text), [`Tripelyx confirmed ${name} 12:00 PM today · Company`], `${name}: the confirmation row`);
    assert.match(rows[0].html, /<time datetime="2026-10-09T/, `${name}: the row carries its time`);
    assert.doesNotMatch(mainOf(res.text), /usr_[A-Za-z0-9]/, `${name}: no user id in Activity`);
    noStaff(w, `${name} /activity`, mainOf(res.text));
  }
}

async function roleMenus(w) {
  const { B, owner } = w;
  const roleBrowsers = { owner, travelAdmin: w.people.travelAdmin.b, manager: w.people.manager.b, finance: w.people.finance.b, employee: w.people.employee.b };
  const seen = {};
  for (const [role, who] of Object.entries(roleBrowsers)) {
    const home = await who.get(B);
    assert.equal(home.status, 200, `${role}: home`);
    const nav = (home.text.match(/<nav\b[^>]*class="[^"]*bz-nav[^"]*"[\s\S]*?<\/nav>/) || home.text.match(/<nav\b[\s\S]*?<\/nav>/) || [''])[0];
    const hrefs = [...new Set([...nav.matchAll(/href="([^"#]+)"/g)].map(m => decode(m[1])).filter(h => h.startsWith(B)))];
    assert.ok(hrefs.length >= 4, `${role}: the menu has links (${hrefs.join(' ')})`);
    for (const h of hrefs) {
      const r = await who.get(h);
      assert.equal(r.status, 200, `${role}: ${h.replace(B, '') || '/'}: ${short(textOf(mainOf(r.text)))}`);
      pageChecks(`${role} ${h.replace(B, '') || '/'}`, r);
    }
    seen[role] = hrefs.map(h => h.replace(B, '') || '/');
  }
  // Each role's menu offers what §D gives it: only deciders see Approvals, only finance roles see Reports.
  assert.ok(seen.manager.includes('/approvals') && !seen.employee.includes('/approvals') && !seen.finance.includes('/approvals'), 'Approvals for deciders only');
  assert.ok(seen.finance.includes('/reports') && !seen.employee.includes('/reports') && !seen.manager.includes('/reports'), 'Reports for finance roles');
  assert.ok(!seen.employee.includes('/people') && !seen.employee.includes('/budgets'), 'no People or Budgets for an employee');
  return seen;
}

// A3 10: every amount reads "Demo price · Priced at …"; nothing is booked or charged; no email is sent.

async function demoHonesty(w) {
  const { B, owner } = w;
  const sam = w.people.employee.b, dana = w.people.manager.b, fay = w.people.finance.b;
  let total = 0;
  for (const [who, path] of [[sam, `${B}/trips/${w.rids.within}`], [dana, `${B}/approvals`], [fay, `${B}/reports?period=2026-Q4`], [owner, `${B}/budgets?period=2026-Q4`], [owner, `${B}/activity`], [sam, `${B}/policy`], [sam, `${B}/trips`], [dana, `${B}/trips/${w.rids.window}`], [owner, B]]) {
    const r = await who.get(path);
    assert.equal(r.status, 200, path);
    pageChecks(path, r);
    // Each amount on its own: inside a demo container whose label says Demo price.
    for (const { what, box } of amountsOf(mainOf(r.text))) {
      total += 1;
      assert.ok(box && /Demo price/.test(box), `${path}: "${what.slice(0, 60)}" is labelled Demo price`);
    }
    assert.match(textOf(r.text), /Nothing is booked or charged/, `${path}: the demo ribbon`);
  }
  assert.ok(total >= 20, `the pages show amounts to check (${total})`);
}

async function signOut(w) {
  const sam = w.people.employee.b;
  const res = await sam.post('/business/signout', formOf((await sam.get(w.B)).text, '/business/signout'));
  assert.equal(res.status, 303, 'sign out');
  const after = await sam.get(w.B);
  assert.equal(after.status, 303);
  assert.match(after.location || '', /\/business\/signin/, 'signed out, the workspace sends to sign in');
}

/** Sign a member back in through /business/signin, in the same browser. */
async function signIn(w, key) {
  const who = w.people[key];
  let res = await who.b.get('/business/signin');
  res = await who.b.post('/business/signin', setFields(formOf(res.text, '/business/signin'), { email: who.email, password: PASSWORD }));
  assert.equal(res.status, 303, `${key} signs in again: ${short(textOf(mainOf(res.text)))}`);
  assert.equal((await who.b.get(w.B)).status, 200);
}

/** The whole §A3 walk (items 1 to 8 and 10), in order, on one company. */
async function a3Walk(w, step = async (name, fn) => fn()) {
  await step('1. home, /business, sign up as Owner of a pending company', () => signUpOwner(w));
  await step('2. the platform admin confirms the company', () => platformConfirm(w));
  await step('3. policies (v2 in history), departments, Q4 budgets', () => policiesDepartmentsBudgets(w));
  await step('4. four invites, each accepted in a fresh browser that creates its account', () => invites(w));
  await step('5a. employee: a trip inside policy is approved to book', () => employeeWithin(w));
  await step('5b. employee: out of policy, alternatives, a swap, Request Approval', () => employeeOut(w));
  await step('6. manager: approve, deny with a reason, ask a question', () => managerDecisions(w));
  await step('7. finance: Q4 reports and the CSV', () => financeReports(w));
  await step('8a. activity, settings and the company export', () => activitySettings(w));
  await step('8b. the company switcher for a member of two companies', () => switcher(w));
  await step('8c. every role opens every page its menu offers', () => roleMenus(w));
  await step('10. every amount is a demo price; nothing booked or charged', () => demoHonesty(w));
  await step('sign out', () => signOut(w));
  return w;
}

// ---------------------------------------------------------------------------------------------------------
// Scenarios beyond the walk

/** The store methods that can change what a store holds (MemoryStore and PostgresStore alike). */
const WRITE_METHODS = Object.freeze([
  'putRecord', 'insertRecord', 'updateRecord', 'deleteRecord', 'commit', 'saveQuote', 'createBooking', 'updateBooking', 'savePaymentIntent', 'savePartnerLead',
]);

/**
 * Record every store write from now on, on any store: stop() puts the methods back and returns the names called.
 * @param {object} app
 * @returns {{ stop: () => string[] }}
 */
function watchWrites(app) {
  const s = app.store;
  const seen = [], undo = [];
  for (const name of WRITE_METHODS) {
    if (typeof s[name] !== 'function') continue;
    const own = Object.prototype.hasOwnProperty.call(s, name);
    const real = s[name];
    s[name] = function counted(...args) { seen.push(name); return real.apply(this, args); };
    undo.push(() => { if (own) s[name] = real; else delete s[name]; });
  }
  return { stop() { for (const f of undo) f(); return seen; } };
}

/**
 * Expiry via the clock: two requests left pending past the company's approval window show as expired with no
 * write. A decision on one and a message on the other are each refused with 409 and persist the expiry
 * (audited as the clock, shown as Automatic in Activity); a cancel of an expired request is refused with 409
 * and writes nothing.
 */
async function expiryFlow(w) {
  const svc = w.app.business;
  const sam = w.people.employee.b, dana = w.people.manager.b;
  const hours = (await w.app.store.getRecord('biz_org', w.orgId)).settings.approvalHours;
  const a = (await outTrip(w, 'Expiry check in London')).rid;
  const b = (await outTrip(w, 'Expiry message check in London')).rid;
  const stored = await w.app.store.getRecord('biz_request', a);
  for (const rid of [a, b]) {
    const r = await w.app.store.getRecord('biz_request', rid);
    assert.equal(r.status, 'pending');
    assert.equal(Date.parse(r.expiresAt) - Date.parse(r.submittedAt), hours * 3600000, `the company approval window is ${hours} hours`);
  }
  let inbox = await dana.get(`${w.B}/approvals`);
  for (const rid of [a, b]) assert.ok(mainOf(inbox.text).includes(`href="${w.B}/trips/${rid}"`), 'waiting in the inbox');

  // One hour past the window.
  w.clock.set(new Date(Date.parse(stored.expiresAt) + 3600000).toISOString());
  const before = w.app.store.kind === 'memory' ? storeSnapshot(w.app) : null;
  const writes = watchWrites(w.app);
  let res = await sam.get(`${w.B}/trips/${a}`);
  assert.equal(res.status, 200);
  let body = textOf(pageChecks('expired (traveler)', res));
  assert.match(body, /Expired at .*\. Nothing was approved\./, 'the traveler sees it expired');
  res = await dana.get(`${w.B}/trips/${a}`);
  assert.equal(res.status, 200);
  body = textOf(pageChecks('expired (manager)', res));
  assert.match(body, /Expired/, 'the manager sees it expired');
  assert.equal(formsOf(res.text, `${w.B}/trips/${a}/decide`).length, 0, 'no decide form on an expired request');
  inbox = await dana.get(`${w.B}/approvals`);
  for (const rid of [a, b]) assert.ok(!mainOf(inbox.text).includes(`href="${w.B}/trips/${rid}"`), 'no longer waiting in the inbox');
  inbox = await dana.get(`${w.B}/approvals?tab=expired`);
  assert.equal(inbox.status, 200);
  for (const rid of [a, b]) assert.ok(mainOf(inbox.text).includes(`href="${w.B}/trips/${rid}"`), 'listed under Expired');
  res = await sam.get(`${w.B}/trips`);
  assert.match(textOf(mainOf(res.text)), /Expired/, 'the trip list says Expired');
  assert.deepEqual(writes.stop(), [], 'reading an expired request writes nothing');
  if (before !== null) assert.equal(storeSnapshot(w.app), before, 'and the memory store holds exactly what it held');
  for (const rid of [a, b]) assert.equal((await w.app.store.getRecord('biz_request', rid)).status, 'pending', 'still stored as pending');

  // Any POST on it now: 409, and the expiry is persisted (audit by the clock). A decision on the first...
  res = await dana.post(`${w.B}/trips/${a}/decide`, { action: 'approve', rev: String(stored.rev) });
  assert.equal(res.status, 409, `deciding an expired request: ${short(textOf(mainOf(res.text)))}`);
  assert.match(textOf(mainOf(res.text)), /This request expired at/, 'the refusal says it expired');
  // ...and the traveler's message on the second.
  const pendingB = await w.app.store.getRecord('biz_request', b);
  res = await sam.post(`${w.B}/trips/${b}/message`, { text: 'Is there any news on this one?', rev: String(pendingB.rev) });
  assert.equal(res.status, 409, `a message on an expired request: ${short(textOf(mainOf(res.text)))}`);
  assert.match(textOf(mainOf(res.text)), /expired/i, 'the refusal says it expired');
  const audit = await svc.listAudit(await memberActor(w, 'moataz'), {});
  for (const rid of [a, b]) {
    const after = await w.app.store.getRecord('biz_request', rid);
    assert.equal(after.status, 'expired', 'the POST persisted the expiry');
    if (rid === b) assert.equal((after.messages || []).length, (pendingB.messages || []).length, 'no message was added');
    assert.ok(audit.rows.some(e => e.action === 'request.expired' && e.target.id === rid && e.actor && e.actor.system === 'clock'), 'audited as the clock');
  }
  // Activity names no person for it: the clock's rows read Automatic.
  res = await w.owner.get(`${w.B}/activity`);
  const auto = activityRows(res.text).filter(r => /expired with no decision/.test(r.text));
  assert.ok(auto.length >= 2, `both expiries are in Activity (${auto.length})`);
  for (const row of auto) assert.match(row.text, /^Sam Rivera's trip to London expired with no decision \d{1,2}:\d\d [AP]M (today|yesterday|\w{3} \d{1,2} \w{3}) · Automatic · Trips$/, `an Automatic row: ${row.text}`);
  // The traveler can no longer cancel it: terminal, refused, nothing written.
  const after = await w.app.store.getRecord('biz_request', a);
  await refused(w, 'cancelling an expired request', () => sam.post(`${w.B}/trips/${a}/cancel`, { rev: String(after.rev) }), { status: 409, rid: a });
  w.rids.expired = a;
  w.rids.expiredByMessage = b;
  return a;
}

/**
 * Swap the live inventory for the real seam's override (createBusinessInventory with overrides wrapping the
 * same providers), so a test can move one option's price. Returns the wrapped providers and a restore().
 */
function overrideInventory(w) {
  const svc = w.app.business;
  const was = svc.inventory;
  const flights = overrideProvider(was.flights), hotels = overrideProvider(was.hotels);
  const inv = createBusinessInventory(w.app.config, { overrides: { flights, hotels } });
  assert.equal(inv.status, 'demo');
  svc.inventory = inv;
  svc.composer.inventory = inv;
  return { flights, hotels, restore() { svc.inventory = was; svc.composer.inventory = was; } };
}

/** The account behind a demo email (by its local part), as the store keeps it. */
async function userOf(w, local) {
  const link = await w.app.store.getRecord('user_email', w.names.email(local));
  assert.ok(link, `an account for ${local}`);
  return w.app.store.getRecord('user', link.userId);
}

/** A MemberActor in the first company, for reading through the service. */
const memberActor = async (w, local) => ({ org: { id: w.orgId }, user: await userOf(w, local) });

const totalOf = async (w, rid) => (await w.app.store.getRecord('biz_request', rid)).totalCents;

/**
 * A price change returns a trip: the hotel option of a draft prices $29 more when it is sent, so Request
 * Approval (here Confirm trip) sends it back to the traveler with was and now; sent again it goes through at
 * the new price. Then a pending request's hotel moves while it waits: the manager's fresh check shows it, and
 * approving sends it back to the traveler with nothing approved, no budget held and nothing left in the inbox;
 * the traveler sends it again with the reason kept, and it waits for the manager at the new total. Last, an
 * option of a draft leaves the demo data: Confirm trip sends it back, unavailable.
 */
async function priceChangeFlow(w) {
  const sam = w.people.employee.b, dana = w.people.manager.b;
  const svc = w.app.business;
  const auditOf = async (rid, action) => (await svc.listAudit(await memberActor(w, 'moataz'), {})).rows.filter(e => e.action === action && e.target.id === rid);
  const ov = overrideInventory(w);
  try {
    // 1. Before it is sent.
    const { rid, page, picks } = await withinDraft(w, 'Price check workshop in London');
    const was = await totalOf(w, rid);
    const hotel = rowKeyParts(picks.hotelKey);
    ov.hotels.setPrice(hotel.offerId, hotel.optionId, 2900);
    let res = await sam.post(`${w.B}/trips/${rid}/submit`, formOf(page.text, `${w.B}/trips/${rid}/submit`));
    assert.equal(res.status, 303);
    assert.match(res.location || '', /\?ok=repriced$/, 'the trip went back to the traveler');
    res = await sam.follow(res);
    let body = textOf(pageChecks('repriced', res));
    assert.match(body, /This trip changed before it was sent\. Review it and send it again\./);
    assert.match(body, /The price changed\./);
    assert.match(body, new RegExp(`Was ${escRe(money(was))} ?, now ${escRe(money(was + 2900))} ?\\.`), 'was and now, exact');
    let stored = await w.app.store.getRecord('biz_request', rid);
    assert.equal(stored.status, 'draft');
    assert.equal(stored.returned.why, 'price_changed');
    assert.deepEqual([stored.returned.fromCents, stored.returned.toCents], [was, was + 2900]);
    assert.equal(stored.totalCents, was + 2900, 'the draft carries the new total');
    const repriced = await auditOf(rid, 'request.repriced');
    assert.equal(repriced.length, 1, 'audited once as request.repriced');
    assert.deepEqual(repriced[0].changes, [{ path: 'totalCents', before: was, after: was + 2900 }], 'with the old and new totals');
    // Sent again at the new price: approved by policy, holding the new total.
    res = await sam.post(`${w.B}/trips/${rid}/submit`, formOf(res.text, `${w.B}/trips/${rid}/submit`));
    assert.match(res.location || '', /\?ok=auto_approved$/, `sent again (${res.location})`);
    stored = await w.app.store.getRecord('biz_request', rid);
    assert.deepEqual([stored.status, stored.budget.cents], ['approved', was + 2900]);
    assert.equal(commitCents((await budgetOf(w)).record.commits[rid]), was + 2900, 'the budget holds the new total');
    w.rids.repriced = rid;

    // 2. While it waits for the manager.
    const pending = await outTrip(w, 'Price check summit in London');
    const before = await totalOf(w, pending.rid);
    const h5 = rowKeyParts(pending.picks.hotelKey);
    res = await dana.get(`${w.B}/trips/${pending.rid}`);
    assert.match(textOf(pageChecks('manager live check (same)', res)), /Price checked again at [^:]+:\d\d [AP]M today: unchanged\./, 'the fresh check: unchanged');
    ov.hotels.setPrice(h5.offerId, h5.optionId, 2900);
    res = await dana.get(`${w.B}/trips/${pending.rid}`);
    body = textOf(pageChecks('manager live check (changed)', res));
    assert.match(body, /Price checked again at [^:]+:\d\d [AP]M today: now \$[\d,.]+ ?\(was \$[\d,.]+ ?\)\. If you approve, it goes back to Sam to confirm the new price\./, 'the fresh check shows the new price');
    assert.match(body, new RegExp(`now ${escRe(money(before + 2900))} ?\\(was ${escRe(money(before))} ?\\)`), 'with the exact totals');
    const held = await budgetOf(w);
    res = await dana.post(`${w.B}/trips/${pending.rid}/decide`, setField(formOf(res.text, `${w.B}/trips/${pending.rid}/decide`), 'action', 'approve'));
    assert.equal(res.status, 303, `approve on a changed price: ${short(textOf(mainOf(res.text)))}`);
    assert.match(res.location || '', /\?ok=returned$/);
    assert.match(textOf(pageChecks('returned (manager)', await dana.follow(res))), /The price changed while this was waiting, so it went back to Sam\. Nothing was approved\./);
    stored = await w.app.store.getRecord('biz_request', pending.rid);
    assert.equal(stored.status, 'draft', 'nothing approved: back to the traveler');
    assert.equal(stored.returned.why, 'price_changed');
    assert.deepEqual([stored.returned.fromCents, stored.returned.toCents], [before, before + 2900]);
    assert.equal(stored.approval, null, 'the approval is cleared');
    // Nothing held, nothing waiting, and the return is on the record.
    const after = await budgetOf(w);
    assert.ok(!Object.hasOwn(after.record.commits, pending.rid), 'no budget hold for the returned trip');
    assert.equal(after.committedCents, held.committedCents, 'the committed total is unchanged');
    const fin = (await svc.listBudgets(await memberActor(w, 'fay'), '2026-Q4')).find(r => r.department.id === w.deptIds.Engineering);
    assert.equal(fin.committedCents, held.committedCents, 'Finance reads the same committed total');
    res = await w.owner.get(`${w.B}/budgets?period=2026-Q4`);
    assert.ok(textOf(mainOf(res.text)).includes(money(held.committedCents)), '/budgets shows the unchanged committed total');
    res = await dana.get(`${w.B}/approvals`);
    assert.ok(!mainOf(res.text).includes(`href="${w.B}/trips/${pending.rid}"`), 'no longer in the manager inbox');
    const returned = await auditOf(pending.rid, 'request.returned');
    assert.equal(returned.length, 1, 'audited as request.returned');
    assert.equal((await auditOf(pending.rid, 'request.approved')).length, 0, 'and never as approved');
    res = await sam.get(`${w.B}/trips/${pending.rid}`);
    assert.match(textOf(pageChecks('returned to the traveler', res)), /The price changed while this was waiting, so it came back to you\. Nothing was approved\./);
    // Sent again: the reason he wrote is kept in the form, and it waits for Dana at the new total.
    let fp = formOf(res.text, `${w.B}/trips/${pending.rid}/submit`);
    assert.equal(getField(fp, 'reason'), REASON, 'the form keeps the reason');
    res = await sam.post(`${w.B}/trips/${pending.rid}/submit`, fp);
    assert.equal(res.status, 303, `sent again: ${short(textOf(mainOf(res.text)))}`);
    assert.match(res.location || '', /\?ok=submitted$/);
    stored = await w.app.store.getRecord('biz_request', pending.rid);
    assert.deepEqual([stored.status, stored.totalCents, stored.reason.text, stored.returned], ['pending', before + 2900, REASON, null], 'pending again at the new total');
    res = await dana.get(`${w.B}/approvals`);
    assert.ok(mainOf(res.text).includes(`href="${w.B}/trips/${pending.rid}"`), 'back in the manager inbox');
    w.rids.returned = pending.rid;

    // 3. An option leaves the demo data before it is sent.
    const gone = await withinDraft(w, 'Unavailable check in London');
    const goneTotal = await totalOf(w, gone.rid);
    const gh = rowKeyParts(gone.picks.hotelKey);
    ov.hotels.setUnavailable(gh.offerId, gh.optionId);
    res = await sam.post(`${w.B}/trips/${gone.rid}/submit`, formOf(gone.page.text, `${w.B}/trips/${gone.rid}/submit`));
    assert.equal(res.status, 303, `Confirm trip with an option gone: ${short(textOf(mainOf(res.text)))}`);
    assert.match(res.location || '', /\?ok=repriced$/, 'it went back to the traveler');
    res = await sam.follow(res);
    body = textOf(pageChecks('unavailable', res));
    assert.match(body, /This trip changed before it was sent\. An option in it is no longer in the demo data\./, 'says an option is gone');
    stored = await w.app.store.getRecord('biz_request', gone.rid);
    assert.equal(stored.status, 'draft', 'nothing approved');
    assert.equal(stored.returned.why, 'unavailable');
    assert.equal(stored.returned.fromCents, goneTotal);
    assert.ok(!Object.hasOwn((await budgetOf(w)).record.commits, gone.rid), 'no budget hold');
    assert.equal((await auditOf(gone.rid, 'request.repriced')).length, 1, 'audited as request.repriced');
    w.rids.unavailable = gone.rid;
  } finally {
    ov.restore();
  }
}

/**
 * Who may decide (§D roles, lifecycle self_approval): a manager of another department cannot see or decide a
 * trip outside it; nobody decides their own trip (a Manager, or the Owner who holds the override), each refused
 * with 404 and nothing written; another admin decides the Owner's trip.
 */
async function deciderScopeFlow(w) {
  const dana = w.people.manager.b, owner = w.owner, tara = w.people.travelAdmin.b;
  if (!w.people.salesManager) await inviteAndJoin(w, 'salesManager', 'Mona Sales', 'mona', 'manager', { department: 'Sales' });
  const mona = w.people.salesManager.b;
  const sams = (await outTrip(w, 'Decider scope check in London')).rid;
  let rev = String((await w.app.store.getRecord('biz_request', sams)).rev);
  assert.equal((await mona.get(`${w.B}/trips/${sams}`)).status, 404, "a Sales manager cannot open an Engineering employee's trip");
  await refused(w, "a Sales manager deciding an Engineering employee's trip", () => mona.post(`${w.B}/trips/${sams}/decide`, { action: 'approve', rev }), { status: 404, rid: sams });
  let res = await mona.get(`${w.B}/approvals`);
  assert.ok(!mainOf(res.text).includes(sams), "nor see it in her inbox");

  // A Manager's own trip goes to the company's admins; she sees no decide form and her forged POST is refused.
  const danas = (await outTrip(w, 'Manager own trip to London', { who: dana, goesTo: /Goes to (?:Moataz Owner or Tara Travel|Tara Travel or Moataz Owner) \(/ })).rid;
  res = await dana.get(`${w.B}/trips/${danas}`);
  assert.equal(formsOf(res.text, `${w.B}/trips/${danas}/decide`).length, 0, 'no decide form on her own trip');
  rev = String((await w.app.store.getRecord('biz_request', danas)).rev);
  await refused(w, 'a Manager approving her own trip', () => dana.post(`${w.B}/trips/${danas}/decide`, { action: 'approve', rev }), { status: 404, rid: danas });

  // The Owner holds the override, but not over their own trip.
  const owners = (await outTrip(w, 'Owner own trip to London', { who: owner, goesTo: /Goes to Tara Travel \(/ })).rid;
  res = await owner.get(`${w.B}/trips/${owners}`);
  assert.equal(formsOf(res.text, `${w.B}/trips/${owners}/decide`).length, 0, 'no decide form on the Owner\'s own trip');
  rev = String((await w.app.store.getRecord('biz_request', owners)).rev);
  await refused(w, 'the Owner approving their own trip with an override note', () => owner.post(`${w.B}/trips/${owners}/decide`, { action: 'approve', rev, note: 'Approving my own trip as the Owner.' }), { status: 404, rid: owners });

  // The Travel Admin decides it.
  res = await tara.get(`${w.B}/trips/${owners}`);
  assert.equal(res.status, 200);
  res = await tara.post(`${w.B}/trips/${owners}/decide`, setField(formOf(res.text, `${w.B}/trips/${owners}/decide`), 'action', 'approve'));
  assert.equal(res.status, 303, `the Travel Admin approves the Owner's trip: ${short(textOf(mainOf(res.text)))}`);
  const done = await w.app.store.getRecord('biz_request', owners);
  assert.equal(done.status, 'approved');
  assert.equal(done.approval.decidedBy.userId, (await userOf(w, 'tara')).id, 'decided by the Travel Admin');
  w.rids.ownerOwn = owners;
  w.rids.managerOwn = danas;
  w.rids.scope = sams;
}

/** Budget committed for a department in a period, as Finance reads it through the service. */
async function committed(w, dept = 'Engineering', period = '2026-Q4') {
  const rows = await w.app.business.listBudgets(await memberActor(w, 'fay'), period);
  return rows.find(r => r.department.id === w.deptIds[dept]);
}

/** Cancel releases the budget hold: an approved trip's cancel (two steps) gives its amount back to the budget. */
async function cancelFlow(w) {
  const sam = w.people.employee.b;
  const start = await committed(w);
  const { rid, page } = await withinDraft(w, 'Cancel check workshop in London');
  await confirmWithin(w, rid, page);
  const hold = (await w.app.store.getRecord('biz_request', rid)).budget.cents;
  let row = await committed(w);
  assert.equal(row.committedCents, start.committedCents + hold, 'the approved trip holds its total');
  let res = await w.owner.get(`${w.B}/budgets?period=2026-Q4`);
  pageChecks('/budgets with the hold', res);

  // Two steps: the link, then "Yes, cancel this trip".
  res = await sam.get(`${w.B}/trips/${rid}`);
  assert.equal(formsOf(res.text, `${w.B}/trips/${rid}/cancel`).length, 0, 'no one-tap cancel on an approved trip');
  assert.match(res.text, new RegExp(`href="${escRe(`${w.B}/trips/${rid}`)}\\?confirm=cancel#cancel"`), 'a link to the confirm step');
  res = await sam.get(`${w.B}/trips/${rid}?confirm=cancel`);
  assert.match(textOf(mainOf(res.text)), /Cancel this trip\?/);
  res = await sam.post(`${w.B}/trips/${rid}/cancel`, formOf(res.text, `${w.B}/trips/${rid}/cancel`));
  assert.equal(res.status, 303, `cancel: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /\?ok=cancelled$/);
  res = await sam.follow(res);
  assert.match(textOf(pageChecks('cancelled', res)), /Nothing was booked or charged\./);
  const stored = await w.app.store.getRecord('biz_request', rid);
  assert.equal(stored.status, 'cancelled');
  row = await committed(w);
  assert.equal(row.committedCents, start.committedCents, 'the hold is released');
  const budget = await w.app.store.getRecord('biz_budget', `${w.orgId}.${w.deptIds.Engineering}.2026-Q4`);
  assert.ok(!Object.hasOwn(budget.commits, rid), 'no commit left for the cancelled trip');
  w.rids.cancelled = rid;
  return rid;
}

/**
 * A3 8, production: APP_ENV=production with no supplier. Sign-up works, the company waits for Tripelyx, and
 * every trip page says "Supplier not connected yet." with no prices and no demo talk.
 */
async function productionFlow(p) {
  assert.equal(p.app.config.isProduction, true);
  assert.equal(p.app.config.trips.enabled, false, 'trips off');
  assert.equal(p.app.business.inventory.status, 'none', 'production business inventory is "none"');
  const b = browser(p.base, { 'x-forwarded-proto': 'https' });
  let res = await b.get('/business/start');
  assert.equal(res.status, 200, 'production /business/start');
  res = await b.post('/business/start', setFields(formOf(res.text, '/business/start'), {
    name: 'Moataz Owner', email: p.names.email('moataz.prod'), password: PASSWORD, companyName: p.names.prodCompany, size: '11-50 people', timezone: 'Africa/Cairo', ack: '1',
  }));
  assert.equal(res.status, 303, `production sign-up: ${short(textOf(mainOf(res.text)))}`);
  assert.match(res.location || '', /^\/business\/o\/[^/]+\/welcome$/);
  const B = `/business/o/${res.location.split('/')[3]}`;
  res = await b.follow(res);
  assert.equal(res.status, 200, 'the welcome page');
  res = await b.get(`${B}/trips/new`);
  assert.equal(res.status, 200, 'production /trips/new');
  const main = pageChecks('/trips/new (production)', res, { demo: false });
  assert.ok(textOf(main).includes('Supplier not connected yet.'), '"Supplier not connected yet."');
  assert.match(main, /<fieldset class="bz-search-fields"[^>]*disabled/, 'the search fields are disabled');
  assert.doesNotMatch(textOf(main), /demo/i, 'no demo flights talked about');
  res = await b.get(`${B}/trips/search?${new URLSearchParams(Q)}`);
  assert.equal(res.status, 503, 'production search answers 503');
  assert.match(textOf(mainOf(res.text)), /Supplier not connected yet\./, 'with the same words');
  assert.doesNotMatch(res.text, /bz-money|Demo price/, 'no prices on the production search');
  const snap = storeSnapshot(p.app);
  res = await b.post(`${B}/trips`, { ...Q, out: 'f.flt_x|LIGHT', purpose: 'A trip with no supplier' });
  assert.equal(res.status, 503, 'Review trip answers 503 with no supplier');
  assert.equal(storeSnapshot(p.app), snap, 'and writes nothing');
  res = await b.get(B);
  assert.equal(res.status, 200);
  assert.match(textOf(mainOf(res.text)), /Supplier not connected yet\./, 'the production home says so too');
  assert.ok(textOf(res.text).includes(`Tripelyx is confirming ${p.names.prodCompany}`), 'the production company is pending');
  assert.doesNotMatch(textOf(res.text), /Preview: flights, hotels and prices are demo data/, 'no demo ribbon in production');
  res = await b.get(`${B}/policy`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(textOf(mainOf(res.text)), /demo/i, 'the production policy page names no demo fares');
  // Everything a company sets up still works with no supplier: a department and the policies.
  res = await b.get(`${B}/people`);
  const form = formsOf(res.text, `${B}/departments`).find(f => !/name="departmentId"/.test(f));
  res = await b.post(`${B}/departments`, setField(fieldsOf(form || ''), 'name', 'Sales'));
  assert.equal(res.status, 303, 'a department is added in production');
  assert.equal((await b.get(`${B}/policies/standard`)).status, 200, 'the policy editor opens in production');
}

module.exports = {
  PASSWORD, Q, BQ, REASON, PRESSURE,
  textOf, mainOf, formsOf, fieldsOf, formOf, setField, setFields, getField, pageChecks, privateHeaders, browser, choices, rowKeyParts,
  namesFor, devWorld, prodWorld,
  signUpOwner, platformAdmin, confirmCompany, platformConfirm, policiesDepartmentsBudgets, inviteAndJoin, invites, company,
  search, reviewTrip, withinDraft, confirmWithin, employeeWithin, outTrip, employeeOut, managerDecisions, financeReports,
  activitySettings, switcher, roleMenus, demoHonesty, signOut, signIn, a3Walk,
  expiryFlow, overrideInventory, priceChangeFlow, committed, cancelFlow, productionFlow, watchWrites,
  refused, budgetOf, deciderScopeFlow, parseCsv, amountsOf, claimsCheck, activityRows, INTERNAL, INTERNAL_CSV, WRITE_METHODS,
};
