// The private preview's password (infra/preview.yaml, .github/workflows/preview.yml). Mounted by app.js only
// when PREVIEW_PASSWORD is set, which config.js refuses in production; unset, nothing in here runs and the
// site is exactly as it was.
//
// - HTTP Basic auth: any username, the preview password. The password is compared as a SHA-256 digest with
//   crypto.timingSafeEqual, so the time a check takes says nothing about how close a guess was.
// - Only GET or HEAD of the health check (/healthz, exactly) is open, so the host can tell the app is up.
// - Every response carries X-Robots-Tag: noindex, nofollow, the open health check included.
// - Wrong passwords are counted per client address (req.ip; set TRUST_PROXY behind a load balancer). After
//   `maxFailures` within `windowMs` that address gets 429 until the window ends, without its password being
//   checked. A request with no Authorization header is not a wrong password and is not counted.
// - Nothing here logs, and neither the password nor the Authorization header is ever written anywhere.
const crypto = require('node:crypto');

const HEALTH_PATH = '/healthz';
const REALM = 'Tripelyx preview';
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
// How many client addresses the failure counter remembers at once (expired ones are dropped first).
const MAX_TRACKED = 10000;

/** The SHA-256 digest of a password, as the gate keeps it (config.js keeps only this, never the text). */
function passwordDigest(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest();
}

/**
 * The password from an `Authorization: Basic <base64(user:password)>` header (any user name), '' for a
 * Basic header that cannot be read, or null when there is no Basic header at all.
 * @param {unknown} header
 * @returns {string|null}
 */
function basicPassword(header) {
  if (typeof header !== 'string' || header === '') return null;
  const m = /^basic[ \t]+([A-Za-z0-9+/]+={0,2})[ \t]*$/i.exec(header);
  if (!m) return /^basic(?:[ \t]|$)/i.test(header) ? '' : null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? '' : decoded.slice(colon + 1);
}

/**
 * @param {{ passwordDigest: Buffer, appEnv: string, now?: () => number, maxFailures?: number,
 *   windowMs?: number, maxTracked?: number }} options
 * @returns {import('express').RequestHandler}
 */
function createPreviewGate({ passwordDigest: digest, appEnv, now = Date.now, maxFailures = MAX_FAILURES, windowMs = WINDOW_MS, maxTracked = MAX_TRACKED } = {}) {
  if (appEnv === 'production') throw new Error('The preview password is not allowed when APP_ENV=production');
  if (!Buffer.isBuffer(digest) || digest.length !== 32) throw new Error('The preview gate needs the SHA-256 digest of PREVIEW_PASSWORD');
  /** client address → { count, resetAt } */
  const failures = new Map();

  function liveEntry(ip, t) {
    const e = failures.get(ip);
    if (e && e.resetAt <= t) {
      failures.delete(ip);
      return null;
    }
    return e || null;
  }

  function recordFailure(ip, t) {
    const e = liveEntry(ip, t);
    if (e) {
      e.count += 1;
      return;
    }
    if (failures.size >= maxTracked) {
      for (const [k, v] of failures) if (v.resetAt <= t) failures.delete(k);
      // Still full: forget the oldest address (Map keeps insertion order).
      if (failures.size >= maxTracked) failures.delete(failures.keys().next().value);
    }
    failures.set(ip, { count: 1, resetAt: t + windowMs });
  }

  function plain(res, status, text) {
    res.status(status);
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain; charset=utf-8');
    res.send(text);
  }

  return function previewGate(req, res, next) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (req.path === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) return next();

    const t = now();
    const ip = req.ip || 'unknown';
    const locked = liveEntry(ip, t);
    if (locked && locked.count >= maxFailures) {
      const seconds = Math.max(1, Math.ceil((locked.resetAt - t) / 1000));
      const minutes = Math.ceil(seconds / 60);
      res.setHeader('Retry-After', String(seconds));
      return plain(res, 429, `Too many wrong passwords from this address. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.\n`);
    }

    const supplied = basicPassword(req.headers.authorization);
    if (supplied !== null) {
      if (crypto.timingSafeEqual(passwordDigest(supplied), digest)) return next();
      recordFailure(ip, t);
    }
    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    return plain(res, 401, 'This is a private preview of Tripelyx. Please sign in with the preview password (any user name works).\n');
  };
}

module.exports = { createPreviewGate, passwordDigest, basicPassword, HEALTH_PATH, MAX_FAILURES, WINDOW_MS };
