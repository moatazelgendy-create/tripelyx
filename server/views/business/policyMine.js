// "Your travel policy" (/business/o/:orgId/policy, plan §B4, §B6): the member's own tier in plain words
// (policy/describe.describe through service.getPolicy), and how the company handles trips outside it.
// Policy limits are written in dollars; the page labels them beside the demo prices they are compared with.
const { html } = require('../../lib/html');
const { icon } = require('../icons');
const f = require('./format');
const p = require('./parts');

/**
 * @param {object} ctx
 * @param {{ org: object, member: object, policy: import('../../business/types').PolicyView }} m
 */
function policyMineView(ctx, { org, policy }) {
  const base = `/business/o/${org.id}`;
  const d = policy.description || { title: 'Your travel policy', sub: '', lines: [] };
  const settings = org.settings || {};
  const hours = Number.isInteger(settings.approvalHours) ? settings.approvalHours : 24;
  const handling = settings.outOfPolicy === 'block'
    ? `At ${org.name}, trips outside the policy can't be requested. Pick options marked Within Policy as you search.`
    : `At ${org.name}, you can request a trip outside the policy with a short reason. Your approver decides within ${f.plural(hours, 'hour')}, or the request expires and nothing is approved.`;
  const status = ctx.business && ctx.business.inventory ? ctx.business.inventory.status : 'none';
  const searchable = status !== 'none';
  const demo = status === 'demo';
  return html`${p.pageHead({
    title: d.title || 'Your travel policy',
    sub: d.sub || `${policy.tierLabel} policy, version ${policy.version}`,
    actions: searchable ? html`<a class="btn btn-navy bz-btn" href="${base}/trips/new">${icon('plane')}<span>Plan a trip</span></a>` : '',
  })}
  ${p.demoBox(html`<h2 class="bz-block-title">${icon('shield')}<span>What your policy allows</span></h2>
    ${d.lines.length ? html`<ul class="bz-policy-lines">${d.lines.map(l => html`<li>${icon('check')}<span>${l}</span></li>`)}</ul>` : html`<p>Your policy has no limits set.</p>`}
    <p class="bz-muted">${demo ? 'Limits are in US dollars. In this preview, the fares and rates they are checked against are demo prices.' : 'Limits are in US dollars.'}</p>`, { pricedAt: null, timeZone: f.safeZone(org.timezone), tag: 'section', cls: 'bz-card bz-policy', label: 'What your policy allows' })}
  <section class="bz-card" aria-labelledby="bz-handling-title">
    <h2 class="bz-block-title" id="bz-handling-title">${icon('info')}<span>Trips outside the policy</span></h2>
    <p>${handling}</p>
    <p class="bz-muted">As you search, every option shows Within Policy, Out of Policy or Blocked by policy, with the reason.</p>
  </section>`;
}

module.exports = { policyMineView };
