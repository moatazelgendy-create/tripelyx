// HotelProvider backed by demo inventory. A real adapter (e.g. a bed bank or channel manager) replaces
// this file only; it must return the same normalized HotelOffer shape.
const HOTELS = require('./demo-data/hotels');
const { BaseMockProvider, media, cancellationFromDays, line, matchesText } = require('./BaseMockProvider');
const { toMinor, percentOf } = require('../../lib/money');
const { daysBetween, addDays } = require('../../lib/dates');

class MockHotelProvider extends BaseMockProvider {
  constructor(opts = {}) {
    super({ vertical: 'hotels', name: 'MockHotelProvider', ...opts });
  }

  buildOffers(query, { offerId } = {}) {
    const nights = Math.max(1, daysBetween(query.checkIn, query.checkOut));
    return HOTELS
      .filter(h => !offerId || `htl_${h.hotel_code}` === offerId)
      .filter(h => offerId || matchesText([h.name, h.area, h.city, h.country, h.category], query.where))
      .map(h => this.toOffer(h, query, nights))
      .filter(o => offerId || o.options.some(opt => opt.available && opt.capacity >= query.guests))
      .sort((a, b) => a.fromPrice.amount - b.fromPrice.amount);
  }

  toOffer(h, query, nights) {
    const options = h.rooms.map(r => {
      // A room type is unavailable if any night in the stay is sold out for it.
      let soldOut = false;
      for (let i = 0; i < nights && !soldOut; i++) soldOut = this.rand(h.hotel_code, r.code, addDays(query.checkIn, i)) < 0.08;
      const rate = toMinor(r.rate_usd);
      const remaining = soldOut ? 0 : 1 + Math.floor(this.rand(h.hotel_code, r.code, query.checkIn, 'left') * 6);
      return {
        id: r.code,
        name: r.name,
        description: `${r.bed} · ${r.size_m2} m² · sleeps ${r.sleeps}`,
        price: { amount: rate, currency: 'USD' },
        total: { amount: rate * nights, currency: 'USD' },
        capacity: r.sleeps,
        available: !soldOut && r.sleeps >= (query.guests || 1),
        remaining,
        features: r.features,
      };
    });
    const fits = options.filter(o => o.capacity >= (query.guests || 1));
    const cheapest = Math.min(...(fits.length ? fits : options).map(o => o.price.amount));
    return {
      id: `htl_${h.hotel_code}`,
      vertical: 'hotels',
      provider: this.name,
      demo: true,
      title: h.name,
      subtitle: `${h.category} · ${h.area}, ${h.city}`,
      description: h.blurb,
      location: { name: `${h.area}, ${h.city}`, area: h.area, city: h.city, country: h.country },
      media: h.scenes.map((s, i) => media(s, `${h.hotel_code}-${i}`, `${h.name} — ${['exterior', 'pool and grounds', 'room'][i] || 'photo'}`)),
      rating: { score: h.review_score, count: h.review_count },
      badges: h.stars >= 5 ? ['5-star'] : [],
      fromPrice: { amount: cheapest, currency: 'USD', unit: 'night' },
      attributes: [
        { label: 'Stars', value: '★'.repeat(h.stars) },
        { label: 'Check-in', value: `from ${h.check_in}` },
        { label: 'Check-out', value: `until ${h.check_out}` },
      ],
      options,
      cancellation: cancellationFromDays(h.cancel),
      details: {
        stars: h.stars, propertyType: h.category, amenities: h.amenities,
        checkInTime: h.check_in, checkOutTime: h.check_out, nights, taxesPercent: h.vat_pct,
      },
    };
  }

  priceLines(offer, option, query) {
    const h = HOTELS.find(x => `htl_${x.hotel_code}` === offer.id);
    const nights = offer.details.nights;
    const base = option.price.amount * nights;
    return [
      line('room', `${option.name} × ${nights} night${nights > 1 ? 's' : ''}`, 'base', base),
      line('vat', `VAT (${h.vat_pct}%)`, 'tax', percentOf(base, h.vat_pct)),
      line('city_tax', `City tax (${nights} night${nights > 1 ? 's' : ''})`, 'tax', toMinor(h.city_tax_usd_per_night) * nights),
    ];
  }

  startDate(offer, query) {
    return query.checkIn;
  }

  lookups() {
    return { where: [...new Set(HOTELS.flatMap(h => [h.city, `${h.area}, ${h.city}`]))] };
  }
}

module.exports = MockHotelProvider;
