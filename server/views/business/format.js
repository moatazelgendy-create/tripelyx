// Tripelyx Business view formatting: money, travel dates, and times in the company's time zone (plan §B6,
// §F6). Pure: every instant is passed in (ctx.now() or a stored ISO time), nothing here reads the clock.
//
// Times a company acts on (priced at, waiting since, expires at, activity) read in the company's own time
// zone and name it: "3:42 PM, Fri 9 Oct (Cairo time)". Flight times are already local to each airport
// (RowSegment.departLocal) and read on a 24-hour clock ("08:35"), as the alternatives' give-ups do. Travel
// dates are 'YYYY-MM-DD' and read "Thu 12 Nov". Twelve-hour times are built by hand, so they never pick up
// the narrow no-break space newer ICU data puts before "PM".
//
// Price sources (real-suppliers design §2.3): every amount says where it came from. pricedAtText names the
// source: demo "Demo price · Priced at …" (unchanged), supplier test data "Supplier test data, not a real
// fare · Checked at …" (a hotel: "not a real room rate"; a whole trip or a total: "not a real price"), live
// prices "US dollars, from the airline · Priced at … · Can change until booked" (go-live design §5.6). A live
// label names who priced the amount, by its `kind` (priceKind/tripKind work it out from the rows): one
// airline's fare, several airlines' fares, the hotel supplier's room, a trip with both, or, when the rows don't
// say how many airlines (a list row of a return trip), "our airline suppliers" or "our airline and hotel
// suppliers", never a count it doesn't know. SOURCE_TOTALS are the labels of tiles that add many requests up
// (budgets, reports, home).
const tz = require('../../business/tz');
const { format } = require('../../lib/money');
const { isSource, sourceOf, leastReal, requestSource, SEARCH_CLOSED } = require('../../business/source');

const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The time zone to show times in: the company's when Intl knows it, else UTC (a view never throws on it). */
function safeZone(timeZone) {
  return tz.isTimeZone(timeZone) ? timeZone : 'UTC';
}

/** 'Africa/Cairo' → 'Cairo time', 'America/Los_Angeles' → 'Los Angeles time', 'UTC' → 'UTC'. */
function zoneLabel(timeZone) {
  const z = safeZone(timeZone);
  if (z === 'UTC' || z === 'Etc/UTC') return 'UTC';
  return `${z.split('/').pop().replace(/_/g, ' ')} time`;
}

/** What a bad value was, for the TypeError (never the value itself in full). */
const kindOf = v => (v === null ? 'null' : typeof v === 'number' ? String(v) : typeof v);

/**
 * Cents as dollars: "$2,940", "$12.50"; a negative amount gets a real minus sign ("−$50"). Whole cents only:
 * null, undefined, NaN, a string or a fraction throws a TypeError, so a missing amount (no budget set, a
 * recheck with no new total) can never read as a "$0" price. The page says why there is no amount instead.
 * @param {number} cents a safe integer
 */
function money(cents) {
  if (!Number.isSafeInteger(cents)) throw new TypeError(`[business] money() needs whole cents, got ${kindOf(cents)}`);
  if (cents === 0) return format(0, 'USD');
  return cents < 0 ? `−${format(-cents, 'USD')}` : format(cents, 'USD');
}

/** "1 night", "3 nights"; `many` for an irregular plural. */
function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

/**
 * Integer tenths of a percent as text: 200 → "20%", 125 → "12.5%". Like money(), a missing share (null when
 * nothing was submitted) throws a TypeError instead of reading "0%".
 * @param {number} tenths a safe integer
 */
function percent(tenths) {
  if (!Number.isSafeInteger(tenths)) throw new TypeError(`[business] percent() needs whole tenths, got ${kindOf(tenths)}`);
  return `${tenths % 10 ? (tenths / 10).toFixed(1) : tenths / 10}%`;
}

/** Minutes as a duration: 304 → "5h 04m", 120 → "2h", 45 → "45m". */
function duration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60), m = total % 60;
  if (!h) return `${m}m`;
  return `${h}h${m ? ` ${String(m).padStart(2, '0')}m` : ''}`;
}

/**
 * A travel date: '2026-11-12' → "Thu 12 Nov" ("Thu 12 Nov 2026" with { year: true }). Anything that is not a
 * real 'YYYY-MM-DD' date comes back as given.
 * @param {string} date
 * @param {{ year?: boolean }} [opts]
 */
function day(date, { year = false } = {}) {
  const m = DATE_RE.exec(String(date || ''));
  if (!m) return String(date || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== m[0]) return m[0];
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
}

/** "Thu 12 Nov to Mon 16 Nov"; one date alone when there is no end ("Thu 12 Nov"). */
function dayRange(from, to) {
  return to ? `${day(from)} to ${day(to)}` : day(from);
}

/** A local wall time 'YYYY-MM-DDTHH:MM' on a 24-hour clock: "08:35". */
function clock24(local) {
  const m = LOCAL_RE.exec(String(local || ''));
  return m ? `${m[2]}:${m[3]}` : '';
}

/** 'HH:MM' (24-hour) as "4:10 PM", "12:05 AM". */
function twelve(hh, mm) {
  const h = Number(hh);
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The time of an instant in a zone: "4:10 PM". */
function timeIn(timeZone, iso) {
  const local = tz.utcToLocal(safeZone(timeZone), iso);
  return twelve(local.slice(11, 13), local.slice(14, 16));
}

/** The date of an instant in a zone: "Fri 9 Oct" ("Fri 9 Oct 2026" with { year: true }). */
function dayIn(timeZone, iso, opts) {
  return day(tz.localDate(safeZone(timeZone), iso), opts);
}

/**
 * An instant with its day, in the company's zone and named: "4:10 PM, Fri 9 Oct (Cairo time)".
 * @param {string} timeZone
 * @param {string|Date|number} iso
 * @param {{ zone?: boolean, year?: boolean }} [opts] zone false leaves out "(Cairo time)"
 */
function dateTimeIn(timeZone, iso, { zone = true, year = false } = {}) {
  return `${timeIn(timeZone, iso)}, ${dayIn(timeZone, iso, { year })}${zone ? ` (${zoneLabel(timeZone)})` : ''}`;
}

/**
 * An instant said relative to now, in the company's zone: "4:10 PM today", "4:10 PM tomorrow",
 * "4:10 PM yesterday", otherwise "4:10 PM, Fri 9 Oct". `zone` adds "(Cairo time)".
 * @param {string} timeZone
 * @param {string|Date|number} iso
 * @param {{ now: string|Date|number, zone?: boolean }} opts
 */
function whenIn(timeZone, iso, { now, zone = false }) {
  const z = safeZone(timeZone);
  const at = tz.localDate(z, iso), today = tz.localDate(z, now);
  const diff = Math.round((Date.parse(`${at}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
  const rel = diff === 0 ? ' today' : diff === 1 ? ' tomorrow' : diff === -1 ? ' yesterday' : `, ${day(at)}`;
  return `${timeIn(z, iso)}${rel}${zone ? ` (${zoneLabel(z)})` : ''}`;
}

/**
 * What a supplier label calls the amount, by its kind: a flight's fare, a hotel's room rate, or any other price
 * (a kind that names more than one thing is a price). Supplier test data only.
 */
const TEST_NOUNS = Object.freeze({ fare: 'fare', room: 'room rate', price: 'price' });
/**
 * Who priced a live amount, by its kind (go-live design §5.6): 'fare' one airline's fare, 'fares' fares of
 * more than one airline, 'room' a hotel room, 'fareRoom' and 'faresRoom' a trip with flights and a hotel,
 * 'flights' flights on airlines the caller can't count, 'price' anything else (the suppliers in general). No
 * supplier is named: companies and travelers see only "the airline" and "the hotel supplier".
 */
const LIVE_FROM = Object.freeze({
  fare: 'the airline',
  fares: 'the airlines',
  room: 'the hotel supplier',
  fareRoom: 'the airline and the hotel supplier',
  faresRoom: 'the airlines and the hotel supplier',
  flights: 'our airline suppliers',
  price: 'our airline and hotel suppliers',
});
/** Every price kind a label takes. */
const PRICE_KINDS = Object.freeze(Object.keys(LIVE_FROM));
/** The end of every live amount's label (go-live design §5.6). */
const CAN_CHANGE = 'Can change until booked';

/**
 * The label every amount carries (§F6), by where it came from: "Demo price · Priced at 3:42 PM, Fri 9 Oct
 * (Cairo time)"; supplier test data "Supplier test data, not a real fare · Checked at 3:42 PM, Fri 9 Oct (Cairo
 * time)"; live "US dollars, from the airline · Priced at 3:42 PM, Fri 9 Oct (Cairo time) · Can change until
 * booked" (hotels "from the hotel supplier"). Without a time, the label without "Priced at".
 * @param {string|null} pricedAt
 * @param {string} timeZone
 * @param {{ source?: import('../../business/types').PriceSource, kind?: string }} [opts] kind: one of
 *   PRICE_KINDS ('price' for anything else)
 */
function pricedAtText(pricedAt, timeZone, { source = 'demo', kind = 'price' } = {}) {
  if (source === 'sandbox') {
    const label = `Supplier test data, not a real ${Object.hasOwn(TEST_NOUNS, kind) ? TEST_NOUNS[kind] : TEST_NOUNS.price}`;
    return pricedAt ? `${label} · Checked at ${dateTimeIn(timeZone, pricedAt)}` : label;
  }
  if (source === 'live') {
    const label = `US dollars, from ${Object.hasOwn(LIVE_FROM, kind) ? LIVE_FROM[kind] : LIVE_FROM.price}`;
    return pricedAt ? `${label} · Priced at ${dateTimeIn(timeZone, pricedAt)} · ${CAN_CHANGE}` : `${label} · ${CAN_CHANGE}`;
  }
  return pricedAt ? `Demo price · Priced at ${dateTimeIn(timeZone, pricedAt)}` : 'Demo price';
}

/**
 * The price kind of a trip from what it holds: how many flights and on how many airlines (null when the
 * airlines are not known), and whether it has a hotel. One flight is one airline's fare. Two or more flights
 * on airlines not known (a list row of a return trip: each way is its own ticket, maybe on one airline, maybe
 * on two) name no count: 'flights', or 'price' with a hotel.
 * @param {{ flights?: number, carriers?: number|null, hotel?: boolean }} t
 * @returns {string} one of PRICE_KINDS
 */
function tripKind({ flights = 0, carriers = null, hotel = false } = {}) {
  const n = Number.isSafeInteger(flights) && flights > 0 ? flights : 0;
  if (!n) return hotel ? 'room' : 'price';
  const known = Number.isSafeInteger(carriers) && carriers > 0;
  if (n > 1 && !known) return hotel ? 'price' : 'flights';
  const many = n > 1 && carriers > 1;
  if (!hotel) return many ? 'fares' : 'fare';
  return many ? 'faresRoom' : 'fareRoom';
}

/**
 * The price kind of some rows (a search's, a trip's out, back and hotel): the airlines that sell the flights
 * (row.carrier), and whether a hotel is among them. 'price' when there are none.
 * @param {Array<object|null|undefined>} rows
 */
function priceKind(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object');
  const flights = list.filter(r => r.kind !== 'hotel');
  const carriers = new Set(flights.map(r => (r.carrier && r.carrier.code) || r.offerId || r.key));
  return tripKind({ flights: flights.length, carriers: carriers.size, hotel: list.some(r => r.kind === 'hotel') });
}

/**
 * The price kind of a list row (types.RequestRow): one flight, or two for a return (on airlines the row doesn't
 * name), and a hotel when it has one.
 */
const requestRowKind = row => tripKind({ flights: row && row.returnDate ? 2 : 1, hotel: Boolean(row && row.hotelCity) });

/** The rows of a trip (a request's or an alternative's `rows`: out, back, hotel). */
const tripRows = rows => (rows && typeof rows === 'object' ? ['out', 'back', 'hotel'].map(c => rows[c]) : []);

/** The price kind of a stored request: its own rows. */
const requestKind = request => priceKind(tripRows(request && request.rows));

/**
 * The kind a label of `source` takes for some rows: who priced them on live prices, 'price' otherwise (so demo
 * and supplier test data labels read as they always have).
 * @param {unknown} source
 * @param {Array<object|null|undefined>} rows
 */
const liveKind = (source, rows) => (source === 'live' ? priceKind(rows) : 'price');

/**
 * The label of a tile that adds many requests up (budgets, reports, home), by their least real source. Live:
 * each request was priced at its own time, so no one time is named.
 */
const SOURCE_TOTALS = Object.freeze({ demo: 'Demo prices', sandbox: 'Includes supplier test data', live: `US dollars, from ${LIVE_FROM.price}, as each trip was priced · ${CAN_CHANGE}` });

/**
 * Where an inventory's prices come from (types.BusinessInventory.source; the frozen fakes carry none, so the
 * status says it), or null with no supplier.
 * @param {object|null|undefined} inventory
 * @returns {import('../../business/types').PriceSource|null}
 */
function inventorySource(inventory) {
  if (!inventory || inventory.status === 'none') return null;
  if (isSource(inventory.source)) return inventory.source;
  return isSource(inventory.status) ? inventory.status : null;
}

/** The workspace's price source: ctx.business.inventory's (null with no supplier). */
const ctxSource = ctx => inventorySource(ctx && ctx.business ? ctx.business.inventory : null);

/** Whether trips can be searched here: some inventory runs (demo, supplier test data or live), not 'none'. */
const searchable = ctx => Boolean(ctx && ctx.business && ctx.business.inventory && ctx.business.inventory.status !== 'none');

/**
 * Live search waits for the company's confirmation (go-live design §5.5): with live prices only a confirmed
 * ('active') company searches. True when the inventory is live and the company is not confirmed yet. Demo
 * inventory and supplier test data keep letting a pending company try a trip.
 * @param {object} ctx
 * @param {{ status?: string }|null|undefined} org
 */
const awaitingConfirmation = (ctx, org) => Boolean(ctx && ctx.business && ctx.business.inventory
  && ctx.business.inventory.status === 'live' && org && org.status !== 'active');

/** Whether this company can search now: some inventory runs, and live search has its confirmation. */
const searchOpen = (ctx, org) => searchable(ctx) && !awaitingConfirmation(ctx, org);

/**
 * What a company waiting for confirmation is told where search would be (go-live design §5.5): the very sentence
 * the service refuses such a search with (source.SEARCH_CLOSED, 409 'company_not_confirmed'), so a search typed
 * in by hand says what the pages say.
 */
const SEARCH_AFTER_CONFIRM = SEARCH_CLOSED;

/** The least real source of some rows (a trip's out, back and hotel), 'demo' when there are none. */
const rowsSource = rows => leastReal((rows || []).filter(Boolean).map(r => sourceOf(r))) || 'demo';

/**
 * The source a total of many requests is labelled with (real-suppliers design §2.3), the rule of the service's
 * ReportTiles/DashboardView priceSource: any supplier test data among them makes it 'sandbox' ("Includes
 * supplier test data"); otherwise the least real of them. A value that is not a source counts as demo (a
 * request stored before real suppliers); null for none.
 * @param {Iterable<unknown>} sources
 * @returns {import('../../business/types').PriceSource|null}
 */
function totalsSource(sources) {
  const list = [...sources];
  return list.includes('sandbox') ? 'sandbox' : leastReal(list);
}

/**
 * How long until an instant, rounded down so it never says more time is left than there is: "45 min",
 * "6 h", "3 days" ("under 1 min" in the last minute). null once the moment has passed (the caller says
 * "Expired").
 * @param {string|Date|number} now
 * @param {string|Date|number} until
 * @returns {string|null}
 */
function timeLeft(now, until) {
  const ms = new Date(until).getTime() - new Date(now).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < MINUTE) return 'under 1 min';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < 2 * DAY) return `${Math.floor(ms / HOUR)} h`;
  return plural(Math.floor(ms / DAY), 'day');
}

module.exports = {
  safeZone, zoneLabel, money, plural, percent, duration, day, dayRange, clock24, timeIn, dayIn, dateTimeIn, whenIn,
  pricedAtText, timeLeft, WEEKDAYS, MONTHS,
  SOURCE_TOTALS, inventorySource, ctxSource, rowsSource, totalsSource, sourceOf, leastReal, requestSource, isSource,
  searchable, searchOpen, awaitingConfirmation, SEARCH_AFTER_CONFIRM,
  // Live labels (go-live design §5.6)
  LIVE_FROM, PRICE_KINDS, CAN_CHANGE, tripKind, priceKind, requestRowKind, requestKind, tripRows, liveKind,
};
