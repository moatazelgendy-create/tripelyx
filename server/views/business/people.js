// /business/o/:orgId/people (members.view, plan §B4 "Policy, budgets and people", §B6): members (name, role,
// department, manager, approver, tier; email only with members.manage), the invite form ("Create invite link":
// a private link the admin copies, since we don't send email yet), pending invites with Revoke, departments
// (add, rename, archive with departments.manage) and warnings such as "Sam has no one who can approve their trips".
// Every change is its own small form (POST, 303 back here); a member's edit form sits in a <details> under them,
// and Remove in a second <details> of its own, so removing someone takes two deliberate steps.
// Only active members are listed: listMembers also returns removed ones (for names on old records).
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const { pageHead, kvList, dataTable, emptyState, pager, notice: noticeBox } = require('./parts');
const f = require('./format');
const { shellView } = require('./shell');
const { textField, selectField } = require('./auth');
const { LABELS, can, assignableBy } = require('../../business/roles');
const { resolveApprover } = require('../../business/approver');
const { TIERS, TIER_LABELS } = require('../../business/constants');

const TITLE = 'People';
const ALONE = "It's just you so far. Invite your team with a private link you copy and send.";
const NO_EMAIL_NOTE = "We don't send email yet. You'll get a private link to copy and send yourself.";
const NO_APPROVER = 'No one yet: set a manager or an approver';
const ADMINS = 'Company admins';
const APPROVER_HINT = 'Who approves trips outside the policy. Without one, their manager does, else the company admins.';

/** A member as approver.resolveApprover reads it, from a MemberView (one company, so one orgId). */
const asRecord = m => ({
  userId: m.userId, orgId: 'org', role: m.role, status: m.status, at: m.at,
  approverId: m.approver ? m.approver.userId : null, managerId: m.manager ? m.manager.userId : null,
});

/** Every member by user id, as records, for resolveApprover and the manager's status. */
function recordsById(lists) {
  const out = {};
  for (const list of lists) for (const m of list || []) if (m && typeof m.userId === 'string') out[m.userId] = asRecord(m);
  return out;
}

/** Who approves this member's trips outside the policy, said the way the rule works today. */
function approverText(m, byId, nameOf) {
  const r = resolveApprover(asRecord(m), byId);
  if (r.rule === 'approver') return nameOf(r.approverId);
  if (r.rule === 'manager') return `${nameOf(r.approverId)} (their manager)`;
  if (r.rule === 'admin') return ADMINS;
  return html`<span class="bz-warn-text">${NO_APPROVER}</span>`;
}

/** "Sam Rivera has no one who can approve their trips." for each active member with no approver at all. */
function approverWarnings(active, byId, me) {
  return active.filter(m => resolveApprover(asRecord(m), byId).rule === null)
    .map(m => (m.userId === me ? 'You have no one who can approve your trips.' : `${m.name} has no one who can approve their trips.`));
}

/** Members who can approve trips (the manager and approver choices): roles holding approval.decide. */
const approverChoices = members => members.filter(m => m.status === 'active' && can(m.role, 'approval.decide'));

/** [value, label] options: '' first, then people, keeping `current` even when it is no longer a usual choice. */
function personOptions(choices, { none, current = null, except = null, everyone = [] }) {
  const list = choices.filter(m => m.userId !== except);
  const opts = list.map(m => [m.userId, `${m.name} (${m.roleLabel || LABELS[m.role]})`]);
  if (current && !list.some(m => m.userId === current)) {
    const cur = everyone.find(m => m.userId === current);
    opts.push([current, cur ? `${cur.name} (${cur.roleLabel || LABELS[cur.role]})` : 'Someone no longer listed']);
  }
  return [['', none], ...opts];
}

function departmentOptions(departments, { none = 'No department', current = null } = {}) {
  const active = departments.filter(d => !d.archivedAt);
  const opts = active.map(d => [d.id, d.name]);
  const cur = current ? departments.find(d => d.id === current) : null;
  if (cur && cur.archivedAt) opts.push([cur.id, `${cur.name} (archived)`]);
  return [['', none], ...opts];
}

const tierOptions = () => TIERS.map(t => [t, TIER_LABELS[t]]);
const roleOptions = roles => roles.map(r => [r, LABELS[r]]);

function inviteSection(ctx, { org, base, assignable, departments, choices, everyone, values, errors }) {
  const v = values || {};
  const e = errors || {};
  return html`<section class="bz-section" id="invite" aria-labelledby="bz-invite-title">
    <h2 id="bz-invite-title">Invite someone</h2>
    <p>${NO_EMAIL_NOTE}${org.status === 'pending' ? ` They can join once Tripelyx confirms ${org.name}.` : ''}</p>
    <form class="bz-card bz-stack" method="post" action="${base}/people/invite">
      <div class="bz-grid-fields bz-grid-3">
        ${textField({ id: 'bz-inv-email', name: 'email', label: 'Email', type: 'email', value: v.email, error: e.email, required: true, maxlength: 120, autocomplete: 'off' })}
        ${selectField({ id: 'bz-inv-role', name: 'role', label: 'Role', options: roleOptions(assignable), value: v.role || 'employee', error: e.role })}
        ${selectField({ id: 'bz-inv-dep', name: 'departmentId', label: 'Department', options: departmentOptions(departments), value: v.departmentId, error: e.departmentId })}
        ${selectField({ id: 'bz-inv-manager', name: 'managerId', label: 'Manager', options: personOptions(choices, { none: 'No manager', everyone }), value: v.managerId, error: e.managerId })}
        ${selectField({ id: 'bz-inv-approver', name: 'approverId', label: 'Approver (optional)', options: personOptions(choices, { none: 'Manager decides', everyone }), value: v.approverId, error: e.approverId, hint: APPROVER_HINT })}
        ${selectField({ id: 'bz-inv-tier', name: 'tier', label: 'Policy tier', options: tierOptions(), value: v.tier || 'standard', error: e.tier })}
      </div>
      <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Create invite link</button></div>
    </form>
  </section>`;
}

function memberCard(m, { base, orgName, me, manage, assignable, departments, choices, everyone, byId, nameOf }) {
  const editable = manage && assignable.includes(m.role);
  const manager = m.manager ? byId[m.manager.userId] : null;
  const facts = kvList([
    ['Department', m.department ? m.department.name : 'None'],
    // A removed manager no longer approves anything: say so rather than name them as if they did.
    ['Manager', !m.manager ? 'None' : manager && manager.status !== 'active' ? `None (${m.manager.name} was removed)` : m.manager.name],
    ['Approver', approverText(m, byId, nameOf)],
    ['Policy tier', TIER_LABELS[m.tier] || m.tier],
  ]);
  const id = `bz-m-${m.userId}`;
  const edit = editable ? html`<details class="bz-more">
      <summary>Change role, department or tier<span class="sr-only"> for ${m.name}</span></summary>
      <form class="bz-stack" method="post" action="${base}/people/${m.userId}">
        <input type="hidden" name="rev" value="${String(m.rev)}">
        <div class="bz-grid-fields">
          ${selectField({ id: `${id}-role`, name: 'role', label: 'Role', options: roleOptions(assignable), value: m.role })}
          ${selectField({ id: `${id}-dep`, name: 'departmentId', label: 'Department', options: departmentOptions(departments, { current: m.department ? m.department.id : null }), value: m.department ? m.department.id : '' })}
          ${selectField({ id: `${id}-manager`, name: 'managerId', label: 'Manager', options: personOptions(choices, { none: 'No manager', current: m.manager ? m.manager.userId : null, except: m.userId, everyone }), value: m.manager ? m.manager.userId : '' })}
          ${selectField({ id: `${id}-approver`, name: 'approverId', label: 'Approver', options: personOptions(choices, { none: 'Manager decides', current: m.approver ? m.approver.userId : null, except: m.userId, everyone }), value: m.approver ? m.approver.userId : '', hint: APPROVER_HINT })}
          ${selectField({ id: `${id}-tier`, name: 'tier', label: 'Policy tier', options: tierOptions(), value: m.tier })}
        </div>
        <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Save changes</button></div>
      </form>
    </details>` : '';
  // Its own disclosure, apart from Save: opening it says what happens, and only the button inside removes.
  const remove = editable && m.userId !== me ? html`<details class="bz-more bz-remove">
      <summary>Remove ${m.name}</summary>
      <form class="bz-stack" method="post" action="${base}/people/${m.userId}/remove">
        <input type="hidden" name="rev" value="${String(m.rev)}">
        <p>${m.name} loses access to ${orgName} right away. They keep their Tripelyx account and personal trips, and their requests stay in the company's records.</p>
        <div class="bz-inline"><button class="btn bz-btn bz-btn-danger" type="submit">Yes, remove ${m.name}</button></div>
      </form>
    </details>` : '';
  return html`<li class="bz-card bz-stack" id="person-${m.userId}">
    <div class="bz-card-head"><h3>${m.name}${m.userId === me ? html` <span class="bz-meta">(you)</span>` : ''}</h3><span class="bz-pill">${m.roleLabel || LABELS[m.role]}</span></div>
    ${m.email ? html`<p class="bz-meta">${m.email}</p>` : ''}
    ${facts}
    ${edit}
    ${remove}
  </li>`;
}

function invitesSection({ base, invites, assignable, timezone, notice = null }) {
  const rows = invites.map(i => [
    i.email,
    i.roleLabel,
    i.departmentName || 'None',
    f.dateTimeIn(timezone, i.expiresAt),
    assignable.includes(i.role)
      ? html`<form class="bz-inline-form" method="post" action="${base}/people/invites/${i.publicId}/revoke"><button class="btn btn-ghost bz-btn" type="submit">Revoke<span class="sr-only"> the invite for ${i.email}</span></button></form>`
      : '',
  ]);
  return html`<section class="bz-section" id="invites" aria-labelledby="bz-invites-title">
    <h2 id="bz-invites-title">Pending invites</h2>
    ${noticeBox(notice)}
    ${dataTable({
    caption: 'Pending invites', columns: [{ label: 'Email' }, { label: 'Role' }, { label: 'Department' }, { label: 'Expires' }, { label: 'Actions' }],
    rows, empty: 'No pending invites. A link stops working once it is used, revoked or expired.',
  })}
  </section>`;
}

/**
 * @param {{ base: string, departments: object[], manage: boolean, notice?: string|null,
 *   form?: { departmentId: string, name: string, error: string }|null }} s form: a refused add or rename, so
 *   its field shows what was typed and the message (departmentId '' for the new-department form)
 */
function departmentsSection({ base, departments, manage, notice = null, form = null }) {
  const active = departments.filter(d => !d.archivedAt);
  const archived = departments.filter(d => d.archivedAt);
  const typed = depId => (form && form.departmentId === depId ? form : null);
  const row = d => html`<li class="bz-card bz-stack">
    <div class="bz-card-head"><h3>${d.name}</h3></div>
    ${manage ? html`<form class="bz-stack" method="post" action="${base}/departments">
        <input type="hidden" name="departmentId" value="${d.id}"><input type="hidden" name="rev" value="${String(d.rev ?? 0)}">
        ${textField({ id: `bz-dep-${d.id}`, name: 'name', label: `Rename ${d.name}`, value: typed(d.id) ? typed(d.id).name : d.name, error: typed(d.id) ? typed(d.id).error : null, required: true, maxlength: 80 })}
        <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Rename<span class="sr-only"> ${d.name}</span></button></div>
      </form>
      <form class="bz-subset" method="post" action="${base}/departments">
        <input type="hidden" name="departmentId" value="${d.id}"><input type="hidden" name="rev" value="${String(d.rev ?? 0)}"><input type="hidden" name="archive" value="1">
        <div class="bz-inline"><button class="btn btn-ghost bz-btn" type="submit">Archive<span class="sr-only"> ${d.name}</span></button></div>
        <p class="bz-meta">Its budgets and history stay. People in it keep it until you change their department.</p>
      </form>` : ''}
  </li>`;
  return html`<section class="bz-section" id="departments" aria-labelledby="bz-deps-title">
    <h2 id="bz-deps-title">Departments</h2>
    ${noticeBox(notice)}
    ${active.length ? html`<ul class="bz-grid">${active.map(row)}</ul>` : html`<p>No departments yet.</p>`}
    ${manage ? html`<form class="bz-card bz-stack" method="post" action="${base}/departments">
      ${textField({ id: 'bz-dep-new', name: 'name', label: 'New department', value: typed('') ? typed('').name : '', error: typed('') ? typed('').error : null, required: true, maxlength: 80 })}
      <div class="bz-inline"><button class="btn btn-navy bz-btn" type="submit">Add department</button></div>
    </form>` : ''}
    ${archived.length ? html`<p class="bz-meta">Archived: ${archived.map(d => d.name).join(', ')}</p>` : ''}
  </section>`;
}

/**
 * The People page.
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ people: import('../../business/types').PeopleView, everyone: object[], moreHref?: string|null,
 *   invite?: { values?: object, errors?: Record<string, string> }, notice?: string|null, noticeAt?: string|null,
 *   department?: { departmentId: string, name: string, error: string }|null, error?: string|null }} v
 *   everyone: every member of the company (MemberView, for the manager and approver choices); noticeAt:
 *   'departments' or 'invites' when the notice answers a form in that section (the 303 lands on its #fragment,
 *   so the notice is drawn there, where the browser scrolls, and not at the top)
 */
function peopleView(ctx, shell, { people, everyone, moreHref = null, invite = {}, notice = null, noticeAt = null, department = null, error = null }) {
  const { org, member } = shell;
  const base = `/business/o/${org.id}`;
  const manage = can(member.role, 'members.manage');
  const depManage = can(member.role, 'departments.manage');
  const assignable = manage ? [...assignableBy(member.role)] : [];
  const departments = people.departments || [];
  const choices = approverChoices(everyone);
  const byId = recordsById([everyone, people.members]);
  const names = new Map([...(everyone || []), ...people.members].map(m => [m.userId, m.name]));
  const nameOf = userId => names.get(userId) || 'Someone no longer listed';
  const active = people.members.filter(m => m.status === 'active');
  const everyoneActive = (everyone && everyone.length ? everyone : people.members).filter(m => m.status === 'active');
  const warnings = everyoneActive.length ? approverWarnings(everyoneActive, byId, member.userId) : (people.warnings || []);
  const shared = { base, orgName: org.name, me: member.userId, manage, assignable, departments, choices, everyone, byId, nameOf };
  const at = noticeAt === 'departments' || noticeAt === 'invites' ? noticeAt : null;
  const invitesShown = manage && Array.isArray(people.invites);
  const body = html`${pageHead({ title: TITLE, sub: `${f.plural(people.memberCount, 'person', 'people')} in ${org.name}` })}
    ${warnings.length ? html`<div class="alert alert-warning bz-alert" role="status">${icon('alert')}<div><p>Check who approves these trips:</p><ul class="bz-warnings">${warnings.map(w => html`<li>${w}</li>`)}</ul></div></div>` : ''}
    ${manage ? inviteSection(ctx, { org, base, assignable, departments, choices, everyone, values: invite.values, errors: invite.errors }) : ''}
    <section class="bz-section" id="members" aria-labelledby="bz-members-title">
      <h2 id="bz-members-title">Members</h2>
      ${people.memberCount <= 1 ? emptyState({ title: ALONE, iconName: 'users' }) : ''}
      <ul class="bz-grid">${active.map(m => memberCard(m, shared))}</ul>
      ${pager(moreHref, 'More people')}
    </section>
    ${invitesShown ? invitesSection({ base, invites: people.invites, assignable, timezone: org.timezone, notice: at === 'invites' ? notice : null }) : ''}
    ${departmentsSection({ base, departments, manage: depManage, notice: at === 'departments' ? notice : null, form: department })}`;
  const top = at === 'departments' || (at === 'invites' && invitesShown) ? null : notice;
  return shellView(ctx, shell, { title: TITLE, body, notice: top, error });
}

module.exports = { peopleView, approverChoices, approverText, TITLE, ALONE, NO_EMAIL_NOTE, NO_APPROVER, ADMINS };
