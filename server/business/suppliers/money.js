// Supplier amounts as integer minor units, exactly (real-suppliers design §3.5). Duffel sends decimal strings
// ("245.30"), LiteAPI JSON numbers (105.5, read through String(n)). The digits after the point are moved with
// string arithmetic, never with floating point, using the currency's ISO 4217 minor-unit digits. More digits
// than the currency has are rounded half-up and reported (`rounded`), so the caller can count and log them.
// Never converts between currencies: there is no exchange rate anywhere in Tripelyx Business.

/** ISO 4217 minor-unit digits that are not 2 (every other three-letter code has 2). */
const DIGITS = Object.freeze({
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0,
  VUV: 0, XAF: 0, XOF: 0, XPF: 0,
});
const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_RE = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

/**
 * The minor-unit digits of a currency.
 * @param {string} currency ISO 4217 code
 * @returns {number|null} null for something that is not a three-letter code
 */
function digitsOf(currency) {
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) return null;
  return Object.prototype.hasOwnProperty.call(DIGITS, currency) ? DIGITS[currency] : 2;
}

/**
 * A supplier amount as minor units.
 * @param {string|number} value a decimal string ("245.30", "0", "12") or a finite JSON number ≥ 0 (105.5)
 * @param {string} currency ISO 4217 code
 * @returns {{ minor: number, rounded: boolean }|null} null when the amount or currency can't be read (negative,
 *   exponent notation, NaN, not a code, too large): the caller drops what it can't price
 */
function parseMinor(value, currency) {
  const digits = digitsOf(currency);
  if (digits === null) return null;
  let text;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) text = String(value);
  else return null;
  const m = DECIMAL_RE.exec(text);
  if (!m) return null;
  const whole = m[1], frac = m[2] || '';
  const kept = frac.slice(0, digits).padEnd(digits, '0');
  const rest = frac.slice(digits);
  let minor = Number(whole + kept);
  const rounded = /[1-9]/.test(rest);
  if (rest && rest[0] >= '5') minor += 1;
  if (!Number.isSafeInteger(minor)) return null;
  return { minor, rounded };
}

/**
 * Minor units back to the supplier's own decimal text ("50.00"), for sentences that quote an amount as given.
 * @param {number} minor
 * @param {string} currency
 * @returns {string|null}
 */
function formatMinor(minor, currency) {
  const digits = digitsOf(currency);
  if (digits === null || !Number.isSafeInteger(minor) || minor < 0) return null;
  if (digits === 0) return String(minor);
  const s = String(minor).padStart(digits + 1, '0');
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

module.exports = { parseMinor, formatMinor, digitsOf };
