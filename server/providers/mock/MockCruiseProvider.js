// CruiseProvider backed by demo sailings. One offer per sailing; cabin categories are the options,
// priced per guest.
const DATA = require('./demo-data/cruises');
const { BaseMockProvider, media, cancellationFromDays, line, matchesText } = require('./BaseMockProvider');
const { toMinor } = require('../../lib/money');
const { addDays, today, daysBetween } = require('../../lib/dates');

const SHIPS = Object.fromEntries(DATA.ships.map(s => [s.code, s]));

class MockCruiseProvider extends BaseMockProvider {
  constructor(opts = {}) {
    super({ vertical: 'cruises', name: 'MockCruiseProvider', ...opts });
  }

  sailings(itin, { from, to }) {
    const out = [];
    let d = itin.first_sailing;
    // Jump close to the window rather than stepping from the first sailing every time.
    const gap = daysBetween(d, from);
    if (gap > 0) d = addDays(d, Math.floor(gap / itin.cadence_days) * itin.cadence_days);
    for (let i = 0; i < 80 && d <= to; i++, d = addDays(d, itin.cadence_days)) if (d >= from) out.push(d);
    return out;
  }

  buildOffers(query, { offerId } = {}) {
    const start = today();
    let from = addDays(start, 2), to = addDays(start, 180);
    if (query.month) {
      from = `${query.month}-01` > from ? `${query.month}-01` : from;
      to = addDays(`${query.month}-01`, 31);
      to = to.slice(0, 7) === query.month ? to : addDays(`${to.slice(0, 7)}-01`, -1);
    }
    const offers = [];
    for (const it of DATA.itineraries) {
      if (!offerId && !matchesText([it.name, it.region, it.embark, ...it.ports.map(p => p.port), ...it.ports.map(p => p.country)], query.where)) continue;
      for (const date of this.sailings(it, { from, to })) {
        const id = `cru_${it.code}_${date}`;
        if (offerId && id !== offerId) continue;
        offers.push(this.toOffer(it, date, query));
      }
    }
    return offers.sort((a, b) => a.details.departureDate.localeCompare(b.details.departureDate)).slice(0, 24);
  }

  toOffer(it, date, query) {
    const ship = SHIPS[it.ship];
    const id = `cru_${it.code}_${date}`;
    // Fares move a little by sailing: earlier and shoulder dates are cheaper.
    const factor = 0.9 + this.rand(id, 'fare') * 0.25;
    const options = it.cabins.map(c => {
      const pp = toMinor(Math.round(c.pp_usd * factor));
      const left = Math.floor(this.rand(id, c.code) * 14);
      return {
        id: c.code, name: c.name, description: `${c.features.join(' · ')} · sleeps up to ${c.sleeps}`,
        price: { amount: pp, currency: 'USD' }, total: { amount: pp * query.guests, currency: 'USD' },
        capacity: c.sleeps, available: left > 0 && c.sleeps >= query.guests, remaining: left, features: c.features,
      };
    });
    const ok = options.filter(o => o.available);
    const ports = it.ports.filter(p => p.port !== 'At sea').map(p => p.port);
    return {
      id, vertical: 'cruises', provider: this.name, demo: true,
      title: it.name,
      subtitle: `${it.nights} nights · ${ship.name}`,
      description: `Round trip from ${it.embark}, calling at ${[...new Set(ports.slice(1, -1))].join(', ')}.`,
      location: { name: it.region, city: it.embark },
      media: [media(ship.scene, id, `${ship.name} at sea`), media('islands', `${id}-port`, `${ports[2] || it.embark} harbour`)],
      rating: { score: 4.5 + (this.rand(it.code) * 0.4), count: 200 + Math.floor(this.rand(it.code, 'r') * 900) },
      badges: [it.region],
      fromPrice: { amount: Math.min(...(ok.length ? ok : options).map(o => o.price.amount)), currency: 'USD', unit: 'guest' },
      attributes: [
        { label: 'Departs', value: date },
        { label: 'Nights', value: String(it.nights) },
        { label: 'Ship', value: ship.name },
        { label: 'Embark', value: it.embark },
      ],
      options,
      cancellation: cancellationFromDays(DATA.cancel),
      details: {
        ship: { name: ship.name, line: DATA.line, yearBuilt: ship.built, guests: ship.guests },
        itinerary: it.ports.map(p => ({ day: p.day, port: p.port, country: p.country, arrive: p.arrive, depart: p.depart, date: addDays(date, p.day - 1) })),
        departureDate: date, nights: it.nights, embarkPort: it.embark,
        portFeesPerGuest: toMinor(it.port_fees_pp_usd), taxesPerGuest: toMinor(it.taxes_pp_usd),
      },
    };
  }

  priceLines(offer, option, query) {
    const g = query.guests;
    return [
      line('cruise_fare', `${option.name} cabin × ${g} guest${g > 1 ? 's' : ''}`, 'base', option.price.amount * g),
      line('port_fees', 'Port fees', 'fee', offer.details.portFeesPerGuest * g),
      line('taxes', 'Government taxes', 'tax', offer.details.taxesPerGuest * g),
    ];
  }

  startDate(offer) {
    return offer.details.departureDate;
  }

  lookups() {
    return { where: [...new Set(DATA.itineraries.flatMap(i => [i.region, i.embark]))] };
  }
}

module.exports = MockCruiseProvider;
