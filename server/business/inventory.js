// Where Business gets flights and hotels (plan §F1; real-suppliers design §1.4; go-live design §3.2, §5). Business
// never calls BookingEngine, createQuote, createBooking or payments, and writes no quotes, bookings or payment
// intents: it only searches and quotes.
//
//   1. overrides.flights or overrides.hotels given → those (tests and preview scenarios only), status 'demo';
//   2. else config.business.suppliers configured → the real suppliers (suppliers/index.js, the only place that
//      requires that folder):
//      - test keys (the preview, round 1): working → status 'sandbox';
//      - live keys (BUSINESS_SUPPLIER_LIVE=true, the www stack; go-live §5): status 'live' only while live search
//        is turned on (below), else 'none';
//      any settings problem → status 'none' with `problem`, NEVER demo, even where demo inventory is allowed;
//   3. else config.business.demoInventory (BUSINESS_DEMO_INVENTORY: on by default in development only, and on
//      the private preview) → Business's own BusinessDemoFlights and BusinessDemoHotels (latency 0), status 'demo';
//   4. else status 'none': "Supplier not connected yet". Policies, people, budgets and approvals still work.
// Business never takes flights or hotels from the shared provider registry (the one /book runs on), whatever it
// holds, and ALLOW_DEMO_INVENTORY alone never gives Business demo inventory: on www (staging, /book on demo
// inventory) Business has status 'none'.
// Nothing calls a supplier at boot. A supplier that answers in the wrong mode at run time latches itself off for
// the life of the process; `problem` then says so (a getter, read when a page asks).
//
// Live search (go-live design §5.4, §5.5; owner decision D2-2, the in-app switch):
// - The switch is one platform record (Repo.supplierSwitch, CAS on its rev, a platform audit entry with every
//   change), read through a 30-second cache: sync() reads it again when the cache is older, and app.js runs
//   sync() before every /business and /admin/business request, so every task follows a change within 30 s.
//   A switch that cannot be read counts as off (fail closed) and is read again on the next request.
// - Status is 'live' only while the stored switch is on, for these very keys (its keyPrint is config's: a key
//   pasted later needs a new check), and no answer in this task has come back in the wrong mode.
// - liveCheck(): the platform admin's "Check live connection" (suppliers/livecheck.js): at most 3 an hour,
//   counted in the switch record before any call; its calls count against the daily caps as 'platform'; the
//   result (counts and booleans only) is stored on the switch with the key print.
// - setLive(on): on only after a passing check for the current key print in the last 24 hours; off at any time.
// - A mode mismatch (an answer whose live_mode or sandbox flag says test) latches this task off at once and
//   turns the stored switch off (CAS, audit "turned off after a mode mismatch"), so every other task, a restart
//   and a deploy keep it off until a platform admin runs a new passing check and turns it on again.
// - A task whose keys are not in place (the undo of go-live design §5.9: "unset" back in a key secret, or a key
//   this site refuses) turns a stored switch that is on off when it reads it (CAS, offReason 'keys', audit
//   "Live search turned off: a supplier key is not in place"), so the same keys pasted again turn nothing on:
//   live search needs a passing check from the last 24 hours and Turn on, as the first time.
// - Every live supplier call counts against the persisted daily caps (business/usage.js), and only companies
//   Tripelyx has confirmed make supplier calls (suppliers/gate.js; requests.js says why first).
//
// airports() and cityFor() read the demo airport table (providers/mock/demo-data/flights.js: the airport codes,
// names and time zones are real, so every source uses the same 14 airports). carriers(): the fictional demo
// carriers for 'demo'; the supplier airline list plus Duffel's test airline ('ZZ', "Test airline") for
// 'sandbox'; the supplier airline list for 'live'; none for 'none'. The tables are required lazily, so an app
// with status 'none' (www, production) never loads demo data.
// The additive fields (types.js): source ('demo'|'sandbox'|'live'|null), hotelsConnected, maxVariantSearches
// (the variant searches the composer may spend: BUSINESS_SUPPLIER_VARIANT_SEARCHES with real suppliers, else
// the composer's own 20) and problem (a sentence for platform admins, or null).
const { performance } = require('node:perf_hooks');
const { AppError } = require('../lib/errors');
const { withCompany } = require('./scope');
const { SupplierUsage } = require('./usage');
const {
  LIVE_SWITCH_CACHE_MS, LIVE_CHECKS_PER_HOUR, LIVE_CHECK_FRESH_MS, SUPPLIER_CAPS,
} = require('./constants');

/** Airports whose city for a hotel search differs from the airport's own city. */
const HOTEL_CITY = Object.freeze({ DBB: 'New Alamein', CAI: 'Cairo' });

/** The composer's own cap on variant searches (search.MAX_SEARCHES), kept for demo and live. */
const DEMO_VARIANT_SEARCHES = 20;

const HOUR_MS = 60 * 60 * 1000;
/** The suppliers by their record names, as the platform admin panel and audit name them (never companies). */
const SUPPLIER_NAMES = Object.freeze({ duffel: 'Duffel', liteapi: 'LiteAPI' });

/** The errors of the live search controls (shown on /admin/business only). */
const LIVE_ERRORS = Object.freeze({
  live_unavailable: [409, 'Live search is not set up on this site.'],
  suppliers_not_ready: [409, 'Live search needs both supplier keys in place first. The Suppliers panel says what is missing.'],
  live_check_limit: [429, 'The live check has run 3 times in the last hour. You can run it again at {at} (UTC).'],
  live_check_needed: [409, 'Run the live check first. Live search turns on only after a check that passed for the keys in place, in the last 24 hours.'],
  switch_unreadable: [503, 'The live search switch could not be read just now, so nothing was changed. Try again in a minute.'],
});
const liveError = (code, at = '') => new AppError(code, LIVE_ERRORS[code][1].replace('{at}', at), LIVE_ERRORS[code][0]);

/**
 * @param {object} config the app config (config.business.demoInventory, config.business.suppliers)
 * @param {{ overrides?: { flights?: object, hotels?: object }, fetch?: Function|null, now?: () => Date,
 *   log?: object, repo?: import('./repo').Repo|null, mono?: () => number }} [deps] fetch: tests only (the
 *   suppliers use the global fetch otherwise, looked up when they call); now: the app clock; repo: the Business
 *   Repo (live search keeps its switch and its daily counts there; without it live search stays off); mono: the
 *   live check's stopwatch. A `registry` passed here is ignored: Business never uses the shared providers.
 * @returns {import('./types').BusinessInventory}
 *   airports(): [{ code, name, city, country, tz }] from the airport data ([] when status is 'none');
 *   carriers(): [{ code, name }] for the source ([] when 'none'); cityFor(iata): { city, country } with DBB →
 *   New Alamein and CAI → Cairo, else the airport's city (null for an unknown code, and always null when 'none');
 *   liveMode: true on a live-keys stack; sync(), liveState(), usageToday(), liveCheck(), setLive(), flush(): the
 *   live search controls (see the header; on any other stack sync() does nothing and the others refuse)
 */
function createBusinessInventory(config, { overrides = {}, fetch = null, now = () => new Date(), log = console, repo = null, mono = () => performance.now() } = {}) {
  let status = 'none', flights = null, hotels = null, source = null, suppliers = null, live = null;
  let tables = null;
  const data = () => {
    if (!tables) {
      const DATA = require('../providers/mock/demo-data/flights');
      tables = {
        airports: DATA.airports.map(a => Object.freeze({ code: a.iata, name: a.name, city: a.city, country: a.country, tz: a.tz })),
        carriers: DATA.carriers.map(c => Object.freeze({ code: c.code, name: c.name })),
      };
      tables.byCode = new Map(tables.airports.map(a => [a.code, a]));
      tables.zones = new Map();
      for (const a of tables.airports) {
        const key = `${HOTEL_CITY[a.code] || a.city}|${a.country}`;
        if (!tables.zones.has(key)) tables.zones.set(key, a.tz);
      }
    }
    return tables;
  };
  const cityOf = iata => {
    if (typeof iata !== 'string') return null;
    const a = data().byCode.get(iata.trim().toUpperCase());
    return a ? { city: HOTEL_CITY[a.code] || a.city, country: a.country } : null;
  };
  const biz = config && config.business ? config.business : null;
  const supplierCfg = biz ? biz.suppliers : null;
  if (overrides.flights || overrides.hotels) {
    status = 'demo';
    flights = overrides.flights || null;
    hotels = overrides.hotels || null;
  } else if (supplierCfg && supplierCfg.configured) {
    // Required here only: nothing else outside the tests requires business/suppliers (design §7.4).
    const { createBusinessSuppliers } = require('./suppliers');
    const lookups = {
      airport: code => data().byCode.get(code) || null,
      cityZone: (city, country) => data().zones.get(`${city}|${country}`) || null,
    };
    if (supplierCfg.live === true) {
      live = createLiveSearch({ cfg: supplierCfg, repo, now, log, mono, fetch, lookups, createBusinessSuppliers, cityOf, data });
      suppliers = live.suppliers;
    } else {
      suppliers = createBusinessSuppliers(supplierCfg, { fetch, now, log, ...lookups });
      if (suppliers.flights) {
        status = suppliers.mode;
        source = suppliers.mode;
        flights = suppliers.flights;
        hotels = suppliers.hotels;
      }
    }
  } else if (biz && biz.demoInventory === true) {
    // Required here only, so a site without Business demo inventory (www, production) never loads the demo data.
    const { BusinessDemoFlights } = require('./demo/flights');
    const { BusinessDemoHotels } = require('./demo/hotels');
    status = 'demo';
    flights = new BusinessDemoFlights({ latencyMs: 0 });
    hotels = new BusinessDemoHotels({ latencyMs: 0 });
  }
  if (status === 'demo') source = 'demo';
  const real = Boolean(suppliers);
  const variantSearches = real ? supplierCfg.variantSearches : DEMO_VARIANT_SEARCHES;

  if (live) {
    const on = () => live.isOn();
    return {
      get status() { return on() ? 'live' : 'none'; },
      get flights() { return on() ? suppliers.flights : null; },
      get hotels() { return on() ? suppliers.hotels : null; },
      get source() { return on() ? 'live' : null; },
      get hotelsConnected() { return on() && Boolean(suppliers.hotels); },
      maxVariantSearches: variantSearches,
      get problem() { return suppliers.problem; },
      liveMode: true,
      airports() { return on() ? data().airports.map(a => ({ ...a })) : []; },
      carriers() { return on() ? require('./suppliers').supplierCarriers('live') : []; },
      cityFor(iata) { return on() ? cityOf(iata) : null; },
      sync: opts => live.sync(opts),
      liveState: () => live.state(),
      usageToday: () => live.usageToday(),
      liveCheck: opts => live.check(opts),
      setLive: (turnOn, opts) => live.set(turnOn, opts),
      flush: () => live.flush(),
    };
  }
  const isOn = status !== 'none';
  const notLive = async () => { throw liveError('live_unavailable'); };
  return {
    status,
    flights,
    hotels,
    source,
    hotelsConnected: Boolean(hotels),
    maxVariantSearches: variantSearches,
    get problem() {
      return suppliers ? suppliers.problem : null;
    },
    liveMode: false,
    airports() {
      return isOn ? data().airports.map(a => ({ ...a })) : [];
    },
    carriers() {
      if (status === 'demo') return data().carriers.map(c => ({ ...c }));
      if (status === 'sandbox') return require('./suppliers').supplierCarriers('sandbox');
      return [];
    },
    cityFor(iata) {
      return isOn ? cityOf(iata) : null;
    },
    sync: async () => {},
    liveState: () => null,
    usageToday: async () => null,
    liveCheck: notLive,
    setLive: notLive,
    flush: async () => {},
  };
}

/**
 * The live search controller of a live-keys stack (see the header).
 * @returns {{ suppliers: object, isOn: () => boolean, sync: Function, state: Function, usageToday: Function,
 *   check: Function, set: Function, flush: Function }}
 */
function createLiveSearch({ cfg, repo, now, log, mono, fetch, lookups, createBusinessSuppliers, cityOf, data }) {
  const hasRepo = Boolean(repo && typeof repo.supplierSwitch === 'function' && typeof repo.writeSupplierSwitch === 'function');
  const usage = hasRepo ? new SupplierUsage({ repo, now, log }) : null;
  const cache = { doc: null, at: -Infinity, ok: false, pending: null };
  const writes = new Set();
  /** When this task latched a supplier off (an ISO time), or null. */
  let latchedAt = null;
  const iso = () => now().toISOString();
  const track = p => {
    const t = p.finally(() => writes.delete(t));
    writes.add(t);
    return t;
  };
  const remember = doc => {
    cache.doc = doc || null;
    cache.at = now().getTime();
    cache.ok = true;
  };

  const suppliers = createBusinessSuppliers(cfg, {
    fetch, now, log, ...lookups,
    usage,
    onMismatch: supplier => {
      latchedAt = iso();
      if (hasRepo) track(mismatchOff(supplier, latchedAt));
    },
  });
  const ready = () => Boolean(suppliers.flights) && typeof cfg.keyPrint === 'string' && cfg.keyPrint !== '';

  /**
   * Turn the stored switch off after a mode mismatch (retried on a lost race; logged, never thrown). A switch
   * that is already off (turned off while this task still read it as on, or with a call in flight) keeps who
   * turned it off and why, and the mismatch is still recorded, so the check before it no longer counts.
   */
  async function mismatchOff(supplier, at) {
    const name = SUPPLIER_NAMES[supplier] || 'A supplier';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const cur = await repo.supplierSwitch();
        if (!cur) return;
        const wasOn = cur.on === true;
        // Against the rev read here, so the audit's words match the switch it changes (a lost race reads again).
        const doc = await repo.writeSupplierSwitch(cur.rev ?? 0, d => {
          if (d.on === true) {
            d.on = false;
            d.offAt = at;
            d.offBy = null;
            d.offReason = 'mismatch';
          }
          d.mismatch = { at, supplier };
          d.updatedAt = at;
        }, wasOn
          ? { action: 'suppliers.live_off', actor: { system: 'mode_check' }, summary: `Live search turned off: ${name} answered in test mode` }
          : { action: 'suppliers.mismatch', actor: { system: 'mode_check' }, summary: `${name} answered in test mode (live search was already off)` });
        remember(doc);
        return;
      } catch (e) {
        if (e instanceof AppError && e.code === 'conflict') continue;
        break;
      }
    }
    log.error('[business] live search could not be turned off in the store after a mode mismatch; this task stays off');
  }

  /**
   * Turn the stored switch off because this task's keys are not in place (retried on a lost race; logged,
   * never thrown). Nothing to do when it is already off.
   */
  async function keysOff() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const cur = await repo.supplierSwitch();
        if (!cur || cur.on !== true) return;
        const at = iso();
        const doc = await repo.writeSupplierSwitch(cur.rev ?? 0, d => {
          d.on = false;
          d.offAt = at;
          d.offBy = null;
          d.offReason = 'keys';
          d.updatedAt = at;
        }, { action: 'suppliers.live_off', actor: { system: 'keys_check' }, summary: 'Live search turned off: a supplier key is not in place' });
        remember(doc);
        return;
      } catch (e) {
        if (e instanceof AppError && e.code === 'conflict') continue;
        break;
      }
    }
    log.error('[business] live search could not be turned off in the store while a supplier key is not in place; this task stays off');
  }

  /** The stored switch, read again when the cache is older than 30 s (or `force`). Never throws. */
  function sync({ force = false } = {}) {
    if (!hasRepo) return Promise.resolve();
    if (!force && cache.ok && now().getTime() - cache.at < LIVE_SWITCH_CACHE_MS) return Promise.resolve();
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      try {
        const doc = await repo.supplierSwitch();
        remember(doc);
        // On in the store, but this task's keys are not in place (taken out to undo live search): off in the
        // store too, so pasting the same keys again needs a check and Turn on.
        if (!ready() && doc && doc.on === true) await track(keysOff());
        // Turned on again (after a new passing check) since this task latched: the latch is cleared.
        if (latchedAt && doc && doc.on === true && typeof doc.onAt === 'string' && doc.onAt > latchedAt) {
          suppliers.state.reset();
          latchedAt = null;
        }
      } catch {
        cache.ok = false;
        cache.doc = null;
        log.warn('[business] the live search switch could not be read, so live search is off until it can be');
      } finally {
        cache.pending = null;
      }
    })();
    return cache.pending;
  }

  function isOn() {
    const d = cache.doc;
    return ready() && cache.ok && Boolean(d) && d.on === true && d.keyPrint === cfg.keyPrint && !suppliers.state.isLatched();
  }

  /** A switch write that may race other tasks: read-decide-commit again on a lost race (a few times). */
  async function write(fn, audit) {
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const doc = await repo.writeSupplierSwitch(null, fn, audit);
        remember(doc);
        return doc;
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'conflict' && e.retryable)) throw e;
        last = e;
      }
    }
    throw last;
  }

  const lastCheckOf = d => (d && d.lastCheck && typeof d.lastCheck === 'object' ? d.lastCheck : null);
  /**
   * Does the switch's last check let live search turn on now: passed, for these keys, in the last 24 hours, and
   * after the last mode mismatch (a mismatch needs a new passing check)?
   */
  const checkCounts = (d, t) => {
    const c = lastCheckOf(d);
    if (!c || c.passed !== true || c.keyPrint !== cfg.keyPrint) return false;
    const at = Date.parse(c.at);
    if (!Number.isFinite(at) || at > t || t - at > LIVE_CHECK_FRESH_MS) return false;
    const m = d.mismatch && typeof d.mismatch === 'object' ? Date.parse(d.mismatch.at) : NaN;
    return !Number.isFinite(m) || at > m;
  };
  const recentChecks = (d, t) => (d && Array.isArray(d.checks) ? d.checks : [])
    .filter(x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && t - Date.parse(x) < HOUR_MS && Date.parse(x) <= t);

  /**
   * What the Suppliers panel shows: plain values, never a key or any part of one.
   * @returns {object}
   */
  function state() {
    const d = cache.doc;
    const t = now().getTime();
    const c = lastCheckOf(d);
    const recent = recentChecks(d, t);
    const nextCheckAt = recent.length >= LIVE_CHECKS_PER_HOUR ? new Date(Date.parse(recent[0]) + HOUR_MS).toISOString() : null;
    return {
      readable: !hasRepo ? false : cache.ok,
      ready: ready(),
      problem: suppliers.problem || null,
      keys: { duffel: cfg.keyState ? cfg.keyState.duffel : null, liteapi: cfg.keyState ? cfg.keyState.liteapi : null },
      on: isOn(),
      stored: d ? {
        on: d.on === true,
        sameKeys: d.keyPrint === cfg.keyPrint,
        onAt: d.onAt || null,
        offAt: d.offAt || null,
        offReason: d.offReason || null,
        mismatch: d.mismatch && typeof d.mismatch === 'object' ? { at: d.mismatch.at || null, supplier: d.mismatch.supplier || null } : null,
      } : null,
      latched: suppliers.state ? { duffel: suppliers.state.latched.duffel, liteapi: suppliers.state.latched.liteapi } : { duffel: false, liteapi: false },
      // When this task latched a supplier off after a mode mismatch (ISO), or null.
      latchedAt,
      rev: d ? d.rev ?? 0 : 0,
      lastCheck: c ? {
        at: c.at, passed: c.passed === true, current: c.keyPrint === cfg.keyPrint, counts: checkCounts(d, t), details: c.details || null,
        // Why a passing check no longer counts: other keys now, older than 24 hours, or a mode mismatch since.
        stale: c.passed !== true || checkCounts(d, t) ? null : c.keyPrint !== cfg.keyPrint ? 'keys'
          : d.mismatch && Date.parse(d.mismatch.at) >= Date.parse(c.at) ? 'mismatch' : 'old',
      } : null,
      canTurnOn: ready() && !isOn() && checkCounts(d, t),
      checksLeft: Math.max(0, LIVE_CHECKS_PER_HOUR - recent.length),
      nextCheckAt,
      hotels: Boolean(cfg.hotels),
      caps: { company: SUPPLIER_CAPS.company, total: SUPPLIER_CAPS.total },
    };
  }

  /**
   * "Check live connection" (go-live §5.4).
   * @param {{ actor: { platformAdmin: string } }} opts
   * @returns {Promise<{ passed: boolean, mismatch: string|null, details: object }>}
   * @throws {AppError} 409 suppliers_not_ready; 429 live_check_limit; 503 switch_unreadable
   */
  async function check({ actor } = {}) {
    if (!hasRepo) throw liveError('switch_unreadable');
    if (!ready()) throw liveError('suppliers_not_ready');
    const startedAt = iso();
    const t = Date.parse(startedAt);
    // Counted before any call, in the record every task shares: at most 3 an hour.
    try {
      await write(d => {
        const recent = recentChecks(d, t);
        if (recent.length >= LIVE_CHECKS_PER_HOUR) {
          const at = new Date(Date.parse(recent[0]) + HOUR_MS).toISOString().slice(11, 16);
          throw liveError('live_check_limit', at);
        }
        d.checks = [...recent, startedAt];
        d.updatedAt = startedAt;
      }, null);
    } catch (e) {
      if (e instanceof AppError && e.code === 'live_check_limit') throw e;
      log.warn('[business] the live check could not be counted, so it did not run');
      throw liveError('switch_unreadable');
    }
    const { runLiveCheck } = require('./suppliers/livecheck');
    const { TripComposer } = require('./search');
    const dto = require('./dto');
    const adapters = suppliers.checkAdapters();
    const checkInventory = {
      status: 'live', source: 'live', flights: adapters.flights, hotels: adapters.hotels, hotelsConnected: Boolean(adapters.hotels),
      maxVariantSearches: 0, problem: null, liveMode: true,
      airports: () => data().airports.map(a => ({ ...a })),
      carriers: () => require('./suppliers').supplierCarriers('live'),
      cityFor: cityOf,
    };
    const result = await withCompany('platform', () => runLiveCheck({
      adapters, composerFor: inv => new TripComposer({ inventory: { ...checkInventory, ...inv }, now }),
      now, mono, assertRow: dto.assertRow, cityFor: cityOf,
    }), { confirmed: true, timezone: 'UTC' });
    const at = iso();
    const mismatch = result.mismatch.duffel ? 'duffel' : result.mismatch.liteapi ? 'liteapi' : null;
    const summary = result.passed ? 'Live check passed'
      : mismatch ? `Live check: ${SUPPLIER_NAMES[mismatch]} answered in test mode, so live search is off` : 'Live check did not pass';
    await write(d => {
      d.lastCheck = { at, passed: result.passed, details: result.details, keyPrint: cfg.keyPrint, by: actor && actor.platformAdmin ? actor.platformAdmin : null };
      if (mismatch) {
        if (d.on === true) {
          d.on = false;
          d.offAt = at;
          d.offBy = null;
          d.offReason = 'mismatch';
        }
        d.mismatch = { at, supplier: mismatch };
      }
      d.updatedAt = at;
    }, { action: 'suppliers.checked', actor: actor || { system: 'unknown' }, summary });
    return { passed: result.passed, mismatch, details: result.details };
  }

  /**
   * "Turn on live search" / "Turn off live search" (go-live §5.4).
   * @param {boolean} turnOn
   * @param {{ actor: { platformAdmin: string }, rev: number|string }} opts rev: the switch's rev the page showed
   * @returns {Promise<object>} the written switch
   * @throws {AppError} 409 live_check_needed, suppliers_not_ready or conflict; 503 switch_unreadable
   */
  async function set(turnOn, { actor, rev } = {}) {
    if (!hasRepo) throw liveError('switch_unreadable');
    const at = iso();
    const t = Date.parse(at);
    const by = actor && actor.platformAdmin ? actor.platformAdmin : null;
    let doc;
    if (turnOn === true) {
      if (!ready()) throw liveError('suppliers_not_ready');
      doc = await repo.writeSupplierSwitch(rev, d => {
        if (!checkCounts(d, t)) throw liveError('live_check_needed');
        d.on = true;
        d.keyPrint = cfg.keyPrint;
        d.onAt = at;
        d.onBy = by;
        d.offReason = null;
        d.mismatch = null;
        d.updatedAt = at;
      }, { action: 'suppliers.live_on', actor, summary: 'Turned live search on' });
      // A new passing check for these keys: this task's mismatch latch (if any) is cleared.
      suppliers.state.reset();
      latchedAt = null;
    } else {
      doc = await repo.writeSupplierSwitch(rev, d => {
        d.on = false;
        d.offAt = at;
        d.offBy = by;
        d.offReason = 'admin';
        d.updatedAt = at;
      }, { action: 'suppliers.live_off', actor, summary: 'Turned live search off' });
    }
    remember(doc);
    return doc;
  }

  /** Today's call counts against the caps (business/usage.js), or null without a store. */
  async function usageToday() {
    return usage ? usage.today() : null;
  }

  return {
    suppliers, isOn, sync, state, usageToday, check, set,
    /** Wait for the switch writes this task started on its own (a mismatch's); tests and shutdown. */
    flush: () => Promise.all([...writes]).then(() => {}),
  };
}

module.exports = { createBusinessInventory };
