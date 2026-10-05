// DEMO DATA — fictional transfer operators (see README.md). Place coordinates are approximate.
module.exports = {
  places: [
    { name: 'El Alamein Airport (DBB)', lat: 30.9245, lng: 28.4614, airport: true },
    { name: 'Cairo Airport (CAI)', lat: 30.1219, lng: 31.4056, airport: true },
    { name: 'Alexandria Borg El Arab Airport (HBE)', lat: 30.9177, lng: 29.6964, airport: true },
    { name: 'New Alamein Downtown', lat: 30.8300, lng: 28.9450 },
    { name: 'New Alamein Towers', lat: 30.8300, lng: 28.9450 },
    { name: 'North Edge', lat: 30.8420, lng: 28.9200 },
    { name: 'The Lagoons', lat: 30.8120, lng: 28.9850 },
    { name: 'Marassi', lat: 30.9300, lng: 28.7700 },
    { name: 'Porto Marina', lat: 30.8330, lng: 29.0450 },
    { name: 'Hacienda Bay', lat: 31.0400, lng: 28.0400 },
    { name: 'Alexandria city centre', lat: 31.2001, lng: 29.9187 },
    { name: 'Cairo, Downtown', lat: 30.0444, lng: 31.2357 },
  ],
  operators: [
    { code: 'NCT', name: 'North Coast Transfers', rating: 4.7, reviews: 980 },
    { code: 'ALX', name: 'AlexLine Chauffeurs', rating: 4.5, reviews: 412 },
  ],
  vehicles: [
    { code: 'SEDAN', name: 'Private sedan', operator: 'NCT', max_pax: 3, max_bags: 3, base_usd: 18, per_km_usd: 0.55, shared: false, scene: 'car-sedan', features: ['Meet & greet', 'Free waiting 60 min at airports'] },
    { code: 'MINIVAN', name: 'Private minivan', operator: 'NCT', max_pax: 7, max_bags: 7, base_usd: 26, per_km_usd: 0.72, shared: false, scene: 'car-van', features: ['Meet & greet', 'Child seats on request'] },
    { code: 'MINIBUS', name: 'Private minibus', operator: 'ALX', max_pax: 14, max_bags: 14, base_usd: 45, per_km_usd: 1.05, shared: false, scene: 'bus', features: ['Ideal for groups', 'Meet & greet'] },
    { code: 'VIP', name: 'Executive car', operator: 'ALX', max_pax: 3, max_bags: 3, base_usd: 40, per_km_usd: 1.1, shared: false, scene: 'car-sedan', features: ['Business-class sedan', 'Bottled water and Wi-Fi', 'Meet & greet'] },
    { code: 'SHUTTLE', name: 'Shared shuttle', operator: 'NCT', max_pax: 1, max_bags: 2, base_usd: 6, per_km_usd: 0.09, shared: true, scene: 'bus', features: ['Priced per seat', 'Scheduled departures'] },
  ],
  vat_pct: 14,
  return_discount_pct: 10,
  cancel: { free_hours: 24, late_penalty_pct: 100 },
};
