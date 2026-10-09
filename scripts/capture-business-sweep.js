#!/usr/bin/env node
// Walks every Tripelyx Business page www serves (go-live design §5.2, stage L2), as every role of two seeded
// companies, a stranger, a person in both companies and the platform admin, and records each answer's status,
// content type, redirect and the sha256 of its normalised body. test/business-unset-sweep.test.js compares
// www as built now, with both supplier key secrets holding "unset", against the record of 49a9ccb (stage L0,
// before live search) in test/fixtures/golive/business-none-49a9ccb.json.
//
// Usage: node scripts/capture-business-sweep.js <root of the site> <env name: l0|unset> [out file] [label]
//   <root> is a whole copy of the site with its test folder (for 49a9ccb: `git archive 49a9ccb | tar -x`),
//   and node_modules next to it. The site at <root> runs in this process on a fresh MemoryStore, its world
//   seeded by <root>'s own test/business-world.js, the app's clock and the global Date held at FIXED_NOW.
//   The fixture was written with: node scripts/capture-business-sweep.js <export of 49a9ccb> l0
//   test/fixtures/golive/business-none-49a9ccb.json 49a9ccb
//
// Normalising changes only what differs between two runs of the same code: the ?v= cache-buster and the year
// (capture-baseline's normalise), and the random ids and invite tokens the seed makes, each replaced by a name
// for what it is (ORG_ACME, USER_ACME_OWNER, DEP_ACME_1, INVITE_ACME, ...). An id the seed doesn't name becomes
// ID_<prefix>_<n>, numbered in order of first appearance on that page.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const FIXED_NOW = '2026-10-09T09:00:00.000Z';

/**
 * The www task's settings: the live baseline env set with Business on (infra/app.yaml).
 * l0: as at 49a9ccb (no supplier settings). unset: as at L2, both key secrets still holding "unset".
 */
function envs(root) {
  const { ENVS } = require(path.join(root, 'scripts/capture-baseline'));
  const l0 = Object.freeze({ ...ENVS.live, ENABLE_BUSINESS: 'true', BUSINESS_DEMO_INVENTORY: 'false' });
  const unset = Object.freeze({
    ...l0, BUSINESS_FLIGHT_SUPPLIER: 'duffel', BUSINESS_HOTEL_SUPPLIER: 'liteapi', BUSINESS_SUPPLIER_LIVE: 'true',
    BUSINESS_ALLOW_SUPPLIER_TEST: 'false', DUFFEL_ACCESS_TOKEN: 'unset', LITEAPI_API_KEY: 'unset',
  });
  return { l0, unset };
}

/** The workspace pages each crawl starts from (test/business-golive.test.js seedsFor, with each ?ok= notice). */
function seedsFor(b) {
  return [
    b, `${b}/welcome`, `${b}/trips`, `${b}/trips?scope=team`, `${b}/trips?scope=all`, `${b}/trips/new`, `${b}/approvals`,
    `${b}/approvals?tab=decided`, `${b}/approvals?tab=company`, `${b}/approvals?tab=expired`, `${b}/approvals?ok=returned`,
    `${b}/policy`, `${b}/policies`, `${b}/policies?ok=handling`, `${b}/policies/standard`, `${b}/policies/standard?ok=saved`,
    `${b}/policies/standard?ok=unchanged`, `${b}/policies/director`, `${b}/policies/executive`, `${b}/policies/standard/history`,
    `${b}/budgets`, `${b}/budgets?ok=budget`, `${b}/budgets?period=2026-Q3`, `${b}/people`,
    ...['revoked', 'member', 'removed', 'department', 'archived'].map(ok => `${b}/people?ok=${ok}`),
    `${b}/reports`, `${b}/activity`, `${b}/settings`, `${b}/settings?ok=saved`, `${b}/settings?ok=renamed`,
    `${b}/trips/search?from=CAI&to=LHR&depart=2026-11-12&return=2026-11-16&hotel=1&cabin=economy`,
    `${b}/trips/search?from=CAI&to=LHR&depart=2026-11-12&cabin=business`,
  ];
}

/** Names for every id and token the seed made: [value, name], longest first. */
function namesOf(w) {
  const out = [[w.ops.user.id, 'USER_OPS'], [w.both.user.id, 'USER_PATBOTH']];
  for (const C of [w.A, w.B]) {
    const word = C.word.toUpperCase();
    out.push([C.id, `ORG_${word}`], [C.invite.token, `INVITE_${word}`]);
    if (C.invite.invite && C.invite.invite.publicId) out.push([C.invite.invite.publicId, `INVITEID_${word}`]);
    if (C.general) out.push([C.general, `DEP_${word}_GENERAL`]);
    C.deps.forEach((d, i) => out.push([d.id, `DEP_${word}_${i + 1}`]));
    for (const [role, p] of Object.entries(C.people)) out.push([p.user.id, `USER_${word}_${role.toUpperCase()}`]);
  }
  return out.filter(([v]) => typeof v === 'string' && v.length >= 8).sort((a, b) => b[0].length - a[0].length);
}

const ID_RE = /\b(usr|org|dep|btr|aud|inv)_[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/g;

/**
 * Walks www's Business pages on the site at `root` with `env`.
 * @param {string} root
 * @param {object} env
 * @param {{ adjust?: (key: string, text: string) => string }} [opts] adjust: changes a page's normalised text
 *   before it is hashed (the test takes out a part only the new site has, after checking it)
 * @returns {Promise<{ status: string, pages: Record<string, string> }>} status: the inventory's; pages: who and
 *   which page → "<status> <content type> <redirect or -> <sha256 of the normalised body>"
 */
async function sweep(root, env, { adjust = null } = {}) {
  const { normalise, freezeDate } = require(path.join(root, 'scripts/capture-baseline'));
  const { world, crawl } = require(path.join(root, 'test/business-world'));
  const restore = freezeDate(FIXED_NOW);
  const w = await world({ production: true, env });
  try {
    const names = namesOf(w);
    const clean = text => {
      let s = normalise(text);
      for (const [v, name] of names) s = s.split(v).join(name);
      const seen = new Map();
      return s.replace(ID_RE, (m, prefix) => {
        if (!seen.has(m)) seen.set(m, `ID_${prefix}_${seen.size + 1}`);
        return seen.get(m);
      });
    };
    const pages = {};
    const keep = who => (url, res) => {
      const type = ((res.headers && res.headers.get('content-type')) || '').split(';')[0];
      const key = `${who} ${clean(url)}`;
      const text = adjust ? adjust(key, clean(res.text)) : clean(res.text);
      // One line per answer: "<status> <content type> <redirect or -> <sha256 of the normalised body>".
      pages[key] = [res.status, type || '-', res.location ? clean(res.location) : '-', crypto.createHash('sha256').update(text, 'utf8').digest('hex')].join(' ');
    };
    for (const C of [w.A, w.B]) {
      for (const [role, p] of Object.entries(C.people)) await crawl(p.http, seedsFor(C.B), { cap: 600, onPage: keep(`${C.word} ${role}`) });
    }
    const publicUrls = ['/business', '/business/start', '/business/signin', '/business/app', `/business/invite/${w.A.invite.token}`,
      '/business/invite/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '/business/no-such-page', '/business/o/org_AAAAAAAAAAAAAAAA',
      w.A.B, w.B.B, `${w.B.B}/settings`, '/admin/business', '/admin/business/no-such-page', '/admin/business?ok=active',
      '/admin/business?ok=suspended', ...[w.A, w.B].flatMap(C => ['active', 'suspended'].map(ok => `/admin/business?ok=${ok}&org=${C.id}`))];
    for (const [who, h] of [['stranger', w.http('')], ['Pat Both', w.both.http], ['platform admin', w.ops.http], ['Acme employee', w.A.people.employee.http]]) {
      await crawl(h, publicUrls, { cap: 600, onPage: keep(who) });
    }
    // The platform admin's own pages, every link under /admin/business they lead to.
    await crawl(w.ops.http, ['/admin/business'], { cap: 600, prefix: '/admin/business', onPage: keep('platform admin') });
    // With no supplier a trip request answers the trip form with "Supplier not connected yet" (503).
    for (const C of [w.A, w.B]) {
      const res = await C.people.employee.http.post(`${C.B}/trips`, { purpose: 'Visit', from: 'CAI', to: 'LHR', depart: '2026-11-12' });
      keep(`${C.word} employee`)(`POST ${C.B}/trips`, res);
    }
    return { status: w.svc.inventory.status, pages };
  } finally {
    await w.close();
    restore();
  }
}

module.exports = { sweep, envs, seedsFor, FIXED_NOW };

if (require.main === module) {
  const [rootArg, envName, outArg, label] = process.argv.slice(2);
  if (!rootArg || !['l0', 'unset'].includes(envName)) {
    process.stderr.write('Usage: node scripts/capture-business-sweep.js <root> <l0|unset> [out file] [label]\n');
    process.exit(2);
  }
  const root = path.resolve(rootArg);
  sweep(root, envs(root)[envName]).then(({ status, pages }) => {
    const out = JSON.stringify({ site: label || null, env: envName, status, count: Object.keys(pages).length, pages }, null, 1);
    if (outArg) fs.writeFileSync(outArg, `${out}\n`);
    else process.stdout.write(`${out}\n`);
    process.exit(0);
  }, e => {
    process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
  });
}
