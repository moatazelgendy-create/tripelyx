// /business/app: the workspace entry (plan §B4 "Workspace entry"). Headed "Your companies" either way. With no
// company: a "Create your company workspace" section and the invite hint. With two or more (or one, for a
// platform admin): a card per company with the member's role and the company's status. Platform admins see
// "Waiting for confirmation (n)" first, linking to /admin/business. Corporate chrome with noindex
// (auth.publicPage); the route sets no-store.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { statusPill, notice } = require('./parts');
const f = require('./format');
const { publicPage, cardHead, signOutForm, START } = require('./auth');

const TITLE = 'Your companies';
const JOIN_HINT = 'Joining a team? Open the invite link your travel admin sent you.';

/**
 * @param {object} ctx
 * @param {{ user: object, companies: import('../../business/types').CompanyLink[], max: number,
 *   waiting?: number|null, note?: string|null }} v waiting: pending companies (platform admins only, else null)
 */
function chooserView(ctx, { user, companies, max, waiting = null, note = null }) {
  const list = Array.isArray(companies) ? companies : [];
  // A platform admin's task comes first: the companies waiting for them.
  const admin = Number.isInteger(waiting)
    ? html`<section class="bz-pub-section bz-pub-admin" aria-label="Tripelyx admin">
        <p>${waiting ? `${f.plural(waiting, 'company', 'companies')} waiting for you to confirm.` : 'No companies are waiting for confirmation.'}</p>
        <p><a class="btn btn-ghost bz-btn" href="/admin/business">${icon('shield')}<span>Waiting for confirmation (${String(waiting)})</span></a></p>
      </section>`
    : '';
  const body = list.length
    ? html`${cardHead(TITLE, `Signed in as ${user.name}. Pick a company to open its workspace.`, ctx)}
      ${notice(note)}
      ${admin}
      <ul class="bz-pub-list">${list.map(c => html`<li class="bz-pub-org">
        <div class="bz-pub-org-text"><p class="bz-pub-org-name">${c.name}</p><p class="bz-pub-org-meta"><span>${c.roleLabel}</span>${statusPill(c.status, { kind: 'org' })}</p></div>
        <a class="btn btn-navy bz-btn" href="/business/o/${c.id}">Open<span class="sr-only"> ${c.name}</span></a>
      </li>`)}</ul>
      ${list.length < max ? html`<p><a class="bz-pub-more" href="${START}">${icon('plus')}<span>Create another company</span></a></p>` : ''}`
    : html`${cardHead(TITLE, admin ? `Signed in as ${user.name}.` : `Signed in as ${user.name}. You're not in a company yet.`, ctx)}
      ${notice(note)}
      ${admin}
      <section class="bz-pub-section" aria-labelledby="bz-create-title">
        <h2 id="bz-create-title">Create your company workspace</h2>
        <p>Set up your travel policy, budgets and team in one place.</p>
        <p><a class="btn btn-navy bz-btn" href="${START}">Create workspace</a></p>
        <p>${JOIN_HINT}</p>
      </section>`;
  return publicPage(ctx, {
    title: TITLE,
    body: html`${body}<div class="bz-pub-links"><p>Your personal trips stay private to you.</p>${signOutForm()}</div>`,
  });
}

module.exports = { chooserView, TITLE, JOIN_HINT };
