// TripService ties the trip planner together: search, trip pages, customizing, the live price check,
// quotes for checkout, the booking provider the booking engine calls, saved trips and price watches,
// support messages, custom trip requests, analytics events and the admin control center's numbers.
const { AppError } = require('../lib/errors');
const { id } = require('../lib/ids');
const { addDays, today, hoursUntil, daysBetween } = require('../lib/dates');
const { str, EMAIL } = require('../lib/validate');
const { format: fmtMoney } = require('../lib/money');
const { encodeSpec, decodeSpec } = require('./spec');
const { priceTrip, publicTrip, requireTrip, DEFAULT_SETTINGS } = require('./pricing');
const optimizer = require('./optimizer');
const decision = require('./decision');

const FUNNEL = ['home_visit', 'budget_entered', 'search_started', 'results_viewed', 'trip_selected', 'checkout_started', 'payment_attempted', 'booking_confirmed'];
const FUNNEL_LABELS = {
  home_visit: 'Homepage visit', budget_entered: 'Budget entered', search_started: 'Search started', results_viewed: 'Results viewed',
  trip_selected: 'Trip selected', checkout_started: 'Checkout started', payment_attempted: 'Payment attempted', booking_confirmed: 'Booking confirmed',
};
const money = c => fmtMoney(c, 'USD');

class TripService {
  constructor({ inventory, store, notifier, config, now = () => new Date(), log = console }) {
    this.inv = inventory;
    this.store = store;
    this.notifier = notifier;
    this.config = config;
    this.now = now;
    this.log = log;
    this.settingsCache = null;
  }

  get demo() { return this.inv.demo; }

  // ---- settings (admin-editable business rules) ----
  async settings() {
    if (this.settingsCache && this.settingsCache.at > Date.now() - 15000) return this.settingsCache.value;
    const saved = await this.store.getRecord('settings', 'pricing');
    const value = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  async saveSettings(input) {
    const cur = await this.settings();
    const dollars = (v, max) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new AppError('invalid_settings', 'Check the values.', 422); return Math.round(n * 100); };
    const pct = (v, max) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new AppError('invalid_settings', 'Check the values.', 422); return Math.round(n * 10) / 10; };
    const next = {
      ...cur,
      serviceFeePerTraveler: dollars(input.serviceFeePerTraveler, 500),
      maxServiceFee: dollars(input.maxServiceFee, 2000),
      hotelMarkupPercent: pct(input.hotelMarkupPercent, 40),
      minProfit: dollars(input.minProfit, 5000),
      minMarginPercent: pct(input.minMarginPercent, 50),
      disabledDestinations: [].concat(input.disabledDestinations || []).filter(d => this.inv.maps.getDestination(d)),
    };
    await this.store.putRecord('settings', 'pricing', next);
    this.settingsCache = null;
    return next;
  }

  // ---- analytics ----
  async track(type, { visitor = null, userId = null, data = {} } = {}) {
    try {
      const e = { id: id('evt'), type, visitor, userId, at: this.now().toISOString(), data };
      await this.store.putRecord('event', e.id, e);
    } catch (err) { this.log.error('[analytics]', err); }
  }

  // ---- search ----
  parse(raw) { return optimizer.parseSearch(raw, { maps: this.inv.maps, now: this.now() }); }

  // When nothing fits: which single rule, relaxed on its own, really produces a trip.
  async oneRuleAway(query) {
    const settings = await this.settings();
    return optimizer.oneRuleAway(this.inv, query, { settings, now: this.now() });
  }

  async search(query, { visitor, user } = {}) {
    await this.track('search_started', { visitor, userId: user && user.id, data: { budget: query.budget, travelers: query.travelers, style: query.style, priority: query.priority, origin: query.origin } });
    const settings = await this.settings();
    const result = optimizer.search(this.inv, query, { settings, now: this.now() });
    if (result.picks.length) await this.track('results_viewed', { visitor, userId: user && user.id, data: { picks: result.picks.map(p => p.trip.dest.id) } });
    if (user) await this.store.putRecord('last_search', user.id, { params: optimizer.searchParams(query), query, at: this.now().toISOString() }, { userId: user.id });
    return result;
  }

  // Sample results for marketing sections (homepage example, SEO pages). Not tracked as searches.
  async sample(raw) {
    const { query } = this.parse(raw);
    return optimizer.search(this.inv, query, { settings: await this.settings(), now: this.now() });
  }

  // ---- a single trip ----
  async price(spec, { promo } = {}) {
    return priceTrip(this.inv, spec, await this.settings(), { promo });
  }

  async trip(token, ctx = {}) {
    const spec = decodeSpec(token);
    const t = requireTrip(await this.price(spec));
    const scores = optimizer.scoreTrip(t, ctx);
    return {
      trip: t, token: encodeSpec(t.spec), scores, why: optimizer.whyThisTrip(t, ctx),
      options: optimizer.customizerOptions(this.inv, t, await this.settings(), this.now()),
      origin: this.inv.maps.airport(spec.from), weather: this.inv.weather.outlook(spec.dest, Number(spec.depart.slice(5, 7))),
    };
  }

  // "Make it better for the same money" / "lock what you love, improve the rest": the strongest
  // alternative package at or under the cap (the current total, or the budget) with the locked parts
  // held fixed. Returns no proposal when nothing beats the current trip.
  async optimize(token, ctx = {}, { locks = {}, capMode = 'same' } = {}) {
    const current = await this.trip(token, ctx);
    const settings = await this.settings();
    const budgetCap = ctx.budget ? Math.round(ctx.budget * (1 + (ctx.allowOver || 0) / 100)) : null;
    const cap = capMode === 'budget' && budgetCap ? Math.max(current.trip.total, budgetCap) : current.trip.total;
    const best = decision.optimizeAround(this.inv, current.trip, settings, ctx, { locks, cap, now: this.now() });
    if (!best) return { current, proposal: null, cap, locks, capMode };
    const proposal = await this.trip(encodeSpec(best.trip.spec), ctx);
    return { current, proposal: { ...proposal, improvements: best.improvements, tradeoffs: best.tradeoffs, delta: best.delta }, cap, locks, capMode };
  }

  // "Name your price": the cheapest version of this trip that is still strong at or under the price
  // the traveler named, the cheapest version we would recommend at all, the best version that
  // reaches the price when none is strong (with its compromises), and the value ladder in between.
  // Candidates come back as trip-page data so every one carries a token.
  async namePrice(token, ctx = {}, target) {
    const current = await this.trip(token, ctx);
    if (target >= current.trip.total) return { current, currentTotal: current.trip.total, target, tooHigh: true };
    const settings = await this.settings();
    const out = decision.nameYourPrice(this.inv, current.trip, settings, ctx, target, { now: this.now() });
    const page = async c => (c ? { ...c, ...(await this.trip(encodeSpec(c.trip.spec), ctx)) } : null);
    return { ...out, current, currentTotal: out.current, recommended: await page(out.recommended), floor: await page(out.floor), anyway: await page(out.anyway), tooHigh: false };
  }

  // Apply one customizer change and return the new trip token.
  customize(token, change) {
    const s = decodeSpec(token);
    const next = { ...s, activities: [...s.activities] };
    if (change.hotel) next.hotel = String(change.hotel).slice(0, 40);
    if (change.flight) next.flight = String(change.flight).slice(0, 40);
    if (change.nights) next.nights = Math.max(2, Math.min(14, Number(change.nights) || s.nights));
    if (change.depart && /^\d{4}-\d{2}-\d{2}$/.test(change.depart)) next.depart = change.depart;
    if (change.bags !== undefined) next.bags = change.bags === '1' || change.bags === true;
    if (change.transfer !== undefined) next.transfer = change.transfer === '1' || change.transfer === true;
    if (change.activities !== undefined) next.activities = [].concat(change.activities).filter(Boolean).map(a => String(a).slice(0, 40)).slice(0, 6);
    if (next.depart < addDays(today(this.now()), 3)) next.depart = s.depart;
    return encodeSpec(next);
  }

  async promo(code) {
    if (!code) return null;
    const c = String(code).trim().toUpperCase().slice(0, 30);
    const p = await this.store.getRecord('promo', c);
    if (!p || !p.active || (p.expiresAt && p.expiresAt < today(this.now()))) throw new AppError('invalid_promo', 'That promo code isn’t valid.', 422, { promo: 'That promo code isn’t valid.' });
    return p;
  }

  // Live price check before checkout: re-ask the suppliers and compare with what the traveler saw.
  async verify(token, seen, { promoCode } = {}) {
    const promo = await this.promo(promoCode);
    const t = await this.price(decodeSpec(token), { promo });
    if (!t) return { available: false };
    const diff = Number.isFinite(seen) && seen > 0 ? t.total - seen : 0;
    return { available: true, trip: t, promo, status: diff === 0 ? 'same' : diff < 0 ? 'cheaper' : 'higher', diff: Math.abs(diff) };
  }

  async createQuote(token, { approvedTotal, budget, keep, allowOver, promoCode, user }) {
    const v = await this.verify(token, approvedTotal, { promoCode });
    if (!v.available) throw new AppError('trip_unavailable', 'Part of this trip is no longer available. Please rebuild it.', 410);
    if (v.status !== 'same') throw new AppError('price_changed', `Your trip price changed to ${money(v.trip.total)}. Please review it before continuing.`, 409, { newTotal: v.trip.total });
    const t = v.trip;
    const tokenNow = encodeSpec(t.spec);
    const origin = this.inv.maps.airport(t.spec.from);
    const now = this.now();
    const pub = publicTrip(t);
    const sum = keys => t.lines.filter(l => keys.includes(l.key)).reduce((s, l) => s + l.amount, 0);
    const taxDetail = t.lines.find(l => l.key === 'taxes').detail;
    const quote = {
      id: id('qt'), vertical: 'trips', refPrefix: 'BT', demo: t.demo, provider: 'trip-packages',
      query: { token: tokenNow },
      offer: {
        id: tokenNow, title: `${t.spec.nights} nights in ${t.dest.name}`, subtitle: `${origin ? origin.city : t.spec.from} to ${t.dest.name}, ${t.spec.travelers} traveler${t.spec.travelers > 1 ? 's' : ''}`,
        location: `${t.dest.name}, ${t.dest.country}`, media: [t.dest.image], demo: t.demo, provider: 'trip-packages',
      },
      option: { name: `${t.hotel.name} · ${t.flight.name} flights` },
      selection: {}, lines: t.lines.map(({ key, label, amount }) => ({ key, label, amount, kind: key === 'promo' ? 'discount' : key === 'taxes' ? 'tax' : key === 'service' ? 'fee' : 'base' })),
      currency: 'USD', subtotal: t.total - sum(['taxes', 'service']), taxes: sum(['taxes']), fees: sum(['service']), total: t.total,
      startDate: t.spec.depart,
      cancellation: { type: 'mixed', freeUntilHours: 0, penaltyPercent: 100, summary: 'Each part of the trip keeps its own cancellation terms, listed on your trip page.' },
      trip: {
        token: tokenNow, spec: t.spec, dest: { id: t.dest.id, name: t.dest.name, country: t.dest.country, image: t.dest.image },
        origin: origin ? { city: origin.city, code: origin.code } : { city: t.spec.from, code: t.spec.from },
        flight: pub.flight, hotel: pub.hotel, activities: pub.activities, transfer: pub.transfer, rooms: t.rooms,
        lines: pub.lines, included: pub.included, notIncluded: pub.notIncluded, providers: pub.providers, policies: pub.policies,
        perTraveler: t.perTraveler, perNight: t.perNight, total: t.total, internationalTrip: t.internationalTrip,
      },
      refundBasis: {
        flights: sum(['flights', 'bags']) + taxDetail[0].amount,
        hotel: sum(['hotel']) + taxDetail.slice(1).reduce((s, l) => s + l.amount, 0),
        activities: t.activities.map(a => ({ id: a.id, amount: a.pricePerPerson * t.spec.travelers })),
        transfer: sum(['transfer']), service: sum(['service']), discount: -sum(['promo']),
      },
      budget: { budget: budget || null, keep: budget && keep ? keep : 0, allowOver: allowOver || 0 },
      promoCode: v.promo ? v.promo.code : null,
      internal: t.internal,
      userId: user ? user.id : null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.quoteTtlMinutes * 60000).toISOString(),
    };
    await this.store.saveQuote(quote);
    return quote;
  }

  // ---- the provider the booking engine calls for vertical 'trips' ----
  bookingProvider() {
    const svc = this;
    return {
      async recheck(quote) {
        const v = await svc.verify(quote.trip.token, quote.total, { promoCode: quote.promoCode }).catch(() => ({ available: false }));
        const url = `/trip/${quote.trip.token}/review?seen=${quote.total}${quote.budget && quote.budget.budget ? `&b=${quote.budget.budget / 100}${quote.budget.keep ? `&k=${quote.budget.keep / 100}` : ''}` : ''}`;
        if (!v.available) return { changed: true, newTotal: null, url, message: 'Part of this trip is no longer available, so nothing was charged. Please review the trip.' };
        if (v.status === 'same') return { changed: false };
        return {
          changed: true, newTotal: v.trip.total, url,
          message: v.status === 'cheaper'
            ? `Good news — your trip dropped to ${money(v.trip.total)}. Nothing was charged; please confirm the new price.`
            : `Your trip price changed by ${money(v.diff)}. Nothing was charged; please review and approve the new price.`,
        };
      },
      async book({ quote, traveler, bookingRef }) {
        const t = await svc.price(quote.trip.spec);
        if (!t) throw new Error('trip components unavailable at booking time');
        const components = [];
        const ctx = { traveler, tripRef: bookingRef };
        const flight = await svc.inv.flights.book(t.flight, ctx); // a failure here fails the whole booking (full refund)
        components.push({ kind: 'flight', name: `${t.flight.airline} · ${t.flight.from} ⇄ ${t.flight.to}`, supplier: t.flight.supplier, status: 'confirmed', confirmation: flight.confirmation });
        const rest = [
          { kind: 'hotel', name: t.hotel.name, supplier: t.hotel.supplier, run: () => svc.inv.hotels.book(t.hotel, ctx) },
          ...t.activities.map(a => ({ kind: 'activity', name: a.name, supplier: a.supplier, run: () => svc.inv.activities.book(a, ctx) })),
          ...(t.transfer ? [{ kind: 'transfer', name: t.transfer.name, supplier: t.transfer.supplier, run: () => svc.inv.transfers.book(t.transfer, ctx) }] : []),
        ];
        let failed = null;
        for (const c of rest) {
          if (failed) { components.push({ kind: c.kind, name: c.name, supplier: c.supplier, status: 'not_booked' }); continue; }
          try {
            const r = await c.run();
            components.push({ kind: c.kind, name: c.name, supplier: c.supplier, status: 'confirmed', confirmation: r.confirmation });
          } catch (err) {
            svc.log.error(`[trips] ${c.kind} booking failed for ${bookingRef}:`, err && err.message);
            failed = c.kind;
            components.push({ kind: c.kind, name: c.name, supplier: c.supplier, status: 'failed' });
          }
        }
        return failed
          ? { status: 'partial', supplierRef: flight.confirmation, components, note: `${failed}_failed` }
          : { status: 'confirmed', supplierRef: flight.confirmation, components };
      },
      async cancel() { /* Demo suppliers accept every cancellation; real adapters cancel each component here. */ },
      cancellationPreview(b, now) {
        if (b.status === 'partially_confirmed') return { allowed: false, reason: 'Our team is already working on this trip and will contact you about your options and any refund.' };
        const q = b.quote, rb = q.refundBasis;
        const paid = (b.payment && b.payment.amount) || b.total;
        const hours = hoursUntil(b.startDate, now);
        if (hours <= 0) return { allowed: false, reason: 'This trip has already started.' };
        const sinceBooking = (now.getTime() - Date.parse(b.createdAt)) / 3600000;
        if (sinceBooking <= 24 && daysBetween(today(now), b.startDate) >= 7) {
          return { allowed: true, refundAmount: paid, currency: b.currency, freeWindowOpen: true, policy: 'You’re within 24 hours of booking, so the whole trip is refundable.', breakdown: [{ component: 'Whole trip', amount: paid }] };
        }
        const f = q.trip.flight, h = q.trip.hotel;
        const breakdown = [
          { component: 'Flights', amount: f.refundable && hours >= (f.freeCancelHours || 0) ? rb.flights : 0 },
          { component: 'Hotel', amount: h.refundable && hours >= h.freeCancelHours ? rb.hotel : 0 },
          ...rb.activities.map(a => ({ component: (q.trip.activities.find(x => x.id === a.id) || {}).name || 'Experience', amount: hours >= 24 ? a.amount : 0 })),
          ...(rb.transfer ? [{ component: 'Airport transfer', amount: hours >= 24 ? rb.transfer : 0 }] : []),
          { component: 'Service fee', amount: 0 },
        ];
        const gross = breakdown.reduce((s, x) => s + x.amount, 0);
        const before = paid + (rb.discount || 0);
        const refund = Math.min(paid, Math.round(rb.discount ? gross * (paid / before) : gross));
        return { allowed: true, refundAmount: refund, currency: b.currency, freeWindowOpen: refund === paid, policy: 'Refunds follow each part’s own terms.', breakdown };
      },
    };
  }

  // Booking engine events → analytics, notifications and admin alerts.
  async onBookingEvent(type, b) {
    if (b.vertical !== 'trips') return;
    const visitor = null;
    if (type === 'payment_attempted' || type === 'booking_confirmed') await this.track(type, { visitor, userId: b.userId, data: { ref: b.ref, total: b.total, dest: b.quote.trip.dest.id } });
    if (type === 'booking_confirmed') {
      await this.notifier.send({ to: b.traveler.email, subject: `Your trip is confirmed · TRIP #${b.ref}`, body: `${b.quote.offer.title}. Total paid ${money(b.total)}.`, ref: b.ref });
    }
    if (type === 'partially_confirmed' || type === 'booking_failed') {
      const alert = { id: id('alr'), ref: b.ref, type, message: type === 'partially_confirmed' ? 'Part of this trip could not be confirmed. Manual intervention needed.' : 'Booking failed after payment; the payment was refunded automatically.', open: true, at: this.now().toISOString() };
      await this.store.putRecord('alert', alert.id, alert);
      await this.notifier.send({ to: 'operations', audience: 'admin', subject: `Action needed: TRIP #${b.ref}`, body: alert.message, ref: b.ref });
      await this.notifier.send({ to: b.traveler.email, subject: `An update on TRIP #${b.ref}`, body: 'Part of your trip could not be confirmed. Our team is on it and will contact you.', ref: b.ref });
    }
  }

  // ---- saved trips, price watches, abandoned trips ----
  async saveTrip(user, token, { kind = 'saved', budget = null } = {}) {
    const t = requireTrip(await this.price(decodeSpec(token)));
    const rec = { id: id(kind === 'watch' ? 'wch' : 'sav'), kind, token: encodeSpec(t.spec), budget, priceAtSave: t.total, title: `${t.spec.nights} nights in ${t.dest.name}`, savedAt: this.now().toISOString() };
    await this.store.putRecord(kind, rec.id, rec, { userId: user.id });
    return rec;
  }

  async listSaved(user, kind) {
    const recs = await this.store.listRecords(kind, { userId: user.id, limit: 50 });
    const out = [];
    for (const r of recs) {
      let t = null;
      try { t = await this.price(decodeSpec(r.token)); } catch { t = null; }
      out.push({ ...r, trip: t ? publicTrip(t) : null, now: t ? t.total : null, change: t ? t.total - r.priceAtSave : null, departed: decodeSpec(r.token).depart < today(this.now()) });
    }
    return out;
  }

  async removeSaved(user, kind, recId) {
    const recs = await this.store.listRecords(kind, { userId: user.id, limit: 200 });
    if (!recs.find(r => r.id === recId)) throw new AppError('not_found', 'Not found.', 404);
    await this.store.deleteRecord(kind, recId);
  }

  async rememberTrip(user, token, budget) {
    if (!user) return;
    await this.store.putRecord('recent_trip', user.id, { token, budget, at: this.now().toISOString() }, { userId: user.id });
  }

  // "Still thinking about Cancun?" Only for a trip that hasn't been booked, re-priced right now.
  async recentTrip(user) {
    if (!user) return null;
    const r = await this.store.getRecord('recent_trip', user.id);
    if (!r) return null;
    let spec;
    try { spec = decodeSpec(r.token); } catch { return null; }
    if (spec.depart < addDays(today(this.now()), 3)) return null;
    const booked = (await this.store.listBookings({ userId: user.id, limit: 20 })).some(b => b.vertical === 'trips' && b.quote.trip.token === r.token && b.status !== 'expired');
    if (booked) return null;
    const t = await this.price(spec);
    return t ? { ...r, trip: publicTrip(t) } : null;
  }

  // ---- support ----
  async addSupportMessage(ref, { from, text, name }) {
    const body = str(text, 2000);
    if (body.length < 2) throw new AppError('invalid_message', 'Write a message first.', 422, { message: 'Write a message first.' });
    const m = { id: id('sup'), ref, from, name: str(name, 80), text: body, at: this.now().toISOString() };
    await this.store.putRecord('support', m.id, m);
    if (from === 'customer') await this.notifier.send({ to: 'support', audience: 'admin', subject: `New message on TRIP #${ref}`, body: body.slice(0, 200), ref });
    return m;
  }

  async supportMessages(ref) {
    return (await this.store.listRecords('support', { limit: 2000 })).filter(m => m.ref === ref).reverse();
  }

  async createRequest(input, user) {
    const r = {
      id: id('req'), name: str(input.name, 80), email: str(input.email, 120).toLowerCase(), budget: str(input.budget, 20), from: str(input.from, 80),
      travelers: str(input.travelers, 10), dates: str(input.dates, 80), wants: str(input.wants, 1500), status: 'received', userId: user ? user.id : null,
      at: this.now().toISOString(),
    };
    const errors = {};
    if (!r.name) errors.name = 'Enter your name.';
    if (!EMAIL.test(r.email)) errors.email = 'Enter a valid email address.';
    if (!r.wants || r.wants.length < 10) errors.wants = 'Tell us a little more about the trip you want.';
    if (Object.keys(errors).length) throw new AppError('invalid_request', 'Check the highlighted fields.', 422, errors);
    await this.store.putRecord('trip_request', r.id, r, { userId: r.userId });
    await this.notifier.send({ to: 'support', audience: 'admin', subject: 'New custom trip request', body: `${r.name}: ${r.wants.slice(0, 200)}`, ref: r.id });
    return r;
  }

  // ---- admin ----
  async dashboard({ days = 30 } = {}) {
    const since = new Date(this.now().getTime() - days * 86400000).toISOString();
    const bookings = (await this.store.listBookings({ limit: 5000 })).filter(b => b.vertical === 'trips');
    const t0 = today(this.now());
    const paidStatuses = ['confirmed', 'partially_confirmed', 'pending_supplier'];
    const inRange = bookings.filter(b => b.createdAt >= since);
    const paid = inRange.filter(b => paidStatuses.includes(b.status));
    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const gbv = sum(paid, b => b.total);
    const revenue = sum(paid, b => (b.quote.internal ? b.quote.internal.serviceFee + b.quote.internal.hotelMarkup + b.quote.internal.commission : 0));
    const profit = sum(paid, b => (b.quote.internal ? b.quote.internal.grossProfit : 0));
    const events = await this.store.listRecords('event', { since, limit: 50000 });
    const funnel = this.funnel(events);
    const searches = events.filter(e => e.type === 'search_started');
    const budgets = searches.map(e => e.data && e.data.budget).filter(Boolean);
    const destCount = {};
    for (const b of paid) destCount[b.quote.trip.dest.name] = (destCount[b.quote.trip.dest.name] || 0) + 1;
    const alerts = (await this.store.listRecords('alert', { limit: 200 })).filter(a => a.open);
    return {
      days,
      bookingsToday: bookings.filter(b => b.createdAt.slice(0, 10) === t0 && paidStatuses.includes(b.status)).length,
      gbv, revenue, profit, avgBookingValue: paid.length ? Math.round(gbv / paid.length) : 0,
      conversionRate: funnel[0].visitors ? Math.round((funnel[funnel.length - 1].visitors / funnel[0].visitors) * 1000) / 10 : 0,
      failed: inRange.filter(b => b.status === 'failed').length,
      pending: bookings.filter(b => ['pending_payment', 'confirming', 'pending_supplier', 'partially_confirmed'].includes(b.status)).length,
      refundRequests: bookings.filter(b => b.status === 'refund_pending' || b.status === 'partially_confirmed').length,
      flagged: paid.filter(b => b.quote.internal && b.quote.internal.review.flagged).length,
      avgBudget: budgets.length ? Math.round(sum(budgets, x => x) / budgets.length) : 0,
      popular: Object.entries(destCount).sort((a, b) => b[1] - a[1]).slice(0, 6),
      funnel, alerts, demo: this.demo,
    };
  }

  funnel(events) {
    const sets = Object.fromEntries(FUNNEL.map(s => [s, new Set()]));
    for (const e of events) if (sets[e.type]) sets[e.type].add(e.visitor || e.userId || e.id);
    return FUNNEL.map((s, i) => {
      const visitors = sets[s].size;
      const prev = i ? sets[FUNNEL[i - 1]].size : null;
      return { stage: s, label: FUNNEL_LABELS[s], visitors, fromPrevious: prev ? Math.round((visitors / prev) * 1000) / 10 : null, dropOff: prev !== null ? Math.max(0, prev - visitors) : null };
    });
  }

  async findBookings({ q = '', status = '' } = {}) {
    const needle = String(q).trim().toLowerCase().replace(/^trip\s*#?/, '');
    return (await this.store.listBookings({ limit: 5000 })).filter(b => b.vertical === 'trips')
      .filter(b => !status || b.status === status)
      .filter(b => !needle || [b.ref, b.traveler.email, `${b.traveler.firstName} ${b.traveler.lastName}`, b.quote.trip.dest.name].some(v => String(v).toLowerCase().includes(needle)))
      .slice(0, 200);
  }

  async adminSetStatus(ref, status, note, staff) {
    const allowed = ['confirmed', 'partially_confirmed', 'refund_pending', 'refunded', 'cancelled', 'failed'];
    if (!allowed.includes(status)) throw new AppError('invalid_status', 'Choose a valid status.', 422);
    const b = await this.store.getBookingByRef(ref);
    if (!b || b.vertical !== 'trips') throw new AppError('booking_not_found', 'Booking not found.', 404);
    const at = this.now().toISOString();
    await this.store.updateBooking(b.id, b.status, { status, history: [...b.history, { at, status, note: str(note, 300), by: staff.email }] });
    if (['confirmed', 'refunded', 'cancelled'].includes(status)) {
      for (const a of await this.store.listRecords('alert', { limit: 500 })) if (a.ref === ref && a.open) await this.store.putRecord('alert', a.id, { ...a, open: false, closedAt: at });
    }
  }
}

module.exports = { TripService, FUNNEL, FUNNEL_LABELS };
