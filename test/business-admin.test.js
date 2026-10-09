// Stage 2A: the company administration pages and the platform admin page (plan §B4, §B6, §I6, §I8): welcome,
// people (invite by a private copy link, roles, removal), departments, policies with versions and history,
// budgets, reports with the CSV download, activity, settings with the rename warning and the data export, and
// /admin/business. Run over HTTP on the real modules (demo inventory, the policy engine), one confirmed company
// with an Owner, a Travel Admin, a Manager, an Employee and Finance. Every POST is same-origin unless a test
// says otherwise; who may do what follows roles.js (Finance gets 403 on edits, a Manager sees only their own
// department's budget, a platform admin gets 404 inside a company). Every amount sits in a demo container.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { seedUser, client, noInline } = require('./business-helpers');
const { KINDS } = require('../server/business/constants');
const { Repo } = require('../server/business/repo');
const { auditInsert } = require('../server/business/actor');

const textOf = page => String(page).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const decode = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const mainOf = page => (String(page).match(/<main[\s\S]*<\/main>/) || [''])[0];
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });
const REASON = 'The board meets at the client office, and this is the only flight that lands in time.';
const STALE = 'Someone changed this while you were looking. Here is the latest version.';

/** The fields a browser would send for the form posting to `action` (inputs, checked boxes, selects, textareas). */
function formOf(page, action) {
  const m = new RegExp(`<form[^>]*action="${escRe(action)}"[^>]*>([\\s\\S]*?)</form>`).exec(page);
  assert.ok(m, `a form posting to ${action}`);
  const body = m[1];
  const attr = (tag, name) => { const a = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return a ? decode(a[1]) : null; };
  const has = (tag, name) => new RegExp(`\\s${name}(\\s|>|=|$)`).test(tag);
  const out = [];
  for (const [tag] of body.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, 'name');
    if (!name || has(tag, 'disabled')) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && !has(tag, 'checked')) continue;
    out.push([name, attr(tag, 'value') ?? (type === 'checkbox' ? 'on' : '')]);
  }
  for (const [, open, inner] of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(open, 'name');
    if (!name) continue;
    const opts = [...inner.matchAll(/<option\b([^>]*)>/g)].map(o => o[1]);
    const chosen = opts.find(o => has(o, 'selected')) || opts[0];
    out.push([name, attr(chosen, 'value') ?? '']);
  }
  for (const [, open, inner] of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = attr(open, 'name');
    if (name) out.push([name, decode(inner)]);
  }
  return out;
}
/** POST a list of [name, value] pairs (repeated names kept). */
const postPairs = (c, path, pairs) => c.raw(path, new URLSearchParams(pairs).toString(), 'application/x-www-form-urlencoded');
const setPair = (pairs, name, value) => pairs.map(([k, v]) => [k, k === name ? value : v]);

/**
 * Every amount ($ and digits) on the page sits inside a data-price-source="demo" container that says "Demo
 * price" (Stage 3's honesty check, §F6). Returns the number of containers.
 */
function assertDemoMoney(page, label) {
  let s = mainOf(page);
  let n = 0;
  for (;;) {
    const open = /<([a-z]+)\b[^>]*data-price-source="demo"[^>]*>/.exec(s);
    if (!open) break;
    const tag = open[1];
    const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'g');
    re.lastIndex = open.index + open[0].length;
    let depth = 1, end = -1, mm;
    while ((mm = re.exec(s))) {
      depth += mm[0].startsWith('</') ? -1 : 1;
      if (depth === 0) { end = re.lastIndex; break; }
    }
    assert.ok(end > 0, `${label}: a closed demo container`);
    const box = s.slice(open.index, end);
    if (/\$\d/.test(textOf(box))) assert.match(textOf(box), /Demo price/, `${label}: a demo container with an amount says "Demo price"`);
    s = s.slice(0, open.index) + s.slice(end);
    n += 1;
  }
  assert.doesNotMatch(textOf(s), /\$\d/, `${label}: no amount outside a demo container`);
  assert.doesNotMatch(s, /bz-money/, `${label}: no money element outside a demo container`);
  return n;
}

/** One confirmed company (Acme Inc) with five roles, built through the service, and an Engineering Q4 2026 budget. */
async function world(env = {}) {
  const app = await startApp({ ENABLE_BUSINESS: 'true', BUSINESS_AUTH_LIMIT: '1000', BUSINESS_WRITE_LIMIT: '1000', ADMIN_EMAILS: 'ops@example.com', ...env });
  const svc = app.business;
  const ops = await seedUser(app, { name: 'Pat Platform', email: 'ops@example.com' });
  await app.accounts.grantPlatformAdmin(ops.user.id, { by: 'test' });
  const admin = { user: { ...ops.user, isAdmin: true } };
  const owner = await seedUser(app, { name: 'Olivia Owner', email: 'olivia@acme.example' });
  let { org } = await svc.createCompany({ user: owner.user }, { name: 'Acme Inc', size: '11-50 people', ack: '1' });
  org = await svc.platformSetStatus(admin, org.id, { status: 'active', rev: org.rev });
  const as = u => ({ org: { id: org.id }, user: u.user });
  owner.actor = as(owner);
  const eng = await svc.saveDepartment(owner.actor, { name: 'Engineering' });
  const join = async (name, email, role, extra = {}) => {
    const u = await seedUser(app, { name, email });
    const { token } = await svc.invite(owner.actor, { email: u.user.email, role, ...extra });
    await svc.acceptInvite({ user: u.user }, token);
    return { ...u, actor: as(u) };
  };
  const tom = await join('Tom Travel', 'tom@acme.example', 'travel_admin');
  const dana = await join('Dana Lee', 'dana@acme.example', 'manager', { departmentId: eng.id });
  const sam = await join('Sam Rivera', 'sam@acme.example', 'employee', { departmentId: eng.id, managerId: dana.user.id });
  const fay = await join('Fay Finance', 'fay@acme.example', 'finance');
  await svc.setBudget(fay.actor, eng.id, '2026-Q4', null, '20000');
  const c = who => client(app.base, who.cookie);
  return { app, svc, admin, ops, org, owner, eng, tom, dana, sam, fay, o: `/business/o/${org.id}`, c, join };
}

/** Sam's two trips in Q4 2026: one inside the policy (approved by policy) and one in Business class waiting for Dana. */
async function trips(w) {
  const { svc, sam } = w;
  const pick = (sv, leg, f) => sv.legs[leg].rows.find(f).row.key;
  const sv = await svc.searchTrip(sam.actor, Q);
  const ok = r => r.row.available && r.row.carrier.code === 'ZA' && r.evaluation.status === 'within';
  const within = await svc.createRequest(sam.actor, {
    query: Q, purpose: 'Client workshop in London',
    selection: { out: pick(sv, 'out', ok), back: pick(sv, 'back', ok), hotelKey: pick(sv, 'hotel', r => r.row.available && r.row.stars === 3 && r.evaluation.status === 'within') },
  });
  const approved = (await svc.submit(sam.actor, within.id, { rev: within.rev })).request;
  const q = { ...Q, cabin: 'business' };
  const bv = await svc.searchTrip(sam.actor, q);
  const zm = r => r.row.available && r.row.carrier.code === 'ZM';
  const out = await svc.createRequest(sam.actor, { query: q, purpose: 'Board meeting in London', selection: { out: pick(bv, 'out', zm), back: pick(bv, 'back', zm), hotelKey: pick(bv, 'hotel', r => r.row.available && r.row.stars === 5) } });
  const pending = (await svc.submit(sam.actor, out.id, { rev: out.rev, reason: REASON, category: '' })).request;
  assert.equal(approved.status, 'approved');
  assert.equal(pending.status, 'pending');
  return { approved, pending };
}

// ---------------------------------------------------------------------------------------------------------

test('welcome: the Owner sees the setup checklist; another role gets 403 naming it; a stranger and the platform admin get 404', async t => {
  const w = await world();
  t.after(w.app.close);
  const res = await w.c(w.owner).get(`${w.o}/welcome`);
  assert.equal(res.status, 200);
  const text = textOf(res.text);
  assert.match(text, /Welcome to Tripelyx Business/);
  for (const [label, href] of [['Review your policy', '/policies'], ['Add departments and budgets', '/people#departments'], ['Invite your team', '/people#invite'], ['Try a demo trip', '/trips/new']]) {
    assert.ok(text.includes(label), label);
    assert.match(res.text, new RegExp(`href="${escRe(w.o + href)}"`), href);
  }
  noInline('welcome', res.text);
  const tom = await w.c(w.tom).get(`${w.o}/welcome`);
  assert.equal(tom.status, 403);
  assert.match(textOf(tom.text), /Your role \(Travel Admin\) can't open this page\. Ask a travel admin at Acme Inc if you need it\./);
  const stranger = await seedUser(w.app, { name: 'Stan Stranger' });
  assert.equal((await client(w.app.base, stranger.cookie).get(`${w.o}/welcome`)).status, 404);
  assert.equal((await client(w.app.base, w.ops.cookie).get(`${w.o}/welcome`)).status, 404);
  const anon = await client(w.app.base).get(`${w.o}/welcome`);
  assert.equal(anon.status, 303);
  assert.equal(anon.location, `/business/signin?next=${encodeURIComponent(`${w.o}/welcome`)}`);
});

test('people: an invite is a private link to copy; the page says "We don\'t send email yet", shows the link once and sends no referrer', async t => {
  const w = await world();
  t.after(w.app.close);
  const c = w.c(w.owner);
  const people = await c.get(`${w.o}/people`);
  assert.equal(people.status, 200);
  assert.match(textOf(people.text), /We don't send email yet\. You'll get a private link to copy and send yourself\./);
  assert.match(textOf(people.text), /5 people in Acme Inc/);
  assert.match(people.text, /sam@acme\.example/, 'emails show with members.manage');
  const res = await c.post(`${w.o}/people/invite`, { email: 'kim@acme.example', role: 'employee', departmentId: w.eng.id, managerId: w.dana.user.id, approverId: '', tier: 'director' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('cache-control'), /no-store/);
  const text = textOf(res.text);
  assert.match(text, /Invite ready for kim@acme\.example/);
  assert.match(text, /We don't send email yet\./);
  assert.match(text, /Director/);
  const link = /value="(http:\/\/127\.0\.0\.1:\d+\/business\/invite\/[A-Za-z0-9_-]{20,})"/.exec(res.text);
  assert.ok(link, 'the full link, ready to copy');
  noInline('invite link', res.text);
  // The link works, signed out, and the page lists the invite once without the token.
  const path = new URL(link[1]).pathname;
  const landing = await client(w.app.base).get(path);
  assert.equal(landing.status, 200);
  assert.match(textOf(landing.text), /Olivia Owner invited kim@acme\.example to join as Employee in Engineering\./);
  const again = await c.get(`${w.o}/people`);
  assert.match(textOf(again.text), /Pending invites/);
  assert.match(again.text, /kim@acme\.example/);
  assert.ok(!again.text.includes(path.split('/').pop()), 'the token is never shown again');
  // A second invite for the same address replaces the first.
  const second = await c.post(`${w.o}/people/invite`, { email: 'kim@acme.example', role: 'employee', tier: 'standard' });
  assert.match(textOf(second.text), /This replaces the earlier invite for this email\./);
  assert.equal((await client(w.app.base).get(path)).status, 410);
  // Bad input and refusals come back on the People page.
  const bad = await c.post(`${w.o}/people/invite`, { email: 'not-an-email', role: 'employee', tier: 'standard' });
  assert.equal(bad.status, 422);
  assert.match(textOf(bad.text), /Enter a valid email address\./);
  assert.match(bad.text, /value="not-an-email"/, 'what was typed is kept');
  const member = await c.post(`${w.o}/people/invite`, { email: 'sam@acme.example', role: 'employee', tier: 'standard' });
  assert.equal(member.status, 409);
  const tomOwner = await w.c(w.tom).post(`${w.o}/people/invite`, { email: 'boss@acme.example', role: 'owner', tier: 'standard' });
  assert.equal(tomOwner.status, 403);
  assert.match(textOf(tomOwner.text), /Your role \(Travel Admin\) can't give that role\. Ask an Owner\./);
  assert.match(textOf(tomOwner.text), /Invite someone/, 'still the People page');
  // Revoke.
  const inv = (await w.svc.listMembers(w.owner.actor)).invites.find(i => i.email === 'kim@acme.example');
  const revoked = await c.post(`${w.o}/people/invites/${inv.publicId}/revoke`, {});
  assert.equal(revoked.status, 303);
  assert.equal(revoked.location, `${w.o}/people?ok=revoked#invites`);
  assert.match(textOf((await c.get(`${w.o}/people?ok=revoked`)).text), /Invite revoked\. That link no longer works\./);
  // Finance sees People without emails or forms, and cannot invite; an Employee cannot open it.
  const fin = await w.c(w.fay).get(`${w.o}/people`);
  assert.equal(fin.status, 200);
  assert.doesNotMatch(fin.text, /sam@acme\.example/);
  assert.doesNotMatch(fin.text, /people\/invite/);
  assert.equal((await w.c(w.fay).post(`${w.o}/people/invite`, { email: 'x@acme.example', role: 'employee' })).status, 403);
  assert.equal((await w.c(w.sam).get(`${w.o}/people`)).status, 403);
});

test('people: change a role, department and tier; remove a member; a stale form is 409; the last Owner cannot remove themselves', async t => {
  const w = await world();
  t.after(w.app.close);
  const c = w.c(w.owner);
  const page = await c.get(`${w.o}/people`);
  const action = `${w.o}/people/${w.sam.user.id}`;
  const fields = formOf(page.text, action);
  const changed = setPair(setPair(fields, 'role', 'manager'), 'tier', 'executive');
  const res = await postPairs(c, action, changed);
  assert.equal(res.status, 303);
  assert.equal(res.location, `${w.o}/people?ok=member`);
  const sam = await w.svc.repo.get(KINDS.member, `${w.org.id}.${w.sam.user.id}`);
  assert.deepEqual([sam.role, sam.tier, sam.departmentId], ['manager', 'executive', w.eng.id]);
  const stale = await postPairs(c, action, setPair(fields, 'tier', 'standard'));
  assert.equal(stale.status, 409);
  assert.match(textOf(stale.text), new RegExp(escRe(STALE)));
  // Remove.
  const fresh = await c.get(`${w.o}/people`);
  const removeAction = `${w.o}/people/${w.sam.user.id}/remove`;
  const removed = await postPairs(c, removeAction, formOf(fresh.text, removeAction));
  assert.equal(removed.status, 303);
  assert.equal((await w.svc.repo.get(KINDS.member, `${w.org.id}.${w.sam.user.id}`)).status, 'removed');
  assert.equal((await w.c(w.sam).get(`${w.o}/settings`)).status, 404, 'a removed member is a stranger');
  // No remove form for yourself; a forged one is refused on the page.
  assert.ok(!fresh.text.includes(`action="${w.o}/people/${w.owner.user.id}/remove"`));
  const self = await c.post(`${w.o}/people/${w.owner.user.id}/remove`, { rev: '0' });
  assert.ok([409, 422].includes(self.status), String(self.status));
  assert.match(textOf(self.text), /People/);
  // Finance cannot change anyone.
  assert.equal((await w.c(w.fay).post(action, { role: 'employee', rev: '0' })).status, 403);
});

test('departments: add, rename and archive; a duplicate name is refused; Finance gets 403', async t => {
  const w = await world();
  t.after(w.app.close);
  const c = w.c(w.owner);
  const add = await c.post(`${w.o}/departments`, { name: 'Sales' });
  assert.equal(add.status, 303);
  assert.equal(add.location, `${w.o}/people?ok=department#departments`);
  const dup = await c.post(`${w.o}/departments`, { name: 'sales' });
  assert.equal(dup.status, 409);
  assert.match(textOf(dup.text), /There is already a department with this name\./);
  const sales = (await w.svc.listDepartments(w.owner.actor)).find(d => d.name === 'Sales');
  const rename = await c.post(`${w.o}/departments`, { departmentId: sales.id, rev: String(sales.rev), name: 'Sales and Marketing' });
  assert.equal(rename.status, 303);
  const renamed = (await w.svc.listDepartments(w.owner.actor)).find(d => d.id === sales.id);
  assert.equal(renamed.name, 'Sales and Marketing');
  const archive = await c.post(`${w.o}/departments`, { departmentId: sales.id, rev: String(renamed.rev), archive: '1' });
  assert.equal(archive.status, 303);
  assert.equal(archive.location, `${w.o}/people?ok=archived#departments`);
  const page = await c.get(`${w.o}/people?ok=archived`);
  assert.match(textOf(page.text), /Department archived\./);
  assert.match(textOf(page.text), /Archived: Sales and Marketing/);
  assert.equal((await w.c(w.fay).post(`${w.o}/departments`, { name: 'Finance team' })).status, 403);
  assert.equal((await w.c(w.tom).post(`${w.o}/departments`, { name: 'Ops' })).status, 303, 'a Travel Admin manages departments');
});

test('policies: every tier at a glance in a demo container; the editor round-trips unchanged, saves a new version with a note, shows field errors, and answers a stale form with the latest version', async t => {
  const w = await world();
  t.after(w.app.close);
  const c = w.c(w.owner);
  const all = await c.get(`${w.o}/policies`);
  assert.equal(all.status, 200);
  for (const tier of ['Standard', 'Director', 'Executive']) assert.match(textOf(all.text), new RegExp(`${tier} policy`), tier);
  assert.match(textOf(all.text), /Demo prices: in this preview, these limits are checked against demo flight and hotel prices only\./);
  assert.ok(assertDemoMoney(all.text, '/policies') >= 3);
  assert.match(textOf(all.text), /Trips outside the policy/);
  // The editor, exactly as a browser would send it back: nothing changed.
  const action = `${w.o}/policies/standard`;
  const editor = await c.get(action);
  assert.equal(editor.status, 200);
  assertDemoMoney(editor.text, 'editor');
  noInline('editor', editor.text);
  const fields = formOf(editor.text, action);
  assert.ok(fields.some(([k]) => k === 'hotel.default'));
  const same = await postPairs(c, action, fields);
  assert.equal(same.status, 303);
  assert.equal(same.location, `${action}?ok=unchanged`);
  // A change with a note: version 2.
  const changed = setPair(setPair(fields, 'hotel.default', '210'), 'note', 'Hotels cost more this year.');
  const saved = await postPairs(c, action, changed);
  assert.equal(saved.status, 303);
  assert.equal(saved.location, `${action}?ok=saved`);
  const after = await c.get(saved.location);
  assert.match(textOf(after.text), /Saved as a new version\./);
  assert.match(textOf(after.text), /Version 2\. Changed by Olivia Owner/);
  const history = await c.get(`${action}/history`);
  assert.equal(history.status, 200);
  const h = textOf(history.text);
  assert.match(h, /Version 2/);
  assert.match(h, /What changed: Hotels cost more this year\./);
  assert.match(h, /\$180/);
  assert.match(h, /\$210/);
  assertDemoMoney(history.text, 'history');
  // The old form again: 409 with the latest rules in the fields.
  const stale = await postPairs(c, action, setPair(fields, 'hotel.default', '190'));
  assert.equal(stale.status, 409);
  assert.match(textOf(stale.text), new RegExp(escRe(STALE)));
  assert.match(stale.text, /name="hotel\.default"[^>]*value="210"/);
  // A bad value: 422, what was typed kept, the message by the field and at the top.
  const fresh = formOf((await c.get(action)).text, action);
  const bad = await postPairs(c, action, setPair(fresh, 'hotel.default', 'lots'));
  assert.equal(bad.status, 422);
  assert.match(bad.text, /name="hotel\.default"[^>]*value="lots"/);
  assert.match(bad.text, /aria-invalid="true"/);
  assert.match(textOf(bad.text), /Check the highlighted fields\./);
  // Unknown tier: 404.
  assert.equal((await c.get(`${w.o}/policies/platinum`)).status, 404);
  // How trips outside the policy are handled, from the policies page.
  const handling = await c.post(`${w.o}/settings`, { rev: String((await w.svc.getOrg(w.owner.actor)).rev), from: 'policies', outOfPolicy: 'block' });
  assert.equal(handling.status, 303);
  assert.equal(handling.location, `${w.o}/policies?ok=handling`);
  assert.equal((await w.svc.getOrg(w.owner.actor)).settings.outOfPolicy, 'block');
});

test('policies: Finance reads every tier but gets 403 on a save; a Manager and an Employee cannot open the company policies', async t => {
  const w = await world();
  t.after(w.app.close);
  const fin = w.c(w.fay);
  const page = await fin.get(`${w.o}/policies/standard`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, new RegExp(`<form[^>]*action="${escRe(`${w.o}/policies/standard`)}"`), 'read-only for Finance');
  assert.match(textOf(page.text), /Owners and Travel Admins can change policies\./);
  const overview = await fin.get(`${w.o}/policies`);
  assert.doesNotMatch(overview.text, /name="outOfPolicy"/);
  assert.equal((await fin.post(`${w.o}/policies/standard`, { rev: '0', 'hotel.default': '999' })).status, 403);
  assert.equal((await w.svc.getPolicy(w.owner.actor, 'standard')).version, 1, 'nothing saved');
  assert.equal((await w.c(w.dana).get(`${w.o}/policies`)).status, 403);
  assert.equal((await w.c(w.sam).get(`${w.o}/policies/standard/history`)).status, 403);
  // A Travel Admin edits.
  const tom = w.c(w.tom);
  const action = `${w.o}/policies/director`;
  const fields = formOf((await tom.get(action)).text, action);
  assert.equal((await postPairs(tom, action, setPair(fields, 'hotel.default', '260'))).status, 303);
});

test('budgets: Finance sets a budget; the table shows budget, committed, awaiting and remaining in a demo container; a Manager sees only their own department; an Employee gets 403', async t => {
  const w = await world();
  t.after(w.app.close);
  const sales = await w.svc.saveDepartment(w.owner.actor, { name: 'Sales' });
  await w.svc.setBudget(w.fay.actor, sales.id, '2026-Q4', null, '5000');
  await trips(w);
  const fin = w.c(w.fay);
  const page = await fin.get(`${w.o}/budgets`);
  assert.equal(page.status, 200);
  const text = textOf(page.text);
  assert.match(text, /Budgets Q4 2026/);
  for (const col of ['Budget', 'Committed', 'Awaiting approval', 'Remaining']) assert.ok(text.includes(col), col);
  assert.match(text, /\$20,000/);
  assert.match(text, /Spent: shows once real bookings exist\./);
  assertDemoMoney(page.text, 'budgets');
  noInline('budgets', page.text);
  // Set a new amount from the page's own form.
  const fields = formOf(page.text, `${w.o}/budgets`);
  assert.ok(fields.length, 'a budget form');
  const engForm = (() => {
    const m = [...page.text.matchAll(/<form[^>]*action="[^"]*\/budgets"[^>]*>([\s\S]*?)<\/form>/g)].find(f => f[1].includes(w.eng.id));
    return formOf(m[0], `${w.o}/budgets`);
  })();
  const set = await postPairs(fin, `${w.o}/budgets`, setPair(engForm, 'amount', '25000'));
  assert.equal(set.status, 303);
  assert.equal(set.location, `${w.o}/budgets?period=2026-Q4&ok=budget`);
  const after = await fin.get(set.location);
  assert.match(textOf(after.text), /Budget saved\./);
  assert.match(textOf(after.text), /\$25,000/);
  const bad = await postPairs(fin, `${w.o}/budgets`, setPair(engForm, 'amount', 'twenty'));
  assert.equal(bad.status, 422);
  assert.match(bad.text, /value="twenty"/);
  const stale = await postPairs(fin, `${w.o}/budgets`, setPair(engForm, 'amount', '30000'));
  assert.equal(stale.status, 409, 'the form was at the old rev');
  // Another period, with nothing set: says so, never $0 budgets.
  const empty = await fin.get(`${w.o}/budgets?period=2027-Q1`);
  assert.match(textOf(empty.text), /No budgets for Q1 2027\. Without a budget, trips are checked against the policy only\./);
  assert.match(textOf(empty.text), /No budget set/);
  assertDemoMoney(empty.text, 'empty period');
  assert.equal((await fin.get(`${w.o}/budgets?period=nope`)).status, 422);
  // The Manager: Engineering only, no forms.
  const mgr = await w.c(w.dana).get(`${w.o}/budgets`);
  assert.equal(mgr.status, 200);
  assert.match(textOf(mgr.text), /Engineering/);
  assert.doesNotMatch(textOf(mgr.text), /Sales/);
  assert.doesNotMatch(mgr.text, /method="post"[^>]*\/budgets"/);
  assert.equal((await w.c(w.dana).post(`${w.o}/budgets`, { departmentId: w.eng.id, period: '2026-Q4', rev: '1', amount: '1' })).status, 403);
  // A Travel Admin reads but cannot set; an Employee cannot open it.
  const tom = await w.c(w.tom).get(`${w.o}/budgets`);
  assert.equal(tom.status, 200);
  assert.match(textOf(tom.text), /Sales/);
  assert.equal((await w.c(w.tom).post(`${w.o}/budgets`, { departmentId: w.eng.id, period: '2026-Q4', rev: '1', amount: '1' })).status, 403);
  assert.equal((await w.c(w.sam).get(`${w.o}/budgets`)).status, 403);
});

test('reports: an empty period says "No requests yet" (never $0); a busy one shows the tiles, the list and Coming soon; the CSV downloads with the filters', async t => {
  const w = await world();
  t.after(w.app.close);
  const fin = w.c(w.fay);
  const empty = await fin.get(`${w.o}/reports?period=2026-Q4`);
  assert.equal(empty.status, 200);
  assert.match(textOf(empty.text), /Reports for Q4 2026/);
  assert.match(textOf(empty.text), /No requests yet/);
  assert.doesNotMatch(textOf(empty.text), /\$0\b/);
  for (const soon of ['Spend booked', 'Invoices']) assert.match(textOf(empty.text), new RegExp(`${soon} Coming soon`), soon);
  await trips(w);
  const page = await fin.get(`${w.o}/reports?period=2026-Q4`);
  const text = textOf(page.text);
  assert.match(text, /Waiting for approval: 1/);
  assert.match(text, /Approved to book: 1/);
  assert.match(text, /50%/);
  assert.match(text, /1 of 2 sent requests were outside the policy or blocked\./);
  assert.match(text, /Sam Rivera/);
  assert.equal((page.text.match(new RegExp(`href="${escRe(w.o)}/trips/btr_`, 'g')) || []).length, 2);
  assert.ok(assertDemoMoney(page.text, 'reports') >= 3);
  noInline('reports', page.text);
  const pendingOnly = await fin.get(`${w.o}/reports?period=2026-Q4&status=pending`);
  assert.equal((pendingOnly.text.match(new RegExp(`href="${escRe(w.o)}/trips/btr_`, 'g')) || []).length, 1);
  const badFilter = await fin.get(`${w.o}/reports?period=2026-Q4&status=lost`);
  assert.equal(badFilter.status, 422);
  // The CSV: the page's own export form, filters included.
  const action = `${w.o}/reports/export`;
  const csv = await postPairs(fin, action, formOf(pendingOnly.text, action));
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="tripelyx-requests-2026-Q4.csv"');
  assert.match(csv.headers.get('cache-control'), /no-store/);
  const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.match(lines[0], /^price_source,request_id/);
  assert.equal(lines.length, 2, 'the header and the one pending request');
  assert.match(lines[1], /^Demo price,btr_/);
  const audit = (await w.svc.listAudit(w.owner.actor, { group: 'reports' })).rows;
  assert.equal(audit[0].action, 'reports.exported');
  // Who may: Owner, Travel Admin and Finance read; Manager and Employee get 403.
  assert.equal((await w.c(w.tom).get(`${w.o}/reports`)).status, 200);
  assert.equal((await w.c(w.dana).get(`${w.o}/reports`)).status, 403);
  assert.equal((await w.c(w.sam).post(action, { period: '2026-Q4' })).status, 403);
});

test('activity: newest first with who and when, a group filter and "Show older"; a Manager gets 403', async t => {
  const w = await world();
  t.after(w.app.close);
  const c = w.c(w.fay);
  const page = await c.get(`${w.o}/activity`);
  assert.equal(page.status, 200);
  const text = textOf(page.text);
  assert.match(text, /Activity/);
  assert.match(text, /Times shown in Cairo time\./);
  assert.match(text, /Fay Finance set the Engineering budget for Q4 2026 to \$20,000/);
  assert.match(text, /Tripelyx confirmed Acme Inc/);
  assert.ok(text.indexOf('Fay Finance set the Engineering budget') < text.indexOf('Tripelyx confirmed Acme Inc'), 'newest first');
  assertDemoMoney(page.text, 'activity');
  noInline('activity', page.text);
  const budgets = await c.get(`${w.o}/activity?group=budget`);
  assert.match(textOf(budgets.text), /set the Engineering budget/);
  assert.doesNotMatch(textOf(budgets.text), /Tripelyx confirmed/);
  assert.match(budgets.text, /aria-current="page"[^>]*>\s*<span>Budgets/);
  const unknown = await c.get(`${w.o}/activity?group=nope`);
  assert.equal(unknown.status, 200);
  assert.match(textOf(unknown.text), /Tripelyx confirmed/);
  // Sixty more entries: "Show older" pages through them.
  const repo = new Repo({ store: w.app.store, now: w.app.ctx.now });
  await repo.commit({ inserts: Array.from({ length: 60 }, (_, i) => auditInsert(repo, { orgId: w.org.id, actor: { userId: w.owner.user.id, name: 'Olivia Owner', role: 'owner' }, action: 'department.created', target: { kind: KINDS.department, id: `dep_${i}` }, summary: `Olivia Owner added the Team ${i} department` })) });
  const first = await c.get(`${w.o}/activity`);
  const older = /href="([^"]*\/activity\?cursor=[^"]+)"/.exec(first.text);
  assert.ok(older, 'Show older');
  assert.match(textOf(first.text), /Show older/);
  const second = await c.get(decode(older[1]));
  assert.equal(second.status, 200);
  assert.match(textOf(second.text), /Tripelyx confirmed Acme Inc/);
  assert.equal((await c.get(`${w.o}/activity?cursor=garbage`)).status, 404);
  assert.equal((await w.c(w.dana).get(`${w.o}/activity`)).status, 403);
});

test('settings: the Owner is warned that a rename sends the company back to Tripelyx, and it does; a Travel Admin changes only travel rules; an Employee reads; the data export downloads', async t => {
  const w = await world();
  t.after(w.app.close);
  const c = w.c(w.owner);
  const page = await c.get(`${w.o}/settings`);
  assert.equal(page.status, 200);
  const text = textOf(page.text);
  assert.match(text, /Changing the name sends your company back to Tripelyx to confirm\. Until then, no one new can join\./);
  assert.match(text, /Book first, approver can cancel within 24 hours\. Available once booking is live\./);
  assert.match(page.text, /<input[^>]*name="outOfPolicyLater"[^>]*disabled/);
  assert.match(text, /US dollars \(USD\)\. More currencies later\./);
  assert.match(text, /To delete this company's data, write to go@tripelyx\.com\./);
  noInline('settings', page.text);
  const action = `${w.o}/settings`;
  const fields = formOf(page.text, action);
  // A bad value: 422 with the field message and what was typed.
  const bad = await postPairs(c, action, setPair(fields, 'approvalHours', '2'));
  assert.equal(bad.status, 422);
  assert.match(bad.text, /name="approvalHours"[^>]*value="2"/);
  // Rename: back to pending, said on the next page.
  const renamed = await postPairs(c, action, setPair(fields, 'name', 'Acme Travel Group'));
  assert.equal(renamed.status, 303);
  assert.equal(renamed.location, `${action}?ok=renamed`);
  const org = await w.svc.repo.get(KINDS.org, w.org.id);
  assert.deepEqual([org.name, org.status], ['Acme Travel Group', 'pending']);
  const after = await c.get(renamed.location);
  assert.match(textOf(after.text), /Settings saved\. Tripelyx will confirm the new name before anyone else can join\./);
  assert.match(textOf(after.text), /Tripelyx is confirming Acme Travel Group\./);
  assert.doesNotMatch(textOf(after.text), /Changing the name sends your company back/, 'no warning while already pending');
  // The same form again is stale.
  assert.equal((await postPairs(c, action, setPair(fields, 'approvalHours', '30'))).status, 409);
  // Travel Admin: travel rules only.
  const tomC = w.c(w.tom);
  const tomPage = await tomC.get(action);
  assert.doesNotMatch(tomPage.text, /name="name"/);
  assert.match(textOf(tomPage.text), /Only an Owner can change the name and time zone\./);
  const tomFields = formOf(tomPage.text, action);
  const ok = await postPairs(tomC, action, setPair(setPair(tomFields, 'approvalHours', '48'), 'outOfPolicy', 'block'));
  assert.equal(ok.status, 303);
  assert.equal(ok.location, `${action}?ok=saved`);
  const s = (await w.svc.getOrg(w.owner.actor)).settings;
  assert.deepEqual([s.approvalHours, s.outOfPolicy], [48, 'block']);
  const forged = await postPairs(tomC, action, [...formOf((await tomC.get(action)).text, action), ['name', 'Tom Co']]);
  assert.equal(forged.status, 403);
  assert.equal((await w.svc.getOrg(w.owner.actor)).name, 'Acme Travel Group');
  // Employee reads, with no form; Finance too.
  const emp = await w.c(w.sam).get(action);
  assert.equal(emp.status, 200);
  assert.doesNotMatch(emp.text, new RegExp(`action="${escRe(action)}`), 'no settings form');
  assert.match(textOf(emp.text), /Owners and Travel Admins can change these\./);
  assert.equal((await w.c(w.sam).post(action, { rev: '9', approvalHours: '30' })).status, 403);
  assert.equal((await w.c(w.fay).post(action, { rev: '9', approvalHours: '30' })).status, 403);
  // The export: JSON attachment for the Owner only.
  const exp = await c.post(`${action}/export`, {});
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type'), /^application\/json/);
  assert.equal(exp.headers.get('content-disposition'), `attachment; filename="tripelyx-company-${w.org.id}.json"`);
  assert.match(exp.headers.get('cache-control'), /no-store/);
  const data = JSON.parse(exp.text);
  assert.ok(JSON.stringify(data).includes(w.org.id));
  assert.doesNotMatch(exp.text, /passwordHash|password/);
  assert.equal((await w.c(w.tom).post(`${action}/export`, {})).status, 403);
});

test('platform: only platform admins see /admin/business; confirming is audited as Tripelyx; a pause needs a note and locks the members out; the platform admin gets 404 inside any company', async t => {
  const w = await world();
  t.after(w.app.close);
  await w.app.store.savePartnerLead({ id: 'lead_test1', name: 'Lena Lead', company: 'Lead Co', email: 'lena@lead.example', type: '51-200 people', message: 'We want to try it with our sales team.', createdAt: '2026-10-08T10:00:00.000Z', kind: 'business' });
  const newcomer = await seedUser(w.app, { name: 'Nina New' });
  const { org: pending } = await w.svc.createCompany({ user: newcomer.user }, { name: 'Acme, Inc.', size: '1-10 people', ack: '1' });
  const ops = client(w.app.base, w.ops.cookie);
  // Everyone else: 404, signed out too, GET and POST.
  for (const who of [w.owner, newcomer, null]) {
    const c = who ? w.c(who) : client(w.app.base);
    assert.equal((await c.get('/admin/business')).status, 404);
    assert.equal((await c.post(`/admin/business/${pending.id}/status`, { status: 'active', rev: '0' })).status, 404);
  }
  assert.equal((await w.svc.repo.get(KINDS.org, pending.id)).status, 'pending');
  const page = await ops.get('/admin/business');
  assert.equal(page.status, 200);
  const text = textOf(page.text);
  assert.ok(text.indexOf('Waiting for confirmation (1)') < text.indexOf('Active (1)'), 'pending first');
  assert.match(text, /Acme, Inc\./);
  assert.match(text, /Similar name: Acme Inc/);
  assert.match(text, /Company enquiries \(1\)/);
  assert.match(text, /Lena Lead/);
  assert.match(text, /We want to try it with our sales team\./);
  assert.doesNotMatch(text, /Engineering|Sam Rivera|policy version/i, 'nothing inside a company');
  assert.match(page.text, /<a href="\/admin\/business" aria-current="page">Companies<\/a>/, 'a tab of the admin control center');
  noInline('/admin/business', page.text);
  const tabs = await ops.get('/admin');
  assert.match(tabs.text, /<a href="\/admin\/business">Companies<\/a>/, 'the Companies tab on the other admin pages');
  // Confirm.
  const confirm = await ops.post(`/admin/business/${pending.id}/status`, { status: 'active', rev: String(pending.rev) });
  assert.equal(confirm.status, 303);
  assert.equal(confirm.location, '/admin/business?ok=active');
  const entry = (await w.svc.listAudit({ org: { id: pending.id }, user: newcomer.user }, { group: 'org' })).rows[0];
  assert.equal(entry.action, 'org.confirmed');
  assert.deepEqual(entry.actor, { platformAdmin: w.ops.user.id, name: 'Tripelyx' });
  assert.equal(entry.summary, 'Tripelyx confirmed Acme, Inc.');
  assert.match(textOf((await ops.get(confirm.location)).text), /Done\. The company is active, and its people can join by invite\./);
  // Pause: a note is required; a stale form is 409.
  const cur = await w.svc.repo.get(KINDS.org, w.org.id);
  const noNote = await ops.post(`/admin/business/${w.org.id}/status`, { status: 'suspended', rev: String(cur.rev), note: '' });
  assert.equal(noNote.status, 422);
  assert.match(textOf(noNote.text), /Write a short note on why this company is paused\./);
  assert.match(noNote.text, /<details class="bz-more" open>/);
  assert.equal((await ops.post(`/admin/business/${w.org.id}/status`, { status: 'suspended', rev: String(cur.rev - 1), note: 'Checking' })).status, 409);
  const paused = await ops.post(`/admin/business/${w.org.id}/status`, { status: 'suspended', rev: String(cur.rev), note: 'Checking the company details' });
  assert.equal(paused.status, 303);
  const locked = await w.c(w.owner).get(`${w.o}/settings`);
  assert.equal(locked.status, 403);
  assert.match(textOf(locked.text), /Tripelyx has paused this company workspace\. Write to go@tripelyx\.com\./);
  assert.doesNotMatch(textOf(locked.text), /Checking the company details/, 'the note stays with Tripelyx');
  assert.equal((await w.c(w.owner).post(`${w.o}/departments`, { name: 'Ops' })).status, 403);
  // Reactivate.
  const back = await ops.get('/admin/business');
  assert.match(textOf(back.text), /Paused \(1\)/);
  const now = await w.svc.repo.get(KINDS.org, w.org.id);
  assert.equal((await ops.post(`/admin/business/${w.org.id}/status`, { status: 'active', rev: String(now.rev) })).status, 303);
  assert.equal((await w.c(w.owner).get(`${w.o}/settings`)).status, 200);
  // The platform admin inside a company: 404, page or form.
  for (const p of ['/welcome', '/people', '/settings', '/reports', '/activity', '/budgets', '/policies']) assert.equal((await ops.get(w.o + p)).status, 404, p);
  assert.equal((await ops.post(`${w.o}/settings`, { rev: '0', approvalHours: '30' })).status, 404);
  assert.equal((await ops.post(`${w.o}/settings/export`, {})).status, 404);
});

test('every admin page: no inline style or script, no em dash, every amount labelled demo, nav marks the page', async t => {
  const w = await world();
  t.after(w.app.close);
  await trips(w);
  const c = w.c(w.owner);
  for (const p of ['/welcome', '/policies', '/policies/standard', '/policies/executive/history', '/budgets', '/people', '/reports', '/activity', '/settings']) {
    const res = await c.get(w.o + p);
    assert.equal(res.status, 200, p);
    noInline(p, res.text);
    assert.doesNotMatch(mainOf(res.text), /—/, `${p}: no em dash`);
    assertDemoMoney(res.text, p);
    assert.doesNotMatch(res.text, /net rate|commission|markup|supplier cost/i, `${p}: nothing internal`);
    assert.match(res.headers.get('cache-control'), /no-store/);
  }
  const people = await c.get(`${w.o}/people`);
  assert.match(people.text, /aria-current="page"[^>]*>[\s\S]{0,200}People/);
});
