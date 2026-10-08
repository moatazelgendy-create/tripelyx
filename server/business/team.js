// Companies, members, invites, departments, settings, the activity log and the platform admin's view (plan
// §B6, §B7, §C3, §D, §I5, §I8). Every method is a BusinessService method (service.js assigns `methods` onto
// its prototype), so `this` is the service: this.repo, this.accounts, this.config, this.now, this.log,
// this.policy (resolveApprover for the People warnings).
// STUB from Stage 0 with the frozen interface; Stage 1W-a builds it (from 1C's service.js:451-725, rewritten
// on Repo.commit with D3, D4, D5 and D8).
//
// Rules for every method here:
// - Company methods take `actor` (req.biz.actor) and start with actor.loadActor(this.repo, actor) (404 for a
//   forged, stale, removed or foreign actor; 403 'org_suspended') and actor.need(a, perm) (403 'forbidden'
//   with the role message). Reads go through repo.getIn / repo.page; nothing calls the store.
// - Every change is one repo.commit holding the change and its audit entry (actor.auditInsert), D7. A form's
//   rev goes in as the cas rev (a stale one answers 409 'conflict' and never retries); server-side reads use
//   rev null under repo.withRetry.
// - Times come from this.repo.iso(). Names go through validate.text; emails through validate.email.
// Errors common to all: 404 'not_found', 403 'forbidden', 403 'org_suspended', 409 'conflict', 422 with
// per-field details (code named per method).
const { DEFAULT_TIMEZONE, COMPANY_SIZES } = require('./constants');

function notBuilt() { throw new Error('[business] not built'); }

/** The sign-up form's company fields and their defaults. */
const COMPANY_FORM = Object.freeze({ sizes: COMPANY_SIZES, defaultTimezone: DEFAULT_TIMEZONE });

const methods = {
  /**
   * Create a company with the signed-in user as its Owner (POST /business/start, after accounts.register or
   * for a signed-in account). One commit: biz_org (status 'pending', or 'active' with
   * config.business.selfServe), the Owner's biz_member (tier standard, department General), the user's
   * biz_user_index (insert, or CAS adding the id), the three biz_policy records at version 1 from
   * policy/defaults.js with their biz_policy_version v1 (note DEFAULTS_NOTE, no changes), the "General"
   * biz_department, and the audit entry 'org.created'. Nothing is written when any part fails.
   * @param {import('./types').UserActor} actor
   * @param {{ name: string, size: string, timezone?: string, ack?: string }} form ack '1' = the preview checkbox
   * @returns {Promise<{ org: import('./types').Org, member: import('./types').Member }>}
   * @throws {AppError} 404 no user; 422 'invalid_company' details { name: "Choose your own company's name." when
   *   it contains "tripelyx" (NFKC, case-insensitive), size, timezone, ack }; 422 'too_many_companies' at
   *   config.business.maxOrgsPerUser ("You're already in 3 companies, the most one account can join in the preview.")
   */
  async createCompany(actor, form) { notBuilt(); },

  /**
   * The companies the user belongs to (active memberships only), in biz_user_index order: the switcher
   * and /business/app. Never throws for a user with none.
   * @param {import('./types').UserActor|import('./types').MemberActor} actor only actor.user is read
   * @returns {Promise<import('./types').CompanyLink[]>}
   */
  async listCompaniesFor(actor) { notBuilt(); },

  /**
   * The company, for a member (org.view).
   * @param {import('./types').MemberActor} actor
   * @returns {Promise<import('./types').Org>}
   */
  async getOrg(actor) { notBuilt(); },

  /**
   * The signed-in user's own active membership in a company, or null (no throw for a non-member, a bad id
   * or a suspended company). For /business/app and the invite landing.
   * @param {import('./types').UserActor} actor
   * @param {string} orgId
   * @returns {Promise<import('./types').Member|null>}
   */
  async membership(actor, orgId) { notBuilt(); },

  /**
   * The People page (members.view): members 50 per page (constants.PAGE_SIZE, Repo.page), pending invites
   * and emails only with members.manage, departments, and warnings for active members nobody can approve
   * ("Sam Traveler has no one who can approve their trips": this.policy.resolveApprover(...).rule === null).
   * @param {import('./types').MemberActor} actor
   * @param {{ cursor?: string|null }} [opts]
   * @returns {Promise<import('./types').PeopleView>}
   */
  async listMembers(actor, opts) { notBuilt(); },

  /**
   * Create an invite link (members.manage; POST /people/invite answers 200 with the show-once link page).
   * The role must be one of roles.assignableBy(actor's role) (else 403 'forbidden'). D3: one commit with
   * the biz_invite insert, the biz_invite_email pointer (insert or CAS), the previous pending invite for the
   * same email revoked ('replaced'), and audit 'member.invited'. Allowed while the company is pending.
   * expiresAt = now + config.business.inviteDays.
   * @param {import('./types').MemberActor} actor
   * @param {{ email: string, role: string, departmentId?: string, managerId?: string, approverId?: string, tier?: string }} form
   * @returns {Promise<import('./types').InviteCreated>}
   * @throws {AppError} 422 'invalid_invite' with details (email, role, departmentId: an active department of
   *   this company, managerId/approverId: active members, tier); 409 'already_member' (an active member has
   *   the email); 409 'company_full' at constants.MEMBER_CAP
   */
  async invite(actor, form) { notBuilt(); },

  /**
   * The invite landing (GET /business/invite/:token; anyone holding the link). Reads by sha256(token) with
   * repo.get (a token lookup). Writes nothing.
   * @param {import('./types').UserActor} actor actor.user may be null (signed out)
   * @param {string} token
   * @returns {Promise<import('./types').InviteLanding>}
   * @throws {AppError} 410 'invite_gone' for a malformed, unknown, expired, revoked, replaced or used token
   */
  async inviteByToken(actor, token) { notBuilt(); },

  /**
   * Join a company from an invite (POST /invite/:token/accept, or /join right after accounts.register with
   * emailProof { via: 'invite', orgId, at }). The account's email must equal the invite's (D5); the pointer
   * must still point at this invite (D3); D4 cap. One commit: invite CAS (acceptedAt, acceptedBy), pointer
   * CAS (inviteHash null), the biz_member insert (or CAS of a removed member back to active, only for an
   * invite created after removedAt), org CAS (memberCount + 1; ownerIds for an owner), user index insert or
   * CAS, audit 'member.joined'.
   * @param {import('./types').UserActor} actor
   * @param {string} token
   * @returns {Promise<{ org: import('./types').Org, member: import('./types').Member }>}
   * @throws {AppError} 410 'invite_gone'; 409 'company_pending' (not confirmed yet); 403 'org_suspended';
   *   403 'invite_email_mismatch'; 409 'already_member'; 422 'too_many_companies'; 409 'company_full'
   */
  async acceptInvite(actor, token) { notBuilt(); },

  /**
   * Revoke a pending invite by its publicId (members.manage; roles.assignableBy must cover its role). One
   * commit: invite CAS (revokedAt, revokedReason 'manual'), pointer CAS (inviteHash null), audit
   * 'member.invite_revoked'.
   * @param {import('./types').MemberActor} actor
   * @param {string} publicId inv_…
   * @returns {Promise<import('./types').Invite>}
   * @throws {AppError} 404 unknown or another company's; 409 'invite_not_pending'
   */
  async revokeInvite(actor, publicId) { notBuilt(); },

  /**
   * Change a member's role, department, manager, approver or tier (members.manage). Both the member's
   * current role and the new one must be in roles.assignableBy(actor's role). D8: org.ownerIds changes in the
   * same commit; emptying it throws 422 'last_owner'. One commit: member CAS (form rev), org CAS when
   * ownerIds changes, audit 'member.role_changed' (role) or 'member.updated' (the rest), with changes.
   * @param {import('./types').MemberActor} actor
   * @param {string} userId
   * @param {{ role?: string, departmentId?: string, managerId?: string, approverId?: string, tier?: string, rev: string|number }} form
   *   blank departmentId/managerId/approverId = none
   * @returns {Promise<import('./types').Member>}
   * @throws {AppError} 404; 403 'forbidden'; 422 'invalid_member' with details (managerId or approverId equal
   *   to the member's own id: "Choose someone else."); 422 'last_owner'; 409 'conflict' (stale rev)
   */
  async updateMember(actor, userId, form) { notBuilt(); },

  /**
   * Remove a member (members.manage; assignableBy must cover their role). The record stays with status
   * 'removed'. One commit: member CAS (form rev; status, removedAt), org CAS (memberCount − 1, ownerIds),
   * user index CAS (orgId removed), any pending invite for their email revoked ('removed') with its pointer
   * cleared, audit 'member.removed'. Their requests stay; override holders can still decide pending ones.
   * @param {import('./types').MemberActor} actor
   * @param {string} userId
   * @param {{ rev: string|number }} form
   * @returns {Promise<import('./types').Member>}
   * @throws {AppError} 404; 403; 422 'last_owner'; 422 'remove_self'; 409 'conflict'
   */
  async removeMember(actor, userId, form) { notBuilt(); },

  /**
   * Create, rename or archive a department (departments.manage). No departmentId → create (audit
   * 'department.created'); with a name change → 'department.renamed'; archive '1' → 'department.archived'
   * (its budgets and history stay; members keep it until changed). Names are unique per company,
   * case-insensitive, ≤ 80; at most constants.DEPARTMENT_CAP.
   * @param {import('./types').MemberActor} actor
   * @param {{ departmentId?: string, name?: string, archive?: string, rev?: string|number }} form
   * @returns {Promise<import('./types').Department>}
   * @throws {AppError} 422 'invalid_department' (details.name); 409 'department_exists'; 409 'conflict'; 404
   */
  async saveDepartment(actor, form) { notBuilt(); },

  /**
   * Every department of the company (org.view), by name, archived last.
   * @param {import('./types').MemberActor} actor
   * @returns {Promise<import('./types').Department[]>}
   */
  async listDepartments(actor) { notBuilt(); },

  /**
   * Save company settings. name and timezone need settings.company; outOfPolicy ('approval'|'block'),
   * approvalHours (4..168) and budgetPeriod ('quarter'|'month') need settings.travel. Changing a field whose
   * permission the member lacks → 403. One commit: org CAS (form rev), audit 'org.settings_changed' with changes.
   * @param {import('./types').MemberActor} actor
   * @param {{ name?: string, timezone?: string, outOfPolicy?: string, approvalHours?: string, budgetPeriod?: string, rev: string|number }} form
   * @returns {Promise<import('./types').Org>}
   * @throws {AppError} 422 'invalid_settings' with details; 403; 409 'conflict'
   */
  async saveSettings(actor, form) { notBuilt(); },

  /**
   * The company's data as JSON (settings.company; POST /settings/export answers it as a download): the
   * org, members (their biz_member records only, no other user data), departments, policies and versions,
   * budgets, requests and the audit log, each paged in full. One commit with audit 'org.exported'.
   * @param {import('./types').MemberActor} actor
   * @returns {Promise<import('./types').CompanyExport>}
   */
  async exportCompany(actor) { notBuilt(); },

  /**
   * The activity log (audit.view), newest first, 50 per page (Repo.page), optionally one group.
   * @param {import('./types').MemberActor} actor
   * @param {{ group?: string|null, cursor?: string|null }} [opts] group: one of constants.AUDIT_GROUPS
   * @returns {Promise<import('./types').Page<import('./types').AuditEntry>>}
   * @throws {AppError} 404 for a foreign or damaged cursor
   */
  async listAudit(actor, opts) { notBuilt(); },

  /**
   * Every company for the platform admin page (/admin/business): repo.listOrgs plus each creator's email and
   * the similar-name hint; company enquiries from repo.listBusinessLeads. Never requests, policies, budgets,
   * member lists or audit contents.
   * @param {import('./types').UserActor} actor actor.user.isAdmin must be true
   * @returns {Promise<import('./types').PlatformView>}
   * @throws {AppError} 404 'not_found' for anyone who is not a platform admin
   */
  async platformListOrgs(actor) { notBuilt(); },

  /**
   * Confirm, suspend or reactivate a company (platform admin). pending → active ('org.confirmed'), active →
   * suspended ('org.suspended', note required), suspended → active ('org.reactivated'). One commit: org CAS
   * (form rev; statusBy, statusAt, statusNote), the company's audit entry with actor.platformActor(user).
   * @param {import('./types').UserActor} actor actor.user.isAdmin must be true
   * @param {string} orgId
   * @param {{ status: 'active'|'suspended', note?: string, rev: string|number }} form
   * @returns {Promise<import('./types').Org>}
   * @throws {AppError} 404 (not an admin, unknown company); 422 'invalid_status' (details.status, details.note);
   *   409 'conflict'
   */
  async platformSetStatus(actor, orgId, form) { notBuilt(); },
};

module.exports = { methods, COMPANY_FORM };
