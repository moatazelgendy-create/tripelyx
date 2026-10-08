// Public Business routes and the workspace entry (plan §B4 "Public" and "Workspace entry", §B7).
// STUB from Stage 0: an empty router and an empty ROUTES table; Stage 2A builds it. Paths are relative to
// MOUNT ('/business'); GET /business is the company page in pagesRouter, never defined here.
//
// What 2A adds (method, path, who, perm, limiters; the views in server/views/business/{auth,invite,chooser}.js):
//   GET  /start                         anyone   -        -                       sign-up (signed out or signed in)
//   POST /start                         anyone   -        bizAuthIp               accounts.register (signed out) →
//                                                                                 svc.createCompany → session → 303 /o/:id/welcome
//   GET  /signin                        anyone   -        -                       "Sign in to your company"; next via safeLocal
//   POST /signin                        anyone   -        bizAuthIp, bizAuthAccount (after form) → 303 next or /business/app
//   POST /signout                       user     -        bizWrite                303 /business
//   GET  /invite/:token                 anyone   -        -                       svc.inviteByToken; Referrer-Policy no-referrer; 410 page
//   POST /invite/:token/accept          user     -        bizAuthIp               svc.acceptInvite → 303 /o/:id
//   POST /invite/:token/join            anyone   -        bizAuthIp               register with emailProof → acceptInvite → 303
//   GET  /app                           user     -        -                       0 companies: create; 1: 303 to it; 2+: cards
//                                                                                 (svc.listCompaniesFor; platform admins also see a
//                                                                                 link to /admin/business)
// The home (/o/:orgId) and /o/:orgId/policy are in traveler.js (2B); /o/:orgId/welcome is in admin.js (2A).
// Each method and path is listed in exactly one ROUTES table (index.assertRoutes checks the union).
const express = require('express');

/** This router's routes (types.RouteEntry). Empty until Stage 2A. */
const ROUTES = Object.freeze([]);

/**
 * @param {object} ctx the app context
 * @param {import('../../business/types').RouterDeps} deps
 * @returns {import('express').Router}
 */
function router(ctx, deps) {
  return express.Router();
}

module.exports = { router, ROUTES };
