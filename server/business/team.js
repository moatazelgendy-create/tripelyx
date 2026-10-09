// Companies, members, invites, departments, settings, the activity log and the platform admin's view (plan
// §B6, §B7, §C3, §D, §I5, §I8). Every method is a BusinessService method (service.js assigns `methods` onto
// its prototype), so `this` is the service: this.repo, this.accounts, this.config, this.now, this.log,
// this.policy (resolveApprover for the People warnings).
// Built in Stage 1W-a from 1C's service.js:451-725, rewritten on Repo.commit with D3, D4, D5 and D8, the
// corporate roles and copy, and departments.
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
//
// How the D-rules are kept:
// - D3: one pending invite per (company, email). The biz_invite_email pointer names it; a new invite moves
//   the pointer and revokes the old invite ('replaced') in the same commit, and accepting needs the pointer
//   to still name this invite. Accepting, revoking and removing the member clear it.
// - D4: config.business.maxOrgsPerUser counts biz_user_index.orgIds, re-checked inside the index cas.
// - D5: the account's email must be exactly the invite's (the token was sent to it); no takeover.
// - An invite carries its inviter's authority only while they hold it: accepting re-reads the inviter, who
//   must still be an active member able to grant the invite's role, and checks their record's rev in the
//   same commit (a demotion racing the accept wins, and the accept answers 410). A new invite for the same
//   email may replace only an invite whose role the new inviter could grant.
// - D8: org.ownerIds changes in the same commit as the member, against the org rev the actor read, so two
//   owners demoting (or removing) each other at once: exactly one wins, the other gets 409; the cas fn
//   refuses an empty list (422 'last_owner').
// - Every admin write also checks the acting member's own rev, so a change made by someone whose role was
//   taken away a moment earlier never lands.
// - Joins and removals of different people change only counters on biz_org, so they cas it against the rev
//   read at commit time (its fn re-checks status and the cap) and retry; departments cas the org against the
//   rev read before listing them, which serializes creates and renames (unique names, the 200 cap).
// - Audit summaries never carry a full email: Finance reads the activity log without members.manage.
// - Company members see the org without the platform's statusBy and statusNote (orgView), and a platform
//   change is recorded under the name "Tripelyx". The platform methods ask accounts.isPlatformAdmin each time.
// - A confirmed company that takes a new name (a new nameKey) goes back to 'pending' until Tripelyx confirms
//   it again (not with config.business.selfServe). The settings form is stale only when a setting changed
//   after it was loaded (org.settingsRev, the org rev of the last settings change), not on every org write.
// - Tripelyx's own company (go-live design §3.8) is the one company named Tripelyx: only
//   platformCreateHouseCompany makes it (createCompany's commit with the house flag), its biz_house record
//   (one fixed id, insert-only) goes in the same commit so there is only ever one, and its name never changes.
const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
const { id } = require('../lib/ids');
const {
  DEFAULT_TIMEZONE, COMPANY_SIZES, KINDS, ID_PREFIX, TIERS, TIMEZONES, OUT_OF_POLICY_MODES, BUDGET_PERIODS,
  APPROVAL_HOURS_RANGE, REASON_MIN_CHARS, GENERAL_DEPARTMENT, MEMBER_CAP, DEPARTMENT_CAP, PAGE_SIZE, SCAN_CAP, AUDIT_GROUPS,
  CURRENCY, BUSINESS_EMAIL, HOUSE_COMPANY_NAME, HOUSE_ID, HOUSE_NAME_FIXED, signupAck,
} = require('./constants');
const { ROLES, LABELS, can, assignableBy } = require('./roles');
const v = require('./validate');
const { loadActor, need, who, auditInsert, memberId, notFound, forbidden, suspended } = require('./actor');
const { conflict, ORG_ID_RE, USER_ID_RE } = require('./repo');
const { newToken, hashToken, sameHash, isToken } = require('./tokens');
const { defaultPolicy, DEFAULTS_NOTE } = require('./policy/defaults');
const { requestSource } = require('./source');

/** The sign-up form's company fields and their defaults. */
const COMPANY_FORM = Object.freeze({ sizes: COMPANY_SIZES, defaultTimezone: DEFAULT_TIMEZONE });

const DAY = 86400000;
/** An invite's public id (lib/ids.id('inv')) and a department id (id('dep')). */
const PUBLIC_ID_RE = /^inv_[A-Za-z0-9_-]{16}$/;
const DEPARTMENT_ID_RE = /^dep_[A-Za-z0-9_-]{16}$/;
/** Rows per store call when a method reads a whole kind (members, invites, an export). */
const SCAN_PAGE = 200;
/** A company export reads at most this many records of each kind. */
const EXPORT_CAP = 20000;
/** Each exported request's price_source, in the requests CSV's words (csv.js price_source). */
const PRICE_SOURCE_LABELS = Object.freeze({ demo: 'Demo price', sandbox: 'Supplier test data', live: 'Supplier price' });
/**
 * The export's note: with only demo requests (or none, under demo inventory) the preview note word for word;
 * with any supplier request, that each request's price_source names where its amounts came from; with no
 * request and no demo inventory (www and production today: go-live design §3.4), the plain export note, which
 * names nothing that isn't there.
 */
const EXPORT_NOTES = Object.freeze({
  demo: `Tripelyx Business preview. Amounts are whole US cents from demo prices: nothing was booked or charged. Questions: ${BUSINESS_EMAIL}.`,
  supplier: `Tripelyx Business preview. Amounts are whole US cents from demo prices, supplier test data or supplier prices, as each request's price_source says: nothing was booked or charged. Questions: ${BUSINESS_EMAIL}.`,
  plain: `Tripelyx Business export. Amounts are whole US cents. Nothing was booked or charged. Questions: ${BUSINESS_EMAIL}.`,
});
/** A request as the export carries it: its own fields, with price_source (the CSV's words) for its stored source. */
function exportedRequest(r) {
  const out = { ...r, price_source: PRICE_SOURCE_LABELS[requestSource(r)] };
  delete out.source;
  return out;
}

/**
 * Which export note fits, from the requests and the inventory's status: any supplier request names each
 * request's price_source; requests that are all demo came from demo prices; with no requests at all, demo
 * prices are named only under demo inventory (with no supplier, as on www and production, every amount is the
 * company's own).
 */
function exportNote(requests, inventory) {
  if (requests.some(r => requestSource(r) !== 'demo')) return EXPORT_NOTES.supplier;
  if (requests.length || (inventory && inventory.status === 'demo')) return EXPORT_NOTES.demo;
  return EXPORT_NOTES.plain;
}
/** A filtered activity page reads at most this many store pages, then offers "Show older". */
const FILTER_PAGES = 25;
/** Platform list order: waiting companies first. */
const STATUS_ORDER = Object.freeze({ pending: 0, active: 1, suspended: 2 });
/** Retries for server-side writes whose only contention is a counter on biz_org (each round lets one through). */
const COUNTER_TRIES = 10;
/** How a platform change appears to the company: Tripelyx, never the staff member's own name. */
const PLATFORM_NAME = 'Tripelyx';
/** The member fields updateMember may change, in the order changes are listed. */
const MEMBER_FIELDS = Object.freeze(['role', 'departmentId', 'managerId', 'approverId', 'tier']);
const FIELD_WORDS = Object.freeze({ departmentId: 'department', managerId: 'manager', approverId: 'approver', tier: 'policy tier' });

// ---------------------------------------------------------------------------------------------------
// Errors

const fieldError = message => new AppError('invalid_field', message, 422);
const invalid = (code, details) => new AppError(code, 'Check the highlighted fields.', 422, details);
const inviteGone = () => new AppError('invite_gone', "This invite link can't be used anymore. Ask your company's travel admin for a new one.", 410);
const lastOwner = () => new AppError('last_owner', 'A company needs at least one Owner. Make someone else an Owner first.', 422);
const removeSelf = () => new AppError('remove_self', "You can't remove yourself. Ask another Owner or Travel Admin.", 422);
const companyFull = () => new AppError('company_full', `A company can have up to ${MEMBER_CAP.toLocaleString('en-US')} people for now.`, 409);
const alreadyMember = () => new AppError('already_member', 'This person is already on your team.', 409);
const youAreMember = () => new AppError('already_member', "You're already in this company.", 409);
const notPending = () => new AppError('invite_not_pending', 'This invite was already used, cancelled or has expired.', 409);
const departmentExists = () => new AppError('department_exists', 'There is already a department with this name.', 409);
const companyPending = name => new AppError('company_pending', `${name} is waiting for Tripelyx to confirm it. Try this link again once it's confirmed.`, 409);
const tooMany = max => new AppError('too_many_companies',
  `You're already in ${max} ${max === 1 ? 'company' : 'companies'}, the most one account can join for now.`, 422);
const emailMismatch = (inviteEmail, userEmail) => new AppError('invite_email_mismatch',
  `This invite is for ${maskEmail(inviteEmail)}. You're signed in as ${userEmail}. Sign out to use it, or ask your admin to invite ${userEmail}.`, 403);

// ---------------------------------------------------------------------------------------------------
// Small helpers

const blank = x => x === undefined || x === null || String(x).trim() === '';
const given = (form, key) => Object.hasOwn(form, key) && form[key] !== undefined;
const yes = x => x === true || x === '1' || x === 'on' || x === 'true';
const addDays = (iso, days) => new Date(Date.parse(iso) + days * DAY).toISOString();
const isUserId = x => typeof x === 'string' && USER_ID_RE.test(x);
const isAdmin = actor => !!(actor && actor.user && actor.user.isAdmin === true && isUserId(actor.user.id));
/** The pointer id of one (company, email): `${orgId}.${sha256(email).slice(0, 32)}` (D3). */
const pointerId = (orgId, email) => `${orgId}.${crypto.createHash('sha256').update(String(email)).digest('hex').slice(0, 32)}`;
/** "d***@acme.com": an email as audit entries and other people's screens may show it. */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '***';
  return `${s.slice(0, 1)}***${s.slice(at)}`;
}
/** The platform's "similar name" key: lowercased letters and digits only. */
const nameKeyOf = name => String(name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** A comparison key for department names (case- and accent-insensitive, spaces squeezed). */
const deptKey = name => String(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Can this invite still be accepted at `nowIso`? */
const usable = (inv, nowIso) => !!inv && !inv.acceptedAt && !inv.revokedAt && typeof inv.expiresAt === 'string' && inv.expiresAt > nowIso;
/** A form's rev (an integer or a digit string) as an integer, or NaN. */
const formRevOf = rev => (typeof rev === 'number' ? rev : /^\d{1,9}$/.test(String(rev ?? '')) ? Number(rev) : NaN);
/** Does a form's rev (an integer or a digit string) match the record's? */
function sameRev(rev, doc) {
  const n = formRevOf(rev);
  return Number.isInteger(n) && n === (doc.rev ?? 0);
}
/** The owner list after `userId` becomes (or stops being) an owner. */
function nextOwners(ownerIds, userId, owner) {
  const rest = (Array.isArray(ownerIds) ? ownerIds : []).filter(x => x !== userId);
  return owner ? [...rest, userId] : rest;
}
/**
 * Letters and digits that read as one of t, r, i, p, e, l, y, x (Cyrillic and Greek look-alikes, small
 * capitals, 1, 3, |, !), folded to that Latin letter. i and l (and 1, |, !) read alike, so both fold to 'i'.
 */
const CONFUSABLE = Object.freeze({
  'т': 't', 'τ': 't', 'ᴛ': 't', '7': 't',
  'г': 'r', 'ʀ': 'r',
  'і': 'i', 'ӏ': 'i', 'ι': 'i', 'ı': 'i', 'ɪ': 'i', 'ǀ': 'i', '1': 'i', '|': 'i', '!': 'i', 'l': 'i', 'ʟ': 'i',
  'р': 'p', 'ρ': 'p', 'ᴘ': 'p',
  'е': 'e', 'є': 'e', 'ε': 'e', 'ᴇ': 'e', '3': 'e',
  'у': 'y', 'ү': 'y', 'γ': 'y', 'υ': 'y', 'ʏ': 'y',
  'х': 'x', 'χ': 'x', '×': 'x', 'ⅹ': 'x',
});
/** "Tripelyx" in any case, width, accent or spacing, or spelled with look-alike letters (on validate.text() output). */
function namesTripelyx(name) {
  const s = String(name).normalize('NFKC').toLowerCase();
  if (s.includes('tripelyx')) return true;
  const bare = s.normalize('NFKD').replace(/\p{M}/gu, '');
  if (bare.replace(/[^a-z0-9]/g, '').includes('tripelyx')) return true;
  const folded = [...bare].map(ch => CONFUSABLE[ch] || ch).join('').replace(/[^a-z]/g, '');
  return folded.includes('tripeiyx');
}
/**
 * A company name: required, ≤ 80 characters of NFKC text, never naming Tripelyx. `house` (only
 * platformCreateHouseCompany passes it, with HOUSE_COMPANY_NAME) skips that last check and nothing else.
 */
function companyName(x, { house = false } = {}) {
  const s = v.text(x, 80, { required: true });
  if (!house && namesTripelyx(s)) throw fieldError("Choose your own company's name.");
  return s;
}
/** The account's name as a member record keeps it. */
const memberName = user => v.text(user && user.name, 80);
/** Departments: active first, then archived; each by name. */
function sortDepartments(list) {
  return [...list].sort((a, b) => (!!a.archivedAt - !!b.archivedAt)
    || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** People-page order within one page: active first, then by role, then by name. */
function memberOrder(a, b) {
  return ((a.status !== 'active') - (b.status !== 'active')) || (ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
    || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }) || (a.userId < b.userId ? -1 : 1);
}
/** A pending invite as the People page and the copy-link page show it. */
function inviteView(inv, departmentsById) {
  const dep = inv.departmentId ? departmentsById.get(inv.departmentId) : null;
  return {
    publicId: inv.publicId, email: inv.email, role: inv.role, roleLabel: LABELS[inv.role], departmentName: dep ? dep.name : null,
    expiresAt: inv.expiresAt, at: inv.at,
  };
}

/** Can this member (still) hand out `role` through an invite: active, members.manage, and a role theirs may grant. */
const canGrant = (m, role) => !!m && m.status === 'active' && can(m.role, 'members.manage') && assignableBy(m.role).includes(role);

/**
 * The company as its members see it: every Org field, but never which Tripelyx staff member changed its
 * status or the note they wrote (statusBy and statusNote are null), and not the internal settingsRev.
 */
function orgView(org) {
  const { settingsRev: _settingsRev, previousName: _previousName, ...rest } = org; // eslint-disable-line no-unused-vars
  return { ...rest, statusBy: null, statusNote: null };
}

/** The org rev a settings form must be at least (the rev the last settings change wrote; 0 before any). */
const settingsRevOf = org => (Number.isInteger(org.settingsRev) ? org.settingsRev : 0);

/**
 * The platform admin behind a platform call. The isAdmin flag on the actor is only a first filter: the
 * service asks accounts.isPlatformAdmin (ADMIN_EMAILS and the platform_admin record, D1) every time, so a
 * made-up user, a flag set on an ordinary account or a revoked admin all get 404.
 * @this {{ accounts: object|null }} the service
 */
async function platformUser(actor) {
  if (!isAdmin(actor) || !this.accounts || typeof this.accounts.isPlatformAdmin !== 'function') throw notFound();
  if (await this.accounts.isPlatformAdmin(actor.user) !== true) throw notFound();
  return actor.user;
}

/**
 * Was the company still pending when Tripelyx last paused it? The newest 'org.suspended' entry of its
 * activity log says (a paused company writes nothing else, so it is on the first page). Then making it
 * active is its confirmation, not a reactivation.
 */
async function pausedWhilePending(repo, orgId) {
  let cursor = null;
  for (let reads = 0; reads < FILTER_PAGES; reads += 1) {
    const page = await repo.page(KINDS.audit, orgId, { limit: PAGE_SIZE, cursor });
    const hit = page.rows.find(e => e && e.orgId === orgId && e.action === 'org.suspended');
    if (hit) {
      const change = (Array.isArray(hit.changes) ? hit.changes : []).find(c => c && c.path === 'status');
      return !!change && change.before === 'pending';
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  return false;
}

/** The check entry that keeps the acting member's own record (and so their role) unchanged until the commit lands. */
function actorCheck(a, { server = true } = {}) {
  return { kind: KINDS.member, id: memberId(a.org.id, a.member.userId), rev: a.member.rev ?? 0, server };
}

/**
 * repo.commit, with a taken id turned into a retryable conflict: every id written here is random except the
 * deterministic ones (the user index, a member, an invite pointer), and a duplicate on those means a racing
 * writer got there first, so withRetry re-reads and decides again.
 */
async function commitOnce(repo, spec) {
  try {
    return await repo.commit(spec);
  } catch (e) {
    if (e instanceof AppError && e.code === 'already_exists') throw conflict({ retryable: true });
    throw e;
  }
}

/** Every record of a kind under one owner, newest stored first, reading at most `cap` (Repo.page). */
async function scanAll(repo, kind, scope, cap = SCAN_CAP) {
  const rows = [];
  let cursor = null;
  do {
    const page = await repo.page(kind, scope, { limit: SCAN_PAGE, cursor });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor && rows.length < cap);
  if (cursor && repo.log && typeof repo.log.warn === 'function') {
    repo.log.warn(`[business] team read the first ${rows.length} ${kind} records of a company and stopped.`);
  }
  return { rows, truncated: !!cursor };
}

/**
 * A user's company index (biz_user_index, id and owner the user id), read through the user's own scope
 * (Repo.list, so the only by-id read left here is the invite-token lookup, §I7). There is one per user; the
 * limit of 2 never reaches Repo.list's "limit reached" warning.
 */
async function userIndex(repo, userId) {
  const rows = await repo.list(KINDS.userIndex, userId, { limit: 2 });
  const d = rows.find(x => x && x.userId === userId);
  return d && Array.isArray(d.orgIds) ? d : null;
}

/** The index entry that adds orgId for userId under the D4 cap: an insert, or a cas re-checking the count. */
function indexAdd(index, userId, orgId, max) {
  if (!index) return { insert: { kind: KINDS.userIndex, id: userId, data: { userId, orgIds: [orgId], rev: 0 }, owner: userId } };
  return {
    cas: {
      kind: KINDS.userIndex, id: userId, rev: index.rev ?? 0, server: true,
      fn: d => {
        if (d.orgIds.includes(orgId)) return;
        if (d.orgIds.length >= max) throw tooMany(max);
        d.orgIds.push(orgId);
      },
    },
  };
}

/**
 * Tripelyx's own company, or null while there is none: the company the biz_house record names
 * (Repo.houseOrgId), when it is there and carries house: true.
 * @param {import('./repo').Repo} repo
 * @returns {Promise<import('./types').Org|null>}
 */
async function houseOf(repo) {
  const orgId = await repo.houseOrgId();
  const org = orgId ? await repo.getIn(KINDS.org, orgId, orgId) : null;
  return org && org.house === true ? org : null;
}

/**
 * The one commit that makes a company, for createCompany and platformCreateHouseCompany: biz_org (status
 * 'pending', or 'active' with config.business.selfServe), the Owner's biz_member (tier standard, department
 * General), the user's biz_user_index (insert, or CAS adding the id), the three biz_policy records at version 1
 * from policy/defaults.js with their biz_policy_version v1 (note DEFAULTS_NOTE, no changes), the "General"
 * biz_department, and the audit entry. Nothing is written when any part fails. `house` (passed only by
 * platformCreateHouseCompany, go-live design §3.8) makes Tripelyx's own company: 'active' at once, house: true,
 * the biz_house record (id HOUSE_ID) inserted in the same commit, so a second one can never be made, and the
 * audit entry 'org.house_created' under the name "Tripelyx". Run inside repo.withRetry: a taken id is a
 * retryable conflict (commitOnce).
 * @this {object} the service
 * @param {{ id: string, email?: string, name?: string }} user the signed-in account, the company's Owner
 * @param {{ name: string, size: string|null, timezone: string }} f the checked company fields
 * @param {{ house?: boolean }} [opts]
 * @returns {Promise<{ org: import('./types').Org, member: import('./types').Member }>}
 */
async function makeCompany(user, f, { house = false } = {}) {
  const biz = this.config.business;
  const max = biz.maxOrgsPerUser;
  const index = await userIndex(this.repo, user.id);
  if (index && index.orgIds.length >= max) throw tooMany(max);
  const at = this.repo.iso();
  const orgId = id(ID_PREFIX.org);
  const depId = id(ID_PREFIX.department);
  const name = memberName(user);
  const by = { userId: user.id, name, role: 'owner' };
  const org = {
    id: orgId, name: f.name, nameKey: nameKeyOf(f.name), status: house || biz.selfServe ? 'active' : 'pending', size: f.size,
    currency: CURRENCY, timezone: f.timezone,
    settings: { outOfPolicy: 'approval', approvalHours: biz.approvalHours, reasonMinChars: REASON_MIN_CHARS, budgetPeriod: 'quarter' },
    ownerIds: [user.id], memberCount: 1, createdBy: user.id, at, updatedAt: at, statusBy: null, statusAt: null, statusNote: null, rev: 0,
    ...(house ? { house: true } : {}),
  };
  const general = { id: depId, orgId, name: GENERAL_DEPARTMENT, archivedAt: null, at, updatedAt: at, rev: 0 };
  const member = {
    orgId, userId: user.id, email: String(user.email || '').toLowerCase(), name, role: 'owner', status: 'active', departmentId: depId,
    managerId: null, approverId: null, tier: 'standard', at, by: null, removedAt: null, rev: 0,
  };
  const policies = TIERS.flatMap(tier => {
    const rules = defaultPolicy(tier);
    return [
      { kind: KINDS.policy, id: `${orgId}.${tier}`, data: { orgId, tier, version: 1, rules, updatedAt: at, updatedBy: by, rev: 0 }, owner: orgId },
      {
        kind: KINDS.policyVersion, id: `${orgId}.${tier}.v1`, owner: orgId,
        data: { orgId, tier, version: 1, rules: defaultPolicy(tier), at, by, note: DEFAULTS_NOTE, changes: [] },
      },
    ];
  });
  const idx = indexAdd(index, user.id, orgId, max);
  const docs = await commitOnce(this.repo, {
    inserts: [
      { kind: KINDS.org, id: orgId, data: org, owner: null },
      { kind: KINDS.department, id: depId, data: general, owner: orgId },
      { kind: KINDS.member, id: memberId(orgId, user.id), data: member, owner: orgId },
      ...(idx.insert ? [idx.insert] : []),
      ...policies,
      ...(house ? [{ kind: KINDS.house, id: HOUSE_ID, data: { orgId, at, by: user.id }, owner: orgId }] : []),
      house
        ? auditInsert(this.repo, {
          orgId, actor: { platformAdmin: user.id, name: PLATFORM_NAME }, action: 'org.house_created', target: { kind: KINDS.org, id: orgId },
          summary: `Tripelyx created ${f.name}, its own company, with ${name} as its Owner`,
        })
        : auditInsert(this.repo, { orgId, actor: by, action: 'org.created', target: { kind: KINDS.org, id: orgId }, summary: `${name} created ${f.name}` }),
    ],
    cas: idx.cas ? [idx.cas] : [],
  });
  return { org: docs[`${KINDS.org}:${orgId}`], member: docs[`${KINDS.member}:${memberId(orgId, user.id)}`] };
}

const methods = {
  /**
   * Create a company with the signed-in user as its Owner (POST /business/start, after accounts.register or
   * for a signed-in account). One commit: biz_org (status 'pending', or 'active' with
   * config.business.selfServe), the Owner's biz_member (tier standard, department General), the user's
   * biz_user_index (insert, or CAS adding the id), the three biz_policy records at version 1 from
   * policy/defaults.js (defaultPolicy(tier); plain, final data, required directly) with their
   * biz_policy_version v1 (note DEFAULTS_NOTE, no changes), the "General"
   * biz_department, and the audit entry 'org.created'. Nothing is written when any part fails.
   * @param {import('./types').UserActor} actor
   * @param {{ name: string, size: string, timezone?: string, ack?: string }} form ack '1' = the sign-up consent box (SIGNUP_ACK)
   * @returns {Promise<{ org: import('./types').Org, member: import('./types').Member }>}
   * @throws {AppError} 404 no user; 422 'invalid_company' details { name: "Choose your own company's name." when
   *   it contains "tripelyx" (NFKC, case-insensitive), size, timezone, ack }; 422 'too_many_companies' at
   *   config.business.maxOrgsPerUser ("You're already in 3 companies, the most one account can join for now.")
   */
  async createCompany(actor, form) {
    const user = actor && actor.user;
    if (!user || !isUserId(user.id)) throw notFound();
    const f0 = form && typeof form === 'object' ? form : {};
    const f = v.collect('invalid_company', {
      name: () => companyName(f0.name),
      size: () => v.oneOf(f0.size, COMPANY_SIZES),
      timezone: () => v.oneOf(f0.timezone, TIMEZONES, { blank: DEFAULT_TIMEZONE }),
      ack: () => {
        if (!yes(f0.ack)) throw fieldError(signupAck(this.inventory ? this.inventory.status : null).error);
        return true;
      },
    });
    return this.repo.withRetry(() => makeCompany.call(this, user, f), { tries: 5 });
  },

  /**
   * The companies the user belongs to (active memberships only), in biz_user_index order: the switcher
   * and /business/app. Never throws for a user with none.
   * @param {import('./types').UserActor|import('./types').MemberActor} actor only actor.user is read
   * @returns {Promise<import('./types').CompanyLink[]>}
   */
  async listCompaniesFor(actor) {
    const user = actor && actor.user;
    if (!user || !isUserId(user.id)) return [];
    const index = await userIndex(this.repo, user.id);
    if (!index) return [];
    const out = [];
    for (const orgId of index.orgIds) {
      if (typeof orgId !== 'string' || !ORG_ID_RE.test(orgId)) continue;
      const [org, m] = await Promise.all([
        this.repo.getIn(KINDS.org, orgId, orgId),
        this.repo.getIn(KINDS.member, memberId(orgId, user.id), orgId),
      ]);
      if (!org || !m || m.userId !== user.id || m.status !== 'active') continue;
      out.push({ id: org.id, name: org.name, status: org.status, role: m.role, roleLabel: LABELS[m.role] });
    }
    return out;
  },

  /**
   * The company, for a member (org.view), as members see it: statusBy and statusNote (who at Tripelyx last
   * changed its status, and their internal note) are always null.
   * @param {import('./types').MemberActor} actor
   * @returns {Promise<import('./types').Org>}
   */
  async getOrg(actor) {
    const a = await loadActor(this.repo, actor);
    need(a, 'org.view');
    return orgView(a.org);
  },

  /**
   * The signed-in user's own active membership in a company, or null (no throw for a non-member, a bad id
   * or a suspended company). For /business/app and the invite landing.
   * @param {import('./types').UserActor} actor
   * @param {string} orgId
   * @returns {Promise<import('./types').Member|null>}
   */
  async membership(actor, orgId) {
    const user = actor && actor.user;
    if (!user || !isUserId(user.id) || typeof orgId !== 'string' || !ORG_ID_RE.test(orgId)) return null;
    const m = await this.repo.getIn(KINDS.member, memberId(orgId, user.id), orgId);
    return m && m.userId === user.id && m.status === 'active' ? m : null;
  },

  /**
   * The People page (members.view): members 50 per page (constants.PAGE_SIZE, Repo.page), pending invites
   * and emails only with members.manage, departments, and warnings for active members nobody can approve
   * ("Sam Traveler has no one who can approve their trips": this.policy.resolveApprover(...).rule === null).
   * @param {import('./types').MemberActor} actor
   * @param {{ cursor?: string|null }} [opts]
   * @returns {Promise<import('./types').PeopleView>}
   */
  async listMembers(actor, opts) {
    const a = await loadActor(this.repo, actor);
    need(a, 'members.view');
    const orgId = a.org.id;
    const manage = can(a.member.role, 'members.manage');
    const cursor = opts && typeof opts === 'object' ? opts.cursor ?? null : null;
    const page = await this.repo.page(KINDS.member, orgId, { limit: PAGE_SIZE, cursor });
    const all = (await scanAll(this.repo, KINDS.member, orgId)).rows.filter(m => m && m.orgId === orgId);
    const byId = Object.fromEntries(all.map(m => [m.userId, m]));
    const departments = sortDepartments(await this.repo.list(KINDS.department, orgId));
    const depById = new Map(departments.map(d => [d.id, d]));
    const ref = userId => (userId && byId[userId] ? { userId, name: byId[userId].name } : null);
    const members = page.rows.filter(m => m && m.orgId === orgId).sort(memberOrder).map(m => {
      const dep = m.departmentId ? depById.get(m.departmentId) : null;
      return {
        userId: m.userId, name: m.name, email: manage ? m.email : null, role: m.role, roleLabel: LABELS[m.role], status: m.status,
        department: dep ? { id: dep.id, name: dep.name } : null, manager: ref(m.managerId), approver: ref(m.approverId), tier: m.tier,
        at: m.at, rev: m.rev ?? 0,
      };
    });
    const warnings = all.filter(m => m.status === 'active').sort(memberOrder)
      .filter(m => this.policy.resolveApprover(m, byId).rule === null)
      .map(m => `${m.name} has no one who can approve their trips`);
    let invites = null;
    if (manage) {
      const nowIso = this.repo.iso();
      // Only invites that can still be accepted: unused, unexpired, and from someone who may still grant the role.
      invites = (await scanAll(this.repo, KINDS.invite, orgId)).rows
        .filter(i => i && i.orgId === orgId && usable(i, nowIso) && canGrant(byId[i.invitedBy], i.role))
        .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).map(i => inviteView(i, depById));
    }
    return { members, cursor: page.cursor, invites, departments, warnings, memberCount: a.org.memberCount };
  },

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
  async invite(actor, form) {
    const f0 = form && typeof form === 'object' ? form : {};
    return this.repo.withRetry(async () => {
      const a = await loadActor(this.repo, actor);
      need(a, 'members.manage');
      const orgId = a.org.id;
      const departments = await this.repo.list(KINDS.department, orgId);
      const depById = new Map(departments.map(d => [d.id, d]));
      const active = new Map((await scanAll(this.repo, KINDS.member, orgId)).rows
        .filter(m => m && m.orgId === orgId && m.status === 'active').map(m => [m.userId, m]));
      const f = v.collect('invalid_invite', {
        email: () => v.email(f0.email),
        role: () => v.oneOf(f0.role, ROLES),
        departmentId: () => pickDepartment(f0.departmentId, depById, null),
        managerId: () => pickMember(f0.managerId, active, { self: null, current: null }),
        approverId: () => pickMember(f0.approverId, active, { self: null, current: null }),
        tier: () => v.oneOf(f0.tier, TIERS, { blank: 'standard' }),
      });
      if (!assignableBy(a.member.role).includes(f.role)) throw forbidden(a.member.role, a.org.name);
      if ([...active.values()].some(m => m.email === f.email)) throw alreadyMember();
      if ((a.org.memberCount || 0) >= MEMBER_CAP) throw companyFull();

      const at = this.repo.iso();
      const token = newToken();
      const hash = hashToken(token);
      const pid = pointerId(orgId, f.email);
      const pointer = await this.repo.getIn(KINDS.inviteEmail, pid, orgId);
      const prev = pointer && pointer.inviteHash ? await this.repo.getIn(KINDS.invite, pointer.inviteHash, orgId) : null;
      // A pending invite that could still be accepted is replaced only by someone who could grant its role
      // (revokeInvite's rule), so a Travel Admin cannot swap an Owner's Finance invite for one of their own.
      const prevInviter = usable(prev, at) && isUserId(prev.invitedBy) ? active.get(prev.invitedBy) : null;
      const prevLive = !!prevInviter && canGrant(prevInviter, prev.role);
      if (prevLive && !assignableBy(a.member.role).includes(prev.role)) throw forbidden(a.member.role, a.org.name);
      const inv = {
        orgId, publicId: id(ID_PREFIX.invite), tokenHash: hash, email: f.email, role: f.role, departmentId: f.departmentId,
        managerId: f.managerId, approverId: f.approverId, tier: f.tier, invitedBy: a.member.userId, at,
        expiresAt: addDays(at, this.config.business.inviteDays), acceptedAt: null, acceptedBy: null, revokedAt: null, revokedReason: null, rev: 0,
      };
      const cas = [];
      const inserts = [{ kind: KINDS.invite, id: hash, data: inv, owner: orgId }];
      if (pointer) cas.push({ kind: KINDS.inviteEmail, id: pid, rev: pointer.rev ?? 0, server: true, fn: d => { d.inviteHash = hash; } });
      else inserts.push({ kind: KINDS.inviteEmail, id: pid, data: { orgId, inviteHash: hash, rev: 0 }, owner: orgId });
      if (prev && !prev.acceptedAt && !prev.revokedAt) {
        cas.push({
          kind: KINDS.invite, id: prev.tokenHash, rev: prev.rev ?? 0, server: true,
          fn: d => { d.revokedAt = at; d.revokedReason = 'replaced'; },
        });
      }
      inserts.push(auditInsert(this.repo, {
        orgId, actor: who(a), action: 'member.invited', target: { kind: KINDS.invite, id: inv.publicId },
        summary: `${who(a).name} invited ${maskEmail(f.email)} as ${LABELS[f.role]}`,
        changes: [{ path: 'role', before: null, after: f.role }, { path: 'tier', before: null, after: f.tier }],
      }));
      await commitOnce(this.repo, { cas, inserts, checks: [actorCheck(a)] });
      return { token, invite: inviteView(inv, depById), replaced: prevLive, orgName: a.org.name };
    }, { tries: 4 });
  },

  /**
   * The invite landing (GET /business/invite/:token; anyone holding the link). Reads by sha256(token) with
   * repo.get (a token lookup). Writes nothing. Signed out, the state is always 'join' (the page offers both
   * "Create your account" and "Already have an account? Sign in"): the landing never looks the invited email up,
   * so holding a link tells nobody whether that address has a Tripelyx account. POST /join answers "This email
   * already has an account. Sign in instead." behind bizAuthIp, as /business/start does.
   * @param {import('./types').UserActor} actor actor.user may be null (signed out)
   * @param {string} token
   * @returns {Promise<import('./types').InviteLanding>}
   * @throws {AppError} 410 'invite_gone' for a malformed, unknown, expired, revoked, replaced or used token, one
   *   whose inviter can no longer grant its role, or (signed in) one older than the user's removal; 403
   *   'org_suspended' when Tripelyx has paused the company (the same answers acceptInvite gives)
   */
  async inviteByToken(actor, token) {
    const { inv, org, inviter } = await usableInvite.call(this, token);
    const user = actor && actor.user && isUserId(actor.user.id) ? actor.user : null;
    const dep = inv.departmentId ? await this.repo.getIn(KINDS.department, inv.departmentId, org.id) : null;
    let state = null;
    if (user && await this.membership({ user }, org.id)) state = 'member';
    else if (org.status === 'pending') state = 'pending_company';
    else if (user) state = String(user.email || '').toLowerCase() === inv.email ? 'accept' : 'other_email';
    else state = 'join';
    if (state === 'accept') {
      // The landing never offers an accept that acceptInvite would refuse (a removed member's older invite).
      const existing = await this.repo.getIn(KINDS.member, memberId(org.id, user.id), org.id);
      if (existing && !rejoinable(existing, inv)) throw inviteGone();
    }
    return {
      org: { id: org.id, name: org.name, status: org.status, timezone: org.timezone },
      invite: {
        publicId: inv.publicId, email: inv.email, emailMasked: maskEmail(inv.email), role: inv.role, roleLabel: LABELS[inv.role],
        departmentName: dep ? dep.name : null, invitedByName: inviter.name || '', expiresAt: inv.expiresAt,
      },
      state,
    };
  },

  /**
   * Join a company from an invite (POST /invite/:token/accept, or /join right after accounts.register with
   * emailProof { via: 'invite', orgId, at }). The account's email must equal the invite's (D5); the pointer
   * must still point at this invite (D3); D4 cap; the inviter must still be an active member who may grant
   * the invite's role. One commit: invite CAS (acceptedAt, acceptedBy), pointer CAS (inviteHash null), the
   * biz_member insert (or CAS of a removed member back to active, only for an invite created at or after
   * removedAt), org CAS (memberCount + 1; ownerIds for an owner; against the rev read at commit time, so
   * joins of different people never block each other), user index insert or CAS, a check of the inviter's
   * member rev, audit 'member.joined'.
   * @param {import('./types').UserActor} actor
   * @param {string} token
   * @returns {Promise<{ org: import('./types').Org, member: import('./types').Member }>}
   * @throws {AppError} 410 'invite_gone'; 409 'company_pending' (not confirmed yet); 403 'org_suspended';
   *   403 'invite_email_mismatch'; 409 'already_member'; 422 'too_many_companies'; 409 'company_full'
   */
  async acceptInvite(actor, token) {
    const user = actor && actor.user;
    if (!user || !isUserId(user.id)) throw notFound();
    const max = this.config.business.maxOrgsPerUser;
    return this.repo.withRetry(async () => {
      const { hash, inv, org, pointer, inviter } = await usableInvite.call(this, token);
      if (org.status === 'pending') throw companyPending(org.name);
      const email = String(user.email || '').toLowerCase();
      if (email !== inv.email) throw emailMismatch(inv.email, email);
      const mid = memberId(org.id, user.id);
      const existing = await this.repo.getIn(KINDS.member, mid, org.id);
      if (existing && existing.status === 'active') throw youAreMember();
      // A removed member comes back only through an invite created after they were removed (D3).
      if (existing && !rejoinable(existing, inv)) throw inviteGone();
      const index = await userIndex(this.repo, user.id);
      if (index && !index.orgIds.includes(org.id) && index.orgIds.length >= max) throw tooMany(max);
      if ((org.memberCount || 0) >= MEMBER_CAP) throw companyFull();
      // The invite's links as they stand now: an archived department or a removed manager is dropped.
      const dep = inv.departmentId ? await this.repo.getIn(KINDS.department, inv.departmentId, org.id) : null;
      const activeId = async uid => {
        if (!isUserId(uid) || uid === user.id) return null;
        const m = await this.repo.getIn(KINDS.member, memberId(org.id, uid), org.id);
        return m && m.status === 'active' ? uid : null;
      };
      const at = this.repo.iso();
      const name = memberName(user);
      const fields = {
        email: inv.email, name, role: inv.role, status: 'active', departmentId: dep && !dep.archivedAt ? dep.id : null,
        managerId: await activeId(inv.managerId), approverId: await activeId(inv.approverId), tier: inv.tier, at, by: inv.invitedBy, removedAt: null,
      };
      const cas = [
        {
          kind: KINDS.invite, id: hash, rev: inv.rev ?? 0, server: true,
          fn: d => { if (!usable(d, at)) throw inviteGone(); d.acceptedAt = at; d.acceptedBy = user.id; },
        },
        {
          kind: KINDS.inviteEmail, id: pointerId(org.id, inv.email), rev: pointer.rev ?? 0, server: true,
          fn: d => { if (d.inviteHash !== hash) throw inviteGone(); d.inviteHash = null; },
        },
        {
          // Counters only, re-checked here: the rev read at commit time (another join just retries).
          kind: KINDS.org, id: org.id, rev: null,
          fn: d => {
            if (d.status === 'pending') throw companyPending(d.name);
            if (d.status !== 'active') throw suspended();
            if ((d.memberCount || 0) >= MEMBER_CAP) throw companyFull();
            d.memberCount = (d.memberCount || 0) + 1;
            if (inv.role === 'owner') d.ownerIds = nextOwners(d.ownerIds, user.id, true);
            d.updatedAt = at;
          },
        },
      ];
      const inserts = [];
      if (existing) {
        cas.push({
          kind: KINDS.member, id: mid, rev: existing.rev ?? 0, server: true,
          fn: d => { if (d.status === 'active') throw youAreMember(); Object.assign(d, fields); },
        });
      } else {
        inserts.push({ kind: KINDS.member, id: mid, data: { orgId: org.id, userId: user.id, ...fields, rev: 0 }, owner: org.id });
      }
      const idx = indexAdd(index, user.id, org.id, max);
      if (idx.insert) inserts.push(idx.insert);
      else cas.push(idx.cas);
      inserts.push(auditInsert(this.repo, {
        orgId: org.id, actor: { userId: user.id, name, role: inv.role }, action: 'member.joined', target: { kind: KINDS.member, id: user.id },
        summary: `${name} joined as ${LABELS[inv.role]}`, changes: [{ path: 'role', before: null, after: inv.role }],
      }));
      // The inviter keeps the role that lets them grant this one until the join lands (a racing demotion or
      // removal wins, and the retry answers 410).
      const checks = [{ kind: KINDS.member, id: memberId(org.id, inviter.userId), rev: inviter.rev ?? 0, server: true }];
      const docs = await commitOnce(this.repo, { cas, inserts, checks });
      return { org: orgView(docs[`${KINDS.org}:${org.id}`]), member: docs[`${KINDS.member}:${mid}`] };
    }, { tries: COUNTER_TRIES });
  },

  /**
   * Revoke a pending invite by its publicId (members.manage; roles.assignableBy must cover its role). One
   * commit: invite CAS (revokedAt, revokedReason 'manual'), pointer CAS (inviteHash null), audit
   * 'member.invite_revoked'.
   * @param {import('./types').MemberActor} actor
   * @param {string} publicId inv_…
   * @returns {Promise<import('./types').Invite>}
   * @throws {AppError} 404 unknown or another company's; 409 'invite_not_pending'
   */
  async revokeInvite(actor, publicId) {
    return this.repo.withRetry(async () => {
      const a = await loadActor(this.repo, actor);
      need(a, 'members.manage');
      if (typeof publicId !== 'string' || !PUBLIC_ID_RE.test(publicId)) throw notFound();
      const orgId = a.org.id;
      const inv = (await scanAll(this.repo, KINDS.invite, orgId)).rows.find(i => i && i.orgId === orgId && i.publicId === publicId);
      if (!inv) throw notFound();
      if (!assignableBy(a.member.role).includes(inv.role)) throw forbidden(a.member.role, a.org.name);
      const at = this.repo.iso();
      if (!usable(inv, at)) throw notPending();
      const pid = pointerId(orgId, inv.email);
      const pointer = await this.repo.getIn(KINDS.inviteEmail, pid, orgId);
      const cas = [{
        kind: KINDS.invite, id: inv.tokenHash, rev: inv.rev ?? 0, server: true,
        fn: d => { if (!usable(d, at)) throw notPending(); d.revokedAt = at; d.revokedReason = 'manual'; },
      }];
      if (pointer && pointer.inviteHash === inv.tokenHash) {
        cas.push({ kind: KINDS.inviteEmail, id: pid, rev: pointer.rev ?? 0, server: true, fn: d => { d.inviteHash = null; } });
      }
      const docs = await commitOnce(this.repo, {
        cas,
        checks: [actorCheck(a)],
        inserts: [auditInsert(this.repo, {
          orgId, actor: who(a), action: 'member.invite_revoked', target: { kind: KINDS.invite, id: inv.publicId },
          summary: `${who(a).name} cancelled the invite for ${maskEmail(inv.email)}`,
        })],
      });
      return docs[`${KINDS.invite}:${inv.tokenHash}`];
    }, { tries: 4 });
  },

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
  async updateMember(actor, userId, form) {
    const f0 = form && typeof form === 'object' ? form : {};
    const a = await loadActor(this.repo, actor);
    need(a, 'members.manage');
    const orgId = a.org.id;
    if (!isUserId(userId)) throw notFound();
    const mid = memberId(orgId, userId);
    const target = await this.repo.getIn(KINDS.member, mid, orgId);
    if (!target || target.userId !== userId || target.status !== 'active') throw notFound();
    const grant = assignableBy(a.member.role);
    if (!grant.includes(target.role)) throw forbidden(a.member.role, a.org.name);

    const depById = new Map((await this.repo.list(KINDS.department, orgId)).map(d => [d.id, d]));
    const people = new Map();
    for (const k of ['managerId', 'approverId']) {
      const uid = f0[k];
      if (!blank(uid) && isUserId(String(uid)) && !people.has(uid)) {
        const m = await this.repo.getIn(KINDS.member, memberId(orgId, uid), orgId);
        if (m && m.status === 'active' && m.userId === uid) people.set(uid, m);
      }
    }
    const f = v.collect('invalid_member', {
      role: () => (given(f0, 'role') && !blank(f0.role) ? v.oneOf(f0.role, ROLES) : target.role),
      departmentId: () => (given(f0, 'departmentId') ? pickDepartment(f0.departmentId, depById, target.departmentId) : target.departmentId),
      managerId: () => (given(f0, 'managerId') ? pickMember(f0.managerId, people, { self: userId, current: target.managerId }) : target.managerId),
      approverId: () => (given(f0, 'approverId') ? pickMember(f0.approverId, people, { self: userId, current: target.approverId }) : target.approverId),
      tier: () => (given(f0, 'tier') && !blank(f0.tier) ? v.oneOf(f0.tier, TIERS) : target.tier),
    });
    if (f.role !== target.role && !grant.includes(f.role)) throw forbidden(a.member.role, a.org.name);
    if (!sameRev(f0.rev, target)) throw conflict();
    const changes = MEMBER_FIELDS.filter(k => (f[k] ?? null) !== (target[k] ?? null)).map(k => ({ path: k, before: target[k] ?? null, after: f[k] ?? null }));
    if (!changes.length) return target;

    const at = this.repo.iso();
    const ownerChange = (target.role === 'owner') !== (f.role === 'owner');
    const cas = [{
      kind: KINDS.member, id: mid, rev: target.rev ?? 0,
      fn: d => {
        if (d.status !== 'active') throw notFound();
        for (const c of changes) d[c.path] = c.after;
      },
    }];
    if (ownerChange) {
      // D8: against the org as this actor read it, so a racing owner change makes this one a 409.
      if (!nextOwners(a.org.ownerIds, userId, f.role === 'owner').length) throw lastOwner();
      cas.push({
        kind: KINDS.org, id: orgId, rev: a.org.rev ?? 0,
        fn: d => {
          const owners = nextOwners(d.ownerIds, userId, f.role === 'owner');
          if (!owners.length) throw lastOwner();
          d.ownerIds = owners;
          d.updatedAt = at;
        },
      });
    }
    const roleChanged = f.role !== target.role;
    const actorName = who(a).name;
    const summary = roleChanged
      ? `${actorName} changed ${target.name}'s role from ${LABELS[target.role]} to ${LABELS[f.role]}`
      : `${actorName} changed ${target.name}'s ${listWords(changes.map(c => FIELD_WORDS[c.path]))}`;
    const docs = await this.repo.commit({
      cas,
      checks: a.member.userId === userId ? [] : [actorCheck(a, { server: false })],
      inserts: [auditInsert(this.repo, {
        orgId, actor: who(a), action: roleChanged ? 'member.role_changed' : 'member.updated', target: { kind: KINDS.member, id: userId }, summary, changes,
      })],
    });
    return docs[`${KINDS.member}:${mid}`];
  },

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
  async removeMember(actor, userId, form) {
    const f0 = form && typeof form === 'object' ? form : {};
    return this.repo.withRetry(async () => {
      const a = await loadActor(this.repo, actor);
      need(a, 'members.manage');
      const orgId = a.org.id;
      if (!isUserId(userId)) throw notFound();
      if (userId === a.member.userId) throw removeSelf();
      const mid = memberId(orgId, userId);
      const target = await this.repo.getIn(KINDS.member, mid, orgId);
      if (!target || target.userId !== userId || target.status !== 'active') throw notFound();
      if (!assignableBy(a.member.role).includes(target.role)) throw forbidden(a.member.role, a.org.name);
      if (!sameRev(f0.rev, target)) throw conflict();
      const wasOwner = target.role === 'owner' || (Array.isArray(a.org.ownerIds) && a.org.ownerIds.includes(userId));
      if (wasOwner && !nextOwners(a.org.ownerIds, userId, false).length) throw lastOwner();
      const at = this.repo.iso();
      const cas = [
        { kind: KINDS.member, id: mid, rev: target.rev ?? 0, fn: d => { if (d.status !== 'active') throw notFound(); d.status = 'removed'; d.removedAt = at; } },
        {
          // An owner's removal is checked against the org as this actor read it (D8: a racing owner change
          // makes it a 409); anyone else's only needs the count kept right, so a racing join just retries.
          kind: KINDS.org, id: orgId, rev: wasOwner ? a.org.rev ?? 0 : null,
          fn: d => {
            const owners = nextOwners(d.ownerIds, userId, false);
            if (!owners.length) throw lastOwner();
            d.ownerIds = owners;
            d.memberCount = Math.max(0, (d.memberCount || 0) - 1);
            d.updatedAt = at;
          },
        },
      ];
      const index = await userIndex(this.repo, userId);
      if (index && index.orgIds.includes(orgId)) {
        cas.push({ kind: KINDS.userIndex, id: userId, rev: index.rev ?? 0, server: true, fn: d => { d.orgIds = d.orgIds.filter(x => x !== orgId); } });
      }
      // A pending invite for their email goes too, so it cannot bring them straight back (D3).
      const pid = pointerId(orgId, target.email);
      const pointer = target.email ? await this.repo.getIn(KINDS.inviteEmail, pid, orgId) : null;
      const pending = pointer && pointer.inviteHash ? await this.repo.getIn(KINDS.invite, pointer.inviteHash, orgId) : null;
      if (pointer && pointer.inviteHash) {
        cas.push({ kind: KINDS.inviteEmail, id: pid, rev: pointer.rev ?? 0, server: true, fn: d => { d.inviteHash = null; } });
        if (pending && !pending.acceptedAt && !pending.revokedAt) {
          cas.push({
            kind: KINDS.invite, id: pending.tokenHash, rev: pending.rev ?? 0, server: true,
            fn: d => { if (!d.acceptedAt && !d.revokedAt) { d.revokedAt = at; d.revokedReason = 'removed'; } },
          });
        }
      }
      const docs = await commitOnce(this.repo, {
        cas,
        checks: [actorCheck(a, { server: false })],
        inserts: [auditInsert(this.repo, {
          orgId, actor: who(a), action: 'member.removed', target: { kind: KINDS.member, id: userId },
          summary: `${who(a).name} removed ${target.name} (${LABELS[target.role]})`,
          changes: [{ path: 'status', before: 'active', after: 'removed' }],
        })],
      });
      return docs[`${KINDS.member}:${mid}`];
    }, { tries: COUNTER_TRIES });
  },

  /**
   * Create, rename or archive a department (departments.manage). No departmentId → create (audit
   * 'department.created'); with a name change → 'department.renamed'; archive '1' → 'department.archived'
   * (its budgets and history stay; members keep it until changed). Names are unique per company,
   * case-insensitive, ≤ 80; at most constants.DEPARTMENT_CAP. Creates and renames cas the org against the
   * rev read before the departments were listed, so racing ones run one after another and see each other.
   * @param {import('./types').MemberActor} actor
   * @param {{ departmentId?: string, name?: string, archive?: string, rev?: string|number }} form
   * @returns {Promise<import('./types').Department>}
   * @throws {AppError} 422 'invalid_department' (details.name); 409 'department_exists'; 409 'conflict'; 404
   */
  async saveDepartment(actor, form) {
    const f0 = form && typeof form === 'object' ? form : {};
    return this.repo.withRetry(async () => {
      const a = await loadActor(this.repo, actor);
      need(a, 'departments.manage');
      const orgId = a.org.id;
      // Read before the list below: a create or rename that lands in between moves the org rev, so this
      // commit loses and the retry lists again (the cap and unique names hold under races).
      const serialize = { kind: KINDS.org, id: orgId, rev: a.org.rev ?? 0, server: true, fn: () => undefined };
      const all = await this.repo.list(KINDS.department, orgId);
      const at = this.repo.iso();
      const actorName = who(a).name;
      // Archived departments keep their name, but a new or renamed one may reuse it.
      const taken = (name, exceptId) => all.some(d => d.id !== exceptId && !d.archivedAt && deptKey(d.name) === deptKey(name));

      if (blank(f0.departmentId)) {
        const { name } = v.collect('invalid_department', { name: () => v.text(f0.name, 80, { required: true }) });
        if (all.length >= DEPARTMENT_CAP) throw invalid('invalid_department', { name: `A company can have up to ${DEPARTMENT_CAP} departments.` });
        if (taken(name, null)) throw departmentExists();
        const depId = id(ID_PREFIX.department);
        const docs = await commitOnce(this.repo, {
          cas: [serialize],
          checks: [actorCheck(a)],
          inserts: [
            { kind: KINDS.department, id: depId, data: { id: depId, orgId, name, archivedAt: null, at, updatedAt: at, rev: 0 }, owner: orgId },
            auditInsert(this.repo, {
              orgId, actor: who(a), action: 'department.created', target: { kind: KINDS.department, id: depId },
              summary: `${actorName} added the ${name} department`, changes: [{ path: 'name', before: null, after: name }],
            }),
          ],
        });
        return docs[`${KINDS.department}:${depId}`];
      }

      const depId = String(f0.departmentId);
      if (!DEPARTMENT_ID_RE.test(depId)) throw notFound();
      const dep = await this.repo.getIn(KINDS.department, depId, orgId);
      if (!dep) throw notFound();
      const next = { name: dep.name, archivedAt: dep.archivedAt };
      if (given(f0, 'name')) next.name = v.collect('invalid_department', { name: () => v.text(f0.name, 80, { required: true }) }).name;
      if (yes(f0.archive) && !dep.archivedAt) next.archivedAt = at;
      if (!sameRev(f0.rev, dep)) throw conflict();
      const renamed = next.name !== dep.name;
      if (renamed && !next.archivedAt && taken(next.name, dep.id)) throw departmentExists();
      if (!renamed && next.archivedAt === dep.archivedAt) return dep;
      const audits = [];
      if (renamed) {
        audits.push(auditInsert(this.repo, {
          orgId, actor: who(a), action: 'department.renamed', target: { kind: KINDS.department, id: dep.id },
          summary: `${actorName} renamed the ${dep.name} department to ${next.name}`, changes: [{ path: 'name', before: dep.name, after: next.name }],
        }));
      }
      if (next.archivedAt !== dep.archivedAt) {
        audits.push(auditInsert(this.repo, {
          orgId, actor: who(a), action: 'department.archived', target: { kind: KINDS.department, id: dep.id },
          summary: `${actorName} archived the ${next.name} department`, changes: [{ path: 'archivedAt', before: null, after: at }],
        }));
      }
      const docs = await commitOnce(this.repo, {
        cas: [
          { kind: KINDS.department, id: dep.id, rev: dep.rev ?? 0, fn: d => { d.name = next.name; d.archivedAt = next.archivedAt; d.updatedAt = at; } },
          ...(renamed ? [serialize] : []),
        ],
        checks: [actorCheck(a)],
        inserts: audits,
      });
      return docs[`${KINDS.department}:${dep.id}`];
    }, { tries: COUNTER_TRIES });
  },

  /**
   * Every department of the company (org.view), by name, archived last.
   * @param {import('./types').MemberActor} actor
   * @returns {Promise<import('./types').Department[]>}
   */
  async listDepartments(actor) {
    const a = await loadActor(this.repo, actor);
    need(a, 'org.view');
    return sortDepartments((await this.repo.list(KINDS.department, a.org.id)).filter(d => d && d.orgId === a.org.id));
  },

  /**
   * Save company settings. name and timezone need settings.company; outOfPolicy ('approval'|'block'),
   * approvalHours (4..168) and budgetPeriod ('quarter'|'month') need settings.travel. Changing a field whose
   * permission the member lacks → 403. One commit: org CAS, audit 'org.settings_changed' with changes.
   * The form's rev is the org rev it was loaded at. It is stale (409, before any field is checked) when a
   * setting changed after that (org.settingsRev) or when the org never had that rev; other org writes in
   * between (joins, removals, status) leave it current. A confirmed company whose name changes beyond case,
   * spacing and punctuation (nameKey) goes back to 'pending' until Tripelyx confirms it again (not with
   * config.business.selfServe); the audit entry lists that status change.
   * @param {import('./types').MemberActor} actor
   * @param {{ name?: string, timezone?: string, outOfPolicy?: string, approvalHours?: string, budgetPeriod?: string, rev: string|number }} form
   * @returns {Promise<import('./types').Org>} as getOrg shows it
   * @throws {AppError} 422 'invalid_settings' with details; 403; 409 'conflict'
   */
  async saveSettings(actor, form) {
    const f0 = form && typeof form === 'object' ? form : {};
    const formRev = formRevOf(f0.rev);
    return this.repo.withRetry(async () => {
      const a = await loadActor(this.repo, actor);
      const role = a.member.role;
      if (!can(role, 'settings.company') && !can(role, 'settings.travel')) need(a, 'settings.company');
      const org = a.org;
      if (!Number.isInteger(formRev) || formRev > (org.rev ?? 0) || formRev < settingsRevOf(org)) throw conflict();
      const s = org.settings || {};
      const f = v.collect('invalid_settings', {
        name: () => {
          if (!given(f0, 'name')) return org.name;
          // Tripelyx's own company keeps the name it was made with (go-live design §3.8).
          if (org.house === true) {
            if (v.text(f0.name, 80) !== org.name) throw fieldError(HOUSE_NAME_FIXED);
            return org.name;
          }
          return companyName(f0.name);
        },
        timezone: () => (given(f0, 'timezone') ? v.oneOf(f0.timezone, TIMEZONES) : org.timezone),
        outOfPolicy: () => (given(f0, 'outOfPolicy') ? v.oneOf(f0.outOfPolicy, OUT_OF_POLICY_MODES) : s.outOfPolicy),
        approvalHours: () => (given(f0, 'approvalHours') ? approvalHours(f0.approvalHours) : s.approvalHours),
        budgetPeriod: () => (given(f0, 'budgetPeriod') ? v.oneOf(f0.budgetPeriod, BUDGET_PERIODS) : s.budgetPeriod),
      });
      const fields = [
        ['name', org.name, f.name, 'settings.company'],
        ['timezone', org.timezone, f.timezone, 'settings.company'],
        ['settings.outOfPolicy', s.outOfPolicy, f.outOfPolicy, 'settings.travel'],
        ['settings.approvalHours', s.approvalHours, f.approvalHours, 'settings.travel'],
        ['settings.budgetPeriod', s.budgetPeriod, f.budgetPeriod, 'settings.travel'],
      ];
      const changes = [];
      for (const [path, before, after, perm] of fields) {
        if (before === after) continue;
        need(a, perm);
        changes.push({ path, before: before ?? null, after });
      }
      if (!changes.length) return orgView(org);
      const at = this.repo.iso();
      // A new name is a new identity for Tripelyx to confirm before anyone else joins.
      const reconfirm = org.status === 'active' && !this.config.business.selfServe && nameKeyOf(f.name) !== nameKeyOf(org.name);
      if (reconfirm) changes.push({ path: 'status', before: 'active', after: 'pending' });
      const actorName = who(a).name;
      const docs = await this.repo.commit({
        cas: [{
          kind: KINDS.org, id: org.id, rev: org.rev ?? 0, server: true,
          fn: d => {
            if (settingsRevOf(d) > formRev) throw conflict();
            // The name Tripelyx confirmed, so the platform list can say "Renamed from …" while it confirms the new one.
            if (reconfirm) d.previousName = d.name;
            d.name = f.name;
            d.nameKey = nameKeyOf(f.name);
            d.timezone = f.timezone;
            d.settings = { ...d.settings, outOfPolicy: f.outOfPolicy, approvalHours: f.approvalHours, budgetPeriod: f.budgetPeriod };
            if (reconfirm) {
              d.status = 'pending';
              d.statusAt = at;
              d.statusBy = null;
              d.statusNote = null;
            }
            d.settingsRev = (d.rev ?? 0) + 1;
            d.updatedAt = at;
          },
        }],
        checks: [actorCheck(a, { server: false })],
        inserts: [auditInsert(this.repo, {
          orgId: org.id, actor: who(a), action: 'org.settings_changed', target: { kind: KINDS.org, id: org.id },
          summary: reconfirm
            ? `${actorName} changed the company settings. Tripelyx will confirm the new name before anyone else can join.`
            : `${actorName} changed the company settings`,
          changes,
        })],
      });
      return orgView(docs[`${KINDS.org}:${org.id}`]);
    }, { tries: COUNTER_TRIES });
  },

  /**
   * The company's data as JSON (settings.company; POST /settings/export answers it as a download): the
   * org, members (their biz_member records only, no other user data), departments, policies and versions,
   * budgets, requests and the audit log, each paged in full. One commit with audit 'org.exported'.
   * @param {import('./types').MemberActor} actor
   * @returns {Promise<import('./types').CompanyExport>}
   */
  async exportCompany(actor) {
    const a = await loadActor(this.repo, actor);
    need(a, 'settings.company');
    const orgId = a.org.id;
    const read = async kind => {
      const r = await scanAll(this.repo, kind, orgId, EXPORT_CAP);
      return { rows: r.rows.filter(x => x && x.orgId === orgId), truncated: r.truncated };
    };
    const members = await read(KINDS.member);
    const departments = await read(KINDS.department);
    const policies = await read(KINDS.policy);
    const versions = await read(KINDS.policyVersion);
    const budgets = await read(KINDS.budget);
    const requests = await read(KINDS.request);
    const audit = await read(KINDS.audit);
    const exportedAt = this.repo.iso();
    const data = {
      format: 'tripelyx-business-company-export',
      version: 1,
      exportedAt,
      note: exportNote(requests.rows, this.inventory),
      org: orgView(a.org),
      members: members.rows,
      departments: sortDepartments(departments.rows),
      policies: TIERS.map(t => policies.rows.find(p => p.tier === t)).filter(Boolean),
      policyVersions: versions.rows.sort((x, y) => TIERS.indexOf(x.tier) - TIERS.indexOf(y.tier) || x.version - y.version),
      budgets: budgets.rows,
      // Where each request's amounts came from, in the CSV's words (a request stored before real suppliers reads as
      // demo). price_source replaces the stored source code, so the export carries no "source" key: in a download
      // that key is kept for a policy cap's rule (the honesty test's markup check).
      requests: requests.rows.map(r => exportedRequest(r)),
      audit: audit.rows,
      truncated: Object.fromEntries(Object.entries({ members, departments, policies, versions, budgets, requests, audit })
        .filter(([, r]) => r.truncated).map(([k]) => [k, true])),
    };
    const counts = `${data.members.length} members, ${data.requests.length} requests`;
    await this.repo.commit({
      checks: [actorCheck(a, { server: false })],
      inserts: [auditInsert(this.repo, {
        orgId, actor: who(a), action: 'org.exported', target: { kind: KINDS.org, id: orgId },
        summary: `${who(a).name} downloaded the company data (${counts})`,
      })],
    });
    return { filename: `tripelyx-company-${orgId}.json`, json: JSON.stringify(data, null, 2) };
  },

  /**
   * The activity log (audit.view), newest first, 50 per page (Repo.page), optionally one group.
   * An unknown group shows every group.
   * @param {import('./types').MemberActor} actor
   * @param {{ group?: string|null, cursor?: string|null }} [opts] group: one of constants.AUDIT_GROUPS
   * @returns {Promise<import('./types').Page<import('./types').AuditEntry>>}
   * @throws {AppError} 404 for a foreign or damaged cursor
   */
  async listAudit(actor, opts) {
    const a = await loadActor(this.repo, actor);
    need(a, 'audit.view');
    const orgId = a.org.id;
    const o = opts && typeof opts === 'object' ? opts : {};
    const group = AUDIT_GROUPS.includes(o.group) ? o.group : null;
    let cursor = o.cursor ?? null;
    const mine = e => e && e.orgId === orgId;
    if (!group) {
      const page = await this.repo.page(KINDS.audit, orgId, { limit: PAGE_SIZE, cursor });
      return { rows: page.rows.filter(mine), cursor: page.cursor };
    }
    // One group: read store pages no larger than what is still missing, so every row read either goes on
    // this page or is skipped, and the cursor (after the last row read) loses nothing. A rare group stops
    // after FILTER_PAGES reads and offers "Show older" with the rows found so far.
    const rows = [];
    for (let reads = 0; reads < FILTER_PAGES && rows.length < PAGE_SIZE; reads += 1) {
      const page = await this.repo.page(KINDS.audit, orgId, { limit: PAGE_SIZE - rows.length, cursor });
      rows.push(...page.rows.filter(e => mine(e) && e.group === group));
      cursor = page.cursor;
      if (!cursor) break;
    }
    return { rows, cursor };
  },

  /**
   * Every company for the platform admin page (/admin/business): repo.listOrgs plus each creator's email and
   * the similar-name hint; company enquiries from repo.listBusinessLeads. Never requests, policies, budgets,
   * member lists or audit contents.
   * @param {import('./types').UserActor} actor actor.user.isAdmin must be true, and accounts.isPlatformAdmin(actor.user) is asked again
   * @returns {Promise<import('./types').PlatformView>}
   * @throws {AppError} 404 'not_found' for anyone who is not a platform admin
   */
  async platformListOrgs(actor) {
    await platformUser.call(this, actor);
    const orgs = await this.repo.listOrgs();
    const byKey = new Map();
    for (const o of orgs) {
      const k = o.nameKey || nameKeyOf(o.name || '');
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(o);
    }
    const rows = [];
    for (const o of orgs) {
      const creator = isUserId(o.createdBy) ? await this.repo.getIn(KINDS.member, memberId(o.id, o.createdBy), o.id) : null;
      const k = o.nameKey || nameKeyOf(o.name || '');
      rows.push({
        id: o.id, name: o.name, status: o.status, size: o.size, at: o.at, creatorEmail: creator ? creator.email : '',
        memberCount: o.memberCount || 0, timezone: o.timezone, similarNames: k ? byKey.get(k).filter(x => x.id !== o.id).map(x => x.name) : [],
        statusNote: typeof o.statusNote === 'string' && o.statusNote ? o.statusNote : null, statusAt: o.statusAt || null,
        previousName: typeof o.previousName === 'string' && o.previousName ? o.previousName : null,
        house: o.house === true,
        rev: o.rev ?? 0,
      });
    }
    // Stable: pending first, then active, then suspended; each newest first (listOrgs order).
    rows.sort((x, y) => (STATUS_ORDER[x.status] ?? 3) - (STATUS_ORDER[y.status] ?? 3));
    const house = await houseOf(this.repo);
    return {
      orgs: rows,
      leads: await this.repo.listBusinessLeads({ limit: 200 }),
      house: house ? { id: house.id, name: house.name, status: house.status } : null,
    };
  },

  /**
   * Confirm, suspend or reactivate a company (platform admin). pending → active ('org.confirmed'), active →
   * suspended ('org.suspended', note required), suspended → active ('org.reactivated', or 'org.confirmed'
   * when it was paused before Tripelyx ever confirmed it). One commit: org CAS (form rev; statusBy, statusAt,
   * statusNote), the company's audit entry with actor { platformAdmin: user id, name: 'Tripelyx' } (the
   * company never sees the staff member's name or note). A pending company may also be suspended (a company
   * Tripelyx will not confirm); asking for the status a company already has changes nothing.
   * @param {import('./types').UserActor} actor actor.user.isAdmin must be true, and accounts.isPlatformAdmin(actor.user) is asked again
   * @param {string} orgId
   * @param {{ status: 'active'|'suspended', note?: string, rev: string|number }} form
   * @returns {Promise<import('./types').Org>}
   * @throws {AppError} 404 (not an admin, unknown company); 422 'invalid_status' (details.status, details.note);
   *   409 'conflict'
   */
  async platformSetStatus(actor, orgId, form) {
    const user = await platformUser.call(this, actor);
    if (typeof orgId !== 'string' || !ORG_ID_RE.test(orgId)) throw notFound();
    const org = await this.repo.getIn(KINDS.org, orgId, orgId);
    if (!org) throw notFound();
    const f0 = form && typeof form === 'object' ? form : {};
    const f = v.collect('invalid_status', {
      status: () => v.oneOf(f0.status, ['active', 'suspended']),
      note: () => v.text(f0.note, 300, { multiline: true }),
    });
    if (f.status === 'suspended' && !f.note) throw invalid('invalid_status', { note: 'Write a short note on why this company is paused.' });
    if (!sameRev(f0.rev, org)) throw conflict();
    if (org.status === f.status) return org;
    const confirming = org.status === 'pending' || (org.status === 'suspended' && await pausedWhilePending(this.repo, org.id));
    const action = f.status === 'suspended' ? 'org.suspended' : confirming ? 'org.confirmed' : 'org.reactivated';
    const verb = { 'org.confirmed': 'confirmed', 'org.suspended': 'paused', 'org.reactivated': 'reactivated' }[action];
    const at = this.repo.iso();
    const docs = await this.repo.commit({
      cas: [{
        kind: KINDS.org, id: org.id, rev: org.rev ?? 0,
        fn: d => { d.status = f.status; d.statusBy = user.id; d.statusAt = at; d.statusNote = f.note || null; d.updatedAt = at; },
      }],
      inserts: [auditInsert(this.repo, {
        orgId: org.id, actor: { platformAdmin: user.id, name: PLATFORM_NAME }, action, target: { kind: KINDS.org, id: org.id },
        summary: `Tripelyx ${verb} ${org.name}`, changes: [{ path: 'status', before: org.status, after: f.status }],
      })],
    });
    return docs[`${KINDS.org}:${org.id}`];
  },

  /**
   * Make Tripelyx's own company (go-live design §3.8; "Create Tripelyx Inc" on /admin/business). Asks
   * accounts.isPlatformAdmin again, then makes it through createCompany's own commit (makeCompany) with the
   * house flag only this method passes: the name HOUSE_COMPANY_NAME (never typed; the one name public sign-up
   * and every rename refuse), the signed-in platform admin as its Owner, status 'active', house: true, no size
   * (Tripelyx has given none) and the default time zone. The biz_house record goes in the same commit and its
   * id is fixed, so there is only ever one: a second press, or two at once, makes nothing and answers the
   * one already there. Audit 'org.house_created' under the name "Tripelyx".
   * @param {import('./types').UserActor} actor actor.user.isAdmin must be true, and accounts.isPlatformAdmin(actor.user) is asked again
   * @returns {Promise<{ org: import('./types').Org, created: boolean }>} created false when it already existed
   * @throws {AppError} 404 'not_found' for anyone who is not a platform admin; 422 'too_many_companies' when the
   *   admin is already in config.business.maxOrgsPerUser companies
   */
  async platformCreateHouseCompany(actor) {
    const user = await platformUser.call(this, actor);
    const f = { name: companyName(HOUSE_COMPANY_NAME, { house: true }), size: null, timezone: DEFAULT_TIMEZONE };
    return this.repo.withRetry(async () => {
      // Read again on every try: a racing press that won is found here, and this one makes nothing.
      const existing = await houseOf(this.repo);
      if (existing) return { org: existing, created: false };
      const { org } = await makeCompany.call(this, user, f, { house: true });
      return { org, created: true };
    }, { tries: 5 });
  },
};

/**
 * The invite behind a token if it can still be used, with its company, pointer and inviter. Malformed,
 * unknown, used, revoked, replaced (the pointer names another invite) or expired → 410; a missing company
 * → 410; a suspended company → 403; an inviter who is no longer an active member able to grant the
 * invite's role (removed, demoted, or never a member) → 410. Not a service method (service.js carries only
 * SERVICE_METHODS), so the methods call it as usableInvite.call(this, token).
 * @this {{ repo: import('./repo').Repo }} the service
 */
async function usableInvite(token) {
  if (!isToken(token)) throw inviteGone();
  const hash = hashToken(token);
  const inv = await this.repo.get(KINDS.invite, hash);
  if (!inv || !sameHash(inv.tokenHash, hash) || !usable(inv, this.repo.iso())) throw inviteGone();
  if (typeof inv.orgId !== 'string' || !ORG_ID_RE.test(inv.orgId)) throw inviteGone();
  const pointer = await this.repo.getIn(KINDS.inviteEmail, pointerId(inv.orgId, inv.email), inv.orgId);
  if (!pointer || pointer.inviteHash !== hash) throw inviteGone();
  const org = await this.repo.getIn(KINDS.org, inv.orgId, inv.orgId);
  if (!org) throw inviteGone();
  if (org.status === 'suspended') throw suspended();
  const inviter = isUserId(inv.invitedBy) ? await this.repo.getIn(KINDS.member, memberId(org.id, inv.invitedBy), org.id) : null;
  if (!inviter || inviter.userId !== inv.invitedBy || !canGrant(inviter, inv.role)) throw inviteGone();
  return { hash, inv, org, pointer, inviter };
}

/**
 * May this removed member come back through `inv`? Only through an invite made at or after their removal
 * (D3). "At" counts: while they were active no invite for their email could be made (already_member), and
 * removal revoked any pending one, so an invite with the same timestamp was made after the removal.
 */
function rejoinable(existing, inv) {
  return typeof existing.removedAt === 'string' && typeof inv.at === 'string' && inv.at >= existing.removedAt;
}

/**
 * A department choice: blank → none; the member's current one stays even if archived since; otherwise an
 * active department of this company.
 */
function pickDepartment(value, depById, current) {
  if (blank(value)) return null;
  const s = String(value);
  if (s === current) return s;
  const dep = depById.get(s);
  if (!dep || dep.archivedAt) throw fieldError("Choose one of your company's departments.");
  return s;
}

/** A manager or approver choice: blank → none; never the member themself; the current one stays; otherwise an active member. */
function pickMember(value, activeById, { self, current }) {
  if (blank(value)) return null;
  const s = String(value);
  if (self && s === self) throw fieldError('Choose someone else.');
  if (current && s === current) return s;
  if (!activeById.has(s)) throw fieldError('Choose someone on your team.');
  return s;
}

/** Approval expiry in whole hours, 4 to 168. */
function approvalHours(x) {
  const [min, max] = APPROVAL_HOURS_RANGE;
  const s = String(x ?? '').trim();
  if (!/^\d{1,3}$/.test(s) || Number(s) < min || Number(s) > max) throw fieldError(`Enter a number of hours from ${min} to ${max}.`);
  return Number(s);
}

/** "department", "department and manager", "department, manager and tier". */
function listWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

module.exports = { methods, COMPANY_FORM };
