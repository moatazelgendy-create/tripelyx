// Business's own demo hotels (plan §F2): the Alamein Go demo hotels plus BUSINESS_HOTELS, read from
// this.hotels (MockHotelProvider reads its module-level HOTELS, so buildOffers, priceLines and lookups are
// all overridden). A subclass: no file under providers/mock changes, and the registry (Alamein Go, the AI
// travel agent) keeps serving MockHotelProvider itself. Loaded only when demo inventory is allowed.
//
// toOffer calls super's, then deletes `rating` when the source hotel has no review score (Business hotels
// have none) and adds each room's `bed` to its option. Nothing here is ever shown raw: dto.hotelRow keeps
// only its allow-list (no rating, media, badges, rooms left or provider name).
const MockHotelProvider = require('../../providers/mock/MockHotelProvider');
const HOTELS = require('../../providers/mock/demo-data/hotels');
const { line, matchesText } = require('../../providers/mock/BaseMockProvider');
const { toMinor, percentOf } = require('../../lib/money');
const { daysBetween } = require('../../lib/dates');
const { AppError } = require('../../lib/errors');
const { BUSINESS_HOTELS } = require('./hotels-data');

class BusinessDemoHotels extends MockHotelProvider {
  /** @param {{ hotels?: object[], latencyMs?: number }} [opts] hotels: raw demo hotels (default: Alamein Go's plus BUSINESS_HOTELS) */
  constructor({ hotels = [...HOTELS, ...BUSINESS_HOTELS], ...opts } = {}) {
    super({ latencyMs: 0, ...opts, name: 'BusinessDemoHotels' });
    this.hotels = hotels;
  }

  /**
   * MockHotelProvider.buildOffers over this.hotels: the hotels matching `where` (or the one offerId), with a
   * room that fits the guests, cheapest first.
   * @param {{ where: string, checkIn: string, checkOut: string, guests: number }} query
   * @param {{ offerId?: string }} [opts]
   * @returns {object[]} provider Offers from this.hotels, cheapest first
   */
  buildOffers(query, { offerId } = {}) {
    const nights = Math.max(1, daysBetween(query.checkIn, query.checkOut));
    return this.hotels
      .filter(h => !offerId || `htl_${h.hotel_code}` === offerId)
      .filter(h => offerId || matchesText([h.name, h.area, h.city, h.country, h.category], query.where))
      .map(h => this.toOffer(h, query, nights))
      .filter(o => offerId || o.options.some(opt => opt.available && opt.capacity >= query.guests))
      .sort((a, b) => a.fromPrice.amount - b.fromPrice.amount);
  }

  /** @returns {object} super.toOffer(...) without `rating` when the hotel has no review score, each option with its bed */
  toOffer(h, query, nights) {
    const offer = super.toOffer(h, query, nights);
    if (h.review_score == null) delete offer.rating;
    offer.options = offer.options.map(o => {
      const r = h.rooms.find(x => x.code === o.id);
      return { ...o, bed: r ? r.bed : '' };
    });
    return offer;
  }

  /**
   * MockHotelProvider's price lines, reading this.hotels. A city with no city tax gets no city tax line
   * (rather than a $0 one).
   * @returns {object[]}
   */
  priceLines(offer, option) {
    const h = this.hotels.find(x => `htl_${x.hotel_code}` === offer.id);
    if (!h) throw new AppError('offer_not_found', 'This offer is no longer available for your dates.', 404);
    const nights = offer.details.nights;
    const base = option.price.amount * nights;
    const lines = [
      line('room', `${option.name} × ${nights} night${nights > 1 ? 's' : ''}`, 'base', base),
      line('vat', `VAT (${h.vat_pct}%)`, 'tax', percentOf(base, h.vat_pct)),
    ];
    if (h.city_tax_usd_per_night > 0) {
      lines.push(line('city_tax', `City tax (${nights} night${nights > 1 ? 's' : ''})`, 'tax', toMinor(h.city_tax_usd_per_night) * nights));
    }
    return lines;
  }

  /** @returns {{ where: string[] }} cities and areas of this.hotels */
  lookups() {
    return { where: [...new Set(this.hotels.flatMap(h => [h.city, `${h.area}, ${h.city}`]))] };
  }
}

module.exports = { BusinessDemoHotels };
