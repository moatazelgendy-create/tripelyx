// The invite landing (GET /business/invite/:token, plan §B6, §B7, lead decision 2) and its answers: the 410
// page for a link that can't be used, and the paused-company page. Corporate chrome with noindex; the route
// sets Referrer-Policy no-referrer, Cache-Control no-store and X-Robots-Tag noindex.
//
// States (types.InviteLanding.state):
//   join             signed out: "Create your account to join" (the /join form, the email fixed) and
//                    "Already have an account? Sign in" (/business/signin?next=<this landing>). The page never
//                    says whether an account uses the email; POST /join answers that, behind bizAuthIp.
//   accept           signed in with the invited email: "Join Acme Inc" (POST /accept)
//   other_email      signed in with another email: refused (copy in §B6), with Sign out
//   member           already in the company: a link to the workspace
//   pending_company  Tripelyx hasn't confirmed the company yet (409)
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { errorBox } = require('./parts');
const f = require('./format');
const { publicPage, cardHead, textField, signOutForm, SIGNIN } = require('./auth');
const { BUSINESS_EMAIL } = require('../../business/constants');

/** The copy (§B6, lead decision 2). */
const GONE = "This invite link can't be used anymore. Ask your company's travel admin for a new one.";
const NOT_YOURS = `If an account with this email isn't yours, write to ${BUSINESS_EMAIL}.`;
const JOIN_TAKEN = 'This email already has an account. Sign in instead.';
const pendingText = name => `${name} is waiting for Tripelyx to confirm it. Try this link again once it's confirmed.`;
const otherEmailText = (masked, mine) => `This invite is for ${masked}. You're signed in as ${mine}. Sign out to use it, or ask your admin to invite ${mine}.`;

/** "Dana Lee invited dana@acme.com to join as Employee in Engineering." The full address only to the
 * person it was sent to (join, accept); anyone else signed in sees it masked. */
function inviteLead(inv, full) {
  const by = inv.invitedByName || 'Your company';
  return `${by} invited ${full ? inv.email : inv.emailMasked} to join as ${inv.roleLabel}${inv.departmentName ? ` in ${inv.departmentName}` : ''}.`;
}

/**
 * The invite landing.
 * @param {object} ctx
 * @param {{ landing: import('../../business/types').InviteLanding, token: string, user?: object|null,
 *   error?: string|null, emailTaken?: boolean, values?: { name?: string }, errors?: Record<string, string> }} v
 */
function inviteView(ctx, { landing, token, user = null, error = null, emailTaken = false, values = {}, errors = {} }) {
  const { org, invite: inv, state } = landing;
  const here = `/business/invite/${token}`;
  const signinHref = `${SIGNIN}?next=${encodeURIComponent(here)}`;
  const expires = f.dateTimeIn('UTC', inv.expiresAt, { zone: true });
  let main;
  if (state === 'join') {
    main = html`${emailTaken ? html`<div class="alert alert-error bz-alert" role="alert">${icon('alert')}<span>${JOIN_TAKEN} <a href="${signinHref}">Sign in</a></span></div>` : ''}
      <section class="bz-pub-section" aria-labelledby="bz-join-title">
        <h2 id="bz-join-title">Create your account to join</h2>
        <form class="bz-form bz-pub-form" method="post" action="${here}/join">
          <div class="field"><span class="label">Email</span><p class="bz-pub-fixed">${inv.email}</p><p class="field-hint">The invite was sent to this address, so your account uses it.</p></div>
          ${textField({ id: 'bz-join-name', name: 'name', label: 'Your name', value: values.name, error: errors.name, required: true, maxlength: 80, autocomplete: 'name' })}
          ${textField({ id: 'bz-join-password', name: 'password', label: 'Password', type: 'password', error: errors.password, required: true, minlength: 10, maxlength: 200, autocomplete: 'new-password', hint: 'At least 10 characters.' })}
          <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Create account and join</button></div>
        </form>
      </section>
      <section class="bz-pub-section" aria-labelledby="bz-join-signin">
        <h2 id="bz-join-signin">Already have an account?</h2>
        <p>Sign in with it to join ${org.name}.</p>
        <p><a class="btn btn-ghost bz-btn" href="${signinHref}">Sign in</a></p>
      </section>`;
  } else if (state === 'accept') {
    main = html`<form class="bz-form bz-pub-form" method="post" action="${here}/accept">
        <p>You're signed in as ${user ? user.name : ''} (${inv.email}).</p>
        <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Join ${org.name}</button></div>
      </form>`;
  } else if (state === 'other_email') {
    main = html`<div class="alert alert-warning bz-alert" role="status">${icon('alert')}<span>${otherEmailText(inv.emailMasked, user ? user.email : '')}</span></div>
      <div class="bz-inline">${signOutForm({ next: here })}</div>`;
  } else if (state === 'member') {
    main = html`<p>You're already in ${org.name}.</p>
      <p><a class="btn btn-navy bz-btn" href="/business/o/${org.id}">Open ${org.name}</a></p>`;
  } else {
    main = html`<div class="alert alert-info bz-alert" role="status">${icon('clock')}<span>${pendingText(org.name)}</span></div>`;
  }
  const body = html`${cardHead(`Join ${org.name}`, inviteLead(inv, state === 'join' || state === 'accept'))}
    ${errorBox(error)}
    ${main}
    <div class="bz-pub-links">
      ${state === 'join' || state === 'accept' ? html`<p>This link works once and expires at ${expires}.</p>` : ''}
      <p>${NOT_YOURS}</p>
    </div>`;
  return publicPage(ctx, { title: `Join ${org.name}`, body });
}

/**
 * A link that can't be used (410), or a company Tripelyx has paused (403), or any other answer without a
 * landing to show.
 * @param {object} ctx
 * @param {{ title?: string, message: string, user?: object|null }} v signed in: a link to their companies instead of Sign in
 */
function inviteProblemView(ctx, { title = 'This invite link', message, user = null }) {
  const body = html`${cardHead(title, '')}
    <div class="alert alert-info bz-alert" role="status">${icon('info')}<span>${message}</span></div>
    <div class="bz-pub-links">
      ${user ? html`<p><a href="/business/app">Your companies</a></p>` : html`<p>Already in a company? <a href="/business/signin">Sign in</a></p>`}
      <p>Questions: <a href="mailto:${BUSINESS_EMAIL}">${BUSINESS_EMAIL}</a></p>
    </div>`;
  return publicPage(ctx, { title, body });
}

module.exports = { inviteView, inviteProblemView, inviteLead, GONE, NOT_YOURS, JOIN_TAKEN, pendingText, otherEmailText };
