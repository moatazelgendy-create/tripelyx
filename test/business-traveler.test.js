// Tripelyx Business traveler pages (plan §B4 "Trips and approvals", §B6, §H1 to §H3), Stage 2B: the
// workspace home, "Your travel policy", the trip form, the results page, the request page with its swap,
// submit and cancel, and the trip lists. Everything runs through HTTP on the real app (demo inventory, the
// real policy engine, alternatives and lifecycle), with the clock held at FIXED_NOW.
//
// The journey test is the one the plan names: a trip inside policy is approved by policy; Business class plus
// a 5-star hotel is out of policy, shows cheaper alternatives before Request Approval, a swap keeps it out, a
// short reason is refused with 422, then it goes to the manager, whose page shows the fresh price check and
// the comparison, and whose approval commits the budget. Every page is checked for the demo rule, its
// headings, its labels, and no inline style or script.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, FIXED_NOW } = require('./helpers');
const {
  seedUser, client, seedOrg, seedMember, seedDepartment, seedBudget, mutableClock, noInline, storeSnapshot,
} = require('./business-helpers');
const { MemoryStore } = require('../server/booking/MemoryStore');
const { ROUTES, router } = require('../server/routes/business/traveler');
const { assertRoutes } = require('../server/routes/business');
const { resultsView } = require('../server/views/business/results');
const { okText } = require('../server/views/business/request');

const Q = Object.freeze({ from: 'CAI', to: 'LHR', depart: '2026-11-12', return: '2026-11-16', hotel: '1', cabin: 'economy' });
const BQ = Object.freeze({ ...Q, cabin: 'business' });
const REASON = 'The board meets at the client office, and this is the only flight that lands in time.';
const qs = q => new URLSearchParams(q).toString();

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
const textMain = page => textOf(mainOf(page));

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
const within = r => r.row.available && r.row.carrier.code === 'ZA' && r.evaluation.status === 'within';
const zm = r => r.row.available && r.row.carrier.code === 'ZM';

/** The POST /trips form for a trip inside the Standard policy (Economy, one airline, a 3-star hotel). */
async function withinForm(w, purpose = 'Client workshop in London') {
  const sv = await w.svc.searchTrip(w.as(w.sam), Q);
  return { ...Q, out: keyWhere(sv, 'out', within), back: keyWhere(sv, 'back', within), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 3 && r.evaluation.status === 'within'), purpose };
}

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

test('ROUTES: the traveler table, frozen, with its gates and limiters, and the index accepts it', () => {
  assert.ok(Object.isFrozen(ROUTES));
  assert.deepEqual(ROUTES.map(r => `${r.method} ${r.path}`), [
    'GET /o/:orgId', 'GET /o/:orgId/policy', 'GET /o/:orgId/trips/new', 'GET /o/:orgId/trips/search', 'POST /o/:orgId/trips',
    'GET /o/:orgId/trips', 'GET /o/:orgId/trips/:rid', 'POST /o/:orgId/trips/:rid/swap', 'POST /o/:orgId/trips/:rid/submit',
    'POST /o/:orgId/trips/:rid/cancel', 'POST /o/:orgId/trips/:rid/decide', 'POST /o/:orgId/trips/:rid/message', 'GET /o/:orgId/approvals',
  ]);
  for (const r of ROUTES) {
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.limiter), r.path);
    assert.equal(r.who, 'member', r.path);
    if (r.method === 'POST') assert.ok(r.limiter.includes('bizWrite'), `${r.path}: every write is limited`);
    if (r.path.includes(':rid')) assert.equal(r.own, 'request', `${r.path}: the request gate`);
  }
  const compute = ROUTES.filter(r => r.limiter.includes('bizCompute')).map(r => `${r.method} ${r.path}`);
  assert.deepEqual(compute, ['GET /o/:orgId/trips/search', 'POST /o/:orgId/trips', 'POST /o/:orgId/trips/:rid/swap', 'POST /o/:orgId/trips/:rid/submit', 'POST /o/:orgId/trips/:rid/decide']);
  assert.doesNotThrow(() => assertRoutes([...ROUTES]));
  assert.equal(typeof router, 'function');
  // The ?ok= codes map to fixed text, and only those.
  const r = { travelerName: 'Sam Rivera', returned: null };
  assert.equal(okText('repriced', r, {}), 'This trip changed before it was sent. Review it and send it again.');
  assert.equal(okText('<script>', r, {}), null);
  assert.equal(okText('submitted', r, { status: 'draft' }), null, 'a notice that no longer fits the status is left out');
  assert.match(okText('message', r, { status: 'expired' }), /Message sent/);
});

test('the journey on demo inventory: inside policy is approved by policy; Business class and a 5-star hotel get alternatives, a swap, a 422 for a short reason, the manager\'s check and approval, and the budget committed', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;

  // The trip form.
  let res = await c.sam.get(`${B}/trips/new`);
  assert.equal(res.status, 200);
  let main = checkPage('/trips/new', res, { priced: false });
  assert.match(main, /<form[^>]*method="get"[^>]*action="[^"]*\/trips\/search"/);
  for (const name of ['from', 'to', 'depart', 'return', 'cabin', 'hotel', 'nights', 'flex']) assert.match(main, new RegExp(`name="${name}"`), name);
  assert.match(textOf(main), /Your department: Engineering · Your policy: Standard/);
  assert.doesNotMatch(main, /<fieldset[^>]*disabled/);

  // The search: every row with its badge and reasons; a GET writes nothing.
  const before = storeSnapshot(w.app);
  res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200);
  assert.equal(storeSnapshot(w.app), before, 'the search wrote nothing');
  main = checkPage('/trips/search', res);
  const text = textOf(main);
  assert.match(text, /Within Policy/);
  assert.match(text, /Show \d+ options? outside your policy/);
  assert.match(text, /Cairo \(CAI\) to London \(LHR\)/);
  assert.match(main, /class="bz-limits"/);
  assert.match(main, /<form class="bz-results" method="post" action="[^"]*\/trips">/);
  for (const name of ['out', 'back', 'hotelKey']) assert.match(main, new RegExp(`type="radio"[^>]*name="${name}"`), name);
  assert.doesNotMatch(main, /name="(?:totalCents|price|amount)"/, 'the form never carries a price');

  // (a) Inside policy: Confirm trip → approved by policy.
  const rid1 = await createDraft(w, await withinForm(w));
  res = await c.sam.get(`${B}/trips/${rid1}`);
  assert.equal(res.status, 200);
  main = checkPage('draft within', res);
  assert.match(textOf(main), /Review your trip/);
  assert.match(textOf(main), /Every part of this trip is inside your policy\. Confirm and it's approved to book\./);
  assert.match(textOf(main), /Confirm trip/);
  assert.doesNotMatch(main, /name="reason"/, 'no Request Approval form for a trip inside policy');
  res = await c.sam.post(`${B}/trips/${rid1}/submit`, { rev: revOf(main, 'submit') });
  assert.equal(res.status, 303);
  assert.equal(res.location, `${B}/trips/${rid1}?ok=auto_approved`);
  res = await c.sam.get(res.location);
  main = checkPage('approved by policy', res);
  assert.match(textOf(main), /Confirmed\. Your trip is approved to book under your policy\./);
  assert.match(textOf(main), /Approved to book\. Booking opens once Tripelyx connects airlines and hotels\. Nothing has been booked or charged\./);
  assert.match(textOf(main), /Approved by policy\./);
  const first = (await w.svc.getRequest(w.as(w.sam), rid1)).request;
  assert.equal(first.status, 'approved');

  // (b) Business class and a 5-star hotel: out of policy, alternatives before Request Approval.
  res = await c.sam.get(`${B}/trips/search?${qs(BQ)}`);
  assert.equal(res.status, 200);
  assert.match(textMain(res.text), /Out of Policy/);
  const rid2 = await createDraft(w, await businessForm(w));
  res = await c.sam.get(`${B}/trips/${rid2}`);
  main = checkPage('draft out', res);
  let body = textOf(main);
  assert.match(body, /Out of policy: \d+ reasons/);
  assert.match(body, /Business class/i, 'the cabin reason');
  const altsAt = body.indexOf('AI-powered cheaper alternatives');
  const askAt = body.indexOf('Request Approval');
  assert.ok(altsAt > 0 && askAt > altsAt, 'the alternatives come before Request Approval');
  assert.match(body, /Goes to Dana Lee \(your manager\)\./);
  assert.match(body, /Saves \$[\d,]+ vs your pick \(demo price\)/);
  assert.match(body, /What you give up/);
  const draft = (await w.svc.getRequest(w.as(w.sam), rid2)).request;
  const hotelAlt = draft.alternatives.filter(a => a.kind === 'hotel').sort((x, y) => y.savesCents - x.savesCents)[0];
  assert.ok(hotelAlt, 'a cheaper hotel');
  assert.match(main, new RegExp(`name="altId" value="${hotelAlt.id}"`));

  // The swap: still Business class, so still out of policy; the saving shows.
  res = await c.sam.post(`${B}/trips/${rid2}/swap`, { altId: hotelAlt.id, rev: String(draft.rev) });
  assert.equal(res.status, 303);
  assert.equal(res.location, `${B}/trips/${rid2}?ok=swapped`);
  res = await c.sam.get(res.location);
  main = checkPage('swapped', res);
  body = textOf(main);
  assert.match(body, /Switched to the cheaper option\. Here is your updated trip\./);
  assert.match(body, /Saved \$[\d,]+ by switching to cheaper options\./);
  assert.match(body, /Out of policy: 2 reasons/);
  assert.match(body, /Outbound flight: Business class is above your limit \(Economy\)/, 'the same rule on two flights names each flight');
  assert.match(body, /Return flight: Business class is above your limit \(Economy\)/);
  // The same swap again is a stale form: 409 with the page as it stands.
  res = await c.sam.post(`${B}/trips/${rid2}/swap`, { altId: hotelAlt.id, rev: String(draft.rev) });
  assert.equal(res.status, 409);
  checkPage('stale swap', res);

  // A reason under 10 characters: 422, what was typed kept, nothing written.
  const rev2 = revOf(main, 'submit');
  let snap = storeSnapshot(w.app);
  res = await c.sam.post(`${B}/trips/${rid2}/submit`, { rev: rev2, reason: 'Too short', category: 'schedule' });
  assert.equal(res.status, 422);
  main = checkPage('short reason', res);
  assert.match(textOf(main), /Tell your approver why this trip needs an exception, in 10 to 500 characters\./);
  assert.match(main, /<textarea id="s-reason"[^>]*aria-invalid="true"[^>]*>Too short<\/textarea>/);
  assert.match(main, /<option value="schedule" selected>/);
  assert.equal(storeSnapshot(w.app), snap, 'a refused submit writes nothing');

  // A good reason: it goes to Dana.
  res = await c.sam.post(`${B}/trips/${rid2}/submit`, { rev: rev2, reason: REASON, category: 'client_meeting' });
  assert.equal(res.status, 303);
  assert.equal(res.location, `${B}/trips/${rid2}?ok=submitted`);
  res = await c.sam.get(res.location);
  main = checkPage('pending (traveler)', res);
  body = textOf(main);
  assert.match(body, /Sent for approval\. We don't send emails yet, so Dana Lee will see it under Approvals\./);
  assert.match(body, /Waiting for Dana Lee since /);
  assert.match(body, /Expires at /);
  assert.match(body, /Cancel request/);
  assert.doesNotMatch(main, /name="action" value="approve"/, 'the traveler cannot decide');

  // Dana's inbox and the request with the fresh price check, the comparison and the budget.
  res = await c.dana.get(`${B}/approvals`);
  assert.equal(res.status, 200);
  main = checkPage('/approvals (Dana)', res);
  assert.match(main, /aria-current="page"><span>Waiting for you<\/span><span class="bz-tab-count">1<\/span>/);
  assert.match(textOf(main), /Sam Rivera/);
  assert.match(textOf(main), /Expires in 24 h/);
  assert.match(main, new RegExp(`href="${B}/trips/${rid2}"`));
  snap = storeSnapshot(w.app);
  res = await c.dana.get(`${B}/trips/${rid2}`);
  assert.equal(res.status, 200);
  assert.equal(storeSnapshot(w.app), snap, 'the approver\'s page and its price check write nothing');
  main = checkPage('pending (approver)', res);
  body = textOf(main);
  assert.match(body, /Sam Rivera's trip to London/);
  assert.match(body, /Your decision/);
  assert.match(body, /Price checked again at 12:00 PM today: unchanged\./);
  assert.match(body, /Requested vs cheapest option inside policy/);
  assert.ok(body.includes(`“${REASON}”`), 'the traveler\'s reason');
  assert.match(body, /Category: Client meeting/);
  const pending = (await w.svc.getRequest(w.as(w.sam), rid2)).request;
  const remaining = 2000000 - first.totalCents;
  assert.match(body, /Uses \$[\d,.]+ of \$[\d,.]+ left in Engineering for Q4 2026\./);
  assert.match(main, /name="action" value="approve"/);
  assert.match(main, /name="action" value="deny"/);
  assert.match(main, /href="#message"/);

  // Approve.
  res = await c.dana.post(`${B}/trips/${rid2}/decide`, { action: 'approve', note: '', rev: revOf(main, 'decide') });
  assert.equal(res.status, 303);
  assert.equal(res.location, `${B}/trips/${rid2}?ok=approved`);
  res = await c.dana.get(res.location);
  main = checkPage('approved (approver)', res);
  assert.match(textOf(main), /Approved\. The trip is approved to book\./);
  assert.match(textOf(main), /Approved by Dana Lee\./);
  res = await c.sam.get(`${B}/trips/${rid2}`);
  main = checkPage('approved (traveler)', res);
  assert.match(textOf(main), /Approved by Dana Lee\./);
  assert.match(textOf(main), /This trip holds \$[\d,.]+ ?of Engineering's Q4 2026 budget\. In all, \$[\d,.]+ ?of \$20,000 is committed\./);

  // The budget holds both trips.
  const budget = (await w.svc.listBudgets(w.as(w.fay), '2026-Q4')).find(b => b.department.id === w.eng.id);
  const done = (await w.svc.getRequest(w.as(w.sam), rid2)).request;
  assert.deepEqual([budget.committedCents, budget.awaitingCents, budget.remainingCents], [first.totalCents + done.totalCents, 0, remaining - done.totalCents]);
  assert.equal(done.totalCents, pending.totalCents);

  // Sam's list shows both, approved.
  res = await c.sam.get(`${B}/trips`);
  main = checkPage('/trips', res);
  assert.equal((textOf(main).match(/Approved/g) || []).length >= 2, true);
  assert.match(main, new RegExp(`href="${B}/trips/${rid1}"`));
  assert.match(main, new RegExp(`href="${B}/trips/${rid2}"`));
});

test('a blocked airline: a banner names it, its fares cannot be picked, and a draft on one shows the verdict instead of Request Approval; submit is refused', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c, svc } = w;
  const view = await svc.getPolicy(w.as(w.owner), 'standard');
  await svc.savePolicy(w.as(w.owner), 'standard', { form: { ...view.form, blockedCarriers: ['ZS'] }, rev: view.rev, note: 'Sahara Wings is not used' });

  const res0 = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res0.status, 200);
  const main0 = checkPage('search with a blocked carrier', res0);
  assert.match(textOf(main0), /Sahara Wings isn't used by Acme Inc\. Options on other airlines are below\./);
  const sv = await svc.searchTrip(w.as(w.sam), Q);
  const zs = sv.legs.out.rows.filter(r => r.row.carrier.code === 'ZS' && r.row.available);
  assert.ok(zs.length, 'Sahara Wings flies this route');
  for (const r of zs) {
    const input = main0.match(new RegExp(`<input[^>]*value="${r.row.key.replace(/[|.]/g, '\\$&')}"[^>]*>`));
    assert.ok(input, r.row.key);
    assert.match(input[0], / disabled/, `${r.row.key} cannot be picked`);
  }
  assert.match(textOf(main0), /Blocked by policy/);

  // A crafted POST on a blocked fare still makes a draft, held as blocked.
  const form = { ...Q, hotel: '', out: zs[0].row.key, back: keyWhere(sv, 'back', within), purpose: 'Site visit in London' };
  const rid = await createDraft(w, form);
  const res = await c.sam.get(`${B}/trips/${rid}`);
  const main = checkPage('blocked draft', res);
  assert.match(textOf(main), /This trip can't be requested under Acme Inc's policy\./);
  assert.doesNotMatch(main, /name="reason"/, 'no Request Approval form for a blocked trip');
  assert.doesNotMatch(textOf(main), /Confirm trip/);
  const draft = (await svc.getRequest(w.as(w.sam), rid)).request;
  const snap = storeSnapshot(w.app);
  const refused = await c.sam.post(`${B}/trips/${rid}/submit`, { rev: String(draft.rev), reason: REASON });
  assert.equal(refused.status, 422);
  checkPage('blocked submit', refused);
  assert.equal(storeSnapshot(w.app), snap);
  assert.equal(await svc.inboxCount(w.as(w.dana)), 0);
});

test('block mode: the results say trips outside policy can\'t be requested, an out-of-policy pick is blocked, and the policy page says so', async t => {
  const w = await world({ settings: { outOfPolicy: 'block' } });
  t.after(w.app.close);
  const { B, c } = w;
  let res = await c.sam.get(`${B}/trips/search?${qs(BQ)}`);
  assert.equal(res.status, 200);
  let main = checkPage('block mode search', res);
  assert.match(textOf(main), /At Acme Inc, trips outside the policy can't be requested\. Pick options marked Within Policy\./);
  // Business class is outside the Standard policy, so in block mode no flight can be picked: they sit behind
  // "Show N options blocked by policy", with disabled radios, and no toggle claims options outside policy.
  assert.match(textOf(main), /None of these flights can be picked under Acme Inc's policy\. Try another date or cabin\./);
  assert.match(textOf(main), /Show \d+ options blocked by policy/);
  assert.doesNotMatch(textOf(main), /Show \d+ options? outside your policy/);
  for (const m of main.matchAll(/<input class="bz-opt-radio"[^>]*name="(?:out|back)"[^>]*>/g)) assert.match(m[0], / disabled/, m[0]);
  assert.doesNotMatch(textOf(main), /Review trip/, 'nothing to review');
  const rid = await createDraft(w, await businessForm(w));
  res = await c.sam.get(`${B}/trips/${rid}`);
  main = checkPage('block mode draft', res);
  assert.match(textOf(main), /This trip can't be requested under Acme Inc's policy\./);
  assert.doesNotMatch(main, /name="reason"/);
  res = await c.sam.get(`${B}/policy`);
  main = checkPage('/policy (block)', res, { priced: false });
  assert.match(textOf(main), /At Acme Inc, trips outside the policy can't be requested\./);
});

test('production config: the trip form says "Supplier not connected yet", search and create answer 503, and nothing is fabricated', async t => {
  const clock = mutableClock(FIXED_NOW);
  const app = await startApp({ APP_ENV: 'production', DATABASE_URL: 'postgres://x/prod', ENABLE_BUSINESS: 'true', ENABLE_TRIPS: 'false' }, { store: new MemoryStore(), now: clock.now });
  t.after(app.close);
  assert.equal(app.business.inventory.status, 'none');
  const owner = await seedUser(app, { name: 'Olivia Owner' });
  const org = await seedOrg(app, owner);
  const sam = await seedMember(app, org, 'employee', { name: 'Sam Rivera', departmentId: org.general.id });
  const c = client(app.base, sam.cookie);
  const B = `/business/o/${org.id}`;
  const h = { headers: { 'x-forwarded-proto': 'https' } };

  let res = await c.get(`${B}/trips/new`, h);
  assert.equal(res.status, 200);
  let main = checkPage('/trips/new (production)', res, { priced: false });
  assert.equal(textOf(main).split('Supplier not connected yet.').length - 1, 1, 'said once, by the panel');
  assert.match(main, /<fieldset class="bz-search-fields"[^>]*disabled/);
  assert.doesNotMatch(textOf(main), /demo/i, 'no demo flights to talk about');

  res = await c.get(`${B}/trips/search?${qs(Q)}`, h);
  assert.equal(res.status, 503);
  main = checkPage('/trips/search (production)', res, { priced: false });
  assert.equal(textOf(main).split('Supplier not connected yet.').length - 1, 1);
  assert.doesNotMatch(main, /bz-money/);

  res = await c.post(`${B}/trips`, { ...Q, out: 'flight|x|y', back: 'flight|x|z', hotelKey: '', purpose: 'Board meeting' }, h);
  assert.equal(res.status, 503);
  checkPage('POST /trips (production)', res, { priced: false });

  res = await c.get(`${B}/policy`, h);
  main = checkPage('/policy (production)', res, { priced: false });
  assert.match(textOf(main), /Limits are in US dollars\./);
  assert.doesNotMatch(textOf(main), /fares and rates they are checked against/, 'no demo fares to check against');

  res = await c.get(B, h);
  assert.equal(res.status, 200);
  main = checkPage('home (production)', res, { priced: false });
  assert.match(textOf(main), /Supplier not connected yet\./);
  assert.doesNotMatch(main, /href="[^"]*\/trips\/new"/, 'no link to a search that cannot run');
  res = await c.get(`${B}/trips`, h);
  main = checkPage('/trips (production)', res, { priced: false });
  assert.match(textOf(main), /No work trips yet\./);
  assert.doesNotMatch(main, /href="[^"]*\/trips\/new"/);
});

test('submit outcomes: a past departure is 422 too_late; a terms-only change says the trip changed and names no price change; a price change shows was and now', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c, svc } = w;
  const hotels = svc.inventory.hotels;
  const real = hotels.quote;
  t.after(() => { hotels.quote = real; });

  // Terms only: the room turns non-refundable at the same price.
  const rid1 = await createDraft(w, await withinForm(w));
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, cancellation: { ...q.cancellation, type: 'non_refundable', freeUntilHours: 0, summary: 'Non-refundable.' } };
  };
  let page = await c.sam.get(`${B}/trips/${rid1}`);
  let res = await c.sam.post(`${B}/trips/${rid1}/submit`, { rev: revOf(page.text, 'submit') });
  assert.equal(res.status, 303);
  assert.equal(res.location, `${B}/trips/${rid1}?ok=repriced`);
  res = await c.sam.get(res.location);
  let main = checkPage('repriced (terms)', res);
  let body = textOf(main);
  assert.match(body, /This trip changed before it was sent\. Review it and send it again\./);
  assert.match(body, /The fare or room terms changed before this was sent\. The price is the same\./);
  assert.doesNotMatch(body, /price changed|Was \$/i, 'no price change claimed when the totals are the same');
  // Sending it again now goes through (the terms are the new ones).
  res = await c.sam.post(`${B}/trips/${rid1}/submit`, { rev: revOf(main, 'submit') });
  assert.equal(res.location, `${B}/trips/${rid1}?ok=auto_approved`);

  // A real price change: each hotel quote 40 dollars dearer.
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 4000 } : l)) };
  };
  const rid2 = await createDraft(w, await withinForm(w, 'Second workshop in London'));
  hotels.quote = real;
  const was = (await svc.getRequest(w.as(w.sam), rid2)).request.totalCents;
  page = await c.sam.get(`${B}/trips/${rid2}`);
  res = await c.sam.post(`${B}/trips/${rid2}/submit`, { rev: revOf(page.text, 'submit') });
  assert.equal(res.location, `${B}/trips/${rid2}?ok=repriced`);
  res = await c.sam.get(res.location);
  main = checkPage('repriced (price)', res);
  body = textOf(main);
  const now = (await svc.getRequest(w.as(w.sam), rid2)).request.totalCents;
  assert.equal(was - now, 4000);
  assert.match(body, /This trip changed before it was sent\. Review it and send it again\./);
  assert.match(body, /The price changed before this was sent\./);
  assert.match(body, /Was \$[\d,.]+ ?, now \$[\d,.]+ ?\./);

  // A departure date that has passed: 422 too_late, nothing written.
  const rid3 = await createDraft(w, await withinForm(w, 'Third workshop in London'));
  page = await c.sam.get(`${B}/trips/${rid3}`);
  w.clock.set('2026-11-13T09:00:00.000Z');
  const snap = storeSnapshot(w.app);
  res = await c.sam.post(`${B}/trips/${rid3}/submit`, { rev: revOf(page.text, 'submit') });
  assert.equal(res.status, 422);
  main = checkPage('too late', res);
  assert.match(textOf(main), /This trip's departure date has passed\. Plan it again with new dates\./);
  assert.equal(storeSnapshot(w.app), snap);
});

test('the results page: a sold-out hotel is listed with no price and no radio; a sold-out room keeps a disabled radio; the toggle counts only options that can be picked', async t => {
  const w = await world();
  t.after(w.app.close);
  const sv = await w.svc.searchTrip(w.as(w.sam), Q);
  // Sell out every room of one hotel.
  const hotelId = sv.legs.hotel.rows.find(r => r.row.available).row.offerId;
  const soldOut = JSON.parse(JSON.stringify(sv));
  for (const r of soldOut.legs.hotel.rows) {
    if (r.row.offerId !== hotelId) continue;
    Object.assign(r.row, { available: false, totalCents: null, nightlyCents: null, nightlyInclCents: null, lines: [] });
    r.evaluation = { status: 'out', violations: [{ rule: 'inventory.unavailable', severity: 'warn', text: 'Not available in demo data' }] };
  }
  const html = String(resultsView(w.app.ctx, { org: w.org.org, view: soldOut, action: `${w.B}/trips` }));
  const card = elements(html).find(el => el.tag === 'article' && html.slice(el.start, el.end).includes(soldOut.legs.hotel.rows.find(r => r.row.offerId === hotelId).row.name));
  assert.ok(card, 'the sold-out hotel is listed');
  const cardHtml = html.slice(card.start, card.end);
  assert.match(textOf(cardHtml), /Not available in demo data/);
  assert.doesNotMatch(cardHtml, /type="radio"/, 'no radio');
  assert.doesNotMatch(cardHtml, /bz-money/, 'no price');
  assertDemoMoney(html, { label: 'results with a sold-out hotel' });
  assertLabelled(html, 'results with a sold-out hotel');

  // The real demo data has a room that is sold out at a hotel with others free: its radio is disabled.
  const res = await w.c.sam.get(`${w.B}/trips/search?${qs(Q)}`);
  const missing = sv.legs.hotel.rows.filter(r => !r.row.available);
  for (const r of missing) {
    const input = res.text.match(new RegExp(`<input[^>]*value="${r.row.key.replace(/[|.]/g, '\\$&')}"[^>]*>`));
    if (input) assert.match(input[0], / disabled/, r.row.key);
  }
  const outside = textOf(res.text).match(/Show (\d+) options? outside your policy/g) || [];
  const pickable = leg => sv.legs[leg].rows.filter(r => r.row.available && r.evaluation.status === 'out').length;
  const counts = outside.map(s => Number(s.match(/\d+/)[0]));
  for (const n of counts) assert.ok([pickable('out'), pickable('back'), pickable('hotel')].includes(n), `${n} counts only pickable rows`);
});

test('the search and create answer what the traveler must fix: 422 with the form and its field errors, and a bad purpose keeps the picks', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  let res = await c.sam.get(`${B}/trips/search?${qs({ ...Q, to: 'CAI' })}`);
  assert.equal(res.status, 422);
  let main = checkPage('search 422', res, { priced: false });
  assert.match(main, /aria-invalid="true"/);
  assert.match(main, /<form[^>]*action="[^"]*\/trips\/search"/);
  res = await c.sam.get(`${B}/trips/search?${qs({ ...Q, depart: '2025-01-01' })}`);
  assert.equal(res.status, 422);
  res = await c.sam.get(`${B}/trips/search?from=CAI&from=DXB&to=LHR&depart=2026-11-12`);
  assert.equal(res.status, 422, 'a repeated field is refused');

  const form = await businessForm(w);
  const snap = storeSnapshot(w.app);
  res = await c.sam.post(`${B}/trips`, { ...form, purpose: 'x' });
  assert.equal(res.status, 422);
  assert.equal(storeSnapshot(w.app), snap);
  main = checkPage('create 422', res);
  assert.match(main, /<input id="t-purpose"[^>]*aria-invalid="true"/);
  for (const k of [form.out, form.back, form.hotelKey]) {
    assert.match(main, new RegExp(`value="${k.replace(/[|.]/g, '\\$&')}" checked`), `${k} stays picked`);
  }
  res = await c.sam.post(`${B}/trips`, { ...form, out: '' });
  assert.ok([409, 422].includes(res.status), String(res.status));
  checkPage('create without an outbound', res);
});

test('home, policy and lists for each role: what each reaches, empty states, filters and a refused filter', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;

  let res = await c.sam.get(B);
  assert.equal(res.status, 200);
  let main = checkPage('home (employee)', res, { priced: false });
  let body = textOf(main);
  assert.match(body, /Hi, Sam/);
  assert.match(body, /Employee at Acme Inc/);
  assert.match(body, /Plan a work trip/);
  assert.match(body, /No work trips yet\./);
  assert.match(body, /Your policy at a glance/);
  assert.doesNotMatch(body, /Set up Acme Inc|Waiting for you|Budgets, Q4 2026/);

  res = await c.owner.get(B);
  main = checkPage('home (owner)', res, { priced: false });
  body = textOf(main);
  assert.match(body, /Set up Acme Inc/);
  assert.match(body, /No requests yet/, 'a share with nothing submitted is never 0%');
  assert.doesNotMatch(body, /\b0(\.0)?%/);

  res = await c.fay.get(B);
  main = checkPage('home (finance)', res, { priced: false });
  assert.match(textOf(main), /Budgets, Q4 2026/);
  assert.match(textOf(main), /Engineering/);

  res = await c.dana.get(B);
  main = checkPage('home (manager)', res, { priced: false });
  assert.match(textOf(main), /Waiting for you \(0\)/);
  assert.match(textOf(main), /Nothing is waiting for you\./);

  res = await c.sam.get(`${B}/policy`);
  assert.equal(res.status, 200);
  main = checkPage('/policy', res, { priced: false });
  assert.match(textOf(main), /What your policy allows/);
  assert.match(textOf(main), /you can request a trip outside the policy with a short reason/);

  // Lists.
  res = await c.sam.get(`${B}/trips`);
  main = checkPage('/trips empty', res);
  assert.match(textOf(main), /No work trips yet\./);
  assert.equal((await c.sam.get(`${B}/trips?scope=team`)).status, 403);
  assert.equal((await c.sam.get(`${B}/trips?scope=all`)).status, 403);
  assert.equal((await c.dana.get(`${B}/trips?scope=all`)).status, 403);
  assert.equal((await c.sam.get(`${B}/trips?scope=nope`)).status, 404);

  const rid = await createDraft(w, await businessForm(w));
  const draft = (await w.svc.getRequest(w.as(w.sam), rid)).request;
  await w.svc.submit(w.as(w.sam), rid, { rev: draft.rev, reason: REASON });

  res = await c.dana.get(`${B}/trips?scope=team`);
  assert.equal(res.status, 200);
  main = checkPage('/trips team', res);
  assert.match(textOf(main), /Sam Rivera/);
  assert.match(textOf(main), /Waiting for approval/);

  res = await c.tom.get(`${B}/trips?scope=all`);
  assert.equal(res.status, 200);
  main = checkPage('/trips all', res);
  assert.match(main, /<select[^>]*name="status"/);
  assert.match(main, /<select[^>]*name="departmentId"/);
  assert.match(main, /<select[^>]*name="travelerId"/);
  assert.match(main, /<select[^>]*name="period"/);
  assert.match(textOf(main), /Sam Rivera/);
  res = await c.tom.get(`${B}/trips?scope=all&status=approved`);
  main = checkPage('/trips all approved', res);
  assert.doesNotMatch(main, new RegExp(`href="${B}/trips/${rid}"`), 'the filter leaves the pending request out');
  res = await c.tom.get(`${B}/trips?scope=all&status=pending&departmentId=${w.eng.id}&travelerId=${w.sam.user.id}`);
  main = checkPage('/trips all filtered', res);
  assert.match(main, new RegExp(`href="${B}/trips/${rid}"`));
  res = await c.tom.get(`${B}/trips?scope=all&status=bogus`);
  assert.equal(res.status, 422);
  main = checkPage('/trips bad filter', res);
  assert.match(main, /aria-invalid="true"/);
  assert.match(main, new RegExp(`href="${B}/trips/${rid}"`), 'the unfiltered list still shows');
});

test('isolation and the gates: another company\'s requests are 404, signed out is sent to sign in, cross-site writes are 403, cancel works, and the compute limit answers 429', async t => {
  const w = await world({ env: { BUSINESS_COMPUTE_LIMIT: '5' } });
  t.after(w.app.close);
  const { B, c, app } = w;
  const rid = await createDraft(w, await withinForm(w));

  // Another company.
  const gina = await seedUser(app, { name: 'Gina Globex' });
  const globex = await seedOrg(app, gina, { name: 'Globex Ltd' });
  const g = client(app.base, gina.cookie);
  for (const path of [`${B}`, `${B}/trips/${rid}`, `${B}/trips`, `${B}/approvals`, `/business/o/${globex.id}/trips/${rid}`]) {
    const res = await g.get(path);
    assert.equal(res.status, 404, path);
    noInline(path, res.text);
  }
  const snap = storeSnapshot(app);
  for (const action of ['submit', 'cancel', 'decide', 'message', 'swap']) {
    const res = await g.post(`/business/o/${globex.id}/trips/${rid}/${action}`, { rev: '0', text: 'Hello from Globex', action: 'approve', note: 'Approving for my friend.' });
    assert.equal(res.status, 404, action);
  }
  assert.equal(storeSnapshot(app), snap, 'nothing of Acme\'s changed');

  // Signed out.
  let res = await c.anon.get(`${B}/trips/${rid}`);
  assert.equal(res.status, 303);
  assert.equal(res.location, `/business/signin?next=${encodeURIComponent(`${B}/trips/${rid}`)}`);

  // Cross-site.
  res = await c.sam.req(`${B}/trips/${rid}/cancel`, { method: 'POST', form: { rev: '0' }, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 403);
  assert.equal(storeSnapshot(app), snap);

  // Another employee of the same company cannot open Sam's draft.
  const eve = await seedMember(app, w.org, 'employee', { name: 'Eve Other', departmentId: w.org.general.id });
  assert.equal((await client(app.base, eve.cookie).get(`${B}/trips/${rid}`)).status, 404);

  // Cancel the draft.
  const page = await c.sam.get(`${B}/trips/${rid}`);
  res = await c.sam.post(`${B}/trips/${rid}/cancel`, { rev: revOf(page.text, 'cancel') });
  assert.equal(res.location, `${B}/trips/${rid}?ok=cancelled`);
  res = await c.sam.get(res.location);
  const main = checkPage('cancelled', res);
  assert.match(textOf(main), /Cancelled\. Nothing was booked or charged\./);
  assert.match(textOf(main), /You cancelled this trip at /);
  assert.doesNotMatch(main, /action="[^"]*\/(?:submit|cancel)"/, 'nothing left to do');

  // The compute limit: five searches a minute here, then 429 with the page chrome.
  let last;
  for (let i = 0; i < 6; i += 1) last = await c.dana.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(last.status, 429);
  assert.match(last.text, /Too many requests in a short time/);
});
