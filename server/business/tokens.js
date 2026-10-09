// Secret tokens for share links and invites. A token is shown once and never stored: records keep
// sha256(token) as their id (and as `tokenHash`), and lookups compare hashes in constant time.
// Tokens never go into events, audit entries, logs or the outbox; those carry the record's publicId.
const crypto = require('node:crypto');

/** A well-formed token: 32 random bytes as base64url, 43 characters. Check this before hashing. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A new random token (32 bytes, base64url, 43 characters).
 * @returns {string}
 */
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * sha256 of the token as 64 lowercase hex characters (the record id and `tokenHash`).
 * @param {string} token
 * @returns {string}
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A stored hash exactly as hashToken makes it: sha256 as 64 lowercase hex characters. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Constant-time comparison of two sha256 hashes (hashToken's output). False for anything that is not two
 * 64-character lowercase hex strings: Node drops a trailing odd nibble when it decodes hex, so shorter or
 * odd-length strings could compare equal when they differ.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !HASH_RE.test(a) || !HASH_RE.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Is this string shaped like a token? (Format check only; it says nothing about whether it exists.)
 * @param {unknown} token
 * @returns {boolean}
 */
function isToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

module.exports = { TOKEN_RE, HASH_RE, newToken, hashToken, sameHash, isToken };
