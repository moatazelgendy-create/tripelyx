// The trip integration layer. Each capability (maps, weather, flights, hotels, activities, transfers)
// has one interface (types.d.ts); TRIP_<CAPABILITY>_PROVIDER picks the implementation. Only the demo
// implementations exist today. They are refused whenever demo inventory is not allowed, so a
// production environment can never quietly sell invented trips. Credentials for real adapters are
// read from the environment on the server and never sent to the browser.
const mock = require('./mock');

const ADAPTERS = {
  // e.g. flights: { acme: (config, deps) => new AcmeFlights(process.env.ACME_FLIGHTS_KEY, deps) },
  maps: {}, weather: {}, flights: {}, hotels: {}, activities: {}, transfers: {}, guides: {},
};

// `guides` (free things worth doing, with a source and a checked date) is the one capability that may
// be absent: where demo inventory is refused and no real guide adapter is named, `guides` is null and
// the experience engine says "no verified free options" instead of inventing any. Sold inventory
// (flights, hotels, activities, transfers) keeps the stricter rule: demo there turns the planner off.
function createTripIntegrations(config, { now = () => new Date(), overrides = {} } = {}) {
  const maps = new mock.MockMaps();
  const demo = {
    maps: () => maps,
    weather: () => new mock.MockWeather(),
    flights: () => new mock.MockFlights({ maps, now }),
    hotels: () => new mock.MockHotels({ now }),
    activities: () => new mock.MockActivities(),
    transfers: () => new mock.MockTransfers(),
    guides: () => new mock.MockGuides({ now }),
  };
  const out = {};
  for (const cap of Object.keys(demo)) {
    if (overrides[cap]) { out[cap] = overrides[cap]; continue; }
    const name = (config.trips.providers || {})[cap] || 'mock';
    if (name === 'mock') {
      if (!config.allowDemoInventory) { if (cap === 'guides') { out[cap] = null; continue; } return null; }
      out[cap] = demo[cap]();
    } else {
      const factory = ADAPTERS[cap][name];
      if (!factory) throw new Error(`TRIP_${cap.toUpperCase()}_PROVIDER "${name}" is not registered in server/trips/integrations/index.js`);
      out[cap] = factory(config, { now });
    }
  }
  out.demo = Object.keys(demo).some(cap => out[cap] && out[cap].kind === 'mock');
  return out;
}

module.exports = { createTripIntegrations, ADAPTERS };
