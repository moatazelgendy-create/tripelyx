// The platform admin's live check (go-live design §5.4: "Check live connection" on /admin/business, run by
// inventory.liveCheck). Three supplier calls, made on the check's own adapters (suppliers/index.js
// checkAdapters: the shared gate, so they count against the daily caps as the company 'platform', and their
// own latch and cache, so nothing is read from an earlier answer):
//   1. one Duffel offer request, Cairo (CAI) to Dubai (DXB), one adult, economy, 30 days after today (UTC);
//   2. one GET of its cheapest offer (the composer's 'confirm' price check of the cheapest row);
//   3. one LiteAPI rates call for Dubai, one night from the day after the flight (so the outbound arrival never
//      moves the stay and costs a second call), when hotels are connected.
// It reports counts and booleans only, never a price, a name, an offer id or anything from a key: whether each
// answer proved live mode (Duffel's live_mode true on the offer request, every offer and the GET; LiteAPI's
// sandbox false), how many rows came back in US dollars and in another currency, whether every row passed
// dto.assertRow as a live row (offer id in the live namespace, demo false), and how long each call took.
// It passes only when all of that holds with at least one US dollar row per supplier. A mode mismatch is
// reported (mismatch.duffel, mismatch.liteapi) and fails the check; the inventory then turns live search off.
const { sourceOf } = require('../source');

const DAY_MS = 24 * 60 * 60 * 1000;
/** The check's fixed search (§5.4). */
const CHECK_ROUTE = Object.freeze({ from: 'CAI', to: 'DXB', daysAhead: 30, cabin: 'economy' });

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
const errorCode = e => (e && typeof e.code === 'string' && /^[a-z_]{1,40}$/.test(e.code) ? e.code : 'failed');

/**
 * Rows as the check reports them: how many, how many passed as live rows.
 * @param {object[]} rows
 * @param {(row: object) => object} assertRow dto.assertRow
 */
function rowFacts(rows, assertRow) {
  let live = 0;
  for (const r of rows) {
    try {
      assertRow(r);
      if (r.demo === false && sourceOf(r) === 'live') live += 1;
    } catch { /* counted as not live */ }
  }
  const usd = rows.filter(r => r.currency === 'USD').length;
  return { rows: rows.length, usdRows: usd, rowsChecked: rows.length > 0 && live === rows.length };
}

/**
 * Run the check.
 * @param {{ adapters: { flights: object, hotels: object|null, state: { latched: { duffel: boolean, liteapi: boolean } } },
 *   composerFor: (inventory: object) => object, now: () => Date, mono: () => number,
 *   assertRow: (row: object) => object, cityFor: (iata: string) => ({ city: string, country: string }|null) }} deps
 *   composerFor: a TripComposer over a live inventory made of these adapters
 * @returns {Promise<{ passed: boolean, mismatch: { duffel: boolean, liteapi: boolean }, details: object }>}
 *   details is plain JSON (stored with the switch): { route, departDate, flights, offer, hotels }
 */
async function runLiveCheck({ adapters, composerFor, now, mono, assertRow, cityFor }) {
  const { flights, hotels, state } = adapters;
  const today = now().toISOString().slice(0, 10);
  const departDate = addDays(today, CHECK_ROUTE.daysAhead);
  const place = (typeof cityFor === 'function' && cityFor(CHECK_ROUTE.to)) || { city: 'Dubai', country: 'United Arab Emirates' };
  const query = {
    from: CHECK_ROUTE.from, to: CHECK_ROUTE.to, departDate, returnDate: null, cabin: CHECK_ROUTE.cabin, passengers: 1, datesFlexible: false,
    hotel: hotels ? { city: place.city, country: place.country, checkIn: addDays(departDate, 1), checkOut: addDays(departDate, 2) } : null,
  };
  const composer = composerFor({ flights, hotels });
  const details = {
    route: `${CHECK_ROUTE.from} to ${CHECK_ROUTE.to}`, departDate,
    flights: { answered: false, liveMode: null, rows: 0, usdRows: 0, otherCurrency: 0, rowsChecked: false, ms: 0, error: null },
    offer: { answered: false, liveMode: null, available: false, ms: 0, error: null },
    hotels: hotels ? { answered: false, sandbox: null, rows: 0, usdRows: 0, otherCurrency: 0, rowsChecked: false, ms: 0, error: null } : null,
  };

  const t0 = mono();
  let searched = null;
  try {
    searched = await composer.search(query);
  } catch (e) {
    details.flights.error = errorCode(e);
  }
  const searchMs = Math.round(mono() - t0);
  details.flights.ms = searchMs;
  if (searched) {
    const out = searched.legs.out;
    details.flights = {
      ...details.flights, answered: true, ...rowFacts(out.rows, assertRow),
      otherCurrency: out.skipped && Number.isInteger(out.skipped.otherCurrency) ? out.skipped.otherCurrency : 0,
    };
    const leg = searched.legs.hotel;
    if (hotels && leg) {
      details.hotels = {
        ...details.hotels, answered: !leg.error, ms: searchMs, ...rowFacts(leg.rows, assertRow),
        otherCurrency: leg.skipped && Number.isInteger(leg.skipped.otherCurrency) ? leg.skipped.otherCurrency : 0,
        error: leg.error ? 'supplier_unavailable' : null,
      };
    }
  }
  details.flights.liveMode = state.latched.duffel ? false : details.flights.answered ? true : null;
  if (details.hotels) details.hotels.sandbox = state.latched.liteapi ? true : details.hotels.answered ? false : null;

  // The cheapest available US dollar fare, checked again with one GET of its Duffel offer.
  const cheapest = searched ? searched.legs.out.rows.find(r => r.available && r.currency === 'USD') : null;
  if (cheapest && !state.latched.duffel) {
    const t1 = mono();
    try {
      const priced = await composer.price({ out: cheapest.key }, searched.query, { check: 'confirm' });
      details.offer.answered = true;
      details.offer.available = Boolean(priced.rows.out && priced.rows.out.available);
    } catch (e) {
      details.offer.error = errorCode(e);
    }
    details.offer.ms = Math.round(mono() - t1);
    details.offer.liveMode = state.latched.duffel ? false : details.offer.answered ? true : null;
  }

  const f = details.flights, o = details.offer, h = details.hotels;
  const passed = f.answered && f.liveMode === true && f.usdRows > 0 && f.rowsChecked
    && o.answered && o.liveMode === true && o.available
    && (!h || (h.answered && h.sandbox === false && h.usdRows > 0 && h.rowsChecked));
  return { passed: Boolean(passed), mismatch: { duffel: state.latched.duffel === true, liteapi: state.latched.liteapi === true }, details };
}

module.exports = { runLiveCheck, CHECK_ROUTE };
