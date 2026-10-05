// Typed shapes of the normalization layer. The runtime is plain JavaScript; this file documents the
// contracts precisely (and gives editors autocompletion via JSDoc `import('./types')`). Runtime checks
// for the same shapes live in ./contracts.js.

export type Vertical =
  | 'hotels' | 'flights' | 'cars' | 'cruises' | 'yachts' | 'transfers' | 'activities' | 'experiences';

/** Integer minor units (cents). Never a float. */
export interface Money { amount: number; currency: string }

export interface PriceLine {
  code: string;            // stable machine code, e.g. "room", "vat", "city_tax", "baggage"
  label: string;           // traveler-facing label
  kind: 'base' | 'tax' | 'fee' | 'discount';
  amount: number;          // minor units; discounts are negative
}

export interface CancellationPolicy {
  type: 'free' | 'partial' | 'non_refundable';
  /** Free cancellation until this many hours before the start date (ignored for non_refundable). */
  freeUntilHours: number;
  /** Percentage of the total retained once the free window has passed (100 for non_refundable). */
  penaltyPercent: number;
  summary: string;
}

export interface Media { url: string; alt: string }

export interface OfferOption {
  id: string;
  name: string;
  description?: string;
  /** Price per `Offer.fromPrice.unit`. */
  price: Money;
  /** Total for the searched query (nights × rate, passengers × fare …), when it can be computed. */
  total?: Money;
  capacity?: number;
  available: boolean;
  remaining?: number;
  features?: string[];
}

export interface Offer<D = Record<string, unknown>> {
  id: string;
  vertical: Vertical;
  provider: string;
  /** True for demo inventory. The UI badges it and production refuses it unless explicitly allowed. */
  demo: boolean;
  title: string;
  subtitle?: string;
  description?: string;
  location: { name: string; area?: string; city?: string; country?: string };
  media: Media[];
  rating?: { score: number; count: number };
  badges?: string[];
  fromPrice: Money & { unit: string };
  attributes?: { label: string; value: string }[];
  options: OfferOption[];
  cancellation: CancellationPolicy;
  details: D;
}

// ---- vertical-specific details ----------------------------------------------------------------

export interface HotelDetails {
  stars: number; propertyType: string; amenities: string[];
  checkInTime: string; checkOutTime: string; nights: number; taxesPercent: number;
}
export interface FlightSegment {
  carrier: { code: string; name: string }; flightNumber: string;
  from: { code: string; name: string; city: string }; to: { code: string; name: string; city: string };
  departAt: string; arriveAt: string; durationMinutes: number; aircraft: string;
}
export interface FlightDetails {
  segments: FlightSegment[]; stops: number; cabin: 'economy' | 'premium' | 'business';
  baggage: { cabinKg: number; checkedBags: number; checkedKg: number };
}
export interface CarDetails {
  vehicleClass: string; model: string; seats: number; doors: number; bags: number;
  transmission: 'automatic' | 'manual'; airConditioning: boolean; fuelPolicy: string;
  supplier: string; pickup: { location: string; at: string }; dropoff: { location: string; at: string }; days: number;
}
export interface CruiseDetails {
  ship: { name: string; line: string; yearBuilt: number; guests: number };
  itinerary: { day: number; port: string; country: string; arrive?: string; depart?: string }[];
  departureDate: string; nights: number; embarkPort: string;
}
export interface YachtDetails {
  type: string; lengthM: number; capacity: number; cabins: number; crew: number;
  marina: string; date: string; duration: string; durationHours: number; inclusions: string[];
}
export interface TransferDetails {
  from: string; to: string; date: string; vehicle: string; maxPassengers: number; maxBags: number;
  durationMinutes: number; meetAndGreet: boolean;
}
export interface ExperienceDetails {
  category: string; date: string; durationMinutes: number;
  meetingPoint: { name: string; address: string; instructions: string };
  slots: { time: string; remaining: number; capacity: number }[];
  languages: string[]; includes: string[];
}

export type HotelOffer = Offer<HotelDetails>;
export type FlightOffer = Offer<FlightDetails>;
export type CarOffer = Offer<CarDetails>;
export type CruiseOffer = Offer<CruiseDetails>;
export type YachtOffer = Offer<YachtDetails>;
export type TransferOffer = Offer<TransferDetails>;
export type ActivityOffer = Offer<ExperienceDetails>;
export type ExperienceOffer = Offer<ExperienceDetails>;

// ---- queries ----------------------------------------------------------------------------------

export interface HotelQuery { where: string; checkIn: string; checkOut: string; guests: number }
export interface FlightQuery { from: string; to: string; departDate: string; passengers: number; cabin: FlightDetails['cabin'] }
export interface CarQuery { where: string; pickupDate: string; dropoffDate: string; driverAge: number }
export interface CruiseQuery { where?: string; month?: string; guests: number }
export interface YachtQuery { where?: string; date: string; duration: 'half_day' | 'full_day' | 'sunset'; guests: number }
export interface TransferQuery { from: string; to: string; date: string; passengers: number }
export interface ExperienceQuery { where?: string; date: string; participants: number }

// ---- the provider interfaces ------------------------------------------------------------------

export interface Traveler {
  firstName: string; lastName: string; email: string; phone?: string; country?: string; notes?: string;
}

export interface SupplierQuote<O extends Offer = Offer> {
  offer: O;
  option: OfferOption;
  /** Option-specific choice such as a time slot (activities/experiences). */
  selection?: Record<string, string>;
  lines: PriceLine[];
  currency: string;
  /** Start of the service; cancellation windows count back from here. */
  startDate: string;
  cancellation: CancellationPolicy;
  supplierQuoteRef?: string;
}

export interface TravelProvider<Q, O extends Offer> {
  readonly name: string;
  readonly vertical: Vertical;
  readonly isDemo: boolean;
  search(query: Q): Promise<O[]>;
  getOffer(offerId: string, query: Q): Promise<O | null>;
  quote(input: { offerId: string; optionId: string; query: Q; selection?: Record<string, string> }): Promise<SupplierQuote<O>>;
  book(input: { quote: SupplierQuote<O>; traveler: Traveler; bookingRef: string }): Promise<{ supplierRef: string; status: 'confirmed' | 'pending' }>;
  cancel(input: { supplierRef: string; reason?: string }): Promise<{ cancelled: true }>;
}

export interface HotelProvider extends TravelProvider<HotelQuery, HotelOffer> { vertical: 'hotels' }
export interface FlightProvider extends TravelProvider<FlightQuery, FlightOffer> { vertical: 'flights' }
export interface CarProvider extends TravelProvider<CarQuery, CarOffer> { vertical: 'cars' }
export interface CruiseProvider extends TravelProvider<CruiseQuery, CruiseOffer> { vertical: 'cruises' }
export interface YachtProvider extends TravelProvider<YachtQuery, YachtOffer> { vertical: 'yachts' }
export interface TransferProvider extends TravelProvider<TransferQuery, TransferOffer> { vertical: 'transfers' }
export interface ActivityProvider extends TravelProvider<ExperienceQuery, ActivityOffer> { vertical: 'activities' }
export interface ExperienceProvider extends TravelProvider<ExperienceQuery, ExperienceOffer> { vertical: 'experiences' }

// ---- payments ---------------------------------------------------------------------------------

export interface PaymentIntent {
  id: string; amount: number; currency: string; status: 'requires_payment' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';
  mode: 'test' | 'live'; processor: string; refundedAmount: number; lastError?: string; card?: { brand: string; last4: string };
}

export interface PaymentProcessor {
  readonly name: string;
  readonly mode: 'test' | 'live';
  createIntent(input: { amount: number; currency: string; bookingId: string; description: string }): Promise<PaymentIntent>;
  /** `method` is whatever the processor's checkout widget produced (a token for live processors). */
  confirm(intent: PaymentIntent, method: unknown): Promise<PaymentIntent>;
  refund(intent: PaymentIntent, amount: number): Promise<PaymentIntent>;
  /** Public, non-secret settings the checkout page needs (e.g. a publishable key). */
  clientConfig(): Record<string, unknown>;
}
