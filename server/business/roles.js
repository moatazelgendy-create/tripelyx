// Tripelyx Business roles and permissions (plan §E). Frozen interface; test/business-foundation.test.js
// snapshots the whole matrix, so any change here is deliberate.
//
// Rules that live outside this table:
// - The role comes from the biz_member record, read on every request. Platform admins (isAdmin) get no
//   org access from that alone.
// - BusinessService re-checks can() and the own-scope inside every method, so a route bug cannot skip them.
// - "own" means an Advisor (or, for reminders, a Support Agent or Finance member) acts only on records whose
//   advisorId is their own user id. For `org.view` it means the Advisor's dashboard counts only their own
//   records; the team list and the Coming soon page have no owner.

/** @typedef {'owner'|'manager'|'advisor'|'support'|'finance'|'readonly'} Role */

/** @type {ReadonlyArray<Role>} */
const ROLES = Object.freeze(['owner', 'manager', 'advisor', 'support', 'finance', 'readonly']);

/** Role → label shown in the workspace. */
const LABELS = Object.freeze({
  owner: 'Owner',
  manager: 'Manager',
  advisor: 'Advisor',
  support: 'Support Agent',
  finance: 'Finance',
  readonly: 'Read Only',
});

/** Every permission, in the order of the plan's table. */
const PERMISSIONS = Object.freeze([
  'org.view',             // dashboard, team list, coming soon
  'proposals.view',       // client-visible content, pipeline
  'proposals.edit',       // brief, build, draft, tools, versions, resolve
  'proposals.send',       // send, create links
  'shares.revoke',
  'proposals.assign',
  'proposals.stage',      // Finance: payment_pending and booked only (STAGE_LIMITS)
  'pricing.viewInternal', // Tripelyx price, markup, fees, discount, earnings, margin, flags
  'pricing.discount',     // up to the rules' maxDiscount
  'pricing.override',     // send a flagged option, with a reason
  'pricing.editRules',
  'brand.edit',
  'clients.view',         // what of a client each role sees: CLIENT_VIEW
  'clients.contact',      // email, phone
  'clients.edit',
  'clients.sensitive',    // reveal (audited)
  'clients.delete',
  'messages.reply',       // client-visible message
  'notes.add',            // internal note
  'reminders',
  'members.manage',       // which roles each may grant: assignableBy()
  'audit.view',
]);

// The matrix. Y = yes, O = own records only, '-' = no. Columns: owner, manager, advisor, support, finance, readonly.
const MATRIX = {
  'org.view':             ['Y', 'Y', 'O', 'Y', 'Y', 'Y'],
  'proposals.view':       ['Y', 'Y', 'O', 'Y', 'Y', 'Y'],
  'proposals.edit':       ['Y', 'Y', 'O', '-', '-', '-'],
  'proposals.send':       ['Y', 'Y', 'O', '-', '-', '-'],
  'shares.revoke':        ['Y', 'Y', 'O', 'Y', '-', '-'],
  'proposals.assign':     ['Y', 'Y', '-', '-', '-', '-'],
  'proposals.stage':      ['Y', 'Y', 'O', '-', 'Y', '-'],
  'pricing.viewInternal': ['Y', 'Y', 'O', '-', 'Y', '-'],
  'pricing.discount':     ['Y', 'Y', 'O', '-', '-', '-'],
  'pricing.override':     ['Y', 'Y', '-', '-', '-', '-'],
  'pricing.editRules':    ['Y', '-', '-', '-', 'Y', '-'],
  'brand.edit':           ['Y', 'Y', '-', '-', '-', '-'],
  'clients.view':         ['Y', 'Y', 'O', 'Y', 'Y', 'Y'],
  'clients.contact':      ['Y', 'Y', 'O', 'Y', '-', '-'],
  'clients.edit':         ['Y', 'Y', 'O', '-', '-', '-'],
  'clients.sensitive':    ['Y', 'Y', 'O', '-', '-', '-'],
  'clients.delete':       ['Y', 'Y', '-', '-', '-', '-'],
  'messages.reply':       ['Y', 'Y', 'O', 'Y', '-', '-'],
  'notes.add':            ['Y', 'Y', 'O', 'Y', 'Y', '-'],
  'reminders':            ['Y', 'Y', 'O', 'O', 'O', '-'],
  'members.manage':       ['Y', 'Y', '-', '-', '-', '-'],
  'audit.view':           ['Y', 'Y', '-', '-', 'Y', '-'],
};

const freezeSets = build => Object.freeze(Object.fromEntries(ROLES.map((role, i) => [role, Object.freeze(new Set(build(i)))])));

/** Role → Set of permissions the role holds (own-only ones included). @type {Readonly<Record<Role, ReadonlySet<string>>>} */
const PERMS = freezeSets(i => PERMISSIONS.filter(p => MATRIX[p][i] !== '-'));

/** Role → Set of permissions the role holds only on its own records. */
const OWN = freezeSets(i => PERMISSIONS.filter(p => MATRIX[p][i] === 'O'));

/**
 * Stages a role may set by hand when it is not every stage. Finance records money steps only.
 * @type {Readonly<Partial<Record<Role, ReadonlyArray<string>>>>}
 */
const STAGE_LIMITS = Object.freeze({ finance: Object.freeze(['payment_pending', 'booked']) });

/**
 * How much of a client profile each role sees with `clients.view`:
 * 'full' = name, preferences and (with clients.contact) contact details; 'prefs' = name and preferences;
 * 'name' = the name only. Sensitive fields never render on a GET for anyone (audited reveal POST only).
 */
const CLIENT_VIEW = Object.freeze({ owner: 'full', manager: 'full', advisor: 'full', support: 'prefs', finance: 'name', readonly: 'name' });

/** Roles each role may grant, change or remove with `members.manage`. */
const ASSIGNABLE = Object.freeze({
  owner: Object.freeze([...ROLES]),
  manager: Object.freeze(['advisor', 'support', 'readonly']),
});

/**
 * Does the role hold the permission (on at least its own records)? Unknown roles and permissions are false.
 * @param {string} role
 * @param {string} perm
 * @returns {boolean}
 */
function can(role, perm) {
  return Object.hasOwn(PERMS, role) && PERMS[role].has(perm);
}

/**
 * Is the role limited to its own records for this permission (advisorId === its user id)?
 * True for the Advisor's "own" cells and for Support and Finance on reminders.
 * @param {string} role
 * @param {string} perm
 * @returns {boolean}
 */
function ownOnly(role, perm) {
  return Object.hasOwn(OWN, role) && OWN[role].has(perm);
}

/**
 * The roles this role may grant (and change or remove members of) with `members.manage`.
 * Owner → every role; Manager → Advisor, Support Agent, Read Only; anyone else → none.
 * @param {string} role
 * @returns {ReadonlyArray<Role>}
 */
function assignableBy(role) {
  return Object.hasOwn(ASSIGNABLE, role) ? ASSIGNABLE[role] : [];
}

/**
 * May the role move a proposal to this stage by hand? Needs `proposals.stage`; Finance only to
 * payment_pending or booked. (The own-scope is checked separately with ownOnly.)
 * @param {string} role
 * @param {string} stage
 * @returns {boolean}
 */
function canSetStage(role, stage) {
  if (!can(role, 'proposals.stage')) return false;
  return Object.hasOwn(STAGE_LIMITS, role) ? STAGE_LIMITS[role].includes(stage) : true;
}

/**
 * How much of a client the role sees: 'full' | 'prefs' | 'name', or null without clients.view.
 * @param {string} role
 * @returns {'full'|'prefs'|'name'|null}
 */
function clientView(role) {
  return can(role, 'clients.view') ? CLIENT_VIEW[role] : null;
}

/**
 * The permission check a service method makes: the role holds `perm`, and when it is own-only for that
 * role, the record's advisorId is the member's user id. Pass `record = null` for checks with no record
 * (then own-only roles pass, and their lists must be filtered by advisorId).
 * @param {{ role: string, userId: string }} member
 * @param {string} perm
 * @param {{ advisorId?: string|null }|null} [record]
 * @returns {boolean}
 */
function allowed(member, perm, record = null) {
  if (!member || !can(member.role, perm)) return false;
  if (!record || !ownOnly(member.role, perm)) return true;
  return !!record.advisorId && record.advisorId === member.userId;
}

module.exports = {
  ROLES, LABELS, PERMISSIONS, PERMS, OWN, STAGE_LIMITS, CLIENT_VIEW,
  can, ownOnly, assignableBy, canSetStage, clientView, allowed,
};
