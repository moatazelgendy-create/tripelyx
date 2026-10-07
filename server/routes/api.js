// JSON API used by the booking pages. Every write requires a JSON body (so a cross-site HTML form
// can't hit it) and booking access rides on a SameSite=Strict, HttpOnly cookie scoped per booking.
const express = require('express');
const { AppError } = require('../lib/errors');
const { id } = require('../lib/ids');
const { validateMessage } = require('../lib/validate');
const { VERTICALS } = require('../verticals');
const { readCookies, bookingCookieName, setBookingCookie } = require('../lib/cookies');

function requireJson(req, res, next) {
  if (!req.is('application/json')) return next(new AppError('unsupported_media_type', 'Send JSON.', 415));
  next();
}

function apiRouter(ctx, { writeLimiter }) {
  const { engine, config } = ctx;
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }));
  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  r.get('/config', (req, res) => {
    const lookups = {};
    for (const v of VERTICALS) {
      const p = ctx.registry.get(v.key);
      if (p && typeof p.lookups === 'function') lookups[v.key] = p.lookups();
    }
    res.json({ ...ctx.publicConfig, search: Object.fromEntries(VERTICALS.filter(v => config.flags[v.key]).map(v => [v.key, v.search])), lookups });
  });

  r.get('/search/:vertical', async (req, res, next) => {
    try {
      const { query, offers } = await engine.search(req.params.vertical, req.query);
      res.json({ query, count: offers.length, offers });
    } catch (e) { next(e); }
  });

  r.get('/offers/:vertical/:offerId', async (req, res, next) => {
    try {
      res.json(await engine.getOffer(req.params.vertical, req.params.offerId, req.query));
    } catch (e) { next(e); }
  });

  r.post('/quotes', writeLimiter, requireJson, async (req, res, next) => {
    try {
      const { vertical, offerId, optionId, query, selection } = req.body || {};
      const quote = await engine.createQuote({ vertical, offerId, optionId, query, selection });
      res.status(201).json({ quoteId: quote.id, total: quote.total, currency: quote.currency, expiresAt: quote.expiresAt, checkoutUrl: `/checkout/${quote.id}` });
    } catch (e) { next(e); }
  });

  r.post('/bookings', writeLimiter, requireJson, async (req, res, next) => {
    try {
      const { quoteId, traveler } = req.body || {};
      const out = await engine.createBooking({ quoteId, traveler, userId: req.user ? req.user.id : null });
      setBookingCookie(res, out.booking.ref, out.accessToken, config);
      res.status(201).json({ booking: out.booking, payment: out.payment });
    } catch (e) { next(e); }
  });

  const auth = req => ({ token: readCookies(req)[bookingCookieName(req.params.ref)] });

  r.get('/bookings/:ref', async (req, res, next) => {
    try {
      res.json(await engine.getBooking(req.params.ref, auth(req)));
    } catch (e) { next(e); }
  });

  r.post('/bookings/:ref/pay', writeLimiter, requireJson, async (req, res, next) => {
    try {
      res.json(await engine.payBooking(req.params.ref, auth(req), (req.body || {}).method));
    } catch (e) { next(e); }
  });

  r.post('/bookings/:ref/cancel', writeLimiter, requireJson, async (req, res, next) => {
    try {
      res.json(await engine.cancelBooking(req.params.ref, auth(req)));
    } catch (e) { next(e); }
  });

  r.post('/bookings/lookup', writeLimiter, requireJson, async (req, res, next) => {
    try {
      const { ref, email } = req.body || {};
      const b = await engine.authorize(ref, { email });
      // Exchange ref + email for the booking's access cookie so the manage page can load it.
      const token = await engine.issueAccessToken(b);
      setBookingCookie(res, b.ref, token, config);
      res.json({ ref: b.ref, url: `/booking/${b.ref}` });
    } catch (e) { next(e); }
  });

  // Contact support and For travel businesses. The message is saved and support is told at once (the
  // admin outbox and the Messages tab), so nothing a traveler sends goes unread.
  r.post(['/messages', '/partners'], writeLimiter, requireJson, async (req, res, next) => {
    try {
      // A hidden honeypot field: humans never fill it, form bots usually do.
      if (req.body && req.body.website) return res.status(201).json({ ok: true });
      const msg = { id: id('msg'), ...validateMessage(req.body), createdAt: new Date().toISOString() };
      await ctx.store.savePartnerLead(msg);
      if (ctx.tripService) {
        await ctx.tripService.notifier.send({ to: 'support', audience: 'admin', subject: `${msg.kind === 'partner' ? 'Business enquiry' : 'Support message'}: ${msg.type || 'no topic'}`, body: `${msg.name} <${msg.email}>: ${msg.message.slice(0, 200)}`, ref: msg.id });
      }
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });

  r.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } }));
  return r;
}

module.exports = { apiRouter };
