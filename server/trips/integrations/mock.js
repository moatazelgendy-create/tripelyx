// Demo implementations of the trip integration interfaces (see types.d.ts): maps/locations, weather,
// flights, hotels, activities and transfers. They read the invented inventory in ../demo-data and
// generate deterministic prices, so a search always returns the same trips for the same day. Every
// offer they return is marked demo: true, and none of them is reachable when demo inventory is off.
const { DESTINATIONS, GUIDE_CHECKED_AT } = require('../demo-data/destinations');
const { ORIGINS } = require('../demo-data/origins');
const { hash32, id } = require('../../lib/ids');
const { addDays, daysBetween, today } = require('../../lib/dates');

const usd = n => Math.round(n * 100);
const DEMO_AIRLINES = ['Skylark Air', 'Coral Wing Airways', 'Bluewater Air', 'Atlas Ridge Airways'];
const FEATURE = { B: 'breakfast', P: 'pool', F: 'beachfront', A: 'adultsOnly', I: 'allInclusive', R: 'freeCancellation', K: 'familyFriendly', S: 'spa', H: 'airportShuttle' };

function jitter(key, spread) {
  return 1 - spread + ((hash32(key) % 1000) / 1000) * spread * 2;
}

function monthOf(dateStr) {
  return Number(dateStr.slice(5, 7));
}

function seasonFactor(dest, month) {
  if (dest.peak.includes(month)) return 1.2;
  if (dest.peak.includes(month === 1 ? 12 : month - 1) || dest.peak.includes(month === 12 ? 1 : month + 1)) return 1.06;
  return 0.93;
}

function haversineKm(a, b) {
  const R = 6371, rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function toDestination(d) {
  return {
    id: d.id, name: d.name, country: d.country, airport: d.airport, lat: d.lat, lon: d.lon,
    regions: d.regions, styles: d.styles, passportRequired: d.passport, blurb: d.blurb,
    image: { url: `/media/demo/${d.scene}.svg?s=${d.id}`, alt: `Illustration of ${d.name} (demo artwork)` },
    demo: true,
  };
}

class MockMaps {
  constructor() {
    this.kind = 'mock';
    this.dests = new Map(DESTINATIONS.map(d => [d.id, d]));
    this.origins = new Map(ORIGINS.map(o => [o.id, o]));
  }
  listDestinations() { return DESTINATIONS.map(toDestination); }
  getDestination(id) { const d = this.dests.get(id); return d ? toDestination(d) : null; }
  listOrigins() { return ORIGINS.map(o => ({ id: o.id, city: o.city, country: 'United States', airports: o.airports.map(a => ({ code: a.code, name: a.name, note: a.note || null })) })); }
  getOrigin(id) { return this.listOrigins().find(o => o.id === id) || null; }
  airport(code) {
    for (const o of ORIGINS) for (const a of o.airports) if (a.code === code) return { ...a, originId: o.id, city: o.city };
    return null;
  }
  distanceKm(fromAirport, destId) {
    const a = this.airport(fromAirport), d = this.dests.get(destId);
    return a && d ? haversineKm(a, d) : null;
  }
}

class MockWeather {
  constructor() { this.kind = 'mock'; }
  // A coarse climate outlook from each destination's demo climate type. A real weather API adapter
  // would return historical averages for the travel dates.
  outlook(destId, month) {
    const d = DESTINATIONS.find(x => x.id === destId);
    if (!d) return null;
    const warmMonths = {
      tropical: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], subtropical: [3, 4, 5, 6, 7, 8, 9, 10, 11],
      mediterranean: [5, 6, 7, 8, 9, 10], temperate: [6, 7, 8, 9], desert: [3, 4, 5, 6, 7, 8, 9, 10, 11], cool: [],
    }[d.climate];
    const warm = warmMonths.includes(month);
    const label = warm ? (d.climate === 'desert' && [6, 7, 8].includes(month) ? 'Hot' : 'Warm') : d.climate === 'cool' ? 'Cold' : 'Mild';
    return { warm, label, source: 'demo climate data' };
  }
}

class MockFlights {
  constructor({ maps, now }) { this.kind = 'mock'; this.maps = maps; this.now = now; }

  // Round trip per traveler, in cents. `neutral` skips season, weekday, lead-time and per-date
  // variation: that is the "typical" fare the Deal score compares against.
  baseFare(from, destId, depart, { neutral = false } = {}) {
    const km = this.maps.distanceKm(from, destId);
    const ap = this.maps.airport(from);
    const d = DESTINATIONS.find(x => x.id === destId);
    let fare = 70 + 0.068 * Math.min(km, 6000) + 0.045 * Math.max(0, km - 6000);
    if (!ap.hub) fare *= 0.9;
    if (neutral) return usd(fare);
    const dow = new Date(`${depart}T00:00:00Z`).getUTCDay();
    fare *= [1.1, 1.0, 0.9, 0.92, 1.02, 1.12, 1.04][dow];
    fare *= seasonFactor(d, monthOf(depart));
    const lead = daysBetween(today(this.now()), depart);
    fare *= lead < 7 ? 1.3 : lead < 14 ? 1.15 : lead < 21 ? 1.06 : 1;
    fare *= jitter(`fl:${from}:${destId}:${depart}`, 0.06);
    return usd(fare);
  }

  nonstopAvailable(from, destId) {
    const km = this.maps.distanceKm(from, destId);
    const ap = this.maps.airport(from);
    const d = DESTINATIONS.find(x => x.id === destId);
    if (d.nonstopFrom) return d.nonstopFrom.includes(from);
    if (d.airport === from) return false;
    return ap.hub ? km < 5200 : km < 2600;
  }

  // Up to three fares for the round trip: basic (cheapest, personal item only), saver (1 stop or the
  // cheapest nonstop) and nonstop flex.
  search({ from, destId, depart, nights, travelers }) {
    const km = this.maps.distanceKm(from, destId);
    if (km === null || km < 150) return [];
    const ret = addDays(depart, nights);
    const base = this.baseFare(from, destId, depart);
    const typical = this.baseFare(from, destId, depart, { neutral: true });
    const longHaul = km > 6000;
    const intl = DESTINATIONS.find(x => x.id === destId).passport;
    const taxRate = intl ? 0.18 : 0.13;
    const airline = DEMO_AIRLINES[hash32(`${from}:${destId}`) % DEMO_AIRLINES.length];
    const hoursNonstop = km / 800 + 0.6;
    const hoursOneStop = km / 780 + 2.4;
    const nonstop = this.nonstopAvailable(from, destId);
    // Demo schedules, in minutes from midnight local time: the cheapest fare leaves at dawn and comes
    // home at dawn, the nonstop keeps civilised hours. Real adapters return the airline's timetable.
    const times = (departMinutes, returnDepartMinutes, durationMinutes) => ({
      departMinutes, arriveMinutes: (departMinutes + durationMinutes) % 1440, arrivesNextDay: departMinutes + durationMinutes >= 1440,
      returnDepartMinutes, returnArriveMinutes: (returnDepartMinutes + durationMinutes) % 1440,
    });
    const mk = (key, mult, o) => ({
      id: key, airline, supplier: `${airline} (demo)`, demo: true,
      from, to: DESTINATIONS.find(x => x.id === destId).airport, depart, return: ret,
      farePerTraveler: Math.round(base * mult), typicalFarePerTraveler: Math.round(typical * mult),
      taxesPerTraveler: Math.round(base * mult * taxRate),
      ...o,
      ...times(o.departMinutes, o.returnDepartMinutes, o.durationMinutes),
    });
    const out = [
      mk('basic', 0.86, {
        name: 'Basic', stops: nonstop && km < 2000 ? 0 : 1, durationMinutes: Math.round((nonstop && km < 2000 ? hoursNonstop : hoursOneStop) * 60),
        departMinutes: 6 * 60 + 5, returnDepartMinutes: 5 * 60 + 50,
        carryOn: false, checkedBagIncluded: false, bagFeePerTraveler: usd(70), seatSelection: false,
        refundable: false, changeable: false, policy: 'Personal item only. No changes or refunds after 24 hours from booking.',
      }),
      mk('saver', 1, {
        name: 'Main', stops: 1, durationMinutes: Math.round(hoursOneStop * 60),
        departMinutes: 9 * 60 + 40, returnDepartMinutes: 12 * 60 + 15,
        carryOn: true, checkedBagIncluded: longHaul, bagFeePerTraveler: longHaul ? 0 : usd(70), seatSelection: true,
        refundable: false, changeable: true, policy: 'Carry-on included. Changes allowed for the fare difference; not refundable after 24 hours from booking.',
      }),
    ];
    if (nonstop) {
      out.push(mk('nonstop', 1.2, {
        name: 'Nonstop Flex', stops: 0, durationMinutes: Math.round(hoursNonstop * 60),
        departMinutes: 10 * 60 + 30, returnDepartMinutes: 16 * 60 + 40,
        carryOn: true, checkedBagIncluded: longHaul, bagFeePerTraveler: longHaul ? 0 : usd(70), seatSelection: true,
        refundable: true, changeable: true, freeCancelHours: 168, policy: 'Nonstop. Carry-on included. Refundable up to 7 days before departure.',
      }));
    }
    return out.map(o => ({ ...o, travelers }));
  }

  async book(offer) {
    return { status: 'confirmed', confirmation: `FL${(hash32(offer.id + offer.depart + Math.random()) % 900000 + 100000)}` };
  }
}

class MockHotels {
  constructor({ now, failureHook = false }) { this.kind = 'mock'; this.now = now; this.failureHook = failureHook; }
  search({ destId, checkIn, nights, rooms }) {
    const d = DESTINATIONS.find(x => x.id === destId);
    if (!d) return [];
    const season = seasonFactor(d, monthOf(checkIn));
    return d.hotels.map(([hid, name, stars, rating, nightly, flags, area, resortFee]) => {
      const features = Object.fromEntries(Object.entries(FEATURE).map(([k, v]) => [v, flags.includes(k)]));
      const net = usd(nightly * season * jitter(`ht:${hid}:${checkIn}`, 0.04));
      return {
        id: hid, name, stars, rating, ratingSource: 'demo supplier rating', area, features, demo: true,
        supplier: 'Demo hotel partner',
        netNightly: net, typicalNetNightly: usd(nightly), rooms, nights, checkIn, checkOut: addDays(checkIn, nights),
        taxPercent: d.hotelTax, resortFeePerNight: resortFee ? usd(resortFee) : 0,
        refundable: features.freeCancellation, freeCancelHours: features.freeCancellation ? 72 : 0,
        policy: features.freeCancellation ? 'Free cancellation until 72 hours before check-in.' : 'Non-refundable rate.',
      };
    });
  }
  // Demo failure hook: a lead traveler named "Failhotel" makes the hotel step fail, so the
  // partially-confirmed path can be exercised end to end in development and staging. Never in
  // production, where a traveler with that surname would otherwise see a booking fail.
  async book(h, { traveler } = {}) {
    if (this.failureHook && traveler && /^failhotel$/i.test(traveler.lastName)) throw new Error('demo hotel rejected the booking');
    return { status: 'confirmed', confirmation: `HT${(hash32(h.id + h.checkIn + Math.random()) % 900000 + 100000)}` };
  }
}

class MockActivities {
  constructor() { this.kind = 'mock'; }
  // `slot`, `months`, `weather` and `tags` come from the activity's optional sixth element (see the
  // demo data's header): `months` is null when the partner states no season (the operating days are
  // then not in our data, which is not the same as "all year"), `tags` always includes the kind.
  search({ destId }) {
    const d = DESTINATIONS.find(x => x.id === destId);
    if (!d) return [];
    return d.activities.map(([aid, name, price, hours, kind, extra = {}]) => ({
      id: aid, name, pricePerPerson: usd(price), commissionPercent: 15, hours, kind, demo: true,
      slot: extra.slot || 'day', months: Array.isArray(extra.months) && extra.months.length ? [...extra.months] : null,
      weather: !!extra.weather, tags: [...new Set([kind, ...(extra.tags || [])])],
      supplier: 'Demo activity partner', freeCancelHours: 24, policy: 'Free cancellation until 24 hours before the activity.',
    }));
  }
  async book(a) {
    return { status: 'confirmed', confirmation: `AC${(hash32(a.id + Math.random()) % 900000 + 100000)}` };
  }
}

// Free things worth doing, from the demo guide notes. Every answer carries its source and the date the
// notes were checked (the demo data's own fixed date, never today's: a page opened today has not
// re-checked anything), because the experience engine says "free" only with both; an item free only on
// some days carries its `condition`. A destination without notes gets null, which every caller reads as
// "no free data", never as "nothing free exists there".
class MockGuides {
  constructor({ now = () => new Date() } = {}) { this.kind = 'mock'; this.now = now; }
  freeThings({ destId }) {
    const d = DESTINATIONS.find(x => x.id === destId);
    if (!d || !Array.isArray(d.freeThings) || !d.freeThings.length) return null;
    return { source: 'Demo guide data (invented for this demo)', checkedAt: d.freeThingsCheckedAt || GUIDE_CHECKED_AT, items: d.freeThings.map(([name, kind, note, condition]) => ({ name, kind, note, ...(condition ? { condition: { ...condition } } : {}) })) };
  }
}

class MockTransfers {
  constructor() { this.kind = 'mock'; }
  quote({ destId, travelers }) {
    const d = DESTINATIONS.find(x => x.id === destId);
    if (!d) return null;
    const vehicles = Math.ceil(travelers / 4);
    return {
      id: `${destId}-transfer`, name: 'Private airport transfer, both ways', supplier: 'Demo transfer partner', demo: true,
      pricePerVehicleEachWay: usd(d.transfer), vehicles, commissionPercent: 12,
      freeCancelHours: 24, policy: 'Free cancellation until 24 hours before pickup.',
    };
  }
  async book() {
    return { status: 'confirmed', confirmation: `TR${(Math.floor(Math.random() * 900000) + 100000)}` };
  }
}

module.exports = { MockMaps, MockWeather, MockFlights, MockHotels, MockActivities, MockGuides, MockTransfers, haversineKm, seasonFactor, demoId: id };
