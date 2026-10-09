// The company a request runs for, carried through every awaited call (real-suppliers design §4.3).
// http.memberGate wraps its final next() in withCompany(org.id, ...), so the service, the composer and a
// supplier adapter several awaits later still know which company a supplier call is for: the per-company
// supplier limit (suppliers/gate.js) and the per-company result cache (suppliers/cache.js) key on it.
// A supplier call outside any scope (a script, a mistaken path) reads null and goes to one small shared
// "unscoped" bucket, so a mistake fails closed. Round 2's webhooks and booking job set the scope themselves.
//
// Lives outside business/suppliers/ on purpose: nothing but inventory.js (and tests) may require the
// suppliers, and http.js needs this module.
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Run `fn` with `orgId` as the current company (for everything it awaits too).
 * @template T
 * @param {string} orgId a company id (org_…)
 * @param {() => T} fn
 * @returns {T} what fn returns
 * @throws {TypeError} for an id that is not a company id (a programming error)
 */
function withCompany(orgId, fn) {
  if (typeof orgId !== 'string' || !ORG_ID_RE.test(orgId)) throw new TypeError('[business] withCompany needs a company id');
  if (typeof fn !== 'function') throw new TypeError('[business] withCompany needs a function');
  return storage.run(Object.freeze({ orgId }), fn);
}

/**
 * The company the current call runs for.
 * @returns {string|null} null outside any withCompany()
 */
function currentCompany() {
  const s = storage.getStore();
  return s ? s.orgId : null;
}

module.exports = { withCompany, currentCompany };
