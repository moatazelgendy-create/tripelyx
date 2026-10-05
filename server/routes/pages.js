const express = require('express');
const { homeView } = require('../views/home');
const { refine, parseRefine } = require('../booking/refine');
const { brandsView, technologyView, partnersView, aboutView, contactView } = require('../views/pages');
const { bookView, bookIndexView, offerView, checkoutView, bookingView, manageView, defaultsFor } = require('../views/book');
const { notFoundView } = require('../views/errors');
const { VERTICALS, getVertical } = require('../verticals');
const { AppError } = require('../lib/errors');
const { readCookies, bookingCookieName, setBookingCookie } = require('../lib/cookies');

function send(res, view) {
  res.type('html').send(String(view));
}

function pagesRouter(ctx, { writeLimiter }) {
  const { engine, config } = ctx;
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); });

  r.get('/', (req, res) => {
    const verticals = VERTICALS.filter(v => enabled(v.key)).map(v => ({ meta: v, values: defaultsFor(v), lookups: lookupsFor(v.key) }));
    send(res, homeView(ctx, { verticals }));
  });
  r.get('/brands', (req, res) => send(res, brandsView(ctx)));
  r.get('/technology', (req, res) => send(res, technologyView(ctx)));
  r.get('/partners', (req, res) => send(res, partnersView(ctx)));
  r.get('/about', (req, res) => send(res, aboutView(ctx)));
  r.get('/contact', (req, res) => send(res, contactView(ctx)));

  r.get('/book', (req, res) => send(res, bookIndexView(ctx)));

  const enabled = vertical => getVertical(vertical) && config.flags[vertical] && ctx.registry.get(vertical);
  const lookupsFor = vertical => {
    const p = ctx.registry.get(vertical);
    return p && typeof p.lookups === 'function' ? p.lookups() : {};
  };

  // Results render on the server (works without JS); book.js swaps in the same fragment with a
  // loading skeleton when JS is available (?partial=1).
  r.get('/book/:vertical', async (req, res, next) => {
    const { vertical } = req.params;
    if (!enabled(vertical)) return res.status(404).type('html').send(String(notFoundView(ctx)));
    const meta = getVertical(vertical);
    const raw = { ...defaultsFor(meta) };
    for (const f of meta.search) if (typeof req.query[f.name] === 'string') raw[f.name] = req.query[f.name];
    let state;
    try {
      state = await engine.search(vertical, raw);
      state.refineQuery = parseRefine(req.query);
      state.refined = refine(state.offers, state.refineQuery);
    } catch (err) {
      if (!(err instanceof AppError)) return next(err);
      state = { error: { status: err.status, message: err.message, details: err.details } };
    }
    if (req.query.partial === '1') {
      const { resultsBlock } = require('../views/book');
      res.status(state.error ? state.error.status : 200);
      return send(res, resultsBlock(vertical, state));
    }
    send(res.status(state.error && state.error.status >= 500 ? state.error.status : 200), bookView(ctx, { vertical, values: raw, state, lookups: lookupsFor(vertical) }));
  });

  r.get('/book/:vertical/:offerId', async (req, res, next) => {
    const { vertical } = req.params;
    if (!enabled(vertical)) return res.status(404).type('html').send(String(notFoundView(ctx)));
    try {
      const raw = { ...defaultsFor(getVertical(vertical)), ...req.query };
      const { query, offer } = await engine.getOffer(vertical, req.params.offerId, raw);
      send(res, offerView(ctx, { vertical, offer, query }));
    } catch (err) { next(err); }
  });

  // Plain form POST (works without JS) → quote → redirect to checkout.
  r.post('/book/:vertical/:offerId/quote', writeLimiter, form, async (req, res, next) => {
    const { vertical, offerId } = req.params;
    if (!enabled(vertical)) return res.status(404).type('html').send(String(notFoundView(ctx)));
    const query = {};
    for (const [k, v] of Object.entries(req.body || {})) if (k.startsWith('q_')) query[k.slice(2)] = v;
    const selection = req.body.slot ? { slot: String(req.body.slot) } : {};
    try {
      const quote = await engine.createQuote({ vertical, offerId, optionId: req.body.optionId, query, selection });
      res.redirect(303, `/checkout/${quote.id}`);
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500 && err.code !== 'supplier_unavailable') return next(err);
      try {
        const { query: q, offer } = await engine.getOffer(vertical, offerId, query);
        res.status(err.status);
        send(res, offerView(ctx, { vertical, offer, query: q, error: err.message, selected: { optionId: req.body.optionId, slot: selection.slot } }));
      } catch (e) { next(e); }
    }
  });

  r.get('/checkout/:quoteId', async (req, res, next) => {
    try {
      const quote = await engine.getQuote(req.params.quoteId);
      res.setHeader('Cache-Control', 'no-store');
      send(res, checkoutView(ctx, { quote, paymentConfig: ctx.payments.clientConfig() }));
    } catch (err) { next(err); }
  });

  r.get('/manage', (req, res) => send(res, manageView(ctx)));
  r.post('/manage', writeLimiter, form, async (req, res, next) => {
    const ref = String(req.body.ref || '').trim().toUpperCase();
    const email = String(req.body.email || '').trim();
    try {
      const b = await engine.authorize(ref, { email });
      setBookingCookie(res, b.ref, await engine.issueAccessToken(b), config);
      res.redirect(303, `/booking/${b.ref}`);
    } catch (err) {
      if (!(err instanceof AppError)) return next(err);
      res.status(err.status);
      send(res, manageView(ctx, { error: err.message, ref, email }));
    }
  });

  const cookieAuth = req => ({ token: readCookies(req)[bookingCookieName(req.params.ref)] });

  r.get('/booking/:ref', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await engine.getBooking(req.params.ref, cookieAuth(req));
      send(res, bookingView(ctx, { ...data, notice: req.query.cancelled ? 'Your booking has been cancelled.' : null }));
    } catch (err) {
      if (err instanceof AppError && err.code === 'booking_not_found') return send(res.status(404), manageView(ctx, { ref: String(req.params.ref).toUpperCase().slice(0, 20) }));
      next(err);
    }
  });

  // Cancel without JS. The cookie is SameSite=Strict, so a cross-site form can't trigger this.
  r.post('/booking/:ref/cancel', writeLimiter, form, async (req, res, next) => {
    try {
      const { booking } = await engine.cancelBooking(req.params.ref, cookieAuth(req));
      res.redirect(303, `/booking/${booking.ref}?cancelled=1`);
    } catch (err) { next(err); }
  });

  return r;
}

module.exports = { pagesRouter };
