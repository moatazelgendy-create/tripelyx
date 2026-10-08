// DEMO DATA: fictional properties for Tripelyx Business previews (plan §F2). Not real hotels: names are
// checked against well-known hotel brands and none is used. Every rate, tax and term is demo data.
// STUB from Stage 0: BUSINESS_HOTELS is empty until Stage 1I fills it; BUSINESS_CITIES is FINAL.
//
// To fill: 29 properties, 3 in each Business city and 2 more in Cairo (which already has demo hotels),
// each city with a 3-star, a 4-star and a 5-star. Rates calibrated against policy/defaults.js Standard caps
// (taxes included): in each city one hotel under the cap, one straddling it (a cheap room under, a suite
// over) and one above. Mixed cancellation (non-refundable; free_days 1 to 3). Per-country vat_pct and
// city_tax_usd_per_night. Same raw shape as providers/mock/demo-data/hotels.js WITHOUT review_score and
// review_count:
//   { hotel_code, name, category, stars, area, city, country, blurb, amenities[], check_in, check_out,
//     vat_pct, city_tax_usd_per_night, cancel: { free_days, late_penalty_pct } | { nonrefundable: true },
//     scenes[], rooms: [{ code, name, sleeps, bed, size_m2, rate_usd, features[] }] }

/** The cities Business demo hotels cover: city and country exactly as the airport data names them. */
const BUSINESS_CITIES = Object.freeze([
  { iata: 'DXB', city: 'Dubai', country: 'United Arab Emirates' },
  { iata: 'LHR', city: 'London', country: 'United Kingdom' },
  { iata: 'CDG', city: 'Paris', country: 'France' },
  { iata: 'IST', city: 'Istanbul', country: 'Türkiye' },
  { iata: 'FCO', city: 'Rome', country: 'Italy' },
  { iata: 'MUC', city: 'Munich', country: 'Germany' },
  { iata: 'ATH', city: 'Athens', country: 'Greece' },
  { iata: 'JED', city: 'Jeddah', country: 'Saudi Arabia' },
  { iata: 'RUH', city: 'Riyadh', country: 'Saudi Arabia' },
  { iata: 'CAI', city: 'Cairo', country: 'Egypt' },
].map(c => Object.freeze(c)));

/** The raw demo hotels (see the header for the shape). @type {ReadonlyArray<object>} */
const BUSINESS_HOTELS = Object.freeze([]);

module.exports = { BUSINESS_HOTELS, BUSINESS_CITIES };
