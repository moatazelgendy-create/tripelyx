// The only module that touches biz_* records in the store (plan §C2, §C8). Everything above it (the
// service modules, routes, views) goes through a Repo, which enforces the storage rules:
// - every list is scoped: a falsy owner would list every tenant, so assertScope refuses anything that is
//   not an org, user or member scope id, and listRecordsPage itself throws on a falsy owner;
// - getRecord has no owner check, so tenant reads go through getIn(kind, id, orgId);
// - there is no unconditional write: records are inserted once, then changed only by compare-and-set on
//   `rev` (cas, or commit for several records at once, all or nothing); a loser gets 409;
// - a change and its audit entry go in the same commit (D7);
// - times are ISO strings from the injected clock; the store's own createdAt is never read, and cursors
//   follow store order only;
// - documents are plain JSON (no top-level arrays, undefined, NaN, Infinity, Date or functions), so the
//   memory store and Postgres hold the same thing.
const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
const { KINDS, LIST_LIMIT } = require('./constants');

/** An owner scope: org_, usr_ or mbr_ followed by 16 base64url characters (lib/ids.id() or memberScope()). */
const SCOPE_RE = /^(org|usr|mbr)_[A-Za-z0-9_-]{16}$/;
/** A user id exactly as accounts.register makes it: id('usr'). */
const USER_ID_RE = /^usr_[A-Za-z0-9_-]{16}$/;
/** A company id exactly as lib/ids.id('org') makes it. */
const ORG_ID_RE = /^org_[A-Za-z0-9_-]{16}$/;

/** Fields that tie a record to its tenant and parent; a cas fn never lets them change or disappear. */
const IDENTITY_KEYS = Object.freeze(['id', 'orgId', 'userId', 'travelerId', 'requestId']);

/** list() is only for scopes that are small by construction; it warns when it reaches this. */
const BOUNDED_LIST = 200;
/** The most rows one page() returns. */
const PAGE_MAX = 200;

/** Kinds that are written once and never changed or deleted (§C3). */
const INSERT_ONLY = Object.freeze([KINDS.audit, KINDS.reqLink, KINDS.policyVersion]);
/** Kinds that are never deleted: a removed member keeps a record with status 'removed' (§C3). */
const NEVER_DELETED = Object.freeze([...INSERT_ONLY, KINDS.member, KINDS.org]);

/** True for a string that can name a stored record (callers pass URL params straight in). */
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
/** Ids written by Business: composite ids join parts with '.', never ':'. */
const checkNewId = id => { if (!validId(id) || id.includes(':')) throw new Error('[business] bad record id'); };
const checkKind = kind => { if (typeof kind !== 'string' || !/^biz_[a-z_]+$/.test(kind)) throw new Error('[business] bad record kind'); };

/** A plain object: not null, not an array, not a class instance or Date. */
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function checkDoc(v, path) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`[business] ${path} is not a finite number`); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => checkDoc(x, `${path}[${i}]`)); return; }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const [k, x] of Object.entries(v)) checkDoc(x, `${path}.${k}`);
    return;
  }
  throw new Error(`[business] ${path} is not plain JSON (${v === undefined ? 'undefined' : Object.prototype.toString.call(v)})`);
}

/**
 * Throws unless `doc` is a plain object of JSON values (no undefined, NaN, Infinity, Date, class
 * instances or functions anywhere; not an array at the top).
 * @param {unknown} doc
 */
function assertDoc(doc) {
  if (!isPlainObject(doc)) {
    throw new Error('[business] a record must be a plain object');
  }
  checkDoc(doc, 'data');
}

/**
 * The owner scope of one member's link records (biz_req_link): 'mbr_' + the first 16 characters of
 * base64url(sha256(orgId + '|' + userId)). Deterministic, so "my approver links in this company" is one
 * scoped page, and it never equals a scope in another company.
 * @param {string} orgId
 * @param {string} userId
 * @returns {string}
 */
function memberScope(orgId, userId) {
  if (typeof orgId !== 'string' || !ORG_ID_RE.test(orgId) || typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    throw new Error('[business] memberScope needs an org id and a user id');
  }
  return `mbr_${crypto.createHash('sha256').update(`${orgId}|${userId}`).digest('base64url').slice(0, 16)}`;
}

/**
 * The 409 every lost compare-and-set answers with.
 * @param {{ retryable?: boolean }} [opts] retryable: the rev was read by the server (rev null or server:true),
 *   so withRetry may re-run the whole read-decide-commit; a rev from a form never retries
 * @returns {AppError}
 */
function conflict({ retryable = false } = {}) {
  const e = new AppError('conflict', 'Someone else just changed this. Reload to see their change.', 409);
  e.retryable = retryable === true;
  return e;
}

/** The 409 for an insert whose id is already taken. */
function alreadyExists() {
  return new AppError('already_exists', 'This already exists.', 409);
}

const notFound = () => new AppError('not_found', 'Not found.', 404);

/** A form's rev (an integer or a digit string) as a number, or NaN. */
function parseRev(rev) {
  if (typeof rev === 'number') return Number.isInteger(rev) && rev >= 0 ? rev : NaN;
  return /^\d{1,9}$/.test(String(rev)) ? Number(rev) : NaN;
}

class Repo {
  /**
   * @param {{ store: object, now: () => Date, log?: { warn: Function } }} deps the app's store, injected clock and logger
   */
  constructor({ store, now, log = null }) {
    if (!store || typeof now !== 'function') throw new Error('[business] Repo needs { store, now }');
    this.store = store;
    this.clock = now;
    this.log = log;
  }

  /** The injected clock's current time. @returns {Date} */
  now() { return this.clock(); }

  /** The injected clock's current time as an ISO string (every `at` / `updatedAt`). @returns {string} */
  iso() { return this.clock().toISOString(); }

  /**
   * Throws unless `id` is an org, user or member scope id (the owner slots of biz_* records).
   * A falsy scope would list every tenant, so '', null and undefined throw too.
   * @param {unknown} id
   * @returns {string} the id
   */
  assertScope(id) {
    if (typeof id !== 'string' || !SCOPE_RE.test(id)) throw new Error('[business] refusing an unscoped or malformed owner id');
    return id;
  }

  /**
   * A record by kind and id, with no tenant check. Only token lookups and getOrg use this; everything an
   * org member asked for goes through getIn.
   * @param {string} kind
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async get(kind, id) {
    if (!validId(id)) return null;
    return this.store.getRecord(kind, id);
  }

  /**
   * A record only if it belongs to the org (`data.orgId === orgId`; for biz_org, `data.id === orgId`).
   * Cross-tenant ids come back as null, so the caller answers 404.
   * @param {string} kind
   * @param {string} id
   * @param {string} orgId
   * @returns {Promise<object|null>}
   */
  async getIn(kind, id, orgId) {
    if (!validId(orgId)) return null;
    const d = await this.get(kind, id);
    if (!d) return null;
    const owner = kind === KINDS.org ? d.id : d.orgId;
    return owner === orgId ? d : null;
  }

  /**
   * Records of a kind under one owner, newest first by `data.at` (or `data.updatedAt` with by:'updatedAt').
   * Only for scopes that are small by construction (at most 200 records: a company's departments, its
   * three policies, one user's company index). It logs a warning when it reaches the limit, since rows
   * past it are silently missing; anything that can grow uses page().
   * @param {string} kind
   * @param {string} scope org, user or member scope id (assertScope)
   * @param {{ limit?: number, by?: 'at'|'updatedAt' }} [opts] limit 1 to 200
   * @returns {Promise<object[]>}
   */
  async list(kind, scope, { limit = BOUNDED_LIST, by = 'at' } = {}) {
    this.assertScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > BOUNDED_LIST) throw new RangeError(`[business] list limit must be 1 to ${BOUNDED_LIST}; use page()`);
    const rows = await this.store.listRecords(kind, { userId: scope, limit });
    if (rows.length >= limit && this.log && typeof this.log.warn === 'function') {
      this.log.warn(`[business] Repo.list(${kind}) reached its limit of ${limit}; older records are missing. Use page().`);
    }
    const sortKey = d => String((by === 'updatedAt' ? (d.updatedAt || d.at) : (d.at || d.updatedAt)) || '');
    return rows.sort((a, b) => {
      const x = sortKey(a), y = sortKey(b);
      return x < y ? 1 : x > y ? -1 : 0;
    });
  }

  /**
   * One page of an owner's records, newest stored first (store order, not data.at). The cursor is opaque
   * and tied to this kind and scope: a cursor from another company's list, or a damaged one, answers 404.
   * @param {string} kind
   * @param {string} scope org, user or member scope id
   * @param {{ limit?: number, cursor?: string|null }} [opts] limit 1 to 200 (default 50)
   * @returns {Promise<{ rows: object[], cursor: string|null }>} cursor is null on the last page
   */
  async page(kind, scope, { limit = 50, cursor = null } = {}) {
    this.assertScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new RangeError(`[business] page limit must be 1 to ${PAGE_MAX}`);
    const tag = crypto.createHash('sha256').update(`${kind}|${scope}`).digest('base64url').slice(0, 10);
    let inner = null;
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      const s = String(cursor);
      const dot = s.indexOf('.');
      if (dot !== tag.length || s.slice(0, dot) !== tag || s.length > 600) throw notFound();
      inner = s.slice(dot + 1);
    }
    let res;
    try {
      res = await this.store.listRecordsPage(kind, { userId: scope, limit, cursor: inner });
    } catch (e) {
      if (e instanceof AppError && e.code === 'bad_cursor') throw notFound();
      throw e;
    }
    return { rows: res.rows, cursor: res.cursor ? `${tag}.${res.cursor}` : null };
  }

  /**
   * Every company, newest stored first: the one deliberate unscoped list, of biz_org only (biz_org has no
   * owner scope). For the platform admin page; the caller checks isAdmin first. Logs a warning when it
   * reaches the limit.
   * @param {{ limit?: number }} [opts] 1 to 1,000 (constants.LIST_LIMIT)
   * @returns {Promise<object[]>} biz_org records
   */
  async listOrgs({ limit = LIST_LIMIT } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT) throw new RangeError(`[business] listOrgs limit must be 1 to ${LIST_LIMIT}`);
    const rows = (await this.store.listRecords(KINDS.org, { limit })).filter(o => o && typeof o.id === 'string' && ORG_ID_RE.test(o.id));
    if (rows.length >= limit && this.log && typeof this.log.warn === 'function') {
      this.log.warn(`[business] Repo.listOrgs reached its limit of ${limit}; older companies are missing.`);
    }
    return rows;
  }

  /**
   * Company enquiries from the /business form: the newest partner leads (store.listPartnerLeads, at most
   * `limit`) whose kind is exactly 'business' (validatePartnerLead keeps kind only for that value).
   * For the platform admin page; the caller checks isAdmin first.
   * @param {{ limit?: number }} [opts] 1 to 200
   * @returns {Promise<object[]>}
   */
  async listBusinessLeads({ limit = 200 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('[business] listBusinessLeads limit must be 1 to 200');
    return (await this.store.listPartnerLeads({ limit })).filter(l => l && l.kind === 'business');
  }

  /**
   * Insert-only write. False when the id is already taken (the stored record is untouched).
   * @param {string} kind
   * @param {string} id
   * @param {object} data plain JSON document
   * @param {{ owner?: string|null }} [opts] owner scope (org, user or member scope id); null only for biz_org
   * @returns {Promise<boolean>}
   */
  async insert(kind, id, data, { owner = null } = {}) {
    const op = this._insertOp({ kind, id, data, owner });
    return this.store.insertRecord(op.kind, op.id, op.data, { userId: op.userId });
  }

  /**
   * Compare-and-set on one record. Re-reads it, checks its rev, applies `fn` to a copy and writes it only
   * if nobody wrote in between; the stored rev becomes rev + 1.
   * - `rev` is the rev the caller saw (a form's hidden field: an integer or digit string). Pass null to
   *   use the rev just read (server-side updates with no form; still safe against lost updates, and a
   *   conflict is then retryable by withRetry).
   * - `fn(current)` returns the next document (a plain object), or changes `current` in place and returns
   *   nothing (`d => { d.x = 1; }`, with braces). Any other return value throws, and so does a next
   *   document whose id, orgId, userId, travelerId or requestId differs from the stored one, so a slip
   *   such as `d => d.x = 1` can never overwrite or re-home a record. It may be async and may throw to abort.
   * Throws AppError 404 when the record is gone and AppError('conflict', …, 409) when the rev moved on.
   * @param {string} kind
   * @param {string} id
   * @param {number|string|null} rev
   * @param {(current: object) => object|void|Promise<object|void>} fn
   * @returns {Promise<object>} the written document (with its new rev)
   */
  async cas(kind, id, rev, fn) {
    const u = await this._casOp({ kind, id, rev, fn });
    const written = await this.store.updateRecord(kind, id, u.expectedRev, u.next);
    if (!written) throw conflict({ retryable: u.retryable });
    return written;
  }

  /**
   * Several writes as one atomic commit (store.commit): all of them happen, or none.
   * - cas:     [{ kind, id, rev, fn, server? }] as cas() (rev null = the rev just read);
   * - checks:  [{ kind, id, rev, server? }] the record must still be at `rev` when the commit lands
   *            (rev null = the rev read now); nothing is written to it;
   * - inserts: [{ kind, id, data, owner }] as insert(), but a taken id fails the whole commit;
   * - deletes: [{ kind, id, rev, server? }] compare-and-set delete (never members, orgs or insert-only kinds).
   * `server: true` marks an explicit rev the server read itself (not a form value), so its conflict is
   * retryable like rev null.
   * Throws 404 when a cas, check or delete target is gone at read time, AppError('conflict', …, 409) when a
   * rev moved on (retryable as above), and AppError('already_exists', …, 409) when an insert's id is taken.
   * @param {{ cas?: object[], checks?: object[], inserts?: object[], deletes?: object[] }} spec
   * @returns {Promise<Record<string, object>>} every written document under 'kind:id'
   */
  async commit({ cas = [], checks = [], inserts = [], deletes = [], ...rest } = {}) {
    if (Object.keys(rest).length) throw new Error(`[business] commit takes cas, checks, inserts and deletes (got ${Object.keys(rest).join(', ')})`);
    for (const [name, list] of Object.entries({ cas, checks, inserts, deletes })) {
      if (!Array.isArray(list)) throw new Error(`[business] commit ${name} must be an array`);
    }
    const retryable = new Set();
    const updates = [];
    for (const c of cas) {
      const u = await this._casOp(c);
      if (u.retryable) retryable.add(`${u.kind}:${u.id}`);
      updates.push({ kind: u.kind, id: u.id, expectedRev: u.expectedRev, next: u.next });
    }
    const storeChecks = [];
    for (const c of checks) {
      const r = await this._revOp(c, 'check');
      if (r.retryable) retryable.add(`${r.kind}:${r.id}`);
      storeChecks.push({ kind: r.kind, id: r.id, rev: r.rev });
    }
    const storeDeletes = [];
    for (const d of deletes) {
      if (NEVER_DELETED.includes(d && d.kind)) throw new Error(`[business] ${d.kind} records are never deleted`);
      const r = await this._revOp(d, 'delete');
      if (r.retryable) retryable.add(`${r.kind}:${r.id}`);
      storeDeletes.push({ kind: r.kind, id: r.id, expectedRev: r.rev });
    }
    const storeInserts = inserts.map(i => this._insertOp(i));
    const res = await this.store.commit({ checks: storeChecks, updates, inserts: storeInserts, deletes: storeDeletes });
    if (res.ok) return res.docs;
    if (res.reason === 'duplicate') throw alreadyExists();
    throw conflict({ retryable: retryable.has(`${res.kind}:${res.id}`) });
  }

  /**
   * Run a whole read-decide-commit again when it lost a race on a rev the server read itself (rev null or
   * server:true). Conflicts on a form's rev, duplicates and every other error pass straight through, and
   * the last conflict is thrown after `tries` attempts.
   * @template T
   * @param {(attempt: number) => Promise<T>} fn
   * @param {{ tries?: number }} [opts]
   * @returns {Promise<T>}
   */
  async withRetry(fn, { tries = 3 } = {}) {
    if (!Number.isInteger(tries) || tries < 1 || tries > 10) throw new RangeError('[business] withRetry tries must be 1 to 10');
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn(attempt);
      } catch (e) {
        const again = e instanceof AppError && e.code === 'conflict' && e.retryable === true && attempt < tries;
        if (!again) throw e;
      }
    }
  }

  /**
   * Delete a record outright, with no rev check. Business flows never call it (they delete through
   * commit, with a rev); it stays for tests and tooling. Members, orgs and insert-only kinds refuse.
   * @param {string} kind
   * @param {string} id
   * @returns {Promise<boolean>} whether one was removed
   */
  async del(kind, id) {
    if (NEVER_DELETED.includes(kind)) throw new Error(`[business] ${kind} records are never deleted`);
    if (!validId(id)) return false;
    return this.store.deleteRecord(kind, id);
  }

  // -------------------------------------------------------------------------------------------------

  /** Validate an insert and return the store's insert entry. */
  _insertOp({ kind, id, data, owner = null } = {}) {
    checkKind(kind);
    checkNewId(id);
    if (owner !== null || kind !== KINDS.org) this.assertScope(owner);
    assertDoc(data);
    return { kind, id, data, userId: owner };
  }

  /** Read the target of a cas, apply fn to a copy and return the store's update entry. */
  async _casOp({ kind, id, rev, fn, server = false } = {}) {
    checkKind(kind);
    if (INSERT_ONLY.includes(kind)) throw new Error(`[business] ${kind} records are insert-only`);
    if (typeof fn !== 'function') throw new Error('[business] cas needs a fn');
    const cur = await this.get(kind, id);
    if (!cur) throw notFound();
    const fromServer = rev === null || rev === undefined;
    const seen = fromServer ? (cur.rev ?? 0) : parseRev(rev);
    const retryable = fromServer || server === true;
    if (!Number.isInteger(seen) || seen !== (cur.rev ?? 0)) throw conflict({ retryable });
    const draft = structuredClone(cur);
    const returned = await fn(draft);
    // `d => d.status = 'active'` returns 'active': it may not replace the record. A returned value must be
    // a plain object that keeps the record's identity.
    if (returned !== undefined && !isPlainObject(returned)) throw new Error('[business] cas fn must return a plain object or nothing');
    const next = returned ?? draft;
    for (const k of IDENTITY_KEYS) {
      if (Object.hasOwn(cur, k) && next[k] !== cur[k]) throw new Error(`[business] cas fn may not change or drop ${k}`);
    }
    const { rev: _drop, ...doc } = next; // eslint-disable-line no-unused-vars
    assertDoc(doc);
    return { kind, id, expectedRev: seen, next: doc, retryable };
  }

  /** A check or delete entry: an explicit rev, or (rev null) the rev read now. */
  async _revOp({ kind, id, rev, server = false } = {}, what) {
    checkKind(kind);
    if (what === 'delete' && INSERT_ONLY.includes(kind)) throw new Error(`[business] ${kind} records are insert-only`);
    if (!validId(id)) throw notFound();
    if (rev === null || rev === undefined) {
      const cur = await this.get(kind, id);
      if (!cur) throw notFound();
      return { kind, id, rev: cur.rev ?? 0, retryable: true };
    }
    const n = parseRev(rev);
    if (!Number.isInteger(n)) throw conflict({ retryable: false });
    return { kind, id, rev: n, retryable: server === true };
  }
}

module.exports = {
  Repo, SCOPE_RE, USER_ID_RE, ORG_ID_RE, IDENTITY_KEYS, INSERT_ONLY, NEVER_DELETED, BOUNDED_LIST, PAGE_MAX,
  assertDoc, memberScope, conflict, alreadyExists,
};
