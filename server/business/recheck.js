// The price check before a submit, an approval, and on the approver's page (plan §F4, §H2). Writes nothing.
// The service calls it through this.composer.recheck(request), so tests can use fakeComposer().
//
// Vocabulary (from 1B): 'same' (every component prices as stored), 'changed' (a total moved, or the terms
// behind it did: the fare's refund, change or bag terms, the room's cancellation terms, the flight times, the
// stay's dates, or the price lines, even at the same total), 'unavailable' (a component no longer prices:
// sold out, or gone from the inventory altogether, in which case its row is the stored one with no price).
// The request's status is the worst of its components.

const RANK = Object.freeze({ same: 0, changed: 1, unavailable: 2 });
const COMPONENTS = Object.freeze(['out', 'back', 'hotel']);

/**
 * What an approver relies on besides the total, in a fixed key order (never Object.keys order): two rows
 * with the same fingerprint and the same total are the same offer.
 * @param {import('./types').Row} row
 * @returns {string}
 */
function terms(row) {
  const lines = (row.lines || []).map(l => [l.label, l.kind, l.cents]);
  if (row.kind === 'hotel') {
    const r = row.room || {}, c = row.cancellation || {};
    return JSON.stringify([row.checkIn, row.checkOut, row.nights, r.name, r.sleeps, r.bed, c.refundable, c.freeUntilHours, c.text, lines]);
  }
  const f = row.fare || {};
  const segs = (row.segments || []).map(s => [s.flightNumber, s.departLocal, s.arriveLocal]);
  return JSON.stringify([row.cabin, f.code, f.terms, f.refundablePercent, f.changeable, f.cabinKg, f.checkedBags, f.checkedKg, segs, lines]);
}

/**
 * Price the request's selection again with composer.price(request.selection, request.query, { previous:
 * request.rows, check }) and compare each component with request.rows: its total, then its terms.
 * @param {import('./search').TripComposer} composer
 * @param {import('./types').Request} request
 * @param {{ check?: import('./types').CheckLevel }} [opts] check: how far a real supplier may go to answer
 *   (real-suppliers design §5.1): 'auto' (default: the supplier's cache, else a fresh check), 'peek' (an
 *   approver's page view: never a search; 503 live_check_skipped when it would need one), 'confirm' (submit),
 *   'final' (decide: hotels prebook). Demo providers and the frozen fakes ignore it
 * @returns {Promise<import('./types').RecheckResult>} at = the fresh pricedAt
 */
async function recheck(composer, request, { check = null } = {}) {
  const was = request.rows || {};
  const fresh = await composer.price(request.selection, request.query, check ? { previous: was, check } : { previous: was });
  const components = { out: null, back: null, hotel: null };
  let status = 'same';
  for (const c of COMPONENTS) {
    const row = fresh.rows[c];
    if (!row) continue;
    const prev = was[c] || null;
    const wasCents = prev && Number.isInteger(prev.totalCents) ? prev.totalCents : null;
    const s = !row.available ? 'unavailable' : row.totalCents !== wasCents || !prev || terms(row) !== terms(prev) ? 'changed' : 'same';
    if (RANK[s] > RANK[status]) status = s;
    components[c] = { status: s, row, wasCents, nowCents: row.available ? row.totalCents : null };
  }
  return { status, components, newTotalCents: status === 'unavailable' ? null : fresh.totalCents, at: fresh.pricedAt };
}

module.exports = { recheck };
