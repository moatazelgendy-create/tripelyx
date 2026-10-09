// Card numbers have no place in Business free text (exception reasons, request messages). 13 to 19 digits
// that pass the Luhn check are treated as a card number and refused: written together or in groups split by
// single spaces, dots or hyphens, also when more digit groups follow ("4242 4242 4242 4242 12 28"). Only
// whole groups are joined, so phone numbers and dates (shorter) are left alone, and so is an unbroken run of
// 20 or more digits (an order number or id). Fullwidth and Arabic-Indic digits count as digits.
// (From the 1B card guard, merged with 1C's hasCardNumber.)

const RUN = /\d(?:[ .-]?\d){12,}/g;

/** Arabic-Indic (U+0660-0669) and Extended Arabic-Indic (U+06F0-06F9) digits as ASCII digits. */
const asciiDigits = s => s.replace(/[٠-٩۰-۹]/g, ch => String((ch.charCodeAt(0) & 0xf)));

/**
 * Luhn check of a digit string.
 * @param {string} digits
 * @returns {boolean}
 */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Does `text` contain something that looks like a payment card number?
 * @param {unknown} text
 * @returns {boolean}
 */
function hasCardNumber(text) {
  const s = asciiDigits(String(text ?? '').normalize('NFKC'));
  for (const m of s.matchAll(RUN)) {
    const groups = m[0].split(/[ .-]/);
    for (let i = 0; i < groups.length; i++) {
      let digits = '';
      for (let j = i; j < groups.length && digits.length < 19; j++) {
        digits += groups[j];
        if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
      }
    }
  }
  return false;
}

/** The 422 a service answers when free text holds a card number. */
const CARD_MESSAGE = "For your security, don't send card numbers here.";

module.exports = { hasCardNumber, containsCardNumber: hasCardNumber, luhn, CARD_MESSAGE };
