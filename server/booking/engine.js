// The booking engine: search → offer → quote → booking → payment → supplier confirmation → cancel.
//
// It talks only to the provider interfaces (via the registry), the payment processor interface and the
// store. It never imports a provider or a processor directly, which is what lets a real supplier or a
// live processor be swapped in without touching this file or the UI.
const crypto = require('node:crypto');
const { getVertical } = require('../verticals');
const { validateOffer, validateQuote } = require('../providers/contracts');
const { AppError, ProviderError } = require('../lib/errors');
const { id, bookingRef } = require('../lib/ids');
const { isIsoDate, daysBetween, today, hoursUntil } = require('../lib/dates');
const { sumLines, percentOf } = require('../lib/money');
const { validateTraveler } = require('../lib/validate');

const MAX_RANGE_DAYS = 30;
const MAX_ADVANCE_DAYS = 500;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function partySize(query) {
  return query.guests || query.passengers || query.participants || 1;
}

class BookingEngine {
  constructor({ registry, store, payments, config, now = () => new Date(), log = console }) {
    // Providers that aren't one of the eight verticals (the trip package provider) register here.
    this.extraProviders = {};
    // Optional observers: { bookingEvent(type, booking) } for analytics and admin alerts.
    this.hooks = {};
    this.registry = registry;
    this.store = store;
    this.payments = payments;
    this.config = config;
    this.now = now;
    this.log = log;
  }

  provider(vertical) {
    if (this.extraProviders[vertical]) return this.extraProviders[vertical];
    const meta = getVertical(vertical);
    const p = meta && this.registry.get(vertical);
    if (!p) throw new AppError('vertical_unavailable', 'This service is not available right now.', 404);
    return p;
  }

  // Validate and coerce a raw (query-string) search into the typed query the provider interface expects,
  // using the vendor-neutral field schema from verticals.js.
  parseQuery(vertical, raw = {}) {
    const meta = getVertical(vertical);
    if (!meta) throw new AppError('vertical_unavailable', 'This service is not available right now.', 404);
    const q = {};
    const errors = {};
    const t = today(this.now());
    for (const f of meta.search) {
      let v = raw[f.name];
      if (v === undefined || v === '') v = f.default;
      if (v === undefined || v === '') {
        if (f.required) errors[f.name] = `${f.label} is required.`;
        continue;
      }
      v = String(v).trim().slice(0, 120);
      if (f.type === 'number') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < (f.min ?? 1) || n > (f.max ?? 99)) { errors[f.name] = `${f.label} must be between ${f.min ?? 1} and ${f.max ?? 99}.`; continue; }
        q[f.name] = n;
      } else if (f.type === 'date') {
        if (!isIsoDate(v)) { errors[f.name] = `${f.label} must be a valid date.`; continue; }
        if (v < t) { errors[f.name] = `${f.label} can't be in the past.`; continue; }
        if (daysBetween(t, v) > MAX_ADVANCE_DAYS) { errors[f.name] = `${f.label} is too far ahead.`; continue; }
        q[f.name] = v;
      } else if (f.type === 'month') {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) { errors[f.name] = `${f.label} must be a month.`; continue; }
        if (v < t.slice(0, 7)) { errors[f.name] = `${f.label} can't be in the past.`; continue; }
        q[f.name] = v;
      } else if (f.type === 'select') {
        if (!f.options.includes(v)) { errors[f.name] = `Choose a valid ${f.label.toLowerCase()}.`; continue; }
        q[f.name] = v;
      } else if (f.type === 'airport') {
        const code = v.toUpperCase().match(/\b([A-Z]{3})\b/);
        if (!code) { errors[f.name] = `Choose an airport for ${f.label.toLowerCase()}.`; continue; }
        q[f.name] = code[1];
      } else {
        q[f.name] = v;
      }
    }
    for (const f of meta.search) {
      if (f.after && q[f.name] && q[f.after]) {
        const span = daysBetween(q[f.after], q[f.name]);
        if (span < 1) errors[f.name] = `${f.label} must be after ${meta.search.find(x => x.name === f.after).label.toLowerCase()}.`;
        else if (span > MAX_RANGE_DAYS) errors[f.name] = `Bookings are limited to ${MAX_RANGE_DAYS} days.`;
      }
    }
    if (Object.keys(errors).length) throw new AppError('invalid_query', 'Check your search.', 422, errors);
    return q;
  }

  async callProvider(vertical, fn) {
    try {
      return await fn(this.provider(vertical));
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Supplier failures are logged with detail server-side and shown to the traveler generically.
      this.log.error(`[provider] ${vertical}:`, err instanceof ProviderError ? err.message : err);
      throw new AppError('supplier_unavailable', 'We couldn\'t reach our travel partner just now. Please try again in a moment.', 502);
    }
  }

  async search(vertical, raw) {
    const query = this.parseQuery(vertical, raw);
    const offers = await this.callProvider(vertical, p => p.search(query));
    return { query, offers: offers.map(o => validateOffer(o, vertical)) };
  }

  async getOffer(vertical, offerId, raw) {
    const query = this.parseQuery(vertical, raw);
    const offer = await this.callProvider(vertical, p => p.getOffer(String(offerId).slice(0, 300), query));
    if (!offer) throw new AppError('offer_not_found', 'This offer is no longer available for your search.', 404);
    return { query, offer: validateOffer(offer, vertical) };
  }

  async createQuote({ vertical, offerId, optionId, query: raw, selection = {} }) {
    const query = this.parseQuery(vertical, raw);
    const cleanSelection = {};
    for (const [k, v] of Object.entries(selection || {})) if (/^[a-z]{1,20}$/i.test(k)) cleanSelection[k] = String(v).slice(0, 40);
    const sq = await this.callProvider(vertical, p => p.quote({ offerId: String(offerId), optionId: String(optionId), query, selection: cleanSelection }));
    validateQuote(sq, vertical);
    if (sq.option.capacity && partySize(query) > sq.option.capacity && !['activities', 'experiences'].includes(vertical)) {
      throw new AppError('over_capacity', `${sq.option.name} takes up to ${sq.option.capacity}.`, 409);
    }
    const base = sumLines(sq.lines.filter(l => l.kind === 'base' || l.kind === 'discount'));
    const taxes = sumLines(sq.lines.filter(l => l.kind === 'tax'));
    const fees = sumLines(sq.lines.filter(l => l.kind === 'fee'));
    const now = this.now();
    const quote = {
      id: id('qt'),
      vertical,
      demo: !!sq.offer.demo,
      provider: sq.offer.provider,
      query,
      offer: sq.offer,
      option: sq.option,
      selection: sq.selection || {},
      lines: sq.lines,
      currency: sq.currency,
      subtotal: base,
      taxes,
      fees,
      total: base + taxes + fees,
      startDate: sq.startDate,
      cancellation: sq.cancellation,
      supplierQuoteRef: sq.supplierQuoteRef || null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.quoteTtlMinutes * 60000).toISOString(),
    };
    await this.store.saveQuote(quote);
    return quote;
  }

  async getQuote(quoteId) {
    const q = await this.store.getQuote(String(quoteId).slice(0, 64));
    if (!q) throw new AppError('quote_not_found', 'This price has expired. Please search again.', 404);
    return { ...q, expired: new Date(q.expiresAt) < this.now() };
  }

  async createBooking({ quoteId, traveler: rawTraveler, userId = null }) {
    const quote = await this.getQuote(quoteId);
    if (quote.expired) throw new AppError('quote_expired', 'This price has expired. Please go back and choose again.', 410);
    const traveler = validateTraveler(rawTraveler);
    const accessToken = crypto.randomBytes(24).toString('base64url');
    const now = this.now();
    // Demo bookings are marked twice — the DEMO- reference and the demo flag — so they can never be
    // confused with real ones in support conversations or reporting.
    const booking = {
      id: id('bk'),
      ref: quote.refPrefix ? bookingRef(quote.demo ? `DEMO-${quote.refPrefix}` : quote.refPrefix) : bookingRef(quote.demo ? 'DEMO' : 'TX'),
      userId,
      vertical: quote.vertical,
      status: 'pending_payment',
      demo: quote.demo,
      quote,
      traveler,
      total: quote.total,
      currency: quote.currency,
      startDate: quote.startDate,
      cancellation: quote.cancellation,
      accessTokenHashes: [sha256(accessToken)],
      paymentMode: this.payments.mode,
      paymentDueAt: new Date(now.getTime() + this.config.paymentWindowMinutes * 60000).toISOString(),
      supplierRef: null,
      createdAt: now.toISOString(),
      history: [{ at: now.toISOString(), status: 'pending_payment' }],
    };
    const intent = await this.payments.createIntent({
      amount: booking.total, currency: booking.currency, bookingId: booking.id,
      description: `${booking.ref} · ${quote.offer.title}`,
    });
    booking.paymentIntentId = intent.id;
    await this.store.createBooking(booking);
    return { booking: this.publicBooking(booking), accessToken, payment: this.payments.clientConfig() };
  }

  // A booking is reachable with the access token handed out at creation (checkout), or with its
  // reference plus the lead traveler's email (manage-booking). Either way the comparison is timing-safe
  // and a wrong guess looks exactly like a missing booking.
  async authorize(ref, { token, email } = {}) {
    const b = await this.store.getBookingByRef(String(ref || '').toUpperCase().slice(0, 20));
    const notFound = new AppError('booking_not_found', 'We couldn\'t find a booking with those details.', 404);
    if (!b) throw notFound;
    let ok = false;
    if (token) {
      const a = Buffer.from(sha256(String(token)));
      for (const h of b.accessTokenHashes || []) {
        const e = Buffer.from(h);
        if (a.length === e.length && crypto.timingSafeEqual(a, e)) ok = true;
      }
    } else if (email) {
      const a = Buffer.from(sha256(String(email).trim().toLowerCase())), e = Buffer.from(sha256(b.traveler.email));
      ok = crypto.timingSafeEqual(a, e);
    }
    if (!ok) throw notFound;
    return this.expireIfLapsed(b);
  }

  // Ref + email can be exchanged for a fresh access token (manage-booking from another device). The
  // last five tokens stay valid so the original checkout session keeps working.
  async issueAccessToken(b) {
    const token = crypto.randomBytes(24).toString('base64url');
    const hashes = [...(b.accessTokenHashes || []), sha256(token)].slice(-5);
    await this.store.updateBooking(b.id, null, { accessTokenHashes: hashes });
    return token;
  }

  async expireIfLapsed(b) {
    if (b.status === 'pending_payment' && new Date(b.paymentDueAt) < this.now()) {
      const at = this.now().toISOString();
      return (await this.store.updateBooking(b.id, 'pending_payment', { status: 'expired', history: [...b.history, { at, status: 'expired' }] })) || this.store.getBooking(b.id);
    }
    return b;
  }

  async getBooking(ref, auth) {
    const b = await this.authorize(ref, auth);
    return { booking: this.publicBooking(b), cancellationPreview: this.cancellationPreview(b), payment: b.status === 'pending_payment' ? this.payments.clientConfig() : null };
  }

  async payBooking(ref, auth, method) {
    let b = await this.authorize(ref, auth);
    if (b.status === 'expired') throw new AppError('payment_window_expired', 'The time to pay for this booking ran out. Please book again.', 410);
    if (b.status !== 'pending_payment') throw new AppError('not_awaiting_payment', 'This booking has already been paid or closed.', 409);

    // Re-check availability and the supplier price immediately before charging. A changed price is
    // never charged: the traveler goes back to approve it.
    const provider = this.provider(b.vertical);
    if (typeof provider.recheck === 'function') {
      const check = await provider.recheck(b.quote);
      if (check && check.changed) {
        throw new AppError('price_changed', check.message, 409, { newTotal: check.newTotal, url: check.url });
      }
    }
    this.emit('payment_attempted', b);

    const intent = await this.store.getPaymentIntent(b.paymentIntentId);
    const paid = await this.payments.confirm(intent, method);
    if (paid.status !== 'succeeded') {
      const at = this.now().toISOString();
      await this.store.updateBooking(b.id, 'pending_payment', { lastPaymentError: paid.lastError, history: [...b.history, { at, status: 'payment_failed', note: paid.declineCode }] });
      throw new AppError('payment_declined', paid.lastError || 'Your payment was declined.', 402);
    }

    // Claim the booking before calling the supplier so a double-submit can't book twice.
    const claimed = await this.store.updateBooking(b.id, 'pending_payment', {
      status: 'confirming', payment: { brand: paid.card && paid.card.brand, last4: paid.card && paid.card.last4, mode: paid.mode, amount: paid.amount },
      history: [...b.history, { at: this.now().toISOString(), status: 'paid' }],
    });
    if (!claimed) throw new AppError('not_awaiting_payment', 'This booking is already being processed.', 409);
    b = claimed;

    try {
      const res = await this.provider(b.vertical).book({ quote: b.quote, traveler: b.traveler, bookingRef: b.ref });
      const at = this.now().toISOString();
      const status = res.status === 'pending' ? 'pending_supplier' : res.status === 'partial' ? 'partially_confirmed' : 'confirmed';
      b = await this.store.updateBooking(b.id, 'confirming', {
        status,
        supplierRef: res.supplierRef,
        components: res.components || null,
        history: [...b.history, { at, status, note: res.note }],
      });
      this.emit(status === 'confirmed' ? 'booking_confirmed' : status, b);
      return { booking: this.publicBooking(b) };
    } catch (err) {
      // The supplier couldn't confirm: give the money back in full and tell the traveler plainly.
      this.log.error(`[booking] supplier booking failed for ${b.ref}:`, err && err.message);
      await this.payments.refund(paid, paid.amount);
      const at = this.now().toISOString();
      await this.store.updateBooking(b.id, 'confirming', {
        status: 'failed', refundAmount: paid.amount,
        history: [...b.history, { at, status: 'failed', note: 'supplier_rejected_refunded' }],
      });
      this.emit('booking_failed', b);
      throw new AppError('supplier_failed', 'Our travel partner couldn\'t confirm this booking, so your payment has been refunded in full. Please try another option.', 502);
    }
  }

  emit(type, booking) {
    try { if (this.hooks.bookingEvent) Promise.resolve(this.hooks.bookingEvent(type, booking)).catch(e => this.log.error('[hooks]', e)); } catch (e) { this.log.error('[hooks]', e); }
  }

  cancellationPreview(b) {
    if (b.status !== 'confirmed' && b.status !== 'pending_supplier' && b.status !== 'partially_confirmed') return null;
    const provider = this.extraProviders[b.vertical];
    if (provider && typeof provider.cancellationPreview === 'function') return provider.cancellationPreview(b, this.now());
    const c = b.cancellation;
    const hours = hoursUntil(b.startDate, this.now());
    if (hours <= 0) return { allowed: false, reason: 'This booking has already started.' };
    const paidAmount = (b.payment && b.payment.amount) || b.total;
    let refund;
    if (c.type !== 'non_refundable' && hours >= c.freeUntilHours) refund = paidAmount;
    else refund = paidAmount - percentOf(paidAmount, c.penaltyPercent);
    return { allowed: true, refundAmount: Math.max(0, refund), currency: b.currency, freeWindowOpen: c.type !== 'non_refundable' && hours >= c.freeUntilHours, policy: c.summary };
  }

  async cancelBooking(ref, auth) {
    const b = await this.authorize(ref, auth);
    if (b.status === 'pending_payment') {
      const at = this.now().toISOString();
      const u = await this.store.updateBooking(b.id, 'pending_payment', { status: 'cancelled', refundAmount: 0, history: [...b.history, { at, status: 'cancelled' }] });
      if (!u) throw new AppError('conflict', 'This booking changed. Refresh and try again.', 409);
      return { booking: this.publicBooking(u) };
    }
    const preview = this.cancellationPreview(b);
    if (!preview || !preview.allowed) throw new AppError('not_cancellable', (preview && preview.reason) || 'This booking can\'t be cancelled.', 409);
    const claimed = await this.store.updateBooking(b.id, b.status, { status: 'cancelling' });
    if (!claimed) throw new AppError('conflict', 'This booking changed. Refresh and try again.', 409);
    try {
      await this.provider(b.vertical).cancel({ supplierRef: b.supplierRef, reason: 'traveler_request', booking: b });
    } catch (err) {
      await this.store.updateBooking(b.id, 'cancelling', { status: b.status });
      this.log.error(`[booking] supplier cancel failed for ${b.ref}:`, err && err.message);
      throw new AppError('supplier_unavailable', 'We couldn\'t reach our travel partner to cancel. Nothing has changed — please try again shortly.', 502);
    }
    if (preview.refundAmount > 0) {
      const intent = await this.store.getPaymentIntent(b.paymentIntentId);
      await this.payments.refund(intent, preview.refundAmount);
    }
    const at = this.now().toISOString();
    const done = await this.store.updateBooking(b.id, 'cancelling', {
      status: 'cancelled', refundAmount: preview.refundAmount, history: [...b.history, { at, status: 'cancelled' }],
    });
    this.emit('booking_cancelled', done);
    return { booking: this.publicBooking(done) };
  }

  // What the browser may see about a booking: no token hash, no internal ids beyond the reference.
  publicBooking(b) {
    return {
      ref: b.ref,
      vertical: b.vertical,
      status: b.status,
      demo: b.demo,
      title: b.quote.offer.title,
      subtitle: b.quote.offer.subtitle,
      location: b.quote.offer.location,
      media: b.quote.offer.media.slice(0, 1),
      option: { name: b.quote.option.name },
      selection: b.quote.selection,
      query: b.quote.query,
      lines: b.quote.lines,
      total: b.total,
      currency: b.currency,
      startDate: b.startDate,
      cancellation: b.cancellation,
      traveler: { firstName: b.traveler.firstName, lastName: b.traveler.lastName, email: b.traveler.email },
      paymentMode: b.paymentMode,
      paymentDueAt: b.paymentDueAt,
      payment: b.payment ? { brand: b.payment.brand, last4: b.payment.last4, mode: b.payment.mode } : null,
      lastPaymentError: b.status === 'pending_payment' ? b.lastPaymentError || null : null,
      supplierRef: b.supplierRef,
      components: b.components || null,
      trip: b.quote.trip || null,
      budget: b.quote.budget || null,
      refundAmount: b.refundAmount ?? null,
      createdAt: b.createdAt,
    };
  }
}

module.exports = { BookingEngine, partySize };
