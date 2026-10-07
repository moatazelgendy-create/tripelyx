// Interfaces for the trip integrations. Money is integer cents (USD); dates are 'YYYY-MM-DD'.
// A real supplier adapter implements one of these and is registered in ./index.js.

export interface Destination {
  id: string; name: string; country: string; airport: string; lat: number; lon: number;
  regions: string[]; styles: string[]; passportRequired: boolean; blurb: string;
  image: { url: string; alt: string }; demo: boolean;
}

export interface MapsProvider {
  listDestinations(): Destination[];
  getDestination(id: string): Destination | null;
  listOrigins(): { id: string; city: string; airports: { code: string; name: string; note: string | null }[] }[];
  getOrigin(id: string): ReturnType<MapsProvider['listOrigins']>[number] | null;
  distanceKm(fromAirport: string, destId: string): number | null;
}

export interface WeatherProvider {
  outlook(destId: string, month: number): { warm: boolean; label: string; source: string } | null;
}

export interface FlightOffer {
  id: 'basic' | 'saver' | 'nonstop' | string; name: string; airline: string; supplier: string; demo: boolean;
  from: string; to: string; depart: string; return: string; stops: number; durationMinutes: number;
  farePerTraveler: number; typicalFarePerTraveler: number; taxesPerTraveler: number;
  carryOn: boolean; checkedBagIncluded: boolean; bagFeePerTraveler: number; seatSelection: boolean;
  refundable: boolean; changeable: boolean; freeCancelHours?: number; policy: string;
  // Schedule, in minutes from midnight local time. Optional: without it the pages skip usable-time facts.
  departMinutes?: number; arriveMinutes?: number; arrivesNextDay?: boolean; returnDepartMinutes?: number; returnArriveMinutes?: number;
}
export interface FlightsProvider {
  search(q: { from: string; destId: string; depart: string; nights: number; travelers: number }): FlightOffer[];
  book(offer: FlightOffer, ctx: { traveler: object; tripRef: string }): Promise<{ status: 'confirmed'; confirmation: string }>;
}

export interface HotelOffer {
  id: string; name: string; stars: number; rating: number; ratingSource: string; area: string; demo: boolean; supplier: string;
  features: Record<'breakfast' | 'pool' | 'beachfront' | 'adultsOnly' | 'allInclusive' | 'freeCancellation' | 'familyFriendly' | 'spa' | 'airportShuttle', boolean>;
  netNightly: number; typicalNetNightly: number; rooms: number; nights: number; checkIn: string; checkOut: string;
  taxPercent: number; resortFeePerNight: number; refundable: boolean; freeCancelHours: number; policy: string;
}
export interface HotelsProvider {
  search(q: { destId: string; checkIn: string; nights: number; rooms: number }): HotelOffer[];
  book(offer: HotelOffer, ctx: { traveler: object; tripRef: string }): Promise<{ status: 'confirmed'; confirmation: string }>;
}

export interface ActivityOffer {
  id: string; name: string; pricePerPerson: number; commissionPercent: number; hours: number; kind: string;
  demo: boolean; supplier: string; freeCancelHours: number; policy: string;
  // Experience facts: the part of the day it takes, the months it runs (null = operating days not in
  // our data), whether it depends on the weather, and tags (the kind plus 'food' / 'nature').
  slot?: 'day' | 'morning' | 'evening' | 'night'; months?: number[] | null; weather?: boolean; tags?: string[];
}
export interface ActivitiesProvider {
  search(q: { destId: string; date: string; travelers: number }): ActivityOffer[];
  book(offer: ActivityOffer, ctx: object): Promise<{ status: 'confirmed'; confirmation: string }>;
}

export interface TransferQuote {
  id: string; name: string; supplier: string; demo: boolean; pricePerVehicleEachWay: number; vehicles: number;
  commissionPercent: number; freeCancelHours: number; policy: string;
}
// Free things worth doing. Only with a source and the date it was checked (the guide's own date, never
// the day it is read); null means "no free data for this destination" (never "nothing free exists"), and
// the whole capability may be absent. `condition` says when an item is free at all (e.g. only on the
// first Sunday of the month): the engine calls it free only on a trip whose dates meet it.
export interface GuideCondition { days: 'first-sunday' | string }
export interface GuidesProvider {
  freeThings(q: { destId: string }): { source: string; checkedAt: string; items: { name: string; kind: string; note: string; condition?: GuideCondition }[] } | null;
}

export interface TransfersProvider {
  quote(q: { destId: string; travelers: number }): TransferQuote | null;
  book(q: TransferQuote, ctx: object): Promise<{ status: 'confirmed'; confirmation: string }>;
}

// Email/SMS. The default 'outbox' provider records messages without sending them.
export interface Notifier {
  send(msg: { to: string; channel?: 'email' | 'sms'; subject: string; body: string; audience?: 'customer' | 'admin'; ref?: string }): Promise<object>;
}
