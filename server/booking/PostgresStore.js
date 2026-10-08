// Postgres store for staging and production (and development when DATABASE_URL is set). Each
const fs = require('fs');
// environment points at its own database via DATABASE_URL. Rows keep the queryable fields as columns
// and the full normalized record as JSONB, so the schema doesn't churn as verticals evolve.
const { Pool } = require('pg');

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

class PostgresStore {
  constructor({ connectionString, ssl, caFile = null }) {
    this.kind = 'postgres';
    const tls = ssl ? { rejectUnauthorized: true, ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}) } : false;
    this.pool = new Pool({ connectionString, ssl: tls, max: 10 });
  }

  async init() { await this.pool.query(SCHEMA); }
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

  async savePartnerLead(lead) {
    await this.pool.query('INSERT INTO tx_partner_leads (id, data) VALUES ($1, $2)', [lead.id, lead]);
    return lead;
  }
}

module.exports = { PostgresStore };
