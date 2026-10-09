# Supplier fixtures (Duffel and LiteAPI)

Answers shaped like the suppliers' documented responses, for the unit tests of `server/business/suppliers/**`
(real-suppliers design §7.1). The tests reach them only through `test/supplier-fetch.js`, an injected `fetch`:
no test ever calls a supplier.

- Every file starts with `_source`, naming the documentation page its shape follows. `_status` (the HTTP status)
  and `_headers` (response headers such as `x-request-id` and `ratelimit-*`) are optional. The loader
  (`supplier-fetch.js` `loadFixture`) strips all three; the rest is the response body exactly as sent.
- Ids, names and amounts are made up (`off_0000AAAA…`, `offer_PLACEHOLDER_…`, `lp1001`…). No file holds a key, a
  token or anything shaped like one; the tests build their fake keys at run time (`duffel_test_` and `sand_`
  plus placeholder text).

## Sources

| Id | Page | Used for |
|---|---|---|
| D-ORQ | https://duffel.com/docs/api/v2/offer-requests/create-offer-request | `duffel/offer-request.*.json`: the `data` envelope, `live_mode`, `offers[]`, `slices`, `passengers` |
| D-OFF | https://duffel.com/docs/api/v2/offers/get-offer-by-id | `duffel/offer.get*.json`: one offer, a changed `total_amount` |
| D-OTYPES | https://raw.githubusercontent.com/duffelhq/duffel-api-javascript/main/src/booking/Offers/OfferTypes.ts | Field types: `tax_amount`/`tax_currency` string or null, `fare_brand_name` may be null, segment `duration` string or null, segment `stops[]`, `baggages[] { type: 'checked'\|'carry_on', quantity }` |
| D-ORDT | https://raw.githubusercontent.com/duffelhq/duffel-api-javascript/main/src/booking/Orders/OrdersTypes.ts | `departing_at`/`arriving_at` in the airport's own time zone; `Stop { airport, arriving_at, departing_at, duration }` |
| D-TYPES | https://raw.githubusercontent.com/duffelhq/duffel-api-javascript/main/src/types/shared.ts | `refund_before_departure`/`change_before_departure` `{ allowed, penalty_amount, penalty_currency }` or null; change penalties on the slices |
| D-AIRT | https://raw.githubusercontent.com/duffelhq/duffel-api-javascript/main/src/supportingResources/Airlines/AirlinesTypes.ts | Airline `iata_code` may be null |
| D-ERR | https://duffel.com/docs/api/overview/errors | `duffel/error.*.json`: `meta { status, request_id }`, `errors[] { type, code, title, message, documentation_url, source }`; `ratelimit-reset` as an RFC 2616 date; `airline_internal` 504 |
| D-AIR | https://duffel.com/docs/api/v2/airlines | `duffel/airlines.page1.json` |
| L-RATES | https://docs.liteapi.travel/reference/post_hotels-rates | `liteapi/rates.*.json`: `data[]`, `hotels[] { id, name, address, city_name, stars, … }`, `guestLevel`, `sandbox` |
| L-STRUCT | https://docs.liteapi.travel/docs/hotel-rates-api-json-data-structure | `roomTypes[].offerId`, `rates[].retailRate.total[]`, `taxesAndFees` (null means all included), `cancellationPolicies { cancelPolicyInfos[], refundableTag }` |
| L-PRE | https://docs.liteapi.travel/reference/post_rates-prebook | `liteapi/prebook*.json`: `data { prebookId, price, priceDifferencePercent, cancellationChanged, boardChanged, roomTypes }`; 408 codes 4016 and 4040 |
| L-ERRW | https://docs.liteapi.travel/reference/api-errors-for-hotel-booking-workflow | `error { code, description, message }`; rates 2001 (HTTP 200), prebook 2001 (HTTP 409), 4290 (HTTP 429), 4291 (HTTP 5xx) |
| L-RL | https://docs.liteapi.travel/reference/rate-limiting | `liteapi/error.429.json` |

## What each Duffel fixture holds

`offer-request.cai-lhr.json` (CAI to LHR, Thursday 12 November 2026, economy, 1 adult; Cairo is UTC+2 that day,
London UTC+0):

| Itinerary | Flights | Fares |
|---|---|---|
| I1 | ZZ1234, 08:35 to 12:50 | Basic 245.30 (no refund, no changes), Standard 289.90 (refund fee 50.00 USD, change fee 25.00 USD), Flexible 412.00 (free), and a first-class fare (left out) |
| I2 | ZZ88, 13:40 to 17:55 | Basic 221.10 (refund condition null), Standard 268.40 (change fee given only on the slice, refund fee in GBP), Saver 180.00 GBP (another currency) |
| I3 | ZZ402 CAI to IST, ZZ403 IST to LHR | no brand with change null at both levels (199.00), Standard with `tax_amount` null (236.00), Upgrade mixing economy and business (left out) |
| I4 | ZZ990 with a stop in Athens inside the segment | Basic 210.00, Standard 255.00 |
| I5 | ZZ77 sold by ZZ, operated by EgyptAir, `duration` null | Basic 260.00, Standard 300.00 |
| I6 | BA154 sold by British Airways | no brand, "Economy Basic", 330.00 |
| I7 | ZZ555 sold by an owner with `iata_code` null | left out |

Every offer expires at 09:30 UTC on 9 October 2026 (the tests' clock starts at 09:00).
