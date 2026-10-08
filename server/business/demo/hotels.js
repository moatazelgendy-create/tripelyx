// Business's own demo hotels (plan §F2): the Alamein Go demo hotels plus BUSINESS_HOTELS, read from
// this.hotels (MockHotelProvider reads its module-level HOTELS, so buildOffers, priceLines and lookups are
// all overridden). A subclass: no file under providers/mock changes.
// STUB from Stage 0 with the frozen interface; Stage 1I builds it. Loaded only when demo inventory is allowed.
//
// toOffer calls super's, then deletes `rating` when the source hotel has no review score (Business hotels
// have none). Nothing here is ever shown raw: dto.hotelRow strips rating, media, badges and the rest.
const MockHotelProvider = require('../../providers/mock/MockHotelProvider');
const HOTELS = require('../../providers/mock/demo-data/hotels');
const { BUSINESS_HOTELS } = require('./hotels-data');

function notBuilt() { throw new Error('[business] not built'); }

class BusinessDemoHotels extends MockHotelProvider {
  /** @param {{ hotels?: object[], latencyMs?: number }} [opts] hotels: raw demo hotels (default: Alamein Go's plus BUSINESS_HOTELS) */
  constructor({ hotels = [...HOTELS, ...BUSINESS_HOTELS], ...opts } = {}) {
    super({ latencyMs: 0, ...opts, name: 'BusinessDemoHotels' });
    this.hotels = hotels;
  }

  /**
   * @param {{ where: string, checkIn: string, checkOut: string, guests: number }} query
   * @param {{ offerId?: string }} [opts]
   * @returns {object[]} provider Offers from this.hotels, cheapest first
   */
  buildOffers(query, opts) { notBuilt(); }

  /** @returns {object} super.toOffer(...) without `rating` when the hotel has no review score */
  toOffer(h, query, nights) { notBuilt(); }

  /** @returns {object[]} price lines, reading this.hotels */
  priceLines(offer, option, query) { notBuilt(); }

  /** @returns {{ where: string[] }} cities and areas of this.hotels */
  lookups() { notBuilt(); }
}

module.exports = { BusinessDemoHotels };
