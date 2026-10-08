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
const { tripsRouter, sameOrigin } = require('./routes/trips');
const { agentRouter } = require('./routes/agent');
const { AgentService } = require('./agent/agent');
const { huntsRouter } = require('./routes/hunts');
const { HuntService } = require('./trips/hunts');
const { adminRouter } = require('./routes/admin');
const { Accounts, visitorId } = require('./accounts');
const { runWithContext } = require('./lib/requestContext');
const { createTripIntegrations } = require('./trips/integrations');
const { createNotifier } = require('./trips/integrations/notifications');
const { TripService } = require('./trips/service');
const { demoMediaRouter } = require('./routes/demoMedia');
const { BusinessService } = require('./business/service');
const { createBusinessLimits } = require('./business/limits');
const { businessRouter } = require('./routes/business');
const { clientRouter, brandRouter, previewRouter } = require('./routes/businessClient');
const { AppError } = require('./lib/errors');
const { id } = require('./lib/ids');
const { notFoundView, errorView } = require('./views/errors');

const ASSET_VERSION = Date.now().toString(36);
/** Business paths that never read the session or set the visitor cookie: client pages, brand.css, logos. */
const BUSINESS_PUBLIC_PATH = /^\/business\/(?:p|brand)(?:\/|$)/i; // case-insensitive, like Express routing

async function createApp(config, { registryOverrides, tripOverrides, store: injectedStore, now, log = console } = {}) {
  const store = injectedStore || createStore(config);
  await store.init();
  const registry = createRegistry(config, { overrides: registryOverrides });
  const payments = createPaymentProcessor({ config, store, now });
  const engine = new BookingEngine({ registry, store, payments, config, now, log });

  // Travel by Budget: on when ENABLE_TRIPS allows it and every integration it needs is available
  // (mock inventory is refused where demo inventory isn't allowed).
  const clock = now || (() => new Date());
  const inventory = config.trips.enabled ? createTripIntegrations(config, { now: clock, overrides: tripOverrides }) : null;
  let tripService = null, accounts = null, agent = null, hunts = null, business = null;
  if (inventory) {
    const notifier = createNotifier(config, { store, now: clock, log });
    tripService = new TripService({ inventory, store, notifier, config, now: clock, log });
    accounts = new Accounts({ store, config, now: clock });
    // The AI Savings Hunter: stored hunts, re-run on open and on a timer (server/trips/hunts). The
    // timer stays off under the test runner, where tests call runDue themselves.
    hunts = new HuntService({ store, inventory, settings: () => tripService.settings(), notifier, now: clock, log, config });
    if (!process.env.NODE_TEST && !process.env.NODE_TEST_CONTEXT) hunts.start();
    // The AI travel agent: the deterministic engines behind a conversation (server/agent), with the
    // hunt service for "hunt for a better deal".
    agent = new AgentService({ tripService, store, now: clock, log, hunts });
    engine.extraProviders.trips = tripService.bookingProvider();
    engine.hooks.bookingEvent = (type, b) => tripService.onBookingEvent(type, b).catch(e => log.error('[trips] booking event', e));
  } else if (config.trips.enabled) {
    log.warn('[trips] Travel by Budget is off: mock trip inventory is not allowed here (set ALLOW_DEMO_INVENTORY=true or name real TRIP_*_PROVIDER adapters).');
  }
  // Tripelyx Business (server/business): built only when ENABLE_BUSINESS is on, with Travel by Budget on or off.
  // Its menu item, header class and footer link follow it (ctx.businessNav, server/views/layout.js).
  business = config.business.enabled ? new BusinessService({ store, tripService, config, now: clock, log }) : null;

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
        ...(config.httpsOnly ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: !config.httpsOnly ? false : { maxAge: 31536000, includeSubDomains: true },
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
    now: clock,
    envBanner: config.appEnv === 'production' ? null
      : `${config.appEnv === 'staging' ? 'Staging' : 'Development'} build · demo inventory · payments in ${config.payment.mode} mode — no real charges`,
    alameinGoUrl: config.alameinGoUrl,
    log,
    trips: !!tripService,
    tripService,
    accounts,
    agent,
    hunts,
    business,
    businessNav: !!business,
  };

  // Tripelyx Business public routes: the white-label client pages and each agency's brand.css and logo.
  // They mount before "who is asking" so they never read the session cookie or set the Tripelyx visitor
  // cookie (plan §G), and before agentRouter and tripsRouter, whose path-less r.use() header setters would
  // otherwise run first. Neither needs req.user. They have their own limiters, never the shared writeLimiter.
  const bizLim = business ? createBusinessLimits(config.business, { logger: log }) : null;
  if (business) {
    app.use('/business/brand', brandRouter(ctx, bizLim));
    app.use('/business/p', clientRouter(ctx, { ...bizLim, sameOrigin }));
  }

  // Who is asking: the signed-in user (session cookie) and an anonymous visitor id for the funnel.
  if (tripService) {
    app.use(async (req, res, next) => {
      try {
        // A request under the Business client or brand paths that fell through to the 404 stays anonymous
        // too: no session read, no visitor cookie.
        if (business && BUSINESS_PUBLIC_PATH.test(req.path)) {
          req.user = null;
          req.visitor = null;
          return runWithContext({ user: null, visitor: null }, () => next());
        }
        req.user = await accounts.userFromRequest(req);
        req.visitor = visitorId(req, req.path.startsWith('/api/') ? null : res, config);
        runWithContext({ user: req.user, visitor: req.visitor }, () => next());
      } catch (e) { next(e); }
    });
  }

  if (config.allowDemoInventory) app.use('/media/demo', demoMediaRouter());

  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false });
  // Searches and the downward price search price hundreds of packages per request.
  const computeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use('/api', apiLimiter, apiRouter(ctx, { writeLimiter }));
  if (tripService) {
    app.use('/admin', adminRouter(ctx, { writeLimiter }));
    if (business) {
      // The signed-in Business routers (they need req.user) mount here, after /admin and before
      // agentRouter and tripsRouter, whose path-less r.use() header setters would otherwise run first.
      // Neither defines GET /business (pagesRouter serves it). /business/brand and /business/p are
      // mounted above, before "who is asking".
      app.use('/business', previewRouter(ctx, { ...bizLim, sameOrigin }));
      app.use('/business', businessRouter(ctx, { ...bizLim, sameOrigin }));
    }
    app.use('/', agentRouter(ctx, { writeLimiter, computeLimiter, sameOrigin }));
    app.use('/', huntsRouter(ctx, { writeLimiter, computeLimiter, sameOrigin }));
    app.use('/', tripsRouter(ctx, { writeLimiter, computeLimiter }));
  }
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

  return { app, engine, store, registry, payments, ctx, tripService, accounts, agent, hunts, business };
}

module.exports = { createApp };
