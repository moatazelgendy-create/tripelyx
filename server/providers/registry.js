// Resolves one provider per enabled vertical from config (HOTEL_PROVIDER, FLIGHT_PROVIDER, …), checks it implements
// the vertical's interface, and enforces the demo-inventory rule: the mock providers are refused when
// demo inventory isn't allowed (production by default). This is the only place that knows which
// concrete provider backs a vertical.
const { VERTICALS } = require('../verticals');
const { assertProvider, INTERFACE_NAMES } = require('./contracts');
const ADAPTERS = require('./adapters');

function createRegistry(config, { env = process.env, overrides = {} } = {}) {
  const providers = {};
  for (const v of VERTICALS) {
    if (!config.flags[v.key]) continue;
    const mode = config.providers[v.key];
    let provider = overrides[v.key];
    if (!provider) {
      if (mode === 'mock') {
        if (!config.allowDemoInventory) {
          throw new Error(`${v.providerEnv}=mock is not allowed in ${config.appEnv}: demo inventory is disabled (set a real provider, disable ENABLE_${v.envKey}, or set ALLOW_DEMO_INVENTORY=true deliberately)`);
        }
        // Only here is the demo inventory ever loaded.
        const { FACTORIES } = require('./mock');
        provider = FACTORIES[v.key]({ latencyMs: Number(env.MOCK_LATENCY_MS || 0) });
      } else {
        const factory = ADAPTERS[v.key][mode];
        if (!factory) throw new Error(`No ${INTERFACE_NAMES[v.key]} adapter named "${mode}" (from ${v.providerEnv}). Registered: mock${Object.keys(ADAPTERS[v.key]).map(k => `, ${k}`).join('')}`);
        provider = factory(env);
      }
    }
    assertProvider(provider, v.key);
    if (provider.isDemo && !config.allowDemoInventory) throw new Error(`${provider.name} serves demo inventory, which is disabled in ${config.appEnv}`);
    providers[v.key] = provider;
  }
  return {
    get(vertical) {
      return providers[vertical] || null;
    },
    enabled() {
      return Object.keys(providers);
    },
  };
}

module.exports = { createRegistry };
