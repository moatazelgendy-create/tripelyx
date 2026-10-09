// Tripelyx Business static checks (plan §I7 "Static test", §L Stage 3): what the source and the built routers
// must look like, checked without running a single request.
//
// - Views: no inline style, <style>, inline <script>, on* handler or javascript: URL in any Business view, and
//   no em dash in any Business file (views, routes, service, browser script and styles). The rendered pages
//   are checked again by test/business-honesty.test.js.
// - Routers: every Business router (public, traveler, admin, the platform router) is built from its ROUTES
//   table: the Express stack holds exactly those routes, in table order, and nothing else anywhere in the app
//   answers a /business or /admin/business path. Every POST runs its limiter(s) → sameOrigin → the form
//   parser → its gate → the handler, in that order; every GET runs headers → limiters → gate → handler.
// - Isolation: `store.` only in repo.js; repo.get (no tenant check) only for the invite token lookup; no
//   personal record kinds, bookings, fetch or http under server/business.
// - No booking: nothing under server/business or the Business routes and views requires the booking engine,
//   payments or the outbox, directly or through anything it loads, nor names createQuote or createBooking.
// - No AI model name or id and no provider secret in any file of the repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');

/** Every file under dir (recursively), as absolute paths. */
function filesUnder(dir, keep = () => true) {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      // node_modules is a symlink in a worktree, and .git a pointer file there: neither is the project's code.
      if (e.name === 'node_modules' || e.name === '.git' || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && keep(p)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
const js = p => p.endsWith('.js');
const at = (...parts) => path.join(ROOT, ...parts);

const SERVICE_FILES = filesUnder(at('server/business'), js);
const ROUTE_FILES = [...filesUnder(at('server/routes/business'), js), at('server/routes/businessPlatform.js')];
const VIEW_FILES = filesUnder(at('server/views/business'), js);
const BROWSER_FILES = [at('public/js/business.js'), at('public/css/business.css'), at('public/css/business-marketing.css')];
const BUSINESS_JS = [...SERVICE_FILES, ...ROUTE_FILES, ...VIEW_FILES];
const read = p => fs.readFileSync(p, 'utf8');

/**
 * The code of a JS file without its comments (string contents kept), so a comment that names the outbox or
 * the store is no hit. A small scanner: quotes, template literals (with ${} nesting) and regex-free code.
 */
function code(src) {
  let out = '';
  let i = 0;
  const stack = []; // template depth: each entry counts open braces inside a ${ }
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    const inTemplate = stack.length && stack[stack.length - 1] === -1;
    if (inTemplate) {
      if (c === '\\') { out += c + n; i += 2; continue; }
      if (c === '`') { stack.pop(); out += c; i += 1; continue; }
      if (c === '$' && n === '{') { stack.push(0); out += '${'; i += 2; continue; }
      out += c; i += 1; continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; out += ' '; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '`') { stack.push(-1); out += c; i += 1; continue; }
    if (stack.length && c === '{') stack[stack.length - 1] += 1;
    if (stack.length && c === '}') {
      if (stack[stack.length - 1] === 0) { stack.pop(); out += c; i += 1; continue; }
      stack[stack.length - 1] -= 1;
    }
    out += c; i += 1;
  }
  return out;
}

/** Every require('…') string in a file's code. */
const requiresOf = src => [...code(src).matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)].map(m => m[2]);

/** Lines of `src` matching re, as "file:line: text" (for messages). */
function hits(file, src, re) {
  const lines = src.split('\n');
  return lines.flatMap((l, i) => (re.test(l) ? [`${rel(file)}:${i + 1}: ${l.trim().slice(0, 140)}`] : []));
}

// ---------------------------------------------------------------------------------------------------------
// Views and copy

test('views: no inline style, <style>, inline <script>, on* handler or javascript: URL in any Business view', () => {
  assert.ok(VIEW_FILES.length >= 20, `${VIEW_FILES.length} Business views`);
  const found = [];
  for (const f of VIEW_FILES) {
    const src = code(read(f));
    found.push(...hits(f, src, /\sstyle\s*=/i));
    found.push(...hits(f, src, /<style\b/i));
    found.push(...hits(f, src, /<script\b(?![^>]*\bsrc=)(?![^>]*application\/json)/i));
    found.push(...hits(f, src, /\son[a-z]+\s*=\s*["'$]/i));
    found.push(...hits(f, src, /javascript:/i));
  }
  // The routes render through the views, but a stray inline page there would bypass them.
  for (const f of ROUTE_FILES) {
    const src = code(read(f));
    found.push(...hits(f, src, /\sstyle\s*=|<style\b|<script\b|\son[a-z]+\s*=\s*["']|javascript:/i));
  }
  assert.deepEqual(found, [], 'inline style or script');
  // Every <script> the shell loads is a same-origin file, deferred.
  const shell = read(at('server/views/business/shell.js'));
  for (const m of shell.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /\ssrc="\/js\/business\.js\?v=|\ssrc="\$\{s\}\?v=/, m[0]);
  // The browser script never writes a style attribute or raw HTML.
  const browser = code(read(at('public/js/business.js')));
  assert.doesNotMatch(browser, /setAttribute\(\s*['"]style['"]|\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
});

/** An em dash, as the character, an HTML entity, a JS escape or a CSS escape (content: "\\2014"). */
const EM_DASH = /\u2014|&mdash;|&#8212;|&#x2014;|\\u2014|\\2014/i;

test('copy: no em dash in any Business file (views, routes, service, browser script and styles), in any spelling', () => {
  const files = [...BUSINESS_JS, ...BROWSER_FILES, at('server/views/pages.js')];
  const found = [];
  for (const f of files) {
    const src = read(f);
    if (f.endsWith('pages.js')) {
      // The corporate pages keep their own copy (B1); only the Business lead form's text is Business copy.
      const biz = src.match(/business:\s*\{[\s\S]*?\n\s*\},/g) || [];
      for (const s of biz) if (EM_DASH.test(s)) found.push(`${rel(f)}: LEAD_TYPES.business`);
      continue;
    }
    // A guard that refuses em dashes (the explainer's FORBIDDEN_TEXT) names one in a regex class: not copy.
    found.push(...hits(f, src, EM_DASH).filter(h => !/\/\[[^\]]*\\u2014[^\]]*\]\//.test(h)));
  }
  assert.deepEqual(found, [], 'em dashes');
});

// ---------------------------------------------------------------------------------------------------------
// Routers and their tables

const GATES = Object.freeze({ anyone: ['publicHeaders'], user: ['publicHeaders', 'requireUserPage'], member: ['bizMemberGate'], platform: ['bizPlatformGate'] });
const HEADERS = new Set(['bizPublicHeaders', 'bizPrivateHeaders', 'noStore']);

async function routerSet(t) {
  const app = await startApp({ ENABLE_BUSINESS: 'true' });
  t.after(app.close);
  const businessRoutes = require('../server/routes/business');
  const deps = businessRoutes.createRouterDeps(app.ctx);
  const sets = [
    ['public', require('../server/routes/business/public'), businessRoutes.MOUNT],
    ['traveler', require('../server/routes/business/traveler'), businessRoutes.MOUNT],
    ['admin', require('../server/routes/business/admin'), businessRoutes.MOUNT],
    ['platform', require('../server/routes/businessPlatform'), require('../server/routes/businessPlatform').MOUNT],
  ];
  return { app, deps, businessRoutes, sets };
}

const key = r => `${r.method} ${r.path}`;
const layerKeys = stack => stack.filter(l => l.route).flatMap(l => Object.keys(l.route.methods).filter(m => l.route.methods[m]).map(m => `${m.toUpperCase()} ${l.route.path}`));

test('routers: each Business router is built from its ROUTES table: exactly its routes, in table order, nothing else', async t => {
  const { app, deps, businessRoutes, sets } = await routerSet(t);
  for (const [label, mod, mount] of sets) {
    const r = mod.router(app.ctx, deps);
    assert.ok(Array.isArray(mod.ROUTES) && mod.ROUTES.length >= 2, `${label}: a ROUTES table`);
    assert.doesNotThrow(() => businessRoutes.assertRoutes([...mod.ROUTES], { mount }), `${label}: ROUTES passes assertRoutes`);
    assert.ok(r.stack.every(l => l.route), `${label}: nothing but routes on the router (no path-less r.use())`);
    assert.deepEqual(layerKeys(r.stack), mod.ROUTES.map(key), `${label}: the Express stack is the ROUTES table, in order`);
    for (const l of r.stack) assert.equal(Object.keys(l.route.methods).filter(m => l.route.methods[m]).length, 1, `${label} ${l.route.path}: one method per route`);
  }
  // The index router is the three routers in order, then the workspace error pages (an error handler only).
  assert.deepEqual(businessRoutes.ROUTES.map(key), [...sets[0][1].ROUTES, ...sets[1][1].ROUTES, ...sets[2][1].ROUTES].map(key));
  const index = businessRoutes.router(app.ctx, deps);
  assert.equal(index.stack.length, 4);
  index.stack.slice(0, 3).forEach((l, i) => assert.deepEqual(layerKeys(l.handle.stack), sets[i][1].ROUTES.map(key), `index layer ${i}`));
  assert.equal(index.stack[3].handle.length, 4, 'the last layer is an error handler (four arguments), so it never answers a request that went well');
  assert.equal(index.stack[3].handle.name, 'bizErrorPage');

  // The source agrees: no router file defines a route by hand.
  for (const f of ROUTE_FILES) {
    const src = code(read(f));
    assert.doesNotMatch(src, /\b(?:r|router|app)\.(?:get|post|put|patch|delete|all)\(/, `${rel(f)} defines a route outside its table`);
  }
});

test('routers: nothing else in the app answers a /business or /admin/business path (GET /business is the company page)', async t => {
  const { app } = await routerSet(t);
  const top = (app.app.router || app.app._router).stack;
  const where = [];
  const collect = (stack, prefix) => {
    for (const l of stack) {
      if (l.route) where.push(`${Object.keys(l.route.methods).map(m => m.toUpperCase()).join(',')} ${prefix}${l.route.path}`);
      else if (l.handle && l.handle.stack) collect(l.handle.stack, prefix);
    }
  };
  let business = 0, platform = 0;
  for (const l of top) {
    if (l.route) { collect([l], ''); continue; }
    if (!l.handle || !l.handle.stack) continue;
    const atRoot = l.match('/x-probe');
    if (!atRoot && l.match('/business/x-probe')) { business += 1; continue; }
    if (!atRoot && l.match('/admin/business/x-probe') && !l.match('/admin/x-probe')) { platform += 1; continue; }
    if (atRoot) collect(l.handle.stack, '');
    else if (l.match('/admin/x-probe')) collect(l.handle.stack, '/admin');
  }
  assert.equal(business, 1, 'one Business router, mounted at /business');
  assert.equal(platform, 1, 'one platform router, mounted at /admin/business');
  const stray = where.filter(w => /\s\/(?:admin\/)?business(?:\/|$)/.test(w) && w !== 'GET /business');
  assert.deepEqual(stray, [], 'only the ROUTES tables answer /business/... and /admin/business');
  assert.ok(where.includes('GET /business'), 'pagesRouter serves the company page');
});

test('routers: every POST runs limiter → sameOrigin → form parser → gate → handler; every GET headers → limiters → gate → handler', async t => {
  const { app, deps, sets } = await routerSet(t);
  const name = fn => {
    for (const [n, l] of Object.entries(deps.limits)) if (fn === l) return n;
    if (fn === deps.sameOrigin) return 'sameOrigin';
    if (fn === deps.form) return 'form';
    return fn.name || '(anonymous)';
  };
  let posts = 0, gated = 0;
  for (const [label, mod] of sets) {
    const r = mod.router(app.ctx, deps);
    for (const row of mod.ROUTES) {
      const layer = r.stack.find(l => l.route.path === row.path && l.route.methods[row.method.toLowerCase()]);
      const chain = layer.route.stack.map(s => name(s.handle));
      const what = `${label} ${key(row)}: ${chain.join(' → ')}`;
      const gate = GATES[row.who];
      const early = row.limiter.filter(l => l !== 'bizAuthAccount');
      const late = row.limiter.filter(l => l === 'bizAuthAccount');
      const want = [...early, ...(row.method === 'POST' ? ['sameOrigin', 'form'] : []), ...late, ...gate];
      // Only a headers middleware (it sets Cache-Control, X-Robots-Tag and, on public pages, Referrer-Policy and
      // calls next) may come before the limiters; the handler is last.
      assert.ok(HEADERS.has(chain[0]), `${what}: starts with the headers middleware`);
      assert.deepEqual(chain.slice(1, 1 + want.length), want, what);
      assert.equal(chain.length, want.length + 2, `${what}: then the handler, and nothing else`);
      const handler = chain[chain.length - 1];
      assert.ok(!gate.includes(handler) && !HEADERS.has(handler) && !Object.keys(deps.limits).includes(handler), `${what}: the handler is last`);
      if (row.method === 'POST') {
        posts += 1;
        assert.ok(row.limiter.length >= 1, `${what}: a limiter`);
        assert.ok(chain.indexOf(early[0]) < chain.indexOf('sameOrigin') && chain.indexOf('sameOrigin') < chain.indexOf('form') && chain.indexOf('form') < chain.indexOf(gate[gate.length - 1]), what);
      } else {
        assert.ok(!chain.includes('sameOrigin') && !chain.includes('form'), `${what}: a GET reads no form`);
      }
      if (row.path.startsWith('/o/:orgId')) {
        assert.ok(chain.includes('bizMemberGate'), `${what}: a workspace route passes the member gate`);
        // The mounted gate checks what the table says: its permissions and its own:'request' (the table is
        // what the isolation test's §D matrix is read against, so it must be what runs).
        const mounted = layer.route.stack.find(s => s.handle.name === 'bizMemberGate').handle;
        assert.deepEqual([...mounted.perms], Array.isArray(row.perm) ? [...row.perm] : [row.perm], `${what}: the gate's permissions are the row's`);
        assert.equal(mounted.own, row.own, `${what}: the gate's own is the row's`);
        gated += 1;
      }
    }
  }
  assert.ok(posts >= 22, `${posts} POST routes checked`);
  assert.ok(gated >= 30, `${gated} workspace gates checked against their rows`);
  // The one documented exception: bizAuthAccount keys on the parsed email, so it runs after the form.
  const signin = sets[0][1].ROUTES.find(r => key(r) === 'POST /signin');
  assert.deepEqual([...signin.limiter], ['bizAuthIp', 'bizAuthAccount']);
});

// ---------------------------------------------------------------------------------------------------------
// Isolation in the source

test('isolation: store. only in repo.js; repo.get only for the invite token; no personal kinds, bookings, fetch or http under server/business', () => {
  const found = [];
  for (const f of [...SERVICE_FILES, ...ROUTE_FILES, ...VIEW_FILES]) {
    const src = code(read(f));
    const r = rel(f);
    if (r !== 'server/business/repo.js') found.push(...hits(f, src, /\bstore\s*\.|\.store\b|\bstore\s*\[/));
    // Tenant reads go through getIn; get (no tenant check) is for the one lookup by token hash.
    for (const h of hits(f, src, /\.get\(\s*KINDS\.|\brepo\.get\(/)) {
      if (!(r === 'server/business/team.js' && /this\.repo\.get\(KINDS\.invite, hash\)/.test(h))) found.push(h);
    }
    found.push(...hits(f, src, /\b(?:listBookings|getBooking|listQuotes|getQuote|listIntents|putRecord|getRecord|listRecords|insertRecord|updateRecord|deleteRecord)\b/)
      .filter(h => r !== 'server/business/repo.js'));
    found.push(...hits(f, src, /\bfetch\(|require\(\s*['"](?:node:)?https?['"]\s*\)|XMLHttpRequest|\baxios\b/));
    // A personal record kind named in code (the Repo refuses every kind but biz_* at run time as well).
    found.push(...hits(f, src, /['"](?:user_email|session|saved_trip|travel_defaults|last_search|recent_trip|trip_request|outbox|platform_admin|payment_intent)['"]/));
    found.push(...hits(f, src, /\brepo\.(?:get|getIn|list|page|insert|cas|del)\(\s*['"](?!biz_)[a-z_]+['"]/));
  }
  assert.deepEqual(found, [], 'reads outside the Repo, or of a personal kind');
  // Every kind the Business code names is a biz_ kind.
  const { KINDS } = require('../server/business/constants');
  for (const [k, v] of Object.entries(KINDS)) assert.match(v, /^biz_[a-z_]+$/, k);
});

// ---------------------------------------------------------------------------------------------------------
// No booking, payments or outbox

test('no booking: Business code never requires the booking engine, payments or the outbox, directly or through what it loads', () => {
  const allowedBooking = new Set(['server/booking/MemoryStore.js']); // repo.js: jsonProblem, the shared JSON rule
  const found = [];
  for (const f of [...BUSINESS_JS]) {
    const src = read(f);
    for (const spec of requiresOf(src)) {
      if (!spec.startsWith('.')) continue;
      let resolved;
      try { resolved = rel(require.resolve(path.resolve(path.dirname(f), spec))); } catch { found.push(`${rel(f)}: require('${spec}') does not resolve`); continue; }
      if (/^server\/payments\//.test(resolved) || /^server\/trips\/integrations\//.test(resolved) || /outbox/i.test(resolved)) found.push(`${rel(f)}: ${resolved}`);
      if (/^server\/booking\//.test(resolved) && !allowedBooking.has(resolved)) found.push(`${rel(f)}: ${resolved}`);
    }
    const c = code(src);
    found.push(...hits(f, c, /\b(?:BookingEngine|createQuote|createBooking|confirmBooking|cancelBooking|paymentIntent|PaymentIntent|outbox|enqueue)\b/));
    found.push(...hits(f, c, /\.book\(|ctx\.(?:engine|payments|tripService|agent|hunts)\b|\bpayments\s*\./));
  }
  assert.deepEqual(found, [], 'booking, payment or outbox code reached from Business');

  // Everything the Business modules load, in a fresh process: no engine, payments or outbox module among it.
  const list = execFileSync(process.execPath, ['-e', `
    const files = ${JSON.stringify(BUSINESS_JS)};
    for (const f of files) require(f);
    process.stdout.write(JSON.stringify(Object.keys(require.cache)));
  `], { cwd: ROOT, encoding: 'utf8' });
  const loaded = JSON.parse(list).map(rel).filter(p => !p.startsWith('node_modules/') && !p.includes('/node_modules/'));
  assert.ok(loaded.includes('server/business/service.js') && loaded.includes('server/routes/business/index.js'), 'the closure was loaded');
  const bad = loaded.filter(p => /^server\/payments\//.test(p) || /^server\/booking\/(?!MemoryStore\.js$)/.test(p) || /^server\/trips\/integrations\//.test(p) || /outbox/i.test(p));
  assert.deepEqual(bad, [], 'modules a Business module loads');
});

// ---------------------------------------------------------------------------------------------------------
// No model name or id, no provider secret

// The model family names are written in hex, so this file holds none of them itself.
const FAMILIES = ['636c61756465', '616e7468726f706963', '6f70656e6169', '63686174677074', '67656d696e69', '6c6c616d61', '6d69737472616c', '6d69787472616c', '646565707365656b', '7177656e']
  .map(h => Buffer.from(h, 'hex').toString('utf8'));
const TIERS_OF_MODELS = ['6f707573', '736f6e6e6574', '6861696b75'].map(h => Buffer.from(h, 'hex').toString('utf8'));
const GPT = Buffer.from('677074', 'hex').toString('utf8');
const MODEL_RE = new RegExp(`(?:${FAMILIES.join('|')})|\\b(?:${TIERS_OF_MODELS.join('|')})[-_ .]?\\d|\\b${GPT}[-_ ]?(?:\\d|4o|3\\.5)`, 'i');
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bghp_[A-Za-z0-9]{30,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAIza[0-9A-Za-z_-]{35}\b/,
  // Supplier tokens, an Authorization header written out, and a secret-named key or variable given a long
  // random value (letters and digits, 32 or more).
  /\bduffel_(?:test|live)_[A-Za-z0-9_-]{8,}/, /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\b\w*(?:SECRET|TOKEN|API_?KEY|PRIVATE_KEY|PASSWORD|[Ss]ecret|[Tt]oken|[Aa]pi[Kk]ey)\w*['"]?\s*[=:]\s*['"`]?(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{32,}/,
];
/** A fixture that checks a secret never leaks names itself fake (FAKE_..., fakeToken, a dummy or example value). */
const FAKE_FIXTURE = /\b(?:fake|dummy|example|placeholder)|FAKE_|_FAKE\b/i;
/** Each pattern's own check: a made-up key of its shape (built here, so this file holds none) and a named fake. */
const SECRET_SAMPLES = (() => {
  const r = (n, set = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z') => set.repeat(4).slice(0, n);
  return [
    ['sk', '-', r(24)], ['sk_', 'live_', r(16)], ['sk_', 'test_', r(16)], ['rk_', 'live_', r(16)], ['AK', 'IA', r(16, 'ABCDEFGHIJKLMNOP2345')],
    ['gh', 'p_', r(36)], ['xo', 'xb-', r(12)], ['-----BEGIN RSA PRIV', 'ATE KEY-----', ''], ['AI', 'za', r(35)],
    ['duffel_', 'test_', r(20)], ['duffel_', 'live_', r(20)], ['Authorization: Bear', 'er ', r(40)],
    ['SUPPLIER_TOK', 'EN=', r(40)], ['const apiK', "ey = '", `${r(40)}'`],
  ].map(parts => parts.join(''));
})();
const TEXT_FILE = p => !/\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz)$/i.test(p);

test('no AI model name or id and no provider secret in any file of the repository; the explainer is the rule-based one only', () => {
  const files = filesUnder(ROOT, TEXT_FILE).filter(p => !rel(p).startsWith('node_modules/'));
  assert.ok(files.length > 200, `${files.length} files scanned`);
  const found = [];
  // The patterns find what they are for: each made-up key matches one, and the line that holds it fails.
  for (const sample of SECRET_SAMPLES) {
    assert.ok(SECRET_RES.some(re => re.test(sample)) && !FAKE_FIXTURE.test(sample), `a secret pattern finds ${sample.slice(0, 12)}...`);
  }
  for (const f of files) {
    const src = read(f);
    if (MODEL_RE.test(src)) found.push(...hits(f, src, MODEL_RE).map(h => `model: ${h}`));
    // A test fixture that checks a secret never leaks is exempt only when it names itself fake.
    for (const re of SECRET_RES) if (re.test(src)) found.push(...hits(f, src, re).filter(h => !FAKE_FIXTURE.test(h)).map(h => `secret: ${h}`));
  }
  assert.deepEqual(found, [], 'model names, model ids or secrets');
  // No .env file is kept, and .env.example holds placeholders only for anything secret.
  assert.ok(!files.some(p => /(^|\/)\.env$/.test(rel(p))), 'no .env file');
  for (const line of read(at('.env.example')).split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !/SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE/.test(m[1])) continue;
    assert.match(m[2].trim(), /^(?:|<[^>]+>)$/, `.env.example ${m[1]} is a placeholder`);
  }
  // The only explainer is the rule-based one, and the config refuses anything else.
  const { EXPLAINERS, createExplainer } = require('../server/business/explain');
  assert.deepEqual([...EXPLAINERS], ['rules']);
  const { loadConfig } = require('../server/config');
  assert.equal(loadConfig({ APP_ENV: 'development' }).business.explainer, 'rules');
  assert.throws(() => loadConfig({ APP_ENV: 'development', BUSINESS_EXPLAINER: 'remote' }), /BUSINESS_EXPLAINER/);
  assert.equal(createExplainer(loadConfig({ APP_ENV: 'development' })).name, 'rules');
  // No Business module names an API key or a remote model endpoint.
  for (const f of BUSINESS_JS) assert.doesNotMatch(code(read(f)), /API_KEY|apiKey|process\.env/, rel(f));
});
