// Public Business routes and the workspace entry (plan §B4 "Public" and "Workspace entry", §B7). Paths are
// relative to MOUNT ('/business'); GET /business is the company page in pagesRouter, never defined here.
//
//   GET  /start                  anyone  -                         sign-up (signed out or signed in)
//   POST /start                  anyone  bizAuthIp                 accounts.register (signed out) → session →
//                                                                  svc.createCompany → 303 /o/:id/welcome
//   GET  /signin                 anyone  -                         "Sign in to your company"; next via safeLocal
//   POST /signin                 anyone  bizAuthIp, bizAuthAccount (after the form) → 303 next or /business/app
//   POST /signout                user    bizWrite                  303 /business (or a /business next)
//   GET  /invite/:token          anyone  -                         svc.inviteByToken; Referrer-Policy no-referrer; 410 page
//   POST /invite/:token/accept   user    bizAuthIp                 svc.acceptInvite → 303 /o/:id
//   POST /invite/:token/join     anyone  bizAuthIp                 register with emailProof → session → acceptInvite → 303
//   GET  /app                    user    -                         0 companies: create; 1: 303 to it; 2+: cards
//
// Every route is mounted from TABLE by mountTable(), which builds the chain from the RouteEntry itself, so the
// Express stack and ROUTES cannot disagree: a GET runs the gate then the handler; a POST runs its limiters →
// sameOrigin → the form parser → (bizAuthAccount, which keys on the parsed email) → the gate → the handler.
// The gate for 'anyone' is noStore (Cache-Control no-store, X-Robots-Tag noindex); 'user' adds requireUser.
// Every public page also sends Referrer-Policy no-referrer (an invite token can sit in the URL or in next):
// bizPublicHeaders runs first in every chain, so the app's 403, 429 and 4xx pages carry it too.
//
// A double-clicked or resubmitted form never does its work twice. POST /start runs one at a time per account
// (per email when signed out) and per invite token for /join, in this process. Signed in, a company the same
// account created under the same name in the last 10 minutes is answered with a 303 to its welcome page
// instead of a second company. Signed out, the losing submit finds the email taken: when the posted password
// is that account's and it has just created that company, it is signed in and sent to the same page (no
// password is checked otherwise, so the 409 stays the answer for any other existing account). A /join whose
// invite was just used by this process with the posted password signs in and opens the workspace.
// The /o/:orgId home and /o/:orgId/policy are in traveler.js (2B); /o/:orgId/welcome is in admin.js (2A).
const crypto = require('node:crypto');
const express = require('express');
const { AppError } = require('../../lib/errors');
const { str, EMAIL } = require('../../lib/validate');
const { gates: makeGates } = require('../../business/http');
const { send, clientError, routesOf, mountTable, publicHeaders, bizPublicHeaders } = require('./table');
const { safeLocal, text, oneOf, collect } = require('../../business/validate');
const { COMPANY_SIZES, TIMEZONES, DEFAULT_TIMEZONE, signupAck } = require('../../business/constants');
const { startView, signinView } = require('../../views/business/auth');
const { inviteView, inviteProblemView, GONE } = require('../../views/business/invite');
const { chooserView } = require('../../views/business/chooser');

// ---------------------------------------------------------------------------------------------------------
// Helpers

/**
 * A same-site path under /business to land on after signing in or out, or null. The path is resolved the way
 * a browser resolves it (dot segments, also as %2e, and backslashes), and the resolved path is both what is
 * checked and what is returned, so "/business/../admin" can't step out of /business.
 */
function businessNext(n) {
  const p = safeLocal(typeof n === 'string' ? n : null, null);
  if (!p) return null;
  const base = 'http://next.invalid';
  let u;
  try {
    u = new URL(p, base);
  } catch {
    return null;
  }
  if (u.origin !== base) return null;
  if (u.pathname !== '/business' && !u.pathname.startsWith('/business/')) return null;
  return u.pathname + u.search;
}

/** A company name's key as team.js keeps it (letters and digits, lowercased): "Acme, Inc." and "acme inc" match. */
const nameKeyOf = name => String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** How long a just-made company or a just-used invite answers a resubmitted form as done. */
const RESUBMIT_MS = 10 * 60 * 1000;

/**
 * Run fn for one key at a time, in this process: a second submit of the same form waits until the first has
 * finished, so it sees what the first one did.
 */
function serialized() {
  const tails = new Map();
  return async function serial(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    let done;
    const mine = new Promise(resolve => { done = resolve; });
    tails.set(key, mine);
    try {
      await prev;
      return await fn();
    } finally {
      done();
      if (tails.get(key) === mine) tails.delete(key);
    }
  };
}

/** The signed-in user as routes and the service see it (no password hash). */
function publicUser(u) {
  const { passwordHash, ...rest } = u || {}; // eslint-disable-line no-unused-vars
  return { ...rest, isAdmin: rest.isAdmin === true };
}

// ---------------------------------------------------------------------------------------------------------
// The table

const TABLE = [
  { method: 'GET', path: '/start', perm: null, own: false, limiter: [], who: 'anyone', handler: 'startPage' },
  { method: 'POST', path: '/start', perm: null, own: false, limiter: ['bizAuthIp'], who: 'anyone', handler: 'startPost' },
  { method: 'GET', path: '/signin', perm: null, own: false, limiter: [], who: 'anyone', handler: 'signinPage' },
  { method: 'POST', path: '/signin', perm: null, own: false, limiter: ['bizAuthIp', 'bizAuthAccount'], who: 'anyone', handler: 'signinPost' },
  { method: 'POST', path: '/signout', perm: null, own: false, limiter: ['bizWrite'], who: 'user', handler: 'signout' },
  { method: 'GET', path: '/invite/:token', perm: null, own: false, limiter: [], who: 'anyone', handler: 'invitePage' },
  { method: 'POST', path: '/invite/:token/accept', perm: null, own: false, limiter: ['bizAuthIp'], who: 'user', handler: 'acceptPost' },
  { method: 'POST', path: '/invite/:token/join', perm: null, own: false, limiter: ['bizAuthIp'], who: 'anyone', handler: 'joinPost' },
  { method: 'GET', path: '/app', perm: null, own: false, limiter: [], who: 'user', handler: 'appPage' },
];

/** This router's routes (types.RouteEntry). */
const ROUTES = routesOf(TABLE);

// ---------------------------------------------------------------------------------------------------------
// Sign-up checks made before an account exists (the service checks everything again)

const fieldError = message => new AppError('invalid_field', message, 422);
const NAME_MESSAGE = "Enter your company's name.";
const SIZE_MESSAGE = "Choose your company's size.";
/** A signed-in sign-up that carries another email (a form opened while signed out, sent after signing in). */
const signedInAsText = email => `You're signed in as ${email}. Sign out to create the company with a new account.`;

/**
 * The company fields' messages, keyed as createCompany keys them ({} when they look right). `status`: the
 * Business inventory's, so the consent error matches the box the page showed (constants.SIGNUP_ACK).
 */
function companyProblems(c, status) {
  try {
    collect('invalid_company', {
      name: () => {
        if (typeof c.name !== 'string' || !c.name.trim()) throw fieldError(NAME_MESSAGE);
        const s = text(c.name, 80, { required: true });
        if (s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').includes('tripelyx')) throw fieldError("Choose your own company's name.");
        return s;
      },
      size: () => {
        if (!COMPANY_SIZES.includes(c.size)) throw fieldError(SIZE_MESSAGE);
        return c.size;
      },
      timezone: () => oneOf(c.timezone, TIMEZONES, { blank: DEFAULT_TIMEZONE }),
      ack: () => { if (c.ack !== '1') throw fieldError(signupAck(status).error); return true; },
    });
    return {};
  } catch (e) {
    if (e instanceof AppError && e.code === 'invalid_company') return e.details || {};
    throw e;
  }
}

/** The account fields' messages, as accounts.register words them ({} when they look right). */
function accountProblems(b) {
  const out = {};
  if (!str(b.name, 80)) out.name = 'Enter your name.';
  if (!EMAIL.test(str(b.email, 120).toLowerCase())) out.email = 'Enter a valid email address.';
  if (typeof b.password !== 'string' || b.password.length < 10) out.password = 'Use at least 10 characters.';
  else if (b.password.length > 200) out.password = 'That password is too long.';
  return out;
}

const tooManyText = max => `You're already in ${max} ${max === 1 ? 'company' : 'companies'}, the most one account can join for now.`;
const one = v => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------------------------------------------------

/**
 * @param {object} ctx the app context
 * @param {import('../../business/types').RouterDeps} deps
 * @returns {import('express').Router}
 */
function router(ctx, deps) {
  const r = express.Router();
  const svc = ctx.business;
  const accounts = ctx.accounts;
  const biz = ctx.config.business;
  const g = makeGates(ctx);

  const gate = row => (row.who === 'user' ? [publicHeaders, g.requireUser] : [publicHeaders]);
  const serial = serialized();
  /** Invites this process just used through /join: sha256(token) → { email, orgId, until (ms) }. */
  const joined = new Map();
  const tokenKey = token => crypto.createHash('sha256').update(String(token)).digest('hex');
  const nowMs = () => ctx.now().getTime();

  /** The sign-up form's values to show again (never the password). */
  const startValues = b => ({
    name: str(b.name, 80), email: str(b.email, 120), companyName: str(b.companyName, 80), size: one(b.size), timezone: one(b.timezone), ack: b.ack === '1' ? '1' : '',
  });

  async function capFor(user) {
    const companies = await svc.listCompaniesFor({ user });
    return companies.length >= biz.maxOrgsPerUser ? tooManyText(biz.maxOrgsPerUser) : null;
  }

  /** A company this account created under the same name in the last RESUBMIT_MS (a resubmitted form), or null. */
  async function justCreated(user, companyName) {
    const key = nameKeyOf(companyName);
    if (!key) return null;
    for (const c of await svc.listCompaniesFor({ user })) {
      if (c.role !== 'owner' || nameKeyOf(c.name) !== key) continue;
      let org;
      try {
        org = await svc.getOrg({ org: { id: c.id }, user });
      } catch (e) {
        if (clientError(e)) continue;
        throw e;
      }
      const age = nowMs() - Date.parse(org.at);
      if (org.createdBy === user.id && age >= 0 && age < RESUBMIT_MS) return org;
    }
    return null;
  }

  /** Remember an invite used through /join, for a second submit of the same form (bounded, short-lived). */
  function rememberJoin(token, email, orgId) {
    const now = nowMs();
    for (const [k, v] of joined) if (v.until <= now || joined.size > 500) joined.delete(k);
    joined.set(tokenKey(token), { email, orgId, until: now + RESUBMIT_MS });
  }

  /**
   * A signed-out sign-up whose email was taken by the same form a moment ago: the posted password is that
   * account's and it created this company in the last RESUBMIT_MS. Returns { user, org } or null (then the
   * page answers 409 as for any existing account; a wrong password changes nothing).
   */
  async function sameSubmit(b) {
    let user;
    try {
      user = publicUser(await accounts.authenticate({ email: b.email, password: b.password }));
    } catch (e) {
      if (clientError(e)) return null;
      throw e;
    }
    const org = await justCreated(user, b.companyName);
    return org ? { user, org } : null;
  }

  /** The invite landing again, for the current visitor, or the problem page when it can't be shown. */
  async function landing(req, res, opts = {}) {
    const token = req.params.token;
    let view;
    try {
      view = await svc.inviteByToken({ user: req.user || null }, token);
    } catch (e) {
      return inviteProblem(req, res, e);
    }
    const status = opts.status ?? (view.state === 'pending_company' ? 409 : 200);
    return send(res, status, inviteView(ctx, { landing: view, token, user: req.user || null, ...opts }));
  }

  function inviteProblem(req, res, e) {
    if (!clientError(e)) throw e;
    const user = req.user || null;
    if (e.code === 'org_suspended') return send(res, 403, inviteProblemView(ctx, { title: 'This company is paused', message: e.message, user }));
    if (e.status === 410 || e.status === 404) return send(res, 410, inviteProblemView(ctx, { message: GONE, user }));
    return send(res, e.status, inviteProblemView(ctx, { message: e.message, user }));
  }

  /** POST /invite/:token/join, one at a time per token. */
  async function join(req, res, token) {
    const b = req.body || {};
    let view;
    try {
      view = await svc.inviteByToken({ user: null }, token);
    } catch (e) {
      // The same form sent twice: this process just used the invite with this password.
      const memo = clientError(e) && e.status === 410 ? joined.get(tokenKey(token)) : null;
      if (memo && memo.until > nowMs()) {
        try {
          const user = await accounts.authenticate({ email: memo.email, password: b.password });
          await accounts.createSession(res, user);
          return res.redirect(303, `/business/o/${memo.orgId}`);
        } catch (err) {
          if (!clientError(err)) throw err;
        }
      }
      return inviteProblem(req, res, e);
    }
    if (view.state !== 'join') return send(res, view.state === 'pending_company' ? 409 : 200, inviteView(ctx, { landing: view, token }));
    const values = { name: str(b.name, 80) };
    let user;
    try {
      user = publicUser(await accounts.register(
        { name: b.name, email: view.invite.email, password: b.password },
        { emailProof: { via: 'invite', orgId: view.org.id, at: ctx.now().toISOString() } },
      ));
    } catch (e) {
      if (!clientError(e)) throw e;
      if (e.code === 'email_taken') return send(res, 409, inviteView(ctx, { landing: view, token, emailTaken: true, values }));
      return send(res, e.status, inviteView(ctx, { landing: view, token, values, errors: e.details || {}, error: e.message }));
    }
    await accounts.createSession(res, user);
    try {
      const { org } = await svc.acceptInvite({ user }, token);
      rememberJoin(token, view.invite.email, org.id);
      return res.redirect(303, `/business/o/${org.id}`);
    } catch (e) {
      if (!clientError(e)) throw e;
      // The account exists and is signed in now: show the landing as they see it from here on.
      req.user = user;
      if (e.code === 'invite_gone' || e.code === 'org_suspended' || e.status === 404) return inviteProblem(req, res, e);
      return landing(req, res, { error: e.message, status: e.status });
    }
  }

  const handlers = {
    async startPage(req, res) {
      const user = req.user || null;
      send(res, 200, startView(ctx, { user, atCap: user ? await capFor(user) : null, selfServe: biz.selfServe }));
    },

    async startPost(req, res) {
      const b = req.body || {};
      const values = startValues(b);
      const company = { name: b.companyName, size: b.size, timezone: b.timezone, ack: b.ack };
      const signedIn = req.user || null;
      const postedEmail = str(b.email, 120).toLowerCase();
      if (signedIn && postedEmail && postedEmail !== String(signedIn.email || '').toLowerCase()) {
        return send(res, 409, startView(ctx, { user: signedIn, values, error: signedInAsText(signedIn.email), selfServe: biz.selfServe }));
      }
      const companyErrors = companyProblems(company, svc.inventory ? svc.inventory.status : null);
      const accountErrors = signedIn ? {} : accountProblems(b);
      if (Object.keys(companyErrors).length || Object.keys(accountErrors).length) {
        return send(res, 422, startView(ctx, { user: signedIn, values, accountErrors, companyErrors, error: 'Check the highlighted fields.', selfServe: biz.selfServe }));
      }
      return serial(signedIn ? `u:${signedIn.id}` : `e:${postedEmail}`, async () => {
        let user = signedIn;
        let accountReady = false;
        if (!user) {
          try {
            user = publicUser(await accounts.register({ name: b.name, email: b.email, password: b.password }));
          } catch (e) {
            if (!clientError(e)) throw e;
            if (e.code === 'email_taken') {
              // The same form sent twice: the first submit made this account and company a moment ago.
              const again = await sameSubmit(b);
              if (again) {
                await accounts.createSession(res, again.user);
                return res.redirect(303, `/business/o/${again.org.id}/welcome`);
              }
              return send(res, 409, startView(ctx, { values, emailTaken: true, accountErrors: { email: 'An account with this email already exists.' }, selfServe: biz.selfServe }));
            }
            return send(res, e.status, startView(ctx, { values, accountErrors: e.details || {}, error: e.message, selfServe: biz.selfServe }));
          }
          await accounts.createSession(res, user);
          accountReady = true;
        } else {
          const org = await justCreated(user, company.name);
          if (org) return res.redirect(303, `/business/o/${org.id}/welcome`);
        }
        try {
          const { org } = await svc.createCompany({ user }, company);
          return res.redirect(303, `/business/o/${org.id}/welcome`);
        } catch (e) {
          if (!clientError(e)) throw e;
          const atCap = e.code === 'too_many_companies' ? e.message : null;
          return send(res, e.status, startView(ctx, {
            user, values, companyErrors: e.details || {}, error: atCap ? null : e.message, accountReady, atCap, selfServe: biz.selfServe,
          }));
        }
      });
    },

    async signinPage(req, res) {
      const next = businessNext(req.query.next);
      if (req.user) return res.redirect(303, next || '/business/app');
      send(res, 200, signinView(ctx, { next, invite: !!next && next.startsWith('/business/invite/') }));
    },

    async signinPost(req, res) {
      const b = req.body || {};
      const next = businessNext(b.next);
      try {
        const user = await accounts.authenticate({ email: b.email, password: b.password });
        await accounts.createSession(res, user);
        return res.redirect(303, next || '/business/app');
      } catch (e) {
        if (!clientError(e)) throw e;
        // A failed sign-in answers 4xx, so bizAuthAccount (skipSuccessfulRequests) counts it.
        return send(res, e.status, signinView(ctx, { values: { email: str(b.email, 120) }, error: e.message, next, invite: !!next && next.startsWith('/business/invite/') }));
      }
    },

    async signout(req, res) {
      await accounts.endSession(req, res);
      res.redirect(303, businessNext(req.body && req.body.next) || '/business');
    },

    async invitePage(req, res) {
      return landing(req, res);
    },

    async acceptPost(req, res) {
      try {
        const { org } = await svc.acceptInvite({ user: req.user }, req.params.token);
        return res.redirect(303, `/business/o/${org.id}`);
      } catch (e) {
        if (!clientError(e)) throw e;
        if (e.code === 'invite_gone' || e.code === 'org_suspended' || e.status === 404) return inviteProblem(req, res, e);
        return landing(req, res, { error: e.message, status: e.status });
      }
    },

    async joinPost(req, res) {
      const token = req.params.token;
      // Signed in: the landing offers the accept form (or explains why not).
      if (req.user) return res.redirect(303, `/business/invite/${encodeURIComponent(token)}`);
      return serial(`t:${tokenKey(token)}`, () => join(req, res, token));
    },

    async appPage(req, res) {
      const user = req.user;
      const companies = await svc.listCompaniesFor({ user });
      const admin = user.isAdmin === true;
      if (companies.length === 1 && !admin) return res.redirect(303, `/business/o/${companies[0].id}`);
      let waiting = null;
      if (admin) {
        try {
          waiting = (await svc.platformListOrgs({ user })).orgs.filter(o => o.status === 'pending').length;
        } catch (e) {
          if (!clientError(e)) throw e;
        }
      }
      send(res, 200, chooserView(ctx, { user, companies, max: biz.maxOrgsPerUser, waiting }));
    },
  };

  return mountTable(r, TABLE, { deps, gate, handlers, headers: bizPublicHeaders });
}

module.exports = { router, ROUTES };
