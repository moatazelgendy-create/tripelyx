// The price check before a submit, an approval, and on the approver's page (plan §F4, §H2). Writes nothing.
// The service calls it through this.composer.recheck(request), so tests can use fakeComposer().
//
// Vocabulary (from 1B): 'same' (every component's total is unchanged), 'changed' (a total moved),
// 'unavailable' (a component no longer prices: sold out, or gone from the inventory altogether, in which case
// its row is the stored one with no price). The request's status is the worst of its components.

const RANK = Object.freeze({ same: 0, changed: 1, unavailable: 2 });
const COMPONENTS = Object.freeze(['out', 'back', 'hotel']);

/**
 * Price the request's selection again with composer.price(request.selection, request.query, { previous:
 * request.rows }) and compare
 * each component's total with request.rows.
 * @param {import('./search').TripComposer} composer
 * @param {import('./types').Request} request
 * @returns {Promise<import('./types').RecheckResult>} at = the fresh pricedAt
 */
async function recheck(composer, request) {
  const was = request.rows || {};
  const fresh = await composer.price(request.selection, request.query, { previous: was });
  const components = { out: null, back: null, hotel: null };
  let status = 'same';
  for (const c of COMPONENTS) {
    const row = fresh.rows[c];
    if (!row) continue;
    const wasCents = was[c] && Number.isInteger(was[c].totalCents) ? was[c].totalCents : null;
    const s = !row.available ? 'unavailable' : row.totalCents !== wasCents ? 'changed' : 'same';
    if (RANK[s] > RANK[status]) status = s;
    components[c] = { status: s, row, wasCents, nowCents: row.available ? row.totalCents : null };
  }
  return { status, components, newTotalCents: status === 'unavailable' ? null : fresh.totalCents, at: fresh.pricedAt };
}

module.exports = { recheck };
