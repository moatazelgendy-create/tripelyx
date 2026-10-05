const crypto = require('node:crypto');

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

// Human-friendly booking reference: no 0/O/1/I so it can be read out over the phone.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function bookingRef(prefix = 'TX') {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += REF_ALPHABET[b % REF_ALPHABET.length];
  return `${prefix}-${out}`;
}

// Stable 32-bit hash used by the mock providers to make availability deterministic per item and date.
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

module.exports = { id, bookingRef, hash32 };
