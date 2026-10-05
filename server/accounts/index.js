// Customer accounts: email + password (scrypt), server-side sessions in the store, and a session cookie
// that is HttpOnly and SameSite=Lax (Secure on HTTPS sites). Only a hash of the session token is stored.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { AppError } = require('../lib/errors');
const { id } = require('../lib/ids');
const { str, EMAIL } = require('../lib/validate');
const { readCookies } = require('../lib/cookies');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'txs';
const SESSION_DAYS = 30;
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

  isAdmin(user) {
    return !!user && this.config.trips.adminEmails.includes(user.email);
  }

  async register({ name, email, password }) {
    const u = { name: str(name, 80), email: str(email, 120).toLowerCase() };
    const errors = {};
    if (!u.name) errors.name = 'Enter your name.';
    if (!EMAIL.test(u.email)) errors.email = 'Enter a valid email address.';
    if (typeof password !== 'string' || password.length < 10) errors.password = 'Use at least 10 characters.';
    else if (password.length > 200) errors.password = 'That password is too long.';
    if (Object.keys(errors).length) throw new AppError('invalid_account', 'Check the highlighted fields.', 422, errors);
    if (await this.store.getRecord('user_email', u.email)) {
      throw new AppError('email_taken', 'An account with this email already exists. Sign in instead.', 409, { email: 'An account with this email already exists.' });
    }
    const user = { id: id('usr'), ...u, passwordHash: await hashPassword(password), profile: {}, createdAt: this.now().toISOString() };
    await this.store.putRecord('user', user.id, user, { userId: user.id });
    await this.store.putRecord('user_email', u.email, { userId: user.id });
    return user;
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
    const expiresAt = new Date(this.now().getTime() + SESSION_DAYS * 86400000).toISOString();
    await this.store.putRecord('session', sha256(token), { userId: user.id, expiresAt }, { userId: user.id });
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
    if (!user) return null;
    const { passwordHash, ...safe } = user; // eslint-disable-line no-unused-vars
    return { ...safe, isAdmin: this.isAdmin(user) };
  }

  async updateProfile(userId, profile) {
    const user = await this.store.getRecord('user', userId);
    if (!user) return null;
    user.profile = { ...(user.profile || {}), ...profile };
    await this.store.putRecord('user', userId, user, { userId });
    return user.profile;
  }
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

module.exports = { Accounts, visitorId, hashPassword, verifyPassword, SESSION_COOKIE };
