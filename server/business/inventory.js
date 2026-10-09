// Where Business gets flights and hotels (plan §F1). Business never calls BookingEngine, createQuote,
// createBooking or payments, and writes no quotes, bookings or payment intents: it only searches and quotes.
//
//   1. overrides.flights or overrides.hotels given → those (tests and preview scenarios only), status 'demo';
//   2. else registry flights and hotels both real (isDemo === false) → those, status 'live' (never today);
//   3. else config.allowDemoInventory → Business's own BusinessDemoFlights and BusinessDemoHotels (latency 0),
//      status 'demo';
//   4. else status 'none': "Supplier not connected yet". Policies, people, budgets and approvals still work.
//
// airports(), carriers() and cityFor() read the demo airport and carrier tables (providers/mock/demo-data/
// flights.js: the airport codes, names and time zones are real, the carriers are fictional). They are
// required lazily, so an app with status 'none' (production) never loads demo data. With status 'live' the
// airports are the same real airports and carriers() is empty until a real supplier names its own.

/** Airports whose city for a hotel search differs from the airport's own city. */
const HOTEL_CITY = Object.freeze({ DBB: 'New Alamein', CAI: 'Cairo' });

/**
 * @param {object} config the app config
 * @param {{ registry: { get: (vertical: string) => object|null }, overrides?: { flights?: object, hotels?: object } }} deps
 * @returns {import('./types').BusinessInventory}
 *   airports(): [{ code, name, city, country, tz }] from the demo airport data ([] when status is 'none');
 *   carriers(): [{ code, name }] ([] when 'none'); cityFor(iata): { city, country } with DBB → New Alamein and
 *   CAI → Cairo, else the airport's city (null for an unknown code, and always null when 'none')
 */
function createBusinessInventory(config, { registry, overrides = {} } = {}) {
  let status = 'none', flights = null, hotels = null;
  if (overrides.flights || overrides.hotels) {
    status = 'demo';
    flights = overrides.flights || null;
    hotels = overrides.hotels || null;
  } else {
    const f = registry && registry.get('flights');
    const h = registry && registry.get('hotels');
    if (f && h && f.isDemo === false && h.isDemo === false) {
      status = 'live';
      flights = f;
      hotels = h;
    } else if (config.allowDemoInventory) {
      // Required here only, so production (no demo inventory) never loads the demo data.
      const { BusinessDemoFlights } = require('./demo/flights');
      const { BusinessDemoHotels } = require('./demo/hotels');
      status = 'demo';
      flights = new BusinessDemoFlights({ latencyMs: 0 });
      hotels = new BusinessDemoHotels({ latencyMs: 0 });
    }
  }
  const on = status !== 'none';
  let tables = null;
  const data = () => {
    if (!tables) {
      const DATA = require('../providers/mock/demo-data/flights');
      tables = {
        airports: DATA.airports.map(a => Object.freeze({ code: a.iata, name: a.name, city: a.city, country: a.country, tz: a.tz })),
        carriers: DATA.carriers.map(c => Object.freeze({ code: c.code, name: c.name })),
      };
      tables.byCode = new Map(tables.airports.map(a => [a.code, a]));
    }
    return tables;
  };
  return {
    status,
    flights,
    hotels,
    airports() {
      return on ? data().airports.map(a => ({ ...a })) : [];
    },
    carriers() {
      return status === 'demo' ? data().carriers.map(c => ({ ...c })) : [];
    },
    cityFor(iata) {
      if (!on || typeof iata !== 'string') return null;
      const a = data().byCode.get(iata.trim().toUpperCase());
      return a ? { city: HOTEL_CITY[a.code] || a.city, country: a.country } : null;
    },
  };
}

module.exports = { createBusinessInventory };
