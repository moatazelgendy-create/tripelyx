// Tripelyx Business rate limits (plan §I6). In memory per running task (each container counts on its own;
// a shared store is phase 2). Business never uses the shared writeLimiter (40 per 10 minutes per IP),
// which a company office behind one address would exhaust. Every IP key goes through ipKeyGenerator, so an
// IPv6 user cannot step through the addresses in their /56. Every limit answers through the app's error
// handler with AppError('rate_limited', …, 429), so pages keep their chrome.
//
//   bizAuthIp       authLimit (20) per 10 minutes per IP: /business/start, /business/signin, invite accept and join.
//   bizAuthAccount  10 per 15 minutes per email address, for sign-in. Keyed on sha256(lower(email)), so it needs
//                   the parsed form: it runs after `form` (IP limiter → sameOrigin → form → email limiter), the
//                   one documented exception to "limiter first". Successful sign-ins do not count.
//   bizWrite        writeLimit (300) per 10 minutes per signed-in user: workspace writes.
//   bizCompute      computeLimit (30) per minute per signed-in user: search, create, swap, decide.
const crypto = require('node:crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { AppError } = require('../lib/errors');
const { str } = require('../lib/validate');

const MINUTE = 60 * 1000;
const RATE_LIMITED = 'Too many requests in a short time. Wait a few minutes and try again.';
/** Sign-in attempts per email address per 15 minutes. */
const ACCOUNT_LIMIT = 10;

/** Express handler for a request over its limit: hand the error to the app's error middleware. */
function limited(req, res, next) {
  next(new AppError('rate_limited', RATE_LIMITED, 429));
}

/** The signed-in user's id, or the IP (normalized for IPv6) when nobody is signed in. */
function userKey(req) {
  return req.user && req.user.id ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip || '')}`;
}

/** The IP, normalized for IPv6. */
function ipKey(req) {
  return `ip:${ipKeyGenerator(req.ip || '')}`;
}

/**
 * The email address being signed in to, as a short hash (never the address itself). Throws when the form
 * has not been parsed yet: the limiter is mounted in the wrong place.
 * The address is normalised exactly as Accounts.authenticate looks it up (lib/validate str: control
 * characters become spaces, trimmed, at most 120 characters; then lowercased), so every spelling that
 * reaches one account shares one budget. Keep the two in step.
 */
function accountKey(req) {
  if (!req.body || typeof req.body !== 'object') throw new Error('[business] bizAuthAccount must run after the form parser');
  const email = str(req.body.email, 120).toLowerCase();
  return `acct:${crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)}`;
}

/**
 * Build the four Business limiters. Call once per app (at createApp), never inside a request.
 * @param {{ authLimit: number, writeLimit: number, computeLimit: number }} biz config.business
 * @param {{ logger?: { warn: Function, error: Function } }} [opts] where express-rate-limit reports misconfiguration
 * @returns {{ bizAuthIp: Function, bizAuthAccount: Function, bizWrite: Function, bizCompute: Function }}
 */
function createBusinessLimits(biz, { logger } = {}) {
  const usable = logger && typeof logger.warn === 'function' && typeof logger.error === 'function';
  const make = (windowMs, limit, keyGenerator, extra = {}) => rateLimit({
    windowMs, limit, keyGenerator, handler: limited, standardHeaders: 'draft-7', legacyHeaders: false, ...(usable ? { logger } : {}), ...extra,
  });
  return {
    bizAuthIp: make(10 * MINUTE, biz.authLimit, ipKey),
    bizAuthAccount: make(15 * MINUTE, ACCOUNT_LIMIT, accountKey, { skipSuccessfulRequests: true }),
    bizWrite: make(10 * MINUTE, biz.writeLimit, userKey),
    bizCompute: make(MINUTE, biz.computeLimit, userKey),
  };
}

module.exports = { createBusinessLimits, RATE_LIMITED, ACCOUNT_LIMIT, userKey, ipKey, accountKey };
