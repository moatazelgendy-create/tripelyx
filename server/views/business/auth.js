// The public Tripelyx Business pages' document and their account forms (plan §B2, §B6, §B7): company sign-up
// (/business/start, signed out or signed in) and "Sign in to your company" (/business/signin). They wear the
// corporate chrome (layout({ corporate: true })) with noindex, load business.css for the .bz-pub card, and work
// with Travel by Budget on or off. The routes set Cache-Control no-store and X-Robots-Tag noindex.
//
// Also here: the form-field helpers every 2A page uses (textField, selectField, checkField, fieldError). Values
// and messages are escaped by html``; a field with a message gets aria-invalid and aria-describedby.
const { html, raw } = require('../../lib/html');
const { icon } = require('../icons');
const { layout } = require('../layout');
const { errorBox } = require('./parts');
const { zoneLabel } = require('./format');
const { COMPANY_SIZES, TIMEZONES, DEFAULT_TIMEZONE, BUSINESS_EMAIL } = require('../../business/constants');

/** Where the public pages point. */
const START = '/business/start';
const SIGNIN = '/business/signin';

/** The sign-up copy (§B6). */
const START_TITLE = 'Create your company workspace';
const AT_CAP_TITLE = "You've reached the company limit";
const ZONE_HINT = 'We show times, like when a request expires, in this time zone.';
const EYEBROW = 'Tripelyx Business · Preview';
const START_LEAD = 'Set up your travel policy, budgets and team. Tripelyx confirms each new company before teammates can join.';
const START_LEAD_SELF_SERVE = 'Set up your travel policy, budgets and team.';
const ACK_TEXT = "I understand this is a preview with demo data, and I won't enter real employee travel plans yet.";
const CURRENCY_TEXT = 'US dollars (USD). More currencies later.';
const EMAIL_TAKEN = 'An account with this email already exists. Sign in to add your company to it.';
const ACCOUNT_READY = "Your account is ready, but creating the company didn't work. Try again.";
const SIGNIN_TITLE = 'Sign in to your company';
const INVITE_HINT = 'Got an invite? Open the link you were sent.';

/** "d***@acme.com": an email as a page shows it to its own owner in a sentence. */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '***';
  return `${s.slice(0, 1)}***${s.slice(at)}`;
}

/** 'Africa/Cairo' → 'Cairo time (Africa/Cairo)'; 'UTC' → 'UTC'. */
const zoneOption = z => (z === 'UTC' ? 'UTC' : `${zoneLabel(z)} (${z})`);

// ---------------------------------------------------------------------------------------------------------
// Form fields

const idPart = s => String(s).replace(/[^A-Za-z0-9_-]+/g, '-');

/** The message under a field (nothing without one). */
function fieldError(id, message) {
  return message ? html`<p class="field-error" id="${id}-error">${message}</p>` : '';
}

function described(id, { hint, error }) {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return ids ? html` aria-describedby="${ids}"` : '';
}

/**
 * A labelled text input (site.css .field).
 * @param {{ id: string, name: string, label: string, value?: string|null, type?: string, error?: string|null,
 *   hint?: *, autocomplete?: string, required?: boolean, maxlength?: number, minlength?: number, inputmode?: string,
 *   readonly?: boolean, placeholder?: string, cls?: string }} f
 */
function textField(f) {
  const id = idPart(f.id);
  const value = f.value === null || f.value === undefined ? '' : String(f.value);
  return html`<div class="field${f.cls ? ` ${f.cls}` : ''}">
    <label for="${id}">${f.label}</label>
    <input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${value}"${f.autocomplete ? html` autocomplete="${f.autocomplete}"` : ''}${f.required ? raw(' required') : ''}${f.maxlength ? html` maxlength="${String(f.maxlength)}"` : ''}${f.minlength ? html` minlength="${String(f.minlength)}"` : ''}${f.inputmode ? html` inputmode="${f.inputmode}"` : ''}${f.placeholder ? html` placeholder="${f.placeholder}"` : ''}${f.readonly ? raw(' readonly') : ''}${f.error ? raw(' aria-invalid="true"') : ''}${described(id, f)}>
    ${f.hint ? html`<p class="field-hint" id="${id}-hint">${f.hint}</p>` : ''}
    ${fieldError(id, f.error)}
  </div>`;
}

/**
 * A labelled textarea.
 * @param {{ id: string, name: string, label: string, value?: string|null, error?: string|null, hint?: *,
 *   maxlength?: number, rows?: number, count?: string, required?: boolean }} f count: the id of a parts.charCount hint
 */
function textArea(f) {
  const id = idPart(f.id);
  return html`<div class="field">
    <label for="${id}">${f.label}</label>
    <textarea id="${id}" name="${f.name}" rows="${String(f.rows || 3)}"${f.required ? raw(' required') : ''}${f.maxlength ? html` maxlength="${String(f.maxlength)}"` : ''}${f.count ? html` data-count="${f.count}"` : ''}${f.error ? raw(' aria-invalid="true"') : ''}${described(id, f)}>${f.value === null || f.value === undefined ? '' : String(f.value)}</textarea>
    ${f.hint ? html`<div id="${id}-hint">${f.hint}</div>` : ''}
    ${fieldError(id, f.error)}
  </div>`;
}

/**
 * A labelled select. `options` are [value, label] pairs; `value` picks the selected one.
 * @param {{ id: string, name: string, label: string, options: Array<[string, string]>, value?: string|null,
 *   error?: string|null, hint?: *, required?: boolean, cls?: string }} f
 */
function selectField(f) {
  const id = idPart(f.id);
  const value = f.value === null || f.value === undefined ? '' : String(f.value);
  return html`<div class="field${f.cls ? ` ${f.cls}` : ''}">
    <label for="${id}">${f.label}</label>
    <select id="${id}" name="${f.name}"${f.required ? raw(' required') : ''}${f.error ? raw(' aria-invalid="true"') : ''}${described(id, f)}>
      ${f.options.map(([v, l]) => html`<option value="${v}"${v === value ? raw(' selected') : ''}>${l}</option>`)}
    </select>
    ${f.hint ? html`<p class="field-hint" id="${id}-hint">${f.hint}</p>` : ''}
    ${fieldError(id, f.error)}
  </div>`;
}

/**
 * A checkbox with its label beside it (business.css .bz-choice).
 * @param {{ id: string, name: string, label: *, checked?: boolean, value?: string, error?: string|null,
 *   required?: boolean, disabled?: boolean }} f
 */
function checkField(f) {
  const id = idPart(f.id);
  return html`<div class="bz-check-field">
    <label class="bz-choice${f.disabled ? ' is-disabled' : ''}" for="${id}"><input type="checkbox" id="${id}" name="${f.name}" value="${f.value || '1'}"${f.checked ? raw(' checked') : ''}${f.required ? raw(' required') : ''}${f.disabled ? raw(' disabled') : ''}${f.error ? raw(' aria-invalid="true"') : ''}${f.error ? html` aria-describedby="${id}-error"` : ''}><span>${f.label}</span></label>
    ${fieldError(id, f.error)}
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// The public document

/**
 * A public Business page on the corporate chrome with noindex.
 * @param {object} ctx
 * @param {{ title: string, body: *, wide?: boolean, description?: string }} page
 */
function publicPage(ctx, { title, body, wide = false, description }) {
  return layout({
    title: `${title} · Business`,
    description: description || 'Tripelyx Business: company travel with your travel policy, approvals and department budgets built in.',
    active: 'business',
    body: html`<div class="bz-pub-main"><div class="container"><div class="bz-pub-card${wide ? ' bz-pub-wide' : ''}">${body}</div></div></div>`,
    styles: ['/css/business.css'],
    bodyClass: 'bz-pub',
    ctx,
    noindex: true,
    corporate: true,
  });
}

/** The eyebrow and heading of a public card. */
function cardHead(title, lead) {
  return html`<p class="eyebrow bz-pub-eyebrow">${EYEBROW}</p><h1>${title}</h1>${lead ? html`<p class="bz-pub-lead">${lead}</p>` : ''}`;
}

/** The sign-out button (POST /business/signout), with where to land afterwards. */
function signOutForm({ next = '', label = 'Sign out' } = {}) {
  return html`<form class="bz-inline-form" method="post" action="/business/signout">${next ? html`<input type="hidden" name="next" value="${next}">` : ''}<button class="btn btn-ghost bz-btn" type="submit">${label}</button></form>`;
}

/**
 * The 403 page of the company admin pages (http.gates forbiddenView): a Business page saying why, with the
 * way back to the member's companies, instead of the app's generic error page. The gate passes no company,
 * so it cannot draw the workspace shell itself.
 * @param {object} ctx
 * @param {{ message: string, reason?: 'role'|'suspended' }} info
 */
function workspaceForbiddenView(ctx, { message, reason = 'role' } = {}) {
  const title = reason === 'suspended' ? 'This workspace is paused' : "Your role can't open this page";
  const text = String(message || '');
  const at = text.indexOf(BUSINESS_EMAIL);
  const said = at < 0 ? text : html`${text.slice(0, at)}<a href="mailto:${BUSINESS_EMAIL}">${BUSINESS_EMAIL}</a>${text.slice(at + BUSINESS_EMAIL.length)}`;
  const body = html`${cardHead(title, '')}
    <div class="alert alert-info bz-alert" role="status">${icon('info')}<span>${said}</span></div>
    <p class="bz-inline"><a class="btn btn-navy bz-btn" href="/business/app">Your companies</a></p>`;
  return publicPage(ctx, { title, body });
}

// ---------------------------------------------------------------------------------------------------------
// Sign-up

function companyFields(values, errors) {
  const sizes = [['', 'Choose a size'], ...COMPANY_SIZES.map(s => [s, s])];
  const zones = TIMEZONES.map(z => [z, zoneOption(z)]);
  return html`<fieldset class="bz-fieldset">
    <legend>Your company</legend>
    <div class="bz-stack">
      ${textField({ id: 'bz-company', name: 'companyName', label: 'Company name', value: values.companyName, error: errors.name, required: true, maxlength: 80, autocomplete: 'organization' })}
      ${selectField({ id: 'bz-size', name: 'size', label: 'Company size', options: sizes, value: values.size, error: errors.size, required: true })}
      ${selectField({ id: 'bz-timezone', name: 'timezone', label: 'Company time zone', options: zones, value: values.timezone || DEFAULT_TIMEZONE, error: errors.timezone, hint: ZONE_HINT })}
      <div class="field"><span class="label">Currency</span><p class="bz-pub-fixed">${CURRENCY_TEXT}</p></div>
    </div>
  </fieldset>`;
}

/**
 * /business/start.
 * @param {object} ctx
 * @param {{ user?: object|null, values?: object, accountErrors?: Record<string, string>,
 *   companyErrors?: Record<string, string>, error?: string|null, emailTaken?: boolean, accountReady?: boolean,
 *   atCap?: string|null, selfServe?: boolean }} v
 *   user: the signed-in user (the signed-in variant shows the company fields only); accountErrors keyed by
 *   name, email and password (accounts.register); companyErrors keyed as createCompany keys them (name, size,
 *   timezone, ack; the company name field is companyName); accountReady: the account was just made but the
 *   company was not; atCap: the "You're already in 3 companies" message (no form then)
 */
function startView(ctx, { user = null, values = {}, accountErrors = {}, companyErrors = {}, error = null, emailTaken = false, accountReady = false, atCap = null, selfServe = false } = {}) {
  const lead = user
    ? `You're signed in as ${user.name} (${maskEmail(user.email)}). Your company workspace uses this sign-in. Your personal trips stay private: your company can't see them.`
    : selfServe ? START_LEAD_SELF_SERVE : START_LEAD;
  const takenBox = emailTaken
    ? html`<div class="alert alert-error bz-alert" role="alert">${icon('alert')}<span>${EMAIL_TAKEN} <a href="${SIGNIN}?next=${encodeURIComponent(START)}">Sign in</a></span></div>`
    : '';
  const form = atCap ? '' : html`<form class="bz-form bz-pub-form" method="post" action="${START}">
    ${user ? '' : html`<fieldset class="bz-fieldset">
      <legend>Your account</legend>
      <div class="bz-stack">
        ${textField({ id: 'bz-name', name: 'name', label: 'Your name', value: values.name, error: accountErrors.name, required: true, maxlength: 80, autocomplete: 'name' })}
        ${textField({ id: 'bz-email', name: 'email', label: 'Work email', type: 'email', value: values.email, error: accountErrors.email, required: true, maxlength: 120, autocomplete: 'email' })}
        ${textField({ id: 'bz-password', name: 'password', label: 'Password', type: 'password', error: accountErrors.password, required: true, minlength: 10, maxlength: 200, autocomplete: 'new-password', hint: 'At least 10 characters.' })}
      </div>
    </fieldset>`}
    ${companyFields(values, companyErrors)}
    ${checkField({ id: 'bz-ack', name: 'ack', label: ACK_TEXT, checked: values.ack === '1', error: companyErrors.ack, required: true })}
    <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Create workspace</button></div>
  </form>`;
  const title = atCap ? AT_CAP_TITLE : START_TITLE;
  const body = html`${cardHead(title, lead)}
    ${accountReady ? html`<div class="alert alert-info bz-alert" role="status">${icon('info')}<span>${ACCOUNT_READY}</span></div>` : ''}
    ${takenBox}${errorBox(error)}
    ${atCap ? html`<div class="alert alert-info bz-alert" role="status">${icon('info')}<span>${atCap}</span></div><p><a class="btn btn-navy bz-btn" href="/business/app">Your companies</a></p>` : ''}
    ${form}
    <div class="bz-pub-links">
      ${user
    ? html`<p>Not ${user.name}?</p>${signOutForm({ next: START })}`
    : html`<p>Already have an account? <a href="${SIGNIN}?next=${encodeURIComponent(START)}">Sign in</a> and add your company to it.</p>`}
      <p>${INVITE_HINT}</p>
      <p>Questions: <a href="mailto:${BUSINESS_EMAIL}">${BUSINESS_EMAIL}</a></p>
    </div>`;
  return publicPage(ctx, { title, body });
}

// ---------------------------------------------------------------------------------------------------------
// Sign-in

/**
 * /business/signin.
 * @param {object} ctx
 * @param {{ values?: { email?: string }, error?: string|null, next?: string|null, invite?: boolean }} v
 *   next: a same-site path to land on (kept in a hidden field); invite: next is an invite landing
 */
function signinView(ctx, { values = {}, error = null, next = null, invite = false } = {}) {
  const body = html`${cardHead(SIGNIN_TITLE, invite ? 'Sign in with the account for your invite, and you will come back to it to join.' : 'Use your Tripelyx account. Every company you belong to opens from here.')}
    ${errorBox(error)}
    <form class="bz-form bz-pub-form" method="post" action="${SIGNIN}">
      ${next ? html`<input type="hidden" name="next" value="${next}">` : ''}
      ${textField({ id: 'bz-signin-email', name: 'email', label: 'Email', type: 'email', value: values.email, required: true, maxlength: 120, autocomplete: 'email' })}
      ${textField({ id: 'bz-signin-password', name: 'password', label: 'Password', type: 'password', required: true, maxlength: 200, autocomplete: 'current-password' })}
      <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Sign in</button></div>
    </form>
    <div class="bz-pub-links">
      <p>New company? <a href="${START}">Create a workspace</a></p>
      <p>${INVITE_HINT}</p>
    </div>`;
  return publicPage(ctx, { title: SIGNIN_TITLE, body });
}

module.exports = {
  startView, signinView, publicPage, cardHead, signOutForm, maskEmail, zoneOption, workspaceForbiddenView,
  textField, textArea, selectField, checkField, fieldError,
  START, SIGNIN, START_TITLE, AT_CAP_TITLE, ZONE_HINT, EYEBROW, START_LEAD, ACK_TEXT, CURRENCY_TEXT, EMAIL_TAKEN, ACCOUNT_READY, SIGNIN_TITLE, INVITE_HINT,
};
