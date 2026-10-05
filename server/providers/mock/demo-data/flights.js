// DEMO DATA — fictional airlines and schedules (see README.md). Airport codes and coordinates are real
// so searches feel natural; carriers, flight numbers and fares are invented. Schedules are generated
// deterministically per route and date by MockFlightProvider from these tables.
module.exports = {
  airports: [
    { iata: 'CAI', name: 'Cairo International', city: 'Cairo', country: 'Egypt', lat: 30.1219, lng: 31.4056, tz: 'Africa/Cairo', hub: true },
    { iata: 'DBB', name: 'El Alamein International', city: 'El Alamein', country: 'Egypt', lat: 30.9245, lng: 28.4614, tz: 'Africa/Cairo' },
    { iata: 'HBE', name: 'Borg El Arab', city: 'Alexandria', country: 'Egypt', lat: 30.9177, lng: 29.6964, tz: 'Africa/Cairo' },
    { iata: 'HRG', name: 'Hurghada International', city: 'Hurghada', country: 'Egypt', lat: 27.1783, lng: 33.7994, tz: 'Africa/Cairo' },
    { iata: 'SSH', name: 'Sharm el-Sheikh International', city: 'Sharm el-Sheikh', country: 'Egypt', lat: 27.9773, lng: 34.3950, tz: 'Africa/Cairo' },
    { iata: 'DXB', name: 'Dubai International', city: 'Dubai', country: 'United Arab Emirates', lat: 25.2532, lng: 55.3657, tz: 'Asia/Dubai', hub: true },
    { iata: 'JED', name: 'King Abdulaziz International', city: 'Jeddah', country: 'Saudi Arabia', lat: 21.6796, lng: 39.1565, tz: 'Asia/Riyadh' },
    { iata: 'RUH', name: 'King Khalid International', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.9576, lng: 46.6988, tz: 'Asia/Riyadh' },
    { iata: 'IST', name: 'Istanbul Airport', city: 'Istanbul', country: 'Türkiye', lat: 41.2753, lng: 28.7519, tz: 'Europe/Istanbul', hub: true },
    { iata: 'ATH', name: 'Athens International', city: 'Athens', country: 'Greece', lat: 37.9364, lng: 23.9445, tz: 'Europe/Athens' },
    { iata: 'FCO', name: 'Rome Fiumicino', city: 'Rome', country: 'Italy', lat: 41.8003, lng: 12.2389, tz: 'Europe/Rome' },
    { iata: 'MUC', name: 'Munich', city: 'Munich', country: 'Germany', lat: 48.3538, lng: 11.7861, tz: 'Europe/Berlin' },
    { iata: 'CDG', name: 'Paris Charles de Gaulle', city: 'Paris', country: 'France', lat: 49.0097, lng: 2.5479, tz: 'Europe/Paris' },
    { iata: 'LHR', name: 'London Heathrow', city: 'London', country: 'United Kingdom', lat: 51.4700, lng: -0.4543, tz: 'Europe/London' },
  ],
  carriers: [
    { code: 'ZM', name: 'Mediterra Airways', aircraft: ['Airbus A320neo', 'Airbus A321neo'], quality: 1.0 },
    { code: 'ZS', name: 'Sahara Wings', aircraft: ['Boeing 737-800', 'Boeing 737 MAX 8'], quality: 0.88 },
    { code: 'ZC', name: 'Coastline Air', aircraft: ['ATR 72-600', 'Embraer E190'], quality: 0.82, regionalOnly: true },
    { code: 'ZA', name: 'Aegean Blue', aircraft: ['Airbus A320', 'Airbus A220-300'], quality: 0.95 },
    { code: 'ZG', name: 'Gulfstar', aircraft: ['Boeing 787-9', 'Airbus A350-900'], quality: 1.12, longHaul: true },
  ],
  // Fare families, priced as a multiple of the cabin's base fare.
  fareFamilies: [
    { code: 'LIGHT', name: 'Light', multiplier: 1.0, cabin_kg: 7, checked_bags: 0, checked_kg: 0, changeable: false, refundable_pct: 0, features: ['7 kg cabin bag', 'Seat chosen at check-in'] },
    { code: 'CLASSIC', name: 'Classic', multiplier: 1.22, cabin_kg: 8, checked_bags: 1, checked_kg: 23, changeable: true, refundable_pct: 0, features: ['1 × 23 kg checked bag', 'Standard seat selection', 'Changes for a fee'] },
    { code: 'FLEX', name: 'Flex', multiplier: 1.55, cabin_kg: 10, checked_bags: 2, checked_kg: 23, changeable: true, refundable_pct: 70, features: ['2 × 23 kg checked bags', 'Free seat selection', 'Free changes', '70% refundable'] },
  ],
  cabinMultiplier: { economy: 1, premium: 1.7, business: 3.1 },
  // Government and airport charges, per passenger, USD.
  taxes: { departure_tax_usd: 18, security_fee_usd: 6, fuel_surcharge_per_1000km_usd: 9 },
};
