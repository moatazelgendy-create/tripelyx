// YachtProvider backed by demo charters. One offer per yacht for the chosen date and duration;
// charter packages are the options. Price per charter (whole boat).
const DATA = require('./demo-data/yachts');
const { BaseMockProvider, media, cancellationFromDays, line, matchesText } = require('./BaseMockProvider');
const { toMinor, percentOf } = require('../../lib/money');

class MockYachtProvider extends BaseMockProvider {
  constructor(opts = {}) {
    super({ vertical: 'yachts', name: 'MockYachtProvider', ...opts });
  }

  buildOffers(query, { offerId } = {}) {
    const dur = DATA.durations[query.duration] || DATA.durations.half_day;
    const durKey = DATA.durations[query.duration] ? query.duration : 'half_day';
    return DATA.yachts
      .filter(y => !offerId || `yct_${y.code}` === offerId)
      .filter(y => offerId || (matchesText([y.marina, y.name, y.type, 'yacht marina'], query.where) && y.capacity >= query.guests))
      .map(y => {
        const id = `yct_${y.code}`;
        const booked = this.rand(y.code, query.date, durKey) < 0.22;
        const base = toMinor(y.rates_usd[durKey]);
        const options = DATA.packages.map(p => {
          const add = toMinor(p.add_usd) * (p.per_guest ? query.guests : 1);
          return {
            id: p.code, name: p.name, description: p.features.join(' · '),
            price: { amount: base + add, currency: 'USD' }, total: { amount: base + add, currency: 'USD' },
            capacity: y.capacity, available: !booked, features: p.features,
          };
        });
        return {
          id, vertical: 'yachts', provider: this.name, demo: true,
          title: y.name, subtitle: `${y.type} · ${y.length_m} m · up to ${y.capacity} guests`,
          description: `Operated by ${y.operator} from ${y.marina}. ${dur.label}, departing ${dur.start}.`,
          location: { name: y.marina, city: y.marina },
          media: [media(y.scene, id, `${y.name}, a ${y.type.toLowerCase()}`), media('sea', `${id}-sea`, 'Open water off the North Coast')],
          rating: { score: y.review_score, count: y.review_count },
          badges: booked ? ['Booked on this date'] : [],
          fromPrice: { amount: base, currency: 'USD', unit: 'charter' },
          attributes: [
            { label: 'Length', value: `${y.length_m} m` },
            { label: 'Guests', value: `up to ${y.capacity}` },
            { label: 'Cabins', value: String(y.cabins) },
            { label: 'Crew', value: String(y.crew) },
          ],
          options,
          cancellation: cancellationFromDays(DATA.cancel),
          details: {
            type: y.type, lengthM: y.length_m, capacity: y.capacity, cabins: y.cabins, crew: y.crew,
            marina: y.marina, date: query.date, duration: durKey, durationLabel: dur.label, durationHours: dur.hours,
            departs: dur.start, operator: y.operator, inclusions: y.inclusions,
          },
        };
      })
      .sort((a, b) => Number(a.badges.length) - Number(b.badges.length) || a.fromPrice.amount - b.fromPrice.amount);
  }

  priceLines(offer, option) {
    const lines = [
      line('charter', `${option.name} — ${offer.details.durationLabel.toLowerCase()}`, 'base', option.price.amount),
      line('marina_fee', 'Marina fee', 'fee', toMinor(DATA.marina_fee_usd)),
    ];
    lines.push(line('vat', `VAT (${DATA.vat_pct}%)`, 'tax', percentOf(lines[0].amount + lines[1].amount, DATA.vat_pct)));
    return lines;
  }

  startDate(offer, query) {
    return query.date;
  }

  lookups() {
    return { where: [...new Set(DATA.yachts.map(y => y.marina))] };
  }
}

module.exports = MockYachtProvider;
