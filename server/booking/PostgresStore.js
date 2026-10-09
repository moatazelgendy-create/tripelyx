// Postgres store for staging and production (and development when DATABASE_URL is set). Each
const fs = require('fs');
// environment points at its own database via DATABASE_URL. Rows keep the queryable fields as columns
// and the full normalized record as JSONB, so the schema doesn't churn as verticals evolve.
const { Pool } = require('pg');
const { planCommit, checkPageArgs, badCursor, encodeCursor, decodeCursor, storable } = require('./MemoryStore');

/** created_at::text as Postgres prints it (DateStyle ISO), e.g. "2026-10-09 09:00:00.123456+00". The
 * offset is within what Postgres reads (±15:59:59). */
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-](?:0\d|1[0-5])(?::[0-5]\d){0,2}$/;
/** Deadlock and serialization failures: the losing transaction is rolled back and reported as a conflict. */
const RETRYABLE_PG = new Set(['40P01', '40001']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tx_quotes (
  id TEXT PRIMARY KEY,
  vertical TEXT NOT NULL,
  demo BOOLEAN NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tx_bookings (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  vertical TEXT NOT NULL,
  status TEXT NOT NULL,
  demo BOOLEAN NOT NULL,
  email TEXT NOT NULL,
  total_amount BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tx_bookings_email_idx ON tx_bookings (email);
CREATE INDEX IF NOT EXISTS tx_bookings_status_idx ON tx_bookings (status);
CREATE TABLE IF NOT EXISTS tx_payment_intents (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tx_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS tx_records_kind_user_idx ON tx_records (kind, user_id);
CREATE INDEX IF NOT EXISTS tx_records_kind_created_idx ON tx_records (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_bookings_user_idx ON tx_bookings ((data->>'userId'));
CREATE TABLE IF NOT EXISTS tx_partner_leads (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * Indexes added after tables already hold live data. Each is built with CREATE INDEX CONCURRENTLY, on its own
 * after SCHEMA (CONCURRENTLY cannot run in a transaction), so the tables stay writable during the build: SCHEMA
 * runs as one implicit transaction, and a plain CREATE INDEX there would hold its lock on the table, blocking
 * every insert and update from the task still serving the site, until the whole build is done.
 */
const LATE_INDEXES = Object.freeze([
  { name: 'tx_records_kind_user_created_idx', create: 'CREATE INDEX CONCURRENTLY tx_records_kind_user_created_idx ON tx_records (kind, user_id, created_at DESC, id DESC)' },
]);
/**
 * The session-level advisory lock init() holds while it runs SCHEMA and builds LATE_INDEXES, so inits that start
 * together (a web task and an admin task) run one after another: the later ones find the index built. Without it,
 * two first builds of one index both find no index and the second fails with 23505 on pg_class.
 */
const SCHEMA_LOCK = 727274001;
const SCHEMA_LOCK_POLL_MS = 50;

/**
 * Take SCHEMA_LOCK on this client's session. It is polled with pg_try_advisory_lock, never waited for inside
 * pg_advisory_lock: a session waiting in a statement keeps a snapshot, and the concurrent index build of the
 * session holding the lock waits for every older snapshot to end, so the two would wait for each other.
 */
async function lockSchema(client) {
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [SCHEMA_LOCK]);
    if (rows[0] && rows[0].locked) return;
    await new Promise(resolve => setTimeout(resolve, SCHEMA_LOCK_POLL_MS));
  }
}

/**
 * Build each LATE_INDEXES index that is missing. An invalid one (what a concurrent build that stopped halfway
 * leaves) is dropped and built again; holding SCHEMA_LOCK, no other init can be building it.
 */
async function buildLateIndexes(client) {
  for (const { name, create } of LATE_INDEXES) {
    const { rows } = await client.query('SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = to_regclass($1)', [name]);
    if (rows[0] && rows[0].valid) continue;
    if (rows[0]) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
    await client.query(create);
  }
}

class PostgresStore {
  constructor({ connectionString, ssl, caFile = null }) {
    this.kind = 'postgres';
    const tls = ssl ? { rejectUnauthorized: true, ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}) } : false;
    this.pool = new Pool({ connectionString, ssl: tls, max: 10 });
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await lockSchema(client);
      await client.query(SCHEMA);
      await buildLateIndexes(client);
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    } catch (e) {
      // Closing this connection ends its session, which releases SCHEMA_LOCK (and stops a build halfway).
      client.release(e);
      throw e;
    }
    client.release();
  }
  async close() { await this.pool.end(); }

  async saveQuote(q) {
    await this.pool.query(
      `INSERT INTO tx_quotes (id, vertical, demo, expires_at, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [q.id, q.vertical, q.demo, q.expiresAt, q],
    );
    return q;
  }

  async getQuote(id) {
    const { rows } = await this.pool.query('SELECT data FROM tx_quotes WHERE id = $1', [id]);
    return rows[0] ? rows[0].data : null;
  }

  async createBooking(b) {
    await this.pool.query(
      `INSERT INTO tx_bookings (id, ref, vertical, status, demo, email, total_amount, currency, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [b.id, b.ref, b.vertical, b.status, b.demo, b.traveler.email, b.total, b.currency, b],
    );
    return b;
  }

  async getBooking(id) {
    const { rows } = await this.pool.query('SELECT data FROM tx_bookings WHERE id = $1', [id]);
    return rows[0] ? rows[0].data : null;
  }

  async getBookingByRef(ref) {
    const { rows } = await this.pool.query('SELECT data FROM tx_bookings WHERE ref = $1', [ref]);
    return rows[0] ? rows[0].data : null;
  }

  async updateBooking(id, expectedStatus, patch) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT data FROM tx_bookings WHERE id = $1 FOR UPDATE', [id]);
      const cur = rows[0] && rows[0].data;
      if (!cur || (expectedStatus && cur.status !== expectedStatus)) { await client.query('ROLLBACK'); return null; }
      const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
      await client.query('UPDATE tx_bookings SET status = $2, data = $3, updated_at = now() WHERE id = $1', [id, next.status, next]);
      await client.query('COMMIT');
      return next;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async savePaymentIntent(i) {
    await this.pool.query(
      `INSERT INTO tx_payment_intents (id, booking_id, mode, status, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = now()`,
      [i.id, i.bookingId, i.mode, i.status, i],
    );
    return i;
  }

  async getPaymentIntent(id) {
    const { rows } = await this.pool.query('SELECT data FROM tx_payment_intents WHERE id = $1', [id]);
    return rows[0] ? rows[0].data : null;
  }

  async listBookings({ userId, limit = 500 } = {}) {
    const { rows } = userId
      ? await this.pool.query("SELECT data FROM tx_bookings WHERE data->>'userId' = $1 ORDER BY created_at DESC LIMIT $2", [userId, limit])
      : await this.pool.query('SELECT data FROM tx_bookings ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows.map(r => r.data);
  }

  async putRecord(kind, id, data, { userId = null } = {}) {
    await this.pool.query(
      `INSERT INTO tx_records (kind, id, user_id, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, user_id = COALESCE(EXCLUDED.user_id, tx_records.user_id), updated_at = now()`,
      [kind, id, userId, data],
    );
    return data;
  }

  /**
   * Insert-only write: stores the record only when no record of this kind has this id yet.
   * @returns {Promise<boolean>} true when written, false when the id was taken (the stored data is untouched)
   */
  async insertRecord(kind, id, data, { userId = null } = {}) {
    const { rowCount } = await this.pool.query(
      'INSERT INTO tx_records (kind, id, user_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, id) DO NOTHING',
      [kind, id, userId, data],
    );
    return rowCount === 1;
  }

  /**
   * Compare-and-set on the document's `rev` (a missing rev counts as 0): writes `{ ...next, rev: expectedRev + 1 }`
   * only when the stored rev still equals expectedRev. The owner and creation time are kept.
   * @returns {Promise<object|null>} the written document, or null when the record is missing or the rev moved on
   */
  async updateRecord(kind, id, expectedRev, next) {
    if (!Number.isInteger(expectedRev)) return null;
    const { rows } = await this.pool.query(
      `UPDATE tx_records SET data = $4, updated_at = now()
       WHERE kind = $1 AND id = $2 AND COALESCE((data->>'rev')::int, 0) = $3 RETURNING data`,
      [kind, id, expectedRev, { ...next, rev: expectedRev + 1 }],
    );
    return rows[0] ? rows[0].data : null;
  }

  async getRecord(kind, id) {
    const { rows } = await this.pool.query('SELECT data FROM tx_records WHERE kind = $1 AND id = $2', [kind, id]);
    return rows[0] ? rows[0].data : null;
  }

  async deleteRecord(kind, id) {
    const { rowCount } = await this.pool.query('DELETE FROM tx_records WHERE kind = $1 AND id = $2', [kind, id]);
    return rowCount > 0;
  }

  async listRecords(kind, { userId, limit = 1000, since } = {}) {
    const where = ['kind = $1'], args = [kind];
    if (userId) { args.push(userId); where.push(`user_id = $${args.length}`); }
    if (since) { args.push(since); where.push(`created_at >= $${args.length}`); }
    args.push(limit);
    const { rows } = await this.pool.query(`SELECT data FROM tx_records WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args);
    return rows.map(r => r.data);
  }

  /**
   * Atomic all-or-nothing write of several records (plan §C1), in one transaction on one pooled client.
   * Rows are touched in (kind, id) order, so two commits never lock the same rows in opposite orders:
   * - checks:  [{ kind, id, rev }] SELECT … FOR SHARE: the record exists and its rev is still `rev`;
   * - updates: [{ kind, id, expectedRev, next }] UPDATE … WHERE rev = expectedRev, written as { ...next, rev: expectedRev + 1 };
   * - inserts: [{ kind, id, data, userId }] INSERT … ON CONFLICT DO NOTHING (created_at = clock_timestamp(),
   *   so the inserts of one commit keep their (kind, id) order in listRecordsPage);
   * - deletes: [{ kind, id, expectedRev }] DELETE … WHERE rev = expectedRev.
   * Any statement that touches 0 rows, a deadlock or a serialization failure rolls everything back.
   * @param {{ checks?: object[], updates?: object[], inserts?: object[], deletes?: object[] }} spec
   * @returns {Promise<{ ok: true, docs: Record<string, object> } | { ok: false, reason: 'conflict'|'duplicate', kind: string, id: string }>}
   */
  async commit(spec) {
    const ops = planCommit(spec);
    if (!ops.length) return { ok: true, docs: {} };
    const client = await this.pool.connect();
    let current = null;
    let healthy = true;
    try {
      await client.query('BEGIN');
      const docs = {};
      for (const o of ops) {
        current = o;
        const key = `${o.kind}:${o.id}`;
        let rows = [];
        let count = 0;
        if (o.op === 'insert') {
          ({ rows } = await client.query(
            `INSERT INTO tx_records (kind, id, user_id, data, created_at) VALUES ($1, $2, $3, $4, clock_timestamp())
             ON CONFLICT (kind, id) DO NOTHING RETURNING data`,
            [o.kind, o.id, o.userId, o.data],
          ));
          if (rows.length !== 1) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'duplicate', kind: o.kind, id: o.id };
          }
          docs[key] = rows[0].data;
          continue;
        }
        if (Number.isInteger(o.rev)) {
          if (o.op === 'check') {
            ({ rowCount: count } = await client.query(
              "SELECT 1 FROM tx_records WHERE kind = $1 AND id = $2 AND COALESCE((data->>'rev')::int, 0) = $3 FOR SHARE",
              [o.kind, o.id, o.rev],
            ));
          } else if (o.op === 'update') {
            ({ rows, rowCount: count } = await client.query(
              `UPDATE tx_records SET data = $4, updated_at = now()
               WHERE kind = $1 AND id = $2 AND COALESCE((data->>'rev')::int, 0) = $3 RETURNING data`,
              [o.kind, o.id, o.rev, { ...o.next, rev: o.rev + 1 }],
            ));
            if (count === 1) docs[key] = rows[0].data;
          } else {
            ({ rowCount: count } = await client.query(
              "DELETE FROM tx_records WHERE kind = $1 AND id = $2 AND COALESCE((data->>'rev')::int, 0) = $3",
              [o.kind, o.id, o.rev],
            ));
          }
        }
        if (count !== 1) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'conflict', kind: o.kind, id: o.id };
        }
      }
      await client.query('COMMIT');
      return { ok: true, docs };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { healthy = false; }
      if (healthy && RETRYABLE_PG.has(err.code) && current) return { ok: false, reason: 'conflict', kind: current.kind, id: current.id };
      throw err;
    } finally {
      client.release(healthy ? undefined : true);
    }
  }

  /**
   * One owner's records of a kind, newest first (created_at, then id), a page at a time with a keyset
   * cursor. Store order only, never business logic. The cursor is opaque.
   * @param {string} kind
   * @param {{ userId: string, limit?: number, cursor?: string|null }} opts userId is required (a falsy one throws)
   * @returns {Promise<{ rows: object[], cursor: string|null }>} cursor is null on the last page
   */
  async listRecordsPage(kind, { userId, limit = 50, cursor = null } = {}) {
    checkPageArgs(userId, limit);
    const where = ['kind = $1', 'user_id = $2'];
    const args = [kind, userId];
    if (cursor !== null && cursor !== undefined) {
      const at = decodeCursor(cursor);
      if (!Array.isArray(at) || at.length !== 2 || typeof at[0] !== 'string' || !PG_TIMESTAMP.test(at[0])
        || !storable(at[1]) || !at[1] || at[1].length > 200) throw badCursor();
      args.push(at[0], at[1]);
      where.push('(created_at, id) < ($3::timestamptz, $4)');
    }
    args.push(limit + 1);
    let rows;
    try {
      ({ rows } = await this.pool.query(
        `SELECT created_at::text AS ca, id, data FROM tx_records WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT $${args.length}`,
        args,
      ));
    } catch (err) {
      // A cursor value Postgres can't read (class 22, data exception: a bad date, time, offset or byte).
      if (cursor !== null && cursor !== undefined && typeof err.code === 'string' && err.code.startsWith('22')) throw badCursor();
      throw err;
    }
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { rows: page.map(r => r.data), cursor: more ? encodeCursor([last.ca, last.id]) : null };
  }

  async savePartnerLead(lead) {
    await this.pool.query('INSERT INTO tx_partner_leads (id, data) VALUES ($1, $2)', [lead.id, lead]);
    return lead;
  }

  /**
   * Partner and business enquiries, newest first.
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<object[]>}
   */
  async listPartnerLeads({ limit = 200 } = {}) {
    const { rows } = await this.pool.query('SELECT data FROM tx_partner_leads ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
    return rows.map(r => r.data);
  }
}

module.exports = { PostgresStore };
