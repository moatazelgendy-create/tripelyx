// /business/o/:orgId/activity (audit.view, plan §B4, §C7): H1 "Activity", newest first, 50 a page with an
// opaque cursor ("Show older"), a group filter. Each row is the entry's plain-English summary, who did it and
// when, in the company's time zone. Budget entries name amounts the company set and trip entries can name
// trips priced on demo data, so the list sits in one demo container with a note saying so (§F6).
const { html } = require('../../lib/html');
const { pageHead, tabs, pager, emptyState } = require('./parts');
const f = require('./format');
const { shellView } = require('./shell');
const { AUDIT_GROUPS } = require('../../business/constants');
const { icon } = require('../icons');

const TITLE = 'Activity';
const EMPTY = 'Nothing here yet.';
const GROUP_LABELS = Object.freeze({
  org: 'Company', member: 'People', department: 'Departments', policy: 'Policy', budget: 'Budgets', request: 'Trips', reports: 'Reports',
});
const AMOUNTS_NOTE = 'Demo prices: amounts here are budgets your company set or trips priced on demo data. Nothing is charged.';

/** Who did it, as the entry snapshotted it: a member's name, "Tripelyx" for the platform, or the system. */
function actorText(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.platformAdmin) return 'Tripelyx';
  if (a.system === 'policy') return 'Automatic, by policy';
  if (a.system === 'clock') return 'Automatic';
  return typeof a.name === 'string' ? a.name : '';
}

/**
 * @param {object} ctx
 * @param {import('../../business/types').ShellModel} shell
 * @param {{ page: import('../../business/types').Page<import('../../business/types').AuditEntry>, group: string|null, moreHref: string|null }} v
 */
function activityView(ctx, shell, { page, group, moreHref }) {
  const { org } = shell;
  const base = `/business/o/${org.id}`;
  const tz = f.safeZone(org.timezone);
  const now = ctx.now();
  const filter = tabs([
    { href: `${base}/activity`, label: 'Everything', current: !group },
    ...AUDIT_GROUPS.map(g => ({ href: `${base}/activity?group=${encodeURIComponent(g)}`, label: GROUP_LABELS[g] || g, current: g === group })),
  ], { label: 'Show activity for' });
  const rows = page.rows.map(e => {
    const who = actorText(e.actor);
    return html`<li class="bz-activity-row">
      <p class="bz-activity-text">${e.summary}</p>
      <p class="bz-meta">${icon('clock')}<span><time datetime="${e.at}">${f.whenIn(tz, e.at, { now })}</time>${who ? ` · ${who}` : ''} · ${GROUP_LABELS[e.group] || e.group}</span></p>
    </li>`;
  });
  const list = rows.length
    ? html`<div class="bz-demo-box bz-activity" data-price-source="demo">
        <ul class="bz-activity-list">${rows}</ul>
        <p class="bz-price-note">${icon('info')}<span>${AMOUNTS_NOTE}</span></p>
      </div>`
    : emptyState({ title: EMPTY, text: group ? 'Try another filter.' : 'Changes your team makes show up here.', iconName: 'clock' });
  const body = html`${pageHead({ title: TITLE, sub: `Times shown in ${f.zoneLabel(tz)}.` })}
    ${filter}
    ${list}
    ${pager(moreHref, 'Show older')}`;
  return shellView(ctx, shell, { title: TITLE, body });
}

module.exports = { activityView, actorText, TITLE, EMPTY, GROUP_LABELS, AMOUNTS_NOTE };
