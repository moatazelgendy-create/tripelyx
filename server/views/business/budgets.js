// /business/o/:orgId/budgets?period=2026-Q4 (budget.view.dept or budget.view.all, plan §B4, §B6, §H4): per
// department its budget, what approved trips committed, what is awaiting approval, what is left, and a bar;
// "Spent: shows once real bookings exist" ("once booking is open" with no supplier). A period switcher;
// budget.edit holders set each department's budget for the period (POST /budgets, 303 back). A Manager sees
// only their own department (listBudgets).
// Every amount sits in a demo container (§F6): committed and awaiting sum demo prices, so the whole table does.
// With real suppliers (real-suppliers design §2.3) the container is labelled with the least real source of the
// requests it adds up (priceSource, from the route): "Includes supplier test data". With no supplier and nothing
// counted (production) priceSource is null: the figures are the company's own, with no price label.
const { html } = require('../../lib/html');
const { pageHead, tabs, dataTable, emptyState, amount, budgetBar, demoBox } = require('./parts');
const f = require('./format');
const { shellView } = require('./shell');
const { textField } = require('./auth');
const { periodLabel } = require('../../business/budgets');
const { SCAN_CAP } = require('../../business/constants');

const TITLE = 'Budgets';
const SPENT = 'Spent: shows once real bookings exist.';
/** With no supplier there is no other kind of booking for "real" to set apart: say when it shows instead. */
const SPENT_NO_SUPPLIER = 'Spent: shows once booking is open.';
/** What Committed counts (plan §C6: a trip approved while its department had no budget for the period takes no hold). */
const committedText = label => `Committed: trips departing in ${label}, approved while their department had a budget for it. A trip approved before its department had a budget for the period isn't counted.`;
const uncountedText = cents => html`Approved before this budget was set, not counted: ${amount(cents)}`;
const noBudgets = label => `No budgets for ${label}. Without a budget, trips are checked against the policy only.`;

/** Cents as the budget form shows dollars: 2000000 → "20000", 1050 → "10.50". */
function dollarsText(cents) {
  if (!Number.isSafeInteger(cents)) return '';
  const whole = Math.trunc(cents / 100), part = Math.abs(cents % 100);
  return part ? `${whole}.${String(part).padStart(2, '0')}` : String(whole);
}

/**
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ rows: import('../../business/types').BudgetRow[], periodKey: string, choices: string[], canEdit: boolean,
 *   periodKind: 'quarter'|'month', ownOnly: boolean, uncounted?: Record<string, number>|null,
 *   values?: Record<string, string>, errors?: Record<string, Record<string, string>>, notice?: string|null, error?: string|null,
 *   priceSource?: import('../../business/types').PriceSource|null }} v
 *   ownOnly: the member sees only their own department; uncounted: per department id, the approved trips of the
 *   period its budget doesn't count, in cents (null when unknown); values/errors: keyed by department id after a 422;
 *   priceSource: the least real source of the amounts the table adds up ('demo' when absent; null with no
 *   supplier and no counted requests, so the table carries no price label)
 */
function budgetsView(ctx, shell, { rows, periodKey, choices, canEdit, periodKind, ownOnly, uncounted = null, values = {}, errors = {}, notice = null, error = null, priceSource = 'demo' }) {
  const { org } = shell;
  const base = `/business/o/${org.id}`;
  const tz = f.safeZone(org.timezone);
  const label = periodLabel(periodKey);
  const keyKind = periodKey.includes('Q') ? 'quarter' : 'month';
  const anyBudget = rows.some(r => r.budgetId);
  const truncated = rows.some(r => r.truncated);
  const switcher = tabs(choices.map(k => ({ href: `${base}/budgets?period=${encodeURIComponent(k)}`, label: periodLabel(k), current: k === periodKey })), { label: 'Budget period' });
  const tableRows = rows.map(r => [
    html`<span class="bz-budget-name">${r.department.name}${r.department.archived ? ' (archived)' : ''}</span>${budgetBar(r)}${uncounted && uncounted[r.department.id] > 0 ? html`<span class="bz-meta bz-budget-note">${uncountedText(uncounted[r.department.id])}</span>` : ''}`,
    r.amountCents === null ? 'No budget set' : amount(r.amountCents),
    amount(r.committedCents),
    amount(r.awaitingCents),
    r.remainingCents === null ? 'No budget set' : amount(r.remainingCents),
  ]);
  // With no supplier and no counted requests the figures are the company's own, so no price label (as
  // home.js budgetTable); otherwise the container says where the amounts it adds up came from.
  const box = (body, opts) => (priceSource ? demoBox(body, opts) : html`<section aria-label="${opts.label}">${body}</section>`);
  const table = rows.length
    ? box(html`${dataTable({
      caption: `Budgets for ${label}`,
      columns: [{ label: 'Department' }, { label: 'Budget', num: true }, { label: 'Committed', num: true }, { label: 'Awaiting approval', num: true }, { label: 'Remaining', num: true }],
      rows: tableRows,
    })}
      <p class="bz-meta">${committedText(label)} Awaiting approval: trips waiting for a decision, not counted as committed.${truncated ? ` Awaiting approval counts the ${SCAN_CAP.toLocaleString('en-US')} most recent requests.` : ''}</p>
      <p class="bz-meta">${f.searchable(ctx) ? SPENT : SPENT_NO_SUPPLIER}</p>`, { pricedAt: null, timeZone: tz, tag: 'section', label: `Budgets for ${label}`, source: priceSource, totals: true })
    : emptyState({ title: ownOnly ? "You're not in a department yet, so there's no budget to show." : 'No departments yet.', text: ownOnly ? 'Ask a travel admin to add you to one.' : 'Add departments on the People page, then set their budgets here.', iconName: 'wallet' });
  const editable = rows.filter(r => !r.department.archived);
  const forms = canEdit && editable.length
    ? keyKind !== periodKind
      ? html`<p class="bz-meta">${org.name} sets budgets by ${periodKind}. Pick a ${periodKind} above to change them.</p>`
      : html`<section class="bz-section" id="set-budgets" aria-labelledby="bz-set-title">
        <h2 id="bz-set-title">Set budgets for ${label}</h2>
        <ul class="bz-grid">${editable.map(r => {
    const id = r.department.id;
    const v = Object.hasOwn(values, id) ? values[id] : dollarsText(r.amountCents);
    const e = errors[id] || {};
    return html`<li><form class="bz-card bz-stack" method="post" action="${base}/budgets">
            <input type="hidden" name="departmentId" value="${id}"><input type="hidden" name="period" value="${periodKey}"><input type="hidden" name="rev" value="${r.rev === null ? '' : String(r.rev)}">
            ${textField({ id: `bz-budget-${id}`, name: 'amount', label: `${r.department.name} (US dollars)`, value: v, error: e.amount || e.period, inputmode: 'decimal', maxlength: 14, required: true })}
            <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">${r.budgetId ? 'Save' : 'Add a budget'}<span class="sr-only"> for ${r.department.name}</span></button></div>
          </form></li>`;
  })}</ul>
      </section>`
    : '';
  const body = html`${pageHead({ title: TITLE, sub: label })}
    ${switcher}
    ${rows.length && !anyBudget ? html`<p class="alert alert-info bz-alert" role="status">${noBudgets(label)}</p>` : ''}
    ${table}
    ${forms}`;
  return shellView(ctx, shell, { title: TITLE, body, notice, error });
}

module.exports = { budgetsView, dollarsText, committedText, TITLE, SPENT, SPENT_NO_SUPPLIER, noBudgets };
