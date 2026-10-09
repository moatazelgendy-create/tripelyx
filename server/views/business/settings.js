// /business/o/:orgId/settings (org.view to read, plan §B4, §C4, §I6): the company name and time zone
// (settings.company), how trips outside the policy are handled, how long an approval waits and the budget
// period (settings.travel), the currency (USD only), and the company's data: download it as JSON
// (POST /settings/export, settings.company) or write to go@tripelyx.com to delete it. One form posts every
// field this member may change with the org rev it was loaded at (409 when a setting changed since). A
// confirmed company is warned before saving that a new name goes back to Tripelyx to confirm (§I6).
const { html, raw } = require('../../lib/html');
const { pageHead, kvList } = require('./parts');
const f = require('./format');
const { shellView } = require('./shell');
const { textField, selectField, zoneOption, CURRENCY_TEXT } = require('./auth');
const { OUT_OF_POLICY } = require('./policies');
const { TIMEZONES, APPROVAL_HOURS_RANGE, BUSINESS_EMAIL } = require('../../business/constants');

const TITLE = 'Settings';
const RENAME_WARNING = 'Changing the name sends your company back to Tripelyx to confirm. Until then, no one new can join.';
const BOOK_FIRST = 'Book first, approver can cancel within 24 hours. Available once booking is live.';
const PERIODS = Object.freeze([['quarter', 'Quarter'], ['month', 'Month']]);
const DELETE_TEXT = `To delete this company's data, write to ${BUSINESS_EMAIL}.`;

/** A form value as text: what was posted (after a 422) or else the saved value. */
function pick(values, key, saved) {
  return values && Object.hasOwn(values, key) && typeof values[key] === 'string' ? values[key] : saved === null || saved === undefined ? '' : String(saved);
}

/**
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ org: import('../../business/types').Org, rev?: number|null, canCompany: boolean, canTravel: boolean, selfServe: boolean,
 *   values?: Record<string, string>, errors?: Record<string, string>, notice?: string|null, error?: string|null }} v
 *   org: getOrg(); rev: the posted form's rev after a 422 (else org.rev); values/errors: the posted form and
 *   the 422 details by field
 */
function settingsView(ctx, shell, { org, rev = null, canCompany, canTravel, selfServe, values = {}, errors = {}, notice = null, error = null }) {
  const base = `/business/o/${org.id}`;
  const s = org.settings || {};
  const mode = pick(values, 'outOfPolicy', s.outOfPolicy) === 'block' ? 'block' : 'approval';
  const [minH, maxH] = APPROVAL_HOURS_RANGE;
  const warnRename = org.status === 'active' && !selfServe;
  const company = canCompany
    ? html`<fieldset class="bz-fieldset bz-stack"><legend>Company</legend>
        ${textField({ id: 'bz-set-name', name: 'name', label: 'Company name', value: pick(values, 'name', org.name), error: errors.name, maxlength: 80, required: true, autocomplete: 'organization', hint: warnRename ? RENAME_WARNING : '' })}
        ${selectField({ id: 'bz-set-zone', name: 'timezone', label: 'Time zone', options: TIMEZONES.map(z => [z, zoneOption(z)]), value: pick(values, 'timezone', org.timezone), error: errors.timezone, hint: 'Approval deadlines, activity and demo price times show in this zone.' })}
      </fieldset>`
    : html`<section class="bz-card bz-stack" aria-labelledby="bz-set-company"><h2 id="bz-set-company">Company</h2>
        ${kvList([['Name', org.name], ['Time zone', zoneOption(f.safeZone(org.timezone))]])}
        ${canTravel ? html`<p class="bz-meta">Only an Owner can change the name and time zone.</p>` : ''}
      </section>`;
  const travel = canTravel
    ? html`<fieldset class="bz-fieldset bz-stack"><legend>Travel rules</legend>
        <fieldset class="bz-fieldset"><legend>When a trip is outside the policy</legend>
          <div class="bz-choices">
            ${['approval', 'block'].map(m => html`<label class="bz-choice"><input type="radio" name="outOfPolicy" value="${m}"${m === mode ? raw(' checked') : ''}><span>${OUT_OF_POLICY[m]}</span></label>`)}
            <label class="bz-choice is-disabled"><input type="radio" name="outOfPolicyLater" value="book_first" disabled><span>${BOOK_FIRST}</span></label>
          </div>
          ${errors.outOfPolicy ? html`<p class="field-error" role="alert">${errors.outOfPolicy}</p>` : ''}
        </fieldset>
        ${textField({ id: 'bz-set-hours', name: 'approvalHours', label: 'Hours an approver has to decide', value: pick(values, 'approvalHours', s.approvalHours), error: errors.approvalHours, inputmode: 'numeric', maxlength: 3, required: true, hint: `From ${minH} to ${maxH} hours. After that, the request expires and the traveler can send it again.` })}
        ${selectField({ id: 'bz-set-period', name: 'budgetPeriod', label: 'Budget period', options: PERIODS, value: pick(values, 'budgetPeriod', s.budgetPeriod), error: errors.budgetPeriod, hint: 'Department budgets are set per quarter or per month.' })}
      </fieldset>`
    : html`<section class="bz-card bz-stack" aria-labelledby="bz-set-travel"><h2 id="bz-set-travel">Travel rules</h2>
        ${kvList([
    ['Trips outside the policy', OUT_OF_POLICY[s.outOfPolicy === 'block' ? 'block' : 'approval']],
    ['Hours an approver has to decide', Number.isInteger(s.approvalHours) ? String(s.approvalHours) : ''],
    ['Budget period', s.budgetPeriod === 'month' ? 'Month' : 'Quarter'],
  ])}
      </section>`;
  const form = canCompany || canTravel
    ? html`<form class="bz-stack" method="post" action="${base}/settings">
        <input type="hidden" name="rev" value="${String(Number.isInteger(rev) ? rev : org.rev ?? 0)}">
        ${company}
        ${travel}
        <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Save settings</button></div>
      </form>`
    : html`${company}${travel}`;
  const money = html`<section class="bz-card bz-stack" aria-labelledby="bz-set-money"><h2 id="bz-set-money">Currency</h2><p>${CURRENCY_TEXT}</p></section>`;
  const data = canCompany
    ? html`<section class="bz-card bz-stack" aria-labelledby="bz-set-data"><h2 id="bz-set-data">Your company's data</h2>
        <p>Download everything ${org.name} keeps in Tripelyx Business as one JSON file: settings, people, departments, policies, budgets, trip requests and activity.</p>
        <form class="bz-inline-form" method="post" action="${base}/settings/export"><button class="btn btn-ghost bz-btn" type="submit">Download company data</button></form>
        <p class="bz-meta">${DELETE_TEXT}</p>
      </section>`
    : html`<p class="bz-meta">An Owner can download ${org.name}'s data or ask Tripelyx to delete it.</p>`;
  const sub = canCompany || canTravel ? `How ${org.name} works in Tripelyx Business.` : `How ${org.name} works in Tripelyx Business. Owners and Travel Admins can change these.`;
  const body = html`${pageHead({ title: TITLE, sub })}
    ${form}
    ${money}
    ${data}`;
  return shellView(ctx, shell, { title: TITLE, body, notice, error });
}

module.exports = { settingsView, TITLE, RENAME_WARNING, BOOK_FIRST, DELETE_TEXT };
