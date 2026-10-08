// Tripelyx Business rate limits (plan §C). Business never uses the shared writeLimiter (40 per 10
// minutes per IP), which an agency office behind one address would exhaust. Workspace limits are per
// signed-in user; client-page limits are per IP (through ipKeyGenerator, so an IPv6 user cannot step
// through addresses in their /56) and, for client writes, per share link as well. Every limit answers
// through the app's error handler with AppError('rate_limited', …, 429), so pages keep their chrome.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { AppError } = require('../lib/errors');
const { hashToken } = require('./tokens');

const MINUTE = 60 * 1000;
const RATE_LIMITED = 'Too many requests in a short time. Wait a few minutes and try again.';

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

/** The IP plus a prefix of the share link's hash (never the token itself). Needs req.params.token. */
function ipShareKey(req) {
  const token = req.params && typeof req.params.token === 'string' ? req.params.token : '';
  return `ip:${ipKeyGenerator(req.ip || '')}|s:${hashToken(token).slice(0, 16)}`;
}

/**
 * Build the five Business limiters. Call once per app (at createApp), never inside a request.
 * @param {{ writeLimit: number, computeLimit: number, clientWriteLimit: number }} biz config.business
 * @param {{ logger?: { warn: Function, error: Function } }} [opts] where express-rate-limit reports misconfiguration
 * @returns {{ bizWrite: Function, bizCompute: Function, clientView: Function, clientWrite: Function, clientSeen: Function }}
 *   bizWrite: workspace writes, writeLimit per 10 minutes per user (default 300);
 *   bizCompute: engine tools, computeLimit per minute per user (default 30);
 *   clientView: client page GETs, 120 per minute per IP;
 *   clientWrite: client POSTs, clientWriteLimit per 10 minutes per IP and link (default 20; use on routes with :token);
 *   clientSeen: the seen beacon, 60 per minute per IP.
 */
function createBusinessLimits(biz, { logger } = {}) {
  const usable = logger && typeof logger.warn === 'function' && typeof logger.error === 'function';
  const make = (windowMs, limit, keyGenerator) => rateLimit({
    windowMs, limit, keyGenerator, handler: limited, standardHeaders: 'draft-7', legacyHeaders: false, ...(usable ? { logger } : {}),
  });
  return {
    bizWrite: make(10 * MINUTE, biz.writeLimit, userKey),
    bizCompute: make(MINUTE, biz.computeLimit, userKey),
    clientView: make(MINUTE, 120, ipKey),
    clientWrite: make(10 * MINUTE, biz.clientWriteLimit, ipShareKey),
    clientSeen: make(MINUTE, 60, ipKey),
  };
}

module.exports = { createBusinessLimits, RATE_LIMITED, userKey, ipKey, ipShareKey };
