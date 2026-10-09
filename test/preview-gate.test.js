// The private preview's password gate (server/lib/previewGate.js, mounted by app.js when PREVIEW_PASSWORD is set).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, quietLog } = require('./helpers');
const { loadConfig } = require('../server/config');
const { createPreviewGate, passwordDigest, basicPassword, MAX_FAILURES, WINDOW_MS } = require('../server/lib/previewGate');

const PASSWORD = 'Preview-test-Pa55word';
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
const SAME = { 'sec-fetch-site': 'same-origin' };

function captureConsole(t) {
  const lines = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[k] = console[k];
    console[k] = (...args) => lines.push(args.map(String).join(' '));
  }
  t.after(() => Object.assign(console, saved));
  return lines;
}

test('config: PREVIEW_PASSWORD turns the gate on, keeps only a digest, and production refuses it', () => {
  const off = loadConfig({});
  assert.deepEqual(off.preview, { gate: null, seed: null });
  assert.deepEqual(loadConfig({ PREVIEW_PASSWORD: '', PREVIEW_SEED: '' }).preview, { gate: null, seed: null });

  const on = loadConfig({ PREVIEW_PASSWORD: PASSWORD, PREVIEW_SEED: 'business' });
  assert.ok(Buffer.isBuffer(on.preview.gate.passwordDigest));
  assert.deepEqual(on.preview.gate.passwordDigest, passwordDigest(PASSWORD));
  assert.equal(on.preview.seed, 'business');
  assert.doesNotMatch(JSON.stringify(on), new RegExp(PASSWORD), 'the password text is not kept in config');

  const prod = { APP_ENV: 'production', DATABASE_URL: 'postgres://x@db/production', HTTPS_ONLY: 'true' };
  assert.doesNotThrow(() => loadConfig(prod));
  assert.throws(() => loadConfig({ ...prod, PREVIEW_PASSWORD: PASSWORD }), err => {
    assert.match(err.message, /PREVIEW_PASSWORD is not allowed when APP_ENV=production/);
    assert.doesNotMatch(err.message, new RegExp(PASSWORD), 'the error never quotes the password');
    return true;
  });
  assert.throws(() => loadConfig({ ...prod, PREVIEW_SEED: 'business' }), /PREVIEW_SEED is not allowed when APP_ENV=production/);
  assert.throws(() => loadConfig({ PREVIEW_PASSWORD: 'short-pw' }), err => {
    assert.match(err.message, /at least 12 characters/);
    assert.doesNotMatch(err.message, /short-pw/);
    return true;
  });
  assert.throws(() => loadConfig({ PREVIEW_SEED: 'everything' }), /PREVIEW_SEED must be one of: business/);
  assert.equal(loadConfig({ APP_ENV: 'staging', DATABASE_URL: 'memory', PREVIEW_PASSWORD: PASSWORD }).preview.gate !== null, true);
});

test('the gate itself refuses production and a missing digest', () => {
  assert.throws(() => createPreviewGate({ passwordDigest: passwordDigest(PASSWORD), appEnv: 'production' }), /not allowed when APP_ENV=production/);
  assert.throws(() => createPreviewGate({ appEnv: 'staging' }), /SHA-256 digest/);
  assert.throws(() => createPreviewGate({ passwordDigest: Buffer.from(PASSWORD), appEnv: 'staging' }), /SHA-256 digest/);
});

test('an app built for production with a preview gate in its config refuses to start', async () => {
  const { createApp } = require('../server/app');
  const prod = loadConfig({ APP_ENV: 'production', DATABASE_URL: 'postgres://x@db/production', HTTPS_ONLY: 'true' });
  const { MemoryStore } = require('../server/booking/MemoryStore');
  const forced = { ...prod, preview: { gate: { passwordDigest: passwordDigest(PASSWORD) }, seed: null } };
  await assert.rejects(createApp(forced, { log: quietLog, store: new MemoryStore() }), /not allowed when APP_ENV=production/);
});

test('basicPassword reads any user name, keeps colons in the password, and tells malformed from absent', () => {
  assert.equal(basicPassword(basic('anyone', PASSWORD)), PASSWORD);
  assert.equal(basicPassword(basic('', PASSWORD)), PASSWORD);
  assert.equal(basicPassword(basic('me', 'a:b:c')), 'a:b:c');
  assert.equal(basicPassword(`basic ${Buffer.from(`x:${PASSWORD}`).toString('base64')}`), PASSWORD, 'the scheme is case-insensitive');
  assert.equal(basicPassword(undefined), null);
  assert.equal(basicPassword(''), null);
  assert.equal(basicPassword('Bearer abc'), null);
  assert.equal(basicPassword('Basic'), '');
  assert.equal(basicPassword('Basic !!!'), '');
  assert.equal(basicPassword(`Basic ${Buffer.from('no-colon').toString('base64')}`), '');
});

test('without the password every page, file and API answers 401 with a Basic challenge; the right one passes', async t => {
  const lines = captureConsole(t);
  const app = await startApp({ ENABLE_BUSINESS: 'true', PREVIEW_PASSWORD: PASSWORD });
  t.after(app.close);
  for (const p of ['/', '/business', '/business/start', '/api/config', '/css/site.css', '/robots.txt', '/no-such-page', '/healthz/', '/HEALTHZ']) {
    const r = await fetch(app.base + p, { redirect: 'manual' });
    assert.equal(r.status, 401, `${p} without a password`);
    assert.equal(r.headers.get('www-authenticate'), 'Basic realm="Tripelyx preview", charset="UTF-8"', p);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow', p);
    assert.equal(r.headers.get('cache-control'), 'no-store', p);
    assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/, p);
    const body = await r.text();
    assert.match(body, /private preview of Tripelyx/, p);
    assert.doesNotMatch(body, /\u2014/, 'no em dashes in the copy');
  }
  const wrong = await fetch(app.base + '/', { headers: { authorization: basic('owner', `${PASSWORD}x`) } });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get('www-authenticate'), /^Basic /);
  const truncated = await fetch(app.base + '/', { headers: { authorization: basic('owner', PASSWORD.slice(0, -1)) } });
  assert.equal(truncated.status, 401);
  const post = await fetch(app.base + '/business/start', { method: 'POST', headers: { ...SAME, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
  assert.equal(post.status, 401, 'a form post without the password never reaches the app');

  for (const user of ['owner', '', 'any name']) {
    const ok = await fetch(app.base + '/', { headers: { authorization: basic(user, PASSWORD) } });
    assert.equal(ok.status, 200, `user "${user}" with the right password`);
    assert.equal(ok.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(ok.headers.get('www-authenticate'), null);
    assert.match(await ok.text(), /^<!doctype html>/i);
  }
  const css = await fetch(app.base + '/css/site.css', { headers: { authorization: basic('x', PASSWORD) } });
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('x-robots-tag'), 'noindex, nofollow');
  const missing = await fetch(app.base + '/no-such-page', { headers: { authorization: basic('x', PASSWORD) } });
  assert.equal(missing.status, 404, 'past the gate the app answers as usual');
  assert.equal(missing.headers.get('x-robots-tag'), 'noindex, nofollow');

  // Nothing was logged, least of all the password or the Authorization header.
  const all = lines.join('\n');
  assert.doesNotMatch(all, new RegExp(PASSWORD));
  assert.doesNotMatch(all, /authorization|basic /i);
  assert.doesNotMatch(all, new RegExp(Buffer.from(`owner:${PASSWORD}`).toString('base64').slice(0, 20)));
});

test('the health check is open (GET and HEAD only) and still says noindex', async t => {
  const app = await startApp({ PREVIEW_PASSWORD: PASSWORD });
  t.after(app.close);
  const r = await fetch(app.base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await r.json()).ok, true);
  const head = await fetch(app.base + '/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('x-robots-tag'), 'noindex, nofollow');
  const post = await fetch(app.base + '/healthz', { method: 'POST' });
  assert.equal(post.status, 401, 'only GET and HEAD of the health check are open');
  const q = await fetch(app.base + '/healthz?x=1');
  assert.equal(q.status, 200, 'a query string does not change the path');
});

test('wrong passwords are limited per address; missing credentials are not counted', async t => {
  const app = await startApp({ PREVIEW_PASSWORD: PASSWORD, TRUST_PROXY: 'true' });
  t.after(app.close);
  const from = (ip, auth) => fetch(app.base + '/', { headers: { 'x-forwarded-for': ip, ...(auth ? { authorization: auth } : {}) } });

  for (let i = 0; i < MAX_FAILURES + 5; i++) assert.equal((await from('203.0.113.9')).status, 401, 'no credentials: a challenge, not a strike');
  assert.equal((await from('203.0.113.9', basic('x', PASSWORD))).status, 200);

  for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await from('203.0.113.7', basic('x', `guess-${i}`))).status, 401, `wrong password ${i + 1}`);
  const locked = await from('203.0.113.7', basic('x', `guess-x`));
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(locked.headers.get('www-authenticate'), null, 'no prompt while locked');
  const retry = Number(locked.headers.get('retry-after'));
  assert.ok(retry > 0 && retry <= WINDOW_MS / 1000, `Retry-After ${retry}`);
  assert.match(await locked.text(), /Too many wrong passwords from this address\. Please try again in 15 minutes\./);
  assert.equal((await from('203.0.113.7', basic('x', PASSWORD))).status, 429, 'while locked, even the right password is not checked');
  assert.equal((await from('203.0.113.8', basic('x', PASSWORD))).status, 200, 'another address is not affected');
  assert.equal((await fetch(app.base + '/healthz', { headers: { 'x-forwarded-for': '203.0.113.7' } })).status, 200, 'the health check stays open');
});

test('the limit window ends, and the address table stays bounded', () => {
  let t = 1_000_000;
  const gate = createPreviewGate({ passwordDigest: passwordDigest(PASSWORD), appEnv: 'staging', now: () => t, maxFailures: 3, windowMs: 60_000, maxTracked: 2 });
  const call = (ip, auth) => {
    const res = {
      statusCode: 200, headers: {}, body: null, nextCalled: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      type(v) { this.headers['content-type'] = v; return this; },
      send(b) { this.body = b; return this; },
    };
    let passed = false;
    gate({ path: '/', method: 'GET', ip, headers: auth ? { authorization: auth } : {} }, res, () => { passed = true; });
    return passed ? 'next' : res.statusCode;
  };
  for (let i = 0; i < 3; i++) assert.equal(call('a', basic('x', 'nope')), 401);
  assert.equal(call('a', basic('x', PASSWORD)), 429);
  t += 59_000;
  assert.equal(call('a', basic('x', PASSWORD)), 429, 'still inside the window');
  t += 1_000;
  assert.equal(call('a', basic('x', PASSWORD)), 'next', 'the window ended');
  // Three addresses with a table of two: the oldest is forgotten, never the gate's memory growing.
  assert.equal(call('b', basic('x', 'nope')), 401);
  assert.equal(call('c', basic('x', 'nope')), 401);
  assert.equal(call('d', basic('x', 'nope')), 401);
  for (let i = 0; i < 2; i++) call('d', basic('x', 'nope'));
  assert.equal(call('d', basic('x', PASSWORD)), 429, 'the newest address is still counted');
});

test('with PREVIEW_PASSWORD unset (or empty) the app is untouched: same status, headers and bytes', async t => {
  const pages = ['/', '/business', '/healthz', '/css/site.css', '/robots.txt', '/no-such-page', '/api/config'];
  const env = { ENABLE_BUSINESS: 'true' };
  const plainApp = await startApp(env);
  t.after(plainApp.close);
  const emptyApp = await startApp({ ...env, PREVIEW_PASSWORD: '', PREVIEW_SEED: '' });
  t.after(emptyApp.close);
  const gated = await startApp({ ...env, PREVIEW_PASSWORD: PASSWORD });
  t.after(gated.close);

  const snapshot = async (base, headers = {}) => {
    const out = {};
    for (const p of pages) {
      const r = await fetch(base + p, { headers: { 'accept-encoding': 'identity', ...headers }, redirect: 'manual' });
      const h = {};
      for (const [k, v] of r.headers) if (!['date', 'set-cookie', 'etag', 'last-modified', 'keep-alive', 'connection'].includes(k)) h[k] = v;
      out[p] = { status: r.status, headers: h, cookies: r.headers.getSetCookie().map(c => c.split('=')[0]), body: Buffer.from(await r.arrayBuffer()).toString('base64') };
    }
    return out;
  };
  const a = await snapshot(plainApp.base);
  const b = await snapshot(emptyApp.base);
  assert.deepEqual(b, a, 'an empty PREVIEW_PASSWORD changes nothing');
  for (const p of pages) assert.equal(a[p].headers['www-authenticate'], undefined, p);
  for (const p of ['/', '/healthz', '/css/site.css', '/robots.txt', '/api/config']) {
    assert.equal(a[p].headers['x-robots-tag'], undefined, `${p}: no preview header when unset`);
  }
  // Through the gate with the right password, the only difference is the noindex header.
  const c = await snapshot(gated.base, { authorization: basic('x', PASSWORD) });
  for (const p of pages) {
    const { 'x-robots-tag': robots, ...rest } = c[p].headers;
    assert.equal(robots, 'noindex, nofollow', p);
    const { 'x-robots-tag': before, ...restBefore } = a[p].headers;
    assert.ok(before === undefined || before === 'noindex, nofollow', p);
    assert.deepEqual({ ...c[p], headers: rest }, { ...a[p], headers: restBefore }, `${p}: the same page behind the gate`);
  }
});

test('createApp mounts nothing for the preview when it is off', async () => {
  const { createApp } = require('../server/app');
  const count = async env => {
    const { app } = await createApp(loadConfig({ APP_ENV: 'development', ...env }), { log: quietLog });
    const stack = (app.router || app._router).stack;
    return { n: stack.length, names: stack.map(l => l.name) };
  };
  const off = await count({});
  const on = await count({ PREVIEW_PASSWORD: PASSWORD });
  assert.equal(on.n, off.n + 1);
  assert.ok(on.names.includes('previewGate'));
  assert.ok(!off.names.includes('previewGate'));
});
