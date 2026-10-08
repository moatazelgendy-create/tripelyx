// Client-facing Tripelyx Business routes. STUB from Stage 0: Stage 2X replaces this file.
// - clientRouter at /business/p: white-label proposal pages behind share tokens, with its own error
//   middleware (client chrome); never reads a session, rules, economics or notes.
// - brandRouter at /business/brand: GET /:orgId/brand.css and GET /:orgId/logo.
// - previewRouter at /business: GET /o/:orgId/proposals/:pid/preview (the client render for members).
// No path-less r.use() in any of them (they share the /business prefix with the marketing page).
const express = require('express');

/**
 * @param {object} ctx the app context
 * @param {{ clientView: Function, clientWrite: Function, clientSeen: Function, sameOrigin: Function }} deps
 * @returns {import('express').Router} mounted at /business/p
 */
function clientRouter(ctx, deps) {
  return express.Router();
}

/**
 * @param {object} ctx the app context
 * @param {{ clientView: Function }} deps the Business limiters
 * @returns {import('express').Router} mounted at /business/brand
 */
function brandRouter(ctx, deps) {
  return express.Router();
}

/**
 * @param {object} ctx the app context
 * @param {{ bizCompute: Function, clientView: Function, sameOrigin: Function }} deps
 * @returns {import('express').Router} mounted at /business
 */
function previewRouter(ctx, deps) {
  return express.Router();
}

module.exports = { clientRouter, brandRouter, previewRouter };
