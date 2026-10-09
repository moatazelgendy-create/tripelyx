// Where Business gets flights and hotels (plan §F1; real-suppliers design §1.4; go-live design §3.2). Business
// never calls BookingEngine, createQuote, createBooking or payments, and writes no quotes, bookings or payment
// intents: it only searches and quotes.
//
//   1. overrides.flights or overrides.hotels given → those (tests and preview scenarios only), status 'demo';
//   2. else config.business.suppliers configured → the real suppliers (suppliers/index.js, the only place that
//      requires that folder): working → status 'sandbox' (round 1 runs on the suppliers' test systems only);
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
// airports() and cityFor() read the demo airport table (providers/mock/demo-data/flights.js: the airport codes,
// names and time zones are real, so every source uses the same 14 airports). carriers(): the fictional demo
// carriers for 'demo'; the supplier airline list plus Duffel's test airline ('ZZ', "Test airline") for
// 'sandbox'; none otherwise. The tables are required lazily, so an app with status 'none' (www, production)
// never loads demo data.
// The additive fields (types.js): source ('demo'|'sandbox'|'live'|null), hotelsConnected, maxVariantSearches
// (the variant searches the composer may spend: BUSINESS_SUPPLIER_VARIANT_SEARCHES with real suppliers, else
// the composer's own 20) and problem (a sentence for platform admins, or null).

/** Airports whose city for a hotel search differs from the airport's own city. */
const HOTEL_CITY = Object.freeze({ DBB: 'New Alamein', CAI: 'Cairo' });

/** The composer's own cap on variant searches (search.MAX_SEARCHES), kept for demo and live. */
const DEMO_VARIANT_SEARCHES = 20;

/**
 * @param {object} config the app config (config.business.demoInventory, config.business.suppliers)
 * @param {{ overrides?: { flights?: object, hotels?: object }, fetch?: Function|null, now?: () => Date,
 *   log?: object }} [deps] fetch: tests only (the suppliers use the global fetch otherwise, looked up when they
 *   call); now: the app clock. A `registry` passed here is ignored: Business never uses the shared providers.
 * @returns {import('./types').BusinessInventory}
 *   airports(): [{ code, name, city, country, tz }] from the airport data ([] when status is 'none');
 *   carriers(): [{ code, name }] for the source ([] when 'none' or 'live'); cityFor(iata): { city, country }
 *   with DBB → New Alamein and CAI → Cairo, else the airport's city (null for an unknown code, and always
 *   null when 'none')
 */
function createBusinessInventory(config, { overrides = {}, fetch = null, now = () => new Date(), log = console } = {}) {
  let status = 'none', flights = null, hotels = null, source = null, suppliers = null;
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
  const biz = config && config.business ? config.business : null;
  const supplierCfg = biz ? biz.suppliers : null;
  if (overrides.flights || overrides.hotels) {
    status = 'demo';
    flights = overrides.flights || null;
    hotels = overrides.hotels || null;
  } else if (supplierCfg && supplierCfg.configured) {
    // Required here only: nothing else outside the tests requires business/suppliers (design §7.4).
    const { createBusinessSuppliers } = require('./suppliers');
    suppliers = createBusinessSuppliers(supplierCfg, {
      fetch, now, log,
      airport: code => data().byCode.get(code) || null,
      cityZone: (city, country) => data().zones.get(`${city}|${country}`) || null,
    });
    if (suppliers.flights) {
      status = suppliers.mode;
      source = suppliers.mode;
      flights = suppliers.flights;
      hotels = suppliers.hotels;
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
  const on = status !== 'none';
  const real = source === 'sandbox' || source === 'live';
  return {
    status,
    flights,
    hotels,
    source,
    hotelsConnected: Boolean(hotels),
    maxVariantSearches: real && suppliers ? supplierCfg.variantSearches : DEMO_VARIANT_SEARCHES,
    get problem() {
      return suppliers ? suppliers.problem : null;
    },
    airports() {
      return on ? data().airports.map(a => ({ ...a })) : [];
    },
    carriers() {
      if (status === 'demo') return data().carriers.map(c => ({ ...c }));
      if (status === 'sandbox') return require('./suppliers').supplierCarriers('sandbox');
      return [];
    },
    cityFor(iata) {
      if (!on || typeof iata !== 'string') return null;
      const a = data().byCode.get(iata.trim().toUpperCase());
      return a ? { city: HOTEL_CITY[a.code] || a.city, country: a.country } : null;
    },
  };
}

module.exports = { createBusinessInventory };
