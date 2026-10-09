// /business/o/:orgId/activity (audit.view, plan §B4, §C7): H1 "Activity", newest first, 50 a page with an
// opaque cursor ("Show older"), a group filter. Each row is the entry's plain-English summary, who did it and
// when, in the company's time zone. Budget entries name amounts the company set and trip entries can name
// trips priced on demo data, so with demo inventory the list sits in one demo container with a note saying so
// (§F6). With real suppliers (real-suppliers design §2.3) the container and its note follow the workspace's
// price source: supplier test data gets the dashed outline, the TEST DATA tag and "Includes supplier test
// data". With no supplier (www and production) the amounts are the company's own budgets and limits, in a plain
// list with a note that says so and no price label.
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
/** With no supplier (www and production today, go-live design §3.4): the amounts listed are the company's own. */
const AMOUNTS_NOTE_PLAIN = 'Amounts here are budgets and limits your company set.';
/** The note by the workspace's price source ('demo' is AMOUNTS_NOTE, as before). */
const AMOUNTS_NOTES = Object.freeze({
  demo: AMOUNTS_NOTE,
  sandbox: 'Includes supplier test data: amounts here are budgets your company set or trips priced on supplier test data. Nothing is charged.',
  live: f.LIVE_UNCOUNTED,
});

/** Who did it, as the entry snapshotted it: a member's name, "Tripelyx" for the platform, or the system. */
function actorText(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.platformAdmin) return 'Tripelyx';
  if (a.system === 'policy') return 'Automatic, by policy';
  if (a.system === 'clock') return 'Automatic';
  return typeof a.name === 'string' ? a.name : '';
}

/**
 * The summary as a row shows it: when it opens with the actor's name, their own trip is "their trip"
 * ("Sam Rivera asked for approval of their trip", not "... of Sam Rivera's trip").
 */
function summaryText(summary, who) {
  const text = String(summary || '');
  if (!who || !text.startsWith(`${who} `)) return text;
  return who + text.slice(who.length).split(`${who}'s trip`).join('their trip');
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
    // The meta line names who did it only when the summary doesn't already start with them.
    const named = who && String(e.summary || '').startsWith(`${who} `);
    return html`<li class="bz-activity-row">
      <p class="bz-activity-text">${summaryText(e.summary, who)}</p>
      <p class="bz-meta">${icon('clock')}<span><time datetime="${e.at}">${f.whenIn(tz, e.at, { now })}</time>${who && !named ? ` · ${who}` : ''} · ${GROUP_LABELS[e.group] || e.group}</span></p>
    </li>`;
  });
  // Where the amounts listed come from: the workspace's source. With no supplier (or none known) the amounts
  // are budgets the company set, never demo prices or test data.
  const source = f.ctxSource(ctx);
  const list = !rows.length ? null : !source
    ? html`<div class="bz-activity"><ul class="bz-activity-list">${rows}</ul>
          <p class="bz-meta bz-activity-note">${icon('info')}<span>${AMOUNTS_NOTE_PLAIN}</span></p>
        </div>`
    : source === 'demo'
      ? html`<div class="bz-demo-box bz-activity" data-price-source="demo">
          <ul class="bz-activity-list">${rows}</ul>
          <p class="bz-price-note">${icon('info')}<span>${AMOUNTS_NOTE}</span></p>
        </div>`
      : html`<div class="bz-demo-box bz-activity${source === 'sandbox' ? ' bz-price-test' : ''}" data-price-source="${source}">
          <ul class="bz-activity-list">${rows}</ul>
          <p class="bz-price-note">${icon('info')}${source === 'sandbox' ? html`<span class="bz-test-tag">TEST DATA</span>` : ''}<span>${AMOUNTS_NOTES[source] || AMOUNTS_NOTE}</span></p>
        </div>`;
  const listOrEmpty = list || emptyState({ title: EMPTY, text: group ? 'Try another filter.' : 'Changes your team makes show up here.', iconName: 'clock' });
  const body = html`${pageHead({ title: TITLE, sub: `Times shown in ${f.zoneLabel(tz)}.` })}
    ${filter}
    ${listOrEmpty}
    ${pager(moreHref, 'Show older')}`;
  return shellView(ctx, shell, { title: TITLE, body });
}

module.exports = { activityView, actorText, summaryText, TITLE, EMPTY, GROUP_LABELS, AMOUNTS_NOTE, AMOUNTS_NOTES, AMOUNTS_NOTE_PLAIN };
