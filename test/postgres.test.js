// Runs the store contract against a real Postgres when TEST_DATABASE_URL is set (skipped otherwise).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStore } = require('../server/booking');

const url = process.env.TEST_DATABASE_URL;

test('PostgresStore round-trips quotes, bookings, intents and leads', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const store = new PostgresStore({ connectionString: url, ssl: false });
  await store.init();
  await store.init(); // idempotent
  try {
    const sfx = Date.now().toString(36);
    const quote = { id: `qt_${sfx}`, vertical: 'hotels', demo: true, expiresAt: new Date(Date.now() + 60000).toISOString(), total: 100 };
    await store.saveQuote(quote);
    assert.deepEqual(await store.getQuote(quote.id), quote);

    const b = { id: `bk_${sfx}`, ref: `DEMO-${sfx.toUpperCase()}`, vertical: 'hotels', status: 'pending_payment', demo: true, traveler: { email: 'a@b.co' }, total: 100, currency: 'USD', history: [] };
    await store.createBooking(b);
    assert.equal((await store.getBookingByRef(b.ref)).id, b.id);
    assert.equal(await store.updateBooking(b.id, 'confirmed', { status: 'cancelled' }), null, 'compare-and-set refuses a stale status');
    const u = await store.updateBooking(b.id, 'pending_payment', { status: 'confirming' });
    assert.equal(u.status, 'confirming');
    // Two racing claims: exactly one wins.
    const [x, y] = await Promise.all([
      store.updateBooking(b.id, 'confirming', { status: 'confirmed' }),
      store.updateBooking(b.id, 'confirming', { status: 'failed' }),
    ]);
    assert.equal([x, y].filter(Boolean).length, 1);

    const intent = { id: `pi_${sfx}`, bookingId: b.id, mode: 'test', status: 'requires_payment', amount: 100 };
    await store.savePaymentIntent(intent);
    await store.savePaymentIntent({ ...intent, status: 'succeeded' });
    assert.equal((await store.getPaymentIntent(intent.id)).status, 'succeeded');
    await store.savePartnerLead({ id: `lead_${sfx}`, name: 'n' });
  } finally {
    await store.close();
  }
});

test('PostgresStore keeps generic records and lists a user’s bookings', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const store = new PostgresStore({ connectionString: url, ssl: false });
  await store.init();
  try {
    const sfx = Date.now().toString(36);
    await store.putRecord('saved', `sv_${sfx}`, { token: 'abc', budget: 1000 }, { userId: `usr_${sfx}` });
    await store.putRecord('saved', `sv_${sfx}`, { token: 'abc', budget: 2000 }, { userId: `usr_${sfx}` }); // upsert
    assert.equal((await store.getRecord('saved', `sv_${sfx}`)).budget, 2000);
    assert.equal((await store.listRecords('saved', { userId: `usr_${sfx}` })).length, 1);
    assert.equal((await store.listRecords('saved', { userId: 'usr_nobody' })).length, 0);
    await store.deleteRecord('saved', `sv_${sfx}`);
    assert.equal(await store.getRecord('saved', `sv_${sfx}`), null);

    const b = { id: `bk2_${sfx}`, ref: `DEMO-BT-${sfx.toUpperCase()}`, vertical: 'trips', status: 'confirmed', demo: true, userId: `usr_${sfx}`, traveler: { email: 'a@b.co' }, total: 100, currency: 'USD', history: [] };
    await store.createBooking(b);
    assert.equal((await store.listBookings({ userId: `usr_${sfx}` })).length, 1);
    assert.equal((await store.listBookings({ userId: 'usr_nobody' })).length, 0);
  } finally {
    await store.close();
  }
});

test('PostgresStore keeps the Business store contract: insert-only, compare-and-set, leads newest first', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const store = new PostgresStore({ connectionString: url, ssl: false });
  await store.init();
  try {
    const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const owner = `org_${sfx}`;
    assert.equal(await store.insertRecord('biz_test', `a_${sfx}`, { n: 1 }, { userId: owner }), true);
    assert.equal(await store.insertRecord('biz_test', `a_${sfx}`, { n: 2 }, { userId: `org_other_${sfx}` }), false);
    assert.deepEqual(await store.getRecord('biz_test', `a_${sfx}`), { n: 1 });
    assert.equal((await store.listRecords('biz_test', { userId: owner })).length, 1);

    assert.equal(await store.updateRecord('biz_test', `a_${sfx}`, 1, { n: 9 }), null, 'wrong rev (missing rev counts as 0)');
    assert.equal(await store.updateRecord('biz_test', `missing_${sfx}`, 0, { n: 9 }), null);
    assert.deepEqual(await store.updateRecord('biz_test', `a_${sfx}`, 0, { n: 2, rev: 77 }), { n: 2, rev: 1 });
    assert.equal(await store.updateRecord('biz_test', `a_${sfx}`, 0, { n: 3 }), null, 'a stale rev loses');
    assert.equal((await store.listRecords('biz_test', { userId: owner })).length, 1, 'the owner is kept');

    const results = await Promise.all(['x', 'y', 'z'].map(v => store.updateRecord('biz_test', `a_${sfx}`, 1, { v })));
    assert.equal(results.filter(Boolean).length, 1, 'racing compare-and-sets: exactly one wins');
    assert.equal((await store.getRecord('biz_test', `a_${sfx}`)).rev, 2);
    const inserts = await Promise.all([1, 2, 3].map(n => store.insertRecord('biz_test', `new_${sfx}`, { n })));
    assert.equal(inserts.filter(Boolean).length, 1, 'racing inserts: exactly one wins');

    for (const n of [1, 2]) {
      await store.savePartnerLead({ id: `lead_${sfx}_${n}`, name: `n${n}` });
      await new Promise(r => setTimeout(r, 5));
    }
    const leads = await store.listPartnerLeads({ limit: 2 });
    assert.deepEqual(leads.map(l => l.id), [`lead_${sfx}_2`, `lead_${sfx}_1`]);
    await store.deleteRecord('biz_test', `a_${sfx}`);
    await store.deleteRecord('biz_test', `new_${sfx}`);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// init(): the first boot of this code on a database made by main (go-live §3.9). The index this code adds is
// built with CREATE INDEX CONCURRENTLY, outside the schema transaction, so the task still serving the site
// keeps writing during the build; and inits that start together (a web task and an admin task) all succeed.
const crypto = require('node:crypto');
const { Pool, Client } = require('pg');

const NEW_INDEX = 'tx_records_kind_user_created_idx';
const NEW_INDEX_DEF = `CREATE INDEX ${NEW_INDEX} ON %s.tx_records USING btree (kind, user_id, created_at DESC, id DESC)`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('init sends the new index on its own, as CREATE INDEX CONCURRENTLY, never inside the schema statements', async () => {
  // A stand-in pool that records every statement: no database needed.
  const store = new PostgresStore({ connectionString: 'postgres://nobody@127.0.0.1:1/none', ssl: false });
  await store.pool.end();
  const sent = [];
  const query = async sql => {
    sent.push(String(sql));
    return /pg_try_advisory_lock/.test(sql) ? { rows: [{ locked: true }], rowCount: 1 } : { rows: [], rowCount: 0 };
  };
  store.pool = { connect: async () => ({ query, release() {} }), query, end: async () => {} };
  await store.init();
  const builds = sent.filter(q => q.includes(NEW_INDEX) && /CREATE\s+(UNIQUE\s+)?INDEX/i.test(q));
  assert.deepEqual(builds, [`CREATE INDEX CONCURRENTLY ${NEW_INDEX} ON tx_records (kind, user_id, created_at DESC, id DESC)`]);
});

/** A schema of its own in the test database (dropped after the test), and connection strings into it. */
async function freshSchema(t) {
  const schema = `init_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const own = app => {
    const u = new URL(url);
    u.searchParams.set('options', `-c search_path=${schema}`);
    if (app) u.searchParams.set('application_name', app);
    return u.toString();
  };
  return { schema, admin, own };
}

/** Tables as main's code leaves them (everything but the new index), with `rows` records and one booking. */
async function mainEra(db, rows) {
  const s = new PostgresStore({ connectionString: db.own(), ssl: false });
  try {
    await s.init();
    await s.pool.query(`DROP INDEX ${NEW_INDEX}`);
    await s.pool.query(`INSERT INTO tx_records (kind, id, user_id, data) SELECT 'k' || (g % 5), 'id' || g, 'u' || (g % 100), jsonb_build_object('g', g) FROM generate_series(1, $1::int) g`, [rows]);
    await s.createBooking({ id: 'bk_1', ref: 'DEMO-BK1', vertical: 'trips', status: 'confirmed', demo: true, traveler: { email: 'a@b.co' }, total: 100, currency: 'USD', history: [] });
  } finally {
    await s.close();
  }
}

/** The new index in this schema: [{ def, valid }] (empty when there is none). */
async function newIndex(db) {
  const { rows } = await db.admin.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname = $2`, [NEW_INDEX, db.schema]);
  return rows;
}

test('first boot on a database made by main: writes to tx_records and tx_bookings go on while the new index is built', { skip: !url && 'TEST_DATABASE_URL not set' }, async t => {
  const db = await freshSchema(t);
  await mainEra(db, 2000);
  // An older transaction that holds a snapshot and no lock on either table: a concurrent build waits for it to
  // end before it finishes, which leaves time to write while the build runs.
  const holder = new Client({ connectionString: db.own() });
  await holder.connect();
  await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await holder.query('SELECT 1');
  const app = `init_${db.schema}`;
  const store = new PostgresStore({ connectionString: db.own(app), ssl: false });
  const writer = new Client({ connectionString: db.own() });
  await writer.connect();
  let settled = false;
  const init = store.init().finally(() => { settled = true; });
  try {
    let building = null;
    for (let i = 0; i < 800 && !settled && !building; i += 1) {
      const { rows } = await db.admin.query(
        `SELECT p.command, a.wait_event_type FROM pg_stat_activity a JOIN pg_stat_progress_create_index p ON p.pid = a.pid
         WHERE a.application_name = $1 AND a.wait_event_type = 'Lock'`, [app]);
      building = rows[0] || null;
      if (!building) await sleep(25);
    }
    assert.ok(building && !settled, 'init was still building the index, waiting for the older transaction (a build inside the schema transaction never waits for it)');
    assert.equal(building.command, 'CREATE INDEX CONCURRENTLY');
    // During the build init holds no lock on either table that blocks a write (ShareUpdateExclusiveLock does not).
    const { rows: locks } = await db.admin.query(
      `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE a.application_name = $1 AND l.granted AND c.relname IN ('tx_records', 'tx_bookings') ORDER BY 1, 2`, [app]);
    assert.deepEqual(locks.map(l => `${l.relname} ${l.mode}`), ['tx_records ShareUpdateExclusiveLock']);
    await writer.query("SET lock_timeout = '5s'");
    assert.equal((await writer.query("INSERT INTO tx_records (kind, id, user_id, data) VALUES ('event', 'during_build', NULL, '{}')")).rowCount, 1);
    assert.equal((await writer.query("UPDATE tx_bookings SET updated_at = now() WHERE id = 'bk_1'")).rowCount, 1);
    assert.equal(settled, false, 'the writes went through while the build was still running');
  } finally {
    await holder.query('COMMIT');
    await holder.end();
    await writer.end();
    await init.catch(() => {});
    await store.close();
  }
  await init;
  assert.deepEqual(await newIndex(db), [{ def: NEW_INDEX_DEF.replace('%s', db.schema), valid: true }]);
});

test('first boots at the same moment on a database made by main: every init succeeds and the index is built once', { skip: !url && 'TEST_DATABASE_URL not set' }, async t => {
  const db = await freshSchema(t);
  await mainEra(db, 20000);
  const stores = [1, 2, 3, 4].map(() => new PostgresStore({ connectionString: db.own(), ssl: false }));
  try {
    await Promise.all(stores.map(s => s.pool.query('SELECT 1')));
    const results = await Promise.allSettled(stores.map(s => s.init()));
    assert.deepEqual(results.map(r => (r.status === 'fulfilled' ? 'ok' : `${r.reason.code} ${r.reason.message}`)), ['ok', 'ok', 'ok', 'ok']);
  } finally {
    await Promise.all(stores.map(s => s.close()));
  }
  assert.deepEqual(await newIndex(db), [{ def: NEW_INDEX_DEF.replace('%s', db.schema), valid: true }]);
});

test('init replaces an invalid index left by a build that stopped halfway', { skip: !url && 'TEST_DATABASE_URL not set' }, async t => {
  const db = await freshSchema(t);
  await mainEra(db, 50);
  // A concurrent build that fails (here on a uniqueness violation) leaves an invalid index under the name.
  const s = new PostgresStore({ connectionString: db.own(), ssl: false });
  try {
    await assert.rejects(s.pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${NEW_INDEX} ON tx_records (kind)`), { code: '23505' });
    const [left] = await newIndex(db);
    assert.equal(left.valid, false);
    await s.init();
  } finally {
    await s.close();
  }
  assert.deepEqual(await newIndex(db), [{ def: NEW_INDEX_DEF.replace('%s', db.schema), valid: true }]);
});
