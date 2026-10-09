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
/**
 * The checks every page passes. `demo: false` is a production page (no supplier): it holds the company's own
 * figures (limits, budgets), which are never demo prices, so no amount may sit in a demo container.
 */
function checkPage(path, res, { priced = true, demo = true } = {}) {
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
  if (demo) assertDemoMoney(main, { priced, label: path });
  else assert.doesNotMatch(main, /data-price-source="demo"|Demo price/, `${path}: nothing labelled a demo price`);
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
  assert.match(textOf(main), /Trip confirmed\. Nothing else is needed from you\./);
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
  assert.match(textOf(main), /Approval saved\. Sam sees it on this trip\./);
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
  main = checkPage('/policy (production)', res, { demo: false });
  assert.match(textOf(main), /Limits are in US dollars\./);
  assert.doesNotMatch(textOf(main), /fares and rates they are checked against/, 'no demo fares to check against');
  assert.doesNotMatch(textOf(main), /demo/i, 'the policy lines name no demo fares when no supplier is connected');
  assert.match(textOf(main), /the median of the fares in your search/);

  res = await c.get(B, h);
  assert.equal(res.status, 200);
  main = checkPage('home (production)', res, { demo: false });
  assert.match(textOf(main), /Supplier not connected yet\./);
  assert.doesNotMatch(main, /href="[^"]*\/trips\/new"/, 'no link to a search that cannot run');
  res = await c.get(`${B}/trips`, h);
  main = checkPage('/trips (production)', res, { priced: false });
  assert.match(textOf(main), /No work trips yet\./);
  assert.doesNotMatch(main, /href="[^"]*\/trips\/new"/);
});

test('a trip that changed before it was sent keeps the reason typed, so the re-sent Request Approval form starts with it', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c, svc } = w;
  const hotels = svc.inventory.hotels;
  const real = hotels.quote;
  t.after(() => { hotels.quote = real; });
  const typed = (main, rid) => {
    const area = main.match(/<textarea id="s-reason"[^>]*>([\s\S]*?)<\/textarea>/);
    assert.ok(area, `${rid}: the Request Approval form`);
    return textOf(area[1]);
  };

  // Terms only (outcome 'repriced', why 'terms_changed'): the room turns non-refundable at the same price.
  const rid1 = await createDraft(w, await businessForm(w));
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, cancellation: { ...q.cancellation, type: 'non_refundable', freeUntilHours: 0, summary: 'Non-refundable.' } };
  };
  let page = await c.sam.get(`${B}/trips/${rid1}`);
  let res = await c.sam.post(`${B}/trips/${rid1}/submit`, { rev: revOf(page.text, 'submit'), reason: REASON, category: 'client_meeting' });
  assert.equal(res.location, `${B}/trips/${rid1}?ok=repriced`);
  let stored = (await svc.getRequest(w.as(w.sam), rid1)).request;
  assert.equal(stored.status, 'draft');
  assert.equal(stored.returned.why, 'terms_changed');
  assert.deepEqual(stored.reason, { text: REASON, category: 'client_meeting' });
  let main = mainOf((await c.sam.get(res.location)).text);
  assert.equal(typed(main, rid1), REASON);
  assert.match(main, /<option value="client_meeting" selected>/);
  // Sent again as it stands: pending with that reason.
  res = await c.sam.post(`${B}/trips/${rid1}/submit`, { rev: revOf(main, 'submit'), reason: typed(main, rid1), category: 'client_meeting' });
  assert.equal(res.location, `${B}/trips/${rid1}?ok=submitted`);
  hotels.quote = real;

  // A price change (why 'price_changed'): the same.
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 4000 } : l)) };
  };
  const rid2 = await createDraft(w, await businessForm(w, 'Second board meeting'));
  hotels.quote = real;
  page = await c.sam.get(`${B}/trips/${rid2}`);
  res = await c.sam.post(`${B}/trips/${rid2}/submit`, { rev: revOf(page.text, 'submit'), reason: REASON, category: 'schedule' });
  assert.equal(res.location, `${B}/trips/${rid2}?ok=repriced`);
  stored = (await svc.getRequest(w.as(w.sam), rid2)).request;
  assert.equal(stored.returned.why, 'price_changed');
  main = mainOf((await c.sam.get(res.location)).text);
  assert.equal(typed(main, rid2), REASON);
  assert.match(main, /<option value="schedule" selected>/);
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
  assert.match(body, /The fare or room terms changed\. The price is the same\./);
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
  assert.match(body, /The price changed\./);
  assert.equal(body.split('This trip changed before it was sent.').length - 1, 1, 'the lead copy once (the banner), no green notice repeating it');
  assert.match(body, /Was \$[\d,.]+ ?, now \$[\d,.]+ ?\./);

  // A departure date that has passed: 422 too_late, nothing written.
  const rid3 = await createDraft(w, await withinForm(w, 'Third workshop in London'));
  page = await c.sam.get(`${B}/trips/${rid3}`);
  w.clock.set('2026-11-13T09:00:00.000Z');
  const snap = storeSnapshot(w.app);
  res = await c.sam.post(`${B}/trips/${rid3}/submit`, { rev: revOf(page.text, 'submit') });
  assert.equal(res.status, 422);
  main = checkPage('too late', res);
  // The refusal is said once, by the banner that also links to plan it again (role="alert" on the 422).
  assert.match(main, /<div class="alert alert-warning bz-alert bz-late" role="alert">/);
  assert.match(textOf(main), /This trip was planned to leave on Thu 12 Nov, which has passed, so it can't be sent\. Plan it again with new dates\./);
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
  assert.match(textOf(main), /Trip cancelled\./);
  assert.match(textOf(main), /You cancelled this trip at [^.]+\. Nothing was booked or charged\./);
  assert.doesNotMatch(main, /action="[^"]*\/(?:submit|cancel)"/, 'nothing left to do');

  // Another employee's 404 is drawn in the workspace shell (lead decision L2-1), the same for a trip that
  // does not exist, with the way back to the company home and no consumer chrome.
  const eveGone = await client(app.base, eve.cookie).get(`${B}/trips/${rid}`);
  const eveNone = await client(app.base, eve.cookie).get(`${B}/trips/btr_AAAAAAAAAAAAAAAA`);
  assert.equal(eveNone.status, 404);
  assert.equal(eveGone.text, eveNone.text, 'a trip Eve cannot see reads exactly like one that does not exist');
  assert.match(eveGone.text, /<body class="bz-app">/);
  assert.match(mainOf(eveGone.text), /<h1 id="bz-refusal-title">This page isn&#39;t available<\/h1>/);
  assert.match(mainOf(eveGone.text), new RegExp(`<a class="btn btn-navy bz-btn" href="${B}">`));
  assert.doesNotMatch(eveGone.text, /Page not found|Back to home|Trips under/, 'not the consumer 404');
  assert.equal(eveGone.headers.get('cache-control'), 'no-store');
  noInline('member 404', eveGone.text);
  // An Employee on Approvals: the role's 403 in the shell.
  const denied = await c.sam.get(`${B}/approvals`);
  assert.equal(denied.status, 403);
  assert.match(denied.text, /<body class="bz-app">/);
  assert.match(textOf(mainOf(denied.text)), /Your role can't open this page Your role \(Employee\) can't open this page\. Ask a travel admin at Acme Inc if you need it\. Back to Acme Inc home/);

  // The compute limit: five searches a minute here, then 429, drawn in the workspace shell for a member.
  let last;
  for (let i = 0; i < 6; i += 1) last = await c.dana.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(last.status, 429);
  assert.match(last.text, /Too many requests in a short time/);
  assert.match(last.text, /<body class="bz-app">/);
  assert.match(mainOf(last.text), /<h1 id="bz-refusal-title">Too many requests<\/h1>/);
  assert.match(mainOf(last.text), new RegExp(`href="${B}"`));
  assert.doesNotMatch(last.text, /We couldn.t do that|Back to home/);
  assert.equal(last.headers.get('cache-control'), 'no-store');
  assert.ok(last.headers.get('ratelimit') || last.headers.get('ratelimit-policy'), 'the limiter headers stay');
  noInline('429', last.text);
});

// ---------------------------------------------------------------------------------------------------------
// Review fixes (Stage 2B review 2)

const { AppError } = require('../server/lib/errors');

/** Every hotel quote throws option_sold_out until `restore()` (or the test's end). */
function sellOutHotels(t, w) {
  const hotels = w.svc.inventory.hotels;
  const real = hotels.quote;
  t.after(() => { hotels.quote = real; });
  hotels.quote = async () => { throw new AppError('option_sold_out', 'Sold out', 409); };
  return () => { hotels.quote = real; };
}

test('a hotel sold out before the trip was sent: the page says so (not the policy), offers no option that is not there, and links to plan it again', async t => {
  for (const kind of ['within', 'out']) {
    const w = await world();
    t.after(w.app.close);
    const { B, c } = w;
    const rid = await createDraft(w, kind === 'within' ? await withinForm(w) : await businessForm(w));
    const page = await c.sam.get(`${B}/trips/${rid}`);
    const restore = sellOutHotels(t, w);
    const res = await c.sam.post(`${B}/trips/${rid}/submit`, { rev: revOf(page.text, 'submit'), reason: REASON });
    assert.equal(res.location, `${B}/trips/${rid}?ok=repriced`, kind);
    restore();
    const back = await c.sam.get(res.location);
    const main = checkPage(`sold out (${kind})`, back);
    const body = textOf(main);
    assert.doesNotMatch(body, /can't be requested under Acme Inc's policy/, `${kind}: not blamed on the policy`);
    assert.doesNotMatch(body, /Blocked by policy/, kind);
    assert.match(body, /An option in this trip is no longer in the demo data, so the trip can't be sent as it is\./, kind);
    if (!(main.match(/name="altId"/g) || []).length) assert.doesNotMatch(body, /Pick another option below/, kind);
    assert.match(main, new RegExp(`href="${B}/trips/search\\?[^"]+"[^>]*>[\\s\\S]*?Plan this trip again`), kind);
    assert.doesNotMatch(main, /name="reason"/, `${kind}: nothing to request`);
  }
});

test('a swap refused with 410: the gone option is not offered again and the page does not claim a fresh list', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await createDraft(w, await businessForm(w));
  const page = await c.sam.get(`${B}/trips/${rid}`);
  const alts = [...page.text.matchAll(/name="altId" value="([^"]+)"/g)].map(m => m[1]);
  assert.ok(alts.length > 1);
  sellOutHotels(t, w);
  const snap = storeSnapshot(w.app);
  // The first alternative that changes the hotel is the one that is gone.
  const draft = (await w.svc.getRequest(w.as(w.sam), rid)).request;
  const gone = draft.alternatives.find(a => a.kind === 'hotel' || a.kind === 'room' || a.change.component === 'hotel') || draft.alternatives[0];
  const res = await c.sam.post(`${B}/trips/${rid}/swap`, { altId: gone.id, rev: String(draft.rev) });
  assert.equal(res.status, 410);
  assert.equal(storeSnapshot(w.app), snap);
  const main = checkPage('410 swap', res);
  assert.doesNotMatch(textOf(main), /Here are the current ones/);
  assert.match(textOf(main), /That option isn't available anymore\. Pick another one, or request approval for the trip as it is\./);
  assert.doesNotMatch(main, new RegExp(`name="altId" value="${gone.id}"`), 'the gone option is not offered again');
});

test('a traveler\'s second click is not "someone else"; the saved line counts only what switching saved', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  // A double click on Confirm trip.
  const rid1 = await createDraft(w, await withinForm(w));
  const page = await c.sam.get(`${B}/trips/${rid1}`);
  const rev = revOf(page.text, 'submit');
  assert.equal((await c.sam.post(`${B}/trips/${rid1}/submit`, { rev })).location, `${B}/trips/${rid1}?ok=auto_approved`);
  const again = await c.sam.post(`${B}/trips/${rid1}/submit`, { rev });
  assert.equal(again.status, 409);
  const main = checkPage('second click', again);
  assert.doesNotMatch(textOf(main), /Someone else/);
  assert.match(textOf(main), /This trip changed since you opened this page, maybe in another tab or with a second click\. Here is where it stands now\./);

  // A swap saves; then every hotel price drops by $200 before it is sent: "Saved" stays the swap's saving.
  const rid2 = await createDraft(w, await businessForm(w, 'Partner meeting in London'));
  const d = (await w.svc.getRequest(w.as(w.sam), rid2)).request;
  const alt = d.alternatives.filter(a => a.kind === 'hotel').sort((x, y) => y.savesCents - x.savesCents)[0];
  let res = await c.sam.post(`${B}/trips/${rid2}/swap`, { altId: alt.id, rev: String(d.rev) });
  assert.equal(res.location, `${B}/trips/${rid2}?ok=swapped`);
  const swapped = (await w.svc.getRequest(w.as(w.sam), rid2)).request;
  const savedBySwap = swapped.history.filter(h => h.action === 'swapped').reduce((n, h) => n + h.savedCents, 0);
  const hotels = w.svc.inventory.hotels;
  const real = hotels.quote;
  t.after(() => { hotels.quote = real; });
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount - 20000 } : l)) };
  };
  const p2 = await c.sam.get(`${B}/trips/${rid2}`);
  res = await c.sam.post(`${B}/trips/${rid2}/submit`, { rev: revOf(p2.text, 'submit'), reason: REASON });
  assert.equal(res.location, `${B}/trips/${rid2}?ok=repriced`);
  hotels.quote = real;
  const after = (await w.svc.getRequest(w.as(w.sam), rid2)).request;
  assert.ok(after.originalTotalCents - after.totalCents > savedBySwap, 'the supplier move is on top of the saving');
  res = await c.sam.get(`${B}/trips/${rid2}`);
  const body = textOf(checkPage('saved after a price drop', res));
  const m = body.match(/Saved \$([\d,]+(?:\.\d\d)?) by switching to cheaper options\./);
  assert.ok(m, body.slice(0, 300));
  assert.equal(Math.round(Number(m[1].replace(/,/g, '')) * 100), savedBySwap);
});

test('messages name who reads them: none on a draft or a trip approved by policy, and "Write to Dana Lee" once it waits for her', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid1 = await createDraft(w, await withinForm(w));
  let res = await c.sam.get(`${B}/trips/${rid1}`);
  let main = checkPage('draft (within) messages', res);
  assert.doesNotMatch(main, /id="m-text"/);
  assert.doesNotMatch(textOf(main), /your approver/i);
  res = await c.sam.post(`${B}/trips/${rid1}/submit`, { rev: revOf(main, 'submit') });
  res = await c.sam.get(`${B}/trips/${rid1}`);
  main = checkPage('approved by policy messages', res);
  assert.doesNotMatch(main, /id="m-text"/, 'nobody to write to on a trip approved by policy');
  assert.doesNotMatch(textOf(main), /Write to your approver|They'll see it/);

  const rid2 = await createDraft(w, await businessForm(w));
  res = await c.sam.get(`${B}/trips/${rid2}`);
  main = checkPage('draft (out) messages', res);
  assert.doesNotMatch(main, /id="m-text"/);
  assert.match(textOf(main), /Messages open once you send this for approval\./);
  res = await c.sam.post(`${B}/trips/${rid2}/submit`, { rev: revOf(main, 'submit'), reason: REASON });
  res = await c.sam.get(`${B}/trips/${rid2}`);
  main = checkPage('pending messages', res);
  assert.match(main, /<label for="m-text">Write to Dana Lee<\/label>/);
  assert.match(textOf(main), /We don't send emails yet\. Dana Lee sees it on this trip under Approvals\./);
  res = await c.sam.post(`${B}/trips/${rid2}/message`, { text: 'The client moved the meeting to Thursday.' });
  res = await c.sam.get(res.location);
  assert.match(textOf(mainOf(res.text)), /Message sent to Dana Lee\./);
  // The traveler sees what they wrote when they asked.
  assert.match(textOf(mainOf(res.text)), new RegExp(`Your reason “${REASON.replace(/[.,]/g, '\\$&')}”`));
});

test('a trip whose departure date has passed: the draft says so and links to plan it again, with no form that would only fail', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await createDraft(w, await businessForm(w));
  w.clock.set('2026-11-13T09:00:00.000Z');
  const res = await c.sam.get(`${B}/trips/${rid}`);
  const main = checkPage('late draft', res);
  const body = textOf(main);
  assert.match(body, /This trip was planned to leave on Thu 12 Nov, which has passed, so it can't be sent\. Plan it again with new dates\./);
  assert.doesNotMatch(main, /name="reason"|name="altId"|action="[^"]*\/submit"/);
  assert.match(main, new RegExp(`href="${B}/trips/new\\?[^"]+"[^>]*>[\\s\\S]*?Plan it again with new dates`));
});

test('a trip that came back: the reason is kept in the form, the history speaks to the traveler, and the notices do not repeat the banner', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c, svc } = w;
  const rid = await createDraft(w, await businessForm(w));
  let page = await c.sam.get(`${B}/trips/${rid}`);
  await c.sam.post(`${B}/trips/${rid}/submit`, { rev: revOf(page.text, 'submit'), reason: REASON, category: 'client_meeting' });
  const hotels = svc.inventory.hotels;
  const real = hotels.quote;
  t.after(() => { hotels.quote = real; });
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 4000 } : l)) };
  };
  page = await c.dana.get(`${B}/trips/${rid}`);
  assert.match(page.text, /value="approve"[^>]*>[\s\S]*?Send back to Sam<\/span>/);
  const res = await c.dana.post(`${B}/trips/${rid}/decide`, { action: 'approve', note: '', rev: revOf(page.text, 'decide') });
  assert.equal(res.location, `${B}/trips/${rid}?ok=returned`);
  const dana = checkPage('returned (Dana)', await c.dana.get(res.location));
  assert.doesNotMatch(dana, /alert-success/, 'the banner says it; no green notice');
  hotels.quote = real;
  page = await c.sam.get(`${B}/trips/${rid}`);
  const main = checkPage('returned (Sam)', page);
  assert.match(main, new RegExp(`<textarea id="s-reason"[^>]*>${REASON}</textarea>`), 'the reason is kept');
  assert.match(main, /<option value="client_meeting" selected>/);
  assert.match(textOf(main), /It went back to you to confirm: the trip changed while it was waiting\./);
  assert.doesNotMatch(textOf(main), /went back to Sam/);

  // A repriced draft: the lead copy once, as a warning, never with the success style.
  const rid2 = await createDraft(w, await withinForm(w));
  page = await c.sam.get(`${B}/trips/${rid2}`);
  hotels.quote = async function quote(args) {
    const q = await real.call(this, args);
    return { ...q, lines: q.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 4000 } : l)) };
  };
  const r2 = await c.sam.post(`${B}/trips/${rid2}/submit`, { rev: revOf(page.text, 'submit') });
  hotels.quote = real;
  const m2 = checkPage('repriced notice', await c.sam.get(r2.location));
  assert.equal(textOf(m2).split('This trip changed before it was sent. Review it and send it again.').length - 1, 1);
  assert.doesNotMatch(m2, /alert-success/);
});

test('a company with no one to approve: the alternatives do not suggest requesting approval', async t => {
  const clock = mutableClock(FIXED_NOW);
  const app = await startApp({ ENABLE_BUSINESS: 'true' }, { now: clock.now, store: new MemoryStore() });
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Solo Owner' });
  const org = await seedOrg(app, owner, { name: 'Solo Studio' });
  const c = client(app.base, owner.cookie);
  const sv = await app.business.searchTrip({ org: { id: org.id }, user: owner.user }, BQ);
  const res = await c.post(`/business/o/${org.id}/trips`, { ...BQ, out: keyWhere(sv, 'out', zm), back: keyWhere(sv, 'back', zm), hotelKey: keyWhere(sv, 'hotel', r => r.row.available && r.row.stars === 5), purpose: 'Board meeting in London' });
  const page = await c.get(res.location);
  const main = checkPage('solo draft', page);
  assert.match(textOf(main), /No one else at Solo Studio can approve this yet/);
  assert.doesNotMatch(textOf(main), /request approval with a reason/i);
});

test('the draft: alternatives have distinct titles, a refused reason links to its field, and Request Approval keeps the alternatives first', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await createDraft(w, await businessForm(w));
  const page = await c.sam.get(`${B}/trips/${rid}`);
  const main = checkPage('draft titles', page);
  const titles = [...main.matchAll(/<h3 class="bz-alt-title">([\s\S]*?)<\/h3>/g)].map(m => textOf(m[1]));
  assert.ok(titles.length > 1);
  assert.equal(new Set(titles).size, titles.length, `distinct: ${titles.join(' | ')}`);
  const res = await c.sam.post(`${B}/trips/${rid}/submit`, { rev: revOf(main, 'submit'), reason: 'Too short' });
  assert.equal(res.status, 422);
  const m = checkPage('reason 422', res);
  const box = m.match(/<div class="alert alert-error bz-alert" role="alert">([\s\S]*?)<\/div>/)[1];
  assert.match(box, /<a href="#s-reason">Tell your approver why this trip needs an exception, in 10 to 500 characters\.<\/a>/);
});

test('home, policy and the trip form: one way to plan a trip, the demo note beside the limits, plain words on expiry; production pages say nothing of demo prices and drop the dead Search button', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  let res = await c.sam.get(B);
  let main = checkPage('home (employee)', res, { priced: false });
  assert.equal((main.match(/href="[^"]*\/trips\/new"/g) || []).length, 1, 'one button to plan a trip');
  assert.match(textOf(main), /Limits are in US dollars\. In this preview, the fares and rates they are checked against are demo prices\./);
  res = await c.sam.get(`${B}/policy`);
  main = checkPage('/policy', res, { priced: false });
  assert.match(textOf(main), /Your approver has 24 hours to decide\. If they don't, the request expires and nothing is approved\./);

  const clock = mutableClock(FIXED_NOW);
  const app = await startApp({ APP_ENV: 'production', DATABASE_URL: 'postgres://x/prod', ENABLE_BUSINESS: 'true', ENABLE_TRIPS: 'false' }, { store: new MemoryStore(), now: clock.now });
  t.after(app.close);
  const owner = await seedUser(app, { name: 'Olivia Owner' });
  const org = await seedOrg(app, owner);
  const eng = await seedDepartment(app, org, { name: 'Engineering' });
  await seedBudget(app, org, eng.id, { periodKey: '2026-Q4', amountCents: 2000000 });
  const fay = await seedMember(app, org, 'finance', { name: 'Fay Finance' });
  const h = { headers: { 'x-forwarded-proto': 'https' } };
  const P = `/business/o/${org.id}`;
  for (const [who, path] of [[owner, `${P}/policy`], [owner, P], [fay, P]]) {
    res = await client(app.base, who.cookie).get(path, h);
    assert.equal(res.status, 200, path);
    noInline(path, res.text);
    main = mainOf(res.text);
    assert.doesNotMatch(textOf(main), /Demo price/, `${path}: the company's own limits and budgets are not demo prices`);
    assert.doesNotMatch(main, /data-price-source="demo"/, path);
  }
  assert.match(textOf(mainOf(res.text)), /\$20,000/, 'the budget still shows');
  res = await client(app.base, owner.cookie).get(`${P}/trips/new`, h);
  main = mainOf(res.text);
  assert.doesNotMatch(main, /<button[^>]*type="submit"/, 'no Search button that cannot run');
  assert.doesNotMatch(main, /bz-actionbar/);
  const fieldset = main.match(/<fieldset[\s\S]*?<\/fieldset>/)[0];
  assert.doesNotMatch(fieldset, /Your department:/, 'the information line is not dimmed with the disabled fields');
  assert.match(textOf(main), /Your department: [^·]+ · Your policy: Standard/);
});

test('an approved trip is cancelled in two steps: the consequence first, then a clearly marked button', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await createDraft(w, await withinForm(w));
  let page = await c.sam.get(`${B}/trips/${rid}`);
  await c.sam.post(`${B}/trips/${rid}/submit`, { rev: revOf(page.text, 'submit') });
  page = await c.sam.get(`${B}/trips/${rid}`);
  let main = checkPage('approved (cancel link)', page);
  assert.doesNotMatch(main, /action="[^"]*\/cancel"/, 'no one-tap cancel');
  assert.match(main, new RegExp(`<a class="btn btn-ghost bz-btn" href="${B}/trips/${rid}\\?confirm=cancel#cancel">Cancel this trip</a>`));
  page = await c.sam.get(`${B}/trips/${rid}?confirm=cancel`);
  main = checkPage('approved (confirm cancel)', page);
  assert.match(textOf(main), /Cancel your approved trip to London\? Its approval ends, and you'd need to plan and confirm it again\. Nothing was booked or charged\./);
  assert.match(main, /<form method="post" action="[^"]*\/cancel">[\s\S]*?<button class="btn bz-btn bz-btn-danger" type="submit">Yes, cancel this trip<\/button>/);
  assert.match(main, new RegExp(`href="${B}/trips/${rid}">Keep this trip</a>`));
});

test('Review trip with nothing picked: one 422 that names every missing choice, each linked to its section', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const res0 = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.match(res0.text, /<input type="hidden" name="hotelChoice" value="1">/);
  const snap = storeSnapshot(w.app);
  const res = await c.sam.post(`${B}/trips`, { ...Q, hotelChoice: '1', purpose: 'Client workshop in London' });
  assert.equal(res.status, 422);
  assert.equal(storeSnapshot(w.app), snap);
  const main = checkPage('nothing picked', res);
  assert.match(textOf(main), /Choose an outbound flight ?, a return flight and a hotel ?\(or No hotel for this trip\)\./);
  for (const id of ['bz-leg-out', 'bz-leg-back', 'bz-leg-hotel']) assert.match(main, new RegExp(`<a href="#${id}">`), id);
  // "No hotel for this trip" is a choice.
  const form = await withinForm(w);
  const ok = await c.sam.post(`${B}/trips`, { ...form, hotelChoice: '1', hotelKey: '' });
  assert.equal(ok.status, 303);
});

test('the Company list keeps a valid filter applied when another is refused', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const rid = await createDraft(w, await withinForm(w));
  const res = await c.tom.get(`${B}/trips?scope=all&status=bogus&period=2026-Q2`);
  assert.equal(res.status, 422);
  const main = checkPage('/trips mixed filters', res);
  assert.doesNotMatch(main, new RegExp(`href="${B}/trips/${rid}"`), 'Sam\'s Q4 trip is not in Q2');
  assert.match(main, /<option value="2026-Q2" selected>/);
  assert.match(textOf(main), /No trips match these filters\./);
});

// ---------------------------------------------------------------------------------------------------------
// Supplier test data (real-suppliers design §2.3, §2.4, §7.1 B items): the app's demo providers moved into the
// flt_t./htl_t. namespace (test/business-sandbox.js useSandbox), with status 'sandbox'. Every amount on every
// page sits in a data-price-source="sandbox" container that says TEST DATA; nothing says "Demo price".

const sandbox = require('./business-sandbox');
const { PRICE_CHECK_COPY, SUPPLIER_ERRORS } = require('../server/business/source');
const { SANDBOX_RIBBON } = require('../server/views/business/parts');
const resultsMod = require('../server/views/business/results');

/** checkPage for a supplier test data page: no demo label, every amount labelled TEST DATA. */
function checkSandboxPage(path, res, { min = 1 } = {}) {
  const main = checkPage(path, res, { demo: false });
  sandbox.assertSourceMoney(main, 'sandbox', { label: path, min });
  return main;
}

test('supplier test data: results, request and trip pages label every amount TEST DATA; a trip inside policy is "Approved (test data)"', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const sb = sandbox.useSandbox(w.app);
  const spy = sandbox.instrument(sb.composer);

  let res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200, res.text.slice(0, 300));
  let main = checkSandboxPage('/trips/search (sandbox)', res, { min: 20 });
  assert.ok(textOf(res.text).includes(`TEST DATA ${SANDBOX_RIBBON}`), 'the ribbon');
  assert.match(res.text, /class="bz-ribbon bz-ribbon-demo bz-ribbon-test"/);
  for (const m of main.matchAll(/type="radio"[^>]*name="(out|back|hotelKey)"[^>]*value="([^"]*)"/g)) {
    if (m[2]) assert.match(m[2], /^[fh]\.(flt|htl)_t\./, `${m[1]}: a sandbox key`);
  }
  assert.ok(textOf(main).includes(resultsMod.ONE_WAY_EACH), 'each way is its own one-way ticket');
  assert.match(textOf(main), /these test fares/, 'the limits bar names the test fares');
  assert.doesNotMatch(textOf(res.text), /demo (?:data|fares|schedule|hotels)/i);

  // A draft inside policy, sent: approved by policy, with nothing booked.
  const rid = await createDraft(w, await withinForm(w));
  res = await c.sam.get(`${B}/trips/${rid}`);
  main = checkSandboxPage('draft (sandbox)', res, { min: 3 });
  res = await c.sam.post(`${B}/trips/${rid}/submit`, { rev: revOf(main, 'submit') });
  assert.equal(res.location, `${B}/trips/${rid}?ok=auto_approved`);
  assert.deepEqual(spy.checks('recheck'), ['confirm'], 'submit checks the price at the confirm level');
  res = await c.sam.get(res.location);
  main = checkSandboxPage('approved (sandbox)', res, { min: 1 });
  assert.ok(textOf(main).includes('Approved (test data). Nothing was booked.'));
  assert.doesNotMatch(textOf(main), /Approved to book/, 'test data is never "approved to book"');
  assert.match(main, /<span class="bz-pill bz-pill-good">Approved \(test data\)<\/span>/);

  // The trip list and the home page.
  res = await c.sam.get(`${B}/trips`);
  main = checkSandboxPage('/trips (sandbox)', res, { min: 1 });
  assert.ok(textOf(main).includes('Approved (test data)'), 'the list says it too');
  res = await c.sam.get(B);
  assert.equal(res.status, 200);
  sandbox.assertSourceMoney(mainOf(res.text), 'sandbox', { label: 'home (sandbox)' });
  // The public page says the preview runs on the suppliers' test data.
  res = await c.anon.get('/business');
  assert.equal(res.status, 200);
  assert.ok(textOf(res.text).includes("In this preview, flights and hotels come from our suppliers' test systems, so prices are test data, not real fares."));
  assert.doesNotMatch(textOf(res.text), /on demo data/);
});

test('supplier test data on results: what the supplier left out, a hotel supplier that failed, and hotels not connected', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const sb = sandbox.useSandbox(w.app);
  const search = sb.composer.search.bind(sb.composer);
  sb.composer.search = async q => {
    const r = await search(q);
    r.legs.out.skipped = { otherCurrency: 3, currencies: ['GBP'], mixedCabin: 1 };
    r.legs.hotel = { rows: [], benchmark: { incl_taxes: { medianCents: null, sampleSize: 0, excluded: [] }, excl_taxes: { medianCents: null, sampleSize: 0, excluded: [] } }, truncated: false, error: 'unavailable' };
    return r;
  };
  let res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200);
  let main = checkSandboxPage('results with notes', res, { min: 10 });
  let text = textOf(main);
  assert.ok(text.includes('3 fares priced in another currency are not shown.'));
  assert.ok(text.includes('Fares that mix cabins are not shown yet.'));
  assert.ok(text.includes(PRICE_CHECK_COPY.hotelsLeg), 'the hotel supplier failed: the flights still show');
  assert.match(main, /type="radio"[^>]*name="out"/);
  assert.doesNotMatch(main, /name="hotelKey"/, 'no hotel to pick');

  // Every outbound fare in another currency: the leg says why it is empty.
  sb.composer.search = async q => {
    const r = await search(q);
    r.legs.out = { rows: [], benchmark: { medianCents: null, sampleSize: 0, excluded: [] }, truncated: false, skipped: { otherCurrency: 12, currencies: ['GBP'] } };
    return r;
  };
  res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  text = textOf(mainOf(res.text));
  assert.ok(text.includes('This supplier priced every fare in GBP. Tripelyx Business shows US dollar prices only for now, so none can be shown.'));
  assert.ok(text.includes("No flights found from CAI to LHR on Thu 12 Nov in the supplier's test system."));
  sb.restore();

  // Flights only: "Hotels are not connected yet."
  sandbox.useSandbox(w.app, { hotels: false });
  res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
  assert.equal(res.status, 200);
  main = checkSandboxPage('flights only', res, { min: 10 });
  assert.ok(textOf(main).includes(resultsMod.HOTELS_NOT_CONNECTED));
});

test('supplier test data: a supplier that fails, or the company limit, is said on the trip form with the search kept; nothing is written', async t => {
  const w = await world();
  t.after(w.app.close);
  const { B, c } = w;
  const sb = sandbox.useSandbox(w.app);
  const form = await withinForm(w);
  const spy = sandbox.instrument(sb.composer);
  const before = storeSnapshot(w.app);
  for (const [code, status, message] of [['supplier_unavailable', 503, SUPPLIER_ERRORS.supplier_unavailable.flights], ['supplier_busy', 429, SUPPLIER_ERRORS.supplier_busy.message]]) {
    spy.fail('search', code);
    let res = await c.sam.get(`${B}/trips/search?${qs(Q)}`);
    assert.equal(res.status, status, code);
    let main = checkPage(`search ${code}`, res, { priced: false, demo: false });
    assert.ok(textOf(main).includes(message), `${code}: ${textOf(main).slice(0, 300)}`);
    assert.match(main, /<input id="t-depart" name="depart"[^>]*value="2026-11-12"/, 'the search is kept');
    assert.match(main, /value="CAI"/);
    // A new draft: the form again, not the results (which would ask the failing supplier once more).
    res = await c.sam.post(`${B}/trips`, form);
    assert.equal(res.status, status, `POST /trips ${code}`);
    main = checkPage(`POST /trips ${code}`, res, { priced: false, demo: false });
    assert.ok(textOf(main).includes(message));
    assert.match(main, /<form[^>]*method="get"[^>]*action="[^"]*\/trips\/search"/);
  }
  assert.equal(storeSnapshot(w.app), before, 'nothing written');
  spy.heal();
  assert.equal((await c.sam.get(`${B}/trips/search?${qs(Q)}`)).status, 200);
});
