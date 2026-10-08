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
const { Repo } = require('./business/repo');
const { createBusinessInventory } = require('./business/inventory');
const { TripComposer } = require('./business/search');
const { createPolicyEngine } = require('./business/policy');
const { createExplainer } = require('./business/explain');
const businessAlternatives = require('./business/alternatives');
const businessDiff = require('./business/diff');
const businessRoutes = require('./routes/business');
const businessPlatform = require('./routes/businessPlatform');
const { AppError } = require('./lib/errors');
const { id } = require('./lib/ids');
const { notFoundView, errorView } = require('./views/errors');

const ASSET_VERSION = Date.now().toString(36);

/** A 43-or-more character base64url run: the shape of every secret token (session, invite). */
const TOKEN_RUN = /[A-Za-z0-9_-]{43,}/g;

/**
 * A request URL fit for the error log (D9): invite tokens in paths, any `…token=` query value and any
 * token-shaped run (43 or more base64url characters, also inside an encoded ?next=) are replaced, and the
 * result is cut to 500 characters. Request bodies are never logged.
 * @param {unknown} url req.originalUrl
 * @returns {string}
 */
function redactUrl(url) {
  return redactText(url).slice(0, 500);
}

/** redactUrl's replacements on any text, uncut (an error's message and stack can quote the URL or a param). */
function redactText(text) {
  return String(text ?? '')
    .replace(/(\/business\/invite\/)[^/?#]*/gi, '$1[redacted]')
    .replace(/([?&;][^=&;#]*token)=[^&;#]*/gi, '$1=[redacted]')
    .replace(TOKEN_RUN, '[token]');
}

/** An unexpected error as the log keeps it: its stack (or text) and code, redacted like the URL (D9). */
function redactError(err) {
  const text = err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : String(err);
  const code = err && typeof err.code === 'string' ? ` [code ${err.code}]` : '';
  return redactText(text + code);
}

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
  // Accounts (sign-in, sessions) run for Travel by Budget and for Tripelyx Business, which works with
  // Travel by Budget off too.
  const accounts = inventory || config.business.enabled ? new Accounts({ store, config, now: clock }) : null;
  let tripService = null, agent = null, hunts = null, business = null;
  if (inventory) {
    const notifier = createNotifier(config, { store, now: clock, log });
    tripService = new TripService({ inventory, store, notifier, config, now: clock, log });
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
  // Platform admins (D1): grandfathered ADMIN_EMAILS accounts get their platform_admin record at boot.
  if (accounts) await accounts.seedPlatformAdmins({ log });
  // Tripelyx Business (server/business): built only when ENABLE_BUSINESS is on, with Travel by Budget on or off.
  // It reaches the store only through its Repo. Its menu item, header class and footer link follow it
  // (ctx.businessNav, server/views/layout.js).
  // Its inventory is its own (server/business/inventory.js: demo where demo inventory is allowed, else
  // "Supplier not connected yet"); it never calls BookingEngine or payments.
  if (config.business.enabled) {
    const bizInventory = createBusinessInventory(config, { registry });
    business = new BusinessService({
      repo: new Repo({ store, now: clock, log }),
      accounts,
      config,
      now: clock,
      log,
      inventory: bizInventory,
      composer: new TripComposer({ inventory: bizInventory, now: clock }),
      policy: createPolicyEngine(),
      alternatives: Object.freeze({
        buildAlternatives: input => businessAlternatives.buildAlternatives(input),
        compareTrips: (a, b) => businessDiff.compareTrips(a, b),
      }),
      explainer: createExplainer(config),
    });
  }

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

  // Who is asking: the signed-in user (session cookie) and an anonymous visitor id for the funnel.
  if (tripService) {
    app.use(async (req, res, next) => {
      try {
        req.user = await accounts.userFromRequest(req);
        req.visitor = visitorId(req, req.path.startsWith('/api/') ? null : res, config);
        runWithContext({ user: req.user, visitor: req.visitor }, () => next());
      } catch (e) { next(e); }
    });
  } else if (business) {
    // Business with Travel by Budget off: read the session for the Business pages only, and set no visitor
    // cookie (the funnel belongs to Travel by Budget). Every other page stays exactly as it is with trips off.
    app.use(['/business', '/admin/business'], async (req, res, next) => {
      try {
        req.user = await accounts.userFromRequest(req);
        req.visitor = null;
        runWithContext({ user: req.user, visitor: null }, () => next());
      } catch (e) { next(e); }
    });
  }

  if (config.allowDemoInventory) app.use('/media/demo', demoMediaRouter());

  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false });
  // Searches and the downward price search price hundreds of packages per request.
  const computeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use('/api', apiLimiter, apiRouter(ctx, { writeLimiter }));
  // Tripelyx Business mounts (plan §J), when Business is on: the platform admin page at /admin/business
  // before /admin (it works with trips off too), then the Business routers (routes/business/index.js) after
  // /admin and before agentRouter, whose path-less r.use() header setters would otherwise run first (with
  // trips off: before pagesRouter). None defines GET /business: pagesRouter serves the company page.
  const bizRouterDeps = business ? businessRoutes.createRouterDeps(ctx) : null;
  if (business) app.use(businessPlatform.MOUNT, businessPlatform.router(ctx, bizRouterDeps));
  if (tripService) app.use('/admin', adminRouter(ctx, { writeLimiter }));
  if (business) app.use(businessRoutes.MOUNT, businessRoutes.router(ctx, bizRouterDeps));
  if (tripService) {
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
    // A client error raised by Express or the body parser (the router's URIError for a malformed escape in a
    // path param; an http-errors error, expose true, for a body that can't be parsed or is too large) keeps
    // its 4xx status and is not a server fault, so it isn't logged. Any other error is a 500.
    const clientStatus = !known && err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500
      && (err.expose === true || err instanceof URIError) ? err.status : null;
    const status = known ? err.status : (clientStatus ?? 500);
    const ref = id('err').slice(4, 14);
    if (!known && status >= 500) log.error(`[error ${ref}] ${req.method} ${redactUrl(req.originalUrl)}`, redactError(err));
    const body = known
      ? { code: err.code, message: err.message, details: err.details }
      : clientStatus
        ? { code: 'bad_request', message: 'The request could not be read.' }
        : { code: 'internal', message: 'Something went wrong on our side. Please try again.', ref };
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: body });
    res.status(status).type('html').send(String(errorView(ctx, { status, ...body })));
  });

  return { app, engine, store, registry, payments, ctx, tripService, accounts, agent, hunts, business };
}

module.exports = { createApp, redactUrl };
