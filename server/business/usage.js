// The persisted daily caps on live supplier calls (go-live design §5.5; owner decision D2-1). Live mode only:
// suppliers/gate.js asks take() before every attempt it sends (a retry is a call too), so every Duffel call
// (offer requests, GET offers, the admin's live check) and every LiteAPI rates call counts.
//
// - Per supplier and UTC day: 100 calls for one company and 500 for all companies together (SUPPLIER_CAPS).
//   The admin's live check counts as the company 'platform'; a call with no company in scope as 'unscoped'.
// - Persisted: one biz_supplier_usage record per day and supplier (Repo.reserveSupplierUsage, compare-and-set),
//   so a deploy or a restart does not reset the count. This task counts ahead in blocks of 10 for each company
//   and spends them from memory; what a task had counted ahead and not spent when it stops stays counted, so
//   the stored count can run ahead of the calls made, never behind them.
// - Over a cap: 429 supplier_daily_limit, naming when search opens again (the next 00:00 UTC) in the
//   company's own time zone. A store that cannot be read or written fails closed: 503 supplier_unavailable.
// The hourly per-company limit (120 an hour) stays in memory, in gate.js.
const tz = require('./tz');
const { supplierError } = require('./source');
const { SUPPLIER_CAPS } = require('./constants');

const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPLIERS = Object.freeze(['duffel', 'liteapi']);
const COMPANY_RE = /^org_[A-Za-z0-9_-]{16}$/;

/** The UTC day of an instant: 'YYYY-MM-DD'. */
const utcDay = date => date.toISOString().slice(0, 10);

/** When the UTC day of `date` ends: the next 00:00 UTC, as an ISO string. */
const nextUtcMidnight = date => new Date(Date.parse(`${utcDay(date)}T00:00:00.000Z`) + DAY_MS).toISOString();

/** 'Africa/Cairo' → 'Cairo time', 'UTC' → 'UTC' (the words views/business/format.js uses). */
function zoneLabel(zone) {
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  return `${zone.split('/').pop().replace(/_/g, ' ')} time`;
}

/**
 * When search opens again, in a time zone: "2:00 AM tomorrow (Cairo time)", "7:00 PM today (Los Angeles time)".
 * @param {string} iso the instant
 * @param {string|null} zone an IANA zone (anything Intl doesn't know reads as UTC)
 * @param {Date} now
 * @returns {string}
 */
function opensAtText(iso, zone, now) {
  const z = typeof zone === 'string' && tz.isTimeZone(zone) ? zone : 'UTC';
  const local = tz.utcToLocal(z, iso);
  const h = Number(local.slice(11, 13));
  const time = `${((h + 11) % 12) + 1}:${local.slice(14, 16)} ${h < 12 ? 'AM' : 'PM'}`;
  const day = tz.localDate(z, iso), today = tz.localDate(z, now);
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  const rel = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : `on ${day}`;
  return `${time} ${rel} (${zoneLabel(z)})`;
}

/** The usage record key of a scope: its company id, 'platform', or 'unscoped'. */
function companyKey(scope) {
  const id = scope && typeof scope.orgId === 'string' ? scope.orgId : null;
  if (id === 'platform') return 'platform';
  return id && COMPANY_RE.test(id) ? id : 'unscoped';
}

class SupplierUsage {
  /**
   * @param {{ repo: import('./repo').Repo, now: () => Date, log?: object,
   *   caps?: { company: number, total: number, block: number, noticeShare: number } }} deps
   */
  constructor({ repo, now, log = console, caps = SUPPLIER_CAPS } = {}) {
    if (!repo || typeof repo.reserveSupplierUsage !== 'function' || typeof now !== 'function') throw new TypeError('[business] SupplierUsage needs a repo and a clock');
    this.repo = repo;
    this.now = now;
    this.log = log;
    this.caps = caps;
    /** @type {Map<string, number>} 'day|supplier|company' → calls counted ahead and not spent yet */
    this.held = new Map();
    /** @type {Map<string, Promise<object>>} one reservation at a time per key */
    this.pending = new Map();
  }

  /**
   * Count one call to `supplier` for the scope's company, or refuse it.
   * @param {'duffel'|'liteapi'} supplier
   * @param {{ orgId: string, timezone?: string|null }|null} scope scope.currentScope()
   * @param {'flights'|'hotels'} vertical whose sentence a store failure gives
   * @returns {Promise<void>}
   * @throws {AppError} 429 supplier_daily_limit; 503 supplier_unavailable
   */
  async take(supplier, scope, vertical) {
    if (!SUPPLIERS.includes(supplier)) throw supplierError('supplier_unavailable', { vertical });
    const company = companyKey(scope);
    for (let round = 0; round < 6; round += 1) {
      const now = this.now();
      const day = utcDay(now);
      this._forgetBefore(day);
      const key = `${day}|${supplier}|${company}`;
      const held = this.held.get(key) || 0;
      if (held > 0) {
        this.held.set(key, held - 1);
        return;
      }
      const waiting = this.pending.get(key);
      if (waiting) {
        await waiting.catch(() => {});
        continue;
      }
      const reservation = this.repo.reserveSupplierUsage({ day, supplier, company, want: this.caps.block, caps: this.caps });
      this.pending.set(key, reservation);
      let r;
      try {
        r = await reservation;
      } catch {
        this.log.warn(`[suppliers] ${supplier}: the daily call count could not be read or written, so the call was not made`);
        throw supplierError('supplier_unavailable', { vertical });
      } finally {
        this.pending.delete(key);
      }
      if (!r.granted) {
        throw supplierError('supplier_daily_limit', { limit: r.limit, opensAt: opensAtText(nextUtcMidnight(now), scope && scope.timezone, now) });
      }
      this.held.set(key, (this.held.get(key) || 0) + r.granted);
    }
    throw supplierError('supplier_unavailable', { vertical });
  }

  /**
   * Give back a call take() counted that was then not sent (the gate refused it after all). It stays in this
   * task's block, so the stored count is unchanged.
   * @param {'duffel'|'liteapi'} supplier
   * @param {{ orgId: string }|null} scope
   */
  giveBack(supplier, scope) {
    const key = `${utcDay(this.now())}|${supplier}|${companyKey(scope)}`;
    this.held.set(key, (this.held.get(key) || 0) + 1);
  }

  /**
   * Today's counts for /admin/business: per supplier the calls counted against the total cap, and whether
   * the 80% notice applies.
   * @returns {Promise<{ day: string, opensAt: string, caps: object, suppliers: Record<string, { total: number,
   *   cap: number, share: number, notice: boolean }> }>}
   */
  async today() {
    const now = this.now();
    const day = utcDay(now);
    const records = await this.repo.supplierUsage(day);
    const suppliers = {};
    for (const s of SUPPLIERS) {
      const total = records[s] && Number.isInteger(records[s].total) ? records[s].total : 0;
      suppliers[s] = { total, cap: this.caps.total, share: total / this.caps.total, notice: total >= this.caps.total * this.caps.noticeShare };
    }
    return { day, opensAt: nextUtcMidnight(now), caps: { company: this.caps.company, total: this.caps.total, block: this.caps.block }, suppliers };
  }

  /** Drop what was held for earlier days (a new UTC day starts a new count). */
  _forgetBefore(day) {
    for (const k of this.held.keys()) if (k.slice(0, 10) < day) this.held.delete(k);
  }
}

module.exports = { SupplierUsage, opensAtText, nextUtcMidnight, utcDay, companyKey };
