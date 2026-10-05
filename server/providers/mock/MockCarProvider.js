// CarProvider backed by demo inventory. One offer per supplier × vehicle class at the pick-up location;
// protection packages are the options. Price per rental day.
const DATA = require('./demo-data/cars');
const { BaseMockProvider, media, cancellationFromDays, line, matchesText } = require('./BaseMockProvider');
const { toMinor, percentOf } = require('../../lib/money');
const { daysBetween } = require('../../lib/dates');

class MockCarProvider extends BaseMockProvider {
  constructor(opts = {}) {
    super({ vertical: 'cars', name: 'MockCarProvider', ...opts });
  }

  static locations() {
    return DATA.locations.map(l => l.name);
  }

  location(where) {
    return DATA.locations.find(l => matchesText([l.name, l.code], where)) || null;
  }

  buildOffers(query, { offerId } = {}) {
    const loc = this.location(query.where);
    if (!loc) return [];
    const days = Math.max(1, daysBetween(query.pickupDate, query.dropoffDate));
    const offers = [];
    for (const s of DATA.suppliers.filter(x => x.locations.includes(loc.code))) {
      for (const v of DATA.vehicles) {
        const id = `car_${s.code}_${v.sipp}_${loc.code}`;
        if (offerId && id !== offerId) continue;
        // Each supplier carries most classes; a few combinations are missing or sold out.
        if (this.rand(s.code, v.sipp) < 0.18) continue;
        const soldOut = this.rand(id, query.pickupDate) < 0.1;
        const dayRate = toMinor(Math.round(v.day_usd * (0.92 + this.rand(s.code, v.sipp, 'px') * 0.2)));
        const options = DATA.protection.map(p => {
          const perDay = dayRate + toMinor(p.day_usd);
          return {
            id: p.code, name: p.name, description: p.features.join(' · '),
            price: { amount: perDay, currency: 'USD' },
            total: { amount: perDay * days, currency: 'USD' },
            available: !soldOut, features: p.features,
          };
        });
        offers.push({
          id, vertical: 'cars', provider: this.name, demo: true,
          title: v.model, subtitle: `${v.class} · ${s.name}`,
          description: `${v.seats} seats · ${v.doors} doors · ${v.bags} bags · ${v.auto ? 'Automatic' : 'Manual'}${v.ac ? ' · Air conditioning' : ''}`,
          location: { name: loc.name, city: loc.name },
          media: [media(v.scene, id, `${v.class} car — ${v.model}`)],
          rating: { score: s.rating, count: s.reviews },
          badges: v.auto ? ['Automatic'] : [],
          fromPrice: { amount: dayRate, currency: 'USD', unit: 'day' },
          attributes: [
            { label: 'Seats', value: String(v.seats) },
            { label: 'Bags', value: String(v.bags) },
            { label: 'Fuel policy', value: s.fuel_policy },
            { label: 'Deposit', value: `USD ${s.deposit_usd}` },
          ],
          options,
          cancellation: cancellationFromDays(DATA.cancel),
          details: {
            vehicleClass: v.class, model: v.model, seats: v.seats, doors: v.doors, bags: v.bags,
            transmission: v.auto ? 'automatic' : 'manual', airConditioning: v.ac, fuelPolicy: s.fuel_policy,
            supplier: s.name, pickup: { location: loc.name, at: `${query.pickupDate}T10:00` },
            dropoff: { location: loc.name, at: `${query.dropoffDate}T10:00` }, days,
            airportSurcharge: toMinor(loc.surcharge_usd), depositUsd: s.deposit_usd,
          },
        });
      }
    }
    return offers.sort((a, b) => a.fromPrice.amount - b.fromPrice.amount);
  }

  priceLines(offer, option, query) {
    const d = offer.details;
    const lines = [line('rental', `${d.vehicleClass} × ${d.days} day${d.days > 1 ? 's' : ''} (${option.name.toLowerCase()})`, 'base', option.price.amount * d.days)];
    if (d.airportSurcharge) lines.push(line('airport', 'Airport location surcharge', 'fee', d.airportSurcharge));
    if (query.driverAge < DATA.young_driver_age) lines.push(line('young_driver', `Young driver fee (under ${DATA.young_driver_age})`, 'fee', toMinor(DATA.young_driver_day_usd) * d.days));
    const taxable = lines.reduce((a, l) => a + l.amount, 0);
    lines.push(line('vat', `VAT (${DATA.vat_pct}%)`, 'tax', percentOf(taxable, DATA.vat_pct)));
    return lines;
  }

  startDate(offer, query) {
    return query.pickupDate;
  }

  lookups() {
    return { where: MockCarProvider.locations() };
  }
}

module.exports = MockCarProvider;
