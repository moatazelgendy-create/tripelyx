// Travel by Budget pages: planner, results, trip page, review, accounts, My Trips, info and SEO pages.
const express = require('express');
const { AppError } = require('../lib/errors');
const { addDays, today, isIsoDate, daysBetween } = require('../lib/dates');
const { str } = require('../lib/validate');
const optimizer = require('../trips/optimizer');
const { encodeSpec, decodeSpec } = require('../trips/spec');
const { publicTrip } = require('../trips/pricing');
const { homeView } = require('../views/trips/home');
const { stepView, resultsView, STEPS } = require('../views/trips/plan');
const { tripView, reviewView, unavailableView, singleChanges } = require('../views/trips/trip');
const { dreamView } = require('../views/trips/dream');
const { compareView } = require('../views/trips/compare');
const { authView, myTripsView } = require('../views/trips/account');
const pages = require('../views/trips/pages');
const { notFoundView } = require('../views/errors');

const send = (res, view) => res.type('html').send(String(view));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const SAMPLE_ORIGIN = 'NYC';

// Browsers send Sec-Fetch-Site on form posts; a cross-site post to a state-changing page is refused.
function sameOrigin(req, res, next) {
  const site = req.get('sec-fetch-site');
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return next(new AppError('forbidden', 'This request was blocked.', 403));
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  res.redirect(303, `/signin?next=${encodeURIComponent(req.originalUrl)}`);
}

function tripsRouter(ctx, { writeLimiter }) {
  const { tripService: svc, accounts, config } = ctx;
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '32kb' });
  const cache = new Map();
  const cached = async (key, ttlMs, fn) => {
    const hit = cache.get(key);
    if (hit && hit.at > Date.now() - ttlMs) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  const originCity = id => { const o = svc.inv.maps.getOrigin(id); return o ? o.city : id; };
  const user = req => req.user || null;
  const tracked = (req, type, data) => svc.track(type, { visitor: req.visitor, userId: req.user && req.user.id, data });

  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); });

  // ---- homepage ----
  r.get('/', async (req, res, next) => {
    try {
      await tracked(req, 'home_visit');
      const example = await cached('home:example', 600000, async () => {
        const result = await svc.sample({ b: '1500', k: '0', from: 'SFO', who: 'couple', when: 'anytime', nights: '5', style: 'beach', prio: 'hotel' });
        return { ...result, originCity: originCity('SFO'), params: optimizer.searchParams(result.query) };
      });
      const levels = await cached('home:levels', 600000, async () => {
        const out = [];
        for (const b of [500, 1000, 1500, 2000, 3000, 5000]) {
          const result = await svc.sample({ b: String(b), k: '0', from: SAMPLE_ORIGIN, who: 'couple', when: 'anytime', nights: b <= 500 ? '2' : b <= 1000 ? '3' : '5', style: 'surprise', prio: 'price' });
          const byDest = new Map();
          for (const p of [...result.picks, ...result.closest]) if (p.trip.total <= b * 100 && !byDest.has(p.trip.dest.id)) byDest.set(p.trip.dest.id, p.trip);
          out.push({ budget: b, originCity: originCity(SAMPLE_ORIGIN), destinations: result.eligibleDestinations, cheapest: result.cheapest, examples: [...byDest.values()].slice(0, 3).map(t => ({ name: t.dest.name, slug: slug(t.dest.name), total: t.total })) });
        }
        return out;
      });
      const dreamDestinations = svc.inv.maps.listDestinations().sort((a, b) => a.name.localeCompare(b.name));
      send(res, homeView(ctx, { example, levels, dreamDestinations, origins: svc.inv.maps.listOrigins(), user: user(req), recent: await svc.recentTrip(user(req)) }));
    } catch (e) { next(e); }
  });

  // ---- planner: one question at a time ----
  r.get('/plan', async (req, res, next) => {
    try {
      const { query, missing } = svc.parse(req.query);
      if (req.query.b && missing[0] === 'keep') await tracked(req, 'budget_entered', { budget: query.budgetInput });
      if (!missing.length) return res.redirect(303, `/trips?${optimizer.searchParams(query)}`);
      send(res, stepView(ctx, { step: missing[0], raw: req.query, query, origins: svc.inv.maps.listOrigins() }));
    } catch (e) { next(e); }
  });

  r.get('/trips', async (req, res, next) => {
    try {
      const { query, missing } = svc.parse(req.query);
      if (missing.length) return res.redirect(303, `/plan?${new URLSearchParams(Object.entries(req.query).filter(([, v]) => typeof v === 'string' && v)).toString()}`);
      const result = await svc.search(query, { visitor: req.visitor, user: user(req) });
      send(res, resultsView(ctx, { result, originCity: originCity(query.origin), user: user(req) }));
    } catch (e) { next(e); }
  });

  // ---- Journey B: dream destination + maximum budget ----
  r.get('/dream', async (req, res, next) => {
    try {
      const dest = svc.inv.maps.getDestination(String(req.query.dest || '').slice(0, 40));
      if (!dest) return res.redirect(303, '/#tb-dream-title');
      const raw = { who: 'couple', style: 'surprise', prio: 'hotel', k: '0', ...req.query };
      // "I have to be there": an optional fixed departure date from the homepage form.
      const t0 = today();
      const fixed = isIsoDate(raw.depart) && raw.depart >= addDays(t0, 3) && daysBetween(t0, raw.depart) <= 330;
      if (!raw.when || (raw.when === 'exact' && !fixed)) raw.when = fixed ? 'exact' : 'anytime';
      if (!fixed) delete raw.depart;
      const beat = raw.beat === '1';
      const { query, missing } = svc.parse(raw);
      const ask = missing.find(m => ['budget', 'from', 'n'].includes(m));
      if (ask) return send(res, stepView(ctx, { step: ask, raw: req.query, query, origins: svc.inv.maps.listOrigins(), dream: dest }));
      await tracked(req, 'search_started', { budget: query.budget, dream: dest.id, origin: query.origin });
      const out = optimizer.dreamSearch(svc.inv, query, dest.id, { settings: await svc.settings(), now: new Date() });
      const cx = { ...optimizer.budgetContext(query), searchParams: null };
      let closers = [];
      if (out.best && out.gap > 0) {
        const token = encodeSpec(out.best.trip.spec);
        const options = optimizer.customizerOptions(svc.inv, out.best.trip, await svc.settings());
        closers = singleChanges(out.best.trip, options, token, cx).filter(c => c.delta < 0).sort((a, b) => (b.total <= query.budget) - (a.total <= query.budget) || a.delta - b.delta).slice(0, 8)
          .map(c => ({ ...c, label: c.total <= query.budget ? `${c.label} — fits your budget` : c.label }));
      }
      send(res, dreamView(ctx, { dest, q: query, originCity: originCity(query.origin), best: out.best, under: out.under, gap: out.gap, closers, cx, user: user(req), beat }));
    } catch (e) { next(e); }
  });

  // ---- one trip ----
  r.get('/trip/:token', async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      if (req.query.review === '1') return res.redirect(303, `/trip/${req.params.token}/review?${optimizer.contextParams(cx, { seen: req.query.seen })}`);
      const data = await svc.trip(req.params.token, cx);
      await tracked(req, 'trip_selected', { dest: data.trip.dest.id, total: data.trip.total, budget: cx.budget });
      await svc.rememberTrip(user(req), data.token, cx.budget);
      let saved = null;
      if (req.user) {
        const [s, w] = await Promise.all([ctx.store.listRecords('saved', { userId: req.user.id, limit: 100 }), ctx.store.listRecords('watch', { userId: req.user.id, limit: 100 })]);
        saved = { saved: s.some(x => x.token === data.token), watch: w.some(x => x.token === data.token) };
      }
      send(res, tripView(ctx, { data, cx, user: user(req), saved }));
    } catch (e) { next(e); }
  });

  r.get('/trip/:token/change', (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const token = svc.customize(req.params.token, { hotel: req.query.hotel, flight: req.query.flight, nights: req.query.nights, depart: req.query.depart, bags: req.query.bags, transfer: req.query.transfer, activities: req.query.activities !== undefined ? [].concat(req.query.activities) : undefined });
      res.redirect(303, `/trip/${token}?${optimizer.contextParams(cx)}#customize`);
    } catch (e) { next(e); }
  });

  // Lock what you love and improve the rest / make it better for the same money: before and after.
  r.get('/trip/:token/optimize', async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const lk = [].concat(req.query.lk || []).filter(x => typeof x === 'string').join('');
      const locks = { hotel: lk.includes('h'), flight: lk.includes('f'), dates: lk.includes('d') };
      const capMode = req.query.cap === 'budget' && cx.budget ? 'budget' : 'same';
      const out = await svc.optimize(req.params.token, cx, { locks, capMode });
      await tracked(req, 'trip_optimized', { dest: out.current.trip.dest.id, improved: !!out.proposal, locks: lk, capMode });
      const items = [{ ...out.current, label: 'Your trip now' }, ...(out.proposal ? [{ ...out.proposal, label: 'Improved version' }] : [])];
      send(res, compareView(ctx, { items, cx, mode: 'optimize', locks, capMode, cap: out.cap, all: req.query.all === '1' }));
    } catch (e) { next(e); }
  });

  // Side by side: two or three trips by token (the results page links all three).
  r.get('/compare', async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const tokens = [...new Set([].concat(req.query.t || []).filter(x => typeof x === 'string' && x.length <= 300))].slice(0, 3);
      const labels = [].concat(req.query.l || []).map(l => (typeof l === 'string' ? l.slice(0, 30) : ''));
      if (tokens.length < 2) return res.redirect(303, cx.searchParams ? `/trips?${cx.searchParams}` : '/plan');
      const items = [];
      for (const [i, tok] of tokens.entries()) {
        try { items.push({ ...(await svc.trip(tok, cx)), label: labels[i] || null }); } catch (e) { if (!(e instanceof AppError)) throw e; }
      }
      if (items.length < 2) return send(res.status(410), unavailableView(ctx, { token: tokens[0], cx }));
      send(res, compareView(ctx, { items, cx, mode: 'compare', all: req.query.all === '1' }));
    } catch (e) { next(e); }
  });

  r.get('/trip/:token/review', async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const seen = Number(req.query.seen) || 0;
      let verify;
      try { verify = await svc.verify(req.params.token, seen, { promoCode: req.query.promo }); } catch (e) { if (e.code !== 'invalid_promo') throw e; verify = await svc.verify(req.params.token, seen); verify.promoError = e.message; }
      if (!verify.available) return send(res.status(410), unavailableView(ctx, { token: req.params.token, cx }));
      // The page shows the verified price (promo included), which is exactly what the quote will check.
      const data = { ...(await svc.trip(req.params.token, cx)), trip: publicTrip(verify.trip) };
      send(res, reviewView(ctx, { data, cx, verify, user: user(req), promoError: verify.promoError, promoCode: verify.promo ? verify.promo.code : '' }));
    } catch (e) { next(e); }
  });

  r.post('/trip/:token/quote', writeLimiter, sameOrigin, form, async (req, res, next) => {
    const cx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(String(req.body.cx || ''))));
    try {
      const quote = await svc.createQuote(req.params.token, { approvedTotal: Number(req.body.approvedTotal), budget: cx.budget, allowOver: cx.allowOver, promoCode: req.body.promo, user: user(req) });
      await tracked(req, 'checkout_started', { dest: quote.trip.dest.id, total: quote.total });
      res.redirect(303, `/checkout/${quote.id}`);
    } catch (e) {
      if (e instanceof AppError && (e.code === 'price_changed' || e.code === 'invalid_promo')) {
        return res.redirect(303, `/trip/${req.params.token}/review?${optimizer.contextParams(cx, { seen: req.body.approvedTotal, promo: e.code === 'invalid_promo' ? req.body.promo : undefined })}`);
      }
      if (e instanceof AppError && e.code === 'trip_unavailable') return send(res.status(410), unavailableView(ctx, { token: req.params.token, cx }));
      next(e);
    }
  });

  r.post('/trip/:token/save', writeLimiter, sameOrigin, form, requireUser, async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const kind = req.body.kind === 'watch' ? 'watch' : 'saved';
      await svc.saveTrip(req.user, req.params.token, { kind, budget: cx.budget });
      res.redirect(303, req.query.back === 'dream' ? '/my-trips?saved=1' : `/trip/${req.params.token}?${optimizer.contextParams(cx)}`);
    } catch (e) { next(e); }
  });

  r.get('/api/trips/:token/price', async (req, res, next) => {
    try {
      const t = await svc.price(decodeSpec(req.params.token));
      if (!t) throw new AppError('trip_unavailable', 'Part of this trip is no longer available.', 410);
      res.setHeader('Cache-Control', 'no-store');
      const p = publicTrip(t);
      res.json({ token: encodeSpec(t.spec), total: p.total, perTraveler: p.perTraveler, perNight: p.perNight, lines: p.lines, demo: p.demo });
    } catch (e) { next(e); }
  });

  // ---- accounts ----
  r.get('/signin', (req, res) => send(res, authView(ctx, { mode: 'signin', next: str(req.query.next, 300) })));
  r.get('/signup', (req, res) => send(res, authView(ctx, { mode: 'signup', next: str(req.query.next, 300) })));
  const safeNext = n => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n.slice(0, 300) : '/my-trips');
  r.post('/signin', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const u = await accounts.authenticate(req.body);
      await accounts.createSession(res, u);
      res.redirect(303, safeNext(req.body.next));
    } catch (e) {
      if (!(e instanceof AppError)) return next(e);
      send(res.status(e.status), authView(ctx, { mode: 'signin', error: e.message, values: { email: req.body.email }, next: safeNext(req.body.next) }));
    }
  });
  r.post('/signup', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const u = await accounts.register(req.body);
      await accounts.createSession(res, u);
      res.redirect(303, safeNext(req.body.next));
    } catch (e) {
      if (!(e instanceof AppError)) return next(e);
      send(res.status(e.status), authView(ctx, { mode: 'signup', error: e.message, errors: e.details || {}, values: { name: req.body.name, email: req.body.email }, next: safeNext(req.body.next) }));
    }
  });
  r.post('/signout', sameOrigin, form, async (req, res, next) => {
    try { await accounts.endSession(req, res); res.redirect(303, '/'); } catch (e) { next(e); }
  });

  r.get('/my-trips', requireUser, async (req, res, next) => {
    try {
      const t = today();
      const bookings = (await ctx.store.listBookings({ userId: req.user.id, limit: 200 })).filter(b => b.vertical === 'trips' && b.status !== 'expired');
      const pub = bookings.map(b => ctx.engine.publicBooking(b));
      const [saved, watches, recent, lastSearch] = await Promise.all([svc.listSaved(req.user, 'saved'), svc.listSaved(req.user, 'watch'), svc.recentTrip(req.user), ctx.store.getRecord('last_search', req.user.id)]);
      send(res, myTripsView(ctx, {
        user: req.user, upcoming: pub.filter(b => b.startDate >= t), past: pub.filter(b => b.startDate < t), saved, watches, recent, lastSearch,
        notice: req.query.saved ? 'Saved. We’ll show price changes here.' : null,
      }));
    } catch (e) { next(e); }
  });
  r.post('/my-trips/remove', sameOrigin, form, requireUser, async (req, res, next) => {
    try { await svc.removeSaved(req.user, req.body.kind === 'watch' ? 'watch' : 'saved', String(req.body.id || '')); res.redirect(303, '/my-trips'); } catch (e) { next(e); }
  });

  // ---- support messages on a booking (cookie or signed-in owner) ----
  r.post('/booking/:ref/message', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const { readCookies, bookingCookieName } = require('../lib/cookies');
      const b = await ctx.engine.authorize(req.params.ref, { token: readCookies(req)[bookingCookieName(req.params.ref)] }).catch(async e => {
        if (req.user) { const own = (await ctx.store.listBookings({ userId: req.user.id, limit: 200 })).find(x => x.ref === String(req.params.ref).toUpperCase()); if (own) return own; }
        throw e;
      });
      await svc.addSupportMessage(b.ref, { from: 'customer', text: req.body.text, name: `${b.traveler.firstName} ${b.traveler.lastName}` });
      res.redirect(303, `/booking/${b.ref}?sent=1`);
    } catch (e) { next(e); }
  });

  // ---- info pages ----
  r.get('/how-it-works', (req, res) => send(res, pages.howItWorksView(ctx)));
  r.get('/faq', (req, res) => send(res, pages.faqView(ctx)));
  r.get('/legal/:key', (req, res) => {
    if (!pages.LEGAL[req.params.key]) return send(res.status(404), notFoundView(ctx));
    send(res, pages.legalView(ctx, req.params.key));
  });
  r.get('/custom-trip', (req, res) => send(res, pages.customTripView(ctx, { values: { budget: str(req.query.budget, 20), from: str(req.query.from, 80), travelers: str(req.query.travelers, 10), dest: str(req.query.dest, 60), name: req.user ? req.user.name : '', email: req.user ? req.user.email : '' }, user: user(req) })));
  r.post('/custom-trip', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try { await svc.createRequest(req.body, user(req)); send(res, pages.customTripView(ctx, { done: true, user: user(req) })); } catch (e) {
      if (!(e instanceof AppError)) return next(e);
      send(res.status(e.status), pages.customTripView(ctx, { values: req.body, errors: e.details || {}, user: user(req) }));
    }
  });

  // ---- SEO landing pages ----
  const landing = async (req, res, next, { title, eyebrow, lead, intro, canonical, budget, raw, moreLinks }) => {
    try {
      const from = svc.inv.maps.getOrigin(String(req.query.from || '').toUpperCase()) ? String(req.query.from).toUpperCase() : SAMPLE_ORIGIN;
      const key = `landing:${canonical}:${from}`;
      const result = await cached(key, 600000, () => svc.sample({ b: String(budget), k: '0', from, who: 'couple', when: 'anytime', nights: '5', style: 'surprise', prio: 'price', ...raw }));
      send(res, pages.landingView(ctx, { title, eyebrow, lead, intro, result, q: result.query, originCity: originCity(from), canonical, budgetValue: String(budget), origins: svc.inv.maps.listOrigins(), moreLinks }));
    } catch (e) { next(e); }
  };
  r.get('/destinations', async (req, res, next) => {
    try {
      const list = await cached('destinations', 600000, async () => {
        const result = await svc.sample({ b: '20000', k: '0', from: SAMPLE_ORIGIN, who: 'couple', when: 'anytime', nights: '5', style: 'surprise', prio: 'price' });
        return svc.inv.maps.listDestinations().map(d => ({ ...d, slug: slug(d.name), from: result.cheapestByDest[d.id] || null })).sort((a, b) => (a.from || 1e12) - (b.from || 1e12));
      });
      send(res, pages.destinationsView(ctx, { destinations: list }));
    } catch (e) { next(e); }
  });
  r.get('/trips-to-:slug', (req, res, next) => {
    const d = svc.inv.maps.listDestinations().find(x => slug(x.name) === req.params.slug);
    if (!d) return send(res.status(404), notFoundView(ctx));
    landing(req, res, next, { title: `Trips to ${d.name}`, eyebrow: `${d.name}, ${d.country}`, lead: `${d.blurb} Tell us your budget and we’ll build the complete trip: flights, hotel and experiences, with every tax and fee in the price.`, intro: `Complete ${d.name} trips priced in full.`, canonical: `/trips-to-${req.params.slug}`, budget: 3000, raw: { dest: d.id, b: '3000' }, moreLinks: [[`/dream?dest=${d.id}&b=1500&from=${SAMPLE_ORIGIN}`, `${d.name} for $1,500?`, 'See how close we can get'], ['/destinations', 'All destinations', 'Where else your budget can go']] });
  });
  r.get('/beach-vacations', (req, res, next) => landing(req, res, next, { title: 'Beach vacations by budget', eyebrow: 'Beach', lead: 'Tell us what you want to spend and we’ll find the beach trip that fits: flights, a hotel on or near the sand, and the extras, priced in full.', intro: 'The three best beach trips for $1,500.', canonical: '/beach-vacations', budget: 1500, raw: { style: 'beach' }, moreLinks: [['/trips-under-1000', 'Trips under $1,000', ''], ['/trips-under-2000', 'Trips under $2,000', '']] }));
  r.get('/trips-under-:n', (req, res, next) => {
    const n = Number(req.params.n);
    if (![500, 1000, 1500, 2000, 3000, 5000].includes(n)) return send(res.status(404), notFoundView(ctx));
    const raw = { b: String(n), nights: n <= 500 ? '2' : n <= 1000 ? '3' : '5' };
    if (['beach', 'city', 'adventure', 'romantic', 'family', 'all-inclusive'].includes(req.query.style)) raw.style = req.query.style;
    if (req.query.nights && /^\d{1,2}$/.test(req.query.nights)) raw.nights = req.query.nights;
    if (req.query.region === 'international') raw.region = 'international';
    landing(req, res, next, { title: `Trips under $${n.toLocaleString('en-US')}`, eyebrow: 'Budget inspiration', lead: `Complete trips (flights, hotel and more) for under $${n.toLocaleString('en-US')}, taxes and fees included. Change the budget to see what else is possible.`, intro: `What $${n.toLocaleString('en-US')} really buys${raw.style ? ` for a ${raw.style} trip` : ''}.`, canonical: `/trips-under-${n}`, budget: n, raw, moreLinks: [500, 1000, 1500, 2000, 3000, 5000].filter(x => x !== n).slice(0, 3).map(x => [`/trips-under-${x}`, `Trips under $${x.toLocaleString('en-US')}`, '']) });
  });

  r.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /trip/\nDisallow: /trips\nDisallow: /compare\nDisallow: /plan\nDisallow: /checkout/\nDisallow: /booking/\nDisallow: /admin\nDisallow: /my-trips\n${config.publicBaseUrl ? `Sitemap: ${config.publicBaseUrl}/sitemap.xml\n` : ''}`));
  r.get('/sitemap.xml', (req, res) => {
    const base = config.publicBaseUrl || '';
    const urls = ['/', '/how-it-works', '/faq', '/destinations', '/beach-vacations', '/about', '/contact', ...[500, 1000, 1500, 2000, 3000, 5000].map(n => `/trips-under-${n}`), ...svc.inv.maps.listDestinations().map(d => `/trips-to-${slug(d.name)}`)];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${base}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
  });

  return r;
}

module.exports = { tripsRouter, sameOrigin, requireUser };
