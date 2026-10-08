// Where Business gets flights and hotels (plan §F1). Business never calls BookingEngine, createQuote,
// createBooking or payments, and writes no quotes, bookings or payment intents: it only searches and quotes.
// STUB from Stage 0: the choice of inventory below is the frozen behaviour (the app boots on it); Stage 1I
// builds airports(), carriers() and cityFor().
//
//   1. overrides.flights or overrides.hotels given → those (tests and preview scenarios only), status 'demo';
//   2. else registry flights and hotels both real (isDemo === false) → those, status 'live' (never today);
//   3. else config.allowDemoInventory → Business's own BusinessDemoFlights and BusinessDemoHotels (latency 0),
//      status 'demo';
//   4. else status 'none': "Supplier not connected yet". Policies, people, budgets and approvals still work.

function notBuilt() { throw new Error('[business] not built'); }

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
  return {
    status,
    flights,
    hotels,
    airports() { notBuilt(); },
    carriers() { notBuilt(); },
    cityFor(iata) { notBuilt(); },
  };
}

module.exports = { createBusinessInventory };
