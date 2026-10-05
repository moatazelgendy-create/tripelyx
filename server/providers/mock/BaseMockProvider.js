// Shared plumbing for the demo providers. Each Mock*Provider maps its raw demo data into normalized
// Offers (exactly the job a real supplier adapter does) and prices a selection; this base class turns
// that into the full provider interface — search, getOffer, quote, book, cancel — with simulated
// network latency so the UI's loading states are exercised in development.
const { ProviderError, AppError } = require('../../lib/errors');
const { hash32 } = require('../../lib/ids');
const crypto = require('node:crypto');

class BaseMockProvider {
  constructor({ vertical, name, latencyMs = 0 }) {
    this.vertical = vertical;
    this.name = name;
    this.isDemo = true;
    this.latencyMs = latencyMs;
    this.bookings = new Map();
  }

  async delay() {
    if (!this.latencyMs) return;
    const jitter = Math.round(this.latencyMs * 0.6 * Math.random());
    await new Promise(r => setTimeout(r, this.latencyMs + jitter));
  }

  // Subclasses implement:
  //   buildOffers(query) -> Offer[]
  //   priceLines(offer, option, query, selection) -> PriceLine[]
  //   startDate(offer, query) -> 'YYYY-MM-DD'
  //   validateSelection(offer, option, query, selection) (optional)

  async search(query) {
    await this.delay();
    // A where of "__supplier_down__" simulates a supplier outage so the UI's error state can be seen.
    if (query && query.where === '__supplier_down__') throw new ProviderError(this.name, 'simulated supplier outage');
    return this.buildOffers(query);
  }

  async getOffer(offerId, query) {
    await this.delay();
    return this.buildOffers(query, { offerId }).find(o => o.id === offerId) || null;
  }

  async quote({ offerId, optionId, query, selection = {} }) {
    const offer = await this.getOffer(offerId, query);
    if (!offer) throw new AppError('offer_not_found', 'This offer is no longer available for your dates.', 404);
    const option = offer.options.find(o => o.id === optionId);
    if (!option) throw new AppError('option_not_found', 'That option is no longer offered.', 404);
    if (!option.available) throw new AppError('option_sold_out', `${option.name} is sold out for your dates.`, 409);
    if (this.validateSelection) this.validateSelection(offer, option, query, selection);
    return {
      offer,
      option,
      selection,
      lines: this.priceLines(offer, option, query, selection),
      currency: offer.fromPrice.currency,
      startDate: this.startDate(offer, query),
      cancellation: offer.cancellation,
      supplierQuoteRef: `MQ-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    };
  }

  async book({ quote, traveler, bookingRef }) {
    await this.delay();
    if (!traveler || !traveler.email) throw new ProviderError(this.name, 'traveler email missing', { retryable: false });
    const supplierRef = `${this.name.replace(/[^A-Z]/g, '').slice(0, 3) || 'MCK'}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    this.bookings.set(supplierRef, { bookingRef, offerId: quote.offer.id, status: 'confirmed', at: new Date().toISOString() });
    return { supplierRef, status: 'confirmed' };
  }

  async cancel({ supplierRef }) {
    await this.delay();
    const b = this.bookings.get(supplierRef);
    // After a server restart the in-memory supplier bookings are gone; the demo supplier accepts the
    // cancellation anyway, like most real APIs do for an unknown-but-well-formed reference.
    if (b) b.status = 'cancelled';
    return { cancelled: true };
  }

  // Deterministic "random" in [0, 1) per key, so availability for a given item and date is stable
  // between search, offer page and quote.
  rand(...parts) {
    return hash32(parts.join('|')) / 4294967296;
  }
}

// ---- normalization helpers shared by the mock adapters ---------------------------------------

function media(scene, seed, alt) {
  return { url: `/media/demo/${scene}.svg?s=${encodeURIComponent(seed)}`, alt };
}

function cancellationFromDays(raw) {
  if (!raw || raw.nonrefundable) {
    return { type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: 'Non-refundable. No refund if you cancel.' };
  }
  const hours = raw.free_hours != null ? raw.free_hours : raw.free_days * 24;
  const pct = raw.late_penalty_pct;
  const window = hours % 24 === 0 && hours >= 48 ? `${hours / 24} days` : `${hours} hours`;
  return {
    type: pct >= 100 ? 'free' : 'partial',
    freeUntilHours: hours,
    penaltyPercent: pct,
    summary: pct >= 100
      ? `Free cancellation until ${window} before the start. After that the booking is non-refundable.`
      : `Free cancellation until ${window} before the start. After that ${pct}% of the total is charged.`,
  };
}

function line(code, label, kind, amount) {
  return { code, label, kind, amount: Math.round(amount) };
}

function matchesText(haystack, needle) {
  if (!needle) return true;
  const n = String(needle).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!n) return true;
  const h = haystack.filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return n.split(' ').every(word => h.includes(word));
}

module.exports = { BaseMockProvider, media, cancellationFromDays, line, matchesText };
