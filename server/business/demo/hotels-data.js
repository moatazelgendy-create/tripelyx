// DEMO DATA: fictional properties for Tripelyx Business previews (plan §F2). Not real hotels: names are
// invented and checked against well-known hotel brands, and none is used. Area names are real only so a
// search reads naturally. Every rate, tax and term is demo data, and nothing here is a rating, a review,
// a count of rooms left or a claim about availability (the demo provider decides availability itself).
//
// 29 properties: 3 in each of the 9 cities other than Cairo (a 3-star, a 4-star and a 5-star), and 2 in
// Cairo (a 3-star and a 4-star: Cairo already has the Alamein Go demo data's CA-NILE, 5-star), so each of
// the 10 cities has a 3-star, a 4-star and a 5-star. Rates are calibrated against the Standard caps in
// policy/defaults.js (taxes included, per night): in each city the 3-star is under the cap in every room,
// the 4-star straddles it (its cheaper rooms are under, its suite is over) and the 5-star is over it in
// every room (in Cairo, CA-NILE is the one above). test/business-inventory.test.js checks this.
// Cancellation terms are mixed (non-refundable, or free until 1 to 3 days before). VAT and city tax are per
// country (COUNTRY_TAXES), demo figures too.
//
// Same raw shape as providers/mock/demo-data/hotels.js WITHOUT review_score and review_count:
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

/** Demo VAT (percent) and city tax (USD a night) per country. Egypt matches the Alamein Go data's CA-NILE. */
const COUNTRY_TAXES = Object.freeze({
  'United Arab Emirates': Object.freeze({ vat: 5, cityTax: 4 }),
  'United Kingdom': Object.freeze({ vat: 20, cityTax: 0 }),
  France: Object.freeze({ vat: 10, cityTax: 3 }),
  'Türkiye': Object.freeze({ vat: 10, cityTax: 2 }),
  Italy: Object.freeze({ vat: 10, cityTax: 5 }),
  Germany: Object.freeze({ vat: 7, cityTax: 0 }),
  Greece: Object.freeze({ vat: 13, cityTax: 2 }),
  'Saudi Arabia': Object.freeze({ vat: 15, cityTax: 0 }),
  Egypt: Object.freeze({ vat: 14, cityTax: 3 }),
});

const NONREFUNDABLE = { nonrefundable: true };
const free = (days, latePenaltyPct) => ({ free_days: days, late_penalty_pct: latePenaltyPct });
const room = (code, name, sleeps, bed, size, rate, features = []) => ({ code, name, sleeps, bed, size_m2: size, rate_usd: rate, features });

/** One raw hotel; VAT and city tax come from its country. */
function hotel(code, { name, category = 'Hotel', stars, area, city, country, blurb, amenities, checkIn = '15:00', checkOut = '12:00', cancel, rooms }) {
  const tax = COUNTRY_TAXES[country];
  return {
    hotel_code: code, name, category, stars, area, city, country, blurb, amenities,
    check_in: checkIn, check_out: checkOut, vat_pct: tax.vat, city_tax_usd_per_night: tax.cityTax,
    cancel, scenes: ['city', 'room', 'pool'], rooms,
  };
}

const RAW = [
  // Dubai: Standard cap $240 a night with taxes (VAT 5%, $4 city tax).
  hotel('DX-SPICE', {
    name: 'Spice Lane Rooms', category: 'Business hotel', stars: 3, area: 'Deira', city: 'Dubai', country: 'United Arab Emirates',
    blurb: 'Simple, quiet rooms a short walk from the creek and the metro, with a breakfast room and a desk in every room.',
    amenities: ['Free Wi-Fi', 'Work desk', 'Breakfast available', 'Air conditioning', 'Metro nearby'],
    cancel: NONREFUNDABLE,
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 20, 115), room('SUP-TWN', 'Superior Twin', 2, '2 single beds', 24, 140)],
  }),
  hotel('DX-CANAL', {
    name: 'Canal Terrace Hotel', stars: 4, area: 'Business Bay', city: 'Dubai', country: 'United Arab Emirates',
    blurb: 'A mid-rise hotel on the canal walk, with meeting rooms on the first floor and a rooftop pool.',
    amenities: ['Free Wi-Fi', 'Meeting rooms', 'Rooftop pool', 'Gym', 'Restaurant', 'Air conditioning'],
    cancel: free(2, 100),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 32, 175, ['Work desk']),
      room('DLX-CNL', 'Deluxe Canal View', 2, '1 king bed', 34, 205, ['Canal view']),
      room('STE-TER', 'Terrace Suite', 3, '1 king bed + sofa bed', 60, 265, ['Terrace', 'Living room']),
    ],
  }),
  hotel('DX-PEARL', {
    name: 'Pearl Dune Grand', stars: 5, area: 'Dubai Marina', city: 'Dubai', country: 'United Arab Emirates',
    blurb: 'A tall glass hotel over the marina promenade, with a spa, a club lounge and several restaurants.',
    amenities: ['Marina view', 'Spa', 'Pool', 'Club lounge', 'Gym', 'Free Wi-Fi', 'Valet parking'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-MAR', 'Deluxe Marina View', 2, '1 king bed', 40, 290, ['Marina view']),
      room('CLB-KNG', 'Club King', 2, '1 king bed', 44, 360, ['Lounge access']),
      room('STE-MAR', 'Marina Suite', 3, '1 king bed + sofa bed', 85, 520, ['Living room', 'Lounge access']),
    ],
  }),

  // London: Standard cap $300 a night with taxes (VAT 20%, no city tax).
  hotel('LN-LARKSPUR', {
    name: 'Larkspur Row Rooms', category: 'Business hotel', stars: 3, area: 'Paddington', city: 'London', country: 'United Kingdom',
    blurb: 'Compact rooms in a converted terrace near the station, with a lounge for working between meetings.',
    amenities: ['Free Wi-Fi', 'Work lounge', 'Breakfast available', 'Station nearby'],
    checkIn: '14:00', checkOut: '11:00', cancel: free(1, 100),
    rooms: [room('CMP-DBL', 'Compact Double', 2, '1 double bed', 14, 135), room('STD-TWN', 'Standard Twin', 2, '2 single beds', 18, 165)],
  }),
  hotel('LN-KESTREL', {
    name: 'Kestrel Yard Hotel', stars: 4, area: 'Southwark', city: 'London', country: 'United Kingdom',
    blurb: 'A brick warehouse turned hotel near the river, with a courtyard bar and bookable meeting rooms.',
    amenities: ['Free Wi-Fi', 'Meeting rooms', 'Gym', 'Restaurant', 'Courtyard bar'],
    cancel: free(2, 100),
    rooms: [
      room('DLX-DBL', 'Deluxe Double', 2, '1 queen bed', 24, 215, ['Work desk']),
      room('DLX-RIV', 'Deluxe River View', 2, '1 king bed', 26, 240, ['River view']),
      room('STE-YRD', 'Yard Suite', 3, '1 king bed + sofa bed', 48, 330, ['Living room']),
    ],
  }),
  hotel('LN-ALDERMOOR', {
    name: 'Aldermoor House', stars: 5, area: 'Mayfair', city: 'London', country: 'United Kingdom',
    blurb: 'A townhouse hotel on a quiet square, with a spa in the basement and a dining room open all day.',
    amenities: ['Spa', 'Restaurant', 'Gym', 'Free Wi-Fi', 'Room service', 'Concierge'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 32, 345),
      room('JST-SQR', 'Junior Suite', 3, '1 king bed + sofa bed', 45, 460, ['Square view']),
      room('STE-ALD', 'Aldermoor Suite', 3, '1 king bed + sofa bed', 80, 690, ['Living room', 'Dining table']),
    ],
  }),

  // Paris: Standard cap $280 a night with taxes (VAT 10%, $3 city tax).
  hotel('PA-TILLEUL', {
    name: 'Rue des Tilleuls Rooms', category: 'Boutique hotel', stars: 3, area: 'Canal Saint-Martin', city: 'Paris', country: 'France',
    blurb: 'A small hotel on a tree-lined street by the canal, with a café on the ground floor.',
    amenities: ['Free Wi-Fi', 'Café', 'Breakfast available', 'Lift'],
    checkIn: '14:00', checkOut: '11:00', cancel: NONREFUNDABLE,
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 15, 125), room('SUP-DBL', 'Superior Double', 2, '1 queen bed', 19, 155, ['Courtyard view'])],
  }),
  hotel('PA-VERMEIL', {
    name: 'Quai Vermeil Hotel', stars: 4, area: 'Saint-Germain', city: 'Paris', country: 'France',
    blurb: 'A classic stone building near the river, with a library lounge and a meeting room for small groups.',
    amenities: ['Free Wi-Fi', 'Library lounge', 'Meeting room', 'Bar', 'Air conditioning'],
    cancel: free(2, 50),
    rooms: [
      room('DLX-DBL', 'Deluxe Double', 2, '1 queen bed', 22, 210),
      room('DLX-BAL', 'Deluxe Balcony', 2, '1 king bed', 24, 235, ['Balcony']),
      room('STE-VER', 'Vermeil Suite', 3, '1 king bed + sofa bed', 42, 300, ['Living room']),
    ],
  }),
  hotel('PA-ORANGER', {
    name: 'Grand Oranger Paris', stars: 5, area: 'Champs-Élysées', city: 'Paris', country: 'France',
    blurb: 'A grand hotel set around a glass-roofed winter garden, with a spa and a restaurant on the terrace.',
    amenities: ['Spa', 'Pool', 'Restaurant', 'Gym', 'Free Wi-Fi', 'Concierge', 'Room service'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 35, 320),
      room('JST-GDN', 'Junior Suite', 3, '1 king bed + sofa bed', 48, 420, ['Garden view']),
      room('STE-ORA', 'Oranger Suite', 4, '1 king bed + sofa bed', 90, 610, ['Living room', 'Terrace']),
    ],
  }),

  // Istanbul: Standard cap $180 a night with taxes (VAT 10%, $2 city tax).
  hotel('IS-LALE', {
    name: 'Lale Courtyard Rooms', category: 'Boutique hotel', stars: 3, area: 'Sultanahmet', city: 'Istanbul', country: 'Türkiye',
    blurb: 'An old wooden house around a small courtyard, a few streets from the tram line.',
    amenities: ['Free Wi-Fi', 'Courtyard', 'Breakfast available', 'Air conditioning'],
    checkIn: '14:00', checkOut: '11:00', cancel: free(1, 100),
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 16, 70), room('SUP-TWN', 'Superior Twin', 2, '2 single beds', 20, 90)],
  }),
  hotel('IS-FERRY', {
    name: 'Bosphorus Ferry House', stars: 4, area: 'Karaköy', city: 'Istanbul', country: 'Türkiye',
    blurb: 'A converted shipping office by the ferry piers, with a rooftop terrace over the water.',
    amenities: ['Free Wi-Fi', 'Rooftop terrace', 'Restaurant', 'Gym', 'Meeting room'],
    cancel: NONREFUNDABLE,
    rooms: [
      room('DLX-DBL', 'Deluxe Double', 2, '1 queen bed', 24, 130),
      room('DLX-SEA', 'Deluxe Sea View', 2, '1 king bed', 26, 150, ['Sea view']),
      room('STE-PIR', 'Pier Suite', 3, '1 king bed + sofa bed', 45, 195, ['Sea view', 'Living room']),
    ],
  }),
  hotel('IS-LANTERN', {
    name: 'Galata Lantern Grand', stars: 5, area: 'Beyoğlu', city: 'Istanbul', country: 'Türkiye',
    blurb: 'A large hotel on the hill above the Golden Horn, with a hammam, an indoor pool and a top-floor restaurant.',
    amenities: ['Hammam', 'Indoor pool', 'Spa', 'Restaurant', 'Gym', 'Free Wi-Fi'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 34, 200),
      room('JST-HRN', 'Junior Suite', 3, '1 king bed + sofa bed', 46, 260, ['Golden Horn view']),
      room('STE-GAL', 'Galata Suite', 4, '1 king bed + sofa bed', 80, 380, ['Living room']),
    ],
  }),

  // Rome: Standard cap $220 a night with taxes (VAT 10%, $5 city tax).
  hotel('RM-FONTANELLA', {
    name: 'Fontanella Rooms', category: 'Boutique hotel', stars: 3, area: 'Trastevere', city: 'Rome', country: 'Italy',
    blurb: 'Rooms above a quiet lane of trattorias, with a shared roof terrace.',
    amenities: ['Free Wi-Fi', 'Roof terrace', 'Breakfast available', 'Air conditioning'],
    checkIn: '14:00', checkOut: '11:00', cancel: NONREFUNDABLE,
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 16, 105), room('SUP-DBL', 'Superior Double', 2, '1 queen bed', 20, 130)],
  }),
  hotel('RM-PINI', {
    name: 'Via dei Pini Hotel', stars: 4, area: 'Monti', city: 'Rome', country: 'Italy',
    blurb: 'A restored palazzo on a sloping street, with a garden bar and a small meeting room.',
    amenities: ['Free Wi-Fi', 'Garden bar', 'Meeting room', 'Gym', 'Air conditioning'],
    cancel: free(2, 100),
    rooms: [
      room('DLX-DBL', 'Deluxe Double', 2, '1 queen bed', 22, 170),
      room('DLX-TER', 'Deluxe Terrace', 2, '1 king bed', 25, 185, ['Terrace']),
      room('STE-PIN', 'Pini Suite', 3, '1 king bed + sofa bed', 44, 240, ['Living room']),
    ],
  }),
  hotel('RM-AURELIANO', {
    name: 'Palazzo Aureliano', stars: 5, area: 'Piazza di Spagna', city: 'Rome', country: 'Italy',
    blurb: 'A grand palazzo near the Spanish Steps, with frescoed halls, a spa and a rooftop restaurant.',
    amenities: ['Spa', 'Rooftop restaurant', 'Gym', 'Free Wi-Fi', 'Concierge', 'Room service'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 32, 255),
      room('JST-CTY', 'Junior Suite', 3, '1 king bed + sofa bed', 45, 330, ['City view']),
      room('STE-AUR', 'Aureliano Suite', 4, '1 king bed + sofa bed', 85, 480, ['Living room', 'Terrace']),
    ],
  }),

  // Munich: Standard cap $220 a night with taxes (VAT 7%, no city tax).
  hotel('MU-KASTANIE', {
    name: 'Kastanie Lane Rooms', category: 'Business hotel', stars: 3, area: 'Maxvorstadt', city: 'Munich', country: 'Germany',
    blurb: 'Plain, bright rooms near the university and the U-Bahn, with a breakfast room and bike storage.',
    amenities: ['Free Wi-Fi', 'Breakfast available', 'Bike storage', 'Lift'],
    checkIn: '14:00', checkOut: '11:00', cancel: free(1, 100),
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 18, 100), room('SUP-TWN', 'Superior Twin', 2, '2 single beds', 22, 120)],
  }),
  hotel('MU-ISARWIESE', {
    name: 'Isar Meadow Hotel', stars: 4, area: 'Haidhausen', city: 'Munich', country: 'Germany',
    blurb: 'A modern hotel near the river meadows, with a sauna, a restaurant and meeting rooms.',
    amenities: ['Free Wi-Fi', 'Sauna', 'Restaurant', 'Meeting rooms', 'Gym'],
    cancel: free(2, 50),
    rooms: [
      room('DLX-DBL', 'Deluxe Double', 2, '1 queen bed', 24, 175),
      room('DLX-PRK', 'Deluxe Park View', 2, '1 king bed', 26, 190, ['Park view']),
      room('STE-ISR', 'Isar Suite', 3, '1 king bed + sofa bed', 46, 240, ['Living room']),
    ],
  }),
  hotel('MU-SILBERFICHTE', {
    name: 'Silberfichte Grand', stars: 5, area: 'Altstadt', city: 'Munich', country: 'Germany',
    blurb: 'A large hotel in the old town, with a spa floor, an indoor pool and a wood-panelled restaurant.',
    amenities: ['Spa', 'Indoor pool', 'Restaurant', 'Gym', 'Free Wi-Fi', 'Concierge'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 34, 265),
      room('JST-OLD', 'Junior Suite', 3, '1 king bed + sofa bed', 46, 340, ['Old town view']),
      room('STE-SLB', 'Silberfichte Suite', 4, '1 king bed + sofa bed', 85, 500, ['Living room']),
    ],
  }),

  // Athens: Greece's Standard cap $170 a night with taxes (no city cap; VAT 13%, $2 city tax).
  hotel('AT-ELIA', {
    name: 'Elia Steps Rooms', category: 'Boutique hotel', stars: 3, area: 'Plaka', city: 'Athens', country: 'Greece',
    blurb: 'A small hotel on a stepped lane below the old town, with a breakfast terrace.',
    amenities: ['Free Wi-Fi', 'Breakfast terrace', 'Air conditioning', 'Lift'],
    checkIn: '14:00', checkOut: '11:00', cancel: NONREFUNDABLE,
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 16, 78), room('SUP-DBL', 'Superior Double', 2, '1 queen bed', 20, 95, ['Balcony'])],
  }),
  hotel('AT-THYME', {
    name: 'Thyme Hill Hotel', stars: 4, area: 'Kolonaki', city: 'Athens', country: 'Greece',
    blurb: 'A calm hotel on the slope of the hill, with a rooftop pool and a meeting room.',
    amenities: ['Free Wi-Fi', 'Rooftop pool', 'Meeting room', 'Bar', 'Air conditioning'],
    cancel: free(1, 100),
    rooms: [
      room('DLX-DBL', 'Deluxe Double', 2, '1 queen bed', 22, 125),
      room('DLX-HIL', 'Deluxe Hill View', 2, '1 king bed', 24, 140, ['Hill view']),
      room('STE-THY', 'Thyme Suite', 3, '1 king bed + sofa bed', 42, 180, ['Living room', 'Balcony']),
    ],
  }),
  hotel('AT-MARBLEWIND', {
    name: 'Marble Wind Grand', stars: 5, area: 'Syntagma', city: 'Athens', country: 'Greece',
    blurb: 'A large hotel on the main square, with a spa, an outdoor pool and a restaurant on the top floor.',
    amenities: ['Spa', 'Outdoor pool', 'Restaurant', 'Gym', 'Free Wi-Fi', 'Concierge'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 32, 205),
      room('JST-SQR', 'Junior Suite', 3, '1 king bed + sofa bed', 44, 270, ['Square view']),
      room('STE-MRB', 'Marble Suite', 4, '1 king bed + sofa bed', 80, 390, ['Living room']),
    ],
  }),

  // Jeddah: Saudi Arabia's Standard cap $200 a night with taxes (no city cap; VAT 15%, no city tax).
  hotel('JD-CORALGATE', {
    name: 'Coral Gate Rooms', category: 'Business hotel', stars: 3, area: 'Al Balad', city: 'Jeddah', country: 'Saudi Arabia',
    blurb: 'Simple rooms at the edge of the old town, with a breakfast room and a quiet lounge.',
    amenities: ['Free Wi-Fi', 'Breakfast available', 'Lounge', 'Air conditioning'],
    checkIn: '14:00', checkOut: '12:00', cancel: free(1, 100),
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 20, 88), room('SUP-TWN', 'Superior Twin', 2, '2 single beds', 24, 110)],
  }),
  hotel('JD-REDSEA', {
    name: 'Red Sea Lantern Hotel', stars: 4, area: 'Corniche', city: 'Jeddah', country: 'Saudi Arabia',
    blurb: 'A seafront hotel on the corniche, with a pool deck, meeting rooms and a seafood restaurant.',
    amenities: ['Free Wi-Fi', 'Pool', 'Meeting rooms', 'Restaurant', 'Gym'],
    cancel: free(2, 100),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 30, 145),
      room('DLX-SEA', 'Deluxe Sea View', 2, '1 king bed', 32, 160, ['Sea view']),
      room('STE-COR', 'Corniche Suite', 3, '1 king bed + sofa bed', 55, 205, ['Sea view', 'Living room']),
    ],
  }),
  hotel('JD-OBHUR', {
    name: 'Obhur Tide Grand', stars: 5, area: 'Obhur', city: 'Jeddah', country: 'Saudi Arabia',
    blurb: 'A resort hotel on the creek north of the city, with a private beach, a spa and a marina.',
    amenities: ['Private beach', 'Spa', 'Pool', 'Marina', 'Restaurant', 'Free Wi-Fi'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-CRK', 'Deluxe Creek View', 2, '1 king bed', 40, 235, ['Creek view']),
      room('JST-SEA', 'Junior Suite', 3, '1 king bed + sofa bed', 55, 300, ['Sea view']),
      room('STE-OBH', 'Obhur Suite', 4, '1 king bed + sofa bed', 95, 430, ['Living room', 'Terrace']),
    ],
  }),

  // Riyadh: Standard cap $220 a night with taxes (VAT 15%, no city tax).
  hotel('RY-NAJDARCH', {
    name: 'Najd Arch Rooms', category: 'Business hotel', stars: 3, area: 'Al Malaz', city: 'Riyadh', country: 'Saudi Arabia',
    blurb: 'A practical hotel with large desks, a breakfast room and parking, near the main ring road.',
    amenities: ['Free Wi-Fi', 'Work desk', 'Breakfast available', 'Parking'],
    checkIn: '14:00', checkOut: '12:00', cancel: NONREFUNDABLE,
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 22, 92), room('SUP-TWN', 'Superior Twin', 2, '2 single beds', 26, 115)],
  }),
  hotel('RY-ACACIA', {
    name: 'Acacia Court Hotel', stars: 4, area: 'Olaya', city: 'Riyadh', country: 'Saudi Arabia',
    blurb: 'A business hotel on the main avenue, with meeting rooms, a pool and an all-day restaurant.',
    amenities: ['Free Wi-Fi', 'Meeting rooms', 'Pool', 'Restaurant', 'Gym', 'Parking'],
    cancel: free(2, 50),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 32, 160),
      room('CLB-KNG', 'Club King', 2, '1 king bed', 34, 175, ['Lounge access']),
      room('STE-ACA', 'Acacia Suite', 3, '1 king bed + sofa bed', 60, 225, ['Living room']),
    ],
  }),
  hotel('RY-MUDBRICK', {
    name: 'Mudbrick Palms Grand', stars: 5, area: 'King Abdullah Financial District', city: 'Riyadh', country: 'Saudi Arabia',
    blurb: 'A tall hotel among the office towers, with a spa, an indoor pool and a club lounge.',
    amenities: ['Spa', 'Indoor pool', 'Club lounge', 'Restaurant', 'Gym', 'Free Wi-Fi', 'Valet parking'],
    cancel: free(3, 50),
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 40, 255),
      room('JST-TWR', 'Junior Suite', 3, '1 king bed + sofa bed', 55, 330, ['Tower view']),
      room('STE-MUD', 'Mudbrick Suite', 4, '1 king bed + sofa bed', 95, 470, ['Living room']),
    ],
  }),

  // Cairo: Standard cap $160 a night with taxes (VAT 14%, $3 city tax). The Alamein Go data's CA-NILE
  // (5-star) is over it in every room, so only the 3-star and the 4-star are new.
  hotel('CA-ZAMALEK', {
    name: 'Zamalek Garden Rooms', category: 'Boutique hotel', stars: 3, area: 'Zamalek', city: 'Cairo', country: 'Egypt',
    blurb: 'A small hotel in a leafy street on the island, with a garden café.',
    amenities: ['Free Wi-Fi', 'Garden café', 'Breakfast available', 'Air conditioning'],
    checkIn: '14:00', checkOut: '12:00', cancel: free(1, 100),
    rooms: [room('STD-DBL', 'Standard Double', 2, '1 double bed', 20, 68), room('SUP-DBL', 'Superior Double', 2, '1 queen bed', 24, 85, ['Garden view'])],
  }),
  hotel('CA-DOKKI', {
    name: 'Dokki Riverside Hotel', stars: 4, area: 'Dokki', city: 'Cairo', country: 'Egypt',
    blurb: 'A modern hotel on the west bank of the river, with meeting rooms and a pool terrace.',
    amenities: ['Free Wi-Fi', 'Meeting rooms', 'Pool', 'Restaurant', 'Gym'],
    cancel: NONREFUNDABLE,
    rooms: [
      room('DLX-KNG', 'Deluxe King', 2, '1 king bed', 30, 115),
      room('DLX-NIL', 'Deluxe Nile View', 2, '1 king bed', 32, 125, ['Nile view']),
      room('STE-DOK', 'Riverside Suite', 3, '1 king bed + sofa bed', 55, 160, ['Nile view', 'Living room']),
    ],
  }),
];

/** Deep-freeze plain data. */
function freeze(x) {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) freeze(v);
    Object.freeze(x);
  }
  return x;
}

/** The raw demo hotels (see the header for the shape). @type {ReadonlyArray<object>} */
const BUSINESS_HOTELS = freeze(RAW);

module.exports = { BUSINESS_HOTELS, BUSINESS_CITIES };
