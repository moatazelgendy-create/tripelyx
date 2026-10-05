// Provider contracts — the seam between Tripelyx and any supplier.
//
// Every vertical has one provider interface (HotelProvider, FlightProvider, CarProvider, CruiseProvider,
// YachtProvider, TransferProvider, ActivityProvider, ExperienceProvider). They share the same five
// methods; what differs per vertical is the query each `search` accepts and the `details` block each
// normalized Offer carries (see ./types.d.ts for the full typed shapes).
//
//   search(query)                      -> Offer[]          normalized, priced for the query
//   getOffer(offerId, query)           -> Offer | null
//   quote({ offerId, optionId, query })-> SupplierQuote    final price lines + cancellation terms
//   book({ quote, traveler, bookingRef }) -> { supplierRef, status }
//   cancel({ supplierRef, reason })    -> { cancelled: true }
//
// The booking engine and the UI only ever see these normalized shapes. A real supplier is added by
// writing an adapter that implements the interface and maps the vendor's API into these shapes; nothing
// above the adapter changes. `assertProvider` runs at boot so a half-written adapter fails loudly
// instead of at a traveler's checkout, and `validateOffer` / `validateQuote` run on every response so a
// supplier changing its payload is caught at the boundary.
const { AppError } = require('../lib/errors');
const { VERTICAL_KEYS } = require('../verticals');

const PROVIDER_METHODS = ['search', 'getOffer', 'quote', 'book', 'cancel'];

const INTERFACE_NAMES = {
  hotels: 'HotelProvider',
  flights: 'FlightProvider',
  cars: 'CarProvider',
  cruises: 'CruiseProvider',
  yachts: 'YachtProvider',
  transfers: 'TransferProvider',
  activities: 'ActivityProvider',
  experiences: 'ExperienceProvider',
};

function assertProvider(provider, vertical) {
  const iface = INTERFACE_NAMES[vertical];
  if (!iface) throw new Error(`Unknown vertical "${vertical}"`);
  if (!provider || typeof provider !== 'object') throw new Error(`${iface}: provider must be an object`);
  if (provider.vertical !== vertical) throw new Error(`${iface}: provider.vertical is "${provider.vertical}", expected "${vertical}"`);
  if (typeof provider.name !== 'string' || !provider.name) throw new Error(`${iface}: provider.name is required`);
  if (typeof provider.isDemo !== 'boolean') throw new Error(`${iface}: provider.isDemo must be a boolean`);
  for (const m of PROVIDER_METHODS) {
    if (typeof provider[m] !== 'function') throw new Error(`${iface} "${provider.name}" is missing ${m}()`);
  }
  return provider;
}

const CANCELLATION_TYPES = ['free', 'partial', 'non_refundable'];

function fail(what, msg) {
  // A malformed supplier payload is our integration bug, not the traveler's — 502, never their fault.
  throw new AppError('provider_payload_invalid', `${what}: ${msg}`, 502);
}

function isMinor(n) {
  return Number.isInteger(n) && n >= 0;
}

function validateMoney(m, what) {
  if (!m || !isMinor(m.amount) || typeof m.currency !== 'string' || m.currency.length !== 3) fail(what, 'invalid money');
}

function validateCancellation(c, what) {
  if (!c || !CANCELLATION_TYPES.includes(c.type)) fail(what, 'invalid cancellation.type');
  if (c.type !== 'non_refundable' && !(Number.isFinite(c.freeUntilHours) && c.freeUntilHours >= 0)) fail(what, 'cancellation.freeUntilHours required');
  if (!(Number.isFinite(c.penaltyPercent) && c.penaltyPercent >= 0 && c.penaltyPercent <= 100)) fail(what, 'cancellation.penaltyPercent must be 0–100');
  if (typeof c.summary !== 'string' || !c.summary) fail(what, 'cancellation.summary required');
}

function validateOffer(o, vertical) {
  const what = `Offer ${o && o.id}`;
  if (!o || typeof o.id !== 'string' || !o.id) fail('Offer', 'id required');
  if (o.vertical !== vertical) fail(what, `vertical must be "${vertical}"`);
  if (typeof o.provider !== 'string') fail(what, 'provider required');
  if (typeof o.demo !== 'boolean') fail(what, 'demo flag required');
  if (typeof o.title !== 'string' || !o.title) fail(what, 'title required');
  if (!o.location || typeof o.location.name !== 'string') fail(what, 'location.name required');
  if (!Array.isArray(o.media)) fail(what, 'media must be an array');
  for (const m of o.media) if (typeof m.url !== 'string' || typeof m.alt !== 'string') fail(what, 'media items need url and alt');
  validateMoney(o.fromPrice, what);
  if (typeof o.fromPrice.unit !== 'string') fail(what, 'fromPrice.unit required');
  if (!Array.isArray(o.options) || !o.options.length) fail(what, 'at least one option required');
  for (const opt of o.options) {
    if (typeof opt.id !== 'string' || typeof opt.name !== 'string') fail(what, 'option id/name required');
    validateMoney(opt.price, `${what} option ${opt.id}`);
    if (typeof opt.available !== 'boolean') fail(what, `option ${opt.id} available flag required`);
  }
  validateCancellation(o.cancellation, what);
  if (!o.details || typeof o.details !== 'object') fail(what, 'details required');
  return o;
}

function validateQuote(q, vertical) {
  const what = 'SupplierQuote';
  if (!q || !q.offer || !q.option) fail(what, 'offer and option required');
  validateOffer(q.offer, vertical);
  if (!Array.isArray(q.lines) || !q.lines.length) fail(what, 'price lines required');
  for (const l of q.lines) {
    if (typeof l.code !== 'string' || typeof l.label !== 'string' || !Number.isInteger(l.amount)) fail(what, 'invalid price line');
    if (!['base', 'tax', 'fee', 'discount'].includes(l.kind)) fail(what, `price line kind "${l.kind}" invalid`);
  }
  if (typeof q.currency !== 'string' || q.currency.length !== 3) fail(what, 'currency required');
  if (typeof q.startDate !== 'string') fail(what, 'startDate required (drives cancellation windows)');
  validateCancellation(q.cancellation, what);
  return q;
}

module.exports = { PROVIDER_METHODS, INTERFACE_NAMES, assertProvider, validateOffer, validateQuote, VERTICAL_KEYS };
