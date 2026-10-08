// Travel by Budget pages: planner, results, trip page, review, accounts, My Trips, info and SEO pages.
const express = require('express');
const { AppError } = require('../lib/errors');
const { addDays, today, isIsoDate, daysBetween } = require('../lib/dates');
const { str, localPath } = require('../lib/validate');
const optimizer = require('../trips/optimizer');
const { encodeSpec, decodeSpec } = require('../trips/spec');
const { publicTrip, requireTrip } = require('../trips/pricing');
const { WATCH_DEFAULT_RULE } = require('../trips/service');
const { homeView } = require('../views/trips/home');
const { stepView, resultsView, STEPS } = require('../views/trips/plan');
const { tripView, reviewView, unavailableView, singleChanges } = require('../views/trips/trip');
const { dreamView } = require('../views/trips/dream');
const challenge = require('../trips/challenge');
const { challengeFormView, challengeReviewView, challengeResultView } = require('../views/trips/challenge');
const { priceView } = require('../views/trips/price');
const { guideView } = require('../views/trips/guide');
const { compareView } = require('../views/trips/compare');
const { authView, myTripsView } = require('../views/trips/account');
const { leaksView } = require('../views/trips/leaks');
const { memoriesView } = require('../views/trips/memories');
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

function tripsRouter(ctx, { writeLimiter, computeLimiter }) {
  const compute = computeLimiter || ((req, res, next) => next());
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
  // A promo code the trip context carries (one a review page verified, then kept on every link so a
  // version opened from the leaks page lands on the total that page promised): its record while the
  // rules still accept it; otherwise null, the code dropped from the links, and the reason kept so
  // the page can say it rather than lose the code quietly.
  const promoOf = async cx => {
    if (!cx.promo) return { promo: null, promoError: null };
    try { return { promo: await svc.promo(cx.promo), promoError: null }; } catch (e) { if (!(e instanceof AppError) || e.code !== 'invalid_promo') throw e; cx.promo = null; return { promo: null, promoError: e.message }; }
  };
  const tracked = (req, type, data) => svc.track(type, { visitor: req.visitor, userId: req.user && req.user.id, data });

  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); });

  // ---- the AI travel agent's homepage ("/" is the corporate homepage, routes/pages.js) ----
  r.get('/ai-travel-agent', async (req, res, next) => {
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

  r.get('/trips', compute, async (req, res, next) => {
    try {
      const { query, missing } = svc.parse(req.query);
      if (missing.length) return res.redirect(303, `/plan?${new URLSearchParams(Object.entries(req.query).filter(([, v]) => typeof v === 'string' && v)).toString()}`);
      const result = await svc.search(query, { visitor: req.visitor, user: user(req) });
      const relax = result.picks.length ? null : await svc.oneRuleAway(query);
      send(res, resultsView(ctx, { result, relax, originCity: originCity(query.origin), user: user(req) }));
    } catch (e) { next(e); }
  });

  // ---- Journey B: dream destination + maximum budget ----
  r.get('/dream', async (req, res, next) => {
    try {
      const dest = svc.inv.maps.getDestination(String(req.query.dest || '').slice(0, 40));
      if (!dest) return res.redirect(303, '/ai-travel-agent#tb-dream-title');
      const raw = { who: 'couple', style: 'surprise', prio: 'hotel', k: '0', ...req.query };
      // "I have to be there": an optional fixed departure date from the homepage form.
      const t0 = today(svc.now());
      const fixed = isIsoDate(raw.depart) && raw.depart >= addDays(t0, 3) && daysBetween(t0, raw.depart) <= 330;
      if (!raw.when || (raw.when === 'exact' && !fixed)) raw.when = fixed ? 'exact' : 'anytime';
      if (!fixed) delete raw.depart;
      const beat = raw.beat === '1';
      const { query, missing } = svc.parse(raw);
      const ask = missing.find(m => ['budget', 'from', 'n'].includes(m));
      if (ask) return send(res, stepView(ctx, { step: ask, raw: req.query, query, origins: svc.inv.maps.listOrigins(), dream: dest }));
      await tracked(req, 'search_started', { budget: query.budget, dream: dest.id, origin: query.origin });
      const out = optimizer.dreamSearch(svc.inv, query, dest.id, { settings: await svc.settings(), now: svc.now() });
      // The context on this page's trip links carries only what the traveler said: the destination
      // they named (so a booking can say it was kept), the date they must leave on (held on every
      // page from here, never moved by a cut), and a length or a priority only when the query
      // stated one. The dream's own defaults (5 nights, "the hotel matters") rank the search but are
      // not written down as asks the traveler made.
      const stated = k => typeof req.query[k] === 'string' && req.query[k] !== '';
      const cx = { ...optimizer.budgetContext(query), searchParams: null, dest: dest.id, dateMode: query.dateMode === 'exact' ? 'exact' : null, nightsAsked: stated('nights') ? query.nights : undefined, priority: stated('prio') ? query.priority : 'price' };
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

  // ---- Trip Challenge: bring the trip you found; we build a comparable one and say who wins ----
  // Our hotels by destination, for "I love this hotel": a probe of the hotel supplier, names only.
  const ourHotels = destId => svc.inv.hotels.search({ destId, checkIn: addDays(today(svc.now()), 14), nights: 1, rooms: 1 }).map(h => ({ id: h.id, name: h.name, stars: h.stars }));
  const hotelGroups = () => svc.inv.maps.listDestinations().slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(d => ({ dest: d, hotels: ourHotels(d.id) })).filter(g => g.hotels.length);
  const challengeForm = (req, res, missing = []) => send(res, challengeFormView(ctx, {
    raw: req.query, missing, destinations: svc.inv.maps.listDestinations().slice().sort((a, b) => a.name.localeCompare(b.name)), origins: svc.inv.maps.listOrigins(), hotels: hotelGroups(),
  }));
  r.get('/challenge', (req, res, next) => {
    try { challengeForm(req, res); } catch (e) { next(e); }
  });
  r.get('/challenge/review', (req, res, next) => {
    try {
      const { challenger: ch, missing } = challenge.parseChallenger(req.query, { maps: svc.inv.maps, now: svc.now() });
      if (missing.length) return challengeForm(req, res, missing);
      const theirDest = svc.inv.maps.getDestination(ch.dest);
      const hotel = ch.hotel ? ourHotels(ch.dest).find(h => h.id === ch.hotel) : null;
      if (ch.hotel && !hotel) ch.hotel = null;
      send(res, challengeReviewView(ctx, { ch, unknowns: challenge.unknownsOf(ch), theirDest, originCity: originCity(ch.origin), hotelName: hotel ? hotel.name : null }));
    } catch (e) { next(e); }
  });
  r.get('/challenge/result', compute, async (req, res, next) => {
    try {
      const { challenger: ch, missing } = challenge.parseChallenger(req.query, { maps: svc.inv.maps, now: svc.now() });
      if (missing.length) return challengeForm(req, res, missing);
      let mode = challenge.MODES[req.query.mode] ? String(req.query.mode) : 'less';
      if (mode === 'surprise' && ch.locks.includes('dest')) mode = 'less';
      await tracked(req, 'search_started', { budget: ch.total, challenge: ch.dest, mode, origin: ch.origin });
      const out = challenge.runChallenge(svc.inv, ch, await svc.settings(), { mode, now: svc.now() });
      send(res, challengeResultView(ctx, { out, theirDest: svc.inv.maps.getDestination(ch.dest), originCity: originCity(ch.origin), user: user(req) }));
    } catch (e) { next(e); }
  });

  // ---- one trip ----
  r.get('/trip/:token', async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      if (req.query.review === '1') return res.redirect(303, `/trip/${req.params.token}/review?${optimizer.contextParams(cx, { seen: req.query.seen })}`);
      const data = await svc.trip(req.params.token, cx);
      // A protected experience this destination does not offer protects nothing: dropped from every link
      // out of the page, and said in words (service.dropUnoffered).
      const pxNote = svc.dropUnoffered(data.trip, cx);
      // A promo code carried from a review page: this page prices before the code (the customizer
      // compares versions before any code), says what the code takes off and the total with it, and
      // its review link names that total as the one seen, so the review page says "still", not "dropped".
      const { promo: p, promoError } = await promoOf(cx);
      const coded = p ? await svc.price(data.trip.spec, { promo: p }) : null;
      const promo = coded ? { code: p.code, total: coded.total, off: data.trip.total - coded.total } : null;
      await tracked(req, 'trip_selected', { dest: data.trip.dest.id, total: data.trip.total, budget: cx.budget });
      await svc.rememberTrip(user(req), data.token, cx.budget);
      let saved = null;
      if (req.user) {
        const [s, w] = await Promise.all([ctx.store.listRecords('saved', { userId: req.user.id, limit: 100 }), ctx.store.listRecords('watch', { userId: req.user.id, limit: 100 })]);
        saved = { saved: s.some(x => x.token === data.token), watch: w.some(x => x.token === data.token) };
      }
      // The main experience: MAIN EXPERIENCE 🔒 PROTECTED while the link protects one (px=), and a
      // protected experience this version lacks said with the way back, never dropped quietly.
      const main = svc.experienceMain(data.trip, cx, cx.goals || []);
      // Only one experience is the protected main experience, so "Protect this instead" replaces the one
      // protected before, and the page it opens says so: `pxwas` names the replaced one, once (it rides
      // on that one link only, never on the context). Read only when it names an experience offered here.
      const was = typeof req.query.pxwas === 'string' && main.protected ? data.trip.activityOptions.find(a => a.id === req.query.pxwas && a.id !== main.main.id) || null : null;
      const switched = was ? { from: was, to: main.main } : null;
      send(res, tripView(ctx, { data, cx, user: user(req), saved, named: ['high', 'low'].includes(req.query.named) ? req.query.named : null, promo, promoError, main, pxNote, switched }));
    } catch (e) { next(e); }
  });

  r.get('/trip/:token/change', (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const token = svc.customize(req.params.token, { hotel: req.query.hotel, flight: req.query.flight, nights: req.query.nights, depart: req.query.depart, bags: req.query.bags, transfer: req.query.transfer, activities: req.query.activities !== undefined ? [].concat(req.query.activities) : undefined });
      res.redirect(303, `/trip/${token}?${optimizer.contextParams(cx)}#customize`);
    } catch (e) { next(e); }
  });

  // Name your price: search this trip downward to the price the traveler named, and say where we'd stop.
  // The price is taken as typed, never clamped: a number under $100 or at or above the trip's total
  // sends the traveler back to the form with a note saying why.
  r.get('/trip/:token/price', compute, async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const typed = String(req.query.target ?? '').replace(/[,$\s]/g, '');
      const target = /^\d+(\.\d+)?$/.test(typed) ? Math.round(Number(typed)) : null;
      const back = named => `/trip/${req.params.token}?${optimizer.contextParams(cx, { named })}#price`;
      if (target === null || target < 100 || target > 1000000) return res.redirect(303, back('low'));
      const data = await svc.namePrice(req.params.token, cx, target * 100);
      if (data.tooHigh) return res.redirect(303, back('high'));
      const outcome = data.recommended ? 'reached' : data.anyway ? 'not-strong' : 'none';
      await tracked(req, 'price_named', { dest: data.current.trip.dest.id, current: data.currentTotal, target: target * 100, outcome });
      send(res, priceView(ctx, { data, cx, user: user(req) }));
    } catch (e) { next(e); }
  });

  // Your trip, step by step: a walk through this trip from its facts, for first trips and nervous flyers.
  r.get('/trip/:token/guide', async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const data = await svc.trip(req.params.token, cx);
      await tracked(req, 'guide_viewed', { dest: data.trip.dest.id });
      send(res, guideView(ctx, { data, cx }));
    } catch (e) { next(e); }
  });

  // Lock what you love and improve the rest / make it better for the same money: before and after.
  r.get('/trip/:token/optimize', compute, async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const lk = [].concat(req.query.lk || []).filter(x => typeof x === 'string').join('').slice(0, 8);
      // The page's own checkboxes (lk=h, f, d) and the locks the link carries from the agent (locked=hotel,flight): a
      // lock set with the agent holds here too, never dropped because a box was left unticked.
      const held = cx.locks || {};
      const locks = { hotel: lk.includes('h') || !!held.hotel, flight: lk.includes('f') || !!held.flight, dates: lk.includes('d') || !!held.dates };
      const capMode = req.query.cap === 'budget' && cx.budget ? 'budget' : 'same';
      const out = await svc.optimize(req.params.token, cx, { locks, capMode });
      await tracked(req, 'trip_optimized', { dest: out.current.trip.dest.id, improved: !!out.proposal, locks: lk, capMode });
      const items = [{ ...out.current, label: 'Your trip now' }, ...(out.proposal ? [{ ...out.proposal, label: out.proposal.tradeoffs.length ? 'Stronger version' : 'Improved version' }] : [])];
      send(res, compareView(ctx, { items, cx, mode: 'optimize', locks, capMode, cap: out.cap, all: req.query.all === '1' }));
    } catch (e) { next(e); }
  });

  // The Money Leak page: what you don't need to pay for. Every number is a version of this trip
  // priced in full by the engine; every control is a link to that version's token, so nothing is
  // removed here and nothing optional is chosen for the traveler. With a promo code on the context
  // (verified on the review page) every version is priced with it, and the code rides on every link
  // out, so a clicked REMOVE lands on the total this page promised. `cut` is the amount to take out
  // as typed, in dollars and cents, read as exactly that: a repeated key is its first value, never a
  // joined number; more than two decimals, a word, zero, or an amount at or above the total runs no
  // cut, and the page says which of those it was rather than cutting a different number quietly.
  r.get('/trip/:token/leaks', compute, async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const { promo, promoError } = await promoOf(cx);
      const data = await svc.trip(req.params.token, cx);
      if (promo) data.trip = requireTrip(await svc.price(data.trip.spec, { promo }));
      const first = [].concat(req.query.cut ?? [])[0];
      const cutTyped = typeof first === 'string' ? first.trim().slice(0, 40) : '';
      const digits = cutTyped.replace(/[,$\s]/g, '');
      const cents = /^\d{1,12}(\.\d{1,2})?$/.test(digits) ? Math.round(Number(digits) * 100) : null;
      const cutProblem = !cutTyped ? null : cents === null ? 'unreadable' : cents === 0 ? 'zero' : cents >= data.trip.total ? 'over' : null;
      const cut = cutProblem || cents === null ? null : cents;
      const hunt = await svc.moneyLeaks(data.trip, cx, { cut, promo });
      await tracked(req, 'leaks_viewed', { dest: data.trip.dest.id, total: data.trip.total, cut, leak: hunt.biggestLeak ? hunt.biggestLeak.kind : null });
      send(res, leaksView(ctx, { data, cx, hunt, cutTyped, cutProblem, cutCents: cents, promo: promo ? promo.code : null, promoError, user: user(req) }));
    } catch (e) { next(e); }
  });

  // MAKE IT MORE MEMORABLE (Experience Max): what this trip gives the goals the traveler ranked
  // (`mem=`), where its money goes, and every version that could make it more memorable, each priced
  // in full by the experience engine; every control is a link to that version's token with the
  // context carried (rules, mem, px, promo, dm, bg), so nothing is applied, added or removed here. The
  // totals are before any promo code, as on the trip page; the code rides on every link to the review,
  // and the review link names the total with the code as the one seen, so the review says "still", not
  // "dropped": the code was applied, the price did not move.
  // `amt` is MAKE $X MEMORABLE's amount in whole dollars as typed (its first value): anything that is
  // not a whole number from $10 to $10,000 runs the $100 default, and the page says so.
  r.get('/trip/:token/memories', compute, async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const { promo: p, promoError } = await promoOf(cx);
      const data = await svc.trip(req.params.token, cx);
      const pxNote = svc.dropUnoffered(data.trip, cx);
      // The event the link carries (ev=) is read only when it could belong to this trip; one that cannot is dropped from
      // every link out of the page and said in words (service.dropFarEvent).
      const evNote = svc.dropFarEvent(data.trip, cx);
      const coded = p ? await svc.price(data.trip.spec, { promo: p }) : null;
      const promo = coded ? { code: p.code, total: coded.total, off: data.trip.total - coded.total } : null;
      const first = [].concat(req.query.amt ?? [])[0];
      const typed = typeof first === 'string' ? first.trim().replace(/[$,\s]/g, '').slice(0, 12) : '';
      const whole = /^\d{2,5}$/.test(typed) && Number(typed) >= 10 && Number(typed) <= 10000 ? Number(typed) : null;
      const amountNote = typed && whole === null ? `I couldn't read "${typed}" as a whole-dollar amount from $10 to $10,000, so this shows $100.` : null;
      const mem = await svc.memories(data.trip, cx, { amount: (whole || 100) * 100 });
      await tracked(req, 'memories_viewed', { dest: data.trip.dest.id, total: data.trip.total, goals: mem.goals, protect: cx.protect || null });
      send(res, memoriesView(ctx, { data, cx, mem, promo, promoError, amountNote, pxNote, evNote, user: user(req) }));
    } catch (e) { next(e); }
  });

  // Side by side: two or three trips by token (the results page links all three).
  r.get('/compare', async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const rawTokens = [].concat(req.query.t || []), rawLabels = [].concat(req.query.l || []);
      const wanted = new Map();
      rawTokens.forEach((tok, i) => { if (typeof tok === 'string' && tok.length <= 300 && !wanted.has(tok) && wanted.size < 3) wanted.set(tok, typeof rawLabels[i] === 'string' ? rawLabels[i].slice(0, 30) : ''); });
      const tokens = [...wanted.keys()];
      if (tokens.length < 2) return res.redirect(303, cx.searchParams ? `/trips?${cx.searchParams}` : '/plan');
      const items = [];
      for (const tok of tokens) {
        try { items.push({ ...(await svc.trip(tok, cx)), label: wanted.get(tok) || null }); } catch (e) { if (!(e instanceof AppError)) throw e; }
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
      try { verify = await svc.verify(req.params.token, seen, { promoCode: cx.promo }); } catch (e) { if (e.code !== 'invalid_promo') throw e; verify = await svc.verify(req.params.token, seen); verify.promoError = e.message; }
      if (!verify.available) return send(res.status(410), unavailableView(ctx, { token: req.params.token, cx }));
      // A protected experience this destination does not offer protects nothing here (and never reaches
      // the quote): dropped from the context, and said on the page.
      const pxNote = svc.dropUnoffered(verify.trip, cx);
      // An event on the link that cannot belong to this trip is dropped and said, as on the Memories page.
      const evNote = svc.dropFarEvent(verify.trip, cx);
      // The verified code rides on every link out of this page (the money leak check's REMOVE, the
      // leaks page, the trip page), so a version opened from here is priced with it; a code the rules
      // refuse is said on the page and carried nowhere.
      cx.promo = verify.promo ? verify.promo.code : null;
      // The page shows the verified price (promo included), which is exactly what the quote will check.
      const data = { ...(await svc.trip(req.params.token, cx)), trip: publicTrip(verify.trip) };
      // The savings check and the money leak check run on the verified trip with its promo, so every
      // version they price moves with the same code.
      const leak = await svc.leakCheck(verify.trip, cx, { promo: verify.promo });
      // Experience Max's additions (the experience receipt, the protection rows, the final experience
      // check, the "very scheduled" line), only when the link carries goals or a protected experience.
      const experience = await svc.experienceReview(verify.trip, cx, { promo: verify.promo });
      send(res, reviewView(ctx, { data, cx, verify, user: user(req), promoError: verify.promoError, promoCode: verify.promo ? verify.promo.code : '', leak, experience, pxNote, evNote }));
    } catch (e) { next(e); }
  });

  r.post('/trip/:token/quote', writeLimiter, sameOrigin, form, async (req, res, next) => {
    const cx = optimizer.parseContext(Object.fromEntries(new URLSearchParams(String(req.body.cx || ''))));
    try {
      const quote = await svc.createQuote(req.params.token, { approvedTotal: Number(req.body.approvedTotal), budget: cx.budget, keep: cx.keep, allowOver: cx.allowOver, promoCode: req.body.promo, user: user(req), cx });
      await tracked(req, 'checkout_started', { dest: quote.trip.dest.id, total: quote.total });
      res.redirect(303, `/checkout/${quote.id}`);
    } catch (e) {
      // Back to the review with the code as typed in the form (a cleared field clears it), so a
      // changed price is read against the same code, never against the code dropped.
      if (e instanceof AppError && (e.code === 'price_changed' || e.code === 'invalid_promo')) {
        return res.redirect(303, `/trip/${req.params.token}/review?${optimizer.contextParams(cx, { seen: req.body.approvedTotal, promo: typeof req.body.promo === 'string' && req.body.promo.trim() ? req.body.promo.trim().slice(0, 30) : undefined })}`);
      }
      if (e instanceof AppError && e.code === 'trip_unavailable') return send(res.status(410), unavailableView(ctx, { token: req.params.token, cx }));
      next(e);
    }
  });

  // Save a trip, or watch its price under a rule: `rule` is 'drop', 'any-drop' or 'under' and `amount`
  // is dollars as typed, turned into cents here. A drop with the amount left blank is the $100 default
  // the form names; no rule at all means the same default; anything else unreadable (a repeated
  // field included) is a 422, never the default.
  r.post('/trip/:token/save', writeLimiter, sameOrigin, form, requireUser, async (req, res, next) => {
    try {
      const cx = optimizer.parseContext(req.query);
      const kind = req.body.kind === 'watch' ? 'watch' : 'saved';
      let rule;
      if (kind === 'watch' && req.body.rule !== undefined) {
        const raw = req.body.amount;
        const typed = raw === undefined ? '' : typeof raw === 'string' ? raw.replace(/[,$\s]/g, '') : null;
        const cents = typed !== null && /^\d+(\.\d{1,2})?$/.test(typed) ? Math.round(Number(typed) * 100) : NaN;
        rule = { kind: String(req.body.rule), amount: req.body.rule === 'drop' && typed === '' ? WATCH_DEFAULT_RULE.amount : cents };
      }
      await svc.saveTrip(req.user, req.params.token, { kind, budget: cx.budget, rule });
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
  // Where to go after signing in or up: a same-site path only (lib/validate localPath, D10), else My Trips.
  const safeNext = n => localPath(n, '/my-trips');
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
    try { await accounts.endSession(req, res); res.redirect(303, '/ai-travel-agent'); } catch (e) { next(e); }
  });

  r.get('/my-trips', requireUser, async (req, res, next) => {
    try {
      const t = today(svc.now());
      const bookings = (await ctx.store.listBookings({ userId: req.user.id, limit: 200 })).filter(b => b.vertical === 'trips' && b.status !== 'expired');
      const pub = bookings.map(b => ctx.engine.publicBooking(b));
      // Hunts are listed from their stored facts (no search runs here); the list is empty without the hunter.
      const [saved, watches, recent, lastSearch, hunts] = await Promise.all([svc.listSaved(req.user, 'saved'), svc.listSaved(req.user, 'watch'), svc.recentTrip(req.user), ctx.store.getRecord('last_search', req.user.id), ctx.hunts ? ctx.hunts.list(req.user) : []]);
      send(res, myTripsView(ctx, {
        user: req.user, upcoming: pub.filter(b => b.startDate >= t), past: pub.filter(b => b.startDate < t), saved, watches, recent, lastSearch, hunts,
        destName: id => { const d = svc.inv.maps.getDestination(id); return d ? d.name : id; },
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

  // WHAT WAS ACTUALLY WORTH IT? after the trip (cookie or signed-in owner, as for messages). The
  // chips as ticked, never preselected: `worth` and `not` are lists of WORTH_IT_CHIPS, `other` the
  // traveler's own words. It is kept on the booking; on the account's defaults only when the box was
  // ticked and the one asking is the signed-in owner (service.setWorthIt decides and says which).
  r.post('/booking/:ref/worth-it', writeLimiter, sameOrigin, form, async (req, res, next) => {
    try {
      const { readCookies, bookingCookieName } = require('../lib/cookies');
      const b = await ctx.engine.authorize(req.params.ref, { token: readCookies(req)[bookingCookieName(req.params.ref)] }).catch(async e => {
        if (req.user) { const own = (await ctx.store.listBookings({ userId: req.user.id, limit: 200 })).find(x => x.ref === String(req.params.ref).toUpperCase()); if (own) return own; }
        throw e;
      });
      const list = v => [].concat(v ?? []).filter(x => typeof x === 'string').slice(0, 10);
      try {
        await svc.setWorthIt(b.ref, { worth: list(req.body.worth), notWorth: list(req.body.not), other: typeof req.body.other === 'string' ? req.body.other : '' }, { remember: req.body.remember === '1', userId: req.user ? req.user.id : null });
      } catch (e) {
        if (e instanceof AppError && (e.code === 'invalid_worth_it' || e.code === 'worth_it_closed')) return res.redirect(303, `/booking/${b.ref}?worthError=${encodeURIComponent((e.details && e.details.reason) || 'empty')}#worth-it`);
        throw e;
      }
      res.redirect(303, `/booking/${b.ref}?worth=1#worth-it`);
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

  // Tripelyx Business adds its lines only when it is enabled: crawlers stay out of the workspace (/business/...)
  // and the sitemap lists its company page.
  const bizOn = !!(config.business && config.business.enabled);
  r.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /trip/\nDisallow: /trips\nDisallow: /compare\nDisallow: /plan\nDisallow: /checkout/\nDisallow: /booking/\nDisallow: /admin\nDisallow: /my-trips\n${bizOn ? 'Disallow: /business/\n' : ''}${config.publicBaseUrl ? `Sitemap: ${config.publicBaseUrl}/sitemap.xml\n` : ''}`));
  r.get('/sitemap.xml', (req, res) => {
    const base = config.publicBaseUrl || '';
    const urls = ['/', '/ai-travel-agent', '/how-it-works', '/faq', '/destinations', '/beach-vacations', '/about', '/contact', ...(bizOn ? ['/business'] : []), ...[500, 1000, 1500, 2000, 3000, 5000].map(n => `/trips-under-${n}`), ...svc.inv.maps.listDestinations().map(d => `/trips-to-${slug(d.name)}`)];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${base}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
  });

  return r;
}

module.exports = { tripsRouter, sameOrigin, requireUser };
