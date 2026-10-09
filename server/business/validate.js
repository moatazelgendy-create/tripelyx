// Field validators for Tripelyx Business forms. Each one returns the clean value or throws
// AppError('invalid_field', <message for that field>, 422). `collect()` runs several and turns their
// messages into one AppError(code, 'Check the highlighted fields.', 422, details) for the form to show.
// Money is integer cents and percentages are integer tenths, parsed with string arithmetic (never floats).
const { AppError } = require('../lib/errors');
const { str, EMAIL, localPath } = require('../lib/validate');

const invalid = message => new AppError('invalid_field', message, 422);
const blankish = v => v === undefined || v === null || String(v).trim() === '';

/**
 * Invisible and direction-changing characters: soft hyphen, combining grapheme joiner, Arabic letter mark,
 * Mongolian vowel separator, zero-width space / non-joiner / joiner, LRM / RLM, the bidi embeddings and
 * overrides (U+202A-202E), word joiner and invisible operators (U+2060-2064), the bidi isolates and
 * deprecated format controls (U+2066-206F) and the BOM. They let "Trip\u200belyx" or a reversed name behind
 * U+202E pass a word check while rendering as something else, so text() removes them.
 */
const INVISIBLE_CHARS = '\\u00ad\\u034f\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff';
const INVISIBLE = new RegExp(`[${INVISIBLE_CHARS}]`, 'g');
const HAS_INVISIBLE = new RegExp(`[${INVISIBLE_CHARS}]`);

/** "$2,000" or "$12.50" from cents (validator messages only; views format money themselves). */
function dollars(cents) {
  const whole = Math.floor(cents / 100), part = cents % 100;
  return `$${whole.toLocaleString('en-US')}${part ? `.${String(part).padStart(2, '0')}` : ''}`;
}

/**
 * Dollars typed in a form → integer cents. Accepts "$1,000.50", "25", "25.5"; strips `$`, `,` and spaces;
 * at most 7 whole digits and 2 decimals ("1.005" is refused, never rounded).
 * @param {unknown} v
 * @param {{ max?: number, blank?: number|null }} [opts] max in cents; `blank` is returned for an empty field
 *   (leave it out to make the field required)
 * @returns {number|null}
 */
function dollarsToCents(v, { max = Infinity, blank } = {}) {
  if (blankish(v)) {
    if (blank !== undefined) return blank;
    throw invalid('Enter an amount.');
  }
  // One optional leading $, and commas only as thousands separators ("1,00" is refused, not read as 100).
  const s = String(v).replace(/\s/g, '').replace(/^\$/, '');
  const m = /^((?:\d{1,3}(?:,\d{3})+)|\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw invalid('Enter an amount in dollars, like 25 or 25.50.');
  const whole = m[1].replace(/,/g, '');
  if (whole.length > 7) throw invalid('Enter an amount in dollars, like 25 or 25.50.');
  const cents = Number(whole) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (cents > max) throw invalid(`The most you can enter is ${dollars(max)}.`);
  return cents;
}

/**
 * A percentage typed in a form → integer tenths ("7.5" → 75, "13.7%" → 137). Up to 2 digits and 1 decimal.
 * @param {unknown} v
 * @param {{ max?: number, blank?: number|null }} [opts] max in tenths; `blank` is returned for an empty field
 * @returns {number|null}
 */
function percentTenths(v, { max = 999, blank } = {}) {
  if (blankish(v)) {
    if (blank !== undefined) return blank;
    throw invalid('Enter a percentage.');
  }
  const s = String(v).replace(/[%\s]/g, '');
  const m = /^(\d{1,2})(?:\.(\d))?$/.exec(s);
  if (!m) throw invalid('Enter a percentage, like 10 or 7.5.');
  const tenths = Number(m[1]) * 10 + Number(m[2] || 0);
  if (tenths > max) throw invalid(`The most you can enter is ${max / 10}%.`);
  return tenths;
}

/**
 * An email address, lowercased (≤120 characters). Invisible and bidi control characters are refused.
 * @param {unknown} v
 * @param {{ optional?: boolean }} [opts]
 * @returns {string}
 */
function email(v, { optional = false } = {}) {
  const s = str(v, 121).toLowerCase();
  if (!s) {
    if (optional) return '';
    throw invalid('Enter an email address.');
  }
  if (s.length > 120 || !EMAIL.test(s) || HAS_INVISIBLE.test(s)) throw invalid('Enter a valid email address.');
  return s;
}

/**
 * A phone number as typed (digits, spaces, + ( ) - .), ≤30 characters. Views build tel: links from its
 * digits and + only.
 * @param {unknown} v
 * @param {{ optional?: boolean }} [opts]
 * @returns {string}
 */
function phone(v, { optional = false } = {}) {
  const s = str(v, 31);
  if (!s) {
    if (optional) return '';
    throw invalid('Enter a phone number.');
  }
  if (s.length > 30 || !/^[+\d][\d\s().-]{5,}$/.test(s) || (s.match(/\d/g) || []).length < 6) throw invalid('Enter a valid phone number.');
  return s;
}

/**
 * Free text: NFKC-normalized (fullwidth and compatibility letters become plain ones), invisible and bidi
 * control characters removed, other control characters (C0, C1, U+2028/2029) turned into spaces (newlines
 * are kept when `multiline`), trimmed, cut to `max`. Word checks on names (such as refusing "tripelyx")
 * should run on this cleaned value, lowercased.
 * @param {unknown} v
 * @param {number} max
 * @param {{ multiline?: boolean, required?: boolean }} [opts]
 * @returns {string}
 */
function text(v, max, { multiline = false, required = false } = {}) {
  const raw = (v === undefined || v === null ? '' : String(v)).normalize('NFKC').replace(INVISIBLE, '')
    .replace(/[\u0080-\u009f\u2028\u2029]/g, ' ');
  let s;
  if (multiline) {
    s = raw.replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max).trim();
  } else {
    s = str(raw, max);
  }
  if (required && !s) throw invalid('Fill in this field.');
  return s;
}

/**
 * One of a fixed list of values. `blank` is returned for an empty field (leave it out to require a choice).
 * @template T
 * @param {unknown} v
 * @param {ReadonlyArray<T>} list
 * @param {{ blank?: any }} [opts]
 * @returns {T}
 */
function oneOf(v, list, { blank } = {}) {
  if (blankish(v) && blank !== undefined) return blank;
  const s = String(v ?? '');
  const hit = list.find(x => String(x) === s);
  if (hit === undefined) throw invalid('Choose one of the options.');
  return hit;
}

/**
 * A same-site path for redirects ("/business/o/x"), or `fallback`. The shared rule (lib/validate.localPath):
 * refuses "//host", "/\host", absolute URLs and control characters, and keeps at most 300 characters.
 * @param {unknown} path
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
function safeLocal(path, fallback = null) {
  return localPath(path, fallback);
}

/**
 * Run several field validators and gather their messages. Returns `{ field: value }`, or throws
 * AppError(code, 'Check the highlighted fields.', 422, { field: message }). Errors other than
 * invalid_field pass through untouched.
 * @param {string} code e.g. 'invalid_pricing'
 * @param {Record<string, () => any>} fields
 * @returns {Record<string, any>}
 */
function collect(code, fields) {
  const out = {}, details = {};
  for (const [name, fn] of Object.entries(fields)) {
    try { out[name] = fn(); } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'invalid_field') throw e;
      details[name] = e.message;
    }
  }
  if (Object.keys(details).length) throw new AppError(code, 'Check the highlighted fields.', 422, details);
  return out;
}

module.exports = { dollarsToCents, percentTenths, email, phone, text, oneOf, safeLocal, collect, dollars };
