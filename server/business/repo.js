// The only module that touches biz_* records in the store (plan §D). Everything above it (the service,
// routes, views) goes through a Repo, which enforces the storage rules:
// - every list is scoped: a falsy owner would list every tenant (MemoryStore.listRecords), so
//   assertScope refuses anything that is not an org, proposal or user id;
// - getRecord has no owner check, so tenant reads go through getIn(kind, id, orgId);
// - mutable records change only by compare-and-set on `rev` (cas); a loser gets 409;
// - times are ISO strings from the injected clock; the store's own createdAt is never read;
// - documents are plain JSON (no top-level arrays, undefined, NaN, Infinity, Date or functions), so the
//   memory store and Postgres hold the same thing;
// - lists sort in JS by data.at / data.updatedAt, never by key order or store order.
const { AppError } = require('../lib/errors');
const { KINDS, LIST_LIMIT } = require('./constants');

/** An owner scope: org_, prp_ or usr_ followed by 16 base64url characters (what lib/ids.id() makes). */
const SCOPE_RE = /^(org|prp|usr)_[A-Za-z0-9_-]{16}$/;
/** A user id exactly as accounts.register makes it: id('usr'). */
const USER_ID_RE = /^usr_[A-Za-z0-9_-]{16}$/;

/** True for a string that can name a stored record (callers pass URL params straight in). */
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
/** Ids written by Business: composite ids join parts with '.', never ':'. */
const checkNewId = id => { if (!validId(id) || id.includes(':')) throw new Error('[business] bad record id'); };

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
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.getPrototypeOf(doc) !== Object.prototype) {
    throw new Error('[business] a record must be a plain object');
  }
  checkDoc(doc, 'data');
}

const sortKey = (d, by) => String((by === 'updatedAt' ? (d.updatedAt || d.at) : (d.at || d.updatedAt)) || '');

class Repo {
  /**
   * @param {{ store: object, now: () => Date }} deps the app's store and injected clock
   */
  constructor({ store, now }) {
    if (!store || typeof now !== 'function') throw new Error('[business] Repo needs { store, now }');
    this.store = store;
    this.clock = now;
  }

  /** The injected clock's current time. @returns {Date} */
  now() { return this.clock(); }

  /** The injected clock's current time as an ISO string (every `at` / `updatedAt`). @returns {string} */
  iso() { return this.clock().toISOString(); }

  /**
   * Throws unless `id` is an org, proposal or user id (the owner slots of biz_* records).
   * A falsy scope would list every tenant, so '', null and undefined throw too.
   * @param {unknown} id
   * @returns {string} the id
   */
  assertScope(id) {
    if (typeof id !== 'string' || !(SCOPE_RE.test(id) || USER_ID_RE.test(id))) throw new Error('[business] refusing an unscoped or malformed owner id');
    return id;
  }

  /**
   * A record by kind and id, with no tenant check. Use getIn for anything an org member asked for.
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
   * Capped at `limit` (default 1000) records, taken newest-created first.
   * @param {string} kind
   * @param {string} scope org, proposal or user id (assertScope)
   * @param {{ limit?: number, by?: 'at'|'updatedAt' }} [opts]
   * @returns {Promise<object[]>}
   */
  async list(kind, scope, { limit = LIST_LIMIT, by = 'at' } = {}) {
    this.assertScope(scope);
    const rows = await this.store.listRecords(kind, { userId: scope, limit });
    return rows.sort((a, b) => {
      const x = sortKey(a, by), y = sortKey(b, by);
      return x < y ? 1 : x > y ? -1 : 0;
    });
  }

  /**
   * Insert-only write. False when the id is already taken (the stored record is untouched).
   * @param {string} kind
   * @param {string} id
   * @param {object} data plain JSON document
   * @param {{ owner?: string|null }} [opts] owner scope (org, proposal or user id); null only for biz_org
   * @returns {Promise<boolean>}
   */
  async insert(kind, id, data, { owner = null } = {}) {
    checkNewId(id);
    if (owner !== null) this.assertScope(owner);
    assertDoc(data);
    return this.store.insertRecord(kind, id, data, { userId: owner });
  }

  /**
   * Compare-and-set. Re-reads the record, checks its rev, applies `fn` to a copy and writes it only if
   * nobody wrote in between; the stored rev becomes rev + 1.
   * - `rev` is the rev the caller saw (a form's hidden field: an integer or digit string). Pass null to
   *   use the rev just read (for server-side updates with no form; still safe against lost updates).
   * - `fn(current)` returns the next document, or changes `current` in place and returns nothing. It may
   *   be async and may throw to abort.
   * Throws AppError 404 when the record is gone and AppError('conflict', …, 409) when the rev moved on.
   * @param {string} kind
   * @param {string} id
   * @param {number|string|null} rev
   * @param {(current: object) => object|void|Promise<object|void>} fn
   * @returns {Promise<object>} the written document (with its new rev)
   */
  async cas(kind, id, rev, fn) {
    const cur = await this.get(kind, id);
    if (!cur) throw new AppError('not_found', 'Not found.', 404);
    const seen = rev === null || rev === undefined ? (cur.rev ?? 0)
      : (typeof rev === 'number' ? rev : /^\d{1,9}$/.test(String(rev)) ? Number(rev) : NaN);
    if (!Number.isInteger(seen) || seen !== (cur.rev ?? 0)) throw conflict();
    const draft = structuredClone(cur);
    const next = (await fn(draft)) ?? draft;
    const { rev: _drop, ...doc } = next; // eslint-disable-line no-unused-vars
    assertDoc(doc);
    const written = await this.store.updateRecord(kind, id, seen, doc);
    if (!written) throw conflict();
    return written;
  }

  /**
   * Unconditional write (biz_logo and biz_reminder only; everything else is insert or cas).
   * @param {string} kind
   * @param {string} id
   * @param {object} data
   * @param {{ owner?: string|null }} [opts]
   * @returns {Promise<object>}
   */
  async put(kind, id, data, { owner = null } = {}) {
    checkNewId(id);
    if (owner !== null) this.assertScope(owner);
    assertDoc(data);
    return this.store.putRecord(kind, id, data, { userId: owner });
  }

  /**
   * Delete a record. @returns {Promise<boolean>} whether one was removed
   * @param {string} kind
   * @param {string} id
   */
  async del(kind, id) {
    if (!validId(id)) return false;
    return this.store.deleteRecord(kind, id);
  }
}

/** The 409 every lost compare-and-set answers with. */
function conflict() {
  return new AppError('conflict', 'Someone else just changed this. Reload to see their change.', 409);
}

module.exports = { Repo, SCOPE_RE, USER_ID_RE, assertDoc, conflict };
