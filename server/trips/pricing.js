// Trip pricing. Turns a trip spec into the customer's complete price (every mandatory tax and fee
// included, nothing added later) and, separately, the internal economics: supplier cost, markup,
// commission, payment processing and estimated gross profit. The internal part is only ever read by
// the admin control center; customer views and the public API use publicTrip(), which drops it.
const { AppError } = require('../lib/errors');
const { percentOf } = require('../lib/money');

const DEFAULT_SETTINGS = {
  serviceFeePerTraveler: 1500,   // cents
  maxServiceFee: 6000,           // cents per booking
  hotelMarkupPercent: 8,         // applied to net hotel rates where package rates allow it
  minProfit: 2000,               // cents per booking; below this the booking is flagged for review
  minMarginPercent: 2,           // gross profit / customer total; below this the booking is flagged
  processingPercent: 2.9,        // card processing estimate
  processingFixed: 30,           // cents
  disabledDestinations: [],
};

function roomsFor(spec) {
  return spec.who === 'family' ? Math.ceil(spec.travelers / 4) : Math.ceil(spec.travelers / 2);
}

// Look up every component of the spec with the suppliers and price it. Returns null when a component
// is no longer available (sold out, route gone), which callers treat as "this trip can't be built".
function priceTrip(inv, spec, settings = DEFAULT_SETTINGS, { promo = null } = {}) {
  const dest = inv.maps.getDestination(spec.dest);
  if (!dest) return null;
  const rooms = roomsFor(spec);
  const flights = inv.flights.search({ from: spec.from, destId: spec.dest, depart: spec.depart, nights: spec.nights, travelers: spec.travelers });
  const flight = flights.find(f => f.id === spec.flight);
  const hotels = inv.hotels.search({ destId: spec.dest, checkIn: spec.depart, nights: spec.nights, rooms });
  const hotel = hotels.find(h => h.id === spec.hotel);
  if (!flight || !hotel) return null;
  const allActs = inv.activities.search({ destId: spec.dest, date: spec.depart, travelers: spec.travelers });
  const acts = spec.activities.map(a => allActs.find(x => x.id === a));
  if (acts.some(a => !a)) return null;
  const transfer = spec.transfer ? inv.transfers.quote({ destId: spec.dest, travelers: spec.travelers }) : null;
  if (spec.transfer && !transfer) return null;

  const T = spec.travelers, N = spec.nights;
  const familyRate = spec.who === 'family' ? 1.35 : 1;
  const hotelNet = Math.round(hotel.netNightly * familyRate) * rooms * N;
  const hotelMarkup = percentOf(hotelNet, settings.hotelMarkupPercent);
  const flightFares = flight.farePerTraveler * T;
  const flightTaxes = flight.taxesPerTraveler * T;
  const bagsAmount = spec.bags ? flight.bagFeePerTraveler * T : 0;
  const hotelPrice = hotelNet + hotelMarkup;
  const hotelTaxes = percentOf(hotelPrice, hotel.taxPercent);
  const resortFees = hotel.resortFeePerNight * rooms * N;
  const actsPrice = acts.reduce((s, a) => s + a.pricePerPerson * T, 0);
  const actsCommission = acts.reduce((s, a) => s + percentOf(a.pricePerPerson * T, a.commissionPercent), 0);
  const transferPrice = transfer ? transfer.pricePerVehicleEachWay * transfer.vehicles * 2 : 0;
  const transferCommission = transfer ? percentOf(transferPrice, transfer.commissionPercent) : 0;
  const serviceFee = Math.min(settings.serviceFeePerTraveler * T, settings.maxServiceFee);

  const taxDetail = [
    { label: 'Flight taxes and airport fees', amount: flightTaxes },
    { label: `Hotel taxes (${hotel.taxPercent}%)`, amount: hotelTaxes },
  ];
  if (resortFees) taxDetail.push({ label: 'Mandatory resort fee (paid in this total, not at the hotel)', amount: resortFees });
  const taxesAndFees = flightTaxes + hotelTaxes + resortFees;

  const lines = [
    { key: 'flights', label: `Round-trip flights for ${T}`, amount: flightFares },
    { key: 'hotel', label: `${N}-night stay, ${rooms} room${rooms > 1 ? 's' : ''}`, amount: hotelPrice },
  ];
  if (actsPrice) lines.push({ key: 'experiences', label: `Experiences (${acts.length})`, amount: actsPrice });
  if (transferPrice) lines.push({ key: 'transfer', label: 'Airport transfer, both ways', amount: transferPrice });
  if (bagsAmount) lines.push({ key: 'bags', label: `Checked bag for each traveler, both ways`, amount: bagsAmount });
  lines.push({ key: 'taxes', label: 'Taxes and mandatory fees', amount: taxesAndFees, detail: taxDetail });
  lines.push({ key: 'service', label: 'Tripelyx service fee', amount: serviceFee });

  let subtotal = lines.reduce((s, l) => s + l.amount, 0);
  let discount = 0;
  if (promo) {
    discount = promo.type === 'percent' ? percentOf(subtotal, promo.value) : Math.min(promo.value, subtotal);
    if (promo.minTotal && subtotal < promo.minTotal) discount = 0;
    if (discount) lines.push({ key: 'promo', label: `Promo code ${promo.code}`, amount: -discount });
  }
  const total = subtotal - discount;

  // Internal economics (never shown to customers).
  const supplierCost = flightFares + flightTaxes + bagsAmount + hotelNet + hotelTaxes + resortFees
    + (actsPrice - actsCommission) + (transferPrice - transferCommission);
  const processingCost = Math.round(total * settings.processingPercent / 100) + settings.processingFixed;
  const grossProfit = total - supplierCost - processingCost;
  const marginPercent = total ? Math.round((grossProfit / total) * 1000) / 10 : 0;
  const reasons = [];
  if (grossProfit < settings.minProfit) reasons.push(`Estimated profit below the $${(settings.minProfit / 100).toFixed(0)} minimum`);
  if (marginPercent < settings.minMarginPercent) reasons.push(`Margin below the ${settings.minMarginPercent}% minimum`);

  // "Typical" price with neutral season, weekday and lead time: the baseline for the value score.
  const typical = flight.typicalFarePerTraveler * T * 1.15
    + Math.round(hotel.typicalNetNightly * familyRate) * rooms * N * (1 + settings.hotelMarkupPercent / 100) * (1 + hotel.taxPercent / 100)
    + resortFees + actsPrice + transferPrice + bagsAmount + serviceFee;

  const intl = dest.passportRequired;
  const included = [
    `Round-trip ${flight.stops ? `${flight.stops}-stop` : 'nonstop'} flights (${flight.name} fare) for ${T}`,
    `${N} nights at ${hotel.name} (${hotel.stars}-star), ${rooms} room${rooms > 1 ? 's' : ''}`,
    ...(hotel.features.allInclusive ? ['All meals and drinks at the resort (all-inclusive)'] : hotel.features.breakfast ? ['Daily breakfast'] : []),
    ...(flight.carryOn ? ['A carry-on bag for each traveler'] : ['A personal item for each traveler (no carry-on)']),
    ...(flight.checkedBagIncluded || spec.bags ? ['A checked bag for each traveler, both ways'] : []),
    ...acts.map(a => a.name),
    ...(transfer ? ['Private airport transfer, both ways'] : []),
    'All taxes, mandatory fees and the Tripelyx service fee',
  ];
  const notIncluded = [
    ...(hotel.features.allInclusive ? [] : ['Meals and drinks' + (hotel.features.breakfast ? ' other than breakfast' : '')]),
    ...(flight.checkedBagIncluded || spec.bags ? [] : ['Checked bags (add them in the customizer)']),
    ...(transfer ? [] : ['Airport transfers (add one in the customizer)']),
    'Travel insurance',
    ...(intl ? ['Passports, visas or entry fees'] : []),
    'Tips and personal spending',
  ];
  const providers = [
    { component: 'Flights', provider: flight.supplier },
    { component: 'Hotel', provider: `${hotel.supplier} (${hotel.name})` },
    ...acts.map(a => ({ component: a.name, provider: a.supplier })),
    ...(transfer ? [{ component: 'Airport transfer', provider: transfer.supplier }] : []),
    { component: 'Trip planning and booking', provider: 'Tripelyx' },
  ];
  const policies = [
    { component: 'Flights', text: `${flight.policy} US rules let you cancel within 24 hours of booking for a full refund when departure is at least 7 days away.` },
    { component: 'Hotel', text: hotel.policy },
    ...acts.map(a => ({ component: a.name, text: a.policy })),
    ...(transfer ? [{ component: 'Airport transfer', text: transfer.policy }] : []),
    { component: 'Service fee', text: 'Refunded if you cancel within 24 hours of booking; otherwise non-refundable.' },
  ];

  return {
    spec, dest, flight, hotel, activities: acts, transfer, rooms, flightOptions: flights, hotelOptions: hotels, activityOptions: allActs,
    lines, total, perTraveler: Math.round(total / T), perNight: Math.round(total / N), typical: Math.round(typical),
    included, notIncluded, providers, policies, internationalTrip: intl,
    demo: !!(dest.demo || flight.demo || hotel.demo),
    internal: {
      supplierCost, hotelMarkup, commission: actsCommission + transferCommission, serviceFee, discount,
      processingCost, grossProfit, marginPercent, review: { flagged: reasons.length > 0, reasons },
    },
  };
}

// Everything a customer may see about a priced trip.
function publicTrip(t) {
  if (!t) return null;
  const { internal, ...rest } = t; // eslint-disable-line no-unused-vars
  return rest;
}

function requireTrip(t) {
  if (!t) throw new AppError('trip_unavailable', 'Part of this trip is no longer available. Please rebuild it.', 410);
  return t;
}

module.exports = { priceTrip, publicTrip, requireTrip, roomsFor, DEFAULT_SETTINGS };
