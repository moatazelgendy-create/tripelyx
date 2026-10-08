// Tripelyx Business roles and permissions (plan §D). Frozen interface; test/business-foundation.test.js
// snapshots the whole matrix and the record scopes, so any change here is deliberate.
//
// Rules that live outside this table:
// - The role comes from the biz_member record, read on every request (memberGate) and again inside every
//   service call (actor.js). Platform admins (isAdmin) get no company access from that alone.
// - Everyone can travel: every role holds trip.request and sees its own requests.
// - Some permissions reach only some records (SCOPES); allowed(member, perm, record) applies the scope:
//   own = the traveler's own request; team = own, or the member is its approver or the traveler's manager,
//   or holds a pool link for it; dept = the member's own department; decider = the assigned approver or a
//   pool member, never the traveler; not_traveler = any request but the member's own (override).

/** @typedef {'owner'|'travel_admin'|'finance'|'manager'|'employee'} Role */

/** @type {ReadonlyArray<Role>} */
const ROLES = Object.freeze(['owner', 'travel_admin', 'finance', 'manager', 'employee']);

/** Role → label shown in the workspace. */
const LABELS = Object.freeze({
  owner: 'Owner',
  travel_admin: 'Travel Admin',
  finance: 'Finance',
  manager: 'Manager',
  employee: 'Employee',
});

/** Every permission, in the order of the plan's table. */
const PERMISSIONS = Object.freeze([
  'org.view',            // home, "Your travel policy", settings (read)
  'trip.request',        // plan and request trips (everyone can travel)
  'request.view.own',
  'request.view.team',   // requests they approve, of travelers they manage, or in their pool
  'request.view.all',
  'approval.decide',     // requests assigned to them, or in their pool
  'approval.override',   // any pending request but their own; a note is required
  'policy.view.all',     // every tier's policy and history
  'policy.edit',
  'budget.view.dept',    // their own department's budget
  'budget.view.all',
  'budget.edit',
  'members.view',
  'members.manage',      // invites, roles, managers, approvers, tiers; which roles: assignableBy()
  'departments.manage',
  'reports.view',
  'reports.export',
  'audit.view',
  'settings.travel',     // out-of-policy mode, approval expiry, budget period
  'settings.company',    // name, time zone, company data export
]);

// The matrix. Y = yes, '-' = no. Columns: owner, travel_admin, finance, manager, employee.
const MATRIX = {
  'org.view':           ['Y', 'Y', 'Y', 'Y', 'Y'],
  'trip.request':       ['Y', 'Y', 'Y', 'Y', 'Y'],
  'request.view.own':   ['Y', 'Y', 'Y', 'Y', 'Y'],
  'request.view.team':  ['Y', 'Y', '-', 'Y', '-'],
  'request.view.all':   ['Y', 'Y', 'Y', '-', '-'],
  'approval.decide':    ['Y', 'Y', '-', 'Y', '-'],
  'approval.override':  ['Y', 'Y', '-', '-', '-'],
  'policy.view.all':    ['Y', 'Y', 'Y', '-', '-'],
  'policy.edit':        ['Y', 'Y', '-', '-', '-'],
  'budget.view.dept':   ['Y', 'Y', 'Y', 'Y', '-'],
  'budget.view.all':    ['Y', 'Y', 'Y', '-', '-'],
  'budget.edit':        ['Y', '-', 'Y', '-', '-'],
  'members.view':       ['Y', 'Y', 'Y', 'Y', '-'],
  'members.manage':     ['Y', 'Y', '-', '-', '-'],
  'departments.manage': ['Y', 'Y', '-', '-', '-'],
  'reports.view':       ['Y', 'Y', 'Y', '-', '-'],
  'reports.export':     ['Y', 'Y', 'Y', '-', '-'],
  'audit.view':         ['Y', 'Y', 'Y', '-', '-'],
  'settings.travel':    ['Y', 'Y', '-', '-', '-'],
  'settings.company':   ['Y', '-', '-', '-', '-'],
};

/**
 * Permissions that reach only some records, and how allowed() picks them. Every other permission covers
 * every record in the member's own company (the company itself is checked by Repo.getIn).
 * @type {Readonly<Record<string, 'own'|'team'|'dept'|'decider'|'not_traveler'>>}
 */
const SCOPES = Object.freeze({
  'request.view.own': 'own',
  'request.view.team': 'team',
  'budget.view.dept': 'dept',
  'approval.decide': 'decider',
  'approval.override': 'not_traveler',
});

// Object.freeze does not stop Set#add/delete, so the exported Sets refuse every change themselves.
class LockedSet extends Set {
  constructor(items) { super(items); this.locked = true; Object.freeze(this); }
  add(v) { if (this.locked) throw new TypeError('[business] the permission matrix is read-only'); return super.add(v); }
  delete() { throw new TypeError('[business] the permission matrix is read-only'); }
  clear() { throw new TypeError('[business] the permission matrix is read-only'); }
}
const freezeSets = build => Object.freeze(Object.fromEntries(ROLES.map((role, i) => [role, new LockedSet(build(i))])));

/** Role → Set of permissions the role holds. @type {Readonly<Record<Role, ReadonlySet<string>>>} */
const PERMS = freezeSets(i => PERMISSIONS.filter(p => MATRIX[p][i] === 'Y'));

/** Role → Set of the permissions it holds that reach only some records (see SCOPES). */
const OWN = freezeSets(i => PERMISSIONS.filter(p => MATRIX[p][i] === 'Y' && Object.hasOwn(SCOPES, p)));

/** Roles each role may grant, change or remove with `members.manage`. Only an Owner grants owner or finance. */
const ASSIGNABLE = Object.freeze({
  owner: Object.freeze([...ROLES]),
  travel_admin: Object.freeze(['travel_admin', 'manager', 'employee']),
});

/**
 * Does the role hold the permission (on at least some records)? Unknown roles and permissions are false.
 * @param {string} role
 * @param {string} perm
 * @returns {boolean}
 */
function can(role, perm) {
  return Object.hasOwn(PERMS, role) && PERMS[role].has(perm);
}

/**
 * Does the role hold any of these permissions?
 * @param {string} role
 * @param {ReadonlyArray<string>} perms
 * @returns {boolean}
 */
function canAny(role, perms) {
  return Array.isArray(perms) && perms.some(p => can(role, p));
}

/**
 * Does the role hold the permission only on some records (allowed() decides which)?
 * True for request.view.own, request.view.team, budget.view.dept, approval.decide and approval.override.
 * @param {string} role
 * @param {string} perm
 * @returns {boolean}
 */
function ownOnly(role, perm) {
  return Object.hasOwn(OWN, role) && OWN[role].has(perm);
}

/**
 * The record scope of a permission: 'org' (every record in the company) or one of SCOPES.
 * @param {string} perm
 * @returns {'org'|'own'|'team'|'dept'|'decider'|'not_traveler'}
 */
function scopeOf(perm) {
  return Object.hasOwn(SCOPES, perm) ? SCOPES[perm] : 'org';
}

/**
 * The roles this role may grant (and change or remove members of) with `members.manage`.
 * Owner → every role; Travel Admin → Travel Admin, Manager, Employee; anyone else → none.
 * @param {string} role
 * @returns {ReadonlyArray<Role>}
 */
function assignableBy(role) {
  return Object.hasOwn(ASSIGNABLE, role) ? ASSIGNABLE[role] : [];
}

/**
 * The permission check a service method makes: the role holds `perm`, and the record is one the
 * permission reaches for this member (SCOPES). Pass `record = null` for checks with no record (then any
 * holder passes, and lists must apply the scope themselves).
 * @param {{ role: string, userId: string, departmentId?: string|null }} member
 * @param {string} perm
 * @param {object|null} [record] a biz_request (travelerId, travelerManagerId, approval.approverId) or a
 *   departmental record (departmentId)
 * @param {{ pooled?: boolean }} [opts] pooled: the member holds a pool link for this request
 * @returns {boolean}
 */
function allowed(member, perm, record = null, { pooled = false } = {}) {
  if (!member || !can(member.role, perm)) return false;
  if (!record) return true;
  const me = member.userId;
  if (typeof me !== 'string' || !me) return false;
  const traveler = record.travelerId === me;
  const approver = !!record.approval && record.approval.approverId === me;
  switch (scopeOf(perm)) {
    case 'own': return traveler;
    case 'team': return traveler || approver || record.travelerManagerId === me || pooled === true;
    case 'dept': return typeof member.departmentId === 'string' && !!member.departmentId && record.departmentId === member.departmentId;
    case 'decider': return !traveler && (approver || pooled === true);
    case 'not_traveler': return !traveler;
    default: return true;
  }
}

/**
 * allowed() for any of several permissions (a route open to own, team or all requests).
 * @param {object} member
 * @param {ReadonlyArray<string>} perms
 * @param {object|null} [record]
 * @param {{ pooled?: boolean }} [opts]
 * @returns {boolean}
 */
function allowedAny(member, perms, record = null, opts = {}) {
  return Array.isArray(perms) && perms.some(p => allowed(member, p, record, opts));
}

module.exports = {
  ROLES, LABELS, PERMISSIONS, PERMS, OWN, SCOPES,
  can, canAny, ownOnly, scopeOf, assignableBy, allowed, allowedAny,
};
