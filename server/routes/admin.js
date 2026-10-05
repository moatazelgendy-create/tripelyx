// The admin control center. Only signed-in accounts listed in ADMIN_EMAILS can see it; everyone else
// gets the same 404 as a page that doesn't exist.
const express = require('express');
const { AppError } = require('../lib/errors');
const { str } = require('../lib/validate');
const admin = require('../views/trips/admin');
const { notFoundView } = require('../views/errors');
const { sameOrigin } = require('./trips');

const STATUSES = ['pending_payment', 'confirming', 'pending_supplier', 'confirmed', 'partially_confirmed', 'failed', 'cancelled', 'refund_pending', 'refunded', 'expired'];

function adminRouter(ctx, { writeLimiter }) {
  const { tripService: svc, store } = ctx;
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '32kb' });
  const send = (res, view) => res.type('html').send(String(view));

  r.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.user || !req.user.isAdmin) return send(res.status(404), notFoundView(ctx));
    next();
  });

  r.get('/', async (req, res, next) => {
    try { send(res, admin.overviewView(ctx, { d: await svc.dashboard({ days: 30 }), bookings: await svc.findBookings() })); } catch (e) { next(e); }
  });

  r.get('/bookings', async (req, res, next) => {
    try {
      const q = str(req.query.q, 80), status = STATUSES.includes(req.query.status) ? req.query.status : '';
      send(res, admin.bookingsView(ctx, { list: await svc.findBookings({ q, status }), q, status, statuses: STATUSES }));
    } catch (e) { next(e); }
  });

  const loadBooking = async ref => {
    const b = await store.getBookingByRef(String(ref).toUpperCase().slice(0, 24));
    if (!b || b.vertical !== 'trips') throw new AppError('booking_not_found', 'Booking not found.', 404);
    return b;
  };
  r.get('/bookings/:ref', async (req, res, next) => {
    try {
      const b = await loadBooking(req.params.ref);
      send(res, admin.bookingDetailView(ctx, { b, messages: await svc.supportMessages(b.ref), notice: req.query.ok ? 'Saved.' : null }));
    } catch (e) { next(e); }
  });
  r.post('/bookings/:ref/status', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try { const b = await loadBooking(req.params.ref); await svc.adminSetStatus(b.ref, String(req.body.status), req.body.note, req.user); res.redirect(303, `/admin/bookings/${b.ref}?ok=1`); } catch (e) { next(e); }
  });
  r.post('/bookings/:ref/message', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const b = await loadBooking(req.params.ref);
      await svc.addSupportMessage(b.ref, { from: 'staff', text: req.body.text, name: req.user.name });
      await svc.notifier.send({ to: b.traveler.email, subject: `A reply about TRIP #${b.ref}`, body: str(req.body.text, 2000), ref: b.ref });
      res.redirect(303, `/admin/bookings/${b.ref}?ok=1`);
    } catch (e) { next(e); }
  });

  r.get('/requests', async (req, res, next) => {
    try { send(res, admin.requestsView(ctx, { requests: await store.listRecords('trip_request', { limit: 500 }), notice: req.query.ok ? 'Saved.' : null })); } catch (e) { next(e); }
  });
  r.post('/requests/:id/status', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const rq = await store.getRecord('trip_request', String(req.params.id).slice(0, 40));
      if (!rq) throw new AppError('not_found', 'Not found.', 404);
      const status = ['received', 'building', 'ready', 'awaiting_approval', 'booked', 'closed'].includes(req.body.status) ? req.body.status : rq.status;
      await store.putRecord('trip_request', rq.id, { ...rq, status, updatedAt: new Date().toISOString() }, { userId: rq.userId });
      res.redirect(303, '/admin/requests?ok=1');
    } catch (e) { next(e); }
  });

  r.get('/settings', async (req, res, next) => {
    try { send(res, admin.settingsView(ctx, { settings: await svc.settings(), destinations: svc.inv.maps.listDestinations(), notice: req.query.ok ? 'Rules saved.' : null })); } catch (e) { next(e); }
  });
  r.post('/settings', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const enabled = new Set([].concat(req.body.enabled || []));
      await svc.saveSettings({ ...req.body, disabledDestinations: svc.inv.maps.listDestinations().map(d => d.id).filter(id => !enabled.has(id)) });
      res.redirect(303, '/admin/settings?ok=1');
    } catch (e) {
      if (!(e instanceof AppError)) return next(e);
      send(res.status(e.status), admin.settingsView(ctx, { settings: await svc.settings(), destinations: svc.inv.maps.listDestinations(), error: e.message }));
    }
  });

  r.get('/promos', async (req, res, next) => {
    try { send(res, admin.promosView(ctx, { promos: await store.listRecords('promo', { limit: 200 }), notice: req.query.ok ? 'Saved.' : null })); } catch (e) { next(e); }
  });
  r.post('/promos', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const code = str(req.body.code, 30).toUpperCase().replace(/[^A-Z0-9-]/g, '');
      const type = req.body.type === 'percent' ? 'percent' : 'amount';
      const value = Number(req.body.value);
      const minTotal = Number(req.body.minTotal || 0);
      const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresAt || '') ? req.body.expiresAt : null;
      if (code.length < 3 || !Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 50) || (type === 'amount' && value > 2000) || !Number.isFinite(minTotal) || minTotal < 0) throw new AppError('invalid_promo', 'Check the code and value (percent up to 50, amount up to $2,000).', 422);
      await store.putRecord('promo', code, { code, type, value: type === 'percent' ? Math.round(value) : Math.round(value * 100), minTotal: Math.round(minTotal * 100), expiresAt, active: true, createdAt: new Date().toISOString(), by: req.user.email });
      res.redirect(303, '/admin/promos?ok=1');
    } catch (e) {
      if (!(e instanceof AppError)) return next(e);
      send(res.status(e.status), admin.promosView(ctx, { promos: await store.listRecords('promo', { limit: 200 }), error: e.message }));
    }
  });
  r.post('/promos/:code/toggle', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const p = await store.getRecord('promo', str(req.params.code, 30).toUpperCase());
      if (!p) throw new AppError('not_found', 'Not found.', 404);
      await store.putRecord('promo', p.code, { ...p, active: !p.active });
      res.redirect(303, '/admin/promos?ok=1');
    } catch (e) { next(e); }
  });

  r.get('/outbox', async (req, res, next) => {
    try { send(res, admin.outboxView(ctx, { messages: await store.listRecords('outbox', { limit: 300 }) })); } catch (e) { next(e); }
  });

  return r;
}

module.exports = { adminRouter };
