// Traveler and approver routes (plan §B4 "Trips and approvals", §H1 to §H3).
// STUB from Stage 0: an empty router and an empty ROUTES table; Stage 2B builds it (views in
// server/views/business/{home,policyMine,tripNew,results,request,trips,approvals}.js). Paths are relative
// to MOUNT ('/business'). Every route runs memberGate per route (never a path-less r.use()).
//
// What 2B adds (method, path, perm, own, limiters → service method):
//   GET  /o/:orgId                       org.view                                    → dashboard({ view: 'home' })
//   GET  /o/:orgId/policy                org.view                                    → getPolicy(actor, null)
//   GET  /o/:orgId/trips/new             trip.request                                → (form; inventory status)
//   GET  /o/:orgId/trips/search          trip.request                bizCompute      → searchTrip (writes nothing)
//   POST /o/:orgId/trips                 trip.request                bizCompute      → createRequest → 303 /trips/:rid
//   GET  /o/:orgId/trips                 request.view.own|team|all                   → listRequests
//   GET  /o/:orgId/trips/:rid            request.view.*, approval.*  own:'request'   → getRequest
//   POST /o/:orgId/trips/:rid/swap       request.view.own            own:'request'   bizCompute → swap
//   POST /o/:orgId/trips/:rid/submit     request.view.own            own:'request'   bizCompute → submit
//   POST /o/:orgId/trips/:rid/cancel     request.view.own, approval.override own:'request' bizWrite → cancel
//   POST /o/:orgId/trips/:rid/decide     approval.decide, approval.override own:'request' bizCompute → decide
//   POST /o/:orgId/trips/:rid/message    request.view.own, approval.* own:'request'  bizWrite → message
//   GET  /o/:orgId/approvals             approval.decide                             → inbox
const express = require('express');

/** This router's routes (types.RouteEntry). Empty until Stage 2B. */
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
