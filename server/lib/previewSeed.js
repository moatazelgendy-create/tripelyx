// The private preview's boot seed (PREVIEW_SEED=business; config.preview.seed). server/index.js calls
// runPreviewSeed once, after createApp and before the server listens, so the preview's demo companies are
// there before the first visitor. It runs only when all of these hold, and otherwise says why in one line:
//   - PREVIEW_SEED=business (config.js refuses it in production; this checks again);
//   - Tripelyx Business is on (ENABLE_BUSINESS=true);
//   - the store is the in-memory one (DATABASE_URL=memory), so demo companies never reach a real database.
// The seed itself is scripts/business-demo.js's exported seed(deps), awaited once with
//   { config, log, now, store, accounts, business, ctx, engine, registry, payments, tripService, agent, hunts, app }
// (createApp's result plus config, log and the app clock). A build without that script logs one line and
// boots normally; a seed that throws logs one line and the site still starts, without all of its demo data.
const path = require('node:path');

const DEMO_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'business-demo.js');

/**
 * A loader for the seed module at `file`: returns its exports, or null when the file is not there. Any other
 * failure while loading it (a syntax error, or a module it needs that is missing) is thrown.
 * @param {string} file
 * @returns {() => object|null}
 */
function moduleLoader(file) {
  return () => {
    let resolved;
    try {
      resolved = require.resolve(file);
    } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND') return null;
      throw e;
    }
    return require(resolved);
  };
}

const seeded = new WeakSet();

/** One line for the log: an error's message only, never its stack or any value it carries. */
function reasonOf(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0].slice(0, 300);
}

/**
 * @param {object} config the app config
 * @param {object} built what createApp returned
 * @param {{ log?: { info?: Function, warn: Function, error: Function }, load?: () => object|null }} [options]
 * @returns {Promise<{ seeded: boolean, reason: string }>}
 */
async function runPreviewSeed(config, built, { log = console, load = moduleLoader(DEMO_SCRIPT) } = {}) {
  const kind = config.preview && config.preview.seed;
  if (!kind) return { seeded: false, reason: 'off' };
  if (config.isProduction || config.appEnv === 'production') {
    log.warn('[preview] PREVIEW_SEED is ignored in production.');
    return { seeded: false, reason: 'production' };
  }
  if (!built || !built.business) {
    log.warn('[preview] PREVIEW_SEED=business needs ENABLE_BUSINESS=true; starting without the demo companies.');
    return { seeded: false, reason: 'business_off' };
  }
  if (!built.store || built.store.kind !== 'memory') {
    log.warn('[preview] PREVIEW_SEED=business only fills the in-memory store (DATABASE_URL=memory); starting without the demo companies.');
    return { seeded: false, reason: 'not_memory' };
  }
  if (seeded.has(built.store)) return { seeded: false, reason: 'already' };
  seeded.add(built.store);

  let mod;
  try {
    mod = load();
  } catch (e) {
    log.error(`[preview] scripts/business-demo.js could not be loaded (${reasonOf(e)}); starting without the demo companies.`);
    return { seeded: false, reason: 'load_failed' };
  }
  if (!mod) {
    log.warn('[preview] scripts/business-demo.js is not in this build; starting without the demo companies.');
    return { seeded: false, reason: 'missing' };
  }
  if (typeof mod.seed !== 'function') {
    log.warn('[preview] scripts/business-demo.js has no seed function; starting without the demo companies.');
    return { seeded: false, reason: 'no_seed' };
  }
  try {
    await mod.seed({ ...built, config, log, now: built.ctx ? built.ctx.now : undefined });
  } catch (e) {
    log.error(`[preview] The Business demo seed stopped (${reasonOf(e)}); the site starts without all of its demo data.`);
    return { seeded: false, reason: 'seed_failed' };
  }
  (log.info || log.warn).call(log, '[preview] Business demo companies are ready.');
  return { seeded: true, reason: 'seeded' };
}

module.exports = { runPreviewSeed, moduleLoader, DEMO_SCRIPT };
