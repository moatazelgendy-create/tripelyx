// The invite link page (POST /business/o/:orgId/people/invite answers it with 200, plan §B6): the link is shown
// once (only its hash is stored), with "Copy link" (parts.copyLink, enhanced by /js/business.js) and "Back to
// People". The route sends Cache-Control no-store and Referrer-Policy no-referrer with it.
const { html } = require('../../lib/html');
const { pageHead, copyLink, kvList } = require('./parts');
const f = require('./format');
const { shellView } = require('./shell');
const { TIER_LABELS } = require('../../business/constants');

const NO_EMAIL = "We don't send email yet.";
const REPLACED = 'This replaces the earlier invite for this email.';

/**
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ created: import('../../business/types').InviteCreated, url: string, tier?: string|null }} v
 */
function inviteLinkView(ctx, shell, { created, url, tier = null }) {
  const { org } = shell;
  const inv = created.invite;
  const expires = f.dayIn(f.safeZone(org.timezone), inv.expiresAt);
  const body = html`${pageHead({ title: `Invite ready for ${inv.email}` })}
    <p class="bz-lead-text">Copy this link and send it to ${inv.email} yourself. It works once and expires on ${expires}. ${NO_EMAIL}</p>
    ${created.replaced ? html`<p class="alert alert-info bz-alert" role="status">${REPLACED}</p>` : ''}
    <div class="bz-card bz-stack">
      ${copyLink({ id: 'bz-invite-link', value: url, label: 'Invite link' })}
      ${kvList([['Email', inv.email], ['Role', inv.roleLabel], ['Department', inv.departmentName || ''], ['Policy tier', tier ? TIER_LABELS[tier] || '' : ''], ['Expires', f.dateTimeIn(org.timezone, inv.expiresAt)]])}
    </div>
    ${org.status === 'pending' ? html`<p>They can join once Tripelyx confirms ${org.name}.</p>` : ''}
    <p>This page shows the link once. If it gets lost, create a new invite for the same email: the new link replaces this one.</p>
    <p class="bz-inline"><a class="btn btn-ghost bz-btn" href="/business/o/${org.id}/people">Back to People</a></p>`;
  return shellView(ctx, shell, { title: 'Invite ready', body });
}

module.exports = { inviteLinkView, NO_EMAIL, REPLACED };
