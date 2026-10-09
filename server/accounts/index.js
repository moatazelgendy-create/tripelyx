// Customer accounts: email + password (scrypt), server-side sessions in the store, and a session cookie
// that is HttpOnly and SameSite=Lax (Secure on HTTPS sites). Only a hash of the session token is stored.
//
// Security rules kept here (plan §I1, §I2, §I4):
// - D1 platform admins: an account may open /admin and /admin/business only when its email is listed in
//   ADMIN_EMAILS AND it has an active platform_admin record for the same email. Records come from the boot
//   seed or from scripts/platform-admin.js. The seed is a one-time migration: the first boot writes the
//   grandfather list (the listed accounts created before ADMIN_SEED_BEFORE) and later boots grant only
//   accounts on it, so adding an address to ADMIN_EMAILS later never makes an old account an admin without
//   a grant. Signing up with a listed address after the cutoff gives nothing, and removing an address from
//   ADMIN_EMAILS revokes on restart.
// - D2 sign-up race: the user is written first and the email is then claimed insert-only; the loser of a
//   race deletes its user and gets email_taken, so two accounts never share an email and a crash leaves at
//   most an orphan user nobody can sign in to.
// - I4 sessions: a session records when it was issued; an account's sessionsValidAfter (set when it is
//   signed out everywhere) ends every session issued before it. Without it, every session counts as before.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { AppError } = require('../lib/errors');
const { id } = require('../lib/ids');
const { str, EMAIL } = require('../lib/validate');
const { readCookies } = require('../lib/cookies');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'txs';
const SESSION_DAYS = 30;
/** Platform admin records (D1): one per user id, owned by that user. */
const PLATFORM_ADMIN = 'platform_admin';
/** Who granted a platform admin record. */
const GRANTED_BY = Object.freeze(['legacy-email-match', 'cli', 'test']);
/** How an account proved its email at sign-up (D5): an invite link sent to that address. */
const EMAIL_PROOF_VIA = Object.freeze(['invite']);
/**
 * D1 grandfather cutoff: an ADMIN_EMAILS account created before this moment gets its platform_admin record
 * at boot (once). Fixed on purpose: there is no environment override.
 */
const ADMIN_SEED_BEFORE = '2026-10-08T00:00:00Z';
/**
 * The grandfather list (D1): one record, `platform_admin_seed` / 'v1', written insert-only by the first
 * seedPlatformAdmins ({ userIds, at, before, rev }). It holds the user ids of the ADMIN_EMAILS accounts created
 * before ADMIN_SEED_BEFORE at that first boot, and no boot after it grants anyone else.
 */
const ADMIN_SEED = 'platform_admin_seed';
const ADMIN_SEED_ID = 'v1';
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const derived = await scrypt(password, Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(key, 'base64');
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

class Accounts {
  constructor({ store, config, now = () => new Date() }) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  /**
   * Is this account a platform admin (it may open /admin and /admin/business)? D1: its email is listed in
   * ADMIN_EMAILS and a platform_admin record exists for this user id with the same email and no revokedAt.
   * One extra read, only for listed emails.
   * @param {{ id: string, email: string }|null} user
   * @returns {Promise<boolean>}
   */
  async isPlatformAdmin(user) {
    if (!user || typeof user.id !== 'string' || !user.id || !listedAdminEmail(this.config, user)) return false;
    return activeAdminRecord(await this.store.getRecord(PLATFORM_ADMIN, user.id), user);
  }

  /**
   * At boot, give each grandfathered ADMIN_EMAILS account its platform_admin record (D1), once. The first
   * call writes the grandfather list (insert-only): the listed accounts created before ADMIN_SEED_BEFORE at
   * that moment. Every call then grants a record to the listed accounts on that list that have never had
   * one, so a crash halfway is finished at the next boot. "Never" matters: a record that was revoked stays
   * revoked. An account that is not on the list is never seeded, even one created before the cutoff whose
   * address is added to ADMIN_EMAILS later: it needs scripts/platform-admin.js grant. Idempotent, and safe
   * when several servers boot at once (both writes are insert-only).
   * Logs "[admin] platform admin: <user id> (o***@example.com), account created <date>, name "<name>"" for
   * every listed account that is a platform admin (the id, masked email and date say which account it is; the
   * name, the account's own choice, comes last, quoted and escaped by quoteName), and "[admin] ADMIN_EMAILS
   * entry with no admin record: o***@example.com" for the rest.
   * @param {{ log?: { info?: Function, warn?: Function } }} [opts]
   * @returns {Promise<{ granted: string[], missing: string[] }>} user ids granted now, and masked emails with no record
   */
  async seedPlatformAdmins({ log } = {}) {
    const info = log && typeof log.info === 'function' ? m => log.info(m) : () => {};
    const warn = log && typeof log.warn === 'function' ? m => log.warn(m) : () => {};
    const listed = [];
    for (const email of [...new Set(this.config.trips.adminEmails)]) listed.push([email, await userByEmail(this.store, email)]);
    const onList = new Set(seedIds(await grandfatherList(this.store, this.now, listed.map(([, user]) => user))));
    const granted = [], missing = [];
    for (const [email, user] of listed) {
      let record = user ? await this.store.getRecord(PLATFORM_ADMIN, user.id) : null;
      if (user && !record && onList.has(user.id) && createdBeforeCutoff(user)) {
        const doc = {
          userId: user.id, email: user.email, grantedAt: this.now().toISOString(), grantedBy: 'legacy-email-match',
          revokedAt: null, note: `ADMIN_EMAILS account created before ${ADMIN_SEED_BEFORE}`, rev: 0,
        };
        if (await this.store.insertRecord(PLATFORM_ADMIN, user.id, doc, { userId: user.id })) granted.push(user.id);
        record = await this.store.getRecord(PLATFORM_ADMIN, user.id);
      }
      if (user && activeAdminRecord(record, user)) {
        info(`[admin] platform admin: ${user.id} (${maskEmail(user.email)}), account created ${String(user.createdAt).slice(0, 10)}, name ${quoteName(user.name)}`);
      } else {
        missing.push(maskEmail(email));
        warn(`[admin] ADMIN_EMAILS entry with no admin record: ${maskEmail(email)}`);
      }
    }
    return { granted, missing };
  }

  /**
   * Make an account a platform admin: insert its platform_admin record, or re-grant a revoked one (or one
   * whose email changed) by compare-and-set. Idempotent for an active record with the same email. It does
   * not check ADMIN_EMAILS (scripts/platform-admin.js does); isPlatformAdmin needs both.
   * @param {string} userId
   * @param {{ by: 'legacy-email-match'|'cli'|'test', note?: string }} opts
   * @returns {Promise<object>} the platform_admin record
   */
  async grantPlatformAdmin(userId, { by, note = '' } = {}) {
    if (!GRANTED_BY.includes(by)) throw new Error(`[accounts] grantPlatformAdmin needs by: ${GRANTED_BY.join(' | ')}`);
    const user = typeof userId === 'string' && userId ? await this.store.getRecord('user', userId) : null;
    if (!user) throw new AppError('not_found', 'No account with that id.', 404);
    const record = { userId: user.id, email: user.email, grantedAt: this.now().toISOString(), grantedBy: by, revokedAt: null, note: str(note, 200) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.store.insertRecord(PLATFORM_ADMIN, user.id, { ...record, rev: 0 }, { userId: user.id })) {
        return this.store.getRecord(PLATFORM_ADMIN, user.id);
      }
      const cur = await this.store.getRecord(PLATFORM_ADMIN, user.id);
      if (!cur) continue;
      if (cur.revokedAt === null && cur.email === user.email) return cur;
      const written = await this.store.updateRecord(PLATFORM_ADMIN, user.id, cur.rev ?? 0, record);
      if (written) return written;
    }
    throw new AppError('conflict', 'Someone else just changed this. Try again.', 409);
  }

  /**
   * Take platform admin away from an account: set revokedAt on its record by compare-and-set (the record
   * stays, for the history). An account with no record gets a revoked one (insert-only), so the boot seed
   * can never grant it later; only a grant makes it an admin again. Idempotent.
   * @param {string} userId
   * @returns {Promise<object|null>} the record, or null when there is no such account
   */
  async revokePlatformAdmin(userId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cur = typeof userId === 'string' && userId ? await this.store.getRecord(PLATFORM_ADMIN, userId) : null;
      if (!cur) {
        const user = typeof userId === 'string' && userId ? await this.store.getRecord('user', userId) : null;
        if (!user) return null;
        const at = this.now().toISOString();
        const doc = {
          userId: user.id, email: user.email, grantedAt: at, grantedBy: 'cli', revokedAt: at,
          note: 'Revoked before any grant, so the boot seed never grants it', rev: 0,
        };
        if (await this.store.insertRecord(PLATFORM_ADMIN, user.id, doc, { userId: user.id })) return this.store.getRecord(PLATFORM_ADMIN, user.id);
        continue;
      }
      if (cur.revokedAt) return cur;
      const { rev, ...rest } = cur;
      const written = await this.store.updateRecord(PLATFORM_ADMIN, userId, rev ?? 0, { ...rest, revokedAt: this.now().toISOString() });
      if (written) return written;
    }
    throw new AppError('conflict', 'Someone else just changed this. Try again.', 409);
  }

  /**
   * Create an account.
   * @param {{ name: string, email: string, password: string }} input
   * @param {{ emailProof?: { via: 'invite', orgId: string, at: string }|null }} [opts] how the email was proven
   *   (D5: an invite link sent to it); stored on the user when given
   * @returns {Promise<object>} the user record
   */
  async register({ name, email, password }, { emailProof = null } = {}) {
    const u = { name: str(name, 80), email: str(email, 120).toLowerCase() };
    const errors = {};
    if (!u.name) errors.name = 'Enter your name.';
    if (!EMAIL.test(u.email)) errors.email = 'Enter a valid email address.';
    if (typeof password !== 'string' || password.length < 10) errors.password = 'Use at least 10 characters.';
    else if (password.length > 200) errors.password = 'That password is too long.';
    if (Object.keys(errors).length) throw new AppError('invalid_account', 'Check the highlighted fields.', 422, errors);
    // A fast pre-check; the insert-only claim below is what decides a race (D2).
    if (await this.store.getRecord('user_email', u.email)) throw emailTaken();
    const proof = emailProof === null || emailProof === undefined ? null : checkEmailProof(emailProof);
    const user = { id: id('usr'), ...u, passwordHash: await hashPassword(password), profile: {}, createdAt: this.now().toISOString() };
    if (proof) user.emailProof = proof;
    // The user first, then the email link insert-only: whoever inserts the link owns the email. Writing the
    // link first could point it at a user that never gets written, which would lock the email forever.
    await this.store.putRecord('user', user.id, user, { userId: user.id });
    let claimed;
    try {
      claimed = await this.store.insertRecord('user_email', u.email, { userId: user.id });
    } catch (e) {
      await this.store.deleteRecord('user', user.id).catch(() => false);
      throw e;
    }
    if (!claimed) {
      // Another sign-up claimed the email between the pre-check and here: drop this account.
      await this.store.deleteRecord('user', user.id).catch(() => false);
      throw emailTaken();
    }
    return user;
  }

  /**
   * Does an account already use this email? The same lookup register's email_taken check and authenticate
   * make (lib/validate str, at most 120 characters, lowercased). The Business invite landing no longer asks it
   * (a signed-out landing is always 'join'); never answer it to anyone but the holder of an invite for this
   * address.
   * @param {unknown} email
   * @returns {Promise<boolean>}
   */
  async emailInUse(email) {
    const key = str(email, 120).toLowerCase();
    if (!key) return false;
    return !!(await this.store.getRecord('user_email', key));
  }

  async authenticate({ email, password }) {
    const fail = new AppError('invalid_login', 'That email and password don’t match an account.', 401);
    const link = await this.store.getRecord('user_email', str(email, 120).toLowerCase());
    // Hash anyway when the account doesn't exist, so timing doesn't reveal which emails are registered.
    if (!link) { await verifyPassword(String(password || ''), 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='); throw fail; }
    const user = await this.store.getRecord('user', link.userId);
    if (!user || !(await verifyPassword(String(password || ''), user.passwordHash))) throw fail;
    return user;
  }

  async createSession(res, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString();
    // issuedAt lets signing an account out everywhere (sessionsValidAfter) end this session (I4).
    await this.store.putRecord('session', sha256(token), { userId: user.id, issuedAt: now.toISOString(), expiresAt }, { userId: user.id });
    const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
    if (this.config.httpsOnly) attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  }

  async endSession(req, res) {
    const token = readCookies(req)[SESSION_COOKIE];
    if (token) await this.store.deleteRecord('session', sha256(token));
    res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.httpsOnly ? '; Secure' : ''}`);
  }

  async userFromRequest(req) {
    const token = readCookies(req)[SESSION_COOKIE];
    if (!token || token.length > 100) return null;
    const s = await this.store.getRecord('session', sha256(token));
    if (!s || new Date(s.expiresAt) < this.now()) return null;
    const user = await this.store.getRecord('user', s.userId);
    if (!user || !sessionCurrent(s, user)) return null;
    const { passwordHash, ...safe } = user; // eslint-disable-line no-unused-vars
    return { ...safe, isAdmin: await this.isPlatformAdmin(user) };
  }

  /**
   * Sign an account out everywhere (I4): set its sessionsValidAfter to now, so every session issued before
   * this moment stops counting (scripts/platform-admin.js revoke --sign-out). The user record is written by
   * compare-and-set, like updateProfile, so neither can drop the other's change.
   * @param {string} userId
   * @returns {Promise<string|null>} the sessionsValidAfter written, or null when there is no such account
   */
  async endAllSessions(userId) {
    const at = this.now().toISOString();
    const written = await this.casUser(userId, user => ({ ...user, sessionsValidAfter: at }));
    return written ? at : null;
  }

  async updateProfile(userId, profile) {
    const written = await this.casUser(userId, user => ({ ...user, profile: { ...(user.profile || {}), ...profile } }));
    return written ? written.profile : null;
  }

  // Read the user, apply fn to it and write it back by compare-and-set on its rev (a record without one
  // counts as 0), retrying a few times when another write got there first. Null when the user is missing.
  async casUser(userId, fn) {
    if (typeof userId !== 'string' || !userId) return null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const user = await this.store.getRecord('user', userId);
      if (!user) return null;
      const rev = Number.isInteger(user.rev) ? user.rev : 0;
      const { rev: _rev, ...next } = fn(user); // eslint-disable-line no-unused-vars
      const written = await this.store.updateRecord('user', userId, rev, next);
      if (written) return written;
    }
    throw new AppError('conflict', 'Someone else just changed this. Try again.', 409);
  }
}

const emailTaken = () => new AppError('email_taken', 'An account with this email already exists. Sign in instead.', 409, { email: 'An account with this email already exists.' });

// D1, the allow-list half: is this account's email listed in ADMIN_EMAILS? Never enough on its own to let
// anyone in, so it is not a method: isPlatformAdmin (and req.user.isAdmin) is the only admin check.
function listedAdminEmail(config, user) {
  return !!user && typeof user.email === 'string' && config.trips.adminEmails.includes(user.email);
}

const createdBeforeCutoff = user => Date.parse(user.createdAt) < Date.parse(ADMIN_SEED_BEFORE);
const seedIds = seed => (seed && Array.isArray(seed.userIds) ? seed.userIds.filter(x => typeof x === 'string') : []);

// The grandfather list (D1): read it, or write it the first time from these accounts (the listed ones that
// exist; those created before the cutoff go on it) and read back whichever list won when several servers
// boot at once.
async function grandfatherList(store, now, users) {
  const current = await store.getRecord(ADMIN_SEED, ADMIN_SEED_ID);
  if (current) return current;
  const userIds = [...new Set(users.filter(u => u && createdBeforeCutoff(u)).map(u => u.id))];
  const doc = { userIds, at: now().toISOString(), before: ADMIN_SEED_BEFORE, rev: 0 };
  await store.insertRecord(ADMIN_SEED, ADMIN_SEED_ID, doc, { userId: null });
  return store.getRecord(ADMIN_SEED, ADMIN_SEED_ID);
}

/**
 * Would the next boot's seedPlatformAdmins give this account a platform_admin record (D1)? Only when it
 * has none and is on the grandfather list, or, before any boot has written that list, when it was created
 * before ADMIN_SEED_BEFORE (that boot reads ADMIN_EMAILS then; the caller checks the address is listed).
 * Reads only. For scripts/platform-admin.js list.
 * @param {object} store
 * @param {{ id: string, createdAt: string }|null} user
 * @returns {Promise<boolean>}
 */
async function seedPending(store, user) {
  if (!user || typeof user.id !== 'string' || !user.id || !createdBeforeCutoff(user)) return false;
  if (await store.getRecord(PLATFORM_ADMIN, user.id)) return false;
  const seed = await store.getRecord(ADMIN_SEED, ADMIN_SEED_ID);
  return !seed || seedIds(seed).includes(user.id);
}

// D1: a platform_admin record that still makes this account an admin: for this user id, for the account's
// current email, and not revoked.
function activeAdminRecord(record, user) {
  return !!record && record.userId === user.id && record.email === user.email && (record.revokedAt === null || record.revokedAt === undefined);
}

// The account an email belongs to (the same lookup authenticate makes), or null. Accounts-internal: Business
// asks emailInUse and never sees a user record.
async function userByEmail(store, email) {
  const key = str(email, 120).toLowerCase();
  if (!key) return null;
  const link = await store.getRecord('user_email', key);
  const user = link && typeof link.userId === 'string' && link.userId ? await store.getRecord('user', link.userId) : null;
  return user && user.email === key ? user : null;
}

// I4: does this session still count for this account? Always, when the account was never signed out
// everywhere. Otherwise only when it was issued at or after sessionsValidAfter; a session with no issuedAt
// (made before sessions recorded it) or an unreadable date counts as issued before.
function sessionCurrent(session, user) {
  if (user.sessionsValidAfter === undefined || user.sessionsValidAfter === null) return true;
  const issued = Date.parse(session.issuedAt), after = Date.parse(user.sessionsValidAfter);
  return Number.isFinite(issued) && Number.isFinite(after) && issued >= after;
}

/**
 * A name (the account's own choice, typed at sign-up) as it goes into a log or CLI line: in double quotes, with
 * JSON's escapes plus every character that could end the line or hide or reorder text in a terminal or log
 * viewer (DEL and C1 controls, soft hyphen, line and paragraph separators, bidirectional and zero-width marks)
 * written as \uXXXX. So a name can never read as the fixed fields printed before it.
 * @param {string} name
 * @returns {string}
 */
function quoteName(name) {
  return JSON.stringify(String(name ?? '')).replace(/[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * An email as the logs show it: the first character, then "***@" and the domain ("o***@example.com").
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '***';
  return `${Array.from(s)[0]}***${s.slice(at)}`;
}

// The emailProof register() stores: { via, orgId, at } with known values only (a programming error otherwise).
function checkEmailProof(p) {
  const ok = p && typeof p === 'object' && !Array.isArray(p) && EMAIL_PROOF_VIA.includes(p.via)
    && typeof p.orgId === 'string' && /^org_[A-Za-z0-9_-]{16}$/.test(p.orgId) && typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at));
  if (!ok) throw new Error('[accounts] emailProof must be { via: \'invite\', orgId, at }');
  return { via: p.via, orgId: p.orgId, at: p.at };
}

// Visitor id for the analytics funnel: random, first-party, no personal data (see the cookie policy).
// Pages set it; API and asset responses only read it (pass res = null), so they never add cookies.
function visitorId(req, res, config) {
  const v = readCookies(req).txv;
  if (v && /^[A-Za-z0-9_-]{16,40}$/.test(v)) return v;
  if (!res) return null;
  const nv = crypto.randomBytes(12).toString('base64url');
  res.append('Set-Cookie', `txv=${nv}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}${config.httpsOnly ? '; Secure' : ''}`);
  return nv;
}

module.exports = {
  Accounts, visitorId, hashPassword, verifyPassword, maskEmail, quoteName, seedPending,
  SESSION_COOKIE, PLATFORM_ADMIN, GRANTED_BY, ADMIN_SEED_BEFORE, ADMIN_SEED, ADMIN_SEED_ID,
};
