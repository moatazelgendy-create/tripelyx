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
// prices "US dollars, from the airline · Priced at … · Can change until booked". SOURCE_TOTALS are the labels
// of tiles that add many requests up (budgets, reports, home).
const tz = require('../../business/tz');
const { format } = require('../../lib/money');
const { isSource, sourceOf, leastReal, requestSource } = require('../../business/source');

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

/** What a supplier label calls the amount: a flight's fare, a hotel's room rate, or any other price. */
const TEST_NOUNS = Object.freeze({ fare: 'fare', room: 'room rate', price: 'price' });
const LIVE_FROM = Object.freeze({ fare: 'the airline', room: 'the hotel supplier', price: 'airlines and hotels' });

/**
 * The label every amount carries (§F6), by where it came from: "Demo price · Priced at 3:42 PM, Fri 9 Oct
 * (Cairo time)"; supplier test data "Supplier test data, not a real fare · Checked at 3:42 PM, Fri 9 Oct (Cairo
 * time)"; live "US dollars, from the airline · Priced at 3:42 PM, Fri 9 Oct (Cairo time) · Can change until
 * booked". Without a time, just the first part.
 * @param {string|null} pricedAt
 * @param {string} timeZone
 * @param {{ source?: import('../../business/types').PriceSource, kind?: 'fare'|'room'|'price' }} [opts]
 */
function pricedAtText(pricedAt, timeZone, { source = 'demo', kind = 'price' } = {}) {
  if (source === 'sandbox') {
    const label = `Supplier test data, not a real ${TEST_NOUNS[kind] || TEST_NOUNS.price}`;
    return pricedAt ? `${label} · Checked at ${dateTimeIn(timeZone, pricedAt)}` : label;
  }
  if (source === 'live') {
    const label = `US dollars, from ${LIVE_FROM[kind] || LIVE_FROM.price}`;
    return pricedAt ? `${label} · Priced at ${dateTimeIn(timeZone, pricedAt)} · Can change until booked` : `${label} · Can change until booked`;
  }
  return pricedAt ? `Demo price · Priced at ${dateTimeIn(timeZone, pricedAt)}` : 'Demo price';
}

/** The label of a tile that adds many requests up (budgets, reports, home), by their least real source. */
const SOURCE_TOTALS = Object.freeze({ demo: 'Demo prices', sandbox: 'Includes supplier test data', live: 'Supplier prices' });

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
  searchable,
};
