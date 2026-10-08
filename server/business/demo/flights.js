// Business's own demo flights (plan §F2): the same fictional schedule as MockFlightProvider, with times local
// to each airport and honest per-fare terms. A subclass, so no file under providers/mock changes and the
// registry (Alamein Go, the AI travel agent) keeps serving MockFlightProvider itself. Loaded only when demo
// inventory is allowed (inventory.js requires it lazily).
//
// - The private helpers (AIRPORTS, km, blockMinutes) are copied from DATA = providers/mock/demo-data/flights.
// - buildOffers: the same itineraries (carriers, flight numbers, hubs, layovers, fares), but nonstop slot i of
//   n departs at 360 + floor((i + 0.15 + 0.7 × rand(seed, 'dep', i, 'slot')) × 900 / n) minutes, origin
//   local, rounded to 5 minutes: each nonstop sits in the middle 70% of its own slot of the 06:00 to 21:00
//   day, so two nonstops on a route are always more than an hour apart. (The plan's formula,
//   floor((i + rand(seed, 'dep', i)) × 900 / n), could put two of them minutes apart; and rand's hash moves
//   very little when only the last character of its key changes, hence the 'slot' suffix.) Flight numbers
//   are unique within a day's offers.
// - toOffer: the origin-local departure → UTC with tz.localToUtc(airport.tz, …); arrival = UTC + duration,
//   shown in the destination's time zone; a connection leaves the hub at the previous arrival + layover
//   (rounded to 5 minutes), shown in the hub's; details.segments[*].departAt/arriveAt are local
//   'YYYY-MM-DDTHH:MM' with arriveDayOffset; details.elapsedMinutes is first departure to last arrival in
//   UTC; details.fareFamilies carry each fare's terms; the offer-level cancellation is OFFER_CANCELLATION.
// - quote: FARE_TERMS[fare code] as the quote's (and the quoted offer's) cancellation, and that fare's bags.
// Example: CAI→LHR is 307 minutes of flying (5 h 07 min, short haul under 360); on 2026-11-12 (Cairo UTC+2,
// London UTC+0) a CAI departure at 08:35 arrives at 11:42 London time.
const MockFlightProvider = require('../../providers/mock/MockFlightProvider');
const { BaseMockProvider, media } = require('../../providers/mock/BaseMockProvider');
const DATA = require('../../providers/mock/demo-data/flights');
const { toMinor } = require('../../lib/money');
const { hash32 } = require('../../lib/ids');
const { daysBetween } = require('../../lib/dates');
const { AppError } = require('../../lib/errors');
const tz = require('../tz');

const MINUTE = 60000;
const FIVE_MINUTES = 5 * MINUTE;

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

/** The offer-level cancellation: the real terms depend on the fare, and quote() gives them. */
const OFFER_CANCELLATION = Object.freeze({
  type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100,
  summary: 'Refund and change terms depend on the fare (demo fare rules).',
});

/** Each demo fare family's terms (the quote's cancellation). */
const FARE_TERMS = Object.freeze({
  LIGHT: Object.freeze({ type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: 'Non-refundable. No changes.' }),
  CLASSIC: Object.freeze({ type: 'non_refundable', freeUntilHours: 0, penaltyPercent: 100, summary: 'Non-refundable. Changes for a fee.' }),
  FLEX: Object.freeze({ type: 'partial', freeUntilHours: 0, penaltyPercent: 30, summary: '70% refundable. Free changes.' }),
});

class BusinessDemoFlights extends MockFlightProvider {
  /** @param {{ latencyMs?: number }} [opts] */
  constructor(opts = {}) {
    super({ latencyMs: 0, ...opts, name: 'BusinessDemoFlights' });
  }

  /**
   * @param {{ from: string, to: string, departDate: string, cabin: string, passengers: number }} query
   * @param {{ offerId?: string }} [opts]
   * @returns {object[]} provider Offers (validateOffer passes), cheapest first
   * @throws {AppError} 400 unknown_airport / same_airport, as MockFlightProvider
   */
  buildOffers(query, { offerId } = {}) {
    const from = AIRPORTS[String(query.from || '').toUpperCase()];
    const to = AIRPORTS[String(query.to || '').toUpperCase()];
    if (!from || !to) throw new AppError('unknown_airport', 'Choose airports from the list.', 400);
    if (from.iata === to.iata) throw new AppError('same_airport', 'Departure and arrival airports must differ.', 400);
    const dist = km(from, to);
    const itineraries = [];
    const carriers = DATA.carriers.filter(c => (!c.regionalOnly || dist < 900) && (!c.longHaul || dist > 1500));
    const seed = `${from.iata}${to.iata}${query.departDate}`;

    // Non-stops: 2 to 4 a day, each in its own slot of the day.
    const nonstopCount = 2 + (hash32(seed) % 3);
    for (let i = 0; i < nonstopCount; i++) {
      const c = carriers[(hash32(`${seed}c${i}`)) % carriers.length];
      const dep = 360 + Math.floor((i + 0.15 + 0.7 * this.rand(seed, 'dep', i, 'slot')) * 900 / nonstopCount);
      itineraries.push({
        carrier: c, segments: [{ c, from, to, dep: Math.round(dep / 5) * 5, dur: blockMinutes(dist), n: 100 + (hash32(`${seed}n${i}`) % 800) }],
      });
    }
    // One-stop via a hub, for routes that aren't hub-adjacent.
    for (const hub of DATA.airports.filter(a => a.hub && a.iata !== from.iata && a.iata !== to.iata)) {
      const d1 = km(from, hub), d2 = km(hub, to);
      if (d1 + d2 > dist * 1.6) continue;
      const c = carriers[hash32(`${seed}${hub.iata}`) % carriers.length];
      const dep = 300 + Math.floor(this.rand(seed, hub.iata) * 780);
      const layover = 70 + Math.floor(this.rand(seed, hub.iata, 'lay') * 120);
      itineraries.push({
        carrier: c,
        segments: [
          { c, from, to: hub, dep: Math.round(dep / 5) * 5, dur: blockMinutes(d1), n: 100 + (hash32(`${seed}${hub.iata}1`) % 800) },
          { c, from: hub, to, layover, dur: blockMinutes(d2), n: 100 + (hash32(`${seed}${hub.iata}2`) % 800) },
        ],
      });
    }
    // Flight numbers come from a hash, so two itineraries could share one: bump until every number is unique.
    const used = new Set();
    for (const it of itineraries) {
      for (const s of it.segments) {
        while (used.has(`${s.c.code}${s.n}`)) s.n = 100 + ((s.n - 100 + 1) % 800);
        used.add(`${s.c.code}${s.n}`);
      }
    }

    return itineraries
      .map(it => this.toOffer(it, query, dist))
      .filter(o => !offerId || o.id === offerId)
      .sort((a, b) => a.fromPrice.amount - b.fromPrice.amount || (a.id < b.id ? -1 : 1));
  }

  /** @returns {object} one provider Offer with local times (see the header) */
  toOffer(it, query, dist) {
    const segs = [];
    let firstDepart = null, prevArrive = null;
    for (const s of it.segments) {
      const departUtc = prevArrive == null
        ? tz.localToUtc(s.from.tz, `${query.departDate}T${hhmm(s.dep)}`).getTime()
        : Math.round((prevArrive + s.layover * MINUTE) / FIVE_MINUTES) * FIVE_MINUTES;
      const arriveUtc = departUtc + s.dur * MINUTE;
      const departAt = tz.utcToLocal(s.from.tz, departUtc);
      const arriveAt = tz.utcToLocal(s.to.tz, arriveUtc);
      if (firstDepart == null) firstDepart = departUtc;
      prevArrive = arriveUtc;
      segs.push({
        carrier: { code: s.c.code, name: s.c.name },
        flightNumber: `${s.c.code}${s.n}`,
        from: { code: s.from.iata, name: s.from.name, city: s.from.city },
        to: { code: s.to.iata, name: s.to.name, city: s.to.city },
        departAt,
        arriveAt,
        arriveDayOffset: daysBetween(departAt.slice(0, 10), arriveAt.slice(0, 10)),
        durationMinutes: s.dur,
        aircraft: s.c.aircraft[s.n % s.c.aircraft.length],
      });
    }
    const first = segs[0], last = segs[segs.length - 1];
    const elapsedMinutes = Math.round((prevArrive - firstDepart) / MINUTE);
    const dayOffset = daysBetween(first.departAt.slice(0, 10), last.arriveAt.slice(0, 10));
    const cabin = query.cabin || 'economy';
    const passengers = query.passengers || 1;
    const id = `flt_${segs.map(s => s.flightNumber).join('-')}_${query.departDate}_${cabin}`;
    // Base fare, exactly as MockFlightProvider: distance-driven, carrier quality, a little per-flight noise.
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
        total: { amount: toMinor(Math.round(baseUsd * f.multiplier)) * passengers, currency: 'USD' },
        available: seatsLeft >= passengers,
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
        { label: 'Arrive', value: `${last.arriveAt.slice(11)} ${last.to.code}${dayOffset > 0 ? ` (+${dayOffset})` : ''}` },
        { label: 'Duration', value: `${Math.floor(elapsedMinutes / 60)}h ${String(elapsedMinutes % 60).padStart(2, '0')}m` },
      ],
      options,
      cancellation: { ...OFFER_CANCELLATION },
      details: {
        segments: segs,
        stops: segs.length - 1,
        cabin,
        baggage: (() => { const f = DATA.fareFamilies[0]; return { cabinKg: f.cabin_kg, checkedBags: f.checked_bags, checkedKg: f.checked_kg }; })(),
        fareFamilies: DATA.fareFamilies.map(f => ({
          code: f.code, cabinKg: f.cabin_kg, checkedBags: f.checked_bags, checkedKg: f.checked_kg,
          refundablePercent: f.refundable_pct, changeable: f.changeable, terms: FARE_TERMS[f.code].summary,
        })),
        distanceKm: Math.round(dist),
        elapsedMinutes,
      },
    };
  }

  /**
   * The base quote (BaseMockProvider, not MockFlightProvider's "free cancellation up to 7 days"), with the
   * fare's own terms and bags. Writes nothing.
   * @param {{ offerId: string, optionId: string, query: object }} input
   * @returns {Promise<object>} a SupplierQuote whose cancellation is FARE_TERMS[optionId]
   */
  async quote(input) {
    const q = await BaseMockProvider.prototype.quote.call(this, input);
    const fam = DATA.fareFamilies.find(f => f.code === q.option.id);
    const terms = FARE_TERMS[q.option.id];
    if (!fam || !terms) throw new AppError('option_not_found', 'That option is no longer offered.', 404);
    q.cancellation = { ...terms };
    q.offer = {
      ...q.offer,
      cancellation: { ...terms },
      details: { ...q.offer.details, baggage: { cabinKg: fam.cabin_kg, checkedBags: fam.checked_bags, checkedKg: fam.checked_kg } },
    };
    return q;
  }
}

module.exports = { BusinessDemoFlights, FARE_TERMS, OFFER_CANCELLATION };
