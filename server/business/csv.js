// The requests CSV (plan §H6): POST /o/:orgId/reports/export (reports.export) answers it as an attachment
// with Cache-Control no-store. BusinessService method exportCsv plus the pure CSV helpers.
// STUB from Stage 0 with the frozen interface; Stage 1W-b builds it.
//
// - UTF-8 with a BOM, CRLF line ends, every cell quoted when it holds a comma, quote, CR or LF.
// - Cells starting with = + - @, a tab or a CR get a ' prefix (formula injection guard).
// - Times are local to the company's time zone ('YYYY-MM-DD HH:MM'); money in dollars with 2 decimals.
// - Never a supplier cost, net rate, commission, markup, provider name or `internal` field.
// - When the 5,000-request scan (constants.SCAN_CAP) is hit, a last note row says so.

function notBuilt() { throw new Error('[business] not built'); }

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
function csvCell(value) { notBuilt(); }

/**
 * A whole CSV body: BOM, header row, data rows, CRLF line ends.
 * @param {string[]} columns
 * @param {Array<Array<string|number|null>>} rows
 * @returns {string}
 */
function toCsv(columns, rows) { notBuilt(); }

/**
 * One request as a row of CSV_COLUMNS.
 * @param {import('./types').Request} request
 * @param {{ timezone: string, status: import('./types').EffectiveStatus, departmentName: string|null,
 *   approverName: string|null }} ctx
 * @returns {Array<string|number|null>}
 */
function requestRow(request, ctx) { notBuilt(); }

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
  async exportCsv(actor, filters) { notBuilt(); },
};

module.exports = { methods, CSV_COLUMNS, PRICE_SOURCE, BOM, csvCell, toCsv, requestRow };
