// The Tripelyx Business workspace (/business/app, /business/start, /business/invite/..., /business/o/...).
// STUB from Stage 0: Stage 2W replaces this file. Rules for the real router (plan §C): it never defines
// GET '/' (the marketing page lives in pagesRouter), it has no path-less r.use(), and every
// state-changing POST runs limiter -> sameOrigin -> body parser -> gate -> handler -> 303.
const express = require('express');

/**
 * @param {object} ctx the app context (ctx.business is the BusinessService)
 * @param {{ bizWrite: Function, bizCompute: Function, clientView: Function, clientWrite: Function,
 *   clientSeen: Function, sameOrigin: Function }} deps limiters from server/business/limits.js and sameOrigin
 * @returns {import('express').Router} mounted at /business
 */
function businessRouter(ctx, deps) {
  return express.Router();
}

module.exports = { businessRouter };
