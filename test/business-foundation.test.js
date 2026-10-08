// Tripelyx Business foundation: roles matrix, tokens, the repo's storage rules, field validators,
// rate limits, and the app wiring (ctx.business, stub routers that keep the site working).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const roles = require('../server/business/roles');
const tokens = require('../server/business/tokens');
const v = require('../server/business/validate');
const constants = require('../server/business/constants');
const { Repo, SCOPE_RE, USER_ID_RE } = require('../server/business/repo');
const { createBusinessLimits } = require('../server/business/limits');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { Accounts } = require('../server/accounts');
const { AppError } = require('../server/lib/errors');
const { loadConfig } = require('../server/config');
const { id } = require('../server/lib/ids');
const { startApp, FIXED_NOW } = require('./helpers');
const { seedUser, client, seedOrg, addMember, mutableClock, noInline, storeSnapshot } = require('./business-helpers');

const { KINDS } = constants;

// ---------------------------------------------------------------------------------------------------
// Roles (plan §E). Y = yes, O = own records only, - = no.
// Columns: Owner, Manager, Advisor, Support Agent, Finance, Read Only.
const EXPECTED_MATRIX = {
  'org.view':             'Y Y O Y Y Y',
  'proposals.view':       'Y Y O Y Y Y',
  'proposals.edit':       'Y Y O - - -',
  'proposals.send':       'Y Y O - - -',
  'shares.revoke':        'Y Y O Y - -',
  'proposals.assign':     'Y Y - - - -',
  'proposals.stage':      'Y Y O - Y -',
  'pricing.viewInternal': 'Y Y O - Y -',
  'pricing.discount':     'Y Y O - - -',
  'pricing.override':     'Y Y - - - -',
  'pricing.editRules':    'Y - - - Y -',
  'brand.edit':           'Y Y - - - -',
  'clients.view':         'Y Y O Y Y Y',
  'clients.contact':      'Y Y O Y - -',
  'clients.edit':         'Y Y O - - -',
  'clients.sensitive':    'Y Y O - - -',
  'clients.delete':       'Y Y - - - -',
  'messages.reply':       'Y Y O Y - -',
  'notes.add':            'Y Y O Y Y -',
  'reminders':            'Y Y O O O -',
  'members.manage':       'Y Y - - - -',
  'audit.view':           'Y Y - - Y -',
};

test('roles: the six roles, their labels and the exact permission matrix', () => {
  assert.deepEqual([...roles.ROLES], ['owner', 'manager', 'advisor', 'support', 'finance', 'readonly']);
  assert.deepEqual({ ...roles.LABELS }, { owner: 'Owner', manager: 'Manager', advisor: 'Advisor', support: 'Support Agent', finance: 'Finance', readonly: 'Read Only' });
  assert.deepEqual([...roles.PERMISSIONS], Object.keys(EXPECTED_MATRIX), 'every permission named in the plan, in order');
  const actual = {};
  for (const perm of roles.PERMISSIONS) {
    actual[perm] = roles.ROLES.map(r => (roles.ownOnly(r, perm) ? 'O' : roles.can(r, perm) ? 'Y' : '-')).join(' ');
    for (const r of roles.ROLES) {
      assert.equal(roles.PERMS[r].has(perm), roles.can(r, perm), `PERMS and can agree: ${r} ${perm}`);
      if (roles.ownOnly(r, perm)) assert.ok(roles.can(r, perm), `own-only implies can: ${r} ${perm}`);
    }
  }
  assert.deepEqual(actual, EXPECTED_MATRIX);
  // Own-only belongs to the Advisor, plus Support and Finance on reminders.
  const ownCells = roles.ROLES.flatMap(r => roles.PERMISSIONS.filter(p => roles.ownOnly(r, p)).map(p => `${r}:${p}`));
  assert.ok(ownCells.every(c => c.startsWith('advisor:') || c === 'support:reminders' || c === 'finance:reminders'));
  assert.ok(Object.isFrozen(roles.PERMS) && Object.isFrozen(roles.ROLES) && Object.isFrozen(roles.PERMISSIONS));
});

test('roles: unknown roles and permissions are refused', () => {
  for (const perm of roles.PERMISSIONS) {
    for (const bad of ['x', '', undefined, null, '__proto__', 'constructor', 'toString', 'Owner']) {
      assert.equal(roles.can(bad, perm), false, `${String(bad)} ${perm}`);
      assert.equal(roles.ownOnly(bad, perm), false);
    }
  }
  for (const r of roles.ROLES) {
    assert.equal(roles.can(r, 'nope'), false);
    assert.equal(roles.can(r, 'has'), false);
    assert.equal(roles.can(r, undefined), false);
  }
  assert.equal(roles.clientView('x'), null);
  assert.deepEqual([...roles.assignableBy('x')], []);
  assert.deepEqual([...roles.assignableBy('__proto__')], []);
});

test('roles: who may grant which roles, Finance stage rules, client visibility', () => {
  assert.deepEqual([...roles.assignableBy('owner')], [...roles.ROLES]);
  assert.deepEqual([...roles.assignableBy('manager')], ['advisor', 'support', 'readonly']);
  for (const r of ['advisor', 'support', 'finance', 'readonly']) assert.deepEqual([...roles.assignableBy(r)], [], r);
  // members.manage exactly where assignableBy is not empty.
  for (const r of roles.ROLES) assert.equal(roles.can(r, 'members.manage'), roles.assignableBy(r).length > 0, r);

  for (const stage of constants.STAGES) {
    assert.equal(roles.canSetStage('owner', stage), true);
    assert.equal(roles.canSetStage('manager', stage), true);
    assert.equal(roles.canSetStage('advisor', stage), true);
    assert.equal(roles.canSetStage('finance', stage), stage === 'payment_pending' || stage === 'booked', `finance ${stage}`);
    assert.equal(roles.canSetStage('support', stage), false);
    assert.equal(roles.canSetStage('readonly', stage), false);
  }
  assert.deepEqual(Object.fromEntries(roles.ROLES.map(r => [r, roles.clientView(r)])),
    { owner: 'full', manager: 'full', advisor: 'full', support: 'prefs', finance: 'name', readonly: 'name' });
});

test('roles: allowed() applies the own-scope to records', () => {
  const advisor = { role: 'advisor', userId: 'usr_aaaaaaaaaaaaaaaa' };
  const mine = { advisorId: 'usr_aaaaaaaaaaaaaaaa' }, theirs = { advisorId: 'usr_bbbbbbbbbbbbbbbb' }, nobody = { advisorId: null };
  assert.equal(roles.allowed(advisor, 'proposals.edit', mine), true);
  assert.equal(roles.allowed(advisor, 'proposals.edit', theirs), false);
  assert.equal(roles.allowed(advisor, 'proposals.edit', nobody), false);
  assert.equal(roles.allowed(advisor, 'proposals.assign', mine), false, 'no permission at all');
  const manager = { role: 'manager', userId: 'usr_cccccccccccccccc' };
  assert.equal(roles.allowed(manager, 'proposals.edit', theirs), true);
  const support = { role: 'support', userId: 'usr_dddddddddddddddd' };
  assert.equal(roles.allowed(support, 'messages.reply', theirs), true, 'Support replies on every proposal');
  assert.equal(roles.allowed(support, 'reminders', theirs), false, 'Support reminders are own only');
  assert.equal(roles.allowed(support, 'reminders', { advisorId: support.userId }), true);
  assert.equal(roles.allowed(null, 'org.view'), false);
  assert.equal(roles.allowed({ role: 'readonly', userId: 'u' }, 'org.view'), true);
});

// ---------------------------------------------------------------------------------------------------
test('constants: the nine pipeline stages with the spec labels', () => {
  assert.deepEqual([...constants.STAGES], ['new_lead', 'needs_review', 'proposal_sent', 'client_reviewing', 'revision_requested', 'approved', 'payment_pending', 'booked', 'lost']);
  assert.deepEqual(constants.STAGES.map(s => constants.STAGE_LABELS[s]),
    ['New Lead', 'Needs Review', 'Proposal Sent', 'Client Reviewing', 'Revision Requested', 'Approved', 'Payment Pending', 'Booked', 'Lost']);
  assert.deepEqual([...constants.AUTO_LOCKED], ['payment_pending', 'booked', 'lost']);
  assert.equal(constants.BUSINESS_EMAIL, 'go@tripelyx.com');
  assert.equal(constants.MAX_OPTIONS, 3);
  assert.equal(constants.MAX_SHARES, 6);
  assert.ok(Object.values(KINDS).every(k => /^biz_[a-z_]+$/.test(k)));
  assert.equal(new Set(Object.values(KINDS)).size, Object.keys(KINDS).length);
  assert.ok(v.contrast(constants.DEFAULT_COLORS.primary, '#ffffff') >= v.MIN_CONTRAST);
  assert.ok(v.contrast(constants.DEFAULT_COLORS.accent, '#ffffff') >= v.MIN_CONTRAST);
});

// ---------------------------------------------------------------------------------------------------
test('tokens: 43 random characters, stored only as a hash, compared in constant time', () => {
  const a = tokens.newToken(), b = tokens.newToken();
  assert.equal(a.length, 43);
  assert.match(a, tokens.TOKEN_RE);
  assert.notEqual(a, b);
  assert.ok(tokens.isToken(a));
  for (const bad of ['', 'short', `${a}x`, `${a.slice(0, 42)}!`, null, undefined, 42]) assert.equal(tokens.isToken(bad), false);
  const h = tokens.hashToken(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(tokens.hashToken(a), h, 'deterministic');
  assert.ok(!h.includes(a));
  assert.equal(tokens.sameHash(h, tokens.hashToken(a)), true);
  assert.equal(tokens.sameHash(h, tokens.hashToken(b)), false);
  assert.equal(tokens.sameHash(h, h.slice(0, 62)), false, 'different lengths');
  assert.equal(tokens.sameHash(h, `${h.slice(0, 63)}z`), false, 'not hex');
  assert.equal(tokens.sameHash(undefined, undefined), false);
  assert.equal(tokens.sameHash('', ''), false);
});

// ---------------------------------------------------------------------------------------------------
test('repo: the scope check matches the user ids accounts.register makes', async () => {
  const store = new MemoryStore();
  const accounts = new Accounts({ store, config: loadConfig({}), now: () => new Date(FIXED_NOW) });
  const user = await accounts.register({ name: 'Ada Advisor', email: 'ada@example.com', password: 'long enough password' });
  assert.match(user.id, USER_ID_RE);
  assert.match(user.id, SCOPE_RE);
  const repo = new Repo({ store, now: () => new Date(FIXED_NOW) });
  assert.equal(repo.assertScope(user.id), user.id);
  for (const prefix of ['org', 'prp', 'usr']) { const x = id(prefix); assert.equal(repo.assertScope(x), x); }
  for (const bad of ['', null, undefined, 0, false, 'org_short', 'cli_aaaaaaaaaaaaaaaa', 'org_aaaaaaaaaaaaaaaa ', `${id('org')}x`, 'org_aaaaaaaa:aaaaaaa', {}, ['org_aaaaaaaaaaaaaaaa']]) {
    assert.throws(() => repo.assertScope(bad), /unscoped or malformed/, String(bad));
  }
  await assert.rejects(repo.list(KINDS.client, ''), /unscoped/);
  await assert.rejects(repo.list(KINDS.client, null), /unscoped/);
  await assert.rejects(repo.list(KINDS.client, undefined), /unscoped/);
  await assert.rejects(repo.insert(KINDS.client, 'cli_x', { rev: 0 }, { owner: '' }), /unscoped/);
});

test('repo: getIn refuses another tenant, list is scoped and sorted by the clock time', async () => {
  const clock = mutableClock(FIXED_NOW);
  const store = new MemoryStore();
  const repo = new Repo({ store, now: clock.now });
  assert.equal(repo.iso(), FIXED_NOW);
  assert.equal(repo.now().toISOString(), FIXED_NOW);
  const orgA = id('org'), orgB = id('org');
  assert.equal(await repo.insert(KINDS.org, orgA, { id: orgA, name: 'A', rev: 0, at: repo.iso() }), true);
  const cid = id('cli');
  await repo.insert(KINDS.client, cid, { id: cid, orgId: orgA, name: 'Client', at: repo.iso(), rev: 0 }, { owner: orgA });
  assert.equal((await repo.getIn(KINDS.client, cid, orgA)).name, 'Client');
  assert.equal(await repo.getIn(KINDS.client, cid, orgB), null, 'cross-tenant id → null');
  assert.equal(await repo.getIn(KINDS.client, cid, ''), null);
  assert.equal(await repo.getIn(KINDS.client, cid, undefined), null);
  assert.equal(await repo.getIn(KINDS.client, 'cli_missing', orgA), null);
  assert.equal(await repo.getIn(KINDS.client, '', orgA), null);
  assert.equal(await repo.getIn(KINDS.client, 'x'.repeat(500), orgA), null);
  assert.equal((await repo.getIn(KINDS.org, orgA, orgA)).name, 'A');
  assert.equal(await repo.getIn(KINDS.org, orgA, orgB), null);

  // Inserted in one order with clock times in another: the list follows data.at, newest first.
  const ats = ['2026-10-09T09:00:00.000Z', '2026-10-11T09:00:00.000Z', '2026-10-10T09:00:00.000Z'];
  for (const [i, at] of ats.entries()) await repo.insert(KINDS.reminder, `rem_${i}`, { id: `rem_${i}`, orgId: orgB, at }, { owner: orgB });
  await repo.insert(KINDS.reminder, 'rem_other', { id: 'rem_other', orgId: orgA, at: ats[1] }, { owner: orgA });
  assert.deepEqual((await repo.list(KINDS.reminder, orgB)).map(r => r.id), ['rem_1', 'rem_2', 'rem_0']);
  assert.deepEqual((await repo.list(KINDS.reminder, orgA)).map(r => r.id), ['rem_other']);
  await repo.insert(KINDS.proposal, 'p1', { id: 'p1', orgId: orgB, at: ats[0], updatedAt: ats[1] }, { owner: orgB });
  await repo.insert(KINDS.proposal, 'p2', { id: 'p2', orgId: orgB, at: ats[2], updatedAt: ats[2] }, { owner: orgB });
  assert.deepEqual((await repo.list(KINDS.proposal, orgB)).map(r => r.id), ['p2', 'p1']);
  assert.deepEqual((await repo.list(KINDS.proposal, orgB, { by: 'updatedAt' })).map(r => r.id), ['p1', 'p2']);
});

test('repo: documents must be plain JSON and ids never use a colon', async () => {
  const repo = new Repo({ store: new MemoryStore(), now: () => new Date(FIXED_NOW) });
  const org = id('org');
  for (const bad of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: new Date() }, { a: [1, undefined] }, { a: { b: () => 1 } }, { a: new Map() }]) {
    await assert.rejects(repo.insert(KINDS.note, id('bnt'), bad, { owner: org }), /not plain JSON|not a finite number/);
  }
  for (const bad of [[], null, 'text', new Date()]) await assert.rejects(repo.insert(KINDS.note, id('bnt'), bad, { owner: org }), /plain object/);
  await assert.rejects(repo.insert(KINDS.member, `${org}:usr`, { ok: true }, { owner: org }), /bad record id/);
  await assert.rejects(repo.put(KINDS.logo, '', { ok: true }, { owner: org }), /bad record id/);
  assert.equal(await repo.insert(KINDS.member, `${org}.usr_aaaaaaaaaaaaaaaa`, { ok: true, list: [1, 'a', null, { x: false }] }, { owner: org }), true);
  assert.equal(await repo.insert(KINDS.member, `${org}.usr_aaaaaaaaaaaaaaaa`, { ok: false }, { owner: org }), false, 'insert-only');
});

test('repo: cas checks rev, applies the change and makes racing writers lose with 409', async () => {
  const store = new MemoryStore();
  const repo = new Repo({ store, now: () => new Date(FIXED_NOW) });
  const org = id('org');
  await repo.insert(KINDS.client, 'c1', { name: 'A', rev: 0 }, { owner: org });
  const w = await repo.cas(KINDS.client, 'c1', 0, d => { d.name = 'B'; });
  assert.deepEqual(w, { name: 'B', rev: 1 });
  assert.deepEqual(await repo.cas(KINDS.client, 'c1', '1', d => ({ ...d, name: 'C', rev: 99 })), { name: 'C', rev: 2 }, 'a form rev string works; rev is the store\'s');
  const stale = await repo.cas(KINDS.client, 'c1', 1, d => { d.name = 'X'; }).catch(e => e);
  assert.ok(stale instanceof AppError);
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'conflict');
  assert.equal(stale.message, 'Someone else just changed this. Reload to see their change.');
  for (const bad of ['abc', '1.5', -1, '', {}]) {
    const e = await repo.cas(KINDS.client, 'c1', bad, d => d).catch(x => x);
    assert.equal(e.status, 409, `rev ${JSON.stringify(bad)}`);
  }
  assert.equal((await repo.cas(KINDS.client, 'c1', null, d => { d.name = 'D'; })).rev, 3, 'null rev: use the rev just read');
  const missing = await repo.cas(KINDS.client, 'nope', 0, d => d).catch(e => e);
  assert.equal(missing.status, 404);
  const aborted = await repo.cas(KINDS.client, 'c1', 3, () => { throw new AppError('bad', 'no', 422); }).catch(e => e);
  assert.equal(aborted.status, 422);
  assert.equal((await repo.get(KINDS.client, 'c1')).rev, 3, 'an aborted change writes nothing');
  await assert.rejects(repo.cas(KINDS.client, 'c1', 3, d => { d.when = new Date(); }), /not plain JSON/);

  // Racing writers that all saw rev 3: exactly one wins, the others get 409.
  const results = await Promise.allSettled(['x', 'y', 'z'].map(n => repo.cas(KINDS.client, 'c1', 3, async d => { await null; d.name = n; })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409));
  assert.equal((await repo.get(KINDS.client, 'c1')).rev, 4);

  // put and del.
  await repo.put(KINDS.logo, org, { orgId: org, b64: 'AA' }, { owner: org });
  await repo.put(KINDS.logo, org, { orgId: org, b64: 'BB' }, { owner: org });
  assert.equal((await repo.get(KINDS.logo, org)).b64, 'BB');
  assert.equal(await repo.del(KINDS.logo, org), true);
  assert.equal(await repo.get(KINDS.logo, org), null);
  assert.equal(await repo.del(KINDS.logo, ''), false);
});

// ---------------------------------------------------------------------------------------------------
const fieldError = fn => { try { fn(); } catch (e) { assert.ok(e instanceof AppError && e.code === 'invalid_field' && e.status === 422, e.message); return e.message; } assert.fail('expected an invalid_field error'); };


test('repo: cas refuses a callback that returns anything but a plain object or nothing, or re-homes a record', async () => {
  const store = new MemoryStore();
  const repo = new Repo({ store, now: () => new Date(FIXED_NOW) });
  const org = id('org');
  const original = { id: 'cli_1', orgId: org, name: 'A', logo: null, rev: 0 };
  await repo.insert(KINDS.client, 'c1', original, { owner: org });
  // The arrow-function slips: `d => d.name = 'X'` returns 'X', `d => d.logo = {…}` returns the logo.
  const slips = [d => d.name = 'X', d => d.logo = { type: 'image/png' }, () => true, () => 5, () => 'str', () => [1, 2], () => null, () => new Date(), d => d.rev = 7];
  for (const fn of slips) {
    await assert.rejects(repo.cas(KINDS.client, 'c1', 0, fn), /cas fn must return a plain object or nothing|may not change or drop/, String(fn));
  }
  await assert.rejects(repo.cas(KINDS.client, 'c1', 0, d => ({ ...d, orgId: id('org') })), /may not change or drop orgId/);
  await assert.rejects(repo.cas(KINDS.client, 'c1', 0, d => ({ ...d, id: 'cli_2' })), /may not change or drop id/);
  await assert.rejects(repo.cas(KINDS.client, 'c1', 0, ({ orgId: _o, ...rest }) => rest), /may not change or drop orgId/);
  await assert.rejects(repo.cas(KINDS.client, 'c1', 0, d => { delete d.orgId; }), /may not change or drop orgId/);
  assert.deepEqual(await repo.get(KINDS.client, 'c1'), original, 'every refused change leaves the record unchanged');
  // The two supported shapes still work.
  assert.deepEqual(await repo.cas(KINDS.client, 'c1', 0, d => { d.name = 'B'; }), { ...original, name: 'B', rev: 1 });
  assert.deepEqual(await repo.cas(KINDS.client, 'c1', 1, d => ({ ...d, name: 'C' })), { ...original, name: 'C', rev: 2 });
  assert.deepEqual(await repo.cas(KINDS.client, 'c1', 2, d => { d.name = 'D'; return d; }), { ...original, name: 'D', rev: 3 });
});

test('validate: money in cents and percentages in tenths, by string arithmetic', () => {
  assert.equal(v.dollarsToCents('1,000.50'), 100050);
  assert.equal(v.dollarsToCents('$ 25'), 2500);
  assert.equal(v.dollarsToCents('25.5'), 2550);
  assert.equal(v.dollarsToCents('0.07'), 7);
  assert.equal(v.dollarsToCents('123.45'), 12345);
  assert.equal(v.dollarsToCents(17), 1700);
  assert.equal(v.dollarsToCents('9999999.99'), 999999999);
  for (const bad of ['1.005', '-1', 'abc', '1e3', '1.2.3', '12345678', '.5', '0x10']) fieldError(() => v.dollarsToCents(bad));
  assert.equal(v.dollarsToCents('', { blank: 0 }), 0);
  assert.equal(v.dollarsToCents('  ', { blank: null }), null);
  assert.equal(fieldError(() => v.dollarsToCents('')), 'Enter an amount.');
  assert.equal(fieldError(() => v.dollarsToCents('2000.01', { max: 200000 })), 'The most you can enter is $2,000.');
  assert.equal(v.dollarsToCents('2000', { max: 200000 }), 200000);

  assert.equal(v.percentTenths('7.5'), 75);
  assert.equal(v.percentTenths('13.7%'), 137);
  assert.equal(v.percentTenths('30', { max: 300 }), 300);
  assert.equal(v.percentTenths('0'), 0);
  for (const bad of ['7.55', '-1', '100', 'abc', '1,5']) fieldError(() => v.percentTenths(bad));
  assert.equal(fieldError(() => v.percentTenths('30.1', { max: 300 })), 'The most you can enter is 30%.');
  assert.equal(v.percentTenths('', { blank: 0 }), 0);
});

test('validate: websites, emails, phones, colors and contrast', () => {
  assert.equal(v.httpsUrl('https://sunny.example/about'), 'https://sunny.example/about');
  assert.equal(v.httpsUrl('sunny.example'), 'https://sunny.example/');
  assert.equal(v.httpsUrl('', { optional: true }), '');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'http://sunny.example', 'data:text/html,hi', 'https://user:pw@sunny.example',
    'https://localhost', 'https://sunny.example:8443', 'ftp://sunny.example', 'https://', 'https://exa mple.com', '']) {
    fieldError(() => v.httpsUrl(bad));
  }
  assert.equal(v.email(' Ada@Example.COM '), 'ada@example.com');
  assert.equal(v.email('', { optional: true }), '');
  for (const bad of ['', 'ada', 'ada@x', '<a>@x.com', `${'a'.repeat(120)}@x.com`]) fieldError(() => v.email(bad));
  assert.equal(v.phone('+1 (555) 010-0199'), '+1 (555) 010-0199');
  assert.equal(v.phone('', { optional: true }), '');
  for (const bad of ['', 'call me', '12', '+1 555 javascript', '5'.repeat(31)]) fieldError(() => v.phone(bad));

  assert.equal(v.hexColor('#0B2545'), '#0b2545');
  for (const bad of ['#fff', 'red', '#12345g', '0b2545', '#0b25456', '', undefined, 'url(x)', '#0b2545;}']) fieldError(() => v.hexColor(bad));
  assert.equal(Math.round(v.contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(v.contrast('#ffffff', '#000000'), v.contrast('#000000', '#ffffff'), 'order does not matter');
  assert.equal(v.contrast('#2f6fed', '#2f6fed'), 1);
  assert.equal(Math.round(v.contrast('#767676', '#ffffff') * 100) / 100, 4.54, 'the classic 4.5:1 grey');
  assert.ok(v.contrast('#777777', '#ffffff') < v.MIN_CONTRAST);
  assert.ok(v.contrast('#ffff00', '#ffffff') < v.MIN_CONTRAST, 'yellow on white is refused');
  assert.throws(() => v.contrast('red', '#ffffff'), AppError);
});

test('validate: text, choices, local paths and collected form errors', () => {
  assert.equal(v.text('  hi\u0000there  ', 100), 'hi there');
  assert.equal(v.text('abcdef', 3), 'abc');
  assert.equal(v.text('line one\r\nline two\n\n\n\nend', 100, { multiline: true }), 'line one\nline two\n\nend');
  assert.equal(v.text('a\nb', 100), 'a b');
  assert.equal(v.text(undefined, 10), '');
  // Invisible and direction-changing characters are removed and the text is NFKC-normalized, so a word
  // check on the cleaned value sees what the page will show.
  assert.equal(v.text('a\u202eb', 10), 'ab');
  assert.equal(v.text('Trip\u200belyx', 20), 'Tripelyx');
  assert.equal(v.text('\u202exylepirT', 20), 'xylepirT', 'the reversed name renders reversed once the override is gone');
  assert.equal(v.text('\uff34\uff52\uff49\uff50elyx', 20), 'Tripelyx', 'fullwidth letters become plain ones');
  assert.equal(v.text('Tri\u00adp\u2060e\u200cl\u200dy\u2066x\u2069\ufeff\u200e\u200f\u061c\u180e\u034f', 20), 'Tripelyx');
  assert.equal(v.text('a\u2028b\u0085c', 10), 'a b c', 'line separators and C1 controls become spaces');
  assert.equal(v.text('one\u202e\n\u2029two', 20, { multiline: true }), 'one\n two');
  assert.equal(v.text('cafe\u0301', 10), 'caf\u00e9');
  assert.equal(v.text('\u200b\u200b', 10), '');
  assert.equal(fieldError(() => v.text('\u200b \u202e', 10, { required: true })), 'Fill in this field.');
  assert.equal(fieldError(() => v.email('hello\u202e@agency.example')), 'Enter a valid email address.');
  assert.equal(fieldError(() => v.text('  ', 10, { required: true })), 'Fill in this field.');
  assert.equal(v.oneOf('B', constants.OPTION_KEYS), 'B');
  assert.equal(v.oneOf('', constants.OPTION_KEYS, { blank: null }), null);
  for (const bad of ['D', '', 'b', undefined, '__proto__']) fieldError(() => v.oneOf(bad, constants.OPTION_KEYS));
  assert.equal(v.safeLocal('/business/o/x?ok=1'), '/business/o/x?ok=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'business', '', '/a\nb', null, 42]) {
    assert.equal(v.safeLocal(bad), null, String(bad));
    assert.equal(v.safeLocal(bad, '/business/app'), '/business/app');
  }
  const e = (() => { try { return v.collect('invalid_brand', { email: () => v.email('nope'), primary: () => v.hexColor('#fff'), name: () => v.text('Sunny', 80) }); } catch (x) { return x; } })();
  assert.ok(e instanceof AppError);
  assert.equal(e.code, 'invalid_brand');
  assert.equal(e.status, 422);
  assert.equal(e.message, 'Check the highlighted fields.');
  assert.deepEqual(Object.keys(e.details), ['email', 'primary']);
  assert.deepEqual(v.collect('x', { a: () => 1, b: () => 'two' }), { a: 1, b: 'two' });
  assert.throws(() => v.collect('x', { a: () => { throw new TypeError('bug'); } }), TypeError, 'programming errors pass through');
});

// ---------------------------------------------------------------------------------------------------
async function limiterApp(biz, logger) {
  const lim = createBusinessLimits(biz, { logger });
  const app = express();
  app.use((req, res, next) => { const u = req.get('x-user'); req.user = u ? { id: u } : null; next(); });
  const ok = (req, res) => res.send('ok');
  app.post('/write', lim.bizWrite, ok);
  app.get('/compute', lim.bizCompute, ok);
  app.get('/p/:token', lim.clientView, ok);
  app.post('/p/:token/respond', lim.clientWrite, ok);
  app.post('/p/:token/seen', lim.clientSeen, ok);
  app.use((err, req, res, next) => res.status(err.status || 500).send(`${err.code}|${err.message}`));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('limits: per user for the workspace, per IP and link for clients, 429 through the error handler', async t => {
  const logged = [];
  const logger = { warn: (...a) => logged.push(['warn', ...a]), error: (...a) => logged.push(['error', ...a]) };
  const srv = await limiterApp({ writeLimit: 2, computeLimit: 1, clientWriteLimit: 2 }, logger);
  t.after(srv.close);
  const post = (path, user) => fetch(srv.base + path, { method: 'POST', headers: user ? { 'x-user': user } : {} });

  assert.equal((await post('/write', 'usr_a')).status, 200);
  assert.equal((await post('/write', 'usr_a')).status, 200);
  const over = await post('/write', 'usr_a');
  assert.equal(over.status, 429);
  assert.equal(await over.text(), 'rate_limited|Too many requests in a short time. Wait a few minutes and try again.');
  assert.equal((await post('/write', 'usr_b')).status, 200, 'two users on one IP do not share a budget');
  assert.equal((await post('/write')).status, 200, 'signed out: keyed by IP');

  assert.equal((await fetch(`${srv.base}/compute`, { headers: { 'x-user': 'usr_a' } })).status, 200);
  assert.equal((await fetch(`${srv.base}/compute`, { headers: { 'x-user': 'usr_a' } })).status, 429);
  assert.equal((await fetch(`${srv.base}/compute`, { headers: { 'x-user': 'usr_b' } })).status, 200, 'compute is per user too');

  const t1 = tokens.newToken(), t2 = tokens.newToken();
  assert.equal((await post(`/p/${t1}/respond`)).status, 200);
  assert.equal((await post(`/p/${t1}/respond`)).status, 200);
  assert.equal((await post(`/p/${t1}/respond`)).status, 429);
  assert.equal((await post(`/p/${t2}/respond`)).status, 200, 'another link has its own budget');
  assert.equal((await post(`/p/${t1}/seen`)).status, 200, 'the beacon has its own limiter');
  assert.equal((await fetch(`${srv.base}/p/${t1}`)).status, 200);

  assert.deepEqual(logged, [], 'express-rate-limit reports no misconfiguration (keys use ipKeyGenerator)');
});

test('limits: defaults come from config and the client view and beacon limits are fixed', async t => {
  const srv = await limiterApp(loadConfig({}).business);
  t.after(srv.close);
  const res = await fetch(`${srv.base}/p/${tokens.newToken()}`);
  assert.equal(res.headers.get('ratelimit-policy'), '120;w=60');
  const w = await fetch(`${srv.base}/write`, { method: 'POST', headers: { 'x-user': 'usr_a' } });
  assert.equal(w.headers.get('ratelimit-policy'), '300;w=600');
  const c = await fetch(`${srv.base}/compute`, { headers: { 'x-user': 'usr_a' } });
  assert.equal(c.headers.get('ratelimit-policy'), '30;w=60');
  const cw = await fetch(`${srv.base}/p/${tokens.newToken()}/respond`, { method: 'POST' });
  assert.equal(cw.headers.get('ratelimit-policy'), '20;w=600');
  const s = await fetch(`${srv.base}/p/${tokens.newToken()}/seen`, { method: 'POST' });
  assert.equal(s.headers.get('ratelimit-policy'), '60;w=60');
});

// ---------------------------------------------------------------------------------------------------
test('app: client and brand paths never read the session or set the Tripelyx visitor cookie', async t => {
  const app = await startApp();
  t.after(app.close);
  const { user, cookie } = await seedUser(app, { name: 'Zebedee Quartermaine' });
  const tok = tokens.newToken();
  const anonymous = [`/business/p/${tok}`, `/business/p/${tok}/versions`, `/business/p/${tok}/approve?option=B`, '/business/p/x',
    '/business/brand/x/brand.css', `/business/brand/${id('org')}/logo?v=1`, '/business/brand', '/BUSINESS/P/x'];
  for (const path of anonymous) {
    for (const headers of [{}, { cookie }]) {
      const res = await fetch(app.base + path, { headers, redirect: 'manual' });
      assert.equal(res.headers.get('set-cookie'), null, `${path} ${headers.cookie ? 'signed in' : 'signed out'}`);
      if (headers.cookie) assert.ok(!(await res.text()).includes(user.name.split(' ')[0]), `${path}: the session is not read`);
    }
  }
  const post = await fetch(`${app.base}/business/p/${tok}/seen`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(post.headers.get('set-cookie'), null, 'beacon');
  // Everywhere else the visitor cookie and the session work as before (workspace paths need req.user).
  for (const path of ['/plan', '/business/app', '/business/o/x', '/business/pricing', '/nope']) {
    const res = await fetch(app.base + path, { redirect: 'manual' });
    assert.match(res.headers.get('set-cookie') || '', /^txv=/, path);
  }
  const signedIn = await fetch(`${app.base}/nope`, { headers: { cookie } });
  assert.ok((await signedIn.text()).includes(user.name.split(' ')[0]), 'a signed-in 404 elsewhere still shows the account');
});

test('app: ctx.business exists only with trips and Business on, and the stub routers change nothing', async t => {
  const app = await startApp();
  t.after(app.close);
  assert.ok(app.business, 'createApp returns business');
  assert.equal(app.ctx.business, app.business);
  assert.equal(app.business.store, app.store);
  assert.equal(app.business.tripService, app.tripService);
  assert.equal(app.business.config, app.config);
  assert.equal(typeof app.business.now, 'function');
  for (const path of ['/', '/plan', '/brands', '/how-it-works']) assert.equal((await fetch(app.base + path)).status, 200, path);
  for (const path of ['/business/app', '/business/p/x', '/business/brand/x/brand.css', '/business/o/x']) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 404, path);
    noInline(path, await res.text());
  }

  const off = await startApp({ ENABLE_BUSINESS: 'false' });
  t.after(off.close);
  assert.equal(off.business, null);
  assert.equal(off.ctx.business, null);
  assert.equal((await fetch(`${off.base}/plan`)).status, 200);

  const warned = [];
  const noTrips = await startApp({ ENABLE_TRIPS: 'false' }, { log: { error() {}, info() {}, log() {}, warn: m => warned.push(m) } });
  t.after(noTrips.close);
  assert.equal(noTrips.business, null);
  assert.ok(warned.includes('[business] Tripelyx Business is off: it needs Travel by Budget.'));
  assert.equal((await fetch(`${noTrips.base}/`)).status, 200);
});

test('helpers: seeded sessions sign in, seeded orgs and members have the §D shapes, GETs leave the store alone', async t => {
  const app = await startApp();
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Olivia Owner', email: 'olivia@example.com' });
  assert.match(owner.user.id, USER_ID_RE);
  const signedIn = await client(app.base, owner.cookie).get('/my-trips');
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.text.includes('Olivia'));
  assert.equal((await client(app.base).get('/my-trips')).status, 303, 'no cookie, no session');

  const org = await seedOrg(app, owner, { status: 'pending' });
  const repo = new Repo({ store: app.store, now: app.ctx.now });
  const stored = await repo.get(KINDS.org, org.id);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.rev, 0);
  assert.equal((await repo.getIn(KINDS.brand, org.id, org.id)).primary, '#0b2545');
  assert.equal((await repo.getIn(KINDS.rules, org.id, org.id)).maxServiceFee, null);
  const om = await repo.getIn(KINDS.member, `${org.id}.${owner.user.id}`, org.id);
  assert.equal(om.role, 'owner');
  assert.deepEqual((await repo.list(KINDS.userOrg, owner.user.id)).map(l => l.orgId), [org.id]);

  const adv = await addMember(app, org, 'advisor', { name: 'Avery Advisor' });
  assert.equal(adv.member.role, 'advisor');
  assert.equal(adv.member.orgId, org.id);
  assert.deepEqual((await repo.list(KINDS.member, org.id)).map(m => m.role).sort(), ['advisor', 'owner']);

  const before = storeSnapshot(app);
  await client(app.base, owner.cookie).get('/my-trips');
  assert.equal(storeSnapshot(app), before);

  const clock = mutableClock(FIXED_NOW);
  assert.equal(clock.now().toISOString(), FIXED_NOW);
  clock.advance(8);
  assert.equal(clock.now().toISOString(), '2026-10-17T09:00:00.000Z');
});
