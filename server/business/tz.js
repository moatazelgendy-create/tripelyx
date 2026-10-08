// Time zones for Tripelyx Business (plan §F2, §C5, §E3): flight times local to each airport, "today" and
// budget periods in the company's time zone, and approval expiry at the departure's local midnight.
// Built on Intl.DateTimeFormat (timeZoneName 'longOffset'), so daylight saving time follows the ICU data
// Node ships. Pure: callers pass every instant (from the injected clock); nothing here reads the clock.
//
// Built in Stage 0 rather than stubbed (plan step 10 lists it as a stub): the policy engine, the lifecycle,
// the request service, the demo flights and the views all need it, and they are built in parallel. Stage 1I
// owns this file from here on and may add functions, but never changes these signatures.
//
// Local wall-clock times are 'YYYY-MM-DDTHH:MM' strings with no offset; dates are 'YYYY-MM-DD'.

const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/;
const OFFSET_RE = /^GMT(?:([+-])(\d{2}):?(\d{2})?)?$/;
const MINUTE = 60000;

const formatters = new Map();
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    if (typeof timeZone !== 'string' || !timeZone) throw new Error('[business] a time zone name is required');
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    } catch {
      throw new Error(`[business] unknown time zone ${timeZone}`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** An instant (Date, epoch milliseconds or ISO string) as epoch milliseconds; throws on anything else. */
function ms(instant) {
  const t = instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : typeof instant === 'string' ? Date.parse(instant) : NaN;
  if (!Number.isFinite(t)) throw new Error('[business] not a valid instant');
  return t;
}

/**
 * Is this an IANA time zone name Intl knows ('Africa/Cairo', 'UTC')?
 * @param {unknown} timeZone
 * @returns {boolean}
 */
function isTimeZone(timeZone) {
  try { formatter(timeZone); return true; } catch { return false; }
}

/**
 * Minutes east of UTC in `timeZone` at that instant (DST-correct): Cairo on 2026-10-09 → 180, on
 * 2026-11-12 → 120; London on 2026-11-12 → 0.
 * @param {string} timeZone IANA name
 * @param {Date|number|string} instant
 * @returns {number}
 * @throws {Error} unknown time zone or invalid instant (a programming error, not a 4xx)
 */
function offsetMinutes(timeZone, instant) {
  const part = formatter(timeZone).formatToParts(new Date(ms(instant))).find(p => p.type === 'timeZoneName');
  const m = OFFSET_RE.exec(part ? part.value : '');
  if (!m) throw new Error(`[business] cannot read the offset of ${timeZone}`);
  if (!m[1]) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === '-' ? -minutes : minutes;
}

/**
 * The wall-clock time in `timeZone` at that instant, 'YYYY-MM-DDTHH:MM' (seconds dropped).
 * @param {string} timeZone
 * @param {Date|number|string} instant
 * @returns {string}
 */
function utcToLocal(timeZone, instant) {
  const t = ms(instant);
  return new Date(t + offsetMinutes(timeZone, t) * MINUTE).toISOString().slice(0, 16);
}

/**
 * The date in `timeZone` at that instant: a company's "today" is localDate(org.timezone, now()).
 * @param {string} timeZone
 * @param {Date|number|string} instant
 * @returns {string} 'YYYY-MM-DD'
 */
function localDate(timeZone, instant) {
  return utcToLocal(timeZone, instant).slice(0, 10);
}

/**
 * The instant a local wall-clock time happens in `timeZone`. A time skipped by a spring-forward change
 * moves forward by the size of the gap (London 01:30 on the change day reads as 02:30, like Temporal's
 * 'compatible' choice); a repeated time (fall back) resolves to its first occurrence.
 * @param {string} timeZone
 * @param {string} local 'YYYY-MM-DDTHH:MM' or 'YYYY-MM-DD' (midnight)
 * @returns {Date}
 * @throws {Error} malformed local time
 */
function localToUtc(timeZone, local) {
  const m = LOCAL_RE.exec(String(local));
  if (!m) throw new Error('[business] a local time must be YYYY-MM-DD or YYYY-MM-DDTHH:MM');
  const wall = Date.parse(`${m[1]}T${m[2] || '00'}:${m[3] || '00'}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 10) !== m[1] || Number(m[2] || 0) > 23 || Number(m[3] || 0) > 59) {
    throw new Error('[business] not a real local time');
  }
  // Try the offsets in force a day either side of the wall time, earliest instant first: the one whose
  // local reading gives back the same wall time wins (both do in a repeated hour: the earlier is taken).
  const offsets = [...new Set([offsetMinutes(timeZone, wall - 86400000), offsetMinutes(timeZone, wall), offsetMinutes(timeZone, wall + 86400000)])];
  const candidates = offsets.map(o => wall - o * MINUTE).sort((a, b) => a - b);
  for (const t of candidates) {
    if (t + offsetMinutes(timeZone, t) * MINUTE === wall) return new Date(t);
  }
  // In a spring-forward gap no candidate reads back: use the offset from before the change, which moves
  // the time forward by the gap.
  return new Date(wall - Math.min(...offsets) * MINUTE);
}

/**
 * The instant a date's local midnight happens in `timeZone`, as an ISO string (approval expiry: no later
 * than the departure's local midnight in the company's time zone).
 * @param {string} timeZone
 * @param {string} date 'YYYY-MM-DD'
 * @returns {string}
 */
function localMidnightUtc(timeZone, date) {
  return localToUtc(timeZone, `${date}T00:00`).toISOString();
}

module.exports = { isTimeZone, offsetMinutes, utcToLocal, localDate, localToUtc, localMidnightUtc };
