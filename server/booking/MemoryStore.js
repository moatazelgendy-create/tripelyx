// In-memory store for local development and tests. Same interface as PostgresStore; data is lost on
// restart. config.js only allows it when APP_ENV=development and no DATABASE_URL is set.
const { AppError } = require('../lib/errors');

const clone = v => (v === undefined ? undefined : structuredClone(v));
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** True for a string both stores hold alike: Postgres text and JSONB cannot hold NUL or an unpaired surrogate. */
const storable = s => typeof s === 'string' && !s.includes('\u0000') && s.isWellFormed();

/**
 * The first reason `v` is not a JSON value both stores keep exactly as given, or null. JSON.stringify (the
 * Postgres path) would silently drop undefined and functions and turn NaN into null, while structuredClone
 * (the memory path) keeps some of them and throws on others, so anything but plain JSON is refused.
 * @param {unknown} v
 * @param {string} path where `v` sits, for the message
 * @returns {string|null}
 */
function jsonProblem(v, path) {
  if (v === null || typeof v === 'boolean') return null;
  if (typeof v === 'string') return storable(v) ? null : `${path} holds a NUL or unpaired surrogate character`;
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${path} is not a finite number`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const p = jsonProblem(v[i], `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      if (!storable(k)) return `${path} has a key with a NUL or unpaired surrogate character`;
      const p = jsonProblem(v[k], `${path}.${k}`);
      if (p) return p;
    }
    return null;
  }
  return `${path} is not plain JSON (${v === undefined ? 'undefined' : typeof v === 'object' ? Object.prototype.toString.call(v) : typeof v})`;
}

/** The most rows one listRecordsPage call returns. */
const PAGE_MAX = 200;
const COMMIT_LISTS = ['checks', 'updates', 'inserts', 'deletes'];
const OP_OF = { checks: 'check', updates: 'update', inserts: 'insert', deletes: 'delete' };

/**
 * Validate a commit() argument and return its operations in (kind, id) order, the order both stores
 * verify (and Postgres locks) them in, so the first failure they report is the same. Throws a TypeError for
 * a malformed call (unknown list, bad kind or id, a document that is not plain JSON all the way down: see
 * jsonProblem) and an Error when one record appears twice: a commit touches each record at most once.
 * Both stores refuse exactly the same inputs, before anything is written.
 * @param {object} spec { checks, updates, inserts, deletes }
 * @returns {Array<{ op: 'check'|'update'|'insert'|'delete', kind: string, id: string, rev?: number, next?: object, data?: object, userId?: string|null }>}
 */
function planCommit(spec = {}) {
  if (!isPlainObject(spec)) throw new TypeError('[store] commit takes { checks, updates, inserts, deletes }');
  for (const key of Object.keys(spec)) {
    if (!COMMIT_LISTS.includes(key)) throw new TypeError(`[store] commit takes checks, updates, inserts and deletes (got ${key})`);
  }
  const ops = [];
  const seen = new Set();
  for (const list of COMMIT_LISTS) {
    const items = spec[list] === undefined ? [] : spec[list];
    if (!Array.isArray(items)) throw new TypeError(`[store] commit ${list} must be an array`);
    for (const item of items) {
      if (!isPlainObject(item)) throw new TypeError(`[store] commit ${list} entries must be objects`);
      const { kind, id } = item;
      if (!storable(kind) || !kind || !storable(id) || !id || id.length > 200) throw new TypeError(`[store] commit ${list} entry needs a kind and an id`);
      const key = `${kind}:${id}`;
      if (seen.has(key)) throw new Error(`[store] commit touches ${key} more than once`);
      seen.add(key);
      const op = { op: OP_OF[list], kind, id };
      if (list === 'checks') op.rev = item.rev;
      if (list === 'updates') {
        if (!isPlainObject(item.next)) throw new TypeError(`[store] commit update ${key} needs a plain object as next`);
        const problem = jsonProblem(item.next, 'next');
        if (problem) throw new TypeError(`[store] commit update ${key}: ${problem}`);
        op.rev = item.expectedRev;
        op.next = item.next;
      }
      if (list === 'deletes') op.rev = item.expectedRev;
      if (list === 'inserts') {
        if (!isPlainObject(item.data)) throw new TypeError(`[store] commit insert ${key} needs a plain object as data`);
        const problem = jsonProblem(item.data, 'data');
        if (problem) throw new TypeError(`[store] commit insert ${key}: ${problem}`);
        op.data = item.data;
        op.userId = item.userId ?? null;
      }
      ops.push(op);
    }
  }
  return ops.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The limit and owner checks every listRecordsPage makes. A falsy owner would page through every tenant.
 * @param {string} userId
 * @param {number} limit
 */
function checkPageArgs(userId, limit) {
  if (!userId || typeof userId !== 'string') throw new Error('[store] listRecordsPage needs an owner (userId): it never lists every tenant');
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new RangeError(`[store] listRecordsPage limit must be a whole number from 1 to ${PAGE_MAX}`);
}

/** The 400 a forged or damaged page cursor answers with (Repo turns it into a 404). */
function badCursor() {
  return new AppError('bad_cursor', 'That page link is not valid any more.', 400);
}

/** An opaque cursor: base64url of a JSON value. */
const encodeCursor = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** The JSON value inside a cursor, or a bad_cursor error. */
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw badCursor();
  try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw badCursor(); }
}

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.quotes = new Map();
    this.bookings = new Map();
    this.refs = new Map();
    this.intents = new Map();
    this.leads = [];
    this.records = new Map();
  }

  async init() {}
  async close() {}

  async saveQuote(q) { this.quotes.set(q.id, clone(q)); return q; }
  async getQuote(id) { return clone(this.quotes.get(id)) || null; }

  async createBooking(b) {
    if (this.refs.has(b.ref)) throw new Error('duplicate booking ref');
    this.bookings.set(b.id, clone(b));
    this.refs.set(b.ref, b.id);
    return b;
  }

  async getBooking(id) { return clone(this.bookings.get(id)) || null; }
  async getBookingByRef(ref) { const id = this.refs.get(ref); return id ? this.getBooking(id) : null; }

  // Compare-and-set on status, so two concurrent pay/cancel calls can't both win.
  async updateBooking(id, expectedStatus, patch) {
    const cur = this.bookings.get(id);
    if (!cur || (expectedStatus && cur.status !== expectedStatus)) return null;
    const next = { ...cur, ...clone(patch), updatedAt: new Date().toISOString() };
    this.bookings.set(id, next);
    return clone(next);
  }

  async savePaymentIntent(i) { this.intents.set(i.id, clone(i)); return i; }
  async getPaymentIntent(id) { return clone(this.intents.get(id)) || null; }

  async savePartnerLead(lead) { this.leads.push(clone(lead)); return lead; }

  /**
   * Partner and business enquiries, newest first.
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<object[]>}
   */
  async listPartnerLeads({ limit = 200 } = {}) { return clone(this.leads).reverse().slice(0, limit); }

  // Newest first.
  async listBookings({ userId, limit = 500 } = {}) {
    return [...this.bookings.values()].filter(b => !userId || b.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit).map(clone);
  }

  // Generic records (accounts, saved trips, analytics events, settings, support messages, …): a kind,
  // an id, an optional owner and a JSON document.
  async putRecord(kind, id, data, { userId = null } = {}) {
    const key = `${kind}:${id}`;
    const prev = this.records.get(key);
    this.records.set(key, { kind, id, userId: userId ?? (prev && prev.userId) ?? null, data: clone(data), createdAt: prev ? prev.createdAt : new Date().toISOString(), seq: prev ? prev.seq : (this.seq = (this.seq || 0) + 1) });
    return data;
  }
  /**
   * Insert-only write: stores the record only when no record of this kind has this id yet.
   * @returns {Promise<boolean>} true when written, false when the id was taken (the stored data is untouched)
   */
  async insertRecord(kind, id, data, { userId = null } = {}) {
    const key = `${kind}:${id}`;
    if (this.records.has(key)) return false;
    this.records.set(key, { kind, id, userId: userId ?? null, data: clone(data), createdAt: new Date().toISOString(), seq: (this.seq = (this.seq || 0) + 1) });
    return true;
  }

  /**
   * Compare-and-set on the document's `rev` (a missing rev counts as 0): writes `{ ...next, rev: expectedRev + 1 }`
   * only when the stored rev still equals expectedRev. The owner, creation time and list order are kept.
   * @returns {Promise<object|null>} the written document, or null when the record is missing or the rev moved on
   */
  async updateRecord(kind, id, expectedRev, next) {
    const r = this.records.get(`${kind}:${id}`);
    if (!r || !Number.isInteger(expectedRev) || (r.data.rev ?? 0) !== expectedRev) return null;
    r.data = { ...clone(next), rev: expectedRev + 1 };
    return clone(r.data);
  }

  async getRecord(kind, id) { const r = this.records.get(`${kind}:${id}`); return r ? clone(r.data) : null; }
  async deleteRecord(kind, id) { return this.records.delete(`${kind}:${id}`); }
  async listRecords(kind, { userId, limit = 1000, since } = {}) {
    return [...this.records.values()].filter(r => r.kind === kind && (!userId || r.userId === userId) && (!since || r.createdAt >= since))
      .sort((a, b) => b.seq - a.seq).slice(0, limit).map(r => clone(r.data));
  }

  /**
   * Atomic all-or-nothing write of several records (plan §C1). Everything is verified first and then
   * everything is applied, with no await in between, so no other call can interleave.
   * - checks:  [{ kind, id, rev }] the record exists and its rev (a missing rev counts as 0) is still `rev`;
   * - updates: [{ kind, id, expectedRev, next }] compare-and-set on rev, written as { ...next, rev: expectedRev + 1 };
   * - inserts: [{ kind, id, data, userId }] insert-only;
   * - deletes: [{ kind, id, expectedRev }] compare-and-set delete.
   * Each record may appear once. Operations run in (kind, id) order and the first failure is reported.
   * @param {{ checks?: object[], updates?: object[], inserts?: object[], deletes?: object[] }} spec
   * @returns {Promise<{ ok: true, docs: Record<string, object> } | { ok: false, reason: 'conflict'|'duplicate', kind: string, id: string }>}
   *   docs holds every inserted and updated document under 'kind:id'
   */
  async commit(spec) {
    const ops = planCommit(spec);
    // Copy every payload before touching anything, so the apply loop below cannot throw part-way.
    for (const o of ops) {
      if (o.data) o.data = clone(o.data);
      if (o.next) o.next = clone(o.next);
    }
    for (const o of ops) {
      const r = this.records.get(`${o.kind}:${o.id}`);
      if (o.op === 'insert') {
        if (r) return { ok: false, reason: 'duplicate', kind: o.kind, id: o.id };
      } else if (!r || !Number.isInteger(o.rev) || (r.data.rev ?? 0) !== o.rev) {
        return { ok: false, reason: 'conflict', kind: o.kind, id: o.id };
      }
    }
    const docs = {};
    const at = new Date().toISOString();
    for (const o of ops) {
      const key = `${o.kind}:${o.id}`;
      if (o.op === 'insert') {
        this.records.set(key, { kind: o.kind, id: o.id, userId: o.userId, data: o.data, createdAt: at, seq: (this.seq = (this.seq || 0) + 1) });
        docs[key] = clone(o.data);
      } else if (o.op === 'update') {
        const r = this.records.get(key);
        r.data = { ...o.next, rev: o.rev + 1 };
        docs[key] = clone(r.data);
      } else if (o.op === 'delete') {
        this.records.delete(key);
      }
    }
    return { ok: true, docs };
  }

  /**
   * One owner's records of a kind, newest first, a page at a time. The order is the store's own (insertion
   * order here, created_at in Postgres): never business logic. The cursor is opaque.
   * @param {string} kind
   * @param {{ userId: string, limit?: number, cursor?: string|null }} opts userId is required (a falsy one throws)
   * @returns {Promise<{ rows: object[], cursor: string|null }>} cursor is null on the last page
   */
  async listRecordsPage(kind, { userId, limit = 50, cursor = null } = {}) {
    checkPageArgs(userId, limit);
    let before = Infinity;
    if (cursor !== null && cursor !== undefined) {
      before = decodeCursor(cursor);
      if (!Number.isSafeInteger(before) || before < 1) throw badCursor();
    }
    const hits = [...this.records.values()].filter(r => r.kind === kind && r.userId === userId && r.seq < before)
      .sort((a, b) => b.seq - a.seq).slice(0, limit + 1);
    const more = hits.length > limit;
    const rows = hits.slice(0, limit);
    return { rows: rows.map(r => clone(r.data)), cursor: more ? encodeCursor(rows[rows.length - 1].seq) : null };
  }
}

module.exports = { MemoryStore, planCommit, checkPageArgs, badCursor, encodeCursor, decodeCursor, jsonProblem, storable, PAGE_MAX };
