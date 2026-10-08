// Tripelyx Business service. STUB from Stage 0: Stage 1C replaces this file with the real service.
//
// Frozen interface (plan §K, "1C interfaces"):
//   new BusinessService({ store, tripService, config, now, log })
// Every method takes `actor = { org, member, user }` (or a share token for client methods) and re-checks
// can() and the own-scope itself (server/business/roles.js), so a route bug cannot bypass them.
//   createOrg(user, { name, email, phone, website }) ; listOrgsFor(user) ; getOrg(orgId) ; listAllOrgs()
//   setOrgStatus(adminUser, orgId, status)
//   membership(orgId, userId) ; listMembers(actor) ; invite(actor, { email, role }) -> { token, invite }
//   inviteByToken(token) ; acceptInvite(user, token) ; revokeInvite(actor, publicId)
//   changeRole(actor, userId, role) ; removeMember(actor, userId)
//   getBrand(orgId) ; saveBrand(actor, brand, rev) ; saveLogo(actor, { type, buffer }) ; removeLogo(actor) ; getLogo(orgId)
//   getRules(actor) ; saveRules(actor, rules, rev)
//   createClient / getClient / listClients / updateClient(actor, cid, input, rev) / revealClient / deleteClient
//   createProposal(actor, { clientId, title, brief }) ; getProposal ; listProposals(actor, { stage, advisorId })
//   updateBrief(actor, pid, brief, rev)
//   getDraft(actor, pid) ; saveDraft(actor, pid, fn) ; createVersion(actor, pid, { client, internal }) -> n
//   getVersion(actor, pid, n) -> { client, internal|null } ; listVersions(actor, pid) ; sendVersion(actor, pid, { reason })
//   createShare(actor, pid, { label, kind }) -> { token, share } ; listShares ; revokeShare(actor, pid, publicId)
//   setStage(actor, pid, stage, { note, externalRef }) ; assign(actor, pid, advisorId) ; resolveResponse(actor, pid, rid)
//   addMessage(actor, pid, text) ; addNote(actor, pid, text) ; listActivity(actor, pid)
//   openShare(token) -> { share, org, brand, proposal:{ id, stage, approved, clientName }, version, sentVersions } (throws 404/410)
//   internalForShare(token) ; recordView(token) ; respond(token, input, { suggestions })
//   clientMessage(token, { text, name }) ; clientActivity(token)
//   addReminder / doneReminder / listReminders(actor) -> { due, upcoming, suggested } ; dashboard(actor)
//   listAudit(actor, { group })

class BusinessService {
  /**
   * @param {{ store: object, tripService: object, config: object, now: () => Date, log: object }} deps
   */
  constructor(deps) { Object.assign(this, deps); }
}

module.exports = { BusinessService };
