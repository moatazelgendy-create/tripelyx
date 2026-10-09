// Every runtime setting comes from the environment (see .env.example). Nothing secret is ever
// hard-coded, and nothing in here is ever sent to the browser except the explicit `publicConfig()`
// projection at the bottom — the frontend only ever learns which verticals are on and whether
// payments are in test mode, never a key, URL with credentials, or provider name it doesn't need.
const { VERTICALS } = require('./verticals');
const { passwordDigest } = require('./lib/previewGate');

const APP_ENVS = ['development', 'staging', 'production'];

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// A whole number of at least zero, or the fallback when unset; anything else fails at boot.
function int(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of 0 or more (got "${value}")`);
  return n;
}

// A whole number of at least one, or the fallback when unset.
function pos(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more (got "${value}")`);
  return n;
}

// One of a fixed list of values; anything else fails at boot.
function oneOf(value, list, name) {
  const v = String(value).trim().toLowerCase();
  if (!list.includes(v)) throw new Error(`${name} must be one of: ${list.join(', ')} (got "${value}")`);
  return v;
}

// Tripelyx Business suppliers (real-suppliers design §1.3). Round 1 accepts only test keys.
const SUPPLIER_TEST_PREFIX = Object.freeze({ duffel: 'duffel_test_', liteapi: 'sand_' });
const SUPPLIER_KEY_RE = /^[\x21-\x7e]{1,512}$/;

// A whole number from min to max, or the fallback when unset; null when it is anything else (never throws).
function range(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * config.business.suppliers. Never throws, whatever the environment holds: every problem becomes `problem`, one
 * sentence that names the variable and never its value (Business then shows "Supplier not connected yet",
 * never demo). The keys are non-enumerable, so they never appear when the config is logged or serialised,
 * and they are only set when there is no problem. Not in publicConfig.
 * @param {object} env
 * @param {string} appEnv
 */
function businessSuppliers(env, appEnv) {
  const text = v => (v === undefined || v === null ? '' : String(v).trim());
  const flightName = text(env.BUSINESS_FLIGHT_SUPPLIER).toLowerCase();
  const hotelName = text(env.BUSINESS_HOTEL_SUPPLIER).toLowerCase();
  const configured = Boolean(flightName || hotelName);
  const nationality = text(env.BUSINESS_GUEST_NATIONALITY || 'US').toUpperCase();
  const cacheSeconds = range(env.BUSINESS_SUPPLIER_CACHE_SECONDS, 300, 0, 900);
  const companyCallsPerHour = range(env.BUSINESS_SUPPLIER_COMPANY_CALLS_PER_HOUR, 120, 1, 100000);
  const variantSearches = range(env.BUSINESS_SUPPLIER_VARIANT_SEARCHES, 4, 0, 20);
  const allowTest = bool(env.BUSINESS_ALLOW_SUPPLIER_TEST, appEnv === 'development');
  const token = text(env.DUFFEL_ACCESS_TOKEN), key = text(env.LITEAPI_API_KEY);
  const isKey = (value, prefix) => SUPPLIER_KEY_RE.test(value) && value.startsWith(prefix) && value.length > prefix.length;
  const problems = [
    [flightName !== '' && flightName !== 'duffel', 'BUSINESS_FLIGHT_SUPPLIER must be duffel or empty.'],
    [hotelName !== '' && hotelName !== 'liteapi', 'BUSINESS_HOTEL_SUPPLIER must be liteapi or empty.'],
    [hotelName !== '' && flightName === '', 'BUSINESS_HOTEL_SUPPLIER needs a working flight supplier (BUSINESS_FLIGHT_SUPPLIER).'],
    [flightName === 'duffel' && !token, 'DUFFEL_ACCESS_TOKEN is not set.'],
    [flightName === 'duffel' && token && !isKey(token, SUPPLIER_TEST_PREFIX.duffel), 'DUFFEL_ACCESS_TOKEN is not a Duffel test token.'],
    [hotelName === 'liteapi' && !key, 'LITEAPI_API_KEY is not set.'],
    [hotelName === 'liteapi' && key && !isKey(key, SUPPLIER_TEST_PREFIX.liteapi), 'LITEAPI_API_KEY is not a LiteAPI sandbox key.'],
    [!allowTest, 'BUSINESS_ALLOW_SUPPLIER_TEST is not true, so supplier test data stays off on this site.'],
    [!/^[A-Z]{2}$/.test(nationality), 'BUSINESS_GUEST_NATIONALITY must be a two-letter country code.'],
    [cacheSeconds === null, 'BUSINESS_SUPPLIER_CACHE_SECONDS must be a whole number from 0 to 900.'],
    [companyCallsPerHour === null, 'BUSINESS_SUPPLIER_COMPANY_CALLS_PER_HOUR must be a whole number of 1 or more.'],
    [variantSearches === null, 'BUSINESS_SUPPLIER_VARIANT_SEARCHES must be a whole number from 0 to 20.'],
  ];
  const found = configured ? problems.find(([bad]) => bad) : null;
  const problem = found ? found[1] : null;
  const out = {
    configured,
    flights: flightName === 'duffel' ? 'duffel' : null,
    hotels: hotelName === 'liteapi' ? 'liteapi' : null,
    allowTest,
    guestNationality: /^[A-Z]{2}$/.test(nationality) ? nationality : 'US',
    cacheSeconds: cacheSeconds ?? 300,
    companyCallsPerHour: companyCallsPerHour ?? 120,
    variantSearches: variantSearches ?? 4,
    problem,
  };
  if (configured && !problem) {
    Object.defineProperty(out, 'duffelToken', { value: token, enumerable: false });
    if (out.hotels) Object.defineProperty(out, 'liteapiKey', { value: key, enumerable: false });
  }
  return Object.freeze(out);
}

function databaseUrlFromParts(env) {
  if (!env.DATABASE_HOST) return null;
  if (!env.DATABASE_NAME || !env.DATABASE_USER || !env.DATABASE_PASSWORD) {
    throw new Error('DATABASE_HOST needs DATABASE_NAME, DATABASE_USER and DATABASE_PASSWORD too');
  }
  const port = env.DATABASE_PORT || '5432';
  return `postgres://${encodeURIComponent(env.DATABASE_USER)}:${encodeURIComponent(env.DATABASE_PASSWORD)}@${env.DATABASE_HOST}:${port}/${encodeURIComponent(env.DATABASE_NAME)}`;
}

function loadConfig(env = process.env) {
  const appEnv = env.APP_ENV || 'development';
  if (!APP_ENVS.includes(appEnv)) throw new Error(`APP_ENV must be one of ${APP_ENVS.join(', ')} (got "${appEnv}")`);
  const isProduction = appEnv === 'production';

  // ENABLE_<VERTICALS> / <VERTICAL>_PROVIDER — on by default outside production so the demo is complete; in production each
  // vertical has to be switched on explicitly once it has a real supplier behind it.
  const flags = {};
  const providers = {};
  for (const v of VERTICALS) {
    flags[v.key] = bool(env[`ENABLE_${v.envKey}`], !isProduction);
    providers[v.key] = (env[v.providerEnv] || 'mock').trim().toLowerCase();
  }

  // Demo inventory (the mock providers) is development/staging material. Production refuses it unless
  // ALLOW_DEMO_INVENTORY=true is set on purpose, e.g. for a public sales demo that takes no real money.
  const allowDemoInventory = bool(env.ALLOW_DEMO_INVENTORY, !isProduction);

  const paymentMode = (env.PAYMENT_MODE || 'test').trim().toLowerCase();
  if (!['test', 'live'].includes(paymentMode)) throw new Error(`PAYMENT_MODE must be "test" or "live" (got "${paymentMode}")`);
  const payment = {
    mode: paymentMode,
    liveProcessor: (env.PAYMENT_LIVE_PROCESSOR || '').trim().toLowerCase() || null,
    liveSecretKey: env.PAYMENT_LIVE_SECRET_KEY || null,
    liveWebhookSecret: env.PAYMENT_LIVE_WEBHOOK_SECRET || null,
    currency: (env.PAYMENT_CURRENCY || 'USD').toUpperCase(),
  };
  if (payment.mode === 'live') {
    // Real charges need all three: production, a named processor and its credentials. Anything less
    // fails at boot rather than half-working at checkout.
    if (!isProduction) throw new Error('PAYMENT_MODE=live is only allowed when APP_ENV=production');
    if (!payment.liveProcessor || !payment.liveSecretKey || !payment.liveWebhookSecret) {
      throw new Error('PAYMENT_MODE=live needs PAYMENT_LIVE_PROCESSOR, PAYMENT_LIVE_SECRET_KEY and PAYMENT_LIVE_WEBHOOK_SECRET');
    }
    if (allowDemoInventory) throw new Error('PAYMENT_MODE=live cannot be combined with ALLOW_DEMO_INVENTORY=true — demo inventory must never take real money');
  }

  // Each environment has its own database. Development may run on the in-memory store; staging and
  // production must point at their own Postgres and the URL must say which environment it is for,
  // so a staging deploy can't be pointed at the production database by a copy-paste.
  // DATABASE_URL=memory is an explicit opt-in to the in-memory store for a throwaway staging demo
  // (bookings vanish on restart); production never accepts it.
  // On AWS the database password comes from Secrets Manager as separate parts, so DATABASE_HOST /
  // DATABASE_NAME / DATABASE_USER / DATABASE_PASSWORD (and DATABASE_PORT) are accepted instead of a URL.
  const databaseUrl = env.DATABASE_URL || databaseUrlFromParts(env);
  if (appEnv !== 'development' && !databaseUrl) throw new Error(`DATABASE_URL is required when APP_ENV=${appEnv}`);
  if (databaseUrl === 'memory' && isProduction) throw new Error('DATABASE_URL=memory is not allowed when APP_ENV=production');
  // HTTPS_ONLY turns on HSTS, upgrade-insecure-requests and Secure cookies. It defaults on outside
  // development; a staging site without a certificate (plain http:// address) sets it to false.
  const httpsOnly = bool(env.HTTPS_ONLY, appEnv !== 'development');
  if (isProduction && !httpsOnly) throw new Error('HTTPS_ONLY=false is not allowed when APP_ENV=production');
  if (databaseUrl && env.DATABASE_ENV && env.DATABASE_ENV !== appEnv) {
    throw new Error(`DATABASE_ENV (${env.DATABASE_ENV}) does not match APP_ENV (${appEnv}) — refusing to use another environment's database`);
  }

  // Travel by Budget (the budget trip planner). On by default outside production, like the verticals.
  // Each integration has its own provider switch; 'mock' is the demo inventory and is refused wherever
  // demo inventory is not allowed.
  const tripProvider = name => (env[name] || 'mock').trim().toLowerCase();
  const trips = {
    enabled: bool(env.ENABLE_TRIPS, !isProduction),
    providers: {
      maps: tripProvider('TRIP_MAPS_PROVIDER'),
      weather: tripProvider('TRIP_WEATHER_PROVIDER'),
      flights: tripProvider('TRIP_FLIGHTS_PROVIDER'),
      hotels: tripProvider('TRIP_HOTELS_PROVIDER'),
      activities: tripProvider('TRIP_ACTIVITIES_PROVIDER'),
      transfers: tripProvider('TRIP_TRANSFERS_PROVIDER'),
      guides: tripProvider('TRIP_GUIDES_PROVIDER'),
      notifications: (env.NOTIFY_PROVIDER || 'outbox').trim().toLowerCase(),
    },
    // Signed-in accounts with these emails can open the admin control center (/admin).
    adminEmails: String(env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
    // How often the Savings Hunter re-runs every active hunt while the site runs (hunts also run when
    // opened). 0 turns the scheduler off: hunts then run only when opened, and the pages say so.
    huntIntervalMinutes: int(env.HUNT_INTERVAL_MINUTES, 360, 'HUNT_INTERVAL_MINUTES'),
  };

  // Tripelyx Business (company travel workspaces under /business/...). Off in every APP_ENV unless
  // ENABLE_BUSINESS=true (D11): with it off, every existing page renders exactly as before Business. It
  // runs with Travel by Budget on or off. Not a vertical: it is not in `flags` and never reaches publicConfig.
  const approvalHours = pos(env.BUSINESS_APPROVAL_HOURS, 24, 'BUSINESS_APPROVAL_HOURS');
  if (approvalHours < 4 || approvalHours > 168) throw new Error(`BUSINESS_APPROVAL_HOURS must be from 4 to 168 (got "${env.BUSINESS_APPROVAL_HOURS}")`);
  const business = {
    enabled: bool(env.ENABLE_BUSINESS, false),
    // false: a new company waits for a platform admin to confirm it at /admin/business before teammates can join.
    selfServe: bool(env.BUSINESS_SELF_SERVE, false),
    inviteDays: pos(env.BUSINESS_INVITE_DAYS, 7, 'BUSINESS_INVITE_DAYS'),
    maxOrgsPerUser: pos(env.BUSINESS_MAX_ORGS_PER_USER, 3, 'BUSINESS_MAX_ORGS_PER_USER'),
    // How long a request waits for a decision before it expires: the default for new companies (each
    // company can pick 4 to 168 hours).
    approvalHours,
    writeLimit: pos(env.BUSINESS_WRITE_LIMIT, 300, 'BUSINESS_WRITE_LIMIT'),
    computeLimit: pos(env.BUSINESS_COMPUTE_LIMIT, 30, 'BUSINESS_COMPUTE_LIMIT'),
    authLimit: pos(env.BUSINESS_AUTH_LIMIT, 20, 'BUSINESS_AUTH_LIMIT'),
    // What writes the notes next to cheaper alternatives. Only the rule-based explainer exists ('rules'):
    // no AI model is connected, and anything else fails at boot.
    explainer: oneOf(env.BUSINESS_EXPLAINER || 'rules', ['rules'], 'BUSINESS_EXPLAINER'),
  };
  // The real suppliers (Duffel flights, LiteAPI hotels; design §1.3). Non-enumerable like the keys inside it,
  // so the business block reads, compares and logs exactly as before for everyone who doesn't ask for it.
  Object.defineProperty(business, 'suppliers', { value: businessSuppliers(env, appEnv), enumerable: false });

  // The private preview (infra/preview.yaml, deployed by .github/workflows/preview.yml). PREVIEW_PASSWORD puts
  // a password on every page but /healthz (server/lib/previewGate.js); only its SHA-256 digest is kept here and
  // its text is never quoted in an error. PREVIEW_SEED=business fills an in-memory store with the Business
  // demo companies at boot (server/lib/previewSeed.js). Production refuses both. Unset, nothing changes.
  const previewPassword = env.PREVIEW_PASSWORD || '';
  if (previewPassword && isProduction) throw new Error('PREVIEW_PASSWORD is not allowed when APP_ENV=production');
  if (previewPassword && previewPassword.length < 12) throw new Error('PREVIEW_PASSWORD must be at least 12 characters');
  const previewSeed = env.PREVIEW_SEED ? oneOf(env.PREVIEW_SEED, ['business'], 'PREVIEW_SEED') : null;
  if (previewSeed && isProduction) throw new Error('PREVIEW_SEED is not allowed when APP_ENV=production');
  const preview = {
    gate: previewPassword ? { passwordDigest: passwordDigest(previewPassword) } : null,
    seed: previewSeed,
  };

  return {
    appEnv,
    trips,
    business,
    preview,
    isProduction,
    port: Number(env.PORT || 4100),
    publicBaseUrl: env.PUBLIC_BASE_URL || null,
    trustProxy: bool(env.TRUST_PROXY, false),
    httpsOnly,
    databaseUrl,
    databaseSsl: bool(env.DATABASE_SSL, appEnv !== 'development'),
    // CA bundle for the database's TLS certificate (Amazon RDS uses its own CA; the Docker image ships it).
    databaseSslCaFile: env.DATABASE_SSL_CA_FILE || null,
    flags,
    providers,
    allowDemoInventory,
    payment,
    quoteTtlMinutes: Number(env.QUOTE_TTL_MINUTES || 20),
    paymentWindowMinutes: Number(env.PAYMENT_WINDOW_MINUTES || 20),
    alameinGoUrl: env.ALAMEIN_GO_URL || '/book/hotels?where=New+Alamein',
    contactEmail: env.CONTACT_EMAIL || null,
  };
}

// The only part of config the browser ever sees.
function publicConfig(config) {
  return {
    env: config.appEnv,
    paymentMode: config.payment.mode,
    currency: config.payment.currency,
    verticals: VERTICALS.filter(v => config.flags[v.key]).map(v => ({
      key: v.key, label: v.label, demo: config.providers[v.key] === 'mock',
    })),
  };
}

module.exports = { loadConfig, publicConfig, APP_ENVS };
