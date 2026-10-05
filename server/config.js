// Every runtime setting comes from the environment (see .env.example). Nothing secret is ever
// hard-coded, and nothing in here is ever sent to the browser except the explicit `publicConfig()`
// projection at the bottom — the frontend only ever learns which verticals are on and whether
// payments are in test mode, never a key, URL with credentials, or provider name it doesn't need.
const { VERTICALS } = require('./verticals');

const APP_ENVS = ['development', 'staging', 'production'];

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
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

  return {
    appEnv,
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
