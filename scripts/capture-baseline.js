#!/usr/bin/env node
// Captures the preservation baseline for Tripelyx Business (plan §F8 and §L Stage 0 step 2) from an untouched
// copy of the site, so test/preserve.test.js and test/book-preserve.test.js can prove that every existing page
// renders exactly as before.
//
// Usage: node scripts/capture-baseline.js <root of the untouched site> [out dir, default test/fixtures/baseline]
//
// The site at <root> runs in this process, once per env set, on a fresh MemoryStore, with the clock held at
// FIXED_NOW (the app's injected clock and the global Date both, because a few views read new Date() directly).
// It writes:
//   - manifest.json: per env set, the status, content type and sha256 of the normalised body of every page in
//     PAGES (signed out) and SIGNED_IN (signed in as a non-admin "Ada Lovelace"), plus where each BOOK and API
//     entry's full text lives;
//   - <env>/<name>.html|.json: the full normalised text of the §F8 booking pages and search JSON.
// Normalising changes two things only: the ?v= cache-buster on stylesheet and script links, and the copyright year.
//
// The tests require this file for the same lists, boot, requests and normalising, so a capture and a check
// always ask the same questions in the same order.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const FIXED_NOW = '2026-10-09T09:00:00.000Z';
const BASE_COMMIT = 'a0ea0bc';

// The three env sets: the default development build, the live site (test/corporate-home.test.js:10) and
// Travel by Budget off.
const ENVS = {
  dev: {},
  live: { APP_ENV: 'staging', ENABLE_TRIPS: 'true', ALLOW_DEMO_INVENTORY: 'true', PAYMENT_MODE: 'test', DATABASE_URL: 'memory', PUBLIC_BASE_URL: 'https://www.tripelyx.com' },
  tripsOff: { ENABLE_TRIPS: 'false' },
};

const PAGES = ['/', '/brands', '/technology', '/partners', '/about', '/contact', '/ai-travel-agent', '/plan', '/how-it-works', '/faq', '/destinations', '/signin', '/signup', '/robots.txt', '/sitemap.xml', '/business'];
const SIGNED_IN = ['/ai-travel-agent', '/my-trips', '/plan'];
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'analytical-engine-1843' };

// Fixed dates, inside the demo schedule as seen from FIXED_NOW (Fri 9 Oct 2026).
const FLIGHT_QUERIES = {
  'flights-cai-dbb': 'from=CAI&to=DBB&departDate=2026-10-23&passengers=2&cabin=economy',
  'flights-cai-lhr': 'from=CAI&to=LHR&departDate=2026-11-12&passengers=1&cabin=economy',
};
const HOTEL_QUERIES = {
  'hotels-new-alamein': 'where=New+Alamein&checkIn=2026-10-23&checkOut=2026-10-26&guests=2',
  'hotels-cairo': 'where=Cairo&checkIn=2026-11-12&checkOut=2026-11-16&guests=1',
  'hotels-dubai': 'where=Dubai&checkIn=2026-11-12&checkOut=2026-11-16&guests=1', // no demo hotels: 0 results
};
// [name, path]: the booking pages kept in full text. The bare /book/flights and /book/hotels (form defaults from
// the clock) are the pages the screenshots open.
const BOOK = [
  ['book', '/book'],
  ['book-flights', '/book/flights'],
  ['book-hotels', '/book/hotels'],
  ...Object.entries(FLIGHT_QUERIES).map(([k, q]) => [`book-${k}`, `/book/flights?${q}`]),
  ...Object.entries(HOTEL_QUERIES).map(([k, q]) => [`book-${k}`, `/book/hotels?${q}`]),
];
const API = [
  ...Object.entries(FLIGHT_QUERIES).map(([k, q]) => [`api-${k}`, `/api/search/flights?${q}`]),
  ...Object.entries(HOTEL_QUERIES).map(([k, q]) => [`api-${k}`, `/api/search/hotels?${q}`]),
];
// One flight and one hotel offer page: the first offer of these searches (found in the captured JSON).
const OFFER_FROM = { 'offer-flight': ['flights', 'flights-cai-lhr'], 'offer-hotel': ['hotels', 'hotels-new-alamein'] };

const HEADERS = { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' };
const quietLog = { error() {}, warn() {}, info() {}, log() {} };

/** The only two things that may differ between runs of the same code: asset cache-busters and the year. */
function normalise(text) {
  return String(text)
    .replace(/(\.(?:css|js)\?v=)[0-9a-z]+(?=")/g, '$1V')
    .replace(/© \d{4} Tripelyx Inc\./g, '© YEAR Tripelyx Inc.');
}

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * With Business on, the only changes Business may make to an existing page's chrome (plan §B1): the "Business"
 * menu item, the site-header-biz class, the .header-name span around the account name and the trip footer's
 * "Tripelyx Business" link. Removes exactly those and counts each, so a test can check both that nothing else
 * changed and that each change appears where it should.
 * @returns {{ text: string, counts: { navItem: number, headerClass: number, headerName: number, footerLink: number } }}
 */
function stripBusiness(text) {
  const counts = { navItem: 0, headerClass: 0, headerName: 0, footerLink: 0 };
  const out = String(text)
    .replace(/<li><a href="\/business"(?: aria-current="page")?>Business<\/a><\/li>/g, () => { counts.navItem++; return ''; })
    .replace(/<li><a href="\/business">Tripelyx Business<\/a><\/li>/g, () => { counts.footerLink++; return ''; })
    .replace(/(<header class="site-header(?: site-header-trips)?) site-header-biz(" data-header>)/g, (m, a, b) => { counts.headerClass++; return a + b; })
    .replace(/<span class="header-name">([^<]*)<\/span>/g, (m, name) => { counts.headerName++; return name; });
  return { text: out, counts };
}

/** The counts stripBusiness should find on an HTML page rendered with Business on. */
function expectedBusinessCounts(text) {
  const page = String(text);
  if (!/<header class="site-header/.test(page)) return { navItem: 0, headerClass: 0, headerName: 0, footerLink: 0 };
  return {
    navItem: 1,
    headerClass: 1,
    headerName: /<div class="header-account header-cta">/.test(page) ? 1 : 0,
    footerLink: /<footer class="site-footer trip-footer">/.test(page) ? 1 : 0,
  };
}

/**
 * Holds the global Date at `iso`: new Date() and Date.now() return it; every other form of Date is unchanged.
 * @returns {() => void} restores the real Date
 */
function freezeDate(iso = FIXED_NOW) {
  const Real = globalThis.Date;
  const t = Real.parse(iso);
  class FrozenDate extends Real {
    constructor(...args) { if (args.length === 0) super(t); else super(...args); }
    static now() { return t; }
  }
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = Real; };
}

/**
 * Boots the site at `root` with `env` the way test/helpers.js startApp does, on a fresh MemoryStore and the
 * held clock, listening on a free port.
 */
async function bootApp(root, env) {
  const { loadConfig } = require(path.join(root, 'server/config'));
  const { createApp } = require(path.join(root, 'server/app'));
  const { MemoryStore } = require(path.join(root, 'server/booking/MemoryStore'));
  const config = loadConfig({ APP_ENV: 'development', ...env });
  const built = await createApp(config, { log: quietLog, now: () => new Date(FIXED_NOW), store: new MemoryStore() });
  const server = await new Promise(resolve => { const s = built.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...built, config, base, close: () => new Promise(r => server.close(r)) };
}

async function fetchText(base, p, cookie) {
  const res = await fetch(base + p, { headers: { ...HEADERS, ...(cookie ? { cookie } : {}) }, redirect: 'manual' });
  return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], text: normalise(await res.text()) };
}

/** Signs Ada up through the real form and returns her session cookie, or null when there are no accounts. */
async function signUpAda(app) {
  if (!app.accounts) return null;
  const res = await fetch(`${app.base}/signup`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: ADA.name, email: ADA.email, password: ADA.password, next: '/my-trips' }).toString(),
    redirect: 'manual',
  });
  const session = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('txs='));
  if (res.status !== 303 || !session) throw new Error(`signing up ${ADA.name} failed (${res.status})`);
  return session;
}

/**
 * Asks one running app every baseline question, in a fixed order.
 * @param {object} app from bootApp (or test/helpers.js startApp)
 * @param {{ offers?: Record<string,string>, only?: 'pages'|'full' }} [opts] offer page paths to use (default:
 *   found from the search JSON); `only` asks just the PAGES and SIGNED_IN questions, or just the BOOK, API and offers
 * @returns {Promise<{ pages, signedIn, full, offers }>} pages and signedIn map path → {status,type,sha256,text};
 *   full maps name → {path,status,type,text}; offers maps name → path
 */
async function collect(app, opts = {}) {
  const want = part => !opts.only || opts.only === part;
  const pages = {};
  if (want('pages')) {
    for (const p of PAGES) {
      const r = await fetchText(app.base, p);
      pages[p] = { status: r.status, type: r.type, sha256: sha256(r.text), text: r.text };
    }
  }
  const full = {};
  const offers = opts.offers ? { ...opts.offers } : {};
  if (want('full')) {
    for (const [name, p] of [...BOOK, ...API]) full[name] = { path: p, ...(await fetchText(app.base, p)) };
  }
  if (want('full') && !opts.offers) {
    for (const [name, [vertical, from]] of Object.entries(OFFER_FROM)) {
      const json = JSON.parse(full[`api-${from}`].text);
      if (!json.offers || !json.offers.length) throw new Error(`no ${vertical} offer to open for ${name}`);
      const q = vertical === 'flights' ? FLIGHT_QUERIES[from] : HOTEL_QUERIES[from];
      offers[name] = `/book/${vertical}/${encodeURIComponent(json.offers[0].id)}?${q}`;
    }
  }
  if (want('full')) for (const [name, p] of Object.entries(offers)) full[name] = { path: p, ...(await fetchText(app.base, p)) };
  let signedIn = null;
  const cookie = want('pages') ? await signUpAda(app) : null;
  if (cookie) {
    signedIn = {};
    for (const p of SIGNED_IN) {
      const r = await fetchText(app.base, p, cookie);
      signedIn[p] = { status: r.status, type: r.type, sha256: sha256(r.text), text: r.text };
    }
  }
  return { pages, signedIn, full, offers };
}

/** sha256 of every file under server/providers/mock (the demo inventory /book runs on), by relative path. */
function providerSources(root) {
  const dir = path.join(root, 'server', 'providers', 'mock');
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(root, f).split(path.sep).join('/')] = sha256(fs.readFileSync(f, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

const ext = type => (type === 'application/json' ? 'json' : 'html');
const withoutText = r => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'text'));
const stripText = map => (map ? Object.fromEntries(Object.entries(map).map(([k, r]) => [k, withoutText(r)])) : null);

async function main() {
  const root = path.resolve(process.argv[2] || '');
  const out = path.resolve(process.argv[3] || path.join(__dirname, '..', 'test', 'fixtures', 'baseline'));
  if (!process.argv[2] || !fs.existsSync(path.join(root, 'server', 'app.js'))) {
    console.error('Usage: node scripts/capture-baseline.js <root of the untouched site> [out dir]');
    process.exit(2);
  }
  // As under the test runner: the Savings Hunter's timer stays off.
  process.env.NODE_TEST = process.env.NODE_TEST || '1';
  freezeDate(FIXED_NOW);
  const manifest = { commit: BASE_COMMIT, fixedNow: FIXED_NOW, normalised: ['?v= on .css/.js links', 'copyright year'], providerSources: providerSources(root), envs: {} };
  for (const [envName, env] of Object.entries(ENVS)) {
    const app = await bootApp(root, env);
    try {
      const got = await collect(app);
      fs.mkdirSync(path.join(out, envName), { recursive: true });
      const full = {};
      for (const [name, r] of Object.entries(got.full)) {
        const file = `${envName}/${name}.${ext(r.type)}`;
        fs.writeFileSync(path.join(out, file), r.text);
        full[name] = { path: r.path, status: r.status, type: r.type, file, sha256: sha256(r.text) };
      }
      manifest.envs[envName] = { env, pages: stripText(got.pages), signedIn: stripText(got.signedIn), full, offers: got.offers };
      console.log(`${envName}: ${Object.keys(got.pages).length} pages, ${got.signedIn ? Object.keys(got.signedIn).length : 0} signed in, ${Object.keys(full).length} full text`);
    } finally { await app.close(); }
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

module.exports = { FIXED_NOW, BASE_COMMIT, ENVS, PAGES, SIGNED_IN, BOOK, API, FLIGHT_QUERIES, HOTEL_QUERIES, ADA, normalise, sha256, stripBusiness, expectedBusinessCounts, freezeDate, bootApp, collect, providerSources };

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
