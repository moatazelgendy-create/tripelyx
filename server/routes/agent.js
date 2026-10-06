// The travel agent's pages: start a conversation, say something, and the live regions the page polls
// while a search job runs. Every change goes through the same text the traveler could have typed.
const express = require('express');
const { AppError } = require('../lib/errors');
const { readCookies, bookingCookieName } = require('../lib/cookies');
const optimizer = require('../trips/optimizer');
const decision = require('../trips/decision');
const state = require('../agent/state');
const { agentView, agentStartView, agentLive } = require('../views/trips/agent');
const { bookingHome } = require('../agent/home');
const { notFoundView } = require('../views/errors');

const send = (res, view) => res.type('html').send(String(view));

function agentRouter(ctx, { writeLimiter, computeLimiter, sameOrigin }) {
  const { tripService: svc, agent } = ctx;
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  const compute = computeLimiter || ((req, res, next) => next());
  const user = req => req.user || null;
  const said = body => { const v = [].concat(body.say || [], body.example || []).filter(x => typeof x === 'string' && x.trim()); return v.length ? v[v.length - 1].trim().slice(0, 600) : ''; };

  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const owned = async (req, res) => {
    const s = await agent.load(req.params.id);
    if (!agent.owns(s, { visitor: req.visitor, user: user(req) })) { send(res.status(404), notFoundView(ctx)); return null; }
    return s;
  };

  // What the canvas shows: the current trip re-priced now, its verdict and the budget context.
  const canvasFor = async s => {
    if (!s.current) {
      // A conversation about a booked trip: the canvas is the agent's home for that booking.
      if (!s.booking) return null;
      const b = await ctx.store.getBookingByRef(s.booking.ref);
      if (!b || !b.quote || !b.quote.trip) return null;
      let preview = null;
      try { preview = svc.bookingProvider().cancellationPreview(b, svc.now()); } catch (e) { preview = null; }
      return { home: bookingHome(b, { now: svc.now(), preview, origin: svc.inv.maps.getOrigin(b.quote.trip.spec.from) }) };
    }
    try {
      const q = state.toQuery(s, { maps: svc.inv.maps }).query;
      const cx = state.budgetContext(s, q);
      const data = await svc.trip(s.current.token, cx);
      const o = svc.inv.maps.getOrigin(s.origin);
      return { ...data, ctx: cx, verdict: decision.verdict(data.trip, cx, data.scores), originCity: o ? o.city : s.origin };
    } catch (e) { if (e instanceof AppError) return null; throw e; }
  };

  // A booking the conversation is about: the traveler's own (cookie or signed-in owner).
  const bookingFor = async (req, ref) => {
    if (!ref) return null;
    const clean = String(ref).toUpperCase().slice(0, 20);
    try {
      const { booking: b } = await ctx.engine.getBooking(clean, { token: readCookies(req)[bookingCookieName(clean)] });
      return b;
    } catch (e) {
      if (req.user && e instanceof AppError) { const own = (await ctx.store.listBookings({ userId: req.user.id, limit: 200 })).find(x => x.ref === clean); if (own) return ctx.engine.publicBooking(own); }
      if (e instanceof AppError) return null;
      throw e;
    }
  };

  r.get('/agent', (req, res) => send(res, agentStartView(ctx, { user: user(req) })));

  r.post('/agent', writeLimiter, sameOrigin, form, compute, async (req, res, next) => {
    try {
      const b = await bookingFor(req, req.body.ref);
      const booking = b && b.vertical === 'trips' ? { ref: b.ref, token: b.trip.token, dest: b.trip.dest.name, depart: b.trip.spec.depart, nights: b.trip.spec.nights, total: b.total, status: b.status } : null;
      const s = await agent.create({ visitor: req.visitor, userId: req.user ? req.user.id : null, booking });
      const text = said(req.body) || (req.body.mode === 'surprise' ? 'Surprise me: pick the best trip my money can buy.' : req.body.mode === 'challenge' ? 'I already found a trip. Can you beat it?' : '');
      if (booking && !text) await agent.say(s.id, `What do I need to do next for trip ${booking.ref}?`);
      else if (text) {
        await svc.track('agent_started', { visitor: req.visitor, userId: req.user && req.user.id, data: { length: text.length, booking: !!booking } });
        await agent.say(s.id, text);
      }
      res.redirect(303, `/agent/${s.id}`);
    } catch (e) { next(e); }
  });

  r.get('/agent/:id', async (req, res, next) => {
    try {
      const s = await owned(req, res);
      if (!s) return;
      send(res, agentView(ctx, { s, canvas: await canvasFor(s), user: user(req) }));
    } catch (e) { next(e); }
  });

  r.get('/agent/:id/live', async (req, res, next) => {
    try {
      const s = await owned(req, res);
      if (!s) return;
      send(res, agentLive(ctx, { s, canvas: await canvasFor(s) }));
    } catch (e) { next(e); }
  });

  r.post('/agent/:id', writeLimiter, sameOrigin, form, compute, async (req, res, next) => {
    try {
      const s = await owned(req, res);
      if (!s) return;
      const text = said(req.body);
      if (text) {
        await svc.track('agent_said', { visitor: req.visitor, userId: req.user && req.user.id, data: { length: text.length } });
        await agent.say(s.id, text);
      }
      res.redirect(303, `/agent/${s.id}`);
    } catch (e) { next(e); }
  });

  return r;
}

module.exports = { agentRouter };
