// Tripelyx Business rate limits (plan §I6). In memory per running task (each container counts on its own;
// a shared store is phase 2). Business never uses the shared writeLimiter (40 per 10 minutes per IP),
// which a company office behind one address would exhaust. Every IP key goes through ipKeyGenerator, so an
// IPv6 user cannot step through the addresses in their /56. Every limit answers through the app's error
// handler with AppError('rate_limited', …, 429), so pages keep their chrome.
//
//   bizAuthIp       authLimit (20) per 10 minutes per IP: /business/start, /business/signin, invite accept and join.
//   bizAuthAccount  10 per 15 minutes per email address, for sign-in. Keyed on sha256(lower(email)), so it needs
//                   the parsed form: it runs after `form` (IP limiter → sameOrigin → form → email limiter), the
//                   one documented exception to "limiter first". Successful sign-ins do not count. app.js builds it
//                   once (createAccountLimiter) and mounts the same instance on the consumer POST /signin, which
//                   signs in to the same accounts: each address has one budget across both sign-in pages.
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

/** A limiter with the Business defaults (draft-7 headers, the app's error handler for a 429). */
function makeLimiter(windowMs, limit, keyGenerator, { logger, ...extra } = {}) {
  const usable = logger && typeof logger.warn === 'function' && typeof logger.error === 'function';
  return rateLimit({
    windowMs, limit, keyGenerator, handler: limited, standardHeaders: 'draft-7', legacyHeaders: false, ...(usable ? { logger } : {}), ...extra,
  });
}

/**
 * The per-address sign-in limiter (bizAuthAccount): ACCOUNT_LIMIT failed sign-ins per 15 minutes per email
 * address; successful sign-ins do not count. Mount it after the form parser. Build it once per app and use the
 * same instance on every route that signs in with a password, so an address has one budget.
 * @param {{ logger?: { warn: Function, error: Function } }} [opts]
 * @returns {Function}
 */
function createAccountLimiter({ logger } = {}) {
  return makeLimiter(15 * MINUTE, ACCOUNT_LIMIT, accountKey, { logger, skipSuccessfulRequests: true });
}

/**
 * Build the four Business limiters. Call once per app (at createApp), never inside a request.
 * @param {{ authLimit: number, writeLimit: number, computeLimit: number }} biz config.business
 * @param {{ logger?: { warn: Function, error: Function }, account?: Function }} [opts] logger: where
 *   express-rate-limit reports misconfiguration; account: the app's shared per-address sign-in limiter
 *   (createAccountLimiter), used as bizAuthAccount (a new one when not given)
 * @returns {{ bizAuthIp: Function, bizAuthAccount: Function, bizWrite: Function, bizCompute: Function }}
 */
function createBusinessLimits(biz, { logger, account } = {}) {
  const make = (windowMs, limit, keyGenerator) => makeLimiter(windowMs, limit, keyGenerator, { logger });
  return {
    bizAuthIp: make(10 * MINUTE, biz.authLimit, ipKey),
    bizAuthAccount: account || createAccountLimiter({ logger }),
    bizWrite: make(10 * MINUTE, biz.writeLimit, userKey),
    bizCompute: make(MINUTE, biz.computeLimit, userKey),
  };
}

module.exports = { createBusinessLimits, createAccountLimiter, RATE_LIMITED, ACCOUNT_LIMIT, userKey, ipKey, accountKey };
