// Who may call a supplier, and when (real-suppliers design §4.3). http.js asks the gate before every attempt
// and tells it how each one went.
//
// In order, for every call:
//   0. live mode only (`confirmedOnly`): the scope must say the company is confirmed (memberGate sets it from
//      the company's status; the admin's live check runs as 'platform', confirmed). Anything else, a call with
//      no company in scope included, is refused before any count → 503 'supplier_unavailable' (go-live §5.5:
//      only confirmed companies make supplier calls; the service says why first, this only fails closed);
//   1. the company (scope.currentCompany()): at most `companyPerHour` (120) supplier calls an hour and
//      `companyPerMinute` (20) in any minute, all suppliers and call types together, counted once per
//      operation (a retry is not a second call) → 429 'supplier_busy'. With no company in scope (a script, a
//      mistaken path) the call goes to one shared unscoped bucket of 10 an hour and a warning is logged once,
//      so a mistake fails closed → 503 'supplier_unavailable';
//   2. the supplier's circuit breaker: 5 failures (timeouts, connection errors, 429 and 5xx) within 60 s open
//      it for 30 s → 503;
//   3. Duffel's own rate-limit headers: when `ratelimit-remaining` is 0, nothing is sent until
//      `ratelimit-reset`, an RFC 2616 HTTP-date ("Tue, 24 Nov 2020 08:22:00 GMT", D-ERR), compared with the
//      injected wall clock at 1-second resolution and clamped to 0 to 60 s (a reset that doesn't parse falls
//      back to the bucket);
//   4. the supplier's global token bucket: Duffel 60 a minute with a burst of 10, LiteAPI's sandbox 4 a second
//      (documented 5). Each caller reserves its own token, so concurrent calls queue fairly.
//   Live mode only, before the bucket: the persisted daily caps (`usage`, business/usage.js), asked for
//   every attempt (a retry is a call too) → 429 'supplier_daily_limit'. A call the bucket then refuses is
//   given back.
// A wait in 3 or 4 longer than `maxWaitMs` (2 s) answers 503 at once: never demo data, never a stale answer.
// The counters live in memory, per task, like limits.js: a restart resets them (the daily caps excepted).
// Buckets and windows run on a monotonic clock (`mono`, milliseconds), not the business clock, which tests
// hold still.
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { currentCompany, currentScope } = require('../scope');
const { supplierError } = require('../source');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Each supplier's global bucket (design §4.3). */
const BUCKETS = Object.freeze({
  duffel: Object.freeze({ capacity: 10, perSecond: 1 }),
  liteapi: Object.freeze({ capacity: 4, perSecond: 4 }),
});
const BREAKER = Object.freeze({ failures: 5, windowMs: 60 * SECOND, openMs: 30 * SECOND });
const RESET_MAX_MS = 60 * SECOND;

/** sha256(orgId) cut to 8 hex characters: the company as a log line names it. */
const companyTag = orgId => (orgId ? crypto.createHash('sha256').update(orgId, 'utf8').digest('hex').slice(0, 8) : null);

/**
 * When Duffel's rate limit opens again, from its headers.
 * @param {{ get: (name: string) => string|null }|null} headers
 * @param {Date} now the wall clock
 * @returns {number|null} milliseconds to wait (0 to 60 000, whole seconds) when ratelimit-remaining is 0 and
 *   ratelimit-reset parses; null otherwise
 */
function duffelResetWait(headers, now) {
  if (!headers || typeof headers.get !== 'function') return null;
  const remaining = headers.get('ratelimit-remaining');
  if (remaining === null || String(remaining).trim() !== '0') return null;
  const reset = Date.parse(String(headers.get('ratelimit-reset') || ''));
  if (!Number.isFinite(reset)) return null;
  const wait = Math.ceil((reset - now.getTime()) / SECOND) * SECOND;
  return Math.min(RESET_MAX_MS, Math.max(0, wait));
}

class TokenBucket {
  constructor({ capacity, perSecond, mono }) {
    this.capacity = capacity;
    this.perMs = perSecond / SECOND;
    this.mono = mono;
    this.tokens = capacity;
    this.at = mono();
  }

  _refill() {
    const t = this.mono();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.at) * this.perMs);
    this.at = t;
  }

  /** Reserve a token: milliseconds until it is usable (0 now). */
  reserve() {
    this._refill();
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : Math.ceil(-this.tokens / this.perMs);
  }

  /** Give a reserved token back (the caller won't wait for it). */
  release() {
    this.tokens = Math.min(this.capacity, this.tokens + 1);
  }
}

class Gate {
  /**
   * @param {{ now: () => Date, log?: object, mono?: () => number, sleep?: (ms: number) => Promise<void>,
   *   companyPerHour?: number, companyPerMinute?: number, unscopedPerHour?: number, maxWaitMs?: number,
   *   buckets?: object, breaker?: object, usage?: { take: Function, giveBack: Function }|null,
   *   confirmedOnly?: boolean }} opts usage and confirmedOnly: live mode (see the header)
   */
  constructor({
    now, log = console, mono = () => performance.now(), sleep = null, companyPerHour = 120, companyPerMinute = 20,
    unscopedPerHour = 10, maxWaitMs = 2 * SECOND, buckets = BUCKETS, breaker = BREAKER, usage = null, confirmedOnly = false,
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('[suppliers] the gate needs a clock');
    this.now = now;
    this.log = log;
    this.mono = mono;
    // A held timer (at most maxWaitMs): an operation waiting its turn keeps a script alive until it is answered.
    this.sleep = sleep || (ms => new Promise(r => { setTimeout(r, ms); }));
    this.companyPerHour = companyPerHour;
    this.companyPerMinute = companyPerMinute;
    this.unscopedPerHour = unscopedPerHour;
    this.maxWaitMs = maxWaitMs;
    this.usage = usage && typeof usage.take === 'function' ? usage : null;
    this.confirmedOnly = confirmedOnly === true;
    this.warnedUnconfirmed = false;
    this.breakerRule = breaker;
    this.buckets = Object.fromEntries(Object.entries(buckets).map(([s, b]) => [s, new TokenBucket({ ...b, mono })]));
    /** @type {Map<string, number[]>} company → call times (monotonic), newest last, at most companyPerHour */
    this.companies = new Map();
    this.unscoped = [];
    this.warnedUnscoped = false;
    this.failures = {};
    this.openUntil = {};
    this.blockedUntil = {};
  }

  _window(list, t) {
    while (list.length && list[0] <= t - HOUR) list.shift();
    return list;
  }

  /** Throws supplier_busy (or, unscoped, supplier_unavailable) when the caller has no calls left. */
  _checkCaller(vertical, t) {
    const org = currentCompany();
    if (!org) {
      if (!this.warnedUnscoped) {
        this.warnedUnscoped = true;
        this.log.warn('[suppliers] a supplier call ran outside any company scope; it uses the small shared unscoped limit');
      }
      if (this._window(this.unscoped, t).length >= this.unscopedPerHour) throw supplierError('supplier_unavailable', { vertical });
      return () => this.unscoped.push(t);
    }
    const list = this._window(this.companies.get(org) || [], t);
    const lastMinute = list.filter(x => x > t - MINUTE).length;
    if (list.length >= this.companyPerHour || lastMinute >= this.companyPerMinute) throw supplierError('supplier_busy');
    return () => {
      list.push(t);
      this.companies.set(org, list);
    };
  }

  /**
   * Wait until `supplier` may be called, or throw.
   * @param {'duffel'|'liteapi'} supplier
   * @param {{ vertical: 'flights'|'hotels', first?: boolean }} opts first: the operation's first attempt (it
   *   counts against the company); a retry only passes the breaker, the headers and the bucket
   * @returns {Promise<void>}
   * @throws {AppError} 429 supplier_busy; 429 supplier_daily_limit (live); 503 supplier_unavailable
   */
  async admit(supplier, { vertical, first = true } = {}) {
    const unavailable = () => supplierError('supplier_unavailable', { vertical });
    const scope = currentScope();
    if (this.confirmedOnly && !(scope && scope.confirmed === true)) {
      if (!this.warnedUnconfirmed) {
        this.warnedUnconfirmed = true;
        this.log.warn('[suppliers] a live supplier call for a company that is not confirmed (or none) was refused');
      }
      throw unavailable();
    }
    const t = this.mono();
    const count = first ? this._checkCaller(vertical, t) : null;
    if ((this.openUntil[supplier] || 0) > t) throw unavailable();
    const blocked = (this.blockedUntil[supplier] || 0) - t;
    if (blocked > this.maxWaitMs) throw unavailable();
    if (blocked > 0) await this.sleep(blocked);
    if (this.usage) await this.usage.take(supplier, scope, vertical);
    const bucket = this.buckets[supplier];
    if (bucket) {
      const wait = bucket.reserve();
      if (wait > this.maxWaitMs) {
        bucket.release();
        if (this.usage) this.usage.giveBack(supplier, scope);
        throw unavailable();
      }
      if (wait > 0) await this.sleep(wait);
    }
    if (count) count();
  }

  /**
   * How an attempt went: failures feed the breaker; Duffel's headers may hold the next calls back.
   * @param {'duffel'|'liteapi'} supplier
   * @param {{ failure: boolean, headers?: { get: Function }|null }} outcome
   */
  record(supplier, { failure, headers = null }) {
    const t = this.mono();
    if (failure) {
      const list = (this.failures[supplier] || []).filter(x => x > t - this.breakerRule.windowMs);
      list.push(t);
      this.failures[supplier] = list;
      if (list.length >= this.breakerRule.failures) {
        this.openUntil[supplier] = t + this.breakerRule.openMs;
        this.failures[supplier] = [];
        this.log.warn(`[suppliers] ${supplier}: ${this.breakerRule.failures} failures in a minute, calls paused for ${this.breakerRule.openMs / SECOND} s`);
      }
    }
    if (supplier === 'duffel') {
      const wait = duffelResetWait(headers, this.now());
      if (wait !== null) this.blockedUntil[supplier] = Math.max(this.blockedUntil[supplier] || 0, t + wait);
    }
  }

  /** Is the breaker open for `supplier` right now? */
  isOpen(supplier) {
    return (this.openUntil[supplier] || 0) > this.mono();
  }
}

module.exports = { Gate, TokenBucket, BUCKETS, BREAKER, duffelResetWait, companyTag };
