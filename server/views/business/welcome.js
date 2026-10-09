// /business/o/:orgId/welcome (plan §B4 "Workspace entry", settings.company): the setup checklist, ticked from
// data (reports.checklist through service.dashboard): Review your policy · Add departments and budgets · Invite
// your team · Try a demo trip (only when demo inventory runs: with no supplier there is no trip to try). With a
// supplier's test system (real-suppliers design §2.3) the last step is "Try a trip with supplier test data";
// with live prices "Try a trip", once Tripelyx has confirmed the company (go-live design §5.5: until then there
// is no search to try).
const { html } = require('../../lib/html');
const { pageHead, checklist } = require('./parts');
const { awaitingConfirmation } = require('./format');
const { shellView } = require('./shell');

const TITLE = 'Welcome to Tripelyx Business';
/** The last set-up step, by where search prices come from. */
const TRY_TRIP = Object.freeze({ demo: 'Try a demo trip', sandbox: 'Try a trip with supplier test data', live: 'Try a trip' });

/**
 * The checklist's items for a company.
 * @param {string} orgId
 * @param {import('../../business/types').Checklist} c
 * @param {{ demo: boolean, source?: import('../../business/types').PriceSource|null }} opts demo: trips can be
 *   searched here (demo inventory or a supplier); source: where their prices come from ('demo' when absent)
 * @returns {Array<{ text: string, done: boolean, href: string }>}
 */
function welcomeItems(orgId, c, { demo, source = 'demo' }) {
  const base = `/business/o/${orgId}`;
  return [
    { text: 'Review your policy', done: !!c.policyReviewed, href: `${base}/policies` },
    { text: 'Add departments and budgets', done: !!c.departments, href: `${base}/people#departments` },
    { text: 'Invite your team', done: !!c.invited, href: `${base}/people#invite` },
    ...(demo ? [{ text: TRY_TRIP[source] || TRY_TRIP.demo, done: !!c.demoTrip, href: `${base}/trips/new` }] : []),
  ];
}

/**
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ checklist: import('../../business/types').Checklist, demo: boolean, source?: string|null, notice?: string|null }} v
 */
function welcomeView(ctx, shell, { checklist: c, demo, source = 'demo', notice = null }) {
  const { org } = shell;
  const items = welcomeItems(org.id, c, { demo: demo && !awaitingConfirmation(ctx, org), source });
  const left = items.filter(i => !i.done).length;
  const body = html`${pageHead({ title: TITLE, sub: `Set up ${org.name} in a few steps. Each one ticks itself once it's done.` })}
    <section class="bz-section" aria-labelledby="bz-setup-title">
      <h2 id="bz-setup-title">${left ? `Set-up steps (${left} to go)` : 'Set-up steps: all done'}</h2>
      ${checklist(items)}
    </section>
    <section class="bz-section" aria-labelledby="bz-next-title">
      <h2 id="bz-next-title">How it works</h2>
      <p>Your team plans trips inside your policy. Anything outside it goes to their manager or approver, and approved trips count against the department's budget.</p>
      <p>We don't send email yet: you share invite links yourself, and approvers check their Approvals page.</p>
      <p class="bz-inline"><a class="btn btn-navy bz-btn" href="/business/o/${org.id}">Go to your company home</a></p>
    </section>`;
  return shellView(ctx, shell, { title: 'Welcome', body, notice });
}

module.exports = { welcomeView, welcomeItems, TITLE, TRY_TRIP };
