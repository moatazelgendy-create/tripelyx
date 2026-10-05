// DEMO DATA — fictional yachts and charter operators (see README.md). Rates in USD major units.
module.exports = {
  durations: {
    half_day: { label: 'Half day (4 hours)', hours: 4, start: '10:00' },
    full_day: { label: 'Full day (8 hours)', hours: 8, start: '09:30' },
    sunset: { label: 'Sunset cruise (2.5 hours)', hours: 2.5, start: '17:30' },
  },
  yachts: [
    {
      code: 'SB42', name: 'Sea Breeze 42', type: 'Sailing yacht', length_m: 12.8, capacity: 10, cabins: 3, crew: 2,
      marina: 'New Alamein Marina', operator: 'Blue Horizon Charters', review_score: 4.8, review_count: 64,
      rates_usd: { half_day: 520, full_day: 890, sunset: 380 },
      inclusions: ['Skipper and deckhand', 'Fuel for the standard route', 'Soft drinks and water', 'Snorkelling gear'],
      scene: 'yacht-sail',
    },
    {
      code: 'AS60', name: 'Azure Spirit 60', type: 'Motor yacht', length_m: 18.3, capacity: 14, cabins: 3, crew: 3,
      marina: 'New Alamein Marina', operator: 'Blue Horizon Charters', review_score: 4.9, review_count: 41,
      rates_usd: { half_day: 1350, full_day: 2300, sunset: 980 },
      inclusions: ['Captain and two crew', 'Fuel for the standard route', 'Fruit platter and soft drinks', 'Paddle boards'],
      scene: 'yacht-motor',
    },
    {
      code: 'BL45', name: 'Blue Lagoon 45', type: 'Catamaran', length_m: 13.9, capacity: 20, cabins: 4, crew: 2,
      marina: 'Marassi Marina', operator: 'Marassi Sea Club', review_score: 4.7, review_count: 120,
      rates_usd: { half_day: 760, full_day: 1290, sunset: 540 },
      inclusions: ['Skipper and host', 'Fuel', 'Soft drinks and snacks', 'Snorkelling gear', 'Bluetooth sound system'],
      scene: 'yacht-cat',
    },
    {
      code: 'PR75', name: 'Poseidon Royale 75', type: 'Superyacht', length_m: 23.0, capacity: 24, cabins: 4, crew: 5,
      marina: 'Marassi Marina', operator: 'Marassi Sea Club', review_score: 5.0, review_count: 18,
      rates_usd: { half_day: 3200, full_day: 5600, sunset: 2400 },
      inclusions: ['Captain, chef and three crew', 'Fuel', 'Chef-prepared lunch', 'Jet ski and water toys'],
      scene: 'yacht-motor',
    },
    {
      code: 'SF34', name: 'Salt & Foam 34', type: 'Speedboat', length_m: 10.4, capacity: 8, cabins: 1, crew: 1,
      marina: 'Porto Marina', operator: 'Porto Watersports', review_score: 4.5, review_count: 207,
      rates_usd: { half_day: 340, full_day: 590, sunset: 260 },
      inclusions: ['Skipper', 'Fuel', 'Water', 'Snorkelling gear'],
      scene: 'yacht-speed',
    },
  ],
  packages: [
    { code: 'STD', name: 'Standard charter', add_usd: 0, per_guest: false, features: ['Everything in the yacht\'s inclusions'] },
    { code: 'LUNCH', name: 'Charter + seafood lunch', add_usd: 35, per_guest: true, features: ['Freshly grilled seafood lunch on board'] },
    { code: 'TOYS', name: 'Charter + water toys', add_usd: 180, per_guest: false, features: ['Inflatable slide, towable ring and extra paddle boards'] },
  ],
  vat_pct: 14,
  marina_fee_usd: 40,
  cancel: { free_days: 7, late_penalty_pct: 50 },
};
