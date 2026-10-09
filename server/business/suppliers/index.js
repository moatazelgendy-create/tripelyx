// The Business suppliers (real-suppliers design §1.2, §1.3, §1.4, §2.1). Only server/business/inventory.js
// requires this folder, and only when config.business.suppliers is configured (so Business off, demo Business
// and every consumer page never load it).
//
// createBusinessSuppliers(cfg, deps) → { flights, hotels, mode, problem, state }, and it never throws:
// - nothing configured → everything null (inventory goes on to its demo or 'none' branches);
// - a settings problem (config.js found it, or this file's own check of the key prefixes) → flights and hotels
//   null and `problem`, one sentence that names the variable but never its value. Never demo instead. One log
//   line per problem, once per process;
// - otherwise DuffelFlights (and LiteApiHotels when set) in mode 'sandbox' (round 1 refuses live keys), sharing
//   one gate (gate.js) and one http (http.js). Nothing is called at boot.
// A mode mismatch at run time (an answer whose live_mode or sandbox flag disagrees with the key) latches that
// supplier off for the life of the process; `problem` then reports it (§1.4, §2.1).
const { Gate } = require('./gate');
const { createSupplierHttp } = require('./http');
const { DuffelFlights } = require('./duffel');
const { LiteApiHotels } = require('./liteapi');
const { AIRLINES, TEST_AIRLINE } = require('./airlines');

/** The key prefixes round 1 accepts (D-TEST, L-AUTH). Round 1b pins the live prefixes here, with the switch. */
const TEST_PREFIX = Object.freeze({ duffel: 'duffel_test_', liteapi: 'sand_' });
const KEY_RE = /^[\x21-\x7e]{1,512}$/;

const PROBLEMS = Object.freeze({
  duffelToken: 'DUFFEL_ACCESS_TOKEN is not a Duffel test token.',
  liteapiKey: 'LITEAPI_API_KEY is not a LiteAPI sandbox key.',
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
 */
function createState(log) {
  const latched = { duffel: false, liteapi: false };
  return {
    latched,
    latch(supplier) {
      if (latched[supplier]) return;
      latched[supplier] = true;
      (log.error || log.warn || log.log || (() => {})).call(log, `[suppliers] ${JSON.stringify({ supplier, outcome: 'mode_mismatch' })}`);
    },
    problem() {
      if (latched.duffel) return PROBLEMS.flightsMismatch;
      if (latched.liteapi) return PROBLEMS.hotelsMismatch;
      return null;
    },
  };
}

const isKey = (value, prefix) => typeof value === 'string' && KEY_RE.test(value) && value.startsWith(prefix) && value.length > prefix.length;

/**
 * @param {object|null|undefined} cfg config.business.suppliers
 * @param {{ fetch?: Function|null, now: () => Date, log?: object, airport?: Function, cityZone?: Function,
 *   sleep?: Function, mono?: Function, random?: Function }} deps
 *   airport(code) → { city, country, tz } and cityZone(city, country) → IANA zone: the inventory's airport data
 * @returns {{ flights: object|null, hotels: object|null, mode: 'sandbox'|null, problem: string|null,
 *   state: object|null }} `problem` is a getter: a run-time latch shows up there
 */
function createBusinessSuppliers(cfg, deps = {}) {
  const log = deps.log || console;
  const off = problem => {
    if (problem) logOnce(log, problem);
    return { flights: null, hotels: null, mode: null, problem: problem || null, state: null };
  };
  try {
    if (!cfg || !cfg.configured) return off(null);
    if (cfg.problem) return off(cfg.problem);
    if (cfg.flights !== 'duffel') return off(PROBLEMS.unreadable);
    if (!isKey(cfg.duffelToken, TEST_PREFIX.duffel)) return off(PROBLEMS.duffelToken);
    if (cfg.hotels === 'liteapi' && !isKey(cfg.liteapiKey, TEST_PREFIX.liteapi)) return off(PROBLEMS.liteapiKey);
    if (typeof deps.now !== 'function') return off(PROBLEMS.unreadable);
    const mode = 'sandbox';
    const { now } = deps;
    const state = createState(log);
    const timing = {
      ...(typeof deps.sleep === 'function' ? { sleep: deps.sleep } : {}),
      ...(typeof deps.mono === 'function' ? { mono: deps.mono } : {}),
    };
    const gate = new Gate({ now, log, companyPerHour: cfg.companyCallsPerHour, ...timing });
    const http = createSupplierHttp({
      fetch: typeof deps.fetch === 'function' ? deps.fetch : null, gate, now, log,
      ...timing, ...(typeof deps.random === 'function' ? { random: deps.random } : {}),
    });
    const flights = new DuffelFlights({
      token: cfg.duffelToken, mode, http, now, log, state, cacheSeconds: cfg.cacheSeconds,
      airport: typeof deps.airport === 'function' ? deps.airport : () => null,
    });
    const hotels = cfg.hotels === 'liteapi'
      ? new LiteApiHotels({
        apiKey: cfg.liteapiKey, mode, http, now, state, cacheSeconds: cfg.cacheSeconds,
        guestNationality: cfg.guestNationality, cityZone: typeof deps.cityZone === 'function' ? deps.cityZone : () => null,
      })
      : null;
    return {
      flights,
      hotels,
      mode,
      state,
      get problem() { return state.problem(); },
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
