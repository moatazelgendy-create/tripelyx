// The approvals inbox (/business/o/:orgId/approvals, plan §B4, §H2): tabs "Waiting for you (n)" (oldest
// first) · "Decided by you" · "Company" (approval.override: every pending request) · "Expired" (no actions).
// Each row: traveler, route and dates, the demo-labelled total, "2 policy reasons", waiting since, and
// when it expires ("in 6 h" under Expires). Writes nothing; an expired request shows as expired without
// being stored as such.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const f = require('./format');
const p = require('./parts');
const { places, tripCell, totalCell } = require('./trips');

const TAB_LABELS = Object.freeze({ waiting: 'Waiting for you', decided: 'Decided by you', company: 'Company', expired: 'Expired' });

/** "2 policy reasons" ("Within policy" when none). */
const reasonsText = n => (n > 0 ? f.plural(n, 'policy reason') : 'Within policy');

/**
 * "in 6 h" (under the column or label "Expires"), or "Expired" once the moment has passed.
 * @param {Date} now
 * @param {string|null} expiresAt
 */
function expiresText(now, expiresAt) {
  if (!expiresAt) return '';
  const left = f.timeLeft(now, expiresAt);
  return left ? `in ${left}` : 'Expired';
}

/** The fixed text of each ?ok= code the inbox answers (a decision whose request the decider can no longer open). */
const OK_TEXT = Object.freeze({
  returned: 'The trip changed while it waited, so it went back to the traveler to confirm. Nothing was approved.',
});

/**
 * The inbox rows as a table, for one tab.
 * @param {object} ctx
 * @param {{ base: string, rows: object[], tab: string, timeZone: string, caption: string }} t
 */
function inboxTable(ctx, { base, rows, tab, timeZone, caption, empty = 'Nothing here yet.' }) {
  const map = places(ctx);
  const now = ctx.now();
  const since = r => (r.waitingSince ? f.whenIn(timeZone, r.waitingSince, { now }) : '');
  let columns, cells;
  if (tab === 'decided') {
    columns = [{ label: 'Traveler' }, { label: 'Trip' }, { label: 'Total', num: true }, { label: 'Status' }, { label: 'Policy' }];
    cells = r => [r.travelerName, tripCell(base, map, r), totalCell(r, timeZone), html`${p.statusPill(r.status, { source: r.source })}${r.decidedAs === 'override' ? html`<span class="bz-cell-sub">Decided as an override</span>` : ''}`, reasonsText(r.violationsCount)];
  } else if (tab === 'expired') {
    columns = [{ label: 'Traveler' }, { label: 'Trip' }, { label: 'Total', num: true }, { label: 'Policy' }, { label: 'Expired' }];
    cells = r => [r.travelerName, tripCell(base, map, r), totalCell(r, timeZone), reasonsText(r.violationsCount), r.expiresAt ? f.dateTimeIn(timeZone, r.expiresAt) : ''];
  } else {
    columns = [{ label: 'Traveler' }, { label: 'Trip' }, { label: 'Total', num: true }, { label: 'Policy' }, { label: 'Waiting since' }, { label: 'Expires' }];
    cells = r => [r.travelerName, tripCell(base, map, r), totalCell(r, timeZone), reasonsText(r.violationsCount), since(r), html`<span class="bz-nowrap">${expiresText(now, r.expiresAt)}</span>`];
  }
  return p.dataTable({ caption, columns, rows: (rows || []).map(cells), empty });
}

/**
 * @param {object} ctx
 * @param {{ org: object, member: object, inbox: import('../../business/types').InboxView, override: boolean, ok?: string }} m
 *   ok: a ?ok= code from a decision ('returned'), shown as fixed text
 */
function approvalsView(ctx, { org, inbox, override, ok = '' }) {
  const base = `/business/o/${org.id}`;
  const timeZone = f.safeZone(org.timezone);
  const tab = inbox.tab;
  const keys = ['waiting', 'decided', ...(override ? ['company'] : []), 'expired'];
  const items = keys.map(k => ({
    href: k === 'waiting' ? `${base}/approvals` : `${base}/approvals?tab=${k}`,
    label: TAB_LABELS[k],
    count: k === 'decided' ? null : inbox.counts[k],
    current: k === tab,
  }));
  const empties = {
    waiting: { title: 'Nothing is waiting for you.', text: "Requests from your team arrive here, oldest first. We don't send emails yet, so check back here.", iconName: 'check' },
    decided: { title: "You haven't decided any requests yet.", text: 'Requests you approve or deny show here, newest first.', iconName: 'clock' },
    company: { title: `Nothing is waiting for approval at ${org.name}.`, text: 'Every pending request in the company shows here, oldest first.', iconName: 'users' },
    expired: { title: 'No requests have expired.', text: 'A request nobody decides in time expires and shows here. Nothing is approved.', iconName: 'clock' },
  };
  const captions = { waiting: 'Requests waiting for you, oldest first', decided: 'Requests you decided, newest first', company: `Every pending request at ${org.name}, oldest first`, expired: 'Requests that expired with no decision' };
  const rows = inbox.rows || [];
  const subs = {
    waiting: 'Requests from your team, oldest first. Open one to see the fresh price check and decide.',
    decided: 'Requests you approved or denied.',
    company: 'As an admin you can decide any pending request but your own. A note is needed.',
    expired: 'These expired before anyone decided them. Nothing was approved, and there is nothing to do here.',
  };
  const okText = Object.hasOwn(OK_TEXT, ok) ? OK_TEXT[ok] : null;
  return html`${p.pageHead({ title: 'Approvals', sub: subs[tab] || '' })}
  ${okText ? html`<div class="alert alert-info bz-alert" role="status">${icon('info')}<span>${okText}</span></div>` : ''}
  ${p.tabs(items, { label: 'Approvals' })}
  ${rows.length ? inboxTable(ctx, { base, rows, tab, timeZone, caption: captions[tab] }) : p.emptyState(empties[tab])}
  ${p.pager(inbox.cursor ? `${base}/approvals?tab=${tab}&cursor=${encodeURIComponent(inbox.cursor)}` : null)}`;
}

module.exports = { approvalsView, inboxTable, expiresText, reasonsText };
