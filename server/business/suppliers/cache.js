// The short supplier result cache (real-suppliers design §4.4): per company, with a time to live, least
// recently used first out, and single-flight (two identical searches at once share one supplier call).
//
// - Keys are always (company, key): one company can never read, or learn from timing, what another searched.
//   The adapters build `key` from the supplier, the mode and the normalised query.
// - Bounded three ways: entries per company (default 20), entries in all (500) and bytes in all (32 MB,
//   each entry measured as the JSON byte length of its value when stored). This process also serves the
//   consumer site, so the cache must not grow with response size. A value larger than the whole byte
//   budget is not stored.
// - Values are the adapters' own normalised data (never a raw supplier body); they are plain JSON and are
//   never handed out to callers (the adapters build fresh offers from them).
// - Time comes from the injected wall clock `now` (so a test's moving clock moves the expiry too).

const MB = 1024 * 1024;

class SupplierCache {
  /**
   * @param {{ now: () => Date, maxEntries?: number, maxPerCompany?: number, maxBytes?: number }} opts
   */
  constructor({ now, maxEntries = 500, maxPerCompany = 20, maxBytes = 32 * MB } = {}) {
    if (typeof now !== 'function') throw new TypeError('[suppliers] the cache needs a clock');
    this.now = now;
    this.maxEntries = maxEntries;
    this.maxPerCompany = maxPerCompany;
    this.maxBytes = maxBytes;
    /** @type {Map<string, { company: string, value: unknown, expires: number, bytes: number }>} oldest first */
    this.entries = new Map();
    this.perCompany = new Map();
    this.bytes = 0;
    this.inflight = new Map();
  }

  static id(company, key) {
    if (typeof company !== 'string' || !company || typeof key !== 'string' || !key) throw new TypeError('[suppliers] a cache key needs a company and a key');
    return `${company}\u0000${key}`;
  }

  _t() { return this.now().getTime(); }

  _drop(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.bytes -= e.bytes;
    const n = (this.perCompany.get(e.company) || 1) - 1;
    if (n > 0) this.perCompany.set(e.company, n); else this.perCompany.delete(e.company);
  }

  /**
   * The value stored for (company, key), while it is still valid; refreshes its place in the LRU order.
   * @returns {unknown|undefined}
   */
  get(company, key) {
    const id = SupplierCache.id(company, key);
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.expires <= this._t()) { this._drop(id); return undefined; }
    this.entries.delete(id);
    this.entries.set(id, e);
    return e.value;
  }

  /**
   * Store a value for ttlMs milliseconds.
   * @param {string} company
   * @param {string} key
   * @param {unknown} value plain JSON
   * @param {number} ttlMs ≤ 0 stores nothing
   * @returns {boolean} whether it was stored
   */
  set(company, key, value, ttlMs) {
    const id = SupplierCache.id(company, key);
    this._drop(id);
    if (!(Number.isFinite(ttlMs) && ttlMs > 0)) return false;
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > this.maxBytes) return false;
    const now = this._t();
    // Expired entries go first, then the company's oldest, then the oldest anywhere.
    for (const [k, e] of this.entries) if (e.expires <= now) this._drop(k);
    while ((this.perCompany.get(company) || 0) >= this.maxPerCompany) {
      const oldest = [...this.entries].find(([, e]) => e.company === company);
      if (!oldest) break;
      this._drop(oldest[0]);
    }
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes)) {
      this._drop(this.entries.keys().next().value);
    }
    this.entries.set(id, { company, value, expires: now + ttlMs, bytes });
    this.perCompany.set(company, (this.perCompany.get(company) || 0) + 1);
    this.bytes += bytes;
    return true;
  }

  /** Forget (company, key). */
  delete(company, key) {
    this._drop(SupplierCache.id(company, key));
  }

  /**
   * Single-flight: while a load for (company, key) is running, every other caller gets the same promise.
   * The loader stores what it wants itself (set); the shared promise ends when it does.
   * @template T
   * @param {string} company
   * @param {string} key
   * @param {() => Promise<T>} loader
   * @returns {Promise<T>}
   */
  once(company, key, loader) {
    const id = SupplierCache.id(company, key);
    const running = this.inflight.get(id);
    if (running) return running;
    const p = (async () => {
      try { return await loader(); } finally { this.inflight.delete(id); }
    })();
    this.inflight.set(id, p);
    return p;
  }

  /** @returns {{ entries: number, bytes: number, companies: number }} */
  stats() {
    return { entries: this.entries.size, bytes: this.bytes, companies: this.perCompany.size };
  }
}

module.exports = { SupplierCache, MB };
