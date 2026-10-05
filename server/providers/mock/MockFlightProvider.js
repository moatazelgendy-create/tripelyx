// FlightProvider backed by a generated demo schedule. A real adapter (GDS/NDC aggregator) replaces this
// file only. Each fare family is an option of the itinerary offer; price is per passenger.
const DATA = require('./demo-data/flights');
const { BaseMockProvider, media, line } = require('./BaseMockProvider');
const { toMinor } = require('../../lib/money');
const { hash32 } = require('../../lib/ids');
const { AppError } = require('../../lib/errors');

const AIRPORTS = Object.fromEntries(DATA.airports.map(a => [a.iata, a]));

function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function blockMinutes(distanceKm) {
  return Math.round(35 + distanceKm / 780 * 60);
}

function hhmm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Local wall-clock 'YYYY-MM-DDTHH:MM' strings; all demo airports are treated as local time.
function at(date, minutes) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMinutes(minutes);
  return d.toISOString().slice(0, 16);
}

class MockFlightProvider extends BaseMockProvider {
  constructor(opts = {}) {
    super({ vertical: 'flights', name: 'MockFlightProvider', ...opts });
  }

  static airports() {
    return DATA.airports.map(a => ({ code: a.iata, name: a.name, city: a.city, country: a.country }));
  }

  buildOffers(query, { offerId } = {}) {
    const from = AIRPORTS[String(query.from || '').toUpperCase()];
    const to = AIRPORTS[String(query.to || '').toUpperCase()];
    if (!from || !to) throw new AppError('unknown_airport', 'Choose airports from the list.', 400);
    if (from.iata === to.iata) throw new AppError('same_airport', 'Departure and arrival airports must differ.', 400);
    const dist = km(from, to);
    const itineraries = [];
    const carriers = DATA.carriers.filter(c => (!c.regionalOnly || dist < 900) && (!c.longHaul || dist > 1500));
    const seed = `${from.iata}${to.iata}${query.departDate}`;

    // Non-stops: 2–4 per day.
    const nonstopCount = 2 + (hash32(seed) % 3);
    for (let i = 0; i < nonstopCount; i++) {
      const c = carriers[(hash32(`${seed}c${i}`)) % carriers.length];
      const dep = 360 + Math.floor(this.rand(seed, 'dep', i) * 900); // 06:00–21:00
      const dur = blockMinutes(dist);
      itineraries.push({
        carrier: c, segments: [{ c, from, to, dep: Math.round(dep / 5) * 5, dur, n: 100 + (hash32(`${seed}n${i}`) % 800) }],
      });
    }
    // One-stop via a hub, for routes that aren't hub-adjacent.
    for (const hub of DATA.airports.filter(a => a.hub && a.iata !== from.iata && a.iata !== to.iata)) {
      const d1 = km(from, hub), d2 = km(hub, to);
      if (d1 + d2 > dist * 1.6) continue;
      const c = carriers[hash32(`${seed}${hub.iata}`) % carriers.length];
      const dep = 300 + Math.floor(this.rand(seed, hub.iata) * 780);
      const dur1 = blockMinutes(d1), dur2 = blockMinutes(d2);
      const layover = 70 + Math.floor(this.rand(seed, hub.iata, 'lay') * 120);
      itineraries.push({
        carrier: c,
        segments: [
          { c, from, to: hub, dep: Math.round(dep / 5) * 5, dur: dur1, n: 100 + (hash32(`${seed}${hub.iata}1`) % 800) },
          { c, from: hub, to, dep: Math.round((dep + dur1 + layover) / 5) * 5, dur: dur2, n: 100 + (hash32(`${seed}${hub.iata}2`) % 800) },
        ],
      });
    }

    return itineraries
      .map(it => this.toOffer(it, query, dist))
      .filter(o => !offerId || o.id === offerId)
      .sort((a, b) => a.fromPrice.amount - b.fromPrice.amount);
  }

  toOffer(it, query, dist) {
    const segs = it.segments.map(s => ({
      carrier: { code: s.c.code, name: s.c.name },
      flightNumber: `${s.c.code}${s.n}`,
      from: { code: s.from.iata, name: s.from.name, city: s.from.city },
      to: { code: s.to.iata, name: s.to.name, city: s.to.city },
      departAt: at(query.departDate, s.dep),
      arriveAt: at(query.departDate, s.dep + s.dur),
      durationMinutes: s.dur,
      aircraft: s.c.aircraft[s.n % s.c.aircraft.length],
    }));
    const first = segs[0], last = segs[segs.length - 1];
    const totalMin = (Date.parse(`${last.arriveAt}Z`) - Date.parse(`${first.departAt}Z`)) / 60000;
    const id = `flt_${segs.map(s => s.flightNumber).join('-')}_${query.departDate}_${query.cabin}`;
    const cabin = query.cabin || 'economy';
    // Base fare: distance-driven, carrier quality, a little day-of-week and per-flight noise.
    const stopsDiscount = segs.length > 1 ? 0.86 : 1;
    const baseUsd = (39 + dist * 0.085) * it.carrier.quality * DATA.cabinMultiplier[cabin] * stopsDiscount
      * (0.9 + this.rand(id, 'noise') * 0.3);
    const options = DATA.fareFamilies.map(f => {
      const seatsLeft = Math.floor(this.rand(id, f.code, 'seats') * 9);
      return {
        id: f.code,
        name: f.name,
        description: f.features.join(' · '),
        price: { amount: toMinor(Math.round(baseUsd * f.multiplier)), currency: 'USD' },
        total: { amount: toMinor(Math.round(baseUsd * f.multiplier)) * query.passengers, currency: 'USD' },
        available: seatsLeft >= query.passengers,
        remaining: seatsLeft,
        features: f.features,
      };
    });
    const available = options.filter(o => o.available);
    const stopsLabel = segs.length === 1 ? 'Non-stop' : `1 stop · ${segs[0].to.code}`;
    return {
      id,
      vertical: 'flights',
      provider: this.name,
      demo: true,
      title: `${first.from.city} → ${last.to.city}`,
      subtitle: `${it.carrier.name} · ${stopsLabel}`,
      description: `${segs.map(s => s.flightNumber).join(' + ')} · ${cabin[0].toUpperCase()}${cabin.slice(1)} cabin`,
      location: { name: `${first.from.code} → ${last.to.code}`, city: last.to.city, country: AIRPORTS[last.to.code].country },
      media: [media('plane', id, `${it.carrier.name} aircraft`)],
      badges: segs.length === 1 ? ['Non-stop'] : [],
      fromPrice: { amount: Math.min(...(available.length ? available : options).map(o => o.price.amount)), currency: 'USD', unit: 'passenger' },
      attributes: [
        { label: 'Depart', value: `${first.departAt.slice(11)} ${first.from.code}` },
        { label: 'Arrive', value: `${last.arriveAt.slice(11)} ${last.to.code}${last.arriveAt.slice(0, 10) !== first.departAt.slice(0, 10) ? ' (+1)' : ''}` },
        { label: 'Duration', value: `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m` },
      ],
      options,
      cancellation: { type: 'free', freeUntilHours: 24 * 7, penaltyPercent: 100, summary: 'Free cancellation up to 7 days before departure. After that, Flex fares are 70% refundable and other fares are non-refundable.' },
      details: {
        segments: segs,
        stops: segs.length - 1,
        cabin,
        baggage: (() => { const f = DATA.fareFamilies[0]; return { cabinKg: f.cabin_kg, checkedBags: f.checked_bags, checkedKg: f.checked_kg }; })(),
        fareFamilies: DATA.fareFamilies.map(f => ({ code: f.code, cabinKg: f.cabin_kg, checkedBags: f.checked_bags, checkedKg: f.checked_kg, refundablePercent: f.refundable_pct, changeable: f.changeable })),
        distanceKm: Math.round(dist),
      },
    };
  }

  priceLines(offer, option, query) {
    const pax = query.passengers;
    const dist = offer.details.distanceKm;
    const t = DATA.taxes;
    const fuel = Math.round((dist / 1000) * t.fuel_surcharge_per_1000km_usd * 100);
    return [
      line('fare', `${option.name} fare × ${pax} passenger${pax > 1 ? 's' : ''}`, 'base', option.price.amount * pax),
      line('fuel', 'Carrier fuel surcharge', 'fee', fuel * pax),
      line('departure_tax', 'Departure tax', 'tax', toMinor(t.departure_tax_usd) * pax),
      line('security_fee', 'Security fee', 'tax', toMinor(t.security_fee_usd) * pax),
    ];
  }

  // Fare family decides how refundable the ticket is once the 24-hour grace window passes.
  quote(input) {
    return super.quote(input).then(q => {
      const fam = DATA.fareFamilies.find(f => f.code === q.option.id);
      q.cancellation = {
        type: fam.refundable_pct ? 'partial' : 'free',
        freeUntilHours: 24 * 7,
        penaltyPercent: 100 - fam.refundable_pct,
        summary: fam.refundable_pct
          ? `Free cancellation up to 7 days before departure. After that ${fam.refundable_pct}% is refunded.`
          : 'Free cancellation up to 7 days before departure. After that the fare is non-refundable.',
      };
      q.offer = { ...q.offer, cancellation: q.cancellation, details: { ...q.offer.details, baggage: { cabinKg: fam.cabin_kg, checkedBags: fam.checked_bags, checkedKg: fam.checked_kg } } };
      return q;
    });
  }

  startDate(offer, query) {
    return query.departDate;
  }

  lookups() {
    const airports = MockFlightProvider.airports();
    return { from: airports, to: airports };
  }
}

module.exports = MockFlightProvider;
