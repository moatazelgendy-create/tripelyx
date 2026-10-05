// Real supplier adapters, keyed by vertical then by the value of <VERTICAL>_PROVIDER.
//
// To connect a live supplier:
//   1. Write an adapter class in this folder that implements the vertical's interface (see
//      ../types.d.ts and ../contracts.js) and maps the vendor's API into normalized Offers/Quotes.
//      Read credentials from process.env inside the adapter — never from the browser.
//   2. Register it below, e.g.  hotels: { acmebeds: env => new AcmeBedsHotelProvider(env) }
//   3. Set HOTEL_PROVIDER=acmebeds (and the adapter's own credentials) in that environment.
// Nothing in the booking engine, payments, routes or UI changes.
module.exports = {
  hotels: {},
  flights: {},
  cars: {},
  cruises: {},
  yachts: {},
  transfers: {},
  activities: {},
  experiences: {},
};
