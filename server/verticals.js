// The eight travel verticals. ENABLE_<envKey> switches one on; <providerEnv> picks its provider.
// This is the one list the config, provider registry, API and UI all read,
// so adding a vertical means adding it here (plus its provider). `search` describes the vertical's search
// form in vendor-neutral terms — the UI renders forms from it and the engine validates queries against
// it, so neither ever needs to know which supplier sits behind the vertical.
const VERTICALS = [
  {
    key: 'hotels', envKey: 'HOTELS', providerEnv: 'HOTEL_PROVIDER', label: 'Stays', noun: 'stay', icon: 'bed', unit: 'night',
    headline: 'Find your next stay',
    search: [
      { name: 'where', label: 'Where are you going?', type: 'text', required: true, placeholder: 'New Alamein', default: 'New Alamein' },
      { name: 'checkIn', label: 'Check in', type: 'date', required: true, offsetDays: 14 },
      { name: 'checkOut', label: 'Check out', type: 'date', required: true, offsetDays: 17, after: 'checkIn' },
      { name: 'guests', label: 'Guests', type: 'number', min: 1, max: 16, default: 2 },
    ],
  },
  {
    key: 'flights', envKey: 'FLIGHTS', providerEnv: 'FLIGHT_PROVIDER', label: 'Flights', noun: 'flight', icon: 'plane', unit: 'passenger',
    headline: 'Search flights',
    search: [
      { name: 'from', label: 'From', type: 'airport', required: true, default: 'CAI' },
      { name: 'to', label: 'To', type: 'airport', required: true, default: 'DBB' },
      { name: 'departDate', label: 'Depart', type: 'date', required: true, offsetDays: 14 },
      { name: 'passengers', label: 'Passengers', type: 'number', min: 1, max: 9, default: 1 },
      { name: 'cabin', label: 'Cabin', type: 'select', options: ['economy', 'premium', 'business'], default: 'economy' },
    ],
  },
  {
    key: 'cars', envKey: 'CARS', providerEnv: 'CAR_PROVIDER', label: 'Cars', noun: 'car', icon: 'car', unit: 'day',
    headline: 'Rent a car',
    search: [
      { name: 'where', label: 'Pick-up location', type: 'text', required: true, default: 'El Alamein Airport (DBB)' },
      { name: 'pickupDate', label: 'Pick-up', type: 'date', required: true, offsetDays: 14 },
      { name: 'dropoffDate', label: 'Drop-off', type: 'date', required: true, offsetDays: 18, after: 'pickupDate' },
      { name: 'driverAge', label: 'Driver age', type: 'number', min: 18, max: 99, default: 30 },
    ],
  },
  {
    key: 'cruises', envKey: 'CRUISES', providerEnv: 'CRUISE_PROVIDER', label: 'Cruises', noun: 'cruise', icon: 'ship', unit: 'guest',
    headline: 'Find a cruise',
    search: [
      { name: 'where', label: 'Region or port', type: 'text', placeholder: 'Eastern Mediterranean', default: '' },
      { name: 'month', label: 'Sailing month', type: 'month', offsetDays: 30 },
      { name: 'guests', label: 'Guests', type: 'number', min: 1, max: 4, default: 2 },
    ],
  },
  {
    key: 'yachts', envKey: 'YACHTS', providerEnv: 'YACHT_PROVIDER', label: 'Yachts', noun: 'yacht charter', icon: 'yacht', unit: 'charter',
    headline: 'Charter a yacht',
    search: [
      { name: 'where', label: 'Marina', type: 'text', default: 'New Alamein Marina' },
      { name: 'date', label: 'Date', type: 'date', required: true, offsetDays: 10 },
      { name: 'duration', label: 'Charter', type: 'select', options: ['half_day', 'full_day', 'sunset'], default: 'half_day' },
      { name: 'guests', label: 'Guests', type: 'number', min: 1, max: 30, default: 6 },
    ],
  },
  {
    key: 'transfers', envKey: 'TRANSFERS', providerEnv: 'TRANSFER_PROVIDER', label: 'Transfers', noun: 'transfer', icon: 'bus', unit: 'vehicle',
    headline: 'Book a transfer',
    search: [
      { name: 'from', label: 'From', type: 'text', required: true, default: 'El Alamein Airport (DBB)' },
      { name: 'to', label: 'To', type: 'text', required: true, default: 'New Alamein Downtown' },
      { name: 'date', label: 'Date', type: 'date', required: true, offsetDays: 14 },
      { name: 'passengers', label: 'Passengers', type: 'number', min: 1, max: 20, default: 2 },
    ],
  },
  {
    key: 'activities', envKey: 'ACTIVITIES', providerEnv: 'ACTIVITY_PROVIDER', label: 'Activities', noun: 'activity', icon: 'flag', unit: 'ticket',
    headline: 'Things to do',
    search: [
      { name: 'where', label: 'Destination', type: 'text', default: 'New Alamein' },
      { name: 'date', label: 'Date', type: 'date', required: true, offsetDays: 7 },
      { name: 'participants', label: 'Participants', type: 'number', min: 1, max: 20, default: 2 },
    ],
  },
  {
    key: 'experiences', envKey: 'EXPERIENCES', providerEnv: 'EXPERIENCE_PROVIDER', label: 'Experiences', noun: 'experience', icon: 'palm', unit: 'ticket',
    headline: 'Unforgettable experiences',
    search: [
      { name: 'where', label: 'Destination', type: 'text', default: 'New Alamein' },
      { name: 'date', label: 'Date', type: 'date', required: true, offsetDays: 7 },
      { name: 'participants', label: 'Participants', type: 'number', min: 1, max: 20, default: 2 },
    ],
  },
];

const VERTICAL_KEYS = VERTICALS.map(v => v.key);
const byKey = Object.fromEntries(VERTICALS.map(v => [v.key, v]));

function getVertical(key) {
  return byKey[key] || null;
}

module.exports = { VERTICALS, VERTICAL_KEYS, getVertical };
