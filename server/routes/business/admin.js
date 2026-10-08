// Company administration routes (plan §B4 "Policy, budgets and people" and "Reports, activity and
// settings"). STUB from Stage 0: an empty router and an empty ROUTES table; Stage 2A builds it (views in
// server/views/business/{welcome,people,inviteLink,policies,budgets,reports,activity,settings}.js). Paths
// are relative to MOUNT ('/business'). Every route runs memberGate per route (never a path-less r.use()).
//
// What 2A adds (method, path, perm, limiters → service method):
//   GET  /o/:orgId/welcome                          settings.company                        → dashboard (checklist)
//   GET  /o/:orgId/policies                         policy.view.all                         → getPolicy per tier
//   GET  /o/:orgId/policies/:tier                   policy.view.all                         → getPolicy
//   POST /o/:orgId/policies/:tier                   policy.edit         bizWrite            → savePolicy
//   GET  /o/:orgId/policies/:tier/history           policy.view.all                         → policyHistory
//   GET  /o/:orgId/budgets                          budget.view.dept|all                    → listBudgets
//   POST /o/:orgId/budgets                          budget.edit         bizWrite            → setBudget
//   GET  /o/:orgId/people                           members.view                            → listMembers
//   POST /o/:orgId/people/invite                    members.manage      bizWrite            → invite (200 show-once page)
//   POST /o/:orgId/people/invites/:publicId/revoke  members.manage      bizWrite            → revokeInvite
//   POST /o/:orgId/people/:userId                   members.manage      bizWrite            → updateMember
//   POST /o/:orgId/people/:userId/remove            members.manage      bizWrite            → removeMember
//   POST /o/:orgId/departments                      departments.manage  bizWrite            → saveDepartment
//   GET  /o/:orgId/reports                          reports.view                            → dashboard({ view: 'reports' })
//   POST /o/:orgId/reports/export                   reports.export      bizWrite            → exportCsv (200 attachment)
//   GET  /o/:orgId/activity                         audit.view                              → listAudit
//   GET  /o/:orgId/settings                         org.view                                → getOrg
//   POST /o/:orgId/settings                         settings.company|settings.travel bizWrite → saveSettings
//   POST /o/:orgId/settings/export                  settings.company    bizWrite            → exportCompany (200 attachment)
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
