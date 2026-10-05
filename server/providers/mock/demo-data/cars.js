// DEMO DATA — fictional rental suppliers (see README.md). Vehicle models are given "or similar" the way
// rental companies list them; prices are invented, USD major units per day.
module.exports = {
  locations: [
    { code: 'DBB', name: 'El Alamein Airport (DBB)', airport: true, surcharge_usd: 25 },
    { code: 'NAD', name: 'New Alamein Downtown', airport: false, surcharge_usd: 0 },
    { code: 'MRS', name: 'Marassi', airport: false, surcharge_usd: 0 },
    { code: 'PMR', name: 'Porto Marina', airport: false, surcharge_usd: 0 },
    { code: 'CAI', name: 'Cairo Airport (CAI)', airport: true, surcharge_usd: 30 },
    { code: 'HBE', name: 'Alexandria Borg El Arab Airport (HBE)', airport: true, surcharge_usd: 25 },
  ],
  suppliers: [
    { code: 'CDR', name: 'Coastal Drive', rating: 4.6, reviews: 812, fuel_policy: 'Full to full', deposit_usd: 300, locations: ['DBB', 'NAD', 'MRS', 'PMR', 'HBE'] },
    { code: 'NLR', name: 'Northline Rentals', rating: 4.3, reviews: 1520, fuel_policy: 'Full to full', deposit_usd: 250, locations: ['DBB', 'CAI', 'HBE', 'NAD'] },
    { code: 'AAH', name: 'Alamein Auto Hire', rating: 4.8, reviews: 233, fuel_policy: 'Same to same', deposit_usd: 400, locations: ['NAD', 'MRS', 'DBB'] },
  ],
  vehicles: [
    { sipp: 'ECAR', class: 'Economy', model: 'Hyundai Accent or similar', seats: 5, doors: 4, bags: 2, auto: true, ac: true, day_usd: 32, scene: 'car-compact' },
    { sipp: 'CDAR', class: 'Compact', model: 'Toyota Corolla or similar', seats: 5, doors: 4, bags: 3, auto: true, ac: true, day_usd: 41, scene: 'car-sedan' },
    { sipp: 'IFAR', class: 'Intermediate SUV', model: 'Kia Sportage or similar', seats: 5, doors: 5, bags: 3, auto: true, ac: true, day_usd: 58, scene: 'car-suv' },
    { sipp: 'FFAR', class: 'Full-size SUV', model: 'Toyota Land Cruiser Prado or similar', seats: 7, doors: 5, bags: 4, auto: true, ac: true, day_usd: 96, scene: 'car-suv' },
    { sipp: 'PDAR', class: 'Premium', model: 'Mercedes-Benz E-Class or similar', seats: 5, doors: 4, bags: 3, auto: true, ac: true, day_usd: 120, scene: 'car-sedan' },
    { sipp: 'MVMR', class: 'Minivan', model: 'Hyundai H-1 or similar', seats: 9, doors: 4, bags: 5, auto: false, ac: true, day_usd: 84, scene: 'car-van' },
    { sipp: 'STAR', class: 'Convertible', model: 'Mini Cooper Convertible or similar', seats: 4, doors: 2, bags: 1, auto: true, ac: true, day_usd: 105, scene: 'car-compact' },
  ],
  // Protection packages sold per day on top of the base rate.
  protection: [
    { code: 'BASIC', name: 'Basic protection', day_usd: 0, excess_usd: 1200, features: ['Collision damage waiver', 'Theft protection', 'USD 1,200 excess'] },
    { code: 'FULL', name: 'Full protection', day_usd: 14, excess_usd: 0, features: ['Zero excess', 'Tyres, glass and underbody', 'Roadside assistance'] },
  ],
  vat_pct: 14,
  young_driver_age: 25,
  young_driver_day_usd: 9,
  cancel: { free_hours: 48, late_penalty_pct: 100 },
};
