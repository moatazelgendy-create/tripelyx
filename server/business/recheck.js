// The price check before a submit, an approval, and on the approver's page (plan §F4, §H2). Writes nothing.
// STUB from Stage 0 with the frozen interface; Stage 1I builds it. The service calls it through
// this.composer.recheck(request), so tests can use fakeComposer().
//
// Vocabulary (from 1B): 'same' (every component's total is unchanged), 'changed' (a total moved),
// 'unavailable' (a component no longer prices). The request's status is the worst of its components.

function notBuilt() { throw new Error('[business] not built'); }

/**
 * Price the request's selection again with composer.price(request.selection, request.query) and compare
 * each component's total with request.rows.
 * @param {import('./search').TripComposer} composer
 * @param {import('./types').Request} request
 * @returns {Promise<import('./types').RecheckResult>} at = the fresh pricedAt
 */
async function recheck(composer, request) { notBuilt(); }

module.exports = { recheck };
