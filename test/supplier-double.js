// A supplier double for the whole app (real-suppliers design §7.1 "End to end"): routes for test/supplier-fetch.js
// fakeFetch that answer the way Duffel and LiteAPI do, driven by a `state` the caller changes between steps (a fare's
// new price or terms, a fare gone, an outage). Used by test/business-suppliers-e2e.test.js and the R1-m
// screenshots. Not a test file itself (it doesn't match *.test.js). Nothing here reaches a supplier.
//
// The double answers from the fixtures in test/fixtures/suppliers (their README lists the documentation
// page each shape follows), reshaped per call the way the suppliers answer:
// - POST /air/offer_requests (D-ORQ, https://duffel.com/docs/api/v2/offer-requests/create-offer-request):
//   duffel/offer-request.cai-lhr.json for CAI to LHR, its times moved to the asked date, each offer's id made
//   unique to that answer and its expires_at set 30 minutes after the app's clock; no offers for any other route.
//   Every Duffel offer id and LiteAPI offerId remembers the company it was served to, and a GET or prebook by
//   another company is recorded (`crossed`, asserted empty).
// - GET /air/offers/{id} (D-OFF, https://duffel.com/docs/api/v2/offers/get-offer-by-id): the duffel/offer.get.json
//   envelope ({ data: offer }) around the offer last served under that id, with any change the test made (a new
//   total_amount, refunds no longer allowed: the two changes duffel/offer.get.price-changed.json and
//   offer.get.terms-changed.json show); an offer that is gone answers duffel/error.offer-no-longer-available.json
//   (D-ERR, https://duffel.com/docs/api/overview/errors, 422); an outage answers duffel/error.500.json.
// - POST /v3.0/hotels/rates (L-RATES, https://docs.liteapi.travel/reference/post_hotels-rates): the hotels of
//   liteapi/rates.cairo.json moved to London (their names, addresses and city), only the asked hotelIds when the
//   call names some, each roomTypes[].offerId made unique to the call; an outage answers liteapi/error.4291.json
//   (L-ERRW, https://docs.liteapi.travel/reference/api-errors-for-hotel-booking-workflow).
// - POST /v3.0/rates/prebook (L-PRE, https://docs.liteapi.travel/reference/post_rates-prebook): liteapi/prebook.json
//   for the room the offerId names, priced as the rates answer that served it.
// Live keys (go-live design §5.3, §8 row E; supplierDouble(clock, { live: true })): every Duffel answer says
// live_mode true and every LiteAPI rates answer sandbox false, as they do for live keys (D-ORQ, D-OFF, L-RATES);
// state.mode = 'test' makes them answer as test systems again (a mode mismatch). In live mode the double also
// answers the platform admin's live check: CAI to DXB (the CAI to LHR offers flown on to Dubai, the arrival
// times moved to Dubai's clock) and hotels in Dubai; the fixture airline's name is "Example Air", so no
// supplier name reaches a page; and a search in another cabin gets the same flights sold in that cabin (each
// segment's cabin_class and its marketing name), so the business cabin's results have fares too.
const { currentCompany } = require('../server/business/scope');

const OFFER_REQUESTS = 'https://api.duffel.com/air/offer_requests';
const OFFER_GET = /^https:\/\/api\.duffel\.com\/air\/offers\/[^/?]+$/;
const RATES = 'https://api.liteapi.travel/v3.0/hotels/rates';
const PREBOOK = 'https://book.liteapi.travel/v3.0/rates/prebook';

const DAY = 86400000;
const dayOf = date => Date.parse(`${date}T00:00:00Z`) / DAY;
/** 'YYYY-MM-DDTHH:MM:SS' moved by whole days (the airport-local times Duffel gives keep their wall time). */
const shiftLocal = (text, days) => (typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(text)
  ? new Date(Date.parse(`${text.slice(0, 19)}Z`) + days * DAY).toISOString().slice(0, 19) + text.slice(19)
  : text);
const LONDON = Object.freeze({
  lp1001: { name: 'Thames View Hotel', address: '12 Albert Embankment' },
  lp1002: { name: 'Garden Court Suites', address: '5 Kensington Gardens Square' },
  lp1003: { name: 'Downtown Inn', address: '20 Southampton Row' },
  lp1004: { name: 'Paddington Lodge', address: '3 Praed Street' },
});
const DUBAI = Object.freeze({
  lp1001: { name: 'Creek View Hotel', address: '12 Al Seef Road' },
  lp1002: { name: 'Garden Court Suites Dubai', address: '5 Al Wasl Road' },
  lp1003: { name: 'Downtown Inn Dubai', address: '20 Sheikh Zayed Road' },
  lp1004: { name: 'Marina Lodge', address: '3 Marina Walk' },
});
const CITIES = Object.freeze({
  London: { hotels: LONDON, country: 'gb', latitude: 51.5, longitude: -0.12 },
  Dubai: { hotels: DUBAI, country: 'ae', latitude: 25.2, longitude: 55.27 },
});
/** Dubai International, shaped as Duffel's airport objects (D-ORQ). */
const DXB = Object.freeze({
  type: 'airport', iata_code: 'DXB', iata_country_code: 'AE', name: 'Dubai International Airport', city_name: 'Dubai',
  time_zone: 'Asia/Dubai', latitude: 25.2532, longitude: 55.3657, id: 'arp_dxb_ae',
});
/** London is UTC+0 and Dubai UTC+4 in November: the same instant, 4 hours later on Dubai's clock. */
const LONDON_TO_DUBAI_HOURS = 4;
const shiftHours = (text, hours) => (typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(text)
  ? new Date(Date.parse(`${text.slice(0, 19)}Z`) + hours * 3600000).toISOString().slice(0, 19) + text.slice(19)
  : text);
/** An offer flown on to Dubai instead of London: every LHR arrival becomes DXB at the same instant. */
function toDubai(o) {
  for (const slice of o.slices) {
    if (slice.destination && slice.destination.iata_code === 'LHR') slice.destination = { ...DXB };
    for (const seg of slice.segments) {
      if (seg.destination && seg.destination.iata_code === 'LHR') {
        seg.destination = { ...DXB };
        seg.arriving_at = shiftHours(seg.arriving_at, LONDON_TO_DUBAI_HOURS);
      }
    }
  }
  return o;
}
/** Carrier objects named after the supplier's test airline get a plain example name (live mode). */
function renameCarriers(o) {
  const rename = c => { if (c && typeof c.name === 'string' && /duffel/i.test(c.name)) c.name = 'Example Air'; };
  rename(o.owner);
  for (const slice of o.slices) for (const seg of slice.segments) { rename(seg.marketing_carrier); rename(seg.operating_carrier); }
  return o;
}
/** The offer sold in another cabin: every segment's passengers fly in it (live mode). */
const CABIN_NAMES = Object.freeze({ premium_economy: 'Premium Economy', business: 'Business', first: 'First' });
function inCabin(o, cabin) {
  for (const slice of o.slices) {
    for (const seg of slice.segments) {
      for (const p of seg.passengers || []) {
        p.cabin_class = cabin;
        p.cabin_class_marketing_name = CABIN_NAMES[cabin] || p.cabin_class_marketing_name;
      }
    }
  }
  return o;
}
const fareKey = o => `${o.slices[0].segments.map(s => s.marketing_carrier.iata_code + s.marketing_carrier_flight_number).join('-')}|${o.slices[0].fare_brand_name}`;
const roomKey = (hotelId, rate) => `${hotelId}|${rate.name}`;
const addAmount = (text, cents) => (Math.round(Number(text) * 100 + cents) / 100).toFixed(2);

/**
 * The suppliers as the caller runs them: their answers follow `state`, which the caller changes between steps.
 * @param {{ now: () => Date }} clock the app's clock (offer expiries follow it)
 */
function supplierDouble(clock, { live = false } = {}) {
  const state = {
    mode: live ? 'live' : 'test', // how the answers say they were made: 'live' (live_mode true, sandbox false) or 'test'
    flights: 'up', // 'down': every Duffel call answers 500
    offerGet: 'up', // 'down': GET /air/offers answers 500 (searches still answer)
    hotels: 'up', // 'down': every LiteAPI call answers 4291 (HTTP 500)
    goneFlights: new Set(), // 'ZZ1234|Standard': a fare no longer offered
    fares: new Map(), // 'ZZ1234|Standard' → { addCents?, refund?: false }: what changed since the search
    rooms: new Map(), // 'lp1004|Twin Room' → { addCents }
  };
  const served = new Map(); // Duffel offer id → the offer as served (before any change)
  const rooms = new Map(); // LiteAPI offerId → { hotelId, rate, checkin, checkout }
  const owners = new Map(); // a Duffel offer id or LiteAPI offerId → the company it was served to
  const crossed = []; // a supplier id used by a company it was not served to
  let offerRequests = 0, ratesCalls = 0, prebooks = 0;
  let lastCity = 'London';
  const own = id => owners.set(id, currentCompany());
  const check = (id, what) => { if (owners.get(id) !== currentCompany()) crossed.push(`${what} ${id}`); };

  const isLive = () => state.mode === 'live';
  const changed = offer => {
    const o = structuredClone(offer);
    o.live_mode = isLive();
    const c = state.fares.get(fareKey(o));
    if (c && c.addCents) {
      o.total_amount = addAmount(o.total_amount, c.addCents);
      o.base_amount = addAmount(o.base_amount, c.addCents);
    }
    // The change duffel/offer.get.terms-changed.json shows: refunds are no longer allowed.
    if (c && c.refund === false) o.conditions.refund_before_departure = { allowed: false, penalty_amount: null, penalty_currency: null };
    return o;
  };

  function offerRequest(body, call) {
    const asked = call.body.data.slices[0];
    body.data.cabin_class = call.body.data.cabin_class;
    body.data.live_mode = isLive();
    offerRequests += 1;
    const n = offerRequests;
    const dubai = live && asked.destination === 'DXB';
    if (asked.origin !== 'CAI' || (asked.destination !== 'LHR' && !dubai)) { body.data.offers = []; return body; }
    if (dubai) body.data.slices = body.data.slices.map(sl => ({ ...sl, destination: { ...DXB } }));
    const days = dayOf(asked.departure_date) - dayOf('2026-11-12');
    const expires = new Date(clock.now().getTime() + 30 * 60000).toISOString();
    body.data.offers = body.data.offers.map(raw => {
      const o = structuredClone(raw);
      // Unique to this answer (Duffel's offer ids are), so a check that used another company's id would show.
      o.id = `off_${asked.departure_date.replace(/-/g, '')}R${n}${raw.id.slice('off_0000AAAA'.length)}`;
      o.expires_at = expires;
      if (dubai) toDubai(o);
      if (live) renameCarriers(o);
      if (live && call.body.data.cabin_class !== 'economy') inCabin(o, call.body.data.cabin_class);
      for (const slice of o.slices) {
        for (const seg of slice.segments) {
          seg.departing_at = shiftLocal(seg.departing_at, days);
          seg.arriving_at = shiftLocal(seg.arriving_at, days);
          for (const stop of seg.stops || []) {
            stop.departing_at = shiftLocal(stop.departing_at, days);
            stop.arriving_at = shiftLocal(stop.arriving_at, days);
          }
        }
      }
      served.set(o.id, o);
      own(o.id);
      return o;
    }).filter(o => !state.goneFlights.has(fareKey(o))).map(changed);
    return body;
  }

  function rates(body, call) {
    ratesCalls += 1;
    const n = ratesCalls;
    body.sandbox = !isLive();
    const only = Array.isArray(call.body.hotelIds) ? new Set(call.body.hotelIds) : null;
    // A call by hotel id names no city: the hotels stay in the city they were last served in.
    const cityName = only ? lastCity : call.body.cityName;
    const city = cityName === 'London' || (live && cityName === 'Dubai') ? CITIES[cityName] : null;
    if (!city) { body.data = []; body.hotels = []; return body; }
    lastCity = cityName;
    body.hotels = body.hotels.filter(h => !only || only.has(h.id)).map(h => ({
      ...h, ...(city.hotels[h.id] || {}), city_name: cityName, country_code: city.country, latitude: city.latitude, longitude: city.longitude,
    }));
    body.data = body.data.filter(d => !only || only.has(d.hotelId)).map(d => ({
      ...d,
      roomTypes: d.roomTypes.map(rt => {
        const offerId = `${rt.offerId}_c${n}`;
        const rate = structuredClone(rt.rates[0]);
        const c = state.rooms.get(roomKey(d.hotelId, rate));
        if (c && c.addCents) {
          for (const list of [rate.retailRate.total, rate.retailRate.initialPrice]) list[0].amount = Math.round(list[0].amount * 100 + c.addCents) / 100;
        }
        rooms.set(offerId, { hotelId: d.hotelId, rate, checkin: call.body.checkin, checkout: call.body.checkout });
        own(offerId);
        return { ...rt, offerId, roomTypeId: `rt_${offerId}`, rates: [rate], offerRetailRate: rate.retailRate.total, offerInitialPrice: rate.retailRate.initialPrice };
      }),
    }));
    return body;
  }

  function prebook(body, call) {
    prebooks += 1;
    check(call.body.offerId, 'prebook');
    const room = rooms.get(call.body.offerId);
    Object.assign(body.data, {
      prebookId: `pb_PLACEHOLDER${String(prebooks).padStart(4, '0')}`,
      offerId: call.body.offerId, hotelId: room.hotelId, checkin: room.checkin, checkout: room.checkout,
      roomTypes: [{ rates: [structuredClone(room.rate)] }], price: room.rate.retailRate.total[0].amount,
    });
    return body;
  }

  const routes = [
    {
      method: 'POST', url: OFFER_REQUESTS,
      reply: () => (state.flights === 'down' ? 'duffel/error.500.json' : { fixture: 'duffel/offer-request.cai-lhr.json', transform: offerRequest }),
    },
    {
      method: 'GET', url: OFFER_GET,
      reply: call => {
        if (state.flights === 'down' || state.offerGet === 'down') return 'duffel/error.500.json';
        const id = call.url.split('/').pop();
        check(id, 'GET');
        const offer = served.get(id);
        if (!offer || state.goneFlights.has(fareKey(offer))) return 'duffel/error.offer-no-longer-available.json';
        return { fixture: 'duffel/offer.get.json', transform: () => ({ data: changed(offer) }) };
      },
    },
    {
      method: 'POST', url: RATES,
      reply: () => (state.hotels === 'down' ? 'liteapi/error.4291.json' : { fixture: 'liteapi/rates.cairo.json', transform: rates }),
    },
    {
      method: 'POST', url: PREBOOK,
      reply: call => (state.hotels === 'down' ? 'liteapi/error.4291.json' : rooms.has(call.body.offerId) ? { fixture: 'liteapi/prebook.json', transform: prebook } : 'liteapi/prebook.2001.json'),
    },
  ];
  return { state, routes, crossed };
}

/** What the suppliers were asked, in order: 'offer_request', 'offer_get', 'rates', 'rates_hotel', 'prebook'. */
function opsOf(calls) {
  return calls.map(c => {
    if (c.url.startsWith(OFFER_REQUESTS)) return 'offer_request';
    if (OFFER_GET.test(c.url)) return 'offer_get';
    if (c.url.startsWith(RATES)) return Array.isArray(c.body && c.body.hotelIds) ? 'rates_hotel' : 'rates';
    if (c.url.startsWith(PREBOOK)) return 'prebook';
    return `other ${c.method} ${c.url}`;
  });
}

module.exports = { supplierDouble, opsOf, OFFER_REQUESTS, OFFER_GET, RATES, PREBOOK, LONDON, DUBAI };
