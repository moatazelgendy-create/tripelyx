// Who is acting, re-read on every service call (plan §I7; from 1C's _actor, _need and _audit).
//
// A route hands a service method `actor = { org, member, user }` (req.biz.actor from memberGate). The
// method never trusts the org or member objects in it: loadActor re-reads the company and the member record
// by the ids, so the role always comes from biz_member as it is now, and a stale or forged actor (another
// company, a removed member, a made-up role) gets 404. Then need() checks the permission (403) and, for a
// record, its scope (404). auditInsert() builds the audit entry that goes in the same commit as the change (D7).
const { AppError } = require('../lib/errors');
const { id } = require('../lib/ids');
const { KINDS, BUSINESS_EMAIL, AUDIT_ACTIONS, ID_PREFIX } = require('./constants');
const { LABELS, can, allowed } = require('./roles');
const { text } = require('./validate');

/** The member record id: one per (company, user). Ids are base64url, so the '.' cannot be spoofed. */
const memberId = (orgId, userId) => `${orgId}.${userId}`;

/** The suspended-company message (403). */
const SUSPENDED = `Tripelyx has paused this company workspace. Write to ${BUSINESS_EMAIL}.`;

/**
 * The 403 message for a role without the permission.
 * @param {string} role
 * @param {string} [orgName]
 * @returns {string}
 */
function roleMessage(role, orgName) {
  return `Your role (${LABELS[role] || 'Unknown'}) can't open this page. Ask a travel admin at ${orgName || 'your company'} if you need it.`;
}

/** 404: not a member, another company's id, or a record the member may not see. */
const notFound = () => new AppError('not_found', 'Not found.', 404);
/** 403 for a member whose role lacks the permission (carries the role for the page). */
const forbidden = (role, orgName) => Object.assign(new AppError('forbidden', roleMessage(role, orgName), 403), { role: role || null });
/** 403 for a suspended company. */
const suspended = () => new AppError('org_suspended', SUSPENDED, 403);

/**
 * Re-read the company and the member behind an actor. Missing company, missing or removed member → 404;
 * suspended company → 403. A pending company works (its owners set it up while Tripelyx confirms it).
 * @param {import('./repo').Repo} repo
 * @param {{ org?: { id?: string }, user?: { id?: string } }} actor
 * @returns {Promise<{ org: object, member: object, user: object }>}
 */
async function loadActor(repo, actor) {
  const userId = actor && actor.user && actor.user.id;
  const orgId = actor && actor.org && actor.org.id;
  if (typeof userId !== 'string' || !userId || typeof orgId !== 'string' || !orgId) throw notFound();
  const org = await repo.getIn(KINDS.org, orgId, orgId);
  if (!org) throw notFound();
  const member = await repo.getIn(KINDS.member, memberId(orgId, userId), orgId);
  if (!member || member.userId !== userId || member.status !== 'active') throw notFound();
  if (org.status === 'suspended') throw suspended();
  return { org, member, user: actor.user };
}

/**
 * Throws 403 unless the member's role holds `perm`; 404 when `record` is not one the permission reaches
 * for this member (roles.allowed).
 * @param {{ org: object, member: object }} a from loadActor
 * @param {string} perm
 * @param {object|null} [record]
 * @param {{ pooled?: boolean }} [opts]
 */
function need(a, perm, record = null, opts = {}) {
  if (!can(a.member.role, perm)) throw forbidden(a.member.role, a.org && a.org.name);
  if (record && !allowed(a.member, perm, record, opts)) throw notFound();
}

/**
 * The actor as an audit entry records it: { userId, name, role }.
 * @param {{ member: object, user: object }} a
 * @returns {{ userId: string, name: string, role: string }}
 */
function who(a) {
  return { userId: a.user.id, name: String(a.member.name || a.user.name || ''), role: a.member.role };
}

/** A platform admin as an audit entry records them. */
const platformActor = user => ({ platformAdmin: user.id, name: String(user.name || '') });
/** An automatic change (policy auto-approval, the clock's expiry). */
const systemActor = what => {
  if (what !== 'policy' && what !== 'clock') throw new Error(`[business] unknown system actor ${what}`);
  return { system: what };
};

/**
 * The insert entry for one audit record, for Repo.commit({ inserts }) alongside the change it records.
 * The group is the action's prefix; unknown actions throw. `at` comes from the injected clock.
 * @param {import('./repo').Repo} repo
 * @param {{ orgId: string, actor: object, action: string, target: { kind: string, id: string }, summary: string,
 *   changes?: Array<{ path: string, before: any, after: any }> }} entry
 * @returns {{ kind: string, id: string, data: object, owner: string }}
 */
function auditInsert(repo, { orgId, actor, action, target, summary, changes = [] }) {
  const group = typeof action === 'string' ? action.split('.')[0] : '';
  if (!Object.hasOwn(AUDIT_ACTIONS, group) || !AUDIT_ACTIONS[group].includes(action)) throw new Error(`[business] unknown audit action ${action}`);
  if (!actor || typeof actor !== 'object') throw new Error('[business] an audit entry needs an actor');
  if (!target || typeof target.kind !== 'string' || typeof target.id !== 'string') throw new Error('[business] an audit entry needs a target');
  if (!Array.isArray(changes) || changes.length > 100) throw new Error('[business] audit changes must be a list of at most 100');
  const auditId = id(ID_PREFIX.audit);
  return {
    kind: KINDS.audit,
    id: auditId,
    owner: orgId,
    data: {
      id: auditId, orgId, at: repo.iso(), actor, action, group, target: { kind: target.kind, id: target.id },
      summary: text(summary, 300), changes,
    },
  };
}

module.exports = {
  loadActor, need, who, platformActor, systemActor, auditInsert, memberId, roleMessage, notFound, forbidden, suspended,
  SUSPENDED,
};
