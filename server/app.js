const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const { publicConfig } = require('./config');
const { createRegistry } = require('./providers/registry');
const { createStore } = require('./booking');
const { BookingEngine } = require('./booking/engine');
const { createPaymentProcessor } = require('./payments');
const { apiRouter } = require('./routes/api');
const { pagesRouter } = require('./routes/pages');
const { demoMediaRouter } = require('./routes/demoMedia');
const { AppError } = require('./lib/errors');
const { id } = require('./lib/ids');
const { notFoundView, errorView } = require('./views/errors');

const ASSET_VERSION = Date.now().toString(36);

async function createApp(config, { registryOverrides, store: injectedStore, now, log = console } = {}) {
  const store = injectedStore || createStore(config);
  await store.init();
  const registry = createRegistry(config, { overrides: registryOverrides });
  const payments = createPaymentProcessor({ config, store, now });
  const engine = new BookingEngine({ registry, store, payments, config, now, log });

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        ...(config.appEnv === 'development' ? {} : { upgradeInsecureRequests: [] }),
      },
    },
    strictTransportSecurity: config.appEnv === 'development' ? false : { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  }));
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
    next();
  });
  app.use(compression());

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, {
    index: false,
    maxAge: config.appEnv === 'development' ? 0 : '7d',
    setHeaders(res, file) {
      if (/\.(woff2|webp|jpg|svg)$/.test(file) && config.appEnv !== 'development') res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    },
  }));

  app.get('/healthz', (req, res) => res.json({ ok: true, env: config.appEnv, store: store.kind }));

  const ctx = {
    config,
    engine,
    store,
    registry,
    payments,
    publicConfig: publicConfig(config),
    assetVersion: ASSET_VERSION,
    envBanner: config.appEnv === 'production' ? null
      : `${config.appEnv === 'staging' ? 'Staging' : 'Development'} build · demo inventory · payments in ${config.payment.mode} mode — no real charges`,
    alameinGoUrl: config.alameinGoUrl,
    log,
  };

  if (config.allowDemoInventory) app.use('/media/demo', demoMediaRouter());

  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use('/api', apiLimiter, apiRouter(ctx, { writeLimiter }));
  app.use('/', pagesRouter(ctx, { writeLimiter }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
    res.status(404).type('html').send(String(notFoundView(ctx)));
  });

  // Errors: known AppErrors are shown as-is; anything else gets a generic message and a reference id
  // that is logged with the full error, so a traveler can quote it to support.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const known = err instanceof AppError;
    const status = known ? err.status : (err.status === 400 && err.type === 'entity.parse.failed' ? 400 : 500);
    const ref = id('err').slice(4, 14);
    if (!known && status >= 500) log.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, err);
    const body = known
      ? { code: err.code, message: err.message, details: err.details }
      : status === 400
        ? { code: 'bad_request', message: 'The request could not be read.' }
        : { code: 'internal', message: 'Something went wrong on our side. Please try again.', ref };
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: body });
    res.status(status).type('html').send(String(errorView(ctx, { status, ...body })));
  });

  return { app, engine, store, registry, payments, ctx };
}

module.exports = { createApp };
