// The requests CSV (plan §H6): POST /o/:orgId/reports/export (reports.export) answers it as an attachment
// with Cache-Control no-store. BusinessService method exportCsv plus the pure CSV helpers.
//
// - UTF-8 with a BOM, CRLF line ends, every cell quoted when it holds a comma, quote, CR or LF.
// - Cells starting with = + - @, a tab or a CR get a ' prefix (formula injection guard).
// - Times are local to the company's time zone ('YYYY-MM-DD HH:MM'); money in dollars with 2 decimals.
// - Never a supplier cost, net rate, commission, markup, provider name or `internal` field.
// - When the 5,000-request scan (constants.SCAN_CAP) is hit, a last note row says so.

const { AppError } = require('../lib/errors');
const tz = require('./tz');
const { KINDS, SCAN_CAP, CURRENCY, REQUEST_STATUSES } = require('./constants');
const { loadActor, need, who, auditInsert } = require('./actor');
const { USER_ID_RE } = require('./repo');
const { periodKey, periodLabel, currentPeriodKey, PERIOD_KEY_RE } = require('./budgets');

/** The columns, in order. price_source is always 'Demo price'; currency always 'USD'. */
const CSV_COLUMNS = Object.freeze([
  'price_source', 'request_id', 'created_local', 'traveler', 'department', 'from', 'to', 'depart_date', 'return_date',
  'hotel_city', 'nights', 'status', 'approval_mode', 'approver', 'decided_local', 'policy_status', 'policy_reasons',
  'total_usd', 'cheapest_in_policy_usd', 'saved_by_switching_usd', 'currency',
]);
/** The first cell of every data row. */
const PRICE_SOURCE = 'Demo price';
/** The byte-order mark the file starts with. */
const BOM = '﻿';

/**
 * One cell, guarded and quoted.
 * @param {string|number|null|undefined} value null/undefined → ''
 * @returns {string}
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A whole CSV body: BOM, header row, data rows, CRLF line ends.
 * @param {string[]} columns
 * @param {Array<Array<string|number|null>>} rows
 * @returns {string}
 */
function toCsv(columns, rows) {
  return `${BOM}${[columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * One request as a row of CSV_COLUMNS.
 * @param {import('./types').Request} request
 * @param {{ timezone: string, status: import('./types').EffectiveStatus, departmentName: string|null,
 *   approverName: string|null }} ctx
 * @returns {Array<string|number|null>}
 */
function requestRow(request, ctx) {
  const r = request;
  const c = ctx || {};
  const timezone = c.timezone || 'UTC';
  const hotel = r.rows && r.rows.hotel ? r.rows.hotel : null;
  const swapped = Array.isArray(r.history) && r.history.some(h => h && h.action === 'swapped');
  const saved = swapped && Number.isInteger(r.originalTotalCents) && r.originalTotalCents > r.totalCents ? r.originalTotalCents - r.totalCents : 0;
  const violations = r.evaluation && Array.isArray(r.evaluation.violations) ? r.evaluation.violations : [];
  return [
    PRICE_SOURCE,
    r.id,
    localTime(timezone, r.at),
    r.travelerName,
    c.departmentName ?? '',
    r.query.from,
    r.query.to,
    r.query.departDate,
    r.query.returnDate ?? '',
    hotel ? hotel.city : '',
    hotel ? hotel.nights : '',
    c.status ?? r.status,
    r.approval ? r.approval.mode : '',
    c.approverName ?? '',
    r.approval && r.approval.decidedAt ? localTime(timezone, r.approval.decidedAt) : '',
    r.evaluation ? r.evaluation.status : '',
    violations.map(v => v.text).filter(t => typeof t === 'string' && t).join('; '),
    dollars(r.totalCents),
    r.cheapestWithin ? dollars(r.cheapestWithin.totalCents) : '',
    dollars(saved),
    r.currency || CURRENCY,
  ];
}

// ---------------------------------------------------------------------------------------------------------
// Service side

const DEPARTMENT_ID_RE = /^dep_[A-Za-z0-9_-]{16}$/;
const EFFECTIVE_STATUSES = Object.freeze([...REQUEST_STATUSES, 'past']);
/** The last row when the scan stopped at SCAN_CAP. */
const TRUNCATED_NOTE = `Based on the ${SCAN_CAP.toLocaleString('en-US')} most recent requests. Narrow the filters to export the rest.`;

/** 'YYYY-MM-DD HH:MM' in the company's time zone ('' for a missing time). */
function localTime(timezone, iso) {
  return typeof iso === 'string' && iso ? tz.utcToLocal(timezone, iso).replace('T', ' ') : '';
}
/** Whole cents as dollars with 2 decimals ('1240.00'); '' for a missing amount. */
function dollars(cents) {
  if (!Number.isInteger(cents)) return '';
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The export filters, checked (422 'invalid_filter' with details by field). Blank period = the current one. */
function exportFilters(org, filters, now) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const details = {};
  const pick = (name, ok, message) => {
    const v = f[name];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !ok(v)) { details[name] = message; return null; }
    return v;
  };
  const out = {
    period: pick('period', v => PERIOD_KEY_RE.test(v), 'Choose a period like 2026-Q4.'),
    departmentId: pick('departmentId', v => DEPARTMENT_ID_RE.test(v), 'Choose a department from the list.'),
    status: pick('status', v => EFFECTIVE_STATUSES.includes(v), 'Choose a status from the list.'),
    travelerId: pick('travelerId', v => USER_ID_RE.test(v), 'Choose a traveler from the list.'),
  };
  if (Object.keys(details).length) throw new AppError('invalid_filter', 'Check the highlighted fields.', 422, details);
  out.period = out.period || currentPeriodKey(org, now);
  return out;
}

/** Every member of the company by user id (paged; active and removed, for names). */
async function allMembers(repo, orgId) {
  const out = {};
  let cursor = null, n = 0;
  do {
    const page = await repo.page(KINDS.member, orgId, { limit: 200, cursor });
    for (const m of page.rows) out[m.userId] = m;
    n += page.rows.length;
    cursor = page.cursor;
  } while (cursor && n < SCAN_CAP);
  return out;
}

/** Who approved or will approve a request, by name ('' when nobody yet). */
function approverName(r, members) {
  const ap = r.approval;
  if (!ap) return '';
  if (ap.decidedBy && ap.decidedBy.system === 'policy') return 'Approved by policy';
  if (ap.decidedBy && typeof ap.decidedBy.name === 'string' && ap.decidedBy.name) return ap.decidedBy.name;
  if (ap.approverId) return members[ap.approverId] ? members[ap.approverId].name : '';
  return ap.pool ? 'Company admins' : '';
}

const methods = {
  /**
   * The CSV download (reports.export). Same filters as the Reports list; pages the company's requests up
   * to constants.SCAN_CAP. One commit with audit 'reports.exported' (row count and filters).
   * @param {import('./types').MemberActor} actor
   * @param {{ period?: string, departmentId?: string, status?: string, travelerId?: string }} filters
   *   period: a PeriodKey (blank = the current period)
   * @returns {Promise<import('./types').CsvExport>} filename 'tripelyx-requests-2026-Q4.csv'
   * @throws {AppError} 403 'forbidden'; 422 'invalid_filter' with details by field
   */
  async exportCsv(actor, filters) {
    const a = await loadActor(this.repo, actor);
    need(a, 'reports.export');
    const f = exportFilters(a.org, filters, this.now());
    const orgId = a.org.id;
    const nowIso = this.repo.iso();
    const kind = f.period.includes('Q') ? 'quarter' : 'month';
    const requests = [];
    let cursor = null, scanned = 0;
    do {
      const page = await this.repo.page(KINDS.request, orgId, { limit: 200, cursor });
      requests.push(...page.rows);
      scanned += page.rows.length;
      cursor = page.cursor;
    } while (cursor && scanned < SCAN_CAP);
    const truncated = !!cursor;
    const [departments, members] = await Promise.all([this.repo.list(KINDS.department, orgId), allMembers(this.repo, orgId)]);
    const depName = new Map(departments.map(d => [d.id, d.name]));
    const rows = [];
    for (const r of requests) {
      if (!r.query || periodKey(r.query.departDate, kind) !== f.period) continue;
      if (f.departmentId && r.departmentId !== f.departmentId) continue;
      if (f.travelerId && r.travelerId !== f.travelerId) continue;
      const status = this.policy.effectiveStatus(r, nowIso, a.org.timezone);
      if (f.status && status !== f.status) continue;
      rows.push(requestRow(r, { timezone: a.org.timezone, status, departmentName: depName.get(r.departmentId) ?? null, approverName: approverName(r, members) }));
    }
    const body = toCsv(CSV_COLUMNS, truncated ? [...rows, [TRUNCATED_NOTE, ...CSV_COLUMNS.slice(1).map(() => '')]] : rows);
    const by = who(a);
    await this.repo.commit({
      inserts: [auditInsert(this.repo, {
        orgId, actor: by, action: 'reports.exported', target: { kind: KINDS.org, id: orgId },
        summary: `${by.name} exported ${rows.length} ${rows.length === 1 ? 'request' : 'requests'} for ${periodLabel(f.period)}`,
        changes: [
          { path: 'rowCount', before: null, after: rows.length },
          { path: 'filters', before: null, after: { period: f.period, departmentId: f.departmentId, status: f.status, travelerId: f.travelerId } },
        ],
      })],
    });
    return { filename: `tripelyx-requests-${f.period}.csv`, body, rowCount: rows.length, truncated };
  },
};

module.exports = { methods, CSV_COLUMNS, PRICE_SOURCE, BOM, csvCell, toCsv, requestRow };
