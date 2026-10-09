// The only file under server/business that calls the network (real-suppliers design §1.2, §4.1, §4.2, §4.6,
// §7.4). Every supplier call goes through call():
//
// - the gate first (gate.js: the company's limit, the breaker, Duffel's headers, the global bucket);
// - a client timeout per attempt (AbortSignal.timeout), inside the operation's time budget;
// - bounded retries: the adapter's `retry(outcome, attempt)` says whether (true: the jittered backoff, 250 ms
//   then 1 s; a number: that wait) and `maxAttempts` how often; no retry starts when the budget can't hold it;
// - redirects are refused (a supplier key never follows a redirect anywhere);
// - the decoded body is read with a byte counter and dropped past `maxBytes` (8 MB for a Duffel offer request,
//   4 MB otherwise) → 503 supplier_unavailable, logged as `too_large`;
// - one structured log line per attempt: { supplier, op, status, ms, attempt, requestId, company, outcome },
//   plus a supplier error's type and code (Duffel) or numeric code (LiteAPI). Never a body, a header, a URL or
//   query string, a place, a date, a name, an offer id or a key: keys exist only in the headers the adapters
//   build, and nothing here reads, logs or throws a header value.
// A connection error, a timeout, an oversized body or a body that isn't JSON, after the retries, is 503
// supplier_unavailable. Any other answer goes back to the adapter, which maps its status and error codes.
const { performance } = require('node:perf_hooks');
const { currentCompany } = require('../scope');
const { supplierError } = require('../source');
const { companyTag } = require('./gate');

const MB = 1024 * 1024;
const DELAYS = Object.freeze([250, 1000]);
/** No retry starts with less than this left in the operation's budget. */
const MIN_ATTEMPT_MS = 1000;
/** The supplier hosts (the byte-identity tests fail on any call to them). */
const SUPPLIER_HOSTS = Object.freeze(['api.duffel.com', 'api.liteapi.travel', 'book.liteapi.travel']);

const SAFE_CODE_RE = /^[a-z0-9_]{1,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

class TooLarge extends Error {}

/**
 * The response body as text, refusing more than maxBytes (decoded).
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 * @throws {TooLarge}
 */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (res.body) await res.body.cancel().catch(() => {});
    throw new TooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, n).toString('utf8');
}

/** A supplier error's type and code, if they look like codes (never its message or title). */
function errorCodes(json) {
  if (!json || typeof json !== 'object') return {};
  const d = Array.isArray(json.errors) && json.errors[0] && typeof json.errors[0] === 'object' ? json.errors[0] : null;
  if (d) {
    return {
      ...(typeof d.type === 'string' && SAFE_CODE_RE.test(d.type) ? { errorType: d.type } : {}),
      ...(typeof d.code === 'string' && SAFE_CODE_RE.test(d.code) ? { errorCode: d.code } : {}),
    };
  }
  const l = json.error && typeof json.error === 'object' ? json.error : null;
  return l && Number.isSafeInteger(l.code) ? { errorCode: l.code } : {};
}

/**
 * @param {{ fetch?: Function|null, gate: import('./gate').Gate, now: () => Date, log?: object,
 *   sleep?: (ms: number) => Promise<void>, random?: () => number, mono?: () => number }} deps
 *   fetch: tests inject one; by default the global fetch, looked up at call time
 * @returns {{ call: (req: SupplierRequest) => Promise<SupplierResponse> }}
 */
function createSupplierHttp({ fetch: fetchImpl = null, gate, now, log = console, sleep = null, random = Math.random, mono = () => performance.now() } = {}) {
  if (!gate || typeof now !== 'function') throw new TypeError('[suppliers] http needs a gate and a clock');
  const send = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  // A held timer (a backoff of at most 1.2 s): a script waiting on a retry is not ended under it.
  const wait = sleep || (ms => new Promise(r => { setTimeout(r, ms); }));
  const info = (log.info || log.log || (() => {})).bind(log);
  const warn = (log.warn || info).bind(log);

  /**
   * @typedef {object} SupplierRequest
   * @property {'duffel'|'liteapi'} supplier
   * @property {string} op a short name for the log ('offer_request', 'offer_get', 'rates', 'prebook', 'airlines')
   * @property {'flights'|'hotels'} vertical whose "not available right now" sentence an outage gives
   * @property {string} url
   * @property {string} [method]
   * @property {Record<string, string>} headers
   * @property {string} [body]
   * @property {number} timeoutMs per attempt
   * @property {number} [budgetMs] the whole operation, retries and waits included (default timeoutMs)
   * @property {number} [maxBytes] default 4 MB
   * @property {number} [maxAttempts] default 1
   * @property {(outcome: object, attempt: number) => boolean|number} [retry]
   * @property {boolean} [countCompany] false for the second half of one operation (LiteAPI's prebook retry with
   *   a longer timeout): the company's limit counts an operation once
   *
   * @typedef {object} SupplierResponse
   * @property {number} status
   * @property {{ get: (name: string) => string|null }} headers
   * @property {unknown} json the parsed body (null when empty or not JSON)
   * @property {string|null} requestId
   * @property {string} answeredAt ISO, when the answer arrived
   * @property {number} attempt
   */
  async function call({ supplier, op, vertical, url, method = 'GET', headers, body = undefined, timeoutMs, budgetMs = timeoutMs, maxBytes = 4 * MB, maxAttempts = 1, retry = () => false, countCompany = true }) {
    const started = mono();
    const company = companyTag(currentCompany());
    const unavailable = () => supplierError('supplier_unavailable', { vertical });
    for (let attempt = 1; ; attempt += 1) {
      await gate.admit(supplier, { vertical, first: attempt === 1 && countCompany });
      const left = budgetMs - (mono() - started);
      if (left < 1) throw unavailable();
      const t0 = mono();
      let outcome;
      try {
        const res = await send(url, { method, headers, body, redirect: 'error', signal: globalThis.AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, Math.floor(left)))) });
        const text = await readCapped(res, maxBytes);
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { json = null; } }
        outcome = { kind: 'response', status: res.status, headers: res.headers, json, badJson: Boolean(text) && json === null };
      } catch (e) {
        outcome = e instanceof TooLarge ? { kind: 'too_large' }
          : e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? { kind: 'timeout' } : { kind: 'network' };
      }
      const ms = Math.round(mono() - t0);
      const status = outcome.kind === 'response' ? outcome.status : null;
      const failure = outcome.kind !== 'response' || status === 429 || status >= 500 || outcome.badJson;
      gate.record(supplier, { failure, headers: outcome.headers || null });
      const rid = outcome.headers ? outcome.headers.get('x-request-id') : null;
      const requestId = typeof rid === 'string' && REQUEST_ID_RE.test(rid) ? rid : null;
      const line = {
        supplier, op, status, ms, attempt, requestId, company,
        outcome: outcome.kind !== 'response' ? outcome.kind : outcome.badJson ? 'bad_body' : status < 400 ? 'ok' : 'error',
        ...(outcome.kind === 'response' && status >= 400 ? errorCodes(outcome.json) : {}),
      };
      (failure ? warn : info)(`[suppliers] ${JSON.stringify(line)}`);

      let delay = attempt < maxAttempts ? retry(outcome, attempt) : false;
      if (delay === true) delay = Math.round(DELAYS[Math.min(attempt - 1, DELAYS.length - 1)] * (0.8 + 0.4 * random()));
      if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) {
        const remaining = budgetMs - (mono() - started);
        if (remaining - delay >= MIN_ATTEMPT_MS) {
          await wait(delay);
          continue;
        }
      }
      if (outcome.kind !== 'response' || outcome.badJson) throw unavailable();
      return { status, headers: outcome.headers, json: outcome.json, requestId, answeredAt: now().toISOString(), attempt };
    }
  }

  return { call, warn, info };
}

module.exports = { createSupplierHttp, readCapped, errorCodes, SUPPLIER_HOSTS, MB, DELAYS, MIN_ATTEMPT_MS };
