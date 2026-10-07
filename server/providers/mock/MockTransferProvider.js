// TransferProvider backed by demo operators. One offer per vehicle type for the route; options are
// one-way or return. Price per vehicle (per seat for the shared shuttle).
const DATA = require('./demo-data/transfers');
const { BaseMockProvider, media, cancellationFromDays, line, matchesText } = require('./BaseMockProvider');
const { toMinor, percentOf } = require('../../lib/money');
const { AppError } = require('../../lib/errors');

const OPERATORS = Object.fromEntries(DATA.operators.map(o => [o.code, o]));

function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  // Road distance is roughly 1.3× the straight line on the coast road network.
  return Math.max(4, 2 * R * Math.asin(Math.sqrt(s)) * 1.3);
}

class MockTransferProvider extends BaseMockProvider {
  constructor(opts = {}) {
    super({ vertical: 'transfers', name: 'MockTransferProvider', ...opts });
  }

  static places() {
    return DATA.places.map(p => p.name);
  }

  place(text) {
    return DATA.places.find(p => matchesText([p.name], text)) || null;
  }

  buildOffers(query, { offerId } = {}) {
    const from = this.place(query.from), to = this.place(query.to);
    if (!from || !to) throw new AppError('unknown_place', 'Choose pick-up and drop-off points from the list.', 400);
    if (from.name === to.name) throw new AppError('same_place', 'Pick-up and drop-off must differ.', 400);
    const dist = km(from, to);
    const minutes = Math.round(10 + dist / 75 * 60);
    return DATA.vehicles
      .filter(v => v.shared || v.max_pax >= query.passengers)
      .map(v => {
        const id = `trf_${v.code}_${encodeURIComponent(from.name)}_${encodeURIComponent(to.name)}`;
        const op = OPERATORS[v.operator];
        const units = v.shared ? query.passengers : 1;
        const oneWay = toMinor(Math.round(v.base_usd + dist * v.per_km_usd));
        const ret = Math.round(oneWay * 2 * (1 - DATA.return_discount_pct / 100));
        const opts = [
          { id: 'ONE_WAY', name: 'One way', amount: oneWay },
          { id: 'RETURN', name: 'Return trip', amount: ret },
        ];
        return {
          id, vertical: 'transfers', provider: this.name, demo: true,
          title: v.name, subtitle: `${op.name} · ${v.shared ? 'per seat' : `up to ${v.max_pax} passengers`}`,
          description: `${from.name} → ${to.name} · about ${minutes} min · ${Math.round(dist)} km`,
          location: { name: `${from.name} → ${to.name}`, city: to.name },
          media: [media(v.scene, id, `${v.name} vehicle`)],
          rating: { score: op.rating, count: op.reviews },
          badges: v.shared ? ['Shared'] : ['Private'],
          fromPrice: { amount: oneWay, currency: 'USD', unit: v.shared ? 'seat' : 'vehicle' },
          attributes: [
            { label: 'Passengers', value: v.shared ? 'per seat' : `up to ${v.max_pax}` },
            { label: 'Bags', value: `up to ${v.max_bags}${v.shared ? ' per seat' : ''}` },
            { label: 'Journey', value: `~${minutes} min` },
          ],
          options: opts.map(o => ({
            id: o.id, name: o.name, description: v.features.join(' · '),
            price: { amount: o.amount, currency: 'USD' }, total: { amount: o.amount * units, currency: 'USD' },
            capacity: v.shared ? undefined : v.max_pax, available: true, features: v.features,
          })),
          cancellation: cancellationFromDays(DATA.cancel),
          details: {
            from: from.name, to: to.name, date: query.date, vehicle: v.name, maxPassengers: v.max_pax,
            maxBags: v.max_bags, durationMinutes: minutes, meetAndGreet: !v.shared, shared: v.shared, distanceKm: Math.round(dist),
          },
        };
      })
      .filter(o => !offerId || o.id === offerId)
      .sort((a, b) => a.options[0].total.amount - b.options[0].total.amount);
  }

  priceLines(offer, option, query) {
    const units = offer.details.shared ? query.passengers : 1;
    const base = option.price.amount * units;
    return [
      line('transfer', `${offer.title} — ${option.name.toLowerCase()}${units > 1 ? ` × ${units} seats` : ''}`, 'base', base),
      line('vat', `VAT (${DATA.vat_pct}%)`, 'tax', percentOf(base, DATA.vat_pct)),
    ];
  }

  startDate(offer, query) {
    return query.date;
  }

  lookups() {
    const places = MockTransferProvider.places();
    return { from: places, to: places };
  }
}

module.exports = MockTransferProvider;
