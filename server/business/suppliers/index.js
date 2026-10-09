// The Business suppliers (real-suppliers design §1.2, §1.3, §1.4, §2.1; go-live design §5.3, §5.4). Only
// server/business/inventory.js requires this folder, and only when config.business.suppliers is configured (so
// Business off, demo Business and every consumer page never load it).
//
// createBusinessSuppliers(cfg, deps) → { flights, hotels, mode, problem, state, checkAdapters }, and it never throws:
// - nothing configured → everything null (inventory goes on to its demo or 'none' branches);
// - a settings problem (config.js found it, or this file's own check of the key prefixes) → flights and hotels
//   null and `problem`, one sentence that names the variable but never its value. Never demo instead. One log
//   line per problem, once per process;
// - otherwise DuffelFlights (and LiteApiHotels when set) sharing one gate (gate.js) and one http (http.js), in
//   mode 'sandbox' (test keys only: round 1, the preview) or, with cfg.live (BUSINESS_SUPPLIER_LIVE, the www
//   stack), mode 'live' (live keys only: a test prefix is a problem, never test data). Nothing is called at boot.
// A mode mismatch at run time (an answer whose live_mode or sandbox flag disagrees with the key) latches that
// supplier off; in sandbox `problem` then reports it until the app restarts (§1.4, §2.1). In live mode
// deps.onMismatch(supplier) is told too: the inventory turns the stored live search switch off, so a restart
// keeps it off, and clears the latch only when live search is turned on again after a new passing check.
// Live mode also counts every call against the persisted daily caps (deps.usage, business/usage.js) and refuses
// a call for a company the scope says is not confirmed (gate.js).
// checkAdapters() builds a second pair of adapters on the same gate, with their own latch: the admin's live
// check (livecheck.js) runs on them, so a check never reads a cached answer and never unlatches live search.
const { Gate } = require('./gate');
const { createSupplierHttp } = require('./http');
const { DuffelFlights } = require('./duffel');
const { LiteApiHotels } = require('./liteapi');
const { AIRLINES, TEST_AIRLINE } = require('./airlines');

/** The test key prefixes (D-TEST, L-AUTH): the only keys sandbox mode accepts, and keys live mode refuses. */
const TEST_PREFIX = Object.freeze({ duffel: 'duffel_test_', liteapi: 'sand_' });
const KEY_RE = /^[\x21-\x7e]{1,512}$/;

const PROBLEMS = Object.freeze({
  duffelToken: 'DUFFEL_ACCESS_TOKEN is not a Duffel test token.',
  liteapiKey: 'LITEAPI_API_KEY is not a LiteAPI sandbox key.',
  duffelLive: 'DUFFEL_ACCESS_TOKEN is a test token; this site takes live keys only.',
  liteapiLive: 'LITEAPI_API_KEY is a sandbox key; this site takes live keys only.',
  unreadable: 'The supplier settings could not be read (BUSINESS_FLIGHT_SUPPLIER).',
  flightsMismatch: 'The flight supplier (DUFFEL_ACCESS_TOKEN) answered in another mode than its key, so flights are off until the app restarts.',
  hotelsMismatch: 'The hotel supplier (LITEAPI_API_KEY) answered in another mode than its key, so hotels are off until the app restarts.',
});

/** Problems already logged by this process (one line each). */
const logged = new Set();

function logOnce(log, text) {
  if (logged.has(text)) return;
  logged.add(text);
  (log.warn || log.log || (() => {})).call(log, `[suppliers] ${text}`);
}

/**
 * The run-time state the adapters share: which supplier is latched off.
 * @param {object} log
 * @param {{ onMismatch?: (supplier: 'duffel'|'liteapi') => void, live?: boolean }} [opts] onMismatch: told once
 *   per latch (live mode: the inventory turns the stored switch off); live: `problem()` stays null, since the
 *   live search switch on /admin/business says what happened
 */
function createState(log, { onMismatch = null, live = false } = {}) {
  const latched = { duffel: false, liteapi: false };
  return {
    latched,
    latch(supplier) {
      if (latched[supplier]) return;
      latched[supplier] = true;
      (log.error || log.warn || log.log || (() => {})).call(log, `[suppliers] ${JSON.stringify({ supplier, outcome: 'mode_mismatch' })}`);
      if (typeof onMismatch === 'function') {
        try { onMismatch(supplier); } catch { /* the hook writes on its own time and logs its own failures */ }
      }
    },
    /** Clear both latches (live mode: live search was turned on again after a passing check). */
    reset() {
      latched.duffel = false;
      latched.liteapi = false;
    },
    isLatched() {
      return latched.duffel || latched.liteapi;
    },
    problem() {
      if (live) return null;
      if (latched.duffel) return PROBLEMS.flightsMismatch;
      if (latched.liteapi) return PROBLEMS.hotelsMismatch;
      return null;
    },
  };
}

const isKey = (value, prefix) => typeof value === 'string' && KEY_RE.test(value) && value.startsWith(prefix) && value.length > prefix.length;
/** A key live mode takes: well formed, and not one of the test prefixes. */
const isLiveKey = (value, prefix) => typeof value === 'string' && KEY_RE.test(value) && !value.startsWith(prefix);

/**
 * @param {object|null|undefined} cfg config.business.suppliers
 * @param {{ fetch?: Function|null, now: () => Date, log?: object, airport?: Function, cityZone?: Function,
 *   sleep?: Function, mono?: Function, random?: Function, usage?: object|null,
 *   onMismatch?: (supplier: string) => void }} deps
 *   airport(code) → { city, country, tz } and cityZone(city, country) → IANA zone: the inventory's airport data;
 *   usage: the daily caps (business/usage.js), live mode only; onMismatch: live mode only (see the header)
 * @returns {{ flights: object|null, hotels: object|null, mode: 'sandbox'|'live'|null, problem: string|null,
 *   state: object|null, checkAdapters: (() => { flights: object, hotels: object|null, state: object })|null }}
 *   `problem` is a getter: a run-time latch shows up there (sandbox)
 */
function createBusinessSuppliers(cfg, deps = {}) {
  const log = deps.log || console;
  const off = problem => {
    if (problem) logOnce(log, problem);
    return { flights: null, hotels: null, mode: null, problem: problem || null, state: null, checkAdapters: null };
  };
  try {
    if (!cfg || !cfg.configured) return off(null);
    if (cfg.problem) return off(cfg.problem);
    if (cfg.flights !== 'duffel') return off(PROBLEMS.unreadable);
    const live = cfg.live === true;
    if (live) {
      if (!isLiveKey(cfg.duffelToken, TEST_PREFIX.duffel)) return off(PROBLEMS.duffelLive);
      if (cfg.hotels === 'liteapi' && !isLiveKey(cfg.liteapiKey, TEST_PREFIX.liteapi)) return off(PROBLEMS.liteapiLive);
    } else {
      if (!isKey(cfg.duffelToken, TEST_PREFIX.duffel)) return off(PROBLEMS.duffelToken);
      if (cfg.hotels === 'liteapi' && !isKey(cfg.liteapiKey, TEST_PREFIX.liteapi)) return off(PROBLEMS.liteapiKey);
    }
    if (typeof deps.now !== 'function') return off(PROBLEMS.unreadable);
    const mode = live ? 'live' : 'sandbox';
    const { now } = deps;
    const state = createState(log, { live, onMismatch: live ? deps.onMismatch : null });
    const timing = {
      ...(typeof deps.sleep === 'function' ? { sleep: deps.sleep } : {}),
      ...(typeof deps.mono === 'function' ? { mono: deps.mono } : {}),
    };
    const gate = new Gate({
      now, log, companyPerHour: cfg.companyCallsPerHour, ...timing,
      ...(live ? { usage: deps.usage || null, confirmedOnly: true } : {}),
    });
    const http = createSupplierHttp({
      fetch: typeof deps.fetch === 'function' ? deps.fetch : null, gate, now, log,
      ...timing, ...(typeof deps.random === 'function' ? { random: deps.random } : {}),
    });
    /** The adapters over the shared gate and http, latching into `own`. */
    const adapters = own => ({
      flights: new DuffelFlights({
        token: cfg.duffelToken, mode, http, now, log, state: own, cacheSeconds: cfg.cacheSeconds,
        airport: typeof deps.airport === 'function' ? deps.airport : () => null,
      }),
      hotels: cfg.hotels === 'liteapi'
        ? new LiteApiHotels({
          apiKey: cfg.liteapiKey, mode, http, now, state: own, cacheSeconds: cfg.cacheSeconds,
          guestNationality: cfg.guestNationality, cityZone: typeof deps.cityZone === 'function' ? deps.cityZone : () => null,
        })
        : null,
    });
    const { flights, hotels } = adapters(state);
    return {
      flights,
      hotels,
      mode,
      state,
      get problem() { return state.problem(); },
      checkAdapters() {
        const own = createState(log, { live });
        return { ...adapters(own), state: own };
      },
    };
  } catch {
    return off(PROBLEMS.unreadable);
  }
}

/**
 * carriers() for a supplier source (§1.4): the airline list plus Duffel's test airline in sandbox.
 * @param {'sandbox'|'live'} mode
 * @returns {Array<{ code: string, name: string }>}
 */
function supplierCarriers(mode) {
  const list = AIRLINES.map(a => ({ code: a.code, name: a.name }));
  if (mode === 'sandbox') list.push({ code: TEST_AIRLINE.code, name: TEST_AIRLINE.name });
  return list;
}

module.exports = { createBusinessSuppliers, supplierCarriers, createState, TEST_PREFIX, PROBLEMS };
