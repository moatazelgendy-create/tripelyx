// The private preview's boot seed hook (server/lib/previewSeed.js, called once by server/index.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp } = require('./helpers');
const { runPreviewSeed, moduleLoader, DEMO_SCRIPT } = require('../server/lib/previewSeed');

function recordingLog() {
  const lines = [];
  const at = level => (...args) => lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error'), log: at('log') } };
}

function stubModule() {
  const calls = [];
  return { calls, mod: { seed: async deps => { calls.push(deps); return { companies: 2 }; } } };
}

const PREVIEW = { ENABLE_BUSINESS: 'true', PREVIEW_SEED: 'business' };

test('the hook points at scripts/business-demo.js', () => {
  assert.equal(DEMO_SCRIPT, path.join(__dirname, '..', 'scripts', 'business-demo.js'));
});

test('PREVIEW_SEED=business with Business on and the memory store calls seed() once with the app', async t => {
  const app = await startApp(PREVIEW);
  t.after(app.close);
  const { lines, log } = recordingLog();
  const { calls, mod } = stubModule();
  let loads = 0;
  const load = () => { loads += 1; return mod; };

  const r = await runPreviewSeed(app.config, app, { log, load });
  assert.deepEqual(r, { seeded: true, reason: 'seeded' });
  assert.equal(calls.length, 1);
  const deps = calls[0];
  assert.equal(deps.business, app.business);
  assert.equal(deps.accounts, app.accounts);
  assert.equal(deps.store, app.store);
  assert.equal(deps.ctx, app.ctx);
  assert.equal(deps.app, app.app);
  assert.equal(deps.config, app.config);
  assert.equal(deps.log, log);
  assert.equal(deps.now, app.ctx.now, 'the app clock, not the wall clock');
  assert.deepEqual(lines, ['info [preview] Business demo companies are ready.']);

  const again = await runPreviewSeed(app.config, app, { log, load });
  assert.deepEqual(again, { seeded: false, reason: 'already' });
  assert.equal(loads, 1, 'once per start-up');
  assert.equal(calls.length, 1);

  // The site still answers.
  assert.equal((await fetch(app.base + '/business')).status, 200);
});

test('a build without scripts/business-demo.js logs one line and boots normally', async t => {
  const app = await startApp(PREVIEW);
  t.after(app.close);
  const { lines, log } = recordingLog();
  const r = await runPreviewSeed(app.config, app, { log, load: () => null });
  assert.deepEqual(r, { seeded: false, reason: 'missing' });
  assert.deepEqual(lines, ['warn [preview] scripts/business-demo.js is not in this build; starting without the demo companies.']);
  assert.equal((await fetch(app.base + '/business')).status, 200);
  assert.equal((await fetch(app.base + '/healthz')).status, 200);
});

test('moduleLoader: a missing file is null, a present one is loaded, a broken one throws', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-preview-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(moduleLoader(path.join(dir, 'business-demo.js'))(), null);

  const stub = path.join(dir, 'stub-demo.js');
  fs.writeFileSync(stub, "exports.seed = async () => 'stub seeded';\n");
  const mod = moduleLoader(stub)();
  assert.equal(typeof mod.seed, 'function');

  const nested = path.join(dir, 'nested-demo.js');
  fs.writeFileSync(nested, "require('./not-there-either');\n");
  assert.throws(() => moduleLoader(nested)(), err => err.code === 'MODULE_NOT_FOUND', 'a module the seed needs that is missing is a real error');
});

test('a stub file on disk is seeded through the real loader', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-preview-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'business-demo.js');
  fs.writeFileSync(stub, 'exports.seed = async deps => { deps.store.__previewSeeded = Object.keys(deps).sort(); };\n');
  const app = await startApp(PREVIEW);
  t.after(app.close);
  const { log } = recordingLog();
  const r = await runPreviewSeed(app.config, app, { log, load: moduleLoader(stub) });
  assert.equal(r.seeded, true);
  for (const k of ['accounts', 'business', 'config', 'ctx', 'log', 'now', 'store']) assert.ok(app.store.__previewSeeded.includes(k), k);
});

test('the hook stays off, or says why in one line, outside its conditions', async t => {
  const never = () => { throw new Error('the seed module must not be loaded'); };

  // PREVIEW_SEED unset: nothing at all.
  const plain = await startApp({ ENABLE_BUSINESS: 'true' });
  t.after(plain.close);
  const quiet = recordingLog();
  assert.deepEqual(await runPreviewSeed(plain.config, plain, { log: quiet.log, load: never }), { seeded: false, reason: 'off' });
  assert.deepEqual(quiet.lines, []);

  // Business off.
  const noBiz = await startApp({ PREVIEW_SEED: 'business' });
  t.after(noBiz.close);
  const a = recordingLog();
  assert.deepEqual(await runPreviewSeed(noBiz.config, noBiz, { log: a.log, load: never }), { seeded: false, reason: 'business_off' });
  assert.equal(a.lines.length, 1);
  assert.match(a.lines[0], /needs ENABLE_BUSINESS=true/);

  // A real database: never seeded.
  const onApp = await startApp(PREVIEW);
  t.after(onApp.close);
  const b = recordingLog();
  const pgLike = { ...onApp, store: { kind: 'postgres' } };
  assert.deepEqual(await runPreviewSeed(onApp.config, pgLike, { log: b.log, load: never }), { seeded: false, reason: 'not_memory' });
  assert.equal(b.lines.length, 1);
  assert.match(b.lines[0], /only fills the in-memory store/);

  // Production (config.js already refuses PREVIEW_SEED there; the hook checks again).
  const c = recordingLog();
  const prodConfig = { ...onApp.config, appEnv: 'production', isProduction: true };
  assert.deepEqual(await runPreviewSeed(prodConfig, onApp, { log: c.log, load: never }), { seeded: false, reason: 'production' });
  assert.equal(c.lines.length, 1);
});

test('a module without seed(), one that fails to load, or a seed that throws: one line, and the site starts', async t => {
  const cases = [
    { load: () => ({}), reason: 'no_seed', line: /has no seed function/ },
    { load: () => { throw new SyntaxError('Unexpected token\n    at secret stack line'); }, reason: 'load_failed', line: /could not be loaded \(Unexpected token\)/ },
    { load: () => ({ seed: async () => { throw new Error('demo company exists\nstack'); } }), reason: 'seed_failed', line: /seed stopped \(demo company exists\)/ },
  ];
  for (const c of cases) {
    const app = await startApp(PREVIEW);
    t.after(app.close);
    const { lines, log } = recordingLog();
    const r = await runPreviewSeed(app.config, app, { log, load: c.load });
    assert.deepEqual(r, { seeded: false, reason: c.reason });
    assert.equal(lines.length, 1, c.reason);
    assert.match(lines[0], c.line);
    assert.doesNotMatch(lines[0], /stack/, 'only the first line of the message');
    assert.equal((await fetch(app.base + '/business')).status, 200);
  }
});

test('server/index.js runs the hook after createApp and before the server listens', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const create = src.indexOf('await createApp(config)');
  const seed = src.indexOf('await runPreviewSeed(config, built)');
  const listen = src.indexOf('app.listen(');
  assert.ok(create > 0 && seed > create && listen > seed, 'createApp, then the seed, then listen');
  assert.equal(src.split('runPreviewSeed(').length - 1, 1, 'called once');
});
