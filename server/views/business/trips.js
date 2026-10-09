// The trips lists (/business/o/:orgId/trips, plan §B4): tabs Mine · Team · Company by permission, the Company
// filters (status, department, traveler, period), 50 rows a page with "Older". Also the pieces every list of
// requests shares (home, approvals): city names for a route, the dates, the trip cell, the demo-labelled total,
// and the search link that plans a trip again.
//
// Amounts: each total is its own demo container (parts.demoPrice) that says "Demo price · Priced at …" in the
// company's time zone, so no amount on these pages stands without its demo label (or, for a request priced by
// a supplier's test system, "Supplier test data, not a real price" with the TEST DATA tag; on live prices "US
// dollars, from the airline · Priced at … · Can change until booked"). The status filter says "Approved", not
// "Approved to book", once the workspace or a listed request is on supplier prices. With live prices a company
// Tripelyx has not confirmed yet cannot search (go-live design §5.5): no "Plan a trip" button, and the empty
// state says search opens once Tripelyx confirms the company. With live search off, a company that already has
// trips priced on live prices (liveTrips) is told search is turned off for now (parts.NO_TRIPS.textSearchOff).
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const f = require('./format');
const p = require('./parts');
const { periodLabel } = require('../../business/budgets');

/** Airport code → city, from the inventory's airport table (empty with no supplier: codes are shown). */
function places(ctx) {
  const inv = ctx && ctx.business && ctx.business.inventory;
  let list = [];
  try { list = inv && typeof inv.airports === 'function' ? inv.airports() : []; } catch { list = []; }
  return new Map(list.map(a => [a.code, a.city]));
}

const cityOf = (map, code) => (map && map.get(code)) || code;

/** "Cairo to London". */
const routeText = (map, from, to) => `${cityOf(map, from)} to ${cityOf(map, to)}`;

/** "Thu 12 Nov to Mon 16 Nov", or "Thu 12 Nov, one way". */
const datesText = (departDate, returnDate) => (returnDate ? f.dayRange(departDate, returnDate) : `${f.day(departDate)}, one way`);

/** Nights between two 'YYYY-MM-DD' dates. */
const nightsBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * The search form's fields for a stored query (types.TripQuery), as the query string of /trips/search or
 * /trips/new: what the traveler typed, so the search runs again exactly as planned.
 * @param {import('../../business/types').TripQuery} q
 * @returns {string} 'from=CAI&to=LHR&depart=…'
 */
function searchQuery(q) {
  if (!q) return '';
  const s = new URLSearchParams();
  s.set('from', q.from);
  s.set('to', q.to);
  s.set('depart', q.departDate);
  if (q.returnDate) s.set('return', q.returnDate);
  if (q.hotel) {
    s.set('hotel', '1');
    if (!q.returnDate) s.set('nights', String(nightsBetween(q.hotel.checkIn, q.hotel.checkOut)));
  }
  s.set('cabin', q.cabin || 'economy');
  if (q.datesFlexible) s.set('flex', '1');
  return s.toString();
}

/**
 * A row's total with its price label (one container per amount): the request's own source (RequestRow.source,
 * real-suppliers design §2.3), so a supplier test data total says so; an old row without one reads as demo. A
 * live total says who priced it (go-live design §5.6): "US dollars, from the airline" for a one-way flight ("the
 * airline and the hotel supplier" with a hotel); a return's two tickets may be on one airline or two, which the
 * row doesn't say, so it reads "from our airline suppliers" ("our airline and hotel suppliers" with a hotel).
 */
function totalCell(row, timeZone) {
  const source = f.isSource(row.source) ? row.source : 'demo';
  const kind = source === 'live' ? f.requestRowKind(row) : 'price';
  return p.demoPrice(row.totalCents, { pricedAt: row.pricedAt, timeZone, source, kind });
}

/** The trip cell of a list: route (a link to the request), dates, and the hotel city when there is one. */
function tripCell(base, map, row) {
  return html`<a class="bz-cell-link" href="${base}/trips/${row.id}">${routeText(map, row.from, row.to)}</a><span class="bz-cell-sub">${datesText(row.departDate, row.returnDate)}${row.hotelCity ? ` · Hotel in ${row.hotelCity}` : ''}</span>`;
}

/**
 * A table of requests (types.RequestRow).
 * @param {{ base: string, map: Map<string, string>, rows: object[], timeZone: string, caption: string,
 *   traveler?: boolean, empty?: string }} t
 */
function tripTable({ base, map, rows, timeZone, caption, traveler = false, empty = 'Nothing here yet.' }) {
  const columns = [
    ...(traveler ? [{ label: 'Traveler' }] : []),
    { label: 'Trip' }, { label: 'Total', num: true }, { label: 'Status' }, { label: 'Policy' },
  ];
  return p.dataTable({
    caption, columns, empty,
    rows: (rows || []).map(r => [
      ...(traveler ? [r.travelerName] : []),
      tripCell(base, map, r), totalCell(r, timeZone), p.statusPill(r.status, { source: r.source }), p.policyBadge(r.policyStatus),
    ]),
  });
}

/** The Company list's filters, as the query string and listRequests name them. */
const LIST_FILTER_FIELDS = Object.freeze(['status', 'departmentId', 'travelerId', 'period']);

const STATUS_FILTERS = Object.freeze([
  ['draft', 'Draft'], ['pending', 'Waiting for approval'], ['approved', 'Approved to book'], ['denied', 'Denied'],
  ['cancelled', 'Cancelled'], ['expired', 'Expired'], ['past', 'Past trip'],
]);
/** The same filters once supplier prices are in play: nothing priced by a supplier can be booked yet. */
const SUPPLIER_STATUS_FILTERS = Object.freeze(STATUS_FILTERS.map(([v, text]) => Object.freeze([v, v === 'approved' ? 'Approved' : text])));

/** A <select> of the Company filters, with the chosen value kept. */
function select({ id, name, label, value, options, error }) {
  return html`<div class="field">
    <label for="${id}">${label}</label>
    <select id="${id}" name="${name}"${error ? html` aria-invalid="true" aria-describedby="${id}-err"` : ''}>
      <option value="">All</option>
      ${options.map(([v, text]) => html`<option value="${v}"${v === value ? html` selected` : ''}>${text}</option>`)}
    </select>
    ${error ? html`<p class="field-error" id="${id}-err">${error}</p>` : ''}
  </div>`;
}

/**
 * The /trips page.
 * @param {object} ctx
 * @param {{ org: object, member: object, scope: 'mine'|'team'|'all', scopes: string[],
 *   list: { rows: object[], cursor: string|null }, filters: object, query: object,
 *   (filters: the ones the list was read with; a refused filter is left out, so no select shows a filter that
 *   was not applied)
 *   options: { departments: object[], travelers: Array<{ userId: string, name: string }>, periods: string[] }|null,
 *   filterError?: string|null, filterErrors?: Record<string, string>, liveTrips?: boolean }} m liveTrips: search
 *   is off and the company already has trips priced on live prices (read for an empty list of the member's own)
 */
function tripsView(ctx, { org, scope, scopes, list, filters = {}, options = null, filterError = null, filterErrors = {}, liveTrips = false }) {
  const base = `/business/o/${org.id}`;
  const tz = f.safeZone(org.timezone);
  const map = places(ctx);
  const labels = { mine: 'Mine', team: 'Team', all: 'Company' };
  const tabItems = scopes.length > 1 ? scopes.map(s => ({ href: s === 'mine' ? `${base}/trips` : `${base}/trips?scope=${s}`, label: labels[s], current: s === scope })) : [];
  const captions = { mine: 'Your trips', team: "Your team's trips", all: `Every trip at ${org.name}` };
  const filtered = scope === 'all' && Object.values(filters).some(Boolean);
  const rows = list.rows || [];
  // With no supplier there is no search to plan a trip with: no "Plan a trip" button (as on the home page).
  // Nor while live search waits for the company's confirmation.
  const searchable = f.searchOpen(ctx, org);
  const waiting = f.awaitingConfirmation(ctx, org);
  // Supplier prices in the workspace or in the list: the approved filter says "Approved" (none can be booked yet).
  const workspace = f.ctxSource(ctx);
  const supplier = (!!workspace && workspace !== 'demo') || rows.some(r => f.isSource(r.source) && r.source !== 'demo');

  let body;
  if (!rows.length && scope === 'mine') {
    body = p.emptyState({
      title: p.NO_TRIPS.title, text: searchable ? p.NO_TRIPS.text : waiting ? p.NO_TRIPS.textWaiting : liveTrips ? p.NO_TRIPS.textSearchOff : p.NO_TRIPS.textNoSupplier, iconName: 'plane',
      action: searchable ? { href: `${base}/trips/new`, label: 'Plan a trip' } : null,
    });
  } else if (!rows.length) {
    body = p.emptyState({
      title: filtered ? 'No trips match these filters.' : 'No trips here yet.',
      text: filtered ? 'Try another status, department, traveler or period.' : scope === 'team' ? 'Trips you approve, and trips of people you manage, show here.' : `Trips planned at ${org.name} show here.`,
      iconName: 'calendar',
    });
  } else {
    body = tripTable({ base, map, rows, timeZone: tz, caption: captions[scope], traveler: scope !== 'mine' });
  }

  const next = new URLSearchParams();
  if (scope !== 'mine') next.set('scope', scope);
  for (const [k, v] of Object.entries(filters)) if (v && !filterErrors[k]) next.set(k, v);
  if (list.cursor) next.set('cursor', list.cursor);

  const filterForm = options ? html`<form class="bz-card bz-filters" method="get" action="${base}/trips">
      <input type="hidden" name="scope" value="all">
      <div class="bz-filter-grid">
        ${select({ id: 'f-status', name: 'status', label: 'Status', value: filters.status, options: supplier ? SUPPLIER_STATUS_FILTERS : STATUS_FILTERS, error: filterErrors.status })}
        ${select({ id: 'f-dep', name: 'departmentId', label: 'Department', value: filters.departmentId, options: options.departments.map(d => [d.id, d.archivedAt ? `${d.name} (archived)` : d.name]), error: filterErrors.departmentId })}
        ${options.travelers.length ? select({ id: 'f-trav', name: 'travelerId', label: 'Traveler', value: filters.travelerId, options: options.travelers.map(t => [t.userId, t.name]), error: filterErrors.travelerId }) : ''}
        ${select({ id: 'f-period', name: 'period', label: 'Departing in', value: filters.period, options: options.periods.map(k => [k, periodLabel(k)]), error: filterErrors.period })}
      </div>
      <div class="bz-filter-actions"><button class="btn btn-navy bz-btn" type="submit">${icon('search')}<span>Show trips</span></button>${filtered ? html`<a class="btn btn-ghost bz-btn" href="${base}/trips?scope=all">Clear filters</a>` : ''}</div>
    </form>` : '';

  return html`${p.pageHead({
    title: 'Trips',
    sub: scope === 'all' ? `Every work trip planned at ${org.name}, newest first.` : scope === 'team' ? 'Trips you approve, and trips of people you manage, newest first.' : 'Your work trips, newest first.',
    actions: searchable ? html`<a class="btn btn-navy bz-btn" href="${base}/trips/new">${icon('plus')}<span>Plan a trip</span></a>` : '',
  })}
  ${p.tabs(tabItems, { label: 'Trips' })}
  ${p.errorBox(filterError)}
  ${filterForm}
  ${body}
  ${p.pager(list.cursor ? `${base}/trips?${next.toString()}` : null)}`;
}

module.exports = { tripsView, tripTable, tripCell, totalCell, places, cityOf, routeText, datesText, searchQuery, nightsBetween, STATUS_FILTERS, SUPPLIER_STATUS_FILTERS, LIST_FILTER_FIELDS };
