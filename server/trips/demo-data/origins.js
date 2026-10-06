// Demo departure cities and their airports. `nearby` airports feed the flexible-airport suggestions,
// with the ground-transport note the traveler needs to weigh the saving against.
const ORIGINS = [
  { id: 'SFO', city: 'San Francisco', airports: [
    { code: 'SFO', name: 'San Francisco Intl', lat: 37.62, lon: -122.38, hub: true },
    { code: 'OAK', name: 'Oakland', lat: 37.72, lon: -122.22, note: 'about 20 miles from San Francisco; BART takes around 40 minutes' },
    { code: 'SJC', name: 'San José', lat: 37.36, lon: -121.93, note: 'about 45 miles from San Francisco; Caltrain plus a shuttle takes around 1h 30m' },
  ] },
  { id: 'LAX', city: 'Los Angeles', airports: [
    { code: 'LAX', name: 'Los Angeles Intl', lat: 33.94, lon: -118.41, hub: true },
    { code: 'BUR', name: 'Burbank', lat: 34.20, lon: -118.36, note: 'about 15 miles north of downtown LA' },
    { code: 'LGB', name: 'Long Beach', lat: 33.82, lon: -118.15, note: 'about 25 miles south of downtown LA' },
  ] },
  { id: 'NYC', city: 'New York', airports: [
    { code: 'JFK', name: 'New York JFK', lat: 40.64, lon: -73.78, hub: true },
    { code: 'EWR', name: 'Newark', lat: 40.69, lon: -74.17, hub: true, note: 'in New Jersey; NJ Transit to Midtown takes around 35 minutes' },
    { code: 'LGA', name: 'LaGuardia', lat: 40.78, lon: -73.87, note: 'in Queens; about 30 minutes to Midtown by bus and subway' },
  ] },
  { id: 'CHI', city: 'Chicago', airports: [
    { code: 'ORD', name: "Chicago O'Hare", lat: 41.98, lon: -87.90, hub: true },
    { code: 'MDW', name: 'Chicago Midway', lat: 41.79, lon: -87.75, note: 'closer to downtown; the Orange Line takes around 25 minutes' },
  ] },
  { id: 'MIA', city: 'Miami', airports: [
    { code: 'MIA', name: 'Miami Intl', lat: 25.80, lon: -80.29, hub: true },
    { code: 'FLL', name: 'Fort Lauderdale', lat: 26.07, lon: -80.15, note: 'about 30 miles north of Miami' },
  ] },
  { id: 'DFW', city: 'Dallas', airports: [
    { code: 'DFW', name: 'Dallas/Fort Worth', lat: 32.90, lon: -97.04, hub: true },
    { code: 'DAL', name: 'Dallas Love Field', lat: 32.85, lon: -96.85, note: 'about 7 miles from downtown Dallas' },
  ] },
  { id: 'HOU', city: 'Houston', airports: [
    { code: 'IAH', name: 'Houston Bush Intl', lat: 29.98, lon: -95.34, hub: true },
    { code: 'HOU', name: 'Houston Hobby', lat: 29.65, lon: -95.28, note: 'about 10 miles south of downtown Houston' },
  ] },
  { id: 'ATL', city: 'Atlanta', airports: [{ code: 'ATL', name: 'Atlanta', lat: 33.64, lon: -84.43, hub: true }] },
  { id: 'BOS', city: 'Boston', airports: [{ code: 'BOS', name: 'Boston Logan', lat: 42.36, lon: -71.01, hub: true }] },
  { id: 'SEA', city: 'Seattle', airports: [{ code: 'SEA', name: 'Seattle-Tacoma', lat: 47.45, lon: -122.31, hub: true }] },
  { id: 'DEN', city: 'Denver', airports: [{ code: 'DEN', name: 'Denver', lat: 39.86, lon: -104.67, hub: true }] },
];

module.exports = { ORIGINS };
