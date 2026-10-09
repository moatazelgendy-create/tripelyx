// Tripelyx Business approvals (plan §B4, §H1 to §H3), Stage 2B: the inbox at /business/o/:orgId/approvals
// with its tabs (Waiting for you, Decided by you, Company for an admin, Expired), and the approver's side of
// a request page: approve, deny (a reason is needed), the over-budget box, an admin override (a note is
// needed), messages, a stale form, a price that changed while it waited, and a request that expired. Through
// HTTP on the real app with demo inventory and the clock held at FIXED_NOW.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const {
  seedUser, client, seedOrg, seedMember, seedDepartment, seedBudget, mutableClock, noInline, storeSnapshot,
} = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');

const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });
const BQ = Object.freeze({ ...Q, cabin: 'business' });
const REASON = 'The board meets at the client office, and this is the only flight that lands in time.';

// ---------------------------------------------------------------------------------------------------------
// Markup checks (the same walkers as test/business-views.test.js)

const PRESSURE = /\b(hurry|limited|selling out|last chance|act now|almost gone|don[’']t miss|only \d+ left|ending soon|book now|still available|prices? (?:will|may) (?:rise|go up)|countdown|typically|usually|predict|(?<!(?:can[’']t be|cannot be|never|not) )guarantee[ds]?\b|identical)\b/i;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function elements(markup) {
  const all = [], stack = [];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const [whole, close, name, attrs] = m;
    const tag = name.toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        for (const el of stack.splice(i)) el.end = m.index;
        break;
      }
      continue;
    }
    const el = { tag, attrs, start: m.index, inner: m.index + whole.length, end: markup.length, parent: stack[stack.length - 1] || null };
    all.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push(el);
  }
  return all;
}
const textOf = s => String(s).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const hasClass = (el, cls) => new RegExp(`\\bclass="[^"]*\\b${cls}\\b`).test(el.attrs);
const TEXT_AMOUNT = /[$€£¥]\s?\d/;

/** Every amount (a .bz-money or an amount in text) sits in a data-price-source="demo" container that says so. */
function assertDemoMoney(markup, { priced = true, label = '' } = {}) {
  const s = String(markup);
  const all = elements(s);
  const check = (el, what) => {
    let box = el;
    while (box && !/\bdata-price-source="demo"/.test(box.attrs)) box = box.parent;
    assert.ok(box, `${label}: ${what} sits in a demo container`);
    const text = textOf(s.slice(box.inner, box.end));
    assert.ok(text.includes('Demo price'), `${label}: the container of ${what} says Demo price: ${text.slice(0, 160)}`);
    if (priced) assert.ok(text.includes('Priced at'), `${label}: the container of ${what} says Priced at: ${text.slice(0, 160)}`);
  };
  let n = 0;
  for (const el of all) {
    if (!hasClass(el, 'bz-money')) continue;
    n += 1;
    check(el.parent, s.slice(el.start, el.start + 80));
  }
  for (const m of s.matchAll(/>([^<]+)</g)) {
    const text = textOf(m[1]);
    if (!TEXT_AMOUNT.test(text)) continue;
    const at = m.index + 1;
    const owner = all.filter(el => !VOID.has(el.tag) && !/\/\s*$/.test(el.attrs) && el.inner <= at && at < el.end)
      .reduce((a, el) => (!a || el.inner > a.inner ? el : a), null);
    check(owner, `"${text.slice(0, 60)}"`);
  }
  return n;
}

function assertLabelled(markup, label) {
  const s = String(markup);
  const fors = [...s.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map(m => m[1]);
  const ids = new Set([...s.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(m => m[1]));
  for (const f of fors) assert.ok(ids.has(f), `${label}: label for="${f}" names a control`);
  for (const m of s.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    if (/\btype="(?:hidden|submit|button)"/.test(m[2])) continue;
    const id = (m[2].match(/\bid="([^"]+)"/) || [])[1];
    assert.ok((id && fors.includes(id)) || /\baria-label(?:ledby)?="[^"]+"/.test(m[2]), `${label}: <${m[1]}${m[2].slice(0, 80)}> has a label`);
  }
}

function assertHeadingOrder(markup, label) {
  const levels = [...String(markup).matchAll(/<h([1-6])\b/g)].map(m => Number(m[1]));
  assert.equal(levels[0], 1, `${label}: starts with the h1`);
  assert.equal(levels.filter(l => l === 1).length, 1, `${label}: one h1`);
  levels.forEach((l, i) => assert.ok(!i || l <= levels[i - 1] + 1, `${label}: h${levels[i - 1]} then h${l} skips a level`));
}

const mainOf = page => (page.match(/<main\b[\s\S]*<\/main>/) || [''])[0];

/** The checks every workspace page passes: CSP, no em dash, no pressure words, headings, labels, the demo rule. */
function checkPage(path, res, { priced = true } = {}) {
  noInline(path, res.text);
  const main = mainOf(res.text);
  assert.ok(main, `${path}: has <main>`);
  assert.doesNotMatch(res.text, /<style\b/, `${path}: no <style>`);
  assert.doesNotMatch(res.text, /\son[a-z]+\s*=\s*["']/i, `${path}: no on* handlers`);
  assert.doesNotMatch(textOf(main), /—/, `${path}: no em dash`);
  assert.doesNotMatch(textOf(main), PRESSURE, `${path}: no pressure words`);
  assert.doesNotMatch(res.text, /supplierQuoteRef|netCents|commission|markup|BusinessDemo/i, `${path}: nothing internal`);
  assertHeadingOrder(main, path);
  assertLabelled(main, path);
  assertDemoMoney(main, { priced, label: path });
  return main;
}

// ---------------------------------------------------------------------------------------------------------
// The world: Acme Inc with an Owner, a Manager (Dana) and her report (Sam) in Engineering, a Travel Admin and
// Finance, and a 20,000 dollar Engineering budget for Q4 2026.

async function world({ settings = {}, env = {}, budgetCents = 2000000, name = 'Acme Inc' } = {}) {
  const clock = mutableClock(FIXED_NOW);
  const app = await startApp({ ENABLE_BUSINESS: 'true', ...env }, { now: clock.now, store: new MemoryStore() });
  const svc = app.business;
  const owner = await seedUser(app, { name: 'Olivia Owner' });
  const org = await seedOrg(app, owner, { settings, name });
  const eng = await seedDepartment(app, org, { name: 'Engineering' });
  const dana = await seedMember(app, org, 'manager', { name: 'Dana Lee', departmentId: eng.id });
  const sam = await seedMember(app, org, 'employee', { name: 'Sam Rivera', departmentId: eng.id, managerId: dana.user.id });
  const tom = await seedMember(app, org, 'travel_admin', { name: 'Tom Travel' });
  const fay = await seedMember(app, org, 'finance', { name: 'Fay Finance' });
  if (budgetCents !== null) await seedBudget(app, org, eng.id, { periodKey: '2026-Q4', amountCents: budgetCents });
  const as = m => ({ org: { id: org.id }, user: m.user });
  const http = m => client(app.base, m.cookie);
  return {
    app, svc, clock, org, eng, owner, dana, sam, tom, fay, as,
    B: `/business/o/${org.id}`,
    c: { owner: http(owner), dana: http(dana), sam: http(sam), tom: http(tom), fay: http(fay), anon: client(app.base) },
  };
}

const keyWhere = (sv, leg, f) => {
  const hit = sv.legs[leg].rows.find(f);
  assert.ok(hit, `a ${leg} row for the test`);
  return hit.row.key;
};
const zm = r => r.row.available && r.row.carrier.code === 'ZM';

/** The POST /trips form for Business class on both legs and a 5-star hotel: out of the Standard policy. */
async function businessForm(w, purpose = 'Board meeting in London') {
  const sv = await w.svc.searchTrip(w.as(w.sam), BQ);
  return { ...BQ, out: keyWhere(sv, 'out', zm), back: keyWhere(sv, 'back', zm), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5), purpose };
}

/** POST /trips, answered 303 to the new request: its id. */
async function createDraft(w, form, who = w.c.sam) {
  const res = await who.post(`${w.B}/trips`, form);
  assert.equal(res.status, 303, res.text.slice(0, 400));
  const m = res.location.match(new RegExp(`^${w.B}/trips/(btr_[A-Za-z0-9_-]+)$`));
  assert.ok(m, res.location);
  return m[1];
}

const revOf = (page, action) => {
  const form = page.match(new RegExp(`<form[^>]*action="[^"]*/${action}"[\\s\\S]*?</form>`));
  assert.ok(form, `a ${action} form`);
  return form[0].match(/name="rev" value="(\d+)"/)[1];
};

// ---------------------------------------------------------------------------------------------------------

/** Business class and a 5-star hotel, sent for approval with a reason: the pending request's id. */
async function pendingTrip(w, purpose = 'Board meeting in London') {
  const rid = await createDraft(w, await businessForm(w, purpose));
  const page = await w.c.sam.get(`${w.B}/trips/${rid}`);
  const res = await w.c.sam.post(`${w.B}/trips/${rid}/submit`, { rev: revOf(page.text, 'submit'), reason: REASON, category: 'client_meeting' });
  assert.equal(res.location, `${w.B}/trips/${rid}?ok=submitted`);
  return rid;
}

const stored = async (w, rid) => (await w.svc.getRequest(w.as(w.sam), rid)).request;
const engBudget = async w => (await w.svc.listBudgets(w.as(w.fay), '2026-Q4')).find(b => b.department.id === w.eng.id);

test('the inbox: who reaches it, each tab, the counts, the rows with "Expires in", and the home block', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;

  // Who reaches it.
  assert.equal((await c.sam.get(`${B}/approvals`)).status, 403);
  assert.equal((await c.fay.get(`${B}/approvals`)).status, 403);
  assert.equal((await c.dana.get(`${B}/approvals?tab=company`)).status, 404, 'Company is for admins with override');
  assert.equal((await c.dana.get(`${B}/approvals?tab=nope`)).status, 404);
  assert.equal((await c.dana.get(`${B}/approvals?tab=waiting&cursor=bogus`)).status, 404);
  const forbidden = await c.sam.get(`${B}/approvals`);
  noInline('/approvals (employee)', forbidden.text);

  // Empty.
  let res = await c.dana.get(`${B}/approvals`);
  assert.equal(res.status, 200);
  let main = checkPage('/approvals empty', res, { priced: false });
  assert.match(textOf(main), /Nothing is waiting for you\./);
  assert.match(textOf(main), /We don't send emails yet, so check back here\./);
  assert.doesNotMatch(main, /aria-current="page"><span>Company/);
  res = await c.tom.get(`${B}/approvals?tab=company`);
  main = checkPage('/approvals company empty', res, { priced: false });
  assert.match(textOf(main), /Nothing is waiting for approval at Acme Inc\./);

  // Two pending requests from Sam: oldest first.
  const rid1 = await pendingTrip(w, 'Board meeting in London');
  w.clock.set('2026-10-09T10:00:00.000Z');
  const rid2 = await pendingTrip(w, 'Partner summit in London');
  const snap = storeSnapshot(w.app);
  res = await c.dana.get(`${B}/approvals`);
  assert.equal(storeSnapshot(w.app), snap, 'the inbox writes nothing');
  main = checkPage('/approvals waiting', res);
  assert.match(main, /aria-current="page"><span>Waiting for you<\/span><span class="bz-tab-count">2<\/span>/);
  const order = [rid1, rid2].map(id => main.indexOf(`href="${B}/trips/${id}"`));
  assert.ok(order[0] > 0 && order[1] > order[0], 'oldest first');
  assert.match(textOf(main), /Expires in 23 h/);
  assert.match(textOf(main), /Expires in 24 h/);
  assert.match(textOf(main), /\d+ policy reasons/);
  assert.doesNotMatch(main, /<form/, 'no decision from the list');

  // The manager's home shows the oldest waiting, with a link to all.
  res = await c.dana.get(B);
  main = checkPage('home (manager, waiting)', res, { priced: false });
  assert.match(textOf(main), /Waiting for you \(2\)/);
  assert.match(main, new RegExp(`href="${B}/approvals"`));
  // The shell's Approvals entry counts them too.
  assert.match(res.text, /Approvals/);

  // Tom sees them under Company, not under Waiting (they are Dana's).
  res = await c.tom.get(`${B}/approvals?tab=company`);
  main = checkPage('/approvals company', res);
  assert.match(main, new RegExp(`href="${B}/trips/${rid1}"`));
  assert.match(textOf(main), /As an admin you can decide any pending request but your own\. A note is needed\./);
  res = await c.tom.get(`${B}/approvals`);
  main = checkPage('/approvals tom waiting', res, { priced: false });
  assert.match(textOf(main), /Nothing is waiting for you\./);

  // Decided by you, after Dana approves one.
  const page = await c.dana.get(`${B}/trips/${rid1}`);
  res = await c.dana.post(`${B}/trips/${rid1}/decide`, { action: 'approve', note: '', rev: revOf(page.text, 'decide') });
  assert.equal(res.location, `${B}/trips/${rid1}?ok=approved`);
  res = await c.dana.get(`${B}/approvals?tab=decided`);
  main = checkPage('/approvals decided', res);
  assert.match(main, new RegExp(`href="${B}/trips/${rid1}"`));
  assert.doesNotMatch(main, new RegExp(`href="${B}/trips/${rid2}"`));
  assert.match(textOf(main), /Approved/);
  res = await c.dana.get(`${B}/approvals`);
  assert.match(res.text, /<span class="bz-tab-count">1<\/span>/);
});

test('deny needs a reason: 422 with what was typed and nothing written, then "Denied by Dana Lee: …" for Sam with a way to plan it again', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  assert.ok((await engBudget(w)).awaitingCents > 0);
  let page = await c.dana.get(`${B}/trips/${rid}`);
  const rev = revOf(page.text, 'decide');

  const snap = storeSnapshot(w.app);
  let res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'deny', note: 'No.', rev });
  assert.equal(res.status, 422);
  assert.equal(storeSnapshot(w.app), snap, 'nothing written');
  let main = checkPage('deny without a reason', res);
  assert.match(main, /<div class="alert alert-error bz-alert" role="alert">[\s\S]*?<a href="#d-note">Tell the traveler why, in at least 10 characters\.<\/a>/, 'the box links to the field');
  assert.match(main, /<textarea id="d-note"[^>]*aria-invalid="true"[^>]*>No\.<\/textarea>/);

  const note = 'Please fly Economy for a meeting this short.';
  res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'deny', note, rev });
  assert.equal(res.status, 303);
  assert.equal(res.location, `${B}/trips/${rid}?ok=denied`);
  res = await c.dana.get(res.location);
  main = checkPage('denied (approver)', res);
  assert.match(textOf(main), /Decision saved\. Sam sees your note on this trip\./);
  assert.doesNotMatch(main, /action="[^"]*\/decide"/, 'no second decision');

  page = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('denied (traveler)', page);
  assert.match(textOf(main), /Denied by Dana Lee: Please fly Economy for a meeting this short\./);
  assert.match(textOf(main), /Nothing was booked or charged\. You can plan the trip again with other options\./);
  assert.doesNotMatch(textOf(main), /Budget|No budget set/, 'a denied trip holds nothing, so no budget line (and never "No budget set" for a department that has one)');
  assert.match(main, new RegExp(`href="${B}/trips/search\\?from=CAI&amp;to=LHR&amp;depart=2026-11-12&amp;return=2026-11-16&amp;hotel=1&amp;cabin=business"`));
  assert.deepEqual([(await engBudget(w)).awaitingCents, (await engBudget(w)).committedCents], [0, 0]);
});

test('an expired request: shown as expired on a GET with nothing written, listed under Expired with no actions, and refused on decide with the time it expired', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  const page = await c.dana.get(`${B}/trips/${rid}`);
  const rev = revOf(page.text, 'decide');
  w.clock.set('2026-10-10T09:30:00.000Z');

  let snap = storeSnapshot(w.app);
  let res = await c.dana.get(`${B}/trips/${rid}`);
  assert.equal(res.status, 200);
  assert.equal(storeSnapshot(w.app), snap, 'a GET never stores the expiry');
  let main = checkPage('expired (approver)', res);
  assert.match(textOf(main), /Expired at 12:00 PM, Sat 10 Oct \(Cairo time\)\. Nothing was approved\./);
  assert.match(textOf(main), /Sam can plan it again\./);
  assert.doesNotMatch(main, /<form[^>]*action="[^"]*\/(?:decide|cancel)"/);

  res = await c.dana.get(`${B}/approvals?tab=expired`);
  main = checkPage('/approvals expired', res);
  assert.match(main, new RegExp(`href="${B}/trips/${rid}"`));
  assert.doesNotMatch(main, /<form/);
  assert.match(textOf(main), /These expired before anyone decided them\. Nothing was approved, and there is nothing to do here\./);
  assert.equal(storeSnapshot(w.app), snap);
  res = await c.dana.get(`${B}/approvals`);
  assert.match(textOf(mainOf(res.text)), /Nothing is waiting for you\./);

  res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev });
  assert.equal(res.status, 409);
  main = checkPage('decide on expired', res);
  assert.match(textOf(main), /This request expired at 12:00 PM, Sat 10 Oct \(Cairo time\)\. Ask Sam to plan it again\./);
  assert.equal((await stored(w, rid)).status, 'expired', 'the POST stored the expiry');
  assert.equal((await engBudget(w)).awaitingCents, 0);

  res = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('expired (traveler)', res);
  assert.match(textOf(main), /Expired at 12:00 PM, Sat 10 Oct \(Cairo time\)\. Nothing was approved\./);
  assert.match(textOf(main), /Plan this trip again/);
});

test('an admin override: the note is required, then "Approved by Tom Travel as Travel Admin (assigned to Dana Lee)", listed as an override', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  let res = await c.tom.get(`${B}/trips/${rid}`);
  assert.equal(res.status, 200);
  let main = checkPage('override page', res);
  assert.match(textOf(main), /You're deciding as Travel Admin for Dana Lee, the assigned approver\. Add a note of at least 10 characters\./);
  assert.match(textOf(main), /Waiting for Dana Lee since/);
  const rev = revOf(main, 'decide');

  res = await c.tom.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev });
  assert.equal(res.status, 422);
  main = checkPage('override without a note', res);
  assert.match(textOf(main), /Add a note of at least 10 characters to approve a request assigned to someone else\./);

  res = await c.tom.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: 'Dana is away this week; approved for the board.', rev });
  assert.equal(res.location, `${B}/trips/${rid}?ok=approved`);
  res = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('approved by override', res);
  assert.match(textOf(main), /Approved by Tom Travel as Travel Admin \(assigned to Dana Lee\)\./);
  assert.match(textOf(main), /Note from Tom Travel: “Dana is away this week; approved for the board\.”/);
  res = await c.tom.get(`${B}/approvals?tab=decided`);
  main = checkPage('decided (override)', res);
  assert.match(textOf(main), /Decided as an override/);
});

test('over budget: the approver sees by how much, a box to approve anyway, 422 without it and the approval with it', async t => {
  const w = await world({ budgetCents: 100000 });
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  let res = await c.dana.get(`${B}/trips/${rid}`);
  let main = checkPage('over budget page', res);
  assert.match(textOf(main), /Engineering has \$1,000 left for Q4 2026\. This trip needs \$[\d,.]+ ?, so approving it goes \$[\d,.]+ ?over\./);
  assert.match(main, /<input id="d-ack" type="checkbox" name="ackOverBudget" value="1"/);
  assert.match(textOf(main), /Approve even though Engineering goes \$[\d,.]+ ?over its Q4 2026 budget\./);
  const rev = revOf(main, 'decide');

  const snap = storeSnapshot(w.app);
  res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev });
  assert.equal(res.status, 422);
  assert.equal(storeSnapshot(w.app), snap);
  main = checkPage('over budget refused', res);
  assert.match(textOf(main), /Approving this takes Engineering over its Q4 2026 budget\. Tick the box to approve it anyway\./);
  assert.match(main, /<input id="d-ack"[^>]*aria-invalid="true"/);

  res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', ackOverBudget: '1', rev });
  assert.equal(res.location, `${B}/trips/${rid}?ok=approved`);
  res = await c.dana.get(res.location);
  main = checkPage('approved over budget', res);
  assert.match(textOf(main), /Approved even though it goes over the department's budget\./);
  const budget = await engBudget(w);
  assert.equal(budget.committedCents, (await stored(w, rid)).totalCents);
  assert.ok(budget.remainingCents < 0);
});

test('messages, cancel and a stale form: both sides write on the page, a too-short message is 422, a cancel withdraws it, and a decision on an old form answers 409', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  const danaPage = await c.dana.get(`${B}/trips/${rid}`);
  const danaRev = revOf(danaPage.text, 'decide');

  let res = await c.dana.post(`${B}/trips/${rid}/message`, { text: 'x' });
  assert.equal(res.status, 422);
  let main = checkPage('short message', res);
  assert.match(textOf(main), /Write 2 to 1,000 characters\./);
  assert.match(main, /<textarea id="m-text"[^>]*aria-invalid="true"[^>]*>x<\/textarea>/);

  res = await c.dana.post(`${B}/trips/${rid}/message`, { text: 'Is there an earlier flight that works?' });
  assert.equal(res.location, `${B}/trips/${rid}?ok=message`);
  res = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('message (traveler)', res);
  assert.match(textOf(main), /Dana Lee 12:00 PM today Is there an earlier flight that works\?/);
  res = await c.sam.post(`${B}/trips/${rid}/message`, { text: 'The earlier one lands after the meeting starts.' });
  assert.equal(res.location, `${B}/trips/${rid}?ok=message`);
  res = await c.dana.get(`${B}/trips/${rid}`);
  main = checkPage('thread (approver)', res);
  assert.match(textOf(main), /You 12:00 PM today Is there an earlier flight that works\? Sam Rivera 12:00 PM today The earlier one lands after the meeting starts\./);

  // Sam cancels; Dana's open form is now stale.
  const samPage = await c.sam.get(`${B}/trips/${rid}`);
  res = await c.sam.post(`${B}/trips/${rid}/cancel`, { rev: revOf(samPage.text, 'cancel') });
  assert.equal(res.location, `${B}/trips/${rid}?ok=cancelled`);
  assert.equal((await engBudget(w)).awaitingCents, 0);
  res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: danaRev });
  assert.equal(res.status, 409);
  main = checkPage('stale decide', res);
  assert.match(textOf(main), /Someone (?:else )?just acted on this request\. Here is where it stands now\./);
  assert.match(textOf(main), /Sam Rivera cancelled this trip at /);
  assert.equal((await stored(w, rid)).status, 'cancelled');
  res = await c.dana.get(`${B}/approvals`);
  assert.match(textOf(mainOf(res.text)), /Nothing is waiting for you\./);
});

test('a price that changed while it waited: the approver sees now and was, and approving sends it back to Sam, who sees why and can ask again', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c, svc } = w;
  const rid = await pendingTrip(w);
  const before = await stored(w, rid);
  const hotels = svc.inventory.hotels;
  const real = hotels.quote;
  t.after(() => { hotels.quote = real; });
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 4000 } : l)) };
  };

  let res = await c.dana.get(`${B}/trips/${rid}`);
  let main = checkPage('changed price (approver)', res);
  assert.match(textOf(main), /Price checked again at 12:00 PM today: now \$[\d,.]+ ?\(was \$[\d,.]+ ?\)\. If you approve, it goes back to Sam to confirm the new price\./);
  res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(main, 'decide') });
  assert.equal(res.location, `${B}/trips/${rid}?ok=returned`);
  res = await c.dana.get(res.location);
  main = checkPage('returned (approver)', res);
  assert.match(textOf(main), /The price changed while this was waiting, so it went back to Sam\. Nothing was approved\./);
  assert.doesNotMatch(main, /alert-success/, 'the banner says it once');

  const after = await stored(w, rid);
  assert.deepEqual([after.status, after.totalCents - before.totalCents], ['draft', 4000]);
  res = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('returned (traveler)', res);
  assert.match(textOf(main), /The price changed while this was waiting, so it came back to you\. Nothing was approved\./);
  assert.match(textOf(main), /Was \$[\d,.]+ ?, now \$[\d,.]+ ?\./);
  assert.match(main, /<textarea id="s-reason"/, 'Request Approval again');
});

test('nobody decides their own trip: an admin\'s own request goes to the owner, with no decision form for the admin', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c, svc } = w;
  const sv = await svc.searchTrip(w.as(w.tom), BQ);
  const form = { ...BQ, out: keyWhere(sv, 'out', zm), back: keyWhere(sv, 'back', zm), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5), purpose: 'Supplier visit in London' };
  const rid = await createDraft(w, form, c.tom);
  let page = await c.tom.get(`${B}/trips/${rid}`);
  assert.match(textOf(mainOf(page.text)), /Goes to Olivia Owner \(Acme Inc's admins\)\./);
  let res = await c.tom.post(`${B}/trips/${rid}/submit`, { rev: revOf(page.text, 'submit'), reason: REASON });
  assert.equal(res.location, `${B}/trips/${rid}?ok=submitted`);
  page = await c.tom.get(`${B}/trips/${rid}`);
  const main = checkPage('own pending (admin)', page);
  assert.match(textOf(main), /You can't decide your own trip\./);
  assert.doesNotMatch(main, /action="[^"]*\/decide"/);
  const snap = storeSnapshot(w.app);
  res = await c.tom.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: 'Approving my own trip here.', rev: '1' });
  assert.ok([403, 404, 422].includes(res.status), String(res.status));
  assert.equal(storeSnapshot(w.app), snap);
  res = await c.owner.get(`${B}/approvals`);
  assert.match(mainOf(res.text), new RegExp(`href="${B}/trips/${rid}"`));
});

// ---------------------------------------------------------------------------------------------------------
// Review fixes (Stage 2B review 2)

/** Ann (Engineering, managed by Dana) whose assigned approver is Max, a Manager in Operations. */
async function withMax(w) {
  const ops = await seedDepartment(w.app, w.org, { name: 'Operations' });
  const max = await seedMember(w.app, w.org, 'manager', { name: 'Max Moss', departmentId: ops.id });
  const ann = await seedMember(w.app, w.org, 'employee', { name: 'Ann Approve', departmentId: w.eng.id, managerId: w.dana.user.id, approverId: max.user.id });
  w.c.max = client(w.app.base, max.cookie);
  w.c.ann = client(w.app.base, ann.cookie);
  return { max, ann };
}

/** Raise every hotel quote's first line by `cents` until the test ends. */
function bumpHotels(t, w, cents = 4000) {
  const hotels = w.svc.inventory.hotels;
  const real = hotels.quote;
  t.after(() => { hotels.quote = real; });
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + cents } : l)) };
  };
  return () => { hotels.quote = real; };
}

test('an assigned approver who is not the manager: approving a re-priced request lands on Approvals with what happened, not on a 404', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c, svc } = w;
  const { ann } = await withMax(w);
  const sv = await svc.searchTrip(w.as(ann), BQ);
  const rid = await createDraft(w, { ...BQ, out: keyWhere(sv, 'out', zm), back: keyWhere(sv, 'back', zm), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5), purpose: 'Board meeting in London' }, c.ann);
  let page = await c.ann.get(`${B}/trips/${rid}`);
  assert.match(textOf(mainOf(page.text)), /Goes to Max Moss \(your approver\)\./);
  let res = await c.ann.post(`${B}/trips/${rid}/submit`, { rev: revOf(page.text, 'submit'), reason: REASON });
  assert.equal(res.location, `${B}/trips/${rid}?ok=submitted`);
  bumpHotels(t, w);
  page = await c.max.get(`${B}/trips/${rid}`);
  assert.equal(page.status, 200);
  res = await c.max.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(page.text, 'decide') });
  assert.equal(res.status, 303);
  assert.equal(res.location, `${B}/approvals?ok=returned`, 'Max can no longer open the draft, so the answer is his inbox');
  res = await c.max.get(res.location);
  assert.equal(res.status, 200);
  const main = checkPage('/approvals after a return', res, { priced: false });
  assert.match(textOf(main), /The trip changed while it waited, so it went back to the traveler to confirm\. Nothing was approved\./);
  assert.equal((await svc.getRequest(w.as(ann), rid)).request.status, 'draft');
  // Dana still opens it (she manages Ann), so her answer stays the request page.
});

test('sold out while waiting: the approver is not promised another option, and the traveler gets a way forward, not a policy block', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c, svc } = w;
  const rid = await pendingTrip(w);
  const hotels = svc.inventory.hotels;
  const real = hotels.quote;
  t.after(() => { hotels.quote = real; });
  const { AppError } = require('../server/lib/errors');
  hotels.quote = async () => { throw new AppError('option_sold_out', 'Sold out', 409); };
  let page = await c.dana.get(`${B}/trips/${rid}`);
  let main = checkPage('sold out (approver)', page);
  assert.doesNotMatch(textOf(main), /pick another option/i, 'nothing promises an option that may not exist');
  assert.match(textOf(main), /an option is no longer in the demo data\. Approving sends it back to Sam, and nothing is approved\./);
  assert.match(main, /name="action" value="approve"[^>]*>[\s\S]*?Send back to Sam/, 'the button says what it does');
  const res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(main, 'decide') });
  assert.equal(res.location, `${B}/trips/${rid}?ok=returned`);
  hotels.quote = real;
  page = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('sold out (traveler)', page);
  const body = textOf(main);
  assert.doesNotMatch(body, /can't be requested under Acme Inc's policy/, 'a sold-out option is not the company policy');
  assert.doesNotMatch(body, /Blocked by policy/);
  assert.match(body, /An option in this trip is no longer in the demo data/);
  const alts = (main.match(/name="altId"/g) || []).length;
  if (!alts) assert.doesNotMatch(body, /Pick another option below/);
  assert.match(main, new RegExp(`href="${B}/trips/search\\?[^"]*"`), 'a way to plan the trip again');
  assert.match(body, /Plan this trip again/);
});

test('the approver\'s panel: the deny rule keeps its own hint beside the counter, the bar holds Approve and Deny, reasons name the traveler, and a Business search says why there is nothing to compare', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  const res = await c.dana.get(`${B}/trips/${rid}`);
  const main = checkPage('approver panel', res);
  // The counter (/js/business.js rewrites #d-note-count) and the rule are two elements.
  const ta = main.match(/<textarea id="d-note"[^>]*>/)[0];
  assert.match(ta, /data-count="d-note-count"/);
  assert.match(ta, /aria-describedby="d-note-hint d-note-count"/);
  assert.match(main, /<p class="field-hint" id="d-note-hint">Needed to deny: tell Sam why, in at least 10 characters\. Sam sees this note\.<\/p>/);
  assert.match(main, /<p class="field-hint bz-charcount" id="d-note-count"[^>]*>Up to 500 characters\.<\/p>/);
  // Approve and Deny in the bar; "Ask a question" is a link outside it.
  const bar = main.match(/<div class="bz-actionbar">([\s\S]*?)<\/div>/)[1];
  assert.match(bar, /value="approve"/);
  assert.match(bar, /value="deny"/);
  assert.doesNotMatch(bar, /Ask a question/);
  assert.match(main, /<a class="bz-ask" href="#message">/);
  // The reasons are Sam's limits, not the viewer's.
  assert.match(textOf(main), /Business class is above Sam's limit \(Economy\)/);
  assert.doesNotMatch(textOf(main), /\byour limit\b|Your policy allows/);
  // Sam searched Business class: there was no fare in the allowed cabin to compare with.
  assert.match(textOf(main), /Sam searched Business class, so there is no Economy fare to compare\./);
});

test('over budget: the box\'s label is one sentence, with the demo note under it in the same demo container', async t => {
  const w = await world({ budgetCents: 100000 });
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  const res = await c.dana.get(`${B}/trips/${rid}`);
  const main = checkPage('over budget label', res);
  const label = main.match(/<label class="bz-choice" for="d-ack">([\s\S]*?)<\/label>/)[1];
  assert.match(textOf(label), /^Approve even though Engineering goes \$[\d,.]+ ?over its Q4 2026 budget\.$/);
  assert.doesNotMatch(label, /Priced at|demo/i);
  const box = main.match(/<div class="bz-demo-box bz-ack-box"[^>]*data-price-source="demo"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  assert.ok(box, 'the box and its note share a demo container');
  assert.match(textOf(box[1]), /Demo price · Priced at/);
});

test('the inbox: the Expires column says "in 24 h", and after an approval the notice does not repeat the banner', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  let res = await c.dana.get(`${B}/approvals`);
  let main = checkPage('/approvals', res);
  assert.match(main, /<span class="bz-cell-label">Expires<\/span><span class="bz-cell-value"><span class="bz-nowrap">in 24 h<\/span>/);
  assert.doesNotMatch(main, /<span class="bz-cell-value"><span class="bz-nowrap">Expires/, 'the value does not repeat its label');
  const page = await c.dana.get(`${B}/trips/${rid}`);
  res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(page.text, 'decide') });
  res = await c.dana.get(res.location);
  main = checkPage('approved notice', res);
  const notice = main.match(/<div class="alert alert-success bz-alert" role="status">([\s\S]*?)<\/div>/);
  assert.ok(notice, 'a notice for the approval');
  assert.match(textOf(notice[1]), /^Approval saved\. Sam sees it on this trip\.$/);
});

test('an expired request refused on decide: the time is said once, in the error', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  const page = await c.dana.get(`${B}/trips/${rid}`);
  w.clock.set('2026-10-10T09:30:00.000Z');
  const res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(page.text, 'decide') });
  assert.equal(res.status, 409);
  const main = checkPage('expired 409', res);
  assert.equal(textOf(main).split('12:00 PM, Sat 10 Oct (Cairo time)').length - 1, 1, 'said once');
  assert.match(textOf(main), /This request expired at 12:00 PM, Sat 10 Oct \(Cairo time\)\. Ask Sam to plan it again\./);
});

test('a decider\'s view of a pending request counts against the compute limit (it prices again); the traveler\'s views do not', async t => {
  const w = await world({ env: { BUSINESS_COMPUTE_LIMIT: '8' } });
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await pendingTrip(w);
  for (let i = 0; i < 12; i += 1) assert.equal((await c.sam.get(`${B}/trips/${rid}`)).status, 200, 'the traveler\'s page prices nothing');
  let last;
  for (let i = 0; i < 9; i += 1) last = await c.dana.get(`${B}/trips/${rid}`);
  assert.equal(last.status, 429);
  assert.equal(last.headers.get('cache-control'), 'no-store');
  assert.match(String(last.headers.get('x-robots-tag')), /noindex/);
});
